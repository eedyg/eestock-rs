import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { Bar, Period } from '@/api/types';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';

/**
 * F8（ADR-028 D2 / 02-spec §7）：`KlineChart` 新增**可选** `onVisibleRangeChange`。
 *
 * 两条判据：
 *  1. **传了** ⇒ 回调携带 `{from_ts, to_ts, from_idx, to_idx}`（索引→ts 在图内经 `getDataList()` 转换，
 *     ts 为 **Unix 秒**，与 `/curve?from_ts=` 同口径）；
 *  2. **不传** ⇒ 订阅面与写操作**逐字节不变**（既有调用方：看板基准/宫格/多周期卫星，零影响）。
 *
 * 图表面用 `@/test/syncChartStub`（klinecharts 公开面的忠实模型），并补齐 KlineChart 装配所需方法。
 */

const KC_BARS = makeSeries({ count: 600, spacingMs: 86_400_000, endTs: Date.UTC(2026, 8, 14) });
const syncStub = createSyncChartStub({ bars: KC_BARS, paneWidthPx: 520, limit: { min: 1, max: 400 } });

const chartStub = Object.assign(syncStub, {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  setStyles: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  overrideIndicator: vi.fn(),
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {}),
  ),
  resetData: vi.fn(),
  setPaneOptions: vi.fn(),
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
});

vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

import { KlineChart, type KlineChartFeedLike } from './KlineChart';

function fakeFeed(): KlineChartFeedLike {
  return {
    bars: [] as Bar[],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
  };
}

const INDICATORS = { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false };

function props(over: Record<string, unknown> = {}) {
  return {
    feed: fakeFeed(),
    code: '518880',
    period: '1d' as Period,
    followLatest: false,
    indicators: INDICATORS,
    onManualZoom: () => {},
    ...over,
  };
}

describe('KlineChart 可选 onVisibleRangeChange（ADR-028 D2 / F8）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncStub.__events.length = 0;
    syncStub.__log.length = 0;
  });

  it('F8-回归：**不传** onVisibleRangeChange ⇒ 不订阅该 action，且无任何程序化写窗', async () => {
    render(<KlineChart {...props()} />);
    await waitFor(() => expect(chartStub.setSymbol).toHaveBeenCalled());
    // 既有订阅面不变（仅 onZoom/onScroll，来自「用户手动缩放/平移」判定）
    expect(syncStub.__listenerCount('onVisibleRangeChange')).toBe(0);
    expect(syncStub.__listenerCount('onZoom')).toBe(1);
    expect(syncStub.__listenerCount('onScroll')).toBe(1);
    // 无窗口指令 ⇒ 不调用定位原语（既有调用方渲染与行为不变）
    expect(syncStub.__log.some((c) => c.method === 'scrollToDataIndex')).toBe(false);
  });

  it('F8-正向：传回调 ⇒ 「可见范围变更」事件携带 from_ts/to_ts/from_idx/to_idx（ts = Unix 秒）', async () => {
    const onChange = vi.fn();
    render(<KlineChart {...props({ onVisibleRangeChange: onChange })} />);
    await waitFor(() => expect(chartStub.setSymbol).toHaveBeenCalled());
    expect(syncStub.__listenerCount('onVisibleRangeChange')).toBe(1);

    onChange.mockClear();
    syncStub.__setRightIndex(300);
    syncStub.__fireAction('onVisibleRangeChange');
    expect(onChange).toHaveBeenCalledTimes(1);
    const r = onChange.mock.calls[0]![0] as {
      from_ts: number;
      to_ts: number;
      from_idx: number;
      to_idx: number;
    };
    expect(r.to_idx).toBe(300);
    expect(r.from_idx).toBeLessThan(r.to_idx);
    // ts 必须是**秒**（= 图表毫秒 dataList / 1000），与 `/curve` 窗口参数同口径
    expect(r.from_ts).toBe(Math.floor((KC_BARS[r.from_idx] as number) / 1000));
    expect(r.to_ts).toBe(Math.floor((KC_BARS[r.to_idx] as number) / 1000));
  });

  it('F9-回声抑制：程序化写窗期间的 onVisibleRangeChange 不得回写窗口', async () => {
    const onChange = vi.fn();
    const onApplied = vi.fn();
    const { rerender } = render(
      <KlineChart {...props({ onVisibleRangeChange: onChange, windowCommand: null, onWindowApplied: onApplied })} />,
    );
    await waitFor(() => expect(chartStub.setSymbol).toHaveBeenCalled());
    onChange.mockClear();

    const targetSec = Math.floor((KC_BARS[300] as number) / 1000);
    rerender(
      <KlineChart
        {...props({
          onVisibleRangeChange: onChange,
          onWindowApplied: onApplied,
          windowCommand: {
            rev: 1,
            from_ts: targetSec - 59 * 86400,
            to_ts: targetSec + 60 * 86400,
            span_bars: 120,
            center_ts: targetSec,
          },
        })}
      />,
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    const res = onApplied.mock.calls[0]![0] as { ok: boolean; error: string | null; requested_bar_space: number | null };
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(res.requested_bar_space).toBe(4); // round(520 / 120)
    // 程序化写窗让引擎**同步**派发了 onVisibleRangeChange（桩内 setBarSpace/scrollToDataIndex 会 fire）
    expect(syncStub.__events).toContain('onVisibleRangeChange');
    expect(onChange).not.toHaveBeenCalled(); // 但被回声抑制（不回写窗口状态）
  });

  it('F9-断言失败上报：windowCommand 让目标 barSpace 越界（stub max=50）⇒ onWindowApplied 显式报错', async () => {
    // 本实例声明放宽到 400（结果页口径），但引擎桩 limit max=50 ⇒ 请求 104 被静默吞掉
    const narrow = createSyncChartStub({ bars: KC_BARS, paneWidthPx: 520, limit: { min: 1, max: 50 } });
    const savedSet = chartStub.setBarSpace;
    const savedGet = chartStub.getBarSpace;
    chartStub.setBarSpace = narrow.setBarSpace;
    chartStub.getBarSpace = narrow.getBarSpace;
    try {
      const onApplied = vi.fn();
      const targetSec = Math.floor((KC_BARS[300] as number) / 1000);
      render(
        <KlineChart
          {...props({
            onWindowApplied: onApplied,
            barSpaceLimit: { min: 1, max: 400 },
            windowCommand: { rev: 2, from_ts: targetSec, to_ts: targetSec, span_bars: 5, center_ts: targetSec },
          })}
        />,
      );
      await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
      const res = onApplied.mock.calls[0]![0] as { ok: boolean; error: string | null };
      expect(res.ok).toBe(false);
      expect(res.error).toContain('静默吞掉');
    } finally {
      chartStub.setBarSpace = savedSet;
      chartStub.getBarSpace = savedGet;
    }
  });

  it('不传 windowCommand ⇒ 一条窗口写语句都不执行（既有调用方零影响）', async () => {
    const onApplied = vi.fn();
    render(<KlineChart {...props({ onWindowApplied: onApplied })} />);
    await waitFor(() => expect(chartStub.setSymbol).toHaveBeenCalled());
    expect(onApplied).not.toHaveBeenCalled();
  });
});
