# ADR-028 §2.4c（D4.2）结果页视图缩放 + K 线副图指标可选 —— 实现方报告

> **本报告自身路径**：`coder/evidence/20260920_result_resize/report.md`
> 原始输出目录：`coder/evidence/20260920_result_resize/raw/`

---

## 0. 判词（一行，前置）

**指标选择 = 完成（结果页入口 6 枚 / 真身驱动 / 独立配置 key）** ｜ **K 线卡拖高 = 完成（卡片 256→406px、内层图表 194→344px 跟随；双击标题复位 256）** ｜ **曲线卡拖高 = 完成（聚合 204→264px、svg 160→220px；持仓 289→349px、svg 208→268px，均 `h-full`）** ｜ **持久化 = 完成但受通道限制（`localStorage`，**仅本机浏览器有效**——服务端无通用 KV 通道且本波禁改 Rust）** ｜ **跨图偏差：统一 PAD 前 = 2.0 user unit = 1.244px ⇒ 统一 PAD 后 = 0.0 user unit = 0px** ｜ **四规格 = 全绿**（resize-probe 1/1、window-sync 6/6、axis-align-probe 2/2、features-verify 10/10） ｜ **变异反证 = 有牙**（M1 固定 svg 高度 ⇒ D5-B 红；M2 指标硬编码看板默认 ⇒ D5-A 红；还原后 bundle 与线上逐字节一致） ｜ **未做项**：宽度缩放、表格类拖高、服务端持久化、`ComparePanel` 的 PAD 未收敛（非本波四张曲线卡）、参考线/定位等 D4 其它子项。

---

## 1. 交付清单与证据索引

| # | 交付 | 代码位置 | 证据 |
|---|---|---|---|
| 1 | 副图指标可选（复用看板实现） | `web/src/features/dashboard/IndicatorToggles.tsx`（新，共享组件 + 名单唯一来源）、`Toolbar.tsx`、`KlineResultChart.tsx`（受控 `indicators` + `toggleSlot`）、`ResultView.tsx` | `raw/d5_spec_run3_after_restore.txt`（D5-A 绿）、`raw/d5a_*.json` |
| 2 | K 线卡上下缩放 | `web/src/features/workbench/cardResize.tsx`（新：hook + `CardTitle`）、`KlineResultChart.tsx` | `raw/d5b_after_kline_drag.json`、`raw/d5_spec_run3_after_restore.txt` |
| 3 | 四张曲线卡上下缩放（svg 随容器） | `cardResize.tsx` + `AggregateScoreChart/SlotScoresChart/EquityDrawdownChart/PositionRatioChart` | `raw/d5b_after_aggregate_drag.json`、`raw/d5b_after_position_drag.json` |
| 4 | 表格类不做高度拖拽 | **未改动**（保持整页滚动） | D5-B 相位 ④ 断言（无把手、无 inline 高度）× 3 表格 |
| 5 | 消除 1.244px 系统差（PAD 单一事实源） | `web/src/features/workbench/curveGeometry.ts`（新）+ 四张曲线改别名导入 | `raw/d5c_align.json`、`curveGeometry.test.tsx` |
| 6 | 持久化（独立 key） | `web/src/features/workbench/resultChartConfig.ts`（新） | `resultChartConfig.test.ts`、D5-A ⑥ / D5-B ⑥ |

**新增单测（5 文件 / 42 例，全绿）**：
`curveGeometry.test.tsx`(9)、`resultChartConfig.test.ts`(11)、`cardResize.test.tsx`(10)、
`resultResizeIndicators.test.tsx`(7)、`dashboard/IndicatorToggles.test.tsx`(5)。
**红→绿留痕**：`raw/red_baseline.txt`（实现前 5 文件全红：「模块不存在」）。

---

## 2. 实现要点（逐项）

### 2.1 副图指标可选（复用看板）
- **名单/逻辑唯一来源** = `IndicatorToggles.tsx`：`INDICATOR_DEFS = ma/vol/macd/kdj/boll/dcap`（DCAP 名取
  `DCAP_INDICATOR_NAME`），组件为**纯受控**（只吃 `indicators` + `onToggle`，不读写任何存储）。
  `KlineChart.syncIndicators` 改为消费**同一份** `INDICATOR_DEFS`（不再有两套名单可漂移）。
