/**
 * 红测试（阶段 1，Red）—— T-R3「每分钟兜底增量（与 WS 复用同一 applyRealtime 合并）」。
 *
 * 本文件位置：`web/src/features/dashboard/feedRealtimePoll.test.ts`
 * 权威依据：
 *  - 诊断：`tester/report/055_kline_realtime_bar_append_diagnosis.md` §0 R3（推送只有 bar 边界、无 tick）、
 *    §6(b)「用户要求的每分钟兜底增量更新稳妥口径」、§6(c) 副作用面
 *  - 设计：`tester/design/055_realtime_append_red_test_design.md` §1 T-R3、§2 桩策略、§3 覆盖目标
 *  - 任务口径（架构师裁决，逐条对应本文件用例）：
 *    ② 每分钟兜底与 WS 复用同一 applyRealtime、按 ts 唯一键合并（更晚 append / 同 ts 覆盖 / 更早忽略）；
 *    ③ 非交易时段跳过分钟轮询；
 *    ④ 失败指数退避 1→2→4→8→60s、成功复位、不弹错。
 *
 * 钉死的判据（当前实现必红：feed 完全没有兜底轮询）：
 *  - T-R3-a 交易时段 + 页面可见：每 60s 一次 `GET /api/kline`，**取最新窗口**（limit 3~5、无 `before` 游标），
 *    与 code/period 一致；
 *  - T-R3-a2 合并语义 = 同一 `applyRealtime`：更晚 ts → append；同 ts → 覆盖（含 OHLC 变化）；
 *    更早 ts → 忽略（不得插入/不得 emit）；每一根变化都经 `feed.onRealtime` 下发（与 WS 同一通路）；
 *  - T-R3-b 与 WS **不重复写入**：WS 已入的 ts 再由兜底返回同一 OHLC ⇒ bars 不重复、不产生第二次下发
 *    （spy 计数）；同 ts 但 OHLC 变化 ⇒ 覆盖 + 恰好一次下发；
 *  - T-R3-d 非交易时段（午间休市 / 周日）跳过；
 *  - T-R3-d2 页面不可见时暂停兜底，回到可见后恢复；
 *  - T-R3-e 失败退避 1→2→4→8→60s（60s 封顶）、成功复位为常规 60s、再次失败从 1s 重新起步；
 *    失败期间 bars 不变、不抛错（401/500 不得打断既有渲染）。
 *
 * seam：`KlineDataFeed`（既有构造签名 `{ api, ws, code, period, viewportBars }`）。不要求新增公开方法：
 * 轮询由 feed 自身在加载完成后按交易时段/可见性调度，合并走既有 `applyRealtime`。
 * **调度契约**：轮询必须是「自 re-arm」定时器——退避期间不得再叠加固定的 60s interval 触发
 *  （否则 T-R3-e 的边界计数不符）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KlineDataFeed } from './feed';
import type { ApiClient, KlineQuery } from '@/api/client';
import type { Bar } from '@/api/types';
import type { WsClient, WsMessage } from '@/ws/WsClient';

const CODE = '518880';
const PERIOD = '1m' as const;
const T = (mm: number) => `2026-09-14T01:${String(mm).padStart(2, '0')}:00Z`;
/** 交易日（周一 2026-09-14 10:00 北京 = 02:00Z，trading） */
const TRADING = new Date('2026-09-14T02:00:00Z');
/** 午间休市（周一 12:30 北京） */
const LUNCH = new Date('2026-09-14T04:30:00Z');
/** 周末（周日） */
const SUNDAY = new Date('2026-09-13T02:00:00Z');

function mkBar(ts: string, close = 1): Bar {
  return { ts, open: close, high: close + 0.01, low: close - 0.01, close, volume: 100, amount: 100 };
}

const LOADED: Bar[] = [mkBar(T(50), 1.0), mkBar(T(51), 1.1), mkBar(T(52), 1.2)];

interface Ctx {
  feed: KlineDataFeed;
  getKline: ReturnType<typeof vi.fn>;
  dispatchBar: (b: Bar) => void;
}

/** 建 feed（初始数据 = LOADED）+ 假 api（按调用序号响应：第 1 次 = 初始加载，其后 = 兜底轮询）
 *  + 假 ws（可注入 bar 帧） */
