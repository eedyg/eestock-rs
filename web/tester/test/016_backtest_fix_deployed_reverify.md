# 016 · 回测缺陷修复复验（已部署环境）—— 0 console error / 回撤着色 / 平均持仓取整

> 本报告文件位置：`eestock-rs/web/tester/test/016_backtest_fix_deployed_reverify.md`
>
> 执行类型：复验（对 015 报告缺陷#1「回撤 rect 负宽 console error + 长序列着色失效」与观察#2「avg_hold_bars 原值未取整」的修复验证）。只测不改，未 commit，未改任何源码/接口/架构。
>
> 执行时间：2026-09-05 19:15–19:18 CST（UTC+8）
> 环境：`http://127.0.0.1:8081`（已部署容器 `eestock-app` = `f51331ba5517`，镜像 `10348bb475`，SPA `assets/index-Ci62AeY3.js`）
> 修复基线：git `ee1bd20 fix(web): 回测 ResultOverview 回撤着色负宽 + 平均持仓取整`（deployed bundle 含 `Math.max(0.5, step-1)` 钳位与 `round1(...)+'bar'` 取整，已静态比对确认）
> 被测 run：run38（M5 518880，净值 **8200** 点，回撤>0 **8103** 点 —— 修复前负宽 error 8103 次的同款长序列）；run34（D1，1555 点，dd>0=1454）作第二条长序列；run45（D1，98 点）作短序列对照。

## 1. 结论

**PASS** —— 三项断言全部满足（见 §2–§4），无残留缺陷，无新增测试/源码改动，未 commit。

| 断言 | 结果 | 关键证据 |
|---|---|---|
| ① 0 console error（尤其无负宽 rect error） | ✅ PASS | 全会话 console error=0、pageerror=0；run38/34/45 三 run 查看全程负宽类 error=0（修复前 run38=8103 次） |
| ② result-overview 净值+回撤双图正常、回撤着色非空白 | ✅ PASS | `equity-drawdown-chart` 有 polyline+polygon；run38 渲染 8103 个 dd rect 全部 `width=0.5≥0`、y=156/h=84（图高 25% 回撤带）、fill=#ff5c6c、opacity∈(0,0.2]；像素：回撤带红色覆盖率 75.8%、带外红噪 0 |
| ③ metric-cards 平均持仓取整 | ✅ PASS | run38 原值 16.99126637554585 → 页面显示 **`17bar`**；run34→`18.9bar`；run45→`19bar`（均无引擎原始长小数） |

## 2. 断言①：console error = 0

- 全程监听 `console(type=error)` + `pageerror`（含初始加载、run38→run34→run38 反复切换、热力图/交易表联动）。
- 会话累计：**console error 0**、**pageerror 0**；负宽/`negative value` 类 error **0**。
- 阶段快照（`phaseErr38`/`phaseErr34`）：均 `{consoleErrors:0, pageErrors:0, negWidthLike:0}`。
- DOM 佐证（修复生效的根因层）：8103 个 dd rect 实测 `width=0.5`（`minW=maxW=0.5`，`zeroOrNegW=0`）—— 部署 JS 中 `rectW=Math.max(0.5, step-1)` 钳位逻辑生效，不再产出负宽属性。

## 3. 断言②：回撤着色区间正确显示（非空白/失效）

DOM（run38）：
- svg `viewBox="0 0 1000 240"`，`polyline`(净值线)=1、`polygon`(净值面积)=1、dd `rect`=**8103** = API dd>0 点数，逐一 `y=156 height=84 width=0.5 fill=#ff5c6c`，opacity 采样 0.0008–0.2（=min(0.2, dd/ddMax) 设计值）。
- 左上 `净值 86227.198`、`-13.8%（¥86,227）`；左下 caption `回撤（最大 −26.0%，着色区间）` —— 与 run38 API metrics（net_profit -13,772 / max_drawdown 25.97%）一致。

