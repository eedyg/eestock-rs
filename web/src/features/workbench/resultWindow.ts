/**
 * ADR-028 D2 / D2.1 / D4 —— 结果页**时间窗状态机**（页面级共享事实源；本文件是可单测的纯函数层）。
 *
 * 为什么必须是页面级而不复用 `ChartSyncGroup`（ADR-028 F12/F22）：既有跨图同步组只面向 klinecharts
 * 实例（靠 `getVisibleRange`/`setBarSpace`/`scrollToTimestamp`）；结果页的曲线视图是**手写 SVG**
 * （F13/F21），只有「时间窗」这一种能力，故窗口事实源必须上提为页面状态。
 *
 * 逐条对应：
 * - **唯一事实源**：{@link ResultWindowState}（`from_ts`/`to_ts`/`span_bars`/`source`/`rev`）。
 * - **写入者**（02-spec §9.2）：`kline`（图内 `getVisibleRange()` → 经 dataList 转 ts，见
 *   {@link readVisibleRangeTs}）/ `jump`（L1/L2 按钮，见 {@link roundTripWindow}/{@link centeredWindow}）
 *   / `reset`（全览 + 历史回退，见 {@link pushHistory}/{@link popHistory}）。
 * - **回声抑制 + 防乱序**（§9.3）：`rev` 单调，落后响应丢弃（{@link isStaleResponse}）；
 *   程序化写窗由 `KlineChart` 的 `programmaticScroll` + 本文件的 command 通道承担（写窗**不**经
 *   `onVisibleRangeChange` 回写）。
 * - **节流**（§9.7）：{@link throttleLatest}（约 200ms，**以最后一次为准**）。
 * - **跳转断言**（D4 / F18 零容忍）：{@link applyWindowOps} 读回 `getBarSpace()` 与
 *   `getVisibleRange()` 显式判定；`setBarSpace` 越界被引擎静默 return 时必须**报错**，禁止静默无反应。
 * - **窗口生命周期**（§9.6）：历史栈上限 {@link WINDOW_HISTORY_MAX} = 20 步。
 */

/** 窗口写入者（观测性：`rev` 之外还要能回答「这一窗是谁写的」，ADR-028 §3.4）。 */
export type WindowSource = 'kline' | 'jump' | 'reset';

/**
 * 页面级共享窗口（ADR-028 D2）。时间戳单位 = **Unix 秒**（与 `/curve` 点 ts、`RoundTrip.open_ts` 同源）。
 *
 * ADR-028 D2.1 第 3 条：窗口**同时**携带**索引范围**与 **ts 范围**（两者必须同源同步）：
 * - `from_ts`/`to_ts` → `/curve` 取数窗口；
 * - `from_idx`/`to_idx` → 曲线 x 映射的 bar 索引空间（由 K 线真身 `getVisibleRange()` 取整而来）。
 */
export interface ResultWindowState {
  from_ts: number;
  to_ts: number;
  /** 窗口内 bar 根数（= 跳转 barSpace 的分母）。 */
  span_bars: number;
  source: WindowSource;
  /** 单调递增序号（防乱序覆盖；请求/响应都带它）。 */
  rev: number;
  /** 引擎实际可见的**首/末 bar 索引**（`getVisibleRange()` 的 `from`/`to` 取整夹取；不可得 ⇒ null）。 */
  from_idx: number | null;
  to_idx: number | null;
}

/** 历史栈上限（02-spec §9.6：上限 20 步）。 */
export const WINDOW_HISTORY_MAX = 20;
/** 窗口请求共享节流（02-spec §9.7：约 200ms，以最后一次为准）。 */
export const WINDOW_THROTTLE_MS = 200;
/** 曲线 x 映射的 ts→bar 配对容差下限（秒；周期更粗时取 `barSeconds/2`）。 */
export const CURVE_TS_TOLERANCE_MIN_SEC = 60;
/** L2 `[跳转]` 默认窗口根数（ADR-028 D4：该笔成交 bar **居中** 120 根，可配）。 */
export const DEFAULT_L2_JUMP_SPAN_BARS = 120;
/** L1 `[跳转]` 回合区间两侧 buffer（根）。 */
export const DEFAULT_JUMP_BUFFER_BARS = 2;

