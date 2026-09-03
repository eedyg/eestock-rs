# 03 — Provider 逐源适配规格

> 每源一节：端点/解析/单位/错误分类/限频。解析测试由 golden 样本驱动（旧仓 028 冒烟 CSV + 响应样例 → crates/providers/testdata/）。
> ⚠️ 端点事实以 028 报告为准（web.ifzq 已 301 失效、新浪旧端点退化——下列为修正后版本）。

## 1. 腾讯 ifzq（TencentIfzq）— 1m 主力

- 端点：`GET https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={prefixed_code},m1,,320`
  （备：`web.ifzq.gtimg.cn` 同路径，自动跟 301；**勿用 web3**）
- 响应：`data.<code>.m1 = [[YYYYMMDDHHMM, 开, 收, 高, 低, 量(手), {}, 额(万元)], ...]`
- ⚠️ 字段序陷阱：**2 号位是"收"不是"高"**（028 §2.1 golden 锁定）
- 单位：量(手)→股 ×100；额(万元)→元 ×10000；时间按 Asia/Shanghai 解析转 UTC
- 编码：JSON/UTF-8（无 GBK 问题）
- 限频：1 req/s + 0~200ms 抖动

## 2. 新浪 jsonp（SinaJsonp）— 1m 备源/交叉基准

- 端点：`GET https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_k=/CN_MarketDataService.getKLineData?symbol={prefixed_code}&scale=1&ma=no&datalen=240`
- 响应处理：剥 `/*<script>location.href=...*/` 防盗链前缀 + `var _k=(...);` jsonp 包裹 → JSON 数组 `[{day,open,high,low,close,volume,amount}]`
- ⚠️ **旧端点 `money.finance.sina.com.cn CN_MarketData.getKLineData scale=1` 已退化（恒定 null），禁用**（028 §3）
- 单位：volume 股（新浪此处为股，非手——golden 样本验证锁定）；时间为 `YYYY-MM-DD HH:MM:SS` 北京时
- 限频：1 req/s + 抖动；无需 Referer（jsonp 域与 hq 域不同）

## 3. 快照池（健康心跳用，字段最小化：last/prev_close/vol/amount/data_ts/name）

| 源 | 端点 | 要点 |
|---|---|---|
| TencentQt | `https://qt.gtimg.cn/q={pfx}{code},...` | **GBK** 解码；`~` 分隔 88 字段；手→股、万元→元；最抗封（024） |
| SinaHq | `https://hq.sinajs.cn/list={pfx}{code}` | **必带 Referer: https://finance.sina.com.cn/**（否则 403）；GBK；`,` 分隔；涨跌幅需自算 |
| ThsCs | `https://d.10jqka.com.cn/v6/realhead/hs_{code}/last.js` | 仅单只；jsonp 包裹 |
| Push2delay | `https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=...&fields=f2,f3,f5,f6,f12,f14,f18` | **fltt=2 时字段为格式化字符串，必须强转 float**（028 修复前科）；东财系最低频 15min |
| Exchange | 沪 `https://yunhq.sse.com.cn:32041/v1/sh1/snap/{code}` + 深 `http://www.szse.cn/api/market/ssjjhq/getTimeData?marketId=1&code={code}` | 官方源；字段结构两所不同，各自适配。⚠️ 勘误（2026-09-03 父级裁决）：深交所端点原为 `api/report/ShowReport?CATALOGID=1110`，无实盘样本支撑，修正为 getTimeData——证据：028 verify_quotes_highintensity.py fetch_exchange + 冒烟 CSV 实盘锁定（data.now/close/deltaPercent/marketTime） |

## 4. 错误分类统一口径（→ domain::ProviderError）

| 情形 | ProviderError | 熔断影响 |
|---|---|---|
| HTTP 403/429 | `RateLimited` | 不计熔断，进退避档 |
| 连接超时/读超时 | `Timeout` | 计熔断失败 |
| 连接重置/断连（push2his 式风控） | `Http` | 计熔断失败 |
| 5xx/网络错误 | `Http` | 计熔断失败 |
| 响应结构不符/字段缺失 | `Parse` | 计熔断失败 |
| 业务无数据（非交易时段空返回/新上市） | `NoData` | 不计失败，记 NA |

## 5. 通用要求

- 每适配器内嵌 token bucket（速率见各节）+ 超时（默认 8s，东财系 5s）
- User-Agent 统一标识 + 每源独立 headers 配置（如 SinaHq 的 Referer）
- 解析函数为**纯函数**（`parse(&str) -> Result<Vec<Bar>>`），golden 样本单测直接驱动，不触网
- HTTP 层与解析层分离：HTTP 层以 `HttpClient` trait 抽象可 mock（集成测试无需触网，等价于本地 mock server 的隔离性）

## 6. 实现（providers crate）

golden 样本（`crates/providers/testdata/`）出处：
`tencent_qt_snapshot.txt`/`sina_hq_snapshot.txt` 为旧仓真实响应原文复制（GBK，golang/pkg/realtime/quotes/testdata/）；
`tencent_ifzq_m1.json`/`sina_jsonp_m1.txt` 取自 028 报告 §2.1/§3 锁定的真实样本；
`ths_cs_last.js`/`push2delay_ulist.json`/`exchange_*.json` 按 verify 脚本解析器锁定的真实报文结构重建（数值取 028 冒烟 CSV，文件头均注明出处）；
`smoke/*.csv` 为 028 冒烟汇总（字段级交叉断言辅助材料）。

``` {.rust file=crates/providers/src/lib.rs}
//! providers —— 基础设施：各数据源 HTTP 适配器（domain::provider trait 实现）。
//! 由 design/03-collector/01-providers-spec.md tangle 生成（ADR-007），禁止手改。

pub mod exchange;
pub mod http;
pub mod push2delay;
pub mod sina_hq;
pub mod sina_jsonp;
pub mod tencent_ifzq;
pub mod tencent_qt;
pub mod ths_cs;
```

