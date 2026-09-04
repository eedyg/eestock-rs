import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { SourcesHealth } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { SourcesPage } from './SourcesPage';

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

/** 默认 mock 健康（5 源：ifzq 健康 / sina_jsonp 降级 / qt 熔断 / hq、push2delay 健康） */
function renderPage(api: ApiClient, ws: ReturnType<typeof fakeWs>) {
  return render(
    <MemoryRouter>
      <SourcesPage api={api} ws={ws} />
    </MemoryRouter>,
  );
}

describe('SourcesPage（页面②数据源诊断：骨架锚点 + 卡片墙 + 详情 + 三态）', () => {
  let ws: ReturnType<typeof fakeWs>;
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    ws = fakeWs();
    api = stubApi();
  });

  it('骨架区域齐备：summary-bar / source-cards / gap-cards / alert-preview（detail 默认折叠）', async () => {
    const { container } = renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('腾讯ifzq')).toBeInTheDocument());
    for (const r of ['summary-bar', 'source-cards', 'gap-cards', 'alert-preview']) {
      expect(container.querySelector(`[data-region="${r}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-region="detail-panel"]')).toBeNull();
  });

  it('汇总条：1m 可用/总数（降级计可用）、快照池计数、系统灯', async () => {
    renderPage(api, ws);
    // mock：ifzq 健康 + sina_jsonp 降级 → 2/2；快照池 3/3（qt 熔断仍为快照池成员→ 2/3 健康）
    await waitFor(() => expect(screen.getByText('2/2')).toBeInTheDocument());
    expect(screen.getByText('2/3')).toBeInTheDocument();
    expect(screen.getByText(/系统正常/)).toBeInTheDocument();
  });

  it('源健康卡片：角色标签/成功率/P50/最近错误；熔断卡显示手动复位按钮', async () => {
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('腾讯qt')).toBeInTheDocument());
    expect(screen.getByText('熔断中')).toBeInTheDocument();
    expect(screen.getAllByText('1m全速')).toHaveLength(2); // ifzq + sina_jsonp
    expect(screen.getByText('99.2%')).toBeInTheDocument(); // ifzq 成功率（mock 100%→见 mock 定义）
    const resetBtn = screen.getByText('手动复位');
    expect(resetBtn).toBeInTheDocument();
    // 最近错误摘要（熔断卡）
    expect(screen.getByText(/连接重置|http/)).toBeInTheDocument();
  });

  it('点卡展开详情：事件流水 + 范围切换；再点折叠', async () => {
    const user = userEvent.setup();
    const { container } = renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('腾讯qt')).toBeInTheDocument());
    await user.click(screen.getByText('腾讯qt').closest('[data-source]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-region="detail-panel"]')).not.toBeNull(),
    );
    await waitFor(() => expect(screen.getByText(/事件流水/)).toBeInTheDocument());
    // 范围切换 1h/今日/3日
    await user.click(screen.getByRole('button', { name: '3日' }));
    await waitFor(() =>
      expect(api.getSourceMetrics).toHaveBeenCalledWith('tencent_qt', '3d'),
    );
    // 再点同一卡折叠
    await user.click(screen.getByText('腾讯qt').closest('[data-source]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-region="detail-panel"]')).toBeNull(),
    );
  });

  it('手动复位：调 POST reset 且不触发展开（stopPropagation）', async () => {
    const user = userEvent.setup();
    const { container } = renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('腾讯qt')).toBeInTheDocument());
    await user.click(screen.getByText('手动复位'));
    await waitFor(() => expect(api.resetSource).toHaveBeenCalledWith('tencent_qt'));
    expect(container.querySelector('[data-region="detail-panel"]')).toBeNull();
  });

  it('WS health 推送 → 卡片状态迁移实时刷新', async () => {
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('熔断中')).toBeInTheDocument());
    const health = (await api.getSourcesHealth()) as SourcesHealth;
    const recovered: SourcesHealth = {
      ...health,
      sources: health.sources.map((s) =>
        s.source === 'tencent_qt'
          ? { ...s, status: 'healthy' as const, circuit_state: 'closed' as const }
          : s,
      ),
    };
    (api.getSourcesHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce(recovered);
    ws.emit('source_health', { type: 'health', window_secs: 3600, sources: [] });
    await waitFor(() => expect(screen.queryByText('熔断中')).toBeNull());
  });

  it('缺口卡：>5% 黄、>20% 红；告警预览只读列表', async () => {
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('26.8%')).toBeInTheDocument());
    const crit = screen.getByText('26.8%').closest('[data-gap]')!;
    expect(crit.getAttribute('data-level')).toBe('crit');
    const warn = screen.getByText('7.8%').closest('[data-gap]')!;
    expect(warn.getAttribute('data-level')).toBe('warn');
    expect(screen.getByText(/腾讯qt 连续失败 3 次/)).toBeInTheDocument();
  });

  it('错误态：健康加载失败 → 错误条 + 重试恢复', async () => {
    (api.getSourcesHealth as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HTTP 500'));
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(screen.getByText('腾讯ifzq')).toBeInTheDocument());
  });

  it('空态：今日无缺口占位；暂无告警占位', async () => {
    api = stubApi({
      getGaps: vi.fn(async () => []),
      getAlerts: vi.fn(async () => []),
    });
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('今日无缺口')).toBeInTheDocument());
    expect(screen.getByText('暂无告警')).toBeInTheDocument();
  });

  it('Trace ID 点击复制', async () => {
    const user = userEvent.setup();
    // userEvent.setup 会装自己的 clipboard stub，须在其后覆写
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByText('腾讯qt')).toBeInTheDocument());
    await user.click(screen.getByText('腾讯qt').closest('[data-source]')!);
    await waitFor(() => expect(screen.getAllByText(/^trace:/)[0]).toBeInTheDocument());
    await user.click(screen.getAllByText(/^trace:/)[0]!);
    expect(writeText).toHaveBeenCalled();
  });
});
