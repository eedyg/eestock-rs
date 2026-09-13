# dcap 指标 —— T1/T2/T3/T4 测试设计（P1-A，Red 阶段）

- 报告自身路径：`tester/design/012_dcap_t1_t4_red_design.md`
- 权威口径：`design/14-dcap-indicator/{01-adr.md, 02-spec.md, 03-test-plan.md, 04-implementation-plan.md}`
- 阶段：P1-A（**先写失败测试**：T1/T2/T3/T4 的 Red 态）
- 被测产物（当前**均不存在**，故本批测试**必须红**）：
  - `web/src/features/indicators/dcap.ts`（entangled 生成，ADR-021 D2）
  - `crates/strategy-core/reference-plugins/dcap.js`（entangled 生成，ADR-021 D2）
- 执行报告（Red 证据）：`tester/test/039_dcap_t1_t4_red_execution.md`

---

## 1. 新增测试文件与运行方式

| 文件 | 覆盖 | 运行命令 |
|---|---|---|
| `web/src/features/indicators/dcap.test.ts` | T1（T1-a…T1-f，6 例）、T2（T2-a…T2-d，4 例） | `cd web && npx vitest run src/features/indicators/dcap.test.ts` |
| `web/src/features/indicators/dcapMirror.test.ts` | T3（负例 8 例 + 真实产物 3 例） | `cd web && npx vitest run src/features/indicators/dcapMirror.test.ts` |
| `crates/strategy-runtime/tests/dcap_cross_runtime.rs` | T4（跨运行时 2 例 + 样例集守卫 1 例）+ 插件侧 T2（1 例）+ 自检 1 例 | `cargo test -p strategy-runtime --test dcap_cross_runtime -- --nocapture` |

合计 **26 例**（10 + 11 + 5）。

落点理由：

- T1/T2/T3 走 vitest（仓库既有前端测试约定：`web/src/**/*.test.ts`，`npm test` = `vitest run`）。
- **T4 落 `crates/strategy-runtime/tests/`**：该 crate 已含 rquickjs 测试基建（`QuickJsRuntime` + 直接
  `rquickjs::Context`），**不新增依赖、不改任何 Cargo.toml / Cargo.lock**；两个产物按仓库相对路径
  **只读**读取，用例所需临时文件一律写 `/tmp`（用完即删）。已核对：现有 `strategy-runtime` 测试
  （unit 14 + `contract.rs` 13）在本批新增后**全绿**不变。

---

## 2. 等价层级（先定「什么必须逐位、什么只能容差」）

| 层级 | 适用 | 本批落点 |
|---|---|---|
| **容差 `|Δ| ≤ 1e-12`** | T1（`r=1 ≡ 遗留 DCAP`、真实数据冻结回归） | `dcap.test.ts` T1-* |
| **逐位（IEEE754 位串）** | T2（`smooth=0 ≡ raw`）、T3（字节镜像）、T4（跨运行时） | `dcap.test.ts` T2-*、`dcapMirror.test.ts`、`dcap_cross_runtime.rs` |

设计依据（实测，本批新增证据）：

- `closes=[100,90,95], n=3, r=1`：本式 `0.0018518518518517713` vs 遗留式 `0.0018518518518519933`（差 2.2e-16）；
- `r=1.2`：按 `02-spec §0` 字面规则（`w=1` 自最新往回 `w /= r`，按此序累加）得 `0.0045787545787545625`；
  该节给出的冻结值 `0.0045787545787547845` 对应**另一种合法排布**（差 2.2e-16）。
  ⇒ `r≠1` 的值对「表达式/累加序」在 1–2 ulp 内敏感，T1 的 1e-12 容差正是为此；
  **T4 因此不得冻结任何一侧的位，必须两侧同时实测比对**。
- 真实数据抽样（n=60, r=1）：本式 `-0.011674411920738925` vs 遗留式 `-0.011674411920738814`（差 1.1e-16）。

---

## 3. 冻结数据（真实 15m 抽样，数据面**只读**）

命令（只读 SELECT，未写库、未启动任何服务、未触碰生产线/数据面写路径）：

```
psql "postgres://eestock:eestock@127.0.0.1:5433/eestock" -At -c "SET extra_float_digits=3;
  SELECT ts::text||'|'||close::text FROM kline_accurate_15m
  WHERE code='518880' ORDER BY ts DESC LIMIT 64"
```

