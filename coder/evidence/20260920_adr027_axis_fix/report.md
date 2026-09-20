# ADR-028 D2.1/D2.3 时间轴对齐缺陷修复（2026-09-20 修复波）—— 证据与判词

> **本文件位置**：`coder/evidence/20260920_adr027_axis_fix/report.md`
> **被测版本**：`web/dist` = `assets/index-Bv7MKg8J.js`（本波 `npm run build` 产物，由 8081 后端静态提供）
> **目标 run**：`sr_1789832517800_000006`（518880 / M5 / 1949 根；含周末 239400s、隔夜 66600s、午休 5400s 缺口）
> **复现**：见 §7（三条命令，全部真渲染；tester 规格逐字节未改动）
> **纪律**：单车道；一律 `timeout` 前缀；vitest 单文件 `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`；playwright 指定规格；
> 跑完 `pgrep` 确认无 `vite preview` / 无遗留 chromium；每步记 `free -h`（全程可用内存 ≥18Gi）。

---

## 0. 判词（前置）

**索引空间映射：完成**（曲线 x = ts→**K 线所绘制的同一 bar 序列**查表索引，再索引线性映射；`mapLine`/`mapLineByTs` 语义未动，ts 线性仅作披露式降级）
**｜ 窗口双向精确：基本完成（5/6 态）**（K 线交互发布引擎 `getVisibleRange()` 实测值；程序化写窗回读并**发布实测值** + 显式披露被钳位；`全览` 态因 E4 冻结判据要求窗口 = run 全区间，物理上限改用「显示 N / 共 M 根」披露，见 §6-2）
**｜ 数据/域原子性：完成**（曲线取数收敛为**单一请求驱动** effect，`{rev, window, xDomain, plot}` 与数据同 rev 原子提交；`全览` 态旧数据+新域缺陷消除：曲线覆盖 plot 比 0.0253 → **1.000**）
**｜ 全览披露：完成**（`显示 614 / 共 1949 根（31.5%；受渲染上限约束）`；曲线跟随同一实际可见范围，不扇伸到全量）
**｜ 六态偏差（同一根 bar 真身配对，@984 / 真身 raw px）**：init **0.05 / 0.03**｜full **0.05 / 0.03**｜120 根 **0.05 / 0.03**｜300 根 **0.98 / 0.51**｜600 根 **1.44 / 0.95**｜无缺口对照（tester 探针配对口径）**1.6** —— **最大 1.44px**
**｜ 是否达标：达标（≤2px）**—— 判据口径为「同一根 bar 在两图上的 x 偏差」（ADR-028 §4.1 的像素判据）；**tester 探针的 Δ984 主口径不能反映本次修复**（其反解假设曲线按 ts 线性绘制），理由与证明见 §3，该主口径修复后仍为 119~352px
**｜ 未做项**：① tester 探针主口径的机械适配（已给出最小 patch 建议，未擅自改其文件）；② `全览` 态 `coverage 0.398`（E4 冻结判据与 ADR D2.3-3 的口径冲突，已披露不静默）

### 0.1 修复前后逐项对照（同一 tester 规格、同一 run、同一 8081 静态服务）

| 态 | 窗口覆盖（可见/窗口）修复前 → 后 | 曲线 plot 覆盖率（ratio）前 → 后 | 曲线首/末缺口(px@984) 前 → 后 | tester 探针配对口径 max\|Δ984\| 前 → 后 | 真身配对 max\|Δ984\|（本波规格） |
|---|---|---|---|---|---|
| init | 1.680 ✗ → **1.000 ✓** | 0.9971 → **1.000** | 0 / 2.9 → **0 / 0** | 350.2 → **0.0** | **0.05** |
| full | 0.398 ✗ → 0.398（E4 口径，见 §6-2） | **0.0253 → 1.000** | **959.1** / 0 → **0 / 0** | 不可测 → 不可测（探针取数口径） | **0.05** |
| 120 根 | 1.000 → **1.000** | 0.9984 → **1.000** | 0 / 1.6 → **0 / 0** | 283.3 → **0.0** | **0.05** |
| 300 根 | 1.309 ✗ → **1.000 ✓** | 0.9994 → **1.000** | 0 / 0.6 → **0 / 0** | 340.6 → **1.0** | **0.98** |
| 600 根 | 1.661 ✗ → **1.000 ✓** | 0.9996 → **1.000** | 0 / 0.4 → **0 / 0** | 169.3 → **1.4** | **1.44** |
| 无缺口对照 | 27.000 ✗ → **1.000 ✓** | 0.5 → **1.000** | 0 / 492 → **0 / 0** | 0.0 → 1.6 | —（本波规格未测该态） |

