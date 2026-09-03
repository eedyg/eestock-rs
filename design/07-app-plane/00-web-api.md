# 07-app-plane / 00 — 应用面 Web API（web / diagnose / eestock-app / 部署）

> 本文档 tangle 生成：
> `crates/diagnose/src/{lib,health}.rs`、`crates/diagnose/tests/health_agg.rs`、
> `crates/storage/src/reader.rs`、`crates/storage/tests/kline_reader.rs`、
> `crates/web/src/{lib,dto,state,rest,ws,spa}.rs`、`crates/web/tests/{api_rest,ws_poller}.rs`、
> `crates/app/src/app_config.rs`、`crates/app/src/bin/eestock-app.rs`、`crates/app/tests/app_config.rs`、
> `Dockerfile.app`。
>
> 决策依据：ADR-017（部署双面分离：应用面与数据面零 API 直连，唯一耦合点 = TimescaleDB，全部读库）、
> ADR-008（axum 栈）、ADR-010（免认证内网）、wave-1.md 2026-09-04 实施定稿（Phase A 后端）。
>
> **数据面零改动**：collector/providers/tushare/storage 写入路径一行不动。仅有三处父级授权的加法扩展：
> ① `storage::reader`（只读查询模块，本节 §3）；② `app` crate 增加 `app_config` 模块与 `eestock-app` bin
> （`crates/app/src/lib.rs` 的 `pub mod app_config;` 声明维护在 design/03-collector/02-data-plane.md，
> 同理 `storage` lib.rs 的 `pub mod reader;` 声明维护在 design/04-storage/02-tushare-sync.md——均为纯加法）；
> ③ 无 domain 改动。
>
> 手写例外（不 tangle，README 既定口径）：`docker-compose.yml`（app 服务）、`config/app.toml.example`、
> 各 crate `Cargo.toml`、`.dockerignore`。
>
> ⚠️ 2026-09-04 审查返工记录（父级裁决，已执行）：
> ① **分层红线修复**——web 不再依赖 storage、diagnose 不再依赖 sqlx：domain::ports 增加只读端口
> `KlineRead` / `HealthEventsRead` + 读模型（KlineBarView / SymbolLatestView / HealthEventRow）
> （02-domain/contracts.md §2.4 纯加法）；storage 的 `KlineReader`/`HealthEventReader` 实现端口；
> diagnose 聚合下沉为纯函数 `aggregate_events`（口径不变）+ `HealthService` 端口注入；
> web handlers/Poller 只依赖 domain 端口与 diagnose 服务；storage/sqlx 仅在 web 的 dev-dependencies
> （集成测试装配与造数）。验证：`cargo tree -p web -e normal` 无 storage/sqlx、`-p diagnose` 无 sqlx。
> ② **Dockerfile.app 自包含**——新增 node:22 frontend 阶段（npm ci → npm run build），dist 由镜像内
> 构建产出，不再依赖构建上下文预存 dist；前端 dist 产物不入库（web/.gitignore 已含 dist/）。

## 1. 端点契约

### 1.1 REST

| 方法/路径 | 参数 | 响应 | 数据源 | 错误态 |
|---|---|---|---|---|
| `GET /healthz` | — | `{"status":"ok"}` | 静态 | —（compose healthcheck 经 `--self-check` 调此路由） |
| `GET /api/kline` | `code`（必填）、`period=1m\|5m\|15m\|1h\|1d`（默认 `1m`）、`before`（RFC3339 游标，不含该 ts 的更早一页）、`limit`（默认 240，封顶 1000） | `{"code","period","bars":[{ts,open,high,low,close,volume,amount,source?}],"next_before"}`；bars **升序**（图表口径）；`next_before`=本页最旧 ts，`null`=无更早数据 | 1m=`kline_merged` 合并视图（准确层优先，ADR-003）；5m/15m/1d=对应 cagg（ADR-004）；1h=`kline_15m` 查询期 rollup（schema 未建 kline_1h cagg，rollup 语义等价） | 400：`code` 空 / `period` 非法 / `before` 非 RFC3339；500 JSON `{"error":...}` |
| `GET /api/symbols` | — | `[{code,name,interval_secs,settlement,enabled,latest:{ts,last,change_pct}\|null}]`；`change_pct`=相对前一根 merge bar 收盘（%），无前值/无 bar → null | `symbols` + `kline_merged` 每 code 最近 2 根（LATERAL） | 500 |
| `GET /api/sources/health` | `window_secs`（默认 3600 = 页面② `SOURCES_DEFAULTS.successRateWindow='1h'`，钳制 60..604800） | `{"window_secs","sources":[{source,attempts,successes,success_rate,p50_ms,p95_ms,circuit_state,status,last_error,last_event_ts}]}`；`success_rate` 分母**排除 `err_kind='na'`**（03 §7），分母 0 → `null` | `source_health_events` 窗口聚合（diagnose crate，05-diagnose §1 口径） | 500 |

字段口径（diagnose，05-diagnose §1 实现 Wave 1 最小集）：

- `circuit_state`：窗口内最近一条熔断迁移事件推导——`circuit_open`→`open`、`circuit_halfopen`→`half_open`、`circuit_closed`/`manual_reset`/无 → `closed`。
- `status` 状态灯：`open`→`circuit_open`；成功率 <95%→`degraded`；否则 `healthy`（非交易时段窗口内全 na → 分母 0 → `healthy`，源可达口径）。
- `last_error`：窗口内最近一条**非熔断迁移类**失败事件（`circuit_*`/`manual_reset` 不占最近错误位，它们是状态不是抓取错误）。
- `p50_ms`/`p95_ms`：窗口内 `ok=true` 且 `latency_ms` 非空事件的 `percentile_cont`（05 §1）。
- 窗口内无事件的源不出现在 `sources` 中（应用面不知编译期源清单；前端对缺失源按无数据渲染）。

### 1.2 WS `/ws`（订阅分发；断线指数退避重连由客户端负责，00-shell 既定）

客户端帧（JSON 文本帧，坏帧忽略——免认证内网 ADR-010）：

```json
{"type":"subscribe","topic":"bar","code":"518880","period":"1m"}
{"type":"unsubscribe","topic":"quote","code":"518880"}
```

- `topic`：`"bar" | "quote" | "health"`；`code`/`period` 省略 = 通配（该 topic 全量）。
- `bar` 订阅 `period` 必填（服务端据此决定轮询哪个周期）。

服务端推送帧（serde 内部 tag，`type` 平铺）：

```json
{"type":"bar","code":"518880","period":"1m","bar":{ts,open,high,low,close,volume,amount,"source"?}}
{"type":"quote","code":"518880","ts":"...","last":1.234,"change_pct":0.12}
{"type":"health","window_secs":3600,"sources":[SourceHealth...]}
```

**推送源 = 轮询**（ADR-017 铁律：应用面只读库，无数据面直连、无 NOTIFY 触发器）：Poller 按
`ws_poll_ms`（默认 3000）周期——对每个活跃 bar 订阅 (code,period) 取最新 bar，ts 前进才推；
任一 quote 订阅存在则推全量快照增量（连接侧按 code 过滤）；health 窗口聚合 `last_event_ts`
前进则整快照推。游标在 Poller 内存（进程级），重启重推一次最新值，无害。
broadcast lagged 丢帧由客户端重连/REST 重拉兜底。

### 1.3 SPA 静态托管

`web/dist` 存在即服务（按扩展名给 Content-Type）；未命中文件回退 `index.html`（history 路由深链）；
路径含 `..`/反斜杠/空段 → 400（防目录穿越）；dist 缺失 → 503 文本占位（Phase A 为占位页，Phase B 构建产物覆盖）。
不引 tower-http：手写 ~60 行（ADR-017 最小攻击面同口径；零新增依赖）。

### 1.4 明确不做（Phase A 边界）

