# ADR-026 回测系统端到端冒烟（API / 引擎 / 边界 / 可观测性）

- **本文件位置**：`tester/evidence/20260919_adr026_smoke_backtest/README.md`
- **原始输出目录**：`tester/evidence/20260919_adr026_smoke_backtest/raw/`
- **执行时间**：2026-09-19 11:18:31 → 11:20:00 CST（Asia/Shanghai，UTC 03:18:31 → 03:20:00）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **被测形态（先确认后测试）**：
  - PID **818710**（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，cwd=仓库根，2026-09-19 11:17:10 启动）
  - 同时持有 **8081**（Web）与 **8082**（MCP SSE）；`GET /healthz` → `{"status":"ok"}`
  - 上游部署证据：`coder/evidence/20260919_adr026_redeploy/`
- **纪律遵守**：未执行 `git add / commit / checkout / stash / reset`；`git diff --cached --stat` 为空（0 staged）；**未改动任何业务代码**（`git status` 中的 M 文件全部为 ADR-026 交付既有改动，本阶段未触碰）；本阶段**未运行需临时库的 cargo 测试**，故无 ADR-025 临时库、无需 DROP（`pg_database` 无 adr025/test 残留）。
- **测试用 run 全部保留**（未删除任何 run 数据）。唯一一次 `cancel` 是针对 68.6 万根 M1 的超大 run（见 S3b，为保护宿主机），取消不删除数据。
- **硬时限**：25 分钟；实际耗时约 **1.5 分钟**（所有命令均在 4 分钟内返回，无 kill）。

## 裁决摘要

| 分节 | 内容 | 结果 |
|---|---|---|
| S1 | Web REST 全链路（提交→状态迁移→result/fills/bars/curve/audit 自洽） | **PASS** 29/29 断言 |
| S2 | MCP 入口平价（bt_run_ensemble + bt_get_run_audit vs REST） | **PASS** 16/16 检查 |
| S3 | 边界与护栏（越界 clamp / M1 护栏 / 未知 run / 非法参数） | **PASS**（含 2 项观察项，见 §3 备注） |
| S4 | 周期覆盖 M30 + M1 小跨度 | **PASS** |
| S5 | 可观测性（trace_id / p4b.segment / run_summary / workbench_run_audit span） | **PASS** |
| S6 | 负面对照（禁假绿：断言可红 + PARTIAL_DEPLOYMENT 不误报） | **PASS** 9/9 |

### 本次使用的 run 清单（全部保留）

| 用途 | run_id | symbol/period | 区间 | 提交入口 | 终态 |
|---|---|---|---|---|---|
| S1 主 run | `sr_1789787931919_000001` | 518880 / D1 | 2025-01-01→2025-12-31 | REST POST | succeeded |
| S1 复现 run | `sr_1789787911898_000000` | 518880 / D1 | 2025-01-01→2025-12-31 | REST POST | succeeded |
| S2 MCP run | `sr_1789787945018_000002` | 518880 / D1 | 2025-01-01→2025-12-31 | MCP `bt_run_ensemble` | succeeded |
| S3a 越界 clamp | `sr_1789787954285_000003` | 518880 / D1 | 2020-01-01→2027-12-31 | REST POST | succeeded（clamped） |
| S3b M1 护栏 confirm=true | `sr_1789787967063_000004` | 518880 / M1 | 2015-01-01→2027-01-01 | REST POST | **canceled（我方主动，68.6 万根）** |
| S3b M1 大跨度 | `sr_1789787971134_000005` | 518880 / M1 | 2020-01-01→2027-01-01 | REST POST | succeeded |
| S3b M1 大跨度（confirm=true 重复） | `sr_1789787975419_000006` | 518880 / M1 | 2020-01-01→2027-01-01 | REST POST | succeeded |
| S3d Dca.interval=0 探测 | `sr_1789787981802_000007` | 518880 / D1 | 2025-06-01→2025-09-30 | REST POST | succeeded（见 §3 观察项 O2） |
| S4 M30 | `sr_1789787990568_000008` | 518880 / **M30** | 2025-01-01→2025-03-31 | REST POST | succeeded |
| S4 M1 | `sr_1789787992880_000009` | 518880 / **M1** | 2025-01-02→2025-01-10 | REST POST | succeeded |
| S6 正对照（部分部署） | `sr_1789738328788_000005` | 518880 / D1 | 2026-01-01→2026-09-18 | 既有历史 run | succeeded |

