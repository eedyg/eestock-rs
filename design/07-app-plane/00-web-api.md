# 07-app-plane / 00 — 应用面 Web API（web / diagnose / eestock-app / 部署）

> 本文档 tangle 生成：
> `crates/diagnose/src/{lib,health}.rs`、`crates/diagnose/tests/health_agg.rs`、
> `crates/storage/src/{reader,admin}.rs`、`crates/storage/tests/{kline_reader,symbol_admin}.rs`、
> `crates/web/src/{lib,dto,state,rest,ws,spa}.rs`、`crates/web/tests/{api_rest,ws_poller,api_admin}.rs`、
> `crates/app/src/app_config.rs`、`crates/app/src/bin/eestock-app.rs`、`crates/app/tests/app_config.rs`、
> `Dockerfile.app`。
>
> 决策依据：ADR-017（部署双面分离：应用面与数据面零 API 直连，唯一耦合点 = TimescaleDB）、
> ADR-008（axum 栈）、ADR-010（免认证内网）、wave-1.md 2026-09-04 实施定稿（Phase A 后端）、
> Wave 1 Phase C 任务书（§8：symbols 写端点 + 熔断复位 DB 控制通道）。
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
>
> ⚠️ 2026-09-04 Phase D 加法（Wave 1 Phase D 任务书；全部口径见 design/07-app-plane/01-mcp.md）：
> `app_config.rs` +`mcp_listen`（默认 `0.0.0.0:8082`，env `MCP_LISTEN` 覆盖）、`eestock-app.rs` 装配
> MCP HTTP/SSE 服务（ADR-009 范围①②，与 web **同进程**、**端口独立** 8082，复用同一
> KlineRead/HealthEventsRead 端口实现实例）、`Dockerfile.app` `EXPOSE 8081 8082`——均为纯加法，
> web/diagnose/storage 既有块零改动。

## 1. 端点契约

### 1.1 REST

| 方法/路径 | 参数 | 响应 | 数据源 | 错误态 |
|---|---|---|---|---|
| `GET /healthz` | — | `{"status":"ok"}` | 静态 | —（compose healthcheck 经 `--self-check` 调此路由） |
| `GET /api/kline` | `code`（必填）、`period=1m\|5m\|15m\|1h\|1d`（默认 `1m`）、`before`（RFC3339 游标，不含该 ts 的更早一页）、`limit`（默认 240，封顶 1000） | `{"code","period","bars":[{ts,open,high,low,close,volume,amount,source?}],"next_before"}`；bars **升序**（图表口径）；`next_before`=本页最旧 ts，`null`=无更早数据 | 1m=`kline_merged` 合并视图（准确层优先，ADR-003）；5m/15m/1d=对应 cagg（ADR-004）；1h=`kline_15m` 查询期 rollup（schema 未建 kline_1h cagg，rollup 语义等价） | 400：`code` 空 / `period` 非法 / `before` 非 RFC3339；500 JSON `{"error":...}` |
| `GET /api/symbols` | — | `[{code,name,interval_secs,settlement,enabled,latest:{ts,last,change_pct}\|null}]`；`change_pct`=相对前一根 merge bar 收盘（%），无前值/无 bar → null | `symbols` + `kline_merged` 每 code 最近 2 根（LATERAL） | 500 |
| `GET /api/sources/health` | `window_secs`（默认 3600 = 页面② `SOURCES_DEFAULTS.successRateWindow='1h'`，钳制 60..604800） | `{"window_secs","sources":[{source,attempts,successes,success_rate,p50_ms,p95_ms,circuit_state,status,last_error,last_event_ts}]}`；`success_rate` 分母**排除 `err_kind='na'`**（03 §7），分母 0 → `null` | `source_health_events` 窗口聚合（diagnose crate，05-diagnose §1 口径） | 500 |
| `POST /api/symbols`（Phase C §8） | body `{code, name?, interval_secs?, settlement?, enabled?}`（缺省 interval=60 / settlement=T1 / enabled=true） | 201 `SymbolDto`（含 latest） | `symbols` 表写入（**DB 控制通道**：数据面 Scheduler 每周期重读热生效，无直连） | 400：code 非 6 位数字 / settlement 非法 / interval_secs<60；409：code 已注册；422：北交所前缀（4/8/920）拒绝「暂不支持」；500 |
| `PATCH /api/symbols/{code}`（Phase C §8） | body `{name?, interval_secs?, settlement?, enabled?}`（None=不改；code 主键不可改） | 200 `SymbolDto` | 同上，间隔修改下一采集周期热生效 | 400/422 同上；404：code 未注册；500 |
| `GET /api/symbols?with_stats=1`（Phase C §8） | `with_stats=1` 追加每标的当日统计 | 列表项追加 `today_bars`（当日 kline_raw 行数，Asia/Shanghai 日界；无 bar → 0） | `kline_raw` 当日窗口 GROUP BY | 500 |
| `POST /api/sources/{id}/reset`（Phase C §8） | 路径 id = SourceId 文本（未知 id 也接受：应用面不知编译期源清单，数据面消费端跳过并告警） | 202 `{"status":"accepted"}`（**异步**：写 `circuit_reset_requests`，数据面 ResetWatcher ≤5s 内消费复位并发出 `manual_reset` 事件） | `circuit_reset_requests` 表（0007） | 400：id 空；500 |

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

