# 010 · MCP 接口批 + 引擎口径批 —— 独立验收报告

> 本文件位置（self-reference）：`eestock-rs/tester/report/010_mcp_batch_acceptance.md`
> 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
> 仓库版本：工作区未提交改动，`git rev-parse HEAD` = `cedd40b`（index **无 staged**，`git diff --cached --name-only` 空）
> 验收时间：2026-09-12 18:34–18:44 CST（10:34–10:44 UTC）
> 角色：Tester（只验证不改实现；未 `git add`、未改任何实现文件）
> 设计报告：`tester/design/010_mcp_batch_acceptance_design.md`
> 原始证据目录：`tester/evidence/010_mcp_batch/`（含原始 stdout 与 JSON 落盘）

被验对象：`crates/mcp`（tools.rs = `design/07-app-plane/01-mcp.md` tangle 生成物）、`crates/backtest`(H1)、
`crates/strategy-core`(warmup)、`crates/application`(test_run/workbench)、`crates/web`(H1 白名单、
试算 DTO)、`design/07|08|12` 文档；报告 `coder/report/144_*.md`。

---

## 0. 结论汇总

| # | 验收项 | 结论 | 关键证据（本节均给原始输出） |
|---|---|---|---|
| 1 | D1 `list_symbols` | **PASS** | 无 required；44 条与 `order by code` 逐行一致；与 web `/api/symbols` 逐 code 字段 0 差异；注册表故障 isError |
| 2 | D2 `get_kline` | **部分 PASS**（1 个边界缺陷 F1） | 10000 根恰好通过 / 10001 根显式错误 / limit=10001→-32602 / 日界换算与端口复算一致；**同日 date 形式（from=to）与混合形式被误判 from≥to** |
| 3 | D5 `strategy_list` | **PASS** | 瘦身 13258 字符 vs 全量 **39097**（= 改前基准，delta 0），−66.1%；非法类型 -32602 |
| 4 | D9 `strategy_test_run` 注册校验 | **PASS** | 未注册 → isError 含 code+「未注册」；已注册正常；注册表故障 isError |
| 5 | I-6/H1 | **PASS** | 两工具 H1 正向；H1 6y 拒（上限 1830 天，与 D1 同）；web 白名单 H1 过、`1h` 拒；`get_kline 1h` 可用 |
| 6 | I-2 warmup | **PASS** | 探针 warmup 段信号恒 buy 但成交 0；默认 250；逐 bar 标记；shortfall 可见；净值/回撤仅 in-range |
| 7 | I-3 fee/policy/capital | **PASS** | 生效 fee 回显含 stamp_duty_pct；显式 0 → 印花税 0；capital ×2.0；policy ×0.5；两通道 trades 逐位一致 |
| 8 | 回归与工程 | **PASS**（另见 F2/F3） | 指定包全绿；强制重编 check 0 error/0 warning；tangle 幂等且 136 生成物逐字节相同；仅 engine.rs 有 warmup 包裹缩进；index 干净 |
| 9 | 生产未受影响 | **PASS**（附环境副作用披露 §9） | PID 3696673 启动早于本批 23h，未重启；:8081/healthz ok；:8082 tools/list 正常且仍为**改前**行为 |

**整体建议：可合并（merge）**，条件见 §8：F1（D2 同日/混合形式边界）建议随批修一行或显式接受为已知边界；
F2/F3/F4 非阻塞（测试/文档/既存工具门禁问题）。

---

## 1. D1 `list_symbols` — PASS

证据文件：`tester/evidence/010_mcp_batch/zz_tester_010_raw.txt`、`list_symbols_payload.json`、
`d1_source_compare_web_vs_tool.txt`、`prod_8081_api_symbols.json`

**1.1 schema 无必填参数**（`tools/list`，同 SSE 传输层同结论）

```
EV D1.schema {"additionalProperties":null,"name":"list_symbols","properties":{},"required":null,"required_present":false}
```

`SSE.tools_list` 证明该 schema 经真 HTTP/SSE 通道一致（n_tools=34，含 list_symbols/get_kline/strategy_test_run/bt_run_ensemble）。

**1.2 与 storage `order by code` 升序同序（独立核对 SQL 与返回顺序）**

storage SQL：`crates/storage/src/reader.rs:150-180` `SYMBOLS_LATEST_SQL` 末行 `ORDER BY s.code`（无 DESC）；
handler 另有 `syms.sort_by(code asc)`（`crates/mcp/src/tools.rs:703` 附近）——两处方向一致，实测：

```
EV D1.sql_order_head ["159337","159577","159638"]      EV D1.sql_order_tail ["562500","562800","588000"]
EV D1.tool_order_head ["159337","159577","159638"]     EV D1.tool_order_tail ["562500","562800","588000"]
EV D1.same_order_as_sql true   EV D1.ascending true   EV D1.count_eq_sql true   EV D1.tool_n 44
EV D1.field_mismatches []   （逐行比对 code/name/interval_secs/settlement/enabled，0 处不一致）
EV D1.sample_first {"code":"159337","enabled":true,"interval_secs":60,"latest":{"change_pct":0.0,"last":1.74,"ts":"2026-09-11T07:00:00Z"},"name":"中证500ETF基金","settlement":"T1"}
EV D1.unknown_args_ignored {"isError":false,"n":44}
```

