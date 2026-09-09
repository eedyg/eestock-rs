# 070 回测任务列表分页 + 轻量查询修复（根因：RUNS_SELECT 全量结果 JSON）

本报告位置：`coder/report/070_backtest_list_light_pagination.md`

## 根因确认

`crates/storage/src/backtest.rs` 的 `RUNS_SELECT` 为 `run LEFT JOIN backtest_results` 且**选中 3 个结果 JSON 列**
（`res.net_value_json` / `res.trades_json` / `res.metrics_json`）。`list_runs` 用它返回**所有 run + 全量结果 JSON**，
且 `ORDER BY created_at DESC` **无 LIMIT** → 任务列表重/慢/传输大（尤其 done 任务多、净值/交易/指标 jsonb 大）。

根因已确认：列表页只需元数据+状态，结果仅 `get_run`（点「查看」）需要。

## 修复范围（仅回测）

storage / domain / web crates + `web/src/features/backtest`。不改其它功能。

## What changed

**storage（`crates/storage/src/backtest.rs`，非 tangle 手写）**
- 新增 `RUNS_SELECT_LIGHT`：只取 run 元数据 16 列，**不联 backtest_results、不选结果 JSON 列**。
- `row_to_run_view_light(row)`：列表行 → `RunView`，`result=None`。
- `row_to_run_view(row)`：在 light 元数据上补结果（读索引 16/17/18），供 `get_run`。
- `list_runs` 改用 `RUNS_SELECT_LIGHT` + `ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`，bind limit/offset。
- `get_run` 仍用 `RUNS_SELECT`（全量结果）。

**domain（`crates/domain/src/ports.rs`——tangle 生成，先改 design/02-domain/contracts.md 再 `entangled tangle`）**
- `RunFilter` 增 `limit: i64` / `offset: i64`；自定义 `Default`（limit=100, offset=0）。

**web（`crates/web/src/dto.rs`——tangle；`crates/web/src/backtest.rs` 非 tangle 手写）**
- `BacktestListQuery` 增 `limit`（serde 默认 100）/ `offset`（默认 0）；新增 `default_backtest_limit()` 与 `MAX_BACKTEST_LIMIT=500`。
- `list_runs` handler：`limit.clamp(1, MAX_BACKTEST_LIMIT)`、`offset.max(0)`，构造 `RunFilter` 带 limit/offset。
- 网格提交内部 `list_runs` 用 `..Default::default()`（limit=100，覆盖新建的小组）。

**web 契约（design/07-app-plane/00-web-api.md）**
- §1.5 端点表 `GET /api/backtest/runs`：增 `limit`/`offset` 参数与「**轻量列表：不含结果列**；`条数==limit` 表示还有更多」。
- dto 代码块（BacktestListQuery / default / MAX_BACKTEST_LIMIT）同步。
- `design/04-storage/schema.md` §4.3.5 prose 同步（轻量分页说明）。

**前端（`web/src/features/backtest` + `web/src/api`）**
- `api/client.ts`：`listRuns` 增 `limit`/`offset` 参数并序列化到 query。
- `api/mock.ts`：`listRuns` 按 `created_at DESC, id DESC` 排序 + `limit/offset` 切片 + **剥离结果列**（`stripBacktestResult`）；`getRun` 仍返回完整。
- `store.ts`：状态增 `hasMore`/`loadingMore`；`loadRuns` 拉首屏 `limit=100`；新 `loadMoreRuns` 追加下一页（`offset=累计条数`，`hasMore=条数==limit`）；`refreshRuns` 重置到首页。
- `TaskList.tsx`：增 `hasMore`/`loadingMore`/`onLoadMore` props；列表底部「加载更多」按钮（disabled=loadingMore）。列表行仅元数据+状态，点「查看」才 `get_run`（现已有 getRun）。
- `BacktestPage.tsx`：给 TaskList 传 pagination props。

## Architecture alignment

- **storage** → Infrastructure：`PgBacktestStore` 只依赖 domain `BacktestRunStore` 端口；查询拆分/分页在实现内，不改协议。
- **domain** → 端口读模型：`RunFilter` 增字段（加法扩展，不破坏既有端口方法签名 `list_runs(&self, &RunFilter)`）；application/测试的 mock 无需改签名。
- **application** → `BacktestService::list_runs` 透传 filter，零改动。
- **web** → Presentation：handler 解析 limit/offset 并 clamp，路由不变。
- **前端 store** → 状态机：分页状态在 store 内，`BacktestPage`/`TaskList` 只消费。

