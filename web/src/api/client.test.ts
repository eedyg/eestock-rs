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
    expect(symbols[0]).toEqual({ code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62, favorite: false, favoriteSort: null });
    expect(symbols[1]).toEqual({ code: '159776', name: '159776', enabled: false, last: null, changePct: 0, favorite: false, favoriteSort: null });
  });

  it('getSymbols → favorite/favorite_sort 恒映射（收藏=true+sort，非收藏=false+null）', async () => {
    const f = fetcherReturning([
      { code: '513310', name: '纳指ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:23:00Z', last: 1.587, change_pct: -0.31 }, favorite: true, favorite_sort: 2 },
      { code: '518880', name: null, interval_secs: 60, settlement: 'T0', enabled: true, latest: null, favorite: false, favorite_sort: null },
    ]);
    const api = createHttpClient('', f);
    const symbols = await api.getSymbols();
    expect(symbols[0]).toMatchObject({ code: '513310', favorite: true, favoriteSort: 2 });
    expect(symbols[1]).toMatchObject({ code: '518880', favorite: false, favoriteSort: null });
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

  it('getAlerts / getSourceEvents / getSourceMetrics / getSourceDivergence URL 契约', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
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

  // ── Wave 2 Phase B：页面⑦ 告警中心（02-alerts §5 契约）──

  it('getAlertEvents → GET /api/alerts 过滤参数序列化（level/from/to/source/limit）', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
    await api.getAlertEvents({ level: 'critical', from: '2026-09-06T16:00:00Z', to: '2026-09-07T16:00:00Z', source: 'collector', limit: 50 });
    const { url } = lastCall(f);
    expect(url).toContain('/api/alerts?');
    expect(url).toContain('level=critical');
    expect(url).toContain('source=collector');
    expect(url).toContain('limit=50');
    expect(url).toContain('from=2026-09-06T16%3A00%3A00.000Z');
    // 空过滤不携带参数
    const f2 = fetcherReturning([]);
    const api2 = createHttpClient('', f2);
    await api2.getAlertEvents({});
    expect(lastCall(f2).url).toBe('/api/alerts');
  });

  it('ackAlert → POST /api/alerts/{id}/ack；404 透传 ApiError', async () => {
    const acked = {
      id: 7, rule_id: 'collection_stall', level: 'critical', source: 'collector',
      message: '停摆', status: 'acked', fire_count: 2,
      first_fired_at: '2026-09-07T02:00:00Z', last_fired_at: '2026-09-07T02:11:00Z',
      acked_at: '2026-09-07T03:00:00Z', resolved_at: null,
    };
    const f = fetcherReturning(acked);
    const api = createHttpClient('', f);
    const r = await api.ackAlert(7);
    expect(lastCall(f).url).toBe('/api/alerts/7/ack');
    expect(lastCall(f).init.method).toBe('POST');
    expect(r.status).toBe('acked');
    expect(r.acked_at).toBe('2026-09-07T03:00:00Z');

    const f404 = fetcherReturning({ error: '告警不存在或不在未确认状态' }, false, 404);
    await expect(createHttpClient('', f404).ackAlert(999)).rejects.toMatchObject({ status: 404 });
  });

  it('getAlertRules / patchAlertRule → GET/PATCH /api/alert-rules', async () => {
    const rule = {
      id: 'symbol_gap_rate', name: '标的当日缺口率超阈', level: 'warning',
      threshold: 10, duration_minutes: 0, silence_minutes: 45, enabled: true,
    };
    const f = fetcherReturning([rule]);
    const api = createHttpClient('', f);
    const rules = await api.getAlertRules();
    expect(lastCall(f).url).toBe('/api/alert-rules');
    expect(rules[0]).toEqual(rule);

    const f2 = fetcherReturning(rule);
    const api2 = createHttpClient('', f2);
    const patched = await api2.patchAlertRule('symbol_gap_rate', { threshold: 10, silence_minutes: 45 });
    expect(lastCall(f2).url).toBe('/api/alert-rules');
    expect(lastCall(f2).init.method).toBe('PATCH');
    expect(JSON.parse(String(lastCall(f2).init.body))).toEqual({
      id: 'symbol_gap_rate', threshold: 10, silence_minutes: 45,
    });
    expect(patched.threshold).toBe(10);
  });

  it('getAlerts（页面②预览复用）：新事件线格式适配为遗留 AlertItem（level 映射 + 时间/文本）', async () => {
    const f = fetcherReturning([
      { id: 1, rule_id: 'collection_stall', level: 'critical', source: 'collector', message: '停摆',
        status: 'triggered', fire_count: 1, first_fired_at: '2026-09-07T02:00:00Z',
        last_fired_at: '2026-09-07T02:00:00Z', acked_at: null, resolved_at: null },
      { id: 2, rule_id: 'symbol_gap_rate', level: 'warning', source: '513310', message: '缺口',
        status: 'triggered', fire_count: 4, first_fired_at: '2026-09-07T01:00:00Z',
        last_fired_at: '2026-09-07T01:30:00Z', acked_at: null, resolved_at: null },
    ]);
    const api = createHttpClient('', f);
    const items = await api.getAlerts(10);
    expect(lastCall(f).url).toBe('/api/alerts?limit=10');
    expect(items[0]).toEqual({ ts: '2026-09-07T02:00:00Z', level: 'crit', text: '停摆' });
    expect(items[1]!.level).toBe('warn');
  });

  // ── Wave 2 Phase C：页面④ 数据质量（04-quality.md §7.1 / 07-app-plane §1.1 真实契约）──

  it('getQualityDivergence → GET /api/quality/divergence?code=&from=&to=（threshold_pct 可选透传）', async () => {
    const body = {
      code: '518880', from: '2026-09-01', to: '2026-09-03', threshold_pct: 0.5,
      summary: { compared_bars: 615, divergent_bars: 3, divergence_rate: 0.0049, consistency_rate: 0.9951, max_deviation_pct: 1.52 },
      rows: [
        { ts: '2026-09-02T02:41:00Z', raw_close: 2.468, accurate_close: 2.431, deviation_pct: 1.5216, raw_source: 'sina_jsonp' },
        { ts: '2026-09-01T06:55:00Z', raw_close: 2.455, accurate_close: 2.441, deviation_pct: 0.5735, raw_source: 'tencent_ifzq' },
      ],
    };
    const f = fetcherReturning(body);
    const api = createHttpClient('', f);
    const r = await api.getQualityDivergence({ code: '518880', from: '2026-09-01', to: '2026-09-03' });
    const { url } = lastCall(f);
    expect(url).toContain('/api/quality/divergence?');
    expect(url).toContain('code=518880');
    expect(url).toContain('from=2026-09-01');
    expect(url).toContain('to=2026-09-03');
    expect(url).not.toContain('threshold_pct'); // 缺省由后端兜底 0.5
    expect(r.summary.compared_bars).toBe(615);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.raw_source).toBe('sina_jsonp');

    const f2 = fetcherReturning(body);
    await createHttpClient('', f2).getQualityDivergence({ code: '518880', from: '2026-09-01', to: '2026-09-03', thresholdPct: 1 });
    expect(lastCall(f2).url).toContain('threshold_pct=1');
  });

  it('getSourceAccuracy → GET /api/quality/source-accuracy?from=&to=', async () => {
    const body = {
      from: '2026-09-01', to: '2026-09-03', threshold_pct: 0.5,
      sources: [
        { source: 'tencent_ifzq', samples: 615, consistency_rate: 0.998, avg_deviation_pct: 0.02, max_deviation_pct: 0.57 },
        { source: 'sina_jsonp', samples: 615, consistency_rate: 0.971, avg_deviation_pct: 0.31, max_deviation_pct: 1.52 },
      ],
    };
    const f = fetcherReturning(body);
    const api = createHttpClient('', f);
    const r = await api.getSourceAccuracy({ from: '2026-09-01', to: '2026-09-03' });
    const { url } = lastCall(f);
    expect(url).toContain('/api/quality/source-accuracy?');
    expect(url).toContain('from=2026-09-01');
    expect(url).not.toContain('code=');
    expect(r.sources).toHaveLength(2);
    expect(r.sources[0]!.source).toBe('tencent_ifzq');
  });

  it('getQualityGaps → GET /api/quality/gaps?code=&from=&to=（segments start/end 为 CST HH:MM）', async () => {
    const body = {
      code: '518880', from: '2026-08-28', to: '2026-09-03',
      days: [
        { date: '2026-09-02', expected_bars: 241, actual_bars: 235, missing_bars: 6,
          segments: [
            { start: '10:41', end: '10:45', count: 5, class: 'source_fault' },
            { start: '13:07', end: '13:07', count: 1, class: 'system_gap' },
          ] },
      ],
    };
    const f = fetcherReturning(body);
    const api = createHttpClient('', f);
    const r = await api.getQualityGaps({ code: '518880', from: '2026-08-28', to: '2026-09-03' });
    const { url } = lastCall(f);
    expect(url).toContain('/api/quality/gaps?');
    expect(url).toContain('code=518880');
    expect(r.days).toHaveLength(1);
    expect(r.days[0]!.segments[0]).toEqual({ start: '10:41', end: '10:45', count: 5, class: 'source_fault' });
  });

  it('getMaConfig → GET /api/config/ma（MA 窗口列表）', async () => {
    const f = fetcherReturning({ windows: [5, 10, 20] });
    const api = createHttpClient('', f);
    const cfg = await api.getMaConfig();
    expect(lastCall(f).url).toBe('/api/config/ma');
    expect(cfg.windows).toEqual([5, 10, 20]);
  });

  it('saveMaConfig → PUT /api/config/ma（body {windows}）', async () => {
    const f = fetcherReturning({ windows: [7, 10, 20] });
    const api = createHttpClient('', f);
    const cfg = await api.saveMaConfig([7, 10, 20]);
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/config/ma');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ windows: [7, 10, 20] });
    expect(cfg.windows).toEqual([7, 10, 20]);
  });

  it('getTushareStatus → GET /api/tushare/status（quota_remaining 恒 null）', async () => {
    const body = {
      checkpoints: [
        { code: '518880', period: '1m', last_synced_date: '2026-09-03', updated_at: '2026-09-03T22:30:00Z' },
      ],
      covered_codes: 44,
      last_updated_at: '2026-09-03T22:30:00Z',
      last_event: { ts: '2026-09-03T22:30:00Z', ok: true, err_kind: null },
      quota_remaining: null,
    };
    const f = fetcherReturning(body);
    const api = createHttpClient('', f);
    const r = await api.getTushareStatus();
    expect(lastCall(f).url).toBe('/api/tushare/status');
    expect(r.covered_codes).toBe(44);
    expect(r.quota_remaining).toBeNull();
    expect(r.last_event).toEqual({ ts: '2026-09-03T22:30:00Z', ok: true, err_kind: null });
  });

  // ── 页面⑤ 回测工作台（Wave 3 Phase 3c；07-app-plane/00-web-api.md §1.5 契约）──

  it('getStrategies → GET /api/backtest/strategies', async () => {
    const f = fetcherReturning([{ id: 'dual_ma', name: '双均线', description: 'd', params_schema: [] }]);
    const api = createHttpClient('', f);
    const list = await api.getStrategies();
    expect(lastCall(f).url).toBe('/api/backtest/strategies');
    expect(list[0]!.id).toBe('dual_ma');
  });

  it('submitRun → POST /api/backtest/runs（period 映射 + fee snake_case + 默认 from/to）', async () => {
    const f = fetcherReturning({ run_id: 7 });
    const api = createHttpClient('', f);
    const resp = await api.submitRun({
      strategyId: 'dual_ma',
      params: { fast: 5, slow: 20 },
      code: '518880',
      period: '1m',
      fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 },
    });
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/backtest/runs');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      code: '518880',
      period: 'M1',
      strategy_id: 'dual_ma',
      params: { fast: 5, slow: 20 },
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    });
    expect(body.from).toBe('2026-01-01T00:00:00Z');
    expect(body.to).toBe('2026-12-31T00:00:00Z');
    expect(resp.run_id).toBe(7);
  });

  it('submitRun 网格参数（起:止:步长）→ 后端 body 拆 params_grid；period 1d → D1', async () => {
    const f = fetcherReturning({ group_id: 'g1', run_ids: [1, 2, 3] });
    const api = createHttpClient('', f);
    const resp = await api.submitRun({
      strategyId: 'dual_ma',
      params: { fast: '3:9:2', slow: 20 },
      code: '518880',
      period: '1d',
      fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 },
    });
    const body = JSON.parse(String(lastCall(f).init.body));
    expect(body.period).toBe('D1');
    expect(body.params).toEqual({ slow: 20 });
    expect(body.params_grid).toEqual({ fast: '3:9:2' });
    expect(resp.group_id).toBe('g1');
    expect(resp.run_ids).toEqual([1, 2, 3]);
  });

  it('submitRun 显式 from/to/initialCapital 透传', async () => {
    const f = fetcherReturning({ run_id: 9 });
    const api = createHttpClient('', f);
    await api.submitRun({
      strategyId: 'macd',
      params: {},
      code: '513310',
      period: '15m',
      fee: { ratePct: 0.01, minFee: 5, slippageBp: 0 },
      from: '2026-02-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
      initialCapital: 200000,
    });
    const body = JSON.parse(String(lastCall(f).init.body));
    expect(body.period).toBe('M15');
    expect(body.from).toBe('2026-02-01T00:00:00Z');
    expect(body.to).toBe('2026-03-01T00:00:00Z');
    expect(body.initial_capital).toBe(200000);
  });

  it('listRuns → GET /api/backtest/runs（status/group_id/limit/offset 过滤序列化）', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
    await api.listRuns();
    expect(lastCall(f).url).toBe('/api/backtest/runs');
    await api.listRuns({ status: 'running', groupId: 'g1' });
    expect(lastCall(f).url).toBe('/api/backtest/runs?status=running&group_id=g1');
    await api.listRuns({ status: 'done', limit: 100, offset: 0 });
    expect(lastCall(f).url).toBe('/api/backtest/runs?status=done&limit=100&offset=0');
    await api.listRuns({ limit: 100, offset: 100 });
    expect(lastCall(f).url).toBe('/api/backtest/runs?limit=100&offset=100');
  });

  it('getRun → GET /api/backtest/runs/{id}', async () => {
    const f = fetcherReturning({ id: 7, code: '518880', period: 'D1', status: 'done', metrics: { sharpe: 1.2 } });
    const api = createHttpClient('', f);
    const r = await api.getRun(7);
    expect(lastCall(f).url).toBe('/api/backtest/runs/7');
    expect(r.id).toBe(7);
    expect(r.status).toBe('done');
  });

  it('compare → GET /api/backtest/compare?ids=（不存在 run 被后端过滤）', async () => {
    const f = fetcherReturning([{ id: 7 }]);
    const api = createHttpClient('', f);
    const r = await api.compare([7, 999]);
    expect(lastCall(f).url).toBe('/api/backtest/compare?ids=7,999');
    expect(r).toHaveLength(1);
  });

  it('deleteRun → DELETE /api/backtest/runs/{id}；404 透传 ApiError', async () => {
    const f = fetcherReturning({ ok: true });
    const api = createHttpClient('', f);
    await api.deleteRun(7);
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/backtest/runs/7');
    expect(init.method).toBe('DELETE');

    const f404 = fetcherReturning({ error: 'run 不存在' }, false, 404);
    await expect(createHttpClient('', f404).deleteRun(999)).rejects.toMatchObject({ status: 404 });
  });

  // ── 看板收藏（Wave 3 页面①；07-app-plane/00-web-api.md §1.5）──

  it('starSymbol → POST /api/symbols/{code}/favorite', async () => {
    const f = fetcherReturning({ code: '513310', favorite: true });
    const api = createHttpClient('', f);
    await api.starSymbol('513310');
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/symbols/513310/favorite');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('unstarSymbol → DELETE /api/symbols/{code}/favorite', async () => {
    const f = fetcherReturning({ code: '518880', favorite: false });
    const api = createHttpClient('', f);
    await api.unstarSymbol('518880');
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/symbols/518880/favorite');
    expect(init.method).toBe('DELETE');
  });

  it('reorderFavorites → PUT /api/symbols/favorites/order（body {codes} = 收藏区展示顺序）', async () => {
    const f = fetcherReturning({ codes: ['518880', '513310'], reordered: true });
    const api = createHttpClient('', f);
    await api.reorderFavorites(['518880', '513310']);
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/symbols/favorites/order');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ codes: ['518880', '513310'] });
    expect((init.headers as Record<string, string> | undefined)?.['content-type']).toContain('application/json');
  });

  it('starSymbol 404（code 未注册）/ reorder 400（未收藏 code）透传 ApiError', async () => {
    const f404 = fetcherReturning({ error: 'code 未注册' }, false, 404);
    await expect(createHttpClient('', f404).starSymbol('000000')).rejects.toMatchObject({ status: 404 });
    const f400 = fetcherReturning({ error: 'code X 未收藏' }, false, 400);
    await expect(createHttpClient('', f400).reorderFavorites(['X'])).rejects.toMatchObject({ status: 400 });
  });

  // ── 页面⑨ 模拟实盘（§1.6）──

  it('getSimState/positions/orders/pnl/strategies → GET /api/sim-live/*（session_id 可选查询）', async () => {
    const f = fetcherReturning({ active: true, session: null, account: null, positions: [], pnl: null, trading_enabled: false, mcp_enabled: true });
    const api = createHttpClient('', f);
    await api.getSimState();
    expect(lastCall(f).url).toBe('/api/sim-live/state');
    await api.getSimState('s_9');
    expect(lastCall(f).url).toBe('/api/sim-live/state?session_id=s_9');
    await api.getSimPositions();
    expect(lastCall(f).url).toBe('/api/sim-live/positions');
    await api.getSimOrders();
    expect(lastCall(f).url).toBe('/api/sim-live/orders');
    await api.getSimPnl();
    expect(lastCall(f).url).toBe('/api/sim-live/pnl');
    await api.getSimStrategies();
    expect(lastCall(f).url).toBe('/api/sim-live/strategies');
  });

  it('startSimSession → POST /api/sim-live/start-session（body 含 name/period/cash_init/strategy_set/stock_set）', async () => {
    const f = fetcherReturning({ started: true, session: { id: 's_1', name: 't', status: 'running', source: 'web', cash_init: 1_000_000, strategy_set: [], stock_set: [], period: 'M1', start_ts: '', end_ts: null } });
    const api = createHttpClient('', f);
    await api.startSimSession({ name: 't', period: 'M1', cash_init: 200_000, strategy_set: ['dual_ma'], stock_set: ['518880'] });
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/sim-live/start-session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 't', period: 'M1', cash_init: 200_000, strategy_set: ['dual_ma'], stock_set: ['518880'] });
  });

  it('placeSimOrder → POST /api/sim-live/place-order（body 含 price=sell 模拟行情价）+ trading/mcp-toggle body {enabled}', async () => {
    const f = fetcherReturning({ session_id: 's_9', filled: true, fill: {} });
    const api = createHttpClient('', f);
    await api.placeSimOrder({ code: '518880', side: 'buy', qty: 1000, price: 9.165 });
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/sim-live/place-order');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: '518880', side: 'buy', qty: 1000, price: 9.165 });

    const f2 = fetcherReturning({ session_id: 's', trading_enabled: true });
    const api2 = createHttpClient('', f2);
    await api2.toggleSimTrading({ enabled: true });
    expect(JSON.parse(String(lastCall(f2).init.body))).toEqual({ enabled: true });
    const f3 = fetcherReturning({ mcp_enabled: false });
    const api3 = createHttpClient('', f3);
    await api3.toggleSimMcp({ enabled: false });
    expect(JSON.parse(String(lastCall(f3).init.body))).toEqual({ enabled: false });
  });

  it('stopSimSession/cancelSimOrder/runSimBacktestCompare/getSimSessions/getSimSession → 对应端点', async () => {
    const f = fetcherReturning({ session_id: 's', stopped: true });
    const api = createHttpClient('', f);
    await api.stopSimSession({ session_id: 's' });
    expect(lastCall(f).url).toBe('/api/sim-live/stop-session');

    const f2 = fetcherReturning({ session_id: 's', order_id: 'o_1', cancelled: true });
    const api2 = createHttpClient('', f2);
    await api2.cancelSimOrder({ session_id: 's', order_id: 'o_1' });
    const { url: u2, init: i2 } = lastCall(f2);
    expect(u2).toBe('/api/sim-live/cancel-order');
    expect(JSON.parse(String(i2.body))).toEqual({ session_id: 's', order_id: 'o_1' });

    const f3 = fetcherReturning({ session_id: 's', session_result: null, run_ids: [1] });
    const api3 = createHttpClient('', f3);
    await api3.runSimBacktestCompare('s_9');
    const c = lastCall(f3);
    expect(c.url).toBe('/api/sim-live/sessions/s_9/backtest-compare');
    expect(c.init.method).toBe('POST');

    const f4 = fetcherReturning([]);
    const api4 = createHttpClient('', f4);
    await api4.getSimSessions();
    expect(lastCall(f4).url).toBe('/api/sim-live/sessions');

    const f5 = fetcherReturning({ session: null, result: null });
    const api5 = createHttpClient('', f5);
    await api5.getSimSession('s_9');
    expect(lastCall(f5).url).toBe('/api/sim-live/sessions/s_9');
  });
});

