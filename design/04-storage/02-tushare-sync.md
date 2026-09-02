# 04-storage/02 — tushare 历史同步（准确层落地）

> 本文档 tangle 生成 `migrations/0005_sync_checkpoints.sql`、`crates/tushare/src/`、`crates/storage/src/` 的准确层部分。
> 决策依据：ADR-003（双真值层）、ADR-016（Provider 双抽象）。父级裁决记录见 §1.2。

## 1. 权限探测结论（2026-09-02 实测，TUSHARE_TOKEN 付费 ETF 档位）

| 接口 | 结果 | 说明 |
|---|---|---|
| `stk_mins`（1min/5min/15min/30min/60min） | ✅ code=0 | 历史深：518880 到 2013-08（上市初），510300 到 2013-01 |
| `fund_daily` | ❌ 40203 无权限 | 与 ADR-003「日级保底」预期相反 |
| `daily` / `index_daily` / `fund_basic` | ❌ 40203 | — |
| `fund_weekly` | ❌ 接口不存在 | — |

**结论**：tushare 原生仅 `stk_mins` 可用 → `supported_periods()` 实报 `[M1]`。
M5/M15/H1/D1 全部标注「本地衍生」：D1 由 `kline_accurate` 的连续聚合 `kline_accurate_1d` 生成（父级裁决：派生数据不物化落行，走 cagg 自动维护，符合 ADR-004 单一事实源哲学）。

## 2. 迁移 0005：同步检查点 + 准确层日级 cagg

⚠️ 工作流注记：initdb 仅在空数据卷首次启动时执行；0005 随本次重建卷生效，
**之后的迁移一律走 sqlx migrate**，不再享受免费 initdb。

⚠️ 运维注记：cagg 刷新策略只覆盖近期窗口（start_offset 3 days），
**大批量历史回填后需手动全量刷新一次**：
`CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL);`
（首拉完成后执行一次；之后增量由策略自动维护）。

``` {.sql file=migrations/0005_sync_checkpoints.sql}
-- 0005_sync_checkpoints.sql — 由 design/04-storage/02-tushare-sync.md tangle 生成，禁止手改
-- 断点续传检查点（tushare 历史同步）
CREATE TABLE sync_checkpoints (
    code             text NOT NULL,
    period           text NOT NULL,          -- M1（当前唯一原生周期）
    last_synced_date date NOT NULL,          -- Asia/Shanghai 口径的已同步截止日（含）
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (code, period)
);

-- 准确层日级连续聚合（父级裁决：D1 不物化落行，由 M1 派生）
CREATE MATERIALIZED VIEW kline_accurate_1d
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 day', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 day', ts, 'Asia/Shanghai');
SELECT add_continuous_aggregate_policy('kline_accurate_1d',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
```

## 3. tushare crate 设计

### 3.1 API 协议与限频

- `POST https://api.tushare.pro`，body：`{"api_name","token","params"}`（参考 golang/pkg/data/source/tushare/client.go）
- 限频：简单间隔节流门（每次 API 调用间隔 ≥ interval，默认 **1000ms**，可配），在适配器内部完成（契约 §2.2）
- 错误分类（ProviderError 契约为 domain 既定，不可改；映射规则如下）：
  - HTTP 403/429 → `RateLimited`（quota 感知：同步循环遇此整体停，checkpoint 已落）
  - reqwest 超时 → `Timeout`；其他传输错误 → `Http`
  - 业务错误 `code != 0`（含 40203 无权限）→ `Http("tushare api error {code}: {msg}")`（永久错误，调用方按 msg 中 code 识别）
  - JSON 解析失败 → `Parse`
  - 空 items（未上市/非交易时段窗口）→ **不是错误**，返回空 vec（窗口步进语义需要）

### 3.2 ts 口径（实测锁定）

- `trade_time` 格式 `2006-01-02 15:04:05`，按 **Asia/Shanghai（固定 +8，无 DST）** 解析转 UTC
- tushare 1m 每日 241 根：09:30–11:30（121 根，含集合竞价 bar）+ 13:01–15:00（120 根）。
  **原样存储**，与旧 Go 系统口径一致。⚠️ 已知风险：午后 bar 似为「末时刻标注」，
  与 raw 层「bar 起始时刻」口径可能错 1 分钟，merge 视图精确 ts 匹配在午后可能两侧并存——
  留给诊断系统分歧比对（ADR-003：不改数据）。
