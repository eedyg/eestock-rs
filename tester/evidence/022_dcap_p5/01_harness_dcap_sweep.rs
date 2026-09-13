//! P5 — dcap 有效性验证（SWEEP IS/OOS）研究用 harness。
//!
//! 位置：**隔离 worktree** 内的 example（不入主树、不提交）。
//! 口径：**in-process 库调用**，直接构造 [`StrategySlot`]（真插件源码 = 生产 dcap.js，
//! `include_str!` 同源）+ `ExecutionPolicy::LumpSum{1.0}` + bars 序列 → [`run_ensemble_with_quickjs`]。
//! 不经 HTTP、不起服务、不写生产数据面（bars 来自落盘 CSV 快照，无 DB 访问）。
//!
//! 用法：
//! ```text
//! cargo run --release --example dcap_sweep -- \
//!     --data-dir /tmp/dcap_p5_data --out /tmp/dcap_p5_out/grid_all.csv \
//!     --code-hash <sha256(dcap.js)>
//! cargo run --release --example dcap_sweep -- --selftest
//! ```
//!
//! 扫描空间（任务书）：n=(8,26,60) 固定、r ∈ {1.00,1.05,1.2}（三线同值）、m ∈ {1,3,5}、
//! smooth=1、th=0.01；IS=前 70%（`cut = int(n*0.7)`，与 ladder SWEEP 同式）、OOS=后 30%。
//! warmup 语义 = 平台口径（预热段在区间之前取、不计绩效）：OOS 段取 IS 尾部 60+m-1 根预热。

use std::collections::HashMap;

use std::fs;

use backtest::{Bar, FeeModel, ParamValue, Period, StrategyParams};
use strategy_core::engine::run_ensemble_with_quickjs;
use strategy_core::{EnsembleConfig, ExecutionPolicy, StrategySlot};
use strategy_runtime::RuntimeLimits;

/// 生产插件源码（与 `reference.rs` 播种的同一文件，逐字节）。
const DCAP_CODE: &str = include_str!("../reference-plugins/dcap.js");
/// 基准用恒分插件：80 ≥ buy_threshold(60) → 恒 Buy；配合 LumpSum 1.0 = 等权买入持有。
const BUYHOLD_CODE: &str = "function on_bar(ctx) { return 80; }";

const SYMBOLS: [&str; 7] = [
    "510050", "510880", "512800", "512480", "513050", "518880", "159985",
];
const N_S: f64 = 8.0;
const N_M: f64 = 26.0;
const N_L: f64 = 60.0;
const SMOOTH: f64 = 1.0;
const TH: f64 = 0.01;
const R_VALUES: [f64; 3] = [1.00, 1.05, 1.20];
const M_VALUES: [f64; 3] = [1.0, 3.0, 5.0];
const CAPITAL: f64 = 1_000_000.0;
/// 与 ladder SWEEP 同费率口径：0.03%（=0.0003 分数，双边）、无最低佣金、ETF 无印花税、无滑点。
/// FeeModel 的 commission_rate_pct 为百分数 ⇒ 0.03。
const FEE: FeeModel = FeeModel {
    commission_rate_pct: 0.03,
    min_commission: 0.0,
    stamp_duty_pct: 0.0,
    slippage_bp: 0.0,
};

// ── 数据装载 ────────────────────────────────────────────────────────────────

/// 日期（YYYY-MM-DD）→ Unix 秒（UTC 零点）；Howard Hinnant days_from_civil。
fn date_ts(d: &str) -> i64 {
    let p: Vec<i32> = d.split('-').map(|x| x.parse().unwrap()).collect();
    let (y, m, dd) = (p[0] as i64, p[1] as i64, p[2] as i64);
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + dd - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146097 + doe - 719468) * 86400
}

fn parse_csv(text: &str) -> Vec<Bar> {
    text.lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split(',').collect();
            assert_eq!(f.len(), 5, "CSV 列数异常: {l}");
            Bar {
                ts: date_ts(f[0]),
                open: f[1].parse().unwrap(),
                high: f[2].parse().unwrap(),
                low: f[3].parse().unwrap(),
                close: f[4].parse().unwrap(),
                volume: 0.0,
            }
        })
        .collect()
}

