# P2-B 报告 — CORE 入口归一化 + 接入播种清单（Green）

- **报告自身路径**：`coder/report/155_dcap_p2b_core_normalize_seed.md`
- **执行时间**：2026-09-13 15:45 ~ 15:55 CST（原始输出保存在 `/tmp/dcap_p2b/`，仓库外）
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`（全部命令在此目录执行）
- **权威口径**：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`
- **上游（不重做）**：P0（js 产物门禁无假绿）、P1（CORE 双产物 + T1/T2/T3/T4）、P2-A（tester 红测试：
  `tester/design/013_dcap_p2a_t5a_t6_t7_t12_red_design.md`、`tester/test/041_dcap_p2a_t5a_t6_t7_t12_red_execution.md`）
- **阶段**：P2-B（Green）。**未 git add / commit / stash（`git diff --cached` 为空）；未 stage 任何文件**
- **硬约束**：未改 ABI 契约 / `clamp_score` / `aggregate` / `classify` / 60-40 阈值 / `ExecutionPolicy` /
  `/api/config/*`；未起 8081/8082；未改任何测试断言（测试文件全部为 tester 交付，我一行未动）

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| `normalizeParams(p)` 进 CORE（两个块同字节） | ✅ 新增（`02-spec.md:318` ts 块 / `:522` js 块，逐字节相同） |
| 插件 `init` 调用归一化 + `on_bar` 只读生效值 | ✅（`02-spec.md:659/674`，哨兵之外） |
| 前端 `computeDcapSeries` 入口调用归一化 | ✅（`02-spec.md:394/598`，CORE 之内） |
| `entangled tangle` 重生成两份产物 | ✅ exit=0，写出 2 个文件；稳定态 `Nothing to be done` |
| CORE 区间两产物逐字节相同 | ✅ 6224 B，sha256 `83e51620…16e4a62`（两侧同） |
| `./scripts/check-tangle.sh` | ✅ exit=0 |
| 既有 **144** 个生成物 sha256 未变 | ✅ `MANIFEST_IDENTICAL 144/144`（并与 P1 独立快照交叉核对：0 处差异） |
| `crates/strategy-core/src/reference.rs` 第 8 条 `dcap` | ✅ 已接入（`reference_plugins()` 7 → 8） |
| T5a（插件面 3 + 前端面 5 + 跨运行时 1） | ✅ 全绿 |
| T6（插件面 2 + 前端面 4） | ✅ 全绿 |
| T12（清单 2 + 播种 1） | ✅ 全绿（strategy-core 33 绿；application strategy 39 绿） |
| T7-e2e / T7-teeth | ✅ 绿（连续跑 vs save→load 续跑 0 处位差；漏存字段被抓到） |
| **T7-channel 探针** | ❌ **红（架构级，平台通道非位级保真；非本轮引入）** → 见 §5 |
| `web` vitest 全量 | ✅ 52 文件 / 514 例全绿 |
| `web` `npx tsc -b` | ❌ exit=2（**tester 的 `dcapNormalize.test.ts` 3 处 TS2353**，非本轮引入）→ 见 §8.1 |

**VERDICT：见文末。**

---

## 1. 改动文件清单

### 1.1 事实源（文档，docs-as-source）

| 文件 | 改动 | 说明 |
|---|---|---|
| `design/14-dcap-indicator/02-spec.md` | +52 / −0 行（658 → 710 行；sha256 `0d39ee7e…` → `85838344…`） | 仅改 §10 两个 entangled 块 + §10 前言一行；**§1–§9 未动** |

CORE 块改动位置（`grep -n` 实测，改后行号）：

```
 291: // === DCAP CORE BEGIN ===          ← ts 块（§10.1）
 318: function normalizeParams(p) {      ← 新增（CORE 内）
 394: function computeDcapSeries(closes, p) {   ← 入口归一化（CORE 内）
 438: // === DCAP CORE END ===
 483: let effS = 8;                      ← 新增（js 包装层，哨兵之外）
 495: // === DCAP CORE BEGIN ===          ← js 块（§10.2；与 ts 块 CORE 逐字节相同）
 522: function normalizeParams(p) {      ← 新增（同字节）
 598: function computeDcapSeries(closes, p) {   ← 同字节
 642: // === DCAP CORE END ===
 659: function init(params) {            ← 调用 normalizeParams（哨兵之外）
 674: function on_bar(ctx) {             ← 只读 effS/effM/effL（哨兵之外）
```

