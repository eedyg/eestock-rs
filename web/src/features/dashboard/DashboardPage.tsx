import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DashboardGrid, DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { defaultApi } from '@/api';
import { defaultWs } from '@/ws';
import type { ApiClient } from '@/api/client';
import type { MultiPeriodConfigDto, Period } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { RegionPortal } from '@/components/RegionPortal';
import { DashboardStore } from './store';
import { KlineDataFeed, DEFAULT_KLINE_VIEWPORT_BARS } from './feed';
import { MultiPeriodStore, resolveBasePeriod } from './multiPeriodStore';
import { MultiPeriodChartStack, DEFAULT_SATELLITE_HEIGHT } from './MultiPeriodChartStack';
import {
  DEFAULT_DCAP_PARAMS,
  dcapWarmupBars,
  type DcapParams,
} from '@/features/indicators/dcapIndicator';
import { DEFAULT_BASE_HEIGHT } from './multiPeriodLayout';
import { SymbolList } from './SymbolList';
import { Toolbar, type ChartTab, type IndicatorName } from './Toolbar';
import { KlineChart } from './KlineChart';
import { TimeshareChart } from './TimeshareChart';
import { GridCell } from './GridCell';

/** 等待实现（指数退避用；测试可注入瞬时 sleep）。 */
const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReadViewportBarsOptions {
  /** 最多尝试次数（含首次），默认 3。 */
  attempts?: number;
  /** 每次失败后、下一次尝试前的等待（指数退避），默认 500ms→1s。 */
  backoffMs?: number[];
  /** 等待实现（便于测试注入瞬时 sleep）。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 读取 K线默认视口根数（GET /api/config/kline 的 `viewport_bars`）并对瞬态失败重试，直到成功或尝试次数耗尽。
 * 全部失败则抛出（由调用方决定兜底），避免 mount 时 `getKlineConfig().then(set).catch(()=>{})`
 * 的静默吞错——偶发失败/网络抖动时页面被永久锁定在默认视口、无重试、无收敛。
 */
export async function readViewportBars(
  api: ApiClient,
  opts: ReadViewportBarsOptions = {},
): Promise<number> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? [500, 1000];
  const sleep = opts.sleep ?? sleepMs;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const cfg = await api.getKlineConfig();
      return cfg.viewport_bars;
    } catch (e) {
      if (attempt >= attempts) throw e;
      await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 500);
    }
  }
  throw new Error('unreachable');
}

/**
 * 读取 dcap 显示参数（GET /api/config/dcap）并对瞬态失败重试（与 readViewportBars 同口径的
 * ADR-020 韧性要求：mount 读取必须有重试 + focus 重读，否则会表现为「重启回默认」假象）。
 */
