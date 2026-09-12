# 147 — D11 实施：标的类型元数据 + 按类型推断的费率默认值（ADR-019）

> 本文档自身路径：`eestock-rs/coder/report/147_d11_symbol_type_fee.md`
> 任务：D11 实施（ADR-019 D11-1~D11-6）；架构师 2026-09-12 逐条裁决（Q1=A2 / Q2=3 行 / Q3=不扩展 FeeModel /
> Q4=A（Option + 解析下沉 application + FeeProfileStore 端口）/ Q5=批准 SymbolLatestView 加 type / Q6=注册端点须支持可选 type）。
> 本批**不 git add/stage**；不重启生产服务；生产库除「架构师批准的 0025 迁移」外零写入。

## 1. 交付物一览

| # | 交付物 | 位置 |
|---|---|---|
| ① | **D11-4 分类清单（复核件，已批准）** | `eestock-rs/coder/report/147_d11_classification_review.md`（44/44：42 etf / 2 lof / 0 stock；逐条依据） |
| ② | 迁移（tangle 生成，644） | `eestock-rs/migrations/0025_symbol_type_fee_profiles.sql`（97 行；源：`design/04-storage/schema.md` §4.3.16） |
| ② | 迁移幂等测试（事务内 + ROLLBACK） | `eestock-rs/crates/storage/tests/symbol_type_fee_migration.rs` |
| ② | 档案读取端口实现 | `eestock-rs/crates/storage/src/fee_profile.rs` + `crates/storage/tests/fee_profile_store.rs` |
| ② | 三层费率解析（application 单点） | `eestock-rs/crates/application/src/fee.rs`（`resolve_fee` / `FeeSource` / `resolved_fee_to_json`） |
| ② | 端到端实测（真实库+真实 K 线） | `eestock-rs/crates/mcp/tests/d11_fee_profile_e2e.rs` |
| ③ | 证据 | `eestock-rs/coder/evidence/147_d11/migration_apply.md` + `symbols_{before,after}_migration.tsv` |
| ④ | 待执行清单 / 影响面 / 回滚 | 本文 §6 / §7 / §8 |

## 2. 变更内容（What changed）

**规模**：36 个已跟踪文件（+1343 / −172）+ 6 个新文件（迁移 97 行、fee_profile.rs 53 行、3 个测试 393 行、
分类清单 114 行）。其中 10 个是 `design/` 事实源文档、1 个前端生成物（`web/src/layouts/SymbolsGrid.tsx`）——改 `design/` 文档后用 `entangled tangle` 单向生成代码（25 个 `crates/` 文件中多数由文档块重新生成）。

### D11-1 `symbols.type`（架构裁决 A2：可空、**不设** NOT NULL 默认值）
- `ALTER TABLE symbols ADD COLUMN IF NOT EXISTS type text` + `symbols_type_check`
  （枚举 `etf`/`lof`/`stock` + D11-6 保留位 `bond_etf`/`money_etf`/`index`）。
- **NULL = 未知**：任何具体类型默认值都会静默错判另一类标的（A1 默认 etf → 将来个股按 ETF 计费；
  A3 默认 stock → ETF 按股票口径计费），故不设默认值；未设 type 的标的在费率解析走第三级回退（旧默认 +
  `source="default"` 回显），不借用他类型档案。
- 写入口（Q6）：`POST /api/symbols`（可选 `type`，省略 = NULL）、`PATCH /api/symbols/{code}`（`type` 可选；
  空串 → 400，避免「意外清空」歧义）、`GET /api/symbols` 与 MCP `list_symbols` 回显 `type`（null = 未设置）。
- 实现：`crates/storage/src/admin.rs`（INSERT/COALESCE UPDATE）、`crates/web/src/{dto,rest}.rs`、
  `crates/storage/src/reader.rs`（`SYMBOLS_LATEST_SQL` + `SymbolLatestView.type_`）、`crates/mcp/src/tools.rs`。

### D11-2 `fee_profiles`（3 行：etf / lof / stock）
| type | commission_rate_pct | min_fee | exchange_fee_pct | regulatory_fee_pct | stamp_duty_pct | transfer_fee_pct |
|---|---|---|---|---|---|---|
| etf | 0.025 | 5.0 | **0** | **0** | **0** | **0** |
| lof | 0.025 | 5.0 | **0** | **0** | **0** | **0** |
| stock | 0.025 | 5.0 | 0.00341 | 0.002 | 0.05 | 0.001 |