- `vol` 单位为股、`amount` 单位为元（golden 样本验证：1343100 股 × 7.35 ≈ 9874709 元），无需换算

### 3.3 分批策略

单次调用上限 8000 行；1min 每交易日 241 根 → **30 天/窗口**（≈7230 根）。
窗口内若返回满 8000 行，从最后一根 ts +1min 续拉；否则窗口取尽，步进到下一窗口。
全历史起点：无 checkpoint 时先按年探测首个有数据的年份（2012 起），再从该年 1 月起 30 天窗口步进。

``` {.rust file=crates/tushare/src/parse.rs}
//! tushare 响应解析（纯函数，golden 样本 TDD 锁定）。

use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};
use domain::provider::ProviderError;
use domain::types::*;
use serde::Deserialize;

/// Asia/Shanghai 无夏令时，固定 +8（避免引入 chrono-tz 依赖）。
pub const CST_OFFSET_SECS: i32 = 8 * 3600;

pub fn cst() -> FixedOffset {
    FixedOffset::east_opt(CST_OFFSET_SECS).expect("valid offset")
}

/// 北京时间 naive → UTC。
pub fn cst_to_utc(naive: NaiveDateTime) -> DateTime<Utc> {
    cst().from_local_datetime(&naive).single()
        .expect("CST 固定偏移无歧义").with_timezone(&Utc)
}

#[derive(Debug, Deserialize)]
pub struct ApiResponse {
    pub code: i64,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub data: Option<ApiData>,
}

#[derive(Debug, Deserialize)]
pub struct ApiData {
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub items: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    pub has_more: Option<bool>,
}

/// 业务错误分类：code != 0 → Http（含 40203 无权限）；code == 0 → data（缺省为空集）。
pub fn classify_response(resp: ApiResponse) -> Result<ApiData, ProviderError> {
    if resp.code != 0 {
        return Err(ProviderError::Http(format!(
            "tushare api error {}: {}", resp.code, resp.msg.unwrap_or_default())));
    }
    Ok(resp.data.unwrap_or(ApiData { fields: vec![], items: vec![], has_more: None }))
}

/// stk_mins 响应 → Vec<Bar>（ts 升序）。空 items → 空 vec（非错误）。
pub fn parse_stk_mins(data: &ApiData, code: &Code) -> Result<Vec<Bar>, ProviderError> {
    if data.items.is_empty() { return Ok(vec![]); }
    let i_time = field_idx(&data.fields, "trade_time")?;
    let i_open = field_idx(&data.fields, "open")?;
    let i_high = field_idx(&data.fields, "high")?;
    let i_low = field_idx(&data.fields, "low")?;
    let i_close = field_idx(&data.fields, "close")?;
    let i_vol = field_idx(&data.fields, "vol")?;
    let i_amt = field_idx(&data.fields, "amount")?;
    let mut out = Vec::with_capacity(data.items.len());
    for item in &data.items {
        let ts_str = item.get(i_time).and_then(|v| v.as_str())
            .ok_or_else(|| ProviderError::Parse("bad trade_time".into()))?;
        let naive = NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%d %H:%M:%S")
            .map_err(|e| ProviderError::Parse(format!("trade_time '{ts_str}': {e}")))?;
        out.push(Bar {
            code: code.clone(),
            period: Period::M1,
            ts: cst_to_utc(naive),
            open: get_f64(item, i_open)?,
            high: get_f64(item, i_high)?,
            low: get_f64(item, i_low)?,
            close: get_f64(item, i_close)?,
            volume: get_f64(item, i_vol)? as u64,   // 股，无需换算（golden 验证）
            amount: get_f64(item, i_amt)?,          // 元
            source: SourceId::Tushare,
        });
    }
    out.sort_by_key(|b| b.ts);
    Ok(out)
}

fn field_idx(fields: &[String], name: &str) -> Result<usize, ProviderError> {
    fields.iter().position(|f| f == name)
        .ok_or_else(|| ProviderError::Parse(format!("missing field: {name}")))
}

fn get_f64(item: &[serde_json::Value], idx: usize) -> Result<f64, ProviderError> {
    match item.get(idx).and_then(|v| v.as_f64()) {
        Some(x) => Ok(x),
        None => Err(ProviderError::Parse(format!("bad f64 at col {idx}: {:?}", item.get(idx)))),
    }
}
```

