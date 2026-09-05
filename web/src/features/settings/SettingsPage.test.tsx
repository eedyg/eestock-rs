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

  it('只读配置区：源/采集/MCP 保存按钮禁用，且标注 S2 占位', async () => {
    renderPage(api);
    await waitFor(() => {
      expect(screen.getAllByText('参数配置化将在下一阶段上线（S2）').length).toBeGreaterThanOrEqual(3);
    });
    const saveBtns = screen.getAllByRole('button', { name: '保存' });
    expect(saveBtns.length).toBeGreaterThanOrEqual(3);
    for (const b of saveBtns) expect(b).toBeDisabled();
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
