import type { ReactNode } from 'react';

export interface MultiPeriodChartStackProps {
  /** 多周期开关（默认 false ⇒ 与现状逐字节等价）。 */
  enabled?: boolean;
  children: ReactNode;
}

/**
 * 多周期图表容器（`design/15-multi-period/02-spec.md` §1；P1 仅骨架与隔离，**不含卫星实例**）。
 *
 * 硬约束（T11 关闭态等价；实施计划 P1 原文「`enabled=false` 时 DOM/行为与现状逐字节等价」）：
 * - `enabled=false` ⇒ **逐字节透传 children（零包裹层）**：DOM 结构/请求/订阅与现状完全一致；
 * - `enabled=true` 但尚未选卫星周期（选择周期属 P2）⇒ 仍是当前单图，**不得出现空卫星/报错**。
 *
 * P2 将在此挂载卫星实例（`state:'minimize'` 隐藏 K 线 + 指标继承 + 每实例一个 `KlineDataFeed`）；
 * 本轮返回 Fragment，不带任何 DOM 节点（等价性由 DOM 结构指纹断言锁定）。
 */
export function MultiPeriodChartStack({ enabled = false, children }: MultiPeriodChartStackProps) {
  if (!enabled) return <>{children}</>;
  return <>{children}</>;
}
