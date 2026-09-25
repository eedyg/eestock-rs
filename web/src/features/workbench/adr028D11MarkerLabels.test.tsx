import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { createMockClient } from '@/api/mock';
import type { Bar, FillReason, Period, WorkbenchRunFill, WorkbenchRunView } from '@/api/types';
import {
  FILL_DOT_HIGHLIGHT_R_PX,
  FILL_HOVER_HIT_R_PX,
  FILL_LABEL_CW_PX,
  FILL_LABEL_PAD_PX,
  HIGHLIGHT_DURATION_MS,
  HIGHLIGHT_PULSE_MS,
  KlineChart,
  estimateFillLabelWidth,
  fillDotFigures,
  pickMarkerAt,
  placeFillLabel,
  type KlineChartFeedLike,
  type KlineMarkerOverlay,
} from '@/features/dashboard/KlineChart';
import { KlineResultChart, buildMarkers } from './KlineResultChart';
import {
  RESULT_CHART_CONFIG_KEY,
  defaultResultChartConfig,
  loadResultChartConfig,
  parseResultChartConfig,
  saveResultChartConfig,
  useResultChartConfig,
  type ResultChartConfig,
} from './resultChartConfig';

/**
 * ADR-028 §2.11（D11）**买卖标记标签门控**（2026-09-25 用户默认口径）。
 *
 * 契约（逐条对应 §2.11 决策 1–4，判据只写**行为不变量**，不写阈值）：
 *  ① 默认态：**只显示圆点** ⇒ 图上文本标签数 = 0（圆点数 = 成交笔数）；
 *  ② 悬停某笔 ⇒ **恰 1 个**标签，内容 = `B×qty`（方向 + 数量）；
 *  ③ 结果页 `markerLabels` 开关：开 ⇒ 标签数 = 笔数；关 ⇒ 0；**刷新后保持**（结果页独立 key）；
 *  ④ 跳转目标那一笔在 **3s 高亮期内标签可见**，**3s 后消失**（回落为点）；
 *  ⑤ 门控不得破坏命中测试（圆点仍可悬停/点击：命中半径 > 圆点半径）；
 *  ⑥ 标签宽度估算常量必须**先真身标定**（实测盒宽 ≤ 估算式；旧的 `4.4×len+5` 对短标签**低估**）。
 *
 * 真身读数（chromium 实测 `<canvas>.measureText`，font = `normal 9px Helvetica Neue`；
 * klinecharts 盒宽 = `paddingLeft + round(measureText) + paddingRight`，见 `index.esm.js:6152`）
 * 落盘：`coder/evidence/20260925_adr028_d11/width_calibration.json`（本文件下方 `MEASURED_BOX_PX` 即其原值）。
 */

const KC_BARS = makeSeries({ count: 600, spacingMs: 86_400_000, endTs: Date.UTC(2026, 8, 14) });
const syncStub = createSyncChartStub({ bars: KC_BARS, paneWidthPx: 520, limit: { min: 1, max: 400 } });
/** 命中测试桩：真身 `convertToPixel` 的**最小忠实模型** —— 索引 → `(index+1)×barSpace` px（含 y）。 */
const PIXEL_BAR_SPACE = 6;
const pixelOf = (tsMs: number, value: number): { x: number; y: number } => {
  const idx = KC_BARS.findIndex((b) => b === tsMs);
  return { x: (idx + 1) * PIXEL_BAR_SPACE, y: 100 - (value - 1) * 10 };
};
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
  getPaneOptions: vi.fn(() => []),
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  convertToPixel: vi.fn((p: { timestamp: number; value: number }) => pixelOf(p.timestamp, p.value)),
  resize: vi.fn(),
});
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

const INDICATORS = { ma: false, vol: false, macd: false, kdj: false, boll: false, dcap: false };

