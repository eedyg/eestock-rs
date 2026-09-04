import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WsMessage } from '@/ws/WsClient';
import type { ApiClient } from '@/api/client';
import type { AlertEventItem, AlertRuleItem } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { AlertsPage } from './AlertsPage';

function fakeWs() {
  const handlers = new Map<string, Set<(m: WsMessage) => void>>();
  return {
    connect: vi.fn(),
    close: vi.fn(),
    onStatusChange: vi.fn(() => () => {}),
    subscribe: vi.fn((topic: string, h: (m: WsMessage) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => {
        handlers.get(topic)!.delete(h);
      };
    }),
    emit(topic: string, msg: WsMessage) {
      handlers.get(topic)?.forEach((h) => h(msg));
    },
  };
}

const EVENTS: AlertEventItem[] = [
  { id: 1, rule_id: 'collection_stall', level: 'critical', source: 'collector',
    message: '采集停摆：交易时段连续 3 分钟无任何成功事件', status: 'triggered', fire_count: 1,
    first_fired_at: '2026-09-07T02:18:00Z', last_fired_at: '2026-09-07T02:18:00Z',
    acked_at: null, resolved_at: null },
  { id: 2, rule_id: 'symbol_gap_rate', level: 'warning', source: '513310',
    message: '513310 当日缺口率 7.8%（>1%）', status: 'triggered', fire_count: 4,
    first_fired_at: '2026-09-07T02:05:00Z', last_fired_at: '2026-09-07T02:35:00Z',
    acked_at: null, resolved_at: null },
  { id: 3, rule_id: 'source_success_rate', level: 'info', source: 'tencent_qt',
    message: '腾讯qt 恢复，回到轮转序列', status: 'acked', fire_count: 1,
    first_fired_at: '2026-09-07T01:47:00Z', last_fired_at: '2026-09-07T01:47:00Z',
    acked_at: '2026-09-07T01:50:00Z', resolved_at: null },
];

const RULES: AlertRuleItem[] = [
  { id: 'source_success_rate', name: '源成功率低于阈值', level: 'warning', threshold: 0.95, duration_minutes: 10, silence_minutes: 10, enabled: true },
  { id: 'symbol_gap_rate', name: '标的当日缺口率超阈', level: 'warning', threshold: 1, duration_minutes: 0, silence_minutes: 30, enabled: true },
  { id: 'collection_stall', name: '采集停摆（交易时段无成功事件）', level: 'critical', threshold: 3, duration_minutes: 0, silence_minutes: 10, enabled: true },
  { id: 'tushare_daily_sync', name: 'tushare 日增量失败', level: 'warning', threshold: 0, duration_minutes: 0, silence_minutes: 60, enabled: false },
];

function apiWith(over: Partial<ApiClient> = {}): ApiClient {
  const events = EVENTS.map((e) => ({ ...e }));
  const rules = RULES.map((r) => ({ ...r }));
  return stubApi({
    getAlertEvents: vi.fn(async () => events.map((e) => ({ ...e }))),
    ackAlert: vi.fn(async (id: number) => {
      const e = events.find((x) => x.id === id)!;
      e.status = 'acked';
      e.acked_at = '2026-09-07T03:00:00Z';
      return { ...e };
    }),
    getAlertRules: vi.fn(async () => rules.map((r) => ({ ...r }))),
    patchAlertRule: vi.fn(async (id: string, patch) => {
      const r = rules.find((x) => x.id === id)!;
      Object.assign(r, patch);
      return { ...r };
    }),
    ...over,
  });
}