``` {.rust file=crates/tushare/src/client.rs}
//! tushare HTTP 客户端：HistoricalDataProvider 实现（ADR-016）。

use crate::parse::*;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use domain::provider::{HistoricalDataProvider, ProviderError};
use domain::types::*;
use tokio::sync::Mutex;
use tokio::time::Instant;

pub const API_URL: &str = "https://api.tushare.pro";
/// tushare 单次调用行数上限（旧 Go 实现同款常量）。
pub const MAX_ROWS_PER_BATCH: usize = 8000;
/// 1min 每交易日 241 根 → 30 天/窗口 ≈ 7230 根 < 8000。
pub const WINDOW_DAYS_1MIN: i64 = 30;
/// 默认限频间隔（任务规格；旧 Go 为 200ms，本系统取保守默认，可配）。
pub const DEFAULT_INTERVAL: Duration = Duration::milliseconds(1000);

/// Code → tushare ts_code（518880 → 518880.SH）。
pub fn to_ts_code(code: &Code) -> Result<String, ProviderError> {
    match code.market().map_err(|e| ProviderError::Parse(e.to_string()))? {
        Market::Sh => Ok(format!("{}.SH", code.0)),
        Market::Sz => Ok(format!("{}.SZ", code.0)),
    }
}

pub struct TushareClient {
    http: reqwest::Client,
    token: String,
    api_url: String,
    interval: Duration,
    /// 上次调用时刻（节流门）；初始化为 interval 之前 → 首次调用不等待。
    gate: Mutex<Instant>,
}

impl TushareClient {
    pub fn new(token: String) -> Self {
        Self::with_config(token, API_URL.to_string(), DEFAULT_INTERVAL)
    }

    pub fn with_config(token: String, api_url: String, interval: Duration) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build().expect("reqwest client build");
        let init = Instant::now()
            .checked_sub(interval.to_std().unwrap_or_default())
            .unwrap_or_else(Instant::now); // 首次调用不等待
        Self { http, token, api_url, interval, gate: Mutex::new(init) }
    }

    /// 间隔节流：保证两次 API 调用间隔 >= interval。
    async fn throttle(&self) {
        let mut g = self.gate.lock().await;
        let next = *g + self.interval.to_std().unwrap_or_default();
        if next > Instant::now() { tokio::time::sleep_until(next).await; }
        *g = Instant::now();
    }

    /// 测试暴露口（集成测试无法触达私有方法；生产路径不用）。
    #[doc(hidden)]
    pub async fn throttle_pub(&self) { self.throttle().await }

    /// 单次 API 调用，返回数据载荷（业务错误已分类）。
    pub(crate) async fn call_api(&self, api_name: &str, params: serde_json::Value)
        -> Result<ApiData, ProviderError>
    {
        self.throttle().await;
        let body = serde_json::json!({
            "api_name": api_name, "token": self.token, "params": params,
        });
        let resp = self.http.post(&self.api_url).json(&body).send().await
            .map_err(map_reqwest_err)?;
        let status = resp.status().as_u16();
        if status == 403 || status == 429 { return Err(ProviderError::RateLimited); }
        let text = resp.text().await.map_err(map_reqwest_err)?;
        let parsed: ApiResponse = serde_json::from_str(&text)
            .map_err(|e| ProviderError::Parse(format!("response json: {e}")))?;
        classify_response(parsed)
    }

    /// stk_mins 单窗口拉取（[start_dt, end_dt]，Asia/Shanghai naive），ts 升序。
    pub async fn fetch_window(&self, ts_code: &str, freq: &str,
                              start_dt: NaiveDateTime, end_dt: NaiveDateTime)
                              -> Result<Vec<Bar>, ProviderError> {
        let data = self.call_api("stk_mins", serde_json::json!({
            "ts_code": ts_code,
            "freq": freq,
            "start_date": start_dt.format("%Y-%m-%d %H:%M:%S").to_string(),
            "end_date": end_dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        })).await?;
        let bare = ts_code.split('.').next().unwrap_or(ts_code);
        parse_stk_mins(&data, &Code(bare.to_string()))
    }
}

fn map_reqwest_err(e: reqwest::Error) -> ProviderError {
    if e.is_timeout() { ProviderError::Timeout } else { ProviderError::Http(e.to_string()) }
}

#[async_trait::async_trait]
impl HistoricalDataProvider for TushareClient {
    fn id(&self) -> SourceId { SourceId::Tushare }

    /// 原生仅 M1；其余周期由 kline_accurate cagg 衍生（§1 裁决）。
    async fn fetch_history(&self, code: &Code, period: Period,
                           start: DateTime<Utc>, end: DateTime<Utc>)
                           -> Result<Vec<Bar>, ProviderError> {
        if period != Period::M1 {
            return Err(ProviderError::Parse(
                "tushare 原生仅 M1；M5/M15/H1/D1 由 kline_accurate cagg 衍生（§1 裁决）".into()));
        }
        let ts_code = to_ts_code(code)?;
        let start_d = start.with_timezone(&cst()).date_naive();
        let end_d = end.with_timezone(&cst()).date_naive();
        let mut out = Vec::new();
        for (ws, we) in crate::sync::plan_windows(start_d, end_d, WINDOW_DAYS_1MIN) {
            let win_close = we.and_hms_opt(15, 0, 0).expect("valid hms");
            let mut cursor = ws.and_hms_opt(9, 0, 0).expect("valid hms");
            loop {
                let batch = self.fetch_window(&ts_code, "1min", cursor, win_close).await?;
                let n = batch.len();
                if n > 0 {
                    let last = batch[n - 1].ts.with_timezone(&cst()).naive_local();
                    out.extend(batch);
                    if n >= MAX_ROWS_PER_BATCH && last < win_close {
                        cursor = last + Duration::minutes(1); // 满批续传
                        continue;
                    }
                }
                break;
            }
        }
        Ok(out)
    }

    fn supported_periods(&self) -> Vec<Period> { vec![Period::M1] }
}
```

