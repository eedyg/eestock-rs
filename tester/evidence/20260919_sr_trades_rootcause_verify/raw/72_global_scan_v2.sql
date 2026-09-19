-- Tester 独立全库扫描 v2（只读，口径修正）
-- 关键口径（engine.rs）：
--   * step7 在 bar i 生成的挂单存入 self.pending，只在 step1（bar i+1）被取走执行；
--   * Intrabar 止损的成交不经过 orders（当 bar 直接成交）；ForceClose 的成交也不经过 orders（finish）；
--   ⇒ 「被丢弃/跳过的挂单」必须用 orders 与 **reason='Policy'（或 StopTrigger=CloseBasis）** 的 Fill 配对，
--     而不是与全部 Fill 配对（后者会把 ForceClose/Intrabar 当成「多余成交」）。
\pset footer off
\echo '=== U1 每个 run：Policy 意图 vs Policy 成交（差 = 被丢弃或静默跳过的挂单）==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
per AS (
  SELECT run_id,
         SUM(jsonb_array_length(e->'orders')) AS intents,
         SUM((SELECT count(*) FROM jsonb_array_elements(e->'events') ev
              WHERE ev->>'type'='fill' AND ev->>'reason'='Policy')) AS policy_fills,
         SUM((SELECT count(*) FROM jsonb_array_elements(e->'events') ev
              WHERE ev->>'type'='fill' AND ev->>'reason'='ForceClose')) AS fc_fills,
         SUM((SELECT count(*) FROM jsonb_array_elements(e->'events') ev
              WHERE ev->>'type'='fill' AND ev->>'reason'='StopTrigger')) AS stop_fills
  FROM uni, jsonb_array_elements(pb) e GROUP BY run_id
)
SELECT p.run_id, sr.symbol, sr.period, p.intents, p.policy_fills, p.stop_fills, p.fc_fills,
       p.intents - p.policy_fills AS unexecuted_orders
FROM per p JOIN strategy_run sr ON sr.id = p.run_id
ORDER BY (p.intents - p.policy_fills) DESC, p.run_id
LIMIT 25;
\echo '=== U1b 汇总 ==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
per AS (
  SELECT run_id,
         SUM(jsonb_array_length(e->'orders')) AS intents,
         SUM((SELECT count(*) FROM jsonb_array_elements(e->'events') ev
              WHERE ev->>'type'='fill' AND ev->>'reason'='Policy')) AS policy_fills
  FROM uni, jsonb_array_elements(pb) e GROUP BY run_id
)
SELECT count(*) AS runs_total,
       count(*) FILTER (WHERE intents = policy_fills) AS runs_fully_executed,
       count(*) FILTER (WHERE intents <> policy_fills) AS runs_with_unexecuted_orders,
       count(*) FILTER (WHERE intents < policy_fills) AS runs_negative,
       SUM(intents - policy_fills) AS total_unexecuted
FROM per;
\echo '=== U2 末 bar 仍有挂单的 run（结构上必然无下一根 bar 可成交 ⇒ 丢弃）==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
lastelt AS (
  SELECT run_id, (array_agg(e ORDER BY ord DESC))[1] AS le
  FROM uni, jsonb_array_elements(pb) WITH ORDINALITY AS t(e, ord) GROUP BY run_id
)
SELECT count(*) AS runs_with_orders_on_last_bar,
       count(*) FILTER (WHERE l.le->'orders' @> '[{"side":"Buy","reason":"Policy"}]') AS with_policy_buy,
       count(*) FILTER (WHERE l.le->'orders' @> '[{"side":"Sell"}]') AS with_sell
FROM lastelt l WHERE jsonb_array_length(l.le->'orders') > 0;
\echo '=== U2b 目标 run 的末 bar 原文 ==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
lastelt AS (
  SELECT run_id, (array_agg(e ORDER BY ord DESC))[1] AS le
  FROM uni, jsonb_array_elements(pb) WITH ORDINALITY AS t(e, ord) GROUP BY run_id
)
SELECT le->>'ts' AS ts, le->'orders' AS orders, le->'events' AS events, le->>'signal' AS signal,
       le->>'warmup' AS warmup
