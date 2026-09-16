-- A4 STEP 2: NEW policy (3 days) + run same job
SELECT remove_continuous_aggregate_policy('kline_accurate_30m', if_exists => true);
SELECT add_continuous_aggregate_policy('kline_accurate_30m',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');
SELECT j.job_id AS new_job_id, j.config->>'start_offset' AS new_start_offset, j.config->>'end_offset' AS end_offset
FROM timescaledb_information.jobs j
JOIN _timescaledb_catalog.continuous_agg ca ON ca.mat_hypertable_id = (j.config->>'mat_hypertable_id')::int
WHERE ca.user_view_name = 'kline_accurate_30m';
DO $$
DECLARE jid int;
BEGIN
  SELECT j.job_id INTO jid FROM timescaledb_information.jobs j
  JOIN _timescaledb_catalog.continuous_agg ca ON ca.mat_hypertable_id = (j.config->>'mat_hypertable_id')::int
  WHERE ca.user_view_name = 'kline_accurate_30m';
  CALL run_job(jid);
END $$;
SELECT count(*) AS buckets_after_3d_policy_V2 FROM kline_accurate_30m WHERE code='VERIFYLATE2';
