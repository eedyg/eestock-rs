# 架构总览

## 分层视图（严格单向依赖，禁止跨层直达）

```
┌────────────────────────── Presentation ──────────────────────────┐
│  Web UI (React SPA, 8页)      MCP Server (HTTP/SSE)    CLI(可选)  │
│        │ WebSocket/REST              │ MCP tools                 │
├────────┼─────────────────────────────┼───────────────────────────┤
│        ▼        Application          ▼                           │
│  CollectorService   RegistryService   QualityService             │
│  DiagnoseService    AlertService      BacktestService            │
│  TradingService                                                  │
├────────────────────────── Domain ────────────────────────────────┤
│  Bar/Quote/Code/Period   ProviderRegistry   SourceSelector       │
│  HealthMonitor(熔断/心跳)  ChipCalculator   MergePolicy(准确层优先)│
├────────────────────── Infrastructure ────────────────────────────┤
│  Providers: tencent_ifzq | sina_jsonp | tencent_qt | sina_hq |   │
│             thscs | push2delay | exchange                        │
│  Storage: TimescaleDB (kline_raw/kline_accurate/cagg/health)     │
│  Tushare: HTTP client (准确层同步)                                │
│  Broker: 券商浏览器自动化 (Wave 4)                                │
└──────────────────────────────────────────────────────────────────┘
```

## Crate 布局（Rust workspace）

```
crates/
├── domain/       # 纯领域：类型+trait+策略，零基础设施依赖（DI 的根）
├── collector/    # 应用：采集调度、源选取状态机、缺口回填
├── storage/      # 基础设施：TimescaleDB 读写（sqlx）
├── providers/    # 基础设施：各数据源 HTTP 适配器（GBK/JSONP/字段映射）
├── tushare/      # 基础设施：tushare 客户端 + 准确层同步
├── diagnose/     # 应用：健康指标聚合、告警规则引擎
├── mcp/          # Presentation：MCP HTTP/SSE 服务
├── web/          # Presentation：axum REST + WebSocket + SPA 静态托管
└── app/          # 二进制装配：DI 组装、配置加载、进程入口
web/              # 前端 React 工程（Wave 1 起）
migrations/       # TimescaleDB DDL（由 04-storage/*.md tangle 生成）
```

## 规则

1. domain 不依赖任何其他 crate；所有基础设施经 trait 注入
2. providers/storage/tushare 实现 domain 定义的 trait，禁止反向依赖
3. 每 crate 一个 design 子目录对应（见 00-vision 文档树）
4. 可观测性：tracing + Trace ID；metrics 暴露给 diagnose