统一提交口径：`slots=[{version_id:"sv_1789211089727_000010", params:{cadence:20,plan_bars:5}, weight:1.0}]`、
`policy={"Dca":{"tranches":3,"interval":5,"mode":"Equal"}}`（S6 正对照为历史 `tranches:100,interval:1`）、
`initial_capital=100000`、`warmup_bars=250`（缺省）。

---

## S1 — Web 入口全链路（REST） → PASS 29/29

**提交体**：`raw/s1_00_submit_body.json` ｜ **提交响应**：`raw/s1_01_submit_resp.json`（HTTP 201）
｜ **状态迁移**：`raw/s1_02_status_timeline.txt` ｜ **终态**：`raw/s1_02_final_brief.json`
｜ **产物**：`raw/s1_04_{result,fills,bars_per_bar,curve}.json`、`raw/s1_07_audit.json`
｜ **对账脚本**：`raw/s1_reconcile.py` ｜ **对账输出**：`raw/s1_08_reconcile.txt`

### 1.1 状态迁移 / 进度 / 错误

- 提交响应：`status=queued`、`progress=0.0`、`error=null`、`created_at=2026-09-19T03:18:51.920230Z`。
- 首次轮询（+2.1s）：`status=succeeded`、`progress=1.0`、`error=null`、
  `started_at=2026-09-19T03:18:51.921605Z`、`finished_at=2026-09-19T03:18:51.942985Z`。
- 该 run 全生命周期 **21.0 ms**，`running` 中间态不可观测（`queued → succeeded` 是提交响应对终态的可见迁移，
  与 `raw/s1_02_status_timeline.txt` 的 `status=succeeded progress=1.0 error=None` 构成两端证据）。
- `raw/s1_02_list_head.json`：`GET /api/workbench/runs?limit=3` 列表已含该 run（含 `config` 快照钉住
  `sha256=5d7f83df…`、`strategy_id=st_1789211089727_000009`、`version=1`）。

### 1.2 result_format / per_bar 总数 / 分页语义（贴数字）

| 断言 | 实测 |
|---|---|
| `result_format` | `chunked_v1` |
| `per_bar` 总数（`/result` 首页） | **493** |
| 其中 `warmup=true` | **250** |
| 其中 in-range（`warmup!=true`） | **243** |
| warmup + in-range | 250 + 243 = **493** ✅（等于总数） |
| `estimated_bars`（brief / result.summary） | **243** = in-range ✅ |
| `has_more` | `false` |
| `next_offset` | `null` |
| `/bars?kind=per_bar&limit=20000` 长度 | 493（与 `/result` 首页逐根一致） |
| `/bars` `has_more` / `next_offset` | `false` / `null` |
| `/curve?kind=net_value` | `points=243`、`downsampled=false`、`original_bars=243`（k≤页不抽样） |

分页语义判据：493 < 单页上限（5000）⇒ `has_more=false` 且 `next_offset=null`，与 ADR-024 chunked 契约一致。

### 1.3 /audit 与 /fills 自洽（我方独立重算）

`raw/s1_07_audit.json`：

```json
{"run_id":"sr_1789787931919_000001","recorded":true,"capital_basis":100000.0,
 "deployed_notional":99975.00624843789,"deployed_pct":0.9997500624843789,
 "cash_consumed":100000.0,"cash_consumed_pct":1.0,
 "planned_tranches":3,"reachable_batches":52,"batches_done":3,"unexecuted_orders":49,
 "last_bar_unfilled":false,"round_trips_total":1,"round_trips_force_closed":1,
 "warnings":[{"code":"ORDERS_UNEXECUTED","severity":"info","message":"49 笔挂单未成交（末根 bar 无次 bar 可执行）"}]}
```

| 对账项 | 结果 | 数字 |
|---|---|---|
| `batches_done` == `/fills` 中 `side=Buy` 笔数 | ✅ | 3 == 3 |
| `deployed_notional` == Σ(Buy qty×price)（独立重算） | ✅ | audit `99975.006248438` vs 重算 `99975.006248438`，**abs Δ = 0.000e+00**，rel Δ = 0 |
| `round_trips_total` == `/result.trades` 长度 | ✅ | 1 == 1 |
| `round_trips_force_closed` == per_bar `events` 中 `ForceClose` 条数 | ✅ | 1 == 1 |
| `round_trips_force_closed` == `/fills` 中 `reason=ForceClose` 笔数 | ✅ | 1 == 1 |
| `fills.total` == `len(fills)` | ✅ | 4 == 4 |
| `unexecuted_orders == reachable_batches − batches_done` | ✅ | 52 − 3 = 49 |

