# Coder Report 060 — 行情看板周/月线 + MA 可配置后端 W1

**Report file:** `coder/report/060_weekly_monthly_ma_config_backend.md`（本文件）

**Branch:** `master`（eestock-rs 工作区）
**状态：** 实现完成，`cargo test --workspace` 全绿（308 tests）、`cargo clippy --workspace --all-targets` 0 告警、`entangled tangle` 幂等（Nothing to be done）、迁移 0014/0015 已应用 :5433 校验。**未 commit、未 git add**（遵循 Acceptance `noStagedFiles: true`）。

---

## 设计契约（Grill 定稿，父级批准范围）

行情看板加周线/月线周期 + MA 可配置（主图+宫格应用，回测弹窗不动）。周=A股交易周（Asia/Shanghai 周一为界）；月=自然月（Asia/Shanghai 月界）。MA 1-3 条可配窗口（默认 [5,10,20]）、DB 持久化。**仅看板加周/月、回测周期不扩**。严格 ADR-007：tangle 生成文件先改 design 源再 `entangled tangle`；手写文件注明。

## What changed

### 1. 周期扩展（`domain::Period` 增 `W1`/`MO1`）
- **tangle**：`design/02-domain/contracts.md` 的 types.rs 块 → `crates/domain/src/types.rs`：`pub enum Period { M1, M5, M15, H1, D1, W1, MO1 }`。
- **tangle**：`00-web-api.md` dto.rs 块 → `crates/web/src/dto.rs` `parse_period`：增 `"1w" => Some(Period::W1)`、`"1mo" => Some(Period::MO1)`（1m 已=分钟，避免歧义）。
- **`period_merged_sql` W1/MO1 分支**：`crates/storage/src/reader.rs`（tangle）增 `FALLBACK_1W`/`FALLBACK_1MO` 常量（`kline_1d` 查询期 rollup，与 `FALLBACK_1H` 同型）与 `Period::W1 => merged_sql("kline_accurate_1w", FALLBACK_1W)`、`Period::MO1 => merged_sql("kline_accurate_1mo", FALLBACK_1MO)`。
- **`backtest.rs` 补全（非 tangle 手写）**：`period_range_sql` match 增 W1/MO1 分支（映射同 cagg 表 + rollup 兜底）以保 match 全穷尽；application::parse_period 仍拒绝 1w/1mo，故回测周期不扩（API 层未开放，见残余风险 3）。

### 2. 周/月聚合（迁移 0014，tangle→SQL）
`design/04-storage/schema.md` 新增 `§4.3.7`，tangle 生成 `migrations/0014_weekly_monthly_caggs.sql`：
- `kline_accurate_1w`（`time_bucket('1 week', ts, 'Asia/Shanghai')` 周一为界）与 `kline_accurate_1mo`（`time_bucket('1 month', ts, 'Asia/Shanghai')` 自然月）cagg，从 `kline_accurate` M1 聚合（first/open、max/high、min/low、last/close、sum/volume、sum/amount），`WHERE ts >= '2024-01-01'`（与 0010 同口径）。
- 刷新策略：周用 `start_offset 30 days`/`end_offset 1 day`、月用 `120 days`/`1 day`。⚠️ **首版用 14d/1d 报 `policy refresh window too small`**（TimescaleDB 要求 refresh 窗口 ≥2 桶；周桶=7d、月桶≈30d），已改大窗口修复并 tangle 重新生成。
- **兜底判断（用我判断，注明）**：schema 无 raw-derived `kline_1w/1mo` cagg → 采用 reader.rs 查询期 rollup（`kline_1d` → week/month 桶），与 1h 兜底从 `kline_15m` rollup 同型（「复用 cagg 兜底语义」），未新增/物化额外 cagg。

