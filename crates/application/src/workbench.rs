//! `WorkbenchService`（application 层，12-strategy-system / P3a；手写，非 tangle）。
//! 依赖注入 domain 端口（`BacktestBarRead`/`StrategyRunStore`/`StrategyPresetStore`/`StrategyStore`/
//! `SymbolRegistry`/`StrategyRunProgressSink`/`Clock`）+ `strategy-core`（EnsembleEngine 观察者入口）；
//! 不依赖 web/storage/sqlx（DI 由 app bin 装配）。
//!
//! 职责（ADR 12-strategy-system §6 管线 / §8 接口 / §11 P3 范围 / §13.4 全量落库 / §13.5 组合预设）：
//! - **任务制 ensemble 运行**（与 BacktestService 同模式）：submit 校验 → 入库 queued →
//!   `tokio::spawn` 后台任务（`Semaphore` 限并发）→ `mark_started` 原子认领（queued→running，
//!   防「排队期被取消后又被执行」）→ `spawn_blocking` 跑
//!   `strategy_core::run_ensemble_with_quickjs_observed`（QuickJS 非 Send 实例在闭包内创建/drop）→
//!   观察者钩子（每 bar 末回调点）做两件事：①进度经 mpsc 桥接到异步报告任务
//!   （WS sink + store.update_progress，0..1，按 0.1% 粒度节流）；②**协作式取消**——
//!   检查内存取消标记（cancel() 设置），置位即 `LoopControl::Break` → `EnsembleError::Canceled`
//!   → 落 canceled（不落结果）。完成 `mark_succeeded`（同事务落五 jsonb 结果）/ 插件错误
//!   `mark_failed`。
//! - **运行钉住快照**：submit 时把 (strategy_id, version_id, version, sha256, params[缺省填充],
//!   weight, archived) 快照进 `config`（复现前提，published 不可变由 0022 trigger 保证 sha256 不失配；
//!   `archived` 为审计标记——2026-09-10 裁决：archived 版本允许审计重跑）。
//! - 提交校验全路径（400/404）：版本存在（404）且非 draft（400；published|archived 可运行——
//!   archived 为审计重跑，draft 未发布代码不可运行）；symbol 已注册（400）；
//!   区间上限 D1≤5年 / 分钟级≤3个月（400）；slots 1..=10；weight>0；params 按 schema 校验填充；
//!   阈值/Policy 经 `EnsembleConfig::validate`（strategy-core）；Stop value 正有限；fee 三字段；
//!   bar 数 >20 万拒绝（400）。
//! - 查询：get_run / list_runs（分页+状态过滤）/ compare（并排 net_value+metrics，输入序，
//!   未知/未成功跳过）。
//! - 组合预设：create/list/get/update/delete/apply（apply=返回钉住 config 供 submit 用；
//!   重名 409——预检查 find_preset_by_name，DB UNIQUE 兜底）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::Semaphore;

use domain::ports::{
    BacktestBarRead, Clock, NewStrategyPreset, NewStrategyRun, StrategyPresetRow,
    FeeProfileStore, StrategyPresetStore, StrategyRunFilter, StrategyRunResult, StrategyRunStore,
    StrategyRunView, StrategyStore, SymbolRegistry,
};
use strategy_core::{EnsembleConfig, EnsembleError, ExecutionPolicy, LoopControl, StopConfig};
use strategy_runtime::StrategyParams;

use crate::fee::{resolve_fee, to_fee_model};
use crate::strategy::{
    fill_and_validate_params, new_id, schema_from_json, D1_MAX_SPAN_DAYS, MINUTE_MAX_SPAN_DAYS,
};

/// 单次 ensemble 运行并发上限（与回测同口径，ADR §7 默认 4；由 DI 传入）。
pub static DEFAULT_MAX_CONCURRENT: usize = 4;

/// 提交时 bar 数上限（per_bar 全量落库前提下的包体/内存护栏）：>20 万 bar 拒绝 400。
pub const MAX_BARS: usize = 200_000;

/// 进度上报节流粒度：0.1%（每 bar 回调仅当千分位前进或最后一 bar 才发帧，防 20 万帧洪泛）。
const PROGRESS_THROTTLE_MILLI: f64 = 1000.0;

/// 默认初始资金（与回测/试算一致，ADR §4）。
const DEFAULT_INITIAL_CAPITAL: f64 = 100_000.0;

/// I-2/D6：缺省前置预热根数（架构师 2026-09-12 裁决；与试算同值）。
pub const DEFAULT_WARMUP_BARS: usize = 250;

// ── 错误类型（web 映射：NotFound→404 / Conflict→409 / Validation→400）──

/// 未找到（run/preset/版本）。web 映射 404。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkbenchNotFound(pub String);
impl std::fmt::Display for WorkbenchNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for WorkbenchNotFound {}

