# 08-plan — 结果页**三视图拆分**（ADR-028 §2.9 D9；含 §2.8 D8 方向缺陷收尾）

> **裁决事实源（唯一出口）**：`design/01-architecture/adr/ADR-028-result-visualization-position-ratio-and-window-sync.md` **§2.8（D8）**、**§2.9（D9）**、**§4 第 11/12 条**、**§5**。
> **用户裁决（2026-09-24）**：Q1=**B**（视图高度取代卡片高度）｜Q2=**A**（中间栏只放四张曲线卡）｜Q3=**B**（指标与明细各自可收起；收起不留空、恢复条常驻带名、记忆）｜Q4=**C**（**K 线视图常驻不可收起** ⇒ x 域永久锚定 K 线可见 bar 序列）｜Q5/Q6=默认（K 线视图不滚、指标与明细各自滚、整页不滚；三段比例默认提议 0.50/0.30/0.20）｜Q7=**授权修订**。
> **状态**：**D8 已实施、独立复验进行中**；**D9 待实施**（本文件是 D9 的方案与派工口径；**new 口径一律由 ADR 裁决，本文不新增**）。

---

## 1. 目标与非目标

**目标**
1. **D8 收尾**：分隔条方向语义（已修 + 已做变异反证）→ 独立复验 → 提交 → 部署。
2. **D9 实现**：结果页拆成**三视图**——**上=K 线视图**（常驻、不可收起）、**中=指标视图**（仅四张曲线卡）、**下=明细视图**（现 4 tab）；两条分隔条；**视图高度取代卡片高度**（删除 D6 卡高机制与 D4.2 的"卡片高度缩放"在结果页的应用）；指标/明细各自可收起；x 域与像素对齐契约不得退化。

**非目标**：指标视图独立 x 域（Q4=C 排除）；"聚焦单视图"（Q3 未选 C）；后端/`/curve` 契约；明细内部 tab 拆分；看板任何行为。

---

## 2. 判据表（D9；**标 `≈待标定` 的数值必须先真身标定再回填契约**）

| # | 判据 | 形态 |
|---|---|---|
| D9-1 | 三视图存在且归属正确 | `wb-kline-view`／`wb-indicator-view`／`wb-detail-view` 三者独立容器；K 线卡在 K 线视图内、四张曲线卡在指标视图内、明细 4 tab 在明细视图内 |
| D9-2 | **K 线视图常驻** | **不存在**收起入口/恢复条（断言缺失）；指标与明细存在收起入口 |
| D9-3 | 指标/明细可收起 | 收起后该视图**不占位**、其余视图**立即按原比例分享**其空间；恢复条**常驻可见、带视图名、可点击（含键盘）**；收起态**记忆**（刷新保持） |
| D9-4 | 滚动语义 | K 线视图**无内部滚动**（`scrollHeight ≤ clientHeight`）；指标/明细各自 `overflow:auto` 且**互不影响**；**整页不滚**（`scrollingElement.scrollHeight ≤ innerHeight`、`scrollY=0`） |
| D9-5 | 视图高度取代卡片高度 | **不存在**S/M/L 预设与 K 线卡下沿把手（断言缺失）；K 线高度 == K 线视图高度（±2px）；四条曲线卡为**固定内容高**、无把把/预设 |
| D9-6 | **两条分隔条 + 三视图高度均可调（2 自由度守恒）** | ①拖 **K线↔指标**：K 线变高/变矮（指标反向补偿）②拖 **指标↔明细**：明细变高/变矮（指标反向补偿）③**指标视图**由两条分隔条共同决定（无需第三个控件）④**守恒判据**：任一调整后 `klinePx + indicatorsPx + detailPx + 两条分隔条高 == 可用高`（±2px）⑤方向：上拖 −N ⇒ **上方**视图变高（±2px，N∈{40,120,240}）⑥双击各自复位默认比例（±0.02） |
| D9-7 | 夹取优先级与**三视图最小高**（2026-09-24 标定回填） | **三个视图都不得被压到 0**（除显式收起外）：K 线视图 **299**（1 副图）/ **329**（2 副图）；**指标视图 180**（≈一张曲线卡完整可读，其余滚动）；**明细视图 95**（tab 29 + p-2 16 + 表头 25 + 行 25）。夹取优先级 **K 线 → 指标 → 明细**；三者之和（1 副图时 574）> 可用高（口径见 D9-8）时按比例压缩并**显式披露**（禁静默） |
| D9-8 | 几何换算与默认态判据（**实测口径**） | `卡高 = K 线视图高 − 60`（窗口条 34 + 载入提示 18 + gap 8）；**`主图 = K 线视图高 − 209`（1 副图）/ `− 230`（2 副图）——均为 **默认 regime（Σ副图 = 100 / 120）**；**触下限时副图被压到 30 ⇒ 同一视图高下主图更高**（实测：卡高 239 ⇒ 主图 160 = 卡高 − 79）**；`可用高 = 视口高 − 132`（口径**必须改**：现状 `ratio × 视口高` 在三档均溢出 92px）；默认态：**主图 ≥ min(320, 该档可达上限)**（可达上限实测 720→245、800→285、1400→585）、副图合计 ≤120、卡头 ≤48（恒 20） |
| D9-9 | x 域与像素对齐不退化 | 四张曲线卡与 K 线共用 bar 索引域：同一 bar 跨视图像素偏差 ≤2px；（D2.1/D2.3-4 全量重测） |
| D9-10 | 跳转纪律不被破坏 | 跳转后：下栏 `scrollTop` 不变、指标视图 `scrollTop` **也不变**（对齐 D7-4②）、K 线在上栏内回到可见、高亮仍生效（L2） |
| D9-11 | 记忆与迁移 | 新键（三段比例 + 两个收起态）持久化；旧 `eestock.result.layout.v1`（`ratio`/`collapsed`）与旧 `eestock.result.cardHeights.v1`（`kline` px）**只读迁移**、界内才采信；看板 key **逐字节不变** |
| D9-12 | 观测性 | 新增 `data-view-ratio-*`／`data-view-height-*`／`data-view-collapsed-*`；且**实际像素比与请求比例不一致时两者都可读**（避免 D7 口径混淆重演） |
| D9-13 | **必修缺陷：记忆路径绕过夹取** | 实测播种 `{"kline":200}` ⇒ 直渲染 200、主图 **121 < 160 硬下限**（挂载时未测到卡头/副图数 ⇒ 用了默认下限 200）。要求：记忆值恢复后按**实测有效下限再夹取**，且在卡头/副图数变化时**重夹**；判据：任意记忆值/任意副图数下主图 **≥160 ∧ 副图 ≥30**（含“播坏值/极小值/极大值”三类） |