### 6.1 HTTP 层（与解析层分离，可 mock）

``` {.rust file=crates/providers/src/http.rs}
//! HTTP 客户端抽象 + reqwest 实现 + 限频门（token bucket 简化：最小间隔 + 随机抖动）。

use async_trait::async_trait;
use domain::provider::ProviderError;
use tokio::sync::Mutex;
use tokio::time::Instant;

/// 统一 UA（01 §5）。
pub const USER_AGENT: &str = "eestock-rs/0.1 (self-hosted market data)";
/// 默认超时 8s；东财系 5s（028 父级裁决）。
pub const DEFAULT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
pub const EASTMONEY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// HTTP 层抽象：解析纯函数吃 body，本 trait 可 mock（测试不触网）。
#[async_trait]
pub trait HttpClient: Send + Sync {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, ProviderError>;
}

pub struct ReqwestHttp {
    client: reqwest::Client,
}

impl ReqwestHttp {
    pub fn new(timeout: std::time::Duration) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent(USER_AGENT)
            .build().expect("reqwest client build");
        Self { client }
    }
}

#[async_trait]
impl HttpClient for ReqwestHttp {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, ProviderError> {
        let mut req = self.client.get(url);
        for (k, v) in headers { req = req.header(*k, *v); }
        let resp = req.send().await.map_err(map_reqwest_err)?;
        let status = resp.status().as_u16();
        // 01 §4：403/429 → RateLimited（不计熔断）；5xx/其他非 200 → Http（计熔断失败）
        if status == 403 || status == 429 { return Err(ProviderError::RateLimited); }
        if status != 200 { return Err(ProviderError::Http(format!("http status {status}"))); }
        let body = resp.bytes().await.map_err(map_reqwest_err)?.to_vec();
        Ok(HttpResponse { status, body })
    }
}

fn map_reqwest_err(e: reqwest::Error) -> ProviderError {
    if e.is_timeout() { ProviderError::Timeout } else { ProviderError::Http(e.to_string()) }
}

/// 最小间隔门 + 随机抖动（每适配器内嵌；01 §5 token bucket 口径的 KISS 实现）。
pub struct IntervalGate {
    interval: std::time::Duration,
    jitter_ms: u64,
    gate: Mutex<Instant>,
}

impl IntervalGate {
    pub fn new(interval: std::time::Duration, jitter_ms: u64) -> Self {
        let init = Instant::now().checked_sub(interval).unwrap_or_else(Instant::now);
        Self { interval, jitter_ms, gate: Mutex::new(init) }
    }
    /// 保证两次放行间隔 >= interval；放行后再加 0..=jitter_ms 随机抖动。
    pub async fn wait(&self) {
        use rand::Rng;
        {
            let mut g = self.gate.lock().await;
            let next = *g + self.interval;
            if next > Instant::now() { tokio::time::sleep_until(next).await; }
            *g = Instant::now();
        }
        if self.jitter_ms > 0 {
            let j = rand::thread_rng().gen_range(0..=self.jitter_ms);
            if j > 0 { tokio::time::sleep(std::time::Duration::from_millis(j)).await; }
        }
    }
}
```

### 6.2 Tier1：腾讯 ifzq（1m 主力）

``` {.rust file=crates/providers/src/tencent_ifzq.rs}
//! 腾讯 ifzq —— 1m 主力（§1）。主域 ifzq.gtimg.cn，备域 web.ifzq.gtimg.cn（reqwest 自动跟 301）。

use crate::http::{HttpClient, IntervalGate};
use chrono::NaiveDateTime;
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://ifzq.gtimg.cn/appstock/app/kline/mkline";
pub const ENDPOINT_FALLBACK: &str = "https://web.ifzq.gtimg.cn/appstock/app/kline/mkline";
/// 免费源物理上限≈2 天（ADR-004），单请求 bar 上限 320。
pub const MAX_LIMIT: usize = 320;

pub struct TencentIfzq {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl TencentIfzq {
    /// 限频：1 req/s + 0~200ms 抖动（§1）。
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url_for(endpoint: &str, code: &Code, limit: usize) -> Result<String, ProviderError> {
        let p = code.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(format!("{endpoint}?param={p},m1,,{}", limit.min(MAX_LIMIT)))
    }
}

/// 解析（纯函数，golden 锁定）：`data.<code>.m1 = [[YYYYMMDDHHMM, 开, 收, 高, 低, 量(手), {}, 额(万元)]]`
/// ⚠️ 2 号位是“收”不是“高”（028 §2.1）；量×100→股；额×10000→元；时间 Asia/Shanghai → UTC。
pub fn parse_m1(body: &[u8], code: &Code) -> Result<Vec<Bar>, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("ifzq json: {e}")))?;
    if v.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ProviderError::Http(format!("ifzq biz code: {}", v.get("code").cloned().unwrap_or_default())));
    }
    let prefixed = code.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?;
    let rows = match v.get("data").and_then(|d| d.get(&prefixed)).and_then(|d| d.get("m1")).and_then(|r| r.as_array()) {
        Some(r) if !r.is_empty() => r,
        _ => return Err(ProviderError::NoData), // 非交易时段空 m1 / 新上市 → NA（01 §4）
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let col = |i: usize| -> Result<&str, ProviderError> {
            row.get(i).and_then(|x| x.as_str())
                .ok_or_else(|| ProviderError::Parse(format!("m1 col {i} missing: {row}")))
        };
        let num = |i: usize| -> Result<f64, ProviderError> {
            col(i)?.parse::<f64>().map_err(|e| ProviderError::Parse(format!("m1 col {i} f64: {e}")))
        };
        let naive = NaiveDateTime::parse_from_str(col(0)?, "%Y%m%d%H%M")
            .map_err(|e| ProviderError::Parse(format!("m1 ts: {e}")))?;
        out.push(Bar {
            code: code.clone(),
            period: Period::M1,
            ts: cst_to_utc(naive),
            open: num(1)?,
            close: num(2)?,  // ⚠️ 2 号位是收
            high: num(3)?,
            low: num(4)?,
            volume: (num(5)? * 100.0) as u64,  // 手→股
            amount: num(7)? * 10000.0,          // 万元→元
            source: SourceId::TencentIfzq,
        });
    }
    out.sort_by_key(|b| b.ts);
    Ok(out)
}

#[async_trait::async_trait]
impl MinuteKlineProvider for TencentIfzq {
    fn id(&self) -> SourceId { SourceId::TencentIfzq }

    async fn fetch_m1(&self, code: &Code, limit: usize) -> Result<Vec<Bar>, ProviderError> {
        self.gate.wait().await;
        let url = Self::url_for(ENDPOINT, code, limit)?;
        let resp = match self.http.get(&url, &[]).await {
            Ok(r) => r,
            Err(first_err) => {
                // 备域兜底一次（028：web.ifzq 301→web3，reqwest 自动跟 301）
                let fb = Self::url_for(ENDPOINT_FALLBACK, code, limit)?;
                self.http.get(&fb, &[]).await.map_err(|_| first_err)?
            }
        };
        let mut bars = parse_m1(&resp.body, code)?;
        if bars.len() > limit { bars = bars.split_off(bars.len() - limit); }
        Ok(bars)
    }
}
```

