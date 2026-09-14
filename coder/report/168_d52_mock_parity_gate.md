# D5-2 实现报告：修 mock 使其与后端口径一致（parity 门禁转绿）

- **本文件路径（自引用）**：`coder/report/168_d52_mock_parity_gate.md`
- 车道：Coder（Worker）｜时间：2026-09-14 21:14–21:17（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `d6462da`；工作树含 P1 未提交改动）
- 上游依据：`design/15-multi-period/02-spec.md` §2 校验 6 / §7.4、架构师裁决；D5-1 交付（`tester/design/267_d51_contract_vectors_parity_red_design.md`、`design/15-multi-period/contract-vectors.json`、两侧消费测试）
- 证据目录：`coder/evidence/168_d52_mock_parity/`

---

## 1. 改动文件清单

| 文件 | 类型 | 规模 |
|---|---|---|
| `web/src/api/mock.ts` | 生产（手写，非 tangle 生成物） | 相对**本轮起始工作树**约 +30/−11（相对 HEAD 的 diff 含 P1 既有新增，见 §6） |
| `web/src/api/mock.test.ts` | 测试（**只新增**，追加以往 describe 块，未删改既有断言） | +44 行 |
| `coder/evidence/168_d52_mock_parity/*` | 证据（新增） | 3 个文本文件 |
| `coder/report/168_d52_mock_parity_gate.md` | 本报告（新增） | — |

**未改动**：后端（`crates/web/**`）、设计（`design/**`）、向量文件 `contract-vectors.json`、tangle 生成物、`client.ts`/`types.ts` 的接口（`ApiClient.saveMultiPeriodConfig` 签名不变）。**未 stage / 未 commit / 未 stash**（本轮硬约束禁止；`git diff --cached` 为空）。

## 2. 解决的问题（口径漂移 D5-①）

`web/src/api/mock.ts::assertMultiPeriodConfig` 与后端 `web::dto::validate_multi_period_config` 不同构：

| 维度 | 后端（P1-D-2/D-3 已修，PASS） | mock（修前） | mock（修后） |
|---|---|---|---|
| `indicators` 归一化 | 去重（保序），**返回值落库/回显** | 原样落库/回显 | 去重（保序），返回值落库/回显 |
| 总 pane 计数 | `1 + (periods-1) × 去重后指标数` | `1 + (periods-1) × 原始长度` | 同后端（基于去重后集合） |
| 越限错误串 | 含被拒维度名 `indicators` | `总 pane 数 N 超上限 12`（无维度名） | `indicators 去重后总 pane 数 N 超上限 12（基准 1 + Σ_卫星(去重后指标) pane）` |

后果（D5-1 红向量证明）：`["dcap","dcap"]` 原样落库；`["dcap"]×5 / ×11` 被误判 >12 pane 而 400。

## 3. 实现方式（架构不变，仅对齐既有契约）

`web/src/api/mock.ts` 内（均为模块内私有，**未导出新符号 ⇒ 未扩公共接口**）：

1. 新增私有纯函数 `normalizeMultiPeriodIndicators(indicators)`：首次出现顺序去重（与后端 `dto::normalize_multi_period_indicators` 同构）。
2. `assertMultiPeriodConfig` 由 `void` 改为**返回归一化后的 `MultiPeriodConfigDto`**，与后端 `validate_multi_period_config -> Result<MultiPeriodConfigDto, String>` 同构：
   - 7 条校验顺序与后端逐条一致（periods 空/>4/重复 → 基准/卫星合法 + 卫星 ≥ 基准 → 1w 需 ≥1d 基准 → heights 键一致 + 值 ∈[80,1200] → indicators ⊆ {dcap}）；
   - pane 计数改用 `normalizedIndicators.length`；
   - 越限 `bad(...)` 消息含 `indicators`（被拒维度名）。
3. `saveMultiPeriodConfig`（mock PUT 路径）用**校验返回值**落库，再回显深拷贝；即「去重落库」而非只在计数时去重。回显改为 `periods/heights/indicators` 拷贝，避免暴露内部可变引用（与同文件 `getMultiPeriodConfig` 口径一致；非契约变更）。
4. `DEFAULT_MULTI_PERIOD_CONFIG` 未改（默认形态与后端 `Default` 一致，向量 #1 已覆盖）。

**架构对齐声明**：改动全部位于「前端 mock ApiClient 适配层」（`web/src/api/mock.ts`，仅用于演示/测试），不触碰 `ApiClient` 接口、DTO 类型、后端 handler/纯函数、层边界或依赖方向；无新增依赖。

