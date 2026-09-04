import { describe, it, expect, vi } from 'vitest';
import { createHttpClient } from './client';
import { ApiError } from './types';

function fetcherReturning(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function lastCall(f: unknown): { url: string; init: RequestInit } {
  const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return { url, init };
}

describe('createHttpClient（Phase C 起对齐 07-app-plane §1.1 真实线格式）', () => {
  it('getSymbols → GET /api/symbols，SymbolDto 映射为 SymbolSnapshot（latest 内联展开）', async () => {
    const f = fetcherReturning([
      {
        code: '518880',
        name: '黄金ETF',
        interval_secs: 60,
        settlement: 'T0',
        enabled: true,
        latest: { ts: '2026-09-04T02:23:00Z', last: 2.431, change_pct: 0.62 },
      },
      {
        code: '159776',
        name: null,
        interval_secs: 60,
        settlement: 'T1',
        enabled: false,
        latest: null,
      },
    ]);
    const api = createHttpClient('', f);
    const symbols = await api.getSymbols();
    expect(lastCall(f).url).toBe('/api/symbols');
    expect(symbols[0]).toEqual({ code: '518880', name: '黄金ETF', last: 2.431, changePct: 0.62 });
    expect(symbols[1]).toEqual({ code: '159776', name: '159776', last: 0, changePct: 0 });
  });

  it('getKline 拼游标参数并解包络 {bars}（升序）', async () => {
    const bars = [
      { ts: '2026-09-04T01:59:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
    ];
    const f = fetcherReturning({ code: '518880', period: '15m', bars, next_before: null });
    const api = createHttpClient('', f);
    const out = await api.getKline({
      code: '518880',
      period: '15m',
      before: '2026-09-03T07:00:00Z',
      limit: 500,
    });
    const { url } = lastCall(f);
    expect(url).toContain('/api/kline?');
    expect(url).toContain('code=518880');
    expect(url).toContain('period=15m');
    expect(url).toContain(`before=${encodeURIComponent('2026-09-03T07:00:00Z')}`);
    expect(url).toContain('limit=500');
    expect(out).toEqual(bars);
  });

  it('getKline 缺省 before/limit 时不带对应参数', async () => {
    const f = fetcherReturning({ code: 'x', period: '1m', bars: [], next_before: null });
    const api = createHttpClient('', f);
    await api.getKline({ code: '518880', period: '1m' });
    const { url } = lastCall(f);
    expect(url).not.toContain('before=');
    expect(url).not.toContain('limit=');
  });

  it('getSourcesHealth → GET /api/sources/health（后端行格式透传）', async () => {
    const body = {
      window_secs: 3600,
      sources: [
        {
          source: 'tencent_ifzq',
          window_secs: 3600,
          attempts: 60,
          successes: 60,
          success_rate: 1,
          p50_ms: 180,
          p95_ms: 320,
          circuit_state: 'closed',
          status: 'healthy',
          last_error: null,
          last_event_ts: '2026-09-04T02:23:00Z',
        },
      ],
    };
    const f = fetcherReturning(body);
    const api = createHttpClient('', f);
    const health = await api.getSourcesHealth();
    expect(lastCall(f).url).toBe('/api/sources/health');
    expect(health.window_secs).toBe(3600);
    expect(health.sources[0]!.source).toBe('tencent_ifzq');
    expect(health.sources[0]!.status).toBe('healthy');
  });

  it('HTTP 非 2xx 抛 ApiError（状态码 + 服务端 error 文本）', async () => {
    const f = fetcherReturning({ error: 'boom' }, false, 500);
    const api = createHttpClient('', f);
    const err = await api.getSymbols().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toContain('boom');
  });

  // ── Phase C：标的管理写端点 ──

  it('getSymbolsAdmin → GET /api/symbols?with_stats=1', async () => {
    const f = fetcherReturning([
      { code: '518880', name: '黄金ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: null, today_bars: 205 },
    ]);
    const api = createHttpClient('', f);
    const rows = await api.getSymbolsAdmin();
    expect(lastCall(f).url).toBe('/api/symbols?with_stats=1');
    expect(rows[0]!.today_bars).toBe(205);
  });

  it('registerSymbol → POST /api/symbols（body 字段后端口径 snake_case）', async () => {
    const created = { code: '600519', name: '贵州茅台', interval_secs: 60, settlement: 'T1', enabled: true, latest: null };
    const f = fetcherReturning(created, true, 201);
    const api = createHttpClient('', f);
    const row = await api.registerSymbol({ code: '600519', interval_secs: 60 });
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/symbols');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: '600519', interval_secs: 60 });
    expect(row.code).toBe('600519');
  });

  it('updateSymbol → PATCH /api/symbols/{code}（停用=enabled:false）', async () => {
    const f = fetcherReturning({ code: '518880' });
    const api = createHttpClient('', f);
    await api.updateSymbol('518880', { enabled: false });
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/symbols/518880');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('registerSymbol 冲突/校验失败透传 ApiError（409/422 供表单内联提示）', async () => {
    const f = fetcherReturning({ error: 'code 已注册（编辑用 PATCH）' }, false, 409);
    const api = createHttpClient('', f);
    const err = await api.registerSymbol({ code: '518880' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toContain('已注册');
  });

  // ── Phase C：熔断复位 + 页面②补充数据源 ──

  it('resetSource → POST /api/sources/{id}/reset（202 异步接受）', async () => {
    const f = fetcherReturning({ status: 'accepted' }, true, 202);
    const api = createHttpClient('', f);
    await api.resetSource('tencent_qt');
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/sources/tencent_qt/reset');
    expect(init.method).toBe('POST');
  });

  it('getGaps / getAlerts / getSourceEvents / getSourceMetrics / getSourceDivergence URL 契约', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
    await api.getGaps();
    expect(lastCall(f).url).toBe('/api/collection/gaps?date=today');
    await api.getAlerts(10);
    expect(lastCall(f).url).toBe('/api/alerts?limit=10');
    await api.getSourceEvents('tencent_qt', 50);
    expect(lastCall(f).url).toBe('/api/sources/tencent_qt/events?limit=50');
    await api.getSourceMetrics('tencent_qt', '1h');
    expect(lastCall(f).url).toBe('/api/sources/tencent_qt/metrics?range=1h');
    const f2 = fetcherReturning({ divergeBars: 3, thresholdPct: 0.5 });
    const api2 = createHttpClient('', f2);
    const d = await api2.getSourceDivergence('tencent_qt', '3d');
    expect(lastCall(f2).url).toBe('/api/sources/tencent_qt/divergence?range=3d');
    expect(d.divergeBars).toBe(3);
  });

  it('getSourceRateLimits → GET /api/sources/{id}/rate-limits?range=（限流计数器组）', async () => {
    const f = fetcherReturning({ http403: 0, http429: 2, connReset: 5 });
    const api = createHttpClient('', f);
    const c = await api.getSourceRateLimits('tencent_qt', '1h');
    expect(lastCall(f).url).toBe('/api/sources/tencent_qt/rate-limits?range=1h');
    expect(c).toEqual({ http403: 0, http429: 2, connReset: 5 });
  });
});
