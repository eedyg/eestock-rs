import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';

function fakeApi(): ApiClient {
  return {
    getSymbols: vi.fn(async () => []),
    getKline: vi.fn(async () => []),
    getSourcesHealth: vi.fn(async () => ({
      collectorRunning: true,
      sources: [
        { id: 'tencent_ifzq', name: '腾讯ifzq', role: '1m' as const, status: 'healthy' as const },
        { id: 'sina_jsonp', name: '新浪jsonp', role: '1m' as const, status: 'circuit' as const },
        { id: 'tencent_qt', name: '腾讯qt快照', role: 'snapshot' as const, status: 'healthy' as const },
      ],
    })),
  };
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
