# K 线看板「实时数据不更新（需刷新/切换）」只读诊断报告

- 报告文件自身路径：`tester/report/055_kline_realtime_bar_append_diagnosis.md`
- 证据目录：`tester/evidence/055/`（原始日志/脚本；`/tmp/kl_diag/` 为运行期临时目录，收尾已拆）
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
- 起点：HEAD = `ece1d9d` + 工作树**未提交**的「切 period/stock 不重置布局」改动（本报告只读，未碰）
- 取证期间该车道已提交（HEAD 前进到 `6391a4d`，其中 `5d8eff4` = 上述布局修复）——因此本报告的"工作树构建"
  实际等于 **`5d8eff4` 源码内容**，A/B 即「修改前(`ece1d9d`) vs 修改后(`5d8eff4`)」；本报告未因该提交改变任何结论。
- 报告文件自身路径：`tester/report/055_kline_realtime_bar_append_diagnosis.md`
- 纪律：全程只读；临时实例 3 个（18099 / 18097 / 18095，MCP 18098/18096/18094），数据库连接串带
  `options=-c default_transaction_read_only=on`（写尝试会被 PG 拒绝；3 个实例日志 0 次写尝试）；
  未对线上 8081/8082 发任何写请求；未改仓库文件（只新增本报告与本目录证据）；未 git add/commit/stash；未跑 tangle。

---

## 0. 结论摘要（TL;DR）

**"新 bar 不追加"不是"前端 append 逻辑坏了"，而是三条独立原因叠加，其中前两条可直接解释用户现象：**

| # | 结论 | 级别 | 证据 |
|---|------|------|------|
| **R1** | **WS 半开连接永不重连**：`WsClient` 无心跳/无静默看门狗。网络瞬断（离线 12s 已复现）后，客户端**既没收到 `close`、也不再建连**，此后**永远收不到任何实时帧**（观测 104s 零帧），顶栏仍显示"已连接"。刷新页面/切周期/切标的之所以"恢复"，是它们都走了 **HTTP 重放**（`loadInitial`）把漏掉的 bar 补上，而**不是** WS 复活。 | **阻断级（核心）** | §3.4、§1.3；`fe_probe3.log`、`fe_probe5.log` |
| **R2** | **非跟随态下新 bar 被追加到可见区之外**：用户一旦手动缩放/平移（`followLatest=false`），WS bar 到达时前端**确实消费并 append 进图**（标记文本随推送变化），但那根新 bar 画在绘图区右侧 **+914px**（rtX=2165 / 绘图区 1251）→ **屏幕上什么都不变**；刷新/切周期/切标的会重锚视口到最右，于是"又更新了"。 | **高（用户可见性）** | §3.5；`fe_probe4b.log`（A 段 rtX=1168 可见 / B 段 rtX=2165 不可见） |
| **R3** | **推送语义只有"bar 边界"，没有 tick / 进行中 bar 更新**：每 (code,period) 每根新 bar 标签**仅推 1 条**（1m≈1 条/分钟且偶发跳标签、5m 每条 5 分钟、15m 每条 15 分钟、1h 每条 60 分钟、1d 当日根本不动）。因此"进行中那根 bar 的 OHLC 不随实时价变化"是**后端设计使然**，用户要求的"每分钟增量更新"必须由新的兜底路径补上。 | **中（需求缺口）** | §2；`ws_513310.log`（300s 原始帧） |

**判定**：`181c35a` / `7949c0b` **与本问题无关**（WS 通路代码零改动；行为 A/B 与 e2e A/B 一致，见 §4）。
e2e 里那两条失败（`G16`、`G18`）是**既有时间炸弹型测试缺陷**（硬编码 `2026-09-04` 过去时间戳 + 真实 WS 串流串扰），**不是回归**（HEAD 与工作树失败清单完全相同，见 §5）。

---

## 1. 症状定性（第 1 项：四问逐项给证据）

### 1.1 ① 进行中 bar 的 OHLC 是否随实时价变化？—— **不会（后端设计使然）**
- 后端 `Poller` 只在 `latest_bar(period,code).ts` **前进**时才推帧（`crates/web/src/ws.rs:214-224`），
  同一根 bar 标签内的 OHLC 变化**从不推送**；1m 原始行写入节奏见 §2.4。
- 因此"最右进行中 bar 冻结"是既有推送语义，不是前端 bug。**这正是用户"要每分钟更新"诉求的正解**（R3/§6）。

