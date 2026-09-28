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

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * ADR-028 §2.13 登记项 ②：`per_bar` **其余 4 个已产出未声明键**（同属 ADR-029 D7 观测块）
 * `warmup` / `ramp_cap_pct_per_bar` / `rate_limited` / `sell_transition`。
 *
 * 产出侧事实源（同一处，逐字对应）：`crates/application/src/workbench.rs::bar_record_json`（`"ts"` /
 * `"warmup"` + D7 观测块 8 键平铺）；语义源：`crates/strategy-core/src/policy.rs::PolicyObservation`。
 *
 * 载荷来源（**逐字摘录**，未改写；原始响应落盘
 * `coder/evidence/20260925_legacy_e2e_reanchor/raw/per_bar_keys/`）：
 *  ① `ratecap_159776_D1_427.json` = `GET http://127.0.0.1:8081/api/workbench/runs/sr_1790267627829_000000/bars?kind=per_bar&offset=0&limit=5000`
 *     （2026-09-25 实测，`total=427`；run 策略 `Exposure{ramp:{RateCap:{pct_per_bar:0.05}}}`）**分母 427/427 根全含这 4 键**：
 *     `warmup` true 250 / false 177；`ramp_cap_pct_per_bar` null 250 / 0.05 177；`rate_limited` false 422 / true 5；
 *     `sell_transition` false 421 / true 6。
 *  ② `legacy_1949.json` = `GET …/runs/sr_1789832517800_000006/bars?kind=per_bar&offset=0&limit=5000`
 *     （ADR-029 D7 之前的 run，`total=1949`）：`warmup` **1949/1949 在**；其余 3 键 **0/1949**（缺席）
 *     ⇒ 消费侧必须容差（3 键声明为可选）；`warmup` 虽在 legacy 也在，仍按「可空」声明（mock/fixture 与
 *     未来 legacy 形态容差；产品侧不依赖其为恒有）。
 *
 * 量纲（依据 `policy.rs` pipeline ⑤ `let cap_qty = pct_per_bar * equity / price`）：
 *  `ramp_cap_pct_per_bar` = **每 bar 允许的目标变动金额 / 决策 bar 收盘净值 equity**（占净值比 / bar，
 *  0.05 = 5%/bar）；`null` = 该 run 的 `ramp` 非 `RateCap`（无速率预算），**不是** 0。
 *  `rate_limited` = 限速步骤**确实压缩了本 bar 目标变动**（pipeline ⑤）；
 *  `sell_transition` = 本 bar **跨越卖出档边界**（进入或离开 `s <= sell_threshold` 档）；
 *  `warmup` = 该 bar 在**预热段**（引擎标记：不执行 Policy / 不计绩效）。
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** `rate_limited=true` 的 bar（`sr_1790267627829_000000`，ts 1768320000；逐字摘录）。 */
const RC_RAW_RATE_LIMITED =
  '{"affordability_capped": false, "aggregate": 80.0, "clamped_by_guard": false, "current_pct": 0.0,' +
  ' "deadzone_blocked": false, "events": [], "orders": [{"qty": 3687.315634218289, "reason": "Policy",' +
  ' "side": "Buy"}], "ramp_cap_pct_per_bar": 0.05, "rate_limited": true, "scores": [{"score": 80.0,' +
  ' "slot_idx": 0}], "sell_transition": false, "signal": "Buy", "target_pct": 0.05, "ts": 1768320000,' +
  ' "warmup": false}';

/** `sell_transition=true` 的 bar（同 run，ts 1769702400；逐字摘录）。 */
const RC_RAW_SELL_TRANSITION =
  '{"affordability_capped": false, "aggregate": 20.0, "clamped_by_guard": false, "current_pct": 0.045959655239836694,' +
  ' "deadzone_blocked": false, "events": [], "orders": [{"qty": 3684.5536015203875, "reason": "Policy",' +
  ' "side": "Sell"}], "ramp_cap_pct_per_bar": 0.05, "rate_limited": false, "scores": [{"score": 20.0,' +
  ' "slot_idx": 0}], "sell_transition": true, "signal": "Sell", "target_pct": 0.0, "ts": 1769702400,' +
  ' "warmup": false}';

/** `warmup=true` 的 bar（同 run，ts 1734883200；逐字摘录：D7 观测块为 null/零值）。 */
const RC_RAW_WARMUP =
  '{"affordability_capped": false, "aggregate": 50.0, "clamped_by_guard": false, "current_pct": null,' +
  ' "deadzone_blocked": false, "events": [], "orders": [], "ramp_cap_pct_per_bar": null, "rate_limited": false,' +
  ' "scores": [{"score": 50.0, "slot_idx": 0}], "sell_transition": false, "signal": "Hold", "target_pct": null,' +
  ' "ts": 1734883200, "warmup": true}';

/** `ramp_cap_pct_per_bar=0.05`（非预热、未受限）的 bar（同 run，ts 1767542400；逐字摘录）。 */
const RC_RAW_RAMP_CAP =
  '{"affordability_capped": false, "aggregate": 50.0, "clamped_by_guard": false, "current_pct": 0.0,' +
  ' "deadzone_blocked": true, "events": [], "orders": [], "ramp_cap_pct_per_bar": 0.05, "rate_limited": false,' +
  ' "scores": [{"score": 50.0, "slot_idx": 0}], "sell_transition": false, "signal": "Hold", "target_pct": 0.0,' +
  ' "ts": 1767542400, "warmup": false}';

/** legacy run（`total=1949`）的 bar：`warmup` 在，其余 3 键**缺席**（逐字摘录）。 */
const LEGACY_RAW_1949 =
  '{"aggregate": 50.0, "events": [], "orders": [], "scores": [{"score": 50.0, "slot_idx": 0}],' +
  ' "signal": "Hold", "ts": 1785115800, "warmup": true}';