FROM lastelt WHERE run_id='sr_1789738328788_000005';
\echo '=== U3 「有已实现回合但全程无真实卖出成交」的 run（回合 100% 由期末强平合成）==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
sellfill AS (
  SELECT run_id, count(*) FILTER (WHERE ev->>'type'='fill' AND ev->>'side'='Sell') AS sell_fills,
         count(*) FILTER (WHERE ev->>'type'='fill' AND ev->>'side'='Sell' AND ev->>'reason'<>'ForceClose') AS real_sell_fills
  FROM uni, jsonb_array_elements(pb) e, jsonb_array_elements(e->'events') ev
  GROUP BY run_id
)
SELECT count(*) AS runs_total,
       count(*) FILTER (WHERE jsonb_array_length(r.trades) > 0) AS runs_with_closed_rounds,
       count(*) FILTER (WHERE jsonb_array_length(r.trades) > 0 AND s.real_sell_fills = 0) AS rounds_all_synthetic
FROM strategy_run_result r LEFT JOIN sellfill s ON s.run_id = r.run_id;
\echo '=== U3b 上类的 trade_count / win_rate / profit_factor 直方（对外读数）==='
WITH uni AS (
  SELECT r.run_id, r.per_bar AS pb FROM strategy_run_result r WHERE r.result_format='legacy_single'
  UNION ALL
  SELECT b.run_id, b.payload AS pb FROM strategy_run_bars b WHERE b.kind='per_bar'
),
sellfill AS (
  SELECT run_id,
         count(*) FILTER (WHERE ev->>'type'='fill' AND ev->>'side'='Sell' AND ev->>'reason'<>'ForceClose') AS real_sell_fills
  FROM uni, jsonb_array_elements(pb) e, jsonb_array_elements(e->'events') ev GROUP BY run_id
)
SELECT (r.metrics->>'trade_count')::int AS trade_count,
       (r.metrics->>'win_rate')::float8 AS win_rate,
       (r.metrics->>'profit_factor')::float8 AS profit_factor,
       count(*) AS runs
FROM strategy_run_result r JOIN sellfill s ON s.run_id=r.run_id
WHERE jsonb_array_length(r.trades) > 0 AND s.real_sell_fills = 0
GROUP BY 1,2,3 ORDER BY runs DESC LIMIT 15;
\echo '=== U4 metrics vs 结果块不变量（其余 run 是否有冲突）==='
WITH nav AS (
  SELECT r.run_id,
         COALESCE((r.net_value->-1->>1)::float8,
                  (SELECT (b.payload->-1->>1)::float8 FROM strategy_run_bars b WHERE b.run_id=r.run_id AND b.kind='net_value')) AS nav_last,
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
SELECT run_id,
       abs(m_net-(nav_last-init)) AS d_net, abs(m_dd-dd_max) AS d_dd,
       abs(m_tc-trades_n) AS d_tc, abs(pnl_sum-(nav_last-init)) AS d_pnlsum
FROM nav
WHERE abs(m_net-(nav_last-init))>1e-6 OR abs(m_dd-dd_max)>1e-9 OR abs(m_tc-trades_n)>0
   OR abs(pnl_sum-(nav_last-init))>1e-6
ORDER BY run_id;
\echo '=== U4b 违反计数 + profit_factor=null 计数 ==='
WITH nav AS (
  SELECT r.run_id,
         COALESCE((r.net_value->-1->>1)::float8,
                  (SELECT (b.payload->-1->>1)::float8 FROM strategy_run_bars b WHERE b.run_id=r.run_id AND b.kind='net_value')) AS nav_last,
         COALESCE((SELECT max((v->>1)::float8) FROM jsonb_array_elements(r.drawdown) v),
                  (SELECT max((v->>1)::float8) FROM strategy_run_bars b, jsonb_array_elements(b.payload) v
                   WHERE b.run_id=r.run_id AND b.kind='drawdown')) AS dd_max,
         jsonb_array_length(r.trades) AS trades_n,
         (SELECT COALESCE(sum((t->>'pnl')::float8),0) FROM jsonb_array_elements(r.trades) t) AS pnl_sum,
         (r.metrics->>'net_profit')::float8 AS m_net,
         (r.metrics->>'max_drawdown')::float8 AS m_dd, (r.metrics->>'trade_count')::int AS m_tc,
         (sr.config->>'initial_capital')::float8 AS init, r.metrics
  FROM strategy_run_result r JOIN strategy_run sr ON sr.id=r.run_id
)
SELECT count(*) AS runs,
  count(*) FILTER (WHERE abs(m_net-(nav_last-init))>1e-6) AS bad_net,
  count(*) FILTER (WHERE abs(m_dd-dd_max)>1e-9) AS bad_dd,
  count(*) FILTER (WHERE abs(m_tc-trades_n)>0) AS bad_tc,
  count(*) FILTER (WHERE abs(pnl_sum-(nav_last-init))>1e-6) AS bad_pnlsum,
  count(*) FILTER (WHERE metrics->'profit_factor' = 'null'::jsonb) AS pf_json_null
FROM nav;
