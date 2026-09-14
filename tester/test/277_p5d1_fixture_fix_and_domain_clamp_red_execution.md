# 277 — P5-D-1 执行报告：C4 夹具缺陷修复 + 「拖拽期望值夹配置域」红测试落地

- **本文件路径**：`tester/test/277_p5d1_fixture_fix_and_domain_clamp_red_execution.md`
- 设计报告：`tester/design/277_p5d1_drag_config_domain_clamp_red_design.md`
- 证据目录：`tester/evidence/277_p5d1_red/`
- 时间：2026-09-15 00:47–00:51（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `78eb68d`；P5 实现已在工作树未提交）
- 执行者：Tester（**只改测试夹具 + 只加红测试**；产品代码零改动；未跑 tangle；未重启线上）

## 1. 变更文件（仅测试面）

| 文件 | 变更 | 属性 |
|---|---|---|
| `web/src/features/dashboard/multiPeriodHeightsPageContract.test.tsx` | ① C4 夹具修复（`serverState` 提模块级 + `resetServerState()`，`beforeEach` 重置）；② 新增 `configDomainErrors()` 本地配置面校验镜像；③ 新增红用例 **C8 / C9** | 夹具 + 红测试 |
| `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx` | 新增红用例 **B13**（组件级 `onHeightsChange` 载荷域断言）+ 导入 `DRAG_DEBOUNCE_MS / HEIGHT_MIN / HEIGHT_MAX` | 红测试 |

产品代码：`web/src/features/dashboard/{DashboardPage.tsx,MultiPeriodChartStack.tsx,multiPeriodStore.ts}` **未触碰**
（与本轮开始时的 `M` 状态逐字节一致；`git diff --stat` 仍为设计文档 + 该 3 文件）。

## 2. 命令与结果

| # | 命令 | 结果 | 说明 |
|---|---|---|---|
| 1 | `npx vitest run src/features/dashboard/multiPeriodHeightsPageContract.test.tsx`（修复前） | **1 failed / 6 passed** | C4 红：`15m 重进后必须保持: expected 20 to be less than or equal to 1`（= 夹具缺陷复现） |
| 2 | `npx vitest run src/features/dashboard/zz_p5d1_prefix_probe.test.tsx -t C4`（临时探针副本，还原修复前形态） | **1 failed / 8 skipped** | 同上，差值恰为拖拽量 20 ⇒ 根因确认；探针已删除 |
| 3 | `npx vitest run src/features/dashboard/multiPeriodHeightsPageContract.test.tsx -t C4`（修复后） | **1 passed** | C4 夹具修复生效 |
| 4 | `npx vitest run src/features/dashboard/multiPeriodHeightsPageContract.test.tsx` | **2 failed / 7 passed（9 tests）** | C8 / C9 红（设计内红）；C1–C7 全绿 |
| 5 | `npx vitest run src/features/dashboard/multiPeriodLayoutDom.test.tsx` | **1 failed / 12 passed（13 tests）** | B13 红（设计内红）；B1–B12 全绿 |
| 6 | `npx vitest run`（全量，Web 单测） | run#1 **4 failed / 743 passed（747）**；run#2 **3 failed / 744 passed（747）** | run#1 多出 1 条 = 既有 **flake** `StrategyEditorPage.test.tsx`（单独跑 17/17 绿；run#2 未复现） |
| 7 | `npx tsc -b` | **exit 0** | 类型面：新增用例/夹具不破坏 `tsc -b` |

基线（本轮改动前，同一环境）：**743 passed / 1 failed（744 tests）**，唯一红 = C4。
本轮后：**744 passed / 3 failed（747 tests）**，3 条红全部为**设计内红**（C8 / C9 / B13），**无新增意外红**。

原始输出：`evidence/277_p5d1_red/{page_contract_c8_c9_red.txt, layout_dom_b13_red.txt, vitest_full_suite_red.txt,
vitest_full_suite_red_run2.txt, c4_fixture_prefix_probe.txt, page_contract_c4_postfix.txt, strategy_editor_flake_check.txt, tsc_b.txt}`

## 3. 失败用例表（**设计内红 = 3**）