``` {.rust file=crates/tushare/src/sync.rs}
//! 同步编排纯逻辑 + 执行器：checkpoint 断点续传、窗口规划、首年探测。

use chrono::{Duration, NaiveDate};

/// 全历史探测下界（510300 等最老 ETF 上市于 2012）。
pub fn full_history_start() -> NaiveDate {
    NaiveDate::from_ymd_opt(2012, 1, 1).expect("valid date")
}

/// 核心标的（阶段 2 优先首拉）。
pub const CORE_CODES: [&str; 4] = ["518880", "513310", "161226", "159776"];

/// 窗口规划：[from, to] 闭区间按 window_days 切片（最后一片可短）。
pub fn plan_windows(from: NaiveDate, to: NaiveDate, window_days: i64) -> Vec<(NaiveDate, NaiveDate)> {
    let mut out = Vec::new();
    let mut s = from;
    while s <= to {
        let e = (s + Duration::days(window_days - 1)).min(to);
        out.push((s, e));
        s = e + Duration::days(1);
    }
    out
}

/// 断点续传起点：有 checkpoint 从次日续，否则全历史。
pub fn resume_from(checkpoint: Option<NaiveDate>) -> NaiveDate {
    checkpoint.map(|d| d + Duration::days(1)).unwrap_or_else(full_history_start)
}
```

``` {.rust file=crates/tushare/src/lib.rs}
//! tushare —— 基础设施：tushare 客户端（HistoricalDataProvider）+ 准确层同步编排。
//! 由 design/04-storage/02-tushare-sync.md tangle 生成（ADR-007），禁止手改。

pub mod client;
pub mod parse;
pub mod sync;
```

### 3.4 测试规格（golden 样本在 `crates/tushare/testdata/`）

- `stk_mins_1min_sample.json`：518880.SH 2025-08-01 完整交易日（241 根，真实 API 响应）
- `stk_mins_empty.json`：未上市窗口空响应（code=0, items=[]）
- `err_permission.json`：fund_daily 40203 权限拒绝响应