**1.3 与 web `/api/symbols` 同源（对拍生产 :8081，只读）**

```
web n: 44 tool n: 44 code sets identical: True
name: mismatches=0 []
interval_secs: mismatches=0 []
settlement: mismatches=0 []
enabled: mismatches=0 []
latest: mismatches=0 []
web code order: ['518880','161226','513310','159776','159742','159337'] ... ['562500','562800','588000']
tool code order (ascending): ['159337','159577','159638','159740','159742','159776'] ... ['562500','562800','588000']
web favorites (front-loaded): ['518880','161226','513310','159776','159742']
非收藏段是否 code 升序: True
```

结论：同源（同一 `KlineRead::symbols_with_latest`）且**同字段同值**；顺序差异仅因 web 端「收藏优先置顶」
（`crates/web/src/rest.rs:92` 已注明），非收藏段仍为 code 升序 → MCP 的「按 code 升序」与 storage 端口序
（非 web 展示序）一致，符合 A1 冲突处置口径。

**1.4 注册表不可用 → fail-closed isError**

```
EV D1.registry_down {"isError":true,"text":"工具执行失败：标的注册表查询失败：injected registry outage (tester 010)"}
```

---

## 2. D2 `get_kline` — 部分 PASS（缺陷 F1）

**2.1 不传 from/to 时旧响应形状不变（向后兼容）**

```
EV D2.legacy_shape {"keys":["bars","code","period"],"n_bars":240,"bar_keys":["amount","close","high","low","open","source","ts","volume"]}
```

键集恰为 `{bars,code,period}`（无 from/to），默认 limit 240 生效。
旁证：生产旧二进制同参调用亦为同一形状（`prod_8082_old_behaviour.txt`，`get_kline 510300` → `{bars:[],code,period}`）。

**2.2 limit 超上限 → -32602 且含「10000」「分段」（不静默钳制）**

```
EV D2.limit_10001 {"code":-32602,"has_10000":true,"has_segment":true,
  "message":"limit 超上限 10000——请缩小 limit 或用 from/to 分段取数"}
```
（SSE 通道同帧：`SSE.get_kline_limit_over {"error":{"code":-32602,...}}`，证明协议层错误帧未走 isError。）

**2.3 边界：区间恰 10000 根（通过）/ 10001 根（显式错误，不静默截断）**

用同一 domain 端口 `KlineRead::bars` 取 20000 根样本构造精确区间（不依赖表结构假设）：

```
EV D2.exact_window {"n_probe":20000,"from":"2020-02-17T03:21:00Z","to":"2020-04-15T06:50:00Z","to2":"2020-04-15T06:51:00Z"}
EV D2.exactly_10000 {"isError":false,"n_bars":10000,"from":"2020-02-17T03:21:00Z","to":"2020-04-15T06:50:00Z"}
EV D2.over_limit_interval {"isError":true,"text":"工具执行失败：区间内根数 10001 超 limit 10000——请缩小 from/to 区间或分段取数"}
```

**2.4 date 形式 `to` 的日界换算（含整日）与独立性复算**

```
EV D2.date_bounds {from_echo:"2026-09-09T16:00:00Z", to_echo:"2026-09-11T16:00:00Z", n:12,
  ts_equal_port_expectation:true,
  expect_ts:[2026-09-10T01:00:00Z … 2026-09-11T07:00:00Z]（与工具输出逐根相同）}
EV D2.date_vs_rfc3339_equivalent {"equal":true,"from":"2026-09-09T16:00:00Z","to":"2026-09-11T16:00:00Z"}
EV D2.single_day_rfc3339 {"n":6,"ts":["2026-09-10T01:00:00Z"…"2026-09-10T07:00:00Z"]}
EV D2.rfc3339_bounds {"from":"2026-09-10T01:00:00Z","to":"2026-09-10T04:00:00Z","n":3,
  "ts":["…01:00:00Z","…02:00:00Z","…03:00:00Z"]}     # to 开：不含 04:00
```
即：`from="2026-09-10"` → UTC 前一日 16:00（CST 00:00，闭）；`to="2026-09-11"` → UTC 16:00
（CST 09-12 00:00，开，含 09-11 整日）；date 形式与显式 RFC3339 逐根等价。

**2.5 参数校验**

```
EV D2.validation.from_gt_to {"code":-32602,"message":"from 须早于 to"}
EV D2.validation.bad_from   {"code":-32602,"message":"from 须为 YYYY-MM-DD 或 RFC3339"}
EV D2.validation.from_number{"code":-32602,"message":"from 须为字符串（YYYY-MM-DD 或 RFC3339）"}
EV D2.validation.limit_string{"code":-32602,"message":"limit 须为整数"}
EV D2.1h_available {"n":3,"last":{…,"ts":"2026-09-11T07:00:00Z"}}
```

**2.6 缺陷 F1（部分 PASS 的唯一原因）：`from ≥ to` 判定先于 `to` 的日界展开**