### 3. MA 配置后端（迁移 0015 + 端口 + 端点 + DI）
- **迁移 0015**（tangle→SQL）：`ma_config` 单行表（id 恒 1，CHECK；`ma_windows integer[] DEFAULT ARRAY[5,10,20]`；种子 `INSERT ... ON CONFLICT DO NOTHING`）。
- **domain 端口**（tangle，contracts.md ports.rs 块）：`MaConfigStore` trait `get()/set(windows)`（`anyhow::Result<Vec<i32>>`）。
- **storage 实现**（**非 tangle 手写** `crates/storage/src/ma_config.rs`）：`PgMaConfigStore`（PgPool）。`get`：`SELECT ma_windows FROM ma_config WHERE id=1`；表空→默认 [5,10,20]。`set`：`INSERT ... ON CONFLICT (id) DO UPDATE ... updated_at=now()`，`Vec<i32>` 绑定 `int4[]` 列。
- **web**（tangle）：`state.rs` AppState 增 `ma_config: Arc<dyn MaConfigStore>`；`lib.rs` 路由 `.route("/api/config/ma", get(rest::get_ma_config).put(rest::put_ma_config))`；`rest.rs` 增 `get_ma_config`/`put_ma_config` handler；`dto.rs` 增 `MaConfigDto{windows}` 与 `validate_ma_windows`（纯函数）。
- **校验语义**（文档化）：1-3 条、每条 1-500 整数、归一化升序去重后落库；非法 → 400。`PUT` 返回归一化结果；`GET` 表空→默认 [5,10,20]。
- **app DI**（tangle）：`eestock-app.rs` 装配 `ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone()))` 注入 AppState。
- **§1.1 REST 契约表** 增 `GET/PUT /api/config/ma` 两行；`GET /api/kline` 行增 `1w/1mo` period 说明。

### 4. 测试装配同步（AppState 增字段后全部构造点补齐）
- **tangle 维护**：`api_rest.rs`/`ws_poller.rs`/`api_admin.rs`/`api_quality.rs`（00-web-api.md）、`api_alerts.rs`（02-alerts.md）→ 补 `ma_config` 字段。
- **直接手写**（非 tangle）：`api_favorites.rs`、`api_backtest.rs`、`api_settings.rs`（孤儿/手写）→ 补 `ma_config` 字段。

## Architecture alignment
- 分层：端口在 `domain`，实现 `PgMaConfigStore` 在 `storage`，web 只见 `domain::ports::MaConfigStore`，app bin 装配。未改任何现有接口/层边界/依赖方向。
- `BarDto` 不变（周期枚举变化只影响 `Period` 语义，不涉及 bar 线格式）。
- ADR-017：`ma_config` 为应用面自有表（数据面不读写）；周/月 cagg 为准确层聚合（数据面只读产物，写入仍由 tushare→kline_accurate M1 单写者驱动）。
- ADR-007：所有 tangle 生成文件（types.rs/ports.rs/reader.rs/dto.rs/lib.rs/state.rs/rest.rs/eestock-app.rs/迁移/各 tangle 测试块）均「先改 design 源再 tangle」；手写文件 `ma_config.rs`、`storage/tests/ma_config_store.rs`、`web/tests/api_ma_config.rs`、`web/tests/api_kline_period.rs`、`backtest.rs`（W1/MO1 补全）、`api_favorites.rs`/`api_backtest.rs`/`api_settings.rs`（字段补齐）注明。
- 允许的偏差：周/月兜底用查询期 rollup（kline_1d）而非 raw-derived cagg，属设计源已注明的判断（见 §4.3.7）。

## Problem solved / feature added
后端 W1：`Period` 增 W1/MO1、`parse_period` 1w/1mo、reader W1/MO1 统一读源、迁移 0014（周/月 cagg）、迁移 0015（ma_config）、`MaConfigStore` 端口/实现、`GET/PUT /api/config/ma`、app DI。

## Implementation approach (within approved architecture)
- 周/月 cagg 从 `kline_accurate` M1 聚合（2024+），accurate 优先 + `kline_1d` 查询期 rollup 兜底（与 1h 同型）。
- MA 配置：web 层 `validate_ma_windows` 校验+归一化（升序去重）→ storage 只存归一化；`ma_config` 单行（id 恒 1）。
- `/api/kline?period=1w|1mo` 走既有 `get_kline` handler（parse_period → bars → BarDto），无新 handler。