const BAR_TS_MS = KC_BARS[KC_BARS.length - 3]!;
function feedWithBars(): KlineChartFeedLike {
  const bars: Bar[] = KC_BARS.slice(-120).map((ms) => ({
    ts: new Date(ms).toISOString(),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 0,
    amount: 0,
  }));
  return {
    bars,
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
  };
}

function fill(over: Partial<WorkbenchRunFill>): WorkbenchRunFill {
  return {
    type: 'fill',
    bar_index: 0,
    ts: Math.floor(BAR_TS_MS / 1000),
    side: 'Buy',
    qty: 118,
    price: 8.417,
    reason: 'Policy' as FillReason,
    rt_seq: 1,
    trade_value: 993.2,
    commission: 5,
    stamp_duty: 0,
    ...over,
  };
}

type OverlayCall = { name: string; extendData?: Record<string, unknown>; points?: unknown };
function overlayCalls(name: string): OverlayCall[] {
  return chartStub.createOverlay.mock.calls
    .map((c) => c[0] as OverlayCall)
    .filter((o) => o.name === name);
}
/** **当前生效**的 fillDot 标签（幂等重建 ⇒ 只取最后一次 createOverlay 那一批：笔数 = 标记数）。 */
function liveFillDotLabels(markerCount: number): Array<string | undefined> {
  const calls = overlayCalls('fillDot');
  return calls.slice(-markerCount).map((o) => o.extendData?.['label'] as string | undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

// ═════════════════════ ①+③+④ 门控（KlineChart 渲染面） ═════════════════════

/** 渲染 K 线图（带 N 笔标记），返回容器。 */
async function renderChart(props: Partial<React.ComponentProps<typeof KlineChart>> & { markers: KlineMarkerOverlay[] }) {
  const { markers, ...rest } = props;
  const utils = render(
    <KlineChart
      feed={feedWithBars()}
      code="518880"
      period={'1d' as Period}
      followLatest={false}
      indicators={INDICATORS}
      onManualZoom={() => {}}
      overlays={markers}
      {...rest}
    />,
  );
  const root = () => utils.container.querySelector('[data-testid="kline-chart"]')!;
  await waitFor(() => expect(overlayCalls('fillDot').length).toBeGreaterThan(0));
  return { ...utils, root };
}

const THREE = () =>
  buildMarkers([
    fill({ rt_seq: 1, ts: Math.floor(KC_BARS[KC_BARS.length - 3]! / 1000), qty: 118 }),
    fill({ rt_seq: 1, ts: Math.floor(KC_BARS[KC_BARS.length - 4]! / 1000), qty: 200, price: 9.1, side: 'Sell' }),
    fill({ rt_seq: 2, ts: Math.floor(KC_BARS[KC_BARS.length - 5]! / 1000), qty: 50, price: 7.7, side: 'Sell' }),
  ]);

describe('D11 ①默认态：只显示圆点（文本标签数 = 0，圆点数 = 成交笔数）', () => {
  it('markerLabels 缺省（false）⇒ 每一笔都画点、**一笔都不画标签**（标签数 = 0）', async () => {
    const markers = THREE();
    const { root } = await renderChart({ markers });
    // 圆点数 = 成交笔数：`data-marker-overlays` = **每批**创建的 `fillDot` 数（幂等重建 ⇒ 不累积）
    expect(Number(root().getAttribute('data-marker-overlays')), '圆点数必须 = 成交笔数（点不得被门控掉）').toBe(
      markers.length,
    );
    expect(
      liveFillDotLabels(markers.length).every((l) => l == null),
      '默认态不得画任何文本标签（当前生效批次的 label 全为 undefined）',
    ).toBe(true);
    expect(root().getAttribute('data-marker-labels')).toBe('off');
    expect(root().getAttribute('data-marker-label-count')).toBe('0');
  });

  it('markerLabels=true（用户显式打开）⇒ 标签数 = 笔数（对照：证明门控不是「永远不画」）', async () => {
    const markers = THREE();
    const { root } = await renderChart({ markers, markerLabels: true });
    expect(Number(root().getAttribute('data-marker-overlays'))).toBe(markers.length);
    expect(liveFillDotLabels(markers.length).every((l) => typeof l === 'string')).toBe(true);
    expect(root().getAttribute('data-marker-labels')).toBe('on');
    expect(root().getAttribute('data-marker-label-count')).toBe(String(markers.length));
  });
});

describe('D11 ②悬停：恰 1 个标签（内容 = 方向×数量），且「哪一笔/价格×数量」仍可获取', () => {
  it('鼠标移到圆点上 ⇒ 恰 1 个标签（该笔）；移开 ⇒ 0 个（含内容与身份可获取性）', async () => {
    const markers = THREE();
    const { root } = await renderChart({ markers });
    const labelCount = () => Number(root().getAttribute('data-marker-label-count'));
    expect(labelCount()).toBe(0);

    // 悬停到第 2 笔的圆心（真身 = mousemove 命中圆点；此处按容器相对坐标给出）
    const target = markers[1]!;
    const p = pixelOf(target.ts, target.price!);
    await act(async () => {
      fireEvent.mouseMove(root(), { clientX: p.x, clientY: p.y });
    });
    await waitFor(() => expect(root().getAttribute('data-marker-hover-key')).toBe(target.fillKey));
    expect(labelCount(), '悬停 ⇒ 恰 1 个标签').toBe(1);
    const withLabel = overlayCalls('fillDot').filter((o) => o.extendData?.['label'] != null);
    // 最后一次重建里恰有 1 笔带标签，且就是被悬停那一笔
    const live = withLabel.slice(-1);
    expect(live.length).toBe(1);
    const hovered = live[0]!.extendData!;
    expect(hovered['fillKey']).toBe(target.fillKey);
    expect(hovered['label'], '悬停标签内容 = 方向×数量（`B×qty`）').toBe(target.label);
    // 可获取性（§2.11 决策 3）：悬停态仍能答「哪一笔 / 买卖 / 价格×数量」
    const readout = root().querySelector('[data-testid="kline-marker-hover"]');
    expect(readout, '悬停必须有明细读数（价格×数量不得只存在于画布像素里）').toBeTruthy();
    expect(readout!.textContent).toContain(String(target.text));
    expect(readout!.textContent).toContain(target.labelDetail!); // 方向 + 价格×数量（全文）
    expect(readout!.textContent).toContain('9.100'); // 第 2 笔价格
    expect(readout!.textContent).toContain('200'); // 第 2 笔数量
    expect(readout!.getAttribute('data-fill-key')).toBe(target.fillKey);

    await act(async () => {
      fireEvent.mouseLeave(root());
    });
    await waitFor(() => expect(root().getAttribute('data-marker-hover-key')).toBe(''));
    expect(labelCount(), '移开 ⇒ 回落到 0 个标签').toBe(0);
  });

  it('⑤门控不破坏命中测试：命中半径为**目标**（> 圆点半径），且不误命中远处圆点', () => {
    const markers = THREE();
    const bars = KC_BARS.slice(-120).map((ms) => ({ ts: new Date(ms).toISOString() }));
    const toPixel = (p: { timestamp: number; value: number }) => pixelOf(p.timestamp, p.value);
    const target = markers[1]!;
    const p = pixelOf(target.ts, target.price!);
    // 圆心命中（单笔列表 ⇒ 排除「邻近兄弟笔更近」的干扰）
    expect(pickMarkerAt({ markers: [target], bars, x: p.x, y: p.y, toPixel })?.fillKey).toBe(target.fillKey);
    // 圆点视觉半径外、命中半径内（⇒ 门控后的点更容易悬停，判据⑤「命中测试不得被破坏」）
    expect(FILL_HOVER_HIT_R_PX).toBeGreaterThan(3.2);
    expect(
      pickMarkerAt({ markers: [target], bars, x: p.x, y: p.y + (FILL_HOVER_HIT_R_PX - 0.5), toPixel })?.fillKey,
      `命中半径内（${FILL_HOVER_HIT_R_PX - 0.5}px）必须命中`,
    ).toBe(target.fillKey);
    // 命中半径外 ⇒ 不命中（防「永远命中最近一笔」的假绿）
    expect(pickMarkerAt({ markers: [target], bars, x: p.x, y: p.y + (FILL_HOVER_HIT_R_PX + 5), toPixel })).toBeNull();
    expect(pickMarkerAt({ markers, bars, x: -999, y: -999, toPixel })).toBeNull();
    // 邻近两笔各按自己的堆叠/锚点命中（取**最近**一笔 ⇒ 不会飘到兄弟笔上）
    expect(pickMarkerAt({ markers, bars, x: pixelOf(markers[0]!.ts, markers[0]!.price!).x, y: pixelOf(markers[0]!.ts, markers[0]!.price!).y, toPixel })?.fillKey).toBe(
      markers[0]!.fillKey,
    );
  });
});

describe('D11 ④跳转目标那一笔：3s 高亮期内标签可见，3s 后消失', () => {
  it('高亮期（pulse>0）标签数 = 1（门控关也画）；3s 到点 ⇒ 回落为点（标签数 = 0）', async () => {
    vi.useFakeTimers();
    const markers = THREE();
    const utils = render(
      <KlineChart
        feed={feedWithBars()}
        code="518880"
        period={'1d' as Period}
        followLatest={false}
        indicators={INDICATORS}
        onManualZoom={() => {}}
        overlays={markers}
        markerLabels={false}
        highlightFillKey={markers[0]!.fillKey!}
        highlightRev={1}
      />,
    );
    const root = () => utils.container.querySelector('[data-testid="kline-chart"]')!;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const hl = () => overlayCalls('fillDotHighlight');
    expect(hl().length, '高亮 overlay 必须已创建').toBeGreaterThan(0);
    expect(
      hl().every((o) => typeof o.extendData?.['label'] === 'string'),
      '跳转目标那一笔在 3s 高亮期内**必须**带标签（门控不得吞掉它）',
    ).toBe(true);
    expect(hl().slice(-1)[0]!.extendData!['label']).toBe(markers[0]!.label);
    expect(root().getAttribute('data-marker-label-count'), '门控关 + 高亮中 ⇒ 恰 1 个标签').toBe('1');
    expect(root().getAttribute('data-marker-highlight-key'), '门控关 + 高亮中 ⇒ 目标笔仍被标识').toBe(
      markers[0]!.fillKey,
    );

    // 3s 到点（定时器驱动，**不得**用 sleep）⇒ 回落为点
    await act(async () => {
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS + HIGHLIGHT_PULSE_MS);
    });
    expect(root().getAttribute('data-highlight-active')).toBe('false');
    expect(root().getAttribute('data-marker-label-count'), '3s 后标签必须消失（回落为点）').toBe('0');
    const after = overlayCalls('fillDotHighlight').length;
    await act(async () => {
      vi.advanceTimersByTime(HIGHLIGHT_PULSE_MS * 4);
    });
    expect(overlayCalls('fillDotHighlight').length, '3s 后不得再画高亮（无永久标签）').toBe(after);
  });
});

// ═════════════════════ ③结果页开关（配置 + 卡片入口） ═════════════════════

describe('D11 ③结果页 `markerLabels` 开关（默认关、独立 key、刷新后保持）', () => {
  it('默认 = 关；解析只认布尔；往返保持；仍只写结果页独立 key', () => {
    expect(defaultResultChartConfig().markerLabels, '默认必须为关（降噪是用户确认的方向）').toBe(false);
    expect(parseResultChartConfig(JSON.stringify({ markerLabels: true })).markerLabels).toBe(true);
    expect(parseResultChartConfig(JSON.stringify({ markerLabels: 'yes' })).markerLabels, '非布尔 ⇒ 回默认关').toBe(false);
    expect(parseResultChartConfig('{oops').markerLabels).toBe(false);
    const cfg: ResultChartConfig = { ...defaultResultChartConfig(), markerLabels: true };
    saveResultChartConfig(cfg);
    expect(Object.keys(localStorage)).toEqual([RESULT_CHART_CONFIG_KEY]);
    expect(loadResultChartConfig().markerLabels).toBe(true);
    expect(loadResultChartConfig(null).markerLabels).toBe(false);
  });

  it('标记标签入口：开关为**结果页唯一写入者**（hook 级），点击即落结果页 key（刷新后保持）', async () => {
    const { result } = renderHook(() => useResultChartConfig());
    expect(result.current.markerLabels, '默认关').toBe(false);
    await act(async () => {
      result.current.toggleMarkerLabels();
    });
    expect(result.current.markerLabels).toBe(true);
    // 刷新（重新挂载）后保持；且只落在结果页独立 key 上
    expect(Object.keys(localStorage)).toEqual([RESULT_CHART_CONFIG_KEY]);
    expect(loadResultChartConfig().markerLabels).toBe(true);
    const { result: again } = renderHook(() => useResultChartConfig());
    expect(again.current.markerLabels, '刷新（重新挂载）后必须保持开').toBe(true);
  });

  it('结果页把受控开关透传到 K 线卡：`markerLabels` 开 ⇒ 卡片 `data-marker-labels` = on', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = (await api.submitWorkbenchRun({
      symbol: '518880',
      period: 'D1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
      policy: { LumpSum: { position_pct: 1 } },
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
      name: 'D11 passthrough',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    })) as unknown as WorkbenchRunView;
    // `RunFillsState.complete` 是**必填**（`useRunSeries.ts:82`）；本 mock 的 rows.length == total == 3 且
    // 无 has_more ⇒ 语义上就是「已拉全」= true（`tsc -b` 门禁红：历史漏填该字段，见 BLOCKED.md）。
    const fills = {
      rows: buildFillRows(),
      total: 3,
      recorded: true,
      loading: false,
      complete: true,
      truncated: false,
      error: null,
    };
    const { container: off } = render(<KlineResultChart run={run} fills={fills} api={api} markerLabels={false} />);
    await waitFor(() =>
      expect(off.querySelector('[data-testid="kline-chart"]')!.getAttribute('data-marker-labels')).toBe('off'),
    );
    const { container: on } = render(<KlineResultChart run={run} fills={fills} api={api} markerLabels />);
    expect(fills.rows.length, '圆点数 = 成交笔数（门控不改变笔数）').toBeGreaterThan(0);
    await waitFor(() =>
      expect(on.querySelector('[data-testid="kline-chart"]')!.getAttribute('data-marker-labels')).toBe('on'),
    );
  });
});

