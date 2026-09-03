// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/http.rs>>[init]
//! HTTP 客户端抽象 + reqwest 实现 + 限频门（token bucket 简化：最小间隔 + 随机抖动）。

use async_trait::async_trait;
use domain::provider::ProviderError;
use tokio::sync::Mutex;
use tokio::time::Instant;

/// 统一 UA（01 §5）。
pub const USER_AGENT: &str = "eestock-rs/0.1 (self-hosted market data)";
/// 默认超时 8s；东财系 5s（028 父级裁决）。
pub const DEFAULT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
pub const EASTMONEY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// HTTP 层抽象：解析纯函数吃 body，本 trait 可 mock（测试不触网）。
#[async_trait]
pub trait HttpClient: Send + Sync {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, ProviderError>;
}

pub struct ReqwestHttp {
    client: reqwest::Client,
}

impl ReqwestHttp {
    pub fn new(timeout: std::time::Duration) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent(USER_AGENT)
            .build().expect("reqwest client build");
        Self { client }
    }
}

#[async_trait]
impl HttpClient for ReqwestHttp {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, ProviderError> {
        let mut req = self.client.get(url);
        for (k, v) in headers { req = req.header(*k, *v); }
        let resp = req.send().await.map_err(map_reqwest_err)?;
        let status = resp.status().as_u16();
        // 01 §4：403/429 → RateLimited（不计熔断）；5xx/其他非 200 → Http（计熔断失败）
        if status == 403 || status == 429 { return Err(ProviderError::RateLimited); }
        if status != 200 { return Err(ProviderError::Http(format!("http status {status}"))); }
        let body = resp.bytes().await.map_err(map_reqwest_err)?.to_vec();
        Ok(HttpResponse { status, body })
    }
}

fn map_reqwest_err(e: reqwest::Error) -> ProviderError {
    if e.is_timeout() { ProviderError::Timeout } else { ProviderError::Http(e.to_string()) }
}

/// 最小间隔门 + 随机抖动（每适配器内嵌；01 §5 token bucket 口径的 KISS 实现）。
pub struct IntervalGate {
    interval: std::time::Duration,
    jitter_ms: u64,
    gate: Mutex<Instant>,
}

impl IntervalGate {
    pub fn new(interval: std::time::Duration, jitter_ms: u64) -> Self {
        let init = Instant::now().checked_sub(interval).unwrap_or_else(Instant::now);
        Self { interval, jitter_ms, gate: Mutex::new(init) }
    }
    /// 保证两次放行间隔 >= interval；放行后再加 0..=jitter_ms 随机抖动。
    pub async fn wait(&self) {
        use rand::Rng;
        {
            let mut g = self.gate.lock().await;
            let next = *g + self.interval;
            if next > Instant::now() { tokio::time::sleep_until(next).await; }
            *g = Instant::now();
        }
        if self.jitter_ms > 0 {
            let j = rand::thread_rng().gen_range(0..=self.jitter_ms);
            if j > 0 { tokio::time::sleep(std::time::Duration::from_millis(j)).await; }
        }
    }
}
// ~/~ end