### 1.2 ② 到点后新 bar 是否追加？—— **健康态会追加且可见；两种用户态下"看不见"**
- 健康态实测（临时实例 18099 + 工作树构建，1m，无任何交互）：
  `fe_probe.log` 每个分钟边界：`barsRecv+1`、`marker` 文本随推送价变化、`hashChanged=true`（画布重绘）；
  `fe_probe3.log` A 段 95s 内 2 次推送：`marker` 8.931→8.935，`回到最新` 始终 disabled（followLatest=true 未自发翻转），
  标记 x 恒定 1582（= 视口跟着走）。
- 失败态 1（R2，手动缩放后）：`fe_probe4b.log`：A 段（跟随）`rtX=1168 / 画布宽 1251` → 新 bar 在可视绘图区内；
  B 段（手动缩放+平移后）`rtX=2165 / 1251` → **新 bar 在绘图区右侧 914px 外**，画布无变化；但 `marker` 文本仍从 8.945 变到 8.942
  ⇒ **数据被消费/追加了，只是看不见**。
- 失败态 2（R1，瞬断后）：`fe_probe3.log` Phase B/C：离线 12s 恢复后 **104s 内 0 条新 bar 帧**，
  且 `WS CLOSE`/`WS OPEN` 事件**均未出现**（说明客户端根本没察觉连接已死、也没重连）。
  `fe_probe5.log`（4.7 分钟全程）终值：**`websocket opens=1 closes=0 barFrames=1`** —— 浏览器侧**只建过 1 个 socket、从未 close**，
  离线→在线后 2.7 分钟内 0 帧，顶栏 pill **始终显示"已连接"**（`(无 WS 异常 pill)`）；随后 `分时→K线` 切 Tab 仍然 0 帧
  ⇒ **只有整页刷新（新建 socket）能救活实时流**，切周期/标的/Tab 只能靠 HTTP 重放把"漏掉的 bar"补上。

### 1.3 ④ 哪些周期/状态会放大问题（实测）
| 维度 | 实测结论 | 证据 |
|------|----------|------|
| 周期 1m | 边界推送 ≈ 1 条/分钟（偶发 90–120s 跳标签，取决于采集侧写行节奏） | `ws_513310.log`：t=0.70/61.93/152.74/270.21（跳了 01:47、01:50） |
| 周期 5m | 只在 5 分钟桶边界推 1 条（300s 内 2 条） | `ws_513310.log` t=0.75（01:45）、t=270.23（01:50） |
| 周期 15m | 15 分钟才 1 条（300s 观测内 **0** 条新增） | `ws_513310.log` 仅 t=0.72（01:45） |
| 周期 1h | 60 分钟才 1 条（仅 t=0.76 的 01:00 桶） | 同上 |
| 周期 1d | 当日内**完全不推**：观测到的最新 D1 = `2026-09-10T16:00:00Z`（周一 09-14 盘中，落后 4 天） | 同上 |
| 跟随最新=开（默认） | 追加可见（rtX 落在绘图区内） | `fe_probe4b.log` A |
| 手动缩放/平移后（跟随=关） | 追加发生在屏外（rtX 越界） | `fe_probe4b.log` B |
| 长时间停留 | 95s 内 follow 未自发翻转、帧正常 | `fe_probe3.log` A |
| 网络瞬断后 | **实时流永久死亡**（无 close、无重连、零帧） | `fe_probe3.log` B/C、`fe_probe5.log` |
| 页面 `document.hidden` | 实时路径**无** hidden 抑制（仅 DashboardPage 用它重读配置；WS/append 不看 visibility） | 代码：`KlineChart.tsx` 无 visibility 分支；`DashboardPage.tsx:196-215` 仅重读配置 |
| WS 重连后重订阅 | `WsClient.onopen` 会重发全部已存 topic 的 subscribe 帧（**前提是 close 事件真的到达**） | `web/src/ws/WsClient.ts:79-84`；R1 说明该前提常不成立 |
| 切 Tab（分时↔K线） | 会重放 HTTP（KlineChart remount → init getBars），能补上漏掉的数据，但**不能救活死掉的 socket** | `fe_probe5.log` Phase 4：切回 K 线后 60s 内 `barFrames` 仍为 1 |

---

## 2. 后端推送面（第 2 项：端点/契约/频率/原始样本）

### 2.1 端点与帧格式
- 端点：`ws://<host>:<port>/ws`；客户端帧 `{"type":"subscribe","topic":"bar","code":"518880","period":"1m"}`
  （`web/src/ws/WsClient.ts:36-42` ↔ `crates/web/src/ws.rs:24-32`）。
- 服务端帧：`{"type":"bar","code":...,"period":...,"bar":{ts,open,high,low,close,volume,amount,source?}}`
  （`PushMsg::Bar`，`crates/web/src/ws.rs:52-60`；`BarDto` 见 `crates/web/src/dto.rs:128-149`）。