- 看板 `Toolbar` 改为渲染同一组件（MA 窗口控件 / DCAP 参数面板仍以 `renderExtra` 内联在其按钮之后）
  ⇒ **零 DOM/行为回归**（`IndicatorToggles.test.tsx` S2 + 既有 `volToggle`/`dcapWiringP3` 全绿）。
- 结果页：`KlineResultChart` 的 `indicators` 从**硬编码 `DASHBOARD_DEFAULTS.indicators`** 改为**受控 prop**
  （缺省仍取 `DASHBOARD_DEFAULTS.indicators` 以保兼容），入口以 `toggleSlot` 注入 K 线卡头部
  （`data-testid="wb-indicator-toggles"`，每枚按钮 `wb-indicator-toggle-<key>` + `aria-pressed`）。
- **副图 pane 高度在切换后保持**：沿用既有差分契约（仅「启用态翻转」才 create/remove；参数变化走
  `overrideIndicator`）。实测：VOL pane 拖到 **137px** 后开 MACD ⇒ VOL 仍 **137px**，MACD 新 pane 100px
  （`d5a_after_macd_on.json`）。

### 2.2 / 2.3 卡片上下缩放（`useCardResize`）
- 把手 = 卡片内**下边缘** 6px 条（inline `cursor: ns-resize`、`data-card-resize="<id>"`），
  真鼠标 mousedown→mousemove→mouseup；松手**一次**提交；上/下限 120–1200px。
- 受控高度下卡片写 `height:<px>` + **`flex-shrink:0`**（探针实测：不写 shrink 会被 flex 列吞回默认高）。
- 内层图随容器：曲线卡 svg 由固定 `h-40/h-36/h-52` 改为 `flex-1 min-h-0` 包裹 + `h-full w-full`
  （**仅受控态**切换 ⇒ **默认渲染逐像素不变**）；K 线卡沿用既有 `min-h-0 flex-1`，klinecharts 自身重排。
- **双击卡片标题复位**：`data-testid="wb-card-title-<id>"`（K 线卡标题 = 既有 `K线 518880（M5）` 文本，
  未新增行；四张曲线卡新增 1 行 14px 标题行，兼作复位入口）。
- **表格类零改动**：三处表格无把手、无 inline 高度（D5-B 相位 ④）。

### 2.5 PAD 统一（**四处收敛为一处**）
```
- web/src/features/workbench/AggregateScoreChart.tsx : -const W = 1000; -const H = 160; -const PAD = 8;
- web/src/features/workbench/SlotScoresChart.tsx     : -const W = 1000; -const H = 160; -const PAD = 8;
- web/src/features/workbench/EquityDrawdownChart.tsx : -const W = 1000; -const H = 220; -const PAD = 10;
- web/src/features/workbench/PositionRatioChart.tsx  : -const W = 1000; -const H = 220; -const PAD = 10;
+ 四文件均改为：import { CURVE_PAD as PAD, CURVE_W as W } from './curveGeometry';
+ web/src/features/workbench/curveGeometry.ts（新）：export const CURVE_PAD = 8; export const CURVE_W = 1000;
```
守卫（`curveGeometry.test.tsx`）：①`CURVE_PAD === 8` 钉死 + 注释写明「改它必须同步改冻结规格」；
②源码扫描断言四文件**不得**再出现自有 `const PAD`/`const W` 且必须从 `./curveGeometry` 导入；
③运行期三图 polyline 首末 userX === 8 / 992；④跨视图同 bar userX 差 ≤0.1。

### 2.6 持久化（独立 key）
- key = `eestock.wb.result.chartConfig.v1`，形状 `{ indicators, cardHeights:{kline,aggregate,slot,equity,position} }`；
  解析**净化**（坏 JSON/未知键/非整数/越界 ⇒ 回默认或夹紧，不静默采纳半坏状态）。
- **配置隔离**实测：保存后 `localStorage` **只有这一个键**；预置看板键 `eestock.dashboard.layout.v1` 不影响
  结果页读取；结果页不引用任何看板存储键（源码级断言）。
- ⚠ **通道披露**：服务端 `app_config` 只有**专用键**端点（`crates/web/src/lib.rs:67-77`：
  `sources/collector/mcp/ma/kline/dcap/multi_period`），**无通用 KV**，且本波**禁改 Rust** ⇒ 用 `localStorage`。
  **仅本机浏览器有效**：换浏览器/设备/清缓存即回默认（服务端不存在该配置）。

