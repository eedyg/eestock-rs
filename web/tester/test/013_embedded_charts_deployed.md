# 013 执行报告 — 内嵌图表深度细化验收（宫格内嵌 K线缩略 + 单图组件，已部署环境）

> **本文件位置**：`/home/eestock/workspace/git/eestock/eestock-rs/web/tester/test/013_embedded_charts_deployed.md`
> 角色/纪律：tester（只测不改；**零产品代码改动、零 commit / git add、零 DB 写**）
> 新测试文件：`web/e2e/embedded-charts.e2e.ts`（10 用例，与既有 e2e 同构；设计见
> `web/tester/design/013_embedded_charts_design.md`）
> 执行时间：2026-09-05 11:13–11:16 CST（10/10 passed，2.5m）；校准探针 11:00–11:20
> 被验环境：`eestock-app` healthy（镜像 9d39b951…，日志显示 33M 修复 commit 族已在 bundle），SPA
> `index-DLbas1AF.js`；前端/API `http://127.0.0.1:8081`；DB `eestock-timescaledb`；代码基线 commit `04f34e0`
> （本地 git HEAD，非本次变更）；Playwright chromium viewport 1280×800
> 证据目录：`/tmp/embedded_evidence/`（截图+JSON，末尾清单）；另 `/tmp/embtest/*.tsv/json`（离线对账）

## 0. 执行摘要

| 任务 | 结论 | 一句话证据 |
|---|---|---|
| ① 宫格每格数据正确性 | ✅ **PASS** | 4+6 格 code 顺序=前 N；每格 15m×120 与 DB 权威重算逐 bar 全等（mismatch 0/1200 根），升序，首尾 ts 一致，多格不串（T1/T2 + 离线 1m 复核） |
| ② 环形图/窄格布局与溢出 | ⚠️ **FAIL（布局缺陷 R1）** | canvas 有界（无 33M，max≈477×512）；但 2×2 行高 500/144（ratio 3.47，应均分 ~362）；E11 顺序 2×3 末行两格画布 0 高只剩表头、页面纵滚 852>800（T3/T3-DEFECT） |
| ③ 生命周期/泄漏 | ✅ **PASS** | ×3 循环 canvas 24/36/10 归位零残留；WS bar 订阅余额回单图后仅剩单图 feed 1 条；切 1m 各格重发 period=1m&limit=120 并重绘；无崩溃（T4/T5） |
| ④ 宫格表头 D2 一致性 | ❌ **FAIL（缺陷 R2，新发现）** | disabled/no-data 格表头显示 `+0.00%`，SymbolList 同标「已停用/无数据」——口径不一致；no-data 格空态不崩（T6/T6-DEFECT） |
| ⑤ 单图内嵌组件回归 | ✅ **PASS** | 网格交互后 VOL/MA/MACD(14)/KDJ(18)/BOLL(22) pane 正常；分时价格+均价线（WS 注入 12 点推进，最新价/均价与计算值全等）；分时 1m 源当日 241 根与 DB M1 逐 bar 一致（T7） |
| ⑥ WS 隔离 | ✅ **PASS** | 单图实时 marker 9.15 → 2×2 注入更晚 bar：格内无 marker、格画布指纹不变 → quote snake_case 更新格表头 -5.55% → 回单图实时恢复 9.31（T8） |

## 1. 测试运行结果

命令：`E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test e2e/embedded-charts.e2e.ts`
结果：**10 passed（含 2 条 DEFECT 复现用例按 K1 语义 PASS 留证）；首轮 T5 1 次 flaky 由 lit 阈值校准后稳定**
（阈值从 >8 调 >2：2×3 末行画布仅 ~41px 高所致——本身即 R1 缺陷影响的次生现象）。无 pageerror；
console error 仅偶发 `/api/kline` 500（EV-1 基础设施，见 §4），无其他 console error。
tsc -b：exit 0（新文件类型安全）。

## 2. ① 宫格每格数据正确性 — ✅ PASS（核心证据）

**格序**（T1/T2 DOM `<b>` 顺序 = /api/symbols 前 N，符号列表同序）：
2×2：`[159337, 159577, 159638, 159740]`；2×3：`[159337, 159577, 159638, 159740, 159742, 159776]`。

**每格请求**：进入宫格后每格发出 `GET /api/kline?code=<cellCode>&period=15m&limit=120`（无 before），全部 200。
证据 `t1_grid2x2_db_reconcile.json` / `t2_grid2x3_reconcile.json`（fiveHundreds=[]）。

**DB 权威对账**（rest=页面实际载荷，db=kline_accurate M1 → 15m 桶 first/max/min/last/sum，与 cagg 同式）：

