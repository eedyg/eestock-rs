# ADR-024 P0 整改单 #2 执行报告 —— `TestRunPanel.test.tsx` 恒真断言（范围外发现①同 D2 修法）

- **报告自身路径（self-location）**：`coder/report/adr024_p0_rect2_testrunpanel.md`（本文件）
- **整改单来源**：架构师裁决（`coder/report/adr024_p0_rectification.md` §7 登记的范围外发现①）——授权按 D2 **完全相同的修法**修掉
- **执行者 / 时间**：coder；2026-09-18 12:59 +0800
- **HEAD**：`18d1b9a`（未变）｜**交付形态**：仅 stage，**未 commit**
- **动作边界（严格按单）**：只改 1 个测试文件 `web/src/features/strategies/TestRunPanel.test.tsx`（1 条断言的期望来源 + 清理 import）。**未触碰任何生产代码**；**未触碰** `design/16-backtest-scalability/`（已由架构师入 index）；未动其它测试文件；未新建数据库；未 `git commit`。

---

## 0. 结论速览

| 项 | 判词 | 关键证据 |
|---|---|---|
| 发现①（`TestRunPanel.test.tsx` 恒真断言） | ✅ **已修**（红→绿 + 复原三段齐全） | §2（修前扰动恒绿 → 修后扰动必红 → 复原全绿） |
| 期望改为**独立来源**（契约向量 `backtest_periods`），不再从 `SUPPORTED_BACKTEST_PERIODS` 派生 | ✅ | §1（diff：新增 `readFileSync(../../../../design/16-backtest-scalability/contract-vectors.json)`；删除 `SUPPORTED_BACKTEST_PERIODS` import） |
| 被扰动文件 `periods.ts` / `ConfigPanel.test.tsx` **逐字未变** | ✅ | §3（sha256sum 前后一致 + `git diff` 空 + blob == index） |
| 定向测试 + 前端全量 `vitest run` + `tsc -b` | ✅ 6/6、850/850（89 files）、`tsc -b` EXIT=0 | §4 |
| 非目标合规（生产代码 / design§16 / 其它测试 / DB / commit） | ✅ 未触碰 | §5 |
| 交付形态 | `M  web/src/features/strategies/TestRunPanel.test.tsx`（仅 stage） | §6 |

**范围外发现②（`design/16-backtest-scalability/`）**：按裁决由架构师亲自入 index（含 `contract-vectors.json`），本单**未动**；收尾快照已见其 `A ` 状态（§6）。

---

## 1. 整改内容（严格只此一项）

### 1.1 缺陷

原断言把**被测常量自己**当期望（组件与测试 import 同一 `SUPPORTED_BACKTEST_PERIODS`），对 `M30` 成员资格**恒真**：删掉常量里的 `M30`，该文件仍 **6/6 全绿**（§2-A 实测复现）。

### 1.2 改法（与 D2 逐字同法）

期望改取**独立**契约向量 `design/16-backtest-scalability/contract-vectors.json::backtest_periods`（相对路径自 `web/src/features/strategies` 到仓库根 = `../../../../`），**不再**从 `SUPPORTED_BACKTEST_PERIODS` 派生；同时删除该文件对 `SUPPORTED_BACKTEST_PERIODS` 的 import（该文件无其它断言使用它）。

### 1.3 提交面 diff（`git diff --cached`，HEAD `529f83b` → index `fe91ef4`）

