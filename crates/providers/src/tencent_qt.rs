// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/tencent_qt.rs>>[init]
//! 腾讯 qt —— 快照池，最抗封（024）。GBK 解码；`~` 分隔 88 字段；手→股、万元→元。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, NaiveDateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://qt.gtimg.cn/q=";

pub struct TencentQt {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl TencentQt {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(codes: &[Code]) -> Result<String, ProviderError> {
        let mut parts = Vec::with_capacity(codes.len());
        for c in codes {
            parts.push(c.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?);
        }
        Ok(format!("{ENDPOINT}{}", parts.join(",")))
    }
}

/// 解析（纯函数，golden 锁定）：行形如 `v_sh518880="1~名称~代码~last~prev~...~ts~...~vol~amt~..."`；
/// [1]name [2]code [3]last [4]prev [30]ts(YYYYMMDDHHMMSS) [36]vol(手) [37]amt(万元)。
/// 畸形行跳过（容错，对齐 verify 脚本 per-code parse_err 口径）；全部无有效行 → NoData。
pub fn parse_quotes(body: &[u8], now: DateTime<Utc>) -> Result<Vec<Quote>, ProviderError> {
    let (text, _, _) = encoding_rs::GBK.decode(body);
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.contains('=') || line.contains("none_match") { continue; }
        let val = line.split_once('=').map(|(_, v)| v).unwrap_or("")
            .trim().trim_end_matches(';').trim_matches('"');
        if val.is_empty() { continue; }
        let f: Vec<&str> = val.split('~').collect();        if f.len() < 38 { continue; }
        let Ok(last) = f[3].parse::<f64>() else { continue };
        let Ok(prev) = f[4].parse::<f64>() else { continue };
        let vol = f[36].parse::<f64>().unwrap_or(0.0);
        let amt = f[37].parse::<f64>().unwrap_or(0.0);
        let ts = NaiveDateTime::parse_from_str(f[30], "%Y%m%d%H%M%S")
            .map(cst_to_utc).unwrap_or(now);
        out.push(Quote {
            code: Code(f[2].to_string()),
            last, prev_close: prev,
            volume: (vol * 100.0) as u64,  // 手→股
            amount: amt * 10000.0,          // 万元→元
            data_ts: ts,
            source: SourceId::TencentQt,
        });
    }
    if out.is_empty() { Err(ProviderError::NoData) } else { Ok(out) }
}

#[async_trait::async_trait]
impl SnapshotProvider for TencentQt {
    fn id(&self) -> SourceId { SourceId::TencentQt }

    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        if codes.is_empty() { return Ok(vec![]); }
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(codes)?, &[]).await?;
        parse_quotes(&resp.body, Utc::now())
    }
}
// ~/~ end
