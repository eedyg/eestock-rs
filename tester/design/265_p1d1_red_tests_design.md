# P1-D-1 红测试设计报告：D1 去重语义 / D2 错误串 / D3 注释修正 / D4 UI 级开关

- **本文件路径**：`tester/design/265_p1d1_red_tests_design.md`
- 时间：2026-09-14 20:44–20:58（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `d6462da229f9264777e414be827d9d1017600778` + 工作树 P1 未提交改动）
- 上游依据：`design/15-multi-period/02-spec.md` §2-6 / §7.4 / §7.5（架构师 P1-D-1 前已改），P1-C 独立验收执行报告 `tester/test/264_p1c_independent_acceptance_execution.md`（缺陷 D1/D2/D3/D4）
- 执行报告：`tester/test/265_p1d1_red_execution.md`；证据目录：`tester/evidence/265_p1d1_red/`
- 本文件由 Tester 车道产出；**未改动任何产品/设计文件**（只改 3 个 P1 测试文件，见执行报告 §1）

---

## 1. 任务口径与策略

| 项 | P1-C 事实 | 本设计的判据（落成测试） | 期望终态 |
|---|---|---|---|
| **D1** | `indicators` 未按 §2-6 去重：`PUT ["dcap","dcap"]` ⇒ 200 且原样落库；pane 计数按**原始长度** ⇒ `["dcap"]×11` 被误拒 400 | ① HTTP：重复项 ⇒ 200 + 回显/读回归一化为 `["dcap"]`；② 计数：`["dcap"]×n` 与 `["dcap"]` 计数**相同**；③ 重复项**无法**伪造 >12 pane（4 周期形态必 200） | 红 → 实现后绿 |
| **D2** | pane 错误串只含算式里的「pane」字样，**无被拒字段名** | 纯函数路径构造越限 ⇒ 错误串必须含**可定位的被拒维度名**（`indicators`，或字段标记形式的 `pane`） | 红 → 实现后绿 |
| **D3** | 测试文件头「v1 HTTP 不可达 >12」的免责理由已被 P1-C 反证 | 注释改为准确表述：v1（去重后）总 pane ≤ 4 ⇒ 无法构造 >12；未去重时的 400 是假象；P2 起必须补 HTTP 级负例 | 改文，无断言变化 |
| **D4** | Toolbar 开关的乐观更新/失败回滚/关闭零残留**无 UI 级测试**（仅 store 级 + 关闭态等价） | 页面级（Toolbar 点击）取证：乐观 `aria-pressed=true`、失败回滚 `false` + 无副作用、成功 `true`、再关闭 `false` + 零残留 | 覆盖缺口补齐（见 §4 诚实声明） |

**测试层级分布**

| 层 | 文件（本轮**加强**，不新建重复文件） | 手段 |
|---|---|---|
| 纯函数契约（`web::dto`） | `crates/web/tests/multi_period_pane_budget.rs` | 直接调用 `multi_period_pane_count` / `verify_multi_period_panes`（无 DB、无 IO） |
| HTTP 契约（真实 axum + 真实 PgPool） | `crates/web/tests/api_multi_period_config.rs` | 临时 listener `127.0.0.1:0` + 共享 dev 库同键（`multi_period`），`MULTI_PERIOD_LOCK` 串行 |
| UI 级（React + jsdom） | `web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx` | `DashboardPage` 真实渲染；klinecharts 整体打桩；`saveMultiPeriodConfig` 以 **deferred** 完全受控 |

**mock / stub 策略**
- Rust 侧不打桩：纯函数直接调用；HTTP 侧只打**本进程自建**临时端口实例（不触碰线上 8081/8082）。
- 前端侧：`stubApi`（契约 mock 底座）+ 覆写 `getKline` / `getMultiPeriodConfig` / `saveMultiPeriodConfig`；`WsClient` 用假实现（可数 handler ⇒ 订阅计数证据）；klinecharts 桩（jsdom 无 canvas）。
- D4 的 PUT 用 `deferred`：既能断言「PUT **未决**窗口内已是 true」（乐观更新的判别点），也能注入 reject（回滚判别点）。

---

## 2. 用例清单（Given–When–Then）

### 2.1 D1 — 去重语义（红）

**A. 纯函数（`multi_period_pane_budget.rs`）**

