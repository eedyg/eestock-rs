import { useCallback, useState } from 'react';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import type { IndicatorName } from '@/features/dashboard/IndicatorToggles';

/**
 * 结果页图表卡配置（ADR-028 §2.4c 第 5/6 项）：
 *  - **指标选择**（与看板同构的多选：ma/vol/macd/kdj/boll/dcap，默认 = `DASHBOARD_DEFAULTS.indicators`）；
 *  - **卡片高度**（5 张可缩放图表卡：kline/aggregate/slot/equity/position，`null` = 默认渲染）；
 *  - **买卖标记标签**（ADR-028 §2.11 D11：默认**关** = 只显圆点；开关写入**同一独立 key**）。
 *
 * **配置隔离（硬约束）**：结果页只读写**本 key**，**不得**触碰看板的指标/布局配置；看板也不得覆盖结果页
 * （看板侧指标勾选是页面会话态、不落任何存储；两侧唯一共享的是「默认值」与「共享勾选组件」）。
 *
 * **持久化通道（本波实测后的选择，已披露）**：服务端 `app_config` 只有**专用键**端点
 * （`crates/web/src/lib.rs:67-77`：`/api/config/{sources,collector,mcp,ma,kline,dcap,multi_period}`），
 * **不存在通用 KV 通道**，且本波**禁止改 Rust** ⇒ 用 `localStorage`。
 * ⚠ **`localStorage` 仅对本机浏览器有效**：换浏览器 / 换设备 / 清缓存即回默认（服务端不存在该配置）。
 */
export const RESULT_CHART_CONFIG_KEY = 'eestock.wb.result.chartConfig.v1';

/** 可缩放卡片（键 = 卡片 testid 后缀；`kline` = K 线卡，其余四张 = 曲线卡）。 */
export type ResultCardId = 'kline' | 'aggregate' | 'slot' | 'equity' | 'position';

export const RESULT_CARD_IDS: readonly ResultCardId[] = ['kline', 'aggregate', 'slot', 'equity', 'position'];

/** 卡片高度上下限（px）。下限 120 > K 线卡功能下限（candle 30 + 分隔条 1 + VOL 30 + x 轴 26 ≈ 87）。 */
export const RESULT_CARD_MIN_PX = 120;
export const RESULT_CARD_MAX_PX = 1200;

export interface ResultChartConfig {
  indicators: Record<IndicatorName, boolean>;
  cardHeights: Record<ResultCardId, number | null>;
  /**
   * ADR-028 §2.11（D11 决策 4）：**买卖标记标签开关**（默认 `false` = 只显圆点）。
   * 与指标/卡高同属**结果页独立 key**（`eestock.wb.result.chartConfig.v1`）⇒ 刷新后保持；
   * **不得**写入看板配置（看板无标记标签概念）。
   */
  markerLabels: boolean;
}

/** 已知指标键（名单唯一来源 = `DASHBOARD_DEFAULTS.indicators`）。 */
const KNOWN_INDICATORS = Object.keys(DASHBOARD_DEFAULTS.indicators) as IndicatorName[];

export function defaultResultChartConfig(): ResultChartConfig {
  const cardHeights = {} as Record<ResultCardId, number | null>;
  for (const id of RESULT_CARD_IDS) cardHeights[id] = null;
  // D11：默认**关**（用户 2026-09-25 默认口径：默认降噪；标签靠悬停/开关/跳转高亮获取）
  return { indicators: { ...DASHBOARD_DEFAULTS.indicators }, cardHeights, markerLabels: false };
}

/** 高度净化：非整数/非有限 ⇒ `null`（**禁止**把坏值当 0 高）；越界 ⇒ 夹紧。 */
export function clampCardHeight(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return Math.min(RESULT_CARD_MAX_PX, Math.max(RESULT_CARD_MIN_PX, n));
}

