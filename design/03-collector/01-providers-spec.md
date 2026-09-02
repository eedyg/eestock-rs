# 03 — Provider 逐源适配规格

> 每源一节：端点/解析/单位/错误分类/限频。解析测试由 golden 样本驱动（旧仓 028 冒烟 CSV + 响应样例 → crates/providers/testdata/）。
> ⚠️ 端点事实以 028 报告为准（web.ifzq 已 301 失效、新浪旧端点退化——下列为修正后版本）。

## 1. 腾讯 ifzq（TencentIfzq）— 1m 主力

- 端点：`GET https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={prefixed_code},m1,,320`
  （备：`web.ifzq.gtimg.cn` 同路径，自动跟 301；**勿用 web3**）
- 响应：`data.<code>.m1 = [[YYYYMMDDHHMM, 开, 收, 高, 低, 量(手), {}, 额(万元)], ...]`
- ⚠️ 字段序陷阱：**2 号位是"收"不是"高"**（028 §2.1 golden 锁定）
- 单位：量(手)→股 ×100；额(万元)→元 ×10000；时间按 Asia/Shanghai 解析转 UTC
- 编码：JSON/UTF-8（无 GBK 问题）
- 限频：1 req/s + 0~200ms 抖动

## 2. 新浪 jsonp（SinaJsonp）— 1m 备源/交叉基准

- 端点：`GET https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_k=/CN_MarketDataService.getKLineData?symbol={prefixed_code}&scale=1&ma=no&datalen=240`
- 响应处理：剥 `/*<script>location.href=...*/` 防盗链前缀 + `var _k=(...);` jsonp 包裹 → JSON 数组 `[{day,open,high,low,close,volume,amount}]`
- ⚠️ **旧端点 `money.finance.sina.com.cn CN_MarketData.getKLineData scale=1` 已退化（恒定 null），禁用**（028 §3）
- 单位：volume 股（新浪此处为股，非手——golden 样本验证锁定）；时间为 `YYYY-MM-DD HH:MM:SS` 北京时
- 限频：1 req/s + 抖动；无需 Referer（jsonp 域与 hq 域不同）

## 3. 快照池（健康心跳用，字段最小化：last/prev_close/vol/amount/data_ts/name）

| 源 | 端点 | 要点 |
|---|---|---|
| TencentQt | `https://qt.gtimg.cn/q={pfx}{code},...` | **GBK** 解码；`~` 分隔 88 字段；手→股、万元→元；最抗封（024） |
| SinaHq | `https://hq.sinajs.cn/list={pfx}{code}` | **必带 Referer: https://finance.sina.com.cn/**（否则 403）；GBK；`,` 分隔；涨跌幅需自算 |
| ThsCs | `https://d.10jqka.com.cn/v6/realhead/hs_{code}/last.js` | 仅单只；jsonp 包裹 |
| Push2delay | `https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=...&fields=f2,f3,f5,f6,f12,f14,f18` | **fltt=2 时字段为格式化字符串，必须强转 float**（028 修复前科）；东财系最低频 15min |
| Exchange | 沪 `https://yunhq.sse.com.cn:32041/v1/sh1/snap/{code}` + 深 `https://www.szse.cn/api/report/ShowReport?SHOWTYPE=JSON&CATALOGID=1110&TABKEY=tab1&txtDM={code}` | 官方源；字段结构两所不同，各自适配 |

## 4. 错误分类统一口径（→ domain::ProviderError）

| 情形 | ProviderError | 熔断影响 |
|---|---|---|
| HTTP 403/429 | `RateLimited` | 不计熔断，进退避档 |
| 连接超时/读超时 | `Timeout` | 计熔断失败 |
| 连接重置/断连（push2his 式风控） | `Http` | 计熔断失败 |
| 5xx/网络错误 | `Http` | 计熔断失败 |
| 响应结构不符/字段缺失 | `Parse` | 计熔断失败 |
| 业务无数据（非交易时段空返回/新上市） | `NoData` | 不计失败，记 NA |

## 5. 通用要求

- 每适配器内嵌 token bucket（速率见各节）+ 超时（默认 8s，东财系 5s）
- User-Agent 统一标识 + 每源独立 headers 配置（如 SinaHq 的 Referer）
- 解析函数为**纯函数**（`parse(&str) -> Result<Vec<Bar>>`），golden 样本单测直接驱动，不触网
- HTTP 层与解析层分离：HTTP 层可 mock，集成测试用本地 mock server
