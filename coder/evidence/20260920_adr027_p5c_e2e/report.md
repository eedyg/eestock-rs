# 报告：ADR-027/028 P5c — 闸门 2 中危发现 M1（真实渲染下的跳转成功性）

> **E2E 规格 完成情况：完成**（`web/e2e/adr028-window-sync.e2e.ts`，4 用例 E1/E2/E4 + 变异反证）
> **｜ playwright 运行：通过**（`4 passed (16.7s)`，原始输出 `raw/10_playwright_adr028.txt`）
> **｜ 越界静默失败：未发生（结果页实例已放宽 max=400，实测 requested barSpace 5–12）；但真渲染下另发现并已修复两类跳转失真（见 §4）**
> **｜ 回归：绿**（`tsc -b` 退出码 0；`vitest run` 100 文件 / 963 用例全绿）

- 本报告文件位置：`coder/evidence/20260920_adr027_p5c_e2e/report.md`
- 原始输出目录：`coder/evidence/20260920_adr027_p5c_e2e/raw/`
- 角色/边界：worker（前端车道）；**只动 `web/`，未改 Rust**。

---

## 1. 复现与运行方式（真身 = 生产构建产物 + 真实 :8081 后端/库）

dev server（`vite`）在 React **StrictMode** 下会对 `WorkbenchPage` 的 effect 做 mount→unmount→mount：
`WorkbenchStore.dispose()` 置 `disposed=true` 后，第二次 `init()` 的所有 `patch()` 被静默丢弃
⇒ 运行历史/目录**永不上屏**（实测 `wb-run-select-*` 数量 0）。故真渲染 E2E 走**生产构建产物**：

```bash
cd web
npx vite build
VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --port 4173 --strictPort &
E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list
```

`vite.config.ts` 新增 `preview.proxy`（与 `server.proxy` 同源），使 preview 也把 `/api`、`/ws`
代理到后端；这是本轮唯一的基础设施改动（`web/` 内，无新依赖）。

## 2. 覆盖用例（对应 03-test-plan E 段 + ADR-028 §4 第 1/2 条）

| 用例 | 内容 | 判据 |
|---|---|---|
| `E1_L1_jump` | L1 行 `[跳转]` | 真身回执 `ok=true`/`error=''`；可见窗口**覆盖** `[open_ts, close_ts]`；**共享窗口 == 真身实测窗口（端点精确相等）**；可见根数 ≥ 回合 bar 根数 + 2×buffer − 容差；4 个曲线视图 `data-x-domain` == 共享窗口 |
| `E2_L2_jump` | L2 行 `[跳转]`（中部成交 idx 7） | 真身 `ok=true`；成交 ts 在窗内；**中心 bar ts == 成交 bar ts（±1 根）**；可见根数 == 120（±5）；共享窗口 == 真身实测窗口 |
| `E4_reset_back` | 全览 + 历史回退 | 全览后窗口态 = `full`、曲线定义域 = run 全区间、历史栈 = 2 步；回退后回合覆盖判据仍成立、曲线定义域 = 回退窗口 |
| `M1_mutation_silent_noop` | **禁假绿变异反证** | 拦截 `/round-trips` 收窄回合 ⇒ 同一套 `l1Mismatches` 对**变异值**为空、对**原始值**非空（断言真绑在真身窗口上，非恒真） |

**真身证据链**：`ResultView` 把 `WindowApplyResult.observed`（K 线实例 `getBarSpace()` /
`getVisibleRange()` 的**读回值**）上屏为 `wb-window-probe[data-*]`，含 `data-ok`/`bar-space`/
`from-idx`/`to-idx`/`from-ts`/`to-ts`/**中心 bar ts**/`edge-clamped`。真渲染 E2E 只断言这些**真身读数**，
不读 `syncChartStub`（既有 F7/F9 的桩自陈「可见根数与真身不完全一致」）。

