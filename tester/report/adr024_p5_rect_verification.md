# ADR-024 P5 **整改复验**报告（N1–N4/N6 独立复核 + ⑤ `dispose()` 爆炸半径裁定）

- **本报告文件位置**：`tester/report/adr024_p5_rect_verification.md`
- 角色：tester（**只验不改生产代码**；本批仅新增 tester 车道测试/证据，**未** `git add` / `git commit`）
- 复验对象：`coder/report/adr024_p5_rectification.md`（worker 交付）+ 其证据 `coder/evidence/adr024_p5_rect/`；**不复用 worker 断言**（自写载体见 §0.3）
- 契约出口：`design/16-backtest-scalability/02-spec.md` §3.1/§3.1.1/§5.1；`contract-vectors.json::span_limit_semantics`；`03-test-plan.md` §5（反假绿条款）
- 环境：临时库 `tmp_p5rv_1789721514`（真渲染/⑤）+ `tmp_p5rv2_1789722163`（后端全量）+ `tmp_p5rv3_1789722729`（N1 全码补测）—— 三个**全部 `DROP … WITH (FORCE)`**，见 §6；`vite dev 127.0.0.1:15173`、第二实例 `127.0.0.1:18099`（生产构建 SPA + 临时库）
- 时间：2026-09-18 16:45–17:12 CST
- 证据目录：`tester/evidence/254_adr024_p5_rect_verify/`（含 `pw/` 三条 harness/规格 + 7 张真渲染截图）

---

## 0. 判词（结论最前）

### 0.1 逐项裁决

| 项 | 判词 | 一句话（判据摘要） |
|---|---|---|
| **① N1 结构化错误** | **PASS**（残余 **N1-r**，LOW，非阻塞） | 静态：`workbench.rs` 21 处 + `strategies.rs` 1 处 `StatusCode::BAD_REQUEST` **全部**位于 `structured(` 调用内，**无** `err(StatusCode::BAD_REQUEST…)` 字符串形状；web 层**零**消息内容判码。HTTP：**53 条** 400 用例全部 `error` 为**对象** + `code`/`message`/`detail` 齐备、`detail` 为对象，覆盖 **27/27 个稳定码**（含 `params_invalid`/`config_invalid`）；两条反向证据（web 侧改码 / application 侧改 `classify_config_error` 前缀）**必红**并逐字节复原。前端 9 例（含未知码回退 + 两条消费路径）。**残余 N1-r**：提交/试算路径的 **web 层早退 400**（12 条）**不含** `detail.period`（application 校验点同源的 18 条均含）——见 §1.5。 |
| **② N2 mock 日历档** | **PASS**（残余 **N2-r**，LOW） | 源码级（去注释后）`MOCK_TESTRUN_{D1,MINUTE}_MAX_SPAN_DAYS` 与「试算区间超限」**零活引用**（仅在注释中作删除说明）；行为级 D1 七年 / M1 104 天（旧档 5 年 / 93 天）**均受理**；`range_empty` / `resource_guard`+`confirm` / 收缩回显与向量**运行期绑定**（扰动向量 ⇒ 2 failed/6 passed ⇒ 复原 sha256 `838530ee…` 逐字节一致 ⇒ 8 passed）。**残余 N2-r**：mock 的**工作台提交**路径仍为旧形状（无 `code`、无收缩/护栏）——N2 判据之外，见 §2.4。 |
| **③ N3 旧断言** | **PASS** | 我自写用例给两种情形：**6 年 D1 + 有数据 ⇒ 200（真跑 `bar_count=1705`）**；**无交集 ⇒ 400 `range_empty` + 回显 `available_from/to/period`**，且 `message` 无「超限/5 年/上限」残留。反向：把日历档加回 `application/src/strategy.rs::test_run` 源头 ⇒ **必红**（`400 ≠ 200`），复原 sha256 `013338bc…` 一致并复绿。**不再可能靠「另一个 400 源」碰巧变绿**（两种情形分别断言 200 与 `code=range_empty`，非仅断言 400）。 |
| **④ N4 真渲染** | **PASS（我自己复跑，未采信转录）** | 生产构建（本轮 `npm run build` 产物 `web/dist`）+ 临时库 + 真 chromium：**4/4 通过** —— 下拉 19 项（非空）/ `range_empty` **按 code 渲染**（旁证原始 body `error.code="range_empty"`）/ `clamped` 提示条 / `resource_guard` 二次确认 → 确认后新 run 入历史（行数 6→7）。截图 5 张 + 转录见 §4。 |
| **⑤ `dispose()` 单向 `disposed=true`** | **dev-only（附证据）** ⇒ **列 MEDIUM（dev 体验/验收可用性）缺陷，非生产缺陷、不作为冻结/上线阻断项** | `vite dev`（React dev + `StrictMode`）：首挂/3 次路由往返/整页重载**全部恒卡**（option 恒 1 项「加载中…」，而同刻 `/api/strategies` **200**）。**生产构建**：首挂/3 次路由往返/重载**全部健康**（19 项）。jsdom 机制层证据（5 例）：同实例 `init→dispose→init` 后 `patch` 被静默丢弃（state 对象一字不变）；`<StrictMode>` 挂载恒卡、**不**包 `StrictMode` 正常、卸载→重建（新 store）正常。**未能构造生产可达路径**（详见 §5）。 |
| **⑥ N6 卫生 + 回归** | **PASS** | 本批 3 个临时库全 DROP，回读库清单 `{eestock, postgres}`（+系统模板）；app/vite 进程 0 残留；一次性 harness 已删。后端 `cargo test -p web -p application`（fresh 库）**344 passed / 0 failed / 0 ignored**（36 suites），含 worker 的 N1 门禁探针 `t_p5_http_structured_error_shape`（`tester_p5_indep` 13/13）；前端 **94 files / 901 tests passed**（worker 基线 91/879，**不减反增**）；`tsc -b` 0 错误；`npm run build` OK；`check-tangle` exit 0；`-p mcp adr024_period_ssot_drift` **5/5**（SSOT 四方逐字节断言）。P4/P6/P4b 面（`/fills`+`recorded`、分块写、`P4B_GLOBAL`/`p4b_run_summary_counters_are_self_consistent`、`periods.ts` 六档）**未见回退**。 |
| **⑦ 范围** | **PASS（含 1 条诚实登记）** | `git diff --cached` 278 项分类见 §7；**`tester/` 车道 0 项入 index**（未被 worker add）。`design/16-backtest-scalability/**`：`01-adr.md`/`03-test-plan.md`/`contract-vectors.json` 与**冻结 index 快照（`coder/backups/adr024_frozen_index_20260918T063137Z.tar.gz`）逐字节一致**；`02-spec.md`/`04-implementation-plan.md` 有改动，内容**全部为架构师裁决/计划层**（P6 `/fills` 「0046 审定」、**P5 N5 定稿**、P4/P6 冻结标记、P2c 派单、R10 关闭、§3.5 派单纪律），**无「为让实现过验而收缩契约」方向**；但**无法用 git 归属证明作者**（见 §7.3）。未发现其它非授权路径改动。 |