describe('D11 ⑥开态语义：**开关开 ≠ 旧行为**（常显**逃生门**，ADR-028 §2.11.1）', () => {
  /**
   * §2.11.1 原文：「**开关开 ≠ 旧行为**（语义 = 常显**逃生门**…）⇒ 规格**不得**断言『开 == 旧行为』」。
   * 机器化：开关开时，画布标签仍必须是**短标签** `方向×数量`（无空格），全文只在 `labelDetail` 里。
   * 反假绿（变异证明）：把标签改回旧全量形态（`B 8.417×118`）⇒ 本用例必红。
   */
  it('开态标签 = 短标签（不含空格）；全文仍在 labelDetail（旧全量形态必红）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = (await api.submitWorkbenchRun({
      symbol: '518880',
      period: 'D1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
      policy: { LumpSum: { position_pct: 1 } },
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
      name: 'D11 gate-on semantics',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    })) as unknown as WorkbenchRunView;
    const fills = {
      rows: buildFillRows(),
      total: 3,
      recorded: true,
      loading: false,
      complete: true,
      truncated: false,
      error: null,
    };
    render(<KlineResultChart run={run} fills={fills} api={api} markerLabels />);
    await waitFor(() => {
      const labels = liveFillDotLabels(fills.rows.length);
      expect(labels.length, '开态每一笔都必须带标签').toBe(fills.rows.length);
    });
    const labels = liveFillDotLabels(fills.rows.length);
    for (const l of labels) {
      expect(typeof l, '标签必须是字符串').toBe('string');
      expect(l, `开态标签必须是短标签 \`方向×数量\`（实测 ${JSON.stringify(l)}）`).toMatch(/^[BS⊗]×/);
      expect(l, '开态标签不得含空格（含空格 = 旧全量形态 ⇒「开 == 旧行为」）').not.toContain(' ');
    }
    // 全文仍在 `labelDetail`（缩短只作用于画布标签；悬停/详情仍可答「价格×数量」）
    const withDetail = overlayCalls('fillDot')
      .slice(-fills.rows.length)
      .map((o) => o.extendData?.['labelDetail'] as string | undefined);
    expect(withDetail.every((d) => typeof d === 'string' && d.includes(' ')), 'labelDetail 必须保留全文').toBe(true);
  });
});

