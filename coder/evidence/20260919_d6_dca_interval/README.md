# D6 —— `Dca.interval` 语义与校验（fail loud + 省略 = 默认 1）

- **本文件位置**：`coder/evidence/20260919_d6_dca_interval/README.md`
- **原始证据**：同目录 `raw/`（文件清单见文末「证据索引」）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`，基线 HEAD `40d16e1`（ADR-026 已提交）
- **日期**：2026-09-19
- **车道**：worker（TDD，Red→Green→Refactor→突变自检）
- **临时库**：`tmp_d6_1789806347`（ADR-025 流程；已 `DROP DATABASE ... WITH (FORCE)`，见 `raw/51_db_teardown.txt`）
- **提交状态**：**未 `git add` / 未 commit**（按本单硬纪律，冻结与提交归主代理）

---

## 1. 交付结论

| 契约 | 交付 | 判据 |
|---|---|---|
| ① 显式 `interval == 0` → **fail loud**，复用既有错误码体系 | ✅ | HTTP：400 `code=policy_invalid`，`message="Dca.interval 必须 ≥ 1（省略即为默认 1）"`；MCP：`isError=true` + 同文案 |
| ② **省略 `interval` = 默认 1**（让文档成真） | ✅ | `#[serde(default = "default_dca_interval")]`；HTTP/MCP 均 201 接受且 `batches_done` 与显式 `interval=1` **数值相等** |
| ③ `interval ≥ 1` 行为与数值**一律不变** | ✅ | 单测 `dca_interval_batch_counts_unchanged_for_1_5_20`（1/5/20 在 20 根 Buy bar 上 = 20/4/1 批 + 股数闭式解）；入口级 `interval=5` 对照 run `batches_done=1` |
| 所有入口都走到校验（无绕过） | ✅ | 见 §4（逐处 file:line，含 `sim_start_session` 不接受 policy 的排除） |
| 文档事实源同步 | ✅ | `design/12-strategy-system/01-adr.md:99` 已改为「interval **≥ 1**；省略 = 1」+ fail loud 说明 |
| entangled 门禁 | ✅ | `./scripts/check-tangle.sh` → ✅（`raw/50_check_tangle.txt`）；**未触碰任何托管生成物**，故无需 re-tangle |
| 突变自检 | ✅ | 移除新校验 ⇒ **5 条测试变红**（跨 4 个测试二进制）；还原后 sha256 与突变前逐字节一致 |

---

## 2. 改了什么（文件级）

| 文件 | 类型 | 说明 |
|---|---|---|
| `crates/strategy-core/src/policy.rs` | 改（+110/−8 行左右） | `Dca.interval` 加 `#[serde(default = "default_dca_interval")]`；`validate()` 增加 `interval == 0` → `Err("Dca.interval 必须 ≥ 1（省略即为默认 1）")`；`norm_interval` 注释降级为「纵深防御」；新增 3 条单测 + 翻转 1 条旧契约断言（见 §3.2） |
| `design/12-strategy-system/01-adr.md:99` | 改（1 行） | Dca 契约明确「`interval` **≥ 1**；省略 = 1」+「`tranches<1`/`interval=0` fail loud，不再静默归一化」（**非** entangled 事实源外的生成物，改后门禁仍 ✅） |
| `web/src/features/workbench/ConfigPanel.test.tsx` | 改（+26 行） | 新增 vitest：`interval=0` 被前端拦截（渲染错误 + 不提交），`interval=1` 边界放行（防回归） |
| `crates/application/tests/d6_dca_interval_serde.rs` | 新（手写测试） | serde 契约：省略→1；显式 0 语法可解析但 `validate()` 拒绝；1/5/20 取值不变 |
| `crates/web/tests/d6_dca_interval.rs` | 新（手写测试） | HTTP 入口：`POST /api/workbench/runs` 的 400/201 + `/audit` 批次数等价性（含 `interval=5` 判别对照） |
| `crates/mcp/tests/d6_dca_interval.rs` | 新（手写测试） | MCP 入口：`bt_run_ensemble` 的 `isError` + 省略接受 + `bt_get_run_audit` 批次数 |

**未改动**（刻意守界）：
- `crates/mcp/src/tools.rs`（policy JSON 描述串原样；故 `design/07-app-plane/01-mcp.md` 无需同步、无需 re-tangle）；
- `crates/web/src/lib.rs`、`crates/mcp/tests/mcp_protocol.rs`、`crates/mcp/tests/mcp_tools_db.rs` 等 entangled 托管生成物；
- `design/01-architecture/adr/ADR-026-*.md`（债务表由主代理更新；该文件 §债务 D6 行仍在）；
- `web/src/api/types.ts` / `ConfigPanel.tsx` 的校验逻辑（既有校验已正确，仅补测试）。

