/**
 * **tester 独立复验（ADR-024 P5 整改 N2）** —— 2026-09-18 第 254 号验收单。
 *
 * 判据（**不复用 worker 断言**；worker 载体 = `web/src/api/mock.test.ts` 的 `N2-MINOR-4`）：
 * 1. **物理删除**：`MOCK_TESTRUN_{D1,MINUTE}_MAX_SPAN_DAYS` 与「试算区间超限」分支不得存在
 *    （源码级 + 行为级双向）。
 * 2. **与后端同口径**：无日历档 / 可得区间收缩（`clamp.mode`）/ `range_empty` / `resource_guard` + `confirm`。
 * 3. **运行期向量绑定**：期望**全部由 `contract-vectors.json::span_limit_semantics` 推导**
 *    （码、`clamp.mode`、`echo_fields`、`deleted_constants`）—— 向量扰动 ⇒ 本用例必须变红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockClient } from './mock';
import { ApiError } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = resolve(HERE, '../../../design/16-backtest-scalability/contract-vectors.json');
const MOCK_SRC_RAW = readFileSync(resolve(HERE, './mock.ts'), 'utf8');
/** 去掉注释后的源码（注释里出现旧常量名是**文档**，不是复活；只对活代码判据）。 */
const stripComments = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
const MOCK_SRC = stripComments(MOCK_SRC_RAW);

type SpanSemantics = {
  calendar_day_cap: number | null;
  deleted_constants: string[];
  clamp: { mode: string; available_range_source: string; echo_fields: string[]; gap_policy: string };
  empty_intersection: { http: number; code: string };
  resource_guard: { hard_reject: boolean; requires_confirmation: boolean; code: string };
};
const V = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  span_limit_semantics: SpanSemantics;
};
const S = V.span_limit_semantics;

const NOW = new Date('2026-09-09T06:00:00Z');
const client = () => createMockClient({ now: NOW }) as never as ReturnType<typeof createMockClient>;
const CODE = 'function on_bar(ctx) { return 50; }';
const base = (over: Record<string, unknown>) => ({
  code: CODE,
  symbol: '518880',
  period: 'D1' as const,
  from: '2025-01-01T00:00:00Z',
  to: '2025-02-01T00:00:00Z',
  mode: 'pure_score' as const,
  ...over,
});

async function catchApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('期望抛 ApiError，实际成功');
}

describe('tester·N2 mock：日历档**物理删除**（源码级 + 行为级）', () => {
  it('源码级：mock.ts 不得再定义/引用 MAX_SPAN_DAYS 常量或「区间超限」文案', () => {
    expect(MOCK_SRC).not.toMatch(/MOCK_TESTRUN_(D1|MINUTE)_MAX_SPAN_DAYS/);
    expect(MOCK_SRC).not.toMatch(/= *366 *\* *5/);
    expect(MOCK_SRC).not.toMatch(/MINUTE_MAX_SPAN_DAYS *= *93/);
    expect(MOCK_SRC).not.toContain('试算区间超限');
    // 向量里声明的「已删常量」名不得作为**活常量**出现（注释/断言字符串允许）
    for (const name of S.deleted_constants) {
      const live = new RegExp(`const\\s+\\S*${name}\\s*[:=]`);
      expect(MOCK_SRC, `mock.ts 复活了已删常量 ${name}`).not.toMatch(live);
    }
  });

  it('行为级：D1 七年跨度（旧档 5 年 ⇒ 旧 mock 必 400）⇒ 受理', async () => {
    expect(S.calendar_day_cap).toBeNull(); // 期望来源 = 向量：无日历档
    const resp = await client().runStrategyTest(base({ from: '2019-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }));
    expect(resp.period).toBe('D1');
    expect(resp.symbol).toBe('518880');
  });

  it('行为级：M1 104 天跨度（旧档 93 天 ⇒ 旧 mock 必 400；< 200k bar 不触护栏）⇒ 受理', async () => {
    const resp = await client().runStrategyTest(base({ period: 'M1', from: '2025-01-01T00:00:00Z', to: '2025-04-15T00:00:00Z' }));
    expect(resp.period).toBe('M1');
    expect(resp.estimated_bars).toBeGreaterThan(93 * 1440 * 0.9); // > 旧 93 天档的量级
  });
});

describe('tester·N2 mock：可得区间收缩 / range_empty / resource_guard（期望取自向量）', () => {
  it('收缩回显：起点早于可得数据 ⇒ clamped=true + clamp_reason=data_range + echo_fields 全覆盖', async () => {
    expect(S.clamp.mode).toBe('intersect_available_range'); // 期望来源 = 向量
    const resp = await client().runStrategyTest(base({ from: '2000-01-01T00:00:00Z', to: '2025-01-10T00:00:00Z' }));
    // 向量声明的回显字段必须**全部**存在（增字段 ⇒ 绑定用例红）
    for (const f of S.clamp.echo_fields) {
      expect(resp, `回显缺字段 ${f}`).toHaveProperty(f);
    }
    expect(resp.clamped).toBe(true);
    expect(resp.clamp_reason).toBe('data_range');
    expect(Date.parse(resp.effective_from!)).toBeGreaterThan(Date.parse(resp.requested_from!));
    expect(resp.effective_to).toBe(resp.requested_to);
  });

  it('无交集 ⇒ 400 range_empty（码取自向量）+ 回显可用区间', async () => {
    const e = await catchApiError(
      client().runStrategyTest(base({ from: '2030-01-01T00:00:00Z', to: '2031-01-01T00:00:00Z' })),
    );
    expect(S.empty_intersection.http).toBe(400);
    expect(e.status).toBe(S.empty_intersection.http);
    expect(e.code).toBe(S.empty_intersection.code);
    expect(typeof e.detail?.available_from).toBe('string');
    expect(typeof e.detail?.available_to).toBe('string');
    expect(e.detail?.period).toBe('D1');
  });

  it('未注册标的 ⇒ range_empty（向量码）+ available 为 null（无可得数据）', async () => {
    const e = await catchApiError(client().runStrategyTest(base({ symbol: '999999' })));
    expect(e.code).toBe(S.empty_intersection.code);
    expect(e.detail?.available_from ?? null).toBeNull();
  });

  it('resource_guard 二次确认：阈值区间 ⇒ 400 向量码；confirm=true ⇒ 放行', async () => {
    expect(S.resource_guard.requires_confirmation).toBe(true);
    // 2 年 M1 ≈ 1.05M bar：≥ 二次确认阈值（200k）且 ≤ 硬上界（2M）⇒ confirmable=true
    const big = base({ period: 'M1', from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' });
    const e = await catchApiError(client().runStrategyTest(big));
    expect(e.status).toBe(400);
    expect(e.code).toBe(S.resource_guard.code);
    expect(e.detail?.confirmable).toBe(true);
    expect(Number(e.detail?.requested_bars)).toBeGreaterThan(0);
    const resp = await client().runStrategyTest({ ...big, confirm: true });
    expect(resp.period).toBe('M1');
  });

  it('短区间回归保护：区间内（可达）⇒ clamped=false 且 requested==effective', async () => {
    const resp = await client().runStrategyTest(base({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }));
    expect(resp.clamped).toBe(false);
    expect(resp.clamp_reason).toBeNull();
    expect(resp.effective_from).toBe(resp.requested_from);
    expect(resp.effective_to).toBe(resp.requested_to);
  });
});
