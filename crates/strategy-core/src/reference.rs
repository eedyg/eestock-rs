//! 首期参考插件包（ADR `design/12-strategy-system/01-adr.md` §7 D8）+ 官方策略模板（§13.2 D10）。
//!
//! - 7 款参考插件：Rust 内建策略（`backtest::strategies`）的 JS 1:1 迁移，兼作用户模板与
//!   测试 fixture；迁移等价性测试见 `tests/equivalence.rs`（golden bars 信号序列逐 bar 一致）。
//! - 4 款官方模板：ABI §4.5（纯评分 / 两态门控 / 定投 / 趋势+止损），编辑器「新建策略」起点。
//!
//! 代码经 `include_str!` 静态内嵌（发布内容 = 仓内文件字节，sha256 寻址的播种源），
//! 供 P2 Registry 播种与测试共用；纯静态、无 serde、无 IO（Domain 层红线）。

/// 参考插件 / 官方模板目录条目（对应 Registry 播种的一行 strategy_version）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReferencePlugin {
    /// 策略 id（与 Rust 内建策略 id 一致；模板为 `模板名`）。
    pub id: &'static str,
    /// 显示名。
    pub name: &'static str,
    /// 描述（与 Rust catalog 口径一致）。
    pub description: &'static str,
    /// 插件 JS 源码全文（strategy_version.code 的播种内容）。
    pub code: &'static str,
}

/// 7 款参考插件（顺序与 `backtest::strategies::builtin_strategy_ids()` 固定顺序一致）。
pub fn reference_plugins() -> Vec<ReferencePlugin> {
    vec![
        ReferencePlugin {
            id: "dual_ma",
            name: "双均线交叉",
            description: "快/慢均线金叉买入、死叉卖出",
            code: include_str!("../reference-plugins/dual_ma.js"),
        },
        ReferencePlugin {
            id: "ma_rsi",
            name: "均线+RSI 过滤",
            description: "均线交叉定方向 + RSI 超买/超卖过滤（方向正确才开仓）",
            code: include_str!("../reference-plugins/ma_rsi.js"),
        },
        ReferencePlugin {
            id: "macd",
            name: "MACD 金叉/死叉",
            description: "DIF 上穿 DEA 金叉买入、下穿死叉卖出",
            code: include_str!("../reference-plugins/macd.js"),
        },
        ReferencePlugin {
            id: "boll",
            name: "BOLL 带突破",
            description: "收破上轨买/下破下轨卖（趋势或均值回归，mode 参数）",
            code: include_str!("../reference-plugins/boll.js"),
        },
        ReferencePlugin {
            id: "kdj",
            name: "KDJ 金叉/死叉",
            description: "K 上穿 D 金叉买入、下穿死叉卖出",
            code: include_str!("../reference-plugins/kdj.js"),
        },
        ReferencePlugin {
            id: "momentum",
            name: "动量突破",
            description: "close 突破 N 日高点买入、跌破 N 日低点卖出",
            code: include_str!("../reference-plugins/momentum.js"),
        },
        ReferencePlugin {
            id: "atr_channel",
            name: "ATR 通道突破",
            description: "Donchian 通道突破买卖 + ATR 止损",
            code: include_str!("../reference-plugins/atr_channel.js"),
        },
    ]
}

/// 4 款官方策略模板（ADR §13.2 D10 / ABI §4.5；编辑器「新建策略」可选起点）。
pub fn official_templates() -> Vec<ReferencePlugin> {
    vec![
        ReferencePlugin {
            id: "pure_score",
            name: "纯评分模板",
            description: "不读 position 的最小评分骨架（教学向）",
            code: include_str!("../reference-plugins/templates/pure_score.js"),
        },
        ReferencePlugin {
            id: "two_state_gate",
            name: "两态门控模板",
            description: "空仓才给买入区高分、持仓期中立——示范门控",
            code: include_str!("../reference-plugins/templates/two_state_gate.js"),
        },
        ReferencePlugin {
            id: "dca",
            name: "定投模板",
            description: "按 bars_since_entry 控制高分时机，配合 DCA Policy",
            code: include_str!("../reference-plugins/templates/dca.js"),
        },
        ReferencePlugin {
            id: "trend_stop",
            name: "趋势+止损模板",
            description: "趋势评分 + close 跌破 avg_cost×(1−stop_pct) 输出 0（软止损示范）",
            code: include_str!("../reference-plugins/templates/trend_stop.js"),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_plugins_match_builtin_order() {
        // 7 款、id 唯一、顺序与 Rust 内建注册表固定顺序一致（ADR §7 名单）。
        let plugins = reference_plugins();
        assert_eq!(plugins.len(), 7);
        let ids: Vec<&str> = plugins.iter().map(|p| p.id).collect();
        assert_eq!(ids, backtest::builtin_strategy_ids());
        let mut seen = std::collections::HashSet::new();
        for p in &plugins {
            assert!(seen.insert(p.id), "id {} 重复", p.id);
            assert!(!p.name.is_empty() && !p.description.is_empty());
            assert!(p.code.contains("function on_bar"), "{} 缺 on_bar", p.id);
            assert!(
                p.code.contains("PARAMS_SCHEMA"),
                "{} 缺 PARAMS_SCHEMA",
                p.id
            );
        }
    }

    #[test]
    fn official_templates_len_4_and_wellformed() {
        let templates = official_templates();
        assert_eq!(templates.len(), 4);
        let ids: Vec<&str> = templates.iter().map(|t| t.id).collect();
        assert_eq!(
            ids,
            vec!["pure_score", "two_state_gate", "dca", "trend_stop"]
        );
        for t in &templates {
            assert!(!t.name.is_empty() && !t.description.is_empty());
            assert!(t.code.contains("function on_bar"), "{} 缺 on_bar", t.id);
            assert!(
                t.code.contains("PARAMS_SCHEMA"),
                "{} 缺 PARAMS_SCHEMA",
                t.id
            );
        }
    }
}
