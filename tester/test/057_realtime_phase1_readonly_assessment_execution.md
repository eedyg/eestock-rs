# 057 — 阶段 1 只读状态评估：实时修复车道半成品 + 活性通道事实核实（执行/观测报告）

- **本文件自身路径（self-location）**：`tester/test/057_realtime_phase1_readonly_assessment_execution.md`
- **报告层级**：执行/观测报告（**只执行、只观测**：跑既有测试 + 读 diff + 临时实例实测；未设计新测试、未改任何产品代码、不进入失败分支、不做失败归因）
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **HEAD**：`6391a4d`（`docs(report): 切 period/stock 布局重置 …`）；分支 `master`
- **观测时间**：2026-09-14 11:07–11:24（Asia/Shanghai；UTC 03:07–03:24），盘中（上午 09:30–11:30 交易时段）
- **证据目录**：`tester/evidence/057/phase1/`
- **纪律（见 §6）**：未改任何仓库跟踪文件；未 `git add/commit/stash`；未重启/触碰线上 PID `2948632`（8081/8082）；未向线上发任何请求（含 GET）；临时实例只连**只读 DB** + 本地端口，观测完已关闭。

---

## 0. 结论速览（TL;DR）

| 项 | 结论 |
|---|---|
| 1 基线 | **全绿**：`npx vitest run` = **63 文件 / 604 用例 全通过**（exit 0）；`npx tsc -b` = exit 0。原 14 条红测试**现全部转绿**（**不是**「一部分绿、其余仍红」）。 |
| 2 半成品可读性 | 自适应静默估值器**对当前 app 基本不起作用**（`AppShell` 恒订阅 `source_health`，盘中健康帧 ≈ 每 3.4s 一张 ⇒ 15s 基线几乎永不触发）。它只在「长时间无帧」时行为不同；**可用 2 行等价规则替换**。存在 **1.5×/2.5× 文档与代码不一致**，且「真半开」时自愈被自身样本逐步拉长到 ≤300s（与 R1 快速自愈目标相冲）。 |
| 3 活性通道 | 入站帧**纯数据驱动、无协议级心跳**：health ≈ 3.4s 节奏（采集活跃时）、quote 突发、bar 按数据推进（1m 约 1/min 且会跳标签；15m 仅每 15min 边界一张）。**只订阅 bar 的 300s 窗口内 15m = 0 帧（实测）**。观测到一段 **~4 分钟发布停摆**（03:12:01–03:16:06，DB 写入持续）。 |
| 4 回归 | 临时端口上 **G16/G18 = 2/2 绿**；修复①e2e（pane 分隔线）**1/1 绿**；①②③ 相关单测在 §1 全量跑中**全绿**。 |
| 5 改动面 | 5 tracked 文件（web + design 文档）+ 6 个 untracked（1 源文件 + 5 测试文件）——**全部前端/文档**；`crates/`、`dcap.ts`、`config/`、`design/14-dcap-indicator`、暂存区**均未触碰**。可保留：e2e 时间炸弹修复、`isOffViewport`+「有新数据」、启动竞态缓冲、`pollIncrement`/`applyRealtime` 幂等。待替换：WsClient 自适应估值器。 |

**末行 VERDICT：见报告末尾。**

---

## 1. 基线状态（文件/用例总数 + 失败清单 + 14 条新测试逐条现状）

### 1.1 命令与结果

| # | 命令（工作目录 `web/`） | 结果 | 证据 |
|---|---|---|---|
| 1 | `npx vitest run --reporter=basic` | **63 文件 / 604 用例，全通过，exit 0**（0 失败 / 0 跳过） | `vitest_full.log` |
| 2 | `npx tsc -b` | **exit 0，无输出**（0 类型错误） | `tsc_b.log`（0 字节） |
| 3 | `npx vitest run <5 个新测试文件> --reporter=verbose` | **5 文件 / 27 用例，全通过，exit 0** | `vitest_newfiles_verbose.log` |

原始末行：
```
# vitest_full.log
 Test Files  63 passed (63)
      Tests  604 passed (604)
   Duration  5.24s
# tsc_b.log: (空)  TSC_EXIT=0
# vitest_newfiles_verbose.log
 Test Files  5 passed (5)
      Tests  27 passed (27)
```

