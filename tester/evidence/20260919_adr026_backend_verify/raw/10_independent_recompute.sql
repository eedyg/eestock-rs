-- Tester 独立重算（ADR-026 阶段2 核验）：不复用应用代码，直接读活库原始 payload。
-- 事实源：strategy_run_bars(kind='per_bar'|'fills').payload（chunked_v1）
--         或 strategy_run_result.per_bar / per_bar[i].events（legacy_single）
-- 口径：佣金 = max(成交额 × rate_pct/100, min_fee)，rate/min 取自 run config.fee。
\pset pager off
\timing off

WITH runs(rid) AS (VALUES
  ('sr_1789738328788_000005'),
  ('sr_1789738272901_000004'),
  ('sr_1789044295239_000111')
),
bar_src AS (
  SELECT r.rid, e.value AS bar, (e.ordinality - 1)::int AS i
  FROM runs r
  JOIN strategy_run_bars srb ON srb.run_id = r.rid AND srb.kind = 'per_bar'
  JOIN LATERAL jsonb_array_elements(srb.payload) WITH ORDINALITY e ON true
  UNION ALL
  SELECT r.rid, e.value, (e.ordinality - 1)::int
  FROM runs r
  JOIN strategy_run_result srr ON srr.run_id = r.rid
  JOIN LATERAL jsonb_array_elements(srr.per_bar) WITH ORDINALITY e ON true
),
ord_src AS (
  SELECT b.rid, b.i, o.value AS o
  FROM bar_src b
  JOIN LATERAL jsonb_array_elements(COALESCE(b.bar->'orders', '[]'::jsonb)) o ON true
  WHERE COALESCE((b.bar->>'warmup')::bool, false) = false
),
intents AS (
  SELECT rid,
         count(*) FILTER (WHERE o->>'side' = 'Buy')  AS buy_intents,
         count(*) FILTER (WHERE o->>'side' = 'Sell') AS sell_intents
  FROM ord_src GROUP BY rid
),
in_range AS (
  SELECT rid, count(*) AS in_range_bars, max(i) AS last_i
  FROM bar_src WHERE COALESCE((bar->>'warmup')::bool, false) = false GROUP BY rid
),
last_bar AS (
  SELECT ir.rid, ir.last_i,
         EXISTS (SELECT 1 FROM ord_src os WHERE os.rid = ir.rid AND os.i = ir.last_i AND os.o->>'side' = 'Buy')
           AS last_bar_unfilled
  FROM in_range ir
),
fill_src AS (
  SELECT r.rid, e.value AS f
  FROM runs r
  JOIN strategy_run_bars srb ON srb.run_id = r.rid AND srb.kind = 'fills'
  JOIN LATERAL jsonb_array_elements(srb.payload) WITH ORDINALITY e ON true
  UNION ALL
  SELECT r.rid, ev.value
  FROM runs r
  JOIN strategy_run_result srr ON srr.run_id = r.rid
  JOIN LATERAL jsonb_array_elements(srr.per_bar) WITH ORDINALITY e ON true
  JOIN LATERAL jsonb_array_elements(COALESCE(e.value->'events', '[]'::jsonb)) WITH ORDINALITY ev ON true
  WHERE ev.value->>'type' = 'fill'
),
fills AS (
  SELECT fs.rid,
         count(*) FILTER (WHERE fs.f->>'side' = 'Buy')  AS buy_fills,
         count(*) FILTER (WHERE fs.f->>'side' = 'Sell') AS sell_fills,
         sum((fs.f->>'qty')::float8 * (fs.f->>'price')::float8)
           FILTER (WHERE fs.f->>'side' = 'Buy')        AS deployed_notional,
         sum(GREATEST((fs.f->>'qty')::float8 * (fs.f->>'price')::float8 * (sr.config->'fee'->>'rate_pct')::float8 / 100.0,
                      (sr.config->'fee'->>'min_fee')::float8))
           FILTER (WHERE fs.f->>'side' = 'Buy')        AS buy_commission
  FROM fill_src fs JOIN strategy_run sr ON sr.id = fs.rid
  GROUP BY fs.rid
),
trades AS (
  SELECT r.rid, jsonb_array_length(srr.trades) AS trades_len
  FROM runs r JOIN strategy_run_result srr ON srr.run_id = r.rid
),
force_close AS (
  SELECT fs.rid,
         count(*) FILTER (WHERE fs.f->>'side' = 'Sell' AND fs.f->>'reason' = 'ForceClose')
           AS forceclose_sell_fills,
         count(*) FILTER (WHERE fs.f->>'side' = 'Sell' AND fs.f->>'reason' = 'ForceClose'
                          AND EXISTS (SELECT 1 FROM jsonb_array_elements(srr.trades) t
                                      WHERE (t->>'close_bar')::int = (fs.f->>'bar_index')::int))
           AS forceclosed_round_trips_by_close_bar
  FROM fill_src fs JOIN strategy_run_result srr ON srr.run_id = fs.rid
  GROUP BY fs.rid
)
SELECT i.rid,
       (sr.config->>'initial_capital')::float8                       AS capital_basis,
       COALESCE(sr.config->'policy'->'Dca'->>'tranches', 'NULL')     AS planned_tranches,
       ir.in_range_bars,
       i.buy_intents                                                 AS reachable_batches,
       f.buy_fills                                                   AS batches_done,
       i.buy_intents - f.buy_fills                                   AS unexecuted_orders,
       lb.last_bar_unfilled,
       round(f.deployed_notional::numeric, 6)                        AS deployed_notional,
       round((f.deployed_notional / (sr.config->>'initial_capital')::float8)::numeric, 8) AS deployed_pct,
       round(f.buy_commission::numeric, 6)                           AS buy_commission_sum,
       round((f.deployed_notional + f.buy_commission)::numeric, 6)   AS cash_consumed,
       round(((f.deployed_notional + f.buy_commission) / (sr.config->>'initial_capital')::float8)::numeric, 8) AS cash_consumed_pct,
       t.trades_len                                                  AS round_trips_total,
       fc.forceclose_sell_fills,
       fc.forceclosed_round_trips_by_close_bar                       AS round_trips_force_closed
FROM intents i
JOIN fills f ON f.rid = i.rid
JOIN in_range ir ON ir.rid = i.rid
JOIN last_bar lb ON lb.rid = i.rid
JOIN trades t ON t.rid = i.rid
JOIN force_close fc ON fc.rid = i.rid
JOIN strategy_run sr ON sr.id = i.rid
ORDER BY i.rid;

-- 目标 run：逐笔买单抽样（名义/佣金逐笔，供与端点 deployed/cash 对照）
SELECT (e.f->>'bar_index')::int AS exec_bar, (e.f->>'qty')::float8 AS qty, (e.f->>'price')::float8 AS price,
       round(((e.f->>'qty')::float8 * (e.f->>'price')::float8)::numeric, 6) AS notional,
       round(GREATEST((e.f->>'qty')::float8 * (e.f->>'price')::float8 * 0.025 / 100.0, 5.0)::numeric, 6) AS commission
FROM strategy_run_bars
JOIN LATERAL jsonb_array_elements(payload) WITH ORDINALITY e(f, ord) ON true
WHERE run_id = 'sr_1789738328788_000005' AND kind = 'fills' AND e.f->>'side' = 'Buy'
ORDER BY exec_bar LIMIT 6;
