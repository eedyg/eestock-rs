// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/dto.rs>>[init]
//! REST/WS 线格式（serde DTO）与查询参数校验纯函数。

use chrono::{DateTime, Utc};
use domain::ports::{KlineBarView, RunView, SymbolLatestView};
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
    /// 是否收藏（Word 3 页面① 看板收藏；由 get_symbols handler 经 FavoriteStore.favorite_map 注入）。
    pub favorite: bool,
    /// 收藏排序（置顶/拖拽后 sort_order；非收藏 → None）。
    pub favorite_sort: Option<i32>,
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
            favorite: false, favorite_sort: None,
        }
    }
}

// ── Wave 3 页面① 看板收藏 DTO（favorite_symbols 表，0013）──

/// PUT /api/symbols/favorites/order 请求体：codes 顺序即收藏区展示顺序（可子集，须均为已收藏 code）。
#[derive(Debug, Deserialize)]
pub struct ReorderFavoritesReq {
    pub codes: Vec<String>,
}

/// GET /api/sources/health 查询参数。
#[derive(Debug, Deserialize)]
pub struct HealthQuery {
    #[serde(default = "default_window")]
    pub window_secs: i64,
}

// ── Wave 2 Phase A：数据质量（页面④）查询参数与校验纯函数 ──

/// GET /api/quality/divergence 查询参数。
#[derive(Debug, Deserialize)]
pub struct DivergenceQuery {
    pub code: String,
    pub from: String,
    pub to: String,
    pub threshold_pct: Option<f64>,
}

/// GET /api/quality/source-accuracy 查询参数（全标的，无 code）。
#[derive(Debug, Deserialize)]
pub struct SourceAccuracyQuery {
    pub from: String,
    pub to: String,
    pub threshold_pct: Option<f64>,
}

/// GET /api/quality/gaps 查询参数。
#[derive(Debug, Deserialize)]
pub struct GapsQuery {
    pub code: String,
    pub from: String,
    pub to: String,
}

/// YYYY-MM-DD 解析（前端日期控件口径；严格定长——chrono %Y-%m-%d 容忍未补零）。
pub fn parse_date(s: &str) -> Option<chrono::NaiveDate> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' { return None; }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// 阈值校验（%）：>0 且 ≤100。
pub fn validate_threshold(t: f64) -> Result<(), String> {
    if !(t > 0.0 && t <= 100.0) { return Err("threshold_pct 须在 (0, 100]".into()); }
    Ok(())
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

// ── 页面⑧ 系统设置 S1（08-settings.md §6）：系统信息 / 运维 / 只读配置快照 DTO ──

/// 各应用面 crate 版本（由 app 装配注入；web 不依赖 collector/storage，纯 DI）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CrateVersions {
    pub collector: String,
    pub storage: String,
    pub diagnose: String,
}

/// GET /api/system/info 响应（只读；db_ok=false 表示进程在线但 DB 断开，非错误态）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SystemInfoDto {
    pub app_version: String,
    pub crate_versions: CrateVersions,
    pub db_ok: bool,
    pub uptime_secs: u64,
}

/// POST /api/system/purge-raw 与 reset-circuits 请求体（confirm 可选：
/// 缺失/不匹配 → 400 服务端拒绝；用 Option 而非必填，避免 axum Json 缺字段返回 422）。
#[derive(Debug, Deserialize)]
pub struct ConfirmReq {
    pub confirm: Option<String>,
}

/// POST /api/system/purge-raw 响应（rows_deleted=清理的 kline_raw 行数）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PurgeRawResultDto {
    pub rows_deleted: u64,
}

/// POST /api/system/reset-circuits 响应（requests=写入的熔断复位请求数）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResetCircuitsResultDto {
    pub requests: usize,
}

/// GET /api/config/sources 单源只读快照项。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceConfigItemDto {
    pub id: String,
    pub label: String,
    pub role: String,
    pub rate_per_sec: i64,
    pub jitter_ms: i64,
    pub circuit_fail_count: i64,
    pub backoff_steps: Vec<String>,
    pub enabled: bool,
    pub rotation_locked: bool,
}

/// GET /api/config/sources 响应（当前只读快照；S1 不落库，值为 SETTINGS_DEFAULTS 默认）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceConfigSnapshotDto {
    pub sources: Vec<SourceConfigItemDto>,
}

/// GET /api/config/collector 响应（交易时段写死只读）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CollectorConfigSnapshotDto {
    pub default_interval_sec: i64,
    pub trading_hours: String,
}

