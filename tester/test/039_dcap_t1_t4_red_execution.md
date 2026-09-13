# dcap 指标 —— T1/T2/T3/T4 测试执行报告（P1-A，**Red 态**）

- 报告自身路径：`tester/test/039_dcap_t1_t4_red_execution.md`
- 执行时间（UTC）：2026-09-13T07:15Z 前后（下文每条命令附原始输出片段）
- 仓库提交：`8745fd5 docs(report): 152 ADR-020 视口口径实施报告 + 153 重建重启取证`
- 阶段：P1-A（先写失败测试）。被测产物**尚不存在** ⇒ 本批测试**按设计为红**
- 本轮**未修改任何生产代码/接口/文档块/生成物**；**未** `git add` / `git commit` / `git stash`；
  **未**启动任何服务；**未**对数据面做任何写操作（仅 1 条只读 SELECT 抽样真实 15m close）

---

## 0. 结论速览

| 套件 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 前端 T1/T2 | `cd web && npx vitest run src/features/indicators/dcap.test.ts` | **测试文件收集失败**（`./dcap` 不存在）⇒ 0 例执行 | 1 |
| 前端 T3 | `cd web && npx vitest run src/features/indicators/dcapMirror.test.ts` | **11 例：8 绿（负例哨兵）/ 3 红（真实产物缺失）** | 1 |
| Rust T4 + 插件 T2 | `cargo test -p strategy-runtime --test dcap_cross_runtime` | **5 例：2 绿（自检+样例集守卫）/ 3 红（产物缺失）** | 101 |
| 类型检查（web 构建） | `cd web && npx tsc -b` | 2 处错误，**均**为 `TS2307: 找不到 './dcap'` | 2 |
| 回归（既有测试不受影响） | `cd web && npx vitest run` / `cargo test -p strategy-runtime` | web：`3 failed | 492 passed (495)`；rust：unit 14 绿 + `contract.rs` 13 绿 | 1 / 101 |

- **崩溃 / core dump：无**（`core*` 文件 0 个；全部为断言/文件缺失类失败，无进程崩溃）。
- **覆盖率工具：无**（本仓未配置覆盖率；本批为口径门禁测试，不做行覆盖统计）。
- **未做任何失败分析或修复**（tester 职责边界）：本报告只记录现象与原始输出。
- **无 skip / `#[ignore]`**：全部新增用例均默认执行。

---

## 1. 命令与原始输出（Red 证据）

### 1.1 前端 T1/T2：产物不存在（模块解析失败）

```
$ cd web && npx vitest run src/features/indicators/dcap.test.ts      # exit=1
 FAIL  src/features/indicators/dcap.test.ts [ src/features/indicators/dcap.test.ts ]
Error: Failed to resolve import "./dcap" from "src/features/indicators/dcap.test.ts". Does the file exist?
  Plugin: vite:import-analysis
  1  |  import { describe, expect, it } from "vitest";
  2  |  import { computeDcapSeries, dcapRoi, smoothSeries } from "./dcap";
     |                                                            ^
 Test Files  1 failed (1)
      Tests  no tests
```

### 1.2 前端 T3：负例全绿（检查器有鉴别力）+ 真实产物断言全红

```
$ cd web && npx vitest run src/features/indicators/dcapMirror.test.ts   # exit=1
  ✓ T3-neg-0 正例对照：合成夹具原样 ⇒ 不报红
  ✓ T3-neg-1 删除 ts 侧 BEGIN 哨兵 ⇒ 必红
  ✓ T3-neg-2 删除 js 侧 END 哨兵 ⇒ 必红
  ✓ T3-neg-3 哨兵重复（歧义切片）⇒ 必红
  ✓ T3-neg-4 合成夹具 CORE 内翻转一个字节 ⇒ 必红且定位到偏移
  ✓ T3-neg-5 清空 CORE 区间（BEGIN/END 相邻）⇒ 必红（防「空区间假绿」）
  ✓ T3-neg-6 ts 侧 CORE 多一个字节 ⇒ 必红（长度不一致）
  ✓ T3-neg-7 哨兵顺序颠倒 ⇒ 必红
  × T3-real-1 两份产物存在且 CORE 区间逐字节相同
      → 前端产物 dcap.ts 不存在：/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcap.ts
        （应由 entangled 从 design/14-dcap-indicator/02-spec.md 生成）
  × T3-real-2 真实产物原样复制到 /tmp ⇒ 检查器不报红（正例对照）
  × T3-real-3 全部负例过程后，仓库内真实产物 sha256 未变
 Test Files  1 failed (1)
      Tests  3 failed | 8 passed (11)
```

