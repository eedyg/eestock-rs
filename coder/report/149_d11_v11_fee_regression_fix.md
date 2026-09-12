# 149 — D11 部署后回归修复（ADR-019 v1.1 修订 R-1..R-3，配置形状 + 字段级费率解析）

- 报告文件位置：`coder/report/149_d11_v11_fee_regression_fix.md`
- 范围：修复 D11（ADR-019）v1.0 上线后的回归；**本批不重启服务、不 git add/stage、DB 只读**。
- 依据：`design/01-architecture/adr/ADR-019-symbol-type-fee-profiles.md` §6（v1.1 修订决议 R-1..R-5）。
- 仓库：`eestock-rs`；分支工作区未提交（仅工作树改动）。

## 1. 变更清单（文件 + 行数）

| 文件 | 变更 | 说明 |
|---|---|---|
| `crates/application/src/fee.rs` | +150/-57 | **R-2/R-3 核心**：`resolve_fee` 改为**按字段优先级**；新增 `explicit_number`/`explicit_stamp_duty` 辅助；模块头注 + `FeeSource`/`to_fee_model` 文档同步；重写/新增单测 |
| `crates/application/src/workbench.rs` | +7/-4 | **R-1 核心**：`submit` 钉住 `config.fee` 由 `resolved_fee_to_json`（两段）改回 `fee_model_to_json`（扁平）；移除未用 import |
| `crates/application/src/strategy.rs` | +3/-2 | `TestRunRequest.fee` 文档注释改字段级口径 |
| `crates/application/tests/strategy.rs` | +14/-7 | fee 回显测试改 v1.1 语义（三键 + ETF → stamp 0；非法字段仍 400） |
| `crates/application/tests/workbench.rs` | +43/-16 | 钉住 config 断言改扁平 + 往返可解析；显式三键 + ETF → stamp 0（本批核心） |
| `crates/mcp/src/tools.rs` | +30/-20 | **tangle 生成物**（源：`design/07-app-plane/01-mcp.md`）：tool 描述 + inline 测试断言同步 v1.1 |
| `crates/mcp/tests/d11_fee_profile_e2e.rs` | +24/-9 | 真实库端到端：显式三键 + ETF → stamp 0；显式 stamp=0.05 复现旧口径 |
| `crates/web/src/dto.rs` | +3/-2 | **tangle 生成物**（源：`design/07-app-plane/00-web-api.md`）：`validate_backtest_fee` 文档注释（行为未改） |
| `crates/web/src/workbench.rs` / `strategies.rs` | +3/-3 | DTO 文档注释改字段级口径（未提交对象） |
| `design/01-architecture/adr/ADR-019-...md` | +34 | §6 增 v1.1 落地锚点 + 历史行兼容说明 |
| `design/04-storage/schema.md` | +5 | §4.3.16 增 v1.1 字段级/扁平 config 说明 |
| `design/07-app-plane/00-web-api.md` | +7/-3 | workbench submit 响应表：`config.fee` 两段 → 扁平（R-1）；dto 注释 |
| `design/07-app-plane/01-mcp.md` | +30/-20 | tool 描述 + inline 测试（tangle 源） |
| `design/08-backtest/01-engine-adr.md` | +18/-6 | 费率口径段（唯一出口）同步 v1.1 |
| `design/12-strategy-system/01-adr.md` | +10/-5 | §13.5.1 试算 fee 口径同步 v1.1 |
| `crates/mcp/tests/zz_tester_010_acceptance.rs` (未跟踪临时夹具) | 调整 | `source`/费率形状断言按 v1.1 调整（见 §6） |

> `web/src`（TypeScript 前端）**零改动**（符合 R-4 预期，见 §5）。

## 2. 问题（回归）

