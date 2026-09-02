// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/tests/golden_parse.rs>>[init]
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
// ~/~ end