/** 回测周期档位 → 秒（前端镜像；用于把「根数」换算成 ts 区间，避免引入第二个周期事实源之外的口径）。 */
const PERIOD_SECONDS: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  D1: 86400,
};

/** 周期档位 → 单根 bar 秒数（未知档位回退 D1 = 86400，**显式**而非 0，避免窗口塌缩成点）。 */
export function periodSeconds(period: string | null | undefined): number {
  return PERIOD_SECONDS[period ?? ''] ?? 86400;
}

export function makeWindow(
  source: WindowSource,
  from_ts: number,
  to_ts: number,
  span_bars: number,
  rev: number,
  idx?: { from_idx: number | null; to_idx: number | null },
): ResultWindowState {
  return {
    from_ts,
    to_ts: Math.max(to_ts, from_ts),
    span_bars: Math.max(1, Math.round(span_bars) || 1),
    source,
    rev,
    from_idx: idx?.from_idx ?? null,
    to_idx: idx?.to_idx ?? null,
  };
}

/** 窗口中点（ts）。 */
export function windowCenter(w: ResultWindowState): number {
  return (w.from_ts + w.to_ts) / 2;
}

/** 两个窗口是否表示同一区间（rev/source 不参与 ⇒ 「无变化不重取」判据）。 */
export function isSameWindow(
  a: ResultWindowState | null,
  b: ResultWindowState | null,
): boolean {
  if (!a || !b) return a === b;
  return a.from_ts === b.from_ts && a.to_ts === b.to_ts && a.span_bars === b.span_bars;
}

// ─────────────────── ADR-028 D2.1 / D2.3：曲线 x 定义域与绘图区几何（纯函数层） ───────────────────

/** K 线真身绘图区几何（同一渲染帧读出；`onVisibleRangeChange` 负载的几何子集）。 */
export interface KlinePlotGeom {
  /** **K 线所绘制的同一 bar 序列**（可见 bar 的 ts，Unix 秒，升序）。 */
  bar_ts: readonly number[];
  /** 每槽像素宽（`getBarSpace().bar`；不可得 ⇒ null）。 */
  bar_space: number | null;
  /** 窗口首根 bar 的绘图区局部像素 x（`convertToPixel`；不可得 ⇒ null）。 */
  x_from_px: number | null;
  /** K 线容器宽（px，`getSize().width`；不可得 ⇒ null）。 */
  chart_width_px: number | null;
  /** 可见首/末 bar 在图表 dataList 中的索引（ADR-028 §2.10 D10「活体披露」；不可得 ⇒ null）。 */
  from_idx?: number | null;
  to_idx?: number | null;
}

/**
 * 曲线 x 定义域**来源**（观测性 + 披露口径，ADR-028 D2.1）：
 * - `kline`：K 线**所绘制的同一 bar 序列**（主路，含共用绘图区几何）；
 * - `per_bar`：**降级**——K 线 bar 序列不可得，回退 run 的 per_bar ts 序列（缺口折叠同源，但与 K 线蜡烛
 *   位置不保证对齐：K 线此刻无 bar）；
 * - `ts`：**降级**——纯 ts 线性（最终兜底；与 K 线可能存在缺口偏差）。
 */
export type CurveXSource = 'kline' | 'per_bar' | 'ts';

/** 曲线 x 构建结果（随取数**原子提交**，见 `useRunSeries`）。 */
export interface CurveXBuild {
  /** x 定义域（`index` = 主路 bar 索引空间；`ts` = **降级** ts 线性；null = 尚无定义域）。 */
  xDomain: CurveXDomain | null;
  /** svg `viewBox` 的 x 起点/宽度（D2.3-4 共用绘图区几何；null = 曲线独立几何）。 */
  plot: { x0: number; w: number } | null;
  /** **降级**标记（`per_bar`/`ts`）⇒ UI 必须显式标注（ADR-028 D2.1 第 4 条，禁静默）。 */
  degraded: boolean;
  /** 定义域来源。 */
  source: CurveXSource | null;
  /** 定义域槽位数（= bar 序列长度；观测/断言用）。 */
  slots: number;
}

