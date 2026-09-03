// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/tests/http_behavior.rs>>[init]
//! HTTP 层行为测试：Referer 必带 / 备域兜底 / 错误传播 / 限频门。mock HttpClient，不触网。

use async_trait::async_trait;
use domain::provider::{MinuteKlineProvider, ProviderError, SnapshotProvider};
use domain::types::*;
use providers::http::{HttpClient, HttpResponse, IntervalGate};
use providers::{sina_hq, tencent_ifzq};
use providers::sina_hq::SinaHq;
use providers::tencent_ifzq::TencentIfzq;
use std::sync::{Arc, Mutex};

type RecordedCall = (String, Vec<(String, String)>);

#[derive(Default)]
struct Mock {
    calls: Mutex<Vec<RecordedCall>>,
    queue: Mutex<Vec<Result<Vec<u8>, ProviderError>>>,
}

impl Mock {
    fn push(&self, r: Result<Vec<u8>, ProviderError>) { self.queue.lock().unwrap().push(r); }
    fn urls(&self) -> Vec<String> { self.calls.lock().unwrap().iter().map(|c| c.0.clone()).collect() }
    fn headers_of(&self, i: usize) -> Vec<(String, String)> { self.calls.lock().unwrap()[i].1.clone() }
}

#[async_trait]
impl HttpClient for Mock {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, ProviderError> {
        self.calls.lock().unwrap().push((url.to_string(),
            headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()));
        let r = self.queue.lock().unwrap().remove(0);
        r.map(|body| HttpResponse { status: 200, body })
    }
}

#[tokio::test]
async fn sina_hq_sends_referer() {
    let mock = Arc::new(Mock::default());
    mock.push(Ok(std::fs::read(format!("{}/testdata/sina_hq_snapshot.txt", env!("CARGO_MANIFEST_DIR"))).unwrap()));
    let p = SinaHq::new(mock.clone());
    let quotes = p.fetch_snapshot(&[Code("518880".into())]).await.unwrap();
    assert_eq!(quotes.len(), 4);
    let headers = mock.headers_of(0);
    assert!(headers.iter().any(|(k, v)| k == "Referer" && v == sina_hq::REFERER),
            "SinaHq 必带 Referer（否则 403）: {headers:?}");
    assert!(mock.urls()[0].starts_with(sina_hq::ENDPOINT));
}

#[tokio::test]
async fn ifzq_fallback_endpoint_on_failure() {
    let mock = Arc::new(Mock::default());
    mock.push(Err(ProviderError::Http("conn reset".into())));
    mock.push(Ok(std::fs::read(format!("{}/testdata/tencent_ifzq_m1.json", env!("CARGO_MANIFEST_DIR"))).unwrap()));
    let p = TencentIfzq::new(mock.clone());
    let bars = p.fetch_m1(&Code("518880".into()), 5).await.unwrap();
    assert_eq!(bars.len(), 3);
    let urls = mock.urls();
    assert!(urls[0].starts_with(tencent_ifzq::ENDPOINT));
    assert!(urls[1].starts_with(tencent_ifzq::ENDPOINT_FALLBACK), "主域失败应兜底备域");
}

#[tokio::test]
async fn ifzq_fallback_also_fails_propagates_first_error() {
    let mock = Arc::new(Mock::default());
    mock.push(Err(ProviderError::RateLimited));
    mock.push(Err(ProviderError::Timeout));
    let p = TencentIfzq::new(mock.clone());
    match p.fetch_m1(&Code("518880".into()), 5).await {
        Err(ProviderError::RateLimited) => {}
        other => panic!("双域皆败应传播首个错误（RateLimited 走退避不进熔断），实际 {other:?}"),
    }
}

#[tokio::test]
async fn gate_enforces_min_interval() {
    let g = IntervalGate::new(std::time::Duration::from_millis(50), 0);
    let t0 = std::time::Instant::now();
    for _ in 0..3 { g.wait().await; }
    assert!(t0.elapsed() >= std::time::Duration::from_millis(100),
            "3 次放行（首次立即）应至少间隔 2×50ms，实际 {:?}", t0.elapsed());
}
// ~/~ end