---

## 3. 与 ADR-028 §2.4c 建议值的偏离说明（D4.2-5）

| 项 | ADR 原建议 | 本波实际 | 原因（证据） |
|---|---|---|---|
| 四张曲线 PAD | **统一为 10**（与净值/持仓一致） | **统一为 8**（与聚合/各策略一致） | 冻结规格 `web/e2e/adr028-axis-align-probe.e2e.ts` **硬编码** `CURVE_PAD = 8 / PLOT_W = 984`（L54-57），并用 `predictIndexUserX(j) = 8 + j/(N−1)×984` 与渲染 userX 比对，硬断言 `indexResidualMaxUser ≤ 1`（L1630-1633，属「配对可信」自校验门，非可放宽余量）。若取 10：|Δ| = |−2 + 4f| ∈ [0,2] ⇒ 端点 2.0 > 1 ⇒ **该规格必红**；而「四规格全绿 + 禁止修改」是本波硬约束。取 8 则跨视图偏差 = 0.0 user unit（达标 ≤0.1px），且四规格全绿。**已由父层裁决（方案 A）并授权**。ADR 文本由父层同步修订。 |

---

## 4. 冻结规格常量更新（父层授权，方案 B）

**文件**：`web/e2e/adr028-features-verify.e2e.ts`（**仅 2 行**，T0 真身锚定）

| 常量 | 旧值 | 新值 |
|---|---|---|
| `EXPECT_BUNDLE_NAME` | `index-BY728MHs.js` | `index-xGaRgVd-.js` |
| `EXPECT_BUNDLE_SHA256` | `f2504232e7a4fba582943fdbe020235013fef27752313db6cc69531f37d0fa0e` | `8d936e11f5d0d448434cf0d6907d8d907f0e544e8bd0a2805d1d06433993a8bc` |

**新值来源**：`curl -s http://localhost:8081/ | grep -o 'assets/index-[^"]*\.js'` ⇒ `index-xGaRgVd-.js`；
该文件 sha256 实测 = 上表新值；**被服务响应体与 `web/dist` 磁盘文件逐字节一致**（同 hash）。

**非放宽证据**：断言形式**未变**——仍是 `toContain(EXPECT_BUNDLE_NAME)`（名）+ `toBe(EXPECT_BUNDLE_SHA256)`
（**精确等值**，非 `skip`/非 `toMatch`/无 env 旁路）+「served == 磁盘」逐字节比对；T0 真跑 **passed**。

**除这两行外零改动**（`git diff --numstat` = `2 2 web/e2e/adr028-features-verify.e2e.ts`）：
```
-const EXPECT_BUNDLE_NAME = 'index-BY728MHs.js';
-const EXPECT_BUNDLE_SHA256 = 'f2504232…0fa0e';
+const EXPECT_BUNDLE_NAME = 'index-xGaRgVd-.js';
+const EXPECT_BUNDLE_SHA256 = '8d936e11…93a8bc';
```

---

## 5. 判据自测（原始输出）

### 5.1 真渲染（Playwright 自建规格 `web/e2e/adr028-d5-resize-indicators.e2e.ts`，3 test / 27.3s）
`raw/d5_spec_run3_after_restore.txt`：**3 passed**（`D5-A` 指标选择、`D5-B` 卡片缩放、`D5-C` 对齐）。

| 判据（任务 §判据 1） | 实测 | 证据文件 |
|---|---|---|
| 拖 K 线卡下边缘 ⇒ 卡片与内层图表高度跟随 | 卡 **256→406**，内层 **194→344**（+150 全量传导） | `d5b_after_kline_drag.json` |
| 拖曲线卡下边缘 ⇒ svg 高度跟随 | 聚合 卡 **204→264** / svg **160→220**（class `h-full w-full`）；持仓 卡 **289→349** / svg **208→268** | `d5b_after_aggregate_drag.json`、`d5b_after_position_drag.json` |
| 双击标题 ⇒ 复位 | K 线卡回 **256**（inline 高度清空）；聚合卡回 **204**、svg 回 **160**（class 回 `h-40 w-full`） | 同上（相位 ⑤ 断言） |
| 切换副图指标（VOL→MACD）⇒ 副图变化且已拖过的 pane 高度保持 | 拖后 VOL pane **137px**（candle 30px 触底）；开 MACD ⇒ 真身 `['MA','VOL','MACD']`，**VOL 仍 137px**；关 VOL ⇒ `['MA','MACD']`、副图 pane 数 = 1（无残留空 pane） | `d5a_after_sep_drag.json`、`d5a_after_macd_on.json` |
| 刷新页面 ⇒ 卡片高度与指标选择保持 | K 线卡 **376→376**（内层 314）、指标 `vol=false/macd=true` 且真身 `['MA','MACD']` | `d5b_after_reload.json`、D5-A ⑥ 断言 |
| 表格类不做高度拖拽 | 回合表/逐bar/事件日志：`handles=0`、`inlineHeight=null` | D5-B 相位 ④ |