`POST/PATCH /api/symbols`、`/api/sources/{id}/metrics|events|divergence|reset`、`/api/collection/gaps`、
`/api/alerts*`（02-sources §8 / 03-symbols §6 所列其余端点）→ Phase B/C 或 Wave 2，本阶段不实现。
WS topic 名采用任务书口径 `"health"`（02-sources 文档中 `"source_health"` 为同一通道，前端适配层映射）。

## 2. diagnose crate：健康聚合查询（Application 层纯服务，端口注入）

分层红线：diagnose **不依赖 sqlx**。窗口事件经 `domain::ports::HealthEventsRead` 注入，
聚合逻辑为纯函数 `aggregate_events`（可离线 TDD）；`HealthService` 只做「读端口 → 纯函数」编排。
SQL 窗口读取下沉 storage（`HealthEventReader`），聚合口径与初版 SQL 版一致（测试锁定相同断言）。

``` {.rust file=crates/diagnose/src/lib.rs}
//! diagnose —— 应用层：健康指标聚合查询（读 source_health_events，03 §7 / 05 §1 口径）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

pub mod health;
```

``` {.rust file=crates/diagnose/src/health.rs}
//! 源健康窗口聚合（纯应用服务）：成功率（分母排除 err_kind='na'，03 §7）、延迟分位数、熔断态、最近错误。
//! 分层红线（Phase A 审查返工）：diagnose 不依赖 sqlx——窗口事件经 domain::ports::HealthEventsRead
//! 注入，聚合为纯函数（可离线 TDD；口径与初版 SQL 聚合一致，05 §1）。

use anyhow::Result;
use chrono::{DateTime, Utc};
use domain::ports::{HealthEventRow, HealthEventsRead};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// 熔断状态（由窗口内最近一条熔断迁移事件推导）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitState { Closed, HalfOpen, Open }

/// 状态灯（05 §1）：Healthy=无熔断且成功率≥95%（或无统计事件）；Degraded=<95%；CircuitOpen=熔断中。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusLight { Healthy, Degraded, CircuitOpen }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastError {
    pub err_kind: Option<String>,
    pub ts: DateTime<Utc>,
    pub code: Option<String>,   // 触发标的（源级事件为 None）
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceHealth {
    pub source: String,
    pub window_secs: i64,
    /// 成功率分母：窗口内非 na 事件数（03 §7：na=非交易时段可达，不入分母）。
    pub attempts: i64,
    pub successes: i64,
    /// attempts=0 → None（无统计意义，前端显示 —）。
    pub success_rate: Option<f64>,
    /// 延迟分位数：窗口内 ok=true 且 latency_ms 非空事件（05 §1；na 事件延迟照计）。
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub circuit_state: CircuitState,
    pub status: StatusLight,
    pub last_error: Option<LastError>,
    pub last_event_ts: Option<DateTime<Utc>>,
}

pub fn success_rate(successes: i64, attempts: i64) -> Option<f64> {
    if attempts <= 0 { None } else { Some(successes as f64 / attempts as f64) }
}

pub fn circuit_state_of(last_kind: Option<&str>) -> CircuitState {
    match last_kind {
        Some("circuit_open") => CircuitState::Open,
        Some("circuit_halfopen") => CircuitState::HalfOpen,
        // circuit_closed / manual_reset / 无迁移事件 → 闭合
        _ => CircuitState::Closed,
    }
}

pub fn status_of(circuit: CircuitState, rate: Option<f64>) -> StatusLight {
    match circuit {
        CircuitState::Open => StatusLight::CircuitOpen,
        _ => match rate {
            Some(r) if r < 0.95 => StatusLight::Degraded,
            _ => StatusLight::Healthy,
        },
    }
}

/// percentile_cont（PG 线性插值口径）：p∈[0,1]，空样本 → None。
pub fn percentile_cont(xs: &[f64], p: f64) -> Option<f64> {
    if xs.is_empty() { return None; }
    let mut v = xs.to_vec();
    v.sort_by(f64::total_cmp);
    let rank = p * (v.len() - 1) as f64;
    let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
    Some(v[lo] + (v[hi] - v[lo]) * (rank - lo as f64))
}

fn is_na(e: &HealthEventRow) -> bool { e.err_kind.as_deref() == Some("na") }

/// 熔断迁移类事件（circuit_* / manual_reset）：是状态不是抓取错误，不占 last_error 位。
fn is_circuit_migration(e: &HealthEventRow) -> bool {
    matches!(e.err_kind.as_deref(),
        Some("circuit_open") | Some("circuit_halfopen")
        | Some("circuit_closed") | Some("manual_reset"))
}

/// 窗口聚合纯函数（diagnose 唯一业务逻辑）：
/// 按 source 归组排序 → 计数（na 出分母）→ 分位数 → 熔断态（最近迁移事件）→ 最近非迁移错误。
pub fn aggregate_events(window_secs: i64, events: Vec<HealthEventRow>) -> Vec<SourceHealth> {
    let mut by_source: HashMap<String, Vec<HealthEventRow>> = HashMap::new();
    for e in events { by_source.entry(e.source.clone()).or_default().push(e); }
    let mut out: Vec<SourceHealth> = by_source.into_iter().map(|(source, mut evs)| {
        evs.sort_by_key(|e| e.ts);
        let attempts = evs.iter().filter(|e| !is_na(e)).count() as i64;
        let successes = evs.iter().filter(|e| e.ok && !is_na(e)).count() as i64;
        let lats: Vec<f64> = evs.iter()
            .filter(|e| e.ok && e.latency_ms.is_some())
            .map(|e| e.latency_ms.expect("filtered") as f64)
            .collect();
        let rate = success_rate(successes, attempts);
        let circuit = circuit_state_of(evs.iter().rev().find(|e| is_circuit_migration(e))
            .and_then(|e| e.err_kind.as_deref()));
        let last_error = evs.iter().rev()
            .find(|e| !e.ok && !is_circuit_migration(e))
            .map(|e| LastError { err_kind: e.err_kind.clone(), ts: e.ts, code: e.code.clone() });
        SourceHealth {
            source, window_secs, attempts, successes,
            success_rate: rate,
            p50_ms: percentile_cont(&lats, 0.5),
            p95_ms: percentile_cont(&lats, 0.95),
            circuit_state: circuit,
            status: status_of(circuit, rate),
            last_error,
            last_event_ts: evs.last().map(|e| e.ts),
        }
    }).collect();
    out.sort_by(|a, b| a.source.cmp(&b.source));
    out
}

/// 健康查询服务（Application）：注入只读端口；聚合全部走纯函数。
pub struct HealthService {
    reader: Arc<dyn HealthEventsRead>,
}

impl HealthService {
    pub fn new(reader: Arc<dyn HealthEventsRead>) -> Self { Self { reader } }

    /// REST /api/sources/health 与 WS health 推送共用入口。
    pub async fn aggregate(&self, window_secs: i64) -> Result<Vec<SourceHealth>> {
        let events = self.reader.window_events(window_secs).await?;
        Ok(aggregate_events(window_secs, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_rate_denominator_semantics() {
        assert_eq!(success_rate(2, 3), Some(2.0 / 3.0));
        assert_eq!(success_rate(0, 0), None, "窗口内无统计事件（全 na）→ None");
        assert_eq!(success_rate(0, 3), Some(0.0));
    }

    #[test]
    fn circuit_state_mapping() {
        assert_eq!(circuit_state_of(Some("circuit_open")), CircuitState::Open);
        assert_eq!(circuit_state_of(Some("circuit_halfopen")), CircuitState::HalfOpen);
        assert_eq!(circuit_state_of(Some("circuit_closed")), CircuitState::Closed);
        assert_eq!(circuit_state_of(Some("manual_reset")), CircuitState::Closed, "手动复位 → 闭合");
        assert_eq!(circuit_state_of(None), CircuitState::Closed);
    }

    #[test]
    fn status_light_matrix() {
        assert_eq!(status_of(CircuitState::Open, Some(1.0)), StatusLight::CircuitOpen);
        assert_eq!(status_of(CircuitState::HalfOpen, Some(0.99)), StatusLight::Healthy);
        assert_eq!(status_of(CircuitState::Closed, Some(0.94)), StatusLight::Degraded, "05 §1 边界 95%");
        assert_eq!(status_of(CircuitState::Closed, Some(0.95)), StatusLight::Healthy);
        assert_eq!(status_of(CircuitState::Closed, None), StatusLight::Healthy,
            "无统计事件（非交易时段全 na）不算降级");
    }

    #[test]
    fn percentile_cont_pg_linear_interpolation() {
        assert_eq!(percentile_cont(&[], 0.5), None);
        assert_eq!(percentile_cont(&[42.0], 0.95), Some(42.0));
        assert_eq!(percentile_cont(&[100.0, 300.0], 0.5), Some(200.0));
        assert_eq!(percentile_cont(&[100.0, 300.0], 0.95), Some(290.0),
            "与 PG percentile_cont 线性插值一致（rank=p*(n-1)）");
        // 乱序输入
        assert_eq!(percentile_cont(&[300.0, 100.0, 200.0], 0.5), Some(200.0));
    }
}
```