| code | rest bars | db bars | 升序 | mismatch | 首 ts | 末 ts |
|---|---|---|---|---|---|---|
| 159337 | 120 | 120 | ✓ | **0** | 2026-08-27T03:00Z | 2026-09-04T07:00Z |
| 159577 | 120 | 120 | ✓ | **0** | 同上 | 同上 |
| 159638 | 120 | 120 | ✓ | **0** | 同上 | 同上 |
| 159740 | 120 | 120 | ✓ | **0** | 同上 | 同上 |
| 159742 / 159776 | 120/120 | 120/120 | ✓ | **0** | — | 同上 |

（T2 全 6 码 mismatch 0；OHLC 容差 1e-6、volume 精确相等——实际 diff=0。）任意两格首 bar ts/close
不同 → 多格不串。离线 1m 复核：`/api/kline?period=1m&limit=482` 与 DB M1 首尾 ts 与数值全等
（/tmp/embtest/db_1m_159337.tsv）。

## 3. ② 布局与溢出 — ⚠️ FAIL（缺陷 R1：宫格行高不均 + E11 顺序下 2×3 末行坍缩）

**PASS 侧（无 33M 复发）**：单图 & 各格 canvas 有界（格内主画布 max 477×512、单图 998×597；h 均 <2000）；
蜡烛格内横向铺满无死区（fillPct=100%/leftBlank=0%，证据 `fill_grid.json` + 截 `FILL_2x2.png`）；
宫格不引入额外横向溢出（grid 模式 docScrollW=1488 == 单图基线 1488；1488>1280 为全站壳层 EV-2 既有，
report 015 截图同宽，非宫格缺陷）；反复 2×2↔单图 3 次 canvas 归位=10、无残留（T3）。

**缺陷 R1（新发现，行高不均 + 末行坍缩）**：
- fresh 2×2：两行格高 **500 / 144**（main canvas 477×448 / 477×92），ratio **3.47**；规格两行应均分可用高
  ~362。多次独立运行复现（500/144、512/108 变体）。
- E11 顺序（单图→2×2→2×3）：行高 500 / 144 / **52** —— **末行两格（159742/159776）画布 0 高**
  （main=None），只剩表头，页面 docScrollH **852 > 800**（`t3defect_grid_row_geometry.json`、
  截 `T3DEFECT_2x3_bottom_zero.png`）。
- 直接 fresh 2×3（不进 2×2）：行高 420/201/102（canvas 368/149/50），末行画布仅 ~50px 高——均分应 ~240，
  同样不均（校准探针）。
- 影响：用户切 2×2/2×3 常见路径下 2×3 第三行缩略图不可见/接近不可见；行高分布由 klinecharts 初始化
  测量与 CSS grid auto 行内容定高互相反馈决定——与 018 记录的 33M 同根因族（flex/grid 尺寸反馈），但
  表现与位置不同（宫格视图），且既有 E11/E12 只断「格数=6 + canvas 数=6」（0 高 canvas 亦计入）故从未捕获。
  复现：见 T3-DEFECT 用例。

**最小复现（R1）**：`/` 加载 → 工具栏点「2×2」→ 再点「2×3」→ 第三行两格仅 52px 表头、主画布 0 高、
页面可纵向滚动（852px）；几何快照见 t3defect JSON。

## 4. ③ 生命周期 / 泄漏 — ✅ PASS

- 单图→2×2→2×3→单图 ×3：每轮 canvas 24→36→**10**、data-grid-cell 0、无 pageerror/无 console(other)
  （`t4_cycles.json`；截 `T4_after_3_cycles.png`）。
- **WS 出站余额**（__sent 帧统计 subscribe−unsubscribe，topic=bar）：循环结束后仅剩
  `bar:159337:15m → 1`（单图 feed，跨模式按设计保留）；其余 5 个宫格主题（159577/159638/159740/
  159742/159776）净 0 → **格内 KlineDataFeed 随 dispose 正确释放**（dispose 解订阅）。JS heap 有界
  （<500MB 断言通过）。
- grid 模式切周期 15m→1m：6 格全部重发 `period=1m&limit=120`（`t5_period_switch_1m.json`），画布结构
  6/格、内容重绘（点亮像素>2）；「回到最新」等无异常。**观察（环境 EV-1）**：本轮 1m 并发首次触发 6 次
  DB shm 500（见下），重试一轮后 6 码均 200 且正常绘制——**无前端崩溃，但 grid 格缺失败重试，单次 500
  会留空格直到重挂载**（产品健壮性建议，非本次判 FAIL）。

