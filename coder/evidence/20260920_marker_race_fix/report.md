# ADR-028 D4.1 买卖标记竞态修复（次序无关重建）—— 实现车道报告

**本报告路径**：`coder/evidence/20260920_marker_race_fix/report.md`
**原始输出目录**：`coder/evidence/20260920_marker_race_fix/raw/`
**起点根因（直接采信，tester 取证）**：`tester/evidence/20260920_t4_flaky_rootcause/report.md` §3.3/§3.5
**唯一生产改动**：`web/src/features/dashboard/KlineChart.tsx`（+95 / −30）
**新增测试**：`web/src/features/dashboard/klineMarkerRace.test.tsx`（4 例）

---

## 判词（一行）

**次序无关修复 = 完成** ｜ **注入验证（`/api/kline` 延迟 1500ms = `/fills` 先到；`/fills` 延迟 1500ms = K 线先到）两种次序 = 全通过**（`data-marker-overlays == 已加载成交笔数 = 44`、真图表 store `fillDot = 44`、截图落盘） ｜ **连续 10 次全量跑 `adr028-features-verify.e2e.ts`（`--workers=1 --retries=0`）= 每次 9 passed / 1 failed（恒为 T0 真身 bundle 锚点常量过期，**非本修复引起、非 flaky**；T4 十次全部 10.9s ⇒ 4.1s 级提前失败 0 次）** ｜ **四 tester 规格 = 全绿**（window-sync 6/6、axis-align-probe 2/2、resize-probe 1/1、features-verify 9/10+T0 见上） ｜ **变异反证 = 有牙**（改回「仅挂载时构建 + 挂载快照」⇒ 同一注入下 `MISMATCH data-marker-overlays=0 want=44` 恒红；恢复后 bundle 与线上**逐字节一致** `56ef4652…`） ｜ **未做项 = ①冻结规格 T0 的 bundle 锚点常量需 tester 更新（本车道禁改 tester 规格）②同类陈旧快照的 `props.code/period`（Effect W）未改，理由见 §6**

> ⚠️ **给 tester 车道的动作项（本车道无法完成）**：`npm run build` 后真身 bundle 由
> `index-xGaRgVd-.js / 8d936e11…` 变为 **`index-BZMgzJCS.js / 56ef46526414735c93f58f159a2659f2a4cfc68d13f47244571d5154b53db13b`**
> ⇒ `web/e2e/adr028-features-verify.e2e.ts` 的 `EXPECT_BUNDLE_NAME` / `EXPECT_BUNDLE_SHA256`（该文件**明写**
> 「构建产物合法变更时须由规格维护者显式更新本常量，不得加 env 旁路」）需由规格维护者更新后，T0 才能复绿。
> 本车道**未触碰**该文件（sha 保持 tester 的 `def97eac0daccd89e54069caddb2d97b9d9733eb20d6858c698274d9c7e58db0`）。

---

## 0. 修复点（**唯一**重建路径：次序无关 + 幂等 + 事件驱动）

**旧路径（根因，tester 已定位到行）**：
`KlineChart.tsx:853`（`feed.loadInitial().then(...)`）与 `Effect M` 各建一次标记：
- `Effect M`（依赖 `[props.overlays, feed]`）在 `/fills` 先到时跑：`feed.bars=[]` ⇒ `snapTsToBars([])===null` ⇒ **建 0 个**；
- 随后 K 线数据到位只触发 `feed.loadInitial().then` 里那次**用挂载渲染的 `props.overlays` 空快照**的重建 ⇒ 仍 **0 个**；
- 此后**无任何重建路径** ⇒ 永久丢失（`data-marker-overlays=0`，页面仍显示「成交合计 44 笔（已加载 44/44）」）。

**新路径（本波）**：

