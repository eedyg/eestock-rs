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

/// 前端周期口径（06-web/01-dashboard 定稿）：1m/5m/15m/1h/1d；看板 W1 增 1w/1mo（周/月，用户定稿）。
/// ⚠️ 1m 已=分钟，故周/月用 1w/1mo（避免与 1m 混淆）；domain 变体名为 W1/MO1。仅看板读源，回测周期不扩。
pub fn parse_period(s: &str) -> Option<Period> {
    match s {
        "1m" => Some(Period::M1),
        "5m" => Some(Period::M5),
        "15m" => Some(Period::M15),
        "1h" => Some(Period::H1),
        "1d" => Some(Period::D1),
        "1w" => Some(Period::W1),
        "1mo" => Some(Period::MO1),
        _ => None,
    }
}

/// GET/PUT /api/config/ma 响应/请求体：MA 窗口列表（归一化升序去重，默认 [5,10,20]；主图+宫格应用，回测弹窗不动）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MaConfigDto {
    pub windows: Vec<i32>,
}

/// MA 窗口校验 + 归一化（纯函数，web handler 层 400 用）：
/// - 条目数 1..=3（最多 3 条 MA）
/// - 每条 1..=500 整数
/// - 归一化：去重（保留首次出现）+ 升序排序（升序/去重归一，存库前统一口径）
///
/// 失败返回描述性错误（handler `err(400, e)`）。
pub fn validate_ma_windows(windows: &[i32]) -> Result<Vec<i32>, String> {
    // count
    if windows.is_empty() { return Err("MA 至少 1 条".into()); }
    if windows.len() > 3 { return Err("MA 最多 3 条".into()); }
    for &w in windows {
        if !(1..=500).contains(&w) { return Err(format!("MA 窗口须为 1..=500 整数，不合规值：{w}")); }
    }
    // 归一化：去重（保持首次出现）+ 升序
    let mut out: Vec<i32> = Vec::new();
    for &w in windows {
        if !out.contains(&w) { out.push(w); }
    }
    out.sort_unstable();
    Ok(out)
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
    /// **日涨跌幅**（%）：(last − 昨收) / 昨收；昨收=前一交易日 D1 收盘，无 D1 历史 → None。
    pub change_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SymbolDto {
    pub code: String,
    pub name: Option<String>,
    /// ADR-019 D11-1：标的类型（`etf`/`lof`/`stock`/保留位）；**null = 未设置（未知）**。
    pub r#type: Option<String>,
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
            code: r.code.clone(), name: r.name.clone(), r#type: r.type_.clone(),
            interval_secs: r.interval_secs,
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
    /// ADR-019 D11-1：标的类型（**可选**；缺省 = None = 未知，不静默错判）。
    pub r#type: Option<String>,
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
    /// ADR-019 D11-1：标的类型（None = 不改；空串 → 400，本批不支持经 API 清空 type）。
    pub r#type: Option<String>,
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

/// 标的类型枚举（ADR-019 D11-1，与 `symbols_type_check` CHECK 同口径；
/// `bond_etf`/`money_etf`/`index` = D11-6 保留位，可登记但本批无费率档案 → 回退旧默认）。
pub const SYMBOL_TYPES: [&str; 6] = ["etf", "lof", "stock", "bond_etf", "money_etf", "index"];

/// type 校验（ADR-019 D11-1）：None 合法（未知）；空串拒绝（避免「意外清空」歧义）；枚举外 400。
pub fn validate_symbol_type(t: Option<&str>) -> Result<(), FieldError> {
    match t {
        None => Ok(()),
        Some(x) if SYMBOL_TYPES.contains(&x) => Ok(()),
        Some("") => Err(FieldError::BadRequest(
            "type 不可为空串（省略该字段 = 保持/未知；本批不支持经 API 清空 type）".into())),
        Some(x) => Err(FieldError::BadRequest(format!(
            "type 须为 {} 之一，got {x}", SYMBOL_TYPES.join("/")))),
    }
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

// ── 页面⑧ 系统设置 S2：配置持久化 PATCH 请求体 / 校验（08-settings.md §6 + 00-web-api.md config 契约）──
// 前端编辑 → PATCH /api/config/{sources,collector,mcp}；值域校验（非法 → 400）、
// 东财末位（ADR-006）、≥60（collector 间隔）、≥0（限额）在 web 层完成；storage ConfigStore 只存 jsonb。

/// PATCH /api/config/sources 单源可编辑参数（label/role/rotation_locked 由服务端按 SOURCE_CONFIG 派生）；
/// 轮转序 = sources 数组顺序；push2delay（东财系）必须为末位（ADR-006 服务端校验）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceConfigPatchItemDto {
    pub id: String,
    pub rate_per_sec: i64,
    pub jitter_ms: i64,
    pub circuit_fail_count: i64,
    pub backoff_steps: Vec<String>,
    pub enabled: bool,
}

/// PATCH /api/config/sources 请求体：完整源清单（含轮转序）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SourceConfigPatchDto {
    pub sources: Vec<SourceConfigPatchItemDto>,
}

/// PATCH /api/config/collector 请求体（交易时段写死只读，不可改）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectorConfigPatchDto {
    pub default_interval_sec: i64,
}

