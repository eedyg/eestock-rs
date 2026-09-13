//! dcap 插件侧 —— T5a（`init` 确定性归一化）与 T6（数据不足边界）
//!
//! 本文件位置：`crates/strategy-runtime/tests/dcap_plugin_init.rs`
//! 被测对象：`crates/strategy-core/reference-plugins/dcap.js`（entangled 生成产物，ADR-021 D2/D4；
//!   本文件**只读**读取仓库内文件，不改仓库任何文件；用例所需临时内容一律不落盘）。
//! 运行：`cargo test -p strategy-runtime --test dcap_plugin_init -- --nocapture`
//!
//! 权威口径：
//!   · `design/14-dcap-indicator/02-spec.md` §2（跨字段约束落地方式：`init` 内归一化
//!     `n_m ← max(n_m, n_s+1)`、`n_l ← max(n_l, n_m+1)`，确定 + 幂等 + 只在 `init` 做一次）、
//!     §3（数据不足：该线无值；三线全缺 → 50）、§4 铁律 5（归一化必须在 CORE 内；插件 `init`
//!     调用它）、§5（`on_bar` ④ 不足的线跳过不入 N；⑤ 三线全不足 return 50；`ctx.log` 无噪声）、
//!     §5「内部状态：三条 close 滚动窗口（各 n_i 长）」。
//!   · `design/14-dcap-indicator/03-test-plan.md` T5a / T6。
//!
//! ── 本文件钉死的口径（每条断言对应一条）─────────────────────────────────────────
//! 1. **T5a-1 生效值**：非单调 n 经 `init` 后，三条滚动窗口的**容量**分别等于归一后的
//!    `(n_s, n_m', n_l')`（`n_m' = max(n_m, n_s+1)`、`n_l' = max(n_l, n_m'+1)`，**顺序归一**）。
//!    可观测形式：跑满 `≥ n_l'` 根 bar 后 `save()` 的 `winS/winM/winL` 数组长度 = 各线容量。
//!    （依据 §5「三条 close 滚动窗口（各 n_i 长）」+ §3「参数归一化」行 ⇒ `n_i` 为归一后值。）
//! 2. **T5a-2 幂等**：把已经归一过的三元组再次作为 `init` 输入 ⇒ 生效值不再变化
//!    （= 与未归一输入的行为**逐位**相同，含每条 bar 的分数位串）。
//! 3. **T5a-3 确定**：同参数 + 同 bar 序列 → 两个独立实例逐位同输出（含非单调参数）。
//! 4. **T5a-4 不逐 bar 变形**：`init` 之后窗口容量恒定（bar 40 与 bar 80 的 `save()` 长度相同），
//!    钉死「只在 `init` 归一一次、`on_bar` 内不得反复归一化」（§3/§5）。
//! 5. **T6-1 逐线**：只有 s 线够数据时，`on_bar` 的分数必须**等于 N=1** 的算式
//!    （`50 − 50·per_s`），**不得**等于 N=3 的算式（`50 − (50/3)·per_s`）——
//!    即「数据不足的线不入 N」（§3 数据不足行 / §5 ④）。
//! 6. **T6-2 全不足**：三线全不足 → 返回**恰好** 50.0（位串 `4049000000000000`），且逐 bar
//!    `ctx.take_logs()` 为空（无日志噪声，§5 ⑤ / §9 可观测性）。
//!
//! ── 为什么浮点一律用十六进制位串 ───────────────────────────────────────────────
//! 本套件需要「用同一段 CORE 独立复算期望值」，浮点跨越 JS↔Rust 时**不得**走 JSON 十进制：
//! `serde_json` 的十进制**解析**非正确舍入（实测见
//! `crates/strategy-runtime/tests/dcap_plugin_replay.rs` 的通道探针：
//! `-0.011674411920738925` 经 `from_str` 差 1 ulp）。故所有 JS→Rust 的浮点一律以
//! 16 位 hex 位串传输，Rust 侧 `f64::from_bits(u64::from_str_radix(..))` 还原（零损失）。

use std::fs;
use std::path::{Path, PathBuf};

