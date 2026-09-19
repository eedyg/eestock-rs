# ADR-027 D3｜P0 历史数据清理报告（cutoff 切分）

> **完成判词**
> 归档复核 **通过** ｜ cutoff **2026-09-19T14:41:56Z** ｜ 旧数据已清 **是** ｜ v2 run 保留 **7 条**（与删除前**一致**） ｜ 回滚命令 **已给出**

- 报告自身路径：`coder/evidence/20260920_adr027_p9_purge/report.md`
- 执行时间（UTC）：2026-09-19T16:10Z ~ 16:15Z（约 5 分钟，硬上限 30 分钟）
- 边界纪律：**未执行** `DROP TABLE` / `DROP DATABASE`；**未执行任何 TRUNCATE**；删除均为带时间谓词的 DELETE。

---

## 0. 裁决记录（契约冲突 → 已上报并获批准）

任务原文要求「对 strategy_run 与 simsession 用 DELETE 加 `created_at` 小于 cutoff 条件」。实测 `public.simsession` **没有 `created_at` 列**（列为 `id,name,cash_init,strategy_set,stock_set,period,start_ts,end_ts,status,source`），只有 `strategy_run` 有 `created_at`。

已按角色纪律上报父级，**父级裁决 = Option A**：simsession 侧改用 `start_ts < cutoff`。

依据（实测）：`simsession.id` 形如 `s_<epoch>_<seq>`，其内嵌 epoch 与 `start_ts` **亚秒级相等**（12/12 行 delta < 1s）：

```
 s_1788766064_0 | start_ts 2026-09-07 07:27:44.034784+00 | id_epoch 2026-09-07 07:27:44+00 | delta 00:00:00.034784
 ...
 s_1789042836_0 | start_ts 2026-09-10 12:20:36.567277+00 | id_epoch 2026-09-10 12:20:36+00 | delta 00:00:00.567277
```

⇒ `start_ts` 是忠实的「会话创建时刻」代理，且谓词仍带时间守卫（非无谓词全表）。

---

## 1. 归档复核（删除前，PASS）

```
$ cd coder/evidence/20260920_adr027_p0_archive
$ sha256sum -c eestock_adr027_p0_tables_20260919T144156Z.dump.sha256
eestock_adr027_p0_tables_20260919T144156Z.dump: OK
```

在册 sha256：`37712b315390a0a2b02356ac745eb9b6f69ad1bdbb824cb54806e68755d86dfc`
归档大小：28,195,192 bytes；TOC 8/8 表数据项齐全。⇒ **归档可用，允许删除。**

**删除后复检（PASS）**：

```
$ sha256sum -c .../eestock_adr027_p0_tables_20260919T144156Z.dump.sha256
eestock_adr027_p0_tables_20260919T144156Z.dump: OK
```

⇒ 归档字节未变（清理全程只读归档）。

## 2. cutoff 的来源与换算

| 项 | 值 |
|---|---|
| 归档文件名 | `eestock_adr027_p0_tables_20260919T144156Z.dump` |
| 文件名内嵌 UTC 时间戳 | `20260919T144156Z` |
| **cutoff（UTC）** | **2026-09-19T14:41:56Z** |
| 换算（+08:00） | 2026-09-19 22:41:56 +08:00 |
| report.md 佐证 | 归档执行窗口 `2026-09-19T14:41:50Z ~ 14:43:20Z`；manifest 快照 `2026-09-19T14:41:50Z` |
| 语义 | cutoff = 归档动作时刻。`< cutoff` = 归档前数据（v1 口径，语义已失效，删）；`>= cutoff` = 归档后数据（v2 口径，**必须保留**） |

**一致性交叉验证（强证据）**：按 `< cutoff` 分区得到的旧数据行数与归档 manifest **逐表完全一致** ⇒ cutoff 取值正确：

| 表 | manifest（归档时） | 实测 `< cutoff`（旧） | 实测 `>= cutoff`（v2） | 现值（删前） |
|---|---:|---:|---:|---:|
| strategy_run | 414 | **414** | 7 | 421 |
| strategy_run_result | 413 | **413** | 5 | 418 |
| strategy_run_bars | 1039 | **1039** | 33 | 1072 |
| simsession | 12 | **12** | 0 | 12 |
| simsession_result | 12 | **12** | 0 | 12 |
| simsession_state | 4 | **4** | 0 | 4 |
| sim_trades | 102 | **102** | 0 | 102 |
| sim_positions | 4 | **4** | 0 | 4 |

