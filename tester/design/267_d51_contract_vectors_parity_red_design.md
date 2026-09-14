# D5-1 红测试设计报告：mock ↔ backend 多周期契约向量（parity 门禁）

- **本文件路径**：`tester/design/267_d51_contract_vectors_parity_red_design.md`
- 时间：2026-09-14 21:10–21:16（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `d6462da229f9264777e414be827d9d1017600778` + 工作树 P1 未提交改动）
- 上游依据：`design/15-multi-period/02-spec.md` §2（配置契约 7 条）、§7.4（总 pane ≤12，**基于去重后集合**计数）、§7 护栏、`03-test-plan.md` T6；架构师 D5-1 派单
- 执行报告：`tester/test/267_d51_red_execution.md`｜证据目录：`tester/evidence/267_d51_red/`
- 本文件由 Tester 车道产出；**未改动任何产品/设计实现文件**（仅新增 3 个新文件：1 个共享向量 JSON + 2 个消费侧测试）

---

## 1. 问题与判据

| 项 | 事实（P1-C/P1-D） | 本设计的判据（落成测试） | 期望终态 |
|---|---|---|---|
| **D5-①** | `web/src/api/mock.ts::assertMultiPeriodConfig`（手写文件，非 tangle 生成物）**不去重** `indicators`（原样回显/落库）且 pane 计数按**原始数组长度** | 同一组输入向量在 mock 与真实后端必须给出**相同接受/拒绝 + 相同归一化输出** | 当前（TS）**红** → 修 mock 后绿 |
| **D5-②** | 两侧口径漂移无门禁（后端 P1-D-2/D-3 已修，mock 未跟） | 落**单一真相**向量文件 + 两侧消费同一文件（Rust 打 `web::dto` 纯函数 / TS 打 mock PUT 路径） | 门禁常驻（Rust 侧现状**绿**，TS 侧现状**红**） |

**为什么必须共享一份向量而不是各写各的**：两份独立用例可以在两侧各自"自洽"地漂移（正是 D5 的根因）。共享文件使「后端绿而 mock 红」成为**同一条断言**，且任一侧改口径都会同时反映到另一侧。

**已识别的设计难题与处置（诚实声明）**：派单要求向量含「去重后越限 ⇒ 400 且错误含维度名」。但 `02-spec.md` §7.4 注已明确：v1 受支持指标仅 `dcap` 且去重后 ⇒ **HTTP 层无法构造纯 pane 越限**（去重后总 pane ≤ 1+3×1 = 4 < 12）。故本设计把该要求拆成**同一向量的两层取证**：

- **配置层**：向量 `pane-over-limit-after-dedup-names-dimension` 的 `input` 去重后为 13 pane（>12），HTTP/纯函数返回 **400** 且错误串含被拒字段名 `indicators`（v1 由"未支持指标"规则先命中）⇒ 两侧断言 `status=400` + `errorMustContain="indicators"`；
- **纯函数层**：同一向量额外声明 `expect.paneCountAfterDedup=13` 与 `expect.paneGuardErrorMustContain=indicators`，由 Rust 侧直接打 `multi_period_pane_count` / `verify_multi_period_panes` 钉住**护栏本体**（TS 侧无纯函数出口，不消费这两个字段，不影响 parity 对称性）。

另：派单要求的「**无法用重复项构造 >12 pane**」向量 = `dedup-n-identical-indicators-cannot-forge-over-12-panes`（4 周期 × `["dcap"]×11` ⇒ 去重后 4 pane ⇒ 200）。TS 侧现状因按原始长度计 34 pane 而 400 ⇒ 正是该向量要抓的漂移。

## 2. 测试层级与文件

| 层 | 文件（本轮**新增**） | 手段 | 现状 |
|---|---|---|---|
| 单一真相（数据） | `design/15-multi-period/contract-vectors.json` | 19 条向量（7×200 / 12×400）；`.json` 不在 tangle watch_list（`design/**/*.md`）⇒ 不影响生成物 | — |
| 后端消费侧 | `crates/web/tests/multi_period_contract_vectors.rs` | `web::dto::validate_multi_period_config` 纯函数（**无 DB、无网络、无 IO 除读该 JSON**）+ `multi_period_pane_count` / `verify_multi_period_panes` | **绿**（4 tests passed） |
| mock 消费侧 | `web/src/api/multiPeriodMockParity.test.ts` | `createMockClient().saveMultiPeriodConfig`（内部即 `assertMultiPeriodConfig`；PUT 路径与后端同语义） | **红**（20 tests：17 passed / **3 failed**） |

**mock/stub 策略**：两侧**均不打桩**——Rust 侧直打纯函数；TS 侧用真实 mock 实现（`createMockClient()`，每条向量新建实例 ⇒ 无状态泄漏）。不引入任何新依赖、不改产品代码。

## 3. 向量清单（19 条；`name` 即用例名）

### 3.1 接受（200）——含去重归一化

| # | name | input 关键点 | 期望 normalized / 附加 |
|---|---|---|---|
| 1 | `valid-single-base-default` | 默认形态（关闭 + `["1m"]` + 420 + `["dcap"]`） | 原样 |
| 2 | `valid-four-periods-max-legal-v1` | 4 周期 × `["dcap"]`（v1 最大合法） | 原样 |
| 3 | `valid-1w-satellite-with-1d-base` | 基准 `1d` + 卫星 `1w`（口径 10 正例） | 原样 |
| 4 | `valid-empty-indicators` | `indicators: []`（边界：无指标 pane） | 原样 |
| 5 | `dedup-two-identical-indicators` | `["dcap","dcap"]`（**2 个重复项**） | `["dcap"]`；`paneCountAfterDedup=2` |
| 6 | `dedup-n-identical-indicators-cannot-forge-over-12-panes` | 4 周期 × `["dcap"]×11`（**n 个重复项** + **无法用重复项构造 >12 pane**） | `["dcap"]`；`paneCountAfterDedup=4` |
| 7 | `dedup-makes-legal-repeated-indicators-over-raw-pane-budget` | 4 周期 × `["dcap"]×5`（原始长度 16 pane 越限，**去重后合法 ⇒ 200**） | `["dcap"]`；`paneCountAfterDedup=4` |