### 1.3 Rust T4 / 插件 T2：产物不存在

```
$ cargo test -p strategy-runtime --test dcap_cross_runtime          # exit=101
running 5 tests
test t4_sample_set_meets_spec ... ok
test t4_selfcheck_comparator_teeth_one_ulp_and_sandbox_pipeline ... ok
test t4_cross_runtime_scores_bit_equal ... FAILED
test t4_cross_runtime_raw_series_bit_equal ... FAILED
test t2_plugin_smooth_off_equals_m1_bit_equal ... FAILED

---- t4_cross_runtime_scores_bit_equal stdout ----
thread '...' panicked at crates/strategy-runtime/tests/dcap_cross_runtime.rs:114:9:
插件产物 dcap.js 读取失败："/home/eestock/workspace/git/eestock/eestock-rs/crates/strategy-core/reference-plugins/dcap.js"
（No such file or directory (os error 2)）
两个产物应由 `entangled tangle` 从 design/14-dcap-indicator/02-spec.md 生成（ADR-021 D1/D2）。
（t4_cross_runtime_raw_series_bit_equal / t2_plugin_smooth_off_equals_m1_bit_equal 同一条信息）

test result: FAILED. 2 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out
```

`t4_selfcheck_*` **绿**说明：比较管线（node/V8 × QuickJS × 比较器）本身可用且有鉴别力（见 §3）。

### 1.4 web 全量套件（确认未破坏既有测试）

```
$ cd web && npx vitest run
 Test Files  2 failed | 48 passed (50)
      Tests  3 failed | 492 passed (495)
```
失败仅来自本批新增的 2 个文件，其余 48 个文件全绿。

**波动观察（如实记录）**：全量套件共跑 8 次，其中 1 次出现 `Test Files 3 failed | 47 passed (50)` /
`Tests 4 failed | 491 passed (495)`（多 1 例失败，发生在既有测试文件中；该次输出未捕获到具体用例名）。
其余 **7 次连续复跑均为 `2 failed files | 48 passed`、`3 failed | 492 passed`**（失败项恒为本批
`T3-real-1/2/3`）⇒ 判定为**既有套件的偶发波动**，与本批新增文件无关（本批前端用例无 RNG/无时钟/无网络依赖）。
建议架构师在统一提交前留意该既有波动（如需，可另立 tester 任务定位）。

### 1.5 既有 Rust 测试不受影响

```
$ cargo test -p strategy-runtime
     Running unittests src/lib.rs        → test result: ok. 14 passed; 0 failed
     Running tests/contract.rs           → test result: ok. 13 passed; 0 failed
     Running tests/dcap_cross_runtime.rs → test result: FAILED. 2 passed; 3 failed   ← 本批新增
```

### 1.6 类型检查（`npm run build` 路径）

```
$ cd web && npx tsc -b                                              # exit=2
src/features/indicators/dcap.test.ts(21,58): error TS2307: Cannot find module './dcap' or its corresponding type declarations.
src/features/indicators/dcap.test.ts(22,45): error TS2307: Cannot find module './dcap' or its corresponding type declarations.
```
两处错误**唯一原因**就是产物未生成；本批测试文件自身在「替身存在」的沙箱里通过了 `strict + noUnusedLocals +
noUncheckedIndexedAccess` 全量类型检查（见 §3.2）。