### 6.3 Tier1：新浪 jsonp（1m 备源）

``` {.rust file=crates/providers/src/sina_jsonp.rs}
//! 新浪 jsonp —— 1m 备源/交叉基准（§2）。剥防盗链前缀 + jsonp 包裹后按 JSON 数组解析。

use crate::http::{HttpClient, IntervalGate};
use chrono::NaiveDateTime;
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_k=/CN_MarketDataService.getKLineData";

pub struct SinaJsonp {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl SinaJsonp {
    /// 限频：1 req/s + 0~200ms 抖动；无需 Referer（§2）。
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(code: &Code, limit: usize) -> Result<String, ProviderError> {
        let p = code.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(format!("{ENDPOINT}?symbol={p}&scale=1&ma=no&datalen={}", limit.min(1023)))
    }
}

/// 解析（纯函数，golden 锁定）：剥 `/*<script>...*/` 前缀与 `var _k=(...);` 包裹；
/// 数组元素 `{day,open,high,low,close,volume,amount}` 全字符串；
/// volume 单位为**股**（028 golden 验证锁定，非手）；day 为 `YYYY-MM-DD HH:MM:SS` 北京时。
/// 旧端点退化形态恒定 `null`（028 §3）与空数组 → NoData。
pub fn parse_m1(body: &str, code: &Code) -> Result<Vec<Bar>, ProviderError> {
    let (start, end) = match (body.find('['), body.rfind(']')) {
        (Some(s), Some(e)) if s < e => (s, e),
        _ => return Err(ProviderError::NoData), // null / 无数组 → NA
    };
    let arr: Vec<serde_json::Value> = serde_json::from_str(&body[start..=end])
        .map_err(|e| ProviderError::Parse(format!("sina jsonp array: {e}")))?;
    if arr.is_empty() { return Err(ProviderError::NoData); }
    let mut out = Vec::with_capacity(arr.len());
    for it in &arr {
        let s = |k: &str| -> Result<&str, ProviderError> {
            it.get(k).and_then(|x| x.as_str())
                .ok_or_else(|| ProviderError::Parse(format!("sina field {k} missing: {it}")))
        };
        let num = |k: &str| -> Result<f64, ProviderError> {
            s(k)?.parse::<f64>().map_err(|e| ProviderError::Parse(format!("sina {k} f64: {e}")))
        };
        let naive = NaiveDateTime::parse_from_str(s("day")?, "%Y-%m-%d %H:%M:%S")
            .map_err(|e| ProviderError::Parse(format!("sina day: {e}")))?;
        out.push(Bar {
            code: code.clone(),
            period: Period::M1,
            ts: cst_to_utc(naive),
            open: num("open")?,
            high: num("high")?,
            low: num("low")?,
            close: num("close")?,
            volume: num("volume")? as u64,  // 股（无换算，golden 锁定）
            amount: num("amount")?,          // 元
            source: SourceId::SinaJsonp,
        });
    }
    out.sort_by_key(|b| b.ts);
    Ok(out)
}

#[async_trait::async_trait]
impl MinuteKlineProvider for SinaJsonp {
    fn id(&self) -> SourceId { SourceId::SinaJsonp }

    async fn fetch_m1(&self, code: &Code, limit: usize) -> Result<Vec<Bar>, ProviderError> {
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(code, limit)?, &[]).await?;
        let text = String::from_utf8(resp.body)
            .map_err(|e| ProviderError::Parse(format!("sina utf8: {e}")))?;
        let mut bars = parse_m1(&text, code)?;
        if bars.len() > limit { bars = bars.split_off(bars.len() - limit); }
        Ok(bars)
    }
}
```

### 6.4 Tier2 快照池（降级模式用；最小字段 last/prev_close/vol/amount/data_ts）

