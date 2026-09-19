# ADR-026 整改后复验（G1 / G2 / G3 / G4）—— Tester 侧收尾报告

- **本报告位置**：`tester/evidence/20260919_adr026_fix_verify/README.md`（原始输出：同目录 `raw/`）
- **契约（冻结）**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`
- **上游（先读、复用其原始输出，不重跑已绿部分）**：
  - `coder/evidence/20260919_adr026_fix/README.md`（R-G1 / R-G2 / R-G4 修复说明与取舍）
  - `tester/evidence/20260919_adr026_fix_verify/raw/`（本批前半段原始输出：00/20/23/24/30/31/32/40/41/50）
- **基线 commit**：`git rev-parse HEAD` = `e807385449a303a1090ac00a52c722b7b77e62ec`（未 add/commit/checkout/stash/reset；`git diff --cached` 空、staged 文件数 = 0）
- **纪律**：只验不改（除 E2E spec 文案同步外不改任何文件）、禁 git add/commit、禁改实现；不得用上游输出替代自己的实测。
- **本 Agent 写入范围**：仅 `tester/evidence/20260919_adr026_fix_verify/`（README + `raw/`）与 `/tmp` 临时脚本；**未改任何源码 / 测试资产 / E2E spec**。

---

## 0. 判词摘要

| 项 | 结论 | 关键读数 | 证据 |
|---|---|---|---|
| **G1** 新增套件并行 flake 确定性修复 | **PASS（绿）** | 修复点核验通过（无跨用例删除、夹具 pid×seq×tag 唯一）+ 两项变异反证均红 + 哨兵行 BEFORE==AFTER；web 目标套件默认并行 **5/5 绿**（29 目标/173 用例/次）；workspace 全新库 **3/3 绿**（130 目标/895 用例/次） | `raw/20`、`raw/23`、`raw/24`、`raw/30`、`raw/31`、`raw/32` |
| **G2** 既有红（阈值漂移） | **PASS（绿）** | 目标 `4 passed; 0 failed`；新夹具 627,564 bar 落在 `500_000 ≤ bars ≤ 2_000_000` 窗口；负面对照（退回旧区间 292,092 bar）必红、还原后复绿 | `raw/40`、`raw/41` |
| **G4** 口径文案消歧（真浏览器） | **PASS（绿）** | bundle 与源码一致（hash 不变）；真浏览器 E2E **7/7 passed**，L1/L2/warning×3/来源列/8 项口径注/无 console error/无失败请求全过；采集器与断言均有非恒真反证 | `raw/60`、`raw/61`、`raw/e2e/*` |
| **前端 vitest**（受影响套件之一） | **PASS（绿）** | `94 passed (94 files)` / `916 passed (916 tests)`，exit=0 | `raw/62` |
| **G3** 跨目标共享库隔离 flake | **登记技术债（既有、非本批；不作 FAIL 依据）** | 同一全新库：RUN1 **exit=0 全绿**、RUN2 **exit=101 红**；目标用例 `orphan_detect_endpoint_red::r1…` 在 RUN2 `FAILED`（`orphan_detect_endpoint_red.rs:47`，`left: 2 / right: 0`）；RUN2 另有 6 个 `tester_*_indep` 目标同源红 | `raw/70_g3_confirm.txt` |

---

## 1. 证据映射

### 1.1 复用本批 raw/ 前半段原始输出

| # | 复核项 | 命令 / 口径 | 结论 | 关键读数 | 证据（raw/） |
|---|---|---|---|---|---|
| 1 | **G1 修复点核验**（自己 grep 测试源） | `grep -n` 测试源修复点 | **绿** | 无跨用例 `DELETE … id LIKE 'sr_adr026%'`；夹具唯一键 = 完整 pid × 进程内原子自增 `FIX_SEQ` × tag；`clean()` 只删本用例私有行 | `raw/30_g1_fixpoint_grep.txt` |
| 2 | **G1 边界/反证**（变异反证 + 哨兵存活） | 变异 M1/M2 + 哨兵实验 | **绿** | M1（共用 code）第 1 次即红；M2（trace 期望改不存在 run）红并打印实际捕获；哨兵 5 项计数 BEFORE == AFTER（3× 目标 + 全量 `-p web`） | `raw/31_g1_repeat_baseline_and_mutations.txt`、`raw/32_g1_sentinel_survival.txt` |
| 3 | **G1 修复后 · web 目标套件默认并行 ×5** | `cargo test -p web --no-fail-fast`（每次全新 ADR-025 临时库） | **绿** | 5/5 次 exit=0；每次 29 目标 / 173 用例 / 0 failed；`adr026_run_audit` 每次 `4 passed; 0 failed` | `raw/20_postfix_web_default_parallel_x5.txt`、`raw/23_*_rebuilt.txt`（lane webrb1..5，exit=0 ×5） |
| 4 | **G1 修复后 · workspace 全新库 ×3** | `cargo test --workspace --no-fail-fast`（每次全新库） | **绿** | 3/3 次 exit=0（02:37→02:42）；每次 130 目标 / 895 用例 / 0 failed | `raw/24_workspace_nofailfast_freshdb_x3.txt`（lane ws1/ws2/ws3） |
| 5 | **G2 复验**（阈值漂移既有红 → 夹具区间修正） | `cargo test -p web --test tester_p5rect_verify` | **绿** | 目标 `4 passed; 0 failed`；新夹具区间 `2016-01-01→2027-01-01` 实测 **627,564 bar** | `raw/40_g2_reverify.txt` |
| 6 | **G2 负面对照**（退回旧区间必红） | 退回 `2021-01-01→2026-01-01`（292,092 bar < 500,000） | **绿（对照符合预期）** | 旧区间不命中护栏 ⇒ 表项红；还原后（sha256 复原 `8dfe5fe0…`）复绿 `4 passed` | `raw/41_g2_negative_control.txt` |
| 7 | **前端重建 + 应用重启**（G4 前置） | `npm run build` + kill 旧进程 + 重启 | **绿** | bundle `index-CkI-1t1L.js` sha256 `4967c508…`（重建前后 hash 不变）；`:8081`/`:8082` 归当前 PID **634454**（STARTED 2026-09-19 10:14:03）；`healthz=200` | `raw/50_frontend_rebuild_and_restart.txt` |

### 1.2 G4 文案复验（自采，真浏览器）—— **绿**

**① bundle 与源码一致性**（`raw/60_g4_build_and_e2e.txt`）：

- `cd web && npm run build` ⇒ **exit 0**，`✓ 184 modules transformed / built in 2.13s`；
- 重建**前后** dist hash **不变**：`index-CkI-1t1L.js` sha256 `4967c508e507cc2361620b74c56ed6a93cfa293df5a69fd5f64d71b71c437726`、`index-CeUPb4uk.css` sha256 `cc991403600598936124bbd124e5306613b49957327447ffcd7e563ca393f90f`；
- `:8081`/`:8082` PID = **634454**（STARTED `Sat Sep 19 10:14:03 2026`）；线上 `GET /backtest-workbench` 的 `index.html` 引用 `assets/index-CkI-1t1L.js` + `assets/index-CeUPb4uk.css` ⇒ **线上 bundle == 当前源码产物**。

**② E2E 真浏览器执行**（`raw/61_g4_e2e.txt`）：

```
cmd: E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test e2e/adr026-audit.e2e.ts --retries=0 --timeout=20000
Running 7 tests using 1 worker
  ✓ 10_baseline_trades   ✓ 11_baseline_metrics   ✓ 12_legacy_sources   ✓ 13_reason_injection
  ✓ 14_control_audit_500 ✓ 90_mutation_deployed  ✓ 91_mutation_warnings
  7 passed (3.9s)   E2E exit=0
```

**③ 断言逐项对照**（`raw/e2e/` 内 JSON + PNG，本轮 10:55 新落盘）：

| 断言 | 期望 | 实测 | 证据 |
|---|---|---|---|
| L1 行 | 含「成交合计 43 笔（含期末强平卖出 1 笔）」 | `"成交合计 43 笔（含期末强平卖出 1 笔）｜回合 1 条（其中强平合成 1 条）｜名义投入 41.40%（分母 = 初始资金）"` | `raw/e2e/base_10_baseline_trades_lines.json` |
| L2 行 | 含「买入成交 42 笔」 | `"现金消耗（含佣金）41.61%｜计划批数 100｜可达轮次 43｜买入成交 42 笔｜未执行挂单 1（末根 bar 无次 bar 可执行）"` | 同上 |
| 3 条 warning | `DCA_PLAN_UNDERFILLED`(⚠)/`PARTIAL_DEPLOYMENT`(⚠)/`ORDERS_UNEXECUTED`(ℹ) | warning 循环 3 项全满足；`mismatch = []` | `base_10_baseline_trades_mismatch.json` |
| 来源列 | 表头含「来源」；历史 run 全「未记录」 | `headers.includes('来源')` 通过；`sources = ["未记录"]` | `base_10_baseline_trades_sources.json`、`base_12_legacy_sources.json` |
| 8 项口径注 | `basis` 含「口径」「分母 = 初始资金 ¥100,000」；8 行 | `"口径：年化 / 最大回撤 / 夏普的分母 = 初始资金 ¥100,000（未满仓时按实际投入口径的风险更高，故并列披露资金投入率）"`；`rows = 8`；mismatch `[]` | `base_11_baseline_metrics_lines.json`、`base_11_baseline_metrics.json` |
| 无 console error / 无失败请求 | 4 类采集器全空 | 用例 10/11：`consoleErrors=[] failedRequests=[] httpErrors=[] pageErrors=[]` | `base_10_baseline_trades.json`、`base_11_baseline_metrics.json` |
| **采集器非恒空（负面对照）** | 注入审计 500 ⇒ 采集器**必须**非空 | `consoleErrors=["[error] Failed to load resource: … 500 …"]`、`httpErrors=["500 GET …/audit"]` | `base_14_control_audit_500_obs.json` |
| **断言非恒真（变异反证）** | 注入 `deployed_pct=1.0`/`batches_done=7`、`warnings=[]` ⇒ 断言**必须**变红 | 两变异 mismatch 均非空并列出具体失败项 | `base_90_mutation_deployed_mismatch.json`、`base_91_mutation_warnings_mismatch.json` |

截图：`raw/e2e/base_10_trades_tab.png`、`base_10c_audit_summary_el.png`、`base_10d_trades_table_el.png`、`base_11_metrics_tab.png`、`base_11c_metrics_basis_el.png`、`base_12b_legacy_trades_table_el.png`、`base_13b_reason_table_el.png`、`base_90b_mutation_summary_el.png`。

### 1.3 前端 vitest（自采）—— **绿**

`raw/62_frontend_vitest.txt`：`npx vitest run` ⇒ `Test Files 94 passed (94)` / `Tests 916 passed (916)`，`vitest exit=0`（Duration 7.76s）。

### 1.4 G3 一次确认性测量（自采）—— 既有隔离债，**登记事实，不作本批 FAIL 依据**

命令（`raw/70_g3_confirm.txt`）：

```bash
EESTOCK_TEST_DB_NAME=tmp_g3confirm_1789786540 scripts/testdb-init.sh   # 全新库
EESTOCK_TEST_DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/tmp_g3confirm_1789786540 \
  timeout 400 cargo test -p web --no-fail-fast                          # RUN1 → RUN2 同库连跑
psql … DROP DATABASE tmp_g3confirm_1789786540 WITH (FORCE)
```

**事实（不归因）**：

| 指标 | RUN1（新库首跑） | RUN2（同库次跑） |
|---|---|---|
| 总退出码 | **0** | **101** |
| `test result: FAILED` 目标数 | **0** | **7** |
| 目标用例 `orphan_detect_endpoint_red::r1_orphan_endpoint_exists_and_reports_zero_on_clean_db` | **ok** | **FAILED** |
| 失败点 | — | `crates/web/tests/orphan_detect_endpoint_red.rs:47:5`，`assertion left == right failed`（`left: 2` / `right: 0`） |
| RUN2 其余红目标 | — | `tester_p4_endpoints_indep`(0/3)、`tester_p4_writepath_indep`(0/6)、`tester_p5_indep`(2/11)、`tester_p5rect_verify`(2/2)、`tester_p6_fills_indep`(0/4)、`ws_poller`(0/1) ⇒ 合计 **28 failed 用例** |

- 起止：RUN1 `10:55:57→10:56:40`；RUN2 `10:56:40→10:57:28`；`### end 10:57:28`。
- 收尾：`DROP DATABASE tmp_g3confirm_1789786540 WITH (FORCE)` ⇒ `DROP DATABASE`；库清单回读 = `eestock,postgres`（不含 `template*`）⇒ 已清场。
- 复现率：本批 1 次测量中**第 2 次跑红 1/1**；连同上游 coder G3 同库次跑红，观测 **2/2 均红**。
- 判读：跨目标共享同一测试库导致的隔离相互污染（既有债务）。**与本批 G1/G2/G4 修复无因果关系**（fresh-DB 口径下全绿，见 §1.1 #3/#4 与 §1.2/§1.3）。按派单口径，此债务另立项，**不作为本批 FAIL 依据**，仅如实登记。

---

## 2. 复现命令

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
# G1 修复后 web 目标套件（默认并行，每次全新库）
URL=$(EESTOCK_TEST_DB_NAME=tmp_webg1_$(date +%s) scripts/testdb-init.sh | grep -o "EESTOCK_TEST_DATABASE_URL='[^']*'" | sed "s/.*='//;s/'//")
EESTOCK_TEST_DATABASE_URL="$URL" cargo test -p web --no-fail-fast
# G1 修复后 workspace（全新库 ×3）
cargo test --workspace --no-fail-fast
# G2
cargo test -p web --test tester_p5rect_verify
# G4 真浏览器 E2E
cd web && E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test e2e/adr026-audit.e2e.ts --retries=0 --timeout=20000
# 前端 vitest
cd web && npx vitest run
# G3 同库连跑两次（见 §1.4）
```

---

## 3. 待补项

无。§2 A（G4 真浏览器）与 B（G3 测量）均已完成，见 §1.2 / §1.4。

---

## 4. 最终裁决

**判据（主代理冻结口径）**：ADR-026 受影响套件 = fresh-DB workspace ×3 + web 目标套件 + 前端 vitest + 真浏览器 E2E。

| 受影响套件 | 结论 | 证据 |
|---|---|---|
| fresh-DB workspace ×3 | **绿** | `raw/24` |
| web 目标套件（默认并行 ×5 + 重建后 ×5） | **绿** | `raw/20`、`raw/23` |
| 前端 vitest（94 文件 / 916 用例） | **绿** | `raw/62` |
| 真浏览器 E2E（7/7） | **绿** | `raw/61`、`raw/e2e/*` |
| 辅助：G1 修复点 + 变异/哨兵反证、G2 复验 + 负面对照、bundle 一致性 | **绿** | `raw/30/31/32/40/41/60` |

- **G3（孤儿检测跨目标共享库 flake）**：既有、非本批债务；本批实测第 2 次跑红 1/1（连同上游 2/2），**已如实在 §1.4 登记事实与复现率**，按主代理决定另立项，**不作为本批 FAIL 依据**。
- **不存在**实测与上述口径不符的项。
- 我未改动任何实现 / 测试资产 / E2E spec；`git diff --cached` 为空（staged = 0）。

**裁决：本批受影响套件全部复核为绿 ⇒ PASS。**

VERDICT: PASS
