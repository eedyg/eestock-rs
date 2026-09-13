//! 首期参考插件包（ADR `design/12-strategy-system/01-adr.md` §7 D8）+ 官方策略模板（§13.2 D10）。
//!
//! - 8 款参考插件：原 Rust 内建策略（`backtest::strategies`）的 JS 1:1 迁移（7 款）+ `dcap`
//!   指标插件（`design/14-dcap-indicator`，ADR-021 §8 裁决 A：第 8 条，可播种/可参测），
//!   兼作用户模板与测试 fixture；迁移等价性测试 `tests/equivalence.rs` 已随 P4b 删除
//!   （旧 Rust 内建策略本体不再存在，等价性对照失去参照物）。
//! - 4 款官方模板：ABI §4.5（纯评分 / 两态门控 / 定投 / 趋势+止损），编辑器「新建策略」起点。
//!
//! ⚠️ 冻结历史记录（架构裁决）：7 个播种插件 JS 文件内注释若仍提及 `equivalence.rs`，属**有意保留**——
//! JS 字节是 sha256 寻址的播种源，改注释 = 变哈希 = 扰动播种语义，故冻结不改。
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

/// 8 款参考插件（顺序锁定为 ADR §7 名单固定顺序 + 追加的 `dcap`；P4b 后 Rust 内建注册表已删除，
/// 顺序由单测硬编码守护 —— 追加位次依据 ADR-021 §8 裁决 A）。
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
        ReferencePlugin {
            id: "dcap",
            name: "DCAP 定投收益率",
            description: "短/中/长三线假想定投收益率（各线自 r）等权映射为 0–100 评分（收益率越高分越低）",
            code: include_str!("../reference-plugins/dcap.js"),
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
        // 8 款、id 唯一、顺序锁定为 ADR §7 名单固定顺序 + dcap（design/14-dcap-indicator，
        // ADR-021 §8 裁决 A：进 reference_plugins 第 8 条，可播种/可参测）。
        // P4b：Rust 内建注册表已物理删除，本清单硬编码保留顺序/唯一性覆盖。
        const BUILTIN_ORDER: [&str; 8] = [
            "dual_ma", "ma_rsi", "macd", "boll", "kdj", "momentum", "atr_channel", "dcap",
        ];
        let plugins = reference_plugins();
        assert_eq!(plugins.len(), 8);
        let ids: Vec<&str> = plugins.iter().map(|p| p.id).collect();
        assert_eq!(ids, BUILTIN_ORDER);
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

    /// T12（03-test-plan）：播种清单含 dcap（第 8 条），且插件面 ABI 钩子/镜像哨兵齐备。
    /// 依据：`design/14-dcap-indicator/02-spec.md` §5（PARAMS_SCHEMA/init/on_bar/save/load）
    ///   + ADR-021 D4（CORE 哨兵区间）、§8 裁决 A（进 reference_plugins）。
    #[test]
    fn t12_dcap_registered_with_plugin_abi_and_core_sentinels() {
        let plugins = reference_plugins();
        let dcap = plugins
            .iter()
            .find(|p| p.id == "dcap")
            .expect("reference_plugins() 必须含 id=\"dcap\"（ADR-021 §8 裁决 A）");
        // 显示名不属权威口径（02-spec §8 裁决 12 只钉指标名 `dcap` 与三线字段 s/m/l）⇒
        // 只断言非空（沿用既有通用断言口径），不臆造具体文案。
        assert!(!dcap.name.is_empty() && !dcap.description.is_empty());
        // ABI 钩子（02-spec §5）
        for needle in [
            "PARAMS_SCHEMA",
            "function init",
            "function on_bar",
            "function save",
            "function load",
        ] {
            assert!(dcap.code.contains(needle), "dcap 插件缺 {needle}（ABI §1/§4/§5）");
        }
        // 镜像哨兵（ADR-021 D4；T3 逐字节断言的锚点）
        assert!(dcap.code.contains("// === DCAP CORE BEGIN ==="), "缺 CORE 起始哨兵");
        assert!(dcap.code.contains("// === DCAP CORE END ==="), "缺 CORE 结束哨兵");
        // id 唯一（全表）
        let mut seen = std::collections::HashSet::new();
        for p in &plugins {
            assert!(seen.insert(p.id), "id {} 重复", p.id);
        }
        assert_eq!(seen.len(), plugins.len());
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
