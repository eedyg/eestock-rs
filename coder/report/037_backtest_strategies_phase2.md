# 037 — backtest 策略 Phase 2：补全 7 款内置策略 + 编译期注册表

> 本报告位置：`eestock-rs/coder/report/037_backtest_strategies_phase2.md`
> 任务：在 `crates/backtest/`（Phase 1 已建）基础上，将第 1 款双均线之外补全 6 款内置策略，并把 `builtin_strategies()` 打通为编译期注册表（恰好 7 款）。权威依据 `design/08-backtest/01-engine-adr.md` §5（7 款名单）+ `06-web/05-backtest.md`（`builtinStrategyCount: 7`）。TDD，**不 commit、不暂存**。

## 父级审批（架构口径）

Phase 2 启动时发现 `builtin_strategies()` 的返回类型与 Phase 1 实现冲突（Phase 1 为 `Vec<StrategyResult>`，任务文本为 `Vec<Box<dyn Strategy>>`）。经父级 Architecture 批复采用 **C 方案（按职责清晰命名）**：

| 入口 | 签名 | 职责 |
|---|---|---|
| `builtin_strategies()` | `Vec<Box<dyn Strategy>>` | **运行时实例**（恰好 7、默认参数、固定顺序；供 `Engine::run`） |
| `builtin_strategy_catalog()` | `Vec<StrategyResult>` | **UI 目录**（id/name/description/params_schema；供 `GET /api/backtest/strategies` 下拉渲染） |
| `create_strategy(id, params)` | `Option<Box<dyn Strategy>>` | **运行时工厂**（按 id + 参数构造；参数网格展开时逐格构建） |
| `builtin_strategy_ids()` | `Vec<&'static str>` | id 清单（恰好 7、唯一） |

要点（父级批准）：catalog 与 runtime 的 id **一一对应、顺序一致（7×7）**；两者 `params_schema()` 一致。`params` 类型父级未指定，本实现用自包含 `ParamValue{Num(f64)|Choice(String)}` + `StrategyParams`（无第三方依赖），与 `ParamKind::Num/Choice` 对应。

## 一、策略清单（ADR §5 名单，顺序固定）

`BUILTIN_ORDER = ["dual_ma","ma_rsi","macd","boll","kdj","momentum","atr_channel"]`

| # | id | 名称 | 信号逻辑 | 参数 schema |
|---|---|---|---|---|
| 1 | `dual_ma` | 双均线交叉（Phase 1 保留） | 快线(MA)上穿慢线金叉 Buy / 下穿死叉 Sell | fast,slow,position_pct |
| 2 | `ma_rsi` | 均线+RSI 过滤 | 金叉且 RSI<超买线 Buy；死叉且 RSI>超卖线 Sell（RSI 不足时按通过） | fast,slow,rsi_period,rsi_oversold,rsi_overbought,position_pct |
| 3 | `macd` | MACD 金叉/死叉 | DIF 上穿 DEA 金叉 Buy / 下穿死叉 Sell | fast,slow,signal,position_pct |
| 4 | `boll` | BOLL 带突破 | 收破上轨 Buy、下破下轨 Sell（`mode=trend` 默认）/ 均值回归反转（`mode=mean_reversion`） | period,k,mode,position_pct |
| 5 | `kdj` | KDJ 金叉/死叉 | K 上穿 D 金叉 Buy / 下穿 Sell | n,k_period,d_period,position_pct |
| 6 | `momentum` | 动量突破 | close 突破前 N 日最高 high Buy / 跌破最低 low Sell | lookback,position_pct |
| 7 | `atr_channel` | ATR 通道突破 | Donchian 通道突破 Buy/Sell；持仓时 `close<entry−ATR倍数×ATR` 止损 | channel_period,atr_period,atr_multiplier,position_pct |

**每款均含 ≥1 个 `Num` 参数**（供网格「起:止:步长」展开；`registry_schema_has_grid_expandable_num_params` 已锁）。BOLL 另有 `Choice` 参数 `mode`（trend/mean_reversion），并含 `Num` 参数 period/k。

## 二、编译期注册表（策略模块实现）

- `builtin_strategies()` → `BUILTIN_ORDER` 逐一 `create_strategy(id, empty)` 得 7 个默认实例（运行 `Engine::run` 用）。
- `builtin_strategy_catalog()` → 各默认实例 `id()`/`params_schema()` + 静态 `name_description(id)` → `StrategyResult`（下拉+参数表单渲染）。
- `create_strategy(id, params)` → 按 id match 构造带覆盖参数的实例；未知 id 返回 `None`。
- `builtin_strategy_ids()` → `BUILTIN_ORDER.to_vec()`。

catalog 与 runtime 顺序一致、schema 一致，均有单测锁死（见 §五）。

## 三、ADR 口径落地（自定/需父级确认）

**按 ADR 或父级推荐落地**：
- **BOLL `mode` 默认 `trend`**（收破上轨 buy/下破下轨 sell = 突破/趋势；ADR §5「上轨买/下轨卖」读法）。并存 `mean_reversion`（收破下轨 buy / 回中轨上方 sell）供均值回归用户。**口径歧义点**：`06-web/05-backtest.md` 策略表把 BOLL 单列为「均值回归（触下轨买/回中轨卖）」，与 ADR §5 的名单读法不同；按父级权威「design/08-backtest/01-engine-adr.md §5（7 款名单）」取 trend 为默认，并用 `mode` 暴露两种语义。**请父级确认默认取 trend 是否 OK。**
- **动量/ATR 通道的 Donchian 上/下轨**：取「当前 bar 之前」`lookback/channel_period` 根 bar 的最高 high/最低 low（**不含当前 bar**，否则 close ≤ 当前 high 永不破位）。**无新增指标**：各策略自持 `VecDeque` 固定长度滚动窗口计算，故不改 `indicators.rs`（符合「若需新指标再按 ADR 补」——此处无需补）。
- **ATR 止损**：持仓时若 `close < entry − atr_multiplier×ATR` 触发 Sell；`entry` 取 Buy 信号当根 close（**近似**，实际成交在下一 open）。止损优先于通道下轨平仓。
- **均线+RSI**：金叉（fast>slow 且前一 bar 未满足）且 RSI<超买线才 Buy；死叉且 RSI>超卖线才 Sell；RSI 数据不足（`index<period`）时按通过（`is_none_or`）。均线用 `ind.ma`（SMA，与 Phase 1 DualMa 一致）。

