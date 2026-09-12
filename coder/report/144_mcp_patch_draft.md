# 144 · MCP 层补丁草案（I-2/I-3/I-6 收口，待放行 design/07-app-plane/01-mcp.md 写入权）

> 报告文件位置（self-reference）：`coder/report/144_mcp_patch_draft.md`
> 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
> 状态：**已全部应用（2026-09-12 10:33Z）**——架构师释放文档写入权后，本 worker 已按本草案
> read-modify-write `design/07-app-plane/01-mcp.md` + `entangled tangle`，并补齐 A1 未竟项；
> 结果见 `coder/report/144_backtest_warmup_fee_h1.md` §10。本文件保留为补丁草案存档（勿再重复应用）。
>
> 依赖：本草案只改 MCP 契约层。`crates/backtest`、`crates/strategy-core`、`crates/application`、
> `crates/web` 侧 I-6/H1、I-2 warmup、I-3 fee/policy/capital **已落地且测试全绿**（见
> `coder/report/144_*.md` 主报告）。

---

## 1. `strategy_test_run` inputSchema 增 4 项属性

在 `design/07-app-plane/01-mcp.md` 的 `strategy_test_run` `inputSchema.properties` 中，
于 `"params"` 之后追加（JSON 片段，保持既有风格）：

```json
"warmup_bars": { "type": "integer", "description": "前置预热根数（I-2/D6；默认 250，0=不预热）。服务层向前多取历史后按 from 切分；历史不足时响应回显 warmup_effective < warmup_requested（silent shortfall 可见）。" },
"fee": { "type": "object", "description": "{rate_pct, min_fee, slippage_bp, stamp_duty_pct?}；缺省 {0.025, 5.0, 2.0}（ADR bt-1）。⚠️ 缺省 stamp_duty_pct=0.05 为 A 股股票口径兼容值——ETF/LOF 无印花税，须显式传 stamp_duty_pct:0；值域 [0,1]。与 bt_run_ensemble 同 to_fee_model 口径，响应回显生效 fee。" },
"policy": { "type": "object", "description": "ExecutionPolicy（与 bt_run_ensemble 同 JSON 口径）：{\"LumpSum\":{\"position_pct\":0..1}} 或 {\"Dca\":{\"tranches\":..,\"mode\":..,\"amount\":..,\"interval\":..}}；缺省 LumpSum 全仓。" },
"capital": { "type": "number", "description": "初始资金，默认 100000（与回测 ADR §4 一致）。" }
```

并更新 `strategy_test_run.description`（并入两处口径句）：
- 「区间上限：D1/H1≤5年 / 分钟级≤3个月」（I-6：补 H1）。
- 「sim_position 默认 60/40 阈值 + LumpSum 全仓 + 缺省 fee 0.05% 佣金/5 元最低/2bp 滑点/0.05% 印花税（ETF 须显式传 0）；可经 fee/policy/capital/warmup_bars 覆盖」。

> 说明：`required` 不变（新参数全部可选，兼容既有调用）。

---

## 2. `strategy_test_run` handler 解析（补丁代码）

在 `async fn strategy_test_run(...)` 内、构造 `TestRunRequest` 之前追加：

```rust
// I-2/D6：前置预热根数（缺省 250；0=不预热）。
let warmup_bars = match args.get("warmup_bars") {
    None => DEFAULT_TEST_RUN_WARMUP_BARS,
    Some(v) => match v.as_u64() {
        Some(n) => n as usize,
        None => return result_err(id, INVALID_PARAMS, "warmup_bars 须为非负整数"),
    },
};
// I-3/D6：fee/policy/capital（缺省与 bt_run_ensemble 同口径）。
let fee = args.get("fee").cloned().unwrap_or_else(default_test_run_fee);
if !fee.is_object() {
    return result_err(id, INVALID_PARAMS, "fee 须为 object");
}
let policy = args
    .get("policy")
    .cloned()
    .unwrap_or_else(|| json!({ "LumpSum": { "position_pct": 1.0 } }));
if !policy.is_object() {
    return result_err(id, INVALID_PARAMS, "policy 须为 object");
}
let capital = match args.get("capital") {
    None => DEFAULT_TEST_RUN_CAPITAL,
    Some(v) => match v.as_f64() {
        Some(n) if n.is_finite() && n > 0.0 => n,
        _ => return result_err(id, INVALID_PARAMS, "capital 须为正有限数值"),
    },
};
```

并把 `TestRunRequest { ... }` 构造补齐 4 个新字段：

```rust
let req = TestRunRequest {
    source,
    params,
    symbol: symbol.to_string(),
    period: period.to_string(),
    from,
    to,
    mode,
    warmup_bars,
    fee,
    policy,
    capital,
};
```

板块级常量（放在 `default_fee_json`/`valid_bt_period` 附近，与 `bt_run_ensemble` 缺省对齐）：

```rust
/// 试算缺省前置预热根数（I-2/D6 架构师裁决，与 application::workbench::DEFAULT_WARMUP_BARS 同值）。
pub const DEFAULT_TEST_RUN_WARMUP_BARS: usize = 250;
/// 试算缺省初始资金（与回测 ADR §4 一致）。
pub const DEFAULT_TEST_RUN_CAPITAL: f64 = 100_000.0;
/// 试算缺省费用（ADR bt-1；缺省 stamp_duty_pct=0.05 为股票口径兼容值，ETF/LOF 须显式传 0）。
fn default_test_run_fee() -> Value {
    json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 })
}
```

