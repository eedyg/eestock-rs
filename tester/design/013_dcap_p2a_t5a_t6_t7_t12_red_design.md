# dcap 指标 —— T5a / T6 / T7 / T12 测试设计（P2-A，Red 阶段）

- 报告自身路径：`tester/design/013_dcap_p2a_t5a_t6_t7_t12_red_design.md`
- 权威口径：`design/14-dcap-indicator/{01-adr.md, 02-spec.md, 03-test-plan.md, 04-implementation-plan.md}`
  （**已更新**：§2 跨字段约束落地方式、§4 铁律 5 入口归一化、T5a/T5b）
- 阶段：P2-A（**先写失败测试**：T5a / T6 / T7 / T12 的 Red 态）
- 上游已完成（本批不重做）：P0（js 产物门禁无假绿）、P1（CORE 双产物 + T1/T2/T3/T4 绿，见
  `tester/design/012_dcap_t1_t4_red_design.md`、`tester/test/040_p1c_dcap_independent_acceptance_execution.md`）
- 执行报告（Red 证据）：`tester/test/041_dcap_p2a_t5a_t6_t7_t12_red_execution.md`
- 原始输出目录：`tester/evidence/020_dcap_p2a_red/`

---

## 1. 测试策略总览

| 层级 | 判据 | 落点 | 本批覆盖 |
|---|---|---|---|
| **逐位（IEEE754 位串）** | `===` 位串、`null` 位置一致 | Rust（QuickJS）× Rust（宿主）、vitest（V8） | T5a（生效值/幂等/确定）、T7（重放） |
| **精确值** | 位串 = `4049000000000000`（50.0） | Rust / vitest | T6（三线全不足 → 恰好 50） |
| **口径独立复算** | 用**同一段 CORE**在 QuickJS 内独立求期望值，再与插件 `on_bar` 比对 | Rust | T6-1（N 语义） |
| **清单事实** | 长度/顺序/id 唯一/ABI 钩子/哨兵 | Rust（strategy-core 内联测 + application 集成测） | T12 |
| **通道性质（架构级）** | 平台 `save()/load()` 位级保真 | Rust（`QuickJsRuntime` 真实 API） | T7 通道探针 |

**等价层级纪律**（03-test-plan §0）：T5a/T7 只允许**逐位**；T6 的 50 是精确常量；
**本批不使用任何容差断言**（T1 是唯一允许 1e-12 容差者，不属本批）。

**「禁改测试来迁就实现」的落实**：

- 本批**未削弱任何既有断言**。T12 两处计数改动是**按新事实升级**并写明依据：
  - `crates/strategy-core/src/reference.rs`：`BUILTIN_ORDER` `[&str; 7] → [&str; 8]`、`len 7 → 8`，
    依据 ADR-021 §8 裁决 A「dcap 进 `reference_plugins` 第 8 条（可播种/可参测）」；
  - `crates/application/tests/strategy.rs`：`11 → 12`、`(7,4) → (8,4)`、测试名 `…_seeds_11_… → …_seeds_12_…`，
    依据同上（8 参考插件 + 4 官方模板；模板数不变）。
  - **没有**出现 `assert_eq!(len, 7)` 改成 `>= 7` 这类放宽。
- T4 既有样例守卫 `t4_sample_set_meets_spec`（强制 `n_s<n_m<n_l`）**保持原样不动**；
  非单调参数另起样例集 `nonmonotonic_samples()`，不污染既有守卫。

---

## 2. 层覆盖计划

| 被测面 | 文件 | 层 |
|---|---|---|
| 插件包装层（`init`/`on_bar`/`save`/`load`） | `crates/strategy-core/reference-plugins/dcap.js` | 插件（QuickJS 真机，`QuickJsRuntime`，非 mock） |
| 前端模块（生成的 `.ts`） | `web/src/features/indicators/dcap.ts` | 前端（Node/V8，vitest 直接 import） |
| 跨运行时一致性 | 两侧 | Rust harness（node 求值 `.ts` × QuickJS 求值 `.js`） |
| 播种清单 | `strategy-core::reference` + `application::StrategyService` | 单元 + 集成（mock store，无 DB） |

**Mock/桩策略**：本批**不引入任何 mock**。
- 插件侧用真实 `QuickJsRuntime`（ABI 真机语义，含真实 `save/load` JSON 通道）；
- 前端侧用 vitest 直接 import 真产物；
- T7 哨兵用**内存字符串变异**（不落盘、不改仓库文件）；
- T12 用 application 既有 mock store（`service(vec![])`，无 DB、无网络）。

---

## 3. 测试用例清单（新增/修改）

### 3.1 新增 `crates/strategy-runtime/tests/dcap_plugin_init.rs`（T5a + T6 插件面，5 例）

