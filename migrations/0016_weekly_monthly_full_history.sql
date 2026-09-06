-- ~/~ begin <<design/04-storage/schema.md#migrations/0016_weekly_monthly_full_history.sql>>[init]
-- 0016_weekly_monthly_full_history.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 问题① 修复：周/月线全历史。既有库 0014 建的 kline_accurate_1w/1mo 带 ts >= '2024-01-01' 过滤
-- （仅 2024+），且 reader 兜底 kline_1d 只有近 2 周数据 → 周/月线只能到 2024。
-- 本迁移 DROP 后重建为全历史（无 2024 过滤；周/月桶少，全量聚合 M1 2012+ 便宜）+ 同样 refresh 策略。
-- 兜底 FALLBACK_1W/1MO（reader.rs 查询期 kline_1d rollup）保留作为 accurate 缺时的安全网。
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

-- 刷新策略（与 0014 同）：周用 30d/1d、月用 120d/1d（窗口须覆盖 ≥ 两桶）。
SELECT add_continuous_aggregate_policy('kline_accurate_1w',
    start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('kline_accurate_1mo',
    start_offset => INTERVAL '120 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
-- ~/~ end
