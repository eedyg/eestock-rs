pub const MULTI_PERIOD_MAX_PANES: usize = 12;

pub fn normalize_multi_period_indicators(indicators: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for ind in indicators {
        if !out.contains(ind) { out.push(ind.clone()); }
    }
    out
}

/// 总 pane 数（02-spec §7.4）：`1`（基准 candle）+ `Σ_卫星(去重后指标 pane 数)`，每受支持指标占 1 个 pane。
/// **计数必须基于去重后的 `indicators` 集合**（P1-C D1：按原始数组长度计数会把 `["dcap"]×11` 误判）。
pub fn multi_period_pane_count(periods: &[String], indicators: &[String]) -> usize {
    let n_inds = normalize_multi_period_indicators(indicators).len();
    1 + periods.len().saturating_sub(1) * n_inds
}

/// 总 pane 预算护栏（02-spec §7.4）：`> MULTI_PERIOD_MAX_PANES` ⇒ `Err`
/// （**明确报错、不得静默截断**；错误信息含**被拒维度名** `indicators`/`pane`——P1-C D2）。
pub fn verify_multi_period_panes(periods: &[String], indicators: &[String]) -> Result<(), String> {
    let n = multi_period_pane_count(periods, indicators);
    if n > MULTI_PERIOD_MAX_PANES {
        return Err(format!(
            "总 pane 数 {n} 超上限 {MULTI_PERIOD_MAX_PANES}\
             （基准 1 + Σ_卫星(去重后指标) pane）"
        ));
    }
    Ok(())
}

// ── 独立验收 harness（Tester 自建；函数体 = dto.rs 逐字节抽取，非重写） ──
fn s(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }
fn rep(name: &str, n: usize) -> Vec<String> { vec![name.to_string(); n] }
fn distinct(n: usize) -> Vec<String> { (0..n).map(|i| format!("ind{i}")).collect() }

fn main() {
    let mut fail = 0;
    // D1：4 周期 × ["dcap"]×n 与 ["dcap"] 计数必须相同（= 4）
    let p4 = s(&["1m", "5m", "15m", "1h"]);
    let base = multi_period_pane_count(&p4, &s(&["dcap"]));
    for n in [2usize, 3, 11, 12, 24] {
        let got = multi_period_pane_count(&p4, &rep("dcap", n));
        if got != base {
            println!("D1_RED: [\"dcap\"]x{n} -> pane {got} != [\"dcap\"] -> pane {base}");
            fail += 1;
        }
    }
    if verify_multi_period_panes(&p4, &rep("dcap", 11)).is_err() {
        println!("D1_RED: 4周期 x [\"dcap\"]x11 被误拒（去重后应为 4 pane ≤ 12）");
        fail += 1;
    }
    println!("D1 case pane_count(4p, [dcap]x11)={} ok={}", multi_period_pane_count(&p4, &rep("dcap", 11)), verify_multi_period_panes(&p4, &rep("dcap", 11)).is_ok());

    // §7.4 边界：1 + 1x11 = 12 ⇒ 允许；1 + 1x12 = 13 ⇒ 拒绝
    let p2 = s(&["1m", "5m"]);
    println!("BOUNDARY 12 -> {} ; 13 -> {}", verify_multi_period_panes(&p2, &distinct(11)).is_ok(), verify_multi_period_panes(&p2, &distinct(12)).is_err());

    // §7.4 负例：4 周期 × 5 不同指标 = 16 > 12 ⇒ 必 Err（且错误串含被拒维度名）
    match verify_multi_period_panes(&p4, &distinct(5)) {
        Ok(()) => { println!("S74_RED: 16 pane 未被拒绝（护栏被放宽/失效）"); fail += 1; }
        Err(e) => {
            let names = e.contains("indicators");
            println!("S74 negative err={e} names_dimension={names}");
            if !names { println!("D2_RED: 错误串未含被拒维度名"); fail += 1; }
        }
    }
    // D2 判据自检：仅算式量词的旧串不算指名
    let old = "总 pane 数 23 超上限 12（基准 1 + Σ_卫星指标 pane）".to_string();
    println!("D2 predicate selfcheck old_string_names_dimension={}", old.contains("indicators"));
    println!("HARNESS fail_count={fail}");
}
