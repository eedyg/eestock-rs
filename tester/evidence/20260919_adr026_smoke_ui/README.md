# ADR-026 回测工作台 UI 端到端（真浏览器 Playwright/Chromium）+ 收尾裁决

- **本文件位置**：`tester/evidence/20260919_adr026_smoke_ui/README.md`
- **原始输出目录**：`tester/evidence/20260919_adr026_smoke_ui/raw/`
- **执行时间**：2026-09-19 11:21:05 → 11:28:20 CST（Asia/Shanghai；UTC 03:21:05 → 03:28:20），约 **7.2 分钟**（硬时限 25 分钟，未触限）
- **仓库 / HEAD**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e807385449a303a1090ac00a52c722b7b77e62ec`（本阶段**未**产生任何提交）
- **上游证据**：`tester/evidence/20260919_adr026_smoke_backtest/`（取其中 S1 新建 run）、`coder/evidence/20260919_adr026_redeploy/`
- **被测形态（先确认后测）**：
  - PID **818710**，`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，启动 **11:17:10**，cwd = 仓库根，同时持有 **8081 / 8082**（`ss -lntp` 实测）
  - `GET /healthz` → `{"status":"ok"}`；`GET /backtest-workbench` 返回 SPA，加载 bundle **`/assets/index-CkI-1t1L.js`**
  - bundle 一致性：`sha256(web/dist/assets/index-CkI-1t1L.js) = sha256(curl /assets/index-CkI-1t1L.js) = 4967c508e507cc2361620b74c56ed6a93cfa293df5a69fd5f64d71b71c437726`（浏览器实际加载的就是 ADR-026 前端构建产物，dist 时间戳 11:16:55）
- **测试用 run（只读，未删改任何 run 数据）**：S1 新写路径 `sr_1789787931919_000001`；历史兼容性对照 `sr_1789738328788_000005`
- **纪律**：未执行 `git add / commit / checkout / stash / reset`；`git diff --cached --stat` 为空（**0 staged**）；**未改动任何业务代码**（22 个 tracked `M` 文件 mtime 全部为 09-19 00:36–02:43，均早于本阶段起点 11:20，见 §5.2）；本阶段新写入的仓库文件**全部**位于 `tester/evidence/20260919_adr026_smoke_ui/raw/`（见 §5.3）；ADR-025 临时库已 `DROP`（见 §5.4）

---

## 裁决摘要

| 分节 | 内容 | 结果 |
|---|---|---|
| S1 | 真浏览器 E2E：S1 run 结果视图 / 交易明细审计摘要 / 8 项绩效口径注 / console+网络干净 | **PASS 25/25 checks** |
| S2 | 历史 run 交叉验证（`sr_1789738328788_000005`，兼容性回归） | **PASS**（来源列「未记录」属预期） |
| S3 | 回归冒烟：web vitest 916 用例 + `cargo test -p web --test adr026_run_audit` 4 用例 + `cargo test -p application --lib audit` 18 用例 | **PASS 全绿** |
| S4 | 变异反证（禁假绿）：/audit 断流 + 来源列期望被改 ⇒ **5 条断言变红**，随后逐字节还原（sha256 相同） | **PASS（断言非恒真）** |
| S5 | 越界审计：0 staged / 未改业务码 / 无仓库内自建探针 / 临时库与误建库均已 DROP | **PASS**（含 1 项工具怪癖与 1 项观察项，见 §6） |

### 部署形态只读复核（手册 Verification 的只读项；本阶段**未**重构建/重启动）

| 项 | 实测 |
|---|---|
| `ss -lntp` 8081+8082 同 PID | 818710 同时持有两端口 ✅ |
| `GET /healthz` | `{"status":"ok"}` ✅ |
| `GET /api/config/kline`（新契约字段） | `{"viewport_bars":120}`（旧字段不存在） ✅ |
| `GET /` 的 bundle 哈希 == dist/index.html 哈希 | `index-CkI-1t1L.js`，`/assets/<bundle>` 与 dist 文件 sha256 一致（`4967c508…`） ✅ |
| 启动日志 ERROR 计数（`logs/app_dev_8081_redeploy_20260919_111711.log`） | **0** ✅ |