``` {.rust file=crates/tushare/tests/golden_parse.rs}
//! golden 样本解析测试：先实调落盘（见 testdata），再离线解析（无网络依赖）。

use chrono::{TimeZone, Utc};
use domain::provider::ProviderError;
use domain::types::*;
use tushare::parse::*;

fn load(name: &str) -> String {
    std::fs::read_to_string(format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR")))
        .expect("golden file exists")
}

#[test]
fn parses_full_trading_day_241_bars() {
    let resp: ApiResponse = serde_json::from_str(&load("stk_mins_1min_sample.json")).unwrap();
    let data = classify_response(resp).expect("code=0");
    let bars = parse_stk_mins(&data, &Code("518880".into())).unwrap();
    assert_eq!(bars.len(), 241, "tushare 1m 口径：09:30-11:30(121) + 13:01-15:00(120)");
    // ts 升序
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts));
    // 首根：2025-08-01 09:30 CST = 01:30 UTC
    assert_eq!(bars[0].ts, Utc.with_ymd_and_hms(2025, 8, 1, 1, 30, 0).unwrap());
    // 末根：15:00 CST = 07:00 UTC
    assert_eq!(bars[240].ts, Utc.with_ymd_and_hms(2025, 8, 1, 7, 0, 0).unwrap());
    // OHLCV 数值（golden 首行对应 15:00 bar，升序后为首根的对端；校验聚合范围）
    assert!(bars.iter().all(|b| b.open > 0.0 && b.high >= b.low && b.amount >= 0.0));
    assert!(bars.iter().all(|b| b.period == Period::M1 && b.source == SourceId::Tushare));
    // vol 单位股（无 ×100 换算）：样本中均为整数股
    let total_vol: u64 = bars.iter().map(|b| b.volume).sum();
    assert!(total_vol > 100_000_000, "518880 日成交应上亿股，实际 {total_vol}");
}

#[test]
fn empty_window_is_not_error() {
    let resp: ApiResponse = serde_json::from_str(&load("stk_mins_empty.json")).unwrap();
    let data = classify_response(resp).expect("code=0 空窗口");
    let bars = parse_stk_mins(&data, &Code("518880".into())).unwrap();
    assert!(bars.is_empty());
}

#[test]
fn permission_denied_maps_to_http_error() {
    let resp: ApiResponse = serde_json::from_str(&load("err_permission.json")).unwrap();
    let err = classify_response(resp).unwrap_err();
    match err {
        ProviderError::Http(msg) => {
            assert!(msg.contains("40203"), "应携带业务错误码: {msg}");
            assert!(msg.contains("fund_daily"), "应携带接口上下文: {msg}");
        }
        other => panic!("40203 应映射 Http，实际 {other:?}"),
    }
}

#[test]
fn cst_naive_converts_to_utc() {
    let naive = chrono::NaiveDate::from_ymd_opt(2025, 8, 1).unwrap().and_hms_opt(9, 30, 0).unwrap();
    assert_eq!(cst_to_utc(naive), Utc.with_ymd_and_hms(2025, 8, 1, 1, 30, 0).unwrap());
}
```

``` {.rust file=crates/tushare/tests/sync_plan.rs}
//! 同步编排纯逻辑测试：窗口规划 / 断点续传 / 节流门。

use chrono::NaiveDate;
use tushare::sync::*;

fn d(y: i32, m: u32, day: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, day).unwrap() }

#[test]
fn windows_cover_closed_interval() {
    let ws = plan_windows(d(2025, 1, 1), d(2025, 3, 15), 30);
    assert_eq!(ws.first().unwrap().0, d(2025, 1, 1));
    assert_eq!(ws.last().unwrap().1, d(2025, 3, 15));
    // 无缝不重叠
    for w in ws.windows(2) {
        assert_eq!(w[1].0, w[0].1 + chrono::Duration::days(1));
    }
    assert!(ws.iter().all(|(s, e)| s <= e));
}

#[test]
fn windows_single_partial() {
    let ws = plan_windows(d(2025, 3, 10), d(2025, 3, 15), 30);
    assert_eq!(ws, vec![(d(2025, 3, 10), d(2025, 3, 15))]);
}

#[test]
fn windows_empty_when_inverted() {
    assert!(plan_windows(d(2025, 3, 15), d(2025, 3, 10), 30).is_empty());
}

#[test]
fn resume_after_checkpoint_next_day() {
    assert_eq!(resume_from(Some(d(2025, 8, 1))), d(2025, 8, 2));
}

#[test]
fn resume_without_checkpoint_full_history() {
    assert_eq!(resume_from(None), full_history_start());
    assert_eq!(full_history_start(), d(2012, 1, 1));
}

#[tokio::test]
async fn throttle_enforces_interval() {
    let c = tushare::client::TushareClient::with_config(
        "t".into(), "http://127.0.0.1:1".into(), chrono::Duration::milliseconds(50));
    let t0 = std::time::Instant::now();
    for _ in 0..3 { c.throttle_pub().await; }
    assert!(t0.elapsed() >= std::time::Duration::from_millis(100),
        "3 次节流调用（首次立即）应至少间隔 2×50ms，实际 {:?}", t0.elapsed());
}
```

