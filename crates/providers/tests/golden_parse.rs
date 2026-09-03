// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/tests/golden_parse.rs>>[init]
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
// ~/~ end
