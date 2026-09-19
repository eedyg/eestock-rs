R3 与 R4 转绿（2/2 绿）｜simlive 与 application 测试 绿（`-p simlive` 41+3+3 全绿；`-p application` 全部二进制 0 failed）｜迁移 已生成（`migrations/0028_sim_trades_fee_split.sql`，entangled 生成；`check-tangle` 通过）｜第二份聚合实现 已删除（`VecDeque` lot 配对与 `stamp_duty: 0.0` 硬编码在 `application/src/simlive.rs` 均无命中）

报告文件位置：`coder/evidence/20260920_adr027_p2_simlive/report.md`

---

## 1. 本波范围（P2 sim-live 车道）

只动 `crates/simlive`、`crates/storage`、`crates/domain`（端口）、`crates/application`（sim-live 服务层）与
`design/04-storage/schema.md`、`design/02-domain/contracts.md`；**未动** strategy-core/backtest 引擎逻辑（P1b 已交付）。

## 2. 判据达成情况

| 判据 | 结果 | 证据 |
|---|---|---|
| `cargo test -p application --test adr027_repro_simlive`（R3+R4） | **全绿 2/2** | `01_red_repro.txt`（红）→ `02_green_repro.txt`（绿） |
| `cargo test -p simlive` | **全绿**（41 + 3 + 3，0 failed） | `05_simlive_tests.txt` |
| `cargo test -p application` | **全绿**（47/2/2/6/3/3/57/41/3/43，0 failed；`mcp::real_db_*` 不在本 crate） | `04_application_tests.txt` + `04_application_tests_summary.txt` |
| `cargo check --workspace --all-targets`（跨 crate 编译面） | 通过（仅既有 warning） | `06_workspace_check.txt` |
| check-tangle（`.git/hooks/pre-commit`） | ✅ 通过（沙箱重新生成 + 逐字节比对，工作区未被修改） | `03_check_tangle.txt` |

### 2.1 R3 红 → 绿（原始输出）

红（`01_red_repro.txt`，节选）：

```
R3：sim-live 结算费用三件套必须与撮合点事实一致，实得 3 项不符:
  stamp_duty 必须 > 0（本笔卖出含印花税 5.9988），实际 0（simlive.rs:1914 硬编码 0.0）
  stamp_duty 必须 == Σ_sell 印花税 = 5.9988，实际 0（Δ = -5.9988）
  commission 必须 == Σ_buy + Σ_sell 佣金 = 10，实际 15.9988（Δ = 5.998799999999999；现口径把卖腿「佣金+印花税」合并值整笔计入 commission）
```

绿（`02_green_repro.txt`）：

```
running 2 tests
test r4_simlive_bar_index_is_not_reverse_computed_from_ts ... ok
test r3_simlive_settlement_stamp_duty_is_not_zero ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### 2.2 R4 红 → 绿（原始输出）

红（`01_red_repro.txt`，节选）：

```
R4：sim-live bar_index 必须为真实 bar 序号，实得 4 项不符:
  open_bar 必须 == 真实 bar 序号（会话内 0-based）= 30，实际 29806680
  close_bar 必须 == 真实 bar 序号（会话内 0-based）= 30，实际 29806680
  open_bar 必须**不是** ts/bar_sec 的反算商（02-spec §1.1「禁 ts/bar_sec 反算」），实际 29806680 == 1788400817/60
  close_bar 必须**不是** ts/bar_sec 的反算商，实际 29806680 == 1788400817/60
```

绿：见 `02_green_repro.txt`（同一次运行，两测试皆 ok）。

## 3. 实现（按四块）

### 3.1 费用拆列（ADR-027 D4）

- `crates/simlive/src/fill.rs`：`Fill` 与 `SimTrade` 的合并 `fee` 字段**拆为** `commission` + `stamp_duty`
  （`try_fill` 内部本就算出两者，原实现把它们相加丢弃）；新增派生读 `Fill::fee()` / `SimTrade::fee()`
  （= 两列之和，**非第二事实源**，供账户账务/订单读模型沿用单列口径）。新增单测
  `sell_fill_carries_stamp_duty_as_separate_fact`（卖腿 `stamp_duty > 0`、买腿恒 0、与 `FeeModel::sell` 逐位一致）。
- `crates/simlive/src/account.rs`：`apply_fill` 用 `fill.fee()`（内部先取合计，再用于现金/已实现盈亏/累计费用）。
- `crates/simlive/src/session.rs`：`SimOrder` 增 `commission` / `stamp_duty`（`#[serde(default)]`，旧
  `simsession_state.orders` JSON 仍可读），使**恢复重建路径**能用真实事实重建 `Fill`，而不是把印花税补成 0。