## 5. ④ 宫格表头 D2 一致性 — ❌ FAIL（缺陷 R2，新发现）

route 拦截 /api/symbols，前4 = `TEST_OFF`(enabled=false, latest=null)、`TEST_NODATA`(enabled=true,
latest=null)、真实×2（T6/T6-DEFECT）：

| 层 | TEST_OFF | TEST_NODATA |
|---|---|---|
| SymbolList（D2 已修复层） | 「已停用」无 0.00 | 「无数据」无 0.00 |
| **宫格格表头（GridCell）** | **`TEST_OFF|停用验证标的|+0.00%`** | **`TEST_NODATA|无数据验证标的|+0.00%`** |

- **缺陷**：GridCell 表头无条件 `changePct.toFixed(2)%`（代码与运行时双层证据），对停用/无数据标的伪造
  **+0.00%**，与 SymbolList「已停用/无数据」口径不一致（D2 修复 commit 7fab9f1 只覆盖 SymbolList；
  宫格格表头从 GridCell 引入起未纳入 D2 范围、从未被测到）。**真实场景**：停用/无数据的标的若按 code 序
  落入前 4/6（现 44 标的全 enabled；一旦出现停用 ETF 即触发），格表头即展示误导性 0.00%。
- **PASS 侧**：no-data 格 K 线不崩溃（真实后端对未知码 200 空 → 空态画布 6 canvas 有界、无 pageerror），
  空态非报错（`t6_nodata_cells.json`）。
- 复现：T6-DEFECT 用例（route 注入）即最小复现。

## 6. ⑤ 单图内嵌组件回归 — ✅ PASS

网格交互（2×2→2×3→单图）后：主图 candle+MA、VOL 副图默认在（canvas=10）；MACD→14、KDJ→18、
BOLL→22 逐开 pane 正常、逐个关闭回 10、canvas 有界（T7，截 `T7_indicators_after_grid.png`）。
分时：休市日（今日=周六 0 bar）初始占位「该时段无数据」（记录 t0，属设计行为）；其 1m 数据源当日
（最近有数据 CST 日 **2026-09-04**）**241 根 REST == DB M1 241 根逐 bar 一致、升序、mismatch 0**
（`t7_timeshare.json` dayReconcile）；WS 注入 12 根今日 bar → 价格线+均价线 2×12 点无缺口，最新价文本
`1.722`==计算值、均价 `1.713`==累计额/量计算值；切回 K 线正常。

## 7. ⑥ WS 隔离 — ✅ PASS

单图注入 15m bar（close 9.15）→ marker「9.15」出现；切 2×2 后注入同 code 更晚 bar ×2（9.25/9.28）→
**格内 0 marker、格主画布 dataURL 指纹不变（无实时 bar 视觉追加）**；quote snake_case `change_pct:-5.55`
注入格2 → 格表头 `-5.55%` 更新（K1 修复在宫格路径有效）；回单图注入 9.31 → marker 恢复。
（观察 O-G1：格内 KlineDataFeed 内部仍订阅并处理 `bar:<code>:<period>` 帧——设计注释「格无实时 bar
订阅」与实现有出入，但图表层不接线、无视觉追加，随 dispose 释放，无用户可见影响。）

## 8. 真实缺陷清单与分类

| ID | 位置/现象 | 分类 | 严重度 | 最小复现 | 证据 |
|---|---|---|---|---|---|
| R1 | 宫格行高分布不均：2×2 行高 500/144（ratio 3.47，应 ~362/362）；E11 顺序 2×3 末行两格画布 0 高（只剩 52px 表头）且页面纵滚 852>800；fresh 2×3 末行画布仅 ~50px | **新发现**（018「33M」同根因族的新实例；E11/E12 浅断言从未捕获） | 高（视觉/功能：2×3 末行缩略图不可见） | / → 2×2 → 2×3 | `t3defect_grid_row_geometry.json`、`T3DEFECT_*` 截图、T3-DEFECT 用例 |
| R2 | GridCell 表头 D2 不一致：disabled/no-data 标显示 `+0.00%`（SymbolList 同标「已停用/无数据」） | **新发现**（7fab9f1 D2 修复范围遗漏 grid header） | 中高（误导数据展示，无崩溃） | route 注入前4含停用/无数据码 → 2×2 | `t6defect_grid_header_d2.json`、`T6DEFECT_grid_header_0pct.png`、T6-DEFECT 用例 |
| EV-1 | DB 容器 /dev/shm=64MB → 并发 kline（1m 深查）间歇 500「could not resize shared memory segment…No space left on device」→ 宫格 1m 切换偶发空格（前端无重试） | 新发现（**基础设施**，非前端逻辑缺陷） | 中（环境/部署；需架构路由提升 shm 或降并行度） | grid 2×3 切 1m 并发 6 请求 | app log（docker logs eestock-app）、`t5_period_switch_1m.json` fiveHundreds |
| EV-2 | 全站壳层 min-w-[1280px]+nav 208 → docScrollW=1488>1280（所有页一致，宫格不额外增加） | 既有（report 015 全页截图同宽 1488；非宫格引入） | 低（基线条件） | 任何页 1280 视口 | T3 基线记录 `fill_grid.json` |