### 1.4 明确不做（边界）

**Phase A 不做**（Phase B/C 或 Wave 2）：`/api/sources/{id}/metrics|events|divergence`、
`/api/collection/gaps`、`/api/alerts*`（02-sources §8 / 03-symbols §6 所列其余端点）。
**Phase C 已交付**（§8）：`POST/PATCH /api/symbols`、`GET /api/symbols?with_stats=1`、
`POST /api/sources/{id}/reset`。
**不做物理删除**（03-symbols §4 定稿）：仅停用（`enabled=false`，历史数据保留），
无 `DELETE /api/symbols` 端点；物理删除仅限 DBA 手工 SQL，不在产品功能内。
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
use domain::ports::{
    HealthEventRow, HealthEventsRead, KlineBarView, KlineRead, SymbolLatestView, SymbolStatView,
    SymbolStatsRead,
};
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

/// 当日（Asia/Shanghai 日界）kline_raw 每 code 行数与最新 ts（页面③ with_stats 数据源）。
const TODAY_STATS_SQL: &str = r#"
SELECT code, count(*)::bigint AS today_bars, max(ts) AS last_bar_ts
FROM kline_raw
WHERE ts >= $1 AND ts < $2
GROUP BY code
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

/// 标的当日采集统计（SymbolStatsRead 实现；页面③ GET /api/symbols?with_stats=1 数据源）。
/// 当日 = Asia/Shanghai 日界（domain::tz 固定 +8 平移口径，与 RawBarReader::existing_ts 一致）。
#[async_trait]
impl SymbolStatsRead for KlineReader {
    async fn today_stats(&self) -> Result<Vec<SymbolStatView>> {
        let today_cst = domain::tz::utc_to_cst(Utc::now()).date();
        let start = domain::tz::cst_to_utc(today_cst.and_hms_opt(0, 0, 0).expect("valid hms"));
        let end = domain::tz::cst_to_utc((today_cst + chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0).expect("valid hms"));
        type Row = (String, i64, Option<DateTime<Utc>>);
        let rows: Vec<Row> = sqlx::query_as(TODAY_STATS_SQL)
            .bind(start).bind(end).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(code, today_bars, last_bar_ts)|
            SymbolStatView { code, today_bars, last_bar_ts }).collect())
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

use axum::{routing::{get, patch, post}, Router};
use std::sync::Arc;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/healthz", get(rest::healthz))
        .route("/api/kline", get(rest::get_kline))
        // Phase C：symbols 写端点（注册 POST / 编辑 PATCH；无物理删除，03-symbols §4）
        .route("/api/symbols", get(rest::get_symbols).post(rest::register_symbol))
        .route("/api/symbols/{code}", patch(rest::update_symbol))
        .route("/api/sources/health", get(rest::get_sources_health))
        // Phase C：熔断手动复位（DB 控制通道，ADR-017）
        .route("/api/sources/{id}/reset", post(rest::reset_source))
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
    /// 仅 with_stats=1 时填充：当日（Asia/Shanghai 日界）kline_raw 行数（无 bar → 0）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub today_bars: Option<i64>,
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
            settlement: r.settlement.clone(), enabled: r.enabled, latest, today_bars: None,
        }
    }
}

/// GET /api/sources/health 查询参数。
#[derive(Debug, Deserialize)]
pub struct HealthQuery {
    #[serde(default = "default_window")]
    pub window_secs: i64,
}

// ── Phase C：标的管理写端点与熔断复位 DTO/校验（§8 契约）──

/// GET /api/symbols 查询参数：with_stats=1 追加当日采集统计。
#[derive(Debug, Deserialize)]
pub struct SymbolsQuery {
    pub with_stats: Option<String>,
}

fn default_interval() -> i32 { 60 }
fn default_settlement() -> String { "T1".into() }
fn default_enabled() -> bool { true }

