# 113 — P1b 统一策略系统：参考插件包（7 款内建策略 JS 改写 + 4 官方模板 + 迁移等价性测试）

- 日期：2026-09（P1b，紧随 111/112 P1a）
- 范围：`crates/strategy-core`（Domain 层；未动 design/ 与既有 crate 源码，仅 lib.rs 增加一行 `pub mod reference;`）
- 本报告路径：`coder/report/113_strategy_core_p1b_reference_plugins.md`

## 1. 问题/需求

ADR `design/12-strategy-system/01-adr.md` §7（D8）：7 款 Rust 内建策略（dual_ma/ma_rsi/macd/boll/kdj/momentum/atr_channel）
逐款改写为 JS 参考插件（兼用户模板与测试 fixture）；§13.2（D10）：4 款官方策略模板；
§9：迁移等价性测试守门（golden bars 信号序列逐 bar 一致）。

## 2. 交付物清单（变更文件）

| 文件 | 说明 |
|---|---|
| `crates/strategy-core/reference-plugins/dual_ma.js` | 参考插件：双均线交叉 |
| `crates/strategy-core/reference-plugins/ma_rsi.js` | 参考插件：均线+RSI 过滤 |
| `crates/strategy-core/reference-plugins/macd.js` | 参考插件：MACD 金叉/死叉（自持增量状态复算，见 §4） |
| `crates/strategy-core/reference-plugins/boll.js` | 参考插件：BOLL 双模式（mode int 编码，见 §4） |
| `crates/strategy-core/reference-plugins/kdj.js` | 参考插件：KDJ（自持滚动窗+平滑状态复算） |
| `crates/strategy-core/reference-plugins/momentum.js` | 参考插件：动量突破（自持 Donchian 滚动窗） |
| `crates/strategy-core/reference-plugins/atr_channel.js` | 参考插件：ATR 通道+止损（自持滚动窗+entry） |
| `crates/strategy-core/reference-plugins/templates/pure_score.js` | 官方模板：纯评分（教学向中文注释） |
| `crates/strategy-core/reference-plugins/templates/two_state_gate.js` | 官方模板：两态门控 |
| `crates/strategy-core/reference-plugins/templates/dca.js` | 官方模板：定投（配合 DCA Policy） |
| `crates/strategy-core/reference-plugins/templates/trend_stop.js` | 官方模板：趋势+软止损 |
| `crates/strategy-core/src/reference.rs` | `ReferencePlugin{id,name,description,code}` + `reference_plugins()`（7）+ `official_templates()`（4），include_str! 纯静态，供 P2 Registry 播种与测试共用 |
| `crates/strategy-core/src/lib.rs` | +1 行 `pub mod reference;`（唯一对既有源码的改动） |
| `crates/strategy-core/tests/equivalence.rs` | 迁移等价性测试（17 个用例） |
| `crates/strategy-core/tests/templates.rs` | 模板回归（3 个用例） |

无新外部依赖；无 design/ 修改。

## 3. 架构对齐

- 全部变更位于 Domain 层 `strategy-core`（ADR §3：唯一策略内核）。插件为纯文本数据（仓内 fixture），
  经 `include_str!` 内嵌——无 IO、无 DB、无网络、无系统时钟，分层红线不破。
- 未修改任何核心接口/事件契约/层边界；`PluginRuntime`/`EnsembleEngine` 零改动。
- 插件只产评分（80/20/50），不含 `position_pct`——仓位归 ExecutionPolicy（ADR §13.1 裁决），逐款头注释注明。

## 4. 7 款逐款「语义对齐确认 / 已知差异」表

