// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/merge.rs>>[init]
//! 双真值层合并：准确层优先（纯函数版，与 SQL 视图语义一致，契约测试锁定）。

use crate::types::Bar;
use std::collections::{HashMap, HashSet};

pub fn merge_prefer_accurate(raw: Vec<Bar>, accurate: Vec<Bar>) -> Vec<Bar> {
    // ⚠️ ADR-016 连带：key 含 period，防止跨粒度误合并
    let raw_keys: HashSet<_> = raw.iter().map(|b| (b.code.clone(), b.period, b.ts)).collect();
    let acc: HashMap<_, _> = accurate.into_iter().map(|b| ((b.code.clone(), b.period, b.ts), b)).collect();
    let mut out: Vec<Bar> = raw.into_iter()
        .map(|b| acc.get(&(b.code.clone(), b.period, b.ts)).cloned().unwrap_or(b)).collect();
    out.extend(acc.into_values().filter(|b| !raw_keys.contains(&(b.code.clone(), b.period, b.ts))));
    out.sort_by_key(|b| (b.code.clone(), b.ts));
    out
}
// ~/~ end
