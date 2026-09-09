//! 周期解析 + `domain::Bar -> backtest::Bar` 映射共享件（手写，非 tangle）。
//!
//! P4b（D16 终章）：旧 `BacktestService`（service.rs）已物理删除；本模块保留新系统
//! （`strategy.rs` 试算 / `workbench.rs` 工作台）复用的两个同口径辅助函数。
//! 周期口径：回测/试算仅 M1/M5/M15/D1（H1 拒绝；W1/MO1 为看板读源扩展，不入回测）。

use anyhow::anyhow;

/// 周期字符串 → `(domain::types::Period, backtest::Period)`。H1 回测不支持（设计仅 1m/5m/15m/日）。
pub fn parse_period(s: &str) -> anyhow::Result<(domain::types::Period, backtest::Period)> {
    match s {
        "M1" => Ok((domain::types::Period::M1, backtest::Period::M1)),
        "M5" => Ok((domain::types::Period::M5, backtest::Period::M5)),
        "M15" => Ok((domain::types::Period::M15, backtest::Period::M15)),
        "D1" => Ok((domain::types::Period::D1, backtest::Period::D1)),
        "H1" => Err(anyhow!("周期 H1 回测暂不支持（仅 M1/M5/M15/D1）")),
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
