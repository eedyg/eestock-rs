import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategyCatalogEntry, WorkbenchPresetConfigInput, WorkbenchPresetRow, WorkbenchRunConfig } from '@/api/types';
import { createMockClient } from '@/api/mock';
import { ConfigPanel } from './ConfigPanel';

// ADR-024 P0 §5.1 —— 周期下拉的**独立期望**：取自契约向量（**不是**被测常量自身，否则是同义反复）。
// 单一真相：`design/16-backtest-scalability/contract-vectors.json::backtest_periods`。
// 该期望与产出解耦：删掉 constants 里的 'M30'、或组件改成手写第二份白名单，本用例都必须变红。
// web/src/features/workbench → 仓库根
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_VECTORS = JSON.parse(
  readFileSync(resolve(HERE, '../../../../design/16-backtest-scalability/contract-vectors.json'), 'utf8'),
) as { backtest_periods: string[] };

const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
let catalogCache: StrategyCatalogEntry[] | null = null;
async function loadCatalog(): Promise<StrategyCatalogEntry[]> {
  catalogCache ??= await api.getStrategyCatalog();
  return catalogCache;
}

function mkProps(over: Record<string, unknown> = {}) {
  const base = {
    catalog: catalogCache,
    catalogLoading: false,
    catalogError: null as string | null,
    onRetryCatalog: vi.fn(),
    symbols: [
      { code: '518880', name: '黄金ETF', enabled: true, last: 2.4, changePct: 0, favorite: false, favoriteSort: null },
    ],
    presets: [] as WorkbenchPresetRow[],
    submitting: false,
    submitError: null as string | null,
    onSubmit: vi.fn(),
    onApplyPreset: vi.fn(),
    onCreatePreset: vi.fn(async (_name: string, _config: unknown) => {}),
    onUpdatePreset: vi.fn(async (_id: string, _name: string, _config: unknown) => {}),
    onRenamePreset: vi.fn(async (_id: string, _name: string) => {}),
    onDeletePreset: vi.fn(async () => {}),
  };
  return { ...base, ...over };
}

