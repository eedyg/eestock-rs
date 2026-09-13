/**
 * dcap 指标 —— 前端图表接线层（klinecharts 注册 + 副图 + calc 降级）
 *
 * 本文件位置：`web/src/features/indicators/dcapIndicator.ts`（**手写**，非 tangle 生成物）
 * 算法正文：  `web/src/features/indicators/dcap.ts`（tangle 生成物；勿手改，改 `design/14-dcap-indicator/02-spec.md` §10.1）
 * 权威口径：  `design/14-dcap-indicator/02-spec.md` §6（图表契约 C）/ §7（配置面）
 *
 * 契约要点（02-spec §6）：
 *  - 名 `DCAP`；一个指标的 3 个 figure（`s` / `m` / `l`，与 KDJ 的 K/D/J 同构）；
 *  - **独立副图 pane**（不得叠 `candle_pane`：dcap 与价格无量纲关系，叠主图会压爆主图 Y 轴）——
 *    由调用方 `chart.createIndicator({name:'DCAP', ...}, true)`（isStack）建独立 pane，故模板不带 `paneId`；
 *  - **必须显式 `precision: 5`**：klinecharts 自定义指标默认 `precision = 4`，`0.004578…` 会在 4 位下丢第 5 位；
 *  - `calcParams = [n_s, n_m, n_l, r_s, r_m, r_l, smooth, m]`（图表不需要 `th`）；
 *  - 数据不足 → `null`（附图值域 `Nullable<D>` ⇒ 线自然断开）；**任何异常必须降级为断线**，不得抛出打断渲染（§9）。
 */
import { registerIndicator, type IndicatorTemplate, type KLineData } from 'klinecharts';
import { computeDcapSeries, type DcapParams, type DcapValues } from './dcap';

/** 显示参数（8 个，`th` 除外）—— 复用 tangle 生成物 `dcap.ts` 的契约类型（02-spec §4）。 */
export type { DcapParams, DcapValues };

/** 指标名（`registerIndicator` / `createIndicator` / `removeIndicator` 三处口径一致）。 */
export const DCAP_INDICATOR_NAME = 'DCAP';
/** 显式精度（02-spec §6：默认 4 位会丢第 5 位，必须钉 5）。 */
export const DCAP_PRECISION = 5;

/** 显示参数范围（02-spec §2；`th` 属策略参数，不进前端模块，也不进 `/api/config/dcap`）。 */
export const DCAP_N_MIN = 2;
export const DCAP_N_MAX = 250;
export const DCAP_R_MIN = 0.5;
export const DCAP_R_MAX = 2.0;
export const DCAP_M_MIN = 1;
export const DCAP_M_MAX = 60;

/** 显示参数默认值（02-spec §2 默认列；与后端 `DcapConfigDto::default()` 同值：8/26/60/1/1/1/1/3）。 */
export const DEFAULT_DCAP_PARAMS: DcapParams = {
  n_s: 8,
  n_m: 26,
  n_l: 60,
  r_s: 1,
  r_m: 1,
  r_l: 1,
  smooth: 1,
  m: 3,
};

/** 显示参数 → klinecharts `calcParams`（顺序即 02-spec §6 契约；**不含 `th`**）。 */
export function dcapCalcParams(p: DcapParams): number[] {
  return [p.n_s, p.n_m, p.n_l, p.r_s, p.r_m, p.r_l, p.smooth, p.m];
}

/** `calcParams` → 显示参数（防御：缺参/非数值回默认；`calc` 被引擎以任意数组调用都不崩）。 */
export function dcapParamsFromCalcParams(calcParams: readonly unknown[] | null | undefined): DcapParams {
  const arr = Array.isArray(calcParams) ? calcParams : [];
  const num = (i: number, dflt: number): number => {
    const v = Number(arr[i]);
    return Number.isFinite(v) ? v : dflt;
  };
  return {
    n_s: num(0, DEFAULT_DCAP_PARAMS.n_s),
    n_m: num(1, DEFAULT_DCAP_PARAMS.n_m),
    n_l: num(2, DEFAULT_DCAP_PARAMS.n_l),
    r_s: num(3, DEFAULT_DCAP_PARAMS.r_s),
    r_m: num(4, DEFAULT_DCAP_PARAMS.r_m),
    r_l: num(5, DEFAULT_DCAP_PARAMS.r_l),
    smooth: num(6, DEFAULT_DCAP_PARAMS.smooth),
    m: num(7, DEFAULT_DCAP_PARAMS.m),
  };
}

/** 取数 warmup 根数（02-spec §6；裁决依据见 §8 #19）：`limit = viewport_bars + (n_l + m − 1)`；
 *  多取部分仅供计算、不上图（视口最左那根才不断线）。 */