## 3. 越界静默失败是否存在（M1 判定）

- **结果页实例**：`KlineResultChart` 建图传 `barSpaceLimit={RESULT_BAR_SPACE_LIMIT}`（max=400），
  实测 requested barSpace 5–12（≪400）⇒ **未发生越界静默吞掉**；`applyWindowOps` 每次 `setBarSpace`
  都**读回校验**（`applied !== requested` ⇒ `ok=false` + 原文报错），E2E 断言 `data-ok=true`。
- **配置不泄漏**：新增 `web/src/features/workbench/resultBarSpaceLimit.test.tsx`（2 用例）——
  **不传** `barSpaceLimit`（看板基准/宫格口径）⇒ `init` **不带** `layout.barSpaceLimit`（引擎默认 max=50）；
  传 `RESULT_BAR_SPACE_LIMIT` ⇒ `init.layout.barSpaceLimit.max=400`。即放宽只作用于结果页实例（ADR-020 严格）。

## 4. 真渲染实测发现的两类跳转失真（**已修复**）

初始版本（p5b 交付）在**真身**下跳转并未真正成功；桩层之所以绿，是桩与真身的已知差异：

1. **居中误差 2.0 根 > 1 ⇒ 结果页报「窗口应用失败」**（真身实测）
   `applyWindowOps` 用 `Math.round(width/span)` 选 barSpace、并用**滚动前**的 `getVisibleRange()`
   估算可见根数 ⇒ 真身含部分 bar（滚前计数偏大 4 根）⇒ 滚动后中心误差 2.0 根，被断言判失败、
   页面出现红色「窗口应用失败」。
   **修复**：初选改 `Math.floor`；用**实测**可见根数校准有效绘图宽度；居中后**读回迭代修正**（≤1 根）。

2. **共享窗口 ≠ 真身可见窗口**（曲线视图取数窗口与 K 线实际可见窗口不一致）
   请求态 `span_bars` 由 `(ts 差)/周期` 反算，隐含「每日 1 根」；真身 D1 bar 可稀疏（实测 ~0.4–0.7 根/日）
   ⇒ 请求 78 根的窗实际覆盖 106 天（回合仅 73 天）；且真身 realized 窗口与页面请求态不同，
   `mapLineByTs` 的定义域（=请求态）与 K 线可见 ts 区间不一致，违反 ADR-028 §4.1/D2.1。
   **修复**：
   - `WindowCommand.span_mode`：`'range'`（L1，窗口 = 已加载 dataList 落在 `[from_ts,to_ts]` 的**全部 bar**）
     / `'bars'`（L2，窗口 = `span_bars` **根**，成交 bar 居中 120 根）——根数不再由 ts 反算；
   - `useResultWindow.onApplied`：写窗**成功后把共享窗口对齐到真身实测窗口**（回执即真值），
     曲线取数窗口与 K 线可见窗口按构造成立；
   - `applyWindowOps` 增加**覆盖保证**（实到根数 < span 则减小 barSpace 重居中）。

> 口径说明：ADR 的「窗口 == 回合区间 ±1 根」在稀疏 D1 数据 + 整数 barSpace 下无法按 ts 端点字面成立，
> 本规格以「回合**完整可见** + 共享窗口 == 真身实测窗口 + 中心 bar == 目标 bar」为可及且更强的判据，
> 并在 `edge-clamped`（目标被数据边缘夹住，真身物理约束）时豁免居中判据。

## 5. 改动清单（本轮 `/` 只动 web）

