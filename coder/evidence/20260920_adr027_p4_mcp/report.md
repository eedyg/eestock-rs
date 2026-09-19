# P4 报告 —— 门禁修复（文档漂移）+ MCP 面增量（ADR-027 §6）

**报告自身位置**：`coder/evidence/20260920_adr027_p4_mcp/report.md`

**判词（前置）**：
**check-tangle 绿 ｜ MCP 工具增量 完成（新增 6 工具 + 2 处契约增量生效；§6 逐条对齐） ｜ workspace 编译 通过 ｜ 测试 绿（mcp 75 / application 全部，除真库环境门禁目标） ｜ 未做项 4**

---

## 0. 产物与证据索引

| 文件 | 内容 |
|---|---|
| `00_check_tangle_red.txt` | 门禁**修前**原始输出（红）：`WARNING crates/web/src/lib.rs not managed by Entangled` |
| `01_stitch_try1.txt` | `./scripts/stitch.sh` 原始输出（沙箱 scoped 回写 + round-trip 校验通过；仅 1 份文档回写） |
| `02_check_tangle_green.txt` | 门禁**修后**绿（MCP 改动前） |
| `03_check_tangle_post_mcp.txt` | MCP 改动 + tangle 完成后的门禁绿（**最终**） |
| `04_precommit.txt` | `bash .git/hooks/pre-commit`（= `scripts/check-tangle.sh`）原始输出，EXIT=0 |
| `10_red_mcp_increment.txt` | **TDD 红**：HEAD 生成物 + 新测试 ⇒ 两个新测试 FAILED（`payload_of` 取不到 payload，因未知工具名走 -32602） |
| `20_green_mcp_nondb.txt` | `cargo test -p mcp --lib`（68 passed）+ `--test mcp_protocol`（2 passed）+ `--test adr024_period_ssot_drift`（5 passed） |
| `20_green_mcp_full.txt` | `cargo test -p mcp` 全量输出（含真库门禁目标的**响亮失败**原文） |
| `21_green_application.txt` | `cargo test -p application` 全目标（0 failed） |
| `30_workspace_build.txt` | `cargo build --workspace` → `Finished` |
| `40_tool_names.txt` | 从生成物 `crates/mcp/src/tools.rs` 抽出的工具名单（bt_ 13 + sim_ 16） |

---

## 1. 第一件事：门禁修复（文档漂移，已绿）

### 1.1 现象与原始输出（红）

```
[check-tangle] ❌ entangled dry-run 报告冲突/未托管（生成物与 design/ 文档失同步）：
WARNING `crates/web/src/lib.rs` not managed by Entangled INFO nothing is done
```
（全文 `00_check_tangle_red.txt`）

根因：P3 车道在 `crates/web/src/lib.rs` 新增了两条 `/round-trips` 路由，但未把路由写回
`design/07-app-plane/00-web-api.md`（事实源）⇒ 生成物 ≠ 文档重新生成结果。

### 1.2 处置（O1 纪律：代码侧 → stitch 回写）

1. `./scripts/stitch.sh`（默认 scoped 回写）：检测到 1 个漂移生成物 → 沙箱 stitch →
   **round-trip 校验通过** → 回写 `design/07-app-plane/00-web-api.md`（+6 行，仅文档；生成物一字节未动）。
   原始输出见 `01_stitch_try1.txt`。
2. **偏差说明（与派单文本不同，按实测）**：派单称 `00-web-api.md` / `01-mcp.md` 含「代码块内嵌 `~/~ begin`
   遗留标记」会被 stitch 跳过 —— 实测两份文档当前 `grep -c '~/~ begin'` 均为 **0**，
   stitch **未跳过**、沙箱校验通过并自动回写。因此**未启用**「文档先行」旁路；两份文档均走
   `stitch（代码→文档）` 或 `entangled tangle（文档→生成物）` 的正规单向路径。
3. 复验：`./scripts/check-tangle.sh` → 绿（`02_check_tangle_green.txt`）；`bash .git/hooks/pre-commit` → EXIT=0。
4. **未使用** `entangled tangle --force`（D-F3-6）；亦未手改任何生成物。

