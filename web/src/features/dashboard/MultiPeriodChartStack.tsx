import type { ReactNode } from 'react';
import type { ApiClient } from '@/api/client';
import type { Period } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import type { IndicatorName } from './Toolbar';
import { DEFAULT_DCAP_PARAMS, type DcapParams } from '@/features/indicators/dcapIndicator';
import { MultiPeriodSatellite } from './MultiPeriodSatellite';

/** 卫星实例定义（`periods[1..]`，按配置顺序）。 */
export interface MultiPeriodSatelliteSpec {
  period: Period;
  /** 实例高度 px（本轮取 `heights[period]`；拖拽持久化属 P5）。 */
  height: number;
}

export interface MultiPeriodChartStackProps {
  /** 多周期开关（默认 false ⇒ 与现状逐字节等价）。 */
  enabled?: boolean;
  /** 卫星实例（配置 `periods[1..]`）；空数组/未启用 ⇒ 逐字节透传 children（零包裹层）。 */
  satellites?: MultiPeriodSatelliteSpec[];
  api?: ApiClient;
  ws?: WsClient;
  /** 当前选中标的（空 ⇒ 只画 children，不建卫星）。 */
  code?: string | null;
  /** 基准图指标勾选集合（卫星**继承**该集合；02-spec §4.1）。 */
  indicators?: Record<IndicatorName, boolean>;
  maWindows?: number[];
  dcapParams?: DcapParams;
  /** K 线默认视口根数（GET /api/config/kline）。 */
  viewportBars?: number;
  /** 实时跟随（P2：各实例各自右端跟随；跨图跨度对齐属 P3）。 */
  followLatest?: boolean;
  /** 基准（K 线）周期与来源：`config` ⇒ 被配置 `periods[0]` 覆盖（显式可观测，禁止静默不一致）。 */
  basePeriod?: Period;
  basePeriodSource?: 'config' | 'toolbar';
  children: ReactNode;
}

/** 卫星高度兜底（配置 `heights[period]` 缺失时；正常由 P1 的 dto 校验保证键与周期一一对应）。 */
export const DEFAULT_SATELLITE_HEIGHT = 180;
/** 指标勾选兜底（与 `DASHBOARD_DEFAULTS.indicators` 同构）。 */
const DEFAULT_INDICATORS: Record<IndicatorName, boolean> = {
  ma: true,
  macd: false,
  kdj: false,
  boll: false,
  dcap: false,
};
const DEFAULT_MA_WINDOWS: number[] = [5, 10, 20];
const DEFAULT_VIEWPORT_BARS = 120;

/**
 * 多周期图表容器（`design/15-multi-period/02-spec.md` §1；P2 挂载卫星实例）。
 *
 * 硬约束：
 * - `enabled=false`（或没有卫星/无选中标的）⇒ **逐字节透传 children（零包裹层）**：DOM 结构/请求/订阅与
 *   现状完全一致（T11 关闭态等价）。**且「enabled=true 但无卫星」（单周期配置）同样不产生任何可见后果**
 *   ——不得新增实例/订阅/取数（用户裁决 A + D4 已锁死的契约）。
 * - children（基准 K 线实例）必须是返回片段的**第一个子节点**：卫星追加在其后（`<>{children}{satellites}</>`）。
 *   绝不在基准之前插入节点——片段是位置化协调，前置节点会让基准 chart 被 remount（dispose+init），
 *   破坏「配置保存/开关切换不得重建实例」契约。
 * - 卫星各自独立实例 + 独立 `KlineDataFeed`（period = 该卫星周期，禁止本地聚合）；隐藏 K 线用
 *   `state:'minimize'` + `separator:0`（02-spec §3.4）；失败可见（§9）。
 */
export function MultiPeriodChartStack({
  enabled = false,
  satellites = [],
  api,
  ws,
  code,
  indicators = DEFAULT_INDICATORS,
  maWindows = DEFAULT_MA_WINDOWS,
  dcapParams = DEFAULT_DCAP_PARAMS,
  viewportBars = DEFAULT_VIEWPORT_BARS,
  followLatest = true,
  basePeriod,
  basePeriodSource = 'toolbar',
  children,
}: MultiPeriodChartStackProps) {
  const active = enabled && satellites.length > 0 && !!api && !!ws && !!code;
  if (!active) return <>{children}</>;
  return (
    <>
      {children}
      {satellites.map((s) => (
        <MultiPeriodSatellite
          key={s.period}
          api={api}
          ws={ws}
          code={code}
          period={s.period}
          height={Number.isFinite(s.height) && s.height > 0 ? s.height : DEFAULT_SATELLITE_HEIGHT}
          indicators={indicators}
          maWindows={maWindows}
          dcapParams={dcapParams}
          viewportBars={viewportBars}
          followLatest={followLatest}
          basePeriod={basePeriod ?? (s.period as Period)}
          basePeriodSource={basePeriodSource}
        />
      ))}
    </>
  );
}
