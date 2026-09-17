//! dcap —— T4 跨运行时逐位等价（QuickJS × V8）+ 插件侧 T2（smooth=0 ≡ m=1）
//!
//! 位置：`crates/strategy-runtime/tests/dcap_cross_runtime.rs`
//!   落点理由：本 crate 已含 rquickjs 测试基建（`QuickJsRuntime` + 直接 rquickjs 求值），
//!   插件产物是 JS ⇒ 无需新增依赖、无需改任何 Cargo.toml / Cargo.lock。
//!   两个产物按**仓库相对路径只读**读取（不改仓库内任何文件；用例需要的临时文件都写在 /tmp）。
//!
//! 权威口径：`design/14-dcap-indicator/03-test-plan.md` §0/T2/T4、
//!   `02-spec.md` §3/§4/§5、`01-adr.md` D5。
//! 运行：`cargo test -p strategy-runtime --test dcap_cross_runtime -- --nocapture`
//!
//! ── 比较对象（T4 明确要求，不得含糊）──────────────────────────────────────────────
//! ① 评分：插件 `on_bar(ctx)` 返回的 0–100 分 ⟷
//!    前端 `dcapScore(computeDcapSeries(closes, p)[i], p.th)`（同一组 closes 驱动）
//! ② 原始值：插件 CORE（QuickJS 内求值）的 `computeDcapSeries` / `dcapRoi` ⟷
//!    前端模块（V8/node 求值）同名导出的 `computeDcapSeries` / `dcapRoi`
//! 断言：每条线、每根 bar **逐位相等**（IEEE754 位串；null 位置一致）。
//!
//! ── 为什么必须「实测 vs 实测」，不得冻结黄金值 ────────────────────────────────────
//! `02-spec.md` §0 钉死的累加序文字与该节 r=1.2 示例值在 1–2 ulp 上**互不吻合**
//! （实测：按字面规则 newest→oldest 得 0.0045787545787545625，另一合法排布得 …7547845）；
//! T1 对 r≠1 只用 1e-12 容差正是为此。T4 要求逐位 ⇒ 只能两侧同时实测比对，任何一侧的位都不得冻结。
//!
//! ── 为什么浮点一律用「十六进制位串」传输，不用 JSON 十进制 ───────────────────────────
//! 实测（2026-09-13，本机 serde_json 1.0.151）：`serde_json::from_str::<f64>("57.329040578513684")`
//! 得到 `0x404caa1e006de2f7`，而正确舍入值（`str::parse`）是 `0x404caa1e006de2f8` —— **差 1 ulp**。
//! 即 serde_json 的浮点**解析**并非正确舍入 ⇒ 若用十进制 JSON 传浮点，跨运行时比对会被
//! 解析误差污染（假红/漏检）。因此：
//!   · 所有浮点输入（closes/params）与本测试的期望值，一律以 16 位十六进制位串传输；
//!   · 两侧用**同一段** DataView 助手（`BITS_JS_HELPER`）做 hex↔f64 转换；
//!   · 比较器遇到十进制 Number 直接判失败（fail-closed，防止有人把十进制通道加回来）。
//!
//! ── 契约前提（给实现方）─────────────────────────────────────────────────────────
//! CORE 区间内必须定义顶层函数 `dcapRoi` / `smoothSeries` / `computeDcapSeries` / `dcapScore`
//! （与 `02-spec.md` §4 的导出名同名），且 CORE 为无类型注解的 ES2015 子集（rquickjs 直接求值）。
//! 插件侧 `on_bar` 依赖 `ctx.params` 的 9 个键全部存在（本测试显式传全量参数）。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use backtest::{Bar, ParamValue, StrategyParams};
use rquickjs::context::intrinsic::{Eval, Json, TypedArrays};
use rquickjs::{Context as QjsContext, Runtime as QjsRuntime};
use serde_json::{json, Value};
use strategy_runtime::{BarCtx, PluginRuntime, QuickJsRuntime, RuntimeLimits};

// ---------------------------------------------------------------------------
// 位串工具（Rust 侧）
// ---------------------------------------------------------------------------

fn f64_hex(v: f64) -> String {
    format!("{:016x}", v.to_bits())
}

fn hex_to_f64(h: &str) -> f64 {
    f64::from_bits(
        u64::from_str_radix(h, 16)
            .unwrap_or_else(|e| panic!("非法十六进制位串 {h:?}（应为 16 位 hex）：{e}")),
    )
}

fn hex_show(h: &Value) -> String {
    match h.as_str() {
        Some(s) => format!("{s}({})", hex_to_f64(s)),
        None => format!("{h}"),
    }
}

/// 两侧共用的 JS 位串助手（node 与 QuickJS 必须逐字节同源）。
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
// 路径
// ---------------------------------------------------------------------------

/// 仓库根 = `crates/strategy-runtime` 上溯两层。
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn ts_product_path() -> PathBuf {
    repo_root().join("web/src/features/indicators/dcap.ts")
}

fn js_product_path() -> PathBuf {
    repo_root().join("crates/strategy-core/reference-plugins/dcap.js")
}

fn read_product(path: &Path, label: &str) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "{label} 读取失败：{path:?}（{e}）\n\
             两个产物应由 `entangled tangle` 从 design/14-dcap-indicator/02-spec.md 生成（ADR-021 D1/D2）。"
        )
    })
}

