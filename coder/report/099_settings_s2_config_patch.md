# 设置页 S2：配置持久化 + PATCH + 运行时应用（状态：已交付核心 + 应用注记）

> 本报告路径：`eestock-rs/coder/report/099_settings_s2_config_patch.md`
> 子任务：实现设置页 S2（使 source/collector/mcp 配置真正可设置）。依据 design/06-web/08-settings.md + 07-app-plane/00-web-api.md（config 契约）。TDD + ADR-007，不 commit。

## 1. 完成边界

- ✅ **迁移 0021**：`app_config` 表（key text PK + value jsonb + updated_at）。存 sources/collector/mcp 三块配置；默认值 = 现 GET 返回默认（内置源参数 / 60s / 交易工具关 / 50000·20）。
- ✅ **dao 端口/存储**：`domain::ports::ConfigStore`（get(key)->Value / set(key,Value)）+ `storage::config_store::PgConfigStore` 实现。
- ✅ **web 端点（PATCH）**：`PATCH /api/config/sources`（完整清单 + 轮转序 + 东财末位校验 ADR-006 + 每源 rate_per_sec/jitter_ms/circuit_fail_count/backoff_steps/enabled 值域校验）、`PATCH /api/config/collector`（default_interval_sec ≥60）、`PATCH /api/config/mcp`（enabled/trading_tools_enabled/daily_limit_amount/daily_limit_count ≥0）。校验失败 400；写库 + 返回快照。
- ✅ **GET 读持久**：原 GET 只读默认改为读 `app_config`，缺则默认回退。
- ✅ **前端保存启用**：Source/Collector/Mcp 面板移除「保存禁用/S2 占位」，改为编辑→PATCH→乐观更新（失败回滚）→值域前端提示；交易工具开启二次确认（ADR-009）。
- ⭕ **运行时应用（collector/MCP）**：**本期注记（未接线）**。任务允许「若改动大先做持久化+端点+GET 读持久、collector 应用单独注记」。详见 §4 残留风险与方案。

## 2. 变更内容（文件 / 层归属）

| 层 | 文件 | 变更 |
|---|---|---|
| 存储 schema | `migrations/0021_app_config.sql`（新） | app_config 表（0021） |
| domain 端口 | `crates/domain/src/ports.rs`（+ConfigStore） | 配置持久化端口（trait） |
| storage 实现 | `crates/storage/src/config_store.rs`（新） | PgConfigStore（get/set） |
| storage 模块 | `crates/storage/src/lib.rs`（+config_store） | 注册模块 |
| storage 自检 | `crates/storage/src/migrate_check.rs`（+app_config） | EXPECTED_RELATIONS 增 app_config |
| web DTO | `crates/web/src/dto.rs`（+SourceConfigPatchItemDto/Dto、CollectorConfigPatchDto、McpConfigPatchDto + 校验纯函数） | PATCH 请求体 + 值域/东财末位校验（纯函数，单元可测） |
| web handler | `crates/web/src/settings.rs`（PATCH×3 + GET 读持久 + merge_source_config） | config 端点 |
| web 路由 | `crates/web/src/lib.rs`（.patch(...)） | PATCH 路由 |
| web 状态 | `crates/web/src/state.rs`（+config 字段） | AppState 注入 ConfigStore |
| app DI | `crates/app/src/bin/eestock-app.rs`（+config） | 装配 PgConfigStore |
| app/单元测试 | `crates/web/tests/api_settings.rs`（+clear_config + PATCH 集成测试） | 后端 TDD |
| storage 测试 | `crates/storage/tests/config_store.rs`（新） | ConfigStore get/set/覆盖/跨 key |
| 全部测试装配 | `crates/web/tests/{api_admin,api_alerts,api_backtest,api_favorites,api_ma_config,api_quality,api_rest,api_settings,ws_poller}.rs`（+config 字段） | AppState 增字段波及装配 |
| 前端 API | `web/src/api/{types,client,mock}.ts`（+saveConfigSources/Collector/Mcp + patch 类型 + mock 内存态） | 前端 API 层 |
| 前端页面 | `web/src/features/settings/{Source,Collector,Mcp}ConfigPanel.tsx`（启用保存/编辑/乐观更新/校验/二次确认） | 前端 S2 |
| 前端测试 | `web/src/features/settings/SettingsPage.test.tsx`（保存/校验/ADR-006/ADR-009/回滚） | 前端 TDD |
| 设计文档 | `design/{02-domain/contracts.md, 04-storage/02-tushare-sync.md, 03-raw-writer.md, schema.md, 07-app-plane/00-web-api.md, 02-alerts.md}` | tangle 事实源同步 |

> `crates/web/tests/api_kline_period.rs` 为既有未入库测试文件（磁盘存在），本任务为其 AppState 增补 `config` 字段以适配新字段（属装配波及，非功能引入）。

## 3. 实现要点 / 关键决策

- **配置存储 = 通用 key→jsonb**：`ConfigStore` 只做 get/set key→Value；web 层做字段划分（sources/collector/mcp）与校验。分层：domain 端口 → storage 实现 → app 装配 → web 只依赖端口（ADR-017 不违，不变 storage/sqlx 到 web 的依赖方向）。
- **PATCH 请求体走 `Json<serde_json::Value>` 手动反序列化**：使字段类型错（如 enabled 非布尔）映射为 **400** 而非 axum 默认 422。语义校验与类型校验统一 400，满足验收「非法→400」。
- **source 持久化仅存可编辑字段**：label/role/rotation_locked 由服务端按 `SOURCE_CONFIG` 派生；轮转序 = sources 数组顺序；`merge_source_config` 把持久化参数合并回完整快照（缺源补默认）。
- **ADR-006 默认序对齐（见 §5）**：基线 `SOURCE_CONFIG`/`RESET_SOURCES`/mock `sourceConfig` 原把 push2delay 置于 index 5（非末位），与 ADR-006「东财末位」及 PATCH 校验冲突。为使默认 GET 与 PATCH 校验自洽，把 push2delay 移至数组末位（其余 7 源相对序不变）。
- **前端乐观更新**：保存时先存 `lastSaved` 基线→立即应用本地态→成功以响应覆盖→失败回滚 `lastSaved`；值域非法或东财非末位时禁用保存并提示。
- **ADR-009**：交易工具开启需页面二次确认（确认/取消），确认后才置 `trading_tools_enabled=true`。