- 每行带 `note`（口径）与 `source`（来源）字段（D11-2 要求）；ETF/LOF 的 note 明确写：
  **经手费事实值 0.04‰ 已按平台「全佣」口径含于佣金 → 列 0，不得叠加**（否则重复计费）、
  印花税**不征**（《印花税法》第三条列举式定义仅含股票/存托凭证）、过户费**免收**（中国结算）。
- `lof` 独立成行（架构裁决 Q2：显式行可审计，拒绝隐式回退）；`bond_etf`/`money_etf`/`index` 保留位
  **不播种**（D11-6）；**不设** `symbols.type → fee_profiles.type` 外键（保留位可无档案行，缺档案 fail-soft）。

### D11-3 按类型推断（解析在 application 服务层单点，MCP 与 REST 同口径）
- 新端口 `domain::ports::FeeProfileStore::for_symbol(code)`（storage：`symbols s JOIN fee_profiles p ON p.type = s.type`）。
- `crates/application/src/fee.rs::resolve_fee(explicit, profile)` 三层：
  1. **显式传 `fee` 对象 → 整体以显式为准**（缺 `stamp_duty_pct` 仍 0.05 → 旧行为完全可复现）`source="explicit"`；
  2. **省略 `fee` + 有档案 → 档案生效值**（`commission_rate_pct`/`min_fee`/`stamp_duty_pct`；滑点非费率事实
     → ADR bt-1 默认 2bp）`source="profile"`；
  3. **`type` 未设 / 无档案 → 旧 ADR bt-1 默认**（0.025/5/0.05/2）`source="default"`。
- 请求类型 `TestRunRequest.fee` / `SubmitRunReq.fee`：`Value` → `Option<Value>`（None = 未显式传）；
  服务装配 `with_fee_profiles(store)`（未装配 = 不推断，既有测试夹具行为不变）。
- 回显：`fee` 对象在原 4 字段上增 `source`（explicit|profile|default）、`symbol_type`，
  解析到档案时附 `profile`（含经手费/证管费/过户费事实列 + 口径 note + 来源）；
  试算响应、工作台钉住 `config.fee` 快照同结构。
- 生产装配：`crates/app/src/bin/eestock-app.rs` 给 `StrategyService` 与 `WorkbenchService` 注入
  `PgFeeProfileStore`（**未显式传 fee 的试算/回测按标的 type 推断**）。
- **sim-live 回测对比保持会话 FeeModel 口径**（显式传入、不走类型推断）——否则同一会话的模拟与回测口径分叉
  （会话费率由 `start_session` 钉住）；已在代码注释与报告登记。

### D11-5 文档口径（唯一出口 + 交叉引用）
- `design/08-backtest/01-engine-adr.md` §4 增 **D11 费率口径段**（ETF/LOF 印花税不征 0、过户费免收 0、全佣口径；
  股票印花税卖出 0.5‰ 等事实；引擎消费范围与 D11-follow-up 债务；回显结构）+ §8 决策表增 D11 修订行。
- `design/07-app-plane/01-mcp.md`：`strategy_test_run`/`bt_run_ensemble` 的 tool schema 与描述改写为
  「省略 fee = 按标的 type 查 `fee_profiles`；显式对象整体优先；回显生效 fee + source」；
  `list_symbols` 描述/字段增 `type`。
- `design/07-app-plane/00-web-api.md`：`GET/POST/PATCH /api/symbols` 契约增 `type`（含 400 语义）；
  `SymbolDto`/`SymbolLatestView`/`SymbolAdminInput`/`SymbolPatch` 契约同步。
- `design/06-web/03-symbols.md` + `web/src/layouts/SymbolsGrid.tsx`：表单增可选 `type`（`SymbolType` 联合类型）+
  页面说明（type → 费率推断；省略 = 未知不静默错判；不支持经 API 清空）。
- `design/12-strategy-system/01-adr.md` §13.5.1：fee 口径更新为 D11 三层解析并交叉引用 §4。
- `design/02-domain/contracts.md`、`design/04-storage/{schema.md,03-raw-writer.md,02-tushare-sync.md}`：
  端口/表/迁移/模块注册/`migrate_check.EXPECTED_RELATIONS`（+`fee_profiles`）。

## 3. 架构对齐（Architecture alignment）

