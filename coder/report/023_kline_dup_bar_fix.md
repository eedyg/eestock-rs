# 023 — K 线图「循环/重复 bar」严格 TDD 修复（仅前端展示层）

> 本报告文件位置：`eestock-rs/coder/report/023_kline_dup_bar_fix.md`
> 状态：RED→GREEN→Refactor 完成；单测 178/178 PASS、`tsc -b && vite build` PASS；已 `git add`（未 commit）供架构师复核。
> 范围声明：只改前端展示层（KlineChart 数据接线 + 新增纯函数适配器 + 单测）。**未触碰数据层**：`feed.ts`（KlineDataFeed 契约）、`api/`、DB、任何 SQL/缓存/Rust。

---

## 0. 结论摘要

- **缺陷**：klinecharts 引擎 `StoreImp._addData('forward')` 执行 `this._dataList = data.concat(this._dataList)` 且**不按 timestamp 去重**。旧 `getBars` 在 `type==='forward'` 时回传整段 `feed.bars`（含已渲染部分），于是每向前翻一页都把已渲染 bar 再叠一遍 → 重复按页数**平方级**增长。
- **修复**：抽出纯函数 `loadBarsForKc(feed, type, onInit?, toKc?)`，`forward` **只回调比已渲染最左 ts 更早的新增 delta**；`KlineChart` 的 `getBars` 改为调用该适配器，删除内联整段回传逻辑。
- **证据（RED）**：复现模型 `['init','forward','forward']` 下，引擎 list 由 init `len=5/unique=5` → forward(1) `len=15/unique=10`（5 重复）→ forward(2) `len=30/unique=15`（15 重复）。修复后 `len=unique`，无重复。
- **验证**：`npx vitest run`（23 文件 / 178 用例）全 PASS；`npm run build` PASS；真环境 `E2E_BASE_URL=http://192.168.50.100:8081` 跑 `kline-matrix.e2e.ts` **20 通过 / 1 失败（D9，预存在、与本次修复无关，见 §6.2）**。

---

## 1. 根因（已确证，未重新怀疑）

文件：`web/src/features/dashboard/KlineChart.tsx`（旧 `getBars`）。机制链：

1. klinecharts `StoreImp._processDataLoad('forward')` 触发 `getBars`,并把当前最左已渲染 bar 的 ts 放入 `params.timestamp`；
2. 旧代码 `callback(feed.bars.map(toKcData), { forward: feed.hasMore, backward: false })` 把**整个 `feed.bars`（含已渲染部分）**整段回传；
3. 引擎 `_addData(data,'forward')` 执行 `data.concat(this._dataList)`，**不查重** → 已渲染部分被重复前叠。

> 根因证据（tester 实测与本次复现均一致）：518880/1m 静止加载 1446 条/唯一 964；前翻 4 页 7230 条/唯一 2410。`feed.ts` 本身无重复，数据层对账 30/30 PASS。

---

## 2. TDD 步骤

### 2.1 Red（证明当前错误契约）

新增 `web/src/features/dashboard/klineDataLoader.ts` 初版：`forward` 仍回传整段 `feed.bars`（保留错误契约）。新增 `klineDataLoader.test.ts`，用**假 feed**（stub `bars/hasMore/loadInitial/loadBefore`）+ 模拟引擎 `engineAccept(data){ engineList = engineList.concat(data) }`（非查重）。

RED 失败证据（`npx vitest run klineDataLoader`）：

```
after init:     engineList len=5  unique=5    (无重复)
after forward:  engineList len=15 unique=10   (5 重复)
after forward:  engineList len=30 unique=15   (15 重复)
Test Files  1 failed (1)   Tests  2 failed | 1 passed (3)
```

- 核心用例 `[init,forward,forward]` 断言 `uniqueTs.size === engineList.length` 失败（30≠15）；
- 另一用例「forward 无新增应回空数组」也失败（旧实现回传非空整段 bars）。
- 即 RED 阶段出现 **重复 ts 证据**：10 个唯一被叠成 30 条（15 重复），与 tester 观察的平方级增长一致。

### 2.2 Green

把 `loadBarsForKc` 修正为契约：