### 0.2 「P5 可否冻结」/「是否具备上线条件」

- **P5：可以冻结（GO for freeze）。** tester 上轮 §0.1 列的两项硬缺口 **N1/N2 已修并各有反向证据**，N3 按契约推导改写（我复核两种情形），N4 真渲染**由我独立复跑通过**；P5 冻结门禁探针（`crates/web/tests/tester_p5_indep.rs::t_p5_http_structured_error_shape`）现为**绿**（13/13）。本单无「须修复后才可冻结」项。
- **上线条件：本单只对 P5 面给出 GO，不背书 P6。** 整体批次门槛仍在 `04-implementation-plan.md` §3「⛔ 上线硬门槛」：**`0027` + P4 不得单独上线**（须与 P6 取数路径改造同批）；本单**未**复核 P6 前端消费面（`has_more`/`next_offset`/`/bars`/`/curve` 的前端消费完整性），该结论仍以上轮 P4/P6 验收与本轮 §6 的「未回退」为限。
- **P5 面残留风险（已登记，不阻塞）**：N1-r（12 条 web 早退 400 无 `detail.period`）、N2-r（mock 提交路径未镜像 P5）、⑤ 的 dev-only 缺陷（建议另立 0.5 天小单）。

### 0.3 本单 tester 独立载体（**均未 `git add`**）

| 载体 | 内容 | 结果 |
|---|---|---|
| `crates/web/tests/tester_p5rect_verify.rs`（新，自写） | ①静态枚举审计（4 组判据）②HTTP 表驱动 **53 条 400**（覆盖 27 码）+ 护栏 `confirm=true` ⇒ 201/200 ③前端码 parity（读 `codes::ALL` 源码）④N3 两种情形 | **4 passed / 0 failed** |
| `web/src/api/tester_p5rect_mock_n2.test.ts`（新） | N2 源码级+行为级+**向量绑定**（期望全部由 `span_limit_semantics` 推导） | **8 passed** |
| `web/src/features/strategies/tester_p5rect_errorDisplay.test.tsx`（新） | 前端 `code→中文`（期望 = 后端源码 `codes::ALL`）+ 未知码回退 + 两条消费路径（`WorkbenchStore.submit` / `TestRunPanel`） | **9 passed** |
| `web/src/features/workbench/tester_p5rect_dispose_blast.test.tsx`（新） | ⑤ 机制 + 生产可达性可证伪探针 | **5 passed** |
| `web/tester/p5rv-254/`（一次性 harness，**用后已删**） | `prod_real_render.e2e.ts`（N4 四项）、`blast_radius.e2e.ts`（⑤ dev/prod）、规格与截图已落 `evidence/pw/` | prod 4/4、prod blast 3/3、dev blast 3/3 |

---

## 1. ① N1 独立复核

### 1.1 静态枚举（不复用 worker 表）

`tester/evidence/254_.../01_n1_static_400_sites.txt`、`02_..._shape_audit.txt`；判据由 `t_n1_static_audit` 自动化：

```
[N1-静态] workbench.rs: 21 处 StatusCode::BAD_REQUEST，全部位于 structured( 调用内
[N1-静态] strategies.rs: 1 处 StatusCode::BAD_REQUEST，全部位于 structured( 调用内
[N1-静态] workbench.rs: 无 classify_config_error / contains / starts_with —— 零消息解析
[N1-静态] strategies.rs: 无 classify_config_error / contains / starts_with —— 零消息解析
[N1-静态] web 层引用码 15 个，全部在 codes::ALL（27 个）内
```

- `strategies.rs` 只有 **1** 处 `StatusCode::BAD_REQUEST`（在 `fn structured()` 内部）⇒ 该模块**结构上不可能**产出非结构化 400（比逐点断言更强）。
- **字符串形状残留**：`grep -n "err(StatusCode::BAD_REQUEST"` = 空；`err(StatusCode::…)` 仅剩 404/409/500/503（`workbench.rs:77/90/92/107`、`strategies.rs:46/81/83/99`）。
- **码同源（静态）**：web 层**零**「按消息内容判码」（`starts_with(` / `.contains(` / `classify_config_error` 均为 0 命中）；且 web 使用/转发的每个 `codes::X` 都在 `codes::ALL` 内（防「旁路码」）。

### 1.2 code 来自 application 校验点（同源）的证据

