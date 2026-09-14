# 实时通路红测试落地记录（T-R1~T-R5 已写入可运行测试）

- 本文件自身路径：`tester/design/056_realtime_append_red_tests_landed.md`
- 层级：设计记录（**只为「新设计并写下的测试」**；执行结果与红证据见 `tester/test/055_realtime_append_red_execution.md`）
- 上游设计：`tester/design/055_realtime_append_red_test_design.md`（T-R1~T-R5 设计，只读未改）
- 上游诊断：`tester/report/055_kline_realtime_bar_append_diagnosis.md`（R1 半开连接 / R2 屏外追加 / R3 无 tick）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`；HEAD = `6391a4d`
- 落地时间：2026-09-14（本条目的测试文件与证据同一轮次产出）
- 记录自身路径：`tester/design/056_realtime_append_red_tests_landed.md`
- 纪律：**未改任何产品代码/接口/架构**（`web/src/**` 只新增 4 个 `*.test.*` 文件）；未 `git add/commit/stash`；未 tangle；
  未碰 `design/14-dcap-indicator` 的 `file=` 代码块；未改 ABI/引擎/ExecutionPolicy；未对线上 8081/8082 发写请求。

## 1. 落地产物（4 个新测试文件 + 1 个既有 e2e 修正）

| 用例组 | 文件（本文件新增/修改） | 层 | 当前状态 |
|--------|------------------------|----|----------|
| T-R1、T-R1-d | `web/src/ws/WsClient.watchdog.test.ts`（新，242 行） | 单元 + 集成（真实 WsClient × 假 transport × 假 ApiClient） | 4 用例全红 |
| T-R2 | `web/src/features/dashboard/feedRealtimeReconnect.test.ts`（新，151 行） | 集成（真实 WsClient + 假传输 + 真 KlineDataFeed） | 1 红 / 1 守卫绿 |
| T-R3（a/a2/b/d/d2/e） | `web/src/features/dashboard/feedRealtimePoll.test.ts`（新，316 行） | 单元（假时钟 + 假 ApiClient） | 5 红 / 2 守卫绿 |
| T-R3(c)、T-R4、T-R5 | `web/src/features/dashboard/KlineChart.realtime.test.tsx`（新，267 行） | 组件（klinecharts 桩 + 可捕获 `subscribeBar` 回调） | 4 红 / 4 守卫绿 |
| e2e 时间炸弹修正（G16/G18） | `web/e2e/kline-matrix.e2e.ts`（改，+163/−22） | e2e（Playwright，只读实例） | 修后 2/2 绿（修前 2/2 红） |

> 与 `design/055` 命名的差异：T-R1 单独成文件（`WsClient.watchdog.test.ts`）而不是追加进 `WsClient.test.ts`
> ——避免与既有 10 条连接状态机用例共用 `FakeWebSocket`／互相影响（本文件需要 `close() 不派发 onclose` 的半开变体）；
> T-R2/T-R5 由 e2e 降级为 **jsdom 单元/组件层**（任务要求「能 jsdom 打桩的优先打桩以保证可重复」），
> e2e 只保留「测缺陷修正」范围内的 G16/G18。

## 2. 用例清单（Given-When-Then 摘要 + 钉死的口径）

### T-R1（`WsClient.watchdog.test.ts`）
| 用例 | Given / When / Then | 钉死口径 |
|------|---------------------|----------|
| T-R1-a | G: 假 WS + 假时钟，open 且已发 `bar:…`/`quote` 订阅 / W: 静默 14s 后再 +1s（阈值 15s） / T: `close()` 被调 1 次、状态不得继续为 `open`、退避 1s 后新建连接并在 open 时**重发全部** subscribe 帧 | 任务 T-R1「入站静默超阈值 ⇒ 主动 close 并进入既有指数退避重连」 |
| T-R1-b | G: `close()` 只把 readyState 置 CLOSING、**永不**派发 `onclose`（半开）/ W: 静默 15s + 退避 1s / T: 仍必须建新连接（不得因 `socket` 非空 / `readyState<=1` 早退） | 诊断 R1 半开连接（§3.4 实测 opens=1/closes=0）；任务「不得依赖 onclose」 |
| T-R1-c | G: 每 10s 一帧、连续 5 帧 / W: 再各静默 10s、5s / T: 10s 静默不关；**自最后一帧起 15s** 必须关 | 阈值以「最近一次入站帧」为基准（负例防误杀） |
| T-R1-d | G: 真 WsClient + 真 KlineDataFeed + 假 api / W: 静默 15s → 看门狗 close → 退避重连 → open / T: 必须有**一次** HTTP 增量补偿，且是当前 code/period 的**最新窗口**（无 `before` 游标） | 任务 T-R1「恢复后必须做一次 HTTP 增量补偿」+ 口径② |

### T-R2（`feedRealtimeReconnect.test.ts`）
| 用例 | Given / When / Then | 钉死口径 |
|------|---------------------|----------|
| T-R2-a | G: 已加载 01:50–01:53；断线期间 DB 新增 01:54–01:56；补偿窗口故意包含 3 根已知 bar / W: 意外断线 → 退避重连 → 补偿返回 / T: `feed.bars` = 01:50…01:56（连续、无重复、升序），且 01:54/55/56 每根都经 `feed.onRealtime` 下发 | 任务 T-R2「断口不残留空洞」；口径②（同一通路） |
| T-R2-b（守卫） | G/W: 补偿窗口只含已知 bar（同 ts 同 OHLC） / T: bars 长度与内容不变、无重复 | 口径②幂等（当前绿，修后仍须绿） |

### T-R3（`feedRealtimePoll.test.ts` + `KlineChart.realtime.test.tsx` 的 c 组）
| 用例 | Given / When / Then | 钉死口径 |
|------|---------------------|----------|
| T-R3-a | G: 假时钟停在交易日 10:00（北京）、假 api 记录调用 / W: 推进 59 999ms 与 60 000ms / T: 恰在 60s 触发一次 `GET /api/kline`，`limit ∈ [3,5]`、无 `before`、code/period 一致；再 60s 再来一次 | 任务 T-R3（页面可见时每 60s / limit 3~5） |
| T-R3-a2 | G/W: 兜底返回 `[更早 ts, 同 ts(改 close), 更晚 ts]` / T: 长度 +1、顺序升序、更早未插入、同 ts 已覆盖、`onRealtime` 恰好 2 次（覆盖+append） | 口径②（更晚 append / 同 ts 覆盖 / 更早忽略） |
| T-R3-b | G: WS 先入 `ts=T` / W: 兜底返回同 ts 同 OHLC，再返回同 ts 改 OHLC / T: 同 OHLC ⇒ bars 不重复且 `onRealtime` **不增加**（spy 计数）；改 OHLC ⇒ 覆盖且恰好 +1 次 | 任务 T-R3(b)「与 WS 不重复写入（同 ts 只写一次）」+ 口径② |
| T-R3-d | G: 假时钟 = 午间休市 / 周日 / W: 推进 5 分钟 / T: 0 次兜底调用 | 口径③ |
| T-R3-d2 | G: `document.visibilityState='hidden'` / W: 推进 120s，再切 `visible` + `visibilitychange` / T: 隐藏期间 0 次；恢复后恢复轮询 | 任务 T-R3「页面可见时」 |
| T-R3-e1 | G: 初始加载成功、其后每次兜底失败 / W: 逐段推进 60s 后按 999/1ms 边界探测 / T: 调用间隔 1→2→4→8→60→60s（封顶），失败期间 bars 不变、无异常抛出；成功后复位，再失败重新 1s 起步 | 口径④（退避序列、成功复位、不弹错） |
| T-R3-e2（守卫） | G/W: 兜底返回空数组 / T: 不清空、不重建、不 emit | 口径②幂等 + §6(c) 副作用面 |
| T-R3-c1（守卫） | G: `followLatest=false` / W: 实时 bar 到达 / T: 不调 `scrollToRealTime` | 口径① |
| T-R3-c2 | G: `followLatest=true` 且用户已手动缩放（`chart.subscribeAction('onZoom')` 触发）/ W: 实时 bar 到达 / T: **不调** `scrollToRealTime` | 任务 T-R3(c)「只有 followLatest && !manualAdjusted 才 scrollToRealTime」 |

### T-R4 / T-R5（`KlineChart.realtime.test.tsx`）
| 用例 | Given / When / Then | 钉死口径 |
|------|---------------------|----------|
| T-R4-a | G: 引擎尚未调用 `subscribeBar`（`rtCallback===null`）/ W: 连到 2 根 bar，再注册 `subscribeBar({callback})` / T: 两根按序补投（ts/close 精确断言）；其后到达的直投且不重复 | 任务 T-R4「不得静默丢弃（缓冲/补偿）」；诊断 §6(a)3 |
| T-R4-b（守卫） | G/W: 先注册再到达 / T: 恰好投递 1 次 | 防「缓冲永不冲刷/重复投递」 |
| T-R5-a | G: `followLatest=false`、容器宽 680、新 bar 像素 x=2165（诊断实测 rtX=2165/绘图区 1251）/ W: 实时 bar 到达 / T: 容器内出现「新数据」提示且 `scrollToRealTime` 调用数不变（**不改变视口**） | 任务 T-R5 + 口径① |
| T-R5-b | G: 同 T-R5-a / W: 点击提示 / T: `scrollToRealTime` 被调用 | 任务 T-R5「点击后才跳转到最新」 |
| T-R5-c（守卫） | G: `followLatest=true`、像素 x 在视口内 / T: 不得出现提示 | 提示语义（跟随态本来可见） |
| T-R5-d（守卫） | G: `followLatest=false` 但像素 x 在视口内 / T: 不得出现提示 | 任务 T-R5「落在视口之外」限定条件 |

## 3. seam 约定（修码方必须满足的最小接口面；均为既有 API，**不新增 ABI**）

1. `WsClient`：**默认**入站静默阈值 15s（无需新增可注入选项）；静默到点后自行 `close()` 并自行进入既有
   `scheduleReconnect`（不得只依赖 `onclose`），且不得让 `connectionStatus` 长期停留在 `open`；
   重连后沿用既有「onopen 重发全部 topic 订阅」行为。
2. `KlineDataFeed`：构造签名不变（`{ api, ws, code, period, viewportBars }`）；`loadInitial()` 成功后自行调度兜底轮询；
   合并**复用 `applyRealtime`**；补偿/兜底触发点只需保证「重连成功后」或「每 60s」各发生一次最新窗口拉取
   （测试不绑定具体接线方式：`onStatusChange`、内部定时器或其它均可，只要行为可观测到）。
3. 兜底取数：`GET /api/kline`，`limit ∈ [3,5]`，**不带 `before`**（最新窗口）。
4. 轮询调度：必须是**自 re-arm** 定时器（退避期间不得再叠加固定 60s interval 触发），否则 T-R3-e1 边界计数不符。
5. 重连补偿必须让新增 bar 经 `feed.onRealtime` 逐根下发（否则图上看不到补齐段）。
6. `KlineChart`：实时回调在 `rtCallback` 为空时缓冲，并在 `subscribeBar({callback})` 注册时按序冲刷；
   滚动门控统一为 `followLatest && !manualAdjusted`；
   「新数据」提示渲染在 `[data-testid="kline-chart"]` 容器内（文本含「新数据」），点击 ⇒ `chart.scrollToRealTime()`；
   视口判定同时兼容 `clientWidth` 与 `getBoundingClientRect()` 两种宽度读取（测试两者都已打桩）。

## 4. 桩 / 边界策略

| 被测对象 | 桩 | 边界覆盖 |
|----------|----|----------|
| `WsClient`（T-R1） | 可编程 fake WebSocket（`normal` = close 派发 onclose；`hung` = CLOSING 且不派发）+ 假时钟 | 阈值前 1s / 阈值 / 阈值后；持续入站不误杀；半开；手动 `close()` 不重连（既有用例保留） |
| `KlineDataFeed` 兜底（T-R3） | 假 `ApiClient.getKline`（按调用序号响应：第 1 次初始加载，其后为兜底；可 reject）+ 假 ws handler | 空返回、重复返回、乱序/更早返回、同 ts 改 OHLC、连续失败、休市、hidden |
| 重连补偿（T-R1-d/T-R2） | **真实 WsClient** + fake transport + 假 api | 断线 1 根/多根；补偿窗口含已知 bar |
| `KlineChart`（T-R3-c/T-R4/T-R5） | klinecharts 桩（`setDataLoader` 捕获 `subscribeBar`、`scrollToRealTime` spy、`convertToPixel` 可编程、`subscribeAction` 捕获 `onZoom`） | 竞态前/后；跟随/非跟随；手动缩放；提示在/不在视口内 |
| e2e（G16/G18） | Playwright + `window.__push` 注入底座（新增 `__isolateBarStream` 只丢弃真实 bar 帧）+ `waitSubscribed`（读 `__sent` 确定性等待订阅） | 15m/1m；append/同 ts update；相对时间戳（+1 / +2 周期） |

## 5. 覆盖目标（本轮达成/未达成）

- `WsClient` 状态机 + 看门狗分支：**正反例齐备**（阈值前/后、持续入站、半开、重连重订阅、补偿）。
- `KlineDataFeed`：`applyRealtime` append/update/ignore 三分支经**兜底路径**各 1 例 + 幂等（同 ts 同 OHLC 不重复写）+ 退避序列。
- `KlineChart`：WS→chart 回调链**首次**有用例（T-R4 断言 `subscribeBar` 回调收到缓冲帧），填补既有
  「所有 `KlineChart.*.test.tsx` 把 `onRealtime` 打成空订阅」的覆盖缺口。
- 行覆盖率：**未采集**（仓库未配置 vitest coverage provider，见执行报告 §5）；本轮以「分支/口径逐条对应」代替覆盖率数字。

## 6. 已知限制 / 待架构师裁决的残余

1. 「新数据」提示的**渲染位置**被钉在 `[data-testid="kline-chart"]` 容器内（与视图同域、非跟随态直接可见）。
   若改为挂在工具栏「回到最新」按钮角标，则 T-R5-a/b 需相应调整（点击路径会跨组件）。
2. T-R3-d2 的可见性语义宽容：隐藏期**严格** 0 次；恢复后允许「立即补一次」或「下个 60s 周期」两种实现
   （断言只要求 120s 内恢复轮询）。
3. T-R1-a/b 的「重连后重发全部 topic」沿用既有实现；若修码方改为「重连后按需增量订阅」，需同步改这两条断言。
4. T-R3-b 的「同 ts 同 OHLC 不重复写入」与口径②「同 ts 覆盖」的调和方式：**同 ts 且 OHLCV 完全一致 ⇒ 不写不 emit；
   同 ts 但 OHLC 变化 ⇒ 覆盖 + emit 一次**（与诊断 §6(c) 末条一致）。
