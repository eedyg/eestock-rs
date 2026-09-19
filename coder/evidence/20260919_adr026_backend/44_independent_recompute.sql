-- ADR-026 §5 A3/A4/A5：**独立重算**（不经过应用代码，直接对活库已落库事实源做 SQL 聚合；
-- 与端点响应逐字段对照）。只读 SELECT（活库）。
-- A3：sr_1789738328788_000005（chunked：per_bar/fills 分块）
with pb as (select (elem->>'warmup')::bool as warmup, ord-1 as bar_index, elem
              from strategy_run_bars, jsonb_array_elements(payload) with ordinality as t(elem, ord)
             where run_id='sr_1789738328788_000005' and kind='per_bar'),
     o  as (select warmup, bar_index, (o2->>'side') as side
              from pb, jsonb_array_elements(elem->'orders') as o2),
     f  as (select (elem->>'side') as side, (elem->>'qty')::float as qty, (elem->>'price')::float as price,
                   (elem->>'reason') as reason, (elem->>'bar_index')::int as bi
              from strategy_run_bars, jsonb_array_elements(payload) as elem
             where run_id='sr_1789738328788_000005' and kind='fills')
select 'A3 buy_intents' as metric, (select count(*) from o where warmup=false and side='Buy')::text as value
union all select 'A3 buy_fills', (select count(*) from f where side='Buy')::text
union all select 'A3 unexecuted', ((select count(*) from o where warmup=false and side='Buy')
                                 - (select count(*) from f where side='Buy'))::text
union all select 'A3 last_bar_has_buy', (select count(*) from o where warmup=false and side='Buy'
                                          and bar_index=(select max(bar_index) from pb where warmup=false))::text
union all select 'A3 deployed_notional', (select sum(qty*price) from f where side='Buy')::text
union all select 'A3 buy_commission(sum max(notional*rate,min))',
       (select sum(greatest(qty*price*0.025/100, 5.0)) from f where side='Buy')::text
union all select 'A3 cash_consumed',
       ((select sum(qty*price) from f where side='Buy') + (select sum(greatest(qty*price*0.025/100, 5.0)) from f where side='Buy'))::text
union all select 'A3 trades_len', (select jsonb_array_length(trades) from strategy_run_result
                                    where run_id='sr_1789738328788_000005')::text
union all select 'A3 forceclose_bar', (select max(bi) from f where side='Sell' and reason='ForceClose')::text
union all select 'A3 trade_close_bars', (select string_agg(distinct (e->>'close_bar'), ',')
                                           from strategy_run_result, jsonb_array_elements(trades) as e
                                          where run_id='sr_1789738328788_000005')
union all select 'A3 config.policy', (select config->>'policy' from strategy_run where id='sr_1789738328788_000005')
union all select 'A3 config.initial_capital', (select config->>'initial_capital' from strategy_run where id='sr_1789738328788_000005');
