-- Tester 独立全库扫描（只读）：用户可见的「意图 vs 成交」与「metrics vs 结果块」不变量
-- 口径来源：engine.rs step1（一条挂单→至多一笔 Fill）/ step7（订单=目标−当前）/ finish()（不消费 pending）
-- 输出四张表，见 70_global_scan.out
\pset footer off
\echo '=== T1 每个 run：意图数 vs Fill 事件数（差 = 静默丢弃/跳过）==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
per AS (
  SELECT run_id,
         SUM(jsonb_array_length(e->'orders')) AS intents,
         SUM((SELECT count(*) FROM jsonb_array_elements(e->'events') ev WHERE ev->>'type'='fill')) AS fill_events,
         SUM((SELECT count(*) FROM jsonb_array_elements(e->'events') ev
              WHERE ev->>'type'='fill' AND ev->>'reason'='ForceClose')) AS forceclose_events,
         SUM(CASE WHEN e->>'warmup' = 'true' THEN 1 ELSE 0 END) AS warmup_bars,
         COUNT(*) AS bars_n,
         jsonb_array_length((array_agg(e ORDER BY ord DESC))[1]->'orders') AS last_bar_orders,
         (SELECT count(*) FROM jsonb_array_elements((array_agg(e ORDER BY ord DESC))[1]->'events') ev
            WHERE ev->>'type'='fill') AS last_bar_fills
  FROM uni, jsonb_array_elements(pb) WITH ORDINALITY AS t(e, ord)
  GROUP BY run_id
)
SELECT p.run_id, sr.symbol, sr.period, p.bars_n, p.warmup_bars, p.intents, p.fill_events,
       p.forceclose_events, p.intents - p.fill_events AS unmatched_intents,
       p.last_bar_orders, p.last_bar_fills
FROM per p JOIN strategy_run sr ON sr.id = p.run_id
WHERE p.intents <> p.fill_events
ORDER BY (p.intents - p.fill_events) DESC, p.run_id;
\echo '=== T1b 计数汇总 ==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
per AS (
  SELECT run_id,
         SUM(jsonb_array_length(e->'orders')) AS intents,
         SUM((SELECT count(*) FROM jsonb_array_elements(e->'events') ev WHERE ev->>'type'='fill')) AS fill_events
  FROM uni, jsonb_array_elements(pb) e GROUP BY run_id
)
SELECT count(*) AS runs_total,
       count(*) FILTER (WHERE intents = fill_events) AS runs_match,
       count(*) FILTER (WHERE intents > fill_events) AS runs_unmatched,
       count(*) FILTER (WHERE intents < fill_events) AS runs_negative,
       SUM(intents - fill_events) AS total_unmatched
FROM per;
\echo '=== T2 末 bar 有挂单但该 bar 无同侧 Fill 的 run（末 bar 丢弃）==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
lastelt AS (
  SELECT run_id, (array_agg(e ORDER BY ord DESC))[1] AS le
  FROM uni, jsonb_array_elements(pb) WITH ORDINALITY AS t(e, ord) GROUP BY run_id
)
SELECT l.run_id, sr.symbol, sr.period, l.le->'orders' AS last_orders,
       (SELECT jsonb_agg(ev) FROM jsonb_array_elements(l.le->'events') ev WHERE ev->>'type'='fill') AS last_fills
FROM lastelt l JOIN strategy_run sr ON sr.id = l.run_id
WHERE jsonb_array_length(l.le->'orders') > 0
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(l.le->'orders') o
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(l.le->'events') ev
                  WHERE ev->>'type'='fill' AND ev->>'side' = o->>'side'))
ORDER BY l.run_id;
\echo '=== T2b 末 bar 丢弃 run 数 ==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
lastelt AS (SELECT run_id, (array_agg(e ORDER BY ord DESC))[1] AS le
  FROM uni, jsonb_array_elements(pb) WITH ORDINALITY AS t(e, ord) GROUP BY run_id)
