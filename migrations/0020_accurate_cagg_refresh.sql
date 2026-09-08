-- ~/~ begin <<design/04-storage/schema.md#migrations/0020_accurate_cagg_refresh.sql>>[init]
-- 0020_accurate_cagg_refresh.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 修复：accurate cagg（5m/15m/1h/1d）在 tushare 大批量 M1 回填后物化滞后。
-- 成因：cagg 刷新策略只覆盖近期窗口（start_offset 2h/6h/2d），回填的旧桶落在窗口外 → watermark 停在回填边界。
-- 处置：全量刷新全部 accurate cagg 至最新 M1（与 kline_accurate M1 max 对齐）；幂等；空数据为 no-op。
CALL refresh_continuous_aggregate('kline_accurate_5m', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_15m', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_1h', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL);
-- ~/~ end
