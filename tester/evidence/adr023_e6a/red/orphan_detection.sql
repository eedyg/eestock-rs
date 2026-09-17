-- ADR-023 P1-2 孤儿检测「规范 SQL」（R2 契约草案：实现必须以可复用常量/函数提供同一份）
-- 口径：对 10 张 cagg 表逐表统计「code 不在 symbols 里」的行数（并集计数 = 各表之和）。
-- 契约列名：table_name text, orphan_rows bigint（10 行，顺序固定）。
SELECT 'kline_accurate_5m'  AS table_name, count(*) AS orphan_rows FROM kline_accurate_5m  c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_accurate_15m', count(*) FROM kline_accurate_15m c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_accurate_30m', count(*) FROM kline_accurate_30m c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_accurate_1h',  count(*) FROM kline_accurate_1h  c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_accurate_1d',  count(*) FROM kline_accurate_1d  c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_accurate_1w',  count(*) FROM kline_accurate_1w  c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_accurate_1mo', count(*) FROM kline_accurate_1mo c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_5m',  count(*) FROM kline_5m  c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_15m', count(*) FROM kline_15m c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
UNION ALL SELECT 'kline_1d',  count(*) FROM kline_1d  c WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)
