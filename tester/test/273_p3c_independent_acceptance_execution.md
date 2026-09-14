# 273 — P3-C 独立验收执行报告（真实渲染 klinecharts 10.0.3 + 测试基建改动审计）

- **本文件路径（自指）**：`tester/test/273_p3c_independent_acceptance_execution.md`
- 角色：Tester（独立验收 + 测试基建审计；**未改任何产品/测试代码**，变异仅在 `/tmp` 副本）
- 时间：2026-09-15（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `ec32767`；P3 实现在工作树，未提交）
- 被验对象（实现车道自述）：`coder/report/170_p3b_sync_group.md`、`web/src/features/dashboard/chartSyncGroup.ts`（755 行）、`chartSyncContext.ts`、`chartSyncGroup.test.ts`、`chartSyncDensity.test.ts`、`multiPeriodSyncBadge.test.tsx`、`web/src/test/syncChartStub.ts`
- 证据目录：`tester/evidence/273_p3c_acceptance/`
  - `real_render_harness.html` / `real_render_driver.mjs`（本轮**新建**的真实渲染仪器，`file://`/本地端口，0 外网）
  - `p3c_harness.json` / `p3c_harness.png` / `harness_stdout.txt`（真渲染结果）
  - `mutations/{A1_remove_satMax_RED.txt, A1_restored_GREEN.txt, A2_noop_stub_RED.txt, A2_restored_GREEN.txt}`（测试基建审计变异）

> 方法学声明（诚实标注）：本轮真实渲染把**真身 klinecharts 10.0.3** 与**真 `ChartSyncGroup`**（esbuild 打包 `chartSyncGroup.ts`，无桩、无 jsdom）直接对接。跨周期夹具的**间距按实测密度表校准**（base 间距 = satBucket / D；同 design 夹具口径），因为静态密度表（4.7/12.2/4.67/37.8）源自 A 股真实日历（含休市），连续合成序列无法逐字复现该日历。校准后两侧同一日历跨度可比 ⇒ 「跨度差 ≤1 根高周期 bar」可真实判定。

---

## 0. 结论速览

| 项 | 内容 | 结论 |
|---|---|---|
| A1 | `satMax: 5000` 是否放宽判据 | **非放宽**（删参 ⇒ 必红于仪器证明行；断言集逐条未变） |
| A2 | `setOffsetRightDistance` 忠实化 | **忠实**（与真身 13692-13710 语义一致；旧 no-op 下 T3-2/T4-1 不可能通过） |
| B1 | G1 无漂移 | **FAIL** —— 真渲染下相对偏移恒 **2 根**（非 0） |
| B2 | 跨周期对齐 | **FAIL** —— 1m↔5m / 1m↔15m / 1d↔1w 跨度差与右端差均超 1 根高周期 bar |
| B3 | T4 `scrollAllToLatest` | **PASS**（右端差 0）；T4-2 真渲染不可复现（引擎无 `updateData`）→ 仅 jsdom 覆盖 |
| B4 | T8bis 诚实降级 | **部分 FAIL** —— 降级 barSpace/≥2 根/角标字段 ✓；**右端对齐超容差**；反向「照用推导必红」**未复现** |
| B5 | 边界 | NaN 前置在真渲染**不可达**（引擎把 barSpace 夹到 width/2），无 NaN 无崩溃 ✓；静态密度回退 ✓；不泄漏基准 ✓ |
| B6 | 残余风险 ①–④ | 逐条独立结论见 §B6 |
| B7 | 回归 | 全量 vitest **75 files / 692 passed**；tsc -b exit 0；check-tangle exit 0；P1/P2 无回归 |

**根因（可复现、单一）**：真身 `scrollToTimestamp(ts)` 的落点**不是右缘**，而是「目标 bar 距右缘 2 根」（PROBE 实测）。实现把 follower 定位统一交给 `scrollToTimestamp`（`chartSyncGroup.ts` `alignFrom`），同时用 `setOffsetRightDistance(0)` 归零右偏移（该归零**确实生效**），但归零**并不能**去掉 `scrollToTimestamp` 固有的 2 根落点差。jsdom 桩把 `scrollToTimestamp` 建模为「精确落右缘」，因此 20/20 全绿。

