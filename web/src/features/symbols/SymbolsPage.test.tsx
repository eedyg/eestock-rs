import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import { ApiError, type SymbolRow } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { SymbolsPage } from './SymbolsPage';

const ROWS: SymbolRow[] = [
  { code: '518880', name: '黄金ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:23:00Z', last: 2.431, change_pct: 0.62 }, today_bars: 205 },
  { code: '161226', name: '白银LOF', interval_secs: 300, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:20:00Z', last: 0.982, change_pct: 1.15 }, today_bars: 41 },
  { code: '159776', name: '港股通医药', interval_secs: 60, settlement: 'T1', enabled: false, latest: null, today_bars: 0 },
];

function statefulApi() {
  let rows = ROWS.map((r) => ({ ...r }));
  return stubApi({
    getSymbolsAdmin: vi.fn(async () => rows.map((r) => ({ ...r }))),
    registerSymbol: vi.fn(async (input) => {
      const row: SymbolRow = {
        code: input.code, name: input.name ?? null,
        interval_secs: input.interval_secs ?? 60, settlement: input.settlement ?? 'T1',
        enabled: input.enabled ?? true, latest: null, today_bars: 0,
      };
      rows = [...rows, row];
      return { ...row };
    }),
    updateSymbol: vi.fn(async (code, patch) => {
      const idx = rows.findIndex((r) => r.code === code);
      if (idx < 0) throw new ApiError(404, 'HTTP 404: code 未注册');
      const cur = rows[idx]!;
      const next: SymbolRow = {
        ...cur,
        name: patch.name !== undefined ? patch.name : cur.name,
        interval_secs: patch.interval_secs ?? cur.interval_secs,
        settlement: patch.settlement ?? cur.settlement,
        enabled: patch.enabled ?? cur.enabled,
      };
      rows = [...rows.slice(0, idx), next, ...rows.slice(idx + 1)];
      return { ...next };
    }),
  });
}

function renderPage(api: ApiClient, confirm?: (m: string) => boolean) {
  return render(
    <MemoryRouter>
      <SymbolsPage api={api} confirm={confirm} />
    </MemoryRouter>,
  );
}