fn load_symbol(dir: &str, code: &str) -> Vec<Bar> {
    let text = fs::read_to_string(format!("{dir}/{code}.csv"))
        .unwrap_or_else(|e| panic!("读取 {dir}/{code}.csv 失败: {e}"));
    let bars = parse_csv(&text);
    assert!(bars.len() > 500, "{code} bars 太少: {}", bars.len());
    bars
}

/// IS/OOS 切分（与 ladder SWEEP 同式：`cut = int(n*0.7)`）。
fn segment_cut(n: usize) -> usize {
    (n as f64 * 0.7) as usize
}

// ── 单次运行 ────────────────────────────────────────────────────────────────

struct Row {
    in_range_bars: usize,
    total_return: f64,
    annualized: f64,
    max_drawdown: f64,
    sharpe: f64,
    win_rate: f64,
    profit_factor: f64,
    trade_count: usize,
    avg_hold_bars: f64,
    final_equity: f64,
    buy_signals: usize,
    sell_signals: usize,
    plugin_errors: usize,
}

/// 组合定义：三条线各自的 r（主网格 = 三线同值；扩展网格另含差异化配置）。
#[derive(Clone, Copy)]
struct Combo {
    rs: f64,
    rm: f64,
    rl: f64,
    m: f64,
}

/// 主网格：r ∈ {1.00,1.05,1.20}（三线同值）× m ∈ {1,3,5}。
fn primary_combos() -> Vec<Combo> {
    let mut v = Vec::new();
    for r in R_VALUES {
        for m in M_VALUES {
            v.push(Combo { rs: r, rm: r, rl: r, m });
        }
    }
    v
}

/// 扩展网格（探索性，非冻结网格）：更细的均匀 r=1.02 + 下偏 r∈{0.90,0.95}（趋 n 根 ROC 极限）+ 三线差异化 r。
fn extended_combos() -> Vec<Combo> {
    let mut v = primary_combos();
    for m in M_VALUES {
        v.push(Combo { rs: 1.02, rm: 1.02, rl: 1.02, m });
        v.push(Combo { rs: 0.95, rm: 0.95, rl: 0.95, m });
        v.push(Combo { rs: 0.90, rm: 0.90, rl: 0.90, m });
        v.push(Combo { rs: 1.20, rm: 1.00, rl: 1.00, m }); // 仅短加速
        v.push(Combo { rs: 1.00, rm: 1.20, rl: 1.00, m }); // 仅中加速
        v.push(Combo { rs: 1.00, rm: 1.00, rl: 1.20, m }); // 仅长加速
        v.push(Combo { rs: 1.00, rm: 1.00, rl: 1.05, m }); // 仅长微加速
        v.push(Combo { rs: 1.20, rm: 1.00, rl: 1.20, m }); // 短+长加速
    }
    v
}

fn combo_id(c: &Combo) -> String {
    if c.rs == c.rm && c.rm == c.rl {
        format!("r{:.2}|m{}", c.rs, c.m as i64)
    } else {
        format!("rs{:.2}_rm{:.2}_rl{:.2}|m{}", c.rs, c.rm, c.rl, c.m as i64)
    }
}

/// 兼容旧调用：单值 r（三线同值）参数集。
fn params_for(r: f64, m: f64) -> StrategyParams {
    params_for3(r, r, r, m)
}

fn params_for3(rs: f64, rm: f64, rl: f64, m: f64) -> StrategyParams {
    let mut p: StrategyParams = HashMap::new();
    for (k, v) in [
        ("n_s", N_S),
        ("n_m", N_M),
        ("n_l", N_L),
        ("r_s", rs),
        ("r_m", rm),
        ("r_l", rl),
        ("smooth", SMOOTH),
        ("m", m),
        ("th", TH),
    ] {
        p.insert(k.to_string(), ParamValue::Num(v));
    }
    p
}

