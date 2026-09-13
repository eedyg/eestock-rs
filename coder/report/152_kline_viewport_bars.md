# 152 — ADR-020 看板默认 K 线视口：口径由「交易日数」改为「K 线根数」

- 报告位置（self-location）：`coder/report/152_kline_viewport_bars.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（独立 git 仓库，本轮**未 commit / 未 push**）
- 权威口径：`design/06-web/11-kline-viewport-bars.md`（ADR-020 §2 决策 / §3 契约 / §4 TDD Red 清单 / §5 观测性）
- 执行者：Coder Agent（接手上一轮因**供应商连接错误**中断的 Red 阶段；未重做已完成部分）
- 附加处置：ADR-020 未覆盖的 D7（分时解耦）与 E3（3 个 e2e 口径统一）经父级 `need_decision` **批准后执行**（见 §7）

---

## 1. 起点盘点（接手时磁盘现状，未重做）

`git status --short`（接手时，**节选仅与本任务相关条目**）：

```
 M crates/web/src/settings.rs        ← 上一轮改：测试已改，实现仍旧
 M crates/web/tests/api_settings.rs  ← 上一轮改：Red 已就绪
 M design/06-web/01-dashboard.md     ← ADR-020 文档补记（上一轮）
 M design/06-web/08-settings.md      ← ADR-020 文档补记（上一轮）
 M design/99-decisions-log.md        ← ADR-020 文档补记（上一轮）
?? design/06-web/11-kline-viewport-bars.md   ← ADR-020 正文（未跟踪）
```
→ 前端全部未改（与任务描述一致）；后端 Red 测试确认为**真 Red**（见 §2.1 / §2.2）。

---

## 2. Red 证据（先红后绿）

### 2.1 后端 - lib 单测（旧实现下编译即红）

命令：`cargo test -p web --lib kline`（回退 settings.rs 前）

```
error[E0425]: cannot find function `verify_kline_viewport_bars` in this scope
   --> crates/web/src/settings.rs:324:17
help: a function with a similar name exists
324 -         let e = verify_kline_viewport_bars(601).unwrap_err();
324 +         let e = verify_kline_viewport_days(601).unwrap_err();
error[E0560]: struct `settings::KlineConfigDto` has no field named `viewport_bars`
   --> crates/web/src/settings.rs:338:36
help: a field with a similar name exists
338 -         let dto = KlineConfigDto { viewport_bars: 200 };
338 +         let dto = KlineConfigDto { viewport_days: 200 };
error: could not compile `web` (lib test) due to 15 previous errors
```

### 2.2 后端 - HTTP 契约（B3/B4，settings.rs 临时回退到旧实现）

命令：`git stash push -- crates/web/src/settings.rs && cargo test -p web --test api_settings`（随后 `git stash pop`）

```
running 6 tests
test config_kline_put_get_and_validate ... FAILED

---- config_kline_put_get_and_validate stdout ----
thread 'config_kline_put_get_and_validate' (1261747) panicked at crates/web/tests/api_settings.rs:305:5:
assertion `left == right` failed: GET 缺省 120（app_config 无 kline 键）
  left: Null
 right: 120

test result: FAILED. 5 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
```
（`left: Null` = 旧实现返回 `{"viewport_days":2}`，无 `viewport_bars` 键 → 正是 B3/B4 要锁的行为。）

### 2.3 前端（R1–R7 + D7）

命令：`cd web && npm test`（实现前）

```
 Test Files  9 failed | 39 passed (48)
      Tests  35 failed | 439 passed (474)
```
关键失败样例（证明测试打在规格上，而非空断言）：
```
 FAIL  src/features/dashboard/barSpaceFit.test.ts
Error: Failed to resolve import "./barSpaceFit" from "src/features/dashboard/barSpaceFit.test.ts".
 FAIL  .../store.test.ts > viewportBars 暴露为 getter：配置值生效 / 缺省 120 兜底
AssertionError: expected undefined to be 200
 FAIL  .../store.test.ts > viewportBars=200 → 未传 pageSize 时 limit=200，任意周期同值
-     "limit": 200,
+     "limit": 482,        ← 旧实现按「2 交易日 × 241」折算
 FAIL  .../GridCell.test.tsx > 复用 barSpaceFit：容器宽 470 / viewportBars=200 ...
AssertionError: expected null not to be null
```
D7（分时退化）Red：
```
 FAIL  src/features/dashboard/TimeshareChart.test.tsx > TimeshareChart（D7：当日 1m 全时段取数，不随 viewport_bars 配置变化）
     > mount 取数 limit ≥ 一个交易日 1m 上限 241（旧口径 482 → 新默认 120 的退化必红）
