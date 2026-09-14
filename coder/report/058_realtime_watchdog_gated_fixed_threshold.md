# 058 — 自适应静默估值器 → 交易时段门控固定阈值（阶段 2 简化 / 只做减法）

- **本报告自身路径**：`coder/report/058_realtime_watchdog_gated_fixed_threshold.md`
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`；HEAD = `6391a4d`（工作区含 ④ 的未提交改动）
- 权威依据：`tester/test/057`（只读状态评估，§2.2「规则 A」建议）、`tester/test/055` + `tester/design/056`、
  `tester/report/055`、`design/06-web/01-dashboard.md` §3 补定稿 10 条实时口径
- 架构师本阶段口径（已裁决，未再提问）：**不做协议级心跳**；把 WsClient 的自适应静默估值器**简化为按交易时段门控的固定阈值**（交易时段 15s / 非交易时段 300s）
- 时间盒：实现 ≈12 min，自测 ≈9 min（含临时实例 e2e），未在估值器/魔法数上做任何调参探索

---

## 1. What changed（净删/增行数：体现「减法」）

| 文件 | 性质 | 净行数（本次改动 vs 改动前工作区） |
|---|---|---|
| `web/src/ws/WsClient.ts` | 已跟踪（含 ④ 未提交改动） | **净 −46 行**；文件 285 → **239 行**（口徑：`git diff --numstat` 相对 HEAD 的增行 **140 → 94**，删除行不变 **5**；HEAD 为 150 行 ⇒ 150+140−5=285） |
| `web/src/ws/WsClient.watchdog.test.ts` | **阶段 1 新增的未跟踪文件** | 净 **+≈15 行**（T-R1-e 用例段整体改写 + 时钟钉死 + 头注释）；文件 367 → **382 行**（落地时 242 行） |
| `design/06-web/01-dashboard.md` | 已跟踪 | **0 行数变化**（1 行散文**等长替换**；`file=` 代码块零触碰） |
| 其余（`feed.ts` / `KlineChart.tsx` / `kline-matrix.e2e.ts` / `realtimePoll.ts`） | — | **0 改动** |

合计：产品代码**净 −46 行**（估值器删除约 95 行、门控实现新增约 47 行），文档 1 行等长改写，测试 1 用例段改写。**没有任何新增依赖、接口、字段或常量**（唯一新增导出常量是把「升级上限」改名为「非交易时段阈值」）。

## 2. 估值器删除清单（`web/src/ws/WsClient.ts`）

删除的 4 个常量（任务点名）：

1. `SILENCE_CADENCE_MULTIPLIER = 2.5`（节奏→阈值放大系数）
2. `MIN_CADENCE_SAMPLE_MS`（节奏样本下限）
3. `MAX_CADENCE_SAMPLE_MS = 200_000`（节奏样本上限）
4. `INBOUND_SAMPLE_WINDOW = 5`（节奏估值窗口）

配套删除的字段 / 方法（估值器本体）：

5. 字段 `silentStreak`（零帧静默几何升级计数）
6. 字段 `inboundSamples: number[]`（节奏样本窗口）
7. 字段 `lastInboundAt`（本连接最近入站帧时刻）
8. 字段 `openedAt`（本连接建立时刻）
9. 方法 `recordInboundSample(gapMs)`（样本记录）
10. 方法 `cadenceEstimateMs()`（节奏估值 = 样本最大值）
11. 方法 `silenceThresholdMs()` 的估值逻辑体（`clamp(max(15s, 2.5×估值, 15s×2^零帧), 15s, 300s)`）整体删除，替换为门控取值
12. `onmessage` / `onopen` / `onInboundSilence` 中的样本记录与几何升级副作用（`reference` 计算、`silentStreak += 1`、`silentStreak = 0`）
13. 常量 `WS_INBOUND_SILENCE_MAX_MS` **改名**为 `WS_INBOUND_SILENCE_OFFHOURS_MS`（语义从「升级封顶」改为「非交易时段固定阈值」；全仓库仅本文件引用，无外部使用）

> 校验：`grep` 上述 11 个标识符在 `WsClient.ts` / `WsClient.watchdog.test.ts` 中**零命中**（见 §6 证据）。

## 3. 门控固定阈值实现位置

- 常量：`web/src/ws/WsClient.ts` — `WS_INBOUND_SILENCE_MS = 15_000`（交易时段）、`WS_INBOUND_SILENCE_OFFHOURS_MS = 300_000`（非交易时段）
- 门控取值：`WsClient.ts` `private silenceThresholdMs()`（**单表达式，3 行**）：

```ts
  private silenceThresholdMs(): number {
    return tradingSession(new Date()) === 'trading'
      ? WS_INBOUND_SILENCE_MS
      : WS_INBOUND_SILENCE_OFFHOURS_MS;
  }
