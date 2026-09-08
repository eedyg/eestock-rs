/**
 * 页面⑨ 模拟实盘展示格式化（纯函数；时区口径统一 Asia/Shanghai (CST, UTC+8)）。
 * 背景：委托/成交 `ts` 为 Unix 秒（UTC 时刻）。旧代码用 `new Date(ts).toLocaleTimeString('zh-CN')`
 * 会取浏览器时区；若机器非 CST，会显示 UTC 时间（看似时段外）。此处固定 +8，与后端 CST 口径一致。
 */

/**
 * Unix 秒（UTC）→ CST "MM-DD HH:mm:ss"（含日期+时分秒，紧凑）。
 * 固定 +8：对 UTC 时刻 +8h 后读其 UTC 字段即得 Asia/Shanghai 墙钟，与运行环境时区无关
 * （中国无夏令时，CST 恒为 UTC+8）。无效/非正输入返回 '—'。
 */
export function formatCstDateTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts * 1000 + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