// ---------------------------------------------------------------------------
// 临时工作目录（全部写在 /tmp，用完即删；绝不写仓库）
// ---------------------------------------------------------------------------

struct Workdir(PathBuf);

impl Workdir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("dcap-xrt-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap_or_else(|e| panic!("创建临时目录失败 {p:?}: {e}"));
        Self(p)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Workdir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------
// 样例集（≥ 20 组，其中 ≥ 5 组 r≠1；参数满足强制约束 n_s < n_m < n_l）
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Params {
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

impl Params {
    /// 传给 JS 的参数对象：键名与 `DcapParams`/插件 `PARAMS_SCHEMA` 一致，值全部为 hex 位串。
    fn hex_json(&self) -> Value {
        json!({
            "n_s": f64_hex(self.n_s), "n_m": f64_hex(self.n_m), "n_l": f64_hex(self.n_l),
            "r_s": f64_hex(self.r_s), "r_m": f64_hex(self.r_m), "r_l": f64_hex(self.r_l),
            "smooth": f64_hex(self.smooth), "m": f64_hex(self.m), "th": f64_hex(self.th),
        })
    }

    fn has_r_ne_one(&self) -> bool {
        self.r_s != 1.0 || self.r_m != 1.0 || self.r_l != 1.0
    }

    fn with_smooth_m(&self, smooth: f64, m: f64) -> Self {
        Self { smooth, m, ..*self }
    }
}

#[derive(Clone)]
struct Sample {
    name: &'static str,
    closes: Vec<f64>,
    p: Params,
}

impl Sample {
    fn to_json(&self) -> Value {
        let closes: Vec<String> = self.closes.iter().map(|v| f64_hex(*v)).collect();
        json!({ "name": self.name, "closes": closes, "params": self.p.hex_json() })
    }
}

/// 确定性合成序列（纯算术构造，无 RNG / 无时间依赖）。
fn synth(len: usize) -> Vec<f64> {
    (0..len)
        .map(|i| 10.0 + (((i * 37) % 11) as f64 - 5.0) * 0.3)
        .collect()
}

/// 真实 15m closes（数据面只读抽样，冻结）：
/// `psql "$EESTOCK_TEST_DATABASE_URL" -At -c "SET extra_float_digits=3;
///  SELECT ts::text||'|'||close::text FROM kline_accurate_15m WHERE code='518880'
///  ORDER BY ts DESC LIMIT 64"`（只读 SELECT，未写库；未触碰生产线）
const REAL_518880_M15_64: [f64; 64] = [
    9.197, 9.188, 9.187, 9.196, 9.192, 9.185, 9.188, 9.176, 9.161, 9.164, 9.061, 9.062, 9.047, 9.054,
    9.066, 9.058, 9.057, 9.057, 9.058, 9.045, 9.054, 9.048, 9.034, 9.027, 9.025, 9.03, 9.024, 9.024,
    9.101, 9.089, 9.094, 9.084, 9.067, 9.045, 9.054, 9.048, 9.047, 9.017, 9.012, 9.027, 9.039, 9.041,
    9.03, 9.039, 9.042, 9.041, 9.073, 9.073, 9.096, 9.096, 9.076, 9.072, 9.087, 9.084, 9.083, 8.906,
    8.907, 8.922, 8.935, 8.958, 8.941, 8.938, 8.942, 8.943,
];

fn real64() -> Vec<f64> {
    REAL_518880_M15_64.to_vec()
}

fn samples() -> Vec<Sample> {
    let mut v: Vec<Sample> = Vec::new();
    let mut push = |name: &'static str, closes: Vec<f64>, p: Params| v.push(Sample { name, closes, p });

    // 手算 3 根（02-spec T1 样例）
    push(
        "hand3_smooth0_r1",
        vec![100.0, 90.0, 95.0],
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.01 },
    );
    push(
        "hand3_smooth0_r12",
        vec![100.0, 90.0, 95.0],
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.2, r_m: 1.2, r_l: 1.2, smooth: 0.0, m: 3.0, th: 0.01 },
    );
    push(
        "hand3_smooth0_r_mixed",
        vec![100.0, 90.0, 95.0],
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 0.5, r_m: 1.0, r_l: 2.0, smooth: 0.0, m: 3.0, th: 0.5 },
    );
    push(
        "hand3_smooth1_m2",
        vec![100.0, 90.0, 95.0],
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 2.0, th: 0.5 },
    );
    push(
        "hand3_smooth1_m3_allnull",
        vec![100.0, 90.0, 95.0],
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 3.0, th: 0.01 },
    );

    // 边界：空 / 单根 / 恰好 n_s / l 线首次有值的前后一根
    push(
        "empty_closes",
        vec![],
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.01 },
    );
    push(
        "single_bar",
        vec![100.0],
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.01 },
    );
    push(
        "exactly_n_s_r_ne_1",
        synth(2),
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.01, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.5 },
    );
    push(
        "boundary_first_l_smooth1",
        synth(6),
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 3.0, th: 0.5 },
    );
    push(
        "boundary_before_first_l",
        synth(5),
        Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 3.0, th: 0.5 },
    );

    // 合成 20 根
    push(
        "synth20_r1_smooth0",
        synth(20),
        Params { n_s: 3.0, n_m: 6.0, n_l: 10.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.01 },
    );
    push(
        "synth20_r1_smooth1_m3",
        synth(20),
        Params { n_s: 3.0, n_m: 6.0, n_l: 10.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 3.0, th: 0.01 },
    );
    push(
        "synth20_r_mixed_smooth0",
        synth(20),
        Params { n_s: 3.0, n_m: 6.0, n_l: 10.0, r_s: 1.05, r_m: 1.2, r_l: 2.0, smooth: 0.0, m: 3.0, th: 0.5 },
    );
    push(
        "synth20_r_mixed_smooth1_m5",
        synth(20),
        Params { n_s: 3.0, n_m: 6.0, n_l: 10.0, r_s: 0.9, r_m: 1.1, r_l: 1.5, smooth: 1.0, m: 5.0, th: 0.5 },
    );
    push(
        "synth20_r05_short_windows",
        synth(20),
        Params { n_s: 2.0, n_m: 3.0, n_l: 5.0, r_s: 0.5, r_m: 0.6, r_l: 0.75, smooth: 0.0, m: 3.0, th: 0.05 },
    );

    // 真实 15m 64 根
    push(
        "real64_default_r1_m3",
        real64(),
        Params { n_s: 8.0, n_m: 26.0, n_l: 60.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 3.0, th: 0.5 },
    );
    push(
        "real64_r12_mixed_m3",
        real64(),
        Params { n_s: 8.0, n_m: 26.0, n_l: 60.0, r_s: 1.0, r_m: 1.2, r_l: 2.0, smooth: 1.0, m: 3.0, th: 0.5 },
    );
    push(
        "real64_r_mixed_smooth0",
        real64(),
        Params { n_s: 8.0, n_m: 26.0, n_l: 60.0, r_s: 0.5, r_m: 0.75, r_l: 1.5, smooth: 0.0, m: 3.0, th: 0.5 },
    );
    push(
        "real64_m1",
        real64(),
        Params { n_s: 8.0, n_m: 26.0, n_l: 60.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 1.0, th: 0.5 },
    );
    push(
        "real64_th0001_maxsens",
        real64(),
        Params { n_s: 8.0, n_m: 26.0, n_l: 60.0, r_s: 1.02, r_m: 1.2, r_l: 1.5, smooth: 0.0, m: 3.0, th: 0.001 },
    );

    // 更大窗口 / 极值 r
    push(
        "synth64_r_ne_1_m10",
        synth(64),
        Params { n_s: 5.0, n_m: 10.0, n_l: 20.0, r_s: 1.02, r_m: 1.1, r_l: 1.3, smooth: 1.0, m: 10.0, th: 0.5 },
    );
    push(
        "synth250_max_n_r2",
        synth(250),
        Params { n_s: 8.0, n_m: 60.0, n_l: 250.0, r_s: 1.0, r_m: 1.2, r_l: 2.0, smooth: 0.0, m: 3.0, th: 0.5 },
    );
    push(
        "synth250_r05",
        synth(250),
        Params { n_s: 8.0, n_m: 60.0, n_l: 250.0, r_s: 0.5, r_m: 0.6, r_l: 0.75, smooth: 0.0, m: 3.0, th: 0.5 },
    );
    push(
        "synth300_near_one_r",
        synth(300),
        Params { n_s: 8.0, n_m: 26.0, n_l: 60.0, r_s: 1.0, r_m: 1.001, r_l: 1.2, smooth: 1.0, m: 3.0, th: 0.2 },
    );

    v
}