- **原始样本（`ws_513310.log`，订阅 1m/5m/15m/1h/1d + quote，t=0 为连接时刻）**：
```
[   0.39] BAR code=513310 period=1d  bar.ts=2026-09-10T16:00:00Z o=4.734 h=4.769 l=4.673 c=4.73 v=1770203119 src=tushare
[   0.70] BAR code=513310 period=1m  bar.ts=2026-09-14T01:46:00Z o=4.627 h=4.627 l=4.620 c=4.624 v=5950700  src=tencent_ifzq
[   0.72] BAR code=513310 period=15m bar.ts=2026-09-14T01:45:00Z o=4.627 h=4.629 l=4.620 c=4.624 v=7448900  src=None
[   0.75] BAR code=513310 period=5m  bar.ts=2026-09-14T01:45:00Z o=4.627 h=4.629 l=4.620 c=4.624 v=7448900  src=None
[   0.76] BAR code=513310 period=1h  bar.ts=2026-09-14T01:00:00Z o=4.603 h=4.645 l=4.603 c=4.624 v=70067708 src=None
[   0.78] QUOTE code=513310 ts=2026-09-14T01:46:00Z last=4.624 changePct=-2.2410147991543496
[  61.93] BAR code=513310 period=1m  bar.ts=2026-09-14T01:48:00Z ...      ← 分钟边界推进（跳过 01:47 标签）
[ 152.74] BAR code=513310 period=1m  bar.ts=2026-09-14T01:49:00Z ...
[ 270.21] BAR code=513310 period=1m  bar.ts=2026-09-14T01:51:00Z ...
[ 270.23] BAR code=513310 period=5m  bar.ts=2026-09-14T01:50:00Z ...      ← 5 分钟桶边界推进
```
（另一次 90s 独立观测，两个 code 均订阅 1m，见 §2.2 摘录。）

### 2.2 频率与语义结论
- **有"新 bar 开始"语义**：`bar.ts` 明确推进（1m 逐分钟、5m/15m/1h 逐桶、1d 逐日）；
- **没有 tick/进行中 bar 语义**：同一 `bar.ts` 的 OHLC 变化**永不推送**（Poller 以 ts 为游标，只推送进）；
- **每 key 每根新 bar 恰好 1 条**（去重轮询 `keys = distinct(code,period)`，`ws.rs:190-207`）；
- **首帧 = 追赶帧**：客户端订阅后第一个 tick 会立即补一条"当前最新 bar"（游标落后即推，`ws.rs:214-219`）；
- **推送节拍 3s**（`ws_poll_ms=3000`，`config/app.toml:10`），故边界最多滞后 3s。

独立 90s 观测（node ws 客户端，`518880`+`513310` 1m）：
```
01:53:22 BAR 513310 1m ts=01:54:00Z c=4.633   01:53:22 BAR 518880 1m ts=01:54:00Z c=8.935
01:54:18 BAR 513310 1m ts=01:55:00Z c=4.647   01:54:29 BAR 518880 1m ts=01:55:00Z c=8.935
```

### 2.3 forming 桶与 1d 差异（为什么"某些周期更不更新"）
- 5m/15m/1h 的"当前未闭合桶"由 `kline_raw` 实时聚合（`crates/storage/src/reader.rs:115-136`）**只在桶 ts 前进时**被推；
- 1d/w/m **无 forming 桶**（`forming_sql` 返回 None），推的是 cagg 里最后一根**已闭合**日线 → 盘中根本不动（实测落后 4 天）；
- 1m 无 forming，直接推 `kline_raw` 最新行（`MERGED_1M_SQL`）。

### 2.4 原始行写入节奏（解释"跳标签"）
只读 SQL 采样（`kline_raw`，多次查询）：1m 行按**每个标的自己的 60s 采集相位**写入，标签偶尔**领先墙钟 45–60s**
（例：`09:47:14` 时库中已有 `ts=01:48:00Z` 的行），个别分钟**整标签缺失**（例：513310 缺 01:47/01:50，518880 缺 01:53）
⇒ 表现为"相邻两次推送间隔 60–120s 不等"。这属于**采集侧写行节奏**，不是 WS 通路缺陷。

---

## 3. 前端消费面（第 3 项：订阅生命周期、回调链、抑制条件）

### 3.1 订阅建立/销毁（代码 + 实测）
- 建立：`KlineDataFeed.loadInitial()` 成功后 `subscribeRealtime()`（`feed.ts:246`、`feed.ts:288-296`），
  topic = `bar:${code}:${period}`；销毁：`feed.dispose()` → `unsubWs()`（`feed.ts:170-176`、`DashboardPage.tsx:238`）。