- 定义在 `crates/application/src/error.rs::codes`（27 常量 + `ALL`）；web 只读码：`structured(StatusCode::BAD_REQUEST, x.code(), x.message(), ctx)`（`map_svc_err_ctx`）。
- application 侧**赋值点**逐处带码：`strategy.rs:430/433/498/531/588/660/664/690/693/699/705/717/725/728/763/767/773/1194/1208`、`workbench.rs:416/423/429/431/456/470/475/478/493/508/732/736/749/768/804/1207/1280/1327/1374/1378/1381/1404/1413/1415/1421/1424/1434/1436/1445/1462`（`grep codes::` 原文见 §1.6 证据）。
- **反向证据 ①（web 侧改码 ⇒ 表驱动必红）**：把 `strategies.rs::test_run` 的 `codes::MODE_INVALID` 源头改为 `codes::REQUEST_INVALID`：
  ```
  assertion `left == right` failed: [test-run/mode_invalid] code 不符；body={"error":{"code":"request_invalid",...}}
    left: "request_invalid"   right: "mode_invalid"
  ```
  复原：`sha256(crates/web/src/strategies.rs)` 前后均 `6ef9a8f1dcc79edb…33ae72`，`git diff` 为空，复绿。
- **反向证据 ②（application 侧 `classify_config_error` 前缀改 ⇒ 必红）**：把 `buy_threshold` 前缀判据改为不存在的前缀：
  ```
  assertion `left == right` failed: [runs/threshold_invalid] … {"code":"request_invalid","message":"buy_threshold 必须严格大于 sell_threshold…"}
    left: "request_invalid"   right: "threshold_invalid"
  ```
  复原：`sha256(crates/application/src/error.rs)` 前后均 `9ee4ec802ffcd110…44f068`，`git diff` 为空，复绿。

### 1.3 `classify_config_error()` 的评估（架构师问「是否真的单点」）

| 判据 | 实测 | 结论 |
|---|---|---|
| 定义数 | **1**（`application/src/error.rs:91`） | ✅ 单一定义 |
| 调用点 | **3**，**全部在 application**：`strategy.rs:770`（试算 `policy.validate()`）、`workbench.rs:508`（提交端 `probe.validate()`）、`workbench.rs:1462`（预设校验 `probe.validate()`） | ✅ 单点函数，未散落 |
| web 侧是否引用 | `workbench.rs`/`strategies.rs` **0 引用** | ✅ 未把消息解析泄漏到 Presentation 层 |
| 被测试钉住 | 我 HTTP 表驱动钉住 3 条主要分支：`buy_threshold…`⇒`threshold_invalid`（反向②证伪）、`Dca…`⇒`policy_invalid`、`initial_capital…`⇒`capital_invalid`；worker 表驱动另钉 `capital_invalid`/`policy_invalid` | ✅ 改前缀即红 |
| 覆盖缺口（诚实登记） | `LumpSum…` / `capital…`（宽前缀）/`policy…` / 兜底 `request_invalid` 分支**未见专门 HTTP 用例**；且 strategy-core 消息一旦新增族而不改此函数 ⇒ **静默**归为 `request_invalid`（不报错、不漂移可见） | ⚠️ 局部债务的**残留面** |

**我同意架构师的认定：这是可接受的局部债务**，判据：① 单点（1 定义 + 3 调用全在 application，web 零解析）；② 被测试钉住（改前缀 ⇒ 我/worker 的表驱动必红，已实证）；③ 触发条件被限死在「strategy-core `String` 校验错误」这一不可变范围的最后一段。**但**「新增消息族静默归为 `request_invalid`」是它的真实余量——若后续要给 strategy-core 校验码化，建议连同 `String`→带码枚举一并做（不在本单范围，登记不阻塞）。

### 1.4 HTTP 级：每条 400 的形状与码（53 条，27 码全覆盖）

`tester/evidence/254_.../30_tester_p5rect_verify.txt`（原文摘录）：

```
[N1-HTTP] 53 条 400 用例全部结构化（error 为对象 + code + message + detail 对象）
[N1-HTTP] 其中 18 条（提交/试算）回显 detail.period
[N1-HTTP] 覆盖码 27 个: ["capital_invalid","code_invalid","code_required","config_invalid","fee_invalid",
 "from_after_to","ids_required","kind_invalid","level_invalid","mode_invalid","name_required","params_invalid",
 "period_invalid","policy_invalid","range_empty","request_invalid","resource_guard","slots_invalid",
 "source_invalid","status_invalid","stop_invalid","symbol_required","symbol_unregistered","threshold_invalid",
 "timestamp_invalid","version_not_runnable","weight_invalid"]
[N1-guard] 提交路径 confirm=true ⇒ 201 run="sr_1789722757705_000000"
[N1-guard] 试算路径 confirm=true ⇒ 200 bar_count=292342
```

覆盖面：`/api/workbench/runs`（17 条，含 `symbol_unregistered`/`version_not_runnable`/`weight_invalid`/`slot_vid_empty`→`slots_invalid`/`params_invalid`/`policy_invalid`/`stop_invalid`/`threshold_invalid`/`capital_invalid`/`range_empty`/`resource_guard`）、`available_range`（2）、`runs` 列表（1）、`/bars`（5）、`/curve`（1）、`compare`（1）、`presets`（3，含 `config_invalid`）、`/api/strategies` 族（9）、`/api/strategies/test-run`（11，含 `code_invalid`/`period_invalid`/`range_empty`/`resource_guard`）。每条断言 `error` 为**对象**（非字符串）、`code`/`message` 非空、`detail` 为**对象**；**无任何** `{"error":"<字符串>"}` 形状。

### 1.5 残余 **N1-r**（LOW）：提交/试算路径的 web 早退 400 无 `detail.period`

```
[N1-r] web 层早退 400（无 detail.period）12 条：["runs/symbol_required(symbol_required)",
 "runs/from_bad(timestamp_invalid)","runs/to_bad(timestamp_invalid)","runs/from_after_to(from_after_to)",
 "runs/slots_empty(slots_invalid)","runs/fee_invalid(fee_invalid)","test-run/source_invalid(source_invalid)",
 "test-run/symbol_required(symbol_required)","test-run/mode_invalid(mode_invalid)","test-run/from_bad(timestamp_invalid)",
 "test-run/to_bad(timestamp_invalid)","test-run/from_after_to(from_after_to)"]
```

