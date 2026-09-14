# 269 — P2-A 红测试设计报告：T2 隐藏 K 线 / T5（除 LIVE）/ T8（G3）/ G4 前置声明

- **本文件路径**：`tester/design/269_p2a_satellite_red_design.md`
- 角色：Tester（设计 + 落地测试；**未改任何产品代码**）
- 时间：2026-09-14 21:30–21:45（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `2632c9e`；web 侧 klinecharts `10.0.3`）
- 权威依据：`design/15-multi-period/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`
  （T2 / T5 除 LIVE / T8 / G4；实施计划 P2）
- 执行报告：`tester/test/269_p2a_satellite_red_execution.md`；证据目录：`tester/evidence/269_p2a_red/`
- 本轮**不含**：跨图同步（P3）、LIVE 虚线段（P4）、高度持久化（P5/T9）

---

## 1. 范围与策略

| 测试项 | 层级 | 手段 | 当前状态 |
|---|---|---|---|
| **T2** 卫星隐藏 K 线（`state:'minimize'`+`separator:0`、指标 pane 填满、缩放/滚动后仍成立） | 组件集成（jsdom + 忠实桩） | `DashboardPage` 真实渲染 + **逐实例 chart 桩**（每次 `init` 新桩）；断言**调用面**（`setPaneOptions`/`setStyles`/实例数/DOM 契约） | **红 ×3** |
| **T2 库事实回归**（`height:0` 单独使用**无效**） | 真身渲染（Playwright + file:// UMD） | `web/tester/p2-satellite-harness/`（真实 klinecharts 测量 DOM rect） | **绿（事实固定）** |
| **T5** 指标继承（每卫星同名集合非空且一致） | 组件集成 | 逐个点开 `{MACD,KDJ,BOLL,DCAP}`（MA 默认开）→ 每实例 `getIndicators({name})` 非空 + 集合相等 | **红** |
| **T5** 叠加指标必须走 `addOverlayIndicator`（禁止裸 `createIndicator(...,false)`） | 组件集成 + 源码门禁 | 所有桩的 `createIndicator` 第二实参**必须显式 `true`**；创建过的名字结束时必须在场（静默顶掉即红）；既有 `indicatorCallGuard.test.ts` 源码门禁不动 | **红（因卫星实例缺失而无法覆盖）** |
| **T5** DCAP 逐实例 `precision 5` / 0 参考线（zero figure）/ 数据不足断线 | 组件集成 + 模板事实 | 逐实例读**该实例自己的** `createIndicator` 记录（`isStack=true`、`calcParams` = 当前 dcap 参数）→ 用该参数跑 `DCAP_INDICATOR_TEMPLATE.calc`（数据不足 ⇒ 三线 null、`zero===0`、长度对齐不抛） | **红** |
| **T8（G3）** 4 周期 × 1 标的：每实例 1 个 `KlineDataFeed`、初始化 HTTP ≤4、WS ≤4、每分钟兜底 ≤4（含 warmup 口径） | 组件集成（页面级记账） | `init` 计数 + `getKline` 逐 period 计数 + `bar:` 订阅 key 计数 | **红 ×4** |
| **T8** 禁止本地聚合 | 源码门禁（代码级）+ 行为级 | `multiPeriodNoLocalAggregation.test.ts`（聚合命名 denylist + `getKline` 的 `period` 非字面量 + 防空扫）+ 行为级「每周期请求命中各自 period」 | 代码级**绿（事实固定）**／行为级**红** |
| **G4** 像素取证前置声明 | 文档 | `design/15-multi-period/03-test-plan.md` §1 增补散文声明（阶段 3 用页面截图 + 画布采样；**禁用图表导出**） | 已完成 |

**为什么 T2/T5 走页面级（`DashboardPage`）而不是直接渲染容器**：产品接口面（satellite 需要的 code/api/ws/indicators/maWindows/dcapParams/…）由页面注入；页面级断言使实现方**可以自由选择内部 props 管道**，测试只锁「配置面 → 实例行为面」这一层契约（与 P1 的 `multiPeriodClosedEquivalence.test.tsx` 同一手法）。

**时间盒**：红测试设计与落地（设计 12 min / 落地含验证 18 min）；未实现任何产品代码。

---

## 2. 用例清单（Given–When–Then）

### 2.1 T2 隐藏 K 线（`multiPeriodSatellite.test.tsx`，MP_2 = `{periods:['15m','1h'], heights:{'15m':420,'1h':180}}`）

