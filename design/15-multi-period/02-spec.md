# 多周期指标同显 — 规格与接口契约

> 依据：`01-adr.md`（ADR-022，路线② + 12 条口径）。测试：`03-test-plan.md`。派单：`04-implementation-plan.md`。
> 术语：**基准实例** = 显示 K 线的最小周期图表；**卫星实例** = 只显示指标 pane 的高周期图表。

---

## 1. 组件与职责

| 组件 | 职责 | 备注 |
|---|---|---|
| `MultiPeriodChartStack`（新） | 垂直堆叠基准 + 卫星实例；高度分配与拖拽；多周期开关 | 仅单图模式挂载 |
| `ChartSyncGroup`（新） | 注册 N 个 chart 实例；时间跨度对齐；重入抑制；回到最新 | 无 UI |
| `addOverlayIndicator(chart, spec)`（新） | **唯一**允许在 `candle_pane` 叠加指标的入口 | 见 §4.3（硬约束） |
| `MultiPeriodPeriodPicker`（新） | 两步选择（先 K 线周期，再指标周期）+ 规则校验提示 | 复用 Toolbar 既有样式 |
| `multiPeriodStore`（新） | 运行态（启用/周期集合/高度/同步统计） | 与既有 dashboard store 并列 |
| 既有 `KlineChart` / `KlineDataFeed` / `realtimePoll` / dcap 模板 | **复用，不重写** | 每实例一份 feed |

## 2. 配置契约（服务端）

落既有 `ConfigStore`/`app_config`，**key = `multi_period`**（无需迁移，先例：`kline`/`dcap`）。

```jsonc
{
  "enabled": false,              // 多周期开关（默认关 ⇒ 行为与现状完全一致）
  "periods": ["1m", "5m", "15m"],// 首个元素 = 基准（K 线）周期；其后 = 卫星指标周期
  "heights": { "1m": 420, "5m": 180, "15m": 180 }, // 每实例高度 px（含基准）
  "indicators": ["dcap"]         // 卫星继承的指标集合（首版：dcap；通用框架下逐项扩展）
}
```

- 端点：`GET/PUT /api/config/multi_period`（形状照 MA/dcap 三层：`dto` 校验 + `rest` 端点 + `ConfigStore`）。
- **校验（PUT 严格 400，GET 坏值回默认不 500）**：
  1. `periods[0]`（基准）∈ 全部周期 \ {`1mo`}；
  2. 卫星 `periods[i>0]` ∈ 全部周期 \ {`1mo`} 且 **≥ 基准**；
  3. **若 1w 出现，则基准必须 ≥ 1d**（口径 10）；
  4. **总周期数 ≤ 4**（口径 2）；
  5. `heights` 键必须与 `periods` 一致，每值 ∈ [80, 1200]；
  6. `indicators` ⊆ 受支持集合（首版仅 `dcap`），去重；
  7. 去重后周期不重复。
- 与 `GET /api/config/dcap` 的关系：多周期**不新增参数**，共用同一套 8 参数（口径 5）。

### 2.1 基准周期规则（架构裁决 2026-09-14，方案 A）

```
basePeriod = enabled && periods.length > 1 ? periods[0] : 工具栏/state.period
```

