# 判定「策略侧是不是写错了」—— sr_1789738328788_000005 只读取证

- 本文件位置：`eestock-rs/coder/evidence/20260918_sr_trades_strategy_side/README.md`
- 取证时间：2026-09-18（本地 23:35–23:52 / UTC 15:35–15:52）
- 被测 run：`sr_1789738328788_000005`（518880 / D1 / 2026-01-04T16:00Z → 2026-09-16T16:00Z，173 bar，
  `initial_capital=100000`，`fee={rate_pct:0.025,min_fee:5,slippage_bp:2,stamp_duty_pct:0}`，`stop=null`）
- 被测插件：`sv_1789211089727_000010`（`定投·定期定额基线` = `dca_baseline` v1，published / backtest_ok）
- 被测执行策略：`Dca{mode:Equal, tranches:100, interval:1}`，阈值 60/40
- 服务：`./target/debug/eestock-app`（同进程 8081 Web + 8082 MCP），DB `127.0.0.1:5433/eestock`
- **只读纪律**：无 UPDATE/INSERT/DELETE/DDL；无代码改动；无 `git add/commit`（仅新增本证据目录；
  `git diff --cached` 为空）。

---

## 0. 一句话结论

**策略没写错，回测引擎也没算错——错的是「这次 run 的用法」与「平台缺一层提交期体检」。**

- 插件实现与它的设计文档**逐字节一致**（S1），单边（永不卖出）是设计红线而非 bug（S4）；
- 引擎口径可被独立纸面模型**复现到 1e-4**（S2/S3 的校验段：两个 run 的净利都对齐）；
- 但本 run 的 `Dca{tranches:100, interval:1}` + `cadence:20/plan_bars:5` 组合，在 173 bar 区间上
  **结构上最多只能投出 42% 的初始资金**（实测 41.40%），于是：
  - 「对照基准」名义是定期定额，实际是**按净值比例的 1% 分批**（S2）；
  - 净亏看起来比满仓小（-2,933.65 vs 同区间满仓 -11,563.89），**纯粹因为只投了 41% 的资金**（S3）；
  - 指标 `trade_count=1 / win_rate=0 / profit_factor=0` 是既有口径的必然结果（前轮已取证）。

判定表（详见 S1–S6）：

| 编号 | 疑点 | 判定 | 严重度 | 归属 |
|---|---|---|---|---|
| S1 | 实现与设计文档不一致 | **不属实**（忠实实现；参数默认也一致） | — | 设计如此 |
| S1-附 | 代码引用的设计文档不在本仓库（可追溯性） | 属实 | 低 | 系统侧（归档） |
| S1-附 | 名称「无脑定期定额」与平台能力不符 | 属实 | 低 | 策略侧命名（作者已自认并修订） |
| S2-① | Equal 是「净值比例」而非「定额」 | **属实**（语义如此，平台文档如实） | — | 设计如此 |
| S2-② | 本 run 每批金额不是固定值 | **属实**（首窗 1000.000 元；其余窗 959.96–1002.28 元） | 中 | 配置使用侧 |
| S2-③ | 文档要求定额而 seed 用 Equal ⇒ 对照基准名不副实 | 部分属实（文档自身有误解；后果成立） | 中 | 策略侧文档 + 配置使用侧 |
| S3 | `plan_bars` 与 `tranches×interval` 无乘性约束/校验/告警 | **属实 ⇒ 契约缺口** | 高 | 系统侧（治理）+ 配置使用侧 |
| S4 | 插件值域恒为 {50,75}，结构上永不卖出 | **属实** | 中（治理） | 设计如此（红线）；治理缺口属系统侧 |
| S4 | 发布链路能发现「永不卖出」 | **不属实（发现不了）** | 中 | 系统侧 |
| S5 | 平台能不能写出双向策略 | 能（12 个仓内样例 11 个双向） | — | 反证：单边是 DCA 族设计 |
| S6-a | `ctx.index` 含 warmup ⇒ 节拍相位取决于 warmup 长度 | 属实 | 低 | 设计如此 + 系统侧（无提示） |
| S6-b | 买入窗口跨区间端点被截断、末 bar 挂单静默作废 | 属实 | 低 | 引擎口径（与 backtest 一致） |
| S6-c | `floor` 取整边界缺陷 | 不属实 | — | — |
| S6-d | `params` 越界行为缺陷 | 不属实（平台拒/收敛） | — | — |
| S6-e | `min_fee=5` 支配 ~1000 元小批次（0.5%/批 = 20× 名义费率） | 属实 | 中低 | 配置使用侧 + 系统侧（无告警） |

---

## S1 设计意图 vs 实际实现

### 判据