``` {.rust file=crates/providers/src/tencent_qt.rs}
//! 腾讯 qt —— 快照池，最抗封（024）。GBK 解码；`~` 分隔 88 字段；手→股、万元→元。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, NaiveDateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://qt.gtimg.cn/q=";

pub struct TencentQt {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl TencentQt {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(codes: &[Code]) -> Result<String, ProviderError> {
        let mut parts = Vec::with_capacity(codes.len());
        for c in codes {
            parts.push(c.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?);
        }
        Ok(format!("{ENDPOINT}{}", parts.join(",")))
    }
}

/// 解析（纯函数，golden 锁定）：行形如 `v_sh518880="1~名称~代码~last~prev~...~ts~...~vol~amt~..."`；
/// [1]name [2]code [3]last [4]prev [30]ts(YYYYMMDDHHMMSS) [36]vol(手) [37]amt(万元)。
/// 畸形行跳过（容错，对齐 verify 脚本 per-code parse_err 口径）；全部无有效行 → NoData。
pub fn parse_quotes(body: &[u8], now: DateTime<Utc>) -> Result<Vec<Quote>, ProviderError> {
    let (text, _, _) = encoding_rs::GBK.decode(body);
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.contains('=') || line.contains("none_match") { continue; }
        let val = line.split_once('=').map(|(_, v)| v).unwrap_or("")
            .trim().trim_end_matches(';').trim_matches('"');
        if val.is_empty() { continue; }
        let f: Vec<&str> = val.split('~').collect();        if f.len() < 38 { continue; }
        let Ok(last) = f[3].parse::<f64>() else { continue };
        let Ok(prev) = f[4].parse::<f64>() else { continue };
        let vol = f[36].parse::<f64>().unwrap_or(0.0);
        let amt = f[37].parse::<f64>().unwrap_or(0.0);
        let ts = NaiveDateTime::parse_from_str(f[30], "%Y%m%d%H%M%S")
            .map(cst_to_utc).unwrap_or(now);
        out.push(Quote {
            code: Code(f[2].to_string()),
            last, prev_close: prev,
            volume: (vol * 100.0) as u64,  // 手→股
            amount: amt * 10000.0,          // 万元→元
            data_ts: ts,
            source: SourceId::TencentQt,
        });
    }
    if out.is_empty() { Err(ProviderError::NoData) } else { Ok(out) }
}

#[async_trait::async_trait]
impl SnapshotProvider for TencentQt {
    fn id(&self) -> SourceId { SourceId::TencentQt }

    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        if codes.is_empty() { return Ok(vec![]); }
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(codes)?, &[]).await?;
        parse_quotes(&resp.body, Utc::now())
    }
}
```

``` {.rust file=crates/providers/src/sina_hq.rs}
//! 新浪 hq —— 快照池。**必带 Referer: https://finance.sina.com.cn/**（否则 403）；GBK；`,` 分隔。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, NaiveDateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://hq.sinajs.cn/list=";
pub const REFERER: &str = "https://finance.sina.com.cn/";

pub struct SinaHq {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl SinaHq {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(codes: &[Code]) -> Result<String, ProviderError> {
        let mut parts = Vec::with_capacity(codes.len());
        for c in codes {
            parts.push(c.prefixed().map_err(|e| ProviderError::Parse(e.to_string()))?);
        }
        Ok(format!("{ENDPOINT}{}", parts.join(",")))
    }
}

/// 解析（纯函数，golden 锁定）：行形如 `var hq_str_sh518880="名称,今开,昨收,last,...,vol,amount,...,日期,时间,..."`；
/// [0]name [2]prev [3]last [8]vol(股) [9]amount(元) [30]date [31]time；代码取变量名末 6 位数字。
pub fn parse_quotes(body: &[u8], now: DateTime<Utc>) -> Result<Vec<Quote>, ProviderError> {
    let (text, _, _) = encoding_rs::GBK.decode(body);
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.contains("hq_str_") || !line.contains('=') { continue; }
        let var = line.split_once('=').map(|(v, _)| v).unwrap_or("").trim();
        let code = var.chars().rev().take(6).collect::<String>().chars().rev().collect::<String>();
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) { continue; }
        let val = line.split_once('=').map(|(_, v)| v).unwrap_or("")
            .trim().trim_end_matches(';').trim_matches('"');
        if val.is_empty() { continue; }
        let f: Vec<&str> = val.split(',').collect();
        if f.len() < 32 { continue; }
        let Ok(last) = f[3].parse::<f64>() else { continue };
        let Ok(prev) = f[2].parse::<f64>() else { continue };
        let vol = f[8].parse::<f64>().unwrap_or(0.0);   // 股
        let amt = f[9].parse::<f64>().unwrap_or(0.0);   // 元
        let ts = NaiveDateTime::parse_from_str(&format!("{} {}", f[30], f[31]), "%Y-%m-%d %H:%M:%S")
            .map(cst_to_utc).unwrap_or(now);
        out.push(Quote {
            code: Code(code), last, prev_close: prev,
            volume: vol as u64, amount: amt,
            data_ts: ts, source: SourceId::SinaHq,
        });
    }
    if out.is_empty() { Err(ProviderError::NoData) } else { Ok(out) }
}

#[async_trait::async_trait]
impl SnapshotProvider for SinaHq {
    fn id(&self) -> SourceId { SourceId::SinaHq }

    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        if codes.is_empty() { return Ok(vec![]); }
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(codes)?, &[("Referer", REFERER)]).await?;
        parse_quotes(&resp.body, Utc::now())
    }
}
```

