# 063 — 周/月线全历史（问题①）+ 前端分页批量 vs 视口（问题②）

> 本报告位置：`coder/report/063_weekly_monthly_full_history_pagination_batch.md`
> 实施方式：TDD（后端 Red→Green）+ ADR-007（schema.md tangle 生成迁移；feed.ts 手写）。
> 未 commit（仅 `git add` 暂存）。

## 根因确认

### 问题① 后端：周/月线只能到 2024
- `kline_accurate_1w/1mo`（0014 cagg）带 `WHERE (period='M1') AND (ts >= '2024-01-01')` 过滤，accurate cagg 只物化 2024+ 的周/月桶。
- reader 兜底 `FALLBACK_1W/1MO` 用 `kline_1d` 查询期 rollup，但 **`kline_1d` 仅 2 周数据**（实盘 `min(ts)=2026-08-20`，共 146 行），无 pre-2024 行。
- 综合：accurate cagg 无 pre-2024 桶 + 兜底 kline_1d 无 pre-2024 行 → 周/月线查询结果从 `2023-12-31 16:00 UTC`（2024-01-01 周末）起，看不到更早历史。
- 实盘证据：修复前 `kline_accurate_1w` `min(ts)=2023-12-31 16:00:00+00`、`count=5942`；`kline_1d` `min=2026-08-20`。

### 问题② 前端：日线/高周期往前加载慢
- `feed.ts` 的 `KlineDataFeed` 用 `pageSize = defaultPageSizeForPeriod(period)`（≈2 交易日：`1d=2`、`1w=2`、`1mo=2`）。
- `loadInitial` 与 `loadBefore` 都用 `pageSize` → 深翻每翻一次只取 2 根，往前翻到多年前需几十上百次小往返（且 klinecharts 每页叠加渲染）。
- 根因：**视口 pageSize 与深翻批量未分离**。

## 迁移 0016 内容（tangle 生成）

文件：`migrations/0016_weekly_monthly_full_history.sql`（由 `design/04-storage/schema.md` §4.3.8 tangle 生成）。

```sql
DROP MATERIALIZED VIEW kline_accurate_1w;
DROP MATERIALIZED VIEW kline_accurate_1mo;

CREATE MATERIALIZED VIEW kline_accurate_1w
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 week', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 week', ts, 'Asia/Shanghai');

CREATE MATERIALIZED VIEW kline_accurate_1mo
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 month', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 month', ts, 'Asia/Shanghai');

SELECT add_continuous_aggregate_policy('kline_accurate_1w',
    start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('kline_accurate_1mo',
    start_offset => INTERVAL '120 days', end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '1 hour');
```
要点：去掉 `AND ts >= '2024-01-01'`（全历史 2012+）；DROP 既有聚焦 cagg（含其刷新策略，随 DROP 级联移除）→ 重建为全历史 + 同 refresh 策略。（psql 注意：`CREATE MATERIALIZED VIEW ... WITH DATA` 不能在事务块内运行，故 0016 应用时勿用 `-1` 单事务。）

## feed 分页批量改动（前端手写）

`web/src/features/dashboard/feed.ts`：
- 新增 `PAGINATION_BATCH`（`1m:500, 5m:300, 15m:220, 1h:120, 1d:250, 1w:150, 1mo:80`）与 `paginationBatchForPeriod(period)`。
- `KlineDataFeedDeps` 增可选 `paginationBatch`；`KlineDataFeed` 构造时计算 `paginationBatch = deps.paginationBatch ?? paginationBatchForPeriod(period)`。
- `loadInitial` 仍用 `pageSize`（视口）；`loadBefore` 改用 `paginationBatch`（批量），`hasMore` 判定改用批量（`older.length < paginationBatch`）。
- 注释注明「分页批量 vs 视口」语义：视口 pageSize 只用于初始铺满 + 宫格缩略；深翻用批量避免每翻 2 根。
- `defaultPageSizeForPeriod` 未动（保持视口）。

宫格缩略（`GridCell`，`pageSize:120`）只调 `loadInitial`、无 `loadBefore`（实证审查 GridCell.tsx），不受批量改动影响。

## 变更清单（暂存）