describe('SymbolsPage（页面③标的管理：表格 + 注册/编辑模态 + 启停）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = statefulApi();
  });

  it('骨架区域齐备 + 表格行渲染（code/名称/间隔/启用/今日bar/最新时刻/操作）', async () => {
    const { container } = renderPage(api);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    expect(container.querySelector('[data-region="table-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-region="symbol-table"]')).not.toBeNull();
    expect(screen.getByText('共 3 只')).toBeInTheDocument();
    const row = screen.getByText('518880').closest('tr')!;
    expect(within(row).getByText('60s')).toBeInTheDocument();
    expect(within(row).getByText('205')).toBeInTheDocument();
    expect(within(row).getByText('10:23:00')).toBeInTheDocument(); // UTC→CST
    expect(within(row).getByText('编辑')).toBeInTheDocument();
    expect(within(row).getByText('停用')).toBeInTheDocument();
    // 停用行置灰 + 操作列显示「启用」、无 bar 显示 —
    const disabledRow = screen.getByText('159776').closest('tr')!;
    expect(disabledRow.className).toContain('opacity');
    expect(within(disabledRow).getByText('启用')).toBeInTheDocument();
    expect(within(disabledRow).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('空态：未注册标的 + 注册引导；错误态：错误条 + 重试恢复', async () => {
    api = stubApi({ getSymbolsAdmin: vi.fn(async () => []) });
    const { unmount } = renderPage(api);
    await waitFor(() => expect(screen.getByText('未注册标的')).toBeInTheDocument());
    expect(screen.getAllByText(/注册标的/).length).toBeGreaterThan(0);
    unmount();
    const fail = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue(ROWS);
    api = stubApi({ getSymbolsAdmin: fail });
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
  });

  it('注册弹窗：打开/取消关闭/遮罩点击不关闭', async () => {
    const user = userEvent.setup();
    const { container } = renderPage(api);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '+ 注册标的' }));
    await waitFor(() => expect(screen.getByText('注册标的', { selector: 'h3' })).toBeInTheDocument());
    // 遮罩点击不关闭（防误触，03-symbols 定稿）
    await user.click(container.querySelector('[data-region="form-dialog"]')!);
    expect(screen.getByText('注册标的', { selector: 'h3' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByText('注册标的', { selector: 'h3' })).toBeNull(),
    );
  });

  it('注册成功：填 code → 保存 → POST + 弹窗关闭 + 列表新增', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '+ 注册标的' }));
    await user.type(screen.getByLabelText(/code/), '600519');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.registerSymbol).toHaveBeenCalledWith({
        code: '600519', name: undefined, interval_secs: 60, settlement: 'T1', enabled: true,
      }),
    );
    await waitFor(() => expect(screen.getByText('600519')).toBeInTheDocument());
    expect(screen.queryByText('注册标的', { selector: 'h3' })).toBeNull();
  });

  it('注册校验：北交所 code 内联提示且不调 API', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '+ 注册标的' }));
    await user.type(screen.getByLabelText(/code/), '830799');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(screen.getByText(/北交所.*暂不支持/)).toBeInTheDocument(),
    );
    expect(api.registerSymbol).not.toHaveBeenCalled();
    expect(screen.getByText('注册标的', { selector: 'h3' })).toBeInTheDocument();
  });

  it('编辑：code 只读 + 值预填；settlement 变更需二次确认后保存', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    const row = screen.getByText('518880').closest('tr')!;
    await user.click(within(row).getByText('编辑'));
    await waitFor(() => expect(screen.getByText('编辑标的', { selector: 'h3' })).toBeInTheDocument());
    const codeInput = screen.getByLabelText(/code/) as HTMLInputElement;
    expect(codeInput.value).toBe('518880');
    expect(codeInput).toHaveAttribute('readonly');
    // settlement T0→T1：出现二次确认，未勾选保存被拦
    await user.selectOptions(screen.getByLabelText(/交收规则/), 'T1');
    await waitFor(() => expect(screen.getByText(/影响回测撮合/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(api.updateSymbol).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /确认修改/ }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.updateSymbol).toHaveBeenCalledWith('518880', expect.objectContaining({ settlement: 'T1' })),
    );
  });

  it('停用：确认后 PATCH enabled:false；启用无需确认', async () => {
    const confirm = vi.fn(() => true);
    const user = userEvent.setup();
    renderPage(api, confirm);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await user.click(within(screen.getByText('518880').closest('tr')!).getByText('停用'));
    await waitFor(() =>
      expect(api.updateSymbol).toHaveBeenCalledWith('518880', { enabled: false }),
    );
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(within(screen.getByText('518880').closest('tr')!).getByText('启用')).toBeInTheDocument(),
    );
    // 启用：不弹确认
    vi.clearAllMocks();
    await user.click(within(screen.getByText('518880').closest('tr')!).getByText('启用'));
    await waitFor(() =>
      expect(api.updateSymbol).toHaveBeenCalledWith('518880', { enabled: true }),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('提交中：保存按钮禁用 + spinner 文案', async () => {
    let resolve: ((v: SymbolRow) => void) | null = null;
    api = stubApi({
      getSymbolsAdmin: vi.fn(async () => ROWS),
      registerSymbol: vi.fn(
        () =>
          new Promise<SymbolRow>((r) => {
            resolve = r;
          }),
      ),
    });
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '+ 注册标的' }));
    await user.type(screen.getByLabelText(/code/), '600519');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /保存中/ })).toBeDisabled());
    resolve!({
      code: '600519', name: null, interval_secs: 60, settlement: 'T1', enabled: true, latest: null,
    });
    await waitFor(() => expect(screen.queryByText('注册标的', { selector: 'h3' })).toBeNull());
  });
});
