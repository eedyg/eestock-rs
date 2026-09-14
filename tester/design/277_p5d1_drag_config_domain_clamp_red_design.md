# 277 — P5-D-1 红测试设计：拖拽期望值必须夹在**配置域** `[80,1200]`（+ C4 夹具缺陷修复）

- **本文件路径**：`tester/design/277_p5d1_drag_config_domain_clamp_red_design.md`
- 角色：Tester（设计 + 落地**红测试**；**未改任何产品代码**、未跑 tangle、未触碰线上、0 写请求）
- 时间：2026-09-15（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `78eb68d`；P5 实现已在工作树未提交）
- 权威依据：
  - `design/15-multi-period/02-spec.md` §6.1 尾注（**架构裁决 2026-09-15，本轮新增**）：
    「**期望 px 必须始终落在配置域内**：拖拽只允许把**期望值**改写进 `[80,1200]`（配置面校验域）；
    分配下界（基准 200 / 卫星 80）是**渲染侧**夹取 —— 两者不得混同」；§6.2（拖拽 → 防抖持久化）
  - 配置面事实源：`crates/web/src/dto.rs`（`MULTI_PERIOD_HEIGHT_MIN/MAX = 80/1200`；`validate_multi_period_config` 第 5 条）
  - 前端单一事实源：`web/src/features/dashboard/multiPeriodLayout.ts`（`HEIGHT_MIN/HEIGHT_MAX/BASE_MIN_HEIGHT/SATELLITE_MIN_HEIGHT`）
- 配套执行报告：`tester/test/277_p5d1_fixture_fix_and_domain_clamp_red_execution.md`
- 原始证据目录：`tester/evidence/277_p5d1_red/`

---

## 1. 缺陷与契约（为什么需要本组红测试）

实现自曝的 UX 瑕疵：**拖拽可把「期望 px」拖出配置域**（实测可到 42px）⇒ 载荷写进
`PUT /api/config/multi_period` ⇒ 服务端 400 ⇒ 失败回滚 ⇒ 用户表现「拖了但没保存」。

根因（观察事实，非修法建议）：`multiPeriodLayout.ts::sanitizeDragHeight` 只夹**上界**
（`Math.min(HEIGHT_MAX, …)` + `≤0 ⇒ 兜底 420/180`），**不夹下界 80**；拖后的期望值在
`fit` 路径（Σ 期望 ≤ 可用）会被**原样**取用为分配高度 ⇒ 持久化载荷出现 `<80` 的值。

契约边界（**不得混同**）：

| 值 | 域 | 归属 |
|---|---|---|
| **期望 px**（`heights[period]`，拖拽改写后） | `[80, 1200]` | **配置面**（本组红测试钉死） |
| **分配 px**（渲染侧，`distributeStackHeights` 输出） | 基准 ≥200 / 卫星 ≥80（仅缩小路径）；Σ == 可用 | **渲染侧**（B1/B2/B6 已钉死） |

## 2. 分层策略

| 层 | 文件 | 承担 | 本轮新增 |
|---|---|---|---|
| 页面级（真 `DashboardPage` + stub api） | `web/src/features/dashboard/multiPeriodHeightsPageContract.test.tsx` | 拖拽 → `onHeightsChange` 载荷 → **`PUT` body** 全链路 + 「400 回滚」用户可见后果 | **C8 / C9** |
| 组件级（真 `MultiPeriodChartStack`） | `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx` | `onHeightsChange` 载荷本身（不经页面） | **B13** |
| 纯函数级 | `web/src/features/dashboard/multiPeriodLayout.test.ts` | 分配算法数值面（本轮未动） | — |
| 真渲染几何 | `web/tester/p5-layout-harness/`（Playwright） | 溢出/几何真渲染（本轮未动；本轮瑕疵是**配置域**问题，非几何） | — |

选择页面级为主：C8/C9 的载荷 = `DashboardPage.saveMultiPeriodHeights` 收到的 `heights`，**逐字节**转发给
`api.saveMultiPeriodConfig({...prev, heights})` ⇒ 断言 `PUT` body 等价于断言 `onHeightsChange` 载荷，
且顺带覆盖「回滚 = 用户可见失败」。B13 在组件层独立钉同一契约（不依赖页面转发实现细节）。

## 3. 用例清单（Given-When-Then）

### C8｜拖拽期望值必须夹在配置域 `[80,1200]`：狠拖下界（期望 <80）也不得产出域外 PUT body
- **Given** 页面挂载（基准 `15m` + 卫星 `1h`/`1d`，可用高度 600px ⇒ 分配 `324/138/138`）
- **When** 对 `15m|1h` 分隔条**向上狠拖 250px**（期望 `324−250 = 74 < HEIGHT_MIN = 80`）等防抖窗
- **Then**
  1. `saveMultiPeriodConfig` 恰 1 次；
  2. 载荷键集合 == `periods`；
  3. **每一项**为整数且 ∈ `[80,1200]`（核心判据，逐项带值断言信息）；
  4. `configDomainErrors(body) == []`（配置面第 5 条的本地镜像，等价「不会 400」）。
- **当前**：第 3 条红 —— `15m = 74 ∉ [80,1200]`。