集成测试（需 TimescaleDB :5433；独立 source 名 + 前后清理，可重入）：

``` {.rust file=crates/diagnose/tests/health_agg.rs}
//! 健康窗口聚合测试（Phase A 返工：聚合为纯函数，无 DB；DB 读路径由 storage 端口测试锁定，
//! 端到端由 web 集成测试 /api/sources/health 锁定）。

use chrono::{Duration, TimeZone, Utc};
use diagnose::health::{aggregate_events, CircuitState, HealthService, SourceHealth, StatusLight};
use domain::ports::{HealthEventRow, HealthEventsRead};

fn ev_for(src: &str, secs_ago: i64, ok: bool, latency: Option<i32>, err: Option<&str>) -> HealthEventRow {
    HealthEventRow {
        ts: Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap() - Duration::seconds(secs_ago),
        source: src.into(), ok, latency_ms: latency, err_kind: err.map(Into::into), code: None,
    }
}

fn one<'a>(rows: &'a [SourceHealth], src: &str) -> &'a SourceHealth {
    rows.iter().find(|r| r.source == src).expect("聚合结果含测试源")
}

#[test]
fn success_rate_excludes_na_and_percentiles() {
    let src = "diag_test_rate";
    let mut events = vec![
        ev_for(src, 100, true, Some(100), None),
        ev_for(src, 90, true, Some(300), None),
        ev_for(src, 80, false, None, Some("timeout")),
    ];
    for i in 0..3 { events.push(ev_for(src, 70 - i, true, None, Some("na"))); }

    let rows = aggregate_events(3600, events);
    let h = one(&rows, src);
    assert_eq!(h.attempts, 3, "na 不入分母（03 §7）");
    assert_eq!(h.successes, 2);
    assert!((h.success_rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
    assert_eq!(h.p50_ms, Some(200.0));
    assert_eq!(h.p95_ms, Some(290.0), "percentile_cont 线性插值口径");
    assert_eq!(h.last_error.as_ref().unwrap().err_kind.as_deref(), Some("timeout"));
    assert_eq!(h.circuit_state, CircuitState::Closed);
    assert_eq!(h.status, StatusLight::Degraded, "0.667 < 0.95");
}

#[test]
fn circuit_state_from_latest_migration_and_last_error_excludes_migrations() {
    let src = "diag_test_circuit";
    let events = vec![
        ev_for(src, 50, false, None, Some("http")),
        ev_for(src, 40, false, None, Some("circuit_open")),
    ];
    let rows = aggregate_events(3600, events);
    let h = one(&rows, src);
    assert_eq!(h.circuit_state, CircuitState::Open);
    assert_eq!(h.status, StatusLight::CircuitOpen);
    assert_eq!(h.last_error.as_ref().unwrap().err_kind.as_deref(), Some("http"),
        "熔断迁移事件不占最近错误位（是状态不是抓取错误）");

    // 手动复位 → 闭合
    let events2 = vec![
        ev_for(src, 50, false, None, Some("http")),
        ev_for(src, 40, false, None, Some("circuit_open")),
        ev_for(src, 30, false, None, Some("manual_reset")),
    ];
    assert_eq!(one(&aggregate_events(3600, events2), src).circuit_state,
        CircuitState::Closed, "手动复位 → 闭合");
}

#[test]
fn healthy_when_all_ok_and_multi_source_sorted() {
    let events = vec![
        ev_for("b_src", 20, true, Some(80), None),
        ev_for("a_src", 20, true, None, None),
        ev_for("a_src", 10, true, Some(200), None),
    ];
    let rows = aggregate_events(3600, events);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].source, "a_src", "输出按 source 排序");
    assert_eq!(rows[1].source, "b_src");
    let a = one(&rows, "a_src");
    assert_eq!(a.success_rate, Some(1.0));
    assert_eq!(a.status, StatusLight::Healthy);
    assert_eq!(a.p50_ms, Some(200.0), "仅 ok 且带 latency 的事件计入分位数");
}

/// HealthService 经 domain 端口注入（mock 读端，证明 diagnose 与 storage 解耦）。
struct MockEvents(Vec<HealthEventRow>);

#[async_trait::async_trait]
impl HealthEventsRead for MockEvents {
    async fn window_events(&self, _window_secs: i64) -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn health_service_aggregates_via_injected_port() {
    let svc = HealthService::new(std::sync::Arc::new(MockEvents(
        vec![ev_for("mock_src", 10, true, Some(80), None)])));
    let rows = svc.aggregate(3600).await.unwrap();
    assert_eq!(one(&rows, "mock_src").success_rate, Some(1.0));
}
```

## 3. storage 只读加法扩展（KlineReader）

父级授权口径：「storage 读接口如需加法扩展可以」。`reader.rs` 为纯新增文件，写路径（kline.rs /
accurate.rs / events.rs / symbols.rs）零改动；`pub mod reader;` 声明维护在 04-storage/02-tushare-sync.md。
审查返工后：`KlineReader`/`HealthEventReader` 实现 domain 只读端口（`KlineRead`/`HealthEventsRead`），
消费方（web/diagnose）不反向依赖本 crate。

- 1m 读 `kline_merged`（准确层优先语义由视图承载，ADR-003，与 domain merge.rs 契约一致）；
- 5m/15m/1d 直读对应 cagg（⚠️ cagg `volume` 列为 numeric，`::bigint` 归一；`amount` 恒 double）；
- 1h 由 `kline_15m` 查询期 rollup（schema 未建 kline_1h cagg；`first/last` 为 timescaledb 聚合，普通查询可用）；
- 表名只经内部 match 映射常量拼接，不接受外部输入（无注入面）。

