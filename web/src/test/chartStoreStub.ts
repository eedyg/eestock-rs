import { vi, type Mock } from 'vitest';

/**
 * klinecharts 10.0.3 store 语义的**最小忠实模型**（仅测试基建，非生产代码）。
 *
 * 依据 `tester/report/165_ma_candle_pane_root_cause.md`（行号取自
 * `web/node_modules/klinecharts/dist/index.esm.js`，version=10.0.3）：
 *  - `createIndicator(value, isStack)`：`isStack` 省略/`false` ⇒ `StoreImp.addIndicator`
 *    先 `removeIndicator({ paneId })` **清空整个 pane** 再 push（`:14162-14166`）= **替换**语义；
 *    `true` ⇒ 纯追加（叠加）；
 *  - 无论“替换”还是“追加”，`createIndicator` 都返回一个**新的非空 id**（`:15292`）
 *    ⇒ **返回 id ≠ 指标留在图中**；
 *  - 全程**零告警**（`:15267` 的 `logWarn` 只在“指标未注册”时触发）。
 *
 * 存在的理由：jsdom 无 canvas，真身 klinecharts 跑不起来；而本坑是**引擎内部语义**，
 * 桩必须把「替换 / 追加 / 无论如何都返回 id」三条语义原样复刻，否则 T7（G2 门禁）的
 * 回归断言与反向证据都失去意义（见 `design/15-multi-period/03-test-plan.md` T7）。
 */

export interface StubIndicatorSpec {
  name: string;
  paneId?: string;
  calcParams?: unknown[];
}

export interface StubIndicator {
  id: string;
  name: string;
  paneId: string;
  calcParams?: unknown[];
}

export interface StubIndicatorFilter {
  id?: string;
  name?: string;
  paneId?: string;
}

type CreateIndicatorFn = (value: string | StubIndicatorSpec, isStack?: boolean) => string | null;
type RemoveIndicatorFn = (filter?: StubIndicatorFilter) => boolean;
type GetIndicatorsFn = (filter?: StubIndicatorFilter) => StubIndicator[];

export interface ChartStoreStub {
  createIndicator: Mock<CreateIndicatorFn>;
  removeIndicator: Mock<RemoveIndicatorFn>;
  getIndicators: Mock<GetIndicatorsFn>;
}

export function createChartStoreStub(): ChartStoreStub {
  const panes = new Map<string, StubIndicator[]>();
  let seq = 0;

  /** `StoreImp.getIndicatorsByFilter`（:14180-14196）：`id` 优先；否则按 `name`；未给则该维不筛。 */
  const match = (indicator: StubIndicator, filter: StubIndicatorFilter): boolean => {
    if (filter.id !== undefined) return indicator.id === filter.id;
    return filter.name === undefined || indicator.name === filter.name;
  };

  const createImpl: CreateIndicatorFn = (value, isStack) => {
    const spec = typeof value === 'string' ? { name: value } : value;
    const paneId = spec.paneId ?? 'indicator_pane_dynamic';
    const indicator: StubIndicator = {
      id: `${spec.name}_${++seq}`,
      name: spec.name,
      paneId,
      calcParams: spec.calcParams,
    };
    if (!(isStack ?? false)) {
      panes.set(paneId, []); // :14163-14164 —— 静默清空整个 pane（**这就是坑**）
    }
    const paneIndicators = panes.get(paneId) ?? [];
    paneIndicators.push(indicator); // :14166
    panes.set(paneId, paneIndicators);
    return indicator.id; // :15292 —— 即使发生了“替换”也照常返回 id
  };

  const removeImpl: RemoveIndicatorFn = (filter = {}) => {
    let removed = false;
    for (const [paneId, paneIndicators] of panes) {
      if (filter.paneId !== undefined && paneId !== filter.paneId) continue;
      const kept = paneIndicators.filter((indicator) => !match(indicator, filter));
      if (kept.length !== paneIndicators.length) {
        removed = true;
        panes.set(paneId, kept);
      }
    }
    return removed;
  };

  const getImpl: GetIndicatorsFn = (filter = {}) => {
    const out: StubIndicator[] = [];
    for (const [paneId, paneIndicators] of panes) {
      if (filter.paneId !== undefined && paneId !== filter.paneId) continue;
      out.push(...paneIndicators.filter((indicator) => match(indicator, filter)));
    }
    return out;
  };

  return {
    createIndicator: vi.fn(createImpl),
    removeIndicator: vi.fn(removeImpl),
    getIndicators: vi.fn(getImpl),
  };
}

