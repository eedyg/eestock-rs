# 120 — P3c：MCP 统一策略系统工具族（strategy_* / bt_*，落现有 SSE server）

**报告位置**：`eestock-rs/coder/report/120_mcp_strategy_bt_tools_p3c.md`（本文件）

## 1. 问题 / 需求

12-strategy-system ADR §8（MCP 工具矩阵）+ §13.7（D15：新工具落现有 SSE server，不做 transport
迁移）+ §11 P3 验收（MCP tools/list 全量）。在 mcp crate 以 sim_* 既有模式（tool_list schema +
handler 分发 + 参数校验 -32602 / 执行失败 isError + MCP 停用开关）交付 strategy_*（7）与
bt_*（8）共 15 个新工具，经已就绪的 `application::StrategyService` / `WorkbenchService`。

## 2. 变更文件（已 git add，未 commit）

| 文件 | 变更 | 层 |
|---|---|---|
| `design/07-app-plane/01-mcp.md` | **tangle 源**：state.rs/tools.rs/mocks.rs/rpc.rs 测试/mcp_protocol.rs/mcp_tools_db.rs 全部改动 + §1.2/§1.3/§4/§5 文档口径 | 设计源（单一属主） |
| `design/07-app-plane/00-web-api.md` | eestock-app.rs 装配块（McpState 注入策略/工作台服务 + 开关；AppState 两处改 clone） | 设计源 |
| `crates/mcp/src/state.rs` | McpState +3 字段（`strategies`/`workbench` Option 注入、`strategy_tools_enabled: Arc<AtomicBool>` 单开关）+ getter/setter | Presentation（生成物） |
| `crates/mcp/src/tools.rs` | tool_list 32 schema（单 json! → `tool_schemas()` Vec 构造，避 serde_json 递归上限）+ 15 分发臂 + 15 handler + P3c 测试（约 +700 行） | Presentation（生成物） |
| `crates/mcp/src/{mocks,rpc}.rs`、`crates/mcp/tests/{mcp_protocol,mcp_tools_db}.rs` | McpState 字面量补 3 字段；工具数断言 17→32；rpc 测试名单补 15 | Presentation 测试（生成物） |
| `crates/app/src/bin/eestock-app.rs` | 装配：strategy/workbench 服务 clone 入 AppState、原实例入 McpState（与 web 共享同实例，同 SimLiveService 双通道口径）；开关默认开 | 装配（生成物） |

红线确认：strategy-runtime / strategy-core / backtest / simlive 零改动；application / domain /
storage / web 零改动（application 的 4 条 clippy warning 为 HEAD 既有，未触碰）。

## 3. 工具清单与 schema 摘要（15 新工具，描述全中文、注明适用场景；strategy_* 注明「统一策略系统 Registry」）

**strategy_***（经 StrategyService；统一策略系统 Registry）：
- `strategy_list {level?, kind?}` → catalog（仅 published，每策略最新 published；level at-least / kind 精确过滤；枚举校验）
- `strategy_get {strategy_id}` → `{strategy, versions[]}`（version 升序）
- `strategy_create {name, description?, kind?, code, params?}` → `{strategy, version}`（v1 draft；params 仅提示不持久化，见 §5 歧义①）
- `strategy_update {version_id, code}` → `{outcome: updated|new_draft, version}`（published 自动落新 draft）
- `strategy_publish {version_id}` / `strategy_archive {version_id}` → 版本行（状态机非法 → isError）
- `strategy_test_run {code?|version_id?, symbol, period, from, to, mode, params?}` → TestRunResponse（双模式；code/version_id 恰一个；period M1/M5/M15/D1；from/to RFC3339）

