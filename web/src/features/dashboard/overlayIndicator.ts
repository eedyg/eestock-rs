import type { Chart, IndicatorCreate } from 'klinecharts';

/**
 * 唯一允许在 `candle_pane`（或任何已有指标 pane）**叠加**指标的框架入口。
 *
 * 为什么必须有这层封装（P7 根因，见 `tester/report/165_ma_candle_pane_root_cause.md`）：
 * klinecharts 10.0.3 的 `createIndicator(value, isStack)` **省略 `isStack` 即 `false`**，而
 * `false` 的语义不是「追加」而是「**整 pane 替换**」——`StoreImp.addIndicator`
 * （`node_modules/klinecharts/dist/index.esm.js:14162-14165`）会先
 * `removeIndicator({ paneId })` **清空该 pane 的全部指标**再 `push` 新指标。
 * 与此同时：
 *  - `createIndicator` 仍照常返回一个**非空新 id**（`:15292`）⇒ **返回 id ≠ 指标留在图中**；
 *  - `logWarn('createIndicator', …)`（`:15267`）只在「指标未注册」时触发 ⇒ 本异常**全程零告警**。
 *
 * 后果：同一 pane 上「先建 A（false）→ 再建 B（false/省略）」会**静默顶掉 A**（实测 MA→EMA/BOLL 可复现）。
 * 因此凡是要叠加到共享 pane 的指标，一律走本入口：显式移除旧实例 → 以 `isStack=true` 追加 → 断言非空。
 *
 * 权威依据：`design/15-multi-period/02-spec.md` §4.3（框架级硬约束）。
 *
 * @param chart      目标图表实例
 * @param spec       指标创建参数（含 `paneId`、`calcParams` 等）
 * @param expectName 期望生效的指标名（用于移除旧实例与「非空断言」，同时出现在错误信息里以便定位）
 * @throws 当创建后 `getIndicators({ name })` 为空（即被静默顶掉/未生效）时抛出可定位错误
 */
export function addOverlayIndicator(chart: Chart, spec: IndicatorCreate, expectName: string): void {
  // 1) 显式移除旧同名实例：createIndicator(spec, true) 是「追加」，不先移除会叠加出重复实例。
  chart.removeIndicator({ name: expectName });
  // 2) 必须显式 isStack=true（追加/叠加语义）——false/省略会静默清空整个 pane（index.esm.js:14162-14165）。
  chart.createIndicator(spec, true);
  // 3) 非空断言：返回 id 不代表指标留在图中（index.esm.js:15292），为空即抛错，禁止静默失效。
  if (chart.getIndicators({ name: expectName }).length === 0) {
    throw new Error(`指标 ${expectName} 未生效（isStack 语义坑）`);
  }
}
