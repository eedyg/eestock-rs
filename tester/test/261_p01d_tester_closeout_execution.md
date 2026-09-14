# 261 — P0.1-D 执行报告：tester 侧收口（C1 加强 + 桩补 `getIndicators` + 旧断言同步）

本文件路径：`tester/test/261_p01d_tester_closeout_execution.md`
角色：Tester（执行者；不改产品代码，不修缺陷，不做失败分析）
运行时间：2026-09-14 19:31–19:37（+08:00）· commit `e2a04ee`（工作区含 P0.1-B 未提交改动）
设计报告：`tester/design/261_p01d_c1_gate_hardening_design.md`

---

## 1. 测试套件结果（最终态）

| 项 | 值 |
|---|---|
| 命令 | `cd web && npx vitest run` |
| Test Files | **66 passed / 66** |
| Tests | **617 passed / 0 failed / 0 skipped** |
| 目标 | ≤ 617 全绿（任务书目标：既有 617 全绿）— **达成** |
| 崩溃 / core dump | 无（无 `core*` 文件、无 OOM、无 worker 崩溃；未出现 vitest unhandled rejection） |

基线（改动前，同一工作区）：`vitest run` = **542 passed / 75 failed**（8 个文件），失败全部为
`TypeError: chart.getIndicators is not a function`（7 个文件）与 `indicatorCallGuard.test.ts` 1 例 + 旧行为断言。

### 其它门禁

| 命令 | exit | 输出摘要 |
|---|---|---|
| `cd web && npx tsc -b` | **0** | 无输出（无类型错误） |
| `./scripts/check-tangle.sh` | **0** | `✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` |
| `git diff --cached --stat` | — | 空（**0 staged files**；全程未 `git add/commit/stash`） |

### 失败用例表（最终态）

| # | 用例 | 错误信息 | 栈顶 | crash/core |
|---|---|---|---|---|
| — | 无失败用例 | — | — | — |

（变异验证期间出现的预期红见 §3，全部已复绿。）

### 覆盖摘要

未启用覆盖率采集（本轮为门禁/桩修复型改动；仓库既有 vitest 配置未开启 coverage，保持现状以免引入新基建）。

---

## 2. 改动清单（仅 tester 侧）

| 文件 | 改动 | 性质 |
|---|---|---|
| `web/src/features/dashboard/indicatorCallGuard.test.ts` | C1 门禁加强（见 §2.1） | 测试（门禁） |
| `web/src/test/chartStoreStub.ts` | 新增 `IndicatorViewFilter`/`IndicatorView`/`indicatorViewFromCalls`/`bindGetIndicators`（+55 行，追加在文件尾部，既有导出未动） | 测试基建 |
| `web/src/features/dashboard/KlineChart.test.tsx` | 桩补 `getIndicators`；3 处旧断言同步 | 测试 |
| `web/src/features/dashboard/GridCell.test.tsx` | 桩补 `getIndicators`；2 处同类旧断言同步（任务书口径外、实测同类） | 测试 |
| `web/src/features/dashboard/KlineChart.realtime.test.tsx` | 桩补 `getIndicators` | 测试 |
| `web/src/features/dashboard/DashboardPage.test.tsx` | 桩补 `getIndicators` | 测试 |
| `web/src/features/dashboard/dcapWiringP3.test.tsx` | 桩补 `getIndicators` | 测试 |
| `web/src/features/workbench/ResultView.test.tsx` | 桩补 `getIndicators` | 测试 |
| `web/src/features/workbench/WorkbenchPage.test.tsx` | 桩补 `getIndicators` | 测试 |

产品代码：**零改动**。`git diff --stat` 中 `GridCell.tsx` / `KlineChart.tsx` 的 15 insertions / 4 deletions
即 P0.1-B 已存在的工作区改动，与本轮前后逐字节一致（变异注入的 sha256 前后比对见 §3）。

