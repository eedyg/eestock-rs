-- 反硬编码探针（临时库内）：目标 run 的副本，把每笔 Buy 成交 qty 减半 ⇒ 端点 deployed 必须随之变
\pset pager off
INSERT INTO strategy_run(id,name,symbol,period,from_ts,to_ts,config,status,progress,created_at,started_at,finished_at)
SELECT 'sr_verify_mut_000003',name||'_mut',symbol,period,from_ts,to_ts,config,'succeeded',1,now(),now(),now()
FROM strategy_run WHERE id='sr_1789738328788_000005';

INSERT INTO strategy_run_result(run_id,per_bar,trades,net_value,drawdown,metrics,result_format)
SELECT 'sr_verify_mut_000003',per_bar,trades,net_value,drawdown,metrics,result_format
FROM strategy_run_result WHERE run_id='sr_1789738328788_000005';

INSERT INTO strategy_run_bars(run_id,kind,seq,ts_from,ts_to,payload)
SELECT 'sr_verify_mut_000003',kind,seq,ts_from,ts_to,
       CASE WHEN kind='fills' THEN
         (SELECT jsonb_agg(CASE WHEN e->>'side'='Buy'
                                THEN jsonb_set(e,'{qty}', to_jsonb((e->>'qty')::float8*0.5))
                                ELSE e END)
          FROM jsonb_array_elements(payload) e)
       ELSE payload END
FROM strategy_run_bars WHERE run_id='sr_1789738328788_000005';

SELECT run_id, kind, jsonb_array_length(payload) FROM strategy_run_bars WHERE run_id='sr_verify_mut_000003' ORDER BY kind;
