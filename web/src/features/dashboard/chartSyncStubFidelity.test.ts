/**
 * **忠实桩保真度回归**（P3-D-1）：把 jsdom 同步桩 `src/test/syncChartStub.ts` 的
 * `scrollToTimestamp` 落点**钉在真身实测值**上，并在**同一环境**内给出反向/可满足性证据。
 *
 * 本文件位置：`web/src/features/dashboard/chartSyncStubFidelity.test.ts`
 * 设计报告：`tester/design/274_p3d1_faithful_stub_red_design.md`
 *
 * 背景（P3-C 独立验收判 **FAIL(B1,B2,B4)**）：真身 klinecharts 10.0.3 的
 * `scrollToTimestamp(ts)` 落点**距右缘固定 2 根**，且 `setOffsetRightDistance(0)` **无法消除**；
 * 而旧桩把它简化成"精确贴右缘" ⇒ `chartSyncGroup.test.ts` 20/20 在真渲染下不成立（假绿）。
 *
 * 实测锚定（**不得重新发现**）：`tester/evidence/273_p3c_acceptance/p3c_harness.json` →
 * `scenarios.PROBE`（页面 `real_render_harness.html`，driver `real_render_driver.mjs`）：
 *  - `offsetBefore = 64`（bs=8 ⇒ 8 根 × 8px，与 P0.3 §6-I6 的 `8×barSpace` 一致）；
 *  - `setOffsetRightDistance(0)` 后 **读回 0**；
 *  - 两实例同 `scrollToDataIndex` ⇒ 范围 `[241,302] == [241,302]`（**精确相等**）；
 *  - `scrollToTimestamp(list[302].timestamp)` ⇒ `[243,304]` ⇒ 右缘索引 = 目标索引 **+2**，
 *    `deltaTs_toTs = 120000ms = 2 × 1m`。
 *
 * 本文件**只读**测试基建：不改产品代码（`chartSyncGroup.ts` 等），不改桩的对外签名。
 */

import { describe, expect, it } from 'vitest';
import {
  REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS,
  createSyncChartStub,
  makeSeries,
} from '@/test/syncChartStub';

/** P3-C PROBE 的精确复刻参数（真身实测配置）。 */
const T0 = Date.UTC(2026, 8, 14, 7, 0, 0);
const MIN = 60_000;
const PANE_WIDTH = 520;
const BAR_SPACE = 8;
const PROBE_INDEX = 300;

function probeStub() {
  return createSyncChartStub({
    bars: makeSeries({ count: 600, spacingMs: MIN, endTs: T0 }),
    paneWidthPx: PANE_WIDTH,
    barSpace: BAR_SPACE,
  });
}

