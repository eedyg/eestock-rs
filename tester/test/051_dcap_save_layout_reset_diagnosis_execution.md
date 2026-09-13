# 执行报告 051 — 保存 dcap 参数重置布局：复现 / 定位 / 可行性 / 红测试（阶段 1 诊断）

- **本文件位置（self-location）**：`tester/test/051_dcap_save_layout_reset_diagnosis_execution.md`
- **测试设计**：`tester/design/016_dcap_save_layout_red_test_design.md`
- **证据目录**：`tester/evidence/051/`（harness + probe1~5 原始 JSON + 10 张截图 + 沙箱候选修复复跑输出 + 只读 SELECT 记录）
- **执行时间**：2026-09-13 23:09 ~ 23:26 (+0800)；`date -u` 15:09 ~ 15:26
- **仓库根 / commit**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `d74bfb8`（本车道**未改任何产品代码**，仅新增 1 个测试文件 + 本报告/设计/证据）
- **被测形态**：临时构建（`/tmp/diag51/dist`）+ 临时预览 `127.0.0.1:18085`，`/api`、`/ws` 反向代理到**线上只读** `8081`（只发 GET）；真实 `klinecharts@10.0.3`
- **纪律**：未 kill/重启/改配置 8081/8082（PID 2102695 全程未动）；未改线上 `web/dist`；未 `git add/commit/stash`；仓库内未跑 tangle；未改 `design/14-dcap-indicator` 的 `file=` 块；DB 仅 **SELECT**；无崩溃 / 无 core dump（探针 `pageErrors` 全空）
- **本报告性质**：**只取证，不分析失败原因之外的因果推断不做修复**；修复提案只写「改哪里、怎么改、副作用面」，**未落地任何代码改动**

> 结论速览：**缺陷复现 ✅（VOL 237px → 100px，−137px）** / **定位：A 与 B 两条路径都存在 ✅** / **`overrideIndicator` 可行 ✅（保高度、重算线值）** / **红测试已就位且当前红 ✅** / **最小修复提案 + 副作用面 ✅（沙箱预演：修复后红测转绿，仅 2 条既有测试需同步更新）** / **只读 SELECT ✅（含并发外部写入的事实报告）**
> 末行 **VERDICT: DIAGNOSED**

---

## 1. 缺陷复现（真实渲染，量化证据）

### 1.1 场景 A —— DCAP **关**态：拖高 VOL ⇒ 保存 `r_s`（走真实 `saveDcapParams` 路径）

操作链：页面加载（DCAP 默认关）→ 鼠标拖第一条分隔线（candle↔VOL）**上移 150px** → 工具栏 `DCAP 配置(8,26,60)` → 面板内把 `r_s` 由 `1` 改成 `1.2` → 点「保存」（`PUT /api/config/dcap` 被浏览器侧本地兑现，**未发往后端**）。

| pane | 保存前（拖高后） | 保存后 | Δ |
|---|---|---|---|
| `candle_pane`（MA，弹性） | DOM **460.0px**（`getPaneOptions().height`=460） | DOM **597.0px**（`height` 选项仍是 460） | **+137px** |
| `indicator_pane_…665535_3`（VOL） | DOM **237.0px** / `height`=237 | **该 pane 已不存在**；新建 `indicator_pane_…670507_3`，DOM **100.0px** / `height`=100 | **−137px（回默认高）** |
| `x_axis_pane` | 26px | 26px | 0 |

- **量化结论**：用户拖出的 VOL 高度被重置为布局默认 `100px`（差额 **137px** 全部回灌给主图 candle pane，460→597），即「K 线与副图之间的高度被重置」被真实复现。
- 截图：`evidence/051/A1-dragged-dcap-off.png`（拖高后） / `A2-after-save-dcap-off.png`（保存后，副图明显缩回）。
- **两次 burst**：一次「保存」在真实路径上产生 **2 个 React commit**（`saveDcapParams` 的乐观更新 `setDcapParams({...next})` + 服务端回显 `setDcapParams(cfg)`）⇒ `syncIndicators` 跑 **2 遍**，共 **16 次** remove/create（每遍 6 次 remove：MA/VOL/MACD/KDJ/BOLL/DCAP，2 次 create：MA/VOL）。
- 逐调用快照（`probe3.json → A.churn`）节选：
  ```
  seq20 removeIndicator {"name":"MA"}  | panes before [candle:460, vol-pane:237, x_axis:100] → after 不变（MA 在 candle_pane，不销毁 pane）
  seq21 createIndicator {name:MA, calcParams:[5,10,20], paneId:candle_pane} → after 不变
  seq22 removeIndicator {"name":"VOL"} | panes before [candle:460, vol-pane:237, x_axis:100] → after [candle:460, x_axis:100]   ← pane 被销毁
  seq23 createIndicator {name:VOL, paneId:indicator_pane_…507_3} → after [candle:460, x_axis:100, 新VOL:100]  ← 默认高 100
  …（MACD/KDJ/BOLL/DCAP 的 remove 在关态下是 no-op；DCAP pane 未被创建）
  ```
