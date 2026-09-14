/**
 * 兜底取数协调器（`realtimePoll.ts`）用例：**合并 + 限流**（诊断 055 §6(c) 副作用面）。
 *
 * 钉死的口径（任务「宫格多图必须合并/限流，避免 2×3 宫格每分钟 6 个请求」）：
 *  - 同一 `(code, period)` 的在途请求只发 1 次 HTTP（主图 / 宫格同标的同周期共享同一 Promise）；
 *  - 请求完成后不再复用旧结果（下一次兜底重新取数）；
 *  - 不同 `(code, period)` 不合并，但全局并发受 `MAX_CONCURRENT_POLLS` 限制：超限排队、**不丢请求**。
 *
 * 本文件为阶段 2 新增（加强覆盖；不修改任何既有断言）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MAX_CONCURRENT_POLLS,
  pollLatestWindow,
  resetRealtimePollGateForTest,
} from './realtimePoll';
import type { ApiClient, KlineQuery } from '@/api/client';
import type { Bar, Period } from '@/api/types';

function mkBar(ts: string): Bar {
  return { ts, open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 };
}

/** 可编程 api：每次调用返回一个测试自行放行的 Promise，并记录入参。 */
function pendingApi() {
  const calls: Array<{
    q: KlineQuery;
    settled: boolean;
    resolve: (bars: Bar[]) => void;
    reject: (e: unknown) => void;
  }> = [];
  const getKline = vi.fn(
    (q: KlineQuery) =>
      new Promise<Bar[]>((resolve, reject) => {
        calls.push({ q, settled: false, resolve, reject });
      }),
  );
  return { api: { getKline } as unknown as ApiClient, getKline, calls };
}

/** 放行「仍在途」的最大下标请求（队列会随放行陆续新增，不能按下标预枚举）。 */
async function releaseNext(calls: ReturnType<typeof pendingApi>['calls'], outcome: 'ok' | 'fail' = 'ok') {
  const next = [...calls].reverse().find((c) => !c.settled);
  if (!next) return false;
  next.settled = true;
  if (outcome === 'ok') next.resolve([mkBar('2026-09-14T01:50:00Z')]);
  else next.reject(new Error('500'));
  await flush();
  return true;
}

/** 冲刷微任务（放行 → release → 排队项启动 需要若干跳）。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('realtimePoll 兜底取数合并 + 限流', () => {
  beforeEach(() => {
    resetRealtimePollGateForTest();
  });

  it('同一 (code, period) 在途请求合并为一次 HTTP；完成后不复用旧结果', async () => {
    const { api, getKline, calls } = pendingApi();
    const a = pollLatestWindow(api, '518880', '1m', 5);
    const b = pollLatestWindow(api, '518880', '1m', 5);
    expect(getKline).toHaveBeenCalledTimes(1);
    expect(calls[0]!.q).toEqual({ code: '518880', period: '1m', limit: 5 });

    calls[0]!.resolve([mkBar('2026-09-14T01:50:00Z')]);
    await expect(a).resolves.toHaveLength(1);
    await expect(b).resolves.toHaveLength(1); // 合并：两个调用方拿到同一结果

    // 已结算 ⇒ 不再是「在途」：下一次兜底重新发请求（不得缓存旧窗口）
    void pollLatestWindow(api, '518880', '1m', 5);
    expect(getKline).toHaveBeenCalledTimes(2);
  });

  it('不同 (code, period) 不合并；超过并发上限的请求排队而不丢失', async () => {
    const { api, getKline, calls } = pendingApi();
    const keys: Array<[string, Period]> = [
      ['518880', '1m'],
      ['513310', '1m'],
      ['159337', '1m'],
      ['510300', '1m'],
      ['588000', '1m'],
      ['515880', '1m'],
    ];
    const ps = keys.map(([code, period]) => pollLatestWindow(api, code, period, 5));
    expect(getKline).toHaveBeenCalledTimes(MAX_CONCURRENT_POLLS); // 宫格 6 图：同时最多 3 个在途

    // 放行一个在途请求 → 排队中的第 4 个立刻补位（限额释放）
    await releaseNext(calls);
    expect(getKline).toHaveBeenCalledTimes(MAX_CONCURRENT_POLLS + 1);

    // 逐个放行其余在途请求 → 最终 6 个请求全部发生、6 个 Promise 全部有结果（不丢请求）
    for (let i = 0; i < keys.length; i++) await releaseNext(calls);
    const results = await Promise.all(ps);
    expect(getKline).toHaveBeenCalledTimes(keys.length);
    expect(results.every((bars) => bars.length === 1)).toBe(true);
    expect(calls.map((c) => c.q.code).sort()).toEqual(keys.map(([code]) => code).sort());
  });

  it('失败的请求同样释放并发名额（不产生死锁）', async () => {
    const { api, getKline, calls } = pendingApi();
    const keys: Array<[string, Period]> = [
      ['518880', '1m'],
      ['513310', '1m'],
      ['159337', '1m'],
      ['510300', '1m'],
    ];
    const ps = keys.map(([code, period]) => pollLatestWindow(api, code, period, 5));
    expect(getKline).toHaveBeenCalledTimes(MAX_CONCURRENT_POLLS);

    calls[0]!.settled = true;
    calls[0]!.reject(new Error('500'));
    await expect(ps[0]).rejects.toThrow('500');
    await flush();
    expect(getKline).toHaveBeenCalledTimes(MAX_CONCURRENT_POLLS + 1); // 名额已释放

    for (let i = 0; i < keys.length; i++) await releaseNext(calls);
    await expect(Promise.all(ps.slice(1))).resolves.toHaveLength(3);
  });
});
