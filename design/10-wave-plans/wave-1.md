# Wave 1 任务书 — 应用面（web/diagnose/MCP/前端 ①②③）

> ⚠️ 2026-09-03 更新：**Wave 0（10-wave-plans/wave-0.md）已新设并先行**——数据面（采集/降级模式/tushare 日增量/容器化部署）全部提前到 Wave 0，按 ADR-017 独立部署。本任务书顺延为应用面：web server / diagnose 查询 API / MCP / 前端，范围相应缩减（后端第 1–5 项已由 Wave 0 交付）。
>
> ⚠️ 2026-09-04 实施定稿（用户批准 8 页四层布局文档后开工）：
> - **部署形态**：ADR-017——新增 `eestock-app` bin 与 compose `app` 服务（应用面容器），与数据面零 API 直连、只读/写库；数据面已有代码一律不动（除 domain 加法扩展需架构师批准）
> - **布局事实源**：`design/06-web/*.md` 四层布局节（L1/L1.5/L2/L3）已全覆盖 8 页；前端布局以 tangle 生成的 `web/src/layouts/*Grid.tsx` 骨架为准，区域 id 与 `data-region` 一致；样式基调 = 01-dashboard 样机的深色交易终端风
> - **分阶段实施**：Phase A 后端（web crate REST/WS + diagnose 读库 + eestock-app + 部署）→ Phase B 前端骨架 + 页面① → Phase C 页面②③ → Phase D MCP
> - 验收标准同步修正：采集/熔断/缺口率项已由 Wave 0 验收闭环（缺口率 0.06%）；本波验收 = 页面①②③可用 + MCP 可查行情与源健康 + `docker compose up -d` 起三容器（db/data/app）

> 目标（用户短期目标原文）：通过新数据源，**稳定地把关心的交易数据获取并存储到数据库**，并**实时关注数据源可用性**（诊断系统）。
> 本任务书是委派 coder/tester 的输入。全程 TDD（Red-Green-Refactor），文学式单向 tangle。

## 范围

### 后端（Rust）
1. **workspace 骨架**：crates 布局见 01-architecture/00-overview；entangled.toml + tangle 一致性 hook（ADR-007）
2. **domain crate**：按 02-domain/contracts.md 落码（先测后码）
   - `types.rs`：Code 市场前缀（5→sh/1→sz）单测；Bar/Quote 序列化
   - `selector.rs`：随机起点分布、轮转序确定、熔断剔除、空池
   - `merge.rs`：accurate 优先、raw 补缺、仅 accurate 有时点保留、排序
3. **providers crate**：
   - `TencentIfzq`：`ifzq.gtimg.cn/appstock/app/kline/mkline?param=<pfx><code>,m1,,320`，JSON 解析 `[时间,开,收,高,低,量(手),{},额(万元)]`——⚠️ 2号位是收不是高；手→股×100、万元→元×10000（028 §2.1 golden 样本驱动测试）
   - `SinaJsonp`：`quotes.sina.cn/.../CN_MarketDataService.getKLineData?symbol=<pfx><code>&scale=1&ma=no&datalen=240`，剥 jsonp 包裹+防盗链前缀；含 amount（028 §2.2）
   - 快照池（TencentQt/SinaHq(Referer 必带)/ThsCs/Push2delay/Exchange）：仅健康心跳用，解析最小字段（028 冒烟 CSV 为 golden）
   - 每 Provider：token bucket 限频 + 随机抖动；错误分类到 ProviderError（403/429→RateLimited）
4. **storage crate**：迁移 0001-0003（04-storage/schema.md）；`KlineWriter.write_batch`（首写胜出断言行数）；merge 视图与 domain merge.rs 契约测试
5. **collector crate**：调度循环（每 code 按 interval_secs）、attempt_chain 拉取、当日缺口回填（启动时补齐当日缺失分钟 bar）、心跳任务（快照源 30-60s）、事件写 source_health_events
6. **diagnose crate（Wave 1 最小集）**：源健康查询 API（成功率/延迟/熔断/最近错误）；WebSocket 推送通道
7. **web crate（后端）**：REST `/api/kline`、`/api/sources/health`、`/api/symbols`；WS `/ws`；SPA 静态托管
8. **app crate**：DI 装配、配置（TOML）、tracing 初始化

### 前端（React 工程）
9. 骨架（Vite+React+TS+Tailwind/shadcn）+ 路由 + WS 客户端
10. **页面①行情看板**：klinecharts，1m/5m/15m/日切换（读 cagg），MA/MACD/KDJ/BOLL
11. **页面②数据源诊断**：各源健康卡片（成功率/延迟/熔断/最近错误），WS 实时刷新
12. **页面③标的管理**：注册集合增删改、间隔配置、启停

### MCP
13. HTTP/SSE 服务；工具：kline 查询、源健康（ADR-009 范围①②）

## 验收标准
- [ ] `entangled tangle && git diff --exit-code` 通过（门禁生效）
- [ ] domain 单测全绿；providers 以 028 golden 样本的解析测试全绿
- [ ] 注册 518880/513310/161226/159776，盘中运行 1 日：kline_raw 缺口率 <1%（非源故障时段）
- [ ] 杀掉腾讯源（本地代理模拟）：失败当周期内自动转移新浪，下一周期起熔断源从轮转摘除，诊断面板可见熔断事件（⚠️ 审查修正：原「接管 <10s」与 60s 采集周期矛盾，改为可测口径）
- [ ] 页面①②③可用；MCP 客户端（Claude Desktop）能查到行情与源健康

## 明确不做（Wave 1 边界）
tushare 同步（Wave 2）、告警规则引擎（Wave 2）、筹码（Wave 2/3）、回测（Wave 3）、交易（Wave 4）、响应式、认证

## 环境前置（开工前人工确认）
- [ ] TimescaleDB 实例就绪（Docker `timescale/timescaledb:latest-pg16`）
- [ ] Rust 工具链 stable；Node LTS
- [ ] 旧系统已停跑（ADR-001）
- [ ] ⚠️ 审查补充：golden 样本从旧仓 `golang/coder/scripts/out/`（028 冒烟 CSV + 腾讯/新浪响应样例）复制到 `eestock-rs/crates/providers/testdata/`，Provider 解析测试以此驱动
- [ ] ⚠️ 审查补充：交易日历 Wave 1 简化口径——仅工作日判断（周末不采集）；法定节假日会产生全天空跑/缺口噪音，可接受，节假日表 Wave 2 接入
