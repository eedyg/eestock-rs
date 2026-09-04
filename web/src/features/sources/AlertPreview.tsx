import type { AlertItem } from '@/api/types';

const LEVEL_DOT: Record<AlertItem['level'], string> = {
  crit: 'text-up',
  warn: 'text-[#f5c451]',
  info: 'text-down',
};

/** HH:MM（Asia/Shanghai，与 alerts 页面事件口径一致；AlertPreview 原用 ts.slice 直取 UTC 段导致偏移 8h） */
function hhmm(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * 告警预览 H=160（02-sources §7）：最近 10 条告警事件流，只读
 * （完整规则配置在页面⑦，Wave 2）。渲染最近 N 条计数头部（样机「最近 10 条只读」口径）；
 * 时间按 CST 显示（与页面⑦一致，修复 UTC 偏移）。三态=骨架行/「暂无告警」/错误占位+重试。
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
      <div className="mb-1 text-[11px] text-txt" data-testid="alert-preview-count">
        最近 <span className="num">{alerts.length}</span> 条告警
      </div>
      {alerts.map((a, i) => (
        <div key={`${a.ts}:${i}`} className="border-b border-line py-1">
          <span className={LEVEL_DOT[a.level]}>●</span>{' '}
          <span className="num">{hhmm(a.ts)}</span> {a.text}
        </div>
      ))}
    </div>
  );
}
