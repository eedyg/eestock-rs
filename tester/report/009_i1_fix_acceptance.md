# 009 — I-1（MCP `get_kline` 未注册代码静默失败）独立验收判决报告

> 报告自身位置：`eestock-rs/tester/report/009_i1_fix_acceptance.md`
> 类型：**判决报告 / 执行验收**（复用上一轮已留存证据，本轮未新增测试设计；仅补 1 份新鲜佐证）
> 被验对象：`crates/mcp/src/{tools,mocks}.rs`、`crates/mcp/tests/{mcp_protocol,mcp_tools_db}.rs`、
> `design/07-app-plane/01-mcp.md`（均已 staged、未 commit）
> 修复报告：`eestock-rs/coder/report/142_mcp_get_kline_unregistered_code_i1_fix.md`
> HEAD：`6e06aa9aa68ec550bd9a4e47618c2c27d733f2ac`（master）
> 本报告生成时间：2026-09-12T04:35Z（本地 12:35）

---

## 0. 判决结论（先给结论）

| 项 | 判决 | 一句话 |
|---|---|---|
| ① 修复前基线（生产 :8082 未注册仍静默空＝生产未被擅自重启） | **通过** | 生产 PID 3696673 自始未重启，仍返回静默空 |
| ② 修复后未注册 → `isError=true` 且消息含代码+原因 | **通过** | 3 个未注册 code 全命中，消息含 code 与「未注册」 |
| ③ 已注册但区间无数据 → 正常空 bars 且无 `isError`（两语义可区分） | **通过** | 已注册空区间 `isError` 缺省；同链路未注册仍 `isError` |
| ④ 注册表不可用 → fail-closed | **通过** | 注入注册表故障 → `isError=true` |
| ⑤ 回归面（REST / 只读工具无行为变化） | **通过（含明确未覆盖标注）** | 6 只读工具帧逐字节等价；REST 未动（在线帧对比未做） |
| ⑥ `cargo test -p mcp` 全量 + check-tangle 一致性 | **通过** | 53/53 绿；tangle 无 diff |
| ⑦ 进程卫生：未新增替代端口实例 | **通过** | 无残留替代端口进程 |

### **I-1 修复 = 通过（PASS）**

无 failed 用例、无 crash/core dump、无源码/接口修改、未 commit、无可归因本次测试的新增常驻进程。
残留风险见 §9。

---

## 1. 证据清单（均位于 `eestock-rs/tester/evidence/`，上一轮产出 + 本轮 1 份新增）

| 证据文件 | 用途 | 生成时刻 |
|---|---|---|
| `baseline_prod_8082.txt` | ① 生产 :8082 修前 `get_kline` 静默空基线 | 12:04 |
| `prod_8082_regression.txt` | ⑤ 生产 :8082 只读工具回归帧 | 12:06 |
| `rest_prod_8081_baseline.txt` | ⑤ REST `/api/kline` 修前基线 | 12:04 |
| `prod_periphery_probe.txt` | ⑤ 生产外围绕工具（strategy_test_run/bt_run_ensemble/sim_start_session） | 12:07 |
| `i1_sse_harness_raw.txt` | ②③④⑤ 真链路 SSE 修复后取证（A/B/C/D/E 分组） | 12:06 |
| `compare_frames.mjs` + `compare_frames_result_strict.txt` | ⑤ 修前生产 vs 修后测试实例只读工具帧逐字节对比 | 12:06 |
| `compare_before_after.mjs` + `compare_before_after_result.txt` | ② get_kline 修前 vs 修后语义对比 | 12:07 |
| `process_hygiene.txt` | ⑦ 进程/端口卫生 | 12:07 |
| `cargo_test_mcp.txt` | ⑥ `cargo test -p mcp` 全量 | 12:04 |
| `cargo_check_workspace.txt` / `cargo_clippy_mcp.txt` | 编译门禁 | 12:07 |
| `check_tangle.txt` + `design_block_vs_file.txt` | ⑥ design↔生成物一致性 | 12:07 |
| `cargo_test_web.txt` | ⑤ REST/web 回归套件 | 12:07 |
| **`i1_reprobe_fresh_20260912.txt`** | **①⑤⑦ 本轮新鲜佐证（生产未重启复核）** | **04:35（本轮）** |

