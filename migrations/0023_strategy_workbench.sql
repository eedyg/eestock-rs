-- ~/~ begin <<design/04-storage/schema.md#migrations/0023_strategy_workbench.sql>>[init]
-- 0023_strategy_workbench.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 12-strategy-system / P3a：回测工作台（ADR 12-strategy-system §13.4 数据粒度 / §13.5 组合预设）。
-- strategy_run = 任务制 ensemble 运行（config 完整快照钉住 (strategy_id, version, sha256)，复现前提）；
-- strategy_run_result = 结果（per_bar 全量五 jsonb 列，FK 级联）；strategy_preset = 组合预设（name UNIQUE）。
-- 应用面自有表（数据面不读写，ADR-017 不违）。
CREATE TABLE strategy_run (
    id          text PRIMARY KEY,                       -- 应用层生成（sr_<ts>_<seq>）
    name        text NOT NULL DEFAULT '',
    symbol      text NOT NULL,
    period      text NOT NULL,                          -- M1/M5/M15/D1
    from_ts     timestamptz NOT NULL,                   -- 区间起点（闭）
    to_ts       timestamptz NOT NULL,                   -- 区间终点（开，[from, to) 半开）
    config      jsonb NOT NULL,                         -- 完整快照：slots+thresholds+policy+stop+initial_capital+fee
    status      text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','succeeded','failed','canceled')),
    progress    float8 NOT NULL DEFAULT 0,              -- 0..1
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    started_at  timestamptz,
    finished_at timestamptz
);

CREATE TABLE strategy_run_result (
    run_id    text PRIMARY KEY REFERENCES strategy_run(id) ON DELETE CASCADE,
    per_bar   jsonb NOT NULL,   -- 各策略分+聚合分+信号+订单+事件全量（ADR §13.4）
    trades    jsonb NOT NULL,   -- 成交明细
    net_value jsonb NOT NULL,   -- 净值序列 [(ts, equity)]
    drawdown  jsonb NOT NULL,   -- 回撤序列 [(ts, dd)]
    metrics   jsonb NOT NULL    -- 8 项绩效指标
);

CREATE TABLE strategy_preset (
    id         text PRIMARY KEY,                        -- 应用层生成（sp_<ts>_<seq>）
    name       text NOT NULL UNIQUE,
    config     jsonb NOT NULL,                          -- 同 strategy_run.config 形状（ADR §13.5）
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 查询：状态过滤列表（created_at DESC）+ 标的维度检索
CREATE INDEX strategy_run_status_created_idx ON strategy_run (status, created_at DESC);
CREATE INDEX strategy_run_symbol_idx         ON strategy_run (symbol);
-- ~/~ end
