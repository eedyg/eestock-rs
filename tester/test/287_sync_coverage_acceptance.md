# 287 — 「左右移动 K 线图时多周期指标 pane 跟着一起移动」独立验收报告

> **本报告位置**：`tester/test/287_sync_coverage_acceptance.md`
> 证据目录：`tester/evidence/287_sync_acceptance/`（索引 `00_INDEX.txt`；验收脚本 `287_acceptance.mjs`、`287_B6_mutation_sandbox.sh`）
> 角色：Tester（**只执行与观察**；未修改任何实现/配置/生成物；未 git add/commit；**未做失败原因分析**）
> 被验对象：线上 `http://127.0.0.1:8081/`（title「eestock · 行情看板」，bundle `/assets/index-BGPCHS0j.js`）
> 仓库：`/home/eestock/workspace/git/eestock/eestock-rs` @ `8828d4621d9536687a380462f567590d5fc3ea3b`（`master`）
> 采集时间：2026-09-15 23:12–23:13 CST（**休市**，无新 bar 干扰；最后一根 5m bar = 09-15 15:00）
> 运行环境：node v22.22.2 · @playwright/test 1.62.1（chromium）· 视口 2000×1100
>   （多周期栈 x=414、宽 1522 ⇒ 视口 ≥1936 宽才无裁剪，故取 2000×1100）

## 0. 禁令遵守（逐条自证）

| 禁令 | 执行情况 |
|---|---|
| 不许对 `/api/*` 发 PUT/POST/PATCH/DELETE | 脚本内无任何写请求；页面会话内 `/api/` 方法集合 = `["GET"]`（B5 证据） |
| 不许拖拽 `[data-mp-separator]` | 脚本内无 `data-mp-separator` 选择器、无 separator 上的任何鼠标事件 |
| 只允许在主图绘图区做鼠标拖动/滚轮 | 手势点固定 = 主图 candle pane 绘图区中心（几何见 `A0_geometry.json`：`left=448 width=1552 top=76 bottom=613`，手势点 `(1224,345)`） |
| 不许改工作区文件 | 验收前后 `git status` 相同（21 项**既有已暂存**变更，非本工作产生）；`git diff --name-only` = 0；`chartSyncGroup.ts` sha256 未变；`web/dist` mtime 未变（2026-09-15 23:02:05 +0800）。变异实验全部在 `/tmp/287_sandbox` |
| 不许 git add/commit | 未执行 |
| 不许用图表导出截图 | 一律 `page.screenshot()` / `locator.screenshot()` |

**被验产物确认为当前源码**（强证据）：在 `/tmp/287_sandbox` 用工作区源码 `VITE_API_MOCK=0 vite build`
重建 ⇒ `dist/assets/index-BGPCHS0j.js`（1,217,684B）md5 = `f493b2be9ca2dfa1acbf07d65366d016`
**与线上取回的 bundle md5 完全相同**（`B6_build_from_current_source.txt`、`A0_env.txt`）。

---

## 1. 结论速览

| 项 | 内容 | 判定 |
|---|---|---|
| **B1** | 主图拖动/缩放后**可同步卫星（1h）的可见时间窗随主图变化** | **PASS（随动）** |
| B1-附 | 主图与卫星的**可见时间跨度一致性** | **不一致（偏差项，页面以可见「对齐受限」角标诚实标注）** |
| B1-附 | 被排除卫星（1d）是否随动 | **未随动**（6/6 观测点逐字段相同；属预期） |
| **B2** | console 无「ChartSyncGroup 未建立」告警 | **PASS**（命中 0 条；console 全量为 0 条） |
| **B3** | 被排除卫星（1d）有可见角标（DOM 属性 + 文案 + title），且不随主图变化 | **PASS** |
| **B4** | 多周期 pane inline 高度/顺序不变量 + VOL 可关可开 | **PASS** |
| **B5** | 零配置写入 + 仅 GET + console error/pageerror/requestfailed | **PASS**（全部 0，配置两次逐字段相同） |
| **B6** | 沙箱变异反证（守门恢复「只认实测表」⇒ 必须变红） | **PASS**（实测变红：`6 failed \| 11 passed`，exit 1） |

