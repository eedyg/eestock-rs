# 038 — 回测 BOLL 默认 mode 改为 mean_reversion

本报告文件位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/038_backtest_boll_default_mean_reversion.md`

## What changed

仅修改 `crates/backtest/src/strategies.rs`，共 4 处代码 + 1 处新增单测。

| 位置 | 之前 | 之后 |
|------|------|------|
| 工厂 `create_strategy`（`boll` 分支，L678） | `get_choice(params, "mode", "trend")` | `get_choice(params, "mode", "mean_reversion")` |
| `params_schema` 中 `mode` 的 `def`（L343） | `def: "trend"` | `def: "mean_reversion"` |
| `params_schema` 中 `mode` 的 `options`（L342） | `["trend", "mean_reversion"]` | `["mean_reversion", "trend"]`（均值回归在前） |
| 模块 doc 默认口径说明（L14） | `trend` … 为默认 | `mean_reversion` … 为默认；`trend` 仍为可选 |
| `BollStrategy` struct doc（L298） | `trend` 默认 | `mean_reversion` 默认 |

新增单测 `boll_default_mode_is_mean_reversion`（约 L952-985）：校验「无 mode 参数时默认行为为 mean_reversion（收破下轨 → Buy）」且校验 schema `mode` 的 `def`/`options` 顺序。

## Architecture alignment

纯参数默认值改动，位于 `crates/backtest/src/strategies.rs` 的策略实现层（编译期注册表 + 工厂）。未改任何接口、`Strategy` trait、`ParamKind`/`ParamDef` 类型、层边界或依赖方向。`trend` 仍保留为合法的显式可选 mode（`on_bar` 的 `if self.mode == "mean_reversion" { … } else { … }` 分支未改），与架构师裁定「06-web 单列 BOLL 为均值回归、默认对齐产品权威；`trend` 仍作为可选 mode」一致。

## Problem solved / feature added

架构师裁定将 BOLL 默认对齐产品权威（均值回归），本改动把两个默认值来源统一为 `"mean_reversion"`：
1. `create_strategy` 工厂在 `mode` 参数缺省时的默认值；
2. `params_schema` 中 `mode` 的 `Choice::def`（供 UI 表单回填默认）。

确保运行时默认与 UI 目录 schema 默认一致，避免工厂与目录默认值分叉。

## Implementation approach

- 判断为既已裁决的小改动，无需再向父级做架构决策；按 TDD 走 Red→Green→Refactor。
- **Red**：先加单测 `boll_default_mode_is_mean_reversion`，首跑失败（默认仍 `trend`）。
- **Green**：改工厂默认 + schema `def`/`options` 顺序 + 两处 doc 注释。
- **Refactor**：修正测试设计缺陷——默认 `period=20` 需要 >20 根 bar 才能产出 `boll`，故测试显式传 `period=5,k=1.5` 但不传 `mode`，以隔离「mode 默认值」这一被测对象；非靠删/改既有断言来贴合实现。
- **范围控制**：仅改 `strategies.rs`；未改 `indicators.rs`、`types.rs`、`lib.rs`、集成测试或任何第三方依赖。

## Test coverage

- 新增：`strategies::tests::boll_default_mode_is_mean_reversion`（工厂默认行为 + schema default/options 顺序）。
- 既有 BOLL 测试均为显式传 `mode`（`boll_trend_mode_cross`、`boll_mean_reversion_mode_inverted`、`cross_strategy_consistency_boll_band`），不依赖默认 mode，故断言不变、无需更新；确认无「黄金样本」依赖默认 mode（`tests/golden_sample.rs` 仅测 dual_ma）。
- 未删除/改写任何既有断言。

## Verification

- `cargo test -p backtest` → 全绿：43 passed（unit）+ 2 passed（golden_sample：`dual_ma_signal_crossings`、`golden_dual_ma_pipeline`）。
- `cargo clippy -p backtest --all-targets` → 无告警。
- 确定性：全部测试为「手工构造固定 bar 序列 + 显式固定参数」，无 RNG/无时间依赖/无实时数据；连续两次运行结果一致（可复现）。
- `git status --short`/`git diff --cached`：无本任务引入的已暂存文件。`crates/backtest/` 为未跟踪的新 crate（`strategies.rs` 属其中）；`Cargo.lock` 的 `backtest` 包条目为任务开始前已存在的改动，非本次引入。

## 默认 mode 前后

- 之前（`trend` 默认）：`create_strategy("boll", {})` → `mode == "trend"`；schema `def: "trend"`、`options: [trend, mean_reversion]`。收破上轨 → Buy；收破下轨 → Sell。
- 之后（`mean_reversion` 默认）：`create_strategy("boll", {})` → `mode == "mean_reversion"`；schema `def: "mean_reversion"`、`options: [mean_reversion, trend]`。收破下轨 → Buy；收破上轨 → Sell。显式传 `mode=trend` 仍返回趋势行为（`on_bar` 分支未改）。
