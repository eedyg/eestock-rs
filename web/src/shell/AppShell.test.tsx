import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';

// 后端健康行（07-app-plane §1.1 线格式）；last_event_ts 用测试时刻保证采集灯判定确定
function healthRow(source: string, status: 'healthy' | 'degraded' | 'circuit_open') {
  return {
    source,
    window_secs: 3600,
    attempts: 60,
    successes: 60,
    success_rate: 1,
    p50_ms: 180,
    p95_ms: 320,
    circuit_state: status === 'circuit_open' ? ('open' as const) : ('closed' as const),
    status,
    last_error: null,
    last_event_ts: new Date().toISOString(),
  };
}

function fakeApi(): ApiClient {
  return stubApi({
    getSourcesHealth: vi.fn(async () => ({
      window_secs: 3600,
      sources: [
        healthRow('tencent_ifzq', 'healthy'),
        healthRow('sina_jsonp', 'circuit_open'),
        healthRow('tencent_qt', 'healthy'),
      ],
    })),
  });
}

function fakeWs() {
  return {
    connect: vi.fn(),
    close: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    onStatusChange: vi.fn(() => () => {}),
  } as unknown as WsClient;
}

describe('AppShell（骨架：状态条+导航+页面出口）', () => {
  it('渲染顶部状态条、8 项导航与 Outlet 内容；健康数取 1m 角色源', async () => {
    const ws = fakeWs();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell api={fakeApi()} ws={ws} />}>
            <Route path="/" element={<div>页面内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText('页面内容')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());
    expect(screen.getByText('采集正常')).toBeInTheDocument();
    expect(ws.connect).toHaveBeenCalled();
    expect(ws.subscribe).toHaveBeenCalledWith('source_health', expect.any(Function));
  });
});
