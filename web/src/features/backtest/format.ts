// 页面⑤ 回测工作台展示格式化（深色交易终端风；指标↔字符串，统一口径）。

/** 后端口径周期代码 → 前端标签（M1/M5/M15/D1 → 1m/5m/15m/日）。 */
export function periodLabel(code: string | undefined): string {
  const map: Record<string, string> = { M1: '1m', M5: '5m', M15: '15m', D1: '日' };
  return map[code ?? ''] ?? (code || '—');
}

/** 状态 → 中文标签（task-list/grid-rank 展示）。 */
export function statusLabel(s: string | undefined): string {
  const map: Record<string, string> = {
    pending: '排队',
    running: '运行中',
    done: '完成',
    failed: '失败',
  };
  return map[s ?? ''] ?? (s ?? '—');
}

/** 持仓时长（bar 数）→ 粗略天数（按日线口径近似；精确换算由引擎 hold_bars × 周期决定）。 */
export function fmtHoldBars(bars: number | undefined): string {
  if (bars == null) return '—';
  if (bars <= 0) return '0';
  return `${bars}bar`;
}

/** Unix 秒 → CST "MM-DD HH:mm" 展示（固定 +8，与浏览器时区无关）。 */
export function fmtTs(ts: number | undefined | null): string {
  if (ts == null || Number.isNaN(ts)) return '—';
  const d = new Date(ts * 1000 + 8 * 3_600_000);
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** ISO datetime 字符串 → CST "MM-DD HH:mm"（run.created_at/current_ts 等）。 */
export function fmtIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';
  const d = new Date(ts + 8 * 3_600_000);
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 百分比（入参为比例，0-1；maxDrawdown/winRate/annualizedReturn 等）。 */
export function fmtPct(x: number | undefined | null, digits = 1): string {
  if (x == null || Number.isNaN(x) || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

/** 金额（元）。 */
export function fmtMoney(x: number | undefined | null): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `¥${x.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}

/** 比率（盈亏比/夏普）。 */
export function fmtRatio(x: number | undefined | null, digits = 2): string {
  if (x == null || Number.isNaN(x) || !Number.isFinite(x)) return x === Infinity ? '∞' : '—';
  return x.toFixed(digits);
}

/** 交易盈亏（带符号着色由调用方决定；此处提供 +/- 格式）。 */
export function fmtPnl(x: number | undefined | null): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `${x >= 0 ? '+' : ''}${x.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}

/** 红涨绿跌的涨跌 class（A 股惯例：涨=up 红、跌=down 绿）。 */
export function deltaClass(x: number | undefined | null): string {
  if (x == null || Number.isNaN(x) || x === 0) return 'text-dim';
  return x > 0 ? 'text-up' : 'text-down';
}
