# 029 — P2a 统一策略系统：Strategy Registry 后端（migration + domain ports + storage + StrategyService + REST）

> 报告位置：`eestock-rs/coder/report/029_strategy_registry_p2a.md`
> 任务：design/12-strategy-system（ADR §5/§13.5，ABI G4）P2a —— Strategy Registry 后端全栈。
> 状态：完成，已 `git add`（未 commit）。

## 1. 变更文件清单（tangle 生成物已标注）

### design（事实源，文学式）
| 文件 | 变更 |
|---|---|
| `design/04-storage/schema.md` | 新增 §4.3.13（0022 迁移文学式块 + storage 模块契约描述） |
| `design/04-storage/02-tushare-sync.md` | storage lib.rs 块注册 `pub mod strategy;` |
| `design/02-domain/contracts.md` | ports.rs 块追加 Strategy Registry 端口段；新增 §2.9（strategy_state.rs 块） |
| `design/07-app-plane/00-web-api.md` | 新增 §1.7 契约；lib.rs 块（路由+`pub mod strategies;`）；state.rs 块（`AppState.strategies` 字段）；eestock-app.rs 块（DI+播种）；4 处测试装配 `strategies: None` |
| `design/07-app-plane/02-alerts.md` | api_alerts.rs 测试装配 `strategies: None` |

### tangle 生成物（禁止手改，由上述 design 生成）
| 文件 | 说明 |
|---|---|
| `migrations/0022_strategy_registry.sql` | strategy/strategy_version 两表 + 2 索引 + published 不可变 trigger（BEFORE UPDATE/DELETE） |
| `crates/domain/src/ports.rs` | StrategyStore port + StrategyRow/StrategyVersionRow/NewStrategy/NewStrategyVersion/CatalogEntry |
| `crates/domain/src/strategy_state.rs` | 状态机纯函数模块（含全流转表单测） |
| `crates/storage/src/lib.rs` | 注册 `pub mod strategy;` |
| `crates/web/src/lib.rs` / `crates/web/src/state.rs` | 路由 + AppState.strategies |
| `crates/app/src/bin/eestock-app.rs` | StrategyService DI + 启动播种调用 |
| `crates/web/tests/{api_admin,api_alerts,api_quality,api_rest,ws_poller}.rs` | 装配字段补齐（strategies: None） |

### 手写（非 tangle）
| 文件 | 说明 |
|---|---|
| `Cargo.toml`（根） | workspace.dependencies 加 `sha2 = "0.10"`（批准注释：架构裁决 2026-09-09，ABI G4） |
| `crates/application/Cargo.toml` | 加 path 依赖 strategy-runtime/strategy-core + sha2.workspace |
| `crates/domain/src/lib.rs` | `pub mod strategy_state;`（lib.rs 本为手写例外） |
| `crates/storage/src/strategy.rs` | PgStrategyStore（sqlx 实现，手写，与 sim.rs 同模式） |
| `crates/application/src/strategy.rs` | StrategyService（手写，DI 参照 simlive.rs） |
| `crates/application/src/lib.rs` | `pub mod strategy;` |
| `crates/web/src/strategies.rs` | REST handlers + DTO（手写，与 backtest.rs/simlive.rs 同模式） |
| `crates/web/tests/api_strategies.rs` | REST 集成测试（真实 DB+server） |
| `crates/storage/tests/strategy_store.rs` | storage 集成测试（含 trigger 双保险） |
| `crates/application/tests/strategy.rs` | Service 测试（mock store + mock bar reader） |
| 5 个手写 web 测试（api_backtest/api_favorites/api_kline_period/api_ma_config/api_settings） | 装配字段补齐 |

## 2. 关键选址理由

