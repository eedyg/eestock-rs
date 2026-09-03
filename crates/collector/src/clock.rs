// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/clock.rs>>[init]
//! 时钟抽象（trait 在 domain::ports，跨层共用；此处 re-export + FakeClock）。

use chrono::{DateTime, Utc};

pub use domain::ports::{Clock, SystemClock};

/// 测试用 fake clock：Arc 共享，测试可推进。
#[derive(Debug, Clone)]
pub struct FakeClock {
    inner: std::sync::Arc<std::sync::Mutex<DateTime<Utc>>>,
}

impl FakeClock {
    pub fn new(ts: DateTime<Utc>) -> Self {
        Self { inner: std::sync::Arc::new(std::sync::Mutex::new(ts)) }
    }
    pub fn advance(&self, d: chrono::Duration) {
        let mut g = self.inner.lock().unwrap();
        *g += d;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> { *self.inner.lock().unwrap() }
}
// ~/~ end