``` {.rust file=crates/storage/src/reader.rs}
//! 应用面只读扩展（Wave 1 Phase A 加法，ADR-017 授权口径；写入路径零改动）：
//! 实现 domain::ports::{KlineRead, HealthEventsRead}（分层红线：web/diagnose 只依赖 domain 端口）。
//! - 1m：kline_merged 合并视图（准确层优先，ADR-003）
//! - 5m/15m/1d：连续聚合直读（ADR-004）
//! - 1h：kline_15m rollup（schema 未建 kline_1h cagg，查询期聚合语义等价）
//! - symbols + 最新快照（REST /api/symbols latest 字段与 WS quote 推送数据源）
//! - source_health_events 窗口读取（diagnose 聚合输入）

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{HealthEventRow, HealthEventsRead, KlineBarView, KlineRead, SymbolLatestView};
use domain::types::Period;
use sqlx::PgPool;

type BarTuple = (String, DateTime<Utc>, f64, f64, f64, f64, i64, f64, Option<String>);

const MERGED_1M_SQL: &str = r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM kline_merged
WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
ORDER BY ts DESC LIMIT $3
"#;

/// cagg 无 source 列（以 NULL 归一行型）；volume 为 numeric → ::bigint。
/// 表名只经 KlineRead::bars 内部 match 映射常量传入，不接受外部输入（无注入面）。
fn cagg_sql(table: &str) -> String {
    format!("
SELECT code, ts, open, high, low, close, volume::bigint AS volume, amount, NULL::text AS source
FROM {table}
WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
ORDER BY ts DESC LIMIT $3")
}

const ROLLUP_1H_SQL: &str = r#"
SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low, last(close, ts) AS close,
       sum(volume)::bigint AS volume, sum(amount) AS amount, NULL::text AS source
FROM kline_15m
WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
GROUP BY code, time_bucket('1 hour', ts)
ORDER BY ts DESC LIMIT $3
"#;

/// 每 code 最近 2 根 merge bar（LATERAL，避免全表窗口）；prev_close = 前一根收盘。
const SYMBOLS_LATEST_SQL: &str = r#"
SELECT s.code, s.name, s.interval_secs, s.settlement, s.enabled,
       l.ts AS last_ts, l.close AS last_close, l.prev_close
FROM symbols s
LEFT JOIN LATERAL (
    SELECT ts, close, lag(close) OVER (ORDER BY ts) AS prev_close
    FROM (
        SELECT ts, close FROM kline_merged m
        WHERE m.code = s.code
        ORDER BY ts DESC LIMIT 2
    ) latest2
    ORDER BY ts DESC LIMIT 1
) l ON true
ORDER BY s.code
"#;

const WINDOW_EVENTS_SQL: &str = r#"
SELECT ts, source, ok, latency_ms, err_kind, code
FROM source_health_events
WHERE ts > now() - make_interval(secs => $1)
ORDER BY source, ts
"#;

/// K线只读端口实现（PgPool）。
pub struct KlineReader {
    pool: PgPool,
}

impl KlineReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl KlineRead for KlineReader {
    /// ts < before（None=最新起），降序取 limit 行后翻转**升序**返回（图表口径）。
    async fn bars(&self, period: Period, code: &str,
                  before: Option<DateTime<Utc>>, limit: i64) -> Result<Vec<KlineBarView>> {
        let sql = match period {
            Period::M1 => MERGED_1M_SQL.to_string(),
            Period::M5 => cagg_sql("kline_5m"),
            Period::M15 => cagg_sql("kline_15m"),
            Period::H1 => ROLLUP_1H_SQL.to_string(),
            Period::D1 => cagg_sql("kline_1d"),
        };
        let rows: Vec<BarTuple> = sqlx::query_as(&sql)
            .bind(code).bind(before).bind(limit)
            .fetch_all(&self.pool).await?;
        let mut bars: Vec<KlineBarView> = rows.into_iter().map(
            |(code, ts, open, high, low, close, volume, amount, source)|
            KlineBarView { code, ts, open, high, low, close, volume, amount, source }
        ).collect();
        bars.reverse();
        Ok(bars)
    }

    /// 注册表 + 最新快照（涨跌幅 = (last − prev_close) / prev_close，由调用方计算）。
    async fn symbols_with_latest(&self) -> Result<Vec<SymbolLatestView>> {
        type Row = (String, Option<String>, i32, String, bool,
                    Option<DateTime<Utc>>, Option<f64>, Option<f64>);
        let rows: Vec<Row> = sqlx::query_as(SYMBOLS_LATEST_SQL).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(
            |(code, name, interval_secs, settlement, enabled, last_ts, last_close, prev_close)|
            SymbolLatestView { code, name, interval_secs, settlement, enabled,
                               last_ts, last_close, prev_close }
        ).collect())
    }
}

/// 健康事件窗口读取（diagnose 聚合输入；HealthEventsRead 实现）。
pub struct HealthEventReader {
    pool: PgPool,
}

impl HealthEventReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl HealthEventsRead for HealthEventReader {
    async fn window_events(&self, window_secs: i64) -> Result<Vec<HealthEventRow>> {
        type Row = (DateTime<Utc>, String, bool, Option<i32>, Option<String>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(WINDOW_EVENTS_SQL)
            .bind(window_secs as f64).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(ts, source, ok, latency_ms, err_kind, code)|
            HealthEventRow { ts, source, ok, latency_ms, err_kind, code }
        ).collect())
    }
}
```

``` {.rust file=crates/storage/tests/kline_reader.rs}
//! KlineReader 只读集成测试（需 TimescaleDB :5433）：merge 准确层优先、游标分页、cagg/1h rollup、最新快照。

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{HealthEventsRead, KlineRead};
use domain::types::Period;
use sqlx::PgPool;
use storage::reader::{HealthEventReader, KlineReader};

// 每测试独立 code：同 binary 测试并行执行，共享 code 会被彼此的 clean 误删（实锤踩坑）。
const CODE_MERGE: &str = "997701";
const CODE_CAGG: &str = "997711";
const CODE_SYM: &str = "997721";
const CODE_SYM_EMPTY: &str = "997722";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool, code: &str) {
    for t in ["kline_raw", "kline_accurate", "symbols"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(code).execute(pool).await.unwrap();
    }
}

/// 5 根 1m raw bar（收盘 1..5，各 100 股）+ base+1min 处准确层覆盖（收盘 9.99，777 股）。
async fn seed(pool: &PgPool, code: &str) {
    for i in 0..5i64 {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 'M1', 9.99, 9.99, 9.99, 9.99, 777, 777.0, 'tushare') \
                 ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
        .bind(code).bind(base() + Duration::minutes(1))
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn merged_1m_accurate_first_and_cursor_pagination() {
    let pool = pool().await;
    clean(&pool, CODE_MERGE).await;
    seed(&pool, CODE_MERGE).await;
    let r = KlineReader::new(pool.clone());

    let bars = r.bars(Period::M1, CODE_MERGE, None, 10).await.unwrap();
    assert_eq!(bars.len(), 5);
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "升序返回（图表口径）");
    assert_eq!(bars[1].close, 9.99, "准确层优先（ADR-003 merge 视图）");
    assert_eq!(bars[1].volume, 777);
    assert_eq!(bars[1].source.as_deref(), Some("tushare"));
    assert_eq!(bars[4].close, 5.0);
    assert_eq!(bars[4].source.as_deref(), Some("tencent_ifzq"));

    // 游标：before 不含该 ts 本身
    let page = r.bars(Period::M1, CODE_MERGE, Some(base() + Duration::minutes(3)), 10).await.unwrap();
    assert_eq!(page.iter().map(|b| b.close).collect::<Vec<_>>(), vec![1.0, 9.99, 3.0]);

    // limit 降序取后翻转
    let top2 = r.bars(Period::M1, CODE_MERGE, None, 2).await.unwrap();
    assert_eq!(top2.iter().map(|b| b.close).collect::<Vec<_>>(), vec![4.0, 5.0]);
    assert_eq!(r.latest_bar(Period::M1, CODE_MERGE).await.unwrap().unwrap().close, 5.0);
    assert!(r.latest_bar(Period::M1, "000000").await.unwrap().is_none());
    clean(&pool, CODE_MERGE).await;
}

#[tokio::test]
async fn cagg_periods_and_1h_rollup() {
    let pool = pool().await;
    clean(&pool, CODE_CAGG).await;
    seed(&pool, CODE_CAGG).await;
    for v in ["kline_5m", "kline_15m", "kline_1d"] {
        sqlx::query(&format!("CALL refresh_continuous_aggregate('{v}', NULL, NULL)"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    for p in [Period::M5, Period::M15, Period::H1, Period::D1] {
        let bars = r.bars(p, CODE_CAGG, None, 10).await.unwrap();
        assert_eq!(bars.len(), 1, "{p:?} 一个桶");
        assert_eq!(bars[0].open, 1.0);
        assert_eq!(bars[0].close, 5.0);
        assert_eq!(bars[0].volume, 500, "cagg volume numeric → bigint 归一");
        assert!(bars[0].source.is_none(), "cagg 无来源列");
    }
    clean(&pool, CODE_CAGG).await;
}

#[tokio::test]
async fn symbols_with_latest_snapshot() {
    let pool = pool().await;
    clean(&pool, CODE_SYM).await;
    clean(&pool, CODE_SYM_EMPTY).await;
    seed(&pool, CODE_SYM).await;
    for (c, n) in [(CODE_SYM, "测试ETF"), (CODE_SYM_EMPTY, "无数据ETF")] {
        sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, $2) \
                     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
            .bind(c).bind(n).execute(&pool).await.unwrap();
    }
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();

    let s = rows.iter().find(|r| r.code == CODE_SYM).expect("含测试标的");
    assert_eq!(s.name.as_deref(), Some("测试ETF"));
    assert_eq!(s.last_close, Some(5.0));
    assert_eq!(s.prev_close, Some(4.0), "前一根 bar 收盘（涨跌幅输入）");
    assert!(s.last_ts.is_some());

    let empty = rows.iter().find(|r| r.code == CODE_SYM_EMPTY).expect("含无数据标的");
    assert!(empty.last_ts.is_none() && empty.last_close.is_none() && empty.prev_close.is_none(),
        "无 bar 标的 latest 字段全空（前端 — 占位）");
    clean(&pool, CODE_SYM).await;
    clean(&pool, CODE_SYM_EMPTY).await;
}

#[tokio::test]
async fn window_events_filters_window_and_maps_fields() {
    const SRC: &str = "storage_test_events";
    let pool = pool().await;
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
    let now = Utc::now();
    let rows_in = [
        (now - Duration::seconds(20), true, Some(120), None, None),
        (now - Duration::seconds(10), false, None, Some("timeout"), Some("518880")),
        (now - Duration::hours(2), true, Some(50), None, None),   // 窗口外
    ];
    for (ts, ok, lat, err, code) in rows_in {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms, err_kind, code) \
                     VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(ts).bind(SRC).bind(ok).bind(lat).bind(err).bind(code)
            .execute(&pool).await.unwrap();
    }
    let all = HealthEventReader::new(pool.clone()).window_events(3600).await.unwrap();
    let mine: Vec<_> = all.iter().filter(|r| r.source == SRC).collect();
    assert_eq!(mine.len(), 2, "窗口外事件不入选");
    assert!(mine[0].ts < mine[1].ts, "按 ts 升序");
    assert!(mine[0].ok && mine[0].latency_ms == Some(120) && mine[0].err_kind.is_none());
    assert!(!mine[1].ok && mine[1].err_kind.as_deref() == Some("timeout"));
    assert_eq!(mine[1].code.as_deref(), Some("518880"), "触发标的字段透传");
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
}
```

