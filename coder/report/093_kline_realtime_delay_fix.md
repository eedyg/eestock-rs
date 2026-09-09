# 093 — 5m/15m/1h 数据更新严重延时修复（物化滞后 + forming 桶右缘）

> 本报告文件位置：`eestock-rs/coder/report/093_kline_realtime_delay_fix.md`

## 根因（按成因分层）

1. **accurate cagg 物化滞后（数据层，主线）**
   - `kline_accurate` M1 max = `2026-09-07 07:00:00+00`（tushare 日同步，正常）。
   - 但 `kline_accurate_5m/15m` cagg max 停在 `2026-09-04 07:00:00+00`（落后 3 交易日）；`kline_accurate_1h` 因 start_offset=2d 恰好覆盖、停在 09-07。
   - 成因：0017 把 cagg 重建为全量后，刷新策略只覆盖近期窗口（5m `start_offset=2h` / 15m `=6h`）；tushare 大批量 M1 回填带入的**旧桶**落在刷新窗口之外 → 增量刷新不触碰 → 物化 watermark 停在回填边界。设计 4.3.4 已注明「历史回填后须手动全量刷新一次」（运维要求，此前未执行）。

2. **forming（进行中）桶未入 latest 查询（读源，右缘延时）**
   - `reader.rs` 的 `merged_sql` 承载 accurate(优)+兜底(反连接)，二者(cagg)只物化**已闭合**桶。
   - latest 查询（`before=None`）右缘随 cagg 物化时机落后至上一闭合桶（5m 最多约 5min，与诊断 02:25 vs raw 02:34 吻合）。

## 修复（只改 DB 迁移/refresh + reader 读源，未改 sim/backtest 业务逻辑）

1. **数据层**：新增迁移 `migrations/0020_accurate_cagg_refresh.sql`，`CALL refresh_continuous_aggregate(<cagg>, NULL, NULL)` 全量刷新 accurate 5m/15m/1h/1d -> 与 M1 max 对齐；已对活库执行（exit 0）。幂等；空库为 no-op。对应 design/04-storage/schema.md §4.3.12 + 注记 8。
2. **读源**：`reader.rs` 增加 `forming_sql()`（仅 M5/M15/H1）+ `KlineReader::forming_bar()`，在 `bars()` latest 查询（`before=None && limit>0`）合入当前未闭合桶（从最新 `kline_raw` 聚合）。合并语义：`f.ts > 末根` 则剔除最旧保 limit + 追加；`f.ts == 末根` 则覆盖 cagg/rollup 的陈旧/部分桶（如 1h rollup 未闭合窗）。分页（`before=Some`）不回填 forming 桶。

## 架构对齐

- `migrations/0020`：数据层（04-storage/schema.md）。
- `reader.rs`：应用面只读端口 `KlineRead::bars` 实现（ADR-017 只读库；07-app-plane/00-web-api.md）。未改 domain 端口/事件契约/写路径/回测。consumer（web/diagnose/mcp）经 `KlineRead` 端口依赖，接口未变。
- 全部改动经 ADR-007 文学式流程：改 design/ 文档 → `entangled tangle` 生成 → 幂等（重新 tangle 后 `Nothing to be done`）。

## 问题解决描述

修「5m/15m/1h 数据更新严重延时」：
- 物化滞后：accurate cagg 从 09-04 追平到 09-07（与 M1 真值一致），历史 high-period 读源恢复 accurate 优先语义。
- 右缘延时：5m/15m/1h latest 读源含当前 forming 桶，右缘随 live 前进（不再停在上一闭合桶）。

## 实现要点

- `forming_sql(period)` 仅对 M5/M15/H1 返回 `time_bucket(interval, now())` 聚合 `kline_raw`（当前桶 ≤1 行，`source=NULL` 与兜底同型）；其余周期返回 None（保留既有读源）。
- `bars()` 在 `before.is_none() && limit>0` 时合并 forming；`latest_bar()`（默认=`bars(None,1)`）随之返回 forming，供 WS 增量判定。
- 兜底一致性（Part 3）：既有 `NOT EXISTS(accurate)` 反连接不变；accurate 现已覆盖 09-07，今日数据由兜底(kline_5m/15m/1h rollup) + forming 承接，无缺口。

## 测试覆盖

- 新增 `high_period_forming_bucket_included_on_latest`（`crates/storage/tests/kline_reader.rs`）：验证 M5 latest 含当前 forming 桶（从最新 raw 聚合、OHLCV/source 断言）；且 `before=Some(fb)` 分页不含 forming 桶。**通过**。
- 既有 kline_reader 全部 12 项通过（合并/分页/深历史/周月/W-M 等）。

## 验证

- `cargo build --workspace`：通过。
- `cargo test --workspace`：除**既有** `storage::alert_store::list_events_filters` 外全部通过。
  - `list_events_filters` 为共享生产库测试隔离缺陷（测试固定 [09-07 02:04,02:06) 窗口，库内真实告警事件 `516380 当日缺口率` 落入窗口 → 计数 2≠1）。与本次 kline 改动无关（未触碰 alert 表/逻辑），属既有 flaky/test-debt。
- psql 校验：
  - accurate cagg max = `2026-09-07 07:00:00+00`（5m/15m/1h 与 M1 一致）。
  - forming_sql 对实盘 `159337` 返回当前 5m 未闭合桶（`ts=2026-09-08 02:50:00+00`，latest raw 聚合）。
  - `/api/kline?period=5m&code=159337` 最新 ts=`2026-09-08T02:45:00Z`（当前 forming 桶；now≈02:50:42Z）。
- 迁移 `0020` 对活库执行：exit 0（CALL ×4）。

## 残留风险

1. **accute cagg start_offset 滞后复发**：5m/15m 刷新窗口(start_offset=2h/6h)仍小于单次 tushare 回填批次跨度；若后续回填又带入窗口外旧桶，需再次运行 0020（或等价 CALL）。未一并改 start_offset（策略参数调整，避免扩大 DDL 影响面；见 design 注记 8）。根治选项=加大 start_offset(建议 ≥2d)。
2. **forming 桶依赖当前桶内有 raw 数据**：若当前桶尚无数据（如采集瞬时滞后/收盘），forming_sql 返回空，右缘自然回退到最近可用桶（正确行为，非异常）。
3. **`alert_store::list_events_filters` 既有失败**：共享生产库事件落入测试固定窗口，隔离性 test-debt（非本次引入）。
4. **无 commit / 无 staged**：仅工作区改动。

## 暂存（staged）文件清单

- 无（`git diff --cached --stat` 为空；未 commit）。工作区改动如下：
  - `crates/storage/src/reader.rs`（读源 forming 分支）
  - `crates/storage/tests/kline_reader.rs`（新增 forming 测试）
  - `migrations/0020_accurate_cagg_refresh.sql`（新增）
  - `design/04-storage/schema.md`（4.3.12 + 注记 8）
  - `design/07-app-plane/00-web-api.md`（reader/test 文档同步）