- **无 remount**：`window.__KC_INITS__` 保存前后都是 **1**。

### 1.2 场景 C —— DCAP **开**态：拖高 VOL+DCAP ⇒ 保存 `r_m`（warmup 不变的参数）

| pane（按键名归并） | 保存前（拖高后） | 保存后 |
|---|---|---|
| MA（`candle_pane`） | DOM **359** | DOM **496** |
| VOL | DOM **145**（pane `…676277_3`） | DOM **100**（pane `…679795_2`，**id 更换**） |
| DCAP | DOM **192**（pane `…676278_2`） | DOM **100**（pane `…679795_5`，**id 更换**） |

- `__KC_INITS__` 3 → 3（无 remount）；churn 18 次（2 遍 × 9）。
- 截图：`evidence/051/C1-dragged-dcap-on.png` / `C2-after-save-rm.png`。
- 即：**DCAP 副图自身**与**其它副图（VOL）**的高度**都会**被重置（`syncIndicators` 遍历全部指标，不只 DCAP）。

### 1.3 真实的 klinecharts 行为旁证（本次实测发现的读数陷阱）

- `getPaneOptions().height` 对**弹性 pane**（`candle_pane`）返回的是**拖拽残值**（460），不等于渲染高度（597）；渲染高度必须取 `chart.getDom(paneId).getBoundingClientRect().height`（或非弹性 pane 的 option）。
- 依据：`index.esm.js:14787-14835`（`measureHeight` 对非弹性 pane 用 `max(minHeight, options.height)`，弹性 pane 吃剩余且只 `setBounding`，**不回写 options**）。
- ⇒ 本报告所有「高度」数字默认以 **DOM 渲染高度**为准，`getPaneOptions` 仅作旁证。

---

## 2. 销毁点定位：A（`syncIndicators` churn）/ B（整图 remount）—— **两条路径都存在**

### 2.1 方法：包裹 `chart.removeIndicator / createIndicator / overrideIndicator / setPaneOptions / setDataLoader / setSymbol …` 记录「调用序列 + 每次调用前后 pane 快照 + 调用栈指纹」

证据：`evidence/051/probe3.json`（`churn` / `fingerprints` / `fingerprintMatch`）、`probe5.json`（路径 B 全量序列）。

### 2.2 路径 A —— `syncIndicators` 的 remove→create churn（参数变化、feed 不变）

**结论：`KlineChart.tsx` 中依赖 `[props.indicators, props.maWindows, props.dcapParams]` 的那个 useEffect 所调用的 `syncIndicators`，是 pane 被销毁重建的直接原因。** 三条独立证据：

1. **调用签名（正向排除 mount effect）**：mount 用的 `[feed]` effect 在 `syncIndicators` 之前**总会**先调 `setDataLoader → setSymbol → setPeriod → setStyles`（初始 mount 实测序列即 `setDataLoader, setSymbol, setPeriod, setStyles, removeIndicator, …`）。而保存 dcap 参数产生的 burst 里**这 4 个调用一个都没有**（A6/C4 断言绿；`A.churn` 只有 remove/create）⇒ 该 burst 不是 mount effect。
2. **`init` 计数不变**：`window.__KC_INITS__` 在场景 A（1→1）、C（3→3）均不变。`init()` 只在 `[feed]` effect 中调用 ⇒ `[feed]` effect 未重跑 ⇒ 排除「建图 effect」；`syncIndicators` 只剩另一个调用者（deps effect）。
3. **依赖面**：该次 React commit 中只有 `dcapParams` 变化（`indicators`、`maWindows` 为同一引用/同值），而 `feed` 未变 ⇒ deps 数组里被触发的只有 `props.dcapParams`。
4. **交叉对照**：点「KDJ」勾选（一定只走 deps effect，无 `init`、无 `setDataLoader`）产生的 churn 与本两次保存的 churn **调用点栈指纹完全相同**（`fingerprintMatch.saveA_eq_toggle=true, saveC_eq_toggle=true`）。
   ⚠️ **诚实标注**：该指纹**不具区分力**（`mount_eq_toggle` 也 = true）——因为压缩产物里 `syncIndicators` 的 4 层内联栈对四种 burst 都一样。故**归因不靠指纹**，而靠上面的 1+2+3（调用签名 + init 计数 + 依赖分析），指纹仅作「同一函数被调用」的佐证。

