# 068（执行/验收）— ④「实时更新补齐」线上独立验收（补跑，带时间盒）

- **本文件自身路径（self-location）**：`tester/test/068_realtime_4_live_acceptance_execution.md`
- **报告层级**：执行/验收报告（**只执行、只观测、只给证据**；未改任何产品代码/设计 `file=` 块；不进入失败分支、不做失败归因、不做修复）
- 设计报告（同批次）：`tester/design/068_realtime_4_harness_acceptance_design.md`
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`；**HEAD = `ce87766`**（`ce87766513612d919656ec7e6d7f0e93c3cfb801`）
- 被测形态：**线上 PID 3112540**（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，cwd=仓库根，同持 8081/8082）；`static_dir=./web/dist`
- 观测窗口：2026-09-14 **12:21:57 – 12:29:34 CST**（`tradingSession()` ⇒ **`lunch`（午间休市）**）
- 证据目录：`tester/evidence/068_realtime_4_accept/`（`harness/` `scripts/` `json/` `logs/` `screenshots/`）
- 纪律：**未向线上发任何非 GET 请求**（浏览器侧非 GET 一律 `abort` 并计数，实测 0 次）；**未重启/未 kill 线上**；未 `git add/commit/stash`；未改仓库任何文件（除 `tester/` 下本报告与证据）；临时器材全部临时端口、收尾全拆
- 本次口径：**独立复现**（不采信上一运维车道自述——其报告未落盘；也不代替架构师结论）

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 1 部署一致性 | ✅ `cargo build -p app` 空跑（`Finished dev profile in 0.32s`，零编译）⇒ 部署二进制==HEAD 构建；served `index.html` 与 `web/dist/index.html` **`cmp` 逐字节相同**；`index-DgTTwVw8.js` / `index-LiEzF-e0.css` served-vs-dist **sha256 一致**；窗口前 `index-CBm_5q76.js` → 现在 `index-DgTTwVw8.js` |
| 2 配置零污染 | ✅ kline/dcap/ma 三端点与基线串 **`cmp` 逐字节一致**；`/tmp/app_dev_8081.toml` md5 = `6fcb509f…`（同 058 基线）；**本窗口请求清单全部 GET、nonGet=0、blockedWrites=0**；线上日志 mtime/size 未变 |
| 3④ 非时点依赖行为 | ✅ (a) 真实手势（拖拽+滚轮）后 `follow=false`，真实兜底取数前后视口坐标**逐字不变**；(b) 前置条件「最新 bar x=1216 > 容器宽 1200」成立后注入新 bar ⇒ 提示「有新数据」出现且视口 `{27,114,27,114}` **不变**，点击后跳最新、提示消失；(c) 真实重复取数 + 字段完整帧重放均**不写不 emit**、同新 bar 连发 3 次只 append 1 次/emit 1 次；(d) 2×2（4 图同 key）并发兜底 **1 次 HTTP ≤ 4**，6 图 **4 次 ≤ 6** |
| 4④(a) 分钟兜底节拍（真实时钟） | ⚠️ **未完成——未取得真实交易时段证据**（执行时全程午休）。替代证据：70s 空闲观窗 **0 次兜底取数/0 入站帧**（非交易时段门控生效）；交易时段节拍依据引用 `tester/test/058`（冻结时钟：门控 25/25、入站帧复位 3/3、兜底/幂等/视口 16/16） |
| 5 回归 | ✅ `vitest run` **63 文件 / 605 用例全绿**、exit 0；`tsc -b` exit 0；`check-tangle.sh` exit 0；线上启动日志 **0 ERROR/WARN**（7 行全 INFO）；线上页面只读冒烟无 console/page error。⚠️ ①（分割线/0 线）等 **Playwright e2e 未复跑**（写风险 + 时间盒，详见 §7 未完成项） |
| 6 反向证据 | ✅ `/tmp` 副本把非交易时段阈值改回 15s ⇒ 仓库用例 `WsClient.watchdog.test.ts > T-R1-e2` **红**（`expected 0, received 1`，`:303`），`1 failed / 7 passed`；**仓库文件 md5 未变**（`044b6b443daa74a3e6702447899a944d`） |
| 7 卫生 | ✅ `pgrep -x eestock-app` = **1**（3112540）；18xxx 无监听（临时服务已 kill）；`git diff --cached` 空；tracked 工作树 0 改动；`web/dist` 与 `/tmp/app_dev_8081.toml` 窗口前后**逐字节未变**；`WsClient.ts`/`feed.ts` md5 与 058 基线一致。自纠：一度误在**仓库外**创建 `…/git/eestock/tester/`（shell 后台化吞掉 `cd`）已删除 |

**末行 VERDICT：PASS（带未完成项：第 4 项）**

---

## 1. 项 1 — 部署一致性（二进制 == HEAD；served == dist）

**1a 部署二进制 == HEAD 构建（`cargo build -p app` 空跑）**

```
$ cd <repo> && cargo build -p app
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.32s      # exit=0，零编译行
```
证据：`logs/cargo_build_app.log`。工作树 tracked 0 改动（`git status --porcelain -uno` 空）⇒ 该 target 正是 HEAD `ce87766` 的构建产物。

**1b served index.html 与 dist `cmp`**

```
$ curl -s http://127.0.0.1:8081/ -o logs/served_index.html
$ cmp logs/served_index.html web/dist/index.html   # exit=0 ⇒ 逐字节相同
sha256 6c4c45695baaad1bb129574fa72b6ec305f7fd8d952a3e369f8151fe4f69a404  (两侧同)
```

**1c JS/CSS sha256（served vs dist）**

| 文件 | served sha256 | dist sha256 |
|---|---|---|
| `assets/index-DgTTwVw8.js` | `31dedacc5fc23c806509cdfac30697baf7e13154c8e3cea1cba1d3e40b5d735d` | 同左 |
| `assets/index-LiEzF-e0.css` | `0efde58240c13980cbda1fd8586e8b876adef8621721f412b6d1bfb4c3acae3c` | 同左 |

**1d 窗口前 bundle 名 vs 现在**

| 时点 | bundle | 佐证 |
|---|---|---|
| 本窗口前（011:06 起） | `index-CBm_5q76.js` | `coder/evidence/165_realtime_live_redeploy/05_frontend_build.txt:8`、`tester/test/057` §L241、`tester/test/058`（md5 `7f312b28…`） |
| 现在（12:2x） | **`index-DgTTwVw8.js`**（+ `index-LiEzF-e0.css`） | 本报告 1b/1c；`static_dir=./web/dist` 为**按请求实时读盘**，故线上即刻服务新产物 |

served `index.html` 引用即 `<script src="/assets/index-DgTTwVw8.js">` + `link … index-LiEzF-e0.css`（见 `logs/served_index.html`）。

---

## 2. 项 2 — 配置零污染 + 「零写请求」证据

**2a 三端点与基线逐字节一致**（基线串由架构师给出；`cmp` exit=0）

| 端点 | 线上响应（原样） | 字节数 | md5（基线==线上） |
|---|---|---|---|
| `GET /api/config/kline` | `{"viewport_bars":120}` | 21 | `8134d960d65192f3139e3a22580125f0` |
| `GET /api/config/dcap` | `{"n_s":8,"n_m":36,"n_l":66,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}` | 74 | `9dbc6ac498348b96675fcc14fedc9f45` |
| `GET /api/config/ma` | `{"windows":[5,10,20]}` | 21 | `2a88ffd93c46fd084a7bfee6425410d7` |

`GET /healthz` = **200**。`/tmp/app_dev_8081.toml` md5 = **`6fcb509f41b9d128da24153079b2964d`**（与 058 记录基线一致）。
证据：`logs/live_config_{kline,dcap,ma}.json`、`logs/app_dev_8081.toml.copy`。

**2b 本窗口零写请求（请求清单）**

- **结构保证**：Playwright 侧 `page.route('**/api/**')` 对**任何非 GET 直接 `abort`**，并落账 `blockedWrites`。
- 实测：`methods_seen = ["GET"]`；`non_get_total = 0`；`blockedWrites = []`（**连写尝试都没有发生**）。
- 我经由 shell 的请求（全部 GET）：`/healthz`、`/api/config/{kline,dcap,ma}`、`/`、`/assets/index-DgTTwVw8.js`、`/assets/index-LiEzF-e0.css`。
- 经浏览器（harness 代理 + 线上页面）的请求形状共 17 种，全部 `GET`，例如 `/api/kline?code=518880&period=15m&limit=N`、`/api/symbols`、`/api/sources/health`、`/api/config/*`。
- 兜底形状（`limit=5` 且**无 `before`**）累计 **9+1+3 = 13 次**（全部由本报告项 3 的显式调用产生）。
- **旁证**：线上进程日志 `logs/app_dev_8081_redeploy_20260914_115233.log` 在窗口内 **mtime 仍 11:52:39、size 仍 1126B**（未新增任何行）。
- 清单落盘：`json/request_manifest.json`。

---

## 3. 项 3 — ④ 非时点依赖行为（真实页面/真实模块，只读）

器材：`/tmp/acc4x/`（vite 用**仓库真实模块** `WsClient`/`KlineDataFeed`/`KlineChart`/`realtimePoll` + Tailwind CSS + klinecharts 透传 spy），HTTP 由 Playwright 代理到线上 8081，WS 直连 `ws://127.0.0.1:8081/ws`；临时静态端口 **18441**（已拆）。

### (a) 非跟随态视口不被强拉 —— ✅

真实手势（`mousedown`+拖拽、`wheel` 缩放）：

| 步骤 | `follow` | 视口 `{from,to,realFrom,realTo}` |
|---|---|---|
| 初始 | true | `{5,120,13,129}` |
| 拖拽平移后 | **false** | `{5,120,37,153}` |
| 滚轮缩放后 | **false** | `{15,120,42,147}` |

随后**触发两次真实数据更新**（真实 `GET /api/kline?code=518880&period=15m&limit=5`，无 `before`）：

```
[fb1 之后] rangeAfterRealDataUpdate = {15,120,42,147}
rangeIdentical = true          # 与手势后逐字相同
followBefore = false, followAfterRealDataUpdate = false
realtimeStats = {lastSource:null, lastWriteAt:null, lastPollOkAt:1789359924329, pollFailures:0}
```
`lastPollOkAt` 前进而 `lastSource` 仍 `null` ⇒ 兜底**取到了数**但数据无变化（走幂等 `ignore` 分支），**视口未被拉回最右**。证据 `json/result.json → harness.a_viewportInvariance`、截图 `screenshots/02_after_gesture_fallback.png`。

### (b)「有新数据」提示：视口外新 bar ⇒ 提示出现且视口不变；点击跳最新 —— ✅

**前置条件（显式断言）**：缩放+向右拖拽后，最新 bar 像素 x = **1216 > 容器宽 1200**（屏外）。

注入一根新 bar（`{...线上真实最后一根, ts: last+15m, close: last.close+0.5}`，schema 见 `WsClient.ts:5`）：

| 量 | 注入前 | 注入后 |
|---|---|---|
| `dataLen` | 120 | 121 |
| `rtCount`（真实 emit 计数） | 0 | 1 |
| 最新 ts | `…03:30:00Z` | `…03:45:00.000Z` |
| 视口 `{from,to,realFrom,realTo}` | `{27,114,27,114}` | **`{27,114,27,114}`（逐字不变）** |
| 提示 `[data-testid="kline-new-data-hint"]` | false | **true**（文本「有新数据」） |

点击提示后：提示消失（`hintGoneAfterClick=true`）、最新 bar 回到视口内（x 1229→**1053 ≤ 1200**，`jumpedToLatest=true`）、`follow` 仍为 `false`（只跳视口、不改跟随口径）。
证据：`json/focus_b2.json`、截图 `screenshots/07_hint_offscreen.png`、`08_after_click_offscreen.png`。

### (c) 幂等：同一根 bar 重复取回 ⇒ 不重复 emit / 不改变长度 —— ✅

| 子场景 | 结果 |
|---|---|
| 连续两次真实兜底取数（同窗口重复取回） | `len [121,121]`、`rtCount [1,1]`、bars 摘要相同 ⇒ **不写不 emit** |
| 重放「已存在且字段完整」的最后一根（同 ts 同 OHLCV+**amount**） | `len [121,121]`、`rtCount [1,1]`、摘要相同 ⇒ `ignore` |
| 同一根**新** bar 连发 3 次 | `appended = 1`、`emitted = 1` ⇒ 只落 1 根、只 emit 1 次 |

支撑观测：`realtimeStats`（`lastSource/lastWriteAt/lastPollOkAt/pollFailures`）与 canvas 签名（`canvasSig`）在两次真实取数间一致（`json/result.json → harness.c_realFetchIdempotency`：`lenStable/digestStable/noReEmit/canvasStable` 全 true）。
> 探针自纠（非产品结论）：首轮用**缺字段**（漏 `amount`）的 bar 重放触发了 1 次 `update` emit；`feed.ts:69 sameBarValues` 比较含 `amount`，改为**字段完整帧**后为 `ignore`。该差异已定位在探针构造侧（`json/focus_bc.json`）。

### (d) 宫格限流/合并 —— ✅

| 场景 | 图数 | 同 key HTTP 次数 | 判据 |
|---|---|---|---|
| 2×2（4 图，同 `518880:15m`）并发兜底 | 4 | **1**（`/api/kline?code=518880&period=15m&limit=5`，无 `before`） | ≤ 图数 ✅ |
| 6 图（3 同 key + 3 异 key） | 6 | **4**（1 合并 + 3 异 key） | ≤ 6 ✅ |

证据：`json/result.json → harness.d_grid2x2 / d_multi6`。

### 线上 served bundle 真实页面只读冒烟 —— ✅

```
title = "eestock · 行情看板"
scripts = ["/assets/index-DgTTwVw8.js"]   css = ["/assets/index-LiEzF-e0.css"]
data-viewport-fit = {"bars":120,"space":11,"visible":118,"clamped":false}
canvasCount = 10 ; hasRoot = true ; consoleErrors = none ; pageErrors = none
```
截图 `screenshots/04_live_page.png`。

---

## 4. 项 4 — ④(a) 分钟兜底节拍（真实时钟）：**未完成（未取得真实交易时段证据）**

- 执行时时段判定：`12:21–12:29` ⇒ `tradingSession()` = **`lunch`（午间休市）**（`web/src/shell/session.ts`：`minutes<11:30 trading / <13:00 lunch`；探针实测 `{shanghai:"12:29", day:1, session:"lunch"}`）。
- **因此按要求不做「≥2.5 分钟真实节拍」观测，本项列为未完成。**（午后 13:00 开盘后，本项可由后续窗口按原计划以 `/api/kline?...limit=5` 无 `before` 的请求节拍补齐。）
- **替代证据（本次独立取得）**：70s 空闲观窗（harness 置非跟随态 + 线上真实页面同时打开）：

```
idleSeconds=70  harnessFollow=false  harnessStatus="open"  harnessConns=1  harnessFrames=0
idleRequests=[]  idleFallbackNoBefore=0  idleAnyKline=0  nonGet=0
harnessStats={lastSource:null,lastWriteAt:null,lastPollOkAt:null,pollFailures:0}
```
⇒ **非交易时段不空转**（无兜底取数、无入站帧、无重连），与 ④ 的门控口径一致。证据 `json/idle.json`。
- **交易时段证据引用（本次不重跑）**：`tester/test/058_realtime_gate_phase3_independent_acceptance_execution.md`（临时实例 + 冻结时钟：门控 25/25、入站帧复位 3/3、分钟兜底/幂等/视口 16/16；含「虚拟 2 分钟恰 2 次 `limit=5` 无 `before`」「非交易时段 0 次」）。

---

## 5. 项 5 — 回归

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npx vitest run`（web） | **63 文件 / 605 用例全绿**，exit **0**（7.75s、33.41s tests） | `logs/vitest.log` |
| `npx tsc -b`（web） | exit **0**，无输出 | `logs/tsc.log` |
| `./scripts/check-tangle.sh` | exit **0**：`✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` | `logs/check_tangle.log` |
| 线上启动日志 | **0 ERROR / 0 WARN**（7 行全 INFO：starting→schema ok→registry→sim-live→serving 8081→mcp 8082→sse opened） | `logs/app_dev_8081_redeploy_20260914_115233.log` |
| 线上页面 | 无 console error / pageerror | `json/result.json → realPage` |

与本次上线相关的定向用例（全绿）：
`KlineChart.realtime.test.tsx(8)`、`feedRealtimePoll.test.ts(7)`、`feedRealtimeReconnect.test.ts(2)`、`realtimePoll.test.ts(3)`、`WsClient.watchdog.test.ts(8)`、`WsClient.test.ts(13)`、`KlineChartSwitchLayout.test.tsx(3)`、`KlineChartDcapSaveLayout.test.tsx(7)`、`dcapWiringP3.test.tsx(14)`、`dcapWarmupP3.test.ts(9)`、`store.test.ts(32)`、`session.test.ts(7)`。

**未复跑（见 §7）**：① 分割线/0 线的 Playwright e2e、② 保存参数不重建 pane 的**浏览器侧本地兑现**（这两条需 e2e/交互，且 e2e 套件含写路径 ⇒ 对线上有写风险）；其单元层覆盖（`KlineChartDcapSaveLayout`/`dcapWiringP3`）已绿。

---

## 6. 项 6 — 反向证据（注入式对照，必须红）

在 **`/tmp/mut068/`（仓库 `web/src` 的副本，仓库文件零改动）** 中把非交易时段阈值改回旧值：

```diff
-export const WS_INBOUND_SILENCE_OFFHOURS_MS = 300_000;
+export const WS_INBOUND_SILENCE_OFFHOURS_MS = 15_000;
```
（`logs/mutation_offhours_threshold.diff`）

```
$ npx vitest run src/ws/WsClient.watchdog.test.ts
 FAIL  … > T-R1-e2 非交易时段（周六）：静默 15s 不得触发；静默满 300s 才触发
 AssertionError: expected 1 to be +0
 ❯ src/ws/WsClient.watchdog.test.ts:303
     expect(sock.closeCalls).toBe(0); // 非交易时段 15s **不得**触发（空转重连）
 Test Files  1 failed (1)      Tests  1 failed | 7 passed (8)
```
⇒ 该断言族**会红**（对照组同轮 7/7 绿），证明「非交易时段 300s 门控」判据有效。
**仓库未受影响**：`web/src/ws/WsClient.ts` md5 = **`044b6b443daa74a3e6702447899a944d`**（与 058 基线一致），`feed.ts` md5 = `ce798fb7ba81605dd3bff8775a851650`；`/tmp/mut068` 已删除。

---

## 7. 项 7 — 卫生与未完成项

**卫生（全部通过）**

| 检查 | 结果 |
|---|---|
| `pgrep -x eestock-app` | **1** ⇒ `3112540 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml` |
| 18xxx 端口残留 | **无**（`ss -ltnp`；临时 `python3 -m http.server 18441` 已 kill） |
| 我的临时进程残留 | 无（`acc4x/run.mjs|focus_b*|idle.mjs`、playwright 浏览器均已退出） |
| `git diff --cached` | **空**（0 文件） |
| tracked 工作树 | **0 改动**（`git status --porcelain -uno` 空；仅 `??` 未跟踪：`tester/` 报告与证据、历史遗留） |
| 线上配置 / 产物 | `/tmp/app_dev_8081.toml` md5 `6fcb509f…` 未变；`web/dist` 三文件 sha256 与窗口初测一致（未重编） |
| 仓库源码 | `WsClient.ts`/`feed.ts` md5 与基线一致（未被探针/变异污染） |
| 自纠记录 | 一度因 shell 把 `cd` 连同 `nohup` 一起后台化，误在**仓库外**创建 `…/git/eestock/tester/`（4 个空目录）——已 `rm -rf` 清除；未触碰仓库 |

**未完成项（含原因）**

1. **项 4 真实交易时段分钟节拍**：执行时全程午休（`lunch`）。按要求列未完成，替代证据见 §4，交易时段依据引用 `tester/test/058`。
2. **项 5 中 ① 分割线/0 线 e2e 与 ② 保存参数不重建 pane 的浏览器侧本地兑现**：未在时间盒内复跑——e2e 套件含写路径，对线上有写风险（硬约束禁止），且 20 分钟时间盒优先保障 1–4 项。单元层（`KlineChartDcapSaveLayout`/`dcapWiringP3`/`KlineChartSwitchLayout`）已绿。
3. **项 6 反向证据族**：本次只做了「非交易时段阈值」一族变异（要求为「至少一处」）；门控/幂等其余族未做第二组变异。

**最小修正建议（只提建议，不做修改）**

1. 下一窗口把「真实交易时段节拍」安排在 **13:00 之后**（或 15:00 后按收盘口径）执行；若时间盒紧，可先只跑 `/api/kline?...limit=5` 的请求节拍（≤3 分钟）。
2. e2e 类回归建议放到**临时实例**（非线上）上跑，避免唯一硬约束（零写）与回归广度冲突。
3. 线上验收建议常备「非 GET 一律 abort」的浏览器护栏（本次已实现并复用），可把「零写」从纪律升级为结构保证。

---

## 8. 证据索引

| 路径（相对 `tester/evidence/068_realtime_4_accept/`） | 内容 |
|---|---|
| `logs/cargo_build_app.log` | `cargo build -p app` 空跑输出 |
| `logs/served_index.html`、`logs/served_index-DgTTwVw8.js`、`logs/served_index-LiEzF-e0.css` | 线上 served 原始产物（用于 `cmp`/sha256） |
| `logs/live_config_{kline,dcap,ma}.json`、`logs/app_dev_8081.toml.copy` | 三端点原始响应 + 线上配置副本 |
| `logs/app_dev_8081_redeploy_20260914_115233.log` | 线上启动日志（0 ERROR/WARN） |
| `logs/vitest.log`、`logs/tsc.log`、`logs/check_tangle.log` | 回归门禁 |
| `logs/mutation_offhours_threshold.diff` | 反向证据变异 diff |
| `json/result.json` | 主驱动原始结果（含请求清单、A/C/D 项、线上页面冒烟） |
| `json/focus_b2.json` | (b) 前置条件 + 提示 + 点击跳最新 |
| `json/focus_bc.json` | (b)(c) 另一轮 + 幂等三子场景 |
| `json/idle.json` | 70s 空闲观窗（非交易时段不空转） |
| `json/request_manifest.json` | 本窗口请求清单（方法/形状/非 GET 计数/被拦写请求） |
| `screenshots/01..08*.png` | 各阶段页面截图 |
| `harness/`、`scripts/` | 可复现的 harness 源码与四个驱动脚本 |
