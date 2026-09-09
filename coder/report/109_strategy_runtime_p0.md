# 109 — strategy-runtime crate（P0：插件运行时 + 契约测试套件）

- 日期：2026-09-08
- 范围：ADR 12-strategy-system §11 P0 期；ABI 权威契约 02-plugin-abi.md
- 报告位置：`coder/report/109_strategy_runtime_p0.md`（本文件）

## 1. 变更文件清单（全部已 `git add` 暂存，未提交）

| 文件 | 变更 |
|---|---|
| `Cargo.toml`（根） | `[workspace.dependencies]` 新增 `rquickjs = { version = "0.11", default-features = false, features = ["std"] }`（含批准与版本选型注释） |
| `Cargo.lock` | rquickjs 0.11.0 / rquickjs-core 0.11.0 / rquickjs-sys 0.11.0 + 传递依赖（foldhash/hashbrown/indexmap/cc 等） |
| `crates/strategy-runtime/Cargo.toml` | 新 crate（纯逻辑；中文头注；依赖 backtest path + workspace 依赖） |
| `crates/strategy-runtime/src/lib.rs` | crate 级中文文档（定位/权威契约/守卫/分层红线，引用 ADR 编号）+ 再导出 |
| `crates/strategy-runtime/src/error.rs` | `PluginError`（thiserror）：JsException/Timeout/MemoryExceeded/CapabilityViolation/InvalidScore/SchemaError |
| `crates/strategy-runtime/src/types.rs` | `RuntimeLimits`（默认 50ms/64MB）、`BarCtx`、`PositionSnapshot`（ABI §2.5）、`ParamDef`/`ParamKind`（serde）、`clamp_score` |
| `crates/strategy-runtime/src/runtime.rs` | `PluginRuntime` / `PluginInstance` trait（ABI §4 签名；`params_schema()` 为 ABI 生命周期的必要补充访问器） |
| `crates/strategy-runtime/src/quickjs.rs` | `QuickJsRuntime` 实现（约 480 行含单测） |
| `crates/strategy-runtime/tests/contract.rs` | 契约测试套件 9 用例（ABI §5 全 6 用例 + schema 提取 + position §2.5 + log sink） |
| `crates/strategy-runtime/tests/fixtures/*.js` | 7 个 fixture 插件（constant_score/stateful_counter/thrower/infinite_loop/boundary_clamp/capability_forbidden/dual_ma_ref） |

合计 +1644 行。未改动 `design/`、`backtest`、`simlive` 及任何既有 crate 代码。

## 2. 新增依赖及版本

- `rquickjs 0.11.0`（父级 2026-09-08 裁决批准）。**版本选型**：0.12+ 的 MSRV 为 rust 1.87，超出
  workspace `rust-version = 1.85`；0.11（MSRV 1.85）是兼容本 workspace 的最新稳定版，注册表源（非 git）。
- `default-features = false, features = ["std"]`：纯逻辑 crate 最小面（不需要 loader/dyn-load/macro/async）。
- 其余依赖全部 `workspace = true`（serde/serde_json/thiserror）+ `backtest`（path）。

## 3. rquickjs API 关键决策点

- **intrinsics 裁剪（G1）**：`Context::custom::<(Eval, Json, MapSet, TypedArrays)>`。
  BaseObjects 由 rquickjs 强制注入；Date/Performance/Promise/Proxy/BigInt/WeakRef 不注入
  → `Date` 引用即 `ReferenceError: Date is not defined` → 归类 `CapabilityViolation`。
  - **ABI 歧义处理 ①**：quickjs-ng 下宿主侧 `JS_Eval` 本身依赖 Eval intrinsic（不注入则
    宿主 eval 报 "eval is not supported"），故 Eval 必须保留。插件内 `eval`/`Function`
    仍在同一沙箱执行，不能获得任何额外能力，不破坏 G1 语义。已注释注明。
- **Math.random（G1）**：Math 属 BaseObjects 无法整体裁剪（且 sqrt/floor 是合法确定能力）。
  守卫脚本以 `Object.defineProperty`（不可写/不可配置）替换为抛错桩，错误信息带
  `capability-forbidden` 标记 → 归类 `CapabilityViolation`。单测证明 Math.sqrt 仍可用。
- **interrupt 超时（G2）**：`Runtime::set_interrupt_handler`（`FnMut() -> bool`）+ 每次调用前
  arm 单调时钟 `Instant` 截止时间（`DeadlineGuard` RAII，析构解除）；到期 QuickJS 抛
  InternalError "interrupted" → 归类 `Timeout`。本 crate 唯一时钟用途（分层红线豁免项）。
- **内存上限（G2）**：`Runtime::set_memory_limit`；超限抛 "out of memory" → `MemoryExceeded`
  （8MB 收紧单测锁定）。
- **实例隔离**：每插件实例独占 Runtime+Context；`QuickJsInstance` 字段顺序保证
  Persistent 先于 Context 析构（否则 JS_FreeRuntime 断言 abort——调试中发现并修复）。
