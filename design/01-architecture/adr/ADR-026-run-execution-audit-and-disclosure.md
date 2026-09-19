# ADR-026 回测结果的执行完整度审计与口径披露

- 状态：**已实现并验收（2026-09-19）**（用户授权「按建议修复，自主决策」；A1–A7 全绿，见 §6）
- 取代/影响：ADR-024 P6（`/fills` 为成交事实源）；不改引擎语义、不改数据库 schema
- 触发事件：`sr_1789738328788_000005`（518880/D1，`dca_baseline` + `Dca{tranches:100,interval:1}`）
  被读成「交易明细只有一条」，实测为「只投出 41.40% 名义资金、计划 100 批只推进 42 批、
  回合数 1 且由期末强平合成」。取证见
  `coder/evidence/20260918_sr_trades_system_side/`、`tester/evidence/20260919_sr_trades_rootcause_verify/`。

## 1. 背景（已取证的三个缺口）

1. **未满仓时绩效分母不披露**：8 项绩效（年化/回撤/夏普）恒定以 `initial_capital` 为分母；
   目标 run 只投出 41.40%（名义）/41.61%（含佣金）⇒ 同一笔亏损读出「年化 −4.24%」，
   按投入口径为「−10.10%」，**风险低估 2.42×**；接口与界面均无「资金投入率」字段。
2. **强平合成的回合对外不可辨**：`TradeDetail` 12 字段无来源；全库 174/359 个「有已实现回合」的
   run 全程无任何真实卖出，其中 132 个读出「胜率 100%」。
   （限定：`/fills` 与 `per_bar[].events` **已带** `reason='ForceClose'`，是 `trades`/绩效/默认 Tab 这条
   读径不可见，不是「系统不知道」。）
3. **执行完整度零观测**：末 bar 挂单结构上永不成交（引擎 `Pending` 需下一 bar）；
   全库 41/377 run 末 bar 有挂单，129/377 run 存在未执行挂单共 39,539 条；无计数、无事件、无字段、无日志。
   DCA 的 `plan_total/batches_done/取消原因` 全程不可见。

**数值层经三条独立重算判为无错（Δ 全 0）**：8 项绩效逐字段、173 点净值逐点、TradeDetail 12 字段；
双向 run（1209 点/40 回合）同样 Δ=0；`Σtrades.pnl == nav[-1] − initial` 成立。
⇒ 本 ADR **不动引擎语义**，只补「对外可读性」与「执行完整度披露」。

## 2. 决策

新增**只读派生的执行完整度审计（Execution Audit）**，按需从**已落库事实**计算，落库与读侧解耦：

### 2.1 事实源与推导规则（唯一口径）

| 量 | 事实源 | 推导 |
|---|---|---|
| 订单意图数 `reachable_batches` | `per_bar[].orders`（`side=Buy`） | 逐 bar 计数（含 warmup 段排除：`warmup=false`） |
| 实际买入批数 `batches_done` | `per_bar[].events` / `fills`（`side=Buy`） | 逐笔计数 |
| 未执行挂单 `unexecuted_orders` | 上述两者之差 | `intents − buy_fills`（≥0） |
| `last_bar_unfilled` | 末根 in-range bar 的 `orders` | 该 bar 存在 Buy 意图且其决策无次 bar 可成交 |
| 名义投入 `deployed_notional` | `Σ buy_fill.qty × buy_fill.price` | 敞口口径（不含费用） |
| 现金消耗 `cash_consumed` | 名义投入 + `Σ buy 佣金`（按 run config 的 fee 契约复算 `max(额×rate, min_fee)`） | 资金占用口径 |
| 回合数 `round_trips_total` | `strategy_run_result.trades` 长度 | 完全平仓回合 |
| 强平合成回合 `round_trips_force_closed` | 该 run 是否存在 `reason='ForceClose'` 的 Sell fill 且其平仓 bar 与 trade.close_bar 一致 | 读侧派生（历史 run 亦可判） |
| `planned_tranches` | run config `policy` | 仅 `Dca` 有值，其余 `null` |