`crates/mcp/src/tools.rs:620-626`（生成源 `design/07-app-plane/01-mcp.md:993-999`）先做
`if f >= t { -32602 "from 须早于 to" }`，其后才对 date 形式 `to` 加 1 天。因此：

```
EV D2.date_same_from_to   {"protocol_error":-32602,"message":"from 须早于 to"}       # from="2026-09-10", to="2026-09-10"
EV D2.date_mixed_forms    {"protocol_error":-32602,"message":"from 须早于 to"}       # from="2026-09-10T00:00:00Z", to="2026-09-10"
```

- 影响：`from`/`to` 同为同一 CST 日期（合法单日查询），或 `from` 用 RFC3339 且晚于该 CST 日界而 `to` 用
  date 形式时，被误判为非法区间，错误文案亦有误导性。
- 规避：调用方改传显式 RFC3339（实测可用，见 2.4 的 `single_day_rfc3339`）或把 `to` 写为次日日期。
- 建议：把 `f >= t` 校验移到 `to` 的 +1 日展开之后（或对 date 形式 `to` 展开后再比较）。
- 严重度：低（边界输入、有明确规避路径、无静默错误数据）；唯一可判定为「接口契约未完全兑现」的点。

---

## 3. D5 `strategy_list` — PASS

```
EV D5.sizes {"slim_chars":13258,"full_chars":39097,"slim_bytes":14000,"full_bytes":47752,
             "baseline_before_change":39097,"delta_vs_baseline":0,"ratio_full_over_slim":2.9489}
EV D5.slim_has_no_code true      EV D5.full_has_code true      EV D5.slim_keeps_identity true
EV D5.n_entries {"slim":11,"full":11}
EV D5.version_keys_slim ["approval_level","created_at","id","params_schema","published_at","sha256","status","strategy_id","version"]
EV D5.version_keys_full ["approval_level","code","created_at","id","params_schema","published_at","sha256","status","strategy_id","version"]
EV D5.invalid_type {"code":-32602,"message":"include_source 须为 boolean"}
```

- 默认体积 **13258 字符**（−66.1%），`include_source=true` 全量 **39097 字符**，与 coder 报告的改前基准
  **逐字符相等（delta=0）** → 说明基准可信、且瘦身**仅**移除 `version.code`，身份/版本/sha256/状态/
  params_schema 全保留（`D5.slim_keeps_identity true`）。
- 非法类型（字符串 "yes"）→ -32602。
- 旁证：`strategy_list_slim_reduces_payload_against_real_registry` 端到端测试绿（§8）。

---

## 4. D9 `strategy_test_run` 注册校验 — PASS

```
EV D9.unregistered {"isError":true,"mentions_code":true,"mentions_未注册":true,
  "text":"工具执行失败：标的 510300 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）"}
EV D9.registered_ok  {"isError":false,"ok":true}
EV D9.registry_down  {"isError":true,"text":"工具执行失败：标的注册表查询失败：injected registry outage (tester 010)"}
```
510300 确不在 44 条注册表内（`symbols` 表独立查询）；口径与 I-1 的 `get_kline` 完全一致（同 `ensure_registered`）。

---

## 5. I-6 / H1 — PASS

```
EV SCHEMA.strategy_test_run {"period_enum":["M1","M5","M15","H1","D1"],"properties":[…"warmup_bars"],"required":["symbol","period","from","to","mode"]}
EV SCHEMA.bt_run_ensemble  {"period_enum":["M1","M5","M15","H1","D1"],"required":["symbol","period","from","to","slots","policy"]}
EV I6.h1_test_run {"isError":false,"period":"H1","bar_count":952,"warmup_requested":250,"warmup_effective":250}
EV I6.h1_span_5y {"isError":false,"text":"accepted"}                 # 2019-01-01→2024-01-01（1826 天）
EV I6.h1_span_6y {"isError":true,"text":"…试算区间超限：H1 跨度 2192 天 > 上限 1830 天"}
EV I6.d1_span_6y {"isError":true,"text":"…试算区间超限：D1 跨度 2192 天 > 上限 1830 天"}
EV I6.w1_rejected {"code":-32602,"message":"period 须为 M1/M5/M15/H1/D1"}
```

- `bt_run_ensemble` 的 H1 正向在 §7 双通道对照中实测（`X.bt_submit` 提交 period=H1 → `X.bt_run_view` status=succeeded）。
- H1 与 D1 **同上限**（1830 天）→ 与架构师裁决「H1 归日线档」一致，无双口径。
- Web REST 白名单（`crates/web/src/workbench.rs:145`）实测（`zz_tester_010_web_raw.txt`）：

```
WEB_RUN period=M1  status=201 body={"id":"sr_…","period":"M1",…}
WEB_RUN period=H1  status=400 body={"error":"区间内无 K 线数据（888451 H1 …）"}     ← 已越过白名单，落到服务层
WEB_RUN period=W1  status=400 body={"error":"period 须为 M1/M5/M15/H1/D1"}          ← 白名单拒绝
WEB_RUN period=1h  status=400 body={"error":"period 须为 M1/M5/M15/H1/D1"}          ← 白名单拒绝（MCP 拼写 H1）
WEB_RUN period=D1  status=400 body={"error":"区间内无 K 线数据（888451 D1 …）"}
```
（合成 symbol 无 1h 数据故 400，但错误文案已不是白名单文案 → 证明 H1 已获白名单放行。）
- 数据层 `get_kline period=1h` 仍可用（§2.5 `D2.1h_available`，3 根、末根 `2026-09-11T07:00:00Z`）。