```

- 门控来源：文件头新增 `import { tradingSession } from '@/shell/session';`（与 `feed.ts` 的分钟兜底**同一口径**：工作日 09:30–11:30 / 13:00–15:00，Asia/Shanghai；`preopen`/`lunch`/`closed` 均按非交易时段 → 300s）
- 语义保持（未变）：`armWatchdog()` 在**连接建立**与**任一入站帧**时重置静默计时；到点 `onInboundSilence()` → `sock.close()` → 既有指数退避重连（`minRetryMs=1s`→`maxRetryMs=30s`，`scheduleReconnect` 未改）→ `handleDisconnect()` 先 `setStatus('closed')`（顶栏 pill 立刻离开 `open`，不谎报）→ 重连 open 后由 `feed.ts` 既有的 `onStatusChange` 触发**一次** HTTP 增量补偿（`pollIncrement('poll')`，未改）。**不引入任何应用层心跳帧。**

## 4. 文档 clause 4 修正后的原文（`design/06-web/01-dashboard.md`，纯散文）

> 子条目原文（替换前：`clamp(max(15s, 1.5 × 推送节奏估值, 15s × 2^连续零帧静默次数), 15s, 300s)`，与代码 2.5 亦不一致）：

```
   - **阈值口径（阶段 2 简化：门控固定阈值）**：阈值按交易时段（复用同口径 5 的 `@/shell/session` `tradingSession()`）二选一取**固定值** —— **交易时段 15s / 非交易时段 300s**；任一入站帧都把静默计时复位。15s 的理由：交易时段推送活跃，要求快速自愈（半开连接最迟 15s 内被发现）；非交易时段放宽到 5 分钟的理由：背后是**数据驱动推送**（Poller 仅在数据推进时发布；实测盘中约 1 帧/分钟、非交易时段 0 帧），固定 15s 会把「本来就没数据可推」误判为失联而空转重连。自愈上限：非交易时段最差 5 分钟一次重连；即使 WS 通路失效，图的 bar 仍由每分钟 HTTP 兜底保证不落后 >60s。**不做协议级心跳**（评估实测：`AppShell` 恒订阅 `source_health`、store 恒订阅 `quote` ⇒ 活跃期 health 帧 ≈3.4s 一张，真实运行中几乎永远有帧，无需应用层心跳帧）。
```

- 同节 clause 4 主句（「不引入应用层心跳帧 / 主动 `close()` / 立即离开 `open` / 重连后一次 HTTP 增量补偿」）**保持原文未动**。
- `git diff` 校验：**无任何 `file=` 行被改动**（`grep -E '^[-+].*file='` 空）⇒ `file=` 代码块零触碰；`./scripts/check-tangle.sh` exit=0。

## 5. 测试改动（哪些断言按新口径改写 / 为何未削弱）

文件：`web/src/ws/WsClient.watchdog.test.ts`

**改写**：`T-R1-e`（原「静默阈值自适应（阶段 2 加强）」）→ 新「**门控固定阈值（交易时段 15s / 非交易时段 300s）**」。

| 原断言（估值器口径，已退役） | 新断言（门控口径） | 鉴别力 |
|---|---|---|
| e1：零帧静默阈值按 `15→37.5→93.75→234.375→300s` 几何升级（逐项写死估值器实现细节） | e1：交易时段静默 **14s 不得触发 / 达 15s 必须触发**，且 `connectionStatus !== 'open'` | 等价加强：仍钉死 15s 快自愈的**精确边界** |
| e2：慢节奏 20s 帧间隔 ⇒ 阈值被估值放大到 50s（依赖 2.5×20 的算式） | e2：非交易时段（周六 10:00 北京）**静默 15s 不得触发**；299.999s 不得触发；**恰达 300s 必须触发** | **新增/更强**：直接钉死门控（15s 触发是旧口径下的行为，新口径必须**不**发生） |
| — | e3：**任一入站帧复位计时** —— 交易时段每 10s 一帧共 5 帧（累计 50s 远超阈值）不得触发；末帧后 14s 不得触发、满 15s 必须触发 | **新增**：把「复位」从隐式变显式（累计时长 > 阈值但仍不触发 = 复位生效的反例） |

**未放宽、未删除任何断言**：`T-R1-a/b/c/d/f` 六条断言**逐字保留**（含半开连接 `readyState===2` 仍须重连、重连后重发全部 subscribe 帧、重连后一次最新窗口（无 `before`）补偿等）。仅在其中 3 个 `describe` 的 `beforeEach` **新增 1 行** `vi.setSystemTime(TRADING_NOW)`——把门控的输入（时钟）**钉死**，使既有 15s 口径用例不依赖墙钟（原先在非交易时段运行会因门控 300s 而假红）。这是**确定化**而非放宽：未有任何 `expect` 被改动。

新增测试常量（仅测试侧）：`OFFHOURS_SILENCE_MS = 300_000`、`TRADING_NOW = 2026-09-14T02:00:00Z`（周一 10:00 北京）、`OFFHOURS_NOW = 2026-09-12T02:00:00Z`（周六 10:00 北京）。

**文件规模变化**：阶段 1 落地 242 行 → 阶段 2 早期（估值器用例 + T-R1-f）≈367 行 → 本次 **382 行**（T-R1-e 段由估值器口径改写为门控口径，净增均为注释与新增 e3 用例，无删断断言）。

**变异测试（鉴别力证据）**：临时把 `silenceThresholdMs()` 改成恒返回 `WS_INBOUND_SILENCE_MS`（拆掉门控）⇒ `T-R1-e2` **变红**（`expect(sock.closeCalls).toBe(0)` 收到 1），其余 7 条仍绿；随后已还原（`grep 'tradingSession(new Date())'` 命中恢复）。⇒ 新用例确实能捕获「门控失效」这一回归。

## 6. Verification（自测与门禁输出）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd web && npx vitest run` | **63 files / 605 tests 全绿**（`Test Files 63 passed (63)`，`Tests 605 passed (605)`，5.19s） |
| 2 | `cd web && npx tsc -b` | **exit=0**（`TSC_EXIT=0`，无输出） |
| 3 | `./scripts/check-tangle.sh` | **exit=0**：`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。` |
| 4 | 临时实例 e2e（G16/G18，临时端口） | `E2E_BASE_URL=http://127.0.0.1:18199 npx playwright test kline-matrix.e2e.ts -g "G16\|G18" --retries=0` → **2 passed (9.5s)**（G16 5.0s / G18 4.2s） |
| 5 | 变异测试（见 §5） | 拆门控 ⇒ `T-R1-e2` 红（1 failed / 7 passed）；已还原并全绿 |

