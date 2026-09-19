# ADR-026 阶段 4：端到端验收 + 回归（真浏览器 E2E / 变异反证 / 部署重启 / 回归）

- **本报告位置**：`tester/evidence/20260919_adr026_e2e_verify/README.md`（原始输出：同目录 `raw/`，截图与采集清单：`raw/e2e/`）
- **契约（冻结，已完整读取）**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`
  （本阶段**只验收**，不改契约、不改引擎语义/表结构/迁移；ADDR-026 §5 A6/A7）
- **交付基线**：`git rev-parse HEAD` = `e807385449a303a1090ac00a52c722b7b77e62ec`；开工 `git status --porcelain` = 84 行（`raw/00_baseline_recon.txt`）
- **上游**：`coder/evidence/20260919_adr026_frontend/`、`tester/evidence/20260919_adr026_backend_verify/`、`coder/evidence/20260919_adr026_backend/`
- **环境**：活库 `eestock`（`127.0.0.1:5433`）；Web `:8081`；MCP `:8082`；改动后应用已**重建并重启**（见 §2）
- **纪律**：未执行任何 `git add / commit / checkout / stash / reset`（`git diff --cached` 空）；未改引擎语义、未改表结构、未新增迁移；需 DB 的测试走 ADR-025 临时库并已 `DROP`（§6）
- **本阶段唯一源码级动作**：一次性**测试用**前端突变（注掉页面摘要渲染）→ 已逐字节还原（§5.2）；无其它源码改动

---

## 1. 判词摘要

| 任务项 | 结论 | 关键读数 | 证据 |
|---|---|---|---|
| ① 重建并重启本机应用（旧进程替换） | **PASS** | 旧 PID 2043164（`Fri Sep 18 18:04:44`，`/proc/exe → (deleted)`）已退出；新 PID **4160311**（`Sat Sep 19 01:14:12 2026`），`:8081/:8082` 均归新 PID；重启后 `GET …/000005/audit` = **200** 且与冻结基准逐字段一致；MCP `tools/list` = **35** 个且含 `bt_get_run_audit` | `raw/20/30/31/32/33/33b` |
| ② 真浏览器 E2E（Playwright/Chromium，非 jsdom） | **PASS** | 7 用例全绿；摘要行/3 条 warning/来源列/8 项口径注逐条断言；console error = 0、pageerror = 0、失败请求 = 0（并有 500 对照证明采集器非恒空）；历史 run 来源列 33/33 行「未记录」 | `raw/40`、`raw/55`、`raw/e2e/*` |
| ③ 变异反证 ①（响应拦截改数据 ⇒ UI 必变、基线断言必红） | **PASS** | `deployed_pct→1.0`+`batches_done→7` ⇒ UI 显「名义投入 100.00%」「已成交 7」，同一套基线断言输出 **3 条红**；`warnings→[]` ⇒ 提示条消失，基线断言输出 **3 条红**（逐 code） | `raw/e2e/base_90*`、`base_91*` |
| ③ 变异反证 ②（注掉页面摘要渲染 ⇒ 断言必红，然后还原） | **PASS** | 突变后 `10_baseline_trades` **FAILED**（`wb-audit-summary` 15s 未出现）；还原后源码 sha256 与突变前**逐字节一致**（`1226b2e7…`）、dist 重新构建后 sha256 与突变前**同值**（`b909850d…`）、7 用例复绿 | `raw/50..55` |
| ④ 回归（受影响后端套件 + 前端 vitest） | **PASS（附本批新增套件 flake + 既有/隔离红，见 §6.2–§6.4）** | `backtest 31✓`、`strategy-core 76✓(+1 ignored)`、`application 199✓`、`mcp 83✓`；`web` 29 目标：RUN-A 1 红（既有 `tester_p5rect_verify`）、RUN-D（全新库）1 红（同一既有红）；前端 `vitest 94 文件/916✓`、`tsc -b` exit 0 | `raw/70..83` |
| ⑤ 越界审计（git / 残留探针） | **PASS** | `git diff --cached` 空；无 add/commit/checkout/stash/reset；工作树相对开工基线**只多** 2 项：本证据目录与 `web/e2e/adr026-audit.e2e.ts`；突变痕迹 `false &&` 计数 = 0；Playwright `artifacts/` 为 gitignore 项且无 adr026 残留目录 | `raw/91` |

### 本阶段发现的**必须由主代理处置**事项（我不修，仅取证）

| # | 级别 | 事实 | 可达性 | 证据 |
|---|---|---|---|---|
| **G1** | **中（本批新增测试资产）** | `crates/web/tests/adr026_run_audit.rs` 在**默认并行**下 flake：本阶段实测 4 次红（1 次 `web` 全量 fail-fast 红 = `audit_recorded_false_when_facts_are_missing`；3 次含 `audit_endpoint_emits_required_tracing_fields`），隔离重复 5 次并行 **1 红**、串行 **3/3 绿** | 每次默认 `cargo test -p web` 有可观概率红 ⇒ ADR-026 §5 A7「受影响套件全绿」在默认命令下**不成立** | `raw/71`、`raw/74`、`raw/72_B/C`、`raw/56`（阶段 2） |
| **G2** | 低（既有红，与本批无关） | `crates/web/tests/tester_p5rect_verify.rs::t_n1_http_every_400_is_structured_object` 恒红：期望 400、实得 201（`GUARD_CONFIRM_BARS` 在 HEAD = 500_000，测试资产未同步） | 每个 `cargo test -p web` 必红（RUN-A/B/C/D 四次全红） | `raw/82`、`raw/75` |
| **G3** | 低（测试隔离/共享库污染） | `crates/web/tests/orphan_detect_endpoint_red.rs::r1_…` 在 `web` 全量 `--no-fail-fast` 的 RUN-B/C 两处红（`rows` 期望 0 实得 2），RUN-A/D 绿；全新库隔离实验（全新库→orphan 单跑→adr026 单跑→orphan 再跑）**全绿且每次后孤儿数 = 0** | 非确定性；**与 ADR-026 代码路径无关（隔离实验可证）**；红线线索：`kline_accurate` 残留 3 个未注册 code（`830277/838077/839496`，各 6 行），该 code 形态只出现在**未改动**的 `crates/web/tests/api_workbench.rs:513`（`format!("83{}", pid%10000)`）——**线索，非结论** | `raw/72_B/C`、`raw/75`、`raw/76`、`raw/78` |
| **G4** | 提示（口径措辞） | 「交易明细」Tab 摘要行 L1 的「成交 N 笔（逐笔源 /fills）」实测 **N = 43**（`/fills` 全口径 = 42 Buy + 1 强平 Sell），而任务提示语中的「成交 42」对应**同一行的 L2「已成交 42」**（= 审计 `batches_done`，仅买入批数）。两者口径各自独立命名、无同物异名 | — | `raw/32`、`raw/e2e/base_10_baseline_trades_lines.json` |

---

## 2. ① 重建并重启本机应用

**手段**：按仓内既有做法（父代理同款命令形态）重建 debug 二进制与前端产物，替换在线进程。

| 动作 | 读数 | 证据 |
|---|---|---|
| 前端构建 | `cd web && npm run build` → exit 0，产出 `dist/assets/index-CxpxqtmC.js`（含 `wb-audit-summary` 等 ADR-026 文案） | `raw/10_frontend_build.txt`、`raw/11_frontend_dist_check.txt` |
| 后端构建 | `cargo build --bin eestock-app` exit 0；二进制 mtime **2026-09-19 01:13:57.457197250 +0800**，sha256 `895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b`；`strings` 命中 `workbench_run_audit`×2、`bt_get_run_audit`×16 | `raw/20_backend_build.txt` |
| 旧进程 | PID **2043164**（`Fri Sep 18 18:04:44 2026`，etime 07:09:17，`/proc/2043164/exe → …(deleted)` = 旧 inode）；`SIGTERM` 后 **已退出**，`:8081/:8082` 无监听 | `raw/30_old_process_stop.txt` |
| 新进程 | `nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> logs/app_dev_8081_redeploy_20260919_011412.log 2>&1 &` ⇒ PID **4160311**，启动时刻 **Sat Sep 19 01:14:12 2026**；`/proc/4160311/exe → target/debug/eestock-app`（**非 deleted**）；cwd = 仓库根 | `raw/31_app_restart_verify.txt` |
| 端口归属 | `:8081` fd=11、`:8082` fd=12 → 均 `users:(("eestock-app",pid=4160311))` | 同上 + `raw/92_final_state.txt` |
| 启动日志 | 6 行 INFO（`schema self-check ok`、registry 播种、sim-live 恢复、serving 8081/8082）；**ERROR 计数 = 0** | `raw/31_app_restart_verify.txt` |
| 健康 | `:8081/healthz` = 200；`:8082/sse` = 200（MCP 无 `/healthz` 路由 ⇒ 404，与既有形态一致） | `raw/32`、`raw/92` |

**重启后线上 `GET /api/workbench/runs/sr_1789738328788_000005/audit`（真实响应，证明新代码在跑）**：

```http
HTTP/1.1 200 OK
{"run_id":"sr_1789738328788_000005","recorded":true,"capital_basis":100000.0,
 "deployed_notional":41397.97208076086,"deployed_pct":0.4139797208076086,
 "cash_consumed":41607.97208076086,"cash_consumed_pct":0.41607972080760863,
 "planned_tranches":100,"reachable_batches":43,"batches_done":42,"unexecuted_orders":1,
 "last_bar_unfilled":true,"round_trips_total":1,"round_trips_force_closed":1,
 "warnings":[DCA_PLAN_UNDERFILLED(warn),PARTIAL_DEPLOYMENT(warn),ORDERS_UNEXECUTED(info)]}
```

- 与冻结基准（`planned=100, reachable=43, done=42, unexecuted=1, last_bar_unfilled=true,
  deployed_pct≈0.41398, cash_consumed_pct≈0.41608`，3 条 warning 文案逐字）**逐字段一致**；
- A4 `sr_1789738272901_000004`：`planned=null, deployed_pct=0.99975006…, cash_consumed_pct=0.99999999…, warnings=[]`；
- A5 `sr_1789044295239_000111`：`reachable=40, batches_done=40, unexecuted=0, round_trips_total=40, force_closed=0, warnings=[]`；
- 端口 `:8082` MCP 真机（SSE）`tools/list` = **35** 个工具且含 `bt_get_run_audit`；`tools/call` A3/A4 与 REST 同值；未知 run ⇒ `isError`；缺参 ⇒ `-32602`。
- 前端 `:8081/backtest-workbench` 返回的 `index.html` 引用**新** bundle `index-CxpxqtmC.js`（旧 dist 为 `index-D8n72RAF.js`，无任何 ADR-026 字样）。
- 证据：`raw/32_live_audit_curl.txt`、`raw/33_live_mcp_probe.txt`、`raw/33b_live_mcp_summary.txt`、`raw/11_frontend_dist_check.txt`

---

## 3. ② 真浏览器 E2E（Playwright / Chromium；**未用 jsdom**）

- 栈：`@playwright/test 1.62.1`，project = `chromium`（`Desktop Chrome`，真实 Chromium 引擎，非 jsdom）；`E2E_BASE_URL=http://127.0.0.1:8081`；`--retries=0`；`workers=1`。
- 用例文件：`web/e2e/adr026-audit.e2e.ts`（本阶段**新增**；sha256 `b8aaee0e6c5da0de0e2637054bd87ebaa678840877f206e2ce73fd2bc4988219`）。
- **断言单一事实源**：基线断言集中在 `summaryMismatches()` / `metricsMismatches()`；正向用例断言其为**空**，变异用例断言其**非空** ⇒ 「绿」不可能来自不绑数据的恒真断言。
- 运行命令：`cd web && E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test e2e/adr026-audit.e2e.ts --retries=0`
- 结果：**7 passed**（3.7s，exit 0）——`raw/40_E2E_baseline_green.txt`；还原后再跑一次仍 **7 passed**——`raw/55_E2E_restored_green.txt`

| 用例 | 断言要点 | 结果 |
|---|---|---|
| `10_baseline_trades` | 选中 `sr_1789738328788_000005`（运行历史首行）⇒ 交易明细 Tab 出 `wb-audit-summary`：L1「成交 43 笔（逐笔源 /fills）｜回合 1 条（其中强平合成 1 条）｜名义投入 41.40%（分母 = 初始资金）」；L2「现金消耗（含佣金）41.61%｜计划批数 100｜可达轮次 43｜**已成交 42**｜未执行挂单 1（末根 bar 无次 bar 可执行）」；3 条 warning（`DCA_PLAN_UNDERFILLED`⚠/`PARTIAL_DEPLOYMENT`⚠/`ORDERS_UNEXECUTED`ℹ，文案与 ADR 逐字）；表头含「来源」；来源列 `未记录`（该 run 的 `trades[0]` 无 `reason` 键） | ✓ |
| `11_baseline_metrics` | 切「8项绩效」Tab（`wb-tab-metrics`）⇒ `wb-metrics-basis`「口径：年化 / 最大回撤 / 夏普的分母 = 初始资金 ¥100,000…」；`wb-metrics-deployed`「资金投入率（名义投入 / 初始资金）= 41.40%；资金占用（含佣金）/ 初始资金 = 41.61%」；8 项绩效表 8 行 | ✓ |
| `12_legacy_sources` | 历史 run `sr_1789282762943_000014`（33 回合，`trades` 无 `reason`）⇒ 来源列 **33/33 行 = 未记录** | ✓ |
| `13_reason_injection` | 真浏览器 + `/result` 响应注入 `trades[0].reason="ForceClose"` ⇒ 来源列 `期末强平`（标签映射非硬编码；不改库、不改代码） | ✓ |
| `14_control_audit_500` | 审计端点注入 500 ⇒ 结果视图不塌（`wb-audit-error` + `wb-audit-retry` + 交易明细表照常）；**采集器非恒空对照**：`consoleErrors` 捕到 1 条、`httpErrors` 捕到 `500 GET …/audit` | ✓ |
| `90_mutation_deployed` | 拦截审计响应改 `deployed_pct=1.0`/`cash_consumed_pct=1.0`/`batches_done=7` ⇒ UI 变（见 §4） | ✓ |
| `91_mutation_warnings` | 拦截 `warnings=[]` ⇒ `wb-audit-warnings` 与 3 条提示条 `toHaveCount(0)`、摘要行仍在（非阻断） | ✓ |

**console 错误清单 / 失败请求清单**（逐用例落盘 `raw/e2e/<tag>_*_obs.json`）：

| 用例 | consoleErrors | pageErrors | failedRequests | httpErrors |
|---|---|---|---|---|
| 10 / 11 / 12 / 13 | **[]** | **[]** | **[]** | **[]** |
| 14（500 对照） | 1 条（`Failed to load resource: … 500`） | [] | [] | 1 条（500 `…/audit`） |

⇒ 正向路径**无 console 错误、无失败请求**；且有 500 对照证明「空」不是采集器失效（禁假绿）。

**截图（`raw/e2e/`，共 35 张 PNG）**：`base_10_trades_tab.png`（视口）、`base_10c_audit_summary_el.png`（摘要+warning 元素图）、`base_10d_trades_table_el.png`（含「来源」列）、`base_11_metrics_tab.png`、`base_11c/11d_*_el.png`（口径注/投入率元素图）、`base_12*`（历史 run 未记录）、`base_13*`（注入后的「期末强平」）、`base_14_control_audit_500.png`、`base_90*/91*`（变异对照）、`mutsrc_52_…_RED_screenshot.png`（突变实测红）、`restored_*`（还原后复绿）。

**DOM 文案原文**（`raw/e2e/base_10_baseline_trades_lines.json`、`base_11_baseline_metrics_lines.json`）：

```
L1: 成交 43 笔（逐笔源 /fills）｜回合 1 条（其中强平合成 1 条）｜名义投入 41.40%（分母 = 初始资金）
L2: 现金消耗（含佣金）41.61%｜计划批数 100｜可达轮次 43｜已成交 42｜未执行挂单 1（末根 bar 无次 bar 可执行）
W1: ⚠ 计划 100 批，区间内最多可推进 43 批、已成交 42 批（剩余批次随买入区结束取消）
W2: ⚠ 名义投入 41.40% 初始资金，年化/回撤/夏普分母仍为初始资金
W3: ℹ 1 笔挂单未成交（末根 bar 无次 bar 可执行）
口径：年化 / 最大回撤 / 夏普的分母 = 初始资金 ¥100,000（未满仓时按实际投入口径的风险更高，故并列披露资金投入率）
资金投入率（名义投入 / 初始资金）= 41.40%；资金占用（含佣金）/ 初始资金 = 41.61%
```

---

## 4. ③ 变异反证 ①：响应拦截改数据 ⇒ UI 必变 + 基线断言必红

**M1（`raw/e2e/base_90_mutation_deployed*`）**：`page.route('**/api/workbench/runs/*/audit*')` 把响应体改成 `deployed_pct=1.0, deployed_notional=capital_basis, cash_consumed_pct=1.0, batches_done=7`。

- UI 确随之变：`L1 = …｜名义投入 100.00%（分母 = 初始资金）`、`L2 = 现金消耗（含佣金）100.00%｜…｜已成交 7｜…`，且 `L1` 不再含「名义投入 41.40%」、`L2` 不再含「已成交 42」；
- **同一套基线断言此时变红 3 条**（`raw/e2e/base_90_mutation_deployed_mismatch.json`）：
  ```
  L1 名义投入 = 41.40% ‖ …名义投入 100.00%…
  L2 现金消耗（含佣金）= 41.61% ‖ 现金消耗（含佣金）100.00%｜…｜已成交 7｜…
  L2 已成交 = 42 ‖ …｜已成交 7｜…
  ```

**M2（`raw/e2e/base_91_mutation_warnings*`）**：拦截 `warnings=[]`。

- UI：`wb-audit-warnings` 与 `wb-audit-warning-{DCA_PLAN_UNDERFILLED,PARTIAL_DEPLOYMENT,ORDERS_UNEXECUTED}` 全部 `toHaveCount(0)`，摘要行照常渲染（非阻断语义成立）；
- 基线断言变红 3 条（逐 code）：
  ```
  warning DCA_PLAN_UNDERFILLED ‖ visible=false text=""
  warning PARTIAL_DEPLOYMENT   ‖ visible=false text=""
  warning ORDERS_UNEXECUTED    ‖ visible=false text=""
  ```

**判据有效性结论**：UI 的数字/告警**确实来自审计响应**（不是写死、不是空断言）——改数据 UI 就变，且同一套断言随之变红。

> 观察（口径正确性顺带被记录）：`warnings[].message` 由**服务端**按当时的 `deployed_pct` 合成并随响应下发，故只拦截数字字段时，warning 文案里的「名义投入 41.40%」保持原样（前端不重算服务端文案）。因此断言必须按**行**取（`L1`/`L2`）而非整块 `innerText`；本用例已按行取，并把「文案保持服务端原值」作为显式断言（`raw/90_mutation_deployed_lines.json`）。

---

## 5. ③ 变异反证 ②：注掉页面摘要渲染 ⇒ 必红；还原后必绿（逐字节证明）

### 5.1 突变（`raw/50_mutation_page_render_setup.txt`、`51_mutation_page_render_build.txt`）

- 备份到**仓库外** `/tmp/adr026_ResultView.tsx.bak`（sha256 `1226b2e7…`，与阶段 3 交付所载一致）；
- 突变点 = 1 行：`web/src/features/workbench/ResultView.tsx` 的
  `<AuditSummary audit={audit} fills={series.fills} />` → `{false && <AuditSummary audit={audit} fills={series.fills} />}`
  （用 `false &&` 而非整段删除，避免触发 `noUnusedLocals`）；
- 源码 sha256 `1226b2e7…` → **`6b23288aa528b23f6801d2b25f9bd13154bf9d3bb630585d9c3feca62cb623ca`**；
- 重建后 dist：`index-CxpxqtmC.js`（`b909850d…`）→ **`index-C5v-edqI.js`（`b7520e09…`）**，且 bundle 内 `wb-audit-summary` 命中数 = **0**（常量折叠后整段被 DCE）。

### 5.2 Red（`raw/52_mutation_page_render_RED.txt`，exit=1）

```
Running 1 test using 1 worker
  ✘  1 … › 10_baseline_trades：目标 run 交易明细 Tab 出审计摘要 + warning 条 + 来源列 (15.2s)
    Error: expect(locator).toBeVisible() failed
    Locator: getByTestId('wb-audit-summary')
    Expected: visible ; Timeout: 15000ms ; Error: element(s) not found
      at openRun (web/e2e/adr026-audit.e2e.ts:122:54)
  1 failed
