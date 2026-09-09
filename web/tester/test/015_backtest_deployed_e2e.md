# 015 执行报告 — 回测工作台（页面⑤）已部署环境真实 E2E 验收 + 用户截图

> **本文件位置**：`/home/eestock/workspace/git/eestock/eestock-rs/web/tester/test/015_backtest_deployed_e2e.md`
> 角色/纪律：tester（只测不改；**零产品代码改动、零 git add / commit、零行情/标的表写入**）
> 测试方式：真实已部署环境 Playwright E2E（脚本 `/tmp/bt_work/e2e_capture.mjs` 等，未入仓）
> 执行时间：2026-09-05 18:40–18:56 CST（UTC+8）；验收执行窗口 10:40–10:56 UTC
> 被验环境：`eestock-app` healthy（container `969a8a0900d6`，image `eestock-rs_app`=`c86773b4235d`，started 2026-09-05T10:30:25Z）；
> SPA `index-Dotb4dP2.js`（hash 资产 200）；前端/API `http://127.0.0.1:8081`（=192.168.50.100:8081）；
> DB `eestock-timescaledb`（5433），backtest_runs/results 表在（迁移0011）；Playwright chromium 1.62.1，viewport 1280×800
> 证据目录：`/tmp/backtest_screenshots/`（10 张验收截图 + 2 张补充图 + `evidence.json` / `evidence_final.json`，底部均带环境+时间 caption）

## 0. 执行摘要（12 验收项）

| # | 验收项 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | 首页导航「⑤ 回测工作台」可点 → /backtest；8 区齐、无加载失败 | ✅ **PASS** | `nav a[href="/backtest"]`=1、text=⑤、cursor=pointer，点击落 `/backtest`；单次视图 6 区 + 激活态 compare-view/grid-rank 均出现；无「加载失败」 |
| 2 | strategy-form：7 策略、schema 参数表单、周期/费用/起:止:步长 | ✅ **PASS** | 策略下拉=7（dual_ma…atr_channel）；dual_ma 参数 param-fast/slow/position_pct；period 4 档；fee 0.025/5/2；grid-* 输入 placeholder=起:止:步长 |
| 3 | 提交回测 → POST /runs 200；任务行出现并推进 | ✅ **PASS** | UI 提交 → `POST /api/backtest/runs` **200** `{"run_id":38}`；任务行 pending/running→pct 0→100 |
| 4 | task-list：WS 实时进度 0→100；点已完成 → 结果加载 | ✅ **PASS** | run38 收 **8200** 帧 `backtest_progress`（pct 0→100，bar_ts 2026-01-05→09-04）；reload 后行=「完成/查看」，点击→result-overview 出图 |
| 5 | result-overview：净值+回撤双图真实数据 | ✅ **PASS** | `equity-drawdown-chart` svg 有 polygon/polyline；run45(D1) 回撤 58 个正宽 rect 着色（见 §5.1 缺陷备注） |
| 6 | metric-cards：8 项指标值合理 | ✅ **PASS** | Net Profit ¥-13,773 / MaxDD 26.0% / Sharpe -1.04 / 胜率 19.2% / 盈亏比 3.46 / 年化 -19.6% / 总交易 229 / 平均持仓≈17bar，与 API metrics 一致 |
| 7 | trade-table：明细+排序筛选 | ✅ **PASS** | run38 交易 229 行；表头 开仓时刻/开平仓价/数量/盈亏/持仓时长；sort-* 3 钮 + 全部/盈利/亏损过滤可用 |
| 8 | period-heatmap：月/周热力 | ✅ **PASS** | 「月/周收益热力」月/周切换钮 + 2026 年各月收益格（run38 M5 2026 有 9 个数据月） |
| 9 | compare-view：2 run 叠加净值+指标并排 | ✅ **PASS** | 勾 run38+run45 → compare-view 图表 2 polyline + 8 行指标并排（NetProfit -13,773 / 9,519 等不同值） |
| 10 | grid-rank：参数网格 5:9:2 → 任务组 → 排行 | ✅ **PASS** | POST 200 `{"group_id":"g_1788605657192_0","run_ids":[39,40,41]}`；grid-rank 表 6 行（fast=5/7/9 × 收益/夏普/回撤/状态 done） |
| 11 | 无 pageerror/console error；非法提交前端内联错误 | ⚠️ **PASS（有 console error 缺陷，见 §5.1）** | pageerror=0；period=1s→400、未知策略→404（API 侧）；非法网格 abc→400 + 前端 `submit-error`「提交失败：HTTP 400…」内联可见；**但** result-overview 长序列 run 触发 `<rect width 负数>` console error 8103 次（缺陷#1） |
| 12 | 数据只读；临时 run 可留 | ✅ **PASS** | 只写 backtest_runs/results（E2E 新增 run 35–45 共 11 条，可留可 SQL 清，见 §6）；行情/标的/告警等表零写入 |

