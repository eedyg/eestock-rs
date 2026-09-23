# 06-plan-d2.4-warmup-clip — ADR-028 **D2.4「评估段裁剪」**修改方案（分数曲线只画执行段）

> **裁决事实源**：`design/01-architecture/adr/ADR-028-result-visualization-position-ratio-and-window-sync.md` **§2.2e（D2.4）** + `design/99-decisions-log.md` 对应条目。
> **契约事实源**：本文 §2（与 ADR-028 §2.2e 逐条一致；**new 口径只在 ADR 裁决，本文不新增**）。
> **定位与取证**：`coder/report/adr028_curve_y_scaling_mismatch_analysis.md`（§0.0 截图像素取证、§8 实施记录、§8.4 门禁核对）。
> **状态**：**已实现、已自测通过；按用户 2026-09-22 决策「先只在本地留着，我自己看」而*未提交*，改动保留在工作区**。
> **方案**：**A（用户裁决）= 裁剪到执行段** —— 分数曲线不画 warmup 预热段。

---

## 1. 问题、判词与根因

### 1.1 现象（用户原话 + 截图取证）

用户报告：「聚合总分和各策略评分的缩放比例和净值不一样，导致显示错误」；复核后用户判词：
「**聚合和各策略评分的 scale 不对，净值是对的**」。

同屏四条曲线**横向范围不一致**（用户截图逐像素测量，坐标 = 截图 1176×1568 px）：

| 元素 | 实测覆盖 x 区间 | 占宽 |
|---|---|---|
| K 线蜡烛 | 0 → ≈1150 | ≈100% |
| 聚合总分（青方波） | ≈141 → ≈1092 | ≈83% |
| 各策略评分（淡紫方波） | ≈180 → ≈1140 | ≈85% |
| **净值 + 回撤** | **≈948 → 1150** | **≈17%** |
| **持仓比率** | **≈948 → 1080** | **≈12%** |

- 两处空白经对比度增强复核为**纯背景**（左区最大亮度仅比背景高 10~30，曲线本身高 90~130）⇒ 不是「太暗看不见」，而是**没有数据点**；
- 净值/持仓两张卡的绘图区网格线横跨整宽 ⇒ 卡片本身满宽，**不是布局问题**；
- 净值与持仓起点同为 x≈948（同一帧）、K 线柱距实测 ≈8.0 px/bar ⇒ 净值/持仓**与 K 线同尺度**（用户判词「净值是对的」在图上成立）。

### 1.2 根因（代码可查）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 引擎在 **warmup 段仍逐 bar 评分**（`per_bar.scores/aggregate` 全量记录并标 `warmup`） | `crates/strategy-core/src/engine.rs:937-959` |
| 2 | 引擎在 warmup 段**不产净值/回撤/持仓**（`if !is_warmup` 才 `nav.push` / `positions.push`） | 同上 |
| 3 | 四条曲线**共用同一 x 轴**（bar 索引空间 + 共用绘图区几何） | ADR-028 §2.2b（D2.1）、§2.2d（D2.3） |
| 4 | 前端类型**没有 `warmup` 列** ⇒ UI 完全不知道预热段存在，把预热段的分数当执行段画 | `web/src/api/types.ts`（`WorkbenchBarRecord`） |
| 5 | warmup 缺省 250 根（可被预设覆盖） | `design/12-strategy-system/01-adr.md` §13.5.1 |

⇒ 结论：**分数曲线的横向口径错**（多画了预热段），价值类曲线（净值/回撤/持仓）**是对的**。

---

## 2. 方案（契约，与 ADR-028 §2.2e D2.4 同一口径）

**方案 A：分数曲线不画 warmup 预热段** —— 曲线数据裁到 run 的**评估区间** `[from_ts, to_ts]`
（后端存 **effective** 区间 = in-range；`crates/application/src/workbench.rs:736,757`）。
K 线卡本就取 `[run.from_ts, run.to_ts]` ⇒ **四条曲线与 K 线同段对齐**。

**硬约束（6 条）：**

1. **评估段** = run 的 effective `[from_ts, to_ts]`（Unix 秒）；边界**含**端点；**只按 `ts` 判定**
   （不依赖 `warmup` 列 ⇒ legacy/旧 run 同样成立）。
2. `from`/`to` 不可得、不可解析、或 `from > to` ⇒ **不裁剪**（`dropped = 0`；坏数据不得静默清空曲线）。
3. **禁止静默有损**（ADR-024 D10）：裁剪根数必须回传（`RunCurve.excludedWarmupBars`）并由 UI 标注
   「（预热段 N 根不计入）」；脚注「共 N bar」口径改为「**评估段** 共 M bar」；
   N 优先取后端 `config.warmup_effective`（**精确根数**），不可得时回退为裁掉的点数。
