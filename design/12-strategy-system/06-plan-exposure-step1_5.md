# 06-plan — `exposure` Step 1.5：意图一等公民 / 非对称速率 / 清仓豁免 / 收敛与成本披露

> **契约事实源（唯一出口）**：`design/01-architecture/adr/ADR-029-execution-policy-exposure-ramp-guard.md` §8（D11–D15、E18–E24）。
> **本文件是实施车道（coder/tester）的唯一施工图**：字段名、JSON 形态、pipeline 顺序、判据、文件清单以本文件为准；**车道不得自行发明语义**，有疑问回抛架构侧。
> **用户裁定（2026-09-29）**：①需要非对称速率；②`on_signal_break` 缺省 `Pause`（UI 新配置默认 `Continue`）；③清仓豁免死区；④收敛判据 + 残仓告警；⑤不新增"风控旁路"类型；⑥C1/C3/B3/D1 全部纳入本批。
> **兼容纪律（不可破）**：`LumpSum`/`Dca` 逐字节不变；**`Exposure` 历史 run（缺省新字段）逐字节不变**。本批全部新增项**缺省即现行语义** ⇒ **不引入 `schema_version`**。

---

## 1. 背景：本轮修复的 5 个已取证问题

| # | 问题 | 取证 |
|---|---|---|
| F1 | **只有"输出目标"有名字**：死区命中时 `target_pct ≡ current_pct` ⇒ 000007 的 1760/1818 根（96.8%）"目标"等于当前，**意图不可见** | `policy.rs:151-156, 668`；DB `per_bar` 实测 |
| F2 | **意图在 Hold 带被抹掉**：降档/清仓被信号时长截断 | 000023：bar 412 清仓意图 → bar 413（Hold）蒸发 → 残仓 0.25% 挂 13 根 bar → bar 427 由 **ForceClose 28.4 股/249.73 元**兜底 |
| F3 | **残仓 < 死区 ⇒ 结构性清不掉**：死区按"意图 gap"判定，清仓最后一段被吃掉 | 同上 |
| F4 | **下行速率不可配**：单 `pct_per_bar` 双向对称 ⇒ 清仓/降档无法比建仓快 | `policy.rs:655`；E6 反向断言 |
| F5 | **成本盲区**：`deadzone_pct` 不感知 `min_fee`；审计 CHURN 门限对"min_fee 主导的小额再平衡"无鉴别力 | 000007：51 笔微单、佣金 297.88 元 = 净利 **15.7%**、单笔实际费率 **0.80%**（名义 2.5bp 的 32 倍）；`orders_per_bar 0.032 / fee_pct 0.298%` **全绿** |

---

## 2. 契约（精确形态）

### 2.1 JSON（serde **无 rename**；变体 PascalCase、字段 snake_case）

```jsonc
{ "Exposure": {
    "target": { "ScoreMapped": { "at_threshold_pct": 0.2, "at_full_pct": 0.5, "sell": "Scaled" } },
    "ramp":   { "RateCap": {
                  "pct_per_bar": 0.05,
                  "down_pct_per_bar": 0.2,        // 新增；省略 = 对称（= pct_per_bar）；0 = 下行不限速
                  "on_signal_break": "Continue"   // 新增；省略 = "Pause"
              } },
    "guard":  { "max_pct": 0.9, "min_pct": 0.0, "deadzone_pct": 0.005,
                "deadzone_min_notional": 100.0 }  // 新增；省略 = None（= 现行比例口径）
} }
```

- `RampSpec::RateCap { pct_per_bar: f64, down_pct_per_bar: Option<f64>, on_signal_break: Option<OnSignalBreak> }`
  - `OnSignalBreak = Pause | Continue`（**只存在于 `RateCap`**：`Immediate` **恒取 `Pause`** —— 它在结构上无法携带该开关）。
    **更正（ADR-029 §8.3 R37）**：原表述「`Immediate` 的 Hold 带行为与 `Continue` 在中立带**等价**」**已作废**（`Continue` 重算**比例** vs `Pause` 冻结**绝对股数**，不等价）。
  - **序列化纪律**：`RampSpec` 为手写 `Serialize/Deserialize`（契约唯一形态）⇒ `RateCapPayload` 两个新字段用 `#[serde(default)]` + `skip_serializing_if = "Option::is_none"` ⇒ **旧形态 `{"RateCap":{"pct_per_bar":x}}` 解析与产出逐字符不变**。
