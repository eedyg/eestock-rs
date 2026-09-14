import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '@/api/client';
import type { Period } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import type { IndicatorName } from './Toolbar';
import { DEFAULT_DCAP_PARAMS, type DcapParams } from '@/features/indicators/dcapIndicator';
import { MultiPeriodSatellite } from './MultiPeriodSatellite';
import { ChartSyncContext, useChartSyncGroup } from './chartSyncContext';
import type { SyncStats } from './chartSyncGroup';
import {
  DEFAULT_BASE_HEIGHT,
  DRAG_DEBOUNCE_MS,
  BASE_MIN_HEIGHT,
  distributeStackHeights,
  dragPair,
  heightsByPeriod,
  toPersistableHeights,
  type StackPane,
} from './multiPeriodLayout';

export { DEFAULT_SATELLITE_HEIGHT } from './multiPeriodLayout';

/** 卫星实例定义（`periods[1..]`，按配置顺序）。 */
export interface MultiPeriodSatelliteSpec {
  period: Period;
  /** 实例高度 px（本轮取 `heights[period]`；拖拽持久化属 P5）。 */
  height: number;
}

export interface MultiPeriodChartStackProps {
  /** 多周期开关（默认 false ⇒ 与现状逐字节等价）。 */
  enabled?: boolean;
  /** 基准 pane **请求高度** px（配置 `heights[periods[0]]`；缺省 = 420）。基准的实际高度由本栈按可用高度分配。 */
  baseHeight?: number;
  /** 可用高度量测覆盖（测试/SSR 用）；缺省 = 量测本栈根元素（`ResizeObserver`）。 */
  availableHeight?: number;
  /** 拖拽结束（防抖 `DRAG_DEBOUNCE_MS` 后）回调：**全 pane 布局高度**（键 = `periods`，值 = 整数 px）。
   *  页面负责「乐观写 store + PUT + 失败回滚」（照既有 MA/dcap 写法的形态）。
   *
   *  **高度权威交还口径（P5-B 裁决：接受，2026-09-15）**：
   *  - 父层返回 **Promise** ⇒ 表示父层已接管高度权威；该 Promise settle（**无论成功回显还是失败回滚**）
   *    后，本组件**交还高度权威给 props**；
   *  - 返回 `undefined` / 未提供 ⇒ 组件**保留本地拖拽结果**（如测试探针/无副作用订阅者接管不了）。
   *  存在理由（C3 钉死）：页面「乐观写 + 失败回滚」可在同一 React 提交内被批处理 ⇒ 仅凭 props 无法区分
   *  「父层已回滚」与「父层未接管」；若不交还，失败回滚会被本地拖拽期望掩盖（面板停在拖后高度）。
   *  **禁止**用 module 级/`localStorage` 缓存高度（权威链恒为：服务端配置 → 父层 props → 本组件）。 */
  onHeightsChange?: (heights: Record<string, number>) => void | Promise<unknown>;
  /** 卫星实例（配置 `periods[1..]`）；空数组/未启用 ⇒ 逐字节透传 children（零包裹层）。 */
  satellites?: MultiPeriodSatelliteSpec[];
  api?: ApiClient;
  ws?: WsClient;
  /** 当前选中标的（空 ⇒ 只画 children，不建卫星）。 */
  code?: string | null;
  /** 基准图指标勾选集合（卫星**继承**该集合；02-spec §4.1）。 */
  indicators?: Record<IndicatorName, boolean>;
  maWindows?: number[];
  dcapParams?: DcapParams;
  /** K 线默认视口根数（GET /api/config/kline）。 */
  viewportBars?: number;
  /** 实时跟随（P2：各实例各自右端跟随；跨图跨度对齐属 P3）。 */
  followLatest?: boolean;
  /** 基准（K 线）周期与来源：`config` ⇒ 被配置 `periods[0]` 覆盖（显式可观测，禁止静默不一致）。 */
  basePeriod?: Period;
  basePeriodSource?: 'config' | 'toolbar';
  /** 同步统计广播（可观测性 02-spec §9：`syncApplied`/`syncSuppressed`/`syncDegraded`/跨度差）。
   *  同步组是页面侧（React）状态源，**不经 store 驱动渲染**；store 只镜像可观测字段。 */
  onSyncStats?: (stats: SyncStats) => void;
  children: ReactNode;
}