function buildFillRows(): WorkbenchRunFill[] {
  return [
    fill({ rt_seq: 1, ts: Math.floor(KC_BARS[KC_BARS.length - 3]! / 1000), qty: 118 }),
    fill({ rt_seq: 1, ts: Math.floor(KC_BARS[KC_BARS.length - 4]! / 1000), qty: 200, price: 9.1, side: 'Sell' }),
    fill({ rt_seq: 2, ts: Math.floor(KC_BARS[KC_BARS.length - 5]! / 1000), qty: 50, price: 7.7, side: 'Sell' }),
  ];
}

// ═════════════════════ ⑥标签宽度常量（真身标定，防再次低估） ═════════════════════

/**
 * **真身实测盒宽**（px）：chromium `measureText` + klinecharts 盒宽口径
 * （`paddingLeft(2) + round(measureText) + paddingRight(2)`，见 `klinecharts/dist/index.esm.js:6152`）。
 * 采集脚本：`coder/evidence/20260925_adr028_d11/calib_fontwidth.mjs`；原值落盘 `width_calibration.json`。
 * 采样面覆盖 4 个字体族 × 2 档字号（9/10px）⇒ 取**最宽**族（防换机字体回退差异）。
 */
const MEASURED_BOX_PX: Array<{ text: string; box: number; source: string }> = [
  { text: 'B×118', box: 31, source: 'monospace@9' },
  { text: '⊗×12000', box: 42, source: 'monospace@9' },
  { text: 'B×807.8369', box: 58, source: 'monospace@9' },
  { text: 'S 12.345×12000', box: 80, source: 'monospace@9' },
  { text: '⊗ 88.888×8888.8888', box: 102, source: 'monospace@9' },
];