- `GuardSpec { max_pct, min_pct, deadzone_pct, deadzone_min_notional: Option<f64> }`（元；`#[serde(default)]`）。

### 2.2 三层语义（D11；命名即契约）

| 层 | 名字 | 定义 | 落库 |
|---|---|---|---|
| **意图** | `intent_pct` / `intent_qty` | 本 bar 「分数映射 + guard 夹取」后**想持有**的水位（pipeline P1–P3） | **新增** `per_bar[].intent_pct` |
| **输出目标** | `target_pct` / `target_qty` | 意图再经「路径推进 → affordability → 死区 → 限速」后**本 bar 下达**的目标（P4–P8） | 既有 `per_bar[].target_pct`（**语义不变**：死区命中 ⇒ = `current_pct`） |
| **实际持仓** | `current_pct` | 次 bar open 成交后的持仓 | 既有 `per_bar[].current_pct` |

**不变式（可测）**：`|intent_pct − target_pct|` 的差**只能**来自 {affordability 下调、死区拦截、限速未走完、`Pause` 冻结}；否则判错。

### 2.3 档位与意图求值（P1–P3）

- Buy 档（`score ≥ buy_threshold`）：`intent_pct = clamp(at_threshold_pct + (s−buy)/(100−buy)·(at_full−at_threshold), guard)`。
- Sell 档（`score ≤ sell_threshold`）：`Flat ⇒ 0`；`Scaled ⇒ clamp(at_threshold_pct·s/sell_threshold, guard)`。
- **Hold 带（`sell_threshold < s < buy_threshold`）**：**沿用上一个非 Hold bar 的 `intent_pct`**（不因净值/价格漂移重算）；首个评估 bar 即 Hold（无上一意图）⇒ `intent_qty = current_qty`（零订单）。
- `Fixed`：意图 = `lump_target` 的输出（Buy ⇒ 冻结名义额 / Sell ⇒ 0 / Hold ⇒ 见 2.4）。
- 分数先夹 `[0,100]`；非有限 ⇒ 中立 50；`price/equity` 非法 ⇒ `intent_qty = current_qty`（防御不造数）。

### 2.4 路径推进（P4；D12）

`anchor = 上一输出目标股数`（首 bar = 当前持仓）。

| 本 bar 档位 | `Pause`（缺省；= 现行） | `Continue` |
|---|---|---|
| Buy / Sell（**有新声明**） | `desired = intent_qty` | `desired = intent_qty` |
| Hold（**无新声明**） | `ScoreMapped`：`desired = anchor`（冻结绝对股数，R5）<br>`Fixed`：现行 `lump_target` Hold 语义（**解冻**，`desired = current`） | `desired = intent_qty`（继续走完）；`Fixed` **不解冻**（保留冻结目标继续推进） |

**`Immediate` 的 `on_signal_break`（2026-09-29 更正）**：`Immediate` **无该字段**，**恒取 `Pause` 语义**（= 现行）。
本文件原表述“`Immediate` 的 Hold 带行为与 `Continue` 等价”**不成立**：`Continue` 会把意图**比例**按当前净值重算，与 E3 钉死的“绝对股数冻结”不同。为守住 E3/E13/E19④ 的兼容铁律，该开关**只在 `RateCap` 内**存在（见 ADR-029 §8.3 **R37**，架构侧已追认）。

限速预算（金额口径，`equity` = 决策 bar 收盘净值）：

```
上行预算 = pct_per_bar        × equity / price
下行预算 = down_pct_per_bar.unwrap_or(pct_per_bar) × equity / price
   · down_pct_per_bar = 0 ⇒ 下行无预算（本 bar 可直接落到 desired，**仍不得越过 desired**）
step = clamp(desired − anchor, −下行预算, +上行预算)      // Immediate ⇒ step = desired − anchor
rate_limited = step != (desired − anchor)
```

### 2.5 可达性 / 死区 / 输出（P5–P8；顺序即契约）