`/fills` 明细（`raw/s1_04_fills.json`）：Buy 3 笔（bar 261/281/301，`reason=Policy`）+ Sell 1 笔
（bar 492，`price=9.2991398`，`reason=ForceClose`）。

### 1.4 新 run 的 trades 是否带 `reason`（写入路径生效）

`/result.trades[0]`（**13 字段**，比 ADR-026 之前的 12 字段多出 `reason`）：

```json
{"open_bar":261,"open_price":6.476862098054315,"open_ts":1737043200,
 "close_bar":492,"close_price":9.2991398,"close_ts":1767110400,
 "shares":15435.71636000571,"hold_bars":231,"gross_value":143538.88434484025,
 "commission":60.87847264831954,"stamp_duty":0.0,"pnl":43502.99962375403,
 "reason":"ForceClose"}
```

- ✅ `reason` 字段存在（写入路径生效）。
- ✅ 取值与成交事件一致：`reason="ForceClose"`；其 `close_bar=492`、`close_price=9.2991398`
  与 `/fills` 中唯一 Sell 成交（`bar_index=492`、`price=9.2991398`、`reason="ForceClose"`）**逐字段吻合**。

### 1.5 单条断言明细

完整 29 条断言见 `raw/s1_08_reconcile.txt`，**SUMMARY: 29 assertions, 0 failed**（脚本退出码 0）。

---

## S2 — MCP 入口平价（同一执行路径） → PASS 16/16

**MCP 客户端**：`raw/s2_mcp_client.py`（SSE `/sse` → `POST /messages?sessionId=…`）
｜ **提交参数**：`raw/s2_01_mcp_submit_args.json` ｜ **提交响应**：`raw/s2_02_mcp_submit_resp.json`
｜ **工具清单**：`raw/s2_00_mcp_tools_list.json`（35 个工具，含 `bt_get_run_audit`）
｜ **平价脚本/输出**：`raw/s2_parity.py` / `raw/s2_07_parity.txt`

### 2.1 MCP 提交（与 S1 同参数）

- `initialize` → `serverInfo={"name":"eestock-mcp","version":"0.1.0"}`；`notifications/initialized` → 202。
- `tools/call bt_run_ensemble`（同 `from/to/symbol/period/slots/policy`）→ **run_id = `sr_1789787945018_000002`**，
  无 `isError`。
- MCP 轮询 `bt_get_run`：`poll 0 status=queued progress=0.0` → `poll 1 status=succeeded progress=1.0 error=None`。
- ✅ **MCP 返回的 run_id 可被 REST 读出**：`GET /api/workbench/runs/sr_1789787945018_000002` → 200，
  `status=succeeded`（`raw/s2_04_rest_read_mcp_run.json`）。

### 2.2 artifact 形状平价（REST-S1 vs MCP-S2）

| 形状项 | 结果 |
|---|---|
| `/result` 顶层 key 集合 | ✅ 完全一致（`drawdown,has_more,metrics,net_value,next_offset,per_bar,result_format,summary,trades`） |
| `result_format` | ✅ 两边均 `chunked_v1` |
| `per_bar[0]` key 集合 | ✅ 一致（`aggregate,events,orders,scores,signal,ts,warmup`） |
| `per_bar` 长度 | ✅ 均为 493 |
| `trades[0]` key 集合 | ✅ 一致（13 字段含 `reason`） |
| `trades[0].reason` | ✅ 均为 `ForceClose` |
| `metrics` key 集合 | ✅ 一致（8 项） |
| `summary` key 集合 | ✅ 一致（20 项） |
| MCP run 的 `/audit` 字段集合 | ✅ 与 S1 一致（15 字段） |
| MCP run `batches_done` / `deployed_notional` | ✅ 3 / 99975.006248（与 S1 相同） |

### 2.3 `bt_get_run_audit` vs REST `/audit` 逐字段相同

- `bt_get_run_audit(run_id=sr_1789787931919_000001)` → `content[0].text` 为 JSON，`isError` 缺省（无错）。
- 字段集合与 REST `/audit` **完全相同**（15 字段）；**逐字段 diff = `{}`（零差异）**。
- 完整比较见 `raw/s2_07_parity.txt`：`PASS audit all fields equal (REST vs MCP): got={} exp={}`。