## Problem solved / feature added

- 修「加载历史记录性能差」根因：列表不再拉全量结果 JSON + 不再无 LIMIT 全表拉；`RUNS_SELECT_LIGHT` 只取元数据 + LIMIT/OFFSET 分页。
- 列表 UI 轻量分页（首屏 100，加载更多 offset 递增，hasMore=条数==limit）；点「查看」才 `get_run` 拉结果。
- 保留 WS 进度自动刷新 / 删除 / 勾选 compare / 网格组（未改动这些路径）。

## Implementation approach

- 轻/全两套查询：`RUNS_SELECT_LIGHT`（16 列，result=None）+ 复用原 `RUNS_SELECT`（19 列）供 `get_run`；`row_to_run_view_light` 复用为两行转换的公共元数据层。
- 分页 key：`ORDER BY created_at DESC, id DESC` 保证稳定排序（同秒创建 id 大者靠前）。
- 默认 limit=100（domain `RunFilter::default()` 与 web `BacktestListQuery` serde 默认一致）；web 侧极限 clamp 1-500。
- 前端 `hasMore` 判定 = 返回条数 == limit（父级批准方案 A：**不加 total**，不破坏 `[BacktestRunDto]` 数组契约）。

## Test coverage

- **storage**（`crates/storage/tests/backtest.rs`，新 `run_store_list_pagination_light`）：造 5 run（2 个 mark_done 带结果）→ 默认 limit=100 全 5 条且 `result=None`；`get_run` 含 result；`limit=2 offset=0`→最新 2 条、`offset=2`→下 2 条、`offset=4`→尾 1 条。
- **web**（`crates/web/tests/api_backtest.rs`，新 `list_runs_pagination_light_numbered`）：HTTP `?limit=&offset=` 分页 + 列表项无 `net_value/trades/metrics` 键，`get_run` 含；limit clamp 500、越界 offset 空页。
- **前端**：
  - `store.test.ts`：分页——loadRuns 首屏 `{limit:100, offset:0}`→100 条 + hasMore=true；loadMoreRuns `{limit:100, offset:100}`→120 条 + hasMore=false；末尾再 loadMore 不重复请求。
  - `mock.test.ts`：listRuns 分页切片（created_at DESC, id DESC）+ 结果列剥离 + getRun 才含结果。
  - `client.test.ts`：listRuns `limit/offset` 序列化到 query。
  - `TaskList.test.tsx`：hasMore 渲染「加载更多」并调 onLoadMore；loadingMore 禁用+文案。

## Verification

- `cargo test --workspace`：**唯一失败**为既有（无关）`storage/tests/alert_store.rs::list_events_filters`（在基线 stash 后同样失败，为**预先存在**）；含本次全部回测测试：`run_store_list_pagination_light`、`run_store_lifecycle`、`list_runs_pagination_light_numbered` 等均 ok。69 个 `test result: ok`。
- `cd web && npx vitest run`：**37 files / 333 tests 全绿**。
- `VITE_API_MOCK=0 npx tsc -b && vite build`：**均通过**（vite 仅有既有 >500kB chunk 警告）。
- `entangled tangle`：**幂等**（第二次运行 "Nothing to be done."）；仅 `crates/domain/src/ports.rs` 与 `crates/web/src/dto.rs` 两个 tangle 文件被重生成，`lib.rs/state.rs/ws.rs` 未变。

## Residual risks

- **既有无关失败**：`storage/tests/alert_store.rs::list_events_filters` 在基线上即失败（`from/to` 窗口断言 left=2/right=1），与本次改动无关；不在本任务范围。
- **分页+删除一致性**：`runNextOffset` 为累计条数；若用户在已加载页之间删除 run，后续 `loadMore` 的 offset 可能略偏（可能出现重复/缺失单条）。属可接受边界，任务未要求跨删除分页去重。
- **网格 internal list_runs** 用默认 limit=100：若单组 grid >100 子任务，`submit_run` 返回 `run_ids` 会被截到 100。网格展开子任务（用户参数组合）通常远小于 100，风险低。
- **WS 更新跨页**：`refreshRunInList` 只更新已加载页内的 run；未加载（更旧）页的 run 进程状态变化不在已加载视图内，属分页预期行为。
- **mock 与后端同序**：二者均 `created_at DESC, id DESC`，但 mock 用字符串比较 `created_at`（RFC3339 同构）。

## 暂存状态

**未 commit、未 stage**（`git diff --cached` 为空）。改动文件为 18 个已跟踪文件 + 本报告（未跟踪）。