AssertionError: expected 120 to be greater than or equal to 241
 Test Files  1 failed (1) · Tests 1 failed | 3 passed (4)
```

---

## 3. Green 证据（必须命令 + 输出尾部）

### 3.1 `cargo test -p web`

```
     Running tests/api_workbench.rs (target/debug/deps/api_workbench-49b94151a6004fd2)
running 6 tests
test submit_archived_version_audit_rerun_201 ... ok
test cancel_run_semantics ... ok
test submit_run_lifecycle_end_to_end ... ok
test preset_crud_apply_end_to_end ... ok
test submit_validation_error_matrix ... ok
test compare_endpoint_side_by_side ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.51s

     Running tests/ws_poller.rs (target/debug/deps/ws_poller-916564b98f1f523f)
running 1 test
test poller_publishes_increments_only ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.92s

   Doc-tests web
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
汇总：**80 passed / 0 failed**（全 suite；含 `config_kline_put_get_and_validate`）。另 `cargo check --workspace` → `Finished dev profile ... in 0.77s`（无错误）。

### 3.2 `npm test`

```
 ✓ src/features/dashboard/barSpaceFit.test.ts (7 tests) 8ms
 ✓ src/features/dashboard/feed.test.ts (10 tests) 9ms
 ✓ src/features/dashboard/store.test.ts (32 tests) 190ms
 ✓ src/features/dashboard/KlineChart.test.tsx (12 tests) 63ms
 ✓ src/features/dashboard/GridCell.test.tsx (12 tests) 132ms
 ✓ src/features/dashboard/TimeshareChart.test.tsx (5 tests) 95ms
 ✓ src/features/dashboard/DashboardPage.test.tsx (26 tests) 3963ms
 ✓ src/features/backtest/ScopedKlineFeed.test.ts (8 tests) 12ms
 ✓ src/features/settings/SettingsPage.test.tsx (11 tests) 1597ms
 ✓ src/api/mock.test.ts (40 tests) 108ms

 Test Files  48 passed (48)
      Tests  484 passed (484)
   Start at  13:10:53
   Duration  5.24s
```
类型门禁：`npx tsc -b` → 退出码 0（无输出）。