```
P5 affordability（仅 ScoreMapped，只降不升，沿用现行）→ desired 下调
P6 死区：|desired − current| × price < max(deadzone_pct × equity, deadzone_min_notional ?? 0)
        ⇒ 命中（deadzone_blocked）
   ★ 豁免（D13/E20；**2026-09-29 收口**）：仅当 **`desired == 0.0` ∧ `current_qty > 0.0`**（**正在朝清仓推进且仍有残仓**）
      ⇒ 死区**不适用**（不置 deadzone_blocked）。
     **为何要加 `current_qty > 0`**：独立复验（V1）实测，若只看 `desired == 0`，则“已空仓且锚点=0”的中立带 bar 会由 `deadzone_blocked=true` 翻为 `false`
     （000023 104/178 bar、000025 10/178 bar，仅**观测位/审计计数**变而成交不变；伴生审计计数 **168→64**（Δ=−104）/ **169→159**（Δ=−10）——**读数更正**：首轮复验曾记「168→143」，该数与 104 处翻转算术上不可同真，已作废）⇒ 破坏历史 run 的**观测级**复现。加上该条件后：
     无残仓 ⇒ 无单可下 ⇒ 保留旧观测（逐字节一致）；有残仓 ⇒ 豁免生效（F3 修复仍然成立）。
P7 限速（见 2.4）
P8 输出目标 = 死区命中 ? current_qty : (affordability_capped ? min(ramped, desired) : ramped)
```

**注（量纲披露，不得当作缺陷修改）**：死区是**意图 gap 门**，**不是订单规模下限**——限速可把单笔订单切到死区之下（E12 有意钉死）。`deadzone_min_notional` 只抬高**门槛**，不改变这一点；配置处文案必须写明。

### 2.6 观测键增补（`per_bar`）

新增（均为 `Option`，预热段 / 旧 run / 非 Exposure ⇒ `null`）：

| 键 | 含义 |
|---|---|
| `intent_pct` | 本 bar 意图占净值比（死区/限速**不**影响它） |
| `down_ramp_cap_pct_per_bar` | 本 bar **下行**速率预算占净值比（`RateCap` 时 = `down_pct_per_bar ?? pct_per_bar`；`Immediate`/预热 ⇒ `null`） |

**镜像纪律**：`per_bar` 键集被 `web/src/api/perBarObservationKeys.test.ts` 冻结 ⇒ 本批须**成对**更新该测试与 `web/src/api/types.ts`（新增键 + 既有键注释口径）。

---

## 3. 审计与披露（D14/D15；用户裁定 C1/C3/B3/D1 全纳入）

### 3.1 结构化出口（新）

`GET /api/workbench/runs/{id}/audit` 响应**新增一个键** `exposure`（追加在 `warnings` 之后，键序其余不变）：

> **线上键数 = 17**（消歧，2026-09-29）：`ExposureAudit.warnings` 为**结构内字段但不序列化**（`#[serde(skip_serializing)]`，告警已合并进顶层 `warnings[]`）
> ⇒ **线上 payload 恰好是本节样例的 17 键**；结构体字段数为 18。「18 键」指结构体字段，不得据以臆造第 18 个线上键。

```jsonc
"exposure": {                       // 非 Exposure 策略 / 无观测 / recorded=false ⇒ null
  "bars": 1810,                     // 参与统计的评估段 bar 数（有观测者；不含预热）
  "orders": 58, "orders_per_bar": 0.0319,
  "fees": 297.8804660338809, "fee_pct": 0.0029788,        // fee_pct = fees / capital_basis
  "nominal_fee_rate": 0.00025,      // FeeModel.rate_pct/100；无成交额 ⇒ null
  "cost_amplification": 32.0,       // all_fills 口径 = (Σcommission/Σ成交额) / 名义费率；000007 实测 12.77（仅 Policy 成交则 ≈18.8）；32.0 仅为示意
  "max_target_gap": 0.010216, "max_target_gap_bar": 1599, // 执行层：max_t |target_pct_t − current_pct_{t+1}|
  "max_intent_gap": 0.0031, "max_intent_gap_bar": 1234,   // 意图层：max_t |intent_pct_t − current_pct_{t+1}|
  "unmet_intent_bars": 12,          // |intent_pct_t − target_pct_t| > deadzone_pct 的 bar 计数
  "clamped_bars": 0, "deadzone_blocked_bars": 1760, "rate_limited_bars": 6,
  "sell_transition_bars": 0, "affordability_capped_bars": 0
}
```

