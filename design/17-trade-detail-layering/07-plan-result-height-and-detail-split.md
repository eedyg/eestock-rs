# 07-plan — 结果页「K 线尺寸」与「明细上下分层」实施计划（ADR-028 D6/D7）

> **裁决事实源（唯一出口）**：`design/01-architecture/adr/ADR-028-result-visualization-position-ratio-and-window-sync.md` **§2.6（D6）**、**§2.7（D7）**、**§4 第 8–10 条**（验收判据）、**§5**（挂起项与债）。
> **取证事实源**：`tester/evidence/20260923_result_ux_probe/`（真渲染：卡高可否调、把手命中带、主图 67px、假把手、跳转把明细顶出视口）。
> **用户裁决（2026-09-23）**：Q1=A（归因卡高）｜Q2=B（默认 520 + S/M/L 预设 + 拖拽微调 + 双击复位）｜明细形态=B（上下分层）｜下栏内容=①②③④全搬+内部 tab｜下栏高=40% 视口｜跳转时下栏=完全不动（B1-1）｜高度判据=OK｜ADR 修订=授权。
> **状态**：待实施（本文只定义契约与派工口径；**new 口径一律由 ADR 裁决，本文不新增**）。

---

## 1. 目标与非目标

**目标（本批全部）**
1. **D6**：K 线卡默认 **520px**；头部预设 **S/M/L = 260/420/560**；拖拽微调；双击标题复位到 520；**主图优先分配**（520 卡高 ⇒ 蜡烛主图 ≥320px、副图合计 ≤120px、卡头 ≤48px）；**主图硬下限 ≥160px**；把手 **≥12px 且悬停可见**（修 `hover:bg-acc1/40` 规则缺失）；尺寸**记忆**（结果页独立 key）。
2. **D7**：结果页改**上下分层**——上栏（K 线 + 窗口条 + 四曲线卡，全宽、自身内部滚动）／下栏（明细四块 + 内部 tab，自身内部滚动）；**整页不再滚动**；下栏默认 **40% 视口高**、可拖拽、可折叠、记忆；**跳转不动下栏**（只在上栏内部把 K 线滚回可见 + 保留 D4.1 高亮）。

**非目标（登记，不在本批实施）**
- 跳转 scale 缺陷（含 `wb-window-probe` 假绿与跳转后曲线卡空白）；
- 买卖标记遮挡（37.1%）与标签常显策略；
- D2.4 的「预热窗口内空图缺 view 级文案」；
- 后端/契约（本批**零 Rust 改动**、零迁移）。

---

## 2. 契约要点（可测化；与 ADR §2.6/§2.7 逐条一致）

| # | 判据 | 判据形态（必须可断言） |
|---|---|---|
| D6-1 | 默认卡高 520px | `wb-kline-chart` 高度 == 520（无记忆值时） |
| D6-2 | 预设 S/M/L | 点 `wb-kline-preset-s/m/l` ⇒ 卡高 260/420/560（受 min/max 夹取后） |
| D6-3 | 主图/副图/卡头分配（**分态判据**） | **默认 520 态**：蜡烛 pane ≥320、副图合计 ≤120、卡头 ≤48；**小卡高态（含 S=260）**：主图 ≥160、副图 ≥30（余量优先给副图） |
| D6-4 | 主图硬下限（**有效下限口径**；2026-09-23 裁决修正） | **名义下限 200**；**有效拖拽下限 = max(200, 卡头实高 + 分隔 1 + x轴 26 + 160 + 副图有效下限)**，**副图有效下限 = 30px**（保持可见，不隐藏；引擎不接受 30 时取引擎最小可设值并给读数）。判据：拖到**有效下限** ⇒ 卡高 ≥200 ∧ 主图 ≥160 ∧ 副图 ≥30；拖引擎 pane 分隔条越界同样 clamp |
| D6-5 | 把手可发现性 | 把手高度（可命中带）≥12px；**悬停前后计算样式 background-color 必须不同且非全透明** |
| D6-6 | 拖拽/持久化/复位 | 拖 +N px ⇒ 卡高与 klinecharts 容器高**双变化**；刷新后保持；双击标题复位 520 |
| D6-7 | 记忆隔离 | 高度写入**结果页独立 key**；**不得**读写看板布局/指标 key（硬约束，同 D4.2 第 5 条） |
| D7-1 | 分层存在 | `[data-testid=wb-chart-pane]` 与 `[data-testid=wb-detail-pane]` 均为独立滚动容器（`overflow:auto`），且**页面无滚动**（`document.scrollingElement.scrollHeight <= innerHeight` 或 body 不滚） |
| D7-2 | 下栏内容 | 四块（L1/L2、逐 bar、事件日志）**都在下栏**；`wb-detail-tabs` 默认选中「回合与逐笔」；切换 tab 不改变上栏状态 |
| D7-3 | 下栏尺寸 | 默认 40% 视口高（容差显式声明）；分隔条拖拽改变比例；折叠后上栏占满；刷新后比例保持 |
| D7-4 | 跳转不动下栏 | L1 与 L2 各一次跳转：①`window.scrollY` 不变 ②下栏 `scrollTop` 不变 ③下栏内目标行仍在其容器视口内 ④K 线卡完整可见 |
| D7-5 | 高亮不回退 | 跳转后 D4.1 高亮仍生效（标记放大 + 3s 回常态），不得因分层改动丢失 |