4. **逐 bar 明细 / 事件日志（事实表）不裁**（预热段行保留；**只有曲线裁**）。
5. **不新增/不改 `/curve` 请求参数**（仍按 ADR-028 D3 窗口语义）；裁剪在客户端派生层 **单点**完成
   ⇒ 不触碰冻结规格对「全览 ⇒ 不传窗口参数」的口径。
6. 预热段内的点**不得**再计入「N 点不在 K 线 bar 序列上（已剔除）」这一**配对失败**披露
   （前者 = 按区间裁剪，后者 = K 线 bar 序列不可配，语义不同）。

**数据流（裁剪发生点）：**

```
后端 /curve?kind=per_bar        ──┐   含 warmup 行（warmup=true，ts < run.from_ts）
后端 /curve?kind=net_value/drawdown/position ──┐ 本就只有 in-range（无预热段）
                                               │
              useRunSeries（唯一取数入口）      │
                └─ clipToEvaluatedRange(per_bar, evaluatedRange(run))   ← 本次唯一新增裁剪点
                     └─ RunCurve{points, originalBars, excludedWarmupBars}
                          ├─ AggregateScoreChart  （points + sampling 披露）
                          └─ SlotScoresChart      （points + sampling 披露）
              x 定义域（resultWindow.ts）保持不变：主路 = K 线 bar 索引域；降级 per_bar 域本就按 [from_ts,to_ts] 过滤
```

---

## 3. 改动清单（文件级）

| 文件 | 类型 | 内容 | 影响面 |
|---|---|---|---|
| `web/src/features/workbench/runSeriesRange.ts` | **新增** | 纯函数 `evaluatedRange(run)`、`clipToEvaluatedRange(rows, range)` | 无副作用；可独立单测 |
| `web/src/features/workbench/useRunSeries.ts` | 改 | `RunCurve` 增 `excludedWarmupBars?`；chunked 与 legacy 两路径同口径裁剪 `perBar`；新增 `warmupExcludedBars()`；`legacySeries(result, range)` | 消费方：`ResultView`（两张分数卡）。`bars.rows` 路径**不变** |
| `web/src/api/types.ts` | 改 | `WorkbenchRunConfig` 补可选 `warmup_requested` / `warmup_effective` | 纯类型增量（后端 config 快照已有该两键） |
| `web/src/features/workbench/AggregateScoreChart.tsx` | 改 | `CurveSampling` 增 `excludedWarmupBars?`；脚注「评估段 共 M bar」+ `wb-aggregate-warmup-note` 披露 | 无预热段时文案与修复前一致（零回归） |
| `web/src/features/workbench/SlotScoresChart.tsx` | 改 | 同上（`wb-slot-warmup-note`） | 同上 |
| `web/src/features/workbench/runSeriesRange.test.ts`、`useRunSeries.test.ts`、`scoreCurveWarmupNote.test.tsx` | 新增/改 | 见 §5 | — |

**明确不改（本方案边界）：**

- `/curve` 请求参数与窗口语义（ADR-028 D3；不触碰「全览 ⇒ 不传窗口参数」冻结口径）；
- `resultWindow.ts` 的 x 定义域构建（降级 `per_bar` 域**本就**按 `[from_ts, to_ts]` 过滤，无需改）；
- 后端任何代码 / 迁移 / 序列语义（不为 warmup 段补净值点 —— 见 §7 残留②）；
- 逐 bar 评分表、事件日志、K 线买卖标记（事实源与标记管线）。

---

## 4. 边界与异常（逐条可测）

| 情形 | 行为 |
|---|---|
| run 的 `from_ts`/`to_ts` 缺一、不可解析、或 `from > to` | **不裁剪**（`dropped=0`，曲线与修复前一致） |
| 载荷里没有任何预热行（正常 run / 子窗口取数） | 逐元素不变，`excludedWarmupBars=0`，UI 不渲染披露 |
| 载荷含预热行且服务端**已抽样** | `excludedWarmupBars` 取 `config.warmup_effective`（精确根数）；不可得时回退为裁掉点数（UI 文案不变，数值为近似，已在 ADR 登记） |
| 空序列 / 单点序列 | 不抛错（返回空 / 单点），披露为 0 |
| 首/末点恰好等于端点 | **保留**（含端点语义） |

---

## 5. 测试方案（判据，TDD：先红后绿）

| 规格文件 | 例数 | 判据要点 |
|---|---|---|
| `runSeriesRange.test.ts`（新） | 7 | `evaluatedRange`：ISO→秒 / 缺端点 / 解析失败 / `from>to` ⇒ null；`clipToEvaluatedRange`：剔除前后、含端点、顺序保持、`range=null` 原样返回、空序列 |
| `useRunSeries.test.ts`（+2） | 8 | chunked：载荷含 3 根预热 + 2 根评估段 ⇒ `points` 只留评估段、`excludedWarmupBars=3`、`originalBars` **保持服务端口径**、净值不受影响；legacy：同口径；**无预热行 ⇒ 逐元素不变**（回归护栏）；`bars.rows` **不裁** |
| `scoreCurveWarmupNote.test.tsx`（新） | 3 | 两卡均渲染「预热段 N 根不计入」+「评估段 共 M bar」；无预热段 ⇒ 不渲染披露（零回归） |