改动清单（`02-spec.md` 内，逐条）：

1. CORE 头部铁律清单追加 **④ 入口归一化也在 CORE 内**（两处：ts/js 块，同字节）；
2. CORE 新增 **`normalizeParams(p)`**（`n_m ← max(n_m, n_s+1)`、`n_l ← max(n_l, n_m'+1)`，顺序归一、确定、幂等）；
3. CORE 的 **`computeDcapSeries` 入口先 `normalizeParams`**（`var q = normalizeParams(p)`，后续一律用 `q`）；
4. 该函数的 doc 注记补「入口先归一化」一句；
5. 插件块头注记补「`init` 先归一化、`on_bar` 不得重复归一化」；
6. 插件包装层新增 `let effS/effM/effL`（归一化后的生效窗口，**非流相关派生量 ⇒ 按 §5 不入 `save()`**）；
7. 插件 `init(params)` 调 `normalizeParams` 并把生效值写进模块状态；
8. 插件 `on_bar` 的 `nS/nM/nL` 改为读 `effS/effM/effL`（不再逐 bar 从 `ctx.params` 取 n）；
9. §10 前言补一行：铁律 5 的入口归一化同样只在 CORE 区间内定义。

### 1.2 生成物（由 `entangled tangle` 写出，禁止手改）

| 文件 | 改动前 | 改动后 |
|---|---|---|
| `web/src/features/indicators/dcap.ts` | 6689 B / sha256 `6cb2f1ef…216a83` | **8031 B** / sha256 `521c2696…566fb1f` |
| `crates/strategy-core/reference-plugins/dcap.js` | 9763 B / sha256 `d83c65ed…237b862` | **11935 B** / sha256 `60bc9b49…bcb8e3c2` |

### 1.3 播种清单（实现代码）

| 文件 | 改动 |
|---|---|
| `crates/strategy-core/src/reference.rs` | `reference_plugins()` 追加第 8 条 `dcap`（`include_str!("../reference-plugins/dcap.js")`，中文 id/name/description，风格与既有 7 条一致）；模块/函数 doc 的「7 款」→「8 款」+ 依据注记。**未改** `[cfg(test)]` 内 tester 已写好的 `BUILTIN_ORDER [&str; 8]` / `len 8` / `t12_…` 用例 |

### 1.4 未改动（明确不做 / 硬约束）

- `crates/application/tests/strategy.rs`（tester 已把 11→12、(7,4)→(8,4)）：**我一行未动**（`git diff` 与该文件在 P2-A 交付时逐字节一致）；
- `crates/strategy-runtime/tests/*`（tester 的 3 个测试文件）：**未动**；
- `*.test.ts`（tester 的 4 个前端测试文件）：**未动**；
- `entangled.toml`、`Cargo.toml`、`Cargo.lock`、`clamp_score`/`aggregate`/`classify`/60-40 阈值/`ExecutionPolicy`/`crates/web/src/dto.rs`/`rest.rs`/`/api/config/*`：**未动**；
- **`.entangled/filedb.json`（gitignore）**：被 tangle 刷新（`0ea5971f…` → `27dc11f3…`，212 targets）；随后 `entangled tangle -s` = `Nothing to be done`（无冲突）。

---

## 2. 实现方式（关键决策，全部在既有架构内）

### 2.1 `normalizeParams` 本体（CORE，两份产物同字节）

```js
function normalizeParams(p) {
  var s = Math.floor(p.n_s);
  var m = Math.max(Math.floor(p.n_m), s + 1);
  var l = Math.max(Math.floor(p.n_l), m + 1);
  return { n_s: s, n_m: m, n_l: l, r_s: p.r_s, r_m: p.r_m, r_l: p.r_l, smooth: p.smooth, m: p.m };
}
```

- **顺序归一**：`m` 用 `s+1` 顶，`l` 用**已归一的 `m`** 顶（与 §2 文字逐字对应）；
- **确定 + 幂等**：`Math.floor`/`Math.max` 均为纯函数；`f(f(p)) = f(p)`（第二遍 `m > s`、`l > m` 恒成立）；
- **铁律达标**：只用 `Math.floor`/`Math.max`（无 `pow/exp/log`）；无 TS 注解、无 `import/export`；
- **非法输入**（NaN/±Inf）：归一结果仍非有限 ⇒ 由调用方按「参数非法 → 中立 50」处理（`on_bar` 的既有守卫）。