> ⚠️ `throttle_pub` 为 `#[cfg(test)]`/`pub(crate)` 测试暴露口的集成测试妥协：
> 集成测试无法触达私有方法，故 client 提供 `#[doc(hidden)] pub async fn throttle_pub`
> 委托私有 `throttle`（生产路径不受影响）。

## 4. storage crate：准确层写入（upsert，与 raw 首写胜出相反——设计意图）

ADR-003：tushare 修正允许覆盖，`ON CONFLICT (code,ts,period) DO UPDATE`；
raw 层 `DO NOTHING`（首写胜出）由 Wave 1 采集服务实现，不在本文档范围。

``` {.rust file=crates/storage/src/accurate.rs}
//! 准确层（kline_accurate）写入：ON CONFLICT DO UPDATE（修正覆盖语义）。

use anyhow::Result;
use chrono::NaiveDate;
use domain::types::*;
use sqlx::PgPool;

pub struct AccurateWriter {
    pool: PgPool,
}

pub fn period_str(p: Period) -> &'static str {
    match p { Period::M1 => "M1", Period::M5 => "M5", Period::M15 => "M15",
              Period::H1 => "H1", Period::D1 => "D1" }
}

fn source_str(s: SourceId) -> &'static str {
    match s {
        SourceId::TencentIfzq => "tencent_ifzq", SourceId::SinaJsonp => "sina_jsonp",
        SourceId::TencentQt => "tencent_qt", SourceId::SinaHq => "sina_hq",
        SourceId::ThsCs => "ths_cs", SourceId::Push2delay => "push2delay",
        SourceId::Exchange => "exchange", SourceId::Tushare => "tushare",
    }
}

impl AccurateWriter {
    pub fn new(pool: PgPool) -> Self { Self { pool } }

    /// 批量 upsert：冲突（code,ts,period）覆盖 OHLCV 与 synced_at。返回受影响行数。
    pub async fn upsert_batch(&self, bars: &[Bar]) -> Result<u64> {
        if bars.is_empty() { return Ok(0); }
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO kline_accurate \
             (code, ts, period, open, high, low, close, volume, amount, source) ");
        qb.push_values(bars.iter(), |mut b, bar| {
            b.push_bind(bar.code.0.clone())
             .push_bind(bar.ts)
             .push_bind(period_str(bar.period))
             .push_bind(bar.open)
             .push_bind(bar.high)
             .push_bind(bar.low)
             .push_bind(bar.close)
             .push_bind(bar.volume as i64)
             .push_bind(bar.amount)
             .push_bind(source_str(bar.source));
        });
        qb.push(" ON CONFLICT (code, ts, period) DO UPDATE SET \
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, \
            close = EXCLUDED.close, volume = EXCLUDED.volume, \
            amount = EXCLUDED.amount, source = EXCLUDED.source, \
            synced_at = now()");
        let res = qb.build().execute(&self.pool).await?;
        Ok(res.rows_affected())
    }
}

/// 断点续传检查点读写。
pub async fn get_checkpoint(pool: &PgPool, code: &str, period: &str) -> Result<Option<NaiveDate>> {
    let row: Option<(NaiveDate,)> = sqlx::query_as(
        "SELECT last_synced_date FROM sync_checkpoints WHERE code = $1 AND period = $2")
        .bind(code).bind(period).fetch_optional(pool).await?;
    Ok(row.map(|r| r.0))
}

pub async fn set_checkpoint(pool: &PgPool, code: &str, period: &str, date: NaiveDate) -> Result<()> {
    sqlx::query(
        "INSERT INTO sync_checkpoints (code, period, last_synced_date) VALUES ($1, $2, $3) \
         ON CONFLICT (code, period) DO UPDATE SET \
            last_synced_date = EXCLUDED.last_synced_date, updated_at = now()")
        .bind(code).bind(period).bind(date).execute(pool).await?;
    Ok(())
}
```

``` {.rust file=crates/storage/src/lib.rs}
//! storage —— 基础设施：TimescaleDB 读写（sqlx）。
//! 由 design/04-storage/*.md tangle 生成（ADR-007），禁止手改。

pub mod accurate;
```

