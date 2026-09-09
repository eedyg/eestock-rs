# 114 — strategy-core P1b 小修复包（reviewer findings，4 项）

- **报告位置**：`coder/report/114_strategy_core_p1b_fixpack.md`（本文件）
- **范围**：crates/strategy-core 内 4 项 review 修复（MAJOR-1 / NIT-1 / NIT-2 / NIT-3），严格 TDD。
- **红线遵守**：未改 design/；未动 strategy-runtime/backtest；无新依赖（Cargo.toml 零改动）；未削弱任何既有断言。

## MAJOR-1 测试假覆盖（变异测试证据）

`tests/templates.rs::two_state_gate_scores_gated_by_position`：旧 bars (0..20) 下 slow MA(20) 首次可
用于 bar19，`first_80=19` → `skip(21)` 零迭代，门控断言形同虚设。

变异测试三步证据（TDD Red→Green）：

| 步骤 | two_state_gate.js | 测试代码 | 结果 |
|------|-------------------|----------|------|
| 1 | 原版（持仓 `trendUp ? 50 : 20`） | 旧 bars (0..20) | 绿（基线） |
| 2 | **变异：持仓分支恒 `return 80`** | 旧 bars (0..20) | **仍绿 → 假覆盖证实** |
| 3 | 变异保留 | bars (0..40) + 守卫断言 | **红：`持仓期（bar21）应为中立分 50（门控），实际 80`** |
| 4 | 还原模板 | 修复后测试 | 绿（3/3 templates 测试通过） |

修复内容：bars 改 `(0..40)`（门控区间 19 次迭代）+ 防空转守卫
`assert!(first_80 + 2 < scores.len(), ...)`（区间为空即 fail，杜绝再次假覆盖）。模板文件已还原，
工作区与 staged 版本逐字节一致。

## NIT-1 atr_multiplier 越界注释

`tests/equivalence.rs::atr_channel_equivalence_channel_exit` 的 `atr_multiplier: 100.0` 注释补充
「有意越界（schema max 5.0）：运行时透传不 clamp（ABI §1 NIT-6 口径）」。纯注释，无语义改动。

## NIT-2 cargo fmt

`cargo fmt -p strategy-core` 消除多余空白/换行（equivalence.rs 及 fmt 顺带规范的
src/{aggregate,engine,lib,policy,stop}.rs、tests/engine.rs——纯格式化，零语义改动）。
`cargo fmt --check -p strategy-core` 通过。

## NIT-3 load() 防御统一（TDD）

4 款插件 load() 补与 dual_ma/boll 一致的字段类型守卫（`state || {}` + `typeof`/`Array.isArray`
检查，缺失/类型错误回退 init() 安全默认）：

- `macd.js`：原 `emaFast = state.emaFast` 等裸赋值（undefined→NaN 污染源头）→ 全字段守卫
  （数值回退 0、prevGt 非布尔回退 null）。
- `kdj.js`：k/d 裸赋值 → 守卫（回退 50 种子）；highs/lows 补 `Array.isArray`。
- `momentum.js`：highs/lows 补 `Array.isArray`（原 `state.highs ?` 对非数组真值不设防）。
- `atr_channel.js`：highs/lows 补 `Array.isArray`；entry 沿用数值守卫。

**新增测试**（先红后绿）：`tests/equivalence.rs::macd_load_corrupted_snapshot_falls_back_to_safe_defaults`
- 损坏快照 A（类型全错：布尔/数组顶替 emaFast/emaSlow/dea/seen，数值顶替 prevGt）；
- 损坏快照 B（字段全缺失：kdj 快照灌入 macd）；
- 断言：load 不报错、逐 bar 分数有限（无 NaN）、与全新实例评分序列逐点一致
  （golden bars 基线含金叉 80/死叉 20，确保对照非平凡）。
- 损坏快照由真实 `save()` 输出经 `Value` 方法改造构造，**未新增 serde_json 依赖**。
- Red 证据：修复前 `类型全错 bar1 ... got=50 fresh=80`（NaN 污染致金叉丢失）；修复后绿。

## 变更文件清单

| 文件 | 改动 |
|------|------|
| crates/strategy-core/tests/templates.rs | MAJOR-1：bars 0..40 + 防空转守卫 |
| crates/strategy-core/tests/equivalence.rs | NIT-1 注释 + NIT-3 新测试 + fmt |
| crates/strategy-core/reference-plugins/macd.js | NIT-3 load() 守卫 |
| crates/strategy-core/reference-plugins/kdj.js | NIT-3 load() 守卫 |
| crates/strategy-core/reference-plugins/momentum.js | NIT-3 load() 守卫 |
| crates/strategy-core/reference-plugins/atr_channel.js | NIT-3 load() 守卫 |
| crates/strategy-core/src/{aggregate,engine,lib,policy,stop}.rs, tests/engine.rs | NIT-2 fmt 纯格式化 |
| crates/strategy-core/reference-plugins/templates/two_state_gate.js | 变异探针已还原（无净改动） |

## 验证

- `cargo test -p strategy-core`：76 passed / 0 failed（unit 32 + engine 23(1 ignored) + equivalence 18 + templates 3）。
- `cargo clippy -p strategy-core --all-targets`：0 warning，exit 0。
- `cargo fmt --check -p strategy-core`：通过。
- 已 `git add`（未 commit）。

## 架构对齐

全部改动位于 Domain 层 strategy-core 的测试与参考插件资产内；load() 守卫属插件内部防御性
编程（ABI G3 快照恢复的实现细节），不触碰 Port/trait/事件契约，无架构决策。
