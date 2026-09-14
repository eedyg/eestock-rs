# 058 — 阶段 3 独立验收（真实 WS/HTTP，临时实例）：WsClient 门控固定阈值 + 分钟兜底 + 幂等合并 + 「有新数据」提示

- **本文件自身路径（self-location）**：`tester/test/058_realtime_gate_phase3_independent_acceptance_execution.md`
- **报告层级**：执行/验收报告（**只执行、只观测、只给证据**；未改任何产品代码/设计 `file=` 块；不进入失败分支、不做失败归因、不做修复）
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`；HEAD = `6391a4d`；分支 `master`
- 被测形态：**工作树**（含 ④/⑤ 未提交改动：`WsClient.ts` / `feed.ts` / `KlineChart.tsx` / `kline-matrix.e2e.ts` / `design/06-web/01-dashboard.md` + 未跟踪 `realtimePoll.ts` 与 5 个测试文件）
- 观测窗口：2026-09-14 11:30–11:52（Asia/Shanghai；**午间休市**，后端行情推送静默 ⇒ 天然接近「半开连接」场景）
- 证据目录：`tester/evidence/058_realtime_gate_acceptance/`（`probes/` + `harness/` + `logs/` + `json/`）
- 纪律：未 `git add/commit/stash`；未跑仓库内 tangle（只跑 `scripts/check-tangle.sh` 检验）；未改 ABI/引擎/ExecutionPolicy/`dcap.ts`；未重启/触碰线上 PID `2948632`；未向线上发任何写请求；临时实例全部用临时端口 + 只读 DB，收尾全拆
- 本次口径：**独立复现，不采信实现车道（`coder/report/058`）自述**

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 1 门控阈值行为 | ✅ 交易时段（时钟桩到周一 10:00）静默 **14s 不重连 / 15s 必 close**（状态离开 open）→ 退避 1s 后真实重连 → **重连后 1 次 HTTP 增量补偿把截掉的 3 根全部补齐**（数据面完全还原、无空洞/无重复）；非交易时段（周六）**15s 不重连、298s 不重连、300s 才自愈**，模拟 1 小时新增重连 **12 次**（≈1 次/5 分钟，无 15s 空转） |
| 2 任一入站帧复位 | ✅ health / quote / bar 三类帧各一轮：13s 注入 ⇒ 27s 仍不 close；注入后满 15s 才 close |
| 3 分钟兜底 + 幂等合并 | ✅ 虚拟 2 分钟恰 2 次 `limit=5`（无 `before`）兜底；`document.hidden` 0 次、非交易时段 0 次；同 ts 同值不写不 emit、同 ts 值变原地覆盖、更晚 ts append；6 图并发 ⇒ 4 次 HTTP（同 (code,period) 3 图合并为 1 次） |
| 4「有新数据」提示 | ✅ 非跟随态 + 新 bar 到屏外（像素 x=2035 > 容器宽 1200）⇒ 提示出现、**视口 from/to 前后逐字不变**；点击后跳最新 |
| 5 回归 | ✅ G16/G18 绿；①（分割线）e2e 绿；分页 T1/T3/T4 绿；vitest 全量 **63 文件 / 605 用例绿**、定向 14 文件 / 110 用例绿（含 DCAP 契约、ADR-020 视口、切周期/标的布局、幂等合并、看门狗）。⚠️ `dashboard-periods-ma.e2e.ts` T2/T5 **红**——**在 HEAD 基线上以同一报错同样红**（环境/既有问题，非本次改动引入；T5 是只读库导致 PUT=500） |
| 6 反向证据 | ✅ 两族各自演示会红：拆门控（阈值恒 15s）⇒ 非交易时段「20s 不重连」断言红；拆同 ts 幂等合并 ⇒ 「同 ts 同值不写不 emit」断言红。对照组同轮全绿；还原后 **md5 逐字节一致**且回绿 |
| 7 门禁与卫生 | ✅ `check-tangle` exit=0；`tsc -b` exit=0；vitest 全绿；`git diff --cached` 空；tracked 改动 = 5 个（4 前端 + 1 处散文，`file=` 零触碰）；临时实例/端口全拆；线上 PID 2948632 未触碰、`/tmp/app_dev_8081.toml` 与 `web/dist` 逐字节同基线；本次全程**只有 GET**（无任何写请求） |
| 8 明确不做 | ✅ 未重启线上；未评价 dcap 信息量；未在估值器/魔法数上调参；未做任何修复性改动 |

**末行 VERDICT：见报告末尾。**

---

## 1. 器材（全部临时、全部只读、全部已拆）

| 器材 | 说明 |
|---|---|
| 临时后端实例 A | `/tmp/acc_rec/app.toml`：`listen=127.0.0.1:18211` / `mcp=127.0.0.1:18212` / `static_dir=/tmp/acc_rec/dist` / `database_url=…?options=-c%20default_transaction_read_only%3Don`（**只读事务**）；`./target/debug/eestock-app`（既有构建，未重编后端）→ 收尾已 kill（端口 18211/18212 已释放） |
| 临时后端实例 B（HEAD 基线差分） | `listen=127.0.0.1:18213` / `18214` / `static_dir=/tmp/acc_rec/dist_base`；HEAD 由 `git worktree add --detach /tmp/acc_rec/base 6391a4d` 取得（**未动主工作区/暂存区**），构建后 `git worktree remove --force` 已清理（`git worktree list` 仅剩既有 3 个历史 worktree）→ 收尾已 kill |
| 页面 A（真实看板） | 工作树 build（`vite build --config /tmp/acc_rec/vite.acc.config.ts`，`VITE_API_MOCK=0`）直写实例 A 的 `static_dir`；`klinecharts` 经临时 alias 指向 `kc-spy.ts`（**透传真身**，仅暴露 `window.__ACC__{inits,charts,log}` 供读取 dataList/可见区间） |
| 页面 B（自建观测底座） | `web/__acc_harness__/`（临时、已删除；副本存 `evidence/058_.../harness/`）：用**仓库真实模块** `WsClient` + `createHttpClient('')` + `KlineDataFeed` + `KlineChart` 组装，暴露 `window.__H__{status,conns,dataList,stats,rtCount,inject,bars,setFollow,multiPoll,…}` |
| 真实 WS | 浏览器 `WebSocket` 直连 `ws://127.0.0.1:18211/ws`（真实握手 + 真实订阅帧；看板页实测发出 4 帧 subscribe：quote/health/bar/…）；无任何协议外帧、无应用层心跳 |
| 真实 HTTP | 真实 `GET /api/kline`（含兜底 `limit=5` 无 `before`、初始 `limit=120`）；无任何写方法 |
| 通道活性实测 | `logs/ws_observe_lunch.log`（Node `ws` 直连实例 A，25s）：订阅后 **~2.0s 一次性快照 burst（1 bar + 44 quote + 1 health）后 23s 内 0 帧** ⇒ 午休时段「无入站帧」为真实事实（半开等价场景），故看门狗路径可真实触发 |
| 时钟控制 | `page.clock.install({time}) + page.clock.pauseAt(time)`：**冻结**虚拟时钟（真实等待不推进；实测 3s 真实等待推进 0ms、`fastForward` 精确 1:1），仅用于门控输入 `tradingSession(new Date())`；网络/定时器事件仍真实 |
| 反向证据 | 变异 A：`WsClient.silenceThresholdMs()` 恒返回 15s；变异 B：去掉 `applyRealtime` 的 `sameBarValues` 早返回。两轮均**只重建页面产物**，跑完即还原（副本 `json/WsClient.ts.pristine`、`json/feed.ts.pristine` + md5 比对） |
| 纪律性说明 | 反向证据属于「只做减法」范围之外的**测试侧变异**（不改设计、不留痕、跑完还原）；产品代码最终 md5：`WsClient.ts=044b6b443daa74a3e6702447899a944d`、`feed.ts=ce798fb7ba81605dd3bff8775a851650`（与变异前逐字节一致） |

