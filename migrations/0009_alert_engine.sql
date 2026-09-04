-- ~/~ begin <<design/04-storage/schema.md#migrations/0009_alert_engine.sql>>[init]
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
-- ~/~ end
