# 165（执行/验收）— ④(a) 真实交易时段的分钟兜底节拍（下午盘，补验项 4）

- **本文件自身路径（self-location）**：`tester/test/165_realtime_minute_tick_afternoon_execution.md`
- **报告层级**：执行/验收报告（**只执行、只观测、只给证据**；未改任何产品代码/设计/接口；不进入失败分支、不做失败归因、不做修复）
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`；**HEAD = `aabf680`**（`aabf6805a9a98ddc03d751cf2098726044369c2c`）
- 被测形态：**线上 PID 3112540**（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，cwd=仓库根，同持 8081/8082）；`static_dir=./web/dist`
- 观测窗口：2026-09-14 **13:05:50 – 13:15:27 CST**（周一，**下午连续交易时段 13:00–15:00**）
- 证据目录：`tester/evidence/165_realtime_minute_tick_afternoon/`（`logs/` `json/` + 驱动脚本 + 截图）
- 纪律：**未向线上发任何非 GET 请求**（浏览器侧 `page.route('**/api/**')` 对非 GET 一律 `abort` 并计数，三轮实测 `non_get_total=0`）；**未重启/未 kill 线上**；未 `git add/commit/stash`；**未改仓库任何文件**（除 `tester/` 下本报告与证据）；临时器材用临时端口 `18465`，收尾全拆
- 口径：**独立复现**（不采信上一轮自述）

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 时段判定 | ✅ **真实交易时段（afternoon trading）**：13:05:50–13:15:27，周一；`tradingSession()` ⇒ `trading`（工作日 09:30–11:30 / 13:00–15:00） |
| 1 分钟兜底节拍 | ✅ **成立**：三轮真实观窗（175s + 150s + 132s），**定时器驱动的兜底取数两两间隔均为 60.02s**（60.023 / 60.019 / 60.021s），⇒ 每分钟恰 1 次，抖动 <1s（远优于 ±5s）；其余同形状请求经时间戳关联认定为 **WS 重连补偿**（每轮重连后 ~1.0s 触发，非节拍偏差） |
| 2 非跟随态视口不变 + 有新数据提示 | ✅ 真实手势后 `follow=false`；真实兜底取数前后视口 `{15,120,42,147}` **逐字不变**；屏外新 bar（xLast 1216 > 1200）⇒ 提示「有新数据」出现且视口 `{27,114,27,114}` **不变**，**点击才跳**最新（xLast 1053 ≤ 1200）、提示消失、`follow` 保持 false |
| 3 幂等复核 | ✅ 连续两次真实兜底取回同一根 bar ⇒ 长度 `[120,120]`、emit `[0,0]`、bars 摘要与 canvas 签名均不变（不写不 emit）；同 ts 同 OHLCV 帧重放 ⇒ 不追加不 emit；同新 bar 连发 3 次 ⇒ 只落 1 根 / 只 emit 1 次 |
| 4 回归抽查 | ✅ `scripts/check-tangle.sh` exit **0**；`/healthz` **200**；三份配置与基线一致（kline `{"viewport_bars":120}`、dcap `{"n_s":8,"n_m":36,"n_l":66,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}`、ma `{"windows":[5,10,20]}`）；线上启动日志 **0 ERROR**（7 行全 INFO，mtime/size 仍 11:52:39 / 1126B 未变） |
| 5 卫生 | ✅ `pgrep -x eestock-app`=**1**（3112540）；**无 18xxx 端口残留**（临时 18465 已拆）；`git diff --cached` **空**；tracked 工作树 **0 改动**；`/tmp/app_dev_8081.toml` md5 `6fcb509f…` 未变 |

**末行 VERDICT：PASS**

---

## 1. 项 1 — ④(a) 真实交易时段分钟兜底节拍（**核心项**）

**口径**：真实线上 served bundle 页面（`http://127.0.0.1:8081/`，默认单图 `main-chart`，标的 518880 / 周期 15m，视口 118 bar）。浏览器侧对非 GET 一律 `abort`。统计 `GET /api/kline?...limit=5` 且**无 `before` 游标**的请求。

