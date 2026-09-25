# 05-deploy-runbook — ADR-024 上线手册（migrate 0027 + P4 + P6 + P5；可选 + P4b）

> 状态：**待用户批准执行**。所有阶段已冻结并经 tester 独立验收；本手册只描述**运维动作**（应用迁移 / 重建重启 / 冒烟 / 回滚），不改代码。
> 适用批次：`migrate 0027(含 fills)` + **P4**（分块落库/端点）+ **P6**（前端取数路径）+ **P5**（去日历档/收缩/结构化错误）。
> **硬门槛（不可违反）**：`0027` 与 P4 **不得单独上线**（P4 后新 run 为 `chunked_v1`，前端未适配 ⇒ 净值/回撤图静默空、逐表只显前 5000 根）。⇒ 本批次必须**同时**含 P6。

---

## 0. 前置检查（执行前逐条打勾）

| # | 检查 | 命令/判据 |
|---|---|---|
| 1 | 工作区 = 冻结态（无未预期改动） | `git status --short`；`git diff --cached --name-only \| wc -l` |
| 2 | 门禁全绿 | `./scripts/check-tangle.sh`；`cargo test -p storage -p application -p web -p mcp`（需临时库：`EESTOCK_TEST_DB_NAME=tmp_deploy_<ts> scripts/testdb-init.sh`）；前端 `npx vitest run` + `tsc -b` + `npm run build` |
| 3 | 备用回滚件 | 当前 app 二进制 + `web/dist` 备份到持久路径（**勿放 /tmp**），记 sha256 |
| 4 | 迁移文件就绪 | `migrations/0027_strategy_run_result_chunks.sql` 存在且由 tangle 生成（含 `kind … 'fills'`） |
| 5 | 时间窗 | 避开采集高峰期；预计停机 < 2 分钟（仅 app 重启，DB 不重启） |

---

## 1. 阶段 A：应用迁移 0027（DB，先做）

> 顺序硬约束：**先落迁移、再重启 app**（新二进制的 `migrate_check::EXPECTED_RELATIONS` 含 `strategy_run_bars`，缺关系会拒绝启动）。

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs

# A1 迁移前状态（留证）
docker exec eestock-timescaledb psql -U eestock -d eestock -c \
  "SELECT to_regclass('public.strategy_run_bars') AS bars_table, \
          (SELECT count(*) FROM information_schema.columns \
            WHERE table_name='strategy_run_result' AND column_name='result_format') AS fmt_col;"
# 期望：bars_table = (null)、fmt_col = 0

# A2 应用（additive：仅加列 + 建表；无数据变更）
docker exec -i eestock-timescaledb psql -U eestock -d eestock -v ON_ERROR_STOP=1 \
  < migrations/0027_strategy_run_result_chunks.sql

# A3 迁移后核验（留证）
docker exec eestock-timescaledb psql -U eestock -d eestock -c \
  "SELECT to_regclass('public.strategy_run_bars') AS bars_table, \
          (SELECT count(*) FROM information_schema.columns \
            WHERE table_name='strategy_run_result' AND column_name='result_format') AS fmt_col;" \
  -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='strategy_run_bars'::regclass;"
# 期望：bars_table = strategy_run_bars、fmt_col = 1、CHECK 含 'fills'
```

**回滚（A）**：`DROP TABLE strategy_run_bars; ALTER TABLE strategy_run_result DROP COLUMN result_format;`（在新 run 写入前执行是安全的）。

---

## 2. 阶段 B：重建 + 重启应用（8081/8082）

> 按仓内既有技能 `rebuild-restart-app-8081`：**先留回滚件 → 构建 → kill+nohup 重启 → 冒烟**；来源可追溯必须写明「**工作区 = HEAD + staged 批次**，不是 HEAD」。

```bash
# B1 回滚件（记 sha256）
cp -p target/debug/eestock-app  <持久备份路径>/eestock-app.pre-adr024-deploy
sha256sum target/debug/eestock-app | tee -a <持久备份路径>/deploy_hashes.txt

# B2 构建（含本批次；前端产物同批重建）
cargo build -p app           # 或在仓内既有脚本下执行
cd web && npm run build && cd ..     # 产出 web/dist（由 app 托管）

# B3 重启（按技能脚本/流程；8081 与 8082 一并）
#   kill <old_pid>; nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml > logs/app_8081.log 2>&1 &
#   （8082 同法，若该实例属于本机 dev 拓扑）