区间：`2026-09-04 03:30+00` → `2026-09-11 07:00+00`（64 根 M15 close，oldest→newest 写入测试）。

冻结值（容差 1e-12；两式互差 ≤1e-15，故任何合法实现均在容差内）：

| 用例 | 参数 | 冻结值 |
|---|---|---|
| T1-d | n=60, r=1.0 | `-0.011674411920738925` |
| T1-d | n=26, r=1.0 | `-0.007990502969230762` |
| T1-d | n=8, r=1.0 | `0.0008139126723081258` |
| T1-d | n=60, r=1.2 | `-0.0022963360597847426` |
| T1-d | n=26, r=1.2 | `-0.0022123890643179767` |
| T1-d | n=8, r=1.2 | `0.0004516499227451565` |
| T1-e | 遗留式 n=60, r=1 | `-0.011674411920738814` |
| T1-f | 三线末根（n 8/26/60, r=1, smooth=1, m=3） | `s=0.00028966107001308455, m=-0.008571441774230748, l=-0.012349115526361643` |
| T1-f | 同上但 r=1.2 | `s=0.00018787644132038187, m=-0.0029321814752066855, l=-0.0030166951270530484` |
| T1-f | 首次有值位置 | `s=9, m=27, l=61`（= n_i + m − 2） |

> 冻结值由 tester 独立实现（IEEE754 f64，windows = **最近 n 根**，newest→oldest）算出，并在
> **Python 与 Node(V8) 两侧交叉核对一致**（差异 ≤1e-15）。另在 `/tmp` 沙箱替身上实测**可复现为绿**（见 §6）。

---

## 4. 测试用例清单（名称 → 钉死的口径）

### T1（`dcap.test.ts`，容差 1e-12）

| 用例 | 场景 | 钉死口径 |
|---|---|---|
| `T1-a` | `[100,90,95], n=3, r=1` | 本指标 ≡ 遗留 DCAP ≡ `0.0018518518518517713`；遗留式 ≡ `0.0018518518518519933` ⇒ **`r=1` 时恒等于遗留 DCAP**（02-spec §1.2） |
| `T1-b` | 同输入 `r=1.2` | 冻结值 `0.0045787545787547845`（容差 1e-12）；且**必须偏离**遗留式（防「`r` 参数被忽略还静默相等」） |
| `T1-c` | 可用 bar < n / 空 / 单根 | 数据不足 ⇒ `null`，不抛错（02-spec §3） |
| `T1-d` | 真实 64 根 × 6 组 (n,r) | 口径冻结（单线 ROI），含 **r≠1** 两组 |
| `T1-e` | 真实 64 根, n=60, r=1 | `r=1 ≡ 遗留 DCAP` 在**真实数据**上成立 |
| `T1-f` | 真实 64 根，三线默认参数 smooth=1,m=3 | 末根三线冻结值 + **首次有值位置 = n_i + m − 1 根**（各自 n_i，不得用 n_l 一刀切） |

### T2（`dcap.test.ts`，逐位）

| 用例 | 场景 | 钉死口径 |
|---|---|---|
| `T2-a` | 4 组输入（含空序列）× `smooth=0` vs `smooth=1,m=1` | **两条路径逐位相同**：`smooth=0` 与 `m=1` 都必须直通原始值（02-spec §3「开关关闭」/§8 裁决 6） |
| `T2-b` | 20 根、`r_s=1, r_m=1.2, r_l=0.9`、`smooth=0` | 每 bar 每条线 === 独立 `dcapRoi(closes[..=i])` ⇒ **禁止增量累加（running sum）**、**禁止未来函数**；null 位置精确对齐（index 0 三线全缺；s→1、m→2、l→3） |
| `T2-c` | `smoothSeries(raw, 0/1/0)`；`m=3` 平滑非退化 | `smooth=0` / `m<=1` ⇒ 直通原值；且平滑分支**不是死代码**（否则 T2-a/b 变平凡） |
| `T2-d` | **哨兵**：可注入等价实现 | 判据必须能判红：①合规直通 ⇒ 不报红（防判据恒红）；②`×1.0000000001` ⇒ 报红；③`+Number.EPSILON`（1 ulp 级）⇒ 报红；④吞前导 null（位置错位）⇒ 报红；⑤**生产 `smoothSeries` 在同一判据下必须不报红**（真断言与哨兵共用同一谓词） |

