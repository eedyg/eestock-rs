# ADR-024 P5 独立验收报告（上线前最后一道）

- **本报告文件位置**：`tester/report/adr024_p5_verification.md`
- 角色：tester（**只验不改生产代码**；本批仅新增 tester 车道测试/证据，未 `git add` / 未 `commit`）
- 验收对象：`coder/report/adr024_p5_span_unwrap_and_clamp.md` + 工作区实现（P5 增量；基线 = 冻结 index）
- 契约出口：`design/16-backtest-scalability/02-spec.md` §3.1/§3.1.1/§5.2/§5.3；`01-adr.md` D1/D2/D3/D11/D12；`03-test-plan.md` §3「P5」；`contract-vectors.json`
- 环境：临时库 `tmp_p5_1789718551`（`scripts/testdb-init.sh` 供应，**已 DROP**）+ 第二实例 `127.0.0.1:18099`（临时库）+ vite dev `15173`
- 时间：2026-09-18 16:02–16:20 CST（本报告为唯一汇总，全部原始输出落 `tester/evidence/253_adr024_p5_verify/`）

---

## 0. 判词（结论最前）

### 0.1 VERDICT：**CONDITIONAL PASS —— P5 主体成立，但「5 项非过」中有 2 项硬缺口，暂**不**建议冻结 P5**

**P5 核心能力（去日历档 / 区间收缩 / 资源护栏 / 试算同口径 / 抽样保首尾 / 进度预扫描 / 并集口径）经独立活库+可控数据源双向验证全部成立**（详见 §1：12 条独立用例通过 + 2 条反向证据 + 活库 518880 真跑）。

但以下 **2 项**属**契约/纪律硬缺口**，须修复后才可冻结：

| # | 非过项 | 级别 | 一句话 |
|---|---|---|---|
| **N1** | **结构化错误覆盖不全**：`period_invalid` / `from_after_to` 等 400 **不是** `{error:{code,message,detail}}`，而是**旧形状** `{"error":"<字符串>"}` ⇒ `error` 字段**两种类型混用** | **HIGH（契约 §3.1.1 明确列举该两个 code + 硬要求「前端必须能编程消费」）** | 见 §2.1（含红证据） |
| **N2** | **前端 mock 仍实现已物理删除的日历天数档**，且其测试**仍断言**该旧规则（D1≤5 年 / 分钟级≤93 天 → 400）⇒ 前端契约镜像（`contract-vectors.json.span_limit_semantics.calendar_day_cap = null`）与实际镜像**相反** | **HIGH（D1 + §5.1 单一事实源；用户可见事故类：「指定范围却被 400」在 mock/前端开发面复活）** | 见 §2.2 |
| **N3** | **旧断言静默残留**：`crates/web/tests/api_strategies.rs:467-473` 仍写「区间超限（D1 > 5 年）→ 400」并断言 400；该断言**仍绿**是因为 400 换源为 `range_empty`（合成标的无 D1 数据）⇒ 掩盖语义（违 `03-test-plan.md` §5 反假绿条款 #4） | MEDIUM（测试诚实性） | 见 §2.3 |
| **N4** | **前端真渲染未闭环**：日期控件 min/max 联动 + 可用区间文案已**真渲染**通过；`clamped` 提示条 / `resource_guard` 二次确认 / 结构化错误展示**受阻**（第二实例工作台策略下拉无条目 ⇒ 无法添加 slot ⇒ 无法在 UI 提交） | MEDIUM（证据缺口，非功能缺陷；jsdom 用例绿但按 test-plan §5 #2 不算） | 见 §2.4 |
| **N5** | **③ 执行时收缩语义与文档/契约字面不一致**：worker U2 称「仅被夹端生效」，实测**任一端 clamped ⇒ 两端都按真实首末 bar 收窄**；且 `effective_to` 会被收窄到「区间内末 bar + 1s」，不同于 §3.1 步骤 5 的字面 `min(to, avail.to)`。**不影响喂入引擎的 bar 集合**（取数先于该调整），但落库 `from_ts/to_ts` 与回显随此变化（≤1 根 bar 级偏移） | LOW-MEDIUM（文档需订正 + 契约需澄清；无功能回归） | 见 §2.5 |

另有 **环境卫生发现 N6**（worker 遗留 443MB 临时库 `tmp_p5_1789716888`，违 ADR-025 D3「残留必须清理」；验收时已 DROP）。

### 0.2 「P5 可否冻结」的明确结论

**暂不可冻结（NO-GO for freeze）**。判据：
- 依赖链已满足（P2/P2b/P4/P4b 均已冻结且本批回归未破，见 §5），**核心能力可上线**；
- 但 **N1（结构化错误混形状）与 N2（前端 mock 反契约）是「契约明确列举项」**，属 `03-test-plan.md` §4 门禁产物要求内、且 P5「契约出口」直接指名的项；在修复并由 tester 复核前，冻结会把一处**已知契约违约**带入 P6/上线批次。

### 0.3 「是否具备上线条件（migrate 0027 + P4 + P6 + P5）」的明确结论

**不具备无条件上线条件（NO-GO）**，但**差距被精确限定为 N1、N2（+ N3 测试诚实性、N4 证据缺口）**：

