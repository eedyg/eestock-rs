# 112 — P1a 修复包：strategy-core 评审 findings 修复（2 MAJOR + 5 MINOR + 4 NIT）

> 报告自身位置：`coder/report/112_strategy_core_p1a_review_fix.md`
> 权威依据：`design/12-strategy-system/01-adr.md` §13.1 增补四条口径（架构师已回写，未动 design/）；
> 对照报告：`coder/report/111_strategy_core_p1a.md`。
> 红线核验：未修改 design/；未动其他 crate（Cargo.lock 仅移除 strategy-core 的 serde_json 条目）；
> 零新外部依赖；既有断言零削弱（只有补强）。

## Finding → 修复 → 测试证据对应表

| Finding | 修复（代码向 ADR §13.1 对齐） | 测试证据（TDD：先 Red 后 Green） |
|---|---|---|
| **MAJOR-1** LumpSum 冻结口径 | `PolicyState` 新增 `lump_frozen: Option<f64>`：Buy 建立时按 equity×position_pct/price 快照冻结；Buy 持续期恒为冻结值；Hold→target=current 并解冻；Sell→0 并解冻；中断后首个 Buy 重新快照。另加 `clamp_lump_frozen()`（pub(crate)）：引擎在 Policy 买入成交后将冻结目标钳制到实际持仓（只降不升）——见「实现决策」① | 单测 `lump_sum_buy_freezes_target_against_equity_drift` / `lump_sum_hold_unfreezes_and_next_buy_resnapshots` / `lump_sum_sell_unfreezes` / `clamp_lump_frozen_caps_unreachable_target`；集成 `lump_sum_frozen_target_flat_no_fee_bleed`（评审反例：flat 10.0×10bar、pct=0.8、恒 80 分 → bar1 后全程无订单、净值持平）+ `lump_sum_frozen_target_rising_price_no_micro_sell`（涨价反例）+ `lump_sum_interrupted_buy_resnapshots_frozen_target`（中断后按新净值重新快照）。**旧实现上 3 个反例测试 FAILED（已实测）**，修复后全绿 |
| **MAJOR-2** 止损重置 PolicyState | 新增 `PolicyState::reset()`（DCA 批次/基线 + LumpSum 冻结全清零，与 trailing.reset() 对齐）；Intrabar 强平成交后立即 reset；CloseBasis 触发判定时 reset（强平挂单已排定，次 bar open 成交） | 单测 `policy_state_reset_clears_lump_freeze_and_dca`；集成 `stop_liquidation_resets_dca_state_close_basis`（评审反例：Dca{4,Equal,1}+CloseBasis FixedPct，强平后首个 Buy 订单 qty = nav/4/price ≈ 2.5k 股单批，非 10_000 一次性买回；bar7 继续第 2 批）+ `stop_liquidation_resets_dca_state_intrabar`（Intrabar 变体同理）。**旧实现上 2 个反例测试 FAILED（已实测）**，修复后全绿 |
| **MINOR-1** Intrabar ATR 前视 | engine 步骤 2 改为 `Indicators::new(bars, i.saturating_sub(1)).atr(14)`（i=0 → 数据不足不触发）；CloseBasis 路径保持含当前 bar（注释注明口径分工） | 集成 `stop_atr_intrabar_uses_atr_through_previous_bar`：14 根平稳 bar（ATR=1.0）+ 深跌 bar（TR=2.1 污染当 bar ATR）；断言 line_prev=8.0045 > low 7.9 > line_incl=7.847（仅未污染口径触发），止损于 bar14 当 bar 按 line_prev×(1−滑点) 成交。**旧实现 FAILED（已实测）**，修复后绿；既有 `stop_atr_close_basis_uses_atr14_line`（含当前 bar）保持绿 |
| **MINOR-2** gap-through 文档注明 | lib.rs「关键口径决策」新增条目：跳空破线仍按止损价×(1−滑点) 成交（ADR §13.3 字面口径），为有意接受的乐观偏差 | 文档项（ADR §13.1 备案），无行为变更 |
| **MINOR-3** parity 补强 | `e2e_buy_hold_force_close_fee_parity_with_backtest` 增补：TradeDetail 全字段（shares/commission/stamp_duty/hold_bars/gross_value + 既有字段）、drawdown 逐点、8 项绩效全字段与 backtest 引擎对照相等 | 同一测试内增补断言（只加强不削弱），全绿 |
| **MINOR-4** StrategySlot 不变量 | 字段私有化（私有 + `code()/code_hash()/params()/weight()` 访问器），唯一构造入口 `StrategySlot::new` 校验 weight>0 有限且 code/code_hash 非空；engine 改用访问器；run_ensemble **不禁空**（零 slot 合法，见 MINOR-5） | 既有单测 `slot_rejects_non_positive_weight` 等保持绿；新增 `zero_slots_neutral_50_no_orders` |
| **MINOR-5** 边界用例 | 新增 4 个集成测试（无实现变更） | `zero_slots_neutral_50_no_orders`（零 slot 全程中立 50/Hold/无订单/净值恒定）；`stop_configured_but_never_holding_is_noop`（配置止损全程零持仓守卫路径）；`stop_trailing_close_basis_next_open_fill`（Trailing×CloseBasis 组合：峰值 12→线 10.8，close 10.7 触发，次 bar open 成交）；Atr×Intrabar 即 MINOR-1 测试；DCA+止损即 MAJOR-2 两个测试 |
| **NIT-1** 移除 serde_json | Cargo.toml 删除 `serde_json.workspace = true`（全 crate 无使用）；Cargo.lock 同步 | `cargo build --workspace` 0 error；lock 中 strategy-core 依赖仅剩 backtest/serde/strategy-runtime |
| **NIT-2** 双跑补强 | `e2e_deterministic_double_run_pointwise_equal` 增补 `drawdown` 序列与逐 bar `events` 序列逐点相等断言 | 同一测试内增补断言，全绿 |
| **NIT-3** EnsembleConfig::validate() | 新增 `EnsembleConfig::validate()`：buy_threshold 严格大于 sell_threshold（且有限）、initial_capital 正有限、委托 policy.validate()（position_pct∈(0,1]、tranches≥1、FixedAmount amount）；`run_ensemble` 入口改调 `cfg.validate()` | 集成 `ensemble_config_validate_rejects_illegal_configs`：7 个非法配置全部 Err + 合法配置 Ok。**旧实现 FAILED（已实测）**，修复后绿 |
| **NIT-4** 性能冒烟断言 | 保留 `#[ignore]`，新增 `assert!(elapsed < 2s)`（实测 84.4ms，约 23x 余量防 flaky） | `cargo test -p strategy-core --test engine -- --ignored` 通过：84.4ms < 2s |