- **事实**：`detail` 恒为对象（判据满足）；但**这 12 条**（`web/src/workbench.rs::submit_run`、`web/src/strategies.rs::test_run` 的**入参预校验早退**）详情里**没有** `period`，尽管请求里带 `period`。**application 校验点同源**的 18 条（经 `map_svc_err_ctx(e, {"period": …})` 合并 ctx）**均有** `detail.period`。
- **与本单判据的关系**：任务书要求「提交/试算路径 `detail.period` 存在」——**按字面未 100% 成立**（12/53 例外）；worker 报告 §0/§1.1 的「提交/试算路径并含请求 `period`」措辞**过宽**（其自测只对 `period_invalid` 两条断言了 `detail.period`：`adr024_structured_errors.rs:320-322/438-441`）。
- **影响**：前端按 `code` 分支不受影响（码齐全）；`detail` 形状仍是对象。仅影响「消费方想从 `detail` 直接取 period」的便利性。
- **我的用法**：以 `PERIOD_GAP` **钉住现状**（补齐即红，提醒更新报告）⇒ 它同时是**防漂移探针**。**判为 LOW 残余**，建议架构师裁决：要么按 `period_invalid` 的写法在两条早退处补 `{"period": req.period}`（改动 <10 行），要么在 §3.1.1 明确「`detail` 仅在 application 校验点回显 period」。

### 1.6 前端（`errorMessages.ts`）与两条消费路径

- `tester_p5rect_errorDisplay.test.tsx` **9 passed**：期望集合**从后端源码解析**（`crates/application/src/error.rs` 的 `pub const …: &str` + `codes::ALL`），逐码断言「命中中文映射且**不等于**原文」（防「未知码回退也算过」）；未知码 ⇒ **回退 `message`**；无码 ⇒ `message`；`range_empty` 的中文提示内联 `detail` 可用区间。
- **消费路径 ①工作台提交**：`WorkbenchStore.submit` 收到 `ApiError(400, msg, 'period_invalid')` ⇒ `submitError` = 「不支持的周期（…原文…）」；未知码 ⇒ 原文。
- **消费路径 ②在线试算**：`TestRunPanel` 渲染 `tr-run-error`，已知码 ⇒ 中文提示、未知码 ⇒ 原文（两条各 1 例）。
- 静态：`store.ts`/`TestRunPanel.tsx` 均 `import { errorDisplayText }`；`if (!hint) return message;` 回退分支在位。

---

## 2. ② N2 独立复核

### 2.1 物理删除（源码级，去注释后判据）

`tester/evidence/254_.../20_n2_physical_deletion_grep.txt`：

```
$ grep -n 'MOCK_TESTRUN_\|MAX_SPAN_DAYS\|试算区间超限' web/src/api/mock.ts
456: * 旧 `MOCK_TESTRUN_D1_MAX_SPAN_DAYS` / `MOCK_TESTRUN_MINUTE_MAX_SPAN_DAYS` 及其超限分支已**物理删除**   ← 仅注释
$ 去注释后含 MAX_SPAN_DAYS 的行数 = 0
$ grep -rn "pub const D1_MAX_SPAN_DAYS\|pub const MINUTE_MAX_SPAN_DAYS\|const MOCK_TESTRUN" crates/application/src web/src
(无 — PASS)
```
⇒ 旧常量/超限分支在**活代码**中不存在（注释里作删除说明不算复活；我的 N2 用例只对去注释源码下判据）。

### 2.2 行为级（期望**由契约向量推导**，非硬编码）

`tester_p5rect_mock_n2.test.ts`（8 passed）：

| 用例 | 期望来源 | 结果 |
|---|---|---|
| D1 七年跨度（旧档 5 年）⇒ 受理 | `span_limit_semantics.calendar_day_cap === null` | OK |
| M1 104 天（旧档 93 天）⇒ 受理，`estimated_bars > 93×1440×0.9` | 同上 | OK |
| 起点早于可得数据 ⇒ `clamped=true` / `clamp_reason='data_range'` / **`clamp.echo_fields` 全部存在** | `span_limit_semantics.clamp.mode` + `echo_fields` | OK |
| 无交集 ⇒ 400 = `empty_intersection.http` 且 `code = empty_intersection.code` + 回显 available/period | 向量 | OK |
| 未注册标的 ⇒ `code = empty_intersection.code`，available 为 null | 向量 | OK |
| `M1` 2 年（≥ 确认阈值、≤ 硬上界）⇒ `code = resource_guard.code`、`confirmable=true`；`confirm=true` ⇒ 放行 | `resource_guard.requires_confirmation` + `code` | OK |
| 短区间 ⇒ `clamped=false`、requested==effective（回归保护） | — | OK |
| 源码级：无活 `MAX_SPAN_DAYS` / 无「试算区间超限」/ 向量 `deleted_constants` 未复活 | 向量 `deleted_constants` | OK |

### 2.3 向量绑定真实性（反向证据）

扰动 `contract-vectors.json::span_limit_semantics`（`calendar_day_cap: null→1830` + `clamp.echo_fields` 追加 `non_existent_echo`）：

```
× D1 七年跨度 ⇒ 受理      → AssertionError: expected 1830 to be null
× 收缩回显 echo_fields 全覆盖 → 回显缺字段 non_existent_echo
Tests  2 failed | 6 passed (8)
```
复原：`sha256 = 838530eeb02edcefa315cbc5ae1d485fe44e8bde51e43c1cf06c9f00a520281d`（**扰动前后一致**），`git diff -- design/16-backtest-scalability/contract-vectors.json` = 空，复跑 **8 passed**。
> 交叉旁证：该 sha256 与 worker 报告 §2.3 独立记录的同一文件哈希**完全一致**（两车道独立取证互证）。

