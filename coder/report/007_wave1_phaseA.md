# Coder Report 007 — Wave 1 Phase A：应用面后端（web/diagnose/eestock-app/部署）

- 日期：2026-09-04（跨轮次续作；首轮因超时中断于文档编写前，本轮从断点完成）
- 本报告路径：`coder/report/007_wave1_phaseA.md`
- 铁律遵守：文学式单向 tangle（全部 Rust 代码由 design/ 生成）、TDD Red-Green、数据面写路径零改动、只 stage 不 commit。

## 1. What changed（变更清单）

### 设计文档（事实源）
| 文件 | 变更 |
|---|---|
| `design/07-app-plane/00-web-api.md` | **新增**（约 800 行）：REST/WS 端点契约表（§1）+ diagnose/web/storage-reader/app 全部代码块与测试 + Dockerfile.app + TDD 要点 |
| `design/04-storage/02-tushare-sync.md` | 加法 1 处：storage lib.rs 块增加 `pub mod reader;`（父级授权的读接口扩展） |
| `design/03-collector/02-data-plane.md` | 加法 1 处：app lib.rs 块增加 `pub mod app_config;`（不改变 eestock-data 行为） |

### 生成代码（tangle 产物，勿手改）
| 文件 | 层 | 说明 |
|---|---|---|
| `crates/diagnose/src/{lib,health}.rs` | Application | 健康窗口聚合：成功率（**分母排除 err_kind='na'**，03 §7）、p50/p95（percentile_cont）、熔断态（窗口内最近迁移事件推导）、最近错误（排除 circuit_*/manual_reset 迁移类）、状态灯（05 §1：95% 边界）；单 SQL 三 CTE 一次往返 |
| `crates/storage/src/reader.rs` + lib.rs | Infrastructure | **纯加法** KlineReader：1m 读 kline_merged（准确层优先 ADR-003）；5m/15m/1d 读 cagg（volume numeric→bigint 归一）；1h 由 kline_15m 查询期 rollup（schema 无 kline_1h cagg）；symbols+最新快照 LATERAL 最近 2 根；游标分页 ts<before 降序取翻转升序 |
| `crates/web/src/{lib,dto,state,rest,ws,spa}.rs` | Presentation | REST 三端点 + /healthz；WS /ws 订阅分发（bar/quote/health，通配订阅，广播+连接侧过滤）；Poller 轮询推送（ADR-017 只读库口径，游标内存推进、无增量不重推）；SPA 手写静态托管（不引 tower-http，零新增依赖，防目录穿越） |
| `crates/app/src/app_config.rs`、`src/bin/eestock-app.rs`、lib.rs | 装配 | AppConfig（TOML+env 覆盖 DATABASE_URL/APP_LISTEN）；eestock-app bin：DI 装配 + schema 自检复用 + tracing JSON + Poller spawn；--self-check 复用 healthz::self_check |
| `Dockerfile.app` | 部署 | 多阶段构建 eestock-app，非 root uid 10002，COPY web/dist → /app/dist |

### 手写工程文件
- `docker-compose.yml`：新增 `app` 服务（depends_on 仅 timescaledb(healthy)，**不依赖 data**；8081:8081；healthcheck 用二进制 --self-check）
- `config/app.toml.example`（入库模板；`config/app.toml` 已入 .gitignore）
- `README.md`：新增「启动应用面」节、布局更新（任务指派归我）
- `crates/{web,diagnose,app}/Cargo.toml`：依赖接线；`Cargo.lock` 同步
- `.gitignore`：+`/config/app.toml`

### 测试（全部新增）
| 文件 | 覆盖 |
|---|---|
| `crates/diagnose/tests/health_agg.rs`（3 集成，真实库 :5433）+ health.rs 内联 3 单测 | na 排除分母、分位数插值、熔断态推导（open→manual_reset→closed）、最近错误排除迁移类、状态灯 95% 边界、窗口外不入选 |
| `crates/storage/tests/kline_reader.rs`（3 集成） | merge 准确层优先（tushare 覆盖 raw）、游标不含 before、limit 翻转升序、cagg 4 周期 + 1h rollup、symbols 快照/无 bar 标的 |
| `crates/web/tests/api_rest.rs`（2 集成，真起 server + reqwest） | 3 页游标分页无重复缺漏、400 校验（period/before）、5m cagg、symbols latest/change_pct、sources/health 端到端、SPA 深链回退与穿越安全 |
| `crates/web/tests/ws_poller.rs`（1 集成） | Poller 增量推送：首轮 bar+quote、无增量不重推、新 bar 再推 |
| `crates/web/src/{dto,ws,spa}.rs` 内联单测（9） | parse_period 口径、JSON tag 形状、matches 矩阵、订阅往返/坏帧忽略、sanitize/mime |
| `crates/app/tests/app_config.rs`（1） | TOML 默认值 + env 覆盖 |