---

## 6. I-2 warmup（契约 A） — PASS

探针策略：`function on_bar(ctx) { return 100; }`（恒 buy 分），`period=H1`，区间 2024-01-02→2024-04-01，
`mode=sim_position`（默认 LumpSum 全仓）。

**6.1 warmup 段逐 bar 评分但零成交（探针取证）**

```
EV I2.warmup5 {"requested":5,"effective":5,"bar_count":353,"scores_len":353,"signals_len":353,
 "n_scores_warmup_true":5,"n_signals_warmup_true":5,"prefix_all_true":true,"suffix_all_false":true,
 "warmup_signals":["buy","buy","buy","buy","buy"],"warmup_scores":[100.0,100.0,100.0,100.0,100.0],
 "n_trades":1,"min_trade_open_bar":6,"trades_in_warmup":0,
 "first_trade":{"open_bar":6,"close_bar":352,"open_price":4.6499298,…}}
EV I2.warmup0 {"requested":0,"effective":0,"n_scores_warmup_true":0,"n_signals_warmup_true":0,
 "n_trades":1,"first_trade":{"open_bar":1,…}}          ← 旧行为（无预热）基线：首成交 open_bar=1
```
→ warmup 段内信号**确为 buy**（插件仍逐 bar 被调用、评分 100），但 `trades_in_warmup=0`，
首成交被推到 in-range 第 1 根（open_bar=6 对应 warmup=5；warmup=0 时 open_bar=1）。契约 A 成立。

**6.2 响应含 warmup_requested / warmup_effective / 逐 bar 标记；默认 250**

```
EV I2.default_warmup {"requested":250,"effective":250,"bar_count":598}
EV I2.default_250_marks {"requested":250,"effective":250,"n_true":250,"scores_len":598,"min_trade_open_bar":251}
```

**6.3 历史不足时 warmup_effective < requested 可见（silent shortfall 消除）**

```
EV I2.shortfall {"data_start_h1":"2013-07-29T01:00:00Z","from":"2013-07-29T02:00:00Z",
                 "requested":250,"effective":1,"bar_count":90,"n_true":1}
```

**6.4 净值/回撤/绩效不计 warmup（bt 通道逐 bar 证据）**

```
EV X.bt_result {"n_per_bar":598,"n_per_bar_warmup_true":250,"net_value_len":348,"drawdown_len":348,
 "net_value_equals_inrange":true,"bar_count_test_run":598,"warmup_effective_test_run":250,
 "n_trades":14,"metrics":{"annualized_return":0.2077,"max_drawdown":0.02119,"sharpe":2.92,"trade_count":14,…},
 "first_bt_trade":{"open_bar":255,…}, "trades_equal_to_test_run":true}
EV X.per_bar_first3 […"warmup":true…]                    # per_bar 全量含 warmup 并逐根标记
EV X.per_bar_warmup_boundary [{"ts":…,"warmup":true},{"ts":1704157200,"warmup":false}]   # 第 250→251 根边界正确
```

**6.5 观察（非缺陷）**：引擎把「执行上一 bar 挂单」与「Policy」两处显式 `!is_warmup` 门控，
但 Intrabar/CloseBasis 止损两处**未**显式门控——warmup 段恒无持仓（pending 仅在 Policy 处设置，
故 holding 保持 None）使其不可触发。行为安全，惟不变量是**推导**而非局部显式；若未来新增 warmup 段
持仓来源，需同步加门控。

---

## 7. I-3 fee / policy / capital — PASS（含两通道对拍）

**7.1 fee 生效并回显生效值（含 stamp_duty_pct）**

```
EV I3.fee_default_echo {"fee":{"min_fee":5.0,"rate_pct":0.025,"slippage_bp":2.0,"stamp_duty_pct":0.05},
  "n_trades":1,"stamp_duty_sum":55.0943,"commission_sum":52.5409,"pnl_sum":10105.99,"shares_first":21500.33}
EV I3.fee_etf_echo {"fee":{…"stamp_duty_pct":0.0},"stamp_duty_sum":0.0,"commission_sum":52.5409,
  "pnl_sum":10161.08,"commission_same_as_default":true,"pnl_differs":true}
```
缺省 `stamp_duty_pct=0.05`（股票口径兼容值）**在结果里可见**；ETF 显式传 0 → 回声 0 且印花税合计 0，
佣金逐位不变、pnl 差 +55.09 = 印花税 → 参数确被应用且可自证。

**7.2 capital / policy 生效**

```
EV I3.capital_effect {"shares_first_100k":21500.325929,"shares_first_200k":43000.651858,"ratio":2.0}
EV I3.policy_lumpsum_half {"n_trades":1,"shares_first":10757.314974,"vs_full_shares":21500.325929}   # ×0.5
EV I3.policy_dca {"isError":false,"n_trades":1}
```

