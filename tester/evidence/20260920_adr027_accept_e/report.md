# ADR-027 / ADR-028 结果载荷 v2 · 闸门 3 E 段复跑 + 闸门 2 反例挖掘（tester 独立验收）

**E 段 通过（后端契约 + 四条恒等式 + 前端 tsc/vitest 全绿；E1–E4 真渲染浏览器级未执行 ⇒ 该项单独标 INCONCLUSIVE，见 §3.3） ｜ I1 通过 ｜ I3 通过 ｜ I4 通过 ｜ 持仓序列恒等式 通过 ｜ 反例挖掘 发现 4 处（0 阻断 / 0 高 / 1 中 / 3 低），另 2 项明确未发现 ｜ 是否建议冻结：否（附放行条件 §5）**

- 本文件位置：`tester/evidence/20260920_adr027_accept_e/report.md`
- 批次根目录：`tester/evidence/20260920_adr027_accept_e/`（`raw/` 为逐项原始输出；`raw/e2e/` 为逐端点 JSON）
- 契约事实源：`design/17-trade-detail-layering/02-spec.md`；判据：`.../03-test-plan.md`（E 段 §6；闸门 2 §7.2）
- 我自己的验证时间：2026-09-19 15:39Z – 16:14Z（本地 23:39 – 00:14）；HEAD commit `0fdd83e`（工作区含 coder 车道未提交实现）
- **纪律**：未修改任何生产代码；未分析失败（本轮无失败需分析）；未尝试修复。本轮新增文件**仅**在本报告目录 `tester/evidence/20260920_adr027_accept_e/` 之下。
- 我未引用任何他人输出作为判据：所有判词均来自本轮我自己执行命令的输出（curl / psql / python 对 HTTP 的独立读取）。

---

## 0. 静止性与环境（原始证据）

### 0.1 树静止判定：**成立**
```
$ date ; find . -path ./target -prune -o -path ./.git -prune -o -path ./web/node_modules -prune -o \
        -path ./tester -prune -o -type f -newermt '-60 seconds' -print
Sat Sep 19 11:41:02 PM CST 2026
(空输出 ⇒ 入场前 60 秒内、排除我自有 tester/ 目录后**零写入**)
$ ps aux | grep -E '\bcargo\b|\brustc\b|vite|vitest'   → 空
```
- 最后一次 coder 写入：`coder/evidence/20260920_adr027_p4b_kind_migration/report.md` @ 23:39:24（本地）；我入场判定时刻 23:41:02 ⇒ 静默窗 ≥ 60s 成立。
- 起始树哈希（`crates` + `web/src` + `migrations` + `design/17-trade-detail-layering` 全量 sha256 汇总）：
  `c3455cdfd9db51f952033e3e6ff3abb9485a2121cdc8d7ab3198b5cac2d9ba9e`
  → `raw/00_tree_hash_start.txt`；静止核对 → `raw/00_quiet_check.txt`
- 服务：8081/8082 = `eestock-app` pid 1781236（started 23:30:48），exe = `target/debug/eestock-app`（mtime 23:26:38，含 ADR-027 实现）；5433 = `eestock-timescaledb`（healthy）。

### 0.2 前置事实复核（我自己查库，不引用他人结论）
```
$ psql -p 5433 -d eestock -c '\d strategy_run_bars'
Check constraints:
  "strategy_run_bars_kind_check" CHECK (kind = ANY (ARRAY['per_bar','net_value','drawdown','fills','position']))
⇒ 迁移 0029 在**活库**已生效（kind 含 position）。
$ migrations/ 最新：0028_sim_trades_fee_split.sql、0029_strategy_run_bars_kind_position.sql
⇒ 0028（sim_trades 费用拆列）文件在位（活库 sim_trades 列结构本轮未直接复验，属 D 段范围）。
```
**口径澄清（非缺陷，但需父级知晓）**：P4b 的「真库端到端 position 分块」证据 `sr_1789832284173_000004`（`raw` 见
`coder/evidence/.../70_end_to_end_position_chunk.txt`）实际落在**测试库 `eestock_test`**（我查证：该 run 只在 `eestock_test`，
活库 `eestock` 无此 run；且该 run 是 6 根合成夹具 91794124000）。因此 P4b 主张的「真库」= 测试库，「迁移已应用活库」= 我已独立复核为真。
**在我入场前，活库上尚不存在任何跑通的新 run**（活库最新成功 run 为 `sr_1789826383501_000000` @ 21:59 本地，且无 position 分块）。
本轮 E 段因此是活库上的**首次**端到端成功取证。

