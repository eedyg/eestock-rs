/**
 * 曲线绘图区几何（ADR-028 §2.4c 第 5 项）——**四张曲线（聚合分 / 各策略评分 / 净值+回撤 / 持仓比率）
 * 的绘图内边距与其他共用几何参数的唯一事实源**。禁止任何曲线组件再声明自有 `PAD` / `W`。
 *
 * ⚠ **CURVE_PAD 的取值是跨仓契约，不是可随手调的样式常数**：
 *  冻结规格 `web/e2e/adr028-axis-align-probe.e2e.ts` 把校准口径硬编码为 `CURVE_PAD = 8`
 *  （L54-57：`CURVE_PLOT_W = 1000 − 2×8 = 984`），并在 L1172-1183 / L1630-1633 用
 *  `predictIndexUserX(j) = 8 + j/(N−1)×984` 与渲染 userX 比对，硬断言 `indexResidualMaxUser ≤ 1`
 *  （「配对可信」的自校验门）。因此 PAD 一旦 ≠ 8，该规格主断言必红。
 *
 *  历史缺陷（本波修复）：聚合/各策略为 8、净值/持仓为 10 ⇒ 跨视图同一根 bar 的 userX 恒差
 *  2.0 user unit（666px 卡宽 / viewBox ≈ 1070.82 ⇒ **1.244px**），吃掉了 ≤2px 判据余量的 62%。
 *  统一到 8 后跨视图差 = 0.0 user unit（≤0.1px），且冻结规格全绿。
 *
 *  ⇒ **改这个值必须同步改 `adr028-axis-align-probe.e2e.ts`**（跨仓契约变更），并重跑该规格。
 */
export const CURVE_PAD = 8;

/** 曲线 viewBox 宽（user units；四张曲线同宽，与 K 线共用绘图区几何时由 `plot.w` 覆盖）。 */
export const CURVE_W = 1000;