/**
 * 由共享窗口 + K 线真身几何构造曲线 x 定义域（ADR-028 D2.1/D2.3-4）：
 * - **主路**：bar 序列可得 ⇒ `mode:'index'`（ts→bar 索引查表 + 索引线性映射）+ 共用绘图区几何；
 * - **降级**：bar 序列不可得 ⇒ `mode:'ts'`（ts 线性，显式标注降级）；
 * - 两者皆不可得（无窗口、无全区间）⇒ `xDomain = null`（D2.2：禁止自造定义域）。
 */
export function buildCurveX(args: {
  geom: KlinePlotGeom | null;
  /** **降级**用：run 的 per_bar ts 序列（Unix 秒，升序；`/bars?kind=per_bar` 的已加载行）。 */
  perBarTs?: readonly number[] | null;
  from_ts: number | null;
  to_ts: number | null;
  barSeconds: number;
  width?: number;
  pad?: number;
}): CurveXBuild {
  const width = args.width ?? 1000;
  const pad = args.pad ?? 8;
  const barTs = args.geom?.bar_ts ?? [];
  if (barTs.length >= 2) {
    const g = args.geom!;
    const plot =
      g.bar_space != null && g.x_from_px != null && g.chart_width_px != null
        ? curvePlotViewBox(
            { barSpacePx: g.bar_space, xFromPx: g.x_from_px, chartWidthPx: g.chart_width_px, slots: barTs.length },
            width,
            pad,
          )
        : null;
    return {
      xDomain: { mode: 'index', barTs, toleranceSec: Math.max(60, Math.round(args.barSeconds / 2)) },
      plot,
      degraded: false,
      source: 'kline',
      slots: barTs.length,
    };
  }
  // 降级 ①：回退 run 的 per_bar ts 序列（窗口内子集；缺口折叠口径与曲线数据同源）
  const lo = args.from_ts;
  const hi = args.to_ts;
  const perBar = (args.perBarTs ?? []).filter((t) => (lo == null || t >= lo) && (hi == null || t <= hi));
  if (perBar.length >= 2) {
    return {
      xDomain: { mode: 'index', barTs: perBar, toleranceSec: Math.max(60, Math.round(args.barSeconds / 2)) },
      plot: null,
      degraded: true,
      source: 'per_bar',
      slots: perBar.length,
    };
  }
  // 降级 ②：纯 ts 线性（最终兜底）
  if (args.from_ts != null && args.to_ts != null && args.to_ts > args.from_ts) {
    return {
      xDomain: { mode: 'ts', from_ts: args.from_ts, to_ts: args.to_ts },
      plot: null,
      degraded: true,
      source: 'ts',
      slots: 0,
    };
  }
  return { xDomain: null, plot: null, degraded: false, source: null, slots: 0 };
}

/**
 * **程序化写窗钳位/校准披露**（ADR-028 D2.3-1 ② / §2.10.1 **裁决 1**：申请未被逐值兑现必须显式披露）。
 *
 * 判据（任一成立即披露）：
 *  - 端点差 > 1 根 bar（`barSeconds`）；
 *  - 根数差 > 1 根；
 *  - **barSpace 被校准**（`requested_bar_space` ≠ `observed_bar_space`，如 L1 初选 12 → 生效 11）。
 *
 * 为什么把 barSpace 校准也纳入：§2.10.1 把 `ok` 的对照基准改为**生效值** ⇒ 校准**不再**由 `data-ok` 承载，
 * 若本披露不覆盖「区间逐值相同而 barScore 被校准」这一情形，「申请未被逐值兑现」就会**静默**。
 * 反过来，披露文案必须与「写窗后被改写」（`data-live-reasons`）**分属两类**：本披露只谈「申请 vs 实质」。
 */
