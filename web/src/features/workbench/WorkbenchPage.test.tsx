import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { WorkbenchPage } from './WorkbenchPage';

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
