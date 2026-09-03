# 03 — 采集服务（Collector）详细设计

> Wave 1 核心。职责：按注册集合与间隔调度，经源选取策略（ADR-005）抓取 1m bar 写入 kline_raw，维护心跳与熔断，当日缺口回填，产出健康事件。
> 实现时本文档承载 collector crate 的代码块（TDD：测试先行）。

## 1. 组件结构

```
CollectorService
├── Scheduler        # 每 code 一个 ticker（interval_secs），对齐分钟边界
├── FetchExecutor    # attempt_chain 执行器：随机起点+轮询转移（domain::selector）
├── GapBackfiller    # 启动时/周期内当日缺口回填
├── StandbyReserve    # 冷藏备援：平时零请求，降级模式激活（ADR-015）
├── CircuitRegistry  # 熔断状态机（内存态 + 事件落库）
└── EventSink        # source_health_events 写入（诊断数据源）
```

## 2. 调度循环（Scheduler）

- 每 enabled code 一个独立 ticker：`interval_secs`（≥60，symbols 表），**相位对齐分钟边界**（`next_tick = ceil(now/60)*60 + jitter(0~2s)`，抖动防同刻齐发）
- 间隔修改热生效（ADR：symbols 变更下周期生效）：Scheduler 每周期前重读 symbols（轻量查询；变更频率极低，不做订阅推送）
- 非交易时段（TradingCalendar）跳过拉取，记 NA 不记失败；Wave 1 简化口径=仅工作日（节假日噪音接受）

## 3. 单次抓取流程（FetchExecutor）

```
对 code C：
  chain = selector.attempt_chain(duty_source(), healthy_minute_sources())
  # ADR-015：时间窗轮换——随机窗长 20-40min 指定当班主源，全部标的先试当班源，
  # 另一源仅故障转移承接；窗界切换带 0-30s 随机偏移；熔断源始终剔除
  for src in chain:                                          # 单批次内按序转移
      t0 = now
      match provider[src].fetch_m1(C, limit=N):              # N=当日剩余分钟数+少量重叠
          Ok(bars)  -> 记录成功事件(延迟) → writer.write_batch(bars)（首写胜出）→ break
          Err(NoData)      -> 记 NA（非交易时段/新上市），不视为失败，break
          Err(RateLimited) -> 记失败(err_kind=rate_limited) → CircuitRegistry.penalize(src, 退避档) → 继续下一源
          Err(e)           -> 记失败(err_kind) → CircuitRegistry.record_failure(src) → 继续下一源
  全部失败 -> 记 code 级失败事件（诊断面板缺口率的因）
```

- **粘源**：单 code 单批次内不跳源重取已成功部分
- 重叠窗口：每次拉取含最近 3 根已有 bar 的重叠，靠首写胜出自然去重（容忍源端当根 bar 修正）
- Trace ID：每次抓取生成，贯穿事件/日志

## 4. 熔断状态机（CircuitRegistry，ADR-005 口径）

```
Healthy --连续3次失败--> CircuitOpen --冷却60s--> HalfOpen --单次成功--> Healthy
   ↑__________________________|                    --失败--> CircuitOpen(冷却×2, 封顶30min)
RateLimited：不进熔断计数，直接按 5s→10s→30s 退避档静默该源（err_kind=rate_limited 计限流信号）
手动复位（诊断面板 POST /sources/{id}/reset）：任意态 → Healthy，记事件
```

- 熔断源从 attempt_chain 健康池摘除；心跳任务对熔断源降为低频探测（HalfOpen 的探测走心跳通道，不占交易抓取）

## 5. 当日缺口回填（GapBackfiller，Q4-B）

- 触发：服务启动时 + 每 30 分钟周期检查
- 缺口定义：当日交易分钟序列（09:30-11:30 ∪ 13:00-15:00，共 240 分钟）− kline_raw 已有 ts
- 回填：对每个缺口 code，走正常 attempt_chain 拉 limit=240 的 m1，首写胜出只补缺的部分
- 只回填**当日**（更早的历史缺口归 tushare 准确层职责，ADR-003）

## 6. 冷藏备援与降级模式（ADR-015，取代原心跳模式）

- **快照池平时零请求**（无心跳无轮询，standby 状态），仅降级模式激活
- 降级触发：某标的 attempt_chain 全链失败（Tier 1 双源均败/熔断）→ 该标的进入**降级模式**：
  - 快照池源顺序**每次随机打乱**后逐个尝试，5-10s（含随机抖动）轮询快照
  - 本地聚合合成近似 1m bar：`source=*_approx` 标记（OHLC≈快照价序列、volume 差分估算或 0），与真实 bar 物理可区分
  - Tier 2 源失败：该源本次激活期指数退避冷却，不轰击
- 恢复：Tier 1 熔断源 HalfOpen 探测成功 → 该标的回切正常；近似 bar 保留待 tushare 准确层覆盖
- 状态可见：diagnose 对冷藏源显示 `standby`；全局状态灯在任一标的降级时变 🟡

## 7. 事件模型（写 source_health_events）

| 场景 | ok | err_kind |
|---|---|---|
| 抓取成功 | true | NULL |
| 非交易时段/无数据 | true | na（架构师锁定：写事件 ok=true+err_kind=na 保留可见性；成功率分母显式排除 err_kind='na'，与 028 口径一致）|
| 超时/HTTP/解析失败 | false | timeout/http/parse |
| 403/429 | false | rate_limited |
| 熔断状态迁移 | false | circuit_open / circuit_halfopen / circuit_closed / manual_reset |

## 8. TDD 规格要点

- Scheduler 相位对齐与热生效（fake clock）
- FetchExecutor：首源成功不转移；NoData 不计失败；RateLimited 走退避不进熔断；全链失败产出 code 级事件
- CircuitRegistry 状态机全迁移路径（含冷却翻倍封顶、手动复位）
- GapBackfiller：缺口集合计算（含午休边界 11:30/13:00 不误判）；只写缺失 ts
- 全部用 mock Provider + fake clock，不触网

## 9. 实现（collector crate，TDD：全部 mock Provider + fake clock，不触网）

### 9.1 模块结构

``` {.rust file=crates/collector/src/lib.rs}
//! collector —— 应用层：采集调度、源选取状态机、熔断、缺口回填、降级模式。
//! 由 design/03-collector/00-design.md tangle 生成（ADR-007），禁止手改。

pub mod calendar;
pub mod circuit;
pub mod clock;
pub mod executor;
pub mod gapfill;
pub mod scheduler;
pub mod service;
pub mod standby;
```

### 9.2 时钟抽象（fake clock 单测的根基）

``` {.rust file=crates/collector/src/clock.rs}
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
```

### 9.3 TradingCalendar（Wave 0 简化口径：仅工作日，节假日噪音接受）

bar 起始时刻口径：上午 09:30..=11:29（120 根）+ 下午 13:00..=14:59（120 根）= 240 分钟。
边界：11:30 属午休（不误判为交易分钟）、13:00 属午后首节（不误判为午休）。

