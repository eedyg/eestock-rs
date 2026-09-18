# 事故记录：TimescaleDB 后台 worker 槽位耗尽 → 生产 5m/15m 数据停摆 ~22 小时

- 发现：2026-09-18 用户报「5min/15min K 线变成 30min 才更新一次；计算的增幅也不正确了」
- 定位与处置：架构师（只读取证 + 经用户授权的删库/回填）
- 影响窗口：**2026-09-17 03:56:20Z → 2026-09-18 02:32Z（约 22.6 小时）**

## 1. 根因（证据链）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 所有 cagg 刷新作业自 **09-17 03:56:20Z** 起连续失败，无一成功 | `job_stats`：job 1000 失败 **75,173 次**（09-17 03:56:20Z → 09-18 02:09Z）；17 个 job 全部逾期 |
| 2 | 失败原因为 **worker 槽位耗尽** | PG 日志：`WARNING: failed to launch job N ...: failed to start a background worker` |
| 3 | `max_worker_processes = 8`，而 `timescaledb.max_background_workers = 16`（配置不一致） | `pg_settings` |
| 4 | **TimescaleDB 每库一个常驻 scheduler**，占 PG worker 槽位 | `pg_stat_activity`：6 个 `TimescaleDB Background Worker Scheduler`（各带 datname）+ 1 launcher = **7/8** |
| 5 | 其中 **4 个是 09-17 凌晨新建的隔离测试库**，时间点精确对上 | scheduler `backend_start`：`e6b_red_iso` 03:47:10 / `e6b_red_iso2` 03:50:36 / `adr023_e6b_gate_iso` **03:56:17.954** / `adr023_e6b_v3_test` 04:02:48；**生产 job 1000 最后一次成功 = 03:56:20.116Z（第 3 个库起来后 2 秒）** |
| 6 | 旁证：`eestock_test` 有 TSDB+17 job 但其 scheduler **一直起不来**；删库腾出槽位后**立刻自动起来**（pid 1767123） | `pg_stat_activity` 前后对比 |

## 2. 用户可见症状与机制

| 症状 | 机制 |
|---|---|
| 5m/15m「每 30 分钟才更新一次」 | `kline_5m`/`kline_15m` 物化 watermark 冻结在 09-17 03:30Z（未做物化）；只有「进行中桶」（查询期 rollup）在动。forming 桶聚合区间 = 桶起点→now ⇒ 15m 与 30m 的末根逐字段相同（实测一致） |
| 增幅不正确 | `prev_close` 取 D1 昨收（`reader.rs:151-177`），而 D1 cagg 同样停摆 ⇒ 昨收冻结为半成品 **8.864**；真实 09-17 收盘（accurate M1 15:00 CST）= **8.856** ⇒ API 显示 `change_pct=0.688%` 而真值 **0.779%** |

## 3. 处置（经用户授权）

| 步骤 | 动作 | 结果 |
|---|---|---|
| ① | `DROP DATABASE ... WITH (FORCE)` × 5：`e6b_red_iso` / `e6b_red_iso2` / `adr023_e6b_gate_iso` / `adr023_e6b_v3_test` / `eestock_d11_probe` | 占用 **7/8 → 3/8**；6 个作业立即转 `Success`（02:32–02:33Z） |
| ② | 手工 `refresh_continuous_aggregate` × 8（kline_5m/15m/1d + accurate_5m/15m/30m/1h/1d，窗口按桶边界对齐） | 每个 0.03–0.09 s；缺口填平 |
| ③ | 验证 | 见下表 |

**回填前后对照（518880 所在全量）**

| 项 | 回填前 | 回填后 |
|---|---|---|
| `kline_5m` 09-17 行数 | 1100（半天） | **2200（全天）** |
| `kline_15m` 09-17 行数 | 396（半天） | **792（全天）** |
| `kline_1d` 09-17 CST 收盘 | 8.864（错误） | **8.856 ✓** |
| API `change_pct` | 0.688%（错误） | **0.9485%**（last=8.94 vs 昨收 8.856 ⇒ 一致）✓ |

## 4. 为什么这些测试库没被清理（用户追问，逐条有据）

| # | 原因 | 原文证据 |
|---|---|---|
| 1 | **各车道只清"自己前缀"的库，对别人的明文"未动"** | `tester/evidence/adr023_e6b/verify/EVIDENCE.md:81-84`：「清理（无残留）：`LIKE 'e6b_verify%'` 返回空 ⇒ 自建库已彻底清理。**未动** `adr023_e6b_v3_test`，也**未动** `adr023_e6b_gate_iso / e6b_red_iso / e6b_red_iso2 / eestock_d11_probe`」 |
| 2 | **门禁语义只保证"不新增"，不管"不残留"** | `coder/report/295_...md:185`（附录 A.3 第 3 条）：「F2 采取的是「预检提前」而非「失败即 DROP」：只保证「源不可达**不留新库**」。**若库已存在（非本脚本创建）则无新库问题**」 |
| 3 | **"登记残留"替代了"清理残留"** | `tester/test/294_...md` §6：「残留登记（如实，逐条交叉引用）… 全部残留均**只登记、不修**」；并交叉引用 ADR-023 §6.1 第 8 条「测试隔离债」 |
| 4 | **工具本身不负责清理** | `scripts/tests/test_adr023_e6b_testdb_gate.sh` 内 **grep 不到 `DROP DATABASE`/`trap`/cleanup** —— 建库用工、退出不管 |
| 5 | **收尾动作最先被截断** | 车道常撞 30 分钟硬上限（ADR-023 §6.2 已记该教训），而清理排在最后一步 |
| 6 | 先例已被忽视 | 09-12 的 `eestock_d11_probe` 建库 README 第 4 步就写着「清理探针库：DROP DATABASE」；后续 ADR-023 D1 报告也点名「为开工前既有遗留」——**点出来了但无人删** |

## 5. 未完成（需用户决策）

| # | 项 | 说明 |
|---|---|---|
| ① | `max_worker_processes` 8 → **32**（≥ 16 + `max_parallel_workers` 8 + 余量） | **防复发**；需重启 PG 容器。当前虽已恢复，但 8 个槽位里 `eestock_test` 已常驻 1 个，"再建 5 个带 TSDB 的库"仍会重演 |
| ② | **观测告警**（TimescaleDB 作业层）：cagg watermark 滞后 + job 失败率 + 带 TSDB 的库数/槽位占用 | 本次 7.5 万次失败、22.6 小时停摆**无人知**；建议立 ADR-025 |
| ③ | 流程护栏：验收加"**本车道创建的隔离载体已不存在**"正向断言；隔离优先用 **schema 级**而非整库；门禁脚本加 `trap` 清理；清理不得置于最后一步 | 见 §4 |
| ④ | `eestock_test` 去留 | 它现在常驻占 1 个槽位（17 个 job）。若 tester 车道近期还要用则留，否则删 |

## 6. 证据文件清单

`tester/evidence/245_tsdb_worker_slot_incident/`
- `pre_state.txt`（删前库清单/槽位占用/配置）
- `pre_state_rowcounts.txt`（删前各库统计估算值 —— **注意：该视图为陈旧估算**，真实计数见下）
- `drop_commands.txt`（5 条 DROP 及输出）
- `post_state_t0.txt`（删后即时状态）
- `post_state_t1.txt`（等待 100s 后作业转 Success + 数据新鲜度）
- `gap_before.txt`（缺口量化）
- `backfill.txt`（8 条 refresh 及耗时）
- `post_backfill.txt`（回填后行数/昨收/API 增幅校验）