1. **P4 + P6 面未见回退**：`/fills`（含 `recorded`）、分块写路径、`P4B_GLOBAL` 计数、SSOT 防漂移四方断言、`web/src/features/backtest/periods.ts` 均在位且相关测试全绿（§5.3）—— **但** P4 单上线的既有硬门槛（前端对 `has_more`/`next_offset`/`/bars`/`/curve` 的消费）属 P6 验收范围，本批**未复核 P6 前端覆盖面**（见 §6 残留风险）。
2. **P5 主体可用**：长区间**不再被日历档拒绝**、收缩**按服务口径并集**且在提交/执行两端回显、护栏可 `confirm` 放行、试算与工作台同口径、进度预扫描精确/降级可见 —— 这些正是 ADR-024 D1/D2/D3/D11/D12 的目标态，已具备。
3. **放行建议**：修复 N1 + N2（N3 顺手订正）⇒ 由 tester 复核（可复用本报告 §1 的 `crates/web/tests/tester_p5_indep.rs` 独立用例，其中 `t_p5_http_structured_error_shape` 即 N1 的红探针）⇒ **P5 冻结**；否则**不得随 0027+P4+P6 批次上线**。

---

## 1. 通过项（独立证据）

**独立测试载体**：`crates/web/tests/tester_p5_indep.rs`（tester 手写，**未 add**；13 例，其中 12 绿 + 1 条为「红探针」，见 §2.1）。
纪律：**只替换取数端口**（`BacktestBarRead` mock：`bars`/`available_range`/`count_bars` 三路独立可设），run store / symbols / strategies **一律真库真实现**；另起真 axum + 真库的第二入口做 HTTP 形状验证。

原始输出：`31_tester_p5_indep_final.txt`（`test result: FAILED. 12 passed; 1 failed`，唯一红为 N1 红探针）。

### 1.1 ① 旧断言反转（D1 去日历档）— **PASS**

```
test t_p5_no_calendar_span_cap_m15_m1_m30 ...
[①] period=M15 span_days=259 ⇒ 201/Queued effective=[2025-03-03 01:30:00 UTC, 2025-11-17 01:30:00 UTC) clamped=false
[①] period=M1 span_days=365 ⇒ 201/Queued effective=[2025-03-03 01:30:00 UTC, 2026-03-03 01:30:00 UTC) clamped=false
[①] period=M30 span_days=730 ⇒ 201/Queued effective=[2025-03-03 01:30:00 UTC, 2027-03-03 01:30:00 UTC) clamped=false
test t_p5_no_calendar_span_cap_m15_m1_m30 ... ok
```
- 另补**真库 HTTP** 反转（旧 web 断言的正面反证）：`518880 D1 2020-01-01→2026-01-01`（**6 年 > 旧 5 年档**）⇒
```
[①-D1] 518880 D1 2020-01-01→2026-01-01（>5 年）status=200 OK body={"mode":"pure_score","symbol":"518880","period":"D1",...}
[①-D1] bar_count=1705 effective=["2020-01-01T00:00:00Z", "2026-01-01T00:00:00Z") clamped=false estimated_bars=Number(1455)
```
  ⇒ **真跑出 1,705 根 D1 结果**（非仅校验通过），跨 6 年无任何日历拒绝。
- 旧「超限 400」文案残留扫描：`60_residual_grep.txt`。**实现侧无日历档文案**（`application/src/error.rs:46` 仅注释说明删除）；**残留见 N2/N3**。

### 1.2 ② 区间收缩（D2）+ 并集口径（D3）— **PASS（含反向证据）**

```
test t_p5_clamp_left_right_both_and_exact ... ok
[②左超] requested=[2025-02-01 01:30:00 UTC, 2025-03-03 02:30:00 UTC) eff=[2025-03-03 01:30:00 UTC, 2025-03-03 02:29:01 UTC) clamped=true reason=Some("data_range")
[②左超-右端观察] requested_to=2025-03-03 02:30:00 UTC 实际 eff_to=2025-03-03 02:29:01 UTC（= 区间内末 bar(02:29:00)+1s）
[②右超] eff=[2025-03-10 01:30:00 UTC, 2025-03-10 02:29:01 UTC) clamped=true
[②右超-左端观察] requested_from=2025-03-07 01:30:00 UTC 实际 eff_from=2025-03-10 01:30:00 UTC（= 区间内首个真实 bar）
[②两端超] eff=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC) clamped=true
[②恰端点] eff=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC) clamped=false
test t_p5_gap_in_middle_not_truncated ... ok
[②缺口] 请求=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC) 落库 eff=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC) 跨度=7 天 clamped=false config.clamped=false
test t_p5_no_intersection_range_empty_400 ... ok
[②无交集] code=range_empty message=请求区间与可得区间无交集（830065 M1 可用区间：2025-03-03T01:30:00+00:00 ~ 2025-03-10T02:29:01+00:00） detail={"available_from":"2025-03-03T01:30:00+00:00","available_to":"2025-03-10T02:29:01+00:00","period":"M1","requested_from":"2025-04-09T02:29:00+00:00","requested_to":"2025-05-09T02:29:00+00:00","symbol":"830065"}
```
- 左超/右超/两端超/恰端点/**无交集 400 `range_empty` 且回显可用区间**/**中间缺口不截断**（3 段数据、中间空 3/4 天，落库跨度 7 天且 `clamped=false`）全覆盖。
- **并集口径（D3）活库独立用例**（自造「accurate 滞后、兜底有数据」）：
```
test t_p5_union_available_range_live_accurate_lags_fallback ... ok
[②并集] available_range=(2025-06-02 05:00:00 UTC, 2025-06-02 07:30:01 UTC) accurate 单层 max=Some(2025-06-02T05:30:00Z) 兜底 30m 桶=2025-06-02 07:30:00 UTC
[②并集] count(*)=4（期望 4：accurate 30m 2 桶(05:00/05:30) + 兜底 15m rollup 2 桶(07:00/07:30)）
```
- **反向证据（R1）**：把 `storage/src/backtest.rs::period_avail_sql(M30)` 改回 **accurate 单层** ⇒
```
failed: to = 并集最晚（**兜底** 30m 桶 07:30）+1s；只取 accurate 单层会得到 05:30 桶 ⇒ 必红
  left: 2025-06-02T05:30:01Z   right: 2025-06-02T07:30:01Z
test t_p5_union_available_range_live_accurate_lags_fallback ... FAILED（0 passed; 1 failed）
```
  复原后 sha256 逐字节一致（`72f3debc…fc6368`，见 `50/51/52_*.txt`），用例复绿。

