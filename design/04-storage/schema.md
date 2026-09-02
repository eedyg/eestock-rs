# 04 — 存储设计（TimescaleDB）

> 本文档 tangle 生成 `migrations/0001_init.sql`。DDL 变更必须改本文档并递增迁移编号。
> 原则：hypertable + 压缩（ADR-002）+ 连续聚合（ADR-004）+ 双真值层（ADR-003）。

## 4.1 核心表

``` {.sql file=migrations/0001_init.sql}
-- 0001_init.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 自抓层：采集服务唯一写入方（逻辑单写者，KISS）
CREATE TABLE kline_raw (
    code        text        NOT NULL,
    ts          timestamptz NOT NULL,          -- bar 起始时刻（分钟边界对齐）
    open        double precision NOT NULL,
    high        double precision NOT NULL,
    low         double precision NOT NULL,
    close       double precision NOT NULL,
    volume      bigint      NOT NULL,          -- 股
    amount      double precision NOT NULL,     -- 元
    source      text        NOT NULL,          -- SourceId
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (code, ts)
);
SELECT create_hypertable('kline_raw', 'ts');
-- 首写胜出：由写入方使用 INSERT ... ON CONFLICT (code,ts) DO NOTHING 实现（ADR-002）。
-- ⚠️ 审查修正：hypertable 不支持表规则（RULE 不会传播到 chunk），禁止用 RULE 防重。

-- 准确层：tushare 同步任务写入（Wave 2）。粒度以 tushare 账户档位为准（ADR-003 开放点）
-- ADR-016：多粒度（D1 保底，M1 档位已验证），period 入主键
CREATE TABLE kline_accurate (
    code        text        NOT NULL,
    ts          timestamptz NOT NULL,
    period      text        NOT NULL,          -- M1/M5/M15/H1/D1
    open        double precision NOT NULL,
    high        double precision NOT NULL,
    low         double precision NOT NULL,
    close       double precision NOT NULL,
    volume      bigint      NOT NULL,
    amount      double precision NOT NULL,
    source      text        NOT NULL DEFAULT 'tushare',
    synced_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (code, ts, period)
);
SELECT create_hypertable('kline_accurate', 'ts');

-- 合并视图：准确层优先（ADR-003，与 domain merge.rs 纯函数语义一致，契约测试锁定）
-- ⚠️ ADR-016：仅合并 accurate 的 M1 部分（raw 恒为 M1）；日级 accurate 由消费方直查
CREATE OR REPLACE VIEW kline_merged AS
SELECT code, ts, open, high, low, close, volume, amount, source, synced_at FROM kline_accurate WHERE period = 'M1'
UNION ALL
SELECT code, ts, open, high, low, close, volume, amount, source, ingested_at AS synced_at
FROM kline_raw r
WHERE NOT EXISTS (SELECT 1 FROM kline_accurate a WHERE a.code = r.code AND a.ts = r.ts AND a.period = 'M1');

-- 标注册表（手工注册，ADR：不跟随券商持仓）
CREATE TABLE symbols (
    code          text PRIMARY KEY,
    name          text,
    interval_secs integer NOT NULL DEFAULT 60 CHECK (interval_secs >= 60),
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- 源健康事件（诊断系统数据源，05-diagnose 消费）
CREATE TABLE source_health_events (
    ts         timestamptz NOT NULL DEFAULT now(),
    source     text NOT NULL,
    ok         boolean NOT NULL,
    latency_ms integer,
    err_kind   text,
    code       text              -- 触发标的（心跳事件为空）
);
SELECT create_hypertable('source_health_events', 'ts');
```

## 4.2 连续聚合（ADR-004）

``` {.sql file=migrations/0002_caggs.sql}
-- 0002_caggs.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 高周期全部从 kline_raw 聚合；准确层粒度 ≥1m 时同样语义适用
CREATE MATERIALIZED VIEW kline_5m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('5 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_raw GROUP BY code, time_bucket('5 minutes', ts);

CREATE MATERIALIZED VIEW kline_15m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('15 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_raw GROUP BY code, time_bucket('15 minutes', ts);

CREATE MATERIALIZED VIEW kline_1d
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 day', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_raw GROUP BY code, time_bucket('1 day', ts, 'Asia/Shanghai');
-- 筹码分布的日线输入即 kline_1d（ADR-011）
-- ⚠️ 审查修正：日界必须按交易所时区对齐（time_bucket 三参形式），否则跨日 bar 错分

-- ⚠️ 审查修正：cagg 必须配刷新策略，否则是不更新的死视图
SELECT add_continuous_aggregate_policy('kline_5m',
    start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_15m',
    start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_1d',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
```

## 4.3 压缩与保留策略

``` {.sql file=migrations/0003_compression.sql}
-- 0003_compression.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
ALTER TABLE kline_raw SET (timescaledb.compress,
    timescaledb.compress_segmentby = 'code',
    timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('kline_raw', INTERVAL '7 days');

ALTER TABLE source_health_events SET (timescaledb.compress,
    timescaledb.compress_segmentby = 'source',
    timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('source_health_events', INTERVAL '7 days');
-- 健康事件保留 90 天；K线不删除（ADR-004：1m 历史靠累积）
SELECT add_retention_policy('source_health_events', INTERVAL '90 days');
```

``` {.sql file=migrations/0004_metrics.sql}
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
```

## 4.4 设计注记

1. 采集服务是 `kline_raw` 的**逻辑单写者**（批量去重/源状态机收敛一处）；tushare 同步任务只写 `kline_accurate`，两写者物理零冲突（ADR-002/003）
2. 缺口判定：某 code 当日交易分钟内 `kline_raw` 缺失的 ts 集合（交易日历 × 分钟序列 LEFT JOIN）
3. `kline_1d` + 流通股本/份额参考表 `share_float`（0004 已建）= 换手率 → 筹码输入（ADR-011/014）
4. metrics 框架（ADR-014）：Wave 1 看板指标由 klinecharts 前端内置渲染；服务端 metrics 表 Wave 2 启用，同名指标口径以服务端为准（契约测试锁定）