桩改动统一形状（每文件 +5 行：1 import + 1 注释块 + 3 行 `getIndicators`）：

```ts
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
...
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {})),
```

---

## 3. 变异验证证据（红/绿）

### M1 — 裸 `false` 注入 `GridCell.tsx` ⇒ C1 必红（任务书要求项 2）

```
# 注入：chart.createIndicator({ name: 'MA', calcParams: maWindowsProp, paneId: 'candle_pane' }, /*isStack=*/false);
$ sha256sum web/src/features/dashboard/GridCell.tsx
48aa27f666eb647bbc85cfc955f4eff14524df93d97ebad9e4c85503b100e743   # 注入前
695569c229fe121b30061fe1ee07e6be41b85318083cf1bea8cef11b8f240eab   # 注入后
$ npx vitest run src/features/dashboard/indicatorCallGuard.test.ts
× 调用点只能出现在白名单文件（新增叠加指标必须走入口 overlayIndicator.ts）
    + "features/dashboard/GridCell.tsx",
× 每个 createIndicator 调用点都必须**显式** isStack=true（false / 省略 / 变量一律判红）
    + "features/dashboard/GridCell.tsx:89  isStack=false",
Test Files 1 failed (1) · Tests 2 failed | 2 passed (4)
$ cp /tmp/t01/GridCell.before.tsx web/src/features/dashboard/GridCell.tsx
$ sha256sum web/src/features/dashboard/GridCell.tsx
48aa27f666eb647bbc85cfc955f4eff14524df93d97ebad9e4c85503b100e743   # 与注入前一致 ⇒ 已还原
$ npx vitest run src/features/dashboard/indicatorCallGuard.test.ts
Test Files 1 passed (1) · Tests 4 passed (4)                      # 复绿
```

### M2 — `isStack` 传**变量**（证明本版严格强于初版）

```
# 注入：const legacyIsStack = def.key !== 'ma'; chart.createIndicator(createIndicatorValue(def.name, desired), legacyIsStack);
$ sha256sum web/src/features/dashboard/KlineChart.tsx → 532fa4b7946862587e94257e2793c2e83d12f365d60bdee043015cb7825ea98b（注入前）
$ npx vitest run src/features/dashboard/indicatorCallGuard.test.ts
× 每个 createIndicator 调用点都必须**显式** isStack=true（false / 省略 / 变量一律判红）
    + "features/dashboard/KlineChart.tsx:169  isStack=legacyIsStack",
Tests 1 failed | 3 passed (4)
$ cp /tmp/t01/KC.before.tsx web/src/features/dashboard/KlineChart.tsx && diff → IDENTICAL
$ npx vitest run src/features/dashboard/indicatorCallGuard.test.ts → Tests 4 passed (4)
```

> 判别依据：初版门禁只对「字面 `false`」与「**非入口处省略**」判红 ⇒ `isStack=legacyIsStack` 在初版下**绿**；
> 本版判红 ⇒ 该条规则是**加强**（严格超集），且文件白名单从“样本”升级为“约束”（M1 第 1 条红证明）。

### M3 — 去掉入口非空断言 ⇒ 必须变红（“加桩不掩盖失败”）

```
# 注入：删除 overlayIndicator.ts 的 `if (chart.getIndicators({name}).length === 0) throw …`
$ sha256sum …/overlayIndicator.ts → 24e817354b86ca9abe1a05de9725bc49be28ff418de2cf9315e34c28a7c5b08c（注入前）
$ npx vitest run
Test Files 1 failed | 65 passed (66) · Tests 3 failed | 614 passed (617)
  × addOverlayIndicator … > 正常路径：先 removeIndicator({name}) 再 createIndicator(spec, true)，且 getIndicators({name}).length > 0
  × addOverlayIndicator … > 桩令 getIndicators 返回空 ⇒ 必须抛错（不得静默返回）
  × addOverlayIndicator … > 抛错信息包含指标名（可定位，与 02-spec §4.3 口径一致）
$ cp /tmp/t01/overlay.before.ts src/features/dashboard/overlayIndicator.ts
$ sha256sum → 24e817354b86ca9abe1a05de9725bc49be28ff418de2cf9315e34c28a7c5b08c（一致 ⇒ 已还原）
```