v1.0（commit 9ef6374）把响应回显用的**两段结构**误写入**钉住 config**：
`crates/application/src/workbench.rs::submit` 由 `"fee": fee_model_to_json(&fee)` 改成 `"fee": resolved_fee_to_json(&resolved)`。
后果（ADR-019 §6 证据 1-4）：`strategy_run.config.fee` 变 `{effective:{…},profile:{…}}` →
① 读 `config.fee.rate_pct/min_fee/slippage_bp` 的消费者得到 `undefined`；② 以 run config 建预设走 `to_fee_model` 报 400；
③ UI 三键 fee（无 stamp）走"对象存在=整体显式"分支 → ETF 仍收 0.05 印花税（D11 收益经 UI 路径未生效）。

## 3. 变更方案（在已批准架构内）

### R-1 钉住 config 恢复扁平
- `crates/application/src/workbench.rs::submit`：`"fee": crate::fee::fee_model_to_json(&fee)`（4 键扁平，含 stamp 实际取值）。
- 两段结构（`resolved_fee_to_json`）**仅用于响应回显**：`TestRunResponse.fee`（`crates/application/src/strategy.rs` 的 pure_score/sim_position）与 `WorkbenchRunView` 之外的响应路径；不再混入 config。
- 往返无损：新增测试锁定 `to_fee_model(fee_model_to_json(m)) == m` 且 `config.fee` 无 `effective`/`profile` 键。

### R-2 字段级优先级（`resolve_fee`）
以"档案（无则旧默认）"为基础值，**显式对象中出现的字段逐字段覆盖**（含数值/值域校验）；未出现的字段保留基础值。
- ① UI 三键 fee（无 stamp）+ ETF 档案 → `stamp_duty_pct=0`（**本批核心断言**）
- ② 三键 fee + stock 档案 → `stamp_duty_pct=0.05`
- ③ 显式 `stamp_duty_pct=0.07` → `0.07`（显式字段最高优先）
- ④ 无显式 + 档案 → profile
- ⑤ 无显式 + 无档案 → 旧默认 + `source="default"`

### R-3 `source` 口径
取**最高优先级来源**：任一字段来自显式 → `"explicit"`；否则解析到档案 → `"profile"`；否则 `"default"`。
文档（fee.rs 模块头注 / 08-backtest / 12-strategy-system / 01-mcp / schema.md）写明"不等于所有字段均来自该类"。

### 关键设计判定（请复核）
- **`to_fee_model` 保持"三键必齐"**，仅用于**扁平预设/钉住**解析（`validate_preset_config`、单元测试）；**不再**用于调用方 fee 入参（调用方入参走 `resolve_fee`）。
- **部分显式 / 空对象按字段级回退（不再报 400）**：这是 R-2 的直接推论（"缺失字段回退"）。因此临时夹具中 `fee_empty_object` / `fee_missing_rate` 由"必须报错"改为"不再报错"（§6）。
- **HTTP 层 `validate_backtest_fee` 未改**（仍要求三键齐）：UI 恒传三键，HTTP 契约不变；故 "partial fee 有效" 仅在 MCP/application 路径生效（HTTP 预校验仍 400）。此为**保留的契约差异**，见 §7 残余风险。
- **`config.fee` 不新增 `source`/`symbol_type` 字段**（保持既有扁平契约最小化；来源信息仅用于响应回显）。

## 4. TDD 证据（Red → Green）

**Red**（实现前，`cargo test -p application --lib fee::`）：
```
fee::tests::explicit_three_keys_without_stamp_falls_back_to_etf_profile
  panicked: 缺 stamp → 回退 ETF 档案 = 0（核心断言）  left: 0.05  right: 0.0
fee::tests::partial_explicit_overrides_only_present_fields       Err: fee.min_fee 缺失或非数值
fee::tests::explicit_object_without_recognized_fields_degrades_source  Err: fee.rate_pct 缺失或非数值
test result: FAILED. 17 passed; 3 failed
```

**Green**（实现后，`cargo test -p application --lib fee::`）：`test result: ok. 20 passed; 0 failed`。

