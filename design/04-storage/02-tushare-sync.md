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

/// checkpoint 推进封顶（缺陷 2 修复，父级裁决 2026-09-03，§6.1）：
/// 盘中（Asia/Shanghai 15:00 收盘前）的同步不得将当日标记为完成 —— 封顶前一自然日；
/// 收盘后（含 15:00）允许含当日。日增量（daily.rs）与手动全量 bin（tushare_sync）共用此口径。
pub fn checkpoint_through_cap(now: chrono::DateTime<chrono::Utc>) -> NaiveDate {
    let cst = domain::tz::utc_to_cst(now);
    let close = chrono::NaiveTime::from_hms_opt(15, 0, 0).expect("valid hms");
    if cst.time() < close { cst.date() - Duration::days(1) } else { cst.date() }
}
```

``` {.rust file=crates/tushare/src/lib.rs}
//! tushare —— 基础设施：tushare 客户端（HistoricalDataProvider）+ 准确层同步编排。
//! 由 design/04-storage/02-tushare-sync.md tangle 生成（ADR-007），禁止手改。

pub mod client;
pub mod daily;
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

#[test]
fn checkpoint_cap_intraday_vs_after_close() {
    // 缺陷 2 修复口径 a：盘中（CST 15:00 收盘前）checkpoint 封顶前一自然日；收盘后允许含当日。
    use chrono::{TimeZone, Utc};
    let intraday = Utc.with_ymd_and_hms(2026, 9, 3, 6, 59, 0).unwrap(); // 14:59 CST
    assert_eq!(checkpoint_through_cap(intraday), d(2026, 9, 2), "收盘前 1 分钟仍盘中");
    let close = Utc.with_ymd_and_hms(2026, 9, 3, 7, 0, 0).unwrap();    // 15:00 CST
    assert_eq!(checkpoint_through_cap(close), d(2026, 9, 3), "收盘后允许含当日");
    let morning = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap(); // 09:30 CST
    assert_eq!(checkpoint_through_cap(morning), d(2026, 9, 2));
    let evening = Utc.with_ymd_and_hms(2026, 9, 3, 8, 0, 0).unwrap(); // 16:00 CST 盘后
    assert_eq!(checkpoint_through_cap(evening), d(2026, 9, 3), "盘后允许含当日");
    let next_day = Utc.with_ymd_and_hms(2026, 9, 3, 16, 0, 0).unwrap(); // 次日 00:00 CST
    assert_eq!(checkpoint_through_cap(next_day), d(2026, 9, 3), "跨日边界按 CST 日期：次日凌晨仍视为次日的盘中");
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
              Period::H1 => "H1", Period::D1 => "D1",
              Period::W1 => "W1", Period::MO1 => "MO1" }
}

// source 列文本口径单一事实源在 domain（SourceId::as_str，含 *_approx 变体）。

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
             .push_bind(bar.source.as_str());
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