### 1.3 回写内容（文档侧 diff）

```diff
         .route("/api/workbench/runs/{id}/fills", get(workbench::get_fills))
+        // ADR-027 §5.2/§5.3：L1 回合列表（懒加载首屏）+ L2 逐笔切片（未知 rt_seq ⇒ 404）
+        .route("/api/workbench/runs/{id}/round-trips", get(workbench::get_round_trips))
+        .route(
+            "/api/workbench/runs/{id}/round-trips/{rt_seq}/fills",
+            get(workbench::get_round_trip_fills),
+        )
```

---

## 2. 第二件事：MCP 面增量（文档先行 → tangle）

### 2.1 事实源与生成方式

- 事实源：`design/07-app-plane/01-mcp.md`（entangled 托管；含 `<<crates/mcp/src/tools.rs>>`、
  `rpc.rs`、`tests/mcp_protocol.rs` 三个产物块）。
- 路径：**先改文档**（工具 schema / dispatch / 实现 / 测试全在文档块内）→ 因仓库 filedb 缓存过期
  （`entangled tangle` 报 `changed outside the control of Entangled`），按 README 载明手段
   **`entangled reset` 重建缓存（只动 `.entangled/`）** → `entangled tangle` 生成产物。
  **全程未用 `--force`**；`reset` 前后对 249 个生成物做 sha256 抽检，**零字节变化**（消除「回退成果」风险）。
- 产物：`crates/mcp/src/tools.rs`（+611 行）、`crates/mcp/src/rpc.rs`（工具名单断言）、
  `crates/mcp/tests/mcp_protocol.rs`（工具计数 35→41）。

### 2.2 02-spec §6 逐条对照表

| §6 行 | 要求 | 落地 | 证据 |
|---|---|---|---|
| `bt_get_run_result` | `trades` 元素 = v2 形状（§5.1） | 透传引擎落库 v2 `trades`（无需 MCP 侧改写）；测试断言元素含 `rt_seq`/`status`/`l2_count` 等 v2 字段 | `20_green_mcp_nondb.txt`（`bt_trade_detail_increment_tools_contract`） |
| **`bt_get_run_round_trips`**（新增） | L1 列表（分页，同 §5.2） | ✅ 新增：`run_id` 必填 + `offset`/`limit`；经 `WorkbenchService::result_round_trips`；响应 `run_id/total/recorded/offset/limit/has_more/next_offset/round_trips` | 同上（L1 分页/完整性/摘要字段断言） |
| **`bt_get_run_round_trip_fills`**（新增） | L2 切片（同 §5.3） | ✅ 新增：`required=["run_id","rt_seq"]`；经 `result_round_trip_fills`；**未知 `rt_seq` ⇒ isError**（应用层 `WorkbenchNotFound`） | 同上（`rt_seq=9999` ⇒ isError） |
| `bt_get_run_curve` | 增 `from_ts`/`to_ts`，响应含 `window_*` 回显 | ✅（**该工具在 MCP 面此前不存在**，本次按 §6 新建）：`kind` enum `per_bar/net_value/drawdown/position` + `k` + `from_ts`/`to_ts`（闭区间），响应对齐 §4.2（`window_from_ts`/`window_to_ts`/`window_bars`/`downsampled`/`original_bars`/`recorded`）；`kind=fills` ⇒ **-32602**（事实源不可抽样，与 web `/curve` 同口径） | 同上（窗口回显/单点窗口/`k=1` 抽样/`position` 点六字段/非法 kind 矩阵） |
| `bt_get_run_fills` | 元素增 `rt_seq`/`trade_value`/`commission`/`stamp_duty`；增 `round_trip` 过滤 | ✅（**该工具在 MCP 面此前不存在**，本次按 §6 新建）：元素为该四字段（引擎写入）；`round_trip=<rt_seq>` 过滤；未命中 ⇒ 空页 `total=0`（**非错误**，404 语义归 L2 切片） | 同上（过滤后全归属、未知回合空页、limit=1 分页回声） |
| `bt_get_run_audit` | 增 §5.5 字段 | ✅ 字段随 application `RunAudit`（`#[serde(flatten)] AuditReport`）**已生效**：`round_trips_closed`/`round_trips_open`/`rt_reconcile{checked,mismatched,tolerance}`；本次改的是**文档事实源**（工具描述增 §5.5 语义与「`mismatched` 非空必须显式告警」纪律）+ 契约断言 | 同上（审计增量断言 + `mismatched==[]`） |
| **sim-live** | 新增「运行中 L1/L2」读（同 §5.2/5.3 形状，键 `session_id`+`code`） | ✅ 新增 `sim_get_round_trips(session_id, code?, offset?, limit?)` 与 `sim_get_round_trip_fills(session_id, code, rt_seq, offset?, limit?)`；经 `SimLiveService::round_trips` / `round_trip_fills`（复用**唯一聚合实现**，与结算同口径；未平仓 ⇒ `status=Open` + `pnl=null`）；**未知 `(code, rt_seq)` ⇒ isError** | `20_green_mcp_nondb.txt`（`sim_round_trip_tools_contract`） |

