// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/strategy_state.rs>>[init]
//! 策略 Registry 状态机与强类型枚举（12-strategy-system / P2a；ADR 12-strategy-system §5）。
//! 纯函数校验模块：流转表驱动、无 IO、可单测（TDD：本模块测试即合法流转的可执行规格）。

use serde::{Deserialize, Serialize};

/// 版本状态（strategy_version.status）：draft → published → archived 单向流转（ADR §5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyStatus { Draft, Published, Archived }

impl StrategyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            StrategyStatus::Draft => "draft",
            StrategyStatus::Published => "published",
            StrategyStatus::Archived => "archived",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "draft" => Some(StrategyStatus::Draft),
            "published" => Some(StrategyStatus::Published),
            "archived" => Some(StrategyStatus::Archived),
            _ => None,
        }
    }
}

/// 权限分级（strategy_version.approval_level）：backtest_ok → sim_ok → live_approved
/// 有序升级（ADR §5：独立标记，升级需显式动作）。rank 用于 catalog at-least 过滤。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalLevel { BacktestOk, SimOk, LiveApproved }

impl ApprovalLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalLevel::BacktestOk => "backtest_ok",
            ApprovalLevel::SimOk => "sim_ok",
            ApprovalLevel::LiveApproved => "live_approved",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "backtest_ok" => Some(ApprovalLevel::BacktestOk),
            "sim_ok" => Some(ApprovalLevel::SimOk),
            "live_approved" => Some(ApprovalLevel::LiveApproved),
            _ => None,
        }
    }
    /// 阶梯 rank（backtest_ok=1 < sim_ok=2 < live_approved=3）。
    pub fn rank(&self) -> u8 {
        match self {
            ApprovalLevel::BacktestOk => 1,
            ApprovalLevel::SimOk => 2,
            ApprovalLevel::LiveApproved => 3,
        }
    }
    /// catalog 过滤（at-least 语义）：本级别是否满足要求的最低级别。
    pub fn satisfies(&self, required: &ApprovalLevel) -> bool {
        self.rank() >= required.rank()
    }
}

/// 策略类别（strategy.kind）：strategy=用户策略 / template=官方模板（ADR §13.2 D10）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyKind { Strategy, Template }

impl StrategyKind {
    pub fn as_str(&self) -> &'static str {
        match self { StrategyKind::Strategy => "strategy", StrategyKind::Template => "template" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "strategy" => Some(StrategyKind::Strategy),
            "template" => Some(StrategyKind::Template),
            _ => None,
        }
    }
}

/// 非法状态流转（状态机校验失败载荷；application 层包装后 web 映射 409）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTransition {
    pub from: StrategyStatus,
    pub to: StrategyStatus,
}

impl std::fmt::Display for InvalidTransition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "非法状态流转: {} → {}（合法：draft→published→archived 单向）",
               self.from.as_str(), self.to.as_str())
    }
}

impl std::error::Error for InvalidTransition {}

/// 合法流转判定（单向表驱动）：draft→published、published→archived。
pub fn can_transition(from: StrategyStatus, to: StrategyStatus) -> bool {
    matches!(
        (from, to),
        (StrategyStatus::Draft, StrategyStatus::Published)
            | (StrategyStatus::Published, StrategyStatus::Archived)
    )
}

/// 流转校验：合法 → Ok(())；非法 → Err(InvalidTransition)。
pub fn validate_transition(from: StrategyStatus, to: StrategyStatus)
    -> Result<(), InvalidTransition> {
    if can_transition(from, to) { Ok(()) } else { Err(InvalidTransition { from, to }) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StrategyStatus::*;

    /// 全流转表（3×3=9 对）：仅 draft→published、published→archived 合法。
    #[test]
    fn transition_table_full() {
        let all = [Draft, Published, Archived];
        for from in all {
            for to in all {
                let expected = matches!((from, to),
                    (Draft, Published) | (Published, Archived));
                assert_eq!(can_transition(from, to), expected, "{from:?} → {to:?}");
                assert_eq!(validate_transition(from, to).is_ok(), expected);
            }
        }
    }

    #[test]
    fn invalid_transition_display_mentions_states() {
        let e = validate_transition(Draft, Archived).unwrap_err();
        assert_eq!(e, InvalidTransition { from: Draft, to: Archived });
        let msg = e.to_string();
        assert!(msg.contains("draft") && msg.contains("archived"));
    }

    #[test]
    fn status_str_roundtrip() {
        for s in [Draft, Published, Archived] {
            assert_eq!(StrategyStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(StrategyStatus::parse("unknown"), None);
    }

    #[test]
    fn approval_level_ladder_and_satisfies() {
        use ApprovalLevel::*;
        assert!(BacktestOk.rank() < SimOk.rank() && SimOk.rank() < LiveApproved.rank());
        // at-least 语义：高级别通过低级别过滤；低级别不满足高级别要求。
        assert!(LiveApproved.satisfies(&BacktestOk));
        assert!(LiveApproved.satisfies(&LiveApproved));
        assert!(SimOk.satisfies(&BacktestOk));
        assert!(!BacktestOk.satisfies(&SimOk));
        assert!(!BacktestOk.satisfies(&LiveApproved));
        for l in [BacktestOk, SimOk, LiveApproved] {
            assert_eq!(ApprovalLevel::parse(l.as_str()), Some(l));
        }
        assert_eq!(ApprovalLevel::parse("admin"), None);
    }

    #[test]
    fn kind_str_roundtrip() {
        for k in [StrategyKind::Strategy, StrategyKind::Template] {
            assert_eq!(StrategyKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(StrategyKind::parse("builtin"), None);
    }

    #[test]
    fn serde_snake_case() {
        assert_eq!(serde_json::to_string(&Draft).unwrap(), "\"draft\"");
        assert_eq!(serde_json::to_string(&ApprovalLevel::LiveApproved).unwrap(),
                   "\"live_approved\"");
        assert_eq!(serde_json::to_string(&StrategyKind::Template).unwrap(), "\"template\"");
    }
}
// ~/~ end
