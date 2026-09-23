import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AggregateScoreChart } from './AggregateScoreChart';
import { SlotScoresChart } from './SlotScoresChart';
import type { WorkbenchBarRecord, WorkbenchPinnedSlot } from '@/api/types';

/**
 * ADR-028 D2.4 披露规格（用户 2026-09-22 决策 = 方案 A「分数曲线不画预热段」）：
 * 分数曲线裁掉预热段后**必须**显式标注（ADR-024 D10 禁静默有损）：
 *  - 右下角写「评估段 共 N bar（预热段 K 根不计入）」；
 *  - 无预热段（`excludedWarmupBars` 缺省/0）⇒ 文案与修复前逐字一致（零回归）。
 */

const bar = (ts: number): WorkbenchBarRecord => ({
  ts,
  scores: [{ slot_idx: 0, score: 50 }],
  aggregate: 50,
  signal: 'Hold',
  orders: [],
  events: [],
});

const SLOTS: WorkbenchPinnedSlot[] = [
  { strategy_id: 'st_dual', version: 1, version_id: 'sv_1', weight: 1 },
] as WorkbenchPinnedSlot[];

describe('分数曲线预热段披露（ADR-028 D2.4）', () => {
  it('聚合总分：裁剪后标注评估段根数与预热段根数', () => {
    render(
      <AggregateScoreChart
        perBar={[bar(1000), bar(1060)]}
        buyThreshold={60}
        sellThreshold={40}
        sampling={{ downsampled: false, originalBars: 500, excludedWarmupBars: 250 }}
      />,
    );
    expect(screen.getByTestId('wb-aggregate-warmup-note')).toHaveTextContent('预热段 250 根不计入');
    expect(screen.getByTestId('wb-aggregate-sampling')).toHaveTextContent('评估段 共 250 bar');
  });

  it('聚合总分：无预热段 ⇒ 不渲染披露（零回归）', () => {
    render(
      <AggregateScoreChart
        perBar={[bar(1000), bar(1060)]}
        buyThreshold={60}
        sellThreshold={40}
        sampling={{ downsampled: false, originalBars: 2 }}
      />,
    );
    expect(screen.queryByTestId('wb-aggregate-warmup-note')).toBeNull();
    expect(screen.getByTestId('wb-aggregate-sampling')).toHaveTextContent('共 2 bar');
  });

  it('各策略评分：同样披露（与聚合同口径）', () => {
    render(
      <SlotScoresChart
        perBar={[bar(1000), bar(1060)]}
        slots={SLOTS}
        catalog={null}
        sampling={{ downsampled: true, originalBars: 500, excludedWarmupBars: 250 }}
      />,
    );
    expect(screen.getByTestId('wb-slot-warmup-note')).toHaveTextContent('预热段 250 根不计入');
    expect(screen.getByTestId('wb-slot-sampling')).toHaveTextContent('评估段 共 250 bar');
    expect(screen.getByTestId('wb-slot-sampling')).toHaveTextContent('服务端抽样 2 点');
  });
});