- 实测（浏览器 `framesent`）：页面加载即发 `quote/health/alert` 与 `bar:518880:15m`；
  点 1m → 先 `unsubscribe bar:518880:15m` 再 `subscribe bar:518880:1m`（feed 身份切换正确，无双订阅/漏订阅）。
  证据：`fe_probe.log` 01:47:34–01:47:37 段。

### 3.2 `subscribeBar` 回调是否真把数据交给 chart —— **是**（健康态）
- 链路：`WsClient.dispatch` → `feed` 的 handler（`msg.type==='bar'`）→ `applyRealtime`（ts 比较：更晚 append / 同 ts update / 更早 ignore）
  → `rtListeners` → `KlineChart` 的 `onRealtime` → `rtCallback(kc)`（= DataLoader `subscribeBar` 回调）→ 引擎 `_addData(data,'update')`
  （klinecharts 10.0.3 `index.esm.js:13620-13625` / `13439-13495`：单条数据 ts 更大则 push、相等则覆盖、更小则忽略）。
- 实测：`marker` 文本与推送 `close` 每次都一致（`fe_probe.log`：8.925/8.936/8.934；`fe_probe4b`：8.945→8.942），
  `hashChanged=true` 表示画布确实重绘 ⇒ **rtCallback 非空、append 生效**。

### 3.3 抑制条件逐条实测
| 抑制条件 | 是否存在 | 实测 |
|----------|----------|------|
| `followLatest=false` 让 append 被丢弃 | **不丢弃**（仍 append），但**不可见** | `fe_probe4b.log` B：marker 文本更新、rtX=2165 越界 |
| `manualAdjusted`（手动缩放后 resize 不再 fit） | 存在（ADR-020 设计），只影响 layout 不影响 append | 同上 |
| `document.hidden` | **不存在**（实时路径不看 visibility） | 代码审查 + `fe_probe3` 无相关行为 |
| 周期不被推送支持 | 不存在（1m/5m/15m/1h/1d/1w/1mo 均可订阅；w/mo 也走 cagg 前进） | §2 |
| `market closed` 跳过 | 后端天然（无新行即无帧），前端无判断 | §2 |
| WS 重连后未重新订阅 | 代码会重订阅，**但 R1：半开连接根本不触发 close ⇒ 永不重连/重订阅** | `fe_probe3.log` B/C |
| 未加载完成前的 `rtCallback===null` 窗口 | 存在（毫秒~百毫秒级启动竞态），丢失的 bar 只留在 feed.bars、不上图 | `KlineChart.tsx:381-387`（`rtCallback?.(kc)`）——本次不是用户现象主因，但属同族缺陷（见 §6 修复建议） |

### 3.4 R1 复现（半开连接）—最关键证据
`fe_probe3.log`（工作树构建 @18099）：
```
[01:56:58] ### Phase B: 离线 12s → 在线
[01:57:10] B T+0s  follow=true marker="8.935" barsRecv=2
...（93s）...
[01:58:50] C T+68s follow=true marker="8.935" barsRecv=2      ← 仍在跟随、但一条新帧都没有
（全程无 "WS CLOSE"、无第二个 "WS OPEN"）
```
同时刻服务端确实在推（独立 node 客户端同时收到 `ts=01:57:00Z/01:58:00Z...` 的 bar 帧；DB 行也在写入）
⇒ **连接是"半开"的：客户端 readyState 仍为 OPEN，`onclose` 不触发，`scheduleReconnect` 永不执行**
（`WsClient.ts:88-95`、`137-151`）。页面刷新/切换会新建连接或重放 HTTP，故"看起来恢复了"。
`fe_probe5.log` 完整记录（同一构建、同一实例）：
```
[02:01:07] WS OPEN #1
[02:02:51] 正常  pill=(无 WS 异常 pill = 显示已连接) barFrames=1 marker=8.943
[02:03:03] network back online
[02:04:43] 恢复中（10s×10 次采样） pill=(无 WS 异常 pill) barFrames=1 marker=8.943   ← 100s 零帧、零重连
[02:04:49] 切Tab后（60s）            pill=(无 WS 异常 pill) barFrames=1 marker=null
[02:05:49] TOTAL: websocket opens=1 closes=0 barFrames=1
```

