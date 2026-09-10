# 125 — 技术债清算·后端车道（TD-1 clippy 清零 / TD-2 alert_store 环境性失败根治 / TD-3 旧回测表 DROP 回收）

报告位置：`eestock-rs/coder/report/125_tech_debt_backend_td1_td3.md`

## 总览

| 项 | 结果 | 验证 |
|---|---|---|
| TD-1 clippy 1.97 清零 | ✅ 当前基线 8 warning（较验收记录 11 条漂移：mcp/tools.rs 现已无 warning）→ 0 | `cargo clippy --workspace --all-targets` 0 warning / 0 error |
| TD-2 list_events_filters 环境性失败 | ✅ 方案 (a)：窗口查询叠加测试唯一 source 标记 | 复现 red（left:3 right:1）→ 修复后 green（污染行仍在库中即通过） |
| TD-3 backtest_runs/backtest_results 回收 | ✅ 迁移 0024（design → tangle），dev DB 已 apply | `\dt backtest*` 无结果；重复执行幂等（IF EXISTS NOTICE） |
| 全量验收 | ✅ | build 0 error；test --workspace --no-fail-fast 570 passed / 0 failed（86 suites）；tangle 二次运行 "Nothing to be done"（无 diff） |

---

## TD-1：clippy --workspace --all-targets 0 warning

当前精确清单（`cargo clippy --workspace --all-targets`，8 条；任务书记录的 11 条中 mcp/tools.rs×1 与 simlive 测试×1 已漂移消失，以实跑为准）：

| # | 位置 | lint | 修复 |
|---|---|---|---|
| 1-2 | `crates/application/src/simlive.rs:578-579` | `doc_lazy_continuation` | doc 列表续行缩进 2 空格（clippy 建议口径，纯注释格式，零语义） |
| 3 | `crates/storage/src/reader.rs:222` | `unnecessary_map_or` | **tangle 生成物**：改事实源 `design/07-app-plane/00-web-api.md`（注意：reader.rs 的实际生成源是 07-app-plane/00-web-api.md 而非任务书所述 04-storage，已按实际 tangle 块头修正）`map_or(true, …)` → `is_none_or(…)`，`entangled tangle` 重新生成 |
| 4 | `crates/application/tests/simlive.rs:86` | eager `.cloned().filter()` | 重排为 `.filter(…).cloned()`（只克隆命中行，语义等价） |
| 5-6 | `crates/application/tests/simlive.rs:1141,1217` | `four_forward_slashes` | `////` → `///`（本就是 doc 注释意图） |
| 7-8 | `crates/web/src/simlive.rs:34,42` | `result_large_err` | 局部 `#[allow(clippy::result_large_err)]` + 注释理由：**非误报但遵项目既有惯例**——`crates/web/src/rest.rs` 已有 3 处同模式 allow（axum handler 以 `Response` 为错误通道是本 crate 既定口径）；Box 化需机械改动 22 处 `Err(e) => return e` 调用点，收益/扰动比不成立（参照 manual_is_multiple_of 先例的注释化局部 allow） |

约束符合性：simlive.rs 的改动仅限 doc 注释缩进（lint 层面，零功能逻辑变更）；strategy-runtime/strategy-core/backtest 零触碰。

## TD-2：storage alert_store::list_events_filters 环境性失败根治（TDD）

- **Red（复现）**：向 dev 库窗口 `t0+4m..t0+6m` 注入外部行（source=`td2_external_repro`）后跑测试 → `left: 3, right: 1` 失败。且发现**环境污染此刻真实存在**：运行中的 app 真实事件 `516380 当日缺口率… @2026-09-07 02:04:07` 正落在固定窗口内（不注入也已 left:2）。
- **修复（方案 a，无副作用）**：`ranged` 窗口查询叠加 `source: Some(A.into())`（测试唯一标记段 `alertstore_list_a`）。**断言强度不削弱**：source=A 自有 m1@t0 / m2@t0+5m 两行，窗口 4m..6m 仍只命中 m2——from/to 窗口语义（last_fired_at 口径）完整保留，且同时覆盖 source+时间窗组合过滤。测试文件为 tangle 生成物 → 改 `design/07-app-plane/02-alerts.md`（附污染根因注释）再 `entangled tangle`。
- **Green**：污染行（注入行 + app 真实行）保留在库中跑测试即通过 → 删除注入行后复跑仍 4/4 ok。
- 同测试其余断言复核：`all`/`mine` 已按 source 过滤、`by_src`/`lim` 天然免疫外部行，无需改动。

