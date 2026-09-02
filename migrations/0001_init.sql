-- ~/~ begin <<design/04-storage/schema.md#migrations/0001_init.sql>>[init]
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
-- ~/~ end