修夹具（上一轮留存，不在实现范围内）：
`crates/mcp/tests/zz_tester_i1_acceptance.rs`（untracked；真实 DB 注册表 + 真实 storage + 真实 axum SSE 链路）。

被验代码的 staged 摘要（`git diff --cached --stat`）：
`mocks.rs +34/-3`、`tools.rs +63/-2`、`mcp_protocol.rs +19/-1`、`mcp_tools_db.rs +62/-3`、
`01-mcp.md +182/-14`；`git diff`（工作区 vs index）为空 ⇒ 证据对应的代码即 staged 版本。
staged blob 哈希：`tools.rs b16fdc9`、`mocks.rs fc0487f`、`mcp_protocol.rs f085738`、`mcp_tools_db.rs a521fac`、`01-mcp.md c3ca025`。
各 staged 文件 mtime ≤ 11:58，**早于全部证据生成时刻（≥12:04）** ⇒ 证据确实针对修复后代码。

---

## 2. ① 修复前基线：生产 :8082 未注册代码仍静默空（＝生产未被擅自重启）

**判定：通过。**

原始输出（`baseline_prod_8082.txt`，生产 :8082，node SSE 探针）：

```
## tools/call get_kline {"code":"510300"}
# SSE frame: {"id":100,"jsonrpc":"2.0","result":{"content":[{"text":"{\n  \"bars\": [],\n  \"code\": \"510300\",\n  \"period\": \"1m\"\n}","type":"text"}]}}
## tools/call get_kline {"code":"999999"}
# SSE frame: {"id":101,"jsonrpc":"2.0","result":{"content":[{"text":"{\n  \"bars\": [],\n  \"code\": \"999999\",\n  \"period\": \"1m\"\n}","type":"text"}]}}
## tools/call get_kline {"code":"ABC123"}
# SSE frame: {"id":102,"jsonrpc":"2.0","result":{"content":[{"text":"{\n  \"bars\": [],\n  \"code\": \"ABC123\",\n  \"period\": \"1m\"\n}","type":"text"}]}}
```

即：修前未注册代码 = `bars: []` 且 **无 `isError` 字段**（静默失败），与调用方无法区分「标的不存在 / 该区间无数据」。

**「生产未被擅自重启」证据**（`process_hygiene.txt` + 本轮 `i1_reprobe_fresh_20260912.txt`）：

```
--- 3696673 start vs staged-fix mtime ---
3696673 Fri Sep 11 11:24:16 2026  1-00:43:31 target/debug/eestock-app --config /tmp/app_dev_8081.toml
2026-09-12 11:57:52.617842507 +0800 ../../crates/mcp/src/tools.rs
```

本轮新鲜复核（2026-09-12T04:35Z）：

```
--- ss listeners ---
LISTEN ... 0.0.0.0:8081  users:(("eestock-app",pid=3696673,fd=11))
LISTEN ... 0.0.0.0:8082  users:(("eestock-app",pid=3696673,fd=12))
--- eestock-app procs ---
3696673 3696671 eestock  Fri Sep 11 11:24:16 2026  1-01:10:43 target/debug/eestock-app --config /tmp/app_dev_8081.toml
## tools/call get_kline {"code":"510300"}
# SSE frame: {"id":100,...,"text":"{\n  \"bars\": [],\n  \"code\": \"510300\",\n  \"period\": \"1m\"\n}",...}}
```

进程启动时刻（Sep 11 11:24:16）**早于**修复文件 mtime（Sep 12 11:57:52），且本轮复测 :8082 仍静默空
⇒ 生产实例运行的是修前二进制，**本次修复未部署、未重启服务**（符合「staged 待审核」约束）。

---

## 3. ② 修复后未注册代码 → `isError=true`，消息含代码 + 原因

**判定：通过。**

原始输出（`i1_sse_harness_raw.txt`，tag `A-real`：真实 DB 注册表 + 真实 `storage::reader::KlineReader`
+ 真实 axum SSE 链路，注册表实测 `n=44` 且 `REGISTRY_CONTAINS 510300/999999/ABC123 = false`）：