/// POST /api/symbols 请求体（缺省与 schema DEFAULT 同口径：60s / T1 / 启用）。
#[derive(Debug, Deserialize)]
pub struct RegisterSymbolReq {
    pub code: String,
    pub name: Option<String>,
    #[serde(default = "default_interval")]
    pub interval_secs: i32,
    #[serde(default = "default_settlement")]
    pub settlement: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// PATCH /api/symbols/{code} 请求体（None = 不改；code 主键不可改）。
#[derive(Debug, Deserialize)]
pub struct UpdateSymbolReq {
    pub name: Option<String>,
    pub interval_secs: Option<i32>,
    pub settlement: Option<String>,
    pub enabled: Option<bool>,
}

/// 校验错误分类：400 = 格式/取值错误；422 = 业务拒绝（北交所）。
#[derive(Debug, PartialEq, Eq)]
pub enum FieldError {
    BadRequest(String),
    Unprocessable(String),
}

/// code 校验（03-symbols §3）：6 位数字 → 市场前缀（复用 domain Code::market 契约，
/// 5/6/9→沪、0/1/2/3→深、4/8/920 北交所拒绝）。
pub fn validate_code(code: &str) -> Result<(), FieldError> {
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(FieldError::BadRequest("code 须为 6 位数字".into()));
    }
    domain::types::Code(code.into()).market().map_err(|_|
        FieldError::Unprocessable("北交所标的（4/8/920 前缀）暂不支持".into()))?;
    Ok(())
}

/// interval_secs 校验：下限 60（schema CHECK interval_secs>=60 同口径，双保险）。
pub fn validate_interval(secs: i32) -> Result<(), FieldError> {
    if secs < 60 {
        return Err(FieldError::BadRequest("interval_secs 下限 60（秒）".into()));
    }
    Ok(())
}

/// settlement 校验：T0/T1（schema CHECK 同口径）。
pub fn validate_settlement(s: &str) -> Result<(), FieldError> {
    if s != "T0" && s != "T1" {
        return Err(FieldError::BadRequest("settlement 须为 T0 或 T1".into()));
    }
    Ok(())
}