**失败清单：空（本基线无任何失败用例）。**

### 1.2 关键更正：14 条红测试现状 = **全部转绿**

对照 `tester/test/055_realtime_append_red_execution.md` §2 记录的 14 条红用例，逐条当前状态（本轮实测）：

| # | 用例（055 记录为红） | 现状 |
|---|---|---|
| 1 | T-R1-a 静默达阈值 → 主动 close()+退避重连 | ✅ 绿 |
| 2 | T-R1-b 半开连接（无 onclose）仍须重连 | ✅ 绿 |
| 3 | T-R1-c 持续入站帧不得误触发（阈值以最近帧为基准） | ✅ 绿 |
| 4 | T-R1-d 自愈后必须一次 HTTP 补偿（最新窗口/无 before） | ✅ 绿 |
| 5 | T-R2-a 断线错过 3 根 → 重连补齐（无空洞/无重复） | ✅ 绿 |
| 6 | T-R3-a 每 60s 恰一次（limit 3~5、无 before） | ✅ 绿 |
| 7 | T-R3-a2 合并语义 append/覆盖/忽略 | ✅ 绿 |
| 8 | T-R3-b 与 WS 不重复写入（同 ts） | ✅ 绿 |
| 9 | T-R3-d2 不可见暂停 → 可见恢复 | ✅ 绿 |
| 10 | T-R3-e1 失败退避 1→2→4→8→60s | ✅ 绿 |
| 11 | T-R4-a 注册前 bar 须缓冲补投 | ✅ 绿 |
| 12 | T-R3-c2 manualAdjusted 时不得滚动 | ✅ 绿 |
| 13 | T-R5-a 视口外新 bar 提示且不滚动 | ✅ 绿 |
| 14 | T-R5-b 点击提示跳最新 | ✅ 绿 |

7 条原「守卫型（本就绿、修后须仍绿）」用例同样全部仍绿：T-R2-b、T-R3-d、T-R3-e2、T-R3-c1、T-R4-b、T-R5-c、T-R5-d。

结论：那半成品实现在 30 分钟超时前**功能上把 14/14 条口径全部兑现**（并在超时前后又补了 6 条测试），只是没来得及提交/写报告。

### 1.3 半成品额外新增的测试（6 条，原 055 记录之外）

| 用例 | 文件 | 说明 |
|---|---|---|
| T-R1-e1 零帧静默：阈值 15→37.5→93.75→234.375→300s 升级 | `web/src/ws/WsClient.watchdog.test.ts` | 锁住自适应估值器几何序列（**过度设计自身**的测试） |
| T-R1-e2 慢节奏（20s 间隔）不得误杀：阈值随节奏放大到 50s | 同上 | 同上 |
| T-R1-f 订阅时 WS 已 open ⇒ 首次重连必须补偿 | 同上 | 补偿接线边界 |
| realtimePoll 合并/限流 ×3 | `web/src/features/dashboard/realtimePoll.test.ts` | 新增 `realtimePoll.ts` 的用例 |

> 数量核对：055 全量 = 62 文件 / 598 用例；本轮 = 63 文件 / 604 用例 ⇒ **+1 文件 / +6 用例**，与「5 个新测试文件中的 watchdog 由 4→7 用例（+3）+ 新增 realtimePoll.test.ts（+1 文件/+3）」一致。

---

## 2. 半成品可读性评估：WsClient「入站静默阈值自适应估值器」

被评对象（`web/src/ws/WsClient.ts` diff，+140/−5）：`silenceThresholdMs()` =
`clamp(max(15s, 2.5 × cadenceEstimate, 15s × 2^silentStreak), 15s, 300s)`，
其中 `cadenceEstimate` = 最近 **5** 个「≥15s 的帧间隔 / 静默时长 / 连接建立→首帧」样本的**最大值**，单样本封顶 **200s**；`silentStreak` = 连续零帧静默次数（任入站帧复位）；静默到点还会把「本次静默时长」也并入样本。

### 2.1 是否必要？——对**当前 app** 基本不必要

