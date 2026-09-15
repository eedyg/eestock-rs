# 286 · VOL 成交量副图「可关闭的普通指标开关（默认开）」独立真渲染验收 + 沙箱变异反证

- **报告自身路径**：`tester/test/286_vol_toggle_acceptance.md`
- **证据目录**：`tester/evidence/286_vol_acceptance/`（索引：`00_INDEX.txt`）
- **验收脚本（已随证据存档，可复跑）**：
  - `tester/evidence/286_vol_acceptance/286_acceptance.mjs`（A1–A7 + A6 收尾；运行：`cd <repo>/web && node <repo>/tester/evidence/286_vol_acceptance/286_acceptance.mjs`）
  - `tester/evidence/286_vol_acceptance/286_supplementary_session_state.mjs`（A8 附加：会话态/刷新回默认开）
  - `tester/evidence/286_vol_acceptance/286_pixel_evidence.py`（A9 附加：截图像素统计）
- **仓库 cwd**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **被验对象**：线上 `http://127.0.0.1:8081/`
  - `title = eestock · 行情看板`；`<script type="module" src="/assets/index-dH4SuwMy.js">`（**与任务给定的 bundle 名一致**）
  - 进程：`eestock-app` PID `1247798`，启动 `Tue Sep 15 22:27:42 2026 +0800`，`static_dir = ./web/dist`，dist 产物 mtime `2026-09-15 22:27:23.637 +0800`
  - 原始证据：`A0_env.txt`
- **验收时间**：
  - 首次基线读取（任务口径「验收开始」）：`2026-09-15 22:29:42 +0800`
  - 脚本主窗口：`2026-09-15T14:34:52Z ~ 14:35:23Z` = `22:34:52 ~ 22:35:23 +0800`
  - A8 补充：`22:36`；A9 像素统计：`22:36~22:37`
- **验收性质**：只读验收 + 沙箱变异。
  - 对 `/api/*` **只发 GET**（A6 证据：本会话页面内所有 `/api/` 请求方法集合 = `["GET"]`；附加脚本记录「非 GET 请求数 = 0」）。
  - **未**点「周期选择」入口的确定按钮；**未**用图表导出截图（一律 `page.screenshot`）。
  - **未**修改工作区任何源码/配置/产物（`A0_env.txt` 给出源码 md5 + mtime，均早于验收开始）。
  - 变异实验**只在 `/tmp/vol286_sandbox/web` 副本内**进行；**未** `git add` / `git commit`。

---

## 0. 结论速览

| 项 | 内容 | 判定 |
|---|---|---|
| A1 | 工具栏 VOL 开关存在且**默认开**（DOM 契约） | **PASS** |
| A2 | 基线取证（主图 + 每个卫星：图例原文 / separator 数 / `[data-mp-pane]` 高度 / 截图） | **PASS**（卫星实测为 **1h、1d**，与任务前提 15m/1h 不同，见 §1） |
| A3 | 点 VOL 关闭 ⇒ 主图 + **全部卫星** pane 内 VOL 图例消失 | **PASS** |
| A4 | 再点开 ⇒ VOL 恢复；多周期栈 pane 高度**逐值一致**；无 0 高/重叠/残留分隔条/pane 数异常 | **PASS** |
| A5 | 沙箱变异反证（VOL 判定恒 true ⇒ 测试必须变红） | **PASS**（14 passed → 6 failed / 8 passed） |
| A6 | 零配置写入（验收窗口首尾 GET 逐字段相同）+ console/network 结论 | **PASS**（附「外部（用户）同时操作」说明，见 §1、§7） |
| A7 | 纯前端回归：分时↔K线、宫格 2×2↔单图 | **PASS** |
| A8（附加） | 会话态：默认开 → 点击关 → **刷新回默认开**；零非 GET 请求 | **PASS** |
| A9（附加） | 像素级渲染证据（截图 ink 占比 / 逐像素差异 / md5） | **PASS** |

**关键原始数据速查**

| 指标 | 值 |
|---|---|
| VOL 开关 DOM | `<button class="… bg-gradient-to-br from-acc1 to-acc2 text-white … h-7 px-3" aria-pressed="true">VOL</button>` |
| 指标开关行（顺序 + 状态） | `MA=true, VOL=true, MACD=false, KDJ=false, BOLL=false, DCAP=false` |
| 运行基线 `GET /api/config/multi_period` | `{"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}` |
| `[data-mp-pane]` inline 高度（A2 基线 = A4 再开） | `5m=364px, 1h=180px, 1d=180px`（逐值一致） |
| 基准图 candle / VOL pane 像素高 | `["237px","100px"]` → VOL 关 `["338px"]` → VOL 再开 `["237px","100px"]` |
| 基准 pane 截图逐像素差异（A4 vs A2） | `0.0000`（逐像素一致） |
| 整页截图 md5 | A1 = A2 = A4 = `c88b0e7f480ab2bbd9a077fb24578f1f`；A3 = `bfcbb352a7148025ff2cc42c9f0e0aad` |
| 沙箱变异 | 14 passed（变异前） → **6 failed / 8 passed**（变异后，exit=1） |
| console | error **0**；pageerror **0**；requestfailed **0**；warning **8**（同一条多周期同步告警，原文见 §7） |