**验收结论：10/10 验收链路走通；发现 1 个前端 console error 缺陷（ResultOverview 回撤 rect 宽为负，长序列 run 触发），1 个展示性观察（avg_hold_bars 原值未取整），无阻塞回测功能的失败项。**

## 1. 测试运行

- 主脚本：`node /tmp/bt_work/e2e_capture.mjs`（完整链路 + 截图），补充脚本 `/tmp/bt_work/{fixup,final_shots,rich_shots,repro_rect,err_probe,rect_probe}.mjs`
- 浏览器：Playwright chromium（命中本地 cache），locale zh-CN / Asia/Shanghai
- 断言结果落 `/tmp/backtest_screenshots/evidence.json`（全步骤）+ `evidence_final.json`（精简）
- 截图统一由 PIL 在底部追加 46px caption（环境+容器+SPA+URL+区名+时间 CST），像素校验 caption 亮字存在

### 1.1 逐项证据（DOM / network / WS / 数值摘录）

**① 首页导航**
- `nav[data-region="nav"] a[href="/backtest"]` 计数 1，text=「⑤ 回测工作台」，cursor=pointer（截图高亮后点击）
- 点击后 URL = `http://127.0.0.1:8081/backtest`；页内 region：topbar/nav/backtest + 单次视图 6 区
  `["strategy-form","task-list","result-overview","metric-cards","trade-table","period-heatmap"]`
- compare-view / grid-rank 为条件渲染：勾选 2 run 后 `[data-region="compare-view"]` 出现（§9），网格提交后 `[data-region="grid-rank"]` 出现（§10），与骨架/单测口径一致
- body 无「加载失败」；task-list 首屏渲染历史 run 行 rows=5

**② strategy-form**
- `GET /api/backtest/strategies` 200，7 款：`dual_ma, ma_rsi, macd, boll, kdj, momentum, atr_channel`
- 选 dual_ma → `param-form` 内 `param-fast / param-slow / param-position_pct`（数值 input，默认 5/20/1）
- 每个数值参数旁有 `grid-fast/slow/position_pct`，placeholder=「起:止:步长」
- `period-select` 4 档：1m/5m/15m/1d（显示「日」）；fee 默认 0.025 / 5 / 2

**③ 提交回测**
- UI 填 518880 + 5m + dual_ma fast=5 slow=20 → 点「提交回测」→ `POST /api/backtest/runs` **200** `{"run_id":38}`
- 任务行 `task-row-38` 出现，DOM 采样 26 次：pct 实时递增（WS 覆盖 REST 进度）
- 后端 `GET /runs/38` 最终 `done`，trades=229

**④ WS 实时进度**
- WS 捕获 run38 帧共 **8200** 条：首 `{"type":"backtest_progress","run_id":38,"pct":0,"bar_ts":"2026-01-05T01:30:00Z"}` → 末 `{"pct":100,"bar_ts":"2026-09-04T07:00:00Z"}`
- 页面 reload 后 `task-row-38` 文案：`● 完成 | 双均线交叉 · 518880 5m | 查看`；点「查看」→ `equity-drawdown-chart` 出现
- 口径观察：单次会话内行「状态」文本来自 REST runs 快照（WS 只推进度 %/当前日期），run 完成后需 reload/下次提交才翻成「完成」——前端行为如此（源码 TaskList 状态取自 runs.data），非本次缺陷；验收流程（跑完→刷新→点已完成→结果加载）已闭环