use backtest::{Bar, ParamValue, StrategyParams};
use rquickjs::context::intrinsic::{Eval, Json, TypedArrays};
use rquickjs::{Context as QjsContext, Runtime as QjsRuntime};
use serde_json::Value;
use strategy_runtime::{BarCtx, PluginInstance, PluginRuntime, QuickJsRuntime, RuntimeLimits};

// ---------------------------------------------------------------------------
// 产物读取（只读；路径按仓库相对路径解析）
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn product_path() -> PathBuf {
    repo_root().join("crates/strategy-core/reference-plugins/dcap.js")
}

fn read_product() -> String {
    let p = product_path();
    fs::read_to_string(&p).unwrap_or_else(|e| {
        panic!(
            "插件产物读取失败：{p:?}（{e}）\n\
             应由 `entangled tangle` 从 design/14-dcap-indicator/02-spec.md §10.2 生成（ADR-021 D1/D2）。"
        )
    })
}

// ---------------------------------------------------------------------------
// 位串工具
// ---------------------------------------------------------------------------

fn f64_hex(v: f64) -> String {
    format!("{:016x}", v.to_bits())
}

fn hex_to_f64(h: &str) -> f64 {
    f64::from_bits(
        u64::from_str_radix(h, 16).unwrap_or_else(|e| panic!("非法十六进制位串 {h:?}：{e}")),
    )
}

/// 两侧共用的 JS 位串助手（与 dcap_cross_runtime.rs 同源同字节）。
const BITS_JS_HELPER: &str = r#"
var __bitsBuf = new ArrayBuffer(8);
var __bitsView = new DataView(__bitsBuf);
function hexToF64(h) {
  __bitsView.setUint32(0, parseInt(h.slice(0, 8), 16), false);
  __bitsView.setUint32(4, parseInt(h.slice(8, 16), 16), false);
  return __bitsView.getFloat64(0, false);
}
function f64ToHex(x) {
  if (x === null || x === undefined) { return null; }
  __bitsView.setFloat64(0, x, false);
  var hi = __bitsView.getUint32(0, false).toString(16);
  var lo = __bitsView.getUint32(4, false).toString(16);
  while (hi.length < 8) { hi = "0" + hi; }
  while (lo.length < 8) { lo = "0" + lo; }
  return hi + lo;
}
"#;

// ---------------------------------------------------------------------------
// 参数 / bar 夹具（确定性，无 RNG / 无时间依赖）
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct P {
    n_s: f64,
    n_m: f64,
    n_l: f64,
    r_s: f64,
    r_m: f64,
    r_l: f64,
    smooth: f64,
    m: f64,
    th: f64,
}

impl P {
    fn params(&self) -> StrategyParams {
        StrategyParams::from([
            ("n_s".to_string(), ParamValue::Num(self.n_s)),
            ("n_m".to_string(), ParamValue::Num(self.n_m)),
            ("n_l".to_string(), ParamValue::Num(self.n_l)),
            ("r_s".to_string(), ParamValue::Num(self.r_s)),
            ("r_m".to_string(), ParamValue::Num(self.r_m)),
            ("r_l".to_string(), ParamValue::Num(self.r_l)),
            ("smooth".to_string(), ParamValue::Num(self.smooth)),
            ("m".to_string(), ParamValue::Num(self.m)),
            ("th".to_string(), ParamValue::Num(self.th)),
        ])
    }

    fn hex_json(&self) -> Value {
        serde_json::json!({
            "n_s": f64_hex(self.n_s), "n_m": f64_hex(self.n_m), "n_l": f64_hex(self.n_l),
            "r_s": f64_hex(self.r_s), "r_m": f64_hex(self.r_m), "r_l": f64_hex(self.r_l),
            "smooth": f64_hex(self.smooth), "m": f64_hex(self.m), "th": f64_hex(self.th),
        })
    }
}

/// 确定性合成序列（纯算术构造）。
fn synth(len: usize) -> Vec<f64> {
    (0..len)
        .map(|i| 10.0 + (((i * 37) % 11) as f64 - 5.0) * 0.3)
        .collect()
}

fn bars_from_closes(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(i, &close)| Bar {
            ts: 1_700_000_000 + i as i64 * 900,
            open: close,
            high: close,
            low: close,
            close,
            volume: 1_000.0 + i as f64,
        })
        .collect()
}