/** 解析持久化串：坏 JSON / 坏形状一律回默认（**禁静默部分采纳**成半坏状态）。 */
export function parseResultChartConfig(raw: string | null): ResultChartConfig {
  const def = defaultResultChartConfig();
  if (!raw) return def;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return def;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return def;
  const o = obj as { indicators?: unknown; cardHeights?: unknown; markerLabels?: unknown };
  const indicators = { ...def.indicators };
  if (o.indicators != null && typeof o.indicators === 'object' && !Array.isArray(o.indicators)) {
    const src = o.indicators as Record<string, unknown>;
    for (const k of KNOWN_INDICATORS) {
      if (typeof src[k] === 'boolean') indicators[k] = src[k] as boolean;
    }
  }
  const cardHeights = { ...def.cardHeights };
  if (o.cardHeights != null && typeof o.cardHeights === 'object' && !Array.isArray(o.cardHeights)) {
    const src = o.cardHeights as Record<string, unknown>;
    for (const id of RESULT_CARD_IDS) {
      if (id in src) cardHeights[id] = clampCardHeight(src[id]);
    }
  }
  return { indicators, cardHeights, markerLabels: typeof o.markerLabels === 'boolean' ? o.markerLabels : def.markerLabels };
}

/** 安全取用 localStorage（隐私模式/SSR/抛异常 ⇒ null，调用方回默认）。 */
function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadResultChartConfig(storage: Storage | null = safeStorage()): ResultChartConfig {
  if (!storage) return defaultResultChartConfig();
  try {
    return parseResultChartConfig(storage.getItem(RESULT_CHART_CONFIG_KEY));
  } catch {
    return defaultResultChartConfig();
  }
}

export function saveResultChartConfig(cfg: ResultChartConfig, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(RESULT_CHART_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // 写失败（配额/隐私模式）不得打断交互：UI 仍以内存态工作，刷新后回默认
  }
}

/** 结果页图表卡配置 hook（**唯一写入者**；每次变更立即落 key ⇒ 刷新保持）。 */
export function useResultChartConfig(): {
  config: ResultChartConfig;
  indicators: Record<IndicatorName, boolean>;
  toggleIndicator(name: IndicatorName): void;
  markerLabels: boolean;
  toggleMarkerLabels(): void;
  cardHeight(id: ResultCardId): number | null;
  setCardHeight(id: ResultCardId, px: number | null): void;
} {
  const [config, setConfig] = useState<ResultChartConfig>(() => loadResultChartConfig());

  const commit = useCallback((next: ResultChartConfig) => {
    setConfig(next);
    saveResultChartConfig(next);
  }, []);

  const toggleIndicator = useCallback(
    (name: IndicatorName) => {
      setConfig((prev) => {
        const next: ResultChartConfig = {
          indicators: { ...prev.indicators, [name]: !prev.indicators[name] },
          cardHeights: prev.cardHeights,
          markerLabels: prev.markerLabels,
        };
        saveResultChartConfig(next);
        return next;
      });
    },
    [],
  );

  /** D11：标签开关（**唯一写入者**；立即落 key ⇒ 刷新保持）。 */
  const toggleMarkerLabels = useCallback(() => {
    setConfig((prev) => {
      const next: ResultChartConfig = { ...prev, markerLabels: !prev.markerLabels };
      saveResultChartConfig(next);
      return next;
    });
  }, []);

  const setCardHeight = useCallback(
    (id: ResultCardId, px: number | null) => {
      commit({
        indicators: config.indicators,
        cardHeights: { ...config.cardHeights, [id]: clampCardHeight(px) },
        markerLabels: config.markerLabels,
      });
    },
    [commit, config],
  );

  const cardHeight = useCallback((id: ResultCardId) => config.cardHeights[id] ?? null, [config]);

  return {
    config,
    indicators: config.indicators,
    toggleIndicator,
    markerLabels: config.markerLabels,
    toggleMarkerLabels,
    cardHeight,
    setCardHeight,
  };
}
