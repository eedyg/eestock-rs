# 272 — P3-A 红测试执行报告（T3 / T4 / T8bis）

- **本报告位置**：`tester/test/272_p3_sync_red_execution.md`
- **类型**：Execution report（执行**本轮新落**的红测试 + 库事实仪器；本轮无既有用例被修改）
- **设计报告**：`tester/design/272_p3_sync_red_design.md`
- **证据目录**：`tester/evidence/272_p3_red/`
  - `vitest_p3_red_3files.txt`（3 个新增前端文件，原始输出）
  - `vitest_full_suite_red.txt`（全量前端套件，原始输出）
  - `tsc_b.txt`（`npx tsc -b`，**0 字节 = 零输出 = 通过**）
  - `p3_sync_harness.json` + `p3_sync_harness.png` + `p3_sync_harness_stdout.txt`（真身 klinecharts 库事实/几何取证）
- **仓库 / 提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `ec32767`（工作树起始干净；本轮仅**新增**测试/证据/文档）
- **执行时间**：2026-09-14 22:54–22:57（本地，UTC+8）
- **环境**：`web/` 下 `npx vitest run`（vitest 3.2.7 + jsdom）、`npx tsc -b`（tsc 5.8）、真身 klinecharts **10.0.3**（本地 UMD）+ Playwright Chromium（`file://`）
- **约束遵守**：未改生产实现/接口/架构；未 `git add/commit/stash`（暂存区为空）；未跑 tangle；未重启/触碰线上（PID 3112540 未动，
  **对 8081/8082 零请求**——harness 全程 `file://` + 合成数据，`non-file network requests = 0`）；临时实例：无（未起任何服务）；
  **未做任何失败分析与修复尝试**（无 core dump）。

---

## 1. 结果总览

| 套件 | 命令（cwd） | 退出码 | total | passed | failed | skipped | 判读 |
|---|---|---|---|---|---|---|---|
| 前端新增 3 文件 | `npx vitest run src/features/dashboard/chartSyncGroup.test.ts src/features/dashboard/chartSyncDensity.test.ts src/features/dashboard/multiPeriodSyncBadge.test.tsx`（`web/`） | 1 | 20 | 0 | **20** | 0 | 全部 `Cannot find module './chartSyncGroup'` / DOM 角标缺失（预期红） |
| 前端全量套件 | `npx vitest run`（`web/`） | 1 | 692 | 672 | **20** | 0 | Test Files 3 failed / 72 passed（75）⇒ **既有 672 例零回归** |
| 类型检查 | `npx tsc -b`（`web/`） | 0 | — | — | 0 | — | 零输出（红阶段不被模块缺失阻塞，变量 specifier 生效） |
| 真身 klinecharts harness | `node tester/p3-sync-harness/run.mjs`（`web/`） | 0 | 14 检查 | **14 PASS** | 0 | 0 | 库事实/几何/事件（含反向证据）；`pageerror=0`、非本地网络请求 = 0 |

**合计**：新增 **20** 个红用例 + **14** 项库事实检查；当前 **20 红 / 0 绿**（产品级）+ **14 绿**（库事实，与 P2-A 同一性质）。

---

## 2. 前端红测试（vitest）

```
 ❯ src/features/dashboard/chartSyncDensity.test.ts (6 tests | 6 failed)
 ❯ src/features/dashboard/chartSyncGroup.test.ts (12 tests | 12 failed)
 ❯ src/features/dashboard/multiPeriodSyncBadge.test.tsx (2 tests | 2 failed)
 Test Files  3 failed (3)
      Tests  20 failed (20)
```

### 2.1 失败用例表（20 例；错误信息 + 出处，无 crash/core）