// ---------------------------------------------------------------------------
// 插件侧：QuickJS 求值
// ---------------------------------------------------------------------------

fn strategy_params(p: &Params) -> StrategyParams {
    StrategyParams::from([
        ("n_s".to_string(), ParamValue::Num(p.n_s)),
        ("n_m".to_string(), ParamValue::Num(p.n_m)),
        ("n_l".to_string(), ParamValue::Num(p.n_l)),
        ("r_s".to_string(), ParamValue::Num(p.r_s)),
        ("r_m".to_string(), ParamValue::Num(p.r_m)),
        ("r_l".to_string(), ParamValue::Num(p.r_l)),
        ("smooth".to_string(), ParamValue::Num(p.smooth)),
        ("m".to_string(), ParamValue::Num(p.m)),
        ("th".to_string(), ParamValue::Num(p.th)),
    ])
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

/// 插件侧比较对象 ①：`on_bar` 逐 bar 返回的 0–100 分（QuickJS）。
fn quickjs_scores(plugin_src: &str, sample: &Sample, override_sm: Option<(f64, f64)>) -> Vec<f64> {
    let p = match override_sm {
        Some((smooth, m)) => sample.p.with_smooth_m(smooth, m),
        None => sample.p,
    };
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:tester_dcap_xrt", plugin_src, &strategy_params(&p))
        .unwrap_or_else(|e| {
            panic!(
                "插件实例化失败（sample={}）：{e}\n\
                 插件需具备 PARAMS_SCHEMA/init/on_bar（ABI §1/§5；P2 包装层）。",
                sample.name
            )
        });
    let bars = bars_from_closes(&sample.closes);
    bars.iter()
        .enumerate()
        .map(|(i, bar)| {
            let ctx = BarCtx::new(i, bar.clone(), &bars, None);
            inst.on_bar(&ctx)
                .unwrap_or_else(|e| panic!("插件 on_bar 出错（sample={} bar={i}）：{e}", sample.name))
        })
        .collect()
}

/// 插件侧比较对象 ②：CORE 的 `computeDcapSeries` / `dcapRoi`（QuickJS 直接求值，输出 hex 位串）。
fn quickjs_raw(plugin_src: &str, sample: &Sample) -> Value {
    let rt = QjsRuntime::new().unwrap_or_else(|e| panic!("QuickJS Runtime 创建失败：{e}"));
    let ctx = QjsContext::custom::<(Eval, Json, TypedArrays)>(&rt)
        .unwrap_or_else(|e| panic!("QuickJS Context 创建失败：{e}"));

    let closes_hex: Vec<String> = sample.closes.iter().map(|v| format!("\"{}\"", f64_hex(*v))).collect();
    let prologue = format!(
        "{helper}\nvar __closes = [{closes}].map(hexToF64);\nvar __params = {params};\n\
         for (var __k in __params) {{ __params[__k] = hexToF64(__params[__k]); }}\n",
        helper = BITS_JS_HELPER,
        closes = closes_hex.join(","),
        params = serde_json::to_string(&sample.p.hex_json()).expect("params JSON"),
    );
    let expr = r#"JSON.stringify({
  series: computeDcapSeries(__closes, __params).map(function (v) {
    return { s: f64ToHex(v.s), m: f64ToHex(v.m), l: f64ToHex(v.l) };
  }),
  roiByLine: {
    s: f64ToHex(dcapRoi(__closes, __params.n_s, __params.r_s)),
    m: f64ToHex(dcapRoi(__closes, __params.n_m, __params.r_m)),
    l: f64ToHex(dcapRoi(__closes, __params.n_l, __params.r_l))
  }
})"#;

    ctx.with(|ctx| {
        if let Err(e) = ctx.eval::<(), _>(plugin_src) {
            panic!(
                "插件源码在 QuickJS 求值失败（sample={}）：{e:?} / {} \
                 —— CORE 必须是无类型注解的 ES2015 子集（02-spec §4 契约要求 4）。",
                sample.name,
                catch_text(&ctx)
            );
        }
        if let Err(e) = ctx.eval::<(), _>(prologue.as_str()) {
            panic!(
                "测试助手脚本求值失败（sample={}）：{e:?} / {}",
                sample.name,
                catch_text(&ctx)
            );
        }
        match ctx.eval::<String, _>(expr) {
            Ok(out) => serde_json::from_str(&out)
                .unwrap_or_else(|e| panic!("QuickJS 输出不是合法 JSON：{e}；原始={out}")),
            Err(e) => panic!(
                "CORE 未按契约暴露顶层函数 dcapRoi/computeDcapSeries（sample={}）：{e:?} / {}",
                sample.name,
                catch_text(&ctx)
            ),
        }
    })
}