fn run_slot(
    code: &'static str,
    code_hash: &str,
    params: StrategyParams,
    bars: &[Bar],
    warmup: usize,
) -> Row {
    let slot = StrategySlot::new(code, code_hash, params, 1.0).expect("slot 构造失败");
    let cfg = EnsembleConfig {
        slots: vec![slot],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy: ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: None,
        initial_capital: CAPITAL,
        fee: FEE,
        period: Period::D1,
        warmup_bars: warmup,
        runtime_limits: RuntimeLimits::default(),
    };
    let res = run_ensemble_with_quickjs(&cfg, bars).unwrap_or_else(|e| panic!("引擎失败: {e}"));
    let mut buy_signals = 0usize;
    let mut sell_signals = 0usize;
    let mut plugin_errors = 0usize;
    for b in &res.per_bar {
        if b.warmup {
            continue;
        }
        match b.signal {
            strategy_core::TradeSignal::Buy => buy_signals += 1,
            strategy_core::TradeSignal::Sell => sell_signals += 1,
            strategy_core::TradeSignal::Hold => {}
        }
        for e in &b.events {
            if matches!(e, strategy_core::EngineEvent::PluginError { .. }) {
                plugin_errors += 1;
            }
        }
    }
    let final_equity = res.net_value.last().map(|x| x.1).unwrap_or(CAPITAL);
    Row {
        in_range_bars: res.net_value.len(),
        total_return: final_equity / CAPITAL - 1.0,
        annualized: res.metrics.annualized_return,
        max_drawdown: res.metrics.max_drawdown,
        sharpe: res.metrics.sharpe,
        win_rate: res.metrics.win_rate,
        profit_factor: res.metrics.profit_factor,
        trade_count: res.metrics.trade_count,
        avg_hold_bars: res.metrics.avg_hold_bars,
        final_equity,
        buy_signals,
        sell_signals,
        plugin_errors,
    }
}

fn f(x: f64) -> String {
    if x.is_finite() {
        format!("{x:.12}")
    } else if x.is_nan() {
        "NA".to_string()
    } else {
        format!("{x}")
    }
}

fn mar(r: &Row) -> String {
    if r.max_drawdown > 0.0 {
        f(r.annualized / r.max_drawdown)
    } else {
        "NA".to_string()
    }
}

const HEADER: &str = "combo_id,kind,code,segment,r,m,n_s,n_m,n_l,smooth,th,warmup_bars,in_range_bars,total_return,annualized,max_drawdown,mar,sharpe,win_rate,profit_factor,trade_count,avg_hold_bars,final_equity,buy_signals,sell_signals,plugin_errors";

fn push_row(
    out: &mut String,
    combo: &str,
    kind: &str,
    code: &str,
    seg: &str,
    r: f64,
    m: f64,
    warmup: usize,
    row: &Row,
) {
    let is_dcap = kind == "dcap";
    let cells: Vec<String> = vec![
        combo.to_string(),
        kind.to_string(),
        code.to_string(),
        seg.to_string(),
        if is_dcap { format!("{r:.2}") } else { "-".into() },
        if is_dcap { format!("{}", m as i64) } else { "-".into() },
        format!("{}", N_S as i64),
        format!("{}", N_M as i64),
        format!("{}", N_L as i64),
        format!("{}", SMOOTH as i64),
        format!("{TH}"),
        warmup.to_string(),
        row.in_range_bars.to_string(),
        f(row.total_return),
        f(row.annualized),
        f(row.max_drawdown),
        mar(row),
        f(row.sharpe),
        f(row.win_rate),
        f(row.profit_factor),
        row.trade_count.to_string(),
        f(row.avg_hold_bars),
        f(row.final_equity),
        row.buy_signals.to_string(),
        row.sell_signals.to_string(),
        row.plugin_errors.to_string(),
    ];
    out.push_str(&cells.join(","));
    out.push('\n');
}

fn warmup_for(m: f64) -> usize {
    (N_L as usize) + (m as usize) - 1
}

// ── 主扫描 ──────────────────────────────────────────────────────────────────