> 修复前数据来源：`tester/evidence/20260920_adr027_axis_align/raw/`（本波以**修复前源码**重建 dist 后按 tester 规格原样重跑，
> 逐值复现 tester 报告：Δ984 = 350.2/283.3/340.6/169.3/0.0、coverage = 1.7/0.4/1.3/1.7/27、tail = 2.9/1.6/0.6/0.4、full head = 959.1 ✓）。
> 修复后数据来源：`coder/evidence/20260920_adr027_axis_fix/raw/`（同一规格、`ADR027_ALIGN_OUT` 指向本目录；与 tester 目录同源同名）。

---

## 1. 四件事：修复点 / 证据 / 落点

### 1.1 ① x 映射改为 **bar 索引空间**（主因）

- **查表源 = K 线所绘制的同一 bar 序列**：`KlineChart` 的 `onVisibleRangeChange` 负载扩展为
  `{from_ts, to_ts, from_idx, to_idx, bar_ts[], bar_space, x_from_px, chart_width_px}`
  （`klineWindowOps.readVisibleRangeTs`）——`bar_ts` 即该图表 `dataList` 中**可见 bar 的 ts 序列**（升序）。
- **映射**：`curveXs(tsList, {mode:'index', barTs, toleranceSec})` —— ts 先**最近邻**查表（真身 per_bar ts 与
  K 线 bar ts 实测差 ~4s ⇒ 容差 `max(60, barSeconds/2)`），得 bar 索引后 **索引线性**映射到 plot；
  超容差点**剔除并计数**（禁钳位、禁外推；组件显示「N 点不在 K 线 bar 序列上（已剔除）」）。
- **降级链（显式、可披露）**：① K 线 bar 序列 → ② run `per_bar` ts 序列（`source:'per_bar'`）→ ③ 纯 ts 线性（`source:'ts'`）。
  ②③ 均在窗口条上出 `wb-axis-degraded` 文案；`xDomain=null`（无域）时**不绘制**（D2.2 禁「数据自身 min/max 扇伸」）。
- **共用绘图区几何（D2.3-4）**：`curvePlotViewBox()` 由 `x_from_px / bar_space / chart_width_px` 反推 svg `viewBox` 的 x 起点/宽度，
  使曲线 plot `[8, 992]` 与 K 线 `x_from_px + i*bar_space` 落在**同一屏幕像素**；四个曲线容器由 `p-1` 改为 `py-1`
  （SVG 宽与 K 线图容器同宽）。实测 `baselineInsetRawPx`（两图容器内缩常量）由 **−9.3px → 0.00px**。
- 证据：`chartUtils.test.ts`（索引/容差/剔除/降级可判别）、`resultAxisIndex.test.tsx`（在 K 线 bar 序列里插入
  「曲线没有的 bar」，断言渲染 x 间距 = 4 槽而非 ts 线性间距）、真渲染 §2。

### 1.2 ② 窗口 ↔ K 线视口双向精确（D2.3-1）

- **口径修正（主因）**：`readVisibleRangeTs` 过去取 `realFrom/realTo`。`realTo` 是引擎**未夹取**的内部扫描上界
  （实测 1014 > dataList 长 999），`realFrom` 只在右侧偏移 > 0 时 ≠ `from` ⇒ 旧实现发布的是「realFrom + 夹取后的 realTo」
  **混合端点**，正是 1.680× / 1.309× / 1.661× / 0.398× / 27× 的来源。现统一取引擎 `getVisibleRange()` 的
  **`from`/`to`**（取整、夹到数据长度）= 该图表实际生效、且任何消费者都按它读取的可见 bar 集合。