- **只有实际存在卫星（`periods.length > 1`）时，基准周期才由配置决定**（即 `periods[0]`，与用户口径 5「先选 K 线周期」一致）；
- **单周期配置（`length === 1`，即启用但未选卫星）不得改变任何现状行为** —— 不新增订阅/取数/实例、`init` 不递增（即 P1 已验证的等价性契约）；**不得静默改写用户工具栏选的 K 线周期**；
- 当基准周期**因配置而被覆盖**（`length > 1` 且 `periods[0] !== state.period`）时，必须**显式可观测**（如 `basePeriodOverridden: true` + 基准周期来源字段），**禁止静默不一致**；待 P5 两步选择器落地时，由选择器同时写 `periods[0]` 与 `state.period` 来消除该状态。
  - **派生公式（专项裁定 2026-09-15，P5.5 红测试发现）**：
    ```
    overridden = enabled && periods.length > 1 && periods[0] !== state.period
    ```
    即**必须比较 `periods[0]` 与 `state.period`**，不能只看 `length > 1`（否则双写后覆盖态**永远为 true**、`[data-mp-base-override]` 徽标永不消失、§2.1 的一致态无法达成）；
  - 徽标语义：它用于暴露**外部造成的**不一致（例：另一终端改了配置），**不是**选择器自身提交动作的产物 ⇒ 选择器提交后 `overridden` 必须为 **false**。
  - **实现落位（P5.5 落地，架构裁定）**：`MultiPeriodState` **不再持有** `basePeriodOverridden`/`basePeriodSource` 快照字段（快照会过期）；改由 `resolveBasePeriod(periods, toolbarPeriod)` 在读处**现算**。**可观测性仍成立**：由 DOM 徽标 `[data-mp-base-override]` 携带（tester 已用变异验证：去掉 `state.period` 双写 ⇒ 徽标 = 3 ⇒ 可区分），故**不要求**持久化快照字段。

## 3. 同步契约（`ChartSyncGroup`）

### 3.1 API

```ts
interface SyncMember { id: string; chart: Chart; period: Period; isBase: boolean; }
class ChartSyncGroup {
  constructor(members: SyncMember[]);
  /** 任一成员发生 onScroll/onZoom/onVisibleRangeChange → 以时间跨度对齐其余成员 */
  start(): void; stop(): void;
  /** 全部成员右端对齐（"回到最新"） */
  scrollAllToLatest(): void;
  /** 应用卫星的 barSpaceLimit（仅卫星；基准不动） */
  applySatelliteLimits(): void;
}
```

### 3.2 对齐算法（以**时间跨度**为准，口径 8/9）

1. leader 可见窗 `[realFrom, realTo]`（时间戳）→ 目标跨度 `span = realTo - realFrom`；
2. follower：**barSpace 用「实测密度比 D」而非名义周期比**（P0.3 实测：非连续序列下名义比不成立 —— 1d↔1w 名义 7 而实测 D≈4.67）：
   `barSpace = clamp(baseBarSpace × D_effective, 1, followerMaxSpace)`；`scrollToTimestamp(center)`；
   **实测锚定表**（P0.3，pane 宽 520px，误差=两侧日历跨度差）：

| 组合 | 名义比 | 实测 D | @baseBS=8 误差 | 卫星可见 bar @baseBS=50 | 判定 |
|---|---|---|---|---|---|
| 1m→5m | 5 | 4.7 | +3 min | 3 | ✅ |
| 1m→15m | 15 | 12.2 | +28 min | 2 | ⚠️ baseBS>21 时退化 |
| 1m→1h | 60 | 37.8 | +58 min | 1 | ❌ baseBS>7 时退化 |
| **1d→1w** | 7 | **4.67** | **+4,320 min（+0.43 周 bar）** | 3 | ✅（必须用密度比） |
| 1h→1w | 168 | 24 | +1,980 min | 1 | ❌ baseBS>11 时退化 |
| 1m→1d / 1m→1w | 1440 / 10080 | 120.5 / 无重叠 | 失效 | 1 | ❌ 恒退化 |

**密度取值口径与来源可观测（287 修复，父级裁决 2026-09-15）**：`ChartSyncGroup` 的有效密度比按
**固定优先级**解析，且**来源必须可区分可读**（`stats.densityByFollower[<跟随者周期>].source`）：

1. **实测锚定表命中**（上表，正/反向）⇒ `source='static'`；
2. **同锚点合成**（本修复新增的放行面）⇒ `source='composed'`，
   `D(base→sat) = D(锚→sat) / D(锚→base)`（锚 = 实测表中共同的上游基准）：
   `D(5m→15m) = 12.2/4.7 ≈ 2.596`、`D(5m→1h) = 37.8/4.7 ≈ 8.043`、`D(15m→1h) = 37.8/12.2 ≈ 3.098`；
   表内组合也可由同锚点还原（`D(1d→1w) = 4.67`，同周期 ⇒ `1`）；
