// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/sina_hq.rs>>[init]
//! 新浪 hq —— 快照池。**必带 Referer: https://finance.sina.com.cn/**（否则 403）；GBK；`,` 分隔。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, NaiveDateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://hq.sinajs.cn/list=";
pub const REFERER: &str = "https://finance.sina.com.cn/";

pub struct SinaHq {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl SinaHq {
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

/// 解析（纯函数，golden 锁定）：行形如 `var hq_str_sh518880="名称,今开,昨收,last,...,vol,amount,...,日期,时间,..."`；
/// [0]name [2]prev [3]last [8]vol(股) [9]amount(元) [30]date [31]time；代码取变量名末 6 位数字。
pub fn parse_quotes(body: &[u8], now: DateTime<Utc>) -> Result<Vec<Quote>, ProviderError> {
    let (text, _, _) = encoding_rs::GBK.decode(body);
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.contains("hq_str_") || !line.contains('=') { continue; }
        let var = line.split_once('=').map(|(v, _)| v).unwrap_or("").trim();
        let code = var.chars().rev().take(6).collect::<String>().chars().rev().collect::<String>();
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) { continue; }
        let val = line.split_once('=').map(|(_, v)| v).unwrap_or("")
            .trim().trim_end_matches(';').trim_matches('"');
        if val.is_empty() { continue; }
        let f: Vec<&str> = val.split(',').collect();
        if f.len() < 32 { continue; }
        let Ok(last) = f[3].parse::<f64>() else { continue };
        let Ok(prev) = f[2].parse::<f64>() else { continue };
        let vol = f[8].parse::<f64>().unwrap_or(0.0);   // 股
        let amt = f[9].parse::<f64>().unwrap_or(0.0);   // 元
        let ts = NaiveDateTime::parse_from_str(&format!("{} {}", f[30], f[31]), "%Y-%m-%d %H:%M:%S")
            .map(cst_to_utc).unwrap_or(now);
        out.push(Quote {
            code: Code(code), last, prev_close: prev,
            volume: vol as u64, amount: amt,
            data_ts: ts, source: SourceId::SinaHq,
        });
    }
    if out.is_empty() { Err(ProviderError::NoData) } else { Ok(out) }
}

#[async_trait::async_trait]
impl SnapshotProvider for SinaHq {
    fn id(&self) -> SourceId { SourceId::SinaHq }

    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        if codes.is_empty() { return Ok(vec![]); }
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(codes)?, &[("Referer", REFERER)]).await?;
        parse_quotes(&resp.body, Utc::now())
    }
}
// ~/~ end
