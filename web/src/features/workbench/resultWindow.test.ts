import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';
import {
  applyWindowOps,
  buildCurveX,
  capDisclosure,
  centeredWindow,
  clampDisclosure,
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
  it('窗口构造携带 7 字段（from_ts/to_ts/span_bars/source/rev + **索引范围** from_idx/to_idx）且 span 归一', () => {
    const w = makeWindow('kline', 100, 200, 0, 3);
    // ADR-028 D2.1 第 3 条：窗口必须**同时**携带索引范围与 ts 范围（同源同步）；缺省（未给索引）⇒ null。
    expect(w).toEqual({
      from_ts: 100,
      to_ts: 200,
      span_bars: 1,
      source: 'kline',
      rev: 3,
      from_idx: null,
      to_idx: null,
    });
    // 给了索引范围则逐字段携带（x 映射用）
    expect(makeWindow('kline', 100, 200, 3, 4, { from_idx: 7, to_idx: 9 })).toEqual({
      from_ts: 100,
      to_ts: 200,
      span_bars: 3,
      source: 'kline',
      rev: 4,
      from_idx: 7,
      to_idx: 9,
    });
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

/**
 * ADR-028 D2.1/D2.3（2026-09-20 修复波）：曲线 x 定义域构建 + 窗口钳位/上限披露。
 * 全部为纯函数（可单测），UI 侧不得自行拼装定义域（禁第二处口径）。
 */
describe('buildCurveX（D2.1 主路 = bar 索引空间；D2.3-4 共用绘图区几何）', () => {
  const geom = {
    bar_ts: [1000, 1300, 1600, 1900],
    bar_space: 6,
    x_from_px: -83,
    chart_width_px: 666,
  };

  it('bar 序列可得 ⇒ 主路 index（**不是** ts 线性）+ 共用几何', () => {
    const b = buildCurveX({ geom, from_ts: 1000, to_ts: 1900, barSeconds: 300 });
    expect(b.degraded).toBe(false);
    expect(b.slots).toBe(4);
    expect(b.xDomain).toEqual({ mode: 'index', barTs: [1000, 1300, 1600, 1900], toleranceSec: 150 });
    expect(b.plot).not.toBeNull();
    // 几何：首根/末根落在 K 线同一屏幕坐标（D2.3-4）
    const screen = (x: number): number => ((x - b.plot!.x0) / b.plot!.w) * 666;
    expect(screen(8)).toBeCloseTo(-83, 3);
    expect(screen(8 + (984 / 3) * 3)).toBeCloseTo(-83 + 3 * 6, 3);
  });

  it('几何字段缺失（老负载/桩）⇒ 主路保留但 plot=null（曲线独立几何，不冒充）', () => {
    const b = buildCurveX({
      geom: { bar_ts: [1000, 1300], bar_space: null, x_from_px: null, chart_width_px: null },
      from_ts: 1000,
      to_ts: 1300,
      barSeconds: 300,
    });
    expect(b.xDomain?.mode).toBe('index');
    expect(b.plot).toBeNull();
  });

  it('bar 序列不可得 ⇒ **显式降级** ts 线性（degraded=true，禁静默）', () => {
    const b = buildCurveX({ geom: null, from_ts: 100, to_ts: 900, barSeconds: 300 });
    expect(b.degraded).toBe(true);
    expect(b.xDomain).toEqual({ mode: 'ts', from_ts: 100, to_ts: 900 });
    expect(b.plot).toBeNull();
  });

  it('无几何且无窗口 ⇒ xDomain=null（D2.2：禁止回退到数据自身 min/max 扇伸）', () => {
    const b = buildCurveX({ geom: null, from_ts: null, to_ts: null, barSeconds: 300 });
    expect(b.xDomain).toBeNull();
    expect(b.degraded).toBe(false);
  });

  it('bar 序列只有 1 根（退化）⇒ 不被当成主路（落入降级）', () => {
    const b = buildCurveX({
      geom: { bar_ts: [1000], bar_space: 6, x_from_px: 0, chart_width_px: 666 },
      from_ts: 1000,
      to_ts: 1300,
      barSeconds: 300,
    });
    expect(b.xDomain?.mode).toBe('ts');
    expect(b.degraded).toBe(true);
  });
});

describe('clampDisclosure（D2.3-1 ②：回读与请求比对，不一致**显式披露被钳位**）', () => {
  const cmd = { from_ts: 1000, to_ts: 4600, span_bars: 13 };

  it('实测 == 请求（±1 根）⇒ null（不打扰）', () => {
    expect(
      clampDisclosure(cmd, { from_ts: 1000, to_ts: 4600, from_idx: 0, to_idx: 12 }, 300),
    ).toBeNull();
    expect(
      clampDisclosure(cmd, { from_ts: 1300, to_ts: 4600, from_idx: 1, to_idx: 12 }, 300),
    ).toBeNull();
  });

  it('末端被数据边缘夹取（常见 L2 夹具）⇒ 披露请求 vs 实测', () => {
    const msg = clampDisclosure(cmd, { from_ts: 3400, to_ts: 4600, from_idx: 8, to_idx: 12 }, 300);
    expect(msg).toContain('被钳位');
    expect(msg).toContain('13 根');
    expect(msg).toContain('5 根');
  });

  it('根数差 > 1（barSpace 被夹到下限）⇒ 披露', () => {
    const msg = clampDisclosure(cmd, { from_ts: 1000, to_ts: 4600, from_idx: 0, to_idx: 3 }, 300);
    expect(msg).toContain('4 根');
  });

  it('缺请求或缺回执 ⇒ null（无从比对，不得编造披露）', () => {
    expect(clampDisclosure(null, { from_ts: 0, to_ts: 1, from_idx: 0, to_idx: 1 }, 300)).toBeNull();
    expect(clampDisclosure(cmd, null, 300)).toBeNull();
  });
});

describe('capDisclosure（D2.3-3：全览的物理上限必须显式披露）', () => {
  it('实际可见 < 全部 ⇒ 「显示 N / 共 M 根（受渲染上限约束）」', () => {
    const msg = capDisclosure(614, 1949);
    expect(msg).toContain('显示 614 / 共 1949 根');
    expect(msg).toContain('受渲染上限约束');
    expect(msg).toContain('31.5%');
  });

  it('全部可见 ⇒ null（不画蛇添足）', () => {
    expect(capDisclosure(1949, 1949)).toBeNull();
  });

  it('数据不可知（null）⇒ null（不得把缺失读成 0）', () => {
    expect(capDisclosure(null, 1949)).toBeNull();
    expect(capDisclosure(10, 0)).toBeNull();
  });
});

/**
 * ADR-028 D2.1 降级链（2026-09-20 修复波）：查表源不可得时的**显式**降级顺序
 * ① K 线所绘制的同一 bar 序列 → ② run 的 per_bar ts 序列 → ③ 纯 ts 线性。禁静默。
 */
describe('buildCurveX 降级链（kline → per_bar → ts）', () => {
  const perBarTs = [1000, 1300, 1600, 1900, 2200];

  it('② K 线 bar 序列不可得 ⇒ 回退 run per_bar ts（source=per_bar，degraded=true，无共用几何）', () => {
    const b = buildCurveX({ geom: null, perBarTs, from_ts: 1300, to_ts: 1900, barSeconds: 300 });
    expect(b.source).toBe('per_bar');
    expect(b.degraded).toBe(true);
    expect(b.plot).toBeNull();
    expect(b.xDomain).toEqual({ mode: 'index', barTs: [1300, 1600, 1900], toleranceSec: 150 });
  });

  it('② 的窗口为空（全区间）⇒ 用全量 per_bar ts', () => {
    const b = buildCurveX({ geom: null, perBarTs, from_ts: null, to_ts: null, barSeconds: 300 });
    expect(b.source).toBe('per_bar');
    expect(b.slots).toBe(perBarTs.length);
  });

  it('③ per_bar 也不可得 ⇒ 纯 ts 线性（source=ts）', () => {
    const b = buildCurveX({ geom: null, perBarTs: null, from_ts: 100, to_ts: 900, barSeconds: 300 });
    expect(b.source).toBe('ts');
    expect(b.degraded).toBe(true);
  });

  it('① 主路优先：K 线 bar 序列可得时**不得**走 per_bar（source=kline、degraded=false）', () => {
    const b = buildCurveX({
      geom: { bar_ts: [1000, 1300], bar_space: 6, x_from_px: 0, chart_width_px: 520 },
      perBarTs,
      from_ts: 1000,
      to_ts: 1300,
      barSeconds: 300,
    });
    expect(b.source).toBe('kline');
    expect(b.degraded).toBe(false);
    expect(b.plot).not.toBeNull();
  });
});
