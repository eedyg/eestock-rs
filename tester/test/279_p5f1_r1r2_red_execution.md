# 279 — P5-F-1 红测试执行报告（R1/R2：父层回执权威 + 越域无死区）

> **本报告位置**：`tester/test/279_p5f1_r1r2_red_execution.md`
> 类型：Execution report（执行**本轮新落**的红测试与真渲染几何 harness；**未修改任何既有测试**，
> 未修改产品实现/接口/架构）
> 设计报告：`tester/design/279_p5f1_r1r2_red_design.md`
> 证据目录：`tester/evidence/279_p5f1_r1r2_red/`

## 0. 运行环境与口径

| 项 | 值 |
|---|---|
| 仓库 / HEAD | `/home/eestock/workspace/git/eestock/eestock-rs` @ `78eb68d`（P5 实现/规范在**工作树未提交**） |
| 时间 | 2026-09-15 01:22–01:25（+08:00） |
| 逻辑层 | `web/` · `vitest 3.2.7`（jsdom） |
| 几何层 | `web/` · Vite 构建真实产品组件 + 真实 Tailwind/klinecharts 10.0.3 + Playwright Chromium；本机**随机端口**静态服务 |
| 类型检查 | `web/` · `tsc -b` ⇒ exit 0、**零输出**（`tsc_b.txt` = 0 字节） |
| 出网 / 写请求 | **0**：几何 harness 全部本机随机端口 + 合成数据；`saveMultiPeriodConfig` 落在**页面内桩**（只进内存）⇒ 0 真实写请求；不触碰线上 8081/8082 |
| 线上进程 | PID 3112540（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`）**未触碰**（`hygiene_and_env.txt`：etime 13h32m） |
| git 卫生 | staged **空**（未 add/commit/stash）；tracked 改动仍为 P5 既有的 4 个文件（本轮**未新增 tracked 改动**） |
| 临时实例 | 已全拆：`/tmp/p5-r1r2-dist` 删除、无残留进程（`[p]5-r1r2-harness` 模式 pgrep 空）、0 个 node 监听 |

## 1. 结果总览

| 套件 | 命令（cwd） | 退出码 | total | passed | failed | skipped | 判读 |
|---|---|---|---|---|---|---|---|
| 本轮新增红测试（逻辑层） | `./node_modules/.bin/vitest run src/features/dashboard/multiPeriodLayoutAuthority.test.tsx`（`web/`） | 1 | 5 | 1 | **4** | 0 | R1/R2 的 4 条判据红；1 例绿 = 载荷口径守卫（`R2-C`） |
| 前端全量套件 | `./node_modules/.bin/vitest run`（`web/`） | 1 | 758 | 754 | 4 | 0 | Test Files 1 failed(83) ⇒ **既有 754 例零回归**，失败全部来自本轮新增文件 |
| 类型检查 | `./node_modules/.bin/tsc -b`（`web/`） | 0 | — | — | 0 | — | 零输出（红阶段不被类型阻塞） |
| 真渲染几何 harness（几何层） | `node tester/p5-r1r2-harness/run.mjs`（`web/`） | 1 | 13 检查 | 7 PASS | **6 FAIL** | 0 | R1 逐值复现 P5 验收回弹；R2 复现死区与 20px 跳变 |

**命令（Red 证据，原始输出见证据目录）**

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs/web
./node_modules/.bin/vitest run src/features/dashboard/multiPeriodLayoutAuthority.test.tsx  # EXIT=1  4 failed | 1 passed
./node_modules/.bin/vitest run                                                            # EXIT=1  4 failed | 754 passed
./node_modules/.bin/tsc -b                                                                # EXIT=0  零输出
node tester/p5-r1r2-harness/run.mjs                                                       # EXIT=1  6 FAIL / 7 PASS
```

## 2. 逻辑层失败用例（4/5；错误信息原文摘要 + 出处）

