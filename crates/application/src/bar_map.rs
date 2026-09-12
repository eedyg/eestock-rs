//! 周期解析 + `domain::Bar -> backtest::Bar` 映射共享件（手写，非 tangle）。
//!
//! P4b（D16 终章）：旧 `BacktestService`（service.rs）已物理删除；本模块保留新系统
//! （`strategy.rs` 试算 / `workbench.rs` 工作台）复用的两个同口径辅助函数。
//! 周期口径：回测/试算支持 M1/M5/M15/H1/D1（I-6/D3：补 H1，与数据层 cagg 1h 对齐；
//! W1/MO1 为看板读源扩展，不入回测）。

use anyhow::anyhow;

/// 周期字符串 → `(domain::types::Period, backtest::Period)`。
pub fn parse_period(s: &str) -> anyhow::Result<(domain::types::Period, backtest::Period)> {
    match s {
        "M1" => Ok((domain::types::Period::M1, backtest::Period::M1)),
        "M5" => Ok((domain::types::Period::M5, backtest::Period::M5)),
        "M15" => Ok((domain::types::Period::M15, backtest::Period::M15)),
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