| # | 用例名 | Given / When | Then（断言口径） |
|---|---|---|---|
| T2-1 | `卫星 candle_pane 必须用 state:"minimize"+minHeight:0 折叠、separator.size=0；且不得依赖 height:0` | 配置 `enabled=true`（基准 15m + 卫星 1h）→ 渲染 | ① `init` 恰 2 次；② 卫星根元素 `[data-mp-satellite="1h"]` 存在且其内向有该实例的 `init(el)`；③ 该实例 `setPaneOptions` 对 `candle_pane` 有 `state:'minimize' && minHeight:0`；④ 该实例**不得**出现带 `height` 键的 `candle_pane` 调用（`height:0` 静默无效路径）；⑤ `setStyles({separator:{size:0}})` 必须调用；⑥ 基准实例的 `candle_pane` **不得** minimize |
| T2-2 | `卫星实例高度 = heights[period]（指标 pane 填满实例容器）` | 同上 | 卫星根元素内联 `style.height === '180px'`（= `heights['1h']`） |
| T2-3 | `缩放/滚动后仍成立：不重建实例、折叠不回弹、分隔条仍为 0` | 派发所有实例的 `onZoom`/`onScroll` 动作（KlineChart 的两个订阅点） | `init` 计数仍 2；卫星元素仍在；该实例所有 `candle_pane` pane options 仍 `minimize`；最后一次 `setStyles` 的 `separator.size === 0`；WS 订阅数不增（2） |

### 2.2 库事实回归（真身 klinecharts harness，**绿**）

| # | 检查 | 断言 |
|---|---|---|
| L1 | `setPaneOptions({id:'candle_pane', height:0})` **单独**使用 | DOM rect 高度**不变**（实测 393 → 393，`heightIsZero=false`）⇒ 必须走 `state:'minimize'` |
| L2 | `state:'minimize' + minHeight:0` | candle rect 高度 **0**；指标 pane rect 高 493 ≈ 容器 520（填满） |
| L3 | `setStyles({separator:{size:0}})` | 相邻 pane 间隙 **0px** |
| L4 | 缩放（`setBarSpace(30)`）+ 滚动（`scrollToDataIndex(120)`） | candle 仍 0 高、间隙仍 0 |
| L5 | 零高 pane 下 `getConvertPictureUrl(true)` | **抛 `InvalidStateError`**（`Failed to execute 'drawImage' … width or height of 0`）⇒ **G4 禁用图表导出** |
| L6 | 画布 `fillText` 打点（探针 165 手法） | 指标图例被绘制（`S:`/`M:`/`L:`）、0 线图例（`0: `）被绘制 ⇒ 指标确实上画布 |
| L7 | `state:'normal'` 还原 | candle 高度恢复 394（折叠可逆） |

### 2.3 T5 指标继承（MP_2；基准勾选 `{MA,MACD,KDJ,BOLL,DCAP}`）

| # | 用例名 | Then |
|---|---|---|
| T5-1 | `基准勾选 {MA,MACD,KDJ,BOLL,DCAP} ⇒ 每个卫星各自非空且集合一致` | 前置 `init=2`；对基准 + 每个卫星：五个指标名 `getIndicators({name}).length > 0`；卫星的指标名集合（排序后）**等于**基准集合 |
| T5-2 | `叠加指标必须走 addOverlayIndicator：所有 createIndicator 显式 isStack=true 且无静默顶掉` | 前置 `init=2`；每个实例的**全部** `createIndicator` 第二实参 === `true`（`false`/省略/变量一律红）；每个被创建过的名字在结束时 `getIndicators({name})` 非空（复刻 `StoreImp.addIndicator` 的替换语义）；基准 `removeIndicator({name:'MA'})` 出现过且 MA 只建一次 |
| T5-3 | `DCAP 逐实例：precision 5 + 0 参考线（zero figure）+ 数据不足断线` | 前置实例数 = 2；每个实例：DCAP 创建记录存在且 `isStack=true`、`calcParams === dcapCalcParams(DEFAULT_DCAP_PARAMS)`；模板 `precision === DCAP_PRECISION === 5`、`figures` 含 `zero`；以该实例参数跑 `calc`（2 根 bar）⇒ 长度 2、最末值 `{s:null,m:null,l:null,zero:0}`（断线不抛） |