| # | 用例 | 错误信息（原文摘要） | crash/core |
|---|---|---|---|
| 1 | `R1-A 依赖完整性：父层只改卫星高度 ⇒ 分配必须重算（不得沿用旧卫星请求）` | `AssertionError: 父层 props 是高度权威（§6.3）：仅卫星高度变化也必须重算分配；返回旧卫星请求（97/97/112）即「依赖缺卫星高度」缺陷: expected {…} to deeply equal { '15m': 294, '1h': 112, …(2) }` —— 实收 `{15m:294, 1h:97, 5m:97, 1d:112}`（`multiPeriodLayoutAuthority.test.tsx:322`） | 无 |
| 2 | `R1-B 父层回执只改卫星高度 ⇒ 必须采用回执值（连续两次卫星↔卫星拖拽不得回弹）` | `AssertionError: 回执 settle 后必须采用回执值（不得回弹到请求前的分配）[回执前={294,97,97,112} 拖中={294,112,82,112} 回执后={294,97,97,112} after−during={0,-15,+15,0}]`（`assertEchoAdopted`，`…test.tsx:289/345`） | 无 |
| 3 | `R2-A 连续同向 ≥1px 拖拽 ⇒ 载荷必须每次都变化（不得「拖了载荷不变」）` | `AssertionError: 第 3 次拖拽后的载荷必须继续变化（收到 178）…载荷序列=[{15m:1200,1h:179,…},{15m:1200,1h:178,…},{15m:1200,1h:178,…}]: expected 178 to be 177`（`…test.tsx:396`） | 无 |
| 4 | `R2-B 越域 + 以真实服务端值重载 ⇒ 屏幕不得跳变（实测 20px）且屏幕-载荷偏差 ≤61px` | `AssertionError: 以真实服务端值重载后屏幕必须与拖后一致（±1px）：拖后屏幕={1261,179,180,180} 重载屏幕={1241,199,180,180} 跳变=20px（P5 验收实测 20px）: expected 20 to be less than or equal to 1`（`…test.tsx:450`） | 无 |
| — | `R2-C 越域载荷口径：payload == clamp(DOM)、Σ DOM == 可用` | **绿（守卫）**：载荷 `{1200,185,175,180}`、Σ 分配 1800、屏幕基准 1260 > 1200 | 无 |

**Crash / core dump**：**无**（0 个 core 文件；无 unhandled rejection；失败全部为契约断言，非崩溃）。
**失败原因摘录（不分析、不修复）**：以上 4 例均为「回执未成为权威 / 载荷零变化 / 重载跳变」的断言失败，
与 P5 最终独立验收（`278_…`，判 FAIL(5)）的 R1/R2 逐值对应。

## 3. 几何层检查（13 项：6 FAIL / 7 PASS）

| # | 检查 | 结果 | 实测 |
|---|---|---|---|
| R1-G0 | 前置：服务端配置 ⇒ 逐值渲染（±1px） | PASS | `{294,97,97,112}` == 期望 |
| R1-G1 | 回执只改卫星高度 ⇒ 拖中 == 回执后 | **FAIL** | 拖中 `{294,112,82,112}` → 回执后 `{294,97,97,112}`（**差 15px**；与 P5 验收逐值一致） |
| R1-G2 | 连续第二次卫星↔卫星 ⇒ 拖中 == 回执后 | **FAIL** | 拖中 `{294,97,107,102}` → 回执后 `{294,97,97,112}`（差 10px） |
| R1-G3 | 依赖完整性：父层只改卫星高度（无拖拽）⇒ 采用回执值 | **FAIL** | 期望 `{294,112,82,112}`，实际仍 `{294,97,97,112}` |
| R2-G0 | 前置：越域（1260 > 1200，Σ=1800） | PASS | `{1260,180,180,180}` |
| R2-G1 | 连续同向 ≥1px 拖拽 ⇒ 载荷每次变化 | **FAIL** | 载荷 `1h` 序列 `[179,178,178]`（期望 `[179,178,177]`） |
| R2-G1b | 载荷 #3 ≠ 载荷 #2 | **FAIL** | 第 3 次 1px 拖拽 ⇒ 载荷零变化（`{1200,178,180,180}` 重复） |
| R2-G2 | 以真实服务端值重载 ⇒ 不跳变 | **FAIL** | 拖后屏幕 `{1261,179,180,180}` vs 重载 `{1241,199,180,180}` ⇒ **跳变 20px** |
| R2-G3 | 屏幕 vs 载荷偏差 ≤61px（记录实测值） | PASS | **实测 61px**（屏幕 1261 / 载荷 1200） |
| R2-G4 | 载荷恒合法（桩「PUT」不收到域外值） | PASS | `[]` |
| HY1 | 零出网 / 零写请求 | PASS | 非本地请求 **0**；PUT 全落页面内桩 |
| HY2 | 零 pageerror | PASS | 0 |
| — | 截图 | — | `R1_echo_snapback_600.png`、`R2_avail1800_deadzone.png` |

