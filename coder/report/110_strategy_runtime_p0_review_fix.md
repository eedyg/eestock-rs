# 110 — strategy-runtime P0 评审 findings 修复包（1 MAJOR + 3 MINOR + 4 NIT）

> 本报告路径：`coder/report/110_strategy_runtime_p0_review_fix.md`
> 前置：P0 交付见 `coder/report/109_strategy_runtime_p0.md`；ABI 文档（design/12-strategy-system/02-plugin-abi.md）已由架构师修订完毕，本包代码向文档对齐，未动 design/。
> 状态：全部修复完成，已 `git add` 暂存，**未 commit**（待架构师验收统一提交）。

## 验收门（全绿）

| 门 | 结果 |
|---|---|
| `cargo test -p strategy-runtime` | 27 passed / 0 failed（unit 14 + contract 13） |
| `cargo clippy -p strategy-runtime --all-targets` | 0 warning |
| `cargo build --workspace` | 0 error |

## 逐条修复对应（finding → 文件:行 → 测试证据）

### MAJOR-1 save() 吞错 → 改签名 `Result<Option<Value>, PluginError>`
- `src/runtime.rs:34` trait 签名改为 `fn save(&self) -> Result<Option<serde_json::Value>, PluginError>`（对齐 ABI §4），doc 注明"未定义 save() 才是 Ok(None)，错误不得折叠"。
- `src/quickjs.rs:262` `QuickJsInstance::save` 实现：restore/call/json_stringify/serde 解析任一环失败 → `Err`（经 `js_call_err` 归类，含 Timeout）；循环引用（QuickJS json_stringify 抛 TypeError 或返回 None）→ Err；未定义 save() → `Ok(None)`。
- 调用点更新：`tests/contract.rs:160`（round-trip 改双层 expect）。
- 测试证据：
  - `contract_save_error_is_reported_not_swallowed`（contract.rs）：(a) 未定义→Ok(None)；(b) `save(){throw 'save boom'}`→Err(JsException) 且含原文；(c) 循环引用→Err；(d) 报错后实例仍可评分。
  - `quickjs::tests::save_error_variants_are_reported`（quickjs.rs 单测）：三种路径。

### MINOR-1 错误归类防伪造
- `src/quickjs.rs` `classify_exception`：
  - (a) Timeout/MemoryExceeded 要求 `name == "InternalError"` **且** 消息精确匹配 `"interrupted"` / `"out of memory"`（实测 quickjs-ng 0.11 原文，临时探针验证：`InternalError/"interrupted"`、`InternalError/"out of memory"`、栈溢出为 `RangeError/"Maximum call stack size exceeded"`）。
  - (b) 守卫脚本 `SANDBOX_GUARD` 的 ban 桩改为构造 `e.name = "CapabilityError"` 的自定义错误；宿主按 `name == "CapabilityError"` 归类 CapabilityViolation，弃用消息子串标记（`CAPABILITY_MARKER` 删除，改 `CAPABILITY_ERROR_NAME`）。
- 测试证据：`contract_forged_guard_messages_are_js_exception`——插件 `throw new Error("interrupted"|"out of memory"|"capability-forbidden: Date")` 三种伪造全部归类 JsException（经 `root_cause()` 断言）；既有 `math_random_is_forbidden` / `contract_capability_forbidden` 仍锁定真实能力违规归类。

### MINOR-2 on_bar 错误自含 code_hash + bar_index（ABI G5）
- `src/error.rs`：新增 variant `PluginError::OnBar { code_hash, bar_index, source: Box<PluginError> }`（thiserror 风格，Display = `插件 {code_hash} bar {bar_index} 出错: {source}`，两字段皆在文本中）；新增 `pub fn root_cause()` 剥离包装 + `pub(crate) fn on_bar()` 构造器。实例化路径错误保持原 variant 不包装（无 bar_index 语义）。
- `src/quickjs.rs` `on_bar`：`.map_err(|e| PluginError::on_bar(&self.code_hash, bctx.index, e))` 统一包装全部 on_bar 路径错误（含 InvalidScore）。
- 测试证据：`contract_exception_isolation` 断言事件文本含 `sha256:thrower` + `bar 2`（直调与 engine_loop 事件流两处）；`contract_timeout_circuit_semantics` 断言超时事件含 `sha256:infinite_loop` + `bar 0`；既有归类断言全部改走 `root_cause()`。