```diff
diff --git a/web/src/features/strategies/TestRunPanel.test.tsx b/web/src/features/strategies/TestRunPanel.test.tsx
index 529f83b..fe91ef4 100644
--- a/web/src/features/strategies/TestRunPanel.test.tsx
+++ b/web/src/features/strategies/TestRunPanel.test.tsx
@@ -1,12 +1,24 @@
 import { describe, it, expect, vi, beforeEach } from 'vitest';
 import { render, screen, waitFor } from '@testing-library/react';
 import userEvent from '@testing-library/user-event';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
 import type { ApiClient } from '@/api/client';
 import type { StrategyTestRunResp } from '@/api/types';
 import { ApiError } from '@/api/types';
 import { stubApi } from '@/test/apiStub';
 import { TestRunPanel } from './TestRunPanel';
 
+// ADR-024 P0 §5.1 —— 周期下拉的**独立期望**：取自契约向量（**不是**被测常量自身，否则是同义反复）。
+// 单一真相：`design/16-backtest-scalability/contract-vectors.json::backtest_periods`。
+// 该期望与产出解耦：删掉常量里的 'M30'、或组件改成手写第二份白名单，本用例都必须变红。
+// web/src/features/strategies → 仓库根
+const HERE = dirname(fileURLToPath(import.meta.url));
+const CONTRACT_VECTORS = JSON.parse(
+  readFileSync(resolve(HERE, '../../../../design/16-backtest-scalability/contract-vectors.json'), 'utf8'),
+) as { backtest_periods: string[] };
+
 const SCHEMA = [
   { key: 'fast', type: 'int' as const, default: 5, min: 1, max: 250, description: '快线周期' },
   { key: 'slow', type: 'int' as const, default: 20, min: 2, max: 250, description: '慢线周期' },
@@ -21,6 +33,14 @@ describe('TestRunPanel（试算面板：双模式表单 → test-run → 结果
     api = stubApi();
   });
 
+  // ADR-024 P0：周期下拉必须覆盖回测单一事实源全集（含 M30），不得手写第二份。
+  // 期望 = 契约向量（独立期望）；对 M30 成员资格**敏感**（删常量里的 M30 即红）。
+  it('周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望）', () => {
+    render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
+    const sel = screen.getByTestId('tr-period') as HTMLSelectElement;
+    expect([...sel.options].map((o) => o.value)).toEqual(CONTRACT_VECTORS.backtest_periods);
+  });
+
   it('表单校验：标的为空 → 内联错误，不调 test-run', async () => {
     const user = userEvent.setup();
     render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
```

> 断言仍是**一条**（未新增/删除用例；用例名同步更正为「…（六档含 M30，独立期望）」）；该文件用例数仍为 **6**。
> `git diff --cached --numstat` = `20 0  web/src/features/strategies/TestRunPanel.test.tsx`（相对 HEAD 净增 20 行、0 删除；含 M30 单遗留的 import/断言行被**替换**，替换量相对 HEAD 表现为新增）。

### 1.4 契约向量输入（`design/16-backtest-scalability/contract-vectors.json`，架构师已入 index）

```json
"backtest_periods": ["M1", "M5", "M15", "M30", "H1", "D1"],
```

---

## 2. TDD 证据链（全部为本机 vitest 原始输出）

**扰动方式**：`sed -i "s/'M1', 'M5', 'M15', 'M30', 'H1', 'D1'/'M1', 'M5', 'M15', 'H1', 'D1'/" web/src/features/backtest/periods.ts`（即**删常量里的 `M30`**）。扰动前已备份基线到 `/tmp/rect2/periods.ts.baseline`；扰动只落在**测试用常量**上，全程未触碰 `periods.ts` 的**交付内容**（§3 已回证）。

### 2-A. 修前复现（缺陷证明）：删 `M30` ⇒ 旧断言**仍全绿**（恒真）

```console
$ sed -n '17p' web/src/features/backtest/periods.ts
export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'H1', 'D1'] as const;

$ npx vitest run src/features/strategies/TestRunPanel.test.tsx

 RUN  v3.2.7 /home/eestock/workspace/git/eestock/eestock-rs/web

 ✓ src/features/strategies/TestRunPanel.test.tsx (6 tests) 157ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  12:59:10
   Duration  617ms (transform 69ms, setup 22ms, collect 103ms, tests 157ms, environment 128ms, prepare 80ms)

VITEST_EXIT=0
```

**判读**：常量去 `M30` 后，组件渲染的 5 档下拉 == 由同一常量派生的期望 ⇒ **恒绿**。恒真性确证。

### 2-B. 修后 RED（TDD ①）：**同一扰动**下新断言**必红**（且只有该 1 条红）

