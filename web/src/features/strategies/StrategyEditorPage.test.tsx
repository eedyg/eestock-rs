import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import { stubApi } from '@/test/apiStub';
import { StrategyEditorPage } from './StrategyEditorPage';

// jsdom 无完整 DOM 测量 API：CodeMirror 整体打桩为受控 textarea（契约与 CodeEditor props 一致）；
// checkSyntax 保留真实实现（保存前的语法门属被测行为）
vi.mock('./CodeEditor', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./CodeEditor')>();
  return {
    ...orig,
    CodeEditor: ({
      value,
      onChange,
      readOnly,
    }: {
      value: string;
      onChange: (v: string) => void;
      readOnly?: boolean;
    }) => (
      <textarea
        data-testid="code-editor"
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    ),
  };
});

function renderEditor(api: ApiClient, id = 'st_mock_dual_ma') {
  return render(
    <MemoryRouter initialEntries={[`/strategies/${id}/edit`]}>
      <Routes>
        <Route path="/strategies/:id/edit" element={<StrategyEditorPage api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StrategyEditorPage（策略编辑器 /strategies/:id/edit）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = stubApi();
  });

  it('加载：头部名称/描述 + 版本下拉默认最新版本（v2 draft）+ 状态徽章 + 代码入编辑器', async () => {
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    expect((screen.getByTestId('meta-name') as HTMLInputElement).value).toBe('双均线插件策略');
    expect((screen.getByTestId('meta-desc') as HTMLInputElement).value).toBe('MA 金叉死叉评分');
    const sel = screen.getByTestId('version-select') as HTMLSelectElement;
    expect(sel.options).toHaveLength(2);
    expect(sel.value).toBe('sv_mock_dual_v2'); // 默认最新版本
    expect(screen.getByTestId('status-badge')).toHaveTextContent('草稿');
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toContain('v2 draft 调整');
  });

  it('名称/描述编辑：保存信息 → patchStrategy', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('meta-name')).toBeInTheDocument());
    await user.clear(screen.getByTestId('meta-name'));
    await user.type(screen.getByTestId('meta-name'), '改名策略');
    await user.click(screen.getByTestId('meta-save'));
    await waitFor(() =>
      expect(api.patchStrategy).toHaveBeenCalledWith('st_mock_dual_ma', { name: '改名策略' }),
    );
  });

  it('NIT-3：meta 保存成功后回填 trim 后值并复位 metaDirty（保存信息按钮禁用）', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('meta-name')).toBeInTheDocument());
    await user.clear(screen.getByTestId('meta-name'));
    await user.type(screen.getByTestId('meta-name'), '改名策略  '); // 尾部空格 → 后端 trim
    await user.click(screen.getByTestId('meta-save'));
    await waitFor(() =>
      expect(api.patchStrategy).toHaveBeenCalledWith('st_mock_dual_ma', { name: '改名策略' }),
    );
    // 回填服务端 trim 后值 + metaDirty 复位
    await waitFor(() =>
      expect((screen.getByTestId('meta-name') as HTMLInputElement).value).toBe('改名策略'),
    );
    expect(screen.getByTestId('meta-save')).toBeDisabled();
  });

  it('MINOR-2：零版本策略 → 渲染空态提示（非永久骨架屏）', async () => {
    api = stubApi({ getStrategyVersions: vi.fn().mockResolvedValue([]) });
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('editor-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('editor-skeleton')).toBeNull();
  });

  it('保存 draft 版本：原地 PUT（outcome=updated），不弹新 draft 提示', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeInTheDocument());
    const ed = screen.getByTestId('code-editor');
    fireEvent.change(ed, { target: { value: (ed as HTMLTextAreaElement).value + '\n// 改动\n' } });
    await user.click(screen.getByTestId('save-code'));
    await waitFor(() =>
      expect(api.updateStrategyVersion).toHaveBeenCalledWith('sv_mock_dual_v2', expect.stringContaining('// 改动')),
    );
    expect(screen.queryByTestId('confirm-newdraft')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('action-msg')).toHaveTextContent('已保存'));
  });

  it('NIT-4：draft 原地保存（outcome=updated）后刷新版本列表 → sha256/schema 摘要即时更新', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeInTheDocument());
    expect(api.getStrategyVersions).toHaveBeenCalledTimes(1); // 初始加载一次
    const shaText = () => screen.getByText(/sha256 sha_/).textContent;
    const before = shaText();
    const newCode = `const PARAMS_SCHEMA = [
  { key: "bias", type: "float", default: 0.5, min: 0, max: 1, description: "偏移" }
];
function on_bar(ctx) { return 50; }
`;
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: newCode } });
    await user.click(screen.getByTestId('save-code'));
    await waitFor(() => expect(screen.getByTestId('action-msg')).toHaveTextContent('已保存'));
    // 保存后重新拉取版本列表（sha256 摘要即时更新）
    await waitFor(() => expect(api.getStrategyVersions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(shaText()).not.toBe(before));
    // schema 摘要（参数面板）即时反映重解析结果
    await user.click(screen.getByTestId('tab-params'));
    await waitFor(() => expect(screen.getByTestId('params-schema-panel')).toHaveTextContent('bias'));
  });

  it('保存 published 版本：提示「将自动创建新 draft 版本」→ 确认 → outcome=new_draft 后切到新版本', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    // 切到 v1（published）
    await user.selectOptions(screen.getByTestId('version-select'), 'sv_mock_dual_v1');
    const ed = screen.getByTestId('code-editor');
    fireEvent.change(ed, { target: { value: (ed as HTMLTextAreaElement).value + '\n// 修改\n' } });
    await user.click(screen.getByTestId('save-code'));
    // 防呆提示（ADR §13.5）
    await waitFor(() => expect(screen.getByTestId('confirm-newdraft')).toHaveTextContent('将自动创建新 draft 版本'));
    expect(api.updateStrategyVersion).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('confirm-newdraft-confirm'));
    await waitFor(() =>
      expect(api.updateStrategyVersion).toHaveBeenCalledWith('sv_mock_dual_v1', expect.stringContaining('// 修改')),
    );
    // mock 返回 new_draft v3 → 版本列表刷新并切换
    await waitFor(() => {
      const sel = screen.getByTestId('version-select') as HTMLSelectElement;
      expect(sel.options).toHaveLength(3);
      expect(sel.value).toContain('sv_mock_');
      expect(sel.value).not.toBe('sv_mock_dual_v1');
      expect(sel.value).not.toBe('sv_mock_dual_v2');
    });
    expect(screen.getByTestId('action-msg')).toHaveTextContent('新 draft');
  });

  it('MINOR-3：published 保存（自动新 draft）后 mock 重解析 PARAMS_SCHEMA → 参数面板/试算参数即时更新', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('version-select'), 'sv_mock_dual_v1');
    const newCode = `const PARAMS_SCHEMA = [
  { key: "bias", type: "float", default: 0.5, min: 0, max: 1, description: "偏移" }
];
function on_bar(ctx) { return 50; }
`;
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: newCode } });
    await user.click(screen.getByTestId('save-code'));
    await waitFor(() => expect(screen.getByTestId('confirm-newdraft')).toBeInTheDocument());
    await user.click(screen.getByTestId('confirm-newdraft-confirm'));
    await waitFor(() => expect(screen.getByTestId('action-msg')).toHaveTextContent('新 draft'));
    // 参数面板：新 schema（bias）即时可见，旧键 fast/slow 消失
    await user.click(screen.getByTestId('tab-params'));
    await waitFor(() => expect(screen.getByTestId('params-schema-panel')).toHaveTextContent('bias'));
    expect(screen.getByTestId('params-schema-panel')).not.toHaveTextContent('快线周期');
    // 试算面板：参数输入同步为新 schema
    await user.click(screen.getByTestId('tab-test'));
    await waitFor(() => expect(screen.getByTestId('tr-param-bias')).toBeInTheDocument());
  });

  it('NIT-6：版本下拉旁「从此版本派生 draft」——任意版本（含 archived）可派生并切换到新 draft', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    // 切到 v1（published）并归档 → archived 版本仍可派生
    await user.selectOptions(screen.getByTestId('version-select'), 'sv_mock_dual_v1');
    await user.click(screen.getByTestId('archive-btn'));
    await waitFor(() => expect(screen.getByTestId('status-badge')).toHaveTextContent('已归档'));
    const deriveBtn = screen.getByTestId('derive-draft-btn');
    expect(deriveBtn).not.toBeDisabled();
    await user.click(deriveBtn);
    await waitFor(() =>
      expect(api.createStrategyVersion).toHaveBeenCalledWith('st_mock_dual_ma', 'sv_mock_dual_v1'),
    );
    // 版本列表刷新并切到新 draft
    await waitFor(() => {
      const sel = screen.getByTestId('version-select') as HTMLSelectElement;
      expect(sel.options).toHaveLength(3);
    });
    expect(screen.getByTestId('status-badge')).toHaveTextContent('草稿');
  });

  it('发布：draft 版本点发布 → publishStrategyVersion → 状态刷为已发布', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('publish-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('publish-btn'));
    await waitFor(() => expect(api.publishStrategyVersion).toHaveBeenCalledWith('sv_mock_dual_v2'));
    await waitFor(() => expect(screen.getByTestId('status-badge')).toHaveTextContent('已发布'));
  });

  it('发布门禁失败（400）→ 错误内联展示', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeInTheDocument());
    // 改为无 on_bar 的合法代码（mock 门禁：缺 on_bar → 400）
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'const x = 1;' } });
    await user.click(screen.getByTestId('save-code'));
    await waitFor(() => expect(screen.getByTestId('action-msg')).toHaveTextContent('已保存'));
    await user.click(screen.getByTestId('publish-btn'));
    await waitFor(() => expect(screen.getByTestId('action-error')).toHaveTextContent(/门禁|400/));
  });

  it('归档：published 版本点归档（confirm）→ archiveStrategyVersion', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('version-select'), 'sv_mock_dual_v1');
    await waitFor(() => expect(screen.getByTestId('archive-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('archive-btn'));
    await waitFor(() => expect(api.archiveStrategyVersion).toHaveBeenCalledWith('sv_mock_dual_v1'));
    await waitFor(() => expect(screen.getByTestId('status-badge')).toHaveTextContent('已归档'));
  });

  it('参数 schema 面板：只读表格展示 fast/slow（key/类型/默认值/范围/描述）', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    await user.click(screen.getByTestId('tab-params'));
    const panel = screen.getByTestId('params-schema-panel');
    expect(within(panel).getByText('fast')).toBeInTheDocument();
    expect(within(panel).getByText('slow')).toBeInTheDocument();
    expect(within(panel).getByText('快线周期')).toBeInTheDocument();
    expect(within(panel).getAllByText('int').length).toBeGreaterThan(0);
  });

  it('指标 API 文档侧栏：列出 indicators 签名与 position/log/save/load 契约', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    await user.click(screen.getByTestId('tab-doc'));
    const doc = screen.getByTestId('doc-sidebar');
    for (const kw of ['ma(n)', 'ema(n)', 'macd()', 'kdj()', 'boll(n, mult)', 'rsi(n)', 'atr(n)', 'position', 'ctx.log', 'save()', 'load(state)', '数据不足返回 null']) {
      expect(doc).toHaveTextContent(kw);
    }
  });

  it('版本 diff：选两版本 → diffStrategyVersions → 渲染 add/del 行', async () => {
    const user = userEvent.setup();
    renderEditor(api);
    await waitFor(() => expect(screen.getByTestId('version-select')).toBeInTheDocument());
    await user.click(screen.getByTestId('tab-diff'));
    await waitFor(() => expect(screen.getByTestId('diff-run')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('diff-from'), 'sv_mock_dual_v1');
    await user.selectOptions(screen.getByTestId('diff-to'), 'sv_mock_dual_v2');
    await user.click(screen.getByTestId('diff-run'));
    await waitFor(() => expect(api.diffStrategyVersions).toHaveBeenCalledWith('sv_mock_dual_v1', 'sv_mock_dual_v2'));
    await waitFor(() => expect(screen.getByTestId('diff-result')).toBeInTheDocument());
    // v2 = v1 + 尾部注释行 → 至少一行 add
    expect(screen.getAllByTestId('diff-line-add').length).toBeGreaterThan(0);
    expect(screen.getByTestId('diff-result')).toHaveTextContent('v2 draft 调整');
  });

  it('加载未知策略 → 404 错误占位', async () => {
    render(
      <MemoryRouter initialEntries={['/strategies/st_missing/edit']}>
        <Routes>
          <Route path="/strategies/:id/edit" element={<StrategyEditorPage api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('editor-error')).toBeInTheDocument());
  });
});