``` {.rust file=crates/collector/src/calendar.rs}
//! 交易时段判定（工作日 + 双交易时段；节假日表 Wave 2 接入）。

use crate::clock::Clock;
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use domain::ports::TradingCalendar;
use domain::tz::utc_to_cst;
use std::sync::Arc;

pub fn hm(h: u32, m: u32) -> NaiveTime { NaiveTime::from_hms_opt(h, m, 0).expect("valid hm") }

/// 分钟（bar 起始时刻）是否交易时段。
pub fn is_trading_minute(t: NaiveTime) -> bool {
    (hm(9, 30)..hm(11, 30)).contains(&t) || (hm(13, 0)..hm(15, 0)).contains(&t)
}

/// 当日交易分钟序列（bar 起始时刻，naive CST）：09:30..=11:29 ∪ 13:00..=14:59，共 240。
pub fn trading_minutes(date: NaiveDate) -> Vec<NaiveDateTime> {
    let mut out = Vec::with_capacity(240);
    let mut push_range = |start: NaiveTime, end: NaiveTime| {
        let mut t = start;
        while t < end {
            out.push(date.and_time(t));
            t += chrono::Duration::minutes(1);
        }
    };
    push_range(hm(9, 30), hm(11, 30));
    push_range(hm(13, 0), hm(15, 0));
    out
}

pub fn is_weekday(date: NaiveDate) -> bool {
    matches!(date.weekday(), chrono::Weekday::Mon | chrono::Weekday::Tue
        | chrono::Weekday::Wed | chrono::Weekday::Thu | chrono::Weekday::Fri)
}

pub struct WeekdayCalendar {
    clock: Arc<dyn Clock>,
}

impl WeekdayCalendar {
    pub fn new(clock: Arc<dyn Clock>) -> Self { Self { clock } }
}

impl TradingCalendar for WeekdayCalendar {
    fn is_trading_day(&self, date: NaiveDate) -> bool { is_weekday(date) }

    fn is_trading_now(&self) -> bool {
        let cst = utc_to_cst(self.clock.now());
        self.is_trading_day(cst.date()) && is_trading_minute(cst.time())
    }
}
```

### 9.4 CircuitRegistry（熔断状态机，§4 全路径）

``` {.rust file=crates/collector/src/circuit.rs}
//! 熔断状态机：Healthy --连续3败--> Open --冷却60s--> HalfOpen --单次成功--> Healthy；
//! HalfOpen 失败 --> Open（冷却×2 封顶 30min）；RateLimited 不进熔断计数，走 5s→10s→30s 退避；
//! 手动复位任意态 → Healthy。状态迁移事件落 source_health_events（§7）。

use crate::clock::Clock;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use domain::ports::{ErrKind, EventSink, HealthEvent, HealthMonitor};
use domain::types::{Health, SourceId};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const FAIL_THRESHOLD: u32 = 3;
pub const BASE_COOLDOWN: Duration = Duration::seconds(60);
pub const MAX_COOLDOWN: Duration = Duration::minutes(30);
/// RateLimited 退避档：5s→10s→30s（封顶保持 30s）。
pub const RL_LADDER: [Duration; 3] =
    [Duration::seconds(5), Duration::seconds(10), Duration::seconds(30)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState { Healthy, Open, HalfOpen }

#[derive(Debug, Clone)]
struct Entry {
    state: CircuitState,
    consecutive_failures: u32,
    opened_at: DateTime<Utc>,
    cooldown: Duration,
    rl_count: u32,
    rl_muted_until: Option<DateTime<Utc>>,
}

impl Entry {
    fn new(now: DateTime<Utc>) -> Self {
        Self { state: CircuitState::Healthy, consecutive_failures: 0, opened_at: now,
               cooldown: BASE_COOLDOWN, rl_count: 0, rl_muted_until: None }
    }
}

pub struct CircuitRegistry {
    tier1: Vec<SourceId>,
    clock: Arc<dyn Clock>,
    sink: Arc<dyn EventSink>,
    entries: Mutex<HashMap<SourceId, Entry>>,
}

impl CircuitRegistry {
    pub fn new(tier1: Vec<SourceId>, clock: Arc<dyn Clock>, sink: Arc<dyn EventSink>) -> Self {
        Self { tier1, clock, sink, entries: Mutex::new(HashMap::new()) }
    }

    async fn emit_migration(&self, src: SourceId, kind: ErrKind) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: src, ok: false, latency_ms: None,
            err_kind: Some(kind), code: None, trace_id: None,
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(source = src.as_str(), error = %e, "circuit migration event emit failed");
        }
    }

    /// 懒迁移：Open 冷却到期 → HalfOpen（返回需发出的迁移事件）。
    fn resolve(entry: &mut Entry, now: DateTime<Utc>) -> Option<ErrKind> {
        if entry.state == CircuitState::Open && now >= entry.opened_at + entry.cooldown {
            entry.state = CircuitState::HalfOpen;
            return Some(ErrKind::CircuitHalfopen);
        }
        None
    }

    fn usable(entry: &Entry, now: DateTime<Utc>) -> bool {
        entry.state == CircuitState::Healthy
            && entry.rl_muted_until.map(|u| now >= u).unwrap_or(true)
    }

    /// 手动复位（诊断面板 POST /sources/{id}/reset，Wave 1 走 DB 控制通道）：任意态 → Healthy。
    pub async fn manual_reset(&self, src: SourceId) {
        {
            let mut g = self.entries.lock().await;
            *g.entry(src).or_insert_with(|| Entry::new(self.clock.now())) =
                Entry::new(self.clock.now());
        }
        self.emit_migration(src, ErrKind::ManualReset).await;
    }

    /// 当前状态（测试/诊断用，含懒迁移）。
    pub async fn state(&self, src: SourceId) -> CircuitState {
        let now = self.clock.now();
        let (state, migration) = {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(now));
            let m = Self::resolve(e, now);
            (e.state, m)
        };
        if let Some(kind) = migration { self.emit_migration(src, kind).await; }
        state
    }
}

#[async_trait]
impl HealthMonitor for CircuitRegistry {
    async fn report_success(&self, src: SourceId, _latency_ms: u64) {
        let mut closed = false;
        {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(self.clock.now()));
            e.consecutive_failures = 0;
            e.rl_count = 0;
            e.rl_muted_until = None;
            if e.state == CircuitState::HalfOpen {
                e.state = CircuitState::Healthy;
                e.cooldown = BASE_COOLDOWN;
                closed = true;
            }
        }
        if closed { self.emit_migration(src, ErrKind::CircuitClosed).await; }
    }

    async fn report_failure(&self, src: SourceId, err_kind: &str) {
        let now = self.clock.now();
        let mut migration = None;
        {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(now));
            if err_kind == ErrKind::RateLimited.as_str() {
                // 限流不进熔断计数：5s→10s→30s 退避档静默该源（§4）
                e.rl_muted_until = Some(now + RL_LADDER[(e.rl_count as usize).min(2)]);
                e.rl_count = (e.rl_count + 1).min(u32::MAX - 1);
            } else {
                e.consecutive_failures += 1;
                match e.state {
                    CircuitState::HalfOpen => {
                        e.state = CircuitState::Open;
                        e.opened_at = now;
                        e.cooldown = (e.cooldown * 2).min(MAX_COOLDOWN);
                        migration = Some(ErrKind::CircuitOpen);
                    }
                    CircuitState::Healthy if e.consecutive_failures >= FAIL_THRESHOLD => {
                        e.state = CircuitState::Open;
                        e.opened_at = now;
                        e.cooldown = BASE_COOLDOWN;
                        migration = Some(ErrKind::CircuitOpen);
                    }
                    _ => {}
                }
            }
        }
        if let Some(kind) = migration { self.emit_migration(src, kind).await; }
    }

    async fn health(&self, src: SourceId) -> Health {
        let now = self.clock.now();
        let (state, rl_muted, migration) = {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(now));
            let m = Self::resolve(e, now);
            (e.state, e.rl_muted_until.map(|u| now < u).unwrap_or(false), m)
        };
        if let Some(kind) = migration { self.emit_migration(src, kind).await; }
        match state {
            CircuitState::Healthy if rl_muted => Health::Degraded,
            CircuitState::Healthy => Health::Healthy,
            CircuitState::Open | CircuitState::HalfOpen => Health::CircuitOpen,
        }
    }

    async fn healthy_minute_sources(&self) -> Vec<SourceId> {
        let now = self.clock.now();
        let mut out = Vec::new();
        let mut migrations = Vec::new();
        {
            let mut g = self.entries.lock().await;
            for src in &self.tier1 {
                let e = g.entry(*src).or_insert_with(|| Entry::new(now));
                if let Some(kind) = Self::resolve(e, now) { migrations.push((*src, kind)); }
                if Self::usable(e, now) { out.push(*src); }
            }
        }
        for (src, kind) in migrations { self.emit_migration(src, kind).await; }
        out
    }
}
```

