# P3 · application + web-api 车道（ADR-027 / ADR-028 结果载荷 v2）

**报告文件位置**：`coder/evidence/20260920_adr027_p3_app_api/report.md`

> round-trips 完成 ｜ L2 切片 完成 ｜ fills 增量 完成 ｜ curve 窗口与 position 完成 ｜ audit 增量 完成 ｜ application 测试 **绿**

---

## 0. 交付清单（本波作者变更）

| 文件 | 内容 | 备注 |
|---|---|---|
| `crates/application/src/workbench.rs` | 读模型：L1 列表 / L2 切片 / `/fills` 过滤与新字段 / `/curve` 窗口与 `position` / 写入侧 position 块 + fills & per_bar 事件字段 | 本波净增约 250 行（文件级 staged diff 331 行中含 P1/P2 车道已暂存改动，非本波作者） |
| `crates/application/src/audit.rs` | `round_trips_closed` / `round_trips_open` / `rt_reconcile{checked,mismatched,tolerance}` + 纯函数 `reconcile_round_trips` | 净增约 190 行；另修 `report_serializes_frozen_field_names` 冻结字段集（受控契约演进，见 §6） |
| `crates/application/tests/workbench.rs` | **C 段契约测试 C1–C8（+C5b/C5c）共 10 支** | `+381` 行，全部为本波新增 |
| `crates/web/src/workbench.rs` | 2 个新 handler + `CurveQuery.from_ts/to_ts` + `FillsQuery.round_trip` + `parse_series_kind` 增 `position` | `+76` 行 |
| `crates/web/src/lib.rs` | 2 条新路由（L1 列表、L2 切片） | `+6` 行 |

证据：`10_red_c_section.txt`（红）、`20_green_c_section.txt`（C 段绿）、`21_green_application.txt`（`-p application` 全绿）、`30_workspace_build.txt`（workspace build 绿）。

---

## 1. 逐端点形状（HTTP 契约 = 02-spec §5）

### 1.1 `GET /api/workbench/runs/{id}/round-trips?offset=&limit=` — L1 列表（§5.2）

```
200 { run_id, total, recorded, offset, limit, has_more, next_offset,
      round_trips: [ RoundTrip v2 × N ] }
404 run 未知 / 无结果（WorkbenchNotFound，与 /result 同）
```

- 元素 = 02-spec §1.2 **全字段**（`rt_seq/code/status/open_ts/close_ts/open_bar/close_bar/open_price/
  close_price/shares/gross_value/commission/stamp_duty/pnl/hold_bars/l2_count/buy_count/sell_count/reason`）。
- 事实源 = `strategy_run_result.trades`（引擎经**唯一聚合实现** `backtest::aggregate_round_trips` 写出；
  本读径只分页投影，**未新增第二处聚合**）。反序列化到 `backtest::TradeDetail` ⇒ 形状由类型系统钉住（非 `Value` 透传）。
- `limit` 缺省 5000 / 上限 20000（与既有分页口径一致）；`has_more` 与 `next_offset` 同源互斥。

### 1.2 `GET /api/workbench/runs/{id}/round-trips/{rt_seq}/fills?offset=&limit=` — L2 切片（§5.3）

```
200 { run_id, rt_seq, total, recorded, offset, limit, has_more, next_offset, fills: [ FillFact × N ] }
404 rt_seq 不属于该 run（**禁空数组冒充「无成交」**）
```

- 归属**只**由 `rt_seq` 判（ADR-027 D6：无 `[open_bar, close_bar]` 窗口推断）。
- `fills` 元素 = §1.1 `FillFact`：`code`（回测填 run 的 symbol，引擎落库无该列 ⇒ 读侧注入，已存在则不覆盖）、
  `rt_seq/bar_index/ts/side/qty/price/trade_value/commission/stamp_duty/reason`。
- 判据实现：过滤后 `owned.is_empty()` ⇒ `WorkbenchNotFound` ⇒ web `404`。

### 1.3 `GET /api/workbench/runs/{id}/fills?offset=&limit=&round_trip=` — 增量（§5.4）

```
200 { run_id, total, offset, limit, has_more, next_offset, recorded,
      [round_trip]  // 仅在传过滤时序列化（既有契约逐字节不变）
      fills: [ 既有字段 + rt_seq + trade_value + commission + stamp_duty ] }
```

