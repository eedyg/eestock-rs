# 250 — 多周期指标框架架构分叉取证 P7a–P7e · 执行报告

- **本报告位置**：`tester/test/250_multiperiod_route_probe_execution.md`
- **类型**：Execution report（执行本调查**新设计并编写**的探针用例；含执行结果）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e2a04ee`
- **运行时间（UTC）**：2026-09-14 18:08–18:13（时间盒内）
- **引擎**：klinecharts `10.0.3`（`web/node_modules/klinecharts/dist/umd`），Playwright Chromium，`file://` 本地页
- **只读证据**：未改仓库源码；未 git add/commit/stash；**0 个网络请求**（全部合成数据）；未重启 PID 3112540。
- **证据目录**：`tester/evidence/250_multiperiod_route_probe/`
- **设计报告**：`tester/design/250_multiperiod_route_probe_design.md`

## 0. 运行汇总

| 探针 | 命令 | 结果 |
|------|------|------|
| P7a/P7b(初)/P7c/P7d | `node run.mjs`（`p7.html`） | PASS，`errors: []`，`p7_result.json` |
| P7b 聚焦重做 | `node runb2.mjs`（`p7b2.html`） | PASS，`errors: []`，`p7b2_result.json` |
| P7a/P7b 可视产出 | `node runview.mjs`（`p7view.html`） | PASS（截 3 图；`getConvertPictureUrl` 在零高 pane 抛错，另记） |
| MA 叠加 quirk | `node runma.mjs`（`ma.html`） | PASS，1 处异常（见 P7c） |

无崩溃、无 core dump。

---

## P7a 隐藏 candle pane —— **可行**

**结论：路线②前提成立**，但必须用 `state:'minimize'`，`height:0` 无效。

| 手段 | 结果 | 证据 |
|------|------|------|
| `setPaneOptions({id:'candle_pane',height:0})` | **无效**。`paneOptions.height` 变 0，但 DOM rect 高度仍 393px，指标 pane 位置不变 | `p7_result.json: p7a.attempt_height0`（rectCandle height 393 / rectInd top 400 / domGap 1） |
| `setPaneOptions({id:'candle_pane',state:'minimize',minHeight:0})` | **有效**。candle pane rect 高度 = **0**；指标 pane 成为 flexible pane 填满剩余高度（493px） | `p7a.attempt_minimize`（rectCandle 6→6 height 0；rectInd 7→500 height 493）；`p7view_result.json: hiddenCandle.candle=0` |
| `setStyles({separator:{size:0}})` | 残留分离条 **1px → 0px** | `p7a.attempt_minimize_sep0`（domGap 0） |
| 拖拽/缩放后残留空隙 | **无**。`zoomAtCoordinate(1.6)`+`scrollByDistance(-180)` 后 candle 仍 0 高、gap 0、布局稳定 | `p7a.afterZoomScroll`（rectCandle height 0；rectInd top 6 高 494；domGap 0；visible realFrom 349 realTo 404） |
| 还原 | `state:'normal'` 还原 candle 到 394px | `p7a.restoreNormal`（rectCandle height 394） |
| 指标 pane 是否占位/自标度 | 占满全高；Y 轴按外部序列自标度 `[-0.2437, 2.9244]`，`minValue:0` 生效 | `p7a.yAxes` |
| 指标是否真渲染 | 是。`p7a_hidden_candle.png`（820×520，741 色，非空白） | 截图文件 |

**源码佐证**（只读）：`index.esm.js:15421` `if (isNumber(options.height) && options.height > 0)` —— 显式拒绝 `height<=0`；`index.esm.js:14792-14838` 布局中 `state==='minimize'` 的 pane 直接取 `options.minHeight`，flexible pane 回退到首个 `state==='normal'` 的 pane。

**× pane 共享 x 轴**：同一 ts `convertToPixel().x` 两 pane 相等（`-1228 == -1228`）→ `p7a.xSharedPixels`。
**Y 轴独立**：指标 pane 有独立 `yAxisId` 与独立 range（`p7a.yAxes`）。⚠️ 隐藏态下 candle pane 高度为 0，`value=9` 的 y 像素（0 vs -947）不是有效的“独立 Y”证据；此点沿用 P1-T2 既有真渲染证据（`tester/evidence/200_multiperiod_feasibility/harness_result.json`）。

