# 05 — 诊断系统（Diagnose）设计

> Wave 1 最小集：源健康查询 + 缺口率 + WS 推送。Wave 2 扩展：告警规则引擎、分歧率。
> 数据基础：source_health_events 表（03-collector §7 事件模型）+ kline_raw。

## 1. 指标定义（查询侧实时聚合，不预计算）

| 指标 | 口径 |
|---|---|
| 成功率 | 窗口内 ok=true / (ok=true + ok=false)，NA 不入分母（028 口径）|
| 延迟 P50/P95 | 窗口内 ok=true 事件的 latency_ms 分位数 |
| 状态灯 | Healthy=最近事件正常且无熔断；Degraded=成功率<95% 或处于退避；CircuitOpen=熔断中 |
| 限流信号计数 | err_kind=rate_limited 的累计（403/429 分桶）+ err_kind=http 且连接重置类单独计数 |
| 缺口率 | （当日交易分钟数 − 该 code 当日 kline_raw 行数）/ 当日交易分钟数；Wave 1 简化日历=工作日 |
| 分歧率（Wave 2） | 快照池各源 vs 腾讯锚，|价差|>0.5% 占比（028 cross 口径） |

## 2. 服务接口

- `HealthQueryService`：`GET /api/sources/health`（卡片墙数据，SQL 窗口聚合）
- `HealthEventStream`：WS `{type:"source_health"}` 变更推送（事件写入时触发，节流 500ms）
- `GapService`：`GET /api/collection/gaps?date=` 缺口率与缺口段（LEFT JOIN 分钟序列）
- `CircuitAdminService`：`POST /api/sources/{id}/reset` 手动复位（经 Collector 的 CircuitRegistry，跨 crate 经 domain 端口调用，禁止直改状态）

## 3. 分层位置

diagnose crate 属 Application 层：只读 storage（健康事件/kline_raw）+ 调用 domain 端口（CircuitRegistry 状态）。不反向依赖 collector；collector 通过 EventSink 端口推事件，diagnose 订阅。

## 4. TDD 规格要点

- 成功率/分位数窗口聚合 SQL 的正确性（testcontainers 造事件序列断言）
- 状态灯迁移矩阵（含 Degraded 边界 95%）
- 缺口计算：午休（11:30-13:00）不产生缺口；非交易日返回空
- WS 节流：高频事件 500ms 合并推送