---

## S3 — 边界与护栏 → PASS

### 3a. 请求区间超出可得范围（不拒绝、clamp 回显）

提交体 `raw/s3_req_a_range.json`（D1，2020-01-01 → **2027-12-31**，远超可得范围）：

| 字段 | 值 |
|---|---|
| HTTP | **201**（不报错拒绝） |
| `clamped` | **true** |
| `clamp_reason` | `data_range` |
| `requested_from → requested_to` | `2020-01-01T00:00:00Z → 2027-12-31T00:00:00Z` |
| `from_ts → to_ts`（= `/result.summary.effective_from/to`） | `2020-01-01T16:00:00Z → 2026-09-17T16:00:01Z` |
| 真实可得范围（护栏 detail 回显） | `available_from=2013-07-29T01:30:00Z`，`available_to=2026-09-18T07:00:01Z` |

✅ effective 落在真实可得范围内（2020-01-01T16:00:00Z ≥ 2013-07-29T01:30:00Z；2026-09-17T16:00:01Z ≤ 2026-09-18T07:00:01Z）；
✅ `effective_to` 被收缩（请求 2027-12-31），非 200+静默截断。
证据：`raw/s3_resp_a_range.json`、`raw/s3_a_range_brief.json`、`raw/s3_a_range_result.json`（run `sr_1789787954285_000003`）。

### 3b. M1 跨度超护栏（结构化错误码 + confirm 二次确认流程）

提交体 M1 2015-01-01→2027-01-01，`confirm` 缺省（false）：

```
HTTP 400
{"error":{"code":"resource_guard",
  "detail":{"available_from":"2013-07-29T01:30:00+00:00","available_to":"2026-09-18T07:00:01+00:00",
            "confirm_bars":500000,"confirmable":true,"estimated_secs":429.83,"limit_bars":2000000,
            "period":"M1","requested_bars":686368,"symbol":"518880"},
  "message":"预估 686368 根 bar（≈429.8 秒）达到二次确认阈值 500000 根；如仍要提交，带 confirm=true 重提"}}
```

✅ 返回**结构化错误码** `resource_guard`（**HTTP 400**，非 500、非裸文本），带 `confirm_bars` / `limit_bars` /
`confirmable` / `requested_bars` 等机器可读字段。
✅ **存在 confirm 二次确认流程**：`"如仍要提交，带 confirm=true 重提"` —— 同参数 `confirm=true` → **HTTP 201** 放行
（run `sr_1789787967063_000004`）。
✅ 阈值以下（M1 2020→2027，`requested_bars=392589 < 500000`）`confirm=false` 亦 **201** 放行（run `sr_1789787971134_000005`），
说明阈值判定生效、非一刀切拒绝。
证据：`raw/s3_m1_{2015-01-01,2020-01-01}_confirm_{false,true}.json`。

> **宿主机保护动作（已记录，非缺陷）**：`confirm=true` 放行的 686368 根 M1 run（`sr_1789787967063_000004`）
> 预估耗时 ≈430 秒，为避免占用宿主机测试窗口，我方主动 `POST /cancel` → **HTTP 200 / `status=canceled`**
> （`raw/s3_m1_cancel_686k.json`）。该动作**不删除数据**，run 记录保留在库中。两条 39.3 万根 M1 run
> （`…000005` / `…000006`）未取消，均 **succeeded**。

### 3c. 未知 run —— 三处均非 200

对 `sr_0000000000_999999`：

| 端点 | HTTP | body |
|---|---|---|
| `GET /api/workbench/runs/{id}/result` | **404** | `{"error":"运行不存在: sr_0000000000_999999"}` |
| `GET /api/workbench/runs/{id}/fills` | **404** | `{"error":"运行不存在: sr_0000000000_999999"}` |
| `GET /api/workbench/runs/{id}/audit` | **404** | `{"error":"运行不存在: sr_0000000000_999999"}` |

✅ 三处**均为 404**，**均不是 200 + 空对象**；`recorded` 未伪造成 `true`，无空 audit 对象泄漏。
证据：`raw/s3_unknown_{result,fills,audit}.json`。

