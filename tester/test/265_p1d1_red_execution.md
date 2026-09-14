# P1-D-1 红测试执行报告（Tester）

- **本文件路径**：`tester/test/265_p1d1_red_execution.md`
- 时间：2026-09-14 20:44–20:59（本地，UTC+8）｜HEAD `d6462da229f9264777e414be827d9d1017600778` **+ 工作树 P1 未提交改动**
- 设计报告：`tester/design/265_p1d1_red_tests_design.md`｜证据目录：`tester/evidence/265_p1d1_red/`（9 个原始输出文件）
- 纪律：**未改任何产品/设计文件**；未 `git add/commit/stash`（`git diff --cached` 行数 = 0）；未重启/未触碰线上（PID 3112540 存活）；未在仓库内跑 `entangled tangle`（仅跑 `scripts/check-tangle.sh`，其自带 /tmp 沙箱，exit=0）；临时实例端口由内核分配（`127.0.0.1:0`，进程退出即释放，复核无残留）；共享库 `app_config.multi_period` 键收尾 **0 行**。

---

## 0. 总览

| 套件 | 命令 | 结果 |
|---|---|---|
| Rust 纯函数（pane 护栏） | `cargo test -p web --test multi_period_pane_budget` | **8 tests：5 passed / 3 failed**（红：D1×2 + D2×1；含 D2 判据自检 1 例，绿） |
| Rust HTTP（多周期端点） | `cargo test -p web --test api_multi_period_config` | **17 tests：15 passed / 2 failed**（红：D1×2） |
| Rust 全 crate 视角 | `cargo test -p web --no-fail-fast` | **109 tests：104 passed / 5 failed**（失败恰为本轮 5 个红用例，其它 target 零回归） |
| 前端聚焦（D4） | `npx vitest run src/features/dashboard/multiPeriodClosedEquivalence.test.tsx` | **6 tests：6 passed**（含新增 D4×2） |
| 前端全量 | `npx vitest run` | **68 files / 628 tests：628 passed / 0 failed**（P1-C 基线 626 + 新增 2） |
| 类型检查 | `./node_modules/.bin/tsc -b` | exit 0（新用例类型干净；**注意用本地二进制**，裸 `npx tsc` 会假红） |
| 生成物门禁 | `./scripts/check-tangle.sh` | exit 0（沙箱重生成逐字节一致；本轮未触碰任何生成物） |
| 崩溃/核心转储 | — | **无**（0 例 crash、0 个 core dump；全部为断言失败） |

**失败 = 预期红**：本轮 5 个失败用例即指派要落的 D1/D2 红测试（现状未实现 → 期望红）。无意外失败、无 collateral。

---

## 1. 改动面（只 3 个 P1 测试文件；均为未跟踪的新文件，属 P1 交付物）

| 文件 | sha256（本轮末） | 行数 | 变更 |
|---|---|---|---|
| `crates/web/tests/multi_period_pane_budget.rs` | `5e2aac28032bfaa857d7f3a3a1f946730cede2bcc5e36e7368bacce3302bd851` | 217 | 头注释修正（D3）+ 新增 D1×2、D2×1 + D2 判据自检×1 用例 |
| `crates/web/tests/api_multi_period_config.rs` | `1ac11f1ce55fa18939f04541ca8c7d444da9e6a48dfd391206de4dab8ae77a91` | 636 | 文件头补 P1-D-1 说明 + 新增 D1×2 用例 |
| `web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx` | `d0b595b08403c68d3b235160ec68df10a327ad5f0e1b3c120be458a4debd84be` | 408 | 头注释补 D4 说明 + 新增 D4 describe（2 用例） |

- P1 既有 11 个 tracked `M` 文件 mtime 全部早于本轮首批写入（20:52:19）⇒ 本轮**未触碰**产品/设计/生成物（证据 `08_changed_files.txt`）。
  - 备注（诚实）：`design/15-multi-period/02-spec.md` 的 mtime 为 20:49:20，落在本轮时间窗内但**早于本车道任何写入**，且本车道从未对 `design/` 发起写入 ⇒ 属架构师车道（§7.4 契约 doc-first）的并发改动，非本轮产出。
- 3 个文件均**非 tangle 生成物**（`design/**` 中无 `file=crates/web/tests/{multi_period_pane_budget,api_multi_period_config}.rs`；前端测试文件同理）⇒ 无需 doc-first；`check-tangle` 亦 exit 0。

## 2. 失败用例逐条（红证据；**仅观察，不分析根因、不修**）