- **状态机纯函数选址 domain::strategy_state**（非 strategy-core）：strategy-core 是评分/聚合/执行内核，
  Registry 持久化语义不属其职责；强类型枚举（StrategyStatus/ApprovalLevel/StrategyKind）需被
  domain ports（行类型）、storage、application、web 四层共享，domain 是唯一公共依赖点，
  与 RunStatus/AlertStatus/SimSessionStatus 等既有状态枚举同层同模式。纯函数 `can_transition`/
  `validate_transition` 表驱动，3×3 全流转表单测锁定（合法仅 draft→published、published→archived）。
- **播种选址 application**（`StrategyService::seed_reference_plugins`，app bin 仅调用）：播种是
  Registry 领域行为，复用同一套状态机/sha256/schema 提取口径，可在 service 测试以 mock store
  锁定幂等语义；放 app 装配层则无法单测。免发布门禁：播种内容=仓内 fixture 字节
  （strategy-core::reference，契约测试已锁定）。
- **created_by**：播种行标 `"seed"`（区分用户 `"local"` 默认）。
- **web/strategies.rs、storage/strategy.rs 手写**：严格遵循 backtest.rs/simlive.rs/sim.rs 的
  「代码块不入 design、契约描述入 design、lib.rs/state.rs 仅 tangle 注册」既定例外模式。

## 3. 发布门禁设计（publish gate）

两阶段真实实例化冒烟（QuickJsRuntime，默认 RuntimeLimits；实例不跨 await 持有，QuickJS 非 Send）：
1. 空参实例化：eval 源码 + 全局 `on_bar` 存在（runtime require_global_fn）+ `PARAMS_SCHEMA` 解析；
2. 按 schema 默认值填参再实例化：验证 `init(params)` 路径。
任一失败 → `StrategyValidation`（400，「发布门禁未通过」），版本保持 draft。通过后计算
sha256（hex，sha2 crate）→ `mark_published`（status+sha256+params_schema+published_at 原子定格）。
draft 创建/更新时 schema 为 best-effort 提取（坏代码允许暂存 draft，门禁在 publish 兜底）。

## 4. 数据模型与双保险

0022 按任务书口径建表（st_/sv_ 应用层 id 前缀，s_<ts>_<seq> 同口径）。published 不可变双保险：
- 应用层：`update_draft` 仅 `WHERE status='draft'` 生效；published 被编辑 → ADR §13.5 自动新 draft
  （version+1）；archived 编辑 → 409。
- DB 层 trigger：BEFORE UPDATE 拦 published 行 code/params_schema/sha256/version 变更（status 字段
  放行——published→archived 唯一出路；OLD='draft' 的发布定格不触发）；BEFORE DELETE 拦 published
  删除（连带 strategy 级联删除同样被拦）。storage 集成测试直改库验证两类拦截 + archive 放行。

## 5. catalog / test_run 口径

- **catalog**：`DISTINCT ON (s.id)` 每策略最新 published 版本；`level` 为 **at-least 语义**
  （权限阶梯 backtest_ok≤sim_ok≤live_approved，高级别通过低级别过滤——文档化决策，理由：级别是
  有序升级阶梯，live_approved 策略不应从回测下拉消失）；仅 published 入册。
- **test_run**：`code|version_id` 二选一 + params + symbol + period(M1/M5/M15/D1) + from/to + mode。
  参数经 schema 校验/填缺省（未知键/非数值/越 min-max → 400，ABI NIT-6 Registry 职责）。
  区间上限 D1≤5 年（366×5 天）/分钟级≤3 个月（93 天），超限 400。收紧 RuntimeLimits
  （per_call 20ms/内存 32MB，实例化 max(20×per_call,1s)）。pure_score=裸评分（position 恒 None，
  G5 语义：错误 bar 中立分 50+事件、连续 10 次熔断后 score=null）；sim_position=单 slot
  EnsembleEngine（默认 60/40+LumpSum 1.0+默认 FeeModel+初始资金 100k）。同步执行。
  截断口径：评分点≤50_000、事件≤1_000、成交≤5_000，超出截尾并置 `truncated.{scores,events,trades}`。

## 6. 测试矩阵（TDD Red→Green）

