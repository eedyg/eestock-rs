/**
 * 页面④ 展示格式化（纯函数；时刻口径 Asia/Shanghai，与后端 CST 标签一致）
 */

/** ISO UTC → CST "MM-DD HH:MM"（分歧表时刻列） */
export function cstMdHm(iso: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 0-1 比率 → 百分比文本（一位小数；null → —） */
export function ratePct(rate: number | null): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

/** 偏差（已是 % 单位）→ 带号两位小数文本（+1.52% / −0.70%；null → —） */
export function devPct(dev: number | null): string {
  if (dev == null) return '—';
  const sign = dev > 0 ? '+' : dev < 0 ? '−' : '';
  return `${sign}${Math.abs(dev).toFixed(2)}%`;
}

/** 价格三位小数（与 mock/样机一致） */
export function price3(n: number): string {
  return n.toFixed(3);
}
