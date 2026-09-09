import { useEffect, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { StrategyCatalogEntry, StrategyCreateReq } from '@/api/types';

/** 空白策略起点代码（ABI 最小骨架；02-plugin-abi §1 口径） */
const BLANK_CODE = `const PARAMS_SCHEMA = [
  { key: "period", type: "int", default: 20, min: 2, max: 250, description: "周期" }
];

function init(params) {}

function on_bar(ctx) {
  // 返回 0-100 连续分
  return 50;
}
`;

/**
 * 新建策略弹窗（列表页）：名称/描述 + 来源（空白 / 从模板创建——catalog kind=template 下拉，
 * 创建时 code 预填模板代码）→ POST /api/strategies（201 v1 draft）→ onCreated（跳转编辑器）。
 */
export function CreateStrategyModal({
  api,
  onClose,
  onCreated,
}: {
  api: ApiClient;
  onClose: () => void;
  onCreated: (strategyId: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<'blank' | 'template'>('blank');
  const [templates, setTemplates] = useState<StrategyCatalogEntry[] | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 模板下拉数据源：catalog kind=template（仅 published 模板入册）
  useEffect(() => {
    let canc = false;
    api
      .getStrategyCatalog({ kind: 'template' })
      .then((list) => {
        if (canc) return;
        setTemplates(list);
        if (list.length > 0) setTemplateId((cur) => cur || list[0]!.strategy.id);
      })
      .catch(() => {
        if (!canc) setTemplates([]);
      });
    return () => {
      canc = true;
    };
  }, [api]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('名称必填');
      return;
    }
    let code = BLANK_CODE;
    if (source === 'template') {
      const tpl = templates?.find((t) => t.strategy.id === templateId);
      if (!tpl) {
        setError('请选择模板');
        return;
      }
      code = tpl.version.code;
    }
    setError(null);
    setSubmitting(true);
    try {
      const req: StrategyCreateReq = { name: name.trim(), description, kind: 'strategy', code };
      const resp = await api.createStrategy(req);
      onCreated(resp.strategy.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="create-strategy-modal"
      role="dialog"
      aria-label="新建策略"
    >
      <div className="w-[420px] rounded-xl border border-line bg-panel p-4 text-xs shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-txt">新建策略</h2>
          <button type="button" aria-label="关闭" className="text-dim hover:text-txt" onClick={onClose}>
            ×
          </button>
        </div>

        <label className="mb-1 block text-dim">名称</label>
        <input
          className="mb-2 h-8 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="create-name"
        />

        <label className="mb-1 block text-dim">描述</label>
        <input
          className="mb-3 h-8 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="create-description"
        />

        <div className="mb-2 flex gap-4" data-testid="create-source">
          <label className="flex items-center gap-1 text-txt">
            <input
              type="radio"
              checked={source === 'blank'}
              onChange={() => setSource('blank')}
              data-testid="create-source-blank"
            />
            空白策略
          </label>
          <label className="flex items-center gap-1 text-txt">
            <input
              type="radio"
              checked={source === 'template'}
              onChange={() => setSource('template')}
              data-testid="create-source-template"
            />
            从模板创建
          </label>
        </div>

        {source === 'template' && (
          <>
            <label className="mb-1 block text-dim">模板（创建后进入编辑器并预填模板代码）</label>
            <select
              className="mb-2 h-8 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              data-testid="create-template-select"
            >
              {(templates ?? []).map((t) => (
                <option key={t.strategy.id} value={t.strategy.id}>
                  {t.strategy.name}
                </option>
              ))}
            </select>
            {templates !== null && templates.length === 0 && (
              <div className="mb-2 text-dim">暂无可用模板</div>
            )}
          </>
        )}

        {error && (
          <div className="mb-2 rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="create-error">
            {error}
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 text-dim hover:text-txt"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            className="rounded-lg bg-gradient-to-r from-acc1 to-acc2 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            onClick={() => void handleSubmit()}
            data-testid="create-submit"
          >
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
