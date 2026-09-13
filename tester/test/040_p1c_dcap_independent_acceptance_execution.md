# P1-C —— dcap T1/T2/T3/T4 独立验收执行报告（不信 worker 自述）

- 报告自身路径：`tester/test/040_p1c_dcap_independent_acceptance_execution.md`
- 执行时间（UTC / CST）：2026-09-13 07:29–07:40Z / 15:29–15:40 CST
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
- 仓库提交（HEAD）：`8745fd52de446efc597e37dcd23cc74c27273dcd`
- 权威口径：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`
- 上游（先已读）：`tester/design/012_dcap_t1_t4_red_design.md`、`tester/test/039_dcap_t1_t4_red_execution.md`
- 被测产物（untracked，本轮生成）：
  - `web/src/features/indicators/dcap.ts` — sha256 `6cb2f1ef…216a83`（6689 B / 163 行）
  - `crates/strategy-core/reference-plugins/dcap.js` — sha256 `d83c65ed…237b862`（9763 B / 229 行）
- 本轮**未**修改任何实现/测试/文档（唯一动作是对产物的**临时移走→字节级还原**与**on_bar 临时改名→字节级还原**，
  两次均以 sha256 证明还原；见 §2/§1）。**未** `git add`/`commit`/`stash`；**未**起 8081/8082；
  **未**对数据面做任何写操作。**未做任何失败分析或修复**（tester 职责边界）。

---

## 0. 结论速览（P1 实际承诺：T1/T2/T3/T4-raw 必须绿）

| 套件 | 命令 | 逐例结果 | 退出码 |
|---|---|---|---|
| T1/T2（前端）`dcap.test.ts` | `cd web && npx vitest run src/features/indicators/dcap.test.ts` | **10 / 10 绿** | 0 |
| T3（镜像）`dcapMirror.test.ts` | `cd web && npx vitest run src/features/indicators/dcapMirror.test.ts` | **11 / 11 绿**（含 3 例真实产物） | 0 |
| T4（跨运行时）`dcap_cross_runtime.rs` | `cargo test -p strategy-runtime --test dcap_cross_runtime` | **5 / 5 绿**（含 raw 与 scores） | 0 |
| 门禁 | `./scripts/check-tangle.sh` | ✅ 一致 | 0 |
| web 全量回归 | `cd web && npx vitest run` | 50 files / 505 tests 绿 | 0 |
| strategy-runtime 全量回归 | `cargo test -p strategy-runtime` | unit 14 + contract 13 + dcap 5 绿 | 0 |
| 类型检查 | `cd web && npx tsc -b` | 绿（`@ts-nocheck` 生效） | 0 |

- **崩溃 / core dump：无**（`find -maxdepth 3 -name 'core*'` = 0；全部失败态均为断言/文件缺失，无 SIGSEGV/SIGABRT）。
- **允许红的两例实测为绿**（派单文档预期其因缺 P2 `on_bar` 包装层而红）——绿的原因**经独立核实成立**：
  worker 在 P1 一并落了 `on_bar` 完整 ABI 钩子，且两例对 `on_bar` 缺失**确有依赖**（见 §1）。
- 逐项验收结论见 §1–§7；**未发现不通过项**。

---

## 1. 三条测试命令逐例结果 + 两例「允许红」的性质核实

### 1.1 逐例（verbose）

```
dcap.test.ts（T1-a…T2-d，10 例，全绿）
  ✓ T1-a 手算 [100,90,95] n=3 r=1 ≡ 遗留 DCAP ≡ 0.0018518518518517713
  ✓ T1-b 手算 r=1.2 冻结值 0.0045787545787547845（容差）+ 必须偏离遗留式
  ✓ T1-c 数据不足 ⇒ null（不抛错）
  ✓ T1-d 真实 15m 冻结回归（n=60/26/8 × r=1.0/1.2）
  ✓ T1-e 真实数据 r=1 ≡ 遗留 DCAP
  ✓ T1-f 默认三线末根三值 + 首次有值位置 9/27/61
  ✓ T2-a smooth=0 ≡ (smooth=1,m=1) 逐位
  ✓ T2-b smooth=0 逐 bar === dcapRoi 独立复算（含 null 对齐）
  ✓ T2-c smoothSeries 直通契约 + 平滑分支非退化
  ✓ T2-d 哨兵：近似直通/1 ulp/吞前导 null 必红；生产函数不报红
