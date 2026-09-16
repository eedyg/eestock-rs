/**
 * mock ↔ backend 多周期配置契约一致性（parity）向量消费侧（TS / mock ApiClient）—— **D5-1 红测试**。
 *
 * 单一真相：`design/15-multi-period/contract-vectors.json`（两侧共用；`entangled.toml` 的 watch_list
 * 只监听 design 下的 markdown（`file=` 块）⇒ `.json` 不受 tangle 影响）。Rust 消费侧见
 * `crates/web/tests/multi_period_contract_vectors.rs`（打 `web::dto` 纯函数）。
 *
 * 本文件逐条读同一 JSON，调用 mock 的 PUT 路径（`createMockClient().saveMultiPeriodConfig`，
 * 内部即 `assertMultiPeriodConfig`），断言与后端**同一组输入 ⇒ 同一接受/拒绝 + 同一归一化输出**：
 * - `expect.status === 200` ⇒ 归一化输出必须 `JSON` 深等价于 `expect.normalized`
 *   （**含 `indicators` 去重后**，02-spec §2 校验 6）；
 * - `expect.status === 400` ⇒ 必须抛 `ApiError(400)` 且 `message` 含 `expect.errorMustContain`
 *   （被拒字段名）。
 *
 * 预期红（D5-1 现状）：`web/src/api/mock.ts::assertMultiPeriodConfig` 仍
 * ① 原样回显未去重的 `indicators`（`["dcap","dcap"]` ⇒ normalized 不一致）；
 * ② 按**原始数组长度**计 pane（`1 + (periods-1) × indicators.length`）⇒ `["dcap"]×5/×11` 被误判
 * >12 pane 而 400（后端去重后 1+3×1=4 ≤ 12 ⇒ 200）。
 * ⇒ 本文件是把「mock 与真实契约不一致」钉死的 parity 门禁；实现侧修 mock（去重 + 基于去重后集合计数）
 * 后应转绿，**不得**通过改向量文件转绿（Rust 侧同名覆盖守卫会红）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockClient, MOCK_MULTI_PERIOD_ORDER } from './mock';
import { ApiError } from './types';
import type { MultiPeriodConfigDto } from './types';
import { MULTI_PERIOD_PICKER_PERIODS } from '@/features/dashboard/multiPeriodPicker';

// web/src/api → 仓库根
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = resolve(HERE, '../../../design/15-multi-period/contract-vectors.json');

/** 契约向量单条（与 Rust 侧同构；见 design/15-multi-period/contract-vectors.json） */
interface ContractVectorExpect {
  status: 200 | 400;
  /** 200 时：归一化后的完整 config 对象（含去重后的 indicators） */
  normalized?: MultiPeriodConfigDto;
  /** 400 时：错误串必须包含的判据词（被拒维度名） */
  errorMustContain?: string;
  /** 去重后总 pane 数（纯函数层证据；mock 侧不消费，见 Rust 消费侧） */
  paneCountAfterDedup?: number;
  /** pane 护栏错误串须含的维度名（纯函数层；mock 侧不消费） */
  paneGuardErrorMustContain?: string;
}

interface ContractVector {
  name: string;
  note?: string;
  input: MultiPeriodConfigDto;
  expect: ContractVectorExpect;
}

const VECTORS: ContractVector[] = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as ContractVector[];

/** 对象键序无关的稳定序列化（Rust 侧 `heights` 是 BTreeMap ⇒ 键序升序；此处对齐比较口径） */
function stable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v) ?? null);
}

/** 周期全集候选（含契约**不提供**的 `1mo`，用于逐档反证「mock 接受集合 == 契约集合」）。 */
const PERIOD_UNIVERSE = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1mo'] as const;

/** 由周期清单构造一份合法的多周期 config（heights 键一一对应）。 */
function cfgFor(periods: string[]): MultiPeriodConfigDto {
  return {
    enabled: false,
    periods,
    heights: Object.fromEntries(periods.map((p) => [p, 420])),
    indicators: ['dcap'],
  };
}

/**
 * mock ↔ 前端契约「周期集合与顺序」parity（ADR-023 §2.5 D2：`30m` 插在 `15m` 与 `1h` 之间）。
 *
 * 口径对齐单一真相：`MULTI_PERIOD_PICKER_PERIODS`（`multiPeriodPicker.test.tsx` 已把它钉死等于后端
 * `MULTI_PERIOD_ALLOWED`，故此处与它对齐即与后端契约对齐）。
 * 断言分三层：① 顺序逐项相等（导出常量）；② 接受集合逐档相等（∈契约⇒200 / ∉契约（`1mo`）⇒400）；
 * ③ 顺序语义逐对相等（`{P ≥ base}` + `1w` 需基准 ≥ `1d`）——②③ 经 `saveMultiPeriodConfig`
 * 真实行为反证，防止「常量漂移但校验逻辑仍用旧序」的假绿。
 */