⇒ 旧集 == 归档集（v1）；v2 集 == 归档后新增（7 run）。

## 3. 执行命令回显（purge_run.log）

连接：`psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -f purge.sql`（宿主端点见 docker-compose `5433:5432`）。
SQL 存档：`purge.sql`；原始输出：`purge_run.log`。单批次事务内完成两次删除。

```
BEGIN
--- BEFORE: strategy_run partition by cutoff (created_at < cutoff) ---
 is_old |  n
 f      |   7
 t      | 414
--- BEFORE: simsession partition by cutoff (start_ts < cutoff) ---
 is_old | n
 t      | 12
--- DELETE v1 strategy_run (created_at < cutoff); cascades to *_result / *_bars ---
DELETE 414
--- DELETE v1 simsession (start_ts < cutoff); cascades to *_result / *_state / sim_trades / sim_positions ---
DELETE 12
COMMIT
```

实际执行的删除语句（两条，均带时间谓词）：

```sql
DELETE FROM public.strategy_run WHERE created_at < timestamptz '2026-09-19T14:41:56Z';  -- DELETE 414
DELETE FROM public.simsession  WHERE start_ts   < timestamptz '2026-09-19T14:41:56Z';  -- DELETE 12
```

**禁用命令审计**（对 `purge.sql` 与 `purge_run.log` 全文扫描）：`DROP TABLE`=0、`DROP DATABASE`=0、`TRUNCATE`=0。⇒ 无禁命令回显。

## 4. 删除前后计数对照

### 4.1 主表（按谓词分区）

| 表 | 谓词 | 删前 `<cutoff` | 删前 `>=cutoff` | 删后 `<cutoff` | 删后 `>=cutoff` |
|---|---|---:|---:|---:|---:|
| strategy_run | `created_at < cutoff` | 414 | 7 | **0** | 7 |
| simsession | `start_ts < cutoff` | 12 | 0 | **0** | 0 |

### 4.2 全表计数（pre_counts.txt → purge_run.log AFTER）

| 表 | 删前 | 删后 | 差 |
|---|---:|---:|---:|
| strategy_run | 421 | 7 | -414 |
| strategy_run_result | 418 | 5 | -413 |
| strategy_run_bars | 1072 | 33 | -1039 |
| simsession | 12 | 0 | -12 |
| simsession_result | 12 | 0 | -12 |
| simsession_state | 4 | 0 | -4 |
| sim_trades | 102 | 0 | -102 |
| sim_positions | 4 | 0 | -4 |

**旧数据行数 = 0**（strategy_run 与 simsession 的 `<cutoff` 分区均空）⇒ 判据满足。

## 5. 级联删除对照（FK ON DELETE CASCADE）

| 级联表 | 父表 | 删前 | 删后 | 应删（父旧行） | 一致 |
|---|---|---:|---:|---:|:---:|
| strategy_run_result | strategy_run | 418 | 5 | 413 | ✔ |
| strategy_run_bars | strategy_run | 1072 | 33 | 1039 | ✔ |
| simsession_result | simsession | 12 | 0 | 12 | ✔ |
| simsession_state | simsession | 4 | 0 | 4 | ✔ |
| sim_trades | simsession | 102 | 0 | 102 | ✔ |
| sim_positions | simsession | 4 | 0 | 4 | ✔ |

⇒ 级联行为与预期完全吻合，无越界删除（v2 关联的 5 条 result + 33 条 bars 被保留）。

## 6. v2 run 保留清单（逐条集合比对）

删除前（`v2_runs_before.txt`）与删除后（`v2_runs_after.txt`）对 `created_at >= cutoff` 的 id 集合做**严格 diff**：

```
$ diff -u v2_runs_before.txt v2_runs_after.txt
DIFF: IDENTICAL (0 differences)
before_lines=7 after_lines=7
```

保留清单（删除后全表 `strategy_run` 亦恰为此 7 条，`all_runs_after.txt`）：