export function clampDisclosure(
  cmd: { from_ts: number; to_ts: number; span_bars: number } | null,
  observed: { from_ts: number; to_ts: number; from_idx: number; to_idx: number } | null,
  barSeconds: number,
  /** barSpace 申请/生效两侧读数（可缺：缺则只按端点/根数判定）。 */
  args_bars?: { requested: number | null; observed: number | null },
): string | null {
  if (!cmd || !observed) return null;
  const tol = Math.max(1, barSeconds);
  const observedBars = observed.to_idx - observed.from_idx + 1;
  const endDiff = Math.abs(observed.from_ts - cmd.from_ts) > tol || Math.abs(observed.to_ts - cmd.to_ts) > tol;
  const spanDiff = Math.abs(observedBars - cmd.span_bars) > 1;
  const bsDiff =
    args_bars != null &&
    args_bars.requested != null &&
    args_bars.observed != null &&
    args_bars.requested !== args_bars.observed;
  if (!endDiff && !spanDiff && !bsDiff) return null;
  const bsNote = bsDiff ? `；barSpace 申请 ${args_bars!.requested} → 生效 ${args_bars!.observed}` : '';
  return `窗口被钳位/校准（申请未被逐值兑现：引擎实测 ≠ 请求）：请求 [${cmd.from_ts}, ${cmd.to_ts}]（${cmd.span_bars} 根）⇒ 实际 [${observed.from_ts}, ${observed.to_ts}]（${observedBars} 根）${bsNote}`;
}

/**
 * **「尽可能全」的物理上限披露**（ADR-028 D2.3-3）：klinecharts 单图上限（`dataList` 页大小 + `barSpace ≥ 1`
 * + 面板宽度）⇒ 全览物理上只能显示一部分。禁把「实际可见根数」当成「全部根数」。
 * 仅在根数不足（`visible < total`）时给出文案；否则 null。
 */
export function capDisclosure(
  visibleBars: number | null,
  totalBars: number,
  label = '全览',
): string | null {
  if (visibleBars == null || !Number.isFinite(visibleBars) || totalBars <= 0) return null;
  if (visibleBars >= totalBars) return null;
  const pct = ((visibleBars / totalBars) * 100).toFixed(1);
  return `${label}：显示 ${visibleBars} / 共 ${totalBars} 根（${pct}%；受渲染上限约束：barSpace ≥ 1 + 面板宽度 + dataList 页大小）`;
}

/** 曲线取数请求（`useResultWindow` → `useRunSeries`）：取数窗口 + x 定义域**同源同 rev**，禁止分别演化。 */
export interface CurveDomainRequest {
  /** 单调 rev（窗口变化 / 回到全区间 都递增）——落后响应按此丢弃。 */
  rev: number;
  /** `/curve` 取数窗口；`null` = 不传窗口参数（全区间）。 */
  window: { from_ts: number; to_ts: number } | null;
  /** x 定义域（主路 bar 索引 / 降级 ts 线性 / null = 尚无）。 */
  xDomain: CurveXDomain | null;
  /** 共用绘图区几何（viewBox x 起点/宽度；null = 曲线独立几何）。 */
  plot: { x0: number; w: number } | null;
  /** **降级**标记（`per_bar`/`ts`）⇒ UI 必须标注。 */
  degraded: boolean;
  /** 定义域来源（`kline` / `per_bar` / `ts` / null）。 */
  source: CurveXSource | null;
  /** 定义域槽位数。 */
  slots: number;
}

/** 由 `onVisibleRangeChange` 负载取 K 线真身几何（可选字段缺失 ⇒ 相应字段为 null，不编造）。 */
export function geomFromRange(r: {
  bar_ts?: readonly number[];
  bar_space?: number;
  x_from_px?: number;
  chart_width_px?: number;
  from_idx?: number;
  to_idx?: number;
}): KlinePlotGeom | null {
  const barTs = r.bar_ts ?? [];
  if (barTs.length === 0) return null;
  return {
    bar_ts: barTs,
    bar_space: r.bar_space ?? null,
    x_from_px: r.x_from_px ?? null,
    chart_width_px: r.chart_width_px ?? null,
    from_idx: r.from_idx ?? null,
    to_idx: r.to_idx ?? null,
  };
}

