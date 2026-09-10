import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import { ApiError } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { StrategiesPage } from './StrategiesPage';

/** 编辑器占位路由（断言新建/新建版本后跳转） */
function EditorStub() {
  const { id } = useParams();
  return <div data-testid="editor-stub">editor:{id}</div>;
}

function renderPage(api: ApiClient) {
  return render(
    <MemoryRouter initialEntries={['/strategies']}>
      <Routes>
        <Route path="/strategies" element={<StrategiesPage api={api} />} />
        <Route path="/strategies/:id/edit" element={<EditorStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StrategiesPage（策略列表页 /strategies：manage 列表 + 过滤 + 新建 + 操作）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = stubApi();
  });

  it('表格渲染：名称/kind/最新版本状态徽章/approval 徽章/版本数/更新时间/操作列', async () => {
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('strategy-table')).toBeInTheDocument());
    // mock 种子 3 行（双均线 published+draft、模板、仅 draft 策略）
    const rows = screen.getAllByTestId(/^strategy-row-/);
    expect(rows).toHaveLength(3);
    // 双均线行：最新版本 = v2 draft（草稿徽章），版本数 2
    const dual = screen.getByTestId('strategy-row-st_mock_dual_ma');
    expect(within(dual).getByText('双均线插件策略')).toBeInTheDocument();
    expect(within(dual).getByText(/草稿/)).toBeInTheDocument();
    expect(within(dual).getByText('2')).toBeInTheDocument();
    // 仅 draft 策略可见（manage 列表含未发布策略——catalog 语义之外的缺口裁决）
    expect(screen.getByText('未发布草稿策略')).toBeInTheDocument();
  });

  it('kind 过滤：选 template 仅显示模板行；approval at-least 过滤：sim_ok 仅显示 sim_ok 及以上', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    await user.selectOptions(screen.getByTestId('filter-kind'), 'template');
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(1));
    expect(screen.getByText('纯评分模板')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('filter-kind'), '');
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    // approval at-least 过滤口径（架构裁决定稿 MINOR-1）：effective = latest_published?.approval_level ?? latest_version?.approval_level。
    // 双均线行 v1 published/sim_ok + v2 draft/backtest_ok → effective=sim_ok（published 优先），sim_ok 过滤不隐藏该行。
    await user.selectOptions(screen.getByTestId('filter-approval'), 'sim_ok');
    await waitFor(() => expect(screen.queryAllByTestId(/^strategy-row-/)).toHaveLength(1));
    expect(screen.getByTestId('strategy-row-st_mock_dual_ma')).toBeInTheDocument();
    // UI 文案注明 at-least 语义
    expect(screen.getByTestId('filter-approval-note')).toHaveTextContent('at-least');
  });

  it('MINOR-1（裁决口径）：徽章取 latest_published ?? latest_version（v1 published/sim_ok + v2 draft/backtest_ok → 徽章 sim_ok）', async () => {
    renderPage(api);
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    const dual = screen.getByTestId('strategy-row-st_mock_dual_ma');
    // 最新版本 v2 draft/backtest_ok，但存在 latest_published v1/sim_ok → 徽章显示 sim_ok（模拟可用）
    expect(within(dual).getByText('模拟可用')).toBeInTheDocument();
    expect(within(dual).queryByText('回测可用')).toBeNull();
    // 仅 draft 无 published 的策略 → 回退 latest_version（draft/backtest_ok → 回测可用）
    const draftRow = screen.getByTestId('strategy-row-st_mock_draft');
    expect(within(draftRow).getByText('回测可用')).toBeInTheDocument();
  });

  it('新建策略（空白）：填名称提交 → createStrategy 调用 → 跳转编辑器', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('create-strategy-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('create-strategy-btn'));
    await user.type(screen.getByTestId('create-name'), '我的新策略');
    await user.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(api.createStrategy).toHaveBeenCalled());
    expect(api.createStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ name: '我的新策略', kind: 'strategy' }),
    );
    await waitFor(() => expect(screen.getByTestId('editor-stub')).toBeInTheDocument());
  });

  it('新建策略（从模板创建）：选模板 → createStrategy code 预填模板代码', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('create-strategy-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('create-strategy-btn'));
    await user.click(screen.getByTestId('create-source-template'));
    await waitFor(() => expect(screen.getByTestId('create-template-select')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('create-template-select'), 'st_mock_tpl_pure');
    await user.type(screen.getByTestId('create-name'), '模板派生策略');
    await user.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(api.createStrategy).toHaveBeenCalled());
    const req = (api.createStrategy as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(req.code).toContain('纯评分模板'); // 模板代码预填（注释行）
  });

  it('新建策略名称为空 → 内联错误，不调用 createStrategy', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('create-strategy-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('create-strategy-btn'));
    await user.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(screen.getByTestId('create-error')).toBeInTheDocument());
    expect(api.createStrategy).not.toHaveBeenCalled();
  });

  it('归档操作：published 最新版本行可归档（confirm 后调 archiveStrategyVersion）；非 published 行归档禁用', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage(api);
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    // 模板行最新版本 v1 published → 可归档
    const tplRow = screen.getByTestId('strategy-row-st_mock_tpl_pure');
    const archiveBtn = within(tplRow).getByTestId('archive-btn');
    expect(archiveBtn).not.toBeDisabled();
    await user.click(archiveBtn);
    await waitFor(() => expect(api.archiveStrategyVersion).toHaveBeenCalledWith('sv_mock_tpl_v1'));
    // 双均线行最新版本为 draft → 归档禁用（仅 published 可归档，409 由后端兜底）
    const dualRow = screen.getByTestId('strategy-row-st_mock_dual_ma');
    expect(within(dualRow).getByTestId('archive-btn')).toBeDisabled();
  });

  it('新建版本操作：从最新版本派生 draft → createStrategyVersion 调用并跳转编辑器', async () => {
    const user = userEvent.setup();
    renderPage(api);
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    const dualRow = screen.getByTestId('strategy-row-st_mock_dual_ma');
    await user.click(within(dualRow).getByTestId('new-version-btn'));
    await waitFor(() =>
      expect(api.createStrategyVersion).toHaveBeenCalledWith('st_mock_dual_ma', 'sv_mock_dual_v2'),
    );
    await waitFor(() => expect(screen.getByTestId('editor-stub')).toHaveTextContent('st_mock_dual_ma'));
  });

  it('加载失败 → 错误占位 + 重试', async () => {
    api = stubApi({
      getStrategyManageList: vi.fn().mockRejectedValue(new Error('boom')),
    });
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('strategy-list-error')).toBeInTheDocument());
  });
});

