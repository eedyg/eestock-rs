# 034 — 设置页 S1 的 ADR-007 合规重编排（design 源回写 + tangle 重生成）

> 本报告位置：`coder/report/034_adr007_settings_s1_design_sync.md`
> 关联报告：`coder/report/033_settings_page_s1.md`（S1 本体验证、偏差与风险）
> 任务契约：ADR-007「design 是唯一事实源、生成物禁止手改」；check-tangle 纪律。
> 性质：**设计源同步 / 重编排**，零功能改动。未 commit，未 stage。

## 1. 问题描述（为什么有此一役）

报告 033 的 S1 实现是**只手改在 tangle 生成的代码文件里**，设计文档源未同步——
违反「design 文档是唯一事实源、生成物禁止手改」（check-tangle 纪律）。例如：

- `crates/collector/src/lib.rs` 有 `pub const VERSION`，但 `design/03-collector/00-design.md`§9.1 无。
- `crates/storage/src/lib.rs` 有 `pub mod system`，但 `design/04-storage/02-tushare-sync.md` 无。
- `web/src/layouts/SettingsGrid.tsx` 已是 `_props`，但 `design/06-web/08-settings.md` L3 仍为 `props`。
- 6 端点 DTO/路由/端口/DI 全部散落在生成文件里，但 `design/07-app-plane/00-web-api.md` 未记。

若直接跑 `entangled tangle`，会以设计块为准**回退**这些手改（报告 033 §5.1 已预警「下次 tangle 再生成会回退」）。

## 2. 解决：把生成文件当前内容「逆向」回写设计块，再 tangle 重生成

做法不是「改功能」，而是**让设计块 = 生成文件当前内容**（begin/end 标记之间的字节级一致），
使 tangle 以设计为源重生成的文件逐字节复现当前实现。用脚本逐块核对后回写；
对「设计块存在」的 tangle 文件做整块内容对齐，对「设计无块」的文件保留手写并列出。

### 2.1 设计文档改了什么（6 个 .md）

| 设计文档 | 改动 | 对应生成文件（块） |
|---|---|---|
| `design/03-collector/00-design.md` | §9.1 collector/lib.rs 块加 `/// crate 编译时版本…` + `pub const VERSION` | `crates/collector/src/lib.rs` |
| `design/07-app-plane/00-web-api.md` | diagnose/lib.rs 块加 VERSION；web/lib.rs 块加 `pub mod settings` + 6 路由；dto.rs 块加 6 端点 DTO/校验纯函数；state.rs 块加 `system_info`/`raw_purge` 字段；eestock-app.rs 块加 system_info 装配 + 两个 AppState 字段；api_rest/api_admin/api_quality/ws_poller 四测试块加各自 `state()` 的 `system_info`/`raw_purge` | `crates/diagnose/src/lib.rs`、`crates/web/src/lib.rs`、`crates/web/src/dto.rs`、`crates/web/src/state.rs`、`crates/app/src/bin/eestock-app.rs`、`crates/web/tests/{api_rest,api_admin,api_quality,ws_poller}.rs` |
| `design/02-domain/contracts.md` | ports.rs 块加 `SystemInfoRead` / `RawPurgePort` 两端口（含 doc 契约） | `crates/domain/src/ports.rs` |
| `design/04-storage/02-tushare-sync.md` | storage/lib.rs 块加 `pub const VERSION` + `pub mod system;`（指向 08-settings.md 代码块） | `crates/storage/src/lib.rs` |
| `design/06-web/08-settings.md` | L3 `SettingsGrid(props)` → `SettingsGrid(_props)`（+ 说明注释） | `web/src/layouts/SettingsGrid.tsx` |
| `design/07-app-plane/02-alerts.md` | api_alerts.rs 块加 `state()` 的 `system_info`/`raw_purge` | `crates/web/tests/api_alerts.rs` |

6 端点契约文本：以 DTO/路由 doc 注释形式落进设计块（`SystemInfoDto`/`ConfirmReq`/`PurgeRawResultDto`/
`ResetCircuitsResultDto`/`SourceConfig*`/`CollectorConfigSnapshotDto`/`McpConfigSnapshotDto`/`RESET_SOURCES`），
格式契约见 `design/06-web/08-settings.md`§6 的 API 依赖表。

### 2.2 逐文件 diff 对应关系（设计块增量 = 生成文件增量，1:1）

- `03-collector +3` ↔ collector/lib.rs `+3`（VERSION）
- `04-storage +6` ↔ storage/lib.rs `+6`（VERSION + `pub mod system`）
- `02-domain +17` ↔ ports.rs `+17`（2 端口）
- `06-settings +4/-1` ↔ SettingsGrid.tsx `+4/-1`（`_props` + 注释）
- `07-web-api +145` ↔ eestock-app `+13` + diagnose `+3` + web/lib `+8` + dto `+80` + state `+4` + api_rest `+10` + api_admin `+9` + api_quality `+9` + ws_poller `+9`
- `02-alerts +9` ↔ api_alerts `+9`

## 3. 哪些文件确属手写（非 tangle），保留并在此列出