/** 几何是否等价（高频滚动事件下避免无谓 state 更新/re-render）。 */
export function sameGeom(a: KlinePlotGeom | null, b: KlinePlotGeom | null): boolean {
  if (!a || !b) return a === b;
  if (a.bar_space !== b.bar_space || a.x_from_px !== b.x_from_px || a.chart_width_px !== b.chart_width_px) {
    return false;
  }
  if ((a.from_idx ?? null) !== (b.from_idx ?? null) || (a.to_idx ?? null) !== (b.to_idx ?? null)) return false;
  if (a.bar_ts.length !== b.bar_ts.length) return false;
  if (a.bar_ts.length === 0) return true;
  return a.bar_ts[0] === b.bar_ts[0] && a.bar_ts[a.bar_ts.length - 1] === b.bar_ts[b.bar_ts.length - 1];
}

/**
 * **活体真身窗口**（ADR-028 §2.10 D10 决策 3）：K 线**当前**实测可见 bar 区间与引擎读回值。
 * 事实源 = `onVisibleRangeChange`（`getVisibleRange()`/`getBarSpace()` 真身读数），不是页面请求态。
 */
export interface LiveWindowView {
  from_ts: number;
  to_ts: number;
  /** 可见 bar 根数（= K 线实际绘制的 bar 数）。 */
  bars: number;
  from_idx: number | null;
  to_idx: number | null;
  bar_space: number | null;
}

/** 由真身几何构造活体窗口（几何缺失/空 bar 序列 ⇒ null：**不猜**）。 */
export function liveWindowFromGeom(g: KlinePlotGeom | null): LiveWindowView | null {
  if (!g || g.bar_ts.length === 0) return null;
  return {
    from_ts: g.bar_ts[0]!,
    to_ts: g.bar_ts[g.bar_ts.length - 1]!,
    bars: g.bar_ts.length,
    from_idx: g.from_idx ?? null,
    to_idx: g.to_idx ?? null,
    bar_space: g.bar_space ?? null,
  };
}

/** 活体一致性判定结果（`reasons` = 可读原因；供披露与红点定位）。 */
export interface LiveConsistency {
  ok: boolean;
  reasons: string[];
}

/**
 * **活体一致性**（ADR-028 §2.10 D10 决策 3 + §2.10.1 **裁决 1**）：`ok` 必须包含「**当前**一致」，不得只看一次性回执。
 *
 * 程序化窗口态（`window.source ∈ {jump, reset}`）判据：
 *  ① 申请回执成功（`setBarSpace` 未被引擎静默吞掉）；
 *  ② 回执属于**当前**请求（`rev` 一致 ⇒ 禁过期快照）；
 *  ③ **真身 == 生效值**（`live.bar_space == applied.observed_bar_space`）——**不是**对照 `requested`：
 *     引擎校准（L1 初选 12 → 生效 11、全览 10 → 9）与不可达夹取属「申请未被逐值兑现」，
 *     由 `wb-window-clamped` 独立披露；若拿它们判 `ok=false`，真实的「写窗后被改写」信号会被噪声淹没。
 *  ④ 可见域 == **写回后的**窗口域（两端各 ±1 根 bar 量化容差）。
 *
 * 被改写的两类信号（reason 文案**必须**读作「被改写」，与「校准/夹取」两类分开，见裁决 1）：
 *  - `bar-space-rewritten:` 真身 barSpace ≠ 生效 barSpace；
 *  - `domain-drift:` 真身可见域偏离写回窗口域（> ±1 根）。
 *
 * 非程序化态（无窗口 / `kline` 用户手势源）无「申请」对照，只要求真身可读（真身不可读 ⇒ 一律不绿）。
 */
