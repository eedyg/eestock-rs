// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/state.rs>>[init]
//! MCP 应用状态与会话登记（DI 装配产物；app crate 注入具体实现）。
//! 分层红线：mcp 只见 domain 端口 + diagnose 服务，不依赖 storage/sqlx（同 web 口径）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// MCP 应用状态（与 web::state::AppState 同模式，只读端口注入）。
pub struct McpState {
    /// K线只读端口（domain::ports::KlineRead；storage 实现由 app 装配）。
    pub kline: Arc<dyn domain::ports::KlineRead>,
    /// 健康查询服务（diagnose；内部注入 domain::ports::HealthEventsRead）。
    pub health: diagnose::health::HealthService,
    /// 数据质量服务（Wave 2 Phase A：MCP④ get_data_quality；diagnose::quality，与 web 同实例）。
    pub quality: diagnose::quality::QualityService,
    /// get_sources_health 缺省统计窗口（秒；与 app 配置 health_window_secs 同源）。
    pub default_window_secs: i64,
    /// SSE 会话登记（sessionId → 消息通道）。
    pub sessions: SessionRegistry,
}

/// 会话登记表（std Mutex 不跨 await；与 web SubscriptionRegistry 同模式）。
#[derive(Clone, Default)]
pub struct SessionRegistry {
    inner: Arc<Mutex<HashMap<String, tokio::sync::mpsc::Sender<String>>>>,
}

impl SessionRegistry {
    /// 开新会话：生成 32 位 hex sessionId（rand，与 Trace ID 同口径，不引 uuid）。
    pub fn create(&self, cap: usize) -> (String, tokio::sync::mpsc::Receiver<String>) {
        let (tx, rx) = tokio::sync::mpsc::channel(cap);
        let id = new_session_id();
        self.inner.lock().expect("sessions poisoned").insert(id.clone(), tx);
        (id, rx)
    }

    /// 取会话发送端（POST /messages 路由）；会话被移除 → None（404）。
    pub fn sender(&self, id: &str) -> Option<tokio::sync::mpsc::Sender<String>> {
        self.inner.lock().expect("sessions poisoned").get(id).cloned()
    }

    /// 注销会话（SSE 断开时由 SessionGuard 调用；通道发送端随之失效）。
    pub fn remove(&self, id: &str) {
        self.inner.lock().expect("sessions poisoned").remove(id);
    }

    /// 活跃会话数（连接泄漏观测/测试断言用）。
    pub fn len(&self) -> usize { self.inner.lock().expect("sessions poisoned").len() }

    pub fn is_empty(&self) -> bool { self.len() == 0 }
}

/// 32 位 hex 随机会话 id（rand 16 字节；99-decisions-log 既定口径：不引 uuid）。
fn new_session_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_lifecycle_and_id_shape() {
        let reg = SessionRegistry::default();
        let (id1, _rx1) = reg.create(8);
        let (id2, _rx2) = reg.create(8);
        assert_eq!(reg.len(), 2);
        assert_ne!(id1, id2);
        assert_eq!(id1.len(), 32, "16 字节 hex = 32 字符");
        assert!(id1.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(reg.sender(&id1).is_some());
        assert!(reg.sender("no-such-session").is_none());
        reg.remove(&id1);
        assert_eq!(reg.len(), 1);
        assert!(reg.sender(&id1).is_none(), "注销后 POST 路由 404");
    }
}
// ~/~ end
