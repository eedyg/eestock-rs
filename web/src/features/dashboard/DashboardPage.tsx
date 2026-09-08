import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DashboardGrid, DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { defaultApi } from '@/api';
import { defaultWs } from '@/ws';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { RegionPortal } from '@/components/RegionPortal';
import { DashboardStore } from './store';
import { KlineDataFeed, DEFAULT_KLINE_VIEWPORT_DAYS } from './feed';
import { SymbolList } from './SymbolList';
import { Toolbar, type ChartTab, type IndicatorName } from './Toolbar';
import { KlineChart } from './KlineChart';
import { TimeshareChart } from './TimeshareChart';
import { GridCell } from './GridCell';

/**
 * 页面①行情看板：以 tangle 骨架 DashboardGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 */
export function DashboardPage({ api = defaultApi, ws = defaultWs }: { api?: ApiClient; ws?: WsClient }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const store = useMemo(() => new DashboardStore({ api, ws }), [api, ws]);
  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // chartTab / 指标勾选为页面本地状态（骨架 Props 未覆盖，默认值取 DASHBOARD_DEFAULTS）
  const [chartTab, setChartTab] = useState<ChartTab>(
    DASHBOARD_DEFAULTS.chartTab === 'kline' ? 'kline' : 'timeshare',
  );
  const [indicators, setIndicators] = useState<Record<IndicatorName, boolean>>({
    ...DASHBOARD_DEFAULTS.indicators,
  });

  // MA 窗口（统一配置，主图+宫格共用）：默认 [5,10,20]，mount 时 GET /api/config/ma 读；保存走乐观更新
  const [maWindows, setMaWindows] = useState<number[]>(() => [...DASHBOARD_DEFAULTS.maWindows]);
  useEffect(() => {
    let cancelled = false;
    api
      .getMaConfig()
      .then((cfg) => {
        if (!cancelled) setMaWindows(cfg.windows);
      })
      .catch(() => {
        // 读取失败保持默认 [5,10,20]（不阻塞看板）
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** 保存 MA 窗口：乐观更新（先同步 setMaWindows 再 await 接口）→ 成功用后端归一化结果，失败回滚并 rethrow。 */
  const saveMaWindows = useCallback(
    async (windows: number[]) => {
      const prev = maWindows;
      setMaWindows([...windows]);
      try {
        const cfg = await api.saveMaConfig(windows);
        setMaWindows(cfg.windows);
      } catch (e) {
        setMaWindows(prev);
        throw e;
      }
    },
    [api, maWindows],
  );

  // K线默认视口（交易日数，统一配置，主图+宫格共用）：默认 2，mount 时 GET /api/config/kline 读；缺省 2 兜底。
  const [viewportDays, setViewportDays] = useState<number>(() => DEFAULT_KLINE_VIEWPORT_DAYS);
  useEffect(() => {
    let cancelled = false;
    api
      .getKlineConfig()
      .then((cfg) => {
        if (!cancelled) setViewportDays(cfg.viewport_days);
      })
      .catch(() => {
        // 读取失败保持默认 2（不阻塞看板）
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // bar 数据流随 选中标的+周期 重建；旧 feed 释放 WS 订阅
  const feed = useMemo(
    () =>
      state.selected
        ? new KlineDataFeed({ api, ws, code: state.selected, period: state.period, viewportDays })
        : null,
    [api, ws, state.selected, state.period, viewportDays],
  );
  useEffect(() => () => feed?.dispose(), [feed]);

  const gridCount = state.gridMode === 'grid2x2' ? 4 : 6;

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1">
      <DashboardGrid
        symbols={state.symbols}
        selected={state.selected ?? ''}
        onSelectSymbol={(c) => store.selectSymbol(c)}
        period={state.period}
        onPeriodChange={(p) => store.setPeriod(p)}
        gridMode={state.gridMode}
        onGridModeChange={(m) => store.setGridMode(m)}
        followLatest={state.followLatest}
        onBackToLatest={() => store.backToLatest()}
        onLoadBefore={() => {
          void feed?.loadBefore();
        }}
      />

      <RegionPortal root={rootRef} region="symbol-list">
        <SymbolList
          symbols={store.filteredSymbols}
          status={state.symbolsStatus}
          selected={state.selected}
          search={state.search}
          onSearchChange={(q) => store.setSearch(q)}
          onSelect={(c) => store.selectSymbol(c)}
          onRetry={() => void store.init()}
          onToggleFavorite={(c) => store.toggleFavorite(c)}
          onReorderFavorites={(codes) => store.reorderFavorites(codes)}
        />
      </RegionPortal>

      <RegionPortal root={rootRef} region="toolbar">
        <Toolbar
          period={state.period}
          onPeriodChange={(p) => store.setPeriod(p)}
          chartTab={chartTab}
          onChartTabChange={setChartTab}
          indicators={indicators}
          onToggleIndicator={(name) => setIndicators((s) => ({ ...s, [name]: !s[name] }))}
          gridMode={state.gridMode}
          onGridModeChange={(m) => store.setGridMode(m)}
          followLatest={state.followLatest}
          onBackToLatest={() => store.backToLatest()}
          maWindows={maWindows}
          onSaveMaWindows={saveMaWindows}
        />
      </RegionPortal>

      {state.gridMode === 'single' ? (
        <RegionPortal root={rootRef} region="main-chart">
          {state.selected &&
            (chartTab === 'kline' && feed ? (
              <KlineChart
                feed={feed}
                code={state.selected}
                period={state.period}
                followLatest={state.followLatest}
                indicators={indicators}
                onManualZoom={() => store.noteManualZoom()}
                maWindows={maWindows}
              />
            ) : (
              <TimeshareChart api={api} ws={ws} code={state.selected} />
            ))}
        </RegionPortal>
      ) : (
        <RegionPortal root={rootRef} region="grid-view">
          {state.symbols.slice(0, gridCount).map((s) => (
            <GridCell
              key={s.code}
              symbol={s}
              period={state.period}
              api={api}
              ws={ws}
              maWindows={maWindows}
              onPick={(code) => {
                store.selectSymbol(code);
                store.setGridMode('single');
              }}
            />
          ))}
        </RegionPortal>
      )}
    </div>
  );
}
