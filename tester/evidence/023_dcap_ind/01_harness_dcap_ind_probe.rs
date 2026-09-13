//! 车道 A — dcap **指标本身**验证（纯指标，不含策略层）研究用 harness。
//!
//! 位置：**隔离 worktree**（/tmp/dcap_ind_wt，detach @3f5425c）内的 example —— 不入主树、不提交。
//! 口径守卫（03-test-plan §3.2「计算口径守卫」）：**全部 dcap 数值都由产物字节算出** ——
//!   本 harness 把 `crates/strategy-core/reference-plugins/dcap.js` 的**完整字节**交给 rquickjs
//!   求值（与生产 `strategy_runtime::QuickJsRuntime` 同一运行时家族/同一求值方式），
//!   然后只调用该产物 CORE 暴露的顶层函数 `computeDcapSeries` / `dcapRoi` /
//!   `smoothSeries` / `dcapScore`。**本文件不含任何 dcap 公式复写**；`__seriesHex` 只是
//!   取数粘合（配置 → 调用产物函数 → hex 位串），不参与任何运算。
//!
//! 用法：
//! ```text
//! cargo run --release -p strategy-runtime --example dcap_ind_probe -- --selftest
//! cargo run --release -p strategy-runtime --example dcap_ind_probe -- \
//!     --bars <bars.csv> --etf <code> --freq d1 --out <dir> [--grid primary|m3only]
//! ```
//!
//! 输出（每 (etf, freq) 一组）：
//!   · `<etf>_<freq>_dcap.f64bin` —— T×C 行主序 little-endian f64 矩阵（null → NaN）。
//!     **位精确**：hex 位串 → `f64::from_bits` 之后直接写原始字节，不经十进制。
//!   · `<etf>_<freq>_bars.csv` —— 规范化 bars（date,close），供未来收益计算与审计。
//!   · `meta_<etf>_<freq>.json` —— 配置序、T、C、产物 sha256、bars sha256。
//!
//! 配置（任务书 §1）：n ∈ {8,26,60} × r ∈ {0.5,0.7,0.85,1.0,1.2,1.5,2.0} × m ∈ {1,3,5}，
//!   smooth=1（m=1 即逐位等于原始线，02-spec §3）；每次取 `n_s = n` 那条线（`s`）。
//!   `n_m = n+1`、`n_l = n+2`（严格单调，满足插件/前端入口归一化；s 线只依赖 n_s/r_s）。

use std::fs;
use std::path::{Path, PathBuf};

use rquickjs::context::intrinsic::{Eval, Json, TypedArrays};
use rquickjs::{Context as QjsContext, Runtime as QjsRuntime};

/// 生产插件源码（与 `reference.rs` 播种的同一文件，逐字节）。
const DCAP_CODE: &str = include_str!("../../strategy-core/reference-plugins/dcap.js");

/// T1 冻结值（03-test-plan §1 T1；守卫用，容差 1e-12）。
const T1_R1: f64 = 0.0018518518518517713;
const T1_R12: f64 = 0.0045787545787547845;

const N_VALUES: [f64; 3] = [8.0, 26.0, 60.0];
const R_VALUES: [f64; 7] = [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0];
const M_VALUES: [f64; 3] = [1.0, 3.0, 5.0];

#[derive(Clone, Copy, Debug)]
struct Cfg {
    n: f64,
    r: f64,
    m: f64,
}

impl Cfg {
    fn id(&self) -> String {
        format!("n{}_r{}_m{}", self.n, fmt_r(self.r), self.m)
    }
}

fn fmt_r(r: f64) -> String {
    // 仅用于 id/文件名（配置是固定字面量集合，十进制短表示即可）
    let s = format!("{r}");
    s
}

