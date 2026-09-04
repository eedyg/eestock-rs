import type { AlertLevelName } from '@/api/types';

/** 级别圆点色（07-alerts 样机基线：critical 红 / warning 琥珀 / info 蓝） */
export const LEVEL_DOT: Record<AlertLevelName, string> = {
  critical: 'text-up',
  warning: 'text-[#fbbf24]',
  info: 'text-acc1',
};
