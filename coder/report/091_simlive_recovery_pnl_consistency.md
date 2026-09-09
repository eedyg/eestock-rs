# 091 — sim-live 重启恢复：账户级 PnL（unrealized/net_profit）与持仓视图 close 复算自洽

> 本报告所在文件：`eestock-rs/coder/report/091_simlive_recovery_pnl_consistency.md`

## 需求/要解决的问题（深测发现）

sim-live 会话重启恢复后，**账户级 PnL 不一致**：
- 重启后 `get_account`/`get_pnl` 的 `unrealized`/`net_profit` 从 0 → **-10172.03**；
- 二次重启累积至 **-16209.24**；
- 而**持仓视图**按 DB close 复算自洽 **-2.03**。

恢复本身正常（状态 running / 不 500 / 续跑均通过），只有 PnL 计算错。只改 sim-live，TDD，不 commit。

## 根因

追踪 `SimLiveService` 的恢复路径 `recover_sessions → restore_live_session`：

1. **落盘侧 `build_live_state`**：构建 `SimSessionState.latest_prices[code]` 时取**内存 `position.latest`**。
   `Position.latest` 仅由 `mark_to_market` 刷新；而 sim-live 运行期（feed → `process_bar`、手动 `place_order`）
   **从不调用 `mark_to_market`**（服务级 `mark_to_market` 仅被测试调用）。`apply_fill` 新建/更新持仓时
   `latest` 置默认 `0.0`。于是 `latest_prices[code] = 0.0` 落盘。
2. **恢复侧 `restore_live_session`**：重建每仓时
   `latest = latest_prices.get(code).unwrap_or(0.0) = 0.0`，随后
   `unrealized = qty × (latest − avg_cost) = qty × (0 − avg_cost) = −qty × avg_cost`（**大额漂移**）。
3. **二阶（二次重启累积）**：恢复后每仓 `latest` 仍为 `0.0`，会话继续运行累积更多资产/仓位（持仓市值越大，
   `−Σ(qty×avg_cost)` 越负），再次落盘仍存 `0.0` → 二次重启数值更负（-10172 → -16209），语义上
   **不是重复计入，而是「误用 0 价 → 漂移随组合增长」**。

结论：①「重建时未按真实 latest mark_to_market，误用 0」是主因；② net_profit 基于错误的 unrealized 累积；
③「重复计入」表象实为漂移随组合叠加，非重复加总。持仓视图走 `get_positions → resolve_latest_price`
（KlineRead::latest_bar close），故自洽 -2.03。

> 佐证：`design/07-app-plane/00-web-api.md`/报告 089 残留风险 #5 已注明「mark_to_market 不即时落盘 →
> persist 读到陈旧 latest」——本 bug 即该残差的实测暴露。

## 修复（仅改 sim-live 恢复计算）

`crates/application/src/simlive.rs` 的 `restore_live_session`：重建每仓 `latest` 时
**优先用行情源 close（`resolve_latest_price`，与 `get_positions` 同源）**，仅当行情源无值（未注入/
查询失败返回 0）才回退落盘 `latest_prices`；仍无 → 0.0（与持仓视图缺行情兜底一致）。

```rust
let period = dom_period_from_str(&view.period).unwrap_or(domain::types::Period::M1);
for row in &state.positions {
    let persisted = state.latest_prices.get(&row.code).copied().unwrap_or(0.0);
    let quote = self.resolve_latest_price(period, &row.code).await;
    let latest = if quote != 0.0 { quote } else { persisted };
    account.positions.insert(..., Position { ..., latest,
        market_value: row.qty * latest, unrealized_pnl: row.qty * (latest - row.avg_cost) });
}
```

- 恢复后账户 `unrealized = Σ(qty×latest) − ... = Σ qty×(quote − avg_cost)`，与 `get_positions`（close 复算）**同源自洽**。
- 恢复后 `position.latest` 已为真实 close，会话继续运行再落盘会把正确最新价写入 `latest_prices`，
  二次重启不再漂移、不累积。
