# dcap 指标 —— T5a / T6 / T7 / T12 Red 执行报告（P2-A）

- 报告自身路径：`tester/test/041_dcap_p2a_t5a_t6_t7_t12_red_execution.md`
- 执行时间（UTC / CST）：2026-09-13 07:36–07:44Z / 15:36–15:44 CST
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
- 仓库提交（HEAD）：`8745fd52de446efc597e37dcd23cc74c27273dcd`
- 权威口径：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`
- 设计报告：`tester/design/013_dcap_p2a_t5a_t6_t7_t12_red_design.md`
- 原始输出（逐命令）：`tester/evidence/020_dcap_p2a_red/`
- 纪律声明：**未写实现**；**未修改实现代码**（仅改测试：见 §1 文件清单）；**未 `git add`/`commit`/`stash`**；
  未起 8081/8082；未对数据面做任何写操作；**未做失败分析、未尝试任何修复**（tester 职责边界）。

---

## 0. 结论速览

| # | 套件 | 命令 | 逐例结果 | 退出码 |
|---|---|---|---|---|
| 1 | T5a/T6 插件面 | `cargo test -p strategy-runtime --test dcap_plugin_init -- --nocapture` | **2 通过 / 3 失败** | 101 |
| 2 | T7 重放 | `cargo test -p strategy-runtime --test dcap_plugin_replay -- --nocapture` | **2 通过 / 1 失败** | 101 |
| 3 | T4 + T5a 跨运行时 | `cargo test -p strategy-runtime --test dcap_cross_runtime -- --nocapture` | **6 通过 / 0 失败** | 0 |
| 4 | T12（清单） | `cargo test -p strategy-core --no-fail-fast` | lib **31 通过 / 2 失败**；engine 25 绿（1 ignored）/ observer 6 绿 / templates 3 绿 | 101 |
| 5 | T12（播种） | `cargo test -p application --no-fail-fast` | lib 26 绿 / simlive 55 绿 / **strategy 38 通过 / 1 失败** / workbench 17 绿 | 101 |
| 6 | T5a/T6 前端 | `cd web && npx vitest run src/features/indicators/dcapNormalize.test.ts src/features/indicators/dcapInsufficient.test.ts` | **5 通过 / 4 失败**（2 文件 9 例） | 1 |
| 7 | 前端全量回归 | `cd web && npx vitest run` | **510 通过 / 4 失败**（52 文件 514 例；失败 = T5a 前端 4 例） | 1 |
| 8 | Rust 回归（受改动影响的两个 crate） | `cargo test -p strategy-runtime --no-fail-fast` / `-p strategy-core --no-fail-fast` / `-p application --no-fail-fast` | 除本批新增红灯外**全绿**（见 §3） | 101 |

- **新增/修改测试共 21 例：11 红 / 10 绿。** 红 = 待 P2 实现落地的口径；绿 = 该口径当前已成立（P1 CORE 已具备）。
- **崩溃 / core dump：无。** 全部失败均为断言失败（Rust `assertion left == right` / vitest `AssertionError`），
  无 SIGSEGV / SIGABRT / panic-in-drop；`find -maxdepth 3 -name 'core*'` = 0。
- ⚠️ **架构级问题已当场证伪并上报**（见 §2）：平台 `save()/load()` 通道（ABI G3）**不是位级保真**
  （`serde_json` 十进制浮点解析非正确舍入，实测差 **1 ulp**）。按派单要求：**已停止**把 T7 做成
  「本数据集可复现」的绿灯叙事，**未把任何断言放宽为容差**，原样上报。

---

## 1. 交付清单

### 新增测试文件

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `crates/strategy-runtime/tests/dcap_plugin_init.rs` | 5 | T5a（插件面 3）+ T6（插件面 2） |
| `crates/strategy-runtime/tests/dcap_plugin_replay.rs` | 3 | T7（重放 1 + 哨兵 1 + 通道探针 1） |
| `web/src/features/indicators/dcapNormalize.test.ts` | 5 | T5a（前端入口 5） |
| `web/src/features/indicators/dcapInsufficient.test.ts` | 4 | T6（前端逐线 4） |

### 修改测试文件

| 文件 | 变更 |
|---|---|
| `crates/strategy-runtime/tests/dcap_cross_runtime.rs` | **+1 例** `t5a_cross_runtime_nonmonotonic_params_bit_equal` + `nonmonotonic_samples()`；既有 5 例与 `t4_sample_set_meets_spec` 守卫**未动** |
| `crates/strategy-core/src/reference.rs` | `#[cfg(test)]` 内：`BUILTIN_ORDER` 7→8（追加 `dcap`）、`len 7→8`；**+1 例** `t12_dcap_registered_with_plugin_abi_and_core_sentinels` |
| `crates/application/tests/strategy.rs` | `seed_reference_plugins_seeds_11_and_is_idempotent` → `…_seeds_12_…`；`11→12`、`(7,4)→(8,4)` |

