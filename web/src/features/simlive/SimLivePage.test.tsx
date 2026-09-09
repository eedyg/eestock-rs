import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@/api/client';
import type { SimStateDto } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { SimLivePage } from './SimLivePage';

function renderPage(api: ApiClient) {
  return render(<SimLivePage api={api} />);
}

describe('SimLivePage（页面⑨模拟实盘：Tab + 会话控制 + 持仓 + 策略/评分 + 订单 + 历史回看）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = stubApi();
    window.location.hash = '';
  });

  it('骨架区域齐备：session-control / position-table / strategy-panel / stock-scoring / order-trade-list（默认当前会话）', async () => {
    const { container } = renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-equity')).toBeInTheDocument());
    for (const r of ['sim-live', 'session-control', 'position-table', 'strategy-panel', 'stock-scoring', 'order-trade-list']) {
      expect(container.querySelector(`[data-region="${r}"]`)).not.toBeNull();
    }
  });

  it('当前会话渲染：状态/账户 KPI + 持仓 + 3 策略评分 + 股票评分表（聚合+独立分+信号）', async () => {
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-equity')).toBeInTheDocument());
    expect(screen.getByTestId('sim-session-status').textContent).toContain('运行中');
    // 持仓
    expect(screen.getByTestId('sim-position-table')).toBeInTheDocument();
    expect(screen.getAllByTestId('sim-position-code').map((e) => e.textContent)).toEqual(['518880', '159577']);
    // 3 策略
    expect(screen.getByTestId('sim-strategy-panel')).toBeInTheDocument();
    expect(screen.getByTestId('sim-strategy-strongest-dual_ma')).toBeInTheDocument();
    // 股票评分：聚合 + 独立分 + 信号
    expect(screen.getByTestId('sim-score-aggregate-518880').textContent).toBe('72');
    expect(screen.getByTestId('sim-score-ma-518880').textContent).toBe('86');
    expect(screen.getByTestId('sim-score-macd-518880').textContent).toBe('12');
    expect(screen.getByTestId('sim-score-signal-518880').textContent).toBe('buy');
    // 订单
    expect(screen.getByTestId('sim-order-list')).toBeInTheDocument();
  });

  it('委托/成交时刻按 CST 显示（09-08 14:54:17 含日期+时分秒，非浏览器时区）', async () => {
    const ts = Date.UTC(2025, 8, 8, 6, 54, 17) / 1000; // 2025-09-08T06:54:17Z
    const api = stubApi({
      getSimOrders: vi.fn().mockResolvedValue({
        session_id: 's_cst',
        orders: [
          { id: 'o_cst', code: '518880', side: 'buy', qty: 10_000, limit_price: null,
            status: 'filled', filled_price: 9.151, filled_qty: 10_000, fee: 22.88, ts, source: 'strategy' },
        ],
      }),
    });
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-order-list')).toBeInTheDocument());
    // 完整「日期+时分秒」CST 展示（14:54:17 而非仅 14:54），且与浏览器时区无关（固定 +8）。
    expect(screen.getByText('09-08 14:54:17')).toBeInTheDocument();
    // 时段列头部「时刻」存在，值为含秒的完整格式。
    const orderRow = screen.getByText('09-08 14:54:17').closest('tr')!;
    expect(orderRow.querySelector('td')!.textContent).toBe('09-08 14:54:17');
  });

  it('Tab 切换：历史回顾展示会话列表+回测对比（不影响当前会话）', async () => {
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-equity')).toBeInTheDocument());
    // 默认当前会话，无历史。
    expect(screen.queryByTestId('sim-history')).toBeNull();
    await userEvent.click(screen.getByText('历史回顾'));
    await waitFor(() => expect(screen.getByTestId('sim-history')).toBeInTheDocument());
    // 历史会话列表
    expect(screen.getByTestId('sim-history-table')).toBeInTheDocument();
    expect(screen.getByText(/s_old11/)).toBeInTheDocument();
  });

  it('统一交易开关切换 → 调 /trading', async () => {
    const api = stubApi();
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-trading-toggle')).toBeInTheDocument());
    const toggle = screen.getByTestId('sim-trading-toggle') as HTMLInputElement;
    await userEvent.click(toggle);
    await waitFor(() => expect(api.toggleSimTrading).toHaveBeenCalledWith({ enabled: false }));
  });

  it('MCP 停用按钮 → 调 /mcp-toggle', async () => {
    const api = stubApi();
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-mcp-toggle')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('sim-mcp-toggle'));
    await waitFor(() => expect(api.toggleSimMcp).toHaveBeenCalledWith({ enabled: false }));
  });

  it('停止会话按钮 → 调 stopSimSession（当前会话）', async () => {
    const api = stubApi();
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-stop-button')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('sim-stop-button'));
    await waitFor(() => expect(api.stopSimSession).toHaveBeenCalledWith({ session_id: undefined }));
  });

  it('未运行会话时可开始会话（先选标的/策略）→ 调 startSimSession', async () => {
    const idle = stubApi();
    vi.spyOn(idle, 'getSimState').mockResolvedValue({
      active: false, session: null, account: null, positions: [], pnl: null,
      trading_enabled: false, mcp_enabled: true,
    });
    renderPage(idle);
    await waitFor(() => expect(screen.getByTestId('sim-start-button')).toBeEnabled());
    await userEvent.click(screen.getByTestId('sim-config-stock-518880'));
    await userEvent.click(screen.getByTestId('sim-config-strategy-st_mock_dual_ma'));
    await userEvent.click(screen.getByTestId('sim-start-button'));
    await waitFor(() => expect(idle.startSimSession).toHaveBeenCalled());
  });

  it('未运行时可配置标的/策略并开始 → startSimSession body 含 stock_set/strategy_set', async () => {
    const idle = stubApi();
    vi.spyOn(idle, 'getSimState').mockResolvedValue({
      active: false, session: null, account: null, positions: [], pnl: null,
      trading_enabled: false, mcp_enabled: true,
    });
    renderPage(idle);
    await waitFor(() => expect(screen.getByTestId('sim-start-button')).toBeEnabled());
    await userEvent.click(screen.getByTestId('sim-config-stock-518880'));
    await userEvent.click(screen.getByTestId('sim-config-strategy-st_mock_dual_ma'));
    await userEvent.click(screen.getByTestId('sim-start-button'));
    await waitFor(() => expect(idle.startSimSession).toHaveBeenCalled());
    expect(idle.startSimSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '手动会话',
        period: 'M1',
        stock_set: ['518880'],
        strategy_set: ['st_mock_dual_ma'],
      }),
    );
  });

  it('选中策略渲染单策略卡（参数/schema/标的子集/权重）→ start body 含 strategies', async () => {
    const idle = stubApi();
    vi.spyOn(idle, 'getSimState').mockResolvedValue({
      active: false, session: null, account: null, positions: [], pnl: null,
      trading_enabled: false, mcp_enabled: true,
    });
    renderPage(idle);
    await waitFor(() => expect(screen.getByTestId('sim-start-button')).toBeEnabled());
    await userEvent.click(screen.getByTestId('sim-config-stock-518880'));
    await userEvent.click(screen.getByTestId('sim-config-strategy-st_mock_dual_ma'));
    // 单策略卡 + schema 参数编辑（fast/slow/position_pct）+ 标的子集 + 权重。
    expect(screen.getByTestId('sim-strategy-card-st_mock_dual_ma')).toBeInTheDocument();
    expect(screen.getByTestId('sim-strategy-st_mock_dual_ma-param-fast')).toBeInTheDocument();
    expect(screen.getByTestId('sim-strategy-st_mock_dual_ma-param-slow')).toBeInTheDocument();
    expect(screen.getByTestId('sim-strategy-st_mock_dual_ma-stock-518880')).toBeInTheDocument();
    expect(screen.getByTestId('sim-strategy-st_mock_dual_ma-weight')).toBeInTheDocument();
    // 改参数（fast=3）、策略权重=2、每标的权重=3。
    await userEvent.clear(screen.getByTestId('sim-strategy-st_mock_dual_ma-param-fast'));
    await userEvent.type(screen.getByTestId('sim-strategy-st_mock_dual_ma-param-fast'), '3');
    await userEvent.clear(screen.getByTestId('sim-strategy-st_mock_dual_ma-weight'));
    await userEvent.type(screen.getByTestId('sim-strategy-st_mock_dual_ma-weight'), '2');
    await userEvent.clear(screen.getByTestId('sim-strategy-st_mock_dual_ma-stockweight-518880'));
    await userEvent.type(screen.getByTestId('sim-strategy-st_mock_dual_ma-stockweight-518880'), '3');
    await userEvent.click(screen.getByTestId('sim-start-button'));
    await waitFor(() => expect(idle.startSimSession).toHaveBeenCalled());
    expect(idle.startSimSession).toHaveBeenCalledWith(
      expect.objectContaining({
        strategies: [
          expect.objectContaining({
            strategy_id: 'st_mock_dual_ma',
            params: expect.objectContaining({ fast: 3 }),
            stocks: ['518880'],
            weight: 2,
            stock_weights: expect.objectContaining({ '518880': 3 }),
          }),
        ],
      }),
    );
  });

  it('会话配置面板展示标的/策略 chips', async () => {
    const idle = stubApi();
    vi.spyOn(idle, 'getSimState').mockResolvedValue({
      active: false, session: null, account: null, positions: [], pnl: null,
      trading_enabled: false, mcp_enabled: true,
    });
    renderPage(idle);
    await waitFor(() => expect(screen.getByTestId('sim-config-stock-518880')).toBeInTheDocument());
    expect(screen.getByTestId('sim-config-stock-513310')).toBeInTheDocument();
    // P4a：策略 chips 数据源 = Registry catalog（mock 播种 st_mock_dual_ma 一款 strategy kind）。
    expect(screen.getByTestId('sim-config-strategy-st_mock_dual_ma')).toBeInTheDocument();
    expect(screen.queryByTestId('sim-config-strategy-macd')).toBeNull();
  });

  it('未选择标的/策略开始 → 提示且不调 startSimSession', async () => {
    const idle = stubApi();
    vi.spyOn(idle, 'getSimState').mockResolvedValue({
      active: false, session: null, account: null, positions: [], pnl: null,
      trading_enabled: false, mcp_enabled: true,
    });
    renderPage(idle);
    await waitFor(() => expect(screen.getByTestId('sim-start-button')).toBeEnabled());
    await userEvent.click(screen.getByTestId('sim-start-button'));
    expect(screen.getByTestId('sim-config-error')).toBeInTheDocument();
    expect(idle.startSimSession).not.toHaveBeenCalled();
  });

  it('开始会话后 策略面板/评分区采用所选标的/策略（mock 派生）', async () => {
    const api = stubApi();
    await api.stopSimSession({}); // 先停掉种子会话 → 未运行态
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-start-button')).toBeEnabled());
    await userEvent.click(screen.getByTestId('sim-config-stock-161226'));
    await userEvent.click(screen.getByTestId('sim-config-strategy-st_mock_dual_ma'));
    await userEvent.click(screen.getByTestId('sim-start-button'));
    await waitFor(() => expect(screen.getByTestId('sim-strategy-panel')).toBeInTheDocument());
    // 所选标的出现在评分区
    expect(screen.getByTestId('sim-score-code-161226')).toBeInTheDocument();
    // 所选策略出现在策略面板（st_mock_dual_ma）
    expect(screen.getByTestId('sim-strategy-panel').textContent).toContain('st_mock_dual_ma');
  });

  it('历史会话「回测一下」→ 调 runSimBacktestCompare', async () => {
    const api = stubApi();
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-equity')).toBeInTheDocument());
    await userEvent.click(screen.getByText('历史回顾'));
    await waitFor(() => expect(screen.getByTestId('sim-compare-s_old11')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('sim-compare-s_old11'));
    await waitFor(() => expect(api.runSimBacktestCompare).toHaveBeenCalledWith('s_old11'));
  });

  it('Tab 高亮类(.tab-on)存在且 active 态切换', async () => {
    const { container } = renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-equity')).toBeInTheDocument());
    const cur = () => container.querySelector('[data-tab="current"]')!;
    const hist = () => container.querySelector('[data-tab="history"]')!;
    // 默认「当前会话」选中；历史 Tab 无高亮。
    expect(cur().className).toContain('tab-on');
    expect(hist().className).not.toContain('tab-on');
    await userEvent.click(hist());
    await waitFor(() => expect(screen.getByTestId('sim-history')).toBeInTheDocument());
    // 切到「历史回顾」后高亮互转。
    expect(hist().className).toContain('tab-on');
    expect(cur().className).not.toContain('tab-on');
  });

  it('region 卡片类(.sim-card)存在且相邻有 margin(mb-5)', async () => {
    const { container } = renderPage(api);
    await waitFor(() => expect(screen.getByTestId('sim-equity')).toBeInTheDocument());
    const check = (r: string) => {
      const el = container.querySelector(`[data-region="${r}"]`);
      expect(el).not.toBeNull();
      expect(el!.className).toContain('sim-card');
      // 独立卡片 + 两两间距（margin-bottom 16-20px）。
      expect(el!.className).toContain('mb-5');
    };
    ['session-control', 'position-table', 'strategy-panel', 'stock-scoring', 'order-trade-list'].forEach(check);
    await userEvent.click(container.querySelector('[data-tab="history"]')!);
    await waitFor(() => expect(screen.getByTestId('sim-history')).toBeInTheDocument());
    check('session-history');
  });

  it('#history 深链 → 历史 Tab 初始激活', async () => {
    window.location.hash = '#history';
    try {
      const { container } = renderPage(api);
      await waitFor(() => expect(screen.getByTestId('sim-history')).toBeInTheDocument());
      expect(container.querySelector('[data-tab="history"]')!.className).toContain('tab-on');
      expect(container.querySelector('[data-tab="current"]')!.className).not.toContain('tab-on');
    } finally {
      window.location.hash = '';
    }
  });

  it('轮询刷新（5s）内容保持原位：不闪退骨架/未运行态（后台静默刷新，不整页刷新/不滚回顶部）', async () => {
    const running = await api.getSimState(); // 真实 mock 运行态快照（active=true、session running）
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      renderPage(api);
      await waitFor(() => expect(screen.getByTestId('sim-equity')).toBeInTheDocument());
      expect(screen.getByTestId('sim-session-status').textContent).toContain('运行中');
      // 记录当前 DOM 节点（若刷新触发重挂/塌缩，节点会被移除/替换为骨架/未运行态）。
      const statusEl = screen.getByTestId('sim-session-status');
      const posTableEl = screen.getByTestId('sim-position-table');
      const strategyEl = screen.getByTestId('sim-strategy-panel');

      // 下一次轮询 getSimState 挂起 → 观察拉取中的中间态。
      let resolve!: (d: SimStateDto) => void;
      const pending = new Promise<SimStateDto>((r) => { resolve = r; });
      vi.spyOn(api, 'getSimState').mockReturnValueOnce(pending);

      // 推进 5s 触发 setInterval 轮询 store.refreshCurrent()。
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      // 拉取中间态：运行中内容仍在（未闪退到 EMPTY_STATE/未运行/骨架），且未重挂。
      expect(screen.getByTestId('sim-session-status')).toBe(statusEl);
      expect(screen.getByTestId('sim-session-status').textContent).toContain('运行中');
      expect(screen.getByTestId('sim-position-table')).toBe(posTableEl);
      expect(screen.getByTestId('sim-strategy-panel')).toBe(strategyEl);
      expect(screen.getByTestId('sim-equity')).toBeInTheDocument();

      await act(async () => { resolve(running); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('sim-session-status').textContent).toContain('运行中');
    } finally {
      vi.useRealTimers();
    }
  });
});
