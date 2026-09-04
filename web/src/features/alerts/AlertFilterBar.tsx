import type { AlertLevelName } from '@/api/types';
import type { AlertFilterState, AlertTimeRange } from './store';

/**
 * alert-filter H=48（07-alerts L2：级别 + 时间范围 + 来源；静态控件无三态；变更即重查）。
 */
export function AlertFilterBar({
  filter,
  sources,
  onChange,
}: {
  filter: AlertFilterState;
  sources: string[];
  onChange: (patch: Partial<AlertFilterState>) => void;
}) {
  const sel =
    'h-[30px] rounded-lg border border-line bg-panel2 px-2 text-xs text-dim outline-none';
  return (
    <>
      <select
        aria-label="级别"
        className={sel}
        value={filter.level ?? ''}
        onChange={(e) => onChange({ level: (e.target.value || null) as AlertLevelName | null })}
      >
        <option value="">级别：全部</option>
        <option value="critical">critical</option>
        <option value="warning">warning</option>
        <option value="info">info</option>
      </select>
      <select
        aria-label="时间范围"
        className={sel}
        value={filter.range}
        onChange={(e) => onChange({ range: e.target.value as AlertTimeRange })}
      >
        <option value="today">时间：今日</option>
        <option value="3d">时间：近三日</option>
        <option value="all">时间：全部</option>
      </select>
      <select
        aria-label="来源"
        className={sel}
        value={filter.source ?? ''}
        onChange={(e) => onChange({ source: e.target.value || null })}
      >
        <option value="">来源：全部</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <span className="flex-1" />
      <span className="rounded-full border border-line bg-white/5 px-3 py-1 text-xs text-dim">
        聚合防刷屏：同源+同规则+未恢复 → 一条
      </span>
    </>
  );
}