| 层 | 文件 | 覆盖 |
|---|---|---|
| domain | strategy_state.rs 内单测（6） | 全流转表 9 对/枚举 str 往返/阶梯 satisfies/serde snake_case |
| storage | strategy_store.rs（7） | CRUD 往返/UNIQUE(strategy_id,version)/update_draft 仅 draft/**trigger 拦 published 改码+删行+级联**/archive 放行/catalog 过滤/at-least 级别/name+sha 幂等探测 |
| application | strategy.rs（21） | 自动新 draft/发布门禁拒坏代码(无 on_bar、语法错)/sha256 稳定/状态机 409 全表/catalog 过滤/播种 11 款+幂等/test_run 双模式/区间上限/参数校验/事件截断/熔断/404 语义 |
| web | api_strategies.rs（5） | 全端点端到端生命周期/catalog 过滤/门禁 400/test-run 双模式+全错误语义（400/404/409） |

## 7. 验证

- `cargo build --workspace`：0 error。
- `cargo test -p domain -p storage -p application -p web -p app`：全绿——domain 16+6、
  storage（除下述环境性失败外全绿，strategy_store 7/7）、application 37+21、web 45 单测+全部
  集成套件（api_strategies 5/5）、app 全绿。
- `cargo clippy --workspace --all-targets`：本次新增代码 0 warning（见 §9 遗留 1）。
- tangle 门禁：`git add -A && entangled tangle && git diff --quiet` → 无 diff（与
  scripts/check-tangle.sh 同语义）。

## 8. 歧义与处理

1. **test_run 入参双 code 字段**：任务书入参 {code|version_id, params, code(股票), …} 有两个
   code。wire 格式命名 `symbol`（标的），`code` 保留为策略源码——已在 web DTO 与 §1.7 文档注明。
2. **catalog level 语义**：取 at-least（阶梯）而非精确匹配，理由见 §5；若父级要精确匹配，
   改动仅在 storage catalog 一处 + 两个测试。
3. **分钟级区间上限**：任务书只给「日线≤5年/1m≤3个月」；实现将 M1/M5/M15 统一按 3 个月
   （93 天）上限（分钟级同族从严，文档注明）。
4. **draft→archived**：严格单向表（不允许），archived 一切转出拒绝（409）。
5. **播种 per-item skip（name+sha256）不可达**：「表为空」总闸先行时逐款跳过实际不触发，
   作为纵深防御保留（两口径任务书均要求）。
6. **sim_position 仅默认配置**：任务书给定默认阈值 60/40+LumpSum 1.0+默认 FeeModel；可调
   DCA/止损属 ADR §13.5「可调」范畴，本期未暴露（可在后续迭代加可选字段，不破坏 wire 兼容）。

## 9. 遗留风险

1. **pre-existing clippy warnings ×11**（base tree 即有，clippy 1.97 新 lint 命中旧代码：
   application/simlive.rs×4、application/tests/simlive.rs×3、storage/reader.rs（tangle）×1、
   web/simlive.rs×2、mcp/tools.rs×1）。**本次变更新增 0 warning**；基线 11 个属 simlive/reader/mcp
   既有文件（部分涉红线 crate 与 tangle 生成物），未动——建议父级单开清理任务。
2. **storage alert_store::list_events_filters 环境性失败**：dev 库被运行中的 eestock-app 写入
   真实 alert_events（行 id=478，2026-09-07 02:04 恰落在该测试固定窗口 t0+4m..t0+6m 内）。
   与本变更无关（本变更不触 alert 任何表；该失败在 base tree 同现）。属测试与共享 dev 库
   环境污染的既有问题。
3. **并发发布/编辑**：状态机校验与写非原子（先读后写），单进程应用面可接受（与 sim 同口径）；
   多实例部署需加乐观锁（DB trigger 已是最后防线）。
4. **mcp 工具族未做**：属 ADR P3 范围，本任务仅 REST。
5. dev DB（127.0.0.1:5433）已手动 apply 0022；容器重建时由 initdb 自动应用。
