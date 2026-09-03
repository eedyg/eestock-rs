// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/exchange.rs>>[init]
//! 交易所官方快照 —— 沪深双端点，结构各自适配（§3，2026-09-03 端点勘误见该节）。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, NaiveDateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const SSE_ENDPOINT: &str = "http://yunhq.sse.com.cn:32041/v1/sh1/snap";
pub const SZSE_ENDPOINT: &str = "http://www.szse.cn/api/market/ssjjhq/getTimeData";
pub const SZSE_REFERER: &str = "http://www.szse.cn/";

pub struct Exchange {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl Exchange {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(code: &Code) -> Result<(String, bool), ProviderError> {
        match code.market().map_err(|e| ProviderError::Parse(e.to_string()))? {
            Market::Sh => Ok((format!("{SSE_ENDPOINT}/{}", code.0), true)),
            Market::Sz => Ok((format!("{SZSE_ENDPOINT}?marketId=1&code={}", code.0), false)),
        }
    }
}

/// 沪市 yunhq snap（纯函数）：`snap=[code,name,last,prev_close,...]`；ts=date(YYYYMMDD)+time(HHMMSS) 拼接。
pub fn parse_sse_snap(body: &[u8], code: &Code, now: DateTime<Utc>) -> Result<Quote, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("sse snap json: {e}")))?;
    let snap = v.get("snap").and_then(|s| s.as_array())
        .ok_or_else(|| ProviderError::Parse("sse: missing snap".into()))?;
    let fnum = |i: usize| -> Result<f64, ProviderError> {
        snap.get(i).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
            .ok_or_else(|| ProviderError::Parse(format!("sse snap[{i}] num")))
    };
    let date = v.get("date").and_then(|d| d.as_i64()).unwrap_or(0);
    let time = v.get("time").and_then(|t| t.as_i64()).unwrap_or(0);
    let ts = NaiveDateTime::parse_from_str(&format!("{date}{time:06}"), "%Y%m%d%H%M%S")
        .map(cst_to_utc).unwrap_or(now);
    Ok(Quote {
        code: code.clone(),
        last: fnum(2)?,
        prev_close: fnum(3).unwrap_or(0.0),
        volume: 0, amount: 0.0,
        data_ts: ts, source: SourceId::Exchange,
    })
}

/// 深市 getTimeData（纯函数）：`data.now/close` 字符串字段；`data.marketTime` 为 ts。
pub fn parse_szse_timedata(body: &[u8], code: &Code, now: DateTime<Utc>) -> Result<Quote, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("szse json: {e}")))?;
    let d = v.get("data").ok_or_else(|| ProviderError::Parse("szse: missing data".into()))?;
    let s = |k: &str| -> Result<&str, ProviderError> {
        d.get(k).and_then(|x| x.as_str())
            .ok_or_else(|| ProviderError::Parse(format!("szse data.{k} missing")))
    };
    let last: f64 = s("now")?.parse()
        .map_err(|e| ProviderError::Parse(format!("szse now f64: {e}")))?;
    let prev: f64 = s("close").unwrap_or("0").parse().unwrap_or(0.0);
    let ts = NaiveDateTime::parse_from_str(s("marketTime")?, "%Y-%m-%d %H:%M:%S")
        .map(cst_to_utc).unwrap_or(now);
    Ok(Quote {
        code: code.clone(), last, prev_close: prev,
        volume: 0, amount: 0.0,
        data_ts: ts, source: SourceId::Exchange,
    })
}

#[async_trait::async_trait]
impl SnapshotProvider for Exchange {
    fn id(&self) -> SourceId { SourceId::Exchange }

    /// 逐码请求（两市端点不同）；部分成功返回部分，全败 → Err。
    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        let mut out = Vec::new();
        let mut last_err = ProviderError::NoData;
        for c in codes {
            let (url, is_sh) = Self::url(c)?;
            self.gate.wait().await;
            let headers: &[(&str, &str)] = if is_sh { &[] } else { &[("Referer", SZSE_REFERER)] };
            match self.http.get(&url, headers).await {
                Ok(resp) => {
                    let r = if is_sh { parse_sse_snap(&resp.body, c, Utc::now()) }
                            else { parse_szse_timedata(&resp.body, c, Utc::now()) };
                    match r { Ok(q) => out.push(q), Err(e) => last_err = e }
                }
                Err(e) => last_err = e,
            }
        }
        if out.is_empty() && !codes.is_empty() { Err(last_err) } else { Ok(out) }
    }
}
// ~/~ end
