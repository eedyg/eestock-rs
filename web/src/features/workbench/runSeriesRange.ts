/**
 * 结果页「评估段」裁剪（**ADR-028 D2.4**；用户 2026-09-22 决策 = 方案 A「裁剪到执行段」）。
 *
 * ## 背景（实测缺陷）
 *
 * 引擎在 **warmup 预热段** 仍逐 bar 评分（`per_bar.scores/aggregate`，标 `warmup:true`），
 * 但**不产净值/回撤/持仓**：`crates/strategy-core/src/engine.rs:937-959`
 * 「`if !is_warmup { nav.push(..); positions.push(..) }`；`per_bar` 仍全量记录」。
 *
 * 结果页把四条曲线画在**同一共享 x 轴**上（ADR-028 D2.1）⇒ 两条分数曲线横跨预热段、
 * 净值/持仓只覆盖执行段 ⇒ 用户报告「聚合总分和各策略评分的 scale 和净值不一样」
 * （截图取证：净值/持仓仅占右侧 ≈17%，分数曲线铺到 ≈85%；见
 * `coder/report/adr028_curve_y_scaling_mismatch_analysis.md` §0.0）。
 *
 * ## 裁决与口径（方案 A：分数曲线不画预热段）
 *
 * - **评估段** = run 的 `[from_ts, to_ts]`（后端存 **effective** 区间 = in-range =
 *   与净值/回撤/持仓同一口径，`crates/application/src/workbench.rs:736,757`）；
 * - 曲线数据裁到评估段 ⇒ 四条曲线与 K 线卡（`fromTs = run.from_ts`）**同段对齐**；
 * - 边界**含**端点（`ts >= from && ts <= to` 保留）；
 * - `from`/`to` 不可得（无 run / 解析失败 / `from > to`）⇒ **不裁剪**（`dropped = 0`，零回归）；
 * - 只按 `ts` 判定，**不**依赖 `warmup` 列（legacy/旧 run 无该列也能正确裁剪）；
 * - 顺序保持；**禁止静默有损**：裁剪根数必须回传并由 UI 标注（ADR-024 D10）。
 */

export interface EvaluatedRange {
  /** Unix 秒（含端点）。 */
  from: number;
  to: number;
}

export interface EvaluatedClip<T> {
  /** 评估段内的行（顺序保持）。 */
  kept: T[];
  /** 被剔除的行数（预热段 + 区间外）。 */
  dropped: number;
}

/** ISO（RFC3339）→ Unix 秒；不可解析 ⇒ null。 */
function toSecs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * run 的**评估段**（Unix 秒）。任一端不可得、或 `from > to` ⇒ `null`
 * （调用方据此**不裁剪**：坏数据不得静默清空曲线）。
 */
export function evaluatedRange(
  run: { from_ts: string; to_ts: string } | null | undefined,
): EvaluatedRange | null {
  if (!run) return null;
  const from = toSecs(run.from_ts);
  const to = toSecs(run.to_ts);
  if (from == null || to == null || from > to) return null;
  return { from, to };
}

/**
 * 把带 `ts`（Unix 秒）的序列裁剪到评估段：预热段（`ts < from`）与区间外（`ts > to`）**不参与曲线绘制**。
 * `range == null` ⇒ **原样返回**（同一数组引用，零拷贝、零回归）。
 */
export function clipToEvaluatedRange<T extends { ts: number }>(
  rows: readonly T[],
  range: EvaluatedRange | null,
): EvaluatedClip<T> {
  if (!range) return { kept: rows as T[], dropped: 0 };
  const kept: T[] = [];
  let dropped = 0;
  for (const r of rows) {
    if (r.ts >= range.from && r.ts <= range.to) kept.push(r);
    else dropped += 1;
  }
  return { kept, dropped };
}