---

## 1. E 段 · 后端契约（活库真 run，全部我自己重跑）

### 1.1 本轮创建的 run（HTTP 201 提交 → 我自己轮询到终态）

| run | symbol/period | 策略/参数 | 终态 | 回合数 | 说明 |
|---|---|---|---|---|---|
| `sr_1789832477006_000002` | 159776 / D1 | Dca 1000×tranches100（实际 15 批） | succeeded | 1 | **DCA 多批**（15 买） + ForceClose 终结（强平） |
| `sr_1789832517708_000005` | 159776 / D1 | 双均线交叉 + Dca | succeeded | 5 | 5 个 Policy 终结回合（无强平） |
| `sr_1789832517800_000006` | 518880 / M5（1699 根） | 双均线交叉 + Dca | succeeded | **48** | 48 回合 / 96 笔，含 1 例 ForceClose ⇒ 分页与 I4 最强样本 |

原始：`raw/e2e_00_run_*.json`（提交响应）、`raw/e2e_01_run_a.json`、`raw/e2e_02_run_a_final.json`。
**结论：迁移修复后，活库新 run 可 succeeded 且 `kind='position'` 分块落库**（我在 §2.3 用 position 曲线 1699 点取证，等价于分块已落库）。

### 1.2 `/round-trips`（L1 列表 + 摘要 + 分页）

| 检查 | 命令/参数 | 结果 | 判词 |
|---|---|---|---|
| 信封字段 | `GET /round-trips?offset=0&limit=2` | `run_id,total,recorded,offset,limit,has_more,next_offset,round_trips` 齐备 | 通过 |
| `l2_count` == 该回合 fills 数 | 48 回合逐条（`limit=4` 分页累加 vs `/fills?round_trip=`） | 全部相等，0 处不符 | 通过 |
| `buy_count`/`sell_count` | 逐条对比 L2 买卖笔数 | 全部相等 | 通过 |
| 分页正确性 | 48 回合用 `limit=7` 翻 7 页 | 累加 == 全量（逐条相等），`has_more`/`next_offset` 0 处不符 | 通过 |
| `offset` 越界 | `offset=9999&limit=5` | 200 + `round_trips:[]` + `has_more:false` + `total` 不变 | 通过 |
| `limit=0` | `offset=0&limit=0` | 200，`limit` 被夹为 **1**（回显 1，返回 1 条） | 通过（夹取，非静默截断） |
| `limit` 超上限 | `limit=100000` | 200，`limit` 夹为 **20000** | 通过 |
| `offset=-1` | `offset=-1&limit=2` | 200，`offset` 夹为 0 | 通过 |
| 原始输出 | `raw/e2e/01..05_*`、`raw/e2e_03_round_trips_probe.txt`、`raw/13_pagination.txt` | | |

### 1.3 `/round-trips/{rt_seq}/fills`（L2 切片）

| 检查 | 结果 | 判词 |
|---|---|---|
| `rt_seq=1` 切片 = 该回合全部 16 笔（DCA run） | 200 + `fills` 含 `code,rt_seq,bar_index,ts,side,qty,price,trade_value,commission,stamp_duty,reason,type` | 通过 |
| 未知 `rt_seq=999999` | **404** `{"error":"回合 999999 不属于运行 …（无该回合的成交事实）"}` | 通过（禁空数组冒充） |
| `rt_seq=0` | 404 | 通过 |
| `rt_seq=abc` | 400，但响应体是**纯文本** `Invalid URL: Cannot parse value at index 1 with value \`abc\` to a \`u32\`` | **发现 L-2（低）**：非结构化错误（其它端点统一 `{"error":{code,detail,message}}`） |
| `limit=0` | 200，夹为 1 条 | 通过 |
| `offset` 越界 | 200 空页 + `has_more:false` | 通过 |
| 分页 | 逐回合 `limit=4` 累加 == `l2_count`（抽 9 个回合） | 通过 |
| 原始输出 | `raw/e2e/06..12_*`、`raw/13_pagination.txt` | |

