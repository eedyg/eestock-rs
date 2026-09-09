import type { StrategyParamDef } from '@/api/types';

/**
 * 参数 schema 面板（只读）：展示当前版本的 PARAMS_SCHEMA——key/类型/默认值/范围/描述表格。
 * 数据源：版本行 params_schema（后端在保存/发布时由 QuickJS 实例化提取）。
 */
export function ParamsSchemaPanel({ schema }: { schema: StrategyParamDef[] }) {
  if (schema.length === 0) {
    return (
      <div className="p-3 text-xs text-dim" data-testid="params-schema-panel">
        该版本未声明 PARAMS_SCHEMA
      </div>
    );
  }
  return (
    <div className="overflow-auto p-3 text-xs" data-testid="params-schema-panel">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-line text-dim">
            <th className="px-2 py-1 font-normal">参数</th>
            <th className="px-2 py-1 font-normal">类型</th>
            <th className="px-2 py-1 font-normal">默认值</th>
            <th className="px-2 py-1 font-normal">范围</th>
            <th className="px-2 py-1 font-normal">描述</th>
          </tr>
        </thead>
        <tbody>
          {schema.map((p) => (
            <tr key={p.key} className="border-b border-line/50 last:border-0">
              <td className="px-2 py-1 font-mono text-acc2">{p.key}</td>
              <td className="px-2 py-1 text-dim">{p.type}</td>
              <td className="px-2 py-1 text-txt">{p.default}</td>
              <td className="px-2 py-1 text-dim">
                {p.min !== undefined || p.max !== undefined ? `[${p.min ?? '-∞'}, ${p.max ?? '+∞'}]` : '—'}
              </td>
              <td className="px-2 py-1 text-dim">{p.description ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