---

## A. 测试基建改动审计（独立证明「非放宽」）

### A1. `chartSyncGroup.test.ts` 的 `satMax: 5000`（NaN 用例夹具参数）

- **变异**：`/tmp/p3c/web` 副本中删掉 `satMax: 5000`（`makePair('1m','1h',{baseBarSpace:40,satBarCount:20})`）。
- **红（必红）**：`tester/evidence/273_p3c_acceptance/mutations/A1_remove_satMax_RED.txt`
  - `1 failed | 11 skipped`；失败点 `chartSyncGroup.test.ts:409`
  - 断言：`expect(Number.isNaN(sat.getVisibleRange().from)).toBe(true)` → **`expected false to be true`**
  - 机制（可观测）：卫星上限回落默认 350 ⇒ `sat.setBarSpace(1512)` 被引擎**静默吞掉**（P0.3 §2.3），视口不可能 NaN ⇒ 仪器证明行不成立。
- **恢复后复绿**：`mutations/A1_restored_GREEN.txt`（`1 passed | 11 skipped`）。
- **断言集合改动前后对照（逐条未变，仅夹具参数不同）**：

  | # | 断言（改动前后**逐字相同**） | 说明 |
  |---|---|---|
  | 1 | `sat.getBarSpace().bar` `toBe 260` | 降级值 = `floor(520/2)` |
  | 2 | `Number.isNaN(sat.getVisibleRange().from)` `toBe false` | 降级后视口可读 |
  | 3 | `g.stats.degraded` `toBe true` | 降级可观测 |
  | 4 | `sat.setBarSpace(1512)` 后 `Number.isNaN(from)` `toBe true` | **仪器证明**（P0.3 §6-I3a） |
  | 5 | 再次交互后 `Number.isNaN(from)` `toBe false` | 组把视口拉回可读 |
  | 6 | `sat.getBarSpace().bar` `toBe 260` | 拉回后仍是降级值 |

  注：变异后断言 1–3 仍通过（失败发生在第 4 条之后），**证明 `satMax` 只影响第 4 条的「前置条件可满足性」，不改变任何判据的严格度**。
- **独立结论**：`satMax: 5000` 是「让前置条件（把推导值硬塞进引擎）可满足」的仪器参数，**不是放宽判据**。架构师授权成立。

### A2. `web/src/test/syncChartStub.ts` 的 `setOffsetRightDistance` 忠实化

- **真身语义**（`web/node_modules/klinecharts/dist/index.esm.js:13692-13710`）：
  ```js
  setOffsetRightDistance = function (distance, isUpdate) {
    this._offsetRightDistance = this._scrollLimitRole === 'distance' ? Math.min(this._maxOffsetDistance.right, distance) : distance;
    this._lastBarRightSideDiffBarCount = this._offsetRightDistance / this._barSpace;
    ... // isUpdate ⇒ _adjustVisibleRange + layout（副作用）
  }
  getOffsetRightDistance = function () { return Math.max(0, this._lastBarRightSideDiffBarCount * this._barSpace); }
  ```
- **桩实现**：setter `offsetRightBarsCount = distance / barSpace`；getter `Math.round(Math.max(0, offsetRightBarsCount * barSpace))`。
- **一致性核对**：核心链路「px → bar 数 → px」与真身**完全一致**；桩额外取整（真身返回浮点）、省略 `scrollLimitRole==='distance'` 的 `min(maxRightDistance, …)` 夹取与 `isUpdate` 布局副作用。对本组用法（`setOffsetRightDistance(0)` 后读回 0）**差异无影响**（0 → barCount 0 → 0）。⇒ 忠实（在所需公开面上）。
- **旧 no-op 桩下 T3-2/T4-1 必红（独立证明）**：`mutations/A2_noop_stub_RED.txt`
  - `2 failed | 10 skipped`
  - T3-2：`expected 304 to be less than or equal to 38`（`chartSyncGroup.test.ts:222`；`getOffsetRightDistance()=8×38=304 > barSpace 38`）
  - T4-1：`expected 304 to be less than or equal to 38`（`chartSyncGroup.test.ts:317`）
  - ⇒ 右端对齐判据在任何实现下都**不可能**通过旧 no-op 桩；忠实化是**解阻**而非放宽。