### 1.4 `/fills`（增量字段 + round_trip 过滤）

- 元素含 `rt_seq`/`trade_value`/`commission`/`stamp_duty`，且 `trade_value == qty × price` 逐笔成立、买入 `stamp_duty == 0`（§2 I1 断言）。
- `?round_trip=1` 返回集合 == L2 切片集合（**除 `code` 字段**，见发现 L-1）。
- 未知回合 `?round_trip=999999` → **200 + 空数组**（`total:0`），非 404 ⇒ **发现 L-3（低）**：与 `/round-trips/{rt_seq}/fills` 的 404 语义不一致，UI 若用 filter 做对账会静默得到空集（前轮已列为契约歧义，本轮复现）。
- 原始输出：`raw/e2e/13..16_*`、`raw/14_fills_shape_diff.txt`。

### 1.5 `/curve?kind=position` 与时间窗（**重采样而非裁剪**，ADR-028 D3）

样本：`sr_1789832517800_000006`（1699 根真实 bar）。完整点集：`n=1699, downsampled=false, original_bars=1699`。

| 用例（from,to,k） | points | window_from_ts | window_to_ts | window_bars | 窗口内原始根数（我自己数） | 首点 ts | 末点 ts | 判词 |
|---|---|---|---|---|---|---|---|---|
| 中段 200 根, k=8 | 8 | =from | =to | 200 | 200 | =from | =to | **重采样**（若为「全区间采样后裁剪」只会剩 ~1 点） |
| 中段 200 根, k=2000 | 200 | =from | =to | 200 | 200 | =from | =to | 不抽样，窗口全量 |
| 中段 200 根, k=1 | 2（首末保点） | =from | =to | 200 | 200 | =from | =to | 通过 |
| 全区间, k=8 | 8 | =from | =to | 1699 | 1699 | =from | =to | 与今日行为兼容 |
| from 落在 bar 中部（+60s） | 8 | =from | =to | **199** | 199 | 首个 ≥from 的 bar | =to | 窗口计数按**真实根**而非算术 |
| 窗口内无 bar | 0 | =from | =to | **0** | 0 | — | — | 诚实留白（非 0 点冒充） |
| 单根窗口 | 1 | =from | =to | 1 | 1 | =from | =to | 通过 |
| `from_ts > to_ts` | 400 `{"error":{"code":"from_after_to",…}}` | | | | | | | 响亮失败 |
| 缺省无窗口 | 1699 | null | null | 1699 | — | — | — | 向后兼容 |
| 跨 kind 同窗（position/net_value/drawdown/per_bar，k=2000） | 各 200，`window_*` 与首末 ts **一致** | | | 200 | 200 | =from | =to | 四 kind 同窗同域 |

原始输出：`raw/11_window_probe.txt`、`raw/11_window_cases.json`、`raw/12_window_more.txt`。
`/curve?kind=fills` 与 `kind=bogus` 均 400 + 结构化 `kind_invalid`（白名单不变，C6 通过）。

### 1.6 `/audit` 增量

```
{"round_trips_total":48,"round_trips_force_closed":1,"round_trips_closed":48,"round_trips_open":0,
 "rt_reconcile":{"checked":48,"mismatched":[],"tolerance":1e-06}, ...}
```
三个 run 的 `rt_reconcile.mismatched` 均为空，`checked == round_trips_total`（1 / 5 / 48）。
原始：`raw/e2e/21_audit.json`、`raw/e2e/audit_<run>.json`。