---

## 1. ⚠️ 前提差异与「外部（用户）同时操作」标注（**不据此判 FAIL**）

### 1.1 任务前提 vs 运行时基线

| 时刻（+0800） | `GET /api/config/multi_period` | 来源 |
|---|---|---|
| `22:29:42`（本次验收**首次**读取 = 任务口径的「验收开始」） | `{"enabled":true,"periods":["5m","15m","1h"],"heights":{"15m":180,"1h":180,"5m":231},"indicators":["dcap"]}` | `A6_config_acceptance_begin_222942.txt` |
| `22:30:35`（**DB 写入时刻**） | 变为 `periods=["5m","1h","1d"]` | `app_config.updated_at = 2026-09-15 14:30:35.055312+00` |
| `22:34:52`（脚本主窗口开始） | `{"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}` | `A6_config_start.txt` |
| `22:35:23`（脚本主窗口结束） | 同上，**逐字段相同** | `A6_config_end.txt` |

**事实**（仅陈述，不判 FAIL）：

1. 本次验收开始（22:29:42）读到的配置 **与任务前提完全一致**（`5m / 15m / 1h`，heights `231/180/180`）。
2. 该配置在 **22:30:35** 被改成 `5m / 1h / 1d`（DB `updated_at` 为唯一时间戳证据），**发生在我的首次基线读取之后、脚本主窗口之前**。
3. 因此 **页面实测卫星 = `1h`、`1d`**（两份），而非任务文字里的「15m、1h」。按任务要求，本项标注为
   **「外部（用户）同时操作」**，**不据此判 FAIL**；A2–A4/A7 一律以**验收脚本运行时的真实返回**为基线（脚本自己在运行首尾各读一次并写入证据）。
4. 我在 22:29–22:37 之间对 `/api/*` **只发过 GET**（`A6_zero_write.txt` 的请求方法与 `A8_session_state.txt` 的「非 GET 请求数 = 0」），
   22:30:35 的写入**不可能来自本次验收**；同一数据库行在 22:35:2x 复读仍为 `14:30:35.055312+00`（即该行自 22:30:35 起未被再碰过）。

### 1.2 A6 「`updated_at` 早于部署窗口」交叉核对 —— **字面预期不成立（外部因素）**

- 部署窗口：`eestock-app` 启动 `Tue Sep 15 22:27:42 2026 +0800`；dist 产物 mtime `22:27:23 +0800`。
- 实测：`app_config.multi_period.updated_at = 2026-09-15 14:30:35.055312+00` = **`22:30:35 +0800`**，**晚于**部署窗口约 3 分钟。
- 即：该行并非「早于本次部署窗口」，而是**部署后被用户本人用选择器改过**（与任务开头「配置刚被用户本人改过」的前提一致，只是又改了一次）。
- 按任务口径，此项**不判 FAIL**，如实标注为 **「外部（用户）同时操作」**。
- 另：`app_config.dcap.updated_at = 2026-09-13 15:27:38+00`（早于部署窗口，无关本次变更）。

---

## A1 工具栏出现 VOL 开关且默认处于开态 — **PASS**

证据：`A1_toolbar_vol_switch.txt`、`A1_toolbar_vol_default_on.png`、`A1_fullpage_default_on.png`

**DOM 契约（原文，抓取于 `2026-09-15T14:34:56.760Z`）**

```html
<button class="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-lg text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 border border-transparent bg-gradient-to-br from-acc1 to-acc2 text-white shadow-[0_2px_10px_rgba(56,189,248,.35)] h-7 px-3" aria-pressed="true">VOL</button>
```

| 属性 | 值 |
|---|---|
| 标签文本 | `VOL` |
| `aria-pressed` | `true`（默认开） |
| `class` | `inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-lg text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 border border-transparent bg-gradient-to-br from-acc1 to-acc2 text-white shadow-[0_2px_10px_rgba(56,189,248,.35)] h-7 px-3`（**与主/次按钮同构**：按下态走 `variant=primary` 配色） |
| 可见 | `true` |

**并列性（工具栏指标开关行顺序与状态，证明 VOL 是与 MA/MACD/KDJ/BOLL/DCAP 并列的一个开关）**

```console
  MA     aria-pressed=true
  VOL    aria-pressed=true
  MACD   aria-pressed=false
  KDJ    aria-pressed=false
  BOLL   aria-pressed=false
  DCAP   aria-pressed=false
```

截图：`A1_toolbar_vol_default_on.png`（工具栏区域，VOL 为高亮按下态）、`A1_fullpage_default_on.png`（整页）。

---

## A2 基线取证（VOL 默认开） — **PASS**

证据：`A2_baseline.txt`、`A2_baseline_full.png`、`A2_baseline_base_pane.png`、`A2_baseline_satellite_1h.png`、`A2_baseline_satellite_1d.png`

**运行时基线配置**（脚本窗口开始时读取）

```json
{"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}
```

⇒ 基准 K 线 pane = **5m**；卫星 = **1h、1d**（`[data-mp-satellite]` 两个元素，实测值；与任务前提 15m/1h 的差异见 §1）。

**`[data-mp-pane]` inline 高度（多周期栈）**