---

## 3. 改动清单（文件级）

**新增**
| 文件 | 内容 |
|---|---|
| `web/e2e/adr028-d9-three-view.e2e.ts` | D9-1..12 真渲染判据（含收起/恢复、两分隔条方向、夹取、记忆与迁移、x 对齐复测） |
| `web/src/features/workbench/threeViewLayout.ts`（可选，若 `resultLayout.ts` 过大再拆） | 三段比例模型纯函数（若不拆则并入 `resultLayout.ts`） |
| `coder/evidence/…/calibration/*`（证据） | **标定脚本与读数**：各标准视口（1280×720/800/1400）下三段可达值、D9-8 的可达主图高，供回填契约数值 |

**修改**
| 文件 | 内容 |
|---|---|
| `web/src/features/workbench/resultLayout.ts` | 由"单 `ratio`"扩为**三段比例** `{kline, indicators, detail}` + 两个收起态；clamp（各段 px 下限/上限、K 线有效下限）；`layoutForViewport` 返回三视图 px；**新键**（建议 `eestock.result.layout.v2`）+ 双源只读迁移（v1 比例、cardHeights kline px → 比例） |
| `web/src/features/workbench/useResultLayout.ts` | 两条分隔条的拖拽（方向语义 D8）+ 各自双击复位；per-view 收起 API；可用高实测（改为三段容器）；恢复条 props |
| `web/src/features/workbench/ResultView.tsx` | 三视图结构与两条分隔条、恢复条；K 线视图 `h-full`；指标视图承载四张曲线卡；明细视图承载 `DetailPane`；删除"单 split"模型；页面级滚动仍移除 |
| `web/src/features/workbench/KlineResultChart.tsx` | **删除卡高机制**（内部 `useCardResize` 实例、预设条、下沿把手；`data-kline-card-bounds` 改 `data-kline-view-height`）；卡片 `h-full`；**保留** 卡头瘦身、`paneConstraints`/`planKlinePanes`、`data-card-header-height` |
| `web/src/features/workbench/cardResize.tsx` | 删除 `CardHeightPresets` 与结果页卡高用法；**保留**曲线卡既有 CSS 默认高（改为固定内容高）与 `svgClass` 契约（受控态 `h-full` 不再需要，按实现清理） |
| `web/src/features/workbench/DetailPane.tsx` | 收起入口统一到**视图级**（恢复条由 `ResultView` 渲染）；tab 语义与懒挂载不变 |
| `web/src/features/workbench/resultCardHeights.ts` | **仅保留** `effectiveMinCardPx`/`planKlinePanes`/几何常量（卡高预设与卡高记忆语义不再被 UI 消费）；旧键只作迁移源 |

**规格/测试重锚（按契约推导，禁按实现倒推）**：`adr028-d6-kline-size.e2e.ts`、`adr028-d5-result-resize-tester-verify.e2e.ts`、`adr028-features-fix.e2e.ts`、`adr028-features-verify.e2e.ts`、`resultResizeIndicators.test.tsx`、`adr028FocusHighlight.test.tsx`、`ResultView.test.tsx`（+ 新增 D9 规格）。

**明确不改**：`/curve`、`/bars`、`resultWindow.ts` 的 x 定义域与窗口栈、`RoundTripsTable`/`PerBarTable`/`EventLog` 数据契约、看板。

---

## 4. 边界与异常

