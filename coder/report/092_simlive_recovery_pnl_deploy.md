# 092 — sim-live 重启恢复账户 PnL 一致性修复 `56f88bd` 部署/重启验证

> 本报告所在文件：`eestock-rs/coder/report/092_simlive_recovery_pnl_deploy.md`

## 需求/任务

部署 sim-live 重启恢复账户 PnL 一致性修复 `56f88bd`（application 层，`crates/application/src/simlive.rs`
的 `restore_live_session` 持仓 `latest` 还原逻辑）。只部署/重启，不改源码/DB，不 commit。

## 操作步骤（实际执行）

1. `cd /home/eestock/workspace/git/eestock/eestock-rs`
2. 确认 HEAD = `56f88bd`（fix 已落盘），工作区无 tracked 改动。
3. `docker-compose build app` → 成功，新镜像 `eestock-rs_app:latest = 47c00e49c72c`（旧 `4326afb96060`）。
   Rust `application`（simlive.rs）变更触发重编；release 编译 21.85s，无 error/panic。
4. `docker-compose up -d app` → **复现** Docker29 + compose v1 崩溃
   `KeyError: 'ContainerConfig'`（`compose/service.py get_container_data_volumes` 读旧容器镜像 config）。
5. 删孤儿 → `docker rm -f 807660b4bce4_eestock-app`（compose 崩溃遗留的 Exited 容器，旧镜像 4326afb96060）。
6. `docker-compose up -d app` → 成功：`Creating eestock-app ... done`。
7. 复验 PnL 恢复（真机，session `s_1788802857_0`，2 次 docker restart）。

## 确认结果

### 镜像/容器
- `eestock-app`：`Up (healthy)`，`image=eestock-rs_app`（sha256:47c00e49c72cf63e…，含 fix）。
- 启动恢复日志：首个启动 `recovered=0 degraded=0`（基线干净，无遗留 running）；下会话后 restart#1/#2
  均 `recovered=1 degraded=0`（会话恢复续跑，非降级）。
- 其它服务未受影响：`eestock-timescaledb`、`eestock-data` 均 Up healthy。
- `/healthz` → HTTP 200 `{"status":"ok"}`。

### PnL 恢复 == 快照（核心验证点，session `s_1788802857_0`）

场景：start-session（2 策略，策略集含 510880/510050）+ 市价 buy 510880×3000（成交价 3.390678，fee 5.0）。

**快照 A（restart 前）：**
- `get_account`：cash=989822.966，market_value=0.0，unrealized_pnl=0.0（**运行期未 mark_to_market**，residual #1），
  equity=989822.966，realized=0.0，total_fee=5.0。
- `get_positions`（close 复算参考，自洽）：latest=3.39，avg_cost=3.390678，market_value=10170.0，**unrealized_pnl=−2.034**。
- `get_pnl`：unrealized=0.0，net_profit=0.0。

**restart#1 → healthy（~10s），recovered=1 degraded=0：**
- `get_account`：cash=989822.966，market_value=10170.0，**unrealized_pnl=−2.034**，equity=999992.966，
  realized=0.0，total_fee=5.0。
- `get_pnl`：**unrealized_pnl=−2.034，net_profit=−2.034**。
- `get_positions`：latest=3.39，unrealized_pnl=−2.034（与 get_account 同源自洽）。
- `/state`、`/pnl`、`/positions`、`/orders` 均 HTTP 200（**非 500**）；session.status=running。

**restart#2（幂等）→ healthy，recovered=1 degraded=0：**
- `get_account.unrealized_pnl` / `get_pnl.net_profit` 仍为 **−2.034**（**不累积、不漂移**）。

**结论：**
- **no −10172 漂移**：修复前恢复值 = −qty×avg_cost = −3000×3.390678 = **−10172.034**；现在 = **−2.034**
  （= 持仓视图 close 复算，正误小差异来自成交价 3.390678 vs 行情 close 3.39）。`−10172 → −2.03` 漂移消除。✓
- **跨重启幂等**：二次 restart 后仍 −2.034，不随组合累积（修复前 −10172→−16209）。✓
- **恢复自洽**：恢复后 `get_account.unrealized == get_positions(close 复算) == −2.034`。✓
- **`/state` 不 500**：恢复中/恢复后均 200；空闲时（无 running）为 404（预期，非 500）。✓

