# ADR-024 阶段 P6 —— 前端结果取数路径改造（+ `/fills` 有界精确源）

- **报告位置（本文件）**：`coder/report/adr024_p6_frontend_result_paths.md`
- **契约出口**：`design/16-backtest-scalability/02-spec.md` §1.2 / §2 / §3.2 / §5.2 / §5.3（**架构师所有，我只读**）；`design/16-backtest-scalability/01-adr.md` D8/D9/D10；`design/07-app-plane/00-web-api.md` §1.8；`design/04-storage/schema.md` §4.3.18
- **上游裁决**：架构师 intercom 裁决（Q1=A 组件内取数 + 单一取数入口；Q2=混合且「事实性信息不得抽样」；授权动 domain/storage/application/web/migrations/`web/src/**`）；P4 交付 `coder/report/adr024_p4_chunked_result_storage.md`；tester 缺口清单 `tester/evidence/251_adr024_p4_verify/13_frontend_gap.txt`
- **证据目录**：`coder/evidence/adr024_p6/`（00–12 号原始输出；含 5 组反向证据；12 号为 GitNexus 不可用的环境证据）
- **状态**：全部落地并通过；DB 测试在**自建临时库**跑完后 teardown；**活库 `eestock` 未应用 0027**（回读 `information_schema`：`strategy_run_bars` 计数 = 0）

---

## 0. 纪律声明

1. **未改 `design/16-backtest-scalability/**`**（架构师所有，只读）。架构师已自行回填 02-spec §1.2/§2/§3.2；本实现与其**逐字对齐**（见 §1）。
2. **未 `git add -A` / `git add .`**，**未 `git commit`**；`git add` 只列本任务路径（清单见 `coder/evidence/adr024_p6/00_scope_git.txt`）。
3. **未触碰**：`crates/mcp/**`、`docker-compose.yml`、`design/01-architecture/**`、`design/99-decisions-log.md`、`design/16-backtest-scalability/**`；共享工作区里 P0–P4 冻结批与他人车道的改动**一个字节都没回退**（工作区仍可见 ` M docker-compose.yml` / `AM design/16/...` 等他车道改动，均未 stage）。
4. **测试库门禁（ADR-025 D3）**：`EESTOCK_TEST_DB_NAME=tmp_p6_*` 建临时库 → 跑 → `DROP DATABASE ... WITH (FORCE)` → 回读库清单 `{eestock, postgres}`（`06`/`10` 号证据）。**从未对活库执行 0027**。
5. **tangle 门禁（ADR-007/018）**：0027 用**沙箱 `entangled tangle -f`** 重新生成后拷回（未手改 `migrations/`）；`crates/domain/src/ports.rs` 用 `./scripts/stitch.sh crates/domain/src/ports.rs` 回写 `design/02-domain/contracts.md`（ADR-007「改码必改文档」硬要求）。`./scripts/check-tangle.sh` **绿**（`11` 号）。
6. **GitNexus 图分析不可用（环境限制，非本任务造成）**：`node .gitnexus/run.cjs detect-changes` 报 `DB file version: 43, Current build storage version: 40`（索引与已安装 CLI 版本不匹配）。AGENTS.md 的 `impact`/`detect_changes` MUST 因此**无法执行**（原始输出：`12_gitnexus_unavailable.txt`）；本批以 `cargo check --workspace --all-targets` + 全量测试 + tangle 门禁 + 5 组定点变异替代图分析。重建方式：`/gitnexus analyze`（或 `node .gitnexus/run.cjs analyze`）。

---

## 1. 契约变更说明（架构师点名的必含节）

### 1.1 `migrations/0027_*.sql` 的 CHECK 变更（tangle 生成，非手写）

`design/04-storage/schema.md` §4.3.18 的 `{.sql file=migrations/0027_*.sql}` 块（+ 上下文段落）：

```diff
-    kind     text        NOT NULL CHECK (kind IN ('per_bar','net_value','drawdown')),
+    kind     text        NOT NULL CHECK (kind IN ('per_bar','net_value','drawdown','fills')),
```

