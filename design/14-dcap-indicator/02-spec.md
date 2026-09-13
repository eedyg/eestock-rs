# dcap 指标 — 规格与接口契约

> 权威口径文档（ADR-007：本文是事实源，产物由 entangled 单向生成）。
> ADR：`01-adr.md`（ADR-021）。测试规格：`03-test-plan.md`。派单：`04-implementation-plan.md`。
> 本轮全部裁决的留痕见 §8「裁决附录」。

---

## 1. 定义

### 1.1 语义

「**假想定投收益率**」：在最近 `n` 根 bar 内，每根 bar 投入一笔资金，第 `k` 笔金额是首笔的 `r^(k−1)` 倍，求到当前 bar 为止这笔定投的收益率。

### 1.2 公式（精确，无近似）

```
A_k   = A_1 · r^(k−1)                     k = 1..n（k=n 为当前 bar）
shares = Σ_k A_k / P_k                    P_k = 第 k 根 bar 的 close
ROI   = (P_n · shares − Σ_k A_k) / Σ_k A_k
      = Σ_k w_k · (P_n/P_k − 1)           w_k = A_k / ΣA        ← 资本加权平均各期收益率
      = P_n / H_w − 1                     H_w = ΣA / Σ(A/P)     ← 几何加权「调和」均值
```

- **买价与估值价均取 `close`**；窗口含当前 bar（滚动重算）。
- 值域 `[−1, +∞)`（下界 −100%）；首批金额 `A_1` 会约掉 ⇒ **只有 `r` 影响结果**，无资金规模参数。
- **`r = 1` 时恒等于遗留 DCAP**（`golang/analysis/dcap_kdj_winrate.py`、`golang/pkg/histview/web.go`）：`close / harmonic_mean(last_N_closes) − 1`。

### 1.3 退化性质（用户已知情，是「三线各自 r」的决策依据）

权重按 `r^(−age)` 几何衰减 ⇒ 有效回看（加权平均年龄）**渐近趋于 `1/(r−1)`**，n 较小时显著偏小（故 `r≈1` 时 n 真正起区分作用）：

| n | r=1.0 | r=1.1 | r=1.2 | r=1.5 | r=2.0 |
|---|---|---|---|---|---|
| 8 | 3.50 | 3.00 | 2.58 | 1.68 | 0.97 |
| 26 | 12.50 | 7.62 | 4.77 | 2.00 | 1.00 |
| 60 | 29.50 | 9.80 | 5.00 | 2.00 | 1.00 |

⇒ `r≈1` 时三线才是真正的「长中短」（默认 `r=1.0` 即落在此区）；`r→∞` 退化为 1 根 ROC。**默认 `r_s=r_m=r_l=1.0`**。

---

## 2. 参数（9 个，全部标量）

ABI 约束：`ParamKind { Int, Float }`、`default: f64` —— **无数组、无 bool**（故三个 n 拆三个标量；开关用 Int 0/1）。

| key | type | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `n_s` | Int | 8 | 2–250 | 短窗口；`n=1` 恒为 0，无意义故 min=2 |
| `n_m` | Int | 26 | 2–250 | 中窗口 |
| `n_l` | Int | 60 | 2–250 | 长窗口 |
| `r_s` | Float | 1.0 | 0.5–2.0 | 短窗口金额增长比 |
| `r_m` | Float | 1.0 | 0.5–2.0 | 中窗口金额增长比 |
| `r_l` | Float | 1.0 | 0.5–2.0 | 长窗口金额增长比 |
| `smooth` | Int | 1 | 0–1 | 0=关（输出原始线）/ 1=开 |
| `m` | Int | 3 | 1–60 | 平滑周期；`smooth=0` 时忽略但**仍受校验** |
| `th` | Float | 0.01 | 0.001–0.5 | 评分映射标度（仅策略侧用，图表不用） |

**跨字段约束 `n_s < n_m < n_l`（用户裁决「强制」）—— 落地方式（架构裁决 2026-09-13，用户批复「按推荐」）**：
平台参数校验 `fill_and_validate_params`（`crates/application/src/strategy.rs:297`）只做**单参数 min/max**，`ParamDef{min,max}` 在结构上**无法表达跨字段约束**；扩 ABI 或在宿主特判 `dcap` 均被否决（前者动冻结面、后者违开闭）。故：
1. **插件自防御（权威、不可绕过）**：`init(params)` 内做**确定性归一化** —— `n_m ← max(n_m, n_s+1)`、`n_l ← max(n_l, n_m+1)`；对任意输入都产出合法且单调的三线；归一化必须**确定、幂等**，且只在 `init` 做一次（`on_bar` 内不得反复归一化）。
2. **配置端点（能真拒绝就真拒绝）**：`PUT /api/config/dcap` 属宿主自有端点，**对非单调 n 直接 400**。
3. **编辑器**：给出即时提示（体验层，**不作为**强制手段）。
⇒ 语义差异是**有意的**：宿主自有端点严格拒绝；ABI 约束下的插件参数**容忍并归一化**。二者都必须可测（`03-test-plan.md` T5a/T5b、T11）。

---

## 3. 计算语义

| 项 | 口径 |
|---|---|
| 窗口 | 最近 `n` 根 bar（含当前），滚动重算 |
| 价格 | `close`（买价 = 估值价） |
| 平滑 | **`SMA(m)`**，作用于每条 ROI 线；`m=1` 或 `smooth=0` ⇒ 原始值 |
| 数据不足 | **放弃**：可用 bar 数 `< n`（开平滑时 `< n + m − 1`）⇒ 该线该 bar **无值**（前端 `null`；插件侧该线**不入 N**；三线全缺 → 插件返回 50） |
| 参数归一化 | 三 n 非单调时按 `n_m←max(n_m,n_s+1)`、`n_l←max(n_l,n_m+1)` 归一（**仅 `init` 一次**，确定 + 幂等；`on_bar` 不得重复归一化）—— 见 §2 跨字段约束 |
| 开关关闭 | 输出必须与"未平滑原始值"**逐位相同**（测试锁定，禁止两条近似路径） |

