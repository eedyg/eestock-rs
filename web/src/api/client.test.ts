import { describe, it, expect, vi } from 'vitest';
import { createHttpClient } from './client';

function fetcherReturning(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('createHttpClient', () => {
  it('getSymbols → GET /api/symbols，返回标快照数组', async () => {
    const f = fetcherReturning([{ code: '518880', name: '黄金ETF', last: 2.431, changePct: 0.62 }]);
    const api = createHttpClient('', f);
    const symbols = await api.getSymbols();
    expect(f).toHaveBeenCalledWith('/api/symbols', expect.anything());
    expect(symbols[0]).toEqual({ code: '518880', name: '黄金ETF', last: 2.431, changePct: 0.62 });
  });

  it('getKline 拼游标参数：code/period/before/limit', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
    await api.getKline({ code: '518880', period: '15m', before: '2026-09-03T07:00:00Z', limit: 500 });
    const url = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('/api/kline?');
    expect(url).toContain('code=518880');
    expect(url).toContain('period=15m');
    expect(url).toContain(`before=${encodeURIComponent('2026-09-03T07:00:00Z')}`);
    expect(url).toContain('limit=500');
  });

  it('getKline 缺省 before/limit 时不带对应参数', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
    await api.getKline({ code: '518880', period: '1m' });
    const url = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).not.toContain('before=');
    expect(url).not.toContain('limit=');
  });

  it('getSourcesHealth → GET /api/sources/health', async () => {
    const body = {
      collectorRunning: true,
      sources: [{ id: 'tencent_ifzq', name: '腾讯ifzq', role: '1m', status: 'healthy' }],
    };
    const f = fetcherReturning(body);
    const api = createHttpClient('', f);
    const health = await api.getSourcesHealth();
    expect(f).toHaveBeenCalledWith('/api/sources/health', expect.anything());
    expect(health.collectorRunning).toBe(true);
    expect(health.sources[0]!.role).toBe('1m');
  });

  it('HTTP 非 2xx 抛错（带状态码）', async () => {
    const f = fetcherReturning({}, false, 500);
    const api = createHttpClient('', f);
    await expect(api.getSymbols()).rejects.toThrow(/500/);
  });
});
