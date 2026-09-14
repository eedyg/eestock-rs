# D5-3 独立验收执行报告（Tester / 独立复现 + 证据）

- **本文件路径（自引用）**：`tester/test/268_d53_independent_acceptance_execution.md`
- 证据包目录：`tester/evidence/268_d53/`（索引见其 `README.md`，含全部探针脚本）
- 执行时间：2026-09-14 21:18–21:25（本地 UTC+8）｜仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD：`d6462da`（工作树含 P1 未提交改动）｜`git diff --cached` 空｜未 add/commit/stash
- 验收对象：① `web/src/api/mock.ts::assertMultiPeriodConfig` 归一化去重 + 基于去重集合计 pane（D5-2）；
  ② mock↔backend parity 门禁（`web/src/api/multiPeriodMockParity.test.ts` + `crates/web/tests/multi_period_contract_vectors.rs`
  + 单一真相 `design/15-multi-period/contract-vectors.json`，D5-1）
- **总判定：PASS（19/19 向量两侧一致；反向变异必红；四门禁全绿；卫生干净）**

---

## 0. 测试套件结果（本次真实运行）

| 套件 | 结果 | 失败/跳过 | 备注 |
|---|---|---|---|
| `cd web && vitest run` | **69 files / 651 tests passed** | 0 failed / 0 skipped | 全量；含 parity 20、`mock.test.ts` 45、`multiPeriodClosedEquivalence` 6、`multiPeriodStore` 5、`client.test` 39 |
| `cd web && tsc -b` | **exit 0，无输出** | — | 类型面干净 |
| `cargo test -p web` | **16 binaries / 113 tests passed** | 0 failed | 含 `multi_period_contract_vectors` 4/4、`multi_period_pane_budget` 8/8、`api_multi_period_config` 17/17 |
| `./scripts/check-tangle.sh` | **exit 0：设计 与生成物一致** | — | 沙箱重生成 + 逐字节比对；工作区未被修改 |

**失败用例表（本次真实运行）**：`（无）`。
**崩溃 / core dump**：`（无）`（无 panic、无 abort、无 core 文件；上述所有命令 exit 0）。
**覆盖率摘要**：未采集（本仓库无覆盖率门禁，派单未要求）。

---

## 1. 逐项结论（派单 5 项）

### ① parity 复核 —— 同一向量文件 + 逐条一致：**PASS**
证据：`tester/evidence/268_d53/01_same_vector_file.txt`、`02_parity_matrix_both_sides.txt`

- **同一文件（不得各写一份）**：`find` 全仓仅 `design/15-multi-period/contract-vectors.json` 一份（无第二份）；
  两侧**唯一的**消费点各一处：
  - TS：`web/src/api/multiPeriodMockParity.test.ts:32` `resolve(HERE,'../../../design/15-multi-period/contract-vectors.json')`
  - Rust：`crates/web/tests/multi_period_contract_vectors.rs:53` `CARGO_MANIFEST_DIR/../../design/15-multi-period/contract-vectors.json`
  两者解析结果**同一绝对路径 / 同一 inode（66315:94662163）/ 同一 sha256（`8c72c601…`）/ 19 条**；
  `.json` 不在 `entangled.toml watch_list = ["design/**/*.md"]` ⇒ 不会被 tangle 覆盖（check-tangle 亦绿）。
- **逐条实际结论比对（不用测试断言转述）**：两侧都由**独立探针**取实际结论——
  mock 侧用 esbuild 打包 `/tmp` 探针直接调 `createMockClient().saveMultiPeriodConfig`（即 `assertMultiPeriodConfig` 的 PUT 路径）；
  backend 侧 `rustc` 直接链接**仓库已编译的真实 crate** `target/debug/deps/libweb-161b6ed0ad648e47.rlib`（0.3s，无重编译、无仓库写入），
  调 `validate_multi_period_config` / `multi_period_pane_count` / `verify_multi_period_panes`。
  19 条逐条给出 `expect / rust / mock` 三列 + `normalizeMatch`（200 比归一化深等价，400 比 `errorMustContain` 含维度名）：

  `PARITY_SUMMARY vectors=19 mismatches=0 names=[]`（19/19 两侧 status、归一化输出、错误串维度名全一致）

  另：`paneCountAfterDedup`（4 条声明）与 `paneGuardErrorMustContain`（1 条声明）与 backend 纯函数实测一致（探针 `PANE_MISMATCH`/`GUARD_MISMATCH` 计数 = 0）。