```

失败截图已留档：`raw/e2e/mutsrc_52_mutation_page_render_RED_screenshot.png`。

### 5.3 还原 + 复绿（`raw/53_mutation_page_render_restore.txt`、`54_restored_live_dist.txt`、`55_E2E_restored_green.txt`）

| 校验 | 突变前 | 还原后 | 结论 |
|---|---|---|---|
| `web/src/features/workbench/ResultView.tsx` sha256 | `1226b2e7a3acc62679533fe21f9f9e2793af0268089741b967bcab66492ba446` | **同值** | 与阶段 3 交付一致（`cmp` 逐字节一致） |
| `git diff` 内 `false &&` 命中 | — | **0** | 无突变残留 |
| `web/dist/assets/index-CxpxqtmC.js` sha256 | `b909850ded4c6325912938483c52e9b8ab61a9bf68162a37cd313cbf2f4ff97f` | **同值**（文件名同） | 构建产物与突变前一致 |
| bundle 内 `wb-audit-summary` 命中 | 1 | **1** | 摘要代码回归 bundle |
| `:8081/backtest-workbench` 引用 | `index-CxpxqtmC.js` | **`index-CxpxqtmC.js`** | 线上服务的是还原后产物 |
| E2E | 7 passed | **7 passed**（`ADR026_E2E_TAG=restored`，另存一套证据） | 行为复绿 |

---

## 6. ④ 回归

### 6.1 ADR-025 临时库（`raw/60_testdb_init.txt`、`raw/77_testdb_init_fresh2.txt`）

```
EESTOCK_TEST_DB_NAME=tmp_e2e_1789751873 scripts/testdb-init.sh        → export EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/tmp_e2e_1789751873'
EESTOCK_TEST_DB_NAME=tmp_e2e2_1789752105 scripts/testdb-init.sh      → export EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/tmp_e2e2_1789752105'
```
（未在活库 `eestock` 上初始化；脚本对源库只读播种）

### 6.2 后端受影响套件（`raw/70_reg_*.txt`、`raw/82_regression_final.txt`、`raw/83_regression_summary.txt`）

| 套件 | targets | passed | failed | ignored |
|---|---|---|---|---|
| `cargo test -p backtest` | 2 | 31 | 0 | 0 |
| `cargo test -p strategy-core` | 7 | 76 | 0 | 1 |
| `cargo test -p application` | 9 | 199 | 0 | 0 |
| `cargo test -p mcp` | 7 | 83 | 0 | 0 |
| `cargo test -p web --no-fail-fast`（RUN-A / DB1） | 29 | 172 | 1 | 0 |
| `cargo test -p web --no-fail-fast`（RUN-B / DB1） | 29 | 170 | 3 | 0 |
| `cargo test -p web --no-fail-fast`（RUN-C / DB1） | 29 | 170 | 3 | 0 |
| `cargo test -p web --no-fail-fast`（RUN-D / DB2 **全新**） | 29 | 172 | 1 | 0 |

- **RUN-D（全新库）失败目标仅 1 个**：`tester_p5rect_verify::t_n1_http_every_400_is_structured_object`（G2，HEAD 既有红，与本批无关）。
- RUN-B/C 额外 2 红：`adr026_run_audit::audit_endpoint_emits_required_tracing_fields`（G1 flake）+ `orphan_detect_endpoint_red::r1_…`（G3 共享库污染）。
- `cargo test -p web`（默认 fail-fast）实际会在 `adr026_run_audit` 处**中断**剩余目标（`raw/71_reg_web_run1.txt`），故 `--no-fail-fast` 才是完整口径。

### 6.3 G1 flake 定量（`raw/74_adr026_suite_flake_stats.txt`、`raw/75_other_targets_isolated.txt`）

```
cargo test -p web --test adr026_run_audit（默认并行 ×5）：ok / FAILED(tracing) / ok / ok / ok   ⇒ 并行 1/5 红
cargo test -p web --test adr026_run_audit -- --test-threads=1（×3）：ok / ok / ok               ⇒ 串行 3/3 绿
```
两种红形态（原文）：
- `crates/web/tests/adr026_run_audit.rs:547` —— 捕获到的 span `run_id=sr_1789751990623_000005` 属**另一并发用例**（共享 `tracing` 订阅者）；
- `crates/web/tests/adr026_run_audit.rs:352` —— `INSERT strategy_run_result` 触发 FK `23503`：`Key (run_id)=(sr_adr026_chunked_nofacts) is not present in table "strategy_run"`（被同文件 `clean()` 的 `DELETE FROM strategy_run WHERE id LIKE 'sr_adr026%'` 并发删掉）。
> 以上为**观察到的失败事实**（不含修法）；与阶段 2 的 F3 为同一现象（当时 9/50 = 18%）。

### 6.4 G3 隔离实验（`raw/78_isolation_experiment.txt`，全新库 `tmp_e2e2_1789752105`）

```
步骤0 初始孤儿数（kline_accurate 中 code 不在 symbols）= 0
步骤1 orphan 目标单跑：ok. 4 passed ⇒ 之后孤儿数 0
步骤2 adr026 目标单跑：ok. 4 passed ⇒ 之后孤儿数 0
步骤3 orphan 目标再跑：ok. 4 passed ⇒ 之后孤儿数 0
```
⇒ 在全新库上，**ADR-026 新增套件不产生孤儿行**；G3 是「同一次 `cargo test -p web` 内其它目标并发写库 + 某目标中断未清理」造成的**跨目标共享库隔离**现象（残留 code 线索见 G3 表）。

### 6.5 前端（`raw/80_frontend_vitest.txt`、`raw/81_frontend_tsc.txt`）

```
npx vitest run → Test Files 94 passed (94) | Tests 916 passed (916)   （exit 0）
npx tsc -b     → exit 0（无输出）
```
（与阶段 3 的绿基线一致；`vitest` 不收集 `*.e2e.ts`，新增 E2E 用例不干扰前端单测）

### 6.6 G2 独立复核：`tester_p5rect_verify` 的红是否与本批无关（`raw/84_G2_head_red_check.txt`）

```
panicked at crates/web/tests/tester_p5rect_verify.rs:137:5:
  assertion `left == right` failed: [runs/resource_guard(confirm=false)] 期望 400，实得 201
  （body.estimated_bars = 292092，status=queued）
