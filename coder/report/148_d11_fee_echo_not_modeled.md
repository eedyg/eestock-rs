# 148 — D11 修复：响应 fee 回显显式区分 `effective` / `profile.not_modeled`（消除误导性回显）

> 本文档自身路径：`eestock-rs/coder/report/148_d11_fee_echo_not_modeled.md`
> （绝对路径 `/home/eestock/workspace/git/eestock/eestock-rs/coder/report/148_d11_fee_echo_not_modeled.md`）
> 任务：修复 D11 独立验收（`tester/report/013_d11_acceptance.md` §11.3）发现的**误导性回显**——架构师裁定为
> **必修（非 follow-up）**，并指定修复方案（照此实现）。
> 纪律：**不 git add/stage**（0 staged）；**不重启生产服务**；DB **只读**（除既有测试事务）；未提交临时夹具同步更新。

---

## 1. 问题（验收发现）

试算 / 回测响应里 `fee.profile` **同时回显** `exchange_fee_pct` / `regulatory_fee_pct` / `transfer_fee_pct`
（stock 档案为 `0.00341 / 0.002 / 0.001`），但引擎 **并未应用**这三项——`backtest::FeeModel` 只有
`commission_rate_pct / min_commission / stamp_duty_pct / slippage_bp` 4 字段。字段无「已建模/未建模」标记，
调用方可能误读为「已计入成本」。属本项目反复出现的**静默失真 / 误导信息**类缺陷（同 I-1 静默空返回、门禁假绿）。

## 2. 修复方案（架构师指定，逐条落地）

响应结构改为**显式区分两段**：

```json
"fee": {
  "effective": { "commission_rate_pct": 0.025, "min_fee": 5.0,
                 "stamp_duty_pct": 0.0, "slippage_bp": 2.0, "source": "profile" },
  "symbol_type": "etf",
  "profile": { "type": "etf", "commission_rate_pct": 0.025, "min_fee": 5.0,
               "exchange_fee_pct": 0.0, "regulatory_fee_pct": 0.0,
               "stamp_duty_pct": 0.0, "transfer_fee_pct": 0.0,
               "note": "…", "source": "…",
               "not_modeled": ["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"] }
}
```

- `effective`：**引擎实际应用**的参数（`commission_rate_pct`/`min_fee`/`stamp_duty_pct`/`slippage_bp`）
  + `source`（`explicit|profile|default`）。**任何未参与撮合的字段不出现在此段**。
- `profile`：解析到的档案**全量事实** + `not_modeled` **显式清单**（始终列出，schema 稳定 —— 架构师
  「二者择一但须一致且文档写明」授权的选择：**始终列出**）。
- `symbol_type`：保留在 `fee` 顶层（架构师未要求移动；非破坏性保留解析元信息）。

### 2.1 `not_modeled` 与实现严格对应（单一来源，非硬编码）

不给 `not_modeled` 硬编码字符串清单；改由**回显的档案字段集派生**：

- `PROFILE_CONSUMED_FIELDS = ["commission_rate_pct", "min_fee", "stamp_duty_pct"]`（单一事实源，
  与 `fee_model_from_profile` 的消费严格一致 —— 测试锁定）；
- `PROFILE_META_FIELDS = ["type", "note", "source"]`（非费率元数据，派生时排除）；
- `not_modeled_fields(profile_obj)` = `profile` 数值费率键 − 消费字段（升序）。

新增/删除档案字段会自动体现，**清单与实现不脱节**；再由测试锁定 `not_modeled` 恰为
`["exchange_fee_pct","regulatory_fee_pct","transfer_fee_pct"]`，且与 `FeeModel` 的 serde 字段集**互斥**。

### 2.2 关键决策（可追溯，非自创）

| # | 决策 | 依据 |
|---|---|---|
| A | `effective` 键名用 `commission_rate_pct`（而非旧回显名 `rate_pct`） | 架构师方案原文列出的键名；与档案字段命名对齐 |
| B | `not_modeled` **始终**列出（有档案即带） | 架构师授权「二者择一」；选「始终」以获得稳定 schema，已在文档写明 |
| C | `symbol_type` 保留在 `fee` 顶层 | 架构师只指定 effective/profile 两段；保留解析元信息不属自创 |
| D | 入参/预设钉住形态 `{rate_pct,min_fee,slippage_bp,stamp_duty_pct}` **不动** | 预设 config 会被前端回填后再次提交，必须保持 `to_fee_model` 可解析 |