describe('AlertsPage（页面⑦，骨架 AlertsGrid + RegionPortal）', () => {
  it('渲染三区域：过滤器/告警列表/规则面板；未确认高亮+计数；已确认无确认按钮', async () => {
    render(<AlertsPage api={apiWith()} ws={fakeWs() as never} />);
    await waitFor(() => expect(screen.getByText('采集停摆：交易时段连续 3 分钟无任何成功事件')).toBeInTheDocument());
    // 列表行：级别 pill + 来源 + 计数
    expect(screen.getAllByText('critical').length).toBeGreaterThan(0);
    expect(screen.getByText('×4')).toBeInTheDocument();
    expect(screen.getAllByText('513310').length).toBeGreaterThan(0);
    // 未确认行有确认按钮（2 条 triggered）；已确认行显示确认时刻
    expect(screen.getAllByRole('button', { name: '确认' })).toHaveLength(2);
    expect(screen.getByText(/已确认/)).toBeInTheDocument();
    // 规则面板：4 条内置规则 + Wave 4 预留置灰
    expect(screen.getByText('源成功率低于阈值')).toBeInTheDocument();
    expect(screen.getByText('采集停摆（交易时段无成功事件）')).toBeInTheDocument();
    expect(screen.getByText(/Wave 4 预留/)).toBeInTheDocument();
    // 过滤器
    expect(screen.getByLabelText('级别')).toBeInTheDocument();
    expect(screen.getByLabelText('时间范围')).toBeInTheDocument();
    expect(screen.getByLabelText('来源')).toBeInTheDocument();
  });

  it('确认操作：点击确认 → API 调用 → 行状态翻转已确认', async () => {
    const api = apiWith();
    const user = userEvent.setup();
    render(<AlertsPage api={api} ws={fakeWs() as never} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '确认' })).toHaveLength(2));
    await user.click(screen.getAllByRole('button', { name: '确认' })[0]!);
    await waitFor(() => expect(api.ackAlert).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.getAllByRole('button', { name: '确认' })).toHaveLength(1));
    expect(screen.getAllByText(/已确认/)).toHaveLength(2);
  });

  it('过滤变更即重查：级别下拉变更携带 level 参数', async () => {
    const api = apiWith();
    const user = userEvent.setup();
    render(<AlertsPage api={api} ws={fakeWs() as never} />);
    await waitFor(() => expect(screen.getByText('513310 当日缺口率 7.8%（>1%）')).toBeInTheDocument());
    vi.mocked(api.getAlertEvents).mockClear();
    await user.selectOptions(screen.getByLabelText('级别'), 'critical');
    await waitFor(() =>
      expect(api.getAlertEvents).toHaveBeenCalledWith(expect.objectContaining({ level: 'critical' })),
    );
  });

  it('空态与错误态+重试', async () => {
    const empty = apiWith({ getAlertEvents: vi.fn(async () => []) });
    const { unmount } = render(<AlertsPage api={empty} ws={fakeWs() as never} />);
    await waitFor(() => expect(screen.getByText('暂无告警')).toBeInTheDocument());
    unmount();

    const api = apiWith({ getAlertEvents: vi.fn(async () => { throw new Error('boom'); }) });
    render(<AlertsPage api={api} ws={fakeWs() as never} />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument());
    vi.mocked(api.getAlertEvents).mockImplementation(async () => EVENTS.map((e) => ({ ...e })));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('513310 当日缺口率 7.8%（>1%）')).toBeInTheDocument());
  });

  it('规则面板：开关切换与静默时长调整触发 PATCH', async () => {
    const api = apiWith();
    const user = userEvent.setup();
    render(<AlertsPage api={api} ws={fakeWs() as never} />);
    await waitFor(() => expect(screen.getByText('源成功率低于阈值')).toBeInTheDocument());
    // 开关：tushare 日增量失败（当前停用）→ 启用
    await user.click(screen.getByRole('button', { name: 'tushare 日增量失败开关' }));
    await waitFor(() =>
      expect(api.patchAlertRule).toHaveBeenCalledWith('tushare_daily_sync', { enabled: true }),
    );
    // 静默时长编辑（symbol_gap_rate 30 → 45）
    const silence = screen.getByLabelText('标的当日缺口率超阈静默时长');
    await user.clear(silence);
    await user.type(silence, '45');
    await user.tab();
    await waitFor(() =>
      expect(api.patchAlertRule).toHaveBeenCalledWith('symbol_gap_rate', { silence_minutes: 45 }),
    );
  });

  it('WS 实时推送：新告警事件即时入列表顶部', async () => {
    const ws = fakeWs();
    render(<AlertsPage api={apiWith()} ws={ws as never} />);
    await waitFor(() => expect(screen.getByText('513310 当日缺口率 7.8%（>1%）')).toBeInTheDocument());
    ws.emit('alert', {
      type: 'alert', id: 9001, rule_id: 'collection_stall', level: 'critical',
      source: 'collector', message: '采集停摆：WS 新事件', status: 'triggered', fire_count: 1,
      first_fired_at: '2026-09-07T03:00:00Z', last_fired_at: '2026-09-07T03:00:00Z',
      acked_at: null, resolved_at: null,
    });
    await waitFor(() => expect(screen.getByText('采集停摆：WS 新事件')).toBeInTheDocument());
  });
});
