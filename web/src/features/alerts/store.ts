import { ALERTS_DEFAULTS } from '@/layouts/AlertsGrid';
import type {
  AlertEventItem,
  AlertLevelName,
  AlertQuery,
  AlertRuleItem,
  AlertRulePatchBody,
} from '@/api/types';
import type { ApiClient } from '@/api/client';
import type { WsClient, WsMessage } from '@/ws/WsClient';

export interface AsyncSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type AlertTimeRange = 'today' | '3d' | 'all';

export interface AlertFilterState {
  level: AlertLevelName | null;
  range: AlertTimeRange;
  source: string | null;
}

export interface AlertsState {
  filter: AlertFilterState;
  list: AsyncSlice<AlertEventItem[]>;
  rules: AsyncSlice<AlertRuleItem[]>;
  acking: Record<number, boolean>;
}

type WsLike = Pick<WsClient, 'subscribe'>;

/** 时间范围 → from 参数（Asia/Shanghai 日界，与后端当日口径一致；与浏览器时区无关） */
export function rangeFromIso(range: AlertTimeRange, now: Date): string | undefined {
  if (range === 'all') return undefined;
  if (range === '3d') return new Date(now.getTime() - 3 * 86_400_000).toISOString();
  // today：CST 当日 00:00（= UTC 前一日 16:00）
  const cst = new Date(now.getTime() + 8 * 3_600_000);
  const startUtc =
    Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate()) - 8 * 3_600_000;
  return new Date(startUtc).toISOString();
}

/** WS 推送帧 → AlertEventItem（id 为 number 才收纳，坏帧忽略） */
export function parseWsAlert(m: WsMessage): AlertEventItem | null {
  if (m.type !== 'alert' || typeof m.id !== 'number') return null;
  return m as unknown as AlertEventItem;
}

/**
 * 页面⑦告警中心状态机（07-alerts L2）：
 * 列表 GET /api/alerts（过滤变更即重查）+ WS {type:"alert"} 实时并入（新事件入顶/同 id 替换）；
 * 确认 POST /api/alerts/{id}/ack（就地翻转已确认）；规则 GET/PATCH /api/alert-rules（热生效）。
 */
export class AlertsStore {
  private current: AlertsState = {
    filter: { level: null, range: ALERTS_DEFAULTS.defaultRange, source: null },
    list: { data: null, loading: true, error: null },
    rules: { data: null, loading: true, error: null },
    acking: {},
  };
  private listeners = new Set<() => void>();
  private offWs: (() => void) | null = null;
  private now: () => Date;

  constructor(private deps: { api: ApiClient; ws?: WsLike; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
  }

  get state(): AlertsState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): AlertsState => this.current;

  private patch(p: Partial<AlertsState>) {
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    this.offWs = this.deps.ws?.subscribe('alert', (m) => this.handleWsAlert(m)) ?? null;
    await Promise.all([this.loadList(), this.loadRules()]);
  }

  dispose(): void {
    this.offWs?.();
    this.offWs = null;
  }

  /** 当前过滤 → GET /api/alerts 查询参数 */
  query(): AlertQuery {
    const f = this.current.filter;
    return {
      level: f.level ?? undefined,
      from: rangeFromIso(f.range, this.now()),
      source: f.source ?? undefined,
    };
  }

  async loadList(): Promise<void> {
    this.patch({ list: { ...this.current.list, loading: true, error: null } });
    try {
      const data = await this.deps.api.getAlertEvents(this.query());
      this.patch({ list: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ list: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async loadRules(): Promise<void> {
    this.patch({ rules: { ...this.current.rules, loading: true, error: null } });
    try {
      const data = await this.deps.api.getAlertRules();
      this.patch({ rules: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ rules: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 过滤变更即重查（07-alerts L2 alert-filter 交互） */
  async setFilter(patch: Partial<AlertFilterState>): Promise<void> {
    this.patch({ filter: { ...this.current.filter, ...patch } });
    await this.loadList();
  }

  /** 「确认」= 标记已读（就地更新，持久化由后端 acked_at 承载） */
  async ack(id: number): Promise<void> {
    if (this.current.acking[id]) return;
    this.patch({ acking: { ...this.current.acking, [id]: true } });
    try {
      const updated = await this.deps.api.ackAlert(id);
      const list = this.current.list.data;
      if (list) {
        this.patch({ list: { ...this.current.list, data: list.map((a) => (a.id === id ? updated : a)) } });
      }
    } finally {
      this.patch({ acking: { ...this.current.acking, [id]: false } });
    }
  }

  /** 规则调整（阈值/开关/静默时长；就地更新，后端下一评估节拍热生效） */
  async updateRule(id: string, patch: AlertRulePatchBody): Promise<void> {
    const updated = await this.deps.api.patchAlertRule(id, patch);
    const rules = this.current.rules.data;
    if (rules) {
      this.patch({ rules: { ...this.current.rules, data: rules.map((r) => (r.id === id ? updated : r)) } });
    }
  }

  /** 新事件是否落入当前过滤（仅决定"是否入列"；已存在条目总是替换以反映状态翻转） */
  private matchesFilter(e: AlertEventItem): boolean {
    const f = this.current.filter;
    if (f.level !== null && e.level !== f.level) return false;
    if (f.source !== null && e.source !== f.source) return false;
    const from = rangeFromIso(f.range, this.now());
    if (from && e.last_fired_at < from) return false;
    return true;
  }

  /** WS 实时并入：同 id 替换（续触发计数/确认/恢复翻转）；新事件过过滤后入顶 */
  private handleWsAlert(m: WsMessage): void {
    const ev = parseWsAlert(m);
    if (!ev) return;
    const list = this.current.list.data;
    if (!list) return;
    const idx = list.findIndex((a) => a.id === ev.id);
    if (idx >= 0) {
      const next = [...list];
      next[idx] = ev;
      next.sort((a, b) => b.last_fired_at.localeCompare(a.last_fired_at));
      this.patch({ list: { ...this.current.list, data: next } });
    } else if (this.matchesFilter(ev)) {
      this.patch({ list: { ...this.current.list, data: [ev, ...list] } });
    }
  }
}
