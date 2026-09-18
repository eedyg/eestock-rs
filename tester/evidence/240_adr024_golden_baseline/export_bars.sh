#!/usr/bin/env bash
# ADR-024 P1 golden 基线：从**活库**导出输入 bar 序列（一次性固化；固化后 harness 不依赖 DB）。
# 数据源（与生产读源同义；高点周期用 accurate cagg 单层，生产另叠 fallback 兜底——见 README 口径说明）：
#   M1  → kline_merged（= kline_accurate，M1，生产 M1_RANGE_SQL 读源）
#   M5  → kline_accurate_5m / M15 → kline_accurate_15m / H1 → kline_accurate_1h / D1 → kline_accurate_1d
# 用法：bash export_bars.sh <case_id> <view> <code> <n>
set -euo pipefail
case_id=$1; view=$2; code=$3; n=$4
dir="$(dirname "$0")/$case_id"
mkdir -p "$dir"
docker exec eestock-timescaledb psql -U eestock -d eestock -A -t -c "
SELECT json_build_object('ts', extract(epoch from ts)::bigint, 'open', open, 'high', high,
                         'low', low, 'close', close, 'volume', volume::float8)
FROM (SELECT ts,open,high,low,close,volume FROM $view
      WHERE code='$code' ORDER BY ts DESC LIMIT $n) t
ORDER BY ts;" > "$dir/bars.jsonl"
echo "[export] $case_id <- $view code=$code n=$n 落盘 $(wc -l < "$dir/bars.jsonl") 行"
