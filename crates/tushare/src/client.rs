// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/src/client.rs>>[init]
//! tushare HTTP 客户端：HistoricalDataProvider 实现（ADR-016）。

use crate::parse::*;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use domain::provider::{HistoricalDataProvider, ProviderError};
use domain::types::*;
use tokio::sync::Mutex;
use tokio::time::Instant;

pub const API_URL: &str = "https://api.tushare.pro";
/// tushare 单次调用行数上限（旧 Go 实现同款常量）。
pub const MAX_ROWS_PER_BATCH: usize = 8000;
/// 1min 每交易日 241 根 → 30 天/窗口 ≈ 7230 根 < 8000。
pub const WINDOW_DAYS_1MIN: i64 = 30;
/// 默认限频间隔（任务规格；旧 Go 为 200ms，本系统取保守默认，可配）。
pub const DEFAULT_INTERVAL: Duration = Duration::milliseconds(1000);

/// Code → tushare ts_code（518880 → 518880.SH）。
pub fn to_ts_code(code: &Code) -> Result<String, ProviderError> {
    match code.market().map_err(|e| ProviderError::Parse(e.to_string()))? {
        Market::Sh => Ok(format!("{}.SH", code.0)),
        Market::Sz => Ok(format!("{}.SZ", code.0)),
    }
}

pub struct TushareClient {
    http: reqwest::Client,
    token: String,
    api_url: String,
    interval: Duration,
    /// 上次调用时刻（节流门）；初始化为 interval 之前 → 首次调用不等待。
    gate: Mutex<Instant>,
}

impl TushareClient {
    pub fn new(token: String) -> Self {
        Self::with_config(token, API_URL.to_string(), DEFAULT_INTERVAL)
    }

    pub fn with_config(token: String, api_url: String, interval: Duration) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build().expect("reqwest client build");
        let init = Instant::now()
            .checked_sub(interval.to_std().unwrap_or_default())
            .unwrap_or_else(Instant::now); // 首次调用不等待
        Self { http, token, api_url, interval, gate: Mutex::new(init) }
    }

    /// 间隔节流：保证两次 API 调用间隔 >= interval。
    async fn throttle(&self) {
        let mut g = self.gate.lock().await;
        let next = *g + self.interval.to_std().unwrap_or_default();
        if next > Instant::now() { tokio::time::sleep_until(next).await; }
        *g = Instant::now();
    }

    /// 测试暴露口（集成测试无法触达私有方法；生产路径不用）。
    #[doc(hidden)]
    pub async fn throttle_pub(&self) { self.throttle().await }

    /// 单次 API 调用，返回数据载荷（业务错误已分类）。
    pub(crate) async fn call_api(&self, api_name: &str, params: serde_json::Value)
        -> Result<ApiData, ProviderError>
    {
        self.throttle().await;
        let body = serde_json::json!({
            "api_name": api_name, "token": self.token, "params": params,
        });
        let resp = self.http.post(&self.api_url).json(&body).send().await
            .map_err(map_reqwest_err)?;
        let status = resp.status().as_u16();
        if status == 403 || status == 429 { return Err(ProviderError::RateLimited); }
        let text = resp.text().await.map_err(map_reqwest_err)?;
        let parsed: ApiResponse = serde_json::from_str(&text)
            .map_err(|e| ProviderError::Parse(format!("response json: {e}")))?;
        classify_response(parsed)
    }

    /// stk_mins 单窗口拉取（[start_dt, end_dt]，Asia/Shanghai naive），ts 升序。
    pub async fn fetch_window(&self, ts_code: &str, freq: &str,
                              start_dt: NaiveDateTime, end_dt: NaiveDateTime)
                              -> Result<Vec<Bar>, ProviderError> {
        let data = self.call_api("stk_mins", serde_json::json!({
            "ts_code": ts_code,
            "freq": freq,
            "start_date": start_dt.format("%Y-%m-%d %H:%M:%S").to_string(),
            "end_date": end_dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        })).await?;
        let bare = ts_code.split('.').next().unwrap_or(ts_code);
        parse_stk_mins(&data, &Code(bare.to_string()))
    }
}

fn map_reqwest_err(e: reqwest::Error) -> ProviderError {
    if e.is_timeout() { ProviderError::Timeout } else { ProviderError::Http(e.to_string()) }
}

#[async_trait::async_trait]
impl HistoricalDataProvider for TushareClient {
    fn id(&self) -> SourceId { SourceId::Tushare }

    /// 原生仅 M1；其余周期由 kline_accurate cagg 衍生（§1 裁决）。
    async fn fetch_history(&self, code: &Code, period: Period,
                           start: DateTime<Utc>, end: DateTime<Utc>)
                           -> Result<Vec<Bar>, ProviderError> {
        if period != Period::M1 {
            return Err(ProviderError::Parse(
                "tushare 原生仅 M1；M5/M15/H1/D1 由 kline_accurate cagg 衍生（§1 裁决）".into()));
        }
        let ts_code = to_ts_code(code)?;
        let start_d = start.with_timezone(&cst()).date_naive();
        let end_d = end.with_timezone(&cst()).date_naive();
        let mut out = Vec::new();
        for (ws, we) in crate::sync::plan_windows(start_d, end_d, WINDOW_DAYS_1MIN) {
            let win_close = we.and_hms_opt(15, 0, 0).expect("valid hms");
            let mut cursor = ws.and_hms_opt(9, 0, 0).expect("valid hms");
            loop {
                let batch = self.fetch_window(&ts_code, "1min", cursor, win_close).await?;
                let n = batch.len();
                if n > 0 {
                    let last = batch[n - 1].ts.with_timezone(&cst()).naive_local();
                    out.extend(batch);
                    if n >= MAX_ROWS_PER_BATCH && last < win_close {
                        cursor = last + Duration::minutes(1); // 满批续传
                        continue;
                    }
                }
                break;
            }
        }
        Ok(out)
    }

    fn supported_periods(&self) -> Vec<Period> { vec![Period::M1] }
}
// ~/~ end