/// 异常可读化（仅用于失败信息；不影响断言语义）。
fn catch_text(ctx: &rquickjs::Ctx<'_>) -> String {
    let caught = ctx.catch();
    match ctx.json_stringify(caught) {
        Ok(Some(s)) => s
            .to_string()
            .unwrap_or_else(|e| format!("<异常对象 UTF-8 转换失败: {e}>")),
        Ok(None) => "<异常对象不可 JSON 序列化>".to_string(),
        Err(e) => format!("<异常对象序列化失败: {e}>"),
    }
}

// ---------------------------------------------------------------------------
// 前端侧：node（V8）求值生成的 .ts
// ---------------------------------------------------------------------------

/// 测试生成的前端驱动器：只从 `dcap.ts` 取数，**不读插件**（保证两侧相互独立）。
/// 输入/输出全部为 hex 位串（见文件头「为什么用十六进制位串」）。
const FRONTEND_DRIVER: &str = concat!(
    r#"
const [, , tsPath, samplesPath] = process.argv;
const { readFileSync } = await import('node:fs');
"#,
    r#"
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
"#,
    r#"
const mod = await import(tsPath);
const samples = JSON.parse(readFileSync(samplesPath, "utf8"));
const out = samples.map((s) => {
  const closes = s.closes.map(hexToF64);
  const params = {};
  for (const k of Object.keys(s.params)) { params[k] = hexToF64(s.params[k]); }
  const series = mod.computeDcapSeries(closes, params);
  return {
    name: s.name,
    series: series.map((v) => ({ s: f64ToHex(v.s), m: f64ToHex(v.m), l: f64ToHex(v.l) })),
    // 前端侧比较对象 ①：dcapScore(values, th)（逐 bar）
    scores: series.map((v) => f64ToHex(mod.dcapScore(v, params.th))),
    // 前端侧比较对象 ②：三线原始值由 dcapRoi 独立给出
    roiByLine: {
      s: f64ToHex(mod.dcapRoi(closes, params.n_s, params.r_s)),
      m: f64ToHex(mod.dcapRoi(closes, params.n_m, params.r_m)),
      l: f64ToHex(mod.dcapRoi(closes, params.n_l, params.r_l)),
    },
  };
});
process.stdout.write(JSON.stringify(out));
"#,
);