dcapMirror.test.ts（T3，11 例，全绿）
  ✓ T3-neg-0…7（合成夹具：正例对照 / 删哨兵 / 哨兵重复 / 翻 1 字节 / 清空 / 多 1 字节 / 顺序颠倒）
  ✓ T3-real-1 两份产物 CORE 逐字节相同
  ✓ T3-real-2 /tmp 原样副本正例对照
  ✓ T3-real-3 负例过程后仓库产物 sha256 未变
cargo dcap_cross_runtime（5 例，全绿）
  ✓ t4_sample_set_meets_spec（24 组，r≠1 共 11 组）
  ✓ t4_selfcheck_comparator_teeth_one_ulp_and_sandbox_pipeline
  ✓ t4_cross_runtime_scores_bit_equal
  ✓ t4_cross_runtime_raw_series_bit_equal
  ✓ t2_plugin_smooth_off_equals_m1_bit_equal
```

### 1.2 两例「允许红」（scores / plugin-T2）为何是绿 —— 独立反证

派单文档预期 `t4_cross_runtime_scores_bit_equal`、`t2_plugin_smooth_off_equals_m1_bit_equal` 因依赖 P2 的
`on_bar` 包装层而保持红；worker 报告其实际为绿。**独立核实其确因 `on_bar` 存在而绿**：

- 结构性事实：插件产物含完整 ABI 钩子 `PARAMS_SCHEMA`(9 key) / `init` / `on_bar` / `save` / `load` + `dcapPushLine`。
- **反证（临时扰动 + 字节级还原）**：把产物 `function on_bar(ctx) {` 改名为 `on_bar_DISABLED` 后：
  - `t4_cross_runtime_scores_bit_equal` → `FAILED`：`插件实例化失败（sample=hand3_smooth0_r1）：… 缺少必需的全局函数 on_bar（ABI §1）`
  - `t2_plugin_smooth_off_equals_m1_bit_equal` → `FAILED`：同上
  - 还原后 `sha256 = d83c65ed…237b862` = 原值（`RESTORE_BYTE_EXACT`），两例复绿。
  ⇒ 两例的绿**真实依赖** `on_bar`，非「测试被削弱 / 断言空转」。
- 测试未被削弱的旁证：三个测试文件 mtime 均**早于** P1-B 起点（15:22）——
  `dcapMirror.test.ts` 15:08、`dcap_cross_runtime.rs` 15:14、`dcap.test.ts` 15:15；内容与 P1-A 交付一致。

---

## 2. 反向证据（防空跑）：移走产物 ⇒ 必红；还原 ⇒ 复绿

**做法**：`mv` 两份产物到 `/tmp/p1c_reverse/`（先记 sha256），跑测试，再 `mv` 回并复核 sha256（`mv` 保 mtime/权限）。

### 移走后（必红）

| 套件 | 结果 | 红的原因 |
|---|---|---|
| `dcap.test.ts` | `Test Files 1 failed (1)` / `Tests no tests`，exit=1 | `Failed to resolve import "./dcap"`（模块不存在） |
| `dcapMirror.test.ts` | `3 failed \| 8 passed (11)`，exit=1 | `T3-real-1/2/3` 红（产物缺失）；8 个负例仍绿（不依赖真实产物） |
| `dcap_cross_runtime` | `2 passed; 3 failed`，exit=101 | `t4_cross_runtime_scores_bit_equal` / `t4_cross_runtime_raw_series_bit_equal` / `t2_plugin_smooth_off_equals_m1_bit_equal` 全部 `插件产物 dcap.js 读取失败：…（No such file or directory）` |

### 还原后（复绿）

```
before.sha256 == after.sha256（两产物）  ⇒ SHA_MATCH=YES
web T1/T2 = 10 passed ; web T3 = 11 passed ; cargo T4 = 5 passed
./scripts/check-tangle.sh → CHECK_TANGLE_EXIT=0
```

⇒ 三条套件**确有鉴别力**（去掉产物即红），不存在空跑假绿。

---

## 3. 镜像体断言独立复做（自切区间，不引用 worker 说法）

**方法**：自写 python 按 `// === DCAP CORE BEGIN ===` / `// === DCAP CORE END ===` 切两份产物区间比较。

```
ts: begin=1 end=1   CORE offset=1499  bytes=4884  sha256=dea7d4388d9ea3d130e8279405d0171d5343b33351562b72f166458d6ae708b0
js: begin=1 end=1   CORE offset=2745  bytes=4884  sha256=dea7d4388d9ea3d130e8279405d0171d5343b33351562b72f166458d6ae708b0
BYTE_IDENTICAL= True   LEN_EQUAL= True   PREFIX_DIFFERS= True   first_diff_index= None   num_diffs= 0
CORE token 命中（两侧均 0）：Math.pow / Math.exp / Math.log / import( / export( / ': number' / ': string' / number[] / interface
```

- **字节数一致、diff 为空**（自证，非引用 worker）。
- **口径差异说明（非缺陷）**：worker 报告称「CORE 4883 B，sha256 `78c175d3…604165`」。实测其 4883 =
  我切法的 4884 **去掉 BEGIN 后的首个换行**（我保留之）。用「去掉首换行」的口径复算得
  `sha256=78c175d3…604165`（与 worker 完全一致）⇒ 仅切片边界约定相差 1 字节，**逐字节相同的结论不变**。
  T3 测试用的是我这种口径（`subarray(begin+len(BEGIN), end)`），与断言自洽。

**/tmp 单字节扰动（不碰仓库真产物）**：

```
pristine 副本           → GREEN
/tmp js 副本 CORE 翻 1 字节 → RED: first diff at CORE offset 142: ts=0x73 js=0x74
/tmp ts 副本 CORE 翻 1 字节 → RED: first diff at CORE offset 142: ts=0x74 js=0x73
扰动后仓库两产物 sha256 未变（TS/JS = True/True）
```

---

## 4. 浮点铁律逐条核（读文 + grep）

CORE 区间（自切，见 §3）内：

| 铁律 | 证据 | 结论 |
|---|---|---|
| 无 TS 注解 / `import` / `export` | CORE 内 `import`=0、`export`=0、`: number`/`: string`/`number[]`/`interface ` 全 0；顶层非注释语句**只有** 4 个 `function` 声明（`dcapRoi` / `smoothSeries` / `computeDcapSeries` / `dcapScore`） | ✅ |
| 无 `Math.pow` / `Math.exp` / `Math.log` | 三者在两侧 CORE 命中 0；CORE 内 `Math.*` **仅** `Math.floor`（用于整数化 n/m） | ✅ |
| `r` 的幂用迭代乘法 | `var a = 1; for (var k=0;k<nn;k++){ weights.push(a); a = a * r; }` | ✅ |
| 非增量累加（每 bar 完整重算） | CORE 顶层**无状态变量**（4 个函数声明，权重/和/窗全为函数内局部量，每次调用重建）；`computeDcapSeries` 逐 index `var prefix = closes.slice(0, i + 1);` 再调 `dcapRoi` 完整复算 ⇒ 无 running sum、无未来函数 | ✅ |
| 累加顺序 = spec §4 第 3 条**两步法** | ① 升序迭代乘法（`weights[0]=1` 最旧 … `weights[nn-1]=r^(n-1)` 最新）；② `for (var j=nn-1; j>=0; j--)` 自最新往回累加 `sumA += weights[j]`、`sumAP += weights[j]/p` ⇒ 即 `k=n→1`；**未**用「w 从 1 起每步 `/= r`」的倒数写法 | ✅ |
| SMA 窗口局部 | `smoothSeries` 对每个 bar 用局部滑窗（push/shift 后**窗口内求和** `sum = sum + win[j]`），非跨 bar 递推；插件侧 `dcapPushLine` 维护长度 ≤ m 的尾窗后调 `smoothSeries` 取末元素 ⇒ 与前端整段 SMA 同值（窗口局部 ⇒ 起算点无关） | ✅ |

> 口径提示（非缺陷）：`03-test-plan.md §0` 的括注把累加序描述为「`w` 从 1 起每步 `/= r`」，而
> `02-spec.md §4` 明文钉死的是**两步法**并**显式排斥**「`/= r`」写法。实现与 **spec §4** 一致（spec 是权威），
> 且 T1 用 1e-12 容差、T4 走「实测 vs 实测」不冻位 ⇒ 该 1–2 ulp 差异不影响任何断言。

---

## 5. 数值独立复算（python 自算 + node 读产物实算）

**我的 python 两步法**（严格照 spec §4）：

| 用例 | 我的值 | 位串 | 冻结值 |
|---|---|---|---|
| `closes=[100,90,95] n=3 r=1` | `0.0018518518518517713` | `3f5e573ac901e400` | `0.0018518518518517713`（T1-a） |
| `closes=[100,90,95] n=3 r=1.2` | `0.0045787545787547845` | `3f72c12c12c12d00` | `0.0045787545787547845`（T1-b） |
| 遗留式 `close/HM−1`（n=3） | `0.0018518518518519933` | `3f5e573ac901e800` | `0.0018518518518519933`（T1-a） |
| 「前进累加（k=1→n）」变体 r=1.2 | `0.0045787545787545625` | `3f72c12c12c12c00` | 与两步法差 `2.220e-16` |

**产物实际输出**（`node --experimental-strip-types` 直接 import 生成的 `dcap.ts`）：

```
r=1   dcapRoi=0.0018518518518517713  bits=3f5e573ac901e400
r=1.2 dcapRoi=0.0045787545787547845  bits=3f72c12c12c12d00
```

⇒ 产物输出与我独立复算**逐位相同**，且 = spec §4 两步法冻结值。

**容差覆盖核验**：
- 不同累加序差异 `|两步法 − 前进累加| = 2.220e-16` ≪ `1e-12` ⇒ T1 容差**充裕覆盖**。
- `|两步法 − 遗留式| = 2.220e-16` ≪ `1e-12` ⇒ T1-a/T1-e 口径成立。
- 产物输出落在容差内（偏差 0）。

**真实数据补充复算**（我的 python vs 测试冻结值）：`n=60 r=1.0` 精确相等 `-0.011674411920738925`；
`n=26 r=1.0` 精确相等 `-0.007990502969230762`；`n=8 r=1.0` 精确相等 `0.0008139126723081258`；
`n=60 r=1.2` 我 `-0.0022963360597848537` vs 冻结 `-0.0022963360597847426`（差 `1.1e-16`，容差内）；
T1-f 三条线末根值与**首次有值位置 9 / 27 / 61 全部精确相等**。

---

## 6. filedb 刷新守卫复核（本轮新增风险点）

**方法**：读 `.entangled/filedb.json`（v2.4.3，146 targets），用 `git cat-file -e HEAD:<path>` 判定 tracked，
再逐文件比对「工作树内容 sha256」与「`git show HEAD:<path>` sha256」。

```
total targets: 146
tracked: 144      # 既有生成物
untracked: 2      # 本轮新增：crates/strategy-core/reference-plugins/dcap.js, web/src/features/indicators/dcap.ts
targets with HEAD blob: 144; identical: 144; different: 0
```

⇒ **144/144 既有生成物与 git HEAD 逐字节相同**（比派单要求的「抽查 ≥20」更强，全量核了 144）。
worker「既有 144 个生成物 sha256 前后一致」**可复现、成立**。

---

## 7. 工作树收敛

- `./scripts/check-tangle.sh` → `CHECK_TANGLE_EXIT=0`（design 与生成物一致，工作区未被修改）。
- `git status --porcelain | grep -vE '^\?\?'` → **0 行**（无任何 tracked 文件被修改）；
  `git diff` / `git diff --cached` 均空；**staged = 0**。
- `find -newermt '2026-09-13 15:20:00'`（排除 `.git`/`target`/`node_modules`）→ 本轮实际改动仅：

```
2026-09-13 15:25:37 ./design/14-dcap-indicator/02-spec.md          # 事实源（+§10 两块）
2026-09-13 15:26:00 ./web/src/features/indicators/dcap.ts          # 产物
2026-09-13 15:26:00 ./crates/strategy-core/reference-plugins/dcap.js # 产物
2026-09-13 15:26:00 ./.entangled/filedb.json                       # 刷新（gitignore）
2026-09-13 15:26:29 ./.entangled/filedb.lock                       # tangle 锁
2026-09-13 15:28:44 ./coder/report/154_dcap_p1b_core_dual_product_green.md
```

  （P1-A 的测试文件 15:08–15:15、tester 报告 012/039 15:15–15:17 均**早于**本窗口，符合预期。）

- **未改动**项复核：
  - `grep -n dcap crates/strategy-core/src/reference.rs` → 无匹配（**未**把 dcap 接入播种清单）；
    `BUILTIN_ORDER: [&str; 7]` 仍为 7。
  - `grep -rn dcap crates/*/src/` → 无匹配（**未**动 ABI/引擎/`clamp_score`/`aggregate`/`classify`）。
  - 60-40 阈值 / `ExecutionPolicy` / `/api/config/*`：`git diff` 为空 ⇒ 无 tracked 改动。

- 产物权限/内容：`0600` 权限、sha256 与 tangle 产物一致；第二次 `entangled tangle` 复核由 check-tangle 沙箱覆盖。

---

## 8. 崩溃 / core dump / 覆盖率

- 崩溃：**无**；core dump：**无**（失败态均为断言/文件缺失类）。
- 覆盖率工具：本仓未配置；本轮为口径门禁测试，不做行覆盖统计。
- 无 skip / `#[ignore]`。

## 9. 残余风险 / 交架构师追认项（不阻塞 P1 验收）

1. **`// @ts-nocheck`**（`.ts` 包装层，哨兵之外）：worker 为满足「CORE 无类型注解」与「`tsc -b` 严格模式绿」
   的折中。实测 `npx tsc -b` exit=0；代价是导出函数推断类型为 `any`。**待架构师追认**（或改选替代方案）。
2. **P2 前置被提前**：worker 在 P1 落入了 `on_bar/save/load` 完整包装层（本为 P2 内容），使得原本「允许红」
   的两例转绿。与 `04-implementation-plan.md` §2 P1 口径存在偏差，但**效果更严（更多绿）**，且未改测试、
   未接入 `reference.rs` ⇒ 不构成本轮验收不通过项，仅留痕。
3. **spec §4 vs 03-test-plan §0 累加序括注不一致**（措辞层面）：实现以 **spec §4 两步法**为准；
   建议后续统一 §0 括注，避免读者误按「`/= r`」写则套。
4. `close <= 0` 的前端口径（spec §4 未定死、§5 只定死插件侧）：实现两端统一按「数据不足 ⇒ null」处理，
   不影响镜像/跨运行时断言，属口径澄清项。
5. `save/load` 尚未被 P2 的 T7 round-trip 测试覆盖（本轮仅 ABI 完整性所需）。

---

## 10. 逐项结论

| 项 | 结论 |
|---|---|
| 1 三条命令逐例 + 两例允许红性质 | **PASS**（26/26 绿；两例确依赖 `on_bar`，经临时改名反证） |
| 2 反向证据（移走产物 ⇒ 红；还原 ⇒ 绿） | **PASS**（sha256 字节级还原，check-tangle=0） |
| 3 镜像体独立复做 + /tmp 单字节扰动 | **PASS**（4884 B 逐字节相同、diff 空；扰动必红且不碰仓库） |
| 4 浮点铁律逐条 | **PASS**（无注解/import/export、无 pow/exp/log、完整重算、两步法、SMA 局部） |
| 5 数值独立复算 | **PASS**（产物 = 我的 python 两步法，逐位相同；容差覆盖 2.2e-16） |
| 6 filedb 刷新守卫 | **PASS**（144/144 既有生成物与 HEAD 逐字节相同） |
| 7 工作树收敛 | **PASS**（无 tracked/staged 改动；仅预期文件；未接 reference.rs） |

**最小修正建议**：无（未发现不通过项）。可选后续：统一 `03-test-plan.md §0` 累加序括注为 spec §4 两步法；
架构师对 `@ts-nocheck` 与「P2 前置」两项追认。

**VERDICT: PASS**