| 用例 | 文件 | 断言/错误信息 | 栈摘录 | 崩溃/core |
|---|---|---|---|---|
| C8 拖拽期望值必须夹在配置域 `[80,1200]`：狠拖下界（期望 <80）也不得产出域外 PUT body | `multiPeriodHeightsPageContract.test.tsx:437` | `15m 必须 ≥ 80（配置域下界），收到 74: expected 74 to be greater than or equal to 80` | `expect(v, …).toBeGreaterThanOrEqual(HEIGHT_MIN)`（载荷逐项断言） | ❌ 无 |
| C9 拖拽域外值 ⇒ 镜像配置面校验的 stub 会 400 ⇒ 用户可见「拖了但没保存」 | `multiPeriodHeightsPageContract.test.tsx:467` | `expected [ 'heights[1h] 须 ∈ [80,1200]，收到 38' ] to deeply equal []` | `expect(rejections, …).toEqual([])`（onSave 域外即 reject） | ❌ 无 |
| B13 拖拽期望值必须夹在**配置域** `[80,1200]` —— 与渲染侧分配下界不得混同 | `multiPeriodLayoutDom.test.tsx:543` | `15m 必须 ≥ 80（配置域下界），收到 64: expected 64 to be greater than or equal to 80` | `expect(v, …).toBeGreaterThanOrEqual(HEIGHT_MIN)`（`onHeightsChange` 载荷逐项断言） | ❌ 无 |

- 载荷实测（三例共同根因）：`heights` 出现 **74 / 38 / 64 px < 80** ⇒ 服务端 `validate_multi_period_config` 第 5 条必拒（400）⇒ 页面回滚。
- **崩溃 / core dump：无**（无 segfault / abort / unhandled rejection；`core` 文件未生成）。

## 4. 既有 flake 说明（非本轮引入）

| 用例 | 现象 | 复核 |
|---|---|---|
| `StrategyEditorPage.test.tsx > 加载：头部名称/描述 + 版本下拉默认最新版本（v2 draft）…` | run#1 全量并发下 `expected '' to contain 'v2 draft 调整'` | 单独跑 **17/17 绿**；全量 run#2 **未复现** ⇒ 并发负载 flake，与本轮改动无关 |

证据：`evidence/277_p5d1_red/strategy_editor_flake_check.txt`、`vitest_full_suite_red.txt` vs `vitest_full_suite_red_run2.txt`。

## 5. 覆盖率

未采集（本轮未跑 coverage 工具；覆盖目标为**逐项断言**，见设计报告 §6）。

## 6. 残余风险（**不含修法建议**，仅登记事实与观察）

1. **超宽屏（容器 ≥ ~1241px 高）**：分配面「基准吸收余量」可使**分配高度**（= 持久化载荷）> 1200 ⇒ 载荷 400；
   与「期望值夹取」不是同一缺陷（§6.1 夹的是**期望值**）。本轮未落红测试。
2. **上界方向当前不红**：`sanitizeDragHeight` 已夹 `min(1200, …)`，故 C8/C9 的「≤1200」仅为回归护栏，非红判据。
3. **期望值 ≤0 走兜底**（420/180）而非夹到 80：拖到"负期望"时 pane 会跳到兜底值（行为怪但停在域内）；
   本轮不判红（既有 B10 覆盖兜底语义）。
4. 探针副本 `web/src/features/dashboard/zz_p5d1_prefix_probe.test.tsx` **已删除**（`ls | grep zz_p5d1` 计数 0）；
   无残留进程、无暂存文件（`git diff --cached` 空）；线上 PID 3112540 存活且启动时间未变（`Mon Sep 14 11:52:36` 起，ELAPSED 12:58:30，未重启）。

## 7. 结论

- **Tester 侧完成**：C4 夹具缺陷修复（绿证据充分）+ 三条「期望值夹配置域」红测试落地（红证据充分、可满足性推演见设计报告 §6）；
- **产品代码零改动**（实现侧应据 §6.1 尾注把**期望值**夹进 `[80,1200]`；本轮 Tester 不实现、不修 product）。
