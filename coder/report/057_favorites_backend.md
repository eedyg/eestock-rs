# Coder Report 057 — 看板收藏（置顶+排序）后端 F1

**Report file:** `coder/report/057_favorites_backend.md`（本文件）

**Branch:** `master`（eestock-rs 工作区；root 另在 `pr_realtime_use_hist_view`，本次仅在 `eestock-rs/` 改动）
**状态：** 实现完成，`cargo test --workspace` 全绿、`cargo clippy --workspace --all-targets` 无告警、`entangled tangle` 幂等。未 commit。

---

## 设计契约（Grill 定稿，父级批准范围）

一键收藏=自动置顶、收藏区可拖拽排序、DB 持久化、仅影响 symbol-list。严格 ADR-007：
> 迁移/端口/lib 路由/dto/state/app-bin 若 tangle 生成，**先改 design 源再 `entangled tangle`**；手写文件（favorite.rs / favorite_store.rs / api_favorites.rs）注明。

## What changed

### 1. 迁移 0013（tangle，design→SQL）
`design/04-storage/schema.md` 新增 `§4.3.6 看板收藏`，tangle 生成 `migrations/0013_favorite_symbols.sql`：
```sql
CREATE TABLE favorite_symbols (
    code       text PRIMARY KEY REFERENCES symbols(code) ON DELETE CASCADE,
    sort_order integer NOT NULL
);
```
- 应用面自有表（数据面不读写，ADR-017 不违）；删除 symbols 级联清收藏（FK ON DELETE CASCADE）。
- 已用 psql 应用到 :5433 校验通过，并实测 FK 级联（storage 测试 `delete_symbol_cascades_favorite`）。

### 2. domain 端口（tangle，contracts.md→ports.rs）
`design/02-domain/contracts.md` ports.rs 块末尾（`BacktestProgressSink` 后）新增：
- `struct FavoriteItem { code: String, sort_order: i32 }`
- `trait FavoriteStore`: `list_favorites` / `star` / `unstar` / `reorder` / `favorite_map`（全部 `anyhow::Result`）。遍历 `crates/domain/src/ports.rs`。

### 3. storage 实现（**非 tangle 手写**，契约描述在 schema.md §4.3.6）
`crates/storage/src/favorite.rs`（新）`PgFavoriteStore`（PgPool）：
- `star`：`INSERT ... SELECT $1, COALESCE((SELECT MAX(sort_order) FROM favorite_symbols), 0)+1 WHERE EXISTS(symbols...) ON CONFLICT DO NOTHING`。**已修 bug**：初版把 `WHERE EXISTS` 加到聚合 SELECT 上，空收藏集时聚合仍返回一行 → 符号不存在也触发 FK。改为标量子查询 + 顶层 `WHERE EXISTS`，符号不存在 → 0 行（no-op），空收藏集 → 1（首个自顶）。
- `unstar`：`DELETE`（不存在 → rows_affected=0，仍 Ok）。
- `reorder`：事务内逐行 `UPDATE ... SET sort_order = index+1`；空入参 no-op。
- `list_favorites` / `favorite_map`：`SELECT code, sort_order ORDER BY sort_order`；map 非收藏不在。
- `crates/storage/src/lib.rs` 注册 `pub mod favorite;`（design 源：02-tushare-sync.md，tangle）。

### 4. web /api（tangle，00-web-api.md → lib.rs / dto.rs / state.rs / rest.rs）
- **路由**（lib.rs）：`POST/DELETE /api/symbols/{code}/favorite`、`PUT /api/symbols/favorites/order`（补充 `put` import）。
- **DTO**（dto.rs）：`SymbolDto` 增 `favorite: bool`、`favorite_sort: Option<i32>`（恒输出，非收藏 favorite=false / favorite_sort=null）；新增 `ReorderFavoritesReq { codes }`；新增 2 个单测。
- **state.rs**：AppState 增 `favorites: Arc<dyn domain::ports::FavoriteStore>`。
- **rest.rs**：
  - `get_symbols`：经 `st.favorites.favorite_map()` 注入 favorite/favorite_sort，然后**收藏优先** `sort_by`（favorite_sort 升序，非收藏保持原 code 序——`sort_by` 是稳定排序）。
  - `read_symbol`：同样注入 favorite 标注（register/update 回读一致）。
  - 新 handlers：`star_favorite`（POST，200 幂等）、`unstar_favorite`（DELETE，200 幂等）、`reorder_favorites`（PUT，校验所有 code 均已收藏否则 400）。
  - `symbol_exists` 辅助：**复用 `symbols_admin.update(code, &SymbolPatch::default())` 的「无字段 no-op 探测」**（`UPDATE ... SET name=COALESCE(NULL,name)... WHERE code=$1` → rows_affected>0 即存在），不新增 FavoriteStore 端口方法（契约最小集）。