1. 设计文档原文（**不在本仓库**，在策略研发侧工作区；只读副本见 `raw/50_design_01_copy.md`，
   原件指纹见 `raw/53_external_docs_provenance.txt`）：
   - `01-dca-strategy-family.md:106-115` §4.4 `dca_baseline`：
     ```
     ### 4.4 `dca_baseline` — 无脑定期定额（对照组，非策略）
     barsSinceTrigger = index - floor(index/cadence)*cadence
     barsSinceTrigger < plan_bars → 75
     其他                          → 50
     参数：`cadence=20, plan_bars=5`
     ```
   - `01-dca-strategy-family.md:41-43` §3 统一约定：**不使用卖出区（≤40）**，退出交给运行级硬止损。
   - `01-dca-strategy-family.md:178-179` §7：**无卖出逻辑** → 单边下跌市持续买入，风险由硬止损兜底。
   - `01-dca-strategy-family.md:198` §8：T5 = 「全序列无卖出区分数」**设计红线**。
   - `01-dca-strategy-family.md:20`：批次由 DCA Policy 管，「插件不能决定投多少，只能决定何时待在买入区」。
2. 库内实现（sha256 复核：库内 `strategy_version.code` 1248 字节的 sha256 =
   `5d7f83df79f338e795b11560218d07971941088eca587116240ec14bf19ea0b3` = 库内声明 sha256，
   也等于作者工作区 `strategies/dca_baseline.js` 的 sha256 ⇒ **三方一致**；见 `raw/14_sha_audit.txt`、
   `raw/53_external_docs_provenance.txt`）：

   | 设计文档 §4.4 | 库内 code（`raw/12_sv_code.exact.txt:14-16` 参数、`:22-23` 逻辑） | 一致？ |
   |---|---|---|
   | `barsSinceTrigger = index - floor(index/cadence)*cadence` | `const since = idx - Math.floor(idx / p.cadence) * p.cadence;` | ✅ |
   | `barsSinceTrigger < plan_bars → 75` | `return since < p.plan_bars ? 75 : 50;` | ✅ |
   | 其他 → 50 | 同上（三元 else 分支） | ✅ |
   | 参数 `cadence=20, plan_bars=5` | `PARAMS_SCHEMA` 默认 20 / 5（min-max 1..250 / 1..120 额外声明） | ✅ |
   | 无状态、无 save/load | 无模块级可变状态、未定义 `save/load` | ✅ |

3. 运行期反证（`raw/41_index_phase_check.txt`）：423 根 per_bar 的 `aggregate` 分布 = `{75:108, 50:315}`，
   且 `(idx % 20 < 5) === (aggregate == 75)` 对全部 423 根成立 ⇒ 实际执行的就是文档那三行。

### 判定

- 「策略侧写错了（与设计不符）」：**不属实**。实现是文档 §4.4 的逐字转写，连默认参数都对得上。
- 附加属实项（低严重度，不是本 bug 的根因）：
  - **S1-附 1｜可追溯性**：code 头部注释引用 `design/01-dca-strategy-family.md`，但该文件
    **不在本仓库**（`git ls-files | grep -c dca-strategy-family` = 0），只存在于策略研发侧工作区
    `/home/eestock/workspace/scrylink/eestock/eestock/design/`。→ 归属 **系统侧（归档/供应商交付缺失）**，
    严重度 低：本仓库内无法自证契约，只能靠外部文档。
  - **S1-附 2｜命名**：「无脑定期定额」在平台上**不可能成立**（没有周期性资金注入通道）——作者自己
    在 `03-dca-policy-semantics-correction.md:30-40, 58-62` 已推翻该定位，并把 `dca_baseline` 改称
    「无择时的梯次建仓」。→ 归属 **策略侧文档/命名**（已自认），严重度 低。

---

## S2 「定期定额」名义 vs 执行引擎实际口径

### ① Equal 与 FixedAmount 的语义差（原文）

```
crates/strategy-core/src/policy.rs:12-20
pub enum DcaMode {
    /// 等额分批：计划总额 / N。计划总额 = 买入信号重新出现时（新一轮建仓起点）的账户净值。
    Equal,
    /// 固定金额分批：每批 `amount` 元。
    FixedAmount,
}
crates/strategy-core/src/policy.rs:190-193
let batch_amount = match mode {
    DcaMode::Equal => st.plan_total / *tranches as f64,   // 净值比例
    DcaMode::FixedAmount => amount.expect("validated"),    // 绝对值
};
crates/strategy-core/src/policy.rs:176-184   // plan_total = 本轮 Buy 起点 equity（每个 Buy run 重新快照）
```
平台自己的 ADR 也把这点写明了：`design/12-strategy-system/01-adr.md:99`
> Equal 计划总额 = 本轮 Buy 起点净值快照；信号中断 → 剩余批次取消，Buy 重现重新计数。

⇒ **Equal ≠ 定额**；「定额」只有 `FixedAmount` 能表达。**属实**，但这是**文档化语义**，不是实现错误。

### ② 本 run 每批金额实测（`raw/34_batch_amount_exact.txt`）

用「每个 Buy-run 首根决策 bar 的 Policy 挂单 qty × 该 bar close = batch_amount」反算（`Equal: batch = plan_total/tranches`）：