- **事实（代码）**：`src/AppShell.tsx`（根路由 element）在挂载时 `ws.connect()` 且恒 `ws.subscribe('source_health', …)`；`features/dashboard/store.ts` 恒订阅 `quote`。所以真实 app 的入站流**永远包含 health/quote**。
- **事实（实测，§3）**：采集活跃期 health 帧 ≈ **每 3.4s** 一张，quote 突发同拍；bar 帧约 1/min。
- **推论**：正常运行时「自最近一次入站帧起算」的静默**几乎不可能达到 15s** ⇒ 阈值恒为 15s 基线，**自适应分支不被触发**。估值器只在「真的没帧」（半开 / 断网 / 长时间无数据）时才改变行为。
- 该估值器的现实价值只在**「只订阅 bar 的慢节奏会话」**（1 帧/分钟）下成立——而那**不是当前 app 的订阅形态**（§3(c) 实测 health/quote 更密）。

### 2.2 是否有更简单的等价规则？——有（建议替换）

观察到的等价行为其实就是「活跃期 15s、无数据期拉长」。两种 ~2 行等价规则即可覆盖，且无需样本/几何升级：

- **规则 A（交易时段门控）**：`threshold = tradingSession(new Date()) === 'trading' ? 15_000 : 300_000`。
  `feed.ts` 已经 `import { tradingSession } from '@/shell/session'`，后端推送本身就是「盘中 data-driven、盘后近乎静默」，与交易时段强相关。
- **规则 B（首帧门控 / 空闲门控）**：「本连接已收到过 ≥1 张帧之前不武装看门狗（或用 300s 长窗）；有帧后固定 15s」。彻底消除「盘后无数据却每 15s 重连」的空转，不引入任何估值。

两条都比现方案少 4 个常量 + 3 个字段 + 2 个方法，行为可观测、可单测（1 条边界用例即可覆盖），无「样本窗口/封顶/几何升级」这类隐性耦合。

### 2.3 判断与理由（可观测性 / 可测性代价）

1. **自愈被自身拉长（与 R1 目标相冲）**：真半开连接持续无帧 ⇒ `silentStreak` 递增且「静默时长」作为样本 ×2.5 反哺估值 ⇒ 有效阈值 15→37.5→93.75→234.375→300s（T-R1-e1 正是把这个序列**钉死为期望**）。即「连接真的死了」时，自愈延迟反而从 15s 退化到最长 **300s（5 分钟）**；顶栏 pill/quote/health 最长停滞 5 分钟（bar 有 60s HTTP 兜底，其余没有）。这与 R1「快速自愈、pill 不撒谎」的初衷存在张力。
2. **文档/代码不一致（可读性缺陷，非功能 bug）**：实际常量 `SILENCE_CADENCE_MULTIPLIER = 2.5`（`WsClient.ts:43`），文件头注释亦写 2.5；但
   - 同文件 `silenceThresholdMs()` 的**方法 docstring 写「1.5 ×」**（`WsClient.ts:172`）；
   - 权威设计 `design/06-web/01-dashboard.md:345` 也写「× 1.5」；
   - 测试文件 `WsClient.watchdog.test.ts:246` 注释写 1.5，而**断言逻辑是 2.5**（`:298`/`:303`）。
   同一阈值在 4 处有两种系数，评审/维护成本高。
3. **可观测性代价**：新增 4 个模块级常量（15s/300s/2.5/15s/200s/窗口5）＋ 3 个实例字段（`silentStreak`/`inboundSamples`/`lastInboundAt+openedAt`）＋ 2 个方法（`recordInboundSample`/`cadenceEstimateMs`），但**没有任何可观测面**导出当前估值/阈值（`realtimeStats` 只覆盖 feed，不覆盖 WS）。排障时无法从外部看出「此刻阈值是多少、为什么」。
4. **测试脆弱性**：`T-R1-e1` 把几何序列（含 200s 单样本封顶与 300s 上限的交叠）逐项写死，任何调参都要改测试；`T-R1-e2` 需要精确构造「20s 帧间隔 ⇒ 2.5×20=50s」。

**建议**：保留「15s 基线 + 长静默期不空转」的目标，删掉估值器，改用 §2.2 规则 A 或 B。（本条只给判断，不改代码。）