未执行 `kill/nohup` 重启：本阶段开工时 8081/8082 已是 11:17:10 启动的 ADR-026 新版（bundle 与 dist 逐字节相同、新端点在线），重启动只会打断验收连续性（手册 Pitfalls 亦要求先确认无运行中 sim-live 会话）；故以「只读复核部署不变量」替代重启。手册第 2 步（sim-live 会话检查）与 PUT 配置冒烟已由上游 `coder/evidence/20260919_adr026_redeploy/` 完成，本阶段不重复、不新造写操作。

---

## S1 — 真浏览器端到端（Playwright 1.62.1 / Chromium headless，**非 jsdom**）

- 机具：`raw/ui_e2e.mjs`（`sha256=2971cde1cb018dc87b48c90b9a855f4c09f50415ef3c163635f73a476d068c9b`），直接 `import playwright` 驱动真 Chromium（`chromium-1234`），viewport 1680×1050、`locale=zh-CN`
- 输出：`raw/ui_e2e_stdout.txt`（首跑）与 `raw/ui_e2e_stdout_rerun.txt`（**换回原始脚本后的复跑**，两份**逐字节相同**，见 §4）、`raw/checks.json`

### 1.1 断言清单（25 条，0 失败）

| id | 断言 | 实测 |
|---|---|---|
| A00 | `/backtest-workbench` 加载 + 左侧运行列表渲染 | `workbench-page` 可见、S1 run 行存在 |
| — | 选中 run 行并完成结果取数（网络级确认） | `title="smoke_adr026_S1_REST_518880_D1_2025"`；`/runs/{id}/result|fills|audit` 均 200 |
| A01 | **结果视图正常出图（K 线 canvas）** | `wb-kline-chart` visible，内部 **10 个 canvas**（lightweight-charts 多 pane） |
| A02 | canvas 尺寸合理 | `1021 × 107`（容器 1680 宽布局内） |
| A03 | **`/fills` 标记来源计数可见** | `wb-fills-note="成交 4 笔（精确源 /fills）"`（S1 事实源 4 笔，与 S1 后端证据一致） |
| A04 | 无成交明细加载失败提示 | `wb-fills-error count=0` |
| A05 | **交易明细 Tab 出审计摘要行** | `成交合计 4 笔（含期末强平卖出 1 笔）｜回合 1 条（其中强平合成 1 条）｜名义投入 99.98%（分母 = 初始资金）` + `现金消耗（含佣金）100.00%｜计划批数 3｜可达轮次 52｜买入成交 3 笔｜未执行挂单 49`（与本阶段 S1 后端 `/audit` 逐值一致） |
| A06 | 审计摘要含四要素 | 现金消耗 / 计划批数 / 买入成交 / 未执行挂单 均在 |
| A07 | **warning 展示** | `count=1`：`ℹ 49 笔挂单未成交（末根 bar 无次 bar 可执行）`（= `ORDERS_UNEXECUTED`，与后端 audit.warnings 一致） |
| A08 | 无审计加载失败 | `wb-audit-error count=0` |
| A09 | 交易明细表含**「来源」列** | 表头 `["开仓","平仓","开价","平价","股数","盈亏","持仓","来源"]` |
| A10 | **S1 run 来源列 ∈ {正常, 止损, 期末强平}**（新写路径 `reason` 生效） | `labels=["期末强平"]`（后端 `trades[0].reason="ForceClose"`，标签映射正确） |
| A11 | S1 run 无「未记录」 | 无 |
| A12 | **8 项绩效表 = 8 行** | `rows=8` |
| A13 | **口径注存在** | `口径：年化 / 最大回撤 / 夏普的分母 = 初始资金 ¥100,000（未满仓时按实际投入口径的风险更高，故并列披露资金投入率）` |
| A14 | **资金投入率并列披露（两个口径）** | `资金投入率（名义投入 / 初始资金）= 99.98%；资金占用（含佣金）/ 初始资金 = 100.00%` |

### 1.2 出图非空证据（像素级，禁「有 canvas 就算过」）

对 `raw/s1_canvas_kline.png`（K 线容器元素截图 1068×256）做像素统计（PIL）：

| 文件 | 尺寸 | 不同颜色数 | 非背景像素 | 非背景占比 |
|---|---|---|---|---|
| `s1_canvas_kline.png` | 1068×256 | **2855** | 42397 | **15.5%** |
| `hist_canvas_kline.png` | 1068×256 | **3057** | 48979 | **17.9%** |

