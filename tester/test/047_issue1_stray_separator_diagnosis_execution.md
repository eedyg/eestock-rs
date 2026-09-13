# 问题① 诊断取证 — K线 与 VOL 之间多出一条分割线（阶段 1：只做证据，不改产品代码）

- **报告自身路径（self-location）**：`tester/test/047_issue1_stray_separator_diagnosis_execution.md`
- **执行时间**：2026-09-13 20:44 ~ 20:52 CST
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `5a016cdb2cd593301ae517c65b70400cb58a2f14`（= 任务给定 `5a016cd`）
- **线上实例**：`http://localhost:8081`（PID **2029836** 未动、未 kill、未重启、未改状态；本报告对线上的全部访问 = **只读 GET**，实测请求方法集合 `{GET}`）
- **测试设计（本阶段新增的红测试）**：`tester/design/014_issue1_pane_separator_red_test_design.md`
- **证据目录**：`tester/evidence/047/`（harness 源码 + 原始 JSON + 截图 + 线上 CSS）
- **本报告性质**：**诊断/执行取证**。未改任何产品代码 / 接口 / 架构；未 `git add/commit/stash`；未跑 tangle；未改 `design/14-dcap-indicator/**`
- **本阶段范围**：只诊断**问题①**（问题② 的 0 线由下一阶段实现）

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 归因 | **(c) 与 DCAP 无关的既有行为** —— 那条多余的线是 **tangle 骨架 `DashboardGrid.tsx` 里 `[data-region="sub-chart"]` 锚点的 `border-t`**（Tailwind preflight 默认边框色 `#e5e7eb`），在 `0.8 × main-chart 高` 处恒画一条**静态**浅灰线；它**不**来自 klinecharts，**不**随 pane 拖动移动，**与 DCAP pane 的创建/移除无关**（DCAP 从未注册/创建的对照变体同样存在） |
| 排除 (a) 空 pane 残留 | 全部状态 `getPaneOptions()` **无空 pane**；DOM 分隔线数 = API `getSeparatorPanes().size` = 「内容 pane 数 − 1」 |
| 排除 (b) remove+create 累积 | DCAP 连续开关 3 次：pane 数 **3↔4 正确往返**（3/4/3/4/3/4），分隔线 1↔2 同步往返，**无只增不减、无残留** |
| 最小修复 | 删掉 `DashboardGrid.tsx`（其 tangle 源 = `design/06-web/01-dashboard.md` L3 代码块）中 `sub-chart` 锚点的 `border-t`；锚点本身保留（region 契约 + `e2e/helpers/pages.ts` region 清单要求其存在） |
| 红测试 | `web/e2e/dashboard-pane-separator.e2e.ts` —— 现状 **1 failed（RED）**，红点即「存在非 klinecharts 的全宽水平线」 |
| VERDICT | **DIAGNOSED(c)** |

---

## 1. 取证方法（真实 10.0.3 + 真实骨架 + 真实 CSS；全部在 /tmp 沙箱，未进产品代码）

| 通道 | 内容 |
|---|---|
| **线上只读探针** | Playwright chromium 打开 `http://localhost:8081/`（当前构建 SPA），`page.route` **abort 一切非 GET**；读 `[data-region=main-chart]` / `[data-region=sub-chart]` / `[k-line-chart-id]` 的计算样式与 bounding box；截图 + 像素行扫描（`live-initial.mjs` / `live-probe.mjs`） |
| **沙箱真实渲染 harness** | esbuild 打包 → chromium：import 仓库**真实** `web/src/layouts/DashboardGrid.tsx`（tangle 产物，未手改）+ 真实 `KlineChart.tsx`（真实 `syncIndicators`/`INDICATOR_DEFS`）；注入**线上 8081 当前构建 CSS**（`tester/evidence/047/live-8081-index-Cm6bbPuq.css`）；klinecharts 经 `--alias` 指向 spy（真实 10.0.3 + 抓 Chart 实例 + 记录 `createIndicator/removeIndicator/setPaneOptions` 调用序列与 pane 前后快照） |
| **对照变体（最小差异）** | `dcap`：调 `ensureDcapIndicatorRegistered()`（= 线上）；`never`：DCAP **从不注册、从不开启、从不创建 pane**（切换 MA 以驱动同一条 `syncIndicators` 路径），其余完全相同 |
| 未做的事 | 未改产品代码；未起/停任何服务；未触碰 8081/8082 状态；未写 DB；未跑 tangle |

---

## 2. 项 1 — pane 结构（`chart.getPaneOptions()` + 每 pane 的 indicator + DOM 实测几何）