| 决策窗起点 idx | 日期 | 挂单 qty | 决策 close | batch_amount | ⇒ implied plan_total |
|---|---|---|---|---|---|
| 260 | 2026-01-18 | 99.940036 | 10.0060 | **1000.000000** | 100,000（=初始资金，全现金） |
| 280 | 2026-02-23 | 91.532195 | 10.9500 | 1002.2775 | 100,228 |
| 300 | 2026-03-23 | 106.005123 | 9.2990 | 985.7416 | 98,574 |
| 320 | 2026-04-21 | 99.387469 | 10.0040 | 994.2722 | 99,427 |
| 340 | 2026-05-24 | 103.577003 | 9.5120 | 985.2245 | 98,522 |
| 360 | 2026-06-22 | 112.617974 | 8.5370 | 961.4196 | 96,142 |
| 380 | 2026-07-20 | 113.363424 | 8.4680 | 959.9615 | 95,996 |
| 400 | 2026-08-17 | 108.135905 | 9.0780 | 981.6577 | 98,166 |
| 420 | 2026-09-14 | 109.841943 | 8.8290 | 969.7945 | 96,979 |

⇒ 每批 = **该窗起点净值的 1%**（959.96 ~ 1002.28 元），**不是固定金额**；现金流出口径合计
41,397.97 元（含 gap/滑点）。**判定：属实**（「定额」名不副实），严重度 **中**
（同一条「对照臂」在不同区间/不同起点的"每批金额"会随净值漂移，跨 run 不可比）。

### ③ 文档要求的是定额还是等比？

- `01-dca-strategy-family.md:29` §2.1 写：「**DCA Policy 每批金额固定**，插件无法改变单批金额」
  ——这是**作者的误解**（平台 ADR/源码都不是这样：Equal 是净值比例，FixedAmount 才是定额）。
- 作者**实际使用**的是 Equal：`01-...:150` §5.3「执行：DCA Policy `{tranches:3, mode:"Equal", interval:5}`」；
  其矩阵工具 `tools/dca_matrix.py:39` `DCA = {"Dca": {"tranches": 3, "mode": "Equal", "amount": None, "interval": 5}}`。
- ⇒ 「文档要求定额」**不成立**（文档正文里就自相矛盾）；但「对照基准（名为定期定额）实际是净值比例分批」
  **成立**。根因在**策略侧文档表述 + 本 run 的参数选择**，不在引擎。
- 作者后来在 `03-dca-policy-semantics-correction.md:94-101` 已把这条列为给平台的 P1 建议
  （要么加周期性注资，要么把 `Dca` 更名 `LadderedEntry`）——**建议至今未落地**。

---

## S3 参数组合是否自洽（`cadence=20 / plan_bars=5` 配 `tranches=100 / interval=1`）

### ① 乘性关系有没有规定/校验/告警？

- **平台 ADR**（`design/12-strategy-system/01-adr.md:99`）只定义 policy 自身，未涉及插件买入窗口。
- **策略设计文档**（`01-...:33-34`）只有定性一句：「延长买入区窗口（多投）——在 `tranches` 未耗尽时
  窗口越长、投的批数越多；一旦 `tranches` 耗尽则窗口无效」。没有不变量、没有数值约束。
- **唯一明确要求对齐的地方**是官方模板的注释：`crates/strategy-core/reference-plugins/templates/dca.js:23`
  > `plan_bars` … description: "计划加仓窗口（bar 数，**应与 DCA Policy 的 tranches×interval 对齐**）"
  ——但这是**注释文本**，平台**没有任何校验或告警**：
  - `crates/strategy-core/src/engine.rs:92-116` `validate()`：只查阈值/资金 + `policy.validate()`；
  - `crates/strategy-core/src/policy.rs:48-76` `Dca.validate()`：只查 `tranches ≥ 1`、FixedAmount 的 `amount > 0`；
  - `crates/application/src/workbench.rs:523`、`…/strategy.rs:769` 调用的就是上述 validate；
  - 插件参数只查 min/max：`crates/application/src/strategy.rs:347-388`。
- ⇒ **判定：属实 ⇒ 契约缺口**（跨「插件参数 × 执行策略 × 区间长度」三者的可完成性无人检查），
  严重度 **高**，归属 **系统侧（治理）+ 配置使用侧**。

### ② 本组合的后果（可数出来）

- 区间 173 bar，`cadence=20 / plan_bars=5` ⇒ 每个 20-bar 周期只有 5 个 Buy 决策 bar，
  9 个周期 = 43 个决策 bar（`raw/41_index_phase_check.txt`：in-range 段 Buy 分正好 43 根）。
- `interval=1` 时每决策 bar 触发 1 批 ⇒ 本区间**最多 43 批**（末 bar 那批无下一 bar 可成交 ⇒ 42 笔成交），
  `tranches=100` 只用到 42/100 = **42%**；实测现金流出 **41.40%** 初始资金（`raw/43_paper_engine_out.txt` A 段）。
- 要投满 100 批需要 100 个连续 Buy bar，或 20 个完整 20-bar 周期 = **400 bar**（本区间 173 bar 结构上不够）。

### ③ 若按文档意图，期望总投入应为多少