---

## 2. 恒等式逐条取证（`raw/verify_identities.py` → `raw/10_identities.json`）

对 3 个真 run（1 / 5 / 48 回合）**逐回合、逐字段**运算，全部基于我从 HTTP 取回的原始 JSON：

### 2.1 I1（逐回合 Σ L2 字段 == L1 同名字段）：**通过**
对每个回合的 16 个字段做等值比较（浮点用相对 1e-9）：`gross_value / commission / stamp_duty / shares / open_price / close_price / open_bar / close_bar / hold_bars / pnl / buy_count / sell_count / l2_count / open_ts / close_ts / reason`。
- 不符条目数：run 000002 = **0**，run 000005 = **0**，run 000006 = **0**。
- 另加逐笔不变量：`trade_value == qty×price`、买入 `stamp_duty == 0`、Closed 回合 `pnl == Σsell(tv−comm−stamp) − Σbuy(tv+comm)` —— 均成立（`pnl` 用**全回合现金流**口径复算，未用末笔卖出）。
- `Open` 回合 `pnl` 必须为 null：本轮 3 个 run 的 `round_trips_open` 均为 0（回测侧期末强平 ⇒ 不存在 Open 回合），该分支**未在活库取得正样本**（诚实标注；U3/U 段单测覆盖，非本轮取证）。

### 2.2 I3（nav 恒等式）：**通过**
`nav[-1] == initial_capital + Σ_closed(pnl) + Σ_open(gross_value − invested + position_value_at_last_bar)`

| run | nav[-1]（position 曲线末点） | RHS | Δ | 容差 1e-6·max(1,|nav|) | 判词 |
|---|---|---|---|---|---|---|
| 000002 | 100657.1243467376 | 100657.1243467376 | 0.0 | 0.1007 | 通过 |
| 000005 | 99953.0871377441 | 99953.08713774412 | −1.46e-11 | 0.09995 | 通过 |
| 000006 | 99582.14238086533 | 99582.14238086536 | −2.91e-11 | 0.09958 | 通过 |

### 2.3 I4（回合自洽）：**通过**

| run | distinct rt_seq | `/result`.trades 长度 | audit.round_trips_total | ForceClose 终结数 vs audit.round_trips_force_closed | closed/open 对账 |
|---|---|---|---|---|---|
| 000002 | 1 | 1 | 1 | 1 vs 1 | 1/0 一致 |
| 000005 | 5 | 5 | 5 | 0 vs 0 | 5/0 一致 |
| 000006 | 48 | 48 | 48 | 1 vs 1 | 48/0 一致 |

且 `reason == 'ForceClose'` 的 rt_seq 集合大小 == `audit.round_trips_force_closed`（逐 run 相等）。

### 2.4 持仓序列恒等式：**通过**
对 65 / 174 / 1699 个 position 点逐点断言：
- `position_value + cash == nav`：0 处不符（3 个 run 合计 1938 点）；
- `nav > 0` 时 `position_ratio == position_value / nav`：0 处不符；
- `nav ≤ 0` ⇒ `position_ratio == 0`：本轮无 nav ≤ 0 的点（诚实标注：**该分支无正样本**，仅有代码/单测覆盖）；
- `ts` 严格单调递增：成立。
原始：`raw/10_identities.json` 的 `position` 字段（`bad_count: 0`）。

---

## 3. 前端复跑

### 3.1 `tsc -b`：**通过**（`TSC_EXIT=0`，`raw/20_tsc.txt`）
### 3.2 `vitest run` 全量：**通过**（**99 test files / 961 tests 全绿**，`VITEST_EXIT=0`，`raw/21_vitest.txt`；Start 23:42:31，Duration 8.53s）
### 3.3 E1–E4 真渲染浏览器级：**INCONCLUSIVE（未执行，非失败）**
原因：仓内**不存在** ADR-028 跳转/窗口联动的 Playwright spec（`web/e2e/*.e2e.ts` 无 ADR-027/028 用例；F 段断言均落在 jsdom 桩层）。
按任务要求给出**可执行步骤与前置条件**（供父级排下一车道）：