/// 冲突（终态取消 / 预设重名）。web 映射 409。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkbenchConflict(pub String);
impl std::fmt::Display for WorkbenchConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for WorkbenchConflict {}

/// 校验失败（入参/区间/配置/bar 数）。web 映射 400。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkbenchValidation(pub String);
impl std::fmt::Display for WorkbenchValidation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for WorkbenchValidation {}

// ── 请求/响应类型 ──

/// 提交槽位（web 层 JSON 解析后传入）。
#[derive(Debug, Clone, PartialEq)]
pub struct SlotReq {
    /// 已发布版本 id（sv_ 前缀）。
    pub version_id: String,
    /// 参数（按版本 schema 校验/缺省填充；缺省 `{}`）。
    pub params: serde_json::Value,
    /// 聚合权重（>0 有限）。
    pub weight: f64,
}

/// 提交运行请求（web 层已完成 from/to RFC3339 解析与 from<to 预校验）。
#[derive(Debug, Clone, PartialEq)]
pub struct SubmitRunReq {
    /// 运行名（可空字符串，缺省 ''）。
    pub name: String,
    pub symbol: String,
    pub period: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub slots: Vec<SlotReq>,
    /// 缺省 60（ADR §6）。
    pub buy_threshold: Option<f64>,
    /// 缺省 40（ADR §6）。
    pub sell_threshold: Option<f64>,
    /// ExecutionPolicy JSON（serde 外部标签：`{"LumpSum":{"position_pct":..}}` / `{"Dca":{..}}`）。
    pub policy: serde_json::Value,
    /// StopConfig JSON（可空 = 无硬止损）。
    pub stop: Option<serde_json::Value>,
    /// 缺省 100_000。
    pub initial_capital: Option<f64>,
    /// `{rate_pct, min_fee, slippage_bp, stamp_duty_pct?}`；**None = 未显式传** →
    /// 按标的 `type` 查 `fee_profiles` 解析默认值（ADR-019 D11-3），无档案 → 回落旧 ADR bt-1 默认。
    pub fee: Option<serde_json::Value>,
    /// I-2/D6：前置预热根数（缺省 [`DEFAULT_WARMUP_BARS`]=250；0 = 无预热）。
    pub warmup_bars: usize,
}

/// compare 并排条目（前端净值叠加 + 绩效并排，ADR §13.5）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CompareItem {
    pub run_id: String,
    pub name: String,
    pub symbol: String,
    pub period: String,
    pub net_value: serde_json::Value,
    pub metrics: serde_json::Value,
}

/// 校验后的槽位（内部；钉住快照 + 运行素材）。
struct ValidatedSlot {
    strategy_id: String,
    version_id: String,
    version: i32,
    sha256: String,
    code: String,
    params: StrategyParams,
    params_json: serde_json::Value,
    weight: f64,
    /// 审计标记：archived 版本提交的运行（2026-09-10 裁决审计重跑），钉入 config 快照。
    archived: bool,
}