## 4. web crate（Presentation 层）

``` {.rust file=crates/web/src/lib.rs}
//! web —— Presentation：axum REST + WebSocket + SPA 静态托管（应用面，ADR-017）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

pub mod dto;
pub mod rest;
pub mod spa;
pub mod state;
pub mod ws;

use axum::{routing::get, Router};
use std::sync::Arc;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/healthz", get(rest::healthz))
        .route("/api/kline", get(rest::get_kline))
        .route("/api/symbols", get(rest::get_symbols))
        .route("/api/sources/health", get(rest::get_sources_health))
        .route("/ws", get(ws::ws_handler))
        .fallback(spa::spa_fallback)
        .with_state(state)
}
```

``` {.rust file=crates/web/src/dto.rs}
//! REST/WS 线格式（serde DTO）与查询参数校验纯函数。

use chrono::{DateTime, Utc};
use domain::ports::{KlineBarView, SymbolLatestView};
use domain::types::Period;
use serde::{Deserialize, Serialize};

pub const MAX_LIMIT: i64 = 1000;

fn default_period() -> String { "1m".into() }
fn default_limit() -> i64 { 240 }
fn default_window() -> i64 { 3600 }

/// GET /api/kline 查询参数：before=游标（不含该 ts 的更早一页），limit 封顶 1000。
#[derive(Debug, Deserialize)]
pub struct KlineQuery {
    pub code: String,
    #[serde(default = "default_period")]
    pub period: String,
    pub before: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

/// 前端周期口径（06-web/01-dashboard 定稿）：1m/5m/15m/1h/1d。
pub fn parse_period(s: &str) -> Option<Period> {
    match s {
        "1m" => Some(Period::M1),
        "5m" => Some(Period::M5),
        "15m" => Some(Period::M15),
        "1h" => Some(Period::H1),
        "1d" => Some(Period::D1),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BarDto {
    pub ts: DateTime<Utc>,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
    pub amount: f64,
    /// 仅 1m merge 视图带来源；cagg 序列化时省略该键。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl From<&KlineBarView> for BarDto {
    fn from(r: &KlineBarView) -> Self {
        BarDto {
            ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close,
            volume: r.volume, amount: r.amount, source: r.source.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KlineResponse {
    pub code: String,
    pub period: String,
    pub bars: Vec<BarDto>,
    /// 下一页游标（本页最旧 ts）；None = 没有更早数据。
    pub next_before: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatestDto {
    pub ts: DateTime<Utc>,
    pub last: f64,
    /// 相对前一根 merge bar 收盘（%）；无前值 → None。
    pub change_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SymbolDto {
    pub code: String,
    pub name: Option<String>,
    pub interval_secs: i32,
    pub settlement: String,
    pub enabled: bool,
    pub latest: Option<LatestDto>,
}

impl From<&SymbolLatestView> for SymbolDto {
    fn from(r: &SymbolLatestView) -> Self {
        let latest = r.last_close.map(|last| LatestDto {
            ts: r.last_ts.expect("last_close 伴随 last_ts（同行 LATERAL 查询）"),
            last,
            change_pct: r.prev_close.filter(|p| *p != 0.0)
                .map(|p| (last - p) / p * 100.0),
        });
        SymbolDto {
            code: r.code.clone(), name: r.name.clone(), interval_secs: r.interval_secs,
            settlement: r.settlement.clone(), enabled: r.enabled, latest,
        }
    }
}

/// GET /api/sources/health 查询参数。
#[derive(Debug, Deserialize)]
pub struct HealthQuery {
    #[serde(default = "default_window")]
    pub window_secs: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_period_front_contract() {
        assert_eq!(parse_period("1m"), Some(Period::M1));
        assert_eq!(parse_period("5m"), Some(Period::M5));
        assert_eq!(parse_period("15m"), Some(Period::M15));
        assert_eq!(parse_period("1h"), Some(Period::H1));
        assert_eq!(parse_period("1d"), Some(Period::D1));
        assert_eq!(parse_period("3m"), None);
        assert_eq!(parse_period("M1"), None, "domain 变体名不是前端口径");
    }

    #[test]
    fn kline_response_json_shape() {
        let resp = KlineResponse { code: "518880".into(), period: "1m".into(), bars: vec![],
            next_before: None };
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["code"], "518880");
        assert!(v["next_before"].is_null(), "无更早数据 → 显式 null（前端停拉信号）");
    }

    #[test]
    fn symbol_without_bars_serializes_null_latest() {
        let row = SymbolLatestView { code: "997702".into(), name: None, interval_secs: 60,
            settlement: "T1".into(), enabled: true,
            last_ts: None, last_close: None, prev_close: None };
        let v = serde_json::to_value(SymbolDto::from(&row)).unwrap();
        assert!(v["latest"].is_null());
    }
}
```

``` {.rust file=crates/web/src/state.rs}
//! 应用状态：DI 装配产物（app crate 注入具体实现）。
//! 分层红线（Phase A 审查返工）：web 只见 domain 端口 + diagnose 服务，不依赖 storage/sqlx。

use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    /// K线只读端口（domain::ports::KlineRead；具体实现由 app 装配，storage 提供）。
    pub kline: Arc<dyn domain::ports::KlineRead>,
    /// 健康查询服务（diagnose；内部注入 domain::ports::HealthEventsRead）。
    pub health: diagnose::health::HealthService,
    pub static_dir: PathBuf,
    /// /api/sources/health 与 WS health 推送的默认窗口（秒）。
    pub health_window_secs: i64,
    pub hub: crate::ws::WsHub,
    pub subs: crate::ws::SubscriptionRegistry,
}
```

