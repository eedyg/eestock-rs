-- ~/~ begin <<design/04-storage/schema.md#migrations/0010_accurate_caggs.sql>>[init]
-- 0010_accurate_caggs.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 统一读源（用户定稿 2026-09-04）：kline_accurate M1（2012→今）为全历史真值；
-- 5m/15m/1h cagg 从 M1 聚合（WHERE ts >= '2024-01-01'，尊重「2024 即可」不聚合 2012 前）。
-- D1 accurate 复用 0005 既有 kline_accurate_1d（聚合全量 M1；日级桶化开销可忽略）。
CREATE MATERIALIZED VIEW kline_accurate_5m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('5 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1' AND ts >= '2024-01-01'
GROUP BY code, time_bucket('5 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_15m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('15 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1' AND ts >= '2024-01-01'
GROUP BY code, time_bucket('15 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_1h
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1' AND ts >= '2024-01-01'
GROUP BY code, time_bucket('1 hour', ts);

-- 刷新策略（近期窗口增量；历史回填后须手动全量 refresh 一次，见块头运维注记）
SELECT add_continuous_aggregate_policy('kline_accurate_5m',
    start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_15m',
    start_offset => INTERVAL '6 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_1h',
    start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
-- ~/~ end