---

## 3. 改动清单（文件级）

**新增**
| 文件 | 内容 |
|---|---|
| `web/src/features/workbench/resultCardHeights.ts` | 纯函数 + 存储适配器：`DEFAULT_KLINE_PX=520`、`CARD_HEIGHT_PRESETS`、`clampCardPx(px,{min,max})`、`readHeight/writeHeight`（**结果页独立 key**，如 `eestock.result.cardHeights.v1`）、旧 key 迁移（若存在）。**无副作用、可独立单测** |
| `web/src/features/workbench/resultLayout.ts` | 纯函数：下栏高度比例（默认 0.4）、`clampRatio`、折叠态切换、比例 ↔ px 换算（**注入视口高**，便于单测） |
| `web/src/features/workbench/useResultLayout.ts` | 状态与持久化（拖拽/折叠/记忆）；DI storage 适配器 |
| `web/src/features/workbench/DetailPane.tsx` | 下栏容器 + `wb-detail-tabs`（回合与逐笔 / 逐 bar 明细 / 事件日志），挂载既有 `RoundTripsTable`/`PerBarTable`/`EventLog`（**不改这三者的数据契约**） |
| `web/src/features/workbench/resultCardHeights.test.ts`、`resultLayout.test.ts` | 单测（clamp/预设/记忆/坏数据/折叠） |
| `web/e2e/adr028-d6-kline-size.e2e.ts` | 真渲染判据 D6-1..D6-7（含变异反证） |
| `web/e2e/adr028-d7-detail-split.e2e.ts` | 真渲染判据 D7-1..D7-5（含变异反证） |

**修改**
| 文件 | 内容 |
|---|---|
| `web/src/features/workbench/cardResize.tsx` | 把手 ≥12px、**悬停可见**（修 CSS 规则缺失，改用能产出规则/内联变量写法）、最小/最大高由 `resultCardHeights` 派生、预设入口、持久化改用新 key |
| `web/src/features/dashboard/KlineChart.tsx` | **（本批新增，经裁决授权）** 增**可选、缺省关闭**的 `paneConstraints` prop（声明式：`{ candleMinPx, subPaneMinPx }`；**不得**暴露 chart 实例）：仅结果页传；不传时行为与现状**逐像素一致**（既有 dashboard 规格必须仍绿并给证据）；卡片拖高与引擎 pane 分隔条拖拽**两条路径都 clamp**；新增 `data-*`/testid 观测当前 pane 高与是否触发 clamp |
| `web/src/features/workbench/KlineResultChart.tsx` | 默认 520；**卡头瘦身**（指标勾选收进下拉/浮层，保留多选与 testid）；主图/副图**默认分配**与**硬下限 clamp**；把手层级优先于 canvas |
| `web/src/features/workbench/ResultView.tsx` | 上下分层容器（`wb-chart-pane` / `wb-pane-splitter` / `wb-detail-pane`）；移除页面级滚动；`wb-kline-focus-anchor` 的滚动作用域收敛到上栏容器内 |
| `web/src/features/workbench/ResultView.test.tsx` | 结构断言更新（分层节点存在、四块在下栏） |
| `web/e2e/adr028-d5-resize-indicators.e2e.ts`、`adr028-window-sync.e2e.ts`、`adr028-axis-align-*.e2e.ts` | **按新默认高与分层口径修订**依赖「单列布局/整页滚动/默认 256」的断言（修订须附"契约推导"，不得按实现输出倒推） |

**观测性（新增 `data-*`，供真渲染判据与事后回查）**：`data-kline-pane-height`、`data-card-header-height`、`data-detail-pane-height`、`data-pane-collapsed`、`data-pane-ratio`。

**明确不改**：`/curve` 与 `/bars` 契约、`resultWindow.ts` 的 x 定义域与窗口栈、`RoundTripsTable`/`PerBarTable`/`EventLog` 的数据源与分页语义、看板（dashboard）任何配置。

---

## 4. 边界与异常（逐条可测）

