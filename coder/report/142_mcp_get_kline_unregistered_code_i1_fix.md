# 142 — MCP get_kline 静默失败修复（I-1，P0）

> 报告自身位置：`eestock-rs/coder/report/142_mcp_get_kline_unregistered_code_i1_fix.md`

## 0. 一句话根因

`get_kline` 直接把 code 透传给 `KlineRead::bars` 后原样返回结果，**从未校验 code 是否在平台
标的注册表（`symbols` 表）内**——未注册代码查不到任何 bar，于是以「正常空结果 `bars: []` +
无 `isError`」返回，调用方无法区分「标的不存在」与「该标的该区间无数据」。

## 1. 变更文件清单（全部已 staged，未 commit）

| 文件 | 性质 | 行数 |
|---|---|---|
| `design/07-app-plane/01-mcp.md` | 事实源（ADR-007：代码由本文档 tangle 生成） | +182/−14 |
| `crates/mcp/src/tools.rs` | 生成物：修复 + 单测 | +63/−2 |
| `crates/mcp/src/mocks.rs` | 生成物：测试替身 `MockKline` 扩展注册表口径 | +34/−3 |
| `crates/mcp/tests/mcp_protocol.rs` | 生成物：SSE 全链路 I-1 断言 | +19/−1 |
| `crates/mcp/tests/mcp_tools_db.rs` | 生成物：真实注册表端到端 I-1 断言 + 注册表垫片 | +62/−3 |

`git status`（staged 之外无本次改动；其余 untracked 文件为他人/架构师产物，未触碰）：
`crates/mcp/src/{mocks,tools}.rs`、`crates/mcp/tests/{mcp_protocol,mcp_tools_db}.rs`、
`design/07-app-plane/01-mcp.md`。

## 2. 实现定位与判定口径

- **MCP 工具层**：`crates/mcp/src/tools.rs::get_kline`（分发入口 `call_tool` → `"get_kline"`）。
- **服务/仓储层**：`domain::ports::KlineRead`（storage 实现 `storage::reader::KlineReader`），
  REST `/api/kline` 与 MCP 共用同一端口。**未改该端口语义**（REST 行为保持不变，见 §7 残留风险）。
- **判定口径（以平台注册表为准，不以「有无 K 线」推断）**：`KlineRead::symbols_with_latest()`
  读 `symbols` 表（实测 44 行、全 `enabled=true`）。该口径与平台既有
  `application::simlive::validate_registered_stock`（ADR §4 修复：格式合法但未注册 → 拒）
  同源；数据面/应用层已有先例，本次只是把同一口径补到 MCP 查询面。
- 实现方式：新增私有 `async fn ensure_registered(&McpState, code)`，在 `get_kline` 参数校验
  **之后**、`bars()` **之前**调用；`Err` → 既有 `tool_fail`（`result.isError=true` + 可读消息）。
  **无新端口、无新依赖、无模块边界变更、无新工具**。

## 3. TDD 证据

### Red（先写测试，确认失败）

命令与输出（关键行）：

```
$ cargo test -p mcp
test tools::tests::get_kline_unregistered_code_is_tool_error ... FAILED
test tools::tests::get_kline_registry_failure_is_tool_error_fail_closed ... FAILED
  assertion `left == right` failed: 510300 未注册 → isError=true（非静默空数组）
    left: Null  right: true
  assertion `left == right` failed: 注册表不可查 → isError（fail-closed）
    left: Null  right: true
test result: FAILED. 45 passed; 2 failed

$ cargo test -p mcp --test mcp_protocol
test mcp_sse_full_protocol_roundtrip ... FAILED
  crates/mcp/tests/mcp_protocol.rs:274: 未注册 999999 → isError（P0 静默失败修复）
    left: Null  right: true
test result: FAILED. 1 passed; 1 failed

$ cargo test -p mcp --test mcp_tools_db
test get_kline_unregistered_code_is_tool_error_against_real_registry ... FAILED
  crates/mcp/tests/mcp_tools_db.rs:222: 510300 未注册 → isError=true（非静默空）
    left: Null  right: true
test result: FAILED. 3 passed; 1 failed
```