### 1.3 ③ 执行时以真实首末为准 — **PASS（语义订正见 N5）**

构造「提交时缓存比执行时实取更宽」（缓存 = 真实 ±(2 天/10 天)）：
```
test t_p5_exec_time_clamp_uses_real_first_last_bar ... ok
[③] 请求=[2025-02-26 01:30:00 UTC, 2025-03-30 02:29:00 UTC] 缓存=[2025-03-01 01:30:00 UTC, 2025-03-20 02:29:00 UTC] 实取真实首末=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:00 UTC]
[③] 提交端响应 eff=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC) clamped=true；落库 eff=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC)
[③] config.requested_from="2025-02-26T01:30:00+00:00" requested_to="2025-03-30T02:29:00+00:00"
```
判据（我构造）：提交端按**陈旧缓存**收缩到 `[2025-03-01, 2025-03-20)`；执行端实取 bar 只到 `2025-03-10`，落库 `to_ts` **以执行时真实末 bar+1s 为准**（`03-10T02:29:01Z`），且原始请求在 `config.requested_*` 留痕 ⇒ **D3「两者不一致以执行时为准」成立**。

### 1.4 ④ 资源护栏（D1）— **PASS**

```
test t_p5_resource_guard_thresholds_and_confirm ... ok
[④] estimated=199999 ⇒ 放行（run=sr_1789718965993_000012）
[④] code=resource_guard detail={"available_from":"2025-03-03T01:30:00+00:00","available_to":"2025-03-10T02:29:01+00:00","confirm_bars":200000,"confirmable":true,"estimated_secs":125.85,"limit_bars":2000000,"period":"M1","requested_bars":200000,"symbol":"833554"}
[④] estimated_secs=125.85（须含每 run 固定成本项 ⇒ > 0.85s）
[④] confirm=true ⇒ 放行（run id=sr_1789718966014_000013 status=Queued）
[④] 落库 config.estimated_bars=200000 progress_prescan="count"
[④] 硬拒 code=resource_guard confirmable=false message=预估 2000001 根 bar 超过硬上界 2000000 根（资源护栏；不可放行）
```
- 边界逐点：`199_999` 放行 / `200_000`（**含**）400 / `confirm:true` 放行 / `2_000_001` **硬拒（confirm 无效）**；`detail` 含 `limit_bars`+`confirm_bars`+`requested_bars`+`estimated_secs`+`confirmable`+可用区间。
- 真实数据面同口径（HTTP + 真库）：`518880 M1` 全历史 ⇒ `requested_bars=770477`（`estimated_secs=482.398`）⇒ 400 `resource_guard`（`31_tester_p5_indep_final.txt`）。**未对活库/生产写 run**（该 400 发生在 create_run 之前）。

### 1.5 ⑤ 结构化错误形状（部分）/ 前端可编程消费 — **N1 见 §2.1；已成立的 2 个 code 如下**

```
[⑤-http range_empty] status=400 raw_body={"error":{"code":"range_empty","detail":{"available_from":"2026-09-09T01:30:00+00:00","available_to":"2026-09-09T01:35:01+00:00","period":"M1","requested_from":"...","requested_to":"...","symbol":"830057"},"message":"请求区间与可得区间无交集（…）"}}
[⑤-http resource_guard] status=400 raw_body={"error":{"code":"resource_guard","detail":{... "limit_bars":2000000 ...},"message":"预估 770477 根 bar（≈482.4 秒）达到二次确认阈值 200000 根；如仍要提交，带 confirm=true 重提"}}
[⑤] 序列化={"code":"range_empty","detail":{"available_from":"2025-01-01T00:00:00Z"},"message":"无数据"}
```
- `range_empty` / `resource_guard` 的形状、类型（`detail` 为**对象**）、可编程消费均成立；前端 `client.ts` 解析 `code`/`detail` 的用例（worker `client.test.ts`）在本批 vitest 全量中绿。
- **`period_invalid` / `from_after_to` 不成立** ⇒ N1。

### 1.6 ⑥ 试算同口径（D11）+ 均匀抽样保首尾 — **PASS**