### 2.4 T8 数据与预算（MP_4 = `{periods:['1m','5m','15m','1h'], heights:{...420/180/180/180}}`）

| # | 用例名 | Then |
|---|---|---|
| T8-1 | `每实例 1 个 KlineDataFeed：4 次 init / 每周期各 1 次初始化 HTTP / 4 个 bar: 订阅` | `init` 恰 4；卫星元素 = `['5m','15m','1h']`；初始化取数（无 `before`、`limit≠5`）按 period 分组 ⇒ 键集**恰** = 配置 4 周期、**每周期恰 1 次**、`code` = 选中标的、`limit === viewport_bars(120)`（DCAP 未开 ⇒ 无 warmup）；`bar:` 订阅 = `['bar:518880:15m','bar:518880:1h','bar:518880:1m','bar:518880:5m']` |
| T8-2 | `每分钟兜底 ≤4、按 (code,period) 各自成 key（不跨周期合并）、并发闸 ≤3` | 假定时器 + 系统时间 = 交易日 10:00（trading）；推进 60s，兜底请求**挂起不 resolve**：兜底请求数 ≤4、`(code,period)` 互不相同（不跨周期合并）、键集 = 4 周期、每周期 ≤1 次、`limit === REALTIME_POLL_LIMIT`；**在途 ≤ `MAX_CONCURRENT_POLLS`(3)**；释放名额后排队请求继续发起（≤4，不丢请求） |
| T8-3 | `warmup 口径：DCAP 显示时每实例都必须 warmup（窗口 limit = viewport+warmup 或 before 游标补取）` | 前置 4 周期都有取数记录；对每个周期：存在 `(窗口 && limit === 120 + dcapWarmupBars(default)=182)` **或** `(before 游标 && limit > 1)` —— 两条均为 02-spec §5 + 既有热更新契约（§6「不重建 pane」）的合法路径 |
| T8-4 | `禁止本地聚合（行为级）：每周期请求命中各自 period` | 初始化取数 period 键集 = 4 配置周期；每周期**恰 1 次**（本地聚合实现通常会重复取低周期再派生）；4 个实例 ⇒ 4 个互不相同的 feed 周期；复用既有 `KlineDataFeed` |

### 2.5 T8 代码级门禁（`multiPeriodNoLocalAggregation.test.ts`，**事实固定/绿**）

| # | 用例名 | Then |
|---|---|---|
| S-1 | 防空扫 | 生产源文件 ≥ 40，且 `features/dashboard/feed.ts` 在扫描集内 |
| S-2 | 无本地聚合实现 | 全量生产源码中 `aggregateBars/resampleBars/rollUpBars/barsToPeriod/toHigherPeriod/aggregateToPeriod/bucketBars/downsampleBars/mergeBarsIntoPeriod/fromOneMinuteBars` 命中 **0** |
| S-3 | 阳性对照 | `feed.ts` 中 `period: this.deps.period` ≥3 处（初始化 / 分页 / 兜底三条路径都直接携带实例周期） |
| S-4 | 无硬编码周期 | 任何 `getKline({…})` 实参块中不得出现 `period: '…'` 字面量 |
| S-5 | 容器无周期换算表 | `MultiPeriod*/multiPeriod*` 生产文件不得出现 `60000 *`、`periodMs *`、`multiplier` |

---

## 3. 测试基建与桩策略

### 3.1 忠实桩（沿用，不新增语义）
- `src/test/chartStoreStub.ts`：复刻 `StoreImp.addIndicator` 的「`isStack=false/省略` ⇒ **先清空同 pane**」语义（`index.esm.js:14162-14166`）与「无论如何都返回新 id」（`:15292`）。T5-2 的「静默顶掉」断言与 T2 的 pane 调用面断言都建立在此语义上。
- 页面级渲染：`stubApi()` 契约 mock 底座 + 覆写 `getSymbols/getKline/getKlineConfig/getMultiPeriodConfig`；假 `WsClient`（可数 handler ⇒ 订阅计数证据）。

### 3.2 **唯一新增 testability 契约**（设计报告钉死，实现方必须满足）
1. **卫星实例根元素**必须带 `data-mp-satellite="<period>"`，内联 `style.height === heights[period] + 'px'`；
2. 该元素**子树内**必须是该卫星 chart 的容器（即 `init(el)` 的 `el` 在其内）——测试据此把「chart 桩 ↔ 卫星周期」一一对应；
3. 除上述两点外，**不新增**任何 DOM/属性要求（`enabled=false` 的关闭态等价口径不变：关闭态不得出现任何此类标记，P1 的 `multiPeriodClosedEquivalence.test.tsx` 继续守护）。
4. 记账面：每实例 **恰一次** `init`；卫星周期**不额外**引入第二次 `init`/重复订阅。

