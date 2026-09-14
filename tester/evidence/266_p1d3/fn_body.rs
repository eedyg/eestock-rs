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
            "indicators 去重后总 pane 数 {n} 超上限 {MULTI_PERIOD_MAX_PANES}\
             （基准 1 + Σ_卫星(去重后指标) pane）"
        ));
    }
    Ok(())
}
