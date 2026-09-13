# dcap 指标 —— P2-C 独立验收（含本轮 feature 变更复核）执行报告

- **报告自身路径**：`tester/test/043_dcap_p2c_independent_acceptance_execution.md`
- **执行时间（CST）**：2026-09-13 17:31 ~ 17:36
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`（全部命令在此目录执行）
- **仓库提交（HEAD）**：`8745fd52de446efc597e37dcd23cc74c27273dcd`
- **权威口径**：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`
- **原始证据目录**：`tester/evidence/021_dcap_p2c/`
- **纪律声明**：本轮为**验收**（P2-C 补跑 + feature 复核）；
  **未修改任何实现 / 测试断言 / CORE / 产物 / ABI / 引擎**；反向取证所用的临时变异**全部已按原 sha256 还原**；
  临时探针（`examples/zz_p2c_*.rs`、`zz_p2c_probe.test.ts`）**用完即删**；
  **未 `git add`/`commit`/`stash`**（`git diff --cached` 为空）；未起 8081/8082。
  **未以任何形式放宽/削弱断言**；**未做失败分析、未尝试任何修复**。

---

## 0. 结论速览

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | T5a / T6 / T7 / T12 全绿；T7 位级 | ✅ | §1 |
| 2 | 反向证据（T7 破坏保存→红→还原复绿；T12 移除 dcap→红→还原复绿） | ✅ | §2 / `05_*`、`06_*` |
| 3 | feature 变更复核（Cargo.toml 单处、Cargo.lock 空、两浮点独立复现、无断言改弱） | ✅ | §3 / `02_*`、`07_*` |
| 4 | 归一化跨端一致（非单调 60/26/8）＋幂等/确定 | ✅ | §4 / `08_*`、`09_*` |
| 5 | 镜像体逐字节 + check-tangle exit=0 + 既有 144 生成物未变 | ✅ | §5 / `03_*`、`04_*`、`10_*` |
| 6 | 工作树收敛（未动 ABI/引擎/agg/Policy/api-config；cached 空） | ✅ | §6 / `11_*` |
| 7 | 回归：Rust 662/0/1；Web 514/0；tsc exit=0 | ✅（1 次 vitest 瞬态退出码，见 §7.3） | §7 / `12_*`~`15_*` |

**末行判定**：`VERDICT: PASS`（详见文末）。

---

## 1. 项 1 —— T5a / T6 / T7 / T12 全绿；T7 位级形式确认

### 1.1 命令与结果

| 套件 | 命令 | 结果 |
|---|---|---|
| T5a 插件面 + T6 | `cargo test -p strategy-runtime --test dcap_plugin_init` | `5 passed; 0 failed; 0 ignored` |
| T7 | `cargo test -p strategy-runtime --test dcap_plugin_replay -- --nocapture` | `3 passed; 0 failed; 0 ignored` |
| T4 + T5a 跨运行时 + T2 | `cargo test -p strategy-runtime --test dcap_cross_runtime` | `6 passed; 0 failed; 0 ignored` |
| T12（清单） | `cargo test -p strategy-core --lib reference::` | `3 passed; 0 failed` |
| T12（播种） | `cargo test -p application --test strategy seed_reference_plugins` | `1 passed; 0 failed` |

T7 三例逐字：

```
test t7_channel_probe_channel_is_not_bit_exact ... ok
test t7_selftest_missing_save_field_is_detected ... ok
test t7_replay_continuation_scores_bit_equal ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### 1.2 T7 断言形式 = 位级（自行读码确认）

- `crates/strategy-runtime/tests/dcap_plugin_replay.rs`：
  - 主判据 `diff_scores`（L166）：`if x.to_bits() != y.to_bits()` —— **IEEE754 位串**比较；
  - 探针 (a)（L340）：`correct.to_bits() != via_serde.to_bits()`；
  - 探针 (b)（L379）：`before.to_bits() != after.to_bits()`；
  - 探针 (c)（L398）：`back.to_bits() != v.to_bits()`；
  - `.abs()`（L347/L384）仅出现在**诊断信息**里计算 ulp 数，**不参与断言**。
- **无任何容差、无 `#[ignore]`、无 `skip`**（全库 dcap 测试文件 grep 均为 0 命中，见 §7.4）。
- 运行时 `save()/load()` 序列化路径（`crates/strategy-runtime/src/quickjs.rs:255-300`）：
  `save()` → `ctx.json_stringify` → `serde_json::from_str::<Value>`（**解析**）；
  `load()` → `serde_json::to_string(state)` → `ctx.json_parse`。断言即钉住该往返的**位级保真**。