### 1.1 三轮观窗原始时间戳序列

**窗口 O1**（`observe.mjs`，175s，13:05:50 起，dump 见 `json/observe.json`）

| # | rel(s) | 绝对时刻（UTC ISO） | 归类 |
|---|---|---|---|
| 1 | 57.271 | `2026-09-14T05:06:47.271Z` | WS 重连补偿 |
| 2 | **60.062** | `2026-09-14T05:06:50.062Z` | **定时器节拍** |
| 3 | 118.303 | `2026-09-14T05:07:48.303Z` | WS 重连补偿 |
| 4 | **120.085** | `2026-09-14T05:07:50.085Z` | **定时器节拍** |

`fallbackRawTs = [1789362407271, 1789362410062, 1789362468303, 1789362470085]`；`methodsSeen=["GET"]`，`nonGetTotal=0`。
**定时器节拍间隔 = 120.085 − 60.062 = 60.023s。**

**窗口 O2**（`observe2.mjs`，150s，13:09:12 起，dump 见 `json/observe2.json`）

`fallbackRawTs = [1789362583786, 1789362599788, 1789362612909, 1789362641779, 1789362657781, 1789362672928, 1789362702845]`
rel(s)：30.889 / 46.891 / **60.012** / 88.882 / 104.884 / **120.031** / 149.948
**定时器节拍间隔 = 120.031 − 60.012 = 60.019s**（其余 5 次为重连补偿，见 1.2）。`nonGetTotal=0`。

**窗口 O3**（`observe3.mjs`，132s，13:12:43 起，dump 见 `json/observe3.json`；同时记录 WS 事件）

`fallbackRawTs = [<见 json>]`，rel(s)：**15.953 / 53.327 / 60.013 / 69.329 / 113.294 / 120.034 / 129.300**
**定时器节拍间隔 = 120.034 − 60.013 = 60.021s。**

### 1.2 节拍认定：定时器 vs WS 重连补偿（时间戳关联）

O3 同窗记录 WebSocket 事件：`wsOpens=5`、`wsCloses=5`、`wsFramesIn=79`。逐条关联：

| 兜底请求 rel(s) | 最近的 `ws-close` rel(s) | 距 close | 归类 |
|---|---|---|---|
| 15.953 | 14.951 | +1002 ms | 重连补偿 |
| 53.327 | 52.326 | +1001 ms | 重连补偿 |
| **60.013** | — | — | **定时器节拍** |
| 69.329 | 68.328 | +1001 ms | 重连补偿 |
| 113.294 | 112.291 | +1003 ms | 重连补偿 |
| **120.034** | — | — | **定时器节拍** |
| 129.300 | 128.294 | +1006 ms | 重连补偿 |

- **定时器节拍**的两次请求**不靠近任何 WS 事件**，两两相距 **60.021s** ⇒ 与 `feed.ts:REALTIME_POLL_INTERVAL_MS=60_000` 一致。
- 其余每 5 次请求均在对应 `ws-close` 后 **约 1.0s** 触发 ⇒ 与 `feed.ts:297`「重连成功 ⇒ `pollIncrement('poll')` 补偿」一致（重连由 `WsClient.ts:WS_INBOUND_SILENCE_MS=15_000` 交易时段静默阈值驱动，closes 间隔出现 16.0s 组）。
- 该二义性用**事件关联**消解，未做代码改动，也未依赖被测系统内部计数。

### 1.3 断言结论

| 断言 | 结果 |
|---|---|
| 真实交易时段内观测 ≥2.5 分钟 | ✅ 三轮合计 **457s**（175+150+132），单轮最长 175s |
| `GET /api/kline?...limit=5`（无 `before`）每分钟恰 1 次，±5s | ✅ **成立**：三窗口定时器节拍间隔 60.023 / 60.019 / 60.021s，抖动 <1s |
| 请求形状正确（无 `before` 游标） | ✅ 全部 `hasBefore=false`，`limit=5`，`code=518880&period=15m` |
| 零写请求 | ✅ `methodsSeen=["GET"]`、`nonGetTotal=0`、`blockedWrites=[]` |

