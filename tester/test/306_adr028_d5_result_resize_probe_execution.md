# ADR-028 D5 结果页图表卡缩放探针 —— 执行报告

- **本报告自身路径**：`tester/test/306_adr028_d5_result_resize_probe_execution.md`
- 主报告（判词与逐项证据）：`tester/evidence/20260920_result_resize_probe/report.md`
- 设计报告：`tester/design/306_adr028_d5_result_resize_probe_design.md`
- 规格：`web/e2e/adr028-resize-probe.e2e.ts`（**本波新建**，1 test）
- 时间：2026-09-20 11:48–11:57（Asia/Shanghai）；commit `cf3e6e714e5615227d56dbb4d64253c4dc982bde`（+ 未提交工作树；`git status --porcelain web/src` 为空）
- 真身：`http://localhost:8081` 主机进程 `eestock-app`（pid 1941108，`static_dir=./web/dist`，按请求读盘）；bundle `/assets/index-BY728MHs.js`，磁盘 sha256 = 响应体 sha256 = `f2504232e7a4fba582943fdbe020235013fef27752313db6cc69531f37d0fa0e`
- 目标 run：`sr_1789832517800_000006`（518880 / M5）
- 输出目录：`tester/evidence/20260920_result_resize_probe/raw`（**报告所引终轮**）；`…/raw_run1`…`raw_run4`（前四轮探索）

## 1. 套件结果总览

| # | 套件 | 命令（均 `timeout` 前缀，`--workers=1 --retries=0`） | 总数 / 通过 / 失败 / 跳过 | 结果 | 耗时 |
|---|---|---|---|---|---|
| 1 | 本波探针（终轮） | `cd web && E2E_BASE_URL=http://localhost:8081 ADR028_RESIZE_OUT=…/raw timeout 1000 npx playwright test e2e/adr028-resize-probe.e2e.ts --reporter=list --retries=0 --workers=1` | 1 / **1** / 0 / 0 | **passed**（exit 0） | 36.4s |
| 2 | 同一规格（第 1 轮探索） | 同上（`raw_run1/run1_stdout.txt`） | 1 / 0 / 1 / 0 | failed（**探针缺陷**，见 §2） | 20.2s |
| 3 | 同一规格（第 2 轮探索） | 同上（`raw_run2/run2_stdout.txt`） | 1 / 0 / 1 / 0 | failed（**探针缺陷**，见 §2） | 27.3s |
| 4 | 同一规格（第 3 轮探索） | 同上（`raw_run3/run3_stdout.txt`） | 1 / 0 / 1 / 0 | failed（**探针缺陷**，见 §2） | 30.2s |
| 5 | 规格编译/枚举 | `timeout 120 npx playwright test e2e/adr028-resize-probe.e2e.ts --list` | 1 / — / 0 / 0 | passed | <5s |

- **崩溃 / core dump：无**（无进程异常退出、无 core 文件、无浏览器崩溃 `/crash`）。
- 退出码：终轮 0；探索轮 1（断言失败）。
- 跳过用例：0。
- 覆盖率：**未启用**（本波不设行覆盖率目标，理由见设计报告 §6）；覆盖改以「问题 × 判据」矩阵记录（设计报告 §3/§6）。
- 未跑其他既有套件（本波为探针取证、资源纪律限定「只跑新建的这一个规格」；跨波回归由后续波次负责）。

## 2. 失败用例表（**全部为探针自身缺陷**；已修复并留痕，非产品缺陷）