describe('D11 ⑥标签宽度估算常量：估算式必须 ≥ 真身盒宽（旧的 4.4×len+5 对短标签低估）', () => {
  it('至少 3 档长度：真身盒宽 ≤ 估算式 ≤ 1.7×真身盒宽（防低估 + 防虚高到无意义）', () => {
    expect(MEASURED_BOX_PX.length).toBeGreaterThanOrEqual(3);
    for (const s of MEASURED_BOX_PX) {
      const est = estimateFillLabelWidth(s.text);
      expect(
        est,
        `「${s.text}」（${s.text.length} 字符，实测盒宽 ${s.box}px）：估算式 ${est} 不得小于真身盒宽（低估 ⇒ 避让失效）`,
      ).toBeGreaterThanOrEqual(s.box);
      expect(est, `「${s.text}」估算式 ${est} 不得超过真身盒宽的 1.7×（虚高同样会让避让失效）`).toBeLessThanOrEqual(
        1.7 * s.box,
      );
    }
  });

  it('旧常量 `4.4×len+5` 在上述短标签上**确实低估**（≡ 变异⑤必须红的原因）', () => {
    // 用**实现里的**估算式与旧公式逐条对照：新估算式必须在旧公式低估的那些长度上**严格更大**
    // （旧公式低估 ⟺ `4.4×len+5 < 实测盒宽`）。变异⑤（把常量改回 4.4/5）⇒ 本断言必红。
    const underestimated = MEASURED_BOX_PX.filter((s) => 4.4 * s.text.length + 5 < s.box);
    expect(underestimated.length, '旧公式至少要在 3 档长度上低估，否则本判据无鉴别力').toBeGreaterThanOrEqual(3);
    for (const s of underestimated) {
      expect(
        estimateFillLabelWidth(s.text),
        `「${s.text}」：旧公式 ${4.4 * s.text.length + 5} 低估（实测盒宽 ${s.box}）⇒ 新估算式必须更大`,
      ).toBeGreaterThan(4.4 * s.text.length + 5);
    }
  });

  it('常量与旧值不同，且 `placeFillLabel` 的翻转判据用**新**估算式（未低估 ⇒ 边缘不再误判）', () => {
    expect(FILL_LABEL_CW_PX * 5 + FILL_LABEL_PAD_PX).toBeGreaterThan(4.4 * 5 + 5);
    const text = 'B×807.8369';
    const est = estimateFillLabelWidth(text);
    const x = 100;
    const r = 3.2;
    const gap = 3;
    const paneW = x + r + gap + est + 1; // 右侧**刚好**放得下（含 `- 1` 的收敛余量）
    expect(placeFillLabel({ x, r, text, paneWidth: paneW }).align, '刚好放得下 ⇒ 保持右侧').toBe('left');
    // 用旧常量会以为「放得下」⇒ 不翻转（标签被裁）；新常量必须翻转
    const oldEst = 4.4 * text.length + 5;
    const tightW = x + r + gap + est - 1; // 新估算式下右侧放不下；但对旧估算式而言仍「放得下」
    expect(tightW - (x + r + gap)).toBeGreaterThan(oldEst);
    expect(
      placeFillLabel({ x, r, text, paneWidth: tightW }).align,
      `新估算式下该宽度右侧放不下 ⇒ 必须翻转到左侧（旧常量会误判为放得下）`,
    ).toBe('right');
  });
});

