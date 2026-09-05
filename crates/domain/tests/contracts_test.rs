// ~/~ begin <<design/02-domain/contracts.md#crates/domain/tests/contracts_test.rs>>[init]
//! domain 契约测试——由 design/02-domain/contracts.md §2.6 tangle 生成，禁止手改。

use chrono::{TimeZone, Utc};
use domain::merge::merge_prefer_accurate;
use domain::ports::{NewRun, RunFilter, RunResult, RunStatus, RunView};
use domain::provider::ProviderError;
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;

fn bar(code: &str, h: u32, mi: u32, src: SourceId, close: f64) -> Bar {
    Bar {
        code: Code(code.into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 3, h, mi, 0).unwrap(),
        open: close, high: close, low: close, close,
        volume: 100, amount: 100.0, source: src,
    }
}

#[test]
fn market_prefix_mapping() {
    for c in ["518880", "600519", "900901"] {
        assert_eq!(Code(c.into()).market().unwrap(), Market::Sh, "{c} 应判沪");
    }
    for c in ["159915", "000001", "200002", "300750"] {
        assert_eq!(Code(c.into()).market().unwrap(), Market::Sz, "{c} 应判深");
    }
    for c in ["430001", "830799", "920001"] {
        assert!(Code(c.into()).market().is_err(), "{c} 北交所/未知应拒绝");
    }
}

#[test]
fn prefixed_code() {
    assert_eq!(Code("518880".into()).prefixed().unwrap(), "sh518880");
    assert_eq!(Code("159915".into()).prefixed().unwrap(), "sz159915");
}

#[test]
fn bar_quote_serde_roundtrip() {
    let b = bar("518880", 1, 30, SourceId::TencentIfzq, 8.9);
    let s = serde_json::to_string(&b).unwrap();
    let b2: Bar = serde_json::from_str(&s).unwrap();
    assert_eq!(b, b2);
    let q = Quote { code: Code("518880".into()), last: 8.9, prev_close: 8.8,
                    volume: 1000, amount: 8900.0,
                    data_ts: Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap(),
                    source: SourceId::TencentQt };
    let q2: Quote = serde_json::from_str(&serde_json::to_string(&q).unwrap()).unwrap();
    assert_eq!(q, q2);
}

#[test]
fn source_id_str_and_approx() {
    assert_eq!(SourceId::TencentIfzq.as_str(), "tencent_ifzq");
    assert_eq!(SourceId::Tushare.as_str(), "tushare");
    // 03 §6：降级模式近似 bar 以 *_approx 标记，与真实 bar 物理可区分
    assert_eq!(SourceId::TencentQtApprox.as_str(), "tencent_qt_approx");
    assert_eq!(SourceId::SinaHqApprox.as_str(), "sina_hq_approx");
    assert_eq!(SourceId::ThsCsApprox.as_str(), "ths_cs_approx");
    assert_eq!(SourceId::Push2delayApprox.as_str(), "push2delay_approx");
    assert_eq!(SourceId::ExchangeApprox.as_str(), "exchange_approx");
    assert!(!SourceId::TencentQt.is_approx());
    assert!(SourceId::TencentQtApprox.is_approx());
    assert_eq!(SourceId::TencentQt.approx(), Some(SourceId::TencentQtApprox));
    assert_eq!(SourceId::TencentQtApprox.base(), SourceId::TencentQt);
    // 非快照池源无近似形态
    assert_eq!(SourceId::TencentIfzq.approx(), None);
    assert_eq!(SourceId::Tushare.approx(), None);
}

#[test]
fn selector_duty_first_when_healthy() {
    let sel = SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]);
    let chain = sel.attempt_chain(SourceId::SinaJsonp,
                                  &[SourceId::TencentIfzq, SourceId::SinaJsonp]);
    assert_eq!(chain, vec![SourceId::SinaJsonp, SourceId::TencentIfzq],
               "当班源健康时链首恒为当班源，之后按注册序轮转");
}

#[test]
fn selector_excludes_unhealthy() {
    let sel = SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]);
    let chain = sel.attempt_chain(SourceId::TencentIfzq, &[SourceId::SinaJsonp]);
    assert_eq!(chain, vec![SourceId::SinaJsonp], "熔断源不出现在序列中");
}

#[test]
fn selector_empty_pool() {
    let sel = SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]);
    assert!(sel.attempt_chain(SourceId::TencentIfzq, &[]).is_empty(), "空池 → 空链");
}

#[test]
fn duty_roster_deterministic_and_alternates() {
    let r = DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]);
    assert_eq!(r.duty_at(0, 7), r.duty_at(0, 7), "同输入恒同输出");
    assert_eq!(r.duty_at(0, 7), SourceId::TencentIfzq);
    // 找到首次换班点 m：窗长必须落在 20-40min（ADR-015）
    let mut flip = None;
    for m in 1..=60u64 {
        if r.duty_at(m, 7) != r.duty_at(0, 7) { flip = Some(m); break; }
    }
    let m = flip.expect("60 分钟内必换班");
    assert!((20..=40).contains(&m), "窗长 {m} 应 ∈ [20,40]");
    assert_eq!(r.duty_at(m, 7), SourceId::SinaJsonp, "两源交替当班");
    assert_eq!(r.duty_at(2 * m, 7), SourceId::TencentIfzq, "再交替回切");
}