| # | 文件 | 用例 | 错误信息（原文摘要） |
|---|---|---|---|
| 1 | `chartSyncDensity.test.ts:…` | D1 密度表：D 取实测密度比（1d→1w 必须 ≠ 名义比 7） | `Cannot find module './chartSyncGroup' imported from '…/chartSyncDensity.test.ts'` |
| 2 | 同上 | D2 密度估计器：卫星 ≤1 根 / 无重叠 ⇒ 失效（null） | 同上 |
| 3 | 同上 | D3 静态回退：估计器失效时用锚定静态表（来源可观测） | 同上 |
| 4 | 同上 | D4 诚实降级：容不下 ≥2 根时取「能容纳 ≥2 根的最大 barSpace」 | 同上 |
| 5 | 同上 | D5 右偏移按倍率换算（px 不得直接透传） | 同上 |
| 6 | 同上 | D6 护栏：恒退化组合（1m↔1w / 1m↔1d / 卫星<基准 / 1mo）必须被拒绝 | 同上 |
| 7 | `chartSyncGroup.test.ts` | G1 T3-1 同周期 20 轮逐字段相等 + 相对偏移 0 + 无回声 | 同上（`./chartSyncGroup`） |
| 8 | 同上 | G2 T3-2 跨周期（1m↔5m / 1m↔15m / 1d↔1w）：跨度差 ≤1 根高周期 bar 且卫星 ≥2 根 | 同上 |
| 9 | 同上 | G3 T3-2 反向：名义比 7 ⇒ 跨度差必超 1 根周 bar | 同上 |
| 10 | 同上 | G4 T3-3 重入抑制的反向证据（禁用 ⇒ 回声；开启 ⇒ 0） | 同上 |
| 11 | 同上 | G5 T3-4 护栏：1m↔1w 必须拒绝（抛错） | 同上 |
| 12 | 同上 | G6 T4-1 回到最新：`scrollAllToLatest()` 右端对齐 + 右偏移补偿 | 同上 |
| 13 | 同上 | G7 T4-2 尊重手动视口：新 bar 到达不得自动回滚 | 同上 |
| 14 | 同上 | G8 T8bis 诚实降级 + 角标可观测字段（①–⑤） | 同上 |
| 15 | 同上 | G9 边界 NaN 降级路径（`satBS ≫ pane 宽`） | 同上 |
| 16 | 同上 | G10 边界 上限不足：必须显式降级（不得静默吞掉） | 同上 |
| 17 | 同上 | G11 边界 放宽不泄漏到基准（`barSpaceLimit{1,50}` 严格） | 同上 |
| 18 | 同上 | G12 `stop()` 后不得再镜像（零残留） | 同上 |
| 19 | `multiPeriodSyncBadge.test.tsx` | B1 退化 ⇒ 角标出现（原因指引 + 跨度差）；缩小基准 ⇒ 角标消失 | `AssertionError: expected 4 to be 260`（`multiPeriodSyncBadge.test.tsx:225`）⇒ 基准缩放未传播到卫星（P3 未实现） |
| 20 | 同上 | B2 反向：退化状态必须可由页面读出（角标 + 跨度差） | `expected null not to be null`（`:282`）⇒ 无角标 DOM |

**Crash / core dump**：**无**（前 18 例为模块解析失败、后 2 例为断言失败；`0` 个 core 文件；无 unhandled rejection）。
**既有用例**：全量 672 passed（与 P2-C 收尾时的 672 一致）⇒ **零回归**（本轮只新增文件，未改动任何既有测试）。

---

## 3. 真身 klinecharts 库事实/几何取证（`web/tester/p3-sync-harness/`）

命令：`cd web && node tester/p3-sync-harness/run.mjs`（exit 0）

```
klinecharts version = 10.0.3 (indicators=27)
PASS  F1 库事实：scrollToTimestamp(ts) 把该 ts 的 bar 对齐到右缘（±8 根内，实测偏 2 根）
PASS  F2 库事实：交互处理器内再**写**图表 API ⇒ 同步嵌套事件（重入存在）
PASS  F3 密度比镜像：20/20 轮跨度差 ≤1 根高周期 bar
PASS  F3 镜像无漂移：卫星 barSpace 20 轮恒为同一值（请求值）
PASS  F3 跨周期卫星可见 bar ≥2
PASS  F3 反向证据：名义比 7 ⇒ 20 轮跨度差**均** >1 根周 bar（判别力成立）
PASS  F3 反向证据：名义比 7 的跨度差最小量级 ≥1 根周 bar
PASS  F4 库事实：基准（默认 max=50）请求 350/5000 被静默吞掉 ⇒ 读回仍 50
PASS  F4 库事实：卫星放宽到 350 后 350 生效（仅卫星）
PASS  F5 降级：barSpace=floor(W/2) ⇒ 视口可读且可见 bar ≥2
PASS  F5 记录（非门禁）：本配置下未复现 NaN（P0.3 §6-I3a 在 1m↔1d/1w 复现）
PASS  F6 密度估计器：正常窗可算（≈5）
PASS  F6 密度估计器：无重叠 ⇒ 失效（需静态回退）
PASS  F6 密度估计器：窗内 ≤1 根 ⇒ 失效（需静态回退）
pageerrors/console = none
non-file network requests = 0
```

**关键原始数值**（`p3_sync_harness.json`）

