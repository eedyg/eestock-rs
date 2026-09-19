//! ADR-027 S 段：`design/17-trade-detail-layering/contract-vectors.json` **跨侧共享向量**验收。
//!
//! 判据（03-test-plan.md §4）：**回测侧聚合**（`backtest::assign_rt_seq` + `backtest::aggregate_round_trips`
//! —— strategy-core 引擎所用的同一对函数，见 `strategy-core/src/engine.rs`）与
//! **sim-live 侧聚合**（`SimLiveService::round_trips` 经 `sim_trades` 行 → `FillFact` 账本的真实读路径）
//! 对**同一向量**产出：
//!   1. 逐笔 `rt_seq` 分配与 `expected_fill_rt_seq` **整数相等**；
//!   2. 每个回合逐字段（含 `pnl`/`open_price`/`close_price`/`hold_bars`/`l2_count`…）与
//!      `expected_round_trips` **值相等（浮点逐位：`serde_json::Value` 数值 `==`）**；
//!   3. 两侧序列化 JSON 字符串**逐字节相等**（最强跨侧一致性判据）；
//!   4. 逐笔 L2 明细逐字段等于 `expected_l2`。
//!
//! 卫生：纯函数 + 只读仓库内 JSON + mock 端口（**无 DB / 无网络 / 无时钟依赖**）。
//! 向量期望值由 `tester/evidence/20260920_adr027_accept/gen_contract_vectors.py`（独立 Python oracle
//! 按 02-spec §2 公式 op 顺序计算）生成 —— 本测试**不**从实现反推期望值。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use domain::ports::{
    NewSimSession, NewSimTrade, SimPositionRow, SimSessionResult, SimSessionState, SimSessionStatus,
    SimSessionStore, SimSessionView,
};
use domain::ports::Clock;

use application::simlive::SimLiveService;
use backtest::{aggregate_round_trips, assign_rt_seq, FeeModel, FillFact, FillReason, OrderSide};
use serde_json::Value;

// ── 夹具：只实现读路径所需方法的 mock 端口 ──

struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[derive(Default)]
struct VectorStore {
    session: Mutex<Option<SimSessionView>>,
    trades: Mutex<Vec<NewSimTrade>>,
}

#[async_trait]
impl SimSessionStore for VectorStore {
    async fn create_session(&self, _s: &NewSimSession) -> anyhow::Result<()> {
        unimplemented!("本测试只走读路径")
    }
    async fn get_session(&self, id: &str) -> anyhow::Result<Option<SimSessionView>> {
        let g = self.session.lock().unwrap();
        Ok(g.as_ref().filter(|v| v.id == id).cloned())
    }
    async fn list_sessions(&self) -> anyhow::Result<Vec<SimSessionView>> {
        Ok(self.session.lock().unwrap().iter().cloned().collect())
    }
    async fn append_trade(&self, _t: &NewSimTrade) -> anyhow::Result<()> {
        unimplemented!("本测试只走读路径")
    }
    async fn list_trades(&self, session_id: &str) -> anyhow::Result<Vec<NewSimTrade>> {
        Ok(self
            .trades
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect())
    }
    async fn update_positions(
        &self,
        _session_id: &str,
        _positions: &[SimPositionRow],
    ) -> anyhow::Result<()> {
        unimplemented!()
    }
    async fn upsert_state(&self, _session_id: &str, _state: &SimSessionState) -> anyhow::Result<()> {
        unimplemented!()
    }
    async fn get_state(&self, _session_id: &str) -> anyhow::Result<Option<SimSessionState>> {
        Ok(None)
    }
    async fn mark_end(
        &self,
        _session_id: &str,
        _end_ts: DateTime<Utc>,
        _result: &SimSessionResult,
    ) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn get_result(&self, _session_id: &str) -> anyhow::Result<Option<SimSessionResult>> {
        Ok(None)
    }
    async fn delete_session(&self, _session_id: &str) -> anyhow::Result<bool> {
        unimplemented!()
    }
}

