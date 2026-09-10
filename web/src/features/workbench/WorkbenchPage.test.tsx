import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { WorkbenchPage } from './WorkbenchPage';
import type { WorkbenchRunView } from '@/api/types';

/** 批量历史行（回归：真实环境 100+ 条历史把配置区挤出可视区的无界增长 bug）。 */
function mkBulkRuns(n: number): WorkbenchRunView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `sr_h_${i}`,
    name: `历史运行 ${i}`,
    symbol: '518880',
    period: 'D1',
    from_ts: '2026-01-01T00:00:00Z',
    to_ts: '2026-04-01T00:00:00Z',
    config: {
      slots: [],
      buy_threshold: 60,
      sell_threshold: 40,
      policy: { LumpSum: { position_pct: 1 } },
      stop: null,
      initial_capital: 100_000,
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    },
    status: 'canceled',
    progress: 0,
    error: null,
    created_at: new Date(Date.UTC(2026, 8, 9, 6, 0, 0) - i * 60_000).toISOString(),
    started_at: null,
    finished_at: null,
  }));
}

/** 覆写 listWorkbenchRuns 为 200 条后端数据（limit/offset 契约与后端/契约 mock 一致）。 */
function stubBulkRuns(api: ApiClient, n = 200) {
  const runs = mkBulkRuns(n);
  (api.listWorkbenchRuns as ReturnType<typeof vi.fn>).mockImplementation(
    (f?: { status?: string; limit?: number; offset?: number }) => {
      const offset = f?.offset ?? 0;
      const limit = f?.limit ?? 100;
      return Promise.resolve(runs.slice(offset, offset + limit));
    },
  );
  return runs;
}

// jsdom 无 canvas：klinecharts 整体打桩（与 BacktestPage.test 同模式）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setBarSpace: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
  registerOverlay: vi.fn(),
}));

