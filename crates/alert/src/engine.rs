// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/alert/src/engine.rs>>[init]
//! AlertService：1min 评估节拍 + 告警生命周期状态机（触发→确认→恢复，语义见本文档 §1）。
//! 注入 domain 只读/持久化端口（ADR-017：应用面只读库；alert_* 为应用面自有表）。

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use domain::ports::{
    AlertEvalRead, AlertEvent, AlertFilter, AlertRule, AlertRulePatch, AlertStore, Clock,
    KlineRead, SymbolStatsRead,
};
use std::sync::Arc;

use crate::rules::{self, Evaluation};

/// 一轮评估的产出（WS 推送输入：fired=新建/续触发，resolved=恢复）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EvalOutcome {
    pub fired: Vec<AlertEvent>,
    pub resolved: Vec<AlertEvent>,
}

/// 告警服务（Application 层，与 diagnose::health::HealthService 同模式）。
pub struct AlertService {
    eval: Arc<dyn AlertEvalRead>,
    kline: Arc<dyn KlineRead>,
    stats: Arc<dyn SymbolStatsRead>,
    store: Arc<dyn AlertStore>,
    clock: Arc<dyn Clock>,
}

impl AlertService {
    pub fn new(eval: Arc<dyn AlertEvalRead>, kline: Arc<dyn KlineRead>,
               stats: Arc<dyn SymbolStatsRead>, store: Arc<dyn AlertStore>,
               clock: Arc<dyn Clock>) -> Self {
        Self { eval, kline, stats, store, clock }
    }

    /// 评估节拍（默认 1min 一轮，由 web::alerts::AlertEvaluator 循环驱动）：
    /// 规则每轮重读（阈值/开关/静默时长热生效）→ 分派内置规则评估 → 状态机落库。
    pub async fn evaluate(&self) -> Result<EvalOutcome> {
        let now = self.clock.now();
        let rules = self.store.list_rules().await?;
        let mut evals: Vec<Evaluation> = Vec::new();
        for rule in rules.iter().filter(|r| r.enabled) {
            match rule.id.as_str() {
                rules::RULE_SOURCE_SUCCESS_RATE => {
                    let since = now - Duration::minutes(rule.duration_minutes.max(1));
                    let events = self.eval.events_since(since).await?;
                    evals.extend(rules::eval_source_success_rate(rule, &events));
                }
                rules::RULE_SYMBOL_GAP_RATE => {
                    let symbols = self.kline.symbols_with_latest().await?;
                    let stats = self.stats.today_stats().await?;
                    evals.extend(rules::eval_symbol_gap_rate(rule, now, &symbols, &stats));
                }
                rules::RULE_COLLECTION_STALL => {
                    let since = now - Duration::minutes((rule.threshold as i64).max(1));
                    let events = self.eval.events_since(since).await?;
                    evals.extend(rules::eval_collection_stall(rule, now, &events));
                }
                rules::RULE_TUSHARE_DAILY_SYNC => {
                    let latest = self.eval.latest_event_of(rules::TUSHARE_SOURCE).await?;
                    evals.extend(rules::eval_tushare_daily_sync(rule, now, latest.as_ref()));
                }
                other => {
                    tracing::debug!(rule = other, "unknown alert rule id skipped");
                }
            }
        }
        self.apply(now, &rules, evals).await
    }

    /// 状态机应用（聚合防刷屏 + 静默期 + 恢复）：
    /// - breached & 无开放事件：距上次触发（含已恢复）≥ 静默期 → 新建 triggered
    /// - breached & 有开放事件：距 last_fired ≥ 静默期 → 续触发（count+1；已确认回退未确认）
    /// - 非 breached & 有开放事件 → 恢复 resolved
    async fn apply(&self, now: DateTime<Utc>, rules: &[AlertRule],
                   evals: Vec<Evaluation>) -> Result<EvalOutcome> {
        let mut out = EvalOutcome::default();
        for ev in evals {
            let Some(rule) = rules.iter().find(|r| r.id == ev.rule_id) else { continue };
            let open = self.store.open_incident(&ev.rule_id, &ev.source).await?;
            if ev.breached {
                let silence = Duration::minutes(rule.silence_minutes);
                match open {
                    Some(inc) => {
                        if now - inc.last_fired_at >= silence {
                            if let Some(e) = self.store.refire(inc.id, now).await? {
                                out.fired.push(e);
                            }
                        }
                    }
                    None => {
                        let last = self.store.last_fired_at(&ev.rule_id, &ev.source).await?;
                        if last.is_none_or(|t| now - t >= silence) {
                            let e = self.store.insert_incident(
                                &ev.rule_id, rule.level, &ev.source, &ev.message, now).await?;
                            out.fired.push(e);
                        }
                    }
                }
            } else if let Some(inc) = open {
                if let Some(e) = self.store.resolve(inc.id, now).await? {
                    out.resolved.push(e);
                }
            }
        }
        Ok(out)
    }

    /// GET /api/alerts（过滤解析/分页钳制在 web 层）。
    pub async fn list(&self, filter: &AlertFilter) -> Result<Vec<AlertEvent>> {
        self.store.list_events(filter).await
    }

    /// POST /api/alerts/{id}/ack：仅 triggered 可确认（确认时刻持久化，刷新不丢）。
    pub async fn ack(&self, id: i64) -> Result<Option<AlertEvent>> {
        self.store.ack(id, self.clock.now()).await
    }

    /// GET /api/alert-rules。
    pub async fn rules(&self) -> Result<Vec<AlertRule>> {
        self.store.list_rules().await
    }

    /// PATCH /api/alert-rules（热生效：下一评估节拍重读规则）。
    pub async fn update_rule(&self, id: &str, patch: &AlertRulePatch) -> Result<Option<AlertRule>> {
        self.store.patch_rule(id, patch).await
    }
}
// ~/~ end