- **改名（Rust 内部 + 结构化段）**：既有 `ExposureAudit::max_intent_gap`（实为执行层口径）**改名为 `max_target_gap`**；**新** `max_intent_gap` 是意图层口径。**告警码 `EXPOSURE_INTENT_GAP` 的名称与语义保持不变**（对外稳定），message 文本改为显式标注"输出目标 vs 实际"。
- **不可判口径（可空，不造数）**：`max_intent_gap*` / `unmet_intent_bars` 在「无意图观测（旧 run）」**或**「有意图数据但取不到 `deadzone_pct`（策略快照不可解析）」时为 `null`；依赖它们的告警**不得触发**。
- 两个**冻结镜像测试成对更新**（属**有意**变更，须在测试注释里写清"新增键 + 其余键序/值不变"）：`crates/application`（`report_serializes_frozen_field_names`）+ `crates/web/tests/adr026_run_audit.rs`（`assert_audit_key_order` / `assert_audit_shape`）。

### 3.2 告警码（全部经既有 `warnings[]`，数值入 message）

| 码 | 触发条件 | 说明 |
|---|---|---|
| `EXPOSURE_INTENT_GAP`（既有，语义不变） | `max_target_gap > 0.05` | 执行层：输出目标 vs 实际 |
| **`EXPOSURE_UNMET_INTENT`（新）** | `max_intent_gap > 0.05` | 意图层：**声明意图未被达成**（限速/affordability/`Pause` 冻结均可致）；message 须点明 `on_signal_break` 口径（`Pause` 下"停在中途"属**预期**但必须披露） |
| **`EXPOSURE_RESIDUAL_INTENT`（新）** | 评估段**末根**满足 `intent_pct == 0.0 ∧ current_pct > 0.005` | 残仓被"收尾强平"兜底 ⇒ 清仓意图未达成（message 含残仓比例与股数） |
| **`EXPOSURE_COST_DRAG`（新）** | `cost_amplification ≥ 10 ∧ fee_pct ≥ 0.0005` | `min_fee` 主导的小额再平衡（既有 CHURN 门限抓不到） |
| `EXPOSURE_CHURN`（既有） | 不变 | — |

- MCP 工具描述同步：`crates/mcp/tests/adr029_warning_codes_description_drift.rs` 须把 3 个新码纳入（该测试即漂移门禁）。

**残仓股数口径（2026-09-29 裁决，消歧；`per_bar` **无**股数字段 ⇒ 不得凭空造）**：
1. **主口径 = 收尾强平成交量**：`Σ signed qty over fills where reason == ForceClose`（要清掉的那一份；与 `current_pct` 同源同时刻）。
2. **降级口径（仅当主口径不可得或为 0）**：`Σ signed qty over fills where bar_index < 末根观测 bar 的 per_bar 下标`（=「进入末根 bar 时持仓」）。
3. 二者皆不可得 ⇒ message 明写「**股数不可得**」（不填 0、不省略）。
4. message 必须注明所用口径；两口径可得且不等时**两个都写**（披露优先）。

**测试口径补充**：E22 正触发必用**构造**（真实 000023 末根 `current_pct=0.002496 < 0.005` 不触发，阈值 0.005 为契约值不可改），并**另加负向判据**：真实 000023 读数 ⇒ 不触发（防阈值被偷偷放宽）。

---

## 4. 判据表（E18–E24；TDD 先红后绿）

