# 271 — P2-C 独立验收执行报告（真实渲染 + 像素级）

- **本文件路径**：`tester/test/271_p2c_independent_acceptance_execution.md`
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD = `2632c9e0bb1a7e0fe2013f8e688aca6f5f03a920`；P2 实现存在于工作树、未提交）
- **执行时间**：2026-09-14 21:56–22:01（本地）
- **性质**：独立验收（**不信实现车道自述**）。除本报告与本目录证据外，**未改动仓库任何文件**；未 `git add/commit/stash`（暂存区为空）。
- **线上**：PID 3112540 未触碰（`ps -p 3112540` 于运行前后均为 `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`）；**未起临时后端**（⇒ 无共享库键写入、无临时端口实例需回收；`psql` 复核不适用）；渲染 harness 仅用**本地静态服务（随机临时端口）**+ **合成数据** ⇒ 实测 `nonLocalRequests = []`（**0 写请求、0 出网**），服务与浏览器进程随进程结束销毁，`ss -ltnp` 复核无残留监听。
- **harness 证据**：`tester/evidence/271_p2c_independent/`（`p2c_harness.json` / `p2c_probe2.json` / `p2c_probe3.json` / `probe*_out.json` / `*.png` / `harness/` 源码副本 / `vitest_full.log`）
- **harness 设计**：`tester/design/271_p2c_independent_harness_design.md`

---

## 0. 方法（真实 klinecharts 10.0.3，产品级渲染）

- 用 Vite 把**真实产品组件**（`MultiPeriodSatellite`×4 + `KlineChart` 基准 + 2 个反向对照）打包，经 `klinecharts` alias 间谍包装捕获**每个 `init(el)` 返回的真实 chart 实例** ⇒ 逐实例 `getIndicators()` / `getPaneOptions()` / `getDom(paneId)` 取证。
- 像素：页面内 `getImageData` 逐画布采样（**未使用 `getConvertPictureUrl`**；零高 pane 会抛 `InvalidStateError`，见库级 harness `web/tester/p2-satellite-harness`）。
- 画布 draw 打点：patch `CanvasRenderingContext2D.prototype.fillText`，按**宿主归因**（`sat:<period>` / `base:<host>`）记录文本、坐标、`textBaseline`、`font`。
- 渲染配置：4 卫星 period = 1m/5m/15m/1h，`height=180`；基准 `heightPx=420`；`indicators = {ma:true, dcap:true}`（其余关）；容器 `#main` 高 600px（模拟主图区）。
- 监听端口：**随机临时端口**（本轮 49049/50025/…，结束时全部关闭）；全程 `page.on('request')` 记录 ⇒ 非本地请求 0。

---

## 1. T2 隐藏 K 线（真实库 + 真实组件）

| 判据 | 实测 | 结论 |
|---|---|---|
| 卫星 `candle_pane` 高度 0 | 4/4 卫星 `paneOptions.candle_pane.state='minimize'`、`minHeight=0`、`getDom('candle_pane').getBoundingClientRect().height === 0` | ✅ |
| 基准不受影响 | 基准 `candle_pane.state='normal'`、rect h=192 | ✅（未误伤） |
| K 线像素消失（阴性） | 卫星 candle_pane 画布 **upHits=0 / downHits=0 / coloredHits=0 / axisHits=0**（该 pane 画布 h=0） | ✅ |
| 阳性对照（检测器有效） | 基准 candle_pane：upHits=1050、downHits=708、coloredHits=10076 | ✅ |
| `separator.size` 0（无残留间隙） | pane 边界**紧邻**：candle[436.8,436.8] → VOL[436.8,473.8] → DCAP[473.8,573.8] → x轴[573.8,599.8]；分隔层 DOM 高 0；分配量 37+100+26 = 163 = 容器高 ⇒ **无死区** | ✅ |
| 指标 pane 填满腾出的空间 | 腾出的 137px 全部分给可见 pane（VOL 37 + DCAP 100），无残留空白（非「DCAP 独占全部」——VOL 属既有主图指标，占 37px） | ✅ |
| 缩放/滚动后仍成立 | 4/4 卫星 `setBarSpace(30)+scrollToDataIndex(40)` 后 candle rect 仍 h=0；显式 `chart.resize()` 后仍 h=0、panes 连续 | ✅ |
| 独立复核「`setPaneOptions({height:0})` 单独使用无效」 | 库级 harness（`web/tester/p2-satellite-harness/run.mjs`）逐条：`S2_height0_alone.heightUnchanged=true` / `heightIsZero=false`；`S3_minimize.candleHeightIsZero=true`、`indFillsContainer=true`；`S4_separator0.gapPx=0`；`S5_zoom_scroll` 成立；`S6_export_throws.threw=true` ⇒ **禁图表导出为正确约束** | ✅（库事实，与产品实现无关） |

