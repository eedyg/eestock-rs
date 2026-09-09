# 107 — 优化 1m 读性能（MERGED_1M_SQL 改为双侧索引 DESC LIMIT 合并）

> 本文件位置：`eestock-rs/coder/report/107_merged_1m_sql_index_limit_descent.md`
> 范围：只改 `crates/storage/src/reader.rs` 的 `MERGED_1M_SQL`（reader.rs 为 ADR-007 tangle 生成物，先改
> `design/07-app-plane/00-web-api.md` 事实源再 `entangled tangle`）。不改数据 / 不改其它周期 / **不 commit**。

## 任务范围
优化 1m 读性能：`GET /api/kline?period=1m&limit=500`（无 before 初始加载）从 ~2.5s 降至期望 <500ms。
根因：旧 `MERGED_1M_SQL` 直查 `kline_merged` 视图，`ORDER BY ts DESC LIMIT` 无法下推到各分支 → 全量
Append（~77 万行）+ top-N 排序 + raw 反连接逐行查 accurate（旧实测 ~1.05s 暖、~2.5s 冷）。

## What changed（产物）

| 文件 | 变更 | 层 |
|---|---|---|
| `design/07-app-plane/00-web-api.md` | `MERGED_1M_SQL` 常量 + doc、模块头注释、`period_merged_sql` doc、§3 叙事（1m 读取口径） | design（事实源） |
| `crates/storage/src/reader.rs` | `MERGED_1M_SQL` 改为双侧 (code,ts) 索引 DESC LIMIT 合并（+doc） | storage（生成物，tangle） |
| `crates/storage/tests/kline_reader.rs` | 新增 2 个 1m 测试：per-branch LIMIT 合并正确性 + 基准断言 | storage 集成测试（生成物，tangle） |

`git diff --stat`：
```
crates/storage/src/reader.rs         |  28 +++++++--
crates/storage/tests/kline_reader.rs |  80 +++++++++++++++++++++++++
design/07-app-plane/00-web-api.md    | 110 +++++++++++++++++++++++++++++++++--
3 files changed, 209 insertions(+), 9 deletions(-)
```

## 优化 SQL（语义等价 kline_merged）

```sql
SELECT code, ts, open, high, low, close, volume, amount, source
FROM (
    (SELECT a.code, a.ts, a.open, a.high, a.low, a.close, a.volume::bigint AS volume,
            a.amount, 'tushare'::text AS source
     FROM kline_accurate a
     WHERE a.code = $1 AND a.period = 'M1' AND ($2::timestamptz IS NULL OR a.ts < $2)
     ORDER BY a.ts DESC LIMIT $3)
    UNION ALL
    (SELECT f.code, f.ts, f.open, f.high, f.low, f.close, f.volume::bigint AS volume,
            f.amount, f.source
     FROM kline_raw f
     WHERE f.code = $1 AND ($2::timestamptz IS NULL OR f.ts < $2)
       AND NOT EXISTS (SELECT 1 FROM kline_accurate a
                       WHERE a.code = f.code AND a.ts = f.ts AND a.period = 'M1')
     ORDER BY f.ts DESC LIMIT $3)
) m
ORDER BY ts DESC LIMIT $3
```

## Implementation approach（框定内的关键决策）

- **双侧各自索引 DESC LIMIT 后合并**：accurate 分支走 `(code,ts)`（实际复用 pkey `(code,ts,period)`）索引回溯
  DESC LIMIT；raw 分支走 `(code,ts)` pkey 索引 DESC LIMIT（含反连接剔重）。合并后外层再 DESC LIMIT。
- **语义等价证明**：merge 尾部 top-N ⊆ 双侧 top-N 并集（任一入选合集的 top-N 行，其分支内更大 ts 的行也必在
  合集中 → 该行必在自身分支 top-N）。raw 分支反连接已剔重（同 code+ts+period=M1），union 天然无重复、准确优先。
  实盘 EXCEPT 互减 0 行（latest + before 两场景都验证）。
- **⚠️ 与任务字面 SQL 的一处偏差（已在实盘验证后确定）**：任务给的字面 SQL 对 raw 分支写 `NULL::text AS
  source`。但 `kline_merged` 视图（以及既有测试 `merged_1m_accurate_first_and_cursor_pagination`、
  `KlineBarView.source` 注释「仅 1m merge 视图带来源」）**保留 raw 实际来源**（如 `'tencent_ifzq'`）。
  任务同时强调「语义等价 kline_merged」「与旧 kline_merged 口径一致」。若按字面 NULL 会改变 1m 输出契约、
  破坏既有测试、**不满足语义等价**。故选 **raw 分支保留 `f.source`**（accurate 分支 `'tushare'` 与视图一致。
  实盘 `kline_accurate M1` source 恒为 `'tushare'`，EXCEPT 0 行佐证）。此为满足「语义等价」目标而做的
  定向矫正，非扩大范围。