---

## 2. B1 核心 —— 「随动 / 未随动」判定（客观读数）

### 2.1 观测点与手势（全部在主图 candle 绘图区内）

| 观测点 | 手势 | 说明 |
|---|---|---|
| `T00_baseline` | 无 | 加载后稳定基线（脚本先 sleep 4s 让初始化对齐/抑制窗过去） |
| `T01_pan_right_250px` | mouse down → 右移 +250px（20 步）→ up | 主图平移到更早时间 |
| `T02_pan_left_450px` | mouse down → 左移 −450px（20 步）→ up | 主图平移到更近时间 |
| `T03_wheel_zoom_in` | 滚轮 `deltaY=-120` ×3 | 主图放大 |
| `T04_wheel_zoom_out` | 滚轮 `deltaY=+120` ×6 | 主图缩小 |
| `T05_wheel_zoom_out_more` | 滚轮 `deltaY=+120` ×10 | 主图继续缩小 |

窗口读数口径 = `chart.getVisibleRange()`（`realFrom/realTo`）映射到 `chart.getDataList()` 的 `timestamp`
（**与实现内部 `readWindow` 同口径**）；`bar` = `getBarSpace().bar`；`off` = `getOffsetRightDistance()`。
时间均为 Asia/Shanghai（CST）。原始表：`B1_windows.txt` / `B1_windows.json`。

### 2.2 逐观测点窗口表

| 观测点 | 主图 5m（`k_line_chart_1`） | 卫星 1h（`k_line_chart_2`） | 卫星 1d（`k_line_chart_3`） |
|---|---|---|---|
| T00 | bar=13，09-11 13:45 → 09-15 15:00，span=**5835 min** | bar=52，09-09 09:00 → 09-15 15:00，span=**9000 min** | bar=13，off=80，04-07 00:00 → 09-14 00:00，span=**230400 min** |
| T01 | bar=13，09-11 10:45 → 09-15 13:30，span=**5925 min** | bar=52，09-08 13:00 → 09-15 13:00，span=**10080 min** | **同 T00（逐字段）** |
| T02 | bar=13，09-11 13:45 → 09-15 15:00，span=**5835 min** | bar=52，09-09 09:00 → 09-15 15:00，span=**9000 min** | **同 T00（逐字段）** |
| T03 | bar=**17.303**，09-11 15:00 → 09-15 14:00，span=**5700 min** | bar=**34**，09-04 13:00 → 09-15 15:00，span=**15960 min** | **同 T00（逐字段）** |
| T04 | bar=**9.196**，09-10 13:55 → 09-15 15:00，span=**7265 min** | bar=**37**，09-07 10:00 → 09-15 15:00，span=**11820 min** | **同 T00（逐字段）** |
| T05 | bar=**3.206**，09-02 13:45 → 09-15 15:00，span=**18795 min** | bar=**13**，08-19 14:00 → 09-15 15:00，span=**38940 min** | **同 T00（逐字段）** |

- `resizeStable = true`（6/6）：为取刻度文本而做的强制重绘（`chart.resize()`）**前后窗口逐字段相同**
  ⇒ 取证动作本身不扰动任何实例的可见窗口。
- 「相对上一观测点是否变化」：`k_line_chart_1` = true×5、`k_line_chart_2` = true×5、`k_line_chart_3` = **false×5**。

### 2.3 结论：随动 / 未随动（逐卫星）

