# ADR-027/028 时间轴对齐修复 —— **tester 独立复验报告**（2026-09-20）

> **本文件位置**：`tester/evidence/20260920_adr027_axis_verify/report.md`
> **被测产物**：`web/dist` = `assets/index-Bv7MKg8J.js`（sha256 `dec86283e2169402aaa54a9ff8b958601c92e3eb5a2d7be90287a648b4ed8733`；由 8081 后端静态提供）
> **目标 run**：`sr_1789832517800_000006`（518880 / M5 / 1949 根；含周末 239400s、隔夜 66600s、午休 5400s 缺口）
> **探针（tester，本波修正为 v2）**：`web/e2e/adr028-axis-align-probe.e2e.ts`；设计说明 `tester/design/303_adr027_axis_verify_probe_v2.md`
> **执行报告**：`tester/test/303_adr027_axis_verify_execution.md`
> **口径依据**：架构师裁决（本波）—— 偏差唯一有效口径 = **同一根 bar（同一 ts）在 K 线与各曲线图上的 x 坐标配对偏差**，判据 ≤2px（984px 参考宽度）
> **纪律**：单车道；禁止改生产代码（变异为**临时注入 + 逐字节还原**）；playwright 只跑指定规格；vitest 单文件 `--maxWorkers=1`；一律 `timeout` 前缀；每步记 `free -h`；跑完核进程卫生

---

## 0. 判词（前置，单行）

**六态偏差**（`max|Δ984| px` / 括号内 `max|Δraw| px`）：**初始 0.05（0.03）｜ 跟随最新 0.05（0.03）｜ 左滚若干根 0.05（0.03）｜ 全览 0.05（0.03）｜ 120 根跳转 0.05（0.03）｜ 300 根 0.98（0.51）**
｜ **是否全态 ≤2px：是**（六态齐备，另附无缺口对照态 0.86/0.58）
｜ **跟随性：通过**（七态「曲线首/末渲染顶点 = K 线首/末可见 bar」，覆盖率全 1.000，跨度差 ≤0.12px，无未覆盖 bar）
｜ **原子性：通过**（静止态不变量全绿 + 切换期逐帧签名无非原子混合；变异注入「旧数据+新域」能被判红）
｜ **披露：通过**（全览 `显示 614 / 共 1949 根（31.5%）` 数值与真身一致；钳位披露到位；降级链两档注入均出 `wb-axis-degraded`；剔除点数与真值对账一致）
｜ **无回归：绿**（`tsc -b` exit 0；冻结规格 `adr028-window-sync.e2e.ts` 6 passed；单测子集 6 文件 67 tests 全绿；探针 2 passed）
｜ **变异反证：有牙**（M1「曲线映射改回 ts 线性」→ 主口径 120~352px 变红；M2「撤销回到全区的重取」→ 全览态 426px / 旧数据+新域 变红；两次还原后源码与 bundle **逐字节一致**）
｜ **总判词 = 放行**（无阻断项；残余观察见 §9，均非阻断）

---

## 1. 口径修正：为什么本波不能用上一轮的主口径（并证明这是「修正」不是「放宽」）

### 1.1 裁决要点与本探针的处置

| 项 | v1（上一轮） | v2（本波，已修正） |
|---|---|---|
| 主口径 | 曲线**渲染 x** 按「ts 线性」反解成 ts，再与同 ts 的 K 线像素比（`Δ984`） | **同一根 bar 配对**：曲线渲染顶点 ↔ 该 bar 在 K 线上的**真身像素**（`convertToPixel`） |
| 前提 | 曲线必须按 ts 线性绘制 | 无（只依赖 ts 最近邻 + 容差 ≤150s） |
| 修复后有效性 | **失效**（曲线已改 bar 索引空间，反解与渲染不同源） | 有效 |
| 判据 | ≤2px | **不变：≤2px**（`max|Δ984|` 且 `max|Δraw|`） |
| 旧口径 | —— | **保留为诊断字段** `legacy.tsLinearInverseSolve984`，字段内标注 `applicableTo: '仅适用于修复前口径（曲线按 ts 线性绘制）'`，代码路径逐行保留 |

### 1.2 「修正而非放宽」的可判别性证明（三件证据）

**(a) 判据阈值未动**：v2 仍用 ≤2px，且**同时**要求归一化 `Δ984` 与**未归一化真身屏幕像素** `Δraw` 双口径达标（比 v1 更严：v1 主判据只看归一化值）。