``` {.rust file=crates/web/src/rest.rs}
//! REST 端点处理（契约见本文档 §1.1）。

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use std::sync::Arc;

use crate::dto::*;
use crate::state::AppState;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "rest handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// GET /healthz —— 存活探测（compose healthcheck 经 --self-check 调此路由）。
pub async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

pub async fn get_kline(State(st): State<Arc<AppState>>, Query(q): Query<KlineQuery>) -> Response {
    if q.code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 必填"); }
    let Some(period) = parse_period(&q.period) else {
        return err(StatusCode::BAD_REQUEST, "period 须为 1m/5m/15m/1h/1d");
    };
    let before = match q.before.as_deref() {
        None => None,
        Some(s) => match DateTime::parse_from_rfc3339(s) {
            Ok(t) => Some(t.with_timezone(&Utc)),
            Err(_) => return err(StatusCode::BAD_REQUEST, "before 须为 RFC3339 时间戳"),
        },
    };
    let limit = q.limit.clamp(1, MAX_LIMIT);
    match st.kline.bars(period, &q.code, before, limit).await {
        Ok(rows) => {
            // 取满一页 → 可能还有更早数据，游标 = 本页最旧 ts（bars 已升序）
            let next_before = if rows.len() as i64 == limit {
                rows.first().map(|r| r.ts)
            } else { None };
            Json(KlineResponse {
                code: q.code.clone(),
                period: q.period.clone(),
                bars: rows.iter().map(BarDto::from).collect(),
                next_before,
            }).into_response()
        }
        Err(e) => internal(e),
    }
}

pub async fn get_symbols(State(st): State<Arc<AppState>>) -> Response {
    match st.kline.symbols_with_latest().await {
        Ok(rows) => Json(rows.iter().map(SymbolDto::from).collect::<Vec<_>>()).into_response(),
        Err(e) => internal(e),
    }
}

pub async fn get_sources_health(State(st): State<Arc<AppState>>,
                                Query(q): Query<HealthQuery>) -> Response {
    let window = q.window_secs.clamp(60, 7 * 24 * 3600);
    match st.health.aggregate(window).await {
        Ok(sources) => Json(serde_json::json!({
            "window_secs": window,
            "sources": sources,
        })).into_response(),
        Err(e) => internal(e),
    }
}
```

``` {.rust file=crates/web/src/ws.rs}
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
pub enum Topic { Bar, Quote, Health }

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

/// 服务端推送帧：serde 内部 tag 平铺为 {"type":"bar"|"quote"|"health", ...}。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushMsg {
    Bar { code: String, period: String, bar: BarDto },
    Quote { code: String, ts: DateTime<Utc>, last: f64, change_pct: Option<f64> },
    Health { window_secs: i64, sources: Vec<diagnose::health::SourceHealth> },
}

/// 订阅匹配：topic 一致且（sub.code/period 为 None 通配或与消息相等）。
pub fn matches(sub: &Subscription, msg: &PushMsg) -> bool {
    let hit = |want: &Option<String>, got: &str| want.as_deref().is_none_or(|w| w == got);
    match (sub.topic, msg) {
        (Topic::Bar, PushMsg::Bar { code, period, .. }) => hit(&sub.code, code) && hit(&sub.period, period),
        (Topic::Quote, PushMsg::Quote { code, .. }) => hit(&sub.code, code),
        (Topic::Health, PushMsg::Health { .. }) => true,
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
```

``` {.rust file=crates/web/src/spa.rs}
//! SPA 静态托管：dist 存在即服务并回退 index.html（history 路由深链）；dist 缺失 → 503 占位。
//! 不引 tower-http（零新增依赖，ADR-017 最小攻击面同口径）。

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::AppState;

/// 未知路径兜底：静态文件 → SPA index.html → 503 占位。
pub async fn spa_fallback(State(st): State<Arc<AppState>>, uri: Uri) -> Response {
    serve_path(&st.static_dir, uri.path()).await
}

async fn serve_path(dir: &Path, req_path: &str) -> Response {
    match sanitize(req_path) {
        None => (StatusCode::BAD_REQUEST, "bad path").into_response(),
        Some(rel) => {
            let candidate = dir.join(&rel);
            if candidate.is_file() { return file_response(&candidate).await; }
            let index = dir.join("index.html");
            if index.is_file() { return file_response(&index).await; }
            (StatusCode::SERVICE_UNAVAILABLE,
             "SPA 未构建：web/dist 缺失（前端 Wave 1 Phase B 产出）").into_response()
        }
    }
}

/// 防目录穿越：拒绝 .. / 反斜杠 / 空段；空路径 → index.html。
pub fn sanitize(path: &str) -> Option<PathBuf> {
    let p = path.trim_start_matches('/');
    if p.is_empty() { return Some(PathBuf::from("index.html")); }
    let mut out = PathBuf::new();
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\') { return None; }
        out.push(seg);
    }
    Some(out)
}

pub fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn file_response(path: &Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime_of(path))], Body::from(bytes)).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize("../etc/passwd").is_none());
        assert!(sanitize("/../../x").is_none());
        assert!(sanitize("assets/..\\evil").is_none());
        assert!(sanitize("a//b").is_none(), "空段拒绝（防规范化歧义）");
    }

    #[test]
    fn sanitize_normalizes() {
        assert_eq!(sanitize("/"), Some(PathBuf::from("index.html")));
        assert_eq!(sanitize("/assets/app.js"), Some(PathBuf::from("assets/app.js")));
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_of(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_of(Path::new("a.js")), "text/javascript");
        assert_eq!(mime_of(Path::new("a.woff2")), "font/woff2");
        assert_eq!(mime_of(Path::new("a.bin")), "application/octet-stream");
    }
}
```

集成测试（真实库 + 真实起 server，reqwest 断言）：