```console
  5m  role=base       attr=364  inline=364px  rect=364  childIndex=0
  1h  role=satellite  attr=180  inline=180px  rect=180  childIndex=2
  1d  role=satellite  attr=180  inline=180px  rect=180  childIndex=4
```

**`[data-mp-separator]`（栈级分隔条）**

```console
  5m|1h  data-mp-sep-height=0  rect=0
  1h|1d  data-mp-sep-height=0  rect=0
```

**每个 klinecharts 实例（DOM）：pane 内联高度 / separator 数 / x 轴**

```console
  k_line_chart_1: panes=["237px","100px"] sepCount=1 seps=["1px"] xAxis=["26px"] hostRect=1522x364
  k_line_chart_2: panes=["0px","135px"]   sepCount=1 seps=["0px"] xAxis=["26px"] hostRect=1522x161
  k_line_chart_3: panes=["0px","135px"]   sepCount=1 seps=["0px"] xAxis=["26px"] hostRect=1522x161
```

> 说明：`k_line_chart_1` 为基准图（candle pane 237px + klinecharts separator 1px + VOL pane 100px + x 轴 26px = 364px）；
> `k_line_chart_2/3` 为卫星（candle pane 被 `state:'minimize'` 折叠为 0px、`separator:{size:0}` ⇒ separator 高 0px，指标 pane 135px）。

**每个 pane 的图例原文**（对 canvas `fillText` 全量捕获后按 pane 归并，排除纯数字刻度）

```console
  k_line_chart_1|pane#0|237px: ["518880 · 5","Time: ","2026-09-15 15:00","Open: ","High: ","Low: ","Close: ","Volume: ","MA(5,10,20)","MA5: ","MA10: ","MA20: "]
  k_line_chart_1|pane#2|100px: ["VOL(5,10,20)","MA5: ","MA10: ","MA20: ","VOLUME: "]
  k_line_chart_1|pane#3|26px : ["14:45","10:30","13:15","14:35","10:20","13:05","14:25"]
  k_line_chart_2|pane#0|0px  : ["518880 · 1H","Time: ","2026-09-15 15:00","Open: ","High: ","Low: ","Close: ","Volume: ","MA(5,10,20)","MA5: ","MA10: ","MA20: "]
  k_line_chart_2|pane#2|135px: ["VOL(5,10,20)","MA5: ","MA10: ","MA20: ","VOLUME: "]
  k_line_chart_2|pane#3|26px : ["08-21 14:00","08-26 11:00","08-31 09:00","09-02 14:00","09-07 11:00","09-10 09:00","09-14 14:00"]
  k_line_chart_3|pane#0|0px  : ["518880 · 1D","Time: ","Open: ","High: ","Low: ","Close: ","Volume: ","MA(5,10,20)","MA5: ","MA10: ","MA20: "]
  k_line_chart_3|pane#2|135px: ["VOL(5,10,20)","MA5: ","MA10: ","MA20: ","VOLUME: "]
  k_line_chart_3|pane#3|26px : []
```

⇒ **含 VOL 图例行的 pane**（基线）= 3 个：基准图 `pane#2`（100px）、卫星 1h `pane#2`（135px）、卫星 1d `pane#2`（135px），
每个都同时画出 `VOL(5,10,20)` 与 `VOLUME: `。

**引擎侧指标**（经 React fiber 取到 chart 实例后调 `chart.getIndicators()`）

```console
  k_line_chart_1: MA(paneId=candle_pane, calcParams=[5,10,20]) , VOL(paneId=indicator_pane_…_2, calcParams=[5,10,20])
  k_line_chart_2: MA(paneId=candle_pane, calcParams=[5,10,20]) , VOL(paneId=indicator_pane_…_3, calcParams=[5,10,20])
  k_line_chart_3: MA(paneId=candle_pane, calcParams=[5,10,20]) , VOL(paneId=indicator_pane_…_3, calcParams=[5,10,20])
```

⇒ VOL 各自落在**独立副图 pane**（`paneId ≠ candle_pane`），MA 仍叠加在 `candle_pane`。
（`chart.getPaneOptions()` 原始返回见 `286_results.json` 的 `items.A2.instances`。）

**像素级佐证**（`A9_pixel_evidence.txt`）
- 基准 pane 截图：candle 带 (0–236px) ink 占比 `0.1344`；VOL 带 (238–337px) ink 占比 `0.2165`（有成交量柱）；x 轴带 `0.0583`。
- 卫星 1h 截图 ink 占比 `0.1533`；卫星 1d `0.2365`。

截图：`A2_baseline_full.png`、`A2_baseline_base_pane.png`、`A2_baseline_satellite_1h.png`、`A2_baseline_satellite_1d.png`。

---

## A3 点 VOL 关闭 ⇒ 主图 + 全部卫星 pane 内 VOL 图例消失 — **PASS**

证据：`A3_vol_off.txt`、`A3_vol_off_full.png`、`A3_vol_off_base_pane.png`、`A3_vol_off_satellite_1h.png`、`A3_vol_off_satellite_1d.png`

**开关态变化（class 原文对比）**