> 注：`params` 变量在现有 handler 中已存在（`args.get("params")` 解析）；上片段引用之。
> `fee` 若为 object 但字段缺失/越界，由服务层 `to_fee_model` 返回 `StrategyValidation` → isError（与 bt_run_ensemble 同）。

---

## 3. `bt_run_ensemble` inputSchema 增 `warmup_bars` + handler 透传

Schema（`bt_run_ensemble` properties 内，`initial_capital` 之后）：

```json
"warmup_bars": { "type": "integer", "description": "前置预热根数（I-2/D6；默认 250，0=不预热）。服务层向前多取历史后按 from 切分；warmup 段不执行 Policy、不计净值/绩效；config 钉住 warmup_requested/effective 并逐 bar 标记 warmup。" }
```

handler（`async fn bt_run_ensemble`）在构造 `SubmitRunReq` 前追加，并补字段：

```rust
// I-2/D6：前置预热根数（缺省 250）。
let warmup_bars = match args.get("warmup_bars") {
    None => DEFAULT_TEST_RUN_WARMUP_BARS,
    Some(v) => match v.as_u64() {
        Some(n) => n as usize,
        None => return result_err(id, INVALID_PARAMS, "warmup_bars 须为非负整数"),
    },
};
let req = SubmitRunReq {
    name,
    symbol: symbol.to_string(),
    period: period.to_string(),
    from,
    to,
    slots,
    buy_threshold,
    sell_threshold,
    policy,
    stop: args.get("stop").cloned(),
    initial_capital,
    fee,
    warmup_bars,
};
```

> `SubmitRunReq` 已在 application 层新增 `warmup_bars: usize` 字段（本批已完成）。
> `bt_get_run` 的 `run.config` 现回显 `warmup_requested`/`warmup_effective` 与**生效** fee
> （含 `stamp_duty_pct` 实际取值，缺省 0.05 可见）——I-3 硬要求①，无需 MCP 侧额外改动。

---

## 4. MCP 测试断言增补清单（放行后并入 tools.rs 的 `#[cfg(test)]`）

在 `design/07-app-plane/01-mcp.md` 的 MCP 测试 chunk 中增补（与既有风格一致）：

1. **H1 正向**：`strategy_test_run` 与 `bt_run_ensemble` 各增一例 `period:"H1"` 调用，
   断言 `r["error"].is_null()` 且 payload `period=="H1"`；并把原以 `"1h"` 作「非法周期」样例的两处
   改为 `"W1"`（既有断言仍拒）。（I-6/D3；已在先行 tangle 中完成，放行后确认保留。）
2. **I-3 fee/policy/capital**：`strategy_test_run` 增例——
   - 缺省调用响应 `fee.stamp_duty_pct == 0.05` 且 `fee.rate_pct == 0.025`；
   - 传 `fee={"...","stamp_duty_pct":0.0}` → 响应 `fee.stamp_duty_pct==0.0`，且成交 `stamp_duty` 合计为 0；
   - 传 `capital=200000` → 与缺省结果不同（trades shares 增大）；
   - 传 `policy={"Dca":{"tranches":3,"mode":"Equal","amount":null,"interval":1}}` → 与缺省 LumpSum 的回合 shares 不同；
   - 非法 `fee`（缺字段）/非法 `policy`/`capital<=0` → isError（服务层校验）。
3. **I-2 warmup**：`strategy_test_run` 增例——
   - `warmup_bars=0`：`warmup_effective==0`，无 warmup 标记；
   - 构造可切分区间 + `warmup_bars=k`：响应 `warmup_requested==k`、`warmup_effective<=k`、
     前 `warmup_effective` 根 `scores[*].warmup==true` 且 `signals[*].warmup==true`，其余 false；
   - `bt_run_ensemble` 提交带 `warmup_bars` → `bt_get_run.config.warmup_requested/effective` 回显；
     `bt_get_run_result.per_bar[*].warmup` 逐 bar 标记，`net_value.len() == in-range 根数`。
4. **schema 契约**：`tools/list` 中 `strategy_test_run.inputSchema.properties` 含
   `warmup_bars/fee/policy/capital`；`bt_run_ensemble` 含 `warmup_bars`（`required` 不含新项）。

---

## 5. 放行后的执行序（避免与 A1 相互覆盖）

1. 确认 A1 已回报「文档+tangle 落到编译可通过」。
2. `git diff` 备份当前 `design/07-app-plane/01-mcp.md`（保留 A1 改动基线）。
3. 仅追加上述 §1–§3 片段（read-modify-write，不动 A1 的 list_symbols / get_kline / strategy_list 段）。
4. `entangled tangle`（全量再生 `crates/mcp/src/tools.rs`）。
5. `cargo test -p mcp --lib` + `cargo check --workspace --all-targets`；确认 A1 编译错已消且测试全绿。
6. 更新主报告 144 的 MCP 段与证据。
