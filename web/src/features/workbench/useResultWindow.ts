import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JumpTarget } from './RoundTripsTable';
import {
  buildCurveX,
  capDisclosure,
  centeredWindow,
  clampDisclosure,
  DEFAULT_JUMP_BUFFER_BARS,
  DEFAULT_L2_JUMP_SPAN_BARS,
  geomFromRange,
  makeWindow,
  periodSeconds,
  popHistory,
  pushHistory,
  roundTripWindow,
  sameGeom,
  throttleLatest,
  WINDOW_THROTTLE_MS,
  type CurveDomainRequest,
  type CurveXBuild,
  type KlinePlotGeom,
  type ResultWindowState,
  type VisibleRangeTs,
  type WindowApplyResult,
  type WindowCommand,
} from './resultWindow';

/**
 * ADR-028 D2/D2.1/D4 —— 结果页**窗口状态机**的 React 承载（页面级，02-spec §9.1/§9.6）。
 *
 * 三个写入者（§9.2）：`kline`（{@link UseResultWindow.applyKlineRange}，节流 + 回声抑制）/
 * `jump`（{@link UseResultWindow.jumpTo}，L1/L2 按钮）/ `reset`（{@link UseResultWindow.reset} +
 * {@link UseResultWindow.back}）。
 *
 * `window === null` = **全区间**（未显式写窗）：此态下曲线按既有全区间取数（**零回归**），
 * 各视图的 x 定义域回退到 run 全区间。
 */
export interface UseResultWindowArgs {
  /** 换 run ⇒ 重置为全区间（§9.6）。 */
  runId: string | null;
  /** run 全区间（Unix 秒；无结果时为 null）。 */
  fullFromTs: number | null;
  fullToTs: number | null;
  /** run 周期档位（`M1`/`D1`…；用于根数↔秒换算）。 */
  period: string | null;
  /** 全区间 bar 根数（「全览」命令的 span_bars）。 */
  totalBars: number;
  /** **降级**定义域用：run per_bar 的已加载行（`/bars?kind=per_bar`）。 */
  perBarRows?: ReadonlyArray<{ ts: number }> | null;
  /** L2 跳转窗口根数（缺省 120，D4「可配」）。 */
  l2SpanBars?: number;
}

export interface UseResultWindow {
  /** 当前共享窗口；`null` = 全区间（无显式窗口）。 */
  window: ResultWindowState | null;
  /** x 轴定义域（窗口 ?? run 全区间）；视图**必须**用它而**不得**用数据自身 min/max（D2.1）。 */
  domain: { from_ts: number; to_ts: number } | null;
  /** 下发给 K 线实例的程序化写窗命令（null = 未写窗）。 */
  command: WindowCommand | null;
  /** 跳转失败**显式**错误（禁止静默无反应；D4/F18）。 */
  applyError: string | null;
  /**
   * 最近一次 K 线实例写窗的**真身回执**（ADR-028 §3.4 观测性：`getBarSpace()`/`getVisibleRange()`
   * 读回值，非页面请求态）。结果页把它上屏为 `wb-window-probe` 的 data-* 属性，供真渲染 E2E
   * 断言「窗口确实落到图上」——**这是越界静默失败的唯一真身证据**（F18 零容忍）。
   */
  observed: WindowApplyResult | null;
  /** 程序化写窗进行中（用于「跳转中…」标注）。 */
  applying: boolean;
  /** K 线侧回执（成功清错、失败落 {@link UseResultWindow.applyError}）。 */
  onApplied: (r: WindowApplyResult) => void;
  /** K 线交互写窗（节流 ~200ms、回声抑制）。 */
  applyKlineRange: (r: VisibleRangeTs) => void;
  /** L1/L2 `[跳转]`（程序化写窗 + 历史入栈）。 */
  jumpTo: (t: JumpTarget) => void;
  /** 「全览」：恢复全区间（历史入栈）。 */
  reset: () => void;
  /** 历史回退（上限 {@link WINDOW_HISTORY_MAX} 步）。 */
  back: () => void;
  canBack: boolean;
  /** 可回退步数（= 历史栈深度；测试/观测用）。 */
  historyDepth: number;
  /** 单根 bar 秒数（视图刻度换算用；与 K 线周期同源）。 */
  barSeconds: number;
  /**
   * ADR-028 D2.1/D2.3-4：K 线**真身几何**（可见 bar 序列 + 复用绘图区几何）。
   * 来源 = `onVisibleRangeChange` 负载（图内 `getVisibleRange()`/`getBarSpace()`/`convertToPixel()` 实测）。
   */
  geom: KlinePlotGeom | null;
  /** 曲线 x 定义域构建结果（主路 = bar 索引；降级 = ts 线性）。 */
  curveX: CurveXBuild;
  /** 曲线取数请求（rev + 取数窗口 + x 定义域），交 `useRunSeries` **原子**提交。 */
  request: CurveDomainRequest;
  /** 程序化写窗**被钳位**披露（请求 ≠ 实测；一致 ⇒ null）。 */
  clampNote: string | null;
  /** 「尽可能全」的物理上限披露（显示 N / 共 M 根；ADR-028 D2.3-3）。 */
  capNote: string | null;
  /** 引擎实测可见根数（回执口径；null = 尚无回执）。 */
  visibleBars: number | null;
}

