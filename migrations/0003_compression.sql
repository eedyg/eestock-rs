-- ~/~ begin <<design/04-storage/schema.md#migrations/0003_compression.sql>>[init]
-- 0003_compression.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ⚠️ 语法修正（2026-09-03）：TimescaleDB 2.18+ 启用 columnstore 新 API；
-- 旧 timescaledb.compress 在 2.29 静默失效（本次实锤踩坑，证据见设计注记 5）
ALTER TABLE kline_raw SET (timescaledb.enable_columnstore,
    timescaledb.segmentby = 'code',
    timescaledb.orderby = 'ts DESC');
SELECT add_compression_policy('kline_raw', INTERVAL '7 days');

ALTER TABLE source_health_events SET (timescaledb.enable_columnstore,
    timescaledb.segmentby = 'source',
    timescaledb.orderby = 'ts DESC');
SELECT add_compression_policy('source_health_events', INTERVAL '7 days');
-- 健康事件保留 90 天；K线不删除（ADR-004：1m 历史靠累积）
SELECT add_retention_policy('source_health_events', INTERVAL '90 days');
-- ~/~ end