/// 回测工作台服务。
pub struct WorkbenchService {
    bar_read: Arc<dyn BacktestBarRead>,
    run_store: Arc<dyn StrategyRunStore>,
    preset_store: Arc<dyn StrategyPresetStore>,
    strategies: Arc<dyn StrategyStore>,
    symbols: Arc<dyn SymbolRegistry>,
    progress: Arc<dyn domain::ports::StrategyRunProgressSink>,
    clock: Arc<dyn Clock>,
    /// ADR-019 D11-3：费率档案读端口（None = 未装配 → 保持旧默认行为，向后兼容既有测试装配）。
    fee_profiles: Option<Arc<dyn FeeProfileStore>>,
    semaphore: Arc<Semaphore>,
    /// running 运行取消标记（协作式：引擎 observer 回调点检查）。
    cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl WorkbenchService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        bar_read: Arc<dyn BacktestBarRead>,
        run_store: Arc<dyn StrategyRunStore>,
        preset_store: Arc<dyn StrategyPresetStore>,
        strategies: Arc<dyn StrategyStore>,
        symbols: Arc<dyn SymbolRegistry>,
        progress: Arc<dyn domain::ports::StrategyRunProgressSink>,
        clock: Arc<dyn Clock>,
        max_concurrent: usize,
    ) -> Self {
        Self {
            bar_read,
            run_store,
            preset_store,
            strategies,
            symbols,
            progress,
            clock,
            fee_profiles: None,
            semaphore: Arc::new(Semaphore::new(max_concurrent.max(1))),
            cancel_flags: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// ADR-019 D11-3：装配费率档案端口（app bin 调用）。未装配 = 不按类型推断（旧行为）。
    pub fn with_fee_profiles(mut self, store: Arc<dyn FeeProfileStore>) -> Self {
        self.fee_profiles = Some(store);
        self
    }

    /// 提交 ensemble 运行：校验全路径 → 钉住快照入库 queued → 后台任务异步执行。
    /// 返回 queued 行（web 201）。
    pub async fn submit(&self, req: SubmitRunReq) -> anyhow::Result<StrategyRunView> {
        if req.symbol.trim().is_empty() {
            return Err(WorkbenchValidation("symbol 必填".into()).into());
        }
        // symbol 已注册（400）。
        let symbol = req.symbol.trim().to_string();
        let enabled = self.symbols.enabled_codes().await?;
        if !enabled.iter().any(|c| c.0 == symbol) {
            return Err(WorkbenchValidation(format!("symbol 未注册: {symbol}")).into());
        }
        let (domain_period, bt_period) = crate::bar_map::parse_period(&req.period)
            .map_err(|e| WorkbenchValidation(e.to_string()))?;
        if req.from >= req.to {
            return Err(WorkbenchValidation("from 须早于 to".into()).into());
        }
        // 区间上限（400）：D1 ≤ 5 年；分钟级 ≤ 3 个月（与试算同口径；H1 按日线档）。
        let span_days = (req.to - req.from).num_days();
        let limit_days = match domain_period {
            domain::types::Period::D1 | domain::types::Period::H1 => D1_MAX_SPAN_DAYS,
            _ => MINUTE_MAX_SPAN_DAYS,
        };
        if span_days > limit_days {
            return Err(WorkbenchValidation(format!(
                "运行区间超限：{} 跨度 {span_days} 天 > 上限 {limit_days} 天",
                req.period
            ))
            .into());
        }
        // slots 1..=10。
        if req.slots.is_empty() || req.slots.len() > 10 {
            return Err(WorkbenchValidation(format!(
                "slots 数量须为 1..=10，got {}",
                req.slots.len()
            ))
            .into());
        }
        // 槽位钉住校验（版本存在 404 / draft 400——published|archived 可运行 / weight>0 / params schema 校验填充）。
        let mut slots = Vec::with_capacity(req.slots.len());
        for s in &req.slots {
            slots.push(self.validate_slot(s).await?);
        }
        // 阈值/Policy/资金 经 strategy-core validate（400）。
        let buy = req.buy_threshold.unwrap_or(strategy_core::DEFAULT_BUY_THRESHOLD);
        let sell = req.sell_threshold.unwrap_or(strategy_core::DEFAULT_SELL_THRESHOLD);
        let policy: ExecutionPolicy = serde_json::from_value(req.policy.clone())
            .map_err(|e| WorkbenchValidation(format!("policy 非法: {e}")))?;
        let stop: Option<StopConfig> = match &req.stop {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => {
                let sc: StopConfig = serde_json::from_value(v.clone())
                    .map_err(|e| WorkbenchValidation(format!("stop 非法: {e}")))?;
                if !sc.value.is_finite() || sc.value <= 0.0 {
                    return Err(WorkbenchValidation(format!(
                        "stop.value 须为正有限值，got {}",
                        sc.value
                    ))
                    .into());
                }
                Some(sc)
            }
        };
        let initial_capital = req.initial_capital.unwrap_or(DEFAULT_INITIAL_CAPITAL);
        // ADR-019 D11-3 + v1.1 R-2：fee 按**字段优先级**解析（显式字段 > 按标的 type 查档案 > 旧 ADR bt-1 默认）。
        let profile = match &self.fee_profiles {
            Some(store) => store.for_symbol(&symbol).await?,
            None => None,
        };
        let resolved = resolve_fee(req.fee.as_ref(), profile)
            .map_err(|e| WorkbenchValidation(e.to_string()))?;
        let fee = resolved.model;
        let mut probe = EnsembleConfig {
            slots: vec![], // validate 不检视 slots（零 slot 合法）；钉住校验已先行
            buy_threshold: buy,
            sell_threshold: sell,
            policy,
            stop,
            initial_capital,
            fee,
            period: bt_period,
            warmup_bars: 0,
            runtime_limits: strategy_runtime::RuntimeLimits::default(),
        };
        probe.validate().map_err(WorkbenchValidation)?;

        // 读 bar + 数量护栏（提交时拒绝：空区间 / >20 万 bar → 400）。
        // I-2/D6：一次性拉取 [warmup_start, to)（前置预热），再按 from 切分。
        let warmup_requested = req.warmup_bars;
        let warmup_start = if warmup_requested == 0 {
            req.from
        } else {
            req.from - crate::bar_map::warmup_lookback(&domain_period, warmup_requested)
        };
        let all: Vec<backtest::Bar> = self
            .bar_read
            .bars(&symbol, &domain_period, warmup_start, req.to)
            .await?
            .iter()
            .map(crate::bar_map::to_bt_bar)
            .collect();
        let split = all
            .iter()
            .position(|b| b.ts >= req.from.timestamp())
            .unwrap_or(all.len());
        let warmup_effective = split.min(warmup_requested);
        let slice_start = split - warmup_effective;
        let bars: Vec<backtest::Bar> = all[slice_start..].to_vec();
        if bars.len() == warmup_effective {
            return Err(WorkbenchValidation(format!(
                "区间内无 K 线数据（{symbol} {} {}~{}）",
                req.period, req.from, req.to
            ))
            .into());
        }
        if bars.len() > MAX_BARS {
            return Err(WorkbenchValidation(format!(
                "bar 数 {} 超上限 {MAX_BARS}（per_bar 全量落库护栏）",
                bars.len()
            ))
            .into());
        }
        // I-2/D6：引擎按 warmup_effective 标记前缀（不执行/不计绩效）。
        probe.warmup_bars = warmup_effective;

        // 钉住快照（复现前提）：slots 全字段 + 阈值 + policy/stop 原文 + 资金 + **生效** fee。
        // `archived` 为审计标记（2026-09-10 裁决：archived 版本可审计重跑，避免误解为「在用策略」）。
        // I-3/D6 + ADR-019 v1.1 R-1：`config.fee` 保持**扁平** [`fee_model_to_json`] 形态
        // （`{rate_pct,min_fee,slippage_bp,stamp_duty_pct}`，含 stamp 实际取值）——预设往返/前端读取
        // 必须向后兼容；两段结构（effective/profile）**只用于响应回显**（`resolved_fee_to_json`），不得混入 config。
        // I-2/D6：warmup 段钉住 requested/effective。
        let config = serde_json::json!({
            "slots": slots.iter().map(|s| serde_json::json!({
                "strategy_id": s.strategy_id,
                "version_id": s.version_id,
                "version": s.version,
                "sha256": s.sha256,
                "params": s.params_json,
                "weight": s.weight,
                "archived": s.archived,
            })).collect::<Vec<_>>(),
            "buy_threshold": buy,
            "sell_threshold": sell,
            "policy": req.policy,
            "stop": req.stop,
            "initial_capital": initial_capital,
            "fee": crate::fee::fee_model_to_json(&fee),
            "warmup_requested": warmup_requested,
            "warmup_effective": warmup_effective,
        });

        let now = self.clock.now();
        let run = self
            .run_store
            .create_run(&NewStrategyRun {
                id: new_id("sr", now),
                name: req.name.clone(),
                symbol,
                period: req.period.clone(),
                from_ts: req.from,
                to_ts: req.to,
                config,
            })
            .await?;

        // 后台任务（与 BacktestService 同模式：入队即 spawn，Semaphore 在任务内阻塞限并发）。
        let run_store = Arc::clone(&self.run_store);
        let progress = Arc::clone(&self.progress);
        let semaphore = Arc::clone(&self.semaphore);
        let cancel_flags = Arc::clone(&self.cancel_flags);
        let clock = Arc::clone(&self.clock);
        let id = run.id.clone();
        tokio::spawn(async move {
            let _permit = semaphore.acquire().await.expect("semaphore closed");
            execute_run(
                run_store, progress, cancel_flags, clock, id, probe, slots, bars,
            )
            .await;
        });
        Ok(run)
    }

    /// 槽位校验 + 钉住（版本存在 404 / draft 400 / weight>0 / params schema 填充）。
    /// 2026-09-10 裁决：published|archived 可运行（archived = 审计重跑，快照带 `archived` 标记）；
    /// draft 仍拒绝（未发布代码不可运行，门禁语义保留）。
    async fn validate_slot(&self, s: &SlotReq) -> anyhow::Result<ValidatedSlot> {
        if s.version_id.trim().is_empty() {
            return Err(WorkbenchValidation("slot.version_id 必填".into()).into());
        }
        if !s.weight.is_finite() || s.weight <= 0.0 {
            return Err(WorkbenchValidation(format!(
                "slot.weight 须为正有限值，got {}",
                s.weight
            ))
            .into());
        }
        let v = self
            .strategies
            .get_version(&s.version_id)
            .await?
            .ok_or_else(|| WorkbenchNotFound(format!("策略版本不存在: {}", s.version_id)))?;
        let status = v.status;
        if status == domain::strategy_state::StrategyStatus::Draft {
            return Err(WorkbenchValidation(format!(
                "策略版本 {} 未发布（status=draft），draft 版本不可运行（published/archived 版本可运行）",
                s.version_id
            ))
            .into());
        }
        debug_assert!(
            matches!(
                status,
                domain::strategy_state::StrategyStatus::Published
                    | domain::strategy_state::StrategyStatus::Archived
            ),
            "状态机仅 draft/published/archived 三态"
        );
        let archived = status == domain::strategy_state::StrategyStatus::Archived;
        let schema = schema_from_json(&v.params_schema);
        let params =
            fill_and_validate_params(&schema, &s.params).map_err(WorkbenchValidation)?;
        let params_json = serde_json::Value::Object(
            params
                .iter()
                .map(|(k, v)| {
                    // ABI §1：插件参数 schema 仅数值型（min/max 数值校验）；Choice 为内建策略遗留形态，
                    // 插件 schema 不产生——防御性兜底序列化为字符串。
                    let jv = match v {
                        backtest::ParamValue::Num(n) => serde_json::json!(n),
                        backtest::ParamValue::Choice(c) => serde_json::json!(c),
                    };
                    (k.clone(), jv)
                })
                .collect(),
        );
        Ok(ValidatedSlot {
            strategy_id: v.strategy_id,
            version_id: v.id,
            version: v.version,
            sha256: v.sha256,
            code: v.code,
            params,
            params_json,
            weight: s.weight,
            archived,
        })
    }

    /// 读 run（404）。
    pub async fn get_run(&self, id: &str) -> anyhow::Result<StrategyRunView> {
        self.run_store
            .get_run(id)
            .await?
            .ok_or_else(|| anyhow!(WorkbenchNotFound(format!("运行不存在: {id}"))))
    }

    /// 列表（分页 + 状态过滤）。
    pub async fn list_runs(&self, filter: &StrategyRunFilter) -> anyhow::Result<Vec<StrategyRunView>> {
        self.run_store.list_runs(filter).await
    }

    /// 读结果（run 未知 → 404；未成功无结果 → 404）。
    pub async fn get_result(&self, run_id: &str) -> anyhow::Result<StrategyRunResult> {
        self.get_run(run_id).await?;
        self.run_store
            .get_result(run_id)
            .await?
            .ok_or_else(|| {
                anyhow!(WorkbenchNotFound(format!("运行 {run_id} 尚无结果（未成功完成）")))
            })
    }

    /// 取消（协作式）：queued → DB 直接落 canceled（后台任务认领时自动放弃）；
    /// running → 置内存取消标记（引擎 observer 回调点检查，下一 bar 边界 Break）+ DB 落 canceled。
    /// 未知 id → 404；终态 → 409。
    pub async fn cancel(&self, id: &str) -> anyhow::Result<StrategyRunView> {
        let run = self.get_run(id).await?; // 404
        if run.status.is_terminal() {
            return Err(WorkbenchConflict(format!(
                "运行 {id} 已终态（{}），不可取消",
                run.status.as_str()
            ))
            .into());
        }
        // running：先置协作式取消标记（引擎下一 bar 边界生效）；queued：标记不存在亦无妨
        //（认领时 mark_started 会读到 canceled 而放弃）。
        if let Some(flag) = self.cancel_flags.lock().expect("flags poisoned").get(id) {
            flag.store(true, Ordering::Relaxed);
        }
        match self.run_store.mark_canceled(id, self.clock.now()).await? {
            None => Err(anyhow!(WorkbenchNotFound(format!("运行不存在: {id}")))),
            Some(false) => Err(WorkbenchConflict(format!(
                "运行 {id} 已终态，不可取消（并发迁移）"
            ))
            .into()),
            Some(true) => self.get_run(id).await,
        }
    }

    /// 多 run 对比：并排 net_value + metrics（输入序；未知/未成功 run 跳过）。
    pub async fn compare(&self, ids: &[String]) -> anyhow::Result<Vec<CompareItem>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(run) = self.run_store.get_run(id).await? else { continue };
            let Some(res) = self.run_store.get_result(id).await? else { continue };
            out.push(CompareItem {
                run_id: run.id,
                name: run.name,
                symbol: run.symbol,
                period: run.period,
                net_value: res.net_value,
                metrics: res.metrics,
            });
        }
        Ok(out)
    }

    // ── 组合预设（ADR §13.5）──

    /// 新建预设：config 校验（同 submit 配置口径，钉住 sha256/params）→ 入库（重名 409）。
    pub async fn create_preset(
        &self,
        name: &str,
        config: &serde_json::Value,
    ) -> anyhow::Result<StrategyPresetRow> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkbenchValidation("name 必填".into()).into());
        }
        if self.preset_store.find_preset_by_name(name).await?.is_some() {
            return Err(WorkbenchConflict(format!("预设名已存在: {name}")).into());
        }
        let pinned = self.validate_preset_config(config).await?;
        let row = self
            .preset_store
            .create_preset(&NewStrategyPreset {
                id: new_id("sp", self.clock.now()),
                name: name.to_string(),
                config: pinned,
            })
            .await
            .map_err(|e| {
                // DB UNIQUE 兜底（预检查后并发撞名）。
                if e.to_string().contains("duplicate key") {
                    anyhow!(WorkbenchConflict(format!("预设名已存在: {name}")))
                } else {
                    e
                }
            })?;
        Ok(row)
    }

    /// 读预设（404）。
    pub async fn get_preset(&self, id: &str) -> anyhow::Result<StrategyPresetRow> {
        self.preset_store
            .get_preset(id)
            .await?
            .ok_or_else(|| anyhow!(WorkbenchNotFound(format!("预设不存在: {id}"))))
    }

    /// 全部预设（created_at ASC, id ASC）。
    pub async fn list_presets(&self) -> anyhow::Result<Vec<StrategyPresetRow>> {
        self.preset_store.list_presets().await
    }

    /// 更新预设（name trim 非空；config 同 create 校验；未知 404；撞名 409）。
    pub async fn update_preset(
        &self,
        id: &str,
        name: &str,
        config: &serde_json::Value,
    ) -> anyhow::Result<StrategyPresetRow> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkbenchValidation("name 必填".into()).into());
        }
        self.get_preset(id).await?; // 404
        if self
            .preset_store
            .find_preset_by_name(name)
            .await?
            .is_some_and(|p| p.id != id)
        {
            return Err(WorkbenchConflict(format!("预设名已存在: {name}")).into());
        }
        let pinned = self.validate_preset_config(config).await?;
        self.preset_store
            .update_preset(id, name, &pinned)
            .await
            .map_err(|e| {
                if e.to_string().contains("duplicate key") {
                    anyhow!(WorkbenchConflict(format!("预设名已存在: {name}")))
                } else {
                    e
                }
            })?
            .ok_or_else(|| anyhow!(WorkbenchNotFound(format!("预设不存在: {id}"))))
    }

    /// 删除预设（未知 404）。
    pub async fn delete_preset(&self, id: &str) -> anyhow::Result<()> {
        if !self.preset_store.delete_preset(id).await? {
            return Err(WorkbenchNotFound(format!("预设不存在: {id}")).into());
        }
        Ok(())
    }

    /// apply：返回钉住 config（供 submit 用；前端合并 symbol/period/from/to 后提交）。404。
    pub async fn apply_preset(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        Ok(self.get_preset(id).await?.config)
    }

    /// 预设 config 校验 + 钉住（与 submit 同口径：slots 1..=10 / weight>0 / 版本存在+非 draft /
    /// params schema 填充 / 阈值+policy 经 strategy-core validate / stop 正有限 / fee 三字段）。
    /// 输出钉住形态（slots 展开为 {strategy_id, version_id, version, sha256, params, weight, archived}）。
    async fn validate_preset_config(
        &self,
        config: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let obj = config
            .as_object()
            .ok_or_else(|| WorkbenchValidation("config 应为对象".to_string()))?;
        let slots_json = obj
            .get("slots")
            .and_then(|v| v.as_array())
            .ok_or_else(|| WorkbenchValidation("config.slots 应为数组".to_string()))?;
        if slots_json.is_empty() || slots_json.len() > 10 {
            return Err(WorkbenchValidation(format!(
                "slots 数量须为 1..=10，got {}",
                slots_json.len()
            ))
            .into());
        }
        let mut slots = Vec::with_capacity(slots_json.len());
        for s in slots_json {
            let req = SlotReq {
                version_id: s
                    .get("version_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                params: s.get("params").cloned().unwrap_or_else(|| serde_json::json!({})),
                weight: s.get("weight").and_then(|v| v.as_f64()).unwrap_or(f64::NAN),
            };
            slots.push(self.validate_slot(&req).await?);
        }
        let num = |key: &str, default: f64| -> Result<f64, WorkbenchValidation> {
            match obj.get(key) {
                None => Ok(default),
                Some(v) => v
                    .as_f64()
                    .ok_or_else(|| WorkbenchValidation(format!("config.{key} 应为数值"))),
            }
        };
        let buy = num("buy_threshold", strategy_core::DEFAULT_BUY_THRESHOLD)?;
        let sell = num("sell_threshold", strategy_core::DEFAULT_SELL_THRESHOLD)?;
        let initial_capital = num("initial_capital", DEFAULT_INITIAL_CAPITAL)?;
        let policy_json = obj
            .get("policy")
            .cloned()
            .ok_or_else(|| WorkbenchValidation("config.policy 必填".to_string()))?;
        let policy: ExecutionPolicy = serde_json::from_value(policy_json.clone())
            .map_err(|e| WorkbenchValidation(format!("policy 非法: {e}")))?;
        let stop_json = obj.get("stop").cloned().unwrap_or(serde_json::Value::Null);
        let stop: Option<StopConfig> = if stop_json.is_null() {
            None
        } else {
            let sc: StopConfig = serde_json::from_value(stop_json.clone())
                .map_err(|e| WorkbenchValidation(format!("stop 非法: {e}")))?;
            if !sc.value.is_finite() || sc.value <= 0.0 {
                return Err(WorkbenchValidation(format!(
                    "stop.value 须为正有限值，got {}",
                    sc.value
                ))
                .into());
            }
            Some(sc)
        };
        let fee_json = obj
            .get("fee")
            .cloned()
            .ok_or_else(|| WorkbenchValidation("config.fee 必填".to_string()))?;
        let fee = to_fee_model(&fee_json).map_err(|e| WorkbenchValidation(e.to_string()))?;
        // I-2/D6：预设可携带 warmup_bars（缺省 250）；非整数 → 400。
        let warmup_bars = match obj.get("warmup_bars") {
            None => DEFAULT_WARMUP_BARS,
            Some(v) => v
                .as_u64()
                .filter(|n| *n <= u32::MAX as u64)
                .map(|n| n as usize)
                .ok_or_else(|| {
                    WorkbenchValidation("config.warmup_bars 应为非负整数".to_string())
                })?,
        };
        let probe = EnsembleConfig {
            slots: vec![],
            buy_threshold: buy,
            sell_threshold: sell,
            policy,
            stop,
            initial_capital,
            fee,
            period: backtest::Period::D1, // validate 不检视 period（仅占位）
            warmup_bars: 0,
            runtime_limits: strategy_runtime::RuntimeLimits::default(),
        };
        probe.validate().map_err(WorkbenchValidation)?;

        Ok(serde_json::json!({
            "slots": slots.iter().map(|s| serde_json::json!({
                "strategy_id": s.strategy_id,
                "version_id": s.version_id,
                "version": s.version,
                "sha256": s.sha256,
                "params": s.params_json,
                "weight": s.weight,
                "archived": s.archived,
            })).collect::<Vec<_>>(),
            "buy_threshold": buy,
            "sell_threshold": sell,
            "policy": policy_json,
            "stop": stop_json,
            "initial_capital": initial_capital,
            "fee": crate::fee::fee_model_to_json(&fee),
            "warmup_bars": warmup_bars,
        }))
    }
}

