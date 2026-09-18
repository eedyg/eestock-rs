/**
 * ADR-024 P0 §5.1 —— 前端镜像常量 ↔ 契约向量「逐字相等」防漂移断言（**手写**）。
 *
 * 单一真相：`design/16-backtest-scalability/contract-vectors.json::backtest_periods`。
 * 本文件断言 `SUPPORTED_BACKTEST_PERIODS`（前端唯一镜像）与之逐字相等；
 * 后端/MCP 侧的同一断言见 `crates/mcp/tests/adr024_period_ssot_drift.rs`（读取本文件字面量）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_BACKTEST_PERIODS } from './periods';

// web/src/features/backtest → 仓库根
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = resolve(HERE, '../../../../design/16-backtest-scalability/contract-vectors.json');

interface ContractVectors {
  backtest_periods: string[];
  m30?: { domain_variant?: string; dashboard_code?: string; bars_per_year_nominal?: number };
}

const VECTORS: ContractVectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as ContractVectors;

describe('ADR-024 P0 前端周期镜像常量（单一事实源）', () => {
  it('SUPPORTED_BACKTEST_PERIODS == contract-vectors.json::backtest_periods（逐字相等）', () => {
    expect([...SUPPORTED_BACKTEST_PERIODS]).toEqual(VECTORS.backtest_periods);
  });

  it('集合为契约六档（含 M30），顺序即展示序', () => {
    expect([...SUPPORTED_BACKTEST_PERIODS]).toEqual(['M1', 'M5', 'M15', 'M30', 'H1', 'D1']);
  });

  it('契约向量声明 m30（domain_variant=M30 / dashboard_code=30m / bars_per_year_nominal=2016）', () => {
    expect(VECTORS.m30?.domain_variant).toBe('M30');
    expect(VECTORS.m30?.dashboard_code).toBe('30m');
    expect(VECTORS.m30?.bars_per_year_nominal).toBe(2016);
  });
});