| 时刻 | `aria-pressed` | `class`（按钮） |
|---|---|---|
| A1/A2 基线（开） | `true` | `… bg-gradient-to-br from-acc1 to-acc2 text-white shadow-[0_2px_10px_rgba(56,189,248,.35)] h-7 px-3`（primary） |
| A3（关） | `false` | `… border border-line text-dim hover:text-txt hover:bg-white/5 h-7 px-3`（ghost） |

关闭态按钮原文：

```html
<button class="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-lg text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 border border-line text-dim hover:text-txt hover:bg-white/5 h-7 px-3" aria-pressed="false">VOL</button>
```

**VOL 图例「关闭前 → 关闭后」原文对比**

```console
关闭前（A2 基线）:{
  "k_line_chart_1|pane#2|100px": {"legendLine":["VOL(5,10,20)"],"label":["VOLUME: "]},
  "k_line_chart_2|pane#2|135px": {"legendLine":["VOL(5,10,20)"],"label":["VOLUME: "]},
  "k_line_chart_3|pane#2|135px": {"legendLine":["VOL(5,10,20)"],"label":["VOLUME: "]}}
关闭后（A3）   : {}          ← 主图与两个卫星**全部**无 VOL 图例
```

**关闭后每个 pane 的图例原文（主图仍保留 MA，卫星只剩被折叠的 candle pane）**

```console
  k_line_chart_1|pane#0|338px: ["518880 · 5","Time: ","2026-09-15 15:00","Open: ","High: ","Low: ","Close: ","Volume: ","MA(5,10,20)","MA5: ","MA10: ","MA20: "]
  k_line_chart_1|pane#1|26px : ["14:45","10:30","13:15","14:35","10:20","13:05","14:25"]
  k_line_chart_2|pane#0|0px  : ["518880 · 1H","Time: ","…","MA(5,10,20)","MA5: ","MA10: ","MA20: "]
  k_line_chart_2|pane#1|26px : ["08-21 14:00","…"]
  k_line_chart_3|pane#0|0px  : ["518880 · 1D","Time: ","…","MA(5,10,20)","MA5: ","MA10: ","MA20: "]
  k_line_chart_3|pane#1|26px : []
```

**pane 数 / klinecharts separator 数变化**

```console
  k_line_chart_1: 前 panes=["237px","100px"] sep=1/["1px"]  ⇒  后 panes=["338px"] sep=0/[]
  k_line_chart_2: 前 panes=["0px","135px"]   sep=1/["0px"]  ⇒  后 panes=["0px"]   sep=0/[]
  k_line_chart_3: 前 panes=["0px","135px"]   sep=1/["0px"]  ⇒  后 panes=["0px"]   sep=0/[]
```

⇒ 三个实例各自**恰好减少 1 个 pane（被移除的 VOL pane）与 1 个 separator**，无残留空 VOL pane、无残留分隔条。

**关闭后 `[data-mp-pane]` inline 高度**（与基线逐值一致，说明切换 VOL 未动多周期栈布局）

```console
  5m role=base attr=364 inline=364px rect=364
  1h role=satellite attr=180 inline=180px rect=180
  1d role=satellite attr=180 inline=180px rect=180
```

**实例身份**：点击前对 3 个 chart 实例与宿主 div 打内存标记（`A3-c0/A3-c1/A3-c2`、`A3-h0/h1/h2`），点击后回读**标记全部仍在** ⇒ DOM 容器与 klinecharts 实例均未重建。

```console
打点（点击前）：hosts=[A3-h0,A3-h1,A3-h2] charts=[A3-c0,A3-c1,A3-c2]
点击后实例   ：[{hostId:k_line_chart_1, acceptMark:A3-c0, indicators:[MA]},
                {hostId:k_line_chart_2, acceptMark:A3-c1, indicators:[MA]},
                {hostId:k_line_chart_3, acceptMark:A3-c2, indicators:[MA]}]
```

**像素级佐证**（`A9_pixel_evidence.txt`）
- 基准 pane VOL 带（238–337px）ink 占比 `0.2165 → 0.0513`（该带已被放大的 candle 图占据，不再是成交量柱）。
- 卫星 1h ink `0.1533 → 0.0195`；卫星 1d `0.2365 → 0.0192`（指标区基本空白）。
- 基准 pane 截图 A3 vs A2 全图差异像素占比 `0.1485`（其中 VOL 带差异 `0.2599`）。

截图：`A3_vol_off_full.png`、`A3_vol_off_base_pane.png`、`A3_vol_off_satellite_1h.png`、`A3_vol_off_satellite_1d.png`。

---

## A4 再点开 ⇒ VOL 恢复；多周期栈 pane 高度逐值一致 — **PASS**

证据：`A4_vol_on_again_layout.txt`、`A4_vol_on_again_full.png`、`A4_vol_on_again_base_pane.png`、`A4_vol_on_again_satellite_1h.png`、`A4_vol_on_again_satellite_1d.png`

**多周期栈 `[data-mp-pane]` inline 高度 逐值对比**