function fakeWs() {
  const handlers = new Map<string, Set<(msg: unknown) => void>>();
  return {
    handlers,
    subscribe: vi.fn((topic: string, h: (msg: unknown) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    emit(topic: string, msg: unknown) {
      handlers.get(topic)?.forEach((h) => h(msg));
    },
  } as unknown as WsClient & { emit: (t: string, m: unknown) => void };
}

function renderPage(api: ApiClient, ws: ReturnType<typeof fakeWs>) {
  return render(
    <MemoryRouter>
      <WorkbenchPage api={api} ws={ws} />
    </MemoryRouter>,
  );
}

describe('WorkbenchPage（页面⑪ 回测工作台：配置区 + 运行管理 + 结果视图 + compare）', () => {
  let ws: ReturnType<typeof fakeWs>;
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    ws = fakeWs();
    api = stubApi();
  });

  it('页面骨架：配置区 + 运行历史（种子四态）+ 结果占位；订阅 strategy_run', async () => {
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-config')).toBeInTheDocument());
    expect(screen.getByTestId('wb-run-list')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed1')).toBeInTheDocument());
    expect(screen.getByTestId('wb-run-row-sr_mock_seed4')).toHaveTextContent('失败');
    expect(screen.getByTestId('wb-run-row-sr_mock_seed4')).toHaveTextContent('mock 引擎错误');
    expect(screen.getByTestId('wb-result-empty')).toBeInTheDocument();
    expect(ws.subscribe).toHaveBeenCalledWith('strategy_run', expect.any(Function));
  });

  it('提交 → submitWorkbenchRun 收到钉住前请求（slots/阈值/policy/fee），新 run 选中并渲染结果', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-add-strategy')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(api.submitWorkbenchRun).toHaveBeenCalled());
    expect(api.submitWorkbenchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: '518880',
        period: 'D1',
        slots: [{ version_id: 'sv_mock_dual_v1', params: { fast: 5, slow: 20 }, weight: 1 }],
        buy_threshold: 60,
        sell_threshold: 40,
        policy: { LumpSum: { position_pct: 1 } },
      }),
    );
    // 新 run（mock 同步终态）选中 → 结果区渲染
    await waitFor(() => expect(screen.getByTestId('wb-aggregate-chart')).toBeInTheDocument());
  });

  it('提交 400 → 友好错误展示（wb-submit-error）', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-add-strategy')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    // 触发后端 400：symbol 选不到未注册项——改为阈值倒挂走本地校验；此处直接 mock 拒绝
    (api.submitWorkbenchRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('HTTP 400: 版本非 published'), { status: 400, name: 'ApiError' }),
    );
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(screen.getByTestId('wb-submit-error')).toHaveTextContent('HTTP 400'));
  });

  it('WS strategy_run_progress 推进运行中 run 的进度条（0..1 → %）', async () => {
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed3')).toBeInTheDocument());
    expect(screen.getByTestId('wb-run-row-sr_mock_seed3')).toHaveTextContent('42%');
    ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 0.87, bar_ts: null });
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed3')).toHaveTextContent('87%'));
  });

  it('取消按钮：running run 取消 → 行状态翻 canceled；终态无取消按钮', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed3')).toBeInTheDocument());
    await user.click(screen.getByTestId('wb-cancel-sr_mock_seed3'));
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed3')).toHaveTextContent('已取消'));
    expect(screen.queryByTestId('wb-cancel-sr_mock_seed1')).toBeNull(); // succeeded 无取消入口
  });

  it('选中已完成 run → 结果视图渲染（K线/总分/各策略/净值/Tab）', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed2')).toBeInTheDocument());
    await user.click(screen.getByTestId('wb-run-select-sr_mock_seed2'));
    await waitFor(() => expect(screen.getByTestId('wb-kline-chart')).toBeInTheDocument());
    expect(screen.getByTestId('wb-aggregate-chart')).toBeInTheDocument();
    expect(screen.getByTestId('wb-slot-chart')).toBeInTheDocument();
    expect(screen.getByTestId('wb-equity-chart')).toBeInTheDocument();
    // 双 slot 种子 → 图例 2 条默认全开（默认前 3）
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('legend-slot-1') as HTMLInputElement).checked).toBe(true);
  });

  it('compare：勾选 2 个已完成 run → 净值叠加 + 绩效并排；上限 4', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed1')).toBeInTheDocument());
    await user.click(screen.getByTestId('wb-compare-sr_mock_seed1'));
    expect(screen.queryByTestId('wb-compare-panel')).toBeNull(); // 1 个不进 compare
    await user.click(screen.getByTestId('wb-compare-sr_mock_seed2'));
    await waitFor(() => expect(screen.getByTestId('wb-compare-panel')).toBeInTheDocument());
    expect(api.compareWorkbenchRuns).toHaveBeenCalledWith(['sr_mock_seed1', 'sr_mock_seed2']);
    await waitFor(() => expect(screen.getByTestId('wb-compare-chart')).toBeInTheDocument());
    expect(screen.getByTestId('wb-compare-table')).toHaveTextContent('net_profit');
    // 退出回单次视图
    await user.click(screen.getByTestId('wb-compare-exit'));
    expect(screen.queryByTestId('wb-compare-panel')).toBeNull();
  });

  it('预设：保存 → 下拉出现；选中即回填；删除 → 消失', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-add-strategy')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.clear(screen.getByTestId('wb-preset-name'));
    await user.type(screen.getByTestId('wb-preset-name'), '我的组合');
    await user.click(screen.getByTestId('wb-preset-save'));
    await waitFor(() => expect(screen.getByTestId('wb-preset-msg')).toHaveTextContent('已保存'));
    const sel = screen.getByTestId('wb-preset-select') as HTMLSelectElement;
    await waitFor(() => expect([...sel.options].some((o) => o.textContent === '我的组合')).toBe(true));
    // 移除 slot 后选中预设 → 回填
    await user.click(screen.getByTestId('slot-remove-sv_mock_dual_v1'));
    expect(screen.queryByTestId('slot-card-sv_mock_dual_v1')).toBeNull();
    await user.selectOptions(sel, [...sel.options].find((o) => o.textContent === '我的组合')!.value);
    await waitFor(() => expect(screen.getByTestId('slot-card-sv_mock_dual_v1')).toBeInTheDocument());
    // 删除
    await user.click(screen.getByTestId('wb-preset-delete'));
    await waitFor(() => expect(screen.getByTestId('wb-preset-msg')).toHaveTextContent('已删除'));
    expect([...sel.options].some((o) => o.textContent === '我的组合')).toBe(false);
  });

  it('切换 run：图例勾选态不跨 run 泄漏（key 重挂载 → 默认前 3 重新生效）', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    // seed2 双 slot 默认全开 → 取消 slot-0
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed2')).toBeInTheDocument());
    await user.click(screen.getByTestId('wb-run-select-sr_mock_seed2'));
    await waitFor(() => expect(screen.getByTestId('wb-slot-chart')).toBeInTheDocument());
    await user.click(screen.getByTestId('legend-slot-0'));
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(false);
    // 切到 seed1（单 slot）→ 图例重新按默认生效（不受上个 run 勾选态影响）
    await user.click(screen.getByTestId('wb-run-select-sr_mock_seed1'));
    await waitFor(() => expect(screen.getByTestId('wb-slot-chart')).toBeInTheDocument());
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    // 切回 seed2 → 勾选态不泄漏，默认全开
    await user.click(screen.getByTestId('wb-run-select-sr_mock_seed2'));
    await waitFor(() => expect(screen.getByTestId('legend-slot-1')).toBeInTheDocument());
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('legend-slot-1') as HTMLInputElement).checked).toBe(true);
  });

  it('结果头部进度叠加 progressMap：running run 选中后 WS 推进实时更新（与 RunList 同模式）', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_mock_seed3')).toBeInTheDocument());
    await user.click(screen.getByTestId('wb-run-select-sr_mock_seed3'));
    await waitFor(() => expect(screen.getByTestId('wb-result')).toBeInTheDocument());
    expect(screen.getByTestId('wb-run-progress')).toHaveTextContent('42%');
    ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 0.87, bar_ts: null });
    await waitFor(() => expect(screen.getByTestId('wb-run-progress')).toHaveTextContent('87%'));
  });

  it('预设就地更新：应用预设 → 改参 → 保存走 PUT（updateWorkbenchPreset），409 不再误发', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-add-strategy')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.type(screen.getByTestId('wb-preset-name'), '组合X');
    await user.click(screen.getByTestId('wb-preset-save'));
    await waitFor(() => expect(screen.getByTestId('wb-preset-msg')).toHaveTextContent('已保存'));
    expect(api.createWorkbenchPreset).toHaveBeenCalledTimes(1);
    // 应用预设（presetSel 落定）
    const sel = screen.getByTestId('wb-preset-select') as HTMLSelectElement;
    await user.selectOptions(sel, [...sel.options].find((o) => o.textContent === '组合X')!.value);
    await waitFor(() => expect(screen.getByTestId('slot-card-sv_mock_dual_v1')).toBeInTheDocument());
    expect(screen.queryByTestId('wb-preset-dirty')).toBeNull(); // 未改 → 无脏标记
    // 改阈值 → 脏标记出现
    await user.clear(screen.getByTestId('wb-buy-threshold'));
    await user.type(screen.getByTestId('wb-buy-threshold'), '70');
    await waitFor(() => expect(screen.getByTestId('wb-preset-dirty')).toBeInTheDocument());
    // 保存 → PUT 就地更新（同名 config 更新，不再 POST 撞 409）
    await user.click(screen.getByTestId('wb-preset-save'));
    await waitFor(() => expect(screen.getByTestId('wb-preset-msg')).toHaveTextContent('已更新'));
    expect(api.updateWorkbenchPreset).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: '组合X', config: expect.objectContaining({ buy_threshold: 70 }) }),
    );
    expect(api.createWorkbenchPreset).toHaveBeenCalledTimes(1); // 未再发 POST
    expect(screen.getByTestId('wb-preset-msg')).not.toHaveTextContent('409');
    // 更新后脏标记消除
    expect(screen.queryByTestId('wb-preset-dirty')).toBeNull();
  });
});