``` {.rust file=crates/storage/tests/accurate_upsert.rs}
//! 准确层 upsert 语义集成测试（需 TimescaleDB :5433，设计意图锁定）：
//! 准确层允许 tushare 修正覆盖（DO UPDATE），与 raw 层首写胜出（DO NOTHING）相反。

use chrono::{TimeZone, Utc};
use domain::types::*;
use sqlx::PgPool;
use storage::accurate::{period_str, AccurateWriter};

fn bar(close: f64) -> Bar {
    Bar {
        code: Code("999999".into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2025, 8, 1, 1, 30, 0).unwrap(),
        open: 1.0, high: 1.0, low: 1.0, close, volume: 100, amount: 100.0,
        source: SourceId::Tushare,
    }
}

#[tokio::test]
async fn conflict_updates_row_not_keeps_first() {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    let pool = PgPool::connect(&url).await.expect("TimescaleDB :5433 可用");
    let w = AccurateWriter::new(pool.clone());

    w.upsert_batch(&[bar(1.0)]).await.unwrap();
    w.upsert_batch(&[bar(2.0)]).await.unwrap(); // 修正覆盖

    let (cnt, close): (i64, f64) = sqlx::query_as(
        "SELECT COUNT(*), MAX(close) FROM kline_accurate WHERE code='999999' AND period='M1'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1, "同键不重复落行");
    assert_eq!(close, 2.0, "准确层后写覆盖先写（修正语义）");

    sqlx::query("DELETE FROM kline_accurate WHERE code='999999'")
        .execute(&pool).await.unwrap();
}

#[tokio::test]
async fn checkpoints_roundtrip() {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    let pool = PgPool::connect(&url).await.unwrap();
    let d = chrono::NaiveDate::from_ymd_opt(2025, 8, 1).unwrap();
    assert_eq!(storage::accurate::get_checkpoint(&pool, "999999", "M1").await.unwrap(), None);
    storage::accurate::set_checkpoint(&pool, "999999", "M1", d).await.unwrap();
    assert_eq!(storage::accurate::get_checkpoint(&pool, "999999", "M1").await.unwrap(), Some(d));
    let d2 = chrono::NaiveDate::from_ymd_opt(2025, 8, 15).unwrap();
    storage::accurate::set_checkpoint(&pool, "999999", "M1", d2).await.unwrap();
    assert_eq!(storage::accurate::get_checkpoint(&pool, "999999", "M1").await.unwrap(), Some(d2),
        "checkpoint 可推进（upsert）");
    sqlx::query("DELETE FROM sync_checkpoints WHERE code='999999'")
        .execute(&pool).await.unwrap();
    assert_eq!(period_str(Period::M1), "M1");
}
```

## 5. 同步执行器（bin `tushare_sync`）

阶段编排（任务书）：阶段1/2/3 合并为一轮 1m 全历史（§1 裁决：D1 由 cagg 衍生），
排序 = 4 只核心优先 → 其余按代码序；quota 感知：`RateLimited` 即整体退出（exit 2），
checkpoint 已逐窗口落库，明日续传无副作用。