3. **运行时估计**（同一交叠 ts 窗内 `baseBarCount / satBarCount`）⇒ `source='measured'`；
4. 三者皆不可用 ⇒ `source='none'`（**真无公共锚点**：`5m/15m/1m/1h ↔ 1d`、`5m/1m ↔ 1w`、含 `1mo` 等）
   ⇒ 该卫星**不可同步**（按 §7.6 排除 + 可见角标），**禁止**按名义周期比兜底。

守门口径随之统一（口径 10 的运行时面）：`isSyncCombinationAllowed(base, sat) === true` **当且仅当**
「同周期 ∪ 实测表命中 ∪ 同锚点合成可用」；**既有护栏全部不变**（卫星周期 < 基准 ⇒ false；含 `1mo`/
未知周期 ⇒ false；`1w` 需基准 ≥ `1d` ⇒ false）。组合判定与「排除原因码」同源：
`unsupported-period` > `satellite-lower-than-base` > `week-requires-day-or-above` > `no-shared-anchor`。
**来源诚实性**：实测表命中**不得**被标注为 `composed`（反之亦然）—— 页面/日志据此可区分「实测」「合成」「估计」。

3. **卫星 `barSpaceLimit.max` 必须放宽**（默认 50 会**静默吞掉**大倍率：实测 req 350 被忽略、零告警）：建议 **max = 350**（1d→1w 实测需 satBS≈42–45 px/bar，即 ≈5.0×baseBS）；**放宽仅作用于卫星，不得泄漏到基准**（实测：req 60/350/5000 在基准读回仍为 50）。
4. **新增硬约束（P0.3 发现）：卫星可见 bar ≥ 2**。口径 8 的"跨度差 ≤1 根高周期 bar"在退化状态（卫星仅 1 根 bar）会被**虚假满足**（实测 0.54–1.00 周 bar）⇒ 不得只看跨度判据。
5. **降级策略（用户裁决 2026-09-14，方案 1：诚实降级 + UI 标注）**：当推导出的 `satBS > paneWidth/2`（即无法容纳 ≥2 根 bar）时：
   - 卫星取「能容纳 **≥2 根** 的最大 `barSpace`」（而非推导值），**右端对齐**；
   - 该 pane 显示角标「**对齐受限**」（含当前跨度与目标跨度的差异提示），**hover/点击给出原因**（当前基准缩放过大 ⇒ 请缩小基准图或改选周期）；
   - **严禁静默虚假对齐**：不得因为"跨度判据恰好通过"就隐藏该状态；实测中该状态的可观测字段（如 `syncDegraded: true` + 跨度差 + `unalignedFollowers`）必须可从页面/日志读出。
6. **判据分路径（架构裁决 2026-09-14，P3-D 实测不可达之后的澄清）**：
   - **对齐成功路径（非降级）**：跨度差 **≤1 根高周期 bar** 且 **右端差 ≤1 根** 且卫星可见 bar ≥2 —— 原口径**不变、不得放宽**；
   - **降级路径（仅当 reachability 探针证明不可达时）**：判据 = **卫星可见 bar ≥2** + **右端差 ≤1 根** + `syncDegraded`/`degradedPeriod` + **角标可读** + **统计可读**；并必须把**实测可达下界**（例：1m 基准 bs=8 ↔ 1h 卫星下界 2.37 根；真 1m ≈2.95 根）作为**记录项**写入证据与文档；
   - 注：单一 pane + 独立 barSpace 存在**物理下界**（引擎把 barSpace 夹到 ~300、可见恒 4 根；leader 窗远小于卫星最小可达跨度）⇒ 跨度等值**只适用于可对齐情形**，不得据此判降级态 FAIL；
   - **fail-closed**：必须先**尝试完整对齐**，只有 reachability 探针证明不可达才降级；降级原因与下界数值必须可读；**严禁在降级状态下宣称已对齐**。