fn vectors() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../design/17-trade-detail-layering/contract-vectors.json");
    let raw = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("契约向量文件不可读 {}：{e}", p.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("契约向量文件 JSON 解析失败 {}：{e}", p.display()))
}

fn side_of(s: &str) -> OrderSide {
    match s {
        "Buy" => OrderSide::Buy,
        "Sell" => OrderSide::Sell,
        other => panic!("未知 side：{other}"),
    }
}

fn reason_of(s: &str) -> FillReason {
    FillReason::parse(s).unwrap_or_else(|| panic!("未知 reason：{s}"))
}

/// 向量 `fills[i]` → 回测侧 `FillFact`（`rt_seq = 0` 占位，由 `assign_rt_seq` 统一分配）。
fn backtest_facts(v: &Value) -> Vec<FillFact> {
    v["fills"]
        .as_array()
        .expect("fills 数组")
        .iter()
        .map(|f| FillFact {
            rt_seq: 0,
            code: f["code"].as_str().unwrap().to_string(),
            bar_index: f["bar_index"].as_u64().unwrap() as usize,
            ts: f["ts"].as_i64().unwrap(),
            side: side_of(f["side"].as_str().unwrap()),
            qty: f["qty"].as_f64().unwrap(),
            price: f["price"].as_f64().unwrap(),
            trade_value: f["trade_value"].as_f64().unwrap(),
            commission: f["commission"].as_f64().unwrap(),
            stamp_duty: f["stamp_duty"].as_f64().unwrap(),
            reason: reason_of(f["reason"].as_str().unwrap()),
        })
        .collect()
}

/// 向量 `fills[i]` → sim-live 侧 `sim_trades` 行（事实三件套直接取自向量，**禁止复算**）。
fn sim_rows(v: &Value, session_id: &str) -> (Arc<VectorStore>, Vec<NewSimTrade>) {
    let start_ts = v["session_start_ts"].as_i64().unwrap();
    let code = v["code"].as_str().unwrap().to_string();
    let view = SimSessionView {
        id: session_id.to_string(),
        name: "vectors".into(),
        cash_init: 1_000_000.0,
        strategy_set: vec![],
        stock_set: vec![code.clone()],
        period: "M1".into(),
        start_ts: Utc.timestamp_opt(start_ts, 0).unwrap(),
        end_ts: None,
        status: SimSessionStatus::Running,
        source: "test".into(),
    };
    let rows: Vec<NewSimTrade> = v["fills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let comm = f["commission"].as_f64().unwrap();
            let stamp = f["stamp_duty"].as_f64().unwrap();
            let reason = f["reason"].as_str().unwrap();
            let source = match reason {
                "Policy" => "strategy",
                "Manual" => "manual",
                "ForceClose" | "StopTrigger" => {
                    panic!("sim-live 无期末强平/止损来源语义（02-spec §1.1），向量不得含 {reason}")
                }
                other => panic!("未知 reason：{other}"),
            };
            NewSimTrade {
                session_id: session_id.to_string(),
                code: f["code"].as_str().unwrap().to_string(),
                side: f["side"].as_str().unwrap().to_lowercase(),
                qty: f["qty"].as_f64().unwrap(),
                price: f["price"].as_f64().unwrap(),
                ts: Utc.timestamp_opt(f["ts"].as_i64().unwrap(), 0).unwrap(),
                commission: comm,
                stamp_duty: stamp,
                fee: comm + stamp,
                source: source.to_string(),
            }
        })
        .collect();
    let store = Arc::new(VectorStore {
        session: Mutex::new(Some(view)),
        trades: Mutex::new(rows.clone()),
    });
    (store, rows)
}

fn sim_service(store: Arc<VectorStore>) -> SimLiveService {
    SimLiveService::new(
        store,
        Arc::new(FixedClock(Utc.timestamp_opt(1_700_000_000, 0).unwrap())),
        FeeModel::default(),
    )
}