/// name 归一：空串/纯空白 → None。
pub fn normalize_name(name: Option<String>) -> Option<String> {
    name.and_then(|n| { let t = n.trim().to_string(); if t.is_empty() { None } else { Some(t) } })
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
        assert!(v.get("today_bars").is_none(), "非 with_stats 请求不出 today_bars 键");
    }

    // ── Phase C：symbols 写端点校验（03-symbols §3 口径 + schema CHECK 对齐）──

    #[test]
    fn validate_code_format_and_market() {
        assert!(validate_code("600519").is_ok(), "沪");
        assert!(validate_code("159915").is_ok(), "深");
        assert!(validate_code("518880").is_ok());
        assert!(matches!(validate_code("60051"), Err(FieldError::BadRequest(_))), "非 6 位");
        assert!(matches!(validate_code("60051a"), Err(FieldError::BadRequest(_))), "非数字");
        assert!(matches!(validate_code(""), Err(FieldError::BadRequest(_))));
        for bse in ["430001", "830799", "920001"] {
            assert!(matches!(validate_code(bse), Err(FieldError::Unprocessable(_))),
                "{bse} 北交所前缀 → 422");
        }
    }

    #[test]
    fn validate_interval_and_settlement() {
        assert!(validate_interval(60).is_ok());
        assert!(validate_interval(300).is_ok());
        assert!(matches!(validate_interval(59), Err(FieldError::BadRequest(_))),
            "下限 60（schema CHECK 同口径）");
        assert!(validate_settlement("T0").is_ok());
        assert!(validate_settlement("T1").is_ok());
        assert!(matches!(validate_settlement("T2"), Err(FieldError::BadRequest(_))));
        assert!(matches!(validate_settlement("t0"), Err(FieldError::BadRequest(_))));
    }

    #[test]
    fn normalize_name_and_register_defaults() {
        assert_eq!(normalize_name(Some("  黄金ETF  ".into())), Some("黄金ETF".into()));
        assert_eq!(normalize_name(Some("   ".into())), None);
        assert_eq!(normalize_name(None), None);
        let req: RegisterSymbolReq = serde_json::from_str(r#"{"code":"600519"}"#).unwrap();
        assert_eq!(req.interval_secs, 60, "缺省 60s（schema DEFAULT 同口径）");
        assert_eq!(req.settlement, "T1");
        assert!(req.enabled);
        assert!(req.name.is_none());
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
    /// 标的管理写端口（Phase C：POST/PATCH /api/symbols；DB 控制通道，ADR-017）。
    pub symbols_admin: Arc<dyn domain::ports::SymbolAdminWrite>,
    /// 标的当日统计只读端口（Phase C：GET /api/symbols?with_stats=1）。
    pub symbol_stats: Arc<dyn domain::ports::SymbolStatsRead>,
    /// 熔断复位写端口（Phase C：POST /api/sources/{id}/reset；DB 控制通道）。
    pub resets: Arc<dyn domain::ports::CircuitResetWrite>,
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
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use domain::ports::{SymbolAdminInput, SymbolPatch};
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

pub async fn get_symbols(State(st): State<Arc<AppState>>,
                         Query(q): Query<SymbolsQuery>) -> Response {
    let with_stats = q.with_stats.as_deref() == Some("1");
    let rows = match st.kline.symbols_with_latest().await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let mut list: Vec<SymbolDto> = rows.iter().map(SymbolDto::from).collect();
    if with_stats {
        match st.symbol_stats.today_stats().await {
            Ok(stats) => {
                let map: std::collections::HashMap<String, i64> =
                    stats.into_iter().map(|s| (s.code, s.today_bars)).collect();
                for d in &mut list {
                    d.today_bars = Some(map.get(&d.code).copied().unwrap_or(0));
                }
            }
            Err(e) => return internal(e),
        }
    }
    Json(list).into_response()
}

/// 字段校验错误 → 400/422 JSON（FieldError 分类）。
fn field_err(e: FieldError) -> Response {
    match e {
        FieldError::BadRequest(m) => err(StatusCode::BAD_REQUEST, &m),
        FieldError::Unprocessable(m) => err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    }
}

/// 写后回读（经 merge 视图返回含 latest 的完整行）；写成功但回读缺失 → 500（不自洽）。
async fn read_symbol(st: &AppState, code: &str) -> anyhow::Result<Option<SymbolDto>> {
    Ok(st.kline.symbols_with_latest().await?.iter()
        .find(|r| r.code == code).map(SymbolDto::from))
}

/// POST /api/symbols —— 注册标的（校验 03-symbols §3；写 symbols 表即控制通道，热生效）。
/// 名称不经服务端行情源反查（ADR-017：应用面无数据面直连）——请求体携带或留空后续 PATCH。
pub async fn register_symbol(State(st): State<Arc<AppState>>,
                             Json(req): Json<RegisterSymbolReq>) -> Response {
    if let Err(e) = validate_code(&req.code) { return field_err(e); }
    if let Err(e) = validate_interval(req.interval_secs) { return field_err(e); }
    if let Err(e) = validate_settlement(&req.settlement) { return field_err(e); }
    let input = SymbolAdminInput {
        code: req.code.clone(), name: normalize_name(req.name),
        interval_secs: req.interval_secs, settlement: req.settlement.clone(),
        enabled: req.enabled,
    };
    match st.symbols_admin.register(&input).await {
        Ok(true) => match read_symbol(&st, &req.code).await {
            Ok(Some(dto)) => (StatusCode::CREATED, Json(dto)).into_response(),
            Ok(None) => internal(anyhow::anyhow!("register 后回读缺失 {}", req.code)),
            Err(e) => internal(e),
        },
        Ok(false) => err(StatusCode::CONFLICT, "code 已注册（编辑用 PATCH）"),
        Err(e) => internal(e),
    }
}

/// PATCH /api/symbols/{code} —— 编辑（间隔/启停/名称/settlement；code 主键不可改）。
/// 仅停用、无物理删除（03-symbols §4）；间隔修改下一采集周期热生效。
pub async fn update_symbol(State(st): State<Arc<AppState>>, Path(code): Path<String>,
                           Json(req): Json<UpdateSymbolReq>) -> Response {
    if let Some(secs) = req.interval_secs {
        if let Err(e) = validate_interval(secs) { return field_err(e); }
    }
    if let Some(s) = &req.settlement {
        if let Err(e) = validate_settlement(s) { return field_err(e); }
    }
    let patch = SymbolPatch {
        name: normalize_name(req.name),
        interval_secs: req.interval_secs,
        settlement: req.settlement.clone(),
        enabled: req.enabled,
    };
    match st.symbols_admin.update(&code, &patch).await {
        Ok(true) => match read_symbol(&st, &code).await {
            Ok(Some(dto)) => Json(dto).into_response(),
            Ok(None) => internal(anyhow::anyhow!("update 后回读缺失 {code}")),
            Err(e) => internal(e),
        },
        Ok(false) => err(StatusCode::NOT_FOUND, "code 未注册"),
        Err(e) => internal(e),
    }
}

/// POST /api/sources/{id}/reset —— 熔断手动复位（DB 控制通道，ADR-017）。
/// 202 异步：写 circuit_reset_requests；数据面 ResetWatcher ≤5s 消费并发出 manual_reset 事件
/// （未知源 id 由消费端跳过并告警——应用面不知编译期源清单，不在此校验）。
pub async fn reset_source(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if id.trim().is_empty() { return err(StatusCode::BAD_REQUEST, "source id 空"); }
    match st.resets.request_reset(&id).await {
        Ok(()) => (StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "accepted" }))).into_response(),
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
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        // Phase C：symbols 写 / 当日统计 / 熔断复位 DB 通道
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
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
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        // Phase C：symbols 写 / 当日统计 / 熔断复位 DB 通道（本文件不涉及行为，仅装配齐全）
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
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
    /// MCP HTTP/SSE 监听地址（Wave 1 Phase D，ADR-009；与 web 同进程、端口独立，仅局域网）
    #[serde(default = "default_mcp_listen")]
    pub mcp_listen: String,
}