| 层 | 变更 | 依据 |
|---|---|---|
| domain（端口） | `FeeProfileRow` + `FeeProfileStore`；`SymbolLatestView.type_`；`SymbolAdminInput/SymbolPatch.type_` | 既有模式：端口在 domain、storage 实现、app bin 装配（ADR-017 分层红线不变） |
| storage（基础设施） | 迁移 0025；`fee_profile.rs`（新模块，非 tangle 手写，契约在 schema.md §4.3.16）；`admin.rs`/`reader.rs` 增 type 列；`migrate_check` 台账 | 应用面自有表（数据面不读写），与 favorite/ma_config/config_store 同口径 |
| application（用例） | `fee.rs` 三层解析（**单一口径源**）；`strategy.rs`/`workbench.rs` 请求 `fee: Option`、装配 `with_fee_profiles`、回显 | 服务层持有策略（I-3 教训：双通道口径必须一致）；不依赖 web/storage/sqlx |
| presentation（MCP/REST） | 不再硬编码缺省 fee（删 `default_fee_json`/`default_test_run_fee`）；传 None 交服务解析；回显/契约字段 | transport 保持薄；MCP `list_symbols` 与 web `/api/symbols` 同源（`KlineReadersymbols_with_latest`） |
| backtest 引擎 | **零改动**（`FeeModel` 4 参数不变） | 架构裁决 Q3：扩展 = backtest+strategy-core+simlive 全链路 HIGH 风险，超 D11 范围 → 债务登记 §9 |

## 4. 解决的问题 / 新增能力

- **修复系统性失真**：平台 44 只注册标的全部为 ETF/LOF，旧缺省印花税 0.05%（股票口径）对 100% 标的是错的。
  实测（真实库 510050，129 根 D1，一笔期末平仓）：旧口径 stamp 合计 49.74 元、pnl −601.33；
  D11 后 stamp 0、pnl −551.59，**Δpnl = +49.74 元**（与 ADR-019 背景「少 50.83 元 / 3.2%」同量级同方向）。
- **可审计的元数据驱动**：费率 = `symbols.type` → `fee_profiles`（每行带口径/来源），分类有逐条依据清单；
  显式传参始终优先 → 旧结论可复现（审计重跑不受影响）。
- **为注册个股铺路**：`stock` 档案已按 ADR §1.2 事实播种；注册端点可选 `type`。

## 5. 测试覆盖（TDD：Red → Green）

| 测试 | 文件 | 锁定内容 |
|---|---|---|
| `migration_0025_idempotent_backfill_and_seed_in_rolled_back_tx` | `crates/storage/tests/symbol_type_fee_migration.rs`（新） | 迁移**幂等**（同事务内连跑 4 次）、`type` 可空且**无默认值**、CHECK 拒枚举外/收保留位、44 码回填（42/2/0 + 抽样硬编码）、`fee_profiles` 三行事实值、保留位不播种、NULL/未注册 → 无档案、幂等语义（不覆盖人工值 / 补 NULL）**全部在事务内 ROLLBACK（未污染生产库）** |
| `for_symbol_resolves_profile_by_type_and_misses_fail_soft` | `crates/storage/tests/fee_profile_store.rs`（新） | 真实库：`510050`→etf、`160723`/`161226`→lof（stamp/transfer/exchange/regulatory 全 0、note 含「全佣」、source 指 ADR-019）、未注册 → None |
| `fee::tests::*`（+7 新） | `crates/application/src/fee.rs` | 三层解析：显式优先且缺 stamp 仍 0.05、档案分支（滑点取 2bp）、default 分支、非法显式 fee 传播错误、回显结构（source/symbol_type/profile 明细） |
| `test_run_fee_resolves_by_symbol_type_when_absent` | `crates/application/tests/strategy.rs`（新） | 试算：省略 fee → stamp 0 / source=profile / symbol_type=etf；显式 → explicit + 0.05；未建档 → default；**未装配端口 → 旧行为不变**（向后兼容） |
| `submit_fee_resolves_by_symbol_type_and_pins_source` | `crates/application/tests/workbench.rs`（新） | 工作台：钉住 config 快照 = 档案生效值 + source；显式优先；未建档 → default |
| `strategy_test_run_fee_resolves_by_symbol_type` / `bt_run_ensemble_fee_resolves_by_symbol_type_and_pins_source` / `list_symbols_exposes_symbol_type_or_null` | `crates/mcp/src/tools.rs`（doc 01-mcp.md） | MCP 双通道（试算/工作台）省略 fee 按类型解析 + source 三值回显；`list_symbols` 回显 `type`（null 语义） |
| `symbols_type_optional_register_and_patch` / `symbol_type_validation_enum_and_optional` / `symbol_admin` 扩展 | `crates/web/tests/api_admin.rs`、`crates/web/src/dto.rs`、`crates/storage/tests/symbol_admin.rs` | 注册/编辑 `type`：省略 → NULL、枚举外/空串 → 400、PATCH 生效、未给字段保留、保留位可登记、CHECK 兜底、`GET /api/symbols` 回显 |
| `real_db_etf_default_fee_is_stamp_free_and_explicit_still_wins` | `crates/mcp/tests/d11_fee_profile_e2e.rs`（新） | **端到端（生产装配同结构 + 真实库 + 真实 K 线）**：`510050` 省略 fee → stamp 0/transfer 0/规费 0/source=profile；显式 → stamp 0.05 且 stamp 合计 >0；pnl 修复方向断言 |