⇒ T7 为位级，非容差；**未被放宽**。

---

## 2. 项 2 —— 反向证据（防空跑）

### 2.1 T7：临时破坏状态保存/恢复

- 变异：将产物 `crates/strategy-core/reference-plugins/dcap.js` 的 `save()` 中 `tailS: tailS.slice(), ` **删除**（模拟「漏存 SMA 尾窗」）。
- 命令：`cargo test -p strategy-runtime --test dcap_plugin_replay t7_replay_continuation_scores_bit_equal`
- 结果：**红**，`MUTATED_EXIT=101`，失败信息（节选）：

```
[T7-e2e] real518880_m15_64 split=20：save→load→续跑与连续跑必须**逐位**相同（ABI G3 …）
快照键=Some(["tailL", "tailM", "winL", "winM", "winS"])
不一致 2 处：
bar 20：连续跑=51.48284719528435(4049bdcdefd85b16) 恢复续跑=51.86242356827663(4049ee63e53e861d)
bar 21：连续跑=52.42961869957857(404a36fdbedc3852) 恢复续跑=52.93950396119883(404a7841aa71e7dd)
test result: FAILED. 0 passed; 1 failed; …
```

- 还原：`cp` 回备份 → `sha256sum -c` **OK**（`60bc9b49e385…bcb8e3c2`）→ 复跑三例 **全绿**（`RESTORED_EXIT=0`）。
- 证据：`tester/evidence/021_dcap_p2c/05_t7_reverse_evidence.txt`。

### 2.2 T12：临时移除 `reference.rs` 的 dcap

- 变异：删除 `crates/strategy-core/src/reference.rs` 中 `reference_plugins()` 的 `id: "dcap"` 条目。
- 命令：`cargo test -p strategy-core --lib reference::`
- 结果：**红**，`MUTATED_EXIT=101`：

```
reference::tests::t12_dcap_registered_with_plugin_abi_and_core_sentinels ... FAILED
reference::tests::reference_plugins_match_builtin_order ... FAILED
  （reference_plugins_match_builtin_order: left: 7  right: 8）
test result: FAILED. 1 passed; 2 failed; …
```

- 还原：`sha256sum -c` **OK**（`85525c066b35…b7dc9bb`）→ 复跑 **全绿**（`RESTORED_EXIT=0`）。
- 证据：`tester/evidence/021_dcap_p2c/06_t12_reverse_evidence.txt`。

⇒ 两条反向证据均成立（先红后绿），判据有鉴别力，非空跑。

---

## 3. 项 3 —— feature 变更复核（`serde_json` `float_roundtrip`）

### 3.1 `Cargo.toml` 只改一处且是 `float_roundtrip`

```diff
diff --git a/Cargo.toml b/Cargo.toml
-serde_json = "1"
+serde_json = { version = "1", features = ["float_roundtrip"] }
```

- `git diff Cargo.toml | grep -c '^@@'` = **1**（单 hunk）；非上下文行**仅 1 增 1 删**。
- `git status --porcelain | grep -i cargo` = 仅 `M Cargo.toml`（**无任何 crate 级 Cargo.toml 被改**）。
- 证据：`02_feature_change_review.txt`。

### 3.2 `git diff Cargo.lock` = 空；解释

- `git diff Cargo.lock` → **空**；`grep -n float_roundtrip Cargo.lock` → **无**；`serde_json` 在锁文件内仍为 `1.0.151`（`c841b55e…`）。
- **解释**：`float_roundtrip` 是 serde_json 的**编译期 feature**，不改变依赖图/版本/被依赖集合；`Cargo.lock` 不记录 feature 选择。⇒ 锁文件无变化是**正确**的，非漏更。
- feature 生效留证：`cargo tree -f "{p} features: {f}" -i serde_json` → **`serde_json v1.0.151 features: default,float_roundtrip,raw_value,std`**。

### 3.3 独立复现两个浮点位串

独立探针（临时 `examples/zz_p2c_float_probe.rs`，用完即删）：