``` {.rust file=crates/providers/src/ths_cs.rs}
//! 同花顺 —— 快照池（仅单只）。jsonp 包裹 realhead；`"10"`=最新价、`"24"`=昨收（verify 脚本正则口径）。
//! 不引入 regex 依赖：用子串定位实现同等语义。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://d.10jqka.com.cn/v6/realhead";

pub struct ThsCs {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl ThsCs {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(code: &Code) -> String {
        format!("{ENDPOINT}/hs_{}/last.js", code.0)
    }
}

/// 在 body 中抓 `"key":"num"` 形态的数值字段（对齐 verify 正则 `"10":"([\\d.]+)"`）。
fn grab(body: &str, key: &str) -> Option<f64> {
    let pat = format!("\"{key}\":\"");
    let i = body.find(&pat)? + pat.len();
    let j = body[i..].find('"')? + i;
    body[i..j].parse().ok()
}

/// 解析（纯函数，golden 锁定）：vol/amount/ts 端点不提供 → 0 / 拉取时刻。
pub fn parse_last(body: &str, code: &Code, now: DateTime<Utc>) -> Result<Quote, ProviderError> {
    let last = grab(body, "10")
        .ok_or_else(|| ProviderError::Parse("ths_cs: missing \"10\" last price".into()))?;
    let prev = grab(body, "24").unwrap_or(0.0);
    Ok(Quote {
        code: code.clone(), last, prev_close: prev,
        volume: 0, amount: 0.0, data_ts: now, source: SourceId::ThsCs,
    })
}

#[async_trait::async_trait]
impl SnapshotProvider for ThsCs {
    fn id(&self) -> SourceId { SourceId::ThsCs }

    /// 仅单只端点：逐码请求；部分成功返回部分（降级模式容错），全败 → Err。
    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        let mut out = Vec::new();
        let mut last_err = ProviderError::NoData;
        for c in codes {
            self.gate.wait().await;
            match self.http.get(&Self::url(c), &[]).await {
                Ok(resp) => match String::from_utf8(resp.body) {
                    Ok(text) => match parse_last(&text, c, Utc::now()) {
                        Ok(q) => out.push(q),
                        Err(e) => last_err = e,
                    },
                    Err(e) => last_err = ProviderError::Parse(format!("ths_cs utf8: {e}")),
                },
                Err(e) => last_err = e,
            }
        }
        if out.is_empty() && !codes.is_empty() { Err(last_err) } else { Ok(out) }
    }
}
```

``` {.rust file=crates/providers/src/push2delay.rs}
//! 东财 push2delay —— 快照池，东财系最低频（ADR-006）。超时 5s（028 父级裁决）。
//! ⚠️ fltt=2 时字段为格式化字符串，必须强转 float（028 修复前科）；`-` 为停牌/无值形态。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use std::sync::Arc;

pub const ENDPOINT: &str = "https://push2delay.eastmoney.com/api/qt/ulist.np/get";
pub const REFERER: &str = "https://quote.eastmoney.com/";

pub struct Push2delay {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl Push2delay {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    /// secid：沪 1.<code>，深 0.<code>。
    pub fn secid(code: &Code) -> Result<String, ProviderError> {
        match code.market().map_err(|e| ProviderError::Parse(e.to_string()))? {
            Market::Sh => Ok(format!("1.{}", code.0)),
            Market::Sz => Ok(format!("0.{}", code.0)),
        }
    }

    fn url(codes: &[Code]) -> Result<String, ProviderError> {
        let mut ids = Vec::with_capacity(codes.len());
        for c in codes { ids.push(Self::secid(c)?); }
        Ok(format!("{ENDPOINT}?secids={}&fields=f2,f3,f5,f6,f12,f14,f18&fltt=2&invt=2", ids.join(",")))
    }
}

/// fltt=2 强转：数值/字符串通吃；`-` 等无值 → None。
fn num(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

/// 解析（纯函数，golden 锁定）：`data.diff[]`；f2=last f18=昨收 f5=vol(手) f6=amount(元) f12=code f14=name。
pub fn parse_quotes(body: &[u8], now: DateTime<Utc>) -> Result<Vec<Quote>, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("push2delay json: {e}")))?;
    let diff = v.get("data").and_then(|d| d.get("diff")).and_then(|d| d.as_array())
        .ok_or_else(|| ProviderError::Parse("push2delay: missing data.diff".into()))?;
    let mut out = Vec::new();
    for it in diff {
        let Some(code) = it.get("f12").and_then(|x| x.as_str()) else { continue };
        let (Some(last), Some(prev)) = (num(it.get("f2").unwrap_or(&serde_json::Value::Null)),
                                        num(it.get("f18").unwrap_or(&serde_json::Value::Null)))
        else { continue }; // "-" 停牌/无值 → 跳过（非错误）
        let vol = num(it.get("f5").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        let amt = num(it.get("f6").unwrap_or(&serde_json::Value::Null)).unwrap_or(0.0);
        out.push(Quote {
            code: Code(code.to_string()), last, prev_close: prev,
            volume: (vol * 100.0) as u64,  // 手→股
            amount: amt,                    // 元
            data_ts: now, source: SourceId::Push2delay,
        });
    }
    if out.is_empty() { Err(ProviderError::NoData) } else { Ok(out) }
}

#[async_trait::async_trait]
impl SnapshotProvider for Push2delay {
    fn id(&self) -> SourceId { SourceId::Push2delay }

    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        if codes.is_empty() { return Ok(vec![]); }
        self.gate.wait().await;
        let resp = self.http.get(&Self::url(codes)?, &[("Referer", REFERER)]).await?;
        parse_quotes(&resp.body, Utc::now())
    }
}
```