**⑤ result-overview（run45 = D1 2024-01→06 验收例）**
- `[data-testid="equity-drawdown-chart"]`：polyline（净值）+ polygon（面积）+ 58 个回撤着色 rect（正宽），左上 `净值 109519.086`、`+9.5%（¥109,519）`，左下 `回撤（最大 −5.4%，着色区间）`
- run38(M5 长序列 2026) 亦出图（净值 86227 / -13.8%），但触发缺陷#1（见 §5.1）

**⑥ metric-cards（run38）**
- `metric-card-*` 8 张：Net Profit ¥-13,773 / Max Drawdown 26.0% / Sharpe -1.04 / 胜率 19.2% / 盈亏比 3.46 / 年化 -19.6% / 总交易数 229 / 平均持仓 `16.99126637554585bar`（原值，见观察#2）
- 与 API run38 metrics 数值一致（net_profit=-13772.8 → ¥-13,773 等）

**⑦ trade-table（run38）**
- 229 行；表头 `开仓时刻 ▲ | 开/平仓价 | 数量 | 盈亏 | 持仓时长`；sort-* 钮 3 个；过滤 全部/盈利/亏损 3 钮；行样例 `02-02 00:00 4.672 → 4.646 21,399.061 -653（-0.7%）10bar`

**⑧ period-heatmap（run38 / run45）**
- run38(M5 2026)：`月/周收益热力 月 周 2026 5.0% -2.9% 0.5% -6.3% -7.8% -10.1% 0.6% 5.0% -0.4%`（数据足一月，非占位）
- run45(D1 2024)：2024 年 5 个数据月（0.0% -0.7% 8.4% 2.7% -1.5%）

**⑨ compare-view（run38 + run45）**
- 勾 2 个已完成 run → compare-view：`对比视图（叠加 2 次） 38·518880 5m | 45·518880 日`；`compare-chart` svg 2 条 polyline + 8 行指标并排表
- 值不同证明叠加为两 run：Net Profit ¥-13,773 / ¥9,519；MaxDD 26.0% / 5.4%；Sharpe -1.04 / 1.92；胜率 19.2% / 33.3%；盈亏比 3.46 / 10.03；年化 -19.6% / 26.3%；总交易数 229 / 3

**⑩ grid-rank**
- 表单填 `grid-fast=5:9:2`（dual_ma，1d）→ POST 200 `{"group_id":"g_1788605657192_0","run_ids":[39,40,41]}`（fast=5/7/9 三并发子任务）
- 任务组全部 done 后再提交一次同网格刷新 runs 列表 → grid-rank 视图：`网格任务组排行（2 组）`，6 行，含 `fast=5 position_pct=1 slow=20 | 1.7% | 0.26 | 9.0% | 日·done`、`fast=7 → -0.1%/0.06/9.7% done`、`fast=9 → -5.7%/-0.83/10.5%`（总收益/夏普/最大回撤/状态列齐全）

**⑪ 非法提交**
- API 侧：`period="1s"` → **400** `{"error":"period 须为 M1/M5/M15/D1，实际 1s"}`；`strategy_id="no_such_strategy"` → **404** `{"error":"未知策略 id: no_such_strategy"}`；`params_grid.fast="abc"` → **400** `{"error":"范围应为 \"起:止:步长\"，实际: abc"}`
- UI 侧（非法网格 abc）→ 表单区 `[data-testid="submit-error"]` 内联出现：`提交失败：HTTP 400 /api/backtest/runs: 范围应为 "起:止:步长"，实际: abc`
- pageerror = **0**；console error 见缺陷#1（仅 result-overview 长序列时触发，非页面加载/表单路径）

**⑫ 数据只读 / 临时 run**
- 全流程仅 `POST /api/backtest/runs`（写 backtest_runs + backtest_results）；未触碰 symbols / kline_* / alert_* 等表
- 本 E2E 会话新增 run id 35–45（11 条：35 M1 探针、36 D1 探针、37 M5 探针、38 M5 验收、39-41 网格组、42-44 网格组、45 API 验收例），全部 done；按任务口径可留库，如需清理见 §6 SQL

## 5. 发现与残留风险