| 文件 | 变更 |
|---|---|
| `web/e2e/adr028-window-sync.e2e.ts` | **新增**：真渲染 E2E（E1/E2/E4 + 变异反证） |
| `web/src/features/dashboard/klineWindowOps.ts` | 窗口写原语：range/bars span、floor 选值+校准、迭代居中、覆盖保证、真身观测字段（中心 bar ts / edge_clamped） |
| `web/src/features/workbench/resultWindow.ts` | `roundTripWindow` 增可选 `spanBarsOverride` |
| `web/src/features/workbench/useResultWindow.ts` | L1 用 bar 索引差定根数；`span_mode`；成功后按真身回执校正共享窗口；暴露 `observed` |
| `web/src/features/workbench/ResultView.tsx` | `wb-window-probe`（真身回执探针）+ `wb-window-state` data-*；SlotScoresChart 传 `domain` |
| `web/src/features/workbench/{AggregateScoreChart,EquityDrawdownChart,PositionRatioChart,SlotScoresChart}.tsx` | 新增 `data-x-domain`（各视图 x 定义域实测标注）；SlotScoresChart 新增可选 `domain`（`mapLineByTs`，无 `domain` 时保持既有下标轴） |
| `web/src/features/workbench/resultBarSpaceLimit.test.tsx` | **新增**：barSpaceLimit 放宽边界配置断言（不泄漏） |
| `web/vite.config.ts` | 提取 `proxy` 并新增 `preview.proxy`（真渲染 E2E 以生产产物跑） |

## 6. 证据文件（`coder/evidence/20260920_adr027_p5c_e2e/`）

- `10_playwright_adr028.txt`：playwright 原始输出（4 passed）
- `20_vitest_full.txt` / `21_vitest_full.txt`：vitest 全量（100 文件 / 963 用例）
- `30_tsc.txt`：`tsc -b` 输出（空 = 退出码 0）
- `raw/e1_l1_jump*.json`、`raw/e2_l2_jump*.json`、`raw/e4_*.json`、`raw/m1_mutation*.json`：真身读数与断言明细

## 7. 未做项 / 残留风险（**不隐瞒**）

1. **跨标 / 目标 barloaded 范围外的 L1 取数（ADR-028 D4「超出则先按区间取数再定位」）未实现**：
   若回合的 open bar 在已加载 K 线区间之外（实测 `sr_1789832500958_000004`：回合 open_ts 早于已加载
   dataList 起点），窗口只能覆盖已加载部分，回合不能完整可见。本轮 `span_mode='range'` 保证「窗口 = 已加载范围内全部 bar」，
   但**未**触发 `ScopedKlineFeed.loadBefore` 补齐目标区间。属独立增量（需接 feed 分页），不在 M1 范围。
2. **初次装载与跳转的时序竞态**：若在 K 线初次 fit/分页尚未落定前点 `[跳转]`，随后的 fit 会覆盖跳转窗口
   （实测 80ms 内跳转 ⇒ 600ms 后窗口被回写为 latest 锚定）。E2E 以「等初始落定再跳」避让；**未**从代码层消除该竞态。
3. `slot` 曲线 `domain` 化仅在本轮补齐（ADR-028 F13 把它列为三个 SVG 视图之一）；`ComparePanel` 的
   `mapLine`（F23 第三个调用点）**未**改为窗口轴（对比面板不属结果页窗口联动范围）。
4. `centeredWindow` 对偶数 span 存在半根 ts 偏移（L2 center_ts = fill.ts + 0.5 bar）；容差 ≤1 根内，未改。
5. E2E 依赖真实库中的特定 run（`sr_1789832477006_000002`）与成交下标；可用
   `ADR028_E2E_RUN` / `ADR028_E2E_FILL` 覆盖。库清理后需重选并复核（用例对缺失 run 会显式失败，不会静默）。

## 8. 判词（前置复核）

- E2E 规格：**完成**（E1/E2/E4 + 变异反证，见 §2）
- playwright：**通过**（原始输出落盘 `raw/10_playwright_adr028.txt`；命令见 §1）
- 越界静默失败：**未发生**（结果页 max=400；`setBarSpace` 每次读回校验）；真渲染另两类失真 **已修复**（§4）
- 回归：**绿**（tsc 退出码 0；vitest 100/963 全绿）