0027 **尚未对活库应用**，故直接改本迁移（不新增 0028）。生成物逐字（`migrations/0027_strategy_run_result_chunks.sql`）：

```sql
-- ADR-024 / P6：kind 增 'fills'（成交明细**有界精确源**，单块 seq=0；见 16-backtest-scalability/02-spec.md §3.2）。
CREATE TABLE IF NOT EXISTS strategy_run_bars (
    run_id   text        NOT NULL REFERENCES strategy_run(id) ON DELETE CASCADE,
    kind     text        NOT NULL CHECK (kind IN ('per_bar','net_value','drawdown','fills')),
    ...
```

对应 domain 端口（`crates/domain/src/ports.rs`，经 stitch 回写 `design/02-domain/contracts.md`，与 02-spec §1.2 一致）：

```rust
pub enum ResultKind { PerBar, NetValue, Drawdown, Fills }
impl ResultKind {
    pub fn as_str(&self) -> &'static str { /* + Fills => "fills" */ }
    pub fn parse(s: &str) -> Option<Self> { /* + "fills" => Some(Fills) */ }
    /// `fills` 是**事实源**（成交明细）：不得进入抽样/区间/分页曲线路径（ADR-024 P6 硬约束）。
    pub fn is_sampleable(&self) -> bool { !matches!(self, ResultKind::Fills) }
}
```

### 1.2 `/fills` 请求/响应形状

```
GET /api/workbench/runs/{id}/fills?offset=0&limit=5000
  offset  默认 0
  limit   默认 5000 / 上限 20000（与 /bars 同口径，复用 BARS_LIMIT_DEFAULT/BARS_LIMIT_MAX）
```

```jsonc
200 {
  "run_id": "sr_...",
  "total": 34,            // 成交总数（全量，不受分页影响）
  "offset": 0,
  "limit": 5000,
  "has_more": false,      // 拟 BarsResponse 风格（超额字段，见 §1.4）
  "next_offset": null,
  "recorded": true,       // false = 该 chunked run 无 fills 块（**「未写」**）
  "fills": [
    { "type": "fill", "bar_index": 3, "ts": 1788485400, "side": "Buy",
      "qty": 908.68, "price": 110.022, "reason": "Policy" }
  ]
}
// 400：无（本端点无入参校验面，offset/limit 仅做下界夹取）；404：id 未知或未成功；503；500
```

- 元素字段沿用 `EngineEvent::Fill`（`bar_index` / `side` / `qty` / `price` / `reason`），另附 `ts`（**所在 bar 的 epoch 秒**，K 线标记锚点）——与架构师「必要时可附 ts」一致。
- **落库形态**：单块 `kind='fills'`、`seq=0`；`ts_from`/`ts_to` = 本 run 首/末 bar ts。
- **「无成交」vs「未写」的判据（架构师要求写明）**：我选 **恒写块**（无成交也写**空数组块**）。因此
  - chunked run：`有块 ⇒ recorded=true`（可能 `total=0` =「无成交」）；`无块 ⇒ recorded=false` =「未写」（P6 之前的 chunked run / 取消的 run）；
  - legacy run：无 fills 块，改由**内联 per_bar 的 `fill` 事件派生**（D8 双读、不回填）⇒ `recorded=true`。
  - 该区别有测试锁定：`p6_fills_unrecorded_distinguished`（反向证据 R5 证明它非空转）。
- **读实现**：chunked 走 `result_chunk_count(Fills)` 判存在 → `series_all(Fills)` 物化；legacy 走 `legacy_fills`（投影内联 per_bar 事件）。
- **`/bars`、`/curve` 明确拒绝 `kind=fills`（400）**：把「事实源不得抽样」在 API 层也钉死（`parse_series_kind` 白名单 3 值 + `result_curve` 的 `is_sampleable` 守卫）。

### 1.3 为什么**不抽样** / 为什么**不用 `trades`**（架构师要求写进报告）

