-- A3 fixture: exact live-DB M1 minute set (09:30..11:30 incl = 121; 13:01..15:00 = 120; total 241)
INSERT INTO kline_accurate(code, ts, period, open, high, low, close, volume, amount, source)
SELECT 'VERIFY30M', t.ts, 'M1',
       1000 + t.i - 0.25, 1000 + t.i + 0.5, 1000 + t.i - 0.75, 1000 + t.i,
       10 + t.i, (10 + t.i) * 2.0, 'verify'
FROM (
  SELECT row_number() OVER (ORDER BY ts) - 1 AS i, ts FROM (
    SELECT (TIMESTAMPTZ '2026-09-15 09:30:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,120) g
    UNION ALL
    SELECT (TIMESTAMPTZ '2026-09-15 13:01:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,119) g
  ) s
) t;
SELECT count(*) AS bars_30m_fixture FROM kline_accurate WHERE code='VERIFY30M' AND period='M1';
CALL refresh_continuous_aggregate('kline_accurate_30m', NULL, NULL);
SELECT count(*) AS materialized_buckets_F1 FROM kline_accurate_30m WHERE code='VERIFY30M';
SELECT to_char(ts AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI') AS bucket_cst, volume, open, high, low, close, amount
FROM kline_accurate_30m WHERE code='VERIFY30M' ORDER BY ts;