``` {.rust file=crates/providers/src/exchange.rs}
//! 交易所官方快照 —— 沪深双端点，结构各自适配（§3，2026-09-03 端点勘误见该节）。

use crate::http::{HttpClient, IntervalGate};
use chrono::{DateTime, NaiveDateTime, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::sync::Arc;

pub const SSE_ENDPOINT: &str = "http://yunhq.sse.com.cn:32041/v1/sh1/snap";
pub const SZSE_ENDPOINT: &str = "http://www.szse.cn/api/market/ssjjhq/getTimeData";
pub const SZSE_REFERER: &str = "http://www.szse.cn/";

pub struct Exchange {
    http: Arc<dyn HttpClient>,
    gate: IntervalGate,
}

impl Exchange {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self { http, gate: IntervalGate::new(std::time::Duration::from_secs(1), 200) }
    }

    fn url(code: &Code) -> Result<(String, bool), ProviderError> {
        match code.market().map_err(|e| ProviderError::Parse(e.to_string()))? {
            Market::Sh => Ok((format!("{SSE_ENDPOINT}/{}", code.0), true)),
            Market::Sz => Ok((format!("{SZSE_ENDPOINT}?marketId=1&code={}", code.0), false)),
        }
    }
}

/// 沪市 yunhq snap（纯函数）：`snap=[code,name,last,prev_close,...]`；ts=date(YYYYMMDD)+time(HHMMSS) 拼接。
pub fn parse_sse_snap(body: &[u8], code: &Code, now: DateTime<Utc>) -> Result<Quote, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("sse snap json: {e}")))?;
    let snap = v.get("snap").and_then(|s| s.as_array())
        .ok_or_else(|| ProviderError::Parse("sse: missing snap".into()))?;
    let fnum = |i: usize| -> Result<f64, ProviderError> {
        snap.get(i).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
            .ok_or_else(|| ProviderError::Parse(format!("sse snap[{i}] num")))
    };
    let date = v.get("date").and_then(|d| d.as_i64()).unwrap_or(0);
    let time = v.get("time").and_then(|t| t.as_i64()).unwrap_or(0);
    let ts = NaiveDateTime::parse_from_str(&format!("{date}{time:06}"), "%Y%m%d%H%M%S")
        .map(cst_to_utc).unwrap_or(now);
    Ok(Quote {
        code: code.clone(),
        last: fnum(2)?,
        prev_close: fnum(3).unwrap_or(0.0),
        volume: 0, amount: 0.0,
        data_ts: ts, source: SourceId::Exchange,
    })
}

/// 深市 getTimeData（纯函数）：`data.now/close` 字符串字段；`data.marketTime` 为 ts。
pub fn parse_szse_timedata(body: &[u8], code: &Code, now: DateTime<Utc>) -> Result<Quote, ProviderError> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| ProviderError::Parse(format!("szse json: {e}")))?;
    let d = v.get("data").ok_or_else(|| ProviderError::Parse("szse: missing data".into()))?;
    let s = |k: &str| -> Result<&str, ProviderError> {
        d.get(k).and_then(|x| x.as_str())
            .ok_or_else(|| ProviderError::Parse(format!("szse data.{k} missing")))
    };
    let last: f64 = s("now")?.parse()
        .map_err(|e| ProviderError::Parse(format!("szse now f64: {e}")))?;
    let prev: f64 = s("close").unwrap_or("0").parse().unwrap_or(0.0);
    let ts = NaiveDateTime::parse_from_str(s("marketTime")?, "%Y-%m-%d %H:%M:%S")
        .map(cst_to_utc).unwrap_or(now);
    Ok(Quote {
        code: code.clone(), last, prev_close: prev,
        volume: 0, amount: 0.0,
        data_ts: ts, source: SourceId::Exchange,
    })
}

#[async_trait::async_trait]
impl SnapshotProvider for Exchange {
    fn id(&self) -> SourceId { SourceId::Exchange }

    /// 逐码请求（两市端点不同）；部分成功返回部分，全败 → Err。
    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        let mut out = Vec::new();
        let mut last_err = ProviderError::NoData;
        for c in codes {
            let (url, is_sh) = Self::url(c)?;
            self.gate.wait().await;
            let headers: &[(&str, &str)] = if is_sh { &[] } else { &[("Referer", SZSE_REFERER)] };
            match self.http.get(&url, headers).await {
                Ok(resp) => {
                    let r = if is_sh { parse_sse_snap(&resp.body, c, Utc::now()) }
                            else { parse_szse_timedata(&resp.body, c, Utc::now()) };
                    match r { Ok(q) => out.push(q), Err(e) => last_err = e }
                }
                Err(e) => last_err = e,
            }
        }
        if out.is_empty() && !codes.is_empty() { Err(last_err) } else { Ok(out) }
    }
}
```

### 6.5 golden 驱动测试（不触网）