1. **抽样会丢真实成交**：`/curve` 是「均匀抽样保首尾」的**有损**读法（D10 允许但必须标注）。成交是**事实**，一次 buy/sell 被抽样丢掉即等于伪造「没有这笔交易」。所以 fills 只提供**分页精确读**（`offset/limit`，上限 20000），且 `/curve?kind=fills` 直接 400。
2. **`trades` 会漏标记**：`TradeDetail` 只在**完全平仓**时合成（`apply_sell` 的 `qty >= holding.qty` 分支）——
   - **部分买入/加仓**（DCA、`position_pct < 1`）不产生 `trades` 行；
   - **部分卖出**（`qty < holding.qty`）不产生 `trades` 行；
   ⇒ 用 `trades` 当 K 线买卖标记源会**系统性漏掉真实成交**（误导，而非「少一点数据」）。
3. **替代方案（拒绝）**：把 `k` 调到上限 20000 或整区间全量读 `/bars`（与 D9/§5.2 相悖：长区间一次性拉近全量/全量）。fills 单块是**有界**的（实测每 run 数十至百余笔），是唯一同时满足「精确」+「有界」的读法。
4. **事件日志同理不抽样**：日志/插件错误/熔断是**调试证据**，抽样等于丢证据 ⇒ 走 `/bars` 分页读 + 覆盖范围标注。

### 1.4 与 02-spec 的**超额**字段（请架构师裁定是否回填 02-spec）

架构师口径写的是「`{ run_id, total, offset, limit, fills:[…] }`，沿用既有风格」。我实现为 **超集**：
额外回 `has_more` / `next_offset`（与 `BarsResponse` 同风格，便于分页 UI 消费；纯加法、旧消费方忽略无碍）。
若架构师认为应严格收敛为 4 字段，请回填 02-spec 后我删（前端改由 `offset+limit vs total` 自算，功能等价）。

---

## 2. 改动清单（含分层）