| 插件 | 语义对齐确认 | 已知差异（已在插件头注释+测试注释注明，无静默放过） |
|---|---|---|
| dual_ma | prev_above 仅在双均线均可用时更新；数据不足 → 50 不更新 prev；金叉/死叉严格大于 | 无 |
| ma_rsi | RSI null 按通过处理（is_none_or 口径）；过滤分支双向覆盖 | 无 |
| macd | DIF/DEA 交叉 prev 口径；MACD 自首根即有值 | **host `macd()` 固定 (12,26,9)（ABI §2）不可调参 → 插件按 `backtest::Indicators::macd` 口径自持增量状态复算**（EMA 种子=首根 close、DEA 种子=首根 DIF=0、IEEE754 同序运算），任意周期参数与 Rust 一致；前提「引擎从 bar 0 连续调用」（EnsembleEngine 保证）。等价性含默认参数 60 bar 长序列抽查 |
| boll | prev_close 无条件每 bar 记录；穿越判定相对当前 band；mean_reversion 默认 | **ABI §1 schema 仅支持 int/float → Rust 的 Choice 参数 `mode` 编码为 int（0=mean_reversion 默认 / 1=trend）**，头注释+schema description 注明；等价性双模式各一条完整交易 |
| kdj | K/D 种子 50、(m−1)/m 平滑、窗口未满 → 50 不更新 prev | **host `kdj()` 固定 (9,3,3) → 同 macd 自持滚动窗+平滑状态复算**；J 不参与判定（同 Rust） |
| momentum | Donchian 窗不含当前 bar；信号判定后推窗（Rust 同序）；空仓也发 Sell（引擎按持仓决定成交） | 无 |
| atr_channel | Donchian 窗不含当前 bar；ATR 止损优先于通道离场；ATR null → 该 bar 不触发；持仓判定 `ctx.position !== null` ↔ Rust `ctx.position > 0.0` | **entry = 自身 Buy 信号当根 close（插件内部状态，不用 `ctx.position.avg_cost`）**——与 Rust 版「信号 bar close 近似」口径一致，头注释注明 |

评分映射等价性依据（逐款头注释注明）：Buy→80 / Sell→20 / Hold→50；默认聚合阈 60/40 下
80≥60↔Buy、20≤40↔Sell、50↔Hold，与 Rust `Signal` 逐 bar 一一对应。

## 5. golden bars 设计说明（全部手工字面量/确定性生成器，无 RNG/无时钟）

- **dual_ma**（fast=2,slow=3）：closes [10,8,9,11,10,7,8]——先跌后涨造金叉(bar3 Buy)、再回落造死叉(bar5 Sell)；尾 bar 供成交。预期 [H,H,H,B,H,S,H]，交易 开4/平6。
- **ma_rsi**（2/3/RSI(2)/70/30）：A) [10,9.5,9.2,10,10.8,10.4,10,9.8] 缓动序列——金叉 bar3（RSI≈66.7<70 通过 Buy）、死叉 bar6（RSI≈31.6>30 通过 Sell），交易 开4/平7；B) [10,6,8,14] 急涨——金叉 bar3 被 RSI≈77.8≥70 过滤（全程 Hold）；C) [8,10,12,11,7] 急跌——死叉 bar4 被 RSI≈18.2≤30 过滤。
- **macd**（2,3,3）：沿用 Rust 单测序列 [10,11,12,11,13,14]——bar1 金叉 Buy、bar3 死叉 Sell、bar4 再金叉 Buy；交易 (开2,平4)+(开5,期末强平平5)。另加默认参数 (12,26/9) 锯齿 60 bar 抽查。
- **boll**（period=5,k=1.5）：均值回归 [10,10,10,10,5,10,15,14]——bar4 收破下轨 Buy、bar6 收破上轨 Sell（交易 开5/平7）；趋势模式 [10,10,10,10,15,16,4,5]——bar4 破上轨 Buy、bar6 破下轨 Sell。
- **kdj**（3,2,2）：沿用 Rust 单测序列 [10,11,12,11,13,14]——bar3 死叉 Sell（无持仓，双侧均忽略成交但信号一致）、bar4 金叉 Buy（开5，期末强平平5）。另加默认参数 (9,3,3) 抽查。
- **momentum**（lookback=2）：b0/b1 建通道(high10/low9)，b2 close12 破上轨 Buy，b3 close8 破下轨 Sell（交易 开3/平4）。
- **atr_channel**（channel=2,atr=2）：A) mult=1.0——b2 Buy(entry=12)，b3 close10 < 12−1×ATR(0.75)=11.25 触发 ATR 止损 Sell（交易 开3/平4）；B) mult=100——ATR 止损不触发，b3 close8 跌破通道下轨(9) 通道离场 Sell。
- **全员默认参数长序列抽查**：确定性锯齿生成器（8 周期三角波，9..=13）80 bar，7 款默认参数逐 bar 等价。