/** 指标勾选兜底（与 `DASHBOARD_DEFAULTS.indicators` 同构）。 */
const DEFAULT_INDICATORS: Record<IndicatorName, boolean> = {
  ma: true,
  macd: false,
  kdj: false,
  boll: false,
  dcap: false,
};
const DEFAULT_MA_WINDOWS: number[] = [5, 10, 20];
const DEFAULT_VIEWPORT_BARS = 120;

/** 「对齐受限」角标状态（降级卫星周期 + 最近一次跨度差分钟；非降级 ⇒ period=null）。 */
interface SyncBadgeState {
  period: string | null;
  spanDiffMinutes: number | null;
}
const NO_BADGE: SyncBadgeState = { period: null, spanDiffMinutes: null };

/**
 * 多周期图表容器（`design/15-multi-period/02-spec.md` §1；P2 挂载卫星实例）。
 *
 * 硬约束：
 * - `enabled=false`（或没有卫星/无选中标的）⇒ **逐字节透传 children（零包裹层）**：DOM 结构/请求/订阅与
 *   现状完全一致（T11 关闭态等价）。**且「enabled=true 但无卫星」（单周期配置）同样不产生任何可见后果**
 *   ——不得新增实例/订阅/取数（用户裁决 A + D4 已锁死的契约）。
 * - children（基准 K 线实例）必须是返回片段的**第一个子节点**：卫星追加在其后（`<>{children}{satellites}</>`）。
 *   绝不在基准之前插入节点——片段是位置化协调，前置节点会让基准 chart 被 remount（dispose+init），
 *   破坏「配置保存/开关切换不得重建实例」契约。
 * - 卫星各自独立实例 + 独立 `KlineDataFeed`（period = 该卫星周期，禁止本地聚合）；隐藏 K 线用
 *   `state:'minimize'` + `separator:0`（02-spec §3.4）；失败可见（§9）。
 */