fn instantiate(rt: &mut QuickJsRuntime, src: &str, p: &P) -> Box<dyn PluginInstance> {
    rt.instantiate("sha256:tester_dcap_init", src, &p.params())
        .unwrap_or_else(|e| panic!("插件实例化失败（P={p:?}）：{e}\n（P2 包装层：PARAMS_SCHEMA/init/on_bar）"))
}

/// 跑完 closes 全序列，返回逐 bar 分数（`on_bar` 之后取走日志，归集到第二个返回值）。
fn run_with_logs(inst: &mut Box<dyn PluginInstance>, closes: &[f64]) -> (Vec<f64>, Vec<Vec<String>>) {
    let bars = bars_from_closes(closes);
    let mut scores = Vec::with_capacity(bars.len());
    let mut logs = Vec::with_capacity(bars.len());
    for (i, bar) in bars.iter().enumerate() {
        let ctx = BarCtx::new(i, bar.clone(), &bars, None);
        let s = inst
            .on_bar(&ctx)
            .unwrap_or_else(|e| panic!("on_bar 出错（bar {i}）：{e}"));
        logs.push(ctx.take_logs());
        scores.push(s);
    }
    (scores, logs)
}

/// 只跑到 `upto`（不含）根，返回逐 bar 分数。
fn run_n(inst: &mut Box<dyn PluginInstance>, closes: &[f64], upto: usize) -> Vec<f64> {
    let bars = bars_from_closes(closes);
    let mut scores = Vec::with_capacity(upto);
    for (i, bar) in bars.iter().enumerate().take(upto) {
        let ctx = BarCtx::new(i, bar.clone(), &bars, None);
        scores.push(
            inst.on_bar(&ctx)
                .unwrap_or_else(|e| panic!("on_bar 出错（bar {i}）：{e}")),
        );
    }
    scores
}

/// 断言两个 f64 **逐位**相同（IEEE754 位串）。
fn assert_bits_eq(actual: f64, expected: f64, label: &str) {
    assert!(
        actual.to_bits() == expected.to_bits(),
        "{label}：位串不同 actual={actual}({}) expected={expected}({})",
        f64_hex(actual),
        f64_hex(expected)
    );
}

fn window_lens(inst: &Box<dyn PluginInstance>) -> (usize, usize, usize) {
    let snap = inst
        .save()
        .unwrap_or_else(|e| panic!("save() 必须成功（ABI G3）：{e}"))
        .expect("dcap 必须提供 save()（ABI G3：缺 save/load 则重放分叉）");
    let len = |k: &str| -> usize {
        snap.get(k)
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| {
                panic!(
                    "save() 缺少数组字段 {k}（02-spec §5「内部状态」：三条 close 滚动窗口必须进 save()）。实际快照键={:?}",
                    snap.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
                )
            })
            .len()
    };
    (len("winS"), len("winM"), len("winL"))
}

// ---------------------------------------------------------------------------
// 用同一段 CORE 独立复算（QuickJS 直接求值；浮点以 hex 位串出）
// ---------------------------------------------------------------------------