| 卫星 | 结论 | 客观依据 |
|---|---|---|
| **1h（可同步）** | **随动** | ① 5 次手势后窗口**每次**都变化（T01..T05 `changedVsPrev=true`）；② 右缘（`realTo` 时间戳）相对主图的残差 = **0 / −30 / 0 / +60 / 0 / 0 min**，全部 ≤ 卫星自身 1 根 bar（60 min）；③ `barSpace` 随主图缩放联动：`52 → 52 → 52 → 34 → 37 → 13`（主图 `13 → 13 → 13 → 17.303 → 9.196 → 3.206`）；④ **可逆复现**：T02 时主图窗口回到与 T00 完全相同（09-11 13:45→09-15 15:00）⇒ 1h 也**精确回到** T00 状态（bar=52，09-09 09:00→09-15 15:00，span=9000） |
| **1d（被排除）** | **未随动**（预期） | 6/6 观测点 `bar=13`、`off=80`、`realFrom=9`、`realTo=127`、`fromTs=1775491200000`、`toTs=1789315200000`、`spanMin=230400`、`realBars=119` **逐字段相同**；即便主图跨度从 5835 min 变为 18795 min（T05，≈13 天）也未发生任何变化 |

### 2.4 附：主图与卫星的「可见时间跨度一致性」（偏差项，事实记录）

| 观测点 | 主图 span | 1h span | 差值（1h − 主图） | 主图右缘 − 1h 右缘 | 页面「对齐受限」角标 `data-mp-span-diff-min` |
|---|---|---|---|---|---|
| T00 | 5835 | 9000 | **+3165 min** | 0 | **3220** |
| T01 | 5925 | 10080 | **+4155 min** | 30 min | **4210** |
| T02 | 5835 | 9000 | **+3165 min** | 0 | **3220** |
| T03 | 5700 | 15960 | **+10260 min** | −60 min | **10315** |
| T04 | 7265 | 11820 | **+4555 min** | 0 | **4610** |
| T05 | 18795 | 38940 | **+20145 min** | 0 | **20200** |

- ⇒ **跨度一致性不成立**（差值 3165–20145 min，从未为 0）；但**不是静默**：卫星 1h 上始终存在
  可见的「对齐受限」角标（`[data-mp-sync-degraded="1h"]`，`data-mp-span-diff-min` 与上表同量级，
  `title` 给出原因与处置建议）——本项为**事实记录**，是否属于本验收口径的可接受偏差由父级裁决。
- 1d 卫星**不存在**「对齐受限」角标（`data-mp-sync-degraded` 为 null），只有「未同步」排除角标。

### 2.5 x 轴刻度文本集合（canvas `fillText` 捕获）对比

口径：每实例取「画布高度 ≤40px 且含时间型文本」的画布（即 x 轴刻度画布，实测高 26px）；
`frame` = 一次 `chart.resize()` 全帧重绘后捕获；`gesture` = 本次手势逐帧捕获的并集。原始表：`B1_axis_ticks.txt`。
（**已知口径限制**：主图窗口不足一天时 klinecharts 只画 `HH:MM`（不含日期），短距离平移可能得到相同集合；
跨日/日线才带日期 ⇒ 同时以 2.2 的时间戳与 2.6 的像素 md5 作为权威证据。）

**主图 `k_line_chart_1`（每次手势集合都变）**

| 观测点 | frame 刻度集合 | 与上一步差异 / 同标签横向位移 |
|---|---|---|
| T00 | `["10:20","10:30","13:05","13:15","14:25","14:35","14:45"]` | — |
| T01 | `["09:30","10:40","10:50","11:00","13:25","13:35","13:45","14:55"]` | 7 个旧标签全部 removed，8 个新标签 added |
| T02 | `["09:30","10:40","10:50","13:25","13:35","13:45","14:45","14:55"]` | removed `["11:00"]` added `["14:45"]`；Δx = **−250px**（7 个共同标签） |
| T03 | `["09:40","09:50","10:40","10:50","13:05","13:15","14:15"]` | 集合变化；Δx = +86px / −121px |
| T04 | `["09:50","10:20","10:50","13:05","13:35","14:05","14:35","14:55"]` | 集合变化 |
| T05 | `["09:30","10:20","11:10","13:25","14:15","15:05"]` | 集合变化 |

**卫星 1h `k_line_chart_2`（随动）**

