//! dcap 插件侧 —— T7（状态持久化 / 重放分叉防线，ABI G3）**位级**一致
//!
//! 本文件位置：`crates/strategy-runtime/tests/dcap_plugin_replay.rs`
//! 被测对象：`crates/strategy-core/reference-plugins/dcap.js`（entangled 生成产物，ADR-021 D2/D4；
//!   本文件**只读**读取；沙箱替身只写 /tmp，用完即删）。
//! 运行：`cargo test -p strategy-runtime --test dcap_plugin_replay -- --nocapture`
//!
//! 权威口径：`design/14-dcap-indicator/02-spec.md` §5（内部状态必须进 `save()/load()`：三条 close
//! 滚动窗口 + 三条 ROI 的 SMA 尾窗）、`design/14-dcap-indicator/03-test-plan.md` T7
//! （「若 `save/load` 漏掉任一窗口/尾窗元素 ⇒ 必须红」+「**位级保真**：`serde_json` 浮点解析
//! 非正确舍入 ⇒ 恢复后必须断言**位级**相等；若序列化确实丢 1 ulp，必须改位串/整型编码，
//! 或上报为架构级问题——**不得**把断言放成容差」）。
//!
//! ── 本文件钉死的口径 ──────────────────────────────────────────────────────────
//! 1. **T7-e2e**：同一段 bar 序列，「连续跑」与「跑到 split → `save()` → 新实例 `load()` → 续跑」
//!    的分数序列必须**逐位相同**（IEEE754 位串；含 split 之前的重合段，证明夹具自身确定）。
//! 2. **T7-teeth**：故意从 `save()` 删掉一个状态字段（close 窗口 / SMA 尾窗）后，同一判据
//!    **必须报红**（否则断言无鉴别力；03-test-plan P2 明确要求本用例「真红过一次」）。
//! 3. **T7-channel**（证据探针）：平台 `save/load` 通道 = `QuickJS JSON.stringify`
//!    → `serde_json::from_str::<Value>`（`quickjs.rs:272-277`）→ `serde_json::to_string`
//!    → `JSON.parse`（`quickjs.rs:289-292`）。浮点十进制往返若**不是位级保真**，
//!    则 T7-e2e 在任何插件实现下都不可能稳定为绿 ⇒ 属架构级问题。本探针把该通道性质
//!    作为**独立断言**钉住（红 = 架构级问题证据，不是范围外测试）。
//!
//! ── 浮点传输纪律 ──
//! 诊断输出与期望值一律以 16 位 hex 位串呈现（不接受十进制近似阅读）。

use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

use backtest::{Bar, ParamValue, StrategyParams};
use strategy_runtime::{BarCtx, PluginInstance, PluginRuntime, QuickJsRuntime, RuntimeLimits};

// ---------------------------------------------------------------------------
// 产物读取
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

fn f64_hex(v: f64) -> String {
    format!("{:016x}", v.to_bits())
}

// ---------------------------------------------------------------------------
// 参数 / bar 夹具
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
}

/// 确定性合成序列（纯算术构造，无 RNG / 无时间依赖）。
fn synth(len: usize) -> Vec<f64> {
    (0..len)
        .map(|i| 10.0 + (((i * 37) % 11) as f64 - 5.0) * 0.3)
        .collect()
}

/// 真实 15m closes（数据面**只读**抽样，冻结；与 `crates/strategy-runtime/tests/dcap_cross_runtime.rs`
/// 同源同值，抽样命令见该文件头）：
/// `psql "$EESTOCK_TEST_DATABASE_URL" -At -c "SET extra_float_digits=3;
///  SELECT ts::text||'|'||close::text FROM kline_accurate_15m WHERE code='518880'
///  ORDER BY ts DESC LIMIT 64"`（只读 SELECT；未写库、未起服务）。
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

// ---------------------------------------------------------------------------
// 运行 / 比较工具
// ---------------------------------------------------------------------------

fn instantiate(rt: &mut QuickJsRuntime, src: &str, p: &P) -> Box<dyn PluginInstance> {
    rt.instantiate("sha256:tester_dcap_replay", src, &p.params())
        .unwrap_or_else(|e| panic!("插件实例化失败（P={p:?}）：{e}\n（P2 包装层：PARAMS_SCHEMA/init/on_bar）"))
}

