// 交易时段（02-sources §L2 写死口径：09:30-11:30 / 13:00-15:00，客户端计算；
// Wave 1 简化：仅工作日判断，节假日噪音接受）
export type TradingSession = 'preopen' | 'trading' | 'lunch' | 'closed';

const SH_OFFSET_MS = 8 * 3600_000;

function shanghaiParts(now: Date): { day: number; minutes: number } {
  const t = new Date(now.getTime() + SH_OFFSET_MS);
  return { day: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function tradingSession(now: Date): TradingSession {
  const { day, minutes } = shanghaiParts(now);
  if (day === 0 || day === 6) return 'closed';
  if (minutes < 9 * 60 + 30) return 'preopen';
  if (minutes < 11 * 60 + 30) return 'trading';
  if (minutes < 13 * 60) return 'lunch';
  if (minutes < 15 * 60) return 'trading';
  return 'closed';
}

export function sessionLabel(s: TradingSession): string {
  switch (s) {
    case 'preopen':
      return '盘前';
    case 'trading':
      return '交易中';
    case 'lunch':
      return '午间休市';
    case 'closed':
      return '已收盘';
  }
}

/** 北京时间 HH:mm（顶部状态条显示） */
export function shanghaiTimeHHMM(now: Date): string {
  const t = new Date(now.getTime() + SH_OFFSET_MS);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** 北京时间日界 key（分时图「当日」过滤用） */
export function shanghaiDayKey(d: Date): string {
  const t = new Date(d.getTime() + SH_OFFSET_MS);
  return `${t.getUTCFullYear()}-${t.getUTCMonth()}-${t.getUTCDate()}`;
}
