# P4c 报告 —— ADR-027 闸门 2 三处后端一致性修复（L-1 `/fills` 元素 `code`、L-3 `round_trip` 未知 ⇒ 404、L-2 参数形态错误 ⇒ 结构化信封）

**报告自身位置**：`coder/evidence/20260920_adr027_p4c_consistency/report.md`

**判词（前置）**：
**code 字段：完成（`/fills` 元素与 L2 切片键集逐字段一致，含 `code`，真值 = run 的 symbol） ｜ round_trip 404：完成（未知 `rt_seq` ⇒ `WorkbenchNotFound` ⇒ HTTP 404，与 `/round-trips/{rt_seq}/fills` 对称；`recorded=false` 不再被误判为「回合不存在」） ｜ 错误信封：完成（`?round_trip/offset/limit=非数字` 与路径 `{rt_seq}` 非数字 ⇒ 400 `{"error":{code:"request_invalid",message,detail:{param,reason}}}`，禁纯文本） ｜ 测试：绿（`cargo test -p application` EXIT=0，全 12 个目标 0 failed；新增 `cargo test -p web --test adr027_fills_param_shape` 2 passed；`cargo build --workspace` EXIT=0） ｜ check-tangle：绿（EXIT=0，沙箱重新生成 + 逐字节比对）**

**纪律遵守**：本波**未**执行任何 `TRUNCATE` / `DELETE` / `DROP TABLE`，**未**新增任何破坏性 SQL；**未**运行任何写库测试（新增 web 用例走 lazy 不可达池，**零连库**）；`entangled` 只用 `tangle`（无 `--force`、无 `reset`）。

---

## 0. 产物与证据索引（全部原始输出落盘）

| 文件 | 内容 |
|---|---|
| `00_check_tangle_baseline.txt` | 门禁**修前**基线（绿 ⇒ 后续若红必属本波） |
| `10_red_application_c4.txt` | **红**：`cargo test -p application --test workbench c4` —— `code` 缺失 + 未知 `round_trip` 返回 `Ok`（200 空数组） |
| `11_red_web_param_shape.txt` | **红**：`cargo test -p web --test adr027_fills_param_shape` —— 纯文本 `Failed to deserialize query string: round_trip: invalid digit found in string`（L-2 复现） |
| `20_green_web_param_shape.txt` | **绿**：同用例 2 passed（信封形状 + 负向对照） |
| `21_green_application_c4.txt` | **绿**：`c4` + `c4b` 2 passed |
| `30_tangle_writeback.txt` | `entangled tangle` 原始输出（只写 `crates/mcp/src/tools.rs`，EXIT=0；前后 sha256） |
| `31_check_tangle_green.txt` | **最终态**门禁绿（最终代码 + 文档 + 生成物全部落盘后重跑） |
| `40_application_tests.txt` | `cargo test -p application` **全目标** EXIT=0（47/2/2/2/6/3/3/57/41/3/**54**/0 passed，0 failed） |
| `50_workspace_build.txt` | `cargo build --workspace` → `Finished`，EXIT=0 |
| `60_mutation_l1_has_teeth.txt` | **突变验证**：去掉 `/fills` 的 `code` 补全 ⇒ `c4` 响红（证明断言有牙）；随后还原 |

---

## 1. 事实源（parent 已更新，本波只读不改）

`design/17-trade-detail-layering/02-spec.md` §5.4 冻结：
- 元素增 `code`（L-1）；
- `round_trip` 指向**不存在的 `rt_seq`** ⇒ **404**（与 §5.3 对称，禁 200 空数组）；
- 校验失败（含非数字 `rt_seq` 等**参数形态**错误）⇒ **结构化错误信封**，禁纯文本 400。

---

## 2. L-1：`/fills` 元素增 `code`（与 L2 切片同形状）

**改动**：`crates/application/src/workbench.rs::result_fills_filtered`
—— 读径取 `let run = self.get_run(run_id).await?;`，对**过滤后**的每笔事实套用既有单点投影
`Self::with_code(f, &run.symbol)`（`sim-live` 侧仍由会话内标的携带；回测 = run 的 symbol）。
归一化发生在**响应出口**，故 chunked（`kind='fills'` 块）与 legacy（内联 per_bar 派生）**两条读径同时**获得 `code`。

