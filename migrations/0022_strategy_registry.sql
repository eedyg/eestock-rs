-- ~/~ begin <<design/04-storage/schema.md#migrations/0022_strategy_registry.sql>>[init]
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
-- ~/~ end