## 2. Architecture alignment

- ADR-017：应用面与数据面零 API 直连——WS 推送源为**轮询库**（非 NOTIFY/直连），`app` compose 服务不依赖 `data`；控制通道未实现（POST/PATCH symbols、reset 属 Phase B/C，§1.4 明确不做）。
- 分层：web(Presentation) → diagnose(Application)/storage(Infrastructure) → domain（仅复用 Period 类型，**零 domain 改动**）。
- 数据面写路径（collector/providers/tushare/storage 写）零改动，gitnexus detect_changes 佐证（见 §4）。
- 依赖：仅启用 axum `ws` 特性（ADR-008 既定栈内开关）+ reqwest 作 web dev-dependency（workspace 既定）；**未引入任何新 crate**。

## 3. Problem solved / 实施要点与踩坑

1. **cagg volume 类型**：连续聚合 sum(bigint)→numeric，读取须 `::bigint` 归一（测试实锤）。
2. **1h 周期**：schema 只有 5m/15m/1d cagg——1h 由 kline_15m rollup（first/last 为 timescaledb 聚合，普通查询可用），语义等价且仍「读 cagg」。
3. **并行测试互删（实锤踩坑 ×2）**：同 binary 内 #[tokio::test] 并行执行，共享测试 code/source 的 clean() 互删导致随机失败——每测试独立 code/source 常量（997701/997711/997721-22、diag_test_{rate,circuit,window}、996601/996602/web_test_src/996603）。
4. **目录穿越口径**：fallback handler 拿到的 `Uri::path()` 是未解码形式，`..%2F..` 只是普通文件名→回退 index.html，天然安全；sanitize 拒绝字面 `..`/反斜杠/空段。测试断言据此修正。
5. **WS topic 命名**：任务书口径 `"health"`（02-sources 文档中 `"source_health"` 为同一通道，已在 §1.4 注明由前端适配层映射——请架构师知悉此命名差异）。

## 4. Verification

| 检查 | 结果 |
|---|---|
| `entangled tangle` 幂等（前后 md5 全量比对 crates/+migrations/+Dockerfile*） | ✅ 无差异（"Nothing to be done"） |
| `cargo test --workspace` | ✅ exit 0，44 个 binary 全 ok（约 112 用例 0 失败，含两轮重复跑验证并行稳定性） |
| `cargo clippy --workspace --all-targets` | ✅ exit 0，零 warning |
| `gitnexus detect-changes --repo eestock-rs` | ✅ risk=low，affected processes=0；变更符号仅 lib.rs 模块声明与文档节，无既有函数行为变化 |
| 手动冒烟（eestock-app 真跑 + 真实库 5433） | ✅ /healthz 200；/api/kline 15m/1h 返回真实 bar（518880）；/api/symbols 含 latest+change_pct（159337 等真实标的）；/api/sources/health?window_secs=604800 返回真实聚合（sina_jsonp/tencent_ifzq 成功率/p50/熔断 half_open/最近错误）；SPA / 返回 index.html |

注：`./scripts/check-tangle.sh` 的 `git diff --quiet` 当前因 `design/10-wave-plans/wave-1.md`（父级 2026-09-04 实施定稿头的**预存未暂存修改**，非本次产出）而失败；tangle 本身幂等无差异。该文件留给父级处置（我不 stage 不属于自己的改动）。

## 5. 建议 commit 切分

