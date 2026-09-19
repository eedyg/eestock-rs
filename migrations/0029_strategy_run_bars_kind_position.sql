-- ~/~ begin <<design/04-storage/schema.md#migrations/0029_strategy_run_bars_kind_position.sql>>[init]
-- 0029_strategy_run_bars_kind_position.sql —— 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ADR-027 D9 / §4.1（2026-09-20）：结果分块增 kind='position'（持仓比率序列，与 net_value 同点；
-- 口径见 design/17-trade-detail-layering/02-spec.md §4.1/§4.2）。
-- 背景：0027 的 CHECK 冻结为四值（per_bar/net_value/drawdown/fills），而 P3 起所有分块 run 都写
-- position 块 ⇒ 新回测 run 一律 check 约束违规、status=failed（既有功能回归）。本迁移为修复件。
-- 幂等：DROP CONSTRAINT IF EXISTS + 同名 ADD CONSTRAINT（重跑等价；约量：无行改写、无列变更）。
-- 应用：psql -v ON_ERROR_STOP=1 -f migrations/0029_strategy_run_bars_kind_position.sql

ALTER TABLE strategy_run_bars
    DROP CONSTRAINT IF EXISTS strategy_run_bars_kind_check;

ALTER TABLE strategy_run_bars
    ADD CONSTRAINT strategy_run_bars_kind_check
    CHECK (kind IN ('per_bar','net_value','drawdown','fills','position'));
-- ~/~ end