**为什么是 SMA 而不是 EMA/KDJ 递推**（关键工程约束）：ADR-021 D1 要求同一公式在两个不同起点的数据窗口上算出同一个数。`SMA(m)` 只用最近 `m` 个 ROI、ROI 只用最近 `n` 个 close ⇒ **窗口局部，起算点无关**；`EMA`/`(m−1)/m` 递推是**状态依赖**（种子在序列起点、理论无限记忆）⇒ 前端换视口起点值就变，D4/D5 无法成立。

---

## 4. 接口契约 A — 前端模块 `web/src/features/indicators/dcap.ts`

> **tangle 块位置（由 coder 在实现时写入并生成，docs-as-source 单向流）**。以下签名是契约，实现正文由 entangled 从本文生成。

```ts
export interface DcapParams {
  n_s: number; n_m: number; n_l: number;
  r_s: number; r_m: number; r_l: number;
  smooth: number; m: number;
}

/** 单 bar 三线值；null = 数据不足（该线该 bar 无值）。 */
export interface DcapValues {
  s: number | null;
  m: number | null;
  l: number | null;
}

/** 单条线：最近 n 根 close 的定投收益率；不足 n 根 → null。 */
export function dcapRoi(closes: number[], n: number, r: number): number | null;

/** SMA(m) over 值序列（忽略 null 前导）；不足 → null。smooth=0 或 m<=1 ⇒ 直通原值。 */
export function smoothSeries(values: (number | null)[], smooth: number, m: number): (number | null)[];

/** 整段序列（图表 calc 用）：与后端起算点无关（窗口局部）。 */
export function computeDcapSeries(closes: number[], p: DcapParams): DcapValues[];

/** 策略侧评分映射（连续式）。 */
export function dcapScore(v: DcapValues, th: number): number;
```

**契约要求**
- 纯函数、无 IO、无全局状态、无 `Date.now()`；同一输入必须逐位可复现。
- `computeDcapSeries` 对每个 index 只依赖 `closes[..=index]`（**禁止未来函数**）。
- **浮点确定性铁律**（ADR-021 D4/D5 可断言的前提，违反则镜像断言必红）：
  1. **禁止 `Math.pow` / `Math.exp` / `Math.log`** —— `r^(k−1)` 用**迭代乘法** `w *= r`（IEEE754 只对 `+ − × ÷ √` 逐位可复现，`pow` 的末位 ulp 因引擎而异）；
  2. **禁止增量累加优化**（running sum）—— 每 bar 必须在窗口上按**同一顺序完整重算**（`n ≤ 250`、`m ≤ 60`，成本可接受）；
  3. **两份产物必须使用同一表达式与同一求和顺序** —— 顺序在本文**钉死**为两步：
     ① 先按 `k = 1..n` **升序**用迭代乘法求权重（`A_1 = 1`；`A_{k+1} = A_k × r`）；
     ② **再自 `k = n` 往回（k = n → 1）累加** `ΣA_k` 与 `Σ(A_k/P_k)`。
     实测（2026-09-13，双向核验）：`closes=[100,90,95], r=1.2` 下按此规则得 `0.0045787545787547845`；若改为 `k = 1 → n` 前进累加则得 `0.0045787545787545625`（差 `2.2e-16`）——**累加顺序不同则浮点尾数不同**。同时注意：若改用「权重从 1 起每步 `/= r`」（即累加倒数的写法）又是另一组尾数。故本条规定的是**表述精确的**两步法，不得用等价但次序不同的写法则套；
     注：T1 用 `1e-12` 容差覆盖此量级差异；**D4/D5 只要求两份产物使用同一段 CORE 文本**（同文即同序即逐位一致），**不要求实现等于某一侧的冻结值**。
  4. **CORE 区间 = 无类型注解的 ES2015 子集**（两个运行时的公共语言）：同一段字节既要进 `.ts`（经 Vite/TS 转译）又要被 **rquickjs 直接求值**（不剥类型注解）⇒ CORE 内不得出现 TS 注解/`import`/`export`/`Math.*` 以外的宿主 API。类型与导出只能出现在 `.ts` 包装层（哨兵区间之外）。
  5. **入口归一化必须在 CORE 内**：`normalizeParams(p)`（§2 跨字段归一化）属 CORE；**插件 `init` 与前端 `computeDcapSeries` 入口必须调用它**。
     ⚠️ 签名边界（P2-C 验收发现的口径缺口，已澄清）：`dcapScore(values, th)` **只接收已算出的 values**（其归一化由上游入口保证），故它**不接收 params、也不做归一化** —— 不得为此给它加 params 形参。否则非单调参数下 D5 跨运行时比对必然分叉。
- `dcapScore` 定义：

```
per_i  = clamp(roi_i / th, −1, +1)        // 缺值的线跳过（不计入分子分母）
score  = clamp(50 − (50/N)·Σ per_i, 0, 100)   N = 参与计算的线数（1..3）
        // 三线全缺 → 50（中立）
```
语义：`roi = −th` → 100、`0` → 50、`+th` → 0；饱和有界；三线等权（"平均观感"而非"平均 ROI"，保住三重确认语义）。

---

## 5. 接口契约 B — 插件 `crates/strategy-core/reference-plugins/dcap.js`

平台插件 ABI（`design/12-strategy-system/02-plugin-abi.md`）：`PARAMS_SCHEMA` / `init(params)` / `on_bar(ctx) → 0..100 f64` / `save()` / `load(state)`。**本 ADR 不改 ABI**。

```
on_bar(ctx):
  ① 维护三条滚动窗口（最近 n_i 根 close）—— 只能拿当前 bar，无历史数组（ABI 有意设计）
  ② 逐线算 ROI（复用 CORE 的 dcapRoi 语义）
  ③ 平滑（SMA(m)，同样复用 CORE）
  ④ 数据不足的线 → 跳过（不计入 N）
  ⑤ 三线全不足 → return 50（中立）
  ⑥ 否则 → return dcapScore(values, th)
```

**内部状态（必须进 `save()/load()`，ABI G3 —— 否则重放分叉）**
- 三条 close 滚动窗口（各 `n_i` 长）；
- 三条 ROI 的 `SMA(m)` 尾窗（各 `m−1` 个历史值）。