```
- 判据常量出处：`crates/application/src/error.rs:150  pub const GUARD_CONFIRM_BARS: usize = 500_000;`
  （该处注释即为「2026-09-18 用户『按推荐』修订：由 `200_000` 提到 `500_000`」）；
- `292092 < 500000` ⇒ 不需二次确认 ⇒ 201 是**实现侧正确行为**，红的是**未同步的测试资产**；
- `git status --porcelain -- crates/web/tests/tester_p5rect_verify.rs crates/web/src/error.rs crates/application/src/error.rs` = **空**（三者均未在本批改动清单）⇒ 该红在 HEAD 即存在，**不由本批引入**。

### 6.7 临时库 teardown（`raw/90_db_teardown.txt`）

```
teardown 前库清单：eestock / postgres / tmp_e2e2_1789752105
DROP DATABASE IF EXISTS tmp_e2e2_1789752105 WITH (FORCE);  → DROP DATABASE
teardown 后库清单：eestock / postgres        （tmp_% 计数 = 0）
```
注：DB1（`tmp_e2e_1789751873`）已在 §6.4 之前 `DROP … WITH (FORCE)`（同一 `raw/77` 段内），最终回读仍只剩 `{eestock, postgres}`。

---

## 7. ⑤ 越界审计（`raw/91_git_boundary_audit.txt`）

- `git diff --cached` **空**，无 staged 文件；全程**未执行** `git add / commit / checkout / stash / reset`（会话内 git 调用仅 `status / diff / rev-parse / log`）。
- 工作树相对开工基线（84 行）→ 收工（85 行），`diff` **只多 2 项**：
  ```
  > ?? tester/evidence/20260919_adr026_e2e_verify/     （本阶段证据）
  > ?? web/e2e/adr026-audit.e2e.ts                     （本阶段新增真浏览器 E2E 用例）
  ```
  其余全部 ` M` / `??` 与基线逐行一致（= 阶段 2/3 的既有产物）。
- 突变痕迹：`grep -c "false &&" web/src/features/workbench/ResultView.tsx` = **0**；被核验文件 sha256 与阶段 2/3 所载逐一相同（`raw/93_changed_files_sha256.txt`）⇒ 无「报告后偷改」、无文件漂移。
- 引擎语义/表结构/迁移：**未触碰**（`crates/strategy-core/src/engine.rs`、`migrations/`、`strategy_run_bars`/`strategy_run_result` 均不在本阶段改动清单；本阶段只改了 `web/e2e/` 新增文件 + 证据目录 + `web/dist`（gitignore 构建产物）+ 应用日志（`logs/`，既有约定））。
- 仓库内残留探针：无。Playwright `web/e2e/artifacts/`（gitignore 项）不含 adr026 残留（末次绿跑已重建 outputDir）；突变备份 `/tmp/adr026_ResultView.tsx.bak`、探针脚本 `/tmp/adr026_e2e_mcp_probe.sh`、临时库名文件 `/tmp/adr026_e2e_tmpdb*.txt` **均在仓库外**（保留供复核）。
- 本阶段新增/改动文件 sha256（`raw/93_changed_files_sha256.txt`）：
  ```
  b8aaee0e6c5da0de0e2637054bd87ebaa678840877f206e2ce73fd2bc4988219  web/e2e/adr026-audit.e2e.ts
  b909850ded4c6325912938483c52e9b8ab61a9bf68162a37cd313cbf2f4ff97f  web/dist/assets/index-CxpxqtmC.js  （gitignore 产物）
  895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b  target/debug/eestock-app        （gitignore 产物）
  ```

---

## 8. 环境动作与影响面（诚实登记）

1. **在线应用已被替换**：`SIGTERM` 旧 PID **2043164**（父代理自 `2026-09-18 18:04:44` 起的常驻进程）→ 新 PID **4160311**（`2026-09-19 01:14:12`，同配置 `/tmp/app_dev_8081.toml`，日志 `logs/app_dev_8081_redeploy_20260919_011412.log`）。这是任务 ① 的**要求动作**（后端有改动 ⇒ 旧进程必须替换）；收工状态：`:8081/healthz 200`、`…/audit 200`、`:8082/sse 200`、ERROR 计数 0。
2. `web/dist` 被**重建两次**（正向一次、突变后一次、还原后一次；末次即还原后产物），线上静态托管随之刷新；前端源码**最终 sha256 与基线一致**。
3. 未改 `/tmp/app_dev_8081.toml`、未改活库 `eestock` 的任何数据（全程只读 + 三次 `curl`/SSE 只读调用；未新建 run、未改 facts 行）。
4. 两个 ADR-025 临时库均已 `DROP … WITH (FORCE)`，库清单回读 = `{eestock, postgres}`。

---

## 9. 残留不确定性（显式）

1. **A7「全绿」不成立于默认命令**（G1）：`cargo test -p web` 默认并行下本批新增端点套件可 flake（本阶段 4 次红 / 6 次并行执行；串行 3/3 绿）；`--no-fail-fast` 全新库 1 红 = 既有 `tester_p5rect_verify`。我未修、未裁量，交由主代理决定「修测试隔离」还是「登记为已接受债务」。
2. **G3 共享库污染的确定性未完全钉死**：只证明「与 ADR-026 代码无关」（隔离实验）与「残留 code 形态出自未改动的 `api_workbench.rs`（线索）」，未定位到具体把 `symbols` 行删掉却留下 `kline_accurate` 行的用例。
3. **「成交 42 vs 43」口径**（G4）：UI 现状是 L1 = `/fills` 全口径 43（含 1 笔强平 Sell）、L2 = `已成交 42`（买入批数）；任务提示语写「成交 42」。若主代理要求 L1 也表现为 42，属 ADR §2.4-1 措辞/口径裁决（前端与端点均已分别命名披露，无同物异名），**不是**本次 E2E 的失败项。
4. **来源列非「未记录」的取值**：活库**无任何** run 的 `trades[*]` 带 `reason`（`raw/93` 前的库查询：`has_reason` 全 `f`），故「正常/止损/期末强平」在**真库数据**上不可达；我用「真浏览器 + `/result` 响应注入 `reason=ForceClose`」证明标签映射（`13_reason_injection`），其余两值（`Policy→正常`、`StopTrigger→止损`）本次未在真浏览器断言（由 `ResultView.test.tsx` 单测覆盖）。
5. **真浏览器仅 Chromium**（仓内 Playwright 配置即只测 chromium）；未做 Firefox/WebKit 交叉。
6. `web/src/**` 的 ADR-026 前端实现我只做**黑盒**验收（E2E + 单测复跑），未逐行审阅其源码；上游阶段 3 报告已含逐行口径对照。
7. 移动端/窄屏布局、`perbar`/`events` 两个 Tab 未纳入本轮 E2E 断言范围（ADR §2.4 未要求）。
8. 未做超大 run（`MAX_BARS=200_000`）审计端点延迟实测（ADR §6 已承认该取舍）。

---

## 10. 原始证据清单（`raw/`）

| 文件 | 内容 |
|---|---|
| `00_baseline_recon.txt` | 开工基线：git status（84 行）、HEAD、关键文件/dist sha256、进程端口、重启前 404、库清单 |
| `10_frontend_build.txt`、`11_frontend_dist_check.txt` | `npm run build` 原文 + dist 内容/sha256/ADR-026 关键字命中 + `git status -- web/` |
| `20_backend_build.txt` | `cargo build --bin eestock-app` 原文 + 构建前后 mtime/sha256 + `strings` 命中 |
| `30_old_process_stop.txt`、`31_app_restart_note.txt`、`31_app_restart_verify.txt` | 旧进程（含 `(deleted)` inode）退出、新进程 PID/启动时刻/端口归属/启动日志 |
| `32_live_audit_curl.txt`、`33_live_mcp_probe.txt`、`33b_live_mcp_summary.txt` | 重启后线上 REST `/audit`（A3/A4/A5）+ 静态 index.html；`/healthz`；MCP SSE 真机 35 工具与 `tools/call` |
| `40_E2E_baseline_green.txt`、`55_E2E_restored_green.txt` | Playwright 正向全绿（7 passed）×2（标签 `base` / `restored`） |
| `50..53_mutation_page_render_*` | 突变②：备份/突变 diff/突变后 sha256、突变构建、**RED 输出**、还原校验（`cmp`+sha256+dist 同值+`false &&` 计数）、还原后重建 |
| `54_restored_live_dist.txt` | 还原后线上 index.html 引用与 7 用例复绿 |
| `60_testdb_init.txt`、`77_testdb_init_fresh2.txt` | 两个 ADR-025 临时库初始化原文（含 export 行） |
| `70_reg_{backtest,strategy-core,application,mcp}.txt`、`71_reg_web_run1.txt`、`72_reg_web_noFailFast_{A,B,C}.txt`、`82_regression_final.txt`、`83_regression_summary.txt` | 回归原始输出与汇总表 |
| `73_tempdb_pollution_after_flake.txt`、`74_adr026_suite_flake_stats.txt`、`75_other_targets_isolated.txt`、`76_tempdb_orphans_now.txt`、`78_isolation_experiment.txt` | G1/G3 定量：flake 统计、隔离重复、孤儿行定位、干净实验 |
| `80_frontend_vitest.txt`、`81_frontend_tsc.txt` | 前端回归：94 文件/916 用例 + `tsc -b` |
| `84_G2_head_red_check.txt` | 既有红 `tester_p5rect_verify` 的独立复核（常量出处 + 相关文件均未改动） |
| `90_db_teardown.txt`、`92_final_state.txt` | 库 teardown 与回读；收工进程/端口/healthz/audit/库清单 |
| `91_git_boundary_audit.txt`、`93_changed_files_sha256.txt` | 越界审计（git 纪律/残留探针/基线 diff）与本阶段改动文件 sha256 |
| `e2e/*` | 35 张截图 + 逐用例 console/网络采集 JSON + 摘要/口径文案原文 + 变异 mismatch JSON |

---

## 11. 裁决

A6（真浏览器 E2E + 变异反证 ×2）**实测通过**；①（重建重启）与 ⑤（越界审计）**通过**；④ 回归中受影响后端套件与前端 vitest 除「本批新增测试资产的并行 flake（G1）」与 1 个 HEAD 既有红（G2）外全绿，且 G3 已证明与 ADR-026 代码无关。
按 ADR-026 §5 **A7「受影响套件全绿」在默认 `cargo test -p web` 下不成立**（G1，测试隔离缺陷，非引擎/端点/UI 缺陷）。
仓内既有验收惯例为**零容忍基线**（对照 `tester/test/032_main_wave_flake_final_acceptance_execution.md`：上一轮「flake 修复」验收要求 `cargo test --workspace --no-fail-fast` **连续 3/3 全绿**方可 PASS），故本次不把 G1 降级为可接受债务，阶段 4 验收结论为：

VERDICT: FAIL A7 未达「受影响套件全绿」：本批新增 `crates/web/tests/adr026_run_audit.rs` 在默认并行下 flake（本阶段 4 次红：`audit_recorded_false_when_facts_are_missing` FK 23503 + `audit_endpoint_emits_required_tracing_fields` 捕获到并发用例的 span；隔离重复并行 1/5 红、串行 3/3 绿），另有 HEAD 既有红 `tester_p5rect_verify::t_n1_http_every_400_is_structured_object` 与跨目标共享库隔离红 `orphan_detect_endpoint_red::r1_…`（全新库不可复现，且隔离实验证明与本批代码无关）。A1–A6 全通过（含 A3/A4/A5 线上实测、A6 真浏览器 E2E 与两项变异反证、还原逐字节证明）；处置（修测试隔离 or 登记为已接受债务）交主代理。