- **恢复后复绿**：`mutations/A2_restored_GREEN.txt`（`12 passed`）。`/tmp` 副本与仓库文件核对**逐字节一致**。

---

## B. P3 独立验收（真渲染数值与证据）

仪器：`tester/evidence/273_p3c_acceptance/real_render_harness.html` + `real_render_driver.mjs`；本地 `python3 -m http.server 18321`（127.0.0.1，已收尾拆除）；结果 `p3c_harness.json`。`errors=[]`，非本地请求 `=[]`（0 外网）。

### PROBE（无组；根因取证）

| 观测 | 值 |
|---|---|
| `getOffsetRightDistance()` 初始 | 64 px |
| `setOffsetRightDistance(0)` 后读回 | **0**（归零生效；沿用后仍 0） |
| 两个同构 1m 图 `setBarSpace(8)` + `scrollToDataIndex(300)` | A `[241,302]`，B `[241,302]`（**完全一致**） |
| B `scrollToTimestamp(A右缘ts)` | `[243,304]`（**整体 +2 根**）；`ΔtoTs = 120000ms = 2 根 1m bar` |

⇒ `scrollToTimestamp` 的落点固有偏 2 根，且与 `getOffsetRightDistance()`（读回 0）**无关**。

### B1. G1 无漂移（1m↔1m，20 轮镜像）

- 逐轮：base `[253,302]`/sat `[255,304]`，`[258,307]/[260,309]`，… 共 20 轮 **drift 恒 = 2**（每轮 `sat = base + 2`）。
- `maxDrift = 2`；`baseOffsetPx = 0`、`satOffsetPx = 0`。
- `stats`：`applied = 41`、`suppressed = 64 (>0)`、`echoEvents = 0`（无回声）、`degraded = false`。
- **判据「相对偏移 0」⇒ FAIL**（恒 2）。
- **反向（禁抑制）**：`reentrySuppression:false` ⇒ `echoEvents = 17 (>0)`、`suppressed = 0`、`drift = 2` ⇒ **回声可观测**（反向旋钮有效）。

### B2. 跨周期对齐（校准间距，真渲染）

| 组合 | satBS（实测/期望静态） | satBars | 跨度差 | 容差(1 根高周期) | 右端差 | 容差 | 结论 |
|---|---|---|---|---|---|---|---|
| 1m↔5m | 38 / 38 | 15 (≥2 ✓) | 546,383ms ≈ **9.1min** | 300,000ms (5min) | 568,085ms ≈ 9.5min | 5min | **FAIL** |
| 1m↔15m | 98 / 98 | 7 (≥2 ✓) | 1,740,000ms ≈ **29min** | 900,000ms (15min) | 1,490,164ms ≈ 24.8min | 15min | **FAIL** |
| 1d↔1w | 37 / 37 | 15 (≥2 ✓) | 1,171,982,827ms ≈ **13.56d** | 604,800,000ms (7d) | 966,125,910ms ≈ 11.18d | 7d | **FAIL** |

- 三组 `echo = 0`、`degraded = false`、`suppressed = 9`（抑制生效）。
- **判据「跨度差 ≤1 根高周期 bar 且右端对齐」⇒ FAIL**（三组均超）。satBS 与静态密度表一致（未用名义比）。

### B3. T4 `scrollAllToLatest()`

- base `[3939,4000]`、sat `[786,800]`，**两侧右端 ts 相等 = 1789369200000** ⇒ `rightEdgeDiff = 0 ≤ 300,000ms`；`baseOffsetPx = satOffsetPx = 0 ≤ 1 根`。⇒ **PASS**。
- （真实引擎在右缘报 `to == length`，实现侧 `readWindow` 已 `clamp` 到数据范围；本仪器同样钳位后读数。）
- **T4-2（新 bar 到达不回滚）真渲染不可复现**：klinecharts `Chart` **无 `updateData` API**（探针报 `base.updateData is not a function`）⇒ 真渲染无法在非交互下追加 bar；该判据仅由 jsdom 桩（`__appendBar` 不触发事件）覆盖。**记为覆盖缺口，不判 FAIL。**