``` {.rust file=crates/tushare/src/bin/tushare_sync.rs}
//! tushare_sync —— ETF 1m 全历史首拉（断点续传）。
//! 用法：DATABASE_URL=... TUSHARE_TOKEN=... tushare_sync [--only 518880,159776] [--interval-ms 1000]

use chrono::{Datelike, Local, NaiveDate};
use domain::provider::ProviderError;
use domain::types::*;
use sqlx::PgPool;
use storage::accurate::{get_checkpoint, set_checkpoint, AccurateWriter};
use tushare::client::{to_ts_code, TushareClient, WINDOW_DAYS_1MIN};
use tushare::sync::{full_history_start, plan_windows, resume_from, CORE_CODES};
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into())).init();

    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    let token = std::env::var("TUSHARE_TOKEN").expect("TUSHARE_TOKEN required");
    let args: Vec<String> = std::env::args().collect();
    let only = arg_vals(&args, "--only");
    let interval_ms: i64 = arg_vals(&args, "--interval-ms")
        .and_then(|s| s.parse().ok()).unwrap_or(1000);

    let pool = PgPool::connect(&db_url).await?;
    let client = TushareClient::with_config(
        token, tushare::client::API_URL.into(),
        chrono::Duration::milliseconds(interval_ms));
    let writer = AccurateWriter::new(pool.clone());

    // 标序：核心 4 只优先 → 其余代码序
    let mut codes: Vec<String> = match only {
        Some(csv) => csv.split(',').map(|s| s.trim().to_string()).collect(),
        None => sqlx::query_scalar("SELECT code FROM symbols WHERE enabled ORDER BY code")
            .fetch_all(&pool).await?,
    };
    codes.sort_by_key(|c| (CORE_CODES.contains(&c.as_str()) as u8 ^ 1, c.clone()));

    let today = Local::now().date_naive();
    let mut done = 0usize;
    for code in &codes {
        info!(code, "=== sync start ===");
        match sync_one(&client, &writer, &pool, code, today).await {
            Ok(n) => { done += 1; info!(code, bars = n, "=== sync done ==="); }
            Err(ProviderError::RateLimited) => {
                error!(code, "quota/rate limited —— checkpoint 已落库，退出待续传");
                std::process::exit(2);
            }
            Err(e) => { warn!(code, error = %e, "sync failed, skip to next"); }
        }
    }
    info!(done, total = codes.len(), "all done");
    Ok(())
}

/// 单标的 1m 全历史：首年探测（仅无 checkpoint 时）→ 30 天窗口步进 → 逐窗口落库 + checkpoint。
async fn sync_one(client: &TushareClient, writer: &AccurateWriter, pool: &PgPool,
                  code: &str, today: NaiveDate) -> Result<usize, ProviderError> {
    let cp = get_checkpoint(pool, code, "M1").await
        .map_err(|e| ProviderError::Http(e.to_string()))?;
    let start = match cp {
        Some(_) => resume_from(cp),
        None => match first_data_year(client, code).await? {
            Some(y) => NaiveDate::from_ymd_opt(y, 1, 1).unwrap(),
            None => {
                set_checkpoint(pool, code, "M1", today).await
                    .map_err(|e| ProviderError::Http(e.to_string()))?;
                info!(code, "no data since {}; mark done", full_history_start());
                return Ok(0);
            }
        },
    };
    if start > today { info!(code, "up to date"); return Ok(0); }

    let ts_code = to_ts_code(&Code(code.to_string()))?;
    let mut total = 0usize;
    for (ws, we) in plan_windows(start, today, WINDOW_DAYS_1MIN) {
        let s = ws.and_hms_opt(9, 0, 0).unwrap();
        let e = we.and_hms_opt(15, 0, 0).unwrap();
        // 窗口内满批续传（罕见：30d×241≈7230<8000，防御性保留）
        let mut cursor = s;
        loop {
            let bars = client.fetch_window(&ts_code, "1min", cursor, e).await?;
            let n = bars.len();
            if n > 0 {
                let last_cst = bars[n - 1].ts.with_timezone(&tushare::parse::cst()).naive_local();
                writer.upsert_batch(&bars).await
                    .map_err(|e2| ProviderError::Http(e2.to_string()))?;
                total += n;
                if n >= tushare::client::MAX_ROWS_PER_BATCH && last_cst < e {
                    cursor = last_cst + chrono::Duration::minutes(1);
                    continue;
                }
            }
            break;
        }
        set_checkpoint(pool, code, "M1", we).await
            .map_err(|e2| ProviderError::Http(e2.to_string()))?;
        info!(code, window = %format!("{ws}..{we}"), total, "window synced");
    }
    Ok(total)
}

/// 首年探测：2012 起逐年单窗口，首次非空即停（每次 1 调用，最多 ~15 次）。
async fn first_data_year(client: &TushareClient, code: &str) -> Result<Option<i32>, ProviderError> {
    let ts_code = to_ts_code(&Code(code.to_string()))?;
    let this_year = Local::now().year();
    for y in full_history_start().year()..=this_year {
        let s = NaiveDate::from_ymd_opt(y, 1, 1).unwrap().and_hms_opt(9, 0, 0).unwrap();
        let e = NaiveDate::from_ymd_opt(y, 12, 31).unwrap().and_hms_opt(15, 0, 0).unwrap();
        let bars = client.fetch_window(&ts_code, "1min", s, e).await?;
        if let Some(first) = bars.last() {
            let fy = first.ts.with_timezone(&tushare::parse::cst()).year();
            info!(code, first_year = fy, "first data year found");
            return Ok(Some(fy));
        }
    }
    Ok(None)
}

fn arg_vals(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}
```

> 注：`first_data_year` 返回 bars.last() 的年份而非循环年——`stk_mins` 降序返回，
> last 即最早一根，防止「年窗口有数据但起始跨年」误判。