---

## 2. 逐项结论与证据

### 项 1 — 门控阈值行为（探针 1：`logs/probe_gate.log`，25/25 通过；原始 JSON `json/probe_gate.json`）

**1a 交易时段（时钟桩到 2026-09-14T02:00Z = 周一 10:00 北京）制造静默：**

| 断言 | 结果 | 原始数值 |
|---|---|---|
| 初始：单条真实 WS 连接 + 状态 open + 订阅帧已发出 | ok | `conns=1, status=open, sent=1（subscribe bar:518880:15m）` |
| 静默 **14s 不得触发** | ok | `conns=1, status=open` |
| 静默 **>15s 必须触发 close 且状态离开 open** | ok | `status=closed`；时间线 `open@1789351200000 → closed@1789351216000`（**+16.0s**，即 `fastForward(14s)` 未触发、`+2s` 触发） |
| 越阈值时尚未重连（退避 1s 未到） | ok | `conns=1` |
| 退避 1s 后自动重连（第 2 条真实连接、状态回 open） | ok | `conns=2, status=open` |
| 重连后重发全部订阅帧 | ok | conn2 framesent：`{"type":"subscribe","topic":"bar","code":"518880","period":"15m"}` |
| **重连后补齐断口**：人为截掉最新 3 根（120→117）后跑一次完整看门狗周期 | ok | 截后 `dataLen=117` → 走 `closed` → 重连 → **恰 1 次 `GET /api/kline?code=518880&period=15m&limit=5`（无 before）** → `dataLen=120`、**`exactRestoreOfL0=true`（数据面与断口前逐根一致）**、`unique=true`、`strictlyIncreasing=true`、末根 ts = 后端最新 `2026-09-14T03:30:00Z` |

