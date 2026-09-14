# 262 — P0.1-C 独立验收执行报告（真实 klinecharts 10.0.3 真渲染）

本文件路径：`tester/test/262_p01c_independent_acceptance_execution.md`
角色：Tester（独立验收；**只读复现**，不改仓库产品代码/测试，不分析失败根因、不修缺陷）
时间：2026-09-14 19:37–19:45（+08:00）
仓库：`/home/eestock/workspace/git/eestock/eestock-rs` @ commit `e2a04ee` + 工作区未提交改动（P0.1-B/C）
证据目录：`tester/evidence/262_p01c_independent_acceptance/`（截图 `*.png`、原始 JSON `*.json`、门禁日志 `logs/`、harness `harness/`、工作区补丁 `git_diff_worktree.patch`、`git_status_porcelain.txt`、`git_staged.txt`（0 行））
设计报告：**无** —— 本轮为独立验收，未新增/修改任何测试（硬约束禁止改仓库测试），故仅有执行报告。

---

## 0. 复现方法（为什么这是"真实渲染"）

- 引擎：`web/node_modules/klinecharts` v10.0.3（`package.json` 实测 10.0.3），用其**官方 UMD 产物**
  `dist/umd/klinecharts.js` 原样载入（复制到 `/tmp`），**非桩、非 mock**。
- 宿主：Playwright 官方 Chromium（`~/.cache/ms-playwright/chromium-1234`，headless），
  真实 DOM + 真实 2D Canvas + 真实 160 根 K 线数据（`setDataLoader` + `setSymbol` + `setPeriod`，
  与产品同一条数据通路形状）。
- 被测入口：用 esbuild 把**仓库真实源文件** `web/src/features/dashboard/overlayIndicator.ts`
  打成 IIFE 注入页面（`OverlayEntry.addOverlayIndicator` = 生产代码本体，非重写）。
  DCAP 回归用同法打包 `web/src/features/indicators/dcapIndicator.ts`。
- 三层证据：
  - **接口层**：`chart.getIndicators({name})` / `{paneId}` / `getDataList()` / `createIndicator` 返回值；
  - **画布层**：逐 canvas `getImageData` 像素统计（目标色容差 ≤28 命中数、逐行/逐列剖面）；
  - **DOM 层**：canvas 数量/尺寸清单（pane 结构）、截图。
- 告警捕获：劫持 `console.warn/error/log/info/debug`，统计 `createIndicator` 期间的消息数。
- 零服务器/零端口：`page.setContent` + `addScriptTag({path})`，全程未开监听端口、未访问线上。
- 无写请求：未对该应用发起任何 HTTP（含读）；仅本地文件 + 内存页面。

**引用的库内行号独立核验**（`web/node_modules/klinecharts/dist/index.esm.js`）：
`14162 if (!isStack) {` / `14163 this.removeIndicator({ paneId: paneId });` / `15267 logWarn('createIndicator', …)（仅"指标未注册"）`
/ `15292 return indicator.id;` —— 与实现注释/根因报告所述**逐行一致**。

---

## 1. 陷阱真实存在（同一 pane：A(false) → B(false)）

场景 S1（`harness/run.mjs` → `evidence/results.json`，截图 `s1_trap_and_counterexample.png`）。

| 阶段 | `createIndicator` 返回 | `getIndicators({paneId:'candle_pane'})` | 画布（价格 pane 主 canvas） | 告警数 |
|---|---|---|---|---|
| 建 A：`MA(false)` | `"MA_1789386061139_1"`（非空） | `["MA"]` | A 线红像素 **4612**（另一层 958） | — |
| 再建 B：`EMA(false)` | `"EMA_1789386061541_1"`（非空） | **`["EMA"]`（A 已消失）** | A 线红 **0**；B 线蓝 **2790**（另一层 696） | **0**（全程零消息） |
| 反例：`MA(false)` → `EMA(true)` | 两个 id 均非空 | `["MA","EMA"]` | 红 **4469** + 蓝 **2464**（另一层 958/696） | 0 |

