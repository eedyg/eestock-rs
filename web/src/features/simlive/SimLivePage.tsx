import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { SimLiveGrid } from '@/layouts/SimLiveGrid';
import { defaultApi } from '@/api';
import type { ApiClient } from '@/api/client';
import type { SimStateDto, SimStrategiesDto, StrategyCatalogEntry, SymbolSnapshot } from '@/api/types';
import { RegionPortal } from '@/components/RegionPortal';
import { SimLiveStore } from './store';
import {
  SessionControl,
  PositionTable,
  StrategyPanel,
  StockScoringTable,
  OrderTradeList,
  SessionHistory,
} from './panels';
import './simlive.css'; // 页面作用域样式（.tab/.tab-on/.sim-card 等，避免污染全局 index.css）

/** 空态默认（current 未加载时骨架渲染用；active=false）。 */
const EMPTY_STATE: SimStateDto = {
  active: false,
  session: null,
  account: null,
  positions: [],
  pnl: null,
  trading_enabled: false,
  mcp_enabled: true,
};

const EMPTY_STRATEGIES: SimStrategiesDto = { session_id: '', strategies: [], stocks: [] };

/**
 * 页面⑨ 模拟实盘：以 tangle 骨架 SimLiveGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 * 数据流：current GET /api/sim-live/state + strategies GET /api/sim-live/strategies + orders GET /api/sim-live/orders；
 * 历史：sessions GET /api/sim-live/sessions + 详情 GET /api/sim-live/sessions/{id} + 「回测一下」POST .../backtest-compare。
 * 与 MCP 共享同一 SimLiveService（后端）；本页轮询 /state 刷新（简单起见，不做 WS 订阅）。 */
export function SimLivePage({ api = defaultApi }: { api?: ApiClient }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // #history 深链：location.hash 决定初始 Tab（读一次，不随后续 hash 变动作响应）。
  const initialTab = window.location.hash === '#history' ? 'history' : 'current';
  const store = useMemo(() => new SimLiveStore({ api }, initialTab), [api]);
  // 会话配置可选项：标的目录（GET /api/symbols）+ 策略目录（P4a 切源：GET /api/strategies
  // Registry catalog——仅 published 策略最新版本；旧内建目录 /api/backtest/strategies 不再用于会话配置）。
  const [symbols, setSymbols] = useState<SymbolSnapshot[]>([]);
  const [strategyCatalog, setStrategyCatalog] = useState<StrategyCatalogEntry[]>([]);
  useEffect(() => {
    let canc = false;
    void api.getSymbols().then((d) => { if (!canc) setSymbols(d); }).catch(() => {});
    void api.getStrategyCatalog({ kind: 'strategy' }).then((d) => { if (!canc) setStrategyCatalog(d); }).catch(() => {});
    return () => { canc = true; };
  }, [api]);
  useEffect(() => {
    void store.init();
    // 轻量轮询 /state 实时刷新（当前会话聚合；5s；dispose 时清）。
    const t = setInterval(() => void store.refreshCurrent(), 5000);
    return () => {
      clearInterval(t);
      store.dispose();
    };
  }, [store]);
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const current = s.current.data ?? EMPTY_STATE;
  const strategies = s.strategies.data ?? EMPTY_STRATEGIES;
  const orders = s.orders.data ?? [];
  const error = s.current.error ?? s.strategies.error ?? s.orders.error ?? s.actionError;

  return (
    <div ref={rootRef} className="flex min-w-0 min-h-0 flex-1">
      <SimLiveGrid
        activeTab={s.activeTab}
        onTabChange={(t) => store.setTab(t)}
        state={current}
        strategies={strategies}
        orders={orders}
        sessions={s.sessions.data ?? []}
        loading={s.current.loading || s.strategies.loading || s.orders.loading}
        error={error}
        onRetry={() => void store.refreshCurrent()}
        onStartSession={(p) => void store.startSession(p)}
        onStopSession={(id) => void store.stopSession(id)}
        onToggleTrading={(e) => void store.toggleTrading(e)}
        onToggleMcp={(e) => void store.toggleMcp(e)}
        onPlaceOrder={(p) => void store.placeOrder({ ...p, side: p.side as 'buy' | 'sell' })}
        onCancelOrder={(id) => void store.cancelOrder(id)}
        onBacktestCompare={(id) => void store.runBacktestCompare(id)}
        onSelectSession={(id) => void store.selectSession(id)}
      />

      <RegionPortal root={rootRef} region="session-control">
        <SessionControl
          state={current}
          starting={s.starting}
          stopping={s.stopping}
          togglingTrading={s.togglingTrading}
          togglingMcp={s.togglingMcp}
          symbols={symbols}
          strategies={strategyCatalog}
          onStart={(p) => void store.startSession(p)}
          onStop={() => void store.stopSession()}
          onToggleTrading={(e) => void store.toggleTrading(e)}
          onToggleMcp={(e) => void store.toggleMcp(e)}
        />
      </RegionPortal>

      <RegionPortal root={rootRef} region="position-table">
        <PositionTable positions={current.positions} />
      </RegionPortal>

      <RegionPortal root={rootRef} region="strategy-panel">
        <StrategyPanel strategies={strategies.strategies} />
      </RegionPortal>

      <RegionPortal root={rootRef} region="stock-scoring">
        <StockScoringTable stocks={strategies.stocks} />
      </RegionPortal>

      <RegionPortal root={rootRef} region="order-trade-list">
        <OrderTradeList orders={orders} onCancel={(id) => void store.cancelOrder(id)} />
      </RegionPortal>

      <RegionPortal root={rootRef} region="session-history">
        <SessionHistory
          sessions={s.sessions.data ?? []}
          selected={s.selectedSession.data}
          compare={s.backtestCompare}
          onSelect={(id) => void store.selectSession(id)}
          onCompare={(id) => void store.runBacktestCompare(id)}
        />
      </RegionPortal>
    </div>
  );
}