### 2.4 残余 **N2-r**（LOW）：mock 的**工作台提交**路径未镜像 P5

`tester/evidence/254_.../21_n2r_mock_submit_fidelity.txt`：`mock.ts::submitWorkbenchRun` 的 400 仍为**字符串形状**（`throw new ApiError(400, 'HTTP 400: …')`，无 `code`/`detail`），且响应硬编码 `clamped: false` / `clamp_reason: null`、**无** `range_empty`/`resource_guard`/收缩回显。
- 该路径**不属** N2 判据（N2 = 日历档删除 + 试算同口径 + 向量绑定；旧日历档从未在该路径存在 ⇒ **未复活**）；且生产走 `VITE_API_MOCK=0`（`Dockerfile.app:15` `npm run build:prod`）⇒ **不影响生产**。
- 影响面：以 mock 模式开发时，工作台的 `clamped`/`range_empty`/`resource_guard` 分支**不可在 UI 上演练**（§4 的真渲染因此必须走真后端）。登记为 dev-mock 保真度残余。

---

## 3. ③ N3 独立复核

`t_r3`（我的用例 `t_n3_long_d1_accepted_and_no_intersection_range_empty`）原文：

```
[N3-a] 6 年 D1 有数据 ⇒ 200 bar_count=1705 clamped=false requested==effective
[N3-b] 无交集 ⇒ 400 range_empty available=["2013-07-28T16:00:00+00:00" .. "2026-09-16T16:00:01+00:00"]
        message=请求区间与可得区间无交集（518880 D1 可用区间：2013-07-28T16:00:00+00:00 ~ 2026-09-16T16:00:01+00:00）
```

- (a) 断言 **200** + `bar_count > 1000`（**真跑**，不是仅校验通过）+ `requested_*` 回显 + `clamped=false` + `effective_* == requested_*`；
- (b) 断言 **400 且 `code === "range_empty"`**（不是「任意 400」）+ `detail.available_from/to` 为字符串 + `detail.period` 存在 + `message` **不含**「超限/5 年/上限」措辞。
  ⇒ **不可能**再由「另一个 400 源」碰巧变绿（旧断言的病根正是只断言 `400`）。
- **反向证据**：在源头 `crates/application/src/strategy.rs::test_run` 临时加回 `if (to-from).num_days() > 366*5 → 400 period_invalid`：
  ```
  assertion `left == right` failed: 6 年 D1 + 有数据应 200（日历档已删），实得 400；
    body={"error":{"code":"period_invalid","detail":{"period":"D1"},"message":"试算区间超限（D1≤5 年）"}}
    left: 400   right: 200
  ```
  复原：`sha256(crates/application/src/strategy.rs)` 前后均 `013338bce9479a5b…9ad0911`，`git diff` 为空，复绿。
- 交叉：worker 改写的 `crates/web/tests/api_strategies.rs` 在 fresh 库 **9 passed / 0 failed**（§6）。

---

## 4. ④ N4 真渲染（我自己复跑，不采信 worker 转录）

**路线**：`npm run build`（本轮自建 `web/dist`，`95_frontend_build_final.txt`）→ 第二实例 `--config /tmp/p5rv_app.toml`（`listen=127.0.0.1:18099`、`static_dir=./web/dist`、`database_url=临时库`）→ 真 chromium（`playwright.p5rv.config.ts`）。

```
[N4①] 策略下拉 option 数 = 19         第 1 项文案 = 添加策略…
[N4②] 渲染文案 = 提交失败：该标的该周期无数据（可用区间：2013-07-28T16:00:00+00:00 ~ 2026-09-16T16:00:01+00:00）
              （HTTP 400 /api/workbench/runs: 请求区间与可得区间无交集（518880 D1 可用区间：…））
[N4②] 原始 400 body = {"error":{"code":"range_empty","detail":{"available_from":"…","available_to":"…",
              "period":"D1","requested_from":"2010-01-01T00:00:00+00:00","requested_to":"2010-02-01T00:00:00+00:00",
              "symbol":"518880"},"message":"请求区间与可得区间无交集…"}}
[N4③] 提示条文案 = 已按实际数据范围收缩：2013-07-28 ~ 2013-08-04（原因：数据可得范围）
[N4④] 确认前 run 行数 = 6
[N4④] 二次确认文案 = 预估 770236 根 bar（约 482.2 秒），达到二次确认阈值。 仍要提交 取消
[N4④] 确认后 run 行数 = 7
4 passed (7.8s)
```

- **四项必查全部真渲染通过**：下拉非空 / `range_empty` **按 code 渲染**（并旁证后端原始 `error.code`，排除「前端硬编码文案」假绿）/ `clamped` 提示条 / `resource_guard` 二次确认 → 确认后 **201 受理**且新 run 入历史。
- 反假绿口径（我自己加的）：② 同时断言**原始 HTTP body 的 code**；④ 断言**确认框隐藏** + **run 行数增加** + **无 `wb-submit-error`**（不是只看提示条文本）。
- 截图：`evidence/254_.../pw/01-catalog-dropdown.png`…`05-guard-confirmed.png`（另 `blast-01/02` 见 §5）。
- 卡点根因（worker §4.1 声称 = dev StrictMode `dispose()`）：**我独立证实**（§5），但**降级为 dev-only**（worker 将其描述为仅「dev 现象」是对的，但它未给出「生产是否可达」的判定，本单补上）。

---

## 5. ⑤ **`WorkbenchStore.dispose()` 单向 `disposed=true` 的爆炸半径裁定：dev-only**

### 5.1 机制（只读定位，证据：jsdom 5 例全绿）

```
web/src/features/workbench/WorkbenchPage.tsx:20  const store = useMemo(() => new WorkbenchStore({ api, ws }), [api, ws]);
web/src/features/workbench/WorkbenchPage.tsx:21  useEffect(() => { void store.init(); return () => store.dispose(); }, [store]);
web/src/features/workbench/store.ts:123        private patch(p) { if (this.disposed) return; … }
web/src/features/workbench/store.ts:417        dispose(): void { this.disposed = true; … }   ← **无复位**
```

