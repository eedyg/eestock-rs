# 研究简报：主涨段（主升浪 / Markup Phase）识别与捕获方法论盘点

> 面向 A 股/ETF 日线级别量化交易策略的信号组合设计参考。
> 调研时间：2026-09。中英文源均覆盖，优先纳入有实证或量化依据的方法。
> ⚠️ 本简报为方法论研究整理，不构成投资建议；社区回测数据普遍存在过拟合/幸存者偏差风险。

## 执行摘要

主涨段的识别在业界有两大范式：**结构化技术体系**（Wyckoff markup、艾略特 3 浪、缠论三买/中枢突破）本质上是同一现象的不同语言——"长期吸筹/盘整后，带量突破区间上沿并回踩不破，随后进入趋势加速段"；**量化信号族**（均线排列、ADX、Donchian 突破、52 周新高、TSMOM、布林挤压、放量突破）则把上述结构转译为可编程规则。实证层面，时间序列动量（TSMOM）在 58 个期货品种上有强证据，52 周新高动量在 20 个国际市场有证据；A 股个股层面动量弱（"A 股动量消失之谜"），但**在 ETF/指数层面做时序趋势与截面轮动总体有效**，有效性高度依赖参数与风控。对 A 股 ETF 日线，最值得优先实验的是"平台/盘整突破 + 量能 + 趋势强度"的复合信号与"ATR 吊灯止损"式离场。

---

## 一、经典技术分析体系

### 1.1 Wyckoff：Markup Phase（上涨阶段）识别

**核心逻辑**：市场周期 = 吸筹(Accumulation) → 上涨(Markup) → 派发(Distribution) → 下跌(Markdown)。主涨段 = 吸筹完成后"因(cause) → 果(effect)"释放的那一段。

**结构链（吸筹五阶段 → markup 触发）**：
- Phase A（止跌）：SC（卖出高潮）、AR（自动反弹）划定区间；
- Phase B（吸筹主体）：多次 ST，回落缩量；
- Phase C（测试）：**Spring**（向下假跌破扫流动性）或抬高型二次测试；
- Phase D（力量确认）：**SOS**（Sign of Strength，放量大阳突破区间/中轴）→ **LPS**（Last Point of Support，缩量窄幅回踩不破）；
- Phase E = **Markup 正式启动**。

**可编程规则（转变判据清单，需大部分同时成立）**：
1. 存在定义良好的震荡区间（支撑=SC区，阻力=AR高点），且位于下跌趋势之后；
2. 回踩支撑缩量（供给枯竭）：下行 K 线均量 < 上行 K 线均量 × 0.9；
3. Spring（假跌破后快速收回）或抬高型更高低点出现；
4. SOS：宽实体阳线、收近高点、量 > 20 日均量；
5. LPS：窄幅、缩量回踩，低点 > 被突破的阻力位（原阻力转支撑）；
6. 出现更高高点 + 更高低点；EMA20 > EMA50；ADX 升破 ~20。

**入场**：SOS 确认或 LPS 回踩；**止损**：Spring 低点（区间支撑）下方；**目标**：区间高度从突破点向上度量（"因果定律"：盘整时间越长/幅度越大，预期 markup 越大）。

**适用条件**：有明显吸筹区间的个股/指数底部或上升中继（再吸筹）。
**失效场景**：震荡市中 Spring 形态频繁误标；跌破 Spring 低点放量 = 吸筹假说证伪；机械 Spring 入场系统的回测利润因子仅 ~1.0–1.4，品种依赖强。