**(b) 旧映射下新口径与旧口径**同时**爆红 ⇒ 新口径不比旧口径宽松**。本波临时把曲线映射改回 ts 线性（变异 M1，注入后 `tsLinearResidualMaxUser = 0.05` 证明渲染确实是 ts 线性）：

| 态（M1 = ts 线性映射） | 新主口径 max\|Δ984\| | 新主口径 max\|Δraw\| | 旧口径（legacy 反解） | 索引空间残差（user unit） |
|---|---|---|---|---|
| 初始 | **352.36** | **219.15** | **352.36** | 352.36 |
| 跟随最新 | **120.45** | **74.92** | 120.45 | 120.45 |
| 全览 | **140.36** | **1117.29**（曲线 1949 点全绘，几何错位极端） | 108.21 | 1793.50 |
| 120 根跳转 | **280.15** | **173.67** | 280.15 | 280.15 |
| 300 根 | **221.80** | **138.03** | 221.62 | 222.56 |
| 无缺口对照 | **211.61** | **130.59** | 211.57 | 211.43 |

⇒ 在**ts 线性**（= 修复前同类映射）下，两口径**数值几乎相同**（如初始态 352.36 / 352.36；对照态 211.61 / 211.57）。
即：新口径并非「换了把只看小数的尺子」，而是**对同一真实错位给出同等量级、同等灵敏度的读数**。

**(c) 修复后两口径分离，且分离原因被独立观测证实**：修复后（真产物）同态下
旧口径仍为 **347.39 / 274.38 / 220.32 / 132.78 / 120.06 px**，而新口径为 **0.05~0.98px**；
同时本探针的**映射身份**字段对同一批渲染顶点给出：`indexResidualMaxUser = 0.04~0.05`（索引空间预测残差 ≈0）、
`tsLinearResidualMaxPx984 = 120.5~352.4`（ts 线性预测残差巨大）。
⇒ 渲染确实是 **bar 索引空间**绘制，旧口径的反解假设「曲线按 ts 线性」已不成立；旧口径在此测的是
「K 线按 ts 插值 vs ts 线性」之差，**与曲线怎么画无关** ⇒ 属**度量口径错误**（与修复方 §3 的判断一致，本波独立复现）。

**(d) 判据分辨率**（有牙粒度）：984px / (N−1) 根 ⇒ 初始态 1 根 ≈ 9.6px、120 根态 ≈ 8.1px、300 根态 ≈ 3.1px、全览/613~614 根态 ≈ 1.6px。
即除最宽态外，**1 根 bar 的映射偏移都远超 2px 判据**；最宽态亦能识别 ≥2 根偏移。

---

## 2. 主口径结果：六态同一根 bar 配对偏差（真实渲染，原始输出）

**方法**：曲线渲染 `<polyline>` 顶点 ↔ `/curve` 数据点 ts（一一带出）↔ K 线**真身**可见 bar（`convertToPixel({timestamp}).x + 容器 left`），
ts 最近邻配对（容差 150s，单调一对一）。`Δ984 = ((xK−xK₀)/spanK − (xC−xC₀)/spanC) × 984`（锚点 = 配对首末）；`Δraw = xK − xC`。

| 态 | 窗口来源 | K 线可见 bar | 配对点数 | **max\|Δ984\|** | **max\|Δraw\|** | 曲线 plot 覆盖率 | 判据 ≤2px |
|---|---|---|---|---|---|---|---|
| ① 初始 | `kline`（103 根） | 103 | 103 | **0.05** | **0.03** | 1.0000 | ✓ |
| ② 跟随最新（K 线推到最新 bar：`toIdx=998=dataLen−1`） | `kline`（613 根） | 613 | 613 | **0.05** | **0.03** | 1.0000 | ✓ |
| ③ 左滚若干根（真手势左滚 194 根：`toIdx 999→805`） | `kline`（614 根） | 614 | 614 | **0.05** | **0.03** | 1.0000 | ✓ |
| ④ 全览 | `full` | 614 | 614 | **0.05** | **0.03** | 1.0000 | ✓ |
| ⑤ 120 根跳转（L2） | `jump`（123 根） | 123 | 123 | **0.05** | **0.03** | 1.0000 | ✓ |
| ⑥ 300 根（滚轮缩小 8 步） | `kline`（317 根） | 317 | 317 | **0.98** | **0.51** | 1.0000 | ✓ |
| ⑦ 补充：无缺口对照（滚轮放大 22 步，36 根） | `kline`（36 根） | 36 | 36 | 0.86 | 0.58 | 1.0000 | ✓ |