/// 在**绝对下标**上推进实例（`BarCtx::index` = 绝对 bar 号，`bctx.bars` = 全量序列，与引擎一致）。
fn advance(inst: &mut Box<dyn PluginInstance>, bars: &[Bar], range: Range<usize>) -> Vec<f64> {
    range
        .map(|i| {
            let ctx = BarCtx::new(i, bars[i].clone(), bars, None);
            inst.on_bar(&ctx)
                .unwrap_or_else(|e| panic!("on_bar 出错（bar {i}）：{e}"))
        })
        .collect()
}

/// 逐位比较两段分数（绝对下标对齐），返回不一致清单（含位串）。
fn diff_scores(abs_offset: usize, a: &[f64], b: &[f64]) -> Vec<String> {
    let mut out = Vec::new();
    if a.len() != b.len() {
        out.push(format!("长度不同：{} vs {}", a.len(), b.len()));
        return out;
    }
    for (k, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        if x.to_bits() != y.to_bits() {
            out.push(format!(
                "bar {}：连续跑={x}({}) 恢复续跑={y}({})",
                abs_offset + k,
                f64_hex(*x),
                f64_hex(*y)
            ));
        }
    }
    out
}

fn snapshot(inst: &Box<dyn PluginInstance>) -> serde_json::Value {
    inst.save()
        .unwrap_or_else(|e| panic!("save() 必须成功（ABI G3 / MAJOR-1：不得折叠为 None）：{e}"))
        .expect("dcap 必须提供 save()（ABI G3：缺 save/load ⇒ 重放分叉）")
}

/// 一次完整「分段重放」实验：返回 (连续跑分数, split 前段分数, 恢复续跑分数, 快照)。
fn replay_experiment(
    src: &str,
    p: &P,
    closes: &[f64],
    split: usize,
) -> (Vec<f64>, Vec<f64>, Vec<f64>, serde_json::Value) {
    let bars = bars_from_closes(closes);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());

    let mut continuous = instantiate(&mut rt, src, p);
    let continuous_scores = advance(&mut continuous, &bars, 0..bars.len());

    let mut first = instantiate(&mut rt, src, p);
    let before = advance(&mut first, &bars, 0..split);
    let snap = snapshot(&first);

    let mut restored = instantiate(&mut rt, src, p);
    restored
        .load(&snap)
        .unwrap_or_else(|e| panic!("load(快照) 失败（P2 包装层）：{e}"));
    let after = advance(&mut restored, &bars, split..bars.len());

    (continuous_scores, before, after, snap)
}

// ---------------------------------------------------------------------------
// 沙箱替身（/tmp；只用于验证本文件判据「有鉴别力」）
// ---------------------------------------------------------------------------

/// 删除 `save()` 中一个字段（模拟「漏存窗口/尾窗」），用于哨兵。
fn mutate_drop_save_field(src: &str, field: &str) -> String {
    let needle = format!("{field}: {field}.slice(), ");
    assert!(
        src.contains(&needle),
        "哨兵注入锚点缺失：save() 中未找到 {needle:?} —— \
         请检查 02-spec §5「内部状态」的 save() 形状是否变更（本哨兵不得静默跳过）"
    );
    src.replace(&needle, "")
}

// ===========================================================================
// T7-e2e —— 连续跑 vs 中途 save→load 续跑：逐位相同
// ===========================================================================

#[test]
fn t7_replay_continuation_scores_bit_equal() {
    let src = read_product();
    // r≠1 + smooth=1：三条线都产出全精度 ROI，尾窗参与 SMA ⇒ 状态面最敏感。
    let p = dcap_params();

    for (name, closes) in [("synth64", synth(64)), ("real518880_m15_64", real64())] {
        for split in [20usize, 60usize] {
            let (continuous, before, after, snap) = replay_experiment(&src, &p, &closes, split);

            // 夹具自检：分段前段与连续跑的前段必须逐位相同（否则比较基线本身不确定）。
            let pre = diff_scores(0, &continuous[..split], &before);
            assert!(
                pre.is_empty(),
                "[T7-e2e] {name} split={split}：split 之前的重合段必须逐位相同（夹具不确定性）：\n{}",
                pre.join("\n")
            );

            let diffs = diff_scores(split, &continuous[split..], &after);
            assert!(
                diffs.is_empty(),
                "[T7-e2e] {name} split={split}：save→load→续跑与连续跑必须**逐位**相同\
                 （ABI G3；02-spec §5 内部状态：三条 close 窗口 + 三条 SMA 尾窗全部必须进快照）。\n\
                 快照键={:?}\n不一致 {} 处（最多列 10）：\n{}",
                snap.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()),
                diffs.len(),
                diffs.iter().take(10).cloned().collect::<Vec<_>>().join("\n")
            );
        }
    }
}