**工具面计数**：35 → **41**（4 只读 + **16** sim_* + 8 strategy_* + **13** bt_*）；名单序断言见
`crates/mcp/src/rpc.rs`、`crate::tools::tests::tool_list_schema_contract`、`tests/mcp_protocol.rs`（三处同步更新）。

### 2.3 实现要点（层内决策，未改层边界）

- 新增工具全部走**既有服务端口**：`WorkbenchService::{result_round_trips, result_round_trip_fills,
  result_fills_filtered, result_curve_window}`、`SimLiveService::{round_trips, round_trip_fills}`；
  MCP 层只做**参数校验（-32602）/ 错误映射（isError）/ 分页与形状组装**，无第二份聚合、无新依赖。
- 参数口径与 web **逐字段同源**：`page_params`（`offset` 缺省 0 负值归零；`limit` 缺省 5000 上限 20000
  = `application::workbench::{BARS_LIMIT_DEFAULT,BARS_LIMIT_MAX}`）、`curve_kind_param`（缺省 `net_value`、
  `fills` 拒绝）。
- 新增小工具函数：`opt_i64`/`opt_usize`/`opt_u32`/`req_u32`/`page_params`/`curve_kind_param`
  （集中在 `req_str` 旁，供后续工具复用）。
- **sim-live 分页在 MCP 层实现**（应用服务返回全量 `Vec`，P2 车道留给消费方分页）；形状按 §5.2/§5.3，
  键替换为 `session_id`+`code`（未过滤 `code` 回显 `null`，显式优于省略）。

### 2.4 TDD 证据（红 → 绿）

- **红**（`10_red_mcp_increment.txt`）：把**新测试**接到 **HEAD 版生成物**上运行 ⇒
  `bt_trade_detail_increment_tools_contract`、`sim_round_trip_tools_contract` 双双 **FAILED**
  （`payload_of` 在 tools/call 的 -32602 错误帧上取不到 payload = 工具不存在）。
  该核对在**单条命令内完成并自动还原**（`cmp` 校验：还原后与绿色产物逐字节一致，见命令回显）。
- **绿**（`20_green_mcp_nondb.txt`）：`cargo test -p mcp --lib` → **68 passed / 0 failed**
  （含两个新测试 + `tool_list_schema_contract` 的 41 计数与必填/枚举契约）。

---

## 3. 验证与门禁（原始输出落盘）

