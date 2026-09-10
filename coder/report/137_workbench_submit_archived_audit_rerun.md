# 137 — todo#11：归档策略版本允许审计重跑（workbench submit 放宽）

- 日期：2026-09-10
- 任务：todo #11（wave25 契约冲突裁决落地）——workbench submit 允许 archived 版本（审计重跑）；draft 仍拒绝；catalog/sim-live/live_approved 语义不放宽。
- 报告路径：`coder/report/137_workbench_submit_archived_audit_rerun.md`

## 变更点（what changed）

| 文件 | 层 | 变更 |
|---|---|---|
| `crates/application/src/workbench.rs`（非 tangle 手写） | application | `validate_slot` 版本门禁由「仅 published」放宽为 **published \| archived**；draft 仍 400，文案区分「未发布（status=draft），draft 版本不可运行（published/archived 版本可运行）」与不存在 404。`ValidatedSlot` 新增 `archived: bool`；submit 与 preset 钉住快照 slots 均新增 **`archived` 审计标记**字段（archived 版本 → true，published → false）。模块/函数文档同步。 |
| `crates/application/tests/workbench.rs` | application 测试 | 删 `submit_rejects_archived_version_400`；新增 `submit_accepts_archived_version_with_audit_marker`（archived 提交成功 + 快照标记 + 真实执行至 succeeded）、`submit_marks_published_version_not_archived`；draft 测试加文案断言（含「未发布」+「draft」）。 |
| `design/07-app-plane/01-mcp.md` → tangle → `crates/mcp/src/tools.rs` | MCP（app-plane） | `bt_run_ensemble` 工具描述与 doc 注释同步新口径（published\|archived 可运行、archived=审计重跑、draft 拒绝）；新增测试 `bt_run_ensemble_archived_version_audit_rerun`（显式 version_id 钉 archived → 提交成功 + config 快照 archived=true + bt_get_run 详情返回标记 + 跑至 succeeded）。**版本解析路径核对**：MCP 自身不做 published-only 校验，语义校验全部委托 `WorkbenchService::submit`；version_id 缺省仍走 catalog（仅 published）解析——与裁决一致，无需额外改动。 |
| `crates/web/tests/api_workbench.rs` | web 集成测试 | 新增 `submit_archived_version_audit_rerun_201`（REST：archive → submit 201 + 快照标记 + 详情返回标记 + succeeded）；`submit_validation_error_matrix` draft 400 加文案断言；生命周期测试加 published → archived=false 断言。 |
| `design/07-app-plane/00-web-api.md` §1.8 | 文档（tangle 源，仅散文/表格） | submit 行错误列「版本非 published」→「版本为 draft（未发布代码不可运行；published\|archived 可运行）」；快照形状加 `archived`；submit 口径段补「版本状态口径（2026-09-10 裁决）」：archived=审计重跑、标记随 201 响应与详情返回、catalog/sim-live/live_approved 不放宽。 |
| `design/12-strategy-system/01-adr.md` §5 | 文档（非 tangle 源） | Registry 一节补一行：「archived 版本可用于审计重跑（2026-09-10 裁决）」及红线不变说明。 |

未触碰：`crates/application/src/simlive.rs`（会话 published-only 保留）、catalog（`strategy.rs`/storage）、strategy-runtime/core/backtest/simlive、web 前端源码（npm 零回归）。

## 校验矩阵（draft / published / archived / 不存在 × REST / MCP）

| 版本状态 | REST `POST /api/workbench/runs` | MCP `bt_run_ensemble`（显式 version_id） |
|---|---|---|
| draft | 400「未发布（status=draft）…不可运行」（api_workbench.rs::submit_validation_error_matrix） | isError（tools.rs::bt_run_ensemble_unpublished_and_invalid_config_are_is_error） |
| published | 201 + `archived:false`（submit_run_lifecycle_end_to_end） | 成功 + 钉住（bt_run_ensemble_happy_path_and_run_queries） |
| archived | 201 + `archived:true` 审计标记 + succeeded（submit_archived_version_audit_rerun_201） | 成功 + `archived:true` + succeeded（bt_run_ensemble_archived_version_audit_rerun） |
| 不存在 | 404（submit_validation_error_matrix / application::submit_rejects_unknown_version_404） | isError（未知 version_id 用例） |
| version_id 缺省（仅 MCP） | — | catalog 解析最新 published；无 published → isError（口径不变） |

审计标记流向：submit 201 响应 config 快照 / `GET /api/workbench/runs/{id}` 详情 / MCP `bt_get_run` 均返回 `config.slots[i].archived`；preset 钉住 config 同形状（apply → submit 回环兼容，多余字段被 SlotReq 忽略）。

## TDD 证据

- **Red**：先改测试（archived 应成功 + 标记），运行 `cargo test -p application --test workbench` → 2 failed（`submit_accepts_archived_version_with_audit_marker` 报「仅 published 版本可运行」、`submit_marks_published_version_not_archived` 标记缺失）。
- **Green**：改 `validate_slot` + 快照，application 14 passed；MCP 新增测试首轮失败（断言方式误用 isError==false，成功帧无该字段），改 `payload_of` 断言归档行 status 后通过。
- **Refactor**：仅文档/注释同步，无结构性重构。

## 验证（全绿）

- `cargo build --workspace`：0 error（2.88s）。
- `cargo test --workspace --no-fail-fast`：85 个 test binary，合计 **587 passed / 0 failed**。
- `cargo clippy --workspace --all-targets -- -D warnings`：0 warning（触源文件强制重查后通过）。
- `entangled tangle`：Nothing to be done（tools.rs 与 01-mcp.md 一致，无 diff）。
- `cd web && npm test`：45 文件 **447 passed / 0 failed**。
- gitnexus：CLI impact 查询 Rust symbol 未命中（索引不含本符号），已人工做 blast radius 分析——`submit` 调用方仅 web handler 与 MCP bt_run_ensemble，`validate_slot` 另服务 preset 校验；新增 JSON 字段为纯加法，风险低。

## 红线自查

- catalog 下拉（`GET /api/strategies`、`strategy_list`）仍仅 published——未改。
- sim-live 会话策略校验（simlive.rs「仅 published 版本可用于会话」）——未改。
- live_approved 语义——未改。
- strategy-runtime/core/backtest/simlive crate——零改动。

## 状态

已 `git add`（7 文件），未 commit。