**红（`10_red_application_c4.txt`）**
```
test c4_fills_filter_and_element_increment ... FAILED
panicked at crates/application/tests/workbench.rs:2400:13:
fills 元素增字段 code 缺失
```

**绿（`21_green_application_c4.txt`）**
```
test c4_fills_filter_and_element_increment ... ok
test c4b_fills_round_trip_unknown_seq_is_404_symmetric_with_l2 ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 52 filtered out
```
断言强度（防「只加一个字段」的浅覆盖）：`c4` 进一步断言
**`/fills` 元素键集 == L2 切片元素键集**（同一事实源禁两种形状）且必含 `code`，`code == "600000"`（= run symbol）。

**突变验证（`60_mutation_l1_has_teeth.txt`）**：把 `/fills` 的 `with_code` 调用替换为 `all.to_vec()`（等价于回退 L-1）
⇒ `c4` 立刻响红（`fills 元素增字段 code 缺失`）；已还原（还原后 `c4`/`c4b` 复跑绿）。

---

## 3. L-3：`/fills?round_trip=<未知 rt_seq>` ⇒ 404

**改动**：`crates/application/src/workbench.rs::result_fills_filtered`
—— 过滤分支前先做**存在性校验**：`round_trip=Some(rt)` 时以 **L1 回合账本**（`res.trades`，ADR-027 D7 唯一聚合实现的物化结果）
判定 `rt` 是否属于该 run，不存在 ⇒ `WorkbenchNotFound` ⇒ web `map_svc_err` ⇒ **HTTP 404**。

**为什么以 L1 账本（而非「过滤后是否为空」）判定**：后者会把 `recorded=false`（事实源**未写**，P6 之前的 chunked run）
误判为「回合不存在」——那会让既有语义（`recorded` 只表达「事实源是否可得」）被 404 污染。退回路径：
L1 账本不可得（`trades` 非数组）时退化为「有归属成交即存在」。

**红（`10_red_application_c4.txt`）**
```
panicked at crates/application/tests/workbench.rs:2447:78:
called `Result::unwrap_err()` on an `Ok` value:
FillsResponse { run_id: "sr_1788915600000_000001", total: 0, offset: 0, limit: 5000,
  has_more: false, next_offset: None, recorded: true, round_trip: Some(1001), fills: [] }
```
（即 L-3 的原始症状：未知回合 **200 + 空数组**。）

**绿**：见上 `21_green_application_c4.txt`。`c4b` 断言：
① 已知回合仍 200 且过滤生效（防「整条过滤路径变 404」的过度修复）；
② 未知回合 ⇒ `WorkbenchNotFound`；
③ **对称性**：同一未知 `rt_seq` 在 `/fills` 与 `/round-trips/{rt_seq}/fills` 得到**同类**错误；
④ 未过滤路径不变（`total == Σ l2_count`）。
`c4` 保留回归保护：清空 fills 块后按**已知** `rt_seq` 过滤仍为 200 + `recorded=false` + `total=0`（未被 404 污染）。

---

## 4. L-2：参数形态错误 ⇒ 结构化错误信封

**改动**：`crates/web/src/workbench.rs` 新增单点改写 `param_shape_err(what, reason)`，
并把 ADR-027 三个同族端点的入参 extractor 从「裸 `Query`/`Path`」改为可捕获 rejection 的形态：
- `get_fills`：`Result<Query<FillsQuery>, QueryRejection>`（`round_trip`/`offset`/`limit`）；
- `get_round_trips`：`Result<Query<RoundTripsQuery>, QueryRejection>`（`offset`/`limit`）；
- `get_round_trip_fills`：`Result<Path<(String, u32)>, PathRejection>` + `Result<Query<..>, QueryRejection>`（路径 `rt_seq` + 分页）。

