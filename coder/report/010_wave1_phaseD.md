# 010 — Wave 1 Phase D：MCP server（ADR-009 范围①②：行情查询 + 源健康）

> 报告位置：`coder/report/010_wave1_phaseD.md`（本文件）
> 任务：新建 crates/mcp（HTTP/SSE 常驻 MCP 服务，工具 get_kline / get_sources_health）、
> eestock-app 同进程装配（端口独立 8082）、compose 暴露 8082。
> 依据：ADR-009（形态与范围定稿）、07-app-plane/00-web-api.md（应用面模式与分层红线）、
> 02-domain/contracts.md（KlineRead/HealthEventsRead 只读端口复用）、wave-1.md（Phase D 验收口径）。

## What changed（21 文件已 git add，未 commit）

### 设计事实源（先改 design 再 tangle，ADR-007）

- **`design/07-app-plane/01-mcp.md`（新建）**：mcp crate 全部代码块的事实源——
  §0 决策注记（父级裁决记录）、§1 协议契约（transport/JSON-RPC 方法/工具 schema 与错误口径）、
  §2 mcp crate 六个代码块、§3 两层集成测试、§4 app 装配口径（代码块属主在 00-web-api.md）、§5 TDD 要点。
- **`design/07-app-plane/00-web-api.md`（纯加法）**：头部 +Phase D 注记；`app_config.rs` 块
  +`mcp_listen`（默认 `0.0.0.0:8082`，env `MCP_LISTEN`）；`eestock-app.rs` 块装配 MCP
  （HealthEventsRead 实现实例提取为共享 Arc + McpState spawn）；`app_config` 测试块 +3 断言；
  `Dockerfile.app` 块 `EXPOSE 8081 8082`。web/diagnose/storage 既有代码块零改动。
- **`design/99-decisions-log.md`**：补记 2026-09-04 Phase D 裁决（transport 口径、tokio-stream 批准、
  Streamable HTTP 列 Wave 2 backlog、同进程/端口独立/泄漏防护口径）。

### 父级裁决记录（架构升级流程，本轮唯一架构歧义）

**问题**：axum 0.8 不内置 SSE，`Body::from_stream` 需 futures-core TryStream；workspace 零相关依赖声明，
与「零新增依赖」红线冲突。三候选上报（contact_supervisor need_decision）：

- **A（批准）**：`tokio-stream`（workspace 级 `0.1` + features `sync`）——真 SSE transport，忠于 ADR-009；
  锁文件零新增包（sqlx 传递依赖 tokio-stream 0.1.19 已在树内），代码最少。
- B：futures-core 手写 Stream impl（多 poll 样板）。
- C：零依赖 Streamable-HTTP-JSON（偏离 ADR-009「HTTP/SSE」字面口径，否决）。

附加口径（已落实）：SSE 连接泄漏防护（SessionGuard drop 注销 + 15s 保活帧 + 溢出 410）；
MCP Streamable HTTP（2025-03-26 spec）列 Wave 2 评估 backlog（99-decisions-log）。

### crates/mcp（tangle 生成物，全部新增）

- **`state.rs`**：`McpState`（KlineRead 端口 + diagnose HealthService + 默认窗口 + 会话登记）；
  `SessionRegistry`（create/sender/remove/len；sessionId = rand 32hex，与 Trace ID 同口径不引 uuid）。
