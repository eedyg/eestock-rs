# 276 — P5-A 红测试执行报告（T9 布局持久化 + 纵向溢出）

- **本报告位置**：`tester/test/276_p5_layout_persistence_red_execution.md`
- **类型**：Execution report（执行**本轮新落**的红测试 + 真渲染几何仪器；**无既有用例被修改**）
- **设计报告**：`tester/design/276_p5_layout_persistence_red_design.md`（钉死接口/DOM/拖拽/分配口径）
- **证据目录**：`tester/evidence/276_p5_red/`
  - `vitest_p5_red_3files.txt`（3 个新增前端文件，原始输出；含 stderr）
  - `vitest_full_suite.txt`（全量前端套件，原始输出）
  - `tsc_b.txt`（`tsc -b`，**0 字节 = 零输出 = 通过**）
  - `p5_layout_harness.json` + `p5_layout_harness.png` + `p5_harness_stdout.txt`（真渲染几何取证）
- **仓库 / 提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `78eb68d`（起始工作树干净；本轮**仅新增**文件）
- **执行时间**：2026-09-15 00:27–00:34（本地，UTC+8）
- **环境**：`web/` 下 `vitest 3.2.7`（jsdom）、`tsc 5.8`、真身 **klinecharts 10.0.3** + Playwright Chromium（Vite 构建的真实产品组件；本地随机端口 + 合成数据）
- **约束遵守**：未改生产实现/接口/架构（`git diff` 对 tracked 文件为空）；未 `git add/commit/stash`（`git diff --cached` 空）；**未跑 tangle**；未重启/触碰线上（PID 3112540 未动，仅 `GET`/静态资源为 0 网络：harness 全程本地 + 合成数据 ⇒ `非本地端口请求 = 0`、`写请求 = 0`）；临时实例：仅本地随机端口静态服务 + chromium，脚本结束即关闭（`ss -ltnp` 无残留监听；`/tmp/p5-layout-dist` 已删除）；**未做任何失败分析与修复尝试**（无 core dump）。

---

## 1. 结果总览

| 套件 | 命令（cwd） | 退出码 | total | passed | failed | skipped | 判读 |
|---|---|---|---|---|---|---|---|
| 前端新增 3 文件 | `./node_modules/.bin/vitest run src/features/dashboard/multiPeriodLayout.test.ts src/features/dashboard/multiPeriodLayoutDom.test.tsx src/features/dashboard/multiPeriodHeightsPageContract.test.tsx`（`web/`） | 1 | 34 | 1 | **33** | 0 | 全部红：`multiPeriodLayout` 模块缺失 + `[data-mp-stack]`/`[data-mp-pane]`/`[data-mp-separator]` 契约缺失（唯一绿 = B12 关闭态零残留，属**保护性守卫**，实现后必须仍绿） |
| 前端全量套件 | `./node_modules/.bin/vitest run`（`web/`） | 1 | 740 | 707 | **33** | 0 | Test Files 3 failed / 77 passed（80）⇒ 既有 **706 例零回归** + 本轮 1 例守卫绿 |
| 类型检查 | `./node_modules/.bin/tsc -b`（`web/`） | 0 | — | — | 0 | — | **零输出**（红阶段不被「模块/新 props 尚不存在」阻塞：变量 specifier + 变量化组件引用，同 P3 手法） |
| 真渲染几何 harness | `node tester/p5-layout-harness/run.mjs`（`web/`） | 1 | 8 检查 | 1 PASS | **7 FAIL** | 0 | **复现 P2-C 的 540px 纵向溢出**（`#main` clientHeight=600 / scrollHeight=1140）；见 §3 |

**合计**：新增 **34** 个红用例（33 红 / 1 守卫绿）+ **8** 项真渲染几何检查（7 红 / 1 绿）。

---

## 2. 前端红测试（vitest）

```
 ❯ src/features/dashboard/multiPeriodLayout.test.ts (15 tests | 15 failed)
 ❯ src/features/dashboard/multiPeriodLayoutDom.test.tsx (12 tests | 11 failed)
 ❯ src/features/dashboard/multiPeriodHeightsPageContract.test.tsx (7 tests | 7 failed)
 Test Files  3 failed (3)
      Tests  33 failed | 1 passed (34)
```

### 2.1 失败用例表（33 例；错误信息 + 出处，无 crash/core）