## 4. TDD 轨迹（红 → 绿）

- **红（D5-1 既有 parity 测试）**：`vitest run src/api/multiPeriodMockParity.test.ts` ⇒ `3 failed | 17 passed (20)`：
  - `dedup-two-identical-indicators`（回显未去重）
  - `dedup-n-identical-indicators-cannot-forge-over-12-panes`（`HTTP 400: 总 pane 数 34 超上限 12`）
  - `dedup-makes-legal-repeated-indicators-over-raw-pane-budget`（`总 pane 数 16 超上限 12`）
- **红（本轮新增加强测试，先写后实现）**：`mock.test.ts` 新 describe 块 ⇒ `2 failed | 43 passed (45)`（去重落库 + 去重后计数两条红）。
- **绿**：实现后 `multiPeriodMockParity.test.ts 20/20` + `mock.test.ts 45/45`；全套 `69 files / 651 tests passed`。

## 5. 测试覆盖

- 既有只加强：`web/src/api/mock.test.ts` **新增** 3 条（未删改任何既有断言）：
  1. `["dcap","dcap"] ⇒ 回显/落库均为 ["dcap"]（GET 同）` —— 钉住「去重落库」；
  2. `4 周期 × ["dcap"]×5（原始 16 pane）⇒ 200 且归一化 ["dcap"]` —— 钉住「基于去重集合计数」；
  3. `失败不改内存态` —— 400 后 GET 仍为上次成功值。
- 两侧同源门禁（D5-1 已就绪，本轮转绿）：`web/src/api/multiPeriodMockParity.test.ts`（20/20，含 19 条向量 + 1 条文件结构守卫）与 `crates/web/tests/multi_period_contract_vectors.rs`（4/4 绿，覆盖守卫钉死 19 个向量名）。
- 未纳入（诚实声明）：HTTP 层「纯 pane 越限」不可构造（v1 受支持指标仅 `dcap` ⇒ 去重后 ≤ 1+3×1 = 4 pane），该护栏本体只在纯函数层取证（Rust 侧 `pane_guard_error_names_dimension_for_over_limit_vectors`）；mock 侧仅对齐错误串措辞，无独立断言路径。mock 的 pane 越限错误串不在公共路径可达 ⇒ 无法用黑盒断言，属预期。

## 6. 验证（命令与结论）

| 命令 | 结果 |
|---|---|
| `cd web && ./node_modules/.bin/vitest run src/api/multiPeriodMockParity.test.ts src/api/mock.test.ts` | ✅ `65 passed (65)` |
| `cd web && ./node_modules/.bin/vitest run` | ✅ `69 files / 651 tests passed` |
| `cd web && ./node_modules/.bin/tsc -b` | ✅ exit 0，无输出 |
| `cargo test -p web` | ✅ 全部 `test result: ok`（0 failed；含 `multi_period_contract_vectors` 4/4） |
| `./scripts/check-tangle.sh` | ✅ `design 与生成物一致`（沙箱重生成 + 逐字节比对；工作区未被修改） |

证据文件：`coder/evidence/168_d52_mock_parity/01_ts_parity_and_typecheck.txt`、`02_rust_and_tangle_gate.txt`、`03_vitest_full.txt`。

**卫生**：0 写请求、未触 DB（未写 `app_config.multi_period`，无需 psql 复核）；未启动任何临时实例/端口（0 进程收尾项）；线上 `eestock-app` PID `3112540` 未重启（`etime 09:23:21` 存活）、未 PUT 线上；无残留 `vitest/cargo test/check-tangle` 进程；`git diff --cached` 为空。

**越界自检**：改动文件 mtime 仅 `mock.ts` / `mock.test.ts` 为 21:14 后，其余修改文件 mtime ≤ 20:59（P1 既有）。

## 7. 观察项 / 残留风险

- `assertMultiPeriodConfig` 返回类型由 `void` 变为 `MultiPeriodConfigDto`（模块内私有，未导出）；如后续有他处需要纯函数出口（例如 TS 侧也钉 pane 护栏本体），需架构师批准新增导出。**未自行新增导出**。
- mock 与后端错误串仍非逐字节一致（mock 为 `HTTP 400: ` 前缀 + 措辞对齐）；parity 断言口径是「含被拒维度名」（与 D5-1 设计一致），不做字节级对标。
- 未纳入 D5-1 设计 §5 提到的 `GET` 读落韧性 / `format` 层错误向量（派单未要求，且需两侧 JSON 反序列化层对标）。