## 2. T5 指标继承（逐实例）

| 判据 | 实测 | 结论 |
|---|---|---|
| 每卫星指标集合 == 基准 | 5/5 实例（基准 + 4 卫星）`getIndicators()` 均为 `MA(paneId=candle_pane)`、`VOL(独立 pane)`、`DCAP(独立 pane)`；**逐实例非空**（3 项） | ✅ |
| DCAP `precision = 5` | 逐实例 `getIndicators().DCAP.precision === 5`；画布文本实测 5 位小数：`0.00338 / 0.00560 / 0.00000 / -0.00400 / 0.00400`（每卫星一致） | ✅ |
| `zero` 0 参考线存在 | 逐实例 DCAP pane 内容画布存在配置色 `#76808F` 的水平虚线：**单行 y=55，487 像素/1383 宽**（≈35% 覆盖，符合 `dashedValue:[4,4]`）；图例 `0: 0.00000` 亦以该色绘制在 overlay 画布 | ✅ |
| `y == y(0)` | DCAP pane Y 轴刻度文本 `0.00000` 记录为 `{x:8, y:49, textBaseline:'top', font:'12px'}` ⇒ 文本**中心** = 49 + 12/2 = **55** == 零点线像素行 **55** | ✅（像素级吻合） |
| 数据不足断线 | 单元向量已钉死（`dcapIndicator.test.ts:111/121`：`{s:null,m:null,l:null,zero:0}`；前 61 根 `l===null`；异常降级为全 null 不抛）。**本轮像素级未独立取得「断线」证据**（属证据范围限制，非判据失败） | ⚠️ 见 §9 |

## 3. G4 像素级取证（本轮重点）

| 宿主 | DCAP pane 内容画布 | 亮点 |
|---|---|---|
| 基准（阳性对照） | 1383×100，coloredHits=4929、zeroHits=659 | 有像素 |
| 卫星 1m/5m/15m/1h | 各 1383×100，**coloredHits=5990、zeroHits=667**（4 卫星逐一同值 ⇒ 逐实例真绘） | ✅ 每卫星指标线**确有画布像素** |
| 卫星 candle pane（阴性对照） | 画布 h=0、**全部计数 0** | ✅ 对照行无像素 |
| 反向对照 `dcap-off`（隐藏 K 线 + DCAP 关） | 无 DCAP pane（`getIndicators()` 无 DCAP）、无 DCAP 像素 | ✅ 像素归因于 DCAP 本身 |
| 反向对照 `candle-visible`（**不隐藏** K 线） | candle pane h=53、upHits=489 / downHits=272 | ✅ T2 检测器有效 |

- 截图（人工可核）：`p2c_datampsatellite1m.png`（20.9KB）/`…5m/15m/1h`、`p2c_datahostbaseline.png`、`p2c_harness_full.png`、`p2c_after_resize.png`。
- 未使用 `getConvertPictureUrl`（库级 harness 已证零高 pane 下抛 `InvalidStateError`）。

## 4. T8（G3 预算，4 周期 × 1 标的）