沙箱（真实骨架，1344×864 主图区，`main-chart h = 864`）。**`paneGeomDom` = DOM 实测**（top/高，px），`配置高度` = pane options 里的 `height`。

### 2.1 默认态（MA 开、VOL 常开、DCAP 关）

| pane id | 配置高度 | DOM 实测 top/高 | 含 indicator | 空 pane? |
|---|---|---|---|---|
| `candle_pane` | 100（弹性，实际取剩余） | 0 / **737** | `MA` | 否（主 pane，天然豁免） |
| `indicator_pane_…_3` | 100 | 738 / **100** | `VOL` | 否 |
| `x_axis_pane` | 100 | 838 / **26** | —（X 轴 pane） | 否 |

分隔线：DOM **1** 条 = API `getSeparatorPanes().size` **1** = 「内容 pane 数(2) − 1」✅

### 2.2 DCAP 开 / 关逐次切换（含连续 3 次）

| 状态 | pane 数 | pane 列表（id→indicator） | 空 pane | DOM 分隔线 / API / 期望 | 实测几何（内容 pane top/高） |
|---|---|---|---|---|---|
| `dcap_on#1` | 4 | candle→MA；`…_3`→**VOL**；`…_6`→**DCAP**；x_axis | 无 | **2 / 2 / 2** ✅ | 0/636，637/100，738/100 |
| `dcap_off#1` | 3 | candle→MA；`…_3`→VOL；x_axis | 无 | **1 / 1 / 1** ✅ | 0/737，738/100 |
| `dcap_on#2` | 4 | candle→MA；`…_2`→VOL；`…_5`→DCAP；x_axis | 无 | **2 / 2 / 2** ✅ | 0/636，637/100，738/100 |
| `dcap_off#2` | 3 | candle→MA；`…_3`→VOL；x_axis | 无 | **1 / 1 / 1** ✅ | 0/737，738/100 |
| `dcap_on#3`（连切 3 次后） | 4 | candle→MA；`…_3`→VOL；`…_6`→DCAP；x_axis | 无 | **2 / 2 / 2** ✅ | 0/636，637/100，738/100 |

- **是否存在空 pane**：**不存在**（12/12 状态为空）。源码侧吻合：`ChartImp.removeIndicator()` 会在 `removed==true` 时清掉「零 indicator 的非 candle/非 x_axis pane」（`index.esm.js:15323-15360`），且 `syncIndicators` 每次都先 `removeIndicator({name})` 再按需 `createIndicator`。
- **pane 数量只增不减？**：**不存在**。3↔4 正确往返（VOL pane 每次都真的被移除后重建，见 §5.2 调用序列），分隔线数 1↔2 严格同步。
- **pane 顺序**：渲染顺序恒 `candle → VOL → DCAP → x_axis`（`_drawPanes` 按 `order` 稳定排序；全部 order=0 ⇒ 插入序）。观察：`getPaneOptions()` 在**同一 tick 内新建 pane 后、异步 layout 落定前**会瞬时出现 `x_axis` 不在末尾的顺序（`kc-spy` 调用日志可见），layout（`sort:true`）随即纠正，**不影响最终 DOM**，非缺陷。

---

## 3. 项 2 — 分割线计数与几何（DOM 分隔元素 = klinecharts `SeparatorPane`）

识别方式：klinecharts 分隔元素 = `[k-line-chart-id] > div` 中「内嵌 7px 高 `cursor:ns-resize` 拖拽层」的 div（源码 `SeparatorWidget.createContainer`：`height REAL_SEPARATOR_HEIGHT=7`、`cursor:'ns-resize'`）；其背景 = `styles.separator.color`（默认 `#DDDDDD`）。

### 3.1 沙箱：全宽水平线清单（`main-chart` 内，非 GET 无关）

| 状态 | klinecharts 分隔线（top / 颜色） | **残留线**（非 klinecharts） | 结论 |
|---|---|---|---|
| 默认态 | 1 条 @ **737** `rgb(221,221,221)` | **1 条 @ 691.2 `DIV[data-region=sub-chart]` border-top 1px `rgb(229,231,235)`** | 多一条 |
| DCAP 开（#1/#2/#3 同） | 2 条 @ **636 / 737** | **1 条 @ 691.2**（同上） | 多一条 |
| DCAP 关（#1/#2 同） | 1 条 @ 737 | **1 条 @ 691.2** | 多一条 |
| VOL=240（DCAP 开） | 2 条 @ **496** / 737 | **1 条 @ 691.2** | 多一条（分隔线动了，它不动） |
| VOL=400（DCAP 开） | 2 条 @ **336** / 737 | **1 条 @ 691.2** | 同上 |