7. **硬约束：基准实例永不作为 follower（架构裁决 2026-09-14）**：基准图视口只由 **ADR-020 + 用户手势**决定，**不得被卫星反向改写**（否则破坏 `visible ≈ viewport_bars` 与 `barSpace ∈[1,50]` 的推导口径；P3-D 实测该路径会把基准 barSpace 50→29）。用户若在**卫星**上拖动/缩放 ⇒ 以**该卫星**为 leader、对齐**其它卫星**，**基准保持不动**。此语义必须写进文档并由断言守护。
8. **barSpace 微调（允许，但有界、可观测、文档化）**：为把残差压到最小，闭环可在密度推导值附近微调 follower 的 barSpace（密度值是**初始估计**而非契约）；必须 ①有界（≤2 次迭代 + 每步幅度上限 + 确定性，震荡即停并降级）②可观测（记录最终值与推导值之差，如 `barSpaceAdjust`）③**不得用于基准**（见第 7 条）。
9. **定位手段（P3-C/P3-D 实测）**：**优先用 `scrollToDataIndex`（精确），不用 `scrollToTimestamp`**（真身后者固定短 2 根，且 `setOffsetRightDistance(0)` 消不掉）；定位后**读回残差**做有界闭环校正。
10. **可信实现要点（P0.3 遗留）**：① 索引窗按 ts 窗二分求解（名义比不成立）；② `satBS ≫ pane 宽` 时 `getVisibleRange()` 会返回 **NaN**，需显式降级；③ 高倍率缩入误差被整段休市缺口支配（1m↔5m @bs1 实测 1095 min）⇒ 按 ts 窗对齐边缘而非按根数；④ 右偏移镜像须按倍率换算；⑤ 密度表需静态回退（无重叠或卫星 ≤1 bar 时估计器失效）。
11. **验收口径（分路径）**：对齐成功路径要求「跨度差 ≤1 根高周期 bar **且** 右端差 ≤1 根 **且** 卫星可见 bar ≥2」三条同时成立；降级路径要求「卫星可见 bar ≥2 + 右端差 ≤1 根 + 角标/统计可读 + 下界已记录」。
12. 基准实例**始终**满足 ADR-020（`visible ≈ viewport_bars`，`barSpace ∈ [1,50]`）**且不得被同步改写**（第 7 条）；卫星 `barSpaceLimit.max` 取第 3 条的实测锚定值（**350**），不得用名义比启发式。

### 3.3 重入抑制（必须，P7b 实测 `reentrantCalls=1`）

- `applying` 标志 + **单向广播**：仅"用户交互源"实例作为 leader，其余为 follower；
- 应用同步后**忽略**短窗（实现取 ≥1 帧/16ms）内自 followers 回传的可见范围事件；
- 门禁：T3 必须证明"20 次镜像后无漂移、且无回声循环"（可观测计数 `syncApplied`/`syncSuppressed`）。

### 3.4 隐藏 K 线（卫星，P7a 唯一可行手段）

```
chart.setPaneOptions({ id: 'candle_pane', state: 'minimize', minHeight: 0 });
chart.setStyles({ separator: { size: 0 } });
```
- `height:0` 会被静默忽略（`index.esm.js:15421` 守卫）⇒ **必须用 `state:'minimize'`**；
- 副作用：零高 pane 存在时 `getConvertPictureUrl()` 抛 `InvalidStateError` ⇒ **禁止在 e2e/截图里用图表导出**，改页面截图（口径 §8「不做」）。

## 4. 指标契约

### 4.1 每实例复用基准的指标勾选集合

- 基准图勾选 `{MA, MACD, KDJ, BOLL, DCAP}` ⇒ **每个卫星都渲染同样的集合**（各自独立 pane），这就是"通用框架"：**注册表新增任何指标，多周期自动支持**（P7c：27 个内置在 4 实例零注册可用）。
- dcap 模板**零改动**（每实例用自己的周期 bar 计算）⇒ **路由② 下不存在跨周期值映射、无未来函数风险**（ADR-022 §2.1）。

### 4.2 LIVE 段（进行中桶）