- 测量有效性（恒真反证，全部通过）：K 线真身可读；相邻 bar 像素间隔 ≈ `barSpace`（每 bar 一槽）；
  曲线已渲染；**配对点数 = 渲染顶点数**（`unpairedVertices = 0`，无「配不上就跳过」）；无重复配 bar；
  正常态映射声明 = 主路 `index`（非降级）。
- **残留偏差与缺口无稳定关联**：各态 argmax 两侧间隔几乎全为 300s（如初始态 argmax ts=1789613100、300 根态 ts=1789540500，前后均 300s），
  量级 ≤1px ⇒ 属**引擎整数像素取整**（`convertToPixel` 取整 + 小数 `barSpace` 的 floor/ceil 交替），而非缺口折叠。
  这与修复前「argmax 恒落在 66600s/239400s 大缺口邻域且量级 169~352px」形成直接对照（v1 报告 §2.2）。
- 无缺口对照态（36 根、仅 1 个 5400s 缺口）0.86px ⇒ 与缺口态同量级 ⇒ 剩余偏差与缺口无关。

**与修复前对照（同一 testid / 同一 run / 同一 8081 静态口径）**

| 项 | 修复前（v1 原始读数） | 修复后（本波） |
|---|---|---|
| 全览态曲线渲染顶点数 | **89**（`/curve` 1949 点） | **614**（= K 线实际可见 bar 数） |
| 全览态曲线 plot 覆盖率 | **0.0253**（挤在右端 2.5%） | **1.0000** |
| 初始态曲线覆盖率（首→末 userX 覆盖） | 0.9971 | 1.0000 |
| 曲线右端固定缺口 | 2.9 / 1.6 / 0.6 / 0.4 px@984（`tail`） | **0.00 px**（七态） |
| 窗口覆盖（可见 ts ÷ 窗口 ts） | 1.680 / 1.309 / 1.661 / 27.0（≠1） | **1.000**（除全览 = E4 冻结口径，见 §9-3） |

> 修复前数据来源：`tester/evidence/20260920_adr027_axis_align/raw/`（v1 探针原始产物，未改动）。

---

## 3. 跟随性（逐态「曲线首/末点 ↔ K 线首/末可见 bar」配对偏差）

| 态 | 曲线顶点 vs 可见 bar | 首点 Δraw / Δ984 | 末点 Δraw / Δ984 | 首末覆盖（head/tail 未覆盖 bar） | 曲线跨度 − K 线跨度 | 判据 |
|---|---|---|---|---|---|---|
| 初始 | 103 = 103（全 bar 被覆盖） | 0.00 / 0.00 | 0.00 / 0.00 | 0 / 0 | 0.00 px | ✓ |
| 跟随最新 | 613 = 613 | 0.00 / 0.00 | 0.00 / 0.00 | 0 / 0 | 0.00 px | ✓ |
| 左滚若干根 | 614 = 614 | 0.00 / 0.00 | 0.00 / 0.00 | 0 / 0 | 0.00 px | ✓ |
| 全览 | 614 = 614 | 0.00 / 0.00 | 0.00 / 0.00 | 0 / 0 | 0.00 px | ✓ |
| 120 根跳转 | 123 = 123 | 0.00 / 0.00 | 0.00 / 0.00 | 0 / 0 | 0.00 px | ✓ |
| 300 根 | 317 = 317 | 0.00 / 0.00 | −0.12 / 0.00 | 0 / 0 | 0.12 px | ✓ |
| 无缺口对照 | 36 = 36 | 0.00 / 0.00 | −0.09 / 0.00 | 0 / 0 | 0.09 px | ✓ |

读法：**曲线不是「贴满框」**——每态曲线覆盖的正是 K 线**当前可见 bar 序列**（逐 bar 一一对应），
K 线左滚（③）后窗口态同步变为 `kline|614 根|[1787725500,1789350900]`，曲线跟随同一区间；
`tail/headDeficitPx984` 全 0（修复前 2.9/1.6/0.6/0.4）。
手势可用性（`raw/pan_gesture_probe.json`）：拖拽 +120px ⇒ `to −120`；拖拽 −120px ⇒ `to +120`；横向滚轮 ±200 ⇒ `to ±194`（**真手势平移可用**，跟随/左滚两态均由真手势达成，未使用引擎回退）。

---

## 4. 数据/定义域原子性

### 4.1 静止态不变量（七态全绿）