### 2.3 路径 B —— 整图 remount（`n_l`/`m` 变化 ⇒ warmup 变化 ⇒ feed 身份变化）

**结论：改 `n_l` 或 `m` 会改变 `dcapWarmupBars = n_l + m − 1` ⇒ `DashboardPage` 的 `feed` useMemo 依赖 `dcapWarmup` 变化 ⇒ 新建 `KlineDataFeed` ⇒ `KlineChart` 的 `[feed]` effect 重跑 ⇒ `init()` 建新图，所有 pane 以默认高度重建。**

- 场景 B（DCAP 开，保存 `m: 3 → 5`，warmup 62 → 64）：`__KC_INITS__` **2 → 3**；高度 `{MA:359, VOL:145, DCAP:192}` → `{MA:496, VOL:100, DCAP:100}`；pane id 全部更换（`…094791_10/…094792_2` → `…097077_3/…097077_6`）。
- `probe5.json`（全量序列）显示 remount burst 的**开头就是 mount 特征**：
  ```
  seq42 setDataLoader [{}]
  seq43 setSymbol [{ticker:"518880", pricePrecision:3, volumePrecision:0}]
  seq44 setPeriod [{type:"minute", span:15}]
  seq45 setStyles [{candle:{…}}]
  seq46 removeIndicator {"name":"MA"} … seq54 createIndicator {name:DCAP, calcParams:[8,26,60,1,1,1.02,1,5]}
  seq55..seq63 又一遍 remove/create（乐观更新）   seq64..seq72 再一遍（服务端回显）
  ```
- 截图：`evidence/051/B2-dragged-dcap-on.png` / `B3-after-save-m-remount.png`。
- **只改 `r_s/r_m/r_l/smooth` 不会**触发路径 B（warmup 不变）；**改 `n_s/n_m` 也不会**（warmup 只由 `n_l`、`m` 决定，`dcapWarmupBars` 实现见 `dcapIndicator.ts`）。

### 2.4 A/B 结论

| 触发条件 | 路径 A（syncIndicators churn） | 路径 B（整图 remount） | 布局是否被重置 |
|---|---|---|---|
| DCAP 关，保存任意 dcap 参数 | ✅（16 次 remove/create：VOL pane 被销毁重建） | ❌（`init` 不增） | ✅ 被重置（A 场景实测 237→100） |
| DCAP 开，保存 `r_s/r_m/r_l/smooth` | ✅（VOL+DCAP pane 同时被销毁重建） | ❌ | ✅ 被重置（C 场景实测 145/192→100/100） |
| DCAP 开，保存 `n_l` 或 `m` | ✅ | ✅（`init` +1，全部 pane id 更换） | ✅ 被重置（B 场景实测） |

⇒ **两者都有**；**只修路径 A 不足以满足「保存任何 dcap 配置都不重置布局」**（`n_l`/`m` 仍会 remount）。

---

## 3. `overrideIndicator` 能力核实（真实数据 + 真实 pane）

证据：`probe3.json → E / overrideCalls / overrideChurn`；截图 `E1-before-override.png` / `E2-after-override.png`。

调用（DCAP/MA/VOL/MACD 已启用，DCAP pane 已拖高，另把 VOL 拖成 292 让三条 pane 边界都非默认）：