### ② mock 行为复核：**PASS**
证据：`tester/evidence/268_d53/02b_mock_behaviour_and_default.txt`、`02_parity_matrix_both_sides.txt`

| 输入 | backend 实际 | mock 实际 | 一致？ |
|---|---|---|---|
| `["dcap","dcap"]`（2 周期） | 200，normalized `indicators=["dcap"]` | 200，回显/GET `indicators=["dcap"]` | ✅（语义重复 ⇒ **200 + 去重**，两侧同一判据） |
| `["dcap"]×11`（4 周期） | 200，pane=4（去重后 1+3×1） | 200，回显 `["dcap"]` | ✅（**不再误拒**；修前为 400「总 pane 数 34 超上限 12」） |
| `["dcap"]×5`（4 周期） | 200，pane=4 | 200，回显 `["dcap"]` | ✅（修前 400「16 超上限」） |
| `enabled=false` 默认 | `Default = {false,["1m"],{"1m":420},["dcap"]}` | fresh client GET 同值 | ✅（且 = 向量#1 input/normalized；前端 6 条 `multiPeriodClosedEquivalence` 绿） |

- **规范化后落库/回显**：mock PUT `["dcap","dcap"]` ⇒ 回显 `["dcap"]`，随后 GET 亦 `["dcap"]`（去重形态进内存态，非仅在计数时去重）；
  被拒 PUT（`periods=[]` ⇒ 400）**不改内存态**（GET 仍是上次成功值/默认）。后端 `rest.rs::put_multi_period_config` 用
  `validate_multi_period_config` 的**返回值**落库 `app_config/multi_period` 并回显（代码复核 + P1-D 的 17 条端点测试绿）。

### ③ 反向证据（门禁有牙）：**PASS**
证据：`tester/evidence/268_d53/03_reverse_evidence_mock_mutants.txt`、`03b_reverse_evidence_weakened_vectors.txt`
（**变异全部在 `/tmp/d53_sb` 副本**，仓库文件 sha256 前后一致）

| 变异 | 做法 | 向量测试结果 | 独立探针结论 |
|---|---|---|---|
| A 去掉去重落库/回显 | 沙箱 `return … indicators: normalizedIndicators` → `[...cfg.indicators]` | **3 failed / 17 passed**：`dedup-two-identical-indicators`、`dedup-n-…`、`dedup-makes-legal-…` | mismatched=3（回显 `["dcap","dcap"]` 等原始形态） |
| B pane 计数改回原始长度 | `normalizedIndicators.length` → `cfg.indicators.length` | **2 failed / 18 passed**：`dedup-n-…`（400「34 超上限」）、`dedup-makes-legal-…`（400「16 超上限」） | mismatched=2（**精确复现 P1-C 误拒样本**） |
| C 削弱向量文件 | 沙箱 JSON：`dedup-two…normalized.indicators→["dcap","dcap"]`、`dedup-n….expect→{400,indicators}` | TS 门禁 **2 failed** | backend 侧同变异 **2 mismatch**（真实 crate 反驳削弱期望）⇒「改向量转绿」不成立 |

沙箱还原校验：`web/src/api/mock.ts` 与仓库 `diff -rq` 无差异、sha256 相同；沙箱向量与仓库向量逐字节相同。

### ④ 回归：**PASS**
证据：`tester/evidence/268_d53/04_regression.txt`

- `vitest` 69 files / 651 tests 全绿（parity 20/20、`mock.test.ts` 45/45、`client.test.ts` 39/39、`api/index` 4/4）；
- `tsc -b` exit 0；`cargo test -p web` 113 passed / 0 failed；`check-tangle` 绿；
- `mock.test.ts` 相对 HEAD **+44 / −0**（纯新增，无既有断言被删改）⇒ 满足「既有测试只允许加强」；
- 产物改动相对于 HEAD：`mock.ts +92 / −0`（P1+D5-2 累计；本次车道只动 mock 的两处口径）；
- `enabled=false` 等价性与 P1 其它契约未见回归（向量#1 + `multiPeriodClosedEquivalence` 6 条 + `api_multi_period_config` 17 条全绿）。

### ⑤ 卫生：**PASS**
证据：`tester/evidence/268_d53/05_hygiene.txt`

- **共享库**：`app_config` key=`multi_period` **收尾 psql 复核 0 行**（键不存在）。
  说明：`cargo test -p web` 内含 `api_multi_period_config.rs`，该 binary 会 PUT/清键（全部落库 `enabled=false`、用例内自清）；
  我在回归跑完后按派单要求 psql 复核为 0 行。