**副作用（新发现）**：存在零高 pane 时 `getConvertPictureUrl()` 抛 `InvalidStateError: ... canvas element with a width or height of 0`（`p7view` 运行原始输出）。若走路线②需要导出/快照，须先临时还原 candle pane。

---

## P7b 跨实例时间轴同步 —— **可行，但需自建原语且跨周期为近似对齐**

**公开 API 快照**（`p7b2_result.json: api` / `p7_result.json: p7b.api`）：

| API | 存在 |
|-----|------|
| `getVisibleRange` / `getBarSpace` / `setBarSpace` / `getOffsetRightDistance` / `setOffsetRightDistance` / `subscribeAction` / `unsubscribeAction` | ✅ function |
| `scrollToTimestamp` / `scrollToDataIndex` / `zoomAtTimestamp` / `zoomAtDataIndex` / `scrollByDistance` / `scrollToRealTime` | ✅ function |
| **`setVisibleRange`** | ❌ **undefined（不存在）** |

**事件**（`p7_result.json: p7b.eventsA/rangeEventA`）：`onScroll` payload `{distance}`，`onZoom` payload `{scale}`，`onVisibleRangeChange` payload `{from,to,realFrom,realTo}`，均实际派发。

**实测对照**（`p7b2_result.json`）：

| 场景 | A 可见跨度 | B 可见跨度 | 判定 |
|------|-----------|-----------|------|
| 同周期（1m vs 1m）+ `scrollToDataIndex(300)` | 51min | 51min | **完全一致**，`getVisibleRange` 逐字段相等（`exactEqual:true`） |
| 跨周期（1m vs 15m）**仅** `scrollToTimestamp` | 51min | 330min | **不对齐（≈15×）** |
| 跨周期 + `barSpace_B = barSpace_A×(P_B/P_A)`（8→120）+ ts 对齐 | 51min | **60min** | 近似对齐，误差 = 1 根高周期 bar（15min）量化；共享 ts 像素 A 410 vs B 338（72px 偏差，源于 `scrollToTimestamp` 吸附到 15m bar 边界） |
| 1m vs 1w（ratio 10080，需 barSpace 80640） | 51min | **10080min（仅 1 根 bar）** | **退化**：高周期 pane 只显示不到一根 bar |

其他实测：
- **`barSpaceLimit` 陷阱**：默认 `barSpaceLimit.max = 50`（`index.esm.js:13249,13667`），`setBarSpace(120)` **静默吞掉**（`getBarSpace()` 返回 `NaN`→JSON null；见 `p7_result.json: p7b.spanAfterCrossPeriod`）。必须在 `init(...,{layout:{barSpaceLimit:{min,max}}})` 放开上限（本报告用 min 0.1 / max 2e5 实测生效）。
- **漂移**：20 次 ts-only 镜像后 A/B 跨度不变（51 / 60），**无累积漂移**（`p7b2.drift20`）。
- **反馈回路**：A 单次滚动即产生 evA=1、evB=1、`reentrantCalls=1` → **存在回边**（目标实例的 `scrollToTimestamp` 会重新进入源的 `onScroll`）。必须用抑制标志/单向同步/去抖；未加保护的双向镜像会乒乓。
- **性能**：50 次同步调用同步耗时 0.2ms（布局异步合并），单次 ≈0.004ms（`p7b2.syncPerf_50ops_ms`）；真实成本在布局帧，非同步调用。

**失败模式清单（实测）**：`setVisibleRange` 缺失；默认 barSpace 上限吞掉大倍率；跨周期只能按高周期 bar 量化（≤1 根高周期 bar 误差）；1m↔1w 退化；双向镜像有回边；`scrollToTimestamp` 对非整 bar 时间戳会吸附。

---

## P7c 成本与「白送」—— **内置指标确实白送，自研模板零改动可复用**