信封 = 既有 ADR-024 §3.1.1 形状：`{"error":{"code":"request_invalid","message":"参数形态非法（… 须为整数）","detail":{"param":"…","reason":"<axum 原始原因>"}}}`
（`detail` 恒对象；`code` 复用兜底码 `request_invalid`，**不新增**码以免破坏 `codes::ALL` 冻结集）。

**红（`11_red_web_param_shape.txt`）**
```
test param_shape_errors_are_structured_json_envelope ... FAILED
panicked at crates/web/tests/adr027_fills_param_shape.rs:121:9:
响应体必须是 JSON（L-2：禁止纯文本 400）；实际 status=400
body="Failed to deserialize query string: round_trip: invalid digit found in string"
```

**绿（`20_green_web_param_shape.txt`）**
```
test param_shape_errors_are_structured_json_envelope ... ok
test wellformed_params_are_not_rejected_as_shape_error ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 8.01s
```
用例覆盖 8 条形态错误路径表（`round_trip=abc` / `offset=abc` / `limit=abc` / `round_trip=-1` / `round_trip=`（空串）/
路径 `round-trips/abc/fills` / L1 `offset=abc` / L2 `limit=abc`），逐条断言：
响应体是 **JSON 对象**、`error` 是**对象**（禁字符串）、键集恰为 `{code,detail,message}`、`code == request_invalid`、
`message` 非空、`detail` 为对象且含 `param`（指出出错参数）。
**负向对照**（防「门禁做宽了，什么都 400」）：形态合法请求必须 `status != 400`。

---

## 5. O1 纪律：文档先行 + 回写 + 门禁复验

本波之所以触及 entangled 托管产物：MCP 侧 `bt_get_run_fills` 的**工具描述**、**函数文档**、
**同文件内契约测试**三处都逐字冻结了旧语义（「未命中 ⇒ 空页 total=0，**非错误**」、
「`code` 在 `/fills` 元素上**不**保证存在」）。行为变更后若不回写，docs/生成物即与实现**漂移**。

**顺序**：先改 `design/07-app-plane/01-mcp.md`（工具 `description`、`round_trip` 参数说明、
`bt_get_run_fills` 函数文档、`mod tests` 断言），再 `entangled tangle`（**无** `--force`、**无** `reset`、**未**手改产物），
最后 `./scripts/check-tangle.sh`。

**回写证据（`30_tangle_writeback.txt`）**
```
before sha256 89f434b3c3caa2d40be67098880a29eb61e7e0ab12118a414c124293e0e40373  crates/mcp/src/tools.rs
[23:48:37] INFO  Welcome to Entangled v2.4.3!
           INFO  write `crates/mcp/src/tools.rs`
EXIT=0
after  sha256 6458796292e29ea3ef05ce8fb7e513da862d16814f480e783c1ad7e54fead7ab  crates/mcp/src/tools.rs
 crates/mcp/src/tools.rs | 25 +++++++++++++------------
 1 file changed, 13 insertions(+), 12 deletions(-)
```
`entangled tangle` **只**写了 `crates/mcp/src/tools.rs`（其余目标无漂移 ⇒ 未触碰），
且 diff 与本波文档改动**逐处对应**（描述 1 处 + 参数说明 1 处 + 函数文档 2 行 + 测试 3 处）。

另：`design/07-app-plane/00-web-api.md` 的 `/fills` 端点行（prose 事实源）同步更新为
v2 元素形状 + `round_trip` 过滤器 + 「400 形态错误结构化 / 404 未知 rt_seq」。