| 例名 | 场景 | 钉死的口径 |
|---|---|---|
| `t5a_plugin_effective_windows_follow_normalization` | 4 组非单调 n（26/26/26、2/10/10、60/26/8、20/20/20），跑 90 根后读 `save().winS/winM/winL` 长度 | §2/§3：`n_m'=max(n_m,n_s+1)`、`n_l'=max(n_l,n_m'+1)`（**顺序归一**）⇒ 生效值 (26,27,28)/(2,10,11)/(60,61,62)/(20,21,22)；且 `n_s<n_m'<n_l'` |
| `t5a_plugin_normalization_is_idempotent_and_bitwise_deterministic` | 非单调 vs 已归一三元组逐 bar 分数；两个独立实例同参数 | T5a 幂等（f(f(x))=f(x)）+ 确定（同输入逐位同输出） |
| `t5a_plugin_windows_do_not_drift_across_bars` | bar 40 与 bar 120 的窗口容量 | §3/§5：归一化**只在 `init` 一次**，`on_bar` 不得反复归一化（容量恒为 (8,9,10)） |
| `t6_plugin_all_lines_insufficient_returns_exactly_50_and_no_log_noise` | `smooth=1,m=3,n_s=5` 前 6 根；`smooth=0` 前 4 根 | §3/§5⑤：三线全不足 → **恰好 50.0**；§9：**无 `ctx.log` 噪声**；并带反向哨兵（更长后必须出现 ≠50） |
| `t6_plugin_insufficient_lines_are_excluded_from_n` | 只有 s 线够（smooth=0 与 smooth=1 各一） | §3/§5④：不足的线**不入 N** ⇒ 分数 = N=1 口径（`50−50·per_s`），**且 ≠ N=3 口径**（含口径差 >1e-6 的可鉴别性自检） |

### 3.2 新增 `crates/strategy-runtime/tests/dcap_plugin_replay.rs`（T7，3 例）

| 例名 | 场景 | 钉死的口径 |
|---|---|---|
| `t7_replay_continuation_scores_bit_equal` | 2 数据集（synth64、真实 518880 M15 64 根）× 2 split（20、60）：连续跑 vs 中途 `save()`→新实例 `load()`→续跑 | T7：「恢复后**位级**相等」；同时自检 split 前重合段位级相同（夹具确定性） |
| `t7_selftest_missing_save_field_is_detected` | 内存变异 `save()` 删 `winS` / `tailS` | 03-test-plan T7「若 `save/load` 漏掉任一窗口/尾窗元素 ⇒ 必须红」+ P2 要求「T7 必须真红过一次」（判据有鉴别力） |
| `t7_channel_probe_channel_is_not_bit_exact` | (a) `serde_json` 十进制解析 vs `str::parse`；(b) 真实 `QuickJsRuntime` save→load 现场；(c) dcap 真实快照全浮点往返 | T7 的**前置条件**：平台状态通道必须位级保真；否则任何插件实现都不可能稳定为绿 ⇒ 架构级问题 |

### 3.3 修改 `crates/strategy-runtime/tests/dcap_cross_runtime.rs`（+1 例，T5a 跨运行时）

| 例名 | 场景 | 钉死的口径 |
|---|---|---|
| `t5a_cross_runtime_nonmonotonic_params_bit_equal` | 4 组非单调参数样例，插件 `on_bar` ⟷ 前端 `dcapScore`，插件 CORE ⟷ 前端 `computeDcapSeries`/`dcapRoi` | §4 铁律 5：归一化在 **CORE 内** ⇒ 非单调参数下两侧必须逐位一致（任一侧漏归一即红） |

> 注：本用例今日**为绿**（两侧当前都未归一 ⇒ 结果仍一致），它是**一致性回归护栏**而非 Red 驱动；
> 真正钉死「归一化存在」的是 §3.1 的 T5a-1 与 §3.4 的 T5a-a/b。

### 3.4 新增 `web/src/features/indicators/dcapNormalize.test.ts`（T5a 前端入口，5 例）

| 例名 | 场景 | 钉死的口径 |
|---|---|---|
| `T5a-a` | 4 组非单调三元组 `computeDcapSeries` vs 已归一三元组（smooth=1, r≠1） | §2 + §4 铁律 5：前端入口同口径归一（逐位） |
| `T5a-b` | (3,3,3)+m=2 的三线首值下标 | 归一后为 `n_i+m−2` = 3/4/5，且三线互不相同（**独立佐证**：排除「两侧都没归一 ⇒ 都相等 ⇒ 假绿」） |
| `T5a-c` | `f(raw)` ≟ `f(normalized)` ≟ `f(f(normalized))` | 幂等 |
| `T5a-d` | 同输入重复调用（中间插入另一组参数） | 确定 / 无全局状态 |
| `T5a-e` | `smooth=0`：raw(4,4,4) ≟ norm(4,5,6) | 归一化与平滑开关**正交**（smooth=0 不得减配） |

### 3.5 新增 `web/src/features/indicators/dcapInsufficient.test.ts`（T6 前端逐线，4 例）

