/**
 * 策略页展示格式化（12-strategy-system / P2b）：中文标签 / 徽章样式 / approval at-least 语义。
 * UI 文案中文（任务书红线）；徽章色遵循既有暗色主题 token（up/down/acc1）。
 */
import type { StrategyApprovalLevel, StrategyKind, StrategyStatus } from '@/api/types';

/** 策略类别标签 */
export const KIND_LABEL: Record<StrategyKind, string> = {
  strategy: '策略',
  template: '模板',
};

/** 版本状态标签 */
export const STATUS_LABEL: Record<StrategyStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

/** 权限分级标签 */
export const APPROVAL_LABEL: Record<StrategyApprovalLevel, string> = {
  backtest_ok: '回测可用',
  sim_ok: '模拟可用',
  live_approved: '实盘批准',
};

/** 状态徽章样式（draft=dim 灰 / published=acc1 亮 / archived=dim 淡） */
export function statusBadgeClass(status: StrategyStatus): string {
  switch (status) {
    case 'published':
      return 'border-acc1/50 bg-acc1/15 text-acc1';
    case 'archived':
      return 'border-line bg-panel2 text-dim opacity-70';
    default:
      return 'border-line bg-panel2 text-dim';
  }
}

/** 权限徽章样式（阶梯递进：live_approved 最亮） */
export function approvalBadgeClass(level: StrategyApprovalLevel): string {
  switch (level) {
    case 'live_approved':
      return 'border-up/50 bg-up/15 text-up';
    case 'sim_ok':
      return 'border-acc2/50 bg-acc2/15 text-acc2';
    default:
      return 'border-line bg-panel2 text-dim';
  }
}

/** approval 阶梯 rank（backtest_ok=1 < sim_ok=2 < live_approved=3；与后端 ApprovalLevel::rank 同构） */
export function approvalRank(level: StrategyApprovalLevel): number {
  return level === 'backtest_ok' ? 1 : level === 'sim_ok' ? 2 : 3;
}

/** at-least 过滤语义：level 是否满足 required 最低级别（更高级别通过一切过滤） */
export function approvalSatisfies(level: StrategyApprovalLevel, required: StrategyApprovalLevel): boolean {
  return approvalRank(level) >= approvalRank(required);
}

/** ISO 时间 → 本地可读串（YYYY-MM-DD HH:mm）；非法输入原样返回 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