### T3（`dcapMirror.test.ts`，逐字节）

| 用例 | 场景 | 钉死口径 |
|---|---|---|
| `T3-neg-0..7` | 8 例：正例对照；删 ts 侧 BEGIN；删 js 侧 END；哨兵重复；CORE 内翻 1 字节；清空区间；多 1 字节；哨兵顺序颠倒 | 检查器 **fail-closed 有鉴别力**（全部走 `/tmp` 合成夹具副本，**不依赖真实产物**，当前即全绿） |
| `T3-real-1` | 读两份真实产物取哨兵区间 | **逐字节相同**（ADR-021 D4）；哨兵各恰好 1 个；区间 ≥200 字节（防「空区间假绿」）；两侧前缀不同（防误读同一文件） |
| `T3-real-2` | 真实产物原样复制到 `/tmp` | 正例对照：差异必须归因于变更而非路径 |
| `T3-real-3` | 全程 sha256 复核 | 负例过程**不得改动仓库内真实产物** |

### T4（`dcap_cross_runtime.rs`，逐位，QuickJS × V8）

| 用例 | 比较对象 | 钉死口径 |
|---|---|---|
| `t4_sample_set_meets_spec` | 样例集守卫 | ≥20 组且 **≥5 组 r≠1**；全部满足 `n_s<n_m<n_l` 与 §2 范围（否则 T4 规模不足会「假绿」） |
| `t4_cross_runtime_scores_bit_equal` | 插件 `on_bar` 0–100 分 ⟷ 前端 `dcapScore(computeDcapSeries(...)[i], th)` | 评分跨运行时**逐位**相等（24 组样例 × 每根 bar） |
| `t4_cross_runtime_raw_series_bit_equal` | 插件 CORE `computeDcapSeries`/`dcapRoi`（QuickJS）⟷ 前端同名导出（V8） | 三线原始值 + 单线 ROI 逐位相等、null 对齐 |
| `t2_plugin_smooth_off_equals_m1_bit_equal` | 插件 `on_bar`（`smooth=0`）⟷（`smooth=1, m=1`） | 插件侧同 T2 口径（关平滑 ≡ 原始） |
| `t4_selfcheck_*` | `/tmp` 沙箱替身 + 1 ulp 比较器 | **断言有效性自证**：①比较器能识别 1 ulp；②两侧逐字节同源 ⇒ 不得报差异；③替身 ROI 被 `×1.0000000001` 污染 ⇒ 必红；④替身 `smooth=0` 支被近似污染 ⇒ T2 判据必红 |

### 样例集（24 组，r≠1 共 11 组）

手算 3 根（r=1 / 1.2 / 混合 0.5-1-2）×5；边界（空、单根、恰好 `n_s`、`l` 线首次有值前后一根）×5；
合成 20 根（含 r=1/1.05-1.2-2.0/0.9-1.1-1.5/0.5-0.6-0.75）×5；真实 64 根（默认/r 混合/m=1/th=0.001 极敏）×5；
大窗口（64 根 m=10、250 根 r=2/0.5、300 根 r_m=1.001）×4。

---

## 5. Mock / Stub 策略

| 需求 | 做法 |
|---|---|
| 「近似直通必红」哨兵（T2） | 测试内**可注入等价实现**（`compliant` / `≈×1+1e-10` / `+1ulp` / 吞前导 null），与真断言**共用同一谓词**；生产代码零改动 |
| T3 负例不得碰真实产物 | 复制到 `os.tmpdir()/dcap-mirror-*` 后做删哨兵/翻字节/清空/增字节，`afterAll` 清理；sha256 复核仓库产物未变 |
| T4 断言有效性自证 | `/tmp` 沙箱替身（`.ts` = CORE + `export`，`.js` = CORE + `PARAMS_SCHEMA/init/on_bar`），在**同一条比较管线**上做正例对照与两种污染（EPS / SMOOTH_OFF） |
| T1/T2 断言可满足性 | `/tmp` 沙箱参考实现（按 02-spec §1/§3 写）驱动同一批测试文件 ⇒ 实测全绿（证明冻结值可达、哨兵有界） |
| 无 mock 框架 | 全部纯函数/纯脚本，无网络、无 DB、无时钟依赖 |

---

## 6. 边界与异常用例覆盖

