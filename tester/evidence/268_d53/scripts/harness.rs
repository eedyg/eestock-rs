// 独立探针（Tester D5-3）：链接**已编译的真实后端 crate** `web`，逐条打印后端实际结论。
#[path = "/tmp/d53_sb/rust_probe/vectors_gen.rs"]
mod gen;
use web::dto::{multi_period_pane_count, validate_multi_period_config, verify_multi_period_panes};

fn main() {
    let mut mismatch = 0usize;
    let mut n = 0usize;
    for v in gen::vectors() {
        n += 1;
        // 消费同一 JSON 的派生期望：由 python 从 JSON 生成的 expect 表在 compare 阶段比对
        let (status, line) = match validate_multi_period_config(&v.cfg) {
            Ok(norm) => {
                let hs = norm.heights.iter().map(|(k, val)| format!("{k}={val}")).collect::<Vec<_>>().join(";");
                (200u64, format!("enabled={} periods={} heights={} indicators={}", norm.enabled,
                    norm.periods.join(","), hs, norm.indicators.join(",")))
            }
            Err(e) => (400u64, format!("err={e}")),
        };
        let pane = multi_period_pane_count(&v.cfg.periods, &v.cfg.indicators);
        let guard = match verify_multi_period_panes(&v.cfg.periods, &v.cfg.indicators) {
            Ok(()) => "ok".to_string(),
            Err(e) => format!("err={e}"),
        };
        println!("VECTOR\t{}\t{}\t{}\tpane={}\tpaneExpect={:?}\tguard={}\tguardExpect={:?}",
            v.name, status, line, pane, v.pane, guard, v.guard);
        // pane/guard 与向量声明的一致性（仅观察）
        if let Some(p) = v.pane { if p != pane as u64 { mismatch += 1; println!("PANE_MISMATCH\t{}\twant={}\tgot={}", v.name, p, pane); } }
        if let Some(g) = v.guard { if !guard.contains(g) { mismatch += 1; println!("GUARD_MISMATCH\t{}\twant_contains={}\tgot={}", v.name, g, guard); } }
    }
    println!("RUST_PROBE_SUMMARY total={n} paneOrGuardMismatch={mismatch}");
}