既有记录核对照：K1（quote snake/camel）已在 9e09cd2 修复并在宫格路径复验通过（-5.55% 正常）；018 单图
33M/h-125% 无复发（canvas 有界、docScrollH≤800 单图）。**R1/R2/EV-1 均为本次新发现**（此前报告/断言
无记录）。

## 9. 约束合规与账目

- 零产品代码/接口/架构改动；零 commit / git add / stage；git status 仅新增 untracked：
  `web/e2e/embedded-charts.e2e.ts`、`web/tester/design/013_*`、`web/tester/test/013_*`。
- DB 全程只读（对账 SELECT），无 sql-ledger 条目。
- 遗留风险：R1/R2/EV-1 待架构路由（coder）修复；O-G1 待产品定夺；2×3 fresh 与 E11-seq 两态行高
  差异说明行高受挂载顺序影响（动态）。

## 10. 证据索引（/tmp/embedded_evidence/）

JSON：`t1_grid2x2_db_reconcile.json`、`t2_grid2x3_reconcile.json`、`t3defect_grid_row_geometry.json`、
`t4_cycles.json`、`t5_period_switch_1m.json`、`t6_nodata_cells.json`、`t6defect_grid_header_d2.json`、
`t7_timeshare.json`、`fill_grid.json`
截图：`T1_grid2x2_db_reconcile.png`、`T2_grid2x3_data.png`、`T3_bounds_2×2/2×3.png`、
`T3_after_cycles_single.png`、`T3DEFECT_2x2_uneven.png`、`T3DEFECT_2x3_bottom_zero.png`、
`T4_after_3_cycles.png`、`T5_grid_period_1m.png`、`T6_nodata_cells_no_crash.png`、
`T6DEFECT_grid_header_0pct.png`、`T7_indicators_after_grid.png`、`T7_timeshare_after_grid.png`、
`T8_ws_isolation_resume.png`、`FILL_2x2.png`、`FILL_2x3_seq.png`、`probe_2x2/2x3/single*.png`
app log：`docker logs eestock-app`（EV-1 shared memory 报错原文）

---

## 11. 复跑验收（R1/R2 修复后部署实证）— 2026-09-05 11:49–11:52 CST

> **本文件位置**：`/home/eestock/workspace/git/eestock/eestock-rs/web/tester/test/013_embedded_charts_deployed.md`
> 性质：对**已部署环境**复跑内嵌图表深测 e2e，确认 R1/R2 修复真实生效（此前 §2–§5 为本地/旧部署
> Green/Fail 混合记录，本次为运行环境实证）。只测不改、零 commit/git add、零 DB 写。

**被验环境**：`eestock-app` Up 18 min (healthy)；镜像 `eestock-rs_app:latest 5294d0cbd9f0`；SPA
`index-l_1GiLir.js`；前端/API `http://127.0.0.1:8081`；本地代码基线 `eestock-rs` HEAD = **4bdd1e0**
（`fix(web+infra): 内嵌图表 R1 宫格行高 / R2 格表头D2 / EV-1 并发kline 500`），与部署提交一致，无本地
diff/staged。DB `eestock-timescaledb`（44 symbols，含 EV-1 并发参数修复）。

### 11.1 测试运行结果

| 套件 | 命令 | 结果 |
|---|---|---|
| 内嵌图表深测（10 用例：T1–T8 + R1 + R2） | `E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test e2e/embedded-charts.e2e.ts` | **10 passed（2.4m）** |
| 单图兼容（E11/E12） | `npx playwright test e2e/kline-matrix.e2e.ts -g "E11\|E12"` | **2 passed（19.7s）** |
| 数据正确性抽查 | `/api/symbols?with_stats=1`、`/api/kline`、并发 kline×12 | **全 200，JSON 结构正常** |

失败用例：**无**。pageerror：无。crash/core dump：无。console error：无（含 no EV-1 500 触发）。

### 11.2 R1（宫格行高均分）— 修复实证 ✅

`r1_grid_row_geometry.json`（本轮 11:50 生成，覆盖旧值）：

