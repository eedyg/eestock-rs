import { describe, expect, it } from 'vitest';
import type { WorkbenchBarRecord } from './types';

/**
 * ADR-029 R16（登记债）：`per_bar` **第 8 个观测键** `affordability_capped` 已在 Rust 侧产出
 * （`crates/application/src/workbench.rs` 的 `bar_record_json`：D7 观测块 = `target_pct` /
 * `current_pct` / `ramp_cap_pct_per_bar` / `rate_limited` / `deadzone_blocked` / `clamped_by_guard` /
 * `sell_transition` / **`affordability_capped`**），但 `web/src/api/types.ts` 未声明。
 *
 * 本文件的两条锁：
 *  1. **编译期锁**（对象字面量直接赋值）：`WorkbenchBarRecord` 若未声明该键 ⇒ `npx tsc -b` 报
 *     TS2353「对象字面量只能指定已知属性」⇒ 门禁红。（`tsc --noEmit` 在本仓空转，不得引用。）
 *  2. **运行时锁**：**真实 run** 的 `/bars?kind=per_bar` 载荷里该键存在且值可解析（boolean）。
 *
 * 载荷来源（**逐字摘录**，未改写；原始响应落盘 `coder/evidence/20260925_small_debt/item3/`）：
 *  - `real_run_R3_all_per_bar.json` =
 *    `GET http://127.0.0.1:8081/api/workbench/runs/sr_1790267629982_000002/bars?kind=per_bar&offset=0&limit=5000`
 *    （2026-09-25 实测：`total=427`；**427/427 根**均含该键；`affordability_capped=true` 3 根 = idx 258/316/375）
 *  - `legacy_run_per_bar_no_key.json` =
 *    `GET …/runs/sr_1789832517800_000006/bars?kind=per_bar&offset=0&limit=2`（ADR-029 之前的 run）
 *
 * **可空依据**：后者（旧 run）的 `per_bar` **没有**该键（键集合仅
 * `aggregate/events/orders/scores/signal/ts/warmup`）⇒ 消费侧必须容差（`affordability_capped?`），
 * 不得当作恒有字段、也不得缺省补 `false`（那会把「未知」伪造成「未截断」）。
 */

/** 真实 run `sr_1790267629982_000002` 中 `affordability_capped=true` 的 bar（idx 258，逐字摘录）。 */
const REAL_RAW_TRUE =
  '{"affordability_capped":true,"aggregate":50.0,"clamped_by_guard":false,"current_pct":1.0,' +
  '"deadzone_blocked":false,"events":[{"bar_index":258,"commission":24.993751562109473,' +
  '"price":1.3572714,"qty":73658.81742475225,"reason":"Policy","rt_seq":1,"side":"Buy",' +
  '"stamp_duty":0.0,"trade_value":99975.00624843789,"type":"fill"}],"orders":[],' +
  '"ramp_cap_pct_per_bar":null,"rate_limited":false,"scores":[{"score":50.0,"slot_idx":0}],' +
  '"sell_transition":false,"signal":"Hold","target_pct":1.0,"ts":1768406400,"warmup":false}';

/** 同一响应的 idx 260（`affordability_capped=false`，逐字摘录）。 */
const REAL_RAW_FALSE =
  '{"affordability_capped":false,"aggregate":50.0,"clamped_by_guard":false,"current_pct":1.0,' +
  '"deadzone_blocked":false,"events":[],"orders":[],"ramp_cap_pct_per_bar":null,"rate_limited":false,' +
  '"scores":[{"score":50.0,"slot_idx":0}],"sell_transition":false,"signal":"Hold","target_pct":1.0,' +
  '"ts":1768752000,"warmup":false}';

/** 旧 run `sr_1789832517800_000006` 的 bar：**无** `affordability_capped`（逐字摘录）。 */
const LEGACY_RAW = '{"aggregate":50.0,"events":[],"orders":[],"scores":[{"score":50.0,"slot_idx":0}],' +
  '"signal":"Hold","ts":1785115800,"warmup":true}';

const parseBar = (raw: string): WorkbenchBarRecord => JSON.parse(raw) as WorkbenchBarRecord;

describe('ADR-029 R16：per_bar 第 8 个观测键 affordability_capped（前端类型）', () => {
  it('编译期锁：字面量含 affordability_capped 时赋值给 WorkbenchBarRecord 必须合法（未声明 ⇒ tsc TS2353）', () => {
    // 若 `WorkbenchBarRecord` 未声明该键，本行在 `npx tsc -b` 下报「对象字面量只能指定已知属性」⇒ 门禁红。
    const literal: WorkbenchBarRecord = {
      ts: 1,
      scores: [],
      aggregate: 0,
      signal: 'Hold',
      orders: [],
      events: [],
      affordability_capped: false,
    };
    expect(literal.affordability_capped).toBe(false);
  });

  it('运行时锁：真实 run 的 per_bar 该键存在且值为 boolean（true / false 两态都可解析）', () => {
    const trueBar = parseBar(REAL_RAW_TRUE);
    const falseBar = parseBar(REAL_RAW_FALSE);
    for (const [label, rec] of [
      ['true', trueBar],
      ['false', falseBar],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(rec, 'affordability_capped'),
        `${label} 键须存在`,
      ).toBe(true);
      expect(typeof rec.affordability_capped, `${label} 值须为 boolean`).toBe('boolean');
    }
    expect(trueBar.affordability_capped, '真实 run 存在 true 态（引擎可观测到截断）').toBe(true);
    expect(falseBar.affordability_capped).toBe(false);
  });

  it('可空依据：旧 run 载荷无该键 ⇒ 声明为可选（缺省 undefined，不伪造 false）', () => {
    const legacy = parseBar(LEGACY_RAW);
    expect(Object.prototype.hasOwnProperty.call(legacy, 'affordability_capped')).toBe(false);
    expect(legacy.affordability_capped).toBeUndefined();
  });
});