### 3.5 R2 复现（非跟随态追加到屏外）
`fe_probe4b.log`：
```
A（跟随，无交互）收到 bar ts=02:00:00Z  geometry={container:[414,1713] w=1299, mainCanvas:[414,1665] w=1251,
   fit={bars:120,space:11,visible:118}}  markerLeft=1582  rtX=1168   ← 在绘图区内 → 可见
B（手动缩放+平移）收到 bar ts=02:01:00Z  markerLeft=2579  rtX=2165   ← 越界 914px → 不可见
   同一时刻 marker 文本已从 8.945 变为 8.942（= 新 bar 的 close）⇒ 数据已进图，只是画在屏外
```
`window` 宽 1280 时图表容器本身就横向溢出（容器 `[414,1713]`），叠加非跟随视口后新 bar 完全落在可视区域之外。
**"刷新/切周期/切标的"能"更新"的机制**（第 3 问）：
| 动作 | 走了哪条重放路径 | 为什么看起来"修好了" |
|------|------------------|----------------------|
| 刷新页面 | 新 feed → `loadInitial()`（HTTP `GET /api/kline`）→ DataLoader `init` 回调整体替换 dataList；视口回到最右（followLatest 默认 true） | 漏掉的 bar 由 HTTP 补齐 + 视口重锚 |
| 切周期 | `feed` 身份变化 → `KlineChart` Effect W 重跑 → `setDataLoader`/`setSymbol`/`setPeriod` 各自 `resetData()` → `init` 取数（同一 `loadPromise`，实测仅 1 次 HTTP） | 同上 |
| 切标的 | 同上，另加 `store.selectSymbol` 显式 `followLatest=true` | 同上（额外恢复跟随） |
| 切 Tab（分时↔K线） | KlineChart 重挂载 → `loadInitial()`（feed 已 ready → 直接回 bar 列表）→ `init` 回调 | 数据补齐、视口重锚；**socket 不会复活** |

---

## 4. 归因近期改动（第 4 项：181c35a / 7949c0b 只读审查 + 对照实验）

### 4.1 代码面（零改动的硬证据，`tester/evidence/055/ws_path_diff_evidence.txt`）
```
## A. 181c35a 是否触及 WS 通路文件（feed.ts / KlineChart.tsx / WsClient.ts）→ 空（未触及）
## B. 7949c0b 是否触及 WsClient → 空
## C. 7949c0b 对 feed.ts 的实时函数（subscribeRealtime/applyRealtime/onRealtime/rtListeners/unsubWs/ws.subscribe）diff → 空
## D. 7949c0b 对 KlineChart.tsx 的实时接线（onRealtime/rtCallback/scrollLatest/followRef/markRealtime/subscribeBar/setDataLoader）diff → 空
```
- `181c35a` 改的是 `dcapIndicator.ts`（第 4 个 figure `zero` + 样式）、`layouts/DashboardGrid.tsx`（删 `border-t`）、设计文档与新增 e2e；
- `7949c0b` 改的是 `KlineChart.tsx`（拆 Effect L/W + `syncIndicators` 状态差分）、`DashboardPage.tsx`（`warmup` 移出 feed 身份依赖）、
  `feed.ts`（新增 `setWarmupBars`）、以及相关测试。**WS 订阅/回调/跟随路径逐行未变**（仅被搬进 Effect W，语义相同）。
- 附带说明：`7949c0b` 把 `dcapWarmup` 移出 feed useMemo 依赖，**减少**了 feed 重建次数 ⇒ 对 WS 订阅只可能是**改善**（更少 unsubscribe/subscribe 往返）。

### 4.2 行为 A/B（/tmp 副本，只读仓库）
| 变体 | 构建 | 1m 实测（跟随态 rtX / 画布宽） | 结论 |
|------|------|-------------------------------|------|
| 工作树（= 现 `5d8eff4` 源码） | `/tmp/kl_diag/dist` @18099 | A 段 `rtX=1168/1251`；B 段 `rtX=2165/1251` | 见 §3.5 |
| `ece1d9d`（= 修改前基线） | `/tmp/kl_head/dist` @18097 | e2e 失败清单与工作树**完全相同**（§5） | 无差异 |
| **`7949c0b^`（3 个 dashboard 文件回退）** | `/tmp/kl_pre/dist`（`git show 7949c0b^:...`）@18095 | A 段 `rtX=1168 / 1251`（可见）；B 段（手动缩放后）`rtX=2165 / 1251`（越界）——与现版**逐项相同**（`fe_probe4_pre.log`） | **预改动行为与本问题的两个特征完全一致 ⇒ 7949c0b 未引入/加重本问题** |
| 单测 A/B | 工作树 577/577 绿；HEAD 574 用例中 3 红（`dcapMirror.test.ts` 的 `/tmp` 拷贝缺 `crates/` 产物，**属拷贝环境假红**）；`7949c0b^` 变体 21 红（全是 7949c0b 自己新增的 pane 布局/dcap warmup 契约测试 = 设计内的"修复前红"）+ 同样 3 条拷贝假红 | — | **三边都没有任何"WS/实时消费"用例失败——因为套件里根本没有这类用例（覆盖缺口，见 §7）** |