---

## 3. 活性通道事实核实（临时实例实测，≥300s）

### 3.1 装置（只读、隔离）

- 临时实例：`./target/debug/eestock-app --config tester/evidence/057/phase1/temp_app.toml`，`listen=127.0.0.1:18099`、`mcp=127.0.0.1:18098`，`static_dir=./web/dist`，`ws_poll_ms=3000`。
- **只读 DB**：`database_url=…?options=-c%20default_transaction_read_only%3Don`。已证真只读：启动后 `web::alerts` 多次 `cannot execute INSERT/UPDATE in a read-only transaction`（只读事务拦截生效，`temp_app.log`）。
- 探针：`tester/evidence/057/phase1/ws_probe.mjs`（Node 22 内建 WebSocket），订阅 `bar:518880:1m`、`bar:518880:15m`、`quote`、`health`，逐帧记录墙钟/相对时间/类型/bar.ts。

### 3.2 三段观测（原始）

| 观测 | 窗口（UTC） | 时长 | 订阅 | 结果 |
|---|---|---|---|---|
| smoke | 03:10:04–03:10:24 | 20s | 全 | bar:1m 2；bar:15m 1；quote 62；health 6（间隔 3.4s） |
| **obs1** | 03:10:36–03:16:06 | **330s** | 全 | bar:1m 1；**bar:15m 0**；quote 45；health 11 |
| probe_now | 03:16:48–03:17:13 | 25s | 全 | bar:1m 1；bar:15m 1；quote 58；health 5 |
| **obs2** | 03:17:30–03:22:30 | **300s** | **仅 bar** | bar:1m 5；**bar:15m 0** |

**DB 侧同期写入（只读查询）**：`source_health_events` 每分钟 ~45 行（03:09–03:17 持续）；`kline_raw` 每分钟 ~44 行（每标的 1 行，对齐整分）；`kline_accurate`（cagg）停留在 **2026-09-11 07:00Z**（未推进）。

**原始时间线（关键片段）**：

- obs2（仅 bar，300s）——1m 帧：
  ```
  03:17:32.568 rel=2.332  bar_ts=03:18 close=8.908   （领先墙钟 ~27s）
  03:18:26.994 rel=56.758 bar_ts=03:19 close=8.909
  03:20:09.516 rel=159.280 bar_ts=03:20 close=8.911   ← 间隔 102.5s，且 ts=03:21 缺失（跳标签）
  03:21:27.757 rel=237.521 bar_ts=03:22 close=8.910
  03:22:18.810 rel=288.574 bar_ts=03:23 close=8.910
  ⇒ bar:15m 计数 = 0（300s 内无 15m 桶边界；上一桶 03:15、下一桶 03:30）
  ```
- obs1（全订阅，330s）——health 到达时刻：
  ```
  03:10:39.375, 03:11:00.403（+21.0s）, 03:11:03.833, 03:11:07.259, 03:11:10.705,
  03:11:14.120, 03:11:17.541, 03:11:20.971, 03:11:24.394, 03:11:27.811（+3.4s 节奏）,
  03:12:01.851（+34.0s）…… 之后至 03:16:06 **零帧**
  ⇒ 03:12:01–03:16:06 约 **4 分钟入站发布停摆**，而 DB 写入持续（health/raw 每分钟 ~45/44 行）。
  ```
- obs1——quote 突发：03:10:39(n=4)、03:11:00(n=1)、03:11:03(n=6)、03:11:07(n=5)、03:11:10(n=6)、03:11:14(n=5)、03:11:17(n=6)、03:11:20(n=3)、03:11:24(n=4)、03:11:27(n=3)、03:12:01(n=2)，此后停。
- probe_now——15m 帧：`03:16:49.983 rel=1.104 bar_ts=03:15`（即 11:15 北京桶在 15 分钟边界后首次推出）；health 间隔 [10.27s, 3.42s, 3.67s, 3.42s]。

### 3.3 回答