`tester_p5rect_dispose_blast.test.tsx`（5 passed）：
- **A 机制**：同一实例 `init → dispose → init` ⇒ `store.state` **对象一字不变**（所有 `patch` 静默丢弃）；**对照组**（未 dispose）`loadCatalog` 使 state 换新对象 ⇒ 判据有判别力。
- **B**：`<StrictMode>` 包裹 `WorkbenchPage` ⇒ 下拉恒 1 项「加载中…」（= dev 现象）；
- **C**：**不**包 `StrictMode` ⇒ 正常加载（= 生产现象）；
- **D**：卸载 → 重建 ⇒ 正常加载（重建拿到**新** store 实例 ⇒ 不命中 dispose 复用）；
- **E**：`catalogLoading=true` ⇒ 占位文案确为「加载中…」（与 dev 实测一致）。

### 5.2 真浏览器双车道对照

| 车道 | 首挂 | SPA 路由往返 ×3 | 整页 reload | `/api/strategies` |
|---|---|---|---|---|
| **`vite dev`**（`127.0.0.1:15173`，React dev + StrictMode） | **恒卡**（option=1，「加载中…」） | **恒卡**（往返后仍 1） | **恒卡** | **200**（首挂 2 次、往返累计 4 次） |
| **生产构建**（app 托管 `web/dist`，`127.0.0.1:18099`） | 健康（19 项） | 健康 ×3（每轮重新拉 catalog 200） | 健康 | 200 |

原文：`evidence/254_.../73_blast_dev.txt`（`P5RV_EXPECT=stuck`，3 passed）、`75_blast_prod_final.txt`（`P5RV_EXPECT=healthy`，3 passed）。

### 5.3 生产可达性尝试（构造路径）与判据

| 可能的「生产也可达」路径 | 尝试 | 结果 |
|---|---|---|
| 路由切换/组件卸载后重建（store 复用） | NavLink 往返 3 次（无整页刷新） | **健康**（新 store；`useMemo` 随组件实例重建） |
| 整页重载（应有新 store） | reload | **健康** |
| 父组件重渲染传入**新** `api`/`ws` ⇒ `useMemo` 重算 | 静态分析：`WorkbenchPage` 仅在 `App.tsx:33` 以**无 props** 方式挂载（`api`/`ws` = `defaultApi`/`defaultWs` 模块单例）⇒ 不会发生；即便发生，也会得到**新** store（旧 store 被 dispose，互不影响） | 不构成可达路径 |
| 同一 store 上 `dispose()` 后再 `init()` | **唯一触发点 = `useEffect` 因依赖变化而重跑且 `store` 标识不变**；在 React **生产**构建下不存在（`StrictMode` 的 mount→unmount→mount 双调用是 **dev-only**） | **仅 dev 可达** |
| 另一次挂载复用已 dispose 的 store | `grep "new WorkbenchStore"` 仅 2 处（`WorkbenchPage`、单测）⇒ 无共享单例 | 不成立 |

**判据小结**：生产构建在**首挂/3 次路由往返/重载**下均健康、且机制上「同实例 dispose→init」在生产构建无双调用触发点 ⇒ **dev-only**。

### 5.4 结论与定性

- **结论：dev-only（附上述双车道 + jsdom 证据）。** 生产部署（`Dockerfile.app` 用 `npm run build:prod`，React 生产构建 + `StrictMode` 额外检查被剥离）**不受影响**。
- **定性：MEDIUM（开发者体验 / 验收可用性）缺陷，非生产缺陷 ⇒ 不作为 P5 冻结或上线阻断项**；但它是**真缺陷**（vite dev 下工作台完全不可用），建议按 worker §4.4 另立 0.5 天小单（`dispose()` 允许后续 `init()` 复位，或用 `useRef`/单例持有 store + 补 jsdom 用例 `dispose→init 后 patch 生效`）。
- **残留风险（须写清）**：若有人把 **vite dev** 直接对外提供服务（非生产口径），则该缺陷**可达**；此外它会让「以 dev 构建做前端验收」永久性失效（本单的真渲染因此必须走生产构建）。

---

## 6. ⑥ N6 卫生 + 回归

### 6.1 环境卫生（`97_n6_teardown.txt`）

```
$ DROP DATABASE IF EXISTS "tmp_p5rv_1789721514" WITH (FORCE)   → DROP DATABASE
$ DROP DATABASE IF EXISTS "tmp_p5rv2_1789722163" WITH (FORCE)  → DROP DATABASE
$ DROP DATABASE IF EXISTS "tmp_p5rv3_1789722729" WITH (FORCE)  → DROP DATABASE
# 回读库清单（业务库须只剩 eestock/postgres）
eestock|2452 MB   postgres|7519 kB   template0|7361 kB   template1|7361 kB
# 残留进程（app / vite）计数 = 0
# 一次性 harness（web/tester/p5rv-254）已删（ls 报 No such file or directory）
```
> 未对活库 `eestock` 应用 0027、未写入 run；所有真实 run 均在临时库/第二实例上产生。

### 6.2 门禁

