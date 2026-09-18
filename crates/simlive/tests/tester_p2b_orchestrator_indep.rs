//! [tester 独立验收 · ADR-024 P2b] sim-live 插件编排器路径（`simlive/src/plugin_orchestrator.rs`）
//! **独立**判别测试 —— 由 tester 自行设计，**不依赖** worker 交付的
//! `crates/simlive/tests/adr024_p2b_orchestrator.rs` 的任何断言。
//!
//! 目的（任务书 A2/A3/A4）：
//! 1. **宿主侧 `ctx.bars` 可见面**（探针 runtime，比 worker 探针**更强**：不止断言长度与
//!    `bars[index]==ctx.bar`，而是**逐元素**比对 `ctx.bars == 已喂入序列前缀**）；
//! 2. **持仓场景下 ctx.position 的逐字段复刻**：P2b 把 `bars_since_entry` 从「裸切片」改成
//!    `history.with_slice(|bars| …)`；本测用「建仓 → 加仓 → 部分卖出 → 清仓（硬止损离场）」
//!    四种持仓态，逐 bar 与**改造前公式**（`git show HEAD:crates/simlive/src/plugin_orchestrator.rs`）比对；
//! 3. **逐 bar 位级评分等价**：真实 QuickJS + 3 策略（不同权重）与「改造前口径复刻」
//!    （累计 `Vec<Bar>` + 每 bar `BarCtx::new(idx, bar, &accumulated, snapshot)`）比对，
//!    评分函数耦合 `index / bar / position / indicators` ⇒ 对 index 对齐、切片口径、持仓快照
//!    三者均敏感；
//! 4. **分配量双向**：新路径每 bar 常数；改造前调用形态（兼容路径）随 index 线性增长
//!    （证明度量有判别力）。
//!
//! 纪律：只读生产 API；独立测试二进制（自带计数分配器）。

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use backtest::{Bar, StrategyParams};
use simlive::{
    aggregate_to_signal, weighted_aggregate, PluginStrategyConfig, PluginStrategyOrchestrator,
    PositionInput,
};
use strategy_runtime::{
    BarCtx, ParamDef, PluginError, PluginInstance, PluginRuntime, PositionSnapshot, QuickJsRuntime,
    RuntimeLimits,
};

// ---------------------------------------------------------------------------
// 计数分配器
// ---------------------------------------------------------------------------

struct CountingAlloc;

static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/// 评分耦合 `index / bar / position（全部 5 字段）/ indicators`：
/// 任何 index 对齐、喂入序列、切片窗口或持仓快照的漂移都会改变位级结果。
const POSITION_ENCODING_PLUGIN: &str = r#"
function on_bar(ctx) {
  const ma = ctx.indicators.ma(5);
  const p = ctx.position;
  var tail = (ctx.index % 10) * 0.01 + (ctx.bar.ts % 97) * 0.0001;
  if (p === null) {
    tail = tail + 7.77;
  } else {
    tail = tail + p.qty * 0.0001 + p.bars_since_entry * 0.001 + p.unrealized_pnl * 0.00001
              + p.avg_cost * 0.01 + (p.entry_ts % 1000) * 0.0001;
  }
  if (ma === null) {
    return 20 + tail;
  }
  var raw = 50 + (ctx.bar.close - ma) * 3.0 + tail;
  if (raw > 100) { raw = 100; }
  if (raw < 0) { raw = 0; }
  return raw;
}
"#;

const CODE: &str = "AAA";

fn series(n: usize, step_secs: i64) -> Vec<Bar> {
    let mut state: u64 = 0xDEAD_BEEF_1234_5678;
    let mut close = 12.5_f64;
    (0..n)
        .map(|i| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let step = ((state >> 33) % 41) as f64 - 20.0;
            close = (close + step * 0.01).max(0.5);
            Bar {
                ts: 1_700_000_000 + i as i64 * step_secs,
                open: close - 0.05,
                high: close + 0.2,
                low: (close - 0.2).max(0.01),
                close,
                volume: 10_000.0 + (i % 7) as f64,
            }
        })
        .collect()
}