```bash
# 前置：1) 活库有可读成功 run（本轮已有 sr_1789832517800_000006 / 48 回合）；2) 8081 服务在跑（本轮已在）；
#       3) web 构建产物存在（web/dist，本轮未重建）
cd web
npx playwright install chromium           # 本机 ~/.cache/ms-playwright 已有 chromium-1234，通常可跳过
E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test --config playwright.config.ts <新增 spec>
```
待补 spec 的断言要点（对应 test-plan §6 E1–E4）：
- **E1**：L1 行 `[跳转]` 后，K 线可见 ts 区间 == 回合 `[open_ts, close_ts]`（±1 根），并**断言跳转成功**（`setBarSpace` 越界静默 return 是已知坑，见 §4.2-M1）；
- **E2**：L2 行 `[跳转]` 后窗口中心 bar ts == 该笔 `ts`（可配 120 根居中）；
- **E3**：同窗口下 position/net_value/drawdown 三 SVG 的 x 定义域 == 共享窗口（后端已证四 kind 同窗同域，见 §1.5；此处验前端不裁剪）；
- **E4**：`全览`/历史回退后窗口复位且请求数 ≤ 节流允许值（无请求风暴）。

---

## 4. 闸门 2 · 反例挖掘（逐项给证据或明确「未发现」）

### 4.1 重复买入出血与回合错配：**未发现**
- 在 3 个真 run（96 + 16 + 10 = 122 笔成交）中：**没有任何一个 bar 出现多笔成交**（同 bar 重复开仓/加仓/同 bar 反手样本数 = 0）；无零长回合（`open_bar == close_bar`）；无相邻回合 `close_bar == 下一个 open_bar` 的同 bar 反手。
- 因此「重复买入 / 回合错配」在**活库真实数据上未被触发**——不是「通过」，而是**无正样本**。现有覆盖仅来自 U/S 段向量（同一 bar 内 buy+sell 的零长回合、DCA 100 批），前轮已验；本轮**未**独立复跑该向量。
- 若父级要求硬证据：需构造同 bar 反手场景（如 M1 周期 + 策略在同一 bar 给出 Buy 后 Sell），本轮时间盒内未做。
- 原始：`raw/15_gate2_item1_samebar.txt`。

### 4.2 假覆盖：**发现 1 处中危 + 1 处低危**
- **M1（中）`setBarSpace` 越界在真渲染层未被断言捕获**：`web/src/test/syncChartStub.ts:7,29` 自陈「越界静默 return …… 推论**只在桩内成立，不得当作真身证据**（P3-C：`setBarSpace(302)` 在真渲染仍报 4 根可见）」。⇒ F9 的「防静默越界」判据只在**桩**层成立；E2 类跳转在真渲染上的成功性**无证据**。这正是 skill 文档列的静默失败路径，也是 §3.3 必须补 Playwright 的直接原因。
- **L-1（低）`/fills` 元素缺 `code` 字段**（L2 切片有）：`raw/14_fills_shape_diff.txt` 证明两源集合仅差 `code` 键。02-spec §1.1 规定 `FillFact.code` 为必需字段、且 `code` 是聚合分组键。⇒ 若做「两源逐笔相同」的强对账（R6 的兄弟断言），两者**不可能**逐字段相等（前轮 R6 自比较缺陷即在此区域）；`/fills` 无法表达多标的（sim-live）归属。属契约形状不一致（02-spec §5.4 只列了增量字段，未明文要求 `code`，故不判违约）。
- **P4b 两处测试缺陷已修**（我核对 coder 突变证据 `51_mutation_web_audit_keys.txt` / `52_mutation_r6_two_sources.txt`：先红后绿，非恒真）；**未在本批次新增/改写测试中发现自比较、恒真断言、只断言不抛错**（本轮未逐行复读全部新增测试；结论限于我检索到的突变证据）。