---

## 2. 项 2 — 非跟随态视口不变 +「有新数据」提示（真实模块 harness，proxy→线上 8081）

器材：`/tmp/livecheck-165/`（静态托管 068 的 harness dist：**仓库真实模块** `WsClient`/`KlineDataFeed`/`KlineChart`/`realtimePoll`，HTTP 经 Playwright 代理到线上 8081，WS 直连 `ws://127.0.0.1:8081/ws`），临时端口 **18465**（已拆）。dump：`json/harness.json`、`json/focus_hint.json`。

### (a) 非跟随态：真实手势 + 真实兜底取数后视口逐字不变 —— ✅

| 步骤 | `follow` | 视口 `{from,to,realFrom,realTo}` |
|---|---|---|
| 初始 | true | `{5,120,13,129}` |
| 真实拖拽平移后 | **false** | `{15,120,42,147}` |
| 随后**真实兜底取数**（`GET /api/kline?code=518880&period=15m&limit=5`，无 `before`） | **false** | **`{15,120,42,147}`** |

`rangeIdentical = true`（`json/harness.json → fb1.rangeIdentical`）；`followBefore=false, followAfter=false`。

### (b) 屏外新 bar ⇒ 提示出现、视口不变、点击才跳 —— ✅

**硬前置条件**：缩放+向右拖拽后，最新 bar 像素 `xLast = 1216 > 容器宽 1200`（屏外，`json/focus_hint.json → preconditionOffViewport=true`）。

| 量 | 注入前 | 注入后 |
|---|---|---|
| `dataLen` | 120 | 121 |
| `rtCount`（真实 emit 计数） | 0 | 1 |
| 最新 ts | `…05:00:00Z` | `…05:15:00.000Z` |
| 视口 | `{27,114,27,114}` | **`{27,114,27,114}`（逐字不变）** |
| 提示 `[data-testid="kline-new-data-hint"]` | false | **true**（文本「有新数据」） |

点击提示后：`hintGoneAfterClick=true`、最新 bar 回到视口内（`xLast 1229 → 1053 ≤ 1200`，`jumpedToLatest=true`）、`follow` 仍 `false`（只跳视口、不改跟随口径）。截图 `h07_hint_offscreen.png`、`h08_after_click_offscreen.png`。

---

## 3. 项 3 — 幂等复核 —— ✅

| 子场景 | 结果 | 判据 |
|---|---|---|
| 连续两次**真实兜底取数**（同窗口重复取回同一根 bar） | `len=[120,120]`、`rt=[0,0]`、`digestSame=true`、`canvasSame=true` | 长度/emit 次数不变（不写不 emit） |
| 重放「已存在且字段完整」的最后一根（同 ts 同 OHLCV+amount） | `len [120,120]`、`rt [0,0]` | `ignore` |
| 同 tc 新 bar 连发 3 次 | `appendedTwice=0`、`reEmitted=0` | 只落 1 根、只 emit 1 次 |
| 注入一根新 bar（视口外） | `len 120→121`、`rt 0→1`、提示出现 | 新 bar 正常 append + emit + 提示 |

依据：`json/harness.json → idempotentRealPoll / inject`。

---

## 4. 项 4 — 回归抽查

| 门禁 | 结果 | 证据 |
|---|---|---|
| `./scripts/check-tangle.sh` | exit **0**：`✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` | `logs/check_tangle.log` |
| `GET /healthz` | **200** | §5 观测 |
| `GET /api/config/kline` | `{"viewport_bars":120}`（与基线逐字节一致） | `logs/live_config_kline.json` |
| `GET /api/config/dcap` | `{"n_s":8,"n_m":36,"n_l":66,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}`（当前值，只读 GET 记录） | `logs/live_config_dcap.json` |
| `GET /api/config/ma` | `{"windows":[5,10,20]}`（与基线一致） | `logs/live_config_ma.json` |
| 线上启动日志 ERROR 数 | **0**（`grep -c -iE '\bERROR\b' = 0`；7 行全 INFO） | `logs/app_dev_8081_redeploy_20260914_115233.log` |

