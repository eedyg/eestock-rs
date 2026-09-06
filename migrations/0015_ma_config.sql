-- ~/~ begin <<design/04-storage/schema.md#migrations/0015_ma_config.sql>>[init]
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
-- ~/~ end
