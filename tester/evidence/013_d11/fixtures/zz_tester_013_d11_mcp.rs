//! [TESTER 临时独立验收夹具 — 013 批 D11 独立验收，不提交，不属于实现]
//!
//! 独立验收 D11（标的类型元数据 + 按类型推断费率，ADR-019）**MCP 通道**：
//!   A. list_symbols 回显 `type`（D11-1/D11-5）
//!   B. strategy_test_run 三层解析：①省略 fee→profile ②显式 fee→explicit（stamp 缺省仍 0.05）
//!      ③type=NULL / 未注册 → default
//!   C. bt_run_ensemble 省略 fee → 钉住 config.fee（source=profile）
//!   D. 真实 SSE 链路（server::build_router）复验 B①（传输层证明）
//!
//! 目标库由 DATABASE_URL 指定（本批用**隔离探针库** eestock_d11_probe，生产库零写入）。
//! 用法：
//!   DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/eestock_d11_probe \
//!   EV_DIR=<abs> cargo test -p mcp --test zz_tester_013_d11_mcp -- --nocapture --test-threads=1

use chrono::Utc;
use mcp::state::{McpState, SessionRegistry};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;

const ETF: &str = "510050"; // 已注册 etf（探针库由生产库只读拷入）
const NULLTYPE: &str = "999999"; // 探针库内：有真实 K 线但**未注册**（用于三级 default 与 type=NULL 实测）
/// 恒高分策略：首 bar 建仓、期末平仓 → 产生卖出成交（印花税口径可观测）。
const CONST_BUY: &str = "function on_bar(ctx) { return 100; }";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock_d11_probe".into());
    PgPool::connect(&url).await.expect("探针库可连")
}

fn ev_dir() -> String {
    std::env::var("EV_DIR").unwrap_or_else(|_| "/tmp".into())
}

fn dump(name: &str, v: &Value) {
    let p = format!("{}/{}", ev_dir(), name);
    std::fs::write(&p, serde_json::to_string_pretty(v).unwrap()).unwrap();
    println!("EV file {p}");
}

struct NoopProgress;
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for NoopProgress {
    async fn send(&self, _r: &str, _p: f64, _b: Option<chrono::DateTime<Utc>>) -> anyhow::Result<()> {
        Ok(())
    }
}

/// 生产装配**同构**（app bin 两处 `with_fee_profiles` 的 MCP 侧镜像）。
fn state(pool: PgPool) -> Arc<McpState> {
    let strategy_store = Arc::new(storage::strategy::PgStrategyStore::new(pool.clone()));
    let strategies = Arc::new(
        application::strategy::StrategyService::new(
            strategy_store.clone(),
            Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        )
        .with_fee_profiles(Arc::new(storage::fee_profile::PgFeeProfileStore::new(pool.clone()))),
    );
    let workbench = Arc::new(
        application::workbench::WorkbenchService::new(
            Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
            Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
            Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
            strategy_store.clone(),
            Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
            Arc::new(NoopProgress),
            Arc::new(domain::ports::SystemClock),
            application::workbench::DEFAULT_MAX_CONCURRENT,
        )
        .with_fee_profiles(Arc::new(storage::fee_profile::PgFeeProfileStore::new(pool.clone()))),
    );
    Arc::new(McpState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(Arc::new(
            storage::reader::HealthEventReader::new(pool.clone()),
        )),
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        default_window_secs: 3600,
        sessions: SessionRegistry::default(),
        sim: None,
        strategies: Some(strategies),
        workbench: Some(workbench),
        strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    })
}

async fn call(st: &McpState, name: &str, args: Value) -> Value {
    mcp::rpc::dispatch(
        st,
        &mcp::rpc::RpcRequest {
            jsonrpc: Some("2.0".into()),
            id: Some(json!(7)),
            method: "tools/call".into(),
            params: Some(json!({ "name": name, "arguments": args })),
        },
    )
    .await
    .expect("tools/call 有响应")
}