/// 后台执行单个 run（任务制，与 BacktestService::execute_run 同模式）：
/// mark_started 原子认领（queued→running；失败 = 排队期被取消，放弃执行）→
/// spawn_blocking 跑引擎（observer：进度上报 + 协作式取消检查）→
/// 成功 mark_succeeded（同事务落结果）/ Canceled mark_canceled / 插件错误 mark_failed。
#[allow(clippy::too_many_arguments)]
async fn execute_run(
    store: Arc<dyn StrategyRunStore>,
    progress: Arc<dyn domain::ports::StrategyRunProgressSink>,
    cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    clock: Arc<dyn Clock>,
    run_id: String,
    probe: EnsembleConfig,
    slots: Vec<ValidatedSlot>,
    bars: Vec<backtest::Bar>,
) {
    // 原子认领：queued→running（排队期被取消 → 0 行 → 放弃执行）。
    match store.mark_started(&run_id, clock.now()).await {
        Ok(true) => {}
        Ok(false) => {
            tracing::info!(run_id, "运行已被并发取消/迁移，放弃执行");
            return;
        }
        Err(e) => {
            tracing::error!(run_id, error = %e, "mark_started 失败");
            let _ = store.mark_failed(&run_id, &e.to_string(), clock.now()).await;
            return;
        }
    }

    // 注册协作式取消标记（引擎 observer 回调点检查）。
    let flag = Arc::new(AtomicBool::new(false));
    cancel_flags
        .lock()
        .expect("flags poisoned")
        .insert(run_id.clone(), Arc::clone(&flag));

    // 进度桥接：引擎 observer 为同步回调（spawn_blocking 内），经 mpsc 到异步报告任务
    //（WS sink + store.update_progress），与 BacktestService 同模式。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(f64, DateTime<Utc>)>();
    let sink = Arc::clone(&progress);
    let store2 = Arc::clone(&store);
    let id2 = run_id.clone();
    let report_task = tokio::spawn(async move {
        while let Some((progress, ts)) = rx.recv().await {
            let _ = sink.send(&id2, progress, Some(ts)).await;
            let _ = store2.update_progress(&id2, progress).await;
        }
    });

    // 引擎配置：钉住槽位（code + sha256 + params + weight）。
    let mut cfg = probe;
    cfg.slots = slots
        .iter()
        .map(|s| {
            strategy_core::StrategySlot::new(
                s.code.clone(),
                s.sha256.clone(),
                s.params.clone(),
                s.weight,
            )
            .expect("submit 已校验 slot 合法")
        })
        .collect();

    let flag2 = Arc::clone(&flag);
    let outcome = tokio::task::spawn_blocking(move || {
        let mut last_milli: i64 = -1;
        let mut observer = |i: usize, total: usize| -> LoopControl {
            // 协作式取消检查点（每 bar 末）。
            if flag2.load(Ordering::Relaxed) {
                return LoopControl::Break;
            }
            let progress = (i + 1) as f64 / total as f64;
            // 节流：0.1% 粒度前进或最后一 bar 才发帧（防 20 万帧洪泛 WS/DB）。
            let milli = (progress * PROGRESS_THROTTLE_MILLI) as i64;
            if milli != last_milli || i + 1 == total {
                last_milli = milli;
                let _ = tx.send((progress, DateTime::from_timestamp(bars[i].ts, 0).unwrap_or_default()));
            }
            LoopControl::Continue
        };
        strategy_core::run_ensemble_with_quickjs_observed(&cfg, &bars, &mut observer)
    })
    .await
    .map_err(|e| anyhow!("引擎任务 panic: {e}"));

    // 引擎结束（含 Break）后 drop 发送端；等报告任务排空（进度/落库完成，确定可复现）。
    let _ = report_task.await;
    // 摘销取消标记。
    cancel_flags.lock().expect("flags poisoned").remove(&run_id);

    match outcome {
        Ok(Ok(res)) => {
            let result = to_run_result(res);
            match store.mark_succeeded(&run_id, &result, clock.now()).await {
                Ok(true) => {}
                Ok(false) => {
                    tracing::info!(run_id, "运行完成但已被并发迁移（如取消），结果不落库")
                }
                Err(e) => tracing::error!(run_id, error = %e, "mark_succeeded 失败"),
            }
        }
        Ok(Err(EnsembleError::Canceled)) => {
            // 协作式取消落 DB（cancel() 通常已置；此处兜底引擎自主 Break 路径）。
            let _ = store.mark_canceled(&run_id, clock.now()).await;
        }
        Ok(Err(EnsembleError::Plugin(e))) => {
            let _ = store.mark_failed(&run_id, &e.to_string(), clock.now()).await;
        }
        Err(e) => {
            let _ = store.mark_failed(&run_id, &e.to_string(), clock.now()).await;
        }
    }
}