**在 ADR 简化模型内自定并标注**：
- `create_strategy` 的 `params` 类型为 `HashMap<String, ParamValue{Num|Choice}>`（父级未指定；此处自包含、无新依赖）。
- 数值参数经 `as usize` 截断；网格展开传入整数即可。
- 小数股/整手/T+1 撮合仍沿用 Phase 1 简化（ADR §4）。

## 四、可复现性说明（用户要求）

**所有策略单测完全确定/可复现**：
- 数据来源 = **手工构造固定 bar 序列**（每个 bar 的 `ts/open/high/low/close` 均为显式字面量，见各测试体内 `bar(...)`）。
- 参数 = **显式固定**（`Strategy::new(...)` 传入字面量；`create_strategy` 用固化参数）。
- **无 RNG、无日期衰减、无环境变量/时间依赖、无实时/DB 数据**。
- 断言 = 精确信号（`Buy(fraction)/Sell/Hold`）与固定阈值/mode 生效；跨策略一致性用 phase1 指标在测试内重新推导比对。
- 不存在依赖实时市场数据的回测路径；如需真实回测仅用固化在测试内的固定序列。

## 五、单测（`mod tests` 内，22 个）

- 每款策略：固定序列断言 `Buy/Sell/Hold` 及 Buy 分数（`dual_ma_signals`、`ma_rsi_*`、`macd_golden_death_cross`、`boll_*`、`kdj_cross`、`momentum_*`、`atr_channel_*`）。
- 参数生效：`ma_rsi_golden_cross_filter`（RSI 超买阈值挡住/放开金叉）、`ma_rsi_oversold_blocks_death_cross_sell`（超卖阈值）、`boll_trend_mode_cross`/`boll_mean_reversion_mode_inverted`（`mode` 反转）、`registry_create_strategy_params_override_defaults`（lookback 覆盖）。
- 跨策略一致性：`cross_strategy_consistency_macd_signal_matches_dif_dea`、`cross_strategy_consistency_boll_band`、`crossover_indicators_rsi_num`（用 phase1 指标 RSI/Boll/MACD 推导并与策略输出比对）。
- 注册表：`registry_has_7_unique_ids`、`registry_runtime_len_7`、`registry_catalog_len_7_and_schema_nonempty`、`registry_catalog_matches_runtime_order_and_ids`、`registry_create_strategy_defaults_ok_for_all`、`registry_create_strategy_unknown_id_returns_none`、`registry_schema_has_grid_expandable_num_params`。

## 六、验证输出

```
$ cargo test -p backtest
    Running unittests src/lib.rs
    running 42 tests ... test result: ok. 42 passed; 0 failed
    Running tests/golden_sample.rs
    running 2 tests ... test result: ok. 2 passed; 0 failed
    （总 44 passed；其中策略单测 22）

$ cargo clippy -p backtest --all-targets
    Finished dev (no warnings)
```

## 七、暂存文件清单（本次变更，未暂存/未 commit）

本次 Phase 2 相对 Phase 1 基线改动的文件（均为已有未跟踪 crate 内文件；`git diff --cached` 为空）：
- `crates/backtest/src/strategies.rs`（重写：7 款策略 struct + 注册表 + 工厂 + id 清单 + 22 单测）
- `crates/backtest/src/lib.rs`（`pub use strategies::{...}` 扩列，暴露新公开 API；`git diff --cached` 为空）

> 说明：crates/backtest/ 整个目录在仓库中仍为**未跟踪**（Phase 1 未 commit，0011 迁移/应用层 Phase 3 才入库），故 `git status` 显示 `?? crates/backtest/`。**本次未 `git add` 任何文件**；`git diff --cached` 为空，与验收 `noStagedFiles: true` 一致。设计文档 `design/08-backtest/01-engine-adr.md` / `06-web/05-backtest.md` 为 Phase 1 既有未跟踪文件，未改动。

## 八、残留风险 / 待父级确认

1. **BOLL `mode` 默认值**：取 `trend`（ADR 名单读法）；`06-web` 单列 BOLL 为均值回归。若希望默认 `mean_reversion`，改 `BollStrategy::new` 默认 mode + `params_schema` 的 `def` 即可（一行），到时通知我。
2. **ATR 止损 `entry`** 用 Buy 信号当根 close（近似实际成交 open 价），可能在极端跳空下轻微偏差。
3. **均线+RSI 用 SMA**（非 EMA），与 Phase 1 DualMa 的 `ind.ma` 一致；如需 EMA 版另议。
4. `create_strategy` 数值参数 `as usize` 截断 + 小数股/整手/T+1 未建模（沿用 ADR §4 简化）。
5. `builtin_strategies()` 已由「UI 目录」重命名/改为「运行时实例」；原 Phase 1 目录语义迁到 `builtin_strategy_catalog()`。**父级已批准此语义拆分。**
6. 应用层（BacktestService）Phase 3 才消费这些入口；届时需再确认 params 从 HTTP JSON 到 `StrategyParams` 的映射。
