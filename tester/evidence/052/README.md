# 证据目录 052 — 「保存 dcap 参数不得重置 pane 布局」阶段 3 **独立验收**（真实渲染）

- 执行报告：`tester/test/052_dcap_save_layout_independent_acceptance_execution.md`
- 上游：测试设计 `tester/design/016_dcap_save_layout_red_test_design.md`（阶段 1 红测试设计）/ 诊断 `tester/test/051_dcap_save_layout_reset_diagnosis_execution.md` / 修复车道 `coder/report/162_dcap_save_layout_fix.md`
- 时间窗：2026-09-13 23:38 ~ 23:54 (+0800)；仓库根 `/home/eestock/workspace/git/eestock/eestock-rs`；HEAD = `d74bfb8`（未提交改动）
- 被测形态（全部临时、全部在 /tmp）：
  - 构建 `A`（**现工作树 = 含未提交修复**）：root = `web/`，alias `klinecharts` → `harness/kc-spy.ts`，产物 `/tmp/acc3/dist`，`vite preview` @ `127.0.0.1:18093`
  - 构建 `B`（**反向证据 A**：`/tmp/acc3/mut` = web 源码副本，其中 `KlineChart.tsx`/`DashboardPage.tsx`/`feed.ts` 用 `git show HEAD:` 覆盖 ⇒ 退回旧 remove+create churn 行为）：产物 `/tmp/acc3/mut-dist`，preview @ `127.0.0.1:18094`
  - 两处 preview 的 `/api`、`/ws` 代理到**线上只读** `127.0.0.1:8081`（只发 GET）；Playwright 在浏览器侧拦截全部非 GET（`PUT /api/config/dcap|ma` 本地兑现 200+echo，**未发往后端/DB**）
  - 真实引擎：`klinecharts@10.0.3`（真身，未打桩；`kc-spy.ts` 仅包裹实例方法以记录调用序列 + 暴露 `window.__ACC__` + 提供反向证据 B 的变异开关）
- 纪律：未 kill/重启/改配置 8081/8082（PID 2102695 全程未动）；未改线上 `web/dist`（md5 前后逐一比对一致）；未 `git add/commit/stash`；仓库内未跑 tangle 写操作；未改 `design/14-dcap-indicator` 的 `file=` 块；无崩溃、无 core dump（4 次探针 `pageErrors` 全空）

## 文件清单

| 文件 | 说明 |
|---|---|
| `harness/kc-spy.ts` | klinecharts 透传 spy（临时 alias）：`window.__ACC__{inits,charts,log}`、调用序列（create/remove/override/setPaneOptions/setDataLoader/setSymbol/setPeriod/resetData）、`window.__ACC_SET_MUT__`（把 `overrideIndicator` 变 no-op = 反向证据 B） |
| `harness/vite.acc.config.ts` | 临时构建/预览配置（`ACC_ROOT`/`ACC_OUT`/`ACC_PORT` 可切 A/B 两套） |
| `harness/lib.mjs` | 公共库：页面状态快照（pane 渲染高度 = `getDom(paneId).getBoundingClientRect().height`、pane id、指标 calcParams/precision/figures/result、dataList、视口）、分隔线拖拽、经 UI 保存 dcap/MA、逐点线值对比、高度差判据（±1px） |
| `harness/probe_core.mjs` | **核心探针**：拖高 VOL+DCAP → 真实保存路径连续 3 次（r_m / m / n_l）→ 31 条断言；`MUT=1` 开反向证据 B 变异 |
| `harness/probe_regress.mjs` | **回归探针**：DCAP 关→开→关、MA windows 变更、DCAP 独立副图/precision 5/0 参考线/断线 → 17 条断言 |
| `harness/oracle.mts` | **离线独立 oracle**（vite-node）：用 CORE 源码 `features/indicators/dcap.ts` 的 `computeDcapSeries` 对同一 dataList + 期望新参数复算，与 chart result 逐位对照 |
| `json/probe_core.json` | 现工作树核心探针原始输出（含每次保存的 dataList closes + chart DCAP result 原值） |
| `json/probe_regress.json` | 现工作树回归探针原始输出 |
| `json/probe_core_mutant.json` | 反向证据 A（旧行为副本）同一核心探针输出 |
| `json/probe_core_mut_override.json` | 反向证据 B（override 变 no-op）同一核心探针输出 |
| `json/oracle.json` | 三套构建 × 3 次保存的 oracle 逐位对照结果 |
| `shots/*.png` | 16 张：`core_0..3`（基线/三次保存后，现工作树）、`regress_A0/A1/A2/B1`（勾选关→开与 MA 保存）、`mutant-oldchurn_core_0..3`（旧行为红色对照）、`mut_override_noop_core_0..3`（反向证据 B 对照） |
| `logs/00_git_scope.txt` | HEAD、`git diff --cached`（空）、本轮 tracked 改动清单、`crates/` 与 `dcap.ts` 洁净性 |
| `logs/01_tsc_b.log` / `logs/02_vitest_run.log` / `logs/03_check_tangle.log` | 门禁原始输出（tsc exit=0 / 574 测试全绿 / check-tangle exit=0） |
| `logs/04_hygiene_teardown.log` | 收尾：临时端口/进程已拆、线上 PID 2102695 与 8081/8082 未动、`web/dist` md5 前后一致 |
| `logs/05_probe_numeric_summary.txt` | 全部关键数值汇总（基线高度、逐次保存高度差、参数敏感度、反向证据、oracle） |
| `logs/mutant_regression_test.log` | 仓库常驻红测试 `KlineChartDcapSaveLayout.test.tsx` 在**旧行为副本**下的原始输出（4 failed / 3 passed） |

## 复跑要点（全部临时端口；先建后拆）

```bash
# A. 现工作树（含修复）
cd web && NODE_PATH=$PWD/node_modules npx vite build --config /tmp/acc3/vite.acc.config.ts
cd web && NODE_PATH=$PWD/node_modules nohup npx vite preview --config /tmp/acc3/vite.acc.config.ts &
cd /tmp/acc3 && node probe_core.mjs && node probe_regress.mjs
# B. 旧行为副本（反向证据 A）
ACC_ROOT=/tmp/acc3/mut ACC_OUT=/tmp/acc3/mut-dist ACC_PORT=18094 ... build + preview
cd /tmp/acc3 && BASE=http://127.0.0.1:18094 OUT=/tmp/acc3/probe_core_mutant.json node probe_core.mjs
# 反向证据 B（override 变 no-op）
cd /tmp/acc3 && MUT=1 OUT=/tmp/acc3/probe_core_mut_override.json node probe_core.mjs
# 离线 oracle
cd web && npx vite-node --root /tmp/acc3 /tmp/acc3/oracle.mts -- /tmp/acc3/probe_core.json ...
# 常驻红测试在旧行为下必须红
cd /tmp/acc3/mut && npx vitest run src/features/dashboard/KlineChartDcapSaveLayout.test.tsx   # 期望 4 failed | 3 passed
```