| # | id | created_at (UTC) | status |
|---|---|---|---|
| 1 | sr_1789831866857_000000 | 2026-09-19 15:31:06.857579 | failed |
| 2 | sr_1789831880929_000001 | 2026-09-19 15:31:20.929508 | failed |
| 3 | sr_1789832477006_000002 | 2026-09-19 15:41:17.006787 | succeeded |
| 4 | sr_1789832500924_000003 | 2026-09-19 15:41:40.924350 | succeeded |
| 5 | sr_1789832500958_000004 | 2026-09-19 15:41:40.977623 | succeeded |
| 6 | sr_1789832517708_000005 | 2026-09-19 15:41:57.708985 | succeeded |
| 7 | sr_1789832517800_000006 | 2026-09-19 15:41:57.800581 | succeeded |

**合计 7 条，删除前后 id 集合完全相同**（非「大概没少」）⇒ 判据满足。

## 7. VACUUM 建议（未执行，按任务可不执行）

删除后 `pg_stat_user_tables` 显示死元组：

```
 strategy_run        | live=7   (stats stale: n_live_tup=312) | dead=444
 strategy_run_bars   | live=33                            | dead=1049
 strategy_run_result | live=5                             | dead=486
 simsession          | live=0                             | dead=44
 simsession_result   | live=0                             | dead=22
 simsession_state    | live=0                             | dead=31
 sim_trades          | live=0                             | dead=134
 sim_positions       | live=0                             | dead=36
```

- **建议**：执行 `VACUUM (ANALYZE)`（非 FULL，非破坏性）以回收空间、刷新 `strategy_run` 等表的统计（当前统计仍为删前旧值，可能导致计划劣化）。
- **未执行**：任务明示「可不执行」，且本波授权仅限清理，故不擅自扩大动作范围。属**非阻断**项。
- 参考命令（如需）：
  ```bash
  PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d eestock \
    -c "VACUUM (ANALYZE) public.strategy_run, public.strategy_run_result, public.strategy_run_bars, public.simsession, public.simsession_result, public.simsession_state, public.sim_trades, public.sim_positions;"
  ```

## 8. 回滚方式（从 dump 精确恢复）

```bash
export PGPASSWORD=eestock
cd /home/eestock/workspace/git/eestock/eestock-rs

# (a) 先校验归档完整性（必须 OK 再继续）
sha256sum -c coder/evidence/20260920_adr027_p0_archive/eestock_adr027_p0_tables_20260919T144156Z.dump.sha256

# (b) 仅恢复本次被清的历史数据（表结构仍在；--data-only 避开 FK 顺序问题）
pg_restore -h 127.0.0.1 -p 5433 -U eestock -d eestock \
  --data-only --disable-triggers --exit-on-error \
  coder/evidence/20260920_adr027_p0_archive/eestock_adr027_p0_tables_20260919T144156Z.dump
```

- 恢复后逐表 count 应回到 manifest 值（见 §2 表右列）：`strategy_run=414, result=413, bars=1039, simsession=12, simsession_result=12, simsession_state=4, sim_trades=102, sim_positions=4`。
- 注意：本归档是**归档时刻的全表快照**，**不含**归档后新增的 7 条 v2 run（它们不在 dump 中，也未被删除，回滚不需重灌）。若恢复时与现存 v2 行主键冲突，`--exit-on-error` 会报错，可加 `--on-conflict-do-nothing` 语义处理（或先删冲突行）。v2 的 7 条 id 见 §6。
- 若表结构意外被破坏（超出本波授权，不在本次发生）：可先 `pg_restore --schema-only` 用同 dump 恢复结构，再执行上面的 data-only 恢复。

## 9. 证据清单

| 文件 | 说明 |
|---|---|
| `report.md` | 本报告 |
| `pre_counts.txt` | 删除前 8 表计数 + 按 cutoff 分区 |
| `purge.sql` | 实际执行的 SQL（两条带谓词 DELETE，单事务） |
| `purge_run.log` | 执行原始回显（含 BEFORE/AFTER 计数） |
| `v2_runs_before.txt` / `v2_runs_after.txt` | v2 保留清单（集合比对前后） |
| `all_runs_after.txt` | 删除后全量 strategy_run id |
