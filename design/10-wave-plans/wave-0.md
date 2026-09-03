# Wave 0 任务书 — 完备产品级数据获取（数据面）

> 目标（用户 2026-09-03 定稿）：本轮之后，**历史与实时数据获取链路产品级 ready**（交易系统数据除外）。
> 数据先行：交付即可长期无人值守运行，持续积累 kline_raw + kline_accurate。
> 本任务书是委派 coder/tester 的输入。全程 TDD（Red-Green-Refactor），文学式单向 tangle：先改 design/ 文档代码块，再 `entangled tangle`。

## 范围

### 1. domain crate（补测试 + 补全）
- `types.rs`：Code 市场前缀（5→sh/1→sz）单测；Bar/Quote 序列化
- `selector.rs`：随机起点分布、轮转序确定、熔断剔除、空池
- `merge.rs`：accurate 优先、raw 补缺、仅 accurate 有时点保留、排序
- `provider.rs`/`ports.rs`：ProviderError 错误分类（03 §4 口径）、Provider trait 双抽象（ADR-016）

### 2. providers crate（golden 样本驱动，不触网）
- **Tier1 分钟源**：TencentIfzq（主）、SinaJsonp（备）——端点/字段序/单位/限频严格按 03 §1、§2
- **Tier2 快照池**（降级模式用，解析最小字段 last/prev_close/vol/amount/data_ts/name）：TencentQt、SinaHq（Referer 必带）、ThsCs、Push2delay（fltt=2 强转 float 前科）、Exchange（沪深双端点）
- 每 Provider：token bucket 限频 + 随机抖动 + 超时（默认 8s，东财系 5s）；错误分类到 ProviderError
- golden 样本：从旧仓 `golang/coder/scripts/out/` 复制至 `crates/providers/testdata/`

### 3. storage crate
- `KlineWriter.write_batch` 写 kline_raw（ON CONFLICT 首写胜出，断言行数）
- `approx` 来源标记支持（`source=*_approx`，降级模式产物，03 §6）
- merge 视图与 domain merge.rs 契约测试
- sqlx migrate 启动自检（0001–0006 已有）

### 4. collector crate（按 03 §1–§7 全量，含降级模式）
- Scheduler：每 code 独立 ticker，分钟边界相位对齐 + 0~2s 抖动；每周期重读 symbols 热生效
- FetchExecutor：ADR-015 时间窗轮换当班（随机窗长 20–40min，窗界切换 0–30s 随机偏移）+ attempt_chain + 3 根重叠首写胜出；Trace ID 贯穿
- CircuitRegistry：熔断状态机全路径（连续3败→Open→60s冷却→HalfOpen→成功闭合；冷却×2封顶30min；RateLimited 走 5s→10s→30s 退避不进熔断计数）
- GapBackfiller：启动时 + 每 30 分钟当日缺口回填（09:30–11:30 ∪ 13:00–15:00，240 分钟；午休边界不误判）
- **StandbyReserve 降级模式（本轮必做）**：快照池平时零请求；attempt_chain 全链失败→该标的降级：快照池随机打乱逐源 5–10s（含抖动）轮询，本地合成近似 1m bar（`source=*_approx`）；Tier2 源失败指数退避；Tier1 HalfOpen 探测成功→回切正常，近似 bar 留待准确层覆盖
- EventSink：source_health_events 落库（03 §7 事件模型，含 na 口径与熔断迁移事件）
- TradingCalendar：仅工作日判断（节假日噪音接受，Wave 2 接节假日表）

### 5. tushare 准确层日增量
- 数据面容器内置定时任务：每交易日 15:30（Asia/Shanghai）触发 tushare_sync 增量（复用 sync_checkpoints），失败指数退避重试 3 次，事件落 source_health_events（source=tushare）
- 既有全量同步能力保留为手动运维命令

### 6. app crate + 部署（ADR-017）
- `eestock-data` bin：DI 装配、TOML 配置、tracing 初始化（JSON 日志、Trace ID）
- `/healthz` 只读存活探测（8080 端口，供 compose healthcheck）
- Dockerfile（多阶段构建，运行时最小镜像）+ docker-compose `data` 服务：`depends_on: timescaledb (healthy)`、启动时 sqlx migrate 自检、`restart: unless-stopped`
- `docker compose up -d` 一条命令起 timescaledb + data

## 验收标准
- [ ] `entangled tangle && git diff --exit-code` 通过（门禁生效）
- [ ] domain/providers/storage/collector 单测全绿（mock provider + fake clock，不触网）
- [ ] `docker compose up -d` 起全栈，`/healthz` 可达，采集随容器自启
- [ ] 实盘 1 个完整交易日：44 标的 kline_raw 缺口率 <1%（非源故障时段）
- [ ] 杀掉腾讯源连通性（本地代理模拟）：当周期自动转移新浪，熔断事件落库可查；双源全杀 → 标的进入降级模式，kline_raw 出现 `source=*_approx` 行，Tier1 恢复后自动回切
- [ ] tushare 日增量任务在模拟时钟下触发/重试/落事件行为正确（fake clock 单测）+ 一次真实收盘后增量成功

## 明确不做（边界）
web / diagnose 查询 API / MCP / 前端 / 交易 / 节假日表 / 熔断手动复位（Wave 1 走 DB 控制通道）/ 响应式 / 认证

## 环境前置（开工前人工确认）
- [x] 旧 Go 系统已彻底停跑（用户 2026-09-03 确认）
- [x] TimescaleDB 就绪（docker compose，宿主机 5433；0001–0006 已落库）
- [x] golden 样本可得（旧仓 golang/coder/scripts/out/）
- [x] 44 只 ETF 已注册 enabled、interval_secs=60
- [ ] Rust 工具链 stable + Docker 可用（coder 自检）
