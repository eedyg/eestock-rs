import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type {
  RoundTrip,
  RoundTripFill,
  WorkbenchBarRecord,
  WorkbenchPositionPoint,
  WorkbenchResultFormat,
  WorkbenchRunFill,
  WorkbenchRunResult,
  WorkbenchRunView,
} from '@/api/types';
import { isStaleResponse, type ResultWindowState } from './resultWindow';

/**
 * 页面⑪ 结果取数**单一入口**（ADR-024 P6 / §5.2；架构师裁决 Q1=A + DRY 硬约束）。
 *
 * 硬约束（本文件是 workbench 特性内唯一的取数点；ResultView / KlineResultChart / PerBarTable /
 * EventLog **一律**从这里取数，禁止各自散落拉取）：
 * - **曲线（总分/各策略分/净值/回撤）⇒ `GET …/curve?kind=&k=`**（显式抽样，带 `downsampled`/
 *   `original_bars` 供 UI 标注；**禁止静默有损**，ADR-024 D10）。
 * - **逐 bar 明细 ⇒ `GET …/bars?kind=per_bar&offset&limit`**（分页；`has_more`/`next_offset`
 *   **必须消费** —— UI 给出「已加载 N / 共 M」与加载入口，杜绝静默只显首页，D9）。
 * - **成交明细 ⇒ `GET …/fills`**（有界精确源；K 线买卖标记**不用** `trades`：`TradeDetail` 仅在
 *   完全平仓时合成 ⇒ 部分买入/加仓与部分卖出不进 `trades`）。
 * - `result_format` 判别（ADR-024 D8）：`legacy_single` 走原 `/result` 全量路径（**零回归**）；
 *   `chunked_v1` 走上述新端点。
 */

/** `/bars` 分页页大小（与后端 `BARS_LIMIT_DEFAULT` 一致 = 一个分块 5000）。 */
export const SERIES_PAGE_SIZE = 5000;
/** `/curve` 抽样目标点数（与后端 `CURVE_K_DEFAULT` 一致）。 */
export const SERIES_CURVE_K = 2000;
/** L1 回合列表页大小（`/round-trips`；ADR-027 D8 懒加载首屏）。 */
export const ROUND_TRIPS_PAGE_SIZE = 200;
/** L2 回合切片页大小（`/round-trips/{rt_seq}/fills`；展开该回合时按 `next_offset` 拉全）。 */
export const L2_PAGE_SIZE = 500;
/** L2 单回合最大拉取页数（护栏：超限 ⇒ 显式披露「未拉全」，禁止静默截断）。 */
export const L2_MAX_PAGES = 40;
/** `/fills`（K 线标记事实源）最大拉取页数（ADR-027 D11 完整性契约的护栏）。 */
export const FILLS_MAX_PAGES = 40;

/** 曲线 + 抽样标注（`downsampled=false` = 全量，UI 不标抽样）。 */
export interface RunCurve<T> {
  points: T[];
  downsampled: boolean;
  /** 抽样前根数（标注「共 M」的依据）。 */
  originalBars: number;
}

/** 逐 bar 明细的分页状态（覆盖范围**必须**显式标注：`已加载 N / 共 M`）。 */
export interface RunBarsState {
  rows: WorkbenchBarRecord[];
  /** 本 run 的 per_bar 总根数（服务端口径）。 */
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** 区间跳读回显（`/bars?from&to`）；null = 序号分页读。 */
  range: { from: string; to: string; count: number } | null;
}

/** 成交明细状态（`recorded=false` = 后端未写 fills 块，与「无成交」区分）。
 *  ADR-027 D11：`total`（服务端口径总量）与 `rows.length`（已加载量）**必须**同时披露；
 *  `complete=false` ⇒ 仍有未加载页（或触及拉取护栏），UI 不得静默当作全量。 */
export interface RunFillsState {
  rows: WorkbenchRunFill[];
  total: number;
  recorded: boolean;
  loading: boolean;
  error: string | null;
  /** 已拉全（`rows.length == total` 且无 `has_more`）。 */
  complete: boolean;
  /** 触及 `FILLS_MAX_PAGES` 护栏而未拉全（显式披露，非静默）。 */
  truncated: boolean;
}

