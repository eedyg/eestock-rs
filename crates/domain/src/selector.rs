// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/selector.rs>>[init]
//! 逐股随机起点 + 轮询式故障转移。
//! TDD 要点（测试规格）：
//! - 随机起点在健康池内均匀分布（统计性测试可放宽为：全部源都可能被首先选中）
//! - 转移顺序确定：从起点起按注册序轮转，不重复
//! - 熔断源不出现在序列中
//! - 单标的单次拉取粘住同一源

use crate::types::*;
use rand::seq::SliceRandom;

pub struct SourceSelector {
    /// 注册序即轮转序（优先级从高到低由配置决定，东财系恒在最后——ADR-006）
    ordered: Vec<SourceId>,
}

impl SourceSelector {
    pub fn new(ordered: Vec<SourceId>) -> Self { Self { ordered } }

    /// 为某标的生成本周期的尝试序列：随机起点 + 注册序轮转，剔除熔断源。
    pub fn attempt_chain(&self, healthy: &[SourceId]) -> Vec<SourceId> {
        let pool: Vec<SourceId> = self.ordered.iter()
            .filter(|s| healthy.contains(s)).cloned().collect();
        if pool.is_empty() { return vec![]; }
        let mut rng = rand::thread_rng();
        let start = pool.choose(&mut rng).cloned().unwrap_or(pool[0]);
        let pos = pool.iter().position(|s| *s == start).unwrap_or(0);
        pool.iter().cycle().skip(pos).take(pool.len()).cloned().collect()
    }
}
// ~/~ end
