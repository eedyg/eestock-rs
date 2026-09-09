# 044 — 修复 ResultOverview 回撤着色负宽 + 平均持仓取整

**报告自身文件位置**: `web/../coder/report/044_resultoverview_drawdown_width_avg_hold.md`
（即 `/home/eestock/workspace/git/eestock/eestock-rs/coder/report/044_resultoverview_drawdown_width_avg_hold.md`）

## 根因确认

### 缺陷#1（中）：回撤着色 rect 负宽
`web/src/features/backtest/ResultOverview.tsx` 原回撤着色宽度公式：

```tsx
const w = eqPoints.length > 1 ? W - PAD * 2 : 0.5;   // W=1000, PAD=10 → w=980
width={(w / Math.max(eqPoints.length - 1, 1)) - 1}
```

即 `width = (980/(n-1)) - 1`。当净值序列点数 `n - 1 > 980`（即 `n > 981`）时，
`980/(n-1) < 1`，`width` 变为**负值**。React dev 环境对负宽 SVG rect 触发
`console.error: "Received \`-…\` for a non-negative attribute \`width\`"`；
run38 约 8103 个正回撤点 → 约 8103 次报错，且长序列回撤着色区间失效（被负宽破坏）。

另 n=1 时 `w=0.5` 且 `width = 0.5/1 - 1 = -0.5` 也为负（除零/负宽双问题）。

### 缺陷#2（观察）：平均持仓未取整
`MetricCards` 的「平均持仓」用 `fmtHoldBars(m.avg_hold_bars)`，后者直接
`return \`${bars}bar\``，将引擎原始值如 `16.99…bar` 原样展示，未取整。

## 改动

### `ResultOverview.tsx`（修复#1）
以点间距推导宽度，减去固定小间隙，并用最小可见宽兜底恒正、同时规避 n=1 除零：

```tsx
const plotW = W - PAD * 2;
const step = eqPoints.length > 1 ? plotW / (eqPoints.length - 1) : plotW;
const rectW = Math.max(0.5, step - 1); // 最小可见宽 0.5，无负宽、无除零
```

- `step`：相邻点间距（n>1 时 `plotW/(n-1)`；n=1 时取整段 plotW，避免除零）。
- `rectW = Math.max(0.5, step - 1)`：任何 n 下恒 ≥ 0.5（正），大 n 退化为最小可见宽，
  彻底消除负宽与 console.error；小 n 时行为与原先一致（接近点间距 - 1）。
- 仅改宽度推导，不改 x/height/opacity/着色逻辑。

### `format.ts`（修复#2 核心）
新增纯函数 `formatAvgHold(bars, period?)`：

- 空/NaN → `—`；bar≤0 → `0`。
- 有 `period`（M1/M5/M15/D1）时按 `bar × PERIOD_DAY_FACTOR` 换算为天/时/分（保留 1 位小数，
  整数去掉尾部 `.0`）。缺省/未识别周期则保留 bar 数（同样取整到 1 位）。
- 保留原 `fmtHoldBars` 不动（`CompareView` 仍依赖，避免越界改动）。

### `MetricCards.tsx`（修复#2 接线）
「平均持仓」卡改用 `formatAvgHold(m.avg_hold_bars)`（`fmtHoldBars` 导入替换为 `formatAvgHold`）。
说明：`MetricCards` 只有 `metrics`（`Metrics` 接口无 period），且铁律禁止改 `BacktestPage` 传 period，
故卡片显示 bar 数取整（如 `16.99…→"17bar"`）；`formatAvgHold(bar, period)` 的「天/时/分」换算
已实现并单测覆盖（如 `formatAvgHold(3.2,'D1')→"3.2天"`）。

## 测试覆盖（TDD）

### 新增 `ResultOverview.test.tsx`（缺陷#1）
- `1200 点长序列：全部 rect width>0 且不触发负宽 console.error`
- `1500 点长序列恒无负宽、全部为正`
- `短序列着色正确：仅回撤>0 处绘制 rect，宽>0`
- `n=1 单点不除零：rect 宽度为正`

### 新增 `format.test.ts`（缺陷#2）
- 无 period：`16.999→"17bar"`、`3.2→"3.2bar"`、`3.0→"3bar"`、null/undefined→`—`、0→`0`、负→`0`
- `period=D1`：`3.2→"3.2天"`、`1.0→"1天"`
- `period=M15`：`60→"15时"`、`144→"1.5天"`；`period=M1`：`3.2→"3.2分"`

## Red → Green 证据

- **Red**（修复前，仅写 #1 测试）：`npx vitest run src/features/backtest/ResultOverview.test.tsx`
  → `3 failed | 1 passed`，3 个长序列/n=1 用例均因 `width` 为负（`Number(width)<=0`）失败：
  - `1200 点`：`expected false to be true`（`widths.every(w=>w>0)` 不满足）
  - `1500 点`：同上
  - `n=1`：同上
- **Green**（修复后）：同一文件 `4 passed`；长序列全部 rect 宽度为正（1200/1500 点宽恰为 0.5），
  `console.error` 断言（非负宽相关报错为空）通过。

## 验证结果

- `cd web && npx vitest run` → **29 files / 226 tests 全绿**（含新增 8 用例）。
- `VITE_API_MOCK=0 npm run build` → **build 通过**（tsc -b + vite build 成功，产物 `dist/`）。
- `npx playwright test e2e/embedded-charts.e2e.ts` → 按任务说明**跳过**（本地未装 Playwright 浏览器缓存，
  且该用例与本改动无关）。

## 残留风险

1. `CompareView.tsx` 仍用 `fmtHoldBars` 展示平均持仓，会显示引擎原始小数（如 `16.99bar`）。
   本铁律限定只改 `ResultOverview`/`format`/`MetricCards`（+测试），未纳入 `CompareView`；如需一致取整，
   后续可在 `CompareView` 改用 `formatAvgHold`。
2. `MetricCards` 因无 `period` 且禁改 `BacktestPage`，卡片以 bar 数取整展示，未显示「天」。
   `formatAvgHold(bars, period)` 的天/时/分换算已实现并单测，但需 `period` 注入后才在 UI 生效。
3. 大 n（>~981）时 rect 宽退化为 0.5（最小可见宽），相邻 rect 间有约 0.3 视觉间隙，
   呈带状而非连续面；仍属正常渲染、无报错，符合「长序列正常渲染、着色区间正确」要求。
4. 本次未 commit、未 git add（`git diff --cached` 为空），工作区改动待父级审阅。

## 暂存/变更文件清单（待审阅，未 commit）

来源（tracked 修改）：
- `web/src/features/backtest/ResultOverview.tsx`
- `web/src/features/backtest/format.ts`
- `web/src/features/backtest/MetricCards.tsx`

新增（untracked）：
- `web/src/features/backtest/ResultOverview.test.tsx`
- `web/src/features/backtest/format.test.ts`

> 注：`web/tester/` 为任务前已存在的未跟踪目录，非本次改动。