**(a) 是否存在周期性帧（任何类型）？**
**无严格协议级周期帧**：服务端 `ws.rs::Poller` 每 ~3s 轮询库，但**只在数据 ts 前进时发布**（bar/quote/health 各有内存游标去重），且订阅前 `matches` 过滤。实测：
- health 在采集活跃期呈 **~3.4s** 的近周期（= poll 拍），但会被 21s / 34s 的更长间隔打断；
- quote 呈**每 poll 拍一次的突发**（一次多标的）；
- bar 完全由数据推进决定。
⇒ 只能说「采集活跃时 health/quote 有 ~3s 的近似节拍」，**不存在**与数据无关的固定心跳帧；并且实测到 **~4 分钟完全无帧**的发布停摆。

**(b) 只订阅 bar，300s 内 15m 周期是否可能零帧？**
**是，实测为 0 帧**（obs2：03:17:30–03:22:30，仅 bar，`bar:15m` 计数 0）。15m bar 只在每 15 分钟桶边界随数据推进推出一次（probe_now 在边界后推出 `bar_ts=03:15` 各 1 张），任何**不含 15m 边界的 300s 窗口 ⇒ 0 帧**。1m 在同一窗口内也只有 5 帧（且因采集「行标签领先墙钟 + 跳标签」出现 102.5s 的长间隔与 ts=03:21 缺失）。

**(c) 同时订阅 health/quote，是否有更密的帧？**
**是，明显更密**：obs1/`probe_now` 中 health ≈ 每 3.4s、quote ≈ 每 poll 拍一张且每拍多标的（25s 内 58 张 quote / 5 张 health）。相对「仅 bar（约 1/min）」是 15–20 倍量级的帧密度。**注意**：这只在采集活跃期成立；本文观测到一段 4 分钟彻底无帧的窗口说明「更密」并非 SLA。

---

## 4. 回归现状

| 用例 | 位置 | 目标 | 结果 |
|---|---|---|---|
| **G16** WS 新 bar appendBar + 同 ts updateBar + 虚线标记 | `web/e2e/kline-matrix.e2e.ts` | 临时端口 18099 | ✅ **passed (4.3s)** |
| **G18** 实时叠加在 15m/1m 都生效 | 同上 | 临时端口 18099 | ✅ **passed (4.1s)** |
| 修复①pane 分隔线（当前必红→已修） | `web/e2e/dashboard-pane-separator.e2e.ts` | 临时端口 18099 | ✅ **1 passed (5.0s)** |

命令（`--retries=0`）：
```
E2E_BASE_URL=http://127.0.0.1:18099 npx playwright test kline-matrix.e2e.ts -g "G16|G18"
  → 2 passed (8.7s)          [e2e_g16_g18_tempport.log]
E2E_BASE_URL=http://127.0.0.1:18099 npx playwright test dashboard-pane-separator.e2e.ts
  → 1 passed (5.3s)          [e2e_pane_separator_tempport.log]
```
> 说明：临时实例 `static_dir=./web/dist`，而 `web/dist` 已被那半成品在 11:06 **重建**（见 §5.4），故上述 e2e 跑的是**半成品前端**；G16/G18 仍绿说明「时间炸弹修复 + 相对时间戳 + bar 流隔离」在临时端口可重复通过（与 055 报告在线上 8081 的 2/2 一致）。

**①②③ 三项已上线修复的相关用例**（对应 `181c35a`／`7949c0b`／`5d8eff4`，见 `coder/report/164_*`）：
- ① 分割线+0线 → e2e `dashboard-pane-separator.e2e.ts` ✅（上表）；
- ② 保存参数不重建 pane → 单测 `KlineChartDcapSaveLayout.test.tsx`（7 用例）✅（§1 全量跑内通过）；
- ③ 切 period/stock 不重置布局 → 单测 `KlineChartSwitchLayout.test.tsx`（3 用例）✅（§1 全量跑内通过）。
⇒ 三项相关用例**均仍绿**，且 604 用例全量无附带破坏。

---

## 5. 改动面与风险清单（半成品 diff 摘要，逐文件）

`git diff --stat`（tracked）：5 文件，**+543/−45**；untracked：6 文件（1 源 + 5 测试）。

### 5.1 逐文件摘要