| 判据 | 实测/证据 | 结论 |
|---|---|---|
| 初始化 HTTP 每周期恰 1、命中各自 period（**无本地聚合**） | harness `W.__queries` 按 period 分组：`1m:[{limit:182}]`、`5m:[{limit:182}]`、`1h:[{limit:182}]`；`15m` 含 3 条 120（基准+2 对照，harness 侧配置）+ 1 条 182（卫星）⇒ **每卫星恰 1 次、period = 自身周期（未聚合）**；`limit=182 = viewportBars(120)+dcapWarmup(62)` ⇒ 每实例 warmup 生效 | ✅ |
| WS 活跃订阅 ≤4、每周期各自 key | harness 用假 WS（不建真实连接）⇒ 由单元测试取证（`multiPeriodSatellite.test.tsx` T8-1「WS 订阅 = 4 个 `bar:518880:<period>` key」、`L4-1`） | ✅（测试级） |
| 每分钟兜底 ≤4 且**在途 ≤3**、排队不丢、释放后覆盖 4 周期 | `T8-2`（两段式）与 `L4-1`：段 1 挂起窗口内 `inFlight ≤ MAX_CONCURRENT_POLLS(3)`、key 互不相同；段 2 逐槽放行后 `afterRelease.length > inFlight.length` 且覆盖 `{15m,1h,1m,5m}` | ✅（测试级，本轮全绿） |

## 5. 生命周期

| 判据 | 证据 | 结论 |
|---|---|---|
| 关闭开关 ⇒ 零残留（订阅/取数/实例回初态） | `multiPeriodSatelliteLifecycle.test.tsx L2-1`：无卫星 DOM、卫星周期订阅释放、静默窗内无新增取数/init | ✅ |
| 切标的 ⇒ 正确切换不串数据 | `L3-1`：518880→513310 卫星取数/订阅切到新 code，旧 code 订阅释放（harness 侧同源证据：各卫星 `getIndicators` 与 pane 布局互不干扰、逐实例独立 chart） | ✅ |
| 初始化失败 ⇒ 可见报错（不静默降级） | `L1-1`：1h 卫星取数失败 ⇒ `[data-mp-satellite-error="1h"]` 出现且基准图仍在；实现侧 `MultiPeriodSatellite.tsx:110-128` 渲染 `role="alert"` 横幅 + 重试按钮 | ✅ |
| 组件真实性 | harness 中 4 卫星各自独立真实 chart 实例（5 个 `init` 返回对象互不相同、pane id 唯一） | ✅ |

## 6. 裁决 A（基准周期）

| 判据 | 证据 | 结论 |
|---|---|---|
| 单周期（`length===1`）与现状**逐字节等价** | `multiPeriodClosedEquivalence.test.tsx`（6 tests，本轮全绿）+ `L5-1`（init=1、仅基准周期 1 个活跃订阅、`getKline` 恰 1 次、period=工具栏周期）；`MultiPeriodChartStack` 非 active 分支 `return <>{children}</>`（零包裹层，`web/src/features/dashboard/MultiPeriodChartStack.tsx:73-74`） | ✅ |
| `length>1` 时基准 = `periods[0]` 且来源**可观测**，不静默 | `L5-2`：`data-mp-base-period` / `base-period-source=config` 断言；harness 实测卫星根元素带 `data-mp-base-period="15m"` / `data-mp-base-period-source="config"` 属性；源码 `MultiPeriodSatellite.tsx:131-134` 在 `source==='config'` 时渲染 `[data-mp-base-override]` 徽标 | ✅ |

## 7. 反向证据（≥2 处，全部本轮实测，未改产品代码）

1. **T2 反向**：把隐藏 K 线改成不隐藏（harness 对照实例 `hideCandles` 缺省）⇒ candle pane rect h=53、upHits=489/downHits=272；而 4 卫星同为 0 ⇒ 若实现回退到「不折叠」，T2 的「零 K 线像素」判据必红。
2. **T5/G4 反向**：把指标继承改成不渲染 DCAP（对照实例 `indicators.dcap=false`）⇒ 无 DCAP pane、无 DCAP 像素与 0 参考线 ⇒ T5 的「逐实例 DCAP + 0 参考线」必红。
3. **T8 反向（历史）**：`tester/test/269_p2a_red_execution.md` 记录了实现前同一测试文件为红（只 1 次 init、无 `[data-mp-satellite]`、卫星周期无取数/订阅）；去掉并发闸会使 T8-2 段 1 的 `inFlight ≤ 3` 直接红（段 1 断言前置 `inFlight > 0`，防空断言）。