/// GET /api/config/mcp 响应（只读；交易工具默认关，开启需二次确认 ADR-009）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpConfigSnapshotDto {
    pub enabled: bool,
    pub trading_tools_enabled: bool,
    pub daily_limit_amount: i64,
    pub daily_limit_count: i64,
}

/// 熔断复位内置源清单（reset-circuits 全部源；非近似变体，即数据面真实注册源）。
pub const RESET_SOURCES: &[&str] = &[
    "tencent_ifzq", "sina_jsonp", "tencent_qt", "sina_hq",
    "ths_cs", "push2delay", "exchange", "tushare",
];

// ── Wave 3 Phase 3c：回测（§1.5；DTO 与校验纯函数）──

fn default_backtest_params() -> serde_json::Value { serde_json::json!({}) }

/// POST /api/backtest/runs 请求体（from/to 为 RFC3339 字符串，handler 解析为 DateTime<Utc>）。
#[derive(Debug, Deserialize)]
pub struct BacktestSubmitReq {
    pub code: String,
    /// M1/M5/M15/D1（H1 回测不支持）。
    pub period: String,
    pub from: String,
    pub to: String,
    pub strategy_id: String,
    /// 单点策略参数（缺省 `{}`；`params_grid` 场景下作为公共基础参数）。
    #[serde(default = "default_backtest_params")]
    pub params: serde_json::Value,
    /// 参数网格 `{k: "起:止:步长"}`（缺省 None = 单 run）。
    #[serde(default)]
    pub params_grid: Option<serde_json::Value>,
    /// 费用 `{rate_pct, min_fee, slippage_bp}`。
    pub fee: serde_json::Value,
    /// 初始资金（缺省 100_000，ADR §4）。
    #[serde(default)]
    pub initial_capital: Option<f64>,
}

/// 回测周期校验：M1/M5/M15/D1（H1 回测不支持，08-backtest §3）。
pub fn validate_backtest_period(s: &str) -> Result<(), FieldError> {
    match s {
        "M1" | "M5" | "M15" | "D1" => Ok(()),
        other => Err(FieldError::BadRequest(format!("period 须为 M1/M5/M15/D1，实际 {other}"))),
    }
}

/// 校验提交体至少含 params 或 params_grid 之一（§1.5：二选一）。
pub fn validate_backtest_params_present(
    params: &serde_json::Value,
    params_grid: &Option<serde_json::Value>,
) -> Result<(), FieldError> {
    if params_grid.is_none() && params.is_null() {
        return Err(FieldError::BadRequest("params 或 params_grid 必填其一".into()));
    }
    Ok(())
}

/// 费用校验：`{rate_pct, min_fee, slippage_bp}` 三字段必须齐、均为数值。
pub fn validate_backtest_fee(fee: &serde_json::Value) -> Result<(), FieldError> {
    let obj = fee.as_object().ok_or_else(|| FieldError::BadRequest("fee 应为对象".into()))?;
    for key in ["rate_pct", "min_fee", "slippage_bp"] {
        match obj.get(key) {
            Some(v) if v.is_number() => {}
            Some(_) => return Err(FieldError::BadRequest(format!("fee.{key} 应为数值"))),
            None => return Err(FieldError::BadRequest(format!("fee.{key} 缺失"))),
        }
    }
    Ok(())
}

/// GET /api/backtest/runs 查询参数（status/group_id 均可选）。
#[derive(Debug, Deserialize, Default)]
pub struct BacktestListQuery {
    pub status: Option<String>,
    pub group_id: Option<String>,
}

/// GET /api/backtest/compare 查询参数（ids 逗号分隔）。
#[derive(Debug, Deserialize)]
pub struct BacktestCompareQuery {
    pub ids: String,
}

/// 解析 `ids=1,2,3` 为 `Vec<i64>`；空/含非数字 → FieldError。
pub fn parse_backtest_ids(s: &str) -> Result<Vec<i64>, FieldError> {
    let mut out = Vec::new();
    for part in s.split(',') {
        let t = part.trim();
        if t.is_empty() { continue; } // 容忍尾部/重复逗号
        match t.parse::<i64>() {
            Ok(v) => out.push(v),
            Err(_) => return Err(FieldError::BadRequest(format!("ids 含非数字: {t}"))),
        }
    }
    if out.is_empty() {
        return Err(FieldError::BadRequest("ids 必填（逗号分隔的 run id）".into()));
    }
    Ok(out)
}

