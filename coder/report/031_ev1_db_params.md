# Report 031 — EV-1 TimescaleDB DB 参数补齐（并发 kline 500 修复）

本报告路径：`eestock-rs/coder/report/031_ev1_db_params.md`
工作仓库：`/home/eestock/workspace/git/eestock/eestock-rs`

## 结论（TL;DR）
- 改动：仅 `eestock-rs/docker-compose.yml` 的 timescaledb 服务，在 `shm_size:"2g"` 后新增 `command:` 一行，追加 3 个 PG 参数。
- 授权修复（禁并行 + mmap）单独生效**无效**（并发 6/12/24/30 仍与基线逐位一致：6/6、2/12、4/24、0/30）。
- 经架构师裁决追加 `max_locks_per_transaction=512` 后，复测**全 200、无 500**，3 轮稳定。
- 真根因经 PG 日志证据修正：`out of shared memory` + HINT `You might need to increase max_locks_per_transaction.` → 主共享内存**共享锁表**耗尽，**不是**并行 worker 的 per-query DSA（初诊不成立）。

## What changed（改动 why）
| 项目 | 内容 |
|---|---|
| 文件 | `docker-compose.yml`（timescaledb 服务） |
| 位置 | 原有 `shm_size: "2g"` 之后 |
| 新增 | `command: ["postgres", "-c", "max_parallel_workers_per_gather=0", "-c", "dynamic_shared_memory_type=mmap", "-c", "max_locks_per_transaction=512"]` |
| 新增注释 | 三行中文注释（初诊 DSA 说明 + 禁用并行 + mmap 兜底） |
| 保留 | `shm_size:"2g"`（R1/R2 已暂存，原样保留） |
| 未改 | 其它服务 / 源码 / SQL / Rust / DB 数据 |

### 工作树 diff（我本次 unstaged 新增，R1/R2 的 shm_size 为先前 staged）
```
+    # EV-1（续）：并发 kline 仍 500（out of shared memory）——根因是 PG 并行 worker 的 per-query
+    # DSA 共享内存预算在 kline 并发下耗尽（kline 为 (code,ts) 索引点查，并行无益且正是 DSA 主体）。
+    # 禁用并行 worker 消除 DSA 分配；dynamic_shared_memory_type=mmap（文件后备）兜底。
+    command: ["postgres", "-c", "max_parallel_workers_per_gather=0", "-c", "dynamic_shared_memory_type=mmap", "-c", "max_locks_per_transaction=512"]
```

## Architecture alignment（分层）
- 归属层：**部署/基建层（docker-compose.yml）**。这是运行态 PG 参数注入，不触任何 `crates/*` 接口、事件契约或模块边界。
- 依赖方向不变：app/data 仍仅经 `timescaledb:5432` 依赖 DB；未新增服务、未删 redis/网络、未改 compose 服务拓扑。
- 无新依赖/框架/库。未 commit、未 stage（本次改动仅留 working tree）。

## Problem solved（解决的问题）
- 并发 `GET /api/kline?...&period=1m&limit=120` 在 6/12/24/30 并发下大量 500（`{"error":"internal error"}`，PG 底层 `out of shared memory`）。
- 通过禁用并行 worker（消除 per-query DSA）并加大共享锁表（max_locks_per_transaction）双保险，消除 500。

## Implementation approach（关键决策）
1. **先按授权初诊**（禁并行 `max_parallel_workers_per_gather=0` + `dynamic_shared_memory_type=mmap`）→ 重建复测。
2. **初诊失败**：参数已生效（SHOW 0/mmap）但 500 模式与基线逐位一致，证明 DSA 假设不成立。
3. **提交给架构师裁决**（need_decision）：附 PG 日志 `out of shared memory` + HINT `increase max_locks_per_transaction` 实锤。
4. **架构师批准方案 A**：追加 `-c max_locks_per_transaction=512`（512×100≈51200 锁槽，默认 64×100≈6400，内存开销几 MB，可逆）。
5. 保留已生效的 `max_parallel_workers_per_gather=0` 与 `dynamic_shared_memory_type=mmap`（无害，后续需恢复并行另议）。

## Test coverage（验证）
- 无自动化测试新增（纯部署参数改动）；验证以运行态行为为准。
- `docker-compose config` 语法校验通过。
- `SHOW` 参数复核：`max_locks_per_transaction=512`、`max_parallel_workers_per_gather=0`、`dynamic_shared_memory_type=mmap`。
- 并发 kline 复测 3 轮（6/12/24/30），全 200 无 500。
- app/data `/healthz`（8081/8080）均 HTTP 200。