### 9.5 FetchExecutor（§3 单次抓取流程）

``` {.rust file=crates/collector/src/executor.rs}
//! 单次抓取执行器：attempt_chain（当班源优先 + 注册序轮转）+ 首写胜出 + Trace ID 贯穿。

use crate::circuit::CircuitRegistry;
use crate::clock::Clock;
use chrono::{DateTime, Utc};
use domain::ports::{ErrKind, EventSink, HealthEvent, HealthMonitor, KlineWriter};
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;
use std::collections::HashMap;
use std::sync::Arc;

/// ProviderError → ErrKind（01-providers-spec §4 统一口径）。
pub fn err_kind_of(e: &ProviderError) -> ErrKind {
    match e {
        ProviderError::Timeout => ErrKind::Timeout,
        ProviderError::Http(_) => ErrKind::Http,
        ProviderError::Parse(_) => ErrKind::Parse,
        ProviderError::RateLimited => ErrKind::RateLimited,
        ProviderError::NoData => ErrKind::Na,
    }
}

/// FNV-1a 稳定散列：当班窗偏移/乱序的种子（确定性、测试可复现）。
pub fn stable_seed(s: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in s.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}

/// ADR-015：时间窗轮换当班。窗界切换带 0-30s 偏移（按 code 稳定散列，各标的非同刻切换）。
pub fn duty_for(roster: &DutyRoster, code: &Code, now: DateTime<Utc>) -> SourceId {
    let seed = stable_seed(&code.0);
    let shifted = now + chrono::Duration::seconds((seed % 31) as i64);
    roster.duty_at((shifted.timestamp() / 60) as u64, seed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchOutcome {
    Ok { source: SourceId, fetched: usize, inserted: usize },
    NoData,
    AllFailed,
}

pub struct FetchExecutor {
    providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>>,
    selector: SourceSelector,
    roster: DutyRoster,
    circuits: Arc<CircuitRegistry>,
    writer: Arc<dyn KlineWriter>,
    sink: Arc<dyn EventSink>,
    clock: Arc<dyn Clock>,
}

impl FetchExecutor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>>,
        selector: SourceSelector,
        roster: DutyRoster,
        circuits: Arc<CircuitRegistry>,
        writer: Arc<dyn KlineWriter>,
        sink: Arc<dyn EventSink>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { providers, selector, roster, circuits, writer, sink, clock }
    }

    /// 熔断注册表访问口（service 降级恢复探测用）。
    pub fn circuits(&self) -> &Arc<CircuitRegistry> { &self.circuits }

    async fn emit(&self, src: SourceId, ok: bool, latency_ms: Option<u32>,
                  err: Option<ErrKind>, code: Option<&Code>, trace_id: &str) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: src, ok, latency_ms, err_kind: err,
            code: code.cloned(), trace_id: Some(trace_id.to_string()),
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(source = src.as_str(), error = %e, "event emit failed");
        }
    }

    /// 对 code 执行一次 attempt_chain 抓取（§3）：单批次内按序转移、粘源、NoData 不计失败。
    pub async fn fetch_one(&self, code: &Code, limit: usize) -> FetchOutcome {
        let trace_id = new_trace_id();
        let now = self.clock.now();
        let duty = duty_for(&self.roster, code, now);
        let healthy = self.circuits.healthy_minute_sources().await;
        let chain = self.selector.attempt_chain(duty, &healthy);
        if chain.is_empty() {
            tracing::warn!(code = %code.0, trace_id, "attempt_chain empty: all tier1 sources unusable");
            self.emit(duty, false, None, Some(ErrKind::AllFailed), Some(code), &trace_id).await;
            return FetchOutcome::AllFailed;
        }
        for src in &chain {
            let provider = &self.providers[src];
            let t0 = std::time::Instant::now();
            match provider.fetch_m1(code, limit).await {
                Ok(bars) => {
                    let latency = t0.elapsed().as_millis() as u64;
                    self.circuits.report_success(*src, latency).await;
                    self.emit(*src, true, Some(latency as u32), None, Some(code), &trace_id).await;
                    return match self.writer.write_batch(&bars).await {
                        Ok(inserted) => {
                            tracing::info!(code = %code.0, source = src.as_str(), trace_id,
                                fetched = bars.len(), inserted, "fetch ok");
                            FetchOutcome::Ok { source: *src, fetched: bars.len(), inserted }
                        }
                        Err(e) => {
                            tracing::error!(code = %code.0, trace_id, error = %e, "kline write failed");
                            FetchOutcome::AllFailed
                        }
                    };
                }
                Err(ProviderError::NoData) => {
                    // 记 NA 不记失败（非交易时段/新上市），不转移（本批次终止）
                    self.emit(*src, true, None, Some(ErrKind::Na), Some(code), &trace_id).await;
                    return FetchOutcome::NoData;
                }
                Err(e) => {
                    let kind = err_kind_of(&e);
                    self.emit(*src, false, None, Some(kind), Some(code), &trace_id).await;
                    self.circuits.report_failure(*src, kind.as_str()).await;
                    tracing::warn!(code = %code.0, source = src.as_str(), trace_id,
                        err_kind = kind.as_str(), "fetch failed, try next source");
                }
            }
        }
        // 全链失败 → code 级失败事件（诊断面板缺口率的因，§3）
        self.emit(duty, false, None, Some(ErrKind::AllFailed), Some(code), &trace_id).await;
        FetchOutcome::AllFailed
    }
}
```

### 9.6 GapBackfiller（§5 当日缺口回填）

``` {.rust file=crates/collector/src/gapfill.rs}
//! 当日缺口回填：启动时 + 每 30 分钟。缺口 = 当日交易分钟序列 − kline_raw 已有 ts（仅当日；
//! 更早历史缺口归 tushare 准确层，ADR-003）。只拉已过去的分钟（未来分钟不是缺口）。

use crate::calendar::{is_weekday, trading_minutes};
use crate::clock::Clock;
use crate::executor::FetchExecutor;
use chrono::{DateTime, NaiveDate, Timelike, Utc};
use domain::ports::{RawBarReader, SymbolRegistry};
use domain::tz::{cst_to_utc, utc_to_cst};
use std::collections::HashSet;
use std::sync::Arc;

pub const BACKFILL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30 * 60);
pub const GAP_LIMIT: usize = 240;

/// 缺口集合：当日已过去的交易分钟（bar 起始时刻）− existing。非当日/非交易日 → 空。
pub fn compute_gaps(existing: &HashSet<DateTime<Utc>>, date: NaiveDate, now: DateTime<Utc>)
    -> Vec<DateTime<Utc>> {
    let cst_now = utc_to_cst(now);
    if cst_now.date() != date || !is_weekday(date) { return vec![]; }
    let now_floor = cst_now.with_second(0).and_then(|t| t.with_nanosecond(0))
        .map(cst_to_utc).unwrap_or(now);
    trading_minutes(date).into_iter().map(cst_to_utc)
        .filter(|ts| *ts <= now_floor && !existing.contains(ts))
        .collect()
}

pub struct GapBackfiller {
    executor: Arc<FetchExecutor>,
    reader: Arc<dyn RawBarReader>,
    registry: Arc<dyn SymbolRegistry>,
    clock: Arc<dyn Clock>,
}

impl GapBackfiller {
    pub fn new(executor: Arc<FetchExecutor>, reader: Arc<dyn RawBarReader>,
               registry: Arc<dyn SymbolRegistry>, clock: Arc<dyn Clock>) -> Self {
        Self { executor, reader, registry, clock }
    }

    /// 当日缺口回填一轮：返回触发回填的 code 数。
    pub async fn backfill_today(&self) -> anyhow::Result<usize> {
        let now = self.clock.now();
        let today = utc_to_cst(now).date();
        if !is_weekday(today) { return Ok(0); }
        let mut touched = 0usize;
        for code in self.registry.enabled_codes().await? {
            let existing = self.reader.existing_ts(&code, today).await?;
            let gaps = compute_gaps(&existing, today, now);
            if gaps.is_empty() { continue; }
            tracing::info!(code = %code.0, gaps = gaps.len(), "gap backfill start");
            self.executor.fetch_one(&code, GAP_LIMIT).await; // 首写胜出只补缺的部分
            touched += 1;
        }
        Ok(touched)
    }
}
```