| 观测点 | frame 刻度集合（8 个） | 与上一步差异 / 同标签横向位移 |
|---|---|---|
| T00 | `["09-09 11:00","09-10 09:00","09-10 14:00","09-11 11:00","09-14 09:00","09-14 14:00","09-15 11:00","09-15 16:00"]` | — |
| T01 | `["09-08 14:00","09-09 11:00","09-10 09:00","09-10 14:00","09-11 11:00","09-14 09:00","09-14 14:00","09-15 11:00"]` | removed `["09-15 16:00"]` added `["09-08 14:00"]`；**Δx = +208px（7 个共同标签）** |
| T02 | 与 T00 **完全相同** | removed `["09-08 14:00"]` added `["09-15 16:00"]`；**Δx = −208px（7 个）** |
| T03 | `["09-07 09:00","09-08 09:00","09-09 09:00","09-10 09:00","09-11 09:00","09-14 09:00","09-15 09:00"]` | 集合变化；Δx = +457px / +241px |
| T04 | `["09-08 09:00","09-09 09:00","09-10 09:00","09-11 09:00","09-14 09:00","09-15 09:00","09-15 16:00"]` | 集合变化；Δx = −50…−140px |
| T05 | `["08-21 14:00","08-26 11:00","08-31 09:00","09-02 14:00","09-07 11:00","09-10 09:00","09-14 14:00"]` | 集合变化（出现 8 月日期）；Δx = +564px |

**卫星 1d `k_line_chart_3`（未随动）**

| 观测点 | frame 刻度集合 | 与上一步差异 | 同标签横向位移 |
|---|---|---|---|
| T00..T05（6/6） | `["2026-04-16","2026-05-13","2026-06-04","2026-06-29","2026-07-21","2026-08-12","2026-09-03"]` | **集合完全相同** | **全部 Δx = 0px**（7 个标签：54/262/469/677/885/1094/1302 → 原样不变） |

- 手势期间的 `gesture` 捕获：1d 的 x 轴画布 **0 条** fillText（即手势期间完全没有重绘），
  而主图与 1h 的 x 轴画布在 T01–T05 期间分别捕获 9–23 条 / 12–29 条 fillText ⇒ 与「未随动」一致。

### 2.6 像素级 md5（补充证据，均取 pane 截图）

| pane | T00 | T01 | T02 | T03 | T04 | T05 | 不同 md5 数 |
|---|---|---|---|---|---|---|---|
| 主图 5m | `9a921d5b…` | `655e7cae…` | `5eee9a0c…` | `2e80ff39…` | `de90f061…` | `4c721be9…` | **6/6 互不相同** |
| 卫星 1h | `37185b9c…` | `4bf8b2e8…` | `37185b9c…`（=T00） | `6ad799ec…` | `8671a0b0…` | `923ece4e…` | 5 个不同（T00=T02，与窗口读数一致） |
| 卫星 1d | `60d3409d…` | `60d3409d…` | `60d3409d…` | `60d3409d…` | `60d3409d…` | `60d3409d…` | **1 个（6/6 完全相同）** |

⇒ 被排除的 1d pane 在 5 次主图手势（含 5× 缩小）后**像素级完全相同**。

### 2.7 B1 判定

- **「每个可同步卫星的可见时间窗必须随主图变化」= PASS（随动）**：唯一的可同步卫星 1h 在 5/5 次手势后窗口均变化，
  右缘残差 ≤ 1 根卫星 bar，且随主图缩放联动 barSpace，并可在主图回到同一窗口时精确复现同一卫星窗口。
- **「未随动」= 仅被排除卫星 1d**（预期行为，见 B3）。
- **偏差项**：1h 与主图的**跨度**始终不一致（3165–20145 min），页面以可见「对齐受限」角标 + 跨度差量化 + 可行动 title
  诚实标注（非静默）。本项由父级裁决是否接受。

---

## 3. B2 —— console 不得出现「ChartSyncGroup 未建立」

