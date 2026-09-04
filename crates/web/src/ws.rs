// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/ws.rs>>[init]
//! WS /ws 订阅分发：{type:"bar"|"quote"|"health"} 推送；断线退避重连由客户端（00-shell 既定）。
//! ADR-017：应用面只读库——无数据面直连，推送源 = Poller 短周期轮询库增量（§1.2）。

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::Response,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

use crate::dto::{parse_period, BarDto};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Topic { Bar, Quote, Health, Alert }

/// 客户端帧：{"type":"subscribe","topic":"bar","code":"518880","period":"1m"}（unsubscribe 同形）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Subscribe { topic: Topic, code: Option<String>, period: Option<String> },
    Unsubscribe { topic: Topic, code: Option<String>, period: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Subscription {
    pub topic: Topic,
    pub code: Option<String>,     // None = 全部标的
    pub period: Option<String>,   // bar 订阅必填（"1m"/"5m"/"15m"/"1h"/"1d"）
}

/// 服务端推送帧：serde 内部 tag 平铺为 {"type":"bar"|"quote"|"health"|"alert", ...}。
/// Alert（Wave 2 Phase B）：newtype 变体内联事件字段（{"type":"alert", id, level, ...}），
/// 推送源 = web::alerts::AlertEvaluator 评估节拍（非本 Poller）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushMsg {
    Bar { code: String, period: String, bar: BarDto },
    Quote { code: String, ts: DateTime<Utc>, last: f64, #[serde(rename = "changePct")] change_pct: Option<f64> },
    Health { window_secs: i64, sources: Vec<diagnose::health::SourceHealth> },
    Alert(crate::alerts::AlertEventDto),
}

/// 订阅匹配：topic 一致且（sub.code/period 为 None 通配或与消息相等）。
pub fn matches(sub: &Subscription, msg: &PushMsg) -> bool {
    let hit = |want: &Option<String>, got: &str| want.as_deref().is_none_or(|w| w == got);
    match (sub.topic, msg) {
        (Topic::Bar, PushMsg::Bar { code, period, .. }) => hit(&sub.code, code) && hit(&sub.period, period),
        (Topic::Quote, PushMsg::Quote { code, .. }) => hit(&sub.code, code),
        (Topic::Health, PushMsg::Health { .. }) => true,
        (Topic::Alert, PushMsg::Alert(_)) => true,   // 订阅即全量告警推送（07-alerts §6）
        _ => false,
    }
}

/// 推送总线（进程内 broadcast；lagged 丢帧由客户端重连/REST 重拉兜底）。
#[derive(Clone)]
pub struct WsHub { tx: broadcast::Sender<PushMsg> }

impl WsHub {
    pub fn new() -> Self { Self { tx: broadcast::channel(256).0 } }
    /// 无订阅者时 send 返回 Err，属常态，忽略。
    pub fn publish(&self, msg: PushMsg) { let _ = self.tx.send(msg); }
    pub fn subscribe(&self) -> broadcast::Receiver<PushMsg> { self.tx.subscribe() }
}

impl Default for WsHub {
    fn default() -> Self { Self::new() }
}

/// 全连接订阅登记表（Poller 据此决定轮询哪些 code/period）。std Mutex 不跨 await。
#[derive(Clone, Default)]
pub struct SubscriptionRegistry { inner: Arc<Mutex<HashSet<Subscription>>> }

impl SubscriptionRegistry {
    pub fn add(&self, sub: Subscription) { self.inner.lock().expect("subs poisoned").insert(sub); }
    pub fn remove(&self, sub: &Subscription) { self.inner.lock().expect("subs poisoned").remove(sub); }
    pub fn snapshot(&self) -> HashSet<Subscription> { self.inner.lock().expect("subs poisoned").clone() }
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(st): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(move |sock| handle_socket(st, sock))
}

async fn handle_socket(st: Arc<AppState>, mut sock: WebSocket) {
    let mut rx = st.hub.subscribe();
    let mut mine: HashSet<Subscription> = HashSet::new();
    loop {
        tokio::select! {
            msg = sock.recv() => match msg {
                Some(Ok(Message::Text(t))) => apply_client_msg(&st.subs, &mut mine, t.as_str()),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}    // ping/pong/binary 忽略（axum 自动回 pong）
                Some(Err(_)) => break,
            },
            push = rx.recv() => match push {
                Ok(m) if mine.iter().any(|s| matches(s, &m)) => {
                    if let Ok(text) = serde_json::to_string(&m) {
                        if sock.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                }
                Ok(_) => {}                                     // 未订阅的消息
                Err(broadcast::error::RecvError::Lagged(_)) => {} // 丢帧由客户端重连兜底
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
    for s in &mine { st.subs.remove(s); }   // 连接关闭即注销（Poller 不再空轮询）
}

fn apply_client_msg(reg: &SubscriptionRegistry, mine: &mut HashSet<Subscription>, text: &str) {
    let Ok(msg) = serde_json::from_str::<ClientMsg>(text) else { return }; // 坏帧忽略（ADR-010 内网）
    match msg {
        ClientMsg::Subscribe { topic, code, period } => {
            let sub = Subscription { topic, code, period };
            mine.insert(sub.clone());
            reg.add(sub);
        }
        ClientMsg::Unsubscribe { topic, code, period } => {
            let sub = Subscription { topic, code, period };
            mine.remove(&sub);
            reg.remove(&sub);
        }
    }
}

/// 推送轮询器（应用面唯一推送源）：按订阅注册表轮询库，ts 前进的增量发布到 hub。
/// 游标在内存（进程级），重启重推一次最新值，无害。
pub struct Poller {
    state: Arc<AppState>,
    interval: Duration,
    last_bar: HashMap<(String, String), DateTime<Utc>>,
    last_quote: HashMap<String, DateTime<Utc>>,
    last_health_ts: Option<DateTime<Utc>>,
}

impl Poller {
    pub fn new(state: Arc<AppState>, interval: Duration) -> Self {
        Self {
            state, interval,
            last_bar: HashMap::new(),
            last_quote: HashMap::new(),
            last_health_ts: None,
        }
    }

    pub async fn run(mut self) {
        loop {
            if let Err(e) = self.tick().await {
                tracing::warn!(error = %e, "ws poller tick failed");
            }
            tokio::time::sleep(self.interval).await;
        }
    }

    /// 单轮轮询（测试可直调）：bar 按 (code,period) 去重；quote 全量快照增量；health 快照变更。
    pub async fn tick(&mut self) -> anyhow::Result<()> {
        let subs = self.state.subs.snapshot();

        // bar：按 (code, period) 去重轮询，ts 前进才推
        let mut keys: HashSet<(String, String)> = HashSet::new();
        for s in subs.iter().filter(|s| s.topic == Topic::Bar) {
            if let (Some(code), Some(period)) = (&s.code, &s.period) {
                keys.insert((code.clone(), period.clone()));
            }
        }
        for (code, period) in keys {
            let Some(p) = parse_period(&period) else { continue };
            if let Some(bar) = self.state.kline.latest_bar(p, &code).await? {
                let key = (code.clone(), period.clone());
                if self.last_bar.get(&key).is_none_or(|ts| bar.ts > *ts) {
                    self.last_bar.insert(key, bar.ts);
                    self.state.hub.publish(PushMsg::Bar { code, period, bar: BarDto::from(&bar) });
                }
            }
        }

        // quote：任一 quote 订阅存在则全量快照推进（连接侧按 code 过滤）
        if subs.iter().any(|s| s.topic == Topic::Quote) {
            for row in self.state.kline.symbols_with_latest().await? {
                let (Some(ts), Some(last)) = (row.last_ts, row.last_close) else { continue };
                if self.last_quote.get(&row.code).is_none_or(|t| ts > *t) {
                    self.last_quote.insert(row.code.clone(), ts);
                    let change_pct = row.prev_close.filter(|p| *p != 0.0)
                        .map(|p| (last - p) / p * 100.0);
                    self.state.hub.publish(PushMsg::Quote { code: row.code, ts, last, change_pct });
                }
            }
        }

        // health：窗口聚合 last_event_ts 前进 → 整快照推送
        if subs.iter().any(|s| s.topic == Topic::Health) {
            let sources = self.state.health.aggregate(self.state.health_window_secs).await?;
            let newest = sources.iter().filter_map(|h| h.last_event_ts).max();
            if newest.is_some() && newest != self.last_health_ts {
                self.last_health_ts = newest;
                self.state.hub.publish(PushMsg::Health {
                    window_secs: self.state.health_window_secs, sources });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn bar_msg(code: &str, period: &str) -> PushMsg {
        PushMsg::Bar { code: code.into(), period: period.into(), bar: BarDto {
            ts: Utc.with_ymd_and_hms(2026, 9, 4, 1, 30, 0).unwrap(),
            open: 1.0, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105.0, source: None,
        } }
    }

    #[test]
    fn matches_bar_code_and_period() {
        let sub = Subscription { topic: Topic::Bar,
            code: Some("518880".into()), period: Some("1m".into()) };
        assert!(matches(&sub, &bar_msg("518880", "1m")));
        assert!(!matches(&sub, &bar_msg("518880", "5m")));
        assert!(!matches(&sub, &bar_msg("513310", "1m")));
    }

    #[test]
    fn matches_none_is_wildcard() {
        let sub = Subscription { topic: Topic::Quote, code: None, period: None };
        let q = PushMsg::Quote { code: "518880".into(), ts: Utc::now(), last: 1.0, change_pct: None };
        assert!(matches(&sub, &q));
        let scoped = Subscription { topic: Topic::Quote, code: Some("513310".into()), period: None };
        assert!(!matches(&scoped, &q));
    }

    #[test]
    fn cross_topic_never_matches() {
        let sub = Subscription { topic: Topic::Health, code: None, period: None };
        assert!(!matches(&sub, &bar_msg("518880", "1m")));
        assert!(matches(&sub, &PushMsg::Health { window_secs: 3600, sources: vec![] }));
    }

    #[test]
    fn push_msg_json_tag_shape() {
        let v = serde_json::to_value(bar_msg("518880", "1m")).unwrap();
        assert_eq!(v["type"], "bar");
        assert_eq!(v["code"], "518880");
        assert_eq!(v["bar"]["close"], 1.05);
        let h = serde_json::to_value(PushMsg::Health { window_secs: 3600, sources: vec![] }).unwrap();
        assert_eq!(h["type"], "health");
    }

    #[test]
    fn push_msg_quote_frame_camel_case() {
        // K1 契约修复：WS quote 帧载荷与前端/mock 统一为 camelCase（前端 store 读 changePct）。
        let q = PushMsg::Quote { code: "518880".into(), ts: Utc::now(), last: 1.234, change_pct: Some(0.12) };
        let v = serde_json::to_value(&q).unwrap();
        assert_eq!(v["type"], "quote");
        assert_eq!(v["code"], "518880");
        assert_eq!(v["changePct"], 0.12);
        assert!(v.get("change_pct").is_none(), "不得再输出 snake_case change_pct");
        assert_eq!(v["last"], 1.234);
    }

    #[test]
    fn push_msg_alert_frame_shape() {
        // Wave 2 Phase B：alert 帧平铺事件字段（07-alerts §6：{type:"alert", level, ...}）
        let dto = crate::alerts::AlertEventDto {
            id: 1, rule_id: "collection_stall".into(), level: domain::ports::AlertLevel::Critical,
            source: "collector".into(), message: "停摆".into(),
            status: domain::ports::AlertStatus::Triggered, fire_count: 1,
            first_fired_at: Utc::now(), last_fired_at: Utc::now(), acked_at: None, resolved_at: None,
        };
        let v = serde_json::to_value(PushMsg::Alert(dto)).unwrap();
        assert_eq!(v["type"], "alert");
        assert_eq!(v["level"], "critical");
        assert_eq!(v["status"], "triggered");
        // 订阅匹配：alert topic 全量
        let sub = Subscription { topic: Topic::Alert, code: None, period: None };
        let dto2 = crate::alerts::AlertEventDto {
            id: 2, rule_id: "symbol_gap_rate".into(), level: domain::ports::AlertLevel::Warning,
            source: "513310".into(), message: "缺口".into(),
            status: domain::ports::AlertStatus::Resolved, fire_count: 4,
            first_fired_at: Utc::now(), last_fired_at: Utc::now(), acked_at: None,
            resolved_at: Some(Utc::now()),
        };
        assert!(matches(&sub, &PushMsg::Alert(dto2)));
        assert!(!matches(&sub, &bar_msg("518880", "1m")), "跨 topic 不匹配");
    }

    #[test]
    fn client_subscribe_unsubscribe_roundtrip() {
        let reg = SubscriptionRegistry::default();
        let mut mine = HashSet::new();
        apply_client_msg(&reg, &mut mine,
            r#"{"type":"subscribe","topic":"bar","code":"518880","period":"1m"}"#);
        assert_eq!(reg.snapshot().len(), 1);
        apply_client_msg(&reg, &mut mine,
            r#"{"type":"unsubscribe","topic":"bar","code":"518880","period":"1m"}"#);
        assert!(reg.snapshot().is_empty());
        apply_client_msg(&reg, &mut mine, "not json");   // 坏帧忽略不 panic
        apply_client_msg(&reg, &mut mine, r#"{"type":"subscribe","topic":"unknown"}"#);
        assert!(reg.snapshot().is_empty(), "未知 topic 忽略");
    }
}
// ~/~ end