| 不变量 | 判据 | 实测 |
|---|---|---|
| 渲染数据 ⊂ **声明定义域**（±150s） | 禁「新数据 + 旧域」 | 七态 true |
| 渲染数据 ⊂ **K 线可见 bar 区间**（±150s） | 禁「旧数据 + 新域」/ 两图区间不相交 | 七态 true |
| 曲线 plot 覆盖率 = 1.000 | 修复前全览 0.0253 | 七态 1.0000 |
| 全部可见 bar 被曲线覆盖 | 禁右端固定少 1 根 | `barsCovered == visibleBars`（103/103、614/614、613/613、123/123、317/317、36/36） |

### 4.2 切换期逐帧采样（50ms 采样；渲染签名 = `mode|顶点数|首末 userX|ΣuserX|viewBox`）

| 切换 | 样本 | 加载态样本 | 非加载态样本 | 签名 = 切换前 | 签名 = 切换后 | 空白帧 | **非原子混合** | 单帧（≤50ms）旧签名残留 |
|---|---|---|---|---|---|---|---|---|
| 初始 → 全览 | 53 | 0 | 52 | 2 | 51 | 0 | **0** | 1（未达「连续 ≥2 帧」判红阈值，见 §9-1） |
| 左滚态 → 120 根跳转 | 56 | 1 | 52 | 4 | 52 | 0 | **0** | 0 |

⇒ 切换期间渲染签名**只取「切换前整组快照」或「切换后整组快照」**，未观测到「新几何 + 旧数据」之类的混合；
且窗口 `applying` / `窗口加载中` / `窗口已应用` 文案随帧流转。

### 4.3 该检查「有牙」：变异 M2（撤销「回到全区间」的重取）

注入后（`raw/mutations/m2_no_full_refetch/`）全览态实测：
**曲线渲染 103 点（= 初始窗口的数据）而 K 线可见 614 根**，`Δraw = 426px`、`indexResidualMaxUser = 820.27`、
`follow.ok = false`、`atomic.ok = false`（`数据区间 [1789454700,1789628100] ∉ K 线可见区间 [1787725500,1789350900]`）
⇒ 正是修复前的「旧数据 + 新域」缺陷类，被本波不变量**判红**。

---

## 5. 披露类

| testid | 态 | 实测文本 / 数值 | 与真身对账 |
|---|---|---|---|
| `wb-window-cap` | 全览 | `全览：显示 614 / 共 1949 根（31.5%；受渲染上限约束：barSpace ≥ 1 + 面板宽度 + dataList 页大小）` | N=614 **=** 真身可见 bar 数；M=1949 **=** run 总根数（`/bars?kind=per_bar.total`）⇒ 数值正确 |
| `wb-window-clamped` | 120 根跳转 | `窗口被钳位（引擎实测 ≠ 请求）：请求 [1789524000, 1789559700]（120 根）⇒ 实际 [1789448700, 1789628100]（123 根）` | 端点/根数取自真身回执 ⇒ 一致 |
| `wb-curve-unmatched` | 全览 | `· 1335 点不在 K 线 bar 序列上（已剔除）` | 1335 **=** 1949 − 614 ⇒ 数值正确 |
| `wb-axis-degraded` | 注入①（K 线 bar 序列不可得） | 初始 8s 内：`时间轴降级（ts 线性…）：K 线 bar 序列与 run per_bar 均不可得`；**切换一次 Tab 触发再渲染后**：`时间轴降级（run per_bar 索引）：K 线所绘制的 bar 序列不可得 ⇒ 与 K 线蜡烛位置不保证对齐`，`data-x-mode = index` | 两档均出文案（禁静默）；档位后发见 §9-2 |
| `wb-axis-degraded` | 注入②（K 线 + per_bar 均不可得） | `时间轴降级（ts 线性，与 K 线可能存在缺口偏差）：…`，`data-x-mode = ts` | 终档披露到位 |
| `data-x-mode` | 正常七态 | 全为 `index`（主路） | 与 `indexResidual ≈ 0.05` 自洽 |

注入手段：`page.route('**/api/kline**')` 返回 `bars: []`（K 线 bar 序列不可得）；再加
`page.route('**/api/workbench/runs/**/bars**')`（`kind=per_bar`）返回空（per_bar 亦不可得）。网络留痕见
`raw/degraded_inject1_kline_empty.json` / `raw/degraded_inject2_ts_linear.json`（含每请求 URL/状态/点数摘要）。

---

## 6. 无回归

