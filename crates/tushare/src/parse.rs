// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/src/parse.rs>>[init]
//! tushare 响应解析（纯函数，golden 样本 TDD 锁定）。

use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};
use domain::provider::ProviderError;
use domain::types::*;
use serde::Deserialize;

/// Asia/Shanghai 无夏令时，固定 +8（避免引入 chrono-tz 依赖）。
pub const CST_OFFSET_SECS: i32 = 8 * 3600;

pub fn cst() -> FixedOffset {
    FixedOffset::east_opt(CST_OFFSET_SECS).expect("valid offset")
}

/// 北京时间 naive → UTC。
pub fn cst_to_utc(naive: NaiveDateTime) -> DateTime<Utc> {
    cst().from_local_datetime(&naive).single()
        .expect("CST 固定偏移无歧义").with_timezone(&Utc)
}

#[derive(Debug, Deserialize)]
pub struct ApiResponse {
    pub code: i64,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub data: Option<ApiData>,
}

#[derive(Debug, Deserialize)]
pub struct ApiData {
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub items: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    pub has_more: Option<bool>,
}

/// 业务错误分类：code != 0 → Http（含 40203 无权限）；code == 0 → data（缺省为空集）。
pub fn classify_response(resp: ApiResponse) -> Result<ApiData, ProviderError> {
    if resp.code != 0 {
        return Err(ProviderError::Http(format!(
            "tushare api error {}: {}", resp.code, resp.msg.unwrap_or_default())));
    }
    Ok(resp.data.unwrap_or(ApiData { fields: vec![], items: vec![], has_more: None }))
}

/// stk_mins 响应 → Vec<Bar>（ts 升序）。空 items → 空 vec（非错误）。
pub fn parse_stk_mins(data: &ApiData, code: &Code) -> Result<Vec<Bar>, ProviderError> {
    if data.items.is_empty() { return Ok(vec![]); }
    let i_time = field_idx(&data.fields, "trade_time")?;
    let i_open = field_idx(&data.fields, "open")?;
    let i_high = field_idx(&data.fields, "high")?;
    let i_low = field_idx(&data.fields, "low")?;
    let i_close = field_idx(&data.fields, "close")?;
    let i_vol = field_idx(&data.fields, "vol")?;
    let i_amt = field_idx(&data.fields, "amount")?;
    let mut out = Vec::with_capacity(data.items.len());
    for item in &data.items {
        let ts_str = item.get(i_time).and_then(|v| v.as_str())
            .ok_or_else(|| ProviderError::Parse("bad trade_time".into()))?;
        let naive = NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%d %H:%M:%S")
            .map_err(|e| ProviderError::Parse(format!("trade_time '{ts_str}': {e}")))?;
        out.push(Bar {
            code: code.clone(),
            period: Period::M1,
            ts: cst_to_utc(naive),
            open: get_f64(item, i_open)?,
            high: get_f64(item, i_high)?,
            low: get_f64(item, i_low)?,
            close: get_f64(item, i_close)?,
            volume: get_f64(item, i_vol)? as u64,   // 股，无需换算（golden 验证）
            amount: get_f64(item, i_amt)?,          // 元
            source: SourceId::Tushare,
        });
    }
    out.sort_by_key(|b| b.ts);
    Ok(out)
}

fn field_idx(fields: &[String], name: &str) -> Result<usize, ProviderError> {
    fields.iter().position(|f| f == name)
        .ok_or_else(|| ProviderError::Parse(format!("missing field: {name}")))
}

fn get_f64(item: &[serde_json::Value], idx: usize) -> Result<f64, ProviderError> {
    match item.get(idx).and_then(|v| v.as_f64()) {
        Some(x) => Ok(x),
        None => Err(ProviderError::Parse(format!("bad f64 at col {idx}: {:?}", item.get(idx)))),
    }
}
// ~/~ end