### M4 — 不忠实桩（派生恒空）反向控制 ⇒ 变红（证明测试真的消费桩结果）

```
# 注入：indicatorViewFromCalls 尾部 `return state.filter(...)` → `return [];`
$ npx vitest run src/features/dashboard/GridCell.test.tsx src/features/dashboard/KlineChart.test.tsx src/features/workbench/ResultView.test.tsx
Test Files 3 failed (3) · Tests 30 failed | 4 passed (34)
$ cp /tmp/t01/stub.before.ts src/test/chartStoreStub.ts && diff → IDENTICAL
$ npx vitest run <同三文件> → Test Files 3 passed (3) · Tests 34 passed (34)
```

**结论**：桩是**载荷路径**（0 例空跑绿），且补桩后新契约（入口非空断言）仍能捕获“静默不生效”。

---

## 4. 断言同步明细（不删用例）

| 文件 | 旧值 | 新值 |
|---|---|---|
| `KlineChart.test.tsx`（不传 maWindows） | `createIndicator(MA, false)` | `createIndicator(MA, true)` + `removeIndicator({name:'MA'})` + remove 调用序 < create 调用序 |
| `KlineChart.test.tsx`（maWindows=[7,20,60]） | `false` | `true` |
| `KlineChart.test.tsx`（maWindows 变化） | `removeIndicator` 从未调用 | 恰 1 次（建图）+ `{name:'MA'}` + 先于 create；且参数变化后 `createIndicator` 对 MA 仍仅 1 次 |
| `GridCell.test.tsx`（默认 maWindows） | `false` | `true` + `paneId:'candle_pane'` + `removeIndicator({name:'MA'})` + 先于 create |
| `GridCell.test.tsx`（maWindows=[7,20,60]） | `false` | `true` |

---

## 5. 执行边界与自我约束

- 未修改产品代码（仅变异验证的临时注入，且 **sha256 前后一致**逐条还原）。
- 未执行 `git add` / `commit` / `stash`（`git diff --cached` 为空）。
- 未在仓库内跑 `entangled tangle`（`check-tangle.sh` 只在 `/tmp` 沙箱内生成 + 比对；工作区未被修改）。
- 未重启线上服务、未发起任何写请求（本轮全部为本地读/写测试与静态扫描）。
- 未做失败分析、未修缺陷（本轮以“门禁加强 + 桩补 + 断言同步”为交付；失败时仅记录现象）。
- 清理临时文件用不自匹配写法（`cp` 覆盖还原，未使用 `pkill/killall -f` 类自匹配命令）。

---

## 6. 残留风险 / 待确认

1. `web/src/features/dashboard/KlineChart.tsx:104` 仍留有旧注释“不得用 `chart.getIndicators(...)` 判在场——既有测试桩未提供该 API”：
   补桩后该前提已不成立（本次未改产品注释，避免越权）。建议产品侧后续在评审中一并更新注释口径。
2. 派生的 `getIndicators` 依赖各测试文件的 `beforeEach(() => vi.clearAllMocks())` 作为“用例隔离”锚点：
   若未来新增的用例在**未清 mock 记录**的情况下渲染图表，会看到上一用例累计的指标。已在设计报告 §3 声明；
   本轮实测 617 全绿，未观察到假绿。
3. 白名单门禁要求“新增 `createIndicator` 调用点必须落在 `{overlayIndicator.ts, KlineChart.tsx}`”：
   若未来确需新增**独立副图**（非叠加）调用点，必须显式更新白名单并给出理由 —— 这是**有意**的收紧（需评审）。