### 4.3 未挣得的绿（环境变量/门禁静默跳过）：**未发现（就 coder 本波声明而言）**
- `crates/test-support` 的 `test_pool()` 在 `EESTOCK_TEST_DATABASE_URL` 缺失时**panic**（响亮失败，明确禁止回退活库）——不是静默跳过：`raw/33_gate2_gated_tests.txt`。
- coder P4b 的 DB 门禁测试**确实执行**：`40_testdb_init.txt` 中 `export EESTOCK_TEST_DATABASE_URL='postgres://…/eestock_test'`，`50_web_adr026_run_audit_testdb.txt` 为 `4 passed; 0 failed`（含 `adr026_replay_target_run_matches_frozen_baseline`）。⇒ 该处「绿」是挣得的。
- 唯一 `#[ignore]` 是性能冒烟（`strategy-core/tests/engine.rs:744`），与新批次无关。
- **口径提示（信息级）**：P4b 把 `eestock_test` 的 run 表述为「真库」；活库与测试库是不同库，我已在 §0.2 澄清并以活库真 run 补齐。

### 4.4 口径回退：**未发现**
- **末笔卖出充当回合金额**：`grep -rn "last_sell|last_trade|sells.last()|sells.iter().rev()"` 在非测试代码中**零命中**（`raw/30_gate2_grep_caliber.txt`）。
- **按费率复算费用**：命中均为**入参/档案解析**（`crates/web/src/dto.rs` 校验、`crates/application/src/fee.rs` 的 `FeeModel` 构造与档案映射），无一处从 `(side,qty,price)+费率` 反算 `FillFact.commission/stamp_duty`；且我在 §2.1 用**引擎落库值**做逐笔加总，与 L1 逐位相符（若下游复算，最低佣金分支 `trade_value = budget − 5.0` 会导致不相等）。⇒ 未发现回退（`raw/31_gate2_grep_caliber2.txt`）。
- **ts / bar_sec 反算 bar 序号**：`strategy-core/engine.rs` 的 `bar_index` 一律来自循环下标 `i`（:833/:841/:855）；`application/simlive.rs:818,1934` 明确以注释与实现禁用 `ts / bar_sec`。⇒ 未发现回退。
- 活库抽查直证：`sr_1789832477006_000002` 的 fills `bar_index=261..314`（D1，warmup 250 之后），若为 `ts/86400` 反算将得到 ~20600 量级 —— 与 L1 的 `open_bar/close_bar` 一致，非反算值。

### 4.5 静默失败路径：**发现 1 处中危（=M1） + 其余已披露/未发现**
- `setBarSpace` 越界：见 M1 —— **真渲染层无断言**（中危，与 §4.2 同一条）。
- **截断披露**：`/result` 返回 `has_more/next_offset`（chunked 首页 5000）；`/round-trips`、`/fills`、`/bars` 均带 `total/has_more/next_offset`；前端 `useRunSeries.ts:232` 计算 `truncated` 并暴露给 UI。⇒ 未发现静默截断（本轮仅静态复核 + 端点字段实证，未做真渲染截图比对）。
- **`recorded=false` 不当成无数据**：`RoundTripsTable.tsx:308`、`KlineResultChart.tsx:99`、`PositionRatioChart.tsx:16`、`ResultView.tsx:157` 均对 `recorded=false` 走显式「未记录」分支（`ResultView.test.tsx:397,598` 有对应用例）。⇒ 未发现「把无事实读成 0」。
- **窗口请求失败用旧数据冒充**：`useRunSeries.ts:119,451` 明确「不更新 `windowApplied` ⇒ UI 显式标注『显示的是上一窗口数据』」。⇒ 代码层已处置（真渲染未取证）。