**其他契约**
- 出口 `[0,100]`：平台 `clamp_score` + 60/40 阈值零改动（引擎不知道 dcap 存在）。
- `init(params)`：**先做三 n 归一化（§2）再初始化状态**；归一化幂等、确定，`on_bar` 内不得重复归一化。
- 不做仓位换算（ADR §13.1：仓位归 `ExecutionPolicy`）。
- 不按 `r` 下单 ⇒ **不改 `ExecutionPolicy`、不加 `DcaMode::Geometric`**。
- 异常路径：除零（close ≤ 0）按数据不足处理，**不得抛错**（避免熔断计次）。

---

## 6. 接口契约 C — 图表（klinecharts 10.0.3）

| 项 | 口径 | 依据 |
|---|---|---|
| 注册 | `registerIndicator` 自定义指标，名 `DCAP`，`shortName` `DCAP` | `index.d.ts:1232` |
| 副图 | **独立副图 pane**（**不可像 MA 叠主图**：dcap 与价格无量纲关系，叠主图会压爆主图 Y 轴） | MA 走 `paneId:'candle_pane'` |
| figure 构成 | **3 个数据 figure**（`s` / `m` / `l`）+ **1 条常驻 0 参考线**（第 4 figure `zero`，值恒 `0`） | 数据三线与 KDJ 的 K/D/J 同构（`index.d.ts:738`）；0 参考线见下行 |
| 0 参考线 | 第 4 figure `zero`：**每条 bar 都返回值 `0`**（数据不足时三条数据线断线 `null`，**0 线仍返回 0**；异常降级路径同理）。样式：细（`size: 1`）、灰（`#76808F`，暗色主题可读）、虚线（`style: 'dashed'`）——与三条数据线视觉区分。作用：**参与副图 Y 轴自动标度**（klinecharts 副图区间取该 pane 内各 indicator 各 figure 值的 min/max，`index.esm.js:1017-1022` ⇒ 只有把 0 纳入标度，0 线才能在任何时段/缩放（含数据不足段）下始终可见）。**不参与策略口径**（CORE/插件/路由零影响）：`DcapValues` 契约不变，该值由手写层 `dcapIndicator.ts` 的 `calc` 在返回对象上就地扩展（`{ ...values, zero: 0 }`），tangle 生成物零改动。 | 取舍（2026-09-13 已向用户说明）：副图 Y 轴**始终包含 0**；三线整体远离 0 时信号会被压缩。若日后改为「仅当 0 落在自动范围内才画 0 线」，需另行定口径（本阶段不做） |
| 精度 | **必须显式 `precision: 5`**（且附理由） | 事实：**自定义指标默认 `precision = 4`**（`index.esm.js:3156` `this.precision = 4`；`series` 默认 `'normal'` ⇒ 走不到 `_synchronizeIndicatorSeriesPrecision` 的 price/volume 分支，`index.esm.js:14219-14226`）。`precision = 2` 只出现在**内置模板**里（MA/EMA/BOLL…）。⇒ 默认 4 位时 `0.0048` 能显示，但**丢第 5 位**（`0.004578…` → `0.0046`），故显式设 **5**（`0.0048` 渲染为 `0.00480`） |
| 小数折叠 | `decimalFold.threshold = 3`（默认） | `0.0048` 点后仅 2 个 0，**不折叠、原样显示**；若值常 ≤ 0.0005 会折成 `0.0{3}48` 形态，必要时把阈值调大 |
| 断线 | 数据不足返回 `null` ⇒ 线自然断开（figure 值域 `Nullable<D>`）；**0 参考线不参与断线**（恒返回 `0`） | 表现为"线从第 `n_i+m−1` 根开始" |
| `calcParams` | `[n_s, n_m, n_l, r_s, r_m, r_l, smooth, m]`（图表不需要 `th`） | klinecharts 数值数组 |
| 取数 warmup | **仅当 DCAP 指标开启时**：前端取数 `limit = viewport_bars + (n_l + m − 1)`，**多取部分仅供计算、不上图**；**关闭时 `limit = viewport_bars`（不动 ADR-020 既有取数口径）**。架构裁决 2026-09-13（依据 P3 实现 + 独立验收实测：开 60/3 → 182、关 → 120、服务端 `n_l=200,m=5` → 324）。**热更新口径（2026-09-13 补）**：DCAP 开关/参数变化**不得**因 warmup 变化而重建 feed（否则整图 remount）；改为 `KlineDataFeed.setWarmupBars` 以最左已加载 bar 为游标**向前补取差额**（前插，窗口回到 `viewport_bars + warmup`），图表随后 `chart.resetData()` **原地**重载数据。⇒ 上表的 `limit` 是**加载窗口口径**（端态合计），冷启动一次取满；运行中热更新走差额补取（视口最左一根仍不断线，T10 端态断言不变） | 否则视口最左侧永远缺一段；关闭时无 dcap 线，不需前置数据，避免无谓扩大取数 |
| **配置保存不得重建 pane** | **参数变更必须走 `overrideIndicator({name, calcParams})` 只更新 `calcParams`**（原地 `_calcIndicator` 重算；指标其余模板属性不得丢：DCAP 仍为**独立副图 pane**、`precision` 仍为 **5**）；**用户拖拽过的 pane 高度在保存后必须保持（±1px）**。**分工**：只有**指标启用状态翻转**（勾选开/关）才允许 `createIndicator` / `removeIndicator` —— `removeIndicator` 清空 pane 即销毁该 pane，重建时取布局默认高 `height:100`，故**尺寸/窗口类参数（MA `windows`、DCAP 8 参）一律不得销毁指标/pane**；`calcParams` 无变化时必须**幂等无操作**（保存路径有乐观更新 + 服务端回显两次 React commit）。取数 warmup（`n_l`/`m`）同理**不得进 feed 身份**（见上行「取数 warmup · 热更新口径」）。常驻防回归：`web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`（有状态 klinecharts 迷你引擎：pane 高度 ±1px + 无 remove/create churn + 线值按新参数重算）、`dcapWiringP3.test.tsx`（保存参数不重建 feed：`setDataLoader` 仅一次） | `overrideIndicator` 原地改 calcParams 不销毁 pane：`index.esm.js:15296-15321`（实测 6 条 pane 高度逐值不变、pane id 不变、线值/`precision=5` 不变：`tester/evidence/051/probe3.json` E 场景）；销毁点：`syncIndicators` 的 remove→create churn（pane 237→100px）与 warmup→feed 身份（整图 `init` +1）——`tester/test/051_dcap_save_layout_reset_diagnosis_execution.md` §2；`resetData` 保 pane 高度/视口：`tester/evidence/051/probe4.json` |