fn config(strategy_id: &str, weight: f64) -> PluginStrategyConfig {
    PluginStrategyConfig {
        strategy_id: strategy_id.into(),
        version_id: format!("sv_{strategy_id}"),
        version: 1,
        sha256: "sha256:tester-indep".into(),
        name: strategy_id.into(),
        code: POSITION_ENCODING_PLUGIN.into(),
        params: StrategyParams::new(),
        stocks: vec![CODE.into()],
        weight,
        stock_weights: HashMap::new(),
    }
}

/// 持仓脚本（模拟「建仓 → 加仓 → 部分卖出 → 硬止损离场」，含空仓段）：
/// 入场 ts 取 bars[10].ts（sticky-first-entry；部分卖出不前进）。
fn position_script(bars: &[Bar]) -> Vec<Option<PositionInput>> {
    bars.iter()
        .enumerate()
        .map(|(i, _b)| match i {
            0..=9 => None,
            10..=24 => Some(PositionInput { qty: 1_000.0, avg_cost: 12.9, entry_ts: bars[10].ts }),
            25..=34 => {
                // 加仓 1,000 股：加权成本摊薄（取一个确定性数值）
                Some(PositionInput { qty: 2_000.0, avg_cost: 12.95, entry_ts: bars[10].ts })
            }
            35..=44 => {
                // 部分卖出 500 股（sticky-first-entry：entry_ts 不前进）
                Some(PositionInput { qty: 500.0, avg_cost: 12.95, entry_ts: bars[10].ts })
            }
            45..=49 => None, // 硬止损离场（→ 空仓）
            50.. => Some(PositionInput { qty: 300.0, avg_cost: 13.4, entry_ts: bars[50].ts }),
        })
        .collect()
}

/// 改造前公式（逐字复刻 HEAD `evaluate` 的 snapshot 构造；`bars` = 累计序列 + 当前 idx）：
/// `bars_since_entry = idx - bars.partition_point(|b| b.ts < entry_ts)`；
/// `unrealized_pnl = qty × (bar.close − avg_cost)`。
fn prechange_snapshot(
    bars: &[Bar],
    idx: usize,
    p: PositionInput,
) -> PositionSnapshot {
    let entry_idx = bars.partition_point(|b| b.ts < p.entry_ts);
    PositionSnapshot {
        qty: p.qty,
        avg_cost: p.avg_cost,
        entry_ts: p.entry_ts,
        bars_since_entry: (idx.saturating_sub(entry_idx)) as u64,
        unrealized_pnl: p.qty * (bars[idx].close - p.avg_cost),
    }
}

// ---------------------------------------------------------------------------
// 判据 1：宿主侧 ctx.bars 可见面（探针 runtime；逐元素比对前缀）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
struct CtxRow {
    index: usize,
    bars_len: usize,
    /// `ctx.bars` 与「已喂入序列前缀」**逐元素**相等（比长度断言更强）。
    bars_eq_prefix: bool,
    ahead_visible: bool,
    cur_eq_ctx_bar: bool,
    shared_handle: bool,
    history_ptr: usize,
    position: Option<PositionSnapshot>,
}

struct ProbeInstance {
    rows: Rc<RefCell<Vec<CtxRow>>>,
}

impl PluginInstance for ProbeInstance {
    fn on_bar(&mut self, ctx: &BarCtx<'_>) -> Result<f64, PluginError> {
        let fed = FED.with(|f| f.borrow().clone());
        let prefix_ok = ctx.bars.len() == ctx.index + 1
            && ctx.bars.len() == fed.len()
            && ctx.bars.iter().zip(fed.iter()).all(|(a, b)| a == b);
        self.rows.borrow_mut().push(CtxRow {
            index: ctx.index,
            bars_len: ctx.bars.len(),
            bars_eq_prefix: prefix_ok,
            ahead_visible: ctx.bars.len() > ctx.index + 1,
            cur_eq_ctx_bar: ctx.bars.get(ctx.index).is_some_and(|b| *b == ctx.bar),
            shared_handle: ctx.shared_history().is_some(),
            history_ptr: ctx
                .shared_history()
                .map(|h| Rc::as_ptr(h) as usize)
                .unwrap_or(0),
            position: ctx.position,
        });
        Ok(50.0)
    }
    fn save(&self) -> Result<Option<serde_json::Value>, PluginError> {
        Ok(None)
    }
    fn load(&mut self, _state: &serde_json::Value) -> Result<(), PluginError> {
        Ok(())
    }
    fn params_schema(&self) -> &[ParamDef] {
        &[]
    }
}