| 口径 | 依据 | 期望总投入 | 期末净利（同区间纸面/实测） |
|---|---|---|---|
| **A2 对照臂（文档 §5.3 / dca_matrix.py:39）** `Dca{t3,i5,Equal}` | `01-...:150`、`dca_matrix.py:39`、`03-correction:72` | **≈100,000 元（100%）** — 每批 = 窗起点净值/3 ≈ 33.3k，每窗只触发第 0 批（第 2 批需 `bars_in_run=5` > 5-bar 窗口）；3 个窗投满，第 4 个窗把剩余 101.11 元投出（4 笔成交） | 纸面投入 99,970.03 元；净利 **-13,306.92** |
| 模板建议的对齐口径 `Dca{t5,i1,Equal}` | `templates/dca.js:23` | **≈100,000 元（100%）** — 每批 = 窗起点净值/5 ≈ 20k，首窗 5 批就投满（纸面投入 99,974.72 元；之后窗口的挂单因现金耗尽不再成交） | 纸面净利 **-15,093.33** |
| A1 立即满仓 `LumpSum{1}` | `03-correction:71` | **≈100,000 元（100%）** | **平台实测 -11,563.8862**（`sr_1789738272901_000004`，同区间！） |
| **本 run** `Dca{t100,i1,Equal}` | `strategy_run.config` | 结构上限 42,000 元（42%） | **平台实测 -2,933.6479** |

纸面模型可信度校验（`raw/43_paper_engine_out.txt` A 段，逐项对齐平台实测）：

| 量 | 纸面模型 | 平台实测 | 
|---|---|---|
| Buy 成交笔数 | 42 | 42（fills = 42 Buy + 1 ForceClose） |
| 期末持仓股数 | 4368.985265614662 | 4368.985265614662（`trades[0].shares`） |
| 买入佣金合计 | 210.000000 | 210.0（`trades[0].commission` 219.671 − 卖出 9.671） |
| 期末净值 | 97,066.352086 | 97,066.35208602871（`net_value` 末点） |
| 净利 | −2,933.6479 | −2,933.64791397129 |

并且同一模型跑 `LumpSum{1}` 得 −11,563.8862，与**平台实测的另一条 run**
`sr_1789738272901_000004`（相同区间、相同插件、`LumpSum{position_pct:1}`）**完全一致**
⇒ 模型不是"编"的，两个方向的数字都能对上（`raw/62_same_window_comparison.txt`）。

### ④ 「名不副实」导致的可比性问题（最直接的收益）

同区间两臂（都是 1 笔回合、都是期末强平）：

| run | policy | 净利 | 最大回撤 | Sharpe | 年化 | 投入 |
|---|---|---|---|---|---|---|
| `sr_1789738272901_000004` | LumpSum 100% | −11,563.89 | 30.52% | −0.387 | −16.39% | 100% |
| `sr_1789738328788_000005`（本 run） | Dca t100/i1 | −2,933.65 | 5.26% | −0.803 | −4.24% | **41.4%** |

⇒ 本 run 的"回撤小、亏得少"**不是策略优**，而是**暴露只有对方的 41%**。把它当"策略绩效"解读会
得出方向性错误的结论。**严重度：高（结论有效性）**，归属 **配置使用侧 + 系统侧缺口**。

---

## S4 是否「结构性单边」

### ① 代数论证：值域恒为 {50,75}

```
on_bar(ctx):
  since = idx − floor(idx/cadence)·cadence      idx ∈ ℤ≥0, cadence ∈ ℤ, 1 ≤ cadence ≤ 250
        = idx mod cadence ∈ [0, cadence)        （整数除法与 floor 一致，非负）
  return since < plan_bars ? 75 : 50            plan_bars ∈ ℤ, 1 ≤ plan_bars ≤ 120
⇒ 返回值为字面量集合 {50, 75}（任何 (cadence, plan_bars, idx) 组合下）
⇒ 永远不 ≤ sell_threshold(40) ⇒ Sell 不可达；也永远不落在 40~60 之外
```
**可执行验证**（`raw/40_value_domain_enum.txt`，用**库内原始字节**在 node 里实例化真实插件）：

```
PARAMS_SCHEMA = [cadence(int,1..250,默认20), plan_bars(int,1..120,默认5)]
combos(cadence×plan_bars) = 30000   idx 0..1000 ⇒ 样本数 = 30,030,000
可达值域 value set = [50,75]
是否含 ≤ sell_threshold(40) 的分支 = false
是否含 ≥ buy_threshold(60) 的分支 = true
run 参数 (cadence=20, plan_bars=5) idx 255..266 = 50,50,50,50,50,75,75,75,75,75,50,50
```
⇒ **判定：属实**（结构性单边，且穷举了声明参数全域）。响应：策略侧**设计如此**（§3 红线 + T5），
但由此产生的治理缺口属系统侧。

### ② 发布链路有没有能力发现「永不卖出」？

**不能**（`raw/56_publish_gate_refs.md` 全文）：

- 发布门禁 = `crates/application/src/strategy.rs:324-345`（`fn publish_smoke` @328）：**两阶段实例化**
  （① 空参 eval + `on_bar` 存在 + `PARAMS_SCHEMA` 可解析；② 按 schema 默认值再实例化验证 `init(params)`）。
  `crates/application/src/strategy.rs:577-596` `publish()` 只在此基础上加 409/400 状态机。