describe('回测工作台 client（12-strategy-system / P3b；07-app-plane §1.8 线格式）', () => {
  const submitBody: import('./types').WorkbenchSubmitReq = {
    symbol: '518880',
    period: 'D1',
    from: '2026-01-01T00:00:00Z',
    to: '2026-03-01T00:00:00Z',
    slots: [{ version_id: 'sv_1', params: { fast: 5 }, weight: 1 }],
    buy_threshold: 60,
    sell_threshold: 40,
    policy: { LumpSum: { position_pct: 1 } },
    stop: { kind: 'FixedPct', value: 0.08, trigger: 'Intrabar' },
    initial_capital: 100000,
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
  };

  it('submitWorkbenchRun → POST /api/workbench/runs（body 原样 snake_case）', async () => {
    const f = fetcherReturning({ id: 'sr_1', status: 'queued' }, true, 201);
    const api = createHttpClient('', f);
    await api.submitWorkbenchRun(submitBody);
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/workbench/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(submitBody);
  });

  it('listWorkbenchRuns → GET /api/workbench/runs（status/limit/offset 序列化；缺省不带参）', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
    await api.listWorkbenchRuns({ status: 'succeeded', limit: 50, offset: 100 });
    expect(lastCall(f).url).toBe('/api/workbench/runs?status=succeeded&limit=50&offset=100');
    await api.listWorkbenchRuns();
    expect(lastCall(f).url).toBe('/api/workbench/runs');
  });

  it('getWorkbenchRun / getWorkbenchResult / cancelWorkbenchRun URL 契约', async () => {
    const f = fetcherReturning({});
    const api = createHttpClient('', f);
    await api.getWorkbenchRun('sr_9');
    expect(lastCall(f).url).toBe('/api/workbench/runs/sr_9');
    await api.getWorkbenchResult('sr_9');
    expect(lastCall(f).url).toBe('/api/workbench/runs/sr_9/result');
    await api.cancelWorkbenchRun('sr_9');
    const c = lastCall(f);
    expect(c.url).toBe('/api/workbench/runs/sr_9/cancel');
    expect(c.init.method).toBe('POST');
  });

  it('compareWorkbenchRuns → POST /api/workbench/runs/compare（body {ids}）', async () => {
    const f = fetcherReturning([]);
    const api = createHttpClient('', f);
    await api.compareWorkbenchRuns(['sr_1', 'sr_2']);
    const { url, init } = lastCall(f);
    expect(url).toBe('/api/workbench/runs/compare');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ids: ['sr_1', 'sr_2'] });
  });

  it('presets CRUD + apply URL/method/body 契约', async () => {
    const f = fetcherReturning({});
    const api = createHttpClient('', f);
    await api.listWorkbenchPresets();
    expect(lastCall(f).url).toBe('/api/workbench/presets');

    const cfg = { slots: [], buy_threshold: 60, sell_threshold: 40 } as never;
    await api.createWorkbenchPreset({ name: 'p1', config: cfg });
    let c = lastCall(f);
    expect(c.url).toBe('/api/workbench/presets');
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(String(c.init.body))).toEqual({ name: 'p1', config: cfg });

    await api.updateWorkbenchPreset('sp_1', { name: 'p2', config: cfg });
    c = lastCall(f);
    expect(c.url).toBe('/api/workbench/presets/sp_1');
    expect(c.init.method).toBe('PUT');

    await api.deleteWorkbenchPreset('sp_1');
    c = lastCall(f);
    expect(c.url).toBe('/api/workbench/presets/sp_1');
    expect(c.init.method).toBe('DELETE');

    await api.applyWorkbenchPreset('sp_1');
    c = lastCall(f);
    expect(c.url).toBe('/api/workbench/presets/sp_1/apply');
    expect(c.init.method).toBe('POST');
  });

  it('错误透传：400/404/409 ApiError（状态码 + 服务端 error 文本）', async () => {
    const f = fetcherReturning({ error: 'ids 必填' }, false, 400);
    const api = createHttpClient('', f);
    await expect(api.compareWorkbenchRuns([])).rejects.toMatchObject({ status: 400 });
    const f404 = fetcherReturning({ error: 'run 不存在' }, false, 404);
    const api404 = createHttpClient('', f404);
    await expect(api404.getWorkbenchRun('sr_x')).rejects.toBeInstanceOf(ApiError);
  });
});
