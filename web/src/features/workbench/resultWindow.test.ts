import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';
import {
  applyWindowOps,
  centeredWindow,
  isSameWindow,
  isStaleResponse,
  makeWindow,
  periodSeconds,
  popHistory,
  pushHistory,
  readVisibleRangeTs,
  roundTripWindow,
  throttleLatest,
  WINDOW_HISTORY_MAX,
  WINDOW_THROTTLE_MS,
  type ResultWindowState,
} from './resultWindow';

/**
 * ADR-028 D2/D2.1/D4 的窗口状态机（F7 的「节流/rev 丢旧/回声抑制」单元侧 + F9 的跳转断言）。
 *
 * 图表面用 `@/test/syncChartStub`：它是 klinecharts 10.0.3「跨图同步所需公开面」的忠实模型，
 * 特别是 **`setBarSpace` 越界静默 return**（F18）这条真实行为 ⇒ F9 的断言路径可被真实构造。
 */

const DAY_MS = 86_400_000;
const BARS = makeSeries({ count: 600, spacingMs: DAY_MS, endTs: Date.UTC(2026, 8, 14) });
/** 桩的 bar ts 是 **ms**；窗口事实源与 `/curve` 口径是 **Unix 秒** ⇒ 测试显式换算。 */
const SEC = (i: number): number => Math.floor((BARS[i] as number) / 1000);

function chartWith(limit = { min: 1, max: 400 }) {
  return createSyncChartStub({ bars: BARS, paneWidthPx: 520, limit });
}

describe('F6/F7 窗口状态机：构造、生命周期与乱序', () => {
  it('窗口构造携带 5 字段（from_ts/to_ts/span_bars/source/rev）且 span 归一', () => {
    const w = makeWindow('kline', 100, 200, 0, 3);
    expect(w).toEqual({ from_ts: 100, to_ts: 200, span_bars: 1, source: 'kline', rev: 3 });
    // to_ts < from_ts 被归一（不得出现反向窗口）
    expect(makeWindow('jump', 200, 100, 5, 1).to_ts).toBe(200);
  });

  it('历史栈上限 = 20 步（超出丢最旧，保留最近可回退）', () => {
    expect(WINDOW_HISTORY_MAX).toBe(20);
    let stack: ResultWindowState[] = [];
    for (let i = 0; i < 25; i++) stack = pushHistory(stack, makeWindow('jump', i, i + 10, 11, i));
    expect(stack.length).toBe(20);
    expect(stack[0]!.from_ts).toBe(5); // 最旧 5 步被丢弃
    const { stack: s2, prev } = popHistory(stack);
    expect(prev!.from_ts).toBe(24);
    expect(s2.length).toBe(19);
    expect(popHistory([]).prev).toBeNull(); // 空栈 ⇒ 显式 null（不是静默 no-op 的假窗口）
  });

  it('落后响应丢弃判据：rev 小于已发出最大 rev ⇒ 丢弃', () => {
    expect(isStaleResponse(3, 5)).toBe(true);
    expect(isStaleResponse(5, 5)).toBe(false);
    expect(isStaleResponse(6, 5)).toBe(false);
  });

  it('同窗口判定（无变化不重取）：rev/source 不参与', () => {
    const a = makeWindow('kline', 1, 2, 3, 1);
    const b = makeWindow('jump', 1, 2, 3, 9);
    expect(isSameWindow(a, b)).toBe(true);
    expect(isSameWindow(a, makeWindow('kline', 1, 3, 3, 1))).toBe(false);
  });

  it('周期 → bar 秒数映射（未知档位显式回退 D1，不得退化为 0）', () => {
    expect(periodSeconds('M1')).toBe(60);
    expect(periodSeconds('D1')).toBe(86400);
    expect(periodSeconds('UNKNOWN')).toBe(86400);
    expect(periodSeconds(null)).toBe(86400);
  });

  it('L1 回合窗口 = [open, close] ± 2 根 buffer；L2 = 目标 bar 居中 120 根', () => {
    const open = SEC(100);
    const close = SEC(109);
    const w1 = roundTripWindow(open, close, 86400, 1);
    expect(w1.from_ts).toBe(open - 2 * 86400);
    expect(w1.to_ts).toBe(close + 2 * 86400);
    expect(w1.span_bars).toBe(14); // 10 根回合 + 两侧各 2 根
    expect(w1.source).toBe('jump');

    const center = SEC(300);
    const w2 = centeredWindow(center, 86400, 2);
    expect(w2.span_bars).toBe(120);
    const mid = (w2.from_ts + w2.to_ts) / 2;
    expect((mid - center) / 86400).toBeCloseTo(0.5, 6); // 119 根区间的中点在目标后 0.5 根（≤1 根量化误差）
    expect(w2.rev).toBe(2);
  });

  it('Open 回合（close_ts = null）⇒ 窗口退化到开仓点（不造 close）', () => {
    const open = SEC(42);
    const w = roundTripWindow(open, open, 86400, 1);
    expect(w.from_ts).toBe(open - 2 * 86400);
    expect(w.to_ts).toBe(open + 2 * 86400);
    expect(w.span_bars).toBe(5);
  });
});