| 层 | 文件 | 改动 |
|---|---|---|
| **Storage 契约（docs→tangle）** | `design/04-storage/schema.md` | §4.3.18 上下文段 + 0027 块：`kind` CHECK 增 `'fills'`；补 fills 语义说明 |
| Storage 产物（生成） | `migrations/0027_strategy_run_result_chunks.sql` | **沙箱 tangle 重生成**（非手写） |
| **Domain 端口（docs→stitch）** | `crates/domain/src/ports.rs` + `design/02-domain/contracts.md` | `ResultKind::Fills`（`as_str`/`parse`）+ `is_sampleable()` |
| Application 写路径 | `crates/application/src/workbench.rs` | 引擎闭包内 `collect_fills` 逐块累积（含末块期末强平）→ finish 后写**单块** `kind=Fills seq=0`（无成交也写空块）；`fills_chunk` / `legacy_fills` / `collect_fills` |
| Application 读路径 | 同上 | `FillsResponse` + `fills_all`（D8 双读 + `recorded`）+ `result_fills`（分页）；`result_curve` 增「事实源不可抽样」守卫；`legacy_series`/`bar_ts_secs` 补 `Fills` 分支 |
| Web | `crates/web/src/workbench.rs`、`crates/web/src/lib.rs` | `GET …/fills` handler + `FillsQuery` + 路由；`/bars`·`/curve` 的 kind 白名单收敛为 `parse_series_kind`（拒绝 `fills`） |
| Web 契约文档 | `design/07-app-plane/00-web-api.md` | REST 表新增 `/fills` 行 + 路由块新增 `.route(.../fills)`（手工同步：lib.rs 不在 stitch 覆盖范围） |
| **前端取数（核心）** | `web/src/features/workbench/useRunSeries.ts`（新） | **单一取数入口**：曲线 `/curve`（抽样标注）、明细 `/bars`（分页 + 区间跳读）、成交 `/fills`；`legacy_single` 全量内联派生（零网络、零回归） |
| 前端类型 | `web/src/api/types.ts` | `WorkbenchResultFormat`、`WorkbenchResultBrief`、`WorkbenchCurveResponse`、`WorkbenchBarsResponse`、`WorkbenchRunFill`、`WorkbenchFillsResponse`；`WorkbenchRunResult` 增 `result_format`/`summary`/`has_more`/`next_offset`；`WorkbenchCompareItem` 增 `downsampled`/`original_bars` |
| 前端客户端 | `web/src/api/client.ts` | `getWorkbenchBrief` / `getWorkbenchBars` / `getWorkbenchCurve` / `getWorkbenchFills`；`compareWorkbenchRuns(ids, k?)` |
| 前端 mock | `web/src/api/mock.ts` | 同上 4 个方法 + compare 抽样；**新提交 run = `chunked_v1`（种子 run = `legacy_single`）**；`MockOptions.workbenchResultBars`（构造 >5000 长区间）、`workbenchFillsMissing`（构造 `recorded=false`）；导出 `sampleIndices`/`fillsOf` |
| 前端 UI | `ResultView.tsx` | 接 hook；图表区 loading/错误；Tab 传分页状态 |
| | `PerBarTable.tsx` | 服务端分页（首页 5000）+「已加载 N / 共 M」+「加载更多」+ 区间跳读（`from&to`）+ 页内 100 行分页保留 |
| | `EventLog.tsx` | 覆盖范围标注（已加载 N / 共 M 根 bar）+「加载更多」（**不抽样**） |
| | `KlineResultChart.tsx` | 标记源改 `WorkbenchRunFill[]`（`/fills` 精确源）+ 成交笔数/`recorded=false` 显式标注 |
| | `AggregateScoreChart.tsx` / `SlotScoresChart.tsx` / `EquityDrawdownChart.tsx` | 抽样标注（`服务端抽样 N 点` + `共 M bar`）沿用既有「抽样 N 点」文案模式 |
| | `ComparePanel.tsx` | **移除**客户端 `downsample(r.net_value)` 全量假设，改直用服务端抽样曲线 + `downsampled`/`original_bars` 标注 |
| 测试 | `crates/application/tests/workbench.rs`、`crates/storage/tests/workbench_store.rs`、`crates/web/tests/api_workbench.rs`、`web/src/api/{client,mock}.test.ts`、`web/src/features/workbench/{useRunSeries,ResultView}.test.tsx` | 见 §4 |

**取数路径对照（§5.2 落地）**

| 数据 | legacy_single | chunked_v1 |
|---|---|---|
| 总分 / 各策略分 | `/result.per_bar`（全量，客户端渲染抽样） | `GET …/curve?kind=per_bar&k=2000`（服务端抽样 + `downsampled`/`original_bars`） |
| 净值 / 回撤 | `/result.net_value|drawdown` | `GET …/curve?kind=net_value|drawdown&k=2000` |
| 逐 bar 评分表 / 事件日志 | `/result.per_bar`（全量） | `GET …/bars?kind=per_bar&offset&limit`（分页，消费 `has_more`/`next_offset`；区间跳读用 `from&to`） |
| K 线买卖标记 | 内联 `per_bar` 的 fill 事件（全量、非抽样） | `GET …/fills`（有界精确源） |
| K 线本身 | 不变（`ScopedKlineFeed` 按 run 区间，§5.2「K 线不变」） | 同左 |

---

## 3. 反向证据（对关键断言人为退化 ⇒ 必须变红 ⇒ 逐字节还原）

原始输出：`coder/evidence/adr024_p6/01..05_*.txt`（含变异说明、变异期输出、还原后复跑、`cmp -s` 复核）。

