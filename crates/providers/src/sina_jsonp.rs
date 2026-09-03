// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/sina_jsonp.rs>>[init]
//! 新浪 jsonp —— 1m 备源/交叉基准（§2）。剥防盗链前缀 + jsonp 包裹后按 JSON 数组解析。

use crate::http::{HttpClient, IntervalGate};
use chrono::NaiveDateTime;
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_k=/CN_MarketDataService.getKLineData";

pub struct SinaJsonp {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl SinaJsonp {
    /// 限频：1 req/s + 0~200ms 抖动；无需 Referer（§2）。
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(code: &Code, limit: usize) -> Result<String, ProviderError> {
        let p = code.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(format!("{ENDPOINT}?symbol={p}&scale=1&ma=no&datalen={}", limit.min(1023)))
    }
}

/// 解析（纯函数，golden 锁定）：剥 `/*<script>...*/` 前缀与 `var _k=(...);` 包裹；
/// 数组元素 `{day,open,high,low,close,volume,amount}` 全字符串；
/// volume 单位为**股**（028 golden 验证锁定，非手）；day 为 `YYYY-MM-DD HH:MM:SS` 北京时。
/// 旧端点退化形态恒定 `null`（028 §3）与空数组 → NoData。
pub fn parse_m1(body: &str, code: &Code) -> Result<Vec<Bar>, ProviderError> {
    let (start, end) = match (body.find('['), body.rfind(']')) {
        (Some(s), Some(e)) if s < e => (s, e),
        _ => return Err(ProviderError::NoData), // null / 无数组 → NA
    };
    let arr: Vec<serde_json::Value> = serde_json::from_str(&body[start..=end])
        .map_err(|e| ProviderError::Parse(format!("sina jsonp array: {e}")))?;
    if arr.is_empty() { return Err(ProviderError::NoData); }
    let mut out = Vec::with_capacity(arr.len());
    for it in &arr {
        let s = |k: &str| -> Result<&str, ProviderError> {
            it.get(k).and_then(|x| x.as_str())
                .ok_or_else(|| ProviderError::Parse(format!("sina field {k} missing: {it}")))
        };
        let num = |k: &str| -> Result<f64, ProviderError> {
            s(k)?.parse::<f64>().map_err(|e| ProviderError::Parse(format!("sina {k} f64: {e}")))
        };
        let naive = NaiveDateTime::parse_from_str(s("day")?, "%Y-%m-%d %H:%M:%S")
            .map_err(|e| ProviderError::Parse(format!("sina day: {e}")))?;
        out.push(Bar {
            code: code.clone(),
            period: Period::M1,
            ts: cst_to_utc(naive),
            open: num("open")?,
            high: num("high")?,
            low: num("low")?,
            close: num("close")?,
            volume: num("volume")? as u64,  // 股（无换算，golden 锁定）
            amount: num("amount")?,          // 元
            source: SourceId::SinaJsonp,
        });
    }
    out.sort_by_key(|b| b.ts);
    Ok(out)
}

#[async_trait::async_trait]
impl MinuteKlineProvider for SinaJsonp {
    fn id(&self) -> SourceId { SourceId::SinaJsonp }

    async fn fetch_m1(&self, code: &Code, limit: usize) -> Result<Vec<Bar>, ProviderError> {
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(code, limit)?, &[]).await?;
        let text = String::from_utf8(resp.body)
            .map_err(|e| ProviderError::Parse(format!("sina utf8: {e}")))?;
        let mut bars = parse_m1(&text, code)?;
        if bars.len() > limit { bars = bars.split_off(bars.len() - limit); }
        Ok(bars)
    }
}
// ~/~ end
