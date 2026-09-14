# 251 — P0.1-A「isStack 静默顶掉」防护 · Red 执行报告

- **本报告位置**：`tester/test/251_multiperiod_p01a_stack_guard_red_execution.md`
- **类型**：Execution report（执行**本轮新落**的红测试；本轮无新设计）
- **设计报告**：`tester/design/251_multiperiod_p01a_stack_guard_red_design.md`
- **证据目录**：`tester/evidence/251_multiperiod_p01a_stack_guard/`
  - `vitest_red_3files.txt`（3 个目标文件，原始输出）
  - `vitest_full_suite_red.txt`（全量套件，原始输出）
  - `tsc_b.txt`（`npx tsc -b`，0 字节 = 零输出 = 通过）
- **仓库 / 提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e2a04ee8cfc18904c93560fc77c10cd83f493ada`（工作区：4 个新增未跟踪文件，**无 staged**）
- **执行时间**：2026-09-14T19:09:29+08:00（目标 3 文件）/ 19:09:33（全量）/ tsc 19:09:50（本机时钟）
- **环境**：`web/` 下 `npx vitest run`（vitest 3.2.7，jsdom）+ `npx tsc -b`
- **约束遵守**：未改生产实现/接口/架构；未 git add/commit/stash；未跑 tangle；未触碰线上（PID 3112540）；**零网络、零写请求**；无临时实例/端口（无收尾项）；**未做任何失败分析与修复尝试**。

---

## 1. 命令与结果

| # | 命令（cwd=`web/`） | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npx tsc -b` | **0** | 通过（零输出）—— 红阶段不被“入口模块缺失”阻塞（测试用变量 specifier，见设计报告 §2.1） |
| 2 | `npx vitest run src/features/dashboard/overlayIndicator.test.ts src/features/dashboard/indicatorStackTrap.test.ts src/features/dashboard/indicatorCallGuard.test.ts` | **1** | Test Files 3 failed (3)；Tests **7 failed \| 5 passed (12)** |
| 3 | `npx vitest run`（全量） | **1** | Test Files **3 failed \| 63 passed (66)**；Tests **7 failed \| 610 passed (617)** |

**关键判读**：全量套件唯一失败的 3 个文件 = 本轮新增的 3 个红测试文件；既有 63 个文件 / 610 例**零回归**。

### 1.1 目标 3 文件输出（片段，原始见 `vitest_red_3files.txt`）

```
 ❯ src/features/dashboard/indicatorStackTrap.test.ts (4 tests | 1 failed) 6ms
   ✓ [证据] 库陷阱指纹：同 pane 第二个 isStack=false 会静默顶掉先建指标 > A(false) → B(false)：A 消失、B 在，且两次 createIndicator 都返回了 id（零告警）
   ✓ [证据] ... > 对照：省略 isStack 与 isStack=false 等价（同样顶掉 A）
   ✓ [证据] ... > 对照：A(false) → B(true) ⇒ A 存活（isStack=true 才是“追加/叠加”）
   × [防护] 走 addOverlayIndicator：先建 A 再建 B ⇒ A 必须存活 > 同 pane 追加第二个指标后，先建的 A 仍在 getIndicators 中
     → Cannot find module './overlayIndicator' imported from '.../indicatorStackTrap.test.ts'
 ❯ src/features/dashboard/overlayIndicator.test.ts (4 tests | 4 failed) 6ms
   × ... 正常路径 ...  → Cannot find module './overlayIndicator' imported from '.../overlayIndicator.test.ts'
   × ... 重复调用幂等 ... → 同上
   × ... 桩令 getIndicators 返回空 ⇒ 必须抛错 ... → 同上
   × ... 抛错信息包含指标名 ... → 同上
 ❯ src/features/dashboard/indicatorCallGuard.test.ts (4 tests | 2 failed) 6ms
   ✓ ... 扫描器自身有效性：至少扫到 KlineChart.tsx / GridCell.tsx 的调用点（防空扫通过）
   × ... 源码内不存在 createIndicator(..., false) —— 当前 KlineChart.tsx / GridCell.tsx 违规（必红）
     → AssertionError: ... expected [ …(2) ] to deeply equal []
       + [ "features/dashboard/GridCell.tsx:86  isStack=false",
       +   "features/dashboard/KlineChart.tsx:155  isStack=false" ]
   ✓ ... 源码内不存在省略 isStack 的 createIndicator ...
   × ... 入口模块 overlayIndicator.ts 存在，且其 createIndicator 显式以 isStack=true 追加
     → ENOENT: no such file or directory, open '.../src/features/dashboard/overlayIndicator.ts'

 Test Files  3 failed (3)
      Tests  7 failed | 5 passed (12)
```

### 1.2 全量套件（片段，原始见 `vitest_full_suite_red.txt`）