| # | 用例 | 文件:行 | 错误信息（截断） | crash/core |
|---|---|---|---|---|
| 1 | `d1_pane_count_uses_deduped_indicator_set_not_raw_length` | `multi_period_pane_budget.rs:130` | `assertion left == right failed: D1：["dcap"]×2 与 ["dcap"] 语义等价 ⇒ 总 pane 计数结果必须相同（基于去重后集合，不得按原始数组长度计数） left: 7 right: 4` | 无 |
| 2 | `d1_duplicate_items_cannot_forge_over_budget_and_legal_shape_is_accepted` | `multi_period_pane_budget.rs:155` | `D1：去重后总 pane = 34 ≤ 12 ⇒ 必须允许保存（重复 11 次不得伪造 >12 pane、不得误拒）` | 无 |
| 3 | `d2_over_budget_error_names_the_rejected_dimension` | `multi_period_pane_budget.rs:178` | `D2：pane 预算错误串必须含**可定位的被拒维度名**……收到：总 pane 数 16 超上限 12（基准 1 + Σ_卫星指标 pane）` | 无 |
| 4 | `d1_duplicate_indicators_are_normalized_200_and_readback_deduped` | `api_multi_period_config.rs:521` | `D1：PUT 回显必须是**归一化（去重）后**的 indicators，收到 ["dcap","dcap"]（left=Array["dcap","dcap"] right=Array["dcap"]）` | 无 |
| 5 | `d1_duplicate_items_cannot_forge_over_budget_4_periods_always_200` | `api_multi_period_config.rs:584` | 全量样本：`n=3: status=200, indicators=["dcap","dcap","dcap"], periods_len=4`；`n=11: status=400, …`；`n=12: status=400, …`（违反项：n=3 未归一化；n=11/12 被误判 >12 pane ⇒ 400） | 无 |

退出码：两目标均 `exit=101`（cargo test 断言失败）；无 panic-from-other 线程、无 abort、无 `core.*` 文件生成。

原始输出：`tester/evidence/265_p1d1_red/01_pane_budget_red.txt`、`02_api_multi_period_red.txt`、`03_cargo_test_web_full.txt`。

## 3. D3（改文）与 D4（覆盖补齐）执行结果

- **D3**：`multi_period_pane_budget.rs` 头注释已按设计报告 §2.3 改写（准确表述 + 「未去重时的 400 是假象」+ P2 起补 HTTP 负例）。该文件仍有 3 红（D1×2/D2×1），与改注释无关。
- **D4**：新增 2 个 UI 级用例，**现状即绿**（`04_d4_vitest_focused.txt`：6 passed）。这是**覆盖缺口**而非缺陷（实现车道 P1 已落地乐观更新 + 失败回滚），故 D4 不贡献红；但反向证据证明其有牙：
  - **M1**（删除 `DashboardPage.toggleMultiPeriod` 失败回滚）⇒ 失败回滚用例 **红**（1 failed / 5 passed）；
  - **M2**（改为非乐观：先 `await` PUT 再改态）⇒ 两个用例 **红**（2 failed / 4 passed）。
  - 变异全部发生在 `/tmp/p1d1_d4m` 沙箱（src 副本 + `node_modules` 软链），仓库零改动，沙箱已拆除。原始输出：`06_d4_reverse_evidence.txt`。

## 4. 卫生与隔离复核（`07_hygiene_isolation.txt`）

| 项 | 实测 |
|---|---|
| 共享库 `app_config` 的 `multi_period` 键 | **0 行**（与 P1-C 基线一致 ⇒ 线上「无键=默认关闭」）；库中现存键仅 `dcap`（本轮未触碰） |
| 线上进程 | PID **3112540 存活**；8081/8082 由其监听（未重启、未发请求） |
| 临时监听残留 | 无 `127.0.0.1:1xxxx` 段残留 |
| 测试进程残留 | 无（cargo test / vitest / node 均已退出） |
| 线上日志 `multi_period` 出现次数 | **0**（`logs/app_dev_8081_redeploy_20260914_115233.log`） |
| 暂存区 | `git diff --cached` = 空 |

## 5. 残余风险 / 交接提示（不修缮，仅报告）

1. **D2 判据精确化**：设计报告 §2.2 把「含被拒维度名」限定为 `indicators` 或**字段标记形式**的 `pane`（`pane:` / `pane=` / `"pane"` / `[pane]` / 句首 `pane`）；仅中文算式里的「pane」字样不算（沿用 P1-C D2 判定）。若实现方选择纯中文句式（如「pane 预算超限」），需按上述形式微调字符串；断言信息已枚举可接受形式。
2. **去重语义的实现位置**：D1 纯函数用例要求 `multi_period_pane_count` 自身对重复项幂等（`["dcap"]×n` 与 `["dcap"]` 同值）；「只在调用方去重、计数函数仍按原始长度」不满足该契约。
3. **D2 判据已被机检钉死**：`d2_dimension_predicate_boundary_is_pinned`（绿）用 10 条正/反样本固化「算不算指名被拒维度」，实现方以任一形式（`indicators` / `pane:` / `pane=` / `\"pane\"` / `[pane]` / 句首 `pane`）均可转绿，避免口径漂移。
4. **前端 mock 未覆盖**：`web/src/api/mock.ts::assertMultiPeriodConfig` 仍按原始长度计 pane 且不去重 ⇒ D1 只修后端会留下前后端 mock 契约不一致（前端演示/mock 模式下 `["dcap"]×n` 会被 mock 400 拒）。**是否本轮一并修由父级裁决**（本车道未越权扩测）。
5. **D4 部分断言 P1 结构性恒真**：`init` 计数 / `bar:` 订阅 / 实例零残留断言在 P1（无卫星）恒真，属 P2 就绪守卫；现阶段有牙的是乐观 true / 回滚 false / PUT 报文 / DOM 指纹（已由 M1/M2 变异证明）。
6. 前端 UI 用例未覆盖「宫格模式隐藏开关」「卫星实例拆除」等 P2 口径（本轮范围外）。
7. 本轮未跑 e2e/Playwright（P1 关闭态无写语义，jsdom + 结构化指纹已足够）。

---

**VERDICT: RED-READY**