**7.3 与 `bt_run_ensemble` 口径一致（同版本/同区间/同参数，两通道对拍）**

```
EV X.test_run {"bar_count":598,"fee":{…"stamp_duty_pct":0.0},"n_trades":14,"warmup_requested":250,"warmup_effective":250}
EV X.bt_submit {"run_id":"sr_…","status":"queued","config":{…,"fee":{…"stamp_duty_pct":0.0},
                "warmup_requested":250,"warmup_effective":250,"slots":[{…"params":{"fast":5.0,"slow":20.0},…}]}}
EV X.bt_run_view {"status":"succeeded","config":{…同上钉住生效 fee + warmup_requested/effective…}}
EV X.bt_result {"trades_equal_to_test_run":true, "first_bt_trade":{"open_bar":255,"close_bar":265,"shares":21426.584,…},
                "first_tr_trade":{…与 bt 逐字段相同…}}
EV X.dca_two_channel {"bt_status":"succeeded","tr_n_trades":14,"bt_n_trades":14,"trades_equal":true,
                      "metrics":{…"net_profit":2245.01,"sharpe":2.934…}}          # Dca 与 LumpSum 指标不同（net_profit 6733→2245）
```
→ LumpSum 与 Dca 两种 policy 下，`strategy_test_run` 与 `bt_run_ensemble→bt_get_run_result` 的
`trades` **逐位相等**（float 同源同序，无容差），`config` 钉住 warmup_requested/effective 与**生效** fee。

**7.4 非法入参分类**

```
EV I3.validation.fee_empty_object       {"isError":true,"text":"工具执行失败：fee.rate_pct 缺失或非数值"}
EV I3.validation.fee_missing_rate       {"isError":true,"text":"…fee.rate_pct 缺失或非数值"}
EV I3.validation.fee_stamp_out_of_range {"isError":true,"text":"…fee.stamp_duty_pct 须 ∈ [0,1]（百分比）"}
EV I3.validation.policy_bad             {"isError":true,"text":"…policy 非法: unknown variant `Nope`, expected `LumpSum` or `Dca`"}
EV I3.validation.capital_zero           {"protocol_error":-32602,"message":"capital 须为正有限数值"}
EV I3.validation.capital_negative       {"protocol_error":-32602,"message":"capital 须为正有限数值"}
EV I3.validation.warmup_negative        {"protocol_error":-32602,"message":"warmup_bars 须为非负整数"}
EV I3.validation.warmup_float           {"protocol_error":-32602,"message":"warmup_bars 须为非负整数"}
```
分类与设计一致：**形状/类型错 → -32602（协议层）**；**语义/值域错 → isError（工具层）**。

**7.5 观察（非缺陷）**：试算响应只回显 `fee`，**不回显** `policy`/`initial_capital`（两通道同结构，
`capital` 经 shares 缩放可自证）。ADR 只硬要求 fee 回显，故不判 FAIL；若希望「调用方可自证口径」，
可后续把 policy/capital 一并回显。

---

## 8. 回归与工程 — PASS（另附 F2/F3 发现）

**8.1 指定包测试全绿**（原始输出 `cargo_test_required.txt`；夹具已临时移出工作区以保证为「批次自带」口径）

```
===== cargo test -p mcp =====            lib 61 / mcp_protocol 2 / mcp_tools_db(真实TimescaleDB) 8 / zz_tester_i1 1，EXIT=0
===== cargo test -p backtest =====       21 passed，EXIT=0
===== cargo test -p strategy-core =====  32 + 25(1 ignored) + 6 + 3，EXIT=0
===== cargo test -p application =====    11 + 55(simlive) + 38(strategy) + 16(workbench)，EXIT=0
===== cargo test -p web --lib =====      43 passed，EXIT=0
===== 追加 cargo test -p web --test api_workbench --test api_strategies =====  9 + 6 passed，EXIT=0
```
- 全批 **0 failed / 0 crash / 无 core dump**（无 panic 输出、无核心文件）。
- 唯一 ignored：`strategy-core/tests/engine.rs:734` 性能冒烟 `#[ignore]`，**HEAD 已存在**（HEAD 与本工作区
  `#[ignore]` 计数均为 3，非本批引入）。
- 批次新增/改动的用例本次均实测通过，抽样：`warmup_prefix_scores_but_never_executes_or_counts_metrics`、
  `warmup_zero_is_legacy_behaviour`、`test_run_warmup_prefix_marked`、`test_run_warmup_reports_shortfall`、
  `test_run_fee_echo_and_stamp_duty_effect`、`test_run_policy_and_capital_effect`、`test_run_h1_period_supported`、
  `submit_accepts_h1_and_rejects_unknown_period`、`submit_warmup_marks_prefix_and_pins_effective_fee`、
  `list_symbols_matches_real_symbols_registry`、`get_kline_from_to_and_limit_cap_against_real_data`、
  `strategy_list_slim_reduces_payload_against_real_registry`、`strategy_test_run_unregistered_symbol_against_real_registry`。

**8.2 `cargo check --workspace --all-targets` 0 error / 0 warning（强制重编，非缓存假绿）**