``` {.rust file=crates/providers/tests/golden_parse.rs}
//! golden 样本解析测试——由 design/03-collector/01-providers-spec.md §6.5 tangle 生成，禁止手改。
//! 样本出处见各文件头注释（028 报告 / golang testdata / verify 脚本锁定结构）。

use chrono::{TimeZone, Utc};
use domain::provider::ProviderError;
use domain::types::*;
use providers::{exchange, push2delay, sina_hq, sina_jsonp, tencent_ifzq, tencent_qt, ths_cs};

fn load(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR")))
        .expect("golden file exists")
}
fn now() -> chrono::DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 0, 0).unwrap() }

#[test]
fn ifzq_golden_field_order_trap() {
    let bars = tencent_ifzq::parse_m1(&load("tencent_ifzq_m1.json"), &Code("518880".into())).unwrap();
    assert_eq!(bars.len(), 3);
    // 时间：2026-09-02 14:58 CST = 06:58 UTC（Asia/Shanghai 解析、UTC 存储）
    assert_eq!(bars[0].ts, Utc.with_ymd_and_hms(2026, 9, 2, 6, 58, 0).unwrap());
    // ⚠️ 2 号位是收不是高（028 §2.1 字段序陷阱锁定）
    let last = &bars[2];
    assert_eq!(last.open, 8.903);
    assert_eq!(last.close, 8.902);
    assert_eq!(last.high, 8.903);
    assert_eq!(last.low, 8.902);
    // 单位：量(手)→股 ×100；额(万元)→元 ×10000
    assert_eq!(last.volume, 3_419_200);
    assert!((last.amount - 29_170.0).abs() < 1e-6);
    assert_eq!(last.source, SourceId::TencentIfzq);
    assert_eq!(last.period, Period::M1);
}

#[test]
fn ifzq_empty_m1_is_nodata() {
    match tencent_ifzq::parse_m1(&load("tencent_ifzq_m1_nodata.json"), &Code("518880".into())) {
        Err(ProviderError::NoData) => {}
        other => panic!("空 m1 应为 NoData（记 NA 不计失败），实际 {other:?}"),
    }
}

#[test]
fn sina_jsonp_golden_strips_wrapper() {
    let text = String::from_utf8(load("sina_jsonp_m1.txt")).unwrap();
    let bars = sina_jsonp::parse_m1(&text, &Code("518880".into())).unwrap();
    assert_eq!(bars.len(), 5);
    // 首根为 028 §3 报告原值；volume 单位为股（无 ×100，golden 验证锁定）
    assert_eq!(bars[0].ts, Utc.with_ymd_and_hms(2026, 9, 2, 6, 56, 0).unwrap());
    assert_eq!(bars[0].open, 8.893);
    assert_eq!(bars[0].close, 8.894);
    assert_eq!(bars[0].volume, 5_245_984);
    assert!((bars[0].amount - 46_660_462.307_7).abs() < 1e-4);
    // 末根 15:00 close=8.902（028 交叉基准锚值）
    assert_eq!(bars[4].ts, Utc.with_ymd_and_hms(2026, 9, 2, 7, 0, 0).unwrap());
    assert_eq!(bars[4].close, 8.902);
    assert_eq!(bars[4].source, SourceId::SinaJsonp);
}

#[test]
fn sina_jsonp_null_is_nodata() {
    let text = String::from_utf8(load("sina_jsonp_m1_null.txt")).unwrap();
    match sina_jsonp::parse_m1(&text, &Code("518880".into())) {
        Err(ProviderError::NoData) => {}
        other => panic!("null（旧端点退化形态）应为 NoData，实际 {other:?}"),
    }
}

#[test]
fn tencent_qt_golden_gbk_tilde_fields() {
    let quotes = tencent_qt::parse_quotes(&load("tencent_qt_snapshot.txt"), now()).unwrap();
    assert_eq!(quotes.len(), 4, "golden 原文 4 行（sh518880/sz159915/sh513330/sz159742）");
    let q = quotes.iter().find(|q| q.code.0 == "518880").unwrap();
    assert_eq!(q.last, 9.564);
    assert_eq!(q.prev_close, 9.388);
    assert_eq!(q.volume, 913_632_800, "9136328 手 → 股 ×100");
    assert!((q.amount - 8_717_760_000.0).abs() < 1.0, "871776 万元 → 元 ×10000");
    // ts 20260824161440 CST → 08:14:40 UTC
    assert_eq!(q.data_ts, Utc.with_ymd_and_hms(2026, 8, 24, 8, 14, 40).unwrap());
    assert_eq!(q.source, SourceId::TencentQt);
}

#[test]
fn sina_hq_golden_gbk_comma_fields() {
    let quotes = sina_hq::parse_quotes(&load("sina_hq_snapshot.txt"), now()).unwrap();
    assert_eq!(quotes.len(), 4);
    let q = quotes.iter().find(|q| q.code.0 == "518880").unwrap();
    assert_eq!(q.last, 9.564);
    assert_eq!(q.prev_close, 9.388);
    assert_eq!(q.volume, 913_632_792, "vol 单位为股（无换算）");
    assert!((q.amount - 8_717_758_032.0).abs() < 1.0, "amount 单位为元");
    // ts "2026-08-24 15:34:59" CST → 07:34:59 UTC
    assert_eq!(q.data_ts, Utc.with_ymd_and_hms(2026, 8, 24, 7, 34, 59).unwrap());
    assert_eq!(q.source, SourceId::SinaHq);
}

#[test]
fn ths_cs_golden_jsonp_fields() {
    let text = String::from_utf8(load("ths_cs_last.js")).unwrap();
    let q = ths_cs::parse_last(&text, &Code("518880".into()), now()).unwrap();
    assert_eq!(q.last, 8.902);
    assert_eq!(q.prev_close, 8.902);
    assert_eq!(q.data_ts, now(), "端点无 ts → 拉取时刻");
    assert_eq!(q.source, SourceId::ThsCs);
    // 缺字段 → Parse
    assert!(matches!(ths_cs::parse_last("{}", &Code("518880".into()), now()),
                     Err(ProviderError::Parse(_))));
}

#[test]
fn push2delay_golden_fltt2_string_coercion() {
    let quotes = push2delay::parse_quotes(&load("push2delay_ulist.json"), now()).unwrap();
    // fltt=2 格式化字符串强转 float（028 前科）；`-` 停牌行跳过
    assert_eq!(quotes.len(), 3, "159776 全 '-' 应跳过");
    let q = quotes.iter().find(|q| q.code.0 == "518880").unwrap();
    assert_eq!(q.last, 8.902);
    assert_eq!(q.prev_close, 9.118);
    assert_eq!(q.volume, 849_701_500, "8497015 手 → 股 ×100");
    assert!((q.amount - 7_544_980_786.0).abs() < 1.0);
    assert_eq!(q.source, SourceId::Push2delay);
}

#[test]
fn exchange_golden_dual_endpoints() {
    let sh = exchange::parse_sse_snap(&load("exchange_sse_snap.json"), &Code("518880".into()), now()).unwrap();
    assert_eq!(sh.last, 8.902);
    assert_eq!(sh.prev_close, 9.118);
    assert_eq!(sh.data_ts, Utc.with_ymd_and_hms(2026, 9, 2, 8, 29, 6).unwrap(),
               "date 20260902 + time 162906 → 16:29:06 CST = 08:29:06 UTC");
    let sz = exchange::parse_szse_timedata(&load("exchange_szse_timedata.json"), &Code("161226".into()), now()).unwrap();
    assert_eq!(sz.last, 1.925);
    assert_eq!(sz.prev_close, 1.977);
    assert_eq!(sz.data_ts, Utc.with_ymd_and_hms(2026, 9, 2, 7, 0, 0).unwrap());
    assert_eq!(sz.source, SourceId::Exchange);
}

#[test]
fn smoke_csvs_are_structured_auxiliary() {
    // 028 冒烟 CSV 辅助材料：字段级交叉断言（round..cross 列结构）
    for f in std::fs::read_dir(format!("{}/testdata/smoke", env!("CARGO_MANIFEST_DIR"))).unwrap() {
        let text = String::from_utf8(std::fs::read(f.unwrap().path()).unwrap()).unwrap();
        let header = text.lines().next().unwrap();
        assert!(header.starts_with("round,bei_time,code,"), "冒烟 CSV 表头结构: {header}");
        assert!(header.contains("status"), "含 status 列: {header}");
    }
}
```