fn grid(mode: &str) -> Vec<Cfg> {
    if mode == "fine" {
        // r 近 1 的细网格（冗余区边界定位）：n ∈ {8,26,60}、r ∈ {0.90,0.95,1.02,1.05,1.10}、m=3
        let rs = [0.90, 0.95, 1.02, 1.05, 1.10];
        let mut v = Vec::new();
        for n in N_VALUES {
            for r in rs {
                v.push(Cfg { n, r, m: 3.0 });
            }
        }
        return v;
    }
    if mode == "nsweep" || mode == "nsweep130" {
        // r=1 的 n' 全扫（用于「(n,r) → 等价 (n',r=1)」的经验映射；m=3 生产默认）
        let hi = if mode == "nsweep" { 250 } else { 130 };
        return (2..=hi).map(|n| Cfg { n: n as f64, r: 1.0, m: 3.0 }).collect();
    }
    let mut v = Vec::new();
    for n in N_VALUES {
        for r in R_VALUES {
            for m in M_VALUES {
                if mode == "m3only" && m != 3.0 {
                    continue;
                }
                v.push(Cfg { n, r, m });
            }
        }
    }
    v
}

// ---------------------------------------------------------------------------
// hex 位串助手（与 crates/strategy-runtime/tests/dcap_cross_runtime.rs 的 BITS_JS_HELPER 同源）
// ---------------------------------------------------------------------------

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

fn f64_hex(v: f64) -> String {
    format!("{:016x}", v.to_bits())
}

fn hex_to_f64(h: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(h, 16).unwrap_or_else(|e| panic!("非法 hex {h:?}: {e}")))
}

/// closes 定义（`__CLOSES_HEX__` 由调用方先定义）。
const CLOSES_JS: &str = "var __closes = __CLOSES_HEX__.map(hexToF64);\n";

/// 取数粘合（**不含公式**）：把 closes 与配置喂给产物 CORE，回传 s 线的 16 位 hex 位串序列。
const SERIES_JS: &str = r#"
// 取数粘合：配置 → 调用**产物** CORE 的 computeDcapSeries → s 线 hex 位串。
// 不重写任何公式；n_m = n+1、n_l = n+2 保证入口归一化后 n_s 仍等于 n（s 线只依赖 n_s/r_s/m/smooth）。
// 生产同路径的滚动窗口取数（与插件 on_bar 的 dcapPushLine 同构：窗口只保留 n 个 close、
// 平滑尾窗只保留 m 个原始 ROI，再调产物 CORE 的 dcapRoi / smoothSeries）。
// 作用：长序列（15m）下避免 computeDcapSeries 的 O(T^2) 前缀拷贝；**同样只调产物函数，不重写公式**。
// 与 __seriesHex（computeDcapSeries 路径）的逐位一致性由 --crosscheck 断言。
function __seriesHexRoll(nHex, rHex, mHex) {
  var n = hexToF64(nHex);
  var r = hexToF64(rHex);
  var mm = Math.floor(hexToF64(mHex));
  var out = [];
  var win = [];
  var tail = [];
  for (var i = 0; i < __closes.length; i++) {
    win.push(__closes[i]);
    if (win.length > n) { win.shift(); }
    var raw = dcapRoi(win, n, r);
    tail.push(raw);
    if (tail.length > mm) { tail.shift(); }
    var sm = smoothSeries(tail, 1, mm);
    out.push(f64ToHex(sm[sm.length - 1]));
  }
  return out.join(",");
}

function __seriesHex(nHex, rHex, mHex) {
  var n = hexToF64(nHex);
  var r = hexToF64(rHex);
  var m = hexToF64(mHex);
  var p = { n_s: n, n_m: n + 1, n_l: n + 2, r_s: r, r_m: r, r_l: r, smooth: 1, m: m };
  var s = computeDcapSeries(__closes, p);
  var out = [];
  for (var i = 0; i < s.length; i++) { out.push(f64ToHex(s[i].s)); }
  return out.join(",");
}
"#;

// ---------------------------------------------------------------------------
// bars 装载
// ---------------------------------------------------------------------------

struct Bars {
    dates: Vec<String>,
    closes: Vec<f64>,
}