/// 在 QuickJS 里求值 CORE，返回 `computeDcapSeries(prefix, params)[last]` 三线值位串
/// 与「只把 s 线计入 N」的分数位串（用于 T6-1 的 N 语义独立复算）。
fn core_probe_last_bar(src: &str, p: &P, prefix: &[f64]) -> Value {
    let rt = QjsRuntime::new().unwrap_or_else(|e| panic!("QuickJS Runtime 创建失败：{e}"));
    let ctx = QjsContext::custom::<(Eval, Json, TypedArrays)>(&rt)
        .unwrap_or_else(|e| panic!("QuickJS Context 创建失败：{e}"));

    let closes_hex: Vec<String> = prefix.iter().map(|v| format!("\"{}\"", f64_hex(*v))).collect();
    let prologue = format!(
        "{helper}\nvar __closes = [{closes}].map(hexToF64);\nvar __params = {params};\n\
         for (var __k in __params) {{ __params[__k] = hexToF64(__params[__k]); }}\n",
        helper = BITS_JS_HELPER,
        closes = closes_hex.join(","),
        params = serde_json::to_string(&p.hex_json()).expect("params JSON"),
    );
    let expr = r#"JSON.stringify((function () {
  var s = computeDcapSeries(__closes, __params);
  var last = s[s.length - 1];
  return {
    s: f64ToHex(last.s), m: f64ToHex(last.m), l: f64ToHex(last.l),
    scoreSOnly: f64ToHex(dcapScore({ s: last.s, m: null, l: null }, __params.th)),
    scoreAll: f64ToHex(dcapScore({ s: last.s, m: last.m, l: last.l }, __params.th))
  };
})())"#;

    ctx.with(|ctx| {
        if let Err(e) = ctx.eval::<(), _>(src) {
            panic!("插件源码在 QuickJS 求值失败：{e:?}（CORE 必须是无类型注解的 ES2015 子集，02-spec §4 铁律 4）");
        }
        ctx.eval::<(), _>(prologue.as_str())
            .unwrap_or_else(|e| panic!("测试助手脚本求值失败：{e:?}"));
        let out: String = ctx
            .eval(expr)
            .unwrap_or_else(|e| panic!("CORE 未按契约暴露 computeDcapSeries/dcapScore：{e:?}"));
        serde_json::from_str(&out).unwrap_or_else(|e| panic!("QuickJS 输出不是合法 JSON：{e}；原始={out}"))
    })
}

fn hex_field(v: &Value, k: &str) -> Option<f64> {
    match v.get(k) {
        Some(Value::Null) | None => None,
        Some(Value::String(s)) => Some(hex_to_f64(s)),
        other => panic!("字段 {k} 应为 hex 字符串或 null，实际 {other:?}"),
    }
}

// ===========================================================================
// T5a —— 插件面：init 确定性归一化
// ===========================================================================

#[test]
fn t5a_plugin_effective_windows_follow_normalization() {
    // ── T5a-1 生效值 ──
    // 非单调三元组 → 归一后生效值（顺序归一：n_m' 先算，n_l' 用 n_m'）。
    let cases: [(&str, (f64, f64, f64), (usize, usize, usize)); 4] = [
        ("n_s=n_m=n_l=26", (26.0, 26.0, 26.0), (26, 27, 28)),
        ("n_s=2,n_m=n_l=10", (2.0, 10.0, 10.0), (2, 10, 11)),
        ("逆序 60/26/8", (60.0, 26.0, 8.0), (60, 61, 62)),
        ("n_s=n_l=20,n_m=20", (20.0, 20.0, 20.0), (20, 21, 22)),
    ];
    let closes = synth(90); // ≥ max(n_l') = 62 → 三条窗口都可跑满

    for (name, raw, eff) in cases {
        let p = P {
            n_s: raw.0,
            n_m: raw.1,
            n_l: raw.2,
            r_s: 1.0,
            r_m: 1.0,
            r_l: 1.0,
            smooth: 0.0,
            m: 3.0,
            th: 0.5,
        };
        let src = read_product();
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let mut inst = instantiate(&mut rt, &src, &p);
        let _ = run_with_logs(&mut inst, &closes);
        let got = window_lens(&inst);

        assert_eq!(
            got, eff,
            "[T5a-1] {name}：raw=({}, {}, {}) 经 init 后三线窗口容量必须为归一值 {:?}\
             （n_m'=max(n_m,n_s+1)、n_l'=max(n_l,n_m'+1)；02-spec §2/§3）",
            raw.0, raw.1, raw.2, eff
        );
        assert!(
            got.0 < got.1 && got.1 < got.2,
            "[T5a-1] {name}：归一后三线必须严格单调（实际窗口容量 {got:?}）"
        );
    }
}