| # | 判据 | 形态（可测断言） | 变异反证 |
|---|---|---|---|
| **E18** | 非对称速率 | 上行用 `pct_per_bar`、下行用 `down_pct_per_bar`（缺省对称）；**逐 bar** 断言"相邻目标变动折算金额 ≤ 对应方向预算"且**不越过 desired**；`down_pct_per_bar=0` ⇒ 单 bar 直达 desired（仍不越过） | 把下行改成上行预算 ⇒ 必红 |
| **E19** | 意图一等公民 + `on_signal_break` | ①`intent_pct` 三态正确（Buy/Sell/Hold 沿用）；②`Pause`：中立带输出冻结（绝对股数）且 `intent_pct` 仍披露未达成意图；③`Continue`：**单根 bar** 的降档信号 ⇒ 后续中立带继续推进，在 `⌈Δ/预算⌉+1` 根内到达 intent；④**缺省（无新字段）⇒ 订单序列与现行逐字节一致** | 把 Hold 分支的 `Continue` 改成 `Pause` ⇒ ③ 必红 |
| **E20** | 清仓豁免死区 | `desired == 0` 时即使 `|gap| < deadzone` 也必须产单并逐 bar 逼近 0；**非清仓**情形死区行为不变（复跑 E5/E9 全绿） | 去掉豁免 ⇒ 必红 |
| **E21** | 收敛判据（4 分句） | a) 清仓意图持续 K ≥ `⌈w/下行预算⌉` ⇒ **含尾段**在 ≤ 该值+1 根内到 **0**；b) 降档至 `w₁` 持续 K ⇒ 到 `w₁`（±死区）；c) `Continue` 下单根信号 ⇒ 仍须在 `⌈Δ/预算⌉+1` 根内到达；d) `Pause` 下 ⇒ **断言"停在中途"是契约行为**且 `intent_pct` 披露未达成（负向判据，防把 Pause 实现成 Continue） | 把 `Continue` 的分句 c 改成 Pause 语义 ⇒ 必红 |
| **E22** | 残仓披露 | 末根 `intent_pct == 0 ∧ current_pct > 0.005` ⇒ 必出 `EXPOSURE_RESIDUAL_INTENT`；否则不出 | 去掉判据 ⇒ 必红 |
| **E23** | 成本感知 | `deadzone_min_notional` 生效（阈值 = `max(deadzone_pct×equity, min_notional)`）；缺省 `None` ⇒ 与现行逐字节一致；`cost_amplification` 计算正确；用 **000007 真实读数**构造 ⇒ `EXPOSURE_COST_DRAG` 必触发（同一构造下既有 CHURN **不**触发，证明新码有鉴别力） | 把 amplification 恒置 1 ⇒ 必红 |
| **E24** | 结构化出口 | `/audit` 新增 `exposure` 段：Exposure run ⇒ 全字段与真值一致；`LumpSum`/`Dca` run ⇒ `null` 且**其余键序不变**；两个镜像测试**成对**更新 | 把 `exposure` 恒置 null ⇒ 必红 |
| **E8′** | **历史复现（回归门禁）** | 用**归档真实 run** 的 config 快照重跑：`Exposure`（000007/000023/000025 三种形态）+ `LumpSum` + `Dca` ⇒ **成交序列 sha256 逐字节一致**。**范围界定**：D12 三项**缺省即现行**；D13（清仓豁免）是**有意的行为修复**，其**成交**影响面 =「清仓意图（`desired==0`）被死区拦 ∧ 残仓 > 0」的 bar —— 对现存全部 **67** 个 `Exposure` run 实测 **0 个**（扫描：`coder/evidence/20260929_adr029_step1_5_arch/raw/11_d13_impact_scan.{sh,txt}`） | — |
| **E25（新，2026-09-29 复验收口）** | **观测级历史复现** | 同 E8′ 的重放，额外要求 **`per_bar` 逐 bar 全键一致**（**键序无关** —— 本批观测键插入位置有变，原始 JSON 文本新旧不等；以原始文本 sha256 作门禁者须先规范化排序）（唯一允许的差异 = 新增的 2 个观测键 `intent_pct`/`down_ramp_cap_pct_per_bar`）+ `net_value`/`drawdown`/`position` 逐字节一致。<br>**动因**：首轮复验实测 `deadzone_blocked` 在旧配置上 **104+10** bar 翻转（仅观测位/审计计数变、成交不变）⇒ 缺口由 D13 条件收口（增设 `current_qty > 0`），并由本条判据锁死 | 去掉 `current_qty > 0` 条件 ⇒ E25 必红（旧配置观测位又翻转） |

---

## 5. 车道划分与文件清单

> **纪律**：一写者一处（同一 cwd 串行）；**车道不得 `git add`/`git commit`**；证据落**未跟踪**目录 `coder/evidence/<date>_adr029_step1_5/raw/`；报告落 `coder/report/`。

### Lane A（Rust core；`crates/strategy-core`）
| 文件 | 改动 |
|---|---|
| `src/policy.rs` | `RampSpec::RateCap` 增 `down_pct_per_bar`/`on_signal_break`（手写 serde 载荷同步）；`GuardSpec` 增 `deadzone_min_notional`；`OnSignalBreak` 枚举；`ExposureState` 增 `last_intent_pct`；`exposure_outcome` 按 §2.2–2.5 重排为 P1–P9（**保序**）；`PolicyObservation` 增 `intent_pct`/`down_ramp_cap_pct_per_bar`；`validate()` 补 E18/E23 规则（`down_pct_per_bar ≥ 0` 有限；`deadzone_min_notional ≥ 0` 有限） |
| `src/engine.rs` | 观测键透传（`bar_record_json` 路径由 Lane B 负责，core 只保证 `PolicyObservation` 字段齐全） |
| `tests/` + `src/policy.rs` 单测 | E18–E21、E23（core 部分）、E8′ 对照 |