- **staged**：`git diff --cached --stat` 空；HEAD 仍 `d6462da`；`git stash list` 空。
- **归因**：20:26–20:59 的 10 个 tracked 文件 = P1 车道；`21:14:53 mock.test.ts` / `21:15:01 mock.ts` = 本轮 D5-2 车道；
  D5-1 新增交付物（parity 测试 21:12:57 / 向量文件 21:12:24 / Rust 消费侧 21:12:38）mtime 一致。
- **线上**：PID `3112540` 存活（etime 09:25:33 → 09:31:14，未重启）；本验收对 8080/8081/8082 **0 请求**（亦未读）。
- **临时资源**：未自建常驻实例（parity 在纯函数层 + mock 层取证即可，无需临时 HTTP 服务）⇒ 无端口需拆；
  `pgrep`（不自匹配写法、命令外置为脚本）为 `none`；监听端口归属仅线上 app / postgres / scrylink / chrome / adb。
- 沙箱 `/tmp/d53_sb` 已在验收结束后整体删除（证据已归档进 `tester/evidence/268_d53/`）。

---

## 2. 观察项 / 残留风险（不阻塞 PASS）

- **R1（诚实边界）**：向量 `pane-over-limit-after-dedup-names-dimension` 在 v1 HTTP 面**不可构造纯 pane 越限**
  （受支持指标仅 `dcap` ⇒ 去重后最多 4 pane），其 400 实由「未支持指标」规则命中（两侧错误串均为
  `indicators 含未支持项：macd`，均含维度名 `indicators`，故向量断言成立但与 note 描述的判据不同）。
  pane 护栏**本体**只在 backend 纯函数层被 `multi_period_pane_budget.rs`/`multi_period_contract_vectors.rs` 钉住；
  mock 侧该护栏的措辞无黑盒用例可覆盖（不可达）。与 `coder/report/168` §5 自述一致。
- **R2**：向量文件内容**无 hash 钉死**，仅靠 Rust 侧 19 个名称覆盖守卫 + 两侧真实实现投票；本次用变异 C 证明
  「削弱向量会让两侧都红」，但若未来 mock 与后端**同向漂移**且向量被同步改写，门禁不会独立发现（需人审/哈希钉死才可根除）。
- **R3**：mock 与后端的 400 错误串并非逐字节一致（mock 带 `HTTP 400: ` 前缀、措辞对齐），parity 口径是「含被拒维度名」——与 D5-1 设计一致，属**故意**，非缺陷。
- **R4（小观察）**：默认配置常量现存在于两处（`web/src/api/mock.ts` 的 `DEFAULT_MULTI_PERIOD_CONFIG`，P1 车道新增导出；
  `web/src/features/dashboard/multiPeriodStore.ts` 同名常量）。本次实测两者与向量#1 一致，但**无测试钉住二者相等**（存在未来漂移可能）。

### 最小修正建议（均非阻塞，且不扩公共接口）
1. **R4**：在 `web/src/api/mock.test.ts`（或 parity 测试文件）加 **1 条**断言：mock 默认 GET 结果深等价于
   `contract-vectors.json` 的 `valid-single-base-default.expect.normalized`（现有向量已含该形态，**无需改向量**）。
   成本 ≈ 3 行，可钉住「默认两侧等价」不漂移。
2. **R1**：把该向量 `note` 补一句「v1 受支持指标仅 dcap ⇒ HTTP 面由未支持项规则先命中；pane 护栏本体由纯函数测试取证」
   （现状 note 已接近，仅措辞对齐即可）。**不建议**为 mock 新增导出/测试钩子（会扩 mock 公共面，收益不抵成本）。
3. **R2**：如需彻底消除「同向漂移」风险，可在向量文件加 `vectorsVersion`/`hash` 字段并在两侧各加一条守卫断言；
   属**新需求**，建议由架构师决定是否派单，本轮不做。

---

## 3. 纪律自检

- 只做指派的事：未改任何实现/接口/架构（仓库 `mock.ts`、后端、`contract-vectors.json` 前后 sha256 一致）；变异只在 `/tmp` 副本；
- 未对失败做任何分析定位/修复尝试（本报告只记录「什么、在哪、证据」；R1 仅为**自述边界的事实陈述**，不含修复实现）；
- 未固定任何仓库内插桩；未跑 entangled tangle（只在 `check-tangle.sh` 的沙箱内由其自行重生成）；
- 临时资源全拆；输出末行打印 VERDICT。