| 用例 | Given | When | Then |
|---|---|---|---|
| `d1_pane_count_uses_deduped_indicator_set_not_raw_length` | 4 周期（1 基准 + 3 卫星） | 分别以 `["dcap"]` / `["dcap"]×2` / `×3` / `×11` / `×12` / `×24` 计算 | 全部 = `4`（与去重后集合一致）；2 周期 × `["dcap"]×11` = `2`（不是 12） |
| `d1_duplicate_items_cannot_forge_over_budget_and_legal_shape_is_accepted` | 同上；另备 `ind0..ind4`（5 个**不同**指标） | `verify_multi_period_panes` | 重复 n∈{1,2,3,11,12,24} ⇒ `Ok`（不误拒、不伪造 >12）；5 个不同指标 ⇒ `Err`（护栏不得被削弱） |

**B. HTTP（`api_multi_period_config.rs`）**

| 用例 | Given | When | Then |
|---|---|---|---|
| `d1_duplicate_indicators_are_normalized_200_and_readback_deduped` | 空键 | `PUT {periods:["1m","5m","15m"], indicators:["dcap","dcap"]}` | **200**；PUT 回显 `indicators == ["dcap"]`；GET 读回 == 归一化后的完整配置 |
| `d1_duplicate_items_cannot_forge_over_budget_4_periods_always_200` | 空键 | `PUT {periods:4 周期, indicators:["dcap"]×n}`，n∈{3,11,12} | 三个样本**全 200**（去重后 1+3×1=4 ≤ 12）；回显/读回归一化为 4 周期 × `["dcap"]`；n=11/12 不得再出现 400（P1-C 误拒样本） |

> 说明：`["dcap"]×11` 是 P1-C 实测被判「23 pane > 12」的样本；本设计把它放在 **HTTP 层**并要求 200，正是「**无法通过重复项构造 >12 pane**」的可复现证据。
> 计数全量观测（先收集 3 个样本再汇总断言）⇒ 红阶段一次性给出 n=3 的「200 但未归一化」与 n=11/12 的「400 误拒」两种事实。

### 2.2 D2 — 错误串含被拒维度名（红）

| 用例 | Given | When | Then |
|---|---|---|---|
| `d2_over_budget_error_names_the_rejected_dimension` | 4 周期 + 5 个不同指标（1+3×5=16 > 12，纯函数路径；v1 HTTP 面无法构造） | `verify_multi_period_panes` | `Err` 串必须含**可定位的被拒维度名**（红断言） |
| `d2_dimension_predicate_boundary_is_pinned`（**判据自检，绿**） | 10 条正/反样本 | `names_rejected_dimension` | 现状串/仅数量串 ⇒ 判 false；`indicators` 与各 `pane` 字段标记形式 ⇒ 判 true（**把口径钉死在代码里，防漂移**） |

**判据边界（**重要**：本设计对「含被拒维度名」的精确化，供实现方与父级复核）**

- 接受：`indicators`（v1 中真正需要缩减的**请求字段**）；或**字段标记形式**的 `pane`：`pane:` / `pane：` / `pane=` / `"pane"` / `[pane]` / `` `pane` ``，或错误串**以 `pane` 开头**。
- 不接受（P1-C D2 的判定）：`总 pane 数 16 超上限 12（基准 1 + Σ_卫星指标 pane）` —— 句中「pane」只是算式量词，不是被拒字段名，调用方无法据此定位该改哪个字段；与之对照，`periods` / `heights` / `indicators` 负例都含字段名。
- 验收标准（可机检）：`err.contains("indicators") || <上述字段标记形式>` ⇒ 绿色；天然满足（例如在错误串前缀 `indicators`、或写成 `pane:` / `pane=`）。

### 2.3 D3 — 头注释修正（改文）

`crates/web/tests/multi_period_pane_budget.rs` 文件头 `### 为什么用纯函数而不是 HTTP 负例（修订版：P1-D-1 D3 修正）` 段替换原免责论断：

1. 原论断「任何 >12 的 body 都会先被 `indicators` 未支持项规则拒掉」**已被 P1-C 实测反证**（`3 周期 × ["dcap"]×11` 能构造 23 pane 并被 pane 护栏拦下）；
2. **准确表述**：v1 受支持集合 = `{dcap}` 且**去重后** ⇒ 总 pane ≤ 1+3×1 = 4 < 12 ⇒ **去重语义正确时 HTTP 层无法构造 >12**；未去重时的 400 是**假象**（那是缺陷 D1，不是护栏可达性证据）；
3. HTTP 面在 v1 只保留**正例**（去重后最大合法形态 200、重复项不得伪造 >12）；
4. **P2 起**（受支持指标集合扩张 ⇒ 去重后仍可 >12）**必须补 HTTP 级负例**。
5. 另加一句事实澄清：本文件**非 tangle 生成物**（`file=` 未在 `design/**` 声明）⇒ 改注释无需 doc-first。