### Green（实现后全绿）

```
$ cargo test -p mcp
running 47 tests ... test result: ok. 47 passed; 0 failed
running  2 tests ... test result: ok. 2 passed; 0 failed      (mcp_protocol)
running  4 tests ... test result: ok. 4 passed; 0 failed      (mcp_tools_db，含新增 I-1 用例)
running  0 tests ... Doc-tests
$ cargo test -p mcp --no-run 2>&1 | grep -c warning  → 0

$ cargo check -p app -p web --all-targets   → Finished（无警告/错误）
$ ./scripts/check-tangle.sh                 → ✅ tangle 后无 diff（design 与生成物一致）
```

## 4. 新增/修改测试

新增 4 个用例（3 层覆盖）：

1. `tools::tests::get_kline_unregistered_code_is_tool_error`（单测）——`510300/999999/ABC123`
   三个未注册代码 → `result.isError=true`、消息含被拒 code 与「未注册」、**且 `bars` 未被调用**
   （`kline.calls` 为空 ⇒ 证明是注册表判定而非数据推断）。
2. `tools::tests::get_kline_registered_without_bars_is_empty_not_error`（单测）——已注册但区间
   无数据 → `isError` 不出现、`bars: []`（**语义区分**锁定）。
3. `tools::tests::get_kline_registry_failure_is_tool_error_fail_closed`（单测）——注册表查询失败
   → `isError`（fail-closed，与 sim-live 既有口径一致）。
4. `mcp_sse_full_protocol_roundtrip` 新增第 8b 步（协议级 E2E）——经真实 SSE 下发
   `get_kline{code:999999}` → `isError=true` + 消息含 code 与原因。
5. `get_kline_unregistered_code_is_tool_error_against_real_registry`（DB 集成，**只读**）——
   用**真实 `symbols` 表**（44 注册标的）跑三个未注册代码 → isError；518880 → 非错误对照。

测试替身改动（`mocks.rs`）：`MockKline` 增加 `registered`（注册表口径）/`empty_bars`/
`registry_fail` 与 `with_registered`，`new()` 缺省注册表 = `["518880"]`；`mcp_protocol.rs`
自带 mock 同步返回 `518880`（其用例代码）。

**不写库**：DB 集成测试原有 `get_kline_merged_accurate_first_via_tool` 用私有
`ShimKline`（bars/latest_bar 委派真实 `KlineReader`，仅 `symbols_with_latest` 换进程内集合），
避免向 `symbols` 控制表注册测试代码（ADR-017：写 `symbols` 即控制数据面采集）。

## 5. 线上帧证据（真实注册表 + 真实 storage 端口，临时探针跑完即删）

复现（修复前，对运行中的 :8082 实测，node SSE 探针）：`510300/999999/ABC123` 均返回
`{"bars": [], "code": …, "period": "1m"}`，**无 `isError`、无错误**。

修复后（同一装配，`mcp::rpc::dispatch` 直调，输出为线上 `result` 帧）：

```
code=510300 → isError=true
  content = 工具执行失败：标的 510300 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）
code=999999 → isError=true
  content = 工具执行失败：标的 999999 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）
code=ABC123 → isError=true
  content = 工具执行失败：标的 ABC123 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）
code=518880 → isError=null + 真实 bars（ts 2026-09-11T06:58Z…，source=tushare）
```

错误形态与「MCP 停用」同形：`{content:[{type:"text",text:…}], isError:true}`，走既有 `tool_fail`。
消息含**被拒代码 + 原因**（未注册/不在 `symbols` 注册表）+ 指引。参数级错误仍是 `-32602`
（注册校验在参数校验之后，`period/limit/code` 非法优先报协议错误——既有测试未变）。

## 6. 顺带排查结论（未扩大修改范围）