```
test t_p5_testrun_same_caliber_and_uniform_sampling ... ok
[⑥同口径-试算] requested=[2025-02-21 01:30:00 UTC, 2025-03-20 02:29:00 UTC] effective=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC) clamped=true reason=Some("data_range") estimated=Some(180)
[⑥同口径-工作台] effective=[2025-03-03 01:30:00 UTC, 2025-03-10 02:29:01 UTC) clamped=true
[⑥试算无交集] code=range_empty detail={...}
[⑥抽样] bar_count=50050 scores=50000 downsampled=true original_points=50050 truncated.scores=false 首=1740965400 末=1743968340
```
- 同区间 ⇒ 试算与工作台 `effective_from/effective_to/clamped` **逐值一致**（断言等值，非目视）；
- 无交集试算 ⇒ 结构化 `range_empty`（同工作台口径）；
- 50,050 根 ⇒ 50,000 点、**首尾保留**（`首=1740965400` = 第 1 根 ts；`末=1743968340` = 第 50,050 根 ts）、`downsampled=true`、`original_points=50050`、`truncated.scores=false`（旧「丢尾」语义已撤销）。
- 前端面缺口见 N2 / §2.4（mock 未回显 `downsampled`/`original_points`）。

### 1.7 ⑦ 进度预扫描（D12）— **PASS**

```
test t_p5_prescan_count_and_degraded_path_visible ... ok
[⑦count] estimated_bars=Some(1234) config.progress_prescan="count"
[⑦降级] estimated_bars=None config.progress_prescan="ts_norm" （并伴随 tracing::warn，见 src 行 489-492）
```
- `count(*)` 成功 ⇒ 精确 total 回显 + 口径 `count` 落 `config`（事后可查）；
- 注入扫描失败 ⇒ 提交**不被阻断**、`estimated_bars=null`（无伪精确值）、口径 `ts_norm` **在 config 可见**，并有 `tracing::warn`（`application/src/workbench.rs:489-492`）。
  残留：降级口径只在**落库 config** 与**服务端日志**可见，**响应体未带口径字段**（前端无法直接看到「本次进度按 ts 归一化」）——验收判为**可接受**（任务表述允许「日志/响应标明」二选一），登记为观察项。

### 1.8 ⑧ 前端（部分真渲染）— **部分 PASS，见 N4**

真渲染（**真浏览器 + 真第二实例 + 真临时库**，`82_playwright_p5.txt`）：
```
[真渲染] available_range 请求= [".../api/workbench/available_range?symbol=518880&period=D1", ".../period=D1", ".../period=D1", ".../period=M1"]
[真渲染] 可用区间文案= 可用区间：2013-07-29 ~ 2026-09-17
[真渲染] 切 M15 后 available_range 文案= 可用区间：2023-01-03 ~ 2026-09-17
```
- 日期控件 `min`/`max` 随「标的+周期」**真联动**（断言 `min=2013-07-29` / `max=2026-09-17`，切 M15 触发**新请求**且文案随数据变化）⇒ §5.2 第 2 条成立。
- 第二实例 `GET /api/workbench/available_range?symbol=518880&period=M1` 真库返回 `{"available_from":"2013-07-29T01:30:00+00:00","available_to":"2026-09-17T07:00:01+00:00",...}`（`83_second_instance_http.txt`）。
- `clamped` 提示条 / `resource_guard` 二次确认 / 结构化错误展示：**受阻**（见 §2.4），jsdom 用例（`ConfigPanel.test.tsx`）绿但不计入真渲染。

### 1.9 ⑨ 回归与范围 — **PASS（明细见 §5）**

- 后端 `cargo test -p storage -p application -p web -p mcp`（临时库）：**513 passed / 0 failed / 0 ignored**（60 个 target；`10_backend_full.txt`）——**未复现** worker 提到的 `orphan_detect_endpoint_red` 并发 flake。
- 前端 `npx vitest run`：**90 files / 872 tests passed**（用例数未减；`20_frontend_vitest.txt`）；`npx tsc -b` **exit=0**；`npm run build`（vite）成功。
- `./scripts/check-tangle.sh` ⇒ **✅ exit=0**（`70_check_tangle.txt`）。
- P4/P6 面未回退（`71_p4p6_nonregression.txt`）：`/fills` 端点 + `recorded`（`web/src/workbench.rs:433-435`、`application/src/workbench.rs:249/878/909/924`）、分块写路径（`append_result_chunk`、`RESULT_FORMAT_CHUNKED`）、`P4B_GLOBAL`（`application/src/workbench.rs:1507/1888-1895`）+ `p4b_run_summary_counters_are_self_consistent`（`tests/workbench.rs:1273`，本批绿）、SSOT 防漂移四方断言（`application/tests/backtest_periods_ssot.rs`、`mcp/tests/adr024_period_ssot_drift.rs`、`web/tests/adr024_workbench_period_ssot.rs`、`web/src/features/backtest/periods.ts` = `['M1','M5','M15','M30','H1','D1']`）。
- **`design/16-backtest-scalability/**` 非 P5 worker 改动**：见 §3.3（可断言部分 + 不可断言部分的诚实登记）。

---

## 2. 非过项（逐条：判据 + 原始输出）

### 2.1 N1 —— 结构化错误覆盖不全（HIGH，契约 §3.1.1 违约）