- 卫星的末根 bar **就是**进行中桶 ⇒ 额外一个 `*_LIVE` 模板/图形，只画**最后一段**（末根与前一根两点）为虚线；已收盘段为实线。
- 一般规则（口径 4 的延伸）：**数据源不提供进行中桶的周期不画 LIVE 段**（实测 `1d` 无当日桶）。
- **进行中桶确实随分钟更新（定时探针 2026-09-15 09:35–09:42 真实盘中，PASS）**：同一未收盘桶、同一 `ts` 下被观测到 OHLCV 推进
  （5m `ts=09:35` C 8.847→8.842 / V 5,664,700→7,177,400；15m `ts=09:30`、1h `ts=09:00` 同桶 V 10,579,200→16,243,900→17,756,600）
  ⇒ 「只在桶边界跳」被**证伪**。**刷新粒度 = 采集周期 ≈60s**（非逐笔）；`ts = 桶开始` 在 5m/15m/1h 盘中成立（且排除"已收盘桶回溯修订"）。
  ⇒ LIVE 段的实时体感取决于 **每分钟兜底/WS 的取数节奏**（④ 已实现），而非桶边界。
- **✅ 1m 的 `ts` = 「分钟结束」标注（专项核实 2026-09-15，`END-MINUTE`；两条决定性证据）**：
  ① **厂商自身聚合恒等式**：`m5_0940 = 145199 == Σ(m1 0936..0940)`（桶首对齐 `Σ(0935..0939)=161747` ✗）⇒ 标号 `0931..0940` 覆盖 `[09:30,09:31)..[09:39,09:40)`；
  ② **两源实时轮询**：标号 `T` 的行在宿主分钟 `T−1` 内就已存在并累积（ifzq 与 sina 一致，非混源差异）。
  旁证：11 个已收盘交易日**全部 n=241**、首 `09:30` 末 `15:00`、`14:59` 恒 `v=0`、`15:00` 为收盘竞价量；DB `ingested_at` **早于标号起点**（`09:46` 于 `09:45:18` 落库）。
  ⇒ **例外**：每交易日首根 `ts=09:30` 是**开盘集合竞价行**（被并入第一个 5m 桶）。
- **LIVE 段锚点口径（据此钉死）**：**1m 卫星的 LIVE 起点 = `ts − 60s`**（末根 `ts` 视为桶尾）；**5m/15m/1h 维持桶首口径不变**（app 派发的高周期为桶首，已盘中验证）。
  ⚠️ **顺带发现的相位不对称（已知）**：厂商**原始** `m5/m15/m60` 序列是**桶尾**标注，而 app 派发的 5m/15m/1h 是**桶首** ⇒ **app 内 1m 与高周期的相位标注不同**；影响面限定为"把 bar 贴到哪个时刻 / 与宿主分钟比较 / 与高周期同刻对齐"的判断（**恒定右偏 1 分钟**），**不影响** `closes` 数值序列、也不破坏 ④ 的 `ts` 唯一键合并机制。跨周期同步的容差（≤1 根高周期 bar）在本相位差下仍成立。
- **开盘后可见性滞后（已知，非缺陷）**：实测 09:35:13 时 5m 序列**当日一根都没有**（末根=昨日 15:00），09:36:39 才出现 09:30/09:35 两根
  ⇒ **开盘后约 5 分钟内高周期卫星可能没有当日 bar（此时无 LIVE 段可画）**；UI 不得因此显示为错误（历史段照常渲染即可），验收也不得据此判 FAIL。

### 4.3 框架级硬约束：`addOverlayIndicator`（P7 根因）

```ts
/** 唯一允许在 candle_pane（或任何已有指标 pane）叠加指标的入口。 */
function addOverlayIndicator(chart: Chart, spec: IndicatorCreate, expectName: string): void {
  chart.removeIndicator({ name: expectName });        // 显式移除旧实例
  chart.createIndicator(spec, true);                  // 必须 isStack=true（追加语义）
  const ok = chart.getIndicators({ name: expectName }).length > 0;  // 断言非空
  if (!ok) throw new Error(`指标 ${expectName} 未生效（isStack 语义坑）`);
}
```
- **禁止**任何代码在已有指标的 pane 上以 `isStack=false`/省略 `isStack` 创建指标（`index.esm.js:14162-14165` 会**静默清空该 pane**，且 `createIndicator` 仍返回 id、零告警）；
- 现存违规点一并整改：`KlineChart.tsx`（MA 走 `false`）、`GridCell.tsx:86`；
- 回归测试必须覆盖"静默消失"（T7）。