/// 读 CSV（表头驱动）：取 `close` 列与日期列（`date` 或 `ts`）。只读。
fn load_bars(path: &Path) -> Bars {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("读 bars 失败 {path:?}: {e}"));
    let mut lines = text.lines();
    let header = lines.next().unwrap_or_else(|| panic!("{path:?} 为空"));
    let cols: Vec<String> = header.split(',').map(|s| s.trim().to_string()).collect();
    let idx_close = cols
        .iter()
        .position(|c| c == "close")
        .unwrap_or_else(|| panic!("{path:?} 缺 close 列：{cols:?}"));
    let idx_date = cols
        .iter()
        .position(|c| c == "date" || c == "ts" || c == "datetime")
        .unwrap_or_else(|| panic!("{path:?} 缺日期列：{cols:?}"));
    let mut dates = Vec::new();
    let mut closes = Vec::new();
    for (i, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(',').collect();
        if f.len() <= idx_close.max(idx_date) {
            panic!("{path:?} 第 {} 行列数不足：{line}", i + 2);
        }
        let c: f64 = f[idx_close]
            .trim()
            .parse()
            .unwrap_or_else(|e| panic!("{path:?} 第 {} 行 close 非法：{e}", i + 2));
        if !(c > 0.0) {
            panic!("{path:?} 第 {} 行 close 非正：{c}", i + 2);
        }
        dates.push(f[idx_date].trim().to_string());
        closes.push(c);
    }
    assert!(!closes.is_empty(), "{path:?} 没有数据行");
    Bars { dates, closes }
}