**口径消歧（本次教训固化）**：`deployed_*`（敞口，不含费用）与 `cash_consumed*`（含佣金）
**必须分别命名、分别披露**，禁止再出现「41.40% vs 41.61%」这类同物异名。

### 2.2 接口契约（冻结）

新增只读端点（Web REST + MCP 各一），**不改** `/result`、`/bars`、`/fills`、`/curve` 的既有契约：

```
GET /api/workbench/runs/{id}/audit
200 {
  "run_id": "sr_…",
  "recorded": true,                     // 事实源齐全（per_bar.orders/events 或 fills 可得）
  "capital_basis": 100000.0,            // 绩效分母口径（= run config initial_capital）
  "deployed_notional": 41397.972081,
  "deployed_pct": 0.41397972,
  "cash_consumed": 41607.972081,
  "cash_consumed_pct": 0.41607972,
  "planned_tranches": 100,              // 非 Dca → null
  "reachable_batches": 43,
  "batches_done": 42,
  "unexecuted_orders": 1,
  "last_bar_unfilled": true,
  "round_trips_total": 1,
  "round_trips_force_closed": 1,
  "warnings": [
    {"code":"DCA_PLAN_UNDERFILLED","severity":"warn","message":"计划 100 批，区间内最多可推进 43 批、已成交 42 批（剩余批次随买入区结束取消）"},
    {"code":"PARTIAL_DEPLOYMENT","severity":"warn","message":"名义投入 41.40% 初始资金，年化/回撤/夏普分母仍为初始资金"},
    {"code":"ORDERS_UNEXECUTED","severity":"info","message":"1 笔挂单未成交（末根 bar 无次 bar 可执行）"}
  ]
}
404 运行不存在或无结果（复用既有错误码体系）
```

- **非阻断**：`warnings` 仅信息性，不改变引擎行为、不拒绝提交、不影响既有响应。
- **判据常量**：`PARTIAL_DEPLOYMENT` 阈值 `deployed_pct < 0.99`；
  `DCA_PLAN_UNDERFILLED` 当 `planned_tranches` 非空且 `batches_done < planned_tranches`；
  `ORDERS_UNEXECUTED` 当 `unexecuted_orders > 0`。阈值集中为具名常量（禁魔法值）。
- MCP 新增只读工具 `bt_get_run_audit { run_id }`，返回同结构（受既有 `strategy_tools_enabled` 开关约束）。

### 2.3 `TradeDetail` 来源字段（向后兼容）

- `TradeDetail` 新增 `reason: Option<String>`（`#[serde(default)]`；`"Policy" | "StopTrigger" | "ForceClose"`）。
  新 run 由引擎写入（清仓那一笔的来源）；**历史 run 该字段缺失 ⇒ `null`**，前端显示「未记录」，
  并在审计端点以 `round_trips_force_closed` 补足披露。**不改 `trade_count` 语义**（仍为平仓次数）。

### 2.4 前端披露（/backtest-workbench）

1. 「交易明细」Tab：表上方一行审计摘要（成交 N 笔（逐笔源 /fills）｜回合 M 条（其中强平合成 K 条）｜
   名义投入 X%（分母 = 初始资金）），`warnings` 以非阻断提示条展示；表格新增「来源」列。
2. 「8项绩效」Tab：加口径注（分母 = 初始资金；并列展示资金投入率）。
3. `profit_factor = null` 的既有语义（JSON 无法表达 ∞）在 UI 显示为「∞（无亏损）」并注明。

## 3. 明确不做（本轮范围外，登记为技术债）

- **提交期（pre-run）体检**：需要预跑才能知道意图数，成本与风险另议（ADR-024 P3 引擎增量后再评估）。
- **发布期信号分布体检**（能否买/能否卖/信号频率）：属治理项，另立 ADR。
- **历史 run 回填**：本审计按需派生，故无需回填；但 `TradeDetail.reason` 对历史 run 永久为 `null`。
- **未执行挂单归因**（现金不足 / `shares==0` / 末 bar）：仅区分 `last_bar_unfilled`，其余不归因（诚实留白）。
- 外部 DCA 族设计文档归档进仓库与命名修订（「定期定额」→「无择时梯次建仓」）：文档侧独立处理。

