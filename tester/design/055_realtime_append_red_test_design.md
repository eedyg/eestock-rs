# K 线实时通路红测试设计（R1/R2/R3/R5）

- 设计文件自身路径：`tester/design/055_realtime_append_red_test_design.md`
- 关联诊断报告：`tester/report/055_kline_realtime_bar_append_diagnosis.md`
- 证据目录：`tester/evidence/055/`
- 本文件**只设计**，不修改仓库任何测试/源码文件（本任务只读）；下面给出"若要落地"的用例名、层、Given-When-Then、桩策略与预期红/绿。

## 0. 覆盖缺口（为什么本次缺陷能藏这么久）

| 现有资产 | 现状 | 缺口 |
|----------|------|------|
| `KlineChart.*.test.tsx`（4 个文件） | `onRealtime: vi.fn(() => () => {})` 全部打桩为**空订阅** | **没有任何用例**验证「WS bar → `subscribeBar` 回调 → 引擎 append/update」这一环 |
| `KlineDataFeed`（feed.test.ts 仅 10 例） | 只测取数 limit/批量/常量 | **无** `applyRealtime` append/update/ignore 的用例、无"每分钟兜底" |
| `WsClient.test.ts` | 只测 `onclose` 驱动的重连 | **无**半开连接 / 入站静默看门狗用例 |
| e2e `kline-matrix.e2e.ts G16/G18` | 注入帧时间戳硬编码 `2026-09-04`，与真实 WS 串流不隔离 | 数据推进后必然失败（时间炸弹），且**只断言 marker 存在、不断言"新 bar 是否落在可见绘图区内"** |

## 1. 用例清单

### T-R1 WS 自愈（层：单元，`web/src/ws/WsClient.test.ts`）
- **T-R1-a 入站静默 → 主动重连**：Given fake WebSocket + 假时钟（`vi.useFakeTimers`），open 成功且已发 subscribe；
  When 静默超过看门狗阈值（建议 15s，允许注入）；Then `close()` 被调用、退避计时器启动、重连后 `onopen` 重发**全部** topic 的 subscribe 帧。
  *当前实现预期红*（无看门狗）。
- **T-R1-b 半开连接（readyState 仍 OPEN，无 onclose）**：Given 同上但永不触发 `onclose`；When 静默阈值到达；
  Then 仍必须进入重连路径（不得因 `readyState<=1` 早退）。
- **T-R1-c 重连后补齐**：Given 重连成功；When 触发一次补偿拉取；Then 收到断连期间漏掉的 bar（与 T-R3 口径一致）。

### T-R2 实时 bar 的可见性（层：e2e，`web/e2e/kline-realtime-visibility.e2e.ts` 新文件）
- **T-R2-a 跟随态**：Given 打开看板 + 选 1m + 等首帧；When 注入 `ts = 已加载最末 ts + 1 周期` 的 bar 帧；
  Then `[data-realtime-marker]` 的 `left` ∈ 主 canvas 的 `getBoundingClientRect()` 横向范围（**不允许只断言"标记存在"**）。
- **T-R2-b 非跟随态（当前必红）**：Given 同上并手动 ctrl+滚轮放大 + 拖拽平移（`回到最新` 变为可用）；
  When 注入更新 ts 的 bar；Then 用户可见区必须出现"有新数据"的可感知提示（按钮角标/文案），
  且**不得**自动把视口拉回最右（同时断言旧行为不回退：视口不变）。
- **T-R2-c 不得因兜底而重置视口**：Given 非跟随且已滚到历史；When 兜底轮询触发一次；
  Then `manualAdjusted` 语义保持、`resetData` 未被调用、pane 高度/身份不变（复用 `KlineChartSwitchLayout.test.tsx` 的高度断言手法）。

### T-R3 每分钟兜底增量（层：单元 + 集成，`web/src/features/dashboard/feedRealtimePoll.test.ts` 新文件）
- **T-R3-a 触发粒度**：Given 假 `ApiClient` 记录调用；When 假时钟推进 60s（页面可见）；
  Then `getKline({limit: 3~5})` 恰被调用 1 次；非交易时段（注入 `tradingSession=false`）→ 不调用或降为 5 分钟。