---

## 7. 接口契约 D — 配置面

**形状**比照 MA 的 `GET/PUT /api/config/ma`（`design/07-app-plane/00-web-api.md`）；**落库路径**比照 `/api/config/kline`（ADR-020）—— 两者是**不同的存储端口**，别混：

| | MA | K 线 | dcap（本方案） |
|---|---|---|---|
| 端口 | `MaConfigStore`（`crates/domain/src/ports.rs:516`） | `ConfigStore`（`config_store.rs`） | `ConfigStore` |
| 表 | `ma_config`（迁移 0015） | `app_config`（迁移 0021） | `app_config`（迁移 0021） |
| 迁移 | — | 无（新增 key 不加迁移，先例成立） | **无** |

- `app_config` = `key text PRIMARY KEY, value jsonb, updated_at`，**DB 层无 key 白名单**（`migrations/0021_app_config.sql`；`config_store.rs:21/34` 为任意 `$1` key 的 upsert）⇒ 新增 `dcap` key **无需迁移**（先例：ADR-020 的 `kline` key，`crates/web/src/settings.rs:72-75`）。

| 端点 | body | 行为 |
|---|---|---|
| `GET /api/config/dcap` | — | 返回 8 个显示参数（`n_s/n_m/n_l/r_s/r_m/r_l/smooth/m`）；无键/解析失败/越界 → 默认值 |
| `PUT /api/config/dcap` | 同上 8 参数 | 校验后写回并返回；非法（`n_s<n_m<n_l` 不成立 / 越界 / 非整数）→ 400 |

- **跨字段语义**：宿主自有端点可做跨字段校验 ⇒ **严格 400 拒绝**；与插件面的"归一化"**有意不同**（理由见 §2）。

- 主图/宫格/工作台**共用一套**参数（同一 key）。
- **前端读取韧性（ADR-020 教训）**：mount 读取必须有重试 + focus 重读，否则会表现为"重启回默认"假象。
- 编辑入口：Toolbar 内联面板，**形态照 MA windows**（用户裁决）。
- 指标勾选：加入 Toolbar 指标列表（MA/MACD/KDJ/BOLL/**DCAP**），**默认关**。
- `th` **不在此接口**（它只属策略参数，在 `/strategies` 编辑器的参数表单里）。

---

## 8. 裁决附录（本轮全部口径）

| # | 项 | 裁决 |
|---|---|---|
| 1 | 参数 1 | n 三元组（长中短，默认 8/26/60） |
| 2 | 参数 2 | **三线各自 r** |
| 3 | 参数 3 | 平滑周期 m（算法由架构师定） |
| 4 | 平滑算法 | **SMA(m)**（窗口局部 ⇒ 双实现可逐位一致） |
| 5 | 开关 | **显式开关参数** `smooth: 0/1`（ABI 无 bool，用 Int） |
| 6 | 关时口径 | 输出与原始线**逐位相同**（测试锁定） |
| 7 | 机制 | **纯指标**（滚动窗口），非锚定实盘计划 |
| 8 | 下单 | **不按 r 下单**；不改 ExecutionPolicy |
| 9 | 价格 | close（买价与估值价） |
| 10 | 数据不足 | 放弃（无值 / 插件中性 50） |
| 11 | 单位 | 比例 `0.0048`（非百分比） |
| 12 | 命名 | 指标名 `dcap`；三线字段 `s` / `m` / `l` |
| 13 | 显示 | **要上 K 线副图** |
| 14 | 实现落位 | 插件侧 JS（乙方案：插件内部映射，引擎/ABI 零改动） |
| 15 | 图表通路 | A1：前端 `registerIndicator` 自算 + tangle 单一源双产物 + `check-tangle` 门禁（ADR-021） |
| 16 | 约束 | **强制 `n_s < n_m < n_l`**：插件面 = 确定性归一化（ABI 无法表达跨字段约束）；配置端点 = 400 拒绝；编辑器 = 提示 |
| 17 | 编辑入口 | Toolbar 内联面板，形态同 MA windows |
| 18 | 配置面 | 服务端 `GET/PUT /api/config/dcap` + 前端读取韧性 |
| 19 | 取数 | 视口外多取 `n_l + m − 1` 根仅供计算 |
| 20 | 阈值 | `th` 默认 0.01、范围 0.001–0.5 |
| 21 | 评分映射 | 连续式等权三线（§4 `dcapScore`） |

**按建议默认采纳、可随时改（2 项）**
- A. 交付形态：进 `reference_plugins`（第 8 条，可播种/可参测），非仅 `templates/`。
- B. 有效性验证：作为**独立后续任务**（SWEEP IS/OOS 纪律），不阻塞指标上线。

---

## 9. 可观测性 / 可测试性要求

| 类别 | 要求 |
|---|---|
| 可测试性 | 全部计算为纯函数（DI 无需求）；两个产物由**同一组黄金样本**驱动（ADR-021 D5）；镜像体断言（D4） |
| 可观测性 | ①前端 `calc` 异常必须**降级为断线**，不得抛出打断图表渲染；②插件数据不足走中性 50，**不打 `ctx.log`**（避免 run 日志爆炸）；③插件异常仍走平台既有 `EngineEvent::PluginError`/`CircuitBreaker` 通道，不新增通道 |
| Trace ID | 本指标不引入新的调用链；沿用 run 级既有 trace（`bar_index` + `code_hash` 已含于事件） |
| 性能 | 每 bar O(n_l + m)；前端 `computeDcapSeries` 为 O(bars × (n_l+m)) —— 需在 spike 中确认 120–600 根量级的帧内耗时（见测试计划 T8） |

---

## 10. entangled 块（算法正文的唯一事实源 → 两份产物）

> 本节两个带 `file` 属性的代码块是 dcap 算法正文的**唯一事实源**（ADR-021 D1）；
> `entangled tangle` 据此生成 `web/src/features/indicators/dcap.ts`（前端模块）与
> `crates/strategy-core/reference-plugins/dcap.js`（插件）。改口径 = 改本节 → 重跑 tangle；
> **禁止手改产物**（`./scripts/check-tangle.sh` 兜底，ADR-007 / ADR-021 D6）。
>
> 哨兵区间（`// === DCAP CORE BEGIN ===` … `// === DCAP CORE END ===`）内的正文在两份产物中
> **逐字节相同**（ADR-021 D4 的机械断言，T3）；包装层（前端的 `export` / 插件的
> `PARAMS_SCHEMA`+`init`/`on_bar`/`save`/`load`）落在哨兵之外，允许两侧不同。
> §4 的浮点铁律（禁幂/指/对数方法、禁增量累加、两步法累加序、CORE 无类型注解）在本节正文内逐条落实。

### 10.1 前端模块（klinecharts 副图 `calc` 消费端）

``` {.ts file=web/src/features/indicators/dcap.ts}
// =============================================================================
// dcap —— 前端模块（klinecharts `registerIndicator` 的 `calc` 消费端）
// 由 design/14-dcap-indicator/02-spec.md §10 的代码块 tangle 生成，禁止手改；
//   改口径 = 改文档 + 重跑 `entangled tangle`（ADR-007 / ADR-021 D1/D2）。
// 镜像约束（ADR-021 D4）：`DCAP CORE BEGIN`/`END` 之间的正文与插件产物逐字节相同。
//
// @ts-nocheck —— 生成物专用豁免。理由：02-spec §4 铁律 4 强制 CORE 为「无类型注解的
//   ES2015 子集」（rquickjs 不剥注解 ⇒ CORE 内不得出现 TS 注解），在 `strict` +
//   `noUncheckedIndexedAccess` 下任何无注解 CORE 都必然报 TS7006/TS18048。本 pragma
//   仅关闭**本文件**的错误上报；导出名与交互契约由下方 interface 与 02-spec §4 钉死。
// =============================================================================

/** 显示参数（02-spec §2 的前 8 个；`th` 只属策略参数，不进前端模块）。 */
export interface DcapParams {
  n_s: number; n_m: number; n_l: number;
  r_s: number; r_m: number; r_l: number;
  smooth: number; m: number;
}