- `crates/domain/src/ports.rs`：`NewSimTrade` 增 `commission` / `stamp_duty`（保留 `fee`，与 DB 冗余列同语义）。
- `crates/storage/src/sim.rs`：`append_trade` INSERT 三列（commission/stamp_duty/fee），`list_trades` SELECT 三列。
- `crates/storage/tests/sim_store.rs`：构造点补两列 + 读回断言（`fee == commission + stamp_duty`）。

### 3.2 聚合统一（删除第二份实现）

`crates/application/src/simlive.rs` 的 `sim_trades_to_trade_details` 由**旧 FIFO lot 配对（一条 lot = 一条 L1，
`stamp_duty` 硬编码 0、`rt_seq`/买卖笔数占位、`bar_index` 由 ts 反算）**改为**构建 `FillFact` 账本后调用唯一实现**：

```rust
fn sim_trades_to_trade_details(trades: &[SimTrade], session_start_ts: i64, period: Period) -> Vec<TradeDetail> {
    let mut fills = sim_trades_to_fill_facts(trades, session_start_ts, bt_bar_seconds(period));
    assign_rt_seq(&mut fills);
    aggregate_round_trips(&fills)
}
```

- `sim_trades_to_fill_facts`：`SimTrade` → `FillFact`。`commission`/`stamp_duty`/`price` 直取撮合点事实；
  `trade_value = qty × price`（与撮合点**同一表达式同操作数** ⇒ 逐位相等；`sim_trades` 无该列）；
  `rt_seq` 置 0 占位由 `assign_rt_seq` 统一打号；`side` 用 `backtest::OrderSide`；
  `reason` 用 `backtest::FillReason`（`strategy`/`aggregate_strategy` → `Policy`；其余（`manual`）→ `Manual`；
  **不产出** `ForceClose`/`StopTrigger` —— sim-live 无期末强平）。
- 前后对照与删除证据：`07_aggregation_unification.txt`（`VecDeque` lot 配对命中数 = 0，
  `stamp_duty: 0.0` 命中数 = 0，`fn sim_trades_to_trade_details` 定义数 = 1）。

### 3.3 真实 bar 序号（R4）

新增 `session_bar_index(session_start_ts, ts, bar_sec)`：`bar_index = (ts − session.start_ts) / bar_sec`
（会话内 0-based bar 网格序号，负差钳为 0）。**禁**绝对纪元商 `ts / bar_sec`。
`stop_session` 传 `session.start_ts`；运行中读路径传 `view.start_ts`（同一函数，同一口径）。

### 3.4 Open 语义与多标的

- 聚合产物中未平仓回合 `status = Open`、`pnl = None`（由 `aggregate_round_trips` 保证），
  与 `Closed` 出现在**同一列表**；`compute_metrics` 只吃 `Closed`（`backtest/src/metrics.rs` 已按 `status` 过滤）。
- `code` 取真实成交代码；多标的按 `(code, rt_seq)` 分组（`assign_rt_seq` per-code 从 1 起）。
- **未引入期末强平**：`stop_session` 不补造任何平仓成交。

### 3.5 运行中读能力（服务层函数；HTTP 路由留 P3）

`SimLiveService` 新增：
- `async fn round_trips(&self, session_id) -> anyhow::Result<Vec<TradeDetail>>`：读 `sim_trades`（`id` 升序 = 到达顺序）
  → `FillFact` → `assign_rt_seq` → `aggregate_round_trips`（复用唯一实现）；
- `async fn round_trip_fills(&self, session_id, code, rt_seq) -> anyhow::Result<Option<Vec<FillFact>>>`：
  按 `(code, rt_seq)` 取 L2 切片；**未知回合 → `None`**（P3 映射 404，禁止空数组冒充「无成交」）；
- 私有 `session_fill_facts`（读路径共用账本构造）；未知会话 → `Err`（非空列表）。
- 新增测试（`crates/application/tests/simlive.rs`）：
  `adr027_p2_running_round_trips_and_fills_read`（多标的 + Open/Closed 同列 + I1 字段级对账 + L2 切片/None 语义）、
  `adr027_p2_open_round_trip_excluded_from_metrics`（结算结果 Open 进列表但 `trade_count`/`win_rate` 不计）。

## 4. DB 迁移（entangled 生成，禁手改产物）

1. `design/04-storage/schema.md` 新增 **§4.3.19**（编号 0028），块内即迁移正文：
   `ALTER TABLE sim_trades ADD COLUMN IF NOT EXISTS commission float8 NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS stamp_duty float8 NOT NULL DEFAULT 0;`
   并以 `COMMENT ON COLUMN` 固化 `fee = commission + stamp_duty` 语义（列注释写明）。
2. **生成方式（重要披露）**：仓库内直接运行 `entangled tangle` 会因**其它车道未同步的生成物冲突**
   （`conflicts found, breaking off`）而拒绝写盘（该命令不支持指定单文件）。因此按 `.git/hooks/pre-commit`
   第 4 步的**权威路径**执行：把 `entangled.toml` + `design/` 拷入临时沙箱，在空 filedb 下
   `entangled tangle -f` 无条件重新生成，再把 `migrations/0028_sim_trades_fee_split.sql` 取回仓库
   （**未使用仓库内 `--force`**，未覆盖任何既有生成物；同法用于同步 `crates/domain/src/ports.rs`）。
