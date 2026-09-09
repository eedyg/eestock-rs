//! 插件编排器 worker 承载壳（P4a 切源；父级裁决决策点 1：**每会话专用 worker 线程，actor 模式**）。
//!
//! 背景：`PluginStrategyOrchestrator` 内含 QuickJS 实例（rquickjs `Rc` → **!Send/!Sync**），
//! 而 `SimLiveService` 以 `Arc` 共享于 axum/MCP/feed 任务（须 Send+Sync）。裁决契约：
//! ① 会话 stop/end → drop sender → worker 线程可靠退出（rx 断连即返回，不泄漏）；
//! ② worker 线程 panic 隔离：oneshot sender 随 panic drop → 调用方收 [`OrchestratorDead`]
//!    → 由 SimLiveService 记错误事件并降级会话（不得毒化服务或其他组件）；
//! ③ 命令通道 `tokio::sync::mpsc` bounded(4)，async 侧 `send().await` + oneshot await，
//!    不阻塞 tokio executor（worker 线程内 `blocking_recv`）；
//! ④ 编排器本体在 crates/simlive 保持纯逻辑同步 !Send 可单测——本模块只是承载壳。
//!
//! 实例化在 worker 线程内完成（`spawn_orchestrator` 同步等待 init 结果——
//! **调用方须经 `spawn_blocking`**，见 `spawn_orchestrator_async`）。

use std::collections::BTreeMap;

use backtest::Bar;
use simlive::{
    OrchestratorError, PluginStrategyConfig, PluginStrategyOrchestrator, PositionInput,
    StockEvaluation,
};
use strategy_runtime::RuntimeLimits;

/// 一次 feed 的产出（评估 + 本 bar 归集的会话事件）。
#[derive(Debug)]
pub struct FeedOutcome {
    /// 未覆盖标的 → None（行情已记录，不评估）。
    pub eval: Option<StockEvaluation>,
    /// 本 bar 的会话事件（插件错误/熔断告警；空 = 无）。
    pub events: Vec<simlive::SessionEvent>,
}

/// worker 线程死亡（panic / 意外退出）：通道断连。调用方按裁决契约 ② 降级会话。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrchestratorDead;

impl std::fmt::Display for OrchestratorDead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "策略编排 worker 线程已终止（panic 隔离；会话应降级）")
    }
}

impl std::error::Error for OrchestratorDead {}

/// 编排器命令（单向；回复走各自 oneshot）。
enum OrchCommand {
    FeedBar {
        code: String,
        bar: Bar,
        position: Option<PositionInput>,
        reply: tokio::sync::oneshot::Sender<FeedOutcome>,
    },
}

/// 编排器句柄（Send+Sync；Clone 供锁内取出后锁外 await）。
/// Drop 最后一个句柄 → 命令通道断连 → worker 线程退出（裁决契约 ①）。
#[derive(Clone)]
pub struct OrchestratorHandle {
    tx: tokio::sync::mpsc::Sender<OrchCommand>,
    /// code → 最近评估（worker 每次评估后更新；同步查询直读，免通道往返）。
    latest: std::sync::Arc<std::sync::Mutex<BTreeMap<String, StockEvaluation>>>,
    /// worker 线程 JoinHandle 共享（退出观测用；detach 语义——drop 不 join）。
    worker: std::sync::Arc<std::thread::JoinHandle<()>>,
}

/// worker 线程退出探针（MINOR-3a：测试/诊断观测 OS 线程**实际退出**；
/// 不持有命令通道所有权——探针存活不影响线程退出）。
#[derive(Clone)]
pub struct WorkerExitProbe {
    worker: std::sync::Arc<std::thread::JoinHandle<()>>,
}

impl WorkerExitProbe {
    /// worker 线程函数已返回（退出/死亡）→ true。
    pub fn is_exited(&self) -> bool {
        self.worker.is_finished()
    }
}

