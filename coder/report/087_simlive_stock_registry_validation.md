# Coder Report 087 — sim-live 股票校验偏差：strategies[].stocks 注册表成员校验

> 本报告文件位置：`eestock-rs/coder/report/087_simlive_stock_registry_validation.md`

## 问题（根因）
`SimLiveService::start_session` 在 ADR §4 的多策略配置下，对 `strategies[].stocks`（及 `stock_weights` 键）只调用
`validate_registered_stock` 做**格式**校验（6 位数字 + 市场前缀 5/6/9→沪、0/1/2/3→深）。
格式合法但**未注册**的 code（如 `999999`）会通过 → 该股在 symbols 注册表外、无行情源 → 评分/市值异常。
设计口径=从 `/api/symbols` 选已注册标的，未注册应拒（400）。

## 修复目标
改为**注册表成员校验**：`strategies[].stocks` 的每个 code 须在 `symbols` 表（注册表）内；`stock_weights` 的 key 仍须 ∈ 该策略 stocks 集（已做、不变）。

## 实现（仅 sim-live application 层 + 注入 symbol 查询）
只改 2 个文件，未触碰 backtest/其它层、未引入新依赖、未改任何公开接口签名。

### `crates/application/src/simlive.rs`
- 新增私有异步方法 `registered_codes() -> anyhow::Result<Option<HashSet<String>>>`：
  - 复用已注入的 `self.kline`（`ports::KlineRead`）的 `symbols_with_latest()` 读注册表 → 建 code 集。
  - **未注入**注册表/行情源读端口（`self.kline == None`）→ `Ok(None)`：调用方回退仅格式校验（兼容既有未注入构造，如前端手动会话/部分 MCP 测试）。
  - 注册表查询**失败** → `Err`（fail-closed：无法确认注册即拒，不放过未注册标的）。
- `start_session`：仅当 `req.strategies` 非空时，循环校验前先 `let registered = self.registered_codes().await?`，并把 `&registered` 传入 `validate_strategy_config_input`。
- `validate_strategy_config_input(input, registered)`：新增 `registered: &Option<HashSet<String>>` 参数，转发给 `validate_registered_stock`。
- `validate_registered_stock(code, registered)`：在既有**格式**校验之后，追加：
  ```rust
  if let Some(reg) = registered {
      if !reg.contains(code) {
          return Err(anyhow!("股票 {code} 未注册"));
      }
  }
  ```
  即格式合法但未注册 → `"股票 {code} 未注册"`，由调用方包成 `InvalidConfig`，web 层映射 **400**。
- 文档注释同步说明「格式 + 注册表成员」双口径。

### `crates/application/tests/simlive.rs`（TDD 测试）
- `MockKline` 增加 `registered: Mutex<HashSet<String>>` 与 `set_registered(&[&str])`；`symbols_with_latest()` 改为返回这些注册行（`SymbolLatestView`，`enabled=true`），供注册表成员校验使用。
- 新增 3 个测试（见下）。

## 设计口径与分层
- `SimLiveService`（application 层）通过 **domain 端口 `KlineRead::symbols_with_latest()`**（03-symbols 注册表读，storage 实现，app bin 装配）判断 code 是否已注册，符合「注入/复用 domain 现有 symbols 读」的口径。
- 生产装配（`app/src/bin/eestock-app.rs`）已 `.with_kline(sim_kline.clone())`，故生产路径**强制**注册表校验。
- 未注入注册表端口时回退仅格式（向后兼容既有构造），属既有 `with_kline` 可选注入模式的一致扩展；此回退不影响生产（生产恒注入）。

## TDD Red → Green
- **Red**：先改 `MockKline`（注册表基座）并新增测试，产物：
  - `start_session_with_strategies_rejects_unregistered_code`：注册表={518880,510300}，stocks=[999999] → 期望 `Err(InvalidConfig)` 含「未注册」。改动前实现只验格式 → 999999 通过 → `unwrap_err()` panic → **FAILED**（复现偏差）。
  - `start_session_with_strategies_accepts_registered_code`：注册表={518880}，stocks=[518880] → 200。
  - `start_session_with_strategies_without_registry_port_falls_back_to_format`：不注入 kline → 510300 仍 200（回退格式）。
