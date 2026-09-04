import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { NavBar } from './NavBar';
import { TopBar } from './TopBar';
import { sessionLabel, shanghaiTimeHHMM, tradingSession } from './session';
import { defaultApi } from '@/api';
import { defaultWs } from '@/ws';
import type { ApiClient } from '@/api/client';
import type { SourcesHealth } from '@/api/types';
import { collectorRunningOf, minuteSources } from '@/features/sources/sourceMeta';
import type { WsClient, WsConnectionStatus } from '@/ws/WsClient';

/**
 * 应用骨架（00-shell §骨架组件）：顶部状态条 + 左侧导航 + 页面出口。
 * 状态条数据：交易时段客户端计算；采集灯/1m 源健康数 = GET /api/sources/health + WS source_health 刷新。
 */
export function AppShell({ api = defaultApi, ws = defaultWs }: { api?: ApiClient; ws?: WsClient }) {
  const [health, setHealth] = useState<SourcesHealth | null>(null);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('connecting');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      api
        .getSourcesHealth()
        .then((h) => {
          if (alive) setHealth(h);
        })
        .catch(() => {});
    };
    void refresh();
    const offStatus = ws.onStatusChange(setWsStatus);
    const offHealth = ws.subscribe('source_health', () => void refresh());
    ws.connect();
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => {
      alive = false;
      offStatus();
      offHealth();
      clearInterval(timer);
    };
  }, [api, ws]);

  const session = tradingSession(now);
  // 1m 角色源统计（后端不携带角色——前端静态映射，sourceMeta）
  const m1 = health ? minuteSources(health.sources) : null;

  return (
    <div className="flex h-screen min-w-[1280px] flex-col">
      <TopBar
        sessionLabel={sessionLabel(session)}
        sessionTime={shanghaiTimeHHMM(now)}
        collectorRunning={collectorRunningOf(health, now.getTime())}
        healthy1m={m1 ? m1.filter((s) => s.status === 'healthy').length : null}
        total1m={m1 ? m1.length : null}
        wsStatus={wsStatus}
      />
      <div className="flex min-h-0 flex-1">
        <NavBar />
        <Outlet />
      </div>
    </div>
  );
}