function makeCtx(
  pollResponder: (n: number, q: KlineQuery) => Promise<Bar[]> = async () => [],
): Ctx {
  let n = 0;
  const getKline = vi.fn(async (q: KlineQuery) => {
    n += 1;
    return pollResponder(n, q);
  });
  let handler: ((msg: WsMessage) => void) | null = null;
  const ws = {
    subscribe: vi.fn((_topic: string, h: (msg: WsMessage) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    }),
  } as unknown as WsClient;
  const feed = new KlineDataFeed({
    api: { getKline } as unknown as ApiClient,
    ws,
    code: CODE,
    period: PERIOD,
    viewportBars: 5,
  });
  return {
    feed,
    getKline,
    dispatchBar: (b: Bar) => handler?.({ type: 'bar', code: CODE, period: PERIOD, bar: b }),
  };
}

/** 队列式兜底响应（第 1 次 = 初始加载 LOADED；其后每 60s 取下一个；队列空返回 []） */
function queueResponder(queue: Bar[][]) {
  return async (n: number): Promise<Bar[]> => (n === 1 ? LOADED : (queue.shift() ?? []));
}

describe('T-R3 每分钟兜底增量（交易时段 / 可见时每 60s，取最新窗口）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-R3-a 每 60s 恰一次：GET /api/kline 最新窗口（limit 3~5、无 before 游标）', async () => {
    const ctx = makeCtx(queueResponder([[mkBar(T(53), 1.3)]]));
    await ctx.feed.loadInitial();
    expect(ctx.getKline).toHaveBeenCalledTimes(1); // 初始加载

    await vi.advanceTimersByTimeAsync(59_999);
    expect(ctx.getKline).toHaveBeenCalledTimes(1); // 未到 60s 不轮询

    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.getKline).toHaveBeenCalledTimes(2);
    const q = ctx.getKline.mock.calls[1]![0] as KlineQuery;
    expect(q.code).toBe(CODE);
    expect(q.period).toBe(PERIOD);
    expect(q.limit).toBeGreaterThanOrEqual(3); // 覆盖「跳标签/偶发缺行」的 1–2 根缺口
    expect(q.limit).toBeLessThanOrEqual(5);
    expect(q.before).toBeUndefined(); // 兜底取最新（不是向前翻页）

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.getKline).toHaveBeenCalledTimes(3); // 每 60s 一次
    ctx.feed.dispose();
  });

  it('T-R3-a2 合并 = 同一 applyRealtime：更晚 append / 同 ts 覆盖 / 更早忽略（且经同一实时通路下发）', async () => {
    const ctx = makeCtx(
      queueResponder([
        [
          mkBar(T(49), 9.9), // 更早 ts（早于已加载最末 T(52)）→ 必须忽略
          mkBar(T(52), 1.25), // 同 ts、OHLC 变化 → 覆盖
          mkBar(T(53), 1.3), // 更晚 → append
        ],
      ]),
    );
    await ctx.feed.loadInitial();
    const rt: Bar[] = [];
    ctx.feed.onRealtime((b) => rt.push(b));

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.feed.bars.map((b) => b.ts)).toEqual([T(50), T(51), T(52), T(53)]);
    expect(ctx.feed.bars).toHaveLength(4); // 更早的 T(49) 未插入
    expect(ctx.feed.bars.at(-1)!.close).toBe(1.3);
    expect(ctx.feed.bars.find((b) => b.ts === T(52))!.close).toBe(1.25); // 同 ts 覆盖
    expect(rt.map((b) => b.ts)).toEqual([T(52), T(53)]); // 覆盖 + append 各一次；更早忽略 → 不下发
    ctx.feed.dispose();
  });

  it('T-R3-b 与 WS 不重复写入：同 ts 同 OHLC 的兜底结果不产生第二次写入（spy 计数）', async () => {
    const ctx = makeCtx(
      queueResponder([
        [mkBar(T(53), 1.5)], // 与 WS 已经入的 bar 完全一致
        [mkBar(T(53), 1.7)], // 同 ts 但 OHLC 变化 → 覆盖
      ]),
    );
    await ctx.feed.loadInitial();
    const rt = vi.fn();
    ctx.feed.onRealtime(rt);

    // WS 先入 T(53)
    ctx.dispatchBar(mkBar(T(53), 1.5));
    expect(ctx.feed.bars).toHaveLength(4);
    expect(rt).toHaveBeenCalledTimes(1);

    // 兜底返回同一 ts 同一 OHLC → 不得重复写入、不得再下发一次
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.feed.bars).toHaveLength(4);
    expect(ctx.feed.bars.filter((b) => b.ts === T(53))).toHaveLength(1);
    expect(rt).toHaveBeenCalledTimes(1);

    // 兜底返回同一 ts 但 OHLC 变化 → 覆盖 + 恰好一次下发
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.feed.bars).toHaveLength(4);
    expect(ctx.feed.bars.at(-1)!.close).toBe(1.7);
    expect(rt).toHaveBeenCalledTimes(2);
    ctx.feed.dispose();
  });

  it('T-R3-d 非交易时段跳过兜底（午间休市 / 周末均不得轮询）', async () => {
    for (const t of [LUNCH, SUNDAY]) {
      vi.setSystemTime(t);
      const ctx = makeCtx();
      await ctx.feed.loadInitial();
      expect(ctx.getKline).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(ctx.getKline).toHaveBeenCalledTimes(1); // 非交易时段：跳过（0 次兜底）
      ctx.feed.dispose();
    }
  });

  it('T-R3-d2 页面不可见时暂停兜底，回到可见后恢复', async () => {
    let vis: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
    try {
      const ctx = makeCtx();
      await ctx.feed.loadInitial();
      expect(ctx.getKline).toHaveBeenCalledTimes(1);

      vis = 'hidden';
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ctx.getKline).toHaveBeenCalledTimes(1); // 后台标签页不轮询

      vis = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ctx.getKline.mock.calls.length).toBeGreaterThan(1); // 恢复轮询
      ctx.feed.dispose();
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });
});