| 门禁 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 后端（fresh 临时库 `tmp_p5rv2_…`） | `cargo test -p web -p application` | **344 passed / 0 failed / 0 ignored**（36 suites） | `81_backend_web_application.txt` |
| 其中 worker 的 N1 门禁探针 | `cargo test -p web --test tester_p5_indep` | **13 passed / 0 failed**（上轮红探针转绿） | 同上 |
| 其中 N3 载体 | `cargo test -p web --test api_strategies` | **9 passed / 0 failed** | 同上 |
| 其中 tester 本单 N1/N3 | `tester_p5rect_verify` | **4 passed** | `30_tester_p5rect_verify.txt` |
| 既有「孤儿行」用例（上轮污染债） | `orphan_detect_endpoint_red` | **4 passed**（fresh 库下未复现，与 worker §7 一致） | 同上 |
| MCP SSOT 四方 | `cargo test -p mcp --test adr024_period_ssot_drift` | **5 passed**（含 `all_four_period_sources_are_byte_equal`） | `92_mcp_ssot_drift.txt` |
| 前端全量 | `npx vitest run` | **94 files / 901 tests passed**（worker 91/879 ⇒ +3 files/+22 tests，**不减**） | `94_frontend_vitest_final.txt` |
| 类型 | `npx tsc -b` | exit 0，输出 0 字节 | `93_frontend_tsc.txt` |
| 构建 | `npm run build` | exit 0（`✓ built in 1.94s`） | `95_frontend_build_final.txt` |
| tangle | `./scripts/check-tangle.sh` | exit 0（沙箱重生成 + 逐字节比对，工作区未改） | `96_check_tangle.txt` |
| 真渲染 | 见 §4 / §5 | 4/4 + 3/3 | `74_n4_real_render_final.txt`、`75_blast_prod_final.txt` |

### 6.3 P4 / P6 / P4b 未回退

| 项 | 判据 | 结果 |
|---|---|---|
| `/fills` + `recorded` | 路由 `crates/web/src/lib.rs:101`；`web::workbench::get_fills`；`application::workbench::WorkbenchRunResult{recorded}`；测试 `p6_fills_paging_and_recorded`、`p6_fills_unrecorded_distinguished`、`tester_p6_fills_indep`（4/4，含 `recorded_vs_unrecorded_and_legacy_derived`、`is_exact_source_and_trades_misses_partial_fills`） | ✅ 全绿 |
| 分块写路径 | `storage/workbench.rs::append_result_chunk/result_chunks/result_chunk_count`、`mark_succeeded ⇒ result_format='chunked_v1'`；测试 `t_p6_fills_chunk_single_block_and_result_row_coexist`、`t_p6_fills_chunk_write_failure_marks_failed_and_precedes_success` | ✅ 全绿 |
| P4b 仪表 | `P4B_GLOBAL` 静态计数器 + `p4b.run_summary` 自洽断言 `p4b_run_summary_counters_are_self_consistent` | ✅ ok（`81_...` 第 242 行） |
| SSOT 四方 | `application/tests/backtest_periods_ssot.rs`（4 断言，含 `ssot_matches_contract_vectors_backtest_periods`）+ `web/tests/adr024_workbench_period_ssot.rs`（4）+ `mcp/tests/adr024_period_ssot_drift.rs`（5，含 `all_four_period_sources_are_byte_equal`）+ 前端 `periods.ts`（`SUPPORTED_BACKTEST_PERIODS = ['M1','M5','M15','M30','H1','D1']`）+ `periods.test.ts` | ✅ 全绿且**未被本批改动** |

---

## 7. ⑦ 范围

### 7.1 `git diff --cached` 分类（278 项，`98_git_cached_classification.txt`）

| 车道/顶层 | 计数 | 说明 |
|---|---|---|
| `coder/evidence/**` | 187 | P0–P6 + 本整改证据 |
| `web/src/**` | 28 | 前端（P0/P4/P5/P6；含 `errorMessages.ts`、`mock.ts`、`periods.ts`） |
| `crates/application/**` | 11 | 含新文件 `src/error.rs` |
| `coder/report/**` | 9 | 各阶段报告 |
| `crates/web/**` | 7 | 含 `tests/adr024_structured_errors.rs`（新） |
| `crates/strategy-runtime/**` | 7 / `crates/storage/**` 5 / `crates/strategy-core/**` 4 / `crates/mcp/**` 3 / `crates/backtest/**` 3 / `crates/simlive/**` 2 / `crates/domain/**` 1 | P2/P2b/P2c/P4/P6 实现与测试 |
| `design/16-backtest-scalability/**` | 5 | 见 §7.3 |
| 其它 design（02-domain / 04-storage ×2 / 07-app-plane ×2） | 5 | tangle 回写文档 |
| `migrations/0027_…sql` | 1 | P4 迁移（**未**应用到活库） |
| **`tester/**`** | **0** | ✅ worker **未** add 任何 tester 车道文件（含上轮 U2 的三个未跟踪 tester 文件） |

### 7.2 我的新增（均未 add）

- 测试载体：`crates/web/tests/tester_p5rect_verify.rs`、`web/src/api/tester_p5rect_mock_n2.test.ts`、`web/src/features/strategies/tester_p5rect_errorDisplay.test.tsx`、`web/src/features/workbench/tester_p5rect_dispose_blast.test.tsx`
- 证据：`tester/evidence/254_adr024_p5_rect_verify/**`（含 `pw/`）
- 本报告。**未** `git add`/`commit`；**未**改任何生产代码（唯一临时改动 = 两处反向取证 + 一次向量扰动，全部逐字节复原，`git diff -- crates/ web/src migrations/` **为空**）。

### 7.3 `design/16-backtest-scalability/**` 是否 worker 改动

用**冻结快照**（`coder/backups/adr024_frozen_index_20260918T063137Z.tar.gz`，captured 06:31Z）做三方比对（`95/96/97/99_*.txt`）：

| 文件 | 冻结快照 vs **index** | 冻结快照 vs **工作区** | 判定 |
|---|---|---|---|
| `01-adr.md` | 一致 | 一致 | 未被任何车道改动 |
| `03-test-plan.md` | 一致 | 一致 | 同上 |
| `contract-vectors.json` | 一致（`838530ee…`） | 一致 | 同上（worker 的瞬时扰动**已逐字节复原**） |
| `02-spec.md` | **不同**（`ResultKind` 增 `Fills`、`strategy_run_bars.kind` CHECK 增 `'fills'`、`/fills` 端点行 + 「0046 审定（P6 升级裁决）」） | **再不同**（新增 §3.1 步骤 5 的 **N5 定稿**语义 + `/fills` 的 `recorded` 语义） | **架构师侧**（P6 契约扩张 + N5 文档裁决） |
| `04-implementation-plan.md` | **不同**（P2b/P4 冻结标记、P2c 派单行、⛔上线硬门槛、P4b 两阶段） | **再不同**（P6 冻结标记、R10 关闭、§3.5 派单与并发纪律 4 条） | **架构师侧**（计划/纪律/风险登记） |