fn sha256_file(path: &Path) -> String {
    // 只用外部 sha256sum，避免引入新 crate（不新增依赖）
    let out = std::process::Command::new("sha256sum")
        .arg(path)
        .output()
        .unwrap_or_else(|e| panic!("sha256sum 失败：{e}"));
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

fn sha256_bytes(b: &[u8]) -> String {
    let tmp = std::env::temp_dir().join(format!("dcap_ind_hash_{}", std::process::id()));
    fs::write(&tmp, b).expect("写临时 hash 文件");
    let h = sha256_file(&tmp);
    let _ = fs::remove_file(&tmp);
    h
}

// ---------------------------------------------------------------------------
// QuickJS 求值
// ---------------------------------------------------------------------------

/// 求出 closes 上所有配置的 s 线（hex 位串）。返回 (configs, T, 每条线的 hex 向量)。
fn run_probe(closes: &[f64], cfgs: &[Cfg], method: &str) -> Vec<Vec<Option<f64>>> {
    let rt = QjsRuntime::new().unwrap_or_else(|e| panic!("QuickJS Runtime 创建失败：{e}"));
    let ctx = QjsContext::custom::<(Eval, Json, TypedArrays)>(&rt)
        .unwrap_or_else(|e| panic!("QuickJS Context 创建失败：{e}"));

    let closes_hex: Vec<String> = closes.iter().map(|v| format!("\"{}\"", f64_hex(*v))).collect();
    let prologue = format!(
        "{helper}\nvar __CLOSES_HEX__ = [{closes}];\n{closesjs}{tail}",
        helper = BITS_JS_HELPER,
        closes = closes_hex.join(","),
        closesjs = CLOSES_JS,
        tail = SERIES_JS
    );

    ctx.with(|ctx| {
        ctx.eval::<(), _>(DCAP_CODE).unwrap_or_else(|e| {
            panic!(
                "产物 dcap.js 在 rquickjs 求值失败：{e:?} / {}",
                catch_text(&ctx)
            )
        });
        ctx.eval::<(), _>(prologue.as_str()).unwrap_or_else(|e| {
            panic!(
                "prologue 求值失败（closes n={}）：{e:?} / {}",
                closes.len(),
                catch_text(&ctx)
            )
        });
        let mut out: Vec<Vec<Option<f64>>> = Vec::with_capacity(cfgs.len());
        for cfg in cfgs {
            let fname = if method == "roll" { "__seriesHexRoll" } else { "__seriesHex" };
            let expr = format!(
                "{fname}(\"{}\", \"{}\", \"{}\")",
                f64_hex(cfg.n),
                f64_hex(cfg.r),
                f64_hex(cfg.m)
            );
            let joined: String = ctx.eval(expr.as_str()).unwrap_or_else(|e| {
                panic!(
                    "取数失败 cfg={}: {e:?} / {}",
                    cfg.id(),
                    catch_text(&ctx)
                )
            });
            let vals: Vec<Option<f64>> = joined
                .split(',')
                .map(|h| if h.is_empty() { None } else { Some(hex_to_f64(h)) })
                .collect();
            assert_eq!(
                vals.len(),
                closes.len(),
                "cfg={} 返回长度 {} ≠ bars {}",
                cfg.id(),
                vals.len(),
                closes.len()
            );
            out.push(vals);
        }
        out
    })
}

fn catch_text(ctx: &rquickjs::Ctx<'_>) -> String {
    let caught = ctx.catch();
    match ctx.json_stringify(caught) {
        Ok(Some(s)) => s.to_string().unwrap_or_else(|e| format!("<utf8 失败 {e}>")),
        Ok(None) => "<不可序列化>".to_string(),
        Err(e) => format!("<序列化失败 {e}>"),
    }
}

// ---------------------------------------------------------------------------
// 自检（T1 守卫 + 归一化 + 数据不足边界 + 确定性）
// ---------------------------------------------------------------------------

fn eval_str(ctx: &rquickjs::Ctx<'_>, expr: &str) -> String {
    ctx.eval::<String, _>(expr)
        .unwrap_or_else(|e| panic!("eval 失败 {expr}: {e:?} / {}", catch_text(ctx)))
}

fn selftest() -> i32 {
    let rt = QjsRuntime::new().unwrap();
    let ctx = QjsContext::custom::<(Eval, Json, TypedArrays)>(&rt).unwrap();
    let mut fails = 0usize;
    ctx.with(|ctx| {
        ctx.eval::<(), _>(DCAP_CODE).expect("产物求值");
        ctx.eval::<(), _>(BITS_JS_HELPER).expect("helper");

        // ── T1 位级守卫：closes=[100,90,95], n=3 ──────────────────────────────
        println!("=== T1 口径守卫（产物字节经 rquickjs；closes=[100,90,95], n=3）===");
        let t1 = eval_str(
            &ctx,
            "JSON.stringify({r1: f64ToHex(dcapRoi([100,90,95], 3, 1.0)), \
             r12: f64ToHex(dcapRoi([100,90,95], 3, 1.2))})",
        );
        println!("bits: {t1}");
        let v = serde_json::from_str::<serde_json::Value>(&t1).unwrap();
        let r1 = hex_to_f64(v["r1"].as_str().unwrap());
        let r12 = hex_to_f64(v["r12"].as_str().unwrap());
        println!("r=1.0  product = {r1:.17e}  ({r1})  hex={}", f64_hex(r1));
        println!("r=1.0  frozen  = {T1_R1:.17e}  ({T1_R1})  hex={}", f64_hex(T1_R1));
        println!(
            "r=1.0  |Δ| = {:.3e}  (T1 容差 1e-12；ulp 差 = {})",
            (r1 - T1_R1).abs(),
            ulp_diff(r1, T1_R1)
        );
        println!("r=1.2  product = {r12:.17e}  ({r12})  hex={}", f64_hex(r12));
        println!("r=1.2  frozen  = {T1_R12:.17e}  ({T1_R12})  hex={}", f64_hex(T1_R12));
        println!(
            "r=1.2  |Δ| = {:.3e}  (T1 容差 1e-12；ulp 差 = {})",
            (r12 - T1_R12).abs(),
            ulp_diff(r12, T1_R12)
        );
        if (r1 - T1_R1).abs() > 1e-12 {
            println!("FAIL: T1 r=1 超容差");
            fails += 1;
        }
        if (r12 - T1_R12).abs() > 1e-12 {
            println!("FAIL: T1 r=1.2 超容差");
            fails += 1;
        }
        println!("T1 守卫：{}", if fails == 0 { "PASS（≤1e-12）" } else { "FAIL" });

        // ── 归一化：n_s = n_m = n_l 时 s 线仍等于 n_s 线 ─────────────────────
        let closes_hex: Vec<String> = (0..40)
            .map(|i| format!("\"{}\"", f64_hex(10.0 + (((i * 37) % 11) as f64 - 5.0) * 0.3)))
            .collect();
        let prologue = format!(
            "{helper}\nvar __closes = [{}].map(hexToF64);\n{series}",
            closes_hex.join(","),
            helper = BITS_JS_HELPER,
            series = SERIES_JS
        );
        if let Err(e) = ctx.eval::<(), _>(prologue.as_str()) {
            println!("prologue 求值失败: {e:?} / {}", catch_text(&ctx));
            fails += 1;
            return;
        }
        let a = eval_str(&ctx, "__seriesHex(\"4020000000000000\", \"3ff0000000000000\", \"4008000000000000\")"); // n=8,r=1,m=3
        let b = eval_str(
            &ctx,
            "(function(){var s=computeDcapSeries(__closes,{n_s:8,n_m:8,n_l:8,r_s:1,r_m:1,r_l:1,smooth:1,m:3});\
             var o=[];for(var i=0;i<s.length;i++)o.push(f64ToHex(s[i].s));return o.join(',');})()",
        );
        println!("\n=== 归一化自检（非单调 n=8/8/8 vs 单调 8/9/10 的 s 线）===");
        println!("逐位相同：{}", a == b);
        if a != b {
            fails += 1;
        }

        // ── 数据不足边界：smooth=1,m=3,n=8 ⇒ 首个有值位置 = n+m-1 ─────────────
        let first = eval_str(
            &ctx,
            "(function(){var s=computeDcapSeries(__closes,{n_s:8,n_m:26,n_l:60,r_s:1,r_m:1,r_l:1,smooth:1,m:3});\
             for(var i=0;i<s.length;i++){ if(s[i].s!==null) return String(i); } return '-1';})()",
        );
        println!("\n=== 数据不足自检（n=8, smooth=1, m=3 ⇒ 可用 bar 数达 n+m−1=10 才有首值 ⇒ 0-based 索引 9）===");
        println!("实际首值位置 = {first}");
        if first != "9" {
            println!("FAIL: 首值位置 ≠ 9");
            fails += 1;
        }

        // ── 确定性：同输入两遍 ────────────────────────────────────────────────
        let x1 = eval_str(&ctx, "__seriesHex(\"4020000000000000\", \"3ff3333333333333\", \"4008000000000000\")");
        let x2 = eval_str(&ctx, "__seriesHex(\"4020000000000000\", \"3ff3333333333333\", \"4008000000000000\")");
        println!("\n=== 确定性自检（同输入双跑逐位相同）===");
        println!("逐位相同：{}", x1 == x2);
        if x1 != x2 {
            fails += 1;
        }
    });
    println!("\nselftest: {} (fails={fails})", if fails == 0 { "ALL PASS" } else { "FAIL" });
    if fails == 0 { 0 } else { 1 }
}

fn ulp_diff(a: f64, b: f64) -> i64 {
    if a == b {
        return 0;
    }
    let (ia, ib) = (ordered_bits(a), ordered_bits(b));
    ia - ib
}

fn ordered_bits(x: f64) -> i64 {
    let b = x.to_bits() as i64;
    if b < 0 { i64::MIN.wrapping_sub(b) } else { b }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn write_bin(path: &Path, mat: &[Vec<Option<f64>>], t: usize, c: usize) {
    let mut buf = Vec::with_capacity(t * c * 8);
    for i in 0..t {
        for j in 0..c {
            let v = mat[j][i].unwrap_or(f64::NAN);
            buf.extend_from_slice(&v.to_bits().to_le_bytes());
        }
    }
    fs::write(path, &buf).unwrap_or_else(|e| panic!("写 {path:?} 失败：{e}"));
}

fn write_bars_csv(path: &Path, bs: &Bars) {
    let mut s = String::from("date,close\n");
    for (d, c) in bs.dates.iter().zip(bs.closes.iter()) {
        s.push_str(&format!("{d},{c:.17e}\n"));
    }
    fs::write(path, s).unwrap_or_else(|e| panic!("写 {path:?} 失败：{e}"));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest());
    }
    let get = |k: &str| -> Option<String> {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1).cloned())
    };
    let bars_path = PathBuf::from(get("--bars").expect("--bars 必填"));
    let etf = get("--etf").expect("--etf 必填");
    let freq = get("--freq").unwrap_or_else(|| "d1".to_string());
    let out_dir = PathBuf::from(get("--out").expect("--out 必填"));
    let grid_mode = get("--grid").unwrap_or_else(|| "primary".to_string());
    let method = get("--method").unwrap_or_else(|| "front".to_string());
    fs::create_dir_all(&out_dir).expect("创建 out 目录");

    let bs = load_bars(&bars_path);
    if args.iter().any(|a| a == "--crosscheck") {
        let cfgs_cc = grid("primary");
        let a = run_probe(&bs.closes, &cfgs_cc, "front");
        let b = run_probe(&bs.closes, &cfgs_cc, "roll");
        let mut bad = 0usize;
        for (i, cfg) in cfgs_cc.iter().enumerate() {
            let same = a[i].iter().zip(b[i].iter()).all(|(x, y)| x.map(f64::to_bits) == y.map(f64::to_bits));
            if !same {
                bad += 1;
                println!("DIFF cfg={}", cfg.id());
            }
        }
        println!(
            "[crosscheck] etf={etf} bars={} cfgs={} 逐位不一致配置数={bad} ⇒ {}",
            bs.closes.len(), cfgs_cc.len(),
            if bad == 0 { "ALL PASS（front 与 roll 逐位相同）" } else { "FAIL" }
        );
        std::process::exit(if bad == 0 { 0 } else { 1 });
    }
    let cfgs = grid(&grid_mode);
    let t0 = std::time::Instant::now();
    let mat = run_probe(&bs.closes, &cfgs, &method);
    let elapsed = t0.elapsed().as_secs_f64();

    let t = bs.closes.len();
    let c = cfgs.len();
    let bin_path = out_dir.join(format!("{etf}_{freq}_dcap.f64bin"));
    let bars_out = out_dir.join(format!("{etf}_{freq}_bars.csv"));
    let meta_path = out_dir.join(format!("meta_{etf}_{freq}.json"));
    write_bin(&bin_path, &mat, t, c);
    write_bars_csv(&bars_out, &bs);

    let plugin_hash = sha256_bytes(DCAP_CODE.as_bytes());
    let cfg_json: Vec<serde_json::Value> = cfgs
        .iter()
        .map(|cfg| {
            serde_json::json!({ "id": cfg.id(), "n": cfg.n, "r": cfg.r, "m": cfg.m,
                                "smooth": 1, "line": "s", "n_m": cfg.n + 1.0, "n_l": cfg.n + 2.0 })
        })
        .collect();
    let meta = serde_json::json!({
        "etf": etf, "freq": freq, "bars": t, "configs": c,
        "rows": t, "cols": c, "nan_means_null": true,
        "layout": "row-major f64 little-endian (T x C)",
        "method": method,
        "js_entry": if method == "roll" { "__seriesHexRoll (dcapRoi+smoothSeries 滚动窗口, 与插件 on_bar 同构)" } else { "__seriesHex (computeDcapSeries s 线)" },
        "plugin_file": "crates/strategy-core/reference-plugins/dcap.js",
        "plugin_sha256": plugin_hash,
        "bars_source": bars_path.display().to_string(),
        "bars_sha256_normalized": sha256_file(&bars_out),
        "bin_sha256": sha256_file(&bin_path),
        "first_date": bs.dates.first(), "last_date": bs.dates.last(),
        "elapsed_sec": elapsed,
        "grid": cfg_json,
    });
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap()).expect("写 meta");
    println!(
        "[probe] etf={etf} freq={freq} bars={t} configs={c} elapsed={elapsed:.1}s bin={}",
        bin_path.display()
    );
    println!("[probe] plugin_sha256={plugin_hash}");
    println!("[probe] bin_sha256={}", meta["bin_sha256"].as_str().unwrap());
}
