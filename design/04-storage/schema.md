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

## 4.4 设计注记

1. 采集服务是 `kline_raw` 的**逻辑单写者**（批量去重/源状态机收敛一处）；tushare 同步任务只写 `kline_accurate`，两写者物理零冲突（ADR-002/003）
2. 缺口判定：某 code 当日交易分钟内 `kline_raw` 缺失的 ts 集合（交易日历 × 分钟序列 LEFT JOIN）
3. `kline_1d` + 流通股本/份额参考表 `share_float`（0004 已建）= 换手率 → 筹码输入（ADR-011/014）
4. metrics 框架（ADR-014）：Wave 1 看板指标由 klinecharts 前端内置渲染；服务端 metrics 表 Wave 2 启用，同名指标口径以服务端为准（契约测试锁定）
5. **压缩事故复盘（2026-09-03，证据修正版）**：真问题是 0003 设计遗漏——kline_accurate 从未配压缩（16M 行 3GB 裸奔）。排查弯路：误判"旧语法静默失效"（reloptions 为空所致）——**2.29 中压缩设置存目录表而非 reloptions，information 视图标志位是可信的**。已用新语法（enable_columnstore/segmentby/orderby，前向兼容）统一四表并实测：kline_accurate 760 chunks 压缩 3044MB→446MB（6.8x）。对策：①compose 镜像 pin 2.29.2-pg16（滚动 latest 仍有 API 漂移风险）；②压缩验收=视图标志位 + compress_chunk 冒烟 + 实测体积
6. **交易日历（0008）**：节假日表为 A 股法定休市日唯一事实源；交易日判定 = 工作日 ∧ ¬holidays。2026 数据内嵌于迁移（来源见块头注释）；每年末按当年官方通知追加下一年度（或 tushare trade_cal 复核导入）
7. **amount 量纲锁定（Wave 2 Phase A D4 结案，实盘查证 2026-09-04）**：`kline_raw.amount` 与 `kline_accurate.amount` **均为元**（tushare stk_mins 解析直取、实盘校验 amount ≈ close×volume 成立；sina_jsonp raw 行同口径 ✓）。⚠️ 已知缺陷：**tencent_ifzq 源 amount 不可信**——实盘签名：raw(tencent) amount ≈ 真实值/10³~10⁴ 且比值随标的不恒定（588000≈1/885、518880≈1/1044、159337≈1/4.9，golden 样本同签名），非固定量纲比，无法视图层换算；根因是 tencent ifzq m1 响应第 7 字段对基金/ETF 的口径与「万元」假设不符（providers 红线，本轮不改解析，留待数据面专项）。对策：①准确层（tushare）数值正确，merge 视图对已同步日天然掩盖（ADR-003 语义正常工作）；②质量对照（分歧率）**只比 close**，amount 不参与跨层比对；③当日未覆盖时段的 tencent 行 amount 及下游 cagg 聚合值低估为已知泄漏，前端/消费方不应据此口径决策
