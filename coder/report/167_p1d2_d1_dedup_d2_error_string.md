# P1-D-2 实现修复报告：D1 去重语义 + D2 pane 错误串维度名

- **本文件路径**：`coder/report/167_p1d2_d1_dedup_d2_error_string.md`
- 时间：2026-09-14 21:00–21:03（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `d6462da229f9264777e414be827d9d1017600778` + 工作树 P1 未提交改动）
- 上游：`design/15-multi-period/02-spec.md` §2-6 / §7.4（架构师已定稿契约）；P1-C 独立验收缺陷 D1/D2；P1-D-1 红测试交付（`tester/design/265_p1d1_red_tests_design.md`）
- 证据目录：`coder/evidence/167_p1d2/`（5 个原始输出文件）

---

## 1. 改动文件清单（区分 tangle 生成物与手写）

| 文件 | 类型 | 变更 | 行（本车道净变更） |
|---|---|---|---|
| `design/07-app-plane/00-web-api.md` | **手写事实源**（doc-first） | dto.rs / rest.rs 两个 `{.rust file=…}` 代码块同步契约 | +20 / −9（仅相关块） |
| `crates/web/src/dto.rs` | **tangle 生成物** | D1 去重：新增 `normalize_multi_period_indicators`；`multi_period_pane_count` 按去重集合计数；`validate_multi_period_config` 归一化并返回规范形态；`multi_period_config_or_default` 返回规范形态；D2 错误串含被拒维度名 | **+33 / −12** |
| `crates/web/src/rest.rs` | **tangle 生成物** | `put_multi_period_config` 改为「校验通过 → 用规范化 DTO 落库/回显」 | **+7 / −3** |
| `coder/evidence/167_p1d2/*.txt` | 手写证据 | 沙箱重生成清单 / 最小 diff / 自测输出 | 新增 5 文件 |
| `coder/report/167_p1d2_d1_dedup_d2_error_string.md` | 手写报告 | 本文件 | 新增 |

行数口径：以「反推的 pre-change 工作树」为基线（排除 P1 既有改动），见 `coder/evidence/167_p1d2/03_minimal_change_diff.txt`。

**未触碰**：既有测试文件、前端代码、迁移、ABI/引擎、其它 137 个 tangle 生成物。**未 `git add/commit/stash`**（`git diff --cached` 为空）。

---

## 2. 问题解决 / 新增能力

### D1（`indicators` 未按 §2-6 去重）
- 旧：`PUT ["dcap","dcap"]` ⇒ 200 且**原样落库**；pane 计数按**原始数组长度** ⇒ 语义等价的 `["dcap"]×11` 被判 23 pane 而 **400「超上限 12」**（合法配置被误拒）。
- 新：
  1. `normalize_multi_period_indicators(&[String]) -> Vec<String>`：**去重（保留首次出现顺序）**。
  2. `multi_period_pane_count`：`1 + (periods−1) × |去重后 indicators|` —— **计数基于去重集合**。
  3. `validate_multi_period_config`：校验通过后**归一化** `indicators` 并**返回规范形态**（签名 `Result<MultiPeriodConfigDto, String>`）。
  4. `put_multi_period_config`：用校验返回的规范 DTO **落库 / 回显** ⇒ 去重**落库**，而非只在计数时去重。
  5. `multi_period_config_or_default`（GET 读落）：合法存量同样返回规范形态。

### D2（pane 越限错误串缺被拒维度名）
- 旧：`总 pane 数 16 超上限 12（基准 1 + Σ_卫星指标 pane）`（句中「pane」只是算式量词）。
- 新：`indicators 去重后总 pane 数 16 超上限 12（基准 1 + Σ_卫星(去重后指标) pane）` —— 含**被拒字段名 `indicators`**，同时保留 `pane` 字样（既有断言 `err.contains("pane")` 仍满足）。

### D3
P1-D-1 已在 `crates/web/tests/multi_period_pane_budget.rs` 头注释完成修正（原文「v1 HTTP 不可达 >12」已被反证 ⇒ 现表述「去重语义正确后总 pane ≤ 4，HTTP 层无法构造 >12；未去重时的 400 是假象；P2 起补 HTTP 负例」）。本车道**复核确认已修正，无需再改**。

### D4
`web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx` 的 D4 UI 级用例（乐观更新 / 失败回滚 / 关闭零残留）由 P1-D-1 交付时**即为绿**（覆盖缺口，非缺陷），本车道复核保持绿（前端全量 628 passed）。

---

## 3. 架构对齐

- 变更全部落在既有三层：**契约事实源 `design/07-app-plane/00-web-api.md`（doc-first）→ tangle 生成物 `crates/web/src/{dto,rest}.rs`**；未新增模块/依赖/接口层。
- 语义口径引用既有规格：`02-spec.md` §2 校验 6（`indicators` 去重）+ §7.4（计数基于去重集合、错误信息含被拒维度名）。
- 存储仍走 `ConfigStore::set`（jsonb，key=`multi_period`），**无迁移**。
- 形状对齐既有先例 MA：`validate_ma_windows` 返回「归一化结果」供 handler 落库；本车道把 `validate_multi_period_config` 对齐为「校验 + 归一化，返回规范 DTO」。

---

## 4. 实现方式（关键决策）

