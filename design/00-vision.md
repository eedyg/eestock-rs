# 00 — Vision：eestock-rs 愿景与路线图

> 文学式编程项目：本 `design/` 目录是事实源，`src/` 代码由 entangled 从文档**单向**生成（ADR-007）。
> 修改代码 = 修改本文档树，然后 `entangled tangle`。

## 1. 为什么存在

eestock（Go 版）完成历史使命：数据源调研验证（报告 024-028）、交易链路、回测体系。
但其工程实现积累了不可接受的架构债，且**终端形态的操作体验无法满足需求**。
本项目**全量重写**，以 Rust + 完整 Web 形态重建，继承旧项目的验证结论与领域知识。

## 2. 产品定义

一个自托管的 A 股（当前聚焦 ETF）行情数据与交易系统：

1. **数据采集**：注册标集合 → 多源 Provider 池自动抓取 1m K线（真实 OHLCV），稳定入库
2. **数据质量**：tushare 准确层 + 双真值模型（查询时准确层优先），自抓层保留原貌
3. **可用性诊断**：数据源健康度实时监控、告警，Web 诊断面板
4. **完整 Web UI**（8 页）：行情看板 / 数据源诊断 / 标的管理 / 数据质量 / 回测工作台 / 交易面板 / 告警中心 / 系统设置
5. **MCP 服务**：向 AI 开放行情查询、源健康、数据质量、交易（独立开关）
6. **衍生能力**：筹码分布自算（日线+换手率衰减模型）、回测、券商交易

## 3. 核心原则（继承自架构治理，不可协商）

- SOLID / DRY / KISS，高内聚低耦合
- 严格分层：Presentation（Web/MCP）→ Application → Domain → Infrastructure（Providers/TimescaleDB/券商）
- TDD：Red-Green-Refactor，无测试不产码
- 证据驱动：禁代码阅读猜测，调试必须有工具输出/结构化日志证据链
- 可观测性：每模块至少暴露 Metrics/Logs/Traces 中两项，Trace ID 全链传播
- 文学式编程：design 单向 tangle，CI 一致性门禁

## 4. 关键决策索引

全部架构决策见 `design/01-architecture/adr/ADR-001 ~ ADR-012`，汇总：

| 维度 | 决策 | ADR |
|---|---|---|
| 范围/语言 | 全部重写（行情+交易+回测+Web+策略），Rust | ADR-001 |
| 存储 | TimescaleDB 单库（压缩+连续聚合+ON CONFLICT） | ADR-002 |
| 真值模型 | kline_raw（自抓）+ kline_accurate（tushare），准确层优先 | ADR-003 |
| K线周期 | 只写 1m，高周期连续聚合生成 | ADR-004 |
| 源选取 | 逐股随机起点 + 轮询转移 + 心跳模式 | ADR-005 |
| 防封禁 | 东财系最低优先级+最低频，保护同 IP | ADR-006 |
| 工程规范 | entangled 单向文学式，子目录独立 git | ADR-007 |
| Web | React+Tailwind/shadcn+klinecharts+ECharts，WebSocket | ADR-008 |
| MCP | HTTP/SSE 常驻，交易工具独立开关 | ADR-009 |
| 部署 | 局域网免认证，桌面优先 | ADR-010 |
| 筹码 | 自算，不依赖东财成品/Tushare | ADR-011 |
| 交付 | 四波次：数据→质量→分析→交易 | ADR-012 |

## 5. 数据源资产清单（继承自旧项目验证结论，报告 024-028）

| 源 | 角色 | 状态 |
|---|---|---|
| 腾讯 ifzq.mkline（m1/m5） | **1m K线主力** | ✅ 已验证，与新浪基准交叉一致 |
| 新浪 quotes.sina.cn jsonp（scale=1） | **1m K线备源/交叉基准** | ✅ 已验证（旧 money.finance 端点已退化，勿用） |
| 腾讯 qt.gtimg.cn 快照 | 快照池/健康参考 | ✅ 100% 可靠 |
| 新浪 hq.sinajs.cn 快照 | 快照池 | ✅（必带 Referer） |
| 同花顺 realhead | 快照池（仅单只） | ✅ 97% |
| 东财 push2delay 快照 | 快照池，**低频** | ✅ 可用但东财系限流史 |
| 交易所官方（沪 yunhq/深 szse） | 快照池，官方兜底 | ✅ |
| 东财 push2his | ❌ 排除 | 本机遭域级风控断连（028 §4） |
| 百度股市通 | ❌ 分钟级否决 | ktype=1 为日线，风控严格（028 §2.4） |
| 东财主域 push2 | ❌ 排除 | 间歇限流 28-40%（024） |

## 6. 交付波次（详见 10-wave-plans/）

1. **Wave 1 数据底座**：TimescaleDB schema + 采集服务 + 连续聚合 + 源健康指标 + Web 骨架（页面①②③）+ MCP①②
2. **Wave 2 质量与告警**：tushare 同步 + 数据质量对照 + 告警引擎（页面④⑦）+ MCP④
3. **Wave 3 分析**：回测引擎 + 回测工作台（页面⑤）；**并行做交易技术 spike**（Rust chromiumoxide 可行性验证）
4. **Wave 4 交易**：券商链路重写 + 交易面板（页面⑥）+ MCP⑥（独立开关）

## 7. 旧系统处置

eestock（Go）**冻结只读、立即停跑**。遗产（源码/报告/验证脚本/testdata）保留在本父目录供检索参考。