### 4.6 边界与分页：**发现 2 处低危**
- `offset` 越界 → 空页 + `has_more:false`（正确）；`limit=0` → 夹为 1（非 0，可能是调用方意外，但非截断）；`limit>20000` → 夹为 20000（**上限披露**在响应 `limit` 回显可见）⇒ 通过。
- 未知 `rt_seq` → 404（L2 端点）⇒ 通过；但 **L-3（低）**：`/fills?round_trip=<未知>` → 200 空页，与 L2 的 404 语义不一致（静默空集）。
- **L-2（低）**：`/round-trips/abc/fills` 的 400 是**纯文本**（axum 路径解析错误），与其余端点的结构化错误信封不一致。
- **`Open` 回合 `pnl=null` 是否被前端渲染为 0：未发现**。`roundTripAccum.ts:139` 的 `mk('pnl',…, rt.pnl, last?.cum_realized_pnl ?? 0, …)`：`l1 == null ⇒ delta = NaN ⇒ mismatched=false`，显示走 `fmtNum(null) → '—'`（`roundTripAccum.ts` 末尾）。`?? 0` 只作用于 **L2 累计侧**，不落在 L1 的 null 上。⇒ 不构成「null 冒充 0」。原始：`raw/34_gate2_open_pnl.txt`、`raw/35_open_pnl_render.txt`、`raw/36_recorded_ui.txt`。

### 4.7 发现清单（数量与严重度）

| ID | 严重度 | 内容 | 证据 | 是否阻断 |
|---|---|---|---|---|
| M1 | 中 | `setBarSpace` 越界静默 return 仅桩层断言，真渲染无证据（P3-C 实测 `302` 仍报 4 根可见）⇒ E2/E1 跳转成功性未挣得 | `raw/32_gate2_grep_silent.txt`、`web/src/test/syncChartStub.ts:29` | 否（放行条件） |
| L-1 | 低 | `/fills` 元素缺 `code`（L2 切片有），两源无法逐字段对账；sim-live 多标的归属在 `/fills` 不可表达 | `raw/14_fills_shape_diff.txt` | 否 |
| L-2 | 低 | `/round-trips/abc/fills` 400 为纯文本，非结构化错误信封 | `raw/e2e/12_rt_nonnum_400.json` | 否 |
| L-3 | 低 | `/fills?round_trip=<未知>` 200 空页 vs L2 404（语义不一致，静默空集） | `raw/e2e/15_fills_rt_unknown.json` | 否 |

**明确未发现**：口径回退（§4.4 四类全零命中）、假覆盖的恒真/削弱（本批次已披露的 2 处已修，其余未见）、未挣得的绿（§4.3）、`Open pnl` 误渲染为 0（§4.6）。

---

## 5. E 段判词与放行建议

| 项 | 判词 |
|---|---|
| E 段 · 后端契约（§1.2–1.6） | **通过**（活库真 run：L1 列表/摘要/分页、L2 切片 404、`/fills` 增量与过滤、`/curve` position+窗口重采样、`/audit` 增量） |
| E 段 · 恒等式 I1 | **通过**（3 run / 54 回合 / 0 处不符） |
| E 段 · 恒等式 I3 | **通过**（Δ ≤ 3e-11，容差内） |
| E 段 · 恒等式 I4 | **通过**（distinct rt_seq == trades 长度 == audit.total；ForceClose 数一致） |
| E 段 · 持仓序列 | **通过**（1938 点逐点自洽；nav ≤ 0 分支无正样本） |
| E 段 · 前端 tsc/vitest | **通过**（TSC_EXIT=0；99 文件 / 961 用例全绿） |
| E 段 · E1–E4 真渲染 | **INCONCLUSIVE**（无对应 Playwright spec；给出可执行步骤与断言要点 §3.3） |
| 闸门 2 · 反例挖掘 | 发现 4 处（M1 中危 + 3 低危）；2 类明确未发现；**0 阻断** |

