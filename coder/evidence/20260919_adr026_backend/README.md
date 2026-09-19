# ADR-026 阶段 1（后端实现）交付报告

- **本报告位置**：`coder/evidence/20260919_adr026_backend/README.md`
- **契约（冻结）**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`（先完整读后动手）
- **交付基线**：`git rev-parse HEAD` = `e807385449a303a1090ac00a52c722b7b77e62ec`（工作树基线见 `00_baseline.txt`）
- **纪律**：**未执行任何 `git add/commit/checkout/stash/reset`**（`git diff --cached` 为空，见 §7）；未改
  `strategy_run_bars` / `strategy_run_result` 表结构，**无新迁移**；未改引擎成交/回合口径
  （`EngineExecutor`/`apply_sell` 的成交量与回合判定逐字不动，仅**新增** `reason` 透传）。

---

## 1. 变更文件清单 + sha256

（原文见 `80_changed_files_sha256.txt` / `81_diff_stat.txt`）

### 1.1 新增文件

| 文件 | sha256 | 说明 |
|---|---|---|
| `crates/application/src/audit.rs` （933 行） | `acf65682af84283e492f8a1e922107392b0fdaa8dcde6c979d19fdd4ea011b90` | **纯函数审计**（ADR-026 §2.1/§2.2 全部字段 + JSON 投影 + 18 个表驱动单测） |
| `crates/web/tests/adr026_run_audit.rs` （563 行） | `fe974d7a5d950b32eee7ab4d41fa524edf3f03c34427b0978018de917207a86e` | 端点集成测试（200 结构/404/recorded/三方自洽/A3-A4 真实 run 回放/tracing 字段捕获） |
| `coder/evidence/20260919_adr026_backend/**` | — | 本批全部证据（命令原文、Red/Green、sha256、DB teardown） |

### 1.2 修改文件

| 文件 | sha256 | 改动 |
|---|---|---|
| `crates/application/src/lib.rs` | `9831499301f42d656685d761048bbbac9b7ffb1b27481f961ada1d19b4ecfb00` | `+2`：注册 `pub mod audit;` |
| `crates/application/src/workbench.rs` | `e1bac99e8e859a67e41fbef7dd9005bef54853b642c994cdb7d386194ac6592f` | `+62`：`RunAudit` DTO + `run_audit()` 读侧接线（复用 `/bars`、`/fills` 的既有 D8 双读） |
| `crates/application/src/simlive.rs` | `ed5bf5bff5d97f7173f6e8b9def2b555227e1b43fad8fcfa3c8e162c2442b038` | `+2`：`TradeDetail.reason: None`（sim-live FIFO 配对无引擎清仓来源 ⇒ 诚实「未记录」） |
| `crates/backtest/src/types.rs` | `eef4001a38e12ba297e48d99c3c6e9a05bc8a20d837b075dd27ee07ce5cc5e5e` | `+8`：`TradeDetail.reason: Option<String>`（`#[serde(default)]`，历史 JSON 可读） |
| `crates/backtest/src/metrics.rs` | `f2f9837e2f1ce485346f44ef449ac66100a150ede48304f3212d3fe2be8ba95e` | `+1`：测试夹具补字段（零语义） |
| `crates/strategy-core/src/engine.rs` | `8c3461ec76ac98c626555f9e97599061e75f147181e6ef66275cf368fcd796cf` | `+31`：`OrderReason::{as_str,parse}`（单一映射源）+ `apply_sell` 增 `reason` 形参（3 个调用点各传 `ForceClose`/挂单来源/`StopTrigger`）+ 清仓时写 `TradeDetail.reason` |
| `crates/strategy-core/tests/engine.rs` | `027ebee12561b53ea9ef2c6cf7f4237709b5e21c89cf99cdef1e111e3b0aedbb` | `+74`：`reason` 三值取证（Policy/StopTrigger/ForceClose，逐例断言 `trade_count` 不变） |
| `crates/web/src/workbench.rs` | `105da7c086c03eeb533c2162461de4da9e5661cd2ed489ae547dc86500b8de4b` | `+47`：`get_audit` handler（404 复用既有错误码体系 + tracing span） |
| `crates/web/src/lib.rs` | `c9ae22928247a997c349a3b0c924c1d69e96d30d1bd0b5619e4b13497312f390` | `+2`：路由 `GET /api/workbench/runs/{id}/audit` |
| `crates/mcp/src/tools.rs` | `d50ae8e5afe85110795c254d8a99de28e8f18d0ada2a00fd4e640ff9e134a6f8` | `+84`：`bt_get_run_audit` 工具（名单 + description + inputSchema + 分发 + handler + 契约/门禁测试） |
| `crates/mcp/src/rpc.rs` | `101811fbd9b771a6b96a7350392f90b79ce3d62bc90e2a52813f57ee02820171` | `+4-1`：`tools/list` 名单点补 `bt_get_run_audit` |
| `crates/mcp/tests/mcp_protocol.rs` | `47f0b2ce2d625458e3cca83e41d0700eef21d83248e658ad67dcf8b8f3193b8b` | `+4-1`：SSE 全协议帧序断言的工具总数 34→35 |
| `design/99-decisions-log.md` | `85578d1ab5fd7f8d0fc639fd1ec5668634043f117d41ac7ed445b34f3bfc03e2` | `+11`：ADR-026 索引行（仓内 ADR 索引惯例） |

> ⚠️ `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` 在 `git status` 中显示 ` M`，但它是
> **基线即已修改**（本批未触碰；本批改动清单以 §1.2 表为准）。

---

## 2. TDD 记录（Red → Green，原始输出落盘）

### 2.1 纯函数审计（`crates/application/src/audit.rs`）

- **Red**（`10_red_pure_fn.txt`）：声明类型/常量/投影/`compute_audit` 全为 `todo!()` →
  `test result: FAILED. 0 passed; 17 failed`（每例 `not yet implemented: ADR-026 Red：compute_audit 尚未实现`）。
- **Green**（`11_green_pure_fn.txt`）：最小实现后 `test result: ok. 17 passed`；随后把 §2.4 的历史 JSON
  兼容用例移入本模块（`strategy-core` 无 `serde_json` dev-dep，不新增依赖）→ **18 passed**。
- 覆盖（ADR-026 §5 A1 要求逐项）：目标 run 形态（43 意图/42 成交/1 未执行/1 强平回合，数值取冻结基准
  41397.97208076086 / 41607.97208076086 / 0.41397972 / 0.41607972）、满仓 `LumpSum{1}`（无
  `PARTIAL_DEPLOYMENT`、`planned_tranches=null`）、零成交、legacy_single（双向 40/40/40，无 ForceClose）、
  Dca 与非 Dca、`deployed_pct` 0.99 阈值**两侧**（`98_999.999→告警` / `99_000.0→不告警`）、
  佣金逐笔取 `max(额×费率,最低)`（最低主导/费率主导/免最低/多笔）、强平按 `close_bar` 配对、
  未执行数 saturating、无 in-range bar、`recorded=false` 诚实留白、分母 0 不 panic/NaN、
  legacy 记录**缺 `warmup` 字段**视为 in-range、字段名与顺序冻结（序列化文本断言）。

### 2.2 `TradeDetail.reason`（ADR-026 §2.3）

- **Red**（`20_red_trade_reason.txt`）：先落字段（三处构造点填 `None` 以可编译）+ 断言测试 →
  `assertion failed: 期末强平合成的回合须标注来源  left: None  right: Some("ForceClose")`（真断言失败，非编译错）。
- **Green**（`21_green_trade_reason.txt`）：`apply_sell` 增 `reason` 形参后 `test ok`；
  三值取证 = `["Policy","Policy","ForceClose"]`（持仓门控 3 回合）与 `StopTrigger`（Intrabar 止损分支），
  每例同时断言 `trades.len()` 不变（**不改 `trade_count` 语义**）。

### 2.3 端点（临时库集成）

- 临时库（ADR-025 §D3）：`EESTOCK_TEST_DB_NAME=tmp_adr026_1789749546 scripts/testdb-init.sh`
  （原文 `30_testdb_init.txt`）。
- **Red**（`40_red_endpoint.txt`）：路由尚未注册 → `audit 应 200  left: 404  right: 200`
  （`{"error":"not found"}`），`test result: FAILED. 1 passed; 2 failed`。
- **Green**（`41_green_endpoint.txt`）：`test result: ok. 4 passed`。
- 覆盖：200 结构（15 个冻结字段名、字段类型、warning 三要素）、`recorded` 语义（chunked 可得=true；
  空事实 chunked=false ⇒ 零值 + **空 warnings**）、404 语义（运行不存在 / 运行存在但无结果）、
  **端点间三方自洽**（`reachable_batches`=/bars 的 Buy 意图、`batches_done`=/fills 的 Buy 成交、
  `deployed_notional`=Σ qty×price、`round_trips_total`=trades 长度、`round_trips_force_closed` 与
  ForceClose 事件 bar 配对）、`deployed_pct/cash_consumed_pct` 与敞口/资金占用自洽。

### 2.4 MCP（`bt_get_run_audit`）

- **Red**（`50_red_mcp.txt`）：先改三处名单断言（`tools.rs` 工具数 34→35 + `bt_*` 名单、`rpc.rs` 名单、
  `mcp_protocol.rs` 帧序工具数）+ 新契约测试 → `工具名单须含 bt_get_run_audit：[...]` FAILED。
- **Green**（`51_green_mcp.txt`）：实现后该测试 ok；`cargo test -p mcp` 全绿（66+5+1+2+8+1）。
- 覆盖：名单注册（tools/list）+ `required: [run_id]`、**真调一次 ensemble 后读审计**并与
  `bt_get_run_result` 的 trades 长度交叉断言、未知 run → isError、缺参 → `-32602`、
  `strategy_tools_enabled=false` → 既有「停用」isError 语义。

---

## 3. 突变自检（ADR-026 §5 A2）

两次突变均**原地改推导**（非改测试），跑完立即还原并以 sha256 校验（禁用 `git checkout`）：
还原校验 `acf65682af84283e492f8a1e922107392b0fdaa8dcde6c979d19fdd4ea011b90 ... audit.rs: OK`
（`60_mutation_pre_sha256.txt` / `63_mutation_reverted_sha256.txt`）。

| # | 突变 | 变红测试 | 输出 |
|---|---|---|---|
| 1 | `unexecuted_orders = buy_intents.saturating_sub(batches_done)` → `= 0`（常量） | **3 个**：`target_run_shape_dca_underfilled`、`zero_fills_reports_partial_deployment_and_unexecuted`（单测）+ `adr026_replay_target_run_matches_frozen_baseline`（真实 run 回放） | `61_mutation_unexecuted_red.txt`（`FAILED. 16 passed; 2 failed` + 回放 FAILED） |
| 2 | `cash_consumed = deployed_notional + buy_commission` → `= deployed_notional`（敞口/资金占用错配） | **4 个**：`target_run_shape_dca_underfilled`（`expected 41607.97…, got 41397.97…`）、`commission_follows_fee_contract_min_and_rate`、`full_deployment_lumpsum_has_no_warnings`、`legacy_two_way_run_is_self_consistent` | `62_mutation_cash_consumed_red.txt`（`FAILED. 14 passed; 4 failed`） |

还原后复跑：`audit:: 18 passed` + 端点 `4 passed`（同文件尾部）。

---

## 4. A3/A4 真实 run 实测（与独立重算对照）

**方式说明（取舍）**：工作树部署（:8081/:8082 的新二进制）与 git 冻结由主代理负责，本车道**未重新部署**；
为使 A3/A4 可复现且不写活库，本批把目标 run 的**事实行**（`strategy_run` / `strategy_run_result` /
`strategy_run_bars`，共 2+2+8 行）从活库**只读**复制进 ADR-025 临时库（`32_replay_fixture_seed.txt`
含逐表 `\copy` 原文），再由**真实端点**回放断言冻结基准（`42_green_replay_A3_A4.txt`），
并与**独立 SQL 重算**（不经应用代码，`44_independent_recompute.txt`）逐字段对照。

- **A3 `sr_1789738328788_000005`** 原始响应（`43_raw_audit_A3_A4.json.txt`）：
  `planned=100, reachable=43, done=42, unexecuted=1, last_bar_unfilled=true, deployed_notional=41397.97208076086,
  deployed_pct=0.4139797208076086, cash_consumed=41607.97208076086, cash_consumed_pct=0.41607972080760863,
  round_trips=1/force_closed=1` + **3 条 warning**（`DCA_PLAN_UNDERFILLED` / `PARTIAL_DEPLOYMENT` /
  `ORDERS_UNEXECUTED`，message 与 ADR §2.2 示例逐字一致：`名义投入 41.40% 初始资金…`）。
  独立重算：`buy_intents=43 / buy_fills=42 / 未执行=1 / 名义=41397.97208076086 /
  佣金 Σ max(额×0.025%,5)=210 / 现金=41607.97208076086 / trades=1 / ForceClose bar=422 == close_bar`。
- **A4 `sr_1789738272901_000004`**（同区间 `LumpSum{position_pct:1}`）：`planned_tranches=null,
  deployed_pct=0.9997500624843787, warnings=[]`（**无** `PARTIAL_DEPLOYMENT`），独立重算名义
  `99975.00624843787`、佣金 `24.99375156210947`。
- **A5 双向 run**（`sr_1789044295239_000111`，legacy_single，1209 bar）：纯函数用例
  `legacy_two_way_run_is_self_consistent` 断言 `batches_done==Buy 成交数(40)`、
  `round_trips_total==trades 长度(40)`、`round_trips_force_closed==ForceClose 事件数(0)`；
  其事实形态（缺 `warmup` 字段、40 Buy + 40 Sell 意图）由 `orders_projection_treats_missing_warmup_as_in_range`
  与实测 SQL 取证（会话内已核对：40/40/40）。

---

## 5. 可观测性（ADR-026 §4）

`GET /audit` handler 发 `tracing::info_span!("workbench_run_audit", trace_id, run_id, deployed_pct,
unexecuted_orders, warnings)`（字段先声明后 `record`，与仓内 `p4b.segment` 同风格）并在 span 内发同名
`tracing::info!`。**实测**（非仅代码检视）：`adr026_run_audit.rs` 内**零新依赖**自写 `CaptureSubscriber`
（`tracing` 已是 web 正式依赖，未引入 `tracing-subscriber`）捕获实际字段，断言 span 与事件均含
`trace_id/run_id/deployed_pct/unexecuted_orders/warnings` 且**值与响应体一致**
（捕获实样：`trace_id=750c455f… run_id=sr_… deployed_pct=0.5001 cash_consumed_pct=0.500225025
recorded=true unexecuted_orders=0 warnings=1`）。
`trace_id` 为**该审计请求自身**的 trace（run 的 trace_id 不落库 ⇒ 无法回指，取舍见 §6）。

---

## 6. 自行取舍清单（契约未覆盖处，按 KISS/DRY/最小影响面决策，未停下等确认）

1. **落点**：纯函数放 `application`（`audit.rs`），非 `domain`——它依赖 `backtest::FeeModel` 与
   `strategy_core::ExecutionPolicy`（domain 层无此二型），契约「domain/application」二者皆可。
2. **`recorded` 判据**：`!per_bar.is_empty() || fills块存在`（契约原文「per_bar.orders/events 或 fills 可得」）。
   `recorded=false` 时**只回零值 + 空 warnings**——否则会伪造「0% 投入」告警（比缺字段更危险）。
3. **佣金复算**：逐笔 `fee.commission(qty×price)` = `max(额×费率, 最低佣金)`，直接复用
   `backtest::FeeModel`；**未**另写公式。实测对目标 run 得 42×5=210（与仓内 `TradeDetail.commission` 口径一致）。
4. **fills 来源不变**：复用既有 `fills_all`（ADR-024 P6 双读：chunked 读 `kind='fills'` 块；legacy 由内联
   per_bar 事件派生），不新造第三条读径。
5. **`round_trips_force_closed` = 计数**（非布尔）：按「存在 ForceClose Sell 成交且 `fill.bar_index ==
   trade.close_bar`」逐回合计数（ADR §2.1 措辞 → 计数更可审计，A3=1/A4=1/A5=0）。
6. **`planned_tranches` 解析失败/缺失 ⇒ `None`**：读径不得因历史 config 形态差异 500。
7. **fee/capital 兜底**：`config.fee` 经既有 `to_fee_model`（失败 → `FeeModel::default()` 即 ADR bt-1）；
   `config.initial_capital` 缺失 → `DEFAULT_INITIAL_CAPITAL`（100000，workbench 既有常量）。
8. **占比分母为 0 ⇒ 返回 0.0**（不 NaN/inf，不 panic）。
9. **`OrderReason::{as_str,parse}` 落在 strategy-core**：`TradeDetail.reason`（引擎写）与 fills reason 解析
   （审计读）共用一份映射，避免字符串二处漂移；serde 外部标记形态天然一致。
10. **sim-live 的 `TradeDetail.reason = None`**：FIFO 配对无「引擎清仓来源」可写；ADR §2.3 只要求引擎写。
11. **MCP 复用 application 的同一条 `run_audit`**（web/MCP **零重复算法**）；工具数 34→35 的三处名单断言同步更新。
12. **测试卫生**：`adr026_run_audit.rs::clean()` 额外清理 **`storage::reader::ORPHAN_TABLES`**（单一事实源）
    对应的 cagg 视图行——M1 播种被 cagg 物化后、源行删除不回删即成为 ADR-023 §6.3 的「孤儿行」，
    会污染同库后续的 `orphan_detect_endpoint_red`（本批实测复现并修复：清理前 FAILED rows=2，清理后 PASS）。
13. **A3/A4 回放用例可跳过**：临时库未播种目标 run 时 **跳过并打印 skip 原因**（`eprintln`），
    避免「临时库是新鲜的」这一常见场景把回归套件弄红；接受验收时按 §4 播种后为**强断言**（已实测通过）。
14. **未重新部署 :8081/:8082**（部署与冻结属主代理）；因此 A6（前端真浏览器 E2E）与本批无关，
    属 ADR-026 §2.4 的前端阶段。

---

## 7. 回归（受影响 crate，原始输出）

`cargo test` × 5 个受影响 crate（backtest / strategy-core / application / web / mcp），
环境 = ADR-025 临时库；输出原文 `70_regression_affected_crates.txt`：
**50 个测试目标 `test result: ok`**，逐 crate 汇总：
`backtest 31`、`strategy-core 33+26+6+7+1+3`、`application 46+2+6+3+55+41+3+43`、
`mcp 66+5+1+2+8+1`、`web 49+2+4+4+3+3+2+1+1+17+1+2+6+9+9+4+8+4+2+2+6+3+6+13+4`。
`cargo check --workspace --all-targets` 通过；无新增 warning 出现在本批文件（仅 tester 自有测试文件的既有
unused 警告）。

**全新鲜临时库上的原始（未过滤）输出**：`72_regression_raw_fresh_tempdb.txt`（984 行，5 crate 全量 stdout）
—— 在**另一只全新**临时库 `tmp_adr026f_1789750143` 上重跑，`50 个 test result: ok`，失败仍只有下述既有红
（证明「新鲜临时库」场景下套件全绿）；该临时库随后已 drop（`90_db_teardown.txt` 第二段，回读
`{eestock, postgres}`、`tmp_` 残留 0）。首只临时库上另有「重复运行同一库」的额外验证：
`orphan_detect_endpoint_red` 在本批 `adr026_run_audit` 跑完**之后**仍 PASS（§6-12 的 cagg 孤儿清理有效）。

**唯一失败（既有、与本批无关）**：`cargo test -p web --test tester_p5rect_verify` 的
`t_n1_http_every_400_is_structured_object` 期望 `resource_guard(confirm=false)` → 400，实得 201。
证据（`71_preexisting_failure_tester_p5rect.txt`）：
- HEAD 的 `crates/application/src/error.rs:150` 已是 `GUARD_CONFIRM_BARS = 500_000`，而该 tester 资产
  仍按 `200_000` 期望（本次提交区间预估 292092 bar ⇒ < 500000 ⇒ 放行 201）；
- `crates/application/tests/resource_guard_contract_vectors.rs:8/12` 明文记载「2026-09-18 用户『按推荐』把
  confirm 阈值由 200_000 提到 500_000」，并点名 `crates/web/tests/tester_p5_indep.rs` 是 tester 自有资产
  （含 200_000 硬断言）；
- 两文件在 HEAD 即如此，且**均不在本批改动清单**（`git status` 见 `80_changed_files_sha256.txt`）。
⇒ 属 tester 资产滞后，**登记给主代理/测试者处置**，本批不代改（避免越界改他人验收资产）。

---

## 8. DB teardown（ADR-025 §D3）

`90_db_teardown.txt`：
```
DROP DATABASE tmp_adr026_1789749546 WITH (FORCE);   -- DROP DATABASE
回读 datname not like 'template%' ⇒ eestock / postgres
回读 tmp_ 前缀残留数 ⇒ 0
```
临时库已销毁，无残留（helper 环境文件亦已删除）。

---

## 9. 未做/残留风险

1. **A6 前端 E2E**（交易明细 Tab 审计摘要 + 来源列 + 8项口径注）不在本阶段范围（阶段 1 = 后端）。
2. 前端尚未消费 `reason`/`audit`：`recorded=false` 时后端回零值 + 空 warnings，**前端须显示「未记录」
   而非 0%**（否则又制造误导），已在本报告显式移交。
3. `TradeDetail.reason` 自本批起成为对外契约（ADR §6：改动须走 ADR）；历史 run 永久为 `null`。
4. 审计端点全量扫 `per_bar`（超大 run 单次 MB 级读，ADR §6 已承认）；仅前端按需调用，未做增量索引。
5. `tester_p5rect_verify` 既有红（§7）需测试者更新其 200_000 期望。
6. **GitNexus 影响分析工具不可用**：`npx gitnexus impact apply_sell/TradeDetail` 报
   `index written by a different @ladybugdb/core build … Run gitnexus analyze --force`
   （索引存储版本 43 vs 当前 build 42）。未重建索引（耗时且会改 `.gitnexus/`）。改用等价人工
   爆炸半径盘点：`TradeDetail` 构造点 3 处（`strategy-core/src/engine.rs:848`、
   `application/src/simlive.rs:1904`、`backtest/src/metrics.rs:166` 测试夹具）——全部已同步；
   `apply_sell` 调用点 3 处（`finish` / `Pending::SellQty` / Intrabar 止损），全部已传 `reason`；
   `TradeDetail` 消费方（`metrics.rs` 仅读 `pnl/hold_bars`；web/application 只读 JSON）无字段集断言。
   `cargo check --workspace --all-targets` 佐证无遗漏。

---

## 10. ADR 索引登记（任务项 6）

`design/99-decisions-log.md` 追加 `# ADR-026 回测结果的执行完整度审计与口径披露（2026-09-19…）`
一节（权威正文 / 触发事件 / 决策要点 D1–D6 / 明确不做 / 关联 / 产出物），与 ADR-024/025 同格式。