1. `feat(diagnose): 源健康窗口聚合查询（成功率排除 na，05 §1 口径）` — design/07 文档 + crates/diagnose/** + Cargo 接线中 diagnose 部分
2. `feat(storage): KlineReader 只读加法扩展（merge/cagg/rollup/快照）` — storage reader + 02-tushare-sync.md lib.rs 声明 + kline_reader.rs
3. `feat(web): axum REST /api/kline /api/symbols /api/sources/health + WS /ws + SPA 托管` — crates/web/**
4. `feat(app): eestock-app bin + AppConfig + 部署（Dockerfile.app/compose app/config 模板/README）` — crates/app/** + Dockerfile.app + docker-compose.yml + config/app.toml.example + README.md + .gitignore + Cargo.lock

（如偏好单 commit，`feat: Wave 1 Phase A 应用面后端` 一把出亦可——四步仅为审查粒度建议。）

## 6. Residual risks / 交接事项

- **web/dist 占位页已被前端 worker 构建产物覆盖**（当前 dist/index.html 为其 vite 构建输出，未 stage 归其处置）。`Dockerfile.app` 的 `COPY web/dist` 要求构建时 dist 存在——compose 构建需在前端 build 之后或父级决定把占位页入库。⚠️ 需父级/架构师知会前端 worker 协调。
- WS 无线端 e2e 测试（无 ws 客户端依赖可用；未获批引入 tokio-tungstenite/reqwest-websocket）——以 Poller 集成测试 + 订阅匹配/帧格式单测覆盖，handle_socket 收发循环仅冒烟未自动化。
- `/api/sources/health` 只含窗口内有事件的源（编译期源清单不在应用面）；前端需对缺失源渲染「无数据」。已在 §1.1 文档化。
- `window_secs` 默认 3600 与页面② SOURCES_DEFAULTS.successRateWindow='1h' 一致。

---

## 返工记录（2026-09-04，父级审查裁决，不需再上报确认）

### 返工 1 — 分层违规修复（web↛storage、diagnose↛sqlx）

按 Wave 0 既有模式（RawBarReader/SymbolRegistry 先例）整改：

- `design/02-domain/contracts.md` §2.4 **纯加法**：只读端口 `KlineRead`（bars 游标分页 / latest_bar 默认实现 /
  symbols_with_latest）与 `HealthEventsRead`（window_events）+ 读模型
  `KlineBarView` / `SymbolLatestView` / `HealthEventRow`（读模型不复用 Bar/HealthEvent：cagg 无 source、
  volume i64 归一、err_kind 容忍裸文本；既有契约零改动）。
- storage：`KlineReader` 实现 `KlineRead`；新增 `HealthEventReader` 实现 `HealthEventsRead`
  （窗口过滤 SQL 下沉 storage：§3 reader.rs）。
- diagnose：去 sqlx 依赖。聚合下沉为纯函数 `aggregate_events`（含自实现 `percentile_cont` 线性插值，
  与 PG 口径一致并有对拍单测 [100,300]→p50=200/p95=290）+ `HealthService` 端口注入编排。
  原 DB 集成测试改写为纯函数测试（同断言集）+ mock 端口注入测试；窗口过滤/字段映射由 storage
  集成测试 `window_events_filters_window_and_maps_fields` 锁定；端到端仍由 web `/api/sources/health` 锁定。
- web：handlers/Poller 改依赖 `Arc<dyn KlineRead>` + `HealthService`；Cargo.toml 正常依赖去掉
  storage/sqlx（storage/sqlx 移至 dev-dependencies，仅供集成测试装配与造数）。
- app bin：装配不变位置（本来就持有 storage），改为注入端口具体实现。

**验收证据**：
- `cargo tree -p web -e normal`：无 storage、无 sqlx（含 domain/diagnose/axum 等 81 节点）
- `cargo tree -p diagnose -e normal`：无 sqlx（anyhow/chrono/serde/domain/async-trait(via domain) 等）
- `cargo test --workspace` exit 0（44 binaries 全 ok）；`cargo clippy --workspace --all-targets` exit 0 零警告

### 返工 2 — Dockerfile.app 自包含

- 三阶段：`frontend`（node:22-bookworm-slim：COPY package.json+package-lock.json → `npm ci` → COPY web/ →
  `npm run build`）→ `builder`（rust 编译 eestock-app）→ runtime（debian-slim 非 root，
  `COPY --from=frontend /web/dist /app/dist`）。构建上下文无需预存 dist。
- 前端 dist 产物不入库：`web/.gitignore` 已含 `dist/`（前端 worker 维护，确认存在无需补）；
  新增根级 `.dockerignore`（排除 .git/target/**/node_modules/**/dist/data/logs 等，裁剪构建上下文）。
- **验证**：`docker build -f Dockerfile.app -t eestock-app:phase-a .` exit 0；容器冒烟
  （--network host + 真实库 5433）：/healthz 200、/api/kline 返回 merge 视图真实 bar（source=tushare
  准确层 ✓）、/ 与 /assets/*.js 由镜像内 dist 服务（200 text/javascript）、/api/sources/health 聚合正常、
  容器内 `--self-check` exit 0。本地 `npm run build` 同口径预验通过（vite build ✓ 61 modules）。

### 返工变更文件清单（相对首版）

`design/02-domain/contracts.md`、`crates/domain/src/ports.rs`、`design/07-app-plane/00-web-api.md`、
`crates/diagnose/{Cargo.toml,src/health.rs,tests/health_agg.rs}`、`crates/storage/{src/reader.rs,tests/kline_reader.rs}`、
`crates/web/{Cargo.toml,src/{state,dto,rest,ws}.rs,tests/{api_rest,ws_poller}.rs}`、
`crates/app/src/bin/eestock-app.rs`、`Dockerfile.app`、`.dockerignore`（新增）、`Cargo.lock`。
