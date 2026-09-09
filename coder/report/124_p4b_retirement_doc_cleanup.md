# Coder 报告 124 — P4b 修复包：退役文档/残留清理 8 项

- 任务：reviewer findings（MAJOR-1/2 + MINOR-1~6），架构裁决已定，按任务书逐项落地。
- 本报告位置：`coder/report/124_p4b_retirement_doc_cleanup.md`
- 时间：2026-09-10

## 修复 → 证据对应表

| # | 修复内容 | 涉及文件 | 证据 |
|---|---|---|---|
| MAJOR-1 | 删 `IN_TOPIC_ALIAS` 的 `backtest_progress→'backtest'` 行；删锁定已删协议的测试用例（出站 subscribe topic:'backtest' + backtest_progress 帧分发） | `web/src/ws/WsClient.ts`、`web/src/ws/WsClient.test.ts` | `grep backtest_progress web/src/` 零命中；`npm test` 中 WsClient 套件全绿 |
| MAJOR-2 | §1.5 节首加退役 banner（仿 06-web/05-backtest.md:3-6 先例）；§1.6 `GET /api/sim-live/strategies` 行数据源 `list_builtin_strategies` → 钉住快照映射（代码实况 `web/src/simlive.rs:247` P4a 注释一致）；§4 引言 backtest.rs/BacktestWsSink 现存性注记改为「已随 P4b 退役，历史记录」 | `design/07-app-plane/00-web-api.md` | 散文改动；`entangled tangle -f` 后所有 tangle 生成物零 diff（见验证节） |
| MINOR-1 | 删除 6 个零消费方公开类型 `Signal`/`Ctx`/`Strategy`/`RunConfig`/`BacktestResult`/`StrategyResult`；lib.rs 再导出同步收敛为 `{Bar, ParamDef, ParamKind, ParamValue, Period, StrategyParams, TradeDetail}`；types.rs/lib.rs 头部失实注释修正（含 StrategyResult 指向已删端点 `GET /api/backtest/strategies` 的注释、"strategy-core 测试仍以 Strategy/Ctx/Signal 校验"失实句、Signal::Buy 口径 bullet） | `crates/backtest/src/types.rs`、`crates/backtest/src/lib.rs` | 全 workspace grep 六类型零引用（见下）；`cargo build --workspace` 0 error |
| MINOR-1 附带 | `crates/strategy-core/src/aggregate.rs:13` doc 注释中 `backtest::Signal` 悬空引用随删除修正（注释级，无逻辑改动） | `crates/strategy-core/src/aggregate.rs` | 编译+测试绿 |
| MINOR-2 | reference.rs 头部注释：`tests/equivalence.rs` 已随 P4b 删除（旧 Rust 内建策略本体不再存在）；加注「7 个播种插件 JS 内注释若提及 equivalence.rs 为**冻结历史记录**——JS 字节是 sha256 寻址播种源，改注释=变哈希=扰动播种语义，故有意保留不改」 | `crates/strategy-core/src/reference.rs` | **未改任何 JS 插件文件**（`git status` 中 reference-plugins/*.js 零改动）；strategy-core 测试绿（含播种哈希守护单测） |
| MINOR-3 | §2/§7 各加 P4b 退役注记：「§7 服务链（BacktestService/内置策略//api/backtest 端点）已于 P4b 退役删除；§1-§6 口径对保留件（fee/indicators/metrics/types）继续有效」 | `design/08-backtest/01-engine-adr.md` | 纯散文，无代码块；tangle 无 diff |
| MINOR-4 | §4.3.5 节首 + storage 模块段（原 :431-433）加 P4b 注记：「BacktestRunStore/PgBacktestStore 已随 P4b 删除；backtest_runs/backtest_results 表保留不读写（迁移不回收，未来 DROP 另立项）」；模块段首行改为现状 `BacktestBarRead`（与 `crates/storage/src/backtest.rs` 头部 P4b 注释一致） | `design/04-storage/schema.md` | 散文改动，未触 `migrations/0011_backtest.sql` 代码块；tangle 无 diff |
| MINOR-5 | Cargo.toml 头部注释与 description 改为现状：StrategyService / WorkbenchService / SimLiveService 等；移除已删 BacktestService/BacktestRunStore/BacktestProgressSink 描述，并留 P4b 退役注记 | `crates/application/Cargo.toml` | 与 `crates/application/src/lib.rs` 现状模块清单一一对应；`cargo build` 0 error |
| MINOR-6 | :951 节标 `RealtimeStrategyOrchestrator 联动` → `策略编排器联动（…P4a 起策略源为 Registry 插件编排器 PluginStrategyOrchestrator）` | `crates/application/tests/simlive.rs` | 与 `crates/simlive/src/strategy_orchestrator.rs` 头部 P4b 注释（旧 RealtimeStrategyOrchestrator 已删）一致；application 测试全绿 |

## 零引用确认（MINOR-1 前置门禁）

全 workspace grep（`crates/`，排除 backtest/src/types.rs 与 lib.rs 自身）：
- `BacktestResult` / `StrategyResult`：零命中。
- `RunConfig`：仅 strategy-runtime 两处**注释**提及（ABI 文档措辞，非 `backtest::RunConfig` 引用）。
- `Signal`：命中均为 `TradeSignal`/`StrategySignal` 等无关符号；唯一对 `backtest::Signal` 的引用为 aggregate.rs:13 doc 注释（本包附带修正）。
- `Ctx`：命中均为 `BarCtx`（strategy-runtime ABI）与 rquickjs 的 `Ctx`（strategy-runtime 内部），无 `backtest::Ctx`。
- `Strategy`（trait）：命中均为 `StrategyKind`/`StrategyStore`/`NewStrategy` 等 Registry 类型，无 `backtest::Strategy`。

`TradeDetail` 被 strategy-core 引擎真实消费（`engine.rs:28/233/345/683`），按任务书保留。

## 验证

1. `cargo build --workspace` → Finished，0 error（warning 计数未新增，本包只删未用代码）。
2. `cargo test -p strategy-core -p application -p web -p mcp -p simlive` → 全部 suite `0 failed`（唯一 ignored=1 为既有项）。
3. `entangled tangle` / `entangled tangle -f` → "Nothing to be done"；校验：`git diff --name-only -- <全部 tangle targets>` 为空（设计源改动均为散文/注释，生成物零 diff）。（entangled 输出一条 pre-existing "conflicts found" warning——多文档共写同一 target 的既有状态，与本次改动无关。）
4. `cd web && npm test` → 437 测试：430 passed / **7 failed 全部为 alerts（页面⑦）**；pre-existing 证明：stash 掉本包 web/src/ws 改动后单独跑 `vitest run src/features/alerts` 仍同样 7 failed（与本包无关）。
5. `npm run build` → `✓ built in 1.72s`，0 error（chunk >500kB 为既有提示）。
6. `git add` 已暂存 11 个本包文件；未 commit。红线复核：未改 `crates/strategy-runtime`；未改任何 JS 插件（`reference-plugins/*.js` 零改动）；无其他代码逻辑改动。

## 残留风险

- alerts 7 个前端测试失败为 pre-existing（页面⑦），本包未触碰，仍待其归属任务修复。
- §1.5 的正文 REST/WS 表与 DI 段按任务书「保留仅为历史记录」未逐行改写，仅节首 banner + §4 引言修正现存性。
