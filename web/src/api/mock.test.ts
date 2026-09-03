import { describe, it, expect } from 'vitest';
import { createMockClient } from './mock';

describe('createMockClient（后端 Phase A 并行期的契约 mock）', () => {
  it('getSymbols 返回注册集合 4 标的（含 latest 快照字段）', async () => {
    const api = createMockClient();
    const symbols = await api.getSymbols();
    expect(symbols.length).toBe(4);
    const codes = symbols.map((s) => s.code);
    expect(codes).toEqual(expect.arrayContaining(['518880', '513310', '161226', '159776']));
    for (const s of symbols) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.last).toBe('number');
      expect(typeof s.changePct).toBe('number');
    }
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

  it('getSourcesHealth 返回采集状态 + 1m/快照源清单', async () => {
    const api = createMockClient();
    const health = await api.getSourcesHealth();
    expect(typeof health.collectorRunning).toBe('boolean');
    expect(health.sources.filter((s) => s.role === '1m').length).toBeGreaterThanOrEqual(2);
    expect(health.sources.some((s) => s.role === 'snapshot')).toBe(true);
  });
});
