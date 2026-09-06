import { describe, it, expect } from 'vitest';
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

  it('listRuns 种子：done/running/pending/failed 四态齐备；compare 只含存在 run', async () => {
    const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
    const runs = await api.listRuns();
    const statuses = runs.map((r) => r.status);
    for (const st of ['pending', 'running', 'done', 'failed']) {
      expect(statuses).toContain(st);
    }
    const done = runs.find((r) => r.status === 'done')!;
    expect(done.id).toBeGreaterThan(0);
    expect(done.metrics).toBeDefined();
    const cmp = await api.compare([done.id, 999999]);
    expect(cmp).toHaveLength(1);
    expect(cmp[0]!.id).toBe(done.id);
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
});