- **回读 + 钳位披露**：程序化写窗（L1/L2 跳转、历史回退、全览）后按 `applyWindowOps` 的**真身回执**发布实测端点/根数
  （禁「请求即发布」），并用 `clampDisclosure()` 与请求比对，不一致即出 `wb-window-clamped` 文案
  （实测：L2 跳转请求 120 根 → 实测 123~131 根时显式披露）。
- 证据：修复后 5/6 态 coverage = **1.000**（见 §0.1）；`resultWindow.test.ts`（clampDisclosure 边界）、
  `resultAxisIndex.test.tsx`（L2 跳转：state 端点 == 回执端点 + 出现披露）。

### 1.3 ③ 数据与定义域**原子切换**（D2.3-2）

- 曲线取数收敛为 `useRunSeries` 内**唯一**的 request-driven effect：键 = `[rev, window.from_ts, window.to_ts]`，
  `rev` 覆盖**三种**变化（K 线交互 / 跳转 / **回到全区间**）；`request.window === null` ⇒ 不传窗口参数取全区间
  （旧实现只在 `window != null` 时重取 ⇒ 全览态「旧数据 + 新域」，实测曲线仅 89 点、占 plot 2.5%、全挤在右端）。
- 成功时把 `{rev, xDomain, plot, degraded, source}` 与数据**一并**提交为 `applied` 快照；
  同 rev 内允许刷新几何（最新 K 线 bar 序列），**跨 rev（取数在飞）一律渲染上一组一致快照** ⇒
  不会出现「旧数据 + 新域」/「新数据 + 旧域」。失败 ⇒ 不提交快照 + `窗口取数失败…显示的是上一窗口数据`。
- 证据：修复后 full 态曲线 plot 覆盖率 **0.0253 → 1.000**、渲染顶点 89 → **614**（= K 线实际可见 bar 数）；
  `resultAxisIndex.test.tsx`（挂起窗口取数 ⇒ 渲染点数必须保持上一组，释放后才切换且加载态文案流转
  `窗口加载中` → `窗口已应用`）。

### 1.4 ④ 全览的物理上限与披露（D2.3-3）

- 「全览」= **尽可能全**：请求 run 全区间，回执给出引擎实际可见根数（本 run：**614 / 1949**），
  由 `capDisclosure()` 出 `wb-window-cap`：`全览：显示 614 / 共 1949 根（31.5%；受渲染上限约束：barSpace ≥ 1 + 面板宽度 + dataList 页大小）`。
- **曲线跟随同一实际可见范围**：全览态渲染顶点 = **614**（不是 1949，也不扇伸到全量）——由「x 映射只在 K 线 bar 序列内取点」天然保证。
- **消除「曲线右端固定少 1 根」**：真因为「K 线 feed 缓冲 bar（run 末端 06:58 ⇒ 缓冲拉到 07:00 有蜡烛）在 run 里没有 per_bar 记录」；
  本波把**结果页实例**的 `ScopedKlineFeed.buffer` 由 2 改为 **0**（看板/弹窗不受影响，见 §6-3），使 K 线 bar 域与 run 数据域一致。
  实测六态 `curveCoverage.tail` 全部 **0.00px**、`ratio` 全部 **1.000**（修复前 2.9 / 1.6 / 0.6 / 0.4 / 492 / 959.1）。
- 证据：§0.1、§2；`resultWindow.test.ts`（capDisclosure）、`resultAxisIndex.test.tsx`（600 根 run：barSpace 被夹到 1 ⇒
  披露出现、渲染点数 ≈ 实际可见 520 根）。

---

## 2. 六态真渲染像素偏差（本波独立复核规格）

**规格（coder 车道，新建）**：`web/e2e/adr028-axis-align-verify.e2e.ts`（tester 的 `adr028-axis-align-probe.e2e.ts` **未改动**）。
方法：曲线顶点 ts 由 `/curve` 数据一对一带出（**不是**由渲染 x 反解），K 线像素由 `convertToPixel(该 bar ts)` 真身读回 ⇒
直接回答「同一根 bar 在两图上的像素偏差」；归一化口径与 tester 一致（锚点 = 数据首末；984 = 曲线 plot 宽 user units）。