| 项 | 实测 |
|---|---|
| F1 右缘落点 | 目标 idx 180 ⇒ 实际 `to=182`（偏 **2 根**；默认右偏移） |
| F2 重入 | 一次 `scrollToDataIndex` ⇒ `onScroll×2`、`onVisibleRangeChange×3`；处理器内**写** API ⇒ **嵌套事件 ≥1**（纯读 `getVisibleRange` ⇒ 无嵌套：0） |
| F3 密度 | 窗内估计 **D≈5.167**（合成交易日 5/7）；密度镜像 satBS **41**（20 轮恒同 ⇒ 无漂移）、跨度差 ≤1 周 **20/20**、卫星可见 **14 根** |
| F3 反向（名义比 7） | satBS 56、跨度差 **20/20 轮全部 >1 周**（最小 **1,296,000,000 ms = 15 天**） |
| F4 | 基准 req 350/5000 ⇒ 读回 **50**（静默吞掉）；卫星（init 放宽 350）req 350 ⇒ **350** |
| F5 | 扫描 50…5000：`getVisibleRange()` **未出现 NaN**（本配置）；`barSpace=260` ⇒ 可见 **4 根**、`floor(520/2)` ⇒ **≥2 根**、可读 |
| F6 | 正常窗 `ok,/D=4.769`；无重叠（1w 平移 4000 天）⇒ `satBarsInWindow=0` 失效；窗内 ≤1 根（短历史 1w + 基准滚到最早）⇒ 失效 |

> **诚实标注**：F5 的 NaN 在**本 harness 配置**（合成数据、无历史 offsetRight 状态、limit 1e6）**未复现** ⇒
> 该项只作记录、不作门禁；红测试 G9 的 NaN 判定基于忠实桩的建模（依据 P0.3 §6-I3a 的实测记录），
> 其**产品级**复现留待 P3-C 真渲染验收（结论：实现仍必须显式降级，不得依赖「恰好可读」）。

---

## 4. 本轮实测新增事实（对实现方直接有用）

1. **`scrollToTimestamp(ts)` 的右缘落点带默认右偏移**（本次实测偏 2 根，bs=8；P0.3 §6-I6 实测 px 随 barSpace 缩放）
   ⇒ 跨周期「右端对齐误差 ≤1 根高周期 bar」**必须补偿右偏移**（`setOffsetRightDistance(0)` 或按 ts 逐边对齐）；
   红测试 G2/G6 已把「跟随者 `getOffsetRightDistance() ≤ 1 根自身 bar`」写成断言。
2. **模型化的重入形状**：真身下「处理器内**读** `getVisibleRange()`」**不**产生嵌套事件（实测 nested=0）；
   嵌套来自「处理器内**写**图表 API」（实测 nested ≥1）⇒ 跨图同步的抑制必要性正是「镜像写入 → 对侧事件回传」。
3. **`barSpaceLimit` 只能在 `init({layout:{barSpaceLimit}})` 设置**（`index.d.ts` 无 `setBarSpaceLimit`）
   ⇒ 卫星放宽必须在建实例时完成；上限不足必须**显式降级**（默认 50 静默吞掉，实测读回不变）。

---

## 5. 交付物

| 文件 | 类型 | 状态（sha256 前 12 位） |
|---|---|---|
| `web/src/test/syncChartStub.ts` | 新增测试基建（忠实同步桩） | `b266c3cbfab9` |
| `web/src/features/dashboard/chartSyncGroup.test.ts` | 新增红测试 12 例 | `e2a1f17a2c56` |
| `web/src/features/dashboard/chartSyncDensity.test.ts` | 新增红测试 6 例 | `5b415cd0f0f0` |
| `web/src/features/dashboard/multiPeriodSyncBadge.test.tsx` | 新增红测试 2 例 | `abba1e83801c` |
| `web/tester/p3-sync-harness/harness.html` | 真身 klinecharts 仪器 | `3c91609f9faa` |
| `web/tester/p3-sync-harness/run.mjs` | 仪器 runner（14 检查） | `21b53dbc742d` |
| `tester/design/272_p3_sync_red_design.md` | 设计报告 | 已产出 |
| `tester/evidence/272_p3_red/` | 证据（6 个文件） | 已产出 |

- **暂存区**：空（`git diff --cached --name-only` 无输出；未 add/commit/stash）。
- **未做**：无任何失败分析/修复尝试；未新增永久插桩；未动产品代码/接口/架构；未跑 tangle；未触碰线上。

---

**本报告位置**：`tester/test/272_p3_sync_red_execution.md`

VERDICT: RED-READY