> 断口制造方式声明：临时实例连接**只读 DB**，无法写入新 bar，故「断口」由「从数据面截掉最新 3 根」制造（等价于 WS 掉线期间新 bar 未入图），补齐由**真实 HTTP 增量补偿**完成；`GET` 命中真实后端真实最新窗口。

**1b 非交易时段（时钟桩到 2026-09-12T02:00Z = 周六 10:00 北京）：**

| 断言 | 结果 | 原始数值 |
|---|---|---|
| 静默 **15s 内不重连**（15s 口径不适用） | ok | `conns=1, status=open` |
| 静默 **298s 仍不重连** | ok | `conns=1, status=open` |
| **~300s 才自愈**（足以区分门控，而非阈值没到） | ok | `closed@1789178700000`（`open@1789178400000` ⇒ **+300.0s**） |
| 300s 后重连成功 | ok | `conns=2` |
| **不空转**：模拟 1 小时 | ok | 新增重连 **12 次**（≤12+2），即 ≈1 次/5 分钟；对照：若恒定 15s 则为 ~240 次 |
| 非交易时段「分钟兜底」HTTP | ok | **0 次**；窗口内出现的 `limit=5` 请求 **13 次 = 重连次数 13**（全部来自口径 4「重连成功后一次 HTTP 增量补偿」，见 §5 观察项 O-1） |

**1c 真实看板页面（非底座，端到端复现同一结论）：**

| 断言 | 结果 | 原始数值 |
|---|---|---|
| 初始：单条真实 WS 连接 | ok | `conns=1, sent=4`（quote/health/bar/… 四帧订阅） |
| 静默 14s：不重连、顶栏 **不出现**断开 pill | ok | `conns=1, pill=0` |
| 静默 >15s：顶栏出现「**WS 断开，重连中…**」（状态离开 open，不谎报） | ok | `pill=1` |
| 重连后自动重订阅 + 1 次 HTTP 补偿（limit=5、无 before） | ok | conn2 framesent 含 `subscribe`；`compensation=[/api/kline?code=518880&period=15m&limit=5]` |
| 数据面无重复、严格递增、末根 = 后端最新 | ok | `len=120, uniq, strictlyIncreasing, chartLast=gtLast=2026-09-14T03:30:00Z` |
| 无页面异常 | ok | `pageErrors=[]` |