/// `strategy_core::EnsembleResult -> domain::StrategyRunResult`（五 jsonb 列；per_bar 全量，ADR §13.4）。
fn to_run_result(res: strategy_core::EnsembleResult) -> StrategyRunResult {
    StrategyRunResult {
        per_bar: serde_json::to_value(PerBarRecords(res.per_bar)).expect("per_bar 可序列化"),
        trades: serde_json::to_value(&res.trades).expect("trades 可序列化"),
        net_value: serde_json::to_value(&res.net_value).expect("net_value 可序列化"),
        drawdown: serde_json::to_value(&res.drawdown).expect("drawdown 可序列化"),
        metrics: serde_json::to_value(res.metrics).expect("metrics 可序列化"),
    }
}

/// per_bar 序列化包装（BarRecord 字段含非 Serialize 的 PluginError  outcome——
/// 投影为纯 JSON 形态：scores[{slot_idx, score, error?}], aggregate, signal, orders, events）。
struct PerBarRecords(Vec<strategy_core::BarRecord>);

impl Serialize for PerBarRecords {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = s.serialize_seq(Some(self.0.len()))?;
        for rec in &self.0 {
            seq.serialize_element(&bar_record_json(rec))?;
        }
        seq.end()
    }
}

/// BarRecord → JSON（各策略分 + 聚合分 + 信号 + 订单 + 事件全量；错误以字符串落——
/// PluginError 非 Serialize，错误事件自含 sha256/bar_index 于 message，ADR §10 不静默吞错）。
fn bar_record_json(rec: &strategy_core::BarRecord) -> serde_json::Value {
    let scores: Vec<serde_json::Value> = rec
        .scores
        .iter()
        .map(|sc| match &sc.outcome {
            strategy_core::SlotScoreOutcome::Ok(_) => serde_json::json!({
                "slot_idx": sc.slot_idx,
                "score": sc.score,
            }),
            strategy_core::SlotScoreOutcome::Err(e) => serde_json::json!({
                "slot_idx": sc.slot_idx,
                "score": sc.score,
                "error": e.to_string(),
            }),
        })
        .collect();
    let events: Vec<serde_json::Value> = rec
        .events
        .iter()
        .map(|ev| match ev {
            strategy_core::EngineEvent::PluginError { slot_idx, code_hash, bar_index, error } => {
                serde_json::json!({
                    "type": "plugin_error", "slot_idx": slot_idx, "sha256": code_hash,
                    "bar_index": bar_index, "error": error.to_string(),
                })
            }
            strategy_core::EngineEvent::CircuitBreaker { slot_idx, code_hash, bar_index } => {
                serde_json::json!({
                    "type": "circuit_breaker", "slot_idx": slot_idx, "sha256": code_hash,
                    "bar_index": bar_index,
                })
            }
            strategy_core::EngineEvent::PluginLog { slot_idx, bar_index, msg } => {
                serde_json::json!({
                    "type": "plugin_log", "slot_idx": slot_idx, "bar_index": bar_index,
                    "message": msg,
                })
            }
            strategy_core::EngineEvent::Fill { bar_index, side, qty, price, reason } => {
                serde_json::json!({
                    "type": "fill", "bar_index": bar_index, "side": side, "qty": qty,
                    "price": price, "reason": reason,
                })
            }
        })
        .collect();
    serde_json::json!({
        "ts": rec.ts,
        "warmup": rec.warmup,
        "scores": scores,
        "aggregate": rec.aggregate,
        "signal": rec.signal,
        "orders": rec.orders,
        "events": events,
    })
}