#[test]
fn t5a_plugin_normalization_is_idempotent_and_bitwise_deterministic() {
    let src = read_product();
    let closes = synth(70);
    let raw = P {
        n_s: 26.0,
        n_m: 26.0,
        n_l: 26.0,
        r_s: 1.0,
        r_m: 1.2,
        r_l: 0.8,
        smooth: 1.0,
        m: 3.0,
        th: 0.02,
    };
    // 归一后的三元组（26,27,28）—— 用同一组其余参数。
    let normalized = P { n_m: 27.0, n_l: 28.0, ..raw };

    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut a = instantiate(&mut rt, &src, &raw);
    let (scores_raw, _) = run_with_logs(&mut a, &closes);
    let len_raw = window_lens(&a);

    // ── T5a-3 确定：同参数新实例 → 逐位同输出 ──
    let mut b = instantiate(&mut rt, &src, &raw);
    let (scores_raw2, _) = run_with_logs(&mut b, &closes);
    assert_eq!(scores_raw.len(), scores_raw2.len(), "[T5a-3] bar 数必须一致");
    for (i, (x, y)) in scores_raw.iter().zip(scores_raw2.iter()).enumerate() {
        assert_bits_eq(*y, *x, &format!("[T5a-3] 非单调参数两个独立实例 bar {i}"));
    }

    // ── T5a-2 幂等：把已经归一过的值再喂 init ⇒ 不再变化 ──
    let mut c = instantiate(&mut rt, &src, &normalized);
    let (scores_norm, _) = run_with_logs(&mut c, &closes);
    let len_norm = window_lens(&c);
    assert_eq!(
        len_norm, len_raw,
        "[T5a-2] 已归一三元组再 init 必须得到同一生效值（raw={len_raw:?} vs 归一后输入={len_norm:?}）"
    );
    assert_eq!(scores_norm.len(), scores_raw.len(), "[T5a-2] bar 数必须一致");
    for (i, (x, y)) in scores_raw.iter().zip(scores_norm.iter()).enumerate() {
        assert_bits_eq(
            *y,
            *x,
            &format!("[T5a-2] 归一化必须无损且幂等：raw 参数 vs 已归一参数 bar {i}"),
        );
    }
}

#[test]
fn t5a_plugin_windows_do_not_drift_across_bars() {
    // ── T5a-4 只在 init 归一一次（on_bar 内不得反复归一化）──
    // 可观测形式：跑到饱和后，窗口容量不得随 bar 推进而增长/变化。
    let src = read_product();
    let p = P {
        n_s: 8.0,
        n_m: 8.0,
        n_l: 8.0,
        r_s: 1.0,
        r_m: 1.0,
        r_l: 1.0,
        smooth: 0.0,
        m: 3.0,
        th: 0.5,
    };
    let closes = synth(120);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = instantiate(&mut rt, &src, &p);

    let _ = run_n(&mut inst, &closes, 40);
    let at40 = window_lens(&inst);
    let _ = run_n(&mut inst, &closes[40..], closes.len() - 40);
    let at120 = window_lens(&inst);

    assert_eq!(
        at40, at120,
        "[T5a-4] 饱和后窗口容量必须恒定（bar40={at40:?} bar120={at120:?}）——\
         归一化只允许在 init 做一次（02-spec §3/§5）；逐 bar 变形会破坏确定性与重放"
    );
    assert_eq!(at40, (8, 9, 10), "[T5a-4] 归一后生效值应为 (8,9,10)");
}

// ===========================================================================
// T6 —— 数据不足边界（插件侧）
// ===========================================================================

#[test]
fn t6_plugin_all_lines_insufficient_returns_exactly_50_and_no_log_noise() {
    let src = read_product();
    // smooth=1, m=3：s 线首个有值需 n_s + m − 1 = 7 根 bar ⇒ 前 6 根三线全不足。
    let smooth1 = P {
        n_s: 5.0,
        n_m: 10.0,
        n_l: 20.0,
        r_s: 1.0,
        r_m: 1.0,
        r_l: 1.0,
        smooth: 1.0,
        m: 3.0,
        th: 0.01,
    };
    // smooth=0：s 线首个有值需 n_s = 5 根 ⇒ 前 4 根三线全不足。
    let smooth0 = P { smooth: 0.0, ..smooth1 };

    for (label, p, insufficient_bars) in [
        ("smooth=1,m=3（需要 n_s+m−1=7 根）", smooth1, 6usize),
        ("smooth=0（需要 n_s=5 根）", smooth0, 4usize),
    ] {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let mut inst = instantiate(&mut rt, &src, &p);
        let closes = synth(30);
        let (scores, logs) = run_with_logs(&mut inst, &closes);

        for i in 0..insufficient_bars {
            assert_bits_eq(
                scores[i],
                50.0,
                &format!("[T6-2] {label}：三线全不足的第 {} 根 bar 必须返回恰好 50", i + 1),
            );
        }
        // 反向哨兵：足够长之后不得仍恒为 50（否则 50 断言无鉴别力）。
        assert!(
            scores[insufficient_bars..].iter().any(|s| *s != 50.0),
            "[T6-2] {label}：数据够长后必须出现非 50 分（否则「恒 50」实现也能蒙过上面的断言）"
        );
        // 无日志噪声（02-spec §5 ⑤ / §9：数据不足走中性 50，不打 ctx.log）。
        let noisy: Vec<(usize, Vec<String>)> = logs
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.is_empty())
            .map(|(i, l)| (i, l.clone()))
            .collect();
        assert!(
            noisy.is_empty(),
            "[T6-2] {label}：数据不足路径不得产生 ctx.log 噪声，实际有日志的 bar：{noisy:?}"
        );
    }
}

