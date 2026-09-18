# 298 — ADR-024 P0（M30 打通）独立验收 · 执行记录

- **本文件路径（self-location）**：`tester/test/298_adr024_p0_verification_execution.md`
- **报告（判词在最前）**：`tester/report/adr024_p0_m30_verification.md`
- **证据目录**：`tester/evidence/246_adr024_p0_verify/`（索引见该目录 `EVIDENCE.md`）
- **角色**：tester —— **只验不改**；本轮**未新增/未修改任何生产代码**；未 `git add` / 未 `git commit`
- **执行时间**：2026-09-18 12:47:03 → 12:52:24 +0800（+0800）
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`
- **被测对象**：worker 已 staged 的 ADR-024 P0 交付（48 files, +1807/−56；未 commit）
- **是否新增永久测试**：否（本任务为验收执行；⑤ 的"人为扰动"均为**临时 + 已复原**，附 sha256 与 `git diff` 空证据）

---

## 1. 执行序（时间线）

| T(+0800) | 动作 | 命令 / 手段 | 结果 | 证据 |
|---|---|---|---|---|
| 12:47:03 | 形态与前置确认 | `ss -lntp`、`ps`、`sha256sum /proc/178558/exe`、`git rev-parse HEAD`、库清单、sim-live 门禁 | 在线 pid=178558（启于 09-16 23:59），exe sha `d6fed24e…`；**M30 → 400（旧硬编码文案）**；库 `{eestock,postgres}`；sim-live 12/12 ended ⇒ 停机门禁 PASS | `00_preflight.txt` |
| 12:47:16 | 后端构建 | `cargo build -p app` | EXIT=0，3.31s；产物 sha `f4d07dcc…`，`strings` 含 `M1/M5/M15/M30/H1/D1` | `01_*` |
| 12:47:28 | 前端构建 | `npx tsc -b` + `npm run build:prod` | EXIT=0；bundle `index-DI8Hug12.js` | `02_*` |
| 12:47:34 | 重启 8081/8082（技能 `rebuild-restart-app-8081`） | 回滚件 `cp /proc/178558/exe /tmp/eestock-app.rollback.20260918_124734`（sha `d6fed24e…`）→ `kill 178558` → `nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml` | 新 pid **4083225**（启于 12:47:37），同时持 8081+8082；`/proc/4083225/exe` == 磁盘产物 `f4d07dcc…`；旧 pid 消失；**未触发回滚** | `03_*`, `03b_*` |
| 12:47:48 | 冒烟 + 负向对照 | `/healthz`、`/api/symbols`、`/api/kline`、`POST period=W1`、`POST period=M300` | 200 / 200(len=44) / 200 / **400** / **400**；启动日志 ERROR=0 WARN=0 | `04_*` |
| 12:47:54 | **M30 真跑** | `POST /api/workbench/runs`（518880 / M30 / 2026-07-19→2026-09-17 / 1 slot `sv_1789013713975_000001` / LumpSum）→ 轮询 | **HTTP 201**；run `sr_1789706874229_000000`；轮询 1 次 running(0.0294) → **succeeded(1.0)**，0.57s；`/result` HTTP 200 (123,596 B) | `05_*` |
| 12:48:05 | M30 断言 | python 断言脚本（修正后版本） | `run_view.period=='M30'`、`status=='succeeded'`、`per_bar=680` 非空、全部 bar 间距为 1800s 整数倍、`trades=14`、metrics 合理 | `05b_*` |
| 12:48:12 | 收尾（ADR-025 D3） | `DELETE FROM strategy_run WHERE name LIKE 'ADR024-P0-verify-%'` → 回读 | DELETE 1；`strategy_run` 残留 **0**；`strategy_run_result` 该 run 残留 **0**；REST 404；库清单 **2 = {eestock, postgres}** | `06_*` |
| 12:48:23 | ② 后端定向测试 | `cargo test -p backtest -p application -p web -p mcp --no-fail-fast` | **316 passed / 64 failed**；64 失败**全部**为 `EESTOCK_TEST_DATABASE_URL 未设置` 同一因 | `10_*` |
| 12:48:23 | ② 前端全量 | `npx vitest run` | **89 files / 850 tests passed**，EXIT=0 | `12_*` |
| 12:48:36 | ② tangle 门禁 | `./scripts/check-tangle.sh` | ✅ 逐字节一致，EXIT=0 | `13_*` |
| 12:49:44 | ④ 禁改项 | `git diff --cached`（值级 grep + 逐路径空判 + 全量 name-status） | 常数 `+/-` 行 0 条；4 条禁改路径 staged diff 全空 | `20_*` |
| 12:49:49 | ④ 附 + 交付一致性 | 常数所在文件全 staged diff；`git cat-file -e :periods.test.ts` | 仅注释/穷尽臂；**`periods.test.ts` 不在 index（D1）** | `20b_*` |
| 12:50:00 | ② workspace 测试 | `cargo test --workspace --no-fail-fast` | **611 passed / 137 failed / 1 ignored**；137 失败**全部**同一因（测试库 env） | `14_*` |
| 12:50:45 | ② 全目标编译 | `cargo check --all-targets` | EXIT=0 | `11_*` |
| 12:50:50 | ③ 反向证据（自造） | 临时删 `periods.ts` 的 `'M30'` → 跑 Rust drift 测试 + 前端 `periods.test.ts` → 复原 → 回绿 | Rust **2 failed**；TS **2 failed**；复原后 Rust 5 passed / TS 3 passed；文件 sha 与 staged blob 不变、`git diff` 空 | `30_*` |
| 12:51:15 | ⑤ 抽查 A | 临时删常量 `'M30'` → `vitest run ConfigPanel.test.tsx` | **仍全绿 13/13** ⇒ 该断言对 M30 成员资格不敏感（D2）；复原 | `31_*` |
| 12:51:17 | ⑤ 抽查 B | 临时把组件下拉硬编码为 4 项（去 M30）→ 同上 | **1 failed / 12 passed** ⇒ 断言对组件强绑定；复原 | `31_*` |
| 12:51:58 | ⑤ 抽查 C | 临时把 `web/src/workbench.rs` 的硬编码白名单回填 → `cargo test -p web --test adr024_workbench_period_ssot -- --nocapture` → 复原 | **2 failed**（M30 门禁 + 源码反回归）→ 复原后 **4 passed** | `32_*` |
| 12:52:10 | 最终复跑 + 零足迹探针 + 终态 | 4 条 Rust + 5 条前端 P0 测试；`POST period=M30 & symbol=""`；残留计数；`git status` | Rust 22/6/5/4 全绿；前端 77/77 全绿；探针 `400 symbol 必填`（未产生 run）；残留 0；工作区 = worker 交付（仅 2 处既有未 staged 文件） | `15_*` |

---

## 2. 测试结果汇总（工具原始输出，非报告转述）

| 门禁 | 命令 | 结果 | 判据 |
|---|---|---|---|
| 后端（4 crate） | `cargo test -p backtest -p application -p web -p mcp --no-fail-fast` | 316 passed / **64 failed** / 0 ignored | 64 个失败**全部**为 `crates/test-support/src/lib.rs:32` 的**刻意门禁 panic**（`EESTOCK_TEST_DATABASE_URL` 未设，禁止回退活库）；**无第二个失败因**；P0 四个新测试文件全绿 |
| 后端（workspace） | `cargo test --workspace --no-fail-fast` | 611 passed / **137 failed** / 1 ignored | 同上，137 个 panic **逐条同址同因**；P0 相关目标全绿 |
| 全目标编译 | `cargo check --all-targets` | EXIT=0 | — |
| 前端全量 | `npx vitest run` | **89 files / 850 tests passed** | EXIT=0 |
| 前端构建 | `npx tsc -b` + `npm run build:prod` | EXIT=0 | bundle `index-DI8Hug12.js` |
| tangle | `./scripts/check-tangle.sh` | EXIT=0 | 沙箱重生成逐字节一致 |
| P0 定向（Rust） | backtest --lib 22 / application ssot 6 / mcp drift 5 / web gate 4 | 全绿 | — |
| P0 定向（前端） | periods 3 / format 9 / mock 46 / ConfigPanel 13 / TestRunPanel 6 | 77/77 全绿 | — |

> **失败项定性（观察，不越界分析）**：64 / 137 个失败**没有**一个落在 P0 新增或被 P0 修改的测试文件上；它们全部是**需要真实测试库**的既有集成测试（`api_*.rs`、`*_store.rs`、`mcp_tools_db.rs`、`kline_reader.rs`、`ws_poller.rs` 等），因本任务纪律「**禁止新建任何数据库**」而**无法执行**——这是**环境前置未满足**，不是 P0 的缺陷。

---

## 3. 受限项（诚实披露，非结论）

| 项 | 状态 | 原因 |
|---|---|---|
| 64 / 137 个集成测试 | **未被执行**（panic 于 env 门禁） | 纪律禁止新建库；仓内 `scripts/testdb-init.sh`（ADR-025 D3 待实现 `--drop`）未被本车道调用 |
| `scripts/testdb-init.sh` 正向 teardown 断言 | 未执行（未建库 ⇒ 无载体可销毁） | 同上；本车道对「无残留」给出的是**库清单双时点相等 + run 残留正向回读 0** |
| worker 未取证的 M30 真跑 | **已补证** | 见 `05_*`（本任务第一优先级） |
| 浏览器真渲染（SPA 选 30min 下拉） | 未做 | 本任务门禁为 REST 端到端；前端下拉由 vitest 真渲染断言 + ⑤ 扰动取证覆盖；`web/dist` 已随本次重启重建 |

---

## 4. 合规声明

- 未修改任何生产代码（唯一两处临时改动为 ③/⑤ 要求的**反向证据扰动**，均在**同一执行块内复原**，并给出 sha256 前后一致 + `git diff` 空 + staged blob 不变的原始输出）。
- 未执行 `git add` / `git commit` / `git stash` / `git checkout`；staged 内容与 worker 交付前完全一致（`git diff --cached --stat` 48 files, +1807/−56）。
- 未新建数据库；`pg_database` 前后均为 `{eestock, postgres}`。
- 未修复任何失败、未对失败做归因式调试（仅记录现象与原始 panic 文本）。
- 过程性副作用（如实披露，均为既有技能 `rebuild-restart-app-8081` 的标准动作）：
  1. 8081/8082 由 pid 178558 → **4083225**（二进制由 `d6fed24e…` → `f4d07dcc…`）；
  2. `/tmp/eestock-app.rollback.20260918_124734`（旧在线 exe 副本，sha `d6fed24e…`）保留；
  3. `web/dist/**` 重建（gitignored）；`logs/app_dev_8081_redeploy_20260918_124734.log` 新增（gitignored）；
  4. 生产库一行 `strategy_run`（+级联 1 行 result）创建后**已删除并回读为 0**。
