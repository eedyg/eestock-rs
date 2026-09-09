import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { defaultApi } from '@/api';
import type { ApiClient } from '@/api/client';
import type { StrategyRowDto, StrategyVersionRowDto } from '@/api/types';
import { CodeEditor, checkSyntax } from './CodeEditor';
import { DiffView } from './DiffView';
import { DocSidebar } from './DocSidebar';
import { ParamsSchemaPanel } from './ParamsSchemaPanel';
import { TestRunPanel } from './TestRunPanel';
import {
  APPROVAL_LABEL,
  STATUS_LABEL,
  approvalBadgeClass,
  statusBadgeClass,
} from './format';

type SideTab = 'test' | 'params' | 'doc' | 'diff';

/**
 * 策略编辑器 /strategies/:id/edit（12-strategy-system / P2b；ADR §13.5 D13）。
 * 布局：头部（名称/描述编辑 + 版本切换 + 状态/权限徽章 + 保存/发布/归档）+
 * 左侧 CodeMirror 6 编辑器 + 右侧 Tab 栏（试算 / 参数 schema / 指标文档 / 版本 diff）。
 * 保存语义：draft 原地 PUT；published 点保存 → 提示「将自动创建新 draft 版本」→ 确认后 PUT
 * （后端自动落新 draft，outcome=new_draft）→ 刷新版本列表并切到新版本；archived 只读。
 */