/** 单 bar 三线值；null = 数据不足（该线该 bar 无值）。 */
export interface DcapValues {
  s: number | null;
  m: number | null;
  l: number | null;
}

// === DCAP CORE BEGIN ===
/**
 * dcap CORE —— 镜像区间（ADR-021 D4）：本区间在两个产物中必须**逐字节相同**。
 *
 * 运行环境契约（02-spec §4 铁律 4）：无类型注解的 ES2015 子集 —— 同一段字节既要经
 * Vite/TS 转译进前端模块，又要被 rquickjs 直接求值（不剥类型注解）。故本区间内
 * 不得出现 TypeScript 注解、ESM 的模块导入/导出语句，也不得使用宿主 Math 之外的 API。
 *
 * 浮点确定性铁律（02-spec §4 铁律 1–3；T3/T4 逐位断言的成立前提）：
 *   ① 禁用宿主 Math 的「幂 / 指数 / 对数」三个方法 —— `r` 的幂只用**迭代乘法**（`a = a * r`）；
 *   ② 禁增量累加（running sum）—— 每 bar 都在窗口上**完整重算**；
 *   ③ 求和顺序钉死为两步：先 k = 1..n 升序迭代乘法求权重（A_1 = 1、A_{k+1} = A_k × r），
 *      再自 k = n 往回（k = n → 1）累加 ΣA_k 与 Σ(A_k/P_k)。两种合法排布的尾数相差
 *      1–2 ulp ⇒ 本段是唯一表述，不得用「等价但次序不同」的写法则套。
 *   ④ §2 跨字段约束的**入口归一化**（§4 铁律 5）也在本区间内：唯一实现 `normalizeParams`，
 *      由插件 `init` 与前端 `computeDcapSeries` 入口调用（两侧同文 ⇒ 非单调 n 下逐位一致）。
 *   k 为年龄升序：k = 1 是窗口内最旧 bar、k = n 是最新 bar（当前 bar），P_k = 第 k 根 close。
 */

/**
 * 参数归一化（02-spec §2 跨字段约束 / §4 铁律 5）：把三条窗口顶成严格单调
 * `n_s < n_m' < n_l'` —— `n_m' ← max(n_m, n_s+1)`、`n_l' ← max(n_l, n_m'+1)`
 * （**顺序归一**：n_l' 用已归一后的 n_m'）。**确定且幂等**（f(f(p)) = f(p)）。
 * 入口调用一次：插件 `init` 与前端 `computeDcapSeries`（§3「参数归一化」行）；
 * `on_bar` 内不得重复归一化（否则窗口容量逐 bar 漂移 ⇒ 确定性与重放失守）。
 * 非有限输入（NaN/±Inf）的归一结果仍非有限，由调用方按「参数非法 → 中立」处理（§5）。
 */
function normalizeParams(p) {
  var s = Math.floor(p.n_s);
  var m = Math.max(Math.floor(p.n_m), s + 1);
  var l = Math.max(Math.floor(p.n_l), m + 1);
  return { n_s: s, n_m: m, n_l: l, r_s: p.r_s, r_m: p.r_m, r_l: p.r_l, smooth: p.smooth, m: p.m };
}

/**
 * 单条线的定投收益率（02-spec §1.2）：窗口 = 最近 n 根 close（含当前 bar）。
 * 金额 A_1 = 1、A_k = r^(k−1)（首笔约掉 ⇒ 无资金规模参数）。
 * ROI = P_n · Σ(A_k/P_k) / ΣA_k − 1；null = 数据不足（bar 数 < n 或价格非法）。
 */
function dcapRoi(closes, n, r) {
  var nn = Math.floor(n);
  if (!(nn >= 1) || nn > closes.length) { return null; }
  var base = closes.length - nn;

  // ① k = 1..n 升序：迭代乘法求权重（禁用 pow）
  var weights = [];
  var a = 1;
  for (var k = 0; k < nn; k++) {
    weights.push(a);
    a = a * r;
  }

  // ② k = n → 1 往回：累加 ΣA_k 与 Σ(A_k/P_k)（本顺序即尾数，不得改写）
  var sumA = 0;
  var sumAP = 0;
  for (var j = nn - 1; j >= 0; j--) {
    var p = closes[base + j];
    if (!(p > 0)) { return null; }   // 除零/非法价 → 按数据不足（插件侧不得抛错，§5）
    sumA = sumA + weights[j];
    sumAP = sumAP + weights[j] / p;
  }
  var last = closes[closes.length - 1];
  return last * sumAP / sumA - 1;
}