| # | 改动 | 位置 |
|---|---|---|
| 1 | `overlaysRef`（每次渲染同步**最新** props）—— 消灭「挂载快照」；重建路径**只**读 `overlaysRef.current`，不再读任何 `props.overlays` 渲染快照 | `KlineChart.tsx:~608` |
| 2 | `barsGen`（K 线**数据代际**，`useState` + `bumpBarsGen`）—— 事件驱动信号：**初始取数落定**（`feed.loadInitial().then`）、**引擎 DataLoader `getBars` 取到数据**（`init` = 初始/`resetData`/换 run/换周期；`forward` = 向前翻页）、**warmup 真的补取了更早 bar**（`setWarmupBars().then`）三处递增 | `~612 / ~857 / ~1005` |
| 3 | `rebuildOverlays(chart)` = **唯一**重建路径：`removeOverlay({name})` 先清（`fillDot`/`simpleAnnotation`/`simpleTag`/`tradeRange`）⇒ 按**最新**值重建「价位线/区间 + 成交标记」⇒ `setMarkerCount` + `setOverlayEpoch`（高亮按 epoch 重放，精确到笔不受影响）。**只触碰 overlay 层**：不动 dataList / 视口 / barSpace / 指标 pane | `~641` |
| 4 | `Effect M` 依赖面 = **三条重建触发条件**（全部为事件/依赖驱动，**无定时器/无 sleep**）：① `overlaysSig`（overlays **内容**变化）② `barsGen`（数据可用/代际变化）③ `paneLayoutSig`（指标勾选 / MA 窗口 / dcap 参数 / 隐藏 K 线 ⇒ pane 布局变化） | `~932` |
| 5 | `overlaySignature()`（纯函数，导出）：用**内容签名**而非对象身份作依赖 ⇒ 父级「每帧新建数组、内容不变」不会引起重建风暴（幂等：重复触发不累积重复标记） | `~522` |
| 6 | Effect W 里原先「用 `props.overlays` 快照建价位线/区间」被**收敛**进唯一路径（同类陈旧快照一并消灭；见 §6 第 1 项） | `~885` |

**幂等性/次序无关性的机制**：任一侧后到（无论 `/fills` 还是 K 线数据）都会让 `overlaysSig` 或 `barsGen` 变化 ⇒
`Effect M` 重跑 ⇒ 用「最新 overlays + 最新 `feed.bars`」全量先清后建。两侧都到齐后由 `snapTsToBars(feed.bars)`
吸附/钳位出**每笔一个 `fillDot`**。

---

## 1. 判据 a/b —— 注入复现（两种次序，均通过）

注入手段 = **tester 的最小注入**（`page.route` 延迟，**不改生产代码**）；两种次序各自单独跑（同一次同时注入两者会互相抵消，故分开跑）。

```bash
cd web && timeout 300 env E2E_BASE_URL=http://localhost:8081 INJ_KLINE_MS=1500 \
  MARKER_RACE_OUT=<raw>/probe npx playwright test e2e/zz-marker-race-inject.e2e.ts -g "次序①" --workers=1 --retries=0
# 反向：INJ_FILLS_MS=1500（-g "次序②"）
```
（`web/e2e/zz-marker-race-inject.e2e.ts` 为**本车道临时取证规格**，跑完已删；原始输出见 `raw/inject_both_orders.txt`、`raw/probe/*.json`、`raw/probe/*.png`）

| 次序 | 注入生效证据（响应到达差） | `data-marker-overlays` | 真图表 store `fillDot` | 期望（`wb-fills-note` 已加载笔数） | 判词 | 耗时 |
|---|---|---|---|---|---|---|
| ① `/fills` 先到（`/api/kline` **+1498ms** 之后才落定） | `orderDeltaMs = +1498` | **44** | **44**（`getOverlays({name:'fillDot'})`，names=`[fillDot]`） | 44（`成交合计 44 笔（精确源 /fills，已加载 44 / 共 44）`） | **✓ passed** | 1.9s |
| ② K 线先到（`/fills` **−1493ms** 之后才落定） | `orderDeltaMs = −1493` | **44** | **44** | 44 | **✓ passed** | 1.9s |

* **DOM 证据**：`[data-testid="kline-chart"][data-marker-overlays="44"]`（每次均与 `wb-fills-note` 的已加载笔数逐字相等）。
* **像素证据**：`raw/probe/order_kline_delayed.png`、`raw/probe/order_fills_delayed.png`（K 线卡 clip 截图，668×256，含 44 个 B/S 圆点 + 价格×股数标签）。
* **标签证据**（store 读回）：`B 1.292×772.7224 / B 1.272×782.4142 / B 1.295×780.7095` ⇒ 标签口径未变。
* `raw/inject_after_restore.txt`：变异测试恢复源码并重建后，两种次序**复跑仍全绿**（1.9s / 1.9s）。

### 1.1 用 tester 自己的断言路径复验（同注入、同断言）

