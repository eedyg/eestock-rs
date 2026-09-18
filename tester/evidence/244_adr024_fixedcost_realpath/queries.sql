-- ============================================================================
-- ADR-024 P1c — 只读查询集（免改代码取证）
-- 文件位置：tester/evidence/244_adr024_fixedcost_realpath/queries.sql
-- 执行方式：docker exec -i eestock-timescaledb psql -U eestock -d eestock -c "$SQL"
-- 全部为 SELECT / 只读；唯一的写操作是本轮自建测试 run 的清理 DELETE（见文件末尾，单独标注）
-- ============================================================================

-- ① 表级累计计数（架构师 357,386 的独立复核；idle 对照 Δ=0 证明统计未被重置）
SELECT relname, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd, n_live_tup, n_dead_tup
FROM pg_stat_user_tables WHERE relname IN ('strategy_run','strategy_run_result') ORDER BY relname;

-- ①' 表历史闭合：n_tup_ins 是否覆盖全表历史（374 存活 + 1,976 删除 ≈ 2,349）
SELECT count(*) AS alive FROM strategy_run;

-- ② postgres 写路径参数（fsync 义务的证据）
SHOW synchronous_commit; SHOW fsync; SHOW wal_sync_method; SHOW wal_level; SHOW max_wal_size;

-- ③ 每 run 的「理论进度帧数」= min(1001, jsonb_array_length(per_bar))
--    依据：crates/application/src/workbench.rs:814 节流 milli=(progress*1000) as i64，
--    last_milli 初值 -1 ⇒ 帧数 = progress 的十进制 0.1% 档位数 = min(1001, n)（n>1000 时恰 1001）
SELECT s.id, s.period, jsonb_array_length(r.per_bar) AS bars,
       LEAST(1001, jsonb_array_length(r.per_bar)) AS progress_frames,
       LEAST(1001, jsonb_array_length(r.per_bar)) + 2 AS predicted_updates,
       EXTRACT(EPOCH FROM (s.finished_at - s.started_at)) AS dur_s
FROM strategy_run s JOIN strategy_run_result r ON r.run_id = s.id
WHERE s.status = 'succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL
ORDER BY s.created_at;
--   ⇒ Σpredicted_updates 与 n_tup_upd 的闭合（本 run 结论：96.9% 由 374 条存活 run 解释）
SELECT SUM(LEAST(1001, jsonb_array_length(r.per_bar)) + 2) AS predicted_total_updates
FROM strategy_run s JOIN strategy_run_result r ON r.run_id = s.id
WHERE s.status='succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL;

-- ③ 状态迁移点（代码结构 + 调用点计数，非根因推断）
--    UPDATE strategy_run 的全部 SQL 位置（生产代码 5 处，唯一改动策略运行行的表）：
--      crates/storage/src/workbench.rs:107  mark_started    (1/run: queued→running)
--      crates/storage/src/workbench.rs:116  update_progress (N/run: 进度帧)
--      crates/storage/src/workbench.rs:131  mark_succeeded  (1/run: running→succeeded, 同事务写 result)
--      crates/storage/src/workbench.rs:152  mark_failed     (≤1/run)
--      crates/storage/src/workbench.rs:169  mark_canceled   (≤1/run)
--    ⇒ succeeded run 的状态迁移 UPDATE = 2（started + succeeded）⇒ 每 run = 进度帧 + 2
grep -n "UPDATE strategy_run" crates/storage/src/workbench.rs

-- ④ 并发度（协变量）：对每条 run 计数「区间交集」的其它 run
WITH r AS (
  SELECT s.id, s.period, s.symbol, s.started_at, s.finished_at,
         jsonb_array_length(res.per_bar) AS bars,
         jsonb_array_length(s.config->'slots') AS slots,
         EXTRACT(EPOCH FROM (s.finished_at - s.started_at)) AS dur_s
  FROM strategy_run s JOIN strategy_run_result res ON res.run_id = s.id
  WHERE s.status='succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL
)
SELECT a.id, a.period, a.bars, a.slots, a.dur_s,
       (SELECT count(*) FROM r b WHERE b.id <> a.id
          AND b.started_at < a.finished_at AND b.finished_at > a.started_at) AS concurrent
FROM r a ORDER BY a.started_at;

-- ⑤ 单次受控 run 的差量测量（Δ = post - pre，**必须用长窗口协议**）
--    前置 90 s idle guard（采样确认零漂移）→ 提交 → 终态 → 后置 240 s 采样确认零漂移
--    实测：363038 → 364041（Δ=1003，run sr_1789663588369_000007，M5 3500 bar）
SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='strategy_run';

-- ⑥ 窗口内是否有其它 run（并发判定；实测 = 0）
SELECT count(*) FROM strategy_run
WHERE id <> '<RUN_ID>' AND started_at < '<POST_TS>'::timestamptz
  AND (finished_at IS NULL OR finished_at > '<PRE_TS>'::timestamptz);

-- ⑦ 系统活动抽样（结构证据：写库语句就是进度 UPDATE）
SELECT now(), pid, state, wait_event_type, left(query, 72) AS query
FROM pg_stat_activity
WHERE query ILIKE '%strategy_run%' AND pid <> pg_backend_pid();

-- ============================================================================
-- 唯一的写操作（本轮自建测试 run 的清理；ON DELETE CASCADE 级联删 strategy_run_result）
-- 执行前先用 SELECT 列出将删除的行；执行后回读确认。
-- ============================================================================
SELECT id, name, period, symbol, status FROM strategy_run WHERE name LIKE 'ADR024-P1c-%';
DELETE FROM strategy_run WHERE name LIKE 'ADR024-P1c-%';