**是否建议冻结：否。**
放行条件（不阻断合入，但建议在收尾波次/下一车道闭环）：
1. M1：补一条真渲染 Playwright 断言（E2 跳转后中心 bar == 目标 ts，且在 max barSpace 越界场景下断言**跳转失败被捕获**），否则 F9/E2 的「防静默越界」判据仅有桩层证据。
2. L-1/L-3：`/fills` 与 L2 切片的字段/未知回合语义对齐（`code` 字段；未知回合 404 或显式 `round_trip_exists:false`），或在 02-spec 明文豁免。
3. L-2：路径参数解析错误统一为结构化错误信封（`Invalid URL: …` 纯文本 → `{"error":{code:"path_param_invalid",…}}`）。
4. 无正样本分支（`Open` 回合 pnl=null、`nav ≤ 0 ⇒ ratio 0`、同 bar 反手）需在 U/S 段向量中保留锁定，或在下一轮构造真库样本。

---

## 6. 原始输出索引（`tester/evidence/20260920_adr027_accept_e/raw/`）

| 文件 | 内容 |
|---|---|
| `00_quiet_check.txt` | 静止性核对（进程/端口/60s 零写入） |
| `00_tree_hash_start.txt` | 入场时树哈希（生产源全量 sha256 汇总） |
| `e2e_00_run_a/b/c/d1ma/m5ma.json` | 5 次 run 提交响应（HTTP 201） |
| `e2e_01_run_a.json` / `e2e_02_run_a_final.json` | DCA run 提交时 / 终态 |
| `e2e_03_round_trips_probe.txt` | `/round-trips` 边界参数探测 |
| `e2e_04_probe_index.txt` + `e2e/01..23_*.json` | 23 个端点的状态码/字节数索引与逐端点原始 JSON |
| `e2e_04_probe_all.txt` | 端点探测（含截断，仅作补充） |
| `e2e/rt_*.json`、`e2e/audit_*.json` | 各 run 的 L1 列表与审计原文 |
| `10_identities.json` / `verify_identities.py` | I1/I3/I4/持仓序列逐回合运算与结果 |
| `11_window_probe.txt`、`11_window_cases.json`、`probe_window.py` | `/curve` 窗口 8 组用例（重采样 vs 裁剪） |
| `12_window_more.txt` | 反序窗口 400 结构化错误 + 四 kind 同窗一致性 |
| `13_pagination.txt` | `limit=7` 翻页等价性、L2 分页/过滤对账、信封字段 |
| `14_fills_shape_diff.txt` | `/fills` vs L2 切片逐笔差异（`code` 键） |
| `15_gate2_item1_samebar.txt` | 同 bar 多笔/反手/零长回合统计（未发现） |
| `20_tsc.txt` / `21_vitest.txt` | 前端 `tsc -b` / `vitest run` 全量输出与退出码 |
| `30/31_gate2_grep_caliber*.txt` | 口径回退 grep（末笔/费率复算/bar 反算） |
| `32_gate2_grep_silent.txt` | 静默失败路径 grep（setBarSpace/截断/旧数据冒充） |
| `33_gate2_gated_tests.txt` | DB 门禁测试入口（缺 env 时 panic，非静默跳过） |
| `34/35/36_*.txt` | `Open pnl` 渲染、`roundTripAccum` 对账、`recorded` UI 分支 |

---

## 7. 收尾自证：验收期间我未改动任何生产代码

```
$ find crates web/src migrations design/17-trade-detail-layering -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
入场 23:41:02  c3455cdfd9db51f952033e3e6ff3abb9485a2121cdc8d7ab3198b5cac2d9ba9e
收尾   c3455cdfd9db51f952033e3e6ff3abb9485a2121cdc8d7ab3198b5cac2d9ba9e   （逐字节相同）
$ find crates web/src migrations -type f -newermt '2026-09-19 23:41:00'   → 空
$ git status --porcelain | grep -v '^A  coder/' | grep -v 'tester/'
 → 仅 coder 车道**入场前已 staged** 的 M/A 条目（未新增、未改写）
```
原始：`raw/00_tree_hash_start.txt`、`raw/99_tree_hash_end.txt`、`raw/00_quiet_check.txt`。
本轮我新增的文件**全部**位于 `tester/evidence/20260920_adr027_accept_e/`（报告 + raw 输出 + 2 个只读校验脚本 `verify_identities.py`、`probe_window.py`）。
