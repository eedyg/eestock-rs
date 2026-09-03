// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/tencent_ifzq.rs>>[init]
//! 腾讯 ifzq —— 1m 主力（§1）。主域 ifzq.gtimg.cn，备域 web.ifzq.gtimg.cn（reqwest 自动跟 301）。

use crate::http::{HttpClient, IntervalGate};
use chrono::NaiveDateTime;
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://ifzq.gtimg.cn/appstock/app/kline/mkline";
pub const ENDPOINT_FALLBACK: &str = "https://web.ifzq.gtimg.cn/appstock/app/kline/mkline";
/// 免费源物理上限≈2 天（ADR-004），单请求 bar 上限 320。
pub const MAX_LIMIT: usize = 320;

pub struct TencentIfzq {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl TencentIfzq {
    /// 限频：1 req/s + 0~200ms 抖动（§1）。
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url_for(endpoint: &str, code: &Code, limit: usize) -> Result<String, ProviderError> {
        let p = code.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(format!("{endpoint}?param={p},m1,,{}", limit.min(MAX_LIMIT)))
    }
}

/// 解析（纯函数，golden 锁定）：`data.<code>.m1 = [[YYYYMMDDHHMM, 开, 收, 高, 低, 量(手), {}, 额(万元)]]`
/// ⚠️ 2 号位是“收”不是“高”（028 §2.1）；量×100→股；额×10000→元；时间 Asia/Shanghai → UTC。
pub fn parse_m1(body: &[u8], code: &Code) -> Result<Vec<Bar>, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("ifzq json: {e}")))?;
    if v.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ProviderError::Http(format!("ifzq biz code: {}", v.get("code").cloned().unwrap_or_default())));
    }
    let prefixed = code.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?;
    let rows = match v.get("data").and_then(|d| d.get(&prefixed)).and_then(|d| d.get("m1")).and_then(|r| r.as_array()) {
        Some(r) if !r.is_empty() => r,
        _ => return Err(ProviderError::NoData), // 非交易时段空 m1 / 新上市 → NA（01 §4）
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let col = |i: usize| -> Result<&str, ProviderError> {
            row.get(i).and_then(|x| x.as_str())
                .ok_or_else(|| ProviderError::Parse(format!("m1 col {i} missing: {row}")))
        };
        let num = |i: usize| -> Result<f64, ProviderError> {
            col(i)?.parse::<f64>().map_err(|e| ProviderError::Parse(format!("m1 col {i} f64: {e}")))
        };
        let naive = NaiveDateTime::parse_from_str(col(0)?, "%Y%m%d%H%M")
            .map_err(|e| ProviderError::Parse(format!("m1 ts: {e}")))?;
        out.push(Bar {
            code: code.clone(),
            period: Period::M1,
            ts: cst_to_utc(naive),
            open: num(1)?,
            close: num(2)?,  // ⚠️ 2 号位是收
            high: num(3)?,
            low: num(4)?,
            volume: (num(5)? * 100.0) as u64,  // 手→股
            amount: num(7)? * 10000.0,          // 万元→元
            source: SourceId::TencentIfzq,
        });
    }
    out.sort_by_key(|b| b.ts);
    Ok(out)
}

#[async_trait::async_trait]
impl MinuteKlineProvider for TencentIfzq {
    fn id(&self) -> SourceId { SourceId::TencentIfzq }

    async fn fetch_m1(&self, code: &Code, limit: usize) -> Result<Vec<Bar>, ProviderError> {
        self.gate.wait().await;
        let url = Self::url_for(ENDPOINT, code, limit)?;
        let resp = match self.http.get(&url, &[]).await {
            Ok(r) => r,
            Err(first_err) => {
                // 备域兜底一次（028：web.ifzq 301→web3，reqwest 自动跟 301）
                let fb = Self::url_for(ENDPOINT_FALLBACK, code, limit)?;
                self.http.get(&fb, &[]).await.map_err(|_| first_err)?
            }
        };
        let mut bars = parse_m1(&resp.body, code)?;
        if bars.len() > limit { bars = bars.split_off(bars.len() - limit); }
        Ok(bars)
    }
}
// ~/~ end