**契约要求**（`02-spec.md` §3.1.1）：`code: "range_empty" | "resource_guard" | "period_invalid" | "from_after_to" | ...`，并硬要求「前端必须能**编程**消费」。
**实测**（真 axum + 真库，`31_tester_p5_indep_final.txt`）：

```
[⑤-http period_invalid] status=400 Bad Request raw_body={"error":"period 须为 M1/M5/M15/M30/H1/D1（未知周期: W1）"}
[⑤-http from_after_to]   status=400 Bad Request raw_body={"error":"from 须早于 to"}
[⑤-http 结构化缺口] period_invalid: 实得 raw={"error":"period 须为 …"}（error 是**字符串**，无 code/detail） | from_after_to: 实得 raw={"error":"from 须早于 to"}（error 是**字符串**，无 code/detail）
assertion `left == right` failed: 契约 §3.1.1 要求 code=period_invalid 的结构化 400（前端按 code 分支）
  left: Null   right: "period_invalid"
test t_p5_http_structured_error_shape ... FAILED
```
**根因**（只读定位，不修）：`crates/web/src/workbench.rs:34 fn err()` 产出 `{"error": msg}`（字符串），而 `structured_err()` 产 `{"error":{code,message,detail}}`；`submit_run` 的周期/`from<to`/slots/fee 预校验与 `map_svc_err` 的 `WorkbenchValidation` 分支**全走 `err()`**。⇒ **同一 `error` 字段两种类型**，前端 `error.code` 对这两类 400 恒为 `undefined`。
**影响**：前端无法按 `code` 分支（§5.3 的「`period_invalid` → 不支持的周期」文案分支无法实现）；且形状不稳定会影响任何按 JSON schema 消费的调用方（MCP/脚本）。
**红探针**：`crates/web/tests/tester_p5_indep.rs::t_p5_http_structured_error_shape`（修复后该用例应转绿——即 P5 冻结的门禁探针）。

### 2.2 N2 —— 前端 mock 保留已删除的日历档 + 断言未撤销（HIGH，D1 + §5.1）

`60_residual_grep.txt`：
```
web/src/api/mock.ts:455: const MOCK_TESTRUN_D1_MAX_SPAN_DAYS = 366 * 5;
web/src/api/mock.ts:456: const MOCK_TESTRUN_MINUTE_MAX_SPAN_DAYS = 93;
web/src/api/mock.ts:1553:  req.period === 'D1' ? MOCK_TESTRUN_D1_MAX_SPAN_DAYS : MOCK_TESTRUN_MINUTE_MAX_SPAN_DAYS;
web/src/api/mock.ts:1557:   `HTTP 400: 试算区间超限：${req.period} 跨度 ${spanDays} 天 > 上限 ${limitDays} 天`,
web/src/api/mock.test.ts:495: // D1 超 5 年 → 400（MINOR-4：试算区间上限对齐后端（D1≤5年 / 分钟级≤3个月）超限 → 400）
```
- mock 的 `runStrategyTest` 与**后端已物理删除的规则相反**：`M1 × 1 年 → 400`、`D1 × 6 年 → 400`（后端实测 `200 OK`，见 §1.1）。
- `contract-vectors.json.span_limit_semantics.calendar_day_cap = null` 与本镜像**直接冲突**；§5.1 要求前端「镜像常量集中一处 + 防漂移断言」——本期前端镜像**分叉**。
- 同层缺口：mock `runStrategyTest` 响应**未回显** `downsampled`/`original_points`/`requested_*`/`effective_*`/`clamped`/`estimated_bars`（D11 + §3.1 回显面），⇒ 试算 UI 的 P5 行为**在 mock 上不可验**（`web/src/api/mock.ts:1593` 仍为 `truncated:{scores:false,...}` 且无 P5 字段）。
- 证据强度：本批 `npx vitest run` **872 tests passed** ⇒ 该旧断言**仍在生效**（不是「忘了跑」）。

### 2.3 N3 —— 旧断言静默残留（MEDIUM，反假绿条款 #4）

`crates/web/tests/api_strategies.rs:467-473`：
```rust
// 区间超限（D1 > 5 年）→ 400
let r = http.post(... "period": "D1", "from": "2020-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z" ...).send().await.unwrap();
assert_eq!(r.status(), 400, "D1 超 5 年应 400");
```
- 该断言**仍绿**（本批 `10_backend_full.txt` 中 `web/tests/api_strategies` 全绿），但 400 的**来源已换**：合成标的无 D1 数据 ⇒ `range_empty`（不再是「区间超限」）。⇒ 属「旧契约断言未按契约推导更新、也不再有替代断言」的静默残留；与 §1.1 的正面反证（**同一语义的真库请求应为 200**）并列时可见其已经**语义失真**。
- 同族文案残留（非断言，仅措辞误导，建议随修）：`application/src/strategy.rs:19`、`application/src/workbench.rs:21`、`web/src/workbench.rs:206`、`web/src/strategies.rs:386` 仍写「区间上限 D1≤5年 / 分钟级≤3个月」；`web/src/features/strategies/TestRunPanel.tsx:239` 仍写「超出上限，仅展示前段」（后端已改**均匀抽样保首尾**，`truncated.scores` 恒 false），且无 `downsampled` 标注展示。

### 2.4 N4 —— 前端真渲染未闭环（MEDIUM，证据缺口）

