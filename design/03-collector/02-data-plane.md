# 03-collector/02 — 数据面进程（eestock-data）与部署

> 本文档 tangle 生成 `crates/app/src/{lib,config,healthz}.rs`、`crates/app/src/bin/eestock-data.rs`、`Dockerfile`。
> 决策依据：ADR-017（部署双面分离；数据面唯一端口 /healthz:8080，无 web 框架依赖、无管理 API）。
> `docker-compose.yml` 与 `config/data.toml.example` 为手写例外（README 既定），config/data.toml 不入库（含本地 token）。

## 1. 配置（TOML + 环境变量覆盖）

- 加载顺序：TOML 文件 → 环境变量覆盖（`DATABASE_URL`、`TUSHARE_TOKEN`，容器 secret 注入口径）。
- `--config PATH` 指定配置路径（默认 `./config/data.toml`，容器内 `/etc/eestock/data.toml`）。

``` {.rust file=crates/app/src/config.rs}
//! 数据面配置：TOML 文件 + 环境变量覆盖（secret 走 env，不落配置文件）。

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct DataConfig {
    pub database_url: String,
    /// tushare token（建议 TUSHARE_TOKEN env 注入；配置文件可省略）
    #[serde(default)]
    pub tushare_token: Option<String>,
    #[serde(default = "default_true")]
    pub tushare_enabled: bool,
    #[serde(default = "default_healthz_port")]
    pub healthz_port: u16,
    #[serde(default = "default_interval_ms")]
    pub tushare_interval_ms: i64,
}

fn default_true() -> bool { true }
fn default_healthz_port() -> u16 { 8080 }
fn default_interval_ms() -> i64 { 1000 }

/// 加载：TOML → env 覆盖（DATABASE_URL / TUSHARE_TOKEN）。
pub fn load(path: &str) -> anyhow::Result<DataConfig> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read config {path}: {e}"))?;
    let mut cfg: DataConfig = toml::from_str(&text)
        .map_err(|e| anyhow::anyhow!("parse config {path}: {e}"))?;
    if let Ok(v) = std::env::var("DATABASE_URL") { cfg.database_url = v; }
    if let Ok(v) = std::env::var("TUSHARE_TOKEN") { cfg.tushare_token = Some(v); }
    Ok(cfg)
}
```

## 2. /healthz（只读存活探测；手写最小 HTTP，不引 web 框架）

ADR-017：数据面无 web 依赖、最小攻击面，唯一端口 8080。手写 ~40 行 TCP HTTP
仅应答 `GET /healthz`；`--self-check` 子命令供容器 healthcheck（运行时镜像无 curl/wget）。

``` {.rust file=crates/app/src/healthz.rs}
//! /healthz 只读存活探测（ADR-017：数据面唯一端口；无 web 框架，最小攻击面）。

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 服务循环：GET /healthz → 200 {"status":"ok"}；其余 → 404。
pub async fn serve(listener: TcpListener) -> anyhow::Result<()> {
    loop {
        let (mut sock, peer) = listener.accept().await?;
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let n = match sock.read(&mut buf).await {
                Ok(n) => n,
                Err(e) => { tracing::debug!(%peer, error = %e, "healthz read"); return; }
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let (status, body) = if req.starts_with("GET /healthz") {
                ("200 OK", r#"{"status":"ok"}"#)
            } else {
                ("404 Not Found", r#"{"error":"not found"}"#)
            };
            let resp = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
        });
    }
}

/// 容器 healthcheck（运行时镜像无 curl/wget）：TCP 直连校验 200。同步实现，供 --self-check。
pub fn self_check(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port)) else { return false };
    s.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok();
    s.set_write_timeout(Some(std::time::Duration::from_secs(2))).ok();
    if s.write_all(b"GET /healthz HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    buf.starts_with(b"HTTP/1.1 200")
}
```

## 3. 进程入口（DI 装配）

启动顺序：配置 → tracing(JSON) → PgPool → **schema 自检（失败拒绝启动）** →
providers/collector 装配 → tushare 日增量任务 → /healthz → collector 主循环。

``` {.rust file=crates/app/src/lib.rs}
//! app —— 二进制装配：DI 组装、配置加载、进程入口（ADR-017 双面分离）。
//! 由 design/03-collector/02-data-plane.md tangle 生成（ADR-007），禁止手改。

pub mod config;
pub mod healthz;
```

