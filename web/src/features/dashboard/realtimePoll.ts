/**
 * 实时兜底取数的**合并 + 限流**协调器（诊断 055 §6(c) 副作用面）。
 *
 * 背景：每分钟兜底 = 每个打开的图表每小时 60 次 HTTP；宫格 2×3 会成倍增加（6 图 × 60 = 360 次/时）。
 * 两条约束在这里集中实现（口径「宫格多图必须合并/限流」）：
 *  1. **合并（coalesce）**：同一 `(code, period)` 的在途请求共享同一 Promise —— 主图与宫格、多格同标的同周期
 *     在每个 60s 窗口内实际只发 1 次 `GET /api/kline`（结果各自 apply 到各自 feed，幂等合并语义不变）；
 *  2. **限流（concurrency gate）**：全局在途上限 `MAX_CONCURRENT_POLLS`（默认 3），超出排队 ⇒ 宫格多标的
 *     不会同一时刻把后端打满（顺序放行，不丢请求）。
 *
 * 说明：不同 (code, period) 无法合并（服务端一请求一标的一周期），只能限流排队。
 * 该协调器是**进程级**共享状态（非每 feed 一份），故导出 `resetRealtimePollGateForTest()` 供用例隔离。
 */
import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';

/** 全局在途上限（宫格 2×3 = 6 图时最多 3 个并发兜底请求）。 */
export const MAX_CONCURRENT_POLLS = 3;

const inflight = new Map<string, Promise<Bar[]>>();
let active = 0;
const queue: Array<() => void> = [];

/** 释放一个在途名额并把名额交给排队中的下一个（若有）。 */
function release(): void {
  active -= 1;
  const next = queue.shift();
  if (next) {
    active += 1;
    next();
  }
}

/** 在并发上限内执行；超限排队（不丢请求、不打断调用方）。 */
function runGated<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT_POLLS) {
    active += 1;
    return fn().finally(release);
  }
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      fn()
        .then(resolve, reject)
        .finally(release);
    });
  });
}

/**
 * 取「最新窗口」增量（无 `before` 游标 = 从最新起 limit 根），同 `(code, period)` 在途请求合并。
 * 调用方（`KlineDataFeed.pollIncrement`）负责逐根走同一 `applyRealtime` 合并；本函数只负责取数 + 协调。
 */
export function pollLatestWindow(
  api: ApiClient,
  code: string,
  period: Period,
  limit: number,
): Promise<Bar[]> {
  const key = `${code}:${period}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = runGated(() => api.getKline({ code, period, limit }));
  inflight.set(key, p);
  const clear = () => {
    if (inflight.get(key) === p) inflight.delete(key);
  };
  void p.then(clear, clear);
  return p;
}

/** 仅测试用：清空在途/排队与并发计数（用例间隔离；生产路径不调用）。 */
export function resetRealtimePollGateForTest(): void {
  inflight.clear();
  queue.length = 0;
  active = 0;
}
