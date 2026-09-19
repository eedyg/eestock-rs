# 286 — D6：`Dca.interval` 语义与校验（fail loud + 省略 = 默认 1）

- **本文件**：`coder/report/286_d6_dca_interval.md`
- **完整报告 + 原始证据**：`coder/evidence/20260919_d6_dca_interval/README.md` 与同目录 `raw/`
- **基线**：HEAD `40d16e1`（ADR-026）；**未 `git add` / 未 commit**（按单子硬纪律，冻结与提交归主代理）
- **VERDICT：DONE**

## 一句话
`Dca.interval` 由「显式 0 静默当 1」改为 **fail loud（400 `policy_invalid`）**，并让文档成真（字段可省略，serde default = 1）；`interval ≥ 1`（1/5/20）的批次计数与数值**逐字节不变**。

## 改了什么
| 文件 | 说明 |
|---|---|
| `crates/strategy-core/src/policy.rs` | `#[serde(default = "default_dca_interval")] interval`；`validate()` 拒绝 0（文案 `Dca.interval 必须 ≥ 1（省略即为默认 1）`）；`norm_interval` 降级为纵深防御（函数体不变）；+3 单测，翻转 1 条编码旧缺陷的断言 |
| `design/12-strategy-system/01-adr.md:99` | Dca 契约改为「`interval` **≥ 1**；省略 = 1」+ fail loud 说明 |
| `web/src/features/workbench/ConfigPanel.test.tsx` | +1 vitest：`interval=0` 前端拦截（防回归），`interval=1` 边界放行 |
| `crates/application/tests/d6_dca_interval_serde.rs` | **新**：serde 契约（省略→1 / 显式 0 被 validate 拒 / 1·5·20 不变） |
| `crates/web/tests/d6_dca_interval.rs` | **新**：HTTP 入口 400/201 + `/audit` 批次数等价性（含 `interval=5` 判别对照） |
| `crates/mcp/tests/d6_dca_interval.rs` | **新**：MCP `bt_run_ensemble` 入口（isError / 省略接受 / `bt_get_run_audit` 数字） |

**未动**：`crates/mcp/src/tools.rs`、任何 entangled 托管生成物、ADR-026 文件、前端校验逻辑、任何 `Cargo.toml`（零新增依赖）。

## 关键判据（数字）
- Red：`interval=0` → HTTP **201**（config 回显 `"interval":0`）；省略 → HTTP **400** `policy_invalid / missing field interval`。
- Green：`interval=0` → HTTP **400** `{"error":{"code":"policy_invalid","message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}`。
- 等价性：省略 `interval` 与显式 `1`，同一 6-bar / 2-Buy 意图 fixture 上 `batches_done` **都是 2**；`interval=5` 为 **1**（判据可判别）。
- 入口审计：web 提交 / MCP `bt_run_ensemble` / `strategy_test_run` / 预设均达 `policy.validate()`；`sim_start_session` 不接受 policy（硬编码 LumpSum）⇒ **无入口绕过**。
- 回归：`cargo test -p strategy-core` ✅、`-p application` ✅（含 `--lib` 46）、`-p web` ✅、`-p mcp` ✅、`web vitest` **917/917** ✅、`tsc -b` exit 0、`check-tangle.sh` ✅。
- 突变：移除新校验 ⇒ **5 条**测试变红（4 个二进制）；还原后 sha256 `cec749d8…` 与突变前**逐字节一致**。
- 临时库 `tmp_d6_1789806347` 已 `DROP … WITH (FORCE)`，库清单回读 = 基线（`eestock, postgres, template0, template1`）。

## 需主代理知情 / 裁决
1. **MCP 面不携带 `code`**：`tools.rs::tool_fail` 只透传 message，`WorkbenchValidation/StrategyValidation` 的 Display 无 `[code]`（对全部工具一致，非 D6 引入）。已采 **A 方案**：不改 MCP wire（改则动 35 个工具契约），`code=policy_invalid` 在 HTTP 面断言。若要求 MCP 也带码 ⇒ 需另行批准的接口变更。已用 `contact_supervisor(progress_update)` 报备。
2. ADR-026 债务表 D6 行**未改**（按单子归主代理）。
3. `policy_validation` 旧断言 `interval=0 ⇒ is_ok()` 已按**契约**翻转（该断言编码的正是待修缺陷）——非「改测试迁就实现」。
4. GitNexus 索引存储版本不符（`impact` 报 `risk: UNKNOWN`），未执行 `analyze --force`；改用等价静态影响分析（`raw/53_entry_audit.txt`）逐处枚举调用点。

---

## 2026-09-19 16:36 CST — 部署到 8081/8082（本阶段无代码改动，仅部署 + 部署者自证）

- **部署证据包**：`coder/evidence/20260919_d6_redeploy/README.md` + `raw/`（20 个文件，含 sha256 清单于 `raw/15_final_state.txt`）
- **代码改动**：无（`git diff --stat` 起止一致；`git diff --cached --stat` 为空；未执行任何 git 写操作）
- **旧进程 → 新进程**：818710（11:17:10 启动，运行镜像 `895c516e…`，含 `(deleted)`）--SIGTERM,exit 0.1s--> 1210738（16:36:14 启动，镜像 `ead45c29…`，cwd=仓库根，持 8081+8082，PPID=1）
- **构建**：`npx tsc -b` exit 0；`npm run build` exit 0（dist 三件产物 sha256 与上一轮相同——D6 前端改动是测试文件，不进 bundle）；`cargo build --bin eestock-app` exit 0（重链 strategy-core + 5 下游，1.21s）
- **命令行自证新代码在跑**（同一判据体，唯一变量 = policy）：
  - `interval=0` → **400** `policy_invalid`「Dca.interval 必须 ≥ 1（省略即为默认 1）」（旧二进制 → 201）
  - 省略 `interval` → **201**（旧二进制 → 400 `missing field `interval``）
  - 显式 `interval=1` → 201（防过度拒绝回归）；`grep -a` D6 文案在 `/proc/1210738/exe` 命中 1、在旧镜像命中 0
- **冒烟**：healthz=200；启动 6 行 INFO，ERROR=0/WARN=0；线上 `index.html`+JS+CSS 与本次构建产物 sha256 逐一相等；`/api/config/kline` GET/PUT 合法+越界均符合预期（临时 PUT 130 已还原 120）；`/api/sim-live/sessions` 重启后 `non_ended=[]`
- **副作用**：新建 3 条 workbench run（见证据包 §5.5），均 `succeeded`；无 DB 测试、无临时库创建
- **自证 ≠ 验收**：独立 live 验收归 tester（`tester/evidence/20260919_d6_live_verify/`）