- **已完成**：日期控件 `min/max` 随标的+周期联动 + 可用区间文案（§1.8，真浏览器+真库）。
- **受阻点（原始输出 `82_playwright_p5.txt`）**：
```
[真渲染] /api/strategies 响应= ["200 http://127.0.0.1:15173/api/strategies [{\"strategy\":{\"id\":\"st_1789013713975_000000\",\"name\":\"双均线交叉\",..."]
[真渲染] 策略下拉 option 数= 1
expect(received).toBeGreaterThan(expected)  Expected: > 1  Received: 1
at .../p5_real_render.e2e.ts:32  (await expect.poll(...option count...).toBeGreaterThan(1) 超时 20s)
```
  ⇒ 第二实例上 `/api/strategies` **返回 200 且含条目**，但工作台「添加策略」下拉**只有占位项** ⇒ 无法添加 slot ⇒ **无法在 UI 内提交 run** ⇒ `clamped` 提示条 / `resource_guard` 二次确认 / 结构化错误展示三条**未能真渲染**。
  （`GET /` 返回 503：`config/app.toml` 的 `static_dir=/app/dist` 为容器口径，本地不存在 ⇒ 真渲染改走 vite dev + `/api` 代理，见 `83_second_instance_http.txt`。）
- **残留风险**：上述三条 UI 行为目前**仅有 jsdom 证据**（`web/src/features/workbench/ConfigPanel.test.tsx`），按 `03-test-plan.md` §5 #2「禁止以 jsdom/桩作为前端验收」**不得**作为 P5 前端验收结论 ⇒ 需在 P6 真渲染批次内补测（或本次修复 N2 后一并补）。
- 备注：受阻原因（下拉空）**不是** P5 改动引入的必然结果，可能是第二实例/环境侧（catalog 已 200 有条目）；已如实登记，不做归因猜测。

### 2.5 N5 —— ③ 执行时收缩语义与文档/契约字面不一致（LOW-MEDIUM）

实测（`31_tester_p5_indep_final.txt` 第 2 条观察）：
- 左端被夹、**右端未夹**（请求终点 = 段1 末 bar + 1min）时，`effective_to` 仍被收窄为 `02:29:01`（区间内末 bar + 1s），**不是**请求值 `02:30:00`；
- 右端被夹、左端未夹时，`effective_from` 被**前移**到「区间内首个真实 bar」（`T0+4d` → `T0+7d`，跨越空档）。
- 原因（只读定位）：`application/src/workbench.rs` 的执行时收缩以**单个 `clamped: bool`** 为守卫，命中即**两端**都按 `in_range` 首末 bar 收紧；而 worker U2 声称「仅**被夹端**生效」。
- 契约字面：§3.1 步骤 5 = `effective = [max(from, avail.from), min(to, avail.to))`；D3 追加「执行时以真实首末 bar 为准」——**新增语义应回写 §3.1 步骤 5/§3.1.1 或 ADR D2/D3**（属文档同步项）。
- 影响界定（已用代码路径确认）：`bars` 取数发生在该调整**之前**，因此**喂入引擎的 bar 集合不变**（无功能回归）；差异仅落在**落库 `from_ts/to_ts`、提交响应回显、以及按 run 区间读结果的调用方**（≤1 根 bar 级边界偏移）。**"中间缺口不截断" 在 `clamped=false` 时可证（§1.2），在任一端被夹时被回显收窄所掩盖**（引擎行为不变）。

### 2.6 N6 —— 环境卫生：worker 遗留临时库（MEDIUM，ADR-025 D3）

验收开始时库清单含 worker 遗留库：`tmp_p5_1789716888`（**443 MB**，`tmp_p5_<ts>` 命名 ⇒ P5 worker 车道产物），与任务纪律「每次 teardown 后只剩 {eestock, postgres}」及 ADR-025 D3（残留必须清理/带 owner+到期日）冲突。验收时已 `DROP DATABASE … WITH (FORCE)`；**最终库清单 = `{eestock, postgres, template0, template1}`**（`90_db_list_after_teardown.txt`）。

---

## 3. 范围与纪律核对

### 3.1 纪律（全部遵守）
- 需 DB 的测试：`EESTOCK_TEST_DB_NAME=tmp_p5_1789718551 scripts/testdb-init.sh` → 跑 → `DROP DATABASE … WITH (FORCE)` → **回读库清单只剩 {eestock, postgres}**（模板库除外，`90_db_list_after_teardown.txt`）。
- **未对活库应用 0027**（临时库由 init 脚本按迁移顺序自行应用）；**未对活库写入 run**（真实 run 只在临时库/第二实例上跑）；`git add` / `git commit` 均**未执行**。
- **未修改生产代码**。唯一的实现文件改动是**反向扰动取证**：`crates/storage/src/backtest.rs` 一行（`period_avail_sql(M30)` → accurate 单层），取证后**逐字节复原**（sha256 `72f3debcfec24199cc1a0a6d2d5f8578e5118ae4e3e9bb2f04faf1880efc6368` 前后一致，`50/52_*.txt`）。
- 新增文件仅 tester 车道：`crates/web/tests/tester_p5_indep.rs`（未 add）、`tester/evidence/253_adr024_p5_verify/**`、本报告。临时 Playwright harness（`web/e2e-tester-p5/`）用后已删除，规格与转录留在 `tester/evidence/253_adr024_p5_verify/pw/`。
- 第二实例与 vite dev 进程均已 kill（无残留进程）。

