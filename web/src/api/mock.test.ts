import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockClient } from './mock';
import { SUPPORTED_BACKTEST_PERIODS } from '@/features/backtest/periods';
import type { StrategyTestRunResp } from './types';

/** 单一事实源：`design/16-backtest-scalability/contract-vectors.json`（ADR-024 §5.4）。
 *  mock 的区间语义（去日历档 / 收缩 / range_empty / resource_guard）**与该向量的
 *  `span_limit_semantics` 段绑定**：向量改（例：把 `calendar_day_cap` 设回数值、改 `clamp.mode`、
 *  删 `echo_fields`）⇒ 本文件断言必红。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  readFileSync(resolve(HERE, '../../../design/16-backtest-scalability/contract-vectors.json'), 'utf8'),
) as {
  backtest_periods: string[];
  span_limit_semantics: {
    calendar_day_cap: number | null;
    deleted_constants: string[];
    clamp: { mode: string; echo_fields: string[]; gap_policy: string };
    empty_intersection: { http: number; code: string };
    resource_guard: { code: string; requires_confirmation: boolean };
  };
};
const SPAN = VECTORS.span_limit_semantics;

describe('createMockClient（后端 Phase A 并行期的契约 mock）', () => {
  it('getSymbols 返回注册集合 4 标的（含 latest 快照字段 + enabled）', async () => {
    const api = createMockClient();
    const symbols = await api.getSymbols();
    expect(symbols.length).toBe(4);
    const codes = symbols.map((s) => s.code);
    expect(codes).toEqual(expect.arrayContaining(['518880', '513310', '161226', '159776']));
    for (const s of symbols) {
      expect(typeof s.name).toBe('string');
      // D2：有数据 last 为 number；latest=null（停用/未采到）→ last 为 null，不伪造 0
      expect(s.last === null || typeof s.last === 'number').toBe(true);
      expect(typeof s.changePct).toBe('number');
      expect(typeof s.enabled).toBe('boolean');
    }
    // 停用/无数据标的 {159776}：enabled=false 且 last=null
    const disabled = symbols.find((s) => s.code === '159776')!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.last).toBeNull();
    // 有数据标的 last 为 number
    expect(symbols.find((s) => s.code === '518880')!.last).toEqual(expect.any(Number));
  });

  it('getKline 返回 limit 根升序 bar，字段齐备', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const bars = await api.getKline({ code: '518880', period: '15m', limit: 100 });
    expect(bars).toHaveLength(100);
    for (let i = 1; i < bars.length; i++) {
      expect(new Date(bars[i]!.ts).getTime()).toBeGreaterThan(new Date(bars[i - 1]!.ts).getTime());
    }
    const b = bars[0]!;
    expect(b.high).toBeGreaterThanOrEqual(b.low);
    expect(b.open).toBeGreaterThan(0);
    expect(b.volume).toBeGreaterThan(0);
  });

  it('getKline 15m 周期 bar 间隔 15 分钟且对齐边界', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const bars = await api.getKline({ code: '518880', period: '15m', limit: 10 });
    const t0 = new Date(bars[0]!.ts).getTime();
    expect(t0 % (15 * 60_000)).toBe(0);
    const t1 = new Date(bars[1]!.ts).getTime();
    expect(t1 - t0).toBe(15 * 60_000);
  });

  it('before 游标为排他上界：返回 bar 全部早于 before', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const first = await api.getKline({ code: '518880', period: '1m', limit: 50 });
    // 真实翻页流程：以当前已加载最早一根的 ts 为游标
    const cursor = first[0]!.ts;
    const older = await api.getKline({ code: '518880', period: '1m', before: cursor, limit: 50 });
    expect(older.length).toBeGreaterThan(0);
    for (const b of older) {
      expect(new Date(b.ts).getTime()).toBeLessThan(new Date(cursor).getTime());
    }
    // 与首批衔接无重复
    const olderTs = new Set(older.map((b) => b.ts));
    expect(first.some((b) => olderTs.has(b.ts))).toBe(false);
  });

  it('同一参数两次调用结果确定（mock 可复现）', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const a = await api.getKline({ code: '518880', period: '5m', limit: 20 });
    const b = await api.getKline({ code: '518880', period: '5m', limit: 20 });
    expect(a).toEqual(b);
  });

  it('getSourcesHealth 返回后端行格式（07-app-plane §1.1：snake_case，三态灯齐备）', async () => {
    const api = createMockClient();
    const health = await api.getSourcesHealth();
    expect(health.window_secs).toBe(3600);
    const statuses = health.sources.map((s) => s.status);
    expect(statuses).toContain('healthy');
    expect(statuses).toContain('degraded');
    expect(statuses).toContain('circuit_open');
    const qt = health.sources.find((s) => s.source === 'tencent_qt')!;
    expect(qt.circuit_state).toBe('open');
    expect(qt.last_error).not.toBeNull();
  });

  it('标的管理闭环：register（冲突 409/北交所 422）→ update → 列表反映', async () => {
    const api = createMockClient();
    const created = await api.registerSymbol({ code: '600519', name: '贵州茅台' });
    expect(created.interval_secs).toBe(60);
    expect(created.settlement).toBe('T1');
    expect(created.enabled).toBe(true);
    await expect(api.registerSymbol({ code: '600519' })).rejects.toMatchObject({ status: 409 });
    await expect(api.registerSymbol({ code: '830799' })).rejects.toMatchObject({ status: 422 });
    const patched = await api.updateSymbol('600519', { interval_secs: 300, enabled: false });
    expect(patched.interval_secs).toBe(300);
    expect(patched.enabled).toBe(false);
    const rows = await api.getSymbolsAdmin();
    expect(rows.find((r) => r.code === '600519')!.enabled).toBe(false);
    await expect(api.updateSymbol('000000', { enabled: false })).rejects.toMatchObject({ status: 404 });
  });

  it('页面②补充数据源：alerts/events/metrics/divergence 契约形状', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    // 缺口摘要由 getQualityGaps 提供（单标的，方案 A：页②缺口区不再调 /api/collection/gaps）
    const gapsResp = await api.getQualityGaps({ code: '518880', from: '2026-08-28', to: '2026-09-03' });
    expect(gapsResp.code).toBe('518880');
    expect((await api.getAlerts(10)).length).toBeGreaterThan(0);
    const events = await api.getSourceEvents('tencent_qt', 50);
    expect(events[0]).toHaveProperty('traceId');
    const metrics = await api.getSourceMetrics('tencent_qt', '1h');
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]).toHaveProperty('successRate');
    const div = await api.getSourceDivergence('tencent_qt', '3d');
    expect(div.thresholdPct).toBe(0.5);
    await expect(api.resetSource('tencent_qt')).resolves.toBeUndefined();
  });

  it('页面⑦ 告警 mock：列表过滤 / ack 状态翻转 / 规则 patch 闭环', async () => {
    const api = createMockClient({ now: new Date('2026-09-07T03:00:00Z') });
    // 列表（默认倒序）+ 过滤
    const all = await api.getAlertEvents({});
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toHaveProperty('rule_id');
    const crit = await api.getAlertEvents({ level: 'critical' });
    expect(crit.every((e) => e.level === 'critical')).toBe(true);
    const bySrc = await api.getAlertEvents({ source: 'collector' });
    expect(bySrc.every((e) => e.source === 'collector')).toBe(true);
    // ack：triggered → acked（持久化于 mock 内部状态）；重复 ack → 404
    const target = all.find((e) => e.status === 'triggered')!;
    const acked = await api.ackAlert(target.id);
    expect(acked.status).toBe('acked');
    expect(acked.acked_at).not.toBeNull();
    await expect(api.ackAlert(target.id)).rejects.toMatchObject({ status: 404 });
    // 规则：4 条内置规则；patch 阈值/开关闭环
    const rules = await api.getAlertRules();
    expect(rules).toHaveLength(4);
    const patched = await api.patchAlertRule('symbol_gap_rate', { threshold: 10, enabled: false });
    expect(patched.threshold).toBe(10);
    expect(patched.enabled).toBe(false);
    expect(patched.silence_minutes).toBe(30); // 未给字段不改
    await expect(api.patchAlertRule('no_such', { enabled: true })).rejects.toMatchObject({ status: 404 });
    // 遗留预览 getAlerts（02-sources §7 样例基线，level ∈ crit/warn/info）
    const legacy = await api.getAlerts(10);
    expect(legacy.length).toBeGreaterThan(0);
    expect(['crit', 'warn', 'info']).toContain(legacy[0]!.level);
  });

  it('页面④ 数据质量 mock：divergence/source-accuracy/gaps/tushare-status 契约形状（04-quality §7.1）', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    // divergence：rows 按 |偏差| 降序 + 汇总行齐备；查询参数回显
    const div = await api.getQualityDivergence({ code: '518880', from: '2026-09-01', to: '2026-09-03' });
    expect(div.code).toBe('518880');
    expect(div.from).toBe('2026-09-01');
    expect(div.to).toBe('2026-09-03');
    expect(div.threshold_pct).toBe(0.5);
    expect(div.rows.length).toBeGreaterThan(0);
    for (let i = 1; i < div.rows.length; i++) {
      expect(Math.abs(div.rows[i]!.deviation_pct)).toBeLessThanOrEqual(
        Math.abs(div.rows[i - 1]!.deviation_pct),
      );
    }
    expect(div.summary.compared_bars).toBeGreaterThan(0);
    expect(div.summary.consistency_rate).not.toBeNull();
    // 同一参数两次调用结果确定
    const div2 = await api.getQualityDivergence({ code: '518880', from: '2026-09-01', to: '2026-09-03' });
    expect(div2).toEqual(div);
    // source-accuracy：一致率降序
    const acc = await api.getSourceAccuracy({ from: '2026-09-01', to: '2026-09-03' });
    expect(acc.sources.length).toBeGreaterThan(0);
    for (let i = 1; i < acc.sources.length; i++) {
      expect(acc.sources[i]!.consistency_rate ?? 0).toBeLessThanOrEqual(
        acc.sources[i - 1]!.consistency_rate ?? 0,
      );
    }
    // gaps：仅含有缺口交易日；segment 形状 {start,end,count,class}
    const gaps = await api.getQualityGaps({ code: '518880', from: '2026-08-28', to: '2026-09-03' });
    expect(gaps.days.length).toBeGreaterThan(0);
    for (const d of gaps.days) {
      expect(d.missing_bars).toBeGreaterThan(0);
      for (const s of d.segments) {
        expect(s.start).toMatch(/^\d{2}:\d{2}$/);
        expect(['source_fault', 'upstream_no_data', 'system_gap']).toContain(s.class);
      }
    }
    // tushare status：quota 恒 null；checkpoints/covered_codes/last_event 齐备
    const ts = await api.getTushareStatus();
    expect(ts.quota_remaining).toBeNull();
    expect(ts.covered_codes).toBe(ts.checkpoints.length);
    expect(ts.last_event).not.toBeNull();
    expect(typeof ts.last_event!.ok).toBe('boolean');
  });

  // ── Wave 3 页面① 看板收藏（F2 前端依赖；与后端 favorite.rs 同构：star 幂等置顶、unstar 幂等、reorder 校验已收藏）──

  it('getSymbols 初始全非收藏（favorite=false, favorite_sort=null，不伪造收藏标注）', async () => {
    const api = createMockClient();
    const symbols = await api.getSymbols();
    for (const s of symbols) {
      expect(s.favorite).toBe(false);
      expect(s.favoriteSort).toBeNull();
    }
  });

  it('starSymbol 收藏置顶：getSymbols 反映 favorite=true + favoriteSort 升序且收藏优先；重复 star 幂等', async () => {
    const api = createMockClient();
    await api.starSymbol('513310');
    await api.starSymbol('518880');
    await api.starSymbol('513310'); // 幂等：不追加
    const symbols = await api.getSymbols();
    expect(symbols[0]).toMatchObject({ code: '513310', favorite: true, favoriteSort: 1 });
    expect(symbols[1]).toMatchObject({ code: '518880', favorite: true, favoriteSort: 2 });
    // 收藏优先：前两名为收藏，非收藏在后
    expect(symbols.slice(0, 2).every((s) => s.favorite === true)).toBe(true);
    expect(symbols.slice(2).every((s) => s.favorite === false)).toBe(true);
  });

  it('unstarSymbol 取消收藏（幂等）：getSymbols 回退 favorite=false, favoriteSort=null；仍非收藏在先', async () => {
    const api = createMockClient();
    await api.starSymbol('513310');
    await api.unstarSymbol('513310');
    await api.unstarSymbol('513310'); // 幂等
    const symbols = await api.getSymbols();
    expect(symbols.find((s) => s.code === '513310')).toMatchObject({ favorite: false, favoriteSort: null });
  });

  it('reorderFavorites 批量重排：codes 顺序即展示顺序；含未收藏 code → 400', async () => {
    const api = createMockClient();
    await api.starSymbol('518880');
    await api.starSymbol('513310');
    await api.starSymbol('161226');
    await api.reorderFavorites(['161226', '518880', '513310']);
    const symbols = await api.getSymbols();
    expect(symbols.slice(0, 3).map((s) => s.code)).toEqual(['161226', '518880', '513310']);
    expect(symbols[0]).toMatchObject({ code: '161226', favorite: true, favoriteSort: 1 });
    await expect(api.reorderFavorites(['518880', '000000'])).rejects.toMatchObject({ status: 400 });
  });

  it('star/unstar 未知 code 404（符号须已注册）', async () => {
    const api = createMockClient();
    await expect(api.starSymbol('000000')).rejects.toMatchObject({ status: 404 });
    await expect(api.unstarSymbol('000000')).rejects.toMatchObject({ status: 404 });
  });

  // ── 行情看板 MA 可配置（W2：GET/PUT /api/config/ma；主图+宫格应用，回测弹窗不动）──

  it('getMaConfig 默认 [5,10,20]；saveMaConfig 归一化（去重升序）并持久化', async () => {
    const api = createMockClient();
    const cfg = await api.getMaConfig();
    expect(cfg.windows).toEqual([5, 10, 20]);

    // 归一化：乱序 + 去重 → 升序（count 校验在去重前，故入参 ≤3 条）
    const saved = await api.saveMaConfig([20, 5, 20]); // 3 条含重复
    expect(saved.windows).toEqual([5, 20]); // 去重保留首次出现 [20,5]，升序→[5,20]
    expect((await api.getMaConfig()).windows).toEqual([5, 20]);

    const saved2 = await api.saveMaConfig([7, 50, 20]);
    expect(saved2.windows).toEqual([7, 20, 50]); // 升序归一
    expect((await api.getMaConfig()).windows).toEqual([7, 20, 50]);
  });

  it('saveMaConfig 校验：空/超 3 条/越界 → 400 + 非法值透传', async () => {
    const api = createMockClient();
    await expect(api.saveMaConfig([])).rejects.toMatchObject({ status: 400 });
    await expect(api.saveMaConfig([5, 10, 20, 30])).rejects.toMatchObject({ status: 400 });
    await expect(api.saveMaConfig([0])).rejects.toMatchObject({ status: 400 });
    await expect(api.saveMaConfig([501])).rejects.toMatchObject({ status: 400 });
  });

  // ── 行情看板 dcap 显示参数（GET/PUT /api/config/dcap；8 参不含 th）──

  it('getDcapConfig 默认 8/26/60/1/1/1/1/3；saveDcapConfig 持久化并回显（含小数 r）', async () => {
    const api = createMockClient();
    expect(await api.getDcapConfig()).toEqual({ n_s: 8, n_m: 26, n_l: 60, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3 });
    const next = { n_s: 5, n_m: 10, n_l: 20, r_s: 1.5, r_m: 1, r_l: 1.02, smooth: 0, m: 5 };
    expect(await api.saveDcapConfig(next)).toEqual(next);
    expect(await api.getDcapConfig()).toEqual(next);
  });

  it('saveDcapConfig 校验（与后端同构）：非单调 n / 越界 / 非整数 / smooth 非法 → 400', async () => {
    const api = createMockClient();
    const base = { n_s: 8, n_m: 26, n_l: 60, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3 };
    const bads = [
      { ...base, n_s: 26, n_m: 26 },
      { ...base, n_m: 60, n_l: 26 },
      { ...base, n_l: 251 },
      { ...base, m: 61 },
      { ...base, n_s: 8.5 },
      { ...base, r_s: 0.49 },
      { ...base, smooth: 2 },
    ];
    for (const bad of bads) {
      await expect(api.saveDcapConfig(bad)).rejects.toMatchObject({ status: 400 });
    }
    // 400 不落库（仍为默认）
    expect(await api.getDcapConfig()).toEqual(base);
  });

  // ── 页面⑨ 模拟实盘（§1.6；与 MCP 共享同一服务）──

  it('getSimState 返回活跃会话（账户/持仓/P&L/开关）', async () => {
    const api = createMockClient();
    const st = await api.getSimState();
    expect(st.active).toBe(true);
    expect(st.session?.status).toBe('running');
    expect(st.account?.cash).toBeGreaterThan(0);
    expect(st.positions.length).toBe(2);
    expect(st.pnl).toBeTruthy();
    expect(typeof st.trading_enabled).toBe('boolean');
    expect(st.mcp_enabled).toBe(true);
  });

  it('getSimStrategies 返回每策略最强 + 每 stock 聚合/独立分', async () => {
    const api = createMockClient();
    const s = await api.getSimStrategies();
    expect(s.strategies.length).toBe(3);
    expect(s.strategies.some((x) => x.strongest?.code === '518880')).toBe(true);
    const stock = s.stocks.find((x) => x.code === '518880')!;
    expect(stock.aggregate_score).toBe(72);
    expect(stock.per_strategy_scores.length).toBe(3);
    expect(stock.per_strategy_scores[0]!.strategy_id).toBe('dual_ma');
  });

  it('startSimSession 带 strategies（每策略参数/标的子集/权重+股票级权重）→ 派生聚合评分', async () => {
    const api = createMockClient();
    await api.startSimSession({
      name: 't', period: 'M1',
      strategies: [
        { strategy_id: 'dual_ma', params: { fast: 2, slow: 3 }, stocks: ['518880'], weight: 1.0, stock_weights: { '518880': 3.0 } },
        { strategy_id: 'macd', stocks: ['518880'], weight: 1.0 },
      ],
    });
    const s = await api.getSimStrategies();
    // 会话 strategy_set/stock_set 由策略派生。
    expect((await api.getSimState()).session?.strategy_set).toEqual(['dual_ma', 'macd']);
    expect((await api.getSimState()).session?.stock_set).toEqual(['518880']);
    // 聚合权重：dual_ma 518880 权重=3、macd 权重=1 → (3*86 + 1*12)/4 = 67.5 → 68。
    const stock = s.stocks.find((x) => x.code === '518880')!;
    expect(stock.per_strategy_scores.length).toBe(2);
    expect(stock.aggregate_score).toBe(68);
  });

  it('startSimSession 重置账户/持仓/订单；stopSimSession 写入历史；toggle 开关读回', async () => {
    const api = createMockClient();
    const before = await api.getSimState();
    await api.startSimSession({ name: 't2', period: 'M1', cash_init: 500_000 });
    const after = await api.getSimState();
    expect(after.session?.name).toBe('t2');
    expect(after.account?.cash).toBe(500_000);
    expect(after.positions.length).toBe(0);
    expect(after.trading_enabled).toBe(false);

    // 统一交易开关 / MCP 开关
    expect((await api.toggleSimTrading({ enabled: true })).trading_enabled).toBe(true);
    expect((await api.getSimState()).trading_enabled).toBe(true);
    expect((await api.toggleSimMcp({ enabled: false })).mcp_enabled).toBe(false);
    expect((await api.getSimState()).mcp_enabled).toBe(false);

    // 停会话 → 历史列表出现 ended 会话
    await api.stopSimSession({});
    const sessions = await api.getSimSessions();
    expect(sessions.some((h) => h.session.status === 'ended')).toBe(true);
    void before;
  });

  it('placeSimOrder 市价成交更新持仓/账户；cancelSimOrder 撤 pending；runSimBacktestCompare 触发 run', async () => {
    const api = createMockClient();
    await api.startSimSession({ name: 't3', period: 'M1' });
    const filled = await api.placeSimOrder({ code: '510300', side: 'buy', qty: 1000, price: 10.0 });
    expect(filled.filled).toBe(true);
    const pos = (await api.getSimPositions()).positions;
    expect(pos.some((p) => p.code === '510300')).toBe(true);

    // pending 单 → 可撤
    const pend = await api.placeSimOrder({ code: '159577', side: 'buy', qty: 1000, price: 1.5, limit_price: 1.4 });
    expect(pend.filled).toBe(false);
    const ordersResp = await api.getSimOrders();
    const order = ordersResp.orders.find((o) => o.status === 'pending')!;
    expect((await api.cancelSimOrder({ session_id: ordersResp.session_id, order_id: order.id })).cancelled).toBe(true);

    // 历史「回测一下」
    const cmp = await api.runSimBacktestCompare('s_old11');
    expect(cmp.run_ids.length).toBeGreaterThan(0);
    expect(cmp.session_id).toBe('s_old11');
  });
});

describe('策略 Registry mock（12-strategy-system / P2b；§1.7 契约行为）', () => {
  it('manage 列表含仅 draft 策略（version_count/latest_version/latest_published 口径）', async () => {
    const api = createMockClient();
    const items = await api.getStrategyManageList();
    expect(items).toHaveLength(3);
    const draft = items.find((x) => x.id === 'st_mock_draft')!;
    expect(draft.version_count).toBe(1);
    expect(draft.latest_version?.status).toBe('draft');
    expect(draft.latest_published).toBeNull();
    const dual = items.find((x) => x.id === 'st_mock_dual_ma')!;
    expect(dual.version_count).toBe(2);
    expect(dual.latest_version?.version).toBe(2);
    expect(dual.latest_published?.version).toBe(1);
  });

  it('catalog 仅 published 且 level at-least 过滤；kind=template 过滤模板', async () => {
    const api = createMockClient();
    const all = await api.getStrategyCatalog();
    expect(all.map((e) => e.strategy.id).sort()).toEqual(['st_mock_dual_ma', 'st_mock_tpl_pure']);
    // at-least：live_approved 无满足者；sim_ok 剩 dual_ma（v1 sim_ok）
    expect(await api.getStrategyCatalog({ level: 'live_approved' })).toHaveLength(0);
    expect((await api.getStrategyCatalog({ level: 'sim_ok' })).map((e) => e.strategy.id)).toEqual(['st_mock_dual_ma']);
    expect((await api.getStrategyCatalog({ kind: 'template' })).map((e) => e.strategy.id)).toEqual(['st_mock_tpl_pure']);
  });

  it('create/patch/版本流转：create v1 draft → 201 形状；patch 名称；publish/archived 流转', async () => {
    const api = createMockClient();
    const { strategy, version } = await api.createStrategy({ name: ' 新策略 ', code: 'function on_bar(ctx){return 50;}' });
    expect(strategy.name).toBe('新策略');
    expect(version.status).toBe('draft');
    expect(version.version).toBe(1);
    const patched = await api.patchStrategy(strategy.id, { description: 'd' });
    expect(patched.description).toBe('d');
    await expect(api.patchStrategy(strategy.id, {})).rejects.toMatchObject({ status: 400 });
    const pub = await api.publishStrategyVersion(version.id);
    expect(pub.status).toBe('published');
    const arch = await api.archiveStrategyVersion(version.id);
    expect(arch.status).toBe('archived');
    // draft 不可归档（409）
    await expect(api.archiveStrategyVersion('sv_mock_dual_v2')).rejects.toMatchObject({ status: 409 });
  });

  it('update_draft：draft 原地 updated；published 自动 new_draft（version+1）；archived 409', async () => {
    const api = createMockClient();
    const upd = await api.updateStrategyVersion('sv_mock_dual_v2', 'function on_bar(ctx){return 51;}');
    expect(upd.outcome).toBe('updated');
    expect(upd.version.version).toBe(2);
    const nd = await api.updateStrategyVersion('sv_mock_dual_v1', 'function on_bar(ctx){return 52;}');
    expect(nd.outcome).toBe('new_draft');
    expect(nd.version.version).toBe(3);
    expect(nd.version.status).toBe('draft');
    // 归档 v1 后再编辑 → 409
    await api.archiveStrategyVersion('sv_mock_tpl_v1');
    await expect(api.updateStrategyVersion('sv_mock_tpl_v1', 'function on_bar(ctx){return 1;}')).rejects.toMatchObject({ status: 409 });
  });

  it('diff：返回两端 code；未知版本 404。test-run：code/version_id 二选一校验 + 双模式输出', async () => {
    const api = createMockClient();
    const d = await api.diffStrategyVersions('sv_mock_dual_v1', 'sv_mock_dual_v2');
    expect(d.from.version).toBe(1);
    expect(d.to.code).toContain('v2 draft 调整');
    await expect(api.diffStrategyVersions('sv_missing', 'sv_mock_dual_v2')).rejects.toMatchObject({ status: 404 });
    // 二选一
    await expect(
      api.runStrategyTest({ symbol: '518880', period: 'D1', from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z', mode: 'pure_score' }),
    ).rejects.toMatchObject({ status: 400 });
    const pure = await api.runStrategyTest({
      code: 'function on_bar(ctx){return 50;}', symbol: '518880', period: 'D1',
      from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z', mode: 'pure_score',
    });
    expect(pure.scores.length).toBeGreaterThan(0);
    expect(pure.trades).toEqual([]);
    const sim = await api.runStrategyTest({
      versionId: 'sv_mock_dual_v1', symbol: '518880', period: 'D1',
      from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z', mode: 'sim_position',
    });
    expect(sim.trades.length).toBeGreaterThan(0);
    expect(sim.signals.length).toBeGreaterThan(0);
    expect(sim.truncated).toEqual({ scores: false, events: false, trades: false });
  });

  it('MINOR-3：保存时重解析代码 PARAMS_SCHEMA（draft 原地 / published→new_draft 均生效；解析失败置空数组）', async () => {
    const api = createMockClient();
    const code = `const PARAMS_SCHEMA = [
  { key: "bias", type: "float", default: 0.5, min: 0, max: 1, description: "偏移" },
  { key: "n", type: "int", default: 9, min: 2, max: 60 }
];
function on_bar(ctx) { return 50; }
`;
    // draft 原地保存 → schema 重解析
    const upd = await api.updateStrategyVersion('sv_mock_dual_v2', code);
    expect(upd.outcome).toBe('updated');
    expect(upd.version.params_schema.map((p) => p.key)).toEqual(['bias', 'n']);
    expect(upd.version.params_schema[0]).toMatchObject({ key: 'bias', type: 'float', default: 0.5, min: 0, max: 1 });
    // published → new_draft 分支同样重解析
    const nd = await api.updateStrategyVersion('sv_mock_dual_v1', code);
    expect(nd.outcome).toBe('new_draft');
    expect(nd.version.params_schema.map((p) => p.key)).toEqual(['bias', 'n']);
    // 无 PARAMS_SCHEMA（解析失败）→ 空数组
    const none = await api.updateStrategyVersion('sv_mock_dual_v2', 'function on_bar(ctx){return 1;}');
    expect(none.version.params_schema).toEqual([]);
  });

  it('N2-MINOR-4（重写）：试算无日历档——与 contract-vectors.json::span_limit_semantics 绑定', async () => {
    const api = createMockClient();
    const base = { code: 'function on_bar(ctx){return 50;}', symbol: '518880', mode: 'pure_score' as const };

    // ① 向量绑定：日历档已删（`calendar_day_cap = null` + 删除的常量名）
    expect(SPAN.calendar_day_cap).toBeNull();
    expect(SPAN.deleted_constants).toContain('MINUTE_MAX_SPAN_DAYS');
    expect(SPAN.deleted_constants).toContain('D1_MAX_SPAN_DAYS');

    // ② D1 七年跨度（旧档 5 年 ⇒ 旧 mock 必 400）⇒ 新语义：**受理**（数据范围内的长区间不收缩）
    const d1 = await api.runStrategyTest({
      ...base, period: 'D1', from: '2019-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z',
    });
    expect(d1.mode).toBe('pure_score');
    expect(d1.requested_from).toBe('2019-01-01T00:00:00.000Z');
    expect(d1.requested_to).toBe('2026-01-01T00:00:00.000Z');
    expect(d1.clamped).toBe(false);
    expect(d1.clamp_reason).toBeNull();

    // ②b 起点早于可得数据 ⇒ 收缩回显（`clamp.mode = intersect_available_range`）
    expect(SPAN.clamp.mode).toBe('intersect_available_range');
    const c = await api.runStrategyTest({
      ...base, period: 'D1', from: '2010-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z',
    });
    expect(c.clamped).toBe(true);
    expect(c.clamp_reason).toBe('data_range');
    expect(Date.parse(c.effective_from!)).toBeGreaterThan(Date.parse(c.requested_from!));
    expect(Date.parse(c.effective_to!)).toBe(Date.parse(c.requested_to!));

    // ④ `clamp.echo_fields` 全部必须回显（向量增字段 ⇒ 本断言红）
    const resp = c as unknown as Record<string, unknown>;
    for (const f of SPAN.clamp.echo_fields) {
      expect(Object.prototype.hasOwnProperty.call(resp, f), `回显字段 ${f}`).toBe(true);
    }

    // ⑤ M1 × 1 年：**不再**按日历档拒绝；改由资源护栏（与后端同阈值镜像）二次确认
    const guardCode = SPAN.resource_guard.code;
    expect(SPAN.resource_guard.requires_confirmation).toBe(true);
    const err = await api
      .runStrategyTest({ ...base, period: 'M1', from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
      .then(() => null)
      .catch((e: unknown) => e as { status: number; code?: string; detail?: Record<string, unknown> });
    expect(err, 'M1 × 1 年（约 52.6 万 bar）应触发资源护栏').not.toBeNull();
    expect(err!.status).toBe(400);
    expect(err!.code).toBe(guardCode);
    expect(typeof err!.detail?.estimated_secs).toBe('number');
    expect(err!.detail?.confirmable).toBe(true);
    // confirm 语义：带 confirm=true 重提 ⇒ 放行
    const ok = await api.runStrategyTest({
      ...base, period: 'M1', from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z', confirm: true,
    });
    expect(ok.bar_count).toBeGreaterThan(0);

    // ⑥ 无数据/无交集 ⇒ `empty_intersection.code`（带可用区间回显）
    expect(SPAN.empty_intersection.http).toBe(400);
    const empty = await api
      .runStrategyTest({ ...base, symbol: '999999', period: 'M1', from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' })
      .then(() => null)
      .catch((e: unknown) => e as { status: number; code?: string; detail?: Record<string, unknown> });
    expect(empty!.status).toBe(SPAN.empty_intersection.http);
    expect(empty!.code).toBe(SPAN.empty_intersection.code);
    expect(empty!.detail).toHaveProperty('available_from');

    // ⑦ 短区间仍受理（回归保护：mock 不得对正常区间变苛刻）
    const short = await api.runStrategyTest({
      ...base, period: 'M1', from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z',
    });
    expect(short.bar_count).toBeGreaterThan(0);
    expect(short.clamped).toBe(false);
  });

  it('N2-防漂移（源码级）：mock 不得再实现日历天数档常量/分支', () => {
    const src = readFileSync(resolve(HERE, './mock.ts'), 'utf8');
    for (const c of SPAN.deleted_constants) {
      // 只禁**代码**（常量声明/使用），文档注释中提及已删常量名属允许（历史说明）。
      expect(new RegExp(`(const|let|var)\\s+\\w*${c}`).test(src), `mock 不得复活已删常量 ${c}`).toBe(false);
      expect(new RegExp(`${c}\\s*:`).test(src)).toBe(false);
    }
    expect(src.includes('试算区间超限')).toBe(false);
    expect(src.includes('跨度')).toBe(false);
  });

  it('N2-回显：P5 抽样/预估字段在试算响应可见（D11/§3.1）', async () => {
    const api = createMockClient();
    const r: StrategyTestRunResp = await api.runStrategyTest({
      code: 'function on_bar(ctx){return 50;}', symbol: '518880', period: 'D1',
      from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z', mode: 'pure_score',
    });
    expect(r.downsampled).toBe(false);
    expect(r.original_points).toBe(30);
    expect(r.estimated_bars).toBe(30);
    expect(r.clamp_reason).toBeNull();
    // 抽样语义镜像：预估点数 > mock 点数 ⇒ downsampled=true（保首尾与后端同语义，见 §1.6）
    const long = await api.runStrategyTest({
      code: 'function on_bar(ctx){return 50;}', symbol: '518880', period: 'D1',
      from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z', mode: 'pure_score',
    });
    expect(long.downsampled).toBe(true);
    expect(long.original_points).toBeGreaterThan(30);
  });

  it('NIT-1：patch 校验顺序对齐后端——先 400（空 patch / name trim 后空）后 404（未知 id）', async () => {
    const api = createMockClient();
    await expect(api.patchStrategy('st_missing', {})).rejects.toMatchObject({ status: 400 });
    await expect(api.patchStrategy('st_missing', { name: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(api.patchStrategy('st_missing', { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('回测工作台 mock（12-strategy-system / P3b；§1.8 契约行为同构）', () => {
  const validSubmit = () => ({
    symbol: '518880',
    period: 'D1',
    from: '2026-01-01T00:00:00Z',
    to: '2026-04-01T00:00:00Z',
    slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    policy: { LumpSum: { position_pct: 1 } } as const,
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
  });

  it('种子 runs：succeeded/running/failed 三态齐备；列表 created_at DESC, id DESC + limit/offset 分页 + status 过滤', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const all = await api.listWorkbenchRuns();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const statuses = new Set(all.map((r) => r.status));
    expect(statuses.has('succeeded')).toBe(true);
    expect(statuses.has('running')).toBe(true);
    expect(statuses.has('failed')).toBe(true);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!;
      const cur = all[i]!;
      expect(prev.created_at > cur.created_at || (prev.created_at === cur.created_at && prev.id > cur.id)).toBe(true);
    }
    const succ = await api.listWorkbenchRuns({ status: 'succeeded' });
    expect(succ.every((r) => r.status === 'succeeded')).toBe(true);
    const page = await api.listWorkbenchRuns({ limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]!.id).toBe(all[1]!.id);
  });

  it('submit 校验：symbol 未注册/period 非法/from≥to/slots 空/weight≤0/阈值倒挂/fee 缺键 → 400；version 未知 404、非 published 400', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), symbol: '999999' })).rejects.toMatchObject({ status: 400 });
    // ADR-024 P0：周期白名单收敛为单一事实源——H1/M30 已为合法回测档位，
    // 非法样例改用看板扩展周期 W1（与后端 api_workbench.rs 同类样例一致）。
    await expect(api.submitWorkbenchRun({ ...validSubmit(), period: 'W1' })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), from: '2026-04-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [] })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [{ version_id: 'sv_mock_dual_v1', weight: 0 }] })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), buy_threshold: 30, sell_threshold: 70 })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), fee: { rate_pct: 0.025 } as never })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [{ version_id: 'sv_nope', weight: 1 }] })).rejects.toMatchObject({ status: 404 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [{ version_id: 'sv_mock_dual_v2', weight: 1 }] })).rejects.toMatchObject({ status: 400 });
  });

  it('ADR-024 P0：submit 接受 SSOT 全集（含 M30/H1）而不再拒绝 H1；W1 仍 400', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    for (const period of SUPPORTED_BACKTEST_PERIODS) {
      const run = await api.submitWorkbenchRun({ ...validSubmit(), period });
      expect(run.period).toBe(period);
    }
    await expect(api.submitWorkbenchRun({ ...validSubmit(), period: 'W1' })).rejects.toMatchObject({ status: 400 });
  });

  it('submit 校验：params 未知键 → 400（对齐后端 fill_and_validate_params 拒绝语义）；已知键正常填充缺省', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    await expect(
      api.submitWorkbenchRun({
        ...validSubmit(),
        slots: [{ version_id: 'sv_mock_dual_v1', weight: 1, params: { fast: 5, nope: 1 } }],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('未知参数键') });
    // 已知键子集：其余按 schema 缺省填充（与后端同口径）
    const run = await api.submitWorkbenchRun({
      ...validSubmit(),
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1, params: { fast: 7 } }],
    });
    expect(run.config.slots[0]!.params).toEqual({ fast: 7, slow: 20 });
  });

  it('submit 成功：config 钉住（slots 展开 strategy_id/version/sha256，params 按 schema 缺省填充；阈值/资金缺省 60/40/100000），结果可取', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await api.submitWorkbenchRun(validSubmit());
    expect(run.id).toMatch(/^sr_/);
    expect(run.config.slots).toHaveLength(1);
    const slot = run.config.slots[0]!;
    expect(slot.strategy_id).toBe('st_mock_dual_ma');
    expect(slot.version).toBe(1);
    expect(slot.sha256).toBeTruthy();
    expect(slot.params).toEqual({ fast: 5, slow: 20 }); // schema 缺省填充
    expect(run.config.buy_threshold).toBe(60);
    expect(run.config.sell_threshold).toBe(40);
    expect(run.config.initial_capital).toBe(100000);
    // ADR-024 P6：新提交 run = `chunked_v1` ⇒ `/result` 回 summary + 首页 per_bar + has_more/next_offset
    // （net_value/drawdown 为空——图表改走 `/curve`；禁止把占位当数据）。
    const res = await api.getWorkbenchResult(run.id);
    expect(res.result_format).toBe('chunked_v1');
    expect(res.per_bar.length).toBeGreaterThan(0);
    expect(res.per_bar[0]).toMatchObject({ ts: expect.any(Number), aggregate: expect.any(Number), signal: expect.stringMatching(/Buy|Sell|Hold/) });
    expect(res.per_bar[0]!.scores[0]).toMatchObject({ slot_idx: 0, score: expect.any(Number) });
    expect(res.has_more).toBe(false); // 60 根 ≤ 页 5000
    expect(res.summary?.bars_total).toBe(res.per_bar.length);
    expect(res.summary?.result_format).toBe('chunked_v1');
    expect(res.net_value).toEqual([]); // 契约：chunked 不在 /result 内联净值
    expect(res.drawdown).toEqual([]);
    expect(res.metrics).toMatchObject({ net_profit: expect.any(Number), trade_count: expect.any(Number) });
    expect(res.trades.length).toBeGreaterThan(0);

    // `/curve` 是图表取数路径（显式抽样 + downsampled/original_bars）
    const nv = await api.getWorkbenchCurve(run.id, { kind: 'net_value', k: 10 });
    expect(nv.original_bars).toBeGreaterThan(0);
    expect(nv.downsampled).toBe(nv.points.length < nv.original_bars);
    expect(nv.points[0]).toHaveLength(2);
  });

  it('ADR-024 P6：/brief /bars /fills 契约形状（分页字段与 recorded 语义）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await api.submitWorkbenchRun(validSubmit());

    const brief = await api.getWorkbenchBrief(run.id);
    expect(brief).toMatchObject({
      id: run.id, status: 'succeeded', result_format: 'chunked_v1', clamped: false,
    });
    expect(brief.bars_total).toBeGreaterThan(0);
    await expect(api.getWorkbenchBrief('sr_nope')).rejects.toMatchObject({ status: 404 });

    // /bars 分页：has_more/next_offset 必须可用（消费方禁止静默只显首页）
    const all = await api.getWorkbenchBars(run.id, { kind: 'per_bar', offset: 0, limit: 5000 });
    expect(all.kind).toBe('per_bar');
    expect(all.bars.length).toBe(all.total);
    expect(all.has_more).toBe(false);
    expect(all.next_offset).toBeNull();
    const p1 = await api.getWorkbenchBars(run.id, { kind: 'per_bar', offset: 0, limit: 2 });
    expect(p1.bars).toHaveLength(2);
    expect(p1.has_more).toBe(true);
    expect(p1.next_offset).toBe(2);
    expect(p1.total).toBe(all.total);
    // 区间读（服务端按 ts 过滤）
    const from = new Date(all.bars[1]!.ts * 1000).toISOString();
    const to = new Date(all.bars[3]!.ts * 1000).toISOString();
    const rg = await api.getWorkbenchBars(run.id, { kind: 'per_bar', from, to });
    expect(rg.bars).toHaveLength(3);

    // /fills：有界精确源（TREND 之外的 CONST 插件可能 0 笔，但 recorded 必为 true）
    const fills = await api.getWorkbenchFills(run.id, { limit: 5000 });
    expect(fills).toMatchObject({ run_id: run.id, recorded: true, offset: 0, limit: 5000 });
    expect(fills.fills).toHaveLength(fills.total);
    for (const x of fills.fills) {
      expect(x).toMatchObject({ type: 'fill', ts: expect.any(Number), reason: expect.any(String) });
    }
    // 分页
    const fp = await api.getWorkbenchFills(run.id, { offset: 0, limit: 1 });
    expect(fp.fills.length).toBe(Math.min(1, fills.total));
    expect(fp.has_more).toBe(fills.total > 1);
    await expect(api.getWorkbenchFills('sr_nope')).rejects.toMatchObject({ status: 404 });
  });

  it('ADR-027 v2：/round-trips（L1 摘要 + 分页）与 /round-trips/{rt_seq}/fills（L2 切片 + 未知 rt_seq 404）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await api.submitWorkbenchRun(validSubmit());
    const all = await api.getWorkbenchRoundTrips(run.id, { offset: 0, limit: 200 });
    expect(all.run_id).toBe(run.id);
    expect(all.recorded).toBe(true);
    expect(all.round_trips.length).toBe(all.total);
    expect(all.has_more).toBe(false);

    for (const rt of all.round_trips) {
      // D8 摘要：l2_count == 该回合 fills 数；买卖笔数 == 各自侧计数
      const l2 = await api.getWorkbenchRoundTripFills(run.id, rt.rt_seq);
      expect(l2.total).toBe(rt.l2_count);
      expect(l2.fills.length).toBe(rt.l2_count);
      expect(l2.fills.filter((f) => f.side === 'Buy').length).toBe(rt.buy_count);
      expect(l2.fills.filter((f) => f.side === 'Sell').length).toBe(rt.sell_count);
      // I2 恒等式：Σ(L2) 逐字段 == L1（浮点逐位；mock 的 L1 由账本派生）
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      expect(sum(l2.fills.map((f) => f.commission))).toBe(rt.commission);
      expect(sum(l2.fills.map((f) => f.stamp_duty))).toBe(rt.stamp_duty);
      expect(sum(l2.fills.filter((f) => f.side === 'Sell').map((f) => f.trade_value))).toBe(rt.gross_value);
      // 元素形状（§5.4 新字段齐备）
      for (const f of l2.fills) {
        expect(f).toMatchObject({ rt_seq: rt.rt_seq, code: rt.code, trade_value: expect.any(Number), commission: expect.any(Number), stamp_duty: expect.any(Number) });
      }
    }

    // 分页：limit=1 ⇒ has_more/next_offset 正确
    if (all.total > 1) {
      const p1 = await api.getWorkbenchRoundTrips(run.id, { offset: 0, limit: 1 });
      expect(p1.round_trips).toHaveLength(1);
      expect(p1.has_more).toBe(true);
      expect(p1.next_offset).toBe(1);
    }
    // 未知 rt_seq ⇒ 404（禁空数组冒充「无成交」）
    await expect(api.getWorkbenchRoundTripFills(run.id, 99_999)).rejects.toMatchObject({ status: 404 });

    // /fills 元素增 rt_seq + 费用三件套（§5.4）
    const fills = await api.getWorkbenchFills(run.id, { limit: 5000 });
    for (const f of fills.fills) {
      expect(f.rt_seq).toBeGreaterThan(0);
      expect(Number.isFinite(f.trade_value)).toBe(true);
      expect(Number.isFinite(f.commission)).toBe(true);
      expect(Number.isFinite(f.stamp_duty)).toBe(true);
    }

    // /audit 增量（§5.5）：closed/open 与 rt_reconcile（mock 由账本派生 ⇒ mismatched 空）
    const audit = await api.getRunAudit(run.id);
    expect(audit.round_trips_closed).toBe(all.total);
    expect(audit.round_trips_open).toBe(0);
    expect(audit.rt_reconcile).toMatchObject({ checked: all.total, mismatched: [] });

    // /curve：window 回显（缺省全区间 = null）+ kind=position（ADR-027 §4.1/ADR-028 D3）
    const nv = await api.getWorkbenchCurve(run.id, { kind: 'net_value' });
    expect(nv.window_from_ts).toBeNull();
    expect(nv.window_to_ts).toBeNull();
    expect(nv.window_bars).toBe(nv.original_bars);
    const pos = await api.getWorkbenchCurve(run.id, { kind: 'position' });
    expect(pos.points.length).toBeGreaterThan(0);
    for (const p of pos.points as Array<{ ts: number; qty: number; position_value: number; cash: number; nav: number; position_ratio: number }>) {
      expect(p.position_value + p.cash).toBeCloseTo(p.nav, 3); // 恒等式（mock 舍入到 3 位）
      expect(p.position_ratio).toBeCloseTo(p.nav > 0 ? p.position_value / p.nav : 0, 3);
    }
    const bars = (await api.getWorkbenchBars(run.id, { kind: 'per_bar' })).bars;
    const from = bars[2]!.ts;
    const to = bars[5]!.ts;
    const win = await api.getWorkbenchCurve(run.id, { kind: 'net_value', from_ts: from, to_ts: to, k: 10 });
    expect(win.window_from_ts).toBe(from);
    expect(win.window_to_ts).toBe(to);
    expect(win.window_bars).toBe(4); // 窗口内原始根数（抽样前）
  });

  it('ADR-024 P6：长区间（>5000 根）chunked ⇒ /result 首页 + has_more/next_offset（显式截断）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 12_000 });
    const run = await api.submitWorkbenchRun(validSubmit());
    const res = await api.getWorkbenchResult(run.id);
    expect(res.result_format).toBe('chunked_v1');
    expect(res.per_bar).toHaveLength(5000);
    expect(res.has_more).toBe(true);
    expect(res.next_offset).toBe(5000);
    // 逐页拉完 = 全量（不静默截断）
    const p2 = await api.getWorkbenchBars(run.id, { kind: 'per_bar', offset: 5000, limit: 5000 });
    expect(p2.bars).toHaveLength(5000);
    expect(p2.next_offset).toBe(10000);
    expect(p2.total).toBe(12_000);
    const p3 = await api.getWorkbenchBars(run.id, { kind: 'per_bar', offset: 10000, limit: 5000 });
    expect(p3.bars).toHaveLength(2000);
    expect(p3.has_more).toBe(false);
    // /curve 抽样（默认 k=2000 < 12000 ⇒ downsampled）
    const nv = await api.getWorkbenchCurve(run.id, { kind: 'net_value' });
    expect(nv.downsampled).toBe(true);
    expect(nv.original_bars).toBe(12_000);
  });

  it('cancel：running/queued → canceled；终态 → 409；未知 → 404', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const running = (await api.listWorkbenchRuns({ status: 'running' }))[0]!;
    const canceled = await api.cancelWorkbenchRun(running.id);
    expect(canceled.status).toBe('canceled');
    await expect(api.cancelWorkbenchRun(running.id)).rejects.toMatchObject({ status: 409 });
    const done = (await api.listWorkbenchRuns({ status: 'succeeded' }))[0]!;
    await expect(api.cancelWorkbenchRun(done.id)).rejects.toMatchObject({ status: 409 });
    await expect(api.cancelWorkbenchRun('sr_nope')).rejects.toMatchObject({ status: 404 });
  });

  it('compare：输入序并排 net_value+metrics；未知/未成功 run 跳过；空 ids → 400', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const r2 = await api.submitWorkbenchRun(validSubmit());
    const r1 = await api.submitWorkbenchRun({ ...validSubmit(), name: 'first' });
    const items = await api.compareWorkbenchRuns([r2.id, 'sr_nope', r1.id]);
    expect(items.map((i) => i.run_id)).toEqual([r2.id, r1.id]);
    expect(items[0]).toMatchObject({ symbol: '518880', period: 'D1' });
    expect(items[0]!.net_value.length).toBeGreaterThan(0);
    expect(items[0]!.metrics).toMatchObject({ sharpe: expect.any(Number) });
    await expect(api.compareWorkbenchRuns([])).rejects.toMatchObject({ status: 400 });
  });

  it('presets CRUD 闭环：create 钉住 → list/get/apply → update（重名 409）→ delete；非法入参 400/404', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const config = (await api.submitWorkbenchRun(validSubmit())).config;
    const created = await api.createWorkbenchPreset({ name: '组合A', config });
    expect(created.id).toMatch(/^sp_/);
    expect(created.config.slots[0]!.version_id).toBe('sv_mock_dual_v1');
    expect((await api.listWorkbenchPresets()).some((p) => p.id === created.id)).toBe(true);
    expect((await api.getWorkbenchPreset(created.id)).name).toBe('组合A');
    expect((await api.applyWorkbenchPreset(created.id)).slots).toHaveLength(1);
    const renamed = await api.updateWorkbenchPreset(created.id, { name: '组合B', config });
    expect(renamed.name).toBe('组合B');
    await expect(api.createWorkbenchPreset({ name: '组合B', config })).rejects.toMatchObject({ status: 409 });
    await expect(api.createWorkbenchPreset({ name: '  ', config })).rejects.toMatchObject({ status: 400 });
    await expect(api.createWorkbenchPreset({ name: '空配置', config: { ...config, slots: [] } })).rejects.toMatchObject({ status: 400 });
    await expect(api.updateWorkbenchPreset('sp_nope', { name: 'x', config })).rejects.toMatchObject({ status: 404 });
    await api.deleteWorkbenchPreset(created.id);
    await expect(api.getWorkbenchPreset(created.id)).rejects.toMatchObject({ status: 404 });
    await expect(api.deleteWorkbenchPreset(created.id)).rejects.toMatchObject({ status: 404 });
  });

  // ── ADR-026 §2.2：/audit mock（由 per_bar.orders/events + config 事实派生，与后端同口径）──

  it('ADR-026：/audit 由事实派生（recorded=true；batches_done=Buy 成交数；deployed=Σqty×price；cash=金额+佣金；Dca → DCA_PLAN_UNDERFILLED）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await api.submitWorkbenchRun({
      ...validSubmit(),
      policy: { Dca: { mode: 'Equal', tranches: 100, interval: 1 } },
    });
    const audit = await api.getRunAudit(run.id);
    expect(audit.run_id).toBe(run.id);
    expect(audit.recorded).toBe(true);
    expect(audit.capital_basis).toBe(100_000);
    expect(audit.planned_tranches).toBe(100);

    // 三方自洽：/fills 的 Buy 笔数 = batches_done；deployed/cash 由逐笔复算佣金（仓内 fee 契约）
    const fills = (await api.getWorkbenchFills(run.id, { limit: 5000 })).fills;
    const buys = fills.filter((f) => f.side === 'Buy');
    expect(audit.batches_done).toBe(buys.length);
    const notional = buys.reduce((s, f) => s + f.qty * f.price, 0);
    const commission = buys.reduce((s, f) => s + Math.max((f.qty * f.price * 0.025) / 100, 5), 0);
    expect(audit.deployed_notional).toBeCloseTo(notional, 6);
    expect(audit.cash_consumed).toBeCloseTo(notional + commission, 6);
    expect(audit.deployed_pct).toBeCloseTo(notional / 100_000, 9);
    expect(audit.cash_consumed_pct).toBeCloseTo((notional + commission) / 100_000, 9);
    expect(audit.round_trips_total).toBe((await api.getWorkbenchResult(run.id)).trades.length);
    expect(audit.round_trips_force_closed).toBeLessThanOrEqual(audit.round_trips_total);
    expect(audit.warnings.map((w) => w.code)).toContain('DCA_PLAN_UNDERFILLED');

    // 非 Dca → planned_tranches=null；未知 run / 无结果 run → 404
    const lump = await api.submitWorkbenchRun(validSubmit());
    expect((await api.getRunAudit(lump.id)).planned_tranches).toBeNull();
    await expect(api.getRunAudit('sr_nope')).rejects.toMatchObject({ status: 404 });
    const running = (await api.listWorkbenchRuns({ status: 'running' }))[0]!;
    await expect(api.getRunAudit(running.id)).rejects.toMatchObject({ status: 404 });
  });

  it('ADR-026：workbenchAuditMissing ⇒ recorded=false + 零值 + 空 warnings（前端须显「未记录」，不得显 0%）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchAuditMissing: true });
    const run = await api.submitWorkbenchRun(validSubmit());
    const audit = await api.getRunAudit(run.id);
    expect(audit).toMatchObject({
      run_id: run.id,
      recorded: false,
      capital_basis: 100_000,
      deployed_notional: 0,
      deployed_pct: 0,
      cash_consumed: 0,
      planned_tranches: null,
      reachable_batches: 0,
      batches_done: 0,
      unexecuted_orders: 0,
      last_bar_unfilled: false,
      round_trips_total: 0,
      round_trips_force_closed: 0,
      warnings: [],
    });
  });
});

describe('createMockClient（ADR-020：K线默认视口 = 根数口径 viewport_bars）', () => {
  it('getKlineConfig 缺省 120（与后端 DEFAULT_KLINE_VIEWPORT_BARS 同构）', async () => {
    const api = createMockClient();
    expect(await api.getKlineConfig()).toEqual({ viewport_bars: 120 });
  });

  it('saveKlineConfig 合法（30/120/600）→ 回显 viewport_bars 且 GET 读回一致', async () => {
    const api = createMockClient();
    for (const n of [30, 120, 600]) {
      expect(await api.saveKlineConfig(n)).toEqual({ viewport_bars: n });
      expect(await api.getKlineConfig()).toEqual({ viewport_bars: n });
    }
  });

  it('saveKlineConfig 越界/非整 → ApiError 400，且内存值不变', async () => {
    const api = createMockClient();
    await api.saveKlineConfig(300);
    for (const bad of [29, 601, 0, -1, 120.5]) {
      await expect(api.saveKlineConfig(bad)).rejects.toMatchObject({ status: 400 });
    }
    expect(await api.getKlineConfig()).toEqual({ viewport_bars: 300 });
  });
});

describe('多周期配置 mock（D5-2：与后端口径一致 —— indicators 归一化去重 + 基于去重集合计 pane）', () => {
  it('saveMultiPeriodConfig 归一化去重：["dcap","dcap"] ⇒ 回显/落库均为 ["dcap"]（GET 同）', async () => {
    const api = createMockClient();
    const cfg = {
      enabled: true,
      periods: ['1m', '5m'],
      heights: { '1m': 420, '5m': 180 },
      indicators: ['dcap', 'dcap'],
    };
    const out = await api.saveMultiPeriodConfig(cfg);
    expect(out.indicators).toEqual(['dcap']);
    // 落库形态也必须是归一化后的（非仅计数时去重）：GET 与 PUT 回显一致（02-spec §2 校验 6 / §7.4）
    expect(await api.getMultiPeriodConfig()).toEqual(out);
    expect((await api.getMultiPeriodConfig()).indicators).toEqual(['dcap']);
  });

  it('pane 计数基于去重后集合：4 周期 × ["dcap"]×5（原始 16 pane）⇒ 200 且归一化 ["dcap"]', async () => {
    const api = createMockClient();
    const cfg = {
      enabled: true,
      periods: ['1m', '5m', '15m', '1h'],
      heights: { '1m': 420, '5m': 180, '15m': 180, '1h': 180 },
      indicators: ['dcap', 'dcap', 'dcap', 'dcap', 'dcap'],
    };
    const out = await api.saveMultiPeriodConfig(cfg);
    expect(out.indicators).toEqual(['dcap']);
    expect((await api.getMultiPeriodConfig()).indicators).toEqual(['dcap']);
  });

  it('失败不改内存态：未支持指标 400 后 GET 仍为上一次成功落库值', async () => {
    const api = createMockClient();
    const ok = await api.saveMultiPeriodConfig({
      enabled: true,
      periods: ['1m', '5m'],
      heights: { '1m': 420, '5m': 180 },
      indicators: ['dcap', 'dcap'],
    });
    await expect(
      api.saveMultiPeriodConfig({ ...ok, indicators: ['dcap', 'macd'] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await api.getMultiPeriodConfig()).toEqual(ok);
  });
});

// ─────────────── ADR-024 P5 §5.2：可得区间 mock（日期控件 min/max 联动数据源） ───────────────

describe('createMockClient（ADR-024 P5：available_range / 收缩回显）', () => {
  it('getWorkbenchAvailableRange：已注册标的 → RFC3339 区间；非法 period → 400', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const r = await api.getWorkbenchAvailableRange('518880', 'D1');
    expect(r.symbol).toBe('518880');
    expect(r.period).toBe('D1');
    expect(r.available_from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.available_to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(api.getWorkbenchAvailableRange('518880', 'W1')).rejects.toMatchObject({ status: 400 });
  });

  it('未注册标的 → available_from/to 为 null（前端据此提示无数据）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const r = await api.getWorkbenchAvailableRange('999999', 'D1');
    expect(r.available_from).toBeNull();
    expect(r.available_to).toBeNull();
  });

  it('submitWorkbenchRun 回显 requested/effective/estimated_bars（P5 新增字段不缺）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await api.submitWorkbenchRun({
      symbol: '518880',
      period: 'D1',
      from: '2026-06-01T00:00:00Z',
      to: '2026-09-01T00:00:00Z',
      slots: [{ version_id: 'sv_mock_dual_v1', params: {}, weight: 1 }],
      policy: { LumpSum: { position_pct: 1 } },
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    });
    expect(run.clamped).toBe(false);
    expect(run.requested_from).toBe('2026-06-01T00:00:00.000Z');
    expect(typeof run.estimated_bars).toBe('number');
    expect(run.result_format).toBe('chunked_v1');
  });
});