``` {.rust file=crates/app/src/bin/eestock-data.rs}
//! eestock-data —— 数据面进程（采集 + 降级模式 + 缺口回填 + tushare 日增量 + /healthz）。

use app::{config, healthz};
use collector::circuit::CircuitRegistry;
use collector::executor::FetchExecutor;
use collector::gapfill::GapBackfiller;
use collector::service::CollectorService;
use collector::standby::StandbyReserve;
use domain::ports::{Clock, EventSink, KlineWriter, RawBarReader, SystemClock, SymbolRegistry};
use domain::provider::{MinuteKlineProvider, SnapshotProvider};
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::SourceId;
use providers::http::{ReqwestHttp, DEFAULT_TIMEOUT, EASTMONEY_TIMEOUT};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // compose healthcheck 子命令（运行时镜像无 curl/wget）
    if args.iter().any(|a| a == "--self-check") {
        let port: u16 = arg_val(&args, "--healthz-port")
            .and_then(|v| v.parse().ok())
            .or_else(|| std::env::var("HEALTHZ_PORT").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(8080);
        std::process::exit(if healthz::self_check(port) { 0 } else { 1 });
    }
    let config_path = arg_val(&args, "--config")
        .unwrap_or_else(|| "./config/data.toml".to_string());
    let cfg = config::load(&config_path)?;

    // JSON 日志（Trace ID 以 span/字段贯穿，03 §3）
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into()))
        .init();
    tracing::info!(config = %config_path, "eestock-data starting");

    let pool = PgPool::connect(&cfg.database_url).await?;
    // ADR-017：启动 schema 自检，缺失即拒绝启动
    storage::migrate_check::verify_schema(&pool).await?;
    tracing::info!("schema self-check ok");

    // ---- providers（Tier1 双源 + Tier2 快照池冷藏）----
    let http_default = Arc::new(ReqwestHttp::new(DEFAULT_TIMEOUT));
    let http_eastmoney = Arc::new(ReqwestHttp::new(EASTMONEY_TIMEOUT));
    let mut minute_providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>> = HashMap::new();
    minute_providers.insert(SourceId::TencentIfzq,
        Arc::new(providers::tencent_ifzq::TencentIfzq::new(http_default.clone())));
    minute_providers.insert(SourceId::SinaJsonp,
        Arc::new(providers::sina_jsonp::SinaJsonp::new(http_default.clone())));
    let snapshot_pool: Vec<Arc<dyn SnapshotProvider>> = vec![
        Arc::new(providers::tencent_qt::TencentQt::new(http_default.clone())),
        Arc::new(providers::sina_hq::SinaHq::new(http_default.clone())),
        Arc::new(providers::ths_cs::ThsCs::new(http_default.clone())),
        Arc::new(providers::push2delay::Push2delay::new(http_eastmoney)),
        Arc::new(providers::exchange::Exchange::new(http_default)),
    ];

    // ---- collector 装配 ----
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let sink: Arc<dyn EventSink> = Arc::new(storage::events::PgEventSink::new(pool.clone()));
    let writer: Arc<dyn KlineWriter> = Arc::new(storage::kline::RawKlineWriter::new(pool.clone()));
    let reader: Arc<dyn RawBarReader> = Arc::new(storage::kline::RawKlineWriter::new(pool.clone()));
    let registry: Arc<dyn SymbolRegistry> = Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone()));
    let tier1 = vec![SourceId::TencentIfzq, SourceId::SinaJsonp];
    let circuits = Arc::new(CircuitRegistry::new(tier1.clone(), clock.clone(), sink.clone()));
    let executor = Arc::new(FetchExecutor::new(
        minute_providers,
        SourceSelector::new(tier1.clone()),
        DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
        circuits, writer.clone(), sink.clone(), clock.clone()));
    let standby = Arc::new(StandbyReserve::new(snapshot_pool, clock.clone()));
    let gapfill = Arc::new(GapBackfiller::new(
        executor.clone(), reader, registry.clone(), clock.clone()));
    let svc = Arc::new(CollectorService::new(
        executor, standby, gapfill, registry, writer, clock.clone()));

    // ---- tushare 日增量（交易日 15:30 Asia/Shanghai）----
    if cfg.tushare_enabled {
        match &cfg.tushare_token {
            Some(token) if !token.is_empty() => {
                let client = tushare::client::TushareClient::with_config(
                    token.clone(), tushare::client::API_URL.to_string(),
                    chrono::Duration::milliseconds(cfg.tushare_interval_ms));
                let daily = Arc::new(tushare::daily::DailySync::new(
                    Arc::new(client),
                    Arc::new(tushare::daily::PgDailyStore::new(pool.clone())),
                    sink.clone(), clock.clone()));
                tokio::spawn(tushare::daily::run_forever(daily, clock.clone()));
                tracing::info!("tushare daily task enabled");
            }
            _ => tracing::warn!("tushare_enabled=true 但无 token（TUSHARE_TOKEN），日增量任务跳过"),
        }
    }

    // ---- /healthz（唯一端口，只读存活探测）----
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.healthz_port)).await?;
    tracing::info!(port = cfg.healthz_port, "healthz listening");
    tokio::spawn(healthz::serve(listener));

    tracing::info!("eestock-data started");
    svc.run().await
}

fn arg_val(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}
```

