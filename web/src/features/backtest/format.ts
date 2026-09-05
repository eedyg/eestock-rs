// 页面⑤ 回测工作台展示格式化（深色交易终端风；指标↔字符串，统一口径）。
import type { Period } from '@/api/types';

/** 后端口径周期代码 → 前端标签（M1/M5/M15/D1 → 1m/5m/15m/日）。 */
export function periodLabel(code: string | undefined): string {
  const map: Record<string, string> = { M1: '1m', M5: '5m', M15: '15m', D1: '日' };
  return map[code ?? ''] ?? (code || '—');
}

/** 后端口径周期代码 → 前端 Period（M1/M5/M15/D1 → 1m/5m/15m/1d；未识别兜底 1d）。
 *  供弹窗 K 线默认周期与看板 KlineChart 周期切换复用。 */
export function periodCodeToPeriod(code: string | undefined | null): Period {
  const map: Record<string, Period> = { M1: '1m', M5: '5m', M15: '15m', D1: '1d' };
  return map[code ?? ''] ?? '1d';
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

/** 后端口径周期代码 → 一天的换算系数（bar 数 × factor = 天；M1=1/1440…）。 */
const PERIOD_DAY_FACTOR: Record<string, number> = {
  M1: 1 / (24 * 60),
  M5: 5 / (24 * 60),
  M15: 15 / (24 * 60),
  D1: 1,
};

/** 数字取整到 1 位小数，整数去掉尾部 .0（如 17.0 → "17"，3.2 → "3.2"）。 */
function round1(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * 平均持仓时长（bar 数）→ 取整展示（修复#2：不再显示引擎原始小数，如 16.99…）。
 * 传入 period（M1/M5/M15/D1）时按 ADR 口径换算为天/时/分；缺省则保留 bar 数（同样取整到 1 位）。
 */
export function formatAvgHold(bars: number | null | undefined, period?: string): string {
  if (bars == null || Number.isNaN(bars)) return '—';
  if (bars <= 0) return '0';

  if (period) {
    const factor = PERIOD_DAY_FACTOR[period];
    if (factor != null) {
      const days = bars * factor;
      if (days >= 1) return `${round1(days)}天`;
      const hours = days * 24;
      if (hours >= 1) return `${round1(hours)}时`;
      return `${round1(days * 24 * 60)}分`;
    }
  }

  // 无 period / 未识别周期：保留 bar 数（取整到 1 位）。
  return `${round1(bars)}bar`;
}

/** Unix 秒 → x 轴时间标签（默认月度 "YYYY-MM"；includeDay 时 "YYYY-MM-DD"；无效/非正 → '—'）。
 *  x 轴用 UTC 日期口径（与 fmtTs 的 +8 展示不同），避免时区漂移导致的日期偏格。 */
export function fmtAxis(ts: number | undefined | null, includeDay = false): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return includeDay ? ymd : ymd.slice(0, 7);
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