```
 Test Files  3 failed | 63 passed (66)
      Tests  7 failed | 610 passed (617)
   Duration  5.42s
```

## 2. 失败用例表（7 例，全部为**预期红灯**）

| # | 文件 | 用例名 | 错误信息（摘） | 栈片段（摘） | crash / core |
|---|---|---|---|---|---|
| 1 | `indicatorCallGuard.test.ts` | 源码内不存在 `createIndicator(..., false)` | `AssertionError: isStack=false 的语义是「替换整个 pane」（index.esm.js:14162-14164），会静默顶掉先建指标: expected [ …(2) ] to deeply equal []`；收到 `["features/dashboard/GridCell.tsx:86  isStack=false","features/dashboard/KlineChart.tsx:155  isStack=false"]` | `indicatorCallGuard.test.ts:190`（`).toEqual([])`） | 无 |
| 2 | `indicatorCallGuard.test.ts` | 入口模块 `overlayIndicator.ts` 存在，且其 `createIndicator` 显式以 `isStack=true` 追加 | `Error: ENOENT: no such file or directory, open '.../web/src/features/dashboard/overlayIndicator.ts'` | `indicatorCallGuard.test.ts:204`（`readFileSync(ENTRY_MODULE,'utf8')`） | 无 |
| 3 | `indicatorStackTrap.test.ts` | [防护] 走 `addOverlayIndicator`：同 pane 追加第二个指标后，先建的 A 仍在 `getIndicators` 中 | `Error: Cannot find module './overlayIndicator' imported from '.../indicatorStackTrap.test.ts'`（`Caused by: Failed to load url ./overlayIndicator ... Does the file exist?`） | `indicatorStackTrap.test.ts:23`（`await import(ENTRY_SPECIFIER)`）← 调用点 `:77` | 无 |
| 4 | `overlayIndicator.test.ts` | 正常路径：先 `removeIndicator({name})` 再 `createIndicator(spec, true)`，且 `getIndicators({name}).length > 0` | 同 #3 错误 | `overlayIndicator.test.ts:26`（`await import`）← `:42` | 无 |
| 5 | `overlayIndicator.test.ts` | 重复调用幂等：连调两次仍只有 1 个同名指标；每次都以 `isStack=true` 追加 | 同 #3 错误 | 同上 | 无 |
| 6 | `overlayIndicator.test.ts` | 桩令 `getIndicators` 返回空 ⇒ 必须抛错（不得静默返回） | 同 #3 错误 | 同上 | 无 |
| 7 | `overlayIndicator.test.ts` | 抛错信息包含指标名（可定位） | 同 #3 错误 | 同上 | 无 |

- **失败原因归类（仅归类，不含分析/修复）**：`#1` = 现存源码违规（`KlineChart.tsx:155`、`GridCell.tsx:86`）；`#2 #3–#7` = 目标入口模块 `web/src/features/dashboard/overlayIndicator.ts` 尚不存在。
- **跳过（skipped）**：0。
- **崩溃 / core dump**：**无**（`web/` 下无 core 文件；vitest 无进程异常退出）。
- **绿（非失败）用例 5 例**：`indicatorStackTrap.test.ts` 的 [证据] B1/B2/B3（库陷阱指纹，**现在就该绿**）+ `indicatorCallGuard.test.ts` C1（扫描器自检）/C3（省略 isStack 前向护栏）。

## 3. 覆盖摘要

- 本轮新增 3 个测试文件 / **12 例**（7 红目标 + 5 绿锚点）；**未统计行覆盖率**（本仓 vitest 未启用 `coverage`，且本期目标是“红灯存在性”而非行覆盖）。
- 静态门禁扫描范围：`web/src/**/*.{ts,tsx}`（排除 `node_modules`/`*.test.*`/`*.d.ts`/`src/test/`/`__*`）⇒ 命中 3 个 `createIndicator` 调用点（`KlineChart.tsx:155`、`KlineChart.tsx:163`、`GridCell.tsx:86`），其中 2 个违规。
- 未复用/未修改任何既有测试；既有 610 例全绿（无回归）。

## 4. 纪律声明

- **未做**：失败根因分析、调参、修复、修改实现/接口/架构、添加永久 instrumentation、`git add/commit/stash`、`tangle`、重启或写线上（PID 3112540）、临时实例/端口（本轮不存在，无需收尾）。
- **只做**：新增 3 个红测试文件 + 1 个测试基建文件；运行 `tsc -b` 与 `vitest`；落盘本报告与证据。
- **移交**：请 Architecture Lead 转 worker 实现 `web/src/features/dashboard/overlayIndicator.ts`（契约见设计报告 §7）并整改 `KlineChart.tsx:155-158` / `GridCell.tsx:86`；随后由 tester 独立验收（预期 `tsc -b` 0、全量 617 例全绿）。

VERDICT: RED-READY