```ts
if (type === 'forward') {
  const prevFirstTs = feed.bars[0]?.ts;          // loadBefore 前的最左（最早）已渲染 ts
  await feed.loadBefore();
  const delta = prevFirstTs
    ? feed.bars.filter((b) => Date.parse(b.ts) < Date.parse(prevFirstTs)).map(toKc)
    : [];
  return { bars: delta, forward: feed.hasMore };  // 绝不再回传已渲染部分
}
await feed.loadInitial();
onInit?.();
return { bars: feed.bars.map(toKc), forward: feed.hasMore };
```

测试转 GREEN：`Test Files  1 passed (1)  Tests  3 passed (3)`。

### 2.3 Refactor（接入 KlineChart，删除内联旧逻辑）

`KlineChart.tsx` 的 `getBars` 改为：

```ts
getBars: async ({ type, callback }) => {
  try {
    const { bars, forward } = await loadBarsForKc(
      feed,
      type === 'forward' ? 'forward' : 'init',
      type === 'forward' ? null : () => fitBarSpace(chart),
    );
    callback(bars, { forward, backward: false });
  } catch {
    callback([], { forward: feed.hasMore, backward: false }); // 兜底：保证 callback，避免 _loading 卡死
  }
},
```

其余（WS 实时 `rtCallback`、`subscribeBar/unsubscribeBar`、indicator 勾选、symbol/period 设置、realtime marker）**保持不变**。

---

## 3. 改动的文件与行数

| 文件 | 改动 | 层 |
|---|---|---|
| `web/src/features/dashboard/klineDataLoader.ts` | **新增**（51 行）：纯函数适配器 `loadBarsForKc` + `KlineDataFeedLike`/`LoadBarsResult` 类型 | 图表适配层（只依赖 feed 最小结构面 + `chartCommon.toKcData`） |
| `web/src/features/dashboard/klineDataLoader.test.ts` | **新增**（88 行）：3 用例（核心 forward 增量去重 / init 全量+onInit / forward 无新增回空） | 适配层单测 |
| `web/src/features/dashboard/KlineChart.tsx` | **修改**（18 行改动）：`getBars` 内联整段回传 → 调用 `loadBarsForKc`；`import { loadBarsForKc }` | 图表承接层（接 klinecharts DataLoader） |

`git diff --cached --stat`：`3 files changed, 151 insertions(+), 6 deletions(-)`。

---

## 4. 架构对齐

- **没动**：`feed.ts`（`KlineDataFeed` 契约/分页/去重均不变）、`api/client.ts`、DB、SQL、Rust。数据层对账结论（feed 干净、无循环）不变。
- **新模块归属**：`klineDataLoader.ts` 是「图表库→feed」的**适配纯函数**，不引入框架/dependency，不改接口签名（`getBars` 沿用 klinecharts 契约）。
- **注入点**：`toKcData` 以默认参数注入（`toKc: (bar: Bar) => KLineData = toKcData`），保证纯函数可测、无 side-effect（`chartCommon.ts` 只做 type-only import，零副作用）。
- **KlineDataFeedLike**：只声明适配器用到的 4 个成员，避免强依赖整个 `KlineDataFeed`，便于测试注入假 feed。

---

## 5. 验证输出

### 5.1 前端单测（`cd eestock-rs/web && npx vitest run`）

```
Test Files  23 passed (23)
     Tests  178 passed (178)
```

含新增 `klineDataLoader.test.ts (3 tests)` 与既有 `feed`/`DashboardPage`/`TimeshareChart`/`store` 等全部通过。

### 5.2 构建（`npm run build` = `tsc -b && vite build`）

```
tsc -b && vite build
✓ 96 modules transformed.
dist/assets/index-B9C79LHj.js  518.69 kB │ gzip: 151.35 kB
✓ built in 984ms
```

> `tsc -b` 首轮曾报 `klineDataLoader.test.ts(22,9): error TS2322`（`Record<string,unknown>` 自引用类型），已通过内部 `state` 可变对象重构消除，复跑 `tsc -b` 通过。仅存的 chunk>500kB 警告为既有现象，与本次改动无关。

### 5.3 真环境 E2E（`E2E_BASE_URL=http://192.168.50.100:8081`）