fn run_frontend(ts_path: &Path, samples: &[Sample], workdir: &Path) -> Value {
    let driver = workdir.join("frontend_driver.mjs");
    fs::write(&driver, FRONTEND_DRIVER).expect("写 driver.mjs");
    let samples_path = workdir.join("samples.json");
    let arr: Vec<Value> = samples.iter().map(Sample::to_json).collect();
    fs::write(
        &samples_path,
        serde_json::to_string(&Value::Array(arr)).expect("samples JSON"),
    )
    .expect("写 samples.json");

    let out = Command::new("node")
        .arg(&driver)
        .arg(ts_path)
        .arg(&samples_path)
        .output()
        .unwrap_or_else(|e| {
            panic!(
                "T4 需要 node 求值前端模块（V8）：启动 node 失败：{e}\n\
                 （本仓 web 测试已依赖 node；若环境无 node，请先说明再裁定 T4 落点）"
            )
        });
    if !out.status.success() {
        panic!(
            "node 求值前端模块失败（status={:?}）：\nstdout={}\nstderr={}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        let head = String::from_utf8_lossy(&out.stdout);
        let head = &head[..head.len().min(600)];
        panic!("node 输出不是合法 JSON：{e}\nstdout 前 600 字节：{head}")
    })
}

// ---------------------------------------------------------------------------
// 逐位比对（hex 位串；null 位置一致）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Diffs {
    total: usize,
    head: Vec<String>,
}

impl Diffs {
    fn push(&mut self, s: String) {
        self.total += 1;
        if self.head.len() < 12 {
            self.head.push(s);
        }
    }

    fn is_empty(&self) -> bool {
        self.total == 0
    }

    fn report(&self) -> String {
        format!(
            "共 {} 处逐位差异（最多列出 12 条）：\n{}",
            self.total,
            self.head.join("\n")
        )
    }
}

fn compare_f64(path: &str, plugin: f64, frontend: f64, diffs: &mut Diffs) {
    if plugin.to_bits() != frontend.to_bits() {
        diffs.push(format!(
            "{path}: 位串不同 插件={plugin}({}) 前端={frontend}({})",
            f64_hex(plugin),
            f64_hex(frontend)
        ));
    }
}

/// JSON 树逐位比对：两侧浮点一律为 16 位 hex 字符串、null 必须对齐、数组长度必须一致。
/// **遇到十进制 Number 直接判失败**（fail-closed：十进制往返在 serde_json 侧有 1 ulp 解析误差）。
fn compare_json_bitwise(path: &str, plugin: &Value, frontend: &Value, diffs: &mut Diffs) {
    match (plugin, frontend) {
        (Value::Null, Value::Null) => {}
        (Value::String(a), Value::String(b)) => {
            if a != b {
                diffs.push(format!(
                    "{path}: 位串不同 插件={} 前端={}",
                    hex_show(plugin),
                    hex_show(frontend)
                ));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                diffs.push(format!("{path}: 长度不同 插件={} 前端={}", a.len(), b.len()));
            }
            for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
                compare_json_bitwise(&format!("{path}[{i}]"), x, y, diffs);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, x) in a {
                match b.get(k) {
                    Some(y) => compare_json_bitwise(&format!("{path}.{k}"), x, y, diffs),
                    None => diffs.push(format!("{path}.{k}: 插件有该字段、前端无")),
                }
            }
            for k in b.keys() {
                if !a.contains_key(k) {
                    diffs.push(format!("{path}.{k}: 前端有该字段、插件无"));
                }
            }
        }
        (Value::Number(n), _) | (_, Value::Number(n)) => {
            panic!(
                "{path}: 比较对象出现十进制数值 {n} —— 浮点必须走 hex 位串通道\
                 （serde_json 十进制解析非正确舍入，实测可差 1 ulp）"
            );
        }
        _ => diffs.push(format!(
            "{path}: 类型或值不同 插件={plugin} 前端={frontend}"
        )),
    }
}

// ---------------------------------------------------------------------------
// 一次完整跨运行时管线
// ---------------------------------------------------------------------------

struct Pipeline {
    v8: Value,
    qjs_scores: Vec<Vec<f64>>,
    qjs_raw: Vec<Value>,
}

fn run_pipeline(ts_path: &Path, plugin_src: &str, samples: &[Sample], workdir: &Path) -> Pipeline {
    let v8 = run_frontend(ts_path, samples, workdir);
    let qjs_scores = samples
        .iter()
        .map(|s| quickjs_scores(plugin_src, s, None))
        .collect();
    let qjs_raw = samples.iter().map(|s| quickjs_raw(plugin_src, s)).collect();
    Pipeline {
        v8,
        qjs_scores,
        qjs_raw,
    }
}

/// 比较对象 ①：评分（插件 on_bar ⟷ 前端 dcapScore）。
fn diffs_scores(p: &Pipeline, samples: &[Sample]) -> Diffs {
    let mut diffs = Diffs::default();
    for (i, s) in samples.iter().enumerate() {
        let frontend = p.v8[i]["scores"]
            .as_array()
            .unwrap_or_else(|| panic!("前端驱动器输出缺少 scores 数组（sample={}）", s.name));
        let plugin = &p.qjs_scores[i];
        if frontend.len() != plugin.len() {
            diffs.push(format!(
                "T4-score[{}]: bar 数不同 插件={} 前端={}",
                s.name,
                plugin.len(),
                frontend.len()
            ));
            continue;
        }
        for (j, (a, b)) in plugin.iter().zip(frontend.iter()).enumerate() {
            let b_hex = b
                .as_str()
                .unwrap_or_else(|| panic!("前端 scores[{j}] 非 hex 字符串（sample={}）：{b}", s.name));
            compare_f64(
                &format!("T4-score[{}][bar {j}]", s.name),
                *a,
                hex_to_f64(b_hex),
                &mut diffs,
            );
        }
    }
    diffs
}