```console
  基线（A2）：5m=364px,1h=180px,1d=180px
  再开（A4）：5m=364px,1h=180px,1d=180px      ⇒ 逐值一致（PASS）

  data-mp-pane-height 声明属性：基线 5m=364,1h=180,1d=180  ⇒  再开 5m=364,1h=180,1d=180（逐值一致）
  pane 顺序 childIndex       ：基线 5m@0,1h@2,1d@4        ⇒  再开 5m@0,1h@2,1d@4（一致）
  栈级分隔条 key             ：基线 5m|1h,1h|1d            ⇒  再开 5m|1h,1h|1d（一致）
  卫星集合                   ：基线 [1h,1d]                 ⇒  再开 [1h,1d]（一致）
```

**单图内 candle pane 与 VOL pane 的像素高度变化（引擎重新分配空间，如实报告，非缺陷）**

```console
  实例 k_line_chart_1
  VOL 开（A2 基线）: panes = ["237px","100px"]   ← [candle, VOL]
  VOL 关（A3）     : panes = ["338px"]           ← 原 VOL 的 100px（+1px separator）归还 candle：237 → 338
  VOL 再开（A4）   : panes = ["237px","100px"]   ← 完全回到基线值
```

**各实例 pane 数 / separator 数（A2 / A3 / A4）**

```console
  k_line_chart_1: A2 paneCount=2 sep=1 | A3 paneCount=1 sep=0 | A4 paneCount=2 sep=1
  k_line_chart_2: A2 paneCount=2 sep=1 | A3 paneCount=1 sep=0 | A4 paneCount=2 sep=1
  k_line_chart_3: A2 paneCount=2 sep=1 | A3 paneCount=1 sep=0 | A4 paneCount=2 sep=1
```

**「0 高 / 重叠 / 残留分隔条 / pane 数异常」检查（A4 态原始观测）**

```console
  基准 pane 与卫星中 rect<=0 的元素：[]
  卫星 pane 内联高度：["0px","135px"] / ["0px","135px"]
        ← "0px" 是卫星 candle pane 的**设计态**（state:'minimize' + minHeight:0，02-spec §3.4 唯一可行手段），非异常
  栈级分隔条：[{"key":"5m|1h","sepHeightAttr":"0","rectHeight":0,"rectTop":440},
               {"key":"1h|1d","sepHeightAttr":"0","rectHeight":0,"rectTop":620}]
        ← 净高 0 的绝对定位命中带（不侵占 pane 空间），非「残留分隔条」
  klinecharts separator 元素：{k_line_chart_1:{sepCount:1,seps:["1px"]},
                               k_line_chart_2:{sepCount:1,seps:["0px"]},
                               k_line_chart_3:{sepCount:1,seps:["0px"]}}
        ← 与 A2 基线完全相同，无新增/残留
```

**VOL 图例恢复**

```console
{"k_line_chart_1|pane#2|100px":{"legendLine":["VOL(5,10,20)"],"label":["VOLUME: "]},
 "k_line_chart_2|pane#2|135px":{"legendLine":["VOL(5,10,20)"],"label":["VOLUME: "]},
 "k_line_chart_3|pane#2|135px":{"legendLine":["VOL(5,10,20)"],"label":["VOLUME: "]}}
```

**像素级最强佐证**（`A9_pixel_evidence.txt`）

```console
  A4 vs A2 基准 pane 全图差异像素占比 = 0.0000   （逐像素一致）
  A4 vs A2 卫星 1h 差异占比        = 0.0000
  A4 vs A2 卫星 1d 差异占比        = 0.0000
  整页 md5：A1 = A2 = A4 = c88b0e7f480ab2bbd9a077fb24578f1f ；A3 = bfcbb352a7148025ff2cc42c9f0e0aad
```

⇒ 关掉再打开 VOL 后，界面**逐像素**回到基线（含多周期栈、卫星、pane 分隔、图例）。

截图：`A4_vol_on_again_full.png`、`A4_vol_on_again_base_pane.png`、`A4_vol_on_again_satellite_1h.png`、`A4_vol_on_again_satellite_1d.png`。

---

## A5 沙箱变异反证：VOL 判定恒 true ⇒ 测试必须变红 — **PASS**

证据：`A5_sandbox.txt`、`A5_sandbox_mutation.diff`、`A5_sandbox_baseline_green.txt`、`A5_sandbox_mutant_red.txt`

**沙箱路径**（**全程未碰用户工作区**）

```console
副本根目录 : /tmp/vol286_sandbox/web
构建方式   : rsync -a --exclude node_modules --exclude dist --exclude e2e/artifacts \
             /home/eestock/workspace/git/eestock/eestock-rs/web/ /tmp/vol286_sandbox/web/
node_modules: 符号链接 → /home/eestock/workspace/git/eestock/eestock-rs/web/node_modules
未变异备份 : /tmp/vol286_sandbox/KlineChart.orig.tsx
```

**变异 diff**（等价变异：把 VOL 判定改成恒 true）

```diff
--- /tmp/vol286_sandbox/KlineChart.orig.tsx	2026-09-15 22:35:42.282425520 +0800
+++ src/features/dashboard/KlineChart.tsx	2026-09-15 22:35:58.081359558 +0800
@@ -160,7 +160,7 @@
   applied: AppliedIndicators,
 ) {
   for (const def of INDICATOR_DEFS) {
-    const enabled = indicators[def.key];
+    const enabled = def.key === 'vol' ? true : indicators[def.key]; // MUTATION(286-A5)
     const desired = desiredCalcParams(def, maWindows, dcapParams);
     const prev = applied.get(def.name);
     if (!enabled) {
```

