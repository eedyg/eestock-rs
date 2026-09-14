# D5-1 红测试执行报告（Tester）：mock ↔ backend 多周期契约向量（parity）

- **本文件路径**：`tester/test/267_d51_red_execution.md`
- 时间：2026-09-14 21:10–21:16（本地，UTC+8）｜HEAD `d6462da229f9264777e414be827d9d1017600778` **+ 工作树 P1 未提交改动**
- 设计报告：`tester/design/267_d51_contract_vectors_parity_red_design.md`｜证据目录：`tester/evidence/267_d51_red/`（6 个原始输出文件）
- 纪律：**未改任何产品/设计实现文件**（仅新增 1 个向量 JSON + 2 个测试文件）；未 `git add/commit/stash`（`git diff --cached` 行数 = 0）；未重启/未触碰线上（PID 3112540 存活）；未跑 tangle；临时实例/端口：**无**（本轮无 HTTP、无 DB 写）；共享库 `app_config.multi_period` 收尾复核 **0 行**（且 `app_config` 现存键仅 `dcap` ⇒ 本轮零写）
- 硬约束遵守：**0 写请求**（两侧断言全为进程内纯函数/内存 mock）；**未**在仓库内跑 `entangled tangle`

---

## 0. 总览

| 套件 | 命令 | 结果 | 红/绿 |
|---|---|---|---|
| Rust 消费侧（后端纯函数） | `cargo test -p web --test multi_period_contract_vectors` | **4 tests：4 passed / 0 failed**（exit 0，0.47s） | **绿**（后端 P1-D-2/D-3 已修，与向量一致） |
| TS 消费侧（mock PUT 路径，聚焦） | `./node_modules/.bin/vitest run src/api/multiPeriodMockParity.test.ts` | **20 tests：17 passed / 3 failed**（exit 1，0.48s） | **红**（预期：mock 未去重） |
| 前端全量（回归视角） | `./node_modules/.bin/vitest run` | **69 files / 648 tests：645 passed / 3 failed**（exit 1，5.66s） | 失败恰为本轮 3 个红用例，其它 68 文件零回归（基线 628 + 本轮 20 = 648） |
| 类型检查 | `./node_modules/.bin/tsc -b` | exit 0（新用例类型干净，用本地二进制） | 绿 |
| 崩溃/核心转储 | — | **无**（0 例 crash、0 个 core dump；全部为断言失败/抛错） | — |

**VERDICT: RED-READY** —— 共享向量 + 两侧消费侧已落地；TS 侧 3 条去重向量按预期红，Rust 侧绿（后端已修）；产品代码零改动。

---

## 1. 改动面（3 个新文件；均为未跟踪新文件，非 tangle 生成物）

| 文件 | 行数 | sha256（本轮末） | 说明 |
|---|---|---|---|
| `design/15-multi-period/contract-vectors.json` | 308 | `8c72c601755297451a1532e6846aa33db365fb6ec701eeda5dd02b465929eb20` | 19 条共享契约向量（7×200 / 12×400），两侧**单一真相**；`.json` 不在 `entangled.toml` 的 `watch_list`（`design/**/*.md`）⇒ 不影响生成物 |
| `crates/web/tests/multi_period_contract_vectors.rs` | 196 | `8fc298e0ace2c992f502997b8a0e1623cd9f6c2b41f9b6969368e0dc6ab65ac0` | Rust 消费侧（4 tests）：逐条打 `validate_multi_period_config`；附加纯函数层 pane 计数/护栏；19 个 name 覆盖守卫 |
| `web/src/api/multiPeriodMockParity.test.ts` | 107 | `2d68ca2578101f86080b8c511abc1a604faa01f0562b1c70f2880955502be214` | TS 消费侧（20 tests）：逐条打 `createMockClient().saveMultiPeriodConfig`（即 `assertMultiPeriodConfig`），断言 status / normalized / errorMustContain |

- 产品/设计实现文件 mtime 全部早于本轮首次写入（21:12:24）：`crates/web/src/dto.rs`、`rest.rs` = 20:59:48；`web/src/api/mock.ts` = 20:39:50；`web/src/api/client.ts` = 20:39:39；`design/15-multi-period/02-spec.md` = 20:49:20 ⇒ 本轮**未触碰**（证据 `05_changes_hygiene.txt`）。
- `design/15-multi-period/contract-vectors.json` 是 `design/**` 下**唯一**新增文件，且为 `.json`（非 `.md`）⇒ tangle 生成物零影响。

## 2. 失败用例逐条（红证据；**仅观察，不分析根因、不修**）