/// 比较对象 ②：三线原始值 + 单线 ROI（插件 CORE ⟷ 前端模块）。
fn diffs_raw(p: &Pipeline, samples: &[Sample]) -> Diffs {
    let mut diffs = Diffs::default();
    for (i, s) in samples.iter().enumerate() {
        compare_json_bitwise(
            &format!("T4-raw[{}].series", s.name),
            &p.qjs_raw[i]["series"],
            &p.v8[i]["series"],
            &mut diffs,
        );
        compare_json_bitwise(
            &format!("T4-raw[{}].roiByLine", s.name),
            &p.qjs_raw[i]["roiByLine"],
            &p.v8[i]["roiByLine"],
            &mut diffs,
        );
    }
    diffs
}

// ===========================================================================
// 自检：本文件里的比较器/管线必须有鉴别力（用 /tmp 沙箱替身，不碰仓库产物）
// ===========================================================================

/// 沙箱替身：CORE 正文（两端逐字节相同；仅包装层不同）。
const STANDIN_CORE: &str = r#"function dcapRoi(closes, n, r) {
  if (!(n >= 1) || closes.length < n) { return null; }
  var sumA = 0, sumAP = 0, w = 1;
  for (var k = n - 1; k >= 0; k--) {
    var P = closes[closes.length - 1 - (n - 1 - k)];
    sumA += w;
    sumAP += w / P;
    w /= r;
  }
  return (closes[closes.length - 1] * sumAP / sumA - 1) * EPS;
}
function smoothSeries(values, smooth, m) {
  if (smooth === 0 || m <= 1) { /*SMOOTH_OFF*/ var out0 = values.slice(); return out0; }
  return values.slice();
}
function computeDcapSeries(closes, p) {
  var out = [];
  for (var i = 0; i < closes.length; i++) {
    var prefix = closes.slice(0, i + 1);
    out.push({ s: dcapRoi(prefix, p.n_s, p.r_s), m: dcapRoi(prefix, p.n_m, p.r_m), l: dcapRoi(prefix, p.n_l, p.r_l) });
  }
  return out;
}
function dcapScore(v, th) {
  var vals = [];
  if (v.s !== null && v.s !== undefined) { vals.push(v.s); }
  if (v.m !== null && v.m !== undefined) { vals.push(v.m); }
  if (v.l !== null && v.l !== undefined) { vals.push(v.l); }
  if (vals.length === 0) { return 50; }
  var acc = 0;
  for (var i = 0; i < vals.length; i++) {
    var per = vals[i] / th;
    if (per < -1) { per = -1; }
    if (per > 1) { per = 1; }
    acc += per;
  }
  var score = 50 - (50 / vals.length) * acc;
  if (score < 0) { score = 0; }
  if (score > 100) { score = 100; }
  return score;
}"#;

fn standin_ts() -> String {
    format!(
        "// /tmp 沙箱替身（自检用；非仓库产物）\nvar EPS = 1;\n{}\nexport {{ dcapRoi, smoothSeries, computeDcapSeries, dcapScore }};\n",
        STANDIN_CORE
    )
}

fn standin_js() -> String {
    format!(
        "// /tmp 沙箱替身（自检用；非仓库产物）\nvar EPS = 1;\nvar closesWin = [];\nvar PARAMS_SCHEMA = [{{ key: \"n_s\", type: \"int\", default: 8, min: 2, max: 250 }}];\n{}\nfunction init(params) {{ closesWin = []; }}\nfunction on_bar(ctx) {{\n  var p = ctx.params;\n  closesWin.push(ctx.bar.close);\n  if (closesWin.length > p.n_l) {{ closesWin.shift(); }}\n  var raw = {{ s: dcapRoi(closesWin, p.n_s, p.r_s), m: dcapRoi(closesWin, p.n_m, p.r_m), l: dcapRoi(closesWin, p.n_l, p.r_l) }};\n  raw.s = smoothSeries([raw.s], p.smooth, p.m)[0];\n  raw.m = smoothSeries([raw.m], p.smooth, p.m)[0];\n  raw.l = smoothSeries([raw.l], p.smooth, p.m)[0];\n  return dcapScore(raw, p.th);\n}}\n",
        STANDIN_CORE
    )
}

/// 沙箱自检样例：只用 smooth=0（替身不实现真平滑）＋含一条 r≠1。
fn selfcheck_samples() -> Vec<Sample> {
    vec![
        Sample {
            name: "sc_hand3_r1",
            closes: vec![100.0, 90.0, 95.0],
            p: Params { n_s: 2.0, n_m: 3.0, n_l: 4.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.5 },
        },
        Sample {
            name: "sc_synth12_r_ne_1",
            closes: synth(12),
            p: Params { n_s: 2.0, n_m: 4.0, n_l: 7.0, r_s: 1.0, r_m: 1.2, r_l: 2.0, smooth: 0.0, m: 3.0, th: 0.5 },
        },
        Sample {
            name: "sc_synth30_r1",
            closes: synth(30),
            p: Params { n_s: 3.0, n_m: 8.0, n_l: 12.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.02 },
        },
    ]
}

