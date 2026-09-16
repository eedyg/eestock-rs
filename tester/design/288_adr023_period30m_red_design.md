# 288 — ADR-023 D1（30m 数据 + 主图周期）红测试**设计报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/design/288_adr023_period30m_red_design.md`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`（§5 判据契约，已冻结）
- 证据：`/tmp/adr023-red-20260916-224257/EVIDENCE.md`（逐条命令原文 + 原始输出）
- 执行报告：`tester/test/288_adr023_period30m_red_execution.md`
- 性质：TDD 红阶段 —— **只新增手写测试文件，零实现改动**（`git diff --stat` 为空）
- 范围：D1 = 30m 数据 + 主图周期；多周期接入（`MULTI_PERIOD_ALLOWED` / `MULTI_PERIOD_PICKER_PERIODS` / `MEASURED_DENSITY_TABLE`）属 D2，**本轮不得实现**（J9 反向断言护栏）

## 1. 测试策略

| 层次 | 手段 | 是否连库 | 覆盖判据 |
|---|---|---|---|
| domain 类型层 | 编译期断言（引用 `Period::M30`） | 否 | J1 |
| storage 映射层 | 直接调用 `pub fn period_str` | 否 | J3 |
| storage 常量台账 | 读 `pub const EXPECTED_RELATIONS` | 否 | J6 |
| storage 读源 | `include_str!` 结构化源码断言（私有函数不可外部调用，见 §3） | 否 | J4 |
| 迁移文本 | 读 `migrations/*.sql` 文本（编号 + 内容） | 否 | J7 |
| web 纯函数 | `web::dto::parse_period` 直接调用 | 否 | J2 |
| web HTTP 契约 | 真实 axum server + `reqwest`，`connect_lazy` 指向**不可达端口** | **否** | J5 |
| web 白名单护栏 | 读 `pub const MULTI_PERIOD_ALLOWED` | 否 | J9 |
| 前端组件/集成 | @testing-library + `stubApi`/`stubWs` 夹具 + klinecharts 打桩 | 否 | J8、J9 |
| 前端静态类型 | 对 `DashboardGrid.tsx` 文本断言 `type Period` | 否 | J8 |

**mock/stub 策略**：后端用 `PgPoolOptions::connect_lazy("…@127.0.0.1:59999/…")`（不可达端口，绝不连活库 5433 / 不碰 8081-8082）；
前端沿用既有夹具（`@/test/apiStub.stubApi`、`vi.mock('klinecharts')`、`@/test/chartStoreStub`）。
**覆盖目标**：ADR-023 §5.1（后端）+ §5.3（前端）**全部可无库判据**；§5.2（DB 逐桶/新鲜度/策略生效）本轮**明确不覆盖**（需活库，禁令）。

## 2. 新增测试文件与用例清单

| 文件（绝对路径前缀 = `/home/eestock/workspace/git/eestock/eestock-rs/`） | 用例 | 判据 |
|---|---|---|
| `crates/domain/tests/period30m_contract.rs` | `j1_period_enum_contains_m30_variant` | J1 |
| `crates/web/tests/period30m_api_contract.rs` | `j2_parse_period_30m_maps_to_m30`、`j2_all_eight_tiers_parse`、`j5a_api_kline_period_30m_must_not_be_400`、`j5b_unknown_period_400_message_lists_all_eight_tiers` | J2、J5 |
| `crates/web/tests/period30m_scope_guard.rs` | `j9_backend_multi_period_allowed_must_not_contain_30m_in_d1`、`j9_backend_multi_period_allowed_unchanged_six_tiers`、`j9_backend_multi_period_allowed_still_excludes_1mo` | J9 |
| `crates/storage/tests/period30m_period_str.rs` | `j3_period_str_m30_is_uppercase_m30`、`j3_existing_period_str_mappings_unchanged` | J3 |
| `crates/storage/tests/period30m_read_source.rs` | `j4a_merged_sql_m30_uses_accurate_30m_relation`、`j4b_fallback_is_30m_rollup_over_kline_15m`、`j4c_forming_sql_m30_is_30_minutes`、`j4d_existing_forming_and_non_intraday_none_unchanged`、`j4e_no_raw_layer_kline_30m_reference` | J4 |
| `crates/storage/tests/period30m_expected_relations.rs` | `j6_expected_relations_contains_kline_accurate_30m`、`j6_existing_relations_not_removed` | J6 |
| `crates/storage/tests/period30m_migration.rs` | `j7a_…exists_with_expected_name`、`j7b_…full_history_30m_over_accurate_m1`、`j7c_no_historical_truncation_filter`、`j7d_start_offset_is_3_days`、`j7e_full_refresh_call_present` | J7 |
| `web/src/features/dashboard/period30m.test.tsx` | J8-a ×2、J8-b ×2、J8-c ×1、J9 ×3 | J8、J9 |

命名风格：`j<N><sub>_should_when` 语义（判据号前缀，便于失败输出直接定位 ADR 条目）。

## 3. 边界与例外

- **不可达私有函数（J4）**：`period_merged_sql` / `forming_sql` 为 `fn`（私有）且 crate 内无 pub 访问器 ⇒ 采用
  `include_str!("../src/reader.rs")` 的结构化源码断言（M30 臂引用 `kline_accurate_30m`；兜底窗口含
  `kline_15m`+`30 minutes`+`time_bucket`；forming M30 臂含 `30 minutes`）。已做命名容错（`const FALLBACK_30M` 缺失时退化到 M30 臂窗口）。
- **不得越界**：J4e 断言 `reader.rs` **不得**出现 raw 层 `kline_30m`（ADR-023 §2.2）；J7d 断言 30m 策略**不得**照抄 `2 hours`；J9 断言前后端多周期白名单本轮不含 30m。
- **既有契约不许弱化**：J3 第二例（7 档 `period_str` 原样）、J4d（既有 forming M5/M15/H1 + `_ => return None`）、J6 第二例（既有关系名不删）、J8-a（既有 7 档不丢）。
- **未知周期错误信息**：J5b 断言 400 文案须同时含 `1m/5m/15m/30m/1h/1d/1w/1mo` 八个字面名，并打印实际 body 便于定位缺项。
- **时间盒**：25 分钟；先落绿基线再落红（顺序见执行报告）。