fn payload(resp: &Value) -> Value {
    assert_ne!(resp["result"]["isError"], json!(true), "工具应成功：{resp}");
    let t = resp["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("无 content 文本：{resp}"));
    serde_json::from_str(t).unwrap_or_else(|e| panic!("payload 非 JSON ({e})：{t}"))
}

fn sum(a: &Value, key: &str) -> f64 {
    a.as_array()
        .map(|xs| xs.iter().map(|t| t[key].as_f64().unwrap_or(0.0)).sum())
        .unwrap_or(f64::NAN)
}

fn test_run_args(symbol: &str, fee: Option<Value>) -> Value {
    let mut a = json!({
        "code": CONST_BUY, "symbol": symbol, "period": "D1",
        "from": "2026-06-15T00:00:00Z", "to": "2026-09-11T00:00:00Z",
        "mode": "sim_position", "warmup_bars": 0,
        "policy": { "LumpSum": { "position_pct": 1.0 } }, "capital": 100000.0,
    });
    if let Some(f) = fee {
        a["fee"] = f;
    }
    a
}

/// SSE 客户端（同 010 批夹具）：真链路 tools/call。
async fn sse_call(st: Arc<McpState>, name: &str, args: Value) -> Value {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, mcp::server::build_router(st)).await.unwrap();
    });
    let base = format!("http://{addr}");
    let mut resp = reqwest::get(format!("{base}/sse")).await.unwrap();
    assert_eq!(resp.status(), 200);
    let mut buf = String::new();
    // 帧切分：取走 endpoint 帧（消费，避免重复命中）
    let endpoint = loop {
        let chunk = resp.chunk().await.unwrap().expect("SSE 首帧");
        buf.push_str(&String::from_utf8_lossy(&chunk));
        if let Some(pos) = buf.find("\n\n") {
            let frame = buf[..pos].to_string();
            buf = buf[pos + 2..].to_string();
            if let Some(d) = frame.lines().find_map(|l| l.strip_prefix("data: ")) {
                break d.to_string();
            }
        }
    };
    assert!(endpoint.starts_with("/messages?sessionId="), "endpoint 帧: {endpoint}");
    let http = reqwest::Client::new();
    let r = http
        .post(format!("{base}{endpoint}"))
        .json(&json!({ "jsonrpc": "2.0", "id": 11, "method": "tools/call",
                       "params": { "name": name, "arguments": args } }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    let frame = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            if let Some(pos) = buf.find("\n\n") {
                let f = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                if let Some(d) = f.lines().find_map(|l| l.strip_prefix("data: ")) {
                    return d.to_string();
                }
                continue;
            }
            let chunk = resp.chunk().await.unwrap().expect("SSE 帧");
            buf.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await
    .expect("SSE 响应超时");
    serde_json::from_str(&frame).unwrap()
}

/// 探针库只读校验：确认目标不是生产库（防误跑污染生产）。
async fn assert_probe_db(pool: &PgPool) {
    let probe: Option<bool> = sqlx::query_scalar("SELECT true")
        .fetch_optional(pool)
        .await
        .unwrap();
    assert_eq!(probe, Some(true));
    let has_nulltype_kline: i64 =
        sqlx::query_scalar("SELECT count(*) FROM kline_accurate WHERE code = $1")
            .bind(NULLTYPE)
            .fetch_one(pool)
            .await
            .unwrap();
    assert!(
        has_nulltype_kline > 0,
        "本夹具要求隔离探针库（含 {NULLTYPE} 造数 K 线）；请以 DATABASE_URL 指向 eestock_d11_probe"
    );
}

#[tokio::test]
async fn zz_tester_013_d11_mcp() {
    let pool = pool().await;
    assert_probe_db(&pool).await;
    let st: Arc<McpState> = state(pool.clone());

    // ═══ A. list_symbols 回显 type（D11-1/D11-5）═══
    let ls = payload(&call(&st, "list_symbols", json!({})).await);
    let rows = ls["symbols"].as_array().expect("symbols 数组");
    let etf = rows.iter().filter(|r| r["type"] == json!("etf")).count();
    let lof = rows.iter().filter(|r| r["type"] == json!("lof")).count();
    let nulls = rows.iter().filter(|r| r["type"].is_null()).count();
    println!("EV A.list_symbols rows={} etf={} lof={} null={}", rows.len(), etf, lof, nulls);
    assert_eq!((rows.len(), etf, lof, nulls), (44, 42, 2, 0), "list_symbols 应回显 type 且与库一致");
    let r510050 = rows.iter().find(|r| r["code"] == json!(ETF)).expect("510050 在注册表");
    assert_eq!(r510050["type"], json!("etf"));
    assert!(r510050.as_object().unwrap().contains_key("type"), "字段名须为 type");
    dump("mcp_A_list_symbols.json", &json!({
        "rows": rows.len(), "etf": etf, "lof": lof, "null": nulls,
        "sample_510050": r510050,
    }));

    // ═══ B①. strategy_test_run 省略 fee → profile（ETF：印花税 0 / 过户费 0 / 规费列 0）═══
    let p1 = payload(&call(&st, "strategy_test_run", test_run_args(ETF, None)).await);
    println!("EV B1.profile fee={}", p1["fee"]);
    let f = &p1["fee"];
    assert_eq!(f["source"], json!("profile"), "省略 fee → source=profile");
    assert_eq!(f["symbol_type"], json!("etf"));
    assert_eq!(f["rate_pct"], json!(0.025));
    assert_eq!(f["min_fee"], json!(5.0));
    assert_eq!(f["slippage_bp"], json!(2.0), "滑点非费率事实 → ADR bt-1 默认 2bp");
    assert_eq!(f["stamp_duty_pct"], json!(0.0), "ETF 印花税不征 → 0");
    assert_eq!(f["profile"]["transfer_fee_pct"], json!(0.0), "ETF 过户费免收 → 0");
    assert_eq!(f["profile"]["exchange_fee_pct"], json!(0.0), "全佣口径：经手费列 0（不叠加）");
    assert_eq!(f["profile"]["regulatory_fee_pct"], json!(0.0), "证管费列 0");
    assert!(f["profile"]["note"].as_str().unwrap().contains("全佣"), "note 须写明全佣口径");
    assert!(f["profile"]["source"].as_str().unwrap().contains("ADR-019"));
    let stamp1 = sum(&p1["trades"], "stamp_duty");
    assert_eq!(stamp1, 0.0, "ETF profile 口径成交印花税合计=0");
    println!("EV B1.trades n={} stamp_sum={} pnl={} bars={}",
        p1["trades"].as_array().unwrap().len(), stamp1, sum(&p1["trades"], "pnl"), p1["bar_count"]);
    dump("mcp_B1_profile_test_run.json", &p1);

    // ═══ B②. 显式 fee → explicit（缺 stamp 仍 0.05，旧行为完全可复现）═══
    let explicit = json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 });
    let p2 = payload(&call(&st, "strategy_test_run", test_run_args(ETF, Some(explicit))).await);
    println!("EV B2.explicit fee={}", p2["fee"]);
    assert_eq!(p2["fee"]["source"], json!("explicit"));
    assert_eq!(p2["fee"]["stamp_duty_pct"], json!(0.05), "显式缺 stamp → 旧默认 0.05");
    let stamp2 = sum(&p2["trades"], "stamp_duty");
    assert!(stamp2 > 0.0, "旧口径下 ETF 仍被收印花税（={stamp2}）");
    println!("EV B2.trades n={} stamp_sum={} pnl={}",
        p2["trades"].as_array().unwrap().len(), stamp2, sum(&p2["trades"], "pnl"));
    dump("mcp_B2_explicit_test_run.json", &p2);

    // 显式 stamp=0 → 以显式 0 为准（用户可显式复现 ETF 口径，不依赖 type）
    let explicit0 = json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0 });
    let p3 = payload(&call(&st, "strategy_test_run", test_run_args(ETF, Some(explicit0))).await);
    assert_eq!(p3["fee"]["source"], json!("explicit"));
    assert_eq!(p3["fee"]["stamp_duty_pct"], json!(0.0));
    println!("EV B2b.explicit0 fee={}", p3["fee"]);

    // ═══ B③-a. MCP 层注册表门禁（I-1/D9）——未注册标的一律拒绝（不受 D11 影响）═══
    let unreg = call(&st, "strategy_test_run", test_run_args(NULLTYPE, None)).await;
    println!("EV B3a.unregistered_gated isError={} text={}",
        unreg["result"]["isError"], unreg["result"]["content"][0]["text"]);
    assert_eq!(unreg["result"]["isError"], json!(true), "未注册标的仍被 MCP 注册表门禁拒绝（D9 未回归）");
    assert!(unreg["result"]["content"][0]["text"].as_str().unwrap().contains("未注册"));

    // ═══ B③-b. **type 字面 NULL** 的已注册标的（探针库内临时造标的后清理）→ default ═══
    sqlx::query(
        "INSERT INTO symbols (code, name, interval_secs, settlement, enabled) \
         VALUES ($1, 'TESTER013', 60, 'T1', false) ON CONFLICT (code) DO NOTHING",
    )
    .bind(NULLTYPE)
    .execute(&pool)
    .await
    .unwrap();
    let ty: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
        .bind(NULLTYPE)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ty, None, "新建标的未传 type → NULL（无默认值，A2 要求）");
    let p5 = payload(&call(&st, "strategy_test_run", test_run_args(NULLTYPE, None)).await);
    println!("EV B3b.type_null fee={}", p5["fee"]);
    assert_eq!(p5["fee"]["source"], json!("default"), "type IS NULL → default（不借用他类型档案）");
    assert!(p5["fee"]["symbol_type"].is_null());
    assert_eq!(p5["fee"]["stamp_duty_pct"], json!(0.05));
    dump("mcp_B3b_type_null_default.json", &p5);

    // ═══ B③-c. 已注册 + 类型合法但**无档案行**（D11-6 保留位 bond_etf）→ 同为 default ═══
    sqlx::query("UPDATE symbols SET type = 'bond_etf' WHERE code = $1")
        .bind(NULLTYPE).execute(&pool).await.unwrap();
    let p5b = payload(&call(&st, "strategy_test_run", test_run_args(NULLTYPE, None)).await);
    println!("EV B3c.no_profile_row fee={}", p5b["fee"]);
    assert_eq!(p5b["fee"]["source"], json!("default"), "类型无档案行 → default（不借用他类型档案）");
    assert_eq!(p5b["fee"]["stamp_duty_pct"], json!(0.05));
    dump("mcp_B3c_no_profile_row_default.json", &p5b);

    // 对照：把同一标的 type 置为 etf → 同一请求立刻变 profile（证明解析链真的按 type 走）
    sqlx::query("UPDATE symbols SET type = 'etf' WHERE code = $1")
        .bind(NULLTYPE)
        .execute(&pool)
        .await
        .unwrap();
    let p6 = payload(&call(&st, "strategy_test_run", test_run_args(NULLTYPE, None)).await);
    println!("EV B3d.type_etf fee={}", p6["fee"]);
    assert_eq!(p6["fee"]["source"], json!("profile"));
    assert_eq!(p6["fee"]["stamp_duty_pct"], json!(0.0));
    // 清理测试标的（探针库）
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(NULLTYPE).execute(&pool).await.unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM symbols WHERE code = $1")
        .bind(NULLTYPE).fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0, "测试标的须清理干净");
    println!("EV B3d.cleanup left={left}");

    // ═══ D. 真实 SSE 链路复验 B①（传输层证明）═══
    let sse = sse_call(st.clone(), "strategy_test_run", test_run_args(ETF, None)).await;
    let ps = payload(&sse);
    assert_eq!(ps["fee"]["source"], json!("profile"), "SSE 真链路同结果");
    assert_eq!(ps["fee"]["stamp_duty_pct"], json!(0.0));
    println!("EV D.sse fee={}", ps["fee"]);

    // ═══ C. bt_run_ensemble 省略 fee → 钉住 config.fee（source=profile）═══
    let created = payload(&call(&st, "strategy_create",
        json!({ "name": "TESTER013-D11", "code": CONST_BUY })).await);
    let vid = created["version"]["id"].as_str().expect("create 回 version.id").to_string();
    let sid = created["strategy"]["id"].as_str().unwrap_or("").to_string();
    let pubr = payload(&call(&st, "strategy_publish", json!({ "version_id": vid })).await);
    println!("EV C.publish sid={sid} vid={vid} status={}", pubr["status"]);
    assert_eq!(pubr["status"], json!("published"), "夹具策略须发布成功");
    let bt = payload(&call(&st, "bt_run_ensemble", json!({
        "name": "tester013-d11", "symbol": ETF, "period": "D1",
        "from": "2026-06-15T00:00:00Z", "to": "2026-09-11T00:00:00Z",
        "slots": [{ "strategy_id": sid, "version_id": vid, "params": {}, "weight": 1.0 }],
        "policy": { "LumpSum": { "position_pct": 1.0 } }, "warmup_bars": 0,
    })).await);
    println!("EV C.bt_run_ensemble config.fee={}", bt["run"]["config"]["fee"]);
    assert_eq!(bt["run"]["config"]["fee"]["source"], json!("profile"), "工作台省略 fee → profile");
    assert_eq!(bt["run"]["config"]["fee"]["stamp_duty_pct"], json!(0.0));
    assert_eq!(bt["run"]["config"]["fee"]["symbol_type"], json!("etf"));
    dump("mcp_C_bt_run_ensemble.json", &bt);

    // 清理：策略 + 运行（探针库）
    let run_id = bt["run"]["id"].as_str().unwrap().to_string();
    let mut final_status = String::new();
    for _ in 0..60 {
        let g = payload(&call(&st, "bt_get_run", json!({ "run_id": run_id })).await);
        final_status = g["status"].as_str().unwrap_or_else(|| g["run"]["status"].as_str().unwrap_or("")).to_string();
        if matches!(final_status.as_str(), "done" | "succeeded" | "failed" | "cancelled") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    println!("EV C.run_id={run_id} final_status={final_status}");

    println!("EV DONE mcp 通道验收完成");
}
