-- ~/~ begin <<design/04-storage/schema.md#migrations/0013_favorite_symbols.sql>>[init]
-- 0013_favorite_symbols.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- Wave 3 页面①：看板收藏（置顶+排序）。应用面自有表（数据面不读写，ADR-017 不违）。
-- code 须存在 symbols（FK）；一键收藏=自动置顶（sort_order=max+1）；拖拽排序=sort_order=索引。
CREATE TABLE favorite_symbols (
    code       text PRIMARY KEY REFERENCES symbols(code) ON DELETE CASCADE,
    sort_order integer NOT NULL
);
-- ~/~ end