---

## 3. TDD 记录

### 3.1 Red（先写失败测试）

**单测（strategy-core）** —— `raw/10_red_unit_strategy_core.txt`
```
---- policy::tests::dca_interval_zero_is_rejected_loudly stdout ----
thread '...' panicked: interval=0 必须被拒绝（D6：静默归一化 → fail loud）: ()
---- policy::tests::policy_validation stdout ----
thread '...' panicked: interval=0 必须拒绝（不再静默归一化为 1）: ()
test result: FAILED. 16 passed; 2 failed
```
（同批 `dca_interval_batch_counts_unchanged_for_1_5_20` / `dca_interval_positive_still_valid` 为契约③的**基线不变**护栏，Red 前即绿、实现后仍绿 —— 证明「不变」而非「改了又改回」。）

**serde（application）** —— `raw/11_red_serde_application.txt`
```
dca_interval_omitted_deserializes_to_default_one ... FAILED
  省略 interval 必须可反序列化（文档：可选，默认 1）: Error("missing field `interval`", line: 0, column: 0)
dca_interval_explicit_zero_parses_but_validate_rejects ... FAILED
test result: FAILED. 1 passed; 2 failed
```

**HTTP 入口** —— `raw/12_red_web_entry.txt`（原始响应）
```
[D6 workbench/interval=0] status=201 Created raw body={"id":"sr_1789806382466_000004",...,"config":{...,"policy":{"Dca":{"interval":0,"mode":"Equal","tranches":2}},...},"status":"queued",...}
assertion `left == right` failed: 显式 interval=0 必须 400（fail loud），实得 201 Created
[D6 omit/omitted] submit status=400 Bad Request body={"error":{"code":"policy_invalid","detail":{"period":"M1"},"message":"policy 非法: missing field `interval`"}}
assertion `left == right` failed: [omit/omitted] 应 201（接受）
```
⇒ 同时实证了债务描述的**两条**事实：`interval=0` 被静默接受（201 且 config 回显原样 0）；省略 `interval` 反序列化失败（与文档矛盾）。

**MCP 入口** —— `raw/13_red_mcp_entry.txt`（原始响应）
```
[D6 mcp/interval=0] isError=null raw text={"run":{...,"config":{...,"policy":{"Dca":{"interval":0,...}}},...},"run_id":"sr_1789806407502_000004"}
assertion failed: 显式 interval=0 必须 isError
[D6 mcp/omitted] isError=true raw text=工具执行失败：policy 非法: missing field `interval`
assertion failed: 省略 interval 必须被接受
```

**前端（vitest）**：新增用例 Red 前**不适用**（属「防回归」断言，既有校验已正确）——`raw/35_regress_web_vitest.txt` 中该用例绿；其判别力由「突变前端校验即红」的对称性保证（本单只做了后端突变，见 §5 说明）。

### 3.2 Green（最小实现）

实现三处（`crates/strategy-core/src/policy.rs`）：
1. `#[serde(default = "default_dca_interval")] interval: usize`，`const fn default_dca_interval() -> usize { 1 }`
   —— **必须**用显式 default 函数：裸 `#[serde(default)]` 对 `usize` 给 0，而 0 是非法值，会自相矛盾。
2. `validate()`：`if *interval == 0 { return Err("Dca.interval 必须 ≥ 1（省略即为默认 1）") }`
   —— 文案前缀 `Dca` 命中 `crates/application/src/error.rs:91-101` 的 `classify_config_error`（判定分支 `:96-97`）⇒ `code = policy_invalid`（**复用既有体系，未新增错误码**）。
3. `norm_interval` 注释改写为「validate 已保证 ≥1；此处仅为纵深防御」，函数体（`interval.max(1)`）**保持不变**（契约③：既有触发逻辑不动）。

Green 输出：`raw/20_green_unit_strategy_core.txt`（18 passed）、`raw/21_green_serde_application.txt`（3 passed）、`raw/22_green_web_entry.txt`、`raw/23_green_mcp_entry.txt`。