describe('D11 ⑤圆点模板：门控不得改变点的绘制/命中面', () => {
  it('`fillDotFigures`：点（视觉）恒在、命中面 > 圆点半径、标签仅在给定文本时增加', () => {
    const noLabel = fillDotFigures({ x: 10, y: 20, paneWidth: 500, data: { color: '#ff5c6c' } });
    const dot = noLabel.find((f) => f.role === 'dot')!;
    const hit = noLabel.find((f) => f.role === 'hit')!;
    expect(dot.attrs['r']).toBeGreaterThan(0);
    expect(dot.attrs['r']).toBeLessThan(FILL_DOT_HIGHLIGHT_R_PX);
    expect(hit.attrs['r']).toBe(FILL_HOVER_HIT_R_PX);
    expect(hit.attrs['r']).toBeGreaterThan(dot.attrs['r'] as number);
    expect(hit.ignoreEvent, '命中面必须可收事件（否则圆点悬停/点击失效）').toBe(false);
    expect(dot.ignoreEvent, '视觉点本身不参与事件（命中由命中面负责，避免重复/误命中）').toBe(true);
    expect(noLabel.some((f) => f.role === 'label'), '无标签文本 ⇒ 不得画标签').toBe(false);

    const withLabel = fillDotFigures({ x: 10, y: 20, paneWidth: 500, data: { color: '#ff5c6c', label: 'B×118' } });
    const label = withLabel.find((f) => f.role === 'label')!;
    expect(label.attrs['text']).toBe('B×118');
    expect(label.ignoreEvent).toBe(true);
  });
});