**运行（副本内）**

```console
$ cd /tmp/vol286_sandbox/web && ./node_modules/.bin/vitest run src/features/dashboard/volToggle.test.tsx
```

| 版本 | 结果 | exit |
|---|---|---|
| 变异前（副本原样） | `Test Files 1 passed (1)` / `Tests 14 passed (14)` | `0` |
| 变异后（VOL 恒 true） | `Test Files 1 failed (1)` / **`Tests 6 failed \| 8 passed (14)`** | `1` |

**变红证据（失败用例 6 条，原文截取）**

```console
FAIL  … > R3 图表生效：indicators.vol=false ⇒ 不创建 VOL；true ⇒ 有且仅有一个 VOL > R3-1 初始即 vol:false ⇒ 无 VOL 指标、无残留 VOL 副图 pane，且其它指标不受影响
FAIL  … > R3 … > R3-2 true ⇒ false（会话内关掉）⇒ VOL 副图消失；MA/MACD 不被动到
FAIL  … > R4 vol 翻转不得重建其它 pane、不得重置用户拖拽过的既有高度 > R4-1 true→false→true：非 VOL pane 的 id/顺序不变、拖拽高度保持、无其它指标 churn
FAIL  … > R5 卫星继承：indicators.vol=false ⇒ 卫星同样无 VOL > R5-1 MultiPeriodSatellite（indicators.vol=false）⇒ 卫星不创建 VOL，MA 仍在
FAIL  … > R5 … > R5-2 MultiPeriodChartStack 透传 vol=false ⇒ 卫星同样不创建 VOL
FAIL  … > R7（附加）页面级：工具栏 VOL 开关驱动主图，且不落服务端配置（会话态） > R7-1 点击 VOL ⇒ 主图 VOL 副图消失；不调用任何配置写接口

AssertionError: 关掉 VOL ⇒ 主图不再有 VOL 副图: expected 1 to be +0 // Object.is equality
AssertionError: 栈透传 vol=false ⇒ 卫星不得创建 VOL: expected 1 to be +0 // Object.is equality
```

**工作区未受影响（反证）**

```console
$ sed -n '163p' /home/eestock/workspace/git/eestock/eestock-rs/web/src/features/dashboard/KlineChart.tsx
    const enabled = indicators[def.key];
md5 = 497791f76b53609c878753ff2c725b54   mtime = 2026-09-15 22:18:33.282161643 +0800（早于验收开始 22:29）
```

---

## A6 零配置写入 + console/network — **PASS**（附 §1 外部操作说明）

证据：`A6_config_start.txt`、`A6_config_end.txt`、`A6_zero_write.txt`、`A6_config_acceptance_begin_222942.txt`、`A0_env.txt`

**验收窗口首尾两次只读 GET（逐字段对比）**

```console
开始（22:34:52+0800 / 14:34:52Z）
  GET /api/config/multi_period ⇒ {"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}  HTTP 200
  GET /api/config/kline        ⇒ {"viewport_bars":120}    HTTP 200
  GET /api/config/ma           ⇒ {"windows":[5,10,20]}    HTTP 200

结束（22:35:23+0800 / 14:35:23Z）
  GET /api/config/multi_period ⇒ {"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}  HTTP 200
  GET /api/config/kline        ⇒ {"viewport_bars":120}    HTTP 200
  GET /api/config/ma           ⇒ {"windows":[5,10,20]}    HTTP 200
```

⇒ **两次逐字段相同（PASS：验收过程本身零写入）**。
补充：整个脚本会话语（含 3 次 VOL 点击、分时/宫格往返）内**所有** `/api/` 请求方法集合 = `["GET"]`（原文见下），
附加脚本 A8 另证「非 GET 请求数 = 0」。

**`app_config` 交叉核对（只读 SELECT）**

```console
key          | updated_at                    | value
dcap         | 2026-09-13 15:27:38.121703+00 | {"m": 3, "n_l": 66, "n_m": 36, "n_s": 8, …}
multi_period | 2026-09-15 14:30:35.055312+00 | {"enabled": true, "heights": {"1d": 180, "1h": 180, "5m": 231}, "periods": ["5m", "1h", "1d"], "indicators": ["dcap"]}
```

- 部署窗口：进程启动 `Tue Sep 15 22:27:42 2026 +0800`；dist mtime `22:27:23 +0800`。
- `multi_period.updated_at` = **`22:30:35 +0800`（晚于部署窗口）** ⇒ 与任务「早于部署窗口」的字面预期不符，
  如实标注为 **「外部（用户）同时操作」**（§1.2），**不据此判 FAIL**。
- 该行在验收窗口内**未被再写入**：窗口首尾复读的配置逐字段相同，且 DB 时间戳仍是 `14:30:35.055312+00`。

**失败请求 / 页面异常（原文）**