#[test]
fn t4_selfcheck_comparator_teeth_one_ulp_and_sandbox_pipeline() {
    // ── ① 比较器的最小可检差异 = 1 ulp（hex 层面，无需 node/QuickJS） ──
    let x = 0.0018518518518517713_f64;
    let x_up = f64::from_bits(x.to_bits() + 1);
    let mut diffs = Diffs::default();
    compare_json_bitwise("selfcheck", &json!(f64_hex(x)), &json!(f64_hex(x_up)), &mut diffs);
    assert!(!diffs.is_empty(), "比较器必须能识别 1 ulp 差异：{x} vs {x_up}");
    // 反向：完全相同的位串不得报差异（防止比较器「恒红」的退化）
    let mut same = Diffs::default();
    compare_json_bitwise(
        "selfcheck",
        &json!([f64_hex(x), Value::Null]),
        &json!([f64_hex(x), Value::Null]),
        &mut same,
    );
    assert!(same.is_empty(), "相同输入不得报差异：{}", same.report());

    // ── ② /tmp 沙箱替身走完整管线（node V8 × QuickJS × 比较器） ──
    let wd = Workdir::new("selfcheck");
    let ts = wd.path().join("standin.ts");
    let js = wd.path().join("standin.js");
    fs::write(&ts, standin_ts()).expect("写沙箱 .ts");
    fs::write(&js, standin_js()).expect("写沙箱 .js");
    let samples = selfcheck_samples();

    let good = run_pipeline(&ts, &standin_js(), &samples, wd.path());
    let good_scores = diffs_scores(&good, &samples);
    let good_raw = diffs_raw(&good, &samples);
    assert!(
        good_scores.is_empty() && good_raw.is_empty(),
        "管线正例对照（两侧逐字节同源）不得报差异：\n{}\n{}",
        good_scores.report(),
        good_raw.report()
    );

    // ── ③ 哨兵 A：替身 CORE 的 ROI 乘 (1+1e-10) ⇒ 跨运行时比对必须报差异 ──
    let js_eps = standin_js().replace("var EPS = 1;", "var EPS = 1.0000000001;");
    assert_ne!(js_eps, standin_js(), "哨兵 A 注入失败（EPS 锚点缺失）");
    let bad_eps = run_pipeline(&ts, &js_eps, &samples, wd.path());
    let bad_eps_raw = diffs_raw(&bad_eps, &samples);
    assert!(
        !bad_eps_raw.is_empty(),
        "哨兵 A：插件侧 ROI 被近似污染后，T4 原始值比对必须报红（否则断言无鉴别力）"
    );

    // ── ④ 哨兵 B：替身 smooth=0 分支改成近似直通 ⇒ 插件侧 T2 判据必须报红 ──
    // 只污染 smooth===0 这一支（m<=1 仍是精确直通）⇒ 两条路径不再逐位相同，T2 判据必须抓到。
    let js_smooth = standin_js().replace(
        "/*SMOOTH_OFF*/ var out0 = values.slice(); return out0;",
        "/*SMOOTH_OFF*/ var out0 = values.slice(); if (smooth === 0) { out0 = out0.map(function (v) { return v === null ? null : v * 1.0000000001; }); } return out0;",
    );
    assert_ne!(js_smooth, standin_js(), "哨兵 B 注入失败（SMOOTH_OFF 锚点缺失）");
    let probe = &samples[0];
    let off = quickjs_scores(&js_smooth, probe, Some((0.0, 3.0)));
    let m1 = quickjs_scores(&js_smooth, probe, Some((1.0, 1.0)));
    let mut t2 = Diffs::default();
    for (j, (a, b)) in off.iter().zip(m1.iter()).enumerate() {
        compare_f64(&format!("T2-sentinel[bar {j}]"), *a, *b, &mut t2);
    }
    assert!(
        !t2.is_empty(),
        "哨兵 B：smooth=0 被改成近似直通后，插件侧 T2（smooth=0 ≡ m=1）判据必须报红"
    );
}

// ===========================================================================
// T4 真实产物：跨运行时逐位等价
// ===========================================================================

#[test]
fn t4_sample_set_meets_spec() {
    let s = samples();
    assert!(s.len() >= 20, "T4 要求 ≥20 组样例，实际 {}", s.len());
    let r_ne_1 = s.iter().filter(|x| x.p.has_r_ne_one()).count();
    assert!(r_ne_1 >= 5, "T4 要求 ≥5 组 r≠1 样例，实际 {r_ne_1}");
    for x in &s {
        assert!(
            x.p.n_s < x.p.n_m && x.p.n_m < x.p.n_l,
            "样例 {} 违反强制约束 n_s<n_m<n_l",
            x.name
        );
        assert!(
            (2.0..=250.0).contains(&x.p.n_s)
                && (2.0..=250.0).contains(&x.p.n_m)
                && (2.0..=250.0).contains(&x.p.n_l)
                && (0.5..=2.0).contains(&x.p.r_s)
                && (0.5..=2.0).contains(&x.p.r_m)
                && (0.5..=2.0).contains(&x.p.r_l)
                && (1.0..=60.0).contains(&x.p.m)
                && (0.001..=0.5).contains(&x.p.th),
            "样例 {} 参数越界（02-spec §2）",
            x.name
        );
    }
}

