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
| 分歧率（Wave 2 Phase A 定稿） | raw vs accurate(M1) 同 ts 对照：**偏差>threshold% 的 bar 占比**（threshold 默认 0.5 = 页面④定稿；**只比 close**——amount 跨层不可比，D4 结案见 04-storage §4.4 注记 7）。028「快照池各源 vs 腾讯锚」口径由本口径取代（准确层到位后，raw vs tushare 更可靠） |

## 2. 服务接口

- `HealthQueryService`：`GET /api/sources/health`（卡片墙数据，SQL 窗口聚合）
- `HealthEventStream`：WS `{type:"source_health"}` 变更推送（事件写入时触发，节流 500ms）
- `GapService`：`GET /api/collection/gaps?date=` 缺口率与缺口段（LEFT JOIN 分钟序列）
- `QualityService`（Wave 2 Phase A 落地，07-app-plane §2.1）：raw vs accurate 分歧对照 / 源一致率排行 /
  交易日历驱动缺口报告（三级分类 source_fault/upstream_no_data/system_gap）/ tushare 同步状态；
  交易日 = 工作日 ∧ ¬holidays（0008）；分钟标签 = domain::calendar 241 口径（13:00 伪缺口结案）
- `CircuitAdminService`：`POST /api/sources/{id}/reset` 手动复位（经 Collector 的 CircuitRegistry，跨 crate 经 domain 端口调用，禁止直改状态）

## 3. 分层位置

diagnose crate 属 Application 层：只读 storage（健康事件/kline_raw）+ 调用 domain 端口（CircuitRegistry 状态）。不反向依赖 collector；collector 通过 EventSink 端口推事件，diagnose 订阅。

## 4. TDD 规格要点

- 成功率/分位数窗口聚合 SQL 的正确性（testcontainers 造事件序列断言）
- 状态灯迁移矩阵（含 Degraded 边界 95%）
- 缺口计算：午休（11:30-13:00）不产生缺口；非交易日返回空（Wave 2 Phase A 起节假日同口径）
- WS 节流：高频事件 500ms 合并推送