### 9.7 StandbyReserve（§6 冷藏备援与降级模式）

``` {.rust file=crates/collector/src/standby.rs}
//! 冷藏备援：快照池平时零请求；attempt_chain 全链失败的标的进入降级模式——
//! 快照池随机打乱逐源 5-10s 轮询，本地合成近似 1m bar（source=*_approx）；
//! Tier2 源失败指数退避；Tier1 恢复探测成功 → 回切正常。

use crate::clock::Clock;
use chrono::{DateTime, Duration, Timelike, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use rand::Rng;
use rand::seq::SliceRandom;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub struct StandbyReserve {
    pool: Vec<Arc<dyn SnapshotProvider>>,
    clock: Arc<dyn Clock>,
    degraded: Mutex<HashSet<Code>>,
    fail_counts: Mutex<HashMap<SourceId, u32>>,
    muted_until: Mutex<HashMap<SourceId, DateTime<Utc>>>,
    last_quotes: Mutex<HashMap<Code, Quote>>,
}

impl StandbyReserve {
    pub fn new(pool: Vec<Arc<dyn SnapshotProvider>>, clock: Arc<dyn Clock>) -> Self {
        Self { pool, clock, degraded: Mutex::new(HashSet::new()),
               fail_counts: Mutex::new(HashMap::new()), muted_until: Mutex::new(HashMap::new()),
               last_quotes: Mutex::new(HashMap::new()) }
    }

    pub fn activate(&self, code: &Code) { self.degraded.lock().unwrap().insert(code.clone()); }
    pub fn deactivate(&self, code: &Code) { self.degraded.lock().unwrap().remove(code); }
    pub fn is_degraded(&self, code: &Code) -> bool { self.degraded.lock().unwrap().contains(code) }
    pub fn degraded_codes(&self) -> Vec<Code> { self.degraded.lock().unwrap().iter().cloned().collect() }

    /// 轮询间隔：5-10s（含随机抖动，§6）。
    pub fn next_poll_delay<R: Rng>(rng: &mut R) -> std::time::Duration {
        std::time::Duration::from_millis(rng.gen_range(5000..=10000))
    }

    /// Tier2 源失败退避：10s 指数 ×2 封顶 300s（激活期内冷却，不轰击）。
    pub fn tier2_backoff(fail_count: u32) -> Duration {
        Duration::seconds((10i64 << fail_count.min(5)).min(300))
    }

    /// 分钟边界（bar 起始时刻对齐；UTC/CST 同为整分钟偏移，floor 一致）。
    pub fn minute_floor(ts: DateTime<Utc>) -> DateTime<Utc> {
        ts.with_second(0).and_then(|t| t.with_nanosecond(0)).expect("valid minute floor")
    }

    /// 本地合成近似 1m bar（§6）：OHLC≈快照价、volume/amount 差分估算或 0、source=*_approx。
    pub fn synthesize(code: &Code, q: &Quote, prev: Option<&Quote>, minute_start: DateTime<Utc>) -> Bar {
        Bar {
            code: code.clone(),
            period: Period::M1,
            ts: minute_start,
            open: q.last, high: q.last, low: q.last, close: q.last,
            volume: prev.map(|p| q.volume.saturating_sub(p.volume)).unwrap_or(0),
            amount: prev.map(|p| (q.amount - p.amount).max(0.0)).unwrap_or(0.0),
            source: q.source.approx().expect("快照池源必有近似变体（domain SourceId::approx）"),
        }
    }

    /// 恢复探测口径：Tier1 有可用源即可探测（§6：HalfOpen 探测成功 → 回切）。
    pub fn should_probe_recover(healthy_tier1: &[SourceId]) -> bool { !healthy_tier1.is_empty() }

    fn is_muted(&self, src: SourceId, now: DateTime<Utc>) -> bool {
        self.muted_until.lock().unwrap().get(&src).map(|u| now < *u).unwrap_or(false)
    }

    fn record_failure(&self, src: SourceId, now: DateTime<Utc>) {
        let mut fc = self.fail_counts.lock().unwrap();
        let n = fc.entry(src).or_insert(0);
        *n = (*n + 1).min(10);
        self.muted_until.lock().unwrap().insert(src, now + Self::tier2_backoff(*n - 1));
    }

    fn record_success(&self, src: SourceId) {
        self.fail_counts.lock().unwrap().remove(&src);
        self.muted_until.lock().unwrap().remove(&src);
    }

    /// 降级模式单次轮询：快照池随机打乱后逐源尝试（跳过退避中的源）。
    pub async fn poll_once(&self, code: &Code) -> Result<Bar, ProviderError> {
        let now = self.clock.now();
        let mut order: Vec<&Arc<dyn SnapshotProvider>> = self.pool.iter().collect();
        order.shuffle(&mut rand::thread_rng()); // §6：每次随机打乱（非固定优先级）
        let mut last_err = ProviderError::NoData;
        for p in order {
            let src = p.id();
            if self.is_muted(src, now) { continue; }
            match p.fetch_snapshot(std::slice::from_ref(code)).await {
                Ok(quotes) => {
                    match quotes.into_iter().find(|q| q.code == *code) {
                        Some(q) => {
                            self.record_success(src);
                            let prev = self.last_quotes.lock().unwrap().get(code).cloned();
                            let bar = Self::synthesize(code, &q, prev.as_ref(), Self::minute_floor(now));
                            self.last_quotes.lock().unwrap().insert(code.clone(), q);
                            return Ok(bar);
                        }
                        None => { self.record_failure(src, now); }
                    }
                }
                Err(e) => { self.record_failure(src, now); last_err = e; }
            }
        }
        Err(last_err)
    }
}
```

### 9.8 Scheduler（§2 相位对齐 + 热生效）

``` {.rust file=crates/collector/src/scheduler.rs}
//! 调度：每 code 独立 ticker，分钟边界相位对齐 + 0~2s 抖动；每周期重读 symbols 热生效（service.rs）。

use crate::calendar::{is_weekday, trading_minutes};
use chrono::{DateTime, TimeZone, Timelike, Utc};
use domain::tz::utc_to_cst;

/// 下一 tick：ceil(now/interval)*interval + jitter(0~2s)（interval>=60，分钟边界相位对齐）。
pub fn next_tick_after(now: DateTime<Utc>, interval_secs: u64, jitter_seed: u64) -> DateTime<Utc> {
    let iv = interval_secs.max(60) as i64;
    let next = (now.timestamp() / iv + 1) * iv;
    let jitter = (jitter_seed % 3) as i64; // 0~2s 防同刻齐发
    Utc.timestamp_opt(next + jitter, 0).single().expect("valid ts")
}

/// 首写胜出重叠根数（§3：每次拉取含最近 3 根已有 bar 的重叠）。
pub const OVERLAP_BARS: usize = 3;

/// 本周期抓取 limit：当日剩余交易分钟数 + 3 根重叠（§3）。非交易日/已收盘 → 0（跳过）。
pub fn fetch_limit(now: DateTime<Utc>) -> usize {
    let cst = utc_to_cst(now);
    if !is_weekday(cst.date()) { return 0; }
    let cur_floor = cst.with_second(0).and_then(|t| t.with_nanosecond(0));
    let Some(cur) = cur_floor else { return 0 };
    let remaining = trading_minutes(cst.date()).into_iter().filter(|m| *m >= cur).count();
    if remaining == 0 { 0 } else { remaining + OVERLAP_BARS }
}
```

