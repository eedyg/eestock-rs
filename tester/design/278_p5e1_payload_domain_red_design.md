# 278 — P5-E-1 红测试设计：**持久化载荷恒合法**（`onHeightsChange.heights` 每一项 ∈ [80,1200]）

- **本文件路径**：`tester/design/278_p5e1_payload_domain_red_design.md`
- 角色：Tester（设计 + 落地**红测试**；**未改任何产品代码**、未跑 tangle、未触碰线上、0 写请求）
- 时间：2026-09-15（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `78eb68d`；P5 实现已在工作树未提交）
- 权威依据：
  - `design/15-multi-period/02-spec.md` §6.2（架构裁决 2026-09-15，本轮已更新）：
    「**持久化载荷恒合法，渲染分配可越域**（重要）：`onHeightsChange` 产出的 `heights` **每一项必须 ∈ [80,1200]**；
    而**渲染侧分配**可以临时超出域（例：可用高度 ≥1201px 的 `fit` 路径让基准吸收余量 ⇒ 可能 >1200），
    因为强行夹取会破坏 `Σ==可用` 不变量。⇒ 断言口径为 **payload == clamp(DOM 末次分配高度, 80, 1200)**
    （当分配本就在域内时即为逐值相等）。」
  - 本轮**作废**的字面值：`600−80−112−112=296`（隐含「拖拽保持 Σ期望 不变」语义，会令既有渲染侧下界行为失效）——
    以 §6.2 为准：**各项期望独立夹取**，夹取后 Σ期望 > 可用则走缩小路径。
  - 配置面事实源：`crates/web/src/dto.rs`（`MULTI_PERIOD_HEIGHT_MIN/MAX = 80/1200`，`validate_multi_period_config` 第 5 条）
  - 前端单一事实源：`web/src/features/dashboard/multiPeriodLayout.ts`（`HEIGHT_MIN/HEIGHT_MAX`、`distributeStackHeights`）
- 配套执行报告：`tester/test/278_p5e1_payload_domain_red_execution.md`
- 原始证据目录：`tester/evidence/277_p5e1_red/`

---

## 1. 缺陷与契约（为什么需要本组红测试）

实现自曝的缺陷（与 P5-D-1 的「期望值下界」**不是**同一缺陷）：**当可用高度足够大（≥ ~1201px）时，
`distributeStackHeights` 的 `fit` 路径把余量全部交给基准 pane**（`heights[base] = H − Σ请求_其它`）
⇒ 基准**分配高度**可 > `HEIGHT_MAX = 1200`；而拖拽结束的防抖回调把 `paneHeights`（= 分配结果）
**原样**作为 `onHeightsChange` 载荷 ⇒ `PUT /api/config/multi_period` 被配置面第 5 条 **400 拒绝** ⇒
失败回滚 ⇒ 用户表现「调大窗口后拖一下就保存失败」。

契约边界（**不得混同**）：

| 值 | 域 | 归属 / 本轮判据 |
|---|---|---|
| **持久化载荷**（`onHeightsChange` 的 `heights` → PUT body） | **恒 ∈ [80,1200]** | 配置面（**本组红测试钉死**） |
| **渲染分配**（`distributeStackHeights` 输出 / DOM pane 高度） | **可越域**（>1200 允许）；但 Σ == 可用高度 | 渲染侧（B1/B2/B5/B6/B7 已钉死） |

**唯一判据口径**：`payload == clamp(DOM 末次分配高度, 80, 1200)`（分配本就在域内 ⇒ 逐值相等）。
**反作用断言**（防「为凑载荷域而夹取分配」）：`Σ DOM 分配 == 可用高度` 必须仍然成立。

## 2. 分层策略