### 3.3 变异/反向证据（红→绿过程中必须保持有效）
- T5-2：把任一叠加指标改回 `isStack=false` ⇒ 断言必红（该名字随后被清空）；
- T2-1：把卫星折叠改成 `setPaneOptions({height:0})`（去掉 `state:'minimize'`）⇒ T2-1 ④ 必红（且真实渲染下 L1 证明它根本无效）；
- T8-1/T8-4：把卫星周期改成"取 1m 再聚合" ⇒ period 键集/计数必红；
- T8-2：去掉并发闸或每实例重复兜底 ⇒ ≤4/≤3 断言必红。

### 3.4 边界与异常用例
- 卫星高度取 `heights[period]`（80/1200 两端由 P1 config 校验负责，本文件不做数值边界）；
- 卫星周期必须 ≥ 基准（MP_2/MP_4 均满足）；`1mo` 与「含 1w 但基准 < 1d」由 P1 T6 负例覆盖，本文件不重复；
- `1w` 卫星不在本轮（P3 的 barSpace 前提），避免引入未锚定的 barSpace 约束；
- DCAP 数据不足（2 根 vs 需 62 根）：断线 + `zero` 恒 0 + 不抛；
- 「每分钟兜底」用挂起请求验证**不丢请求**（排队语义）与「不跨周期合并」。

### 3.5 覆盖目标
- T2：卫星的折叠面（`state/minHeight/separator`）与实例生命周期 100% 走断言；真实几何由 harness 承担。
- T5：五个勾选指标 × 每实例均有非空断言；DCAP 三事实（precision/zero/断线）逐实例。
- T8：**记账面**（实例数 / 初始化窗口取数 / 兜底 / WS / 周期身份）全覆盖；G3 预算三条（≤4/≤4/≤4）逐条有断言。
- G4：**本轮只声明口径**（阶段 3 落地首页截图 + 画布采样），本阶段不提前声称像素证据。

---

## 4. 与设计文档的两点口径澄清（实现方须知，非阻塞）

1. **基准周期**：`02-spec.md` §2「`periods[0]`（基准）＝ K 线周期」 ⇒ 本文件 T8 的 MP_4 取 `periods[0]='1m'`，断言**请求 period 集合 = 配置周期集合**（即基准实例必须渲染 `periods[0]`）。T2/T5 用 `periods[0]='15m'`（= `DASHBOARD_DEFAULTS.period`），**不依赖**该切换行为。
2. **`config.indicators` vs 基准勾选集合**：`02-spec.md` §2 记 `indicators:['dcap']`（"卫星继承的指标集合"，首版 dcap），§4.1 又要求「卫星渲染**基准勾选**的同一集合」。本文件按 §4.1（**基准勾选集合 = 继承源**）写断言；`config.indicators` 在 v1 视为**受支持集合/白名单**（P1 已在 `web::dto` 校验）。若架构师认为卫星集合应由 `config.indicators` 决定（而非基准勾选），请在实现前裁定——本文件的 T5-1/T5-3 需随之改口径。

---

## 5. 产物清单（本设计落地）

| 文件 | 类型 | 状态 |
|---|---|---|
| `web/src/features/dashboard/multiPeriodSatellite.test.tsx` | 新增红测试（10 用例） | **10 failed（预期红）** |
| `web/src/features/dashboard/multiPeriodNoLocalAggregation.test.ts` | 新增源码门禁（5 用例） | 5 passed（事实固定） |
| `web/tester/p2-satellite-harness/{harness.html,run.mjs}` | 新增真身 klinecharts harness（11 检查） | 11 PASS / 0 网络请求 |
| `design/15-multi-period/03-test-plan.md` | §1 G4 增补散文（2 行，无代码块） | 已完成 |
| `tester/evidence/269_p2a_red/` | 证据（红输出、harness JSON/PNG、全量回归） | 已产出 |

**未做**：未改任何产品代码/接口/架构；未改 Rust/生成物；未跑 tangle；未 git add/commit/stash；未触碰线上（0 写请求；harness 全程 `file://`）。
