import type { AlertItem } from '@/api/types';

const LEVEL_DOT: Record<AlertItem['level'], string> = {
  crit: 'text-up',
  warn: 'text-[#f5c451]',
  info: 'text-down',
};

/**
 * 告警预览 H=160（02-sources §7）：最近 10 条告警事件流，只读
 * （完整规则配置在页面⑦，Wave 2）。
 */
export function AlertPreview({
  alerts,
  loading,
  error,
}: {
  alerts: AlertItem[] | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <div className="m-3 h-24 animate-pulse rounded bg-panel2" />;
  }
  if (error) {
    return <div className="p-3 text-xs text-up">告警加载失败：{error}</div>;
  }
  if (!alerts || alerts.length === 0) {
    return <div className="p-3 text-xs text-dim">暂无告警</div>;
  }
  return (
    <div className="overflow-y-auto p-3 text-xs text-dim">
      {alerts.map((a, i) => (
        <div key={`${a.ts}:${i}`} className="border-b border-line py-1">
          <span className={LEVEL_DOT[a.level]}>●</span>{' '}
          <span className="num">{a.ts.slice(11, 16)}</span> {a.text}
        </div>
      ))}
    </div>
  );
}
