# 036 — backtest 引擎（Phase 1 纯逻辑 crate）

> 本报告位置：`eestock-rs/coder/report/036_backtest_engine.md`
> 任务：实施回测 Phase 1 纯逻辑 `backtest` crate。权威依据 `design/08-backtest/01-engine-adr.md`（已批复，6 决策按推荐）；UI/交互参考 `06-web/05-backtest.md`。TDD，**不 commit**。

## 一、定位与落位

`backtest` crate = **纯逻辑、无 IO/无 DB**（事件驱动 bar 引擎 + 组合/订单/费用/滑点 + 指标 + 8 项绩效指标），可完全单测。落位 `eestock-rs/crates/backtest/`。手写（非 tangle）。

- workspace `Cargo.toml` 的 `members = ["crates/*"]` glob 已覆盖 `crates/backtest`，**无需另行加显式条目**（duplicate 会被 Cargo 视为冗余）。`cargo metadata` 确认其为 workspace member。
- 唯一对既有文件的改动是 `Cargo.lock`（新增 `backtest` package 条目，仅依赖 `serde`）。
- **未触碰** web/storage/collector/domain 等既有实现；未动 DB；无 commit。未新增任何第三方依赖（`serde` 为 workspace 既有依赖，仅用于结果/交易/指标序列化给 REST 层）。

## 二、crate 结构

```
crates/backtest/
  Cargo.toml                 # 依赖：serde.workspace = true
  src/
    lib.rs                   # 模块声明 + 常用类型再导出
    types.rs                 # Bar / Period / Signal / Ctx / ParamDef / ParamKind / Strategy trait / StrategyResult / RunConfig / TradeDetail / BacktestResult
    indicators.rs            # Indicators（MA/EMA/RSI/MACD/KDJ/BOLL/ATR）+ MacdValue/KdjValue/BollValue
    fee.rs                   # FeeModel + BuyExecution/SellExecution + 费用/滑点计算
    metrics.rs               # BacktestMetrics + compute_metrics / compute_drawdown / compute_max_drawdown
    engine.rs                # Engine + run()（事件循环/挂单/成交/期末强平/净值/回撤）
    strategies.rs            # DualMaStrategy + builtin_strategies()（编译期注册目录）
  tests/
    golden_sample.rs         # 黄金样本（12 根 1d bar × 双均线）× 策略信号交叉单测
```

## 三、trait / 模型 / 指标实现要点

- **Strategy trait**（ADR §5）：
  ```rust
  pub trait Strategy: Send + Sync {
      fn id(&self) -> &str;
      fn params_schema(&self) -> Vec<ParamDef>;
      fn on_bar(&mut self, ctx: &mut Ctx, bar: &Bar, ind: &Indicators) -> Signal;
  }
  ```
  `ParamDef{key,label,kind:Num{min,max,step,def}/Choice{options,def}}` 驱动 UI schema；`Ctx`（bar_index/ts/cash/position/equity）。`Indicators` 惰性按需计算（持有 `&[Bar]` + index），满足对象安全（`dyn Strategy`）。
- **Indicators**：实现 MA(fast/slow)、EMA、RSI(Wilder)、MACD(12/26/9、取 DIF/DEA/hist)、KDJ(9/3/3)、BOLL(20,2)、ATR(Wilder)。均单测锁定。策略引用即可用。
- **组合/订单/费用/滑点**（ADR §4 简化）：初始资金默认 100_000；单标的单方向多头；`Signal::Buy(fraction)` 表示投入市值比例（默认 1.0=全仓）；信号在 bar close 判定 → **下一 bar open 成交**（bt-2）；`FeeModel` 默认 0.025 / 5.0 / 0.05 / 2.0（bt-1）。
- **成交模型**：买/卖价按滑点折入；佣金 `max(成交额×0.025%, 5)` 买卖各一次；卖出加印花税 `0.05%`；建仓把佣金折进预算（`shares=预算/(成交价×(1+佣金率))`，触底最低佣金时折入最低值）保证总成本=预算。**期末强制平仓**（最后 close），并让净值序列末点反映已实现净值。
- **8 项指标**（metrics）：NetProfit、MaxDrawdown、Sharpe、WinRate、ProfitFactor、AnnualizedReturn、TradeCount、AvgHoldPeriod。

## 四、黄金样本单测结果（锁死口径）

手工 12 根 1d bar（close 序列 `[10,9,8,8.2,9.5,12,11,10,13,15,10.5,10.5]`，open=close）驱动 `DualMaStrategy(2,3,1.0)`。期望值由独立 Python 模型按 ADR 口径推演（含滑点/佣金/印花税/下一 bar open 成交）。锁死：净值序列逐点、回撤序列逐点、交易明细（含费用/滑点/持仓时长）、8 项指标。