背景色 `(23,28,51)`（panel2），第二/第三高频色为 K 线涨绿 `(38,143,115)` 与跌红 `(181,36,75)` ⇒ **真实绘制了蜡烛与标记**，不是空画布。

### 1.3 console / pageerror / 失败请求（**全部为空**）

| 清单 | 结果 | 文件 |
|---|---|---|
| console error | **0** | `raw/console_errors.json` = `[]`（`raw/console_all.json` 亦为 `[]`：本次会话 Console 消息条数为 0） |
| pageerror | **0** | `raw/pageerrors.json` = `[]` |
| 失败请求（HTTP ≥ 400 或 requestfailed） | **0** | `raw/network_failed.json` = `[]` |

网络全景（`raw/network_all.json`，34 条响应，**状态码全为 200**）：

```
200 × 10  /api/workbench/available_range
200 ×  6  /api/workbench/runs/{id}/curve
200 ×  2  /api/workbench/runs/{id}/result
200 ×  2  /api/workbench/runs/{id}/fills
200 ×  2  /api/workbench/runs/{id}/audit      <- S1 run 与历史 run 各 1 次（懒加载按 Tab 生效）
200 ×  2  /api/workbench/runs/{id}/bars
200 ×  2  /api/kline
200 ×  1  /api/workbench/runs  /api/workbench/presets  /api/strategies  /api/symbols  /api/sources/health
200 ×  1  /backtest-workbench  /assets/index-CeUPb4uk.css  /assets/index-CkI-1t1L.js
```

截图：`raw/s1_tab_trades.png`（交易明细：审计摘要 + warning + 来源列）、`raw/s1_tab_metrics.png`（8 项绩效：口径注 + 资金投入率）、`raw/s1_canvas_kline.png`

---

## S2 — 历史 run 交叉验证（兼容性回归）→ PASS

`sr_1789738328788_000005`（09-18 的历史 run，`TradeDetail.reason` 缺字段）：

| id | 断言 | 实测 |
|---|---|---|
| A15 | 结果视图仍正常渲染（K 线 canvas 存在） | ✅ |
| A16 | 交易明细 Tab 出审计摘要（**非报错**） | ✅ `成交合计 43 笔（含期末强平卖出 1 笔）｜回合 1 条（其中强平合成 1 条）｜名义投入 41.40%…`；3 条 warning（`DCA_PLAN_UNDERFILLED` / `PARTIAL_DEPLOYMENT` / `ORDERS_UNEXECUTED`）——与本阶段 S6 后端正对照逐项一致 |
| A17 | **来源列全部显示「未记录」**（无 reason，属预期） | ✅ `rows=1 labels=["未记录"]` |
| A18 | 8 项绩效 8 行 + 资金投入率可用 | ✅ `资金投入率（名义投入 / 初始资金）= 41.40%；资金占用（含佣金）/ 初始资金 = 41.61%` |
| A19 | fills note 可见 | ✅ `成交 43 笔（精确源 /fills）` |

截图：`raw/hist_tab_trades.png`、`raw/hist_tab_metrics.png`、`raw/hist_canvas_kline.png`

---

## S3 — 回归冒烟（原始输出）

### 3.1 `cd web && npx vitest run` → **exit 0**（全文：`raw/vitest_run_full.txt`，319 行）

```
 Test Files  94 passed (94)
      Tests  916 passed (916)
   Start at  11:28:33
   Duration  7.88s (transform 3.82s, setup 4.66s, collect 15.76s, tests 41.75s, environment 30.54s, prepare 7.72s)
```

（两次独立运行口径一致：11:22:29 → 94 files / 916 tests / 7.97s；11:28:33 → 94 files / 916 tests / 7.88s。其中 `src/features/workbench/ResultView.test.tsx` **27 用例**全绿（含 P6 长区间不静默截断、事件日志覆盖范围显式标注两条重用例）。94 个文件的逐行结果见 `raw/vitest_run_full.txt`。）

### 3.2 `cargo test -p web --test adr026_run_audit`（ADR-025 临时库）→ **exit 0**