```console
$ sed -n '17p' web/src/features/backtest/periods.ts
export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'H1', 'D1'] as const;

$ npx vitest run src/features/strategies/TestRunPanel.test.tsx

 RUN  v3.2.7 /home/eestock/workspace/git/eestock/eestock-rs/web

 ❯ src/features/strategies/TestRunPanel.test.tsx (6 tests | 1 failed) 164ms
   × TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染） > 周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望） 24ms
     → expected [ 'M1', 'M5', 'M15', 'H1', 'D1' ] to deeply equal [ Array(6) ]
   ✓ TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染） > 表单校验：标的为空 → 内联错误，不调 test-run 41ms
   ✓ TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染） > 参数按 schema 渲染（默认值填充）；参数越界 → 内联校验错误 33ms
   ✓ TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染） > pure_score 运行：POST test-run（内联 code + 参数）→ 评分曲线 + 事件列表 17ms
   ✓ TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染） > sim_position 运行：渲染成交表 + 信号标记 25ms
   ✓ TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染） > truncated 标记 → 截断提示；400 错误（区间超限等）→ 友好展示 24ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯

 FAIL  src/features/strategies/TestRunPanel.test.tsx > TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染） > 周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望）
AssertionError: expected [ 'M1', 'M5', 'M15', 'H1', 'D1' ] to deeply equal [ Array(6) ]

[32m- Expected[39m
[31m+ Received[39m

[2m  [[22m
[2m    "M1",[22m
[2m    "M5",[22m
[2m    "M15",[22m
[32m-   "M30",[39m
[2m    "H1",[22m
[2m    "D1",[22m
[2m  ][22m

 ❯ src/features/strategies/TestRunPanel.test.tsx:41:50
     39|     render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
     40|     const sel = screen.getByTestId('tr-period') as HTMLSelectElement;
     41|     expect([...sel.options].map((o) => o.value)).toEqual(CONTRACT_VECT…
       |                                                  ^
     42|   });
     43| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
   Start at  12:59:16
   Duration  633ms (transform 67ms, setup 23ms, collect 101ms, tests 164ms, environment 126ms, prepare 72ms)

VITEST_EXIT=1
```

**判读**：独立期望（契约向量 6 档）与去 `M30` 后的渲染 5 档对照 ⇒ **红**；失败用例**恰为**目标 1 条，其余 5 条照常绿。恒真性已被消除，断言对 `M30` 成员资格**敏感**。

### 2-C. 复原 ⇒ GREEN（TDD ②）：恢复 `M30` 后转绿

```console
$ cp /tmp/rect2/periods.ts.baseline web/src/features/backtest/periods.ts
$ sed -n '17p' web/src/features/backtest/periods.ts
export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'M30', 'H1', 'D1'] as const;

$ npx vitest run src/features/strategies/TestRunPanel.test.tsx

 RUN  v3.2.7 /home/eestock/workspace/git/eestock/eestock-rs/web

 ✓ src/features/strategies/TestRunPanel.test.tsx (6 tests) 160ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  12:59:18
   Duration  628ms (transform 68ms, setup 22ms, collect 103ms, tests 160ms, environment 127ms, prepare 101ms)

VITEST_EXIT=0
```

**判读**：红 → 绿 → 复原三段闭合。

---

## 3. `periods.ts` / `ConfigPanel.test.tsx` 逐字未变证明

扰动前（本单动手前）先把两文件基线 sha256 落盘 `/tmp/rect2_baseline_sha.txt`；复原后逐项回证：