**真渲染复验要点**（需有浏览器的环境；本容器无 chromium，未执行）：

1. 选一个 `warmup_effective > 0` 的 run（或 mock 合成）⇒ 断言聚合/各策略卡脚注出现披露、且 `polyline` 的**首点 x** 与净值卡首点 x 同段（同一 bar 索引位置）；
2. 断言 `/curve?kind=per_bar` 的 `original_bars` 与脚注「评估段 共 M bar」之差 == `warmup_effective`；
3. 反向用例：`warmup_effective = 0` 的 run ⇒ 脚注无披露、曲线与修复前逐点一致。

---

## 6. 执行与验证记录（本次已跑）

| 命令 | 结果 |
|---|---|
| `npx vitest run src/features/workbench/runSeriesRange.test.ts` | 红（模块不存在）→ 实现后 **7 passed** |
| `npx vitest run src/features/workbench/useRunSeries.test.ts` | 红（未裁剪）→ 实现后 **8 passed** |
| `npx vitest run src/features/workbench/scoreCurveWarmupNote.test.tsx` | 红 → **3 passed** |
| `npx vitest run src/features/workbench` | **22 文件 / 223 例全绿**（含冻结的轴对齐与窗口规格） |
| `npx vitest run`（全量 111 文件 / 1064 例） | 1062 passed / 2 failed —— **两个与本次无关**：`multiPeriodClosedEquivalence`（干净树同样失败）+ `StrategyEditorPage`（单独跑 17/17，并行 flaky） |
| `npx tsc -b` | 无输出（0 错） |
| `npx vite build` | 成功（`dist/` 已被 gitignore） |
| `entangled tangle` / `tangle -s` | `Nothing to be done` / exit 0 ⇒ 无代码回滚；本方案改动文件**不在** tangle 治理范围（无对应 `~/~ begin` 块） |
| `entangled stitch`（**误跑**） | ADR 文件「changed outside the control of Entangled」⇒ `breaking off`，**未写任何文件**；ADR-018 §1.7 明文禁止在真实仓跑全局 stitch ⇒ 已登记为流程失误，不再执行 |
| gitnexus impact | **不可用**（索引 `repoPath` 指向不存在的路径）⇒ 以文本调用点分析替代（影响面见 §3）并如实登记 |

---

## 7. 风险与残留（技术债，已登记 ADR-028 §5）

1. `per_bar.warmup` 列**未**暴露到前端类型 ⇒ 逐 bar 评分表 / 事件日志仍展示预热段行且**无预热标识**（本次只裁曲线）；
2. 净值/回撤/持仓在预热段仍为**空白**（不补点、不画平线）⇒ 观感上「净值只占右侧一小段」仍在，但四条曲线现已**同段**（这正是本次裁决的口径：净值是对的）；若日后需要「全区间可比」，须另裁（后端补点 `nav = 初始资金` 平线，或前端画预热分界线 = 方案 B）；
3. 抽样态下 `excludedWarmupBars` 在缺 `config.warmup_effective` 时为近似值（已用「优先取后端精确值」规避）。

---

## 8. 回退

```bash
cd /workspace
git checkout -- web/src/api/types.ts \
  web/src/features/workbench/useRunSeries.ts \
  web/src/features/workbench/useRunSeries.test.ts \
  web/src/features/workbench/AggregateScoreChart.tsx \
  web/src/features/workbench/SlotScoresChart.tsx
rm -f web/src/features/workbench/runSeriesRange.ts \
      web/src/features/workbench/runSeriesRange.test.ts \
      web/src/features/workbench/scoreCurveWarmupNote.test.tsx
# 文档回退（可选）：ADR-028 §2.2e、design/99-decisions-log.md 条目、design/12-strategy-system/01-adr.md §13.5.2 增量
```

---

## 9. 关联

- **ADR-024 D10**（禁止隐式有损 ⇒ 本次披露义务）、**ADR-028 §2.2b D2.1 / §2.2d D2.3 / §2.3 D3**（x 域、共用绘图区几何、窗口取数）、**ADR-028 §2.2e D2.4**（本方案裁决）、**ADR-026 §2.1**（口径消歧先例）；
- `design/12-strategy-system/01-adr.md` §13.5.1（warmup 口径）/ §13.5.2（结果页时间窗口径增量）；
- 取证与实施记录：`coder/report/adr028_curve_y_scaling_mismatch_analysis.md`；
- 治理：`design/01-architecture/adr/ADR-018-tangle-gate-hardening.md`（tangle/stitch 纪律）、`AGENTS.md`（gitnexus 影响面分析要求）。