- MCP 工具描述自证同一范围：`crates/mcp/src/tools.rs:307-311`
  「发布门禁：QuickJS 真实实例化冒烟（eval + on_bar + PARAMS_SCHEMA + init(defaults)）」。
- 宿主只 clamp，不体检分布：`crates/strategy-runtime/src/quickjs.rs:619-627`（有限值 → `clamp [0,100]`，
  非有限 → `InvalidScore`）、`types.rs:169-172`；信号判定 `aggregate.rs:105-114`。
- 提交期无「计划可完成性」检查：`engine.rs:92-116`、`policy.rs:48-76`、`workbench.rs:523`。
- `approval_level='backtest_ok'` 是**默认标签**，不是回测证据：`strategy_state.rs:34-48`、`ports.rs:785/861`；
  `grep sim_ok|live_approved` 在 application/web/mcp 只命中测试 ⇒ 没有任何路径因"跑过回测"而升级。
  本 run 用的 4 个定投版本全是 `published / backtest_ok`（`raw/36_dca_version_rows.txt`）。
- **反证**：全仓里唯一会检查这件事的东西是**策略作者自己的 harness**，而且它断言的是**反面**：
  `tools/strategy_eval.py:350-354`「设计红线：定投族不主动清仓…应全序列无卖出区分数」。
- **同类先例**（说明这不是孤例，而是发布门禁的系统性盲区）：`st_1789282702753_000004「15min 对照臂·永不交易」`
  / `sv_1789282702753_000005`（996 字节 `cnb_notrade`，注释自述「恒返回 50（观望）→ 永不进入买入区/卖出区，
  用于测量平台执行基线」）同样 `published`；另有 5 个恒定探针版本 `function on_bar(ctx) { return 80; }`
  （36 字节，同一 sha `d82d2adf…`，`sv_…029/032/035/038/043`）也被发布（`raw/14_sha_audit.txt`）。
⇒ **判定：「发布时零告警」属实 ⇒ 系统侧治理缺口**（不是策略语法错），严重度 **中**。

### ③ 「永不卖出」本身是不是缺陷？

**不是**。设计文档把它写成红线（`01-...:41-43`、`:178-179`、`:198` T5），作者的工具把
「全序列无卖出区分数」当作**通过条件**。用户看到的"从不卖出"= 设计如此。

---

## S5 横向对照：仓内样例能不能双向

（完整表见 `raw/54_reference_plugin_value_domains.txt`）

| 样例 | 分值字面量出处 | 值域 | 可卖(≤40) |
|---|---|---|---|
| dual_ma.js:46/48 | 80/20/50 | {20,50,80} | ✅ |
| ma_rsi.js:49/54 | 80/20/50 | {20,50,80} | ✅ |
| macd.js:74/76 | 80/20/50 | {20,50,80} | ✅ |
| boll.js:50-59 | 80/20/50 | {20,50,80} | ✅ |
| kdj.js:78/80 | 80/20/50 | {20,50,80} | ✅ |
| momentum.js:47/49 | 80/20/50 | {20,50,80} | ✅ |
| atr_channel.js:65/70/75 | 20/20/80 | {20,50,80} | ✅ |
| dcap.js:189-192 | `clamp(50 − (50/N)Σroi, 0, 100)` | [0,100] 连续 | ✅ |
| templates/pure_score.js:32 | 80/20 | {20,50,80} | ✅ |
| templates/trend_stop.js:29/36 | 0(软止损)/80/20 | {0,20,50,80} | ✅ |
| templates/two_state_gate.js:34/37 | 80/50/20 | {20,50,80} | ✅ |
| templates/dca.js:33/36 | 80/50 | {50,80} | ❌（官方 DCA 模板，设计单边） |
| 本 run dca_baseline | — | {50,75} | ❌ |

⇒ 12 个仓内样例 **11 个双向**；唯一的单边模板正是官方 DCA 模板（同样以"不主动清仓"为设计），
**证明平台能力不缺**，缺的是发布期体检。归属：反证 S4。

---

## S6 是否存在与设计无关的真正代码缺陷

### a) `ctx.index` 含 warmup ⇒ 节拍相位由 warmup 长度决定 —— **成立（低）**

- 证据（`raw/41_index_phase_check.txt`、`raw/28_per_bar_pretty.json`）：
  - per_bar 共 423 根 = 250 warmup（`warmup=true`）+ 173 in-range；`per_bar[0].aggregate=75`
    ⇒ 第 1 根 **warmup** bar 就落在 `idx%20<5` 的相位上 ⇒ **`ctx.index` 从 warmup 第 1 根起算**。
  - warmup 段 65 根 Buy 分（说明插件在 warmup 段被完整调用，只有 Policy 被关掉：
    `engine.rs:528/754`），in-range 段 43 根 Buy 分。
  - in-range 起点 `idx=250`（端点是 `from_ts` 那一根），相位 `250%20=10` ⇒ **第一个决策窗是 260..264**，
    区间前 10 根 in-range bar 结构上不可能进买入区；末窗 420..424 被区间末端截断。
