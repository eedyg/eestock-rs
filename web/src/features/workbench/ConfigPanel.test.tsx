import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StrategyCatalogEntry, WorkbenchPresetConfigInput, WorkbenchPresetRow, WorkbenchRunConfig } from '@/api/types';
import { createMockClient } from '@/api/mock';
import { ConfigPanel } from './ConfigPanel';

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