把**冻结规格逐字节复制**后仅在 `test.beforeEach` 后插入 tester 报告 §3.3 的 **12 行注入**（临时规格，已删）：

```bash
timeout 300 env E2E_BASE_URL=http://localhost:8081 ADR028INJ_KLINE_MS=1500 ADR028V_OUT=<raw>/t4_inject \
  npx playwright test e2e/zz-t4-inject.e2e.ts -g "T4 " --workers=1 --retries=0 --reporter=list
# → ✓ T4 只高亮被点击那一笔 [@mut]：白描边簇恰 1 个且质心落在该笔堆叠位置；3 秒后回落为 0 (12.8s)  → 1 passed
```
（`raw/t4_inject_kline1500_AFTER_FIX.txt`）
对照 tester 修前原文（同注入）：`Error: 跳转后目标笔几何必须可测` @4.4s（红）⇒ **同一注入、同一断言口径，由红转绿**。

---

## 2. 判据 c —— 连续 10 次全量（`--workers=1 --retries=0`）

命令（每次一条，`timeout 600` 前缀，`ADR028V_OUT` 每次独立目录）：

```bash
cd web && timeout 600 env E2E_BASE_URL=http://localhost:8081 ADR028V_OUT=<raw>/runs/rNN \
  npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0 --reporter=list
```

| # | 判词（原始输出） | # | 判词（原始输出） |
|---|---|---|---|
| r00 | 1 failed / **9 passed (45.8s)** | r05 | 1 failed / **9 passed (46.1s)** |
| r01 | 1 failed / **9 passed (45.7s)** | r06 | 1 failed / **9 passed (46.0s)** |
| r02 | 1 failed / **9 passed (45.9s)** | r07 | 1 failed / **9 passed (45.7s)** |
| r03 | 1 failed / **9 passed (45.8s)** | r08 | 1 failed / **9 passed (45.8s)** |
| r04 | 1 failed / **9 passed (45.9s)** | r09 | 1 failed / **9 passed (45.9s)** |

* **10/10 次**：T1–T7 全部通过（**10 × 9 = 90 个断言用例全绿**）。
* **恒 red 的那 1 个 = `T0 真身锚定（bundle sha256）`**，每次 0.4s、原因**确定且与产品逻辑无关**：
  我按判据 g 执行了 `npm run build` ⇒ 被服务 bundle 变为 `index-BZMgzJCS.js`（新 sha），
  而冻结规格的 `EXPECT_BUNDLE_NAME/SHA256` 是**构建前**的常量，且该文件**明写禁止** env 旁路/放宽、要求**规格维护者显式更新**。
  本车道禁改 tester 规格 ⇒ 需要 tester 更新常量（见报告开头动作项）。**这不是回归、不是 flaky**：
  T0 在修复前对旧 bundle 是绿的（tester 12/12 已证），修复后只对**新** bundle 锚点失配；
  `served == web/dist 本地文件逐字节一致` 与 `web/dist/index.html 引用同一 bundle` 两条**仍恒绿**。
* **耗时分布（每次逐用例，`raw/runs/timings.txt`）**：T0 0.4 / T1 1.7–1.8 / T2 1.3–1.4 / T3 1.7–1.8 /
  **T4 10.9 ×10（min=max=10.9）** / T5 6.9–7.0 / T6a 1.6–1.7 / T6b 1.6–1.7 / T6c 15.8–15.9 / T7 3.1–3.2（秒）。
  ⇒ **历史异常档 4.1s 出现 0 次**（10/10 次 T4 均为 10.9s；修前正常档 13.6–13.9s ⇒ 竞态消失后不再有「等不到标记直接死」的档）。

---

## 3. 判据 d —— 四个 tester 规格（全绿）

```bash
cd web && timeout 600 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/<spec>.e2e.ts --workers=1 --retries=0 --reporter=list
```

| 规格 | 判词 | 原始输出 |
|---|---|---|
| `adr028-window-sync.e2e.ts` | **6 passed (23.6s)**（E1/E2/E3/E4 + M1/M2 变异防线） | `raw/three_specs_after_fix.txt` |
| `adr028-axis-align-probe.e2e.ts` | **2 passed (43.6s)**（P1 配对 ≤2px 六态 + P2 降级披露） | 同上 |
| `adr028-resize-probe.e2e.ts` | **1 passed (36.2s)**（指标入口/副图拖拽/卡片高度/拖高后对齐 ≤2px） | 同上（原始 JSON 亦在 `raw/<spec>_out/`） |
| `adr028-features-verify.e2e.ts` | **9 passed / T0 failed**（见 §2 说明；T0 = bundle 锚点常量过期，需 tester 更新） | `raw/runs/r00.txt` … `r09.txt` |