| 态 | 窗口来源 | 配对点数 | max\|Δraw\|（真身屏幕 px） | max\|Δ984\| | 窗口覆盖 | 曲线首/末缺口 |
|---|---|---|---|---|---|---|
| init（默认） | kline | 103 | **0.03** | **0.05** | 1.000 | 0 / 0 |
| full（全览） | full | 614 | **0.03** | **0.05** | n/a（§6-2） | 0 / 0 |
| 120 根（L2 跳转） | jump | 123 | **0.03** | **0.05** | 1.000 | 0 / 0 |
| 300 根（滚轮缩小） | kline | 317 | **0.51** | **0.98** | 1.000 | 0 / 0 |
| 600 根（滚轮缩小） | kline | 595 | **0.95** | **1.44** | 1.000 | 0 / 0 |

- 断言（规格内、恒真反证）：每态 `配对点数 > 0`；`max|Δ984| ≤ 2px`；`max|Δraw| ≤ 2px` ⇒ **passed（18.5s）**。
- 原始产物：`coder/evidence/20260920_adr027_axis_fix/raw/verify_states.json`、`verify_verdict.json`。
- tester 探针在**无缺口对照态**给出的配对口径 = **1.6px**（≤2px）⇒ 六态齐备。

---

## 3. 测量方法学：为什么 tester 探针的 **Δ984 主口径**不能反映本修复（含证明）

tester 规格的主口径把曲线**渲染 x** 用「ts 线性」反解成 ts（`ts(x) = D0 + ((x−8)/984)·(D1−D0)`），再与 K 线像素比。
该反解**只在曲线本身按 ts 线性绘制时与渲染同源**；本修复把曲线改成 **bar 索引空间**（ADR-028 D2.1 第 2 条明文要求）后，
反解与渲染不再同源 ⇒ 主口径测的是「K 线按 ts 插值口径 vs ts 线性口径」的差，与曲线怎么画**无关**。可复算证据：

1. **模型复现**：以真身数据（`state_*.json` 的 `kline.ts/xAbs` + `delta_series_*.json` 的曲线顶点 ts）离线复算 tester 算法，
   修复前逐态复现 **350.2 / 283.3 / 340.6 / 169.3 / 0.0**（与 tester 报告逐位一致 ⇒ 模型可信）。
2. **代入索引空间渲染后，主口径仍为大值**（同一模型：曲线 x 改为 `pad + idx/(n−1)·plotW`）：init 334.5、120 根 269.2、
   300 根 434.3、600 根 153.3（同量级）；而同期**配对口径**（同一批顶点按真实 ts 配对）= 0.3 / 0.4 / 2.3 / 1.9px。
3. **实测交叉验证**：修复前两口径**相等**（350.2/350.2、283.3/283.3…，tester 报告 §1「双口径互证」）；
   修复后两口径**分离**（如 init：主口径 352.4、配对口径 **0.0**）——分离本身即「反解假设已不成立」的直接证据。
4. 结论：本波判据取 **ADR-028 §4.1 的语义**（同一 ts / 同一 bar 在 K 线与各曲线视图上的 x 偏差 ≤ 2px）在**正确配对**下的实测值；
   tester 主口径若仍需保留可比性，最小机械适配是「曲线 x→ts 反解改用曲线声明的 x 映射」（见 §6-1，未擅自改其文件）。

---

## 4. 新增披露（UI，可测）

| testid | 触发 | 文案要点 |
|---|---|---|
| `wb-window-clamped` | 程序化写窗实测 ≠ 请求 | 「窗口被钳位（引擎实测 ≠ 请求）：请求 [a,b]（N 根）⇒ 实际 [c,d]（M 根）」 |
| `wb-window-cap` | 全览态可见 < 全部 | 「全览：显示 614 / 共 1949 根（31.5%；受渲染上限约束…）」 |
| `wb-axis-degraded` | 定义域降级 | per_bar 索引 / ts 线性两档各一句（禁静默） |
| 曲线条内 | 有超差点 | 「N 点不在 K 线 bar 序列上（已剔除）」 |
| `data-x-mode` | 恒有 | `index` / `ts` / `none`（观测性：与 `data-x-domain` 是两件事） |

---

## 5. 验证与命令（原始输出见 §7）