```
FRAME [A-real] {"id":10,...,"result":{"content":[{"text":"工具执行失败：标的 510300 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）","type":"text"}],"isError":true}}
FRAME [A-real] {"id":11,...,"text":"工具执行失败：标的 999999 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）",...,"isError":true}}
FRAME [A-real] {"id":12,...,"text":"工具执行失败：标的 ABC123 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）",...,"isError":true}}
```

覆盖三要素：`isError=true` ✓、**消息含被拒 code**（510300/999999/ABC123）✓、
**消息含原因**（「未注册（不在平台 symbols 注册表内）」+ 指引）✓。

修前 vs 修后语义对比（重跑 `compare_before_after.mjs`，确定性输出）：

```
=== get_kline code=510300 ===
prod(修前) isError=false  text="{\n  \"bars\": [],\n  \"code\": \"510300\",\n  \"period\": \"1m\"\n}"
harness(修后) isError=true  text="工具执行失败：标的 510300 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）"
payload_identical=false  behavior_changed=true
（999999 / ABC123 同形；518880 已注册 → payload_identical=true, behavior_changed=false）
```

补充：错误走既有 `tool_fail`（`result.isError=true`），非 `-32602` 协议帧；参数非法仍优先报协议错误
（见 §8 E 分组）。单测 `get_kline_unregistered_code_is_tool_error` 亦断言 `kline.calls` 为空（未落到取数），
证明判定依据是注册表而非数据推断。

---

## 4. ③ 已注册但区间无数据 → 正常空 bars 且无 `isError`（两语义可区分）

**判定：通过。**

原始输出（`i1_sse_harness_raw.txt`，tag `B-empty-real-registry`：注册表委派**真实 DB**、
`bars` 垫片恒空＝「已注册但区间无数据」）：

```
TOOL get_kline ARGS {"code":"518880"}  => TAG [B-empty-real-registry]
  result.content[0].text = "{\n  \"bars\": [],\n  \"code\": \"518880\",\n  \"period\": \"1m\"\n}"
  result.isError       = （缺省 / 无）
TOOL get_kline ARGS {"code":"510300"}  => TAG [B-empty-real-registry]
  result.content[0].text = "工具执行失败：标的 510300 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）"
  result.isError         = true
```

同一注册表链路下：**已注册 518880 + 空区间 → 正常空 `bars` 且无 `isError`**；
**未注册 510300 → `isError=true`**。两语义**可区分** ✓。

单测佐证（`cargo_test_mcp.txt`）：`tools::tests::get_kline_registered_without_bars_is_empty_not_error ... ok`。
（另注：`518880` 在 §3 A-real 中 `period=1d limit=3` 返回真实 bars，说明其确为已注册标的。）

---

## 5. ④ 注册表不可用 → fail-closed

**判定：通过。**

原始输出（`i1_sse_harness_raw.txt`，tag `C-registry-down`：注册表查询注入故障
`injected registry outage (tester)`，`bars` 委派真实 storage）：

```
TOOL get_kline ARGS {"code":"518880"}  => TAG [C-registry-down]
  result.content[0].text = "工具执行失败：标的注册表查询失败：injected registry outage (tester)"
  result.isError         = true
```

即注册表不可确认时**拒绝查询（fail-closed）**，而非退回静默空 ✓。
单测佐证：`get_kline_registry_failure_is_tool_error_fail_closed ... ok`。

---

## 6. ⑤ 回归面：REST `/api/kline` 与只读工具无行为变化

**判定：通过（含明确未覆盖项）。**

### 6.1 只读工具帧逐字节对比（修前生产 :8082 vs 修后测试实例）

`compare_frames_result_strict.txt`（本轮重跑 `compare_frames.mjs` 输出一致，确定性）：

```
MATCH  get_sources_health {"window_secs":60}                 (payload bytes identical, 101 chars)
MATCH  get_data_quality {"code":"518880","date":"2026-09-10"} (payload bytes identical, 350 chars)
MATCH  get_data_quality {"code":"999999","date":"2026-09-10"} (payload bytes identical, 1310 chars)
MATCH  strategy_list {}                                       (payload bytes identical, 42016 chars)
MATCH  bt_list_runs {}                                        (payload bytes identical, 191541 chars)
MATCH  sim_list_sessions {}                                   (payload bytes identical, 8104 chars)
# compared=6 identical=6 differing=0
```