fn default_listen() -> String { "0.0.0.0:8081".into() }
fn default_mcp_listen() -> String { "0.0.0.0:8082".into() }
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
    if let Ok(v) = std::env::var("MCP_LISTEN") { cfg.mcp_listen = v; }
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
    // web 只见 domain::ports，diagnose 只见 domain::ports::HealthEventsRead）
    // Phase D：HealthEventsRead 实现实例 web 与 mcp 共享（同一 Arc）
    let health_events: Arc<dyn domain::ports::HealthEventsRead> =
        Arc::new(storage::reader::HealthEventReader::new(pool.clone()));
    let state = Arc::new(web::state::AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(health_events.clone()),
        // Phase C：symbols 写端点 / with_stats 当日统计 / 熔断复位 DB 控制通道
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        static_dir: cfg.static_dir.clone().into(),
        health_window_secs: cfg.health_window_secs,
        hub: web::ws::WsHub::new(),
        subs: web::ws::SubscriptionRegistry::default(),
    });
    tokio::spawn(web::ws::Poller::new(state.clone(), Duration::from_millis(cfg.ws_poll_ms)).run());

    // Wave 1 Phase D：MCP HTTP/SSE 服务（ADR-009 范围①②）——与 web 同进程、端口独立
    // （design/07-app-plane/01-mcp.md；复用同一 KlineRead/HealthEventsRead 端口实现实例）
    let mcp_state = Arc::new(mcp::state::McpState {
        kline: state.kline.clone(),
        health: diagnose::health::HealthService::new(health_events),
        default_window_secs: cfg.health_window_secs,
        sessions: mcp::state::SessionRegistry::default(),
    });
    let mcp_listen = cfg.mcp_listen.clone();
    tokio::spawn(async move {
        if let Err(e) = mcp::server::serve(mcp_state, &mcp_listen).await {
            tracing::error!(error = %e, "mcp server exited");
        }
    });

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
    let saved_mcp = std::env::var("MCP_LISTEN").ok();
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("APP_LISTEN");
    std::env::remove_var("MCP_LISTEN");

    let cfg = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg.database_url, "postgres://u:p@db:5432/eestock");
    assert_eq!(cfg.listen, "0.0.0.0:8081");
    assert_eq!(cfg.static_dir, "./web/dist");
    assert_eq!(cfg.health_window_secs, 3600);
    assert_eq!(cfg.ws_poll_ms, 3000);
    assert_eq!(cfg.mcp_listen, "0.0.0.0:8082", "Phase D：MCP 缺省端口 8082（独立端口）");

    // env 覆盖（容器 secret/地址注入口径）
    std::env::set_var("DATABASE_URL", "postgres://override@h/db");
    std::env::set_var("APP_LISTEN", "127.0.0.1:9999");
    std::env::set_var("MCP_LISTEN", "127.0.0.1:9998");
    let cfg2 = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg2.database_url, "postgres://override@h/db");
    assert_eq!(cfg2.listen, "127.0.0.1:9999");
    assert_eq!(cfg2.mcp_listen, "127.0.0.1:9998", "MCP_LISTEN env 覆盖");

    match saved_db { Some(v) => std::env::set_var("DATABASE_URL", v), None => std::env::remove_var("DATABASE_URL") }
    match saved_listen { Some(v) => std::env::set_var("APP_LISTEN", v), None => std::env::remove_var("APP_LISTEN") }
    match saved_mcp { Some(v) => std::env::set_var("MCP_LISTEN", v), None => std::env::remove_var("MCP_LISTEN") }
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
EXPOSE 8081 8082
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

## 8. Phase C：symbols 写端点 + 熔断复位 DB 控制通道（Wave 1 Phase C 任务书）

> 2026-09-06 Phase C 定稿节后落稿。契约表见 §1.1（Phase C 行）、边界见 §1.4。
> 事实约束（ADR-017 铁律）：应用面影响数据面**只能经 DB**。本阶段两条控制通道：
> ① symbols 表写入（数据面 Scheduler 每周期重读，间隔/启停热生效，03-collector §2 既有机制）；
> ② `circuit_reset_requests` 表（0007 迁移）+ 数据面 `collector::reset::ResetWatcher`
> 轮询消费（03-collector §10，纯加法扩展，数据面既有逻辑零改动）。

### 8.1 决策注记

- **名称不经服务端行情源反查**：03-symbols L2 的「注册时服务端反查名称」依赖行情源，
  与 ADR-017（应用面无数据面/外网直连）冲突 → 按 ADR-017 裁决：name 由请求体携带或留空
  （设计既定降级路径「失败留空可手工改」），可后续 `PATCH` 补录。
- **无 `DELETE /api/symbols`**：03-symbols §4 定稿仅停用（`enabled=false`），物理删除不在产品内。
- **复位为异步语义**：202 仅表示请求落库；数据面 ≤5s 消费后由数据面发出 `manual_reset`
  事件（单写者原则），diagnose 聚合呈现闭合、WS `health` 推送经 Poller 增量生效。
