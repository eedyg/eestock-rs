-- ~/~ begin <<design/04-storage/schema.md#migrations/0018_sim_session.sql>>[init]
-- 0018_sim_session.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 11-sim-live / L1：模拟实盘会话存储（ADR 11-sim-live §9）。
-- simsession = 会话元数据；simsession_result = 结束结果（3 jsonb 列）；
-- sim_trades = 会话内成交明细；sim_positions = 会话内持仓状态（可重建）。
-- 应用面自有表（数据面不读写，ADR-017 不违）。
CREATE TABLE simsession (
    id           text PRIMARY KEY,                     -- 应用层生成会话 id（s_<ts>_<seq>）
    name         text NOT NULL,
    cash_init    float8 NOT NULL,                      -- 初始资金（默认 1_000_000 可配，ADR §5）
    strategy_set jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 策略集（何时/哪些策略 trading on|off）
    stock_set    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 标的集
    period       text NOT NULL,                        -- M1/M5/M15/D1（回测支持周期）
    start_ts     timestamptz NOT NULL,
    end_ts       timestamptz,                          -- ended 时刻
    status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ended')),
    source       text NOT NULL DEFAULT 'manual'        -- mcp/web/preset/manual
);

CREATE TABLE simsession_result (
    session_id    text PRIMARY KEY REFERENCES simsession(id) ON DELETE CASCADE,
    net_value_json jsonb NOT NULL,
    trades_json    jsonb NOT NULL,
    metrics_json   jsonb NOT NULL
);

CREATE TABLE sim_trades (
    id         bigserial PRIMARY KEY,
    session_id text NOT NULL REFERENCES simsession(id) ON DELETE CASCADE,
    code       text NOT NULL,
    side       text NOT NULL CHECK (side IN ('buy','sell')),
    qty        float8 NOT NULL,
    price      float8 NOT NULL,
    ts         timestamptz NOT NULL,
    fee        float8 NOT NULL,
    source     text NOT NULL                            -- strategy/manual
);

CREATE TABLE sim_positions (
    session_id text NOT NULL REFERENCES simsession(id) ON DELETE CASCADE,
    code       text NOT NULL,
    qty        float8 NOT NULL,
    avg_cost   float8 NOT NULL,
    PRIMARY KEY (session_id, code)
);

-- 查询：会话直查（主键）+ 成交按会话检索 + 持仓按会话检索
CREATE INDEX sim_trades_session_idx     ON sim_trades (session_id, ts);
CREATE INDEX sim_positions_session_idx  ON sim_positions (session_id);
-- ~/~ end