- `get_sources_health`：**无行为变化**（逐字节等价）✓
- `get_data_quality`：**无行为变化** ✓（含 `code=999999` 的「同族缺陷」质量卡原样保留 ⇒ 未越界改动，与修复报告 §6 一致）
- `strategy_list` / `bt_list_runs` / `sim_list_sessions`：**无行为变化** ✓

### 6.2 REST `/api/kline`

问题红线限定 MCP 工具层；staged 变更集**不含** `crates/web`。当前生产 :8081 实测（本轮新鲜）：

```
--- code=510300 --- HTTP/1.1 200 ... {"code":"510300","period":"1d","bars":[],"next_before":null}
--- code=518880 --- HTTP/1.1 200 ... {"code":"518880",...,"bars":[ ... 2 bars ... ],"next_before":"..."}
```

- **生产 REST 行为未变**（未注册仍静默空；这是**修前**生产进程，本轮复测与 `rest_prod_8081_baseline.txt` 一致）✓
- staged 变更集不触及 `crates/web`，REST 处理路径无改动 ✓
- 回归套件 `cargo_test_web.txt`：43（lib）+ 2+3+2+1+1+1+2+6+9+6+1 = 全部 `ok`，含 REST K 线契约用例
  `api_rest::kline_cursor_pagination_cagg_and_validation ... ok` ✓

> **未覆盖（如实标注）**：未对「修复后二进制的 REST `/api/kline`」单独做在线帧对比（仅覆盖修前生产 + 代码范围 + web 回归套件）。

### 6.3 外围工具（`strategy_test_run` / `bt_*` / `sim_*`）

- `bt_list_runs` / `sim_list_sessions`：见 §6.1，逐字节等价 ✓
- `strategy_test_run` / `bt_run_ensemble` / `sim_start_session`：`prod_periphery_probe.txt`（**修前生产** :8082）
  给出参数校验帧（`-32602`）作为基线，**无修后在线帧对照**；但 staged 变更集不含这三个工具的实现路径，
  且 `cargo_test_mcp.txt` 中 `strategy_test_run_inline_and_version_modes`、`bt_run_ensemble_*`、
  `sim_start_session_*` 全部 `ok`。
  > **未覆盖（如实标注）**：上述三工具的「修前 vs 修后在线帧」对比**未做**。

`prod_periphery_probe.txt` 原始帧（修前生产）：

```
## tools/call strategy_test_run {"symbol":"999999",...} -> {"error":{"code":-32602,"message":"code 与 version_id 须恰提供一个（二选一）"}}
## tools/call bt_run_ensemble {"symbol":"999999"} -> {"error":{"code":-32602,"message":"period 必填（M1/M5/M15/D1）"}}
## tools/call sim_start_session {"name":"i1-tester-probe","stock_set":["999999"]} -> {"error":{"code":-32602,"message":"period 必填"}}
```

---

## 7. ⑥ `cargo test -p mcp` 全量 + check-tangle 一致性

**判定：通过。**

`cargo_test_mcp.txt`：

```
running 47 tests  (unittests src/lib.rs)        test result: ok. 47 passed; 0 failed; 0 ignored
running  2 tests  (tests/mcp_protocol.rs)      test result: ok. 2 passed; 0 failed; 0 ignored
running  4 tests  (tests/mcp_tools_db.rs)      test result: ok. 4 passed; 0 failed; 0 ignored
running  0 tests  (Doc-tests mcp)              test result: ok. 0 passed; 0 failed; 0 ignored
```

合计 **53 passed / 0 failed / 0 ignored**。含本轮 I-1 三单测与 DB 集成用例：

```
test tools::tests::get_kline_unregistered_code_is_tool_error ................... ok
test tools::tests::get_kline_registered_without_bars_is_empty_not_error ........ ok
test tools::tests::get_kline_registry_failure_is_tool_error_fail_closed ........ ok
test get_kline_unregistered_code_is_tool_error_against_real_registry ........... ok
```

编译门禁：`cargo_check_workspace.txt` = `Finished dev profile in 1.50s`（无 error）；
`cargo_clippy_mcp.txt` = `Finished dev profile in 2.69s`（无 warning）。

design↔生成物一致性：

