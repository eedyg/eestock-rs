import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ApiClient } from '@/api/client';
import { createMockClient } from '@/api/mock';
import type { WorkbenchBarRecord } from '@/api/types';
import { useRunSeries, SERIES_PAGE_SIZE } from './useRunSeries';

const SUBMIT = {
  symbol: '518880',
  period: 'D1',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  policy: { LumpSum: { position_pct: 1 } } as const,
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
  name: '取数用例',
  slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
};

/** 提交一个 chunked run 并取回 `/result` 兼容响应。 */
async function submitRun(client: ApiClient, bars?: number) {
  void bars;
  const run = await client.submitWorkbenchRun(SUBMIT);
  const result = await client.getWorkbenchResult(run.id);
  return { run, result };
}

describe('useRunSeries（ADR-024 P6 结果取数单一入口）', () => {
  it('legacy_single：全部从 /result 内联列同步派生 —— 零网络、零回归', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await api.getWorkbenchRun('sr_mock_seed1');
    const result = await api.getWorkbenchResult(run.id);
    expect(result.result_format).toBe('legacy_single');
    const curveSpy = vi.spyOn(api, 'getWorkbenchCurve');
    const barsSpy = vi.spyOn(api, 'getWorkbenchBars');
    const fillsSpy = vi.spyOn(api, 'getWorkbenchFills');

    const { result: hook } = renderHook(() => useRunSeries({ api, run, result }));

    expect(hook.current.format).toBe('legacy_single');
    expect(hook.current.curvesLoading).toBe(false);
    expect(hook.current.perBar.points).toHaveLength(result.per_bar.length);
    expect(hook.current.perBar.downsampled).toBe(false);
    expect(hook.current.netValue.points).toHaveLength(result.net_value.length);
    expect(hook.current.bars.rows).toHaveLength(result.per_bar.length);
    expect(hook.current.bars.hasMore).toBe(false);
    expect(hook.current.fills.recorded).toBe(true);
    expect(hook.current.fills.rows.length).toBeGreaterThan(0);
    expect(curveSpy).not.toHaveBeenCalled();
    expect(barsSpy).not.toHaveBeenCalled();
    expect(fillsSpy).not.toHaveBeenCalled();
  });

  it('chunked_v1：曲线走 /curve（抽样标注）、明细走 /bars、成交走 /fills', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 12_000 });
    const { run, result } = await submitRun(api);
    const curveSpy = vi.spyOn(api, 'getWorkbenchCurve');

    const { result: hook } = renderHook(() => useRunSeries({ api, run, result }));
    await waitFor(() => expect(hook.current.curvesLoading).toBe(false));

    expect(hook.current.format).toBe('chunked_v1');
    // 曲线：服务端抽样 + original_bars（D10）
    expect(hook.current.perBar.points).toHaveLength(2000);
    expect(hook.current.perBar.downsampled).toBe(true);
    expect(hook.current.perBar.originalBars).toBe(12_000);
    expect(hook.current.netValue.downsampled).toBe(true);
    expect(hook.current.drawdown.originalBars).toBe(12_000);
    expect(curveSpy).toHaveBeenCalledWith(run.id, { kind: 'per_bar', k: 2000 });
    expect(curveSpy).toHaveBeenCalledWith(run.id, { kind: 'net_value', k: 2000 });
    expect(curveSpy).toHaveBeenCalledWith(run.id, { kind: 'drawdown', k: 2000 });
    // 明细：首页 + has_more（**不得**静默只显首页）
    expect(hook.current.bars.rows).toHaveLength(SERIES_PAGE_SIZE);
    expect(hook.current.bars.total).toBe(12_000);
    expect(hook.current.bars.hasMore).toBe(true);
    expect(hook.current.bars.nextOffset).toBe(SERIES_PAGE_SIZE);
    // 成交：事实源
    expect(hook.current.fills.recorded).toBe(true);
    expect(hook.current.fills.total).toBeGreaterThan(0);
  });

  it('chunked_v1：loadMore 消费 next_offset（追加不覆盖）直到拉满', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 12_000 });
    const { run, result } = await submitRun(api);
    const { result: hook } = renderHook(() => useRunSeries({ api, run, result }));
    await waitFor(() => expect(hook.current.bars.rows).toHaveLength(5000));

    await act(async () => hook.current.loadMore());
    await waitFor(() => expect(hook.current.bars.rows).toHaveLength(10_000));
    expect(hook.current.bars.nextOffset).toBe(10_000);

    await act(async () => hook.current.loadMore());
    await waitFor(() => expect(hook.current.bars.rows).toHaveLength(12_000));
    expect(hook.current.bars.hasMore).toBe(false);
    expect(hook.current.bars.nextOffset).toBeNull();
    // ts 单调（追加顺序正确，无错位/重复）
    const ts = hook.current.bars.rows.map((b) => b.ts);
    expect(ts.every((v, i) => i === 0 || v > ts[i - 1]!)).toBe(true);
  });

  it('chunked_v1：jumpToRange 复用 /bars 的 from&to（服务端按 ts 过滤）并可复位', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 12_000 });
    const { run, result } = await submitRun(api);
    const { result: hook } = renderHook(() => useRunSeries({ api, run, result }));
    await waitFor(() => expect(hook.current.bars.rows).toHaveLength(5000));

    // 取已加载行中的一段（100 根）作为区间
    const rows = hook.current.bars.rows;
    const from = new Date(rows[1000]!.ts * 1000).toISOString();
    const to = new Date(rows[1099]!.ts * 1000).toISOString();
    const barsSpy = vi.spyOn(api, 'getWorkbenchBars');

    await act(async () => hook.current.jumpToRange(from, to));
    await waitFor(() => expect(hook.current.bars.range).not.toBeNull());
    expect(barsSpy).toHaveBeenCalledWith(run.id, { kind: 'per_bar', from, to });
    expect(hook.current.bars.rows).toHaveLength(100);
    expect(hook.current.bars.rows[0]!.ts).toBe(rows[1000]!.ts);
    expect(hook.current.bars.rows[99]!.ts).toBe(rows[1099]!.ts);
    expect(hook.current.bars.range).toEqual({ from, to, count: 100 });
    expect(hook.current.bars.hasMore).toBe(false);

    // 复位 → 回到首页分页
    await act(async () => hook.current.resetRange());
    await waitFor(() => expect(hook.current.bars.range).toBeNull());
    await waitFor(() => expect(hook.current.bars.rows).toHaveLength(5000));
    expect(hook.current.bars.hasMore).toBe(true);
  });

  it('chunked_v1：/fills recorded=false ⇒ 显式可判（与「无成交」区分）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchFillsMissing: true });
    const { run, result } = await submitRun(api);
    const { result: hook } = renderHook(() => useRunSeries({ api, run, result }));
    await waitFor(() => expect(hook.current.fills.loading).toBe(false));
    expect(hook.current.fills.recorded).toBe(false);
    expect(hook.current.fills.total).toBe(0);
  });

  it('run/result 未就绪 ⇒ 空态且不发起请求', () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const curveSpy = vi.spyOn(api, 'getWorkbenchCurve');
    const barsSpy = vi.spyOn(api, 'getWorkbenchBars');
    const { result: hook } = renderHook(() => useRunSeries({ api, run: null, result: null }));
    expect(hook.current.bars.rows).toHaveLength(0);
    expect(hook.current.fills.rows).toHaveLength(0);
    expect(hook.current.curvesLoading).toBe(false);
    expect(curveSpy).not.toHaveBeenCalled();
    expect(barsSpy).not.toHaveBeenCalled();
  });

  // ───────────────── ADR-028 D2.4：评估段裁剪（预热段不参与曲线绘制） ─────────────────

  /** 合成 per_bar 行（只需 ts；曲线渲染只消费 ts/aggregate/scores）。 */
  const barRow = (ts: number): WorkbenchBarRecord => ({
    ts,
    scores: [],
    aggregate: 50,
    signal: 'Hold',
    orders: [],
    events: [],
  });

  it('chunked_v1：per_bar 曲线裁掉 warmup 预热段（评估段 = run.from_ts..to_ts），并披露剔除根数', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 60 });
    const { run, result } = await submitRun(api);
    const fromSec = Math.floor(Date.parse(run.from_ts) / 1000);
    const toSec = Math.floor(Date.parse(run.to_ts) / 1000);
    // 3 根预热段（from 之前）+ 2 根评估段（含端点）
    const rows = [barRow(fromSec - 180), barRow(fromSec - 120), barRow(fromSec - 60), barRow(fromSec), barRow(toSec)];
    const real = api.getWorkbenchCurve.bind(api);
    vi.spyOn(api, 'getWorkbenchCurve').mockImplementation(async (id, q) => {
      if (q.kind !== 'per_bar') return real(id, q);
      return {
        kind: 'per_bar', points: rows, downsampled: false, original_bars: rows.length, k: 2000,
        window_from_ts: null, window_to_ts: null, window_bars: rows.length,
      } as Awaited<ReturnType<ApiClient['getWorkbenchCurve']>>;
    });

    const { result: hook } = renderHook(() => useRunSeries({ api, run, result }));
    await waitFor(() => expect(hook.current.curvesLoading).toBe(false));

    expect(hook.current.perBar.points.map((p) => p.ts)).toEqual([fromSec, toSec]);
    expect(hook.current.perBar.excludedWarmupBars).toBe(3);
    // 服务端口径的 original_bars **不变**（抽样/完整性披露仍以服务端为准）
    expect(hook.current.perBar.originalBars).toBe(rows.length);
    // 净值/回撤/持仓同段（本就不含预热段）⇒ 不受影响
    expect(hook.current.netValue.excludedWarmupBars ?? 0).toBe(0);
  });

  it('legacy_single：/result.per_bar 同样裁掉预热段（旧 run 零回归：无预热行 ⇒ 逐元素不变）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await api.getWorkbenchRun('sr_mock_seed1');
    const result = await api.getWorkbenchResult(run.id);
    const fromSec = Math.floor(Date.parse(run.from_ts) / 1000);
    const warm = [barRow(fromSec - 120), barRow(fromSec - 60)];

    const bare = renderHook(() => useRunSeries({ api, run, result }));
    expect(bare.result.current.perBar.points).toHaveLength(result.per_bar.length);
    expect(bare.result.current.perBar.excludedWarmupBars ?? 0).toBe(0);

    const patched = { ...result, per_bar: [...warm, ...result.per_bar] };
    const { result: hook } = renderHook(() => useRunSeries({ api, run, result: patched }));
    expect(hook.current.perBar.points).toHaveLength(result.per_bar.length);
    expect(hook.current.perBar.points[0]!.ts).toBe(result.per_bar[0]!.ts);
    expect(hook.current.perBar.excludedWarmupBars).toBe(warm.length);
    // 逐bar 明细（表格事实源）**不裁**（事实表保留预热段行；曲线才裁）
    expect(hook.current.bars.rows).toHaveLength(patched.per_bar.length);
  });
});
