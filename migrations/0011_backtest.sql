-- ~/~ begin <<design/04-storage/schema.md#migrations/0011_backtest.sql>>[init]
-- 0011_backtest.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- Wave 3 Phase 3a：回测任务（运行）+ 结果存储（ADR 08-backtest §7）。
-- backtest_runs = 任务状态（pending/running/done/failed + progress 0-100 + current_ts）；
-- backtest_results = 完成结果的 3 个 jsonb 列（run_id 1:1，run_id PK）。
CREATE TABLE backtest_runs (
    id          bigserial PRIMARY KEY,
    code        text NOT NULL,
    period      text NOT NULL,                      -- M1/M5/M15/D1（回测支持周期）
    strategy_id text NOT NULL,                      -- builtin 策略 slug
    params_json jsonb NOT NULL DEFAULT '{}'::jsonb, -- 策略参数（网格展开后单点）
    fee_json    jsonb NOT NULL DEFAULT '{}'::jsonb, -- {rate_pct,min_fee,slippage_bp}
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
    progress    integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    current_ts  timestamptz,                        -- 当前回测 bar 时刻（进度展示）
    created_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,                        -- done/failed 时刻
    error       text,                               -- failed 错误信息
    group_id    text                                -- 任务组（grid 展开）
);

CREATE TABLE backtest_results (
    run_id         bigint PRIMARY KEY REFERENCES backtest_runs(id) ON DELETE CASCADE,
    net_value_json jsonb NOT NULL,
    trades_json    jsonb NOT NULL,
    metrics_json   jsonb NOT NULL
);

-- 查询：状态筛选 / 任务组聚合 / 结果 join（run_id PK 隐式索引；另列满足契约索引清单）
CREATE INDEX backtest_runs_status_idx     ON backtest_runs (status);
CREATE INDEX backtest_runs_group_idx      ON backtest_runs (group_id);
CREATE INDEX backtest_results_run_id_idx  ON backtest_results (run_id);
-- ~/~ end