/**
 * SMA(m)（02-spec §3）：窗口局部 ⇒ 起算点无关（ADR-021 D1 成立的前提）。
 * smooth = 0 或 m <= 1 ⇒ **逐位直通原值**（§8 裁决 6；不得走第二条近似路径）。
 * 忽略 null 前导（窗口不推进）；有效值不足 m 个 ⇒ null。
 */
function smoothSeries(values, smooth, m) {
  var mm = Math.floor(m);
  var out = [];
  var i;
  if (smooth === 0 || !(mm > 1)) {
    for (i = 0; i < values.length; i++) { out.push(values[i]); }
    return out;
  }
  var win = [];
  for (i = 0; i < values.length; i++) {
    var v = values[i];
    if (v === null || v === undefined) {
      out.push(null);
      continue;
    }
    win.push(v);
    if (win.length > mm) { win.shift(); }
    if (win.length < mm) {
      out.push(null);
      continue;
    }
    var sum = 0;
    for (var j = 0; j < mm; j++) { sum = sum + win[j]; }
    out.push(sum / mm);
  }
  return out;
}

/**
 * 整段序列（图表 calc 用）：每个 index 只依赖 closes[..=index]（**禁未来函数**、
 * 禁增量累加 —— T2-b 用 dcapRoi 独立复算逐位钉死）。
 * 入口先 `normalizeParams(p)`（§4 铁律 5），后续一律用归一后的 `q`。
 */
function computeDcapSeries(closes, p) {
  var q = normalizeParams(p);   // §4 铁律 5：前端入口归一化（CORE 内唯一实现，与插件同口径）
  var rawS = [];
  var rawM = [];
  var rawL = [];
  for (var i = 0; i < closes.length; i++) {
    var prefix = closes.slice(0, i + 1);
    rawS.push(dcapRoi(prefix, q.n_s, q.r_s));
    rawM.push(dcapRoi(prefix, q.n_m, q.r_m));
    rawL.push(dcapRoi(prefix, q.n_l, q.r_l));
  }
  var smS = smoothSeries(rawS, q.smooth, q.m);
  var smM = smoothSeries(rawM, q.smooth, q.m);
  var smL = smoothSeries(rawL, q.smooth, q.m);
  var out = [];
  for (var j = 0; j < closes.length; j++) {
    out.push({ s: smS[j], m: smM[j], l: smL[j] });
  }
  return out;
}

/**
 * 评分映射（02-spec §4）：per_i = clamp(roi_i / th, −1, +1)；
 * score = clamp(50 − (50/N)·Σ per_i, 0, 100)。缺值的线跳过（不计入 N）；三线全缺 → 50。
 * 三线等权 =「平均观感」而非「平均 ROI」，保住三重确认语义。
 */
function dcapScore(values, th) {
  var roi = [];
  if (values.s !== null && values.s !== undefined) { roi.push(values.s); }
  if (values.m !== null && values.m !== undefined) { roi.push(values.m); }
  if (values.l !== null && values.l !== undefined) { roi.push(values.l); }
  if (roi.length === 0) { return 50; }
  var acc = 0;
  for (var i = 0; i < roi.length; i++) {
    var per = roi[i] / th;
    if (per < -1) { per = -1; }
    if (per > 1) { per = 1; }
    acc = acc + per;
  }
  var score = 50 - (50 / roi.length) * acc;
  if (score < 0) { score = 0; }
  if (score > 100) { score = 100; }
  return score;
}
// === DCAP CORE END ===

/**
 * 对外导出（02-spec §4 契约名）：dcapRoi / smoothSeries / computeDcapSeries / dcapScore。
 * 实现正文在哨兵区间内（与插件产物逐字节相同），此处只做导出。
 */
export { dcapRoi, smoothSeries, computeDcapSeries, dcapScore };
```

### 10.2 策略插件（strategy-runtime rquickjs 求值 + `reference.rs` 播种）

``` {.js file=crates/strategy-core/reference-plugins/dcap.js}
// =============================================================================
// 参考插件：dcap —— 假想定投收益率三线（短/中/长），纯滚动指标（无仓位换算，ADR §13.1）
// 由 design/14-dcap-indicator/02-spec.md §10 的代码块 tangle 生成，禁止手改；
//   改口径 = 改文档 + 重跑 `entangled tangle`（ADR-007 / ADR-021 D1/D2）。
// 镜像约束（ADR-021 D4）：`DCAP CORE BEGIN`/`END` 之间的正文与前端产物逐字节相同。
//
// 口径（02-spec §5）：on_bar ① 维护三条 close 滚动窗口 → ② 逐线算 ROI → ③ SMA(m) 平滑
//   → ④ 数据不足的线跳过（不计入 N）→ ⑤ 三线全不足返回 50（中立）→ ⑥ 否则 dcapScore(v, th)。
//   · 出口 [0,100]：平台 clamp_score + 60/40 阈值零改动（引擎不知道 dcap 存在）。
//   · 异常路径：close <= 0 按数据不足处理，**不得抛错**（避免熔断计次，§5）。
//   · init(params)：**先做三 n 归一化**（CORE `normalizeParams`，§2/§4 铁律 5）再初始化
//     状态；归一化确定 + 幂等，on_bar 内不得重复归一化（窗口容量恒定，T5a）。
//   · 平滑只保留最近 m 个原始 ROI 的尾窗 ⇒ 复用 CORE 的 smoothSeries（同表达式、同求和序）。
//
// 内部状态（ABI G3，必须进 save()/load()，否则重放分叉）：
//   · 三条 close 滚动窗口（各 n_i 长，尾部 = 最新 bar）；
//   · 三条原始 ROI 的平滑尾窗（各 ≤ m 长，含当前 bar）。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "n_s", type: "int", default: 8, min: 2, max: 250, description: "短窗口：最近 n 根 close" },
  { key: "n_m", type: "int", default: 26, min: 2, max: 250, description: "中窗口" },
  { key: "n_l", type: "int", default: 60, min: 2, max: 250, description: "长窗口（跨字段约束 n_s<n_m<n_l 由发布门禁强制）" },
  { key: "r_s", type: "float", default: 1.0, min: 0.5, max: 2.0, description: "短窗口金额增长比" },
  { key: "r_m", type: "float", default: 1.0, min: 0.5, max: 2.0, description: "中窗口金额增长比" },
  { key: "r_l", type: "float", default: 1.0, min: 0.5, max: 2.0, description: "长窗口金额增长比" },
  { key: "smooth", type: "int", default: 1, min: 0, max: 1, description: "平滑开关：0=关（原始线）/ 1=开（SMA(m)）" },
  { key: "m", type: "int", default: 3, min: 1, max: 60, description: "平滑周期；smooth=0 时忽略但仍受校验" },
  { key: "th", type: "float", default: 0.01, min: 0.001, max: 0.5, description: "评分映射标度（仅策略侧使用，图表不用）" }
];