describe('ADR-028 §2.13 ②：per_bar 其余 4 个已产出键（warmup / ramp_cap_pct_per_bar / rate_limited / sell_transition）', () => {
  it('编译期锁：字面量含这 4 键 ⇒ 赋值给 WorkbenchBarRecord 必须合法（未声明 ⇒ tsc TS2353）', () => {
    // 4 键齐备（`ramp_cap_pct_per_bar` 两态：`null` = 非 RateCap；数字 = RateCap 的 pct_per_bar）。
    const withCap: WorkbenchBarRecord = {
      ts: 1,
      scores: [],
      aggregate: 0,
      signal: 'Hold',
      orders: [],
      events: [],
      warmup: false,
      ramp_cap_pct_per_bar: 0.05,
      rate_limited: true,
      sell_transition: false,
    };
    const noCap: WorkbenchBarRecord = {
      ts: 2,
      scores: [],
      aggregate: 0,
      signal: 'Hold',
      orders: [],
      events: [],
      warmup: true,
      ramp_cap_pct_per_bar: null,
      rate_limited: false,
      sell_transition: true,
    };
    expect([withCap.ramp_cap_pct_per_bar, noCap.ramp_cap_pct_per_bar]).toEqual([0.05, null]);
  });

  it('运行时锁：真实 run 载荷 427/427 根含这 4 键，值域可解析（boolean / number|null）', () => {
    const bars = [
      ['rate_limited=true', RC_RAW_RATE_LIMITED],
      ['sell_transition=true', RC_RAW_SELL_TRANSITION],
      ['warmup=true', RC_RAW_WARMUP],
      ['ramp_cap_pct_per_bar=0.05', RC_RAW_RAMP_CAP],
    ] as const;
    for (const [label, raw] of bars) {
      const rec = parseBar(raw);
      for (const key of ['warmup', 'ramp_cap_pct_per_bar', 'rate_limited', 'sell_transition'] as const) {
        expect(Object.prototype.hasOwnProperty.call(rec, key), `${label} 须含 ${key}`).toBe(true);
      }
      expect(typeof rec.warmup, `${label} warmup 须为 boolean`).toBe('boolean');
      expect(rec.rate_limited === true || rec.rate_limited === false, `${label} rate_limited 须为 boolean`).toBe(true);
      expect(rec.sell_transition === true || rec.sell_transition === false, `${label} sell_transition 须为 boolean`).toBe(
        true,
      );
      const cap = rec.ramp_cap_pct_per_bar;
      expect(cap === null || typeof cap === 'number', `${label} ramp_cap_pct_per_bar 须为 number|null`).toBe(true);
    }
    // 三态各自可达（分母 427：true 250/177、rate_limited true 5、sell_transition true 6、ramp 非空 177）。
    expect(parseBar(RC_RAW_RATE_LIMITED).rate_limited).toBe(true);
    expect(parseBar(RC_RAW_RATE_LIMITED).warmup).toBe(false);
    expect(parseBar(RC_RAW_SELL_TRANSITION).sell_transition).toBe(true);
    expect(parseBar(RC_RAW_WARMUP).warmup).toBe(true);
    expect(parseBar(RC_RAW_WARMUP).ramp_cap_pct_per_bar).toBeNull();
    expect(parseBar(RC_RAW_RAMP_CAP).ramp_cap_pct_per_bar).toBe(0.05);
  });

  it('量纲：ramp_cap_pct_per_bar = 每 bar 允许的目标变动金额 / 决策 bar 收盘净值（0.05 = 5%/bar）', () => {
    const limited = parseBar(RC_RAW_RATE_LIMITED);
    const cap = limited.ramp_cap_pct_per_bar;
    expect(typeof cap).toBe('number');
    // 占净值比 / bar ⇒ 落在 (0,1]；且本 bar 目标恰被限速压在 cap 上（cap_qty = pct_per_bar×equity/price）。
    expect(cap! > 0 && cap! <= 1, `cap=${String(cap)} 须为占净值比/bar`).toBe(true);
    expect(limited.target_pct, '限速态目标 == cap（同分母口径）').toBe(cap);
    expect(limited.rate_limited, '被压缩 ⇒ rate_limited=true').toBe(true);
    // 未受限的非预热 bar 同样声明 cap（预算存在但未用尽 ⇒ rate_limited=false）。
    const notLimited = parseBar(RC_RAW_RAMP_CAP);
    expect(notLimited.ramp_cap_pct_per_bar).toBe(cap);
    expect(notLimited.rate_limited).toBe(false);
  });

  it('可空依据：legacy run（1949 根）无 D7 三键（0/1949）⇒ 声明为可选；预热段策略为 null 而非 0', () => {
    const legacy = parseBar(LEGACY_RAW_1949);
    for (const key of ['ramp_cap_pct_per_bar', 'rate_limited', 'sell_transition'] as const) {
      expect(Object.prototype.hasOwnProperty.call(legacy, key), `legacy 须无 ${key}`).toBe(false);
      expect(legacy[key], `legacy 的 ${key} 须 undefined（不伪造零值）`).toBeUndefined();
    }
    expect(Object.prototype.hasOwnProperty.call(legacy, 'warmup'), 'warmup 在 legacy 载荷中也在').toBe(true);
    expect(legacy.warmup).toBe(true);
    // 预热段：策略未参与 ⇒ 预算字段为 null（**不得**读成 0 = 预算为零）。
    expect(parseBar(RC_RAW_WARMUP).ramp_cap_pct_per_bar).toBeNull();
  });
});
