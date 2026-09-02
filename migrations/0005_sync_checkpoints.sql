-- ~/~ begin <<design/04-storage/02-tushare-sync.md#migrations/0005_sync_checkpoints.sql>>[init]
-- 0005_sync_checkpoints.sql — 由 design/04-storage/02-tushare-sync.md tangle 生成，禁止手改
-- 断点续传检查点（tushare 历史同步）
CREATE TABLE sync_checkpoints (
    code             text NOT NULL,
    period           text NOT NULL,          -- M1（当前唯一原生周期）
    last_synced_date date NOT NULL,          -- Asia/Shanghai 口径的已同步截止日（含）
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (code, period)
);

-- 准确层日级连续聚合（父级裁决：D1 不物化落行，由 M1 派生）
CREATE MATERIALIZED VIEW kline_accurate_1d
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 day', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 day', ts, 'Asia/Shanghai');
SELECT add_continuous_aggregate_policy('kline_accurate_1d',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
-- ~/~ end