describe('T-R3-e 兜底失败退避 1→2→4→8→60s（成功复位、不弹错）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-R3-e1 连续失败按 1/2/4/8/60s 退避（60s 封顶），不改变既有 bars、不抛错', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    let n = 0;
    const getKline = vi.fn(async (q: KlineQuery) => {
      n += 1;
      void q;
      if (n === 1) return LOADED; // 初始加载成功
      if (mode === 'fail') throw new Error('poll 500');
      return [mkBar(T(53), 1.9)];
    });
    const ws = { subscribe: vi.fn(() => () => {}) } as unknown as WsClient;
    const feed = new KlineDataFeed({
      api: { getKline } as unknown as ApiClient,
      ws,
      code: CODE,
      period: PERIOD,
      viewportBars: 5,
    });
    await feed.loadInitial();
    expect(getKline).toHaveBeenCalledTimes(1);

    const calls = () => getKline.mock.calls.length;
    // 常规 60s 触发第 1 次兜底 → 失败
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    // 退避 1s
    await vi.advanceTimersByTimeAsync(999);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(3);
    // 退避 2s
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(4);
    // 退避 4s
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls()).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(5);
    // 退避 8s
    await vi.advanceTimersByTimeAsync(7_999);
    expect(calls()).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(6);
    // 退避 60s
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls()).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(7);
    // 封顶 60s（不再增长）
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls()).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(8);

    // 失败期间既有数据不变（不弹错、不清空）
    expect(feed.bars.map((b) => b.ts)).toEqual(LOADED.map((b) => b.ts));

    // 第 9 次：常规 60s 节奏 + 成功 → 复位
    mode = 'ok';
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls()).toBe(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(9);
    expect(feed.bars.map((b) => b.ts)).toEqual([T(50), T(51), T(52), T(53)]);

    // 成功后再失败 → 退避必须复位为 1s（不是继续 60s）
    mode = 'fail';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(10);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls()).toBe(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(11);

    feed.dispose();
  });

  it('T-R3-e2 守护：兜底返回空数组 / 失败均不得清空或重建既有数据', async () => {
    const ctx = makeCtx(queueResponder([[], []]));
    await ctx.feed.loadInitial();
    const rt = vi.fn();
    ctx.feed.onRealtime(rt);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ctx.feed.bars.map((b) => b.ts)).toEqual(LOADED.map((b) => b.ts));
    expect(rt).not.toHaveBeenCalled();
    ctx.feed.dispose();
  });
});