- **Green**：实现 `registered_codes()` + 传 `registered` 下探到 `validate_registered_stock` → 上述 3 测试全绿，且 `simlive` 全量 **31 passed / 0 failed**。

## 测试覆盖
| 测试 | 断言 |
|------|------|
| `start_session_with_strategies_rejects_unregistered_code` | 格式合法但未注册（999999）→ `InvalidConfig` 含「999999」「未注册」；且不落库（`store.created` 为空） |
| `start_session_with_strategies_accepts_registered_code` | 注册表内（518880）→ 200；会话 `stock_set` 由策略派生 |
| `start_session_with_strategies_without_registry_port_falls_back_to_format` | 未注入注册表端口 → 回退格式；510300 → 200 |

既有 `start_session_invalid_strategies_rejects` 覆盖的 `stock_weights` 键 ∉ stocks、weight≤0、params 越界、未知 id、空标的集、格式非法（`abc`）等仍全绿。

## 验证
| 命令 | 结果 |
|------|------|
| `cargo test -p application --test simlive` | 31 passed / 0 failed |
| `cargo test -p application` | 31 passed / 0 failed（含 doc-tests 0） |
| `cargo test -p mcp` | lib 31 + protocol 2 + tools_db 3 = 36 passed |
| `cargo test --workspace -- --skip list_events_filters` | **388 passed / 0 failed**，exit 0（`web` lib 36 passed；文内无 `test result: FAILED`） |
| `cargo clippy -p application --tests` | 仅 2 条预存 `////` 四斜杠注释风格告警（tests/simlive.rs:743/799，非本次引入）；无新增告警 |
| `entangled tangle` | `Nothing to be done.`（幂等；本改动为手写 crate，非 tangle 生成） |

## 前端（`web/src`）
**未受影响，故不跑 vitest/tsc/build**：本改动仅在 Rust `application` crate 的 `start_session` 校验逻辑内，未改任何 `web/src` 前端源码、未改 `crates/web/src/simlive.rs`（其 `InvalidConfig`→400 映射已存在）、未改公开 API/HTTP 契约。前端 vitest 测试依赖浏览器内 mock API（`web/src/api/mock.ts`），从不调用 Rust 后端；`VITE_API_MOCK=0` 的 tsc/build 仅编译前端源码，与本后端改动无关。

## 残留风险
1. **注册表端口回退**：若第三方以「未注入 kline」方式构造 `SimLiveService`，注册表校验回退为仅格式（不拒未注册）。生产 app bin 恒注入 kline，故生产强制；此回退仅为兼容既有测试/构造的防御。
2. **`enabled=false` 的注册标的仍视为已注册**：当前判据为「code ∈ symbols 表（`symbols_with_latest` 全量）」；若未来需「仅接收启用档位」，需加 `enabled` 过滤，当前不在任务范围。
3. **每次 `start_session` 调用 `symbols_with_latest()` 全量拉取注册表**：非热路径（开局会话），可接受；若后续频率升高可引入缓存/专用 is_registered 查询。
4. **会话期加股**：`configure_strategies` 接收已构造的 `simlive::StrategyConfig`（非 `StrategyConfigInput`），且无 web/MCP 暴露的「会话中加股」用户路径；现有用户输入面（`start_session`）已注册表校验，故该项不适用（任务措辞「若支持」）。
5. **幂等**：`entangled tangle` 幂等；`start_session` 重复运行（既有 running）在注册表校验前返回 `AlreadyRunning`，交互顺序未变。

## 暂存文件清单（本次改动）
- 修改（未暂存）：`crates/application/src/simlive.rs`（+34/−8 行）
- 修改（未暂存）：`crates/application/tests/simlive.rs`（+103/−1 行）
- 新增本报告（未暂存）：`coder/report/087_simlive_stock_registry_validation.md`

> 工作树**未暂存、未 commit**（`git diff --cached` 为空）；仓库中大量 `??`（既有报告/logs 等）均非本次改动。本次改动严格限定在 sim-live（application）股票注册校验。