### 2.2 三个入口的落位

| 入口 | 落位 | 做法 |
|---|---|---|
| 前端 `computeDcapSeries` | CORE 内（`02-spec.md:394`） | `var q = normalizeParams(p)`，后续 `dcapRoi`/`smoothSeries` 全用 `q` |
| 插件 `init(params)` | 哨兵之外（`:659`） | `const q = normalizeParams(params)` → `effS/effM/effL = Math.floor(q.n_*)` |
| 插件 `on_bar` | 哨兵之外（`:674`） | 只读 `effS/effM/effL`；**不重复归一化**（§3/§5 明文） |

- 归一化后的**生效值存模块状态**（`effS/effM/effL`），不入 `save()/load()`：§5 明文列出的内部状态是
  「三条 close 滚动窗 + 三条 SMA 尾窗」六条；生效 n 是 **params 的纯派生量**（重放时平台以同一 params
  重新 `init` 再 `load`），按 §5 不进快照（也与既有参考插件「派生参数不落状态」的惯例一致）。
- `t5a_cross_runtime_nonmonotonic_params_bit_equal` 为绿即证：插件（`init` 归一）与前端
  （`computeDcapSeries` 归一）对 4 组非单调参数逐位一致。

### 2.3 §4 铁律 5 中「`dcapScore` 入口也调用它」一句的处理（口径说明，非静默偏移）

`dcapScore(values, th)` 的契约签名**无 params 形参**（§4 同时钉死该签名），故「`dcapScore` 入口做 n
归一化」在签名上不可落地；`dcapScore` 的输入恒为「已归一化的 `computeDcapSeries` / 插件归一窗口」
产物，语义上已被覆盖。tester 在 `013_…_red_design.md` §6.2 已独立记录该缺口，并明确本批只钉
`computeDcapSeries`（行为可观测）。**我未改 `dcapScore` 签名、未加可选形参**（不擅自扩契约）。

---

## 3. tangle 与门禁证据

### 3.1 `entangled tangle`（改文档块 → 生成物）

```
$ entangled tangle -s                     # 改文档后、生成前的 dry-run
[15:48:09] INFO     Welcome to Entangled v2.4.3!
           INFO     write `web/src/features/indicators/dcap.ts`
           INFO     write `crates/strategy-core/reference-plugins/dcap.js`
           INFO     nothing is done                    # 无 ERROR / 无 conflict / 无 not-managed
PLAN_EXIT=0

$ entangled tangle                        # 真实写入（无 --force）
[15:48:12] INFO     Welcome to Entangled v2.4.3!
           INFO     write `web/src/features/indicators/dcap.ts`
           INFO     write `crates/strategy-core/reference-plugins/dcap.js`
TANGLE_EXIT=0                               # 且两文件确实落盘（8031 B / 11935 B，mtime 15:48）

$ entangled tangle -s                     # 稳定态复跑
[15:50:23] INFO     Nothing to be done.
STEADY_EXIT=0
```

### 3.2 CORE 区间逐字节相同（切哨兵独立复算）

```
ts CORE bytes= 6224 sha256= 83e51620fd82862a85ae24c36f7f7ccb0ae38ffabddfd45029040f3071e8e9d1
js CORE bytes= 6224 sha256= 83e51620fd82862a85ae24c36f7f7ccb0ae38ffabddfd45029040f3071e8e9d1
CORE 逐字节相同: True | >=200 字节: True
两侧前缀不同（防误读同一文件）: True
区间内禁 Token 检查: {'Math.pow': False, 'Math.exp': False, 'Math.log': False,
                     'import ': False, 'export ': False, ': number': False, ': string': False,
                     'const ': False, 'let ': False}
（另：区间内 Math.floor / Math.max 均存在；CORE 无顶层可变状态）
```

（同一脚本对 `02-spec.md` 的两个块体也跑了：写入时刻即 `BYTE-IDENTICAL`，sha256 同上。）