``` {.rust file=crates/web/tests/api_rest.rs}
//! REST/SPA 集成测试（需 TimescaleDB :5433）：真实起 axum server + reqwest 断言。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996601";
const SCODE: &str = "996602";
const HSRC: &str = "web_test_src";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅出现在 dev-dependencies（正常依赖图不含，cargo tree -e normal 验证）。
fn state(pool: PgPool) -> Arc<AppState> {
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool))),
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: WsHub::new(),
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

/// n 根 1m raw bar（收盘 1..n）。
async fn seed_bars(pool: &PgPool, code: &str, n: i64) {
    for i in 0..n {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(pool).await.unwrap();
    }
}

// 两测试并行执行：各自的 clean 只碰自己的 code/source（共享清理会互删，实锤踩坑）。
async fn clean_kline(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
}

async fn clean_sym(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(SCODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(SCODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM source_health_events WHERE source = $1").bind(HSRC)
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn kline_cursor_pagination_cagg_and_validation() {
    let pool = pool().await;
    clean_kline(&pool).await;
    seed_bars(&pool, CODE, 5).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 第 1 页：limit=2 → 最新 2 根升序 [4,5]
    let v: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2")])
        .send().await.unwrap().json().await.unwrap();
    let bars = v["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 2);
    assert_eq!(bars[0]["close"], 4.0);
    assert_eq!(bars[1]["close"], 5.0);
    let cursor = v["next_before"].as_str().expect("还有更早页").to_string();

    // 第 2 页：before=游标 → [2,3]，无重叠
    let v2: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2"), ("before", &cursor)])
        .send().await.unwrap().json().await.unwrap();
    let closes: Vec<f64> = v2["bars"].as_array().unwrap()
        .iter().map(|b| b["close"].as_f64().unwrap()).collect();
    assert_eq!(closes, vec![2.0, 3.0], "游标页无重复/缺漏");
    let cursor2 = v2["next_before"].as_str().unwrap().to_string();

    // 第 3 页：[1]，next_before=null（前端停拉信号）
    let v3: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2"), ("before", &cursor2)])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v3["bars"].as_array().unwrap().len(), 1);
    assert!(v3["next_before"].is_null());

    // 参数校验
    for q in [[("code", CODE), ("period", "3m")], [("code", CODE), ("period", "M1")]] {
        let r = http.get(format!("{url}/api/kline")).query(&q).send().await.unwrap();
        assert_eq!(r.status(), 400, "非法 period → 400");
    }
    let r = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("before", "not-a-time")]).send().await.unwrap();
    assert_eq!(r.status(), 400, "非法 before → 400");

    // cagg 周期（5m 桶：开 1 收 5 量 500）
    sqlx::query("CALL refresh_continuous_aggregate('kline_5m', NULL, NULL)")
        .execute(&pool).await.unwrap();
    let v5: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "5m")]).send().await.unwrap().json().await.unwrap();
    let bars5 = v5["bars"].as_array().unwrap();
    assert_eq!(bars5.len(), 1);
    assert_eq!(bars5[0]["open"], 1.0);
    assert_eq!(bars5[0]["close"], 5.0);
    assert_eq!(bars5[0]["volume"], 500);
    assert!(bars5[0].get("source").is_none(), "cagg 无 source 键");
    clean_kline(&pool).await;
}

#[tokio::test]
async fn symbols_latest_healthz_spa_and_sources_health() {
    let pool = pool().await;
    clean_sym(&pool).await;
    sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, '测试ETF') \
                 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
        .bind(SCODE).execute(&pool).await.unwrap();
    seed_bars(&pool, SCODE, 2).await;   // 收盘 1,2 → change_pct=100
    for i in 0..3 {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms) \
                     VALUES (now() - make_interval(secs => $1), $2, true, 120)")
            .bind(10 + i).bind(HSRC).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind) \
                 VALUES (now(), $1, false, 'timeout')")
        .bind(HSRC).execute(&pool).await.unwrap();
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // /api/symbols 含 latest 快照字段
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == SCODE).expect("含测试标的");
    assert_eq!(s["latest"]["last"], 2.0);
    assert!((s["latest"]["change_pct"].as_f64().unwrap() - 100.0).abs() < 1e-6);

    // /api/sources/health：3 成功 + 1 失败 → 成功率 0.75、degraded
    let v: Value = http.get(format!("{url}/api/sources/health"))
        .query(&[("window_secs", "3600")]).send().await.unwrap().json().await.unwrap();
    let h = v["sources"].as_array().unwrap().iter()
        .find(|x| x["source"] == HSRC).expect("含测试源");
    assert_eq!(h["attempts"], 4);
    assert!((h["success_rate"].as_f64().unwrap() - 0.75).abs() < 1e-9);
    assert_eq!(h["status"], "degraded");
    assert_eq!(h["last_error"]["err_kind"], "timeout");

    // /healthz
    let v: Value = http.get(format!("{url}/healthz")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["status"], "ok");

    // SPA：/ 与深链均回退占位 index.html
    for path in ["/", "/symbols", "/assets/nonexistent.js"] {
        let body = http.get(format!("{url}{path}")).send().await.unwrap().text().await.unwrap();
        assert!(body.contains("eestock"), "{path} 回退 index.html");
    }
    // 目录穿越：编码形式不做百分比解码，"..%2F.." 只是普通文件名 → 回退 index.html，
    // 绝不会读到 dist 之外（sanitize 拒绝的是解码后语义中的 ".." 段，即字面段）。
    let r = http.get(format!("{url}/..%2F..%2Fetc%2Fpasswd")).send().await.unwrap();
    let body = r.text().await.unwrap();
    assert!(body.contains("eestock") && !body.contains("root:"), "穿越尝试只能拿到 SPA 页");
    // 字面 ".." 段（构造未经客户端规范化的路径）→ sanitize 拒绝 → 400
    let r = http.get(format!("{url}/assets/%2e%2e")).send().await.unwrap();
    assert!(r.status() != 500);
    clean_sym(&pool).await;
}
```

``` {.rust file=crates/web/tests/ws_poller.rs}
//! WS Poller 集成测试（需 TimescaleDB :5433）：库增量 → hub 推送；无增量不重推；新 bar 再推。

use chrono::{DateTime, Duration, TimeZone, Utc};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use web::state::AppState;
use web::ws::{Poller, PushMsg, Subscription, SubscriptionRegistry, Topic, WsHub};

const CODE: &str = "996603";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅出现在 dev-dependencies（正常依赖图不含，cargo tree -e normal 验证）。
fn state(pool: PgPool) -> Arc<AppState> {
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool))),
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: WsHub::new(),
        subs: SubscriptionRegistry::default(),
    })
}

async fn seed(pool: &PgPool, min: i64, close: f64) {
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
        .bind(CODE).bind(base() + Duration::minutes(min)).bind(close)
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn poller_publishes_increments_only() {
    let pool = pool().await;
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO symbols (code) VALUES ($1) ON CONFLICT (code) DO NOTHING")
        .bind(CODE).execute(&pool).await.unwrap();
    seed(&pool, 0, 1.0).await;

    let st = state(pool.clone());
    st.subs.add(Subscription { topic: Topic::Bar,
        code: Some(CODE.into()), period: Some("1m".into()) });
    st.subs.add(Subscription { topic: Topic::Quote, code: None, period: None });
    let mut rx = st.hub.subscribe();
    let mut poller = Poller::new(st.clone(), StdDuration::from_secs(60));

    // 第 1 轮：bar + quote 各一帧（其他标的的 quote 可能有，过滤找本 code）
    poller.tick().await.unwrap();
    let mut bar_seen = false;
    let mut quote_seen = false;
    while let Ok(m) = rx.try_recv() {
        match m {
            PushMsg::Bar { code, period, bar } if code == CODE => {
                assert_eq!(period, "1m");
                assert_eq!(bar.close, 1.0);
                bar_seen = true;
            }
            PushMsg::Quote { code, last, .. } if code == CODE => {
                assert_eq!(last, 1.0);
                quote_seen = true;
            }
            _ => {}
        }
    }
    assert!(bar_seen && quote_seen, "首轮推送 bar 与 quote");

    // 第 2 轮：无增量 → 不重推
    poller.tick().await.unwrap();
    let mut resent = false;
    while let Ok(m) = rx.try_recv() {
        match m {
            PushMsg::Bar { code, .. } | PushMsg::Quote { code, .. } if code == CODE => resent = true,
            _ => {}
        }
    }
    assert!(!resent, "游标推进，无增量不重推");

    // 新 bar → 再推（bar 与 quote 均为最新值）
    seed(&pool, 1, 2.0).await;
    poller.tick().await.unwrap();
    let mut new_close = None;
    while let Ok(m) = rx.try_recv() {
        if let PushMsg::Bar { code, bar, .. } = m {
            if code == CODE { new_close = Some(bar.close); }
        }
    }
    assert_eq!(new_close, Some(2.0));

    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
}
```

## 5. eestock-app（app crate 加法：应用面进程入口）

`crates/app/src/lib.rs` 增加 `pub mod app_config;`（声明维护在 03-collector/02-data-plane.md，纯加法）。
`--self-check` 子命令复用 `app::healthz::self_check`（同步 TCP 探测 /healthz，compose healthcheck 用）。

