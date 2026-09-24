# 05-plan — `exposure × ramp × guard` Step 1 实施计划（ADR-029）

> **契约事实源（唯一出口）**：`design/01-architecture/adr/ADR-029-execution-policy-exposure-ramp-guard.md`（D1–D10、§4 验收口径）。
> **本批范围**：**Step 1 纯增量**——新增 `ExecutionPolicy::Exposure`（`Fixed|ScoreMapped` 目标 × `Immediate|RateCap` 路径 × `guard`）。**不改** `LumpSum`/`Dca` 语义（历史 run 逐字节可复现）。
> **JSON 命名约定**：沿用现行 serde 风格（**无 rename**）：变体 PascalCase（`Exposure`/`Fixed`/`ScoreMapped`/`Immediate`/`RateCap`/`Flat`/`Scaled`），字段 snake_case（`at_threshold_pct`…）。

```jsonc
{ "Exposure": {
    "target": { "Fixed": { "pct": 0.3 } }
           // | { "ScoreMapped": { "at_threshold_pct": 0.2, "at_full_pct": 0.8, "sell": "Flat" } }
    ,
    "ramp":   { "Immediate": null }
           // | { "RateCap": { "pct_per_bar": 0.05 } }
    ,
    "guard":  { "max_pct": 0.9, "min_pct": 0.0, "deadzone_pct": 0.005 }
} }
```

---

## 1. 判据表（Step 1）

| # | 判据 | 形态 |
|---|---|---|
| E1 | `ScoreMapped` **单调不减** + **端点精确** | `score=buy_threshold ⇒ at_threshold_pct`；`score=100 ⇒ at_full_pct`；区间内单调；分数先夹 `[0,100]` |
| E2 | `SellPolicy` 两支 | `Flat`：`score ≤ sell_threshold ⇒ 目标 0`；`Scaled`：对称降档至 `[0, at_threshold_pct)` |
| E3 | **中立带保持** | `sell_threshold < score < buy_threshold` ⇒ **保持上一目标**（穿越中立区零订单） |
| E4 | `guard.max_pct` **强制夹取** | 构造"分数要求满仓"⇒ `目标 ≤ max_pct` ∧ `clamped_by_guard=true`；策略无权覆盖 |
| E5 | `deadzone_pct` 死区 | `|Δ目标暴露| < deadzone_pct` ⇒ **零订单**（逐 bar 断言） |
| E6 | `RateCap` 速率 | 相邻 bar 目标变动 ≤ `pct_per_bar × equity`（含跳变极端用例）；**任一 bar 不得越过 target** |
| E7 | **强平 reset** | 硬止损/强平后路径与冻结状态全清（沿用现行裁决，与 `LumpSum/Dca` 同口径） |
| E8 | **旧变体逐字节复现** | `LumpSum`/`Dca` 在同一输入下与本 ADR 之前一致；并用真实 run 成交序列对照（`sr_1790169818677_000006`、`sr_1790247371321_000015`） |
| E9 | **防抖** | 分数抖动序列 ⇒ 下单次数 / 费用占净值比 ≤ 标定上限（不做"每 bar 微单"） |
| E10 | **观测/审计** | 每 bar `target_pct/current_pct/deadzone_blocked/clamped_by_guard` 可读；审计出现"意图 vs 实际暴露"差值 |
| E11 | **校验 fail loud** | `buy_threshold < 100 ∧ sell_threshold > 0`（`ScoreMapped` 分母非零）；`at_full_pct ≥ at_threshold_pct`；`0 ≤ min_pct ≤ max_pct ≤ 1`；`deadzone_pct ≥ 0`；`pct_per_bar > 0`；违规⇒构造报错（不得静默回退默认） |

---