### 3.3 `./scripts/check-tangle.sh`

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
CHECK_TANGLE_EXIT=0
```

### 3.4 既有 **144** 个生成物 sha256 未变（方法同 P1-B + 独立交叉核对）

```
$ # 目标集 = design/ 内所有 `file=` 目标（153 命中，其中 7 条为文档示例文本、2 条为 dcap 新产物）
$ #   ⇒ 既有生成物 = 144
$ sha256sum <144 files> | sort -k2 > manifest_after.sha256      # 改后
$ diff manifest_before.sha256 manifest_after.sha256
MANIFEST_IDENTICAL: 144/144 既有生成物逐字节未变

$ # 独立交叉核对（第三方快照：P1-B 落盘前保存的 144 行清单 /tmp/dcap_p1b/filedb/manifest_before.sha256）
SET_IDENTICAL (144 files)；files=144 differs=0
```

> 清单文件自身 sha256：`manifest_before = 21f7d9ea…8ab2`、`manifest_after = 21f7d9ea…8ab2`（同一文件，逐字节相同）。
> 即：本轮 tangle 只改写了 dcap 两个产物，其余 144 个生成物**内容零变化**（这是 §1.3 之外唯一可能被
> tangle 波及的面，已被机械排除）。

---

## 4. 测试输出片段

### 4.1 `cargo test -p strategy-core --no-fail-fast`（T12 清单）

```
     Running unittests src/lib.rs
running 33 tests                                     ← P2-A 时 31 绿 / 2 红；现 33 绿
test result: ok. 33 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/engine.rs          → 25 passed; 0 failed; 1 ignored
     Running tests/observer.rs        → 6 passed; 0 failed
     Running tests/templates.rs       → 3 passed; 0 failed
```

### 4.2 `cargo test -p application --no-fail-fast`（T12 播种）

```
     Running unittests src/lib.rs     → 26 passed; 0 failed
     Running tests/simlive.rs         → 55 passed; 0 failed     ← 未受清单长度变化影响
     Running tests/strategy.rs        → 39 passed; 0 failed     ← P2-A 时 38 绿 / 1 红；现 39 绿
     Running tests/workbench.rs       → 17 passed; 0 failed
```

### 4.3 `cargo test -p strategy-runtime --test dcap_cross_runtime -- --nocapture`

```
running 6 tests
test t4_sample_set_meets_spec ... ok
test t5a_cross_runtime_nonmonotonic_params_bit_equal ... ok     ← 本轮 T5a 跨运行时（归一化在 CORE）
test t4_selfcheck_comparator_teeth_one_ulp_and_sandbox_pipeline ... ok
test t2_plugin_smooth_off_equals_m1_bit_equal ... ok
test t4_cross_runtime_scores_bit_equal ... ok
test t4_cross_runtime_raw_series_bit_equal ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.17s
```

### 4.4 `cargo test -p strategy-runtime --test dcap_plugin_init -- --nocapture`（T5a 插件面 + T6）

```
running 5 tests
test t6_plugin_all_lines_insufficient_returns_exactly_50_and_no_log_noise ... ok
test t6_plugin_insufficient_lines_are_excluded_from_n ... ok
test t5a_plugin_windows_do_not_drift_across_bars ... ok            ← P2-A 红 → 绿
test t5a_plugin_normalization_is_idempotent_and_bitwise_deterministic ... ok  ← P2-A 红 → 绿
test t5a_plugin_effective_windows_follow_normalization ... ok      ← P2-A 红 → 绿
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

### 4.5 `cargo test -p strategy-runtime --test dcap_plugin_replay -- --nocapture`（T7）

```
running 3 tests
[T7-channel] (c) 本次数据集（real518880_m15_64, split=30）的 dcap 快照共 40 个浮点数，全部位级可往返（未命中误舍入样本）
[T7-teeth] 未注入产物 split=30 逐位差异数 = 0（0 = 位级保真；>0 = 产物/通道问题）
test t7_selftest_missing_save_field_is_detected ... ok
test t7_replay_continuation_scores_bit_equal ... ok     ← save→load→续跑 与 连续跑 逐位相同（0 处差异）
test t7_channel_probe_channel_is_not_bit_exact ... FAILED   ← 架构级（平台通道），见 §5
test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
（cargo test -p strategy-runtime --no-fail-fast 总退出码 101；其余 14 unit + 13 contract 全绿）
```