**bt_***（经 WorkbenchService；回测工作台）：
- `bt_run_ensemble {name?, symbol, period, from, to, slots[{strategy_id, version_id?, weight, params?}], buy_threshold?, sell_threshold?, policy, stop?, initial_capital?, fee?}` → `{run_id, run}`（queued + 钉住 config；version_id 缺省=catalog 最新 published；fee 缺省 ADR bt-1 {0.025,5.0,2.0}）
- `bt_get_run {run_id}`（状态+progress 0..1）/ `bt_get_run_result {run_id}`（五 jsonb）/ `bt_list_runs {status?, page?, page_size?}`（page 1 起，page_size 默认 100 封顶 500）/ `bt_cancel_run {run_id}` / `bt_compare_runs {run_ids[]}` / `bt_list_presets {}` / `bt_apply_preset {preset_id}` → `{preset_id, config}`

错误口径（严格复刻 sim_*）：结构性参数错误（缺参/空串/非法枚举/非法时间戳/slot 结构）→ JSON-RPC
-32602；领域语义错误（未知 id / 未发布版本 / 非法状态流转 / 非法配置 / 区间超限）→ result.isError=true；
MCP 停用 / 服务未配置（None）→ isError。

## 4. 架构对齐

- mcp（Presentation）仅依赖 application 服务 + domain 类型，无 storage/sqlx 正常依赖（红线同 web）。
- 开关裁决（父级 2026-09，intercom 裁决记录）：**方案 B**——McpState 本地**单开关**
  `strategy_tools_enabled: Arc<AtomicBool>`（默认开），否决 A（在 StrategyService/WorkbenchService
  复制 sim 式开关=死能力+接口污染）与 C（消费持久化 K_MCP=每次调用 DB 读）。代码注释已注明
  「后续如需运行时翻转，web 端点写同一 Arc」（列入遗留风险，本期不做端点）。
- 装配与 web 共享同一服务实例（clone Arc），与 SimLiveService 双通道一致性同口径。

## 5. 歧义处理（均已父级批准）

1. **fee 参数**：任务书未列 fee，但 `SubmitRunReq.fee` 必填 → 工具加可选 `fee`，缺省 ADR bt-1 默认
   `{rate_pct:0.025, min_fee:5.0, slippage_bp:2.0}`（父级批准；schema 注明缺省值）。
2. **version_id 缺省解析**：slot.version_id 缺省 → `StrategyService.catalog()` 取该 strategy_id 最新
   published；无 published → isError（信息含 strategy_id）（父级批准）。
3. **strategy_create.params**：CreateStrategyInput 无 params 字段（Registry 不存实例参数）→ schema
   保留 params 键并注明「创建不持久化，仅提示；试算/运行时传入」，提供时仅做 object 形状校验
   （非对象 → -32602）。报备。
4. **ADR §8 矩阵差异**：ADR 列 `strategy_versions`，任务书合并为 `strategy_get` 返回详情+版本列表
   （按任务书执行）；ADR 未列的 `bt_get_run_result/bt_cancel_run/bt_list_presets/bt_apply_preset`
   按任务书补齐。
5. **from<to 语义校验**归服务层（isError），tool 层只校验 RFC3339 可解析性（与 get_data_quality 同层口径）。

## 6. TDD 过程（Red→Green）

- **Red**：先在 design 源写全部 P3c 测试 + tool_list 契约（32 工具）→ tangle → `cargo test -p mcp`
  编译失败（E0560 无 strategies/workbench/strategy_tools_enabled 字段、E0599 无 setter）——红。
- **Green**：design 源实现 state 字段/开关、15 schema + 分发 + handler、mock 端口（全内存
  StrategyStore/StrategyRunStore/StrategyPresetStore/SymbolRegistry/sink/bar read）→ tangle → 41 lib 绿。
- **Refactor**：tool_list 单 json! 触 serde_json 递归上限 → 重构为 `tool_schemas()` 每工具独立 json!
  （测试全绿保护下完成）；修复 list_trades mock 的 iter_overeager_cloned（HEAD 漂移带入的既有 warning）。

**附带发现（重要）**：HEAD 磁盘 `crates/mcp/src/tools.rs` 与 design 源存在**漂移**（P3a 期手改了
MockSimStore 的 list_trades/upsert_state/get_state 与 `configure_strategies().await`，未回写 design
源）——首次 tangle 报「changed outside the control of Entangled」。已将漂移如实回写 design 源
（design 为单一属主），`git diff HEAD` 确认最终产出 = HEAD + 仅本任务加法。