**无回归佐证（本修复不触碰的既有行为，均由上述规格在真身下复验）**：跳转高亮（T4 白簇恰 1 个 + 质心 ±3px + 3s 回落）、
圆点+价格×股数标签与同 bar 堆叠（T1/T2）、指标切换后 pane 高度保持与卡片拖高/复位（resize-probe 的
`dragBefore/dragAfterGrow` 读数）、窗口联动与对齐 ≤2px（window-sync E1–E4 + axis-align-probe P1）、
四张曲线 PAD 单源（axis-align-probe P1 配对口径）。

---

## 4. 判据 e/f/g —— 类型检查 / 单测 / 构建 / 变异反证

| 判据 | 命令 | 结果 |
|---|---|---|
| e1 | `npx tsc -b`（web/ 下） | **exit 0** |
| e2 | `npx vitest run <19 个相关文件> --maxWorkers=1`（`NODE_OPTIONS=--max-old-space-size=2048`） | **19 files / 156 tests passed**（含新增 4 例；覆盖 KlineChart 全系 + dcap warmup/接线 + volToggle + indicator 防线 + adr028FocusHighlight + resultWindowSync/ResizeIndicators/BarSpaceLimit/AxisIndex/roundTripLayers + WorkbenchPage/ResultView） |
| g | `npm run build`（`tsc -b && vite build`） | **exit 0**；产出 `dist/index.html` 引用 `/assets/index-BZMgzJCS.js` 且该文件存在（引用一致）；`:8081`（`static_dir=./web/dist`）实测同源：`curl -s localhost:8081/ \| grep -o 'assets/index-.*\.js'` == `assets/index-BZMgzJCS.js`，sha256 == `56ef4652…` |
| f | 变异：把重建路径改回「**仅挂载时构建 + 挂载快照**」（`if (mutantMounted.current) return; … createMarkerOverlays(chart, props.overlays ?? [], feed.bars)`），`npx vite build`（变异 bundle `index-DAC1b1by.js / ac4938b0…`）后跑同一注入 | **红（有牙）**：`openRunSettled` 就绪判据超时，原文 `Expected: "OK" / Received: "MISMATCH data-marker-overlays=0 want=44 note=成交合计 44 笔（精确源 /fills，已加载 44 / 共 44）"`（`raw/t4_inject_kline1500_MUTANT.txt`、`raw/t4_inject_kline1500_MUTANT_error_context.md`） |
| f′ | 恢复源码（`diff` 无差异）后 `npm run build` | **与线上 bundle 逐字节一致**：`dist/assets/index-BZMgzJCS.js` sha256 = `56ef46526414735c93f58f159a2659f2a4cfc68d13f47244571d5154b53db13b`（== 变异前的线上 sha），`index.html` 引用同名文件 |

**新增单测（Red → Green 固化，`web/src/features/dashboard/klineMarkerRace.test.tsx`，4 例）**：
① K 线数据**后**到（`/fills` 先落定）⇒ 标记 44（**修前此例必红**：实测 `expected 0 to be 44`）；
② K 线先到（`/fills` 后落定）⇒ 标记 44（防回归）；③ 数据**代际变化**（prepend 更早 bar + 引擎重跑 `getBars('init')`）⇒ 仍 44 且**不重复**；
④ **事件驱动**：无事件时 `vi.advanceTimersByTime(10_000)` ⇒ `createOverlay` 调用数**不增**（禁定时轮询/固定 sleep）。
overlay 面按真身语义建模（`createOverlay` / `removeOverlay({name})` 先清后建 ⇒ 等价 `getOverlays({name:'fillDot'})`）。

---

## 5. 判据 5 —— 同类「陈旧 props 快照 + 无重建路径」位置清单