| 命令 | 结果 |
|---|---|
| `cd web && timeout 600 npx tsc -b --force` | **exit 0** |
| `timeout 400 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-axis-align-probe.e2e.ts --reporter=list --retries=0`（tester 规格，未改） | **1 passed（26.7s）** |
| `timeout 600 … npx playwright test e2e/adr028-axis-align-verify.e2e.ts --reporter=list --retries=0`（本波真身配对规格） | **1 passed（18.5s）**；max\|Δ984\| = 1.44px、max\|Δraw\| = 0.95px |
| `timeout 900 … npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list --retries=0`（**冻结规格，断言未放松**） | **6 passed（23.1s）** |
| `npx vitest run src/features/workbench/{chartUtils,resultWindow,resultWindowSync,useRunSeries,resultAxisIndex,ResultView,WorkbenchPage,resultBarSpaceLimit}.test.* --maxWorkers=1`（逐文件） | 全绿：17 / 33 / 6 / 6 / **4（新增）** / 27 / 14 / 2 |
| `npx vitest run src/features/dashboard/{KlineChart,KlineChartVisibleRange,KlineChart.realtime,chartSyncAlignClosedLoop}.test.*`（逐文件） | 全绿：12 / 5 / 8 / 7 |
| `pgrep -af "[v]ite preview"` / `pgrep -c chromium` | 空 / 0（无残留进程） |

---

## 6. 残余、口径冲突与机械适配

1. **tester 探针主口径（未擅自修改其文件）**：建议的最小机械适配 = 让 `tsAtUserX` 使用曲线**声明的 x 映射**
   （读新增的 `data-x-mode`；`index` 时按 `barTs`/声明定义域把 userX 反解为 bar 索引后再取该 bar 的 ts，`ts` 时保持原式）。
   本波**不改** tester 文件（它是回归基线），改用同口径语义 + 正确配对的自有规格（§2）给出判据值。
2. **全览态 coverage 0.398（E4 冻结判据 vs ADR D2.3-3）**：`adr028-window-sync.e2e.ts` E4 明确要求「全览后各曲线视图定义域 = run 全区间」
   （断言 `domainMismatches(fullDomains, fullFrom, fullTo)`），而 ADR D2.3-1 ② 要求「不一致则**发布实际值**」。
   本波的取舍：**窗口（逻辑时间范围）保持 run 全区间**（保 E4 绿），**实际渲染与曲线覆盖改为跟随引擎实际可见范围**
   （614 根），并以 `wb-window-cap` 显式披露物理上限 —— 即「披露优先于改写窗口」。若闸门裁定按 D2.3-1 ② 改写窗口，
   需同步修订 E4 判据（属 tester 车道裁决项）。
3. **结果页 K 线 feed `buffer: 2 → 0`**：仅作用于结果页实例（`KlineResultChart`；看板/弹窗/宫格不受影响）。
   理由是 D2.3-4 的「曲线右端固定少 1 根」根因即「缓冲 bar 有蜡烛但 run 无 per_bar」；实测六态 tail 缺口 0.00px。
   副作用：run 末端之后的 1~2 根市场 bar 不再作为上下文显示（这些 bar 本就没有 run 数据）。
4. **`getVisibleRange().from/to` 口径**：本波以它定义「K 线可见 bar 集合」。它在**右侧留白**（引擎
   `_lastBarRightSideDiffBarCount > 0`）时与几何可见范围（`realFrom/realTo`）相差一个偏移量；
   本波以**共用绘图区几何（viewBox）**消除该偏移在像素上的影响（`baselineInsetRawPx` = 0，真身配对 ≤1.44px）。
5. **`per_bar` 降级表**：来自 `/bars?kind=per_bar` 的**已加载分页**（本 run 1949 根一页取全）；>5000 根且未翻页时该降级表为部分集，
   已在 UI 标为降级；该路径仅在「K 线无 bar」时触发（罕见）。
6. **`curvesLoading` 语义**：仅**首屏**整块骨架；窗口刷新只置 `windowLoading`（旧曲线保持可见 + `窗口加载中` 标注），
   避免「窗口一跳就白屏」并保证原子切换可视。

---

## 7. 复现步骤（他人可一键重跑）

