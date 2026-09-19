# S4 发布链路「能不能发现永不卖出」取证（逐条 file:line）

## 1. 发布门禁 = 只做「能否实例化」两阶段冒烟

```
crates/application/src/strategy.rs:318-345
/// **发布门禁**：QuickJsRuntime 真实实例化冒烟（ADR 任务书口径）。
/// 两阶段：① 空参实例化（eval 源码 + on_bar 存在 + PARAMS_SCHEMA 解析）；
/// ② 按 schema 默认值填参再实例化（验证 init(params) 路径）。
/// 通过 → 插件声明的 schema；失败 → 错误描述（400）。
fn publish_smoke(code: &str, code_hash: &str) -> Result<Vec<ParamDef>, String> {
    let schema = { let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let inst = rt.instantiate(code_hash, code, &StrategyParams::new())
            .map_err(|e| format!("发布门禁未通过（eval/on_bar/schema 冒烟）: {e}"))?;
        inst.params_schema().to_vec() };
    { let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
      rt.instantiate(code_hash, code, &defaults_params(&schema))
        .map_err(|e| format!("发布门禁未通过（init(params) 冒烟）: {e}"))?; }
    Ok(schema)
}

crates/application/src/strategy.rs:576-596
pub async fn publish(&self, version_id: &str) -> ... {
    // 非 draft → 409；门禁失败 → 400
    let schema = blocking(move || publish_smoke(&smoke_code, &smoke_sha)) ...
```
⇒ **校验内容**：`eval` 源码可编译、`on_bar` 存在、`PARAMS_SCHEMA` 可解析、`init(defaults)` 不抛错。
**没有**：跑一根 bar、检查返回值分布、检查值域是否含买卖两侧、检查信号频率、检查与 policy 的兼容性。

## 2. MCP 工具描述自证门禁范围

```
crates/mcp/src/tools.rs:307-311
"name": "strategy_publish",
"description": "…发布门禁：QuickJS 真实实例化冒烟（eval + on_bar + PARAMS_SCHEMA + init(defaults)），
                不过 → isError；published 不可变，可被 bt_run_ensemble 运行。"
```

## 3. 宿主侧只 clamp，不做分布体检

```
crates/strategy-runtime/src/quickjs.rs:619-627
/// on_bar 返回值收敛（ABI G6）：有限数值 clamp [0,100]；NaN/无穷/非数值 → InvalidScore。
crates/strategy-runtime/src/types.rs:169-172
pub(crate) fn clamp_score(v: f64) -> f64 { v.clamp(0.0, 100.0) }
crates/strategy-core/src/aggregate.rs:105-114  (classify: ≥60 Buy / ≤40 Sell / else Hold)
```
⇒ 平台只保证分数落在 [0,100]；**不保证也不检查这张表上有没有卖点**。

## 4. 提交期（回测/试算）校验也没有「计划可完成性」检查

```
crates/strategy-core/src/engine.rs:92-116
pub fn validate(&self) -> Result<(), String> {
    // buy/sell_threshold 有限且 buy>sell、夹中立 50、initial_capital>0 → policy.validate()
}
crates/strategy-core/src/policy.rs:50-76
impl ExecutionPolicy::validate: Dca → 仅检查 tranches ≥ 1；FixedAmount → 检查 amount 为正有限。
                                          （**不检查 tranches 与任何策略参数/区间长度的关系**）
crates/application/src/workbench.rs:523      probe.validate()          // 即上面这个 validate
crates/application/src/strategy.rs:347-388   fill_and_validate_params  // 仅查 params 的 min/max/未知键
crates/application/src/strategy.rs:435-436   code.trim().is_empty()    // 仅查代码非空
```
⇒ `Dca{tranches:100, interval:1}` 配 `plan_bars:5 / cadence:20` 在 173 bar 区间上**最多只能完成 43 批**：
提交期无 400、无 warning、运行期无事件告警，只有事后从 fills 数出来才知道。

## 5. `approval_level='backtest_ok'` 是默认值，不是证据

```
crates/domain/src/strategy_state.rs:34-48   ApprovalLevel{BacktestOk,SimOk,LiveApproved} + 字符串映射
crates/domain/src/ports.rs:785              「新建版本…approval_level 默认 backtest_ok」
crates/domain/src/ports.rs:861              「新建 draft 版本（status='draft'、approval_level='backtest_ok' 默认）」
grep -rn "sim_ok|live_approved" crates/application/src crates/web/src crates/mcp/src  → 唯一命中是 mcp 测试
```
⇒ 没有任何应用代码会**基于回测结果**把级别抬到 sim_ok/live_approved；本 run 用的 4 个定投版本都是
`published / backtest_ok`（raw/36_dca_version_rows.txt），即「出厂默认标签」，不代表跑过任何回测。

## 6. 反证：仓库里唯一会检查「永不卖出」的东西，是策略作者自己的 harness，而且它断言的是反面

```
（外部工作区，非本仓库）/home/eestock/workspace/scrylink/eestock/eestock/tools/strategy_eval.py:350-354
    # 设计红线：定投族不主动清仓（退出交给运行级硬止损），因此不应出现卖出信号
    res.check("T5", "设计红线：全序列无卖出区分数（定投族不做主动清仓）",
              all(x > 40 for x in expect), f"卖出区 bar 数={...}")
```
⇒ 对 DCA 族而言「永不卖出」是**被断言的正确行为**；平台侧则**完全没有这种体检**。

## 7. 现实佐证：平台已接受过另一个「永不交易」插件

DB `strategy` 表（本轮只读查询）：`st_1789282702753_000004  15min 对照臂·永不交易  strategy  1 版本 / published`
（源码 `on_bar` 恒 `return 50`，见 raw/14_sha_audit.txt 中 sv_1789282702753_000005 的 code 字节）
⇒ 与 dca_baseline 同类的「结构上不可能交易」插件，都能一次通过发布门禁、零告警进目录。