describe('ConfigPanel（页面⑪ 配置区：策略多选/权重/参数/阈值/Policy/止损/预设）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await loadCatalog();
  });

  // ADR-024 P0：周期下拉必须覆盖回测单一事实源全集（含 M30），不得手写第二份。
  // 期望 = 契约向量（独立期望）；对 M30 成员资格**敏感**（删常量里的 M30 即红）。
  it('周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望）', () => {
    render(<ConfigPanel {...mkProps()} />);
    const sel = screen.getByTestId('wb-period') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(CONTRACT_VECTORS.backtest_periods);
  });

  it('catalog 渲染到策略下拉；添加策略 → slot 卡片（权重 + schema 参数表单）', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    const addSelect = screen.getByTestId('wb-add-strategy') as HTMLSelectElement;
    // catalog 2 条（双均线 + 纯评分模板；draft-only 策略不在 catalog）
    expect(addSelect.options.length).toBe(1 + catalogCache!.length); // 含占位项
    await user.selectOptions(addSelect, 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    expect(screen.getByTestId('slot-card-sv_mock_dual_v1')).toBeInTheDocument();
    expect((screen.getByTestId('slot-weight-sv_mock_dual_v1') as HTMLInputElement).value).toBe('1');
    // schema 驱动参数表单（fast/slow 默认值）
    expect((screen.getByTestId('slot-param-sv_mock_dual_v1-fast') as HTMLInputElement).value).toBe('5');
    expect((screen.getByTestId('slot-param-sv_mock_dual_v1-slow') as HTMLInputElement).value).toBe('20');
    // 重复添加同一版本被拒（下拉已过滤已选）
    expect([...addSelect.options].some((o) => o.value === 'sv_mock_dual_v1')).toBe(false);
  });

  it('校验：空 slots 提交 → 内联错误，不触发 onSubmit', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await user.click(screen.getByTestId('wb-submit'));
    expect(screen.getByTestId('wb-form-error')).toHaveTextContent('至少添加 1 个策略');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('校验：阈值倒挂（buy ≤ sell）→ 内联错误', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.clear(screen.getByTestId('wb-buy-threshold'));
    await user.type(screen.getByTestId('wb-buy-threshold'), '30');
    await user.clear(screen.getByTestId('wb-sell-threshold'));
    await user.type(screen.getByTestId('wb-sell-threshold'), '70');
    await user.click(screen.getByTestId('wb-submit'));
    expect(screen.getByTestId('wb-form-error')).toHaveTextContent('买入阈值须大于卖出阈值');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('校验：schema 参数越界 / 权重 ≤0 → 内联错误', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.clear(screen.getByTestId('slot-param-sv_mock_dual_v1-fast'));
    await user.type(screen.getByTestId('slot-param-sv_mock_dual_v1-fast'), '999');
    await user.click(screen.getByTestId('wb-submit'));
    expect(screen.getByTestId('wb-form-error')).toHaveTextContent('超出范围');
    await user.clear(screen.getByTestId('slot-param-sv_mock_dual_v1-fast'));
    await user.type(screen.getByTestId('slot-param-sv_mock_dual_v1-fast'), '10');
    await user.clear(screen.getByTestId('slot-weight-sv_mock_dual_v1'));
    await user.type(screen.getByTestId('slot-weight-sv_mock_dual_v1'), '0');
    await user.click(screen.getByTestId('wb-submit'));
    expect(screen.getByTestId('wb-form-error')).toHaveTextContent('权重须 > 0');
  });

  it('默认提交：LumpSum + 无止损 + 60/40 + fee snake_case + RFC3339 区间', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    const req = props.onSubmit.mock.calls[0]![0];
    expect(req).toMatchObject({
      symbol: '518880',
      period: 'D1',
      buy_threshold: 60,
      sell_threshold: 40,
      initial_capital: 100000,
      policy: { LumpSum: { position_pct: 1 } },
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    });
    expect(req.stop).toBeNull();
    expect(req.slots).toEqual([{ version_id: 'sv_mock_dual_v1', params: { fast: 5, slow: 20 }, weight: 1 }]);
    expect(Date.parse(req.from)).not.toBeNaN();
    expect(Date.parse(req.to)).not.toBeNaN();
    expect(Date.parse(req.from)).toBeLessThan(Date.parse(req.to));
  });

  it('DCA policy + 硬止损：表单切换渲染并正确序列化（Dca/StopConfig serde 形态）', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.selectOptions(screen.getByTestId('wb-policy-kind'), 'Dca');
    await user.clear(screen.getByTestId('wb-dca-tranches'));
    await user.type(screen.getByTestId('wb-dca-tranches'), '4');
    await user.selectOptions(screen.getByTestId('wb-dca-mode'), 'FixedAmount');
    await user.clear(screen.getByTestId('wb-dca-amount'));
    await user.type(screen.getByTestId('wb-dca-amount'), '5000');
    await user.clear(screen.getByTestId('wb-dca-interval'));
    await user.type(screen.getByTestId('wb-dca-interval'), '3');
    await user.click(screen.getByTestId('wb-stop-enabled'));
    await user.selectOptions(screen.getByTestId('wb-stop-kind'), 'Trailing');
    await user.clear(screen.getByTestId('wb-stop-value'));
    await user.type(screen.getByTestId('wb-stop-value'), '0.1');
    await user.selectOptions(screen.getByTestId('wb-stop-trigger'), 'CloseBasis');
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    const req = props.onSubmit.mock.calls[0]![0];
    expect(req.policy).toEqual({ Dca: { tranches: 4, mode: 'FixedAmount', amount: 5000, interval: 3 } });
    expect(req.stop).toEqual({ kind: 'Trailing', value: 0.1, trigger: 'CloseBasis' });
  });

  // D6（2026-09-19）：前端与后端 `Dca.validate()` 的 fail-loud 同口径——`interval=0` 必须在**表单层**
  // 被拦截，绝不把 0 发给后端（防回归：既有校验在 ConfigPanel.tsx 的 `DCA 批间隔须为 ≥1 整数`）。
  it('D6：DCA 批间隔=0 被前端拦截（渲染错误且不提交）', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.selectOptions(screen.getByTestId('wb-policy-kind'), 'Dca');
    await user.clear(screen.getByTestId('wb-dca-tranches'));
    await user.type(screen.getByTestId('wb-dca-tranches'), '3');
    await user.clear(screen.getByTestId('wb-dca-interval'));
    await user.type(screen.getByTestId('wb-dca-interval'), '0');
    await user.click(screen.getByTestId('wb-submit'));
    expect(await screen.findByTestId('wb-form-error')).toHaveTextContent('DCA 批间隔须为 ≥1 整数');
    expect(props.onSubmit).not.toHaveBeenCalled();
    // 边界：1 合法（不得把 ≥1 写成 ≥2）。
    await user.clear(screen.getByTestId('wb-dca-interval'));
    await user.type(screen.getByTestId('wb-dca-interval'), '1');
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    expect(props.onSubmit.mock.calls[0]![0].policy).toEqual({
      Dca: { tranches: 3, mode: 'Equal', amount: null, interval: 1 },
    });
  });

  it('预设：选中应用 → 表单回填（slots/阈值/policy/止损）；保存为预设 → onCreatePreset 当前配置', async () => {
    const user = userEvent.setup();
    const pinnedConfig: WorkbenchRunConfig = {
      slots: [{
        strategy_id: 'st_mock_dual_ma', version_id: 'sv_mock_dual_v1', version: 1,
        sha256: 'sha_x', params: { fast: 9, slow: 30 }, weight: 2,
      }],
      buy_threshold: 65,
      sell_threshold: 35,
      policy: { LumpSum: { position_pct: 0.5 } },
      stop: { kind: 'FixedPct', value: 0.08, trigger: 'Intrabar' },
      initial_capital: 200000,
      fee: { rate_pct: 0.03, min_fee: 6, slippage_bp: 3 },
    };
    const preset: WorkbenchPresetRow = {
      id: 'sp_1', name: '组合A', config: pinnedConfig,
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    };
    const props = mkProps({
      presets: [preset],
      onApplyPreset: vi.fn(async () => pinnedConfig),
    });
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-preset-select'), 'sp_1');
    await waitFor(() => expect(props.onApplyPreset).toHaveBeenCalledWith('sp_1'));
    // 回填：slot 卡片 + 参数值 + 阈值 + policy + 止损 + 资金
    await waitFor(() => expect(screen.getByTestId('slot-card-sv_mock_dual_v1')).toBeInTheDocument());
    expect((screen.getByTestId('slot-param-sv_mock_dual_v1-fast') as HTMLInputElement).value).toBe('9');
    expect((screen.getByTestId('slot-weight-sv_mock_dual_v1') as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('wb-buy-threshold') as HTMLInputElement).value).toBe('65');
    expect((screen.getByTestId('wb-position-pct') as HTMLInputElement).value).toBe('0.5');
    expect((screen.getByTestId('wb-stop-enabled') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('wb-initial-capital') as HTMLInputElement).value).toBe('200000');
    // 保存为预设：名字 + 当前表单配置（未钉住形态 slots）
    await user.clear(screen.getByTestId('wb-preset-name'));
    await user.type(screen.getByTestId('wb-preset-name'), '组合B');
    await user.click(screen.getByTestId('wb-preset-save'));
    await waitFor(() => expect(props.onCreatePreset).toHaveBeenCalled());
    const call = props.onCreatePreset.mock.calls[0]! as unknown as [string, WorkbenchPresetConfigInput];
    const [name, config] = call;
    expect(name).toBe('组合B');
    expect(config.slots).toEqual([{ version_id: 'sv_mock_dual_v1', params: { fast: 9, slow: 30 }, weight: 2 }]);
    expect(config.buy_threshold).toBe(65);
  });

  it('预设管理：重命名 / 删除回调', async () => {
    const user = userEvent.setup();
    const preset: WorkbenchPresetRow = {
      id: 'sp_1', name: '组合A',
      config: {
        slots: [{ strategy_id: 'st_mock_dual_ma', version_id: 'sv_mock_dual_v1', version: 1, sha256: 'x', params: {}, weight: 1 }],
        buy_threshold: 60, sell_threshold: 40, policy: { LumpSum: { position_pct: 1 } },
        stop: null, initial_capital: 100000, fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
      },
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    };
    // NIT-3：apply 成功后才落 presetSel —— 本用例 onApplyPreset 须 resolve（默认 vi.fn() 返回 undefined 视为失败）
    const props = mkProps({ presets: [preset], onApplyPreset: vi.fn(async () => preset.config) });
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-preset-select'), 'sp_1');
    await waitFor(() => expect((screen.getByTestId('wb-preset-select') as HTMLSelectElement).value).toBe('sp_1'));
    await user.clear(screen.getByTestId('wb-preset-name'));
    await user.type(screen.getByTestId('wb-preset-name'), '组合A2');
    await user.click(screen.getByTestId('wb-preset-rename'));
    await waitFor(() => expect(props.onRenamePreset).toHaveBeenCalledWith('sp_1', '组合A2'));
    await user.click(screen.getByTestId('wb-preset-delete'));
    await waitFor(() => expect(props.onDeletePreset).toHaveBeenCalledWith('sp_1'));
  });

  it('catalog 加载失败 → 错误占位 + 重试', async () => {
    const user = userEvent.setup();
    const props = mkProps({ catalog: null, catalogError: 'HTTP 503: strategies 未配置' });
    render(<ConfigPanel {...props} />);
    expect(screen.getByTestId('wb-catalog-error')).toHaveTextContent('503');
    await user.click(screen.getByText('重试'));
    expect(props.onRetryCatalog).toHaveBeenCalled();
  });

  it('校验：slots 超 10 上限 → 提交前友好提示，不触发 onSubmit（与后端 1..=10 同口径）', async () => {
    const user = userEvent.setup();
    // 合成 11 版本 catalog（slots 上限行为与 catalog 规模解耦）
    const base = catalogCache![0]!;
    const bigCatalog: StrategyCatalogEntry[] = Array.from({ length: 11 }, (_, i) => ({
      strategy: { ...base.strategy, id: `st_big_${i}` },
      version: { ...base.version, id: `sv_big_${i}`, strategy_id: `st_big_${i}` },
    }));
    const props = mkProps({ catalog: bigCatalog });
    render(<ConfigPanel {...props} />);
    for (let i = 0; i < 11; i++) {
      await user.selectOptions(screen.getByTestId('wb-add-strategy'), `sv_big_${i}`);
      await user.click(screen.getByTestId('wb-add-btn'));
    }
    await user.click(screen.getByTestId('wb-submit'));
    expect(screen.getByTestId('wb-form-error')).toHaveTextContent('1..=10');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('预设就地更新：应用后改参 → 脏标记可见 + 保存走 onUpdatePreset（PUT）；应用失败 → presetSel 回退不落选中态', async () => {
    const user = userEvent.setup();
    const pinnedConfig: WorkbenchRunConfig = {
      slots: [{
        strategy_id: 'st_mock_dual_ma', version_id: 'sv_mock_dual_v1', version: 1,
        sha256: 'sha_x', params: { fast: 9, slow: 30 }, weight: 2,
      }],
      buy_threshold: 65,
      sell_threshold: 35,
      policy: { LumpSum: { position_pct: 0.5 } },
      stop: null,
      initial_capital: 200000,
      fee: { rate_pct: 0.03, min_fee: 6, slippage_bp: 3 },
    };
    const preset: WorkbenchPresetRow = {
      id: 'sp_1', name: '组合A', config: pinnedConfig,
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    };
    const props = mkProps({
      presets: [preset],
      onApplyPreset: vi.fn(async () => pinnedConfig),
      onUpdatePreset: vi.fn(async (_id: string, _name: string, _config: unknown) => {}),
    });
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-preset-select'), 'sp_1');
    await waitFor(() => expect(screen.getByTestId('slot-card-sv_mock_dual_v1')).toBeInTheDocument());
    // 应用后未改 → 无脏标记，选中态落定
    expect((screen.getByTestId('wb-preset-select') as HTMLSelectElement).value).toBe('sp_1');
    expect(screen.queryByTestId('wb-preset-dirty')).toBeNull();
    // 改参 → 脏标记出现
    await user.clear(screen.getByTestId('slot-param-sv_mock_dual_v1-fast'));
    await user.type(screen.getByTestId('slot-param-sv_mock_dual_v1-fast'), '10');
    await waitFor(() => expect(screen.getByTestId('wb-preset-dirty')).toBeInTheDocument());
    // 保存 → PUT 就地更新（当前表单 config），不再 POST 新建（同名不撞 409）
    await user.click(screen.getByTestId('wb-preset-save'));
    await waitFor(() => expect(props.onUpdatePreset).toHaveBeenCalled());
    const call = props.onUpdatePreset.mock.calls[0]! as unknown as [string, string, WorkbenchPresetConfigInput];
    expect(call[0]).toBe('sp_1');
    expect(call[1]).toBe('组合A');
    expect(call[2].slots).toEqual([{ version_id: 'sv_mock_dual_v1', params: { fast: 10, slow: 30 }, weight: 2 }]);
    expect(call[2].buy_threshold).toBe(65);
    expect(props.onCreatePreset).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('wb-preset-msg')).toHaveTextContent('已更新'));
    // 更新后脏标记消除
    expect(screen.queryByTestId('wb-preset-dirty')).toBeNull();
  });

  it('预设应用失败：presetSel 回退原值（不落选中态），错误提示可见', async () => {
    const user = userEvent.setup();
    const preset: WorkbenchPresetRow = {
      id: 'sp_1', name: '组合A',
      config: {
        slots: [{ strategy_id: 'st_mock_dual_ma', version_id: 'sv_mock_dual_v1', version: 1, sha256: 'x', params: {}, weight: 1 }],
        buy_threshold: 60, sell_threshold: 40, policy: { LumpSum: { position_pct: 1 } },
        stop: null, initial_capital: 100000, fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
      },
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    };
    const props = mkProps({
      presets: [preset],
      onApplyPreset: vi.fn(async () => {
        throw new Error('HTTP 404: 预设不存在');
      }),
    });
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-preset-select'), 'sp_1');
    await waitFor(() => expect(screen.getByTestId('wb-preset-msg')).toHaveTextContent('预设应用失败'));
    expect((screen.getByTestId('wb-preset-select') as HTMLSelectElement).value).toBe('');
  });
});

