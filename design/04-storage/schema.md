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
-- settlement：T+0/T+1 交收规则（用户裁决 2026-09-03 必须区分；影响策略/回测撮合规则）
-- 分类规则：跨境(QDII)/债券/商品(黄金等)/货币 ETF → T0；沪深股票型 ETF → T1；
-- 规则仅作默认，最终逐只人工确认（symbols 管理页可改）
CREATE TABLE symbols (
    code          text PRIMARY KEY,
    name          text,
    interval_secs integer NOT NULL DEFAULT 60 CHECK (interval_secs >= 60),
    settlement    text NOT NULL DEFAULT 'T1' CHECK (settlement IN ('T0','T1')),
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
SELECT code, time_bucket('1 day', ts, 'Asia/Shanghai') AS ts,
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
-- ⚠️ 语法修正（2026-09-03）：TimescaleDB 2.18+ 启用 columnstore 新 API；
-- 旧 timescaledb.compress 在 2.29 静默失效（本次实锤踩坑，证据见设计注记 5）
ALTER TABLE kline_raw SET (timescaledb.enable_columnstore,
    timescaledb.segmentby = 'code',
    timescaledb.orderby = 'ts DESC');
SELECT add_compression_policy('kline_raw', INTERVAL '7 days');

ALTER TABLE source_health_events SET (timescaledb.enable_columnstore,
    timescaledb.segmentby = 'source',
    timescaledb.orderby = 'ts DESC');
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
ALTER TABLE metrics SET (timescaledb.enable_columnstore,
    timescaledb.segmentby = 'code,metric',
    timescaledb.orderby = 'ts DESC');
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

``` {.sql file=migrations/0006_accurate_compression.sql}
-- 0006_accurate_compression.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 审查修正（2026-09-03）：0003 漏了 kline_accurate 的压缩（当时 16M 行 3GB 未压缩）
ALTER TABLE kline_accurate SET (timescaledb.enable_columnstore,
    timescaledb.segmentby = 'code,period',
    timescaledb.orderby = 'ts DESC');
SELECT add_compression_policy('kline_accurate', INTERVAL '7 days');
-- 存量压缩（首次部署时手动执行一次，之后策略自动接管）：
-- SELECT count(compress_chunk(x)) FROM show_chunks('kline_accurate', older_than => INTERVAL '7 days') x;
```

## 4.3.1 DB 控制通道表（Wave 1 Phase C，ADR-017）

应用面与数据面零 API 直连（ADR-017）：`POST /api/sources/{id}/reset` 手动熔断复位经
本表传递——应用面插入请求行，数据面 `collector::reset::ResetWatcher` 轮询、原子标记消费，
再经 `CircuitRegistry.manual_reset` 复位（`manual_reset` 事件仍由数据面单写者发出，
source_health_events 写路径不变）。非 hypertable（控制面小表，无压缩/分区需求）。

``` {.sql file=migrations/0007_circuit_reset.sql}
-- 0007_circuit_reset.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- Wave 1 Phase C：熔断复位 DB 控制通道（ADR-017：应用面唯一耦合点 = DB）。
-- 应用面 POST /api/sources/{id}/reset 插入；数据面 ResetWatcher 轮询消费（consumed_at 标记）。
CREATE TABLE circuit_reset_requests (
    id           bigserial PRIMARY KEY,
    source       text NOT NULL,            -- SourceId::as_str 口径文本
    requested_at timestamptz NOT NULL DEFAULT now(),
    consumed_at  timestamptz               -- NULL = 待消费
);
-- 消费端轮询（consumed_at IS NULL）部分索引，避免全表扫描
CREATE INDEX circuit_reset_pending_idx ON circuit_reset_requests (id) WHERE consumed_at IS NULL;
```

## 4.3.2 交易日历节假日表（Wave 2 Phase A，0008）

交易所休市日（周末由日历工作日判定天然排除，本表只列**法定节假日休市**日期，含区间内周末仅作完整记录）。
collector 调度/缺口回填与 diagnose 质量缺口报告共用同一口径：非交易日（周末 ∪ holidays）
不采集、不计缺口（design/03-collector §9.3 / design/07-app-plane §2 质量服务）。
年度导入：先以迁移内嵌官方口径数据；后续年度可经 tushare `trade_cal` 接口复核/导入（评估结论见 wave-2.md §3——
2026 数据量小且官方通知先行，迁移内嵌足够；trade_cal 留作跨年复核手段）。

``` {.sql file=migrations/0008_holidays.sql}
-- 0008_holidays.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- Wave 2 Phase A：交易日历节假日表（A 股休市日；周末由工作日判定排除，不入表）。
-- 数据来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（2025-11 发布）
--   + 沪深交易所 2026 年休市安排（交易所休市 = 法定节假日区间，周末不调休开市）。
-- 复核手段：tushare trade_cal 接口（is_open=0 日期应 ⊇ 本表；跨年导入同口径）。
CREATE TABLE holidays (
    date   date PRIMARY KEY,
    name   text NOT NULL              -- 节假日名（元旦/春节/清明/劳动节/端午/中秋/国庆）
);

-- 2026 年法定节假日休市日期（区间内逐日记录，周末日仅作完整性记录，判定时不产生效果）：
--   元旦 1/1-1/3；春节 2/15-2/23；清明 4/4-4/6；劳动节 5/1-5/5；
--   端午 6/19-6/21；中秋 9/25-9/27；国庆 10/1-10/8。
INSERT INTO holidays (date, name) VALUES
    ('2026-01-01', '元旦'), ('2026-01-02', '元旦'), ('2026-01-03', '元旦'),
    ('2026-02-15', '春节'), ('2026-02-16', '春节'), ('2026-02-17', '春节'),
    ('2026-02-18', '春节'), ('2026-02-19', '春节'), ('2026-02-20', '春节'),
    ('2026-02-21', '春节'), ('2026-02-22', '春节'), ('2026-02-23', '春节'),
    ('2026-04-04', '清明'), ('2026-04-05', '清明'), ('2026-04-06', '清明'),
    ('2026-05-01', '劳动节'), ('2026-05-02', '劳动节'), ('2026-05-03', '劳动节'),
    ('2026-05-04', '劳动节'), ('2026-05-05', '劳动节'),
    ('2026-06-19', '端午'), ('2026-06-20', '端午'), ('2026-06-21', '端午'),
    ('2026-09-25', '中秋'), ('2026-09-26', '中秋'), ('2026-09-27', '中秋'),
    ('2026-10-01', '国庆'), ('2026-10-02', '国庆'), ('2026-10-03', '国庆'),
    ('2026-10-04', '国庆'), ('2026-10-05', '国庆'), ('2026-10-06', '国庆'),
    ('2026-10-07', '国庆'), ('2026-10-08', '国庆');
```

## 4.3.3 告警引擎表（Wave 2 Phase B，页面⑦）

`alert_rules` / `alert_events` 为**应用面自有表**（与 circuit_reset_requests 同口径：数据面不读写，
不违 ADR-017 只读库铁律）。规则表种子即内置规则首批（wave-2.md §2）；阈值/开关/静默时长由
页面⑦ `PATCH /api/alert-rules` 调整，评估节拍每轮重读热生效（02-alerts.md §2 threshold 语义按 id 约定）。
告警事件按「同 rule+source 未恢复聚合为一条」（07-alerts §5 防刷屏），fire_count 累计触发次数。
（0008 预留给节假日表，见 wave-2.md §3。）

``` {.sql file=migrations/0009_alert_engine.sql}
-- 0009_alert_engine.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- Wave 2 Phase B：告警引擎（页面⑦ 告警中心）。应用面自有表（数据面不读写，ADR-017 不违）。
-- 生命周期状态机：triggered → acked → resolved（triggered → resolved 直转合法，条件消失自动恢复）。
CREATE TABLE alert_rules (
    id               text PRIMARY KEY,          -- 内置规则 slug（无自由规则编辑器，07-alerts §3）
    name             text NOT NULL,
    level            text NOT NULL CHECK (level IN ('info','warning','critical')),
    threshold        double precision NOT NULL, -- 语义按 id：成功率下限(0-1)/缺口率%/停摆分钟数/未用(0)
    duration_minutes integer NOT NULL DEFAULT 0,   -- 评估窗口/持续时长（分钟；0=瞬时判定）
    silence_minutes  integer NOT NULL DEFAULT 10 CHECK (silence_minutes >= 1),
    enabled          boolean NOT NULL DEFAULT true,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_events (
    id             bigserial PRIMARY KEY,
    rule_id        text NOT NULL REFERENCES alert_rules(id),
    level          text NOT NULL CHECK (level IN ('info','warning','critical')),
    source         text NOT NULL,           -- 来源：源ID / 标的 code / 系统组件（collector/tushare）
    message        text NOT NULL,
    status         text NOT NULL DEFAULT 'triggered' CHECK (status IN ('triggered','acked','resolved')),
    fire_count     integer NOT NULL DEFAULT 1,  -- 聚合防刷屏：同 rule+source 未恢复事件累计触发次数
    first_fired_at timestamptz NOT NULL DEFAULT now(),
    last_fired_at  timestamptz NOT NULL DEFAULT now(),
    acked_at       timestamptz,             -- 确认时刻（持久化，刷新不丢）
    resolved_at    timestamptz              -- NULL = 未恢复（开放事件）
);
-- 评估节拍高频查询：开放事件唯一聚合单元（同 rule+source 至多一条未恢复）
CREATE UNIQUE INDEX alert_events_open_uq ON alert_events (rule_id, source) WHERE resolved_at IS NULL;
-- 列表查询（last_fired_at 降序 + 过滤）
CREATE INDEX alert_events_list_idx ON alert_events (last_fired_at DESC);

-- 内置规则首批种子（wave-2.md §2；页面⑦ 仅阈值/开关/静默时长可调，热生效）
INSERT INTO alert_rules (id, name, level, threshold, duration_minutes, silence_minutes) VALUES
    ('source_success_rate', '源成功率低于阈值',     'warning',  0.95, 10, 10),
    ('symbol_gap_rate',     '标的当日缺口率超阈',   'warning',  1.0,  0,  30),
    ('collection_stall',    '采集停摆（交易时段无成功事件）', 'critical', 3, 0, 10),
    ('tushare_daily_sync',  'tushare 日增量失败',   'warning',  0,    0,  60);
```

## 4.3.4 统一读源 accurate 连续聚合（Wave 3，0010，用户定稿 2026-09-04）

背景：`reader.rs` 的 `1m` 走 `kline_merged`（准确层优先，深历史），但 `5m/15m/1d`
直查 raw-derived cagg（只 2 周）——「往前翻几天就没数据」。本迁移把 ADR-003
「accurate 优先 + 底层兜底」语义推广到所有周期：

- accurate 层：`kline_accurate` M1（2012→今，全量真值）聚合出 `kline_accurate_5m/15m/1h`；
  `kline_accurate_1d` **复用 0005 既有 cagg**（聚合全量 M1，日级桶化开销可忽略，不新增）；
  **各周期聚合/读取 DB 全部 accurate M1（2012→今），无人工时间截断；数据摄取量=可获取量**。
- 兜底层（reader 端 UNION ALL + NOT EXISTS 反连接）：`5m/15m/1d` 用 raw-derived `kline_5m/15m/1d`；
  `1h` 用 `kline_15m` 查询期 rollup；`1m` 用 `kline_raw`（现有 `kline_merged` 语义不变）。

⚠️ 0017（用户定稿 2026-09-07）：既有库 0010 建的 `kline_accurate_5m/15m/1h` 带 `WHERE ts >= '2024-01-01'`
（0010 定稿时的「2024 即可」口径）→ DROP 后重建为**全量**（无 2024 过滤，聚合全部 accurate M1），
与 0016 周/月同型（见 4.3.9）。**统一原则**：所有周期聚合/读取 DB 全部 accurate M1（2012→今），
无人工时间截断；数据摄取量=可获取量（供后续遵循）。

⚠️ 运维注记：cagg 刷新策略只覆盖近期窗口；**历史回填后须手动全量刷新一次**：
`CALL refresh_continuous_aggregate('kline_accurate_5m', NULL, NULL);`（15m/1h 同理，
D1 复用 0005 的 `kline_accurate_1d` 亦须全量刷新一次以物化深历史）。

``` {.sql file=migrations/0010_accurate_caggs.sql}
-- 0010_accurate_caggs.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 统一读源（用户定稿 2026-09-04）：kline_accurate M1（2012→今）为全历史真值；
-- 各周期聚合/读取 DB 全部 accurate M1（2012→今），无人工时间截断；数据摄取量=可获取量。
-- D1 accurate 复用 0005 既有 kline_accurate_1d（聚合全量 M1；日级桶化开销可忽略）。
CREATE MATERIALIZED VIEW kline_accurate_5m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('5 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('5 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_15m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('15 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('15 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_1h
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 hour', ts);

-- 刷新策略（近期窗口增量；历史回填后须手动全量 refresh 一次，见块头运维注记）
SELECT add_continuous_aggregate_policy('kline_accurate_5m',
    start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_15m',
    start_offset => INTERVAL '6 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_1h',
    start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
```

## 4.3.5 回测存储（Wave 3 Phase 3a，0011；ADR 08-backtest §7）

**上下文**：backtest engine crate（纯逻辑，无 IO/DB）已落（crates/backtest，commit 97fe314）。
本迁移补回测**数据/应用面**两张表：任务运行（backtest_runs）+ 完成结果（backtest_results）。
应用面 CRUD 经 `domain::ports::BacktestRunStore`（storage 实现，见下）。

**表口径**：run 状态机 pending/running/done/failed；progress 0-100（整数，进度经 WS 分发）；
current_ts = 当前回测 bar 时刻（进度展示）；result 只在 done 时写一次（中间结果不落库，ADR §7）。
`backtest_runs` / `backtest_results` 为**应用面自有表**（与 circuit_reset_requests/alert_events 同口径：
数据面、引擎回不读写，不违 ADR-017 只读库铁律）。

``` {.sql file=migrations/0011_backtest.sql}
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
```

``` {.sql file=migrations/0012_backtest_run_extend.sql}
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
```

**storage 模块 `crates/storage/src/backtest.rs`（非 tangle 手写，契约描述）**：
实现 `domain::ports::{BacktestBarRead, BacktestRunStore}`（PgPool）。
- `BacktestBarRead`：`bars(code, period, from, to)` 按统一读源（accurate 优先 + cagg 兜底，复用 KlineReader 口径，
  与 design/07-app-plane/00-web-api.md `merged_sql` 同语义）读 `[from, to)` 升序 `domain::Bar` 序列；
  M1 走 `kline_merged` 视图，5m/15m/1h/1d 走 period 对应 accurate/cagg 表 + 底层兜底反连接剔重（同 reader.rs）。
  兜底 cagg 行 source 缺 NULL → `domain::Bar.source` 以占位 `SourceId::parse().unwrap_or(Tushare)` 记（backtest 不消费 source）。
- `PgBacktestStore`：`backtest_runs/backtest_results` CRUD（create_run 回 id 并写 initial_capital/date_from/date_to 三列；
  update_run_progress 写 progress/current_ts；mark_done 事务内更新 status=done/finished_at + upsert result 3 列；
  mark_failed 置 failed/error；list_runs 按 status/group filter + limit/offset 分页（**轻量**：`RUNS_SELECT_LIGHT` 不联 backtest_results、不选结果 JSON 列、result=None；排序 created_at DESC, id DESC）；get_run 用 `RUNS_SELECT` 联表读全量结果；delete_run 删 run（级联删结果）返回是否删行。
  B1 增补（ADR-007 手写例外）：`NewRun`/`RunView` 增 `initial_capital/date_from/date_to`；`create_run` 落这三列；`delete_run(&self, id) -> Result<bool>`。
  性能修正（ADR-007 手写例外）：列表页不再联结果/全量返回——`RunFilter` 增 `limit/offset`（默认 100），`list_runs` 轻量分页，结果仅 `get_run` 读。

## 4.3.6 看板收藏（Wave 3 页面①，0013；用户定稿 2026-09-05）

**上下文**：看板收藏（置顶+排序）为应用面功能，仅影响 `/api/symbols` 的 symbol-list 展示。
一键收藏 = 自动置顶（`star` → sort_order=max+1）；收藏区可拖拽排序（`reorder` → sort_order=索引）。
`favorite_symbols` 为**应用面自有表**（与 circuit_reset_requests/alert_events/backtest 同口径：数据面不读写，
不违 ADR-017 只读库铁律）。code 为主外键 → `symbols(code)`（标的不存在则收藏无意义），ON DELETE CASCADE
（仅停用 symbols 不物理删除时不受影响；DBA 手工物理删除时级联清理收藏）。

``` {.sql file=migrations/0013_favorite_symbols.sql}
-- 0013_favorite_symbols.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- Wave 3 页面①：看板收藏（置顶+排序）。应用面自有表（数据面不读写，ADR-017 不违）。
-- code 须存在 symbols（FK）；一键收藏=自动置顶（sort_order=max+1）；拖拽排序=sort_order=索引。
CREATE TABLE favorite_symbols (
    code       text PRIMARY KEY REFERENCES symbols(code) ON DELETE CASCADE,
    sort_order integer NOT NULL
);
```

**storage 模块 `crates/storage/src/favorite.rs`（非 tangle 手写，契约描述）**：
实现 `domain::ports::FavoriteStore`（PgPool）。字段注：`sort_order` 起点 1（首个收藏=1）。
- `list_favorites`：全量收藏（code + sort_order，按 sort_order 升序）。
- `star`：INSERT ... SELECT COALESCE(MAX(sort_order),0)+1；已存在 → ON CONFLICT DO NOTHING（幂等 Ok）。
- `unstar`：DELETE（不存在 → rows_affected=0，仍 Ok）。
- `reorder`：批量 UPDATE sort_order = 索引（array_position 逐行）；入参须为已收藏 code（web 层校验 400）。
- `favorite_map`：`SELECT code, sort_order FROM favorite_symbols` → `HashMap<code, sort_order>`（/api/symbols 展示用）。

## 4.3.7 行情看板周/月线 + MA 配置（后端 W1，0014/0015；用户定稿 2026-09-06）

**上下文**：行情看板加周线/月线周期 + MA 可配置（主图+宫格应用，回测弹窗不动）。周期枚举
`domain::Period` 增 `W1`（周）/`MO1`（月）——仅看板读源扩展；**回测周期不扩**（`backtest::Period`
独立枚举）。周 = A股交易周（`time_bucket('1 week', ts, 'Asia/Shanghai')` 周一为界）；月 = 自然月
（`time_bucket('1 month', ts, 'Asia/Shanghai')` 月界）。

**周/月线 cagg（0014；0016 重建为全历史）**：`kline_accurate_1w/1mo` 从 `kline_accurate` M1 聚合（**全历史**，
不设 `ts >= '2024-01-01'` 过滤——周/月桶少，全量聚合 M1 2012+ 便宜（0010 的 5m/15m/1h 由 0017 同步全量）。
准确层优先 + 底层兜底（ADR-003 推广）：兜底在 reader.rs **查询期 rollup**（`kline_1d` → week/month 桶，与 1h 兜底
从 `kline_15m` rollup 同型）——schema 未建 raw-derived `kline_1w/1mo` cagg，按「复用 cagg 兜底语义」判断不新增，
表名/时机按 0010 既有模式。**0016**：既有库的 0014 已建（2024 过滤）→ DROP 后重建为全历史（同 refresh 策略）；
兜底 FALLBACK_1W/1MO 保留（accurate 缺时的安全网），全历史 cagg 后 pre-2024 也走 accurate。

``` {.sql file=migrations/0014_weekly_monthly_caggs.sql}
-- 0014_weekly_monthly_caggs.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 行情看板周线/月线（后端 W1）：kline_accurate M1 连续聚合出 kline_accurate_1w/1mo。
-- 周=A股交易周（time_bucket('1 week', ts, 'Asia/Shanghai') 周一为界）；月=自然月（month 界）。
-- 全历史（无 ts >= '2024-01-01' 过滤）：周/月桶少，全量聚合 M1 2012+ 便宜（0010 的 5m/15m/1h 由 0017 同步全量）。
-- 兜底在 reader.rs 查询期 rollup（kline_1d → week/month 桶），见 00-web-api §3。
CREATE MATERIALIZED VIEW kline_accurate_1w
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 week', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 week', ts, 'Asia/Shanghai');

CREATE MATERIALIZED VIEW kline_accurate_1mo
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 month', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 month', ts, 'Asia/Shanghai');

-- 刷新策略（周/月桶变化不频繁，schedule 放宽；历史回填后须手动全量 refresh 一次）
-- ⚠️ TimescaleDB 校验：refresh 窗口（start_offset = end_offset）须覆盖 ≥ 两个桶，否则报
-- "policy refresh window too small"（周桶=7d、月桶≈30d）；故周用 30d/1d、月用 120d/1d。
SELECT add_continuous_aggregate_policy('kline_accurate_1w',
    start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('kline_accurate_1mo',
    start_offset => INTERVAL '120 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
```

**MA 配置持久化（0015）**：`ma_config` 单行（id 恒 1）存 `ma_windows int[]`（默认 [5,10,20]）。
应用面自有表（数据面不读写，ADR-017 不违）。归一化（升序去重）在 web/dto 层；本表只持久化归一化结果。

``` {.sql file=migrations/0015_ma_config.sql}
-- 0015_ma_config.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 行情看板 MA 可配置（后端 W1）：ma_config 单行存 ma_windows int[]（默认 [5,10,20]）。
-- 应用面自有表（数据面不读写，ADR-017 不违）。id 恒 1（单行），CHECK 保证。
-- 归一化（升序去重）在 web/dto 层；本表只持久化归一化结果。
CREATE TABLE ma_config (
    id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    ma_windows integer[] NOT NULL DEFAULT ARRAY[5,10,20],
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ma_config (id, ma_windows) VALUES (1, ARRAY[5,10,20]) ON CONFLICT (id) DO NOTHING;
```

**storage 模块 `crates/storage/src/ma_config.rs`（非 tangle 手写，契约描述）**：
实现 `domain::ports::MaConfigStore`（PgPool）。
- `get`：`SELECT ma_windows FROM ma_config WHERE id = 1`；表空/无行 → 默认 `[5,10,20]`（不抛错）。
- `set`：`INSERT ... ON CONFLICT (id) DO UPDATE SET ma_windows = EXCLUDED.ma_windows, updated_at = now()`，
  参数绑定 `&[i32]` 到 `int4[]` 列（sqlx 支持 Vec<i32>/&[i32] 数组映射）；写回后返回归一化窗口列表。

**页面⑧ 设置页 S2：配置持久化（0021）**：`app_config` 表（key text PK + value jsonb）。
存三块配置（sources / collector / mcp），value 为 jsonb；默认值 = 现 GET 返回的 SETTINGS_DEFAULTS
默认（内置源参数 / 60s / 交易工具关 / 50000·20 等），缺值由 web 层回退默认。应用面自有表
（数据面不读写，ADR-017 不违）。

``` {.sql file=migrations/0021_app_config.sql}
-- 0021_app_config.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 页面⑧ 系统设置 S2：配置持久化（app_config 表：key text PK + value jsonb）。
-- 存三块配置（sources / collector / mcp），value 为 jsonb；默认值 = 现 GET 返回的
-- SETTINGS_DEFAULTS 默认（内置源参数 / 60s / ma 等），缺值由 web 层回退默认，本表不强制种子。
-- 应用面自有表（数据面不读写，ADR-017 不违）。
CREATE TABLE app_config (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

**storage 模块 `crates/storage/src/config_store.rs`（非 tangle 手写，契约描述）**：
实现 `domain::ports::ConfigStore`（PgPool；app_config 表，迁移 0021）。
- `get`：`SELECT value FROM app_config WHERE key = $1`；表无该 key → `Ok(None)`（web 层回退默认）。
- `set`：`INSERT ... ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`；
  键名约定 `"sources" / "collector" / "mcp"`；跨 key 独立。

## 4.3.8 周/月线全历史重建（后端 W1，0016；用户定稿 2026-09-06）

**上下文**：既有库 0014 建的 `kline_accurate_1w/1mo` 带 `WHERE ts >= '2024-01-01'`（0010 同口径），
故 accurate cagg 只有 2024+ 的周/月桶；reader.rs 兜底 `FALLBACK_1W/1MO` 用 `kline_1d` 查询期 rollup，
但 `kline_1d` 仅近 2 周数据（无 pre-2024 行）→ 周/月线只能到 2024。

**修复（0016）**：DROP 既有 `kline_accurate_1w/1mo` → 重建为**全历史**（去掉 2024 过滤；周/月桶少，
全量聚合 M1 2012+ 便宜）+ **同样 refresh 策略**。这样周/月线覆盖全历史（2012+）且走 accurate cagg 快。
兜底 `FALLBACK_1W/1MO` 保留（accurate 缺时安全网）；全历史 cagg 后 pre-2024 也走 accurate。

``` {.sql file=migrations/0016_weekly_monthly_full_history.sql}
-- 0016_weekly_monthly_full_history.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 问题① 修复：周/月线全历史。既有库 0014 建的 kline_accurate_1w/1mo 带 ts >= '2024-01-01' 过滤
-- （仅 2024+），且 reader 兜底 kline_1d 只有近 2 周数据 → 周/月线只能到 2024。
-- 本迁移 DROP 后重建为全历史（无 2024 过滤；周/月桶少，全量聚合 M1 2012+ 便宜）+ 同样 refresh 策略。
-- 兜底 FALLBACK_1W/1MO（reader.rs 查询期 kline_1d rollup）保留作为 accurate 缺时的安全网。
DROP MATERIALIZED VIEW kline_accurate_1w;
DROP MATERIALIZED VIEW kline_accurate_1mo;

CREATE MATERIALIZED VIEW kline_accurate_1w
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 week', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 week', ts, 'Asia/Shanghai');