端到端相等断言口径：交易笔数 + 每笔开/平仓 bar 一致（价格口径差异已排除——同 `FeeModel::default()`、
同「close 判定、次 bar open 成交」规则；双侧期末强制平仓口径一致）。

## 6. 等价性测试方法（口径）

- Rust 侧：`backtest::Engine` 跑 `create_strategy(id, params)`（经 Recorder 包装逐 bar 记录原始 Signal，持仓/成交时序为真实引擎口径）。
- JS 侧：单 slot `run_ensemble_with_quickjs`（weight=1，阈值 60/40，`LumpSum{pct:1.0}`，同 FeeModel/initial_capital），取 `per_bar[i].signal`。
- **参数默认值填充**：ABI §1 NIT-6 裁决「schema 填缺省是消费方职责，运行时原样透传」——测试中作为消费方
  按插件 PARAMS_SCHEMA 的 default 补齐缺省 key（`fill_schema_defaults`），与 Rust 侧 `create_strategy` 空参默认填充对齐（Red 阶段此口径曾致 3 例失败，补齐后全绿）。

## 7. 测试覆盖（TDD：Red 已留痕）

- Red：先写 tests + 语义占位 stub（恒 50）→ 13 个等价性/schema 用例失败（`cargo test` 输出已确认）。
- Green：逐款移植实现 → 全绿。
- `tests/equivalence.rs`（17 用例）：7 款 golden-bar 等价（10 条用例）+ macd/kdj 默认参数长序列 + 全员默认参数 80 bar 抽查 + PARAMS_SCHEMA 机械对齐（key/默认值/范围 vs Rust catalog，剔除 position_pct；boll mode int 编码专项断言）+ 确定性双跑（7 款信号序列+分数序列逐点）+ save/load round-trip（7 款：前半段喂状态 → save → 新实例 load → 后半段逐点一致；含 entry/滚动窗/EMA/DEA/prev 全状态）。
- `tests/templates.rs`（3 用例）：4 模板实例化+schema 合法（无 position_pct）+ 确定性双跑 + 两态门控行为冒烟（持仓期不得再给买入区高分）。
- `src/reference.rs` 单测（2 用例）：7 款 id 唯一且顺序 = `builtin_strategy_ids()`；模板 4 款；code 含 on_bar/PARAMS_SCHEMA。

## 8. 验证

- `cargo test -p strategy-core`：32(lib) + 23(engine, 1 ignored 为既有) + 17(equivalence) + 3(templates) 全绿。
- `cargo test -p strategy-runtime`：14 + 13 全绿（零回归）。
- `cargo clippy -p strategy-core --all-targets`：0 warning。
- `cargo build --workspace`：0 error。
- 已 `git add` 暂存（未 commit）；暂存集 = 上表 15 个文件，无越界。

## 9. 遗留风险

1. **macd/kdj 自算口径的调用前提**：插件自持增量状态依赖「从 bar 0 起逐 bar 连续调用 on_bar」；
   EnsembleEngine 与试算路径均满足，但若未来出现「区间中段启动」的运行模式（如 sim-live 热加载中途接管），
   需经 save/load 快照恢复或从头重放——已在插件头注释注明。P4 sim-live 切源时需注意会话恢复路径走 G3 快照。
2. **boll.mode 的 int 编码**是 ABI §1 schema 类型能力（int/float）下的权宜；若 ABI 未来扩展 choice 类型，
   参考插件可平移回字符串枚举（语义不变，仅编码变化）。
3. **模板 dca 的 plan_bars 与 Policy tranches×interval 对齐靠约定**（注释已注明），无机制强约束——
   属教学模板的可接受简化。
4. 等价性守门覆盖 golden bars + 默认参数锯齿序列；非默认参数的随机全覆盖未做（指标本身由
   `backtest::Indicators` host 侧保证同口径，风险低）。