> ⚠️ 影响面提示（决策 A）：响应顶层不再有 `rate_pct`（已入 `effective.commission_rate_pct`）——
> **MCP/REST 响应的破坏性 schema 变更**。前端**不消费** run-config.fee（仅配置面板消费**预设**的
> 入参形态 fee，见决策 D），故前端无运行时破坏；相关 TS 类型见 §7 残留风险。

## 3. 变更清单（changed files）

| 类别 | 文件 | 变更 |
|---|---|---|
| 实现（手写，非 tangle） | `crates/application/src/fee.rs` | `resolved_fee_to_json` 重构为两段；新增 `PROFILE_CONSUMED_FIELDS` / `PROFILE_META_FIELDS` / `not_modeled_fields`；`fee_model_to_json` 注释澄清为入参/预设形态；单测 1 更新 + 4 新增 |
| 实现（tangle 生成物） | `crates/mcp/src/tools.rs` | 由 `design/07-app-plane/01-mcp.md` 块经 `entangled tangle` 重新生成（工具 schema 描述 + 测试断言） |
| 集成测试 | `crates/application/tests/strategy.rs` | 6 断言迁至 `effective`，新增 `profile.not_modeled` 断言 |
| 集成测试 | `crates/application/tests/workbench.rs` | 4 断言迁至 `effective`，新增 `profile.not_modeled` 断言 |
| 集成测试（真实库） | `crates/mcp/tests/d11_fee_profile_e2e.rs` | 断言迁至 `effective`；新增 `not_modeled` 清单 + 「未建模字段不入 effective」断言 |
| 临时夹具（未提交） | `crates/mcp/tests/zz_tester_010_acceptance.rs` | 缺省 fee 断言改为**按 `effective.source` 分支**（`default→0.05` / `profile→0.0`），显式分支恒 0；标注未装配 fee_profiles 前提 |
| 事实源文档 | `design/07-app-plane/01-mcp.md` | 工具 schema 描述改为两段口径；测试块断言同步（→ tangle 生成 tools.rs） |
| 事实源文档 | `design/07-app-plane/00-web-api.md` | `POST /api/workbench/runs` 201 `config.fee` 两段 schema 说明 |
| 事实源文档 | `design/08-backtest/01-engine-adr.md` | §4 D11 段「响应回显」改为两段 + `not_modeled` |
| 事实源文档 | `design/12-strategy-system/01-adr.md` | 试算参数组响应回显说明改为两段 |
| ADR | `design/01-architecture/adr/ADR-019-symbol-type-fee-profiles.md` | D11-3 措辞补两段 + `not_modeled`（013 §11.3 修正） |

**架构对齐**：解析/回显的**唯一实现点**仍在 application 层 `fee.rs`（ADR-019 D11-3「单点完成」不破）；
MCP/web 仅透传 `resolved_fee_to_json`（分层红线不破）；未改 `backtest::FeeModel` / `domain::FeeProfileRow`
等核心接口；未引入新依赖。

## 4. TDD 证据（Red → Green）

**Red（旧实现 + 新断言）**：`cargo test -p application --lib fee::` → **4 failed / 12 passed**
（`resolved_json_exposes_effective_and_profile_segments` 等 4 例因 `effective` 段缺失而红）。

**Green（新实现）**：同命令 → **16 passed / 0 failed**：

```
test fee::tests::resolved_json_exposes_effective_and_profile_segments ... ok
test fee::tests::effective_excludes_unmodeled_profile_fields ... ok
test fee::tests::not_modeled_matches_profile_numeric_fields_minus_consumed ... ok
test fee::tests::effective_strictly_matches_fee_model_fields_and_is_disjoint_from_not_modeled ... ok
test fee::tests::consumed_profile_fields_are_exactly_what_engine_applies ... ok
test result: ok. 16 passed; 0 failed
```

