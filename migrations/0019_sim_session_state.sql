-- ~/~ begin <<design/04-storage/schema.md#migrations/0019_sim_session_state.sql>>[init]
-- 0019_sim_session_state.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- 11-sim-live / 会话运行态实时落盘（重启恢复续跑）：simsession_state（state_json + updated_at）。
-- 应用面自有表（数据面不读写，ADR-017 不违）；`state_json` = domain::ports::SimSessionState 序列化。
CREATE TABLE simsession_state (
    session_id text PRIMARY KEY REFERENCES simsession(id) ON DELETE CASCADE,
    state_json jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- ~/~ end
