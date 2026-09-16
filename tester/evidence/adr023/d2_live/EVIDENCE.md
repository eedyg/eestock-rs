# ADR-023 D2 上线后真渲染独立验收 — EVIDENCE

- 本文件位置（绝对路径）：`/tmp/adr023-d2-verify-live-20260917-000127/EVIDENCE.md`
- 类型：**验收证据**（只验不改；无失败分析、无修复）
- 被验对象：线上 `http://127.0.0.1:8081/`（只读客户端；bundle `/assets/index-J50SI06a.js`），PID `178558`（`eestock-app`）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs` @ HEAD `3094018f352dae25752340d78b5e108c284aeecc`（工作区含 D2 未提交改动，均先于本轮会话）
- 采集时间：2026-09-17 00:01 → 00:07（+08:00）
- 运行环境：node v22 · @playwright/test chromium（headless）· 视口 2000×1100
- 证据文件：
  - `00_snapshot_t0.txt`（会话前 `app_config` 只读快照 + GET）
  - `10_snapshot_t1.txt`（会话后 `app_config` 只读快照 + GET + HEAD + PID）
  - `11_git_status_after.txt`（`git status --porcelain`，93 项，全部先于本轮）
  - `result.json`（脚本全量原始读数）、`run.log`
  - `shot_00_initial.png` `shot_01_enabled.png` `shot_B1_picker.png` `shot_B2_combo_15m_30m.png` `shot_B2_combo_1m_30m.png` `shot_B3a_30m_1d.png` `shot_B3b_30m_1w_picker.png` `shot_B3c_1h_base_picker.png` `shot_B3d_1h_1d.png` `shot_B4_15m_30m.png` `shot_final.png`
  - 脚本：`acceptance.mjs`

---

## 0. 强制规程（ADR-023 §6.2）：`app_config.multi_period` 前后快照与精确差异

### 快照（只读 `psql`；查询 `select key,value::text,updated_at::text from app_config where key='multi_period'`）

| 时点 | value | updated_at |
|---|---|---|
| **T0 = 会话前（00:01）** | **无该行（键 ABSENT）** | 无 |
| T-mid（00:04:46 UTC 16:04:46，首轮 toggle 后，见下） | `{"enabled": true, "heights": {"1m": 420}, "periods": ["1m"], "indicators": ["dcap"]}` | `2026-09-16 16:04:46.062696+00` |
| **T1 = 会话后（16:06:17 UTC）** | `{"enabled": true, "heights": {"15m": 420, "30m": 180}, "periods": ["15m", "30m"], "indicators": ["dcap"]}` | `2026-09-16 16:06:17.320858+00` |

- `00_snapshot_t0.txt` 同时列出会话前全部 app_config 键：**仅 `dcap`**（`multi_period` 不存在）⇒ 后端 GET 兜底默认 `{"enabled":false,"periods":["1m"],"heights":{"1m":420},"indicators":["dcap"]}`。
- **语义变化（如实报告，未自行恢复）**：`enabled` false→**true**；`periods` `["1m"]`→**`["15m","30m"]`**；`heights` `{"1m":420}`→**`{"15m":420,"30m":180}`**；`indicators` 不变（`["dcap"]`）。`updated_at` 由「无行」变为 `2026-09-16 16:06:17.320858+00`。
- 该变化**全部来自产品自身 `PUT /api/config/multi_period`**（见 §B5 六条 PUT body 全量）。开多周期开关 1 次 + 选择器「确定」5 次。**未自行恢复**（遵规程）。

### 与任务前提的偏差（重要）
- 任务描述「已知 `data-testid=mp-periods-open` 的入口打开即触发 PUT」**未被观测到**：脚本记录 `[picker open] 触发请求 = []`（点击入口前后请求数差 = 0，无任何 PUT）。实际触发 PUT 的是**「多周期」开关**与**选择器「确定」**两项产品动作。已按实测记录。

---

## 1. B1 选择器可达性（真渲染）

- 开启多周期后点击 `[data-testid="mp-periods-open"]` ⇒ `[data-testid="mp-picker"]` 出现。截图 `shot_B1_picker.png`。

**步骤 1（基准）`[data-mp-base-period]` 实渲染顺序：**
```
1m, 5m, 15m, 30m, 1h, 1d, 1w
```
**步骤 2（卫星）`[data-mp-indicator-period]` 分基准枚举：**
```
base=1m  : 1m, 5m, 15m, 30m, 1h, 1d, 1w
base=15m :      15m, 30m, 1h, 1d, 1w
base=30m :           30m, 1h, 1d, 1w
base=1h  :                1h, 1d, 1w
base=1d  :                    1d, 1w
```
- 结论：步骤 1 与步骤 2（base ≤ 30m 时）均**含 30m**；三周期相对顺序 **15m(ind 2) < 30m(ind 3) < 1h(ind 4)**，严格成立；**`1mo` 在两步骤任一列表中都不存在**。`data-mp-picker-hint` 文案含「`1mo` 不提供」。

---

## 2. B2 可同步性（真渲染 + ChartSyncGroup stats 读数）

读数口径：React fiber 反射取 `MultiPeriodChartStack` 的 `ChartSyncGroup` 实例只读 `group.stats`（脚本 `FIND_GROUP_FN`）；比值为像素 520 口径静态表命中。同步由基准 pane 绘图区内滚轮手势触发。

| 组合 | PUT 回显 periods | groupEstablished | syncableFollowerCount | densityByFollower["30m"] | degraded | 判定 |
|---|---|---|---|---|---|---|
| 基准 15m / 卫星 30m | `["15m","30m"]` | **true** | **1** | `{ratio: 1.8, source: "static"}` | true（对齐受限，见 B4） | **PASS** |
| 基准 1m / 卫星 30m | `["1m","30m"]` | **true** | **1** | `{ratio: 24.1, source: "static"}` | true（unreachable，见 B4） | **PASS** |

- 冻结实测值命中：**15m→30m = 1.8**，**1m→30m = 24.1**，`source` 均为 `static`（非 `composed`/`measured`）。`excludedSatellites=[]`。
- 截图：`shot_B2_combo_15m_30m.png`、`shot_B2_combo_1m_30m.png`。

---

## 3. B3 诚实降级（真渲染）

### 3a. 30m 基准 + 1d 卫星（**可达**）
- 卫星 DOM：`[data-mp-sync-excluded="1d"]` `data-mp-sync-excluded-reason="no-shared-anchor"`，文案「未同步（1d）」，`title`（可行动）：「本 pane（周期 1d）与基准周期 30m 的组合不可用（原因：no-shared-anchor）…处置建议：把该 pane 的周期改为与基准同锚点（如 5m 基准选 15m/1h）或调整基准周期」。`visible=true`。
- 组统计：`groupEstablished=false`、`groupReason="no-syncable-follower"`、`excludedSatellites=[{"period":"1d","reason":"no-shared-anchor"}]`。**非静默**。截图 `shot_B3a_30m_1d.png`。

### 3b. 30m 基准 + 1w 卫星（**不可选 = 可见原因**）
- 步骤 2 中 `1w` `disabled=true` 且 `[data-mp-indicator-reason="1w"]` = 「1w 需基准 ≥ 1d（避免恒退化）」，`visible` 文案非空。截图 `shot_B3b_30m_1w_picker.png`。

### 3c. 1h 基准 + 30m 卫星（**结构不可达**）
- 步骤 2 基准 = 1h ⇒ 候选 = `1h, 1d, 1w`；**30m 不在候选**（选择器强制候选 ≥ 基准，且切基准时 `sanitizeSelection` 主动丢弃非法已选项）。截图 `shot_B3c_1h_base_picker.png`。
- 结论：`satellite-lower-than-base` 语义在**产品 UI 上无法构造**（picker 结构性拦截）。此为**真渲染下的可达性事实**，非静默；该项**未能在真渲染中观测**（记为下游裁决项）。

### 3d. 旁证：跨族 1h 基准 + 1d 卫星（**可达**）
- `[data-mp-sync-excluded="1d"]` reason `no-shared-anchor`，title 含可行动建议。截图 `shot_B3d_1h_1d.png`。

### 3e. `unsupported-period`
- 全程 `result.json` 中 `unsupported-period` 命中 **0 次**（`grep -c` = 0）。所观测原因码仅 `no-shared-anchor`（卫星排除）+ picker 禁用原因「1w 需基准 ≥ 1d」。**PASS（不出现 unsupported-period）**。

---

## 4. B4 对齐 drift（30m 配对；复用 287 口径）

组合：基准 15m / 卫星 30m。口径 = `chart.getVisibleRange()`→`getDataList()` **索引定位**；"基准冻结" = 手势后 2.5s 再读窗口与 0.5s 读值逐字段一致。

### 4.1 有界闭环 + 对齐（拖动平移后，`gDrag`）
| 项 | 基准 15m | 卫星 30m |
|---|---|---|
| realFrom/realTo | 13 / 87 | 240 / 281 |
| realFromTs / realToTs | 1788918300000 / **1789438500000** | 1788917400000 / **1789437600000** |
| spanMs | **520200000** | **520200000** |

- 跨度差 = **0 ms**；右缘残差 = 900000 ms = **15 min = 0.5 根卫星 bar（30m bar）** ⇒ 在容差（≤1 根卫星 bar）内。
- stats：`degraded=false`、`lastSpanDiffMinutes=15`、`spanResidualBars=0.5`、`edgeResidualBars=0.5`、`applied=40`、`suppressed=205`、`density={30m:{1.8,static}}`。
- DOM：`[data-mp-sync-degraded]` **不存在**（`domAfterDrag degraded=[null]`）⇒ 对齐态不虚标、也不虚警。
- 基准冻结：`settled` 与 `afterDrag` 前后基准窗一致（同 `justAfter` 的 25/99 → 拖动后 13/87 为手势本身位移；无二次数值漂移）。

### 4.2 退化必须可见（缩放后，`gZoom`）
- stats：`degraded=true`、`degradedPeriod="30m"`、`lastSpanDiffMinutes=5775`、`spanResidualBars=192.5`、`lastUnalignedReason="30m:no-improvement"`。
- DOM：`[data-mp-sync-degraded="30m"] data-mp-span-diff-min="5775"`，文案「对齐受限」，`title`=「…无法在容纳 ≥2 根 bar 的同时与基准图（15m）时间跨度一致（当前跨度差 5775 分钟）。原因：基准图缩放过大 ⇒ 请缩小基准图，或改选周期」。`visible=true`。
- 1m→30m 组合：`degraded=true`、`lastUnalignedReason="30m:unreachable"`、`spanResidualBars=2.27`、`edgeResidualBars=0.567`（可见角标）。
- 结论：**无虚假对齐**——能对齐时残差 0.5 根 bar 且无角标；不能对齐时一律可见降级 + 可行动 title。截图 `shot_B4_15m_30m.png`。

---

## 5. B5 只读与副作用审计

- 全部 HTTP 方法：`{"GET": 21, "PUT": 6}`；无 POST/PATCH/DELETE。
- GET 路径：`/`(1)、`/assets/index-J50SI06a.js`(1)、`/assets/index-BpQVDpqf.css`(1)、`/api/symbols`(1)、`/api/config/multi_period`(3)、`/api/config/ma`(1)、`/api/config/dcap`(1)、`/api/config/kline`(1)、`/api/sources/health`(1)、`/api/kline`(10)。
- 6 条写请求全部为 `PUT /api/config/multi_period`（产品自身触发），body 全量：
  1. `{"enabled":true,"periods":["1m"],"heights":{"1m":420},"indicators":["dcap"]}`（多周期开关）
  2. `{"enabled":true,"periods":["15m","30m"],"heights":{"15m":420,"30m":180},"indicators":["dcap"]}`（选择器确定）
  3. `{"enabled":true,"periods":["1m","30m"],"heights":{"1m":420,"30m":180},"indicators":["dcap"]}`
  4. `{"enabled":true,"periods":["30m","1d"],"heights":{"30m":180,"1d":180},"indicators":["dcap"]}`
  5. `{"enabled":true,"periods":["1h","1d"],"heights":{"1h":420,"1d":180},"indicators":["dcap"]}`
  6. `{"enabled":true,"periods":["15m","30m"],"heights":{"15m":420,"30m":180},"indicators":["dcap"]}`
- console：`consoleAll=[]`（**0 条，含 error 级 0 条**）；`pageErrors=[]`。无 core dump、无崩溃。
- 仓库零改动：仅写 `/tmp`。会话期间仓库内唯一新近改动文件 = `coder/report/293_adr023_period30m_d2_deploy.md`（mtime `2026-09-17 00:00:52`，**部署车道产物，先于本轮浏览器会话**）；D2 源码 mtime 23:42、`web/dist` 23:55、`target/debug/eestock-app` 23:43 均**早于**会话。无新增未跟踪文件来自本轮。
- HEAD 未变：`3094018f352dae25752340d78b5e108c284aeecc`。
- 在线 PID 未变：`178558`（`eestock-app`，持 8081/fd=11）。
- `app_config` 前后差异：见 §0（ABSENT → enabled:true / periods ["15m","30m"]）。

---

## 6. 结论

- **30m 在线上多周期中真实可用**：选择器两步骤均提供 30m 且顺序正确（1mo 不提供）；15m↔30m 与 1m↔30m 均可建立同步组，`groupEstablished=true`、`syncableFollowerCount=1`，密度读数 `source=static` 且精确等于冻结实测值 `1.8` / `24.1`；对齐退化一律可见且带可行动 title，无 `unsupported-period`，无静默。
- **残留风险 / 待裁决**：
  1. `satellite-lower-than-base`（1h 基准 + 30m 卫星）在真渲染中**结构不可达**（picker 强制候选 ≥ 基准），未被观测（列为裁决项）。
  2. `30m↔1w` 的降级在 picker 层以「1w 需基准 ≥ 1d」禁用原因呈现（未进入同步层）；如需同步层原因码证据需另构造。
  3. 缩放态 30m 卫星常用 `degraded=true`（`no-improvement` / `unreachable`）——诚实可见，但意味着 30m 在强缩放下**长期处于「对齐受限」**（可用性/体验取舍交由父级）。
  4. 线上 `multi_period` 配置被本轮验收按其规程改为 `enabled:true / ["15m","30m"]`（未自行恢复）；是否保留或还原由父级裁决。