- 691.2 = `0.8 × 864`（`main-chart` 高的 4/5）—— **恰是 `sub-chart` 锚点的 top**（`h-1/5 bottom-0`），**不对应任何 pane 边界**（pane 边界在 636/737 或 496/737 或 336/737）。
- 残留线宽 1299.31 = `main-chart` 全宽；klinecharts 分隔线宽 1299（图表区宽）。

### 3.2 对照变体（**同一 harness，最小差异**）

| 变体 | DCAP 是否注册/创建 | 各状态残留线 | klinecharts 分隔线 |
|---|---|---|---|
| `dcap`（线上） | 是（可切开关） | **每条状态都有 @ 691.2** | 1（关）/ 2（开） |
| `never`（**DCAP 从未注册、从未创建**，切 MA 驱动同一 `syncIndicators`） | **否**（12/12 状态 `getIndicators()` 无 `DCAP`，`getPaneOptions()` 恒 3 pane） | **每条状态都有 @ 691.2**（与 `dcap` 变体**完全一致**） | 恒 1 |
| `live:initial`（线上 8081，DCAP 开关 `aria-pressed=false`） | 否 | **有** @ 659.2（= 0.8×824） | 1 @ 697 |

⇒ **多出来的那条线并非只在注册/创建过 DCAP pane 之后出现**：DCAP 从未存在的变体、以及线上 DCAP 关闭态，都同样存在该线。

### 3.3 线上 8081 像素级证据（初始态，零交互，只发 GET）

截图 `tester/evidence/047/live-initial.png`（1440×900；`main-chart` top=76、h=**824**）：

```
y=735 (relMain=659)  主色 rgb(229, 231, 235) × 1027 px   ← sub-chart 锚点 border-top（#e5e7eb）
y=773 (relMain=697)  主色 rgb(221, 221, 221) × 1026 px   ← klinecharts 分隔线（#DDDDDD）
```

两条线**颜色不同**（`#e5e7eb` vs `#DDDDDD`）⇒ 确系两个不同来源的元素；x=1240 竖直扫描（无蜡烛区）同样只在这两行出现亮线。线上 CSS 佐证：`/assets/index-Cm6bbPuq.css` 内 `.border-t{border-top-width:1px}` + preflight `border-width:0;border-style:solid;border-color:#e5e7eb}`（已存证）。

---

## 4. 项 3 — 复现用户场景（VOL 拉高）

| 通道 | 操作 | 结果 |
|---|---|---|
| **线上 8081（只读 + 纯前端交互）** | 鼠标拖第一条分隔线向上 120px（VOL 100→210px） | klinecharts 分隔线 697 → **587**（随 pane 移动）；**sub-chart 锚点线仍 659.2，一动不动**；像素行：y=663 `rgb(221,221,221)`（新位置）、**y=735 `rgb(229,231,235)` 仍在** |
| 线上 8081 | 再点 DCAP 开关（前端本地状态；实测仅 GET） | 分隔线变 2 条（596 / 697）；锚点线仍 659.2 → **屏上共 3 条线** |
| 沙箱 | 公开 API `chart.setPaneOptions({id: VOL_pane, height: 240 / 400})` | 分隔线 496 / 336；锚点线恒 **691.2** |

⇒ 用户报告的「把 VOL 视图向上拉大之后，这条分割线**一直存在**」**完全复现**：它是 `0.8 × main-chart 高` 处的**静态**骨架边框线，与任何 pane 边界无关；**位置不对应任何空 pane**（此刻根本没有空 pane，见 §2）。

---

## 5. 项 4 — 归因判定：**(c) 与 DCAP 无关的既有行为**

### 5.1 判定链（每条都有实测）

| 假设 | 判定 | 证据 |
|---|---|---|
| (a) DCAP pane 创建/移除后残留**空 pane** | **否** | 12/12 状态 `getPaneOptions()` 无空 pane；DOM 分隔线数 == `getSeparatorPanes().size` == 「内容 pane 数 − 1」（§2、§3.1） |
| (b) remove+create 反复同步的瞬时/累积（只增不减） | **否** | DCAP 连切 3 次：pane 数 3/4/3/4/3/4、分隔线 1/2/1/2/1/2，完全可逆；每次 ON 都移除旧 pane 再建新 pane（调用序列见 §5.2） |
| (c) 与 DCAP 无关的既有行为 | **是** | ① DCAP 从未注册/创建的对照变体同样有该线（§3.2）；② 线上 DCAP 关闭态（初始态）同样有该线（§3.3）；③ 该线来自 **DOM 骨架元素**（`DIV[data-region=sub-chart]` 的 `border-top`），根本不在 klinecharts 容器内；④ 其 top 恒 = `0.8 × main-chart 高` = 锚点自身 top，与 pane 无关 |
| (d) 证据不足 | 否 | 已定位到具体元素、具体 CSS 规则、具体像素颜色与固定几何 |