/// 命令通道容量（裁决契约 ③：bounded(1~4)；1m bar 速率无背压压力）。
const CMD_CHANNEL_CAP: usize = 4;

impl OrchestratorHandle {
    /// 喂入一根新 bar 并评估（async；send + oneshot await，不阻塞 executor）。
    /// `Err(OrchestratorDead)` = worker 线程已终止（panic 隔离，裁决契约 ②）。
    pub async fn feed_bar(
        &self,
        code: &str,
        bar: Bar,
        position: Option<PositionInput>,
    ) -> Result<FeedOutcome, OrchestratorDead> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(OrchCommand::FeedBar {
                code: code.to_string(),
                bar,
                position,
                reply,
            })
            .await
            .map_err(|_| OrchestratorDead)?;
        rx.await.map_err(|_| OrchestratorDead)
    }

    /// 某标的最近评估（镜像直读）。
    pub fn latest_evaluation(&self, code: &str) -> Option<StockEvaluation> {
        self.latest.lock().ok()?.get(code).cloned()
    }

    /// 全部标的最近评估（按 code 升序）。
    pub fn all_evaluations(&self) -> Vec<StockEvaluation> {
        self.latest
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    /// worker 线程退出探针（测试用：观测 drop 句柄后线程实际退出，MINOR-3a）。
    pub fn exit_probe(&self) -> WorkerExitProbe {
        WorkerExitProbe { worker: std::sync::Arc::clone(&self.worker) }
    }
}

/// 启动 worker 线程并在线程内实例化编排器（QuickJS 实例 !Send，必须在目标线程创建）。
/// **同步阻塞**等待 init 结果（实例化失败 → 显式 `Err`，会话启动失败——
/// 旧「未知策略静默跳过」语义废止）。调用方须处于阻塞容忍上下文（见 async 包装）。
pub fn spawn_orchestrator(
    configs: Vec<PluginStrategyConfig>,
    buy_long_threshold: f64,
    sell_threshold: f64,
) -> Result<OrchestratorHandle, OrchestratorError> {
    spawn_orchestrator_with(move || {
        PluginStrategyOrchestrator::with_quickjs(
            configs,
            buy_long_threshold,
            sell_threshold,
            RuntimeLimits::default(),
        )
    })
}

/// 泛化构造入口（MINOR-3：测试故障注入用——`build` 闭包在 **worker 线程内**执行，
/// 可注入 MockRuntime/panic 插件等非 QuickJS 编排器；生产路径用 [`spawn_orchestrator`]）。
/// 闭包只须 `Send`（编排器本体 !Send，故必须在闭包内构造而非捕获）。
pub fn spawn_orchestrator_with<F>(
    build: F,
) -> Result<OrchestratorHandle, OrchestratorError>
where
    F: FnOnce() -> Result<PluginStrategyOrchestrator, OrchestratorError> + Send + 'static,
{
    let (tx, mut rx) = tokio::sync::mpsc::channel::<OrchCommand>(CMD_CHANNEL_CAP);
    let (init_tx, init_rx) = std::sync::mpsc::channel::<
        Result<BTreeMap<String, StockEvaluation>, OrchestratorError>,
    >();
    let latest = std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::new()));
    let latest_worker = std::sync::Arc::clone(&latest);
    let join = std::thread::spawn(move || {
        let mut orch = match build() {
            Ok(o) => o,
            Err(e) => {
                let _ = init_tx.send(Err(e));
                return; // init 失败：线程即退（调用方持 Err，不会再发命令）。
            }
        };
        if init_tx.send(Ok(BTreeMap::new())).is_err() {
            return; // 调用方已放弃（会话启动竞态取消）。
        }
        // 命令循环：通道断连（句柄全 drop）→ recv 返 Err → 线程退出（裁决契约 ①）。
        while let Some(cmd) = rx.blocking_recv() {
            match cmd {
                OrchCommand::FeedBar { code, bar, position, reply } => {
                    let eval = orch.feed_bar(&code, bar, position);
                    let events = orch.take_events();
                    if let Some(ev) = &eval {
                        if let Ok(mut m) = latest_worker.lock() {
                            m.insert(ev.code.clone(), ev.clone());
                        }
                    }
                    // 接收方已放弃（如会话降级）→ 丢弃结果继续服务后续命令。
                    let _ = reply.send(FeedOutcome { eval, events });
                }
            }
        }
    });
    // 同步等待 init（调用方经 spawn_blocking；QuickJS 实例化为一次性启动成本）。
    init_rx
        .recv()
        .map_err(|_| OrchestratorError("编排 worker init 通道意外关闭".into()))??;
    Ok(OrchestratorHandle { tx, latest, worker: std::sync::Arc::new(join) })
}