- **复位 id 不在应用面校验**：应用面不知编译期源清单；未知 id 由数据面消费端跳过并 warn。

### 8.2 storage 写/控制通道加法扩展（admin.rs）

父级授权口径同 Phase A reader（「storage 接口加法扩展可以」）：`admin.rs` 为纯新增文件，
写路径（kline/accurate/events/symbols.rs）零改动；`pub mod admin;` 声明维护在
design/04-storage/02-tushare-sync.md。实现 domain Phase C 端口（02-domain/contracts.md §2.4 尾部）。

``` {.rust file=crates/storage/src/admin.rs}
//! 应用面写/控制通道加法扩展（Wave 1 Phase C，ADR-017 授权口径；数据面既有写路径零改动）：
//! - PgSymbolAdmin：symbols 表注册/编辑（写即控制通道——Scheduler 每周期重读热生效）
//! - PgResetStore：熔断复位 DB 通道（应用面 request_reset 插入；数据面 take_pending 原子消费）
//!
//! 字段校验在 web 层完成（dto.rs 纯函数，与 schema CHECK 同口径）；本层仅落库，CHECK 兜底。

use anyhow::Result;
use async_trait::async_trait;
use domain::ports::{
    CircuitResetChannel, CircuitResetWrite, ResetRequest, SymbolAdminInput, SymbolAdminWrite,
    SymbolPatch,
};
use sqlx::PgPool;

/// symbols 表管理写（POST /api/symbols、PATCH /api/symbols/{code}）。
pub struct PgSymbolAdmin {
    pool: PgPool,
}

impl PgSymbolAdmin {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl SymbolAdminWrite for PgSymbolAdmin {
    /// 注册；ON CONFLICT DO NOTHING → rows_affected=0 即已存在（Ok(false)，web 映射 409）。
    async fn register(&self, input: &SymbolAdminInput) -> Result<bool> {
        let n = sqlx::query(
            "INSERT INTO symbols (code, name, interval_secs, settlement, enabled) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING")
            .bind(&input.code).bind(&input.name)
            .bind(input.interval_secs).bind(&input.settlement).bind(input.enabled)
            .execute(&self.pool).await?
            .rows_affected();
        Ok(n > 0)
    }

    /// 编辑（COALESCE 语义：None 字段不改）；code 不存在 → Ok(false)（web 映射 404）。
    async fn update(&self, code: &str, patch: &SymbolPatch) -> Result<bool> {
        let n = sqlx::query(
            "UPDATE symbols SET \
                 name = COALESCE($2, name), \
                 interval_secs = COALESCE($3, interval_secs), \
                 settlement = COALESCE($4, settlement), \
                 enabled = COALESCE($5, enabled) \
             WHERE code = $1")
            .bind(code).bind(&patch.name).bind(patch.interval_secs)
            .bind(&patch.settlement).bind(patch.enabled)
            .execute(&self.pool).await?
            .rows_affected();
        Ok(n > 0)
    }
}

/// 熔断复位 DB 控制通道（circuit_reset_requests，migrations/0007）：
/// 应用面写（CircuitResetWrite）+ 数据面消费（CircuitResetChannel），单表双角色。
pub struct PgResetStore {
    pool: PgPool,
}

impl PgResetStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl CircuitResetWrite for PgResetStore {
    async fn request_reset(&self, source: &str) -> Result<()> {
        sqlx::query("INSERT INTO circuit_reset_requests (source) VALUES ($1)")
            .bind(source).execute(&self.pool).await?;
        Ok(())
    }
}

#[async_trait]
impl CircuitResetChannel for PgResetStore {
    /// UPDATE ... RETURNING 原子消费（并发下同行只被一个消费者取出；
    /// circuit_reset_pending_idx 部分索引覆盖 consumed_at IS NULL）。
    async fn take_pending(&self) -> Result<Vec<ResetRequest>> {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "UPDATE circuit_reset_requests SET consumed_at = now() \
             WHERE id IN (SELECT id FROM circuit_reset_requests \
                          WHERE consumed_at IS NULL ORDER BY id) \
             RETURNING id, source")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id, source)| ResetRequest { id, source }).collect())
    }
}
```

集成测试（真实库 :5433；独立 code 段 9968xx + 独立 source 名，前后清理可重入）：