### 9.9 CollectorService（运行时装配，薄胶合；状态机与纯函数已单测覆盖）

``` {.rust file=crates/collector/src/service.rs}
//! 运行时装配：reconcile 循环（60s 重读 symbols 热生效）+ 每 code 抓取循环
//! + 缺口回填循环（启动即跑 + 每 30min）。降级模式内层循环 5-10s 轮询快照。
//!
//! 注：本模块为薄胶合（tokio 任务编排），行为逻辑均在已单测的组件内。
//! §2 注记：非交易时段调度静默跳过（不为每分钟每标的刷 NA 事件噪音）；
//! NA 事件口径由源端 NoData 响应承载（§7），与 028 一致。

use crate::calendar::WeekdayCalendar;
use crate::clock::Clock;
use crate::executor::{FetchExecutor, FetchOutcome};
use crate::gapfill::{GapBackfiller, BACKFILL_INTERVAL};
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
        registry: Arc<dyn SymbolRegistry>,
        writer: Arc<dyn KlineWriter>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let calendar: Arc<dyn TradingCalendar> = Arc::new(WeekdayCalendar::new(clock.clone()));
        Self { executor, standby, gapfill, registry, calendar, writer, clock }
    }

    /// 主循环：reconcile（60s）+ 缺口回填（30min）。
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
```

### 9.10 测试（mock Provider + fake clock，不触网）

公共测试设施（内存版端口实现）：

``` {.rust file=crates/collector/tests/common/mod.rs}
//! 测试公共设件：内存 EventSink / KlineWriter / RawBarReader / SymbolRegistry + 脚本化 mock Provider。
#![allow(dead_code)]

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use domain::ports::{EventSink, HealthEvent, KlineWriter, RawBarReader, SymbolRegistry};
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::types::*;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Default)]
pub struct MemSink { pub events: Mutex<Vec<HealthEvent>> }

#[async_trait]
impl EventSink for MemSink {
    async fn emit(&self, ev: HealthEvent) -> anyhow::Result<()> {
        self.events.lock().unwrap().push(ev);
        Ok(())
    }
}

impl MemSink {
    pub fn kinds(&self) -> Vec<Option<String>> {
        self.events.lock().unwrap().iter().map(|e| e.err_kind.map(|k| k.as_str().to_string())).collect()
    }
}

#[derive(Default)]
pub struct MemWriter { pub bars: Mutex<Vec<Bar>> }

#[async_trait]
impl KlineWriter for MemWriter {
    async fn write_batch(&self, bars: &[Bar]) -> anyhow::Result<usize> {
        // 模拟首写胜出：同 (code,ts) 已存在则跳过
        let mut g = self.bars.lock().unwrap();
        let mut n = 0;
        for b in bars {
            if !g.iter().any(|x| x.code == b.code && x.ts == b.ts) { g.push(b.clone()); n += 1; }
        }
        Ok(n)
    }
}

pub type TsKey = (String, NaiveDate);

#[derive(Default)]
pub struct MemReader { pub ts: Mutex<HashMap<TsKey, HashSet<DateTime<Utc>>>> }

#[async_trait]
impl RawBarReader for MemReader {
    async fn existing_ts(&self, code: &Code, date: NaiveDate)
        -> anyhow::Result<HashSet<DateTime<Utc>>> {
        Ok(self.ts.lock().unwrap().get(&(code.0.clone(), date)).cloned().unwrap_or_default())
    }
}

pub struct MemRegistry {
    pub codes: Mutex<Vec<(Code, u64)>>,
}

#[async_trait]
impl SymbolRegistry for MemRegistry {
    async fn enabled_codes(&self) -> anyhow::Result<Vec<Code>> {
        Ok(self.codes.lock().unwrap().iter().map(|(c, _)| c.clone()).collect())
    }
    async fn interval_secs(&self, code: &Code) -> anyhow::Result<u64> {
        Ok(self.codes.lock().unwrap().iter().find(|(c, _)| c == code)
            .map(|(_, i)| *i).unwrap_or(60))
    }
    async fn upsert(&self, code: Code, interval_secs: u64, _enabled: bool) -> anyhow::Result<()> {
        self.codes.lock().unwrap().push((code, interval_secs));
        Ok(())
    }
}

/// 脚本化 mock Provider：按序返回预设结果，记录调用。
pub struct MockMinute {
    pub id: SourceId,
    pub results: Mutex<Vec<Result<Vec<Bar>, ProviderError>>>,
    pub calls: Mutex<usize>,
}

impl MockMinute {
    pub fn new(id: SourceId, results: Vec<Result<Vec<Bar>, ProviderError>>) -> Self {
        Self { id, results: Mutex::new(results), calls: Mutex::new(0) }
    }
    pub fn calls(&self) -> usize { *self.calls.lock().unwrap() }
}

#[async_trait]
impl MinuteKlineProvider for MockMinute {
    fn id(&self) -> SourceId { self.id }
    async fn fetch_m1(&self, _code: &Code, _limit: usize) -> Result<Vec<Bar>, ProviderError> {
        *self.calls.lock().unwrap() += 1;
        let mut g = self.results.lock().unwrap();
        if g.is_empty() { Err(ProviderError::NoData) } else { g.remove(0) }
    }
}

pub fn bar(code: &str, h: u32, mi: u32, src: SourceId) -> Bar {
    Bar {
        code: Code(code.into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 3, h, mi, 0).unwrap(),
        open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 100, amount: 100.0, source: src,
    }
}

pub fn quote(code: &str, last: f64, vol: u64, amt: f64, src: SourceId) -> Quote {
    Quote {
        code: Code(code.into()), last, prev_close: last, volume: vol, amount: amt,
        data_ts: Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap(), source: src,
    }
}
```

``` {.rust file=crates/collector/tests/calendar_test.rs}
//! TradingCalendar / 交易分钟序列（fake clock）。

use chrono::{NaiveDate, TimeZone, Utc};
use collector::calendar::*;
use collector::clock::FakeClock;
use domain::ports::TradingCalendar;
use std::sync::Arc;

fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }

#[test]
fn trading_minutes_240_and_lunch_boundary() {
    let mins = trading_minutes(d(2026, 9, 3)); // 周四
    assert_eq!(mins.len(), 240);
    // 上午 09:30..=11:29、下午 13:00..=14:59；午休边界不误判
    assert!(is_trading_minute(hm(9, 30)));
    assert!(is_trading_minute(hm(11, 29)));
    assert!(!is_trading_minute(hm(11, 30)), "11:30 属午休");
    assert!(!is_trading_minute(hm(12, 59)));
    assert!(is_trading_minute(hm(13, 0)), "13:00 属午后首节");
    assert!(is_trading_minute(hm(14, 59)));
    assert!(!is_trading_minute(hm(15, 0)), "15:00 已收盘（bar 起始时刻口径）");
    assert!(!is_trading_minute(hm(9, 29)));
}

#[test]
fn weekday_calendar_with_fake_clock() {
    // 2026-09-03 是周四；2026-09-05 是周六
    assert!(is_weekday(d(2026, 9, 3)));
    assert!(!is_weekday(d(2026, 9, 5)));
    // 09:35 CST = 01:35 UTC → 交易中
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let cal = WeekdayCalendar::new(clock.clone());
    assert!(cal.is_trading_now());
    // 推进到午休 12:00 CST = 04:00 UTC
    clock.advance(chrono::Duration::minutes(145));
    assert!(!cal.is_trading_now());
    // 推进到周六 10:00 CST（= 9-5 02:00 UTC）
    let sat = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap()));
    assert!(!WeekdayCalendar::new(sat).is_trading_now());
}
```