// 归一化后的生效窗口（02-spec §2/§4 铁律 5：只在 init 归一一次，on_bar 只读；
// 属 params 的派生量，非流相关状态 ⇒ 不进 save()/load()，§5「内部状态」只列六条窗口）。
let effS = 8;
let effM = 26;
let effL = 60;

// 内部状态（ABI G3）
let winS = [];
let winM = [];
let winL = [];
let tailS = [];
let tailM = [];
let tailL = [];

// === DCAP CORE BEGIN ===
/**
 * dcap CORE —— 镜像区间（ADR-021 D4）：本区间在两个产物中必须**逐字节相同**。
 *
 * 运行环境契约（02-spec §4 铁律 4）：无类型注解的 ES2015 子集 —— 同一段字节既要经
 * Vite/TS 转译进前端模块，又要被 rquickjs 直接求值（不剥类型注解）。故本区间内
 * 不得出现 TypeScript 注解、ESM 的模块导入/导出语句，也不得使用宿主 Math 之外的 API。
 *
 * 浮点确定性铁律（02-spec §4 铁律 1–3；T3/T4 逐位断言的成立前提）：
 *   ① 禁用宿主 Math 的「幂 / 指数 / 对数」三个方法 —— `r` 的幂只用**迭代乘法**（`a = a * r`）；
 *   ② 禁增量累加（running sum）—— 每 bar 都在窗口上**完整重算**；
 *   ③ 求和顺序钉死为两步：先 k = 1..n 升序迭代乘法求权重（A_1 = 1、A_{k+1} = A_k × r），
 *      再自 k = n 往回（k = n → 1）累加 ΣA_k 与 Σ(A_k/P_k)。两种合法排布的尾数相差
 *      1–2 ulp ⇒ 本段是唯一表述，不得用「等价但次序不同」的写法则套。
 *   ④ §2 跨字段约束的**入口归一化**（§4 铁律 5）也在本区间内：唯一实现 `normalizeParams`，
 *      由插件 `init` 与前端 `computeDcapSeries` 入口调用（两侧同文 ⇒ 非单调 n 下逐位一致）。
 *   k 为年龄升序：k = 1 是窗口内最旧 bar、k = n 是最新 bar（当前 bar），P_k = 第 k 根 close。
 */

/**
 * 参数归一化（02-spec §2 跨字段约束 / §4 铁律 5）：把三条窗口顶成严格单调
 * `n_s < n_m' < n_l'` —— `n_m' ← max(n_m, n_s+1)`、`n_l' ← max(n_l, n_m'+1)`
 * （**顺序归一**：n_l' 用已归一后的 n_m'）。**确定且幂等**（f(f(p)) = f(p)）。
 * 入口调用一次：插件 `init` 与前端 `computeDcapSeries`（§3「参数归一化」行）；
 * `on_bar` 内不得重复归一化（否则窗口容量逐 bar 漂移 ⇒ 确定性与重放失守）。
 * 非有限输入（NaN/±Inf）的归一结果仍非有限，由调用方按「参数非法 → 中立」处理（§5）。
 */
function normalizeParams(p) {
  var s = Math.floor(p.n_s);
  var m = Math.max(Math.floor(p.n_m), s + 1);
  var l = Math.max(Math.floor(p.n_l), m + 1);
  return { n_s: s, n_m: m, n_l: l, r_s: p.r_s, r_m: p.r_m, r_l: p.r_l, smooth: p.smooth, m: p.m };
}

/**
 * 单条线的定投收益率（02-spec §1.2）：窗口 = 最近 n 根 close（含当前 bar）。
 * 金额 A_1 = 1、A_k = r^(k−1)（首笔约掉 ⇒ 无资金规模参数）。
 * ROI = P_n · Σ(A_k/P_k) / ΣA_k − 1；null = 数据不足（bar 数 < n 或价格非法）。
 */
function dcapRoi(closes, n, r) {
  var nn = Math.floor(n);
  if (!(nn >= 1) || nn > closes.length) { return null; }
  var base = closes.length - nn;

  // ① k = 1..n 升序：迭代乘法求权重（禁用 pow）
  var weights = [];
  var a = 1;
  for (var k = 0; k < nn; k++) {
    weights.push(a);
    a = a * r;
  }

  // ② k = n → 1 往回：累加 ΣA_k 与 Σ(A_k/P_k)（本顺序即尾数，不得改写）
  var sumA = 0;
  var sumAP = 0;
  for (var j = nn - 1; j >= 0; j--) {
    var p = closes[base + j];
    if (!(p > 0)) { return null; }   // 除零/非法价 → 按数据不足（插件侧不得抛错，§5）
    sumA = sumA + weights[j];
    sumAP = sumAP + weights[j] / p;
  }
  var last = closes[closes.length - 1];
  return last * sumAP / sumA - 1;
}

/**
 * SMA(m)（02-spec §3）：窗口局部 ⇒ 起算点无关（ADR-021 D1 成立的前提）。
 * smooth = 0 或 m <= 1 ⇒ **逐位直通原值**（§8 裁决 6；不得走第二条近似路径）。
 * 忽略 null 前导（窗口不推进）；有效值不足 m 个 ⇒ null。
 */