export function StrategyEditorPage({ api = defaultApi }: { api?: ApiClient }) {
  const { id = '' } = useParams();
  const [strategy, setStrategy] = useState<StrategyRowDto | null>(null);
  const [versions, setVersions] = useState<StrategyVersionRowDto[] | null>(null);
  const [currentVid, setCurrentVid] = useState('');
  const [code, setCode] = useState('');
  const [savedCode, setSavedCode] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [confirmNewDraft, setConfirmNewDraft] = useState(false);
  const [tab, setTab] = useState<SideTab>('test');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, vs] = await Promise.all([api.getStrategy(id), api.getStrategyVersions(id)]);
      setStrategy(s);
      setName(s.name);
      setDesc(s.description);
      setVersions(vs);
      // 默认选中最新版本（version 最大）
      const latest = vs.length > 0 ? vs.reduce((a, b) => (b.version > a.version ? b : a)) : null;
      if (latest) {
        setCurrentVid((cur) => cur || latest.id);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '加载失败');
    }
  }, [api, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(
    () => versions?.find((v) => v.id === currentVid) ?? null,
    [versions, currentVid],
  );

  // 版本切换 → 载入该版本代码
  useEffect(() => {
    if (!current) return;
    setCode(current.code);
    setSavedCode(current.code);
  }, [current]);

  const dirty = code !== savedCode;
  const metaDirty = strategy !== null && (name !== strategy.name || desc !== strategy.description);
  const archived = current?.status === 'archived';

  const switchVersion = (vid: string) => {
    if (dirty && !window.confirm('有未保存修改，切换版本将丢弃，继续？')) return;
    setCurrentVid(vid);
    setActionError(null);
    setActionMsg(null);
  };

  const handleMetaSave = async () => {
    if (!strategy || !name.trim()) {
      setActionError('名称不能为空');
      return;
    }
    setActionError(null);
    setBusy(true);
    try {
      const patch: { name?: string; description?: string } = {};
      if (name.trim() !== strategy.name) patch.name = name.trim();
      if (desc !== strategy.description) patch.description = desc;
      if (Object.keys(patch).length === 0) return;
      const updated = await api.patchStrategy(strategy.id, patch);
      setStrategy(updated);
      // NIT-3：回填服务端 trim 后值并复位 metaDirty
      setName(updated.name);
      setDesc(updated.description);
      setActionMsg('信息已保存');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const doSaveCode = async () => {
    if (!current) return;
    setActionError(null);
    setBusy(true);
    try {
      const resp = await api.updateStrategyVersion(current.id, code);
      if (resp.outcome === 'new_draft') {
        // published 自动落新 draft（ADR §13.5）：刷新版本列表并切到新版本
        const vs = await api.getStrategyVersions(id);
        setVersions(vs);
        setCurrentVid(resp.version.id);
        setCode(resp.version.code);
        setSavedCode(resp.version.code);
        setActionMsg(`已自动创建新 draft 版本 v${resp.version.version} 并切换`);
      } else {
        // NIT-4：draft 原地保存后刷新版本列表（sha256/schema 摘要即时更新）
        const vs = await api.getStrategyVersions(id);
        setVersions(vs);
        setSavedCode(code);
        setActionMsg('已保存');
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () => {
    if (!current) return;
    if (archived) {
      setActionError('已归档版本不可编辑（可从该版本新建 draft）');
      return;
    }
    const syntax = checkSyntax(code);
    if (syntax) {
      setActionError(`语法检查未通过：${syntax}`);
      return;
    }
    if (current.status === 'published') {
      setConfirmNewDraft(true);
      return;
    }
    void doSaveCode();
  };

  const handlePublish = async () => {
    if (!current || current.status !== 'draft') return;
    if (dirty) {
      setActionError('有未保存修改，请先保存再发布');
      return;
    }
    setActionError(null);
    setBusy(true);
    try {
      await api.publishStrategyVersion(current.id);
      const vs = await api.getStrategyVersions(id);
      setVersions(vs);
      setActionMsg('已发布（门禁冒烟通过）');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '发布失败');
    } finally {
      setBusy(false);
    }
  };

  /** NIT-6：从当前选中版本派生新 draft（任意版本含 archived 可派生）并切换 */
  const handleDeriveDraft = async () => {
    if (!strategy || !current) return;
    if (dirty && !window.confirm('有未保存修改，派生后将切到新 draft，当前修改会丢失，继续？')) return;
    setActionError(null);
    setBusy(true);
    try {
      const nv = await api.createStrategyVersion(strategy.id, current.id);
      const vs = await api.getStrategyVersions(id);
      setVersions(vs);
      setCurrentVid(nv.id);
      setActionMsg(`已从 v${current.version} 派生新 draft v${nv.version} 并切换`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '派生 draft 失败');
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async () => {
    if (!current || current.status !== 'published') return;
    if (!window.confirm(`确认归档 v${current.version}？归档后该版本不再可用于新运行。`)) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.archiveStrategyVersion(current.id);
      const vs = await api.getStrategyVersions(id);
      setVersions(vs);
      setActionMsg('已归档');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '归档失败');
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-4 text-xs" data-region="strategy-editor">
        <div className="rounded-xl border border-line bg-panel p-4 text-up" data-testid="editor-error">
          策略加载失败：{loadError}
          <div className="mt-2">
            <Link to="/strategies" className="text-acc1 hover:underline">
              « 返回策略列表
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!strategy || !versions) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-4" data-region="strategy-editor" data-testid="editor-skeleton">
        <div className="h-9 animate-pulse rounded bg-white/10" />
        <div className="h-64 animate-pulse rounded bg-white/10" />
      </div>
    );
  }

  // MINOR-2：零版本策略 → 空态提示（非永久骨架屏；可从列表「新建版本」创建首个 draft）
  if (versions.length === 0 || !current) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-4 text-xs" data-region="strategy-editor">
        <div className="rounded-xl border border-line bg-panel p-6 text-center text-dim" data-testid="editor-empty">
          「{strategy.name}」暂无任何版本，无法编辑。请先在列表页通过「新建版本」创建首个 draft。
          <div className="mt-3">
            <Link to="/strategies" className="text-acc1 hover:underline">
              « 返回策略列表
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const TABS: Array<{ key: SideTab; label: string }> = [
    { key: 'test', label: '试算' },
    { key: 'params', label: '参数' },
    { key: 'doc', label: '文档' },
    { key: 'diff', label: 'Diff' },
  ];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 text-xs" data-region="strategy-editor">
      {/* 头部：名称/描述 + 版本切换 + 徽章 + 操作 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-3">
        <Link to="/strategies" className="text-dim hover:text-txt">
          « 列表
        </Link>
        <input
          className="h-7 w-44 rounded-lg border border-line bg-panel2 px-2 text-txt"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="meta-name"
          aria-label="策略名称"
        />
        <input
          className="h-7 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          data-testid="meta-desc"
          aria-label="策略描述"
          placeholder="描述"
        />
        <button
          type="button"
          disabled={busy || !metaDirty}
          className="h-7 rounded-lg border border-line px-2 text-dim hover:text-txt disabled:opacity-40"
          onClick={() => void handleMetaSave()}
          data-testid="meta-save"
        >
          保存信息
        </button>
        <select
          className="h-7 rounded-lg border border-line bg-panel2 px-2 text-txt"
          value={currentVid}
          onChange={(e) => switchVersion(e.target.value)}
          data-testid="version-select"
          aria-label="版本切换"
        >
          {[...versions]
            .sort((a, b) => b.version - a.version)
            .map((v) => (
              <option key={v.id} value={v.id}>
                {`v${v.version}（${STATUS_LABEL[v.status]}）`}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={busy}
          title="从当前选中版本派生新 draft（任意版本含 archived 可派生）"
          className="h-7 rounded-lg border border-line px-2 text-dim hover:text-txt disabled:opacity-40"
          onClick={() => void handleDeriveDraft()}
          data-testid="derive-draft-btn"
        >
          派生 draft
        </button>
        <span
          className={`rounded border px-1.5 py-0.5 text-[11px] ${statusBadgeClass(current.status)}`}
          data-testid="status-badge"
        >
          {STATUS_LABEL[current.status]}
        </span>
        <span className={`rounded border px-1.5 py-0.5 text-[11px] ${approvalBadgeClass(current.approval_level)}`}>
          {APPROVAL_LABEL[current.approval_level]}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={busy || archived || !dirty}
            className="h-7 rounded-lg bg-gradient-to-r from-acc1 to-acc2 px-3 font-medium text-white disabled:opacity-40"
            onClick={handleSave}
            data-testid="save-code"
          >
            保存
          </button>
          {current.status === 'draft' && (
            <button
              type="button"
              disabled={busy}
              className="h-7 rounded-lg border border-acc1/50 px-3 text-acc1 hover:bg-acc1/10 disabled:opacity-40"
              onClick={() => void handlePublish()}
              data-testid="publish-btn"
            >
              发布
            </button>
          )}
          {current.status === 'published' && (
            <button
              type="button"
              disabled={busy}
              className="h-7 rounded-lg border border-up/50 px-3 text-up hover:bg-up/10 disabled:opacity-40"
              onClick={() => void handleArchive()}
              data-testid="archive-btn"
            >
              归档
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="action-error">
          {actionError}
        </div>
      )}
      {actionMsg && (
        <div className="rounded-lg border border-acc1/40 bg-acc1/10 p-2 text-acc1" data-testid="action-msg">
          {actionMsg}
        </div>
      )}

      {/* 主体：编辑器 + 右侧 Tab 栏 */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <CodeEditor value={code} onChange={setCode} readOnly={archived} />
          <div className="mt-1 text-[11px] text-dim">
            sha256 {current.sha256.slice(0, 12)}…
            {archived && ' ｜ 已归档版本只读（可从列表「新建版本」派生 draft）'}
            {current.status === 'published' && ' ｜ 已发布版本保存时将自动创建新 draft（防呆）'}
          </div>
        </div>
        <div className="flex w-[420px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
          <div className="flex border-b border-line">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`flex-1 px-2 py-2 text-xs ${
                  tab === t.key ? 'border-b-2 border-acc1 text-txt' : 'text-dim hover:text-txt'
                }`}
                onClick={() => setTab(t.key)}
                data-testid={`tab-${t.key}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'test' && <TestRunPanel api={api} code={code} schema={current.params_schema ?? []} />}
            {tab === 'params' && <ParamsSchemaPanel schema={current.params_schema ?? []} />}
            {tab === 'doc' && <DocSidebar />}
            {tab === 'diff' && <DiffView api={api} versions={versions} />}
          </div>
        </div>
      </div>

      {/* 保存 published 版本防呆确认（ADR §13.5：自动落新 draft） */}
      {confirmNewDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog">
          <div className="w-[380px] rounded-xl border border-line bg-panel p-4 text-xs" data-testid="confirm-newdraft">
            <p className="text-txt">
              当前 v{current.version} 为已发布版本（不可变）。保存将自动创建新 draft 版本，原发布版本保持不变。是否继续？
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-dim hover:text-txt"
                onClick={() => setConfirmNewDraft(false)}
                data-testid="confirm-newdraft-cancel"
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-gradient-to-r from-acc1 to-acc2 px-3 py-1.5 font-medium text-white"
                onClick={() => {
                  setConfirmNewDraft(false);
                  void doSaveCode();
                }}
                data-testid="confirm-newdraft-confirm"
              >
                继续保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