| 层 | 文件 | 承担 | 本轮新增 |
|---|---|---|---|
| 组件级（真 `MultiPeriodChartStack`） | `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx` | 载荷本身（不经页面转发）：`onHeightsChange` 载荷域 + 渲染侧 Σ 不变量 | **B14 / B15** |
| 页面级（真 `DashboardPage` + stub api） | `web/src/features/dashboard/multiPeriodHeightsPageContract.test.tsx` | 拖拽 → PUT body 全链路（既有 C8/C9） | — （本轮不动，运行确认未回归） |
| 纯函数级 | `web/src/features/dashboard/multiPeriodLayout.test.ts`、`multiPeriodDragDomainClamp.test.ts` | 分配算法数值面（既有） | — （本轮不动，运行确认未回归） |
| 真渲染几何 | `web/tester/p5-layout-harness/`（Playwright） | 溢出/几何真渲染 | — （本缺陷是**载荷域**问题，非几何） |

选择**组件级**为主：`onHeightsChange` 的载荷就是 `DashboardPage.saveMultiPeriodHeights` 收到的值，
并被逐字节转发给 `api.saveMultiPeriodConfig({...prev, heights})`（C1 已钉死）⇒ 组件级断言载荷域即等价于
「PUT body 合法（不会 400）」，且不依赖页面转发实现细节。

**「可用高度 ≥ ~1201px」如何用最小夹具构造**（数学事实，不含修法建议）：
`fit` 路径下基准分配 `= H − Σ卫星请求`（卫星请求被净化到 ≥80）。故
- **B14**：沿用既有 4-pane 夹具（卫星 3×180 = 540）取 `H = 1800` ⇒ 基准分配 `= 1260 > 1200`；
- **B15**：**3-pane 夹具**（卫星 2×80 = 160，取配置域下界的自然场景）取 `H = 1400`（任务书示例值）
  ⇒ 基准分配 `= 1240 > 1200`。

拖拽仅用于**触发防抖回调**（`onHeightsChange` 只在拖拽静默 `DRAG_DEBOUNCE_MS` 后产生），
拖拽量取 `+1px`（最小扰动；且拖拽后仍停在 `fit` ⇒ 复现同一路径）。

## 3. 用例清单（Given-When-Then）

### B14｜超宽屏（可用 1800px）⇒ 基准吸收余量使**渲染分配**越域：载荷必须仍是 `clamp(分配)` 且各项 ∈ [80,1200]
- **Given** 真 `MultiPeriodChartStack`（4 pane：基准 `15m` 请求 420 + 卫星 `1h`/`5m`/`1d` 各 180），`availableHeight = 1800`
- **When** 渲染 + flush，然后对 `15m|1h` 分隔条拖 `+1px` 并推进防抖窗
- **Then**
  1. **前置（夹具自证越域）**：拖前基准分配 `1260 > HEIGHT_MAX`；
  2. `onHeightsChange` 恰 1 次；
  3. **Σ DOM 分配 == 1800**（渲染侧不变量**不得**因载荷夹取而破坏）；
  4. 载荷键集合 == `periods`、每项为整数且 ∈ `[80,1200]`（**核心判据**，当前红）；
  5. **口径等式**：每项 `payload[p] == clamp(DOM[p], 80, 1200)`；
  6. 越域的是基准 pane（`payload[15m] > HEIGHT_MAX` 被显式断言为**前置再现**）。
- **当前**：红 —— `15m = 1261 ∉ [80,1200]`，`clamp(DOM 1261) = 1200`（实现未夹载荷）。

### B15｜1400px 容器 + 两颗 80px 卫星 ⇒ 基准分得 1240：载荷 == clamp(分配)，Σ 分配仍 == 1400
- **Given** 真 `MultiPeriodChartStack`（3 pane：基准 `15m` 请求 420 + 卫星 `1h`/`5m` 各 **80**），`availableHeight = 1400`
  （Σ请求 `580 ≤ 1400` ⇒ `fit` ⇒ 基准 `= 1400 − 160 = 1240`）
- **When** 渲染 + flush，然后对 `15m|1h` 分隔条拖 `+1px` 并推进防抖窗
- **Then**
  1. **前置**：拖前基准分配 `1240 > HEIGHT_MAX`，且 Σ 分配 == 1400；
  2. `onHeightsChange` 恰 1 次、键集合 == `[15m,1h,5m]`；
  3. **Σ DOM 分配 == 1400**（不变量）；
  4. 载荷每项 ∈ `[80,1200]`（**核心判据**，当前红）；
  5. **口径等式**：`payload[p] == clamp(DOM[p], 80, 1200)`（当前红）；
  6. **渲染分配允许越域**：`DOM[15m] > HEIGHT_MAX` 被显式断言（不得为凑域而夹取分配）。