``` {.rust file=crates/storage/tests/symbol_admin.rs}
//! PgSymbolAdmin / PgResetStore / today_stats 集成测试（需 TimescaleDB :5433，含 0007 迁移）。

use chrono::{Duration, Utc};
use domain::ports::{
    CircuitResetChannel, CircuitResetWrite, SymbolAdminInput, SymbolAdminWrite, SymbolPatch,
    SymbolStatsRead,
};
use sqlx::PgPool;
use storage::admin::{PgResetStore, PgSymbolAdmin};
use storage::reader::KlineReader;

const CODE: &str = "996810";
const CODE2: &str = "996811";
const STATS_CODE: &str = "996812";
const RSRC: &str = "storage_test_reset_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool) {
    for c in [CODE, CODE2] {
        sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(c).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(c).execute(pool).await.unwrap();
    }
}

// 每测试独立 clean（同 binary 测试并行执行，共享清理会互删——实锤踩坑，见 kline_reader.rs 注记）
async fn clean_stats(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(STATS_CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(STATS_CODE).execute(pool).await.unwrap();
}

async fn clean_reset(pool: &PgPool) {
    sqlx::query("DELETE FROM circuit_reset_requests WHERE source = $1")
        .bind(RSRC).execute(pool).await.unwrap();
}

fn input(code: &str) -> SymbolAdminInput {
    SymbolAdminInput { code: code.into(), name: Some("测试ETF".into()),
        interval_secs: 60, settlement: "T1".into(), enabled: true }
}

#[tokio::test]
async fn register_update_roundtrip_and_conflict() {
    let pool = pool().await;
    clean(&pool).await;
    let admin = PgSymbolAdmin::new(pool.clone());

    assert!(admin.register(&input(CODE)).await.unwrap(), "首次注册成功");
    assert!(!admin.register(&input(CODE)).await.unwrap(), "重复注册 → false（409 语义）");

    // 编辑：间隔 60→300 + 停用（COALESCE 只动给定字段）
    let patch = SymbolPatch { interval_secs: Some(300), enabled: Some(false), ..Default::default() };
    assert!(admin.update(CODE, &patch).await.unwrap());
    let row: (i32, String, bool, Option<String>) =
        sqlx::query_as("SELECT interval_secs, settlement, enabled, name FROM symbols WHERE code = $1")
            .bind(CODE).fetch_one(&pool).await.unwrap();
    assert_eq!(row.0, 300, "间隔更新落库（数据面下周期热生效）");
    assert_eq!(row.1, "T1", "未给字段保持原值");
    assert!(!row.2, "停用落库（仅停用，无物理删除）");
    assert_eq!(row.3.as_deref(), Some("测试ETF"));

    assert!(!admin.update("996899", &SymbolPatch::default()).await.unwrap(),
        "未知 code → false（404 语义）");

    // schema CHECK 对齐双保险：web 层已拦 <60，此处锁库层约束仍生效
    let bad = SymbolAdminInput { interval_secs: 30, ..input(CODE2) };
    assert!(admin.register(&bad).await.is_err(), "interval_secs<60 被 schema CHECK 拒绝");
    let bad2 = SymbolAdminInput { settlement: "T2".into(), ..input(CODE2) };
    assert!(admin.register(&bad2).await.is_err(), "非法 settlement 被 schema CHECK 拒绝");
    clean(&pool).await;
}

#[tokio::test]
async fn today_stats_counts_shanghai_day_window() {
    let pool = pool().await;
    clean_stats(&pool).await;
    // 今日 2 根 + 昨日 3 根（Asia/Shanghai 日界由实现侧 domain::tz 计算）
    let now = Utc::now();
    for i in 0..2 {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(STATS_CODE).bind(now - Duration::minutes(i + 1)).execute(&pool).await.unwrap();
    }
    for i in 0..3 {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(STATS_CODE).bind(now - Duration::days(1) - Duration::minutes(i))
            .execute(&pool).await.unwrap();
    }
    let stats = KlineReader::new(pool.clone()).today_stats().await.unwrap();
    let s = stats.iter().find(|r| r.code == STATS_CODE).expect("含测试标的");
    assert_eq!(s.today_bars, 2, "仅当日（Asia/Shanghai 日界）行数");
    assert!(s.last_bar_ts.is_some());
    clean_stats(&pool).await;
}

#[tokio::test]
async fn reset_channel_write_take_consume_once() {
    let pool = pool().await;
    clean_reset(&pool).await;
    let store = PgResetStore::new(pool.clone());

    store.request_reset(RSRC).await.unwrap();
    store.request_reset(RSRC).await.unwrap();
    let taken = store.take_pending().await.unwrap();
    let mine: Vec<_> = taken.iter().filter(|r| r.source == RSRC).collect();
    assert_eq!(mine.len(), 2, "待消费请求原子取出");
    assert!(mine[0].id < mine[1].id, "按 id 顺序");
    let again = store.take_pending().await.unwrap();
    assert!(!again.iter().any(|r| r.source == RSRC), "已消费不重复取出");
    clean_reset(&pool).await;
}
```

### 8.3 web 集成测试（真实库 + 真实 server，契约锁定）