## 5. 数据契约

- 每实例一个 `KlineDataFeed({api, ws, code, period, viewportBars})`（既有实现）；
- 取数：每周期 `GET /api/kline?period=P&limit=viewport_bars + warmup(P)`（warmup 仅当该实例显示 dcap：`n_l+m−1`）；
- 实时：每实例订阅 `bar:{code}:{period}`（P7c/④ 既有链路，零改动）；
- 每分钟兜底：`realtimePoll` 按 `(code,period)` 合并、并发闸 3 ⇒ **N 个周期 = N 个 key，不跨周期合并**（口径 11 已接受）；
- **预算护栏**：多周期模式仅单图 + 总周期 ≤4 ⇒ 每标的每分钟 ≤4 次兜底、≤4 个 WS 订阅；
- **禁止本地聚合**（口径：P4 实测本地 1m 聚合与后端高周期仅 50/208 桶一致）——每周期必须直接取后端 bar。

## 6. 布局契约

### 6.1 高度分配（P5，修纵向溢出）
- 栈容器 `h-full w-full flex flex-col min-h-0`（**只改手写 `MultiPeriodChartStack.tsx`，不改 tangle 生成物**）；
- 可用高度 H = 栈容器高度；需求 D = 各实例期望高度（`heights[period]`，默认基准 420 / 卫星 180）：
  1. **D ≤ H** ⇒ 按配置 px 直用，**余量由分配算法吸收**（不得依赖 `flex-1` —— 后者在 min-overflow 时会被压缩，与 Σ==可用/可滚动冲突）；
  2. **D > H** ⇒ **按比例缩小**，并夹取下界：**卫星 ≥80px、基准 ≥200px**；
  3. 连下界都放不下 ⇒ 栈 `overflow-y-auto` **退化可滚动**，并置**可观测状态**（如 `stackScrollFallback: true`），**不得静默**。
- **期望 px 必须始终落在配置域内**：拖拽只允许把**期望值**改写进 `[80,1200]`（即配置面校验域）；分配下界（基准 200 / 卫星 80）是**渲染侧**夹取 —— 两者不得混同，否则拖到域外的值会让 `PUT` 被拒并回滚（用户表现为"拖了但没保存"）。

### 6.2 拖拽与持久化
- 分隔条由**我们自己的容器**渲染，**不再由区域锥点 border 提供**（① 修复契约的直接应用）；
- 拖拽 ⇒ 乐观更新 + **防抖（300–500ms）持久化**到 `PUT /api/config/multi_period`；失败 ⇒ 回滚（形态照 MA/dcap）。
- **拖拽语义（架构裁决 2026-09-15，纠正之前的字面口径）**：拖拽对**各项期望值独立夹取**到 `[80,1200]`；夹取后若 `Σ期望 > 可用` ⇒ 走缩小路径。**不要求“拖拽保持 Σ期望 不变”**（那会让既有的渲染侧下界行为失效：实测基准会停在卫星下限而非基准下限 200）。
- **持久化载荷恒合法，渲染分配可越域**（重要）：`onHeightsChange` 产出的 `heights` **每一项必须 ∈ [80,1200]**；而**渲染侧分配**可以临时超出域（例：可用高度 ≥1201px 的 `fit` 路径让基准吸收余量 ⇒ 可能 >1200），因为强行夹取会破坏 `Σ==可用` 不变量。⇒ 断言口径为 **payload == clamp(DOM 末次分配高度, 80, 1200)**（当分配本就在域内时即为逐值相等）。
- **拖拽基线取“持久化域内的当前值”（架构裁决 2026-09-15，P5 最终验收 FAIL(5) 后补定）**：拖拽的起点必须是**载荷域内值**（即 `clamp(当前分配)`），**不是屏幕分配值**。理由：越域时（可用 ≥1201px 的 fit 路径）两者相差 ≤61px，以屏幕值为基线会出现“拖了但载荷不变”（死区）与重载后跳变；以载荷值为基线则**每次拖拽都单调改载荷**（无死区），屏幕由分配算法决定。
- **基准高度在 `fit` 模式下是“余量吸收项”**：其屏幕高度 = 可用 − Σ卫星，**其持久化值仅作记录**（不保证等于屏幕高）；⇒ 越域场景下“屏幕 vs 载荷”的偏差属**已知且允许**，但**必须在 UI/日志中不造成“拖了没反应”**（靠上一条基线规则保证）。
  - **偏差公式（P5 验收第二轮校正，取代夹具特定的 ≤61px）：`deviation = max(0, H − Σ卫星高度 − 1200)`**（H = 可用高度）⇒ 偏差**随 H 线性无界**（例：H=2000、卫星各 180 ⇒ 240px）。“≤61px”仅对 H≈1800 的固定夹具成立，**不得**当作普适上界。