```
57.329040578513684:     std=404caa1e006de2f8 serde=404caa1e006de2f8 bit_equal=true ulp=0 | roundtrip=404caa1e006de2f8 rt_equal=true
-0.011674411920738925:  std=bf87e8c10b3264c0 serde=bf87e8c10b3264c0 bit_equal=true ulp=0 | roundtrip=bf87e8c10b3264c0 rt_equal=true
-0.0045787545787545625: std=bf72c12c12c12c00 serde=bf72c12c12c12c00 bit_equal=true ulp=0 | roundtrip=bf72c12c12c12c00 rt_equal=true
0.0045787545787547845:  std=3f72c12c12c12d00 serde=3f72c12c12c12d00 bit_equal=true ulp=0 | roundtrip=3f72c12c12c12d00 rt_equal=true
ALL_BIT_EQUAL_AND_RT=true
```

⇒ 两个位串（`57.329040578513684`、`-0.011674411920738925`）现在与**正确舍入**（`str::parse`）**逐位一致（0 ulp）**，且 `to_string→from_str` 往返位级保真。证据：`07_float_probe.txt`。

### 3.4 抽查未把任何既有断言改弱

逐条读 `git diff`（两个被测文件）：

| 文件 | 改动性质 | 是否放宽 |
|---|---|---|
| `crates/application/tests/strategy.rs` | 测试名 `…_seeds_11_…`→`…_seeds_12_…`；`assert_eq!(seeded, 11→12)`、`catalog.len() 11→12`、`(n_strategy,n_template) (7,4)→(8,4)`；+3 行依据注释 | ❌ **否**：均为「按新事实改数字」（8 参考插件 + 4 模板 = 12，ADR-021 §8 裁决 A），仍是 `assert_eq!` 精确等值 |
| `crates/strategy-core/src/reference.rs` | 模块/函数 doc「7 款」→「8 款」；`BUILTIN_ORDER [&str; 7]→[&str; 8]`（追加 `"dcap"`）；`assert_eq!(plugins.len(), 7→8)`；**新增** `t12_dcap_registered_with_plugin_abi_and_core_sentinels`；新增第 8 条 `ReferencePlugin{id:"dcap",…}` | ❌ **否**：数字按新事实更新 + 追加条目/追加测试；**未**出现 `>= 7` 这类放宽容差 |

- 全库 dcap 测试文件 grep `#[ignore]|.skip(|toBeCloseTo|within(|epsilon` → **0 命中**。
- `serde_json` feature 变更本身**未触碰任何测试文件**（`git diff --stat` 中 `.rs`/`.ts` 无 feature 相关改动）。
- 证据：`02_feature_change_review.txt`、§7.4。

---

## 4. 项 4 —— 归一化跨端一致（非单调参数）

口径：`02-spec.md` §2 跨字段约束 + §4 铁律 5（归一化在 CORE 内）。
取非单调 `raw=(n_s,n_m,n_l)=(60,26,8)`：

- **插件侧**（临时 `examples/zz_p2c_norm_probe.rs`，真实 `QuickJsRuntime`，跑 90 根后读 `save()`）：

```
plugin effective windows raw=(60,26,8) -> (winS=60, winM=61, winL=62)
spec section2: n_m'=max(26,60+1)=61 ; n_l'=max(8,61+1)=62 -> (60,61,62)
```

- **前端入口**（临时 vitest 探针，import 真实生成物 `dcap.ts`）：

```
firstNN raw(60,26,8): 59 60 61      # smooth=0 ⇒ 首值下标 = n_i−1 ⇒ 生效 (60,61,62)
raw ≡ normalized(60,61,62) 逐位相同；再喂 normalized 不变（幂等）  ⇒ 1 passed
```

⇒ 两端生效窗口**一致**（60/61/62），符合 §2 公式（顺序归一）；**幂等**（f(f(x))=f(x)）且**确定**（同输入逐位同输出）。
证据：`08_norm_plugin_probe.txt`、`09_norm_frontend_probe.txt`；另有既有 `t5a_cross_runtime_nonmonotonic_params_bit_equal`（4 组非单调样例逐位）为绿。

---

## 5. 项 5 —— 镜像体与门禁

### 5.1 自切 CORE 区间比较