---

## 2. 失败用例清单

| # | 用例 | 套件 | 错误信息（原文摘录） | 崩溃/core |
|---|---|---|---|---|
| 1 | `dcap.test.ts`（整文件 T1-a…T2-d，10 例） | vitest | `Failed to resolve import "./dcap" ... Does the file exist?`（收集阶段失败，0 例执行） | 无 |
| 2 | `T3-real-1 两份产物存在且 CORE 区间逐字节相同` | vitest | `前端产物 dcap.ts 不存在：<repo>/web/src/features/indicators/dcap.ts（应由 entangled 从 design/14-dcap-indicator/02-spec.md 生成）` | 无 |
| 3 | `T3-real-2 真实产物原样复制到 /tmp ⇒ 检查器不报红` | vitest | 同上 | 无 |
| 4 | `T3-real-3 真实产物 sha256 未变` | vitest | 同上 | 无 |
| 5 | `t4_cross_runtime_scores_bit_equal` | cargo | `插件产物 dcap.js 读取失败：<repo>/crates/strategy-core/reference-plugins/dcap.js（No such file or directory (os error 2)）` | 无 |
| 6 | `t4_cross_runtime_raw_series_bit_equal` | cargo | 同上 | 无 |
| 7 | `t2_plugin_smooth_off_equals_m1_bit_equal` | cargo | 同上 | 无 |

崩溃 / core dump：**无**（无 SIGSEGV/SIGABRT，无 core 文件生成）。

---

## 3. 断言有效性自证（Red 之外的可信度证据）

Red 本身不能证明「测试能变绿」或「断言能判红」。故本批在 `/tmp` 隔离沙箱内做了两侧自证（**未**触碰仓库产物）：

### 3.1 T1/T2 可满足性（沙箱参考实现）

在 `/tmp/dcap_selfcheck/` 放入按 02-spec §1/§3 自写的**替身** `dcap.ts`，用同一份测试文件运行：

```
$ npx vitest run --root /tmp/dcap_selfcheck features/indicators/dcap.test.ts
 ✓ features/indicators/dcap.test.ts (10 tests) 7ms
      Tests  10 passed (10)
```

⇒ T1/T2 全部冻结值可达、T2 四个哨兵（含 1 ulp 与 null 错位）在该实现下判红/不报红均符合预期。

### 3.2 沙箱类型检查

```
$ npx tsc -p /tmp/dcap_selfcheck/tsconfig.json（strict + noUnusedLocals + noUncheckedIndexedAccess）
（无 dcap.test.ts / dcapMirror.test.ts 相关错误；仅替身自身 3 处索引告警）
```

### 3.3 T3 真实产物路径的正/负双向验证（沙箱伪仓库）

在 `/tmp/dcap_selfcheck_repo/` 造出「两份产物 CORE 逐字节同源」的伪仓库：

```
$ npx vitest run --root /tmp/dcap_selfcheck_repo web/src/features/indicators/dcapMirror.test.ts
      Tests  11 passed (11)                                    # 正例：全绿

# 在伪仓库的 .js CORE 内插入 1 个字节（空格）后重跑：
  × T3-real-1 ... → 镜像体不一致（ADR-021 D4 违例）：首个差异在 CORE 内偏移 434：ts=0x7c js=0x20；
                    上下文 ts=" { if (smooth === 0 || m <= 1) return va" / js=" { if (smooth === 0  || m <= 1) return v"
      Tests  2 failed | 9 passed (11)
```

⇒ 真实产物路径上的断言**确有鉴别力**（1 字节即可判红并给出偏移）。

### 3.4 T4 自检（`t4_selfcheck_comparator_teeth_one_ulp_and_sandbox_pipeline`，当前**绿**）

四个子断言全部通过：①比较器能识别 1 ulp（`0x...f7` vs `0x...f8`）；②沙箱替身两侧逐字节同源 ⇒ 不报差异；
③替身 ROI 乘 `1.0000000001` ⇒ 原始值比对报红；④替身 `smooth=0` 支被近似污染 ⇒ 插件侧 T2 判据报红。