- 基线可信度：`getDataList().length = 160`；价格 pane 有真实 K 线像素（阳线 `#2dc08e` 4303 / 阴线 `#f92855` 3311）；
  DOM canvas 清单 = 6 个（价格 pane 847×394 主+叠加层 & 其 Y 轴 53×394，量 pane 847×26 主+叠加层）。
- 结论：**A 被静默顶掉**，且 `createIndicator` 照常返回非空 id、**零告警** —— 与根因报告口径一致；
  反例证明 `isStack=true` 才是"追加"，A 存活。

---

## 2. 我们的代码不再触发它（真实渲染 + 源码静态独立复核）

**2a. 真实渲染走生产入口（S2）**（`s2_entry_coexist.png`、`results.json.s2`）

| 步骤（真实 chart） | 结果 |
|---|---|
| `OverlayEntry.addOverlayIndicator(chart, MA_spec, 'MA')` | `getIndicators({paneId:'candle_pane'}) = ["MA"]` |
| 再 `addOverlayIndicator(chart, EMA_spec, 'EMA')` | `["MA","EMA"]`；`getIndicators({name:'MA'}).length > 0` = **true**；`…{name:'EMA'}` = **true** ⇒ **共存** |
| 画布 | MA 红 **4473**（叠加层 958）且 EMA 蓝 **2686**（叠加层 696）⇒ 两条线同时可见（非仅接口自述） |
| 重复调用（幂等） | 再叠一次 MA 后仍**恰好各 1 个**：`["EMA","MA"]` |
| 告警 | 仅 klinecharts 版本欢迎 `log`（初始化时），`createIndicator` 期间 **0 条** |

**2b. 独立 grep（不复用门禁代码）**：自写括号配平扫描器遍历 `web/src/**`（排除 `*.test.*` 与 `src/test/`）：

```
web/src/features/dashboard/overlayIndicator.ts:29   argCount=2  isStack='true'
web/src/features/dashboard/KlineChart.tsx:168       argCount=2  isStack='desired), true'
web/src/features/indicators/dcapIndicator.ts:14     （位于块注释正文，非调用点）
```
`grep -rn createIndicator web/src | grep -v test`：真实调用点仅上述 2 处，**均显式 `true`**；
MA 原地调用点已消失（改为 `KlineChart.tsx:161` 调用唯一入口 `addOverlayIndicator(...)`）⇒
**生产代码内不存在裸 `createIndicator` 传 `false` 或省略 `isStack` 的调用点**（独立复核成立）。

---

## 3. 失败路径：桩令 `getIndicators` 返回空 ⇒ 入口必须抛错（S3）

```
threw = true
message = "指标 MA 未生效（isStack 语义坑）"   （含指标名 "MA" ⇒ 可定位）
调用序列 = removeIndicator({name:'MA'}) → createIndicator(spec, true) → getIndicators({name:'MA'})
```
（`results.json.s3`）—— 不静默、错误信息含指标名，符合口径。

> 备注（非缺陷，harness 说明）：我另加的一条探针 `getIndicators(){return [{name:'EMA'}]}` 未抛错，
> 因为该桩**无视 filter** 而入口传的是 `{name:'MA'}`；真实 API 按 filter 过滤，故此探针不构成反例，
> 不作为证据使用。

---

## 4. 反向证据：入口改回 `createIndicator(spec, false)` ⇒ 必须变红

**4a. 运行时（`/tmp` 副本打包的变异入口 `OverlayEntryFalse`，S4；`s4_mutated_entry_false.png`）**

| 步骤 | 结果 |
|---|---|
| `MA` via 变异入口 | `["MA"]`，红像素 **4612**（叠加层 958） |
| 再 `EMA` via 变异入口 | **不抛错**（`throwFromEntry = null`）、`getIndicators({paneId:'candle_pane'}) = ["EMA"]`、`MA` 计数 **0**、红像素 **0**、蓝 **2790** ⇒ **静默顶掉复现，`coexist=false`** |

**4b. 门禁（`/tmp/rev/web` 副本 + 软链真实 `node_modules`，仓库文件零改动）**