function smoothSeries(values, smooth, m) {
  var mm = Math.floor(m);
  var out = [];
  var i;
  if (smooth === 0 || !(mm > 1)) {
    for (i = 0; i < values.length; i++) { out.push(values[i]); }
    return out;
  }
  var win = [];
  for (i = 0; i < values.length; i++) {
    var v = values[i];
    if (v === null || v === undefined) {
      out.push(null);
      continue;
    }
    win.push(v);
    if (win.length > mm) { win.shift(); }
    if (win.length < mm) {
      out.push(null);
      continue;
    }
    var sum = 0;
    for (var j = 0; j < mm; j++) { sum = sum + win[j]; }
    out.push(sum / mm);
  }
  return out;
}

/**
 * 整段序列（图表 calc 用）：每个 index 只依赖 closes[..=index]（**禁未来函数**、
 * 禁增量累加 —— T2-b 用 dcapRoi 独立复算逐位钉死）。
 * 入口先 `normalizeParams(p)`（§4 铁律 5），后续一律用归一后的 `q`。
 */
function computeDcapSeries(closes, p) {
  var q = normalizeParams(p);   // §4 铁律 5：前端入口归一化（CORE 内唯一实现，与插件同口径）
  var rawS = [];
  var rawM = [];
  var rawL = [];
  for (var i = 0; i < closes.length; i++) {
    var prefix = closes.slice(0, i + 1);
    rawS.push(dcapRoi(prefix, q.n_s, q.r_s));
    rawM.push(dcapRoi(prefix, q.n_m, q.r_m));
    rawL.push(dcapRoi(prefix, q.n_l, q.r_l));
  }
  var smS = smoothSeries(rawS, q.smooth, q.m);
  var smM = smoothSeries(rawM, q.smooth, q.m);
  var smL = smoothSeries(rawL, q.smooth, q.m);
  var out = [];
  for (var j = 0; j < closes.length; j++) {
    out.push({ s: smS[j], m: smM[j], l: smL[j] });
  }
  return out;
}

/**
 * 评分映射（02-spec §4）：per_i = clamp(roi_i / th, −1, +1)；
 * score = clamp(50 − (50/N)·Σ per_i, 0, 100)。缺值的线跳过（不计入 N）；三线全缺 → 50。
 * 三线等权 =「平均观感」而非「平均 ROI」，保住三重确认语义。
 */
function dcapScore(values, th) {
  var roi = [];
  if (values.s !== null && values.s !== undefined) { roi.push(values.s); }
  if (values.m !== null && values.m !== undefined) { roi.push(values.m); }
  if (values.l !== null && values.l !== undefined) { roi.push(values.l); }
  if (roi.length === 0) { return 50; }
  var acc = 0;
  for (var i = 0; i < roi.length; i++) {
    var per = roi[i] / th;
    if (per < -1) { per = -1; }
    if (per > 1) { per = 1; }
    acc = acc + per;
  }
  var score = 50 - (50 / roi.length) * acc;
  if (score < 0) { score = 0; }
  if (score > 100) { score = 100; }
  return score;
}
// === DCAP CORE END ===

/**
 * 单线推进：close 入滚动窗 → 原始 ROI → 平滑尾窗 → SMA(m)（复用 CORE 的 smoothSeries）。
 * 尾窗长度 ≤ m ⇒ smoothSeries 在该窗上的末元素与前端「整段序列上的 SMA(m)」逐位相同
 * （SMA 窗口局部；原始 ROI 的 null 仅出现在前导，两端一致 —— 见 02-spec §3）。
 */
function dcapPushLine(win, tail, close, n, r, smooth, m) {
  win.push(close);
  if (win.length > n) { win.shift(); }
  const raw = dcapRoi(win, n, r);
  tail.push(raw);
  if (tail.length > m) { tail.shift(); }
  const sm = smoothSeries(tail, smooth, m);
  return sm[sm.length - 1];
}

function init(params) {
  // §2 跨字段约束：先做 CORE 归一化（确定 + 幂等），生效值存模块状态；
  // on_bar 内不得重复归一化（窗口容量恒定 ⇒ T5a-4）。
  const q = normalizeParams(params);
  effS = Math.floor(q.n_s);
  effM = Math.floor(q.n_m);
  effL = Math.floor(q.n_l);
  winS = [];
  winM = [];
  winL = [];
  tailS = [];
  tailM = [];
  tailL = [];
}

function on_bar(ctx) {
  const p = ctx.params;
  const nS = effS;   // init 归一化后的生效值（on_bar 不再归一，§3/§5）
  const nM = effM;
  const nL = effL;
  const mm = Math.floor(p.m);
  if (!(nS >= 1) || !(nM >= 1) || !(nL >= 1) || !(mm >= 1)) {
    return 50; // 参数非法（含 NaN/±Inf）→ 中立（不抛错，避 ABI G5 熔断计次）
  }
  const close = ctx.bar.close;
  const values = {
    s: dcapPushLine(winS, tailS, close, nS, p.r_s, p.smooth, mm),
    m: dcapPushLine(winM, tailM, close, nM, p.r_m, p.smooth, mm),
    l: dcapPushLine(winL, tailL, close, nL, p.r_l, p.smooth, mm)
  };
  return dcapScore(values, p.th);
}

function save() {
  return {
    winS: winS.slice(), winM: winM.slice(), winL: winL.slice(),
    tailS: tailS.slice(), tailM: tailM.slice(), tailL: tailL.slice()
  };
}

// 防御口径（NIT-3，与 kdj/dual_ma/boll 一致）：字段缺失/类型错误 → 回退安全默认
// （= init() 初始值），不得把 undefined 写入状态引入 NaN 污染。
function load(state) {
  const s = state || {};
  winS = Array.isArray(s.winS) ? s.winS.slice() : [];
  winM = Array.isArray(s.winM) ? s.winM.slice() : [];
  winL = Array.isArray(s.winL) ? s.winL.slice() : [];
  tailS = Array.isArray(s.tailS) ? s.tailS.slice() : [];
  tailM = Array.isArray(s.tailM) ? s.tailM.slice() : [];
  tailL = Array.isArray(s.tailL) ? s.tailL.slice() : [];
}
```
