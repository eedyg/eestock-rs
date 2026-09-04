// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/reset.rs>>[init]
//! 熔断复位 DB 控制通道消费端（Wave 1 Phase C 加法扩展，ADR-017）。
//! 应用面写 circuit_reset_requests；本任务轮询原子消费 → CircuitRegistry.manual_reset
//! （复位事件由数据面单写者发出；未知 source 跳过并 warn）。既有采集/熔断逻辑零改动。

use crate::circuit::CircuitRegistry;
use domain::ports::CircuitResetChannel;
use domain::types::SourceId;
use std::sync::Arc;
use std::time::Duration;

/// 复位轮询周期：复位为低频人工操作，5s 足够敏捷（事件表聚合窗口远宽于此）。
pub const RESET_POLL_INTERVAL: Duration = Duration::from_secs(5);

pub struct ResetWatcher {
    channel: Arc<dyn CircuitResetChannel>,
    circuits: Arc<CircuitRegistry>,
}

impl ResetWatcher {
    pub fn new(channel: Arc<dyn CircuitResetChannel>, circuits: Arc<CircuitRegistry>) -> Self {
        Self { channel, circuits }
    }

    /// 单轮消费（测试可直调）：取出全部待消费复位请求并逐条执行，返回实际复位数。
    pub async fn poll_once(&self) -> anyhow::Result<usize> {
        let reqs = self.channel.take_pending().await?;
        let mut applied = 0usize;
        for r in reqs {
            match SourceId::parse(&r.source) {
                Some(src) => {
                    tracing::info!(source = %r.source, request_id = r.id, "circuit manual reset consumed");
                    self.circuits.manual_reset(src).await;
                    applied += 1;
                }
                None => tracing::warn!(source = %r.source, request_id = r.id,
                    "reset request for unknown source skipped"),
            }
        }
        Ok(applied)
    }
}

/// 常驻任务：按 RESET_POLL_INTERVAL 轮询消费（单轮失败记 warn 下轮重试，不退出）。
pub async fn run_forever(watcher: Arc<ResetWatcher>) {
    loop {
        if let Err(e) = watcher.poll_once().await {
            tracing::warn!(error = %e, "circuit reset poll failed");
        }
        tokio::time::sleep(RESET_POLL_INTERVAL).await;
    }
}
// ~/~ end