// ===========================================================================
// T7-teeth —— 漏存字段必须被抓到
// ===========================================================================

#[test]
fn t7_selftest_missing_save_field_is_detected() {
    let src = read_product();
    let closes = real64();
    let p = dcap_params();
    let split = 30usize;

    // ① 漏存 close 滚动窗口（winS）⇒ 恢复后 s 线缺历史 ⇒ 必须报差异。
    let drop_win = mutate_drop_save_field(&src, "winS");
    let (c1, _, a1, _) = replay_experiment(&drop_win, &p, &closes, split);
    assert!(
        !diff_scores(split, &c1[split..], &a1).is_empty(),
        "[T7-teeth] save() 漏存 winS 后，位级判据必须报红（否则 T7 无鉴别力）"
    );

    // ② 漏存 SMA 尾窗（tailS）⇒ 恢复后 s 线平滑值一度为 null ⇒ 必须报差异。
    let drop_tail = mutate_drop_save_field(&src, "tailS");
    let (c2, _, a2, _) = replay_experiment(&drop_tail, &p, &closes, split);
    assert!(
        !diff_scores(split, &c2[split..], &a2).is_empty(),
        "[T7-teeth] save() 漏存 tailS 后，位级判据必须报红（否则 T7 无鉴别力）"
    );

    // ③ 参照输出（不构成断言；仅便于区分「判据坏了」与「产物坏了」）：
    //    未注入产物在同一 split 上的逐位差异数。0 表示产物位级保真；>0 见 T7-e2e 的证据。
    let (c3, _, a3, _) = replay_experiment(&src, &p, &closes, split);
    let clean = diff_scores(split, &c3[split..], &a3);
    println!(
        "[T7-teeth] 未注入产物 split={split} 逐位差异数 = {}（0 = 位级保真；>0 = 产物/通道问题）",
        clean.len()
    );
}

// ===========================================================================
// T7-channel —— 平台 save/load 通道的位级保真（证据探针）
// ===========================================================================

/// 递归收集 JSON 中的全部浮点数（路径, 值）。
fn collect_floats(v: &serde_json::Value, path: &str, out: &mut Vec<(String, f64)>) {
    match v {
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                out.push((path.to_string(), f));
            }
        }
        serde_json::Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                collect_floats(x, &format!("{path}[{i}]"), out);
            }
        }
        serde_json::Value::Object(o) => {
            for (k, x) in o {
                collect_floats(x, &format!("{path}.{k}"), out);
            }
        }
        _ => {}
    }
}