新增/更新断言覆盖：**explicit / profile / default 三态** + `not_modeled` 清单锁定 + `effective` 段不含未建模字段
+ `effective` 字段集与 `FeeModel` serde 字段集严格对应（`min_commission`↔`min_fee` 别名）。

## 5. 验证结果（commands-run）

| 验证 | 命令 | 结果 |
|---|---|---|
| 单测（fee 模块） | `cargo test -p application --lib fee::` | ✅ 16 passed / 0 failed |
| application 集成 | `cargo test -p application` | ✅ 21 + 55 + 39 + 17 passed / 0 failed |
| MCP 单测（tools.rs） | `cargo test -p mcp --lib` | ✅ 65 passed / 0 failed |
| MCP 真实库 e2e（只读） | `cargo test -p mcp --test d11_fee_profile_e2e -- --nocapture` | ✅ 1 passed；输出含 `"not_modeled":["exchange_fee_pct","regulatory_fee_pct","transfer_fee_pct"]`，`effective.source=profile` |
| web 集成 | `cargo test -p web` | ✅ 全部通过 |
| 临时夹具编译 | `cargo test -p mcp --test zz_tester_010_acceptance --no-run` | ✅ 编译通过（**未执行**：该夹具会写 `strategy_runs`，遵「DB 只读」故仅编译校验） |
| **全量测试** | `cargo test --workspace -- --skip zz_tester` | ✅ **642 passed / 0 failed**（2 个 tester 夹具用例按名跳过：`--skip zz_tester`，其余全跑） |
| clippy | `cargo clippy --workspace --all-targets` | ✅ 仅 **2 条既有告警**（`strategy.rs` clone_on_copy / tester borrowed expr），本批新增 0 |
| **tangle 门禁** | `./scripts/check-tangle.sh` | ✅ 沙箱重新生成 + 逐字节比对通过（工作区未被修改） |
| staged 检查 | `git diff --cached --name-only \| wc -l` | ✅ **0** |

## 6. 端到端实测留痕（真实库 510050，只读）

```
[D11 实测] symbol=510050 bars=129 trades=1 | profile: fee={
  "effective":{"commission_rate_pct":0.025,"min_fee":5.0,"slippage_bp":2.0,"source":"profile","stamp_duty_pct":0.0},
  "profile":{"commission_rate_pct":0.025,"exchange_fee_pct":0.0,"min_fee":5.0,
             "not_modeled":["exchange_fee_pct","regulatory_fee_pct","transfer_fee_pct"],
             "regulatory_fee_pct":0.0,"stamp_duty_pct":0.0,"transfer_fee_pct":0.0,"type":"etf", …},
  "symbol_type":"etf"} stamp_sum=0 pnl=-551.5901
| explicit: stamp_sum=49.73663912787073 pnl=-601.3267 | Δpnl=49.7366
```

stock 档案（三项规费非零）在单测 `effective_excludes_unmodeled_profile_fields` 中验证：
`effective` 段**不含** `exchange_fee_pct/regulatory_fee_pct/transfer_fee_pct`，`profile.not_modeled` 恰列三项。

## 7. 残留风险 / 待办（非阻塞）

1. **前端 TS 类型保真**：`web/src/api/types.ts` 的 `WorkbenchRunConfig.fee` 仍为扁平的 `WorkbenchFee`，
   而真实后端 run config 已改两段。前端**运行时**不消费 run-config.fee（只消费预设的入参形态 fee），
   故不改；建议后续拆类型（run = 两段 / preset = 入参）以免 mock 与真后端失真。**未改属守 scope**。
2. **破坏性 schema 变更**：`fee.rate_pct` → `fee.effective.commission_rate_pct`（决策 A），外部 MCP 调用方需适配。
3. **临时夹具未实跑**：`zz_tester_010_acceptance.rs` 仅编译校验（避免测试写生产库）；夹具现已对
   `default`/`profile` 两种装配表达正确意图。

## 8. 门禁结论

`./scripts/check-tangle.sh` ✅；`cargo test --workspace -- --skip zz_tester` **642 passed / 0 failed**；
`cargo clippy --workspace --all-targets` 仅 2 条既有告警；**0 staged**。