```console
$ sha256sum web/src/features/backtest/periods.ts web/src/features/workbench/ConfigPanel.test.tsx
04b540dedf18f1e55625bbf0f6726077c8bc2f94dc69f691e2ad6a095d99f14a  web/src/features/backtest/periods.ts
8c8b819c1c75672a3761ef3ecdc4a4ad551d51cae8c84b126706e9b22d3c0788  web/src/features/workbench/ConfigPanel.test.tsx
--- baseline (captured before any perturbation) ---
04b540dedf18f1e55625bbf0f6726077c8bc2f94dc69f691e2ad6a095d99f14a  web/src/features/backtest/periods.ts
8c8b819c1c75672a3761ef3ecdc4a4ad551d51cae8c84b126706e9b22d3c0788  web/src/features/workbench/ConfigPanel.test.tsx

$ git diff -- web/src/features/backtest/periods.ts web/src/features/workbench/ConfigPanel.test.tsx
(empty above = no drift)

$ echo "periods.ts  disk=$(git hash-object web/src/features/backtest/periods.ts)  index=$(git rev-parse :web/src/features/backtest/periods.ts)"
periods.ts  disk=799c18cc4aeea82a568f0a89ecb4fb3a2fe22a44  index=799c18cc4aeea82a568f0a89ecb4fb3a2fe22a44
$ echo "ConfigPanel disk=$(git hash-object web/src/features/workbench/ConfigPanel.test.tsx)  index=$(git rev-parse :web/src/features/workbench/ConfigPanel.test.tsx)"
ConfigPanel disk=a96358690c9bcc36c0223228d82e6af8858fd0a9  index=a96358690c9bcc36c0223228d82e6af8858fd0a9

$ git diff --numstat -- web/src/features/backtest/periods.ts web/src/features/workbench/ConfigPanel.test.tsx
(empty above = identical to index)
```

**判读**：
1. `periods.ts` sha256 = `04b540de…`，与**扰动前基线逐字相同**；且 = D2 整改报告中记录的 sha（`04b540de…`）⇒ 未因本次扰动遗留任何差异。
2. `ConfigPanel.test.tsx` sha256 = `8c8b819c…`，本单**从未触碰**，与基线逐字相同。
3. `git diff`（工作区 vs index）为空 ⇒ 两文件**磁盘内容 == index 内容**；`git hash-object` == `git rev-parse :path` ⇒ blob 层面亦一致。
4. `git diff --numstat` 为空 ⇒ 相对 index **零字节差异**。

> 即：被扰动的是**测试用常量**在扰动窗口内的临时状态；窗口结束时 `periods.ts` 已复原到与交付/index 完全一致的字节，`ConfigPanel.test.tsx` 全程未变。已通过文件 `M30` 全绿（§2-C）确认常量已回归含 `M30`。

---

## 4. 门禁验证（定向 + 全量 + 类型）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npx vitest run src/features/strategies/TestRunPanel.test.tsx`（定向，交付态） | ✅ **6/6 passed**，`TARGETED_EXIT=0` |
| 2 | `npx vitest run`（前端全量） | ✅ **89 files / 850 tests passed**，`FULL_EXIT=0`（与 D2 基线一致：未减用例数） |
| 3 | `npx tsc -b` | ✅ EXIT=0（无输出；证明删除未使用 import 后类型面干净） |

### 4.1 定向（交付态，原始输出）

```console
$ npx vitest run src/features/strategies/TestRunPanel.test.tsx

 RUN  v3.2.7 /home/eestock/workspace/git/eestock/eestock-rs/web

 ✓ src/features/strategies/TestRunPanel.test.tsx (6 tests) 161ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  12:59:25
   Duration  622ms (transform 69ms, setup 22ms, collect 104ms, tests 161ms, environment 130ms, prepare 94ms)

TARGETED_EXIT=0
```

### 4.2 前端全量（原始输出尾部）

```console
$ npx vitest run
...
 ✓ src/features/strategies/format.test.ts (4 tests) 3ms
 ✓ src/features/backtest/markerSnap.test.ts (7 tests) 3ms

 Test Files  89 passed (89)
      Tests  850 passed (850)
   Start at  12:59:27
   Duration  6.78s (transform 3.25s, setup 3.85s, collect 13.55s, tests 33.81s, environment 28.31s, prepare 6.75s)

FULL_EXIT=0
```

### 4.3 类型检查（原始输出）

```console
$ npx tsc -b
TSC_EXIT=0
```

---