**时间线原始记录**：`json/probe_gate.json → wsEvents`（每条连接的发起时刻 + 收发帧计数）+ `scenarios.T1/T3/A.conns`。

### 项 2 — 任一入站帧复位（探针 1 的 T4，3 轮全绿）

| 轮次 | 注入帧类型 | 13s 注入 | 距注入 14s（累计 27s） | 距注入 16s |
|---|---|---|---|---|
| 1 | `health` | accepted | **status=open, conns=1**（未复位则 27s 早已 close） | **status=closed** |
| 2 | `quote` | accepted | status=open, conns=2 | status=closed |
| 3 | `bar`（同 ts 覆盖） | accepted | status=open, conns=3 | status=closed |

> 注入方式：`window.__H__.inject(msg)` 调用**真实 WebSocket 实例**的 `onmessage({data: JSON.stringify(frame)})`（与仓库既有 e2e `__push` 同口径）。因后端无周期帧（§1 实测），这是唯一可确定化注入真实形状入站帧的手段；帧形状与后端一致（`{type:'health'|'quote'|'bar', …}`）。

### 项 3 — 每分钟兜底 + 幂等合并 + 视口（探针 2：`logs/probe_poll.log`，16/16 通过；`json/probe_poll.json`）

| 断言 | 结果 | 原始数值 |
|---|---|---|
| P1 虚拟 2 分钟 ⇒ **恰 2 次**兜底，`limit=5`、**无 before** | ok | `minute1=[…limit=5]`、`minute2=[…limit=5 ×2]`；初始 = `limit=120` |
| P1 `stats` 前进 | ok | `lastPollOkAt: null → …260000 → …320000`（虚拟时钟 60s 步进，逐字对应）；`pollFailures=0` |
| P2 `document.hidden` ⇒ **0 次** HTTP（虚拟 2 分钟） | ok | `visibilityState=hidden`（浏览器侧桩）；窗口内 `[]` |
| P3 非交易时段（周六）⇒ **0 次** HTTP、无重连 | ok | 窗口内 `[]`；`conns=1` |
| P4 真实 HTTP 兜底重复取回同一根 ⇒ **不重复写入** | ok | `len 120→120`、`rtCount 0→0`（无 emit） |
| P4 同 ts 且 OHLCV 完全一致（WS 重复帧）⇒ **不写、不 emit** | ok | `len=120, rtCount=0` |
| P4 同 ts 值变 ⇒ **原地覆盖** | ok | `len=120, rtCount=1, close 8.911→8.923（= 注入值）` |
| P4 更晚 ts ⇒ **append** | ok | `len=121, rtCount=2, lastTs=注入 ts` |
| P5 宫格合并/限流计数：同一 `(code,period)` **3 图** ⇒ **1 次** HTTP；6 图共 **4 次**（≠6） | ok | 518880 出现 **1 次**；总请求 = `[518880, 161226, 513310, 159915]` ×1；全部 `limit=5`，6 个 pollIncrement 全成功 |
| P5 6 个**不同**标的 ⇒ 6 次（各自 1 次、无重复） | ok | 6 条互异 URL，`results=[true×6]` |
| N1 非跟随态 + 新 bar 到屏外 ⇒ **提示出现** | ok | `hint=1`，`lastBarPx=2035 > 容器宽 1200`，`rtCount 0→1` |
| N1 提示出现时 **视口坐标前后不变** | ok | `vrBefore={from:137,to:252,realFrom:137,realTo:252}` = `vrAfter`（逐字相同） |
| N1 点击提示 ⇒ 跳最新 | ok | `hint 1→0`，`vr={from:226,to:341}`（`chartLen=341` ⇒ 右端 = 最后一根），`lastBarPx=1055`（回到屏内） |
| N2 `followLatest` 态 ⇒ 无提示且跟随最右 | ok | `hint=0`、`rtCount 1→2`、`vr.to=342 ≥ chartLen-2` |
| 无重连、无页面异常 | ok | `conns=1, pageErrors=[]` |

