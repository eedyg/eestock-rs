import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { defaultApi } from '@/api';
import type { ApiClient } from '@/api/client';
import type { StrategyApprovalLevel, StrategyKind, StrategyManageItem } from '@/api/types';
import { CreateStrategyModal } from './CreateStrategyModal';
import {
  APPROVAL_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  approvalBadgeClass,
  approvalSatisfies,
  formatDateTime,
  statusBadgeClass,
} from './format';

/**
 * 策略列表页 /strategies（12-strategy-system / P2b）。
 * 数据源：GET /api/strategies/manage（含仅 draft 策略；catalog 仅 published 不满足列表语义——
 * 架构裁决 2026-09-09 缺口 1 选 A 补端点）。
 * 过滤：kind / approval_level 均为前端客户端过滤（approval 为 at-least 语义，UI 注明）；
 * approval 口径（架构裁决 MINOR-1）：`latest_published?.approval_level ?? latest_version?.approval_level`。
 * 操作：编辑 / 新建版本（从最新版本派生 draft 后进编辑器）/ 归档（仅最新版本为 published 可点）。
 */
export function StrategiesPage({ api = defaultApi }: { api?: ApiClient }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<StrategyManageItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<StrategyKind | ''>('');
  const [approvalFilter, setApprovalFilter] = useState<StrategyApprovalLevel | ''>('');
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    api
      .getStrategyManageList()
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [api]);
  useEffect(() => refresh(), [refresh]);

  const visible = useMemo(() => {
    if (!items) return null;
    return items.filter((it) => {
      if (kindFilter && it.kind !== kindFilter) return false;
      if (approvalFilter) {
        // 裁决口径（MINOR-1）：latest_published 优先，回退 latest_version
        const lvl = it.latest_published?.approval_level ?? it.latest_version?.approval_level;
        if (!lvl || !approvalSatisfies(lvl, approvalFilter)) return false;
      }
      return true;
    });
  }, [items, kindFilter, approvalFilter]);

  const handleArchive = async (it: StrategyManageItem) => {
    const v = it.latest_version;
    if (!v || v.status !== 'published') return;
    if (!window.confirm(`确认归档「${it.name}」的最新版本 v${v.version}？归档后该版本不再可用于新运行。`)) return;
    setActionError(null);
    try {
      await api.archiveStrategyVersion(v.id);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '归档失败');
    }
  };

  const handleNewVersion = async (it: StrategyManageItem) => {
    const v = it.latest_version;
    if (!v) return;
    setActionError(null);
    try {
      await api.createStrategyVersion(it.id, v.id);
      navigate(`/strategies/${encodeURIComponent(it.id)}/edit`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '新建版本失败');
    }
  };

  return (
    <div data-region="strategies" className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4 text-xs">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-medium text-txt">策略管理</h1>
        <button
          type="button"
          className="rounded-lg bg-gradient-to-r from-acc1 to-acc2 px-3 py-1.5 font-medium text-white"
          onClick={() => setShowCreate(true)}
          data-testid="create-strategy-btn"
        >
          + 新建策略
        </button>
      </div>

      {/* 过滤栏 */}
      <div className="flex items-center gap-3" data-region="strategy-filter">
        <label className="flex items-center gap-1 text-dim">
          类别
          <select
            className="h-7 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as StrategyKind | '')}
            data-testid="filter-kind"
          >
            <option value="">全部</option>
            <option value="strategy">策略</option>
            <option value="template">模板</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-dim">
          权限级别
          <select
            className="h-7 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={approvalFilter}
            onChange={(e) => setApprovalFilter(e.target.value as StrategyApprovalLevel | '')}
            data-testid="filter-approval"
          >
            <option value="">全部</option>
            <option value="backtest_ok">回测可用</option>
            <option value="sim_ok">模拟可用</option>
            <option value="live_approved">实盘批准</option>
          </select>
        </label>
        <span className="text-[11px] text-dim" data-testid="filter-approval-note">
          权限过滤为 at-least 语义：选中级别及以上均显示
        </span>
      </div>

      {actionError && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="action-error">
          {actionError}
        </div>
      )}

      {error ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4 text-up" data-testid="strategy-list-error">
          <span>策略列表加载失败：{error}</span>
          <button type="button" className="self-start rounded-lg border border-line px-3 py-1 text-dim hover:text-txt" onClick={refresh}>
            重试
          </button>
        </div>
      ) : visible === null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4" data-testid="strategy-list-skeleton">
          <div className="h-7 animate-pulse rounded bg-white/10" />
          <div className="h-7 animate-pulse rounded bg-white/10" />
          <div className="h-7 animate-pulse rounded bg-white/10" />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel p-6 text-center text-dim" data-testid="strategy-list-empty">
          暂无策略，点击右上角「新建策略」开始
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-line bg-panel" data-testid="strategy-table">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line text-dim">
                <th className="px-3 py-2 font-normal">名称</th>
                <th className="px-3 py-2 font-normal">类别</th>
                <th className="px-3 py-2 font-normal">最新版本</th>
                <th className="px-3 py-2 font-normal">权限</th>
                <th className="px-3 py-2 font-normal">版本数</th>
                <th className="px-3 py-2 font-normal">更新时间</th>
                <th className="px-3 py-2 font-normal">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((it) => {
                const v = it.latest_version;
                // 权限徽章口径（MINOR-1 裁决）：latest_published ?? latest_version
                const approval = it.latest_published?.approval_level ?? v?.approval_level;
                return (
                  <tr key={it.id} className="border-b border-line/50 last:border-0" data-testid={`strategy-row-${it.id}`}>
                    <td className="px-3 py-2">
                      <div className="text-txt">{it.name}</div>
                      {it.description && <div className="max-w-64 truncate text-[11px] text-dim">{it.description}</div>}
                    </td>
                    <td className="px-3 py-2 text-dim">{KIND_LABEL[it.kind]}</td>
                    <td className="px-3 py-2">
                      {v ? (
                        <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${statusBadgeClass(v.status)}`}>
                          {`v${v.version} ${STATUS_LABEL[v.status]}`}
                        </span>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {approval ? (
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${approvalBadgeClass(approval)}`}>
                          {APPROVAL_LABEL[approval]}
                        </span>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-dim">{it.version_count}</td>
                    <td className="px-3 py-2 text-dim">{formatDateTime(it.updated_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <Link
                          to={`/strategies/${encodeURIComponent(it.id)}/edit`}
                          className="text-acc1 hover:underline"
                          data-testid="edit-link"
                        >
                          编辑
                        </Link>
                        <button
                          type="button"
                          className="text-acc2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!v}
                          onClick={() => void handleNewVersion(it)}
                          data-testid="new-version-btn"
                        >
                          新建版本
                        </button>
                        <button
                          type="button"
                          className="text-up hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!v || v.status !== 'published'}
                          title={v && v.status !== 'published' ? '仅最新版本为已发布时可归档' : undefined}
                          onClick={() => void handleArchive(it)}
                          data-testid="archive-btn"
                        >
                          归档
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateStrategyModal
          api={api}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => navigate(`/strategies/${encodeURIComponent(id)}/edit`)}
        />
      )}
    </div>
  );
}