日志：`tester/evidence/055/{vitest_wt.log,vitest_head.log,vitest_pre.log,fe_probe4_pre.log}`。

---

## 5. e2e 判定（第 5 项：HEAD vs 工作树，临时实例，只读库）

跑法（临时实例 + 各自构建产物；未跑写库用例）：
```
E2E_BASE_URL=http://127.0.0.1:18099 npx playwright test kline-matrix.e2e.ts -g "G16|G17|G18" ...
E2E_BASE_URL=http://127.0.0.1:18097 npx playwright test kline-matrix.e2e.ts -g "G16|G17|G18|D10" ...
E2E_BASE_URL=http://127.0.0.1:18099 npx playwright test kline-matrix.e2e.ts -g "D10" ...
```
| 用例 | 工作树构建（@18099） | HEAD 构建（@18097） | 判定 |
|------|----------------------|---------------------|------|
| `D10 分时在数据动态时正确（WS 注入模拟盘中）` | ✅ passed | ✅ passed | 既有 flake 已消失（非回归） |
| `G16 WS 新 bar appendBar + 同 ts updateBar + 进行中 bar 虚线跳动标记` | ❌ failed（attempt#1 + retry#1） | ❌ failed（attempt#1 + retry#1） | **既有测试缺陷（时间炸弹+真实流串扰），非回归** |
| `G17 实时注入 ≥60s 连续运行不崩 / 无 console error / 内存有界` | ✅ passed | ✅ passed | — |
| `G18 实时叠加在 15m 与 1m 都生效` | ❌ failed（retry 后仍失败） | ❌ failed | **同上** |
| `canvas.e2e.ts` | 未跑（该文件不含 updateBar/WS/分时动态用例，与实时判定无关） | 同 | — |

`G16` 失败原因（`tester/evidence/055/e2e_wt.log`）：
1. attempt#1：`expect(marker).toContainText("9.15")` 实际收到 `"8.929"` —— 注入帧 `ts=2026-09-04T08:00:00Z` **早于**当日已加载数据（09-14），
   被 `applyRealtime` 判为 `ignore`；此刻页面上唯一存在的是**真实 WS 推送**的 bar（8.929）；
2. retry#1：`expect(marker).toHaveCount(1)` 收到 0 —— 5s 窗口内既无注入帧生效、也恰好没有真实帧 ⇒ 不确定。
`G18` 同因（`9.17`/`9.19` 均为 `2026-09-04` 硬编码时间戳）。
**结论**：这两条是"为收盘后静态数据写的注入用例"，在盘中/数据推进后必然失败（与 181c35a/7949c0b 无关；HEAD 侧失败清单完全相同）。
修复口径应改为**相对时间戳**（如 `lastBar.ts + 周期步长`）并**只断言注入帧的效果**（或在注入前冻结/忽略真实流）。

---

## 6. 最小修复提案（不改代码，只给口径）

### (a) 核心修复点（按优先级）
1. **R1 —— WS 活性检测与自愈（最高优先，直接影响"必须刷新"）**
   - 客户端加**心跳/看门狗**：`WsClient` 内维护 `lastMessageAt`；服务端已推 `health/quote` 高频帧，可直接
     「每 N 秒（如 15s）若无任何入站帧 → 视为失联」主动 `close()` 并走既有指数退避重连（重连后 `onopen` 已会重订阅）；
   - 或（更标准）**应用层 ping/pong**：客户端定时发 `{"type":"ping"}`，服务端回 `{"type":"pong"}`（需后端加一条 ClientMsg 分支，改动在
     `crates/web/src/ws.rs` 的 `ClientMsg`/`handle_socket`；仍属 ADR-017 只读语义，无写库）；
   - 另加**书签式补偿**：重连成功后对当前 (code,period) 做一次 HTTP 增量拉取（见 (b)），把断连期间漏掉的 bar 补齐
     —— 否则即使重连成功，图上也缺一段 bar（`applyRealtime` 只支持"接得上最新一根"）。
2. **R2 —— 非跟随态的可见性/提示**
   - 保持"尊重用户手动视口"（ADR-020 §2.6 不回归），但要让用户知道有新数据：例如 `followLatest=false` 时更新
     「回到最新」按钮的角标/文案（"有新 bar（N）"）；或按用户最新诉求提供"仅当视口已在最右时自动跟随"的选项。
   - 若确认这是用户主诉，最小改动是：`applyRealtime` 之后若 `!followLatest` 且新 bar 落在可见范围外 → 触发一次轻量提示；
     **不要**每分钟强行 `scrollToRealTime()`（会破坏历史翻阅）。
