-- 假绿探针（临时库内构造，不动活库）：
-- (1) chunked_v1 有 per_bar 块但**无 fills 块**（P6 之前的形态）——事实源缺 fills
-- (2) run 存在但**无结果行**
-- (3) 未知 run（不插入，直接打端点）
\pset pager off
INSERT INTO strategy_run(id,name,symbol,period,from_ts,to_ts,config,status,progress,created_at,started_at,finished_at)
SELECT 'sr_verify_nofills_000001','verify_nofills','518880','D1',from_ts,to_ts,config,'succeeded',1,now(),now(),now()
FROM strategy_run WHERE id='sr_1789738328788_000005';

INSERT INTO strategy_run_result(run_id,per_bar,trades,net_value,drawdown,metrics,result_format)
VALUES ('sr_verify_nofills_000001','[]','[]','[]','[]','{}','chunked_v1');

-- 复制目标 run 的 per_bar 块（含 orders/events），**不**复制 fills 块
INSERT INTO strategy_run_bars(run_id,kind,seq,ts_from,ts_to,payload)
SELECT 'sr_verify_nofills_000001',kind,seq,ts_from,ts_to,payload
FROM strategy_run_bars WHERE run_id='sr_1789738328788_000005' AND kind='per_bar';

INSERT INTO strategy_run(id,name,symbol,period,from_ts,to_ts,config,status,progress,created_at)
SELECT 'sr_verify_noresult_000002','verify_noresult','518880','D1',from_ts,to_ts,config,'running',0,now()
FROM strategy_run WHERE id='sr_1789738328788_000005';

SELECT id, (select count(*) from strategy_run_bars b where b.run_id=r.id and b.kind='per_bar') pb,
            (select count(*) from strategy_run_bars b where b.run_id=r.id and b.kind='fills') fb,
            (select count(*) from strategy_run_result s where s.run_id=r.id) res
FROM strategy_run r WHERE id LIKE 'sr_verify_%';
