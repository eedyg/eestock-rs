//! 周期解析 + `domain::Bar -> backtest::Bar` 映射共享件（手写，非 tangle）。
//!
//! P4b（D16 终章）：旧 `BacktestService`（service.rs）已物理删除；本模块保留新系统
//! （`strategy.rs` 试算 / `workbench.rs` 工作台）复用的两个同口径辅助函数。
//! 周期口径：回测/试算支持 M1/M5/M15/M30/H1/D1（I-6/D3：补 H1，与数据层 cagg 1h 对齐；
//! **ADR-024 P0：补 M30**——回测/试算/MCP 的 30min 档打通，数据层 `kline_accurate_30m` 早已就绪；
//! W1/MO1 为看板读源扩展，不入回测）。
//!
//! **单一事实源（ADR-024 §5.1）**：`supported_backtest_periods()` 是回测周期白名单的唯一权威来源，
//! web/MCP/前端镜像常量均不得再手写第二份（防漂移断言见 `tests/backtest_periods_ssot.rs`
//! 与 `crates/mcp/tests/adr024_period_ssot_drift.rs`）。

use anyhow::anyhow;

/// 回测/试算支持的周期档位（**唯一权威事实源**，ADR-024 §5.1）。
/// 顺序即 UI 展示序（M1/M5/M15/M30/H1/D1，按时间粒度升序）。
///
/// 消费方（必须由本函数/`parse_period` 导出，不得硬编码）：
/// - `crates/web/src/workbench.rs` 的 `submit_run` 预校验（调 `parse_period`）；
/// - `crates/mcp/src/tools.rs` 的 `valid_bt_period` 与 `bt_*`/`strategy_test_run` 的 JSON schema `enum`；
/// - 前端镜像常量 `web/src/features/backtest/periods.ts::SUPPORTED_BACKTEST_PERIODS`。
/// - 契约向量 `design/16-backtest-scalability/contract-vectors.json::backtest_periods`。
pub fn supported_backtest_periods() -> &'static [&'static str] {
    &["M1", "M5", "M15", "M30", "H1", "D1"]
}

/// 周期字符串 → `(domain::types::Period, backtest::Period)`。
/// match 臂必须与 `supported_backtest_periods()` 一一对应（回环断言在
/// `tests/backtest_periods_ssot.rs::every_ssot_period_parses_roundtrip`）。
pub fn parse_period(s: &str) -> anyhow::Result<(domain::types::Period, backtest::Period)> {
    match s {
        "M1" => Ok((domain::types::Period::M1, backtest::Period::M1)),
        "M5" => Ok((domain::types::Period::M5, backtest::Period::M5)),
        "M15" => Ok((domain::types::Period::M15, backtest::Period::M15)),
        // ADR-024 P0：30min 档打通（数据层 kline_accurate_30m 就绪，ADR-023 §2.4）。
        "M30" => Ok((domain::types::Period::M30, backtest::Period::M30)),
        "H1" => Ok((domain::types::Period::H1, backtest::Period::H1)),
        "D1" => Ok((domain::types::Period::D1, backtest::Period::D1)),
        other => Err(anyhow!("未知周期: {other}")),
    }
}

/// `domain::types::Bar -> backtest::Bar`（ts 转 Unix 秒；volume 转 f64）。
pub(crate) fn to_bt_bar(b: &domain::types::Bar) -> backtest::Bar {
    backtest::Bar {
        ts: b.ts.timestamp(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume as f64,
    }
}

/// I-2/D6：warmup 前置取数窗口。给定周期与请求的前置根数，返回向前回溯的时间跨度
/// （宁可多取，调用方只截取 `from` 之前最近 `warmup_bars` 根；见 `strategy::test_run`）。
/// 估算口径：A 股每日交易 4 小时（分钟级占空比 1/6）+ 周末/假日系数，向上取整。
pub fn warmup_lookback(period: &domain::types::Period, warmup_bars: usize) -> chrono::Duration {
    let bar_secs: i64 = match period {
        domain::types::Period::M1 => 60,
        domain::types::Period::M5 => 300,
        domain::types::Period::M15 => 900,
        // ADR-023 增 30m；ADR-024 P0 起回测/试算 gate（parse_period）已接受 M30（回测档位大写 "M30"）。
        domain::types::Period::M30 => 1_800,
        domain::types::Period::H1 => 3_600,
        domain::types::Period::D1 => 86_400,
        // 看板扩展周期（不入回测）：保守按日线占位。
        domain::types::Period::W1 | domain::types::Period::MO1 => 86_400,
    };
    let factor: i64 = match period {
        domain::types::Period::W1 | domain::types::Period::MO1 | domain::types::Period::D1 => 3,
        _ => 30,
    };
    chrono::Duration::seconds(bar_secs * factor * warmup_bars as i64)
}
