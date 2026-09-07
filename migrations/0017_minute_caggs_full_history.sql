-- ~/~ begin <<design/04-storage/schema.md#migrations/0017_minute_caggs_full_history.sql>>[init]
-- 0017_minute_caggs_full_history.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 问题① 修复：分钟线全历史。既有库 0010 建的 kline_accurate_5m/15m/1h 带 ts >= '2024-01-01' 过滤
-- （仅 2024+），与 1m/1d/周/月（全量）口径不一致，深翻在 2024 边界截断。
-- 本迁移 DROP 后重建为全量（无 2024 过滤，聚合 kline_accurate 全部 M1）+ 同样 refresh 策略。
-- 兜底（reader.rs 查询期 kline_5m/15m + kline_15m rollup）保留作为 accurate 缺时的安全网。
DROP MATERIALIZED VIEW kline_accurate_5m;
DROP MATERIALIZED VIEW kline_accurate_15m;
DROP MATERIALIZED VIEW kline_accurate_1h;

CREATE MATERIALIZED VIEW kline_accurate_5m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('5 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('5 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_15m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('15 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('15 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_1h
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 hour', ts);

-- 刷新策略（与 0010 同，窗口须覆盖 ≥ 两桶：5m=2h≈24桶、15m=6h≈24桶、1h=2d≈48桶）
SELECT add_continuous_aggregate_policy('kline_accurate_5m',
    start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_15m',
    start_offset => INTERVAL '6 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_1h',
    start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- 运维注记：历史回填后须手动全量刷新一次以物化深历史（覆盖 2012→今）：
-- CALL refresh_continuous_aggregate('kline_accurate_5m', NULL, NULL);
-- CALL refresh_continuous_aggregate('kline_accurate_15m', NULL, NULL);
-- CALL refresh_continuous_aggregate('kline_accurate_1h', NULL, NULL);
-- ~/~ end
