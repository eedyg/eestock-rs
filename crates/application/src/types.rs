//! 应用层输入/输出类型（`SubmitReq` / `SubmitOutcome`）。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 提交回测请求（应用层输入；web 层从 `POST /api/backtest/runs` body 校验解析后构造）。
/// 对应 ADR §7 提交契约：`{code, period, from, to, strategy_id, params | params_grid, fee}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubmitReq {
    pub code: String,
    /// 回测周期：M1/M5/M15/D1（H1 回测暂不支持，submit 预校验拒绝）。
    pub period: String,
    /// 区间起点（闭）。
    pub from: DateTime<Utc>,
    /// 区间终点（开，`[from, to)`）。
    pub to: DateTime<Utc>,
    pub strategy_id: String,
    /// 单点参数（与 `params_grid` 二选一；网格场景下作为公共基础参数）。
    #[serde(default)]
    pub params: serde_json::Value,
    /// 参数网格 `{k: "起:止:步长"}`；有值则展开为 N 个子任务（共享 group_id）。
    #[serde(default)]
    pub params_grid: Option<serde_json::Value>,
    /// 费用 `{rate_pct, min_fee, slippage_bp}`（stamp_duty_pct 取 ADR bt-1 常量 0.05）。
    pub fee: serde_json::Value,
    /// 初始资金（默认 100_000，ADR §4）。
    pub initial_capital: Option<f64>,
}

/// `submit` 返回：单 run 返回 `run_id`；参数网格返回任务组 `group_id`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SubmitOutcome {
    /// 单次回测 run。
    Run(i64),
    /// 参数网格展开的任务组（N 个子任务共享）。
    Group(String),
}
