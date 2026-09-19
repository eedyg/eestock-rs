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

/** 页面级共享窗口（ADR-028 D2）。时间戳单位 = **Unix 秒**（与 `/curve` 点 ts、`RoundTrip.open_ts` 同源）。 */
export interface ResultWindowState {
  from_ts: number;
  to_ts: number;
  /** 窗口内 bar 根数（= 跳转 barSpace 的分母）。 */
  span_bars: number;
  source: WindowSource;
  /** 单调递增序号（防乱序覆盖；请求/响应都带它）。 */
  rev: number;
}

/** 历史栈上限（02-spec §9.6：上限 20 步）。 */
export const WINDOW_HISTORY_MAX = 20;
/** 窗口请求共享节流（02-spec §9.7：约 200ms，以最后一次为准）。 */
export const WINDOW_THROTTLE_MS = 200;
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
): ResultWindowState {
  return {
    from_ts,
    to_ts: Math.max(to_ts, from_ts),
    span_bars: Math.max(1, Math.round(span_bars) || 1),
    source,
    rev,
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

export {
  applyWindowOps,
  readVisibleRangeTs,
  type KlineWindowOps,
  type VisibleRangeTs,
  type WindowApplyObserved,
  type WindowApplyResult,
  type WindowCommand,
} from '@/features/dashboard/klineWindowOps';