| # | 文件 | 用例 | 错误信息（原文摘要） |
|---|---|---|---|
| 1–15 | `multiPeriodLayout.test.ts` | A1…A15（分配：恰好填满 / 直用 / 缩小 / 下限 / 退化可滚动 / 非法值与越界夹取 / 序与整数性 / 单调性 / 压力） | `Cannot find module './multiPeriodLayout' imported from '…/multiPeriodLayout.test.ts'`（+ `Failed to load url ./multiPeriodLayout … Does the file exist?`） |
| 16 | `multiPeriodLayoutDom.test.tsx` | B1 栈根元素契约 | `Error: 缺少 [data-mp-stack]` |
| 17–18 | 同上 | B2 恰好填满（Σ pane == 600）/ B3 每 pane 一个 chart 宿主 | `Error: 缺少 pane 15m` |
| 19 | 同上 | B4 我方分隔条（3 条、`role=separator`、不依赖 region 锚点 border） | `AssertionError: 分隔条数量 = 相邻 pane 对数: expected [] to deeply equal [ '15m\|1h', '1h\|5m', '5m\|1d' ]` |
| 20–22 | 同上 | B5 拖拽改相邻两者 / B7 防抖一次 / B8 连续拖拽合并 | `Error: 缺少 pane 15m`（B5/B7/B8 各在读数阶段） |
| 23 | 同上 | B6 拖拽下限（200 / 80） | `Error: 缺少分隔条 15m\|1h` |
| 24 | 同上 | B9 ②③ 不变量（换 dcap 参数 / 换标的） | `Error: 缺少分隔条 15m\|1h` |
| 25 | 同上 | B10 非法 heights ⇒ 不崩、回退默认 | `Error: 缺少 pane 15m` |
| 26 | 同上 | B11 ADR-020（基准 barSpace 不被高度变化改写） | `Error: 缺少分隔条 15m\|1h` |
| 27–33 | `multiPeriodHeightsPageContract.test.tsx` | C1 防抖 PUT 一次（字段不重置）/ C2 乐观更新 / C3 失败回滚 / C4 刷新重进保持 / C5 切标的 / C6 切周期 / C7 保存 dcap | `Error: 缺少 pane 15m`（C1–C3）/ `Error: 缺少分隔条 15m\|1h`（C4–C7） |

**Crash / core dump**：**无**（`0` 个 core 文件；无 unhandled rejection；失败原因全部为「契约元素缺失」或断言，**非崩溃**）。
**未实现即必然红的理由**：`MultiPeriodChartStack` 目前把卫星按普通流追加（`height: Npx`，无高度分配、无 pane/分隔条契约、无拖拽、无持久化）。
**唯一绿**：B12「关闭态零残留」—— `enabled=false` 走 Provider 直通分支，本轮**不得**被实现方改红（DOM 逐字节等价契约）。

### 2.2 既有用例零回归

| 项 | 证据 |
|---|---|
| 全量 706 例既有用例 | `vitest_full_suite.txt`：`Tests 707 passed | 33 failed (740)`；3 个 failed 文件**全部**为本轮新增文件 ⇒ 既有用例 **0 失败** |
| 关键既有契约文件（P2/P3） | `multiPeriodSatellite.test.tsx` / `multiPeriodSatelliteLifecycle.test.tsx` / `multiPeriodClosedEquivalence.test.tsx` / `chartSyncGroup.test.ts` / `chartSyncDensity.test.ts` / `multiPeriodSyncBadge.test.tsx` 均在 706 通过之列 |
| P2 的 `T2-2`（卫星 inline height == `heights[period]`） | 本设计把「量测不可用（jsdom `clientHeight=0`）⇒ 保持请求高度」写成口径（设计报告 §2.1/§2.2）⇒ 既有断言不受影响（实测未红） |
| 类型 | `tsc_b.txt` = 0 字节（exit 0） |

---

## 3. 真渲染几何取证（`web/tester/p5-layout-harness/`）

命令：`cd web && node tester/p5-layout-harness/run.mjs`（exit 1）

```
main clientHeight=600 scrollHeight=1140 ⇒ 溢出 540px
现状（基准 + 卫星）高度和 = 1140（可用 600）
pane 数 = 0，分隔条数 = 0，Σ pane = 0
FAIL  G1 栈契约存在（`[data-mp-stack]`；P5 高度分配面）
FAIL  G2 pane 契约存在（`[data-mp-pane]` 数 == 4：基准 + 3 卫星）
FAIL  G3 恰好填满：Σ 各 pane 高度 == 可用高度 600（±1px）
FAIL  G4 **无纵向溢出**：主图区 scrollHeight <= clientHeight（现状实测 1140 > 600 = 540px 溢出）
FAIL  G5 栈自身无纵向溢出（scrollHeight <= clientHeight）
FAIL  G6 各 pane 真实渲染高度 == 声明高度（±1px）且 > 0
FAIL  G7 我方分隔条存在且覆盖每个相邻 pane 对（4 pane ⇒ 3 条；`role=separator`）
PASS  G8 零写请求（持久化路径不被 harness 触发）
非本地端口请求 = 0；写请求 = 0
```

**关键原始数值**（`p5_layout_harness.json`）