```
ts CORE bytes = 6226  sha256 = db5b3eff73e63615f217ddca77f9bb0319d863714d477b8ed95df4da603c64e7
js CORE bytes = 6226  sha256 = db5b3eff73e63615f217ddca77f9bb0319d863714d477b8ed95df4da603c64e7
byte-identical: True
length>=200: True
prefix up to CORE equal: False  (ts prefix len 1473 / js prefix len 3205)
CORE 内禁 Token：Math.pow/exp/log/import/export/「: number」/const/let 全部 False；Math.floor/Math.max = True
```

⇒ 两产物 CORE **字节数相同、sha256 相同、逐字节相同（diff 空）**；前缀不同（排除误读同一文件）；区间内无 TS 注解/模块语句/pow 类方法。

### 5.2 门禁

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

### 5.3 既有生成物内容未变（≥20 抽查）

对 `design/` 内全部 `file=` 目标中**已被 git 追踪**的生成物，逐文件与 `git show HEAD:<path>` 比对：

```
design file= targets=148  tracked=144  checked=144  differences=0
```

⇒ 144/144（远超 ≥20）逐字节未变，0 差异。证据：`03_core_mirror.txt`、`04_generated_artifacts_vs_head.txt`、`10_check_tangle.txt`。

---

## 6. 项 6 —— 工作树收敛

```
### git diff --name-status (tracked)
M	Cargo.toml
M	crates/application/tests/strategy.rs
M	crates/strategy-core/src/reference.rs

### git diff --cached --name-status (expect empty)
(end)

### forbidden-symbol changes in tracked diff
(none)          # clamp_score / fn aggregate / classify / ExecutionPolicy / /api/config 均无

### diff touching crates/web or crates/strategy-runtime/src
(end)           # 空
```

- 追踪改动仅 3 个文件：`Cargo.toml`（本轮 feature）、`crates/application/tests/strategy.rs`（P2-A tester 交付）、
  `crates/strategy-core/src/reference.rs`（P2-B coder 交付）。**本轮 P2-C 未再引入任何 CORE/产物变更**（见下）。
- **CORE/产物未因本轮而变化**：dcap 两产物 sha256 与 P2-B 报告逐字节一致——
  `dcap.ts = 521c2696…566fb1f`、`dcap.js = 60bc9b49…bcb8e3c2`（P2-B 报告 §1.2 同值）。
- **未动**：ABI（`design/12-strategy-system/02-plugin-abi.md`）、引擎、`aggregate`/`classify`/60-40 阈值、
  `ExecutionPolicy`、`/api/config/*`、`clamp_score`；`crates/web/**`、`crates/strategy-runtime/src/**` 零改动。
- `git diff --cached` **为空**（无暂存文件）。
- 本轮 P2-C 实际产物：`tester/evidence/021_dcap_p2c/**`、`tester/test/043_*.md`（仅验收留痕，均为 `??` 未追踪）。
- 证据：`11_worktree_convergence.txt`。

---

## 7. 项 7 —— 回归

### 7.1 Rust：`cargo test --workspace` → **exit 0**

- **合计：passed=662 / failed=0 / ignored=1**（跨 92 个 result 行；`FAILED|panicked` 计数 = 0）。
- 唯一 ignored = `strategy-core/tests/engine.rs` 的 `perf_smoke_1260_bars_3_plugins`（**既有设计**，非本轮引入、未削弱）。
- dcap 子套件均绿：`dcap_cross_runtime.rs` 6、`dcap_plugin_init.rs` 5、`dcap_plugin_replay.rs` 3。
- 证据：`12_cargo_test_workspace_full.txt`、`13_cargo_test_workspace_summary.txt`。

### 7.2 Web：`cd web && npx vitest run` → **exit 0**

```
 Test Files  52 passed (52)
      Tests  514 passed (514)
```

含 dcap 套件：`dcap.test.ts`(10)、`dcapMirror.test.ts`(11)、`dcapNormalize.test.ts`(5)、`dcapInsufficient.test.ts`(4) 全绿。
证据：`15_vitest_full.txt`、`14_web_tsc_vitest_summary.txt`。

### 7.3 Web：`cd web && npx tsc -b` → **exit 0**（无输出）

