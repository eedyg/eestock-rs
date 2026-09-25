/**
 * ADR-028 D12 / 09-plan §2 —— **Y 轴刻度生成（唯一纯函数）**。
 *
 * 冻结口径（09-plan §2 表格 + §2.1 硬约束 2）：
 *  - **3–5 条**自适应刻度，步长 ∈ {1,2,**2.5**,5}×10^k（2.5 档 = 2026-09-25 复审裁定，用于让 0–100 域得到 0/25/50/75/100）；
 *  - **只标注现有 y 域，绝不改值域** ⇒ 刻度**必须落在 `[min,max]` 内**（禁为了"好看"外扩到 nice 边界，
 *    那会诱使调用方去 padding 值域 ⇒ 动 `equity-line`/`position-line` 顶点与冻结几何）；
 *  - 各卡 y 域由**既有**实现提供（聚合/各策略 = 固定 0–100；净值 = `extentOf(equities)` 无 padding；
 *    持仓 = `extentOf(ratios ∪ {0,1})`），本模块**不**参与值域计算。
 *
 * 设计（为何是"域内取 nice 倍数"而不是"nice 边界外扩"）：外扩会改变刻度覆盖范围，
 * 而 09-plan §1.2-2 明确禁止任何会改 y 映射的改动 ⇒ 取 `step` 的整数倍中落在域内的子集。
 * 病态域（域内不存在任何 nice 步长的 ≥3 个倍数，如 `[1000.5, 1000.9]` 这类窄域 + 高位偏移）
 * ⇒ 显式兜底：**域内等距 3 条**（仍不越界、不空集；这是契约的 3–5 条约束所要求的让步，
 * 步长不再是 nice 集合成员，属显式披露的兜底路径）。
 */

/** 尾数集合（步长 = m × 10^k）；**2026-09-25 复审裁定**：加入 `2.5` 档
 *  （仅 {1,2,5}×10^k 时 0–100 域只能给 3 条 0/50/100，不满足「看到具体范围」）。 */
const MANTISSAS = [1, 2, 2.5, 5];

/** 返回 `[min,max]` 内 `step` 的整数倍（升序）；浮点误差用**相对** eps 吸收（绝对 eps 在 1e5 量级会错位）。 */
function multiplesIn(min: number, max: number, step: number): number[] {
  const lo = min / step;
  const hi = max / step;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const eps = 1e-9 * Math.max(1, Math.abs(lo), Math.abs(hi));
  const i0 = Math.ceil(lo - eps);
  const i1 = Math.floor(hi + eps);
  if (i1 < i0) return [];
  const out: number[] = [];
  for (let i = i0; i <= i1; i++) {
    const v = i * step;
    out.push(v === 0 ? 0 : v); // 归一 `-0`（`Math.ceil(−eps)` 会给出 `−0` ⇒ 刻度文本/相等断言都应是 `0`）
  }
  return out;
}

/** 候选步长阶梯（`raw` 附近的 {1,2,2.5,5}×10^k，由细到粗）。 */
function stepLadder(raw: number): number[] {
  const k0 = Math.floor(Math.log10(raw));
  const set = new Set<number>();
  for (let k = k0 - 4; k <= k0 + 3; k++) {
    for (const m of MANTISSAS) set.add(m * Math.pow(10, k));
  }
  return [...set].sort((a, b) => a - b);
}

/** 域内等距兜底（条数 = 3–5；含端点 ⇒ 不外扩、不空集）。 */
function fallbackEven(min: number, max: number, count: number): number[] {
  const n = Math.min(5, Math.max(3, Math.round(count) || 3));
  const span = max - min;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(min + (span * i) / (n - 1));
  return out;
}

/**
 * 生成覆盖 `[min,max]` **域内**的自适应刻度（3–5 条，优先步长 ∈ {1,2,5}×10^k）。
 *
 * @param min 域下界（非有限 ⇒ 返回 `[]`）
 * @param max 域上界（非有限 ⇒ 返回 `[]`）
 * @param targetCount 目标条数（默认 4；非法值按 4 处理；上限 5 不可突破）
 * @returns 升序刻度值；`min === max` ⇒ 单条 `[min]`（不除零、不自造域）
 */
export function niceTicks(min: number, max: number, targetCount = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (lo === hi) return [lo];
  const target = Number.isFinite(targetCount) && targetCount > 0 ? Math.round(targetCount) : 4;
  const raw = (hi - lo) / Math.max(target - 1, 1);

  let best: number[] = [];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const step of stepLadder(raw)) {
    const ticks = multiplesIn(lo, hi, step);
    const n = ticks.length;
    // 只接受 3–5 条（契约上限）；在其中挑最接近目标条数的，平手取更细的步长
    if (n < 3 || n > 5) continue;
    const score = Math.abs(n - target);
    if (score < bestScore) {
      bestScore = score;
      best = ticks;
    }
  }
  if (best.length > 0) return best;

  // 兜底 1：阶梯里有 6 条以上的（只可能偏多）⇒ 均匀取 5 条，仍全在域内
  for (const step of stepLadder(raw)) {
    const ticks = multiplesIn(lo, hi, step);
    if (ticks.length > 5) {
      const picked: number[] = [];
      for (let i = 0; i < 5; i++) picked.push(ticks[Math.round((i * (ticks.length - 1)) / 4)]!);
      return [...new Set(picked)].sort((a, b) => a - b);
    }
  }
  // 兜底 2：任何 nice 步长在域内的倍数都 < 3（窄域 + 高位偏移）⇒ 域内等距 3 条
  return fallbackEven(lo, hi, target);
}
