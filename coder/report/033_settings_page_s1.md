# 033 — 设置页 S1 低风险切片（页面⑧ 首站）

> 本报告位置：`coder/report/033_settings_page_s1.md`
> 依据契约：`design/06-web/08-settings.md`（权威，L2/L3 已定稿）
> 任务范围：仅 S1（页面组件 + 路由 `/settings` + 导航启用 + 只读/运维区）。S2（配置持久化 / 日志采集 / WS）仅占位，未实现。

## 1. What changed（文件清单）

### 前端（web/src）

| 文件 | 类型 | 说明 |
|---|---|---|
| `web/src/api/types.ts` | 修改 | 新增 `SystemInfo`、`SourceConfigSnapshot`、`SourceConfigItem`、`CollectorConfigSnapshot`、`McpConfigSnapshot`、`PurgeRawResult`、`ResetCircuitsResult`（snake_case 与后端线格式同构）|
| `web/src/api/client.ts` | 修改 | `ApiClient` 增 `getSystemInfo` / `getConfigSources` / `getConfigCollector` / `getConfigMcp` / `purgeRaw` / `resetCircuits`（含实现）|
| `web/src/api/mock.ts` | 修改 | mock 实现上述 6 方法 + `mockSourceConfig()`（内置源清单/默认值）|
| `web/src/features/settings/SettingsPage.tsx` | 新增 | 页面基座：`SettingsGrid` 骨架 + `RegionPortal` 挂 7 区（settings-nav/6 内容区）|
| `web/src/features/settings/SettingsNav.tsx` | 新增 | 分组锚点滚动定位 + 高亮 |
| `web/src/features/settings/SystemInfoPanel.tsx` | 新增 | `GET /api/system/info` 渲染版本/crate/DB/运行时长（三态）|
| `web/src/features/settings/DangerZone.tsx` | 新增 | `POST purge-raw` / `reset-circuits`，二次确认（PURGE/RESET，缺失被拒）|
| `web/src/features/settings/SourceConfigPanel.tsx` | 新增 | 只读源参数快照 + 保存禁用（S2 标注）+ `SaveDisabledNote` |
| `web/src/features/settings/CollectorConfigPanel.tsx` | 新增 | 只读采集参数快照 + 保存禁用 |
| `web/src/features/settings/McpConfigPanel.tsx` | 新增 | 只读 MCP 快照 + 保存禁用 |
| `web/src/features/settings/LogViewer.tsx` | 新增 | S2 占位（日志跟随待采集层/WS）|
| `web/src/features/settings/useApiSlice.ts` | 新增 | 区域三态 async 加载 hook |
| `web/src/features/settings/SettingsPage.test.tsx` | 新增 | 页面集成/行为测试（6 区/confirm 缺失被拒/只读禁用/system-info）|
| `web/src/App.tsx` | 修改 | `<Route path="/settings" element={<SettingsPage/>} />` |
| `web/src/shell/navItems.ts` | 修改 | settings `enabled:true`（⑧ 解锁）|
| `web/src/shell/NavBar.test.tsx` | 修改 | 更新解锁项断言（⑧ 现为链接）|
| `web/src/layouts/SettingsGrid.tsx` | 修改 | **偏离“禁止手改”**：`props`→`_props`，修复骨架潜伏编译错误（见 §5）|

### 后端（crates）

| 文件 | 类型 | 说明 |
|---|---|---|
| `crates/domain/src/ports.rs` | 修改 | 新增端口 `SystemInfoRead::ping`（SELECT 1 db_ok）、`RawPurgePort::purge_raw`（DELETE kline_raw）|
| `crates/storage/src/system.rs` | 新增 | `PgSystemInfo` / `PgRawPurge` 实现 + 便捷构造 |
| `crates/storage/src/lib.rs` | 修改 | `pub mod system;` + `pub const VERSION` |
| `crates/collector/src/lib.rs` | 修改 | 增 `pub const VERSION`（crate 版本来源）|
| `crates/diagnose/src/lib.rs` | 修改 | 增 `pub const VERSION`（crate 版本来源）|
| `crates/web/src/dto.rs` | 修改 | 新增 `CrateVersions`、`SystemInfoDto`、`ConfirmReq`、`PurgeRawResultDto`、`ResetCircuitsResultDto`、`SourceConfigItemDto`、`SourceConfigSnapshotDto`、`CollectorConfigSnapshotDto`、`McpConfigSnapshotDto`、`RESET_SOURCES` |
| `crates/web/src/settings.rs` | 新增 | `SystemInfoSource` + 6 端点 handlers + 内置源快照 + 纯函数单测 |
| `crates/web/src/lib.rs` | 修改 | `pub mod settings;` + 6 新路由 |
| `crates/web/src/state.rs` | 修改 | `AppState` 增 `system_info: SystemInfoSource`、`raw_purge: Arc<dyn RawPurgePort>` |
| `crates/app/src/bin/eestock-app.rs` | 修改 | DI 装配新增 `system_info` / `raw_purge` |
| `crates/web/tests/api_settings.rs` | 新增 | 4 集成测试 |
| `crates/web/tests/{api_rest,api_admin,api_quality,api_alerts,ws_poller}.rs` | 修改 | 各自 `state()` 补 `system_info` / `raw_purge` 字段 |