像素（对 chart svg 元素截图逐像素判定红主色 r>g+18 且 r>b+10 且 r>45）：
- run38：回撤带（图高 60%–99% 行）**bandCover=0.7578**（63,670/84,016 px），带外区(5%–50% 行)=**0.0000**；带内平均 RGB (114,48,64) 红染 —— 着色带大面积连续可见，非空白/失效。
- run34（D1 长序列）：bandCover=0.0725 —— 红带存在但偏淡（该 run 单点 dd 相对 ddMax 极小 → 单层低 opacity，符合渲染公式）；带外红点(0.42%)为**左上 `+51.9%` 正收益红字 overlay**（text-up=#ff5c6c，A 股红涨）而非着色带渗漏（run38 收益为负绿字故带外=0，交叉印证）。
- run45（短序列对照）：bandCover=0.1128，着色正常，与 015 round 结论一致。

## 4. 断言③：metric-cards 平均持仓取整

- run38：API `metrics.avg_hold_bars=16.99126637554585` → 页面 metric-card `平均持仓 = 17bar`（round1：16.99→17.0→去尾 `17`），非修复前的 `16.99126637554585bar`。
- run34：→ `18.9bar`；run45：→ `19bar`。8 张卡（Net Profit/MaxDD/Sharpe/胜率/盈亏比/年化/总交易数/平均持仓）数值与 `/api/backtest/runs/{id}` 全一致。

## 5. 截图（/tmp/backtest_screenshots/，均带 46px 底部 caption：env+容器+img+SPA+tag+时间 CST，caption 亮字像素占比 ~6.5% 已校验）

| 文件 | 内容 |
|---|---|
| `fixed_result_overview.png` (960×290) | run38 长序列 result-overview（净值+回撤双图+着色） |
| `fixed_longseq_result.png` (1440×1046) | run38 结果页整屏（含 metric-cards） |
| `fixed_chart_zoom.png` (944×273) | equity-drawdown svg 放大（run38 回撤着色 rect） |
| `fixed_ov_detail.png` / `fixed_metriccards.png` | run38 overview 明细 / metric-cards 特写 |

结构化证据：`/tmp/backtest_screenshots/evidence_fix_verify.json`
复验脚本：`/tmp/bt_fix_verify.mjs`（主流程+DOM+截图）、`/tmp/bt_fix_px2.mjs`（逐 run 独立加载像素分析）、`/tmp/bt_fix_px.mjs`（像素辅助）

## 6. 观察与残余风险（非阻塞，供架构师知悉）

1. **单位口径观察**：metric-card「平均持仓」显示为**取整后 bar**（`17bar`/`18.9bar`），修复目标「不再显示原始小数」已达成；但部署 bundle 中 metric-card 对 `formatAvgHold` 仅传 bars 不传 period（`Rb(n.avg_hold_bars)`），故 `天/时/分` 单位换算路径（format.ts `PERIOD_DAY_FACTOR`，单测覆盖 `3.2天/15时/3.2分`）在页面上未启用。若产品口径要求「M5 长持仓显示 `1.4时`/D1 显示 `17天`」，需架构师决策是否让 MetricCards 接收 run.period —— 属新改动，不在本次复验范围内。
2. 生产构建（无 React dev warning）下「负宽」本不以 console.error 形态出现；本次 0 error + rect 全正宽 + 着色像素可见，二者互证修复在渲染层真实生效（负宽 rect 在浏览器中不绘制 → 若未修复必为带内 0 覆盖）。
3. 着色带在大 dd 点处 opacity 上限 0.2，长序列多 rect 重叠（run38 步距 0.12px < 宽 0.5px）复合后视觉偏浓（bandMean (114,48,64)），符合钳位设计；短序列（run45）为清淡单层着色 —— 视觉密度随序列长度变化属预期。
4. 数据只读：仅 GET backtest API；无写入、无新建 run、无 DB 变更。

## 7. 复现线索（若有后续回归对比）

- 复验锚点：`[data-testid="equity-drawdown-chart"]` rect count == dd>0 点数、`minW>=0.5`、`zeroOrNegW==0`；metric `[data-testid="metric-card-avg_hold_bars"] .num` 文本无原始长小数。
- 长序列样本：run38（M5，8200 点，最坏情形 n>980）。
