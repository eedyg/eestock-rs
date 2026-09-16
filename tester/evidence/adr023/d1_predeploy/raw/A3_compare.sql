\echo '--- A3c-1: cagg vs independent manual aggregation (independent bucket expr) ---'
WITH manual AS (
  SELECT code,
         (date_trunc('hour', ts) + CASE WHEN extract(minute from ts)::int >= 30 THEN interval '30 min' ELSE interval '0 min' END) AS ts,
         (array_agg(open  ORDER BY ts))[1] AS open,
         max(high) AS high, min(low) AS low,
         (array_agg(close ORDER BY ts))[array_length(array_agg(close ORDER BY ts),1)] AS close,
         sum(volume) AS volume, sum(amount) AS amount
  FROM kline_accurate WHERE code='VERIFY30M' AND period='M1' GROUP BY code, 2
), c AS (SELECT code, ts, open::float8, high::float8, low::float8, close::float8, volume::numeric, amount::numeric FROM kline_accurate_30m WHERE code='VERIFY30M')
SELECT 'cagg_minus_manual' AS diff, count(*) FROM (SELECT * FROM c EXCEPT SELECT code, ts, open::float8, high::float8, low::float8, close::float8, volume::numeric, amount::numeric FROM manual) a
UNION ALL
SELECT 'manual_minus_cagg', count(*) FROM (SELECT code, ts, open::float8, high::float8, low::float8, close::float8, volume::numeric, amount::numeric FROM manual EXCEPT SELECT * FROM c) b;

\echo '--- A3c-2: cagg vs pure arithmetic expectation from generator formula ---'
WITH gen AS (
  SELECT row_number() OVER (ORDER BY ts) - 1 AS i, ts FROM (
    SELECT (TIMESTAMPTZ '2026-09-15 09:30:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,120) g
    UNION ALL SELECT (TIMESTAMPTZ '2026-09-15 13:01:00+08' + (g || ' min')::interval) AS ts FROM generate_series(0,119) g) s
), exp AS (
  SELECT 'VERIFY30M'::text AS code,
         (date_trunc('hour', ts) + CASE WHEN extract(minute from ts)::int >= 30 THEN interval '30 min' ELSE interval '0 min' END) AS ts,
         (1000 + min(i) - 0.25)::float8 AS open, (1000 + max(i) + 0.5)::float8 AS high,
         (1000 + min(i) - 0.75)::float8 AS low, (1000 + max(i))::float8 AS close,
         sum(10 + i)::numeric AS volume, sum((10 + i) * 2)::numeric AS amount
  FROM gen GROUP BY 1, 2
), c AS (SELECT code, ts, open::float8, high::float8, low::float8, close::float8, volume::numeric, amount::numeric FROM kline_accurate_30m WHERE code='VERIFY30M')
SELECT 'cagg_minus_arith' AS diff, count(*) FROM (SELECT * FROM c EXCEPT SELECT * FROM exp) a
UNION ALL
SELECT 'arith_minus_cagg', count(*) FROM (SELECT * FROM exp EXCEPT SELECT * FROM c) b;

\echo '--- A3b: bucket boundary alignment (all buckets minute in {0,30}, sec=0) ---'
SELECT count(*) AS buckets, count(*) FILTER (WHERE extract(minute from ts)::int IN (0,30) AND extract(second from ts)=0 AND extract(hour from (ts AT TIME ZONE 'Asia/Shanghai'))::int BETWEEN 0 AND 23) AS aligned,
       min(ts AT TIME ZONE 'Asia/Shanghai') AS first_bucket, max(ts AT TIME ZONE 'Asia/Shanghai') AS last_bucket
FROM kline_accurate_30m WHERE code='VERIFY30M';
