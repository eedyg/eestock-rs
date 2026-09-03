-- ~/~ begin <<design/04-storage/schema.md#migrations/0006_accurate_compression.sql>>[init]
-- 0006_accurate_compression.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 审查修正（2026-09-03）：0003 漏了 kline_accurate 的压缩（当时 16M 行 3GB 未压缩）
ALTER TABLE kline_accurate SET (timescaledb.enable_columnstore,
    timescaledb.segmentby = 'code,period',
    timescaledb.orderby = 'ts DESC');
SELECT add_compression_policy('kline_accurate', INTERVAL '7 days');
-- 存量压缩（首次部署时手动执行一次，之后策略自动接管）：
-- SELECT count(compress_chunk(x)) FROM show_chunks('kline_accurate', older_than => INTERVAL '7 days') x;
-- ~/~ end