### B4. T8bis 诚实降级（1m↔1h，真渲染）

- 退化：`ideal = round(8×37.8) = 302`，`satBS = 260 = floor(520/2) = capacity` ✓；`satBars = 4 (≥2 ✓)`；`degraded = true`、`degradedPeriod = '1h'` ✓；`onChange` 快照 4 次、最后一次 `degraded = true` ✓；`lastSpanDiffMinutes = 142.2 (>0)`。
- **右端对齐**：`rightEdgeDiff = 6,266,667ms ≈ 1.74h > 1h 容差` ⇒ **FAIL**（同一 `scrollToTimestamp` +2 根根因，1h bar ⇒ 约 2 根 ≈ 2h 量级）。
- ⑤ 缩小基准 `setBarSpace(4)`：`satBS = 151 = round(4×37.8)` ✓、`degraded = false`、`degradedPeriod = null`、最后快照 `degraded = false` ✓、`satBars = 5 (≥2)` ⇒ **PASS**。
- **反向「照用推导 barSpace ⇒ 必红」未复现**：真渲染下 `setBarSpace(302)` 后 `getVisibleRange()` 仍报 **4 根可见**（引擎把「部分可见 bar」计入 `to-from+1`），并非 <2 ⇒ 该反向证据**仅在 jsdom 桩成立**（桩用 `floor(pane/barSpace)=1`）。**如实记录，不据此判 FAIL**（但说明 jsdom 与真渲染在「可见根数口径」上不一致）。

### B5. 边界

- **NaN 前置不可达（无崩溃）**：卫星 `barSpaceLimit.max = 1e6`，`setBarSpace(1512)` 读回仍 **260**（引擎把 barSpace 夹到 `width/2`）⇒ **无法造出 `satBS ≫ pane` 的 NaN**。组侧始终落 `260`、`satBars = 4`、`degraded = true`，**无 NaN、无异常**（`errors=[]`）。⇒ 「降级不崩」成立；但 NaN 前置在本引擎版本不可复现（P0.3 §6-I3a 的 NaN 属桩面/特定组合）。
- **密度表静态回退生效**：1m↔5m 真渲染 `satBS = 38 = round(8×4.7)`（名义比 7 会给 56）⇒ **PASS**。
- **卫星放宽不泄漏基准**：基准请求 50/350/5000 ⇒ 读回 **50/50/50**；卫星 `max=350` 请求 350 ⇒ **350**。⇒ **PASS**。
- 纯函数抽查：`mirrorRightOffsetPx(80,4.7)=376`；`resolveDensityRatio('1m','5m',null)={4.7,'static'}`、`(…,5.2)={5.2,'measured'}`、`('1w','15m',null)={null,'none'}`。

### B6. 残余风险逐条独立结论（不照抄）

| # | 自述风险 | 我的独立结论 |
|---|---|---|
| ① | 生产走 `setOffsetRightDistance(0)` 边缘对齐，`mirrorRightOffsetPx` 未被直接调用 | **属实**：grep 全仓，`mirrorRightOffsetPx` 仅 `chartSyncGroup.ts` 定义 + `chartSyncDensity.test.ts` 引用，生产 `alignFrom` **不调用**。且生产右偏移路径本轮**已被真渲染覆盖并发现问题**（归零生效但 `scrollToTimestamp` 仍偏 2 根）⇒ 不是「未验证路径」，而是「已验证但不足」。故 ① 的风险从「未验证」升级为 B1/B2 的实锤缺陷。 |
| ② | 卫星↔卫星（15m↔1h）是否真工作 | **工作**：真渲染组（base 1m + 15m + 1h），以 15m 为 leader ⇒ 1h `satBS = 25 = round(8×(37.8/12.2))`（同锚点合成正确）、base `satBS = 1 = round(8/12.2)`、`echo = 0`。**barSpace 合成正确**（跨度对齐另见 B2 的 +2 根问题）。 |
| ③ | 无共同锚点时「跳过 follower」是否可观测 | **当前不可达**：`isSyncCombinationAllowed` 只放行表内/同周期组合，而 `densityFactors` 对每个可放行组合都以 base 为公共锚点 ⇒ 「同一 base 的任意两个合法卫星」必有共同锚点，`effectiveDensity` 返回 null 的 `continue` 分支在合法组内**不可触发**。⇒ 静默跳过**暂不可观测也无专统计字段**；若日后扩表/放宽护栏，该跳过是**静默**的（残余风险，低）。 |
| ④ | base 作为 follower 降级无角标（仅 store/日志可读） | **属实且可接受度存疑**：角标仅渲染在 `period === degradedPeriod` 的**卫星**面板（`MultiPeriodChartStack.tsx:138` → `MultiPeriodSatellite`）；若 base 降级（`degradedPeriod='1m'`）则**无角标**，仅 `mpStore.syncDegraded` / `stats` 可读。合法组合下 base 上限恒 50，base 退化少见 ⇒ 低风险，但属**可观测性缺口**。 |