## 6. 验证与验收证据（Verification）

| 检查 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `cargo test --workspace` | **641 passed / 0 failed**（exit 0；94 个 test result 汇总，含 15 个 doc-tests 目标） |
| 前端类型检查 | `cd web && npx tsc -b --force` | 0 error（`SymbolsGrid.tsx` 新 `type` 字段向后兼容：可选） |
| 前端单测 | `cd web && npx vitest run` | 47 files / **457 passed** |
| 编译 | `cargo build --workspace` | 0 warning |
| Clippy | `cargo clippy --workspace --all-targets` | 仅 2 条**既有**告警（`strategy.rs` clone_on_copy、tester 文件 borrowed expr），本批新增告警已清零 |
| **tangle 门禁** | `./scripts/check-tangle.sh` | ✅ 沙箱重新生成 + 逐字节比对通过（工作区未被修改） |
| 迁移应用 | `psql -v ON_ERROR_STOP=1 -f migrations/0025_…sql` | 首次：`ALTER TABLE / DO / UPDATE 44 / CREATE TABLE / INSERT 0 3` |
| 迁移幂等 | 重复执行 ×3 | `UPDATE 0` / `INSERT 0 0` / NOTICE skipping；状态不变（3 profiles、42 etf、2 lof、0 NULL、44 rows） |
| 数据完整性 | `diff symbols_before/after.tsv` | 无差异（纯加法迁移） |
| 端到端实测 | `cargo test -p mcp --test d11_fee_profile_e2e -- --nocapture` | 见 §4 数字（Δpnl +49.74 元） |

## 7. 待执行清单（运维 / 后续动作）

| # | 动作 | 状态 | 步骤 / 影响面 | 回滚 |
|---|---|---|---|---|
| 1 | **应用迁移 0025** | ✅ **已执行**（架构师批准后） | `psql -v ON_ERROR_STOP=1 -f migrations/0025_symbol_type_fee_profiles.sql`；纯加法（44 行回填 + 3 行档案） | `ALTER TABLE symbols DROP COLUMN type; DROP TABLE fee_profiles;`（无代码/数据依赖，可即时回滚；旧二进制继续工作，但 D11 解析失效 → 需同时回滚代码） |
| 2 | **部署新二进制（数据面+应用面）** | ⏳ **待执行（未做；本批不重启生产服务）** | 现有进程仍跑旧代码：DB 侧已具备 type/档案，但**运行中的服务不会按类型推断**；重新构建/切换镜像后 `strategy_test_run`/`bt_run_ensemble` 才生效。启动自检 `migrate_check` 已登记 `fee_profiles`（缺失会启动失败 → 顺序：先迁移，后部署） | 回切旧镜像（旧代码忽略 `type`/`fee_profiles`，无破坏） |
| 3 | **tester 验收断言更新（跨团队）** | ⏳ 待 tester | `crates/mcp/tests/zz_tester_010_acceptance.rs` 的 I-3 用例 `assert_eq!(p_fee_def["fee"]["stamp_duty_pct"], json!(0.05), "缺省须回显 0.05")` 针对 `CODE="518880"`（真实 ETF）：其夹具**未装配**档案端口 → 今天仍 0.05 通过；但生产已接线，若 tester 按生产装配/直连 MCP 复验，缺省应变为 **0.0 + source=profile**（这是 D11 的预期行为变更，须同步断言，勿误判回归） | 不需要 |
| 4 | D11-follow-up 债务（§9） | ⏳ 登记 | 见 §9 | — |
| 5 | `551000` 的 `name` 补录 | ⏳ 后续项 | 数据面任务（tushare `fund_basic` 当前 token 无权限；替代=交易所基金列表/手工录入）。不影响 `type=etf` 与费率 | — |