### 4.6 `web`（vitest）

```
$ npx vitest run src/features/indicators/
 ✓ src/features/indicators/dcapMirror.test.ts (11 tests)        ← T3 镜像（CORE 逐字节）
 ✓ src/features/indicators/dcapInsufficient.test.ts (4 tests)   ← T6 前端逐线
 ✓ src/features/indicators/dcapNormalize.test.ts (5 tests)      ← T5a 前端入口（P2-A 4 红 → 全绿）
 ✓ src/features/indicators/dcap.test.ts (10 tests)              ← T1/T2 冻结值未漂
 Test Files  4 passed (4) | Tests  30 passed (30)

$ npx vitest run
 Test Files  52 passed (52) | Tests  514 passed (514)            ← P2-A 时 510 绿 / 4 红
```

### 4.7 全量 `cargo test -p strategy-runtime --no-fail-fast`

```
unittests src/lib.rs        → 14 passed; 0 failed
tests/contract.rs           → 13 passed; 0 failed
tests/dcap_cross_runtime.rs → 6 passed; 0 failed
tests/dcap_plugin_init.rs   → 5 passed; 0 failed
tests/dcap_plugin_replay.rs → 2 passed; 1 FAILED（t7_channel_probe_*，§5）
```

---

## 5. ⚠️ 唯一红：`t7_channel_probe_channel_is_not_bit_exact`（架构级，非本轮引入）

**它不是我实现的问题**：该探针断言的是**平台 `save()/load()` 通道**（ABI G3）的位级保真能力，
与 dcap 实现无关；P2-A（tester，未动实现）就已把它测红，`041_…_red_execution.md` §2 已上报。

现场证据（本轮复跑，逐字一致）：

```
[T7-channel] 平台状态通道（ABI G3：`save()/load()`）不具备位级保真 ⇒ 架构级问题
(a) `serde_json` 十进制解析非正确舍入（crates/strategy-runtime/src/quickjs.rs:272-277）：
  -0.011674411920738925: str::parse=bf87e8c10b3264c0 serde_json::from_str=bf87e8c10b3264bf  差 1 ulp
  57.329040578513684:    str::parse=404caa1e006de2f8 serde_json::from_str=404caa1e006de2f7  差 1 ulp
(b) 平台 `save()→load()` 现场可证伪（真实 QuickJsRuntime API）：
  起始值=57.329040578513684(404caa1e006de2f8) → 经 save→load 后=57.32904057851368(404caa1e006de2f7)，差 1 ulp
(c) dcap 快照（real518880_m15_64, split=30）共 40 个浮点数：本次数据集全部位级可往返（未命中误舍入样本）
```

**为什么停在这里**：T7 的位级保真修复只能落在**运行时序列化**（`crates/strategy-runtime/src/quickjs.rs`
+ 依赖配置）——即 ABI G3 通道本身，属被冻结面；派单明文「未经批准不得擅自改运行时序列化契约」。
故我**未改任何运行时/序列化代码，未放宽任何断言**（探针原样保留为红）。

### 5.1 候选方案（请架构裁决；均已做过最小验证）

**候选 1（推荐，最小改动、无损）**：给工作区 `serde_json` 依赖打开 `float_roundtrip` feature
（`Cargo.toml:30`：`serde_json = { version = "1", features = ["float_roundtrip"] }`）。
- 机制：只把**解析**改成正确舍入（wire 格式、JSON 形状、ABI、插件代码全不变；`to_string` 的 ryu 最短
  表示本就正确往返）；`(a)`、`(b)` 两处证据同时消失。
- 已验证（仓库外最小复现 `/tmp/serde_probe`，`cargo run --offline`）：
  ```
  -0.011674411920738925: str::parse=bf87e8c10b3264c0 serde=bf87e8c10b3264c0 equal=true
  57.329040578513684:    str::parse=404caa1e006de2f8 serde=404caa1e006de2f8 equal=true
  roundtrip 57.329040578513684: 404caa1e006de2f8 -> 404caa1e006de2f8 equal=true
  ```
  （本机 `serde_json 1.0.151` 支持该 feature；`Cargo.lock` 需随之更新。）