## 7. 测试矩阵（mcp crate 既有模式：真实 service + 全内存 mock 端口，无 DB）

| 测试 | 覆盖 |
|---|---|
| `tool_list_schema_contract`（更新） | 32 工具；strategy_*/bt_* 名称序；描述含「统一策略系统 Registry」；level/kind 枚举；13 个必填数组契约 |
| `strategy_crud_flow_via_tools` | create(v1 draft)→get→update 原地→publish→update 新 draft(v2)→list(kind/level 过滤)→archive→catalog 空 |
| `strategy_test_run_inline_and_version_modes` | inline pure_score（42 分×6 bar 无信号）/ version sim_position（恒 80→buy 信号+LumpSum 成交） |
| `strategy_tools_param_validation_is_32602` | 18 组缺参/非法 kind/level/period/mode/时间戳/code 与 version_id 二选一 |
| `strategy_tools_unknown_id_and_state_errors_are_is_error` | 未知 id ×3 / 重复发布 / draft 归档 → isError |
| `bt_run_ensemble_happy_path_and_run_queries` | version_id 缺省 catalog 解析钉住 + fee 缺省 + 后台真实 QuickJS 引擎跑至 succeeded（progress=1.0）+ result 五 jsonb（per_bar=6）+ 列表过滤分页 + compare 跳过未知 + 终态取消 isError |
| `bt_run_ensemble_unpublished_and_invalid_config_are_is_error` | draft 版本 / 无 published（信息含 strategy_id）/ weight=0 / 未知 version_id / 非法 policy → isError |
| `bt_tools_param_validation_and_unknown_id` | 16 组 -32602（缺 symbol/slots/policy、slot 结构、非法 status/page/run_ids）+ 未知 run/preset isError + queued 无结果 isError + queued 取消→canceled（确定性：store 直插不行后台） |
| `bt_presets_list_and_apply` | list + apply 返回钉住 config（buy_threshold=60）+ 未知预设 isError |
| `strategy_tools_gated_by_mcp_disable_switch` | 关→strategy_*/bt_* 全族 isError 含「停用」→开恢复 |
| `strategy_tools_unconfigured_returns_is_error` | strategies/workbench=None → isError |
| rpc/mcp_protocol（更新） | 工具名单 32 / tools/list 帧序断言 17→32 |

## 8. 验证命令（全绿）

- `entangled tangle` → **Nothing to be done（无 diff）** ✓
- `cargo test -p mcp -p app` → 10 套件全 ok（mcp lib 41、protocol 2、tools_db 3、app 4）✓
- `cargo build --workspace` → 0 error ✓
- `cargo clippy -p mcp -p app --all-targets` → mcp/app **0 warning**（application 4 条为 HEAD 既有，未触碰）✓
- `git add` 已暂存 9 文件（7 生成物 + 2 design 源），未 commit ✓

## 9. 遗留风险

1. **停用开关生产不可达**：`strategy_tools_enabled` 默认开，本期无 web 翻转端点（父级裁决口径：
   后续如需运行时翻转，web 端点写同一 Arc）。测试可翻转并锁定语义。
2. **strategy_create.params 接受但不持久化**（schema 已注明）；若未来 Registry 支持实例参数落库需
   新决策。
3. **bt_run_ensemble 后台执行为真实 QuickJS 引擎**（与 application 测试同工艺）；happy path 轮询
   上限 4s（200×20ms），CI 高负载理论上有抖动余量不足风险（当前 6 bar 秒级完成）。
4. mcp_tools_db.rs 未加 P3c 工具的 DB 集成测试（单测已用全内存 mock 锁定语义；storage 侧
   Pg*Store 已由 application/web 集成测试覆盖同端口）。
5. design 源与生成物的既有漂移已回写修复（见 §6）；建议后续 CI 加 `entangled tangle` 无 diff 守门。
