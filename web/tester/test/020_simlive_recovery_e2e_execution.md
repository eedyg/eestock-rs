# 020 · simlive-recovery e2e 执行报告（实时落盘 + 真机重启恢复续跑）

- 本文件位置（self-location）：`web/tester/test/020_simlive_recovery_e2e_execution.md`
- 配套 spec：`web/e2e/simlive-recovery.e2e.ts`（本文件即其执行记录）
- 设计稿：`web/tester/design/020_simlive_recovery_e2e_design.md`
- 运行环境：eestock-app 镜像 `4326afb96060`（healthy）/ SPA / http://127.0.0.1:8081 /
  DB eestock-timescaledb 127.0.0.1:5433；docker `restart eestock-app` 权限可用。
- 运行命令：
  `cd web && E2E_SHOTS=/tmp/simlive_recovery npx playwright test e2e/simlive-recovery.e2e.ts --workers=1 --retries=0`
- 运行时间：2026-09-08 01:18–01:20（CST；UTC 2026-09-07T17:18–17:20）；4 次真机 docker restart。

## 0. 结论摘要

| 用例 | 结果 | 说明 |
|---|---|---|
| R0 前置基线 | PASS | docker 可用、app healthy、无 running/state 残留、内存无 running |
| T1 实时落盘 | PASS | strategies(含 params/stocks/weights)+买 510880×3000 → simsession_state 完整运行态；feed process_bar 后 updated_at 前进 |
| T2 重启恢复（核心·真机） | **FAIL（软断言观察项）** | 恢复本身全部 PASS（running/不 500/持仓/订单/策略配置/DB state/续跑/再下单）；**账户级 PnL 与快照 A 不一致**：unrealized/net_profit 0 → −10172.034 |
| T3 幂等（二次重启） | **FAIL（软断言观察项）** | 无重复全部 PASS（orders/trades/positions/state 行数不变、cash 不双重扣款）；同一 PnL 根因使偏差累积：快照 B −10172.034 → 二次重启后 −16209.24 |
| T4 无 state→ended + ended 幂等 | PASS | 清空 state → restart → degraded=1 → ended+「恢复降级」注解、不 500；再 restart → recovered=0 degraded=0 |
| 清理 | PASS | 自建 2 会话全删（级联 state/result/trades/positions）；终态 running=0、state=0、ended=8（=基线） |

证据目录：`/tmp/simlive_recovery/`（evidence.json + 3 张截图：T2 恢复面板 / T3 幂等面板 / T4 idle）。

## 1. 运行证据（docker 启动恢复日志，4 次重启全命中预期）

```
17:19:04.xx  sim-live 启动恢复完成 recovered=1 degraded=0   ← restart#1（T2：有 state 会话被恢复）
17:19:24.xx  sim-live 启动恢复完成 recovered=1 degraded=0   ← restart#2（T3：二次重启仍恢复，幂等收敛）
17:19:43.xx  sim-live 启动恢复完成 recovered=0 degraded=1   ← restart#3（T4：无 state 会话降级 ended）
17:19:59.xx  sim-live 启动恢复完成 recovered=0 degraded=0   ← restart#4（T4：已 ended 不再收敛）
```
每次 restart → healthy ≈16s；`docker inspect` RestartCount=0、OOMKilled=false、ExitCode=0（无异常崩溃；重启均为本 spec 显式触发）。

## 2. 验收对照

1. **实时落盘** ✅：start(带 strategies: dual_ma{fast5/slow20, stocks[510880], weight2,
   stock_weights{1.5}}、macd{…, stocks[510050], weight0.5}) + place-order 买 510880×3000 →
   DB `simsession_state` 含 cash=989822.966、positions[510880@3.390678×3000]、orders[Filled]、
   net_value_series 初始点、strategy_configs(2 条含 params/stocks/weight/stock_weights)、
   trading_enabled=false、latest_prices；start→feed 评分→下单 三次落盘 updated_at 逐次前进（T1）。
2. **重启恢复（核心·真机）** ⚠️ 部分 FAIL：会话仍 running 且 id 不变；/state、/strategies、
   /positions、/orders、/pnl、/sessions/{id} 全 200（无 404「会话不存在」/无 500）；账户
   cash/equity/market_value/realized/total_fee、持仓(code/qty/avg_cost/latest 按 DB close 复算)、
   订单集、策略配置(含 params/stocks/weight/stock_weights)、DB state 核心字段、net_value_series 与
   快照 A **全部一致**；feed 续跑（/strategies 非空、state updated_at 再前进）、恢复后可直接再下单
   （买 510050×2000 → orders/trades/positions=2）。**不一致点（FAIL 上报）**：账户级
   `unrealized_pnl`/`net_profit` 快照 A=0 → 恢复后=−10172.034（持仓视图 un=−2.03 复算自洽，
   账户口径与持仓口径分歧）。