### 5.2 附：`syncIndicators` 的调用序列（kc-spy 记录，用于排除 (b)）

```
removeIndicator {name:'VOL'} -> true  | panesBefore=[candle_pane, <VOL pane>, x_axis_pane]
                                      | panesAfter =[candle_pane, x_axis_pane]        ← VOL pane 真被移除
createIndicator {name:'VOL', paneId:'indicator_pane_<新id>'} isStack=true -> VOL_…
removeIndicator {name:'DCAP'} -> true | panesAfter 中 DCAP pane 消失
createIndicator {name:'DCAP', paneId:'indicator_pane_<新id>'} isStack=true -> DCAP_…
```
（`{name:'MACD'}/{name:'KDJ'}/{name:'BOLL'}` 关闭态恒 `-> false`，`removed=false` 时 klinecharts **不**做 pane 清扫——本场景下没有「零 indicator 且非 candle/x_axis」的 pane，故无影响。）

### 5.3 顺带发现（**非** 问题① 根因，但同为观感缺陷，建议下一阶段一并评估）

1. **用户拖拽设置的 pane 高度不被记忆**：`syncIndicators` 每次调用都 `removeIndicator({name:'VOL'})` + `createIndicator({name:'VOL'}, isStack=true)`，而 VOL 的 `paneId` 是**每次新建的 `indicator_pane_<ts>_<n>`** ⇒ 新 pane 用默认高度 100。实测：VOL=240 → 切 DCAP 关 → VOL 回到 **100**；VOL=400 → 切 MA 关 → VOL 回到 **100**（线上同样：拖到 210 后点 DCAP → 回到 100）。
2. `getPaneOptions()` 在新建 pane 后的**同一 tick**内顺序瞬时非规范（`x_axis` 不在末尾），layout 随即纠正（§2.2 观察）。
3. 两条线的观感强度与视口有关：**1280×800** 下二者相距仅 **1.8px**（515.2 vs 517 ⇒ 像「粗/双线」）；1440×900 下相距 **38px**（⇒ 像「多一条线」）。

---

## 6. 项 5 — 最小修复提案（**不改代码**，仅提案）

### 6.1 方案 A（推荐，最小且直击根因）

- **改哪里**：`design/06-web/01-dashboard.md` 的 **L3 代码块**（tangle 源，第 ~279 行）中，把
  `<div data-region="sub-chart" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/5 border-t">`
  的 `border-t` 删除；随后跑仓库既定 tangle 流程使 `web/src/layouts/DashboardGrid.tsx` 同步更新（`scripts/check-tangle.sh` 必须绿）。**不得手改生成物**。
- **怎么改**：只删这一个 utility class（`class` 变为 `pointer-events-none absolute inset-x-0 bottom-0 h-1/5`），锚点 div 与 `data-region` 保留。
- **为什么**：该锚点按设计（L2 区域表 + 2026-09-04 修复记录）就是「绝对定位**占位**」，成交量副图已由 klinecharts 的 VOL pane 经主图容器 `h-full` 呈现；`border-t` 是样机（L1 mockup 的 `.region` 视觉边框）残留，与实际 pane 边界无任何几何关系。
- **影响面**：
  - pane 顺序 / 高度 / `getPaneOptions()`：**零影响**（不碰 klinecharts）；
  - ADR-020 视口口径（`data-viewport-fit`、barSpace、取数 `limit=viewport_bars(+warmup)`）：**零影响**；
  - region 契约：锚点仍在 ⇒ `src/features/dashboard/DashboardPage.test.tsx`（region 锚点断言）与 `e2e/helpers/pages.ts` 的 region 清单**不受影响**；
  - 视觉：主图区内全宽水平线只剩 klinecharts 自身分隔线 —— 正是用户期望。

### 6.2 备选方案（不推荐，仅记录）