### 5.1 缺陷#1（console error，中优先级，非阻塞）
- 现象：任选一个**净值序列点 >~980 个**的已完成 run 查看（如 run38 M5 2026 ≈ 8000+ 点、run34 D1 2018–2024 =1555 点），result-overview 渲染时浏览器刷 console error：
  `Error: <rect> attribute width: A negative value is not valid. ("-0.880473228442493")`（run38 计数 8103 次；run34 计数 1454 次）
- 根因位置（前端源码，未修改）：`eestock-rs/web/src/features/backtest/ResultOverview.tsx` 回撤着色 rect：
  `width={(w / Math.max(eqPoints.length - 1, 1)) - 1}`，其中 `w = W - PAD*2 = 980`；当 `eqPoints.length - 1 > 980` 时 width 为负 → SVG rect 属性非法 → 浏览器逐 rect 报错且回撤着色不可见。
- 最小复现：打开 /backtest → 任务列表选任意长序列 done run（M5/M15/M1 或多年 D1）点「查看」→ console 刷错误。
- 影响：控制台噪音大（数千条）；回撤红色着色区间在长序列下失效（短序列 run45 D1 2024 为 58 个正宽 rect，着色正常、0 console error）。净值主曲线/指标/交易/热力不受影响。
- 建议交给架构师/开发者按「width 下限 ≥0 或改用 1px 描边/面片」修复后复验。

### 5.2 观察#2（展示性，低）
- metric-cards「平均持仓」显示引擎原值未取整（`16.99126637554585bar`），其余指标均格式化；trade-table 持仓时长列同用原值。非功能问题，仅观感。

### 5.3 观察#3（行为口径）
- 任务行状态文本（排队/运行中/完成）来自 REST runs 列表快照，WS backtest_progress 仅推进 pct/当前日期；run 完成后需页面 reload 或下一次提交（refreshRuns）才翻为「完成」。「查看」按钮按设计仅在 done 行出现 —— 与前端单测（BacktestPage.test）一致，不属回归，但用户长时间停留时可能看到「运行中 100%」直至手动刷新。验收按「跑完→reload→点已完成→结果加载」闭环执行并通过。

## 6. DB 临时 run 记录与清理（可选）

- 新增 run：`SELECT id,code,period,strategy_id,status,group_id FROM backtest_runs WHERE id BETWEEN 35 AND 45;`（全部 done，11 行）
- 如需清理（可选，任务允许留库）：
```sql
DELETE FROM backtest_results WHERE run_id BETWEEN 35 AND 45;
DELETE FROM backtest_runs WHERE id BETWEEN 35 AND 45;
```
- 未执行清理，未 commit，无 staged 文件（外层仓库与 eestock-rs 内层仓库 `git diff --cached` 均为空）。

## 7. 截图文件列表（`/tmp/backtest_screenshots/`，每张底部 caption：环境+容器+SPA+URL+时间 CST）

| 文件 | 内容 |
|---|---|
| backtest_nav.png | 首页导航，⑤ 回测工作台高亮可点 |
| backtest_fullpage.png | /backtest 全页（6 区+任务列表） |
| backtest_strategyform.png | strategy-form（dual_ma schema 参数+网格输入） |
| backtest_tasklist_running.png | task-list 运行中（run38 进度） |
| backtest_result_overview.png | result-overview（run45 D1：净值+回撤着色） |
| backtest_metriccards.png | metric-cards 8 卡（run38） |
| backtest_tradetable.png | trade-table 229 行（run38） |
| backtest_heatmap.png | period-heatmap 月视图（run38） |
| backtest_compare.png | compare-view（run38 M5 + run45 D1 叠加） |
| backtest_gridrank.png | grid-rank（fast=5/7/9 排行） |
| backtest_invalid_grid.png | 补充：非法网格前端内联错误 |
| evidence.json / evidence_final.json | 全步骤证据 JSON |

## 8. 验收结论
- **回测全链路（提交→WS 进度→完成→结果→指标→交易→热力→compare→网格）在真实已部署环境全部走通（12 项 PASS，无 FAIL）。**
- 唯一产品缺陷为 result-overview 长序列回撤 rect 宽为负导致 console error 与着色失效（§5.1），最小复现已给出；未修复、未改产品代码。
