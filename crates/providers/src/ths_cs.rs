// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/ths_cs.rs>>[init]
//! 同花顺 —— 快照池（仅单只）。jsonp 包裹 realhead；`"10"`=最新价、`"24"`=昨收（verify 脚本正则口径）。
//! 不引入 regex 依赖：用子串定位实现同等语义。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://d.10jqka.com.cn/v6/realhead";

pub struct ThsCs {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl ThsCs {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(code: &Code) -> String {
        format!("{ENDPOINT}/hs_{}/last.js", code.0)
    }
}

/// 在 body 中抓 `"key":"num"` 形态的数值字段（对齐 verify 正则 `"10":"([\\d.]+)"`）。
fn grab(body: &str, key: &str) -> Option<f64> {
    let pat = format!("\"{key}\":\"");
    let i = body.find(&pat)? + pat.len();
    let j = body[i..].find('"')? + i;
    body[i..j].parse().ok()
}

/// 解析（纯函数，golden 锁定）：vol/amount/ts 端点不提供 → 0 / 拉取时刻。
pub fn parse_last(body: &str, code: &Code, now: DateTime<Utc>) -> Result<Quote, ProviderError> {
    let last = grab(body, "10")
        .ok_or_else(|| ProviderError::Parse("ths_cs: missing \"10\" last price".into()))?;
    let prev = grab(body, "24").unwrap_or(0.0);
    Ok(Quote {
        code: code.clone(), last, prev_close: prev,
        volume: 0, amount: 0.0, data_ts: now, source: SourceId::ThsCs,
    })
}

#[async_trait::async_trait]
impl SnapshotProvider for ThsCs {
    fn id(&self) -> SourceId { SourceId::ThsCs }

    /// 仅单只端点：逐码请求；部分成功返回部分（降级模式容错），全败 → Err。
    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        let mut out = Vec::new();
        let mut last_err = ProviderError::NoData;
        for c in codes {
            self.gate.wait().await;
            match self.http.get(&Self::url(c), &[]).await {
                Ok(resp) => match String::from_utf8(resp.body) {
                    Ok(text) => match parse_last(&text, c, Utc::now()) {
                        Ok(q) => out.push(q),
                        Err(e) => last_err = e,
                    },
                    Err(e) => last_err = ProviderError::Parse(format!("ths_cs utf8: {e}")),
                },
                Err(e) => last_err = e,
            }
        }
        if out.is_empty() && !codes.is_empty() { Err(last_err) } else { Ok(out) }
    }
}
// ~/~ end