export function liveConsistency(args: {
  applied: {
    ok: boolean;
    rev: number;
    /** **申请初选**（仅供观测/证据；**不**参与 `ok` 判定 — §2.10.1 裁决 1）。 */
    requested_bar_space: number | null;
    /** **生效值**（`applied.observed.bar_space`；§2.10.1 裁决 1 的对照基准）。 */
    observed_bar_space: number | null;
    error: string | null;
  } | null;
  live: LiveWindowView | null;
  window: ResultWindowState | null;
  expectRev: number;
  barSeconds: number;
}): LiveConsistency {
  const { applied, live, window: win, expectRev, barSeconds } = args;
  const reasons: string[] = [];
  if (!live) reasons.push('live-unreadable: 真身可见域不可读（无 onVisibleRangeChange 读数）');
  const programmatic = win != null && win.source !== 'kline';
  if (programmatic) {
    if (!applied) reasons.push('no-receipt: 无写窗回执');
    else {
      if (!applied.ok) reasons.push(`receipt-failed: ${applied.error ?? '写窗失败'}`);
      else if (applied.rev !== expectRev) {
        reasons.push(`receipt-stale: 回执 rev ${applied.rev} ≠ 当前请求 rev ${expectRev}`);
      }
      if (
        applied.ok &&
        live &&
        applied.observed_bar_space != null &&
        live.bar_space !== applied.observed_bar_space
      ) {
        reasons.push(
          `bar-space-rewritten: 真身 ${live.bar_space} ≠ 生效 ${applied.observed_bar_space}（写窗后被改写，非申请未兑现）`,
        );
      }
    }
  }
  if (live && win) {
    const tol = Math.max(1, barSeconds);
    if (Math.abs(live.from_ts - win.from_ts) > tol || Math.abs(live.to_ts - win.to_ts) > tol) {
      reasons.push(
        `domain-drift: 真身可见域 [${live.from_ts}, ${live.to_ts}] ≠ 写回窗口域 [${win.from_ts}, ${win.to_ts}]（> ±1 根：写窗后被改写/漂移）`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * **曲线取数窗口**（ADR-028 §2.10 D10 决策 4）：必须与 x 定义域**同源**。
 * 主路（x 域取 K 线 bar 序列）⇒ 取数窗口 = **真身可见 ts 区间**；降级（无真身几何）⇒ 回退声明窗口。
 * 理由：取数窗口取「页面声明窗口」而 x 域取「真身可见切片」⇒ 逐点剔除（实测剔除率最高 80.5%）。
 */
export function curveFetchWindow(args: {
  source: CurveXSource | null;
  live: LiveWindowView | null;
  window: { from_ts: number; to_ts: number } | null;
}): { from_ts: number; to_ts: number } | null {
  if (args.source === 'kline' && args.live) return { from_ts: args.live.from_ts, to_ts: args.live.to_ts };
  return args.window;
}

/**
 * **真值写回**（ADR-028 §2.10 D10 决策 2）：程序化写窗被夹取（目标不可达）时，以**实测可达区间**
 * 对齐窗口状态机（`source`/`rev` 保持申请者身份）；「全览」请求（`cur === null`）⇒ 建立 `reset` 窗口。
 *
 * 返回 `null` ⇒ 无需变更（幂等：不触发多余 re-render / 取数）。
 */
export function writeBackWindow(args: {
  cur: ResultWindowState | null;
  observed: { from_ts: number; to_ts: number; from_idx: number; to_idx: number } | null;
  rev: number;
  source?: WindowSource;
}): ResultWindowState | null {
  const { cur, observed, rev } = args;
  if (!observed) return null;
  const span = Math.max(1, observed.to_idx - observed.from_idx + 1);
  if (cur == null) {
    return makeWindow(args.source ?? 'reset', observed.from_ts, observed.to_ts, span, rev, {
      from_idx: observed.from_idx,
      to_idx: observed.to_idx,
    });
  }
  if (
    cur.from_ts === observed.from_ts &&
    cur.to_ts === observed.to_ts &&
    cur.span_bars === span &&
    cur.from_idx === observed.from_idx &&
    cur.to_idx === observed.to_idx
  ) {
    return null;
  }
  return {
    ...cur,
    from_ts: observed.from_ts,
    to_ts: observed.to_ts,
    span_bars: span,
    from_idx: observed.from_idx,
    to_idx: observed.to_idx,
  };
}

export function containsTs(w: ResultWindowState, ts: number): boolean {
  return ts >= w.from_ts && ts <= w.to_ts;
}

/** 落后响应丢弃判据（02-spec §9.3：`rev` 单调，落后者**丢弃**，不得回写）。 */
export function isStaleResponse(responseRev: number, latestIssuedRev: number): boolean {
  return responseRev < latestIssuedRev;
}

/** 历史栈压入（上限 {@link WINDOW_HISTORY_MAX}；超出丢**最旧**，保留最近可回退步数）。 */
export function pushHistory(
  stack: readonly ResultWindowState[],
  w: ResultWindowState,
): ResultWindowState[] {
  return [...stack, w].slice(-WINDOW_HISTORY_MAX);
}

/** 历史回退（空栈 ⇒ `prev = null`，调用方须显式处理「无可回退」而不是静默 no-op）。 */
export function popHistory(stack: readonly ResultWindowState[]): {
  stack: ResultWindowState[];
  prev: ResultWindowState | null;
} {
  if (stack.length === 0) return { stack: [], prev: null };
  return { stack: stack.slice(0, -1), prev: stack[stack.length - 1] ?? null };
}

/** L1 `[跳转]`：回合区间 `[open_ts, close_ts]` ± buffer 根（ADR-028 D4）。
 *  `spanBarsOverride`：由**回合 bar 索引差**给出的真实根数（稀疏数据下 `(ts 差)/step` 会高估，
 *  见 `useResultWindow.jumpTo`）；不给则保持既有 ts 反算口径（向后兼容）。 */
export function roundTripWindow(
  openTs: number,
  closeTs: number,
  barSeconds: number,
  rev: number,
  bufferBars: number = DEFAULT_JUMP_BUFFER_BARS,
  spanBarsOverride?: number,
): ResultWindowState {
  const step = Math.max(1, barSeconds);
  const from = openTs - bufferBars * step;
  const to = Math.max(closeTs, openTs) + bufferBars * step;
  const span = spanBarsOverride ?? Math.round((to - from) / step) + 1;
  return makeWindow('jump', from, to, span, rev);
}

/** L2 `[跳转]`：该笔成交 bar **居中**、默认 120 根（D4）。 */
export function centeredWindow(
  centerTs: number,
  barSeconds: number,
  rev: number,
  spanBars: number = DEFAULT_L2_JUMP_SPAN_BARS,
): ResultWindowState {
  const step = Math.max(1, barSeconds);
  const span = Math.max(1, Math.round(spanBars) || 1);
  const half = Math.floor((span - 1) / 2);
  const from = centerTs - half * step;
  const to = from + (span - 1) * step;
  return makeWindow('jump', from, to, span, rev);
}

/**
 * 约 `delayMs` 的**尾沿节流**：窗口内的多次调用只保证「立即一次 + 尾沿最后一次」，
 * 与 02-spec §9.7「共享 ~200ms 节流，以最后一次为准」一致。
 * 返回的 `flush()` 立即提交挂起值（卸载/跳转等需要确定性提交时用）。
 */
export function throttleLatest<T>(
  fn: (v: T) => void,
  delayMs: number = WINDOW_THROTTLE_MS,
): { call: (v: T) => void; flush: () => void; cancel: () => void } {
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { v: T } | null = null;
  const now = () => Date.now();
  const fire = (v: T) => {
    lastAt = now();
    fn(v);
  };
  return {
    call: (v: T) => {
      const t = now();
      if (t - lastAt >= delayMs) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pending = null;
        fire(v);
        return;
      }
      pending = { v };
      if (!timer) {
        const wait = Math.max(0, delayMs - (t - lastAt));
        timer = setTimeout(() => {
          timer = null;
          const p = pending;
          pending = null;
          if (p) fire(p.v);
        }, wait);
      }
    },
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const p = pending;
      pending = null;
      if (p) fire(p.v);
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}


// ── K 线实例侧的窗口读/写原语（图表层实现，workbench 侧再导出以保持依赖方向 workbench → dashboard） ──

import { curvePlotViewBox, type CurveXDomain } from '@/features/backtest/chartUtils';

export {
  applyWindowOps,
  readVisibleRangeTs,
  type KlineWindowOps,
  type VisibleRangeTs,
  type WindowApplyObserved,
  type WindowApplyResult,
  type WindowCommand,
} from '@/features/dashboard/klineWindowOps';
