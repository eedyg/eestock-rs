import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type {
  QualityDivergenceResponse,
  QualityGapsResponse,
  SourceAccuracyResponse,
  TushareStatusResponse,
} from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { QualityPage } from './QualityPage';

const DIVERGENCE: QualityDivergenceResponse = {
  code: '518880', from: '2026-08-29', to: '2026-09-04', threshold_pct: 0.5,
  summary: { compared_bars: 615, divergent_bars: 3, divergence_rate: 0.0049, consistency_rate: 0.9951, max_deviation_pct: 1.5216 },
  rows: [
    { ts: '2026-09-02T02:41:00Z', raw_close: 2.468, accurate_close: 2.431, deviation_pct: 1.5216, raw_source: 'sina_jsonp' },
    { ts: '2026-09-02T05:07:00Z', raw_close: 2.402, accurate_close: 2.419, deviation_pct: -0.7028, raw_source: 'sina_jsonp' },
    { ts: '2026-09-01T06:55:00Z', raw_close: 2.455, accurate_close: 2.441, deviation_pct: 0.5735, raw_source: 'tencent_ifzq' },
  ],
};

const ACCURACY: SourceAccuracyResponse = {
  from: '2026-08-29', to: '2026-09-04', threshold_pct: 0.5,
  sources: [
    { source: 'tencent_ifzq', samples: 615, consistency_rate: 0.998, avg_deviation_pct: 0.02, max_deviation_pct: 0.57 },
    { source: 'sina_jsonp', samples: 615, consistency_rate: 0.971, avg_deviation_pct: 0.31, max_deviation_pct: 1.52 },
  ],
};

const GAPS: QualityGapsResponse = {
  code: '518880', from: '2026-08-29', to: '2026-09-04',
  days: [
    { date: '2026-09-02', expected_bars: 241, actual_bars: 235, missing_bars: 6,
      segments: [
        { start: '10:41', end: '10:45', count: 5, class: 'source_fault' },
        { start: '13:07', end: '13:07', count: 1, class: 'upstream_no_data' },
      ] },
  ],
};

const TUSHARE: TushareStatusResponse = {
  checkpoints: [
    { code: '518880', period: '1m', last_synced_date: '2026-09-03', updated_at: '2026-09-03T22:30:00Z' },
  ],
  covered_codes: 44,
  last_updated_at: '2026-09-03T22:30:00Z',
  last_event: { ts: '2026-09-03T22:30:00Z', ok: true, err_kind: null },
  quota_remaining: null,
};