| 文件 | 层 | 说明 |
|---|---|---|
| `design/04-storage/schema.md` | 存储设计 | 0014 块去 2024 过滤；新增 §4.3.8 / 0016 块 |
| `migrations/0014_weekly_monthly_caggs.sql` | 存储迁移 | tangle 重生成（去 2024 过滤注释+SQL） |
| `migrations/0016_weekly_monthly_full_history.sql` | 存储迁移 | 新增（DROP+重建全历史） |
| `crates/storage/src/reader.rs` | 读源 | 仅文档注释（W1/MO1 accurate 全历史说明） |
| `design/07-app-plane/00-web-api.md` | 读源设计 | reader 注释 + 新增 W1/MO1 深翻测试块 |
| `crates/storage/tests/kline_reader.rs` | 集成测试 | tangle 重生成（含新测试） |
| `web/src/features/dashboard/feed.ts` | 前端 feed | 分页批量 vs 视口分离 |
| `web/src/features/dashboard/feed.test.ts` | 前端测试 | 增 paginationBatchForPeriod 用例 |
| `web/src/features/dashboard/store.test.ts` | 前端测试 | loadBefore 断言改批量 |

## TDD 证据

- **RED（后端起手）**：新测试 `weekly_monthly_deep_scroll_before_2024` 在 0016 应用前跑 —— `FAILED: W1 深翻应覆盖 <2024-01-01 数据点，实际 []`（reader 对 pre-2024 返回空）。
- **GREEN（应用 0016 后）**：同一测试 `ok`，断言 W1/MO1 深翻到达 `ts < 2024-01-01` 且 `source=Some("tushare")`（走 accurate cagg 而非兜底）。

## 验证输出

### psql（0016 应用后 <2024 校验）
```
kline_accurate_1w: min=2012-01-01 16:00:00+00, max=2026-08-30 16:00:00+00, count=14237
kline_accurate_1mo: min=2011-12-31 16:00:00+00, max=2026-08-31 16:00:00+00, count=3395
pre-2024 周桶 = 8337；pre-2024 月桶 = 2012
```
修复前 min(1w)=2023-12-31；修复后 2012-01-01，覆盖全历史。

### cargo test --workspace
全部 test binary 通过，无 FAILD/panicked。重点：`kline_reader` 11/11（含新增 `weekly_monthly_deep_scroll_before_2024`）、`backtest`、`tushare`、`web` 等全绿；`migrate_check` 无回归。

### 前端
- `npx vitest run`：37 files / 314 tests 全绿（含 feed.test.ts 7、store.test.ts 25、klineDataLoader.test.ts 3）。
- `VITE_API_MOCK=0 npx tsc -b`：通过（无类型错误）。
- `VITE_API_MOCK=0 npx vite build`：成功（仅有超过 500KB 的既有 chunk size 警告，非错误）。

### tangle 一致性
`entangled tangle` 重跑输出 `Nothing to be done` → design 与生成物同步（ADR-007 门禁满足）。

## 残留风险

1. **0014 迁移文件内容已改（去 2024 过滤）**：0014 为历史迁移，改动文件内容是文档/新建库语义一致；已应用库由 0016 兜底重建。新建库按 0014（全历史）→0016（DROP+重建全历史）顺序，会二次全量物化（约 2×一次成本），功能正确但略费时。若后续要避免，可保留 0014 原样、仅 0016 承担重建（与当前任务指示略有出入，取舍以任务「0014 去过滤」为准）。
2. **0016 全物化耗时**：实盘应用约 70s（16.26M M1 → 周/月桶）。仅迁移一次性；后续由 refresh 策略增量。
3. **周/月 cagg 最近的桶边界**：CREATE 初始 refresh 物化到最后一个完整桶（1w max=2026-08-30、1mo max=2026-08-31），当前部分周/月桶待下一次 refresh 补齐（30d/1d、120d/1d 策略会覆盖）。不影响历史查询。
4. **前端批量取值**：`1d:250 / 1w:150 / 1mo:80` 等为约定合理值（单页往返 vs 次数权衡），未实测网络/渲染具体收益；可后续按真实性能微调。
5. **看板 E2E 未单独运行**：本轮验证覆盖 KlineDataFeed/klineDataLoader/store 单测 + `tsc` + `vite build`；全端 E2E（playwright 需真实栈+浏览器）未在无栈环境执行，属回归置信度上的一处保留。
6. **`kline_1d` 兜底数据空洞**：`kline_1d` 现仅近 2 周数据，作为兜底对 pre-2024 无贡献；全历史依赖 accurate cagg。若 accurate cagg 重建/回填失败，周/月线会回到只有近数据（兜底安全网较弱）。已保留 FALLBACK_1W/1MO 作部分兜底。