### 5.2 对齐回归（拖高态：K 线卡 480px + 聚合卡 +150px）
`raw/d5c_align.json`（口径 = tester v2 的「同一根 bar 配对 + 锚定去线性漂移」，阈值不放宽）：

| 视图 | 配对点数 | max\|Δraw\|（锚定） | max\|Δ984\| | plot 左/右 = 8 / 992 |
|---|---|---|---|---|
| 聚合分 | 103 | **0.03px** | **0.05px** | ✓ |
| 各策略评分 | 103 | **0.03px** | **0.05px** | ✓ |
| 净值+回撤 | 103 | **0.03px** | **0.05px** | ✓ |
| 持仓比率 | 103 | **0.03px** | **0.05px** | ✓ |

**跨视图同一根 bar 的 userX 差**（统一 PAD 前 / 后）：各策略 **2.0 → 0.0**、净值 **2.0 → 0.0**、
持仓 **2.0 → 0.0** user unit（666px 卡宽 / viewBox 1070.82 ⇒ **1.244px → 0px**，达 ≤0.1px 目标）。
> 「同一根 bar」采用**配对**口径（禁「假设 ts 线性反解」）；x 方向变化不影响 y 观感（y 映射 `H`/`PAD` 未动，
> 净值/持仓仅左右各少 2 user unit 留白）。

### 5.3 无回归（四个 tester 规格，**未修改其中三个**）

| 规格 | 结果 | 输出 |
|---|---|---|
| `adr028-resize-probe.e2e.ts` | **1 passed（36.2s）** | `raw/frozen_resize_probe.txt` |
| `adr028-window-sync.e2e.ts` | **6 passed（23.6s）** | `raw/frozen_window_sync.txt` |
| `adr028-axis-align-probe.e2e.ts` | **2 passed（43.6s）** | `raw/frozen_axis_align.txt` |
| `adr028-features-verify.e2e.ts` | **10 passed（1.1m）**（含 T0 锚定） | `raw/frozen_features_verify.txt` |

- `tsc -b`：**退出码 0**（多条命令实跑：`npx tsc -b`；收尾复跑仍 0）。产物：`web/dist/assets/index-xGaRgVd-.js`
  sha256 `8d936e11…93a8bc`，**与 8081 被服务响应体逐字节一致**（收尾复核）。
- 相关单测子集（逐文件单跑、`--maxWorkers=1`）：`raw/unit_subset.log`
  —— `ResultView`(27)、`resultAxisIndex`(4)、`resultWindowSync`(6)、`resultWindow`(33)、`volToggle`(14)、
  `dcapWiringP3`(14)、`adr028FocusHighlight`(6)、`adr028LayoutFix`(7)、`roundTripLayers`(6)、
  `resultBarSpaceLimit`(2)、`multiPeriodSatellite`(10)、`WorkbenchPage`(14) **全绿**；新增 5 文件 42 例全绿。

### 5.4 反假绿（变异反证，**有牙**）

| 变异 | 内容 | 结果 | 证据 |
|---|---|---|---|
| **M1** | 聚合卡 svg 改回固定 `h-40`（`resize.svgClass(...)` → 恒 `'h-40 w-full'`） | **D5-B 红**：`曲线卡 svg 必须随容器（拖前 160 → 拖后 160）` 期望 ≥200 | `raw/mutation_m1_fixed_svg.txt` |
| **M2** | `KlineResultChart` 的 `indicators` 改回硬编码 `DASHBOARD_DEFAULTS.indicators` | **D5-A 红**：`开 MACD ⇒ 真身出现 MACD`（真身无变化） | `raw/mutation_m2_hardcoded_indicators.txt` |