> 说明：本项按任务口径只做「抽查」四项，未复跑全量 `vitest`/`tsc`（时间盒 ≤15 分钟优先保障核心项 1；全量单元层已在 068 窗口全绿）。

---

## 5. 项 5 — 卫生

| 检查 | 结果 | 证据 |
|---|---|---|
| `pgrep -x eestock-app` | **1** ⇒ `3112540 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（**未重启/未 kill**） | `logs/hygiene_final.txt` |
| 18xxx 端口残留 | **无**（临时静态服务 18465 已 kill；临时目录 `/tmp/livecheck-165` 已 `rm -rf`） | `logs/hygiene_final.txt` |
| `git diff --cached` | **空**（0 文件） | `logs/hygiene_final.txt` |
| tracked 工作树 | **0 改动**（`git status --porcelain -uno` 空） | `logs/hygiene_final.txt` |
| 线上配置/日志 | `/tmp/app_dev_8081.toml` md5 `6fcb509f41b9d128da24153079b2964d` 未变；线上日志 mtime/size 仍 `11:52:39 / 1126B` | `logs/hygiene.txt` |

---

## 6. 观测说明与边界（非结论性）

1. **二义性消解方式**：线上真实页面默认**单图**（`probe_dom.mjs`：`klineChartEls=1`、`main-chart` region、`gridCells=0`）。同形状 `limit=5` 除 60s 定时器外还由 **WS 重连补偿**产生；本报告以**同窗 WS 事件时间戳关联**（重连后 ~1.0s）将二者区分，定时器节拍即两两 60.02s 的那两次。此处仅作观测分类，不对任何行为做「缺陷/修复」判断。
2. **视口/提示/幂等**在 harness（**仓库真实模块**）上复现，HTTP 代理到线上、WS 直连线上；未修改被测代码，未对线上发写请求。
3. 观测期间线上进程日志零新增（mtime/size 未变）⇒ 页面流量未污染线上日志。

---

## 7. 证据索引

| 路径（相对 `tester/evidence/165_realtime_minute_tick_afternoon/`） | 内容 |
|---|---|
| `json/observe.json` | O1 原始观窗（175s，请求清单 + 原始时间戳） |
| `json/observe2.json` | O2 原始观窗（150s） |
| `json/observe3.json` | O3 原始观窗（132s，含 WS open/close/frame 事件） |
| `json/classify_observe3.json` | O3 兜底请求逐条归类（定时器 vs 重连补偿） |
| `json/harness.json` | 项 2(a)/项 3 原始结果 |
| `json/focus_hint.json` | 项 2(b) 前置条件 + 提示 + 点击跳最新 |
| `logs/live_config_{kline,dcap,ma}.json` | 三端点原始响应 |
| `logs/check_tangle.log`、`logs/app_dev_8081_redeploy_20260914_115233.log` | 回归门禁 |
| `logs/hygiene.txt`、`logs/hygiene_final.txt` | 卫生检查 |
| `observe.mjs`/`observe2.mjs`/`observe3.mjs`/`harness_check.mjs`/`focus_hint.mjs`/`probe_dom.mjs`/`classify.mjs` | 可复现驱动脚本 |
| `live_page.png`、`harness_hint.png`、`h07_hint_offscreen.png`、`h08_after_click_offscreen.png` | 截图 |

---

**结论一句话**：在 2026-09-14 13:05–13:15 CST 真实下午交易时段，线上页面定时器驱动的分钟兜底取数两两间隔恒为 60.02s（三轮 60.023/60.019/60.021s），**每分钟恰 1 次成立**（抖动 <1s，远优于 ±5s）。

**末行 VERDICT: PASS**