## Test coverage
- `crates/web/src/dto.rs`（unit，无 DB）：`parse_period_front_contract` 增 `1w`/`1mo`/`1m 仍=分钟`；`ma_windows_validation_and_normalize`（升序/去重/1-500/条目数边界）；`ma_config_dto_roundtrip`。
- `crates/storage/tests/kline_reader.rs`（tangle，集成）：`weekly_monthly_periods_aggregate`（跨两周两月种子 → 周/月聚合 OHLCV、升序、准确层优先）。⚠️ 曾用 997731 与既有 CODE_QUAL 冲突（cagg 全局桶被污染 → close 实测 10），改用 997733 修复。
- `crates/storage/tests/ma_config_store.rs`（**手写**，集成）：get 默认（表空→[5,10,20]）、set 写回+get 一致、覆盖写、单行约束。
- `crates/web/tests/api_ma_config.rs`（**手写**，集成，真实 server）：GET 默认、PUT 校验+归一化、持久化读回、400（0/4 条、0/501/-1）、400 不落库。
- `crates/web/tests/api_kline_period.rs`（**手写**，集成，真实 server）：`/api/kline?period=1w|1mo` 返回周/月 bar（HTTP 全链路 parse_period→bars→BarDto）。
- 既有测试不依赖 /api/config/ma、/api/symbols 顺序（用 .find），未受影响。

## Verification
- `cargo build --workspace`：通过。
- `cargo test --workspace`：**308 tests，0 失败**（70 个结果行全 ok；含既有 + 新增）。
- `cargo clippy --workspace --all-targets`：**0 告警、0 错误**（修了 2 个 dto.rs 告警：doc_lazy_continuation、len_zero；1 个 ports.rs empty_line_after_outer_attr 孤儿注释）。
- `entangled tangle`：`Nothing to be done`（幂等）。
- psql 迁移校验：0015 建表+默认行 `{5,10,20}`；0014 cagg 物化成功（周 5940 行、月 1423 行）+ 刷新策略（后修复大窗口）均已应用 :5433。
- 新测试重复运行稳定（kline_reader 10 组全绿、api_kline_period、api_ma_config 通过）。

## Residual risks
1. **`ma_config` 为全局单行**：storage 与 web 测试共享同一行，先清后收（清→断言→清）。跨 binary 并行（`cargo test --workspace`）时若两 binary 同时触达 `ma_config` 可能互踩，导致偶发断言错乱；当前 `cargo test` 顺序执行 binary 未触发，但非绝对隔离。建议后续引入测试专用 schema 或串行化（`--test-threads=1`）。
2. **周/月 cagg 兜底为查询期 rollup（kline_1d）**：若 kline_1d 无数据（raw 未回填或溢出）则兜底为空，仅 accurate（2024+）供数。深历史 2024 前为空白（与 5m/15m/1h/1d 同口径，尊重「2024 即可」）。旧数据（2012-2023）周/月不可见。
3. **`backtest.rs` W1/MO1 分支**：为保 match 全穷尽而映射同名 cagg；application `parse_period` 仍拒绝 W1/MO1，且 `backtest_runs.period` 注释仍为 M1/M5/M15/D1，故「回测周期不扩」在 API 面成立。若未来有人直接调 `BacktestBarRead::bars(W1)` 会读到周线（当前无调用入口）。
4. **迁移 0014 刷新窗口首版 bug**（14d/1d 报 policy refresh window too small）已在设计源修复并 tangle；但已在 :5433 手动补加的政策用新窗口。若在全新容器按序应用 0014 将天然使用修复后窗口。
5. **cagg 触发初始全量物化**（0014 CREATE 时自动 refresh 2024+ 全量周/月），在 16M 行 kline_accurate 上实测约 11s；对超大库部署时注意初始物化耗时。
6. **`get_ma_config`/`put_ma_config` handler 未做 body 缺失/空 body 专门处理**：axum `Json<MaConfigDto>` 反序列化失败自动 400，语义等价但错误信息非自定义。可接受。

## 暂存文件清单（changed files，未 commit、未 git add——遵循 Acceptance `noStagedFiles: true`）
**修改（25 tracked）**：`crates/app/src/bin/eestock-app.rs`、`crates/domain/src/{ports,types}.rs`、`crates/storage/src/{accurate,backtest,lib,reader}.rs`、`crates/storage/tests/kline_reader.rs`、`crates/web/src/{dto,lib,rest,state}.rs`、`crates/web/tests/{api_admin,api_alerts,api_backtest,api_favorites,api_quality,api_rest,api_settings,ws_poller}.rs`、`design/02-domain/contracts.md`、`design/04-storage/{02-tushare-sync,schema}.md`、`design/07-app-plane/{00-web-api,02-alerts}.md`。

**新增**：`crates/storage/src/ma_config.rs`、`crates/storage/tests/ma_config_store.rs`、`crates/web/tests/api_ma_config.rs`、`crates/web/tests/api_kline_period.rs`、`migrations/0014_weekly_monthly_caggs.sql`、`migrations/0015_ma_config.sql`。