- **当前**：红 —— `15m = 1240 ∉ [80,1200]`，`clamp(DOM 1240) = 1200`。

### B8（既有，**仅注释**更新，断言不变）
在 `expect(payload, 'payload == 末次分配结果（与 DOM 逐项一致）').toEqual(allHeights(container))` 上方
加口径注记：通用口径为 `payload == clamp(DOM 末次分配高度, 80, 1200)`；**本用例分配本就在域内**
（600px 可用）⇒ `clamp` 是恒等映射 ⇒ 与「逐值相等」**等价**，故保留更强的逐值相等断言（**未放宽、未删除**）。

## 4. Mock / stub 策略（**0 写请求**）

- 复用既有 `multiPeriodLayoutDom.test.tsx` 基建：`klinecharts` 忠实桩（逐实例）、`stubApi`（`getKline` 本地桩）、
  手写 fake ws、`KlineDataFeed` 合成数据；`onHeightsChange` = 本地 `vi.fn`（**不发网络**）；
- `stackTree(opts)` **最小扩展**（向后兼容）：新增可选 `availableHeight`（缺省 600）与 `panes`（缺省 3×180 卫星），
  既有 12 个用例的调用形态与断言**逐字节不变**；
- 新增读数辅助：`heightsOf(root, periods)`（指定周期集合）、`sumHeights`、`clampDomain`（口径的口语化落点）；
- 域上下界从 `multiPeriodLayout.ts` **导入**（`HEIGHT_MIN/HEIGHT_MAX` 单一事实源，不硬编码数字）；
- 本地 `vitest + jsdom`，**不触线上**（线上 PID 3112540 未触碰）、**未起临时实例**（见
  `tester/evidence/277_p5e1_red/process_hygiene.txt`）。

## 5. 边界与异常用例

- **可用高度 ≥ 1201px 的 `fit` 路径**（B14 1800 / B15 1400）：本轮核心红；
- **可用高度 600px（域内分配）**：既有 B1–B13 覆盖 ⇒ 回归护栏（`clamp` 为恒等 ⇒ 载荷与分配逐值相等）；
- **卫星取配置域下界 80**（B15 的自然场景）：说明「更少/更矮的卫星 ⇒ 更小的可用高度即可越域」；
- **缩小路径（`shrunk`）**：既有 B6/B13/C8/C9（基准触底 200 / 卫星触底 80）—— 该路径分配不越域；
- **`unavailable`（jsdom 无布局）**：既有 B10（保持请求高度）—— 与载荷域无关，不受本轮影响。

## 6. 覆盖目标与可满足性推演（供实现侧对齐，**非修法建议**）

- 覆盖目标：**载荷域**（键集合 + `[80,1200]` + 整数 + `== clamp(DOM)`）在「分配越域」夹具上 100% 逐项断言；
  并同时钉死「渲染侧 Σ == 可用高度」不得被载荷夹取破坏。
- 可满足性（预估转绿形态）：把**载荷**（而非分配）夹到 `[80,1200]` 后
  - B14：DOM `{15m:1261, 1h:179, 5m:180, 1d:180}`（Σ=1800）⇒ 载荷 `{1200, 179, 180, 180}` 全在域内、
    口径等式成立、DOM Σ 仍 == 1800 ⇒ 本用例转绿；
  - B15：DOM `{15m:1240, 1h:80, 5m:80}`（Σ=1400）⇒ 载荷 `{1200, 80, 80}` ⇒ 转绿；
  - 既有域内用例（B1–B13、C1–C9）：`clamp` 为恒等映射 ⇒ **断言逐字节不变**（B7 的「载荷之和 == 可用高度」
    在 600px 夹具下依然成立）。
- **诚实标注**：B14/B15 只钉「载荷域 + 渲染不变量」；「哪些 pane 可越域」「如何夹」属实现自由
  （唯一约束来自 §6.2：载荷恒合法、分配的 Σ 不变量不得破坏）。