| 项 | 实测（红） |
|---|---|
| 主图区 `#main` | clientHeight **600** / scrollHeight **1140** ⇒ **溢出 540px**（与 P2-C `271` 报告 §9 **逐值一致**） |
| 现状业务元素 | 基准 `[data-testid="kline-chart"]` 高 **600**（`h-full` 被拉伸）+ 3 卫星 `[data-mp-satellite]` 各 **180** = **1140** |
| P5 契约元素 | `[data-mp-stack]` / `[data-mp-pane]` / `[data-mp-separator]` **均不存在**（0/0/0） |
| 网络 | 非本地端口请求 **0**、写请求 **0**、`pageerror` 0（仅 P3 既有的「组合不可用」警告：15m↔1h 不在锚定密度表 ⇒ 组不建立，属已验收的诚实降级） |
| 截图 | `p5_layout_harness.png`（144.8 KB，人工可核：主图区被撑破、卫星溢到容器外） |

**仪器性质（诚实标注）**
- 用 **Vite 构建真实产品组件**（`MultiPeriodChartStack` + 基准 `KlineChart` + 3×真实 `MultiPeriodSatellite`）+ **真实 Tailwind**（harness 内 `postcss.config.js` ⇒ 工具类语义与生产一致，不手搓子集）+ **真实 klinecharts 10.0.3**；合成数据、本地随机端口 ⇒ 0 出网/0 写请求。
- 主图区为**等价复刻**（600px 固定高 + `data-region="main-chart"`，与 P2-C `271` harness 同源口径），非整页 `DashboardGrid`；本层判据只依赖主图区几何，与锚点实现无关。
- 反向证据：本 harness **当前即红**（现状实现必溢出）；实现后 G1–G7 必须转绿且 G8 保持绿。

---

## 4. 本轮实测新增事实（对实现方直接有用）

1. **`h-full` 会把基准图拉到容器高**：现状基准 `KlineChart` 无 `heightPx` 时 `h-full` = 600px，卫星再追加 540px ⇒ 溢出正好 = 卫星总高。（设计报告 §2.3 已把「基准高度由栈的 pane 承载、`DashboardPage` 不再传 `heightPx`」写成契约。）
2. **jsdom 量测为 0**：`available <= 0` 若被当作「可用高度」处理，会把每 pane 压成 0/默认值 ⇒ 既有 P2 `T2-2`（卫星 inline height == `heights[period]`）会假红。故口径钉死：**量测不可用 ⇒ 保持请求高度**（A7/B10 已守护）。
3. **分隔条不得占布局高度**：否则 `Σ pane == 可用高度` 与「无溢出」不可能同时成立（设计报告 §2.3 允许 absolute/负 margin）。
4. **拖拽只在相邻两 pane 内互补重分配（总和不便）**：持久化 = **全 pane 布局高度**（和 == 可用）⇒ 同窗口重进可逐 px 复现（C1/C4 判据）。
5. **页面上 15m↔1h / 15m↔1d 不在 P3 锚定密度表** ⇒ 同步组不建立（日志警告为预期）；本层用例的周期组合已按 P1 护栏选取（卫星 ≥ 基准、不含 1mo、含 1w 需基准 ≥1d ⇒ 未取 1w）。

---

## 5. 交付物

| 文件 | 类型 | 状态（sha256 前 12 位） |
|---|---|---|
| `web/src/features/dashboard/multiPeriodLayout.test.ts` | 新增红测试 15 例（纯函数面） | `a9bdfc32d7e8` |
| `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx` | 新增红测试 12 例（DOM/拖拽/ADR-020 面） | `77ecb7608881` |
| `web/src/features/dashboard/multiPeriodHeightsPageContract.test.tsx` | 新增红测试 7 例（页面写入路径/②③ 面） | `46ff3c707464` |
| `web/tester/p5-layout-harness/{index.html,entry.tsx,run.mjs,vite.config.mjs,postcss.config.js}` | 真渲染几何仪器（8 检查） | `8c6999359605` / `18da87dfd93b` / `88bf7f447de0` / `c9ce70b561f1` / `7020c8dc0448` |
| `tester/design/276_p5_layout_persistence_red_design.md` | 设计报告 | `e7bda86e0545` |
| `tester/evidence/276_p5_red/`（6 文件） | 证据（原始输出 + JSON + PNG） | `vitest_p5_red_3files=ee42823703b9`、`p5_layout_harness.json=646548d4562f` |

- **暂存区**：空（`git diff --cached --name-only` 无输出；未 add/commit/stash）。
- **tracked 改动**：无（`git status --short` 无 `M/A/D` 行 ⇒ 本轮**只新增文件**）。
- **未做**：无任何失败分析/修复尝试；未新增永久插桩；未动产品代码/接口/架构；未跑 tangle；未触碰线上；临时端口/进程/构建产物已全拆。

---

**本报告位置**：`tester/test/276_p5_layout_persistence_red_execution.md`

VERDICT: RED-READY