CREATE MATERIALIZED VIEW kline_accurate_1mo
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 month', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 month', ts, 'Asia/Shanghai');

-- 刷新策略（与 0014 同）：周用 30d/1d、月用 120d/1d（窗口须覆盖 ≥ 两桶）。
SELECT add_continuous_aggregate_policy('kline_accurate_1w',
    start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('kline_accurate_1mo',
    start_offset => INTERVAL '120 days', end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');
```

## 4.3.9 分钟线全历史重建（0017；用户定稿 2026-09-07）

**上下文**：0010 建的 `kline_accurate_5m/15m/1h` 带 `WHERE ts >= '2024-01-01'`（「2024 即可」口径，
不聚合 2012 前亿万级 M1）——5m/15m/1h accurate cagg 只有 2024+ 桶。而 1m（`kline_accurate` M1）、
1d（复用 0005）、周/月（0016 全历史）已全量，故分钟/日/周/月深翻在 2024 边界截断，与
「数据只到 2024」的人为截断同源。

**修复（0017）** 与 0016 周/月同型：DROP 既有 `kline_accurate_5m/15m/1h` → 重建为**全量**
（移除 `WHERE ts >= '2024-01-01'`，聚合 `kline_accurate` 全部 M1）+ **同样 refresh 策略**
（窗口须覆盖 ≥ 两桶：5m 用 2h/1m、15m 用 6h/1m、1h 用 2d/1h，与 0010 同）。这样 5m/15m/1h
覆盖全历史（2012+）且走 accurate cagg 快。兜底（reader.rs 查询期 `kline_5m/15m` + `kline_15m` rollup）
保留作为 accurate 缺时的安全网。**统一原则**：所有周期聚合/读取 DB 全部 accurate M1（2012→今），
无人工时间截断；数据摄取量=可获取量（供后续遵循）。

**性能注记**：全量 5m/15m/1h 物化行数较多（一次性）；TimescaleDB cagg 为**增量刷新**，历史回填后
手动全量 refresh 一次即可，查询同快（cagg 查询读物化桶，与行数无关）。若全量聚合超时/物化开销过大，
可**按 code 子集分批**（每批若干 code 的窗口 refresh）或确认可接受时长。

``` {.sql file=migrations/0017_minute_caggs_full_history.sql}
-- 0017_minute_caggs_full_history.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 问题① 修复：分钟线全历史。既有库 0010 建的 kline_accurate_5m/15m/1h 带 ts >= '2024-01-01' 过滤
-- （仅 2024+），与 1m/1d/周/月（全量）口径不一致，深翻在 2024 边界截断。
-- 本迁移 DROP 后重建为全量（无 2024 过滤，聚合 kline_accurate 全部 M1）+ 同样 refresh 策略。
-- 兜底（reader.rs 查询期 kline_5m/15m + kline_15m rollup）保留作为 accurate 缺时的安全网。
DROP MATERIALIZED VIEW kline_accurate_5m;
DROP MATERIALIZED VIEW kline_accurate_15m;
DROP MATERIALIZED VIEW kline_accurate_1h;

CREATE MATERIALIZED VIEW kline_accurate_5m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('5 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('5 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_15m
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('15 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('15 minutes', ts);

CREATE MATERIALIZED VIEW kline_accurate_1h
WITH (timescaledb.continuous) AS
SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('1 hour', ts);

-- 刷新策略（与 0010 同，窗口须覆盖 ≥ 两桶：5m=2h≈24桶、15m=6h≈24桶、1h=2d≈48桶）
SELECT add_continuous_aggregate_policy('kline_accurate_5m',
    start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_15m',
    start_offset => INTERVAL '6 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('kline_accurate_1h',
    start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- 运维注记：历史回填后须手动全量刷新一次以物化深历史（覆盖 2012→今）：
-- CALL refresh_continuous_aggregate('kline_accurate_5m', NULL, NULL);
-- CALL refresh_continuous_aggregate('kline_accurate_15m', NULL, NULL);
-- CALL refresh_continuous_aggregate('kline_accurate_1h', NULL, NULL);
```

## 4.3.10 模拟实盘会话存储（L1 sim-live，0018；ADR 11-sim-live §9）

**上下文**：sim-live（纸面交易，ADR 11-sim-live）L1 核心落数据/应用面会话存储。
会话运行期在应用面内存维护（统一读共享状态 + 变更通知），落库用于会话语义状态快照与持久化：
- `simsession`：会话元数据（name/cash_init/strategy_set/stock_set/period/start-end/status/source）。
- `simsession_result`：会话结束后结果（net_value/trades/metrics 三 jsonb 列，结构=backtest_result）。
- `sim_trades`：会话内成交明细（会话事件流落库）。
- `sim_positions`：会话内持仓状态（code/qty/avg_cost，可重建）。

**表口径**：应用面自有表（与 backtest/alert 同口径：数据面不读写，不违 ADR-017 只读库铁律）。
`simsession.id` 为应用层生成会话 id（`s_<ts>_<seq>` 口径）；`status` 状态机 running/ended。
`simsession_result` 只在 ended 时写一次（中间结果不落库，ADR §3）。

``` {.sql file=migrations/0018_sim_session.sql}
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
```

## 4.3.11 模拟实盘会话运行态存储（0019；重启恢复续跑）

**上下文**：随会话运行**实时落盘**内存态（现金/持仓/净值序列/策略配置/订单/开关），供进程重启后
`recover_sessions()` 重建同一会话**续跑**（不标记中断）。与 `simsession_result`（只有 ended 才写一次的
最终结果，ADR §3 原口径）不同，本表是**运行期中间状态**，每次 `start/process_bar/place_order/configure_strategies/set_trading/cancel_order/mark_to_market` 后 upsert。

**表口径**：`state_json` 为 `domain::ports::SimSessionState` 序列化；`updated_at` 列供诊断/幂等；
FK 级联删除。仅存 `status='running'` 会话（ended 后该行可为残留，recover 跳过 ended 不读）。

``` {.sql file=migrations/0019_sim_session_state.sql}
-- 0019_sim_session_state.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 11-sim-live / 会话运行态实时落盘（重启恢复续跑）：simsession_state（state_json + updated_at）。
-- 应用面自有表（数据面不读写，ADR-017 不违）；`state_json` = domain::ports::SimSessionState 序列化。
CREATE TABLE simsession_state (
    session_id text PRIMARY KEY REFERENCES simsession(id) ON DELETE CASCADE,
    state_json jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

**storage 模块 `crates/storage/src/sim.rs`（非 tangle 手写，契约描述）**：
实现 `domain::ports::SimSessionStore`（PgPool）。见 design/02-domain/contracts.md「SimSessionStore」端口。

## 4.3.12 准确层 cagg 物化恢复刷新（0020；tushare 回填后置运维修复）

**上下文**：0017 重建的 `kline_accurate_5m/15m/1h`（全量）在**大批量 tushare M1 回填**后，
cagg 刷新策略只覆盖近期窗口（5m start_offset 2h / 15m 6h / 1h 2d；见 4.3.4），
回填的**旧桶**落在窗口之外 → `kline_accurate_5m/15m` 物化 watermark 停在回填边界
（实盘签名：accurate M1 max=09-07 07:00，而 5m/15m cagg max 停在 09-04 07:00，落后 3 交易日；1h 因 start_offset 2d 恰好覆盖）。
这是设计的已知运维要求（4.3.4 块头注记「历史回填后须手动全量刷新一次」），本迁移把它固化为**可复跑**脚本：
全量刷新全部 accurate cagg 至最新 M1。

**幂等性**：`refresh_continuous_aggregate(cagg, NULL, NULL)` 幂等；空库（全新容器，数据由 tushare 首填）
时为 no-op，不阻塞后续迁移。**残留风险**：若下一次 tushare 批量回填又带入 start_offset 之外的旧桶，
需再次运行本迁移（或等价 CALL）；更根治的选项是把 accurate cagg 的 start_offset 加大到覆盖单次回填批次（2-3 天）——
属策略参数调整，未在本迁移内一并改动（避免扩大 DDL 影响面；见 4.4 注记 8）。

``` {.sql file=migrations/0020_accurate_cagg_refresh.sql}
-- 0020_accurate_cagg_refresh.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 修复：accurate cagg（5m/15m/1h/1d）在 tushare 大批量 M1 回填后物化滞后。
-- 成因：cagg 刷新策略只覆盖近期窗口（start_offset 2h/6h/2d），回填的旧桶落在窗口外 → watermark 停在回填边界。
-- 处置：全量刷新全部 accurate cagg 至最新 M1（与 kline_accurate M1 max 对齐）；幂等；空数据为 no-op。
CALL refresh_continuous_aggregate('kline_accurate_5m', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_15m', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_1h', NULL, NULL);
CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL);
```

## 4.3.13 策略 Registry（12-strategy-system / P2a，0022；ADR 12 §5 数据模型与状态机）

**上下文**：统一策略系统（12-strategy-system）P2a 落 Strategy Registry 持久化。
`strategy` = 策略元数据（一等资源，版本化+哈希寻址）；`strategy_version` = 版本化插件代码
（code + params_schema jsonb + sha256，ABI G4 寻址）。状态机 `draft→published→archived` 单向流转
（应用层经 `domain::strategy_state` 纯函数校验）；权限分级 `approval_level`
（backtest_ok→sim_ok→live_approved，独立标记，升级需显式动作）。

**表口径**：应用面自有表（与 backtest/simsession 同口径：数据面不读写，不违 ADR-017）。
`strategy.id` / `strategy_version.id` 为应用层生成（`st_<ts>_<seq>` / `sv_<ts>_<seq>` 口径）。

**published 不可变 + 状态机补强（DB 双保险之一）**：应用层状态机校验之外，DB 层 BEFORE UPDATE
trigger 拦 published 行内容字段（code/params_schema/sha256/version）及定位字段
（strategy_id/published_at）变更；**状态机补强**（MINOR-1）：published 行 status 变更目标仅允许
`archived`（published→draft/published 均被拒）；`archived` 为终态——禁止任何 status 变更
（同值 no-op UPDATE 放行，便于幂等清理）。BEFORE DELETE trigger 拦 published 行删除
（published 只能 archive，不可删；连带 strategy 行级联删除也会被拦截；archived 行可删）。

**P2b 查询口径（无新迁移，复用 0022 表）**：manage 管理列表（`StrategyStore::manage_list`）
一查询聚合——`strategy` LEFT JOIN 三段 LATERAL（① 版本计数 `count(*)`；② 版本号最大版本
（任意状态，`ORDER BY version DESC LIMIT 1`）；③ 最新 published 同式加 `status='published'`），
无 N+1；`kind` 精确匹配过滤。元数据更新（`StrategyStore::update_meta`）为单条件 UPDATE
（name/description 最终值 + `updated_at = now()`，`RETURNING` 行；0 行 → `Ok(None)` → 404）。

``` {.sql file=migrations/0022_strategy_registry.sql}
-- 0022_strategy_registry.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 12-strategy-system / P2a：Strategy Registry（ADR 12-strategy-system §5 数据模型与状态机）。
-- strategy = 策略元数据（一等资源）；strategy_version = 版本化插件代码（sha256 寻址，ABI G4）。
-- 状态机 draft→published→archived 单向；published 不可变（BEFORE UPDATE/DELETE trigger 双保险）。
-- 应用面自有表（数据面不读写，ADR-017 不违）。
CREATE TABLE strategy (
    id          text PRIMARY KEY,                       -- 应用层生成（st_<ts>_<seq>）
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    kind        text NOT NULL DEFAULT 'strategy' CHECK (kind IN ('strategy','template')),
    created_by  text NOT NULL DEFAULT 'local',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE strategy_version (
    id             text PRIMARY KEY,                    -- 应用层生成（sv_<ts>_<seq>）
    strategy_id    text NOT NULL REFERENCES strategy(id) ON DELETE CASCADE,
    version        integer NOT NULL,
    code           text NOT NULL,                       -- 插件 JS 源码全文（02-plugin-abi §1）
    params_schema  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- PARAMS_SCHEMA 声明（ABI §1）
    sha256         text NOT NULL,                       -- 内容哈希寻址（ABI G4）
    status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    approval_level text NOT NULL DEFAULT 'backtest_ok'
                   CHECK (approval_level IN ('backtest_ok','sim_ok','live_approved')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz,
    UNIQUE (strategy_id, version)
);

-- 查询：某策略版本按状态检索 + catalog 过滤（仅 published 按权限级别；部分索引）
CREATE INDEX strategy_version_status_idx  ON strategy_version (strategy_id, status);
CREATE INDEX strategy_version_catalog_idx ON strategy_version (approval_level) WHERE status = 'published';

-- published 不可变 + 状态机补强（DB 双保险之一，ADR §5「published 不可变」）：
-- BEFORE UPDATE：
--   ① published 行 status 变更目标仅允许 archived（published→draft 拒绝；draft→published 时
--      OLD='draft' 不触发；同值 no-op UPDATE 放行）；
--   ② archived 为终态——禁止任何 status 变更（archived→draft/published 拒绝）；
--   ③ published 行内容字段（code/params_schema/sha256/version）及定位字段
--      （strategy_id/published_at）任一变化 → 拒绝。
-- BEFORE DELETE：OLD.status='published' → 拒绝（published 只能 archive，不可删；
-- 连带 strategy 行 ON DELETE CASCADE 级联删除 published 版本同样被拦；archived 行可删）。
CREATE OR REPLACE FUNCTION strategy_version_published_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'published' THEN
            RAISE EXCEPTION 'strategy_version % is published: archive instead of delete', OLD.id;
        END IF;
        RETURN OLD;
    END IF;
    -- ① 状态机补强：published 行 status 仅允许 → archived
    IF OLD.status = 'published'
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status <> 'archived' THEN
        RAISE EXCEPTION 'strategy_version % is published: status can only transition to archived', OLD.id;
    END IF;
    -- ② archived 为终态：禁止任何 status 变更
    IF OLD.status = 'archived' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'strategy_version % is archived: terminal state, status immutable', OLD.id;
    END IF;
    -- ③ published 不可变：内容字段 + 定位字段冻结
    IF OLD.status = 'published' AND (
        NEW.code IS DISTINCT FROM OLD.code OR
        NEW.params_schema IS DISTINCT FROM OLD.params_schema OR
        NEW.sha256 IS DISTINCT FROM OLD.sha256 OR
        NEW.version IS DISTINCT FROM OLD.version OR
        NEW.strategy_id IS DISTINCT FROM OLD.strategy_id OR
        NEW.published_at IS DISTINCT FROM OLD.published_at
    ) THEN
        RAISE EXCEPTION 'strategy_version % is published and immutable: create a new draft version', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_version_no_update_published
    BEFORE UPDATE ON strategy_version
    FOR EACH ROW EXECUTE FUNCTION strategy_version_published_guard();

CREATE TRIGGER strategy_version_no_delete_published
    BEFORE DELETE ON strategy_version
    FOR EACH ROW EXECUTE FUNCTION strategy_version_published_guard();
```

**storage 模块 `crates/storage/src/strategy.rs`（非 tangle 手写，契约描述）**：
实现 `domain::ports::StrategyStore`（PgPool；strategy/strategy_version 表，迁移 0022）。
见 design/02-domain/contracts.md「StrategyStore」端口（§2.4 末尾 Registry 段）。
- `catalog`：`DISTINCT ON (s.id)` 取每策略最新 published 版本（`ORDER BY s.id, v.version DESC`）；
  `level` 过滤为 at-least 语义——SQL 侧按 rank 展开：`backtest_ok` 要求 → 全部级别通过；
  `sim_ok` → `('sim_ok','live_approved')`；`live_approved` → `('live_approved')`。
- `update_draft`：`UPDATE ... WHERE id=$1 AND status='draft'`，命中时同事务推进
  `strategy.updated_at`（与 `create_version` 对齐）；0 行 → `Ok(None)`。
- `mark_published`：`UPDATE ... SET status='published', sha256, params_schema, published_at
  WHERE id=$1 AND status='draft' AND code=$expected_code`（**乐观并发 TOCTOU 防护**：
  `expected_code` 为 application 层冒烟通过的原文）；0 行 → `Ok(None)`（application 映射 409）。

## 4.3.14 回测工作台（12-strategy-system / P3a，0023；ADR 12 §13.4 数据粒度 / §13.5 组合预设）

**上下文**：统一策略系统 P3a 落回测工作台持久化。`strategy_run` = 任务制 ensemble 运行
（ queued→running→succeeded/failed/canceled 状态机，progress 0..1，config 为完整可复现快照——
钉住 (strategy_id, version, sha256) + params/weight + thresholds + policy + stop + initial_capital + fee，
ADR §13.4 复现前提）；`strategy_run_result` = 运行结果（per_bar 全量——各策略分+聚合分+信号+订单+事件，
ADR §13.4；trades/net_value/drawdown/metrics 五 jsonb 列，FK ON DELETE CASCADE）；
`strategy_preset` = 组合预设（ADR §13.5：命名保存 {策略集+权重/参数, 阈值, Policy, 止损}，
config 同 strategy_run.config 形状，工作台与 sim-live 共用下拉，name UNIQUE）。

**表口径**：应用面自有表（与 backtest/strategy 同口径：数据面不读写，不违 ADR-017）。
`strategy_run.id` / `strategy_preset.id` 为应用层生成（`sr_<ts>_<seq>` / `sp_<ts>_<seq>` 口径）。
状态迁移全部条件更新（应用层端口契约：queued→running 原子认领；running→succeeded 同事务落结果；
queued/running→canceled 协作式取消 DB 侧），终态不可再迁移（domain::ports::StrategyRunStatus::is_terminal）。

``` {.sql file=migrations/0023_strategy_workbench.sql}
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
```

**storage 模块 `crates/storage/src/workbench.rs`（非 tangle 手写，契约描述）**：
实现 `domain::ports::StrategyRunStore` + `StrategyPresetStore`（PgPool；迁移 0023）。
- `mark_started`：`UPDATE ... SET status='running', started_at=$2 WHERE id=$1 AND status='queued'`
  （原子认领，0 行 → false——并发取消/启动时后台任务放弃执行）。
- `mark_succeeded`：事务内 `INSERT strategy_run_result` + `UPDATE strategy_run SET status='succeeded',
  progress=1, finished_at WHERE status='running'`（0 行 → rollback + false，结果不落库）。
- `mark_failed` / `mark_canceled`：`WHERE status IN ('queued','running')` 条件更新
  （0 行 → false / Some(false)，终态不覆盖——并发取消胜出保留 canceled）。
- `update_progress`：仅 running 行生效（`WHERE status='running'`，终态行静默忽略）。
- `update_preset`：`UPDATE ... SET name, config, updated_at=now() ... RETURNING`；
  name UNIQUE 冲突 → sqlx Err（application/web 映射 409）。

## 4.4 设计注记

1. 采集服务是 `kline_raw` 的**逻辑单写者**（批量去重/源状态机收敛一处）；tushare 同步任务只写 `kline_accurate`，两写者物理零冲突（ADR-002/003）
2. 缺口判定：某 code 当日交易分钟内 `kline_raw` 缺失的 ts 集合（交易日历 × 分钟序列 LEFT JOIN）
3. `kline_1d` + 流通股本/份额参考表 `share_float`（0004 已建）= 换手率 → 筹码输入（ADR-011/014）
4. metrics 框架（ADR-014）：Wave 1 看板指标由 klinecharts 前端内置渲染；服务端 metrics 表 Wave 2 启用，同名指标口径以服务端为准（契约测试锁定）
5. **压缩事故复盘（2026-09-03，证据修正版）**：真问题是 0003 设计遗漏——kline_accurate 从未配压缩（16M 行 3GB 裸奔）。排查弯路：误判"旧语法静默失效"（reloptions 为空所致）——**2.29 中压缩设置存目录表而非 reloptions，information 视图标志位是可信的**。已用新语法（enable_columnstore/segmentby/orderby，前向兼容）统一四表并实测：kline_accurate 760 chunks 压缩 3044MB→446MB（6.8x）。对策：①compose 镜像 pin 2.29.2-pg16（滚动 latest 仍有 API 漂移风险）；②压缩验收=视图标志位 + compress_chunk 冒烟 + 实测体积
6. **交易日历（0008）**：节假日表为 A 股法定休市日唯一事实源；交易日判定 = 工作日 ∧ ¬holidays。2026 数据内嵌于迁移（来源见块头注释）；每年末按当年官方通知追加下一年度（或 tushare trade_cal 复核导入）
7. **amount 量纲锁定（Wave 2 Phase A D4 结案，实盘查证 2026-09-04）**：`kline_raw.amount` 与 `kline_accurate.amount` **均为元**（tushare stk_mins 解析直取、实盘校验 amount ≈ close×volume 成立；sina_jsonp raw 行同口径 ✓）。⚠️ 已知缺陷：**tencent_ifzq 源 amount 不可信**——实盘签名：raw(tencent) amount ≈ 真实值/10³~10⁴ 且比值随标的不恒定（588000≈1/885、518880≈1/1044、159337≈1/4.9，golden 样本同签名），非固定量纲比，无法视图层换算；根因是 tencent ifzq m1 响应第 7 字段对基金/ETF 的口径与「万元」假设不符（providers 红线，本轮不改解析，留待数据面专项）。对策：①准确层（tushare）数值正确，merge 视图对已同步日天然掩盖（ADR-003 语义正常工作）；②质量对照（分歧率）**只比 close**，amount 不参与跨层比对；③当日未覆盖时段的 tencent 行 amount 及下游 cagg 聚合值低估为已知泄漏，前端/消费方不应据此口径决策
8. **accurate cagg 物化滞后根因（0020）**：cagg 刷新策略 start_offset（5m=2h/15m=6h）小于单次 tushare 回填批次跨度，大批量回填时**旧桶不落入刷新窗口** → 物化 watermark 停在回填边界。当前以「回填后全量刷新」作为运维惯例规避（0020 固化）；根治选项=加大 start_offset 覆盖单次回填批次（建议 5m/15m ≥ 2d），属策略参数调整，未随 0020 一并改动