**未修改**：任何实现代码、任何产物（`dcap.ts` / `dcap.js`）、任何 `design/` 文档、`Cargo.toml/.lock`、`entangled.toml`。

> 计数改动依据（非放宽）：ADR-021 §8 裁决 A「dcap 进 `reference_plugins` 第 8 条」⇒
> 8 参考插件 + 4 模板 = **12**，strategy 类 7→8；模板数不变。

---

## 2. ⚠️ 架构级问题：平台状态通道非位级保真（T7 前置条件不成立）

**现场证据**（`tester/evidence/020_dcap_p2a_red/02_dcap_plugin_replay.txt`）：

```
[T7-channel] 平台状态通道（ABI G3：`save()/load()`）不具备位级保真 ⇒ 架构级问题
(a) serde_json 十进制解析非正确舍入（crates/strategy-runtime/src/quickjs.rs:272-277）：
  -0.011674411920738925: str::parse=bf87e8c10b3264c0  serde_json::from_str=bf87e8c10b3264bf  差 1 ulp
  57.329040578513684:    str::parse=404caa1e006de2f8  serde_json::from_str=404caa1e006de2f7  差 1 ulp
(b) 平台 `save()→load()` 现场可证伪（真实 QuickJsRuntime API，非模拟）：
  起始值=57.329040578513684(404caa1e006de2f8) → 经 save→load 后=57.32904057851368(404caa1e006de2f7)，差 1 ulp
      （快照={"v":57.32904057851368}）
(c) dcap 快照共 40 个浮点数，**本次数据集全部位级可往返**（未命中误舍入样本）
```

**机制**（事实陈述，非修复建议）：`save()` 走 QuickJS `JSON.stringify` → `serde_json::from_str::<Value>`
（`quickjs.rs:272-277`）；`load()` 走 `serde_json::to_string` → QuickJS `JSON.parse`（`quickjs.rs:289-292`）。
去程的十进制 **解析**非正确舍入 ⇒ 形态命中（最短十进制表示落在两可舍入区间边界）的 f64 会静默丢 1 ulp。

**影响面**：dcap 的三条 ROI **SMA 尾窗**（`tailS/tailM/tailL`）= 全精度 ROI 值 ⇒ 属高风险载荷；
close 滚动窗口（3–4 位小数）低风险。

**当前实测分布（重要，不得含糊）**：

| 判据 | 结果 |
|---|---|
| `t7_replay_continuation_scores_bit_equal`（synth64 & real518880_m15_64 × split 20/60） | **绿（0 处差异）** —— 上述数据集**未**触发丢 1 ulp |
| `t7_selftest_missing_save_field_is_detected`（删 `winS` / 删 `tailS`） | **绿** —— 判据确有鉴别力（两处均被抓到） |
| `t7_channel_probe_channel_is_not_bit_exact` | **红** —— 通道能力被证伪 |