/// PATCH /api/config/mcp 请求体（总开关/交易工具/每日限额）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpConfigPatchDto {
    pub enabled: bool,
    pub trading_tools_enabled: bool,
    pub daily_limit_amount: i64,
    pub daily_limit_count: i64,
}

/// 单源可编辑参数值域校验（纯函数，单元可测）：速率/抖动/熔断次数 ≥0；退避档位非空且每档非空字符串。
pub fn validate_source_config_item(it: &SourceConfigPatchItemDto) -> Result<(), String> {
    if it.id.trim().is_empty() { return Err("源 id 不能为空".into()); }
    if it.rate_per_sec < 0 { return Err(format!("源 {} 速率 rate_per_sec 须 ≥0", it.id)); }
    if it.jitter_ms < 0 { return Err(format!("源 {} 抖动 jitter_ms 须 ≥0", it.id)); }
    if it.circuit_fail_count < 0 { return Err(format!("源 {} 熔断次数 circuit_fail_count 须 ≥0", it.id)); }
    if it.backoff_steps.is_empty() { return Err(format!("源 {} 退避档位不能为空", it.id)); }
    if it.backoff_steps.iter().any(|b| b.trim().is_empty()) {
        return Err(format!("源 {} 退避档位含空字符串", it.id));
    }
    Ok(())
}

/// sources 清单校验（纯函数）：全部为已知内置源、无重复 id、每源值域合法、含全部内置源、
/// push2delay（东财系）必须为末位（ADR-006）。失败返回描述性错误（handler `err(400, e)`）。
pub fn validate_source_config(dto: &SourceConfigPatchDto) -> Result<(), String> {
    if dto.sources.is_empty() { return Err("源清单不能为空".into()); }
    let mut seen = std::collections::HashSet::new();
    for it in &dto.sources {
        if !RESET_SOURCES.contains(&it.id.as_str()) { return Err(format!("未知源 id：{}", it.id)); }
        if !seen.insert(it.id.clone()) { return Err(format!("源 id 重复：{}", it.id)); }
        validate_source_config_item(it)?;
    }
    // 必须包含全部内置真实源（完整轮转序），否则视为残缺
    for id in RESET_SOURCES {
        if !seen.contains(*id) { return Err(format!("源清单缺 {}（须为完整内置源清单）", id)); }
    }
    // 东财末位（ADR-006）：push2delay 必须为最后一个元素
    if dto.sources.last().map(|s| s.id.as_str()) != Some("push2delay") {
        return Err("轮转序违规：push2delay（东财系）必须为末位（ADR-006）".into());
    }
    Ok(())
}

/// collector 间隔校验（纯函数）：≥60 秒（全局默认抓取间隔下界）。
#[allow(dead_code)]
pub fn verify_collector_interval(sec: i64) -> Result<(), String> {
    if sec < 60 { return Err(format!("default_interval_sec 须 ≥60，收到 {sec}")); }
    Ok(())
}