```bash
# ① 构建（tsc -b && vite build）并确认 8081 已提供新 bundle
cd /home/eestock/workspace/git/eestock/eestock-rs/web
timeout 900 env NODE_OPTIONS=--max-old-space-size=2048 npm run build
timeout 10 curl -s --max-time 5 http://localhost:8081/ | grep -o "index-[A-Za-z0-9_-]*\.js"   # => index-Bv7MKg8J.js

# ② tester 规格（未改动；输出指向本波证据目录，避免覆盖 tester 的修复前基线）
timeout 400 env E2E_BASE_URL=http://localhost:8081 \
  ADR027_ALIGN_OUT=/home/eestock/workspace/git/eestock/eestock-rs/coder/evidence/20260920_adr027_axis_fix/raw \
  npx playwright test e2e/adr028-axis-align-probe.e2e.ts --reporter=list --retries=0

# ③ 本波真身配对规格（同一根 bar 的像素偏差；判据 ≤2px）
timeout 600 env E2E_BASE_URL=http://localhost:8081 \
  npx playwright test e2e/adr028-axis-align-verify.e2e.ts --reporter=list --retries=0

# ④ 冻结回归规格（不得放松）
timeout 900 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list --retries=0
```

产物：`coder/evidence/20260920_adr027_axis_fix/raw/`
`summary.json` / `verdict.json`（tester 规格六态读数）、`state_<态>.json` / `delta_series_<态>.json`（逐态真身读数）、
`verify_states.json` / `verify_verdict.json`（真身配对六态）、`state_<态>*.png`（截图）。
修复前基线：`tester/evidence/20260920_adr027_axis_align/raw/`（本波以修复前源码重建 dist 后原样重跑，逐值复现 tester 报告）。

---

## 8. 变更文件（web/ 内；未改 Rust）

| 文件 | 变更要点 |
|---|---|
| `web/src/features/backtest/chartUtils.ts` | 新增 `CurveXDomain`/`curveXs`/`mapLineByDomain`/`curvePlotViewBox`/`resolveCurveX`/`curveDomainAttr`（`mapLine`/`mapLineByTs` 未动） |
| `web/src/features/workbench/chartUtils.ts` | 再导出上述新增（依赖方向不变） |
| `web/src/features/dashboard/klineWindowOps.ts` | `VisibleRangeTs` 增 `bar_ts/bar_space/x_from_px/chart_width_px`；`readVisibleRangeTs` 改用 `from/to` + 采几何；`KlineWindowOps` 增 `convertToPixel` |
| `web/src/features/dashboard/KlineChart.tsx` | Effect V：程序化写窗期间**仍派发**可见范围（几何是事实；窗口回写由消费方抑制） |
| `web/src/features/workbench/resultWindow.ts` | 窗口态增 `from_idx/to_idx`；新增 `buildCurveX` 降级链、`clampDisclosure`、`capDisclosure`、`geomFromRange/sameGeom`、`CurveDomainRequest` |
| `web/src/features/workbench/useResultWindow.ts` | 记录真身几何；rev 单调推进；回读发布 + 钳位披露；`request/curveX/capNote/visibleBars` 出口 |
| `web/src/features/workbench/useRunSeries.ts` | 曲线取数收敛为 request-driven 单点；`applied` 快照原子提交；首屏骨架 vs 窗口刷新加载态分离；`appliedXDomain/Plot/Degraded/XSource` |
| `web/src/features/workbench/{AggregateScoreChart,SlotScoresChart,EquityDrawdownChart,PositionRatioChart}.tsx` | 消费 `xDomain`/`plot`（`data-x-mode`、共用 viewBox、超差点披露）；容器 `p-1 → py-1` |
| `web/src/features/workbench/ResultView.tsx` | 串接 `appliedXDomain/Plot`、`perBarRows` 降级表；新增三处披露 |
| `web/src/features/workbench/KlineResultChart.tsx` | 结果页 feed `buffer: 2 → 0`（对齐 run 数据域） |
| 测试 | 新增 `resultAxisIndex.test.tsx`（4 用例）、`adr028-axis-align-verify.e2e.ts`；扩展 `chartUtils.test.ts`（+11）、`resultWindow.test.ts`（+10）；机械适配 `resultWindow.test.ts` 一处既有断言（窗口态新增 `from_idx/to_idx` 两字段） |