⇒ 结论应表述为：**dcap 的 T7 位级保真在本次数据集上未被证伪，但通道本身不具备位级保真能力（潜在缺陷已被平台级最小复现钉死）**。
按 `03-test-plan.md` T7 的明文要求，这属「序列化确实丢 1 ulp」情形 ⇒ **上报为架构级问题**，
候选修法（位串/整型编码）由架构师裁决；tester **未**放宽任何断言、**未**改动实现。

---

## 3. 失败用例表（全部为本批新增/修改的测试）

| # | 用例 | 文件 | 错误信息（摘要） | 钉死的口径 | 崩溃/core |
|---|---|---|---|---|---|
| 1 | `t5a_plugin_effective_windows_follow_normalization` | `crates/strategy-runtime/tests/dcap_plugin_init.rs:320` | `assertion left == right failed: [T5a-1] n_s=n_m=n_l=26：raw=(26,26,26) 经 init 后三线窗口容量必须为归一值 (26,27,28)  left: (26, 26, 26) right: (26, 27, 28)` | 02-spec §2/§3：`n_m'=max(n_m,n_s+1)`、`n_l'=max(n_l,n_m'+1)` | 无 |
| 2 | `t5a_plugin_normalization_is_idempotent_and_bitwise_deterministic` | 同上 `:368` | `[T5a-2] 已归一三元组再 init 必须得到同一生效值（raw=(26,26,26) vs 归一后输入=(26,27,28)） left: (26,27,28) right: (26,26,26)` | 幂等 f(f(x))=f(x) + 确定（逐位） | 无 |
| 3 | `t5a_plugin_windows_do_not_drift_across_bars` | 同上 `:412` | `[T5a-4] 归一后生效值应为 (8,9,10)  left: (8,8,8) right: (8,9,10)` | 归一化只在 `init` 一次（`on_bar` 不得反复归一） | 无 |
| 4 | `T5a-a 非单调三元组 ≡ 归一后三元组（逐位，smooth=1，r≠1）` | `web/src/features/indicators/dcapNormalize.test.ts:59/102` | `bar 4 字段 m 位串不同（actual=3f919ea6dbf41d35 expected=非数值(null)）` | 02-spec §4 铁律 5：前端入口归一 | 无 |
| 5 | `T5a-b 归一后的生效位置 = 各自的 (n_i + m − 1)` | 同上 `:111` | `T5a-b m 线首值下标（4+2−2=4，未归一则为 3）: expected 3 to be 4` | 归一后生效位置可核验（排除「都没归一」假绿） | 无 |
| 6 | `T5a-c 幂等：已归一三元组再进入口 ⇒ 输出不变` | 同上 `:130` | `bar 8 字段 m 位串不同（actual=3fafa29ab6115368 expected=非数值(null)）` | 幂等 | 无 |
| 7 | `T5a-e smooth=0 时同样按归一后窗口生效` | 同上 `:147` | `bar 3 字段 m 位串不同（actual=bfb00274e2aa58c8 expected=非数值(null)）` | 归一化与 `smooth` 正交 | 无 |
| 8 | `t7_channel_probe_channel_is_not_bit_exact` | `crates/strategy-runtime/tests/dcap_plugin_replay.rs:420` | 见 §2（(a)(b) 双证据；1 ulp） | 平台通道位级保真（T7 前置）⇒ **架构级** | 无 |
| 9 | `reference::tests::reference_plugins_match_builtin_order` | `crates/strategy-core/src/reference.rs:118` | `assertion left == right failed  left: 7  right: 8` | T12：`reference_plugins()` 长度 8 | 无 |
| 10 | `reference::tests::t12_dcap_registered_with_plugin_abi_and_core_sentinels` | 同上 `:143` | `reference_plugins() 必须含 id="dcap"（ADR-021 §8 裁决 A）` | T12：第 8 条 + ABI 钩子 + 镜像哨兵 | 无 |
| 11 | `seed_reference_plugins_seeds_12_and_is_idempotent` | `crates/application/tests/strategy.rs:743` | `assertion left == right failed: 8 参考插件 + 4 官方模板  left: 11  right: 12` | T12：播种计数 11→12 | 无 |