先 `cargo clean -p mcp -p web -p application -p backtest -p strategy-core -p app`（删构建产物，不动源码），
再 check；输出逐个 crate 重编后 0 error/0 warning（`cargo_check_workspace_forced.txt`）：

```
### start 2026-09-12T10:40:57Z
    Checking backtest / alert / storage / strategy-runtime / strategy-core / simlive / application / web / mcp / app
    Finished `dev` profile … in 2.64s        EXIT=0
（唯一 warning 来自 tester 自己的临时夹具文件，已删除该 import 后复跑无 warning）
```

**8.3 entangled tangle 幂等（对拍法，未改动工作区）**

在 `/tmp/tangle010`（仅 `design/` + `entangled.toml` 的独立副本，entangled 2.4.3）执行 tangle，
与工作区逐文件比对（`tangle_compare.txt`）：

```
136 个生成物 SAME（含 migrations/*.sql、crates/**/**.rs、web/src/**）
crates/mcp/src/tools.rs: sha256 b97be9ea1f0e2f057c953cc0841216c7226a7a4258e947eceb96e2da44dfad40（两侧相同，cmp IDENTICAL）
DIFF web/src/layouts/DashboardGrid.tsx  /  DIFF web/src/layouts/SimLiveGrid.tsx  /  DIFF .entangled/filedb.json（工具缓存，无关）
```
→ 本批目标生成物**幂等且与事实源一致**。显式「再 tangle 无 diff」证据（`tangle_idempotent.txt`）：
把上一轮产物整体复制后**再跑一次** tangle（run3），`diff -r --brief` **0 处差异**；三方 sha256 相同：

```
b97be9ea…dfad40  /tmp/tangle010_r3/crates/mcp/src/tools.rs    （再 tangle 产物）
b97be9ea…dfad40  /tmp/tangle010_snap/crates/mcp/src/tools.rs  （上一轮产物）
b97be9ea…dfad40  <repo>/crates/mcp/src/tools.rs               （工作区生成物）
```

> 说明：幂等对拍刻意在 `/tmp` 独立副本中进行（仅 `design/` + `entangled.toml`），**未**在工作区原地
> 跑 tangle，以免覆盖本批未提交的 design/生成物。

**F3（既存问题，非本批引入）**：两处 TSX 与 tangle 结果不一致（`tangle_head_drift.txt`）：

