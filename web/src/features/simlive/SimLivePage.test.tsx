import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@/api/client';
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

  it('未运行会话时可开始会话 → 调 startSimSession', async () => {
    const idle = stubApi();
    vi.spyOn(idle, 'getSimState').mockResolvedValue({
      active: false, session: null, account: null, positions: [], pnl: null,
      trading_enabled: false, mcp_enabled: true,
    });
    renderPage(idle);
    await waitFor(() => expect(screen.getByTestId('sim-start-button')).toBeEnabled());
    await userEvent.click(screen.getByTestId('sim-start-button'));
    await waitFor(() => expect(idle.startSimSession).toHaveBeenCalled());
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
});