# B4 来源留证
git rev-parse HEAD; git diff --cached --stat | tail -3
sha256sum target/debug/eestock-app; ps -o pid,lstart,args -C eestock-app
```

---

## 3. 阶段 C：冒烟验收（必须全过，逐条留输出）

| # | 用例 | 期望 |
|---|---|---|
| C1 | `GET /healthz`（应用面 `:8081`；数据面 `:8080` **同路径**；**`/api/health` 不是端点**（`/api` 前缀未知路径一律 404，见 07-app-plane/00-web-api.md §1.1 消歧；2026-09-25 依赖盘点为零 ⇒ **不设别名**）） | 200 + `{"status":"ok"}` |
| C2 | `GET /api/symbols` 取 518880 | 200；`change_pct` 与昨收一致（此前事故项） |
| C3 | **M30 真跑**：`POST /api/workbench/runs` `period=M30`、小区间、1 slot | **201** → 轮询 `succeeded` → `/result` 首页 `has_more` 见、`period="M30"` |
| C4 | **负向对照**：`period=W1` | **400** `{"error":{"code":"period_invalid",…}}` |
| C5 | **长区间**（≈M1 93 天以上，验证 P5 去档）：`POST` 提交 | 201（若 ≥200k bar 则 400 `resource_guard`，带 `confirm:true` 重提 ⇒ 201） |
| C6 | **区间收缩**：`from` 早于可得区间 | 201 且响应 `clamped:true` + `effective_from` 晚于 `requested_from` |
| C7 | **`/fills`**：对 C3 的 run | 200；`{total, recorded:true, fills:[…]}`；K 线标记来自它 |
| C8 | **`/curve`**：`?kind=net_value&k=2000` | 200；`downsampled:true` + `original_bars` |
| C9 | **`/bars` 分页**：`?kind=per_bar&offset=0&limit=5000` | 200；`has_more`/`next_offset` 正确 |
| C10 | **结构化错误**：故意传非法 period | `{"error":{"code":…,"message":…,"detail":{…}}}`（`error` 为**对象**） |
| C11 | **前端真渲染**：工作台结果页（长区间 run） | 图表有数据（非空）、事件日志有覆盖提示、K 线买卖标记完整（来自 fills） |
| C12 | **收尾** | 冒烟产生的 run **必须先到终态再删**（或先 `cancel`）——**禁止在 running 期间删除父行**（否则后台分块写入会报 FK 约束失败 ERROR；2026-09-18 实测教训）；删除后回读为 0，库清单仍 `{eestock, postgres}` |

---

## 4. 阶段 D（可选，需用户先确认方案）：P4b 进度写库节流

> **前置**：用户确认方案（推荐「时间窗节流 ≥250 ms，WS 帧不变」）。**未获确认不得执行**。
> 判据：改动前基线（`coder/evidence/adr024_p4b/…`：每 run 1003 次 UPDATE、permit 持有 97% 为进度落库） vs 改动后（同规模 run 的落库次数/耗时/permit 占比）；须给**前后对比**证据。

---

## 5. 回滚预案

| 触发 | 动作 |
|---|---|
| app 启动失败（`migrate_check` 报缺关系） | 确认 A 阶段已应用；未应用 ⇒ 补做 A1–A3 |
| 冒烟 C3–C11 任一失败 | **立即回滚 app 二进制**（用 B1 备份）+ 回滚 `web/dist`（备份件）；DB 侧**保留**（0027 additive，回滚 app 后旧代码不受影响） |
| 前端结果页异常（图表空/表只显首页） | 检查是否漏部署 `web/dist`（P6 同批要求）；必要时只回滚 `web/dist` |
| 数据异常 | 按 ADR-025 D4 顺序：**先量化缺口（行数+水位）→ 再修因 → 最后回填** |

---

## 6. 上线后登记

1. 记录部署批次（HEAD、staged 摘要、二进制 sha256、`web/dist` sha256、时间窗）。
2. **刷新 GitNexus 索引**（用仓内 runner：`node .gitnexus/run.cjs analyze`；**不要**用 `npx gitnexus analyze`）。
3. 观察 24h：`strategy_run` 状态分布、`/curve` `/bars` `/fills` 错误率、cagg 作业状态（ADR-025 D2 的监控若已落地则直接看告警）。
4. 本手册执行记录归档：`tester/evidence/256_adr024_deploy/DEPLOY.md`（含二进制/dist 哈希、12 项冒烟结果、唯一 ERROR 的归因）。
