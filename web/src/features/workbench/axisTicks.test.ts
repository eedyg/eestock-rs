import { describe, expect, it } from 'vitest';
import { niceTicks } from './axisTicks';

/**
 * ADR-028 D12（09-plan §2 / §2.1）——「Y 轴刻度」的**纯函数**判据（先红后绿）。
 *
 * 冻结口径：
 *  - 3–5 条自适应整数刻度，步长 ∈ {1,2,5}×10^k；
 *  - **只标注现有 y 域**：任何刻度都不得外扩到 `[min,max]` 之外（值域由各卡既有几何决定，禁 padding）；
 *  - 含 0 的域 ⇒ 刻度必含 0（常驻 0 线的卡，用户既有裁决）。
 */

/** 步长是否为 {1,2,2.5,5}×10^k（k ∈ ℤ；**2026-09-25 复审裁定：加入 2.5 档**）。 */
function isNiceStep(step: number): boolean {
  if (!(step > 0) || !Number.isFinite(step)) return false;
  const k = Math.round(Math.log10(step));
  for (const m of [1, 2, 2.5, 5]) {
    for (const kk of [k - 1, k, k + 1]) {
      if (Math.abs(step - m * Math.pow(10, kk)) <= 1e-9 * Math.max(1, step)) return true;
    }
  }
  return false;
}

/** 边界断言（不外扩；容差仅吸收浮点表示误差）。 */
function expectWithinDomain(ticks: number[], min: number, max: number) {
  expect(ticks.length).toBeGreaterThanOrEqual(3);
  expect(ticks.length).toBeLessThanOrEqual(5);
  const eps = 1e-9 * Math.max(1, Math.abs(min), Math.abs(max));
  expect(ticks[0]!).toBeGreaterThanOrEqual(min - eps);
  expect(ticks[ticks.length - 1]!).toBeLessThanOrEqual(max + eps);
  for (let i = 1; i < ticks.length; i++) {
    expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    expect(isNiceStep(ticks[i]! - ticks[i - 1]!), `步长必须 ∈ {1,2,5}×10^k，实测 ${ticks[i]! - ticks[i - 1]!}`).toBe(true);
  }
}

describe('T1 niceTicks：0–100（聚合总分 / 各策略评分的固定域）', () => {
  it('3–5 条、全在 [0,100] 内、含 0、步长 nice', () => {
    const ticks = niceTicks(0, 100, 4);
    expectWithinDomain(ticks, 0, 100);
    expect(ticks).toContain(0);
  });

  it('**复审裁定**：0–100 必须给 5 条（0/25/50/75/100）——「看到具体范围」而非只有 0/50/100', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('目标条数超大（9）仍受 3–5 上限约束（禁“要几条给几条”）', () => {
    const ticks = niceTicks(0, 100, 9);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expectWithinDomain(ticks, 0, 100);
  });
});

describe('T1b niceTicks：2.5×10^k 档可达（复审裁定扩展允许集合）', () => {
  it('0–10 ⇒ 步长 2.5 给出 5 条 [0,2.5,5,7.5,10]', () => {
    expect(niceTicks(0, 10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('窄域 0–5：仍满足 3–5 条 + 域内 + nice 步长（步长 2 得 0/2/4；不得退化成 1–2 条）', () => {
    const ticks = niceTicks(0, 5, 4);
    expectWithinDomain(ticks, 0, 5);
    expect(ticks).toEqual([0, 2, 4]);
  });

  it('2.5 档不可退化为“仅 {1,2,5}”：0–100 必须能取到 25/75（否则本断言在移除 2.5 档时不变红）', () => {
    const ticks = niceTicks(0, 100, 4);
    expect(ticks).toContain(25);
    expect(ticks).toContain(75);
    expect(isNiceStep(25)).toBe(true);
  });
});

describe('T2 niceTicks：净值域（数据 min/max，无 padding，禁外扩）', () => {
  it('小数域 100.2–104.8：刻度全落在数据域内（不外扩到 100/105）', () => {
    const ticks = niceTicks(100.2, 104.8, 4);
    expectWithinDomain(ticks, 100.2, 104.8);
    expect(ticks[0]).toBeGreaterThan(100.2); // 若外扩成 nice 边界（100）本断言变红
  });

  it('整数域 1000–1040：4 条左右且在域内', () => {
    const ticks = niceTicks(1000, 1040, 4);
    expectWithinDomain(ticks, 1000, 1040);
  });

  it('大数量级 123456–789012：仍 3–5 条且全在域内', () => {
    const ticks = niceTicks(123456, 789012, 4);
    expectWithinDomain(ticks, 123456, 789012);
  });
});

describe('T3 niceTicks：跨 0 的域（持仓比率 extentOf(ratios ∪ {0,1})）', () => {
  it('−3 … 7 ⇒ 含 0 且全在域内', () => {
    const ticks = niceTicks(-3, 7, 4);
    expectWithinDomain(ticks, -3, 7);
    expect(ticks).toContain(0);
  });

  it('0.05 … 1.02（持仓比率典型域）⇒ 含 0 时必标 0', () => {
    const ticks = niceTicks(0, 1.02, 4);
    expectWithinDomain(ticks, 0, 1.02);
    expect(ticks).toContain(0);
  });
});

describe('T4 niceTicks：退化与非法输入', () => {
  it('min == max ⇒ 单条刻度 = 该值（不除零、不自造域）', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(0, 0)).toEqual([0]);
  });

  it('非有限输入 ⇒ 空数组（不抛、不自造域）', () => {
    expect(niceTicks(NaN, 10)).toEqual([]);
    expect(niceTicks(0, Infinity)).toEqual([]);
    expect(niceTicks(-Infinity, Infinity)).toEqual([]);
    expect(niceTicks(0, -Infinity)).toEqual([]);
  });

  it('目标条数非法（0/负数/NaN）⇒ 按默认 4 处理，不得越界', () => {
    for (const t of [0, -1, NaN]) {
      const ticks = niceTicks(0, 100, t);
      expectWithinDomain(ticks, 0, 100);
    }
  });

  it('min > max（调用方传反）⇒ 与 (max,min) 等价（不自造空集）', () => {
    expect(niceTicks(7, -3, 4)).toEqual(niceTicks(-3, 7, 4));
  });
});

describe('T5 niceTicks：窄域 + 高位偏移（域内无 nice 步长的病态情形）', () => {
  it('1000.5–1000.9 ⇒ 仍 3–5 条且全在域内（禁“外扩到 1000/1001”换取好看步长）', () => {
    const ticks = niceTicks(1000.5, 1000.9, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ticks[0]!).toBeGreaterThanOrEqual(1000.5 - 1e-9);
    expect(ticks[ticks.length - 1]!).toBeLessThanOrEqual(1000.9 + 1e-9);
  });

  it('极窄域 0.9999999–1.0000001 ⇒ 仍给出 3–5 条域内刻度（禁空集）', () => {
    const ticks = niceTicks(0.9999999, 1.0000001, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ticks[0]!).toBeGreaterThanOrEqual(0.9999999 - 1e-12);
    expect(ticks[ticks.length - 1]!).toBeLessThanOrEqual(1.0000001 + 1e-12);
  });
});
