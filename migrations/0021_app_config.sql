-- ~/~ begin <<design/04-storage/schema.md#migrations/0021_app_config.sql>>[init]
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
-- ~/~ end
