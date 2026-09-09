//! 模拟实盘实时评分 feed（F2：接入实时行情，驱动 running 会话评分/聚合/自动单）。
//! 手写，非 tangle（application crate 为本任务手写层；ADR-007 例外与 `simlive` 同源）。
//!
//! 数据流：app bin 装配（`eestock-app.rs`）注入 `SimLiveService` + `domain::ports::KlineRead`
//! + poll 周期 → `tokio::spawn(SimLiveFeed.run())`。每轮：
//! 1. `SimLiveService::feed_targets()` 枚举 poll 目标（**P4a：仅「running 且有钉住编排器」的
//!    会话**——策略配置在 start_session/恢复时已钉住重建，feed 不再自动配置；纯手动会话不轮询）；
//! 2. 对每个目标的每标的，经 `KlineRead::latest_bar(period, code)` 取最近一根；
//! 3. 若该标的最近 bar ts 有变化（新 bar）→ `SimLiveService::process_bar(session_id, code, bar)`
//!    （评估→评分→聚合→达阈值+统一开关开→自动模拟单）。
//!
//! **实现选择：poll 式**（而非 WS bar-订阅）——复核 ADR-017「应用面只读库，无数据面直连/NOTIFY」：
//! 应用面不订阅实时行情事件源，仅按 `interval` 轮询库内最近 bar。每 ≤1 根 bar 的采样周期内必发现新 ts。
//! 周期：`interval`（app bin 装配；缺省 [`DEFAULT_POLL_INTERVAL`]=5s，适配 M1/5m 等常见周期）。
//! 注：复用 storage 的 `KlineRead`（如 `storage::reader::KlineReader`），不新增行情数据链依赖。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use backtest::Bar;
use domain::ports::KlineRead;
use domain::types::Period;

use crate::simlive::SimLiveService;

/// 默认 poll 周期（5s）。M1 bar=60s/根；5s 采样足以在下一根 bar 到来前发现新 ts。
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// 会话内滚动 feed 状态：`(session_id, code) → 最近已处理 bar ts`。
#[derive(Default)]
struct FeedState {
    last_ts: HashMap<(String, String), i64>,
}

/// 实时评分 feed（poll 式）。
pub struct SimLiveFeed {
    svc: Arc<SimLiveService>,
    kline: Arc<dyn KlineRead>,
    interval: Duration,
    state: Mutex<FeedState>,
}

impl SimLiveFeed {
    /// 构造 feed（`interval` = poll 周期）。
    pub fn new(svc: Arc<SimLiveService>, kline: Arc<dyn KlineRead>, interval: Duration) -> Self {
        Self {
            svc,
            kline,
            interval,
            state: Mutex::new(FeedState::default()),
        }
    }

    /// 驱动循环（app bin `tokio::spawn`；每 `interval` 一轮）。
    pub async fn run(self) {
        loop {
            if let Err(e) = self.tick().await {
                tracing::warn!(error = %e, "sim-live feed tick failed");
            }
            tokio::time::sleep(self.interval).await;
        }
    }

    /// 一轮 poll：对每个 running 会话的标的集查最近 bar，新 ts 即 `process_bar`。
    /// 测试可直调（确定性、无随机/时间依赖）。返回本轮处理（产出/跳过）的标的数。
    pub async fn tick(&self) -> anyhow::Result<usize> {
        let targets = self.svc.feed_targets()?;
        let mut processed = 0usize;
        for t in targets {
            let Some(period) = dom_period_from_str(&t.period) else { continue };
            for code in &t.codes {
                let Some(view) = self.kline.latest_bar(period, code).await? else { continue };
                let ts = view.ts.timestamp();
                let key = (t.session_id.clone(), code.clone());
                if self.state.lock().unwrap().last_ts.get(&key).copied() == Some(ts) {
                    continue; // 无新 bar，跳过（避免重复评估）
                }
                let bar = Bar {
                    ts,
                    open: view.open,
                    high: view.high,
                    low: view.low,
                    close: view.close,
                    volume: view.volume as f64,
                };
                self.svc.process_bar(&t.session_id, code, bar).await?;
                self.state.lock().unwrap().last_ts.insert(key, ts);
                processed += 1;
            }
        }
        Ok(processed)
    }
}

/// 会话 period 字符串 → `domain::types::Period`（poll 查询用）。未知 → `None`（跳过该会话）。
fn dom_period_from_str(s: &str) -> Option<Period> {
    match s {
        "M1" => Some(Period::M1),
        "M5" => Some(Period::M5),
        "M15" => Some(Period::M15),
        "H1" => Some(Period::H1),
        "D1" => Some(Period::D1),
        "W1" => Some(Period::W1),
        "MO1" => Some(Period::MO1),
        _ => None,
    }
}