describe('WorkbenchPage 布局（运行历史无界增长覆盖配置区 回归）', () => {
  let ws: ReturnType<typeof fakeWs>;
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    ws = fakeWs();
    api = stubApi();
  });

  it('200 条历史：首屏仅渲染一页（50 条 DOM 有界）+ 分页控件存在 + 配置区始终可见', async () => {
    stubBulkRuns(api, 200);
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_h_0')).toBeInTheDocument());
    // DOM 有界：分页首屏只渲染一页，而非一次性渲染全部 200 条
    expect(screen.getAllByTestId(/^wb-run-row-/).length).toBe(50);
    expect(screen.getAllByTestId(/^wb-run-row-/).length).toBeLessThan(200);
    // 分页控件（hasMore：200 > 50）
    expect(screen.getByTestId('wb-runs-more')).toBeInTheDocument();
    // 左列：整列不再滚动（历史不再把配置区顶走），高度有界
    const left = screen.getByTestId('wb-left-col');
    expect(left.className).not.toContain('overflow-y-auto');
    expect(left.className).toContain('min-h-0');
    // 历史包装：max-h 有界 + 内部滚动容器
    expect(screen.getByTestId('wb-run-history').className).toMatch(/max-h-/);
    expect(screen.getByTestId('wb-run-list-scroll').className).toContain('overflow-y-auto');
    // 配置区完整可见可操作（含提交按钮）
    expect(screen.getByTestId('wb-config')).toBeInTheDocument();
    expect(screen.getByTestId('wb-submit')).toBeInTheDocument();
  });

  it('「加载更多」以 offset 追加第二页（50→100 条），配置区布局不受影响', async () => {
    const user = userEvent.setup();
    stubBulkRuns(api, 200);
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_h_0')).toBeInTheDocument());
    await user.click(screen.getByTestId('wb-runs-more'));
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_h_99')).toBeInTheDocument());
    expect(screen.getAllByTestId(/^wb-run-row-/).length).toBe(100);
    expect(api.listWorkbenchRuns).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }));
    // 历史仍在有界滚动容器内，配置区仍可见
    expect(screen.getByTestId('wb-run-list-scroll').contains(screen.getByTestId('wb-run-row-sr_h_99'))).toBe(true);
    expect(screen.getByTestId('wb-config')).toBeInTheDocument();
  });

  it('选中历史项后左列布局稳定：配置区不被结果视图内容高度顶走', async () => {
    const user = userEvent.setup();
    stubBulkRuns(api, 200);
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('wb-run-row-sr_h_10')).toBeInTheDocument());
    const before = screen.getByTestId('wb-left-col').className;
    await user.click(screen.getByTestId('wb-run-select-sr_h_10'));
    await waitFor(() => expect(screen.getByTestId('wb-result-pending')).toBeInTheDocument());
    // 左列类名（布局结构）不因选中/结果区内容变化而改变，配置区仍在
    expect(screen.getByTestId('wb-left-col').className).toBe(before);
    expect(screen.getByTestId('wb-config')).toBeInTheDocument();
    expect(screen.getByTestId('wb-run-history')).toBeInTheDocument();
  });
});