### 6.6 HTTP 层行为测试（mock HttpClient，不触网）

``` {.rust file=crates/providers/tests/http_behavior.rs}
//! HTTP 层行为测试：Referer 必带 / 备域兜底 / 错误传播 / 限频门。mock HttpClient，不触网。

use async_trait::async_trait;
use domain::provider::{MinuteKlineProvider, ProviderError, SnapshotProvider};
use domain::types::*;
use providers::http::{HttpClient, HttpResponse, IntervalGate};
use providers::{sina_hq, tencent_ifzq};
use providers::sina_hq::SinaHq;
use providers::tencent_ifzq::TencentIfzq;
use std::sync::{Arc, Mutex};

type RecordedCall = (String, Vec<(String, String)>);

#[derive(Default)]
struct Mock {
    calls: Mutex<Vec<RecordedCall>>,
    queue: Mutex<Vec<Result<Vec<u8>, ProviderError>>>,
}

impl Mock {
    fn push(&self, r: Result<Vec<u8>, ProviderError>) { self.queue.lock().unwrap().push(r); }
    fn urls(&self) -> Vec<String> { self.calls.lock().unwrap().iter().map(|c| c.0.clone()).collect() }
    fn headers_of(&self, i: usize) -> Vec<(String, String)> { self.calls.lock().unwrap()[i].1.clone() }
}

#[async_trait]
impl HttpClient for Mock {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, ProviderError> {
        self.calls.lock().unwrap().push((url.to_string(),
            headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()));
        let r = self.queue.lock().unwrap().remove(0);
        r.map(|body| HttpResponse { status: 200, body })
    }
}

#[tokio::test]
async fn sina_hq_sends_referer() {
    let mock = Arc::new(Mock::default());
    mock.push(Ok(std::fs::read(format!("{}/testdata/sina_hq_snapshot.txt", env!("CARGO_MANIFEST_DIR"))).unwrap()));
    let p = SinaHq::new(mock.clone());
    let quotes = p.fetch_snapshot(&[Code("518880".into())]).await.unwrap();
    assert_eq!(quotes.len(), 4);
    let headers = mock.headers_of(0);
    assert!(headers.iter().any(|(k, v)| k == "Referer" && v == sina_hq::REFERER),
            "SinaHq 必带 Referer（否则 403）: {headers:?}");
    assert!(mock.urls()[0].starts_with(sina_hq::ENDPOINT));
}

#[tokio::test]
async fn ifzq_fallback_endpoint_on_failure() {
    let mock = Arc::new(Mock::default());
    mock.push(Err(ProviderError::Http("conn reset".into())));
    mock.push(Ok(std::fs::read(format!("{}/testdata/tencent_ifzq_m1.json", env!("CARGO_MANIFEST_DIR"))).unwrap()));
    let p = TencentIfzq::new(mock.clone());
    let bars = p.fetch_m1(&Code("518880".into()), 5).await.unwrap();
    assert_eq!(bars.len(), 3);
    let urls = mock.urls();
    assert!(urls[0].starts_with(tencent_ifzq::ENDPOINT));
    assert!(urls[1].starts_with(tencent_ifzq::ENDPOINT_FALLBACK), "主域失败应兜底备域");
}

#[tokio::test]
async fn ifzq_fallback_also_fails_propagates_first_error() {
    let mock = Arc::new(Mock::default());
    mock.push(Err(ProviderError::RateLimited));
    mock.push(Err(ProviderError::Timeout));
    let p = TencentIfzq::new(mock.clone());
    match p.fetch_m1(&Code("518880".into()), 5).await {
        Err(ProviderError::RateLimited) => {}
        other => panic!("双域皆败应传播首个错误（RateLimited 走退避不进熔断），实际 {other:?}"),
    }
}

#[tokio::test]
async fn gate_enforces_min_interval() {
    let g = IntervalGate::new(std::time::Duration::from_millis(50), 0);
    let t0 = std::time::Instant::now();
    for _ in 0..3 { g.wait().await; }
    assert!(t0.elapsed() >= std::time::Duration::from_millis(100),
            "3 次放行（首次立即）应至少间隔 2×50ms，实际 {:?}", t0.elapsed());
}
```

> 注：`IntervalGate`/各适配器限频档（Tier1 1 req/s + 0~200ms 抖动）为 §1/§2 口径；
> 错误分类（403/429→RateLimited、超时→Timeout、5xx→Http、结构异常→Parse、空数据→NoData）在
> ReqwestHttp 与各 parse 函数落实，01 §4 口径由 domain 契约测试 + 本节行为测试双侧锁定。
