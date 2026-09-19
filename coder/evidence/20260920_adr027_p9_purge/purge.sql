-- ADR-027 D3 P9 purge — v1 (pre-archive) rows only.
-- cutoff = 2026-09-19T14:41:56Z (from archive filename eestock_adr027_p0_tables_20260919T144156Z.dump)
-- Discipline: no DDL schema-drop, no whole-table unconditional wipe. Time-guarded predicates only.
\set ON_ERROR_STOP on
BEGIN;

\echo '--- BEFORE: strategy_run partition by cutoff (created_at < cutoff) ---'
SELECT (created_at < timestamptz '2026-09-19T14:41:56Z') AS is_old, count(*) AS n
  FROM public.strategy_run GROUP BY 1 ORDER BY 1;

\echo '--- BEFORE: simsession partition by cutoff (start_ts < cutoff) ---'
SELECT (start_ts < timestamptz '2026-09-19T14:41:56Z') AS is_old, count(*) AS n
  FROM public.simsession GROUP BY 1 ORDER BY 1;

\echo '--- DELETE v1 strategy_run (created_at < cutoff); cascades to *_result / *_bars ---'
DELETE FROM public.strategy_run WHERE created_at < timestamptz '2026-09-19T14:41:56Z';

\echo '--- DELETE v1 simsession (start_ts < cutoff); cascades to *_result / *_state / sim_trades / sim_positions ---'
DELETE FROM public.simsession WHERE start_ts < timestamptz '2026-09-19T14:41:56Z';

COMMIT;

\echo '--- AFTER: strategy_run partition by cutoff ---'
SELECT (created_at < timestamptz '2026-09-19T14:41:56Z') AS is_old, count(*) AS n
  FROM public.strategy_run GROUP BY 1 ORDER BY 1;

\echo '--- AFTER: simsession partition by cutoff ---'
SELECT (start_ts < timestamptz '2026-09-19T14:41:56Z') AS is_old, count(*) AS n
  FROM public.simsession GROUP BY 1 ORDER BY 1;

\echo '--- AFTER: all 8 tables ---'
SELECT 'strategy_run|'||count(*) FROM public.strategy_run
UNION ALL SELECT 'strategy_run_result|'||count(*) FROM public.strategy_run_result
UNION ALL SELECT 'strategy_run_bars|'||count(*) FROM public.strategy_run_bars
UNION ALL SELECT 'simsession|'||count(*) FROM public.simsession
UNION ALL SELECT 'simsession_result|'||count(*) FROM public.simsession_result
UNION ALL SELECT 'simsession_state|'||count(*) FROM public.simsession_state
UNION ALL SELECT 'sim_trades|'||count(*) FROM public.sim_trades
UNION ALL SELECT 'sim_positions|'||count(*) FROM public.sim_positions;