### 本批为绿的用例（10 例，必须与上面的红区分开）

| 用例 | 说明 |
|---|---|
| `t6_plugin_all_lines_insufficient_returns_exactly_50_and_no_log_noise` | T6：三线全不足 → 恰好 50 且无 `ctx.log`（P1 已成立） |
| `t6_plugin_insufficient_lines_are_excluded_from_n` | T6：不足的线不入 N（= N=1 口径且 ≠ N=3 口径） |
| `t7_replay_continuation_scores_bit_equal` | T7 主判据：本次数据集未触发丢 1 ulp（见 §2 分布） |
| `t7_selftest_missing_save_field_is_detected` | T7 判据鉴别力自检（删 `winS` / `tailS` 均被抓到） |
| `t5a_cross_runtime_nonmonotonic_params_bit_equal` | 非单调参数下两侧**当前**一致（两侧都未归一）⇒ 一致性护栏，非 Red 驱动 |
| `T5a-d 确定：同输入重复调用逐位相同` | 前端纯函数确定性（P1 已成立） |
| `T6-a` / `T6-b` / `T6-c` / `T6-d`（前端逐线 4 例） | T6：逐线首值位置 = 各自的 `n_i+m−1`；（P1 CORE 已成立） |

---

## 4. 回归（是否误伤既有测试）

| 套件 | 结果 |
|---|---|
| `cargo test -p strategy-runtime --no-fail-fast` | unit **14 绿** / `contract.rs` **13 绿** / `dcap_cross_runtime` **6 绿** / `dcap_plugin_init` 2 绿 3 红 / `dcap_plugin_replay` 2 绿 1 红 |
| `cargo test -p strategy-core --no-fail-fast` | lib **31 绿 / 2 红（本批 T12）**；`engine` 25 绿（1 ignored）/ `observer` 6 绿 / `templates` 3 绿 |
| `cargo test -p application --no-fail-fast` | lib 26 绿 / `simlive` 55 绿 / `strategy` **38 绿 / 1 红（本批 T12）** / `workbench` 17 绿 |
| `cd web && npx vitest run` | 52 文件 **514 例：510 绿 / 4 红（全部为 T5a 前端）**（口径：P1 时 50 文件 505 例全绿 ⇒ 本批 +2 文件 +9 例，无新增误伤） |

⇒ 除本批**有意**新增的红外，无任何既有测试被改变结果；无既有断言被削弱。

---

## 5. 覆盖与门禁

- `./scripts/check-tangle.sh`：本批**未运行**（未改文档块/产物 ⇒ 无漂移面；P1-C 已验绿）。
- 覆盖率工具：本仓未接入覆盖率统计（沿用既有口径，不新增工具）。
- 无 `#[ignore]` / 无 `skip`：本批 21 例全部默认执行。

## 6. 给下游（P2 实现）的口径移交要点

1. `init` 内做**顺序归一**：`n_m ← max(n_m, n_s+1)` → `n_l ← max(n_l, n_m+1)`，并把生效值用于
   ① 窗口容量 ② ROI 的 `n` ③ 平滑判定（否则 T5a-1/-2/-4 不会全绿）；归一化**只在 `init` 一次**。
2. 归一化必须写进 **CORE 区间**（§4 铁律 5），前端 `computeDcapSeries` 入口同口径调用；
   同时需更新 `02-spec.md` §10 的代码块并重跑 `entangled tangle`（否则 T3 镜像 / T4 会飘）。
3. `reference.rs` 加第 8 条 + `include_str!("../reference-plugins/dcap.js")`；两处计数按 8/12 落地。
4. T7：**不得**用容差绕过 §2 的通道问题；若架构裁决未改编码，`t7_channel_probe_*` 将保持红
   （它是架构级证据，不是实现缺陷）。
