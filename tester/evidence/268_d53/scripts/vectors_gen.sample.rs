// AUTO-GENERATED 由 design/15-multi-period/contract-vectors.json 派生（Tester D5-3 独立探针）；请勿手工编辑。
use std::collections::BTreeMap;
use web::dto::MultiPeriodConfigDto;
pub struct V { pub name: &'static str, pub cfg: MultiPeriodConfigDto, pub pane: Option<u64>, pub guard: Option<&'static str> }
pub fn vectors() -> Vec<V> {
    let mut out: Vec<V> = Vec::new();
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420)] { h.insert(k, val); }
      out.push(V { name: "valid-single-base-default", cfg: MultiPeriodConfigDto { enabled: false, periods: vec!["1m".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("15m".to_string(), 180), ("1h".to_string(), 180), ("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "valid-four-periods-max-legal-v1", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string(), "15m".to_string(), "1h".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1d".to_string(), 420), ("1w".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "valid-1w-satellite-with-1d-base", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1d".to_string(), "1w".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "valid-empty-indicators", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string()], heights: h, indicators: vec![] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "dedup-two-identical-indicators", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string()], heights: h, indicators: vec!["dcap".to_string(), "dcap".to_string()] }, pane: Some(2), guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("15m".to_string(), 180), ("1h".to_string(), 180), ("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "dedup-n-identical-indicators-cannot-forge-over-12-panes", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string(), "15m".to_string(), "1h".to_string()], heights: h, indicators: vec!["dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string()] }, pane: Some(4), guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("15m".to_string(), 180), ("1h".to_string(), 180), ("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "dedup-makes-legal-repeated-indicators-over-raw-pane-budget", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string(), "15m".to_string(), "1h".to_string()], heights: h, indicators: vec!["dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string(), "dcap".to_string()] }, pane: Some(4), guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("15m".to_string(), 180), ("1h".to_string(), 180), ("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "pane-over-limit-after-dedup-names-dimension", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string(), "15m".to_string(), "1h".to_string()], heights: h, indicators: vec!["dcap".to_string(), "macd".to_string(), "kdj".to_string(), "boll".to_string()] }, pane: Some(13), guard: Some("indicators") }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [] { h.insert(k, val); }
      out.push(V { name: "reject-empty-periods", cfg: MultiPeriodConfigDto { enabled: false, periods: vec![], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("15m".to_string(), 180), ("1d".to_string(), 180), ("1h".to_string(), 180), ("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "reject-more-than-4-periods", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string(), "15m".to_string(), "1h".to_string(), "1d".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420)] { h.insert(k, val); }
      out.push(V { name: "reject-duplicate-periods", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "1m".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420), ("1mo".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "reject-1mo-period", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "1mo".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1d".to_string(), 420), ("1h".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "reject-satellite-below-base", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1d".to_string(), "1h".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420), ("1w".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "reject-1w-with-base-below-1d", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "1w".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("15m".to_string(), 180), ("1m".to_string(), 420)] { h.insert(k, val); }
      out.push(V { name: "reject-heights-key-mismatch", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420), ("5m".to_string(), 40)] { h.insert(k, val); }
      out.push(V { name: "reject-heights-below-min", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420), ("5m".to_string(), 1201)] { h.insert(k, val); }
      out.push(V { name: "reject-heights-above-max", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string()], heights: h, indicators: vec!["dcap".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420)] { h.insert(k, val); }
      out.push(V { name: "reject-unsupported-indicator", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string()], heights: h, indicators: vec!["ma".to_string()] }, pane: None, guard: None }); }
    { let mut h: BTreeMap<String, i64> = BTreeMap::new();
      for (k, val) in [("1m".to_string(), 420), ("5m".to_string(), 180)] { h.insert(k, val); }
      out.push(V { name: "reject-unsupported-indicator-among-supported", cfg: MultiPeriodConfigDto { enabled: true, periods: vec!["1m".to_string(), "5m".to_string()], heights: h, indicators: vec!["dcap".to_string(), "macd".to_string()] }, pane: None, guard: None }); }
    out
}