- **命中条数 = 0（PASS）**。
- console 全量 = **0 条消息**（error/warning/info 均为 0）。原始：`B2_console.txt`。
- 采集范围：从 `page.goto` 之前注册监听起，覆盖加载 + 5 次手势 + VOL 往返全程。

---

## 4. B3 —— 被排除卫星（运行时配置的 1d）可见角标 + 不随动

运行时配置（验收开始时 GET，逐字段）：`{"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}`
⇒ 基准 `5m`；卫星 `1h`（同锚点合成可用 ⇒ 参与同步）、`1d`（无公共锚点 ⇒ 排除并标注）。

**DOM 原文（末次观测点 T05，原文照抄；`B3_excluded_badge.txt`）**

```html
<div data-mp-sync-excluded="1d" data-mp-sync-excluded-reason="no-shared-anchor" role="status"
     class="absolute right-1 top-4 z-20 cursor-help rounded border border-acc1/50 bg-panel/95 px-1 text-[9px] text-amber-300 shadow"
     title="未同步：本 pane（周期 1d）与基准周期 5m 的组合不可用（原因：no-shared-anchor）⇒ 不参与跨图同步。处置建议：把该 pane 的周期改为与基准同锚点（如 5m 基准选 15m/1h）或调整基准周期。">
  <span>未同步（1d）</span>
</div>
```

| 项 | 值 |
|---|---|
| `data-mp-sync-excluded` | `1d` |
| `data-mp-sync-excluded-reason` | `no-shared-anchor` |
| `textContent` | `未同步（1d）` |
| `title` | `未同步：本 pane（周期 1d）与基准周期 5m 的组合不可用（原因：no-shared-anchor）⇒ 不参与跨图同步。处置建议：把该 pane 的周期改为与基准同锚点（如 5m 基准选 15m/1h）或调整基准周期。` |
| `role` | `status` |
| 可见性 | `offsetParent !== null` = **true**；`boundingRect = {x:1931, y:937, w:65, h:16}` |
| 非排除卫星 | 1h **不存在** `[data-mp-sync-excluded]`（未残留）；「整组未建立」角标 `[data-mp-sync-group-unestablished]` **不存在**（组已建立） |

**不随动（该卫星可见时间窗不随主图变化 = 预期）**：6/6 观测点窗口逐字段相同（见 §2.3/§2.2）；
x 轴刻度集合 6/6 完全相同且横向位移全为 0px（§2.5）；pane 像素 md5 6/6 相同（§2.6）。
**截图**：`B1_T00_baseline_full.png` + `B1_T00_baseline_sat_1d.png`（基线，含角标）；
`B1_T05_wheel_zoom_out_more_full.png` + `B1_T05_wheel_zoom_out_more_sat_1d.png`（主图 5× 缩小后，角标仍在、窗口不变）。

---

## 5. B4 —— 回归（pane 不变量 + VOL 开关）

**多周期 pane DOM 不变量（8 个观测点：T00–T05 五次手势 + VOL 关 + VOL 再开）**（`B4_dom_invariants_per_step.txt`）

```
panes:        5m: role=base attr=664 inline=664px idx=0 | 1h: role=satellite attr=180 inline=180px idx=2 | 1d: role=satellite attr=180 inline=180px idx=4
separators:   5m|1h@1(h=0) | 1h|1d@3(h=0)
stack:        div[pane=5m|h=664px] -> div[sep=5m|1h] -> div[pane=1h|h=180px] -> div[sep=1h|1d] -> div[pane=1d|h=180px]
sat:          1h: inline=180px rect=180 | 1d: inline=180px rect=180 | order=1h,1d
layout:       {"reason":"fit","total":1024,"shrunk":false,"scrollable":false,"available":1024,"heights":{"5m":664,"1h":180,"1d":180}}
```
⇒ 8/8 观测点与基线**逐字段完全一致**（inline 高度、声明属性 `data-mp-pane-height`、childIndex、分隔条 key/序号、
stack children 顺序、卫星顺序）。**PASS**