## Verification（证据）
### 重建前后 PG 生效参数
| 参数 | 修复前 | 授权初诊后(0/mmap) | 最终(0/mmap/512) |
|---|---|---|---|
| max_parallel_workers_per_gather | 2 | 0 | 0 |
| dynamic_shared_memory_type | posix | mmap | mmap |
| max_locks_per_transaction | 64 | 64 | 512 |
| max_connections | 100 | 100 | 100 |
| shared_buffers | 128MB | 128MB | 128MB |

### 并发 kline 验收（`GET /api/kline?code=<code>&period=1m&limit=120`，目标 `http://localhost:8081`）
最终（3 轮一致，下面为代表性一轮）：
```
concurrency= 6  PASS  OK=6/6    500=0
concurrency=12  PASS  OK=12/12  500=0
concurrency=24  PASS  OK=24/24  500=0
concurrency=30  PASS  OK=30/30  500=0
ALL_PASS=True
```
（修复前基线：6→2/6、12→2/12、24→4/24、30→0/30。）

### 根因实锤（timescaledb stderr / PG 日志）
```
ERROR:  out of shared memory
HINT:  You might need to increase max_locks_per_transaction.
STATEMENT:
        SELECT code, ts, open, high, low, close, volume, amount, source
        FROM kline_merged
        WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
        ORDER BY ts DESC LIMIT $3
```
`out of shared memory` + `max_locks_per_transaction` HINT 是 PG 共享锁表（`LockAcquire`→`SetupLockInTable`）耗尽的专用报错，与并行 worker DSA 无关。

### /healthz（timescaledb 重启后 app/data 重连）
- `GET http://localhost:8080/healthz` → HTTP 200
- `GET http://localhost:8081/healthz` → HTTP 200
- app/data 容器状态：`Up (healthy)`；app 日志最近 100 行无 `out of shared memory` / `rest handler failed` / `internal error`。

### 重建 / 耗时
- 重建（最终版）到 healthy：约 6s（t=1 starting → t=3 healthy）。
- 最终并发验收单个档位耗时：6→1.72s、12→2.42s、24→3.72s、30→4.89s（本轮最大值，随并发升高而增加，属正常连接池排队）。

### compose 坑触发情况
- **触发**：`docker-compose up -d timescaledb` 在 recreate 时崩 `KeyError: ContainerConfig`（compose v1.29.2 已知坑），共触发 2 次（第 1 次初诊重建、第 2 次加 512 重建）。
- 处理：每次都出现孤儿容器 `<id>_eestock-timescaledb`，`docker rm -f <id>_eestock-timescaledb` 后重新 `up` 成功（第 1 次残留 0 个，末尾确认无 timescaledb 孤儿）。

## Residual risks（残留风险）
1. **慢查询隐患**：`kline_merged` 视图查询仍约 1s（app 日志 `slow statement ... 1.05s/1.10s`），属性能问题，本次验收仅要求无 500；若需提速要另开任务（与锁表/并行无关）。
2. **共享锁表仍有上限**：`max_locks_per_transaction=512 × max_connections=100 ≈ 51200` 锁槽。若未来 `max_connections` 大幅上调或长期高并发（>51200 同时持有的锁）仍可能耗尽，需再评估。
3. **`max_parallel_workers_per_gather=0`**：全局禁并行，对（如 cagg/复杂聚合）并行有益的查询被禁用；架构师点评"后续恢复并行可另议"，非本次决定。
4. `shared_buffers=128MB` 偏小，但本次未触达（非瓶颈）；若后续单请求大量排序/聚合可能成为新瓶颈。
5. 数据卷权限为 postgres 属主导致 `ls` 拒绝访问（`permission denied`），非问题；重建未动数据，`SELECT count(*) FROM symbols = 44` 正常。

## no commit / no stage
- 未 `git add`、未 `git commit`。
- `docker-compose.yml` 当前 git 状态为 `MM`：`M`（index/staged）= R1/R2 先前暂存的 `shm_size:"2g"`；`M`（working tree）= 我本次新增的 `command:`（未 stage）。R1/R2 已暂存状态原样保留，未被我改写。

## 复测脚本
- `/tmp/kline_concurrent.py`（并发状态码统计，非仓库文件）
- `/tmp/kline_error_body.py`（诊断 500 响应体，曾借以确认 app 层掩码为 `{"error":"internal error"}`）