- 数据不足：`[]`、单根、恰好 `n_s`、`n_l + m − 2`（仍 null）、`n_l + m − 1`（首次有值）；
- 空窗口 ⇒ 三线全缺 ⇒ 插件中立 50（T4 样例含 `empty_closes` / `hand3_smooth1_m3_allnull`）；
- `m=1`（等价关平滑）与 `smooth=0` 双路径；
- `r` 端点：0.5 / 2.0 / 1.2 / 1.5 / 1.75 / 1.001（近 1，测权重累乘精度）；
- `th` 端点：0.001（最大灵敏度，含饱和路径）与 0.5；
- 最大规模：`n_l=250`（规格上限）+ 300 根序列（超出窗口的历史参与前缀）。

**未纳入本批**（避免带未定口径进测试）：`close ≤ 0` 的除零语义在 02-spec 只对插件侧（§5 异常路径）定死、
前端模块的对应行为未明确 ⇒ 若强行断言会以测试代替裁决，故留作后续任务/口径澄清项（见执行报告「残余风险」）。

---

## 7. 覆盖目标

- T1–T4 全部条款可机械判定（无人工目视项）；
- 逐位断言均落在 **IEEE754 位串**（前端 `DataView` 16 位 hex；Rust `f64::to_bits`），非 `===` 近似语义；
- T2/T3/T4 的每条断言都有**反向哨兵**证明其有鉴别力（T1 用规格给定容差，其鉴别力来自「必须偏离遗留式」的 T1-b 断言）；
- 反向门禁：T3/T4 断言按 QA checklist 要求**不得** `skip`/`#[ignore]`（本批无 skip）。

---

## 8. 关键设计决策（含实测依据）

1. **T4 用「实测 vs 实测」而非冻结黄金值**：`02-spec §0` 的累加序文字与该节 r=1.2 示例值在 1–2 ulp 上互不吻合
   （实测见 §2），冻结任一侧的位都会把「口径选择」伪装成「口径错误」。改为 V8(node 直接 import 生成的 `.ts`)
   × QuickJS(rquickjs 直接求值 CORE / `QuickJsRuntime` 跑 `on_bar`) 同输入实时比对。
2. **浮点传输一律十六进制位串**：实测 `serde_json::from_str::<f64>("57.329040578513684")` =
   `0x404caa1e006de2f7`，而正确舍入值（`str::parse`）为 `0x404caa1e006de2f8` ⇒ **serde_json 浮点解析非正确舍入**
   （差 1 ulp）。故：输入（closes/params）与输出（series/scores/roiByLine）全部走 16 位 hex；
   两侧共用同一段 `DataView` 助手；比较器遇到十进制 Number 直接 fail-closed 报错。
   （该 1 ulp 现象最初正是被本批的自检哨兵抓到的。）
3. **T2 的「未平滑原始 ROI」用 `dcapRoi` 独立复算**（而非 `smoothSeries` 自身），才能把 running-sum / 未来函数
   一并钉死；同时在真实数据上验证「首次有值位置 = `n_i + m − 1` 根」。
4. **T3 的负例与真实产物断言分离**：负例用合成夹具（现在就能绿，证明检查器有鉴别力），真实产物断言现在必红；
   这样 Red→Green 的每一步都有可核对的证据，而不是「一起红、一起绿」。

---

## 9. 前提与依赖（交下一步 coder 执行时需满足）

1. 两份产物由 `entangled tangle` 生成（改文档 → 生成，禁手改生成物；`check-tangle.sh` 兜底）；
2. **CORE 区间内需定义顶层函数** `dcapRoi` / `smoothSeries` / `computeDcapSeries` / `dcapScore`
   （与 02-spec §4 导出名同名）——T4 原始值比对依赖此契约；缺失时测试给出明确报错而非含糊 diff；
3. 插件侧 `on_bar` 需要 `PARAMS_SCHEMA/init/on_bar`（P2 包装层）；若 P1 只落 CORE，则 T4 的评分/插件 T2 两例
   保持红（属预期），原始值比对一例可先绿；
4. T4 需要 `node` 可执行（本仓 web 测试已依赖 node；环境无 node 时该测试以明确信息失败，不静默跳过）；
5. CORE 必须是**无类型注解**的 ES2015 子集（rquickjs 直接求值）；两份产物 CORE 逐字节相同（T3）。
