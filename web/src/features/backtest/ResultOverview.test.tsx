import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import type { BacktestRunDto } from '@/api/types';
import { ResultOverview } from './ResultOverview';

/** 构造一个 status=done 的 run（series/drawdown 长度 n；drawdownPct 为逐点回撤比例）。 */
function makeRun(n: number, drawdownPct: number): BacktestRunDto {
  const series = Array.from({ length: n }, (_, i) => [i, 100_000 + i * 10] as [number, number]);
  const drawdown = Array.from({ length: n }, (_, i) => [i, drawdownPct] as [number, number]);
  return {
    id: 1,
    code: '518880',
    period: 'D1',
    strategy_id: 'dual_ma',
    params: { fast: 5, slow: 20 },
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    status: 'done',
    progress: 100,
    current_ts: '2026-09-04T02:00:00Z',
    created_at: '2026-09-04T01:00:00Z',
    finished_at: '2026-09-04T02:00:00Z',
    error: null,
    group_id: null,
    net_value: { series, drawdown },
    trades: [],
    metrics: {
      net_profit: 1000,
      max_drawdown: drawdownPct,
      sharpe: 1.2,
      win_rate: 0.5,
      profit_factor: 1.1,
      annualized_return: 0.1,
      trade_count: 10,
      avg_hold_bars: 16.999,
    },
  };
}

function renderOverview(run: BacktestRunDto) {
  return render(
    <ResultOverview
      run={run}
      loading={false}
      error={null}
      onRetry={() => {}}
    />,
  );
}

describe('ResultOverview（修复#1：回撤着色 rect 宽度恒非负，长序列无负宽）', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    errSpy?.mockRestore();
  });

  it('1200 点长序列：全部回撤着色 rect width>0、解析为有限正数，且不触发负宽 console.error', () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderOverview(makeRun(1200, 0.03));

    const rects = document.querySelectorAll('svg rect');
    expect(rects.length).toBe(1200);
    const widths = Array.from(rects).map((r) => Number(r.getAttribute('width')));
    expect(widths.every((w) => Number.isFinite(w) && w > 0)).toBe(true);

    // 负宽会让 React 走 console.error（dev）: "Received `-…` for a non-negative attribute `width`"
    const badWarns = errSpy.mock.calls
      .flat()
      .filter((m) => typeof m === 'string' && (m.includes('non-negative attribute') || m.includes('negative')));
    expect(badWarns).toEqual([]);
  });

  it('长序列（>1000 点）恒无负宽，即使回撤值全部为正', () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderOverview(makeRun(1500, 0.02));
    const rects = document.querySelectorAll('svg rect');
    expect(rects.length).toBe(1500);
    const widths = Array.from(rects).map((r) => Number(r.getAttribute('width')));
    expect(widths.every((w) => Number.isFinite(w) && w >= 0)).toBe(true);
    expect(Math.min(...widths)).toBeGreaterThan(0);
  });

  it('短序列着色正确：仅回撤>0 处绘制 rect，且 width>0', () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = makeRun(5, 0.02);
    // 改成部分点为 0 回撤 → 只有回撤>0 的点才着色
    run.net_value!.drawdown = [
      [0, 0],
      [1, 0.02],
      [2, 0],
      [3, 0.03],
      [4, 0.01],
    ];
    renderOverview(run);
    const rects = document.querySelectorAll('svg rect');
    expect(rects.length).toBe(3);
    const widths = Array.from(rects).map((r) => Number(r.getAttribute('width')));
    expect(widths.every((w) => Number.isFinite(w) && w > 0)).toBe(true);
  });

  it('n=1 单点（回撤>0）不除零：rect 宽度为正', () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = makeRun(1, 0.01);
    renderOverview(run);
    const rects = document.querySelectorAll('svg rect');
    // 单点回撤>0 会着色一排
    expect(rects.length).toBeGreaterThan(0);
    const widths = Array.from(rects).map((r) => Number(r.getAttribute('width')));
    expect(widths.every((w) => Number.isFinite(w) && w > 0)).toBe(true);
  });
});

/** 构造指定 ts 的 run（net_value 覆盖；drawdown 全部 0 不干扰回撤断言）。 */
function makeRunWithTs(n: number, startTs: number, stepSec: number): BacktestRunDto {
  const series = Array.from(
    { length: n },
    (_, i) => [startTs + i * stepSec, 100_000 + i * 10] as [number, number],
  );
  const drawdown = Array.from(
    { length: n },
    (_, i) => [startTs + i * stepSec, 0] as [number, number],
  );
  return { ...makeRun(n, 0), net_value: { series, drawdown } };
}

describe('ResultOverview 补充：净值图时间 x 轴（含 ts → ≥3 刻度；无 ts → 占位）', () => {
  it('含 ts 的净值序列 → x 轴出现 ≥3 个时间刻度文本', () => {
    const startTs = Date.UTC(2024, 0, 1) / 1000; // 2024-01-01 00:00:00 UTC
    renderOverview(makeRunWithTs(120, startTs, 86_400)); // 每日一根，120 天
    const labels = Array.from(document.querySelectorAll('[data-testid="chart-x-axis"] span')).map(
      (s) => s.textContent ?? '',
    );
    expect(labels.length).toBeGreaterThanOrEqual(3);
    const dateLike = labels.filter((t) => /^\d{4}-\d{2}(-\d{2})?$/.test(t));
    expect(dateLike.length).toBeGreaterThanOrEqual(3);
  });

  it('无 ts（ts 全为 0）→ x 轴占位「—」', () => {
    renderOverview(makeRunWithTs(5, 0, 0));
    const labels = Array.from(document.querySelectorAll('[data-testid="chart-x-axis"] span')).map(
      (s) => s.textContent ?? '',
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => l === '—')).toBe(true);
  });
});