**本批核心断言（UI 三键 + ETF → stamp 0）实测**：
- 单测 `fee::explicit_three_keys_without_stamp_falls_back_to_etf_profile`：三键 fee + ETF → `stamp_duty_pct == 0.0`，`sell().stamp_duty == 0.0`。
- 应用集成 `workbench::submit_fee_resolves_by_symbol_type_and_pins_source` ②：三键 fee + ETF → `run.config.fee.stamp_duty_pct == 0.0`。
- 应用集成 `strategy::test_run_fee_resolves_by_symbol_type_when_absent`：三键 fee + ETF → `effective.stamp_duty_pct == 0.0`，成交 `stamp_duty` 合计 0。
- 真实库端到端 `mcp --test d11_fee_profile_e2e`（510050=etf）实测输出：
  ```
  profile: stamp_sum=0 pnl=-551.5901 | explicit(stamp=0.05): stamp_sum=49.7366 pnl=-601.3267 | Δpnl=49.7366
  ```
  （显式三键无 stamp 亦 stamp_sum=0；显式 stamp=0.05 复现旧多收口径。）

## 5. 前端（`web/src`）与 R-4

- **零改动**：回归根因在后端（钉住 config 形状 + 解析口径）。修好 R-1/R-2 后，前端三键 fee 提交 + 读取预设 `cfg.fee.rate_pct/min_fee/slippage_bp` 即恢复。
- **未改前端**复核依据：
  - 预设路径本就是扁平（`validate_preset_config` 在 v1.0 即用 `fee_model_to_json`，D11 commit 未改）→ 前端读预设 fee 的三个顶层键一直可读。
  - run config 的两段结构是**新引入**的破坏；本批改回扁平即消除。
  - 未发现需改 `web/src` 的消费点；**未**为"让测试变绿"改前端。
- R-5（Playwright/真实浏览器走查）属发布验收动作，本批不执行（需真实前后端联调）；已在 ADR §6 保留待办。

## 6. 临时夹具 `crates/mcp/tests/zz_tester_010_acceptance.rs`（未跟踪，按 v1.1 调整）

- 该夹具 `full_state` **未装配 `fee_profiles`**，故 ETF profile 分支在此不可用（原注释已声明）。
- 调整：
  - 旧注释"显式分支恒 0.05"→ v1.1 字段级口径说明。
  - 原 `fee_empty_object` / `fee_missing_rate` 位于"必须报错"清单；按 R-2 移出并新增断言 `!isError`（字段级回退），另补 `I3.fee_ui3_field_level`（三键 fee 无 stamp：本夹具无档案 → 回退默认 0.05、`source=explicit`）。
  - 保留 `fee_stamp_out_of_range`（仍报错）。
  - ETF profile 分支的核心断言（三键 + ETF → stamp 0）由 application 单测、workbench/strategy 集成、d11 真实库端到端覆盖（本夹具无档案不重复）。
- 该夹具未执行（`bt_run_ensemble` 会写 `strategy_run` 行，违反本批 DB 只读纪律）；已 `cargo test --workspace --no-run` 编译校验。

## 7. 旧 run 行（两段结构）读取兼容性

已落库的历史 run 行 `strategy_run.config.fee` 仍可能是 v1.0 写入的两段结构。逐读取路径核查：

| 读取路径 | 行为 | 是否崩 |
|---|---|---|
| MCP `bt_get_run` / `bt_list_runs` / `bt_get_run_result` | config 作为**不透明 JSON 原样返回**，不解析 fee | 否 |
| HTTP `GET /api/workbench/runs` / `GET /api/workbench/runs/{id}` | 同上，`StrategyRunView.config` 原样 | 否 |
| 前端 `ResultView` | 只读 `run.config.buy_threshold/sell_threshold/slots`，**不读** `run.config.fee` | 否 |
| 前端 `ConfigPanel` | `cfg.fee.*` 的 `cfg` 来自 `applyPreset`（预设 config，**恒扁平**），非 run config | 否 |
| 预设创建 `validate_preset_config`（写入路径） | 若客户端把**旧两段 run config** 当预设提交 → `to_fee_model` 显式返回 400 | 否（显式错误，非 panic） |