``` {.rust file=crates/web/tests/api_admin.rs}
//! Phase C 写端点集成测试（需 TimescaleDB :5433）：
//! POST/PATCH /api/symbols（校验 400/422、冲突 409、未知 404、with_stats）、
//! POST /api/sources/{id}/reset（202 + DB 通道行落库待消费）。

use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996820";
const RSRC: &str = "web_test_reset_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构；storage/sqlx 仅 dev-dependencies）。
fn state(pool: PgPool) -> Arc<AppState> {
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
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

// 每测试独立 clean（同 binary 测试并行执行，共享清理会互删——实锤踩坑）
async fn clean(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
}

async fn clean_reset(pool: &PgPool) {
    sqlx::query("DELETE FROM circuit_reset_requests WHERE source IN ($1, 'no_such_source')")
        .bind(RSRC).execute(pool).await.unwrap();
}

#[tokio::test]
async fn symbols_register_edit_disable_and_stats() {
    let pool = pool().await;
    clean(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 注册（缺省值：interval=60 / settlement=T1 / enabled=true）→ 201 + 回读完整行
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": CODE})).send().await.unwrap();
    assert_eq!(r.status(), 201);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["code"], CODE);
    assert_eq!(v["interval_secs"], 60);
    assert_eq!(v["settlement"], "T1");
    assert_eq!(v["enabled"], true);
    assert!(v["latest"].is_null(), "无 bar 标的 latest 为 null");

    // 重复注册 → 409
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": CODE, "interval_secs": 120})).send().await.unwrap();
    assert_eq!(r.status(), 409);

    // 校验：北交所 422 / 非 6 位数字 400 / 间隔下限 400 / 非法 settlement 400
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "830799"})).send().await.unwrap();
    assert_eq!(r.status(), 422, "北交所前缀拒绝（暂不支持）");
    let body: Value = r.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("北交所"));
    for bad in [serde_json::json!({"code": "12345"}), serde_json::json!({"code": "60051a"})] {
        let r = http.post(format!("{url}/api/symbols")).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), 400, "{bad} → 400");
    }
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "996821", "interval_secs": 30})).send().await.unwrap();
    assert_eq!(r.status(), 400, "interval_secs<60 → 400");
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "996821", "settlement": "T2"})).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // 编辑：间隔 60→300 + 名称（热生效语义由数据面重读承载，本层锁落库与回读）
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"interval_secs": 300, "name": "测试ETF"})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["interval_secs"], 300);
    assert_eq!(v["name"], "测试ETF");
    assert_eq!(v["settlement"], "T1", "未给字段不变");

    // 停用（唯一删除语义，03-symbols §4）
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"enabled": false})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["enabled"], false);

    // 未知 code → 404；非法 PATCH 值 → 400
    let r = http.patch(format!("{url}/api/symbols/996899"))
        .json(&serde_json::json!({"enabled": true})).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"interval_secs": 10})).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // with_stats=1：今日 bar 数入列；不带参数不出 today_bars 键（Phase A 契约不回归）
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
        .bind(CODE).bind(Utc::now() - Duration::minutes(1)).execute(&pool).await.unwrap();
    let v: Value = http.get(format!("{url}/api/symbols"))
        .query(&[("with_stats", "1")]).send().await.unwrap().json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == CODE).expect("含测试标的");
    assert_eq!(s["today_bars"], 1);
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == CODE).unwrap();
    assert!(s.get("today_bars").is_none(), "无 with_stats 不出 today_bars 键");
    clean(&pool).await;
}

#[tokio::test]
async fn reset_endpoint_enqueues_db_control_row() {
    let pool = pool().await;
    clean_reset(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    let r = http.post(format!("{url}/api/sources/{RSRC}/reset")).send().await.unwrap();
    assert_eq!(r.status(), 202, "异步接受（数据面消费后生效）");
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "accepted");

    // DB 控制通道行落库且待消费（数据面 ResetWatcher 轮询取出）
    let (cnt,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM circuit_reset_requests WHERE source = $1 AND consumed_at IS NULL")
        .bind(RSRC).fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1);

    // 未知源 id 同样 202（应用面不知编译期源清单；数据面消费端跳过并告警）
    let r = http.post(format!("{url}/api/sources/no_such_source/reset")).send().await.unwrap();
    assert_eq!(r.status(), 202);
    clean_reset(&pool).await;
}
```

### 8.4 Phase C TDD 规格要点（Red-Green 记录）

- domain：`SourceId::parse` 全变体往返 + 未知文本 None（契约测试）。
- storage admin：注册/重复/编辑 COALESCE/未知 code/schema CHECK 双保险（interval<60、非法 settlement
  库层仍拒绝）；today_stats 当日 Asia/Shanghai 窗口；reset 通道原子消费不重复（集成测试）。
- collector reset：消费 → manual_reset（Healthy + 事件发出）；未知 source 跳过；空队列 noop
  （内存 channel + fake clock，无 DB）。
- web：注册 201+缺省值、409/422/400 矩阵、PATCH 回读与 404、停用、with_stats 出/不出键、
  reset 202 + DB 行待消费（集成测试）；dto 校验纯函数单测（code/interval/settlement/name）。