| # | 位置 | 是否同类 | 处置 |
|---|---|---|---|
| 1 | `KlineChart.tsx` Effect W：`createChartOverlays(chart, props.overlays)`——价位线/区间 overlay 只在 **feed 变化**时用该次渲染的 `props.overlays` 快照建一次，`props.overlays` 单独变化时**无重建路径** | **是（完全同类）** | **已修**：收敛进唯一重建路径（`rebuildOverlays` 读 `overlaysRef.current`，由 `overlaysSig`/`barsGen`/`paneLayoutSig` 触发）。当前无调用方传 `price-line/range`（工作台结果页只传 marker），故风险仅潜在；一并修可避免下一波重演 |
| 2 | `KlineChart.tsx` Effect W 内读 `props.code` / `props.period`，而依赖只有 `[feed]` | 形态相同（读 props 而非依赖） | **不改（明确理由）**：调用方契约是「**feed 身份 = 数据面**」（`KlineResultChart` 用 `useMemo([api, run, period])`、看板/宫格同一 feed 源），把 code/period 加入依赖会改变「换标的是否重接 loader（`setSymbol`/`setPeriod`/`resetData`」的语义 ⇒ 属接口/生命周期层面的架构决策，**超出本波范围**，须由架构车道裁决（建议下波统一为 `feed` 携带 `code/period` 只读字段，消除该类隐患） |
| 3 | `KlineChart.tsx` Effect K（`windowCommand`）、Effect V（`onVisibleRangeChange`）、warmup Effect（`props.warmupBars`） | 读 props **且**依赖齐备（`[props.windowCommand]` / `[hasVisibleRangeCb]` / `[feed, props.warmupBars]`） | 无需处置（非同类） |
| 4 | `feed.onRealtime` 回调 / `markRealtime` / `scrollLatest` 闭包 | 读 props 的部分均已走 ref（`followRef` / `onManualZoomRef` / `syncRegistryRef`） | 无需处置（非同类） |

---

## 6. 未做项 / 残留风险 / 交接

| # | 项 | 级 | 说明 / 处置 |
|---|---|---|---|
| 1 | **T0 bundle 锚点常量过期**（冻结规格 `adr028-features-verify.e2e.ts:45-46`） | **中（阻塞 T0 复绿）** | 本车道**禁止**改 tester 规格 ⇒ 需规格维护者把常量更新为新产物 `index-BZMgzJCS.js / 56ef46526414735c93f58f159a2659f2a4cfc68d13f47244571d5154b53db13b`（旧产物备份：`raw/dist_prefix/assets/index-xGaRgVd-.js`，sha `8d936e11…`） |
| 2 | 同类位置 #2（`props.code/period` 读法） | 低 | 未改（§5 #2 理由）；建议架构车道统一「feed 携带 code/period」 |
| 3 | 实时 bar（WS append）不触发标记重建 | 低（有意） | 成交标记锚定历史 `fill.ts`；实时 append 仅可能改变「目标 ts 晚于已加载末根 ⇒ 钳位到末根」这一边界情形。为诚实起见**未**把实时 tick 纳入重建面（否则每 tick 重建 44 个 overlay）；若后续出现「盘中成交落在正在形成的 bar 上」的需求，由架构裁决（数据侧应改走数据代际而非 tick） |
| 4 | 非 marker 的 `price-line/range` 重建面**当前无测试覆盖**（无调用方） | 低 | 已在 §5 #1 说明；如需固化，建议后续补一条组件测试（本轮时间盒内未做） |
| 5 | 30 分钟时间盒 | — | 次序无关修复 → 注入验证 → 连续 10 次 → 四规格 → 回归/变异**均已完成**；仅 T0 需外部（tester）动作 |

---

## 7. 纪律与资源证据

* **单车道**：未 spawn 任何子代理；playwright 全部 `--workers=1 --retries=0`；vitest 单次调用 `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`；每条命令均有 `timeout` 前缀。
* **free -h**（每步前记录，模板示例）：`used 17–18Gi / available 28Gi`（无内存压力）；swap 无新增占用。
* **收尾进程卫生**：`pgrep -af '[v]ite preview'` ⇒ **0 条**（本波未起 preview）；`pgrep -af 'ms[-]playwright'` ⇒ **0 条**；`ls core*` ⇒ 无。
* **临时取证规格已删**：`web/e2e/zz-marker-race-inject.e2e.ts`、`web/e2e/zz-t4-inject.e2e.ts` 已 `rm`（`ls web/e2e | grep zz` ⇒ 空）。
* **未改 Rust / 未改 tester 规格**：`web/e2e/adr028-features-verify.e2e.ts` sha256 仍为 tester 的 `def97eac0daccd89e54069caddb2d97b9d9733eb20d6858c698274d9c7e58db0`（逐字节未动）。
* **工作区状态**：`git status --porcelain web/` = ` M web/src/features/dashboard/KlineChart.tsx` + `?? web/src/features/dashboard/klineMarkerRace.test.tsx`（另 ` M web/e2e/adr028-features-verify.e2e.ts` 为 tester 在本波**之前**的改动，非本车道产生）；`git diff --cached` ⇒ **空（无 staged，符合本波验收要求 no-staged-files）**。
* **grep/find** 均带 `--exclude-dir target --exclude-dir node_modules --exclude-dir .git`（或限定路径）。