来源：[Investopedia: Making Money the Wyckoff Way](https://www.investopedia.com/articles/active-trading/070715/making-money-wyckoff-way.asp)、[TrendSpider: Wyckoff Accumulation](https://trendspider.com/learning-center/chart-patterns-wyckoff-accumulation/)、[Blueberry Markets: Wyckoff Phases](https://blueberrymarkets.com/market-analysis/wyckoff-theory-identifying-accumulation-and-distribution-phases/)、[pinescriptforge ES Wyckoff backtest](https://pinescriptforge.com/es/wyckoff-accumulation/backtest)

### 1.2 艾略特波浪：第 3 浪识别

**三条硬规则（任一违反则数浪无效）**：
1. 2 浪回撤不超过 1 浪起点的 100%；
2. **3 浪绝不是 1/3/5 浪中最短的**（实践中通常最长）；
3. 4 浪不进入 1 浪价格区域。

**3 浪特征**（Frost & Prechter《Elliott Wave Principle》）：动量最大、斜率最陡、成交量与参与度最广、通常是最长的延伸浪；基本面新闻开始确认趋势；最强机会是"3 浪中的 3 浪"（分形嵌套）。

**可编程识别/交易规则**：
1. 识别干净 1 浪（内部 5 子浪结构）与 3 子浪回撤的 2 浪；
2. 2 浪回撤至黄金带 = **1 浪的 50%–61.8%**（A股/高波动市场可放宽至 78.6%）；
3. 2 浪低点 > 1 浪起点（规则 1）；
4. **确认触发：收盘突破 1 浪终点** → 3 浪启动的高概率判据；
5. 入场：2 浪末端黄金带 + 反转确认，或突破 1 浪终点；
6. 止损：1 浪起点（失效点）；目标：**1.618×W1（TP1）/ 2.618×W1（TP2）**，自 2 浪端点投影；
7. 盈亏比 ≥ 2R。

**失效场景**：主观性强、同一图表可有多种数浪；回撤比例是统计均值而非定律；3 浪失败（嵌套错误）时须切换备选数浪。

来源：[Elliott Wave International: Grab Hold of a Powerful 3rd Wave](https://www.elliottwave.com/articles/grab-hold-of-a-powerful-3rd-wave-like-this-one/)、[Traders.com: Trading Wave 3 (Dologa)](https://store.traders.com/stcov244trwa.html)、[TradersUnited: 3 Rules of Elliott Wave](https://tradersunited.org/tradegeek/forex/technical-analysis-101/3-rules-in-trading-elliot-waves)

### 1.3 缠论（缠中说禅）：主升浪 / 中枢突破 / 第三类买点

**结构链**：K线去包含 → 分型 → 笔 → 中枢 → 买卖点。主升浪本质 = **中枢突破后中枢新生、形成上涨趋势**的那段。

**中枢量化定义**（≥3 笔重叠）：ZG = min(g1,g2,g3)（上沿），ZD = max(d1,d2,d3)（下沿），有效性 = ZG > ZD。趋势判据（中心定理二）：**后中枢 DD > 前中枢 GG → 上涨延续（主升浪前提）**。

**第三类买点（主升浪关键触发，四条缺一不可）**：
1. 存在有效中枢；
2. 次级别走势向上离开中枢（突破 ZG）；
3. **回踩低点 > ZG（不回到中枢内）** ← 唯一真理；
4. 底分型确认。
- 强三买：回踩低点 > 中枢 GG；弱三买：低点在 ZG~GG 之间。
- 实战技巧："大级别（日线）中枢突破 + 小级别（30F）三买精确入场"（区间套）。
- 量价增强：中枢时间 ≥18 根K线、振幅压缩 (ZG−ZD)/MA60 < 20%、强势突破 = 量能 +30% 且突破上沿 2%、跳空三日不补。

**止损/失效**：跌破 ZG = 三买形态失效；三买后若不形成趋势（进入更大级别盘整），盘整高点出局。二买三买重合（凌厉突破 + 回抽不触及）→ 常对应大级别上涨。

**开源工具**：[czsc (waditu)](https://github.com/hennychen/ToSharePro_Analysis/blob/dev/CZSC_INTEGRATION_SUMMARY.md)（43 个内置信号函数）、[chan.py (Vespa314)](https://github.com/Vespa314/chan.py)（多级别联立、区间套）、[noahnan-max/chanlun-trading-system](https://github.com/noahnan-max/chanlun-trading-system)。

**适用条件**：A 股圈广泛使用，与 ETF 日线兼容性需自验。
**失效场景**：分型/笔的参数化定义分歧大；"当下不跌破 ZG"本质是概率判断，需量价/板块共振过滤；震荡市假阳性多。

---

## 二、量化信号族（规则 / 参数 / 适用与失效）

### 2.1 趋势类

| 信号 | 可编程规则 | 关键参数 | 适用 | 失效 |
|---|---|---|---|---|
| **多均线多头排列** | MA5>MA20>MA60>MA120 且全部向上发散；入场=排列形成或回踩 MA20 不破 | 5/20/60/120；A股研报常用 MA20&MA60 | 趋势明确期 | 震荡市反复缠绕、信号滞后 |
| **ADX/DMI** | ADX(14) 升破 25 且 DI+>DI− → 趋势启动；ADX 回落 = 趋势衰竭预警 | ADX<20 无趋势；20–25 萌芽；≥25 强趋势 | 过滤假突破的 Regime 开关 | 非方向性，须配 DI 或价格方向 |
| **Supertrend** | 上轨=hl2+mult×ATR，下轨=hl2−mult×ATR；收盘上穿上轨→多，下破下轨→空 | (10, 3) 标准；高波动品种调 4.0 | 趋势跟随止损/方向线 | 震荡市连续假信号 |
| **Donchian/Turtle** | 收盘突破前 20 日高点入场，跌破 10 日低点出场；仓位按 1×ATR≈账户 0.5–1%，止损 2×ATR | 入场 20/出场 10（海龟 S1）；55/20（S2） | 大趋势捕获，胜率低赔率高 | 假突破期连续小亏（胜率常 <40%） |

来源：[Quantified/海龟法则整理](https://licai.cofool.com/user/guide_view_3407047.html)、[StockCharts ChartSchool](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit)、[知乎：趋势跟踪策略](https://zhuanlan.zhihu.com/p/15299036766)

### 2.2 动量类

| 信号 | 可编程规则 | 关键参数 | 适用 | 失效 |
|---|---|---|---|---|
| **TSMOM（时序动量）** | sign = 过去 12 个月累计超额收益的符号；多头为正、空头为负；仓位按 EWMA 波动率缩放（目标 ~40% 年化波动） | lookback=12M（效果持续 ~1 年后部分反转）；波动缩放质心 60 日 | 期货/指数/ETF 时序，危机中表现最佳（crisis alpha，58/58 品种为正） | Kim-Tse-Wald：不做波动缩放 alpha 大降；2009 后 QE 期衰减 |
| **52 周新高效应** | 比值 = 现价 / 252 日最高价；接近 1（或创新高）→ 持有/买入；截面取前 30% | George & Hwang 2004；20 个国际市场 18 个为正 | 锚定偏差导致的动量，且**不长期反转**（区别于 JT 动量） | 多数市场扣除交易成本后不显著；熊市弱 |
| **N 日动量分位 / ROC** | ROC(N) 进入自身历史分位上区间（如 >80 分位）→ 趋势加速确认 | 20/25/60/120 日；东兴证券 ETF 轮动实测选 **120 日** | ETF 截面轮动与时序过滤 | A 股个股短窗口（5–60 日）以反转为主 |
| **回归动量（R² 平滑动量）** | 对数价格对时间做 OLS：得分 = 年化斜率 × R² | 25 日窗口常见；社区对照实验显示 R² 过滤对收益影响最大 | 惩罚暴涨暴跌、偏好"直"的趋势 | 过拟合风险，需 OOS 验证 |

来源：[Moskowitz, Ooi & Pedersen 2012 TSMOM (JFE)](https://www.sciencedirect.com/science/article/abs/pii/S1386418116301379?via%3Dihub)、[AQR TSMOM 数据集](https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Original-Paper-Data)、[George & Hwang 2004 (JoF)](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.2004.00695.x)、[Liu, Liu & Ma 国际市场实证](https://cir.nii.ac.jp/crid/1870302167634563200)

### 2.3 量价类

| 信号 | 可编程规则 | 关键参数 | 适用 | 失效 |
|---|---|---|---|---|
| **放量突破** | 收盘 > N 日前高 ×(1+2~3%) 且 当日量/20 日均量 ≥ 1.5 | 收盘突破（非盘中）显著更可靠；量比 <1.3 的"无量突破 90% 为假" | 平台突破确认的第一层过滤 | 缩量/冲高回落即假突破 |
| **量比阈值（市值自适应）** | 短线 >3.0/2.0 倍量（小盘）；中线 >2.0/1.5 倍（中盘）；长线 >1.5/1.2 倍（大盘） | 按流通市值分档 | A 股个股/行业 ETF | 大盘宽基 ETF 量比天然偏低，须分档 |
| **OBV / 量能趋势** | OBV 创新高先于或同步于价格新高 → 能量确认；OBV 与价格顶背离 → 预警 | 20 日 OBV 斜率 | 突破真伪辅助 | 单独使用噪声大 |
| **筹码/资金共振（进阶）** | 板块涨幅前 30%、大单净量 >0、主力净流入连续为正 | — | 个股/行业 ETF 主升浪 | 宽基 ETF 资金流数据可得性差 |

来源：[腾讯云开发者：量价辨真假突破](https://cloud.tencent.com.cn/developer/article/2728591?policyId=1003)、[360doc：量价结构三维分析框架（规避 42% 假突破）](http://www.360doc.com/content/25/0324/13/82058071_1149736023.shtml)、[缠论三买共振系统（通达信）](https://goodgongshi.com/tongdaxingongshi/115165.html)

### 2.4 波动率类

| 信号 | 可编程规则 | 关键参数 | 适用 | 失效 |
|---|---|---|---|---|
| **ATR 扩张** | ATR(14) 环比上升 且 ATR/ATR(60) > 1.2 → 波动扩张启动 | — | 主涨段启动伴随波动率扩张 | 下跌段同样扩张，须配方向 |
| **布林挤压（TTM Squeeze）** | Squeeze ON：BB(20,2.0) 完全在 KC(20,1.5×ATR) 内；挤压 ≥5–6 根 K 线后首个"释放" + 动量柱 >0 且上升 + ADX≥25 → 入场 | BB 20/2.0，KC 20/1.5，动量=linreg(close − (Donchian 中轨+SMA20)/2) | "压缩→扩张"拐点，与威科夫因果律同构 | 挤压期过长无释放；释放后 1 根假阳反转 |
| **布林带宽挤压→扩张** | BBWidth 降至 N 日低分位（如 <20%）后连续两日扩张 + 收上中轨 | — | 简化版 squeeze | 同上 |

来源：[StockCharts: TTM Squeeze](https://chartschool.stockcharts.com/~gitbook/pdf?page=ospLYpXUsodCNuQ8ub16&only=yes)、[TrendSpider: TTM Squeeze](https://trendspider.com/learning-center/introduction-to-ttm-squeeze/)、[RobotFX Tech Trader（ADX≥25+ATR 风控组合）](https://robotfx.org/tech-trader-expert-advisor-mt5)

### 2.5 结构类

| 信号 | 可编程规则 | 关键参数 | 适用 | 失效 |
|---|---|---|---|---|
| **平台突破** | 横盘 ≥10 日、振幅 ≤15%（窄平台 <5%）；收盘 > 前 20 日高点 ×1.02；量比 ≥1.5；MA60 上方 | 盘整天数作为因子（而非仅过滤器）："整理时间越长，突破后空间越大"——需分组回测验证单调性 | 个股/行业 ETF 主升起点 | 全 A 裸突破回测胜率仅 ~41%、回撤 ~35%——**必须过滤** |
| **杯柄（Cup with Handle, O'Neil/CAN SLIM）** | 前置上涨 ≥30%；杯期 7–65 周（日线折算 ~35–325 交易日，多用 3–6 月）；杯深 12–33%（大盘深跌可至 40–50%）；U 形非 V 形；柄 1–4 周、柄深 8–12%（≤杯深 1/3）、位于杯体上半部且在 50 日均线上方、缩量；**买入点 = 柄高点 + 最小跳价**；突破日量 ≥ 均量 1.4–1.5 倍；止损 = 买入点下方 7–8%；目标 = 买入点 + 杯深 | 参数见左 | 强势股上升中继；ETF 上可用缩小版参数 | 学术检验有限（Lo-Mamaysky-Wang 2000 仅证明部分形态有增量信息，未含杯柄）；V 形杯、下半部柄、无量突破均失效 |
| **缠论中枢突破/三买** | 见 1.3 | 回踩低点 > ZG | A 股原生方法论 | 见 1.3 |

来源：[IBD: Cup-With-Handle Base](https://www.investors.com/how-to-invest/investors-corner/cup-with-handle-base-harbors-many-winners-before-big-price-runs/?src=A00220)、[LuxAlgo: Cup-with-Handle Base](https://www.luxalgo.com/library/concept/cup-with-handle-base/#how-traders-use-it)、[Tapeboard: Cup and Handle rules](https://tapeboard.com/blog/glossary-what-is-a-cup-and-handle-pattern)、[Lo, Mamaysky & Wang 2000 (JoF)](https://business.columbia.edu/sites/default/files-efs/pubfiles/19268/Lo-Mamaysky_wang_foundations.pdf)、[a-share-breakout-strategy SKILL](https://github.com/aifinlab/finclaw/blob/main/skills/a-share-breakout-strategy/SKILL.md)、[台股箱体盘整量化实证（永丰）](https://www.sinotrade.com.tw/richclub/coding/%E7%94%A8%E9%87%8F%E5%8C%96%E8%A7%92%E5%BA%A6%E6%80%9D%E8%80%83%E7%AE%B1%E5%9E%8B%E7%9B%A4%E6%95%B4-%E7%9B%A4%E6%95%B4%E7%AA%81%E7%A0%B4%E6%90%AD%E9%85%8D%E5%9F%BA%E6%9C%AC%E9%9D%A2%E5%9B%A0%E5%AD%90%E7%B8%BE%E6%95%88%E5%A6%82%E4%BD%95--65dc3f3c5fd9c53c7cb248d0)

---

## 三、学术与业界实证

### 3.1 时间序列动量（TSMOM）

- **Moskowitz, Ooi & Pedersen (2012, JFE)**：58 个期货品种 25 年数据，过去 12 个月收益符号预测未来收益；**58/58 品种 12 个月 TSMOM 均为正**；分散化组合月均超额 ~1.09%（t≈5.4）；**极端行情中表现最好（凸性 / crisis alpha）**；效果持续 ~1 年后部分反转。波动率缩放（EWMA 方差、质心 60 日、目标 40% 年化波动）是收益的重要来源。
- **Kim, Tse & Wald（争议）**：不做波动缩放时 TSMOM alpha 降至 ~0.39%/月且与 buy-and-hold 无显著差异 → **波动缩放（仓位管理）本身就是收益来源**。
- **含义**：对 ETF 日线策略，TSMOM 的启发是"趋势符号 + 波动率目标仓位"两层设计；lookback 从 12M 折算到日线常用 120–250 日。

来源：[TSMOM (JFE)](https://www.sciencedirect.com/science/article/abs/pii/S1386418116301379?via%3Dihub)、[AQR 原始数据](https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Original-Paper-Data)、[Elm Wealth PDF](https://elmwealth.com/wp-content/uploads/2017/06/timeseriesmomentum.pdf)

### 3.2 趋势/动量在 A 股与中国 ETF 的本土化结论

- **个股层面**：A 股 5–60 日窗口以**反转**为主，120–250 日才现动量；《中国管理科学》（徐龙炳等）"A 股动量消失之谜"——月度动量整体不显著，剥离跳跃收益后非跳跃收益动量显著（多空月均 0.92%）；中泰证券《动量亦有时》：机构共识池（≥4 基金共同重仓）动量多空 ~11.3%（t=2.07），叠加**波动率目标控仓**回撤 −66.9%→−41.9%，再加**崩溃空仓机制**年化 17.9%、回撤 −37.9%。
- **ETF/指数层面（更相关）**：
  - 东兴证券 ETF 动量轮动：**120 日动量、月调仓、前 3 行业等权**，2015–2021 年化 14.05%（基准 6.11%），超额 8.27%，IR 0.69；
  - 西部证券 ETF 日内动量 2.0：中证 500 2013–2025 年化 18.9%、夏普 2.10（日内频，参考）；
  - 社区实证（JoinQuant/GitHub）：自适应轮动、跨境轮动（A 股与美股相关性仅 0.20）、双池平滑动量等，宣称夏普 1.7+，但**样本期短、普遍有过拟合/未来函数质疑**；对照实验结论：**短期风控、成交量过滤、R² 过滤对收益影响最大**。
- **本土化共识参数**：动量窗口 120 日优于 20/60 日；Regime 过滤（HS300 120 日收益 < −8% 切防御）；8% 绝对止损；ETF 无印花税是成本优势；T+1 与涨跌停必须纳入回测。

来源：[中泰证券金工《动量亦有时》](https://stock.finance.sina.com.cn/stock/go.php/vReport_Show/kind/11/rptid/841144295945/index.phtml)、[东兴 ETF 动量轮动（PDF）](https://bigdata-s3.wmcloud.com/researchreport/2021-09/ea3e8dae1a7dc466127c0672333f0340.pdf)、[西部证券 ETF 日内动量 2.0](https://stock.finance.sina.com.cn/stock/view/paper.php?reportid=819332204283&symbol=sh000001&autocallup=no&isfromsina=no)、[etf-daily-sync-and-backtest](https://github.com/zhuleimed/etf-daily-sync-and-backtest)、[聚宽：ETF 动量过滤条件对照实验](https://www.joinquant.com/view/community/detail/0fe80568cb9641c4cfaac04cc2f59f1c)

### 3.3 主涨段识别的近期实践

- 缠论量化工具链成熟（czsc 43 信号函数、chan.py 多级别区间套），可直接用于日线中枢突破/三买信号生成；
- 券商金工方向从"个股动量选股"转向"主线行情/动量崩溃风控"（波动率目标 + 空仓机制）；
- 量化社区 ETF 轮动的最新共识：标的池跨资产低相关（宽基+跨境+黄金/债券）、R² 平滑动量打分、Regime 择时、无标的可持时切货币/债券 ETF。

来源：[czsc 集成总结](https://github.com/hennychen/ToSharePro_Analysis/blob/dev/CZSC_INTEGRATION_SUMMARY.md)、[chan.py](https://github.com/Vespa314/chan.py)、[RiskParity-Momentum-ETF 策略文档](https://raw.githubusercontent.com/huyukun662-crypto/RiskParity-Momentum-ETF/main/docs/STRATEGY.md)

---

## 四、离场与风险管理

### 4.1 离场方法

| 方法 | 规则 | 参数 | 适用 | 失效 |
|---|---|---|---|---|
| **吊灯止损（Chandelier Exit, LeBeau/Elder）** | 多头止损 = HighestHigh(N) − k×ATR(N)；收盘跌破即离场；**棘轮：止损只升不降** | N=22, k=3 标准；高波动品种 k=4–5 | 波动率自适应的趋势保护；不会仅因趋势老化而收紧 | 震荡市连续触发；ATR 悖论——加速时 ATR 变大，止损反而放宽，回吐加大 |
| **Parabolic SAR（加速因子）** | AF 从 0.02 起、每创新高 +0.02、上限 0.2；止损随趋势加速收紧 | 0.02/0.2 | 末端冲刺段锁定利润 | 趋势中段过早收紧 |
| **加速趋势线 / 结构离场** | 收盘跌破最陡的上升加速趋势线，或跌破最近一个更高低点（结构破位） | 趋势线取主升浪段两低点 | 末端加速段 | 趋势线主观性强 |
| **涨速衰竭信号（A 股本土化）** | ① 加速赶顶：5 日涨幅远超前期、乖离率（相对 MA20）>10–15%；② 衰竭：动量一阶导从峰值回落/转负（Z-score < −0.5 且前值 > 阈值）；③ 量价顶背离：价格新高 + 量较前高萎缩 ≥30%；④ MACD 红柱逐波走低；⑤ 跌破 MA20 且反抽不站回 | 阈值用 ±0.8σ 防频繁触发；KDJ 顶背离须加 MA20 走平过滤（回测：无过滤 5 日跌 2% 概率 52% → 过滤后 68%） | 主升浪末端预警 | 强趋势中指标钝化，单一信号=预警而非离场 |
| **分阶离场（推荐）** | 预警（单一维度）→ 减 30%；共振（三维度：涨速/量价/资金）→ 再减 50% 仅留观察仓；破位（放量跌破 MA20 / 吊灯触发）→ 清仓；**清仓后 20 日内不再介入** | — | ETF 波段 | — |

来源：[StockCharts: Chandelier Exit](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit)、[LuxAlgo: Chandelier Stop](https://www.luxalgo.com/library/concept/chandelier-stop/)、[搜狐：主升浪见顶量化离场规则](https://www.sohu.com/a/1010829003_121617714)、[CSDN：动量衰减量化](https://blog.csdn.net/weixin_31961675/article/details/152335265)、[主升浪逃顶 5 信号](https://www.sina.cn/news/detail/5319785983246779.html)

### 4.2 假突破过滤手段（优先级排序）

1. **量能确认**：量比 ≥1.5（市值自适应分档）；突破次日量缩 50%+ → 假突破嫌疑；
2. **收盘站稳**：收盘 > 颈线 ×1.02–1.03（拒绝盘中触及）；突破后 3 日回撤 <3%；2 日内跌回颈线 → 离场；
3. **趋势 Regime 过滤**：价格在 MA60 上方 + MA20>MA60 + ADX≥25；
4. **波动率结构**：挤压后扩张的突破质量高于高波动中的突破；
5. **板块/市场共振**：所属板块涨幅前 30%；HS300 120 日收益 > −8%；
6. **缠论/威科夫确认**：回踩不破（LPS / 三买的"回踩低点 > ZG"）才加仓；
7. **回测纪律**：信号 T 日收盘生成、T+1 开盘成交；IS/OOS 分割 + Walk-Forward；计入 T+1、涨跌停、滑点 0.1–0.15%。

来源：[FinClaw a-share-breakout-strategy](https://github.com/aifinlab/finclaw/blob/main/skills/a-share-breakout-strategy/SKILL.md)、[360doc 量价三维框架](http://www.360doc.com/content/25/0324/13/82058071_1149736023.shtml)、[腾讯云：量价辨真假突破](https://cloud.tencent.com.cn/developer/article/2728591?policyId=1003)

---

## 五、推荐清单：A 股 ETF 日线主涨段捕获最值得优先实验的 5 个信号组合

> 排序依据：实证强度 × 与 ETF 日线的匹配度 × 实现难度。每个组合给出"入场 = 触发 ∧ 过滤器；离场"的完整骨架。

**① Donchian 突破 × 量能 × ADX Regime（基准型，最高优先级）**
- 入场：`close > HHV(20)[-1]` ∧ 量/MA20量 ≥1.3 ∧ ADX(14)>20 且 DI+>DI− ∧ close>MA60
- 离场：close < LLV(10)[-1] 或 吊灯止损（22, 3）先到者
- 依据：海龟/TSMOM 家族，实证基础最厚；ETF 无印花税成本低；裸突破胜率低，必须带过滤。

**② 平台挤压突破（Squeeze × 平台因子）**
- 入场：横盘 ≥15 日且 振幅/MA60 ≤10%（或 BBWidth 处 120 日 <20 分位）∧ 首个释放日收盘突破平台高点×1.01 ∧ 量 ≥1.5×均量 ∧ MA20>MA60
- 离场：动量柱两连反向色，或 close < MA20；硬止损 = 平台下沿
- 依据：与威科夫因果律、缠论中枢突破同构；"盘整时长×量能结构"作为分组因子回测。

**③ TSMOM 时序趋势 + 波动率目标仓位（组合层）**
- 信号：120 日（敏感测试 60/250）收益 > 0 → 持有；否则空仓/转防御 ETF
- 仓位：目标年化波动 ~10–13%，按 EWMA 实测波动缩放（TSMOM 文献显示波动缩放本身是 alpha 来源）
- 叠加：Regime 崩溃空仓（指数 120 日收益 < −8% 或趋势符号翻负）
- 依据：MOP 2012 + Kim-Tse-Wald + 中泰"动量亦有时"波动控仓回撤减半的本土证据。

**④ 52 周新高近度 + R² 平滑动量的截面轮动（多只 ETF 池）**
- 打分：`score = 0.5×rank(close/HHV252) + 0.5×rank(年化斜率×R², 25日)`；持有池内 top1–3，月/周调仓
- 过滤：得分 < 阈值或信号为负 → 切黄金/债券/货币 ETF
- 依据：George & Hwang 2004 + 东兴 120 日动量轮动 IR 0.69 + 社区对照实验"R² 过滤贡献最大"；池内资产低相关（A股/纳指/黄金/债券）是收益来源。

**⑤ 缠论式中枢突破回踩（结构型右侧确认）**
- 入场（两档）：A. 突破中枢 ZG ×1.01 且放量（小仓试入）；B. 回踩低点 > ZG + 底分型确认（加仓）——等价于 Wyckoff LPS / 艾略特 2 浪回踩
- 失效：收盘跌回中枢内（< ZG）→ 形态证伪离场
- 离场：新中枢形成后 DD ≤ 前中枢 GG（中枢不再上移）或 MACD 顶背离 + 破 MA20
- 实现：czsc / chan.py 日线复现；依据：A 股圈实践密度最高、与 ①② 互为正交确认。

**组合层建议**：①②④ 提供信号正交性（突破型 / 压缩释放型 / 截面排名型），③提供仓位与危机保护，⑤提供结构确认降低假阳性；统一用吊灯止损或分阶离场收口，回测必须 IS/OOS + Walk-Forward + T+1/成本约束。

---

## 来源清单（保留）

- [Moskowitz, Ooi & Pedersen, Time Series Momentum, JFE 2012](https://www.sciencedirect.com/science/article/abs/pii/S1386418116301379?via%3Dihub) — TSMOM 原始实证（58/58 品种为正）
- [AQR: Time Series Momentum Original Paper Data](https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Original-Paper-Data) — 可复现数据
- [George & Hwang, The 52-Week High and Momentum Investing, JoF 2004](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.2004.00695.x) — 52 周新高动量奠基文献
- [52-Week High in International Stock Markets (Liu/Liu/Ma)](https://cir.nii.ac.jp/crid/1870302167634563200) — 20 市场实证与成本敏感性
- [Lo, Mamaysky & Wang, Foundations of Technical Analysis, JoF 2000](https://business.columbia.edu/sites/default/files-efs/pubfiles/19268/Lo-Mamaysky_wang_foundations.pdf) — 形态识别的学术方法（kernel 回归）
- [StockCharts ChartSchool: Chandelier Exit](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit) / [TTM Squeeze](https://chartschool.stockcharts.com/~gitbook/pdf?page=ospLYpXUsodCNuQ8ub16&only=yes) — 离场与挤压的标准参数
- [Investopedia: Making Money the Wyckoff Way](https://www.investopedia.com/articles/active-trading/070715/making-money-wyckoff-way.asp)、[TrendSpider Wyckoff Accumulation](https://trendspider.com/learning-center/chart-patterns-wyckoff-accumulation/) — Wyckoff 阶段结构
- [Elliott Wave International: 3rd Wave](https://www.elliottwave.com/articles/grab-hold-of-a-powerful-3rd-wave-like-this-one/)、[Traders.com: Trading Wave 3](https://store.traders.com/stcov244trwa.html) — 3 浪规则与交易框架
- [IBD: Cup-With-Handle](https://www.investors.com/how-to-invest/investors-corner/cup-with-handle-base-harbors-many-winners-before-big-price-runs/?src=A00220)、[LuxAlgo Cup-with-Handle](https://www.luxalgo.com/library/concept/cup-with-handle-base/#how-traders-use-it) — O'Neil 杯柄参数
- [中泰证券金工《动量亦有时》](https://stock.finance.sina.com.cn/stock/go.php/vReport_Show/kind/11/rptid/841144295945/index.phtml) — A 股动量崩溃与波动率控仓本土证据
- [东兴证券 ETF 动量轮动研报（PDF）](https://bigdata-s3.wmcloud.com/researchreport/2021-09/ea3e8dae1a7dc466127c0672333f0340.pdf)、[西部证券 ETF 日内动量 2.0](https://stock.finance.sina.com.cn/stock/view/paper.php?reportid=819332204283&symbol=sh000001&autocallup=no&isfromsina=no) — 中国 ETF 动量实证
- [chan.py](https://github.com/Vespa314/chan.py)、[czsc 集成](https://github.com/hennychen/ToSharePro_Analysis/blob/dev/CZSC_INTEGRATION_SUMMARY.md)、[chanlun-trading-system](https://github.com/noahnan-max/chanlun-trading-system) — 缠论量化工具链
- [聚宽：ETF 动量过滤条件对照实验](https://www.joinquant.com/view/community/detail/0fe80568cb9641c4cfaac04cc2f59f1c)、[etf-daily-sync-and-backtest](https://github.com/zhuleimed/etf-daily-sync-and-backtest) — 社区实证与回测框架
- [FinClaw a-share-breakout-strategy](https://github.com/aifinlab/finclaw/blob/main/skills/a-share-breakout-strategy/SKILL.md)、[360doc 量价三维框架](http://www.360doc.com/content/25/0324/13/82058071_1149736023.shtml)、[腾讯云量价突破](https://cloud.tencent.com.cn/developer/article/2728591?policyId=1003) — A 股平台突破/假突破过滤实践
- [搜狐：主升浪见顶量化离场](https://www.sohu.com/a/1010829003_121617714)、[主升浪逃顶 5 信号](https://www.sina.cn/news/detail/5319785983246779.html) — 涨速衰竭/分阶离场本土框架

**弃用来源说明**：TradingView/MQL5 脚本页（实现细节琐碎无实证）、加密交易所博客（与 A 股 ETF 不相关）、宣称"6 年 11 倍"类社区帖（样本期过短、明显过拟合，仅作方向参考未作证据）。

## 未决问题与后续建议

1. **52 周新高效应在 A 股 ETF 上的直接实证缺失**（文献集中于个股与其他市场）——建议先在宽基+行业 ETF 池上做自有回测。
2. **杯柄形态在 ETF 日线上的参数缩放**（7–65 周 → 日线窗口）无公开验证，需网格扫描。
3. **缠论信号与经典量化信号的增量贡献**（正交性）无公开对照研究，建议用信号相关性矩阵+增量 IC 检验。
4. 社区宣称的高收益轮动策略需以 Walk-Forward + 真实成本复核后才能采信。