### 3.3 `./scripts/check-tangle.sh`

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
```
> 中途一次门禁红：`WARNING web/src/layouts/SettingsGrid.tsx not managed by Entangled`——根因是上一轮改的是**文档侧** `design/06-web/08-settings.md` 里 `{.tsx file=web/src/layouts/SettingsGrid.tsx}` 代码块的 2 行注释，生成物未同步。处置：未用 `--force`（`entangled tangle` 因 lib.rs/kline_reader.rs「changed outside control」而 `ERROR conflicts found, breaking off`，拒绝写盘），改为**按文档真源手改生成物 2 行**并逐字节比对 `identical` 后过门禁（未跑全局 `entangled stitch`）。

---

## 4. 文件清单

### 4.1 新增（2）
| 文件 | 内容 |
|---|---|
| `web/src/features/dashboard/barSpaceFit.ts` | 主图+宫格共用：`MIN/MAX_BAR_SPACE`、`barSpaceForViewport`、`fitBarSpaceToViewport`（含 `data-viewport-fit` 留痕 + 按 chart 实例去重的夹取 warn）、`useBarSpaceFit`（ResizeObserver） |
| `web/src/features/dashboard/barSpaceFit.test.ts` | R1 缺陷复现（7 周期同 space）+ R2 边界/安全网/width≤0 + 留痕与告警去重（7 用例） |

### 4.2 修改（31 = 后端 3 + 前端源码 10 + 前端测试 9 + entangled 生成物 1 + e2e 4 + design 4）
后端（3）：
- `crates/web/src/settings.rs`：`viewport_days`→`viewport_bars`；`DEFAULT/MIN/MAX_KLINE_VIEWPORT_BARS=120/30/600`；`verify_kline_viewport_days`→`verify_kline_viewport_bars`（30..=600，描述性错误含字段名与区间）；GET 三态回退（缺键/解析失败含旧结构/落库越界 → 120 + `tracing::warn!`）；PUT 越界/非整/缺字段 → 400。**删除旧常量与旧校验函数，无兼容分支、不折算、不双读**
- `crates/web/src/lib.rs`：路由注释 L71 口径同步（entangled 生成物，与文档真源两处一致）
- `crates/web/tests/api_settings.rs`：B3/B4 契约断言（上一轮已写，本轮验证通过；新增 `seed_kline_raw` 辅助）

前端源码（10）：
- `web/src/features/dashboard/feed.ts`：删 `BARS_PER_TRADING_DAY`/`defaultPageSizeForPeriod`/`DEFAULT_KLINE_VIEWPORT_DAYS`/`deps.viewportDays`；新增 `DEFAULT/MIN/MAX_KLINE_VIEWPORT_BARS`、`deps.viewportBars`、`get viewportBars()`、`pageSize = deps.pageSize ?? viewportBars ?? 120`；**`PAGINATION_BATCH`/`paginationBatchForPeriod` 原样保留**；新增 `TIMESHARE_1M_BARS=500`（D7）
- `web/src/features/dashboard/KlineChart.tsx`：`KlineChartFeedLike.viewportDays→viewportBars`；`fitBarSpace` 改调 `barSpaceFit` 模块（删本地 clamp 与死参数 `extraPx`）；接 `useBarSpaceFit`；新增 `manualAdjusted` ref（`onZoom`/`onScroll` 非 programmatic → true；feed 重建重置 false；`followLatest` false→true 重置并重算 + `scrollToRealTime`）
- `web/src/features/dashboard/GridCell.tsx`：新增 `viewportBars?: number` prop（缺省 120）；feed 传 `viewportBars`（**移除 `pageSize:120`**）；复用 `useBarSpaceFit`；新增 `data-grid-chart`（resize/fit 断言锚点）。**`maWindows` 仍不进 feed deps**
- `web/src/features/dashboard/DashboardPage.tsx`：`readViewportDays→readViewportBars`（保留 3 次尝试 + 500ms/1s 退避 + focus/visibilitychange 重读 + 失败兜底 120）；`viewportBars` 同时给主图 feed 与 `GridCell`
- `web/src/features/dashboard/TimeshareChart.tsx`：分时 feed 显式 `pageSize: TIMESHARE_1M_BARS`、**不传 viewportBars**（D7）
- `web/src/features/backtest/ScopedKlineFeed.ts`：`SCOPED_VIEWPORT_BARS=120`（不读配置）；`viewportDays`→`viewportBars`；`pageSize` 默认 `paginationBatchForPeriod(period)`
- `web/src/features/settings/KlineConfigPanel.tsx`：MIN 30 / MAX 600 / DEFAULT 120；文案「默认K线根数（主图与宫格统一，所有周期一致）」，删除「交易日」措辞；越界/非整禁用保存
- `web/src/api/types.ts` / `client.ts` / `mock.ts`：`KlineConfigDto.viewport_bars`；`saveKlineConfig(viewportBars)` PUT `{viewport_bars}`；`assertKlineViewportBars`（非整/越界 → `ApiError` 400；缺省 120）
- 测试（9，不在上述计数内单列）：`feed.test.ts`、`store.test.ts`、`KlineChart.test.tsx`、`GridCell.test.tsx`、`DashboardPage.test.tsx`、`ScopedKlineFeed.test.ts`、`SettingsPage.test.tsx`、`TimeshareChart.test.tsx`、`api/mock.test.ts`

entangled 生成物（1）：
- `web/src/layouts/SettingsGrid.tsx`：按文档真源 `design/06-web/08-settings.md`（上一轮改）同步 `kline-config` 区块 2 行注释，逐字节比对 `identical`（见 §3.3）

e2e（4）：`dashboard-periods-ma.e2e.ts`（INIT_PAGE 全 120）+ E3 的 3 个 spec（见 §7.2）

design 文档（4）：`design/07-app-plane/00-web-api.md`（本轮：lib.rs 路由注释真源同步）；`design/06-web/01-dashboard.md`、`design/06-web/08-settings.md`、`design/99-decisions-log.md`（**上一轮**的 ADR-020 文档补记，本轮未再改）

### 4.3 删除（0）
无文件删除；符号删除见 §4.2（`BARS_PER_TRADING_DAY` / `defaultPageSizeForPeriod` / `DEFAULT_KLINE_VIEWPORT_DAYS` / `verify_kline_viewport_days` / `deps.viewportDays` / `KlineConfigDto.viewport_days`）。

---

## 5. 残留审计（原始输出）

```
$ grep -rn "viewport_days\|viewportDays\|BARS_PER_TRADING_DAY\|defaultPageSizeForPeriod\|DEFAULT_KLINE_VIEWPORT_DAYS" web/src crates web/e2e
crates/web/tests/api_settings.rs:306:    assert!(v.get("viewport_days").is_none(), "响应不得含旧字段 viewport_days");
crates/web/tests/api_settings.rs:348:    // 4) B3 旧结构不兼容：app_config[kline] = {"viewport_days":8} → GET 回默认 120（非 8、非折算值）
crates/web/tests/api_settings.rs:349:    seed_kline_raw(&pool, serde_json::json!({ "viewport_days": 8 })).await;
crates/web/tests/api_settings.rs:352:    assert_eq!(v["viewport_bars"], 120, "旧结构 viewport_days=8 视为未配置 → 回默认 120（不折算）");
crates/web/tests/api_settings.rs:356:        .json(&serde_json::json!({ "viewport_days": 8 })).send().await.unwrap();
crates/web/src/settings.rs:240:/// 缺键 / 解析失败（含旧结构 `{{"viewport_days":n}}`）/ 落库值越界 → 回默认 120 根（`tracing::warn!` 留痕，不折算、不双读）。
crates/web/src/settings.rs:356:        assert!(v.get("viewport_days").is_none(), "序列化不得输出旧字段");
crates/web/src/settings.rs:363:        // 旧结构（仅 viewport_days）→ 反序列化失败（ADR-020 §2.3：不兼容、不双读）
crates/web/src/settings.rs:364:        assert!(serde_json::from_value::<KlineConfigDto>(serde_json::json!({"viewport_days": 8})).is_err());
```
**结论：9 处命中全部是 ADR-020 §2.3/B3 明确要求的「旧结构不得被兼容」负断言与说明**——即
① 断言响应不含旧字段；② 断言序列化不输出旧字段；③ 以旧 payload `{"viewport_days":8}` 反序列化必须失败 / PUT 必须 400。
去掉这些负断言后严格命中为 **3 处**（全部是旧 payload 字面量），**生产代码 0 处**：
```
$ grep -rn ... web/src crates web/e2e | grep -v 旧结构 | grep -v 旧字段 | wc -l
3        # 均为 json!({"viewport_days": 8}) 负断言的输入字面量
```
`web/src`（前端源码）与 `web/e2e`：**0 命中**。`grep -rn "klineViewportDays|assertKlineViewportDays|verify_kline_viewport_days" web/src crates` → **0 命中**。

---

## 6. 验收要点自查（逐条对照 ADR-020）

| 项 | 结论 | 证据 |
|---|---|---|
| §2.1 单位=K线根数、字段 `viewport_bars` | ✅ | `settings.rs` / `types.ts` / `client.ts` / `mock.ts`；审计 0 生产命中 |
| §2.2 默认 120 / 30–600 前后端同构 | ✅ | `settings.rs` 常量 + `feed.ts` 常量 + `KlineConfigPanel` 30/600/120；`api_settings` 边界 PUT 30/600→200、29/601→400 |
| §2.3 旧值不兼容、不折算、不双读 | ✅ | GET `{"viewport_days":8}`→120；PUT 旧结构→400；`seed_kline_raw` 脏值 9999→120 |
| §2.4 主图+宫格统一 / 回测弹窗固定 120 | ✅ | DashboardPage→GridCell `viewportBars`；`ScopedKlineFeed.SCOPED_VIEWPORT_BARS=120` |
| §2.5 视口与周期解耦 | ✅ | `feed.test`（1m/15m/1d limit 同值）；`barSpaceFit.test` R1（7 周期同 space） |
| §2.6 resize 重算 / 手动缩放后不重算 / 回到最新恢复 | ✅ | `KlineChart.test` R7 四例（含 feed 重建重置） |
| §2.7 夹取语义 = 安全网 | ✅ | `barSpaceForViewport` clamp + `clamped` + `console.warn`（按 chart 去重） |
| §4.1 B1–B4 | ✅ | `settings::tests` 3 例 + `api_settings` 1 例 |
| §4.2 R1–R7 | ✅ | 见 §3.2 各文件 |
| §5 观测性 | ✅ | 后端 GET 回退 `tracing::warn!`；前端夹取 `console.warn({width,viewportBars,space,clamped})`；`data-viewport-fit` 主图/宫格同构 |
| §3.3 不改动项 | ✅ | `getKline` 契约 / `MAX_LIMIT=1000` / 路由 / `app_config` / 回测弹窗业务语义未动 |

---

## 7. ADR-020 附带处置（父级批准的范围扩展）

### 7.1 D7：分时图与「视口根数」解耦（新增常量 `TIMESHARE_1M_BARS`）

**问题**：`TimeshareChart.tsx` 直接 `new KlineDataFeed({api, ws, code, period:'1m'})` → 旧默认 482（2 交易日）→ 口径改后默认 120 ≈ 半个交易日，`computeTimeshare()` 只用「当日」1m bar 画线 → **分时图退化为最近 ~120 分钟**（A 股 1m 单日 ≈241 根）。ADR-020 未覆盖该文件 → 停手 `need_decision`，父级裁决选 **C（专用常量，意图命名）**。

**实现**：
- `feed.ts` 新增 `export const TIMESHARE_1M_BARS = 500;`，注释写明 ①语义=当日 1m 全时段；②必须 ≥ 单日上限 241（A 股 4h=240min + 集合竞价/收盘余量，真数据核对），取 500 留缓冲；③与 `viewport_bars` **解耦**。
- `TimeshareChart.tsx:31-33`：`new KlineDataFeed({ api, ws, code, period: '1m', pageSize: TIMESHARE_1M_BARS })`，**不传 `viewportBars`**。
- 测试：`TimeshareChart.test.tsx` 新增 2 例（Red→Green 已录，见 §2.3）；`feed.test.ts` 新增常量守卫（500、≥241、≠120、≤1000）。
- 未选 A（复用 `PAGINATION_BATCH`：语义重载）、未选 B（跟随配置：接受回归）——与父级裁决一致。

### 7.2 E3：3 个部署级 e2e spec 的口径统一（逐文件 旧值→新值 对照表）

设计依据：ADR-020 §1.3 F5「部署级 e2e 断言口径必须随本 ADR 统一」；§4.3 E1 只点名 `dashboard-periods-ma.e2e.ts` 属表述不周 → 父级**批准扩范围**（仅限这 3 个文件的断言口径）。事实源：`web/src/features/dashboard/feed.ts`（`DEFAULT_KLINE_VIEWPORT_BARS=120`、`TIMESHARE_1M_BARS=500`）；`BATCH`/深翻批量**未动**。

| 文件 | 旧行号 | 旧值 | 新行号 | 新值 | 依据 |
|---|---|---|---|---|---|
| `e2e/kline-matrix.e2e.ts` | L14 | `BARS_PER_DAY = {1m:241,5m:49,15m:17,1h:5,1d:1}` | L15–L28 | `KLINE_VIEWPORT_LIMIT=120` + `INIT_LIMIT{全周期:120}` + `TIMESHARE_1M_LIMIT=500`（含事实源注释） | feed.ts 常量 |
| 同上 | L172 | `toContain('limit=34')` | L186–L187 | ``toContain(`limit=${INIT_LIMIT['15m']}`)`` + `expect(KLINE_VIEWPORT_LIMIT).toBe(120)` | feed.ts |
| 同上 | L260–L264 | `1m:482, 5m:98, 15m:34, 1h:10, 1d:2` | L276–L280 | 全 = `INIT_LIMIT[...]` = **120** | feed.ts |
| 同上 | L291–L295 | `expect(BARS_PER_DAY[api]).toBeDefined()` | L310–L311 | `expect(INIT_LIMIT[api]).toBe(KLINE_VIEWPORT_LIMIT)`（同强度，仅换事实源） | feed.ts |
| 同上 | L361–L362 | 分时 `limit=482` | L377–L379 | 分时 ``limit=${TIMESHARE_1M_LIMIT}`` = **500** | `TIMESHARE_1M_BARS`（D7） |
| `e2e/dashboard-state-consistency.e2e.ts` | L46–L53 | `{1d:2, 1w:30, 1mo:24, 1m:482, 15m:34, 1h:10}` | L47–L56 | `KLINE_VIEWPORT_LIMIT=120`；6 个周期全 = **120** | feed.ts |
| 同上 | L24（头部口径注释） | `15m init limit=34` | L24–L25 | `15m init limit=120（=DEFAULT_KLINE_VIEWPORT_BARS，旧 34 已废除）` | feed.ts |
| `e2e/embedded-charts.e2e.ts` | L674 / L677 | 分时 `limit=482` | L674–L681 | 分时 `TIMESHARE_1M_LIMIT=500`（局部常量 + 取值理由注释） | `TIMESHARE_1M_BARS`（D7） |
| `e2e/dashboard-periods-ma.e2e.ts` | L40–L41 | `INIT_PAGE={1w:30,1mo:24,1d:2,1m:482}` | L40–L43 | `INIT_PAGE` 全 = **120**；`BATCH` 维持 `PAGINATION_BATCH`（1w150/1mo80/1d250/1m500） | 任务口径 |

`embedded-charts.e2e.ts:254/308/505/516` 的 `k.limit === 120` **已核对无需改动**：它们断言的是**宫格单格**请求（旧实现硬编码 `pageSize:120`），新实现宫格默认 `viewportBars=120` → 值不变、语义由「硬编码」变为「配置默认」。

**DB 当日报文对账分母的取舍（父级要求说明理由）**：取 `TIMESHARE_1M_LIMIT=500` 而非旧 482。对账分母 = 「REST 响应中落在该 CST 日内的 1m 行」；`500 ≥ 241`（单日上限）保证当日行**完整**落在响应内，不依赖「恰好覆盖 2 个交易日」的巧合；同时 ≤ 后端 `MAX_LIMIT(1000)` 不会被截断。故采用固定值断言而非「≥ 当日 DB 行数」的模糊断言（固定值可精确捕获「分时取数被视口配置污染」的回归）。

**e2e 类型卫生**：3 个 spec 均为 Playwright 转译（不进 `tsc -b`）。为证明未引入新类型错误，对每个文件做了「现行 vs HEAD 基线」同目录 tsc 对比：`kline-matrix 9/9`、`dashboard-state-consistency 1/1`、`embedded-charts 14/14`、`dashboard-periods-ma 0/0`（**数量一致，且无一处落在本轮改动行上**；其余为既有 `__push`/DOM 循环类型宽松问题）。**本地未跑 e2e**（按任务说明）。

---

## 8. 未决事项 / 风险

1. **部署级 e2e 未在本地执行**（按任务要求）；§7.2 的 3 个 spec 仅做静态口径核对与类型基线对比，需 tester 在真容器复跑（`E2E_BASE_URL=http://127.0.0.1:8081`）。
2. **部署镜像口径落后**：`web/e2e/*` 里 `ENV_TAG` 仍写 `SPA index-B9RewKvL.js (b92fc88)`；真容器需重新构建部署后 e2e 才反映本轮口径（属部署流程，不在本轮范围）。
3. **ADR §4.3 E2（`data-viewport-fit` DOM 断言）未加入 e2e**：属性已在主图/宫格实现并有单测锁定（`KlineChart.test` × 2、`GridCell.test` × 2），但部署级断言未加（e2e 无法本地验证，且任务点名的 e2e 变更只有 INIT_PAGE/BATCH）。建议后续在 `dashboard-periods-ma.e2e.ts` 补「1d 与 1m 同配置值初始可见根数同阶」的 `data-viewport-fit` 断言。
4. **`vercel`/组件级 `clamped` 告警仅前端 console**：无指标通道（ADR §5 已声明 Metrics 不在范围）。受支持布局下 `30–600` 恒可达（可达区间 [19,980]），夹取为安全网。
5. **既有 flaky**：`StrategyEditorPage.test.tsx`（codemirror 内容异步）在本轮某次全量跑中偶发 1 例失败（`expected '' to contain 'v2 draft 调整'`），单独重跑与随后全量重跑均通过，**与本轮改动无关**（该文件未改）。建议 tester 关注。
6. **`barSpaceForViewport` 签名与 ADR §3.2 字面差异**：§3.2 写 `: number`，而 §4.2 R2 要求 `width ≤ 0 → null`。按 R2（可测规格）实现为 `number | null`，已在源码注释与测试中显式说明；未改 ADR（父级负责 design/ 侧补记）。
7. **未选中/未初始化**：`app_config[kline]` 落库脏值（手写越界）→ GET 回 120（安全网），但**不自动修复库中脏值**（不写迁移、不回写），与 §2.3「不折算、不双读」一致；如需自愈属新需求。
8. **分时 `TIMESHARE_1M_BARS=500` 属本轮新增口径**（ADR 原文未覆盖）：已按父级裁决实现并注释事实源，ADR 文档补记由父级完成（本轮未改 `design/`，除 `00-web-api.md` 的 lib.rs 真源同步行）。

---

## 9. 提交状态

- **未 `git commit` / 未 `git push`**；按验收契约要求**未 `git add`**（工作区全部变动可 `git diff` / `git status` 直接审阅）。
- 本报告路径：`coder/report/152_kline_viewport_bars.md`。