describe('syncChartStub 保真度：`scrollToTimestamp` 落点 = 距右缘 2 根（真身 PROBE 复刻）', () => {
  it('F1 右偏移可归零（读回 0）——但落点缺口**不是**右偏移，归零无法消除', () => {
    const a = probeStub();
    // 真身 PROBE：offsetBefore = 64（8 根 @bs8），setOffsetRightDistance(0) 后读回 0
    expect(a.getOffsetRightDistance(), '初始右偏移 = 8 根 × barSpace（P0.3 §6-I6 实测）').toBe(64);
    a.setOffsetRightDistance(0);
    expect(a.getOffsetRightDistance(), 'setOffsetRightDistance(0) 必须真的生效（真身读回 0）').toBe(0);

    a.scrollToTimestamp(a.__bars[PROBE_INDEX] as number);
    // 归零后仍偏 2 根 ⇒ 缺口独立于右偏移（这正是 P3-C B1/B2/B4 的单一根因）
    expect(
      a.__rightIndex() - PROBE_INDEX,
      '归零右偏移后落点缺口仍为 2 根（真身 PROBE：[243,304] vs 目标索引 302）',
    ).toBe(REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS);
  });

  it('F2 同构双实例：`scrollToDataIndex` 精确对齐（缺口不在该原语上）', () => {
    const a = probeStub();
    const b = probeStub();
    a.setOffsetRightDistance(0);
    b.setOffsetRightDistance(0);
    a.scrollToDataIndex(PROBE_INDEX);
    b.scrollToDataIndex(PROBE_INDEX);
    // 真身 PROBE：sameIndexScroll_a [241,302] == sameIndexScroll_b [241,302]（**精确**）
    expect(
      b.getVisibleRange().to,
      '同 scrollToDataIndex ⇒ 右缘索引必须精确相同（缺口不在 scrollToDataIndex 上）',
    ).toBe(a.getVisibleRange().to);
  });

  it('F3 `scrollToTimestamp(leader.toTs)` ⇒ 右缘 = 目标索引 + 2 根（= 真身 PROBE 的 [243,304]）', () => {
    const base = probeStub();
    const follower = probeStub();
    base.setOffsetRightDistance(0);
    follower.setOffsetRightDistance(0);
    base.scrollToDataIndex(PROBE_INDEX);
    const leaderToTs = base.__bars[base.getVisibleRange().to] as number;

    follower.scrollToTimestamp(leaderToTs);

    const edgeIndexGap = follower.getVisibleRange().to - base.getVisibleRange().to;
    expect(
      edgeIndexGap,
      `跨图镜像的右缘索引差必须复刻真身实测的 ${REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS} 根（PROBE: 304 - 302）`,
    ).toBe(REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS);

    const leaderTo = base.__bars[base.getVisibleRange().to] as number;
    const followerTo = follower.__bars[follower.getVisibleRange().to] as number;
    // 真身 PROBE：deltaTs_toTs = 120000ms = 2 × 1m
    expect(
      followerTo - leaderTo,
      '右端时间戳差必须复刻真身实测的 2 根（PROBE deltaTs_toTs = 120000ms）',
    ).toBe(REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS * MIN);
  });

  it('F4 可满足性反向对照：**补偿 2 根缺口**后相对偏移 ≤1 根（判据非空、可满足、非不可能测试）', () => {
    const base = probeStub();
    const follower = probeStub();
    base.setOffsetRightDistance(0);
    follower.setOffsetRightDistance(0);
    base.scrollToDataIndex(PROBE_INDEX);

    // 真身语义：`scrollToTimestamp(ts)` ≡ `scrollToDataIndex(nearest(ts))`，而该原语的落点 = `nearest + 2`
    // ⇒ 要让右缘**正好**落在目标索引上，必须把目标 ts 前移 `REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS` 根
    //   （标定补偿；等价做法：读回落点后按缺口回退）。本对照证明 G1 的「≤1 根」**可达**。
    const targetIndex = base.getVisibleRange().to; // = PROBE_INDEX（桩内 scrollToDataIndex 精确）
    const compensatedTs = base.__bars[targetIndex - REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS] as number;
    follower.scrollToTimestamp(compensatedTs);

    expect(
      Math.abs(follower.__rightIndex() - base.__rightIndex()),
      '补偿 2 根缺口后相对偏移为 0 ⇒ G1 的「≤1 根」判据可满足（不是不可能测试）',
    ).toBeLessThanOrEqual(1);
  });

  it('F5 保真度诚实标注：桩与真身的**已知**残余差异（绝对窗口 / 可见根数）', () => {
    const a = probeStub();
    a.setOffsetRightDistance(0);
    a.scrollToDataIndex(PROBE_INDEX);
    const r = a.getVisibleRange();
    // 桩：可见根数 = floor(paneWidth / barSpace) = floor(520/8) = 65 ⇒ from = 300-64 = 236
    // 真身：实测 from = 241（62 根可见）⇒ 桩的可见根数模型偏乐观。
    // ⚠️ 因此「`floor(520/302)=1` ⇒ 可见 <2 根」这类**依赖可见根数模型**的推论只在桩内成立，
    //    不得当作真身证据（P3-C：真身 `setBarSpace(302)` 仍报 4 根可见，部分 bar 计数导致）。
    //    本文件的 F1–F4 判据**不依赖**可见根数，只依赖「落点索引缺口」，故不受该残余差异影响。
    // 钉住当前桩行为（防止"顺手改桩"绕过红线）：65 = floor(520/8)。
    expect(r.to - r.from + 1, '桩的可见根数 = floor(paneWidth/barSpace)（真身 520px/bs8 实测 62 根）').toBe(65);
    expect(REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS, '落点缺口常量必须为真身实测的 2 根').toBe(2);
  });
});