SELECT count(*) AS runs_with_orders_on_last_bar
FROM lastelt l
WHERE jsonb_array_length(l.le->'orders') > 0
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(l.le->'orders') o
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(l.le->'events') ev
                  WHERE ev->>'type'='fill' AND ev->>'side' = o->>'side'));
\echo '=== T3 metrics vs 结果块不变量（净利=末净值−初始；回撤=max(drawdown)；trade_count=len(trades)；Σpnl=净利）==='
WITH nav AS (
  SELECT r.run_id,
         COALESCE((r.net_value->-1->>1)::float8,
                  (SELECT (b.payload->-1->>1)::float8 FROM strategy_run_bars b
                   WHERE b.run_id=r.run_id AND b.kind='net_value')) AS nav_last,
         COALESCE((SELECT max((v->>1)::float8) FROM jsonb_array_elements(r.drawdown) v),
                  (SELECT max((v->>1)::float8) FROM strategy_run_bars b,
                        jsonb_array_elements(b.payload) v
                   WHERE b.run_id=r.run_id AND b.kind='drawdown')) AS dd_max,
         jsonb_array_length(r.trades) AS trades_n,
         (SELECT COALESCE(sum((t->>'pnl')::float8),0) FROM jsonb_array_elements(r.trades) t) AS pnl_sum,
         (r.metrics->>'net_profit')::float8 AS m_net,
         (r.metrics->>'max_drawdown')::float8 AS m_dd,
         (r.metrics->>'trade_count')::int AS m_tc,
         (sr.config->>'initial_capital')::float8 AS init
  FROM strategy_run_result r JOIN strategy_run sr ON sr.id=r.run_id
)
SELECT run_id,
       abs(m_net - (nav_last - init)) AS d_net,
       abs(m_dd - dd_max) AS d_dd,
       abs(m_tc - trades_n) AS d_tc,
       abs(pnl_sum - (nav_last - init)) AS d_pnlsum
FROM nav
WHERE abs(m_net - (nav_last - init)) > 1e-6
   OR abs(m_dd - dd_max) > 1e-9
   OR abs(m_tc - trades_n) > 0
   OR abs(pnl_sum - (nav_last - init)) > 1e-6
ORDER BY run_id;
\echo '=== T3b 违反计数 ==='
WITH nav AS (
  SELECT r.run_id,
         COALESCE((r.net_value->-1->>1)::float8,
                  (SELECT (b.payload->-1->>1)::float8 FROM strategy_run_bars b
                   WHERE b.run_id=r.run_id AND b.kind='net_value')) AS nav_last,
         COALESCE((SELECT max((v->>1)::float8) FROM jsonb_array_elements(r.drawdown) v),
                  (SELECT max((v->>1)::float8) FROM strategy_run_bars b, jsonb_array_elements(b.payload) v
                   WHERE b.run_id=r.run_id AND b.kind='drawdown')) AS dd_max,
         jsonb_array_length(r.trades) AS trades_n,
         (SELECT COALESCE(sum((t->>'pnl')::float8),0) FROM jsonb_array_elements(r.trades) t) AS pnl_sum,
         (r.metrics->>'net_profit')::float8 AS m_net,
         (r.metrics->>'max_drawdown')::float8 AS m_dd, (r.metrics->>'trade_count')::int AS m_tc,
         (sr.config->>'initial_capital')::float8 AS init
  FROM strategy_run_result r JOIN strategy_run sr ON sr.id=r.run_id
)
SELECT count(*) AS runs,
  count(*) FILTER (WHERE abs(m_net-(nav_last-init))>1e-6) AS bad_net,
  count(*) FILTER (WHERE abs(m_dd-dd_max)>1e-9) AS bad_dd,
  count(*) FILTER (WHERE abs(m_tc-trades_n)>0) AS bad_tc,
  count(*) FILTER (WHERE abs(pnl_sum-(nav_last-init))>1e-6) AS bad_pnlsum
FROM nav;
