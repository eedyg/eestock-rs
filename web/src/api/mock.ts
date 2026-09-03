import type { ApiClient, KlineQuery } from './client';
import type { Bar, Period, SourcesHealth, SymbolSnapshot } from './types';

/**
 * 手写契约 mock（09-frontend.md §4）：后端 Phase A 并行开发期供前端联调/测试。
 * 确定性生成：同一 (code, period, ts) 恒得同一 bar，便于复现与分页测试。
 */

const PERIOD_MS: Record<Period, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

const BASE_PRICE: Record<string, number> = {
  '518880': 2.4,
  '513310': 1.58,
  '161226': 0.98,
  '159776': 0.87,
};

const MOCK_SYMBOLS: SymbolSnapshot[] = [
  { code: '518880', name: '黄金ETF', last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', last: 1.587, changePct: -0.31 },
  { code: '161226', name: '白银LOF', last: 0.982, changePct: 1.15 },
  { code: '159776', name: '港股通医药', last: 0.874, changePct: -0.8 },
];

/** 确定性伪随机 [0,1)：由 key 哈希驱动 */
function rand01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function makeBar(code: string, period: Period, ts: number): Bar {
  const base = BASE_PRICE[code] ?? 1;
  const r1 = rand01(`${code}:${period}:${ts}:o`);
  const r2 = rand01(`${code}:${period}:${ts}:c`);
  const r3 = rand01(`${code}:${period}:${ts}:h`);
  const r4 = rand01(`${code}:${period}:${ts}:l`);
  const open = round3(base * (1 + (r1 - 0.5) * 0.02));
  const close = round3(base * (1 + (r2 - 0.5) * 0.02));
  const high = round3(Math.max(open, close) * (1 + r3 * 0.005));
  const low = round3(Math.min(open, close) * (1 - r4 * 0.005));
  const volume = 1000 + Math.floor(r1 * 9000);
  return { ts: new Date(ts).toISOString(), open, high, low, close, volume, amount: Math.round(volume * close) };
}

export interface MockOptions {
  now?: Date; // 测试注入固定时刻，保证可复现
}

export function createMockClient(opts: MockOptions = {}): ApiClient {
  const anchorNow = opts.now?.getTime() ?? Date.now();
  return {
    async getSymbols() {
      return MOCK_SYMBOLS.map((s) => ({ ...s }));
    },
    async getKline({ code, period, before, limit = 500 }: KlineQuery): Promise<Bar[]> {
      const step = PERIOD_MS[period];
      // 排他上界：缺省为当前周期边界（最新一根已完成 bar）
      const endExclusive = before ? Date.parse(before) : Math.floor(anchorNow / step) * step;
      const bars: Bar[] = [];
      for (let i = limit; i >= 1; i--) {
        bars.push(makeBar(code, period, endExclusive - step * i));
      }
      return bars;
    },
    async getSourcesHealth(): Promise<SourcesHealth> {
      return {
        collectorRunning: true,
        sources: [
          { id: 'tencent_ifzq', name: '腾讯ifzq', role: '1m', status: 'healthy' },
          { id: 'sina_jsonp', name: '新浪jsonp', role: '1m', status: 'healthy' },
          { id: 'tencent_qt', name: '腾讯qt快照', role: 'snapshot', status: 'healthy' },
          { id: 'sina_hq', name: '新浪hq快照', role: 'snapshot', status: 'healthy' },
        ],
      };
    },
  };
}