## 5. 非目标合规自检

| 禁改/禁做项 | 状态 | 客观断言 |
|---|---|---|
| 生产代码 | ✅ 未改 | 本单工作区改动**仅** `web/src/features/strategies/TestRunPanel.test.tsx`（测试文件）；`git diff --name-only` 的未 stage 面仅 `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` 与 `docker-compose.yml`（**既有工作区改动，非本任务**） |
| `design/16-backtest-scalability/`（含 `contract-vectors.json`） | ✅ 未动 | 本单仅**只读**该 JSON；其 index 状态为 `A `（**架构师入的**），工作区无任何本单引入的改动 |
| 其它测试文件 | ✅ 未动 | `ConfigPanel.test.tsx` sha256 逐字未变（§3） |
| 新建数据库 | ✅ 未做 | 全程仅 vitest 单元/组件测试与 `tsc`，无任何 DB 命令 |
| `git commit` | ✅ 未执行 | `git log -1` 仍为 `18d1b9a` |
| 扩大范围 | ✅ 未扩大 | 未新增/删除测试用例；未修改契约向量；未动后端 |

### 5.1 完整性回证

```console
$ echo "disk =$(git hash-object web/src/features/strategies/TestRunPanel.test.tsx)"
disk =fe91ef400623a3588c995ecef74780ca2e794d32
$ echo "index=$(git rev-parse :web/src/features/strategies/TestRunPanel.test.tsx)"
index=fe91ef400623a3588c995ecef74780ca2e794d32
```

磁盘 == index（本单修复已 stage，无残留工作区差异）。

---

## 6. 收尾 `git status --porcelain`（该文件的 index 状态）

```console
$ git status --porcelain -- web/src/features/strategies/TestRunPanel.test.tsx
M  web/src/features/strategies/TestRunPanel.test.tsx
```

> `M ` = **已 stage（第 1 列 M）+ 工作区无未 stage 改动（第 2 列空格）**；即整改已入 index 且磁盘与 index 逐字一致，**未 commit**。

### 6.1 全程快照对照

| 时机 | staged | unstaged（既有，非本任务） | untracked | 合计 |
|---|---|---|---|---|
| 本单动手前（架构师已入 `design/16`） | 55 | 2 | 62 | 119 |
| 本单收尾（stage 目标文件后） | 55 | 2 | 62 | 119 |

```console
$ git status --porcelain | wc -l
119
$ git status --porcelain | grep -c '^[MAD] '
55
$ git status --porcelain | grep -c '^ M'
2
$ git status --porcelain | grep -c '^??'
62
$ git status --porcelain | grep '^ M'
 M design/01-architecture/adr/ADR-023-period-set-extension-30m.md
 M docker-compose.yml
```

- 本单**未新增/删除任何 staged 文件**（`TestRunPanel.test.tsx` 原本即为 `M `，本次仅更新其 staged blob：`529f83b` 内容基线 → `fe91ef4`）。
- staged 55 条中已含架构师入的 `design/16-backtest-scalability/`（5 条 `A `，见下）：
  ```console
  $ git status --porcelain -- design/16-backtest-scalability/
  A  design/16-backtest-scalability/01-adr.md
  A  design/16-backtest-scalability/02-spec.md
  A  design/16-backtest-scalability/03-test-plan.md
  A  design/16-backtest-scalability/04-implementation-plan.md
  A  design/16-backtest-scalability/contract-vectors.json
  ```
- 未 stage 的 2 条均为**既有工作区改动**（`docker-compose.yml`、`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`），**非本任务**，保持原样。

---

## 7. 产物

| 类型 | 路径 |
|---|---|
| **报告（本文件，self-location）** | `coder/report/adr024_p0_rect2_testrunpanel.md` |
| 被整改的测试文件（已 stage，未 commit） | `web/src/features/strategies/TestRunPanel.test.tsx`（index blob `fe91ef4`） |
| 期望的独立来源（架构师已入 index，本单只读） | `design/16-backtest-scalability/contract-vectors.json::backtest_periods` |
