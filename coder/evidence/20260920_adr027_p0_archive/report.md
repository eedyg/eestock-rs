# ADR-027 §2.4 D3｜P0 历史数据归档与恢复校验报告

归档 **成功**；恢复校验 **通过**；临时库 **已清理**。

- 报告自身路径：`coder/evidence/20260920_adr027_p0_archive/report.md`
- 执行时间：2026-09-19T14:41:50Z ~ 2026-09-19T14:43:20Z（UTC）／2026-09-19 22:41~22:43 +08:00
- 边界纪律：全程**未执行** TRUNCATE / DELETE / DROP TABLE。唯一删除动作 = 隔离临时库 `tmp_p0_20260919t144215z` 的 `DROP DATABASE`，且在建库同一段流程（`verify_restore.sh`）内完成后**立即**执行。
- 备注（命名）：任务给定目录名为 `20260920_adr027_p0_archive`（按任务原文照用）；实际执行落在 UTC 2026-09-19 / CST 2026-09-19，两者相差为时区标注差异，非执行日期漂移。

---

## 1. 连接口径（事实源）

| 项 | 值 | 来源 |
|---|---|---|
| 宿主端点 | `127.0.0.1:5433` | `docker-compose.yml` ports `5433:5432` |
| 容器内端点 | `172.24.0.2:5432` | `inet_server_addr()` 实测 |
| 库 | `eestock` | `docker-compose.yml` `POSTGRES_DB` |
| 用户 / 口令 | `eestock` / `eestock` | `docker-compose.yml` `POSTGRES_USER/PASSWORD`；与 `scripts/testdb-init.sh` 默认一致 |
| Schema | `public` | `information_schema.tables` 实测 |
| 服务端版本 | PostgreSQL **16.15** (TimescaleDB 2.29.2-pg16 镜像) | `SHOW server_version` |
| 客户端版本 | psql/pg_dump/pg_restore **16.14** (Ubuntu) | 同主版本，兼容 |
| 访问方式 | 手工 `psql`（无 sqlx 迁移驱动） | 任务约定 + 脚本现状 |

连接验证：`SELECT current_database(), current_user, inet_server_addr(), inet_server_port();` → `eestock|eestock|172.24.0.2|5432`。

### 1.1 表名与所属库核实

8 张表全部存在且位于 `eestock.public`（与任务清单一致，无改名）：

```
 table_schema | table_name
--------------+---------------------
 public       | sim_positions
 public       | sim_trades
 public       | simsession
 public       | simsession_result
 public       | simsession_state
 public       | strategy_run
 public       | strategy_run_bars
 public       | strategy_run_result
```

---

## 2. Manifest（归档前基线快照）

- 文件：`manifest.tsv`（sha256 `5551905b386cc847e0def5b8c6c2d071d623e74fc866296971659496380263ed`）
- 采样方式：`BEGIN ISOLATION LEVEL REPEATABLE READ` 单事务内 8 表 `count(*)`，保证同快照一致。

| 表 | count |
|---|---:|
| strategy_run | 414 |
| strategy_run_result | 413 |
| strategy_run_bars | 1039 |
| simsession | 12 |
| simsession_result | 12 |
| simsession_state | 4 |
| sim_trades | 102 |
| sim_positions | 4 |

---

## 3. Dump 与 sha256

- 路径：`coder/evidence/20260920_adr027_p0_archive/eestock_adr027_p0_tables_20260919T144156Z.dump`
- 格式：`pg_dump -Fc`（custom），仅 8 表（`-t public.<table>` ×8），大小 **28,195,192 bytes**
- TOC：44 entries，含 8× `TABLE` + 8× `TABLE DATA` + 主键/索引/FK/序列
- **sha256**（在册，同时落 `*.dump.sha256`）：

```
37712b315390a0a2b02356ac745eb9b6f69ad1bdbb824cb54806e68755d86dfc  eestock_adr027_p0_tables_20260919T144156Z.dump
```

命令（可复现）：

```bash
pg_dump -h 127.0.0.1 -p 5433 -U eestock -d eestock -Fc \
  -t public.strategy_run -t public.strategy_run_result -t public.strategy_run_bars \
  -t public.simsession -t public.simsession_result -t public.simsession_state \
  -t public.sim_trades -t public.sim_positions \
  -f eestock_adr027_p0_tables_20260919T144156Z.dump
```

---

## 4. 目录项校验（pg_restore -l）

`pg_restore -l` 全量输出存 `toc.txt`。逐表 `TABLE DATA` 目录项命中：

| 表 | TABLE DATA 项 |
|---|---:|
| sim_positions | 1 |
| sim_trades | 1 |
| simsession | 1 |
| simsession_result | 1 |
| simsession_state | 1 |
| strategy_run | 1 |
| strategy_run_bars | 1 |
| strategy_run_result | 1 |

**MISSING=0**（8/8 表数据目录项齐全）。
附注：6 个 FK CONSTRAINT 的引用目标全部落在本 8 表集合内（`*_session_id_fkey → simsession`、`*_run_id_fkey → strategy_run`），**无外部依赖**，故隔离库整表恢复不会因缺引用表而失败。

