# 277 — P5-B 实现：栈内高度分配（修纵向溢出）+ 拖拽 + 防抖持久化

- **本文件路径**：`coder/report/277_p5b_multi_period_layout_heights_persistence.md`
- **角色**：Coder（**只改手写前端**；未改 Rust / 未改 tangle 生成物 / 未跑 tangle / 未重启线上 / **0 写请求**）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`（起始 HEAD `78eb68d`；工作树起始干净）
- **时间**：2026-09-15 00:35–00:58（本地，UTC+8）
- **依据**：`design/15-multi-period/04-implementation-plan.md` P5、`03-test-plan.md` T9、`02-spec.md` §6（含 P5-B 裁决后的 §6.1–§6.4）、ADR-020 / ADR-022 §3.2 第 7 条、P5-A 红测试（`tester/design/276_p5_layout_persistence_red_design.md`）
- **证据目录**：`coder/evidence/277_p5b_layout_persistence/`（vitest 原始输出 ×2、`tsc -b`、`check-tangle`、真渲染 harness JSON/PNG/stdout、真渲染拖拽往返探针）

---

## 1. 改动文件清单

| 文件 | 类型 | 行数 | 层级 |
|---|---|---|---|
| `web/src/features/dashboard/multiPeriodLayout.ts` | **新增**（纯函数） | +239 | L1 领域算法（无 React/DOM） |
| `web/src/features/dashboard/MultiPeriodChartStack.tsx` | 改（手写容器） | +231 / −23 | L2 组件（布局/拖拽/量测/防抖） |
| `web/src/features/dashboard/DashboardPage.tsx` | 改（手写页面） | +31 / −5 | L3 页面装配 + 写路径（乐观/回滚） |
| `web/src/features/dashboard/multiPeriodStore.ts` | 改 | +10 / −0 | L3 运行态 store（`setHeights` 乐观入口） |
| `web/src/features/dashboard/multiPeriodLayoutHandshake.test.tsx` | **新增**（实现方用例） | +241 | 测试（高度权威交还口径） |

**未触碰**：`web/src/layouts/DashboardGrid.tsx`（tangle 生成物）、任何 Rust/crates、任何生成物/锚点、`tester/**`（测试方文件零改动）。

> 注：`design/15-multi-period/02-spec.md` 在 00:42 被**他人**（编排/架构侧）更新为 P5 的 §6.1–§6.4（高度权威交还口径等），**非本轮实现方改动**；本报告按该更新的口径实现（见 §4.3）。

---

## 2. 解决的问题

1. **纵向溢出（实测 540px，P2-C `271` §9）**：旧实现基准 `h-full` 拉满主图区 600px、卫星再按普通流追加 3×180 ⇒ `#main` clientHeight 600 / scrollHeight **1140**。现在栈容器按可用高度**统一分配**并使 Σ pane == 可用高度 ⇒ **实测溢出 0px**。
2. **T9 布局持久化**：我方分隔条拖拽 → 防抖（300ms）写 `PUT /api/config/multi_period`（乐观更新 + 失败回滚），刷新/重进保持；且保存 dcap / 切周期 / 切标的都**不重置**任何实例高度。

---

## 3. 分配算法（`multiPeriodLayout.ts`，纯函数）

常量：`BASE_MIN_HEIGHT=200`、`SATELLITE_MIN_HEIGHT=80`、`HEIGHT_MIN=80`、`HEIGHT_MAX=1200`、`DEFAULT_BASE_HEIGHT=420`、`DEFAULT_SATELLITE_HEIGHT=180`、`DRAG_DEBOUNCE_MS=300`。

`distributeStackHeights({panes, available})`：

1. **净化**：`sanitizeRequestedHeight` —— 非有限 / ≤0 ⇒ 兜底（基准 420 / 卫星 180）；否则 `round` 并夹到 `[80,1200]`。
2. **`available` 不可用**（0 / 负 / NaN / undefined）⇒ `reason='unavailable'`：**保持净化后的请求高度**（`total=Σ请求`，不缩放、不伪造默认值）。理由：jsdom 无布局引擎（`clientHeight` 恒 0）——若在此猜默认值，会把 P2 已验收的「卫星 inline height == `heights[period]`」假红（设计 §2.1-2）。
3. **D ≤ H** ⇒ `reason='fit'`：卫星直用请求值，**基准吸收余量** = `H − Σ卫星`（无基准 pane 时余量并入最后一个 pane）；`total=H`。
4. **D > H**：
   - `minTotal = Σ(基准 200 / 卫星 80)`；`minTotal > H` ⇒ `reason='min-overflow'`：各 pane 取其下限、`total=minTotal`、`scrollable=true`（**可观测，绝不静默裁剪**）；
   - 否则 `reason='shrunk'`：`f = H / D`；`h_i = floor(max(min_i, req_i·f))`；**残差修正**：
     - 残差 > 0 ⇒ 逐 px 加到「可增空间最大（`req_i − h_i`）」的 pane，**每次都重算候选**（基准优先命中）⇒ 默认档（420+3×180 @600）得 **264/112/112/112**（与设计示例逐值一致）；
     - 残差 < 0（下限撑破 H）⇒ 从「可减空间最大（`h_i − min_i`）」的 pane 逐 px 扣（有防死循环护栏）；
     - `total=H`。
5. 不变量：输出高度全为整数；顺序/`key`/`period`/`isBase` 原样回传；`fit`/`shrunk` 下 `Σ == H`。
6. **退化条件汇总**：

| 条件 | reason | Σ pane | overflow-y | 可观测 |
|---|---|---|---|---|
| 量测不可得（0/NaN/负/undefined） | `unavailable` | Σ请求 | — | `data-mp-stack-layout.reason` |
| D ≤ H | `fit` | == H | — | 同上 |
| H < D 且 minTotal ≤ H | `shrunk` | == H | — | 同上 |
| minTotal > H | `min-overflow` | == minTotal > H | `auto` | `data-mp-stack-scrollable="true"` + `scrollable:true` |

**可观测状态**：栈根元素 `[data-mp-stack]` + `data-mp-stack-scrollable` + `data-mp-stack-layout`（JSON：`reason/total/shrunk/scrollable/available/heights`）。
> 口径说明：派单里举例的 `store.stackScrollFallback` 未落地 —— P5-A 钉死的可观测面是 DOM 属性/JSON（设计 §2.1/§2.3「本字段即可观测记录」），且新增 store 字段会扩张 store 接口；实现方选择**不扩接口**，退化状态在 DOM 上可读、可断言（`B1`/`A5`/`A15`）。

---

## 4. 实现要点

### 4.1 栈容器与 pane（`MultiPeriodChartStack.tsx`）

- 激活态根元素：`div[data-mp-stack]` = `flex h-full w-full min-h-0 flex-col`（`scrollable` ⇒ 内联 `overflowY:auto`）；**关闭态逐字节不变**（仍 `Provider` 直通 children，零新增节点 ⇒ 冻结指纹/关闭态等价不受影响）。
- 基准 pane：`div[data-mp-pane=<基准周期>][data-mp-pane-role=base][data-mp-pane-height]` + 内联 `height:<分配值>px` + `minHeight:200px`，**children 仍是 Provider 的第一个子节点**（不前置节点 ⇒ 不 remount 基准实例）。
- 卫星 pane：`div[data-mp-pane=<周期>][data-mp-pane-role=satellite]` 包裹既有 `[data-mp-satellite]`（P2 契约元素保留），并把**分配高度**传给 `MultiPeriodSatellite`；量测不可得时分配值 == 请求值 ⇒ P2 的 `T2-2`（inline height == `heights[period]`）不变。
- **偏离说明（1 处）**：全部 pane 用 `flex-none` + 显式 px（派单文字建议基准用 `flex-1`）。`flex-1`（=`flex:1 1 0%`）在「连下限都放不下」时会被 flex **压缩**、且会把余量交给 flex 而不是分配算法 ⇒ 与「Σ pane == 可用」和「退化可滚动」冲突。余量吸收改由**算法**完成（`fit` 分支基准 = `H − Σ卫星`），语义等价且可预测（真渲染实测基准图 rect == pane 高度）。
- **量测**：`availableHeight` 显式给出时优先；否则在 `[data-mp-stack]` 根元素上挂 `ResizeObserver`（`entry.contentRect.height` > 0 为准，回退 `clientHeight`），并做一次挂载时 `clientHeight` 初读。**踩坑（已修）**：栈根元素**只在激活态存在**，而激活态由 `mpStore.load()` 异步决定 ⇒ 若 effect 只依赖 `availableHeight`，首次提交时 ref 为 null ⇒ 观察者永不建立（页面级 C1 因此首屏不缩小）。修法：`rootRef` 用 **callback ref + state**（节点出现即（重）挂观察者）。
- **分隔条**：`div[data-mp-separator="<上>|<下>"][data-mp-sep-upper/lower][data-mp-sep-height="0"]` + `role=separator`，`h-0` + 绝对定位命中带（≥4px）⇒ **净布局高度 0**（否则 Σ pane == 可用与无溢出不可能同时成立）；**完全由我方容器渲染**，不依赖任何 `data-region` 锚点/border。

### 4.2 拖拽与防抖持久化

- 分隔条 `mousedown` ⇒ window `mousemove/mouseup`；`delta = clientY − startY`；**拖拽基线 = 当前已分配高度**，改写**相邻两 pane 的期望 px**（上 `+delta`、下 `−delta`），随后仍由分配算法统一分配（算法是唯一高度权威）：
  - 未触界 ⇒ 相邻两者互补、其它 pane 不变（期望值之和不变 ⇒ 比例带不动其它 pane）；
  - 触界（如基准已到 200）⇒ 算法把余量交给另一个 pane、并把其它 pane 压向下限，**不越界、不溢出**（B6 实测 200/240/80/80）。
- **拖拽值口径（`fromDrag`）**：拖拽产生的期望值只做「非有限/≤0 ⇒ 兜底」净化，**不再夹到配置域 `[80,1200]`**（P5-A B5–B8 钉死：同窗口内纯互补重分配，Σ 恒 == 可用；下限由**缩小路径**保证：基准 200 / 卫星 80）。配置域校验属于持久化面（P1 dto）。
- **防抖**：每次拖拽变化与 `mouseup` 重置 300ms 定时器；静默后**恰一次** `onHeightsChange(全 pane 布局高度)`（键 == `periods`，值 == 整数 px、Σ == 可用）。连续拖拽（间隔 < 300ms）合并为一次（B8）。未移动（仅点击分隔条）不写。
- **父层回写 vs 本地拖拽期望**：请求高度签名（`baseHeight|卫星 heights`）变化 ⇒ 丢弃本地拖拽期望（props 权威）；父层**返回 Promise**（已接管）时，settle 后交还权威给 props（见 §4.3）。

### 4.3 页面写路径（`DashboardPage`）+ 高度权威交还（裁决二，四条已逐条满足）

```ts
const saveMultiPeriodHeights = async (heights) => {
  const prev = {enabled, periods:[...], heights:{...}, indicators:[...]};  // 拖前快照
  mpStore.setHeights(heights);                       // 乐观写（只替换 heights，不动其它字段）
  try   { mpStore.applyServerConfig(await api.saveMultiPeriodConfig({...prev, heights})); }  // 成功用回显
  catch { mpStore.applyServerConfig(prev); }         // 失败回滚，且不抛穿页面
};
```
- ① 语义精确写入代码注释（`MultiPeriodChartStackProps.onHeightsChange` 的 JSDoc，含「返回 Promise ⇒ 交还权威 / settle 后交还 / undefined ⇒ 保留本地」）。
- ② **失败回滚路径有正向断言**：`multiPeriodLayoutHandshake.test.tsx` H1（父层 rejected + 回滚到**拖前 props**，与 C3 同形：乐观写与回滚同提交 ⇒ 组件仅凭 props 无法区分）与 H1b（回滚到**另一**配置）。
- ③ **成功回显路径有断言**：H2（服务端回显 ≠ 拖拽值 ⇒ 采用 props 回显值）。
- ④ **无跨挂载缓存**：无 module 级/localStorage 高度缓存；权威链恒为 服务端配置 → 父层 props → 组件。
- **反向证据（证明 H1 真的咬住该语义）**：临时删掉交还逻辑（`.then(setDragRequest(null))`）⇒ **H1 变红**（`失败后不得保留本地拖拽值: expected 284 not to be 284`），随后已还原（`grep -c setDragRequest(null)` = 3）。
- `baseHeight` 传入配置 `heights[periods[0]]`（缺省 420）；**基准 KlineChart 不再收 `heightPx`**（激活态高度由 pane 决定）⇒ `h-full` 拉满容器导致溢出的根因被移除。

### 4.4 ②③ 契约与 ADR-020 / 基准零写入

- 保存 dcap 参数 / 切周期 / 切标的 ⇒ 高度不变、且**不产生** `multi_period` 写请求：C5/C6/C7（页面级）+ B9（组件级，换 `dcapParams`/换 `code` 强制重渲染后各 pane 高度不变）。
- ADR-020：拖拽改高**属布局面**，不触碰基准的 `setBarSpace`（B11：拖拽前后 `setBarSpace` 调用次数/参数不变，仍为 `barSpaceForViewport(980,120)`）；基准高度变化只走既有 `ResizeObserver`/`h-full` 路径。
- 基准零写入（ADR-022 §3.2 第 7 条）：卫星侧拖拽（`1h|5m`）只改这两个 pane 的期望 px，基准 pane 的高度/视口不被改写（真渲染探针实测：拖 `1h|5m` 后 15m 仍 264，仅 1h/5m 变为 127/97）。

---

## 5. 真渲染几何实测（`web/tester/p5-layout-harness/`，Playwright + Vite 真实产品组件 + 真实 Tailwind；0 出网/0 写请求）

命令：`cd web && P5_HARNESS_OUT=<证据目录> node tester/p5-layout-harness/run.mjs`（exit 0，**8/8 PASS**）

| 项 | 修复前（P5-A 红） | 本轮实测 |
|---|---|---|
| `#main` clientHeight / scrollHeight | 600 / **1140** | 600 / **600** |
| **纵向溢出** | **540px** | **0px** |
| Σ pane 真实 rect | 0（无 pane 契约） | **600 == 可用高度** |
| 各 pane 高度（配置 420+3×180 @600） | — | **15m 264 / 1h 112 / 5m 112 / 1d 112** |
| 各 pane rect == 声明高度 | — | 264/112/112/112 逐值一致（±0） |
| 基准图真实高 | 600（被 `h-full` 拉满） | **264 == 基准 pane 高** |
| 我方分隔条 | 0 | **3 条**（`role=separator`，净布局高 **0**） |
| 栈 `scrollHeight <= clientHeight` | 假 | 600 ≤ 600 |
| 网络 | — | 非本地请求 **0**、写请求 **0** |
| `data-mp-stack-layout` | 不存在 | `{"reason":"shrunk","total":600,"shrunk":true,"scrollable":false,"available":600,"heights":{"15m":264,"1h":112,"5m":112,"1d":112}}` |

**真渲染拖拽往返**（临时探针 `coder/evidence/277_p5b_layout_persistence/p5_drag_probe.mjs`，复用 tester harness 的真实组件与构建，未改 tester 文件；真实鼠标事件）：

```
[probe] 基准|1h 拖 +20：15m 264→284，1h 112→92，Σ=600，溢出=0
[probe] 往返（再 −20）：15m=264，1h=112（回到初值），Σ=600
[probe] 1h|5m 拖 +15：1h 112→127，5m 112→97，Σ=600（基准 15m 不动 = 基准零写入）
[probe] 基准图真实高 = pane 15m 高（264 vs 264）；写请求 = 0；非本地请求 = 0
```

**持久化往返**（写路径的权威证据在 jsdom 层，理由：harness 的 `entry.tsx` 未接 `onHeightsChange` ⇒ G8 要求 0 写请求）：
C1（拖后恰 1 次 `PUT`，body `heights` == 面板全表、`periods/indicators/enabled` 逐字段原样）→ C2（在途时 DOM 已是乐观值）→ C3（reject ⇒ 回到拖前 ±1px、无 unhandled rejection）→ C4（重进后保持 ±1px，见 §7）→ H1/H2（父层 settle 后采用回滚值/回显值）。

---

## 6. 红测试转绿证据 + 测试/门禁输出

| 套件 | 命令（cwd） | 结果 |
|---|---|---|
| L1 纯函数 15 例 | `vitest run src/features/dashboard/multiPeriodLayout.test.ts` | **15 passed**（红：`Cannot find module './multiPeriodLayout'`） |
| L2 组件 DOM 12 例 | `vitest run …/multiPeriodLayoutDom.test.tsx` | **12 passed** |
| L3 页面 7 例 | `vitest run …/multiPeriodHeightsPageContract.test.tsx` | **6 passed / 1 failed（C4，夹具缺陷，见 §7）** |
| 实现方交还口径 4 例（新增） | `vitest run …/multiPeriodLayoutHandshake.test.tsx` | **4 passed**（H1/H1b/H2/H3） |
| 全量前端套件 | `vitest run`（`web/`） | **739/740 → 743/744 passed**；唯一失败 = C4（夹具缺陷）；**P1–P3 既有用例零回归**（`multiPeriodSatellite*`/`multiPeriodClosedEquivalence`/`chartSync*`/`barSpaceFit`/`DashboardPage` 全绿） |
| 类型 | `tsc -b`（`web/`） | **exit 0，0 字节输出** |
| Tangle 一致性 | `./scripts/check-tangle.sh`（仓库根） | **exit 0**（`design 与生成物一致…工作区未被修改`） |
| 真渲染几何 | `node tester/p5-layout-harness/run.mjs`（`web/`） | **exit 0，8/8 PASS** |

证据文件：`coder/evidence/277_p5b_layout_persistence/{vitest_p5_4files.txt, vitest_full_suite.txt, tsc_b.txt, check_tangle.txt, harness_stdout.txt, harness/p5_layout_harness.json, harness/p5_layout_harness.png, drag_probe.txt, p5_drag_probe.mjs}`。

---

## 7. C4：**夹具缺陷**（已按裁决一交 Tester 修；实现侧零改动）

- **现象**：C4 拖后 `unmount()` → `const reopened = await setup();`，重进后高度回到**拖前**布局（差值恰等于拖拽量 20）。
- **因果证据**：`setup()` 内部调用 `makeCtx()`，而 `makeCtx` **每次新建** `serverState = { heights: {15m:420,1h:180,1d:180} }` ⇒ 重进页面的 `GET /api/config/multi_period` 回的是**原配置**，与测试注释声明的本意（「同一 serverState ⇒ GET 返回拖后 heights」）自相矛盾。组件内埋点（已还原）实测：重进挂载 `sig = 420|180|180`（= GET 回显原配置），而 `saved = 344` ⇒ 不可能相等。
- **闭合验证**：把夹具改为复用同一 mock 服务端态（`setup(undefined, ctx)`，两行）后，**C4 转绿**：`7 passed (7)`（探针文件 `zz_c4fix_probe.test.tsx` 已删除，`tester/**` 零改动）。即 C4 的失败**纯属夹具**，实现侧语义正确。
- 产品侧唯一能让 C4 绿的做法是**跨挂载本地高度缓存**（module/localStorage）——按裁决一（B）**否决**，未实现。

---

## 8. 时间盒与约束遵守

| 约束 | 状态 |
|---|---|
| 禁 `git add/commit/stash` | **遵守**：`git diff --cached` 空，未暂存/未提交（本轮派单硬约束优先于「实现后暂存」的通用流程） |
| 禁在仓库内跑 tangle | 遵守：仅跑 `scripts/check-tangle.sh`（沙箱重生成 + 比对，exit 0，未改工作区） |
| 0 写请求 / 不重启线上（PID 3112540） | 遵守：全部验证在 jsdom 桩与本地临时实例（Vite 构建 + 本地随机端口 + Chromium；结束即关，`ss -ltnp` 无残留监听；`/tmp` 构建产物已删） |
| 只改手写前端 | 遵守：未改 `DashboardGrid.tsx`/任何生成物/任何 Rust |
| 既有测试只允许加强 | 遵守：`tester/**` 零改动；新增实现方用例 1 文件（4 例）；反向证据脚本为**临时**（已还原，`grep -c` 复核） |
| 时间盒 | **超时（据实记录）**：红确认 ~1min（P5-A 已就绪）/ 实现 ~30min / 验收取证（harness + 真渲染拖拽探针 + 门禁复跑 + 证据归档）~25min。超时主因：① 页面级 C3 暴露的「乐观写 + 回滚同提交」信号缺口（需接口语义裁决 + 新用例）；② C4 夹具缺陷定位 + 裁决往返；③ 首次落地的量测挂载点缺陷（块根元素仅在激活态存在，RO 永不建立）。 |

---

## 9. 残留风险与观察项

1. **C4 仍红 1 例**（夹具缺陷；按裁决交 Tester 修，预计修后 **744/744**）。
2. **拖拽可把卫星压到 < 80px**（B8 钉死：334/42/112/112）：此时持久化载荷含 < `HEIGHT_MIN` 的值 ⇒ 若后端 dto 严格校验 `[80,1200]`，保存会被拒 → 页面回滚（可见、不静默）。同窗口内视觉正常（Σ 恒 == 可用）；**跨重进会回到配置域值**（服务端权威）。若产品要求「拖拽下界硬夹到 80 且仍保持 Σ == 可用」，需要改算法/改测试口径（属 P6/后续裁决项）。
3. **分隔条命中带为 4–5px 绝对定位**：触屏/键盘无障碍拖拽未做（设计与派单均列为不做）。
4. **退化可滚动（`min-overflow`）**在真渲染 harness 未取景（harness 配置恒为 4 pane @600 ⇒ `shrunk`）；数值面由 A5/A15 覆盖，DOM 属性 `data-mp-stack-scrollable="true"` 由 B1 契约覆盖。
5. 栈高度分配**仅作用于单图模式的多周期栈**；宫格/分时路径未变（P5 范围外）。
6. `design/15-multi-period/02-spec.md` 的 §6.1 提到基准用 `flex-1` 吸收余量；实现改用算法吸收 + `flex-none`（§4.1 偏离说明）——建议 P6 文档校准时把该措辞与实现对齐（或由架构侧确认）。

---

- **本文件路径**：`coder/report/277_p5b_multi_period_layout_heights_persistence.md`
