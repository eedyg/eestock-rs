import { describe, it, expect } from 'vitest';
import type { BacktestRunDto } from './types';
import { createMockClient } from './mock';

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

  // ── 页面⑤ 回测工作台（Wave 3 Phase 3c；契约 mock，恰 7 策略 + 四态种子 + 提交/网格展开）──

  it('getStrategies 返回恰 7 款内置策略，schema 含 key/label/kind', async () => {
    const api = createMockClient();
    const list = await api.getStrategies();
    expect(list).toHaveLength(7);
    const ids = list.map((s) => s.id);
    for (const id of ['dual_ma', 'ma_rsi', 'macd', 'boll', 'kdj', 'momentum', 'atr_channel']) {
      expect(ids).toContain(id);
    }
    for (const s of list) {
      expect(s.name).not.toBe('');
      expect(s.params_schema.length).toBeGreaterThan(0);
      const p = s.params_schema[0]!;
      expect(p.key).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(typeof p.kind).toBe('object');
    }
    // boll 含 Choice 参数（mode）
    const boll = list.find((s) => s.id === 'boll')!;
    const mode = boll.params_schema.find((p) => p.key === 'mode')!;
    expect(mode.kind).toHaveProperty('Choice');
  });

  it('submitRun 单 run → {run_id}，getRun 返回完成态（净值/指标/交易齐备）', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const resp = await api.submitRun({
      strategyId: 'dual_ma',
      params: { fast: 5, slow: 20 },
      code: '518880',
      period: '1d',
      fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 },
    });
    expect(resp.run_id).toBeGreaterThan(0);
    const run = await api.getRun(resp.run_id!);
    expect(run.status).toBe('done');
    expect(run.period).toBe('D1');
    expect(run.metrics).toHaveProperty('sharpe');
    expect(run.metrics!.trade_count).toBeGreaterThan(0);
    expect(run.net_value!.series.length).toBeGreaterThan(0);
    expect(run.net_value!.drawdown.length).toBe(run.net_value!.series.length);
    expect(run.trades!.length).toBeGreaterThan(0);
    expect(run.trades![0]).toHaveProperty('pnl');
  });

  it('submitRun 网格 → {group_id, run_ids}，list 按 group_id 过滤返回全部子任务', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const resp = await api.submitRun({
      strategyId: 'dual_ma',
      params: { fast: '3:9:2', slow: 20 },
      code: '518880',
      period: '1d',
      fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 },
    });
    expect(resp.group_id).toBeTruthy();
    expect(resp.run_ids!.length).toBe(4); // 3/5/7/9
    const group = await api.listRuns({ groupId: resp.group_id });
    expect(group).toHaveLength(4);
    for (const r of group) {
      expect(r.group_id).toBe(resp.group_id);
    }
  });

  it('listRuns 种子：done/running/pending/failed 四态齐备；列表轻量（不含结果）；compare 只含存在 run；getRun 才有结果', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const runs = await api.listRuns();
    const statuses = runs.map((r) => r.status);
    for (const st of ['pending', 'running', 'done', 'failed']) {
      expect(statuses).toContain(st);
    }
    const done = runs.find((r) => r.status === 'done')!;
    expect(done.id).toBeGreaterThan(0);
    // 轻量列表：结果列被剥离（性能根因——列表只需要元数据+状态）。
    expect(done.metrics).toBeUndefined();
    expect(done.net_value).toBeUndefined();
    expect(done.trades).toBeUndefined();
    // 结果仅 getRun 提供。
    const detail = await api.getRun(done.id);
    expect(detail.metrics).toBeDefined();
    expect(detail.net_value).toBeDefined();
    const cmp = await api.compare([done.id, 999999]);
    expect(cmp).toHaveLength(1);
    expect(cmp[0]!.id).toBe(done.id);
  });

  it('listRuns 分页：created_at DESC, id DESC + limit/offset 切片；未传 limit 返回全部', async () => {
    const seeds: BacktestRunDto[] = Array.from({ length: 120 }, (_, i) => ({
      id: 100 + i,
      code: '518880',
      period: 'D1',
      strategy_id: 'dual_ma',
      params: {},
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
      status: 'done',
      progress: 100,
      current_ts: null,
      // 秒递增 → created_at 单调于 id → created_at DESC, id DESC 等价 id DESC。
      created_at: new Date(2026, 8, 4, 0, 0, i).toISOString(),
      finished_at: '2026-09-04T02:00:00Z',
      error: null,
      group_id: i % 10 === 0 ? 'g_pg' : null,
    }));
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z'), backtestRuns: seeds });
    // 未传 limit → 返回全部
    const all = await api.listRuns();
    expect(all.length).toBe(120);
    // limit=100 offset=0 → 100 条，id DESC（最新 id 最大在前）
    const p1 = await api.listRuns({ limit: 100, offset: 0 });
    expect(p1.length).toBe(100);
    expect(p1[0]!.id).toBe(219);
    expect(p1[99]!.id).toBe(120);
    // offset=100 → 20 条
    const p2 = await api.listRuns({ limit: 100, offset: 100 });
    expect(p2.length).toBe(20);
    expect(p2[0]!.id).toBe(119);
    expect(p2[19]!.id).toBe(100);
    // 结果列剥离
    expect(p1[0]!.metrics).toBeUndefined();
  });

  it('deleteRun 删除 run（列表反映）；不存在 throw 404', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const runs = await api.listRuns();
    expect(runs.length).toBeGreaterThan(0);
    const id = runs[0]!.id;
    await api.deleteRun(id);
    const after = await api.listRuns();
    expect(after.some((r) => r.id === id)).toBe(false);
    await expect(api.deleteRun(999999)).rejects.toMatchObject({ status: 404 });
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

  it('MINOR-4：试算区间上限对齐后端（D1≤5年 / 分钟级≤3个月）超限 → 400', async () => {
    const api = createMockClient();
    const base = { code: 'function on_bar(ctx){return 50;}', symbol: '518880', mode: 'pure_score' as const };
    // D1 五年内存量 OK（1826 天 ≤ 1830）
    await expect(
      api.runStrategyTest({ ...base, period: 'D1', from: '2021-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).resolves.toBeTruthy();
    // D1 超 5 年 → 400
    await expect(
      api.runStrategyTest({ ...base, period: 'D1', from: '2019-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).rejects.toMatchObject({ status: 400 });
    // M1 + 1 年区间 → 400（分钟级上限 3 个月）
    await expect(
      api.runStrategyTest({ ...base, period: 'M1', from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).rejects.toMatchObject({ status: 400 });
    // M1 三个月内 OK
    await expect(
      api.runStrategyTest({ ...base, period: 'M1', from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }),
    ).resolves.toBeTruthy();
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
    await expect(api.submitWorkbenchRun({ ...validSubmit(), period: 'H1' })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), from: '2026-04-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [] })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [{ version_id: 'sv_mock_dual_v1', weight: 0 }] })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), buy_threshold: 30, sell_threshold: 70 })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), fee: { rate_pct: 0.025 } as never })).rejects.toMatchObject({ status: 400 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [{ version_id: 'sv_nope', weight: 1 }] })).rejects.toMatchObject({ status: 404 });
    await expect(api.submitWorkbenchRun({ ...validSubmit(), slots: [{ version_id: 'sv_mock_dual_v2', weight: 1 }] })).rejects.toMatchObject({ status: 400 });
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
    // mock 同步完成（对齐旧回测 mock 即时终态先例）：结果经 result 端点可取
    const res = await api.getWorkbenchResult(run.id);
    expect(res.per_bar.length).toBeGreaterThan(0);
    expect(res.per_bar[0]).toMatchObject({ ts: expect.any(Number), aggregate: expect.any(Number), signal: expect.stringMatching(/Buy|Sell|Hold/) });
    expect(res.per_bar[0]!.scores[0]).toMatchObject({ slot_idx: 0, score: expect.any(Number) });
    expect(res.net_value[0]).toHaveLength(2);
    expect(res.metrics).toMatchObject({ net_profit: expect.any(Number), trade_count: expect.any(Number) });
    expect(res.trades.length).toBeGreaterThan(0);
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
});