function apiWith(over: Partial<ApiClient> = {}): ApiClient {
  return stubApi({
    getQualityDivergence: vi.fn(async () => structuredClone(DIVERGENCE)),
    getSourceAccuracy: vi.fn(async () => structuredClone(ACCURACY)),
    getQualityGaps: vi.fn(async () => structuredClone(GAPS)),
    getTushareStatus: vi.fn(async () => structuredClone(TUSHARE)),
    ...over,
  });
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function renderPage(api: ApiClient) {
  return render(
    <MemoryRouter initialEntries={['/quality']}>
      <Routes>
        <Route path="/quality" element={<><QualityPage api={api} /><LocationSpy /></>} />
        <Route path="/" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('QualityPage（页面④，骨架 QualityGrid + RegionPortal）', () => {
  it('五区齐备：分歧表+汇总行 / 一致率卡 / sync-panel（按钮置灰）/ 缺口列表 / filter-bar', async () => {
    renderPage(apiWith());
    // 分歧表：行（偏差降序）+ 汇总行
    const table = await screen.findByTestId('divergence-rows');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    // 首行最大偏差 +1.52%（10:41 CST）
    expect(within(rows[0]!).getByText('09-02 10:41')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('+1.52%')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2.468')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2.431')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('−0.70%')).toBeInTheDocument();
    // raw 来源中文标签（sourceMeta 映射）
    expect(within(rows[0]!).getByText('新浪jsonp')).toBeInTheDocument();
    const summary = screen.getByTestId('divergence-summary');
    expect(summary.textContent).toMatch(/比对\s*615\s*bar/);
    expect(summary.textContent).toMatch(/一致率\s*99\.5%/);
    expect(summary.textContent).toMatch(/最大偏差\s*\+?1\.52%/);
    // accuracy-cards：两源卡（腾讯ifzq 亦出现于分歧表 raw 来源列，用 getAll 断言至少一处）
    expect(screen.getAllByText('腾讯ifzq').length).toBeGreaterThan(0);
    expect(screen.getByText(/99\.8%/)).toBeInTheDocument();
    // sync-panel：状态 + 手动同步置灰 + tooltip
    expect(screen.getByText(/覆盖/)).toBeInTheDocument();
    expect(screen.getByText('44')).toBeInTheDocument();
    const syncBtn = screen.getByRole('button', { name: '手动同步' });
    expect(syncBtn).toBeDisabled();
    expect(syncBtn).toHaveAttribute('title', '下阶段开放');
    // quota 恒 null → —
    expect(screen.getByText(/剩余积分/)).toBeInTheDocument();
    // gap-report：缺口日 + 段
    expect(screen.getByText(/缺\s*10:41-10:45/)).toBeInTheDocument();
    expect(screen.getByText(/5\s*bar/)).toBeInTheDocument();
    expect(screen.getByText('源故障')).toBeInTheDocument();
    expect(screen.getByText('上游无数据')).toBeInTheDocument();
    // filter-bar：标的/日期/视图切换
    expect(screen.getByLabelText('标的')).toBeInTheDocument();
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-08-29');
    expect(screen.getByRole('button', { name: '分歧表' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('空态：无比对数据 + 无缺口 + 无样本', async () => {
    const api = apiWith({
      getQualityDivergence: vi.fn(async () => ({
        ...structuredClone(DIVERGENCE),
        summary: { compared_bars: 0, divergent_bars: 0, divergence_rate: null, consistency_rate: null, max_deviation_pct: null },
        rows: [],
      })),
      getSourceAccuracy: vi.fn(async () => ({ ...structuredClone(ACCURACY), sources: [] })),
      getQualityGaps: vi.fn(async () => ({ ...structuredClone(GAPS), days: [] })),
      getTushareStatus: vi.fn(async () => ({
        checkpoints: [], covered_codes: 0, last_updated_at: null, last_event: null, quota_remaining: null,
      })),
    });
    renderPage(api);
    expect(await screen.findByText(/该范围无比对数据/)).toBeInTheDocument();
    expect(screen.getByText('该范围无缺口')).toBeInTheDocument();
    expect(screen.getByText('该窗口无比对样本')).toBeInTheDocument();
    expect(screen.getByText(/从未同步/)).toBeInTheDocument();
  });

  it('错误态+重试：divergence 失败显示错误条，重试后恢复', async () => {
    const api = apiWith({
      getQualityDivergence: vi.fn(async () => {
        throw new Error('HTTP 500');
      }),
    });
    renderPage(api);
    expect(await screen.findByText(/加载失败/)).toBeInTheDocument();
    vi.mocked(api.getQualityDivergence).mockImplementation(async () => structuredClone(DIVERGENCE));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('divergence-rows')).toBeInTheDocument();
  });

  it('视图切换：叠加图渲染 raw/accurate 双线，切回分歧表', async () => {
    const user = userEvent.setup();
    renderPage(apiWith());
    await screen.findByTestId('divergence-rows');
    await user.click(screen.getByRole('button', { name: '叠加图' }));
    const chart = await screen.findByTestId('overlay-chart-svg');
    expect(within(chart).getByTestId('line-raw')).toBeInTheDocument();
    expect(within(chart).getByTestId('line-accurate')).toBeInTheDocument();
    expect(screen.getByText('raw 收盘')).toBeInTheDocument();
    expect(screen.getByText('accurate 收盘')).toBeInTheDocument();
    expect(screen.queryByTestId('divergence-rows')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '分歧表' }));
    expect(await screen.findByTestId('divergence-rows')).toBeInTheDocument();
  });

  it('点行跳行情看板：导航至 /?code=&ts=', async () => {
    const user = userEvent.setup();
    renderPage(apiWith());
    const table = await screen.findByTestId('divergence-rows');
    await user.click(within(table).getAllByRole('row')[0]!);
    await waitFor(() => {
      const loc = screen.getByTestId('location').textContent ?? '';
      expect(loc).toContain('/');
      expect(loc).toContain('code=518880');
      expect(loc).toContain(`ts=${encodeURIComponent('2026-09-02T02:41:00Z')}`);
    });
  });

  it('标的切换即重查：getQualityDivergence 携带新 code', async () => {
    const api = apiWith();
    const user = userEvent.setup();
    renderPage(api);
    await screen.findByTestId('divergence-rows');
    vi.mocked(api.getQualityDivergence).mockClear();
    await user.selectOptions(screen.getByLabelText('标的'), '513310');
    await waitFor(() =>
      expect(api.getQualityDivergence).toHaveBeenCalledWith(expect.objectContaining({ code: '513310' })),
    );
  });
});