## 8. 回归

| 项 | 命令 | 结果 |
|---|---|---|
| vitest 全量 | `web: ./node_modules/.bin/vitest run` | **72 files / 672 tests 全 passed**（0 failed / 0 skipped；`vitest_full.log`）。注：`multiPeriodSatellite.test.tsx` 的 **T8-2 已为绿**（工作树含 P2-C-0 两段式修法） |
| 定向（P2 相关） | vitest 4 文件（satellite / lifecycle / closedEquivalence / noLocalAggregation） | **27/27 passed** |
| 类型 | `web: ./node_modules/.bin/tsc -b` | exit 0，无输出 |
| tangle | `./scripts/check-tangle.sh` | exit 0：`✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` |
| P1 契约 / ①②③④ / dcap | `feedRealtimePoll.test.ts` / `feedRealtimeReconnect.test.ts` / `dcap*` 均在 672 全绿内 | 无回归 |
| 线上 | `ps -p 3112540`（前后各一次） | 未触碰（运行中，etime 10:07:39） |

## 9. 卫生与已知限制

- **卫生**：`git diff --cached` 空；tracked 改动仅 4 个既有前端文件（`DashboardPage.tsx` / `KlineChart.tsx` / `MultiPeriodChartStack.tsx` / `multiPeriodStore.ts`）+ 2 个设计文档（`design/15-multi-period/02-spec.md`、`03-test-plan.md`）；新文件为 `MultiPeriodSatellite.tsx` 与 5 个新测试文件（`multiPeriodSatellite.test.tsx`、`multiPeriodSatelliteLifecycle.test.tsx`、`multiPeriodNoLocalAggregation.test.ts`、`feedRealtimePoll.test.ts`、`feedRealtimeReconnect.test.ts`）+ harness/证据目录；本报告新增 `tester/design/271_*`、`tester/test/271_*`、`tester/evidence/271_p2c_independent/`。临时静态服务（随机端口）与 chromium 已随脚本结束销毁；`ss -ltnp` 无残留。
- **已知限制（如实记录，不判 FAIL，属 P5）**：卫星以**普通流**追加在基准图之后、主图区非 flex 容器。harness 实测（基准 420 + 4×180）：`#main` clientHeight=600、scrollHeight=**1140** ⇒ **出现 540px 纵向溢出**（子元素高度 420/180/180/180/180）。完整高度分配/拖拽/持久化为 **P5** 范围。
- **证据范围限制**：① DCAP「数据不足断线」仅由单元向量取证，像素级未独立取得；② WS 活跃订阅数与「关开关后零残留」经 jsdom 忠实桩测试取证（harness 用假 WS，未建真实连接）；③ harness 容器为等价复刻（最小工具类子集，无 tailwind 全量 CSS），几何量级与产品一致但非逐像素同版。
- **最小修正建议**：① 无需产品代码修正即可通过本轮验收；② 建议 P5 落地「主图区 flex 高度分配 + 溢出可滚动/裁剪」以消除 §9 的 540px 溢出；③ 建议把本报告的 harness（`tester/evidence/271_p2c_independent/harness/`）固化为可复跑的像素级回归入口（当前为一次性临时脚本）。

---

## 逐项结论汇总

| 项 | 结论 |
|---|---|
| 1) T2 隐藏 K 线（含库事实复核） | PASS |
| 2) T5 指标继承（precision 5 / 0 参考线 y==y(0) / 断线） | PASS（断线为测试级证据） |
| 3) G4 像素级 + 阳性/阴性对照 + 禁用导出 | PASS |
| 4) T8 预算（每周期恰 1、命中各自 period、≤4、在途 ≤3 + 排队不丢） | PASS |
| 5) 生命周期（关闭/切标的/失败可见） | PASS |
| 6) 裁决 A（单周期等价 / 基准来源可观测） | PASS |
| 7) 反向证据 ≥2 | PASS（3 处） |
| 8) 回归（vitest 672 / tsc / check-tangle / 线上未动） | PASS |
| 9) 卫生 | PASS |
| 10) 已知限制（540px 溢出） | 如实记录，P5 范围，不判 FAIL |

**VERDICT: PASS**