**VOL 开关往返（图例原文对比）**（`B4_layout_and_vol.txt`）

| 状态 | `aria-pressed` | 含 `VOL(` 或 `VOLUME:` 的画布 |
|---|---|---|
| 默认（开） | `true` | `k_line_chart_1\|1492x100@top614`、`k_line_chart_2\|1492x135@top759`、`k_line_chart_3\|1507x135@top939`（各 `["VOL(5,10,20)","VOLUME: "]`） |
| 点一次（关） | `false` | **`{}`（0 个画布命中）** |
| 再点一次（开） | `true` | 与默认态**完全相同**（3 个画布命中，内容逐字相同） |

`outerHTML`（默认态）：`<button class="… bg-gradient-to-br from-acc1 to-acc2 text-white …" aria-pressed="true">VOL</button>`
`outerHTML`（关闭态）：`<button class="… border-line text-dim …" aria-pressed="false">VOL</button>`
**截图**：`B4_vol_off_full.png` / `B4_vol_on_again_full.png`。**PASS**

---

## 6. B5 —— 零配置写入 / 仅 GET / 错误计数

| 检查 | 结果 |
|---|---|
| `GET /api/config/multi_period` 开始 vs 结束 | `{"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}` ↔ 完全相同 |
| `GET /api/config/kline` | `{"viewport_bars":120}` ↔ 完全相同 |
| `GET /api/config/ma` | `{"windows":[5,10,20]}` ↔ 完全相同 |
| 逐字段对比 | **两次完全相同（零写入）** |
| 页面会话内 `/api/` 方法集合 | `["GET"]`；非 GET 方法 = `[]`（去重请求清单见 `B5_zero_write_and_errors.txt`，含 `/api/kline?...&before=...` 历史补齐等 11 条去重 GET） |
| console error/warning 计数 | **0**（原文：无） |
| pageerror 计数 | **0** |
| requestfailed 计数 | **0** |

**PASS**。（`/tmp/served_287.js` 为 curl 取回的线上 bundle 副本，仅 GET。）

---

## 7. B6 —— 沙箱变异反证

| 项 | 值 |
|---|---|
| 沙箱路径 | `/tmp/287_sandbox`（`web/` 完整拷贝 + `node_modules` **真实拷贝** 157M ⇒ 缓存写入全部落在 /tmp，工作区零共享写入） |
| 源码一致性 | 变异前 `diff -rq /tmp/287_sandbox/web/src <repo>/web/src` = 无差异；`chartSyncGroup.ts` sha256 = `5fff99f7…`（== 工作区）；`syncCoverage.test.ts` sha256 = `319b16eb…` |
| **基线（未变异）** | `Test Files 1 passed (1)` / `Tests 17 passed (17)`，**exit 0**（`B6_sandbox_baseline_green.txt`） |
| 附带反证（线上=当前源码） | 沙箱 `VITE_API_MOCK=0 vite build` ⇒ `index-BGPCHS0j.js` md5 `f493b2be9ca2dfa1acbf07d65366d016` == 线上（`B6_build_from_current_source.txt`） |
| 变异 diff | 1 行（`B6_mutation.diff`）：删除 `syncExclusionReason` 中 `if (composeDensity(basePeriod, satellitePeriod) !== null) return null;` 放行分支 ⇒ 守门**只认实测表**（回到修复前旧行为） |
| 变异后文件 sha256 | `02b4ee6cf65ca7dd1425dd0a210ef71e2141c4d827df3bebc57922985e07141d` |
| **变异后执行** | `Test Files 1 failed (1)` / `Tests 6 failed \| 11 passed (17)`，**exit 1（变红）** |
| 变红用例（6） | `U1`（合成可用即放行：`expected false to be true`）、`U4`（排除列表 `[ '1h', '1d' ]` ≠ `[ '1d' ]`）、`U6`（可同步卫星必须被写入 barSpace：`expected false to be true`）、`U7`（跟随者 1h 密度读数 `expected undefined to be defined`）、`U9`（onStats 排除列表不符）、`U10`（1h 被误排除 ⇒ 角标集合错误） |
| 崩溃 / core dump | 无（6 例全为 `AssertionError`，无进程崩溃、无 core 文件） |
| 工作区影响 | `chartSyncGroup.ts` sha256 变异前后不变；`web/dist` mtime 未变 |