## 4. 质量属性

- **可测试性**：审计计算为**纯函数**（输入：意图列表、成交列表、fee 契约、`initial_capital`、policy），
  落在 domain/application 层，无 IO ⇒ 表驱动单测；端点另做集成测试。
- **可观测性**：端点发 `tracing::info!` span，含 `trace_id`、`run_id`、`deployed_pct`、
  `unexecuted_orders`、`warnings` 数（与仓内 `p4b.segment` 同风格）。
- **性能**：按需计算，逐块流式扫描 `per_bar`（分页上限沿用既有 `BARS_LIMIT_*` 常量），
  不新增常驻内存结构；仅在 UI 打开对应 Tab 时调用。

## 5. 验收（冻结，含反证要求）

| # | 判据 | 证据要求 |
|---|---|---|
| A1 | 纯函数表驱动单测全绿 | 用例含：目标 run 形态（43/42/1）、满仓、零成交、legacy、Dca 与非 Dca |
| A2 | **突变反证**：把推导改成常量或错配 → 单测必须变红 | 贴变异前后输出 |
| A3 | 目标 run 实测：`planned=100, reachable=43, done=42, unexecuted=1, last_bar_unfilled=true, deployed_pct≈0.41398, cash_consumed_pct≈0.41608`，含 3 条 warning | 原始 curl + 与独立重算对照 |
| A4 | 同区间 `LumpSum{1}` run（`sr_1789738272901_000004`）：`planned=null`、`deployed_pct≈0.9998`、无 `PARTIAL_DEPLOYMENT` | 原始 curl |
| A5 | 双向 run（`sr_1789044295239_000111`）：`batches_done == buy fills 数`、`round_trips_total == trades 长度`、`round_trips_force_closed` 与事件流一致 | 三方自洽断言 |
| A6 | 前端真浏览器 E2E：交易明细 Tab 出审计摘要与 warning、来源列、8项表口径注；无 console 错误 | Playwright 截图 + console + 网络 |
| A7 | 既有测试回归：受影响套件全绿（需 DB 的用 ADR-025 临时库，跑完 DROP 并回读库清单） | 原始输出 + teardown 证据 |

## 6. 交付与验收记录（2026-09-19）

**实现**（未提交，冻结 tarball `coder/backups/adr026_frozen_20260919T105844Z.tar.gz`，27 文件，HEAD `e807385`）：

- 纯函数审计 `crates/application/src/audit.rs`（常量具名、复用 `backtest::FeeModel`、`recorded=false` 时诚实留白）；
- Web `GET /api/workbench/runs/{id}/audit`（`crates/web/src/workbench.rs` + 路由）与 MCP `bt_get_run_audit`；
- `TradeDetail.reason: Option<String>`（`#[serde(default)]`，引擎三处清仓路径写入来源；历史 run 为 `null`）；
- 前端：`useRunAudit` 懒加载 + ResultView 审计摘要/warning 条/来源列 + 8 项表口径注 + `profit_factor=null` → 「∞（无亏损）」；
- `design/99-decisions-log.md` 登记一行。

**验收证据**（独立 tester 车道，未采信实现方输出）：