tangle 标记扫描（`design/**/*.md` 全部 `file=` 块 vs 全仓 tangle 标记文件）确认：

- `crates/web/src/settings.rs` —— 6 端点 handlers + `SystemInfoSource`（标记指向 08-settings.md，但 08-settings.md 无该块）。**非 tangle 生成 → 手写保留**。
- `crates/storage/src/system.rs` —— `PgSystemInfo`/`PgRawPurge` 端口实现（同上，无块）。**非 tangle 生成 → 手写保留**。
- `crates/web/tests/api_settings.rs` —— 4 项设置端点集成测试（无块）。**非 tangle 生成 → 手写保留**。
- `web/src/features/settings/*`（SettingsPage/SettingsNav/SystemInfoPanel/DangerZone/SourceConfigPanel/CollectorConfigPanel/McpConfigPanel/LogViewer/useApiSlice/SettingsPage.test）—— 前端手写组件/测试，非 tangle。
- 前端 `/api/*`（client.ts/mock.ts/types.ts）、`App.tsx`、`shell/navItems.ts`、`shell/NavBar.test.tsx` —— 手写，非 tangle。

以上改动属 S1 实现本身（报告 033 §1），本任务**未动**它们，仅回写设计块，故保留。

## 4. tangle 重生成与「无游离改动」验证

1. 回写后 `entangled tangle --force`（因手改文件被标记为「在 Entangled 控制外变更」需 --force；`--force` 仅清除冲突回退屏障，设计块内容 = 文件内容，故逐字节复现）。
2. 9 个主文件 + 5 个测试文件 **pre/post tangle sha256 逐字节一致** → 无水印、无回退。
3. 再跑 `entangled tangle`（无 --force）：**`Nothing to be done`** → 项目全量幂等，设计现在是唯一事实源。
4. 游离改动检查：tangle 标记但无设计块的文件仅上述 3 个（settings.rs/system.rs/api_settings.rs），均为**手写**，符合「若设计无块则保留手写」口径。不存在「设计文档未含但生成文件却有」的游离生成物。

## 5. 验证（逻辑不变，仅重编排）

| 命令 | 结果 |
|---|---|
| `cargo test -p web` | ✅ 25 单测 + 集成 4（api_settings）/2（api_admin）/3（api_alerts）/1（api_quality）/2（api_rest）/1（ws_poller）全绿 |
| `cargo clippy --workspace --all-targets` | ✅ 无告警 |
| `cd web && npx vitest run` | ✅ 25 文件 / 191 用例全绿 |
| `cd web && npm run build` | ✅ `tsc -b && vite build` 通过（chunk>500kB 为既有非阻断提示） |

## 6. 已完成范围

- ✔ design 块回写：14 个 tangle 生成文件的设计源已同步（9 主文件 + 5 测试文件）。
- ✔ `pub const VERSION`（collector/diagnose/storage）由设计块驱动。
- ✔ 6 端点契约、DTO、路由、端口、state、DI、测试 `state()` 全部进设计块。
- ✔ `SettingsGrid(props)` → `SettingsGrid(_props)`（strict noUnusedParameters）进 L3 块。
- ✔ tangle 重生成幂等、零功能改动；未真删 kline_raw；未改任何功能逻辑；未 commit、未 stage。

## 7. 残留风险（residual risks）

1. **手写文件带 tangle 标记**：`settings.rs`/`system.rs`/`api_settings.rs` 含 `// ~/~ begin …` 标记但无设计块。
   因不在 `filedb`，`entangled tangle` 不触动它们（已实证），故安全；但标记具误导性——
   若日后在这些文件上做设计块，需先在 design 建块（本任务按「无块即手写」口径处理，刻意未建块）。
2. **只读配置快照硬编码于 web**（报告 033 §5.2 原有风险，与本任务无关，S2 需引权威源）。
3. **crate 版本来源为编译期 env!**（033 §5.3），本任务未改。
4. **reset-circuits 通用语义**（033 §5.4），本任务未改。
5. **`--force` 依赖**：本次因设计块=文件内容，`--force` 复现一致；未来任何人手改生成文件后未同步设计，
   `entangled tangle` 将再次报「conflicts」并要求 `--force` 或先 `stitch`——这正是本任务要消除的纪律缺口。

## 8. Git 状态结构（设计改 + 生成文件随之改）

- 设计文档（tracked，改）：`design/{02-domain/contracts,03-collector/00-design,04-storage/02-tushare-sync,06-web/08-settings,07-app-plane/00-web-api,07-app-plane/02-alerts}.md`
- tangle 生成文件（tracked，改，均由设计驱动）：collector/diagnose/storage/domain/web lib.rs、web dto.rs/state.rs/lib.rs、app eestock-app.rs、5 个 web tests、SettingsGrid.tsx
- 手写 S1 文件（tracked 改 / untracked 新增，非 tangle）：`App.tsx`、`api/*`、`shell/*`、`features/settings/*`、`system.rs`、`settings.rs`、`api_settings.rs`
- 无任何 staged（`git diff --cached --name-only` = 0）；未 commit。