> **观察项 O1（一致性，非本次失败）**：该 404 家族的错误体为**字符串形** `{"error":"<message>"}`；
> 而本任务是提交侧 400 家族为对象形 `{"error":{"code","detail","message"}}`。ADR-026 契约原文为
> 「404 运行不存在或无结果（**复用既有错误码体系**）」，即沿用既有行为。**是否要求 404 也对象化**属设计口径问题，
> 非本阶段实测不符。

### 3d. 非法参数（结构化错误码）

| 用例 | HTTP | 错误体 |
|---|---|---|
| 不存在的 `strategy_id=st_0000000000000_999999` | **404** | `{"error":"策略版本不存在: st_0000000000000_999999"}` |
| 不存在的 `version_id=sv_0000000000000_999999` | **404** | `{"error":"策略版本不存在: sv_0000000000000_999999"}` |
| 非法 policy `Dca{tranches:0}` | **400** | `{"error":{"code":"policy_invalid","detail":{"period":"D1"},"message":"Dca.tranches 必须 ≥ 1"}}` |
| 非法 policy `LumpSum{position_pct:2.0}` | **400** | `{"error":{"code":"policy_invalid","detail":{"period":"D1"},"message":"LumpSum.position_pct 必须在 (0,1]，got 2"}}` |

✅ 非法参数**均被拒**（404/400），**非 500、非裸文本**；policy 家族带机器可读 `code=policy_invalid`。
✅ 无副作用：被拒的 4 个用例均未产生 run（响应体为错误体，无 `id` 字段）。
证据：`raw/s3_resp_{d,e,f,h}_*.json`。

> **观察项 O2（未覆盖边界）**：`Dca.interval=0` 的探测请求**被接受（HTTP 201）**并成功执行
> （run `sr_1789787981802_000007`，`status=succeeded`，见 `raw/s3_resp_g_dca_interval0.json`）。
> 本任务书点名的非法样例是 `Dca{tranches:0}`（已正确拒绝），`interval=0` 是否属合法语义（例如「每根 bar」）
> 需设计侧确认；本报告仅记录事实，不作推定。**该 run 已保留**。

---

## S4 — 周期覆盖（ADR-023/024 P0）→ PASS

| 周期 | run_id | 区间 | 提交 | 终态 | `estimated_bars` | `/audit` | warnings |
|---|---|---|---|---|---|---|---|
| **M30** | `sr_1789787990568_000008` | 2025-01-01→2025-03-31 | 201 | **succeeded** / progress 1.0 / error null | 560 | **200**，`recorded=true`，`deployed_pct=0.9998`，`batches_done=3`，`round_trips_total=1` | `[ORDERS_UNEXECUTED]` |
| **M1** | `sr_1789787992880_000009` | 2025-01-02→2025-01-10 | 201 | **succeeded** / progress 1.0 / error null | 1446 | **200**，`recorded=true`，`deployed_pct=0.9998`，`batches_done=3`，`round_trips_total=1` | `[ORDERS_UNEXECUTED]` |

✅ 两周期均**可提交且 succeeded**，`/audit` **正常返回**（200 + 非空审计 + 与首两周期语义一致的 warning 结构）。
证据：`raw/s4_{M30,M1}_{submit_body,submit_resp,final_brief,audit}.json`。
补充：另有两条 39.3 万根 M1 大跨度 run（`…000005`/`…000006`，2020→2026）亦 **succeeded**，佐证 M1 长区间可用性。

---

## S5 — 可观测性（Trace ID 贯通） → PASS

日志文件（进程 818710 的 stdout/stderr，经 `/proc/818710/fd/1` 确认）：
`logs/app_dev_8081_redeploy_20260919_111711.log` ｜ 抽取结果：`raw/s5_log_lines.txt`

### 5.1 S1 run（`sr_1789787931919_000001`）的关键行

该 run 的 p4b 生命周期，**同一次 run 内 `trace_id` 完全相同 = `5112f3d7eee0a03163c4a95acbc6e6ad`**：