| 情形 | 行为 |
|---|---|
| 无记忆值 / 记忆值不可解析 / 越界 | 用默认 520，并按 min/max 夹取；**不得**因坏数据把卡高变成 0/NaN |
| 视口高过小（如 < 600px） | max = 视口高 − 200 可能小于默认 520 ⇒ 卡高取 `min(520, max)`；**有效下限优先**：卡高不得低于 `max(200, 卡头+187+副图有效下限)`；副图让位至 **30px 下限**（不隐藏），**主图始终 ≥160** |
| 下栏折叠 | 上栏占满；分隔条隐藏但保留键盘可恢复入口；比例记忆保留（展开时恢复） |
| 下栏比例拖动越界 | clamp 到 [0.15, 0.85]（可测常量），不得把任一侧压到 0 |
| 明细数据未就绪 / 空 | 下栏仍存在（不因空数据消失），显式空态文案 |
| L1/L2 跳转 | 下栏**完全不动**；若目标行原本不在下栏视口内 ⇒ **也不动**（B1-1：禁止自动滚动） |
| 单 run 与 sim-live | 两者同口径（分层与卡高记忆共用结果页 key） |

---

## 5. 测试方案（TDD：先红后绿）

1. **先写失败判据**（红）：`resultCardHeights.test.ts`、`resultLayout.test.ts`、`adr028-d6-*.e2e.ts`、`adr028-d7-*.e2e.ts`。
2. **单测（纯函数）**：夹取/预设/记忆读写/坏数据/折叠与比例 clamp。
3. **真渲染 E2E（本机 chromium 可用；活库可用）**：D6-1..7、D7-1..5 全量；每项断言**必须**是"用户可见效果"（高度、计算样式、滚动量、视口内可见性），**不得**只断言元素存在。
4. **变异反证（至少 3 项）**：人工去掉实现后判据必须变红——①主图高分配（回到 67px）②把手悬停可见性（回到透明）③跳转后下栏 `scrollTop`（回到被顶走）。
5. **既有规格修订**：逐条给出"旧契约 → 新契约"的推导说明（参照 ADR-023 §6.2 教训：改契约须全域枚举受影响测试，不得碰到才改）。
6. **回归**：`npx tsc -b` 0 错；`npx vitest run`（全量）无新增红；`adr028-axis-align-*` 在**新默认高**下仍绿（D4.2 第 6 条要求）。

---

## 6. 门禁与验收流程（分工）

1. **coder（worker 车道）**：先红后绿；改动清单逐项落盘证据；提交前跑 `gitnexus impact`（对 `useRunSeries`/`ResultView`/`cardResize` 等目标符号）与 `detect_changes`（若索引报 LadybugDB 版本不符，先 `node .gitnexus/run.cjs analyze --index-only`）。
2. **tester（独立验收）**：不采信 coder 自证；真渲染复跑 D6/D7 判据 + 变异反证 + 既有规格修订的**结构性复核**（断言条数/类型/期望集合是否等价于契约推导）。
3. **架构侧（我）**：复核是否违反 ADR §2.6/§2.7 与既有硬约束（D4.2 配置隔离、D2.3-4 共用几何、禁静默有损），并做提交门禁复核与最终合入。
4. **证据纪律**：**代理产物（`coder/`、`tester/`）不入库**（用户 2026-09-23 规），只入库产品与文档改动。

---

## 7. 回退

```bash
git checkout -- web/src/features/workbench/{cardResize.tsx,KlineResultChart.tsx,ResultView.tsx,ResultView.test.tsx}
rm -f web/src/features/workbench/{resultCardHeights.ts,resultCardHeights.test.ts,resultLayout.ts,resultLayout.test.ts,useResultLayout.ts,DetailPane.tsx}
rm -f web/e2e/adr028-d6-kline-size.e2e.ts web/e2e/adr028-d7-detail-split.e2e.ts
# 文档回退：ADR-028 §2.6/§2.7、design/99-decisions-log.md 条目、本文件
```

## 8. 关联

- **ADR-028** §2.2b/§2.2d（x 域与共用绘图区几何，不得破坏）、§2.4b（D4.1 高亮，D7-5 引用）、**§2.4c（D4.2 缩放与配置隔离，本批在其上扩展）**、§2.5（D5 完整性）、§3（影响）、§4（验收）、§5（债）；
- `design/12-strategy-system/01-adr.md` §13.5（结果页口径）；`design/17-trade-detail-layering/05-status.md`（批次索引）；
- 取证：`tester/evidence/20260923_result_ux_probe/`（含 7 个可复跑探针与关键截图）；
- 治理：`design/01-architecture/adr/ADR-018-tangle-gate-hardening.md`（tangle/stitch 纪律）、`AGENTS.md`（gitnexus 门禁 + 代理产物不入库）。
