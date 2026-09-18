# 02-spec — 接口契约变更（ADR-024）

> 配套：`01-adr.md`（决策 D1–D14）。本文档是**实现契约唯一出口**；任何实现与本文不一致 = 违约，须先改本文。
> 修订既有文档的责任见 `04-implementation-plan.md` P7。

---

## 1. Domain 端口契约（`crates/domain/src/ports.rs`）

### 1.1 取数：新增游标分页（保留旧 `bars()` 供既有调用方）

```rust
/// 可得区间（该标的 × 该周期，服务口径并集：accurate ∪ 兜底）。
/// 无数据 → Ok(None)（调用方据此 400，禁止产出 0 bar 的"成功"run）。
pub struct AvailableRange { pub from: DateTime<Utc>, pub to: DateTime<Utc> }

pub trait BacktestBarRead: Send + Sync {
    /// 既有全量读（保留；sim-live 等短区间调用方继续用）。
    async fn bars(&self, code: &str, period: &Period, from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<Bar>>;

    /// 新增：keyset 游标分页。`after_ts = None` 表示从 `from` 起。
    /// 返回按 ts 升序的 bar；**首末根由调用方判定**（用于 D3 的执行时收缩）。
    /// 禁 OFFSET；单次 limit 上限由实现钳制（建议 10_000，chunk 默认 5_000）。
    async fn bars_page(&self, code: &str, period: &Period, from: DateTime<Utc>, to: DateTime<Utc>,
                       after_ts: Option<DateTime<Utc>>, limit: usize)
        -> anyhow::Result<Vec<Bar>>;

    /// 新增：可得区间（服务口径并集，单次轻量 min/max 查询）。
    async fn available_range(&self, code: &str, period: &Period)
        -> anyhow::Result<Option<AvailableRange>>;
}
```

**硬约束**：`available_range` **不得**只查 accurate 层（D3）；实现须与 `merged_sql` 的服务口径一致（accurate ∪ 兜底并集），并有契约测试覆盖「accurate 滞后而兜底有数据」的场景。

### 1.2 结果：分块读写

```rust
pub const RESULT_FORMAT_LEGACY: &str = "legacy_single";
pub const RESULT_FORMAT_CHUNKED: &str = "chunked_v1";

pub enum ResultKind { PerBar, NetValue, Drawdown, Fills }

pub struct ResultChunk {
    pub kind: ResultKind,
    pub seq: i32,
    pub ts_from: DateTime<Utc>,
    pub ts_to: DateTime<Utc>,
    pub payload: serde_json::Value, // 数组
}

pub trait StrategyRunStore: Send + Sync {
    // 既有：create_run / mark_started / update_progress / mark_succeeded / mark_failed /
    //       mark_canceled / get_run / list_runs ... （签名不变）
    //       mark_succeeded 语义变更：新 run 写 trades/metrics + result_format='chunked_v1'，
    //       且**不**再写 per_bar/net_value/drawdown（那三列新 run 写 '[]' 占位，
    //       读取路径一律以 result_format 判别，禁止把占位当数据）。

    /// 新增：追加一个结果分块（边跑边写）。seq 由调用方单调递增。
    async fn append_result_chunk(&self, run_id: &str, chunk: &ResultChunk) -> anyhow::Result<()>;

    /// 新增：按序号范围读分块（分页）。
    async fn result_chunks(&self, run_id: &str, kind: ResultKind,
                           offset: i64, limit: i64) -> anyhow::Result<Vec<ResultChunk>>;

    /// 新增：按时间区间读分块（跨 chunk 查询；可能返回部分 chunk，调用方在 chunk 内精确过滤）。
    async fn result_chunks_in_range(&self, run_id: &str, kind: ResultKind,
                                    from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<ResultChunk>>;

    /// 新增：分块计数（进度/分页元信息）。
    async fn result_chunk_count(&self, run_id: &str, kind: ResultKind) -> anyhow::Result<i64>;
}
```

**错误语义**：`append_result_chunk` 失败 ⇒ run 必须落 `failed`（不得留半截结果当 succeeded）；`strategy_run_result` 的写入与 `mark_succeeded` 仍在同一事务（分块写入在事务之外、先于 `mark_succeeded`；`mark_succeeded` 的 `status='running'` 守卫保证「取消后不落成功」）。

---

## 2. 存储契约（`design/04-storage/schema.md` → tangle → `migrations/0027_*.sql`）

