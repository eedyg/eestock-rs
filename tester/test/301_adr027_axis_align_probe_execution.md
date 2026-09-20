# 执行报告 301 — ADR-027 曲线/K 线时间轴对齐「测量规格」真渲染执行

- **本文件位置**：`tester/test/301_adr027_axis_align_probe_execution.md`
- **被执行的规格（新建）**：`web/e2e/adr028-axis-align-probe.e2e.ts`
- **测试设计**：`tester/design/297_adr027_axis_align_probe_design.md`
- **证据与判词报告**：`tester/evidence/20260920_adr027_axis_align/report.md`
- **原始证据目录**：`tester/evidence/20260920_adr027_axis_align/raw/`
- **角色边界**：tester，本波**只测量与取证**：未修改任何生产代码、未做任何修复尝试、未对失败做原因分析。

## 1. 运行元信息

| 项 | 值 |
|---|---|
| 执行时间（本地） | 2026-09-20 09:07:32 ~ 09:08:00 CST（最后一次运行） |
| 执行时间（UTC） | 2026-09-20T01:07:32Z ~ 01:08:00Z |
| commit | `aa5444eb98e2e4876e8d6a3fb414c87ca08966d2`（`master`，`aa5444e`） |
| 被测环境 | `http://localhost:8081`（线上 eestock-app pid 1941108；静态 = `web/dist` bundle `assets/index-D8WPpeNL.js`，未重建） |
| 目标 run | `sr_1789832517800_000006`（518880 / M5 / 1949 根） |
| 测试栈 | Playwright 1.63.0 / chromium（`devices['Desktop Chrome']`，视口 1280×720；`workers=1`、`retries=0`（本次命令行覆盖）、`timeout=300s`（spec 内）） |
| 启动方式 | **不起 vite preview**：直接对线上 8081 跑（前端静态已是最新，见任务书）；不需要 `vite build` |

## 2. 运行矩阵（同一份规格文件，4 次执行）

| # | 规格版本 | 命令 | 结果 | 说明 |
|---|---|---|---|---|
| 1 | v1（初版） | `E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-axis-align-probe.e2e.ts --retries=0` | **1 failed**（14.0s） | 失败点 = **规格自身**的测量完整性断言 `full：必须产出首/中/末 + argmax 行`（`rows.length` 期望 ≥3、实测 0）。取证到两条重要事实：① L2 跳转目标若不落在 K 线已加载数据内，窗口会退化（4 根 / barSpace 1）；② 全览态曲线的渲染点数与共享窗口不一致。据此改规格（不改生产代码）。 |
| 2 | v2 | 同上 | **1 passed**（21.0s） | 动态挑选「落在 K 线已加载区间内」的 L2 回合；新增曲线渲染 x 反解与覆盖缺量。 |
| 3 | v3 | 同上 | **1 passed**（26.6s） | 新增 ⑥ 无缺口对照组（真滚轮放大到 ≤40 根）+ `verdict.json` 汇总。 |
| 4 | v4（**最终**） | 同上 | **1 passed**（spec 26.6s / total 27.0s） | 新增曲线采样标注文本（`wb-aggregate-sampling`）与 K 线 dataList 端点；先 `rm -rf raw/` 后重跑，raw/ 为本次纯净产物。 |

**最终一次运行结果**：`total 1 / passed 1 / failed 0 / skipped 0`（Playwright `1 passed (27.0s)`，退出码 0）。

## 3. 失败用例表（含 v1 规格自检失败，供追溯）

| 用例 | 阶段 | 错误信息（原文摘要） | crash / core |
|---|---|---|---|
| `P1_probe_viewports`（v1 版本） | 测量完整性断言 | `Error: full：必须产出首/中/末 + argmax 行 — expect(received).toBeGreaterThanOrEqual(expected) — Expected: >= 3, Received: 0`（`web/e2e/adr028-axis-align-probe.e2e.ts:730`） | 无 |
| 其它 | — | 无 | 无 |

- **无崩溃、无 core dump**：执行后 `ps -eo pid,args | grep -E "chrom[e]ium|headless_shell"` 为空（无遗留浏览器进程）；未产生 core 文件（仅 Playwright 常规失败截图 `web/e2e/artifacts/test-results/...`，未纳入证据）。
- **不分析失败原因**（角色纪律）：v1 的失败已按「改规格以覆盖真实状态」处理（属于测量方法本身，不涉及产品代码）；其暴露的两条产品侧事实已作为观测写入证据报告 §4.1 / §4.2。