结论：**读取路径均为不透明透传，不解析 fee，不因旧行而崩**；无需读取侧兼容 shim。
唯一不兼容点为"用旧两段 config 新建预设"→ 显式 400（非崩溃）；新 run 行（本批后扁平）无此问题。已在 ADR-019 §6 落地锚点写明。

## 8. 门禁与测试

- tangle 门禁：`./scripts/check-tangle.sh` → ✅（沙箱重新生成 + 逐字节比对通过；工作区未修改）。改文档经 `entangled tangle` 回写生成物（`crates/mcp/src/tools.rs`、`crates/web/src/dto.rs`）。
- 测试（本批 DB 只读，仅跑非写库套件 + 只读 e2e）：
  - `cargo test --workspace --lib`：**269 passed / 0 failed / 0 ignored**
  - `cargo test -p application`：**136 passed / 0 failed**（含 fee 单测 20）
  - `cargo test -p mcp --lib`：**65 passed / 0 failed**
  - `cargo test -p backtest -p strategy-core -p strategy-runtime -p simlive -p alert -p diagnose -p domain -p providers -p tushare --tests`：**245 passed / 0 failed / 1 ignored**
  - `cargo test -p mcp --test mcp_protocol`：2 passed
  - `cargo test -p mcp --test d11_fee_profile_e2e`（真实库，只读）：1 passed
- 未执行：`crates/storage` / `crates/web` / `crates/mcp` 的**写库**集成测试（经 `cargo test --workspace --no-run` 编译校验；按本批 DB 只读纪律不跑）。经静态 grep 核查，其中无关于 config.fee 形状/`source` 的断言会随本批失效（`api_workbench.rs:331` 的 "fee 缺字段→400" 因 HTTP 预校验未改而仍成立）。

## 9. 残余风险 / 待复核点

1. **部分/空显式 fee 现为有效（字段级回退）**：R-2 的直接推论。HTTP 预校验仍要求三键（UI 契约），MCP/application 接受部分对象。若期望"至少一个可识别字段"守卫，需增规则（ADR 未要求，本批未加）。
2. **HTTP 与 MCP fee 校验不对称**（见上）：保留既有 UI 契约，未改 `validate_backtest_fee`。
3. **旧 run 行的两段 config 若被当预设提交** → 显式 400（非崩溃）；本批未加兼容 shim。
4. R-5 前端实跑走查未做（发布阶段动作）。

---

## 10. 增量修订：D11 v1.1 **补守卫**（架构师裁决）— 2026-09-12T14:52:53Z

> 承接上一节（v1.1 R-1..R-3），本增量只做**一条守卫**：显式 `fee` 对象**存在但无可识别字段** → fail-fast 400/isError。
> 本节内容为追加，前文不变。报告自身位置：`coder/report/149_d11_v11_fee_regression_fix.md`。

### 10.1 裁决与语义
- **有 ≥1 个可识别字段**（`rate_pct` / `min_fee` / `slippage_bp` / `stamp_duty_pct`）→ 按 R-2 字段级优先级解析，
  缺失字段逐级回退（profile → 旧默认），**不报错**。
- **对象存在但 0 个可识别字段**（`{}` / `{"foo":1}` / 仅档案列名 `{"commission_rate_pct":..}`）→ **400/isError**，
  消息须指明可识别字段集与当前收到的键。理由：空/全未知键是典型调用方 bug；静默按"全量回退"属"静默失真"类缺陷
  （同 I-1 静默空返回、门禁假绿），必须 fail-fast。
- **HTTP 层 `validate_backtest_fee` 三键预校验保持不变**（UI 契约）；守卫只作用于 application 层解析点
  `fee::resolve_fee`（与 R-2 同处）。