fn run_scan(data_dir: &str, out_path: &str, code_hash: &str, warmup_mode: &str, grid: &str) {
    let combos = if grid == "extended" { extended_combos() } else { primary_combos() };
    let mut out = String::new();
    out.push_str(HEADER);
    out.push('\n');

    for code in SYMBOLS {
        let bars = load_symbol(data_dir, code);
        let n = bars.len();
        let cut = segment_cut(n);
        // IS = [0, cut]（cut+1 根）；OOS = [cut, n)（与 ladder SWEEP 同边界，含 1 根重叠）。
        let is_bars = &bars[0..=cut];
        let oos_bars = &bars[cut..];
        let is_c2c = is_bars.last().unwrap().close / is_bars.first().unwrap().close - 1.0;
        let oos_c2c = oos_bars.last().unwrap().close / oos_bars.first().unwrap().close - 1.0;

        // 基准（同段同费率，引擎内跑）：等权买入持有（恒 Buy）+ 收盘价对收盘价参考。
        let b0 = Row {
            in_range_bars: 0,
            total_return: is_c2c,
            annualized: 0.0,
            max_drawdown: 0.0,
            sharpe: 0.0,
            win_rate: 0.0,
            profit_factor: 0.0,
            trade_count: 0,
            avg_hold_bars: 0.0,
            final_equity: 0.0,
            buy_signals: 0,
            sell_signals: 0,
            plugin_errors: 0,
        };
        push_row(&mut out, "B2C_close_to_close", "bench_ref", code, "IS", 0.0, 0.0, 0, &b0);
        let b1 = Row { total_return: oos_c2c, ..b0 };
        push_row(&mut out, "B2C_close_to_close", "bench_ref", code, "OOS", 0.0, 0.0, 0, &b1);

        // 买入持有：与 dcap 同 warmup 语义（预热段在区间之前取），按 m 各出一条（与各组合逐 bar 对齐）。
        for m in M_VALUES {
            let wu = warmup_for(m);
            let bh_id = format!("BUYHOLD_m{}", m as i64);
            let bh_is = run_slot(
                BUYHOLD_CODE,
                "p5-buyhold",
                HashMap::new(),
                is_bars,
                wu.min(is_bars.len().saturating_sub(1)),
            );
            push_row(&mut out, &bh_id, "bench", code, "IS", 0.0, 0.0, wu, &bh_is);
            let pre = cut.saturating_sub(wu);
            let oos_with_pre = &bars[pre..];
            let bh_oos = run_slot(BUYHOLD_CODE, "p5-buyhold", HashMap::new(), oos_with_pre, wu);
            push_row(&mut out, &bh_id, "bench", code, "OOS", 0.0, 0.0, wu, &bh_oos);
        }

        for cbo in &combos {
            let (r, m) = (cbo.rl, cbo.m);
            {
                let wu = warmup_for(m);
                let combo = combo_id(cbo);
                // OOS 预热前缀 = IS 尾部 wu 根（生产口径：preheat 取 from 之前的历史，不计绩效）。
                let pre = cut.saturating_sub(wu);
                let oos_with_pre = &bars[pre..];
                let p = params_for3(cbo.rs, cbo.rm, cbo.rl, cbo.m);
                // IS：无更早历史 ⇒ 预热段只能取段内前 wu 根（平台 warmup 语义的边界情形）。
                let row_is = run_slot(
                    DCAP_CODE,
                    code_hash,
                    p.clone(),
                    is_bars,
                    wu.min(is_bars.len().saturating_sub(1)),
                );
                push_row(&mut out, &combo, "dcap", code, "IS", r, m, wu, &row_is);
                // OOS：预热前缀 = IS 尾部 wu 根（生产口径）
                let row_oos = run_slot(DCAP_CODE, code_hash, p.clone(), oos_with_pre, wu);
                push_row(&mut out, &combo, "dcap", code, "OOS", r, m, wu, &row_oos);
                // 敏感性：OOS 无预热（插件自然回中立 50 → 不交易），看预热是否影响裁决。
                if warmup_mode == "with_sensitivity" {
                    let row_now = run_slot(DCAP_CODE, code_hash, p, oos_bars, 0);
                    push_row(&mut out, &combo, "dcap", code, "OOS_nowarmup", r, m, 0, &row_now);
                }
            }
        }
        eprintln!("[scan] {code} bars={n} cut={cut} IS={} OOS={}", is_bars.len(), oos_bars.len());
    }

    let rows = out.lines().count() - 1;
    fs::write(out_path, &out).unwrap_or_else(|e| panic!("写 {out_path} 失败: {e}"));
    println!("[done] rows={rows} out={out_path}");
}