- 不改 `build_live_state`（落盘侧）/ 不改接口/不改 backtest / 不触真实券商。

## TDD Red → Green

在 `crates/application/tests/simlive.rs` 新增 2 测试（`--test simlive`）：

- `recover_after_unmarked_positions_pnl_matches_position_view`
  - **Red**（修复前，断言失败）：`expected 998.000... got -10001.999...`（恢复后 unrealized=-10002，
    而持仓视图 close 复算=998）。
  - **Green**（修复后）：恢复后 `get_account.unrealized` / `get_pnl.unrealized` / `get_pnl.net_profit`
    == 持仓视图 close 复算值；二次恢复（新实例再 recover）不累积/不翻倍。
- `recover_reproduces_persisted_pnl_snapshot`
  - 回归守卫：预置完整 `SimSessionState`（cash/positions(latest_prices=11)/realized=200）→ recover →
    `get_account.realized=200`、`unrealized=Σ qty×(11−10)=1000`、`get_pnl.net_profit=200+1000`；
    二次恢复值一致、cash 不变。该用例修前即绿，用于锁定「纯落盘还原」不回归。

## 验证

- `cargo test -p application --test simlive` → **37 通过**（新增 2 + 原有 35）。
- `cargo test -p simlive` → 28 通过（纯逻辑，未改动，回归确认）。
- `cargo test -p storage --test sim_store` → 6 通过。
- `cargo test -p web` → 36 通过。
- `cargo test --workspace --no-fail-fast` → **唯一失败 `storage::alert_store::list_events_filters`**
  （alert 功能、固定时间戳 + 共享持久 PG 的数据污染，与 sim-live 无关，属既有需剔除项）；
  其余全部通过。application 集成测试（37）与 simlive（28）全绿。
- `entangled tangle` → 幂等：重复执行后 `eestock-rs` 内**无新增 tracked 改动**；
  本 2 文件为**手写非 tangle**（无 `<<design` / `~~~ begin` 标记），tangle 不生成/不覆盖。

## 残留风险

1. **未打市值的「运行中且从未重启」会话**：若会话从未触发恢复，`get_account` 仍返回 `unrealized=0.0`
   （内存 `Position.unrealized_pnl` 未被 mark_to_market 刷新），与 `get_positions` 的 close 复算不一致。
   本修复仅让「恢复后」自洽；要彻底根治需在运行期也 mark_to_market 或让 `get_account` 同源 close——
   超出「只改恢复计算」范围，未做。
2. **恢复依赖行情源 close**：若 `kline` 未注入或某标的查询失败（返回 0），恢复仍回退落盘 `latest_prices`
   （可能仍为 0 → −qty×avg_cost），但此时 `get_positions` 同样兜底 0，二者仍**自洽**（一致地缺价）。
3. **行情源演进导致快照歧义**：若恢复时行情源 close 已前进（≠落盘时 latest），恢复值取行情源当前 close，
   与「落盘时刻」快照可能略异；但与 `get_positions` 同源，UI 自洽。此为取舍，优先自洽。
4. **`build_live_state` 未改**：落盘 `latest_prices` 仍可能为陈旧 0（历史遗留 state），依赖恢复侧用行情源
   修正。若后续有直接读 `simsession_state.state_json` 的消费者，需注意其可能残留 0。
5. **gitnexus CLI 不可用/超时**：`npx gitnexus analyze` 在本机超时（索引起始/大），未能跑 impact/detect；
   以手工 impact 分析 + 全工作区测试（含恢复路径）替代。改动仅触及 `application` 私有方法
   `restore_live_session`（唯一调用方 `recover_sessions`），不扩接口、不影响其它 crate。

## 暂存文件清单（已 `git add`，未 commit）

- `crates/application/src/simlive.rs`（修复 `restore_live_session` 持仓 latest 还原）
- `crates/application/tests/simlive.rs`（新增 2 测试：恢复自洽 + 落盘快照回归）

> 注：`web/e2e/sql-ledger.md` 为工作区已有的、与本次无关的改动；**不**纳入本次暂存。