**入口级原始响应（Green）** —— `raw/22_green_web_entry.txt`
```
[D6 workbench/interval=0] status=400 Bad Request raw body={"error":{"code":"policy_invalid","detail":{"period":"M1"},"message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}
[D6 omit/omitted]   submit status=201 Created  config.policy={"Dca":{"mode":"Equal","tranches":10}}   audit batches_done=2 reachable_batches=2 planned_tranches=10
[D6 omit/interval=1] submit status=201 Created config.policy={"Dca":{"interval":1,"mode":"Equal","tranches":10}} audit batches_done=2 reachable_batches=2 planned_tranches=10
[D6 omit/interval=5] submit status=201 Created config.policy={"Dca":{"interval":5,"mode":"Equal","tranches":10}} audit batches_done=1 reachable_batches=2 planned_tranches=10
```
⇒ 省略 与 显式 1 的 `batches_done` **都是 2**（等价）；`interval=5` 为 **1**（判据可判别，非恒真）。fixture = 6 根 M1（close 100/100/110/110/100/100）+ trend 插件 ⇒ 2 个 Buy 意图（bar2/bar3）。

`raw/23_green_mcp_entry.txt`
```
[D6 mcp/interval=0] isError=true raw text=工具执行失败：Dca.interval 必须 ≥ 1（省略即为默认 1）
[D6 mcp/omitted]   isError=null  config.policy={"Dca":{"mode":"Equal","tranches":10}}  audit batches_done=2 reachable_batches=2 planned_tranches=10
```

### 3.3 Refactor
仅在测试保护下做注释/文档收敛：`norm_interval` 注释改写、结构体字段 doc 补「≥1；省略=1；显式 0 fail loud」、设计文档同步。**无**行为改动、**无**测试删除或按实现输出倒推的断言（唯一被改动的旧断言见 §5.1）。

---

## 4. 入口审计（`policy.validate()` 可达性，逐处 file:line）

完整文本：`raw/53_entry_audit.txt`。

| 入口 | 链 | 结论 |
|---|---|---|
| web `POST /api/workbench/runs` | `crates/web/src/workbench.rs:240`（handler）→ `:332` policy 透传 → `crates/application/src/workbench.rs:495` serde → **`:533 probe.validate()`** → `crates/strategy-core/src/engine.rs:92` `EnsembleConfig::validate` → **`:114 self.policy.validate()`** | ✅ 覆盖（已实测 400/201） |
| MCP `bt_run_ensemble` | `crates/mcp/src/tools.rs:1293`（组 `SubmitRunReq`）`:1371` → `wb.submit` | ✅ 同一链（已实测） |
| MCP `strategy_test_run` | `crates/mcp/src/tools.rs:1188` → `crates/application/src/strategy.rs:766`（serde）**`:769 policy.validate()`** | ✅ 覆盖（显式调用） |
| web 试算（strategies 路由） | `crates/web/src/strategies.rs:186`（`policy: Option<Value>`）`:498` → 同上 `strategy.rs` | ✅ 覆盖 |
| MCP `sim_start_session` | `crates/mcp/src/tools.rs:763` | ⚪ **不接受 policy**：`policy` 硬编码 `{"LumpSum":{"position_pct":1.0}}`（`crates/application/src/simlive.rs:1563`）⇒ 无缺口 |
| 预设保存/应用 | `crates/application/src/workbench.rs:1488-1491`（解析）`:1492-1539`（**`probe.validate()`**） | ✅ 覆盖 |

**无任何入口绕过 `validate`** ⇒ 不触发任务书的 BLOCKED 条款。

`norm_interval`（`policy.rs:100`）为**私有 fn**，唯一调用者 `PolicyState::target_qty`（`policy.rs:192`），已由 crate 内测试与入口级 run 共同覆盖。

**影响面（活库只读取证）** —— `raw/52_live_db_interval_distribution.txt`：
```
interval | status   | n
0        | succeeded| 1     <- sr_1789787981802_000007（D6 复现对照，改造后同类请求将 400）
1        | succeeded| 14
5        | succeeded| 137
5        | canceled | 1
20       | succeeded| 2
```
即：本次改造在历史数据上**只影响 1 条** `interval=0` 的 run（拒绝），`1/5/20` 的 152 条语义与数值不变；**0 条**省略 `interval`（与「前端总是显式发送」相符）。

---

## 5. 突变自检（mutation check）

把新增的 `interval == 0` 校验**临时移除**（`raw/41_mutation_red.txt`）：

| 测试二进制 | 变红用例 | 结果 |
|---|---|---|
| `strategy-core --lib policy` | `dca_interval_zero_is_rejected_loudly`、`policy_validation` | 2 failed |
| `application --test d6_dca_interval_serde` | `dca_interval_explicit_zero_parses_but_validate_rejects` | 1 failed |
| `web --test d6_dca_interval` | `d6_workbench_entry_rejects_interval_zero_loudly` | 1 failed |
| `mcp --test d6_dca_interval` | `d6_mcp_bt_run_ensemble_rejects_interval_zero_loudly` | 1 failed |