/** 程序化写窗期间的回声抑制窗（ms）：写窗后引擎派发的 onZoom/onScroll/onVisibleRangeChange 一律忽略。 */
export const PROGRAMMATIC_SUPPRESS_MS = 400;

export function useResultWindow(args: UseResultWindowArgs): UseResultWindow {
  const { runId, fullFromTs, fullToTs, period, totalBars } = args;
  const perBarRows = args.perBarRows ?? null;
  const l2SpanBars = args.l2SpanBars ?? DEFAULT_L2_JUMP_SPAN_BARS;
  const barSeconds = useMemo(() => periodSeconds(period), [period]);

  const [window, setWindow] = useState<ResultWindowState | null>(null);
  const [history, setHistory] = useState<ResultWindowState[]>([]);
  const [command, setCommand] = useState<WindowCommand | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [observed, setObserved] = useState<WindowApplyResult | null>(null);
  /** K 线真身几何（可见 bar 序列 + 绘图区几何；D2.1/D2.3-4）。 */
  const [geom, setGeom] = useState<KlinePlotGeom | null>(null);
  /** 「全区间」（window = null）请求的 rev（单调；与窗口 rev 同一序列，保证落后响应丢弃）。 */
  const [fullRev, setFullRev] = useState(0);
  /** 程序化写窗的**请求**（与回执比对，供钳位披露）。 */
  const lastRequestRef = useRef<{ from_ts: number; to_ts: number; span_bars: number } | null>(null);
  const [clampNote, setClampNote] = useState<string | null>(null);
  const [visibleBars, setVisibleBars] = useState<number | null>(null);

  const revRef = useRef(0);
  /** 回声抑制窗（程序化写窗后 K 线派发的事件在此时刻前一律忽略）。 */
  const suppressUntilRef = useRef(0);
  /** 当前窗口的实时快照（节流回调与事件回调里避免闭包过期）。 */
  const windowRef = useRef<ResultWindowState | null>(null);
  windowRef.current = window;

  const commit = useCallback((w: ResultWindowState) => {
    setWindow(w);
  }, []);

  /** 节流器（**共享** ~200ms，以最后一次为准；§9.7）。只在挂载时建一次。 */
  const throttleRef = useRef<ReturnType<typeof throttleLatest<ResultWindowState>> | null>(null);
  if (!throttleRef.current) {
    throttleRef.current = throttleLatest<ResultWindowState>((w) => commit(w), WINDOW_THROTTLE_MS);
  }

  /** 换 run：窗口重置为全区间、历史栈清空、错误清空（§9.6）。 */
  useEffect(() => {
    throttleRef.current?.cancel();
    revRef.current = 0;
    suppressUntilRef.current = 0;
    windowRef.current = null;
    setWindow(null);
    setHistory([]);
    setCommand(null);
    setApplyError(null);
    setApplying(false);
    setObserved(null);
    setGeom(null);
    // rev 序列在换 run 时归零（新 run 的窗口从 0 重新单调递增；applied 已清空 ⇒ 无跨 run 竞争）
    setFullRev(0);
    setClampNote(null);
    setVisibleBars(null);
    lastRequestRef.current = null;
  }, [runId]);

  useEffect(() => () => throttleRef.current?.cancel(), []);

  /** K 线交互写窗（leader）：节流 + 回声抑制 + 同窗丢弃（无变化不重取）。
   *  同时**记录真身几何**（同一 bar 序列 + 绘图区几何）——曲线 x 映射与共用几何的唯一来源。 */
  const applyKlineRange = useCallback(
    (r: VisibleRangeTs) => {
      // **真身几何先记**（ADR-028 D2.1/D2.3-4）：无论是否程序化回声，K 线实际绘制的 bar 序列与
      // 绘图区几何都是**事实**（曲线 x 映射/共用几何必须跟随）——被抑制的只是「写窗口」这一步。
      const g = geomFromRange(r);
      setGeom((prev) => (sameGeom(prev, g) ? prev : g));
      if (Date.now() < suppressUntilRef.current) return; // 程序化写窗回声 ⇒ 不回写窗口（§9.3）
      revRef.current += 1; // rev **单调**（落后响应丢弃的前提；旧实现用 revRef+1 但不推进 ⇒ 同 rev 竞争）
      const next = makeWindow('kline', r.from_ts, r.to_ts, r.to_idx - r.from_idx + 1, revRef.current, {
        from_idx: r.from_idx,
        to_idx: r.to_idx,
      });
      setVisibleBars(next.span_bars);
      setClampNote(null); // 用户手势不是「请求」，无钳位语义
      const cur = windowRef.current;
      if (
        cur &&
        cur.source === 'kline' &&
        cur.from_ts === next.from_ts &&
        cur.to_ts === next.to_ts
      ) {
        return;
      }
      throttleRef.current?.call(next);
    },
    [],
  );

  const issue = useCallback(
    (w: ResultWindowState, cmd: WindowCommand, pushPrev: boolean) => {
      const prev = windowRef.current;
      if (pushPrev && prev) setHistory((h) => pushHistory(h, prev));
      revRef.current = Math.max(revRef.current, w.rev);
      suppressUntilRef.current = Date.now() + PROGRAMMATIC_SUPPRESS_MS; // 回声抑制窗
      windowRef.current = w;
      setWindow(w);
      setCommand(cmd);
      setApplyError(null);
      setApplying(true);
      // 记录**请求值**（回读后与实测比对 ⇒ 钳位披露；禁「请求即发布」）
      lastRequestRef.current = { from_ts: cmd.from_ts, to_ts: cmd.to_ts, span_bars: cmd.span_bars };
      setClampNote(null);
    },
    [],
  );

  const jumpTo = useCallback(
    (t: JumpTarget) => {
      const rev = revRef.current + 1;
      let w: ResultWindowState;
      if (t.level === 'L1') {
        // ADR-028 D4：窗口 = 回合 **[open_bar, close_bar] ± buffer 根**。
        // 根数**必须**由回合的 **bar 索引差**给出（`close_bar - open_bar + 1`），**不得**用
        // `(ts 差)/step` 反算：真身 bar 可能稀疏（实测 ~0.73 根/日）⇒ ts 反算会把窗口放大（P5c 真渲染实测：
        // 回合 53 根被算成 78 根，可见窗口多覆盖 ~30 天）。ts 仅作 from/to 初值，应用后由真身回执校正。
        const step = Math.max(1, barSeconds);
        const legs = Math.abs((t.close_bar ?? t.open_bar) - t.open_bar) + 1;
        const span = legs + 2 * DEFAULT_JUMP_BUFFER_BARS;
        w = roundTripWindow(t.open_ts, t.close_ts ?? t.open_ts, step, rev, DEFAULT_JUMP_BUFFER_BARS, span);
      } else {
        w = centeredWindow(t.ts, barSeconds, rev, l2SpanBars);
      }
      issue(
        w,
        {
          rev,
          from_ts: w.from_ts,
          to_ts: w.to_ts,
          span_bars: w.span_bars,
          center_ts: (w.from_ts + w.to_ts) / 2,
          // L1：窗口 = 区间内**全部** bar（回合完整可见）；L2：窗口 = `span_bars` **根**（成交 bar 居中）。
          span_mode: t.level === 'L1' ? 'range' : 'bars',
        },
        true,
      );
    },
    [barSeconds, issue, l2SpanBars],
  );

  /** 「全览」：窗口回到全区间（window = null ⇒ 曲线按既有全区间取数），并把当前窗入栈。 */
  const reset = useCallback(() => {
    const prev = windowRef.current;
    if (prev) setHistory((h) => pushHistory(h, prev));
    revRef.current += 1;
    const rev = revRef.current;
    windowRef.current = null;
    setWindow(null);
    setFullRev(rev);
    setApplyError(null);
    setClampNote(null);
    if (fullFromTs != null && fullToTs != null) {
      suppressUntilRef.current = Date.now() + PROGRAMMATIC_SUPPRESS_MS;
      const cmd: WindowCommand = {
        rev,
        from_ts: fullFromTs,
        to_ts: fullToTs,
        span_bars: Math.max(1, totalBars || 1),
        center_ts: (fullFromTs + fullToTs) / 2,
        span_mode: 'range',
      };
      lastRequestRef.current = { from_ts: cmd.from_ts, to_ts: cmd.to_ts, span_bars: cmd.span_bars };
      setCommand(cmd);
      setApplying(true);
    }
  }, [fullFromTs, fullToTs, totalBars]);

  const back = useCallback(() => {
    setHistory((h) => {
      const { stack, prev } = popHistory(h);
      if (!prev) return h; // 无可回退：不动（`canBack=false` 时按钮应禁用）
      revRef.current += 1;
      const rev = revRef.current;
      const w = { ...prev, rev };
      windowRef.current = w;
      setWindow(w);
      setApplyError(null);
      suppressUntilRef.current = Date.now() + PROGRAMMATIC_SUPPRESS_MS;
      const cmd: WindowCommand = {
        rev,
        from_ts: w.from_ts,
        to_ts: w.to_ts,
        span_bars: w.span_bars,
        center_ts: (w.from_ts + w.to_ts) / 2,
        span_mode: 'range',
      };
      lastRequestRef.current = { from_ts: cmd.from_ts, to_ts: cmd.to_ts, span_bars: cmd.span_bars };
      setCommand(cmd);
      setApplying(true);
      setClampNote(null);
      return stack;
    });
  }, []);

  const onApplied = useCallback(
    (r: WindowApplyResult) => {
      setApplying(false);
      setObserved(r); // 真身回执（成功/失败都留痕，禁止「没报错就算绿」）
      if (!r.ok) {
        setApplyError(r.error ?? `窗口应用失败（rev ${r.rev}）`);
        return;
      }
      setApplyError(null);
      const obs = r.observed;
      if (!obs) return;
      setVisibleBars(obs.to_idx - obs.from_idx + 1);
      // ADR-028 §4.1：程序化写窗成功后，把**页面共享窗口对齐到真身实测窗口**。
      // 理由：barSpace 为整数 + 真身含部分 bar + 数据稀疏 ⇒ 请求态 `[from_ts, to_ts]` 与可见态
      // 必然有量化偏差；而「各曲线 x 定义域 == K 线可见 ts 区间」是冻结契约（§4.1/D2.1）。
      // 回执即真身读数 ⇒ 以回执为准。
      const cur = windowRef.current;
      if (cur && (cur.source === 'jump' || cur.source === 'reset')) {
        const span = obs.to_idx - obs.from_idx + 1;
        setClampNote(clampDisclosure(lastRequestRef.current, obs, barSeconds));
        if (
          cur.from_ts !== obs.from_ts ||
          cur.to_ts !== obs.to_ts ||
          cur.span_bars !== span ||
          cur.from_idx !== obs.from_idx ||
          cur.to_idx !== obs.to_idx
        ) {
          const next: ResultWindowState = {
            ...cur,
            from_ts: obs.from_ts,
            to_ts: obs.to_ts,
            span_bars: span,
            from_idx: obs.from_idx,
            to_idx: obs.to_idx,
          };
          windowRef.current = next;
          setWindow(next);
        }
      }
    },
    [barSeconds],
  );

  const domain = useMemo(() => {
    if (window) return { from_ts: window.from_ts, to_ts: window.to_ts };
    if (fullFromTs != null && fullToTs != null) return { from_ts: fullFromTs, to_ts: fullToTs };
    return null;
  }, [window, fullFromTs, fullToTs]);

  /**
   * 曲线 x 定义域构建（ADR-028 D2.1：主路 = bar 索引空间；降级 = ts 线性；无域 = null）。
   * `barSeconds` 用于配对容差（真身 per_bar ts 与 K 线 bar ts 可差数秒 ⇒ 最近邻吸附）。
   */
  const curveX = useMemo(
    () =>
      buildCurveX({
        geom,
        perBarTs: perBarRows ? perBarRows.map((r) => r.ts) : null,
        from_ts: domain?.from_ts ?? null,
        to_ts: domain?.to_ts ?? null,
        barSeconds,
      }),
    [geom, domain, barSeconds, perBarRows],
  );

  /** 取数请求（窗口 rev + 取数窗口 + x 定义域）：`useRunSeries` 据此**原子**提交「数据 ↔ 定义域」。 */
  const request: CurveDomainRequest = useMemo(
    () => ({
      rev: window ? window.rev : fullRev,
      window: window ? { from_ts: window.from_ts, to_ts: window.to_ts } : null,
      xDomain: curveX.xDomain,
      plot: curveX.plot,
      degraded: curveX.degraded,
      source: curveX.source,
      slots: curveX.slots,
    }),
    [window, fullRev, curveX],
  );

  /** 全览态（window = null）的物理上限披露：以**引擎实测可见根数**为 N、run 总根数为 M。 */
  const capNote = useMemo(() => {
    if (window) return null;
    return capDisclosure(visibleBars, totalBars);
  }, [window, visibleBars, totalBars]);

  return {
    window,
    domain,
    command,
    applyError,
    observed,
    applying,
    onApplied,
    applyKlineRange,
    jumpTo,
    reset,
    back,
    canBack: history.length > 0,
    historyDepth: history.length,
    barSeconds,
    geom,
    curveX,
    request,
    clampNote,
    capNote,
    visibleBars,
  };
}