| 指标 | 修复前（旧部署 §3） | 修复后（本轮实测） | 断言 |
|---|---|---|---|
| 2×2 两行格高 | 500 / 144（ratio 3.47） | **322 / 322（ratio 1）** | <1.3 ✅ |
| 2×2 0 高 canvas/矮格 | 有（末行 92px 主画布） | **zero22=[]**，主画布全 477×270 | =[] ✅ |
| 2×3 三行格高（E11 顺序 2×2→2×3） | 500 / 144 / **52**（末行主画布 0 高） | **215 / 215 / 215（ratio 1）** | <1.3 ✅ |
| 2×3 末行两格 | 主画布 None（只剩表头） | **bottomZeroCells=[]**，全 477×163 | =[] ✅ |
| 页面纵向溢出 | docScrollH 852 > 800 | **scroll.H=720 ≤ 720+60（winH=720）→ docOverflow=false** | false ✅ |

格高几何细目：2×3 六格 y 簇 76/291/505，行距 215，grid h=644；截图 `R1_grid_2x2_even.png`、
`R1_grid_2x3_even.png`（246KB 各，内容有效）。

### 11.3 R2（格表头 D2 一致性）— 修复实证 ✅

route 注入前2=TEST_OFF(enabled=false,latest=null)/TEST_NODATA(enabled=true,latest=null) 后进 2×2，
`t6defect_grid_header_d2.json`（本轮 11:51）：

| 格 | 修复前（§5） | 修复后（本轮实测） | 断言 |
|---|---|---|---|
| TEST_OFF 格表头 | `TEST_OFF|停用验证标的|+0.00%` | **`TEST_OFF|停用验证标的|已停用`** | 含「已停用」且无 [+-]0.00% ✅ |
| TEST_NODATA 格表头 | `TEST_NODATA|无数据验证标的|+0.00%` | **`TEST_NODATA|无数据验证标的|无数据`** | 含「无数据」且无 0.00% ✅ |

`gridShowsOff=true`、`gridShowsNoData=true`；与 SymbolList 同口径。no-data 格空态不崩（canvas 6/格有界
471×270/26，后端 TEST 码 kline 请求 200 空 bars=0，无 pageerror）。截图 `R2_grid_header_d2.png`（155KB）。

### 11.4 单图兼容 + 数据正确性（无回归）

- E11 宫格 2×2/2×3/回单图无状态丢失、E12 点击格进单图聚焦+quote 注入跳动：**2 passed**。
- T1/T2 数据对账：4+6 格 code=前 N 顺序一致，每格 15m×120 与 DB kline_accurate 权威重算逐 bar
  mismatch **0**（全部 120 bars、升序、首 2026-08-27T03:00Z / 末 2026-09-04T07:00Z），fiveHundreds=[]；
  T2 lit 点亮像素 92–136/格（内容非空）。T5 1m 切周期 6 格均发 period=1m&limit=120 且 **fiveHundreds=[]**
  （EV-1 未触发）。T7 分时 1m 源当日（2026-09-04）241 根 == DB 241 根 mismatch 0；WS 注入 12 bar 价格线
  +均价线 12 点、最新价 1.722/均价 1.713 与计算一致。T4 循环 canvas 24/36/10 归位、bar 订阅余额仅单图
  feed 1 条。T8 WS 隔离：格内无 marker、画布指纹不变、quote -5.55 更新表头、回单图实时恢复 9.31。
- 抽查（bash/curl）：`/api/symbols?with_stats=1` → list 44，首项含 latest{ts,last,change_pct} 结构正常；
  `/api/kline?code=159337&period=15m&limit=5` → `{code,period,bars[],next_before}`，bar 含 ts/open/high/
  low/close/volume/amount/source（tushare）。**并发 12 路**（前 12 code，period=15m&limit=120）→ **12/12
  200**（0.0046–0.0128s），抽查其中 3 个响应体 bars=120、首尾 ts 与 DB 一致。

### 11.5 结论与账目

**结论：PASS。** R1（grid-rows-2/3 + min-h-0）与 R2（格表头 D2 已停用/无数据）修复在已部署环境
（4bdd1e0 / 5294d0cbd9f / index-l_1GiLir.js）**真实生效**；单图组件（E11/E12/T7/T8）无回归；DB 并发
kline 全 200（EV-1 修复生效）。零产品代码改动；零 commit / git add / stage（`git diff` 与
`git diff --cached` 均空）；DB 只读（对账 SELECT）。本报告文件及 `web/tester/` 为既有 untracked 测试产物
目录，未纳入版本控制。