| 调用 | 返回值（库事实） | calcParams 生效 | 线值变化 | pane 高度 | pane id | 新增 pane |
|---|---|---|---|---|---|---|
| `overrideIndicator({name:'DCAP', calcParams:[8,26,60,1.3,1,1,0,3]})` | **false** | ✅ `[8,26,60,1.2,1.5,1,1,5]`→新值 | ✅ s 有效点数 173→177、值域变；`zero` 恒 0 | **逐值不变** | 不变 | 无 |
| `overrideIndicator({name:'MA', calcParams:[7,20,60]})`（无 paneId，主图 `candle_pane`） | false | ✅ `[5,10,20]`→`[7,20,60]` | ✅ | 不变 | 不变 | 无 |
| `overrideIndicator({name:'MA', paneId:'candle_pane', …})`（带 paneId 过滤器） | false | ✅ | ✅ | 不变 | 不变 | 无 |
| `overrideIndicator({name:'VOL', calcParams:[3,9]})`（独立副图） | false | ✅ `[5,10,20]`→`[3,9]` | ✅ | 不变 | 不变 | 无 |
| `overrideIndicator({name:'MACD', …})`（已启用独立副图） | false | （未单独抽样线值） | （未抽样） | 不变 | 不变 | 无 |
| 负控：`{name:'KDJ'}`（**未启用**） | false | — | — | 不变 | 不变 | **无**（不创建指标/pane） |
| 负控：`{name:'NOT_REGISTERED_IND'}` | false | — | — | 不变 | 不变 | 无 |

补充断言（均绿，`probe3.json.checks`）：
- **E1** 6 条 pane 渲染高度逐值相等（`{MA:258, VOL:292, MACD:45, DCAP:100}` 前后完全一致）；
- **E2/E3** pane id 集合、指标集合（`name@paneId`）、pane 数量均不变；
- **E6** DCAP pane 的 canvas 像素哈希变化 **且** Y 轴量程变化：`from/to = [-0.02116329, 0.02402008] → [-0.02245367, 0.02524694]` ⇒ 是**真渲染重算**，非仅内部字段；
- **E7** `precision=5`、`figures.key = ['s','m','l','zero']` 不变（DCAP 契约不被 override 破坏）；
- **E13** 未触发 `init`（无整图重建）；**E14** 无任何非 GET 请求、`/api/kline` 请求数 3→3（**只重算、不重新取数**）；**E15** 序列里只有 `overrideIndicator`，没有 remove/create。

**库事实（必须写进修复注意项）**：`ChartImp.overrideIndicator` 在「仅 calc 变化」时返回 **`false`**（`index.esm.js:15296-15318`：`updated` 只在 draw/sort 时置位），本次 6 次调用**全是 false 但确实生效** ⇒ **不得用返回值判成败**。

**对「指标启用状态」逻辑的影响**：`overrideIndicator` 只在**已存在**的指标上生效（`getIndicatorsByFilter` 为空即直接 `return false`，`:15299-15301`）⇒ **启用/停用仍必须靠 `createIndicator` / `removeIndicator`**。这与「状态差分」修复方案天然契合：**只翻转启用状态才 create/remove，参数变化走 override**。

---

## 4. 红测试：位置与当前红状态

- **新增文件**：`web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`（既有 vitest + jsdom 基建；2 条用例）
  - T-1（**红**）`改 dcapParams 后：既有 pane 高度不变（±1px）、pane 不被销毁重建、dcap 线值按新参数更新`
  - T-2（守卫，绿）`指标启用状态翻转仍必须 create/remove（差分不得吞掉开关语义）`
- **当前红状态（原始输出见 `evidence/051/red-test-run.txt`）**：
  ```
  × 保存 dcap 配置不得重置 pane 布局 > 【红】改 dcapParams… 13ms
    → AssertionError: expected 240 to be less than or equal to 1
   Test Files  1 failed (1)      Tests  1 failed | 1 passed (2)
  ```
  （VOL 拖到 240 → 保存参数后该 pane 被销毁重建，渲染高度落到 0；断言「±1px」因此红。）
- **全量回归面**：`npx vitest run` → **57 files / 564 tests，1 failed（即新增红测试）/ 563 passed**（基线为 56 files / 562 tests ⇒ 本车道只多了这 2 条，无附带破坏）；`npx tsc -b` 无输出（干净）。
- **沙箱预演「修复后转绿」（未改仓库代码；副本在 `/tmp` 与 `web/node_modules/.diag51/`，已删）**：
  - 候选 **v3**（已应用状态用组件 ref 持有 + 参数变化走 `overrideIndicator`）：新增红测试 **2/2 绿**；既有 3 个测试文件里**只剩 2 条红**，且都是「断言旧 churn 语义」：`KlineChart（MA 窗口可配置）> maWindows 变化 → 重新 sync 应用新 calcParams`、`DashboardPage（页面①集成）> MA 配置保存：改窗口 → 主图 KlineChart 应用新 calcParams`（它们期望 `createIndicator(新 calcParams)`，修复后应为 `overrideIndicator`）⇒ **测试需同步更新**。
  - 候选 **v1**（用 `chart.getIndicators({name})` 判在场）：**44 条既有测试红**（`TypeError: chart.getIndicators is not a function`，因为既有测试桩只提供了 `createIndicator/removeIndicator/...`）⇒ **修复不得引入既有桩没有的 chart API，否则要同步扩桩**。