## 4. 测试（配置解析 + healthz 行为）

``` {.rust file=crates/app/tests/config_healthz.rs}
//! 配置解析与 healthz 行为测试。

use app::{config, healthz};

#[test]
fn config_parse_and_defaults() {
    let dir = std::env::temp_dir().join(format!("eestock-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("data.toml");
    std::fs::write(&p, r#"
database_url = "postgres://u:p@db:5432/eestock"
"#).unwrap();
    // env 覆盖测试与解析测试同进程：先暂存并清除真实 env（开发机可能 export 了 TUSHARE_TOKEN）
    let saved_db = std::env::var("DATABASE_URL").ok();
    let saved_tk = std::env::var("TUSHARE_TOKEN").ok();
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("TUSHARE_TOKEN");
    let cfg = config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg.database_url, "postgres://u:p@db:5432/eestock");
    assert!(cfg.tushare_enabled, "默认开启");
    assert_eq!(cfg.healthz_port, 8080);
    assert_eq!(cfg.tushare_interval_ms, 1000);
    assert!(cfg.tushare_token.is_none());
    // env 覆盖（secret 注入口径）
    std::env::set_var("DATABASE_URL", "postgres://override@h/db");
    std::env::set_var("TUSHARE_TOKEN", "tok123");
    let cfg2 = config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg2.database_url, "postgres://override@h/db");
    assert_eq!(cfg2.tushare_token.as_deref(), Some("tok123"));
    // 恢复真实 env
    match saved_db { Some(v) => std::env::set_var("DATABASE_URL", v), None => std::env::remove_var("DATABASE_URL") }
    match saved_tk { Some(v) => std::env::set_var("TUSHARE_TOKEN", v), None => std::env::remove_var("TUSHARE_TOKEN") }
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn healthz_serves_200_and_404() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(healthz::serve(listener));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    // self_check 为同步阻塞调用：spawn_blocking 避免饿死 current_thread runtime 上的 server 任务
    let ok = tokio::task::spawn_blocking(move || healthz::self_check(port)).await.unwrap();
    assert!(ok, "GET /healthz → 200");
    // 404 路径（同样走 blocking）
    let not_found = tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"GET /admin HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n").unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).unwrap();
        buf.starts_with(b"HTTP/1.1 404")
    }).await.unwrap();
    assert!(not_found, "无管理端点（ADR-017 最小攻击面）");
}

#[test]
fn self_check_false_when_down() {
    // 未监听端口 → false（compose healthcheck 失败语义）
    assert!(!healthz::self_check(59999));
}
```

## 5. Dockerfile（多阶段构建，运行时最小镜像）

``` {.dockerfile file=Dockerfile}
# Dockerfile — 数据面镜像（由 design/03-collector/02-data-plane.md tangle 生成，禁止手改）
# 多阶段：builder 编译 eestock-data；运行时 debian-slim 非 root 运行（ADR-017 最小攻击面）
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --bin eestock-data

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home eestock
COPY --from=builder /build/target/release/eestock-data /usr/local/bin/eestock-data
USER eestock
# 唯一端口：/healthz（ADR-017）
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/eestock-data"]
CMD ["--config", "/etc/eestock/data.toml"]
```

## 6. compose `data` 服务（docker-compose.yml 手写例外）

要点（已在 docker-compose.yml 落地）：

- `depends_on: timescaledb (condition: service_healthy)`——库健康才启动；
- `restart: unless-stopped`；healthcheck 用二进制自带 `--self-check`（镜像无 curl/wget）；
- 配置 `./config/data.toml` 只读挂载（本地文件，.gitignore；模板 `config/data.toml.example` 入库）；
- `TUSHARE_TOKEN` 经环境变量注入（compose 从宿主机 env 透传，不落文件）；
- `docker compose up -d` 一条命令起 timescaledb + data 全栈。