- 代价：解析路径略慢（仅状态通道，非逐 bar 热路径）；需架构批准一次依赖 feature 变更。

**候选 2（重，需新 ADR）**：状态通道改为位级无损编码（hex 位串 / 整型 + typed transport）。
- 会改 ABI G3 快照形状 ⇒ 影响全部既有播种插件的历史快照兼容（需版本化），代价远大于候选 1；
- 且只靠**插件侧**局部编码**不能**让探针绿（探针 (b) 用的是平台级沙箱插件），故必须动平台通道。

**候选 3（不修，记为架构债 / 由 tester 重裁口径）**：承认「十进制通道对**特定**最短表示可丢 1 ulp」
是既定限制；探针改写为「记录该限制 + 断言 dcap 数据集位级可往返」。
- 事实支持：dcap 快照 40/40 浮点位级可往返、T7-e2e 0 处位差（本次数据集未命中）；
- 但这要改 tester 的测试语义（**不属 coder 职责**），且与 `03-test-plan.md` T7「必须位级保真」硬要求冲突，
  故需架构+tester 共同裁决。

---

## 6. 「未放宽任何既有断言」的说明（逐条对照）

| 断言 | P2-A（红） | 本轮（绿） | 是否放宽 |
|---|---|---|---|
| `reference_plugins_match_builtin_order` | `len 7 → 8`、`BUILTIN_ORDER [&str; 8]`（tester 已改） | 8 条→绿 | ❌ 无（**未改**，按新事实 8，未出现 `>= 7` 形式） |
| `seed_reference_plugins_seeds_12_and_is_idempotent` | `11 → 12`、`(7,4) → (8,4)`（tester 已改） | 12 条→绿 | ❌ 无（**未改**文件；仍是 `assert_eq!` 精确等值） |
| T5a 插件面 3 例 | 红（窗口容量/幂等/不漂移） | 绿 | ❌ 无（实现侧归一化，断言原样） |
| T5a 前端面 5 例 | 4 红 | 绿 | ❌ 无（断言原样，逐位比较） |
| T5a 跨运行时 1 例 | 绿（护栏） | 绿 | ❌ 无 |
| T6 插件/前端 6 例 | 绿 | 绿 | ❌ 无 |
| T7-e2e / T7-teeth | 绿 | 绿 | ❌ 无 |
| T7-channel 探针 | 红 | **红（保持）** | ❌ 无 —— **明确拒绝**「放宽容差 / 改断言 / `#[ignore]`」三条捷径 |
| T1/T2/T3/T4 既有 + 前端/后端全量回归 | 绿 | 绿 | ❌ 无 |

**测试文件改动：0 行**（`git status`：4 个 `*.test.ts`、3 个 `crates/strategy-runtime/tests/*`、
`crates/application/tests/strategy.rs` 均为 P2-A tester 交付时的内容，我未触碰）。
`git diff`（tracked）仅 2 个文件：`reference.rs`（实现，见 §1.3）与 `application/tests/strategy.rs`
（**tester 的改动**，内容与 P2-A 交付一致）。

---

## 7. 约束遵守清单

| 约束 | 状态 | 证据 |
|---|---|---|
| 禁 `git add` / `commit` / `stash` | ✅ | `git diff --cached --name-only` = 0 行；`git status` 无 `A ` 条目 |
| 禁改 ABI / `clamp_score` / `aggregate` / `classify` / 60-40 阈值 / `ExecutionPolicy` / `/api/config/*` | ✅ | `git diff --stat` 仅 `reference.rs`（+61/−14）与 tester 的 `strategy.rs`；`crates/strategy-runtime/src/**`、`crates/web/**` 零改动 |
| 禁起 8081/8082 | ✅ | 未启动任何服务（仅 cargo/vitest/tangle） |
| 禁改测试迁就实现 | ✅ | 见 §6（测试文件 0 改动；未放宽/未跳过任一断言） |
| 归一化「只在 `init` 一次、`on_bar` 不重复」 | ✅ | `on_bar` 只读 `effS/effM/effL`；`t5a_plugin_windows_do_not_drift_across_bars` 绿 |
| 改文档块必须重跑 tangle | ✅ | §3.1（`write` × 2）+ §3.3（check-tangle exit=0） |
| 既有生成物零变化 | ✅ | §3.4（144/144 + P1 快照交叉核对 0 差异） |
| 未改 `entangled.toml` / 未用 `--force` | ✅ | `git diff entangled.toml` 空；真实仓内只用 `entangled tangle`（无 `-f`） |