- 真实渲染等价证据：本报告 §1/§2/§3（同一判据在真实 klinecharts 上成立：237→100、id 更换、init 计数、override 保高度）。

---

## 5. 最小修复提案（**不改代码**，只给方案）

### 第 1 步（必需）— `syncIndicators` 改为**状态差分**（`web/src/features/dashboard/KlineChart.tsx` 一处）

目标：**只有「启用状态」翻转才 create/remove；参数变化走 `overrideIndicator`。**

1. **已应用状态放在组件内、随建图重置**：在 `[feed]` effect 里 `appliedRef.current = new Map<string, number[]>()`（`name → 已应用 calcParams`），把该 Map 作为参数传给 `syncIndicators`。
   - ⚠️ **不要用模块级 `WeakMap<Chart, …>`**：既有测试的 chart 桩是**跨用例共享的同一个对象**（`KlineChart.test.tsx` 的 `chartStub`），WeakMap 会让后续用例误判「已应用」而跳过创建 —— 沙箱实测该写法导致 3 条 MA 用例 `createIndicator` 调用数为 0（红）。
2. **逐步逻辑**（每个 `INDICATOR_DEFS` 项）：
   - `enabled === false`：若已应用过 → `chart.removeIndicator({name})` 并删掉表项；否则不动（**不产生空 pane**）。
   - `enabled === true` 且**未应用过**：走原 create 分支（MA→`paneId:'candle_pane', isStack=false`；DCAP→`ensureDcapIndicatorRegistered()` + `isStack=true`；其它→`isStack=true`），随后登记 calcParams。
   - `enabled === true` 且已应用过、`calcParams` **有变化**：`chart.overrideIndicator({ name, calcParams })`（**不传 `paneId`**：DCAP/VOL/MA 名唯一，且传了也无害），更新登记值。
   - `calcParams` 无变化：**什么都不做**（幂等 ⇒ 乐观更新+回显两次 commit 天然安全）。
3. **不要依赖 `overrideIndicator` 的返回值**（仅 calc 变化时为 `false`；见 §3）。
4. MA 窗口变化因此从「重建 MA」变为「原地重算 MA」——**candle pane 不受影响**（本来也不被销毁），但需要更新 2 条既有测试（§4）。

### 第 2 步（必需，否则需求不成立）— 断开 **warmup → feed 身份** 的耦合（路径 B）

现状：`DashboardPage` 的 `feed` useMemo 依赖 `dcapWarmup = dcapWarmupBars(dcapParams)`；`KlineChart` 的建图 effect 依赖 `[feed]`。改 `n_l`/`m` 必然整图重建。

**方案 ①（推荐·保布局）**：把 warmup 从 feed 的**身份**降为**可变属性**：
- `KlineDataFeed.warmupBars` 改为可变 + 提供「强制重载」（现有 `loadInitial()` 幂等、命中缓存不再取数，实测 `resetData()` 后 `/api/kline` 请求数 **未增加**、`dataLen` 仍 182 ⇒ 必须有显式 reload 才能换新 limit）；
- `DashboardPage` 的 `feed` useMemo **移除 `dcapWarmup` 依赖**（保留 `viewportBars`）；参数变化时 `feed.setWarmup(n)`，并让图表在**不重建**的前提下重载数据：`chart.resetData()`。
- **实测支撑（`probe4.json`）**：`chart.resetData()` 后 —— pane id 集合不变、`init` 计数不变、**pane 渲染高度逐值不变**（`{MA:359, VOL:237, DCAP:100}` 前后相同）、**视口不被扰动**（`getVisibleRange()` `{from:68,to:182}`→同值、`getBarSpace()` `bar:11`→`bar:11`、`offsetRightDistance 80`→`80`）；唯一不满足的是「没换 limit」（需 feed 侧强制 reload）。
- ⚠️ 待 coder 验证：`resetData` 会重跑 DataLoader `init`（`index.esm.js:13652-13658`）⇒ 需确认不会顺带触发 `fitBarSpace` 之外的视口重排；建议**不**调用 fit（保持 ADR-020 §2.6「尊重手动视口」），也不要把 `manualAdjusted` 重新置 false。