- **宿主内置指标名单**（`getSupportedIndicators()`，27 个）：`AVP,AO,BIAS,BOLL,BRAR,BBI,CCI,CR,DMA,DMI,EMV,EMA,MTM,MA,MACD,OBV,PVT,PSY,ROC,RSI,SMA,KDJ,SAR,TRIX,VOL,VR,WR`（+探针注册的 P7EXT）。→ 「将来任何内置指标白送」成立的前提是**指标由宿主编译进 bundle**（本仓库即 klinecharts 自带集）。
- **零注册即可显示**：4 个实例（1m/5m/15m/30m）各自 `createIndicator(MACD/KDJ/BOLL)` 返回 id 且出现在 `getIndicators()`、有独立 paneId/yAxisId（`p7c.perInstance`）。**无需任何前端注册**。
- **自研模板零改动复用**：同一 `P7EXT`（读 `indicator.extendData`）在 4 实例各 `createIndicator(..., true)` 带各自 `extendData`，`calc` 各自被调用且 `extendData` 长度独立（80/400/399…），无需改动模板（`p7c.calcCallsPerInstance`）。→ 现有 DCAP 模板（`web/src/features/indicators/dcapIndicator.ts`）在路线②可零改动逐实例挂载。
- **成本量级**：4 实例×5 指标创建 166.7ms；4 实例 reset+重载 233.2ms（headless 合成 400 bar/实例，**仅量级参考**）。堆内存 `performance.memory` delta=0（headless 未启用精确内存，**不可用，标注未证实**）。
- **⚠️ 异常（未证实根因）**：`createIndicator({name:'MA',calcParams:[5,10,30],paneId:'candle_pane'})` 返回非空 id，但 **MA 不出现在 `getIndicators()` 也不渲染**；同 pane 的 `EMA`/`BOLL` 正常，`MA` 以 `isStack=true` 放独立 pane 正常，`MA` 省略 paneId 亦正常；当已有另一个 MA 实例时，`MA + paneId:'candle_pane'` 又能出现（`ma.html` 三次运行，`runma.mjs` 原始输出）。属 klinecharts 10.0.3 的 MA + candle_pane 组合 quirk，**根因未查**。

---

## P7d 交互与契约

- **分隔线（是否复现 ① 的分割线问题）**：单实例多 pane 的相邻 pane 之间为 **1px 分离条**（`p7d.route1_singleChart_3indPanes.separatorStrips = [1,1,1,0]`）；路线②每个实例各自带自己的分离条 —— 隐藏 candle 后，每实例残留 **1px**（`p7d.route2_hiddenCandleStrip.domGapPx=1`），可被 `styles.separator.size=0` 清零（P7a-T3）。→ 路线②下分隔线问题**不消失但可消除**，代价是每实例一次样式设置；且注意 N 实例 = N 组独立分离条（DOM 内无类名，需用 `getSize`/rect 度量）。
- **pane 高度记忆**：`setPaneOptions({id,height})` 每实例独立生效；`resize()` 后保持（单实例 opt 123/size 123；4 实例各自 applied 120/size 120）。→ 路线②需**按实例**持久化各自 pane 布局（现状 DCAP 是单实例的存储键）。
- **保存参数/切周期不重置布局**：路线②下对应做法 = 每实例 `overrideIndicator`/`setDataLoader` 独立重算 + 保留各自 pane 高度；参数共享仍在应用层（8 参数只换 period），与实例数无关。未在浏览器内对「切周期」做完整实测 → **标注为设计推断，未完全证实**。
- **overlay/WS/每分钟兜底**：本探针**未实测**（只看引擎层）。**未证实**：N 实例下是否会 ×N 需要看 `web/src/features/dashboard/realtimePoll.ts` 的既有按 (code) 限流能否扩为按 (code,period) 合并；此为静态判读，未运行。

---

## P7e 路线①重实现代价（粗估，源码清点）

- 宿主口径：`crates/backtest/src/indicators.rs`（327 行）提供 `ma/ema/rsi/macd/kdj/boll/atr`，`Indicators::new(bars,index)` 逐 bar。
- 前端现状：`web/src/features/indicators/dcap.ts`（182 行）+ `dcapIndicator.ts`（202 行）= 已把 DCAP 口径移植到 TS。
- 若走路线①：为 **MA/EMA/RSI/MACD/KDJ/BOLL（+SAR/ATR 等）** 各写一个「吃外部序列」的模板（约 1 个模块 ~400–600 行或 7 个小文件），并对齐 Rust 口径。
- 对齐手段：**黄金样本**——Rust 侧测试导出 JSON 向量（现有 `golden_parse` 模式可参照），TS 侧读同一向量做**跨运行时位级/容差断言**（DCAP 已有此模式：`dcap.test.ts` 对遗留值容差 1e-12）。新增文件粗估：指标实现 1、外部序列适配 1、黄金向量生成器 1、TS 断言 1–7。
- 契合「通用框架」的代价：**每来一个新指标都要前端再实现一遍 + 生成黄金样本**，与宿主指标集漂移；路线②则宿主编译进来即白送。