1. **归一化由校验函数返回，而非 handler 二次归一**：保证「校验输出 = 落库形态」不变式，避免前后端/多处口径漂移。对齐 MA 先例（`validate_ma_windows` 返回归一化 Vec）。
2. **仅在指标维度归一**：`periods` 重复仍为**拒绝**（§2 校验 7），保持既有 400 语义不变。
3. **D2 错误串同时含 `indicators` 与 `pane`**：既满足 D2 判据（`names_rejected_dimension`），又不破坏既有 `err.contains("pane")` 断言。
4. **GET 读落也归一**：`multi_period_config_or_default` 对合法存量返回规范形态，防止「历史带重复项存量」重新落回读侧。
5. 不改 HTTP 契约（状态码/字段不变），不改前端；`web/src/api/mock.ts::assertMultiPeriodConfig` 的前后端 mock 镜像**本轮不动**（见 §7 残余）。

---

## 5. tangle 单向工作流（doc-first）

1. 先改 `design/07-app-plane/00-web-api.md` 的 dto.rs/rest.rs 契约块。
2. 在 **/tmp 沙箱**（`mktemp`，拷贝 `entangled.toml` + `design/` + 全部 `file=` 目标；删 `.entangled`）跑 `entangled tangle -f`（**未在仓库内跑 tangle**）。
3. **只拷回** `crates/web/src/dto.rs` 与 `crates/web/src/rest.rs`（`cmp` 证明与沙箱重生成逐字节一致）。
4. 沙箱拆除（无残留）。

**门禁**：`./scripts/check-tangle.sh` ⇒ `exit=0`
`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。`

---

## 6. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| D1/D2 纯函数红→绿 | `cargo test -p web --test multi_period_pane_budget` | **8 passed / 0 failed**（P1-D-1 时 5 passed / 3 failed） |
| D1 HTTP 红→绿 | `cargo test -p web --test api_multi_period_config` | **17 passed / 0 failed**（P1-D-1 时 15 passed / 2 failed） |
| 全 crate 零回归 | `cargo test -p web --no-fail-fast` | **109 passed / 0 failed**（14 个 target 全绿） |
| 前端全量 | `cd web && npx vitest run` | **68 files / 628 tests：628 passed / 0 failed**（含 D4 用例） |
| 类型检查 | `cd web && npx tsc -b`（本地二进制） | `exit=0` |
| 生成物门禁 | `./scripts/check-tangle.sh` | `exit=0` |

**既有生成物零变化（sha256 清单）**：139 个 tangle 生成物逐项 `cmp` 沙箱重生成 ↔ pre-change 基线 ⇒ **仅 `crates/web/src/dto.rs`、`crates/web/src/rest.rs` 2 项不同，其余 137 项逐字节一致（sha256 零变化）**。
证据：`coder/evidence/167_p1d2/01_sandbox_regen_manifest.txt`（139 行 sha256 清单）、`02_sandbox_regen_vs_prechange.txt`。

**红测试转绿证据**：
- `d1_pane_count_uses_deduped_indicator_set_not_raw_length`：red `7≠4` ⇒ **ok**
- `d1_duplicate_items_cannot_forge_over_budget_and_legal_shape_is_accepted`：red「34 ≤ 12 必须允许」⇒ **ok**
- `d2_over_budget_error_names_the_rejected_dimension`：red（错误串无维度名）⇒ **ok**
- `d1_duplicate_indicators_are_normalized_200_and_readback_deduped`：red（回显 `["dcap","dcap"]`）⇒ **ok**
- `d1_duplicate_items_cannot_forge_over_budget_4_periods_always_200`：red（n=3 未归一化；n=11/12 400 误拒）⇒ **ok**

原始输出：`coder/evidence/167_p1d2/04_selftest_outputs.txt`、`05_frontend_and_gate.txt`。

---

## 7. 卫生 / 约束遵守

| 约束 | 实测 |
|---|---|
| 禁 `git add/commit/stash` | ✅ 未执行；`git diff --cached` 为空 |
| 禁仓库内跑 entangled tangle | ✅ 仅在 /tmp 沙箱跑 `tangle -f` |
| 不重启线上 | ✅ PID **3112540 存活**（未触碰） |
| 0 写请求（线上） | ✅ 未对线上 8081/8082 发任何请求 |
| 临时实例 / 端口 | ✅ HTTP 测试自建 `127.0.0.1:0`，进程退出即释放 |
| 库卫生 | ✅ `app_config[multi_period]` 收尾 **0 行**（现存键仅 `dcap`） |
| 沙箱收尾 | ✅ `/tmp/p1d2_tangle.*`、`/tmp/p1d2_before` 全拆，无残留 |

---

## 8. 残余风险 / 观察项（不修缮，仅上报）

1. **前端 mock 镜像未同步（重要）**：`web/src/api/mock.ts::assertMultiPeriodConfig`（tangle 生成物）仍按**原始长度**计 pane 且不去重（`pane = 1 + (periods−1)×indicators.length`）。本轮派单明确限定为「`crates/web/src/dto.rs` 的 D1 + D2」两件，故**未越权改动**；但 mock 契约与后端 §2-6/§7.4 口径仍不一致（mock 模式下 `["dcap"]×n` 可能被 400 拒）。**建议父级裁决是否开一张独立单修 mock + 其 design 块**（需 doc-first）。
2. **D4 计数类断言 P1 结构性恒真**：`init`/`bar:` 订阅/实例零残留断言在 P1（无卫星）恒真，属 P2 就绪回归守卫（P1-D-1 已诚实声明）。
3. **D3 无断言变化**：仅注释修正，已由 P1-D-1 完成；本车道复核确认。
4. **v1 HTTP 层无 >12 pane 负例**：去重语义正确后 v1 总 pane ≤ 4，HTTP 层不可达 >12；D2 护栏以纯函数契约守护，P2 起补 HTTP 负例（§7.4 已声明）。

---

**VERDICT: GREEN(带观察项)**