**方案 ②（保守·保布局的兜底）**：仍允许 remount，但**记住并回放 pane 高度**：卸载前/拖动时记录 `{指标名 → 高度}`（顺序按指标名，因为 pane id 会变），重建后 `syncIndicators` 完成时按当前 `getIndicators({name})[0].paneId` 逐个 `setPaneOptions({id, height})`。
- **实测支撑（`probe3.json → M.step3`）**：churn 之后 `setPaneOptions({id: volPane, height: 237})` 能把该 pane 渲染高度恢复到 **237px**（±0）。
- 代价：需订阅/记录拖拽（`subscribeAction('onPaneDrag')` 或比较 `getPaneOptions`），并处理「指标被停用再启用」的顺序漂移；比方案 ① 更重，建议作为 ① 不可行时的退路。

### 第 3 步（可选·观测性）— 留一条可断言痕迹
建议在 `data-viewport-fit` 同层加一个 `data-dcap-sync`（记录本次 sync 的动作类型：`create|remove|override|noop` 计数），便于 e2e 直接断言「保存参数没有 create/remove」。**不强制**。

---

## 6. 副作用面（逐项，按派单要求）

| 既有行为 | 修复后影响 | 依据 / 需同步的事 |
|---|---|---|
| **指标勾选切换**（MA/MACD/KDJ/BOLL/DCAP 开↔关） | **语义不变**：翻转仍 create/remove；关态不产生空 pane；重开以布局默认高 100 建 pane | 守卫测试 T-2（现绿）；真实探针 A7（DCAP 关态保存不误建 pane） |
| **MA windows 变化** | 由「remove+create MA」改为「`overrideIndicator(MA)`」⇒ 更轻、且不再重建指标（**用户可见行为更好**） | ⚠️ **2 条既有测试需更新**（期望由 `createIndicator(新 calcParams)` 改为 `overrideIndicator`）：`KlineChart.test.tsx` 的 `maWindows 变化 → 重新 sync…`、`DashboardPage.test.tsx` 的 `MA 配置保存：改窗口…`（沙箱实测） |
| **DCAP 开/关** | 开关本身语义不变（关时 `removeIndicator DCAP` 销毁 DCAP pane；开时新建 pane 默认高 100）。**注意**：`DCAP 关 → 开` 仍会丢失该 pane 的原高度/顺序（不在本次需求「保存配置不重置」范围内；若要保留需再记 pane 高度） | §3 负控；真实探针 B1/D（DCAP 开⇒3 pane；关⇒2 pane 无空 pane） |
| **ADR-020 视口口径** | 路径 A 修复**完全不触及**视口：参数保存不重建图、不重新取数（实测 `/api/kline` 请求数不变）、`setBarSpace`/`fitBarSpace` 不被触发 ⇒ 视口/「可见 ≈ N 根」不变；路径 B 修复（方案 ①）实测 `resetData` 后 `visibleRange`/`barSpace`/`offsetRightDistance` **逐值不变**，但**必须**确认不重跑 fit、不重置 `manualAdjusted`（否则会破坏「用户手动缩放后不重算」） | `probe4.json` R1/R3/R4；`probe3.json` E14 |
| **pane 首次创建时的默认高度分配** | **不变**：新建 pane 仍取布局模板 `height:100/minHeight:30`，弹性 `candle_pane` 吃剩余（`measureHeight` 语义未变）。差异只在**何时**新建：从「每次 sync 都重建」变为「仅启用状态翻转时」 | `index.esm.js:13250-13256`、`:14787-14835`；真实探针 A/C/M |
| **Pane 顺序漂移（附带收益）** | 现状下 churn 会改变副图顺序（实测手工只重建 VOL ⇒ VOL 被追加到 DCAP **之后**；`M1`）；修复后参数保存不再重排 | `probe3.json → M` |
| **DCAP 取数 warmup** | 保持/显式重载：初次加载仍 `limit = viewport_bars + warmup`（T10 口径不变）；仅当 `n_l`/`m` 变化需要**重载**以补足更早的 warmup（方案 ① 的 feed 强制 reload）。若选择「不重载」，表现退化为「视口最左一段 DCAP 断线直到用户向左翻页」 | `probe4.json` R2（resetData 不会自动换 limit）；`klineDataLoader.ts`（`loadInitial` 幂等） |
| **宫格（GridCell）** | 不受影响：宫格不复用 `KlineChart`、不渲染 DCAP；其 MA 热更新是 `remove+create MA` 落 `candle_pane`（**不会销毁 pane**，故无同类缺陷） | `GridCell.tsx:55-88` |
| **既有测试基线** | 修复落地后需：新增红测试转绿 + 更新 2 条 MA churn 断言；**不得**引入既有测试桩缺失的 chart API（否则 44 条红，见 §4-v1） | `evidence/051/fix-candidates/sandbox-fix-runs.txt` |