---

## 5. 隔离库恢复校验（逐表比对）

脚本：`verify_restore.sh`（单段流程，含 trap 兜底 DROP）。日志：`restore_verify.log`。

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | `CREATE DATABASE tmp_p0_20260919t144215z` | OK |
| 2 | `pg_restore --no-owner --no-privileges --exit-on-error` | OK（无错） |
| 3 | 逐表 `count(*)` 比对 manifest | 8/8 PASS |
| 4 | **立即** `DROP DATABASE ... WITH (FORCE)` | OK |
| 5 | `psql -l` 残留检查 | NONE |

逐表比对明细：

```
PASS  strategy_run:         manifest=414  restored=414
PASS  strategy_run_result:  manifest=413  restored=413
PASS  strategy_run_bars:    manifest=1039 restored=1039
PASS  simsession:           manifest=12   restored=12
PASS  simsession_result:    manifest=12   restored=12
PASS  simsession_state:     manifest=4    restored=4
PASS  sim_trades:           manifest=102  restored=102
PASS  sim_positions:        manifest=4    restored=4
结果: ALL TABLES MATCH (8/8)
```

---

## 6. 源库未被改动（归档为只读动作）

归档与恢复校验全程对源库 `eestock` **零写**。校验后复测 count，与 manifest 完全一致：

```
sim_positions|4   sim_trades|102   simsession|12   simsession_result|12
simsession_state|4   strategy_run|414   strategy_run_bars|1039   strategy_run_result|413
```

⇒ 本刀**未执行任何清空动作**，TRUNCATE 留给下一波（需用户/父级批准）。

---

## 7. 临时库已清理的证据

- 脚本内联 `DROP DATABASE IF EXISTS "tmp_p0_20260919t144215z" WITH (FORCE);`（建库同段流程第 4 步，非留到最后）。
- 残留证明（`psql_l_after.txt`，`psql -l` 输出）：

```
$ psql -h 127.0.0.1 -p 5433 -U eestock -d postgres -l | grep -c tmp_p0
0
```

- 显式查询：`SELECT datname FROM pg_database WHERE datname LIKE 'tmp_p0_%';` → **空集**。
- `psql -l` 现存库仅：`eestock` / `postgres` / `template0` / `template1`（4 行，无 `tmp_p0_*`）。
- 结论：**无临时库残留**（既有历史测试库 `eestock_test` 等在本机并不存在，不在本次范围内）。

---

## 8. 证据清单（同目录）

| 文件 | 说明 |
|---|---|
| `report.md` | 本报告 |
| `manifest.tsv` | 8 表基线 count |
| `eestock_adr027_p0_tables_20260919T144156Z.dump` | 自定义格式归档（28,195,192 B） |
| `eestock_adr027_p0_tables_20260919T144156Z.dump.sha256` | 归档 sha256 |
| `toc.txt` | `pg_restore -l` 全量目录 |
| `verify_restore.sh` | 隔离库校验脚本（可复跑） |
| `restore_verify.log` | 校验执行日志 |
| `psql_l_after.txt` | 清理后 `psql -l` 快照 |
| `.dump_name` | 归档文件名指针（供脚本复用） |

---

## 9. 下一步（TRUNCATE 待批）

**不自动执行**。待用户/父级就 ADR-027 §2.4 D3 明确批准后，按「先归档后清空」顺序执行 TRUNCATE（保表结构与迁移链，**禁 DROP 表**）：

```sql
BEGIN;
TRUNCATE TABLE public.sim_positions, public.sim_trades, public.simsession_state,
                public.simsession_result, public.simsession,
                public.strategy_run_bars, public.strategy_run_result, public.strategy_run
  RESTART IDENTITY;
COMMIT;
```

（`RESTART IDENTITY` 用于同步重置 `sim_trades_id_seq`；如父级要求保留序列现值可去掉该子句。）

### 9.1 回滚命令

若清空后需回滚，用本归档恢复（**目标为活库 `eestock`，需父级批准**）：

```bash
export PGPASSWORD=eestock
# 校验归档完整性
sha256sum -c coder/evidence/20260920_adr027_p0_archive/eestock_adr027_p0_tables_20260919T144156Z.dump.sha256

# 恢复（清空后表结构仍在，故 --data-only --disable-triggers 以避开 FK 顺序问题）
pg_restore -h 127.0.0.1 -p 5433 -U eestock -d eestock \
  --data-only --disable-triggers --exit-on-error \
  coder/evidence/20260920_adr027_p0_archive/eestock_adr027_p0_tables_20260919T144156Z.dump
```

若表结构也被意外破坏（超出本刀授权范围），先用同 dump 的 schema 段恢复结构，再执行上面 data-only 恢复：

```bash
pg_restore -h 127.0.0.1 -p 5433 -U eestock -d eestock --schema-only \
  coder/evidence/20260920_adr027_p0_archive/eestock_adr027_p0_tables_20260919T144156Z.dump
```

恢复后逐表 count 应回到 manifest 值（见 §2）。