- `total` = **过滤后**总数；`recorded` 语义**不变**（仍是「事实源是否可得」）——过滤不改变该判定。
- `/fills` 对未知 `round_trip` **不**做 404（分页查询语义；404 语义专属 L2 切片端点）。
- 写入侧同源：`collect_fills` 与 per_bar 事件投影同时补 4 字段 ⇒ 两源逐值一致（legacy 双读派生路径
  `legacy_fills` 逐字段透传，缺失即 `null`，不造数）。

### 1.4 `GET /api/workbench/runs/{id}/curve?kind=&k=&from_ts=&to_ts=` — 窗口 + `position`（§4.1/§4.2）

```
200 { kind, points, downsampled, original_bars, k,
      window_from_ts: i64|null, window_to_ts: i64|null, window_bars: i64,
      recorded: bool }                                   // ← 见 §5 契约偏差申报
```

- `kind ∈ per_bar|net_value|drawdown|position`；`position` 可抽样（`is_sampleable()` 白名单**未**动，
  `fills` 仍被拒 ⇒ C6）。
- 时间窗 = **闭区间** `[from_ts, to_ts]`，两端可各自缺省（`null` = 不限）；缺省无窗口 ⇒ 全区间，
  `window_from_ts/window_to_ts = null`、`window_bars == original_bars` ⇒ **行为与今日逐值一致**（向后兼容）。
  在**窗口内重新采样** `k`（禁前端裁剪已取点）；`downsampled = points.len() < window_bars`（分母 = 窗口内原始根数）。
- `original_bars` 语义保持 = **该 kind 全序列**原始根数（无窗口时 = `window_bars`，故既有断言不破）；
  `window_bars` = 窗口内原始根数（采样分母，ADR-028 D3）。
- `from_ts > to_ts` ⇒ web 结构化 400 `from_after_to`（与 `/bars` 区间读同码同形）。
- `position` 点形状 = §4.1（`ts/qty/position_value/cash/nav/position_ratio`）；测试逐点锁定 I6
  （`position_value + cash == nav`、`position_ratio == position_value/nav`（`nav ≤ 0 ⇒ 0`））
  与「与 `net_value` 同根数 / 同 ts / 同 nav」。

### 1.5 `GET /api/workbench/runs/{id}/audit` — 增量（§5.5）

```
+ round_trips_closed: usize
+ round_trips_open:   usize            // 回测恒 0
+ rt_reconcile: { checked: usize, mismatched: [rt_seq, ...], tolerance: f64 }
```

- 判据（**逐回合 Σ(L2 字段) 与 L1 同名字段一致**）落在纯函数
  `audit::reconcile_round_trips(trades, fills, fills_recorded)`：
  `gross_value ← Σ_{side=Sell} trade_value`；`commission ← Σ 全笔 commission`；`stamp_duty ← Σ 全笔 stamp_duty`。
- **容差显式**：`RT_RECONCILE_TOLERANCE = 1e-6`，判据 `|Σ_L2 − L1| ≤ tol × max(1, |L1|)`；
  `tolerance` 字段回显该常量（C7 断言相等）。
- **事实缺失不冒充一致**（D10/D11）：`fills_recorded=false` 或成交无 `rt_seq` ⇒ `checked=0` + `mismatched=[]`（诚实留白）。
- `recorded=false` 路径下三字段保持零值占位（不在无事实时输出计数）。

### 1.6 写入侧（任务项 6）

- 引擎闭包内净值/回撤块之后**新增** `kind='position'` 分块（`position_chunk`，`chunk = RESULT_CHUNK_BARS`），
  payload = `PositionPoint[]` 对象数组；与 `net_value` **同点同序 ⇒ 同块数**（C5c 断言 `chunks(position) == chunks(net_value)` 且逐点同 ts/同 nav）。
- `legacy_single`：无 `position` 内联列 ⇒ `legacy_series` 回空数组 + `recorded=false`
  （**不得**把「无该序列」读成「无持仓」，C5b 锁定）。
- `recorded` 判定链**未**引入 position 依赖（`fills_all` 与 audit `recorded` 逐字不变）⇒ 新增序列不污染既有 recorded 语义。

---

## 2. C 段红转绿原始输出

### 2.1 红（实现前；新契约测试对旧源码）

命令（把 `crates/application/src/{workbench,audit}.rs` 还原至 P3 前索引态后执行）：

```
cargo test -p application --test workbench c
```

原始输出节选（全文 `10_red_c_section.txt`）：

