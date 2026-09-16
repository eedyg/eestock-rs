\echo '--- A3 supplementary: idealized 240-bar session (09:30..11:29 + 13:00..14:59) ---'
INSERT INTO kline_accurate(code, ts, period, open, high, low, close, volume, amount, source)
SELECT 'VERIFY240', t.ts, 'M1', 1000+t.i-0.25, 1000+t.i+0.5, 1000+t.i-0.75, 1000+t.i, 10+t.i, (10+t.i)*2.0, 'verify'
FROM (SELECT row_number() OVER (ORDER BY ts)-1 AS i, ts FROM (
  SELECT (TIMESTAMPTZ '2026-09-15 09:30:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,119) g
  UNION ALL SELECT (TIMESTAMPTZ '2026-09-15 13:00:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,119) g) s) t;
SELECT count(*) AS bars_240 FROM kline_accurate WHERE code='VERIFY240' AND period='M1';
CALL refresh_continuous_aggregate('kline_accurate_30m', NULL, NULL);
SELECT count(*) AS buckets_240 FROM kline_accurate_30m WHERE code='VERIFY240';