thread_local! {
    /// 探针进度镜像（探针 runtime 侧只读；测试侧每 feed 前追加）。
    static FED: RefCell<Vec<Bar>> = const { RefCell::new(Vec::new()) };
}

struct ProbeRuntime {
    rows: Rc<RefCell<Vec<CtxRow>>>,
}

impl PluginRuntime for ProbeRuntime {
    fn instantiate(
        &mut self,
        _code_hash: &str,
        _code: &str,
        _params: &StrategyParams,
    ) -> Result<Box<dyn PluginInstance>, PluginError> {
        Ok(Box::new(ProbeInstance { rows: Rc::clone(&self.rows) }))
    }
}

#[test]
fn indep_orchestrator_ctx_prefix_and_position_fields() {
    let _guard = serial();
    let n = 60;
    let bars = series(n, 60);
    let script = position_script(&bars);
    let rows = Rc::new(RefCell::new(Vec::new()));
    let mut rt = ProbeRuntime { rows: Rc::clone(&rows) };
    let mut orch = PluginStrategyOrchestrator::new(vec![config("st_a", 1.0)], 60.0, 40.0, &mut rt)
        .expect("构建编排器");

    let mut accumulated: Vec<Bar> = Vec::with_capacity(n);
    for (i, b) in bars.iter().enumerate() {
        FED.with(|f| f.borrow_mut().push(b.clone()));
        accumulated.push(b.clone());
        orch.feed_bar(CODE, b.clone(), script[i]).expect("评估");
    }
    FED.with(|f| f.borrow_mut().clear());

    let all = rows.borrow().clone();
    assert_eq!(all.len(), n, "每 bar 应产出一行探针");
    let first_ptr = all[0].history_ptr;
    let mut pos_null = 0usize;
    let mut pos_some = 0usize;
    for (i, r) in all.iter().enumerate() {
        assert_eq!(r.index, i, "bar {i}: index 漂移");
        assert_eq!(r.bars_len, i + 1, "bar {i}: 宿主侧 ctx.bars 必须恰为 bars[..=index]");
        assert!(!r.ahead_visible, "bar {i}: 存在 index 之外的 bar（可读未来）");
        assert!(r.bars_eq_prefix, "bar {i}: ctx.bars 与已喂入前缀逐元素不等");
        assert!(r.cur_eq_ctx_bar, "bar {i}: ctx.bars[index] != ctx.bar");
        assert!(r.shared_handle, "bar {i}: 未注入共享历史缓冲句柄");
        assert_eq!(r.history_ptr, first_ptr, "bar {i}: 共享缓冲句柄跨 bar 不恒等");
        // 持仓快照 = 改造前公式（独立复刻）
        let want = script[i].map(|p| prechange_snapshot(&accumulated, i, p));
        assert_eq!(r.position, want, "bar {i}: ctx.position 与改造前公式不等");
        if r.position.is_none() {
            pos_null += 1;
        } else {
            pos_some += 1;
        }
    }
    assert!(pos_null >= 15 && pos_some >= 40, "持仓场景覆盖不足：null={pos_null} some={pos_some}");

    println!(
        "[tester-indep/sim-live] ctx.bars 可见面（独立探针）：rows={} 违例=0 bars_len==index+1 全成立 \
         ahead_visible 全 false 逐元素前缀相等=true 句柄恒等=true",
        all.len()
    );
    for r in all.iter().take(3) {
        println!(
            "  idx={} bars_len={} ahead_visible={} shared_handle={} history_ptr={:#x}",
            r.index, r.bars_len, r.ahead_visible, r.shared_handle, r.history_ptr
        );
    }
    println!(
        "[tester-indep/sim-live] ctx.position 复刻比对：{} bar 全等（null {} / some {}）；\
         抽印 idx=10,25,35,45,50 → {:?}",
        all.len(),
        pos_null,
        pos_some,
        [10usize, 25, 35, 45, 50]
            .iter()
            .map(|i| (*i, all[*i].position))
            .collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// 判据 2：逐 bar 位级评分等价（新路径 vs 改造前口径复刻；3 策略 × 持仓场景）
// ---------------------------------------------------------------------------

#[test]
fn indep_orchestrator_scores_bitwise_vs_prechange_replica_with_positions() {
    let _guard = serial();
    let n = 120;
    let bars = series(n, 60);
    let script = position_script(&bars);
    let weights = [1.0_f64, 0.5, 1.5];

    // 新路径：真实编排器（共享历史缓冲 + 前缀切片）。
    let cfgs = vec![
        config("st_a", weights[0]),
        config("st_b", weights[1]),
        config("st_c", weights[2]),
    ];
    let mut orch =
        PluginStrategyOrchestrator::with_quickjs(cfgs, 60.0, 40.0, RuntimeLimits::default())
            .expect("构建编排器");
    let mut new_rows: Vec<(i64, Vec<f64>, f64, String)> = Vec::with_capacity(n);
    for (i, b) in bars.iter().enumerate() {
        let ev = orch.feed_bar(CODE, b.clone(), script[i]).expect("评估");
        new_rows.push((
            ev.ts,
            ev.per_strategy_scores.iter().map(|s| s.score).collect(),
            ev.aggregate_score,
            ev.signal.clone(),
        ));
    }

    // 改造前口径复刻：累计 Vec<Bar> + 每 bar `BarCtx::new(idx, bar, &accumulated, snapshot)`（无共享句柄）。
    let mut instances: Vec<Box<dyn PluginInstance>> = (0..3)
        .map(|_| {
            let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
            rt.instantiate("sha256:tester-indep", POSITION_ENCODING_PLUGIN, &StrategyParams::new())
                .expect("实例化成功")
        })
        .collect();
    let mut accumulated: Vec<Bar> = Vec::with_capacity(n);
    let mut old_rows: Vec<(i64, Vec<f64>, f64, String)> = Vec::with_capacity(n);
    for (i, b) in bars.iter().enumerate() {
        accumulated.push(b.clone());
        let idx = accumulated.len() - 1;
        let snapshot = script[i].map(|p| prechange_snapshot(&accumulated, idx, p));
        let mut per_strategy: Vec<f64> = Vec::with_capacity(3);
        let mut weighted: Vec<(f64, f64)> = Vec::with_capacity(3);
        for (j, inst) in instances.iter_mut().enumerate() {
            let ctx = BarCtx::new(idx, b.clone(), &accumulated, snapshot);
            let score = inst.on_bar(&ctx).expect("不应出错");
            per_strategy.push(score);
            weighted.push((weights[j], score));
        }
        let agg = weighted_aggregate(&weighted);
        let signal = aggregate_to_signal(agg, 60.0, 40.0).to_string();
        old_rows.push((b.ts, per_strategy, agg, signal));
    }

    assert_eq!(new_rows.len(), old_rows.len());
    let mut pos_bars = 0usize;
    let mut distinct = std::collections::HashSet::new();
    for (i, (new, old)) in new_rows.iter().zip(old_rows.iter()).enumerate() {
        assert_eq!(new.0, old.0, "bar {i}: ts 漂移");
        assert_eq!(new.1.len(), old.1.len(), "bar {i}: 策略数漂移");
        for (j, (a, b)) in new.1.iter().zip(old.1.iter()).enumerate() {
            assert_eq!(
                a.to_bits(),
                b.to_bits(),
                "bar {i} slot {j}: 新路径 {a:?} ≠ 改造前复刻 {b:?}（位级）"
            );
            distinct.insert(a.to_bits());
        }
        assert_eq!(new.2.to_bits(), old.2.to_bits(), "bar {i}: aggregate 位级漂移");
        assert_eq!(new.3, old.3, "bar {i}: signal 漂移");
        if script[i].is_some() {
            pos_bars += 1;
        }
    }
    assert!(pos_bars >= 40, "持仓 bar 覆盖不足：{pos_bars}");
    assert!(distinct.len() > 60, "评分取值应有鉴别力：distinct={}", distinct.len());
    let signals: std::collections::HashSet<&str> =
        new_rows.iter().map(|r| r.3.as_str()).collect();
    println!(
        "[tester-indep/sim-live] 位级等价（含持仓）：bars={} slots=3 持仓 bar={} 逐位相等={} \
         distinct_scores={} signals={:?}",
        n,
        pos_bars,
        n * 3,
        distinct.len(),
        signals
    );
}

// ---------------------------------------------------------------------------
// 判据 3：分配量双向（新路径常数 vs 改造前调用形态线性）
// ---------------------------------------------------------------------------

fn measure_new(n: usize) -> (f64, f64) {
    let bars = series(n, 60);
    let before = ALLOC_BYTES.load(Ordering::Relaxed);
    let t0 = std::time::Instant::now();
    let mut orch =
        PluginStrategyOrchestrator::with_quickjs(vec![config("st_a", 1.0)], 60.0, 40.0, RuntimeLimits::default())
            .expect("构建编排器");
    for b in &bars {
        let ev = orch.feed_bar(CODE, b.clone(), None).expect("评估");
        assert_eq!(ev.per_strategy_scores.len(), 1);
    }
    let wall_ms = t0.elapsed().as_secs_f64() * 1_000.0;
    let after = ALLOC_BYTES.load(Ordering::Relaxed);
    ((after - before) as f64 / n as f64, wall_ms)
}

/// 改造前调用形态（兼容路径）复刻：累计 `Vec<Bar>` + 每 bar 全量切片 `BarCtx::new`。
fn measure_compat(n: usize) -> (f64, f64) {
    let bars = series(n, 60);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:tester-indep", POSITION_ENCODING_PLUGIN, &StrategyParams::new())
        .expect("实例化成功");
    let mut accumulated: Vec<Bar> = Vec::with_capacity(n);
    let before = ALLOC_BYTES.load(Ordering::Relaxed);
    let t0 = std::time::Instant::now();
    for b in &bars {
        accumulated.push(b.clone());
        let idx = accumulated.len() - 1;
        let ctx = BarCtx::new(idx, b.clone(), &accumulated, None);
        let _ = inst.on_bar(&ctx).expect("不应出错");
    }
    let wall_ms = t0.elapsed().as_secs_f64() * 1_000.0;
    let after = ALLOC_BYTES.load(Ordering::Relaxed);
    ((after - before) as f64 / n as f64, wall_ms)
}

#[test]
fn indep_orchestrator_alloc_flat_vs_growing_compat() {
    let _guard = serial();
    let (new2k, new2k_ms) = measure_new(2_000);
    let (new4k, new4k_ms) = measure_new(4_000);
    let (cmp2k, cmp2k_ms) = measure_compat(2_000);
    let (cmp4k, cmp4k_ms) = measure_compat(4_000);

    println!(
        "[tester-indep/alloc·新路径] n=2000 {new2k:.1} B/bar（{new2k_ms:.1} ms） | n=4000 {new4k:.1} \
         B/bar（{new4k_ms:.1} ms）；ratio={:.3}（期望 ≈1）；wall ratio={:.3}（期望 ≈2）",
        new4k / new2k,
        new4k_ms / new2k_ms
    );
    println!(
        "[tester-indep/alloc·兼容路径(改造前形态)] n=2000 {cmp2k:.1} B/bar（{cmp2k_ms:.1} ms） | \
         n=4000 {cmp4k:.1} B/bar（{cmp4k_ms:.1} ms）；ratio={:.3}（期望 ≈2）",
        cmp4k / cmp2k
    );

    assert!(
        new4k / new2k <= 1.25,
        "新路径每 bar 分配不得随 index 增长：{new2k:.1} → {new4k:.1} B/bar"
    );
    assert!(
        cmp4k / cmp2k >= 1.5,
        "度量判别力检验失败：改造前调用形态应随 index 线性增长，实测 {cmp2k:.1} → {cmp4k:.1} B/bar"
    );
    assert!(
        cmp2k / new2k >= 10.0,
        "改造前形态每 bar 分配应远高于新路径：兼容 {cmp2k:.1} vs 新 {new2k:.1} B/bar"
    );
}