## 变更文件清单

| 文件 | 变更 |
|---|---|
| `crates/strategy-core/src/policy.rs` | PolicyState +`lump_frozen` 冻结态、`reset()`、`clamp_lump_frozen()`；LumpSum 分支冻结/解冻逻辑；模块文档更新；+5 单测 |
| `crates/strategy-core/src/engine.rs` | `EnsembleConfig::validate()`；run_ensemble 改调 cfg.validate()；Intrabar ATR 截至上一 bar；两条止损路径 `policy_state.reset()`；Policy 买入成交后 `clamp_lump_frozen`；StrategySlot 访问器改造；模块文档更新 |
| `crates/strategy-core/src/aggregate.rs` | StrategySlot 字段私有化 + 4 个访问器；不变量文档；单测改用访问器 |
| `crates/strategy-core/src/lib.rs` | 口径决策新增 4 条（冻结/止损重置/ATR 前视/gap-through 备案） |
| `crates/strategy-core/Cargo.toml` | 移除 serde_json |
| `crates/strategy-core/tests/engine.rs` | +10 集成测试；parity/双跑/性能冒烟 3 个既有测试断言补强 |
| `Cargo.lock` | strategy-core 依赖移除 serde_json（自动） |

## 架构对齐

全部变更落在 **Domain 层**（strategy-core 纯逻辑 crate 内部）：无 IO/DB/网络/时钟；未触碰
strategy-runtime/backtest 接口；未改任何跨 crate 契约。`PolicyState::reset()`/`clamp_lump_frozen()`
为本 crate 内部运行态 API（后者 pub(crate)），不影响 ABI。

## 实现决策（裁决口径内的落地细节）

1. **冻结 × 现金上限（affordability 钳制）**：ADR §13.1 字面口径「按 equity×position_pct/price
   换算股数并冻结」在 position_pct=1.0 时与既有费用 parity 红线存在张力——佣金使实得股数必然
   略小于冻结目标，若冻结值不下调，则每 bar 对不可达缺口重复挂微买单（同样构成费用出血）。
   处理：冻结值按 ADR 字面口径计算（决策时不折费），引擎在 Policy 买入成交后将冻结目标钳制到
   实际持仓（只降不升）。效果：pct=0.8 评审反例下冻结值即成交值（无需钳制）；pct=1.0 下与
   backtest 引擎逐点 parity 保持（既有对照测试未削弱且全字段补强后仍绿）。
2. **CloseBasis reset 时点**：触发判定当 bar（步骤 6）即 reset——止损挂单已排定且步骤 7 被
   stop_order 跳过，次 bar open 成交后 Policy 已是干净状态；与 Intrabar「成交即 reset」语义对齐。

## 验证（命令与结果）

- Red 证据：将 src 临时换回评审前版本，5 个反例测试（MAJOR-1×2、MAJOR-2×2、MINOR-1、NIT-3）
  全部 FAILED；恢复修复后全绿。
- `cargo test -p strategy-core` → **30 单测 + 23 集成全绿**（1 ignored）；
- `cargo test -p strategy-core --test engine -- --ignored` → 性能冒烟通过（84.4ms < 2s 硬断言）；
- `cargo clippy -p strategy-core --all-targets -- -D warnings` → **0 warning**；
- `cargo build --workspace` → **0 error**；
- `cargo test -p strategy-runtime` → 27 全绿（**零回归**）。

## 遗留风险

- 止损强平后同 bar 信号仍 Buy 会立即重新开始建仓（无冷却期）——ADR §13.3 职责边界口径，
  既有行为，测试已锁定；如需冷却期属新需求。
- DCA 路径在现金不足时仍会对缺口补单（accumulated 目标 > 实得）——MAJOR-1 裁决仅覆盖
  LumpSum 冻结口径，DCA 未在评审 findings 范围；极端资金耗尽场景可能产生零成交微单
  （与修复前行为一致，无回归）。
- gap-through 乐观偏差为备案口径（MINOR-2），极端跳空场景回测结果略偏乐观——已在 crate 文档注明。
