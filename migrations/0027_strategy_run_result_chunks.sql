-- ~/~ begin <<design/04-storage/schema.md#migrations/0027_strategy_run_result_chunks.sql>>[init]
-- 0027_strategy_run_result_chunks.sql —— 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ADR-024 / D8：结果统一分块（per_bar / net_value / drawdown 边跑边写，与区间长度解耦）。
-- ADR-024 / P6：kind 增 'fills'（成交明细**有界精确源**，单块 seq=0；见 16-backtest-scalability/02-spec.md §3.2）。

ALTER TABLE strategy_run_result
    ADD COLUMN IF NOT EXISTS result_format text NOT NULL DEFAULT 'legacy_single';

-- 判别列硬约束：不得用空 jsonb 表达「数据在别处」（静默读空）。

CREATE TABLE IF NOT EXISTS strategy_run_bars (
    run_id   text        NOT NULL REFERENCES strategy_run(id) ON DELETE CASCADE,
    kind     text        NOT NULL CHECK (kind IN ('per_bar','net_value','drawdown','fills')),
    seq      integer     NOT NULL,             -- 0 起单调递增（应用层生成）
    ts_from  timestamptz NOT NULL,             -- 本块首根 bar ts（闭）
    ts_to    timestamptz NOT NULL,             -- 本块末根 bar ts（闭）
    payload  jsonb       NOT NULL,             -- 本块数组（chunk=5000 根）
    PRIMARY KEY (run_id, kind, seq)
);
CREATE INDEX IF NOT EXISTS strategy_run_bars_run_kind_seq_idx ON strategy_run_bars (run_id, kind, seq);
CREATE INDEX IF NOT EXISTS strategy_run_bars_run_kind_ts_idx  ON strategy_run_bars (run_id, kind, ts_from, ts_to);
-- ~/~ end