| # | 用例（name 即用例名） | 文件:行 | 错误信息（截断） | crash/core |
|---|---|---|---|---|
| 1 | `dedup-two-identical-indicators（expect 200）` | `web/src/api/multiPeriodMockParity.test.ts:88` | `AssertionError: mock 归一化输出必须与后端一致（含 indicators 去重）…`；`Expected: {"enabled":true,"heights":{"1m":420,"5m":180},"indicators":["dcap"],"periods":["1m","5m"]}` / `Received: {…,"indicators":["dcap","dcap"],…}` | 无 |
| 2 | `dedup-n-identical-indicators-cannot-forge-over-12-panes（expect 200）` | `multiPeriodMockParity.test.ts:84`（栈：`mock.ts:202` → `mock.ts:231` → `mock.ts:1079`） | `ApiError: HTTP 400: 总 pane 数 34 超上限 12`（期望 200：去重后 1+3×1=4 ≤ 12） | 无 |
| 3 | `dedup-makes-legal-repeated-indicators-over-raw-pane-budget（expect 200）` | `multiPeriodMockParity.test.ts:84`（栈同上） | `ApiError: HTTP 400: 总 pane 数 16 超上限 12`（期望 200：原始长度 16 越限，去重后 4 ≤ 12） | 无 |

- 退出码：`vitest` = 1（断言/抛错）；`cargo test` = 0（Rust 侧全绿）；无 panic-from-other 线程、无 abort、无 `core.*` 文件。
- 其余 16 条向量（含全部 12 条 400 负例与 4 条 200 正例）在 TS 侧**已绿** ⇒ 红的范围精确等于"去重语义"这一条漂移，无 collateral。
- 原始输出：`tester/evidence/267_d51_red/01_rust_contract_vectors.txt`、`02_ts_mock_parity_red.txt`、`04_vitest_full.txt`。

## 3. Rust 消费侧（绿）明细

```
running 4 tests
test pane_count_after_dedup_matches_backend_pure_function ... ok
test contract_vectors_cover_required_rules ... ok
test pane_guard_error_names_dimension_for_over_limit_vectors ... ok
test all_contract_vectors_match_backend_validation ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

含义：19 条向量在真实后端 `web::dto` 校验上**逐条**给出与期望一致的接受/拒绝与归一化输出（含 `["dcap"]×11` ⇒ 200 + 归一化 `["dcap"]`；去重后 13 pane 向量 ⇒ 400 且错误含 `indicators`，纯函数层 `paneCountAfterDedup=13` + 护栏错误含维度名）。**Rust 侧现状绿 = 后端已修**，红侧只在 mock。

## 4. 卫生与隔离复核（`05_changes_hygiene.txt` / `06_hygiene_db_proc.txt`）

| 项 | 实测 |
|---|---|
| 暂存区 | `git diff --cached` = **0 行**（未 `git add/commit/stash`） |
| 共享库 `app_config` | `key='multi_period'` **0 行**；现存键仅 `dcap`（本轮未触碰任何键 ⇒ 零写） |
| 线上进程 | PID **3112540 存活**（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，ELAPSED 09:20:45）；未重启、未发请求（8081/8082 零请求） |
| 临时实例/端口 | **无**（本轮不建 HTTP 实例；无监听残留） |
| 测试进程残留 | 无（cargo test / vitest 均已退出；`ps` 中 node 进程均为 IDE/intercom 常驻，非本轮产物） |
| tangle | 未在仓库内跑 `entangled tangle`；新增文件为 `.json` 非 watch 目标 ⇒ 生成物零影响 |

## 5. 残余风险 / 交接提示（不修缮，仅报告）

1. **本轮不改 mock（派单明确"不要改产品代码"）** ⇒ TS 侧 3 红是**待 D5-2 实现转绿**的门禁。转绿判据：`vitest run src/api/multiPeriodMockParity.test.ts` 20/20 + Rust 侧保持 4/4。修 mock 时**不得**给 `periods` 去重（向量 `reject-duplicate-periods` 要求 400）。
2. **「去重后越限」在 v1 只能两层取证**（`02-spec.md` §7.4 注）：HTTP 面的 400 由"未支持指标"规则产生（错误串含字段名 `indicators`），纯 pane 越限由 `verify_multi_period_panes`（纯函数）钉住。P2 受支持指标集合扩张后，应在**同一向量文件**补 HTTP 级纯 pane 越限负例（届时支持 ≥5 个不同指标即可）。
3. **TS 侧未覆盖**：`GET` 读落韧性（无键/坏 JSON/越界旧值 ⇒ 默认）与 JSON 反序列化层（如 `periods` 非数组、`heights` 值非整数）——派单未要求；Mock 的 `getMultiPeriodConfig` 目前不跑校验（只回内存态），若 D5-2 一并收敛可加向量。
4. **TS 侧 `expect.normalized` 比对为"键序无关稳定序列化"**：与 Rust `MultiPeriodConfigDto` 的 `PartialEq` 语义等价（`heights` 为 `BTreeMap`）；不引入对象键序依赖。
5. **首轮证据文件 `02_ts_mock_parity_red.txt` 曾被覆盖**：初次运行因测试文件块注释内含 `design/**/*.md` 使 `*/` 提前闭合，esbuild 报 `Transform failed: Unexpected "*"`（0 tests）。已改写该注释**再跑**，当前证据文件为最终一次运行（20 tests / 3 failed）。该问题是测试文件自身语法，非产品缺陷。
6. **两侧命令均未使用 `cargo test -p web` 全量**（避免长时间编译/其它 target 干扰）：本轮只跑新 target + 前端全量 vitest；`tsc -b` exit 0。