- **可断言**：3/5 文件与冻结快照**逐字节一致** ⇒ 未被 worker（或任何车道）改动；另 2 个文件的差异内容**全部是架构师裁决/计划层文字**（引用 architect 裁决标记与 tester 证据 id `251/252`；方向是**扩张/固化**契约，不是「为让实现过验而收缩」）——与本单 N5 的「文档与实现对齐」裁决一致。
- **不可断言（诚实登记）**：ADR-024 全部工作未 commit，**无 git 作者元数据**，且这 2 个文件的改动**部分在 index、部分在工作区**（工作区改动为**预存**，我在开工时的 `git status` 即已见到）⇒ **无法用 git 证明「非 worker 改动」**，只能给出上述内容级 + 快照级实质断言。按任务书「架构师改的可接受」处理，**不登记为 worker 越权**。
- **次要观察（非判据）**：`02-spec.md` 新增的 N5 定稿句中「不得影响**嗂**给引擎的 bar 集合」疑为「**喂**」的错字（架构师原文）。不影响判词。

---

## 8. 未决项 / 建议（给架构师的动作）

1. **N1-r（LOW，建议顺手补）**：`web/src/workbench.rs::submit_run` / `web/src/strategies.rs::test_run` 的 6+6 条入参早退 400 未并入 `period` ctx；二选一：补 `{"period": …}` 或把「detail 回显 period（有则）」写进 §3.1.1 以消除歧义。**不阻塞冻结**。
2. **N2-r（LOW，登记）**：mock 工作台提交路径未镜像 P5（无 `code`/无收缩/无护栏）；若希望 mock 模式可演练 P5 分支，另立小单。**不阻塞**。
3. **⑤（MEDIUM，dev-only，建议另立 0.5 天单）**：`WorkbenchStore.dispose()` 允许复位（或改由 `useRef`/单例持有），并补「`dispose→init` 后 `patch` 生效」的 jsdom 用例。**不作为 P5 冻结/上线阻断项**，但会持续影响 dev 构建下的前端可用性与验收方式。
4. **`classify_config_error` 余量（LOW）**：若日后 strategy-core 校验码化，建议同步移除字符串前缀归类；在此之前，新增消息族会静默归 `request_invalid`（已在 §1.3 登记）。
5. **P6 门槛仍在**：本单只对 P5 面给 GO；`0027 + P4` 单独上线的禁令与 P6 前端消费面复核**不在本单范围**（沿用上轮结论）。

---

## 9. 证据清单（`tester/evidence/254_adr024_p5_rect_verify/`）

| 文件 | 内容 |
|---|---|
| `01_n1_static_400_sites.txt` / `02_n1_static_shape_audit.txt` | N1 静态枚举（两模块全部 400 出口 + `err()` 非 400 清单 + 零消息解析） |
| `30_tester_p5rect_verify.txt` | tester 独立 N1/N3 载体原文（53 条 400、27 码、N1-r 清单、护栏 201/200、N3 两情形） |
| `31/33_rev_n1_hash_before|after_restore.txt`、`32_rev_n1_code_perturbed_red.txt` | **N1 反向①**（web 改码 ⇒ 红 + sha256 复原） |
| `34/36_rev_n1_classify_hash_*.txt`、`35_rev_n1_classify_perturbed_red.txt` | **N1 反向②**（application 改前缀 ⇒ 红 + sha256 复原） |
| `20_n2_physical_deletion_grep.txt` / `21_n2r_mock_submit_fidelity.txt` | N2 物理删除核查 / N2-r 残余 |
| `40/42_rev_n2_vector_hash_before|after_restore.txt`、`41_rev_n2_vector_perturbed_red.txt`、`43_rev_n2_vector_restored_green.txt` | **N2 向量绑定反向证据**（红 → 复原 → 绿） |
| `50/52_rev_n3_hash_*.txt`、`51_rev_n3_calendar_cap_red.txt` | **N3 反向证据**（日历档加回源头 ⇒ 红 + sha256 复原） |
| `60/95_frontend_build*.txt`、`93_frontend_tsc.txt`、`96_check_tangle.txt` | 前端构建/类型/tangle |
| `70_second_instance.log`、`72_vite_dev.log`、`74_n4_real_render_final.txt` | 第二实例（生产构建 SPA）/ vite dev / **N4 四项真渲染** |
| `71/75_blast_prod*.txt`、`73_blast_dev.txt` | **⑤ 双车道对照**（生产健康 3/3；dev 恒卡 3/3） |
| `80/81/82_*`、`90/94_frontend_vitest*.txt`、`91_p4p6p4b_static.txt`、`92_mcp_ssot_drift.txt` | 临时库供应 / 后端 344-0 / 前端 901 / P4·P6·P4b 未回退 / MCP SSOT |
| `95/96/97/99_*frozen*design16*.txt`、`98_git_cached_classification.txt` | ⑦ 范围：`design/16` 三方比对（冻结快照 vs index vs 工作区）+ index 分类 |
| `97_n6_teardown.txt`、`98_workspace_hygiene.txt` | ⑥ 环境卫生（DROP + 库清单 + 进程 + harness 清理） |
| `10/82_tempdb*` | 三个临时库的供应日志 |
| `pw/` | `prod_real_render.e2e.ts`、`blast_radius.e2e.ts`、`playwright.p5rv.config.ts` + 7 张截图 |
