-- ~/~ begin <<design/04-storage/schema.md#migrations/0004_metrics.sql>>[init]
-- 0004_metrics.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ADR-014 自定义指标框架（Wave 2 落地，DDL 先行）
CREATE TABLE metrics (
    code     text        NOT NULL,
    period   text        NOT NULL,          -- M1/M5/M15/H1/D1
    ts       timestamptz NOT NULL,
    metric   text        NOT NULL,          -- MA20 / MACD_DIF / ATR14 / CHIP_PROFIT_RATIO ...
    value    double precision NOT NULL,
    PRIMARY KEY (code, period, ts, metric)
);
SELECT create_hypertable('metrics', 'ts');
ALTER TABLE metrics SET (timescaledb.compress,
    timescaledb.compress_segmentby = 'code,metric',
    timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- 筹码完整分布（ADR-011/014）：日级，价位→筹码占比
CREATE TABLE chip_distribution (
    code   text        NOT NULL,
    date   date        NOT NULL,
    price  double precision NOT NULL,
    pct    double precision NOT NULL,        -- 该价位筹码占比 0-1
    PRIMARY KEY (code, date, price)
);

-- 流通股本/ETF 份额参考表（换手率输入，低频更新）
CREATE TABLE share_float (
    code       text PRIMARY KEY,
    float_shares bigint NOT NULL,            -- 股
    as_of      date NOT NULL,
    source     text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- ~/~ end