```console
  pageerror    ：[]      （0 条）
  requestfailed：[]      （0 条）
  console error：0 条
  console warning：8 条，全部为同一条多周期同步告警，原文如下（截一条，完整 8 条见 A6_zero_write.txt）：
[warning] [multi-period] ChartSyncGroup 未建立（周期组合不可用，禁止静默虚假对齐）
          Error: 多周期同步组合不可用：基准 5m ↔ 卫星 1h 恒退化/无重叠（禁止静默虚假对齐）
    at new UN (http://127.0.0.1:8081/assets/index-dH4SuwMy.js:72:244496)
    at Object.register (…/index-dH4SuwMy.js:72:254966) …
```

> 仅陈述：该 warning 出现在多周期实例注册（挂载）路径，与 VOL 开关无关；本次验收**未**观察到 console error。

**本会话页面内 `/api/` 请求（方法 + 状态，去重后原文）**

```console
  GET 200 http://127.0.0.1:8081/api/config/multi_period
  GET 200 http://127.0.0.1:8081/api/config/dcap
  GET 200 http://127.0.0.1:8081/api/config/kline
  GET 200 http://127.0.0.1:8081/api/config/ma
  GET 200 http://127.0.0.1:8081/api/sources/health
  GET 200 http://127.0.0.1:8081/api/symbols
  GET 200 http://127.0.0.1:8081/api/kline?code=518880&period=1d&limit=120
  GET 200 http://127.0.0.1:8081/api/kline?code=518880&period=1h&limit=120
  GET 200 http://127.0.0.1:8081/api/kline?code=518880&period=5m&limit=120
  GET 200 http://127.0.0.1:8081/api/kline?code=518880&period=1m&limit=500
  GET 200 http://127.0.0.1:8081/api/kline?code=513310&period=15m&limit=120
  GET 200 http://127.0.0.1:8081/api/kline?code=159776&period=15m&limit=120
  GET 200 http://127.0.0.1:8081/api/kline?code=161226&period=15m&limit=120
  GET 200 http://127.0.0.1:8081/api/kline?code=518880&period=15m&limit=120
```

（后 4 条 15m 请求来自 A7b 宫格 2×2 的四个 `GridCell`；`1m` 请求来自 A7a 分时页签——均为 GET、均 200。）

---

## A7 纯前端回归（不写配置） — **PASS**

证据：`A7_frontend_regression.txt`、`A7a_timeshare.png`、`A7a_back_to_kline.png`、`A7b_grid2x2.png`、`A7b_back_to_single.png`

**A7a 分时 tab 往返（先把 VOL 人工置为关态，检验会话态是否保持）**

```console
  切走前 VOL aria-pressed = false
  分时态 kline 实例数     = 0（K线图整棵子树卸载）
  切回 K线后 aria-pressed = false      ⇒ PASS（状态保持）
```

**A7b 宫格 2×2 往返**

```console
  宫格态：kline 实例数=4  [data-mp-stack] 存在=false  「多周期」按钮存在=false  VOL 按钮存在=true
  切回单图：卫星=["1h","1d"]  VOL aria-pressed=false
  切回单图 [data-mp-pane] inline：5m=364px,1h=180px,1d=180px
  ⇒ PASS（无报错、无残留；多周期栈按基线重建）
```

两段往返期间 console 无 error、`requestfailed` 为空（见 §A6 汇总）。

截图：`A7a_timeshare.png`、`A7a_back_to_kline.png`、`A7b_grid2x2.png`、`A7b_back_to_single.png`。

---

## A8（附加）会话态：默认开 · 点击关 · 刷新回默认开 · 零非 GET — **PASS**

证据：`A8_session_state.txt`、`A8_vol_off_before_reload.png`、`A8_after_reload_default_on.png`

```console
  首次加载后 VOL aria-pressed = true    （默认开）
  点击 VOL 后 aria-pressed    = false   （点击关）
  刷新页面后 aria-pressed     = true    （刷新回默认开 ⇒ 不落服务端配置）
  非 GET 的 /api/ 请求        = （无）  （0 条）
  GET /api/config/multi_period 脚本前后逐字段相同：{"enabled":true,"periods":["5m","1h","1d"],…}
```

---

## A9（附加）像素级渲染证据 — **PASS**

证据：`A9_pixel_evidence.txt`（脚本 `286_pixel_evidence.py`）

```console
基准 pane 截图（1523x364；A2 布局：candle 0-236 / separator 237 / VOL 238-337 / x轴 338-363）
  candle(0-236)  : ink A2=0.1344  A3=0.1238  A4=0.1344
  sep(237)       : ink A2=0.0000  A3=0.0342  A4=0.0000
  VOL(238-337)   : ink A2=0.2165  A3=0.0513  A4=0.2165
  xAxis(338-363) : ink A2=0.0583  A3=0.0586  A4=0.0583
  A3 vs A2 全图差异像素占比 = 0.1485（VOL 带内 0.2599）
  A4 vs A2 全图差异像素占比 = 0.0000（逐像素一致）

卫星（1523x180）
  1h: ink A2=0.1533 A3=0.0195 A4=0.1533 ; A3vsA2=0.1556 ; A4vsA2=0.0000
  1d: ink A2=0.2365 A3=0.0192 A4=0.2365 ; A3vsA2=0.2382 ; A4vsA2=0.0000

整页 md5：A1=c88b0e7f… A2=c88b0e7f… A4=c88b0e7f…（三者一致）；A3=bfcbb352a7148025ff2cc42c9f0e0aad
```

