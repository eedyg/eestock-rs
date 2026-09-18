import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type {
  WorkbenchBarRecord,
  WorkbenchResultFormat,
  WorkbenchRunFill,
  WorkbenchRunResult,
  WorkbenchRunView,
} from '@/api/types';

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

/** 成交明细状态（`recorded=false` = 后端未写 fills 块，与「无成交」区分）。 */
export interface RunFillsState {
  rows: WorkbenchRunFill[];
  total: number;
  recorded: boolean;
  loading: boolean;
  error: string | null;
}

export interface RunSeries {
  format: WorkbenchResultFormat;
  /** 总分 / 各策略评分曲线数据（chunked = `/curve?kind=per_bar`；legacy = `/result.per_bar`）。 */
  perBar: RunCurve<WorkbenchBarRecord>;
  netValue: RunCurve<[number, number]>;
  drawdown: RunCurve<[number, number]>;
  /** 图表序列是否仍在加载（chunked 首屏 true；legacy 恒 false ⇒ 零回归）。 */
  curvesLoading: boolean;
  curvesError: string | null;
  bars: RunBarsState;
  fills: RunFillsState;
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

const emptyFills = (): RunFillsState => ({ rows: [], total: 0, recorded: true, loading: false, error: null });

/** legacy 分支：直接从 `/result` 内联三列派生（原全量路径，零网络、零回归）。 */
function legacySeries(result: WorkbenchRunResult): Omit<RunSeries, 'loadMore' | 'jumpToRange' | 'resetRange' | 'reload'> {
  const perBar = result.per_bar;
  const fills = fillsFromPerBar(perBar);
  return {
    format: 'legacy_single',
    perBar: { points: perBar, downsampled: false, originalBars: perBar.length },
    netValue: { points: result.net_value, downsampled: false, originalBars: result.net_value.length },
    drawdown: { points: result.drawdown, downsampled: false, originalBars: result.drawdown.length },
    curvesLoading: false,
    curvesError: null,
    bars: { ...emptyBars(), rows: perBar, total: perBar.length },
    fills: { rows: fills, total: fills.length, recorded: true, loading: false, error: null },
  };
}

/**
 * 结果取数 hook（唯一入口）。`run`/`result` 未就绪时返回空态（不发起请求）。
 */
export function useRunSeries({
  api,
  run,
  result,
}: {
  api: ApiClient;
  run: WorkbenchRunView | null;
  result: WorkbenchRunResult | null;
}): RunSeries {
  const runId = run?.id ?? null;
  const format: WorkbenchResultFormat = result?.result_format ?? 'legacy_single';
  const chunked = format === 'chunked_v1';

  const [perBar, setPerBar] = useState<RunCurve<WorkbenchBarRecord>>(emptyCurve);
  const [netValue, setNetValue] = useState<RunCurve<[number, number]>>(emptyCurve);
  const [drawdown, setDrawdown] = useState<RunCurve<[number, number]>>(emptyCurve);
  const [curvesLoading, setCurvesLoading] = useState(false);
  const [curvesError, setCurvesError] = useState<string | null>(null);
  const [bars, setBars] = useState<RunBarsState>(emptyBars);
  const [fills, setFills] = useState<RunFillsState>(emptyFills);
  const [nonce, setNonce] = useState(0);
  const aliveRef = useRef(true);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    aliveRef.current = true;
    if (!chunked || !runId || !result || run?.status !== 'succeeded') return () => undefined;
    let alive = true;
    const alive2 = (fn: () => void) => {
      if (alive) fn();
    };
    setCurvesLoading(true);
    setCurvesError(null);
    setBars((b) => ({ ...b, loading: true, error: null }));
    setFills((f) => ({ ...f, loading: true, error: null }));
    void (async () => {
      const [b, f, pb, nv, dd] = await Promise.allSettled([
        api.getWorkbenchBars(runId, { kind: 'per_bar', offset: 0, limit: SERIES_PAGE_SIZE }),
        api.getWorkbenchFills(runId, { limit: SERIES_PAGE_SIZE }),
        api.getWorkbenchCurve(runId, { kind: 'per_bar', k: SERIES_CURVE_K }),
        api.getWorkbenchCurve(runId, { kind: 'net_value', k: SERIES_CURVE_K }),
        api.getWorkbenchCurve(runId, { kind: 'drawdown', k: SERIES_CURVE_K }),
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
          setFills({
            rows: f.value.fills,
            total: f.value.total,
            recorded: f.value.recorded,
            loading: false,
            error: null,
          });
        } else {
          setFills((s) => ({ ...s, loading: false, error: (f.reason as Error).message }));
          errs.push(`/fills ${(f.reason as Error).message}`);
        }
        const curveOf = <T,>(r: PromiseSettledResult<{ points: unknown; downsampled: boolean; original_bars: number }>) =>
          r.status === 'fulfilled'
            ? { points: r.value.points as T[], downsampled: r.value.downsampled, originalBars: r.value.original_bars }
            : null;
        const pbv = curveOf<WorkbenchBarRecord>(pb);
        const nvv = curveOf<[number, number]>(nv);
        const ddv = curveOf<[number, number]>(dd);
        if (pbv) setPerBar(pbv); else errs.push('/curve?kind=per_bar');
        if (nvv) setNetValue(nvv); else errs.push('/curve?kind=net_value');
        if (ddv) setDrawdown(ddv); else errs.push('/curve?kind=drawdown');
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
            curvesLoading: false,
            curvesError: null,
            bars: emptyBars(),
            fills: emptyFills(),
          };
    return { ...base, loadMore, jumpToRange, resetRange, reload };
  }

  return {
    format,
    perBar,
    netValue,
    drawdown,
    curvesLoading,
    curvesError,
    bars,
    fills,
    loadMore,
    jumpToRange,
    resetRange,
    reload,
  };
}