| # | 变异点 | 目标测试 | 红灯实测 | 还原 |
|---|---|---|---|---|
| R1 | `useRunSeries.ts` chunked 首页置 `hasMore:false`/`nextOffset:null`（= **忽略 `has_more`**、静默只显首页） | ResultView › **长区间（12000 根 chunked）不得静默截断** | `Tests 1 failed`；`Unable to find an element by: [data-testid="wb-perbar-more-note"]` | ✅ `RESTORED`（`cmp -s` 逐字节一致） |
| R2 | `useRunSeries.ts` 曲线映射改 `downsampled:false` / `originalBars=已抽样点数`（= **隐式未标注的有损**，违 D10） | 同 R1（断言抽样标注） | `Tests 1 failed`；`expect(element).toHaveTextContent()` 失配 | ✅ `RESTORED` |
| R3 | `application/src/workbench.rs` 引擎闭包 fills 单块**永不写出** | `p6_fills_block_single_seq_and_content` / `p6_fills_paging_and_recorded` | `2 failed; 3 passed`；`assertion left == right failed: fills 恒为单块（seq=0） left: 0 right: 1` | ✅ `RESTORED` |
| R4 | `result_curve` 去掉 `is_sampleable` 守卫（= 解禁 fills 抽样） | `p6_fills_curve_sampling_rejected` | `FAILED`：`called Result::unwrap_err() on an Ok value: CurveResponse { kind: "fills", ... }` | ✅ `RESTORED` |
| R5 | `fills_all` 无块也回 `recorded=true`（抹掉「未写」语义） | `p6_fills_unrecorded_distinguished` | `FAILED`（断言 `!res.recorded` 不成立） | ✅ `RESTORED` |

还原后同一用例复跑全绿；两处源文件 sha256（还原后）：`useRunSeries.ts = 05be06ff…`、`application/src/workbench.rs = 41ae267f…`。

---

## 4. 测试与构建（全量，退出码）

### 4.1 前端
| 命令 | 结果 | 证据 |
|---|---|---|
| `npx vitest run` | **exit 0**；`Test Files 90 passed (90)`、`Tests 864 passed (864)` | `03_frontend_full.txt` |
| `npx tsc -b` | **exit 0** | `04_frontend_tsc.txt` |
| `npx vite build` | **exit 0**（`✓ built in 2.17s`） | `05_frontend_build.txt` |

> 用例数**未减少**：基线 `89 files / 850 tests` → `90 files / 864 tests`（净 **+14**；新增文件 `useRunSeries.test.ts`）。
> 备注：`ResultView.test.tsx` 被重写（10 → 15 例）——原 10 例全部保留（`逐bar分页` 一例改为 legacy 形态，因为 chunked 的明细现在由 `/bars` 分页提供；另新增 5 例 P6）；`mock.test.ts` 的 submit 用例按新契约改写（`/result` 对 chunked 不再内联净值）+ 新增 2 例。

### 4.2 后端
| 命令 | 结果 | 证据 |
|---|---|---|
| `cargo check --workspace --all-targets` | **exit 0** | `07_backend_check_all_targets.txt` |
| `cargo test -p domain -p application` | **exit 0**（全 `test result: ok`） | `08_backend_tests_app.txt` |
| `EESTOCK_TEST_DATABASE_URL=<tmp> cargo test -p storage -p web -p mcp` | **exit 0**（55 个 suite 全 ok，0 FAILED） | `09_backend_tests_db.txt` |
| `./scripts/check-tangle.sh` | **exit 0**（`design 与生成物一致`） | `11_tangle_check.txt` |

**P6 新增后端用例（7 条）**
- `crates/application/tests/workbench.rs`：`p6_fills_block_single_seq_and_content`（单块 seq=0 / ts_from·ts_to / 元素字段 / `fill.ts == 对应 bar ts` / 与 per_bar fill 事件逐值等量）、`p6_fills_paging_and_recorded`（total/offset/limit/`has_more`/`next_offset` + 分页拼接逐值一致 + 超末尾空页）、`p6_fills_unrecorded_distinguished`（无块 ⇒ `recorded=false`）、`p6_fills_legacy_derived_from_inline_per_bar`（双读派生 + 过滤非 fill 事件）、`p6_fills_curve_sampling_rejected`（`/curve` 抽样拒绝，400 语义 + 文案）
- `crates/storage/tests/workbench_store.rs`：`chunks_kind_fills_round_trip`（CHECK 接受 `'fills'`、空块持久化、kind 隔离、payload 逐值 round-trip）
- `crates/web/tests/api_workbench.rs`：`p6_fills_endpoint`（真实库 run 上 `/fills` 形状 + `ts` 属于 per_bar ts 集合 + limit=1 逐页拼齐 + `/curve?kind=fills`→400 + `/bars?kind=fills`→400 + 未知 run→404）