``` {.rust file=crates/collector/tests/circuit_test.rs}
//! 熔断状态机全迁移路径（fake clock + 内存 sink）。

mod common;

use chrono::{Duration, TimeZone, Utc};
use collector::circuit::{CircuitRegistry, CircuitState};
use collector::clock::FakeClock;
use common::MemSink;
use domain::ports::HealthMonitor;
use domain::types::{Health, SourceId};
use std::sync::Arc;

const S: SourceId = SourceId::TencentIfzq;

fn setup() -> (Arc<CircuitRegistry>, Arc<FakeClock>, Arc<MemSink>) {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()));
    let sink = Arc::new(MemSink::default());
    let reg = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock.clone(), sink.clone()));
    (reg, clock, sink)
}

#[tokio::test]
async fn three_failures_open_then_cooldown_halfopen_then_close() {
    let (reg, clock, sink) = setup();
    for _ in 0..2 { reg.report_failure(S, "http").await; }
    assert_eq!(reg.state(S).await, CircuitState::Healthy, "2 次失败不熔断");
    assert!(reg.healthy_minute_sources().await.contains(&S));
    reg.report_failure(S, "timeout").await;
    assert_eq!(reg.state(S).await, CircuitState::Open, "连续 3 次失败 → Open");
    assert!(!reg.healthy_minute_sources().await.contains(&S), "熔断源从健康池摘除");
    assert!(sink.kinds().contains(&Some("circuit_open".into())));
    assert_eq!(reg.health(S).await, Health::CircuitOpen);
    // 冷却 59s 仍 Open；60s 后懒迁移 HalfOpen + 事件
    clock.advance(Duration::seconds(59));
    assert_eq!(reg.state(S).await, CircuitState::Open);
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
    assert!(sink.kinds().contains(&Some("circuit_halfopen".into())));
    // HalfOpen 单次成功 → Healthy + circuit_closed
    reg.report_success(S, 100).await;
    assert_eq!(reg.state(S).await, CircuitState::Healthy);
    assert!(sink.kinds().contains(&Some("circuit_closed".into())));
    assert!(reg.healthy_minute_sources().await.contains(&S));
}

#[tokio::test]
async fn halfopen_failure_reopens_with_doubled_cooldown_capped_30min() {
    let (reg, clock, _sink) = setup();
    for _ in 0..3 { reg.report_failure(S, "http").await; }
    clock.advance(Duration::seconds(60));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
    reg.report_failure(S, "http").await; // HalfOpen 失败 → Open，冷却 ×2 = 120s
    assert_eq!(reg.state(S).await, CircuitState::Open);
    clock.advance(Duration::seconds(119));
    assert_eq!(reg.state(S).await, CircuitState::Open);
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
    // 连续翻倍封顶 30min：再失败 → 240s，再失败 → 480s ... 验证不超过 1800s
    let mut cooldown = 240u64;
    for _ in 0..6 {
        reg.report_failure(S, "http").await;
        clock.advance(Duration::seconds(cooldown.min(1800) as i64 - 1));
        assert_eq!(reg.state(S).await, CircuitState::Open, "冷却 {cooldown}s 未到不迁移");
        clock.advance(Duration::seconds(1));
        assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
        reg.report_failure(S, "http").await; // 立即再打回 Open
        cooldown *= 2;
    }
    clock.advance(Duration::seconds(1800));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen, "冷却封顶 30min 后必到期");
}

#[tokio::test]
async fn rate_limited_backoff_ladder_not_circuit() {
    let (reg, clock, _sink) = setup();
    reg.report_failure(S, "rate_limited").await;
    assert_eq!(reg.state(S).await, CircuitState::Healthy, "限流不进熔断");
    assert_eq!(reg.health(S).await, Health::Degraded, "退避中为 Degraded");
    assert!(!reg.healthy_minute_sources().await.contains(&S), "退避期静默该源");
    clock.advance(Duration::seconds(5));
    assert!(reg.healthy_minute_sources().await.contains(&S), "5s 退避档到期恢复");
    reg.report_failure(S, "rate_limited").await;
    clock.advance(Duration::seconds(9));
    assert_eq!(reg.health(S).await, Health::Degraded, "第二档 10s 未到期");
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.health(S).await, Health::Healthy);
    reg.report_failure(S, "rate_limited").await;
    clock.advance(Duration::seconds(29));
    assert_eq!(reg.health(S).await, Health::Degraded, "第三档 30s 未到期");
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.health(S).await, Health::Healthy);
    // 成功重置退避档
    reg.report_failure(S, "rate_limited").await;
    reg.report_success(S, 10).await;
    reg.report_failure(S, "rate_limited").await;
    clock.advance(Duration::seconds(5));
    assert_eq!(reg.health(S).await, Health::Healthy, "成功后退避档重置回 5s");
}

#[tokio::test]
async fn manual_reset_from_any_state() {
    let (reg, _clock, sink) = setup();
    for _ in 0..3 { reg.report_failure(S, "http").await; }
    assert_eq!(reg.state(S).await, CircuitState::Open);
    reg.manual_reset(S).await;
    assert_eq!(reg.state(S).await, CircuitState::Healthy);
    assert!(sink.kinds().contains(&Some("manual_reset".into())));
    assert!(reg.healthy_minute_sources().await.contains(&S));
}
```

