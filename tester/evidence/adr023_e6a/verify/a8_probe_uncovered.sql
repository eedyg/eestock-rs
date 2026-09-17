SELECT 'kline_accurate_5m' AS table_name, count(*) AS orphan_rows FROM kline_accurate_5m
  WHERE code NOT IN (SELECT code FROM symbols)