### C9｜拖拽域外值 ⇒ 镜像配置面校验的 stub 会 400 ⇒ 用户可见「拖了但没保存」
- **Given** `setup({ onSave })`，`onSave` = **本地镜像配置面校验**：域外即 `Promise.reject(400)`
- **When** 对 `1h|1d` 分隔条**向上狠拖 100px**（期望 `138−100 = 38 < 80`）
- **Then**
  1. `rejections == []`（拖拽产出必须被服务端接受）；
  2. 拖后 `1h` 分配高度 < 拖前（结果未被回滚）；
  3. Σ 分配仍 == 600（分配不变量未被破坏）。
- **当前**：第 1 条红 —— `['heights[1h] 须 ∈ [80,1200]，收到 38']`（= 线上 400 的可复现形态）。

### B13｜拖拽期望值必须夹在**配置域** `[80,1200]` —— 与渲染侧分配下界不得混同（组件级）
- **Given** 真 `MultiPeriodChartStack`（4 pane：`15m` 基准 + `1h`/`5m`/`1d`；`availableHeight=600`）
- **When** 对 `15m|1h` 分隔条向上狠拖 200px（期望 `264−200 = 64 < 80`）并推进防抖窗
- **Then** `onHeightsChange` **恰 1 次**，载荷键集合 == `periods`，每一项为整数且 ∈ `[80,1200]`。
- **当前**：红 —— `15m = 64 ∉ [80,1200]`。

> 反向判据（「把夹取去掉 ⇒ 必红」）由当前实现天然满足：三用例均**因缺少下界夹取**而红；
> 若实现侧把**期望值**夹进 `[80,1200]`（下界夹取落点），三例应转绿 —— 该方向的可满足性推演见 §6。

## 4. Mock / stub 策略（**0 写请求**）

- api：`stubApi(overrides)`（`@/test/apiStub`）——`getSymbols`/`getKline`/`getKlineConfig`/`getMultiPeriodConfig`
  全部本地 async 桩；`saveMultiPeriodConfig` = 本地 `vi.fn`（**不发网络**）；
- ws：手写 fake（`subscribe` 返回退订闭包）；
- klinecharts / ResizeObserver：既有桩（`@/test/chartStoreStub` + `RoMock` 投递 600px）；
- `configDomainErrors` = `crates/web/src/dto.rs` 第 5 条的**本地纯函数镜像**（键集合 + `[80,1200]`），
  域上下界从 `multiPeriodLayout.ts` 导入（单一事实源，不硬编码数字）；
- **不触线上**：未重启 PID 3112540、未起临时实例、未发任何写请求（证据 `evidence/277_p5d1_red/process_hygiene.txt`）。

## 5. 边界与异常用例

- 期望值 **< 下界**（C8 74 / C9 38 / B13 64）：本轮核心红；
- 期望值 **> 上界**：现状 `sanitizeDragHeight` 已夹 `Math.min(1200, …)` ⇒ 该方向当前**不红**
  （故不作为红判据，仅由 C8/C9 的「每一项 ≤ 1200」覆盖为回归护栏）；
- 期望值 **≤ 0 / 非有限**：现状走兜底（420/180）⇒ 在域内（既有 B10 覆盖）；
- **容器 ≥ 1201px 高**（超宽屏）：分配面「基准吸收余量」可让**分配高度** > 1200 ⇒ 载荷 400 —
  与「期望值夹取」不是同一缺陷，本轮**未落红测试**，作为残余风险上报（见执行报告 §6）。

## 6. 覆盖目标与可满足性推演

- 覆盖目标：**载荷域**（键集合 + `[80,1200]` + 整数）100% 逐项断言；页面级与组件级各 1 条路径 + 1 条「服务端 400 → 用户可见」路径。
- 可满足性（预估转绿形态，供实现侧对齐）：把**期望值**夹到 `[80,1200]` 后
  - C8：期望 `{80, 388, 138}` ⇒ Σ=606 > 600 ⇒ 缩小路径（基准下限 200 / 卫星下限 80）⇒ 载荷全在域内；
  - C9：期望 `{324, 80, 238}` ⇒ Σ=642 > 600 ⇒ 缩小路径 ⇒ 载荷 `{≈298, 80, ≈222}`，全部 ≥80；
  - B13：期望 `{80, 312, 112, 112}` ⇒ Σ=616 > 600 ⇒ 缩小路径 ⇒ 基准 ≈200、卫星 ≥80，全部在域内。
- **C4 夹具缺陷修复**（架构裁定：夹具缺陷，非产品缺陷）：
  - 现象：重进 `15m = 324` vs `saved = 344`，差值恰为拖拽量 20 ⇒ 与用例注释「同一 serverState」自相矛盾；
  - 根因：`serverState` 建在 `makeCtx()` **局部**，而 C4 在 `unmount()` 后重新 `setup()` ⇒ 每次都造新初态、`GET` 回拖前值；
  - 修法（最小、只改夹具）：`serverState` 提为**模块级** `let` + `beforeEach` 调 `resetServerState()` 重置
    （用例内多次 `setup()` 共用同一份态，跨用例隔离）；**不改产品代码、不删任何断言**；
  - 复现证据：`evidence/277_p5d1_red/c4_fixture_prefix_probe.txt`（探针临时副本还原修复前形态得到同一失败）；
    修复后：`evidence/277_p5d1_red/page_contract_c4_postfix.txt`（C4 绿）。
