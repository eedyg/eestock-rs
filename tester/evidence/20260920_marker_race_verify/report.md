# ADR-028 D4.1 买卖标记竞态修复 —— tester 独立复验（次序无关 + T0 常量维护）

**本报告路径**：`tester/evidence/20260920_marker_race_verify/report.md`
**原始输出目录**：`tester/evidence/20260920_marker_race_verify/raw/`
**复验对象**：生产改动 `web/src/features/dashboard/KlineChart.tsx`（+95/−30，sha256 `bc6fd9571db049a13845c59d8de333cbd1a77904c3d87ec53bfde0733e942196`）
**线上产物**：`web/dist/assets/index-BZMgzJCS.js`，sha256 `56ef46526414735c93f58f159a2659f2a4cfc68d13f47244571d5154b53db13b`（== `:8081` 服务值）
**真身**：主机进程 `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（PID 1941108，`static_dir=./web/dist`）
**测试纪律**：单车道（未 spawn 子代理）｜playwright 一律 `--workers=1 --retries=0` 且只跑相关规格｜vitest 单次 `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`｜每条命令 `timeout` 前缀｜grep/find 带 `--exclude-dir`（或限定路径）｜每步记录 `free -h`（used 17–20Gi / available 26–28Gi，全程无内存压力）

---

## 判词（一行，前置）

**根因复核 一致**（陈旧 `props.overlays` 渲染快照 + 重建路径缺失 ⇒ 标记永久丢失；修复为**唯一**幂等重建路径 `rebuildOverlays`，触发面 = `overlaysSig`/`barsGen`/`paneLayoutSig`，**无定时器/无 sleep**，变异反证复现同一失败签名） ｜ **次序无关（kline 延迟 +1499ms / fills 延迟 −1497ms）通过**（两种次序均 `data-marker-overlays=44 == 已加载 44`、真图表 store `fillDot=44`、视窗内 24 个标记**逐笔像素取证**全中、两序截图 **PNG 逐字节相同**、历史红断言「跳转后目标笔几何必须可测」两序均绿） ｜ **连续 10 次全量 `adr028-features-verify.e2e.ts` 全绿**（每次 **10 passed / 0 failed**，套件 45.1–45.3s；**T4 = 10.9–11.0s**（mean 10.91 / pstdev 0.030），**4.1s 级提前失败 0 次**；T0 0.36s 绿） ｜ **无回归 绿**（window-sync 6/6、axis-align-probe 2/2、resize-probe 1/1；`tsc -b` exit 0；vitest 14 files / 82 tests passed） ｜ **变异反证 有牙**（「仅挂载时构建 + 挂载快照」变异 bundle `index--d9w5szN.js / f613c487…` ⇒ 同一注入下 **红**：`MISMATCH data-marker-overlays=0 want=44`；还原后源码 sha 与变异前一致、重建 bundle 与线上**逐字节一致** `56ef4652…`） ｜ **T0 常量更新 完成**（`EXPECT_BUNDLE_NAME/SHA256` → `index-BZMgzJCS.js / 56ef4652…`；**零改动证明：diff numstat = 2 2**，逐字节快照比对，断言仍为精确等值 + served-vs-磁盘逐字节，无 env 旁路/无放宽） ｜ **同类位置 #2（`props.code/period`）判定 = 不构成真缺陷**（三个调用方的 `feed` 身份均以 (code, period) 为依赖 ⇒ 无可达路径；探针证明其为**潜在隐患**：违反隐式契约时图表静默停在旧标的/周期，属接口层建议项，本波**未**打补丁） ｜ **总判词 = 放行**

---

## 0. 本波动作与边界

| # | 动作 | 结果 |
|---|---|---|
| 1 | 独立复跑根因复核（读代码，不采信实现方结论） | 一致（§1） |
| 2 | 自建注入手段（`page.route` 分别延迟 `/api/kline` 与 run 级 `/fills` 1500ms）复验次序无关 | 两序通过（§2） |
| 3 | 连续 10 次全量跑冻结规格（`--workers=1 --retries=0`） | 10/10 全绿（§3） |
| 4 | 无回归：三个 tester 规格 + `tsc -b` + vitest 相关子集 | 全绿（§4） |
| 5 | 变异反证（临时改生产代码再**逐字节还原**） | 有牙 + 还原一致（§5） |
| 6 | 维护**我拥有的**规格常量（`adr028-features-verify.e2e.ts:45-46`） | 完成，numstat 2 2（§6） |
| 7 | 同类位置 #2 判定 + 最小复现探针 | 不构成真缺陷，列为潜在隐患（§7） |
| — | **禁止项遵守**：未改生产语义（唯一生产文件的改动为临时变异且已逐字节还原）；未改架构/接口；临时取证文件（1 个 e2e 规格 + 1 个单测探针）跑完已删、源码归档 | 见 §8 |

---

## 1. 根因复核（结论：**一致**）

### 1.1 缺陷形态（读 `git show HEAD:…KlineChart.tsx` 原始行号复核）

| 位置 | 旧行为 | 后果 |
|---|---|---|
| `HEAD:845-855`（`feed.loadInitial().then(...)`） | 回调闭包持**该次 Effect W 渲染**的 `props.overlays`；`createMarkerOverlays(chart, props.overlays ?? [], feed.bars)` | `/fills` 先到 ⇒ 闭包内是**空数组快照** |
| `HEAD:869-876`（Effect M，依赖 `[props.overlays, feed]`） | `/fills` 先到后立刻跑：`feed.bars=[]` ⇒ `snapTsToBars([])===null` ⇒ 建 **0** 个 | `data-marker-overlays=0` |
| 此后 | 依赖面只剩 `[props.overlays, feed]`，两者均不再变化 ⇒ **无任何重建路径** | **永久丢失**（页面仍显示「已加载 44/44」） |

⇒ 「陈旧 props 快照 + 无重建路径 ⇒ 标记永久丢失」**形态复核一致**（与我上一波 `tester/evidence/20260920_t4_flaky_rootcause/report.md` §3.3/§3.5 的注入取证同因）。

### 1.2 修复点复核（当前 worktree）

* **唯一重建路径**：`rebuildOverlays(chart)`（`KlineChart.tsx:648-662`）——先按名清（`fillDot`/`simpleAnnotation`/`simpleTag`/`tradeRange`）再建；**只**读 `overlaysRef.current`（`609-610`：每次渲染同步最新 props，消灭挂载快照）+ `feed.bars`；随后 `setMarkerCount` + `setOverlayEpoch`。**不触碰** dataList / 视口 / barSpace / 指标 pane。
* **触发面只三条（Effect M 依赖，`936`）**：`[rebuildOverlays, overlaysSig, barsGen, paneLayoutSig]`
  * `overlaysSig = overlaySignature(props.overlays)`（**内容签名**，纯函数，`522-544`）⇒ 父级「新数组同内容」不触发重建（幂等/防重建风暴）；
  * `barsGen`（`useState` + `bumpBarsGen`）⇒ **数据代际信号**，调用点 3 处（复核）：`860`（DataLoader `getBars` 实取到 bar：init/forward）、`914`（`feed.loadInitial().then`）、`1016`（warmup 真的补取更早 bar 后 `resetData()`）；
  * `paneLayoutSig`（指标勾选 + MA 窗口 + dcap 参数 + 隐藏 K 线）。
* **无定时器/无 sleep**（独立 grep 复核）：`KlineChart.tsx` 内 `setTimeout/setInterval` 仅 `947/948`，属 **Effect P 高亮脉冲**；`grep -n "setInterval\|setTimeout" <HEAD 版本>` ⇒ `887/888` —— **同一处，修复前既有**，与重建触发面无关。重建路径内无 `await new Promise`/固定等待/轮询。

**判词**：根因复核 **一致**（含「无定时器」的机制性排除）。

---

## 2. 次序无关验证（**通过**）—— 自有注入手段

注入手段（**tester 自建、不改生产代码、不改冻结规格**）：临时规格 `web/e2e/zz-tester-order-independence.e2e.ts`（跑完已删，源码归档 `raw/probe_source_zz_order_independence.e2e.ts`）在浏览器侧 `page.route` 分别延迟：

* 次序① `**/api/kline*` +1500ms（⇒ `/fills` 先落定）
* 次序② `**/api/workbench/runs/*/fills*` +1500ms（⇒ K 线数据先落定；**只**延迟 run 级事实源，不碰 round-trips 切片）

断言=四口径：**DOM**（`data-marker-overlays` == `wb-fills-note` 已加载笔数，且 note 必须**落定**：`已加载 N / 共 N` 且 N>0）、**store**（真图表 `getOverlays({name:'fillDot'})` 计数与逐笔字段）、**像素**（每笔 `convertToPixel` + `stackIndex×12` 位置 ±5px 盒内取该笔颜色墨迹：买 `#ff5c6c` / 卖 `#00e0a4`）、**历史红断言**（跳转后目标笔几何可测）。

| 项 | 次序① `/fills` 先到（kline +1499ms） | 次序② K 线先到（fills −1497ms） |
|---|---|---|
| 响应到达差（自采 `page.on('response')`） | kline@1685ms / fills@186ms ⇒ **Δ+1499ms** | kline@177ms / fills@1674ms ⇒ **Δ−1497ms** |
| `wb-fills-note` | 成交合计 44 笔（精确源 /fills，已加载 44 / 共 44） | 同左 |
| `data-marker-overlays`（DOM） | **44** | **44** |
| store `fillDot` 数（真图表） | **44** | **44** |
| 像素：视窗内标记逐笔有墨 | **24 / 24**（ink min 15，median 18） | **24 / 24**（ink min 15，median 18） |
| 历史红断言（跳转后几何可测） | **✓** | **✓** |
| 截图（PNG） | `markers_kline.png` sha `681bd938…` / `jump_kline.png` sha `7e7fb83c…` | `markers_fills.png` `681bd938…` / `jump_fills.png` `7e7fb83c…` |

* **两序 PNG 逐字节相同**（markers + jump 各一对 sha 相同）⇒ 次序无关性不仅是计数一致，**渲染结果也一致**。
* 视窗外 20 笔（run A 174 根，默认视窗 120 根）本就不该有墨迹 ⇒ 像素判据按 `inView` 收敛为「视窗内 24 笔逐笔命中」，**未放宽**为「整体比例」。
* 原始输出：`raw/order_A_kline_delayed.txt`（1 passed 2.8s）、`raw/order_B_fills_delayed.txt`（1 passed 2.9s）；读数 `raw/order_independence/order_kline.json`、`order_fills.json`。
* 对照（修前同因，非本波读数）：`tester/evidence/20260920_t4_flaky_rootcause/report.md` §3.3 —— 同注入下 `dots=0` 持续 11s 且 T4 于 4.4s 死在同一断言；本波同注入两序均绿 ⇒ **由红转绿的机制被独立复现**。

**判词**：次序无关（kline 延迟 / fills 延迟）**通过**。

---

## 3. 确定性：连续 10 次全量（**全绿**）

命令（每次独立输出目录，`timeout 600` 前缀）：

```bash
cd web && timeout 600 env E2E_BASE_URL=http://localhost:8081 ADR028V_OUT=<raw>/runs/rNN \
  npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0 --reporter=list
```

| run | 判词 | 套件 | run | 判词 | 套件 |
|---|---|---|---|---|---|
| r00 | **10 passed / 0 failed** | 45.3s | r05 | **10 passed / 0 failed** | 45.1s |
| r01 | **10 passed / 0 failed** | 45.2s | r06 | **10 passed / 0 failed** | 45.1s |
| r02 | **10 passed / 0 failed** | 45.2s | r07 | **10 passed / 0 failed** | 45.2s |
| r03 | **10 passed / 0 failed** | 45.1s | r08 | **10 passed / 0 failed** | 45.3s |
| r04 | **10 passed / 0 failed** | 45.1s | r09 | **10 passed / 0 failed** | 45.1s |

**逐用例耗时表**（`raw/runs/timings.txt`，单位秒）：

| run | T0 | T1 | T2 | T3 | **T4** | T5 | T6a | T6b | T6c | T7 |
|---|---|---|---|---|---|---|---|---|---|---|
| r00 | 0.4 | 1.4 | 1.3 | 1.8 | **10.9** | 6.9 | 1.7 | 1.6 | 15.8 | 3.1 |
| r01 | 0.4 | 1.4 | 1.3 | 1.8 | **10.9** | 6.9 | 1.6 | 1.6 | 15.8 | 3.1 |
| r02 | 0.4 | 1.4 | 1.3 | 1.8 | **10.9** | 6.9 | 1.7 | 1.6 | 15.8 | 3.1 |
| r03 | 0.4 | 1.4 | 1.3 | 1.8 | **10.9** | 6.9 | 1.6 | 1.6 | 15.8 | 3.1 |
| r04 | 0.4 | 1.4 | 1.3 | 1.8 | **10.9** | 6.9 | 1.6 | 1.6 | 15.8 | 3.1 |
| r05 | 0.4 | 1.4 | 1.3 | 1.7 | **10.9** | 6.9 | 1.6 | 1.6 | 15.8 | 3.1 |
| r06 | 0.4 | 1.4 | 1.3 | 1.8 | **10.9** | 6.9 | 1.6 | 1.6 | 15.8 | 3.1 |
| r07 | 0.4 | 1.4 | 1.3 | 1.7 | **10.9** | 6.9 | 1.6 | 1.6 | 15.9 | 3.1 |
| r08 | 0.4 | 1.4 | 1.3 | 1.8 | **11.0** | 6.9 | 1.6 | 1.7 | 15.8 | 3.1 |
| r09 | 0.4 | 1.4 | 1.3 | 1.8 | **10.9** | 6.9 | 1.6 | 1.6 | 15.8 | 3.1 |

* **T4 分布**：n=10，min **10.9** / max **11.0** / mean **10.91** / pstdev **0.030**；**≤6.0s（历史 4.1s 级「等不到标记直接死」档）出现 0 次**。
* **T0 每次 0.36–0.37s 绿**（常量已更新，见 §6）；读数 `raw/runs/r00/t0_bundle.json`：`servedSha256 == localSha256 == 56ef4652…`、`localRef == /assets/index-BZMgzJCS.js`。
* 每 run 的原始输出 `raw/runs/r00.txt … r09.txt`（含每例逐行判词）；run rXX 目录内另落 T0/T1/T2/T4/T5 等结构化读数 JSON。
* 收尾（变异实验并还原后）**再跑 1 次全量 = 10 passed (45.3s)**：`raw/post_restore_frozen.txt`（确认实验未污染线上产物）。

**判词**：连续 10 次全绿；T4 分布 10.9–11.0s，4.1s 级提前失败 0 次。

---

## 4. 无回归（**绿**）

| 判据 | 命令 | 结果 | 原始输出 |
|---|---|---|---|
| 窗口联动 | `playwright test e2e/adr028-window-sync.e2e.ts --workers=1 --retries=0` | **6 passed (23.6s)** | `raw/spec_adr028-window-sync.txt` |
| 轴对齐探针 | 同前缀 `adr028-axis-align-probe.e2e.ts` | **2 passed (43.8s)** | `raw/spec_adr028-axis-align-probe.txt` |
| 结果页缩放探针 | 同前缀 `adr028-resize-probe.e2e.ts` | **1 passed (36.2s)** | `raw/spec_adr028-resize-probe.txt` |
| 类型检查 | `npx tsc -b`（web/） | **exit 0**（零输出） | `raw/tsc_b.txt` |
| 相关单测子集 | `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run <14 文件> --maxWorkers=1` | **14 files / 82 tests passed**（含 `klineMarkerRace.test.tsx`、KlineChart 全系、markerSnap/ScopedKlineFeed/klineDataLoader、adr028FocusHighlight、resultWindowSync/ResizeIndicators/BarSpaceLimit/AxisIndex） | `raw/vitest_subset.txt` |

**判词**：无回归 **绿**。

---

## 5. 变异反证（**有牙**）

**变异体**（临时改生产代码，`KlineChart.tsx` 两处插入，见 `raw/mutation_diff_snippet.txt`）：把唯一重建路径改回**「仅挂载时构建 + 挂载快照」**旧缺陷形态 ——

```ts
// 挂载快照 + 单次构建闸门
const mutantMountOverlays = useRef(props.overlays);
const mutantBuilt = useRef(false);
...
if (mutantBuilt.current) return;      // 仅挂载时构建
mutantBuilt.current = true;
const ovs = mutantMountOverlays.current ?? [];   // 陈旧快照（不再读 overlaysRef）
```

| 步骤 | 命令/读数 | 结果 |
|---|---|---|
| 变异构建 | `npm run build`（exit 0，2.08s） | `dist/assets/index--d9w5szN.js`，sha256 `f613c487e4b6cc536473b23dc35db90ae32479335676ad7b172cd2688411f2cd`；`:8081` 实测服务同名文件 |
| 同一注入（次序① kline +1500ms） | 自建注入规格 | **红**，21.7s：`MISMATCH data-marker-overlays=0 want=44 note=成交合计 44 笔（精确源 /fills，已加载 44 / 共 44）`（`raw/mutation_kline_delayed.txt`） |
| 同一注入（次序② fills +1500ms） | 同上 | **红**，20.3s：同一文案（`raw/mutation_fills_delayed.txt`） |
| 还原 | `cp raw/KlineChart_pre_mutation.tsx → web/src/…/KlineChart.tsx` | 源文件 sha **与变异前完全一致** `bc6fd957…`，`grep -c "TESTER MUTANT"` = 0，`git diff --numstat` 回到 **95 30** |
| 还原构建 | `npm run build`（exit 0，2.03s） | `dist/assets/index-BZMgzJCS.js`，sha256 **`56ef46526414735c93f58f159a2659f2a4cfc68d13f47244571d5154b53db13b`** == 变异前线上值 ⇒ **与线上 bundle 逐字节一致**；`dist` 内已无变异文件（`ls` 仅 `index-BZMgzJCS.js` + `index-DOyfqUyq.css`） |
| 还原后复跑 | 两序注入 + 冻结规格 | `raw/post_restore_kline.txt` / `post_restore_fills.txt` 各 1 passed；`raw/post_restore_frozen.txt` **10 passed (45.3s)** |

* 变异红的**失败签名与历史红、与我上一波根因取证的签名同形**（`data-marker-overlays=0 want=44`）⇒ 本波判据确实咬在「陈旧快照 + 无重建」这一点上，而非泛泛的稳定性。
* 变异期间的两序**均红**符合「仅挂载时构建」语义（单次构建后任何数据后到都不重建）；次序①的红即为任务要求的「同一注入下必须红」。

**判词**：变异反证 **有牙**；还原后与线上 bundle 逐字节一致。

---

## 6. T0 常量更新（**完成**）与「除这两行外零改动」证明

### 6.1 改动内容（`web/e2e/adr028-features-verify.e2e.ts:45-46`）

```diff
-const EXPECT_BUNDLE_NAME = 'index-xGaRgVd-.js';
-const EXPECT_BUNDLE_SHA256 = '8d936e11f5d0d448434cf0d6907d8d907f0e544e8bd0a2805d1d06433993a8bc';
+const EXPECT_BUNDLE_NAME = 'index-BZMgzJCS.js';
+const EXPECT_BUNDLE_SHA256 = '56ef46526414735c93f58f159a2659f2a4cfc68d13f47244571d5154b53db13b';
```

文件 sha256：改前 `def97eac0daccd89e54069caddb2d97b9d9733eb20d6858c698274d9c7e58db0`（= 上一波 tester 冻结值）→ 改后 `dc3f6fc537a0da1734d8ff08f3166167c7bf41724303a32810fb1fa635446c5f`。

### 6.2 零改动证明（**numstat = 2 2**）

```
$ git diff --no-index --numstat <改前快照> <改后快照>
2	2	{spec_prefix_before_t0_update.e2e.ts => spec_post_t0_update.e2e.ts}
```

* 逐字节快照留档：`raw/spec_prefix_before_t0_update.e2e.ts`（sha `def97eac…`）、`raw/spec_post_t0_update.e2e.ts`（sha `dc3f6fc5…`）；完整 diff 体（仅两行 `-/+`，上下文为原注释/`RUN_A` 行）见 `raw/t0_const_update_diff.txt`。
* **相对 `git HEAD` 的 numstat = 102 10**；其中 **100 8** 为**上一波 tester** 的确定性加固（`waitForTimeout(2500)` → 显式就绪判据 + T4 写窗回执，已在 `tester/evidence/20260920_t4_flaky_rootcause/report.md` 记录），本波增量恰为 **2 2**（上面 `--no-index` 自比对证明，排除上一波改动被计入的歧义）。
* **未放宽/未旁路**（断言逐字未动，仅常量值变化）：T0 仍要求
  `expect(url).toContain(EXPECT_BUNDLE_NAME)`、`expect(localRef).toBe(url)`、`expect(served).toBe(sha256(web/dist 同名文件))`、`expect(served).toBe(EXPECT_BUNDLE_SHA256)`（**精确等值**）；`grep -n "process.env.*EXPECT_BUNDLE\|process.env.*BUNDLE"` ⇒ **0 命中**（无 env 旁路）。
* 复绿证据：T0 单跑 `1 passed (712ms)`（`raw/t0_only.txt`，读数 `raw/t0_only/t0_bundle.json`）+ 10 次全量中 T0 每次 0.36–0.37s 绿（§3）。

**判词**：T0 常量更新 **完成**；**除这两行外零改动**（numstat 2 2）。

---

## 7. 同类位置 #2：`props.code` / `props.period`（Effect W 读 props，依赖仅 `[feed]`）—— **不构成真缺陷**

### 7.1 形态复核（同形）

```
KlineChart.tsx:879  chart.setSymbol({ ticker: props.code, … });
KlineChart.tsx:880  chart.setPeriod(PERIOD_MAP[props.period]);
KlineChart.tsx:922  }, [feed]);     // ← 依赖面只有 feed；code/period 变化不会重跑本 Effect
```
（`KlineChartProps` 的 `code`/`period` 字段**无**文档化契约说明「必须随 feed 身份变化」——见 `KlineChart.tsx:91-92`。）

### 7.2 可达性判定：**不构成真缺陷**（无可达路径）

| 调用方 | `feed` 身份依赖 | 是否覆盖 code/period | 依据 |
|---|---|---|---|
| 工作台结果页 `KlineResultChart.tsx:229` | `useMemo(..., [api, run, period])`，其中 `code=run.symbol`、`period=periodCodeToPeriod(run.period)`（`:126-141`） | **是**（code/period 变化必伴随 `run` 或 `period` 变化） | 读码 + 依赖数组 |
| 看板基准图 `DashboardPage.tsx:477` | `useMemo(..., [api, ws, state.selected, basePeriod, viewportBars])`，`code={state.selected}`、`period={basePeriod}`（`:361-374`） | **是** | 同上 |
| 多周期卫星 `MultiPeriodSatellite.tsx:161` | `useMemo(..., [api, ws, code, period, props.viewportBars])`（`:66-77`），另有 `key={attempt}` 重试重挂 | **是** | 同上 |

非测试代码中 `<KlineChart` 仅上述 3 处（`grep -rn "<KlineChart"`，另 1 处为注释）⇒ **无任何调用方在同 `feed` 身份下切换 code/period** ⇒ 产品可达路径下**不可复现**。

### 7.3 最小复现（**须先违反调用方契约**，仅证明潜在隐患）

探针 `web/src/features/dashboard/zzLatentCodePeriodProbe.test.tsx`（临时单测，跑完已删；源码归档 `raw/probe_source_zz_latent_code_period.test.tsx`）：同一 `feed` 对象身份，`render(view(feed,'518880','1d'))` → `rerender(view(feed,'159776','1h'))`（其余 props 不变），读取桩 chart 调用记录：

```json
{ "afterMount":  { "setSymbol": 1, "setPeriod": 1, "symbols": ["518880"] },
  "afterChange": { "setSymbol": 1, "setPeriod": 1, "symbols": ["518880"], "periods": ["[object Object]"] } }
```

⇒ 违反契约时 `setSymbol/setPeriod` **不再被调用**：图表**静默停在旧标的/旧周期**（无提示、无报错）。读数：`raw/latent_probe/latent_code_period.json`，运行输出 `raw/latent_probe.txt`（1 passed）。

### 7.4 结论与处置建议（**不打补丁**）

* **判定**：**不构成同类真缺陷**（无调用方可达；「陈旧值」不会在现有产品路径上出现）。但它与 §1 的缺陷**形态同形**（Effect 读 props 而非依赖），且契约仅靠三个调用方「碰巧」共同遵守 ⇒ 属**潜在隐患（隐式契约）**。
* **建议（交架构车道裁决，本波未改产品）**：①短期把「`code`/`period` 变化必须伴随 `feed` 身份变化」写进 `KlineChartProps` 契约注释并经架构确认；②中期按实现方建议统一为 **`feed` 携带 `code`/`period` 只读字段**（消除该类隐患的结构性来源），届时 `setSymbol/setPeriod` 以 `feed.code/feed.period` 为准，Chart 侧无需再读独立 props。
* 若架构车道选择保留现状，建议下波补一条**固化隐式契约**的单测（本项目已有 `klineMarkerRace.test.tsx` 先例），本轮**未**落永久测试（避免把「潜在形态」误固化为「期望行为」）。

---

## 8. 残留风险 / 未做项（诚实清单）

| # | 项 | 级 | 说明 |
|---|---|---|---|
| 1 | 冻结规格头部注释仍含旧 bundle 名（`adr028-features-verify.e2e.ts:20` 提到 `assets/index-BY728MHs.js`） | 低（文档陈旧） | **本波刻意未改**：任务要求「除两行常量外零改动」且 numstat 必须为 2 2，改注释会使 numstat 变成 3 3。该注释自更早波次起即陈旧，**不影响任何断言**（T0 只读常量，`expect(url).toContain(EXPECT_BUNDLE_NAME)`）。建议下波专门做一次只动注释的维护（不计入本波改动面）。 |
| 2 | 实时 bar（WS append）不触发标记重建 | 低（实现方有意，未纳入本波复验目标） | 复验未发现「盘中成交落在正在形成的 bar 上」的产品需求；若出现，应由数据代际而非 tick 驱动。 |
| 3 | `price-line/range` 类 overlay 的重建面**当前无调用方**（工作台只传 marker） | 低 | §1 复核确认它们已收敛进唯一路径；无调用方 ⇒ 无端到端覆盖。 |
| 4 | 同类位置 #2 属潜在隐患（§7） | 低 | 无产品补丁，仅建议（见 §7.4）。 |
| 5 | 临时取证文件已清理：`web/e2e/zz-tester-order-independence.e2e.ts`、`web/src/features/dashboard/zzLatentCodePeriodProbe.test.tsx` | — | `ls web/e2e \| grep -c zz` = 0；`ls src/features/dashboard \| grep -c zz` = 0；源码留档于 `raw/probe_source_*.`。 |
| 6 | 内存/进程卫生 | — | 收尾：`pgrep -af '[v]ite preview'` = 0；`pgrep -af 'ms[-]playwright'` = 0；`pgrep -af '[p]laywright test'` = 0；仓库内 `core*` = 0；`free -h` used 18Gi/available 28Gi（`raw/hygiene.txt`）。桌面自身的 snap chromium/Steam 进程非本波产生（无 `ms-playwright` 归属）。 |
| 7 | 工作区状态 | — | `git status --porcelain web/` = ` M web/e2e/adr028-features-verify.e2e.ts`（本波 2 行 + 上一波加固）｜` M web/src/features/dashboard/KlineChart.tsx`（实现方改动，sha `bc6fd957…`，与变异前一致）｜`?? web/src/features/dashboard/klineMarkerRace.test.tsx`（实现方新增单测）；`git diff --cached` **空**。 |

---

## 9. 证据索引（`tester/evidence/20260920_marker_race_verify/raw/`）

| 文件 | 内容 |
|---|---|
| `spec_prefix_before_t0_update.e2e.ts` / `spec_post_t0_update.e2e.ts` / `t0_const_update_diff.txt` | T0 常量改动的**逐字节**前后快照 + `--no-index` numstat **2 2** + diff 体 |
| `t0_only.txt` / `t0_only/t0_bundle.json` | T0 单跑绿（712ms）与 served/local sha 读数 |
| `probe_source_zz_order_independence.e2e.ts` | 本波注入规格源码留档（自建；已从 `web/` 删除） |
| `order_A_kline_delayed.txt` / `order_B_fills_delayed.txt` | 两序注入原始输出（各 1 passed） |
| `order_independence/{order_kline,order_fills}.json` | 两序 DOM/store/像素/几何/响应时序读数 |
| `order_independence/{markers,jump}_{kline,fills}.png` | 像素证据截图（两序 sha 相同） |
| `runs/r00.txt … r09.txt` + `runs/r0N/*.json` + `runs/timings.txt` | 10 次全量原始输出、逐例耗时表与结构化读数 |
| `spec_adr028-window-sync.txt` / `spec_adr028-axis-align-probe.txt` / `spec_adr028-resize-probe.txt` | 三个 tester 规格回归输出 |
| `tsc_b.txt` / `vitest_subset.txt` | `tsc -b` exit 0（零输出）与 14 文件 / 82 测试 passed |
| `KlineChart_pre_mutation.tsx` / `mutant_build.txt` / `mutation_kline_delayed.txt` / `mutation_fills_delayed.txt` | 变异前源码留档、变异 bundle sha、两序变异红输出 |
| `restore_build.txt` / `post_restore_*.txt` / `post_restore/` | 还原构建（bundle 逐字节一致）+ 还原后两序注入与全量复跑 |
| `latent_probe.txt` / `latent_probe/latent_code_period.json` / `probe_source_zz_latent_code_period.test.tsx` | 同类位置 #2 探针输出、读数、源码留档 |
| `hygiene.txt` | 收尾进程/产物/内存卫生快照 |

---

## 10. 报告自指

本文件位置：**`tester/evidence/20260920_marker_race_verify/report.md`**（原始输出与像素证据：`tester/evidence/20260920_marker_race_verify/raw/`）。
本波**未**新增永久测试（无 `tester/design/` 产物）：所有新增工件为临时取证（e2e 注入规格 + 单测探针），跑完即删并归档源码；唯一永久改动为 §6 的规格常量两行。