- 净值序列（末点）：...、108_181.745722、108_133.080429、75_693.156300、75_621.259156
- 2 笔交易：第 1 笔 buy 12.0024→sell 12.9974（盈利 8181.745722，费 52.059487+印花 54.131471，持 3 bar）；第 2 笔 buy 15.003→sell 10.4979（亏损 −32560.486566，费 45.958181+印花 37.839009，持 2 bar）。
- 指标：NetProfit=−24378.740844、MaxDD=0.300979、Sharpe=−1.848716、WinRate=0.5、ProfitFactor=0.251278、Annualized=−0.997172、TradeCount=2、AvgHold=2.5。

**`cargo test -p backtest`：22 passed（20 unit + 2 integration），0 failed。**

## 五、cargo test / clippy 输出

```
$ cargo test -p backtest
   Compiling backtest v0.1.0
    Running unittests src/lib.rs
    running 20 tests ... test result: ok. 20 passed; 0 failed
    Running tests/golden_sample.rs
    running 2 tests ... test result: ok. 2 passed; 0 failed

$ cargo clippy -p backtest --all-targets
    Finished dev profile (no warnings)
```

## 六、ADR 口径落地说明（含自行明确/标注的约定）

| 决策 | 落地 |
|---|---|
| bt-1 费用默认 | `FeeModel::default()` = 0.025% / 5.0 元 / 0.05% / 2.0bp |
| bt-2 成交时点 | 信号 close 判定 → 下一 bar open 成交；期末强平用最后 close |
| bt-3 年化/Sharpe | Sharpe rf=0；年化因子按周期：D1=252、1m=252×240、5m=252×48、15m=252×16（`Period::bars_per_year`）。年化收益 `(期末/初始)^(bars_per_year/bar_count)−1`；Sharpe = 均值/样本标准差 × √bars_per_year |
| bt-4 复权 | 不复权（纯逻辑按给定价格推进，除权跳空接受） |
| bt-5 策略名单 | Phase 1 落地第 1 款「双均线」；其余 6 款为 Phase 2 工作（见残留风险） |
| bt-6 落位 | 独立 `backtest` crate（纯逻辑、单测） |

**在 ADR 简化模型内自行明确并标注的约定（未覆盖处，按推荐实现并在注释+本报告写法）**：
- `backtest::Bar{ts,open,high,low,close,volume}` / `Period(M1/M5/M15/D1)` 与 `domain::Bar` 解耦（application 层端口适配器负责映射，Phase 1 不实现；本 crate 不依赖 domain）。`ts` 用 `i64` Unix 秒。
- **Sharpe 周期回报标准差取样本（ddof=1）**（金融惯例；ADR 未指明）。
- **MACD hist = DIF−DEA**（未 ×2；策略只用 DIF/DEA 交叉）。
- **成交数量为小数**（ADR「非完整撮合」简化；真实 A 股 1 手=100 股整手规则不建模）。
- **`StrategyResult` 解读为内建策略目录条目**（id/name/description/params_schema，供 `GET /api/backtest/strategies`）；ADR 仅定义 `Signal`，此为按 UI 契约的自然解读。

## 七、残留风险

1. 7 款内建策略仅落地「双均线」，`builtin_strategies()` 返回 1 条，与 UI 定稿 `builtinStrategyCount: 7` 不符 → Phase 2 补 6 款。
2. Sharpe 样本标准差（ddof=1）为自行约定，需父级确认是否改用总体标准差。
3. 小数股/忽略 100 股整手与 T+1 撮合，为 ADR 允许的简化；对账旧引擎时需注意口径一致性。
4. 年化收益在小 bar 数下数值极端（数学上按 bt-3 正确，如 12 bar 年化≈−99.7%），仅展示层注意。
5. 指标每 bar 全量重算 → 大区间 `O(n²)` 慢；Phase 1 测试尺度足够，生产可预计算缓存。
6. `domain::Bar → backtest::Bar` 映射层尚未实现（application 层 Phase 2）。

## 八、暂存文件清单（本次变更，未暂存）

新文件（未跟踪，`??`）：
- `crates/backtest/Cargo.toml`
- `crates/backtest/src/lib.rs`
- `crates/backtest/src/types.rs`
- `crates/backtest/src/indicators.rs`
- `crates/backtest/src/fee.rs`
- `crates/backtest/src/metrics.rs`
- `crates/backtest/src/engine.rs`
- `crates/backtest/src/strategies.rs`
- `crates/backtest/tests/golden_sample.rs`

修改（`M`）：
- `Cargo.lock`（仅新增 `backtest` package 条目）

**未暂存任何文件（`git diff --cached` 为空）。未 commit。**