## 2. Architecture alignment

- **S1 只读/运维**：`presentation`(web settings.rs) → `application`(无新增应用服务，纯只读) → `domain`(两个端口) → `infrastructure`(storage system.rs)。遵循 ADR-017：web 只见 `domain::ports`，不依赖 storage/sqlx。
- **端口在 domain、实现于 storage、app 装配**（既有加法扩展同模式）。`reset-circuits` 复用既有 `CircuitResetWrite`（DB 控制通道，ADR-017）。
- **crate 版本**：web 不依赖 collector/storage（分层红线），故经 `SystemInfoSource`（DI）注入 `CrateVersions`，由 app 从各 crate `VERSION` 常量装配。
- **只读配置快照**：值为 `SETTINGS_DEFAULTS`（08-settings L3）默认；S1 不落库（S2 配置持久化再引入权威源）。

## 3. New endpoints / ports

- `GET /api/system/info` → `{app_version, crate_versions, db_ok, uptime_secs}`（只读）
- `POST /api/system/purge-raw`（`{confirm}` 须为 `"PURGE"` 否则 400）→ `{rows_deleted}`（危险：DELETE kline_raw）
- `POST /api/system/reset-circuits`（`{confirm}` 须为 `"RESET"` 否则 400）→ `{requests}`（对全部内置实源写 circuit_reset_requests）
- `GET /api/config/sources` / `GET /api/config/collector` / `GET /api/config/mcp` → 只读默认快照
- 端口：`domain::ports::SystemInfoRead`、`domain::ports::RawPurgePort`

## 4. TDD Red → Green

- 前端：先写 `SettingsPage.test.tsx`（Red：新页面/类型缺引用无法编译/断言失败）→ 实现组件与 mock（Green）。`SettingsGrid.tsx` 参数改名后 `npm run build` 由失败转通过。
- 后端：先写 `api_settings.rs`（Red：6 端点/端口未实现无法编译）→ 实现 domain 端口、storage 实现、web settings/dto/routes、DI（Green）。`settings.rs` 纯函数单测（配置快照/source 清单）随库单测通过。

## 5. 偏差与风险（residual risks）

1. **`SettingsGrid.tsx` 手改**：tangle 骨架潜伏 `props` 未用编译错误（`noUnusedParameters`），因新建页面导入而触发，`npm run build` 被阻断。为满足 build 验收，将参数改名 `_props`（契约 `SettingsGridProps` 不变）。**下次 tangle 再生成会回退**，需随 08-settings.md 生成器同步或接受此微调。
2. **只读配置快照硬编码于 web 层**：值属编译期默认（非数据面源注册），与 07-app-plane §1.1「应用面不知编译期源清单」存在口径张力；S1 只读快照可接受，S2 配置持久化需引入权威源。
3. **crate 版本来源**：为满足 `crate_versions`，在 collector/storage/diagnose 各加 `pub const VERSION`（1 行）。collector 仅在 lib.rs 加常量，未触碰源注册/配置持久化。
4. **reset-circuits “通用”语义**：无独立系统级熔断实体，按“全部内置实源（8 个，非近似变体）”逐一写复位请求；ResetWatcher 对未知源跳过并 warn。
5. **运行容器为旧二进制**：新端点未部署到运行中 `eestock-app`（:8081）；已用 `api_settings.rs` 自带 axum server 完成真实 HTTP 冒烟（等价 curl）。

## 6. Test coverage 与验证

- 前端：`npx vitest run` 25 文件/191 用例全绿（含 SettingsPage 6 用例）。`npm run build` 通过。
- 后端：`cargo test -p web` 全绿（含 api_settings 4 用例、settings/dto 单测）。`cargo clippy -p web --all-targets` / `-p app --bin eestock-app` / `-p domain -p storage -p collector -p diagnose --all-targets` 无告警。`cargo build -p app --bin eestock-app` 通过。
- 危险操作仅测**拒绝路径**（confirm 缺失/不匹配 → 400），未真删 kline_raw。

## 7. S2 占位说明

- `LogViewer`：展示「日志跟随将在下一阶段上线（需日志采集层）」，不实现 WS/采集（tracing ring buffer 归 S2）。
- `SourceConfigPanel`/`CollectorConfigPanel`/`McpConfigPanel`：表单/保存按钮禁用，标注「参数配置化将在下一阶段上线（S2）」；不做 PATCH `/api/config/*` 持久化，不做拖拽排序。
- 未新增任何配置存储/collector 源注册改动。

## 8. Staged files

未 stage、未 commit（`git diff --cached --name-only` = 0）。所有改动保留在工作区，供父级 review。