### 项 4 —「有新数据」提示（= 上表 N1/N2，另见 `json/probe_poll.json → scenarios.N1/N2`）

### 项 5 — 回归

| 回归族 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `cd web && npx vitest run` | **63 files / 605 tests 全绿**（exit 0）→ `logs/vitest_final.log` |
| 定向（实时 + DCAP 契约 + ADR-020 视口 + 切周期/标的布局 + 看门狗） | `npx vitest run KlineChart.test.tsx KlineChartSwitchLayout KlineChartDcapSaveLayout dcapWiringP3 dcapWarmupP3 feed feedRealtimePoll feedRealtimeReconnect realtimePoll KlineChart.realtime WsClient.watchdog WsClient barSpaceFit session` | **14 files / 110 tests 全绿**（exit 0）→ `logs/vitest_targeted.log` |
| e2e G16/G18（实时 appendBar/updateBar/标记、15m/1m 双周期） | `E2E_BASE_URL=http://127.0.0.1:18211 npx playwright test kline-matrix.e2e.ts -g "G16|G18" --retries=0` | **2 passed (8.1s)** → `logs/e2e_g16g18.log` |
| e2e ①②③（分割线形态）+ 分页批量族 | `… playwright test dashboard-pane-separator.e2e.ts dashboard-periods-ma.e2e.ts` | ① **✓ passed (5.0s)**（K线\|VOL 之间恰 1 条 klinecharts 分隔线、无骨架残留线）；分页 **T1 周线 ✓ / T3 日线 ✓ / T4 分钟 ✓**；**T2 月线 ✘ / T5 MA 配置 ✘** → `logs/e2e_regress.log` |
| T2/T5 差分判定（是否本次改动引入） | 同一命令打 **HEAD 基线实例（18213，worktree 6391a4d + 只读 DB）** | **同样 2 failed，报错逐字相同**：T2 `每个 forward 请求 limit=80 且响应 80 根: [{"limit":80,"n":39,"before":"2016-09-30T16:00:00Z"}]`；T5 `PUT /api/config/ma` 收到 **500**（实例日志同刻 `cannot execute INSERT in a read-only transaction`）→ `logs/e2e_regress_BASE_HEAD.log` |
| 结论 | — | T2 依赖月线历史覆盖、T5 依赖可写 DB，**在 HEAD 基线上同样红 ⇒ 与本次改动无关**（环境/既有）。① 与 G16/G18、DCAP 契约、ADR-020、overlay 均绿 |

### 项 6 — 反向证据（`logs/reverse.log`；变异仅测试侧、已还原）

| 变异 | 目标断言（必须红） | 变异后 | 对照断言（同轮必须仍绿） | 还原后 |
|---|---|---|---|---|
| A：`silenceThresholdMs()` 恒 15s（拆门控） | 非交易时段静默 20s 不得重连 ⇒ **FAIL**：`{"status":"closed","conns":1}` | 1/2 passed | 交易时段静默 16s 必须离开 open ⇒ **ok** | 副本回填 + `md5=044b6b44…` 一致；重跑 **2/2 绿** |
| B：`applyRealtime` 去掉 `sameBarValues` 早返回（同 ts 一律覆盖） | 同 ts 同值不写不 emit ⇒ **FAIL**：`rtCount 0→1`（重复上行/重复渲染） | 1/2 passed | 同 ts 值变必须覆盖 ⇒ **ok** | 副本回填 + `md5=ce798fb7…` 一致；重跑 **2/2 绿** |

### 项 7 — 门禁与卫生

