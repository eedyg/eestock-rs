// P1-D-3 独立验收探针（Tester 自建，非实现方测试；只在 /tmp 副本，不改仓库）
// 目的：核对「后端已去重」与「前端 mock 镜像」的契约一致性问题（coder/167 §8.1 残余项）。
import { describe, it, expect } from 'vitest';
import { createMockClient } from '@/api/mock';

const base = (n: number) => ({
  enabled: false,
  periods: ['1m', '5m', '15m'],
  heights: { '1m': 420, '5m': 180, '15m': 180 },
  indicators: Array(n).fill('dcap'),
});

describe('P1-D-3 mock 镜像一致性探针', () => {
  it('mock saveMultiPeriodConfig(["dcap"]×11, 3 周期) —— 后端 200（去重后 3 pane），mock 呢？', async () => {
    const api = createMockClient();
    let status: number | null = null;
    let msg = '';
    try {
      await api.saveMultiPeriodConfig(base(11));
    } catch (e: any) {
      status = e?.status ?? -1;
      msg = String(e?.message ?? e);
    }
    const cfg = await api.getMultiPeriodConfig();
    console.log('MOCK_PROBE_PANE', JSON.stringify({ caughtStatus: status, msg, indicatorsAfter11: cfg.indicators }));
    expect(true).toBe(true);
  });

  it('mock saveMultiPeriodConfig(["dcap","dcap"]) —— 后端归一化为 ["dcap"]，mock 呢？', async () => {
    const api = createMockClient();
    let caught = '';
    try {
      await api.saveMultiPeriodConfig({ ...base(2) });
    } catch (e: any) {
      caught = String(e?.message ?? e);
    }
    const cfg = await api.getMultiPeriodConfig();
    console.log('MOCK_PROBE_DEDUP', JSON.stringify({ caught, indicatorsAfterDup: cfg.indicators }));
    expect(true).toBe(true);
  });
});
