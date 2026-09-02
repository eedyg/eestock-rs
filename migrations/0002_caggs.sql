-- ~/~ begin <<design/04-storage/schema.md#migrations/0002_caggs.sql>>[init]
-- 0002_caggs.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 高周期全部从 kline_raw 聚合；准确层粒度 ≥1m 时同样语义适用
CREATE MATERIALIZED VIEW kline_5m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('5 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_raw GROUP BY code, time_bucket('5 minutes', ts);

CREATE MATERIALIZED VIEW kline_15m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('15 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_raw GROUP BY code, time_bucket('15 minutes', ts);

CREATE MATERIALIZED VIEW kline_1d
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 day', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_raw GROUP BY code, time_bucket('1 day', ts, 'Asia/Shanghai');
-- 筹码分布的日线输入即 kline_1d（ADR-011）
-- ⚠️ 审查修正：日界必须按交易所时区对齐（time_bucket 三参形式），否则跨日 bar 错分

-- ⚠️ 审查修正：cagg 必须配刷新策略，否则是不更新的死视图
SELECT add_continuous_aggregate_policy('kline_5m',
    start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_15m',
    start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_1d',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
-- ~/~ end