> **流程硬约束（ADR-007/018）**：迁移文件由 `design/04-storage/schema.md` 的 ```` ``` {.sql file=migrations/0027_*.sql} ```` 块 tangle 生成，**禁止手改 `migrations/` 下产物**。门禁：tangle 后 `git diff` 必须与产物一致。

```sql
-- 0027_strategy_run_result_chunks.sql —— 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ADR-024 / D8：结果统一分块（per_bar / net_value / drawdown 边跑边写，与区间长度解耦）。

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
```

**配套**：
- `crates/storage/src/migrate_check.rs` 的 `EXPECTED_RELATIONS` 增 `strategy_run_bars`（**先落迁移、再重启 app** —— 与 ADR-023 §4.1 同型的顺序硬约束）。
- 应用方式：`psql -v ON_ERROR_STOP=1 -f migrations/0027_....sql`（本迁移无 cagg，可用单事务；仍按既有惯例记录应用证据）。
- `strategy_run.period` 列注释更新（现注释写 `M1/M5/M15/D1`）→ 加 `M30`（无 CHECK 约束，无需数据迁移）。

---

## 3. REST 契约（`crates/web`）

### 3.1 `POST /api/workbench/runs`（提交）

**请求**：不变（`symbol/period/from/to/slots/policy/...`）。

**校验顺序变更**（`WorkbenchService::submit`）：
1. symbol 非空 → 已注册
2. **period 合法（改用 `bar_map::parse_period` 单一事实源；接受 `M30`）** ← 删除 web 层硬编码白名单
3. `from < to`
4. **删除** 日历天数档校验 ← 原 `workbench.rs:229-240`
5. **区间收缩**：`available_range(symbol, period)` → 无交集 ⇒ 400 `range_empty`；有交集 ⇒ `effective = [max(from, avail.from), min(to, avail.to))`
   - **执行时以真实取到的首末 bar 为准（D3，P5 验收 N5 定稿）**：若**任一端**被夹（`clamped=true`），则两端**都**按区间内真实首/末 bar 收窄；`effective_from = 首根 in-range bar ts`，`effective_to = 末根 in-range bar ts + 1s`（半开）。理由：`clamped` 一次就是「本区间不是你要的区间」的声明，此时报“精确到 bar”的真实覆盖范围比报一个混入请求值的半成品边界更诚实；**不得影响嗂给引擎的 bar 集合**（取数仍先于该调整，集合以真实 in-range bar 为准）。
   - 该调整会反映到落库 `strategy_run.from_ts/to_ts` 与回显 `effective_*`（差异 ≤1 根 bar）。
6. slots / 版本 / params / 阈值 / policy / stop / fee（不变）
7. **资源护栏**（D1，值待 ② 规模曲线定）：预估 bar 数/耗时超阈值 ⇒ 400 `resource_guard`（带 `confirm_token` 语义见 3.1.1）

**响应 201 新增字段**（`StrategyRunView`）：
```jsonc
{
  "id": "sr_...", "status": "queued",
  "requested_from": "...", "requested_to": "...",     // 用户原始输入
  "effective_from": "...", "effective_to": "...",     // 实际生效（收缩后）
  "clamped": true,                                     // effective != requested
  "clamp_reason": "data_range",                        // data_range | null
  "estimated_bars": 2800,                              // 提交时预估（count 预扫描，D12）
  "bars_total": 2800,                                  // 执行后精确值（running/succeeded 时可见）
  "result_format": "chunked_v1"
}
```
> `requested_*` / `effective_*` / `clamped` 为**审计与复现前提**，必须入库（`strategy_run` 现有 `from_ts/to_ts` 存 **effective**；`requested_*` 落入 `config` 快照，与既有钉住快照同源）。

#### 3.1.1 结构化错误（400）
```jsonc
{ "error": {
    "code": "range_empty" | "resource_guard" | "period_invalid" | "from_after_to" | ...,
    "message": "人类可读中文",
    "detail": { "period": "M30", "available_from": "...", "available_to": "...",
                "requested_bars": 290000, "limit_bars": 2000000, "estimated_secs": 180 }
} }
```
**硬要求**：前端必须能**编程**消费（不再只解析字符串）；`design/07-app-plane/00-web-api.md` 记录该错误形状。

### 3.2 结果读取（新增 + 兼容）

| 端点 | 语义 | 备注 |
|---|---|---|
| `GET /api/workbench/runs/{id}/result` | **兼容保留**：`legacy_single` 全量返回；`chunked_v1` 返回 `summary` + **首页 bars** + `has_more` + `next_offset`（默认页 5,000，**显式**截断，非静默） | 既有前端可渐进迁移 |
| `GET /api/workbench/runs/{id}/brief` | 轻量：`status/progress/metrics/effective_from/to/clamped/estimated_bars/bars_total/result_format/chunk_count` | 列表/轮询用，避免拉大包 |
| `GET /api/workbench/runs/{id}/bars?kind=per_bar&offset=0&limit=5000` | **分页**读（`offset/limit`，`limit` 默认 5,000、上限 20,000） | `kind ∈ per_bar`（明细表/逐 bar 评分） |
| `GET /api/workbench/runs/{id}/bars?kind=per_bar&from=...&to=...` | **区间**读（跨 chunk；可能返回部分 chunk 外沿，调用方按 ts 过滤） | 与 `offset/limit` 互斥（同时给 → 400） |
| `GET /api/workbench/runs/{id}/curve?k=2000&kind=net_value` | **显式抽样**曲线（`k` = 目标点数，默认 2,000、上限 20,000；均匀抽样**保首尾**） | 响应带 `downsampled:true` + `original_bars`（D10） |
| `GET /api/workbench/runs/{id}/fills?offset=0&limit=5000` | **成交明细分页读**（**有界精确源**，`kind='fills'` 单块；`limit` 默认 5,000/上限 20,000）。响应：`{run_id, total, offset, limit, has_more, next_offset, recorded, fills:[…]}`；其中 **`recorded` 承载「无成交」与「未写」的判别**（`false` = 该 run 无 fills 块，仅 P6 之前的 chunked run 可达） | 用于 **K 线买卖标记**与成交核对。**禁止**用抽样曲线或 `trades` 代替：① 抽样会**丢真实成交**；② `TradeDetail` 仅在**完全平仓**时合成（部分买入/加仓/DCA 与部分卖出不进 `trades`）⇒ 会漏标记。实证（tester `252`）：含 `position_pct=0.5` + 部分卖出的 run ⇒ fills 3 笔 vs trades 1 行；7953 bar 真实 run ⇒ fills 200 vs trades 100 |
| `POST /api/workbench/runs/compare` | 返回**抽样后**净值曲线（默认 `k=2000`，可传 `k`）+ 绩效并排 | 禁止 N × 全量净值 |

**向后兼容矩阵**：

| 既有调用方 | 影响 | 处置 |
|---|---|---|
| 前端 `ResultView`（图表 + 逐 bar 表） | `/result` 对 `chunked_v1` 不再全量 | 图表改走 `/curve`；逐 bar 表改走 `/bars` 分页（P6） |
| 前端 compare 面板 | 净值由全量变抽样 | 显式标注 `downsampled`（曲线点数提示，已有 `抽样 N 点` 文案模式） |
| MCP `bt_get_run_result` | 同上 | 见 §4 |
| 旧 run（`legacy_single`） | 无影响（全量返回） | 双读路径（D8） |

---

## 4. MCP 契约（`crates/mcp/src/tools.rs`）

| 工具 | 变更 |
|---|---|
| `bt_run_ensemble` | ① `period` enum 增 `"M30"`；② 描述**删除**「分钟级≤3个月 / D1≤5年」表述，改为「区间按数据可得范围自动收缩（响应回显 requested/effective/clamped）；无日历天数上限」；③ 响应 schema 增 `effective_from/to`、`clamped`、`estimated_bars`、`bars_total` |
| `strategy_test_run` | 同上三处（period enum 增 M30、去上限表述、收缩回显）；截断语义改为「均匀抽样 + `downsampled`/`original_points`」 |
| `bt_get_run_result` | 增可选参数 `offset`/`limit`（分页）与 `kind`；**默认行为**：与 REST `/result` 一致（首页 + `has_more`），描述中说明 `bt_get_run_result` 大区间应改用分页参数 |
| `bt_get_run_curve`（新） | 或复用 `bt_get_run_result` + `sample_k` 参数 —— **首选复用**（减少工具面）：`bt_get_run_result {run_id, kind?, offset?, limit?, from?, to?, sample_k?}` |
| `bt_list_runs` | 增 `bars_total`/`result_format` 摘要字段（列表轻量，不含结果） |
| 工具描述中的周期集 | 由单一事实源生成（见 §5.1），禁止手写漂移 |

**MCP 超时注意**：试算同步路径放开后（D11），长区间可能超 MCP 客户端超时 ⇒ 工具描述须提示「长区间建议改用 `bt_run_ensemble`（异步）」，并在响应中回显预估耗时。

---

## 5. 前端契约（`eestock-rs/web`）

### 5.1 单一事实源（DRY 硬要求）

| 层 | 现状 | 目标 |
|---|---|---|
| application | `bar_map::parse_period` 接受 `M1/M5/M15/M30/H1/D1`（新） | **唯一权威**，并额外导出 `supported_backtest_periods() -> &[&str]` |
| web | `workbench.rs:148` 硬编码 `matches!(...)` | 删除，改调 `parse_period` |
| MCP | `tools.rs:1020` `is_valid_period` + 2 处 schema enum 手写 | 由 `supported_backtest_periods()` 生成 |
| 前端 | 2 个 `<select>` 手写 + `mock.ts` 独立常量 | 镜像常量集中一处 + **防漂移断言测试**（与后端集合逐字相等） |

新增契约向量文件 `design/16-backtest-scalability/contract-vectors.json`（前后端共用断言输入），见 §5.4。

### 5.2 工作台/试算 UI
- **周期下拉**：增 `M30`（工作台 `ConfigPanel.tsx:585`、试算 `TestRunPanel.tsx:148`）；`ScopedKlineFeed` 已有 `30m` 映射。
- **日期区间与可得区间联动**：切换周期或标的 → 取 `available_range` → 设 `input[type=date]` 的 `min`/`max` + 显示「可用区间 X ~ Y」。
- **收缩提示条**：提交响应 `clamped:true` → 显著提示「已按实际数据范围收缩：X ~ Y（原因：数据可得范围）」，**不弹确认框**（Q12：静默收缩 + 显著回显）。
- **过渡期二次确认**：收到 `resource_guard` → 展示「预估 N 根 / 约 M 秒」+ 确认后带 `confirm=true` 重提（引擎改造完成后此路径可退化为提示）。
- **取数路径**：总分/各策略分/净值/回撤曲线 → `/curve`（抽样）；逐 bar 评分表 → `/bars` 分页（虚拟滚动）；K 线 + 买卖标记 → 仍按区间取 kline（既有路径）。

### 5.3 错误展示
`range_empty` → 「该标的该周期无数据（可用区间：X ~ Y）」；`resource_guard` → 见上；`period_invalid` → 「不支持的周期」。

### 5.4 `contract-vectors.json`（新增，防漂移）

```jsonc
{
  "backtest_periods": ["M1","M5","M15","M30","H1","D1"],
  "span_limit_semantics": {
    "calendar_day_cap": null,                       // ADR-024 D1：已删除
    "clamp": { "mode": "intersect_available_range",
               "echo_fields": ["requested_from","requested_to","effective_from","effective_to","clamped"] },
    "empty_intersection": { "http": 400, "code": "range_empty" }
  },
  "sampling": { "explicit_only": true, "must_mark": ["downsampled","original_bars"] },
  "m30": { "domain_variant": "M30", "dashboard_code": "30m", "bars_per_year_nominal": 2016 }
}
```

---

## 6. 契约变更总表（实施顺序 = 优先级）

| # | 契约 | 变更类型 | 兼容性 |
|---|---|---|---|
| 1 | `BacktestBarRead::bars_page` / `available_range` | 端口新增（加法） | 兼容 |
| 2 | `StrategyRunStore::append_result_chunk` / `result_chunks*` | 端口新增（加法） | 兼容 |
| 3 | `strategy_run_result.result_format` | 迁移 0027（加法，默认 `legacy_single`） | 兼容 |
| 4 | `strategy_run_bars` 表 | 迁移 0027（新增表） | 兼容 |
| 5 | `POST /workbench/runs` 校验顺序 + 收缩 | 行为变更（去掉天数档） | **语义变更**（旧 400 场景变 201） |
| 6 | 响应增 `effective_*/clamped/estimated_bars` | 字段新增 | 兼容（旧客户端忽略） |
| 7 | `GET /result` 对 `chunked_v1` 分页 | 行为变更 | **需前端同步**（P6） |
| 8 | `/brief` `/bars` `/curve` | 新端点 | 兼容 |
| 9 | `compare` 净值抽样 | 行为变更 | 前端标注 `downsampled` |
| 10 | MCP period enum + M30 | 加法 | 兼容 |
| 11 | 试算截断 → 均匀抽样 | 行为变更 | 前端/调用方读 `downsampled` |
| 12 | 周期白名单单一事实源 | 内部重构 | 无 wire 影响 |