---

## ① / ② 对照表

| 维度 | 路线①（单图多 pane + 外部序列注入） | 路线②（多实例 + 跨图同步） |
|------|-------------------------------------|------------------------------|
| 隐藏 K 线 | 天然（无 K 线需求则不建 candle pane？不可，仍存在，需 minimize） | **可行**：`state:'minimize',minHeight:0` + `separator.size=0`（P7a 实测） |
| x 轴同步 | **天然**（同一实例强制共享，实测同 ts 同 x） | **需自建**：无 `setVisibleRange`；`scrollToTimestamp`+`setBarSpace`+放开 `barSpaceLimit` 近似对齐（P7b 实测） |
| Y 轴独立 | 各 pane 独立（既有 P1 证据） | 天然（每实例独立） |
| 任何内置指标「白送」 | ❌ 内置指标吃不到 `extendData`，须每个指标前端重实现 | ✅ 宿主 27 个内置指标零注册可用（P7c 实测；MA+candle_pane 有 quirk） |
| 自研 DCAP 模板 | 需改造成外部序列版（已具备 extendData 路径） | **零改动**，逐实例挂载（P7c 实测） |
| 新增未来指标 | 前端再实现一遍 + 对齐 Rust 口径 | 宿主编译进来即可（若指标需外部序列仍需少量适配） |
| 跨周期对齐口径 C | 单实例内按桶映射到 K 线网格（P1/P2 已验证） | 跨实例按时间戳/`barSpace` 比例对齐；**误差 ≤1 根高周期 bar**；1m↔1w **退化** |
| 性能/成本 | 1 实例（低） | ≈×N 实例（4 实例创建 167ms / reset 233ms 量级） |
| 风险 | 口径漂移（前端重实现 vs Rust）、工作量大、与宿主指标集不同步 | 同步原语自建、反馈回边、跨周期量化误差、1w 退化、每实例 pane 高度/布局持久化、零高 pane 破坏 `getConvertPictureUrl` |
| 对「通用框架」契合度 | **低**（每个指标都要再实现） | **高**（内置/未来指标白送） |

## 推荐

**走路线②（多实例 + 跨图同步）**，并把下列点纳入设计：
1. 隐藏 K 线：`setPaneOptions({id:'candle_pane', state:'minimize', minHeight:0})` + `setStyles({separator:{size:0}})`；零高 pane 下禁止 `getConvertPictureUrl`（或先临时还原）。
2. 同步原语：以**基准实例为源**单向广播；用 `getVisibleRange` 源 ts 窗口 → 目标 `setBarSpace(源barSpace×(P目标/P源))` + `scrollToTimestamp(目标吸附 bar)`；`init` 时放开 `layout.barSpaceLimit`。抑制标志防回边，去抖/合并帧。
3. 跨周期对齐接受「≤1 根高周期 bar」量化误差；1m↔1w 需产品层处理（1w pane 在 1m 缩放下不足一根 bar → 建议按「>= K线周期 且 目标周期 bar 在视口内≥1 根」过滤，或对高周期强制最小 barSpace）。
4. pane 高度/布局按实例持久化。
5. MA + `paneId:'candle_pane'` 的 quirk 需在实现前复现确认并选规避（用 `isStack` 独立 pane，或省略 paneId）。

**未证实项**：内存量级（`performance.memory` 不可用）；切周期/保存参数在 N 实例下的完整交互（仅设计推断）；realtimePoll/WS 兜底在 N 实例下的合并（未运行）；MA quirk 根因。

VERDICT: ROUTE-2（多实例 + 跨图同步）—— 唯一能兑现「通用框架、任何指标白送」的路线；代价是自建时间轴同步并接受跨周期量化误差与 1w 退化。

## 本报告位置
`tester/test/250_multiperiod_route_probe_execution.md`