| 文件 | 变更 | 摘要 | 归类 |
|---|---|---|---|
| `web/src/ws/WsClient.ts` | +140/−5 | 新增入站静默看门狗 + **自适应阈值估值器**（15s/300s/2.5×/200s 封顶/5 样本/几何升级）＋ `handleDisconnect` 幂等化 ＋ `onclose` 迟到事件忽略（`this.socket!==sock` 早退）。 | ⚠️ **待替换**（估值器）；✅ 可保留（看门狗骨架、断线幂等、迟到 close 忽略） |
| `web/src/features/dashboard/feed.ts` | +149/−4 | 每分钟兜底轮询（自 re-arm、60s/失败退避 1→2→4→8→60s、交易时段+可见性门控）＋ WS 重连补偿接线（`onStatusChange`、`wsEverOpen` 去首连）＋ `applyRealtime(bar, source)` 幂等（同 ts 同 OHLCV 不写不 emit）＋ `realtimeStats` 可观测面。 | ✅ **大体可保留**（口径①②③④）；注意 `onStatusChange` 依赖 |
| `web/src/features/dashboard/realtimePoll.ts`（新，76 行） | 新增 | 兜底取数合并（同 `(code,period)` 在途共享 Promise）+ 全局并发上限 3。 | ✅ 可保留（有 `resetRealtimePollGateForTest` 测试钩子） |
| `web/src/features/dashboard/KlineChart.tsx` | +73/−14 | `isOffViewport()` 视口判定；`rtBuffer`（≤300）启动竞态缓冲 + `subscribeBar` 冲刷；滚动门控统一 `followLatest && !manualAdjusted`；「有新数据」提示按钮（`[data-testid="kline-new-data-hint"]`，点击才 `scrollToRealTime`）；`programmaticScroll` 改为 try/finally 同步复位。 | ✅ **可保留** |
| `web/e2e/kline-matrix.e2e.ts` | +163/−22 | **时间炸弹修复**：`latestBarTs()`/`nextTs()` 相对时间戳、`__isolateBarStream` 只丢真实 bar 帧、`__sent`+`waitSubscribed` 确定性等待、`pushBarExpectMarker`。 | ✅✅ **明确可保留的好工作** |
| `design/06-web/01-dashboard.md` | +18 | 新增「补定稿（2026-09-14）：实时更新口径」10 条。 | ⚠️ 文档含 1.5× 与代码不符（§2.3-2） |
| 5 个测试文件（untracked） | 1290 行 | `WsClient.watchdog.test.ts`(359)、`feedRealtimePoll.test.ts`(316)、`feedRealtimeReconnect.test.ts`(151)、`KlineChart.realtime.test.tsx`(267)、`realtimePoll.test.ts`(121)。 | ✅ 可保留；`T-R1-e*` 属估值器专用，随估值器一起处置 |

### 5.2 可保留的好工作（明确）

1. **e2e 时间炸弹修复**（`kline-matrix.e2e.ts`）：相对时间戳 + `__isolateBarStream` + `waitSubscribed` 确定性等待——把「硬编码 `2026-09-04` 的必红」变可重复绿（本报告 §4 复证）。
2. **`isOffViewport` + 「有新数据」提示 + 滚动门控 `followLatest && !manualAdjusted`**（口径①，KlineChart）。
3. **启动竞态缓冲 `rtBuffer`**（口径 T-R4，不静默丢 bar）。
4. **`applyRealtime` 幂等合并（同 ts 同 OHLCV 不写不 emit）+ `pollIncrement` 复用同一通路**（口径②）。
5. **兜底轮询自 re-arm + 退避 + 非交易/隐藏跳过 + `realtimeStats`**（口径③④）。
6. **WsClient 的断线处理幂等化**（`handleDisconnect`）与 `onclose` 迟到事件忽略——与估值器解耦，可独立保留。

### 5.3 待替换的过度设计（明确）

- `WsClient` 自适应阈值估值器（`silenceThresholdMs`/`recordInboundSample`/`cadenceEstimateMs` + 4 常量 + `silentStreak`/`inboundSamples`）；建议替换为 §2.2 的 2 行等价规则。连带 `T-R1-e1/e2` 两条测试。
- 文档 `design/06-web/01-dashboard.md` 第 7 条的「× 1.5」与代码 2.5 需统一（并补 `silenceThresholdMs` docstring 的 1.5）。