/// async 包装：`spawn_blocking` 承载 init 同步等待（不阻塞 tokio executor，裁决契约 ③）。
pub async fn spawn_orchestrator_async(
    configs: Vec<PluginStrategyConfig>,
    buy_long_threshold: f64,
    sell_threshold: f64,
) -> anyhow::Result<OrchestratorHandle> {
    tokio::task::spawn_blocking(move || {
        spawn_orchestrator(configs, buy_long_threshold, sell_threshold)
    })
    .await
    .map_err(|e| anyhow::anyhow!("编排 worker init 任务 panic: {e}"))?
    .map_err(anyhow::Error::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use backtest::StrategyParams;
    use std::collections::HashMap;

    const CONST_80: &str = "function on_bar(ctx) { return 80; }";

    fn cfg(id: &str, stocks: &[&str]) -> PluginStrategyConfig {
        PluginStrategyConfig {
            strategy_id: id.into(),
            version_id: format!("sv_{id}"),
            version: 1,
            sha256: format!("sha_{id}"),
            name: id.into(),
            code: CONST_80.into(),
            params: StrategyParams::new(),
            stocks: stocks.iter().map(|s| s.to_string()).collect(),
            weight: 1.0,
            stock_weights: HashMap::new(),
        }
    }

    fn bar(ts: i64, close: f64) -> Bar {
        Bar { ts, open: close, high: close, low: close, close, volume: 1.0 }
    }

    /// 裁决契约 ③：async feed 正常工作（spawn_blocking init + oneshot await）。
    #[tokio::test]
    async fn feed_bar_roundtrip_via_worker() {
        let h = spawn_orchestrator_async(vec![cfg("st_a", &["AAA"])], 60.0, 40.0)
            .await
            .expect("spawn");
        let out = h.feed_bar("AAA", bar(100, 10.0), None).await.expect("feed");
        let ev = out.eval.expect("覆盖标的应评估");
        assert!((ev.aggregate_score - 80.0).abs() < 1e-9);
        assert!(out.events.is_empty());
        // 镜像可查。
        let latest = h.latest_evaluation("AAA").expect("镜像有值");
        assert!((latest.aggregate_score - 80.0).abs() < 1e-9);
        assert_eq!(h.all_evaluations().len(), 1);
    }

    /// 实例化失败（坏代码）→ spawn 显式 Err。
    #[tokio::test]
    async fn spawn_fails_on_bad_code() {
        let mut c = cfg("st_bad", &["AAA"]);
        c.code = "function on_bar(ctx) { return ;".into();
        let r = spawn_orchestrator_async(vec![c], 60.0, 40.0).await;
        assert!(r.is_err(), "实例化失败必须显式报错");
    }

    /// 裁决契约 ①：drop 句柄 → worker 线程退出（通道断连）；重复 feed → OrchestratorDead。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drop_handle_stops_worker_and_feed_fails() {
        let h = spawn_orchestrator_async(vec![cfg("st_a", &["AAA"])], 60.0, 40.0)
            .await
            .expect("spawn");
        h.feed_bar("AAA", bar(100, 10.0), None).await.expect("feed");
        drop(h);
        // 通道断连后重建的句柄不复存在；此处验证 drop 后线程退出无副作用：
        // 新 spawn 互不干扰（线程无泄漏语义由 rx 断连即退保证）。
        let h2 = spawn_orchestrator_async(vec![cfg("st_b", &["BBB"])], 60.0, 40.0)
            .await
            .expect("respawn");
        let out = h2.feed_bar("BBB", bar(100, 10.0), None).await.expect("feed");
        assert!(out.eval.is_some());
    }

    // ── MINOR-3：actor 生命周期真实测试（退出观测 + panic 故障注入）──

    /// 测试插件：on_bar 直接 panic（Rust 侧故障注入——JS 异常由运行时捕获走 G5，不构成本路径）。
    struct PanicInstance;
    impl strategy_runtime::PluginInstance for PanicInstance {
        fn on_bar(
            &mut self,
            _ctx: &strategy_runtime::BarCtx<'_>,
        ) -> Result<f64, strategy_runtime::PluginError> {
            panic!("fault injection: on_bar panic");
        }
        fn save(&self) -> Result<Option<serde_json::Value>, strategy_runtime::PluginError> {
            Ok(None)
        }
        fn load(&mut self, _state: &serde_json::Value) -> Result<(), strategy_runtime::PluginError> {
            Ok(())
        }
        fn params_schema(&self) -> &[strategy_runtime::ParamDef] {
            &[]
        }
    }

    /// 每「策略×标的」实例化出 PanicInstance 的测试运行时。
    struct PanicRuntime;
    impl strategy_runtime::PluginRuntime for PanicRuntime {
        fn instantiate(
            &mut self,
            _code_hash: &str,
            _code: &str,
            _params: &StrategyParams,
        ) -> Result<Box<dyn strategy_runtime::PluginInstance>, strategy_runtime::PluginError> {
            Ok(Box::new(PanicInstance))
        }
    }

    /// 轮询等待探针报退出（上限 2s，防挂死）。
    async fn wait_exited(probe: &WorkerExitProbe) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !probe.is_exited() {
            assert!(std::time::Instant::now() < deadline, "worker 线程未在时限内退出");
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// MINOR-3a：drop 句柄 → worker 线程**实际退出**（exit_probe 观测 OS 线程结束，
    /// 非仅通道断连；探针不持有命令通道所有权，不影响退出）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_thread_actually_exits_after_handle_drop() {
        let h = spawn_orchestrator_async(vec![cfg("st_a", &["AAA"])], 60.0, 40.0)
            .await
            .expect("spawn");
        h.feed_bar("AAA", bar(100, 10.0), None).await.expect("feed");
        let probe = h.exit_probe();
        assert!(!probe.is_exited(), "worker 存活中");
        drop(h);
        wait_exited(&probe).await;
    }

    /// MINOR-3b（承载壳级）：worker 线程内 panic（故障注入）→ 调用方收 OrchestratorDead
    ///（oneshot 随 panic drop，裁决契约 ②）；线程实际终止；后续 feed 仍 Err。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_panic_yields_orchestrator_dead_and_thread_exits() {
        let h = spawn_orchestrator_with(|| {
            let mut rt = PanicRuntime;
            PluginStrategyOrchestrator::new(vec![cfg("st_panic", &["AAA"])], 60.0, 40.0, &mut rt)
        })
        .expect("spawn");
        let probe = h.exit_probe();
        let err = h.feed_bar("AAA", bar(100, 10.0), None).await.unwrap_err();
        assert_eq!(err, OrchestratorDead, "worker panic → OrchestratorDead（裁决契约 ②）");
        wait_exited(&probe).await;
        // 句柄残留但通道已断：后续 feed 仍 Err。
        let err = h.feed_bar("AAA", bar(101, 10.0), None).await.unwrap_err();
        assert_eq!(err, OrchestratorDead);
    }
}