---

## 8. 发现 / 残余风险（供父级与 tester 处置）

### 8.1 【findings，非本轮引入】`web` `npx tsc -b` exit=2（tester 测试文件 3 处 TS 错误）

```
$ cd web && npx tsc -b ; echo $?
src/features/indicators/dcapNormalize.test.ts(87,72): error TS2353: Object literal may only specify
  known properties, and 'th' does not exist in type 'Partial<DcapParams>'.
src/features/indicators/dcapNormalize.test.ts(121,73): error TS2353: ...
src/features/indicators/dcapNormalize.test.ts(135,93): error TS2353: ...
2
```

- 事实：`DcapParams` 按 §4 只含 8 个显示参数（**不含 `th`**，§7 明文「`th` 不在此接口」），而
  tester 的 `dcapNormalize.test.ts` 在 3 处 `params({ …, th: … })` 传入 `th`（运行期无害、类型期报错）。
- 影响面：`npm run build`（`tsc -b && vite build`）红；**生产镜像不受影响**（`build:prod` = `vite build`，
  Dockerfile.app 走它）；vitest 不做类型检查，故测试全绿。
- **我未改该测试文件**（tester 职责 + 「禁改测试」约束）。最小修法（供 tester 选）：把 3 处 `th` 从
  `params(...)` 里删掉（`th` 仅 `dcapScore` 需要），或把该 helper 的参数类型写成
  `Partial<DcapParams> & { th?: number }`。
- 备注：P1-B 时 `tsc -b` exit=0；该错误随 P2-A 的新测试文件引入。

### 8.2 `dcapScore` 入口归一化（§4 铁律 5 的字面句）——见 §2.3

`dcapScore(values, th)` 无 params 形参（§4 同时冻结该签名）⇒ 该句不可字面落地；语义上已被
`computeDcapSeries` + 插件 `init` 覆盖（T5a 跨运行时逐位绿即证）。若架构要求字面落地，需**先改 §4 签名**
（属契约变更，需批准 + 重跑 tangle）。

### 8.3 其他

- 归一化的**单参数越界**（`n=1/251`、`r=NaN/Inf`、`m=0/61`…）不由插件断言（ABI §1 NIT-6）：插件对
  非法输入走「中立 50」；`T5b`（400 拒绝）属 P3 配置端点，本轮不做（派单已明确）。
- `r^(k-1)` 的数值行为、两步法累加序**未动**（本轮只改入口 n，`dcapRoi`/`smoothSeries`/`dcapScore` 正文逐字节未改）。
- 前端 UI / `/api/config/dcap` / `DASHBOARD_DEFAULTS`：**未动**（P3）。

---

**报告自身路径**：`coder/report/155_dcap_p2b_core_normalize_seed.md`
**原始证据（仓库外）**：`/tmp/dcap_p2b/`（`patch_spec.py`、`02-spec.before.md`、`manifest_before.sha256`、
`manifest_after.sha256`、`products_before.sha256`、`tests_core_app.txt`、`tsc.out`、`p1_set.txt`/`p2b_set.txt`）、
`/tmp/serde_probe`（候选 1 的最小复现）

**VERDICT: FAIL(T7 通道探针 `t7_channel_probe_channel_is_not_bit_exact` 红 —— 平台 `save()/load()` 十进制通道
`serde_json 1.0.151` 解析非正确舍入、实测丢 1 ulp；属 P2-A 已上报的架构级问题，**非本轮实现缺陷、未放宽容差**。
P2-B 全部指定判据已绿：CORE 归一化（T5a 插件 3 + 前端 5 + 跨运行时 1）、T6、T12、T7-e2e/T7-teeth、
tangle 双产物逐字节同 + check-tangle exit=0 + 既有 144 生成物 sha256 零变化、web 514/514、strategy-core 33/33、
application 39/39。候选方案见 §5：① 工作区 `serde_json` 开 `float_roundtrip`（推荐，已最小验证）② 通道改位级
编码（需新 ADR）③ 记为架构债并由 tester 重裁 T7 口径；未经批准未改运行时/序列化代码。)
