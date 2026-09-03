// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/service.rs>>[init]
//! 运行时装配：reconcile 循环（60s 重读 symbols 热生效）+ 每 code 抓取循环
//! + 缺口回填循环（启动即跑 + 每 30min）+ 熔断低频探测任务（§4 HalfOpen 自愈，60s 节拍）。
//!
//! 降级模式内层循环 5-10s 轮询快照。
//!
//! 注：本模块为薄胶合（tokio 任务编排），行为逻辑均在已单测的组件内。
//! §2 注记：非交易时段调度静默跳过（不为每分钟每标的刷 NA 事件噪音）；
//! NA 事件口径由源端 NoData 响应承载（§7），与 028 一致。

use crate::calendar::WeekdayCalendar;
use crate::clock::Clock;
use crate::executor::{FetchExecutor, FetchOutcome};
use crate::gapfill::{GapBackfiller, BACKFILL_INTERVAL};
use crate::probe::CircuitProber;
use crate::scheduler::{fetch_limit, next_tick_after};
use crate::standby::StandbyReserve;
use domain::ports::{HealthMonitor, KlineWriter, SymbolRegistry, TradingCalendar};
use domain::types::Code;
use rand::Rng;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinHandle;

pub struct CollectorService {
    executor: Arc<FetchExecutor>,
    standby: Arc<StandbyReserve>,
    gapfill: Arc<GapBackfiller>,
    prober: Arc<CircuitProber>,
    registry: Arc<dyn SymbolRegistry>,
    calendar: Arc<dyn TradingCalendar>,
    writer: Arc<dyn KlineWriter>,
    clock: Arc<dyn Clock>,
}

impl CollectorService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        executor: Arc<FetchExecutor>,
        standby: Arc<StandbyReserve>,
        gapfill: Arc<GapBackfiller>,
        prober: Arc<CircuitProber>,
        registry: Arc<dyn SymbolRegistry>,
        writer: Arc<dyn KlineWriter>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let calendar: Arc<dyn TradingCalendar> = Arc::new(WeekdayCalendar::new(clock.clone()));
        Self { executor, standby, gapfill, prober, registry, calendar, writer, clock }
    }

    /// 主循环：reconcile（60s）+ 缺口回填（30min）+ 熔断低频探测（60s，§4）。
    pub async fn run(self: Arc<Self>) -> anyhow::Result<()> {
        // 缺口回填：启动即跑一轮，之后每 30 分钟（§5）
        {
            let gf = self.gapfill.clone();
            tokio::spawn(async move {
                loop {
                    if let Err(e) = gf.backfill_today().await {
                        tracing::warn!(error = %e, "gap backfill round failed");
                    }
                    tokio::time::sleep(BACKFILL_INTERVAL).await;
                }
            });
        }
        // 低频探测：HalfOpen Tier1 源冷却到期后单发探测自愈（§4，不占交易抓取通道）
        {
            let pb = self.prober.clone();
            tokio::spawn(async move { crate::probe::run_forever(pb).await });
        }
        let mut tasks: HashMap<Code, JoinHandle<()>> = HashMap::new();
        loop {
            match self.registry.enabled_codes().await {
                Ok(codes) => {
                    let live: std::collections::HashSet<&Code> = codes.iter().collect();
                    // 移除已禁用标的
                    tasks.retain(|c, h| {
                        if live.contains(c) { true } else { h.abort(); false }
                    });
                    // 新增标的起任务
                    for code in codes {
                        if let std::collections::hash_map::Entry::Vacant(e) = tasks.entry(code) {
                            let svc = self.clone();
                            let c = e.key().clone();
                            e.insert(tokio::spawn(async move { svc.code_loop(c).await }));
                        }
                    }
                }
                Err(e) => tracing::warn!(error = %e, "symbols re-read failed (keep current set)"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    }

    /// 单标的抓取循环：每周期重读 interval（热生效），分钟边界对齐。
    /// 注：ThreadRng 不 Send，仅在调用点临时创建（不跨 await 持有）。
    async fn code_loop(self: Arc<Self>, code: Code) {
        loop {
            let interval = self.registry.interval_secs(&code).await.unwrap_or(60);
            let seed: u64 = rand::thread_rng().gen();
            let next = next_tick_after(self.clock.now(), interval, seed);
            let wait = (next - self.clock.now()).to_std().unwrap_or(std::time::Duration::ZERO);
            tokio::time::sleep(wait).await;
            if !self.calendar.is_trading_now() { continue; } // 非交易时段跳过（注记见模块头）
            if self.standby.is_degraded(&code) {
                self.degraded_loop(&code).await;
                continue;
            }
            let limit = fetch_limit(self.clock.now());
            if limit == 0 { continue; }
            if self.executor.fetch_one(&code, limit).await == FetchOutcome::AllFailed {
                tracing::warn!(code = %code.0, "attempt_chain all failed -> 进入降级模式");
                self.standby.activate(&code);
            }
        }
    }

    /// 降级模式内层循环：5-10s 轮询快照合成近似 bar；Tier1 可用即探测回切（§6）。
    async fn degraded_loop(&self, code: &Code) {
        while self.standby.is_degraded(code) {
            // 恢复探测：Tier1 有可用源 → 走正常链试一次
            if StandbyReserve::should_probe_recover(&self.executor.circuits().healthy_minute_sources().await) {
                let limit = fetch_limit(self.clock.now()).max(crate::scheduler::OVERLAP_BARS + 1);
                if let FetchOutcome::Ok { .. } = self.executor.fetch_one(code, limit).await {
                    tracing::info!(code = %code.0, "Tier1 恢复探测成功 -> 回切正常模式");
                    self.standby.deactivate(code);
                    break;
                }
            }
            match self.standby.poll_once(code).await {
                Ok(bar) => {
                    if let Err(e) = self.writer.write_batch(&[bar]).await {
                        tracing::warn!(code = %code.0, error = %e, "approx bar write failed");
                    }
                }
                Err(e) => tracing::warn!(code = %code.0, error = %e, "snapshot pool exhausted this round"),
            }
            if !self.calendar.is_trading_now() { break; } // 非交易时段退出降级轮询，下周期重估
            let delay = { let mut r = rand::thread_rng(); StandbyReserve::next_poll_delay(&mut r) };
            tokio::time::sleep(delay).await; // rng 先行 drop，不跨 await（Send）
        }
    }
}
// ~/~ end