/// 回测 run 读模型（GET /api/backtest/runs、/{id}、compare 响应项）。
/// B1 增补：initial_capital/date_from/date_to（迁移 0012 持久化；前端展示区间）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BacktestRunDto {
    pub id: i64,
    pub code: String,
    pub period: String,
    pub strategy_id: String,
    pub params: serde_json::Value,
    pub fee: serde_json::Value,
    pub initial_capital: f64,
    pub date_from: DateTime<Utc>,
    pub date_to: DateTime<Utc>,
    pub status: String,
    pub progress: i32,
    pub current_ts: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trades: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<serde_json::Value>,
}

impl From<&RunView> for BacktestRunDto {
    fn from(r: &RunView) -> Self {
        let result = r.result.as_ref();
        BacktestRunDto {
            id: r.id,
            code: r.code.clone(),
            period: r.period.clone(),
            strategy_id: r.strategy_id.clone(),
            params: r.params.clone(),
            fee: r.fee.clone(),
            initial_capital: r.initial_capital,
            date_from: r.date_from,
            date_to: r.date_to,
            status: r.status.as_str().to_string(),
            progress: r.progress,
            current_ts: r.current_ts,
            created_at: r.created_at,
            finished_at: r.finished_at,
            error: r.error.clone(),
            group_id: r.group_id.clone(),
            net_value: result.map(|res| res.net_value.clone()),
            trades: result.map(|res| res.trades.clone()),
            metrics: result.map(|res| res.metrics.clone()),
        }
    }
}

/// 策略目录项（GET /api/backtest/strategies）。params_schema 直通 backtest::ParamDef 的 JSON 形态。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BacktestStrategyDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub params_schema: Vec<serde_json::Value>,
}

/// 8 项绩效指标（BacktestMetrics 的 jsonb 形态；供前端/测试类型化解析）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetricsDto {
    pub net_profit: f64,
    pub max_drawdown: f64,
    pub sharpe: f64,
    pub win_rate: f64,
    pub profit_factor: f64,
    pub annualized_return: f64,
    pub trade_count: usize,
    pub avg_hold_bars: f64,
}