## 2. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `crates/strategy-core/src/policy.rs` | 新增 `ExposureTarget{SellPolicy, ...}` / `RampSpec` / `GuardSpec` / `ExecutionPolicy::Exposure`；`validate()` 加 E11 全部规则；`target_qty` 增 **`score: f64`** 参数（旧变体忽略）；新增 `ExposureState{last_target_pct, ramp_used_this_bar…}` 与 `clamped_by_guard/deadzone_blocked` 输出 |
| `crates/strategy-core/src/engine.rs` | 把**聚合分**传入 policy；把 E10 观测字段写入既有 `per_bar` 记录（不新增事实表） |
| `crates/application/src/audit.rs` | 新增"意图（target_pct）vs 实际暴露"差值与**抖动指标**（下单次数/费用占净值比），形态沿用 `WARN_*` |
| `web/src/api/types.ts` | policy 联合类型补 `Exposure` |
| `web/src/features/workbench/ConfigPanel.tsx` | 新模式 UI（选择 exposure/ramp/guard、字段校验提示、映射端点说明） |
| 规格 | `crates/strategy-core` 单测矩阵（E1–E7、E11）；`engine` 观测（E10）；`audit` 新字段；`web` 单测 + e2e（配置与披露） |

---

## 3. 边界与异常

| 情形 | 行为 |
|---|---|
| `buy_threshold = 100` 或 `sell_threshold = 0` + `ScoreMapped` | **构造期 fail loud**（分母为 0，映射无定义） |
| `score` 越界（<0 / >100） | 先夹到 `[0,100]` 再映射 |
| `score` 缺失/`aggregate` 非有限 | 记中立 50（沿用 G5 口径）并**不动目标** |
| 目标因净值漂移而微变 | 走 `deadzone`（不下单）；`equity` 口径 = 决策 bar 收盘 |
| 现金不足 | 沿用现行 affordability 夹取；被夹时**披露**（不得静默） |
| `RateCap` 与目标反向 | 反向同样受 `pct_per_bar` 限制（不得跳变） |
| 硬止损触发 | 路径作废 + `reset()`；下个 Buy 周期重新计目标 |
| 无覆盖标的的 slot（聚合=50） | 沿用现行（不参与归一）⇒ 目标按 50 映射（`ScoreMapped` 下 = Hold 带 ⇒ 保持上一目标） |

---

## 4. 测试方案（TDD：先红后绿）

1. **单测矩阵**（`policy.rs`）：E1–E7、E11 逐条；含"分数序列 → 目标序列"的黄金序列（便于回归）。
2. **旧变体复现**（E8）：`LumpSum`/`Dca` 的既有单测**不得修改**且必须全绿；另加"真实 run 成交序列对照"（用归档的 fills 作为期望序列）。
3. **观测/审计**（E10）：engine 单测断言字段存在与取值；audit 单测断言新增告警/差值。
4. **防抖**（E9）：构造 ±5 分抖动 20 根 bar ⇒ 断言下单次数与费用上限（阈值先标定再写死）。
5. **真渲染**（web）：配置面板可选 `Exposure` 并提交成功；结果页/审计显示目标与披露；**旧配置（`LumpSum`/`Dca`）打开与运行不回归**。
6. **变异反证 ≥2**：①去掉 `max_pct` 夹取 ⇒ E4 必红；②去掉死区 ⇒ E5/E9 必红。

---

## 5. 门禁与流程

1. `cargo test -p strategy-core` / `-p application`；`npx tsc -b`；`npx vitest run`（不得新增红）；web e2e（配置与披露）。
2. `gitnexus impact`：`ExecutionPolicy`、`PolicyState::target_qty`、`classify`（聚合→信号）与 `audit` 新字段；提交前 `detect_changes(staged)`。
3. 独立复验（tester，自建探针）：E1–E11 抽查 + 旧 run 复现对照 + 变异反证复核。
4. 证据落**未跟踪**目录；**零 staged**（车道不得 `git add/commit`）；部署后冒烟（身份 + 旧配置不回归 + 新配置可跑）。

## 6. 回退
```bash
git checkout -- crates/strategy-core/src/policy.rs crates/strategy-core/src/engine.rs \
  crates/application/src/audit.rs web/src/api/types.ts web/src/features/workbench/ConfigPanel.tsx
# 文档回退：ADR-029、本文件、design/99-decisions-log.md 条目
```

## 7. 关联
ADR-029（契约）｜ADR-028 §13.1（冻结/reset 裁决）｜ADR-026（审计披露）｜ADR-024 D10（禁静默有损）｜`design/12-strategy-system/{01-adr,02-plugin-abi,04-strategy-programming-guide}.md`。