``` {.rust file=crates/collector/tests/executor_test.rs}
//! FetchExecutor：首源成功不转移 / NoData 不计失败 / RateLimited 走退避不进熔断 /
//! 全链失败产出 code 级事件 / 当班源链首 / Trace ID 贯穿。

mod common;

use chrono::{TimeZone, Utc};
use collector::circuit::CircuitRegistry;
use collector::clock::FakeClock;
use collector::executor::*;
use common::*;
use domain::ports::HealthMonitor;
use domain::provider::ProviderError;
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;
use std::collections::HashMap;
use std::sync::Arc;

fn setup(t: Arc<MockMinute>, s: Arc<MockMinute>)
    -> (Arc<FetchExecutor>, Arc<MemWriter>, Arc<MemSink>, Arc<CircuitRegistry>) {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let sink = Arc::new(MemSink::default());
    let writer = Arc::new(MemWriter::default());
    let circuits = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock.clone(), sink.clone()));
    let mut providers: HashMap<SourceId, Arc<dyn domain::provider::MinuteKlineProvider>> = HashMap::new();
    providers.insert(SourceId::TencentIfzq, t);
    providers.insert(SourceId::SinaJsonp, s);
    let ex = Arc::new(FetchExecutor::new(
        providers,
        SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]),
        DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
        circuits.clone(), writer.clone(), sink.clone(), clock));
    (ex, writer, sink, circuits)
}

#[tokio::test]
async fn first_source_success_no_failover() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::TencentIfzq)])]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::SinaJsonp)])]));
    let (ex, writer, sink, _c) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    // 当班源（duty）放链首：用 duty_for 对齐期望
    let duty = duty_for(&DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
                        &code, Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap());
    let out = ex.fetch_one(&code, 10).await;
    let FetchOutcome::Ok { source, inserted, .. } = out else { panic!("应成功: {out:?}") };
    assert_eq!(source, duty, "当班源健康时先试当班源");
    assert_eq!(inserted, 1);
    let other_calls = if duty == SourceId::TencentIfzq { s.calls() } else { t.calls() };
    assert_eq!(other_calls, 0, "首源成功不转移");
    // 成功事件 + Trace ID 贯穿
    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].ok && events[0].err_kind.is_none() && events[0].latency_ms.is_some());
    assert_eq!(events[0].trace_id.as_deref().map(str::len), Some(32));
    assert_eq!(writer.bars.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn nodata_marks_na_no_failover_no_circuit() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![Err(ProviderError::NoData), Err(ProviderError::NoData)]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp, vec![Err(ProviderError::NoData), Err(ProviderError::NoData)]));
    let (ex, _w, sink, circuits) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    let duty = duty_for(&DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
                        &code, Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap());
    let other = if duty == SourceId::TencentIfzq { s.clone() } else { t.clone() };
    assert_eq!(ex.fetch_one(&code, 10).await, FetchOutcome::NoData);
    assert_eq!(other.calls(), 0, "NoData 不转移（本批次终止）");
    assert_eq!(sink.kinds(), vec![Some("na".to_string())], "ok=true + err_kind=na");
    // NoData 不计失败：连续两次后源仍健康
    assert_eq!(ex.fetch_one(&code, 10).await, FetchOutcome::NoData);
    assert!(circuits.healthy_minute_sources().await.contains(&duty));
}

#[tokio::test]
async fn rate_limited_failover_no_circuit_trip() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![
        Err(ProviderError::RateLimited), Err(ProviderError::RateLimited),
        Err(ProviderError::RateLimited), Ok(vec![bar("518880", 1, 35, SourceId::TencentIfzq)])]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::SinaJsonp)])]));
    let (ex, _w, sink, circuits) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    let out = ex.fetch_one(&code, 10).await;
    assert!(matches!(out, FetchOutcome::Ok { source: SourceId::SinaJsonp, .. }),
            "RateLimited 应转移下一源: {out:?}");
    assert!(sink.kinds().contains(&Some("rate_limited".into())));
    // 连续 3 次 RateLimited 不触发熔断（不进熔断计数）
    for _ in 0..3 { let _ = ex.fetch_one(&code, 10).await; }
    assert!(circuits.healthy_minute_sources().await.contains(&SourceId::TencentIfzq)
        || matches!(circuits.health(SourceId::TencentIfzq).await, Health::Degraded),
        "限流只进退避档，不熔断");
}

#[tokio::test]
async fn all_failed_emits_code_level_event_and_counts_circuit() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![Err(ProviderError::Timeout)]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp, vec![Err(ProviderError::Http("x".into()))]));
    let (ex, _w, sink, _c) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    assert_eq!(ex.fetch_one(&code, 10).await, FetchOutcome::AllFailed);
    let kinds = sink.kinds();
    assert!(kinds.contains(&Some("timeout".into())) && kinds.contains(&Some("http".into())),
            "每源失败事件分源记录: {kinds:?}");
    assert_eq!(kinds.last().unwrap(), &Some("all_failed".into()), "全链失败产出 code 级事件");
    // code 级事件带 code、trace 贯穿全链同一 trace_id
    let events = sink.events.lock().unwrap();
    let traces: std::collections::HashSet<_> = events.iter().filter_map(|e| e.trace_id.clone()).collect();
    assert_eq!(traces.len(), 1, "单次抓取全链共享同一 Trace ID");
    assert_eq!(events.last().unwrap().code, Some(Code("518880".into())));
}

#[tokio::test]
async fn circuit_open_source_excluded_from_chain() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![])); // 不会被调用
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::SinaJsonp)])]));
    let (ex, _w, _sink, circuits) = setup(t.clone(), s.clone());
    for _ in 0..3 { circuits.report_failure(SourceId::TencentIfzq, "http").await; }
    let out = ex.fetch_one(&Code("518880".into()), 10).await;
    assert!(matches!(out, FetchOutcome::Ok { source: SourceId::SinaJsonp, .. }));
    assert_eq!(t.calls(), 0, "熔断源不出现在 attempt_chain");
}
```

``` {.rust file=crates/collector/tests/gapfill_test.rs}
//! GapBackfiller：缺口集合计算（午休边界不误判）+ 只写缺失 ts（首写胜出）。

mod common;

use chrono::{NaiveDate, TimeZone, Utc};
use collector::circuit::CircuitRegistry;
use collector::clock::FakeClock;
use collector::executor::FetchExecutor;
use collector::gapfill::*;
use collector::calendar::trading_minutes;
use common::*;
use domain::ports::KlineWriter;
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

fn d() -> NaiveDate { NaiveDate::from_ymd_opt(2026, 9, 3).unwrap() } // 周四

#[test]
fn gaps_are_trading_minutes_minus_existing_only_past() {
    // now = 10:00 CST = 02:00 UTC
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    let mut existing = HashSet::new();
    // 已有 09:30-09:34（CST → UTC 01:30-01:34）
    for m in trading_minutes(d()).into_iter().take(5) {
        existing.insert(cst_to_utc(m));
    }
    let gaps = compute_gaps(&existing, d(), now);
    // 缺口 = 09:35..10:00（26 根，含 10:00 本分钟）；未来分钟不算缺口
    assert_eq!(gaps.len(), 26, "09:35..=10:00 共 26 根: {:?}", gaps.first());
    assert!(!gaps.contains(&cst_to_utc(trading_minutes(d())[0])), "已有 ts 不是缺口");
    // 午休时段永远不在分钟序列里（11:30-12:59 不产生缺口）——由 trading_minutes 保证
    let noon = Utc.with_ymd_and_hms(2026, 9, 3, 4, 30, 0).unwrap(); // 12:30 CST
    let gaps_noon = compute_gaps(&existing, d(), noon);
    assert!(gaps_noon.iter().all(|ts| {
        let cst = domain::tz::utc_to_cst(*ts);
        collector::calendar::is_trading_minute(cst.time())
    }), "缺口全为交易分钟（午休不误判）");
}

#[test]
fn gaps_empty_on_non_trading_day_or_other_date() {
    let now = Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap(); // 周六
    assert!(compute_gaps(&HashSet::new(), NaiveDate::from_ymd_opt(2026, 9, 5).unwrap(), now).is_empty());
    // now 与 date 不同日 → 空（只回填当日）
    let now2 = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();
    assert!(compute_gaps(&HashSet::new(), d(), now2).is_empty());
}

#[tokio::test]
async fn backfill_writes_only_missing_ts() {
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    let clock = Arc::new(FakeClock::new(now));
    let sink = Arc::new(MemSink::default());
    let writer = Arc::new(MemWriter::default());
    let reader = Arc::new(MemReader::default());
    // 已有 09:30 bar
    let existing_bar = bar("518880", 1, 30, SourceId::TencentIfzq);
    writer.write_batch(std::slice::from_ref(&existing_bar)).await.unwrap();
    reader.ts.lock().unwrap().insert(("518880".into(), d()),
        HashSet::from([existing_bar.ts]));
    // mock 源返回当日全 240 根（含已有的 09:30）
    let all: Vec<Bar> = trading_minutes(d()).into_iter().map(|t| Bar {
        code: Code("518880".into()), period: Period::M1, ts: cst_to_utc(t),
        open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
        source: SourceId::TencentIfzq,
    }).collect();
    // 双源均返回全量（duty 由 stable_seed 决定，任一当班都能成功承接）
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![Ok(all.clone())]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp, vec![Ok(all)]));
    let circuits = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock.clone(), sink.clone()));
    let mut providers: HashMap<SourceId, Arc<dyn domain::provider::MinuteKlineProvider>> = HashMap::new();
    providers.insert(SourceId::TencentIfzq, t);
    providers.insert(SourceId::SinaJsonp, s);
    let ex = Arc::new(FetchExecutor::new(providers,
        SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]),
        DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
        circuits, writer.clone(), sink.clone(), clock.clone()));
    let registry = Arc::new(MemRegistry { codes: std::sync::Mutex::new(vec![(Code("518880".into()), 60)]) });
    let bf = GapBackfiller::new(ex, reader.clone(), registry, clock);
    let touched = bf.backfill_today().await.unwrap();
    assert_eq!(touched, 1);
    // 首写胜出：mock 源返回全 240 根，已有的 09:30 冲突跳过不重复、其余全落
    let written = writer.bars.lock().unwrap();
    assert_eq!(written.len(), 240);
    assert_eq!(written.iter().filter(|b| b.ts == existing_bar.ts).count(), 1,
               "已有 ts 不重复落行（只写缺失 ts）");
}
```

