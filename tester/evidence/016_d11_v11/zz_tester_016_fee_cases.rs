//! 016 D11 v1.1 复验临时探针（tester，**未跟踪临时夹具**，验收后删除）。
//!
//! 目的：为 ADR-019 §6 v1.1 R-2 五条字段级优先级用例 + R-2 补守卫 打印**实际取值**原始证据
//! （供 stock 档案 / 无档案两条真实库不可达情形：symbols 表无 stock 标的、全部标的均有档案）。
//! 只读调用 `application::fee::resolve_fee`（纯函数），不触库、不改实现。

use application::fee::{resolve_fee, FeeSource};

fn etf_profile() -> domain::ports::FeeProfileRow {
    domain::ports::FeeProfileRow {
        type_: "etf".into(), commission_rate_pct: 0.025, min_fee: 5.0,
        exchange_fee_pct: 0.0, regulatory_fee_pct: 0.0, stamp_duty_pct: 0.0,
        transfer_fee_pct: 0.0, note: "全佣口径：经手费/证管费列 0；印花税不征".into(),
        source: "ADR-019 §1.1".into(),
    }
}

fn stock_profile() -> domain::ports::FeeProfileRow {
    domain::ports::FeeProfileRow {
        type_: "stock".into(), commission_rate_pct: 0.025, min_fee: 5.0,
        exchange_fee_pct: 0.00341, regulatory_fee_pct: 0.002, stamp_duty_pct: 0.05,
        transfer_fee_pct: 0.001, note: "A 股事实费率；规费未建模（D11-follow-up）".into(),
        source: "ADR-019 §1.2".into(),
    }
}

fn show(tag: &str, explicit: Option<serde_json::Value>, profile: Option<domain::ports::FeeProfileRow>) {
    match resolve_fee(explicit.as_ref(), profile) {
        Ok(r) => {
            let src = match r.source {
                FeeSource::Explicit => "explicit",
                FeeSource::Profile => "profile",
                FeeSource::Default => "default",
            };
            println!(
                "EV {tag} => OK source={src} symbol_type={:?} rate_pct={} min_fee={} slippage_bp={} stamp_duty_pct={} sell(1000@10).stamp={}",
                r.symbol_type, r.model.commission_rate_pct, r.model.min_commission,
                r.model.slippage_bp, r.model.stamp_duty_pct, r.model.sell(1000.0, 10.0).stamp_duty
            );
        }
        Err(e) => println!("EV {tag} => ERR(status=400/isError): {e}"),
    }
}

#[test]
fn r2_five_cases_and_guard_raw_values() {
    let ui3 = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
    // ① UI 三键（无 stamp）+ ETF 档案
    show("R2-1 ui3+etf        ", Some(ui3.clone()), Some(etf_profile()));
    // ② UI 三键（无 stamp）+ stock 档案
    show("R2-2 ui3+stock      ", Some(ui3.clone()), Some(stock_profile()));
    // ③ 显式 stamp=0.07 + stock 档案（显式字段最高优先）
    show(
        "R2-3 stamp0.07+stock",
        Some(serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.07})),
        Some(stock_profile()),
    );
    // ④ 无显式 + ETF 档案
    show("R2-4 none+etf       ", None, Some(etf_profile()));
    // ⑤ 无显式 + 无档案（旧默认）
    show("R2-5 none+none      ", None, None);
    // R-2 补守卫：{} / 全未知键 / 仅档案列名 → 400/isError；≥1 可识别字段 → 放行
    show("GUARD {} (empty)    ", Some(serde_json::json!({})), Some(etf_profile()));
    show("GUARD {\"foo\":1}      ", Some(serde_json::json!({"foo": 1})), Some(etf_profile()));
    show(
        "GUARD 档案列名      ",
        Some(serde_json::json!({"commission_rate_pct": 0.02})),
        Some(etf_profile()),
    );
    show("GUARD {rate_pct}    ", Some(serde_json::json!({"rate_pct": 0.025})), Some(etf_profile()));
    // 值域守卫（未变）
    show(
        "GUARD stamp=1.5     ",
        Some(serde_json::json!({"rate_pct": 0.025, "stamp_duty_pct": 1.5})),
        Some(etf_profile()),
    );
}