- **§1.1 REST 契约表**：新增收藏三条目。

### 5. app DI（tangle，00-web-api.md → eestock-app.rs）
`eestock-app.rs` 装配 `favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone()))` 注入 AppState。

### 6. 测试装配同步（AppState 增字段后全部构造点补齐）
- tangle 维护：`api_rest.rs` / `ws_poller.rs` / `api_admin.rs` / `api_quality.rs`（00-web-api.md）、`api_alerts.rs`（02-alerts.md）→ 补 `favorites` 字段。
- **直接手写**（无 tangle 块）：`api_settings.rs`（08-settings.md 中该测试块缺失/孤儿，tangle 不再碰它，直接编辑）、`api_backtest.rs`（非 tangle 手写）。

## Architecture alignment
- 分层：端口在 `domain`，实现 `PgFavoriteStore` 在 `storage`，web 只见 `domain::ports::FavoriteStore`，app bin 装配。未改任何现有接口/层边界/依赖方向。
- ADR-017：`favorite_symbols` 为应用面自有表（数据面不读写，与 circuit_reset/alert/backtest 同口径）。
- ADR-007：迁移/端口/lib 路由/dto/state/app-bin + 各 tangle 测试块均「先改 design 源再 tangle」；唯 `favorite.rs`、`favorite_store.rs`、`api_favorites.rs`、`api_settings.rs`（孤儿）、`api_backtest.rs` 为手写（注明）。
- 允许的偏差：`/api/symbols` 的「读取 join favorite_symbols」经 **`favorite_map()` 注入（Application 层）** 而非 KlineRead SQL 联表——因为 web 层只依赖 domain 端口，不能直连 storage 表；契约单列的 `favorite_map` 正是为此服务。语义等价且更贴合分层红线。

## Problem solved / feature added
实现看板收藏（置顶+排序）后端：迁移 0013、FavoriteStore 端口/实现、3 个收藏端点、`/api/symbols` 的 favorite 标注与收藏优先排序、app DI 装配。

## Implementation approach (within approved architecture)
- 收藏=自动置顶：`star` 写 `sort_order=max+1`。
- 幂等语义（父级批准）：`star` 已存在 → 200 无副作用（不做 409）；`unstar` 不存在 → 200（不做 404，仅 code 未注册才 404）。
- 拖拽排序：`reorder(codes)` → `sort_order=索引`，可子集。
- 校验：POST/DELETE 前 `symbol_exists`（no-op update 探测）→ 未注册 404；`reorder` 经 `favorite_map` 预检所有 code 已收藏 → 否则 400。
- `/api/symbols`：`favorite_map` 标注 + `sort_by`（稳定）收藏优先。

## Test coverage
- `crates/web/src/dto.rs`（unit，无 DB）：`symbol_dto_favorite_fields_always_serialize`（favorite/favorite_sort 恒输出）、`reorder_favorites_req_deserialize`（含空数组）。
- `crates/storage/tests/favorite_store.rs`（**手写**，集成，需 DB :5433）：star 自动置顶/幂等、unstar 幂等、list 升序、reorder 重排（sort_order=索引）、favorite_map（非收藏不在 map）、star/unstar 未知符号 no-op、FK 级联。
- `crates/web/tests/api_favorites.rs`（**手写**，集成，真实 server + reqwest）：POST 收藏（置顶）/幂等、DELETE 取消（幂等）、PUT 重排、`/api/symbols` favorite 标注且收藏优先（favorites 在非收藏前、按 favorite_sort 升序）、404（code 未注册，POST/DELETE）、400（reorder 含未收藏 code）、空重排 200。
- 既有测试（api_rest / api_admin）不依赖 `/api/symbols` 顺序（用 `.find(|x| x["code"]==...)`），未受影响。

