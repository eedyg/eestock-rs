import type { SourceHealthItem, SourcesHealth } from '@/api/types';

/**
 * 内置源元数据（源编译期注册于数据面，03-collector；后端 /api/sources/health 按契约
 * 不携带中文名/角色——07-app-plane §1.1「应用面不知编译期源清单」——故前端静态映射）。
 * 未知源（新接入未更新前端）兜底：label=id、role='snapshot'（不计入 1m 统计，安全侧）。
 */
export type SourceRole = '1m' | 'snapshot';

export interface SourceMeta {
  label: string;
  role: SourceRole;
}

export const SOURCE_META: Record<string, SourceMeta> = {
  tencent_ifzq: { label: '腾讯ifzq', role: '1m' },
  sina_jsonp: { label: '新浪jsonp', role: '1m' },
  tencent_qt: { label: '腾讯qt', role: 'snapshot' },
  sina_hq: { label: '新浪hq', role: 'snapshot' },
  ths_cs: { label: '同花顺', role: 'snapshot' },
  push2delay: { label: 'push2delay（东财系）', role: 'snapshot' },
  exchange: { label: '交易所', role: 'snapshot' },
  tushare: { label: 'tushare（历史层）', role: 'snapshot' },
};

export function metaOf(sourceId: string): SourceMeta {
  return SOURCE_META[sourceId] ?? { label: sourceId, role: 'snapshot' };
}

export function roleOf(sourceId: string): SourceRole {
  return metaOf(sourceId).role;
}

/** 1m 角色源子集（汇总条「1m源 x/y」与系统灯的统计口径） */
export function minuteSources(sources: SourceHealthItem[]): SourceHealthItem[] {
  return sources.filter((s) => roleOf(s.source) === '1m');
}

/** 系统状态灯（02-sources §2）：任一 1m 源熔断 → warn；全部 1m 熔断 → crit；否则 ok */
export function systemLight(sources: SourceHealthItem[]): 'ok' | 'warn' | 'crit' {
  const m1 = minuteSources(sources);
  if (m1.length === 0) return 'ok';
  const open = m1.filter((s) => s.circuit_state === 'open').length;
  if (open === m1.length) return 'crit';
  if (open > 0) return 'warn';
  return 'ok';
}

/** 状态标签（角色标签随熔断态切换：熔断中 > 角色） */
export function roleLabelOf(item: SourceHealthItem): string {
  if (item.circuit_state === 'open') return '熔断中';
  return roleOf(item.source) === '1m' ? '1m全速' : '快照心跳';
}

/**
 * 采集服务运行判定（客户端推导）：后端无 collectorRunning 字段（07 §1.1），
 * 以「任一源在 recencyMs 内有健康事件」近似采集在线（事件由采集循环产生）。
 */
export function collectorRunningOf(
  health: SourcesHealth | null,
  nowMs: number,
  recencyMs = 10 * 60_000,
): boolean | null {
  if (!health) return null;
  return health.sources.some(
    (s) => s.last_event_ts && nowMs - Date.parse(s.last_event_ts) < recencyMs,
  );
}
