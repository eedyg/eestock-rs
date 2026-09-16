-- ~/~ begin <<design/04-storage/schema.md#migrations/0026_period_30m.sql>>[init]
-- 0026_period_30m.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ADR-023（架构裁决 2026-09-16）：① 新增第 8 档 30m 的准确层连续聚合；
-- ② 根治 intraday accurate cagg 刷新窗口：5m/15m/30m/1h 的 start_offset 统一 INTERVAL '3 days'；
-- ③ 迁移内一次性全量刷新三个 intraday cagg（补齐 2026-09-07 以来 kline_accurate_5m 的空缺）。
-- 口径：30m = 1m 本地衍生（源 kline_accurate 的 M1 行，全历史），不取 tushare 原生 30min
--       （避免第二口径，ADR-004 单一事实源）。
-- 幂等：CREATE MATERIALIZED VIEW IF NOT EXISTS +
--       remove_continuous_aggregate_policy(if_exists => true) + refresh 重跑为等价重物化
--       ⇒ 重复执行不报错（NOTICE 属正常）。
-- 应用：psql -v ON_ERROR_STOP=1 -f migrations/0026_period_30m.sql
--       不得加 -1/--single-transaction（建连续聚合视图与 refresh 不可置于显式事务块）。
-- 顺序：先落本迁移再重启 app（新二进制启动自检含 kline_accurate_30m，缺关系会拒绝启动）。

CREATE MATERIALIZED VIEW IF NOT EXISTS kline_accurate_30m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('30 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('30 minutes', ts);

-- 刷新策略根治（ADR-023 §2.4.4）：无 in-place 修改 API ⇒ 先 remove（if_exists 幂等）再 add；
-- start_offset 由 2h/6h/2d（5m/15m/1h）统一放大到 3 days；end_offset/schedule_interval 保持现值。
SELECT remove_continuous_aggregate_policy('kline_accurate_5m', if_exists => true);
SELECT remove_continuous_aggregate_policy('kline_accurate_15m', if_exists => true);
SELECT remove_continuous_aggregate_policy('kline_accurate_30m', if_exists => true);
SELECT remove_continuous_aggregate_policy('kline_accurate_1h', if_exists => true);

-- 5m：start_offset 3 days（原 2h）
SELECT add_continuous_aggregate_policy('kline_accurate_5m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');

-- 15m：start_offset 3 days（原 6h）
SELECT add_continuous_aggregate_policy('kline_accurate_15m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');

-- 30m（新建）：即写入 3 days（禁止照抄 0017 的旧窗口值）
SELECT add_continuous_aggregate_policy('kline_accurate_30m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- 1h：start_offset 3 days（原 2 days）——与 1d（0010/0016）同值，形成「intraday accurate cagg 统一 3 days」规则
SELECT add_continuous_aggregate_policy('kline_accurate_1h',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- 一次性全量刷新（全历史；参数 NULL, NULL = 无界）。重跑为等价重物化，幂等。
-- 注：1h 无已知缺口（策略窗口 2d 已覆盖），不在此全量刷。
CALL refresh_continuous_aggregate('kline_accurate_30m', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_5m', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_15m', NULL, NULL);
-- ~/~ end