### 5.4 需要 parent 注意的旁路事实（非代码改动）

- **`web/dist` 已被半成品在 11:06 重建**（`index-CBm_5q76.js`，含 `有新数据` / `kline-new-data-hint` 标记）。线上 `2948632` 的 `static_dir=./web/dist`（相对仓库根，见 `coder/report/164` §6.1）⇒ **线上前端此刻已在服务这份半成品 bundle**（静态文件按请求实时读盘）。这不是本次任务要改的东西，但属「半成品已部分触达线上」的事实，请 parent 裁决是否回滚/重建 dist。
- **疑似半成品遗留的临时实例**：PID `3013641`（`--config /tmp/rt055/app.toml`，`listen=127.0.0.1:18111`，10:44 启动）仍在运行（只读 DB）。非本次任务产物，**未处置**，请 parent 决定是否清理。
- **观测到的 WS 发布停摆**（§3.2，03:12:01–03:16:06 无帧而 DB 持续写）——仅记录原始事实，**未做归因**（超出 tester 角色）。

### 5.5 未触碰确认（命令 + 空输出）

```
$ git diff --stat -- crates/           → (空)   # ABI/引擎/ExecutionPolicy 所在 Rust 层
$ git diff --stat -- web/src/features/indicators/dcap.ts → (空)
$ git diff --stat -- config/           → (空)
$ git diff --stat -- design/14-dcap-indicator/ → (空)   # dcap 文档 file= 代码块未碰
$ git diff -- web/src | grep -iE "abi|executionpolicy|engine" → (空)
$ git diff --cached --name-only        → (空)   # 暂存区为空
$ git diff --name-only → design/06-web/01-dashboard.md, web/e2e/kline-matrix.e2e.ts,
                          web/src/features/dashboard/KlineChart.tsx,
                          web/src/features/dashboard/feed.ts, web/src/ws/WsClient.ts
```
⇒ **未触碰 ABI / 引擎 / ExecutionPolicy / `dcap.ts` / 线上配置 / dcap 设计文档代码块 / 暂存区。**

---

## 6. 纪律确认

- 本任务**只评估**：未改任何仓库跟踪文件、未 `git add/commit/stash`、未改产品代码/接口/架构、未进入失败分支、未做失败归因。
- **未重启线上**：PID `2948632`（8081/8082）全程存活（`ps` 复证 `ELAPSED 01:22:33`，监听 8081/8082 仍在）。
- **未向线上发任何请求**（含 GET）：全部观测只连 `127.0.0.1:18099`（临时实例）与 `127.0.0.1:5433`（只读 DB）。
- 临时实例已**关闭**（18099/18098 已无监听）；临时配置/日志/探针/JSON 均落在 `tester/evidence/057/phase1/`。
- 本人新增文件仅 `tester/test/057_*.md` 与 `tester/evidence/057/**`。

---

## 7. 证据索引（`tester/evidence/057/phase1/`）

| 文件 | 内容 |
|---|---|
| `vitest_full.log` | 全量单测：63 文件 / 604 用例 全绿 |
| `vitest_newfiles_verbose.log` | 5 个新测试文件逐用例（27/27 绿） |
| `tsc_b.log` | `npx tsc -b` 空输出（0 字节，exit 0） |
| `e2e_g16_g18_tempport.log` | 临时端口 G16/G18 = 2 passed |
| `e2e_pane_separator_tempport.log` | 临时端口 pane 分隔线 = 1 passed |
| `temp_app.toml` / `temp_app.log` | 临时实例只读配置 + 启动日志（含只读事务拦截证据） |
| `ws_probe.mjs` | WebSocket 探针脚本 |
| `smoke.json` / `obs1_all.json` / `obs2_bar_only.json` / `probe_now.json` | 各段逐帧原始记录（含 `frames`/`summary`/`gaps`） |
| `e2e/artifacts/`（Playwright 产物目录，若生成） | e2e trace/截图（仅失败时） |

---

VERDICT: ASSESSED