/// crate 编译时版本（settings 页 system-info 展示；由 app 装配 CrateVersions）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod accurate;
pub mod events;
pub mod kline;
pub mod migrate_check;
// reader：应用面只读加法扩展（Wave 1 Phase A，ADR-017 授权口径；代码块在 design/07-app-plane/00-web-api.md）
pub mod reader;
pub mod symbols;
// admin：应用面写/控制通道加法扩展（Wave 1 Phase C：标的管理写 + 熔断复位 DB 通道；
// 代码块在 design/07-app-plane/00-web-api.md）
pub mod admin;
// alerts：告警引擎端口实现加法扩展（Wave 2 Phase B：PgAlertStore + PgAlertEval；
// 代码块在 design/07-app-plane/02-alerts.md）
pub mod alerts;
// system：页面⑧ 设置页 S1 端口实现加法扩展（SystemInfoRead + RawPurgePort；
// 代码块在 design/06-web/08-settings.md）
pub mod system;
// backtest：回测取数端口实现（Wave 3 Phase 3a：BacktestBarRead；P4b 起 BacktestRunStore 随旧回测服务退役删除，
// BacktestBarReader 保留供 strategy 试算 / workbench / mcp 复用；
// 代码块在 design/04-storage/schema.md §4.3.5。backtest.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod backtest;
// favorite：看板收藏端口实现加法扩展（Wave 3 页面①：FavoriteStore；
// 代码块在 design/04-storage/schema.md §4.3.6。favorite.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod favorite;
// ma_config：行情看板 MA 可配置端口实现加法扩展（后端 W1：MaConfigStore；
// 代码块在 design/04-storage/schema.md §4.3.7。ma_config.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod ma_config;
// config_store：页面⑧ 系统设置 S2 配置持久化端口实现加法扩展（ConfigStore，app_config 表，迁移 0021；
// 代码块在 design/04-storage/schema.md。config_store.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod config_store;
// sim：模拟实盘会话存储端口实现加法扩展（L1 sim-live：SimSessionStore；
// 代码块在 design/04-storage/schema.md §4.3.10。sim.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod sim;
// strategy：策略 Registry 存储端口实现加法扩展（12-strategy-system / P2a：StrategyStore；
// 代码块在 design/04-storage/schema.md §4.3.13。strategy.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod strategy;
// workbench：回测工作台存储端口实现加法扩展（12-strategy-system / P3a：StrategyRunStore + StrategyPresetStore；
// 代码块在 design/04-storage/schema.md §4.3.14。workbench.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod workbench;
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
use domain::ports::{ErrKind, EventSink, HealthEvent};
use domain::provider::ProviderError;
use domain::types::*;
use sqlx::PgPool;
use storage::accurate::{get_checkpoint, set_checkpoint, AccurateWriter};
use storage::events::PgEventSink;
use tushare::client::{to_ts_code, TushareClient, WINDOW_DAYS_1MIN};
use tushare::sync::{checkpoint_through_cap, full_history_start, plan_windows, resume_from, CORE_CODES};
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
    let sink = PgEventSink::new(pool.clone());

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
        match sync_one(&client, &writer, &pool, &sink, code, today).await {
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
/// 缺陷 2 修复（§6.1）：checkpoint 推进经 checkpoint_through_cap 封顶（盘中不封当日）；
/// 「已最新」零调用跳过落审计事件（ok=true + err_kind=na，禁止静默跳过）。
async fn sync_one(client: &TushareClient, writer: &AccurateWriter, pool: &PgPool,
                  sink: &PgEventSink, code: &str, today: NaiveDate) -> Result<usize, ProviderError> {
    let cap = checkpoint_through_cap(chrono::Utc::now());
    let cp = get_checkpoint(pool, code, "M1").await
        .map_err(|e| ProviderError::Http(e.to_string()))?;
    let start = match cp {
        Some(_) => resume_from(cp),
        None => match first_data_year(client, code).await? {
            Some(y) => NaiveDate::from_ymd_opt(y, 1, 1).unwrap(),
            None => {
                set_checkpoint(pool, code, "M1", today.min(cap)).await
                    .map_err(|e| ProviderError::Http(e.to_string()))?;
                info!(code, "no data since {}; mark done", full_history_start());
                return Ok(0);
            }
        },
    };
    if start > today {
        info!(code, "up to date");
        // 缺陷 2 修复口径 b：零调用跳过落审计事件（ok=true + err_kind=na，附跳过原因）
        if let Err(e) = sink.emit(HealthEvent {
            ts: chrono::Utc::now(), source: SourceId::Tushare, ok: true, latency_ms: None,
            err_kind: Some(ErrKind::Na), code: Some(Code(code.to_string())),
            trace_id: Some("skip:up_to_date".into()),
        }).await {
            warn!(code, error = %e, "skip-audit event emit failed");
        }
        return Ok(0);
    }

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
        // 缺陷 2 修复口径 a：盘中同步 checkpoint 封顶前一自然日（不封当日）
        set_checkpoint(pool, code, "M1", we.min(cap)).await
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

## 6. 日增量定时任务（数据面内置，wave-0 范围）

每自然日 **08:00 / 18:00 / 00:00 Asia/Shanghai** 三时点各触发一轮完整增量同步（§6.2，用户决策 2026-09-03；
复用 sync_checkpoints 断点续传，目标交易日 = 最近一个已收盘工作日）；
失败指数退避重试 3 次；`RateLimited`（quota）整轮中止（§5 口径）；事件落 source_health_events（source=tushare）。
既有全量同步 bin `tushare_sync` 保留为手动运维命令。

### 6.1 checkpoint 语义修正（缺陷 2 修复，父级裁决 2026-09-03）

背景（tester 004 §8）：手动全量同步盘中将 checkpoint 预置为当日 → 15:30 日增量判「已最新」
整轮静默跳过（0.048s / 0 API 调用 / 0 事件），当日准确层落空。修正口径（两点）：

- **a. 盘中不封当日**：任何同步（日增量与手动 bin 共用 `sync::checkpoint_through_cap`）在
  Asia/Shanghai 15:00 收盘前，checkpoint 推进封顶前一自然日；收盘后（含 15:00）允许含当日。
  同时日增量对**当个交易日强制同步**：拉取起点 = `min(checkpoint+1日, 今日)`，
  即 checkpoint==今日也重拉当日窗口 —— 准确层 `ON CONFLICT DO UPDATE` 幂等去重，重拉无副作用。
- **b. 禁止静默跳过**：整轮零调用（无启用标的）必须落审计事件（source=tushare，ok=true，
  err_kind=na，原因载于 trace_id 形如 `skip:<reason>`）；手动 bin 的「已最新」零调用跳过同理落审计。
  注：0001 schema 无 detail 列，监控以该 na 事件为信号、原因查日志。

### 6.2 三时点调度（用户决策 2026-09-03）

背景：tushare ETF 历史整理耗时长，收盘后不能立即更新完毕 → 单一 15:30 触发不可靠，
需多次补全直至收敛。调度改为每自然日 **18:00 / 00:00 / 08:00 CST** 三个触发点：

- 三时点各自独立触发完整增量 `[min(checkpoint+1日, target), target]`（target = `sync_target_date`，
  最近已收盘工作日：18:00 → 当日；00:00/08:00 → 前一交易日，跨周末回退）；
  各自独立退避重试 3 次、各自落事件（含 §6.1-b 零调用审计事件）。
- 与缺陷 2 修正并存：每轮均含目标交易日（强制同步，盘中不封当日的 cap 语义不变）；
  **前提**：准确层写入为 upsert 覆盖语义（§4 `conflict_updates_row_not_keeps_first` 测试锁定），
  后次同步覆盖修正前次不完整数据。

``` {.rust file=crates/tushare/src/daily.rs}
//! 日增量同步定时任务（数据面内置）。纯逻辑可测（注入 Clock / mock Provider / 内存 Store）。

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use domain::ports::{Clock, ErrKind, EventSink, HealthEvent};
use domain::provider::{HistoricalDataProvider, ProviderError};
use domain::types::*;
use domain::tz::cst_to_utc;
use domain::tz::utc_to_cst;
use std::sync::Arc;

pub const MAX_ATTEMPTS: u32 = 3;

/// 三时点调度（用户决策 2026-09-03，§6.2）：每自然日 CST 08:00 / 18:00 / 00:00 各触发一轮完整增量。
/// tushare ETF 历史整理耗时长、收盘后不能立即更新，多次补全直至收敛
/// （前提：准确层 upsert 覆盖语义，后次同步修正前次不完整数据，见 §4 accurate_upsert 测试锁定）。
pub const RUN_TIMES: [(u32, u32); 3] = [(0, 0), (8, 0), (18, 0)];

/// 下次触发时刻：严格晚于 now 的最近一个 CST 08:00/18:00/00:00。
/// 含周末触发（周末轮次目标交易日回退到周五，多次补全直至收敛）。
pub fn next_run_after(now: DateTime<Utc>) -> DateTime<Utc> {
    let mut date = utc_to_cst(now).date();
    for _ in 0..10 {
        for &(h, m) in &RUN_TIMES {
            let run = cst_to_utc(date.and_hms_opt(h, m, 0).expect("valid hms"));
            if run > now { return run; }
        }
        date += Duration::days(1);
    }
    unreachable!("10 天内必有触发点")
}

/// 同步目标交易日（三时点口径）：最近一个已收盘（15:00 CST 已过）的工作日。
/// 18:00 触发 → 当日；00:00/08:00 触发 → 前一交易日（跨周末回退，Wave 0 日历=仅工作日）。
pub fn sync_target_date(now: DateTime<Utc>) -> NaiveDate {
    let cst = utc_to_cst(now);
    let close = chrono::NaiveTime::from_hms_opt(15, 0, 0).expect("valid hms");
    let mut d = if cst.time() < close { cst.date() - Duration::days(1) } else { cst.date() };
    while matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun) {
        d -= Duration::days(1);
    }
    d
}

/// 退避档：base ×2^n（attempt 0-based），封顶 10min。默认 base 60s。
pub fn retry_backoff(base: std::time::Duration, attempt: u32) -> std::time::Duration {
    (base * 2u32.pow(attempt.min(4))).min(std::time::Duration::from_secs(600))
}

/// 日增量存储端口（测试可内存实现；生产 = PgDailyStore）。
#[async_trait::async_trait]
pub trait DailyStore: Send + Sync {
    async fn checkpoint(&self, code: &str) -> anyhow::Result<Option<NaiveDate>>;
    /// 落 accurate + 推进 checkpoint 到 synced_through。返回 upsert 行数。
    async fn save(&self, code: &str, bars: &[Bar], synced_through: NaiveDate) -> anyhow::Result<u64>;
    async fn enabled_codes(&self) -> anyhow::Result<Vec<String>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DailyOutcome {
    Synced { codes: usize, bars: usize },
    /// 任一 code 重试耗尽（其余已续跑）；RateLimited 整轮中止也归此。
    Failed,
}

pub struct DailySync {
    provider: Arc<dyn HistoricalDataProvider>,
    store: Arc<dyn DailyStore>,
    sink: Arc<dyn EventSink>,
    clock: Arc<dyn Clock>,
    backoff_base: std::time::Duration,
}

impl DailySync {
    pub fn new(provider: Arc<dyn HistoricalDataProvider>, store: Arc<dyn DailyStore>,
               sink: Arc<dyn EventSink>, clock: Arc<dyn Clock>) -> Self {
        Self::with_backoff(provider, store, sink, clock, std::time::Duration::from_secs(60))
    }

    /// 测试可注入零退避。
    pub fn with_backoff(provider: Arc<dyn HistoricalDataProvider>, store: Arc<dyn DailyStore>,
                        sink: Arc<dyn EventSink>, clock: Arc<dyn Clock>,
                        backoff_base: std::time::Duration) -> Self {
        Self { provider, store, sink, clock, backoff_base }
    }

    async fn emit(&self, ok: bool, latency_ms: Option<u32>, err: Option<ErrKind>, code: Option<&str>) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: SourceId::Tushare, ok, latency_ms, err_kind: err,
            code: code.map(|c| Code(c.to_string())), trace_id: Some(new_trace_id()),
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(error = %e, "tushare daily event emit failed");
        }
    }

    /// 审计事件（缺陷 2 修复口径 b）：整轮跳过/零调用落 source_health_events
    /// （source=tushare, ok=true, err_kind=na；原因载于 trace_id，形如 "skip:<reason>"）。
    /// 注：0001 schema 无 detail 列，PgEventSink 持久化 ts/source/ok/latency/err_kind/code；
    /// 监控以该 na 事件为信号，跳过原因查日志（trace_id 随内存事件/断言可见）。
    async fn emit_skip_audit(&self, reason: &str) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: SourceId::Tushare, ok: true, latency_ms: None,
            err_kind: Some(ErrKind::Na), code: None, trace_id: Some(format!("skip:{reason}")),
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(error = %e, "tushare daily skip-audit event emit failed");
        }
    }

    /// 单 code 增量：拉取窗口 = [min(checkpoint+1日, target), target]
    /// （target = sync_target_date 最近已收盘工作日，三时点均含目标交易日）。
    /// 缺陷 2 修复（§6.1）：目标交易日**强制同步**（checkpoint==target 也重拉，
    /// 准确层 ON CONFLICT DO UPDATE 幂等去重——三时点多次补全方案的前提）；
    /// checkpoint 推进经 sync::checkpoint_through_cap 封顶（盘中不得标记当日完成）。
    async fn sync_code(&self, code: &str, target: NaiveDate, now: DateTime<Utc>) -> Result<usize, ProviderError> {
        let cp = self.store.checkpoint(code).await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        let start = crate::sync::resume_from(cp).min(target);
        let bars = self.provider.fetch_history(
            &Code(code.to_string()), Period::M1,
            cst_to_utc(start.and_hms_opt(0, 0, 0).expect("valid hms")),
            cst_to_utc(target.and_hms_opt(15, 0, 0).expect("valid hms"))).await?;
        let n = bars.len();
        let through = target.min(crate::sync::checkpoint_through_cap(now));
        self.store.save(code, &bars, through).await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        Ok(n)
    }

    /// 单轮：逐 code 增量（目标 = 最近已收盘工作日），失败指数退避重试 MAX_ATTEMPTS 次；
    /// RateLimited 整轮中止。三时点各自独立触发一轮（各自独立重试与审计事件）。
    pub async fn run(&self) -> DailyOutcome {
        let now = self.clock.now();
        let target = sync_target_date(now);
        let codes = match self.store.enabled_codes().await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "tushare daily: read symbols failed");
                self.emit(false, None, Some(ErrKind::Http), None).await;
                return DailyOutcome::Failed;
            }
        };
        if codes.is_empty() {
            // 缺陷 2 修复口径 b（禁止静默跳过）：整轮零调用落审计事件
            tracing::warn!("tushare daily: no enabled codes, round skipped (zero API calls)");
            self.emit_skip_audit("no_enabled_codes").await;
            return DailyOutcome::Synced { codes: 0, bars: 0 };
        }
        let mut total_bars = 0usize;
        let mut done = 0usize;
        let mut failed = false;
        for code in &codes {
            let mut attempt = 0u32;
            loop {
                let t0 = std::time::Instant::now();
                match self.sync_code(code, target, now).await {
                    Ok(n) => {
                        self.emit(true, Some(t0.elapsed().as_millis() as u32), None, Some(code)).await;
                        total_bars += n;
                        done += 1;
                        break;
                    }
                    Err(ProviderError::RateLimited) => {
                        // quota 感知：整轮中止，checkpoint 已逐 code 落库（§5 口径）
                        self.emit(false, None, Some(ErrKind::RateLimited), Some(code)).await;
                        tracing::error!(code, "tushare daily: rate limited, abort round");
                        return DailyOutcome::Failed;
                    }
                    Err(e) => {
                        attempt += 1;
                        let kind = match &e {
                            ProviderError::Timeout => ErrKind::Timeout,
                            ProviderError::Parse(_) => ErrKind::Parse,
                            _ => ErrKind::Http,
                        };
                        self.emit(false, None, Some(kind), Some(code)).await;
                        if attempt >= MAX_ATTEMPTS {
                            tracing::error!(code, attempts = attempt, "tushare daily: retries exhausted, skip code");
                            failed = true;
                            break;
                        }
                        let wait = retry_backoff(self.backoff_base, attempt - 1);
                        tracing::warn!(code, attempt, wait_ms = wait.as_millis() as u64,
                            error = %e, "tushare daily: retry after backoff");
                        tokio::time::sleep(wait).await;
                    }
                }
            }
        }
        if failed { DailyOutcome::Failed } else { DailyOutcome::Synced { codes: done, bars: total_bars } }
    }
}

/// 生产 Store：复用 storage 准确层（upsert + sync_checkpoints）与 symbols 表。
pub struct PgDailyStore {
    pool: sqlx::PgPool,
}

impl PgDailyStore {
    pub fn new(pool: sqlx::PgPool) -> Self { Self { pool } }
}

#[async_trait::async_trait]
impl DailyStore for PgDailyStore {
    async fn checkpoint(&self, code: &str) -> anyhow::Result<Option<NaiveDate>> {
        storage::accurate::get_checkpoint(&self.pool, code, "M1").await
    }

    async fn save(&self, code: &str, bars: &[Bar], synced_through: NaiveDate) -> anyhow::Result<u64> {
        let n = storage::accurate::AccurateWriter::new(self.pool.clone()).upsert_batch(bars).await?;
        storage::accurate::set_checkpoint(&self.pool, code, "M1", synced_through).await?;
        Ok(n)
    }

    async fn enabled_codes(&self) -> anyhow::Result<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT code FROM symbols WHERE enabled ORDER BY code")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }
}

/// 定时循环（薄胶合）：睡到下一触发点 → 跑一轮 → 循环。
pub async fn run_forever(sync: Arc<DailySync>, clock: Arc<dyn Clock>) {
    loop {
        let next = next_run_after(clock.now());
        let wait = (next - clock.now()).to_std().unwrap_or(std::time::Duration::ZERO);
        tracing::info!(next_run = %next, wait_secs = wait.as_secs(), "tushare daily scheduled");
        tokio::time::sleep(wait).await;
        let outcome = sync.run().await;
        tracing::info!(?outcome, "tushare daily round done");
    }
}
```

``` {.rust file=crates/tushare/tests/daily_sync.rs}
//! 日增量定时任务测试（fake clock + mock provider + 内存 store，不触网）。

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use domain::ports::{Clock, EventSink, HealthEvent};
use domain::provider::{HistoricalDataProvider, ProviderError};
use domain::types::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tushare::daily::*;

struct FakeClock(Mutex<DateTime<Utc>>);
impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> { *self.0.lock().unwrap() }
}

#[derive(Default)]
struct MemSink { events: Mutex<Vec<HealthEvent>> }
#[async_trait::async_trait]
impl EventSink for MemSink {
    async fn emit(&self, ev: HealthEvent) -> anyhow::Result<()> {
        self.events.lock().unwrap().push(ev);
        Ok(())
    }
}

#[derive(Default)]
struct MemStore {
    cps: Mutex<HashMap<String, NaiveDate>>,
    saved: Mutex<HashMap<String, usize>>,
    codes: Vec<String>,
}
#[async_trait::async_trait]
impl DailyStore for MemStore {
    async fn checkpoint(&self, code: &str) -> anyhow::Result<Option<NaiveDate>> {
        Ok(self.cps.lock().unwrap().get(code).cloned())
    }
    async fn save(&self, code: &str, bars: &[Bar], through: NaiveDate) -> anyhow::Result<u64> {
        self.cps.lock().unwrap().insert(code.to_string(), through);
        *self.saved.lock().unwrap().entry(code.to_string()).or_default() += bars.len();
        Ok(bars.len() as u64)
    }
    async fn enabled_codes(&self) -> anyhow::Result<Vec<String>> { Ok(self.codes.clone()) }
}

struct MockHist { results: Mutex<Vec<Result<Vec<Bar>, ProviderError>>>, calls: Mutex<usize> }
#[async_trait::async_trait]
impl HistoricalDataProvider for MockHist {
    fn id(&self) -> SourceId { SourceId::Tushare }
    async fn fetch_history(&self, _code: &Code, _period: Period,
                           _s: DateTime<Utc>, _e: DateTime<Utc>) -> Result<Vec<Bar>, ProviderError> {
        *self.calls.lock().unwrap() += 1;
        let mut g = self.results.lock().unwrap();
        if g.is_empty() { Err(ProviderError::Http("unexpected call".into())) } else { g.remove(0) }
    }
    fn supported_periods(&self) -> Vec<Period> { vec![Period::M1] }
}

fn mk_bar(code: &str) -> Bar {
    Bar {
        code: Code(code.into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 3, 7, 0, 0).unwrap(),
        open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
        source: SourceId::Tushare,
    }
}

fn setup_at(results: Vec<Result<Vec<Bar>, ProviderError>>, codes: Vec<&str>,
            cps: Vec<(&str, NaiveDate)>, now: DateTime<Utc>)
    -> (Arc<DailySync>, Arc<MockHist>, Arc<MemStore>, Arc<MemSink>) {
    let clock = Arc::new(FakeClock(Mutex::new(now)));
    let sink = Arc::new(MemSink::default());
    let store = Arc::new(MemStore {
        codes: codes.into_iter().map(String::from).collect(),
        cps: Mutex::new(cps.into_iter().map(|(c, d)| (c.to_string(), d)).collect()),
        ..Default::default()
    });
    let hist = Arc::new(MockHist { results: Mutex::new(results), calls: Mutex::new(0) });
    let sync = Arc::new(DailySync::with_backoff(hist.clone(), store.clone(), sink.clone(),
        clock, std::time::Duration::ZERO));
    (sync, hist, store, sink)
}

/// 默认收盘后口径：2026-09-03 15:31 CST（07:31 UTC）。
fn setup(results: Vec<Result<Vec<Bar>, ProviderError>>, codes: Vec<&str>, cps: Vec<(&str, NaiveDate)>)
    -> (Arc<DailySync>, Arc<MockHist>, Arc<MemStore>, Arc<MemSink>) {
    setup_at(results, codes, cps, Utc.with_ymd_and_hms(2026, 9, 3, 7, 31, 0).unwrap())
}

#[test]
fn next_run_three_triggers_same_day() {
    // 三时点调度（用户决策 2026-09-03，§6.2）：每日 CST 08:00 / 18:00 / 00:00（严格晚于 now）
    // 07:00 CST（前日 23:00 UTC）→ 当日 08:00 CST = 00:00 UTC
    let now = Utc.with_ymd_and_hms(2026, 9, 2, 23, 0, 0).unwrap();
    assert_eq!(next_run_after(now), Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap());
    // 10:00 CST（02:00 UTC）→ 当日 18:00 CST = 10:00 UTC
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 0).unwrap();
    assert_eq!(next_run_after(now), Utc.with_ymd_and_hms(2026, 9, 3, 10, 0, 0).unwrap());
    // 20:00 CST（12:00 UTC）→ 次日 00:00 CST = 当日 16:00 UTC
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 12, 0, 0).unwrap();
    assert_eq!(next_run_after(now), Utc.with_ymd_and_hms(2026, 9, 3, 16, 0, 0).unwrap());
    // 恰在触发点 08:00:00 CST（00:00 UTC）→ 严格晚于 → 当日 18:00
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap();
    assert_eq!(next_run_after(now), Utc.with_ymd_and_hms(2026, 9, 3, 10, 0, 0).unwrap());
}

#[test]
fn next_run_cross_midnight_and_weekend() {
    // 跨午夜：23:59 CST（15:59 UTC）→ 次日 00:00 CST（16:00 UTC）
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 15, 59, 0).unwrap();
    assert_eq!(next_run_after(now), Utc.with_ymd_and_hms(2026, 9, 3, 16, 0, 0).unwrap());
    // 跨周末不跳过触发：周五 20:00 CST（12:00 UTC）→ 周六 00:00 CST（周五 16:00 UTC）
    // （周末轮次目标交易日回退到周五，多次补全直至收敛）
    let fri = Utc.with_ymd_and_hms(2026, 9, 4, 12, 0, 0).unwrap();
    assert_eq!(next_run_after(fri), Utc.with_ymd_and_hms(2026, 9, 4, 16, 0, 0).unwrap());
}

#[test]
fn sync_target_is_latest_closed_weekday() {
    let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
    // 18:00 周四（10:00 UTC）→ 当日周四（已收盘）
    assert_eq!(sync_target_date(Utc.with_ymd_and_hms(2026, 9, 3, 10, 0, 0).unwrap()), d(2026, 9, 3));
    // 15:00 整收盘 → 当日
    assert_eq!(sync_target_date(Utc.with_ymd_and_hms(2026, 9, 3, 7, 0, 0).unwrap()), d(2026, 9, 3));
    // 盘中 10:00 周四 → 前一交易日周三（当日未收盘，不是目标）
    assert_eq!(sync_target_date(Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 0).unwrap()), d(2026, 9, 2));
    // 00:00 周六（周五 16:00 UTC）→ 周五（跨午夜仍补前一交易日）
    assert_eq!(sync_target_date(Utc.with_ymd_and_hms(2026, 9, 4, 16, 0, 0).unwrap()), d(2026, 9, 4));
    // 08:00 周一（周一 00:00 UTC）→ 前一交易日周五（跨周末口径）
    assert_eq!(sync_target_date(Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap()), d(2026, 9, 4));
    // 18:00 周六（周六 10:00 UTC）→ 周五（周末触发回退最近已收盘工作日）
    assert_eq!(sync_target_date(Utc.with_ymd_and_hms(2026, 9, 5, 10, 0, 0).unwrap()), d(2026, 9, 4));
}

#[test]
fn backoff_doubles_and_caps() {
    let base = std::time::Duration::from_secs(60);
    assert_eq!(retry_backoff(base, 0), std::time::Duration::from_secs(60));
    assert_eq!(retry_backoff(base, 1), std::time::Duration::from_secs(120));
    assert_eq!(retry_backoff(base, 2), std::time::Duration::from_secs(240));
    assert_eq!(retry_backoff(base, 9), std::time::Duration::from_secs(600), "封顶 10min");
}

#[tokio::test]
async fn incremental_from_checkpoint_and_events() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, hist, store, sink) = setup(
        vec![Ok(vec![mk_bar("518880")]), Ok(vec![mk_bar("159776")])],
        vec!["518880", "159776"], vec![("518880", cp), ("159776", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 2, bars: 2 });
    assert_eq!(store.saved.lock().unwrap()["518880"], 1);
    // checkpoint 推进到今日（2026-09-03）
    assert_eq!(store.cps.lock().unwrap()["518880"], NaiveDate::from_ymd_opt(2026, 9, 3).unwrap());
    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e.ok && e.source == SourceId::Tushare));
    assert_eq!(*hist.calls.lock().unwrap(), 2, "每 code 一次增量拉取");
}

#[tokio::test]
async fn retry_then_success_emits_failure_events() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, hist, store, sink) = setup(
        vec![Err(ProviderError::Timeout), Err(ProviderError::Http("x".into())), Ok(vec![mk_bar("518880")])],
        vec!["518880"], vec![("518880", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 1, bars: 1 });
    assert_eq!(*hist.calls.lock().unwrap(), 3, "失败重试至成功");
    let kinds: Vec<_> = sink.events.lock().unwrap().iter()
        .map(|e| (e.ok, e.err_kind.map(|k| k.as_str()))).collect();
    assert_eq!(kinds, vec![(false, Some("timeout")), (false, Some("http")), (true, None)]);
    assert_eq!(store.saved.lock().unwrap()["518880"], 1);
}

#[tokio::test]
async fn retries_exhausted_skips_code_continues_others() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, _hist, store, sink) = setup(
        vec![Err(ProviderError::Http("a".into())), Err(ProviderError::Http("b".into())),
             Err(ProviderError::Http("c".into())), Ok(vec![mk_bar("159776")])],
        vec!["518880", "159776"], vec![("518880", cp), ("159776", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Failed, "518880 三次重试耗尽");
    assert_eq!(store.saved.lock().unwrap().get("518880"), None, "失败 code 不落库");
    assert_eq!(store.saved.lock().unwrap()["159776"], 1, "后续 code 继续");
    assert_eq!(sink.events.lock().unwrap().len(), 3 + 1);
}

#[tokio::test]
async fn rate_limited_aborts_whole_round() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, hist, _store, sink) = setup(
        vec![Err(ProviderError::RateLimited)],
        vec!["518880", "159776"], vec![("518880", cp), ("159776", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Failed);
    assert_eq!(*hist.calls.lock().unwrap(), 1, "quota 感知：整轮中止不重试不轰击");
    assert!(sink.events.lock().unwrap().iter()
        .any(|e| e.err_kind.map(|k| k.as_str()) == Some("rate_limited")));
}

#[tokio::test]
async fn checkpoint_today_still_fetches_today_after_close() {
    // 缺陷 2 复现（tester 004 §8）：checkpoint 被盘中手动全量同步预置为今日，
    // 收盘后 15:30 日增量触发 → 仍必须拉取当日（新口径：当日强制同步，upsert 幂等去重）。
    let today = NaiveDate::from_ymd_opt(2026, 9, 3).unwrap();
    let (sync, hist, store, sink) = setup(
        vec![Ok(vec![mk_bar("518880")])], vec!["518880"], vec![("518880", today)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 1, bars: 1 });
    assert_eq!(*hist.calls.lock().unwrap(), 1, "checkpoint==今日不跳过：收盘后仍拉取当日");
    assert_eq!(store.cps.lock().unwrap()["518880"], today, "收盘后 checkpoint 推进到今日");
    assert!(sink.events.lock().unwrap().iter().any(|e| e.ok), "成功事件落库");
}

#[tokio::test]
async fn intraday_run_does_not_advance_checkpoint_to_today() {
    // 缺陷 2 修复口径 a：盘中（15:00 CST 前）同步不得将当日标记为完成。
    let yesterday = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let intraday = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 0).unwrap(); // 10:00 CST 盘中
    let (sync, hist, store, _sink) = setup_at(
        vec![Ok(vec![mk_bar("518880")])], vec!["518880"], vec![("518880", yesterday)], intraday);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 1, bars: 1 });
    assert_eq!(*hist.calls.lock().unwrap(), 1, "盘中触发仍拉取（目标=前一交易日 09-02）");
    assert_eq!(store.cps.lock().unwrap()["518880"], yesterday,
        "盘中 checkpoint 封顶前一自然日，不得标记当日完成");
}

#[tokio::test]
async fn zero_call_round_emits_audit_event() {
    // 缺陷 2 修复口径 b：整轮零调用（无启用标的）不得静默 —— 落 ok=true + err_kind=na 审计事件。
    let (sync, hist, _store, sink) = setup(vec![], vec![], vec![]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 0, bars: 0 });
    assert_eq!(*hist.calls.lock().unwrap(), 0);
    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 1, "零调用轮必须落一条审计事件（禁止静默跳过）");
    let e = &events[0];
    assert!(e.ok && e.source == SourceId::Tushare);
    assert_eq!(e.err_kind.map(|k| k.as_str()), Some("na"));
    assert!(e.trace_id.as_deref().unwrap_or("").starts_with("skip:"),
        "审计事件附跳过原因: {:?}", e.trace_id);
}
```