```
error[E0425]: cannot find value `RT_RECONCILE_TOLERANCE` in module `application::audit`
error[E0599]: no method named `result_round_trips` found for struct `Arc<WorkbenchService>`
error[E0599]: no method named `result_round_trip_fills` found for struct `Arc<WorkbenchService>`
error[E0609]: no field `round_trip` on type `FillsResponse`
error[E0599]: no method named `result_fills_filtered` found for struct `Arc<WorkbenchService>`
error[E0609]: no field `recorded` on type `CurveResponse`
error[E0609]: no field `window_from_ts` on type `CurveResponse`
error[E0609]: no field `window_to_ts` on type `CurveResponse`
error[E0609]: no field `window_bars` on type `CurveResponse`
error[E0599]: no method named `result_curve_window` found for struct `Arc<WorkbenchService>`
```

（新端点/新字段在旧实现下**不存在** ⇒ 编译级红；契约测试先于实现落盘。）

### 2.2 绿（实现后）

```
cargo test -p application --test workbench
test c1_result_trades_element_is_v2_shape ... ok
test c2_round_trips_paging_and_summary ... ok
test c3_l2_slice_ownership_and_unknown_rt_seq_404 ... ok
test c4_fills_filter_and_element_increment ... ok
test c5_curve_position_kind_and_time_window ... ok
test c5b_legacy_single_position_is_empty_and_explicitly_unrecorded ... ok
test c5c_position_chunk_written_alongside_net_value ... ok
test c6_curve_rejects_fills_kind ... ok
test c7_audit_increments_and_per_round_trip_reconcile ... ok
test c8_completeness_on_all_list_endpoints ... ok
test result: ok. 53 passed; 0 failed; 0 ignored; 0 measured
```

（全文 `20_green_c_section.txt`；53 = 既有 43 + 本波 10。）

### 2.3 `cargo test -p application` 全绿

```
cargo test -p application
test result: ok. 47 passed; 0 failed; 0 ignored; ... (lib)
test result: ok. 2/2/6/3/3/57/41/3/53 passed; 0 failed; ... (各 integration target)
```

`mcp::real_db_*` 真库门禁测试按判据豁免（未在本机跑真库）。全文 `21_green_application.txt`。

### 2.4 `cargo build --workspace`

```
cargo build --workspace
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.86s
```

全文 `30_workspace_build.txt`。另 `cargo test -p web --no-run` 通过（web 路由/handler 新代码与全部既有 web 测试目标均可编译）。

---

## 3. C1–C8 覆盖对照

| ID | 用例（03-test-plan §3） | 落点 | 关键断言 |
|---|---|---|---|
| C1 | `/result` trades v2 形状 | `c1_result_trades_element_is_v2_shape` | 元素键集**精确相等**（既无漏字段亦无 v1 残留）；`status=Closed`；`l2_count ≥ 1` |
| C2 | `/round-trips` 分页与摘要 | `c2_round_trips_paging_and_summary` | `total/has_more/next_offset` 正确且分页拼接 = 全量；`l2_count == 该回合 fills 数`；`buy_count/sell_count` 与切片逐笔方向一致 |
| C3 | L2 切片 | `c3_l2_slice_ownership_and_unknown_rt_seq_404` | 归属正确（元素 `rt_seq` 全等 + `code` 注入 + §1.1 全字段非 null）；**未知 `rt_seq ⇒ WorkbenchNotFound(404)`** |
| C4 | `/fills?round_trip=` + 新字段 | `c4_fills_filter_and_element_increment` | 过滤后集合 == 该回合切片；4 新字段非 null；`recorded=false` 语义不变 |
| C5 | `/curve?kind=position` + 窗口 | `c5_curve_position_kind_and_time_window` + `c5b` + `c5c` | 窗口回显正确；`window_bars == 窗口内原始根数`；缺省全区间向后兼容；position 恒等式与 net_value 同点；legacy 空 + `recorded=false`；写侧 position 块 |
| C6 | `/curve` 拒 `kind=fills` | `c6_curve_rejects_fills_kind` | `WorkbenchValidation{code=kind_invalid}`（web ⇒ 400），窗口路径同样拒 |
| C7 | `/audit` 增量 | `c7_audit_increments_and_per_round_trip_reconcile` | `closed + open == total`、`closed == L1 回合数`、`open == 0`、`checked == L1 回合数`、`mismatched` 空；**反例**：篡改一笔 L2 佣金 ⇒ 该 `rt_seq` 被标出（禁静默） |
| C8 | 完整性契约 | `c8_completeness_on_all_list_endpoints` | `/fills`、`/round-trips`、L2、`/bars`、`/curve` 均自述完整性；首页截断 `has_more=true` |