describe('mock ↔ 契约：多周期周期集合与顺序 parity（MULTI_PERIOD_PICKER_PERIODS）', () => {
  it('mock 周期序逐项相等 MULTI_PERIOD_PICKER_PERIODS（含 30m，不含 1mo）', () => {
    expect(
      MOCK_MULTI_PERIOD_ORDER,
      `mock 的周期序必须与前端契约逐项相等；契约 = ${JSON.stringify(MULTI_PERIOD_PICKER_PERIODS)}`,
    ).toEqual(MULTI_PERIOD_PICKER_PERIODS);
    expect(MOCK_MULTI_PERIOD_ORDER, '1mo 不提供').not.toContain('1mo');
  });

  it('mock 接受集合 == 契约集合（逐档反证：含 30m 接受、含 1mo 拒绝）', async () => {
    for (const p of PERIOD_UNIVERSE) {
      const api = createMockClient();
      const inContract = MULTI_PERIOD_PICKER_PERIODS.includes(p as never);
      if (inContract) {
        await expect(
          api.saveMultiPeriodConfig(cfgFor([p])),
          `[${p}] ∈ 契约 ⇒ mock 必须接受（200），不得判 400`,
        ).resolves.toBeTruthy();
      } else {
        await expect(
          api.saveMultiPeriodConfig(cfgFor([p])),
          `[${p}] ∉ 契约 ⇒ mock 必须 400`,
        ).rejects.toMatchObject({ status: 400 });
      }
    }
  });

  it('mock 顺序语义 == 契约（{P ≥ base} + 1w 需基准 ≥ 1d）逐对反证', async () => {
    const rank = (p: string): number => MULTI_PERIOD_PICKER_PERIODS.indexOf(p as never);
    for (const a of PERIOD_UNIVERSE) {
      for (const b of PERIOD_UNIVERSE) {
        if (a === b) continue;
        const ra = rank(a);
        const rb = rank(b);
        const expectOk = ra >= 0 && rb >= 0 && rb >= ra && !(b === '1w' && ra < rank('1d'));
        const api = createMockClient();
        if (expectOk) {
          await expect(
            api.saveMultiPeriodConfig(cfgFor([a, b])),
            `契约 ${a}→${b} 应放行（卫星 ≥ 基准）`,
          ).resolves.toBeTruthy();
        } else {
          await expect(
            api.saveMultiPeriodConfig(cfgFor([a, b])),
            `契约 ${a}→${b} 应 400`,
          ).rejects.toMatchObject({ status: 400 });
        }
      }
    }
  });
});

describe('mock ↔ backend 多周期契约向量 parity（design/15-multi-period/contract-vectors.json）', () => {
  it('向量文件可读且为数组（两侧单一真相）', () => {
    expect(Array.isArray(VECTORS)).toBe(true);
    expect(VECTORS.length).toBeGreaterThan(0);
    for (const v of VECTORS) {
      expect(typeof v.name, '向量必须含 name').toBe('string');
      expect(v.input, `[${v.name}] 必须含完整 config input`).toBeTruthy();
      expect([200, 400], `[${v.name}] expect.status 须为 200|400`).toContain(v.expect.status);
    }
  });

  for (const v of VECTORS) {
    it(`${v.name}（expect ${v.expect.status}）`, async () => {
      const api = createMockClient();
      if (v.expect.status === 200) {
        const out = await api.saveMultiPeriodConfig(v.input);
        expect(
          stable(out),
          `[${v.name}] mock 归一化输出必须与后端一致（含 indicators 去重）；note=${v.note ?? ''}`,
        ).toBe(stable(v.expect.normalized));
      } else {
        let err: unknown = null;
        try {
          await api.saveMultiPeriodConfig(v.input);
        } catch (e) {
          err = e;
        }
        expect(err, `[${v.name}] mock 必须拒绝该配置（期望 400）；note=${v.note ?? ''}`).not.toBeNull();
        expect(err, `[${v.name}] 拒绝必须是 ApiError`).toBeInstanceOf(ApiError);
        const e = err as ApiError;
        expect(e.status, `[${v.name}] 状态码必须为 400`).toBe(400);
        expect(
          e.message,
          `[${v.name}] 错误串必须含被拒维度名「${v.expect.errorMustContain}」`,
        ).toContain(v.expect.errorMustContain);
      }
    });
  }
});