| 轮次 | 失败用例 | 错误信息 / 现象 | 根因（探针侧） | 修复 | 崩溃/core |
|---|---|---|---|---|---|
| 1 | `P1..P4 结果页图表卡缩放探针…` | `base：聚合分曲线主口径 max|Δ984| 必须 ≤ 2px … Expected: <= 2, Received: NaN` | ①断言读了不存在的键 `maxAbs984`（实际键 `maxAbs984Px`）；②分隔线选择器用 `cursor:ns-resize` 先命中 **Y 轴缩放 widget**（54px 宽竖条） | 修正键名；命中条件加「宽 > 100 且高 ≤ 10」 | 无 |
| 2 | 同上 | 同上 | 追加：Playwright 点击 Tab 触发 `scrollIntoView` ⇒ K 线卡滚出视口（容器 `top=-829`），拖拽落点为负坐标，`elementFromPoint=null` | 每次测量/拖拽/截图前把 `wb-result.scrollTop` 复位到 0 | 无 |
| 3 | 同上 | 同上（`maxAbs984=NaN`） | 追加：`/curve?kind=net_value|drawdown` 的 `points` 是 `[ts, value]` **数组对**（非 `{ts}` 对象），`p.ts` → `undefined` ⇒ 净值图配对全部落到 j=0（`duplicateBars=102`、`spanK=0`） | `fetchCurveTs` 兼容两种形状 | 无 |
| 4（终轮） | — | 无失败 | — | — | 无 |

> 说明：第 1–4 轮的产物（`raw_run1/`…`raw_run4/`）保留**原样**作为取证留痕（含负结果），主报告中的所有产品结论**只引终轮 `raw/*.json`**；负结果已在主报告 §3 ⚠ 与 §9 明确标注为探针缺陷。另：`raw_run4` 与报告所引终轮（`raw/`）为**口径冻结后的两次连跑**，逐项数值完全一致（可复现性证据）。

## 3. 终轮实测摘要（原始输出见 `raw/`）

- **P1**：`controlsTotal=103`，`indicatorEntries=[]`，`aria-pressed` 计数 = 0，唯一 checkbox = `legend-slot-0`；副图真身指标 = **VOL**（`paneId=indicator_pane_1789876589121_2`），主图叠加 = MA；pane options 三者 `minHeight=30 / dragEnabled=true / state=normal`；`separator={size:1,color:#DDDDDD,activeBackgroundColor:rgba(22,119,255,0.08)}`。
- **P2**：`hover.hitIsSeparator=true`（背景变 active 色）；上拖 40px ⇒ 分隔线 y 205→165、candle 107→67px、VOL 100→140px；下拖 40px ⇒ 复原；上拖 200px ⇒ candle 30px（下界）/ VOL **177px**；「全览」+「回退」后 pane options 仍 30/177（**保留**）。
- **P3**：卡片高 = K 线 **256**（内层图表 234）/ 聚合分 186（svg 160）/ 各策略 190（svg 144）/ 净值 218（svg 208）/ 持仓 271（svg 208）；曲线卡注入 340px ⇒ 卡片变高、**svg 不变**（`svgFollowsCard=false`）；保留 `shrink:1` 时注入高度被吞回 186；K 线卡注入 480px ⇒ 内层图表 234→458（跟随）；表格三处 `clientHeight == scrollHeight`（无内滚动），结果面板 680/6540 整页滚动。
- **P4**：7 态 × 4 图，`max|Δ984| ≤ 0.05px`、非 zoom 态 `max|Δraw| ≤ 1.25px`、`pairs=103(117)`、`duplicateBars=0`、`outOfTolerance=0`；跨视图 userX 互差恒 2.0 user unit（= 1.24px）；zoom80 态绝对 Δraw 不可比（offset≈93px，坐标系混合），尺度校正残差 0.05px。

## 4. 未做（诚实边界）

- 未尝试修复任何产品缺陷（本波无产品缺陷结论，只有「未实现」项）；**未修改任何生产代码、接口与架构**。
- 未新增永久性埋点/仪表（页面侧仅会话内 `Map.prototype.set` 只读包装，随页面销毁）。
- 未被纳入本轮的：其他 run（`sr_1789875082403_000003`）、像素级截图审阅、副图指标切换后的高度保持（实现后补测）、刷新/切 run 后的拖拽持久化。