/// MCP 限额校验（纯函数）：金额/笔数 ≥0。
#[allow(dead_code)]
pub fn verify_mcp_daily_limit(m: &McpConfigPatchDto) -> Result<(), String> {
    if m.daily_limit_amount < 0 { return Err(format!("daily_limit_amount 须 ≥0，收到 {}", m.daily_limit_amount)); }
    if m.daily_limit_count < 0 { return Err(format!("daily_limit_count 须 ≥0，收到 {}", m.daily_limit_count)); }
    Ok(())
}

/// 熔断复位内置源清单（reset-circuits 全部源；非近似变体，即数据面真实注册源）。
/// 顺序与 rotation（SOURCE_CONFIG）一致：push2delay（东财系，ADR-006）锁定末位。
pub const RESET_SOURCES: &[&str] = &[
    "tencent_ifzq", "sina_jsonp", "tencent_qt", "sina_hq",
    "ths_cs", "exchange", "tushare", "push2delay",
];

// ── 费用校验（§1.5 旧回测退役后由 §1.8 工作台沿用；POST /api/workbench/runs 复用）──

/// 费用校验：`{rate_pct, min_fee, slippage_bp}` 三字段必须齐、均为数值；
/// `stamp_duty_pct` 可选（研发任务裁决：ETF 无印花税，缺省由 application 层取 0.05），若提供须为数值且 ∈ [0, 1]。
pub fn validate_backtest_fee(fee: &serde_json::Value) -> Result<(), FieldError> {
    let obj = fee.as_object().ok_or_else(|| FieldError::BadRequest("fee 应为对象".into()))?;
    for key in ["rate_pct", "min_fee", "slippage_bp"] {
        match obj.get(key) {
            Some(v) if v.is_number() => {}
            Some(_) => return Err(FieldError::BadRequest(format!("fee.{key} 应为数值"))),
            None => return Err(FieldError::BadRequest(format!("fee.{key} 缺失"))),
        }
    }
    if let Some(v) = obj.get("stamp_duty_pct") {
        match v.as_f64() {
            Some(x) if (0.0..=1.0).contains(&x) => {}
            Some(_) => return Err(FieldError::BadRequest("fee.stamp_duty_pct 须 ∈ [0,1]".into())),
            None => return Err(FieldError::BadRequest("fee.stamp_duty_pct 应为数值".into())),
        }
    }
    Ok(())
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
        // 看板 W1 增 周/月：1w/1mo（1m 已=分钟，避免歧义）；回测周期不扩。
        assert_eq!(parse_period("1w"), Some(Period::W1));
        assert_eq!(parse_period("1mo"), Some(Period::MO1));
        assert_eq!(parse_period("3m"), None);
        assert_eq!(parse_period("M1"), None, "domain 变体名不是前端口径");
        assert_eq!(parse_period("1m"), Some(Period::M1), "1m 仍=分钟，不与月混淆");
    }

    #[test]
    fn ma_windows_validation_and_normalize() {
        // 合法：升序去重归一化
        assert_eq!(validate_ma_windows(&[5, 10, 20]).unwrap(), vec![5, 10, 20]);
        assert_eq!(validate_ma_windows(&[20, 5, 10]).unwrap(), vec![5, 10, 20], "乱序归一化升序");
        assert_eq!(validate_ma_windows(&[5, 5, 10]).unwrap(), vec![5, 10], "去重");
        assert_eq!(validate_ma_windows(&[1]).unwrap(), vec![1], "最少 1 条");
        assert_eq!(validate_ma_windows(&[500]).unwrap(), vec![500], "上界 500");
        // 非法：条目数
        assert!(validate_ma_windows(&[]).is_err(), "至少 1 条");
        assert!(validate_ma_windows(&[5, 10, 20, 30]).is_err(), "最多 3 条");
        // 非法：量纲
        assert!(validate_ma_windows(&[0]).is_err());
        assert!(validate_ma_windows(&[501]).is_err());
        assert!(validate_ma_windows(&[-1]).is_err());
    }

    #[test]
    fn ma_config_dto_roundtrip() {
        let dto = MaConfigDto { windows: vec![5, 10, 20] };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["windows"][0], 5);
        let back: MaConfigDto = serde_json::from_value(v).unwrap();
        assert_eq!(back.windows, vec![5, 10, 20]);
    }

    // ── 页面⑧ S2：配置持久化 PATCH 校验纯函数（值域 / 东财末位 ADR-006 / ≥60 / ≥0）──

    fn patch_item(id: &str) -> SourceConfigPatchItemDto {
        SourceConfigPatchItemDto {
            id: id.into(), rate_per_sec: 1, jitter_ms: 0, circuit_fail_count: 3,
            backoff_steps: vec!["5s".into(), "10s".into(), "30s".into()], enabled: true,
        }
    }

    /// 完整合法 sources 清单（前 7 真实源 + push2delay 末位，ADR-006）。
    fn valid_sources_patch() -> SourceConfigPatchDto {
        let mut items: Vec<SourceConfigPatchItemDto> = RESET_SOURCES
            .iter().filter(|s| **s != "push2delay").map(|s| patch_item(s)).collect();
        items.push(patch_item("push2delay")); // 末位
        SourceConfigPatchDto { sources: items }
    }

    #[test]
    fn source_config_patch_validation_ok() {
        assert!(validate_source_config(&valid_sources_patch()).is_ok(), "完整且东财末位 → 合法");
    }

    #[test]
    fn source_config_patch_validation_rejects_bad_values() {
        // rate<0
        let mut p = valid_sources_patch();
        p.sources[0].rate_per_sec = -1;
        assert!(validate_source_config(&p).is_err(), "rate<0 → 拒绝");
        // jitter<0
        let mut p = valid_sources_patch();
        p.sources[0].jitter_ms = -1;
        assert!(validate_source_config(&p).is_err());
        // circuit<0
        let mut p = valid_sources_patch();
        p.sources[0].circuit_fail_count = -1;
        assert!(validate_source_config(&p).is_err());
        // 空退避
        let mut p = valid_sources_patch();
        p.sources[0].backoff_steps = vec![];
        assert!(validate_source_config(&p).is_err());
    }

    #[test]
    fn source_config_patch_validation_rejects_eastmoney_not_last() {
        // push2delay 挪到非末位（首元素）→ 拒（ADR-006）
        let mut p = valid_sources_patch();
        let push = p.sources.remove(p.sources.len() - 1);
        p.sources.insert(0, push);
        assert!(validate_source_config(&p).is_err(), "push2delay 非末位 → 拒（ADR-006）");
    }

    #[test]
    fn source_config_patch_validation_rejects_unknown_dup_missing() {
        // 未知源
        let mut p = valid_sources_patch();
        p.sources[0].id = "not_a_source".into();
        assert!(validate_source_config(&p).is_err(), "未知源 id → 拒");
        // 重复 id
        let mut p = valid_sources_patch();
        p.sources[1].id = p.sources[0].id.clone();
        assert!(validate_source_config(&p).is_err(), "重复 id → 拒");
        // 缺内置源（末位后仍保留 push2delay，但缺某真实源）
        let mut p = valid_sources_patch();
        p.sources.retain(|s| !s.id.is_empty());
        let missing = p.sources.remove(0); // 移除首元素
        assert!(validate_source_config(&p).is_err(), "缺内置源 → 拒");
        let _ = missing;
    }

    #[test]
    fn source_config_patch_item_value_domain() {
        assert!(validate_source_config_item(&patch_item("tencent_ifzq")).is_ok());
        let mut it = patch_item("x");
        it.rate_per_sec = -5;
        assert!(validate_source_config_item(&it).is_err());
        let mut it = patch_item("x");
        it.jitter_ms = -1;
        assert!(validate_source_config_item(&it).is_err());
        let mut it = patch_item("x");
        it.circuit_fail_count = -1;
        assert!(validate_source_config_item(&it).is_err());
    }

    #[test]
    fn collector_interval_validation() {
        assert!(verify_collector_interval(60).is_ok());
        assert!(verify_collector_interval(120).is_ok());
        assert!(verify_collector_interval(59).is_err(), "<60 → 拒");
        assert!(verify_collector_interval(0).is_err());
    }

    #[test]
    fn mcp_daily_limit_validation() {
        let ok = McpConfigPatchDto { enabled: true, trading_tools_enabled: false,
            daily_limit_amount: 50000, daily_limit_count: 20 };
        assert!(verify_mcp_daily_limit(&ok).is_ok());
        let mut bad = McpConfigPatchDto { enabled: true, trading_tools_enabled: false,
            daily_limit_amount: -1, daily_limit_count: 20 };
        assert!(verify_mcp_daily_limit(&bad).is_err(), "金额<0 → 拒");
        bad.daily_limit_amount = 100;
        bad.daily_limit_count = -1;
        assert!(verify_mcp_daily_limit(&bad).is_err(), "笔数<0 → 拒");
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
        let row = SymbolLatestView { code: "997702".into(), name: None, type_: Some("etf".into()),
            interval_secs: 60, settlement: "T1".into(), enabled: true,
            last_ts: None, last_close: None, prev_close: None };
        let v = serde_json::to_value(SymbolDto::from(&row)).unwrap();
        assert!(v["latest"].is_null());
        assert!(v.get("today_bars").is_none(), "非 with_stats 请求不出 today_bars 键");
    }

    // ── Wave 3 页面① 看板收藏 DTO（favorite/favorite_sort 恒输出；ReorderFavoritesReq 反序列化）──

    #[test]
    fn symbol_dto_favorite_fields_always_serialize() {
        // 非收藏 → favorite=false, favorite_sort=null（Always 输出，前端置顶 UI 依据）
        let row = SymbolLatestView { code: "997702".into(), name: None, type_: Some("etf".into()),
            interval_secs: 60, settlement: "T1".into(), enabled: true,
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
    fn symbol_type_validation_enum_and_optional() {
        // ADR-019 D11-1：None 合法（未知）；枚举内合法（含 D11-6 保留位）；枚举外/空串 → 400。
        assert!(validate_symbol_type(None).is_ok());
        for ok in SYMBOL_TYPES {
            assert!(validate_symbol_type(Some(ok)).is_ok(), "{ok} 应合法");
        }
        for bad in ["", "ETF", "stockx", "fund", "etfs"] {
            assert!(matches!(validate_symbol_type(Some(bad)), Err(FieldError::BadRequest(_))),
                "{bad:?} 应拒绝");
        }
    }

    #[test]
    fn backtest_fee_validation() {
        let ok = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
        assert!(validate_backtest_fee(&ok).is_ok());
        let missing = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0});
        assert!(matches!(validate_backtest_fee(&missing), Err(FieldError::BadRequest(_))));
        let nonnum = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": "2"});
        assert!(matches!(validate_backtest_fee(&nonnum), Err(FieldError::BadRequest(_))));
        assert!(matches!(validate_backtest_fee(&serde_json::json!(42)), Err(FieldError::BadRequest(_))));
        // stamp_duty_pct 可选（研发任务裁决：ETF 无印花税）：缺省兼容；显式 0 合法；越界/非数值 400。
        let etf = serde_json::json!({"rate_pct": 0.005, "min_fee": 0.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0});
        assert!(validate_backtest_fee(&etf).is_ok());
        let over = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 1.5});
        assert!(matches!(validate_backtest_fee(&over), Err(FieldError::BadRequest(_))));
        let neg = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": -0.1});
        assert!(matches!(validate_backtest_fee(&neg), Err(FieldError::BadRequest(_))));
        let nonnum_stamp = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": "0"});
        assert!(matches!(validate_backtest_fee(&nonnum_stamp), Err(FieldError::BadRequest(_))));
    }
}

// ~/~ end
