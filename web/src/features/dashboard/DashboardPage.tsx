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

/** 等待实现（指数退避用；测试可注入瞬时 sleep）。 */
const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReadViewportDaysOptions {
  /** 最多尝试次数（含首次），默认 3。 */
  attempts?: number;
  /** 每次失败后、下一次尝试前的等待（指数退避），默认 500ms→1s。 */
  backoffMs?: number[];
  /** 等待实现（便于测试注入瞬时 sleep）。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 读取 K线默认视口（GET /api/config/kline）并对瞬态失败重试，直到成功或尝试次数耗尽。
 * 全部失败则抛出（由调用方决定兜底），避免 mount 时 `getKlineConfig().then(set).catch(()=>{})`
 * 的静默吞错——偶发失败/网络抖动时页面被永久锁定在默认视口、无重试、无收敛。
 */
export async function readViewportDays(
  api: ApiClient,
  opts: ReadViewportDaysOptions = {},
): Promise<number> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? [500, 1000];
  const sleep = opts.sleep ?? sleepMs;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const cfg = await api.getKlineConfig();
      return cfg.viewport_days;
    } catch (e) {
      if (attempt >= attempts) throw e;
      await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 500);
    }
  }
  throw new Error('unreachable');
}

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

  // K线默认视口（交易日数，统一配置，主图+宫格共用）：默认 2，mount 时 GET /api/config/kline 读；
  // 读失败重试（最多 3 次、指数退避 500ms/1s），耗尽仍失败用默认 2 兜底（不再静默吞错）。
  const [viewportDays, setViewportDays] = useState<number>(() => DEFAULT_KLINE_VIEWPORT_DAYS);
  useEffect(() => {
    let cancelled = false;
    readViewportDays(api)
      .then((days) => {
        if (!cancelled) setViewportDays(days);
      })
      .catch(() => {
        // 读取失败（已重试）保持默认 2（不阻塞看板）；至少真实重试，穿越瞬态
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // window focus / visibilitychange(visible) 时重读 getKlineConfig（跨 tab 改配置 / 从后台回来能刷新）；
  // 重读成功则 setViewportDays（feed 重建，useMemo 已含 viewportDays 依赖）；失败保持当前值不回落默认。
  useEffect(() => {
    let cancelled = false;
    const reread = () => {
      readViewportDays(api)
        .then((days) => {
          if (!cancelled) setViewportDays(days);
        })
        .catch(() => {
          // 重读失败保持当前 viewportDays（不重置为默认）
        });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reread();
    };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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
