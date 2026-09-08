import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import { stubApi } from '@/test/apiStub';
import { SettingsPage } from './SettingsPage';

function renderPage(api: ApiClient) {
  return render(
    <MemoryRouter>
      <SettingsPage api={api} />
    </MemoryRouter>,
  );
}

describe('SettingsPage（页面⑧系统设置：骨架锚点 + 只读/运维区 + S2 占位）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = stubApi();
  });

  it('骨架区域齐备：settings-nav + 6 内容区（source/collector/mcp/system/log/danger）', async () => {
    const { container } = renderPage(api);
    await waitFor(() => expect(screen.getByText('腾讯ifzq')).toBeInTheDocument());
    for (const r of [
      'settings-nav',
      'source-config',
      'collector-config',
      'mcp-config',
      'system-info',
      'log-viewer',
      'danger-zone',
    ]) {
      expect(container.querySelector(`[data-region="${r}"]`)).not.toBeNull();
    }
  });

  it('system-info 渲染：应用/crate 版本、DB 状态、运行时长', async () => {
    renderPage(api);
    await waitFor(() => expect(screen.getByText(/v0.1.0/)).toBeInTheDocument());
    expect(screen.getByText(/collector 0.1.0/)).toBeInTheDocument();
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.getByText(/运行/)).toBeInTheDocument();
  });

  it('源参数面板：保存启用，编辑速率→PATCH 乐观更新，值域非法禁用保存', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('腾讯ifzq')).toBeInTheDocument());

    const saveBtn = screen.getByTestId('save-sources');
    expect(saveBtn).toBeEnabled();

    // 编辑速率（10）→ 保存 → PATCH /api/config/sources（完整清单 + 东财末位）
    const rateInput = screen.getByLabelText('tencent_ifzq 速率');
    await user.clear(rateInput);
    await user.type(rateInput, '10');
    await user.tab();
    await user.click(saveBtn);
    await waitFor(() => expect(api.saveConfigSources).toHaveBeenCalled());
    const arg = (api.saveConfigSources as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { id: string; rate_per_sec: number }[];
    const ifzq = arg.find((s) => s.id === 'tencent_ifzq')!;
    expect(ifzq.rate_per_sec).toBe(10);
    expect(arg[arg.length - 1]!.id).toBe('push2delay'); // 东财末位
    await waitFor(() => expect(screen.getByText(/已保存/)).toBeInTheDocument());
  });

  it('源参数面板：东财（push2delay）不可上移（ADR-006），参数<0 禁用保存', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('腾讯ifzq')).toBeInTheDocument());

    // push2delay 上移按钮禁用（东财末位锁定 ADR-006）
    const up = screen.getByLabelText('push2delay 上移');
    expect(up).toBeDisabled();

    // 参数<0（熔断次数）→ 保存禁用（NumInput 提交于 blur，选 blur 后校验生效）
    const circuit = screen.getByLabelText('tencent_ifzq 熔断次数');
    await user.clear(circuit);
    await user.type(circuit, '-1');
    await user.tab(); // 触发 onBlur 提交
    expect(screen.getByTestId('save-sources')).toBeDisabled();
  });

  it('采集参数面板：编辑间隔→PATCH collector（≥60），非法禁用保存', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText(/默认抓取间隔/)).toBeInTheDocument());

    const input = screen.getByLabelText('默认抓取间隔（秒）');
    await user.clear(input);
    await user.type(input, '120');
    expect(screen.getByTestId('save-collector')).toBeEnabled();
    await user.click(screen.getByTestId('save-collector'));
    await waitFor(() => expect(api.saveConfigCollector).toHaveBeenCalledWith({ default_interval_sec: 120 }));

    // <60 非法 → 保存禁用
    await user.clear(input);
    await user.type(input, '30');
    expect(screen.getByTestId('save-collector')).toBeDisabled();
  });

  it('MCP 面板：交易工具开启需二次确认（ADR-009）→确认→保存 PATCH mcp，限额非法禁用', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText(/MCP 服务总开关/)).toBeInTheDocument());

    // 交易工具开启 → 弹二次确认（ADR-009）
    await user.click(screen.getByLabelText('交易工具开关'));
    expect(screen.getByTestId('mcp-confirm-tools')).toBeInTheDocument();
    await user.click(screen.getByTestId('mcp-confirm-tools'));

    // 编辑金额/笔数 → 保存
    const amount = screen.getByLabelText('每日下单金额');
    const count = screen.getByLabelText('每日下单笔数');
    await user.clear(amount); await user.type(amount, '100000');
    await user.clear(count); await user.type(count, '30');
    await user.click(screen.getByTestId('save-mcp'));
    await waitFor(() => expect(api.saveConfigMcp).toHaveBeenCalledWith(
      expect.objectContaining({ trading_tools_enabled: true, daily_limit_amount: 100000, daily_limit_count: 30 }),
    ));

    // 金额<0 → 非法禁用保存
    await user.clear(amount); await user.type(amount, '-1');
    expect(screen.getByTestId('save-mcp')).toBeDisabled();
  });

  it('配置保存失败（后端 400）→ 提示错误并回滚', async () => {
    const user = userEvent.setup();
    (api.saveConfigCollector as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HTTP 400: default_interval_sec 须 ≥60'));
    renderPage(api);
    await waitFor(() => expect(screen.getByText(/默认抓取间隔/)).toBeInTheDocument());
    const input = screen.getByLabelText('默认抓取间隔（秒）');
    await user.clear(input); await user.type(input, '120');
    await user.click(screen.getByTestId('save-collector'));
    await waitFor(() => expect(screen.getByTestId('save-collector-err')).toHaveTextContent(/保存失败|HTTP/));
  });

  it('danger-zone：confirm 为空时破坏按钮禁用（缺失被拒）；输入 PURGE 后方可触发', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('清空 kline_raw')).toBeInTheDocument());
    const purgeBtn = screen.getByRole('button', { name: '清空 kline_raw' });
    // confirm 缺失：按钮禁用 → 不触发请求（前端「缺失被拒」）
    expect(purgeBtn).toBeDisabled();
    expect(api.purgeRaw).not.toHaveBeenCalled();
    // 输入 PURGE → 按钮可用 → 点击 → 调 POST purge-raw
    await user.type(screen.getByTestId('danger-confirm-input'), 'PURGE');
    expect(purgeBtn).toBeEnabled();
    await user.click(purgeBtn);
    await waitFor(() => expect(api.purgeRaw).toHaveBeenCalledWith('PURGE'));
  });

  it('danger-zone：服务端 confirm 拒绝（400）→ 错误提示展示', async () => {
    (api.purgeRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('HTTP 400: confirm 字段缺失或不匹配（须为 PURGE）'),
    );
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('清空 kline_raw')).toBeInTheDocument());
    await user.type(screen.getByTestId('danger-confirm-input'), 'PURGE');
    await user.click(screen.getByRole('button', { name: '清空 kline_raw' }));
    await waitFor(() => expect(screen.getByTestId('danger-message')).toHaveTextContent(/操作失败/));
  });

  it('log-viewer：S2 占位提示（需日志采集层）', async () => {
    renderPage(api);
    await waitFor(() =>
      expect(screen.getByText(/日志跟随将在下一阶段上线/)).toBeInTheDocument(),
    );
  });
});
