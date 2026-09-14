/**
 * 多周期跨图同步的 **React 接线面**（`design/15-multi-period/02-spec.md` §1/§3）。
 *
 * 分工：
 *  - `ChartSyncGroup`（`./chartSyncGroup.ts`）是纯同步原语（无 UI、无 React）；
 *  - 本模块只负责「谁注册进组」「组何时重建」「程序化写入标记」，以及把 `stats` 抛给页面/store。
 *
 * 零残留契约（02-spec §7.5 / T11）：provider **只在多周期栈真正启用（有卫星）时挂载**；
 * 关闭 ⇒ 不挂 provider ⇒ `useChartSyncRegistry()` 返回 **no-op 注册表** ⇒ 不建组、不订阅、无残留。
 * provider 本身**不渲染任何 DOM**（`Context.Provider` ⇒ 关闭态 DOM 逐字节等价，T11）。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { Chart } from 'klinecharts';
import {
  ChartSyncGroup,
  SATELLITE_MAX_BAR_SPACE,
  type SyncChartApi,
  type SyncMember,
  type SyncStats,
} from './chartSyncGroup';

/** 无同步组时的统计（关闭态/组销毁 ⇒ 页面角标必须归零，不得残留上一次读数）。 */
export const EMPTY_SYNC_STATS: SyncStats = {
  applied: 0,
  suppressed: 0,
  echoEvents: 0,
  lastSpanDiffMinutes: null,
  degraded: false,
  degradedPeriod: null,
  unalignedFollowers: 0,
  lastUnalignedReason: null,
  lastCorrectionIterations: 0,
  spanResidualBars: null,
  edgeResidualBars: null,
  barSpaceAdjust: 0,
};

/** 图表实例向同步组的注册载荷（`KlineChart` 在 init 后/周期变化时调用）。 */
export interface ChartSyncRegistration {
  chart: Chart;
  period: string;
  isBase: boolean;
}

/**
 * 注册表（provider 提供）。**无 provider 时全部为 no-op**（单图/宫格/工作台/关闭态零影响）。
 */
export interface ChartSyncRegistry {
  /** 注册一个图表实例；返回注销函数（组件卸载/周期变化时调用）。 */
  register(member: ChartSyncRegistration): () => void;
  /** 程序化写入开始（实时跟随 / 回到最新）：此窗内的图表事件**不是用户交互**，不得作为 leader。 */
  beginProgrammatic(): void;
  endProgrammatic(): void;
}

const NOOP_REGISTRY: ChartSyncRegistry = {
  register: () => () => {},
  beginProgrammatic: () => {},
  endProgrammatic: () => {},
};

/** 同步组注册表 Context（仅 `MultiPeriodChartStack` 启用时提供）。 */
export const ChartSyncContext = createContext<ChartSyncRegistry | null>(null);

/** 取当前同步注册表（无 provider ⇒ no-op）。 */
export function useChartSyncRegistry(): ChartSyncRegistry {
  const registry = useContext(ChartSyncContext);
  return registry ?? NOOP_REGISTRY;
}

export interface UseChartSyncGroupOptions {
  /** 统计广播回调（UI 角标 / store 可观测的数据源）。 */
  onStats?: (stats: SyncStats) => void;
  /** 卫星实例的 `barSpace` 上限（P0.3 锚定；默认 350）。 */
  satelliteMaxBarSpace?: number;
}

/**
 * 建立/销毁 `ChartSyncGroup`（provider 侧薄封装）。
 *
 * 成员集合变化（图表挂载/卸载/切周期）⇒ 重建组（旧组 `stop()` ⇒ 订阅/监听零残留）；
 * 组合不可用（配置面应已拦截）⇒ **不建组**并 `console.warn`：不做任何对齐（**禁止静默虚假对齐**）。
 */
export function useChartSyncGroup(options: UseChartSyncGroupOptions = {}): ChartSyncRegistry {
  const membersRef = useRef(new Map<number, SyncMember>());
  const seqRef = useRef(0);
  const groupRef = useRef<ChartSyncGroup | null>(null);
  const unsubStatsRef = useRef<(() => void) | null>(null);
  const programmaticRef = useRef(0);
  const onStatsRef = useRef(options.onStats);
  onStatsRef.current = options.onStats;
  const satMax = options.satelliteMaxBarSpace ?? SATELLITE_MAX_BAR_SPACE;

  const disposeGroup = useCallback(() => {
    unsubStatsRef.current?.();
    unsubStatsRef.current = null;
    groupRef.current?.stop();
    groupRef.current = null;
    programmaticRef.current = 0;
  }, []);

  const rebuild = useCallback(() => {
    disposeGroup();
    const members = [...membersRef.current.values()];
    if (members.length === 0) {
      onStatsRef.current?.({ ...EMPTY_SYNC_STATS }); // 组销毁 ⇒ 角标/统计归零（零残留）
      return;
    }
    try {
      const group = new ChartSyncGroup(members, {
        satelliteMaxBarSpace: satMax,
        reentrySuppression: true, // 生产恒开（默认；反向旋钮仅测试用）
      });
      group.applySatelliteLimits();
      unsubStatsRef.current = group.onChange((stats) => onStatsRef.current?.(stats));
      group.start();
      groupRef.current = group;
    } catch (err) {
      console.warn('[multi-period] ChartSyncGroup 未建立（周期组合不可用，禁止静默虚假对齐）', err);
    }
  }, [disposeGroup, satMax]);

  useEffect(() => () => disposeGroup(), [disposeGroup]);

  return useMemo<ChartSyncRegistry>(
    () => ({
      register(member) {
        const key = (seqRef.current += 1);
        membersRef.current.set(key, {
          id: `m${key}`,
          chart: member.chart as unknown as SyncChartApi,
          period: member.period,
          isBase: member.isBase,
        });
        rebuild();
        return () => {
          if (!membersRef.current.has(key)) return;
          membersRef.current.delete(key);
          rebuild();
        };
      },
      beginProgrammatic() {
        programmaticRef.current += 1;
        groupRef.current?.beginProgrammatic();
      },
      endProgrammatic() {
        if (programmaticRef.current > 0) programmaticRef.current -= 1;
        groupRef.current?.endProgrammatic();
      },
    }),
    [rebuild],
  );
}