| 项 | 命令 | 结果 |
|---|---|---|
| 冻结 E2E（断言未放松） | `timeout 900 … playwright test e2e/adr028-window-sync.e2e.ts --reporter=list --retries=0` | **6 passed（23.1s）**：E1 / E2 / E3 / E4 / M1 / M2 全绿 |
| 类型检查 | `timeout 600 npx tsc -b --force` | **exit 0** |
| 单测子集（逐文件 `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`） | vitest run `<file>` | **67 passed / 0 failed / 0 skipped**（chartUtils 17、resultWindow 33、resultAxisIndex 4、useRunSeries 6、KlineChartVisibleRange 5、resultBarSpaceLimit 2） |
| 探针 v2 | 2 用例 | **2 passed（43.4s）** |
| 进程卫生 | `pgrep -af "[v]ite preview"` / `pgrep -c chromium` / `ps \| grep headless_shell` | 空 / 0 / 无残留 |

---

## 7. 变异反证（反假绿）明细与还原

### M1 —— 把曲线映射改回 **ts 线性**（`web/src/features/backtest/chartUtils.ts`，`curveXs` index 分支）

- 注入后 `tsLinearResidualMaxUser = 0.05`（渲染确实是 ts 线性）、`indexResidualMaxUser = 120~1793`
  ⇒ 声明 `index` 与渲染不符，**首先**触发红（`raw/mutations/m1_ts_linear/playwright.log`）。
- 主口径同时爆红：`max|Δ984| = 120.45 ~ 352.36px`、`max|Δraw| = 74.92 ~ 1117.29px`（全部 ≫ 2px）。
- 旧口径与主口径在该映射下**收敛到同一数值**（初始 352.36 / 352.36；对照 211.61 / 211.57）
  ⇒ 证明这正是上一轮测得 283~352px 的同一真实错位，**新口径能测到它**（口径修正 ≠ 放宽）。

### M2 —— 撤销「回到全区间（window=null）」的重取（`web/src/features/workbench/useRunSeries.ts`）

- 全览态：曲线 103 点（初始窗口数据）+ 全区间定义域 ⇒ `Δraw = 426px`、`follow.ok=false`、`atomic.ok=false`
  ⇒ 「旧数据 + 新域」被本波不变量判红（`raw/mutations/m2_no_full_refetch/playwright.log`）。

### 还原（逐字节一致）

| 项 | 变异前 | 还原后 |
|---|---|---|
| `web/src/features/backtest/chartUtils.ts` sha256 | `466e18d91667a681a5326706f54d919df29158d123f175cabe42225ad61de4ac` | **同值** |
| `web/src/features/workbench/useRunSeries.ts` sha256 | `1c4b00b1986b28b121a5a00d5c5fee319ab7a33a4b4445df3dfe5e45c23a830c` | **同值** |
| 重建产物 `web/dist/assets/index-*.js` sha256 | `dec86283…`（`index-Bv7MKg8J.js`） | **同值**（并确认 8081 重新提供 `index-Bv7MKg8J.js`） |
| 探针复跑（还原后） | 2 passed | **2 passed（43.4s）** |
| 其它生产文件 | — | `git diff -- web/src` 为空（无残留改动） |

---

## 8. 复现步骤（他人可一键重跑）

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
# 前置：8081 已在跑，静态 = web/dist（本波产物 index-Bv7MKg8J.js）；无需 vite preview
free -h
timeout 10 curl -s --max-time 5 http://localhost:8081/ | grep -o "index-[A-Za-z0-9_-]*\.js"   # => index-Bv7MKg8J.js

cd web
# ① tester 探针 v2（六态配对 + 跟随 + 原子 + 披露 + 降级注入）
timeout 900 env E2E_BASE_URL=http://localhost:8081 \
  ADR027_ALIGN_OUT=/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/20260920_adr027_axis_verify/raw \
  npx playwright test e2e/adr028-axis-align-probe.e2e.ts --reporter=list --retries=0

# ② 冻结回归（断言不得放松）
timeout 900 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list --retries=0

# ③ 类型检查 + 单测子集
timeout 600 npx tsc -b --force
for f in src/features/workbench/{chartUtils.test.ts,resultWindow.test.ts,resultAxisIndex.test.tsx,useRunSeries.test.ts,resultBarSpaceLimit.test.tsx} src/features/dashboard/KlineChartVisibleRange.test.tsx; do
  timeout 600 env NODE_OPTIONS=--max-old-space-size=2048 npx vitest run "$f" --maxWorkers=1