| 检查 | 结果 |
|---|---|
| `./scripts/check-tangle.sh` | **exit=0**：`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` |
| `cd web && npx tsc -b` | **exit=0**（无输出） |
| `cd web && npx vitest run` | **63 files / 605 tests 绿**（exit 0） |
| `git diff --cached` | **空**（无暂存文件） |
| tracked 改动清单 | `design/06-web/01-dashboard.md`（1 处散文条款等长替换）、`web/src/ws/WsClient.ts`、`web/src/features/dashboard/feed.ts`、`web/src/features/dashboard/KlineChart.tsx`、`web/e2e/kline-matrix.e2e.ts` —— **仅前端 + 1 处散文**；`git diff design/06-web/01-dashboard.md \| grep -E '^[-+].*file='` → **NONE（`file=` 代码块零触碰）**；`crates/`、`dcap.ts`、`config/`、ABI/引擎/ExecutionPolicy **零改动** |
| 临时实例/端口 | 实例 A（18211/18212）、实例 B（18213/18214）已 kill；`ss` 确认 **1821[0-9] 全部释放**；HEAD worktree 已 `git worktree remove`（`git worktree list` 无 `/tmp/acc_rec/base`）；临时底座 `web/__acc_harness__/` 已从仓库删除（副本存证据目录） |
| 线上 PID 未被触碰 | `ps -o pid,lstart -p 2948632` → **`Mon Sep 14 10:00:45 2026`（与开工基线一致）**，仍是 `--config /tmp/app_dev_8081.toml`；8081/8082 监听未变 |
| 线上配置逐字节一致 | `/tmp/app_dev_8081.toml` md5 = **6fcb509f41b9d128da24153079b2964d（同基线）**；`web/dist/index.html` = `f09dd2a7…`、`assets/index-CBm_5q76.js` = `7f312b28…`、`assets/index-LiEzF-e0.css` = `cdb88f51…`（**同基线**，未重编线上产物） |
| 无线上写请求（nonGetOther） | 本次对线上的全部交互 = **开局的 1 次 `GET /healthz`（只读）**；探针面向 18211/18213，日志中记录的全部 `/api/kline` 请求 **method 均为 GET**（`json/probe_gate.json → scenarios.T2.compensationRequests[].method = GET`）；两个临时实例日志中**唯一**出现的写尝试是 e2e `PUT /api/config/ma`，被**只读事务拒绝**（`cannot execute INSERT in a read-only transaction`，HTTP 500）⇒ **无任何写入落地** |
| 崩溃/core dump | 无（探针 `pageErrors=[]`、e2e 无崩溃；未见 core 文件） |

### 项 8 — 明确不做

- 未重启/未触碰线上实例（8081/8082, PID 2948632）；
- 未评价 dcap 信息量（不在本轮范围）；
- 未在估值器/魔法数上做任何调参探索；
- 未做任何修复性改动（失败项只记录、不归因、不修）。

---

## 3. 失败项清单（**只记录，不归因**）

| 用例 | 报错（原文节选） | 崩溃/core | 基线对照（HEAD 6391a4d 实例 18213） |
|---|---|---|---|
| `dashboard-periods-ma.e2e.ts:435 T2 月线：深翻至覆盖 2022-2023` | `Error: 每个 forward 请求 limit=80 且响应 80 根（非 2）: [{"limit":80,"n":39,"before":"2016-09-30T16:00:00Z"}]`；`expect(out.allForwardBatch).toBeTruthy()` Received false | 无 | **同样失败、报错逐字相同** |
| `dashboard-periods-ma.e2e.ts:505 T5 MA 配置：…非法零 PUT/恢复默认` | `Error: PUT /api/config/ma 200` → `expect(received).toBe(expected)`；Received **500** | 无 | **同样失败、报错逐字相同**（基线实例同样只读 DB，同刻日志：`cannot execute INSERT in a read-only transaction`） |

> 本轮**无**任何由被测实时改动引入的红；vitest 全量 605 无失败；无崩溃、无 core dump。

---

## 4. 观察项（非阻断，仅记录 + 最小建议，不实施）