3. **无 state → ended** ✅：清空 running 会话 simsession_state → restart#3 degraded=1 →
   `/sessions/{id}` 200 ended + result.note「恢复降级…已标记 ended」+ metrics「中断…」；无 running 时
   /state、/strategies 缺省 404 idle（非 500）；不崩。
4. **幂等** ✅：restart#2 已恢复会话无重复（orders 2 / sim_trades 2 / sim_positions 2 / state 行 1、
   cash 未双重扣款）；restart#4 已 ended 会话 recovered=0 degraded=0（不再收敛）、注解不变。
5. **pageerror=0 / console.error=0** ✅：T2/T3/T4 三处 UI 段断言通过（重启窗口页面关闭，无网络断开
   类 console 错误混入）。

## 3. 发现（只上报，不改码）

### FINDING-1（验收 2 的 FAIL 项）账户级 PnL 跨重启不一致（恢复路径用 latest_prices=0 反推未实现盈亏）
- 现象（最小复现）：start(带 strategies) → 买 510880×3000 → `docker restart eestock-app` →
  `GET /api/sim-live/state`、`GET /api/sim-live/pnl`：
  - 快照 A：`account.unrealized_pnl=0`、`pnl.net_profit=0`（账户层持仓未打市值，latest=0）；
  - 重启恢复后：`account.unrealized_pnl=-10172.034`、`pnl.net_profit=-10172.034`；
  - 持仓视图 `/positions` 两侧一致：unrealized=−2.03（按 DB M1 close 3.39 复算自洽）。
  - 二次重启（T3，加入 510050×2000 后再重启）：−16209.24，偏差随持仓数累积。
- 根因线索（仅定位用，不改码）：`simsession_state.state_json.latest_prices` 落盘为 0.0
  （下单路径不把成交价写入 position.latest，live 路径无 mark_to_market）；
  `restore_live_session` 以 `latest=0.0` 反推 `unrealized_pnl=qty×(0−avg_cost)` → 大额负值。
  而账户级查询（get_account/get_pnl）读内存账户（不读 kline），与 PositionView（kline 复算）口径天然
  分歧，重启放大了该分歧。
- 建议决策归属：架构师（任务书：FAIL → 最小复现+证据交架构师自主决策）。证据见
  `/tmp/simlive_recovery/evidence.json`（observations 6 条）与下方证据细节。

### 观察-2 预检与流程噪声（非缺陷）
- feed 会对「无 orchestrator 的 running 会话」自动配置并每轮评估落盘；T4 退化夹具已用空标的集规避
  （避免删 state 后被 feed 5s 内重新写回）。
- Playwright 用例失败会回收 worker（新进程 + 旧 worker afterAll 清夹具）→ 本 spec 收敛为
  R0 + 单流程 test（软断言观察项继续执行完 T1→T4），证据在 test 内联落盘防覆盖。
- 复跑前若存在「DB 行已被删但应用内存仍 running」的残留，R0 会卫生重启一次清理（本轮未触发）。

## 4. 清理与基线恢复
- 自建夹具：`e2e-rec-t1-*`、`e2e-rec-t4b-*` 两会话 → 产品 stop + SQL 级联删除（台账 sql-ledger.md）。
- 终态复核：simsession running=0 / ended=8（=R0 基线）/ simsession_state=0；sim_trades、
  sim_positions 各 1 行、simsession_result 8 行均为基线既有（L4-f2 等 ended 会话遗留，非本 spec 产物）。
- 容器：eestock-app healthy（restart#4 后实例），DB 容器未受影响。
- git：无 staged 文件；新增/修改均为未跟踪产物（spec + design + 本执行报告），未 commit。

## 5. 复跑方式
```
cd web && E2E_SHOTS=/tmp/simlive_recovery npx playwright test e2e/simlive-recovery.e2e.ts --workers=1 --retries=0
```
预期：R0/T1/T4 PASS；T2/T3 因 FINDING-1 软断言 FAIL（evidence 记录 Δ；恢复/幂等/降级/清理各硬断言全 PASS）。
