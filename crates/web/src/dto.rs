// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/dto.rs>>[init]
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
// ~/~ end