```
基线（未变异）：npx vitest run src/features/dashboard/indicatorCallGuard.test.ts
              → Test Files 1 passed / Tests 4 passed (4)          [logs/gate_baseline.log]
变异（overlayIndicator.ts:29 改 false，sha256 由 24e8173… 变为 206876e…）：
              → Test Files 1 failed / Tests 2 failed | 2 passed (4)  [logs/gate_mutated.log]
                × 每个 createIndicator 调用点都必须显式 isStack=true
                    + "features/dashboard/overlayIndicator.ts:29  isStack=false"
                × 入口模块 overlayIndicator.ts：必须以 true 追加
                    → expected 'false' to be 'true'
```
仓库内 `overlayIndicator.ts` 事后 sha256 仍为 `24e817354b86ca9abe1a05de9725bc49be28ff418de2cf9315e34c28a7c5b08c`（与变异前一致）。

**重要事实（不粉饰）**：变异后**运行时的"非空断言"不会变红**（4a 不抛错）—— 因为 `false` 只是"整 pane 替换"，
新指标本身仍在，`getIndicators({name:'EMA'})` 非空。**真正拦住该变异的是静态门禁（4b）**；
非空断言拦的是"创建后目标指标为空"（如未注册/被别的同名逻辑挤掉）。两条防线互补，缺一不可。

---

## 5. 回归（真实渲染 + 门禁）

**5a. 真实渲染（S5 / S5b / S5c，`s5_regression_ma_dcap.png`、`s5b_dcap_zero_broken.png`）**

- MA 主图：`getIndicators({paneId:'candle_pane'}) = ["MA"]`；价格 pane 红 **4627** + 阳线绿 **4493** ⇒ 主图/MA 正常。
- DCAP 独立副图：`createIndicator({name:'DCAP', paneId:'dcap_pane'}, true)` 返回非空 id
  `"DCAP_…_1"`，`getIndicators({name:'DCAP'})` 非空，**`precision = 5`**，
  `figures = ["s","m","l","zero"]`，实例 `paneId = "dcap_pane"`（与主图分离，主图 MA 未受影响）。
- DCAP 副图画布（843×100）：三线颜色命中 `#ff9600` 767 / `#1477ff` 303（+ `#935EBD`）⇒ 三条数据线已绘。
- 0 线：副图 canvas 逐行剖面**只有一行**符合灰 `#76808F`（y=55），该行横跨 x=0…754、覆盖 **464/843** 像素
  ⇒ 常驻横向 0 参考线在（`calc` 层同时证明 `zero` 恒 0：`zeroAll=true`）。
- 断线：`calc` 产物前 9 根为 `{s:null,m:null,l:null,zero:0}`（数据不足 → 断线语义）；
  **画布级限制（如实声明）**：默认视口下前 9 根暖机 bar 被滚出左边界，故本次未能在像素层观察到"断口"
  （`firstDataLineColumnX=0`），断线证据为 `calc` 层 + 引擎 `Nullable` 渲染契约；像素级断口未采到。
- 全程告警：仅版本欢迎 `log`，0 条 warning/error。

**5b. 门禁套件**

| 命令 | 结果 |
|---|---|
| `cd web && npx vitest run`（第 1 次） | Test Files **1 failed / 65 passed (66)**；Tests **1 failed / 616 passed (617)** |
| `cd web && npx vitest run`（第 2 次） | Test Files **66 passed (66)**；Tests **617 passed / 0 failed / 0 skipped** |
| `npx vitest run src/features/settings/SettingsPage.test.tsx`（单文件） | 11 passed |
| `cd web && npx tsc -b` | exit **0**，无输出 |
| `./scripts/check-tangle.sh` | exit **0**：`✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` |
| 崩溃 / core dump | **无**（`find . -maxdepth 2 -name 'core*' -newermt '-1 hour'` = 0） |

**5c. 失败用例表（唯一一次失败，见 `logs/vitest.log`）**