```
web/src/layouts/DashboardGrid.tsx   HEAD_design_tangle vs HEAD_git: DIFF
web/src/layouts/SimLiveGrid.tsx     HEAD_design_tangle vs HEAD_git: DIFF
crates/mcp/src/tools.rs             HEAD_design_tangle vs HEAD_git: SAME
```
即用 **HEAD 的 design/** 去 tangle 也与 HEAD 已提交 TSX 不一致 → 与本次改动无关，属仓库既存漂移；
后果是 `./scripts/check-tangle.sh` 在**干净 HEAD** 上也会红（其判据是 tangle 后 `git diff --quiet`）。
（本批工作区本身 dirty，`check-tangle.sh` 报 diff 属预期，coder 已声明。）

**8.4 无无关格式化 churn（忽略空白对拍，独立核验）**

```
git diff --stat            → 22 files changed, 2092 insertions(+), 184 deletions(-)
git diff -w --stat         → 22 files changed, 2024 insertions(+), 116 deletions(-)
diff <(git diff --numstat) <(git diff -w --numstat)   → 唯一差异文件：crates/strategy-core/src/engine.rs
crates/strategy-core/src/engine.rs   完整 88+/69− ；  -w 视角 20+/1−
逐文件「去行首空白后再 diff」的实质行数 == -w numstat（其余 21 个文件完全相等）
git diff --check → 无空白错误(rc=0)
```
engine.rs 的 136 行空白差异**全部**是 warmup 门控块的包裹缩进（`if !is_warmup { … }`）；实质变更仅 21 行，
逐行均为 I-2 相关（新增 `warmup_bars`/`warmup` 字段、`let is_warmup = i < warmup;`、step1/step7/nav 门控）：

```
@@ -131,0 +132,5 @@   pub warmup_bars: usize,        @@ -218,0 +224,3 @@   pub warmup: bool,
@@ -336,0 +345,2 @@ let warmup = cfg.warmup_bars.min(n);   @@ -348,0 +359 @@ let is_warmup = i < warmup;
@@ -353,17 +364,31 @@ / @@ -371,24 +396,13 @@ / @@ -399,23 +413,23 @@  ← step1 挂单执行包裹 if !is_warmup
@@ -555 +569,2 @@ if !stop_order && !is_warmup      @@ -585,0 +601 / @@ -589,4 +605,6 @@ if !is_warmup { nav.push… }
@@ -594,0 +613 @@   warmup: is_warmup,
```
→ 结论：**无无关格式化 churn**；唯一空白 churn 是本批语义所需的缩进重排。

**8.5 index 干净**

```
$ git diff --cached --name-only        → （空）
$ git status --porcelain=v1 | grep -c '^??'  → 17（均为既存/本批未跟踪产物：coder 报告、tester 夹具与证据、.claude/ 等）
```
未执行任何 `git add`/`git commit`。

**F2（测试卫生，低）**：`crates/web/tests/api_workbench.rs:286` 仍以 `b["period"] = json!("H1")` 作为
「period 非法 → 400」样例。H1 现已合法 → 该断言不再测「period 校验」，只是因合成 symbol 无 1h 数据
（`区间内无 K 线数据`）而**恰好仍为 400**（该文件 6/6 实测通过，`cargo_test_web_integration_workbench.txt`）。
建议改为 `"W1"`/`"1h"` 以免门禁形同虚设。（MCP 侧同类样例已改为 W1，web 侧漏改。）

**F4（文档陈旧，低）**：`crates/application/src/strategy.rs:41` 注释仍为
「复用回测服务的周期解析口径（M1/M5/M15/D1；H1 拒绝）」——H1 已支持，注释与实际不符（无行为影响）。

---

## 9. 生产未受影响 — PASS（附环境副作用披露）

**9.1 未被重启**

```
$ ps -o pid,lstart,etime,cmd -p 3696673
    PID                  STARTED     ELAPSED CMD
3696673 Fri Sep 11 11:24:16 2026  1-07:17:45 target/debug/eestock-app --config /tmp/app_dev_8081.toml
本批 22 个改动文件最早 mtime：2026-09-12T10:17:01Z (= 18:17 CST)，最新 2026-09-12 18:32:27 CST
```
启动时刻早于本批任何改动 **≈23 小时**，运行时长连续增长（1d07h），**未重启**。

**9.2 :8081/healthz 与 :8082 tools/list 正常**

```
$ curl http://127.0.0.1:8081/healthz        → {"status":"ok"}  HTTP=200
$ probe_mcp_sse.py http://127.0.0.1:8082 tools/list
  # SSE status=200 content-type=text/event-stream
  # endpoint=/messages?sessionId=520997be90dac7dec5ca88544309ac11
  # POST /messages status=202
  RAW={"id":1,"jsonrpc":"2.0","result":{"tools":[ … 33 个工具 … ]}}
```

**9.3 生产仍是改前行为（旁证「本批未部署」）**

```
PROD tools n= 33            PROD has list_symbols: False        （新构建为 34 且含 list_symbols）
PROD get_kline desc: 查询标的 K 线（…）bars 升序返回。            （无注册校验/from-to/10000 文案）
PROD get_kline limit desc: {'description': '根数，默认 240，上限 1000'}
PROD strategy_test_run period_enum: ['M1','M5','M15','D1']       （无 H1）
PROD bt_run_ensemble  period_enum: ['M1','M5','M15','D1']
PROD tools/call get_kline{code:"510300"} → {"bars":[],"code":"510300","period":"1m"}   ← I-1 未修（静默空）
PROD tools/call list_symbols → {"error":{"code":-32602,"message":"未知工具：list_symbols"}}
```

**9.4 环境副作用（如实披露，均已处置）**

1. 我为强制重编执行了 `cargo clean -p mcp -p web -p application -p backtest -p strategy-core -p app`，
   其中 `-p app` 连带删除了 `target/debug/eestock-app`——**恰是生产进程当前在磁盘上的可执行文件路径**
   （`/proc/3696673/exe -> …/target/debug/eestock-app (deleted)`）。生产进程持有已打开 inode，**运行不受影响**
   （清理后 healthz 仍 200、PID/启动时间不变）；已用 `cargo build -p app` 重建该路径（新构建，Sep 12 18:41）以免
   「生产重启时无二进制」。**若生产在本次重建后重启，将运行新版代码**——部署时机请由架构师掌握。
   （另：`cargo clean` 只删构建产物，未触碰任何源文件；`target/` 属构建缓存。）
2. 复跑（夹具与生产探针）均**只读**为主；为 I-2/I-3 双通道取证向共用 dev DB 写入了 2 条运行
   （`tester-010-h1-warmup`、`tester-010-h1-dca`），**已删除**（含 `strategy_run_result`），残留 0；
   web 夹具自建合成 symbol/策略 也已清理（`db_cleanup.txt`、`WEB_CLEANUP leftover_strategies=0`）。
3. 工作区新增了 **tester 夹具 2 个文件**（`crates/mcp/tests/zz_tester_010_acceptance.rs`、
   `crates/web/tests/zz_tester_010_web.rs`，untracked）。建议：提交前删除，或由架构师决定保留为长期验收夹具。

---

## 10. 发现清单（Findings）

| ID | 严重度 | 位置 | 说明 | 建议 |
|---|---|---|---|---|
| F1 | 低（接口边界） | `crates/mcp/src/tools.rs:620-626` / `design/07-app-plane/01-mcp.md:993-999` | `from >= to` 判定先于 date 形式 `to` 的 +1 日展开 → 同日 date 形式与「RFC3339 from + date to」被误判 -32602 `from 须早于 to` | 把 f>=t 校验移到 to 展开之后；或对 date 形式 to 先展开再比 |
| F2 | 低（测试卫生） | `crates/web/tests/api_workbench.rs:286` | 仍以 `H1` 作「非法 period」样例；H1 已合法 → 该断言不再覆盖 period 校验（因合成 symbol 无 1h 数据仍为 400） | 改为 `"W1"` 或 `"1h"` |
| F3 | 中（既存工具门禁） | `web/src/layouts/{DashboardGrid,SimLiveGrid}.tsx` | HEAD 的 design 与 HEAD 的 TSX 就不一致（与 `design/07-app-plane/00-web-api.md` 等非本批文档漂移）→ `check-tangle.sh` 在干净 HEAD 上亦红 | 单独一事：回归 design 源或接受手写例外并调整门禁 |
| F4 | 低（注释陈旧） | `crates/application/src/strategy.rs:41` | 注释仍写「H1 拒绝」 | 更新注释 |
| O1 | 观察 | `crates/strategy-core/src/engine.rs` step2/step6 | 止损两处未显式 `!is_warmup` 门控（靠 warmup 段无持仓的不变量保证） | 可选：显式门控使不变量局部化 |
| O2 | 观察 | `TestRunResponse` | 试算响应不回显 policy/initial_capital（仅 fee） | 可选增强（ADR 只硬要求 fee） |

---

## 11. 未覆盖项（显式声明）

1. **前端 UI**：`web/src/features/*` 的 period 选项、fee/policy/capital/warmup 表单未加（coder 已声明本轮范围
   限定引擎与接口）——未验证、亦不属本批范围。
2. **D11 标的类型推断印花税**：symbols 表无 `type` 列，印花税仍由调用方显式传值承担——未验证（另立任务）。
3. **生产重新部署**：未做（本批仍在工作区）；生产仍跑改前二进制。
4. **`get_kline` 的 cagg 实时右缘/forming 桶与 from-to 组合**：未构造 covering 边界（`to` 给定时不合并 forming 桶，
   已由代码读证，未实测）。
5. **`bt_run_ensemble` 的 M1/M5/M15/D1 各周期**回归：只实测 H1（本批新增）+ 既有测试套绿；未逐周期端到端对拍。
6. **warmup 与 stop（止损）交互**：未构造 warmup 段外触发止损的 H1 用例（既有单测覆盖策略核引擎层面）。
7. **多 strategy_run 并发/取消**（`Semaphore`/cancel）未在本批重新验证（既有测试绿）。

---

## 12. 整体合并建议

**建议合并（可 merge）**，理由：
- 9 项验收中 8 项 **PASS**，1 项（D2）**部分 PASS**，唯一缺陷 F1 为**输入边界**且**有明确规避**、无静默
  错误数据；`cargo test`（含真实 DB 集成与端到端）全绿、`cargo check --workspace --all-targets` 强制重编
  0 error/0 warning、tangle 目标生成物幂等且与事实源逐字节一致、index 无 staged、生产未被打扰。
- 合入前建议（择一即可）：(a) 顺手修 F1（改 1 行 + 设计文档 1 处）；或 (b) 显式接受为已知边界并在
  `design/07-app-plane/01-mcp.md` 记明「date 形式 to 不支持与 from 同日；请用显式 RFC3339」。
- 非阻塞但建议同批处理：F2（web 测试样例改为 W1）、F4（注释）。F3 建议单独立项（既存、跨批、涉及前端文档源）。

---

## 13. 证据文件索引（全部位于 `tester/evidence/010_mcp_batch/`）

| 文件 | 内容 |
|---|---|
| `zz_tester_010_raw.txt` | 主夹具完整原始 stdout（D1/D2/D5/D9/I-6/I-2/I-3/双通道/SSE/schema） |
| `zz_tester_010_web_raw.txt` | Web 通道夹具原始 stdout（H1 白名单 + 试算 DTO） |
| `cargo_test_required.txt` / `cargo_test_all.txt` | 指定包测试全量输出（两次独立运行，均全绿） |
| `cargo_check_workspace_forced.txt` | 强制重编后的 `cargo check --workspace --all-targets` |
| `cargo_test_web_integration_workbench.txt` | `cargo test -p web --test api_workbench`（6/6） |
| `tangle_run.txt` / `tangle_compare.txt` / `tangle_idempotent.txt` / `tangle_head_drift.txt` / `tangle_tsx_diff.txt` | tangle 幂等（再跑 0 diff）与生成物对拍、既存 TSX 漂移 |
| `churn_analysis.txt` / `engine_rs_churn.txt` | 忽略空白对拍与 engine.rs 空白差异归属 |
| `git_index_state.txt` / `db_cleanup.txt` | index 状态、DB 自有写入清理 |
| `prod_process.txt` / `prod_healthz.txt` / `prod_not_restarted.txt` / `prod_8082_tools_list.txt` / `prod_8082_tools_list_summary.txt` / `prod_8082_old_behaviour.txt` / `prod_binary_restore.txt` | 生产存活、未重启、tools/list、旧行为对照、二进制路径副作用处置 |
| `list_symbols_payload.json` / `prod_8081_api_symbols.json` / `d1_source_compare_web_vs_tool.txt` | D1 同源对拍 |
| `strategy_list_slim.json` / `strategy_list_full.json` | D5 体积与字段对拍输入 |
| `get_kline_legacy_payload_shape.json` | D2 向后兼容形状 |
| `probe_mcp_sse.py` / `fixture_final_rerun.txt` | 生产只读探针脚本；夹具最终复跑 |