done

# ④ 进程卫生
pgrep -af "[v]ite preview"; pgrep -c chromium
```

变异复现（可选，须逐字节还原）：对 `web/src/features/backtest/chartUtils.ts` 的 `curveXs` index 分支注入 ts 线性映射，
或对 `web/src/features/workbench/useRunSeries.ts` 的取数 effect 增加
`if (reqFrom == null && reqTo == null && firstLoadDoneRef.current) return () => undefined;`，
`npm run build` 后跑 ①，观察变红；随后 `cp` 还原 + `npm run build`，核对 sha256。

---

## 9. 残余与观察（未做 / 非阻断，如实披露）

1. **切换期单帧（≤50ms）旧签名残留**：全览切换的 53 个样本中有 **1 帧**（窗口态已变 `full`、K 线已在新区间，但曲线仍是切换前 103 点快照，
   且该帧无「加载中」文案）。因仅 1 帧（< 连续 2 帧 = 100ms 判红阈值）未判红——判红阈值即为此设定，避免 React「先提交窗口态、后跑 effect 置加载态」
   的固有单帧竞态误报。**属 ≤1 帧的视觉瞬变，非阻断**（原始样本在 `raw/transitions.json → full.rawSamples`）。
2. **降级链档位②（per_bar 索引）后发**：注入「K 线 bar 序列不可得」后，页面在 8s 观测窗内稳定停在档位③（ts 线性，`data-x-mode=ts`）；
   **切换一次 Tab 触发再渲染后**才变为档位②（`data-x-mode=index` + `per_bar 索引` 文案）。即档位② 的实现存在、但**依赖一次额外渲染**
   （`perBarRowsRef` 存在一次渲染滞后）。两档文案均到位（禁静默满足）；**档位② 的及时性作为观察项交回上层**（本角色不做归因/修复）。
3. **全览态窗口覆盖 0.398 不再计缺陷**（架构师裁决 / ADR 已冻结）：K 线受渲染物理上限（`barSpace ≥ 1` + 面板宽 + dataList 页）只可见 614/1949 根，
   判据只看像素对齐 + 披露；本波实测披露齐全且数值正确（§5）。
4. **未测**：D1 周期、其它标的、多周期栈内同类图（本波只测 M5 单图）；`wb-window-clamped` 仅观测到跳转态一处（其余态无程序化写窗）。
5. **探针视图宽度**：1280×800 视口、工作台左栏占位 ⇒ K 线 666px、曲线 SVG 同宽；绝对量级随窗口宽度变化，判据口径（≤2px）与宽度无关。
6. **本波未改动生产代码**：两处变异为临时注入且已逐字节还原（§7）；探针 v2 为 tester 自有文件（断言阈值未放松）。

---

## 10. 证据清单（`tester/evidence/20260920_adr027_axis_verify/`）

| 文件 | 内容 |
|---|---|
| `report.md` | 本报告（判词 + 全部结论） |
| `raw/summary.json` | 七态全部测量值（主口径配对、跟随、原子、披露、映射身份、诊断口径）+ 切换采样摘要 |
| `raw/verdict.json` | 判词输入（逐态 Δ 表、ok 标志、旧口径对照、可判别性、切换判词） |
| `raw/state_<态>.json` / `delta_series_<态>.json` | 单态完整读数 / 主口径逐点 Δ 序列（7 态） |
| `raw/transitions.json` | 窗口切换逐帧原始样本（初始→全览 53 帧；左滚→跳转 56 帧） |
| `raw/pan_gesture_probe.json` | 手势平移能力矩阵（拖拽/横向滚轮两方向） |
| `raw/degraded_inject1_kline_empty.json` / `degraded_inject2_ts_linear.json` | 降级注入①/② 的档位演进、属性快照、网络留痕 |
| `raw/state_<态>*.png`（每态 4 张：整页 / K 线 / 聚合 / 策略槽） | 28 张截图 |
| `raw/logs/02_tsc_b_fixed.txt`、`03_window_sync_frozen_fixed.txt`、`04_vitest_subset_fixed.txt`、`06_probe_fixed_build_green_after_restore.txt`、`05_baseline_hashes.txt`、`07_restored_hashes.txt` | 回归命令原始输出与哈希留痕 |
| `raw/mutations/m1_ts_linear/`、`raw/mutations/m2_no_full_refetch/` | 两次变异的注入 diff、构建日志、探针变红输出、变异态全部 raw |