- **O-1（口径边界，建议架构师裁决）**：非交易时段「重连后一次 HTTP 增量补偿」（口径 4）**不受**交易时段/可见性门控 —— 实测周六模拟 1 小时：分钟兜底 **0 次**，但 `limit=5` 请求 **13 次 = 重连次数**（≈1 次/5 分钟）。若把任务项 3「非交易时段 0 次 HTTP」按**字面全量**解读，则这里是唯一不符点；按设计条款 5「仅 `trading` 才发兜底请求…0 次 HTTP」的语境（指分钟兜底）则相符。
  **最小修正建议（1 处、如需）**：`feed.ts` 的 `onStatusChange('open')` 分支在 `pollIncrement('poll')` 前加与 `shouldPollNow()` 同源的判定（或抽出 `realtimeFetchAllowed()` 复用），即非交易时段/`document.hidden` 时不发补偿请求。**本轮未实施**（属扩大范围）。
- **O-2（既有遗留，非本轮产物）**：临时实例 `PID 3013641`（`--config /tmp/rt055/app.toml`，监听 `127.0.0.1:18111/18112`，静态目录 `./web/dist`，只读 DB）仍在运行——非本阶段创建、非线上实例，**未处置**，请架构师决定是否回收。

---

## 5. 最小修正建议汇总

1. **O-1**：如要求非交易时段/隐藏页**零 HTTP**，在重连补偿路径补一次与 `shouldPollNow()` 同源的门控（1 处、1 条件，不引入新常量）；否则建议在 `design/06-web/01-dashboard.md` 口径 5 明确「0 次 HTTP 指分钟兜底，重连补偿例外」。
2. **非本轮范围**：`dashboard-periods-ma.e2e.ts` T2（月线深翻依赖历史覆盖）与 T5（PUT 配置依赖可写库）需在**可写 / 数据完整**的验收环境运行；建议在可写实例上复跑以取得确定结论（本轮受「只读 DB」纪律限制，已在 HEAD 基线证明两者与本次改动无关）。

---

## 6. 原始证据索引

| 路径 | 内容 |
|---|---|
| `tester/evidence/058_realtime_gate_acceptance/logs/probe_gate.log` | 探针 1 逐条断言 + 数值（25/25） |
| `tester/evidence/058_realtime_gate_acceptance/logs/probe_poll.log` | 探针 2 逐条断言 + 数值（16/16） |
| `tester/evidence/058_realtime_gate_acceptance/logs/reverse.log` | 反向证据四轮（PRISTINE / MUTANT-A / MUTANT-B / AFTER-RESTORE） |
| `tester/evidence/058_realtime_gate_acceptance/json/probe_gate.json` | WS 连接时间线、每连接收发帧计数、断口补齐前后数据面、补偿请求、真实看板端到端数值 |
| `tester/evidence/058_realtime_gate_acceptance/json/probe_poll.json` | 分钟节拍、hidden/非交易时段 0 HTTP、幂等合并三态、合并计数、视口与提示数值 |
| `tester/evidence/058_realtime_gate_acceptance/logs/ws_observe_lunch.log` | 通道活性实测（burst 后 23s 0 帧） |
| `tester/evidence/058_realtime_gate_acceptance/logs/{vitest_final,vitest_targeted,tsc_b,check_tangle,e2e_g16g18,e2e_regress,e2e_regress_BASE_HEAD}.log` | 门禁与回归原始输出 |
| `tester/evidence/058_realtime_gate_acceptance/probes/` | `probe_gate.mjs` / `probe_poll.mjs` / `probe_mutant.mjs` / `vite.acc.config.ts` / `kc-spy.ts`（自建，跑完即从仓库移除） |
| `tester/evidence/058_realtime_gate_acceptance/harness/` | 观测底座 `main.tsx` / `index.html` 副本 |
| `tester/evidence/058_realtime_gate_acceptance/json/{online_baseline,md5_impl_pristine}.txt` | 线上基线与产品代码 md5（变异前后比对） |

---

**VERDICT: PASS**
