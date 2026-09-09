# 069 分钟线全历史重建（0017）——去除「数据只到 2024」人为截断

> 本报告文件位置：`eestock-rs/coder/report/069_minute_caggs_full_history.md`

## 问题（修复的需求）

0010（Wave 3）建的 `kline_accurate_5m/15m/1h` 连续聚合带 `WHERE ts >= '2024-01-01'` 过滤
（0010 定稿时「2024 即可」口径，不聚合 2012 前亿万级 M1）。实盘库核对（迁移前）：

- `kline_accurate_5m/15m/1h` min ts = **2024-01-01**（只到 2024）。
- `kline_accurate` M1 / `kline_accurate_1d` / `_1w` / `_1mo` min ts = **2012**（全量）。

→ 5m/15m/1h 深翻在 2024 边界截断，与「数据只到 2024」的人为截断同源（1m/日/周/月已全量）。

## 改动

1. **迁移 0017**（design 源 → tangle）`migrations/0017_minute_caggs_full_history.sql`：
   `DROP MATERIALIZED VIEW kline_accurate_5m/15m/1h` → 重建为**全量**（移除 `WHERE ts >= '2024-01-01'`，
   聚合 `kline_accurate` 全部 M1）+ 同样 refresh 策略（窗口≥2桶：5m=2h/1m、15m=6h/1m、1h=2d/1h）。
   与 0016 周/月**同型**（DROP→重建→add_continuous_aggregate_policy）。
2. **设计口径**：`design/04-storage/schema.md`：
   - 4.3.4（0010）叙述 + 0010 SQL 块头注释：删除「尊重 2024 即可/不聚合 2012 前亿万级 M1」，
     改为「**各周期聚合/读取 DB 全部 accurate M1（2012→今），无人工时间截断；数据摄取量=可获取量**」；
     0010 块 SQL 移除 `AND ts >= '2024-01-01'`（3 处）。
   - 新增 4.3.9（0017）节 + tangle 块；写明上下文/修复/性能注记，并明确**统一原则**（供后续遵循）。
   - 修正 4.3.7（0014）与 0014 SQL 块头「与 0010 的 2024 口径不同」→「0010 的 5m/15m/1h 由 0017 同步全量」。
3. **reader 设计注释**：`design/07-app-plane/00-web-api.md`（reader 源，tangle→`crates/storage/src/reader.rs`）：
   - 叙述「覆盖 2024-01-01→今；W1/MO1 例外」→「覆盖全历史 2012+；5m/15m/1h(0017)/1w/1mo(0016) 均全量」。
   - `merged_sql` doc 注释同步。**仅注释，无逻辑改动**。
4. **reader 逻辑 / 前端 / DB 非迁移：不改**。reader `period_merged_sql` 本就读 `kline_accurate_5m/15m/1h`
   （现全量），1m/1d/1w/1mo 已全量不动；前端分页批量（5m=300/15m=220/1h=120）已就绪，深翻可达。

## 架构对齐（ADR-007 / ADR-003）

- design → src 单向 tangle：改的是 `design/04-storage/schema.md`、`design/07-app-plane/00-web-api.md` 事实源，
  `migrations/*.sql` 与 `crates/storage/src/reader.rs` 为 tangle 生成物（禁止手改）。
- ADR-003「accurate 优先 + 底层兜底」语义不变：accurate 分支现覆盖全历史（2012+），兜底（`kline_5m/15m` +
  `kline_15m` rollup）保留为 accurate 缺时安全网。
- 迁移是**纯 DDL（cagg DROP/CREATE + policy）**，不改表定义/数据，不涉应用面/引擎读写，不违 ADR-017。

## 实现要点（已定架构内）

- 0016 已建立「全历史 cagg」同型迁移模板，0017 严格复刻（DROP 既有 → 重建去 2024 过滤 → 同 refresh 窗口）。
- 窗口≥2桶校验：5m(2h≈24桶)/15m(6h≈24桶)/1h(2d≈48桶) 均满足 TimescaleDB「policy refresh window too small」
  约束（与 0010 原策略一致）。
- TimescaleDB 2.29 在 `CREATE ... WITH (timescaledb.continuous)` 时默认做一次全量初始物化（NOTICE
  "refreshing continuous aggregate"），故**迁移内已完成全历史物化**（见验证行数）。

## 验证

### entangled tangle 幂等
- 首次：`write migrations/0010/0014`、`create migrations/0017`、`write crates/storage/src/reader.rs`。
- 再次：`Nothing to be done.`（幂等 ✓）。