> 说明（residual #1，**非回归**）：restart 前 `get_account.unrealized=0.0`（运行期 `Position.latest`/`unrealized_pnl`
> 未 `mark_to_market` 刷新）；恢复后 = −2.034（close 复算）。二者差 −2.034，属报告 091 残留风险 #1
> 记录的已知行为（本 fix 只让「恢复后」自洽，未改运行期 get_account；e2e 亦作软断言观察）。若把「快照 A」
> 定义为正确 PnL 参考（get_positions close 复算 = −2.034），则恢复 get_account **== 快照 A** 成立。

### 清理
- `POST /api/sim-live/stop-session {session_id:s_1788802857_0}` → 200 `stopped:true`。
- DB `simsession` running=0；`simsession_state` 残留 1 行（已 ended 会话的 state，属正常落盘痕迹）。

### 回归
- `/healthz` → 200；`/api/sim-live/sessions` → 200；`/api/sim-live/sessions/{id}`（ended）→ 200；
  `/api/sim-live/state`、`/api/sim-live/strategies`（空闲）→ 404（预期，非 500）；`/api/symbols` → 200；
  `/api/backtest/runs` → 200；`/api/backtest/strategies` → 200；`/api/alerts` → 200。
- 全量 app 日志 ERROR/PANIC/FATAL = 0；无 `error=` WARN。

## 耗时
- 任务操作窗口约 `01:37:20 → 01:43:30`（约 6 分钟）；其中 build 主耗时在 Rust release 重编（21.85s，
  Docker cache 已命中大部分依赖）+ 前端 npm ci/vite（build 内含）；两次 restart 每次约 10–15s to healthy。

## compose 坑（与预期一致）
- Docker 29.1.3 + docker-compose 1.29.2（compose v1) `up -d app` 重建容器读旧容器
  `image_config['ContainerConfig']` 崩 `KeyError: 'ContainerConfig'`（本任务复现，报 090 同源）。
- 规避：先 `docker rm -f` 崩溃遗留的**孤儿容器**（`<id>_eestock-app`，Exited，旧镜像），再次
  `docker-compose up -d app` 走新建路径即可。每次对已有容器重建都会重演，建议固定「先删孤儿再 up」。

## 残留风险
1. **运行期 get_account 未打市值**（residual #1）：运行中且从未重启的会话，`get_account.unrealized=0.0`；
   本 fix 仅让「恢复后」自洽。彻底根治需运行期也 mark_to_market，超出本次「只改恢复计算」范围。
2. **恢复依赖行情源 close**：若 `kline` 未注入或某标的查询失败（返回 0），恢复回退落盘 `latest_prices`
   （历史遗留可能仍为 0 → −qty×avg_cost），但 `get_positions` 同样兜底 0，二者仍一致（自洽地缺价）。
3. **行情源演进导致快照歧义**：若恢复时行情 close 已前进（≠落盘时 latest），恢复值取当前 close，
   与「落盘时刻」快照可能略异；但与 `get_positions` 同源，UI 自洽。本次环境 close 静止（3.39）故未触发。
4. **`build_live_state` 未改**：落盘 `latest_prices` 仍可能残留历史陈旧 0，依赖恢复侧用行情源修正；
   若未来有直接读 `simsession_state.state_json` 的消费者需注意。
5. **compose v1 + Docker29 重建重复崩溃**：后续对已有容器的 `up -d` 会再次 `KeyError`；固定「先删孤儿再 up」。
6. **GitNexus 索引**滞后于本次部署无因果：本次未改任何源码，无需重建索引。

## 交付验证（change report 要求）
- changed-files：无（部署非源码变更；仅新增本报告 + `logs/app_56f88bd_build.log`/`_up.log`/`_up2.log`）。
- tests-added：无（只部署，不新增测试）。既有 `web/e2e/simlive-recovery.e2e.ts` T1~T4 覆盖恢复场景；本任务以 API 方式真机复现已达同样验证。
- commands-run：见「操作步骤/确认结果」。
- staged files：无（未 commit 未 stage；git status 无 tracked/staged 改动）。