```
check_tangle.txt:        [check-tangle] ✅ tangle 后无 diff，design 与生成物一致。
design_block_vs_file.txt: `# doc-blocks (markers stripped) ok=8 bad=0`
    （tools.rs / mocks.rs / mcp_protocol.rs / mcp_tools_db.rs 等 8 个 doc-block 全部 MATCH）
```

---

## 8. ⑦ 进程卫生：本次工作未新增替代端口实例

**判定：通过。**

`process_hygiene.txt`（上一轮，12:07）与本轮新鲜复核
（`i1_reprobe_fresh_20260912.txt`，2026-09-12T04:35Z）一致，无替代端口 `eestock-app`：

```
--- ss listeners ---
127.0.0.1:18082  eestock-app pid=1858479   （既有 app_smoke.toml 实例，Sep 4 起）
127.0.0.1:18081  eestock-app pid=1858479
0.0.0.0:8081     eestock-app pid=3696673   （生产 dev 实例）
0.0.0.0:8080     （无属主）
0.0.0.0:8082     eestock-app pid=3696673   （生产 MCP 实例）
--- eestock-app procs ---
1858479 ... Fri Sep  4 13:24:52 2026  target/debug/eestock-app --config /tmp/app_smoke.toml
3696673 ... Fri Sep 11 11:24:16 2026  target/debug/eestock-app --config /tmp/app_dev_8081.toml
```

- 仅两个既有 `eestock-app` 实例，**无本次工作新起的替代端口常驻实例**。
- 取证夹具 `zz_tester_i1_acceptance.rs` 采用进程内 `TcpListener::bind("127.0.0.1:0")`（临时端口，测试结束即随进程释放），
  不产生常驻监听。
- 两个既有实例启动时刻均**早于**取证时刻，非本次工作所起。

（`process_hygiene.txt` 另记录 `515249 eestock-data`、`1343090/1343124 scrylink-*` 等无关进程，均非本次产物。）

---

## 9. 缺口、未覆盖项与残留风险（不分析失败，仅如实记录）

1. **本轮未新增测试设计**：全部复用上一轮证据 + 1 份新鲜生产复核；无新失败、无 crash/core dump（harness `test result: ok. 1 passed`）。
2. **未覆盖**：修复后二进制的 **REST `/api/kline` 在线帧对比**（仅覆盖修前生产 + 代码范围 + web 回归套件）。
3. **未覆盖**：`strategy_test_run` / `bt_run_ensemble` / `sim_start_session` 的「修前 vs 修后在线帧」对比
   （仅覆盖修前生产参数校验帧 + 单测全绿 + 变更集不含其实现路径）。
4. **语义继承（非本次缺陷）**：`get_data_quality` 对未注册 `code` 仍返回「正常」质量卡（compare_frames 中
   `code=999999` 逐字节等价 ⇒ 语义未变），与修复报告 §6「同族缺陷、记录不改」结论一致。
5. **口径未决**：注册表成员判定采用 `symbols` 全表成员（含 `enabled=false` 成员取「已注册」），与
   `bt_run_ensemble` 的 `enabled` 口径存在差异——属既有设计选择，需上位拍板，非本次验收阻断项。
6. **生产仍为修前二进制**：:8082 实测静默空 ⇒ 修复尚未部署（符合「staged 待审核」约定）。若验收要求线上生效，需另行授权部署。
7. **GitNexus 影响面工具不可用**（修复报告 §7.4 记录：LadybugDB 版本不匹配），已用手工爆炸半径核查代替；
   本次验收未依赖该工具。

---

## 10. 结论

**I-1 修复 = 通过（PASS）。**

①–⑦ 全部通过：修前基线成立且生产未被重启（①）；未注册 → `isError` 含代码+原因（②）；
已注册无数据 → 空 bars 无 `isError`、两语义可区分（③）；注册表故障 fail-closed（④）；
回归面 6 只读工具逐字节等价、REST 范围未触及（⑤，附 2 项未覆盖标注）；
`cargo test -p mcp` 53/53 绿 + tangle 一致（⑥）；无新增替代端口实例（⑦）。

无 failed 用例、无 crash/core dump；未修改实现、未新增常驻进程、未 `git commit`（5 个被验文件保持 coder 的 staged 状态）。