### 2.4 D4 — Toolbar 开关 UI 级（覆盖缺口）

新增 `describe('D4 Toolbar「多周期」开关 UI 级（乐观更新 / 失败回滚 / 关闭零残留）')`，2 个用例（页面级，点击 `[role=button][name=多周期]`）：

| 用例 | 步骤 | 断言 |
|---|---|---|
| 失败回滚 | ① 点击（PUT 挂起不 resolve）② reject | 点击后**立即** `aria-pressed=true`（乐观）+ PUT 报文 `{enabled:true, periods:["1m"], heights:{"1m":420}, indicators:["dcap"]}`；未决窗口内 `init` 计数 / `bar:` 订阅 / `getKline` 计数**不变**；reject 后回滚 `false`，且主图 DOM 指纹、实例/订阅/取数计数均回初态、无卫星标记元素 |
| 成功 + 关闭零残留 | ① 点击 → resolve ② 再点击 → resolve | 成功保持 `true`；关闭后 `false` 且 PUT 报文 `enabled:false`；**零残留**：DOM 指纹 / `init` 计数 / `bar:` 订阅 / `getKline` / `getMultiPeriodConfig` 计数全部 == 初态；静默窗 120ms 内无迟到实例/订阅/取数 |

**反向证据（变异检验，仓库零改动，/tmp 沙箱）**：M1 删除 catch 里的回滚 ⇒ 失败回滚用例红；M2 改成非乐观（先 await 再改态）⇒ 两个用例都红。原始输出见 `tester/evidence/265_p1d1_red/06_d4_reverse_evidence.txt`。

---

## 3. 边界与例外覆盖清单

| 类别 | 覆盖 |
|---|---|
| 去重边界 | n=1（无重复）、2、3、11、12、24；1 卫星 vs 3 卫星 |
| 预算边界 | 恰好 12（允许）、13（拒绝）、16（拒绝 + 错误串判据）、4（v1 合法最大） |
| 归一化边界 | PUT 回显 vs GET 读回（两处都必须归一化，防「只在计数时去重」） |
| 不越界保证 | 反向对照用例：5 个**不同**指标仍必须被拒（护栏不被 D1 修法削弱） |
| 前端时序边界 | PUT **未决**窗口（乐观判别点）、reject、resolve、关闭后静默窗 120ms |
| 幂等/残留 | 关闭后计数 == 初态；无 satellite/卫星 标记元素 |

## 4. 期望红/绿与诚实声明

| 用例组 | 期望 | 依据 |
|---|---|---|
| D1 纯函数（2 例） | **红**（实测 7≠4、34 pane 误拒） | 现状按原始长度计数 |
| D1 HTTP（2 例） | **红**（实测 n=3 回显未归一化；n=11/12 400 误拒） | 现状未去重 |
| D2（1 红 + 1 绿自检） | **红**（现状错误串不含被拒维度名）；判据自检 **绿** | 见 §2.2 判据 |
| D3 | 改文（无断言） | 注释事实错误 |
| D4（2 例） | **绿**（实测 6/6 passed） | P1-C D4 是**覆盖缺口**而非缺陷：实现车道 P1 的乐观更新 + 失败回滚已落地，故本段立即转绿；其价值是**回归网**（M1/M2 变异即红） |

- 未做（本轮范围外，明确不做）：不改产品代码；不补 HTTP 负例（v1 不可达，D3 已声明 P2 起补）；不测同步算法/卫星渲染（P2+）。
- 已知覆盖空洞（诚实）：D4 中「实例/订阅计数零残留」断言在 P1 **结构性恒真**（`MultiPeriodChartStack` 尚不创建卫星）⇒ 现阶段真正有牙的是「乐观 true / 回滚 false / PUT 报文 / DOM 指纹」；计数断言是 **P2 就绪的回归守卫**。
- 前端镜像风险（**未落测试，仅提示父级**）：`web/src/api/mock.ts::assertMultiPeriodConfig` 同样按**原始长度**计 pane 且不去重（`pane = 1 + (periods-1)×indicators.length`）⇒ D1 若只修后端，mock 契约仍与后端不一致（mock 会把 `["dcap"]×n` 判 >12 而拒）。是否本轮一并修，由父级裁决（本车道不越权扩测）。
