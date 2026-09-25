import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AggregateScoreChart } from './AggregateScoreChart';
import { SlotScoresChart } from './SlotScoresChart';
import type { WorkbenchBarRecord, WorkbenchPinnedSlot } from '@/api/types';

/**
 * ADR-028 D2.4 债（`design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md` §1
 * 非目标清单 + §5 残留）：「**预热窗口内空图缺 view 级文案**」。
 *
 * 场景（真实数据可复现）：用户把窗口（ADR-028 D3）拖/跳到 **预热段** 内 ⇒ `/curve?kind=per_bar`
 * 返回的窗口点全部落在评估段 `[run.from_ts, run.to_ts]` **之外** ⇒ `clipToEvaluatedRange` 全裁掉
 * ⇒ 两张分数曲线卡**空图**，而脚注只写「评估段 共 M bar（预热段 K 根不计入）」（M/K 是 **run 级**口径，
 * 不解释「当前窗口为什么是空的」）。
 *
 * 契约（本文件锁死）：
 *  1. 当前载荷**因评估段裁剪而变空**（`points.length === 0 ∧ excludedByEvaluatedRange > 0`）⇒
 *     视图内**必须**有明确文案，且根数 **N 取自载荷真值** `excludedByEvaluatedRange`
 *     （= 本窗口内落在评估段之外的根数），**不得**自造/硬编码数值。
 *  2. **非裁剪**导致的空（如窗口落在 run 数据之外：`excludedByEvaluatedRange === 0`）⇒ **不渲染**该文案
 *     （不得把「无数据」谎报为「预热段」）。
 *  3. 非空窗口 ⇒ **不渲染**该文案（零回归）。
 *
 * 真值来源：`GET /api/workbench/runs/sr_1790267627829_000000/curve?kind=per_bar&k=2000&from_ts=1734883200&to_ts=1737475200`
 * （2026-09-25 实测：`original_bars=427`、`window_bars=22`、`points=22`；run `from_ts=2026-01-04T16:00Z`、
 * `warmup_effective=250` ⇒ 该窗口 22 根**全在预热段**）。原始响应落盘
 * `coder/evidence/20260925_small_debt/item5/curve_warmup_only.json`。
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

/** 预热窗口载荷（服务端口径）：`original_bars=427`、窗口 22 根全部被评估段裁掉。 */
const WARMUP_WINDOW_SAMPLING = {
  downsampled: false,
  originalBars: 427,
  excludedWarmupBars: 250,
  excludedByEvaluatedRange: 22,
};

describe('ADR-028 D2.4：预热窗口空图的 view 级文案', () => {
  it('聚合总分：窗口全在预热段 ⇒ 文案说明「当前窗口 N 根全部落在预热段（不计入评估、不绘制）」，N 取自载荷真值', () => {
    const sampling = { ...WARMUP_WINDOW_SAMPLING };
    render(
      <AggregateScoreChart perBar={[]} buyThreshold={60} sellThreshold={40} sampling={sampling} />,
    );
    const note = screen.getByTestId('wb-aggregate-warmup-window-empty');
    expect(note).toHaveTextContent(`当前窗口 ${sampling.excludedByEvaluatedRange} 根全部落在预热段`);
    expect(note).toHaveTextContent('不计入评估、不绘制');
  });

  it('聚合总分：N 随真值变化（非硬编码；同一组件换载荷 ⇒ 文案根数同步）', () => {
    render(
      <AggregateScoreChart
        perBar={[]}
        buyThreshold={60}
        sellThreshold={40}
        sampling={{ downsampled: false, originalBars: 427, excludedWarmupBars: 250, excludedByEvaluatedRange: 1 }}
      />,
    );
    expect(screen.getByTestId('wb-aggregate-warmup-window-empty')).toHaveTextContent('当前窗口 1 根');
  });

  it('聚合总分：空图但**非**评估段裁剪所致（窗口在 run 数据之外）⇒ 不渲染该文案（禁谎报预热段）', () => {
    render(
      <AggregateScoreChart
        perBar={[]}
        buyThreshold={60}
        sellThreshold={40}
        sampling={{ downsampled: false, originalBars: 427, excludedWarmupBars: 0, excludedByEvaluatedRange: 0 }}
      />,
    );
    expect(screen.queryByTestId('wb-aggregate-warmup-window-empty')).toBeNull();
  });

  it('聚合总分：窗口内有数据 ⇒ 不渲染该文案（零回归）', () => {
    render(
      <AggregateScoreChart
        perBar={[bar(1000), bar(1060)]}
        buyThreshold={60}
        sellThreshold={40}
        sampling={WARMUP_WINDOW_SAMPLING}
      />,
    );
    expect(screen.queryByTestId('wb-aggregate-warmup-window-empty')).toBeNull();
  });

  it('各策略评分：同口径披露（与聚合同一真值/同一文案）', () => {
    render(
      <SlotScoresChart
        perBar={[]}
        slots={SLOTS}
        catalog={null}
        sampling={WARMUP_WINDOW_SAMPLING}
      />,
    );
    const note = screen.getByTestId('wb-slot-warmup-window-empty');
    expect(note).toHaveTextContent('当前窗口 22 根全部落在预热段');
    expect(note).toHaveTextContent('不计入评估、不绘制');
  });
});