/// `expected_round_trips` 的 JSON 对象 vs 实际 `TradeDetail` 序列化值 —— 数值**逐位**相等。
fn assert_rt_fields_exact(actual: &Value, expected: &Value, who: &str) {
    let a = actual.as_object().expect("实际回合是对象");
    let e = expected.as_object().expect("期望回合是对象");
    assert_eq!(a.len(), e.len(), "{who} 字段数不一致：{actual} vs {expected}");
    for (k, ev) in e {
        let av = a
            .get(k)
            .unwrap_or_else(|| panic!("{who} 缺字段 `{k}`；实际：{actual}"));
        assert!(
            av == ev,
            "{who} 字段 `{k}` 不一致（须逐位相等）：实际 {av}，期望 {ev}；完整实际：{actual}"
        );
    }
}

/// 逐向量：回测侧聚合 == 期望；sim-live 侧聚合 == 期望；两侧 JSON **逐字节相等**。
#[tokio::test]
async fn adr027_contract_vectors_cross_side_parity() {
    let doc = vectors();
    let vs = doc["vectors"].as_array().expect("vectors 数组");
    assert!(vs.len() >= 6, "S 段要求 ≥6 组向量，实际 {}", vs.len());

    let mut checked = 0usize;
    for (i, v) in vs.iter().enumerate() {
        let id = v["id"].as_str().unwrap();
        let session_id = format!("vectors-{i}");

        // ── 回测侧（strategy-core 引擎所用的同一对函数）──
        let mut bt_facts = backtest_facts(v);
        assign_rt_seq(&mut bt_facts);
        let exp_seq: Vec<u32> = v["expected_fill_rt_seq"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u32)
            .collect();
        let got_seq: Vec<u32> = bt_facts.iter().map(|f| f.rt_seq).collect();
        assert_eq!(got_seq, exp_seq, "[{id}] 回测侧逐笔 rt_seq 分配不符");
        let bt_rts = aggregate_round_trips(&bt_facts);
        let bt_json = serde_json::to_value(&bt_rts).unwrap();

        // ── sim-live 侧（真实读路径：sim_trades → FillFact → 唯一聚合实现）──
        let (store, _rows) = sim_rows(v, &session_id);
        let svc = sim_service(store);
        let sl_rts = svc
            .round_trips(&session_id)
            .await
            .unwrap_or_else(|e| panic!("[{id}] sim-live round_trips 失败：{e}"));
        let sl_json = serde_json::to_value(&sl_rts).unwrap();

        // 判据 1：两侧逐笔 rt_seq 相同（sim 侧经 store 重建）
        let sl_facts = svc
            .round_trip_fills(&session_id, v["code"].as_str().unwrap(), exp_seq[0])
            .await
            .unwrap()
            .expect("首回合切片存在");
        assert_eq!(
            sl_facts.iter().map(|f| f.rt_seq).collect::<Vec<_>>(),
            exp_seq.iter().copied().filter(|s| *s == exp_seq[0]).collect::<Vec<_>>(),
            "[{id}] sim-live 首回合切片逐笔 rt_seq 不符"
        );

        // 判据 2：逐字段等于向量期望（浮点逐位）
        let exp_rts = v["expected_round_trips"].as_array().unwrap();
        assert_eq!(bt_json.as_array().unwrap().len(), exp_rts.len(), "[{id}] 回测侧回合数不符");
        assert_eq!(sl_json.as_array().unwrap().len(), exp_rts.len(), "[{id}] sim-live 回合数不符");
        for (k, e) in exp_rts.iter().enumerate() {
            assert_rt_fields_exact(&bt_json[k], e, &format!("[{id}] 回测侧回合#{k}"));
            assert_rt_fields_exact(&sl_json[k], e, &format!("[{id}] sim-live 侧回合#{k}"));
        }

        // 判据 3：两侧序列化表**逐字节相等**（最强一致性判据）
        let bt_str = serde_json::to_string(&bt_rts).unwrap();
        let sl_str = serde_json::to_string(&sl_rts).unwrap();
        assert_eq!(
            bt_str, sl_str,
            "[{id}] 跨侧逐字节不一致（回测聚合 vs sim-live 聚合）"
        );

        // 判据 4：逐笔 L2 明细字段级相等
        let exp_l2 = v["expected_l2"].as_array().unwrap();
        assert_eq!(bt_facts.len(), exp_l2.len(), "[{id}] L2 笔数不符");
        for (k, e) in exp_l2.iter().enumerate() {
            let f = &bt_facts[k];
            let got = serde_json::json!({
                "rt_seq": f.rt_seq,
                "code": f.code,
                "bar_index": f.bar_index,
                "ts": f.ts,
                "side": f.side,
                "qty": f.qty,
                "price": f.price,
                "trade_value": f.trade_value,
                "commission": f.commission,
                "stamp_duty": f.stamp_duty,
                "reason": f.reason.as_str(),
            });
            for key in [
                "rt_seq",
                "code",
                "bar_index",
                "ts",
                "side",
                "qty",
                "price",
                "trade_value",
                "commission",
                "stamp_duty",
                "reason",
            ] {
                assert!(
                    got[key] == e[key],
                    "[{id}] L2#{k} 字段 `{key}` 不符：实际 {}，期望 {}",
                    got[key],
                    e[key]
                );
            }
        }
        checked += 1;
    }
    assert_eq!(checked, vs.len());
}