3. `bash .git/hooks/pre-commit` → `/bin/bash: exit 0`：`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）`
   （全文 `03_check_tangle.txt`）。
4. **迁移本体本波不入库**（按任务书，应用留收尾波次与清空历史同批）。应执行命令：

```
psql -v ON_ERROR_STOP=1 -f migrations/0028_sim_trades_fee_split.sql
```

（本迁移无 cagg，可用单事务；顺序硬约束：**先落迁移、再上新二进制** —— `storage/src/sim.rs` 的
INSERT/SELECT 已含两列，缺列会运行期报错。历史行两列取默认 0；sim-live 历史会话按 ADR-027 D3
在收尾波次与回测历史同批 `TRUNCATE`，故不回填。）

## 5. 越界与跨车道事项（透明披露）

1. **`crates/domain/src/ports.rs` 被 entangled 托管**：本波对它加字段属「改码必改文档」，
   已同步 `design/02-domain/contracts.md` 对应块并重新生成。
2. **发现并修复了跨车道的 doc↔code 漂移**：生成沙箱里 `ports.rs` 与工作区不一致，差在 **P1 车道已写入但未回写文档**
   的 `ResultKind::Position`（enum 变体 / `as_str` / `parse` / `is_sampleable` 文档注）。check-tangle 因此报
   `WARNING crates/domain/src/ports.rs not managed by Entangled`。为让门禁通过，把该 4 处**原样补进
   `design/02-domain/contracts.md`**（未改 P1 的代码语义，仅补文档事实源）。P1 侧如需以其它文本书写，请以文档为准重跑 tangle。
3. `SimOrder` 增两列（见 §3.1）是本波「费用分列」的必要连带：否则重启恢复路径只能把 `stamp_duty` 造 0（造数）。
   `OrderView`（对外读模型）形状**未变**，`fee` 仍为合计。

## 6. 未做项（留给后续波次）

- HTTP 路由（`P3`）：`/round-trips`、`/round-trips/{rt_seq}/fills`、`/fills` 过滤与字段、`/curve` 窗口、`/audit` 逐回合自洽；
  本波只交付服务层读函数（签名自定，见 §3.5）。
- `ResultKind::Position` 曲线生成与 sim-live 序列点（02-spec §4.1）未在本波触碰（非 P2 任务项）。
- `sim_trades` 迁移**未执行入库**（收尾波次与历史清空同批）。
- `crates/storage/tests/*` 为真库测试，本沙箱未跑（新增的读回断言已随代码落盘，待真库门禁跑）。
- 前端（P5）与 MCP/HTTP（P3/P4）形状未动。

## 7. 改动清单

| 文件 | 变更 |
|---|---|
| `crates/simlive/src/fill.rs` | `Fill`/`SimTrade` 费用拆列 + `fee()` 派生读 + 新单测 |
| `crates/simlive/src/account.rs` | `apply_fill` 用费用合计（两列之和） |
| `crates/simlive/src/session.rs` | `SimOrder` 增 `commission`/`stamp_duty`（serde default）+ 测试构造适配 |
| `crates/simlive/src/plugin_orchestrator_tests.rs` | `SimTrade` 构造适配 |
| `crates/domain/src/ports.rs` | `NewSimTrade` 增 `commission`/`stamp_duty` |
| `crates/storage/src/sim.rs` | INSERT/SELECT 三列同步 |
| `crates/storage/tests/sim_store.rs` | 构造适配 + 读回断言 |
| `crates/application/src/simlive.rs` | 删除第二份 FIFO 聚合；`FillFact` 账本 + `assign_rt_seq` + `aggregate_round_trips`；真实 `bar_index`；运行中 L1/L2 读函数；费用分列落库 |
| `crates/application/tests/simlive.rs` | 2 个新测试（运行中读 / Open 不进绩效）+ `fill.fee()` 适配 |
| `design/04-storage/schema.md` | 新增 §4.3.19（0028 迁移块） |
| `design/02-domain/contracts.md` | `NewSimTrade` 两列 + 补 P1 的 `ResultKind::Position` 文档漂移 |
| `migrations/0028_sim_trades_fee_split.sql` | entangled 生成的迁移产物（新增） |

## 8. 证据文件

`01_red_repro.txt`（R3/R4 红原始输出）｜`02_green_repro.txt`（R3/R4 绿）｜`03_check_tangle.txt`（门禁通过）｜
`04_application_tests.txt` + `04_application_tests_summary.txt`｜`05_simlive_tests.txt`｜`06_workspace_check.txt`｜
`07_aggregation_unification.txt`（聚合统一前后对照 + 删除证据）
