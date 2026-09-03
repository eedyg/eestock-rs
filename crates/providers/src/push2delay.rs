// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/push2delay.rs>>[init]
//! 东财 push2delay —— 快照池，东财系最低频（ADR-006）。超时 5s（028 父级裁决）。
//! ⚠️ fltt=2 时字段为格式化字符串，必须强转 float（028 修复前科）；`-` 为停牌/无值形态。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://push2delay.eastmoney.com/api/qt/ulist.np/get";
pub const REFERER: &str = "https://quote.eastmoney.com/";

pub struct Push2delay {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl Push2delay {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    /// secid：沪 1.<code>，深 0.<code>。
    pub fn secid(code: &Code) -> Result<String, ProviderError> {
        match code.market().map_err(|e| ProviderError::Parse(e.to_string()))? {
            Market::Sh => Ok(format!("1.{}", code.0)),
            Market::Sz => Ok(format!("0.{}", code.0)),
        }
    }

    fn url(codes: &[Code]) -> Result<String, ProviderError> {
        let mut ids = Vec::with_capacity(codes.len());
        for c in codes { ids.push(Self::secid(c)?); }
        Ok(format!("{ENDPOINT}?secids={}&fields=f2,f3,f5,f6,f12,f14,f18&fltt=2&invt=2", ids.join(",")))
    }
}

/// fltt=2 强转：数值/字符串通吃；`-` 等无值 → None。
fn num(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

/// 解析（纯函数，golden 锁定）：`data.diff[]`；f2=last f18=昨收 f5=vol(手) f6=amount(元) f12=code f14=name。
pub fn parse_quotes(body: &[u8], now: DateTime<Utc>) -> Result<Vec<Quote>, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("push2delay json: {e}")))?;
    let diff = v.get("data").and_then(|d| d.get("diff")).and_then(|d| d.as_array())
        .ok_or_else(|| ProviderError::Parse("push2delay: missing data.diff".into()))?;
    let mut out = Vec::new();
    for it in diff {
        let Some(code) = it.get("f12").and_then(|x| x.as_str()) else { continue };
        let (Some(last), Some(prev)) = (num(it.get("f2").unwrap_or(&serde_json::Value::Null)),
                                        num(it.get("f18").unwrap_or(&serde_json::Value::Null)))
        else { continue }; // "-" 停牌/无值 → 跳过（非错误）
        let vol = num(it.get("f5").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        let amt = num(it.get("f6").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        out.push(Quote {
            code: Code(code.to_string()), last, prev_close: prev,
            volume: (vol * 100.0) as u64,  // 手→股
            amount: amt,                    // 元
            data_ts: now, source: SourceId::Push2delay,
        });
    }
    if out.is_empty() { Err(ProviderError::NoData) } else { Ok(out) }
}

#[async_trait::async_trait]
impl SnapshotProvider for Push2delay {
    fn id(&self) -> SourceId { SourceId::Push2delay }

    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        if codes.is_empty() { return Ok(vec![]); }
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(codes)?, &[("Referer", REFERER)]).await?;
        parse_quotes(&resp.body, Utc::now())
    }
}
// ~/~ end