// ---------------------------------------------------------------------------
// 既有集成测试用「最简 chart 桩」的 getIndicators 补桩（P0.1-D，测试基建）
// ---------------------------------------------------------------------------

/** `getIndicators` 的过滤条件（与 `StoreImp.getIndicatorsByFilter` 同口径）。 */
export interface IndicatorViewFilter {
  id?: string;
  name?: string;
  paneId?: string;
}

/** `getIndicators` 返回元素的最小形状（`name`/`paneId` 为被测代码会读的字段）。 */
export interface IndicatorView {
  id: string;
  name: string;
  paneId: string;
  calcParams?: unknown[];
}

/** 只需要「调用记录」的最小 Mock 形状（`vi.fn()` 即满足）。 */
interface CallRecordMock {
  mock: { calls: unknown[][]; invocationCallOrder: number[] };
}

const viewMatch = (indicator: IndicatorView, filter: IndicatorViewFilter): boolean => {
  if (filter.id !== undefined) return indicator.id === filter.id;
  if (filter.name !== undefined && indicator.name !== filter.name) return false;
  return filter.paneId === undefined || indicator.paneId === filter.paneId;
};

/**
 * 由 `createIndicator` / `removeIndicator` 的**调用记录**派生 `getIndicators` 结果。
 *
 * 为什么派生而不是维护独立状态：`vi.clearAllMocks()` 会清空调用记录 ⇒ 每个用例天然从「图里
 * 什么都没有」开始，不存在跨用例残留状态把失败**掩盖成绿**（本补桩的第一约束是「加桩不得掩盖失败」）。
 *
 * 语义忠实于 `StoreImp`（`node_modules/klinecharts/dist/index.esm.js:14162-14196`）：
 *  - `isStack` 为 `true` ⇒ 追加；`false`/省略 ⇒ **先清空同 pane**（替换语义，本坑本体）；
 *  - 过滤：`id` 优先；否则按 `name`（未给即不筛 name）+ `paneId`；
 *  - 返回元素含 `id` / `name` / `paneId`（+ 透传 `calcParams`）。
 *
 * 用途：`web/src` 既有集成测试的 chart 桩缺少 `getIndicators` 时，框架入口
 * `addOverlayIndicator`（`web/src/features/dashboard/overlayIndicator.ts`）的**非空断言**
 * 会以 `TypeError: chart.getIndicators is not a function` 全文件连坐（不是被测代码缺陷）。
 */
export function indicatorViewFromCalls(
  createIndicator: CallRecordMock,
  removeIndicator: CallRecordMock,
  filter: IndicatorViewFilter = {},
): IndicatorView[] {
  interface Event {
    order: number;
    kind: 'create' | 'remove';
    value: unknown;
    isStack?: boolean;
  }
  const events: Event[] = [];
  createIndicator.mock.calls.forEach((call, i) => {
    events.push({
      order: createIndicator.mock.invocationCallOrder[i] ?? i,
      kind: 'create',
      value: call[0],
      isStack: call[1] as boolean | undefined,
    });
  });
  removeIndicator.mock.calls.forEach((call, i) => {
    events.push({
      order: removeIndicator.mock.invocationCallOrder[i] ?? i,
      kind: 'remove',
      value: call[0],
    });
  });
  events.sort((a, b) => a.order - b.order);

  let seq = 0;
  let state: IndicatorView[] = [];
  for (const event of events) {
    if (event.kind === 'remove') {
      const f = (event.value ?? {}) as IndicatorViewFilter;
      state = state.filter((indicator) => !viewMatch(indicator, f));
      continue;
    }
    const raw = event.value as string | { name: string; paneId?: string; calcParams?: unknown[] };
    const spec = typeof raw === 'string' ? { name: raw } : raw;
    const paneId = spec.paneId ?? 'indicator_pane_dynamic';
    if (!(event.isStack ?? false)) {
      state = state.filter((indicator) => indicator.paneId !== paneId); // :14163-14164 替换语义
    }
    state = [
      ...state,
      { id: `${spec.name}_${++seq}`, name: spec.name, paneId, calcParams: spec.calcParams },
    ];
  }
  return state.filter((indicator) => viewMatch(indicator, filter));
}

/**
 * 给「最简 chart 桩」用的 `getIndicators` 实现工厂：`chartStub.createIndicator` /
 * `chartStub.removeIndicator` 必须是 `vi.fn()`（需 `.mock.calls` 与 `invocationCallOrder`）。
 */
export function bindGetIndicators(
  chartStub: { createIndicator: CallRecordMock; removeIndicator: CallRecordMock },
): (filter?: IndicatorViewFilter) => IndicatorView[] {
  return (filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {});
}
