# 03 — 采集服务（Collector）详细设计

> Wave 1 核心。职责：按注册集合与间隔调度，经源选取策略（ADR-005）抓取 1m bar 写入 kline_raw，维护心跳与熔断，当日缺口回填，产出健康事件。
> 实现时本文档承载 collector crate 的代码块（TDD：测试先行）。

## 1. 组件结构

```
CollectorService
├── Scheduler        # 每 code 一个 ticker（interval_secs），对齐分钟边界
├── FetchExecutor    # attempt_chain 执行器：随机起点+轮询转移（domain::selector）
├── GapBackfiller    # 启动时/周期内当日缺口回填
├── HeartbeatTask    # 快照池 30-60s 保活
├── CircuitRegistry  # 熔断状态机（内存态 + 事件落库）
└── EventSink        # source_health_events 写入（诊断数据源）
```

## 2. 调度循环（Scheduler）

- 每 enabled code 一个独立 ticker：`interval_secs`（≥60，symbols 表），**相位对齐分钟边界**（`next_tick = ceil(now/60)*60 + jitter(0~2s)`，抖动防同刻齐发）
- 间隔修改热生效（ADR：symbols 变更下周期生效）：Scheduler 每周期前重读 symbols（轻量查询；变更频率极低，不做订阅推送）
- 非交易时段（TradingCalendar）跳过拉取，记 NA 不记失败；Wave 1 简化口径=仅工作日（节假日噪音接受）

## 3. 单次抓取流程（FetchExecutor）

```
对 code C：
  chain = selector.attempt_chain(healthy_minute_sources())   # 随机起点+轮转，剔除熔断
  for src in chain:                                          # 单批次内按序转移
      t0 = now
      match provider[src].fetch_m1(C, limit=N):              # N=当日剩余分钟数+少量重叠
          Ok(bars)  -> 记录成功事件(延迟) → writer.write_batch(bars)（首写胜出）→ break
          Err(NoData)      -> 记 NA（非交易时段/新上市），不视为失败，break
          Err(RateLimited) -> 记失败(err_kind=rate_limited) → CircuitRegistry.penalize(src, 退避档) → 继续下一源
          Err(e)           -> 记失败(err_kind) → CircuitRegistry.record_failure(src) → 继续下一源
  全部失败 -> 记 code 级失败事件（诊断面板缺口率的因）
```

- **粘源**：单 code 单批次内不跳源重取已成功部分
- 重叠窗口：每次拉取含最近 3 根已有 bar 的重叠，靠首写胜出自然去重（容忍源端当根 bar 修正）
- Trace ID：每次抓取生成，贯穿事件/日志

## 4. 熔断状态机（CircuitRegistry，ADR-005 口径）

```
Healthy --连续3次失败--> CircuitOpen --冷却60s--> HalfOpen --单次成功--> Healthy
   ↑__________________________|                    --失败--> CircuitOpen(冷却×2, 封顶30min)
RateLimited：不进熔断计数，直接按 5s→10s→30s 退避档静默该源（err_kind=rate_limited 计限流信号）
手动复位（诊断面板 POST /sources/{id}/reset）：任意态 → Healthy，记事件
```

- 熔断源从 attempt_chain 健康池摘除；心跳任务对熔断源降为低频探测（HalfOpen 的探测走心跳通道，不占交易抓取）

## 5. 当日缺口回填（GapBackfiller，Q4-B）

- 触发：服务启动时 + 每 30 分钟周期检查
- 缺口定义：当日交易分钟序列（09:30-11:30 ∪ 13:00-15:00，共 240 分钟）− kline_raw 已有 ts
- 回填：对每个缺口 code，走正常 attempt_chain 拉 limit=240 的 m1，首写胜出只补缺的部分
- 只回填**当日**（更早的历史缺口归 tushare 准确层职责，ADR-003）

## 6. 心跳任务（HeartbeatTask）

- 快照池（TencentQt/SinaHq/ThsCs/Push2delay/Exchange）每 30-60s 随机抖动一轮：取注册集合快照，验证可达性与解析，**只记健康事件不入行情库**
- 用途：源健康观测 + HalfOpen 探测 + 快照与 1m 价交叉（诊断分歧率输入）
- Push2delay 单独 15min 低频档（ADR-006）

## 7. 事件模型（写 source_health_events）

| 场景 | ok | err_kind |
|---|---|---|
| 抓取成功 | true | NULL |
| 非交易时段/无数据 | true | na（架构师锁定：写事件 ok=true+err_kind=na 保留可见性；成功率分母显式排除 err_kind='na'，与 028 口径一致）|
| 超时/HTTP/解析失败 | false | timeout/http/parse |
| 403/429 | false | rate_limited |
| 熔断状态迁移 | false | circuit_open / circuit_halfopen / circuit_closed / manual_reset |

## 8. TDD 规格要点

- Scheduler 相位对齐与热生效（fake clock）
- FetchExecutor：首源成功不转移；NoData 不计失败；RateLimited 走退避不进熔断；全链失败产出 code 级事件
- CircuitRegistry 状态机全迁移路径（含冷却翻倍封顶、手动复位）
- GapBackfiller：缺口集合计算（含午休边界 11:30/13:00 不误判）；只写缺失 ts
- 全部用 mock Provider + fake clock，不触网