#[test]
fn t4_cross_runtime_scores_bit_equal() {
    let samples = samples();
    let plugin = read_product(&js_product_path(), "插件产物 dcap.js");
    let ts = ts_product_path();
    let wd = Workdir::new("scores");
    let pipeline = run_pipeline(&ts, &plugin, &samples, wd.path());
    let diffs = diffs_scores(&pipeline, &samples);
    assert!(
        diffs.is_empty(),
        "T4 评分跨运行时不等（插件 on_bar ⟷ 前端 dcapScore）：\n{}",
        diffs.report()
    );
}

#[test]
fn t4_cross_runtime_raw_series_bit_equal() {
    let samples = samples();
    let plugin = read_product(&js_product_path(), "插件产物 dcap.js");
    let ts = ts_product_path();
    let wd = Workdir::new("raw");
    let pipeline = run_pipeline(&ts, &plugin, &samples, wd.path());
    let diffs = diffs_raw(&pipeline, &samples);
    assert!(
        diffs.is_empty(),
        "T4 三线原始值跨运行时不等（插件 CORE ⟷ 前端 dcapRoi/computeDcapSeries）：\n{}",
        diffs.report()
    );
}

#[test]
fn t2_plugin_smooth_off_equals_m1_bit_equal() {
    let samples = samples();
    let plugin = read_product(&js_product_path(), "插件产物 dcap.js");
    let mut diffs = Diffs::default();
    for s in &samples {
        let off = quickjs_scores(&plugin, s, Some((0.0, 3.0)));
        let m1 = quickjs_scores(&plugin, s, Some((1.0, 1.0)));
        for (j, (a, b)) in off.iter().zip(m1.iter()).enumerate() {
            compare_f64(&format!("T2-plugin[{}][bar {j}]", s.name), *a, *b, &mut diffs);
        }
    }
    assert!(
        diffs.is_empty(),
        "插件侧 smooth=0 必须与 (smooth=1, m=1) 逐位相同：\n{}",
        diffs.report()
    );
}

// ===========================================================================
// T5a —— 非单调 n：跨运行时一致性（归一化必须在 CORE 内，02-spec §4 铁律 5）
// ===========================================================================

/// 非单调 `n` 三元组样例（**故意违反** `n_s < n_m < n_l`；`t4_sample_set_meets_spec`
/// 的守卫只管 `samples()`，本组单独成套，不弱化任何既有断言）。
fn nonmonotonic_samples() -> Vec<Sample> {
    vec![
        Sample {
            name: "t5a_ns_nm_nl_all3",
            closes: synth(30),
            p: Params { n_s: 3.0, n_m: 3.0, n_l: 3.0, r_s: 1.0, r_m: 1.2, r_l: 0.8, smooth: 1.0, m: 3.0, th: 0.02 },
        },
        Sample {
            name: "t5a_nm_eq_nl_5_5",
            closes: synth(30),
            p: Params { n_s: 2.0, n_m: 5.0, n_l: 5.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0.0, m: 3.0, th: 0.05 },
        },
        Sample {
            name: "t5a_reversed_9_6_3",
            closes: synth(30),
            p: Params { n_s: 9.0, n_m: 6.0, n_l: 3.0, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 1.0, m: 4.0, th: 0.01 },
        },
        Sample {
            name: "t5a_ns_eq_nl_4_3_4",
            closes: synth(40),
            p: Params { n_s: 4.0, n_m: 3.0, n_l: 4.0, r_s: 1.05, r_m: 1.0, r_l: 1.2, smooth: 0.0, m: 3.0, th: 0.5 },
        },
    ]
}

/// T5a：**非单调参数**下前端入口与插件面必须逐位一致。
///
/// 口径：归一化写在 CORE 内（02-spec §4 铁律 5）⇒ 两侧对同一组非单调参数解析出同一组
/// 生效 `n`。若有一侧漏归一（只归一插件 `init`、或只归一前端入口），本用例即红。
/// 断言：评分（`on_bar` ⟷ `dcapScore`）与三线原始值（`computeDcapSeries`/`dcapRoi`）逐位相等。
#[test]
fn t5a_cross_runtime_nonmonotonic_params_bit_equal() {
    let samples = nonmonotonic_samples();
    // 用例前提自检：必须真的非单调（否则退化为 T4，失去 T5a 的鉴别力）。
    for s in &samples {
        assert!(
            !(s.p.n_s < s.p.n_m && s.p.n_m < s.p.n_l),
            "T5a 样例 {} 必须非单调（n={}/{}/{}）",
            s.name,
            s.p.n_s,
            s.p.n_m,
            s.p.n_l
        );
    }
    let plugin = read_product(&js_product_path(), "插件产物 dcap.js");
    let ts = ts_product_path();
    let wd = Workdir::new("t5a-nonmono");
    let pipeline = run_pipeline(&ts, &plugin, &samples, wd.path());

    let ds = diffs_scores(&pipeline, &samples);
    assert!(
        ds.is_empty(),
        "T5a 非单调参数下评分跨运行时分叉（插件 on_bar ⟷ 前端 dcapScore）——\
         归一化必须在 CORE 内（02-spec §4 铁律 5）：\n{}",
        ds.report()
    );
    let dr = diffs_raw(&pipeline, &samples);
    assert!(
        dr.is_empty(),
        "T5a 非单调参数下三线原始值跨运行时分叉（插件 CORE ⟷ 前端 dcapRoi/computeDcapSeries）：\n{}",
        dr.report()
    );
}