**还原验证**：两处变异回滚后重建，产物与线上 bundle **逐字节一致**（同名 `index-xGaRgVd-.js`，同 sha256
`8d936e11…93a8bc`）；还原后重跑 D5 规格 **3 passed**（`raw/d5_spec_run3_after_restore.txt`）。

---

## 6. 资源纪律证据

| 项 | 事实 |
|---|---|
| 单车道 | 未 spawn 子代理；全程唯一活跃车道 |
| vitest | 逐文件单跑 + `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048` |
| playwright | 只跑相关规格（1 自建 + 4 冻结；每次 `timeout 900/1500/2400`）；**未起 `vite preview`**（复用已在跑的 8081 主机进程） |
| `free -h` | 全过程记录于 `raw/resource_discipline.md`（起测 9.6Gi free / 28~29Gi avail；真渲染峰值观测 7.8Gi free / 26Gi avail；收尾 8.8Gi free / 27Gi avail）——无异常增长，无 OOM |
| 收尾残留 | `raw/resource_discipline.md`：`/proc` 枚举（先按 `comm` 排除自查 shell）⇒ `vite preview` / `ms-playwright` / `headless_shell` / `chrome-linux` 残留 = **0**；8081 仍 **200** |
| grep/find | 均带 `--exclude-dir`/限定路径（`--exclude-dir` 不支持的 find 场景改用 `rg`/限定目录） |
| 副作用清理 | 跑冻结规格会**覆盖它们自己的历史证据**（`coder/evidence/20260920_adr027_p9c_final/raw/`、`tester/evidence/20260920_adr027_axis_verify/raw/`、`tester/evidence/20260920_adr028_features_verify/raw/` 的 json/png，差异仅 `rev` 等运行相关值）⇒ 已 `git checkout --` **还原**（本波 stdout 结果另存于 `raw/frozen_*.txt`）；工作树非本波改动仅剩波前既有的两份 ADR 文档 |

---

## 7. 未做项 / 残余风险（诚实边界）

1. **不做宽度缩放**（与 ADR §2.4c 第 2 条一致：宽度变化会破坏共用绘图区几何）。
2. **表格类不做高度拖拽**（与第 3 条一致，保持整页滚动）。
3. **持久化仅本机浏览器有效**（`localStorage`，见 §2.6；服务端通用 KV 缺失且禁改 Rust）。
4. **`ComparePanel.tsx` 仍有自有 `PAD = 10`**（页面⑤ 对比区，**不是**本波的四张结果页曲线卡）——
   未收敛，登记为技术债；若把它也并入 `curveGeometry`，需先确认该面板的对齐判据锚点。
5. **曲线卡新增 1 行 14px 标题行**（复位入口）：卡默认高度 186/190/218/271 → 204/208/236/289（实测），
   页面总高增加 ~56px；四个冻结规格硬断言不受影响（x 对齐与窗口判据与高度无关），但**视觉基线类规格**
   （`visual.e2e.ts` 截图基线）未在本次回归范围内 ⇒ 若后续跑视觉回归需重新基线化。
6. **副图 pane 高度不跨刷新持久化**（本波未要求；klinecharts pane 高度是实例内状态，切换指标不重置已验证）。
7. **`KlineChart` 头部行数增加**（新增指标入口）⇒ 默认态 K 线**绘图区**由 234px 变 194px（卡高仍 256）。
   冻结探针记录的 VOL pane 上限由 177px 变 137px（该值本就是**卡高函数**，非判据）。
8. 未跑全量前端单测/E2E（资源纪律要求只跑相关子集）。

---

## 8. 给规格维护者的结构性建议（一行，父层要求写入）

`adr028-features-verify.e2e.ts` T0 的 bundle 锚点用**硬编码字面量**会在每次合法重建后变红 ⇒ 建议改为
「从 `web/dist/index.html` 引用的 assets 名 + 磁盘该文件实测 sha256」**自证一致**，从而把「产物变更」与
「判据失效」解耦（本波只按授权改了 2 行常量，未实现该建议）。

---

## 9. 报告自身位置

`coder/evidence/20260920_result_resize/report.md`（本文件）。