- **闭包生命周期**：rquickjs 注入闭包不可借用 `BarCtx` 引用（`Context::with` 回调生命周期约束，
  编译期拒绝）；改为每 bar 将指标窗口 `bars[0..=index]` 复制入 `Rc<Vec<Bar>>` 供 7 个指标
  闭包共享，log sink 用 `Rc<RefCell<Vec<String>>>` 句柄。复制成本 O(index)/bar（见遗留风险）。
- **ctx 构建**：params 按 key 排序插入后 `Object.freeze`（HashMap 迭代序不确定，排序保证
  属性枚举序确定，服务 G1 确定性）；Persistent 复用同一 params 对象（ABI "init 时同一对象"）。
- **schema 提取**：`const PARAMS_SCHEMA` 是词法绑定（非 globalThis 属性），经二次 eval 表达式
  + `JSON.stringify` 取回，serde 严格解析（type 仅 int|float、default 必填、key 非空，
  违规 → `SchemaError`）。
- **返回值收敛（G6）**：有限数值 `clamp [0,100]`；NaN/±Infinity/非数值 → `InvalidScore`。

## 4. TDD 节奏记录

1. **Red**：先建空壳 crate + 7 fixture + 完整 contract.rs（可执行规格），`cargo test` 编译失败
   （`unresolved imports strategy_runtime::*`）——失败原因正确。
2. **Green**：最小实现逐模块落地；过程中真实暴露并修复 3 个实现缺陷（eval intrinsic 依赖、
   Persistent 析构顺序 abort、quickjs-ng ReferenceError 无引号格式）+ 1 个测试自身缺陷
   （position 用例返回值 300 被 G6 clamp，改阈值编码——**未削弱任何沙箱断言**）。
3. **Refactor**：clippy needless_borrow 修复；注释/文档完善。全程测试保持绿。

## 5. 测试覆盖与验证

- `cargo test -p strategy-runtime`：**13 单测 + 9 契约测试全绿**（连续两轮结果一致）。
  - 契约 6 用例：确定性双跑（dual_ma_ref，120 bar，两独立 runtime 序列逐点相等）/
    状态 round-trip（save→新实例 load→后续分数一致）/ 超时熔断（30ms 收紧，Timeout 错误 +
    引擎循环模拟记中立分 50 跑完全程，二次调用仍超时证明 runtime 可继续调度）/
    异常隔离（bar 2 JsException 含原文，对照插件不受影响）/ clamp（-5→0、150→100、NaN→
    InvalidScore、60 原样）/ 能力禁区（Date.now → CapabilityViolation 含 "Date"，引擎继续）。
  - 附加：PARAMS_SCHEMA 提取（3 参数逐字段相等 + serde 序列化 + 无 schema 插件为空）、
    ctx.position（null/注入双路径）、ctx.log sink 归集。
  - 单测：Math.random 禁区 / Math.sqrt 可用 / Date 不存在 / 缺 on_bar / 语法错误 /
    非法 schema type / 内存超限 / params 冻结（strict 抛错或静默两路径均证明不可改）/
    指标口径与 backtest::Indicators 逐点一致 + 数据不足 null / load 缺钩子报错 /
    Infinity→InvalidScore / clamp 边界 / 默认限额值。
- `cargo clippy -p strategy-runtime --all-targets`：**0 warning**。
- `cargo build --workspace`：**0 error**，其余 crate 不受影响。

## 6. ABI 歧义与处理

1. Eval intrinsic（见 §3①）：保留并注释，语义不破 G1。
2. `save()` trait 签名为 `Option<serde_json::Value>`（ABI §4 原文）：插件 save() 抛异常时只能
   返回 None，错误细节被吞。遵守 ABI 未改签名；引擎层（P1）如需错误事件可另行埋点。
3. `PluginInstance` 增加 `params_schema()` 访问器：ABI §4 trait 未列出，但 ABI §1 生命周期要求
   eval 后读取 schema，Registry/编辑器需要宿主侧出口；以只读访问器补充，不改任何既有签名。
4. `PluginInstance` 未加 `Send/Sync` 约束：QuickJS Runtime 为单线程对象；bar 内插件间并行
   （ADR §14 性能项）由引擎层按实例拆线程实现，与本 trait 正交。

## 7. 遗留风险

- 指标窗口每 bar O(index) 复制（rquickjs 闭包生命周期约束所致）：5 年日线（≈1260 bar）×
  3 插件规模下为常数级内存拷贝，可忽略；1m 长区间（P1 引擎）如需优化，可由引擎传共享
  历史缓冲（口径不变，纯实现优化）。
- 错误归类基于 quickjs-ng 错误信息文本匹配（"interrupted"/"out of memory"/"is not defined"）：
  升级 rquickjs 大版本时需回归契约测试（套件本身即为守门）。
- 超时语义为「每次调用 wall-clock 单调时钟上限」，非 CPU 燃料；宿主机器负载高时边界略软，
  符合 ABI G2「超时（默认 50ms/次，可配）」表述。
