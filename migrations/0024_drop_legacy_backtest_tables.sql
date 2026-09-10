-- ~/~ begin <<design/04-storage/schema.md#migrations/0024_drop_legacy_backtest_tables.sql>>[init]
-- 0024_drop_legacy_backtest_tables.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 技术债清算 TD-3（架构裁决 2026-09-10）：旧回测残留表终局回收。
-- backtest_runs / backtest_results 自 P4b（12-strategy-system D16 终章）退役后无任何代码读写；
-- IF EXISTS 保证幂等（全新库从 0001 顺跑本迁移时两表由 0011 建出，重复执行/缺表均安全）。
DROP TABLE IF EXISTS backtest_results;
DROP TABLE IF EXISTS backtest_runs;
-- ~/~ end
