# 115 — P2b 后端补端点：Strategy Registry 两个管理端点

- 报告位置：`coder/report/115_strategy_registry_p2b_manage_endpoints.md`
- 基线：P2a 封板 b1c5d9e；架构裁决 A/A；契约与前端锁定（未改一字既有契约，纯加法）。

## 问题/需求

P2b 前端联调发现 2 个 API 缺口，补两端点（契约已定稿）：

1. `GET /api/strategies/manage?kind=strategy|template`（kind 可选）→ 200 `{ items: [...] }`：
   **全部策略（含仅 draft / 零版本）**，每条目聚合 `version_count`、
   `latest_version`（版本号最大版本，任意状态；零版本 → null）、
   `latest_published`（最新 published `{id,version,approval_level}`，无 → null）。
2. `PATCH /api/strategies/{id}` body `{name?, description?}` → 200 更新后 strategy 行；
   均空 → 400；name trim 后为空 → 400；未知 id → 404；命中推进 `updated_at`。

## 变更文件（已 git add，未 commit）

| 文件 | 层 | 变更 |
|---|---|---|
| `design/02-domain/contracts.md` | domain 契约源 | StrategyStore 增 `manage_list`/`update_meta` + 3 个 DTO（`StrategyManageItem`/`StrategyManageVersionSummary`/`StrategyManagePublishedSummary`），字段序=wire 序 |
| `crates/domain/src/ports.rs` | domain（tangle 生成物） | 由 contracts.md tangle 生成（+50 行），禁手改 |
| `crates/storage/src/strategy.rs` | storage | `PgStrategyStore` 两方法实现 + `ManageJoinRow` 手写 FromRow（18 列超元组上限，与 `CatalogJoinRow` 同模式） |
| `crates/application/src/strategy.rs` | application | `StrategyService::manage_list`（透传）/ `update_meta`（校验 400/404 + 合并口径） |
| `crates/web/src/strategies.rs` | web | `manage_list`/`update_meta` handlers + `ManageQuery`/`UpdateMetaReq` DTO（非 tangle 手写区，ADR-007 例外同既有模式） |
| `crates/web/src/lib.rs` | web（tangle 生成物） | 路由：`GET /api/strategies/manage`（静态段，matchit 优先于 `{id}`）、`/api/strategies/{id}` 增 `.patch()` |
| `design/07-app-plane/00-web-api.md` | web 契约源 | §1.7 REST 表追加两端点行 + lib.rs 路由代码块（→ tangle） |
| `design/04-storage/schema.md` | storage 契约源 | §4.3.13 追加 P2b 查询口径说明（无新迁移，复用 0022 表） |
| `crates/storage/tests/strategy_store.rs` | 测试 | +2 集成测试 |
| `crates/application/tests/strategy.rs` | 测试 | MockStore 两方法 + 3 服务测试 |
| `crates/web/tests/api_strategies.rs` | 测试 | +2 REST 集成测试 |

## 实现要点（既定架构内决策）

- **manage_list 一查询聚合（无 N+1）**：`strategy` LEFT JOIN 三段 LATERAL——
  ① `count(*)` 版本计数；② 版本号最大版本（任意状态，`ORDER BY version DESC LIMIT 1`）；
  ③ 最新 published（同式 + `status='published'`）。`kind` 精确匹配，按 `strategy.id` 升序。
- **update_meta 分层**：service 负责校验（均空 400 / name trim 空 400 / 未知 id 404 经 `get_strategy`）
  与合并（未给字段保持原值、name trim 后落库）；storage 为原子最终值 UPDATE +
  `updated_at = now()` + `RETURNING`（0 行 → `Ok(None)` 双保险 404）。
- **路由安全**：`/api/strategies/manage` 静态段在 axum matchit 中优先于 `{id}` 参数段，
  GET manage 不会落入 `get_strategy`（REST 集成测试实测 200 验证）。

## 测试覆盖（TDD：Red 先写测试编译失败 → Green 实现 → 全绿）

- storage 集成（TimescaleDB :5433）：
  - `manage_list_includes_draft_only_and_aggregates`：仅 draft 策略在列且 latest_published=None；
    零版本策略 latest_version=None/version_count=0；v1 published+v2 draft → latest_version=v2(draft)/
    latest_published=v1；kind 过滤。
  - `update_meta_updates_fields_and_advances_updated_at`：字段落库 + updated_at 推进 + 未知 id None。
- application（mock store）：
  - `manage_list_includes_draft_only_with_aggregates`、`update_meta_validation_400_and_404`、
    `update_meta_happy_trims_name_and_keeps_missing_fields`。
- web REST 集成（真实 axum + reqwest + DB）：
  - `manage_endpoint_lists_all_strategies_with_aggregates`：200 `{items}` 形态/null 形态/kind 过滤/非法 kind 400。
  - `patch_meta_update_and_error_semantics`：200 trim 落库/未给字段保持/均空 400/空白 name 400/未知 id 404。

## 验证证据

- `cargo build --workspace`：0 error。
- `cargo test -p storage --test strategy_store`：13 passed / 0 failed。
- `cargo test -p application`：lib 10 + service 11 + simlive 37 + strategy 28，全绿。
- `cargo test -p web`：11 个测试目标全绿（api_strategies 7 passed）。
- `cargo test -p domain -p app`：全绿。
- `cargo clippy --workspace --all-targets`：新增 0 warning（既有 11 处 warning 均在
  simlive.rs/tools.rs/reader.rs 等未触碰文件，HEAD 基线相同）。
- `entangled tangle`：重跑 "Nothing to be done"（生成物与源一致，无 diff）。

## 残留风险/歧义

- **预存在失败（非本次引入）**：`storage::alert_store::list_events_filters` 在干净 HEAD（git stash 后）
  同样失败（断言 2≠1），疑似运行中的 eestock-app 容器污染共享测试库 alert 事件数据；与本变更无关。
- 歧义处理：`description` 未做 trim（契约仅规定 name trim）；`update_meta` 响应为 `StrategyRow`
  （契约「更新后 strategy 行」）；manage item JSON 字段序按契约声明序排布（serde struct 字段序）。
- 未触碰红线：未改 web/ 前端目录（另一 worker 施工中，其未跟踪修改未 add）、
  未动 strategy-runtime/core/backtest/simlive、未 commit、无新依赖、无新迁移。