3. **R3 —— `rtCallback===null` 竞态（启动窗口丢 bar）**：`KlineChart` 的 `onRealtime` 回调里若 `rtCallback` 为空，
   应把 bar 暂存（或对最近一根做 `chart.resetData()`/补一次 init）而不是静默丢弃。

### (b) 用户要求的「每分钟兜底增量更新」稳妥口径
**形态**：WS 为主 + **每分钟一次 REST 增量兜底**（仅当页面可见时），落到同一个 `KlineDataFeed`，复用同一条 `applyRealtime`/`rtListeners` 通路。

- **取数**：`GET /api/kline?code=<code>&period=<p>&limit=K`（`before` 省略 = 从最新起），`K` 建议 3~5（覆盖"跳标签/偶发缺行"导致的 1–2 根缺口）。
- **合并（幂等，天然不与 WS 重复）**：对返回的 bars 逐根走**同一** `applyRealtime` 语义：
  `Date.parse(ts) > last.ts → append`；`=== last.ts → 覆盖（updateBar）`；`< last.ts` → 忽略。
  由于合并以 **bar 时间戳为唯一键**（与 klinecharts `_addData` 同口径），WS 已入的 bar 再被 REST 拉回来只会"同 ts 覆盖"，
  **不会产生重复 bar**（这正是当前 `applyRealtime` 已有的语义，直接复用即可，无需去重表）。
- **与 WS 的优先级/竞态**：两者都写同一 `applyRealtime`；REST 结果到达时若 ts 更旧则被忽略。建议 REST 兜底**不**走 `rtListeners` 的
  "滚动/但标记"副作用以外的路径（即复用 `applyRealtime`，保持行为一致）；并在 `loadingBefore`/`inFlight` 上加简单互斥，避免并发覆盖。
- **不打断手动缩放/历史翻阅**：兜底拉取**只更新数据**，视图侧沿用现有规则 —— 仅当 `followLatest && !manualAdjusted` 时才
  `scrollToRealTime()`；用户滚到历史（`followLatest=false`）时**绝不**自动拉视口。同理不清 overlay、不 `resetData()`、不重建 feed
  （保住 `7949c0b` 的 pane 布局契约）。
- **市场闭市/非交易时段**：建议**跳过或降频**（例如按 `AppShell` 已有 `tradingSession()` 判据：非交易时段 5 分钟一次或暂停；
  盘中 60s），避免无意义的每分钟 HTTP；闭市时后端本来也无新行。
- **失败重试与退避**：单次失败**不弹错、不阻塞**；退避 1s→2s→4s→8s→上限 60s，成功即复位；
  连续失败 N 次（如 5）后降为每 5 分钟探测；与 WS 恢复（R1 修复后）互相独立，任一通路成功即视为健康。
- **可观测性**：在 `feed`/`KlineChart` 上暴露最近一次实时来源（`ws`/`poll`）、最近成功时间、连续失败数，
  便于 e2e 与人工排查（可直接复用到红测试里）。

### (c) 副作用面（必须一并评估）
- 每小时 60 次 HTTP × 每个打开的图表（宫格 2×2/2×3 会**成倍**增加）→ 需在 `GridCell` 共用/合并请求；
- 1m 的 `limit=3~5` 查询走 `MERGED_1M_SQL`（实测 ~0.1s）可接受，但**多标的并发**需限流；
- 对 1d/w/mo 周期，REST 兜底也拿不到当日 D1（数据面未写入）→ 兜底无法"创造"数据，需求应写清"仅日线闭合后才变"；
- 兜底轮询 + WS 同时触发时可能对同一 bar 产生两次 `emit()`（一次 append/一次同 ts 覆盖）→ 会多一次 React `setRt` 重渲染，
  不影响正确性（可在同 ts 且 OHLC 完全相同时跳过 `emit`）。

### (d) 需要同步更新/新增的既有测试
| 类型 | 用例 | 为什么必须动 |
|------|------|--------------|
| e2e（必改） | `web/e2e/kline-matrix.e2e.ts` `G16`、`G18` | 硬编码 `2026-09-04` 时间戳已失效（§5）；改为相对时间戳（`lastLoadedTs + 1 周期`）并隔离真实 WS 流 |
| e2e（新增） | 实时可见性/自愈：`bar` 帧到达后断言 **rtX 落在绘图区内**（而非只断言标记存在）；断网 12s 后断言**自动重连并从 HTTP 补齐** | 当前无用例覆盖 R1/R2（见 §7） |
| 单测（新增） | `KlineChart` 的 WS→chart 路径：目前所有 `KlineChart.*.test.tsx` 都把 `onRealtime` 打桩为 `vi.fn(() => () => {})`，**没有任何用例验证 `subscribeBar` 回调被调用** | 覆盖缺口是本次诊断能藏这么久的原因之一 |
| 单测（新增） | `WsClient`：断言"入站静默超时 → 触发重连 + 重发 subscribe"，以及半开连接场景 | 现有 `WsClient.test.ts` 只测了 `onclose` 驱动的重连 |
| 单测（新增） | `KlineDataFeed`：`pollIncrement()`（兜底）与 `applyRealtime` 的合并幂等（同 ts 覆盖、更早忽略、不重复 append） | 锁住"每分钟兜底不与 WS 重复"的口径 |