#[test]
fn merge_prefers_accurate_and_fills_and_keeps_accurate_only() {
    let raw = vec![bar("518880", 1, 30, SourceId::TencentIfzq, 1.0),
                   bar("518880", 1, 31, SourceId::TencentIfzq, 2.0)];
    let acc = vec![bar("518880", 1, 31, SourceId::Tushare, 99.0),
                   bar("518880", 1, 32, SourceId::Tushare, 3.0)];
    let out = merge_prefer_accurate(raw, acc);
    assert_eq!(out.len(), 3);
    assert_eq!(out[0].close, 1.0, "raw 补缺");
    assert_eq!(out[1].close, 99.0, "accurate 优先");
    assert_eq!(out[1].source, SourceId::Tushare);
    assert_eq!(out[2].close, 3.0, "仅 accurate 有的时点保留");
    // 排序：按 (code, ts) 升序
    assert!(out.windows(2).all(|w| w[0].ts < w[1].ts));
}

#[test]
fn provider_error_classification() {
    // 01-providers-spec §4 统一口径
    assert_eq!(ProviderError::RateLimited.to_string(), "rate limited (403/429)");
    assert_eq!(ProviderError::Timeout.to_string(), "timeout");
    assert!(ProviderError::Http("x".into()).to_string().starts_with("http: "));
    assert!(ProviderError::Parse("x".into()).to_string().starts_with("parse: "));
    assert!(ProviderError::NoData.to_string().contains("no data"));
}

#[test]
fn err_kind_str_table() {
    // 03 §7 事件模型 err_kind 列口径
    use domain::ports::ErrKind;
    assert_eq!(ErrKind::Na.as_str(), "na");
    assert_eq!(ErrKind::Timeout.as_str(), "timeout");
    assert_eq!(ErrKind::Http.as_str(), "http");
    assert_eq!(ErrKind::Parse.as_str(), "parse");
    assert_eq!(ErrKind::RateLimited.as_str(), "rate_limited");
    assert_eq!(ErrKind::CircuitOpen.as_str(), "circuit_open");
    assert_eq!(ErrKind::CircuitHalfopen.as_str(), "circuit_halfopen");
    assert_eq!(ErrKind::CircuitClosed.as_str(), "circuit_closed");
    assert_eq!(ErrKind::ManualReset.as_str(), "manual_reset");
    assert_eq!(ErrKind::AllFailed.as_str(), "all_failed");
}

#[test]
fn trace_id_format() {
    let a = new_trace_id();
    let b = new_trace_id();
    assert_eq!(a.len(), 32, "32 位 hex（rand 生成，父级裁决：不引 uuid 依赖）");
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b, "两次生成应不同");
}

#[test]
fn source_id_parse_roundtrip_and_unknown() {
    // Phase C 加法：parse 为 as_str 的逆（含 *_approx 全变体）
    for s in [
        SourceId::TencentIfzq, SourceId::SinaJsonp, SourceId::TencentQt, SourceId::SinaHq,
        SourceId::ThsCs, SourceId::Push2delay, SourceId::Exchange, SourceId::Tushare,
        SourceId::TencentQtApprox, SourceId::SinaHqApprox, SourceId::ThsCsApprox,
        SourceId::Push2delayApprox, SourceId::ExchangeApprox,
    ] {
        assert_eq!(SourceId::parse(s.as_str()), Some(s), "{} 应往返一致", s.as_str());
    }
    assert_eq!(SourceId::parse("nonexistent_src"), None, "未知源 → None（消费端跳过不 panic）");
    assert_eq!(SourceId::parse(""), None);
}

#[test]
fn run_status_str_and_parse() {
    assert_eq!(RunStatus::Pending.as_str(), "pending");
    assert_eq!(RunStatus::Running.as_str(), "running");
    assert_eq!(RunStatus::Done.as_str(), "done");
    assert_eq!(RunStatus::Failed.as_str(), "failed");
    for s in ["pending", "running", "done", "failed"] {
        assert_eq!(RunStatus::parse(s).unwrap().as_str(), s, "{s} 应往返一致");
    }
    assert_eq!(RunStatus::parse("unknown"), None, "未知状态 → None（消费端跳过不 panic）");
    // serde snake_case：DB status 文本 ↔ 枚举（ADR 08-backtest §7 status 口径）
    assert_eq!(serde_json::from_str::<RunStatus>("\"failed\"").unwrap(), RunStatus::Failed);
    assert_eq!(serde_json::to_string(&RunStatus::Pending).unwrap(), "\"pending\"");
}

#[test]
fn backtest_run_types_serde_roundtrip() {
    let run = NewRun {
        code: "518880".into(), period: "D1".into(), strategy_id: "dual_ma".into(),
        params: serde_json::json!({"fast": 5, "slow": 20}),
        fee: serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0}),
        group_id: Some("g1".into()),
    };
    let j = serde_json::to_string(&run).unwrap();
    let back: NewRun = serde_json::from_str(&j).unwrap();
    assert_eq!(run, back);

    let t0 = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap();
    let view = RunView {
        id: 1, code: "518880".into(), period: "D1".into(), strategy_id: "dual_ma".into(),
        params: serde_json::json!({}), fee: serde_json::json!({}),
        status: RunStatus::Done, progress: 100, current_ts: Some(t0),
        created_at: t0, finished_at: Some(t0), error: None, group_id: None,
        result: Some(RunResult { net_value: serde_json::json!([t0, 1.0]),
            trades: serde_json::json!([]), metrics: serde_json::json!({"net_profit": 1.0}) }),
    };
    let vj = serde_json::to_string(&view).unwrap();
    let vback: RunView = serde_json::from_str(&vj).unwrap();
    assert_eq!(view, vback);
}

#[test]
fn run_filter_defaults() {
    let f = RunFilter::default();
    assert!(f.status.is_none() && f.group_id.is_none(), "全 None = 全量");
}
// ~/~ end