- 环境：`EESTOCK_TEST_DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/tmp_ui_adr026_202609191122`
- 全文：`raw/cargo_test_web_adr026_run_audit.txt`

```
running 4 tests
test adr026_replay_target_run_matches_frozen_baseline ... ok
test audit_recorded_false_when_facts_are_missing ... ok
test audit_endpoint_matches_recorded_facts_and_404_semantics ... ok
test audit_endpoint_emits_required_tracing_fields ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.82s
```

### 3.3 `cargo test -p application --lib audit` → **exit 0**

- 全文：`raw/cargo_test_application_lib_audit.txt`

```
running 18 tests
…（18 条 audit::tests 全 ok，含 trade_detail_json_reads_legacy_without_reason_field /
   report_serializes_frozen_field_names / partial_deployment_threshold_table 等）
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out; finished in 0.00s
```

---

## S4 — 变异反证（证明断言不是恒真）→ PASS

**变异体**：`raw/mutation_apply.py` 对 `raw/ui_e2e.mjs` **原位**施加 3 处突变——

1. **M1 响应拦截**：`page.route('**/audit*', r => r.abort('failed'))`（审计事实源断流）
2. **M2 改期望**：来源列允许集由 `{正常,止损,期末强平}` 改为 `{正常}`（本条 run 实际为「期末强平」⇒ 期望必错）
3. M3 把可能被带崩的读取改软失败，使一次运行能吐全红清单（不改断言语义）

**变异运行结果（`raw/mutation_run_stdout.txt`，node exit **1**）**：

```
FAIL | A05 | 交易明细 Tab 出「审计摘要行」（wb-audit-summary） | text="<<not rendered>>"
FAIL | A06 | 审计摘要含现金消耗/计划批数/买入成交/未执行挂单 | <<absent>>
FAIL | A07 | warning 展示（本条 run 预期 ORDERS_UNEXECUTED） | count=0 texts=[]
FAIL | A08 | 无审计加载失败 | wb-audit-error count=1
FAIL | A10 | S1 run 来源列显示 正常/止损/期末强平 之一（新写路径 reason 生效） | rows=1 labels=["期末强平"]
（随后脚本在 A14 读取 wb-metrics-deployed 处因审计错误态被替换而超时中断；该中断本身也是「审计不可达 ⇒ 绩效区口径披露同时失效」的红向证据）
```

⇒ A05/A06/A07/A08（审计断流）与 A10（错误期望）**确实变红**；同一套断言在正常态全绿（§1）⇒ **绿不是假绿**。

**逐字节还原证明（sha256）**：

```
-- 变异前   raw/ui_e2e.mjs:  2971cde1cb018dc87b48c90b9a855f4c09f50415ef3c163635f73a476d068c9b
-- 变异体（mutation_apply.py 施加后，重放推导字节）:
                            2dd415be2430d1e918dead9346325b566ef6a8fd8f5d006b4d7ab8d0e7f74797
-- 还原后   raw/ui_e2e.mjs:  2971cde1cb018dc87b48c90b9a855f4c09f50415ef3c163635f73a476d068c9b
```

- 还原方式：变异前 `cp ui_e2e.mjs /tmp/ui_e2e_pristine.mjs`，运行后 `cp` 回原位 ⇒ `mutation_sha_before.txt` 与 `mutation_sha_after.txt` **文件内容逐字节相同**（`diff` → IDENTICAL_OK），现场文件哈希与变异前一致。
- 变异体哈希**可复现**：对原始文件重放 `mutation_apply.py`（写到 `/tmp`，**不触碰仓库**）得 `2dd415be…`，并用该变体复跑一次 ⇒ 输出的 PASS/FAIL 清单与运行时变体**逐行相同**（`diff` 无差异，5 条 FAIL，见 `mutation_run_stdout.txt` vs 本次复跑），故 `2dd415be…` 即运行时变体的字节。
- 变异产物截图另存 `raw/mut_out/`、`raw/mut_out2/`（红向状态留证，未覆盖正常态证据）。

---

## S5 — 越界审计