#[test]
fn t7_channel_probe_channel_is_not_bit_exact() {
    let mut findings: Vec<String> = Vec::new();

    // ── (a) 最小复现：`serde_json` 的十进制浮点**解析**非正确舍入 ──
    // 样本取自真实数据上 dcap ROI 的量级/形态（见本 crate `dcap_cross_runtime.rs` 实测记录）。
    let samples = [
        "-0.011674411920738925",
        "57.329040578513684",
        "-0.0045787545787545625",
        "0.0045787545787547845",
    ];
    let mut bad_a: Vec<String> = Vec::new();
    for s in samples {
        let correct: f64 = s.parse().expect("str::parse");
        let via_serde: f64 = serde_json::from_str::<f64>(s).expect("serde_json::from_str");
        if correct.to_bits() != via_serde.to_bits() {
            bad_a.push(format!(
                "  {s}: str::parse={}({}) serde_json::from_str={}({}) 差 {} ulp",
                correct,
                f64_hex(correct),
                via_serde,
                f64_hex(via_serde),
                (via_serde.to_bits() as i128 - correct.to_bits() as i128).abs()
            ));
        }
    }
    if !bad_a.is_empty() {
        findings.push(format!(
            "(a) `serde_json` 十进制解析非正确舍入（平台通道 core，见 crates/strategy-runtime/src/quickjs.rs:272-277）：\n{}",
            bad_a.join("\n")
        ));
    }

    // ── (b) 端到端：平台 `save()/load()` API 上「位级保真」可被直接证伪 ──
    // 沙箱插件（内存字符串，不落盘、不进仓库）：状态里持有一个最短十进制表示会触发
    // `serde_json` 误舍入的 f64；`on_bar` 原样返回该值（∈[0,100]，clamp 不变）。
    let sandbox = r#"
const PARAMS_SCHEMA = [];
let v = null;
function init(params) { v = 57.329040578513684; }
function on_bar(ctx) { return v; }
function save() { return { v: v }; }
function load(state) { v = state.v; }
"#;
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut orig = instantiate(&mut rt, sandbox, &probe_params());
    let bars = bars_from_closes(&[100.0]);
    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    let before = orig.on_bar(&ctx).expect("原始实例 on_bar");
    let snap = snapshot(&orig);
    let mut restored = instantiate(&mut rt, sandbox, &probe_params());
    restored.load(&snap).expect("load(快照)");
    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    let after = restored.on_bar(&ctx).expect("恢复实例 on_bar");
    if before.to_bits() != after.to_bits() {
        findings.push(format!(
            "(b) 平台 `save()→load()` 现场可证伪「位级保真」：\n             起始值={before}({}) 经 save→load 后={after}({})，差 {} ulp（快照={snap}）",
            f64_hex(before),
            f64_hex(after),
            (after.to_bits() as i128 - before.to_bits() as i128).abs()
        ));
    }

    // ── (c) dcap 真实快照：其中是否有浮点数无法位级往返（本次数据集的经验事实）──
    let src = read_product();
    let closes = real64();
    let (_, _, _, snap_dcap) = replay_experiment(&src, &dcap_params(), &closes, 30);
    let mut floats = Vec::new();
    collect_floats(&snap_dcap, "state", &mut floats);
    let mut unstable: Vec<String> = Vec::new();
    for (path, v) in &floats {
        let j = serde_json::to_string(v).expect("to_string");
        let back: f64 = serde_json::from_str(&j).expect("from_str");
        if back.to_bits() != v.to_bits() {
            unstable.push(format!(
                "  {path}={v}({}) → {back}({})",
                f64_hex(*v),
                f64_hex(back)
            ));
        }
    }
    if !unstable.is_empty() {
        findings.push(format!(
            "(c) dcap 快照共 {} 个浮点数，其中 {} 个经平台通道后位级改变：\n{}",
            floats.len(),
            unstable.len(),
            unstable.join("\n")
        ));
    } else {
        println!(
            "[T7-channel] (c) 本次数据集（real518880_m15_64, split=30）的 dcap 快照共 {} 个浮点数，全部位级可往返（未命中误舍入样本）——\n             即平台通道**对特定值丢 1 ulp** 的能力存在（(a)/(b) 已证），但本数据集未触发 ⇒ 属**潜在**位级保真缺陷，不是「本数据集已复现」。",
            floats.len()
        );
    }

    assert!(
        findings.is_empty(),
        "[T7-channel] 平台状态通道（ABI G3：`save()/load()`）不具备位级保真 ⇒ 架构级问题\n         （03-test-plan T7 明确：若序列化确实丢 1 ulp，必须改为位串/整型编码，或上报为架构级问题；\n         **不得**把断言放成容差）。证据：\n{}",
        findings.join("\n")
    );
}

/// 通道探针用参数（与 dcap 无关；仅占位，插件不读 ctx.params）。
fn probe_params() -> P {
    P {
        n_s: 1.0,
        n_m: 1.0,
        n_l: 1.0,
        r_s: 1.0,
        r_m: 1.0,
        r_l: 1.0,
        smooth: 0.0,
        m: 1.0,
        th: 0.01,
    }
}

/// T7 主用例所用参数（r≠1 + smooth=1：三线皆为全精度 ROI，尾窗参与 SMA）。
fn dcap_params() -> P {
    P {
        n_s: 3.0,
        n_m: 8.0,
        n_l: 20.0,
        r_s: 1.0,
        r_m: 1.2,
        r_l: 1.5,
        smooth: 1.0,
        m: 3.0,
        th: 0.01,
    }
}