``` {.rust file=crates/app/src/app_config.rs}
//! 应用面配置：TOML 文件 + 环境变量覆盖（DATABASE_URL / APP_LISTEN）。
//! 与数据面 DataConfig 并列（同文件级惯例：secret 走 env，不落配置文件）。

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub database_url: String,
    /// 监听地址（REST/WS/SPA 同端口）
    #[serde(default = "default_listen")]
    pub listen: String,
    /// SPA 静态目录（容器 /app/dist；本地 ./web/dist）
    #[serde(default = "default_static_dir")]
    pub static_dir: String,
    /// /api/sources/health 与 WS health 推送的默认统计窗口（秒）
    #[serde(default = "default_health_window")]
    pub health_window_secs: i64,
    /// WS 推送轮询周期（毫秒）
    #[serde(default = "default_ws_poll_ms")]
    pub ws_poll_ms: u64,
}

fn default_listen() -> String { "0.0.0.0:8081".into() }
fn default_static_dir() -> String { "./web/dist".into() }
fn default_health_window() -> i64 { 3600 }
fn default_ws_poll_ms() -> u64 { 3000 }

/// 加载：TOML → env 覆盖（DATABASE_URL / APP_LISTEN）。
pub fn load(path: &str) -> anyhow::Result<AppConfig> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read config {path}: {e}"))?;
    let mut cfg: AppConfig = toml::from_str(&text)
        .map_err(|e| anyhow::anyhow!("parse config {path}: {e}"))?;
    if let Ok(v) = std::env::var("DATABASE_URL") { cfg.database_url = v; }
    if let Ok(v) = std::env::var("APP_LISTEN") { cfg.listen = v; }
    Ok(cfg)
}
```

``` {.rust file=crates/app/src/bin/eestock-app.rs}
//! eestock-app —— 应用面进程（web REST/WS + diagnose 读库 + SPA 托管）。
//! ADR-017：与数据面零 API 直连，唯一耦合点 = TimescaleDB；启动 schema 自检复用 storage::migrate_check。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

use app::app_config;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // compose healthcheck 子命令（运行时镜像无 curl/wget；复用数据面 healthz::self_check）
    if args.iter().any(|a| a == "--self-check") {
        let port: u16 = arg_val(&args, "--port")
            .and_then(|v| v.parse().ok())
            .or_else(|| std::env::var("APP_PORT").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(8081);
        std::process::exit(if app::healthz::self_check(port) { 0 } else { 1 });
    }
    let config_path = arg_val(&args, "--config")
        .unwrap_or_else(|| "./config/app.toml".to_string());
    let cfg = app_config::load(&config_path)?;

    // JSON 日志（与数据面同口径）
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into()))
        .init();
    tracing::info!(config = %config_path, "eestock-app starting");

    let pool = PgPool::connect(&cfg.database_url).await?;
    storage::migrate_check::verify_schema(&pool).await?;
    tracing::info!("schema self-check ok");

    // DI 装配（ADR-017：app 是唯一持有 storage 具体实现的应用面组件；
    // web 只见 domain::ports::KlineRead，diagnose 只见 domain::ports::HealthEventsRead）
    let state = Arc::new(web::state::AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool))),
        static_dir: cfg.static_dir.clone().into(),
        health_window_secs: cfg.health_window_secs,
        hub: web::ws::WsHub::new(),
        subs: web::ws::SubscriptionRegistry::default(),
    });
    tokio::spawn(web::ws::Poller::new(state.clone(), Duration::from_millis(cfg.ws_poll_ms)).run());

    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    tracing::info!(listen = %cfg.listen, static_dir = %cfg.static_dir, "eestock-app serving");
    axum::serve(listener, web::build_router(state)).await?;
    Ok(())
}

fn arg_val(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}
```

``` {.rust file=crates/app/tests/app_config.rs}
//! 应用面配置解析测试（TOML 默认值 + env 覆盖）。

use app::app_config;

#[test]
fn parse_minimal_uses_defaults_and_env_overrides() {
    let dir = std::env::temp_dir().join(format!("eestock-app-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("app.toml");
    std::fs::write(&p, "database_url = \"postgres://u:p@db:5432/eestock\"\n").unwrap();
    // env 覆盖测试与解析测试同进程：先暂存并清除真实 env
    let saved_db = std::env::var("DATABASE_URL").ok();
    let saved_listen = std::env::var("APP_LISTEN").ok();
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("APP_LISTEN");

    let cfg = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg.database_url, "postgres://u:p@db:5432/eestock");
    assert_eq!(cfg.listen, "0.0.0.0:8081");
    assert_eq!(cfg.static_dir, "./web/dist");
    assert_eq!(cfg.health_window_secs, 3600);
    assert_eq!(cfg.ws_poll_ms, 3000);

    // env 覆盖（容器 secret/地址注入口径）
    std::env::set_var("DATABASE_URL", "postgres://override@h/db");
    std::env::set_var("APP_LISTEN", "127.0.0.1:9999");
    let cfg2 = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg2.database_url, "postgres://override@h/db");
    assert_eq!(cfg2.listen, "127.0.0.1:9999");

    match saved_db { Some(v) => std::env::set_var("DATABASE_URL", v), None => std::env::remove_var("DATABASE_URL") }
    match saved_listen { Some(v) => std::env::set_var("APP_LISTEN", v), None => std::env::remove_var("APP_LISTEN") }
    std::fs::remove_dir_all(&dir).ok();
}
```

## 6. 部署

- `Dockerfile.app`（本文档 tangle，审查返工后自包含）：三阶段——`frontend`（node:22，`npm ci` 严格按
  lock 安装 → `npm run build`）→ `builder`（rust 编译 eestock-app）→ runtime（debian-slim 非 root，
  dist 从 frontend 阶段 COPY）。构建上下文无需预存 dist；`.dockerignore` 排除 node_modules/target/data 等。
- compose `app` 服务（docker-compose.yml 手写例外）：`depends_on: timescaledb(healthy)`——
  **不依赖 data 服务**（两面零耦合，库为唯一耦合点）；`8081:8081`（数据面 8080 不动）；
  `./config/app.toml` 只读挂载（.gitignore；模板 config/app.toml.example 入库）；
  healthcheck 复用二进制 `--self-check`。
- `docker compose up -d` 一条命令起三容器（db/data/app），wave-1.md 验收口径。

``` {.dockerfile file=Dockerfile.app}
# Dockerfile.app — 应用面镜像（由 design/07-app-plane/00-web-api.md tangle 生成，禁止手改）
# 多阶段自包含（Phase A 审查返工）：frontend(node:22 构建 web/dist) → builder(rust) → runtime(非 root)
# dist 由镜像内构建产出，不依赖构建上下文预存（前端 dist 产物不入库，web/.gitignore 已含 dist/）
FROM node:22-bookworm-slim AS frontend
WORKDIR /web
# 锁文件先行：依赖层缓存（npm ci 严格按 lock 安装）
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --bin eestock-app

FROM debian:bookworm-slim
RUN useradd --system --uid 10002 --no-create-home eestock
COPY --from=builder /build/target/release/eestock-app /usr/local/bin/eestock-app
# SPA 静态资源来自 frontend 阶段构建产物
COPY --from=frontend /web/dist /app/dist
USER eestock
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/eestock-app"]
CMD ["--config", "/etc/eestock/app.toml"]
```

## 7. TDD 规格要点（Red-Green 记录）

- diagnose：成功率分母排除 na / percentile_cont 线性插值（与 PG 口径一致）/ 熔断态取最近迁移事件 /
  最近错误排除迁移类 / 状态灯 95% 边界 / 多源归组排序 / HealthService 端口注入（纯函数 + mock 端口，无 DB）；
  窗口过滤与字段映射由 storage 端口集成测试锁定（真实库 :5433）。
- storage reader：merge 视图准确层优先 / 游标不含 before 本身 / limit 降序取翻转升序 /
  cagg volume numeric→bigint / 1h rollup / symbols 最新快照与无 bar 标的（集成测试）。
- web：parse_period 前端口径 / 游标分页无重复缺漏 / 400 校验 / SPA 深链回退与目录穿越 /
  WS matches 矩阵与 JSON tag 形状 / Poller 增量推送不重复（单测 + 集成测试）。
- app：TOML 默认值 + env 覆盖。