- **`rpc.rs`**：JSON-RPC 2.0 纯分发层（可离线 TDD）——initialize（protocolVersion=2024-11-05 /
  capabilities.tools / serverInfo）、ping、tools/list、tools/call；通知（notifications/* 或无 id）→ 无响应；
  未知方法 -32601；id 原样 echo。
- **`tools.rs`**：`get_kline(code, period=1m, limit=240≤1000)` 经 `KlineRead`（merge 视图准确层优先，
  与 REST 同端口同语义，升序、source 仅 1m 带）；`get_sources_health(window_secs=默认≤604800)`
  经 `HealthService`（diagnose 聚合口径原样）。错误两分：参数非法 → -32602（协议层）；
  端口/聚合失败 → result.isError=true（MCP 工具错误惯例）。period 映射 5 行自带
  （mcp 不依赖 web——两 Presentation 层防反向依赖）。交易类工具不做（ADR-009 范围④ Wave 4）。
- **`server.rs`**：SSE transport（spec 2024-11-05）——GET /sse（endpoint 首帧 + message 帧 +
  15s `:ka` 保活）；POST /messages?sessionId=（一律 202，响应经 SSE 异步下发；400 缺 id / 404 未知会话 /
  410 通道溢出 / -32700 坏帧）；`SessionGuard` 随流 drop 注销会话（泄漏防护）；`serve()` 常驻入口。
- **`mocks.rs`**（cfg(test)）：mock KlineRead/HealthEventsRead（记录调用参数 + failing 变体），
  证明 mcp 与 storage 解耦。

### crates/app（既有块纯加法，代码块属主 00-web-api.md）

- `app_config.rs`：`mcp_listen` 字段（默认 `0.0.0.0:8082`，env `MCP_LISTEN` 覆盖）。
- `bin/eestock-app.rs`：**同进程装配**（任务书授权「同进程更简单选同进程」——复用同一 DI 产物，
  文档已注明）：HealthEventsRead 实现提取为共享 Arc，McpState 复用 `state.kline.clone()`，
  `tokio::spawn(mcp::server::serve(...))`；**端口独立** 8082。

### 手写例外（不 tangle，README 既定口径）

- `Cargo.toml`（workspace）：`tokio-stream = { version = "0.1", features = ["sync"] }`（父级批准标注）。
- `crates/mcp/Cargo.toml`：正常依赖 = domain/diagnose/axum/tokio-stream/serde/serde_json/chrono/tokio/
  tracing/anyhow/rand；dev 依赖 = storage/sqlx/reqwest/async-trait（分层红线同 web 口径）。
- `crates/app/Cargo.toml`：+`mcp = { path = "../mcp" }`。
- `docker-compose.yml`：app 服务 +`"8082:8082"`（MCP HTTP/SSE，免认证内网 ADR-010）。
- `config/app.toml.example`：+`mcp_listen` 行。
- `Cargo.lock`：仅 mcp 包依赖边 + app→mcp 边；**零新增包版本**（tokio-stream 0.1.19 本就在树内）。

## Architecture alignment

- **分层红线**：mcp 正常依赖只有 domain + diagnose（+ 基础设施 crates）；`cargo tree -p mcp -e normal`
  grep storage/sqlx = 0 命中。storage/sqlx 仅 dev-dependencies（集成测试装配造数，同 web 既定模式）。
- **端口复用零新 SQL**：get_kline → `domain::ports::KlineRead`（storage KlineReader，merge 视图准确层
  优先 ADR-003）；get_sources_health → `diagnose::health::HealthService`（聚合口径 05-diagnose §1 原样）。
- **ADR-017**：应用面只读库，与数据面零直连；数据面 collector/providers/tushare/storage 写入路径
  一行未动（git diff 可证——storage 目录零变更）。
- **同进程决策**（任务书授权范围内自决）：eestock-app 同时 serve web(8081) 与 MCP(8082)，
  复用同一 KlineRead/HealthEventsRead 实例；独立 bin 会重复整套 DI/配置面，违背 KISS。
- **零新增编译单元**：唯一新声明依赖 tokio-stream 已在锁文件（sqlx 传递依赖），父级裁决批准。

## TDD Red-Green-Refactor 记录

1. **Red**：01-mcp.md 首版 tools.rs 为 `todo!()` 桩 + 全部测试先行 → `cargo test -p mcp`：
   `rpc::tools_list_and_call_route_to_tools_layer FAILED (not yet implemented)`（其余帧/状态测试已绿）。
2. **Green**：填实 tools.rs → 14 单测全绿；协议级测试首轮发现会话注销断言失败——
   根因 = 测试夹具读流任务持有连接（drop 接收端不发 FIN），修夹具（abort 读流任务）后全绿；
   DB 测试首轮并行互删（共享 clean 触碰两资源——既有文档警告过的实锤坑），拆 clean_kline/clean_health 后全绿。
3. **Refactor**：clippy 4 警告清零（doc 列表缩进 ×3、BarsCall.code 未读 → 补断言、len()→is_empty()），
   全程测试保护。

## Test coverage（新增 18 测试）

- `crates/mcp/src/state.rs`（1）：会话生命周期 + 32hex 唯一 id。
- `crates/mcp/src/rpc.rs`（5）：initialize 三要素 / id echo / 通知无响应 / -32601 / tools 路由。
- `crates/mcp/src/tools.rs`（8）：schema 契约（两工具、required、enum、无交易工具）/ 缺省值与透传 /
  limit 封顶与 period 映射 / -32602 矩阵（含未知工具）/ 端口失败 isError ×2 / 窗口钳制 / 缺 params·name。
- `crates/mcp/tests/mcp_protocol.rs`（2，无 DB）：**协议级全链路**——真实 server + SSE 长连接 +
  POST JSON-RPC 帧：endpoint 首帧格式、initialize/tools/list/tools/call（get_kline·get_sources_health）
  往返、通知 202 无响应帧、未知方法 -32601、坏帧 -32700（id null）、参数错 -32602、
  断连会话注销（泄漏防护）；另测缺 sessionId 400 / 未知会话 404。
- `crates/mcp/tests/mcp_tools_db.rs`（2，真实库 :5433）：merge 准确层优先经工具端到端、
  健康聚合 0.75/degraded/last_error 经工具端到端。
- `crates/app/tests/app_config.rs`（+3 断言）：mcp_listen 默认值 + MCP_LISTEN env 覆盖。

## Verification

- `./scripts/check-tangle.sh` → ✅ tangle 后无 diff。
- `cargo test --workspace` → **144 passed, 0 failed**（含 mcp 18 新增；DB 集成测试走真实 :5433）。
- `cargo clippy --workspace --all-targets` → **0 warning**。
- `cargo tree -p mcp -e normal | grep -cE "storage|sqlx"` → 0（分层红线实测）。
- **实盘冒烟**（eestock-app 二进制 + 真实库）：同进程双端口——`:18081/healthz` ok；
  `:18082/sse` endpoint 帧 → POST initialize/tools/list/tools/call 全 202 → SSE message 帧依序下发——
  `get_kline(518880)` 返回真实 merge bar（source=tencent_ifzq）、`get_sources_health` 返回真实卡片
  （sina_jsonp healthy/1.0；tencent_ifzq degraded/0.91、last_error=timeout@513750）；`:ka` 保活帧可见。
- compose/Dockerfile 未实际构建镜像（沿用既有 app 服务定义加法，构建验证留部署窗口）。

## 残余风险 / 边界说明

1. SSE transport 为 spec 2024-11-05 口径（ADR-009）；Streamable HTTP（2025-03-26）已列 Wave 2 评估
   backlog（99-decisions-log）。Claude Desktop 远程接入经 SSE 支持（或 mcp-remote 代理），本期验收口径内。
2. SSE 断连清理依赖写失败检测（保活 ≤15s 内收敛）；实测 hyper 在客户端 FIN 后即刻清理（协议测试锁定）。
3. 免认证（ADR-010 内网）：MCP 面与 web 面同口径，公网暴露属部署层红线（compose 端口映射控制）。
4. get_kline 无游标参数（任务书签定 code/period/limit 三参）；LLM 翻页场景后续按需评估加 before。