/** L1 回合列表状态（`recorded=false` = 无成交事实源 ⇒ L1 不可得，与「无回合」区分）。 */
export interface RunRoundTripsState {
  rows: RoundTrip[];
  total: number;
  recorded: boolean;
  hasMore: boolean;
  nextOffset: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

/** 单个回合的 L2 切片状态（**懒加载**：`requested=false` 表示从未请求）。 */
export interface RunL2State {
  rows: RoundTripFill[];
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  loading: boolean;
  /** 已发出过请求（含失败）——用于「展开前零请求」的懒加载断言与 UI 三态。 */
  requested: boolean;
  error: string | null;
  /** 触及 `L2_MAX_PAGES` 护栏而未拉全（显式披露）。 */
  truncated: boolean;
}

export interface RunSeries {
  format: WorkbenchResultFormat;
  /** 总分 / 各策略评分曲线数据（chunked = `/curve?kind=per_bar`；legacy = `/result.per_bar`）。 */
  perBar: RunCurve<WorkbenchBarRecord>;
  netValue: RunCurve<[number, number]>;
  drawdown: RunCurve<[number, number]>;
  /** ADR-028 D1：持仓序列（`/curve?kind=position`；`position_value + cash == nav` 逐点）。 */
  position: RunCurve<WorkbenchPositionPoint>;
  /** 图表序列是否仍在加载（chunked 首屏 true；legacy 恒 false ⇒ 零回归）。 */
  curvesLoading: boolean;
  curvesError: string | null;
  /** ADR-028 D3：**窗口**取数加载态（窗口变化时的重新采样请求）。 */
  windowLoading: boolean;
  /** 窗口取数失败（UI **必须**标注「显示的是上一窗口数据」，禁止旧数据冒充当前窗口，§9.8）。 */
  windowError: string | null;
  /** 当前曲线数据实际对应的窗口（null = 全区间）。UI 用它判定「是否已在显示新窗口」。 */
  windowApplied: { from_ts: number; to_ts: number; rev: number } | null;
  bars: RunBarsState;
  fills: RunFillsState;
  /** L1 回合列表（ADR-027 D8：chunked 走 `/round-trips` 分页；legacy 由 `/result.trades` 内联派生）。 */
  roundTrips: RunRoundTripsState;
  /** 各回合的 L2 切片（键 = `rt_seq`；仅展开过的回合有键）。 */
  l2: Record<number, RunL2State>;
  /** **懒加载入口**：展开某回合时调用；未调用则**不得**发起任何 L2 请求。 */
  ensureL2: (rtSeq: number) => void;
  /** 加载更多 L1 回合（消费 `/round-trips` 的 `next_offset`）。 */
  loadMoreRoundTrips: () => void;
  /** 加载更多逐 bar 明细（消费 `next_offset`）。 */
  loadMore: () => void;
  /** 区间跳读（复用 `/bars` 的 `from&to`；服务端在块内按 ts 精确过滤）。 */
  jumpToRange: (fromIso: string, toIso: string) => void;
  /** 退出区间跳读，回到序号分页首页。 */
  resetRange: () => void;
  /** 整段重取（错误重试 / 区间复位）。 */
  reload: () => void;
}

/** 由 per_bar 的 `fill` 事件派生成交明细（与后端 legacy 双读同口径；`ts` 取所在 bar）。 */
export function fillsFromPerBar(perBar: WorkbenchBarRecord[]): WorkbenchRunFill[] {
  const out: WorkbenchRunFill[] = [];
  for (const rec of perBar) {
    for (const ev of rec.events) {
      if (ev.type !== 'fill') continue;
      out.push({
        type: 'fill',
        bar_index: ev.bar_index,
        ts: rec.ts,
        side: ev.side,
        qty: ev.qty,
        price: ev.price,
        reason: ev.reason,
        // ADR-027 D4：归属键 + 费用三件套**逐笔透传引擎事实**（禁下游复算）
        rt_seq: ev.rt_seq,
        trade_value: ev.trade_value,
        commission: ev.commission,
        stamp_duty: ev.stamp_duty,
      });
    }
  }
  return out;
}

const emptyCurve = <T,>(): RunCurve<T> => ({ points: [], downsampled: false, originalBars: 0 });

const emptyBars = (): RunBarsState => ({
  rows: [],
  total: 0,
  hasMore: false,
  nextOffset: null,
  loading: false,
  loadingMore: false,
  error: null,
  range: null,
});

const emptyFills = (): RunFillsState => ({
  rows: [], total: 0, recorded: true, loading: false, error: null, complete: false, truncated: false,
});

const emptyRoundTrips = (): RunRoundTripsState => ({
  rows: [], total: 0, recorded: true, hasMore: false, nextOffset: null,
  loading: false, loadingMore: false, error: null,
});

/** L2 单回合切片装载器（按 `next_offset` 拉全；`L2_MAX_PAGES` 护栏 ⇒ `truncated=true` 显式披露）。 */
async function fetchAllL2(
  api: ApiClient,
  runId: string,
  rtSeq: number,
): Promise<{ rows: RoundTripFill[]; total: number; hasMore: boolean; nextOffset: number | null; truncated: boolean }> {
  const rows: RoundTripFill[] = [];
  let offset: number | null = 0;
  let total = 0;
  let pages = 0;
  while (offset != null) {
    const page = await api.getWorkbenchRoundTripFills(runId, rtSeq, { offset, limit: L2_PAGE_SIZE });
    rows.push(...page.fills);
    total = page.total;
    offset = page.has_more ? page.next_offset : null;
    pages += 1;
    if (pages >= L2_MAX_PAGES && offset != null) break;
  }
  return { rows, total, hasMore: offset != null, nextOffset: offset, truncated: offset != null };
}

/** `/fills` 全量装载器（ADR-027 D11：分页拉全 + 显式披露总量/已加载量）。 */
async function fetchAllFills(
  api: ApiClient,
  runId: string,
): Promise<{ rows: WorkbenchRunFill[]; total: number; recorded: boolean; complete: boolean; truncated: boolean }> {
  const rows: WorkbenchRunFill[] = [];
  let offset: number | null = 0;
  let total = 0;
  let recorded = true;
  let pages = 0;
  while (offset != null) {
    // 首页保持既有调用形状（`{ limit }`）；后续页按 `next_offset` 续拉（禁静默首页截断）
    const page = await api.getWorkbenchFills(runId, offset === 0 ? { limit: SERIES_PAGE_SIZE } : { offset, limit: SERIES_PAGE_SIZE });
    rows.push(...page.fills);
    total = page.total;
    recorded = page.recorded;
    offset = page.has_more ? page.next_offset : null;
    pages += 1;
    if (!page.recorded) break;
    if (pages >= FILLS_MAX_PAGES && offset != null) break;
  }
  return { rows, total, recorded, complete: offset == null, truncated: offset != null };
}

/** legacy 分支：直接从 `/result` 内联三列派生（原全量路径，零网络、零回归）。 */
export function legacySeries(
  result: WorkbenchRunResult,
): Omit<
  RunSeries,
  | 'loadMore'
  | 'jumpToRange'
  | 'resetRange'
  | 'reload'
  | 'ensureL2'
  | 'loadMoreRoundTrips'
  | 'l2'
> {
  const perBar = result.per_bar;
  const fills = fillsFromPerBar(perBar);
  return {
    format: 'legacy_single',
    perBar: { points: perBar, downsampled: false, originalBars: perBar.length },
    netValue: { points: result.net_value, downsampled: false, originalBars: result.net_value.length },
    drawdown: { points: result.drawdown, downsampled: false, originalBars: result.drawdown.length },
    // legacy 无 `/curve?kind=position` 数据源（历史 run）⇒ 诚实空态（持仓比率视图显式留白）
    position: emptyCurve<WorkbenchPositionPoint>(),
    curvesLoading: false,
    curvesError: null,
    windowLoading: false,
    windowError: null,
    windowApplied: null,
    bars: { ...emptyBars(), rows: perBar, total: perBar.length },
    fills: { rows: fills, total: fills.length, recorded: true, loading: false, error: null, complete: true, truncated: false },
    // legacy：L1 取 `/result.trades` 内联列（**零网络**，与今日行为逐字节一致）；L2 仍按 D8 懒加载。
    roundTrips: { ...emptyRoundTrips(), rows: result.trades, total: result.trades.length },
  };
}

/**
 * 结果取数 hook（唯一入口）。`run`/`result` 未就绪时返回空态（不发起请求）。
 */
export function useRunSeries({
  api,
  run,
  result,
  window = null,
}: {
  api: ApiClient;
  run: WorkbenchRunView | null;
  result: WorkbenchRunResult | null;
  /** ADR-028 D3：共享时间窗（页面级事实源）；null = 全区间（既有行为零回归）。 */
  window?: ResultWindowState | null;
}): RunSeries {
  const runId = run?.id ?? null;
  const format: WorkbenchResultFormat = result?.result_format ?? 'legacy_single';
  const chunked = format === 'chunked_v1';

  const [perBar, setPerBar] = useState<RunCurve<WorkbenchBarRecord>>(emptyCurve);
  const [netValue, setNetValue] = useState<RunCurve<[number, number]>>(emptyCurve);
  const [drawdown, setDrawdown] = useState<RunCurve<[number, number]>>(emptyCurve);
  const [position, setPosition] = useState<RunCurve<WorkbenchPositionPoint>>(emptyCurve);
  const [curvesLoading, setCurvesLoading] = useState(false);
  const [curvesError, setCurvesError] = useState<string | null>(null);
  const [windowLoading, setWindowLoading] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [windowApplied, setWindowApplied] = useState<{ from_ts: number; to_ts: number; rev: number } | null>(null);
  /** 已发出的最大窗口 rev（02-spec §9.3：落后响应丢弃，防乱序覆盖）。 */
  const issuedRevRef = useRef(0);
  const [bars, setBars] = useState<RunBarsState>(emptyBars);
  const [fills, setFills] = useState<RunFillsState>(emptyFills);
  const [roundTrips, setRoundTrips] = useState<RunRoundTripsState>(emptyRoundTrips);
  const [l2, setL2] = useState<Record<number, RunL2State>>({});
  const [nonce, setNonce] = useState(0);
  const aliveRef = useRef(true);
  /** 已取数的 L2 键（`runId#rt_seq`）：展开-收起-再展开不重复打请求（D8 懒加载 + 会话内保留）。 */
  const l2FetchedRef = useRef<Set<string>>(new Set());

  const reload = useCallback(() => {
    l2FetchedRef.current = new Set(); // 整段重取 ⇒ L2 缓存失效（避免旧切片冒充新数据）
    setL2({});
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (!chunked || !runId || !result || run?.status !== 'succeeded') return () => undefined;
    let alive = true;
    const alive2 = (fn: () => void) => {
      if (alive) fn();
    };
    setCurvesLoading(true);
    setCurvesError(null);
    setWindowApplied(null); // 换 run / 重取：上一窗口的「已应用」标记失效
    setWindowError(null);
    setWindowLoading(false);
    issuedRevRef.current = 0;
    setBars((b) => ({ ...b, loading: true, error: null }));
    setFills((f) => ({ ...f, loading: true, error: null }));
    setRoundTrips((r) => ({ ...r, loading: true, error: null }));
    void (async () => {
      const [b, f, pb, nv, dd, rt, pos] = await Promise.allSettled([
        api.getWorkbenchBars(runId, { kind: 'per_bar', offset: 0, limit: SERIES_PAGE_SIZE }),
        // ADR-027 D11：**分页拉全**（旧实现只取 5000 首页且无续拉 ⇒ 标记静默缺失）
        fetchAllFills(api, runId),
        api.getWorkbenchCurve(runId, { kind: 'per_bar', k: SERIES_CURVE_K }),
        api.getWorkbenchCurve(runId, { kind: 'net_value', k: SERIES_CURVE_K }),
        api.getWorkbenchCurve(runId, { kind: 'drawdown', k: SERIES_CURVE_K }),
        // ADR-027 D8：L1 列表（含 l2_count/买卖笔数摘要；L2 切片仍懒加载）
        api.getWorkbenchRoundTrips(runId, { offset: 0, limit: ROUND_TRIPS_PAGE_SIZE }),
        // ADR-028 D1：持仓序列（全区间；窗口态由下面的窗口 effect 覆盖）
        api.getWorkbenchCurve(runId, { kind: 'position', k: SERIES_CURVE_K }),
      ]);
      const errs: string[] = [];
      alive2(() => {
        if (b.status === 'fulfilled') {
          setBars({
            rows: b.value.bars,
            total: b.value.total,
            hasMore: b.value.has_more,
            nextOffset: b.value.next_offset,
            loading: false,
            loadingMore: false,
            error: null,
            range: null,
          });
        } else {
          setBars((s) => ({ ...s, loading: false, error: (b.reason as Error).message }));
          errs.push(`/bars ${(b.reason as Error).message}`);
        }
        if (f.status === 'fulfilled') {
          setFills({ ...f.value, loading: false, error: null });
        } else {
          setFills((s) => ({ ...s, loading: false, error: (f.reason as Error).message }));
          errs.push(`/fills ${(f.reason as Error).message}`);
        }
        if (rt.status === 'fulfilled') {
          setRoundTrips({
            rows: rt.value.round_trips,
            total: rt.value.total,
            recorded: rt.value.recorded,
            hasMore: rt.value.has_more,
            nextOffset: rt.value.next_offset,
            loading: false,
            loadingMore: false,
            error: null,
          });
        } else {
          setRoundTrips((r) => ({ ...r, loading: false, error: (rt.reason as Error).message }));
          errs.push(`/round-trips ${(rt.reason as Error).message}`);
        }
        const curveOf = <T,>(r: PromiseSettledResult<{ points: unknown; downsampled: boolean; original_bars: number }>) =>
          r.status === 'fulfilled'
            ? { points: r.value.points as T[], downsampled: r.value.downsampled, originalBars: r.value.original_bars }
            : null;
        const pbv = curveOf<WorkbenchBarRecord>(pb);
        const nvv = curveOf<[number, number]>(nv);
        const ddv = curveOf<[number, number]>(dd);
        const posv = curveOf<WorkbenchPositionPoint>(pos);
        if (pbv) setPerBar(pbv); else errs.push('/curve?kind=per_bar');
        if (nvv) setNetValue(nvv); else errs.push('/curve?kind=net_value');
        if (ddv) setDrawdown(ddv); else errs.push('/curve?kind=drawdown');
        if (posv) setPosition(posv); else errs.push('/curve?kind=position');
        setCurvesLoading(false);
        setCurvesError(errs.length > 0 ? errs.join('；') : null);
      });
    })();
    return () => {
      alive = false;
      aliveRef.current = false;
    };
    // `run?.status` 与 `result` 变化需重取；`nonce` 为重试/区间复位信号。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, runId, chunked, run?.status, result, nonce]);

  /**
   * **窗口曲线**（ADR-028 D3）：共享窗口变化 ⇒ 对 4 个 kind **并发**重取（既有 per-kind 端点，
   * 不新增批量端点，§9.7），窗口内重新采样（`k` 作用于窗口内点集）。
   *
   * 两条硬约束：
   * - **落后响应丢弃**（§9.3）：响应 rev < 已发出的最大 rev ⇒ 直接丢弃，**不回写也不动加载态**
   *   （否则旧窗口响应会把新窗口数据覆盖，或把新请求的 loading 提前关掉）；
   * - **失败不冒充**（§9.8）：任一 kind 失败 ⇒ `windowError` 显式报错，且**不**更新
   *   `windowApplied` ⇒ UI 可标注「显示的是上一窗口数据」。
   */
  const winFrom = window?.from_ts ?? null;
  const winTo = window?.to_ts ?? null;
  const winRev = window?.rev ?? null;
  useEffect(() => {
    if (!chunked || !runId || !result || run?.status !== 'succeeded') return () => undefined;
    if (winFrom == null || winTo == null || winRev == null) return () => undefined;
    if (isStaleResponse(winRev, issuedRevRef.current)) return () => undefined; // 乱序到达的旧窗口：不发起
    issuedRevRef.current = winRev;
    let alive = true;
    setWindowLoading(true);
    setWindowError(null);
    void (async () => {
      const q = { k: SERIES_CURVE_K, from_ts: winFrom, to_ts: winTo };
      const [pb, nv, dd, pos] = await Promise.allSettled([
        api.getWorkbenchCurve(runId, { kind: 'per_bar', ...q }),
        api.getWorkbenchCurve(runId, { kind: 'net_value', ...q }),
        api.getWorkbenchCurve(runId, { kind: 'drawdown', ...q }),
        api.getWorkbenchCurve(runId, { kind: 'position', ...q }),
      ]);
      if (!alive) return;
      if (isStaleResponse(winRev, issuedRevRef.current)) return; // 落后即丢弃（不回写、不改加载态）
      const errs: string[] = [];
      const curveOf = <T,>(r: PromiseSettledResult<{ points: unknown; downsampled: boolean; original_bars: number }>) =>
        r.status === 'fulfilled'
          ? { points: r.value.points as T[], downsampled: r.value.downsampled, originalBars: r.value.original_bars }
          : null;
      const pbv = curveOf<WorkbenchBarRecord>(pb);
      const nvv = curveOf<[number, number]>(nv);
      const ddv = curveOf<[number, number]>(dd);
      const posv = curveOf<WorkbenchPositionPoint>(pos);
      if (pbv) setPerBar(pbv); else errs.push('/curve?kind=per_bar');
      if (nvv) setNetValue(nvv); else errs.push('/curve?kind=net_value');
      if (ddv) setDrawdown(ddv); else errs.push('/curve?kind=drawdown');
      if (posv) setPosition(posv); else errs.push('/curve?kind=position');
      setWindowLoading(false);
      if (errs.length > 0) {
        // 不更新 windowApplied ⇒ UI 显式标注「显示的是上一窗口数据」（禁止旧数据冒充当前窗口）
        setWindowError(errs.join('；'));
      } else {
        setWindowError(null);
        setWindowApplied({ from_ts: winFrom, to_ts: winTo, rev: winRev });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, runId, chunked, run?.status, result, winFrom, winTo, winRev]);

  /**
   * **L2 懒加载**（ADR-027 D8）：只在展开某回合时调用 ⇒ 展开前**零** L2 请求。
   * 已取过的回合（同一 run）复用缓存；失败 ⇒ 显式错误态（可重试，禁止静默空表）。
   */
  const ensureL2 = useCallback(
    (rtSeq: number) => {
      if (!runId) return;
      const key = `${runId}#${rtSeq}`;
      if (l2FetchedRef.current.has(key)) return;
      l2FetchedRef.current.add(key);
      setL2((m) => ({ ...m, [rtSeq]: { rows: [], total: 0, hasMore: false, nextOffset: null, loading: true, requested: true, error: null, truncated: false } }));
      void (async () => {
        try {
          const page = await fetchAllL2(api, runId, rtSeq);
          setL2((m) => ({ ...m, [rtSeq]: { ...page, loading: false, requested: true, error: null } }));
        } catch (e) {
          l2FetchedRef.current.delete(key); // 失败可重试（重试前不残留 requested 缓存）
          setL2((m) => ({ ...m, [rtSeq]: { ...(m[rtSeq] ?? { rows: [], total: 0, hasMore: false, nextOffset: null, truncated: false }), loading: false, requested: true, error: (e as Error).message } }));
        }
      })();
    },
    [api, runId],
  );

  /** 加载更多 L1 回合（消费 `/round-trips` 的 `has_more`/`next_offset`；完整披露已加载 N / 共 M）。 */
  const loadMoreRoundTrips = useCallback(() => {
    if (!chunked || !runId || !roundTrips.hasMore || roundTrips.loadingMore) return;
    const offset = roundTrips.nextOffset ?? roundTrips.rows.length;
    setRoundTrips((r) => ({ ...r, loadingMore: true }));
    void (async () => {
      try {
        const page = await api.getWorkbenchRoundTrips(runId, { offset, limit: ROUND_TRIPS_PAGE_SIZE });
        setRoundTrips((r) => ({
          ...r,
          rows: [...r.rows, ...page.round_trips],
          total: page.total,
          hasMore: page.has_more,
          nextOffset: page.next_offset,
          loadingMore: false,
          error: null,
        }));
      } catch (e) {
        setRoundTrips((r) => ({ ...r, loadingMore: false, error: (e as Error).message }));
      }
    })();
  }, [api, chunked, runId, roundTrips.hasMore, roundTrips.loadingMore, roundTrips.nextOffset, roundTrips.rows.length]);

  /** 加载更多（消费 `has_more`/`next_offset`；追加不覆盖）。 */
  const loadMore = useCallback(() => {
    if (!chunked || !runId || !bars.hasMore || bars.loadingMore) return;
    const offset = bars.nextOffset ?? bars.rows.length;
    setBars((b) => ({ ...b, loadingMore: true }));
    void (async () => {
      try {
        const page = await api.getWorkbenchBars(runId, { kind: 'per_bar', offset, limit: SERIES_PAGE_SIZE });
        setBars((b) => ({
          ...b,
          rows: [...b.rows, ...page.bars],
          total: page.total,
          hasMore: page.has_more,
          nextOffset: page.next_offset,
          loadingMore: false,
          error: null,
        }));
      } catch (e) {
        setBars((b) => ({ ...b, loadingMore: false, error: (e as Error).message }));
      }
    })();
  }, [api, chunked, runId, bars.hasMore, bars.loadingMore, bars.nextOffset, bars.rows.length]);

  /** 区间跳读（服务端在块内按 ts 精确过滤；结果替换当前页，覆盖范围显式标注）。 */
  const jumpToRange = useCallback(
    (fromIso: string, toIso: string) => {
      if (!chunked || !runId) return;
      setBars((b) => ({ ...b, loading: true, error: null }));
      void (async () => {
        try {
          const page = await api.getWorkbenchBars(runId, { kind: 'per_bar', from: fromIso, to: toIso });
          setBars({
            rows: page.bars,
            total: page.total,
            hasMore: false,
            nextOffset: null,
            loading: false,
            loadingMore: false,
            error: null,
            range: { from: fromIso, to: toIso, count: page.bars.length },
          });
        } catch (e) {
          setBars((b) => ({ ...b, loading: false, error: (e as Error).message }));
        }
      })();
    },
    [api, chunked, runId],
  );

  const resetRange = useCallback(() => reload(), [reload]);

  // legacy：直接从 `/result` 派生（同步返回 ⇒ 旧行为零回归）。
  if (!chunked) {
    const base =
      result && run?.status === 'succeeded'
        ? legacySeries(result)
        : {
            format,
            perBar: emptyCurve<WorkbenchBarRecord>(),
            netValue: emptyCurve<[number, number]>(),
            drawdown: emptyCurve<[number, number]>(),
            position: emptyCurve<WorkbenchPositionPoint>(),
            curvesLoading: false,
            curvesError: null,
            windowLoading: false,
            windowError: null,
            windowApplied: null,
            bars: emptyBars(),
            fills: emptyFills(),
            roundTrips: emptyRoundTrips(),
          };
    return { ...base, l2, ensureL2, loadMoreRoundTrips, loadMore, jumpToRange, resetRange, reload };
  }

  return {
    format,
    perBar,
    netValue,
    drawdown,
    position,
    curvesLoading,
    curvesError,
    windowLoading,
    windowError,
    windowApplied,
    bars,
    fills,
    roundTrips,
    l2,
    ensureL2,
    loadMoreRoundTrips,
    loadMore,
    jumpToRange,
    resetRange,
    reload,
  };
}