// ── 自检（harness 正确性，先于扫描跑） ─────────────────────────────────────

fn selftest() {
    // 1) CSV 解析 + 日期换算
    let sample = "date,open,high,low,close\n2020-01-02,1.0,1.2,0.9,1.1\n2020-01-03,1.1,1.3,1.0,1.2\n";
    let bars = parse_csv(sample);
    assert_eq!(bars.len(), 2);
    assert_eq!(bars[0].close, 1.1);
    assert_eq!(date_ts("1970-01-01"), 0);
    assert_eq!(date_ts("2020-01-02"), 1577923200);

    // 2) 切分与 ladder SWEEP 同式
    assert_eq!(segment_cut(100), 70);
    assert_eq!(segment_cut(3568), 2497);
    assert_eq!(segment_cut(1642), 1149);

    // 3) dcap 行为自检：单调下跌 → 高分（Buy）；单调上涨 → 低分（Sell）
    let mk = |closes: Vec<f64>| -> Vec<Bar> {
        closes
            .iter()
            .enumerate()
            .map(|(i, c)| Bar {
                ts: i as i64 * 86400,
                open: *c,
                high: *c,
                low: *c,
                close: *c,
                volume: 0.0,
            })
            .collect()
    };
    let down: Vec<f64> = (0..120).map(|i| 100.0 - 0.5 * i as f64).collect();
    let up: Vec<f64> = (0..120).map(|i| 100.0 + 0.5 * i as f64).collect();
    let r_down = run_slot(DCAP_CODE, "selftest", params_for(1.0, 1.0), &mk(down), 60);
    let r_up = run_slot(DCAP_CODE, "selftest", params_for(1.0, 1.0), &mk(up.clone()), 60);
    assert!(r_down.buy_signals > 0, "下跌序列应出现 Buy（dcap 逆势语义）");
    assert!(r_up.sell_signals > 0, "上涨序列应出现 Sell");
    assert_eq!(r_down.plugin_errors, 0, "不得有插件错误（会触发 G5 熔断）");
    assert_eq!(r_up.plugin_errors, 0);

    // 4) 买入持有（恒 Buy 插件 + LumpSum 1.0）：单调上涨段必须盈利且只有 1 笔平仓（期末强平）
    let r_bh = run_slot(BUYHOLD_CODE, "selftest-bh", HashMap::new(), &mk(up.clone()), 0);
    assert!(r_bh.total_return > 0.0, "买入持有在上涨段应盈利，got {}", r_bh.total_return);
    assert_eq!(r_bh.trade_count, 1, "期末强平应合成 1 笔交易");
    assert!(r_bh.total_return < up[up.len() - 1] / up[0] - 1.0, "含费收益应低于无费收盘比");

    // 5) 不可达/非法参数：n_s >= n_m 归一化后仍确定性（引擎不报错）
    let mut bad = params_for(1.0, 1.0);
    bad.insert("n_s".into(), ParamValue::Num(60.0));
    bad.insert("n_m".into(), ParamValue::Num(60.0));
    let r_bad = run_slot(DCAP_CODE, "selftest", bad, &mk(up.clone()), 60);
    assert_eq!(r_bad.plugin_errors, 0, "非法 n 经归一化不得报错");

    println!("[selftest] all assertions passed");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str| -> Option<String> {
        args.iter().position(|a| a == k).map(|i| args[i + 1].clone())
    };
    if args.iter().any(|a| a == "--selftest") {
        selftest();
        return;
    }
    let data_dir = get("--data-dir").unwrap_or_else(|| "/tmp/dcap_p5_data".into());
    let out = get("--out").unwrap_or_else(|| "/tmp/dcap_p5_out/grid_all.csv".into());
    let code_hash = get("--code-hash").unwrap_or_else(|| "p5-dcap".into());
    let mode = get("--warmup-mode").unwrap_or_else(|| "main".into());
    let grid = get("--grid").unwrap_or_else(|| "primary".into());
    run_scan(&data_dir, &out, &code_hash, &mode, &grid);
}
