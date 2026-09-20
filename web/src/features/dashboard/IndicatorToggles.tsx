import type { ReactNode } from 'react';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { Button } from '@/components/ui/button';
import { DCAP_INDICATOR_NAME } from '@/features/indicators/dcapIndicator';

/**
 * K 线指标勾选 —— **看板与结果页共用的唯一实现**（ADR-028 §2.4c 第 1 项「复用看板」）。
 *
 * 名单唯一来源 = {@link INDICATOR_DEFS}（也被 `KlineChart.syncIndicators` 消费 ⇒ 勾选键与图表指标一一对应，
 * 不会出现「勾了但图里没有」的错位）。看板 Toolbar 与结果页 K 线卡都渲染本组件 ⇒
 * 「勾选逻辑」只有一处，避免两套名单漂移（本波修复的正是结果页此前**硬编码**
 * `indicators={DASHBOARD_DEFAULTS.indicators}` 导致「无入口 + 与看板配置直通」的双缺陷）。
 *
 * 配置隔离：本组件是**纯受控**组件（只吃 `indicators` + `onToggle`，不读写任何存储）——
 * 看板侧为页面会话态，结果页侧由 `resultChartConfig` 的**独立 key** 持有（硬约束）。
 */
export type IndicatorName = keyof typeof DASHBOARD_DEFAULTS.indicators;

export const INDICATOR_DEFS: Array<{ key: IndicatorName; name: string; calcParams?: number[] }> = [
  { key: 'ma', name: 'MA' }, // 主图叠加（candle_pane）
  { key: 'vol', name: 'VOL' }, // 副图 1：成交量（默认开，见 DASHBOARD_DEFAULTS.indicators）
  { key: 'macd', name: 'MACD' },
  { key: 'kdj', name: 'KDJ' },
  { key: 'boll', name: 'BOLL' },
  { key: 'dcap', name: DCAP_INDICATOR_NAME }, // ADR-021：dcap 三线（独立副图 pane）
];

export interface IndicatorTogglesProps {
  indicators: Record<IndicatorName, boolean>;
  onToggle(name: IndicatorName): void;
  /** 结果页用：给每枚按钮加稳定 testid（`<prefix>-<key>`）。缺省 ⇒ 不产生 testid（看板 DOM 不变）。 */
  testIdPrefix?: string;
  /** 紧随某枚按钮之后的附加控件（看板：MA 窗口配置 / DCAP 参数面板）。 */
  renderExtra?(name: IndicatorName): ReactNode;
}

export function IndicatorToggles({ indicators, onToggle, testIdPrefix, renderExtra }: IndicatorTogglesProps) {
  return (
    <>
      {INDICATOR_DEFS.map((i) => (
        <span key={i.key} className="flex items-center gap-1">
          <Button
            {...(testIdPrefix ? { 'data-testid': `${testIdPrefix}-${i.key}` } : {})}
            data-indicator={i.key}
            aria-pressed={indicators[i.key]}
            variant={indicators[i.key] ? 'primary' : 'ghost'}
            onClick={() => onToggle(i.key)}
          >
            {i.name}
          </Button>
          {renderExtra?.(i.key)}
        </span>
      ))}
    </>
  );
}