---

## 7. 只读数据库查证（授权范围内，仅 SELECT）

（原始记录：`evidence/051/db-readonly.txt`；连接信息取自 `/tmp/app_dev_8081.toml` → `postgres://eestock:eestock@127.0.0.1:5433/eestock`；容器为 **eestock-timescaledb**（5433→容器 5432）；命令 = `psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -c "SELECT …"`，**未执行任何 INSERT/UPDATE/DELETE/DDL**）

**第 1 次读取（23:13:29 +0800 = 15:13:29 UTC）**

```
key  | value                                                                            | updated_at
dcap | {"m":3,"n_l":60,"n_m":26,"n_s":8,"r_l":1.0,"r_m":1.0,"r_s":1.0,"smooth":1}         | 2026-09-13 15:07:52.814854+00
```
⇒ `updated_at` 的**绝对时间 = 2026-09-13 15:07:52.814854 UTC = 2026-09-13 23:07:52 (+0800)**；`value` 全文见上（**8 参、无 `th`、`smooth=1`**）。

**关于 `smooth=0` 是何时被写入的（关闭上一轮 049 FAIL(4) 的归属问题）**

可用事实链：
- tester-046 基线（**12:35:54Z = 20:35:54 CST**）：`smooth = 1`；
- tester-049 窗口内三次读取逐字节相同（**13:26–13:47Z = 21:26–21:47 CST**）：`smooth = 0`；
- 本次（15:13:29Z = 23:13:29 CST）读到 `smooth = 1`，其 `updated_at = 15:07:52Z`（= **23:07:52 CST**，即**本次读取前 5.6 分钟**，早于本车道任何操作）。

推理（**不猜测**，只做时间窗收窄）：`updated_at` 只反映**最后一次**写入 ⇒
- `smooth=0` 的写入发生在 **tester-046 基线之后、tester-049 首次读取之前** ⇒ 落在 **(12:35Z, 13:26Z] = (20:35 CST, 21:26 CST]** 这 **51 分钟**窗口内；
- 该窗口**早于 049 的观测窗口（21:26 起）** ⇒ **049 窗口内的只读操作不可能写入它**（049 报告的「非本次运维所致」成立，且现在能进一步给出时间上界）；
- 而 23:07:52 CST 的这次写入把 `smooth` 变回 `1`（即 049 记录的 `smooth=0` 状态**已被后续写入覆盖**）。
- 本次**无法**给出 `smooth=0` 的精确时刻（表内只有单一 `updated_at`，无审计表/无请求日志；日志目录不含 PUT 记录）。

**⚠️ 并发外部写入（必须上报的事实）**：在**本车道探针运行期间**，该行又被改了一次 ——

```
第 2 次读取（23:23:29 +0800 = 15:23:29 UTC）
key  | value                                                                              | updated_at
dcap | {"m":3,"n_l":60,"n_m":26,"n_s":8,"r_l":1.02,"r_m":1.0,"r_s":1.0,"smooth":1}         | 2026-09-13 15:18:59.759956+00   (= 23:18:59 +0800)
```
- 变化：`r_l 1.0 → 1.02`，`updated_at` 前移到 **23:18:59 CST**（在我第一次读取后 5.5 分钟）。
- **不归因于本车道**：本车道所有页面请求中，**非 GET 一律被拦截**（`probe*.json` 的 `nonGetOther` 全为空数组）；共 10 条 `PUT /api/config/dcap` 全部由 Playwright `route.fulfill` **本地兑现**，其请求体分别为 `r_s:1.2 / m:5 / r_m:1.5`，**没有任何一条包含 `r_l:1.02`**；DB 侧也无本车道可用的写路径。
- 旁证：机器上有一个**长期存活的 headless chromium（`--remote-debugging-port=9222`，profile `/tmp/greedysearch-chrome-profile`，已运行 ~9.6 天）**，可对线上 UI 发真实请求 ⇒ 存在**其他车道/人**经 UI 写 `/api/config/dcap` 的可能。**本报告只陈述事实，不做归属断言。**
- 对本车道结论的影响：**无**（复现/定位都在本地兑现的 PUT 上完成；探针页面 mount 时读到的基线参数已逐条记录在 `putIntercepted` 里，可复核）。对**其他车道**的影响：`smooth/r_l` 的现场值仍在变动，凡以 `/api/config/dcap` 现场值为基线做「不变性」断言的验收，都可能被这次外部写入打成假红。