**门禁（`31_check_tangle_green.txt`）**
```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

---

## 6. 判据复验（最终态）

| 判据 | 命令 | 结果 |
|---|---|---|
| 编译 | `cargo build --workspace` | **绿**（`Finished dev profile`，EXIT=0；`50_workspace_build.txt`） |
| application 测试 | `cargo test -p application` | **绿**（12 个目标全 ok，0 failed；其中 `tests/workbench.rs` **54 passed**；EXIT=0；`40_application_tests.txt`） |
| 新增 web 契约测试 | `cargo test -p web --test adr027_fills_param_shape` | **绿**（2 passed；**零连库**；`20_green_web_param_shape.txt`） |
| tangle 一致性 | `./scripts/check-tangle.sh` | **绿**（EXIT=0；`31_check_tangle_green.txt`） |

---

## 7. 未做项 / 残留风险（**明确披露，不静默**）

1. **未新增真库 HTTP 端到端用例**（`crates/web/tests/api_workbench.rs::p6_fills_endpoint` 未扩展）：
   纪律禁止 `DELETE`/`TRUNCATE`，而该文件的夹具收尾正是 `DELETE FROM strategy_run`；故本波 HTTP 级证据走
   **零连库**的 `adr027_fills_param_shape.rs`，L-1/L-3 走 application 层契约测试（`c4`/`c4b`）。
   404 的 **web 映射**由既有用例覆盖（`map_svc_err`：`WorkbenchNotFound → 404`，同一函数在 `/result`、`/fills`、`/audit` 共用）。
2. **`crates/web/tests/tester_p6_fills_indep.rs` 的 `FILL_KEYS` 冻结集已过期**（tester 独立用例，7 键）：
   自 ADR-027 P3 增 `rt_seq`/三件套起即已与实现不符，本波再增 `code`。属 **tester 车道**的冻结集更新，未越界修改
   （该文件为 tester 独立验收资产；真库用例不在本波判据内）。
3. **前端 TS 未加 `code`**：`web/src/api/types.ts::WorkbenchRunFill`（手写、非 tangle）未增 `code` 字段 ——
   02-spec §7 明确列举的前端增量仅 `rt_seq`/`trade_value`/`commission`/`stamp_duty`，且 `types.ts` 非 tangle 目标；
   后端新增字段对既有前端**纯增量**（多余键被忽略）。若前端要消费 `code`，需另开前端车道（含 §7 文档先行）。
4. **`design/07-app-plane/00-web-api.md` 端点表缺 L1/L2 两行**（`/round-trips`、`/round-trips/{rt_seq}/fills`）：
   ADR-027 P3 引入时的既有文档缺口（路由已在 `lib.rs`、行为已在实现），本波未补（避免越界扩范围）；建议由 parent 决定是否补。
5. **MCP 真库用例未在本波运行**（`crates/mcp/src/tools.rs::mod tests::bt_trade_detail_increment_tools_contract`
   经 tangle 回写后断言「未知 `rt_seq` ⇒ isError」）：需真库 + 造 run（含写库与夹具清理），不属本波判据；
   编译已随 `cargo build --workspace` 验证，语义已由 `c4b` 在 application 层等价锁定（`WorkbenchNotFound` ⇒ MCP `tool_fail` ⇒ `isError`）。

---

## 8. 改动文件清单（未 `commit`、未 `git add`）

| 文件 | 类型 | 行数 |
|---|---|---|
| `crates/application/src/workbench.rs` | 实现（L-1 + L-3） | +27/−5 |
| `crates/web/src/workbench.rs` | 实现（L-2；同族三端点） | +41/−7 |
| `crates/application/tests/workbench.rs` | C 段契约测试（`c4` 扩展 + `c4b` 新增） | +47/−1 |
| `crates/web/tests/adr027_fills_param_shape.rs` | **新增** C 段契约测试（L-2；195 行；零连库） | new |
| `crates/mcp/src/tools.rs` | **tangle 生成物**（由 `01-mcp.md` 回写） | +13/−12 |
| `design/07-app-plane/01-mcp.md` | 事实源（描述/文档/测试断言） | +14/−13 |
| `design/07-app-plane/00-web-api.md` | 事实源（`/fills` 行） | +1/−1 |
| `coder/evidence/20260920_adr027_p4c_consistency/*` | 证据（10 个文件） | new |

> 说明：按本仓既有惯例（历波 `coder/report/*` 均注明「遵循 Acceptance `noStagedFiles: true`」），
> 本波**未** `git add`、**未** `commit`，改动留在工作区供父级评审（`git diff` 可见）。