## TD-3：backtest_runs/backtest_results 残留表回收（架构裁决 2026-09-10：DROP）

- **design/04-storage/schema.md**：§4.3.5 两处「保留不读写，未来 DROP 另立项」注记结案（指向 0024）；新增 **§4.3.15 旧回测表回收** 节，含迁移块。
- **migrations/0024_drop_legacy_backtest_tables.sql**（tangle 生成，非手改）：
  `DROP TABLE IF EXISTS backtest_results; DROP TABLE IF EXISTS backtest_runs;`（IF EXISTS 幂等；先子后父保持依赖序）。
- **design/04-storage/03-raw-writer.md**：`EXPECTED_RELATIONS` 移除两表（注释注明 0024 回收）→ tangle 同步 `crates/storage/src/migrate_check.rs`。
- **design/99-decisions-log.md**：追加「技术债清算（2026-09-10，后端车道 TD-1~TD-3）」条目（处置/依据/遗留）。
- **dev DB（127.0.0.1:5433）**：`psql -f migrations/0024_…sql` 已 apply（DROP TABLE×2）；`\dt backtest*` 无结果；二次执行 NOTICE skipping 幂等通过。
- **零引用核实**：全 workspace Rust 代码对两表仅注释/migrate_check 引用（无读写路径），DROP 不影响编译与测试。

## 变更文件清单（已 git add，未 commit）

- `crates/application/src/simlive.rs`（TD-1 doc 缩进）
- `crates/application/tests/simlive.rs`（TD-1 ×3）
- `crates/web/src/simlive.rs`（TD-1 allow×2）
- `crates/storage/src/reader.rs`（tangle 再生，TD-1）
- `crates/storage/src/migrate_check.rs`（tangle 再生，TD-3）
- `crates/storage/tests/alert_store.rs`（tangle 再生，TD-2）
- `design/07-app-plane/00-web-api.md` / `02-alerts.md`（TD-1/TD-2 事实源）
- `design/04-storage/schema.md` / `03-raw-writer.md`（TD-3 事实源）
- `design/99-decisions-log.md`（TD-3 登记）
- `migrations/0024_drop_legacy_backtest_tables.sql`（新增，tangle 生成）

## 架构对齐

- TD-1 全部在既有模块内机械修正，无接口/边界变动；web 层 allow 遵循 crate 内既有先例。
- TD-2 仅测试过滤口径收紧，storage 实现零改动。
- TD-3 严格走 ADR-007 design→tangle 单向流程；EXPECTED_RELATIONS 属 storage 启动自检台账同步。

## 遗留风险

1. **e2e 陈旧引用（已结案 2026-09-10 收尾包）**：`web/e2e/simlive-deep.e2e.ts:278`、`backtest-form-task.e2e.ts`、`backtest-compare-gridrank.e2e.ts` 的 `backtest_runs` SQL 清理/快照段已处理——三个 backtest-*.e2e.ts 整体针对已退役旧回测页，整文件删除；`simlive-deep.e2e.ts` 仅清理段改为 strategy_run 系表清理（`sqlDeleteStrategyRuns`，`btRunIds` 改 string[]）。decisions-log 登记同步改为已完成注记。
2. DROP 不可逆：历史回测数据随表删除（裁决已明确接受）。
3. dev 库由运行中的 app 持续写入真实告警事件——TD-2 修复后测试对外部行免疫，但同类「固定时间窗+无标记过滤」模式若新增测试需遵循本次确立的唯一标记惯例。

## 验证证据

- `cargo build --workspace` → Finished, 0 error
- `cargo test --workspace --no-fail-fast` → 86 suites，合计 **570 passed / 0 failed**
- `cargo clippy --workspace --all-targets` → 0 warning（grep 计数 0）
- `entangled tangle` 二次运行 → "Nothing to be done"（生成物与 design 一致，无 diff）
- dev DB：`\dt backtest*` → "Did not find any relation"；0024 重复 apply 幂等
