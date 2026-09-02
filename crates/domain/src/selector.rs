// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/selector.rs>>[init]
//! 时间窗轮换当班 + 轮询式故障转移（ADR-015 取代 ADR-005 的逐股随机起点）。
//! TDD 要点（测试规格）：
//! - 当班源健康时链首恒为当班源；当班源熔断时退为剩余健康源随机起点
//! - 转移顺序确定：从链首起按注册序轮转，不重复
//! - 熔断源不出现在序列中
//! - DutyRoster：窗长随机 20-40min，两源交替当班，窗界切换带 0-30s 随机偏移

use crate::types::*;
use rand::seq::SliceRandom;
use rand::Rng;

pub struct SourceSelector {
    /// 注册序即轮转序（东财系恒在最后——ADR-006）
    ordered: Vec<SourceId>,
}

impl SourceSelector {
    pub fn new(ordered: Vec<SourceId>) -> Self { Self { ordered } }

    /// 本周期尝试链：当班源优先（健康时），否则健康池随机起点；之后按注册序轮转。
    pub fn attempt_chain(&self, duty: SourceId, healthy: &[SourceId]) -> Vec<SourceId> {
        let pool: Vec<SourceId> = self.ordered.iter()
            .filter(|s| healthy.contains(s)).cloned().collect();
        if pool.is_empty() { return vec![]; }
        let mut rng = rand::thread_rng();
        let start = if pool.contains(&duty) { duty }
                    else { pool.choose(&mut rng).cloned().unwrap_or(pool[0]) };
        let pos = pool.iter().position(|s| *s == start).unwrap_or(0);
        pool.iter().cycle().skip(pos).take(pool.len()).cloned().collect()
    }
}

/// 当班轮换表：随机窗长 20-40min，Tier1 两源交替，切换带 0-30s 随机偏移。
/// 纯函数可测（注入时钟与随机源）。
pub struct DutyRoster {
    tier1: [SourceId; 2],
}

impl DutyRoster {
    pub fn new(tier1: [SourceId; 2]) -> Self { Self { tier1 } }
    /// 由“纪元分钟数 + 抖动种子”确定性推导当班源（测试可复现）。
    pub fn duty_at(&self, epoch_minutes: u64, jitter_seed: u64) -> SourceId {
        // 窗长 20-40min：以 30min 为基准的伪随机窗口序列由 epoch/jitter 推导，
        // 实现细节在 collector 落码时以 TDD 锁定；此处固定契约：
        // 同一 (epoch_minutes, jitter_seed) 输入恒得同一输出。
        let window = 20 + (jitter_seed % 21); // 20-40
        let idx = ((epoch_minutes / window) % 2) as usize;
        self.tier1[idx]
    }
}
// ~/~ end