**PASS（反证成立：变异必红）**。原始证据 `B6_sandbox_mutation_red.txt` / `B6_mutation.diff`。

---

## 8. 无法判定项 / 证据缺口（明确缺什么）

1. **「主图 ↔ 卫星跨度一致」不成立**（1h，差值 3165–20145 min，见 §2.4）。我给出事实数值与页面诚实角标原文；
   该偏差**是否属于本验收口径可接受**需父级裁决（若口径要求跨度严格一致，则 B1 应改判为 FAIL/部分满足）。
2. **本验收不含失败原因分析**（角色禁令）：1h 的 `barSpace` 为何落在 52/34/37/13（而非按密度推导值）**未做归因**，
   也未给出修复建议。
3. **刻度文本口径限制**：主图窗口不足一天时 x 轴标签只有 `HH:MM`（不含日期），短距离平移可能得到相同集合；
   因此结论以 §2.2 时间戳与 §2.6 像素 md5 为主、刻度集合为辅（差异表中已逐条列出实际差异）。
4. **未覆盖**：其他视口尺寸 / 其他浏览器 / 其他运行时多周期配置（如 `1m+5m+15m`、`1d+1w`）下的同类验收；
   本轮只按「运行时读取」的当前配置（5m 基准 + 1h/1d 卫星）判定。
5. **未做源码 ↔ bundle 的语义等价性证明**，只做了「沙箱以当前源码重建 ⇒ 产物字节相同」这一强证据；
   若要更强，需要在隔离环境重放部署流程（超出本轮范围）。
6. 1h 卫星的「对齐受限」角标（`data-mp-sync-degraded="1h"`，预存在的诚实降级机制）在 6/6 观测点均出现，
   本报告仅作事实记录，未纳入任何 PASS/FAIL 判定。

---

## 9. 截图清单（`tester/evidence/287_sync_acceptance/`）

| 文件 | 内容 |
|---|---|
| `B1_T00_baseline_full.png` / `_base_5m.png` / `_sat_1h.png` / `_sat_1d.png` | 基线（含 1d「未同步（1d）」角标、1h「对齐受限」角标） |
| `B1_T01_pan_right_250px_*` | 右拖 +250px 后 |
| `B1_T02_pan_left_450px_*` | 左拖 −450px 后 |
| `B1_T03_wheel_zoom_in_*` | 滚轮放大后 |
| `B1_T04_wheel_zoom_out_*` | 滚轮缩小后 |
| `B1_T05_wheel_zoom_out_more_*` | 滚轮继续缩小后（主图 span 18795 min，1d 仍不变） |
| `B4_vol_off_full.png` / `B4_vol_on_again_full.png` | VOL 关闭 / 恢复 |

（`*` = `full.png` + `base_5m.png` + `sat_1h.png` + `sat_1d.png`，共 24 张）

---

## 10. 工作区完整性（本工作未改动任何文件）

```
git rev-parse HEAD            = 8828d4621d9536687a380462f567590d5fc3ea3b  （未变）
git diff --name-only          = （空：0 个未暂存改动）
git diff --cached --name-only = 21 项既有已暂存变更（实现方先前的暂存，非本工作产生；本工作未 add/commit）
chartSyncGroup.ts sha256      = 5fff99f744bed995fc243d0b70e48e3671ff4323b96e64534e280879ac9bf184（未变）
web/dist/assets/*.js mtime    = 2026-09-15 23:02:05 +0800（未重建）
本工作新增（未跟踪）= tester/evidence/287_sync_acceptance/**、tester/test/287_sync_coverage_acceptance.md
```