| 行 | message | 关键字段 |
|---|---|---|
| 22 | `p4b.submit` | `trace_id=5112f3d7…`、`run_id=sr_1789787931919_000001`、`symbol=518880`、`period=D1`、`bars_total=493`、`warmup_effective=250`、`submit_fetch_ms=6.676` |
| 23 | `p4b.segment` | `segment=mark_started`、`elapsed_us=1018`（span `workbench_run` 携带 `trace_id`+`run_id`+`bars_total`） |
| 24 | `p4b.segment` | `segment=engine`、`elapsed_us=10257` |
| 25 | `p4b.segment` | `segment=progress_drain`、`progress_db_writes=2`、`progress_db_throttled=491`、`chunk_writes=4` |
| 26 | `p4b.segment` | `segment=progress_drain_tail`、`progress_drain_total_ms=20.135` |
| 27 | `p4b.segment` | `segment=result_serialize` |
| 28 | `p4b.segment` | `segment=result_write`、`elapsed_us=1547` |
| 29 | `p4b.run_summary` | `trace_id=5112f3d7…`、`outcome=succeeded`、`bars_total=493`、`engine_ms=10.257`、`engine_share_pct=44.53`、`global_runs_total=2` |

### 5.2 `/audit` 请求产生的 `workbench_run_audit` span 行（trace_id 存在）

```
{"timestamp":"2026-09-19T03:18:56.351583Z","level":"INFO",
 "fields":{"message":"workbench_run_audit","trace_id":"ea4d4d61f460277a14664f0ba933bb69",
   "run_id":"sr_1789787931919_000001","deployed_pct":0.9997500624843789,"cash_consumed_pct":1.0,
   "recorded":true,"unexecuted_orders":49,"warnings":1,"elapsed_us":5423},
 "target":"web::workbench",
 "span":{"deployed_pct":0.9997500624843789,"run_id":"sr_1789787931919_000001",
   "trace_id":"ea4d4d61f460277a14664f0ba933bb69","unexecuted_orders":49,"warnings":1,
   "name":"workbench_run_audit"}}
```

✅ `workbench_run_audit` span 行**存在且带 `trace_id=ea4d4d61…`**；span 与 fields 同时携带 `run_id`、
`deployed_pct`、`unexecuted_orders`、`warnings` 计数（与 `/audit` 响应体数值一致：409… 见 §1.3，`unexecuted_orders=49`、`warnings=1`）。

### 5.3 Trace ID 贯通口径（事实陈述）

- **run 内部贯通**：单条 run 的 `p4b.submit` → 8 条 `p4b.segment` → `p4b.run_summary` 共享 **同一 `trace_id`**
  （S1 = `5112f3d7eee0a03163c4a95acbc6e6ad`；M1-S4 = `0b466a6a742bd6d1fdfe007fada73a94`），
  span 层级为 `workbench_run`（父）→ `p4b.segment`（子，带 `segment` 名）。
- **跨请求关联**：`/audit` 是独立 HTTP 请求，拥有**独立 `trace_id`**（S1 = `ea4d4d61…`），
  与 run 的 trace 经 **`run_id`** 关联（两侧日志均带 `run_id`）。审计 span 名称 `workbench_run_audit`（target `web::workbench`）。
- 结论：Trace ID 在同一执行链内贯通；`/audit` 与 run 之间通过 `run_id` 可双向定位（同一 run 的 6 条 audit 行均可用
  `run_id` 命中，见 `raw/s5_log_lines.txt` 的 `workbench_run_audit` 区块，覆盖 `sr_…000005/000000/000001/000002/000008/000009`）。

---

## S6 — 负面对照（禁假绿） → PASS 9/9

脚本：`raw/s6_negative_control.py` ｜ 输出：`raw/s6_negative_control.txt`

### 6.1 断言可红（变异测试：证明断言非空转）

| 检查 | 期望 | 实测 |
|---|---|---|
| A **变异**：把期望值改成 `Σ(Buy qty×price) + 1.0`（错值） | 断言应 **RED** | `got_match=False` ⇒ **断言确实变红** ✅（真实值 `99975.006248` vs 错值 `99976.006248`，Δ=1.000） |
| B **真值**：`deployed_notional == Σ(Buy qty×price)` | 断言应 **GREEN** | `delta=0.000e+00` ⇒ **绿** ✅ |

⇒ 同一断言机具在「错 1 元」时必红、在真值时必绿，**S1 的 29 条绿不是假绿**。

### 6.2 `PARTIAL_DEPLOYMENT` 不误报（满仓 run 必不报 + 部分部署 run 必报）