### cargo 编译 / 测试
- `cargo test --workspace`：**编译通过**。`cargo test -p storage --test kline_reader` → **11/11 通过**
  （含 `unified_read_deep_history_to_2024`、`weekly_monthly_deep_scroll_before_2024`）。
- 无关既有失败：`storage::alert_store::list_events_filters`（`alert_store.rs` 未被本改动触碰；隔离重跑亦失败，
  from/to 窗口计数口径，与本改动无涉——判定为**预存在/无关**）。

### psql 应用 0017（实盘库 :5433）
- 应用时长：`real 1m35.714s`（含 3 个 CREATE 的全量初始物化），无超时。
- 物化行数 / min ts（迁移后）：

| cagg | min ts | max ts | rows |
|------|--------|--------|------|
| kline_accurate_5m  | 2012-01-04 01:30:00+00 | 2026-09-04 07:00:00+00 | 3,373,450 |
| kline_accurate_15m | 2012-01-04 01:30:00+00 | 2026-09-04 07:00:00+00 | 1,214,442 |
| kline_accurate_1h  | 2012-01-04 01:00:00+00 | 2026-09-04 07:00:00+00 |   404,814 |
| kline_accurate M1（对照） | 2012-01-04 01:30:00+00 | 2026-09-04 07:00:00+00 | 16,260,029 |

→ 5m/15m/1h min ts = **2012-01-04 < 2024**，与 accurate M1 起点一致 ✓。

### API（应用面 :8081）before=2020 深翻
- `GET /api/kline?code=518880&period=5m&before=2020-01-01T00:00:00Z&limit=5` → 5 根 **2019-12-31** 5m bar（source=tushare）✓
- `...period=15m...` → 2019-12-31 15m bar ✓
- `...period=1h...` → 2019-12-31 1h bar ✓
- `...period=1m/1d/1w/1mo...` → 2019-12-31 pre-2020 bar（仍全量，**未变**）✓

## 性能 / 物化说明（任务要求如实报告）

- 全量物化（3 cagg 一次性）在**约 1 分 36 秒**完成，未超时，无性能阻塞。
- 全量后 5m=3.37M / 15m=1.21M / 1h=0.40M 行；TimescaleDB cagg 为**增量刷新**（policy 只刷近期窗口），
  查询读物化桶，**查询同快**（与行数无关）。历史回填全量 refresh 只需一次。
- 若后续其它标的补全历史（M1 行数继续增大）时出现全量聚合超时，可行方案：**按 code 子集分批** refresh
  （每批若干 code 的窗口），或确认可接受时长。

## 残留风险 / 注记

1. **存储开销增长**：5m/15m/1h cagg 物化行数增大（5m 1.4M→3.37M 等），cagg 底层 hypertable 磁盘占用上升；
   已随 `kline_accurate` 压缩体系（0010 之前 caggs 是否配置压缩需复核持续聚合压缩策略），非本任务范围。
2. **全新库重放 0010+0017**：0010（现已全量并默认初始物化）+0017（DROP→重建全量）会对 5m/15m/1h 做两次全量聚合，
   幂等正确但稍冗余——此与既有 0014+0016 的重放模式一致。
3. **reader 兜底语义未变**：兜底 `kline_5m/15m`（raw-derived，仍近 2 周）与 1h `kline_15m` rollup 保留；
   仅当 accurate cagg 缺数时兜底，全历史 cagg 后 pre-2024 也走 accurate（source='tushare'）。
4. `alert_store::list_events_filters` 为**预存在失败**（与本任务无关，未触碰对应代码）。

## 变更文件清单（未暂存）

**修改（tracked）**：
- `crates/storage/src/reader.rs`（仅 doc 注释，逻辑未改）
- `design/04-storage/schema.md`（0010/0014/0017 口径，+4.3.9）
- `design/07-app-plane/00-web-api.md`（reader 设计注释）
- `migrations/0010_accurate_caggs.sql`（tangle 重生成，去 2024 过滤）
- `migrations/0014_weekly_monthly_caggs.sql`（tangle 重生成，注释）
- **新增（untracked）**：`migrations/0017_minute_caggs_full_history.sql`
- **新增（本报告）**：`coder/report/069_minute_caggs_full_history.md`

`git status`（eestock-rs）无任何已暂存（`git diff --cached` 为空）；未 commit。