export async function readDcapParams(
  api: ApiClient,
  opts: ReadViewportBarsOptions = {},
): Promise<DcapParams> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? [500, 1000];
  const sleep = opts.sleep ?? sleepMs;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await api.getDcapConfig();
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

  // 多周期指标同显运行态（ADR-022；P1 仅骨架与隔离）。配置落服务端（口径 12）；
  // `enabled=false` 时与现状逐字节等价（T11）——本 store 只持配置态，不建 feed / 不订阅 WS。
  const mpStore = useMemo(() => new MultiPeriodStore({ api }), [api]);
  useEffect(() => {
    void mpStore.load();
    return () => mpStore.dispose();
  }, [mpStore]);
  const mpState = useSyncExternalStore(mpStore.subscribe, mpStore.getSnapshot);

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

  // dcap 显示参数（统一配置，主图+宫格共用）：默认 8/26/60/1/1/1/1/3，mount 时 GET /api/config/dcap 读
  // （重试 + focus 重读；失败保持默认，不阻塞看板）；保存走乐观更新 + 失败回滚。
  const [dcapParams, setDcapParams] = useState<DcapParams>(() => ({ ...DEFAULT_DCAP_PARAMS }));
  useEffect(() => {
    let cancelled = false;
    readDcapParams(api)
      .then((p) => {
        if (!cancelled) setDcapParams(p);
      })
      .catch(() => {
        // 读取失败（已重试）保持默认参数（不阻塞看板）
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** 保存 dcap 显示参数：乐观更新（先同步 set 再 await 接口）→ 成功用服务端回显，失败回滚并 rethrow。 */
  const saveDcapParams = useCallback(
    async (next: DcapParams) => {
      const prev = dcapParams;
      setDcapParams({ ...next });
      try {
        const cfg = await api.saveDcapConfig(next);
        setDcapParams(cfg);
      } catch (e) {
        setDcapParams(prev);
        throw e;
      }
    },
    [api, dcapParams],
  );

  /** 切换多周期开关：乐观更新（同步 setEnabled）+ PUT 服务端 config；成功用服务端回显，失败回滚。
   *  照既有 MA/dcap 写法的乐观更新 + 失败回滚。 */
  const toggleMultiPeriod = useCallback(
    async (enabled: boolean) => {
      const prev: MultiPeriodConfigDto = {
        enabled: mpStore.state.enabled,
        periods: [...mpStore.state.periods],
        heights: { ...mpStore.state.heights },
        indicators: [...mpStore.state.indicators],
      };
      mpStore.setEnabled(enabled); // 乐观更新
      try {
        const cfg = await api.saveMultiPeriodConfig({ ...prev, enabled });
        mpStore.applyServerConfig(cfg);
      } catch {
        mpStore.applyServerConfig(prev); // 失败回滚
      }
    },
    [api, mpStore],
  );

  /** 保存多周期**布局高度**（P5；T9）：乐观更新（同步 `mpStore.setHeights`）→ `PUT /api/config/multi_period`
   *  （body = 当前 `enabled`/`periods`/`indicators` **原样** + 新 `heights`）→ 成功用服务端回显，
   *  失败**回滚**到拖拽前高度（DOM 随 store 回滚）且不抛穿页面。形态照既有 MA/dcap 写法的乐观更新 + 失败回滚。 */
  const saveMultiPeriodHeights = useCallback(
    async (heights: Record<string, number>) => {
      const prev: MultiPeriodConfigDto = {
        enabled: mpStore.state.enabled,
        periods: [...mpStore.state.periods],
        heights: { ...mpStore.state.heights },
        indicators: [...mpStore.state.indicators],
      };
      mpStore.setHeights(heights); // 乐观更新（拖拽期间 DOM 已是本地高度，此处只把期望值落到配置态）
      try {
        const cfg = await api.saveMultiPeriodConfig({ ...prev, heights: { ...heights } });
        mpStore.applyServerConfig(cfg);
      } catch {
        mpStore.applyServerConfig(prev); // 失败回滚（不抛穿：拖拽不得炸页面）
      }
    },
    [api, mpStore],
  );

  // K线默认视口（K 线根数，统一配置，主图+宫格共用）：默认 120，mount 时 GET /api/config/kline 读；
  // 读失败重试（最多 3 次、指数退避 500ms/1s），耗尽仍失败用默认 120 兜底（不再静默吞错）。
  const [viewportBars, setViewportBars] = useState<number>(() => DEFAULT_KLINE_VIEWPORT_BARS);
  useEffect(() => {
    let cancelled = false;
    readViewportBars(api)
      .then((bars) => {
        if (!cancelled) setViewportBars(bars);
      })
      .catch(() => {
        // 读取失败（已重试）保持默认 120（不阻塞看板）；至少真实重试，穿越瞬态
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // window focus / visibilitychange(visible) 时重读 getKlineConfig / getDcapConfig（跨 tab 改配置 /
  // 从后台回来能刷新）；重读成功则 setState（feed 重建，useMemo 已含 viewportBars/warmup 依赖）；
  // 失败保持当前值不回落默认。
  useEffect(() => {
    let cancelled = false;
    const reread = () => {
      readViewportBars(api)
        .then((bars) => {
          if (!cancelled) setViewportBars(bars);
        })
        .catch(() => {
          // 重读失败保持当前 viewportBars（不重置为默认）
        });
      readDcapParams(api)
        .then((p) => {
          if (!cancelled) setDcapParams(p);
        })
        .catch(() => {
          // 重读失败保持当前 dcap 参数（不重置为默认）
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

  // 取数 warmup（02-spec §6；裁决依据见 §8 #19）：开 DCAP 时初始取数 limit = viewport_bars + (n_l + m − 1)，
  // 多取部分仅供 dcap 计算、不上图（否则视口最左永远缺一段）；未开 DCAP 不 warmup（ADR-020 口径不变）。
  // **注意**：它**不得进 feed 身份（useMemo deps）**——否则保存 n_l/m 会重建 feed ⇒ KlineChart remount
  // ⇒ 整图 pane 重建、用户拖拽过的副图高度被重置（§6 图表契约「配置保存不得重建 pane」）。
  // warmup 的变化改由 feed.setWarmupBars 热更新 + 图表原地重载（KlineChart 的 warmupBars prop）。
  const dcapWarmup = indicators.dcap ? dcapWarmupBars(dcapParams) : 0;

  // 基准（K 线）周期口径（用户裁决 A）：仅当启用且**确实存在卫星**（periods.length > 1）时，
  // 基准周期由配置 `periods[0]` 决定；否则一律沿用工具栏/状态周期 state.period（单周期配置不存在
  // 多周期视图 ⇒ 「启用」不得静默改写用户选的 K 线周期；T11/D4 已锁死该等价性）。
  // 被配置覆盖时必须**显式可观测**（`basePeriodSource==='config'` ⇒ 页面“基准 x”徽标，禁止静默不一致）。
  const base = resolveBasePeriod(mpState, state.period);
  const basePeriod = base.period;

  // 卫星实例定义（配置 `periods[1..]`；高度本轮取 `heights[period]`，拖拽持久化属 P5）。
  // 仅单图 + K 线页签 + 启用 + 有选中标的时才有卫星（宫格/分时不受影响，02-spec §7.1）。
  const satellites = useMemo(() => {
    if (!mpState.enabled || chartTab !== 'kline' || !state.selected) return [];
    if (mpState.periods.length <= 1) return [];
    return mpState.periods.slice(1).map((p) => ({
      period: p as Period,
      height: mpState.heights[p] ?? DEFAULT_SATELLITE_HEIGHT,
    }));
  }, [mpState.enabled, mpState.periods, mpState.heights, chartTab, state.selected]);

  // bar 数据流随 选中标的+周期 重建；旧 feed 释放 WS 订阅。
  // **基准周期用 basePeriod（口径 A）**：deps 里放 basePeriod（而非 enabled/periods）⇒ 「启用但无卫星」
  // 时 feed 身份不变（不新建实例/订阅/取数，P1 等价性保持）。
  // `warmupBars` 只取**建 feed 那一刻**的值（构建初值）：后续变化走 setWarmupBars 热更新，故意不入 deps。
  const feed = useMemo(
    () =>
      state.selected
        ? new KlineDataFeed({
            api,
            ws,
            code: state.selected,
            period: basePeriod,
            viewportBars,
            warmupBars: dcapWarmup,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- warmup 故意不入 deps（见上：热更新路径）
    [api, ws, state.selected, basePeriod, viewportBars],
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
          dcapParams={dcapParams}
          onSaveDcapParams={saveDcapParams}
          multiPeriodEnabled={mpState.enabled}
          onToggleMultiPeriod={toggleMultiPeriod}
        />
      </RegionPortal>

      {state.gridMode === 'single' ? (
        <RegionPortal root={rootRef} region="main-chart">
          <MultiPeriodChartStack
            enabled={mpState.enabled}
            satellites={satellites}
            api={api}
            ws={ws}
            code={state.selected}
            indicators={indicators}
            maWindows={maWindows}
            dcapParams={dcapParams}
            viewportBars={viewportBars}
            followLatest={state.followLatest}
            basePeriod={basePeriod}
            basePeriodSource={base.source}
            /* P5（T9）：基准 pane 的**请求高度**（配置 `heights[periods[0]]`）与拖拽持久化回调；
               基准实例的实际高度由栈容器按可用高度统一分配（基准吸收余量）。 */
            baseHeight={mpState.heights[basePeriod] ?? DEFAULT_BASE_HEIGHT}
            /* P5（T9）：拖拽持久化回执 —— 返回 Promise 告知父层**已接管**该布局（成功回显/失败回滚均已落盘），
               本组件随后交还高度权威给 props（避免失败回滚被本地拖拽期望掩盖）。 */
            onHeightsChange={saveMultiPeriodHeights}
            /* P3 可观测（02-spec §9）：同步统计镜像入 store（syncApplied/syncSuppressed/
               syncDegraded/最近一次跨度差），与页面角标同源；关闭态/组销毁 ⇒ 归零（零残留）。 */
            onSyncStats={(stats) => mpStore.applySyncStats(stats)}
          >
            {state.selected &&
              (chartTab === 'kline' && feed ? (
                <KlineChart
                  feed={feed}
                  code={state.selected}
                  period={basePeriod}
                  followLatest={state.followLatest}
                  indicators={indicators}
                  onManualZoom={() => store.noteManualZoom()}
                  maWindows={maWindows}
                  dcapParams={dcapParams}
                  warmupBars={dcapWarmup}
                  /* P5：**不再**传 `heightPx` —— 激活态（有卫星）基准高度由栈的基准 pane 决定
                     （避免「h-full 拉满容器 + 卫星追加」⇒ 540px 纵向溢出）；非激活态仍 `h-full`。 */
                />
              ) : (
                <TimeshareChart api={api} ws={ws} code={state.selected} />
              ))}
          </MultiPeriodChartStack>
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
              viewportBars={viewportBars}
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