- **依赖完整性（P5 验收 R1 的教训）**：任何影响 pane 高度/分配的 `useMemo`/`useEffect` **必须把卫星高度列入依赖**（实测缺依赖时父层回执只改卫星高度会被忽略 ⇒ 拖拽回弹、屏幕与服务端分叉）。

### 6.3 高度权威链（P5 接口语义，架构裁决 2026-09-14）
```
服务端配置（唯一权威） → 父层 props → 组件
```
- `onHeightsChange?: (heights) => void | Promise<unknown>`：
  - 父层**返回 Promise** ⇒ 表示父层已接管高度权威；**该 Promise settle（无论成功回显还是失败回滚）后，组件交还高度权威给 props**；
  - 父层**返回 `undefined`/未提供** ⇒ 组件保留本地拖拽结果（不受控模式）。
- **禁止跨挂载本地缓存**（module 级 / localStorage 均不得使用）：否则“服务端是配置权威”（P1）失效、其它标签页/终端改过的 `heights` 会被永久忽略；权威链只能走上述路径。
- 必测：父层 settle 后采用**服务端回显值**（成功）与**回滚值**（失败）两条路径都要有断言。

### 6.4 与既有契约的交互
- **保存 dcap 参数 / 切周期 / 切标的均不得重置任何实例高度**（T9）；
- 基准高度变化 ⇒ 走既有 ResizeObserver/ADR-020 路径（`visible ≈ viewport_bars` 仍成立）；
- 卫星高度变化 ⇒ 作为 follower 重新对齐（基准仍为锚点、**基准零写入**，ADR-022 §3.2 第 7 条）。

## 7. 护栏（必须实现为硬校验）

1. 多周期仅在**单图模式**可用（宫格模式隐藏开关并强制关闭）；
2. 总周期 ≤ **4**；
3. 卫星周期 **≥ 基准**，且不含 `1mo`；含 `1w` 时基准须 ≥ `1d`；
4. **总 pane 数上限 ≤ 12**（= 基准 1 + Σ卫星的指标 pane 数）：**计数必须基于「归一化（去重）后」的 `indicators` 集合**（P1-C D1 实测：按原始数组长度计数会把语义等价的 `["dcap"]×11` 误判为 23 pane）；超限时**明确报错并拒绝保存**（不静默截断），且错误信息**必须包含被拒维度名**（`indicators`/`pane`）；
   - 注：v1 受支持指标仅 `dcap` 且去重后 ⇒ 总 pane ≤ 4，**HTTP 层在 v1 无法构造 >12**（P1-C 已反证：未去重时的 400 是假象）；故该护栏先以 `web::dto` 纯函数测试守护，**P2 起受支持指标集合扩张后必须补 HTTP 级负例**。