临时实例装置（全程只读、临时端口，已全拆）：后端二进制 `./target/debug/eestock-app`（既有构建，非本轮重编），
配置 `listen=127.0.0.1:18199` / `mcp=127.0.0.1:18198` / `static_dir=/tmp/ws2_e2e/dist` /
`database_url=…?options=-c%20default_transaction_read_only%3Don`（只读事务）；
前端 `VITE_API_MOCK=0 npx vite build --outDir /tmp/ws2_e2e/dist`（**刻意不写入 `web/dist`**——线上 8081 的
`static_dir=./web/dist`，重编它等于改线上行为）。收尾：kill 临时 PID 3074042、`ss` 确认 18199/18198 已释放、
`rm -rf /tmp/ws2_e2e`；线上 PID 2948632 未触碰（`/healthz`=200）。

## 7. Architecture alignment

- 改动全部落在 **web 前端传输层** `web/src/ws/`（WsClient）与其**单元/集成测试**，以及 `design/` 散文；
- 新增的唯一依赖是**同仓库内既有** `@/shell/session`（`feed.ts` 已在用，架构师本阶段明确要求复用同一口径）；
  未改 ABI / 引擎 / ExecutionPolicy / `dcap.ts` / 后端 / 协议，未新增第三方依赖；
- `onStatusChange` / `subscribe` / 重连退避 / `feed.applyRealtime` / `realtimePoll` 等**接口与契约零变更**。

## 8. Problem solved / feature added

症状（诊断 R1）：WS 半开时连接状态长期滞留 `open`、永不重连（用户必须手动刷新）。阶段 2 早期用「自适应静默估值器」
兜住该问题，但 ① 在真实订阅形态下（AppShell 恒订阅 `source_health`、store 恒订阅 `quote`）几乎不生效
（活跃期 health ≈3.4s 一张 ⇒ 永远有帧）；② 引入 4 常量 + 4 字段 + 2 方法 + 4 处系数不一致（1.5/2.5）的可维护性负担。
本次**只做减法**：删掉估值器，改为**按交易时段门控的固定阈值**（交易 15s / 非交易 300s），行为契约不变
（任一入站帧复位；超阈值 ⇒ 主动 close → 既有指数退避重连 → 状态立刻离开 open → 重连成功后一次 HTTP 增量补偿）。

## 9. 观察项（非阻断，按「只做减法」口径记录，未扩大范围）

- 阈值在**武装时刻**求值（`armWatchdog()` 调 `tradingSession(now)`）：若静默期间跨过时段边界，计时器保留武装时的阈值。
  两个方向都可接受：① 交易时段武装的 15s 计时器跨到午休/收盘仍会触发一次（偏**激进**但只多一次自愈）；
  ② 盘前/午休武装的 300s 计时器跨到 09:30/13:00 开盘后仍等满 300s（开盘瞬间的最坏自愈延迟 ≈5 min，bar 仍有 60s HTTP 兜底）。
  本轮**不做**边界重算（那会重新引入「策略」复杂度，与「只做减法」冲突）；如后续要收敛，建议单开一条最小改动（在时段边界重排计时器）。
- `WS_INBOUND_SILENCE_MAX_MS` → `WS_INBOUND_SILENCE_OFFHOURS_MS` 的重命名：全仓库 grep 确认仅本文件/本测试引用，属内部模块常量（非跨层接口），未构成接口变更。
- 未向线上 8081/8082 发任何写请求（本轮仅对**临时实例** 18199 做只读/GET 与 WS 注入 e2e）；未 `git add/commit/stash`（工作区**无暂存文件**）。
