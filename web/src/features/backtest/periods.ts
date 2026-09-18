/**
 * ADR-024 P0 §5.1 —— 回测周期白名单的**前端镜像常量**（唯一前端事实源）。
 *
 * 后端权威事实源：`application::bar_map::supported_backtest_periods()`。
 * 本常量必须与以下三者**逐字相等**（防漂移断言）：
 * - 后端：`crates/application/src/bar_map.rs::supported_backtest_periods()`
 * - MCP：`crates/mcp/src/tools.rs` 的 `bt_run_ensemble` / `strategy_test_run` `period.enum`
 * - 契约向量：`design/16-backtest-scalability/contract-vectors.json::backtest_periods`
 *
 * 断言消费方：
 * - Rust 跨层断言 `crates/mcp/tests/adr024_period_ssot_drift.rs`（读取本文件字面量）；
 * - 前端 vitest `web/src/features/backtest/periods.test.ts`（与本文件 + 向量比对）。
 *
 * 用途：工作台/试算周期下拉、mock 白名单——不得在任何消费点再手写第二份。
 * 注：看板读源的小写档位（`1m`/`30m`/…）由 `@/layouts/DashboardGrid` 的 `Period` 承载，与此不同源。
 */
export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'M30', 'H1', 'D1'] as const;

/** 回测周期档位类型（由镜像常量派生，避免第二处联合类型）。 */
export type BacktestPeriod = (typeof SUPPORTED_BACKTEST_PERIODS)[number];