| 判据 | 结果 | 证据 |
|---|---|---|
| `./scripts/check-tangle.sh` | ✅ EXIT=0（沙箱重新生成 + 逐字节比对；工作区未被修改） | `03_check_tangle_post_mcp.txt` |
| `bash .git/hooks/pre-commit` | ✅ EXIT=0 | `04_precommit.txt` |
| `cargo build --workspace` | ✅ `Finished` | `30_workspace_build.txt` |
| `cargo test -p mcp --lib` | ✅ 68 passed / 0 failed | `20_green_mcp_nondb.txt` |
| `cargo test -p mcp --test mcp_protocol` | ✅ 2 passed | 同上 |
| `cargo test -p mcp --test adr024_period_ssot_drift` | ✅ 5 passed | 同上 |
| `cargo test -p application`（全目标） | ✅ 0 failed（lib 47 / simlive 57 / strategy 41 / workbench 53 / …） | `21_green_application.txt` |
| `cargo test -p mcp`（真库目标） | ⛔ 按设计**响亮失败**：`d11_fee_profile_e2e` 等报 `EESTOCK_TEST_DATABASE_URL` 未设置（验收豁免的真库门禁） | `20_green_mcp_full.txt` |

---

## 4. 未做项与残差（诚实留白）

1. **真库 MCP 目标未运行**：`crates/mcp/tests/{d11_fee_profile_e2e,d6_dca_interval,mcp_tools_db,
   tester_p4_mcp_indep}.rs` 需 `EESTOCK_TEST_DATABASE_URL`（本环境未提供）⇒ 新工具**未经真库端到端**
   验证（已用内存 mock store + 真实 QuickJS 引擎跑通 run 全流程）。
2. **`/fills` 元素不含 `code`（P3 读径现状，非本波改动）**：§1.1 把 `code` 定义为 FillFact **必需**字段，
   但 `WorkbenchService::result_fills_filtered` 只在 L2 切片（`result_round_trip_fills`）补 `code`，
   `/fills` 元素缺该键（回测 run 单标的，语义无歧义）。本波按 §5.4 字面（`rt_seq`+费用三件套）断言，
   已在测试内注明；**建议架构侧裁决**：或补 `code`（P3 侧 + 文档），或在 §1.1/§5.4 显式豁免。
3. **sim-live L1/L2 的 web 端点未开**：本波只做 MCP 面（派单边界：不动 `web/src` 前端；`crates/web`
   的 sim-live 路由不属 P4 范围）。若后续 web 也要同能力，应把分页/响应组装下沉到 application
   （当前在 MCP 工具层，存在双份分页逻辑的**潜在 DRY 债**）。
4. **§6 措辞与现实的偏差已按现实落地**：`bt_get_run_curve` / `bt_get_run_fills` 在 MCP 面**原本不存在**
   （`grep` 全仓仅命中文档），故不是「增参数」而是**新建工具**（tool 描述按 §6 要求书写，并披露
   `recorded` 完整性语义）。`design/16-backtest-scalability/02-spec.md` 曾倾向「复用 `bt_get_run_result`
   减少工具面」，本波按更新的 ADR-027 §6 执行（工具面 +4）；如需回落请架构侧裁决。

---

## 5. 变更清单（本波）

| 文件 | 变化 |
|---|---|
| `design/07-app-plane/00-web-api.md` | +6：P3 新增 `/round-trips{,/{rt_seq}/fills}` 路由回写（门禁修复，stitch） |
| `design/07-app-plane/01-mcp.md` | +644/-…：§1.3 工具清单prose、6 个工具 schema、dispatch、实现、helper、测试（含计数 41） |
| `crates/mcp/src/tools.rs` | +611（tangle 生成，禁手改） |
| `crates/mcp/src/rpc.rs` | 工具名单断言 +6 |
| `crates/mcp/tests/mcp_protocol.rs` | 工具计数 35→41 |
| `coder/evidence/20260920_adr027_p4_mcp/**` | 本报告 + 11 份原始输出 |

**未触碰**：`web/src/**`（前端）、`crates/application|domain|backtest|web` 的既有实现语义
（只读调用其公开方法，零改动）、迁移、Cargo 依赖。
**未暂存**：`design/17-trade-detail-layering/02-spec.md`、`design/01-architecture/adr/ADR-023-*.md`
（属其它车道/架构侧的既有工作区改动，不在本波范围，故意不 `git add`）。