**未覆盖**：C9（MCP 工具增量）—— 不在本波派工边界（见 §4）。

---

## 4. 未做项与原因

1. **C9 / MCP 工具增量**（`bt_get_run_round_trips`、`bt_get_run_round_trip_fills` 及 4 个字段/参数变更）：
   本波派工为「Rust 侧 application 与 domain 读模型与 web 路由」，MCP 契约（02-spec §6）不在本波边界；
   mcp crate 未调用 `WorkbenchService` 的 fills/curve 方法（经 grep 确认零调用点），故本波改动**不影响** mcp 编译。
2. **前端类型/交互（02-spec §7/§9）**：P5a/P5b 已有车道在动 `web/src`，本波不触碰。
3. **迁移 0028 入库 / `sim_trades` DDL**（02-spec §8）：P2 已生成未入库；DB 侧不在本波（application/web）边界。
4. **sim-live 运行中 L1/L2 读端点**（§6 末行「sim-live 新增运行中 L1/L2 读能力」）：属 sim-live 车道，
   本波未动 `application/src/simlive.rs`。
5. **web 层 HTTP 级 C 段测试**：既有 web 契约测试载体需真库；本波把 C1–C8 落在 application 读模型层
   （判据允许「可用既有测试载体与 mock 存储，不要求真库」）。web 层已通过 `cargo test -p web --no-run` 编译门禁，
   但**新路由的 HTTP 端到端断言未落盘** ⇒ 残余风险（见 §7）。

---

## 5. 契约偏差申报（需架构师确认）

`CurveResponse` 新增了 02-spec §4.2 响应信封**未列出**的字段 `recorded: bool`
（与 `window_*`/`window_bars` 同屏、恒序列化），语义 = 「该 kind 的序列事实源是否可得」。
理由：任务项 6 明确要求 legacy 无 `position` 列时「读侧回空数组并保证 recorded 语义正确（不得把『无该序列』读成『无持仓』）」，
而 §4.2 信封内**无任何字段**可承载该消歧（`original_bars=0` 与 `downsampled=false` 组合无法区分
「零持仓」与「未记录该序列」）；§5.6/ADR-027 D11 又要求全局自述完整性。

影响面：**纯加法**（新增键，既有键名/语义/顺序均未变，无既有断言依赖键集长度）⇒ 既有前端与 web 测试零影响。
若架构师裁定不得扩展 §4.2 信封，替代方案是把该披露移入新的 `/audit` 字段（但位置比语义更差）。
**未阻塞后续波次**，但请在闸门 1（契约一致性亲审）时裁决。

---

## 6. 既有测试的受控修改

- `crates/application/src/audit.rs::tests::report_serializes_frozen_field_names`：
  原断言 `AuditReport` 序列化键集**精确等于** ADR-026 §2.2 的 14 个字段。ADR-027 §5.5 批准 `/audit`
  增 3 字段 ⇒ 冻结集扩为 17 个（同一测试同时校验「键集相等」「无多出字段」「声明序 = 契约序」）。
  这是**契约演进**（spec 是唯一出口），非为让实现通过而放宽断言。
- 其余既有测试（含 `p6_fills_*`、`p4_*`、`adr026_run_audit.rs` 依赖的字段）**未改**，逐条绿。

---

## 7. 残余风险

1. **新路由无 HTTP 级测试**：`/round-trips` 与 `/round-trips/{rt_seq}/fills` 的 axum 路由/路径参数
   (`Path<(String, u32)>`) 仅经编译门禁，无真请求断言；`rt_seq` 非数字 ⇒ axum 默认 400（未显式锚定错误体）。
2. **`/fills` 未知 `round_trip` 返回空页**（非 404）：符合 §5.4 的既有分页契约，但若 UI 期望 404 需架构师明确。
3. **`original_bars` 语义**（窗口态 = 全序列根数）为本人裁决（§1.4）；spec 未逐字规定该字段在窗口态的口径，
   已在 C5 锁定，若架构师要求「窗口内根数」需同步改 `CurveResponse::original_bars` 与 C5 断言。
4. **audit 的两阶段合并**（`compute_audit` 产出零值占位 + 读侧在 `recorded` 门禁后合并）
   是 KISS 取舍：避免改动 `AuditInput` 从而破坏约 12 处表驱动单测字面量；代价是纯函数单独调用时三字段恒为零。
5. **`code` 读侧注入**：L2 元素 `code` 取自 run.symbol；若未来 run 支持多标的，必须改为引擎落库（当前回测单标的，成立）。