| 用例 | 错误信息 | 栈顶 | 与 P0.1 关系 | crash/core |
|---|---|---|---|---|
| `src/features/settings/SettingsPage.test.tsx > 源参数面板：保存启用，编辑速率→PATCH 乐观更新，值域非法禁用保存` | `AssertionError: expected 110 to be 10 // Object.is equality` | `SettingsPage.test.tsx:66:31`（`expect(ifzq.rate_per_sec).toBe(10)`） | **无关**（设置页；P0.1 改动仅 `dashboard/*` 与 `workbench/*` 测试；该文件单跑 11 passed，全量第 2 次 617 全绿） | 无 |

P0.1 直接相关的 4 个测试文件（`overlayIndicator.test.ts` / `indicatorStackTrap.test.ts` /
`indicatorCallGuard.test.ts` / `KlineChart*`）在 3 次运行中**均绿**，无回归。
（按角色纪律：本报告只记录现象，不对该 flaky 做根因分析。）

---

## 6. 卫生

| 检查 | 结果 |
|---|---|
| `git diff --cached --name-only` | **0 行**（0 staged，全程未 `git add/commit/stash`） |
| tracked 改动（9 个） | 产品 **2**：`KlineChart.tsx`、`GridCell.tsx`（MA 走入口）；测试 **7**：`KlineChart.test.tsx`、`GridCell.test.tsx`、`KlineChart.realtime.test.tsx`、`DashboardPage.test.tsx`、`dcapWiringP3.test.tsx`、`ResultView.test.tsx`、`WorkbenchPage.test.tsx`（桩补 `getIndicators` + 旧断言同步） |
| untracked（`web/src`） | 产品 **1**：`overlayIndicator.ts`；测试 **3**：`overlayIndicator.test.ts`、`indicatorStackTrap.test.ts`、`indicatorCallGuard.test.ts`；测试基建 **1**：`web/src/test/chartStoreStub.ts`；另 2 个 `feedRealtime{Poll,Reconnect}.test.ts` 为**既有** untracked（非 P0.1 产物） |
| ABI / 引擎 / 口径 | **零改动**（`crates/` 无改动；`design/` 仅既有 untracked `design/15-multi-period/`） |
| 线上实例 | PID **3112540** (`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`) `STARTED Mon Sep 14 11:52:36 2026`、`ELAPSED 07:50:31` ⇒ **未重启/未触碰** |
| 写请求 | **0**（未向应用/后端发起任何 HTTP） |
| 临时实例/端口 | 本轮**未开任何监听端口**（`ss -ltnp | grep node` 为空）；Playwright 浏览器已 `close()`；残留进程扫描 = 0（在跑的 chromium 均为 3–10 天前的既有进程）；`/tmp/p01c/*` 证据已归档至 `tester/evidence/262_…` |
| 仓库文件未被本轮修改 | 产品三文件 mtime `19:35–19:36`（早于本会话起始 19:38）；变异只发生在 `/tmp` 副本 |

---

## 7. 结论与最小修正建议

逐项：① 陷阱真实存在 ✅（真渲染三层证据 + 反例）；② 入口不再触发 ✅（真渲染共存 + 独立 grep 无裸调用）；
③ 失败路径抛错 ✅（信息含指标名）；④ 反向证据 ✅（`/tmp` 变异 ⇒ 运行时静默顶掉复现 & 门禁 2 条判红，仓库未动）；
⑤ 回归 ✅（MA/DCAP/`precision 5`/0 线在；`tsc -b` 0、`check-tangle` 0、P0.1 相关测试 3/3 全绿；617 全绿可复现）。

最小修正建议（均为**可选**，不构成本次验收反对项）：
1. **无需产品改动**。若要"运行时也能抓到 false 变异"，可在入口加一条**前值超集断言**
   （创建前后比较同 pane 指标集合，断言旧集合 ⊆ 新集合），使 4a 这类静默替换在运行时也抛错；
   当前仅靠静态门禁拦截，属可接受的互补设计。
2. `SettingsPage.test.tsx` 既有 flaky（3 次全量中 1 红；单文件绿）建议 parent 决定是否单独立项处理，
   与 P0.1 无因果。
3. 若日后要求"断线"像素级证据，需在 harness 里缩小 bar 数或 `scrollToDataIndex(0)` 后再采样
   （本轮时间盒内未采到，已如实标注为限制）。

VERDICT: PASS