## 4. TDD Red→Green 记录

后端：
- **Red**：先写 `storage::tests::config_store`（get 缺失→None、set 后 get 一致、覆盖、跨 key 独立）+ `web::tests::api_settings`（PATCH 合法→200+落库+GET 读持久；非法 rate<0/东财非末位/enabled 非布尔→400；collector <60→400；mcp 金额<0→400；GET 缺省回退默认）。首跑失败（端点 404/405；无 ConfigStore；AppState 缺字段）。
- **Green**：迁移 0021 落库 + ConfigStore 端口/实现 + PATCH 端点 + GET 读持久 + 校验 + AppState/装配/测试全量增补 → 全部转绿。

前端：
- **Red**：编写「保存启用/编辑→PATCH/东财不可上移/值域非法禁用/collector PATCH/mcp 二次确认+保存/保存失败回滚」用例（`saveConfigSources`/`saveConfigCollector`/`saveConfigMcp` 未在 client/mock 暴露 → TS/断言失败）。
- **Green**：补齐 `client.ts`/`types.ts`/`mock.ts` 接口方法 + 面板实现 → 用例转绿。

## 5. 验证结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `cargo test --workspace` | 通过（除既有 flaky） | 唯一失败 `storage::tests::alert_store::list_events_filters`，**已用 `git stash` 在基线 HEAD 复现，确认为既有失败，非本任务引入** |
| `cargo test -p web` | 43 通过 | lib + 全部集成 |
| `cargo test -p storage --test config_store` | 1 通过 | ConfigStore |
| `cargo test -p web --test api_settings` | 5 通过 | 含 PATCH 持久化 + 400 全覆盖 |
| `cargo test -p web --lib dto::tests::` | 21 通过 | 含 config 校验纯函数 |
| `cargo test -p web --lib settings::tests::` | 2 通过 | 含 push2delay 末位断言 |
| `cd web && npx vitest run` | 367 通过 / 7 失败 | 7 失败均为 `features/alerts/*`（既有 flaky，基线同样失败） |
| `cd web && npx tsc -b` | 通过 | exit 0 |
| `cd web && VITE_API_MOCK=0 npx vite build` | 通过 | 127 modules，产物 dist/ |
| `entangled tangle` | 幂等 | 二次运行 "Nothing to be done"，无 code/doc 漂移 |

> 本会话已手工向测试库 `:5433` 应用 `migrations/0021_app_config.sql`（`app_config` 表，0 行），供集成测试落库验证。该表为应用面自有表，重新新建容器后由 docker-entrypoint 按文件名顺序自动执行。

## 6. 残留风险 / 未完成

1. **collector/MCP 运行时应用未接线（本期注记）**：collector 源参数（rate/jitter/circuit/backoff/enabled）编译/启动期注入数据面源注册表，MCP/SimLive 的 trading tools/daily limit 为内存态（`mcp_enabled`/`trading_enabled` AtomicBool），均无 `app_config` 读钩子。
   **方案（后续波次）**：
   - collector：启动/重载时读 `app_config['sources']`，把可编辑参数映射到源配置（token bucket 速率/抖动/熔断次数/退避档位/enabled）；启用数据面控制通道或启动期装卸载，标注「下周期生效/需重启数据面」。
   - MCP/SimLive：给 `SimLiveService` 注入 `ConfigStore`，`mcp_enabled`/`trading_tools_enabled`/daily limit 初始值改从 `app_config` 读（缺则默认）；PATCH 后由 SimLive 重读热生效。
   - 本期做到「能存能读」（持久化+端点+GET 持久+前端保存），数据面应用单独注记。
2. **ADR-006 默认序对齐改动**：把 push2delay 从 index 5 移到末位（其余 7 源相对序不变）。影响 `GET /api/config/sources` 默认返回与 `reset-circuits` 的 RESET_SOURCES 顺序（该顺序仅用于 web 层 reset 遍历，不影响数据面采集序）。需父级确认这一「默认轮转序对齐 ADR-006」是否符合预期。
3. **既有 flaky 未修复（职责外）**：`alert_store::list_events_filters`（storage）、`features/alerts/*`（vitest 7 条）在起跑线即失败，非本次改动引入；未纳入修复范围。
4. **entangled db undead 告警**：`design/11-sim-live/mcp-access.md` 被 `entangled reset` 前误删后仍在 db 中（磁盘已删，未生成代码），仅告警不影响 tangle 幂等（"Nothing to be done"）；已从 git index 移除。
5. **后端集成测试依赖 DB 已应用 0021**：若在全新容器跑，需先初始化；本会话已手工应用。

## 7. 未 commit

已确认**无任何 git 暂存文件**（`git diff --cached --name-only` 为空），全部改动在 `eestock-rs` 子仓库工作树（30 个修改 + 4 个新增文件）。仅运行了 `entangled tangle`（只写生成物/文档，不产生 git 暂存）。