- 影响：这套"月频"节拍与自然日历无关，且相位取决于 `warmup_bars`（提交参数，本 run = 250）；
  warmup 换成 240 会平移整个买入窗序列。当前实现**没有任何提示**。
- 归属：**设计如此**（`01-...:24`「节奏只能靠 ctx.index 算术」）+ **系统侧**（引擎把 warmup 一起
  喂给插件且 index 不重置、也不暴露"区间内起点"给插件：`engine.rs:528/754`）。

### b) 买入窗口跨区间端点 —— **成立（低）**

- 证据：43 个决策 bar 中，`idx=422`（末 bar）的 Policy 挂单 `qty=110.04391957839198`
  写进了 `per_bar[422].orders`，但**没有下一根 bar 可成交**；`finish()`
  （`engine.rs:471-500`）只强平 `holding`、**不执行 pending 挂单** ⇒ 该批被静默丢弃（42 而非 43）。
- 归属：**引擎口径**（注释明示"沿用 backtest 引擎口径"）+ 插件拿不到区间端点信息
  （`ctx` 无区间字段，设计文档 §2 已列）。**不是策略 bug**，但会让"计划批次数"少 1
  （相对误差 2.4%）。

### c) `floor` 取整边界 —— **不成立**

- `idx ∈ [0,422]`、`cadence ∈ [1,250]` 均为整数 ⇒ `idx/cadence` 的浮点除法与 `Math.floor`
  在本量级上精确；`since ∈ [0, cadence)` 恒成立；30,030,000 样本枚举无异常值、无非有限值
  （`raw/40_value_domain_enum.txt`）。
- 唯一"边界"是**参数交互陷阱**：`plan_bars ≥ cadence` 时 `since < plan_bars` 恒真 ⇒ 永久 Buy、
  永不中立（`cadence ≤ 120` 即可构造），平台不校验也不告警。归属 **配置使用侧**，严重度 低。

### d) `params` 越界行为 —— **不成立（平台已拒/收敛）**

- `crates/application/src/strategy.rs:347-388` `fill_and_validate_params`：未知键、非数值、
  低于 `min`、高于 `max` 一律 400（错误文案带上下界）；draft 阶段允许坏代码，发布/试算阶段兜底冒烟。
- `crates/strategy-runtime/src/quickjs.rs:619-627`：返回 NaN/±Inf/非数值 → `InvalidScore`
  （该 bar 记中立 50 + 错误事件）；有限值 → `clamp [0,100]`（`types.rs:169-172`）。

### e) 与设计无关但属实：`min_fee=5` 支配小批次 —— **成立（中低）**

- `crates/backtest/src/fee.rs:63-67` `commission = max(额×0.025%, 5)`；
  `fee.rs:73-95` 佣金触底时 `value = budget − min_fee`。
- 本 run 每批 ~1000 元 ⇒ 佣金恒为 **5 元/批 = 0.5%/批**（20× 名义费率）；
  DB 佐证 `trades[0].commission = 219.67099879139525 = 42×5 + 9.671`（`raw/33_trades_pretty.json`）⇒
  买入佣金 210 元，占投入 41,398 元的 **0.507%**。
- 更隐蔽的是：由于 DCA 目标是**累计股数**（`policy.rs:194-196`），每批少投的 5 元会在下一批发单里被
  "补差"，于是**补差单又各付一次最低佣金**（首窗第 2..5 批 = 1004.78 元 ≈ 1000 + 5 元补差）。
- 归属：**配置使用侧**（`tranches=100` 把小批次推到最低佣金区）+ **系统侧**（无"单批金额 vs min_fee"告警）。
- 同一病灶在**文档口径**（`Dca{t3,i5}`）下也出现在最后一笔"残单"上：前 3 批把资金投到只剩
  101.11 元，第 4 个窗的挂单把这 101.11 元投出去，其中 **5 元是最低佣金（占该笔 5%）**，
  投完现金恰好归零，此后各窗挂单因 `cash == 0` 不再执行（纸面推演：4 笔成交、投入 99,970.03 元、
  买入佣金 29.97 元 = 3×8.33 + 5.00）。

### f) 指标 `win_rate=0 / profit_factor=0 / trade_count=1` —— **不是缺陷**

- `crates/backtest/src/metrics.rs:16` 明确口径（实现见 `:81-103`）：「无平仓时 WinRate=0…仅亏无盈 → 0」（盈亏比=0）；
  TradeDetail 只在完全平仓时合成（`engine.rs:846-862`，前轮已取证）⇒ 本 run 期末强平的唯一一笔
  是亏损回合 ⇒ `win_rate=0/1=0`、`profit_factor=0/|loss|=0`。**设计如此**。

---

## 7. 给用户的回答（对齐质问）

