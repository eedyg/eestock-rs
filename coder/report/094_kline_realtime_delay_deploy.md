# 094 — 5m/15m/1h 数据更新延时修复 `be07f1c` 部署/重启验证

> 本报告文件位置：`eestock-rs/coder/report/094_kline_realtime_delay_deploy.md`

## 需求/任务

部署 5m/15m/1h 更新延时修复 `be07f1c`（reader forming-bar + 迁移 0020 accurate cagg 刷新）。
只部署/重启，不改源码/DB 非迁移，不 commit。迁移 0020 已应用（复验确认）。

## 操作步骤（实际执行）

1. `cd /home/eestock/workspace/git/eestock/eestock-rs`，确认 HEAD=`be07f1c`（fix 已落盘），
   工作区无 tracked 改动。
2. 确认迁移 0020 已应用：`kline_accurate_5m/15m/1h` max=`2026-09-07 07:00:00+00`（与 M1 `kline_accurate` 一致）。
3. `docker-compose build app` → **成功**（exit 0，24s），新镜像 `eestock-rs_app:latest=fc3a7cf5a072`
   （旧 `47c00e49c72c`=56f88bd simlive fix）。Rust `storage`(reader.rs) 变更触发重编；release 编译 22.12s。
4. `docker-compose up -d app` → **复现** Docker29 + compose v1 崩溃 `KeyError: 'ContainerConfig'`。
5. 删孤儿 → `docker rm -f 4b4fc0f79a86_eestock-app`（崩溃遗留 Exited 容器，旧镜像 47c00e49c72c）。
6. `docker-compose up -d app` → 成功：`Creating eestock-app ... done`。

## 确认结果

### 镜像/容器
- `eestock-app`：id=`060a19010248…`，image=`eestock-rs_app:latest`（sha256:fc3a7cf5a072…，含 fix），
  `Up (healthy)`，restarts=0。
- 其它服务未受影响：`eestock-timescaledb`、`eestock-data` 均 Up healthy。
- `/healthz` → HTTP 200 `{"status":"ok"}`。
- 启动日志：`schema self-check ok`；`sim-live 启动恢复完成 recovered=1 degraded=0`。

### 5m/15m/1h near-live（延时是否 ≤1 桶）

`now=2026-09-08 02:55:29 UTC`：

| period | 最新 ts | 桶起点 = floor(now/period) | 与 now 差距 | 判定 |
|--------|---------|---------------------------|------------|------|
| 5m | `2026-09-08T02:55:00Z` | 02:55 | ~0.5 min（同一桶内） | ✅ ≤1 桶 |
| 15m | `2026-09-08T02:45:00Z` | 02:45 | 同一桶内 | ✅ ≤1 桶 |
| 1h | `2026-09-08T02:00:00Z` | 02:00 | 同一桶内 | ✅ ≤1 桶 |

- **forming 右缘随 live 前进（核心验证）**：5m 最新 ts 在 `now=02:54` 时为 `02:50`，在 `now=02:55` 时
  前进到 `02:55`（未闭合桶，由 `kline_raw` 最新分钟聚合）；不再停在上一闭合桶（修复前 5m 最多延迟 ~5min）。
- 原始分钟佐证：`kline_raw` 518880 最新桶 `02:55/02:56`（tencent_ifzq），forming 桶据此聚合。

### accurate cagg 覆盖（无 3 天 gap）
- API `/api/kline?code=518880&period=5m&before=2026-09-07T08:05:00Z&limit=1000` 返回 1000 根，
  **首 `2026-08-11T01:30:00Z` → 末 `2026-09-07T07:00:00Z`**；每天 50 根，覆盖
  `08-11…09-07`（周末 09-05/09-06 正确跳过，max_consecutive_gap_min=3990=周末隔夜，预期）。
- **旧 09-04 → 09-07 的 3 天 gap 已填平**：09-07 现有 50 根（修复前 accurate cagg 停在 09-04）。
- DB：`kline_accurate_5m/15m/1h` max=`2026-09-07 07:00:00+00`（已对齐 M1）。

### 既有回归
- `/api/symbols` → 200；`/api/backtest/runs` → 200；`/api/alerts` → 200。
- `/api/sim-live/sessions` → 200；`/api/sim-live/state` → 200；`/api/sim-live/strategies` → 200。
- `/healthz` → 200。
- app 日志 `--since 3m` 无 ERROR/PANIC/FATAL。

## 耗时
- 任务窗口约 `10:52 → 10:55`（~3 分钟）；其中 build 主耗时在 Rust release 重编（22.12s，cache 命中依赖），
  前端 build 命中 cache；两次 up 各 ~0–11s；healthcheck 即刻 healthy。

## compose 坑（与预期一致）
- Docker 29.1.3 + docker-compose 1.29.2（compose v1)`up -d app` 重建已有容器时读旧容器
  `image_config['ContainerConfig']` 崩 `KeyError: 'ContainerConfig'`（本次复现）。
- 规避：先 `docker rm -f <orphan>_eestock-app`（崩溃遗留 Exited 容器，旧镜像），再次
  `docker-compose up -d app` 走新建路径即成功。每次对已有容器重建都会重演，建议固定「先删孤儿再 up」。

## 残留风险
1. **accurate cagg start_offset 滞后复发**：5m/15m 刷新窗口(start_offset=2h/6h)仍小于单次 tushare
   回填批次跨度；若后续回填又带入窗口外旧桶，需再次运行 0020（或等价 CALL）。根治=加大 start_offset(≥2d)。
   （093 残留风险 #1，未一并改 DDL。）
2. **forming 桶依赖当前桶内有 raw 数据**：若当前桶无数据（采集瞬时滞后/收盘），forming_sql 返回空，
   右缘自然回退到最近可用桶（正确行为，非异常）。
3. **compose v1 + Docker29 重建重复崩溃**：后续对已有容器的 `up -d` 会再次 `KeyError`；固定「先删孤儿再 up」。
4. **`alert_store::list_events_filters` 既有失败**：共享生产库事件落入测试固定窗口，隔离性 test-debt
   （非本次 kline 引入；093 已记录）。
5. **sim-live 启动 recovered=1**：本次重启恢复出 1 个会话（非 kline 相关；正常恢复续跑，未降级）。

## 交付验证（change report 要求）
- changed-files：无源码更改。仅新增本报告 + 部署日志 `logs/app_be07f1c_build.log`/`_up.log`/`_up2.log`。
- tests-added：无（只部署）。既有 `crates/storage/tests/kline_reader.rs` 已含 forming 测试（093 新增并过）。
- commands-run：见「操作步骤/确认结果」。
- staged files：无（`git diff --cached --stat` 为空；`git diff --stat` 为空；未 commit）。