export function MultiPeriodChartStack({
  enabled = false,
  baseHeight,
  availableHeight,
  onHeightsChange,
  satellites = [],
  api,
  ws,
  code,
  indicators = DEFAULT_INDICATORS,
  maWindows = DEFAULT_MA_WINDOWS,
  dcapParams = DEFAULT_DCAP_PARAMS,
  viewportBars = DEFAULT_VIEWPORT_BARS,
  followLatest = true,
  basePeriod,
  basePeriodSource = 'toolbar',
  onSyncStats,
  children,
}: MultiPeriodChartStackProps) {
  const active = enabled && satellites.length > 0 && !!api && !!ws && !!code;

  // 同步降级角标（T8bis-④/⑤）：只把「角标相关」的变化推给 React（非降级态的滚动不触发重渲染）。
  const [syncBadge, setSyncBadge] = useState<SyncBadgeState>(NO_BADGE);
  const handleSyncStats = useCallback(
    (stats: SyncStats) => {
      onSyncStats?.(stats);
      setSyncBadge((prev) => {
        const period = stats.degraded ? stats.degradedPeriod : null;
        if (prev.period === period && (period === null || prev.spanDiffMinutes === stats.lastSpanDiffMinutes)) {
          return prev;
        }
        return { period, spanDiffMinutes: stats.lastSpanDiffMinutes };
      });
    },
    [onSyncStats],
  );
  /** 同步组注册表（仅在启用态挂 provider；关闭 ⇒ 无 group、无订阅、零残留）。 */
  const syncRegistry = useChartSyncGroup({ onStats: handleSyncStats });

  // ── P5：可用高度量测（`availableHeight` 显式给出时优先；否则量测本栈根元素）────────────────
  // jsdom 无布局引擎（`clientHeight` 恒 0、RO 桩不回调）⇒ `available = 0` ⇒ `unavailable`
  // ⇒ 保持请求高度（不得猜默认值，否则 P2 的「卫星 inline height == heights[period]」被假红）。
  // 注意：量测目标（`[data-mp-stack]` 根元素）**仅在激活态存在** ⇒ 依赖 `active`（关闭→开启必须重新挂载
  // 观察者；若只依赖 `availableHeight`，首次提交时 ref 尚为 null ⇒ 永远量不到高度）。
  const [measured, setMeasured] = useState(0);
  const [measureNode, setMeasureNode] = useState<HTMLDivElement | null>(null);
  const rootRef = useCallback((node: HTMLDivElement | null) => setMeasureNode(node), []);
  useEffect(() => {
    if (availableHeight !== undefined) return;
    const el = measureNode;
    if (!el) return;
    const initial = el.clientHeight;
    if (initial > 0) setMeasured(initial);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const next = rect && Number.isFinite(rect.height) && rect.height > 0 ? rect.height : el.clientHeight;
      if (!(next > 0)) return;
      setMeasured((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [availableHeight, measureNode, active]);
  const available = availableHeight !== undefined ? availableHeight : measured;

  // ── P5：pane 定义（基准 = children 宿主；卫星 = 配置 periods[1..]）────────────────────────────
  // 基准请求高度来自 `baseHeight`（配置 `heights[periods[0]]`）——DashboardPage 不再给基准 KlineChart
  // 传 `heightPx`（激活态高度由本栈的 pane 决定；非激活态仍 `h-full` ⇒ 现状等价）。
  const periodsKey = satellites.map((s) => s.period).join('\u0000');
  // **依赖完整性（R1 修复；02-spec §6.2 架构裁决 ③）**：`satellites` 数组每次渲染都是新引用 ⇒ 直接入依赖
  // 会让 memo 每渲染重算；改用「`周期:高度`」**稳定签名**（同样的周期+高度 ⇒ 同样的串 ⇒ 不重算）。
  // 缺此依赖时，父层回执**只改卫星高度**（基准请求值不变）会被静默忽略 ⇒ 拖拽在回执 settle 后回弹、
  // 屏幕与服务端配置分叉（P5 最终验收 R1 实测 600px：拖中 `{294,112,82,112}` → 回执后 `{294,97,97,112}`）。
  const satelliteHeightsKey = satellites.map((s) => `${s.period}:${s.height}`).join('\u0000');
  const specPanes = useMemo<StackPane[]>(() => {
    const base: StackPane = {
      key: basePeriod ?? 'base',
      period: basePeriod ?? 'base',
      requested: baseHeight ?? DEFAULT_BASE_HEIGHT,
      isBase: true,
    };
    return [base, ...satellites.map((s) => ({ key: s.period, period: s.period, requested: s.height, isBase: false }))];
  }, [basePeriod, baseHeight, periodsKey, satelliteHeightsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- satellites 由 periodsKey+satelliteHeightsKey（周期+高度稳定签名）比对

  // 拖拽会改写「期望 px」；但**配置/父层回写**（保存成功回显 或 失败回滚）必须重新成为权威
  // ⇒ 请求高度签名一变即丢弃本地拖拽期望（否则失败回滚回不去；沿用 React 官方「props 变更时调整 state」写法）。
  const requestSig = specPanes.map((p) => String(p.requested)).join('|');
  const [dragRequest, setDragRequest] = useState<Record<string, number> | null>(null);
  const [lastSig, setLastSig] = useState(requestSig);
  if (lastSig !== requestSig) {
    setLastSig(requestSig);
    setDragRequest(null);
  }

  const requests = useMemo<StackPane[]>(() => {
    if (!dragRequest) return specPanes;
    return specPanes.map((p) => {
      const d = dragRequest[p.period];
      return typeof d === 'number' && Number.isFinite(d)
        ? { ...p, requested: d, fromDrag: true }
        : { ...p, fromDrag: true };
    });
  }, [specPanes, dragRequest]);

  /** 分配结果（唯一高度权威；Σ == 可用，或退化可滚动且可观测）。 */
  const layout = useMemo(() => distributeStackHeights({ panes: requests, available }), [requests, available]);
  const paneHeights = useMemo(() => heightsByPeriod(layout), [layout]);

  // 防抖持久化：拖拽期间用本地期望高度（乐观）；`DRAG_DEBOUNCE_MS` 静默后恰写一次「全 pane 布局高度」。
  // **载荷夹取（P5-E-1）**：`fit` 路径下基准吸收余量 ⇒ 分配高度可 > `HEIGHT_MAX = 1200`（可用高度 ≥ ~1201px 时）
  // ⇒ 原样回流会被 `PUT /api/config/multi_period` 400 拒绝并回滚。故持久化载荷逐项夹到 `[80,1200]`
  // （`toPersistableHeights`）；**渲染分配不改**（`Σ == 可用高度` 不变量不得被夹取破坏）。
  const payloadRef = useRef<Record<string, number>>(paneHeights);
  useEffect(() => {
    payloadRef.current = paneHeights;
  }, [paneHeights]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = useCallback(() => {
    if (!onHeightsChange) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const out = onHeightsChange(toPersistableHeights(payloadRef.current));
      // 父层若以 Promise 回执「接管」：落定（成功回显 / 失败回滚）后交还高度权威给 props。
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        void (out as Promise<unknown>).then(
          () => setDragRequest(null),
          () => setDragRequest(null),
        );
      }
    }, DRAG_DEBOUNCE_MS);
  }, [onHeightsChange]);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  /**
   * 拖拽分隔条：改写相邻两 pane 的**期望 px**（上 += delta，下 −= delta），再由分配算法统一分配。
   * 以**鼠标事件**驱动（mousedown 于分隔条 → mousemove/mouseup 于 window）；不以 region 锚点 border 命中。
   */
  const beginDrag = useCallback(
    (upper: string, lower: string, startEvent: { clientY: number; preventDefault?: () => void }) => {
      startEvent.preventDefault?.();
      const startY = startEvent.clientY;
      // 拖拽基线 = **持久化域内的当前值**（`clamp(当前分配)`，02-spec §6.2 架构裁决 ①，2026-09-15）：
      // 不是屏幕分配值。越域时（可用 ≥1201px 的 `fit` 路径，基准吸收余量可 > HEIGHT_MAX）两者相差 ≤61px，
      // 以屏幕值为基线会与「载荷 = clamp(分配)」的持久化口径错位（载荷重复/零反馈、重载跳变）；
      // 以域内值为基线 ⇒ 每次拖拽都单调改载荷（无死区），屏幕由分配算法决定（裁决 ②：基准在 `fit` 模式
      // 是余量吸收项，其持久化值仅作记录）。
      // 同时保留 B6 实测口径：基线取「当前」而非上次拖拽的原始期望值（缩小路径后二次拖拽不得错位）。
      const seed = toPersistableHeights(paneHeights);
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY;
        if (delta === 0) return;
        moved = true;
        setDragRequest(dragPair(seed, upper, lower, delta));
        scheduleFlush();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (moved) scheduleFlush();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [dragRequest, paneHeights, scheduleFlush],
  );

  if (!active) {
    // ⚠️ **仍保留 Provider 包裹**（值为 null ⇒ `useChartSyncRegistry()` 得 no-op 注册表）：
    // 若此处直接返回 `<>{children}</>`，根元素类型会从 `Context.Provider` 变成 Fragment ⇒ React 会
    // 卸载整个旧子树（含基准 KlineChart）再重建 ⇒ `init`/`dispose` 重跑、用户拖拽过的 pane 高度被重置，
    // 破坏 P2 已验收的「2③ 不重建 pane」契约。Provider **不渲染任何 DOM** ⇒ 关闭态 DOM 逐字节等价不变。
    return <ChartSyncContext.Provider value={null}>{children}</ChartSyncContext.Provider>;
  }
  const baseKey = specPanes[0]!.period;
  const layoutJson = JSON.stringify({
    reason: layout.reason,
    total: layout.total,
    shrunk: layout.shrunk,
    scrollable: layout.scrollable,
    available,
    heights: paneHeights,
  });
  /** 我方分隔条（**不得**依赖 region 锚点 border）：净布局高度 0（`h-0` + 绝对定位命中带），
   *  否则「Σ pane == 可用高度」与「无溢出」不可能同时成立。 */
  const separator = (upper: string, lower: string) => (
    <div
      key={`sep:${upper}|${lower}`}
      data-mp-separator={`${upper}|${lower}`}
      data-mp-sep-upper={upper}
      data-mp-sep-lower={lower}
      data-mp-sep-height="0"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`调整 ${upper} 与 ${lower} 高度`}
      className="relative z-10 h-0 w-full shrink-0 cursor-row-resize"
      onMouseDown={(e) => beginDrag(upper, lower, e)}
    >
      <div className="absolute inset-x-0 -top-1 h-2 hover:bg-acc1/50" />
    </div>
  );
  const paneHeightOf = (period: string): number => paneHeights[period] ?? 0;

  return (
    <ChartSyncContext.Provider value={syncRegistry}>
      <div
        ref={rootRef}
        data-mp-stack=""
        data-mp-stack-scrollable={layout.scrollable ? 'true' : 'false'}
        data-mp-stack-layout={layoutJson}
        className="flex h-full w-full min-h-0 flex-col"
        style={layout.scrollable ? { overflowY: 'auto' } : undefined}
      >
        {/* 基准 pane：children 仍为 Provider 的第一个子节点（不得前置节点 ⇒ 不得 remount 基准实例）。
            高度 = 分配结果（`flex-none` + inline px ⇒ 与分配逐 px 一致；`flex-1` 会在退化可滚动时
            被 flex 压扁/拉伸而与分配不符）。*/}
        <div
          data-mp-pane={baseKey}
          data-mp-pane-role="base"
          data-mp-pane-height={paneHeightOf(baseKey)}
          style={{ height: `${paneHeightOf(baseKey)}px`, minHeight: `${BASE_MIN_HEIGHT}px` }}
          className="relative w-full flex-none overflow-hidden"
        >
          {children}
        </div>
        {satellites.map((s, i) => (
          <Fragment key={s.period}>
            {separator(i === 0 ? baseKey : satellites[i - 1]!.period, s.period)}
            <div
              data-mp-pane={s.period}
              data-mp-pane-role="satellite"
              data-mp-pane-height={paneHeightOf(s.period)}
              style={{ height: `${paneHeightOf(s.period)}px` }}
              className="relative w-full flex-none overflow-hidden"
            >
              <MultiPeriodSatellite
                api={api}
                ws={ws}
                code={code}
                period={s.period}
                height={paneHeightOf(s.period)}
                indicators={indicators}
                maWindows={maWindows}
                dcapParams={dcapParams}
                viewportBars={viewportBars}
                followLatest={followLatest}
                basePeriod={basePeriod ?? (s.period as Period)}
                basePeriodSource={basePeriodSource}
                syncDegraded={syncBadge.period === s.period}
                syncSpanDiffMinutes={syncBadge.period === s.period ? syncBadge.spanDiffMinutes : null}
              />
            </div>
          </Fragment>
        ))}
      </div>
    </ChartSyncContext.Provider>
  );
}