/// 单笔交易（TradeDetail 的 jsonb 形态）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TradeDto {
    pub open_ts: i64,
    pub close_ts: i64,
    pub open_bar: usize,
    pub close_bar: usize,
    pub open_price: f64,
    pub close_price: f64,
    pub shares: f64,
    pub gross_value: f64,
    pub commission: f64,
    pub stamp_duty: f64,
    pub pnl: f64,
    pub hold_bars: usize,
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

    // ── Wave 3 页面① 看板收藏 DTO（favorite/favorite_sort 恒输出；ReorderFavoritesReq 反序列化）──

    #[test]
    fn symbol_dto_favorite_fields_always_serialize() {
        // 非收藏 → favorite=false, favorite_sort=null（Always 输出，前端置顶 UI 依据）
        let row = SymbolLatestView { code: "997702".into(), name: None, interval_secs: 60,
            settlement: "T1".into(), enabled: true,
            last_ts: None, last_close: None, prev_close: None };
        let v = serde_json::to_value(SymbolDto::from(&row)).unwrap();
        assert_eq!(v["favorite"], false);
        assert!(v["favorite_sort"].is_null());
        // 收藏标注（handler 注入）：favorite=true, favorite_sort=1
        let mut dto = SymbolDto::from(&row);
        dto.favorite = true;
        dto.favorite_sort = Some(1);
        let v2 = serde_json::to_value(&dto).unwrap();
        assert_eq!(v2["favorite"], true);
        assert_eq!(v2["favorite_sort"], 1);
    }

    #[test]
    fn reorder_favorites_req_deserialize() {
        let req: ReorderFavoritesReq = serde_json::from_str(r#"{"codes":["600519","518880"]}"#).unwrap();
        assert_eq!(req.codes, vec!["600519", "518880"]);
        // 空数组可接受（无收藏 → 空重排，无需收藏 400）
        let empty: ReorderFavoritesReq = serde_json::from_str(r#"{"codes":[]}"#).unwrap();
        assert!(empty.codes.is_empty());
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

    // ── Wave 2 Phase A：质量端点查询参数校验 ──

    #[test]
    fn parse_date_and_threshold_validation() {
        assert_eq!(parse_date("2026-09-03").unwrap(),
            chrono::NaiveDate::from_ymd_opt(2026, 9, 3).unwrap());
        assert!(parse_date("2026/09/03").is_none());
        assert!(parse_date("2026-9-3").is_none(), "严格 %Y-%m-%d");
        assert!(parse_date("").is_none());
        assert!(validate_threshold(0.5).is_ok());
        assert!(validate_threshold(0.3).is_ok());
        assert!(validate_threshold(0.0).is_err());
        assert!(validate_threshold(-1.0).is_err());
        assert!(validate_threshold(100.0).is_ok());
        assert!(validate_threshold(100.1).is_err());
    }

    #[test]
    fn backtest_period_fee_and_params_validation() {
        assert!(validate_backtest_period("M1").is_ok());
        assert!(validate_backtest_period("D1").is_ok());
        assert!(matches!(validate_backtest_period("H1"), Err(FieldError::BadRequest(_))));
        assert!(matches!(validate_backtest_period("1m"), Err(FieldError::BadRequest(_))), "前端 1m 非回测口径");

        let ok = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
        assert!(validate_backtest_fee(&ok).is_ok());
        let missing = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0});
        assert!(matches!(validate_backtest_fee(&missing), Err(FieldError::BadRequest(_))));
        let nonnum = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": "2"});
        assert!(matches!(validate_backtest_fee(&nonnum), Err(FieldError::BadRequest(_))));
        assert!(matches!(validate_backtest_fee(&serde_json::json!(42)), Err(FieldError::BadRequest(_))));

        assert!(validate_backtest_params_present(&serde_json::json!({}), &None).is_ok());
        assert!(validate_backtest_params_present(&serde_json::json!({}), &Some(serde_json::json!({}))).is_ok());
        assert!(matches!(
            validate_backtest_params_present(&serde_json::Value::Null, &None),
            Err(FieldError::BadRequest(_))
        ), "无 params 且无 params_grid → 400");
    }

    #[test]
    fn backtest_parse_ids() {
        assert_eq!(parse_backtest_ids("1,2,3").unwrap(), vec![1, 2, 3]);
        assert_eq!(parse_backtest_ids("1, 2 ,3").unwrap(), vec![1, 2, 3], "容忍空格");
        assert_eq!(parse_backtest_ids("1,,2").unwrap(), vec![1, 2], "容忍空段");
        assert!(matches!(parse_backtest_ids(""), Err(FieldError::BadRequest(_))));
        assert!(matches!(parse_backtest_ids("abc"), Err(FieldError::BadRequest(_))));
    }

    #[test]
    fn backtest_dto_json_shapes() {
        // RunView → BacktestRunDto（status 用 as_str()，result 未完成时结果字段 None 跳过序列化）
        let v = serde_json::to_value(BacktestRunDto::from(&RunView {
            id: 7, code: "600000".into(), period: "D1".into(), strategy_id: "dual_ma".into(),
            params: serde_json::json!({}), fee: serde_json::json!({}),
            initial_capital: 100_000.0,
            date_from: chrono::Utc::now(), date_to: chrono::Utc::now(),
            status: domain::ports::RunStatus::Pending, progress: 0, current_ts: None,
            created_at: chrono::Utc::now(), finished_at: None, error: None, group_id: None, result: None,
        })).unwrap();
        assert_eq!(v["status"], "pending");
        assert_eq!(v["initial_capital"], 100_000.0);
        assert!(v.get("date_from").is_some(), "date_from 输出（B1 持久化展示）");
        assert!(v.get("date_to").is_some());
        assert!(v.get("net_value").is_none(), "未完成不输出 net_value 键");
        assert!(v.get("metrics").is_none());

        // 策略目录 DTO：params_schema 为数组直通
        let s = BacktestStrategyDto { id: "dual_ma".into(), name: "双均线".into(),
            description: "d".into(), params_schema: vec![serde_json::json!({"key": "fast"})] };
        let sv = serde_json::to_value(&s).unwrap();
        assert_eq!(sv["id"], "dual_ma");
        assert_eq!(sv["params_schema"][0]["key"], "fast");

        // Metrics/Trade DTO 可反序列化（锁定 jsonb 字段名）
        let m: MetricsDto = serde_json::from_value(serde_json::json!({
            "net_profit": 8.9, "max_drawdown": 0.1, "sharpe": 4.58, "win_rate": 0.5,
            "profit_factor": 2.0, "annualized_return": 214.0, "trade_count": 2, "avg_hold_bars": 2.5,
        })).unwrap();
        assert_eq!(m.trade_count, 2);
        let t: TradeDto = serde_json::from_value(serde_json::json!({
            "open_ts": 0, "close_ts": 1, "open_bar": 0, "close_bar": 1, "open_price": 1.0,
            "close_price": 1.1, "shares": 100.0, "gross_value": 110.0, "commission": 0.1,
            "stamp_duty": 0.05, "pnl": 9.9, "hold_bars": 1,
        })).unwrap();
        assert_eq!(t.pnl, 9.9);
    }
}
// ~/~ end
