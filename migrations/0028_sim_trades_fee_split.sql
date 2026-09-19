-- ~/~ begin <<design/04-storage/schema.md#migrations/0028_sim_trades_fee_split.sql>>[init]
-- 0028_sim_trades_fee_split.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ADR-027 D4（费用分列，2026-09-20）：sim_trades 增 commission / stamp_duty（事实源两列），
-- 保留 fee 列（冗余，语义 = commission + stamp_duty，便于既有查询）。
-- 口径：费用三件套由撮合点写入（crates/simlive/src/fill.rs），禁止下游按费率复算。
-- 历史行：两列取默认 0；按 ADR-027 D3 历史会话在收尾波次同批清空（不提供回填）。
-- 应用：psql -v ON_ERROR_STOP=1 -f migrations/0028_sim_trades_fee_split.sql

ALTER TABLE sim_trades
    ADD COLUMN IF NOT EXISTS commission float8 NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stamp_duty float8 NOT NULL DEFAULT 0;

COMMENT ON COLUMN sim_trades.commission IS '本笔佣金（含最低佣金；ADR-027 D4 事实源，禁止下游复算）';
COMMENT ON COLUMN sim_trades.stamp_duty IS '本笔印花税（买入恒 0；ADR-027 D4 事实源）';
COMMENT ON COLUMN sim_trades.fee        IS '费用合计 = commission + stamp_duty（冗余列，便于既有查询）';
-- ~/~ end
