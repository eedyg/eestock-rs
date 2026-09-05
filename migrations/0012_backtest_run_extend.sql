-- ~/~ begin <<design/04-storage/schema.md#migrations/0012_backtest_run_extend.sql>>[init]
-- 0012_backtest_run_extend.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- Wave 3 Phase 3b（B1）：回测存储扩展——持久化初始资金与回测区间（ADR 08-backtest §7）。
-- backtest_runs 增列：initial_capital（初始资金）/ date_from（区间起点，闭）/ date_to（区间终点，开）。
-- from/to 为半开区间 [from, to)：date_from = from，date_to = to（排除端点；展示口径由前端处理）。
-- backtest_results 不动；run 删除级联已由 FK ON DELETE CASCADE 处理（见 0011）。
ALTER TABLE backtest_runs
    ADD COLUMN initial_capital float8 NOT NULL DEFAULT 100000,
    ADD COLUMN date_from timestamptz,
    ADD COLUMN date_to timestamptz;

-- 既有行回填：旧行（Phase 3b 前）未存 from/to/initial_capital，无法精确重建区间（040 报告残留风险 #1）。
-- 用 created_at 作 best-effort 占位（date_from = date_to = created_at），随后 SET NOT NULL，保证既有数据也能通过迁移。
-- 全新容器（docker-entrypoint-initdb.d 按序跑 0011→0012）时表为空，无回填实体。
UPDATE backtest_runs
   SET date_from = created_at,
       date_to   = created_at
 WHERE date_from IS NULL;

ALTER TABLE backtest_runs ALTER COLUMN date_from SET NOT NULL;
ALTER TABLE backtest_runs ALTER COLUMN date_to SET NOT NULL;
-- ~/~ end