- **T-R3-b 幂等合并（同 ts 覆盖）**：Given last bar `ts=T, close=1.0`；When 兜底返回 `ts=T, close=1.2`；
  Then `bars.length` 不变、末根 close=1.2、`onRealtime` 触发（updateBar 路径）。
- **T-R3-c append**：Given last `ts=T`；When 返回 `ts=T+1m`；Then 长度 +1 且顺序升序。
- **T-R3-d 更早忽略**：Given last `ts=T`；When 返回 `ts=T-1m`；Then 忽略（长度不变、不 emit）。
- **T-R3-e 与 WS 不重复**：Given 先注入 WS `ts=T+1m`，再让兜底返回同一 `ts=T+1m`（同 OHLC）；
  Then 长度仍 +1（不出现重复 bar），且**不产生第二次 `emit`**（或至少不产生第二次 React `setRt` 之外的重渲染）。
- **T-R3-f 失败退避**：Given 连续 3 次 500；Then 退避 1s→2s→4s、不抛错、不改变既有 bars；第 4 次成功后复位。
- **T-R3-g 不打断手动视口**：Given `followLatest=false`；When 兜底成功；Then `scrollToRealTime` **未**被调用。

### T-R4 启动竞态（单元，`web/src/features/dashboard/KlineChart.realtime.test.tsx` 新文件）
- **T-R4**：Given klinecharts 桩（记录 `callback` 调用），`subscribeBar` 尚未调用；
  When `feed.onRealtime` 派发一根 bar；Then 该 bar 在 `subscribeBar` 注册后必须被补投（不得静默丢弃）。
  *当前实现预期红*（`rtCallback?.(kc)` 直接调空）。

### T-R5 既有 e2e 修正（不是新特性，是修"时间炸弹"）
- **T-R5-a `G16`**：注入 ts 改为**相对时间戳**（从已加载 `bars.at(-1).ts` + 周期步长推导），并先冻结真实流
  （`window.__push` 与真实帧隔离：断言只针对注入帧的特征值，或用独立 symbol/period 避免污染）。
- **T-R5-b `G18`**：同上（15m 与 1m 两段）。
- 预期：修正后两条应稳定绿；若仍红，则说明存在真实的 append/update 回归（此时才允许归因代码）。

## 2. 桩策略与边界

| 被测对象 | 桩/依赖 | 边界用例 |
|----------|---------|----------|
| `WsClient`（T-R1） | 注入 `webSocketImpl`（可编程 fake）+ 假时钟 | 半开、onclose 后重连、`manualClose` 后不重连、退避上限 30s |
| `KlineChart`（T-R2/T-R4） | klinecharts 桩（沿用既有 `vi.mock('klinecharts')` 手法，需补 `subscribeBar` 回调捕获） | 数据未加载 / feed 已 ready / feed 身份切换中 |
| `KlineDataFeed` 兜底（T-R3） | 假 `ApiClient.getKline`，可编程成功/失败/延迟 | 空返回、重复返回、乱序返回、并发（`loadingBefore` 互斥） |
| e2e（T-R2/T-R5） | Playwright + `window.__sock` 注入底座（沿用 `kline-matrix.e2e.ts` 的 WS_HARNESS） | 跟随/非跟随、1m/15m、断网 12s 后恢复 |

## 3. 覆盖目标（建议）
- `WsClient`：连接状态机 + 静默看门狗分支 100%（新增行为全部有正反例）；
- `KlineDataFeed`：`applyRealtime` append/update/ignore 三分支 + 兜底合并幂等 100%；
- `KlineChart`：WS→chart 回调链至少 1 条端到端断言（当前为 0）；
- e2e：新增 1 条可见性断言 + 1 条自愈断言；`G16/G18` 相对时间戳化后稳定绿。