// ─────────────── ADR-024 P5 §5.2/§5.3：可得区间联动 + 收缩提示条 + 资源护栏二次确认 ───────────────

describe('ConfigPanel（ADR-024 P5：区间联动 / 收缩提示 / resource_guard 二次确认）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await loadCatalog();
  });

  it('日期控件 min/max 随可得区间联动 + 展示可用区间', async () => {
    const loadAvailableRange = vi.fn(async () => ({
      symbol: '518880',
      period: 'D1',
      available_from: '2012-01-04T01:30:00Z',
      available_to: '2026-09-16T00:00:00Z',
    }));
    render(<ConfigPanel {...mkProps({ loadAvailableRange })} />);
    await waitFor(() => {
      expect((screen.getByTestId('wb-date-from') as HTMLInputElement).min).toBe('2012-01-04');
    });
    expect((screen.getByTestId('wb-date-from') as HTMLInputElement).max).toBe('2026-09-16');
    expect((screen.getByTestId('wb-date-to') as HTMLInputElement).min).toBe('2012-01-04');
    expect((screen.getByTestId('wb-date-to') as HTMLInputElement).max).toBe('2026-09-16');
    expect(screen.getByTestId('wb-available-range').textContent).toContain('2012-01-04');
    expect(screen.getByTestId('wb-available-range').textContent).toContain('2026-09-16');
    expect(loadAvailableRange).toHaveBeenCalledWith('518880', 'D1');
  });

  it('clamped:true ⇒ 显著提示条可见（不弹确认框）', () => {
    render(
      <ConfigPanel
        {...mkProps({
          clampNotice: {
            requestedFrom: '2012-01-01T00:00:00Z',
            requestedTo: '2026-12-31T00:00:00Z',
            effectiveFrom: '2012-01-04T01:30:00Z',
            effectiveTo: '2026-09-16T00:00:00Z',
          },
        })}
      />,
    );
    const notice = screen.getByTestId('wb-clamp-notice');
    expect(notice.textContent).toContain('收缩');
    expect(notice.textContent).toContain('2026-09-16');
  });

  it('resource_guard ⇒ 二次确认（展示预估 bar 数/耗时；确认/取消回调）', async () => {
    const user = userEvent.setup();
    const onConfirmGuard = vi.fn();
    const onDismissGuard = vi.fn();
    render(
      <ConfigPanel
        {...mkProps({
          guardPrompt: { bars: 290000, secs: 182.35 },
          onConfirmGuard,
          onDismissGuard,
        })}
      />,
    );
    const prompt = screen.getByTestId('wb-guard-prompt');
    expect(prompt.textContent).toContain('290000');
    expect(prompt.textContent).toContain('182.3'); // 182.35.toFixed(1) === '182.3'（JS 浮点舍入）
    await user.click(screen.getByTestId('wb-guard-confirm'));
    expect(onConfirmGuard).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('wb-guard-cancel'));
    expect(onDismissGuard).toHaveBeenCalledTimes(1);
  });
});