| 例名 | 场景 | 钉死的口径 |
|---|---|---|
| `T6-a` | n=(3,5,8), m=4, smooth=1 | 首值下标**逐线** = `n_i+m−2` = 5/7/10；三线互不相同；s 严格早于 l（**不得用 `n_l` 一刀切**） |
| `T6-b` | 边界表 `n−1`/`n`/`n+m−2`/`n+m−1`，三条线各测一遍 + 有值后不回退 | §3 数据不足行（逐线各按自己的 `n_i`） |
| `T6-c` | `smooth=0`：`n_i−1` → null、`n_i` → 有值 | 平滑关闭时的数据不足边界 |
| `T6-d` | `dcapRoi`：`<n` → null、`=n` → 有值、空序列 → null、`close=0` → null 且**不抛错** | §5 异常路径（除零/非法价按数据不足，不得抛错） |

### 3.6 修改 `crates/strategy-core/src/reference.rs`（T12，1 改 + 1 增）

| 例名 | 变更 | 钉死的口径 |
|---|---|---|
| `reference_plugins_match_builtin_order` | `BUILTIN_ORDER` 7→8（追加 `"dcap"`）、`len 7→8` | T12：清单第 8 条 + 顺序 |
| `t12_dcap_registered_with_plugin_abi_and_core_sentinels`（**新增**） | 取 `id=="dcap"` 条目，断言 `PARAMS_SCHEMA`/`function init`/`function on_bar`/`function save`/`function load` 与 `DCAP CORE BEGIN/END` 哨兵齐备；全表 id 唯一 | T12 + §5（ABI 钩子）+ ADR-021 D4（镜像哨兵锚点） |

> 显示名**不**属权威口径（§8 裁决 12 只钉指标名与三线字段）⇒ 只断言非空，不臆造文案。

### 3.7 修改 `crates/application/tests/strategy.rs`（T12，1 改）

| 例名 | 变更 | 钉死的口径 |
|---|---|---|
| `seed_reference_plugins_seeds_12_and_is_idempotent`（原 `…_seeds_11_…`） | `seeded 11→12`、`catalog.len() 11→12`、`(n_strategy,n_template) (7,4)→(8,4)` | T12：播种计数 + 幂等（第二次 `(0,0)`）保持不变 |

---

## 4. 边界与异常用例（本批覆盖）

- n 三元组的**全部单调性失败形态**：全相等、`n_s==n_l`、`n_m==n_l`、完全逆序；
- 数据不足的**四种边界**（`n−1`/`n`/`n+m−2`/`n+m−1`）× 三条线；
- 三线全不足 → 50 且**无日志**；
- `smooth=0` 时 `m` 越界/忽略的确定性（T5a 表内：由 T5a-e 的逐位直通间接覆盖）；
- 非法价（`close=0`）→ 按数据不足处理且不抛错（T6-d）；
- 单参数越界（`n=1/251`、`r=0.49/2.01`、`m=0/61`…）**不由插件断言**（ABI §1 NIT-6：单参数 `min/max`
  是消费方职责）⇒ 留待 T5b（P3 配置端点）与平台 `fill_and_validate_params`。

## 5. 覆盖目标

| 目标 | 状态 |
|---|---|
| T5a（插件面 3 例 + 前端面 5 例 + 跨运行时 1 例） | 设计完成；插件面/前端面红，跨运行时为绿（护栏） |
| T6（插件面 2 例 + 前端面 4 例） | 设计完成；**当前全绿**（P1 的 CORE 已正确实现数据不足语义） |
| T7（重放 1 例 + 哨兵 1 例 + 通道探针 1 例） | 设计完成；重放/哨兵绿，**通道探针红（架构级）** |
| T12（strategy-core 2 例 + application 1 例） | 设计完成；**全红**（清单仍 7/11） |

## 6. 已知口径缺口（供架构师确认，不影响本批可测性）

1. **`02-spec.md` §10 的 CORE 代码块尚无 `normalizeParams`**：§2/§4 铁律 5 要求
   「`normalizeParams(p)` 属 CORE，插件 `init` 与前端 `computeDcapSeries`/`dcapScore` 入口都调用它」，
   但 §10.1/§10.2 两个 `file=` 块里目前没有该函数（P1 产物里也没有）。
   ⇒ 本批 T5a 断言**只依赖行为可观测**（窗口容量 / 逐位等价 / 首值位置），**不依赖函数名**，
   故该缺口不会让测试失去鉴别力；但实现阶段需同时改 §10 块 + 重跑 tangle（否则 T3 镜像/T4 会飘）。
2. **`dcapScore(values, th)` 无 params 形参**，故「`dcapScore` 入口调用 `normalizeParams`」在签名上
   不可直接落地；本批只钉 `computeDcapSeries`（其输出即 `dcapScore` 的输入，归一化在此生效）。

## 7. 判据鉴别力自检（本批全部实测，非声明）

| 判据 | 自检方式 | 结果 |
|---|---|---|
| T7 位级判据 | 内存变异删 `save()` 的 `winS` / `tailS` | 两处**均被抓到**（红） |
| T6-1 N 语义 | 断言 `≠ N=3 口径` + 口径差 `>1e-6` | 通过（口径差足够大） |
| T6-2 恒 50 | 断言更长序列必须出现 `≠50` | 通过 |
| T5a 跨运行时 | 样例必须真非单调（前置断言） | 通过 |