### Lane B（Rust application / MCP）
| 文件 | 改动 |
|---|---|
| `crates/application/src/audit.rs` | `ExposureAudit` 字段改名/新增（§3.1）；`exposure_from_per_bar` 读新键；新告警 3 码；`compute_audit` 组装 |
| `crates/application/src/workbench.rs` | `bar_record_json` 输出新键；`/audit` 响应带 `exposure` 段 |
| `crates/web/src/workbench.rs` | 响应 DTO 若需（`RunAudit` 序列化） |
| `crates/mcp/tests/adr029_warning_codes_description_drift.rs` + 工具描述 | 3 个新码同步 |
| 测试 | E22、E24、`crates/web/tests/adr026_run_audit.rs` 成对更新 |

### Lane C（Web；依赖 A 的键名与 B 的段形态）
| 文件 | 改动 |
|---|---|
| `web/src/api/types.ts` | `GuardSpec.deadzone_min_notional?`、`RateCap.down_pct_per_bar?`/`on_signal_break?`、`perBar` 两新键、审计 `exposure?` 段类型 |
| `web/src/features/workbench/ConfigPanel.tsx` | 新字段 UI + 校验 + **UI 新配置默认 `Continue`** + 成本提示（`deadzone_pct × 初始资金 < 20 × min_fee` ⇒ 提示并提供一键预填 `deadzone_min_notional = 20 × min_fee`） |
| `web/src/features/workbench/ResultView.tsx` | 披露升级：`意图 / 输出目标 / 当前持仓` 三读数 + 末根未达成意图 + 审计 `exposure` 段（死区占比、`cost_amplification`、`unmet_intent_bars`） |
| `web/src/api/perBarObservationKeys.test.ts` + e2e | 键集镜像更新 + 配置/披露真渲染 |

---

## 6. 门禁与流程

1. **TDD**：每条判据先写红（含失败证据）→ 最小实现 → 全绿；**不得**为了变绿改判据。
2. `cargo test -p strategy-core -p application -p web`；`cargo clippy`；`cd web && npx tsc -b && npx vitest run`；e2e（配置 + 披露 + 旧配置不回归）。
3. `gitnexus impact`（`ExecutionPolicy` / `RampSpec` / `GuardSpec` / `PolicyState::target_qty_with_score` / `exposure_audit` / `compute_audit`）+ 提交前 `detect_changes(staged)`。
4. **独立复验（tester）**：E18–E24 抽查 + **E8′ 真实 run 复现对照** + **变异反证复核** + 证据纪律（落盘路径不得污染已跟踪文件）。
5. **部署后冒烟**：重建 `:8081` 后端并重启 → 真跑一次"降档/清仓" run（`Continue` + `down_pct_per_bar`）⇒ 残仓由**策略**清干净（非 ForceClose）；旧配置 run 不回归。
6. 证据落未跟踪目录；提交用**显式文件清单**；提交前自检 `git diff --cached --name-only | grep -E '^(coder|tester)/'` 为空。

## 7. 回退

```bash
git checkout -- crates/strategy-core/src/policy.rs crates/strategy-core/src/engine.rs \
  crates/application/src/audit.rs crates/application/src/workbench.rs \
  crates/web/tests/adr026_run_audit.rs crates/mcp/tests/adr029_warning_codes_description_drift.rs \
  web/src/api/types.ts web/src/api/perBarObservationKeys.test.ts \
  web/src/features/workbench/ConfigPanel.tsx web/src/features/workbench/ResultView.tsx
# 文档回退：ADR-029 §8、本文件、design/99-decisions-log.md 条目
```

## 8. 关联

ADR-029 §8（D11–D15 / E18–E24）｜ADR-029 D2/D10（兼容纪律）｜ADR-028 §13.1（冻结/reset）｜ADR-026（审计披露与镜像冻结）｜ADR-024 D10（禁静默有损）｜`design/12-strategy-system/05-plan-exposure-ramp-step1.md`（Step 1 契约）。