export function dcapWarmupBars(p: DcapParams): number {
  return p.n_l + p.m - 1;
}

/** 显示参数校验（02-spec §2 单参数范围 + §7 跨字段 `n_s < n_m < n_l`）；合法返回 null。 */
export function validateDcapParams(p: DcapParams): string | null {
  const isInt = (v: number): boolean => Number.isInteger(v);
  const ns = [p.n_s, p.n_m, p.n_l];
  if (!ns.every(isInt)) return 'n_s/n_m/n_l 须为整数';
  if (!ns.every((v) => v >= DCAP_N_MIN && v <= DCAP_N_MAX)) {
    return `n_s/n_m/n_l 须在 ${DCAP_N_MIN}-${DCAP_N_MAX}`;
  }
  if (!(p.n_s < p.n_m && p.n_m < p.n_l)) return '须满足 n_s < n_m < n_l（非单调组合被拒绝）';
  const rs: Array<[string, number]> = [
    ['r_s', p.r_s],
    ['r_m', p.r_m],
    ['r_l', p.r_l],
  ];
  for (const [key, r] of rs) {
    if (typeof r !== 'number' || !Number.isFinite(r) || r < DCAP_R_MIN || r > DCAP_R_MAX) {
      return `${key} 须在 ${DCAP_R_MIN}-${DCAP_R_MAX}`;
    }
  }
  if (p.smooth !== 0 && p.smooth !== 1) return 'smooth 须为 0（关）或 1（开）';
  if (!isInt(p.m) || p.m < DCAP_M_MIN || p.m > DCAP_M_MAX) return `m 须为 ${DCAP_M_MIN}-${DCAP_M_MAX} 整数`;
  return null;
}

/** 三线全缺的「断线」值（figure 值域 Nullable ⇒ 线在此断开）。 */
function breakValue(): DcapValues {
  return { s: null, m: null, l: null };
}

function breakSeries(len: number): DcapValues[] {
  return Array.from({ length: len }, breakValue);
}

/** 非有限值 → null（数据不足/非法价一律断线，绝不把 NaN 交给渲染）。 */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toDcapValues(v: unknown): DcapValues {
  const o = (v ?? {}) as Partial<DcapValues>;
  return { s: finiteOrNull(o.s), m: finiteOrNull(o.m), l: finiteOrNull(o.l) };
}

/**
 * `calc` 正文：closes → `computeDcapSeries`（CORE，含入口归一化）→ 三线值。
 * **降级纪律（02-spec §9）**：数据不足 → null 断线；任何异常（含读取 bar 字段抛错）→ 全 null 断线；
 * 长度恒等于 `dataList.length`（引擎按索引对齐），任何情况下都不得向外抛。
 */
function calcDcapSeries(dataList: KLineData[], calcParams: readonly number[] | null | undefined): DcapValues[] {
  if (!Array.isArray(dataList)) return [];
  const params = dcapParamsFromCalcParams(calcParams);
  try {
    const closes = dataList.map((d) => Number((d as KLineData).close));
    const series = computeDcapSeries(closes, params) as DcapValues[] | null | undefined;
    if (!Array.isArray(series) || series.length !== dataList.length) return breakSeries(dataList.length);
    return series.map(toDcapValues);
  } catch {
    // 计算异常 → 断线（不得打断图表渲染；不新增错误通道，02-spec §9）
    return breakSeries(dataList.length);
  }
}

/** klinecharts 指标模板（02-spec §6）。`figures` 三线 s/m/l；无 `paneId` ⇒ 由 isStack 建独立副图。 */
export const DCAP_INDICATOR_TEMPLATE: IndicatorTemplate<DcapValues, number> = {
  name: DCAP_INDICATOR_NAME,
  shortName: DCAP_INDICATOR_NAME,
  precision: DCAP_PRECISION,
  calcParams: dcapCalcParams(DEFAULT_DCAP_PARAMS),
  figures: [
    { key: 's', title: 'S: ', type: 'line' },
    { key: 'm', title: 'M: ', type: 'line' },
    { key: 'l', title: 'L: ', type: 'line' },
  ],
  calc: (dataList, indicator) => calcDcapSeries(dataList, indicator?.calcParams),
};

/** 注册幂等（klinecharts `registerIndicator` 为全局注册，重复注册会覆盖/告警）。 */
let dcapRegistered = false;
export function ensureDcapIndicatorRegistered(): void {
  if (dcapRegistered) return;
  // 测试环境（jsdom 无 canvas）klinecharts 被打桩，缺 registerIndicator ⇒ 跳过注册（同 KlineChart 的 overlay 兜底）。
  if (typeof registerIndicator !== 'function') return;
  registerIndicator(DCAP_INDICATOR_TEMPLATE);
  dcapRegistered = true;
}