⇒ **5 条**测试变红（要求 ≥2）✔。

还原（`cp` 回备份文件，**未使用**任何 git 命令）：

```
raw/40_mutation_sha256_before.txt        cec749d83b8bcbf1cfdd10a8780bd9ca881ef2df3144ef333ee93cb1956245c5  crates/strategy-core/src/policy.rs
raw/42_mutation_sha256_after_restore.txt cec749d83b8bcbf1cfdd10a8780bd9ca881ef2df3144ef333ee93cb1956245c5  crates/strategy-core/src/policy.rs
```
⇒ **突变前 == 还原后，逐字节一致**。还原后四套件全绿：`raw/43_post_mutation_green.txt`（18 / 3 / 2 / 2 passed）。

**说明**：前端 vitest 新增用例在「Red 前」即为绿（既有校验已正确），本单对后端做了突变验证；前端校验若被放宽，该用例会红（断言 = 错误文案 + `onSubmit` 未被调用）。

---

## 6. 回归

| 命令 | 结果 | 原始输出 |
|---|---|---|
| `cargo test -p strategy-core` | ok（36+26+6+7+1+3 passed，0 failed） | `raw/30_regress_strategy_core.txt` |
| `cargo test -p application --lib` | ok 46 passed，0 failed | `raw/31_regress_application_lib.txt` |
| `cargo test -p application`（全） | ok（46+2+6+3+3+55+41+3+43 passed） | `raw/32_regress_application_all.txt` |
| `cargo test -p web`（全，含 `adr024_structured_errors` / `adr026_run_audit` / `api_workbench`） | ok，0 failed | `raw/33_regress_web_all.txt` |
| `cargo test -p mcp`（全，含 entangled 的 `mcp_tools_db.rs`） | ok，0 failed | `raw/34_regress_mcp_all.txt` |
| `npx vitest run`（web） | **94 files / 917 tests passed**（新增 1 条） | `raw/35_regress_web_vitest.txt` |
| `npx tsc -b`（web 类型检查） | exit 0 | 见本节末 |
| `./scripts/check-tangle.sh` | ✅ design 与生成物一致 | `raw/50_check_tangle.txt` |