### 3.2 `git diff --cached` 分类（`72_git_diff_cached_names.txt`）
| 车道 | 计数（顶层路径） | 说明 |
|---|---|---|
| `coder/evidence` | 152 | P0–P6 证据（含本批 `adr024_p5/01–12`） |
| `coder/report` | 8 | 各阶段交付报告 |
| `web/src` | 26 | 前端（P0/P4/P5/P6） |
| `crates/{application,strategy-runtime,web,storage,strategy-core,mcp,backtest,simlive,domain}` | 42 | 实现（含 P5 的 `application/src/error.rs` 新文件） |
| `design/{02-domain,04-storage,07-app-plane}` | 5 | tangle 回写文档（P5 worker 声明范围） |
| `design/16-backtest-scalability` | 5 | **见 §3.3** |
| `migrations/0027_…sql` | 1 | P4 迁移（未应用到活库） |

### 3.3 `design/16-backtest-scalability/**` 是否被 worker 改动
- **可断言**：本批**未**观测到任何「让实现与契约对齐」方向的 P5 契约改动；`02-spec.md` §3.1/§3.1.1 关于日历档删除、收缩、`range_empty`/`resource_guard`、抽样标记的文字与实现一致（我逐条比对 §1 的实测输出与 §3.1 文字）；`contract-vectors.json` 仍为 `calendar_day_cap: null`、`deleted_constants: ["MINUTE_MAX_SPAN_DAYS","D1_MAX_SPAN_DAYS"]`、`sampling.must_mark`、`progress.primary/fallback` —— **未被反向修改**。
- **不可断言（诚实登记）**：ADR-024 全部工作（P0–P6）**均未提交**（`HEAD` = ADR-023 E6b `18d1b9a`），`design/16/**` 无已提交基线 ⇒ 「非 worker 改动」**无法用 `git diff` 证明**。可见事实：`design/16` 有 5 个文件在 index、其中 `02-spec.md`/`04-implementation-plan.md` 另有**未暂存改动**（内容是**架构师侧**：`/fills` 的 `recorded` 语义（标注「0046 审定（P6 升级裁决）」）、P6 冻结标记、**R10 关闭**）—— 与 P5 实现无关，且**未被 P5 worker 纳入 index**。
- 结论：**不能给出「design/16 未被 worker 触碰」的强断言**；只能给出「契约文本与实现一致、契约向量未被反向修改」的**实质断言**（上一条）。

---

## 4. 未复核项（诚实登记，附原因）

| # | 项 | 原因 | 残留风险 |
|---|---|---|---|
| U1 | R10 取数标度（861k bar → 3,500 ms）**未独立复跑** | 时间预算（单车道 30 分钟上限；优先保 §1 的判据项） | 低：worker 证据 `03_r10_fetch_scaling.txt` 与代码路径（`period_range_sql` 单次区间查询）一致；**R10 改判本身不改变 P5 判词** |
| U2 | worker 对 **tester 车道文件**的机械改动（`tester_p2b_tryrun_indep.rs`、`tester_p4_writepath_indep.rs`、`tester_p4_endpoints_indep.rs`） | 三文件**未跟踪**（无基线可 diff） | 中：我抽查到 P5 相关改动仅 `confirm: false,`（2 处）+（worker 自述）P4 右端对齐；**无法证明其余行未被弱化** ⇒ 见 §6 待办 |
| U3 | `web/src/features/strategies/TestRunPanel.*` 的 P5 语义（抽样标注/D11 展示） | 不属 worker 声明范围，且 mock 未回显 P5 字段（N2） | 中：试算 UI 仍可能显示「仅展示前段」的旧措辞（§2.3） |
| U4 | P6 前端覆盖面（`has_more`/`next_offset`/`/bars`/`/curve`/`result_format` 消费） | 属 P6 验收范围，非本批 | 高（**上线硬门槛**）：`04-implementation-plan.md` 明示「0027 + P4 不得单独上线」；本报告**不**为 P6 背书 |

---

## 5. 回归与门禁原始汇总

| 门禁 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 后端全量 | `cargo test -p storage -p application -p web -p mcp`（临时库） | **513 passed / 0 failed / 0 ignored**（60 target） | `10_backend_full.txt` |
| tester 独立 P5 | `cargo test -p web --test tester_p5_indep` | **12 passed / 1 failed**（唯一红 = N1 红探针，符合预期） | `31_tester_p5_indep_final.txt` |
| 前端全量 | `npx vitest run` | **90 files / 872 tests passed** | `20_frontend_vitest.txt` |
| 类型 | `npx tsc -b` | exit=0 | `41_frontend_tsc.txt` |
| 构建 | `npm run build`（vite） | 成功（`✓ built in 2.04s`） | `40_frontend_build.txt` |
| tangle | `./scripts/check-tangle.sh` | ✅ exit=0（沙箱重生成 + 逐字节比对） | `70_check_tangle.txt` |
| 第二实例构建 | `cargo build -p app` | `Finished dev profile in 5.35s` | `42_app_build.txt` |
| 真渲染（部分） | `npx playwright test`（vite dev + 第二实例 + 临时库） | 日期控件联动断言**通过**；后续流程受阻（N4） | `82_playwright_p5.txt` |
| 库卫生 | 回读库清单 | `eestock / postgres / template0 / template1` | `90_db_list_after_teardown.txt` |