---

## 8. 明确未做 / 边界

- **未修改任何产品代码、接口、架构**；`web/` 下仅**新增** 1 个测试文件 `web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`。
- 未 kill/重启/改配置 8081/8082（PID 2102695 未动）；未改线上 `web/dist`；未用 deploy 脚本；未动 8080/5433 容器。
- 未 `git add/commit/stash`（`git diff --cached --name-only` 为空；tracked 改动 0）。
- 仓库内未跑 tangle；未改 `design/14-dcap-indicator/*` 的 `file=` 块。
- DB：**仅 SELECT**（2 次 `\d` + 2 次 `SELECT`），无任何写语句。
- 未实现/未验证修复（沙箱候选修复只用于证明「红测试可转绿 + 既有测试影响面」，副本已删除，仓库零改动）。
- 未启用覆盖率工具 ⇒ 本报告无覆盖率数字。
- 临时资源已收尾：`vite preview`(18085) 已 kill、端口已释放；`web/node_modules/.diag51/` 已删除；无残留 playwright chromium 进程。

---

## 9. 逐项结论

| # | 派单项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 复现缺陷（pane 高度被重置，量化） | ✅ | A：VOL 237→100（−137px，主图 460→597）、pane id 更换；C：VOL 145→100、DCAP 192→100；截图 A1/A2/C1/C2 |
| 2 | 精确定位销毁点（A/B/两者） | ✅ **两者都有** | A：deps `[props.indicators, props.maWindows, props.dcapParams]` effect → `syncIndicators`（burst 无 `setDataLoader/setSymbol`、`__KC_INITS__` 不变、仅 dcapParams 变）；B：`n_l`/`m` → warmup → feed 重建 → `init+1`、pane 全换（probe5 全量序列） |
| 3 | `overrideIndicator` 能力核实 | ✅ 可行 | 6 条 pane 高度逐值不变、id/指标集合不变、DCAP 线值与 Y 轴量程变、canvas 像素变、无 init、无新取数；MA（candle_pane）/VOL/MACD 同类适用；负控：未启用/不存在指标不创建 ⇒ 开关仍靠 create/remove；返回值恒 `false` 不可作判据 |
| 4 | 红测试（位置 + 当前红） | ✅ | `web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`（1 红 + 1 守卫绿）；`npx vitest run` 全量 564 中唯一失败即它；`tsc -b` 干净 |
| 5 | 最小修复提案 + 副作用面 | ✅ | §5（两步：`syncIndicators` 状态差分 + 断开 warmup↔feed 身份；已用沙箱副本预演转绿）/ §6（勾选、MA 窗口、DCAP 开关、ADR-020、首次建 pane 默认高度逐项） |
| 6 | 只读 DB 查证 | ✅ | `updated_at = 2026-09-13 15:07:52.814854+00 (= 23:07:52 +0800)`，`value` 全文 8 参 `smooth=1`；`smooth=0` 写入窗 = **(20:35, 21:26] CST**（早于 049 观测窗）；并额外发现**探针期间第三方写入**（`r_l→1.02` @ 23:18:59 CST，非本车道） |

## 10. 最小修正建议（交架构师裁决）

1. **【必需】** 按 §5 第 1 步把 `syncIndicators` 改为状态差分（参数变化走 `overrideIndicator`）——解决路径 A；同时更新 2 条既有 MA churn 断言，且**不要**依赖既有桩缺失的 `chart.getIndicators`（否则 44 条红）。
2. **【必需】** 按 §5 第 2 步断开 `warmup → feed 身份`（方案 ① 首选，方案 ② 兜底）——否则改 `n_l`/`m` 仍会整图重建、布局仍被重置。
3. **【建议】** 补一条 e2e/观测痕迹（`data-dcap-sync` 或等价），把「保存参数无 create/remove」变成线上可断言事实。
4. **【勘误·跨车道】** 线上 `/api/config/dcap` 现场值在 23:07:52 / 23:18:59 CST 被**外部**改写（`smooth→1`、`r_l→1.02`）；凡以该现场值为「不变性」基线的验收请先重新取基线，避免假红。

**VERDICT: DIAGNOSED**