| 工具 | 模式 | 结论 |
|---|---|---|
| `get_sources_health` | 无 code 入参；窗口内无事件 → `sources: []`（实测 window=60 → `{"sources":[],"window_secs":60}`，`isError` 缺省） | **无标的存在性问题**（空集语义 = 窗口内无健康事件，合法）。属轻微歧义（可被读成"无数据源"），记录不改。 |
| `get_data_quality` | **同族缺陷（未注册代码无校验）**：实测 `code=999999` → `isError` 缺省、返回"正常"质量卡：`trading_day=true`、`expected_bars=241`、`actual_bars=0`、整日 `segments[].class="system_gap"` | **记录，未改**（红线：不改其他工具语义）。危害描述：把"标的不存在"报成"当日系统性缺口"，比 I-1 更易误导（污染数据质量判断）。建议单独立项（可作为 I-11）。 |
| `strategy_test_run` | 有 `symbol`，仅查非空、**不查注册表**；无 bar → 显式报错 `区间内无 K 线数据（symbol period from~to）` | **无静默空**（会报错）；但消息把"未注册"与"区间无数据"混为一谈，symbol 未做注册校验。属接口契约问题（I-3/D6 邻域），记录不改。 |
| `bt_run_ensemble`（`WorkbenchService::submit`） | `enabled_codes()` 校验：未注册 → `WorkbenchValidation("symbol 未注册: …")` | **已正确**（且为 `enabled` 口径）。 |
| `sim_*`（`sim_start_session` / `sim_place_order` 等） | `validate_registered_stock` + `registered_codes()`（fail-closed） | **已正确**（本次修复即对齐此口径）。 |
| `sim_run_backtest_compare` | 仅 `session_id`（会话标的在建会话时已校验） | 无新增入参 → 无此问题。 |

其他只读工具（`strategy_list/get`、`bt_get_run*`、`bt_list_*`、`sim_get_*`）均以 id/session
为主键且未命中即 `isError`（既有测试 `*_unknown_id_and_state_errors_are_is_error` 锁定），无"静默空"。

## 7. 残留风险 / 需上层知晓

1. **REST `/api/kline` 仍为静默空**（本次未动：任务红线限定 MCP 工具层）。`GET /api/kline?code=999999`
   依旧返回 `bars: []`。若要求两端一致，需另行授权。
2. **口径选择：注册表成员（含 `enabled=false`）**。本次按任务书"以平台注册表为准"取 `symbols`
   全表成员（与 `simlive::validate_registered_stock` 一致，当前 44 标的全部 enabled）；
   `bt_run_ensemble` 用的是 `enabled` 口径，二者对"已注册但停用"的标的判定不同。若上位要求
   统一为 `enabled` 口径（停用 → isError），属语义扩展，需拍板后改。
3. **注册表查询失败 = fail-closed**：`symbols_with_latest()` 出错时 `get_kline` 直接 isError
   （宁可拒也不放过）。与 sim-live 一致；若 DB 抖动，调用方会看到错误而非空结果。
4. `GitNexus` 影响面分析未能执行：`gitnexus impact/context` 对本仓库返回
   `LadybugDB unavailable … Database file version: 43, current build storage version: 40`
   （索引版本与 CLI 不匹配）。已改用手工爆炸半径核查：`get_kline` 仅被 `call_tool`（`rpc.rs`）
   调用；`ensure_registered` 为私有新函数；`MockKline`/`ShimKline` 仅测试内使用；
   `McpState` 结构未变（`app`/`web` 装配零影响，`cargo check -p app -p web` 通过）。
5. 未部署：运行中的 `eestock-app`（:8082）仍是修复前二进制；本次只到"已 staged、待架构师
   审核提交"，未重启服务、未改配置。

## 8. 红线遵守

- 未做架构重构、未加新工具、未改其他工具语义；`McpState`/端口/事件契约未动。
- DB 仅只读（`symbols` 表只 `SELECT`；新增 DB 集成用例不写任何表；探针跑完已删除）。
- 未 `git commit`（按要求 staging 供审核）。`entangled tangle` 后无 diff（门禁通过）。
- 未新增依赖（复用既有 `async-trait` dev-dep 与 `domain::ports::KlineRead`）。