#[test]
fn t6_plugin_insufficient_lines_are_excluded_from_n() {
    // ── T6-1 逐线：不足的线不入 N ──
    // 构造：只有 s 线够数据（m / l 线窗口未满）。
    let src = read_product();
    let closes = synth(30);

    for (label, p, bar_idx) in [
        (
            "smooth=0：第 5 根（0 起 index 4）只有 s 线够（n_s=3, n_m=8, n_l=20）",
            P {
                n_s: 3.0,
                n_m: 8.0,
                n_l: 20.0,
                r_s: 1.0,
                r_m: 1.0,
                r_l: 1.0,
                smooth: 0.0,
                m: 3.0,
                th: 0.01,
            },
            4usize,
        ),
        (
            "smooth=1,m=5：第 7 根（0 起 index 6）只有 s 线够",
            P {
                n_s: 3.0,
                n_m: 8.0,
                n_l: 20.0,
                r_s: 1.0,
                r_m: 1.0,
                r_l: 1.0,
                smooth: 1.0,
                m: 5.0,
                th: 0.01,
            },
            6usize,
        ),
    ] {
        let prefix = &closes[..=bar_idx];
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let mut inst = instantiate(&mut rt, &src, &p);
        let scores = run_n(&mut inst, &closes, prefix.len());
        let got = scores[bar_idx];

        // 读该 bar 的插件状态：m / l 线此时必须**未就绪**（窗口未满 ⇒ 不可能计入 N）。
        let snap = inst.save().expect("save()").expect("dcap save()");
        let wl = |k: &str| snap.get(k).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        assert!(
            wl("winM") < p.n_m as usize && wl("winL") < p.n_l as usize,
            "[T6-1] {label}：构造前提失败——此时 m/l 线应未就绪（winM={}, winL={}）",
            wl("winM"),
            wl("winL")
        );

        // 用同一段 CORE 独立复算：只有 s 线的值 + 显式 m/l = null。
        let probe = core_probe_last_bar(&src, &p, prefix);
        let s_val = hex_field(&probe, "s").expect("[T6-1] s 线此时必须有值");
        let expect_n1 = hex_field(&probe, "scoreSOnly").expect("scoreSOnly");
        let per = (s_val / p.th).clamp(-1.0, 1.0);
        let rust_n1 = 50.0 - (50.0 / 1.0) * per; // Rust 侧独立算式（N=1）
        let rust_n3 = 50.0 - (50.0 / 3.0) * per; // 反例：把三条线都算进分母

        assert_bits_eq(
            got,
            expect_n1,
            &format!("[T6-1] {label}：仅 s 线参与 ⇒ score 必须等于 N=1 口径"),
        );
        assert_bits_eq(got, rust_n1, &format!("[T6-1] {label}：与 Rust 侧 N=1 算式逐位一致"));
        assert!(
            got.to_bits() != rust_n3.to_bits(),
            "[T6-1] {label}：不得等于 N=3 口径（不足的线若被计入分母即此值）\
             got={got}({}) n3={rust_n3}({})",
            f64_hex(got),
            f64_hex(rust_n3)
        );
        assert!(
            (rust_n1 - rust_n3).abs() > 1e-6,
            "[T6-1] {label}：N=1 与 N=3 的口径差过小（|Δ|={}），本用例失去鉴别力——请检查 th 是否让 per 饱和",
            (rust_n1 - rust_n3).abs()
        );
    }
}