---

## 8. 无法判定 / 限制项（明确缺什么证据）

| # | 项 | 状态 | 缺什么 |
|---|---|---|---|
| 8-1 | **人工肉眼判读截图** | **本次无法执行** | 本会话的模型不具备图像读取能力（`read` 图片返回 “Current model does not support images”）。已用**客观替代证据**补齐：canvas `fillText` 全量图例捕获、klinecharts DOM pane/separator 计数、`[data-mp-pane]` inline 高度、以及 A9 的像素统计（ink 占比 / 逐像素差异 / md5）。截图文件已按规定命名落盘，可供人工复核。 |
| 8-2 | **前提中的卫星周期 15m/1h** | **与实测不符（外部因素）** | 实测基线为 `1h/1d`。缺的是「用户不再改动配置」的稳定窗口：任务前提的 `5m/15m/1h` 我在 22:29:42 读到过（`A6_config_acceptance_begin_222942.txt`），但 22:30:35 被外部改写为 `5m/1h/1d`（DB `updated_at`）。若需要「在 15m/1h 组合下复跑一次」的证据，需要在配置稳定后由父级发起一次重跑。 |
| 8-3 | **A6 「updated_at 早于部署窗口」字面预期** | **不成立（外部因素）** | 实测 `updated_at = 22:30:35 +0800` > 部署 `22:27:42 +0800`。缺的是「用户未在部署后使用选择器」的证据；现有 DB 时间戳恰好证明存在一次外部写入。不据此判 FAIL（任务明示）。 |
| 8-4 | **服务端侧请求日志** | **不可得** | `logs/app_dev_8081_redeploy_20260915_222740.log` 仅记录启动信息（无 access log）。因此「零写入」由**浏览器侧网络记录 + 配置首尾复读 + DB `updated_at` 未再变化**三重证据支撑，而非服务端日志。 |
| 8-5 | **「切换 VOL 只增删 VOL 自身，不重建/重置其它 pane」的拖拽场景** | **未覆盖（本轮非破坏性只读约束下未做）** | 本轮未拖拽分隔条（拖拽会触发 `PUT /api/config/multi_period`，违反「不许写配置」禁令）。已用 A3 的实例内存打点（chart 实例与宿主 div 标记在切换后保留）+ A4 的 `[data-mp-pane]` 高度逐值一致 + 逐像素一致作为替代证据；拖拽后高度保持的判据由 A5 沙箱内的 `R4-1` 用例覆盖（变异前 14 passed 含该用例）。 |

---

## 9. 证据清单（`tester/evidence/286_vol_acceptance/`）

| 文件 | 对应项 |
|---|---|
| `00_INDEX.txt` | 目录索引 |
| `A0_env.txt` | 环境：8081 PID/cmdline/启动时间、`index.html`、dist mtime、源码 md5+mtime、写过的路径 |
| `A1_toolbar_vol_switch.txt` / `A1_toolbar_vol_default_on.png` / `A1_fullpage_default_on.png` | A1 |
| `A2_baseline.txt` / `A2_baseline_full.png` / `A2_baseline_base_pane.png` / `A2_baseline_satellite_1h.png` / `A2_baseline_satellite_1d.png` | A2 |
| `A3_vol_off.txt` / `A3_vol_off_full.png` / `A3_vol_off_base_pane.png` / `A3_vol_off_satellite_1h.png` / `A3_vol_off_satellite_1d.png` | A3 |
| `A4_vol_on_again_layout.txt` / `A4_vol_on_again_full.png` / `A4_vol_on_again_base_pane.png` / `A4_vol_on_again_satellite_1h.png` / `A4_vol_on_again_satellite_1d.png` | A4 |
| `A5_sandbox.txt` / `A5_sandbox_mutation.diff` / `A5_sandbox_baseline_green.txt` / `A5_sandbox_mutant_red.txt` | A5 |
| `A6_config_start.txt` / `A6_config_end.txt` / `A6_config_acceptance_begin_222942.txt` / `A6_zero_write.txt` | A6 |
| `A7_frontend_regression.txt` / `A7a_timeshare.png` / `A7a_back_to_kline.png` / `A7b_grid2x2.png` / `A7b_back_to_single.png` | A7 |
| `A8_session_state.txt` / `A8_vol_off_before_reload.png` / `A8_after_reload_default_on.png` | A8（附加） |
| `A9_pixel_evidence.txt` | A9（附加） |
| `286_acceptance.mjs` / `286_supplementary_session_state.mjs` / `286_pixel_evidence.py` / `286_results.json` / `286_run.log` | 验收脚本与结构化结果 |

---

## 10. 本报告未做之事（边界声明）

- **未**修改任何实现代码/接口/架构；**未**改工作区任何文件（除本报告与 `tester/evidence/286_vol_acceptance/` 下的证据）。
- **未**对失败做原因分析、**未**尝试修复（本轮无失败需修复）。
- **未**对 `/api/*` 发出 PUT/POST/PATCH/DELETE；**未**点击「周期选择」确定按钮；**未**做 `git add` / `git commit`。
- **未**在用户工作区做变异；变异只发生在 `/tmp/vol286_sandbox/web`。