// ───────────── ADR-029 Step 1（Web 侧）：`ExecutionPolicy::Exposure` = 目标 × ramp × guard ─────────────
// 契约事实源：`design/01-architecture/adr/ADR-029-execution-policy-exposure-ramp-guard.md`（D3–D5/D8/§4）
//   + `design/12-strategy-system/05-plan-exposure-ramp-step1.md`（E11 校验 + §1 JSON 形状）。
// 期望载荷 = **独立**写死（变体 PascalCase / 字段 snake_case、**无 rename**、`Immediate` 为空载荷 `null`）；
// 默认值取派工指定的**保守**组（实现改默认值 ⇒ 本组用例必须变红）。

describe('ConfigPanel（ADR-029 Step 1：Exposure 目标 × ramp × guard）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await loadCatalog();
  });

  /** 添加 1 个 slot 并把 ExecutionPolicy 切到 `Exposure`。 */
  async function pickExposure(user: UserEvent): Promise<void> {
    await user.selectOptions(screen.getByTestId('wb-add-strategy'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('wb-add-btn'));
    await user.selectOptions(screen.getByTestId('wb-policy-kind'), 'Exposure');
  }

  async function setField(user: UserEvent, testId: string, value: string): Promise<void> {
    await user.clear(screen.getByTestId(testId));
    await user.type(screen.getByTestId(testId), value);
  }

  it('E11/§1：ScoreMapped + RateCap 提交载荷 = 契约 JSON 形状（字段名逐一核对，无 rename）', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await pickExposure(user);
    expect(screen.getByTestId('wb-exposure-fields')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
    // 保守默认值**显式**落值（不依赖后端缺省；改默认值 ⇒ 本断言变红）
    expect((screen.getByTestId('wb-exposure-at-threshold-pct') as HTMLInputElement).value).toBe('0.2');
    expect((screen.getByTestId('wb-exposure-at-full-pct') as HTMLInputElement).value).toBe('0.5');
    expect((screen.getByTestId('wb-exposure-sell') as HTMLSelectElement).value).toBe('Flat');
    expect((screen.getByTestId('wb-ramp-kind') as HTMLSelectElement).value).toBe('RateCap');
    expect((screen.getByTestId('wb-ramp-pct-per-bar') as HTMLInputElement).value).toBe('0.05');
    expect((screen.getByTestId('wb-guard-max-pct') as HTMLInputElement).value).toBe('0.9');
    expect((screen.getByTestId('wb-guard-min-pct') as HTMLInputElement).value).toBe('0');
    expect((screen.getByTestId('wb-guard-deadzone-pct') as HTMLInputElement).value).toBe('0.005');
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    const req = props.onSubmit.mock.calls[0]![0];
    expect(req.policy).toEqual({
      Exposure: {
        target: { ScoreMapped: { at_threshold_pct: 0.2, at_full_pct: 0.5, sell: 'Flat' } },
        ramp: { RateCap: { pct_per_bar: 0.05 } },
        guard: { max_pct: 0.9, min_pct: 0, deadzone_pct: 0.005 },
      },
    });
    // 键名/大小写（禁 rename）：顶层 target/ramp/guard，guard 内三键 snake_case
    expect(Object.keys(req.policy.Exposure)).toEqual(['target', 'ramp', 'guard']);
    expect(Object.keys(req.policy.Exposure.guard)).toEqual(['max_pct', 'min_pct', 'deadzone_pct']);
    expect(Object.keys(req.policy.Exposure.ramp)).toEqual(['RateCap']);
  });

  it('E11/§1：Fixed + Immediate 载荷形状（`Immediate` 为**空载荷 null**，不得写成 {} / "Immediate"）', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await pickExposure(user);
    // 默认目标维 = Fixed（常数目标，= 现 LumpSum 的目标语义）
    expect((screen.getByTestId('wb-exposure-target') as HTMLSelectElement).value).toBe('Fixed');
    await setField(user, 'wb-exposure-fixed-pct', '0.3');
    await user.selectOptions(screen.getByTestId('wb-ramp-kind'), 'Immediate');
    expect(screen.queryByTestId('wb-ramp-pct-per-bar')).toBeNull(); // Immediate 无速率字段
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    const req = props.onSubmit.mock.calls[0]![0];
    expect(req.policy).toEqual({
      Exposure: {
        target: { Fixed: { pct: 0.3 } },
        ramp: { Immediate: null },
        guard: { max_pct: 0.9, min_pct: 0, deadzone_pct: 0.005 },
      },
    });
    // 空载荷形态（serde 单元变体）：JSON 化后必须是 `{"Immediate":null}`
    expect(JSON.stringify(req.policy.Exposure.ramp)).toBe('{"Immediate":null}');
  });

  it('E11：Scaled 卖出侧可选 + 改字段后载荷跟随（sell 两支都用例）', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await pickExposure(user);
    await user.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
    await user.selectOptions(screen.getByTestId('wb-exposure-sell'), 'Scaled');
    await setField(user, 'wb-exposure-at-threshold-pct', '0.25');
    await setField(user, 'wb-exposure-at-full-pct', '0.6');
    await setField(user, 'wb-ramp-pct-per-bar', '0.1');
    await setField(user, 'wb-guard-max-pct', '0.8');
    await setField(user, 'wb-guard-min-pct', '0.05');
    await setField(user, 'wb-guard-deadzone-pct', '0.01');
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    expect(props.onSubmit.mock.calls[0]![0].policy).toEqual({
      Exposure: {
        target: { ScoreMapped: { at_threshold_pct: 0.25, at_full_pct: 0.6, sell: 'Scaled' } },
        ramp: { RateCap: { pct_per_bar: 0.1 } },
        guard: { max_pct: 0.8, min_pct: 0.05, deadzone_pct: 0.01 },
      },
    });
  });

  /** E11 逐条：全部在**表单层** fail loud（不发请求、不静默回退默认值）。 */
  const E11_CASES: Array<{ name: string; setup: (u: UserEvent) => Promise<void>; expect: RegExp }> = [
    {
      name: 'at_full_pct < at_threshold_pct',
      setup: async (u) => {
        await u.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
        await setField(u, 'wb-exposure-at-threshold-pct', '0.5');
        await setField(u, 'wb-exposure-at-full-pct', '0.3');
      },
      expect: /at_full_pct.*须 ≥ at_threshold_pct/,
    },
    {
      name: 'at_full_pct > guard.max_pct',
      setup: async (u) => {
        await u.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
        await setField(u, 'wb-exposure-at-full-pct', '0.95');
      },
      expect: /at_full_pct.*须 ≤ guard\.max_pct/,
    },
    {
      name: 'min_pct > max_pct',
      setup: async (u) => {
        await setField(u, 'wb-guard-min-pct', '0.95');
      },
      expect: /0 ≤ min_pct ≤ max_pct ≤ 1/,
    },
    {
      name: 'max_pct > 1',
      setup: async (u) => {
        await setField(u, 'wb-guard-max-pct', '1.2');
      },
      expect: /0 ≤ min_pct ≤ max_pct ≤ 1/,
    },
    {
      name: 'min_pct < 0',
      setup: async (u) => {
        await setField(u, 'wb-guard-min-pct', '-0.1');
      },
      expect: /0 ≤ min_pct ≤ max_pct ≤ 1/,
    },
    {
      name: 'deadzone_pct < 0',
      setup: async (u) => {
        await setField(u, 'wb-guard-deadzone-pct', '-0.01');
      },
      // R1/R5 量纲：deadzone_pct = **暴露比例差**（与 position_ratio 同量纲）——错误文案必须带量纲
      expect: /deadzone_pct.*暴露比例差.*须 ≥ 0/,
    },
    {
      name: 'pct_per_bar = 0',
      setup: async (u) => {
        await setField(u, 'wb-ramp-pct-per-bar', '0');
      },
      // R1/R5 量纲：pct_per_bar = 每 bar 允许变动金额 / 净值
      expect: /pct_per_bar.*净值.*须 > 0/,
    },
    {
      // ScoreMapped 映射分母 100−buy_threshold 为 0 ⇒ 映射无定义（05-plan §3）
      name: 'buy_threshold = 100（ScoreMapped）',
      setup: async (u) => {
        await u.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
        await setField(u, 'wb-buy-threshold', '100');
      },
      expect: /买入阈值 < 100|卖出阈值 > 0/,
    },
    {
      name: 'sell_threshold = 0（ScoreMapped）',
      setup: async (u) => {
        await u.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
        await setField(u, 'wb-sell-threshold', '0');
      },
      // 既有「阈值须为正数」在前，口径等价（分母/边界非零）；两者任一即视为 fail loud
      expect: /卖出阈值 > 0|阈值须为正数/,
    },
    {
      name: 'Fixed.pct = 0',
      setup: async (u) => {
        await setField(u, 'wb-exposure-fixed-pct', '0');
      },
      expect: /Fixed\.pct.*净值占比.*\(0,1\]/,
    },
    {
      name: 'Fixed.pct > 1',
      setup: async (u) => {
        await setField(u, 'wb-exposure-fixed-pct', '1.5');
      },
      expect: /Fixed\.pct.*净值占比.*\(0,1\]/,
    },
  ];

  for (const c of E11_CASES) {
    it(`E11 校验：${c.name} ⇒ 构造期报错且不提交`, async () => {
      const user = userEvent.setup();
      const props = mkProps();
      render(<ConfigPanel {...props} />);
      await pickExposure(user);
      await c.setup(user);
      await user.click(screen.getByTestId('wb-submit'));
      expect(screen.getByTestId('wb-form-error')).toHaveTextContent(c.expect);
      expect(props.onSubmit).not.toHaveBeenCalled();
    });
  }

  it('E15/E16（契约补充）：非零 min_pct 只约束持有态、**不阻塞清仓** —— 表单提示与校验文案都写明', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await pickExposure(user);
    // ① 提交前提示（常驻，不依赖输入值）
    const guardNote = screen.getByTestId('wb-exposure-guard-note');
    expect(guardNote).toHaveTextContent('仅约束持有态');
    expect(guardNote).toHaveTextContent('不阻塞清仓');
    expect(guardNote).toHaveTextContent('目标仍为 0');
    // ② 字段标签也带量纲外的语义限定
    expect(screen.getByTestId('wb-guard-min-pct').closest('label')?.textContent ?? '').toContain('不清仓');
    // ③ 设置非零下限后仍**可合法提交**（下限不是「不清仓开关」，不引入额外阻断）
    await setField(user, 'wb-guard-min-pct', '0.05');
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    expect(props.onSubmit.mock.calls[0]![0].policy.Exposure.guard).toEqual({
      max_pct: 0.9,
      min_pct: 0.05,
      deadzone_pct: 0.005,
    });
  });

  it('E11 边界（鉴别力）：buy_threshold = 100 在 **Fixed** 目标下合法（< 100 的约束只针对 ScoreMapped 分母）', async () => {
    const user = userEvent.setup();
    const props = mkProps();
    render(<ConfigPanel {...props} />);
    await pickExposure(user);
    await setField(user, 'wb-buy-threshold', '100');
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    expect(props.onSubmit.mock.calls[0]![0].policy.Exposure.target).toEqual({ Fixed: { pct: 0.3 } });
  });

  it('R2（契约修订）：`sell` 选项只属于 ScoreMapped —— Fixed 分支不渲染（Fixed 卖侧语义 = 回到目标 0，等价 LumpSum）', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel {...mkProps()} />);
    await user.selectOptions(screen.getByTestId('wb-policy-kind'), 'Exposure');
    expect((screen.getByTestId('wb-exposure-target') as HTMLSelectElement).value).toBe('Fixed');
    expect(screen.queryByTestId('wb-exposure-sell')).toBeNull();
    // Fixed 侧的等价披露（不得让用户以为 Fixed 需要 sell 配置）
    expect(screen.getByTestId('wb-exposure-disclosure')).toHaveTextContent('Fixed');
    expect(screen.getByTestId('wb-exposure-disclosure')).toHaveTextContent('score ≤ sell_threshold');
    await user.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
    expect(screen.getByTestId('wb-exposure-sell')).toBeInTheDocument();
    // 切回 Fixed 后提交载荷中 target 不含 sell 键（固定形状）
    await user.selectOptions(screen.getByTestId('wb-exposure-target'), 'Fixed');
    expect(screen.queryByTestId('wb-exposure-sell')).toBeNull();
  });

  it('D7 披露：配置处标注「总分曲线是诊断量、不等于仓位」+ 映射端点/guard 摘要；非 Exposure 不渲染', async () => {
    const user = userEvent.setup();
    render(<ConfigPanel {...mkProps()} />);
    // 默认 LumpSum ⇒ 无 Exposure 披露（零回归）
    expect(screen.queryByTestId('wb-exposure-disclosure')).toBeNull();
    await user.selectOptions(screen.getByTestId('wb-policy-kind'), 'Exposure');
    const note = screen.getByTestId('wb-exposure-disclosure');
    expect(note).toHaveTextContent('总分曲线是诊断量');
    expect(note).toHaveTextContent('不等于仓位');
    await user.selectOptions(screen.getByTestId('wb-exposure-target'), 'ScoreMapped');
    // 端点摘要随「买/卖阈值 + 端点字段」联动（score=买入阈值 ⇒ at_threshold_pct）
    expect(note).toHaveTextContent('score=60');
    expect(note).toHaveTextContent('at_threshold_pct=20.0%');
    expect(note).toHaveTextContent('at_full_pct=50.0%');
    // D8：guard 由 run 级给出、策略无权覆盖 —— 必须**披露**该不变式
    expect(note).toHaveTextContent('max_pct=90.0%');
    expect(note).toHaveTextContent('策略无权覆盖');
    expect(note).toHaveTextContent('deadzone_pct=0.50%');
    expect(note).toHaveTextContent('pct_per_bar=5.0%');
    // R6（契约修订）：两支卖出语义各一句话说清（Flat = 直接清仓；Scaled = 对称降档到两端点之间）
    expect(note).toHaveTextContent('Flat = 直接清仓');
    await user.selectOptions(screen.getByTestId('wb-exposure-sell'), 'Scaled');
    expect(note).toHaveTextContent('Scaled = 对称降档');
    expect(note).toHaveTextContent('score=0');
    expect(note).toHaveTextContent('score=40');
    // R1/R5 量纲提示：三个量纲各不相同，必须在表单处标明
    expect(note).toHaveTextContent('净值占比');
    expect(note).toHaveTextContent('暴露比例差');
    expect(note).toHaveTextContent('每 bar 允许变动金额 / 净值');
    // 切回 Dca ⇒ 披露消失（不为旧模式新增噪音）
    await user.selectOptions(screen.getByTestId('wb-policy-kind'), 'Dca');
    expect(screen.queryByTestId('wb-exposure-disclosure')).toBeNull();
  });

  it('预设回填：Exposure（ScoreMapped + RateCap + guard）逐字段回到表单并可原样再提交（round-trip）', async () => {
    const user = userEvent.setup();
    const exposurePolicy = {
      Exposure: {
        target: { ScoreMapped: { at_threshold_pct: 0.15, at_full_pct: 0.45, sell: 'Scaled' } },
        ramp: { RateCap: { pct_per_bar: 0.02 } },
        guard: { max_pct: 0.8, min_pct: 0.02, deadzone_pct: 0.002 },
      },
    } as const;
    const pinnedConfig: WorkbenchRunConfig = {
      slots: [{
        strategy_id: 'st_mock_dual_ma', version_id: 'sv_mock_dual_v1', version: 1,
        sha256: 'sha_x', params: { fast: 5, slow: 20 }, weight: 1,
      }],
      buy_threshold: 70,
      sell_threshold: 30,
      policy: exposurePolicy,
      stop: null,
      initial_capital: 100000,
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    };
    const preset: WorkbenchPresetRow = {
      id: 'sp_exp', name: 'Exposure 预设', config: pinnedConfig,
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    };
    const props = mkProps({ presets: [preset], onApplyPreset: vi.fn(async () => pinnedConfig) });
    render(<ConfigPanel {...props} />);
    await user.selectOptions(screen.getByTestId('wb-preset-select'), 'sp_exp');
    await waitFor(() => expect(screen.getByTestId('wb-exposure-fields')).toBeInTheDocument());
    expect((screen.getByTestId('wb-policy-kind') as HTMLSelectElement).value).toBe('Exposure');
    expect((screen.getByTestId('wb-exposure-target') as HTMLSelectElement).value).toBe('ScoreMapped');
    expect((screen.getByTestId('wb-exposure-sell') as HTMLSelectElement).value).toBe('Scaled');
    expect((screen.getByTestId('wb-exposure-at-threshold-pct') as HTMLInputElement).value).toBe('0.15');
    expect((screen.getByTestId('wb-ramp-pct-per-bar') as HTMLInputElement).value).toBe('0.02');
    expect((screen.getByTestId('wb-guard-max-pct') as HTMLInputElement).value).toBe('0.8');
    expect((screen.getByTestId('wb-guard-min-pct') as HTMLInputElement).value).toBe('0.02');
    expect((screen.getByTestId('wb-guard-deadzone-pct') as HTMLInputElement).value).toBe('0.002');
    // round-trip：未改动即无脏标记，且再提交载荷与预设快照一致（无字段丢失）
    expect(screen.queryByTestId('wb-preset-dirty')).toBeNull();
    await user.click(screen.getByTestId('wb-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    expect(props.onSubmit.mock.calls[0]![0].policy).toEqual(exposurePolicy);
  });
});