> 该自检在本轮**抓到两个真实陷阱**（已修正并写进设计报告 §8）：
> ① 自写冻结值最初取错窗口（取了最旧 n 根而非最近 n 根）⇒ 被沙箱正例对照暴露；
> ② `serde_json::from_str::<f64>` 的十进制解析**并非正确舍入**（实测 `"57.329040578513684"` →
> `0x404caa1e006de2f7`，正确值 `0x404caa1e006de2f8`，差 1 ulp）⇒ 浮点传输已全部改为 16 位 hex 位串，
> 并在比较器里对十进制 Number 做 fail-closed 拒绝。

---

## 4. 覆盖摘要

- 无覆盖率工具输出；本批为**口径门禁**测试（T1–T4），覆盖面按用例清单计量：
  T1 6 例、T2 4 例、T3 11 例、T4 5 例（含 1 自检 + 1 样例集守卫），共 **26 例**；
- T4 的样例集为 **24 组 × （1 组评分序列 + 1 组三线序列 + 1 组单线 ROI）**，其中 r≠1 共 11 组（≥5 要求）；
- 三条独立断言层级齐备：容差（T1）/ 逐位（T2、T4）/ 逐字节（T3）。

---

## 5. 交给下一步 coder 的简短说明（Red → Green 执行清单）

1. 在 `design/14-dcap-indicator/02-spec.md` 写两个 `file=` 块（CORE 区间逐字节相同），
   跑 `entangled tangle` 生成 `web/src/features/indicators/dcap.ts` 与
   `crates/strategy-core/reference-plugins/dcap.js`（**勿手改生成物**；`./scripts/check-tangle.sh` 兜底）。
2. CORE 内必须是**无类型注解的 ES2015 子集**，并**定义与 §4 导出名同名的顶层函数**
   `dcapRoi` / `smoothSeries` / `computeDcapSeries` / `dcapScore`（T4 原始值比对依赖此契约；缺名会给出明确报错）。
3. 浮点铁律：**禁 `Math.pow/exp/log`**（`w *= r` / `w /= r` 迭代乘除）、**禁增量累加**（每 bar 在窗口上完整重算）、
   两份产物**同一表达式同一累加序**。注意：`02-spec §0` 的累加序文字与该节 `r=1.2` 示例值差 2.2e-16
   ——T1 用 1e-12 容差（两侧都过），**T4 不冻结任何一侧的位**（两侧实测互比），故按你落地的排布实现即可，
   但**两份产物必须完全一致**。
4. 插件包装层（P2）需要 `PARAMS_SCHEMA/init/on_bar/save/load`；其中 `on_bar` 与 `save/load` 是
   T4-评分 / T2-插件 / （后续）T7 的前提。**若 P1 只落 CORE**：`t4_cross_runtime_raw_series_bit_equal`
   可先绿，另两例保持红属预期（不是缺陷）。
5. 变绿顺序建议：T3-real（镜像）→ T4-raw → T1/T2（前端）→ T4-scores / T2-plugin（依赖包装层）。
6. 跑测试的命令见 §0；**不要**为了变绿改动测试的容差/哨兵/样例集；若认为某条断言口径有误，
   回到 `design/14-dcap-indicator/**` 改口径（事实源）后再改测试。

---

## 6. 未做事项（职责边界声明）

- **未**分析失败原因、**未**尝试任何修复、**未**修改任何源文件（只新增 3 个测试文件 + 2 份 tester 报告）；
- **未** `git add`/`commit`/`stash`；**未**使用 `entangled tangle --force`（仓库门禁未触碰；沙箱仅用于 `/tmp` 内替身）；
- **未**启动 8081/8082 服务；**未**触碰生产线；数据面仅执行 1 条只读 `SELECT`（抽样真实 15m close 作冻结基准）。