| 项 | 结果 | 关键读数 |
|---|---|---|
| A3 目标 run 线上实测 | PASS | `planned=100, reachable=43, done=42, unexecuted=1, last_bar_unfilled=true, deployed_pct=0.41397972, cash_consumed_pct=0.41607972`，3 条 warning；独立 SQL 重算 Δ=0 |
| A4 满仓对照 | PASS | `planned=null, deployed_pct=0.99975, warnings=[]` |
| A5 双向 run 三方自洽 | PASS | `reachable=done=40`、`round_trips_total=40=trades 长度`、`force_closed=0` |
| A6 真浏览器 E2E | PASS | 7 用例绿；L1「成交合计 43 笔（含期末强平卖出 1 笔）」、L2「买入成交 42 笔」；两项变异反证（改数据/注掉渲染）均变红后逐字节还原 |
| A1/A2 纯函数与突变 | PASS | 18 单测绿；两处推导突变 → 5 单测 + 2 端点回放变红，还原后 sha256 逐字节一致 |
| A7 回归 | PASS | fresh-DB `cargo test --workspace --no-fail-fast` ×3 全绿（130 目标/895 用例）；前端 vitest 94 文件/916 用例；`-p web` 默认并行 ×5 绿 |

**本轮一并修复的既有问题**：

1. `crates/web/tests/adr026_run_audit.rs` 并行 flake（跨用例 DELETE 触发 FK 23503；tracing 捕获并发 span）⇒ 改为按唯一 source 隔离 + scoped subscriber 按 run_id 过滤；
2. `tester_p5rect_verify::t_n1_http_every_400_is_structured_object` 既有红（阈值漂移：`GUARD_CONFIRM_BARS=500_000` 经 ADR-024 `f2726da` 有意上移，测试夹具区间未同步）⇒ 夹具区间改为 2016-01→2027-01（实测 627,564 bar）；
3. 摘要口径消歧：`deployed_*`（敞口）与 `cash_consumed*`（含佣金）分别命名并同屏披露。

## 7. 已登记债务（本轮不做，需单独立项）

| # | 债务 | 事实 | 建议修法 |
|---|---|---|---|
| D1 | 跨目标共享库隔离 flake：`orphan_detect_endpoint_red::r1_*`（同库连跑第 2 次红，`left:2 right:0`） | 既有、与本批代码无关（全新库 3/3 绿可证）；污染源之一是 `tester_p5_indep.rs` 只删 symbol/run 不删派生 cagg，且任意宽窗 `refresh_continuous_aggregate` 会把它物化 | 在 test-support 提供 `cleanup_kline_fixture(pool, code)`（删 `kline_accurate` + 遍历 `storage::reader::ORPHAN_TABLES` 按 code 删），所有真库播种测试统一调用；或给孤儿检测类测试固定专用一次性库 |
| D2 | 提交期（pre-run）体检 | 见 §3 | 待 ADR-024 P3 增量引擎就绪后评估 |
| D3 | 发布期信号分布体检（能否买/能否卖/信号频率） | 发布链路发现不了「结构性单边」策略 | 另立 ADR |
| D4 | 外部 DCA 族设计文档不在仓库、命名与能力不符 | 见取证报告 | 文档归档 + 命名修订（「定期定额」→「无择时梯次建仓」） |
| D5 | 错误体形状不一致：404 家族为字符串形 `{"error":"…"}`，400 家族为对象形 `{"error":{code,detail,message}}` | 2026-09-19 部署后冒烟 S3（O1） | 统一为对象形（带 `code`）——**属对外契约变更，需先行批准** |
| D6 | `Dca.interval=0` 被接受（201）并 succeeded；`tranches=0` 已正确拒绝 | 冒烟 S3d（O2，run `sr_1789787981802_000007`） | 二选一：在 config 回显里写入规范化后的 `interval`，或在 `Dca.validate()` 拒绝 0；现状是静默规范化（`norm_interval`） |
| D7 | 超大 run（M1 686,368 根，预估 ≈430s）完整成功路径未端到端验证（本次为保护主机主动 cancel）；已有 392,589 根 M1 成功先例 | 冒烟 S3b（O4） | 单独开一个长窗口验证，或纳入 P4b 性能治理一并覆盖 |

## 8. 风险

- 审计端点要扫 `per_bar`，超大 run（`MAX_BARS=200_000`）单次成本约 MB 级读取 ⇒ 只在前端按需调用；
  若后续出现延迟问题，走 ADR-024 P3 增量索引路线优化（不在本轮）。
- `TradeDetail.reason` 一旦写入即成为对外契约的一部分，改动须走 ADR。