---

## 8. 复现命令（单车道）

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs

# 0) 单测（Red/Green 固化）
cd web && timeout 600 env NODE_OPTIONS=--max-old-space-size=2048 npx vitest run \
  src/features/dashboard/klineMarkerRace.test.tsx --maxWorkers=1

# 1) 类型 + 构建（判据 e/g）
timeout 600 npx tsc -b            # exit 0
timeout 600 npm run build         # → dist/assets/index-BZMgzJCS.js（sha 56ef4652…）；index.html 引用一致

# 2) 注入两种次序（临时规格，先用 tester 版脚本重建）
#    zz-marker-race-inject.e2e.ts 源码留档于 raw/probe_source_zz_marker_race_inject.e2e.ts
cp ../coder/evidence/20260920_marker_race_fix/raw/probe_source_zz_marker_race_inject.e2e.ts e2e/zz-marker-race-inject.e2e.ts
timeout 300 env E2E_BASE_URL=http://localhost:8081 INJ_KLINE_MS=1500 MARKER_RACE_OUT=$PWD/../coder/evidence/20260920_marker_race_fix/raw/probe \
  npx playwright test e2e/zz-marker-race-inject.e2e.ts -g "次序①" --workers=1 --retries=0 --reporter=list   # 期望 ✓
timeout 300 env E2E_BASE_URL=http://localhost:8081 INJ_FILLS_MS=1500 MARKER_RACE_OUT=$PWD/../coder/evidence/20260920_marker_race_fix/raw/probe \
  npx playwright test e2e/zz-marker-race-inject.e2e.ts -g "次序②" --workers=1 --retries=0 --reporter=list   # 期望 ✓
rm -f e2e/zz-marker-race-inject.e2e.ts

# 3) 连续 10 次全量
for i in 00 01 02 03 04 05 06 07 08 09; do
  timeout 600 env E2E_BASE_URL=http://localhost:8081 ADR028V_OUT=$PWD/../coder/evidence/20260920_marker_race_fix/raw/runs/r$i \
    npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0 --reporter=list
done   # 每次：9 passed / T0 failed（锚点常量过期，需 tester 更新）

# 4) 四规格
for s in adr028-window-sync adr028-axis-align-probe adr028-resize-probe; do
  timeout 600 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/$s.e2e.ts --workers=1 --retries=0 --reporter=list
done

# 5) 收尾
pgrep -af '[v]ite preview' ; pgrep -af 'ms[-]playwright' ; ls core* 2>/dev/null ; free -h
```

---

## 9. 报告自指

本文件位置：**`coder/evidence/20260920_marker_race_fix/report.md`**（原始输出：`coder/evidence/20260920_marker_race_fix/raw/`）。

---

## 10. 补记（2026-09-20 13:15 前后，收尾自检）

* 归档的临时取证规格 `raw/probe_source_zz_marker_race_inject.e2e.ts` **重新落盘后可复跑**：按报告 §8 的命令原样跑「次序①」⇒ `1 passed (2.3s)`（`raw/probe_source_rerun.txt`、`raw/probe_archive/order_kline_delayed.json`）——即 §1 的结论可由归档源码独立重放。
* 收尾复核：`ls web/e2e | grep -c zz` ⇒ **0**（临时规格已删）；`pgrep -af 'ms[-]playwright'` ⇒ **0**；`pgrep -af '[v]ite preview'` ⇒ **0**；`free -h` used 18Gi / available 28Gi；`git diff --cached` ⇒ 空。
* `web/dist` 为构建产物（git 忽略），当前即**修复后**产物：`index-BZMgzJCS.js`（sha `56ef4652…`）+ `index.html` 引用一致；修复前产物备份在 `raw/dist_prefix/`（`index-xGaRgVd-.js`，sha `8d936e11…`）。