| 检查 | run | 实测 |
|---|---|---|
| C1 `deployed_pct >= 0.99` | S1 满仓 `sr_1789787931919_000001` | `0.999750` ✅ |
| C2 **无** `PARTIAL_DEPLOYMENT` | S1 满仓 | `codes=['ORDERS_UNEXECUTED']` ✅ **不误报** |
| C3 `deployed_pct < 0.99` | 正对照 `sr_1789738328788_000005` | `0.413980` ✅ |
| C4 **有** `PARTIAL_DEPLOYMENT` | 正对照 | `codes=['DCA_PLAN_UNDERFILLED','PARTIAL_DEPLOYMENT','ORDERS_UNEXECUTED']` ✅ |
| C5 判据在同一字段上可判别（非常量） | — | `True`（两 run 结论相反） ✅ |
| D1 `batches_done == planned_tranches` ⇒ **无** `DCA_PLAN_UNDERFILLED` | S1（3 == 3） | ✅ |
| D2 `batches_done < planned_tranches` ⇒ **有** `DCA_PLAN_UNDERFILLED` | 正对照（42 < 100） | ✅ |

⇒ warning 体系对**满仓 vs 部分部署**、**满批 vs 欠批**均能正确判别，**无假绿、无假红**。

---

## 观察项 / 残留风险（非失败，供 Architecture Lead 裁决）

| 编号 | 观察 | 位置 | 证据 |
|---|---|---|---|
| O1 | 未知 run / unknown strategy 的 **404 错误体为字符串形** `{"error":"…"}`，而 400 家族为对象形 `{"error":{"code","detail","message"}}`；ADR-026 契约写「复用既有错误码体系」，即沿用既有行为。是否要求统一为对象形（带 `code`）需设计侧确认。 | `GET /runs/{id}/{result,fills,audit}` | `raw/s3_unknown_*.json` |
| O2 | `Dca.interval=0` **被接受（201）并 succeeded**；`Dca.tranches=0` 已正确拒绝（400 `policy_invalid`）。`interval=0` 是否属合法语义（如「每根 bar」）未在契约中明确。 | 提交侧 policy 校验 | `raw/s3_resp_g_dca_interval0.json`（run `sr_1789787981802_000007` 已保留） |
| O3 | 提交响应体**无 `effective_from`/`effective_to` 键**（仅 `from_ts`/`to_ts`），effective 区间须从 `/result.summary.effective_from/to` 读取。clamp 场景下 `from_ts/to_ts == effective`（已实测相等），属字段命名差异而非缺值。 | POST `/api/workbench/runs` | `raw/s3_resp_a_range.json` vs `raw/s3_a_range_result.json` |
| O4 | 686368 根 M1 run 预估 ≈430s（> 本任务 4 分钟命令上限），我方主动 cancel 以免占用测试窗口。大 run 的**完整成功路径**未在本次验证（仅验证 201 放行 + 结构化护栏 + 392589 根 M1 成功）。 | S3b | `raw/s3_m1_cancel_686k.json` |
| O5 | S1 run 生命周期仅 21 ms，`running` 中间态不可观测；状态迁移证据为「提交响应 `queued`/progress 0」+「终态 `succeeded`/progress 1」两端。 | — | `raw/s1_01_submit_resp.json`、`raw/s1_02_status_timeline.txt` |

## 复现方式

```bash
# S1: 见 raw/s1_reconcile.py（读 raw/*.json 本地对账，无网络依赖）
python3 tester/evidence/20260919_adr026_smoke_backtest/raw/s1_reconcile.py   # -> exit 0
# S2: 需要 8082 在线；客户端 raw/s2_mcp_client.py + runner raw/s2_runner.py
python3 tester/evidence/20260919_adr026_smoke_backtest/raw/s2_parity.py      # -> exit 0
# S6: 负面对照
python3 tester/evidence/20260919_adr026_smoke_backtest/raw/s6_negative_control.py  # -> exit 0
```

## 纪律与收尾核对

- ✅ 未执行 `git add / commit / checkout / stash / reset`（`git diff --cached --stat` 为空）
- ✅ 未修改业务代码（`git status --porcelain` 中 M 文件均为 ADR-026 交付既有改动，本阶段未触碰）
- ✅ 未新增/修改测试代码（本阶段为部署后冒烟验证，未写新测试，故无 `tester/design/` 设计报告）
- ✅ 未删除任何 run 用户数据；1 次 cancel 仅改状态不改数据完整性
- ✅ 未创建 ADR-025 临时库（本阶段未跑 cargo 测试），`pg_database` 无 adr025/test 残留
- ✅ 全程未对新 run 做任何破坏性操作；所有断言脚本可独立复跑