## 8. 影响面与残留风险

- **行为影响面**：`strategy_test_run` / `bt_run_ensemble`（含 web REST 同服务路径）在**未显式传 fee** 时，
  ETF/LOF 标的印花税由 0.05% → 0（过户费列 0 亦不再隐含在股票口径中）；显式传参者零变化；
  `symbols.type` 为 NULL 的标的零变化。sim-live 内部回测对比保持会话费率（不变）。
- **历史回测结论**：旧 run 的 `config.fee` 快照原样保留（复现仍按显式 fee），新 run 才用推断值 → **不会改写历史**。
- **残留风险**：
  1. 生产服务尚未重启 → 新旧行为并存期（DB 已就绪、运行时未生效），运维需知；
  2. 港股通/恒生系 4 只 ETF 的 `settlement`（T0/T1）历史存疑（`coder/report/002` §5）——与 D11 无关，未被本批改动；
  3. 债券/货币 ETF 的经手费豁免未建模（D11-6 明确排除）→ 债券 ETF 成交额被计 0.04‰ 经手费口径
     （实际因其为全佣口径列 0，本批同样为 0，故无实际偏差；待 D11-follow-up 建模时一并复核）；
  4. `type` 为空壳（NULL）的既有/新建标的：费率回落旧默认并在回显 `source="default"` 显式可见，
     不会静默按 ETF 计费（符合 A2 裁决），但**仍需运营侧补录 type**，否则该标的一直是股票口径；
  5. 未做：`symbols.type` 的 MCP 写入通道（MCP 无 symbols 写工具，与既有范围一致）。

## 9. D11-follow-up（架构裁决要求显式登记的债务）

1. **扩展 `backtest::FeeModel` 建模规费**（架构裁决 Q3 明确登记）：待注册个股或需规费精度时，
   FeeModel 须支持 `exchange_fee_pct`（经手费，双边）、`regulatory_fee_pct`（证管费，双边）、
   `transfer_fee_pct`（过户费，双边）与 `stamp_duty_pct`（**仅卖出侧**）的叠加口径；对应
   `backtest`/`strategy-core`（engine）/`simlive` 全链路 + 黄金样本重算（**HIGH 风险改动，须单独立项**）。
   当前 `fee_profiles` 已把三项事实值入库，扩展时无需再改 schema。
2. **债券 ETF / 货币 ETF 经手费豁免**（D11-6 保留位）：需要时新增 `bond_etf`/`money_etf` 档案行 +
   把对应标的重分类为该 type（分类清单 §2 已记录子类，可直接执行）。
3. **`fee_profiles` 按标的覆盖**（ADR-019 §4 提到的「免五/全佣」券商差异）：需要时增 `symbol` 维度覆盖表，
   保持本表为类型默认。
4. **`551000` 名称补录**（分类清单 §4）。

## 10. 复现命令（reviewer 快速核对）

```bash
cd eestock-rs
# 1) 分类清单（重点交付）与迁移原文
sed -n '1,60p' coder/report/147_d11_classification_review.md
sed -n '1007,1140p' design/04-storage/schema.md      # §4.3.16（迁移事实源）

# 2) 测试（含迁移幂等/事务回滚、端口、三层解析、MCP/web、E2E）
cargo test -p storage --test symbol_type_fee_migration
cargo test -p storage --test fee_profile_store
cargo test -p application --lib fee::
cargo test -p application --test strategy --test workbench
cargo test -p mcp --lib
cargo test -p web --test api_admin
cargo test -p mcp --test d11_fee_profile_e2e -- --nocapture

# 3) 门禁 + 全量
./scripts/check-tangle.sh && cargo test --workspace

# 4) DB 现状（只读）
psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -c "SELECT coalesce(type,'(NULL)'), count(*) FROM symbols GROUP BY 1;"
psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -c "SELECT * FROM fee_profiles ORDER BY type;"
```