- **B. 保留一条「region 边界线」的意图**：若产品确实想标示「副图区起点」，应把这条线的语义交给 klinecharts 的 pane 分隔线（它已经存在且可拖动），而不是再叠一条静态 DOM 边框；否则拖高 VOL 后仍会出现「线在错位置」的问题（§4）。
- **C. 隐藏而非移除（`visible:false`）**：**klinecharts 10.0.3 不支持** —— `PaneOptions = { id, height, minHeight, dragEnabled, order, state: 'normal'|'maximize' }`（`node_modules/klinecharts/dist/index.d.ts:700-707`），**没有 `visible` 字段**；因此「隐藏 DCAP pane 而非移除」这条常见思路在本库不可用于 pane（只能用 `removeIndicator`）。故本问题的修复不应牵到 pane 可见性。
- **D. 顺带修 5.3 第 1 条（pane 高度记忆）**：在 `syncIndicators` 里改为「只在**启用状态变化**时 create/remove」，或记录各 pane 的 `height` 并在重建后 `setPaneOptions` 还原（也可稳定复用同一 `paneId`）。**影响面**：pane 顺序保持 `candle → VOL → DCAP → 高度记忆保留`；对 ADR-020 视口口径无影响；但会改动 `KlineChart.tsx`（超出问题① 的最小范围，建议单独阶段/单独红测试）。

---

## 7. 项 6 — 红测试（位置、当前状态、隔离验证）

- **位置**：`web/e2e/dashboard-pane-separator.e2e.ts`（既有 E2E 基建；`testMatch: '**/*.e2e.ts'`，**不被 `npx vitest run` 收集**，故不污染单测门禁）
- **设计**：`tester/design/014_issue1_pane_separator_red_test_design.md`
- **运行**：
  ```bash
  cd web && E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/dashboard-pane-separator.e2e.ts
  ```
  前置：eestock-app 在 `E2E_BASE_URL`（默认 8081）服务本仓库当前构建的 SPA（真实数据；chromium 已在本机缓存）
- **当前状态**：**1 failed（RED）**（`--retries=0`）：
  ```
  Error: 主图区内出现了非 klinecharts 的水平分割线
  [默认态] main-chart h=644
    klinecharts 分隔线: [{"tag":"DIV[klinecharts-separator]","kind":"bg rgb(221, 221, 221)","topInMain":517,"h":1,"w":1299}]
    残留线(应为空):     [{"tag":"DIV[data-region=sub-chart]","kind":"border-top 1px solid rgb(229, 231, 235)","topInMain":515.2,"h":128.8,"w":1299.31}]
    sub-chart 锚点:     {"classes":"pointer-events-none absolute inset-x-0 bottom-0 h-1/5 border-t", ...}
  ```
- **红→绿隔离验证（已执行，零残留）**：拷贝该用例为临时文件（`e2e/zz-tmp-sep-greencheck.e2e.ts`），仅在运行期注入 `[data-region="sub-chart"]{border-top-width:0 !important}`（= 模拟 §6.1 的最小修复），其余断言原样保留 → **PASS（5.0s，1 passed）**；随后删除临时文件（`git status` 复核无残留）。⇒ 该用例只由这条残留线变红，修复后其余 pane/分隔线断言（拖高 VOL 后分隔线移动、DCAP 开/关 2↔1、无空 pane、无非 GET 请求）**均成立**。
- 期间修掉一个用例自身的缺陷：`getByRole('button', {name:'DCAP'})` 会同时命中「DCAP 配置」按钮 ⇒ 改为 `exact: true`。

---

## 8. 未做 / 边界

- 未改产品代码（`git status` 仅新增 `web/e2e/dashboard-pane-separator.e2e.ts` + 本报告/设计/证据文件）；未 `git add/commit/stash`；**无 staged 文件**
- 对线上 8081 的访问全程 **只读 GET**（非 GET 一律 abort，实测方法集合 = `{GET}`）；线上交互仅「拖分隔线 / 点 DCAP 开关」（纯前端状态，不写 `/api/config/*`、不写库）
- 未跑 tangle（§6.1 的 tangle 步骤属实施阶段）
- 问题②（DCAP 副图 0 线）本阶段**未诊断、未实现**（按任务范围留给下一阶段）
- 本报告不对问题① 之外的第二处缺陷下结论（§5.3 仅记录观察，未深入归因）

---

## 9. 产物清单

| 路径 | 内容 |
|---|---|
| `tester/test/047_issue1_stray_separator_diagnosis_execution.md` | 本报告 |
| `tester/design/014_issue1_pane_separator_red_test_design.md` | 红测试设计 |
| `web/e2e/dashboard-pane-separator.e2e.ts` | 新增红测试（当前 RED） |
| `tester/evidence/047/` | harness（`kc-spy.ts`/`entry2.tsx`/`run2.mjs`/`live-*.mjs`）+ 原始 JSON + 截图 + 线上 CSS + README |

**末行结论：VERDICT: DIAGNOSED(c)**
