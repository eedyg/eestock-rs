-- A4 STEP 0/1: age check + OLD policy (2 hours) + late data delivery + run job
SELECT now() AT TIME ZONE 'UTC' AS now_utc,
       (TIMESTAMPTZ '2026-09-15 09:30:00+08') AS late_ts,
       now() - (TIMESTAMPTZ '2026-09-15 09:30:00+08') AS age;
SELECT remove_continuous_aggregate_policy('kline_accurate_30m', if_exists => true);
SELECT add_continuous_aggregate_policy('kline_accurate_30m',
    start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');
SELECT j.job_id, j.config->>'start_offset' AS old_start_offset, j.config->>'end_offset' AS end_offset
FROM timescaledb_information.jobs j
JOIN _timescaledb_catalog.continuous_agg ca ON ca.mat_hypertable_id = (j.config->>'mat_hypertable_id')::int
WHERE ca.user_view_name = 'kline_accurate_30m';
INSERT INTO kline_accurate(code, ts, period, open, high, low, close, volume, amount, source)
SELECT 'VERIFYMUT', t.ts, 'M1', 1000+t.i, 1000+t.i, 1000+t.i, 1000+t.i, 1, 1.0, 'verify'
FROM (SELECT row_number() OVER (ORDER BY ts)-1 AS i, ts FROM (
  SELECT (TIMESTAMPTZ '2026-09-15 09:30:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,119) g
  UNION ALL SELECT (TIMESTAMPTZ '2026-09-15 13:00:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,119) g) s) t;
SELECT count(*) AS late_m1_rows FROM kline_accurate WHERE code='VERIFYMUT' AND period='M1';
DO $$
DECLARE jid int;
BEGIN
  SELECT j.job_id INTO jid FROM timescaledb_information.jobs j
  JOIN _timescaledb_catalog.continuous_agg ca ON ca.mat_hypertable_id = (j.config->>'mat_hypertable_id')::int
  WHERE ca.user_view_name = 'kline_accurate_30m';
  CALL run_job(jid);
END $$;
SELECT count(*) AS buckets_after_2h_policy_MUT FROM kline_accurate_30m WHERE code='VERIFYMUT';