/// 跨侧判据的**单侧独立复算**：sim-live 侧 `round_trip_fills` 的 L2 元素必须逐字段等于向量期望
/// （不只回测侧；防止只验一侧）。
#[tokio::test]
async fn adr027_contract_vectors_sim_live_l2_matches_vector() {
    let doc = vectors();
    for (i, v) in doc["vectors"].as_array().unwrap().iter().enumerate() {
        let id = v["id"].as_str().unwrap();
        let session_id = format!("vectors-l2-{i}");
        let (store, _) = sim_rows(v, &session_id);
        let svc = sim_service(store);
        let exp_l2 = v["expected_l2"].as_array().unwrap();
        // 按 expected_l2 的 (rt_seq) 分组逐回合取切片
        let mut seen: Vec<u32> = vec![];
        for e in exp_l2 {
            let rt = e["rt_seq"].as_u64().unwrap() as u32;
            if seen.contains(&rt) {
                continue;
            }
            seen.push(rt);
            let slice = svc
                .round_trip_fills(&session_id, v["code"].as_str().unwrap(), rt)
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("[{id}] sim-live 切片 rt_seq={rt} 缺失"));
            let want: Vec<&Value> = exp_l2
                .iter()
                .filter(|x| x["rt_seq"].as_u64().unwrap() as u32 == rt)
                .collect();
            assert_eq!(slice.len(), want.len(), "[{id}] rt_seq={rt} 切片笔数不符");
            for (k, w) in want.iter().enumerate() {
                let f = &slice[k];
                assert_eq!(f.ts, w["ts"].as_i64().unwrap(), "[{id}] rt_seq={rt} L2#{k} ts");
                assert_eq!(f.bar_index, w["bar_index"].as_u64().unwrap() as usize);
                assert_eq!(f.qty, w["qty"].as_f64().unwrap());
                assert_eq!(f.price, w["price"].as_f64().unwrap());
                assert_eq!(f.trade_value, w["trade_value"].as_f64().unwrap());
                assert_eq!(f.commission, w["commission"].as_f64().unwrap());
                assert_eq!(f.stamp_duty, w["stamp_duty"].as_f64().unwrap());
                assert_eq!(f.side, side_of(w["side"].as_str().unwrap()));
                assert_eq!(f.reason, reason_of(w["reason"].as_str().unwrap()));
            }
        }
        // sim 侧未知 rt_seq ⇒ None（禁空数组冒充；D8）
        let missing = svc
            .round_trip_fills(&session_id, v["code"].as_str().unwrap(), 9999)
            .await
            .unwrap();
        assert!(missing.is_none(), "[{id}] 未知 rt_seq 必须为 None");
    }
}