### 5.1 git（未动历史）
- `git diff --cached --stat` → **空**（0 staged）
- `git reflog -5` 顶部仍是 `e807385 commit: chore(deploy): ADR-024 上线记录与手册修订`（本阶段**无** add/commit/checkout/stash/reset 记录）
- `git status --porcelain` 中 tracked 变更 = 22 个 `M`（ADR-026 交付既有改动），`HEAD = e807385449a303a1090ac00a52c722b7b77e62ec`，`git diff --stat` = `22 files changed, 1085 insertions(+), 33 deletions(-)`（与部署前一致）

### 5.2 未触碰业务代码（mtime 反证）
22 个 tracked `M` 文件 mtime 全部为 **09-19 00:36:50 → 02:43:07**（早于本阶段起点 11:20:30），全文见 `raw/tracked_m_mtimes.txt`。⇒ 这些改动**不是本阶段所为**。

### 5.3 无仓库内残留探针
- 本阶段写入的仓库文件共 **30 个**，**全部**位于 `tester/evidence/20260919_adr026_smoke_ui/raw/**`（清单：`raw/touched_files_since_1120.txt`，其中还含上游 S1 冒烟 README，mtime 11:20:3x，属上游车道）
- 未在 `crates/`、`web/`、`scripts/`、`design/` 下新增/修改任何文件
- 浏览器机具 `ui_e2e.mjs` 放在**证据目录**内，未落在 `web/e2e/`；已确认无 `.bak`/`.orig`/临时探针残留（`/tmp` 下的中间体不属仓库）

### 5.4 DB 收尾
```
DROP DATABASE "tmp_ui_adr026_202609191122"  -> DROP DATABASE
DROP DATABASE "eestock_test"                 -> DROP DATABASE
回读：SELECT datname FROM pg_database WHERE datname ~ '(tmp_|test|adr0|probe)'  -> 空
库清单（非 template）：postgres, eestock
后台 worker 计数 / max_worker_processes：2 / 32
```
（详见 `raw/testdb_drop.txt`、`raw/db_age.txt`、`raw/post_drop_workers.txt`）

> **需显式披露的自查发现（非缺陷，但必须记录）**：本阶段**首条** testdb 命令漏传 `EESTOCK_TEST_DB_NAME`，脚本按默认库名建了 `eestock_test`（`raw/db_age.txt` 的 `PG_VERSION` mtime = `2026-09-19 03:22:41Z` = 本阶段 11:22:41，证明它是**本阶段新建**、并非既有库；上游 ADR-026 后端车道的收尾记录亦写明当时库清单只剩 `{eestock, postgres}`）。该库已在收尾 **DROP**，库清单恢复到 `{eestock, postgres}`，与开工前一致。

---

## S6 — 观察项 / 残留不确定性（**显式列出**）

| 编号 | 观察 | 证据 |
|---|---|---|
| U1 | **首跑 testdb-init 撞 TimescaleDB 并发刷新**：对新建临时库 `tmp_ui_adr026_202609191122` 应用迁移时，最后一条 `0026_period_30m.sql` 的 `refresh_continuous_aggregate('kline_accurate_5m')` 报 `ERROR: could not refresh continuous aggregate "kline_accurate_5m" due to a concurrent refresh / DETAIL: A concurrent refresh on window [4714-11-24 00:00:00+00 BC, infinity) is already in progress.`，脚本 **exit 3**（迁移账本停在 0025）；**对同一库原样重跑即 exit 0**（0026 重放成功并完成播种）。属工具链怪癖（TSDB cagg 刷新与同实例内并发 refresh 冲突），非 ADR-026 代码问题。 | `raw/testdb_init_stderr.txt` = **成功那一次（第 3 次运行，exit 0）**的日志（末行 `kline_accurate_1d 现有 6772 行`，无 ERROR）；首跑的 exit 3 原始 stderr 因重定向同文件被覆盖，**无独立落盘文件**，仅有本报告正文转录的 ERROR 原文 —— **如实披露该证据缺口**。可复现路径见 §复现方式（新建 tmp 库首次 init 时存在该概率性冲突，重跑即过） |
| U2 | **`/api/workbench/available_range` 在一次会话内被请求 10 次**（K 线取数区间解析），全程 200、无报错；若属轮询/重复解析，属既有行为，本阶段**未**判定为缺陷。 | `raw/network_all.json` |
| U3 | **仓库内存在上游车道的未跟踪 E2E 规格** `web/e2e/adr026-audit.e2e.ts`（mtime 09-19 01:44，`git status` 为 `??`）与 `web/e2e/artifacts/`（10:54）。**非本阶段产物**，本阶段未运行、未修改、未删除（避免越界）。若架构侧要求「无未跟踪探针入库」，需由拥有该产物的车道处置。 | `git status --porcelain`、`ls -la web/e2e/` |
| U4 | `raw/ui_e2e_stdout.txt` 与 `raw/ui_e2e_stdout_rerun.txt` 逐字节相同（`sha256=fac658f6eff2f2ef…`），即换回原始脚本后 25/25 复现，**无 flake**；但两次运行共用同一 Chromium 版本与同一线上进程，**未**做跨版本/跨浏览器（Firefox/WebKit）验证。 | 两份 stdout |
| U5 | vitest 全文已落盘 `raw/vitest_run_full.txt`（第 2 次运行）；第 1 次运行（11:22:29，也是 94/916）仅落汇总行。两次独立运行结果一致，但**同一工作树**，非干净环境复现。 | §3.1 |
| U6 | 变异运行的终止点在 A14（读取 `wb-metrics-deployed` 超时），故红清单是 **5 条 + 1 条中断**而非完整 25 条红向评估；不影响「断言非恒真」结论。 | `raw/mutation_run_stdout.txt` |
| U7 | 上游 S1 冒烟报告遗留的 O1–O5（404 错误体形状、`Dca.interval=0` 语义、提交响应无 `effective_*`、大 run 未跑完、running 中间态不可观测）**未被本阶段覆盖**，仍待架构侧裁决。 | 上游 `README.md` |