## Verification
- `cargo build --workspace`：通过。
- `cargo test --workspace`：**67 个测试组，0 失败**（全绿，含既有 + 新增 favorite 测试）。
- `cargo clippy --workspace --all-targets`：0 告警、0 错误。
- `entangled tangle`：`Nothing to be done`（幂等）。
- psql 迁移校验：0013 在 :5433 建表；FK 级联实测通过。
- 收藏相关单测重复 3 轮（存储 5 项 + web 2 项）均稳定。

## Residual risks
1. **`/api/symbols` 收藏优先排序在收藏数极大时无分页**：现有端点本就全量返回，收藏排序无额外风险。
2. **`symbol_exists` 用 `symbols_admin.update` 作 no-op 探测**：对收藏高频切换场景，每 POST/DELETE 会多一次无字段 UPDATE（rows_affected 判定）。无字段均为 COALESCE 保留原值，无副作用；0 引入新端口。极端并发锁竞争可能让该 UPDATE 短暂等待，可接受。
3. **`api_settings.rs` 为孤儿 tangle 目标**（08-settings.md 无其代码块，tangle 不再管理），本次直接编辑；若后续恢复该块需同步 `favorites` 字段。
4. **`reorder` 采用「先 web 层 `favorite_map` 预检 + 事务内更新」**，严格非原子（预检与提交间存在极小 TOCTOU 窗口，另一请求取消某 code 会导致该 code 重排无效但 DB 不报错）。对单用户看板操作无实际影响。
5. **迁移已手动应用到 :5433**：非全新容器（已存在 0013 表）下次 compose 启动不会重跑（docker-entrypoint-initdb.d 仅首建执行）。迁移文件按序追加在 `migrations/`，全新部署按序应用 0013 一次。
6. **`favorite`/`favorite_sort` 恒输出**：前端若按旧 schema 严格校验 `SymbolDto` 可能需同时发前端适配（后端契约已定稿）。

## 暂存文件清单（changed files，未 commit、未 git add——遵循 Acceptance `noStagedFiles: true`）
**避免提交（working-tree 状态，供父级 review）**。

修改（19）：
- `crates/app/src/bin/eestock-app.rs`（DI 注入 favorites）
- `crates/domain/src/ports.rs`（FavoriteItem + FavoriteStore）
- `crates/storage/src/lib.rs`（pub mod favorite）
- `crates/web/src/dto.rs`（SymbolDto favorite 字段 + ReorderFavoritesReq + 单测）
- `crates/web/src/lib.rs`（收藏三条路由 + put import）
- `crates/web/src/rest.rs`（get_symbols 排序 + read_symbol 标注 + 3 handlers + symbol_exists）
- `crates/web/src/state.rs`（AppState.favorites）
- `crates/web/tests/api_admin.rs` / `api_alerts.rs` / `api_backtest.rs` / `api_quality.rs` / `api_rest.rs` / `api_settings.rs` / `ws_poller.rs`（AppState 装配补 favorites）
- `design/02-domain/contracts.md`（FavoriteStore 端口）
- `design/04-storage/02-tushare-sync.md`（storage lib.rs 注册 favorite）
- `design/04-storage/schema.md`（0013 迁移块 + favorite.rs 契约描述）
- `design/07-app-plane/00-web-api.md`（REST 契约 + lib/dto/state/rest/eestock-app/tests 块）
- `design/07-app-plane/02-alerts.md`（api_alerts 装配 favorites）

新增（4）：
- `crates/storage/src/favorite.rs`（PgFavoriteStore，手写）
- `crates/storage/tests/favorite_store.rs`（手写集成测试）
- `crates/web/tests/api_favorites.rs`（手写集成测试）
- `migrations/0013_favorite_symbols.sql`（tangle 生成）