### MINOR-3 契约套件补齐
- (a) 内存上限：`contract_memory_limit`（contract.rs，从 quickjs.rs 单测 `memory_limit_is_enforced` 提升并删除原单测）：收紧 8MB 限额 → MemoryExceeded；同实例二次调度仍超限、健康插件不受影响（runtime 可继续调度）。
- (b) `tests/fixtures/stack_overflow.js`（新）：深递归 → `contract_stack_overflow_is_js_exception` 断言归类 JsException（实测 RangeError）、信息含 "stack"、进程不崩溃（后续同实例/其他插件调用正常）。
- 熔断停用断言：`contract_timeout_circuit_semantics` 注释明确「连续 N 次熔断停用」归 P1 strategy-core 引擎层契约测试，本套件不实现（ABI §5 口径）。

### NIT-1 ParamDef serde "type"
- `src/types.rs:111` `#[serde(rename = "type")]` 于 `kind` 字段。
- 测试证据：`contract_params_schema_extraction` 断言 `json[0]["type"] == "int"`。

### NIT-2 Eval intrinsic 实验结论：**保留**（原"必须注入"判断经实测证实）
- 实验：临时探针测试（用后已删）对 `Context::custom::<(Json, MapSet, TypedArrays)>`（移除 Eval）直接宿主侧 `ctx.eval("1 + 2")` → **抛 Exception**，函数定义/typeof/JSON.stringify 全部不可用。即 quickjs-ng 0.11 宿主 eval 路径依赖 Eval intrinsic，**移除不可行**。
- 处置：保留 Eval；`src/quickjs.rs` 模块头与 `Context::custom` 处注释改为实测结论（写明验证方式与现象、日期）。

### NIT-4 PARAMS_SCHEMA 重复 key 拒绝
- `src/quickjs.rs` `extract_params_schema`：serde 解析后 HashSet 查重 → `SchemaError("...重复 key '...'")`。
- 测试证据：`quickjs::tests::duplicate_param_key_is_schema_error`。

### NIT-5 rquickjs feature 禁忌注释
- 根 `Cargo.toml` rquickjs 注释追加：「禁止为 rquickjs 启用 rust-alloc/allocator feature（会使 set_memory_limit 静默失效，G2 内存上限形同虚设）」。

### NIT-7 实例化独立时限
- `src/types.rs` `RuntimeLimits` 新增 `pub instantiate_timeout: Duration`，Default = `max(per_call_timeout × 20, 1s)`（默认 1s）。
- `src/quickjs.rs` `instantiate`：eval(SANDBOX_GUARD)+eval(code)+init(params) 统一 arm `instantiate_timeout`，与 per-call 解耦（Timeout variant 携带相应时限）。
- 测试证据：`types::tests::default_limits_match_abi` 增加 instantiate_timeout 断言（=1s 且 = max(per_call×20, 1s)）；`tighten(30)` 的超时契约用例仍快速触发（实例化不受 per-call 收紧影响）。

## 变更文件清单

| 文件 | 变更 |
|---|---|
| `crates/strategy-runtime/src/error.rs` | +OnBar variant、+root_cause()/on_bar()（约 +35 行） |
| `crates/strategy-runtime/src/runtime.rs` | save() 签名 + doc（MAJOR-1） |
| `crates/strategy-runtime/src/types.rs` | +instantiate_timeout 字段/Default、ParamDef serde rename、default_limits 测试 |
| `crates/strategy-runtime/src/quickjs.rs` | 守卫脚本 CapabilityError 桩、classify 防伪造、save 实现、on_bar 包装、实例化时限、schema 查重、Eval 实测注释、单测增删（+2/-1） |
| `crates/strategy-runtime/tests/contract.rs` | +4 契约用例（save 错误/内存上限/栈溢出/防伪造），既有用例适配 OnBar 包装与 serde "type" |
| `crates/strategy-runtime/tests/fixtures/stack_overflow.js` | 新增 fixture |
| `Cargo.toml`（根） | NIT-5 禁忌注释 |

红线遵守：未动 design/ 文档、未动其他 crate、无新外部依赖；既有沙箱断言（G1 能力禁区/params 冻结/确定性双跑/clamp）全部保留且通过。

## 残余风险
- `PluginError::OnBar` 包装改变了 on_bar 路径错误的部分匹配形态；下游（P1 strategy-core）消费时须用 `root_cause()` 归类——已在 error.rs doc 注明。
- interrupted/OOM 精确消息文本绑定 quickjs-ng 0.11 实测原文；未来 rquickjs 升级若改文案，契约用例（超时/内存/栈溢出）会立即变红暴露。