| 质问 | 回答 | 依据 |
|---|---|---|
| 策略写错了吗？ | **没有**。实现与设计逐字节一致（参数默认也一致）；单边是设计红线；`min` 值 50/75 全部落在 Buy/Hold 区，没有"本该是卖点却写成 Hold"的地方 | S1、S4③、S6-a/b/c/d |
| 回测系统算错了吗？ | **没有算错**。同区间两条 run 的净利都能被独立纸面模型复现到 1e-4（-2,933.6479 / -11,563.8862） | S3④、`raw/43_paper_engine_out.txt` |
| 那问题在哪？ | **在"这次 run 的用法"**：`Dca{tranches:100,interval:1}` 配 `cadence=20/plan_bars=5`，173 bar 区间只投得出 42% 资金 ⇒ 数字全部不可解释；且"定期定额"这个名字在平台上无法成立（Equal 是净值比例、平台无周期性注资） | S2、S3 |
| 系统该补什么？ | ① 提交期「DCA 计划可完成性」体检+告警；② 发布期的信号分布体检（能否买/能否卖/信号频率）；③ 交付物归档（设计文档进仓库） | S3①、S4②、S1-附 1 |

---

## 8. 如果只允许改一处，改哪里收益最大

**改「提交期（workbench submit / `bt_run_ensemble`）加一条 DCA 计划可完成性检查 + 显式告警」**
（系统侧一处，别处不动）：

- 位置：`crates/application/src/workbench.rs:485-523` 与 `…/strategy.rs:769` 的 policy 校验段
  （现有 `policy.validate()` 之后），新增一次**廉价预跑**（复用既有的 warmup+逐 bar 评分能力）得到
  每个 Buy run 的长度，算出
  `可达批次数 = Σ_runs min(tranches, floor(run_bars/interval) + 1)`，写进响应：
  `policy_capacity: {planned_tranches, reachable_batches, max_deployed_pct}`，
  并在 `max_deployed_pct < 1` 时给 `warnings[]`（**不阻断**，保持向后兼容）；
- 收益：**一次性消灭本 run 的根因**——"只投 41% 的对照组被当成策略绩效"这件事在提交那一刻就会被
  明示（"乐观口径下最多完成 43/100 批 ≈ 42% 计划投入，剩余资金将空置"）；
- 通用性：对任何策略 × 任何 `tranches/interval` × 任何区间长度都生效，**不需要改任何策略代码、
  不需要改引擎语义、不需要改数据**；顺带修掉"同一策略不同区间数字不可比"的复现性隐患。
- 最小替代（若只允许改**配置**、不许动系统）：把该 run 的 policy 换成作者设计/矩阵口径
  `Dca{tranches:3, mode:Equal, interval:5}`（并把区间提到 4 年以对齐 A1/A2 基准），
  即 `03-dca-policy-semantics-correction.md:72` 的 A2 臂——平台实测该配置 4 年满仓
  （`sr_1789212710079_000053`：26,496 股、净利 +140,554.70）。

---

## 9. 证据文件清单（本目录 `raw/`）

### 原始取证（命令输出）
| 文件 | 内容 |
|---|---|
| `00-02_*schema*.txt` | `strategy_version`/`strategy_run`/`strategy_run_result` 表结构 |
| `10_sv_row.txt` | 版本行（sha256=5d7f83df…，1248 字节，published） |
| `11_run_row.txt` | run 行（config 全文：policy Dca100/1、params cadence20/plan5、warmup 250、clamped） |
| `12_sv_code.sql.txt` / `12_sv_code.exact.txt` | 库内 code（后者去掉 psql 追加的换行 = 精确 1248 字节） |
| `13_all_versions_sha.tsv` / `14_sha_audit.txt` | **全部 24 个版本**的 sha256 复核（24/24 MATCH；含 "永不交易" 与恒分探针版本源码） |
| `20_fills_raw.json` / `21_fills_summary.txt` | 43 笔成交（42 Buy + 1 ForceClose）逐笔明细 |
| `22_bars_by_kind.txt` / `23_per_bar_firstlast.txt` | 分块（per_bar 423 / net_value 173 / fills 43 / drawdown 173） |
| `24_kline_518880_d1.tsv` | （已删：`kline_accurate` 实际只存 M1，D1 需走 `/api/kline`，见 27） |
| `25_per_bar_ts.json` / `28_per_bar_pretty.json` | per_bar 全量（ts/score/signal/orders/events/warmup） |
| `27_kline_api_518880_1d.json` | `GET /api/kline?code=518880&period=1d&limit=1000`（1000 根 D1） |
| `29_window260_orders_events.txt` | 首窗逐 bar 的挂单/成交（证明"决策在 i、成交在 i+1 open"） |
| `30_metrics_raw.json` / `31_nav_last.txt` / `32_nav_first.txt` / `33_trades_pretty.json` | 指标/净值端点/唯一回合（含 commission=219.671） |
| `35_dca_strategy_rows.txt` / `36_dca_version_rows.txt` | 4 个定投策略与其版本（published / backtest_ok） |