`tsc` 原始输出（无输出 + exit 0）：
```
$ cd web && npx tsc -b ; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

数据库 teardown（`raw/51_db_teardown.txt`）：
```
$ psql postgres -c 'DROP DATABASE "tmp_d6_1789806347" WITH (FORCE)'
DROP DATABASE
$ psql postgres -Atc "SELECT datname FROM pg_database ORDER BY 1"
eestock
postgres
template0
template1
```
⇒ 临时库已消失，回到基线库清单（`template0/template1` 为集群自带系统库，基线时即存在；基线快照同样是这 4 行）。

---

## 7. 与任务书的偏差 / 取舍（自行取舍登记）

### 7.1 旧断言翻转（唯一一处「改存量测试」）
`policy.rs` 的 `policy_validation` 末尾原断言 `interval: 0 ⇒ is_ok()`，注释为「interval=0 按默认 1 处理」——它**编码的正是 D6 要修的缺陷**（静默归一化），与契约①直接冲突。按契约推导翻转（不是按实现输出倒推）：新断言 `expect_err` + 错误文案含 `Dca.interval`。已在断言处留注说明理由。

### 7.2 MCP 面**不携带** `code` 字段（已报备主代理，采 A 方案）
任务书写「MCP `bt_run_ensemble` … 必须返回**结构化错误且带 code**」。实测 MCP 线上形状**没有 code 字段**：
- `crates/mcp/src/tools.rs:539 tool_fail` 只透传 `format!("工具执行失败：{e}")`；
- `WorkbenchValidation`（`crates/application/src/workbench.rs:150`）/ `StrategyValidation`（`crates/application/src/strategy.rs:141`）的 `Display` 只输出 `message`，**不含** `[code]`（只有 `StructuredError`（`application/src/error.rs:121`）带 `[code]`）；
- 该行为对**全部**工具语义失败一致，**非 D6 引入**。

取舍：**不把 MCP 线格式改宽**（改 `tool_fail` = 动 35 个工具的 wire 契约，属越界；任务书亦要求「不要顺手改大范围」）。
- MCP 侧断言：`isError=true` + message 字段级定位（`Dca.interval` / `默认 1`）；
- `code = policy_invalid` 在 **HTTP 面**断言（原始响应贴出）；
- `policy_invalid` 的**同源性**另有 application 层证据：校验消息前缀 `Dca` → `classify_config_error`（`crates/application/src/error.rs:91-101`）→ `codes::POLICY_INVALID`，并由存量表驱动用例 `crates/web/tests/adr024_structured_errors.rs`（`runs/policy_invalid`）钉住 —— 该用例在本单回归中仍绿。
- 若主代理要求 MCP 面也带码 ⇒ 属接口变更（B 方案），需另行批准。

### 7.3 测试落位（未新增依赖）
契约②的 serde 断言放在 `crates/application/tests/d6_dca_interval_serde.rs`，而**不是** `strategy-core`：`crates/strategy-core/Cargo.toml` 未声明 `serde_json`，为一条测试给 Domain 层新增依赖违反本单「不新增依赖」纪律与分层红线。application 层本就在解析 policy JSON，判据同源且落位自然。**未新增任何依赖**（`Cargo.toml` 零改动）。

### 7.4 未改动 ADR-026 债务表 D6 行
`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md:162` 仍写「D6 … 现状是静默规范化」，按任务书由主代理更新。

### 7.5 GitNexus 索引不可用（工具缺陷，非阻塞）
项目 `AGENTS.md` 要求改符号前 `gitnexus_impact`。实测索引与当前 `@ladybugdb/core` 存储版本不符：
```
$ npx --no-install gitnexus impact validate --direction upstream
{"error":"This index was written by a different @ladybugdb/core build ... Database file version: 43, Current build storage version: 42", "risk":"UNKNOWN"}
```
未执行 `gitnexus analyze --force`（重建索引非本单授权范围，且会写仓内 `.gitnexus/`）。**改用等价静态影响分析**：见 §4（`grep` 全量枚举调用点 + 入口链逐处 file:line）。影响面：`ExecutionPolicy::validate` 的 5 个调用点、`norm_interval` 的 1 个调用点，全部在 §4 表中；`design/` 无对 `policy.rs` 的引用（改前已核，故 `policy.rs` 非 entangled 托管）。

### 7.6 复现 run 保留
`sr_1789787981802_000007`（interval=0，succeeded）**保留未动**，作对照（活库只读查询见 `raw/52_...txt`）。

---

## 8. 证据索引（`coder/evidence/20260919_d6_dca_interval/raw/`）

| 文件 | 内容 |
|---|---|
| `10_red_unit_strategy_core.txt` | Red：strategy-core 单测（2 failed） |
| `11_red_serde_application.txt` | Red：application serde 契约（2 failed，含 `missing field \`interval\``） |
| `12_red_web_entry.txt` | Red：HTTP 入口（interval=0 → 201；省略 → 400） |
| `13_red_mcp_entry.txt` | Red：MCP 入口（interval=0 → 排队；省略 → isError） |
| `20_green_unit_strategy_core.txt` | Green：18 passed |
| `21_green_serde_application.txt` | Green：3 passed |
| `22_green_web_entry.txt` | Green：HTTP 400/201 原始响应 + `/audit` 数字（omitted=2 == interval1=2；interval5=1） |
| `23_green_mcp_entry.txt` | Green：MCP `isError` 原文 + `bt_get_run_audit` 数字 |
| `30_regress_strategy_core.txt` | `cargo test -p strategy-core` |
| `31_regress_application_lib.txt` | `cargo test -p application --lib` |
| `32_regress_application_all.txt` | `cargo test -p application` |
| `33_regress_web_all.txt` | `cargo test -p web` |
| `34_regress_mcp_all.txt` | `cargo test -p mcp` |
| `35_regress_web_vitest.txt` | `npx vitest run`（94 files / 917 tests） |
| `40_mutation_sha256_before.txt` / `42_..._after_restore.txt` | 突变前/还原后 sha256（一致） |
| `41_mutation_red.txt` | 突变后 5 条测试变红 |
| `43_post_mutation_green.txt` | 还原后四套件全绿 |
| `50_check_tangle.txt` | `./scripts/check-tangle.sh` ✅ |
| `51_db_teardown.txt` | 临时库 teardown + 库清单回读 |
| `52_live_db_interval_distribution.txt` | 活库 interval 分布（只读）+ interval=0 run |
| `53_entry_audit.txt` | 入口审计逐处 file:line |

---

**VERDICT: DONE**