``` {.rust file=crates/collector/tests/standby_test.rs}
//! StandbyReserve：近似 bar 合成 / 乱序轮询 / Tier2 指数退避 / 降级集管理。

mod common;

use chrono::{Duration, TimeZone, Utc};
use collector::clock::FakeClock;
use collector::standby::StandbyReserve;
use common::*;
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use std::sync::{Arc, Mutex};

struct MockSnap {
    id: SourceId,
    results: Mutex<Vec<Result<Vec<Quote>, ProviderError>>>,
    calls: Mutex<usize>,
}
impl MockSnap {
    fn new(id: SourceId, results: Vec<Result<Vec<Quote>, ProviderError>>) -> Self {
        Self { id, results: Mutex::new(results), calls: Mutex::new(0) }
    }
}
#[async_trait::async_trait]
impl SnapshotProvider for MockSnap {
    fn id(&self) -> SourceId { self.id }
    async fn fetch_snapshot(&self, _codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        *self.calls.lock().unwrap() += 1;
        let mut g = self.results.lock().unwrap();
        if g.is_empty() { Err(ProviderError::NoData) } else { g.remove(0) }
    }
}

#[test]
fn synthesize_approx_bar_from_quotes() {
    let code = Code("518880".into());
    let q1 = quote("518880", 8.9, 1000, 8900.0, SourceId::TencentQt);
    let q2 = quote("518880", 8.95, 1600, 14300.0, SourceId::TencentQt);
    let m = Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap();
    // 首个快照：volume/amount 估算为 0（无差分基准）
    let b1 = StandbyReserve::synthesize(&code, &q1, None, m);
    assert_eq!((b1.open, b1.high, b1.low, b1.close), (8.9, 8.9, 8.9, 8.9));
    assert_eq!(b1.volume, 0);
    assert_eq!(b1.source, SourceId::TencentQtApprox, "source=*_approx 物理可区分");
    assert!(b1.source.is_approx());
    // 有前快照：差分估算
    let b2 = StandbyReserve::synthesize(&code, &q2, Some(&q1), m);
    assert_eq!(b2.volume, 600);
    assert!((b2.amount - 5400.0).abs() < 1e-9);
}

#[test]
fn poll_delay_in_5_to_10s_and_backoff_exponential() {
    let mut rng = rand::thread_rng();
    for _ in 0..100 {
        let d = StandbyReserve::next_poll_delay(&mut rng);
        assert!((5..=10).contains(&d.as_secs()), "5-10s 含抖动: {d:?}");
    }
    assert_eq!(StandbyReserve::tier2_backoff(0), Duration::seconds(10));
    assert_eq!(StandbyReserve::tier2_backoff(1), Duration::seconds(20));
    assert_eq!(StandbyReserve::tier2_backoff(9), Duration::seconds(300), "封顶 300s");
}

#[tokio::test]
async fn poll_once_success_then_volume_diff() {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 20).unwrap()));
    let p = Arc::new(MockSnap::new(SourceId::TencentQt, vec![
        Ok(vec![quote("518880", 8.9, 1000, 8900.0, SourceId::TencentQt)]),
        Ok(vec![quote("518880", 8.95, 1600, 14300.0, SourceId::TencentQt)]),
    ]));
    let pool: Vec<Arc<dyn SnapshotProvider>> = vec![p];
    let standby = StandbyReserve::new(pool, clock.clone());
    let code = Code("518880".into());
    standby.activate(&code);
    assert!(standby.is_degraded(&code));
    let b1 = standby.poll_once(&code).await.unwrap();
    assert_eq!(b1.ts, Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap(), "分钟边界对齐");
    assert_eq!(b1.volume, 0);
    clock.advance(Duration::seconds(60));
    let b2 = standby.poll_once(&code).await.unwrap();
    assert_eq!(b2.volume, 600, "跨快照量差分估算");
    assert_eq!(b2.source, SourceId::TencentQtApprox);
    standby.deactivate(&code);
    assert!(!standby.is_degraded(&code));
}

#[tokio::test]
async fn tier2_failure_backs_off_source() {
    // 单源池（确定性）：失败 → 指数退避冷却，退避期内不再请求该源（不轰击）
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let bad = Arc::new(MockSnap::new(SourceId::ThsCs, vec![
        Err(ProviderError::Timeout), Err(ProviderError::Timeout), Err(ProviderError::Timeout)]));
    let pool: Vec<Arc<dyn SnapshotProvider>> = vec![bad.clone()];
    let standby = StandbyReserve::new(pool, clock.clone());
    let code = Code("518880".into());
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 1);
    clock.advance(Duration::seconds(5)); // 退避 10s 未到期
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 1, "退避期内不再请求该源（不轰击）");
    clock.advance(Duration::seconds(6)); // 退避到期
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 2, "退避到期后可再试");
    clock.advance(Duration::seconds(15)); // 第二次退避 20s 未到期
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 2, "退避档 ×2 生效");
}

#[tokio::test]
async fn poll_falls_through_shuffled_pool_to_healthy_source() {
    // 首源失败 → 乱序池中落到健康源（每次随机打乱，行为口径：任一可用源即可承接）
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let bad = Arc::new(MockSnap::new(SourceId::ThsCs, vec![
        Err(ProviderError::Timeout), Err(ProviderError::Timeout), Err(ProviderError::Timeout),
        Err(ProviderError::Timeout), Err(ProviderError::Timeout)]));
    let good = Arc::new(MockSnap::new(SourceId::SinaHq, vec![
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)])]));
    let pool: Vec<Arc<dyn SnapshotProvider>> = vec![bad.clone(), good.clone()];
    let standby = StandbyReserve::new(pool, clock.clone());
    let code = Code("518880".into());
    let b = standby.poll_once(&code).await.unwrap();
    assert_eq!(b.source, SourceId::SinaHqApprox, "坏源失败应由健康源承接");
}

#[test]
fn should_probe_recover_only_when_tier1_available() {
    assert!(!StandbyReserve::should_probe_recover(&[]));
    assert!(StandbyReserve::should_probe_recover(&[SourceId::SinaJsonp]));
}
```

``` {.rust file=crates/collector/tests/scheduler_test.rs}
//! Scheduler：相位对齐 + 抖动 + fetch_limit 口径。

use chrono::{TimeZone, Utc};
use collector::scheduler::*;

#[test]
fn next_tick_aligns_minute_boundary_with_jitter() {
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 10).unwrap();
    for seed in 0..30u64 {
        let next = next_tick_after(now, 60, seed);
        assert!(next > now);
        assert_eq!(next.timestamp() % 60, (seed % 3) as i64, "分钟边界 + 0~2s 抖动");
        assert!((0..=2).contains(&(next.timestamp() % 60)));
        assert!(next.timestamp() - now.timestamp() <= 63);
    }
    // interval 300s：对齐 5 分钟边界
    let next5 = next_tick_after(Utc.with_ymd_and_hms(2026, 9, 3, 1, 31, 0).unwrap(), 300, 0);
    assert_eq!(next5.timestamp() % 300, 0);
    // interval < 60 抬到 60（symbols CHECK interval_secs>=60 双保险）
    let n = next_tick_after(now, 30, 0);
    assert_eq!(n.timestamp() % 60, 0);
}

#[test]
fn fetch_limit_remaining_plus_overlap() {
    // 10:00 CST = 02:00 UTC：已过 09:30..09:59 共 30 根 → 剩余 210（含 10:00 本分钟），+3 重叠
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    assert_eq!(fetch_limit(now), 210 + OVERLAP_BARS);
    // 午休 12:30 CST：剩余 120 根下午 +3
    let noon = Utc.with_ymd_and_hms(2026, 9, 3, 4, 30, 0).unwrap();
    assert_eq!(fetch_limit(noon), 120 + OVERLAP_BARS);
    // 盘后 15:30 CST → 0；周六 → 0
    assert_eq!(fetch_limit(Utc.with_ymd_and_hms(2026, 9, 3, 7, 30, 0).unwrap()), 0);
    assert_eq!(fetch_limit(Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap()), 0);
}
```