### 分析与复算
| 文件 | 内容 |
|---|---|
| `26_batch_amounts.txt` | 逐笔成交额/批次金额**粗算（已废弃口径，仅留痕）**（文件头有说明） |
| `34_batch_amount_exact.py` / `_exact.txt` | **每窗 batch_amount 精确反算**（首窗 1000.000000 元 = 100,000/100） |
| `40_value_domain_enum.js` / `_enum.txt` | **值域穷举**（30,030,000 样本 → {50,75}，无 ≤40） |
| `41_index_phase_check.py` / `_check.txt` | **相位证据**（(idx%20<5) ≡ (score==75)；warmup 含 index；in-range 首根相位 10） |
| `42_policy_projection.py` / `_out.txt` | 独立复现 policy.rs 的 Dca 分支（模型自校验：复现 42 笔/43 意图） |
| `43_paper_engine.py` / `_out.txt` | **纸面引擎**（两个 run 净利均复现到 1e-4）+ `t3/i5`、`t5/i1`、`LumpSum` 推演 |
| `60_same_plugin_other_runs.txt` | 同插件的 73 条历史 run（作者 A 臂矩阵，均为 t3/i5 或 LumpSum） |
| `61_same_window_lumpsum_arm.txt` | **同区间 A1 臂实测**（`sr_1789738272901_000004`，净利 −11,563.8862） |
| `62_same_window_comparison.py` / `.txt` | 同区间两臂对照（含"投入 41.4% vs 99.98%"） |
| `63_author_A1A2_runs.txt` | 作者 4 年 A1/A2 平台实测（A2 满仓 26,496 股、净利 +140,554.70） |

### 外部文档与引用
| 文件 | 内容 |
|---|---|
| `50_design_01_copy.md` | `design/01-dca-strategy-family.md` 只读副本（作者工作区） |
| `51_design_03_copy.md` | `design/03-dca-policy-semantics-correction.md` 只读副本 |
| `52_author_source_dca_baseline.js` | 作者源文件（与库内 code 逐字节相同） |
| `53_external_docs_provenance.txt` | 外部文档/工具/源码的 sha256 + 本仓库 `git ls-files` 反证 |
| `54_reference_plugin_value_domains.txt` | S5 值域表（file:line） |
| `55_policy_equal_vs_fixed_refs.md` | S2 代码引用（Equal/FixedAmount、min_fee） |
| `56_publish_gate_refs.md` | S4 发布链路引用（门禁范围、无分布体检、approval_level 默认） |
| `commands.sh` | 本轮全部只读命令（可复跑） |

复核环境提示：`psql -At -c "select code ..."` 会在末尾多一个换行，做 sha256 比对时需
`head -c -1`（这正是 `12_sv_code.exact.txt` 存在的理由）；`encode(...,'base64')` 默认每 76 字符
换行，做批量 sha 比对时须 `replace(...,E'\n','')`（否则会得到假的 MISMATCH，见 `14_sha_audit.txt` 的说明）。

---

## 10. 角色报告（coder 交付物契约字段）

- **本文件位置**：`eestock-rs/coder/evidence/20260918_sr_trades_strategy_side/README.md`
  （同目录 `raw/` 为全部原始输出与分析脚本）
- **What changed（改了什么）**：**零代码改动、零库写**。仅**新增**本证据目录
  （`README.md` + `raw/` 48 个文件：命令输出、分析脚本、外部文档只读副本）。
  仓库内任何源码/迁移/web 资产均未触碰（`git status` 中本目录以外无本会话新增项；
  `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` 的未提交修改**先于本会话存在**，
  非本会话产物——本会话开始时（首条 `git status`）它已是 ` M` 状态）。
- **Architecture alignment（分层归属）**：无。本任务为只读取证，不涉及 layers/boundaries；
  证据落点遵循既有约定 `coder/evidence/<date>_<task>/`（与前一轮
  `coder/evidence/20260918_sr_trades_forensics/` 同构）。
- **Problem solved（解决了什么）**：把用户质问「策略写错了还是回测系统有问题」拆成 S1–S6 六个
  可复核判据，逐条给出判定 + `file:line`/命令证据 + 严重度 + 归属；结论为「两边都没写错，
  是本次 run 的 policy/区间用法 + 平台缺一层提交期体检」。
- **Implementation approach（方法）**：① 库内 code 与设计文档/作者源文件三方 sha256 比对；
  ② 用库内精确字节在 node 里穷举值域；③ 用 per_bar 挂单/成交反算每批金额与相位；
  ④ 写独立纸面引擎，先对**两个平台实测 run** 做 1e-4 级校验，再推演设计口径下的期望投入。
- **Test coverage（测试）**：不适用（只读任务，未新增/修改任何测试；未运行仓库测试套件，
  以避免任何构建产物/缓存写入——本目录外无文件被创建）。
- **Verification（验证方式）**：
  - 纸面模型 vs 平台实测：`sr_1789738328788_000005` 净利 −2,933.64791397129 ↔ −2,933.6479；
    `sr_1789738272901_000004`（同区间 LumpSum 臂）净利 −11,563.8862 ↔ −11,563.8862（见 `raw/43_paper_engine_out.txt`、`raw/62_same_window_comparison.txt`）。
  - sha256 一致性：24/24 版本 MATCH（`raw/14_sha_audit.txt`）。
  - 值域穷举：30,030,000 样本 → {50,75}（`raw/40_value_domain_enum.txt`）。
  - 复跑入口：`bash raw/commands.sh`（全部只读）。
- **只读纪律自检**：`git diff --cached` 为空；无 `UPDATE/INSERT/DELETE/DDL`；无 `git commit`。