## 复现方式

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs/web
node ../tester/evidence/20260919_adr026_smoke_ui/raw/ui_e2e.mjs \
     ../tester/evidence/20260919_adr026_smoke_ui/raw            # -> exit 0, 25/25
# 变异反证（会原位改 ui_e2e.mjs，务必先备份并还原）
cp ../tester/evidence/20260919_adr026_smoke_ui/raw/ui_e2e.mjs /tmp/bak.mjs
python3 ../tester/evidence/20260919_adr026_smoke_ui/raw/mutation_apply.py \
        ../tester/evidence/20260919_adr026_smoke_ui/raw/ui_e2e.mjs
node ../tester/evidence/20260919_adr026_smoke_ui/raw/ui_e2e.mjs /tmp/mut_out    # -> exit 1, 5 FAIL
cp /tmp/bak.mjs ../tester/evidence/20260919_adr026_smoke_ui/raw/ui_e2e.mjs       # 还原
# 回归冒烟（需 DB 的两条走 ADR-025 临时库）
DB=tmp_ui_adr026_$(date +%Y%m%d%H%M)
EESTOCK_TEST_DB_NAME=$DB bash scripts/testdb-init.sh > /tmp/env.sh 2>/dev/null || \
EESTOCK_TEST_DB_NAME=$DB bash scripts/testdb-init.sh > /tmp/env.sh   # 幂等重跑一次即可（见 U1）
eval "$(cat /tmp/env.sh)"
cargo test -p web --test adr026_run_audit
cargo test -p application --lib audit
PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d postgres -c "DROP DATABASE \"$DB\""
```

## 纪律与收尾核对

- ✅ 未执行 `git add / commit / checkout / stash / reset`（`git reflog` 顶部未变、0 staged）
- ✅ 未修改任何业务代码 / 测试代码（22 个 `M` 文件 mtime 全部早于本阶段起点；本阶段新文件全部在证据目录内）
- ✅ 未删除任何 run 数据；E2E 全程只读（GET），未提交新 run、未 cancel
- ✅ ADR-025 临时库 `tmp_ui_adr026_202609191122` 已 DROP；误建的 `eestock_test` 亦已 DROP；库清单回到 `{eestock, postgres}`
- ✅ 变异反证在**证据目录内**的机具文件上进行并逐字节还原（sha256 相同），未触碰 `web/src/**`
- ✅ 无命令被 kill（全部在 4 分钟上限内返回；`testdb-init` 单次最长约 40s、cargo 测试 <1s、E2E 单次约 40s）

---

_本报告文件_：`tester/evidence/20260919_adr026_smoke_ui/README.md`
_设计报告（新增测试机具的设计）_：`tester/design/295_adr026_ui_e2e_design.md`