| 情形 | 行为 |
|---|---|
| 可用高过小（三段下限之和 > 可用高） | 按优先级夹取：**K 线有效下限 → 指标最小高 → 明细最小高**；三者不可同时满足时**按比例压缩并显式披露**（不得把任一视图压到 0；不得静默） |
| 两个视图同时收起 | 剩余视图占满；恢复条并排常驻 |
| K 线视图被拖到很低 | 仍受 D6-4 有效下限（主图 ≥160、副图 ≥30）⇒ 实际下限 ≈239（1 副图）；后续曲线 x 域随之缩小（**契约允许**，因 x 域锚定 K 线可见集） |
| 迁移源冲突（v1 比例与 cardHeights px 同时存在） | **以 v2 已存值为准**；两源仅在 v2 无该字段时采信；界外/坏数据 ⇒ 忽略该源、用默认 |
| 收起态下刷新 | 收起态与比例均保持；恢复条仍可见 |
| 引擎 pane 分隔条拖拽 | 与视图分隔条**互不覆盖**：引擎条只改 K 线视图**内部**主图/副图分配，仍受主图硬下限 clamp |
| **相邻视图最小高口径（2026-09-24 复验登记）** | `保底 200px` 指 **split 几何**（= 可视 pane + 分隔条 12 + gap 16）；实测可视 pane 在保底处 = **172px**。**判据一律以像素读数（pane `boundingBox`）为准**，不得按常量名推断可视高 |
| **窗口条/载入提示归属（2026-09-24 标定定案）** | 两者归 **K 线视图**（共 60px：窗口条 34 + 提示 18 + gap 8）⇒ `卡高 = 视图高 − 60`；**判据不得拿卡高当视图高** |
| **明细切 tab 引起的内容高变化** | 明细**最小高固定 95**（不随 tab 变）；回合 tab 含摘要时内容 262 属**内容高**、由内部滚动承接，**不得**因此把明细段擑高或挤压其他视图 |

---

## 5. 测试方案（TDD；**标定先行**）

0. **标定阶段（先做，产出回填契约）**：tester 在标准视口（1280×720/800/1400）真身测量：三段可达高/比例、默认态主图高、有效下限实测值、夹取临界点；把数值回填 ADR §2.9 第 7 项与 §4 第 12 条 → **判据数值不得由算术推导直接进契约**（本批已三次付代价）。
1. **先写失败判据**：`adr028-d9-three-view.e2e.ts` + `resultLayout.test.ts`（三段模型/夹取/迁移/收起）+ `useResultLayout.test.tsx`（两分隔条方向与复位）。
2. **实现**（按 §3 清单，勿扩大范围）。
3. **真渲染验收**（D9-1..12）；**变异反证 ≥3 项**：①两分隔条方向各反一次 ②K 线视图加入收起入口（须红：D9-2 断言缺失）③收起后空间不共享（须红）——复原须 `sha256` 校验。
4. **既有规格重锚**：逐条给"旧契约 → 新契约"推导；**全域枚举**受影响测试（ADR-023 §6.2），不得碰到才改。
5. **回归**：`tsc -b` 0 错；`vitest` 全量无新增红；D2.1/D2.3-4 像素对齐与 x 域全量重测；D7 既有判据（跳转不动下栏、高亮、明细 tab）在新结构下重测。

---

## 6. 门禁与验收流程

1. **coder（worker）**：先红后绿；提交前跑 `impact`（`ResultView`/`KlineResultChart`/`useResultLayout`/`ResultView`）与 `detect_changes`（索引过期先 `analyze --index-only`）。
2. **tester（独立验收）**：不采信自证；真渲染复跑 D9-1..12 + 变异反证 + 规格重锚的结构性复核；证据落**未跟踪**目录（AGENTS.md 纪律）。
3. **架构侧**：复核 D6/D7 未被无意破坏（x 域、像素对齐、跳转纪律、禁静默有损）；提交门禁；**部署后冒烟**（served == dist + 契约标记 + 关键判据）。
4. **代理产物不入库**；提交用显式文件清单。

---

## 7. 回退

```bash
git checkout -- web/src/features/workbench/{ResultView.tsx,ResultView.test.tsx,KlineResultChart.tsx,cardResize.tsx,cardResize.test.tsx,DetailPane.tsx,useResultLayout.ts,resultLayout.ts,resultLayout.test.ts,resultCardHeights.ts,resultResizeIndicators.test.tsx,adr028FocusHighlight.test.tsx}
rm -f web/e2e/adr028-d9-three-view.e2e.ts
# 文档回退：ADR-028 §2.9/§4 第 12 条、本文件
```

## 8. 关联

- **ADR-028**：§2.6（D6，**部分被取代**）、§2.7（D7）、**§2.8（D8）**、**§2.9（D9）**、§3 第 6 项、§4 第 11/12 条、§5；`design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md`（D6/D7 实施记录）；`design/99-decisions-log.md`（本批条目）。
- **纪律**：ADR-023 §6.2（改契约须全域枚举受影响测试）；`AGENTS.md`（代理产物不入库、提交纪律、e2e 证据路径、禁根级递归 chown/chmod）。