### 3.2 拒绝（400）——判据为**被拒维度名**

| # | name | input 关键点 | errorMustContain | 依据 |
|---|---|---|---|---|
| 8 | `pane-over-limit-after-dedup-names-dimension` | 4 周期 × `["dcap","macd","kdj","boll"]`：**去重后 13 pane > 12** | `indicators` | §7.4（+ `paneCountAfterDedup=13` / `paneGuardErrorMustContain=indicators`） |
| 9 | `reject-empty-periods` | `periods: []` | `periods` | §2-1/4 |
| 10 | `reject-more-than-4-periods` | 5 周期 | `periods` | §2-4 / §7-2 |
| 11 | `reject-duplicate-periods` | `["1m","1m"]`（periods **不去重落库**，必须拒） | `periods` | §2-7 |
| 12 | `reject-1mo-period` | `["1m","1mo"]` | `periods` | §2-1/2 / §8 |
| 13 | `reject-satellite-below-base` | `["1d","1h"]`（卫星 < 基准） | `periods` | §2-2 / §7-3 |
| 14 | `reject-1w-with-base-below-1d` | `["1m","1w"]` | `periods` | §2-3（口径 10） |
| 15 | `reject-heights-key-mismatch` | `periods=["1m","5m"]` 但 `heights={1m,15m}` | `heights` | §2-5 |
| 16 | `reject-heights-below-min` | `heights={"5m":40}` | `heights` | §2-5（[80,1200]） |
| 17 | `reject-heights-above-max` | `heights={"5m":1201}` | `heights` | §2-5 |
| 18 | `reject-unsupported-indicator` | `["ma"]` | `indicators` | §2-6 |
| 19 | `reject-unsupported-indicator-among-supported` | `["dcap","macd"]`（去重不得掩盖未支持项） | `indicators` | §2-6 |

**覆盖守卫（两侧共同钉死向量集合，防止"改向量一起变绿"）**：Rust 侧 `contract_vectors_cover_required_rules` 显式列出上述 19 个 name，缺一即红；TS 侧对每条向量生成独立用例（name 进入用例名 ⇒ 缺失即红）。

## 4. 断言口径

- **200**：`归一化输出 == expect.normalized`（Rust 侧 `MultiPeriodConfigDto` `PartialEq`；TS 侧**键序无关稳定序列化**后比对，因 Rust `heights` 为 `BTreeMap` 键序升序）。
- **400**：必须拒绝，且错误串 `contains(expect.errorMustContain)`（Rust：`Err(String)`；TS：`ApiError.status === 400 && message.includes(...)`；mock 的 message 前缀 `HTTP 400: ` 不影响 `includes`）。
- **纯函数附加**：`paneCountAfterDedup` ⇒ `multi_period_pane_count`；`paneGuardErrorMustContain` ⇒ `verify_multi_period_panes` 的 `Err` 命中。
- **崩溃判据**：任何 crash / core dump 必须记录（本轮 0 例，全部为断言失败）。

## 5. 边界与例外

- TS 侧每条向量独立 `createMockClient()` ⇒ 无跨用例状态耦合（mock 有内存态 `multiPeriodConfig`）。
- 未纳入：`GET` 读落韧性（无键/坏 JSON/越界旧值 ⇒ 默认，`02-spec.md` §2）；`format` 层错误（如 `periods` 非数组）——派单未要求，且需两侧 JSON 反序列化层对标；**建议 D5-2 视 mock 修复情况自行决定是否补**。
- 未纳入：HTTP 级真实 axum 负例（既有 `api_multi_period_config.rs` 已覆盖，本门禁不重复造；且需 DB ⇒ 违反本轮 0 写请求）。

## 6. 覆盖目标

| 目标 | 判据 |
|---|---|
| 两侧对全部 19 条向量给出**同一**接受/拒绝 | Rust `all_contract_vectors_match_backend_validation` 绿 + TS 文件全绿 |
| 去重语义（计数 + 归一化）在两侧都基于**去重后集合** | 向量 #5/#6/#7 的 normalized + `paneCountAfterDedup` |
| 每条 400 的错误串可定位被拒维度 | 12 条 400 向量的 `errorMustContain` |
| 向量集合不被削弱 | Rust `contract_vectors_cover_required_rules`（19 name 必备） |
| 生产代码零改动 | 见执行报告 §1 |

## 7. 交接口径（给 D5-2 实现车道）

- 只允许改 `web/src/api/mock.ts`（`assertMultiPeriodConfig` + `saveMultiPeriodConfig` 归一化回显）：**indicators 去重（保留首次出现顺序）+ pane 计数用去重后集合**；`periods` **不得**去重（向量 #11 要求拒）。
- 转绿判据：`web/src/api/multiPeriodMockParity.test.ts` 20/20 通过（`npx vitest run src/api/multiPeriodMockParity.test.ts`），且 `crates/web/tests/multi_period_contract_vectors.rs` 保持 4/4 绿。
- **不得**通过删改 `contract-vectors.json` 条目转绿（Rust 侧覆盖守卫 + 两侧同文件会同时红）。