- `npx playwright test e2e/kline-matrix.e2e.ts -g "F14|A1"` → **2 passed**：A1 默认加载铺满无死区；**F14 向前滚动分页 `?before=` 无重复/缺口（可达≥10交易日）** 直接验证本次修复目标。
- `npx playwright test e2e/kline-matrix.e2e.ts`（全量）→ **20 passed | 1 failed（D9）**。

---

## 6. 跳过/关注项与残留风险

### 6.1 已执行 / 未跳过

- 未跳过 `npm run build`、`npx vitest run`、以及真环境 kline-matrix E2E（环境 192.168.50.100:8081 可达，HTTP 200）。

### 6.2 D9 失败说明（预存在、与本次修复无关）

- D9「切分时」在 `e2e/kline-matrix.e2e.ts:363` 断言 `period=1m&limit=480` 的 REST 请求被命中，实测 0 命中。
- 原因：`TimeshareChart.tsx` 用 `new KlineDataFeed({ api, ws, code, period: '1m' })`（**未传 pageSize**），按 `feed.ts` 默认 `defaultPageSizeForPeriod('1m')=BARS_PER_TRADING_DAY['1m']*2=241*2=482` 请求 **`limit=482`**，与断言 `limit=480` 不符。
- 该断言涉及的组件（TimeshareChart）与常量（feed 默认 pageSize）**均不在本次修改范围**；本次只改 KlineChart 数据接线与新增适配器。**结论：D9 为预存在测试-常量错配，非本修复引入的回归。** 建议由 tester/架构师评估是更新断言为 `482` 还是调整 `BARS_PER_TRADING_DAY['1m']`。

### 6.3 架构级发现（升级给架构师，未自行拍板）

- klinecharts `_processDataLoad('forward')` 会把**当前最左已渲染 bar 的 timestamp** 作为 `params.timestamp` 传给 `getBars`。本次 `loadBarsForKc`（forward）用 `feed.bars[0]?.ts`（loadBefore 前）推导「已渲染最左 ts」。两者在 feed 与引擎完全同步时等价；但理论上 `params.timestamp`（引擎实际渲染最左）**更贴近引擎视角、更抗 feed/引擎不一致**。建议架构师评估是否将 `params.timestamp` 传入 `loadBarsForKc` 作为前送游标的**首选来源**（本次为遵循已确证根因 + 最小改动，仍用 feed 推导，未改接口）。
- 另：klinecharts `forward` `data.concat(dataList)` 不做去重。若后续引擎换版本或新增 `backward`/`update` 数据路径，需复查适配层是否仍只回增量。

### 6.4 残留风险

1. **并发/空增量语义**：`loadBefore` 返回 0（无更早数据/并发被吞）时回 `{ bars: [], forward: feed.hasMore }`；若 `hasMore` 仍为 true，图表在用户再次左滚到边缘时会**重试**拉取（符合引擎 `_dataLoadMore.forward` 约定），不会叠加重复，但可能产生一次空请求。风险低。
2. **`backward` 未支持**：引擎在 `to===total && _dataLoadMore.backward` 时才触发 `backward`；本适配始终保持 `backward:false` 不触发。若未来开启反向加载需新增分支。
3. **D9 预存在失败**：见 §6.2，须由架构师/测试侧定夺，不在本修复内。
4. **`onInit` 传入时机**：`init` 分支在 `loadInitial()` resolve 后调用 `onInit`（= `() => fitBarSpace(chart)`），随后 `getBars` 调 `callback`。原实现是先 `callback` 后 `fitBarSpace`；顺序对视觉结果无影响（`fitBarSpace` 只设 barSpace），且仍保证 init 后固定一次。

---

## 7. 暂存状态

`git -C eestock-rs add web/src/features/dashboard/KlineChart.tsx web/src/features/dashboard/klineDataLoader.ts web/src/features/dashboard/klineDataLoader.test.ts` → 已暂存（未 commit）：

```
M  web/src/features/dashboard/KlineChart.tsx     (18 行改动)
A  web/src/features/dashboard/klineDataLoader.ts     (51 行)
A  web/src/features/dashboard/klineDataLoader.test.ts (88 行)
```

> e2e 产物 `web/e2e/artifacts/` 已被 gitignore，未被暂存。