### B7. 回归与卫生

| 命令 | 结果 |
|---|---|
| `cd web && ./node_modules/.bin/vitest run`（全量） | **75 files / 692 passed** |
| `vitest run chartSyncGroup|Density|SyncBadge`（P3 三文件） | **3 files / 20 passed** |
| `./node_modules/.bin/tsc -b` | **exit 0**（无 `tsbuildinfo` 落入仓库） |
| `./scripts/check-tangle.sh` | **exit 0**（`design 与生成物一致`，沙箱重生成逐字节比对，工作区未被修改） |
| P1/P2/①②③④/dcap 契约 | 由全量 692 通过覆盖（含 `dcapMirror`、`multiPeriodMockParity`、P1/P2 用例）→ 无回归 |
| 线上 PID 3112540 | **存活未触碰**（`./target/debug/eestock-app`，ELAPSED 11:24:27） |
| `git diff --cached` | **空**（无暂存） |
| 我的写入 | 仅 `tester/evidence/273_p3c_acceptance/` 与 `tester/test/273_p3c_independent_acceptance_execution.md`；tracked 改动仍是 P3 原有 5 文件 |
| 临时实例/端口 | `http.server 18321` 已 kill（进程 0，端口空闲）；playwright 实例已 `close()`（残留 chromium 均为**既存** `/snap` 用户浏览器，非本轮） |
| 变异 | 全部在 `/tmp/p3c` 副本；副本两文件与仓库**逐字节一致** |

### §8 已知限制（不判 FAIL）

- **卫星普通流追加 ⇒ 纵向溢出仍在**：属 P5 范围，本轮未复现/未验（真渲染也无 `updateData` 可追加），**如实记录**。
- **真渲染无法构造 T4-2 的「新 bar 到达」**：见 B3。

---

## C. 判定

- A（测试基建）：**通过** —— `satMax: 5000` 非放宽（删参必红于仪器行、断言集未变）；`setOffsetRightDistance` 忠实化（旧 no-op 下 T3-2/T4-1 不可能通过）。
- B1（G1 无漂移）：**FAIL** —— 真渲染相对偏移恒 2 根。
- B2（跨周期对齐）：**FAIL** —— 三组跨度差/右端差均超 1 根高周期 bar。
- B3（T4）：**PASS**（`scrollAllToLatest` 右端差 0）；T4-2 真渲染覆盖缺口。
- B4（T8bis）：**部分 FAIL** —— 右端对齐超容差；反向「照用推导必红」真渲染未复现。
- B5（边界）：NaN 前置不可达但**不崩**；静态密度回退、不泄漏基准 **PASS**。
- B7（回归/卫生）：全绿、无暂存、线上未触碰。

**根因指向（不修复，仅报告）**：实现统一用 `scrollToTimestamp` 定位 follower，而真身该 API 的落点距右缘固定 2 根，且 `setOffsetRightDistance(0)` 不能消除它；jsdom 桩把该语义简化为「精确右缘」，导致 20/20 绿在真实渲染下不成立。相关证据：PROBE 行 + S1/S2/S4。

**VERDICT: FAIL(B1,B2,B4)**