### 10.2 变更清单（本增量）
| 文件 | 变更 | 说明 |
|---|---|---|
| `crates/application/src/fee.rs` | +守卫 + 常量 + 测试/注释 | 新增 `RECOGNIZED_FEE_FIELDS`；`resolve_fee` 在 `Some(v)` 分支加"≥1 可识别字段"守卫；模块头注/函数文档同步；单测改写 |
| `crates/mcp/tests/zz_tester_010_acceptance.rs`（未跟踪夹具） | 调整断言 | `fee_empty_object`/`fee_unknown_keys` → 回归"必须报错"并校验错误消息；`fee_missing_rate` 保持"不报错" |
| `design/07-app-plane/01-mcp.md` | 事实源文档 | trial/bt fee 入参 schema 描述 + inline 测试（tangle 源）写明守卫 |
| `design/07-app-plane/00-web-api.md` | 事实源文档 | `validate_backtest_fee` 注释注明"本层三键不变，守卫在应用层解析点" |
| `design/01-architecture/adr/ADR-019-symbol-type-fee-profiles.md` | §6 落地锚点 | 增 "R-2 补守卫（架构师裁决）" 条目 |
| `crates/mcp/src/tools.rs` | tangle 生成物 | 由 `entangled tangle` 重新生成（描述 + inline 断言） |
| `crates/web/src/dto.rs` | tangle 生成物 | 由 `entangled tangle` 重新生成（`validate_backtest_fee` 注释） |

### 10.3 TDD 证据（Red → Green）
- **Red**（先改测试、未实现）：`cargo test -p application --lib fee::`
  ```
  thread ... panicked at crates/application/src/fee.rs:433:
  empty_object: 无可识别字段须报错: ResolvedFee { ... source: Profile ... }
  test result: FAILED. 20 passed; 1 failed
  ```
- **Green**（实现后）：`cargo test -p application --lib fee::` → `test result: ok. 21 passed; 0 failed`。

### 10.4 三条用例实测输出（临时 example 直调 `resolve_fee`，已删除，未入库）
```
[1 {} (empty)]            input={}                => ERR(400/isError): fee 对象不含任何可识别字段（可识别: rate_pct/min_fee/slippage_bp/stamp_duty_pct；当前收到: （空对象））
[2 {"foo":1}]             input={"foo":1}          => ERR(400/isError): fee 对象不含任何可识别字段（可识别: rate_pct/min_fee/slippage_bp/stamp_duty_pct；当前收到: foo）
[3 {"rate_pct":0.025}]    input={"rate_pct":0.025} => OK(source=explicit, stamp=0, rate=0.025, min=5, slip=2)   ← ETF 档案：缺失字段逐级回退 profile
```
用例 3 的 `stamp=0` 证明"部分字段合法 + 缺失字段回退 ETF 档案（印花税不征）"，非旧 0.05。

### 10.5 门禁与全绿数
- tangle 门禁：`./scripts/check-tangle.sh` → ✅（沙箱重生成 + 逐字节比对通过，工作区未修改）。
- `cargo test --workspace --lib`：**270 passed / 0 failed / 0 ignored**。
- `cargo test -p application`：**137 passed / 0 failed**（含 fee 单测 21）。
- `cargo test -p mcp --lib`：**65 passed / 0 failed**（含 inline `strategy_test_run_fee_policy_capital_channel` 新守卫断言）。
- `cargo test -p backtest -p strategy-core -p strategy-runtime -p simlive -p alert -p diagnose -p domain -p providers -p tushare --tests`：**245 passed / 0 failed / 1 ignored**。
- `cargo test -p mcp --test mcp_protocol`：2 passed；`cargo test -p mcp --test d11_fee_profile_e2e`（真实库，只读）：1 passed。
- `cargo test -p web --lib`：44 passed；`cargo test -p mcp --test zz_tester_010_acceptance --no-run`、`cargo test -p web --no-run` 编译校验通过。
- 未执行（本批 DB 只读纪律）：`crates/storage` / `crates/web` / `crates/mcp` 的写库集成测试。

### 10.6 残余风险更新
- 第 9 节风险 1（"部分/空显式 fee 现为有效"）**已由本守卫收敛一半**：空对象/全未知键现为 400；
  部分字段（≥1 可识别）仍为合法（裁决明确要求）。
- HTTP 与 MCP 校验不对称仍在：HTTP 预校验要求三键齐（UI 契约不变），MCP/application 接受"≥1 可识别字段"的字段级部分对象。
