/**
 * P5 高度权威交还口径（`onHeightsChange` 返回 Promise 的语义）——实现侧补充用例。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodLayoutHandshake.test.tsx`
 * 依据：P5-B 裁决二（2026-09-15）—— 父层返回 Promise ⇒ 已接管高度权威；该 Promise settle
 * （**成功回显 / 失败回滚**）后组件**交还高度权威给 props**；返回 `undefined` ⇒ 保留本地拖拽结果。
 *
 * 为什么必须有本文件（C3 暴露的真实缺口）：页面的「乐观写 store + 失败回滚」可在同一 React 提交内
 * 被批处理 ⇒ 组件仅凭 props 无法区分「父层已回滚」与「父层未接管」；若不在父层落定后交还权威，
 * 失败回滚会被本地拖拽期望掩盖（面板停在拖后高度 = 用户看到成功假象）。
 *
 * 覆盖（正向断言，非仅成功路径）：
 *  H1 父层返回 **rejected** Promise ⇒ settle 后组件反映 props 的**回滚值**（不得保留本地拖拽值）。
 *  H2 父层返回 **resolved** Promise + props 变为**服务端回显值**（≠ 拖拽值）⇒ 组件采用回显值。
 *  H3 父层返回 `undefined`（未接管，如测试探针）⇒ 组件**保留**本地拖拽结果。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { useCallback, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';
import { distributeStackHeights, heightsByPeriod, DRAG_DEBOUNCE_MS } from './multiPeriodLayout';

// ── klinecharts 桩（与 P2/P5 DOM 契约测试同源：卫星实例必须能 init）────────────────
vi.mock('klinecharts', async () => {
  const { createChartStoreStub } = await import('@/test/chartStoreStub');
  return {
    init: vi.fn(() => ({
      ...createChartStoreStub(),
      setSymbol: vi.fn(),
      setPeriod: vi.fn(),
      setDataLoader: vi.fn(),
      setBarSpace: vi.fn(),
      overrideIndicator: vi.fn(),
      resetData: vi.fn(),
      setStyles: vi.fn(),
      resize: vi.fn(),
      setPaneOptions: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToDataIndex: vi.fn(),
      getVisibleRange: vi.fn(() => ({ from: 0, to: 10 })),
      getSize: vi.fn(() => ({ width: 980, height: 600 })),
      convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
      createOverlay: vi.fn(),
      removeOverlay: vi.fn(),
      subscribeAction: vi.fn(),
      unsubscribeAction: vi.fn(),
    })),
    dispose: vi.fn(),
    registerIndicator: vi.fn(),
  };
});

import { MultiPeriodChartStack } from './MultiPeriodChartStack';

const BAR = { ts: '2026-09-15T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 };
const api = stubApi({ getKline: vi.fn(async () => [BAR]) }) as unknown as ApiClient;
const ws = {
  connectionStatus: 'open',
  subscribe: () => () => {},
  onStatusChange: () => () => {},
} as unknown as WsClient;

const INDICATORS = { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: true };
const BASE = '15m';
const SATS = ['1h', '5m', '1d'];
const ALL = [BASE, ...SATS];
/** 配置请求高度（默认 420 + 3×180 = 960 > 600 ⇒ 首屏即缩小）。 */
const REQ: Record<string, number> = { '15m': 420, '1h': 180, '5m': 180, '1d': 180 };
const AVAILABLE = 600;

interface SaveCtx {
  heights: Record<string, number>;
  setHeights: (h: Record<string, number>) => void;
}

/** 复刻页面：`save` 内部可乐观写回 / 回滚 / 回显；返回值即「是否接管」的信号。 */
function Host({ initial, save }: { initial: Record<string, number>; save: (ctx: SaveCtx) => void | Promise<unknown> }) {
  const [heights, setHeights] = useState<Record<string, number>>({ ...initial });
  const apply = useCallback((h: Record<string, number>) => setHeights({ ...h }), []);
  const handle = useCallback(
    (h: Record<string, number>) => save({ heights: h, setHeights: apply }),
    [apply, save],
  );
  return (
    <MultiPeriodChartStack
      enabled
      code="518880"
      api={api}
      ws={ws}
      indicators={INDICATORS}
      maWindows={[5, 10, 20]}
      dcapParams={DEFAULT_DCAP_PARAMS}
      viewportBars={120}
      followLatest
      basePeriod={BASE}
      basePeriodSource="config"
      availableHeight={AVAILABLE}
      baseHeight={heights[BASE]}
      satellites={SATS.map((p) => ({ period: p as never, height: heights[p]! }))}
      onHeightsChange={handle}
    >
      <div data-testid="base-child" />
    </MultiPeriodChartStack>
  );
}

/** 分配算法的「预言值」：给定配置 heights + 可用高度，DOM 应呈现的高度。 */
function expectedLayout(heights: Record<string, number>): Record<string, number> {
  return heightsByPeriod(
    distributeStackHeights({
      panes: [
        { key: BASE, period: BASE, requested: heights[BASE]!, isBase: true },
        ...SATS.map((p) => ({ key: p, period: p, requested: heights[p]!, isBase: false })),
      ],
      available: AVAILABLE,
    }),
  );
}