describe('策略删除 + 手册入口（裁决 2026-09-10）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = stubApi();
  });

  it('删除按钮：deletable=true 行可点；deletable=false（含 published/曾发布）行禁用且有 tooltip 说明', async () => {
    renderPage(api);
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    // 仅 draft 策略 → 可删
    const draftRow = screen.getByTestId('strategy-row-st_mock_draft');
    const delBtn = within(draftRow).getByTestId('delete-btn');
    expect(delBtn).not.toBeDisabled();
    // 双均线（v1 published + v2 draft）→ 禁用 + tooltip
    const dualRow = screen.getByTestId('strategy-row-st_mock_dual_ma');
    const dualDel = within(dualRow).getByTestId('delete-btn');
    expect(dualDel).toBeDisabled();
    expect(dualDel).toHaveAttribute('title', '含已发布版本的策略不可删除，请归档');
    // 模板（published）→ 禁用
    const tplRow = screen.getByTestId('strategy-row-st_mock_tpl_pure');
    expect(within(tplRow).getByTestId('delete-btn')).toBeDisabled();
  });

  it('删除确认流：confirm 取消不调 API；确认后调 deleteStrategy 并刷新列表（行消失）', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage(api);
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    const draftRow = screen.getByTestId('strategy-row-st_mock_draft');
    await user.click(within(draftRow).getByTestId('delete-btn'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.deleteStrategy).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(within(draftRow).getByTestId('delete-btn'));
    await waitFor(() => expect(api.deleteStrategy).toHaveBeenCalledWith('st_mock_draft'));
    // mock 删除生效 → 刷新后行消失
    await waitFor(() => expect(screen.queryByTestId('strategy-row-st_mock_draft')).toBeNull());
    expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(2);
  });

  it('删除 409（竞态：后端拒绝）→ 友好提示「含已发布版本的策略不可删除，请归档」', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api = stubApi({
      deleteStrategy: vi.fn().mockRejectedValue(new ApiError(409, 'HTTP 409: 含已发布版本的策略不可删除，请归档')),
    });
    renderPage(api);
    await waitFor(() => expect(screen.getAllByTestId(/^strategy-row-/)).toHaveLength(3));
    const draftRow = screen.getByTestId('strategy-row-st_mock_draft');
    await user.click(within(draftRow).getByTestId('delete-btn'));
    await waitFor(() => expect(screen.getByTestId('action-error')).toHaveTextContent('含已发布版本的策略不可删除，请归档'));
  });

  it('帮助入口：列表页「📖 完整编程手册」链接新窗口打开 /api/strategies/guide', async () => {
    renderPage(api);
    await waitFor(() => expect(screen.getByTestId('strategy-table')).toBeInTheDocument());
    const link = screen.getByTestId('guide-link');
    expect(link).toHaveTextContent('完整编程手册');
    expect(link).toHaveAttribute('href', '/api/strategies/guide');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
