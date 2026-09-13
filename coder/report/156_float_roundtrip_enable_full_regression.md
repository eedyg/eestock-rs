# 156 — 启用 serde_json `float_roundtrip`（全平台正确舍入）+ 全量回归

- 日期：2026-09-13
- 任务：步骤 1 — 开 `float_roundtrip` + 全量回归
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
- 本报告自身路径：`coder/report/156_float_roundtrip_enable_full_regression.md`
- 依据：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`；
  架构师定稿修法 = **选项 ①**：workspace 级启用 serde_json `float_roundtrip`。
- 末行判定：**VERDICT: GREEN**

---

## 1. 改动范围（What changed）

单一处改动，符合"只改这一处"硬约束：

```diff
--- a/Cargo.toml        (workspace 根，手写例外，ADR-007：本文件不 tangle)
+++ b/Cargo.toml
@@ -27,7 +27,7 @@ sqlx = { version = "0.8", default-features = false, features = [
     "json",
 ] }
 serde = { version = "1", features = ["derive"] }
-serde_json = "1"
+serde_json = { version = "1", features = ["float_roundtrip"] }
 chrono = { version = "0.4", features = ["serde"] }
 async-trait = "0.1"
```

- 文件：`Cargo.toml`（workspace 根），**1 增 1 删**（`git diff --stat` 显示 2 +-）。
- **未改任何 crate 的 Cargo.toml**（`git status --porcelain` 中仅 `Cargo.toml` 为 M；另两个 M 文件 `crates/application/tests/strategy.rs`、`crates/strategy-core/src/reference.rs` 是本轮开工前既有的 P2 未提交改动，非本次产生）。
- 未新建/修改任何测试文件（tester 的 `dcapNormalize.test.ts`、`dcap_plugin_replay.rs` 等一律未动）。
- 未改插件 / 引擎 / CORE / 产物；**未重新 tangle**（本轮无需：改的是 workspace 依赖 feature，不涉及 `design/**` 源或生成物）。

## 2. Lock 影响（Lock impact）

- **`Cargo.lock` 无变化**（理由：`float_roundtrip` 是 serde_json 的编译期 feature，不改变依赖图/版本/被依赖项集合；Cargo.lock 不记录 feature 选择）。
  - 显式证据：改动前后 `diff /tmp/Cargo.lock.before Cargo.lock` → 空（逐字节一致）；
    `sha256(Cargo.lock)` 改前 = `a4fec9c944e431be3c1734fe92d529095089bc3a116640e0e4c503a4d12d8790`，改后一致。
  - `git diff Cargo.lock` → 空。
- `cargo tree -i serde_json` 留证：`serde_json v1.0.151`，被 `application / domain / axum / strategy-runtime / mcp / web` 等全树依赖（单一版本，无重复）。
- feature 生效留证：`cargo tree -f "{p} features: {f}" -i serde_json` → **`serde_json v1.0.151 features: default,float_roundtrip,raw_value,std`**。

## 3. 两路验证（Two-route verification，缺一不可）

### (a) 独立解析探针（正确舍入位串证据）

独立 example 探针（临时文件 `crates/strategy-runtime/examples/zz_float_probe_tmp.rs`，取证后已删除，不入库、不留痕），
对 `serde_json::from_str::<f64>` 与 Rust 标准库 `str::parse::<f64>`（正确舍入参照）逐位比对：

| 输入 | `str::parse`（正确舍入） | `serde_json::from_str`（启用后） | bit_equal | ulp |
|---|---|---|---|---|
| `57.329040578513684` | `404caa1e006de2f8` | `404caa1e006de2f8` | **true** | 0 |
| `-0.011674411920738925` | `bf87e8c10b3264c0` | `bf87e8c10b3264c0` | **true** | 0 |
| `-0.0045787545787545625` | `bf72c12c12c12c00` | `bf72c12c12c12c00` | **true** | 0 |
| `0.0045787545787547845` | `3f72c12c12c12d00` | `3f72c12c12c12d00` | **true** | 0 |

改动前（Red 基线，同探针在同仓跑出的实测）：`57.329040578513684` → serde_json `404caa1e006de2f7`（差 1 ulp）、
`-0.011674411920738925` → `bf87e8c10b3264bf`（差 1 ulp）。启用后全部归零。

序列化往返（平台通道 save→load 的底层动作）同样全部 `bit_equal=true`（4/4）。

### (b) 真实 QuickJsRuntime 重放（`t7_channel_probe_channel_is_not_bit_exact`）

命令：`cargo test -p strategy-runtime --test dcap_plugin_replay -- --nocapture`

- 改动前（Red）：`1 failed; 2 passed` —— `(a)` 两个样本各丢 1 ulp，`(b)` save→load 现场 `57.329040578513684 → 57.32904057851368`（差 1 ulp）⇒ 断言触发 FAIL（符合 P2-B 上报）。
- 改动后（Green）：**`test result: ok. 3 passed; 0 failed`**
  - `t7_channel_probe_channel_is_not_bit_exact ... ok` ✅（本任务目标用例）
  - `t7_selftest_missing_save_field_is_detected ... ok` ✅（T7 鉴别力自检，仍真红过；未削弱）
  - `t7_replay_continuation_scores_bit_equal ... ok` ✅（位级一致断言保持 `==`）

## 4. 全量回归（Full regression，平台级行为变更必跑）

### Rust：`cargo test --workspace`

- 退出码 **0**。
- **总计：662 passed / 0 failed / 1 ignored**（跨 77 个 test binary + doctests）——测试结果行聚合 `awk '{p+=$4;f+=$6;i+=$8}'`。
- **失败用例清单：无（0）**，故无"期望值过期"或"真实功能回归"需归因。
- 唯一 ignored = `strategy-core` 的 `perf_smoke_1260_bars_3_plugins`，其 ignore 理由为 **既有设计**（`性能冒烟：手动运行 cargo test -p strategy-core -- --ignored`），**非本轮新增**，未削弱。
- dcap 相关子套件逐项绿：
  - `tests/dcap_cross_runtime.rs` → 6 passed / 0 failed
  - `tests/dcap_plugin_init.rs` → 5 passed / 0 failed
  - `tests/dcap_plugin_replay.rs` → 3 passed / 0 failed
  - `strategy-core reference::tests::t12_dcap_registered_with_plugin_abi_and_core_sentinels` → ok
- 关键回归相关用例保持绿（浮点正确舍入是收紧而非放松，故不产生期望值漂移）：
  `t5a_cross_runtime_nonmonotonic_params_bit_equal`、`t5a_plugin_*`、`t6_plugin_*`、`e2e_deterministic_double_run_pointwise_equal` 均 ok。

### Web：`cd web && npx vitest run`

- 退出码 **0**。
- **`Test Files 52 passed (52)`；`Tests 514 passed (514)`**，0 failed。
- 含 dcap 套件：`dcapNormalize.test.ts`（5）、`dcap.test.ts`（10）、`dcapInsufficient.test.ts`（4）、`dcapMirror.test.ts`（11）全绿。
  （注：`dcapNormalize.test.ts` 的 TS 类型错属 `tsc` 层面，本步按约定不修，留待 tester 下一步。）

## 5. 未削弱任何断言的说明（No assertion weakening）

- 本轮**唯一代码改动 = workspace `Cargo.toml` 一行**；`.rs`/`.ts`/`.tsx` 测试文件与生产逻辑文件**零改动**（`git diff --stat` 中除既有 P2 未提交文件外，仅 `Cargo.toml`）。
- 未使用 `>=` 替 `==`、未用 `contains` 替 `==`、未加 `#[ignore]`/skip、未把位级断言改成容差。
- 反向证据：`t7_channel_probe` 由 **FAIL → ok** 是**被修复**，而不是被放松；`t7_selftest_missing_save_field_is_detected`（故意漏 `save` 字段必须报红）在修复后**仍 ok**，证明 T7 判据鉴别力未被削弱。
- 未改动 `clamp_score` / `aggregate` / `classify` / 60-40 阈值 / `ExecutionPolicy` / `/api/config/*`；未起 8081/8082；未 git add/commit/stash（`git diff --cached` 为空）。

## 6. 架构对齐（Architecture alignment）

- 改动位于 **workspace 根依赖声明**：符合项目"统一依赖版本集中在 `[workspace.dependencies]`，各 crate 一律 `<dep>.workspace = true`"的既有约定；各消费 crate 无需改动即继承 feature（Cargo feature 统一为并集）。
- 属**平台层行为变更**（浮点解析），非 ABI/引擎/CORE 层；不触碰任何层边界与事件契约。

## 7. 残余风险 / 后续

- `float_roundtrip` 是全平台浮点解析口径变更：本仓全量回归（Rust 662 + Web 514）已覆盖，未观察到期望值漂移。若未来引入对 serde_json 解析"旧缺陷行为"有硬编码期望的外部夹具，需按"旧值按缺陷行为写"原则更新期望值，不得放松形式。
- 本轮**未**重新 tangle（不需要）；P2 剩余 tester 侧 TS 类型修复不在本轮范围。

---

**VERDICT: GREEN**