---

## 7. 红测试建议（设计，不在本任务改仓库测试文件）

设计文件：`tester/design/055_realtime_append_red_test_design.md`（同目录约定）。
要点（先红后绿，可作修复验收面）：
1. **T-R1（WsClient 自愈，单测）**：fake WebSocket + 假时钟；`open` 后停止任何入站帧 → 期望 `>N` 秒后 `close()` 被调用、
   `onopen` 后重发全部 topic 的 subscribe 帧；并覆盖"半开（readyState 仍 OPEN、无 onclose）"场景（当前实现必红）。
2. **T-R2（追加可见性，e2e）**：1m 图表；注入"更晚 ts"的 bar 帧 → 断言 `[data-realtime-marker]` 的 `left` 落在
   主 canvas 的 rect 内（当前跟随态会绿、非跟随态会红，正好锁住 R2 的口径）。
3. **T-R3（每分钟兜底，单测+集成）**：假 `ApiClient` 记录调用；断言 60s 粒度触发一次 `limit=3~5` 的增量拉取；
   返回"同 ts 已存在但 OHLC 变化"的 bar → `updateBar` 被触发且 `bars.length` 不变；返回"更新 ts" → append 且长度 +1；
   返回更早 ts → 忽略；`followLatest=false` → 不得调用 `scrollToRealTime`。
4. **T-R4（启动竞态，单测）**：`subscribeBar` 回调注册前到达的实时 bar 必须最终上图（当前会丢）。
5. **T-R5（e2e 既有用例修正）**：`G16`/`G18` 时间戳相对化（相对化后应转绿；同时保留"mock 注入与真实流隔离"断言）。

---

## 8. 只读纪律与收尾清单

- 临时实例：`18099/18098`（工作树构建）、`18097/18096`（HEAD 构建）、`18095/18094`（`7949c0b^` 变体），全部指向
  `...?options=-c default_transaction_read_only=on`；3 份 `app.log` 中 **0 次**写尝试被拒（`grep -ci "read-only"` = 0），
  说明连写尝试都没有发生；e2e 只跑 `kline-matrix.e2e.ts` 的只读实时用例（未跑含 `preClean/cleanupSymbol` 的写库用例）。
- 未对线上 8081/8082 发起任何请求（含 WS）；未改仓库文件；未 `git add/commit/stash`；未 tangle。
- 收尾：3 个临时实例已 kill；`/tmp/kl_diag`、`/tmp/kl_head`、`/tmp/kl_pre` 已删除（证据副本保留在 `tester/evidence/055/`）。

---

## 附录：证据索引（`tester/evidence/055/`）

| 文件 | 内容 |
|------|------|
| `ws_observe.py` / `ws_513310.log` | 后端 WS 契约原始帧（5 周期 + quote，300s；1m/5m/15m/1h/1d 频率差异） |
| `fe_probe.mjs` / `fe_probe.log` | 浏览器端：订阅/退订帧、帧到达、marker/画布随推送变化（健康态） |
| `fe_probe2.mjs` / `fe_probe2.log` | 手动缩放后：marker 文本更新但画布不变（R2 首次观测） |
| `fe_probe3.mjs` / `fe_probe3.log` | 跟随态 95s 未自发翻转；**离线 12s 后半开连接永不恢复（R1）** |
| `fe_probe4.mjs` / `fe_probe4b.log` | 几何测量：跟随态 `rtX=1168/1251` 可见 vs 非跟随态 `rtX=2165/1251` 不可见（R2 定量） |
| `fe_probe4_pre.log` | `7949c0b^` 构建的对照（A 段 `rtX=1168` 与现版一致） |
| `e2e_wt.log` / `e2e_head.log` | e2e `D10/G16/G17/G18` 两次运行通过/失败清单与失败文本 |
| `vitest_wt.log` / `vitest_head.log` / `vitest_pre.log` | 单测三变体（577/577、574 中 3 条拷贝环境假红、`7949c0b^` 21 条设计内红） |
| `ws_path_diff_evidence.txt` | `181c35a`/`7949c0b` 对 WS 通路零改动的 diff 证据 |