5. 关闭多周期开关 ⇒ **完全回到现状**（单实例、单周期），不得有残留实例/订阅/请求。
6. **运行时同步护栏（287 修复，父级裁决 2026-09-15；替代「周期组合不可用即整组拒绝」）**：
   `ChartSyncGroup` 构造函数**不得**因单个卫星组合不可用而抛错（旧行为 + `console.warn` ⇒ 整组静默失效）：
   - 不可同步的卫星**只排除自己**：既不作为 leader、**也不被写入**（不 `setBarSpace`、不 `scrollToDataIndex`/
     `scrollToTimestamp`、不 `setOffsetRightDistance`），并从同步目标与右偏移归零集合中剔除；
   - 排除项（**周期 + 原因码**）必须可从 `SyncStats.excludedSatellites` 读出，且页面必须为**每个被排除卫星**
     渲染**可见角标**：`[data-mp-sync-excluded="<period>"]` + `data-mp-sync-excluded-reason="<reason>"`，
     文案含「未同步」、`title` 含可行动处置建议；非排除 ⇒ 该元素**不存在**（不得残留）；
   - 仅「**基准缺失**」或「**可同步跟随者 < 2**」才**不建立组**，且该情形必须有**页面可见状态**：
     `[data-mp-sync-group-unestablished]` + `data-mp-sync-group-reason="missing-base"|"no-syncable-follower"`
     —— **禁止只 `console.warn`**（旧行为的静默失效即缺陷根因）；
   - 原因码优先级（钉死）：`unsupported-period` > `satellite-lower-than-base` >
     `week-requires-day-or-above` > `no-shared-anchor`。
   既有硬约束**逐条不回退**：基准永不作为 follower、重入抑制（`SUPPRESSION_WINDOW_MS`）、有界闭环校正
   （`MAX_ALIGN_CORRECTION_ITERATIONS` / `MAX_BAR_SPACE_STEP_RATIO`）、诚实降级（`degraded`/`degradedPeriod`/
   `unalignedFollowers`）。

## 8. 明确不做（本轮范围外）

- `1mo` 周期（用户裁决）；
- **宫格内的多周期**（口径 4）；
- **跨周期值叠加**（把高周期指标值画到低周期轴上）—— 路线② 不需要它；若将来需要，ADR-022 §2.1 注记的"桶位移/as-of"约束将重新生效；
- 本地聚合替代高周期 bar；
- 图表导出截图（`getConvertPictureUrl` 在零高 pane 下抛错）。

## 9. 可观测性

- 每实例 `KlineDataFeed.realtimeStats`（既有）+ 聚合面板：每周期 `lastSource/lastWriteAt/lastPollOkAt/pollFailures`；
- 同步统计：`syncApplied` / `syncSuppressed`（重入抑制次数）/ 最近一次对齐误差（分钟）；
- **同步覆盖率与来源（287 修复，口径 C；禁止静默）**，`SyncStats` 新增字段：
  - `excludedSatellites: Array<{ period, reason }>` —— 被排除出同步的卫星（周期 + 原因码，空数组 = 无排除）；
  - `syncableFollowerCount: number` —— 可同步的跟随者数（不含基准）；
  - `groupEstablished: boolean` / `groupReason: 'missing-base' | 'no-syncable-follower' | null`
    —— 组是否建立与未建立原因（**未建立必须显式上报**，不得只 `console.warn`）；
  - `densityByFollower: Record<period, { ratio, source }>`，`source ∈ measured | static | composed | none`
    —— **每次对齐**记录各跟随者实际使用的密度比与来源（`5m↔1h` 必须为 `composed`；表内命中必须为 `static`）；
  - 组**（重）建后必须至少广播一次**统计快照（页面在任何用户交互之前即可显示「被排除 / 整组未建立」）；
    关闭态/组销毁 ⇒ 归零（`excludedSatellites: []`、`groupEstablished: false`、`groupReason: null`、`densityByFollower: {}`）；
- 页面可见状态（`web/`）：
  - 被排除卫星角标 `[data-mp-sync-excluded="<period>"]`（含 `data-mp-sync-excluded-reason`，文案含「未同步」，title 给处置建议）；
  - 整组未建立 `[data-mp-sync-group-unestablished]`（含 `data-mp-sync-group-reason`）；
  - 既有「对齐受限」角标 `[data-mp-sync-degraded="<period>"]` 语义**不变**（与上述角标并存，互不替代）；
- 失败可见：任一卫星初始化失败必须**可见报错**（不得静默降级为单图）。