## 4. 覆盖摘要

- e2e 无行覆盖率口径（无 instrumentation、未加永久埋点）。
- 测量覆盖（本轮实测）：**6 个视口状态** × {K 线真身读回、聚合总分曲线、各策略评分曲线（slot）、缺口普查、Δ984 逐点序列、截图 4 张/态}。
  - 状态：`init`（初始 kline 窗口，90 根）、`full`（全览）、`narrow120`（L2 跳转，123 根）、`zoom300`（真滚轮，317 根可见）、`zoom600`（真滚轮，595 根可见）、`controlGapless`（无缺口对照，2 根共同覆盖）。
- 判据覆盖：`max|Δ984| > 2px ⇒ 不对齐`；同时给出 Δraw（屏上原始像素）与缺口折叠模型（数值）三条口径。

## 5. 资源纪律（硬约束逐项自证）

| 约束 | 实测 |
|---|---|
| 单车道，不 spawn 子代理 | 未使用任何子代理；所有命令在本会话串行执行 |
| playwright 只跑新建的这一个测量规格 | 4 次运行均为 `e2e/adr028-axis-align-probe.e2e.ts`；另加 2 次 `--list`（只解析，不起浏览器） |
| 跑完确认无 `vite preview` 残留 | `ps -eo pid,args \| grep -E "vite[[:space:]]+(preview\|build)"` → 运行前后均无输出（`(none)`）；全程未启动 vite |
| 无遗留 chromium | 执行后 `grep -E "chrom[e]ium\|headless_shell"` → 无输出 |
| 每步记一次 `free -h` | 记录于下方 |
| 命令一律 `timeout` 前缀、`curl` 加 `--max-time` | 所有 playwright 运行 `timeout 400 …`；所有 curl `--max-time 10/15`（探针：`/api/health`、`/api/workbench/runs`、`/round-trips`、`/bars`、`/curve`、`/backtest-workbench`） |
| grep/find 带排除目录 | 本轮取证检索均限定 `web/src`、`web/dist/assets`、`node_modules/klinecharts/dist` 等具体路径（未做根目录全量 grep） |

`free -h` 采样（available 列，全程无内存压力）：

| 采样点 | total | used | free | buff/cache | available |
|---|---|---|---|---|---|
| 起步 | 46Gi | 18Gi | 20Gi | 9.5Gi | 27Gi |
| 规格就绪（pre-run2） | 46Gi | 19Gi | 20Gi | 9.6Gi | 27Gi |
| 第二次运行前（pre-run3） | 46Gi | 19Gi | 20Gi | 9.6Gi | 27Gi |
| 最终运行前（pre-run4，删旧 raw 后） | 46Gi | 19Gi | 20Gi | 9.6Gi | 27Gi |
| 最终运行后 | 46Gi | 19Gi | 20Gi | 9.6Gi | 27Gi |

## 6. 产物（本次执行落盘）

- `tester/evidence/20260920_adr027_axis_align/raw/summary.json`（6 态汇总 + verdict；本次运行唯一真源）
- `tester/evidence/20260920_adr027_axis_align/raw/verdict.json`、`env.json`
- `raw/state_<态>.json` ×6、`raw/delta_series_<态>.json` ×6
- `raw/state_<态>*.png` ×24（整页 1280×720 / K 线 668×256 / 聚合图 668×187 / 各策略评分 668×191）
- `tester/evidence/20260920_adr027_axis_align/report.md`（判词报告，判词前置）

## 7. 未修改声明与规格设计要点

- `git status --short -- web/src web/dist web/package.json web/playwright.config.ts` → **空**（生产代码、静态产物、构建/测试配置一律未动）。
- 本规格新增文件仅 3 处：`web/e2e/adr028-axis-align-probe.e2e.ts`、`tester/design/297_adr027_axis_align_probe_design.md`、`tester/evidence/20260920_adr027_axis_align/**`。
- 页面侧探针**只读**：仅包 `Map.prototype.set` 捕获 klinecharts 实例以调用其只读 getter（`getDataList/getVisibleRange/getBarSpace/getSize/convertToPixel`），不写任何图表状态、不做永久 instrumentation。
- 规格**不断言「缺陷存在」**（否则修复后必红）：只断言测量有效性（相邻 bar 间隔 ≈ barSpace、顶点数 = `/curve` 点数、曲线已渲染、真身可读、滚轮真生效）；缺陷判词落在报告与 `verdict.json`，供后续修复波做回归对照。
