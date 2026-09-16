/**
 * ADR-023 D1 红测试（**手写**，非 tangle 产物）：判据 J8（前端主图周期 30m）+ J9（前端范围边界，反向断言）。
 *
 * 覆盖（逐条映射 ADR-023 §5.3 / §2.5 / §3.2 与任务书 J8/J9）：
 *   J8-a  `web/src/layouts/DashboardGrid.tsx` 的 `type Period` 含 `'30m'`（文本断言，见任务书 J8 授权）；
 *   J8-b  `Toolbar.tsx` 的 `PERIODS` = 8 档，顺序严格 `1m,5m,15m,30m,1h,1d,1w,1mo`（渲染序断言，`PERIODS` 未导出 ⇒ 用 DOM 序）；
 *   J8-c  点击 30m 按钮后**数据层**发出的 kline 请求 `period=30m`（DashboardPage 装配 + feed/mock 夹具风格，同 DashboardPage.test.tsx）；
 *   J9    反向护栏：`MULTI_PERIOD_PICKER_PERIODS` 本轮**不含** `30m`（D2 才开）；`PERIOD_BUCKET_MS['30m'] = 1800000`（本轮**必须**有）。
 *
 * 契约出处：design/01-architecture/adr/ADR-023-period-set-extension-30m.md §2.5 / §3.2 / §5.3 / §6.1
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { SymbolSnapshot } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { indicatorViewFromCalls } from '@/test/chartStoreStub';

// jsdom 无 canvas：klinecharts 整体打桩（与 DashboardPage.test.tsx 同风格）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  setBarSpace: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  getIndicators: vi.fn((filter?: { name?: string }) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {})),
  overrideIndicator: vi.fn(),
  resetData: vi.fn(),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setPaneOptions: vi.fn(),
  resize: vi.fn(),
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

import { DashboardPage } from './DashboardPage';
import { Toolbar } from './Toolbar';
import { MULTI_PERIOD_PICKER_PERIODS } from './multiPeriodPicker';
import { PERIOD_BUCKET_MS, periodBucketMs } from './chartSyncGroup';

const WEB_ROOT = process.cwd(); // vitest 以 web/ 为工作目录
const read = (rel: string) => fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8');

// ---------------------------------------------------------------- J8-a

describe('J8-a：DashboardGrid 的 type Period 含 30m（主图周期档）', () => {
  it("type Period 含 '30m'，且既有 7 档一档不丢（纯加法）", () => {
    const src = read('src/layouts/DashboardGrid.tsx');
    const m = src.match(/export\s+type\s+Period\s*=\s*([^;]+);/);
    expect(m, 'DashboardGrid.tsx 必须导出 `type Period = ...;`').not.toBeNull();
    const tiers = m![1]!
      .split('|')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(tiers, "ADR-023 §3.1/§5.3：type Period 必须含 '30m'").toContain('30m');
    for (const p of ['1m', '5m', '15m', '1h', '1d', '1w', '1mo']) {
      expect(tiers, `既有档位 ${p} 不得从 type Period 中消失`).toContain(p);
    }
    expect(tiers, 'ADR-023 §5.3：主图周期档共 8 档').toHaveLength(8);
  });

  it("前端 Period 类型（api/types 再导出）可用 '30m' 赋值（编译期同源断言）", () => {
    // 类型层断言：若 type Period 不含 '30m'，本行 TypeScript 不通过。
    // 运行时用字符串比较兜底（jsdom 环境不跑 tsc）：
    const src = read('src/layouts/DashboardGrid.tsx');
    expect(src).toMatch(/export\s+type\s+Period\s*=[^;]*'30m'/);
  });
});

// ---------------------------------------------------------------- J8-b

describe('J8-b：Toolbar 周期按钮 = 8 档，顺序 1m,5m,15m,30m,1h,1d,1w,1mo', () => {
  const PERIOD_LABELS = ['1m', '5m', '15m', '30m', '1h', '日', '周', '月'];

  function renderToolbar() {
    return render(
      <Toolbar
        period="15m"
        onPeriodChange={vi.fn()}
        chartTab="kline"
        onChartTabChange={vi.fn()}
        indicators={{ ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false }}
        onToggleIndicator={vi.fn()}
        gridMode="single"
        onGridModeChange={vi.fn()}
        followLatest={true}
        onBackToLatest={vi.fn()}
        maWindows={[5, 10, 20]}
        onSaveMaWindows={vi.fn(async () => {})}
      />,
    );
  }

  it('周期按钮按 DOM 序严格为 8 档（30m 插在 15m 与 1h 之间，ADR-023 §3.2）', () => {
    const { container } = renderToolbar();
    const got = Array.from(container.querySelectorAll('button'))
      .map((b) => (b.textContent ?? '').trim())
      .filter((t) => PERIOD_LABELS.includes(t));
    expect(got, '工具栏周期按钮必须是 8 档且顺序 1m,5m,15m,30m,1h,日,周,月').toEqual([
      '1m', '5m', '15m', '30m', '1h', '日', '周', '月',
    ]);
  });

  it('点击 30m 按钮 → onPeriodChange("30m")（控件层契约）', async () => {
    const onPeriodChange = vi.fn();
    render(
      <Toolbar
        period="15m"
        onPeriodChange={onPeriodChange}
        chartTab="kline"
        onChartTabChange={vi.fn()}
        indicators={{ ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false }}
        onToggleIndicator={vi.fn()}
        gridMode="single"
        onGridModeChange={vi.fn()}
        followLatest={true}
        onBackToLatest={vi.fn()}
        maWindows={[5, 10, 20]}
        onSaveMaWindows={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '30m' }));
    expect(onPeriodChange).toHaveBeenCalledWith('30m');
  });
});

// ---------------------------------------------------------------- J8-c

const SYMBOLS: SymbolSnapshot[] = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
];

type WsHandler = (msg: unknown) => void;
function fakeWs() {
  const handlers = new Map<string, Set<WsHandler>>();
  return {
    subscribe: vi.fn((topic: string, h: WsHandler) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
  } as unknown as WsClient;
}

function fakeApi(): ApiClient {
  return stubApi({
    getSymbols: vi.fn(async () => SYMBOLS),
    getKline: vi.fn(async () => [
      { ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
    ]),
    getSourcesHealth: vi.fn(async () => ({ window_secs: 3600, sources: [] })),
  });
}

describe('J8-c：点击 30m → 数据层发出 kline 请求 period=30m（DashboardPage 集成）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = fakeApi();
  });

  it('对照组（证明夹具可用）+ 30m 断言', async () => {
    render(
      <MemoryRouter>
        <DashboardPage api={api} ws={fakeWs()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());

    // 对照组：既有档位 '1h' 点击 → period:'1h'（证明本夹具/装配可用 ⇒ 30m 失败不是夹具问题）
    await userEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => {
      expect(api.getKline).toHaveBeenCalledWith(
        expect.objectContaining({ code: '518880', period: '1h' }),
      );
    });

    // 被测：'30m' 点击 → 数据层 period:'30m'
    await userEvent.click(screen.getByRole('button', { name: '30m' }));
    await waitFor(() => {
      expect(api.getKline).toHaveBeenCalledWith(
        expect.objectContaining({ code: '518880', period: '30m' }),
      );
    });
  });
});

// ---------------------------------------------------------------- J9（D2 契约护栏）
//
// **契约演进（2026-09-16，父级授权）**：D1 阶段 J9 断言「30m **不在**前端多周期选择器」（防 D1 越界）。
// D2 的目标正是把 30m 接进多周期 ⇒ 本处按 D2 契约**转向**：「30m **必须**在选择器内且顺序
// `15m → 30m → 1h`」，同时**保留**真正该守的护栏（`1mo` 不提供、既有 6 档一档不少、指定顺序）。
// 前后逐条对照：`/tmp/adr023-d2-red-20260916T152240Z/diff_period30m_tsx.before.tsx` 与本文件 diff。

describe('J9：D2 契约护栏（30m 在多周期选择器内 + 既有档位/顺序不得被削减）', () => {
  it('前端 MULTI_PERIOD_PICKER_PERIODS **必须**含 30m，且顺序为 1m/5m/15m/30m/1h/1d/1w', () => {
    expect(
      MULTI_PERIOD_PICKER_PERIODS,
      'D2 契约（ADR-023 §2.5/§3.2）：`30m` 必须在多周期选择器内；实际 = ' +
        JSON.stringify(MULTI_PERIOD_PICKER_PERIODS),
    ).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w']);
  });

  it('30m 严格位于 15m 与 1h 之间；既有 6 档一档不少；1mo 仍不提供', () => {
    const i15 = MULTI_PERIOD_PICKER_PERIODS.indexOf('15m');
    const i30 = MULTI_PERIOD_PICKER_PERIODS.indexOf('30m');
    const i1h = MULTI_PERIOD_PICKER_PERIODS.indexOf('1h');
    expect(i15, '15m 必须在选择器内').toBeGreaterThanOrEqual(0);
    expect(i1h, '1h 必须在选择器内').toBeGreaterThanOrEqual(0);
    expect(
      i30,
      `顺序必须满足 15m < 30m < 1h；实际 = ${i15}/${i30}/${i1h}`,
    ).toBeGreaterThan(i15);
    expect(i30).toBeLessThan(i1h);
    for (const tier of ['1m', '5m', '15m', '1h', '1d', '1w']) {
      expect(MULTI_PERIOD_PICKER_PERIODS, `D2 纯加法面：既有档位 ${tier} 不得被移除`).toContain(tier);
    }
    expect(MULTI_PERIOD_PICKER_PERIODS, '既有裁决：1mo 不提供').not.toContain('1mo');
  });

  it("chartSyncGroup 的 PERIOD_BUCKET_MS 含 30m = 1800000（本轮**必须**有）", () => {
    expect(
      PERIOD_BUCKET_MS['30m'],
      "ADR-023 §2.5/§3.2：PERIOD_BUCKET_MS['30m'] 必须 = 1_800_000",
    ).toBe(1_800_000);
    expect(periodBucketMs('30m'), 'periodBucketMs("30m") 必须返回 1_800_000（非 null）').toBe(1_800_000);
  });

  it('30m 桶宽与 15m 桶宽严格 2:1（桶边界对齐 ≥ 前提）', () => {
    expect(PERIOD_BUCKET_MS['30m']! / PERIOD_BUCKET_MS['15m']!).toBe(2);
  });
});
