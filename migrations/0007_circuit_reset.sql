-- ~/~ begin <<design/04-storage/schema.md#migrations/0007_circuit_reset.sql>>[init]
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
-- ~/~ end