**反向证据汇总（反假绿）**
| # | 扰动 | 结果 | 复原 |
|---|---|---|---|
| R1 | `period_avail_sql(M30)` 改回 **accurate 单层** | 我的并集用例 **FAILED**（`to=05:30:01Z ≠ 07:30:01Z`） | sha256 一致 + 复绿（`51/52_*.txt`） |
| R2 | （我自建）**红探针**：断言 `period_invalid`/`from_after_to` 为结构化 code | **FAILED**（实得 `{"error":"<字符串>"}`）⇒ 证明 N1 真实存在、且该断言具有判别力 | 不适用（缺口未修） |

> 说明：worker 自证的三条反向扰动（span cap 复现 ⇒ 红、guard 禁用 ⇒ 红、clamp 关闭 ⇒ 红，`coder/evidence/adr024_p5/05–07`）**未被我复跑**；但其结论与我的独立用例（§1.1/§1.2/§1.4）方向一致，且我的 R1 覆盖了 worker `01/02` 的并集口径。

---

## 6. 待办（给架构师/后续车道的明确动作）

1. **修 N1**：`period_invalid` / `from_after_to`（以及 `WorkbenchValidation` 映射的其余参数类 400）统一为 `{"error":{code,message,detail}}`；`error` 字段**只允许一种类型**。验收探针：`crates/web/tests/tester_p5_indep.rs::t_p5_http_structured_error_shape`。
2. **修 N2**：删除 `web/src/api/mock.ts` 的 `MOCK_TESTRUN_*_MAX_SPAN_DAYS` 与「试算区间超限」分支，改为「可得区间收缩 + `range_empty`」；mock 响应补 P5 回显（`downsampled`/`original_points`/`requested_*`/`effective_*`/`clamped`/`estimated_bars`）；同步订正 `mock.test.ts` 的 MINOR-4 用例。
3. **修 N3**：`crates/web/tests/api_strategies.rs:467-473` 按契约推导改写（**有 D1 数据的标的 × >5 年 ⇒ 200 + 回显**），不得以「换个理由的 400」保留；顺手清理 §2.3 的过期措辞（4 处注释 + `TestRunPanel` 文案）。
4. **订正 N5**：要么把 `effective_*` 定义为「执行时真实首末 bar」（则应把 §3.1 步骤 5/D3 的字面改写并更新 U2 说明），要么限制执行端只收窄**被夹端**（恢复 U2 声称的语义）。二者任选其一，**必须文档与实现一致**。
5. **补 N4**：真渲染补齐 `clamped` 提示条 / `resource_guard` 二次确认 / 结构化错误展示（并解决工作台策略下拉在第二实例上无条目的问题）。
6. **复核 U2**：worker 对 tester 车道未跟踪文件的机械改动，需由 tester 逐行复核（或重建基线）。
7. **卫生**：临时库 teardown 必须落在**最后一步之前**（本批 worker 遗留 443MB 库，ADR-025 D3）。

---

## 7. 证据清单（`tester/evidence/253_adr024_p5_verify/`）

| 文件 | 内容 |
|---|---|
| `01_tempdb_init.log` | 临时库供应（迁移 + 只读基线播种） |
| `10_backend_full.txt` | 后端 4 crate 全量测试（513 passed / 0 failed） |
| `20_frontend_vitest.txt` | 前端全量 vitest（90 files / 872 tests） |
| `30_tester_p5_indep.txt`（中间态）/ `31_tester_p5_indep_final.txt` | **tester 独立 P5 13 例**（12 green + N1 红探针）含全部 `[①]…[⑦]` 原始打印 |
| `40_frontend_build.txt` / `41_frontend_tsc.txt` / `42_app_build.txt` | 前端构建 / tsc / 第二实例二进制构建 |
| `50_reverse_union_hash_before.txt` / `51_reverse_union_accurate_only_red.txt` / `52_reverse_union_restored_hash.txt` | **R1 反向证据**（扰动 sha256 → 红 → 复原 sha256） |
| `60_residual_grep.txt` | 旧日历档/旧文案残留扫描（N2/N3 依据） |
| `70_check_tangle.txt` | tangle 门禁 ✅ |
| `71_p4p6_nonregression.txt` | P4/P6 面未回退证据（`/fills`+`recorded`、分块写、`P4B_GLOBAL`、SSOT） |
| `72_git_diff_cached_names.txt` | `git diff --cached --name-only` 分类原始清单 |
| `80_second_instance.log` / `81_vite_dev.log` / `83_second_instance_http.txt` | 第二实例（临时库）+ vite dev + 真库端点输出 |
| `82_playwright_p5.txt` | **真渲染**转录（可用区间联动通过；clamped/guard 受阻点） |
| `90_db_list_after_teardown.txt` | teardown 后库清单（只剩 eestock/postgres） |
| `pw/` | Playwright 规格 + 配置 + 产物（`pw-artifacts/`） |

**新增 tester 测试载体**：`crates/web/tests/tester_p5_indep.rs`（13 例；**未 `git add`**；其中 `t_p5_http_structured_error_shape` 为 N1 红探针，冻结前应转绿）。