- **未新建索引**：占位复用已有 pkey `(code,ts,period)`（accurate）与 `(code,ts)`（raw）索引，均被计划采用；
  满足「不改数据」铁律（EXPLAIN 可见 Index Scan Backward 于两者）。
- **占位符一致**：`bars()` 绑定 3 参（code/before/limit），SQL 用 `$1/$2/$3`（多分支复用）。

## Test coverage

- 既有 `merged_1m_accurate_first_and_cursor_pagination`（不改）：准确层优先 / raw 兜底 / source（`tushare` 与
  `tencent_ifzq`）/ 升序 / before 游标 / limit —— 在新 SQL 下仍全绿（锁定 source 契约与 merge 语义）。
- 新增 `merged_1m_branch_limit_merge_correctness`：准确层与 raw 交替（偶数/奇数分钟）、双侧行数 > limit，
  锁 per-branch LIMIT 合并正确性（准确优先 / raw 兜底 / 无重复 / 升序 / limit / before 深翻）。
- 新增 `merged_1m_branch_index_limit_performance`：真实 code `518880`（77 万+ 行）读 500 根，预热 8 次后测
  稳态，断言 <500ms 并打印实测（若数据不足则跳过断言，防假阴性）。

## Verification

- **EXPLAIN 前后耗时**（code=518880, limit=500）：
  | 场景 | 前（旧 kline_merged 视图） | 后（新 MERGED_1M_SQL） |
  |---|---|---|
  | 初始加载（无 before） | `Execution Time ~1057ms`（全量 Append 768,871 行 + top-N heapsort） | `Execution Time ~113ms`（Index Scan Backward + Merge Append；仅扫 419 accurate 行 + raw 候选） |
  | 深翻（before=2026-09-01） | `Execution Time ~976–1002ms` | `Execution Time ~16.6ms` |
  | 稳态（sqlx Rust 侧，预热后） | — | `290ms → 284ms`（debug build，含行解码开销；<500ms 通过） |

  注：hypertable 上千 chunk 子计划使单次**规划** ~600ms（新旧 SQL 都存在，非本次优化点）；`EXPLAIN
  ANALYZE` 的 `Execution Time` 为真实查询执行耗时，即优化目标。后侧无缓存的冷执行（含规划）实测 ~700ms；
  sqlx / web 长连接用 prepared statement + generic plan 后稳态 ~113ms（执行）。
- **语义等价**：`SELECT * FROM opt EXCEPT SELECT * FROM old` 双向 0 行（latest 与 before 两场景）。
- **测试**：`cargo test -p storage --test kline_reader` → `14 passed; 0 failed`。
- **工作区**：`cargo test --workspace` → 除 `storage::alert_store::list_events_filters` 外全部通过。该失败为
  **既有、与本改动无关**（`alert_store` 与本改动零交集；隔离单独运行亦失败：`from/to 窗口 last_fired_at
  断言 left:2 right:1`，疑似 DB 残留/口径，须另行排查）。
- **tangle 幂等（ADR-007 门禁）**：二次 `entangled tangle` → `Nothing to be done`；`git diff --exit-code` 干净。
- **explain 前后对比汇总**：初始加载（无 before）2.5s/1s 级 → 113ms，符合期望 <500ms。

## 残留风险

1. **1m 输出 `source` 字段语义**：raw 分支保留 `f.source`（与旧 `kline_merged` 一致）。若上游某天要求 raw
   1m source 归一为 NULL（对齐 `merged_sql` 其它周期），需另立需求并同步修改
   `merged_1m_accurate_first_and_cursor_pagination` 断言 —— 本改动未这样做。
2. **基准断言依赖真实 code `518880` 有≥500 根 M1**：若验收库为仅迁移的裸库则跳过（`[bench-skip]`），不造成
   假阴性；性能证据以 `EXPLAIN Execution Time` 为主。
3. **规划成本未优化**：hypertable 上千 chunk 子计划的单次规划 ~600ms 仍在（新旧皆有），靠连接级
   prepared statement / generic plan 摊薄；如后续成为瓶颈可考虑 `plan_cache_mode` 或减少 chunk 数（超出本任务）。
4. **本机时间/缓存方差**：基准数字为同库暖缓存下测得，冷启动/负载下执行耗时会升高（但双重索引 LIMIT 的计划
   形态不变，数量级仍远低于全量 Append）。
5. **`alert_store::list_events_filters` 既有失败**：与本改动无关，归为待办，不阻塞本任务验收。

## 暂存文件清单（已 `git add`，未 commit）

```
crates/storage/src/reader.rs
crates/storage/tests/kline_reader.rs
design/07-app-plane/00-web-api.md
```