## 4. 覆盖率小结（本层自带口径）

- 逻辑层：R1 判据 3/3 有对应用例（2 红 1 绿守卫路径）、R2 判据 4/4（3 红 1 绿守卫）。
- 几何层：13 检查覆盖「前置 / R1 回弹 / R1 依赖 / R2 死区 / R2 跳变 / 偏差上界 / 载荷合法 / 卫生」。
- 两层互证：同一拖拽场景在两层都产出 `{294,112,82,112} → {294,97,97,112}`（声明高 vs 真实 rect 一致）。

## 5. 本轮交付物

| 文件 | 类型 | sha256(前 12) |
|---|---|---|
| `web/src/features/dashboard/multiPeriodLayoutAuthority.test.tsx` | 新增红测试（5 例） | `97da93a73433` |
| `web/tester/p5-r1r2-harness/entry.tsx` | 真渲染入口（父层桩 + 几何读数 API） | `d295b1f68d4f` |
| `web/tester/p5-r1r2-harness/index.html` | 页面 | `723948f2493a` |
| `web/tester/p5-r1r2-harness/vite.config.mjs` | 构建配置（root=本目录；outDir=/tmp） | `95fecd8c590f` |
| `web/tester/p5-r1r2-harness/postcss.config.js` | 真实 Tailwind/autoprefixer | `7020c8dc0448` |
| `web/tester/p5-r1r2-harness/run.mjs` | runner（13 检查；红时 exit 1） | `72ff530954dc` |
| `tester/evidence/279_p5f1_r1r2_red/{vitest_r1r2_red.txt, vitest_full_suite.txt, tsc_b.txt, p5_r1r2_harness_stdout.txt, p5_r1r2_harness.json, R1_echo_snapback_600.png, R2_avail1800_deadzone.png, probe_baseline_observability.txt, hygiene_and_env.txt}` | 证据（原始输出 + JSON + PNG + 探针 + 卫生） | 见证据目录 |

- **暂存区**：空（`git diff --cached --name-only` 无输出；未 add/commit/stash）。
- **tracked 改动**：无新增（仅 P5 既有的 4 个文件仍为工作树改动）⇒ 产品实现/接口/架构**零改动**。
- **未做**：未分析失败根因后改代码、未修复任何失败、未新增永久插桩、未跑 tangle、未触碰线上、未重启服务。

## 6. 残余风险（仅记录，不实施）

- **R-1（低）**：逻辑层容差 ±1px（声明高 vs 分配）、几何层 ±1px（真实 rect）；两层实测逐值为整数，无额外误差。
- **R-2（信息）**：「屏幕 vs 载荷 ≤61px」是**当前夹具**（可用 1800、3×180 卫星）的上界；可用高度更高时该偏差会增大
  ⇒ 若后续要求更大可用高度，需按 `可用 − Σ卫星 − 1200` 重算该上界（不属本轮红测试范围）。
- **R-3（信息）**：裁决 ① 的「基线改 `clamp(分配)`」在本分配算法下**几乎不可观测**（探针：
  `probe_baseline_observability.txt`，仅 δ≈−1200 的极端饱和场景有差异）⇒ 让本轮判据转绿的**必要条件**是
  **裁决 ③（deps 必须含卫星高度）**；这条已写入设计报告 §7.1 供实现方与下一轮验收使用。
- **R-4（信息）**：`R2-C`/`R2-G3`/`R2-G4`/`HY1`/`HY2`/`R1-G0`/`R2-G0` 是**绿守卫**（当前即绿），非红证据；
  实现后必须仍绿（否则属回归）。

**本报告位置**：`tester/test/279_p5f1_r1r2_red_execution.md`

VERDICT: RED-READY