**瞬态说明（如实记录）**：在一次「tsc→vitest 连跑」中，`npx vitest run` 一度返回退出码 **1**（输出被重定向未留存失败明细）。
随后**独立复跑 11 次**（含原样连跑序列 2 次）**全部 exit=0 且 `514 passed (514)`**，**未复现**任何失败用例；
判定为与 dcap 无关的瞬态（既知 `DashboardPage` 时序敏感用例族），不构成阻断。

### 7.4 断言放宽扫描（全库 dcap 测试文件）

```
grep -rnE "#\[ignore\]|\.skip\(|it\.skip|describe\.skip|toBeCloseTo|within\(|epsilon" \
  crates/strategy-runtime/tests/dcap_*.rs web/src/features/indicators/dcap*.test.ts
→ (none found)
```

---

## 8. 失败用例 / 崩溃 / core dump

| 项 | 结果 |
|---|---|
| 失败用例（最终态） | **无**（Rust 0 / Web 0） |
| 失败用例（反向证据态，已还原） | `t7_replay_continuation_scores_bit_equal`（变异注入）；`reference_plugins_match_builtin_order`、`t12_dcap_registered_with_plugin_abi_and_core_sentinels`（变异注入）——均在还原后复绿 |
| 崩溃 | **无** |
| core dump | **无**（全流程无 SIGSEGV/SIGABRT；无 `core.*`） |
| 暂存文件 | 无（`git diff --cached` 空） |
| 残留临时文件 | 无（`examples/zz_p2c_*.rs`、`web/.../zz_p2c_probe.test.ts` 已删；`git status` 无残留） |

---

## 9. 覆盖小结（T1–T12 视角）

| 判据 | 状态（本报告可证） |
|---|---|
| T1 口径基准（容差） | 绿（`dcap.test.ts` 10，含冻结值） |
| T2 smooth=0≡raw（逐位） | 绿（`t2_plugin_smooth_off_equals_m1_bit_equal`） |
| T3 镜像体（逐字节） | 绿（`dcapMirror.test.ts` 11 + 本报告 §5.1） |
| T4 跨运行时（逐位） | 绿（`dcap_cross_runtime.rs`） |
| T5a 归一化（插件/前端/跨端） | 绿（§1、§4） |
| T6 数据不足边界 | 绿（`dcap_plugin_init.rs`、`dcapInsufficient.test.ts`） |
| T7 状态持久化（位级） | 绿 + 反向证据（§1、§2.1） |
| T12 播种/清单 | 绿 + 反向证据（§1、§2.2） |
| 8/tangle 门禁 | 绿（§5） |

---

## 10. 残余风险 / 最小建议（供父级/架构裁决；均**未**自行处置）

1. **`t7_channel_probe` 的语义**：该探针断言的是平台 `save()/load()` 十进制通道的位级保真。启用 `float_roundtrip` 后其**通过**（`(a)/(b)` 误舍入消失；`(c)` 数据集 40/40 位级可往返）。**这是被修复而非被放松**，断言形式（位级）未改。
2. **Web 瞬态退出码**：见 §7.3，11 次连跑未复现，建议后续 CI 观察 `DashboardPage` 时序用例；与 dcap/feature 无关联证据。
3. **`dcapScore` 入口归一化字面落地的签名缺口**：`02-spec §4 铁律 5` 字面句「`dcapScore` 入口调用 `normalizeParams`」与其冻结签名 `dcapScore(values, th)`（无 params 形参）冲突；语义上已由 `computeDcapSeries` + 插件 `init` 覆盖（T5a 跨运行时逐位绿即证）。此项为**既有口径缺口**，两路（tester `013_…` §6.2、coder `155_…` §2.3）已各自留痕，非本轮引入、不影响本报告判据。

---

## 11. 纪律与自证

- **本报告为执行报告**：本轮未设计/新增任何**永久**测试；仅执行既有测试 + 临时探针（已删）+ 反向变异（已还原）。
- **未修改实现/CORE/产物/ABI/引擎/agg/Policy/api-config**；变异全部按 sha256 还原（`dcap.js=60bc9b49…`、`reference.rs=85525c06…`）。
- **未 `git add`/`commit`/`stash`**；**未起 8081/8082**；**未以任何形式放宽/削弱断言**；**未做失败分析、未尝试修复**。
- 证据索引：`tester/evidence/021_dcap_p2c/`（`00_*`~`15_*`）。

---

**VERDICT: PASS**