**P6 新增前端用例（14 条）**
- `src/features/workbench/useRunSeries.test.ts`（6）：legacy 零网络同步派生 / chunked 三端点取数 + 抽样标注 / `loadMore` 消费 `next_offset` 直至拉满（ts 单调）/ `jumpToRange`（`from&to` + 范围标注 + 复位）/ `recorded=false` / 空态不发请求
- `src/features/workbench/ResultView.test.tsx`（+5）：**长区间不得静默截断**（12000 根 ⇒ `已加载 5000 / 共 12000` + 加载入口 + 两次加载到 12000 后提示消失 + 抽样标注）/ legacy 零回归（同步渲染、`/curve` 未被调用）/ 事件日志覆盖标注 + 加载更多 / K 线标记来自 `/fills` 精确源（断言 `getWorkbenchFills` 被调用且笔数 = fill 事件数）/ `recorded=false` 显式提示
- `src/api/mock.test.ts`（+2）：`/brief`/`/bars`/`/fills` 契约形状；**长区间（12000）`/result` 首页 5000 + has_more/next_offset + 分页拉满**
- `src/api/client.test.ts`（+1）：4 个新端点 URL/query 契约（含 RFC3339 编码）

---

## 5. 未决项 / 残余风险

1. **`/fills` 的超额字段**（`has_more`/`next_offset`/`recorded`）：见 §1.4，待架构师裁定是否回填 02-spec。
2. **`recorded=false` 的既有 run**：P6 之前落库的 `chunked_v1` run 无 fills 块（如 P4 期间产生的 run）。前端**显式提示**「未记录成交明细 ⇒ 标记可能不全」，**不静默少标记**。若需要回填，需另立专项（读 `per_bar` 块重建 fills 块）。
3. **K 线区间仍取 run `[from_ts, to_ts]`**：§5.2 明确「K 线不变」；run 级无 `available_range` 读端点（P5 才有）。已在 `KlineResultChart` 注释标注。
4. **`/curve` 服务端仍物化全量后抽样**（P4 §7.3 已记录）：本批未改（非 P6 范围），前端已按「有界响应」消费。
5. **区间跳读的时间精度**：UI 用 `datetime-local`（分钟精度）⇒ 跳到某区间的首/末可能夹在整分钟边界；服务端按 ts 闭区间过滤，返回根数以服务端口径为准（UI 显示服务端回的 `count`，不做本地推测）。
6. **MCP 未加 `/fills` 工具**（架构师明确「本次不必」）。`bt_get_run_result` 仍走 `result_compat`。
7. **非本任务范围（P5/P6 后续）**：区间收缩提示条、周期/可得区间联动、结构化错误展示、资源护栏二次确认 —— 均**未做**（架构师非目标）。

---

## 6. 提交面

- `git add` 仅本任务路径（`coder/evidence/adr024_p6/00_scope_git.txt` 逐条列出）；**未 `-A`**、**未 commit**。
- 共享工作区中的他车道改动（`docker-compose.yml`、`design/16/**`、`design/01-architecture/**`、`design/99-decisions-log.md`）**保持未 stage、未回退**。
- **P4 冻结局部解除的后果已对齐**：0027（CHECK + `'fills'`）、application 写/读路径、web 端点、`00-web-api.md` 的 P4 读侧契约均在本批并批重验（§4.2 全绿）；建议架构师安排 tester 重跑 P4 验收 + P6 真渲染（Playwright）验收。