describe('F7 节流（约 200ms，以最后一次为准）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('连发 5 次 ⇒ 提交次数 ≤ 2 且最后一次值胜出', () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const t = throttleLatest<number>((v) => fired.push(v), WINDOW_THROTTLE_MS);
    for (let i = 0; i < 5; i++) t.call(i);
    vi.advanceTimersByTime(1000);
    expect(fired[fired.length - 1]).toBe(4);
    expect(fired.length).toBeLessThanOrEqual(2);
  });

  it('节流窗之外的调用立即提交（不引入固定延迟）', () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const t = throttleLatest<number>((v) => fired.push(v), 200);
    t.call(1);
    vi.advanceTimersByTime(500);
    t.call(2);
    vi.advanceTimersByTime(0);
    expect(fired).toEqual([1, 2]);
  });

  it('flush() 立即提交挂起值（卸载/跳转需要确定性提交）', () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const t = throttleLatest<number>((v) => fired.push(v), 200);
    t.call(1);
    t.call(2);
    t.flush();
    expect(fired[fired.length - 1]).toBe(2);
  });
});

describe('F8 索引 → ts（getVisibleRange 经 dataList 转换）', () => {
  it('读回索引与 ts 成对一致', () => {
    const chart = chartWith();
    chart.setBarSpace(8);
    const r = readVisibleRangeTs(chart);
    expect(r).not.toBeNull();
    expect(r!.from_ts).toBe(SEC(r!.from_idx)); // 回调负载是**秒**（图表 dataList 是毫秒）
    expect(r!.to_ts).toBe(SEC(r!.to_idx));
    expect(r!.to_idx).toBeGreaterThan(r!.from_idx);
  });

  it('无数据 / NaN 视口 ⇒ null（不猜、不返回 0 区间）', () => {
    expect(readVisibleRangeTs(createSyncChartStub({ bars: [], paneWidthPx: 520 }))).toBeNull();
    const wide = createSyncChartStub({ bars: BARS, paneWidthPx: 520, limit: { min: 1, max: 4000 } });
    const chart = wide;
    wide.setBarSpace(1500); // 桩内 `barSpace > 2 × pane 宽` ⇒ getVisibleRange() 失效（NaN）
    expect(Number.isNaN(chart.getVisibleRange().from)).toBe(true);
    expect(readVisibleRangeTs(chart)).toBeNull();
  });
});

describe('F9 跳转断言（禁止 setBarSpace 静默越界）', () => {
  it('L2 居中 120 根：barSpace 生效且目标 bar 居中（误差 ≤1 根）', () => {
    const chart = chartWith();
    const target = SEC(300);
    const r = applyWindowOps(
      chart,
      { rev: 1, from_ts: target - 59 * 86400, to_ts: target + 60 * 86400, span_bars: 120, center_ts: target },
      { min: 1, max: 400 },
    );
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.requested_bar_space).toBe(4); // round(520 / 120)
    expect(r.observed!.bar_space).toBe(4);
    const center = (r.observed!.from_idx + r.observed!.to_idx) / 2;
    expect(Math.abs(center - 300)).toBeLessThanOrEqual(1); // E2 口径：中心 bar == 目标
  });

  it('L1 回合区间：目标落在窗口内且窗口根数 ≈ 指定 span', () => {
    const chart = chartWith();
    const center = SEC(120);
    const r = applyWindowOps(
      chart,
      { rev: 2, from_ts: center - 7 * 86400, to_ts: center + 6 * 86400, span_bars: 14, center_ts: center },
      { min: 1, max: 400 },
    );
    expect(r.ok).toBe(true);
    expect(r.observed!.from_idx).toBeLessThanOrEqual(120);
    expect(r.observed!.to_idx).toBeGreaterThanOrEqual(120);
  });

  it('**越界静默失败必须被捕获并显式报错**（构造 max=50 场景）', () => {
    // 引擎 limit max=50（看板默认），但调用方以为放宽到 400 ⇒ 请求 barSpace 104 会被静默 return
    const narrow = chartWith({ min: 1, max: 50 });
    const before = narrow.getBarSpace().bar;
    const target = SEC(300);
    const r = applyWindowOps(
      narrow,
      { rev: 3, from_ts: target, to_ts: target, span_bars: 5, center_ts: target },
      { min: 1, max: 400 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('静默吞掉');
    expect(r.requested_bar_space).toBe(104);
    expect(narrow.getBarSpace().bar).toBe(before); // 引擎确实什么都没做（静默 return）
  });

  it('数据未加载 / 未布局 / 能力缺失 ⇒ 显式失败（不得静默无反应）', () => {
    const empty = applyWindowOps(
      createSyncChartStub({ bars: [], paneWidthPx: 520 }),
      { rev: 4, from_ts: 1, to_ts: 2, span_bars: 10, center_ts: 1 },
      { min: 1, max: 400 },
    );
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('dataList 为空');

    const noLayout = applyWindowOps(
      createSyncChartStub({ bars: BARS, paneWidthPx: 0 }),
      { rev: 5, from_ts: SEC(0), to_ts: SEC(10), span_bars: 10, center_ts: SEC(5) },
      { min: 1, max: 400 },
    );
    expect(noLayout.ok).toBe(false);
    expect(noLayout.error).toContain('宽度不可测');

    const bare = applyWindowOps(
      { getSize: () => ({ width: 520 }) },
      { rev: 6, from_ts: 1, to_ts: 2, span_bars: 10, center_ts: 1 },
      { min: 1, max: 400 },
    );
    expect(bare.ok).toBe(false);
    expect(bare.error).toContain('不支持窗口命令');
  });

  it('窗口命令 rev 单调回传（调用方据此丢弃落后回执）', () => {
    const chart = chartWith();
    const r = applyWindowOps(
      chart,
      { rev: 77, from_ts: SEC(10), to_ts: SEC(20), span_bars: 11, center_ts: SEC(15) },
      { min: 1, max: 400 },
    );
    expect(r.rev).toBe(77);
  });
});