function readHeights(root: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ALL) {
    const el = root.querySelector<HTMLElement>(`[data-mp-pane="${p}"]`)!;
    out[p] = Number(el.getAttribute('data-mp-pane-height'));
  }
  return out;
}

function separator(root: HTMLElement, upper: string, lower: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-mp-separator="${upper}|${lower}"]`)!;
}

/** 拖拽 + 等防抖窗（真实计时器）。 */
async function dragAndSettle(sep: HTMLElement, deltaY: number): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(sep, { clientY: 300, button: 0 });
    fireEvent.mouseMove(window, { clientY: 300 + deltaY, buttons: 1 });
    fireEvent.mouseUp(window, { clientY: 300 + deltaY });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, DRAG_DEBOUNCE_MS + 60));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('P5 高度权威交还（onHeightsChange 回执语义）', () => {
  it('H1 父层 rejected（回滚到**拖前** props）⇒ settle 后反映 props 回滚值（不得保留本地拖拽值）', async () => {
    /** 复刻页面写法（与 C3 同形）：乐观写 payload → PUT 失败 ⇒ 回滚到拖前 store 态。
     *  两者可在**同一提交**内被批处理（props 前后完全一致）⇒ 本用例是「交还高度权威」的**唯一**正向证据：
     *  若删掉交还逻辑，面板会停在拖后高度（本地拖拽期望掩盖失败回滚）。 */
    const save = vi.fn(({ heights, setHeights }: SaveCtx) => {
      setHeights({ ...heights }); // 乐观写
      return new Promise((_, reject) => {
        setTimeout(() => {
          setHeights({ ...REQ }); // 失败回滚（= 拖前 props）
          reject(new Error('模拟 PUT 失败'));
        }, 0);
      });
    });
    const view = render(<Host initial={REQ} save={save} />);
    await act(async () => {});
    const before = readHeights(view.container);
    expect(Object.values(before).reduce((a, b) => a + b, 0), '首屏恰好填满').toBe(AVAILABLE);

    await dragAndSettle(separator(view.container, BASE, '1h'), 20);
    const after = readHeights(view.container);

    expect(save, '拖拽必须触发一次持久化回调').toHaveBeenCalledTimes(1);
    expect(after[BASE]!, '失败后不得保留本地拖拽值（before+20）').not.toBe(before[BASE]! + 20);
    expect(after, '必须回到 props（拖前配置）对应布局').toEqual(expectedLayout(REQ));
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(AVAILABLE);
  });

  it('H1b 父层 rejected（回滚到**另一**配置）⇒ props 是唯一权威（不保留任何本地拖拽痕迹）', async () => {
    const rollback: Record<string, number> = { '15m': 380, '1h': 160, '5m': 160, '1d': 160 };
    const save = vi.fn(({ heights, setHeights }: SaveCtx) => {
      setHeights({ ...heights });
      return new Promise((_, reject) => {
        setTimeout(() => {
          setHeights({ ...rollback });
          reject(new Error('模拟 PUT 失败'));
        }, 0);
      });
    });
    const view = render(<Host initial={REQ} save={save} />);
    await act(async () => {});
    const before = readHeights(view.container);

    await dragAndSettle(separator(view.container, BASE, '1h'), 20);
    const after = readHeights(view.container);

    expect(after[BASE]!, '不得保留本地拖拽值').not.toBe(before[BASE]! + 20);
    expect(after, '必须反映 props（回滚目标配置）对应布局').toEqual(expectedLayout(rollback));
  });

  it('H2 父层 resolved + 服务端回显（≠ 拖拽值）⇒ 组件采用 props 的回显值', async () => {
    const echo: Record<string, number> = { '15m': 300, '1h': 100, '5m': 100, '1d': 100 };
    const save = vi.fn(({ setHeights }: SaveCtx) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          setHeights({ ...echo }); // 服务端归一化回显
          resolve();
        }, 0);
      });
    });
    const view = render(<Host initial={REQ} save={save} />);
    await act(async () => {});
    const before = readHeights(view.container);

    await dragAndSettle(separator(view.container, BASE, '1h'), 20);
    const after = readHeights(view.container);

    expect(after[BASE]!, '不得停留在本地拖拽值（before+20）').not.toBe(before[BASE]! + 20);
    expect(after, '必须采用 props（服务端回显值）对应布局').toEqual(expectedLayout(echo));
    expect(after[BASE]).toBe(300);
  });

  it('H3 父层未接管（返回 undefined）⇒ 组件保留本地拖拽结果', async () => {
    const save = vi.fn(() => undefined);
    const view = render(<Host initial={REQ} save={save} />);
    await act(async () => {});
    const before = readHeights(view.container);

    await dragAndSettle(separator(view.container, BASE, '1h'), 20);
    const after = readHeights(view.container);

    expect(save).toHaveBeenCalledTimes(1);
    expect(after[BASE]!, '无接管 ⇒ 保留本地拖拽结果').toBe(before[BASE]! + 20);
    expect(after['1h']!).toBe(before['1h']! - 20);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(AVAILABLE);
  });
});
