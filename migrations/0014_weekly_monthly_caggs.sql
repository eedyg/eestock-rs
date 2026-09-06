-- ~/~ begin <<design/04-storage/schema.md#migrations/0014_weekly_monthly_caggs.sql>>[init]
-- 0014_weekly_monthly_caggs.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 行情看板周线/月线（后端 W1）：kline_accurate M1 连续聚合出 kline_accurate_1w/1mo。
-- 周=A股交易周（time_bucket('1 week', ts, 'Asia/Shanghai') 周一为界）；月=自然月（month 界）。
-- WHERE ts >= '2024-01-01'（与 0010 同口径：尊重「2024 即可」不聚合 2012 前亿万级 M1）。
-- 兜底在 reader.rs 查询期 rollup（kline_1d → week/month 桶），见 00-web-api §3。
CREATE MATERIALIZED VIEW kline_accurate_1w
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 week', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1' AND ts >= '2024-01-01'
GROUP BY code, time_bucket('1 week', ts, 'Asia/Shanghai');

CREATE MATERIALIZED VIEW kline_accurate_1mo
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 month', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1' AND ts >= '2024-01-01'
GROUP BY code, time_bucket('1 month', ts, 'Asia/Shanghai');

-- 刷新策略（周/月桶变化不频繁，schedule 放宽；历史回填后须手动全量 refresh 一次）
-- ⚠️ TimescaleDB 校验：refresh 窗口（start_offset = end_offset）须覆盖 ≥ 两个桶，否则报
-- "policy refresh window too small"（周桶=7d、月桶≈30d）；故周用 30d/1d、月用 120d/1d。
SELECT add_continuous_aggregate_policy('kline_accurate_1w',
    start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('kline_accurate_1mo',
    start_offset => INTERVAL '120 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
-- ~/~ end
