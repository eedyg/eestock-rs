# 015 — 部署后验收报告（生产 :8081/:8082 运行态实证）

> 本文档自身路径：`eestock-rs/tester/report/015_post_deploy_acceptance.md`
> 绝对路径：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/015_post_deploy_acceptance.md`
> （同内容镜像：`/home/eestock/workspace/git/eestock/tester/report/015_post_deploy_acceptance.md`）
> 原始证据目录：`eestock-rs/tester/evidence/015_post_deploy/`（43 个文件：41 项原始输出/JSON 载荷 + 探针源码 + spec）
> 验收时间：2026-09-12 22:29–22:39 CST
> 被验对象：**运行中生产进程** PID 3767395（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，启动 2026-09-12 22:28:40）
> 验收角色：Tester —— **只验证不改实现**：未修改任何实现文件、未提交 git、未重启/未停止服务、0 staged。

---

## 0. 结论

**部署成功（PASS，无 blocker）** —— 10 项验收全部通过；本次上线内容（MCP 契约批 D1/D2/D5/D9 + 引擎口径批 I-2/I-3/I-6 + D11/D11-fix + F3）在**运行中的生产 :8081/:8082** 上逐项取证成立。

伴随 **6 条残余风险 / 未覆盖项**（均非本次部署引入的 blocker，详见 §11/§12）：
其中 **R1（备份件是「本次新二进制」而非「部署前旧二进制」，不能用于行为回退）** 与
**R2（UI 工作台路径仍以 explicit+0.05 计 ETF 印花税，本次未做前端实测）** 需架构师知悉后决定是否跟进。

**关键判据一句话**：`tools/list`=34 且含 `list_symbols`；未注册标的在 `get_kline`/`strategy_test_run` 双侧 `isError`；
ETF 省略 fee → `effective.stamp_duty_pct=0 / source=profile`、显式 → `0.05 / explicit`，且**同标的两口径 Δpnl 恰等于印花税差额 50.152577 元（相对误差 0.000000%）**；
warmup 段 250 根逐 bar `warmup=true`、信号恒 buy 而**成交 0 笔**（首笔成交 open_bar=251）。

---

## 1. 验收方法与纪律

- **只打运行中的生产**：REST `127.0.0.1:8081`、MCP `127.0.0.1:8082`（SSE 传输，JSON-RPC over `/sse` + `POST /messages?sessionId=`）。
- **原始证据优先**：所有断言来自 `tester/evidence/015_post_deploy/` 下我自己采集的原始载荷（`probe_015.py` 探针源码同目录留档）。
- **只读为主**：DB 侧全部只读查询；唯一写操作 = 一次 `bt_run_ensemble` H1 提交（见 §11 R6，已留痕 `50_db_side_effects.txt`）。
- **不重启、不改实现、不提交**：进程 PID 在验收期间始终为 3767395（`37_crash_and_logscan.txt`）；`git diff --cached` 为空（`51_git_state.txt`）。

---

## 2. 部署事实复核（`36_process_and_health.txt`）

| 项 | 实测 | 结论 |
|---|---|---|
| 新进程 | PID 3767395，PPID 3767370，启动 `Sat Sep 12 22:28:40 2026`，cwd=仓库根 | ✅ 与架构师陈述一致 |
| 旧进程 3696673 | `ps -p` → 不存在 | ✅ 已退出 |
| 监听 | `ss -ltnp`：8081→pid 3767395 fd=11；8082→pid 3767395 fd=12 | ✅ 双端口同进程 |
| stdout/err | `/proc/3767395/fd/1` → `logs/app_dev_8081_redeploy_20260912_222837.log` | ✅ 新日志定位 |
| `/healthz` | `{"status":"ok"}` HTTP 200 | ✅ |
| 启动日志 | 6 行，含 `schema self-check ok`、`播种 seeded=0 skipped=0`、`sim-live 恢复 recovered=0 degraded=0`、`serving 0.0.0.0:8081`、`mcp server serving 0.0.0.0:8082` | ✅ 干净启动 |

---

## 3. 验收项 ①：MCP 工具面（PASS）

证据：`01_tools_list.json`、`49_tools_surface_check.txt`、`02_list_symbols.json`、`30_api_symbols.json`、`32_list_symbols_vs_api_compare.txt`

| 子项 | 期望 | 实测 |
|---|---|---|
| `tools/list` 工具数 | 34 | **34** ✅ |
| 含 `list_symbols` | 是 | **是**（第 4 个） ✅ |
| `list_symbols` 返回条数 | 44 | **44** ✅ |
| 每条含 `type` | 是 | **44/44 含 `type`**；分布 `etf 42 / lof 2`，`type is null` = 0 ✅ |
| 按 code 升序 | 是 | `codes == sorted(codes)` = **True** ✅ |
| 与 `/api/symbols` 同源 | 一致 | 注册字段 `code/name/type/interval_secs/settlement/enabled` **逐条差异=0**；`latest` 快照 **逐条差异=0**；code 集合一致 ✅ |

**口径注记（非阻塞，见 §11 R3）**：`/api/symbols` 在每条上额外含 web 收藏字段 `favorite` / `favorite_sort`（5 条 `favorite=true`），且 REST 排序为「收藏优先 → code 升序」；MCP `list_symbols` 不返回这两个字段、严格 code 升序（与工具描述「按 code 升序」一致）。工具描述写「与 web GET /api/symbols 同源**同字段**」——**注册表字段同源成立**，但「同字段」字面不含 web 收藏扩展列，属文档措辞待收紧。

---

## 4. 验收项 ②：I-1/D2 取数（PASS）

证据：`03/04/05/06/07/08_*.json`、`43_kline_i1_d2_check.txt`

| 子项 | 期望 | 实测 |
|---|---|---|
| 未注册 510300（`get_kline`） | `isError` + 消息含代码+原因 | `isError=true`，消息 `工具执行失败：标的 510300 未注册（不在平台 symbols 注册表内）——已拒绝查询；请核对代码（注册标的见 web /api/symbols）` ✅ |
| 不传 `from/to` | 旧形状不变 | keys=`["bars","code","period"]`，与 010 期基线 `{"keys":["bars","code","period"],"n_bars":240}` **逐键一致**（无 from/to 回显、无新增包裹层） ✅ |
| `from/to` date 形式 | from 闭、to 开且含 to 整日 | `from=2026-08-03 to=2026-08-10` → 回显 `from=2026-08-02T16:00:00Z`、`to=2026-08-10T16:00:00Z`；bars ts=`[08-02T16Z,08-03T16Z,08-04T16Z,08-05T16Z,08-06T16Z,08-09T16Z]`（=08-03…08-07、08-10 各 bar）；**含 08-10 整日、不含 08-11** ✅ |
| `from/to` RFC3339 形式 | to 严格开区间 | `[08-03T00:00+08:00, 08-06T00:00+08:00)` → bars `[08-02T16Z,08-03T16Z,08-04T16Z]`（=08-03/04/05，不含 08-06） ✅ |
| `limit>10000` | -32602 且含「10000」「分段」 | `{"code":-32602,"message":"limit 超上限 10000——请缩小 limit 或用 from/to 分段取数"}` ✅ |
| `get_kline` 1h | 可用 | 5 根 H1 bar（`…T02:00Z/T03:00Z/T05:00Z/T06:00Z/T07:00Z`，04:00Z 午休缺档属正常） ✅ |

---

## 5. 验收项 ③：D5 目录瘦身（PASS）

证据：`10_strategy_list_default.json`、`11_strategy_list_include_source.json`、`44_d5_strategy_list_check.txt`

| 口径 | 实测体积 | 说明 |
|---|---|---|
| `strategy_list` **默认**（15 条目） | **19477 字符**（payload text）／22061 字符整帧 | `version` 字段集 = `[approval_level, created_at, id, params_schema, published_at, sha256, status, strategy_id, version]` —— **不含 `code`**；payload 不含 `on_bar` ✅ |
| `include_source=true`（同 15 条目） | **52656 字符**（payload text）／56832 字符整帧 | `version` 增 `code`；payload 含 `on_bar` ✅ |
| 同目录口径缩减 | **−33179 字符 = −63.0%** | 同为 15 条目，可比 |
| 历史基准 39097（`tester/evidence/143/strategy_list_before_prod_8082.txt`） | 旧行为 11 条目 / 含 code 合计 24733 字符 | 条目数 11→15，**不可直接比值**；仅作量级参照：现默认 19477（-19620 字符） |

---

## 6. 验收项 ④：D9 注册表门禁（PASS）

证据：`12_testrun_d9_unregistered.json`、`45_d9_check.txt`

`strategy_test_run(symbol=510300, D1, sim_position, 内联恒买 code)` → `isError=true`，消息含代码 `510300` + 原因「未注册」。✅

---

## 7. 验收项 ⑤：I-6/H1（PASS）

证据：`13_testrun_h1.json`、`20_bt_run_ensemble_h1.json`、`21_bt_run_ensemble_bad_period.json`、`22_bt_get_run_h1.json`、`23_bt_get_run_result_h1.json`、`48_i6_h1_check.txt`

| 通道 | 实测 |
|---|---|
| `strategy_test_run` period=H1 | 成功：`bar_count=274`，`warmup 250/250`，1 笔成交，`fee.effective.source=profile` ✅ |
| `bt_run_ensemble` period=H1 | 接受并入库：`run_id=sr_1789223648181_000000`，`period=H1`，`from_ts=2026-08-02T16:00:00Z`/`to_ts=2026-08-06T16:00:00Z`，`status=queued`→轮询 `succeeded`（`progress=1.0`，`error=null`） ✅ |
| 枚举校验 | `period=M7` → `{"code":-32602,"message":"period 须为 M1/M5/M15/H1/D1"}`（H1 在允许集内） ✅ |
| 数据面 | `get_kline period=1h` 返回真实 H1 bar ✅ |
| schema | `strategy_test_run.period.enum` / `bt_run_ensemble.period.enum` 均 `[M1,M5,M15,H1,D1]`（`49_tools_surface_check.txt`） ✅ |

---

## 8. 验收项 ⑥：I-2 warmup（PASS，含「warmup 段无成交」硬取证）

证据：`14_testrun_warmup250.json`、`23_bt_get_run_result_h1.json`、`46_i2_warmup_check.txt`
探针：恒买 `function on_bar(ctx) { return 100; }`（warmup 段信号恒 `buy`，若执行必然立即建仓）。

| 通道 | 响应字段 | 逐 bar 标记 | 成交 | 判定 |
|---|---|---|---|---|
| `strategy_test_run` D1 510050（from 2026-08-01，warmup_bars=250） | `warmup_requested=250`、`warmup_effective=250`、`bar_count=280` | `scores`/`signals` 各 280 条均带 `warmup`；`warmup=true` 计数 **250**；首个 `warmup=false` 下标 **250** | **warmup 段 [0,249] 成交数 = 0**；唯一成交 `open_bar=251, close_bar=279` | ✅ warmup 段信号 = `{buy: 250}` 却零成交 |
| `bt_get_run_result` H1（warmup 缺省 250） | `config.warmup_requested=250 / effective=250` | `per_bar` 274 条，`warmup=true` 计数 **250**，首个非 warmup 下标 **250** | **warmup 段 orders 非空条数 = 0**；成交 `open_bar=266, close_bar=273` | ✅ |

warmup 段逐 bar 样例：`{"ts":1753113600,"signal":"buy","warmup":true}`（首根）；in-range 首条 `warmup:false`（下标 250）。

---

## 9. 验收项 ⑦：I-3/D11 费率（PASS，核心项）

证据：`15_testrun_fee_profile.json`、`16_testrun_fee_explicit.json`、`17_testrun_fee_explicit_no_stamp.json`、`18_testrun_fee_profile_518880.json`、`19_testrun_fee_profile_lof161226.json`、`47_i3_d11_fee_check.txt`
区间/策略：510050，D1，`from=2026-06-01 to=2026-09-12`，恒买探针（先建仓、期末强制平仓 → 产生卖出成交）。

| 断言 | 期望 | 实测 |
|---|---|---|
| 省略 `fee` → 印花税 | `effective.stamp_duty_pct == 0` | **0.0** ✅ |
| 省略 `fee` → 来源 | `effective.source == "profile"` | **"profile"** ✅ |
| 显式 `stamp_duty_pct:0.05` → 生效值 | 0.05 | **0.05** ✅ |
| 显式 → 来源 | `effective.source == "explicit"` | **"explicit"** ✅ |
| 显式**省略** stamp（旧行为） | 仍回落 0.05 | `stamp_duty_pct=0.05`、`source=explicit` ✅ |
| `fee.profile.not_modeled` 三项 | 经手费/证管费/过户费 | `["exchange_fee_pct","regulatory_fee_pct","transfer_fee_pct"]` ✅ |
| `fee.effective` 不含未建模字段 | 无 | `effective` 字段集恒为 `{commission_rate_pct, min_fee, slippage_bp, stamp_duty_pct, source}`；三项未建模键 **均不存在** ✅ |
| 同标的两口径 pnl 差 ≈ 印花税差额 | 相等 | `Δstamp = 50.152577`（profile 0.0 → explicit 50.152577）；`Δpnl = 50.152577`（280.077673 → 229.925096）；**相对误差 0.000000%** ✅ |
| 两口径可比性 | 同 bar/同成交 | `bar_count=324 vs 324`、`warmup 250/250 vs 250/250`、`trades=1 vs 1`、开平仓 bar `(251,323)` 完全一致、成交额 `100305.15396175579` 完全一致 ✅ |
| 第二真实 ETF 518880（省略 fee） | profile / 0 | `symbol_type=etf`、`source=profile`、`stamp 0.0`、`stamp_sum=0.0` ✅ |
| LOF 161226（省略 fee） | profile / 0 | `symbol_type=lof`、`source=profile`、`stamp 0.0`、`stamp_sum=0.0` ✅ |

`bt_run_ensemble` 的 config 快照同样落两段（`20_bt_run_ensemble_h1.json`）：`config.fee.effective={…,"source":"profile","stamp_duty_pct":0.0}` + `config.fee.profile.not_modeled=[三项]` ✅

---

## 10. 验收项 ⑧：数据面回归（PASS）

证据：`30_api_symbols.json`、`33_data_freshness.txt`、`34_logs_grep.txt`、`37_crash_and_logscan.txt`、`40/41_*.json`、`42_get_sources_health.json`

| 子项 | 实测 |
|---|---|
| `/api/symbols` | HTTP 200，**44 条**，`type` 分布 `etf 42 / lof 2`，`type is null` = 0 ✅ |
| tab 计数 | `symbols=44`、`type_null=0`、`fee_profiles=3` ✅ |
| M1 新鲜度 | `kline_accurate` 周期仅 `M1`；510050/518880/161226 `max(ts)=2026-09-11 07:00:00+00`（= 09-11 15:00 CST 收盘 bar），`last_sync` 快照 2026-09-12 10:00Z ✅ |
| D1/H1 新鲜度 | cagg 视图 `kline_accurate_1h` / `kline_accurate_1d` 末 bar 同 09-11；工具侧 `get_kline` 518880 1m 末 bar `2026-09-11T07:00:00Z`（close 8.943）、1d 末 bar `2026-09-10T16:00:00Z`（= 09-11 日 bar，close 8.943）✅ |
| 新鲜度口径 | 采集时刻 2026-09-12 是**周六**，最近交易日 = 09-11（周五）；`sync_checkpoints.last_synced_date=2026-09-11`、`updated_at=2026-09-12 10:00Z`（收盘后同步）→ **正常** ✅ |
| sim-live 恢复 | 启动日志 `sim-live 启动恢复完成 recovered=0 degraded=0`；`simsession` 12 行、`status='running'` = 0 ✅ |
| 日志 ERROR/panic | **0**：`"level":"ERROR"`=0、`"level":"WARN"`=0、`panic`=0、`panicked`=0、`SIGSEGV`/`SIGABRT`=0（日志 54 行，全部 INFO） ✅ |
| 崩溃/core | cwd 无 `core*`；`/var/crash`、`/var/lib/apport/coredump`、`/var/lib/systemd/coredump` 无本进程条目；`ulimit -c = 0`（内核不落 core）；**验收期间 PID 未变**（无重启/无崩溃恢复） ✅ |
| MCP 会话泄漏 | 日志 `sse session opened=24 / closed=24` 配对 ✅ |
| 数据源健康 | `get_sources_health(window_secs=3600)` → `{"sources":[]}`：窗口内无源事件（末次采集 10:00Z，进程 14:28Z 重启），属窗口口径结果，**非**故障证据（见 §11 R4） |

---

## 11. 验收项 ⑨：回滚可用性（PASS，含语义警告）与 ⑩ 未覆盖声明

### ⑨ 回滚件核对（`35_rollback_check.txt`）

| 项 | 实测 |
|---|---|
| 备份存在 | `/tmp/eestock-app-d11.bak`，205180096 B，mtime 2026-09-12 22:28:34 |
| sha256 三元一致 | 备份 `4183692d…a1d8ad` == `target/debug/eestock-app` == `/proc/3767395/exe`（运行中镜像）✅ |

**回滚步骤（供架构师执行；本次报告不执行）**：

```bash
# 1) 现场留档（建议）
cp -p eestock-rs/target/debug/eestock-app /tmp/eestock-app-d11.current.$(date +%Y%m%d_%H%M%S)
# 2) kill 新进程并确认端口释放
kill 3767395            # 5s 未退出则 kill -9 3767395
ss -ltnp | grep -E ':8081|:8082'   # 期望无输出
# 3) 恢复备份二进制
cp -p /tmp/eestock-app-d11.bak eestock-rs/target/debug/eestock-app
sha256sum eestock-rs/target/debug/eestock-app   # 期望 4183692d2afd5612b7dd19dd60dca275c5c56a6542b3afb230568deb80a1d8ad
# 4) 以同参数重启
cd eestock-rs && nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml \
  >> logs/app_dev_8081_rollback_$(date +%Y%m%d_%H%M%S).log 2>&1 &
# 5) 验收
curl -s 127.0.0.1:8081/healthz; curl -s 127.0.0.1:8081/api/symbols | head -c 200
```

> ⚠️ **语义警告（R1）**：备份 sha256 与 `target/debug/eestock-app` 相同 = 它是**本次上线后的新镜像**（构建于 21:58、复制于 22:28），**不是部署前的旧镜像**。因此步骤 3 只能「重启同一上线版本」（防误删/防构建产物损坏），**不构成代码行为回退手段**。若要回退 D11 行为，需 `git` 回退提交 + 重新 `build`（提交仍在仓库中），或使用部署前另行留档的旧二进制（本任务未定位到，`target/debug/eestock-app` 已被覆盖）。

### ⑩ 本次**未覆盖**的验证范围（显式声明）

1. **未做前端 UI 实测**：未打开浏览器、未跑 web E2E / Playwright；仅做静态定位（`52_fe_static_note.txt`）——见 R2。
2. **未做 M1/M5/M15/D1 逐周期端到端**：本次仅实打 MCP 侧的 D1（试算/回测）与 H1（试算 `bar_count=274` + 回测 `succeeded`）与 `get_kline` 的 1m/1d/1h；**M1/M5/M15 未逐周期跑通试算/回测**。
3. **未做并发/压测**：单会话串行调用；未验证多 SSE 会话并发、限流、连接耗尽、超时（会话 open/close 仅 24 对，串行）。
4. **未验证 F3 门禁运行时效果**：F3（tangle 门禁硬化）为**非运行时**变更，本次部署验收不含 tangle/CI 复跑（见 012 报告范围）。
5. **未做 stock 类型费率实测**：注册表 44 标的中无 `stock` 类型（42 etf / 2 lof），`stock` 分支费率（0.00341/0.002/0.05/0.001）**未在生产实测**。
6. **未覆盖第三条解析支路 `source="default"`**：生产库无 `type is null` 标的、3 个 fee_profiles 覆盖 etf/lof/stock；`type` 未设/无档案 → 旧默认 0.05 的兜底路径本次**未在生产复现**（013 期以隔离探针库验证过）。
7. **未做写型工具的回归**：`strategy_create/update/publish/archive`、`sim_*` 会话、`bt` 全系列仅用了 `bt_run_ensemble`+`bt_get_run`+`bt_get_run_result` 的 H1 happy path；失败/取消/归档重跑等分支未覆盖。
8. **未验证重启后采集调度**：`sync_checkpoints` 最新同步为**重启前**（10:00Z）的进程产物；重启后到验收结束（14:39Z）无新采集落库，**采集调度是否随重启正常接管未取得正证**（见 R5）。
9. **未验证 web REST 其余端点**：仅 `/healthz`、`/api/symbols`、DB 只读；`/api/kline`、工作台 REST、WS 推送未回归。
10. **费率值域边界未穷举**：未测 `stamp_duty_pct>1`、负值、`min_fee` 极大等非法/极端输入。

---

## 12. 残余风险（Residual Risks）

| # | 风险 | 级别 | 证据/说明 |
|---|---|---|---|
| **R1** | **备份件不能回退行为**：`/tmp/eestock-app-d11.bak` 与现场/运行镜像 sha256 相同 →「回滚」实为「重启同版本」；行为级回退需 git 回退 + rebuild | 中 | `35_rollback_check.txt` |
| **R2** | **UI 路径未享受类型推断**：`ConfigPanel` 提交恒带显式三键 fee（无 `stamp_duty_pct`）→ 后端判 `explicit` → **经 UI 提交的 ETF 回测仍收 0.05 印花税**；且回填读 `cfg.fee.rate_pct`，在两段 `effective/profile` 结构下该顶层键不存在（显示层风险）。本次**未做前端实测** | 中 | `52_fe_static_note.txt`（`ConfigPanel.tsx:263`、`:360-362`、`types.ts:833`）；014 报告 §7 已登记为既有债 |
| **R3** | MCP 工具描述称与 `/api/symbols`「同源**同字段**」，实测 REST 多出 `favorite/favorite_sort` 且排序不同（收藏优先） | 低（文档） | `32_list_symbols_vs_api_compare.txt` |
| **R4** | `get_sources_health(window_secs=3600)` 返回 `sources:[]`（窗口内无源事件）。窗口内无事件不等于源故障，但也**未取得「重启后链路健康」的正证** | 低 | `42_get_sources_health.json` |
| **R5** | 重启后无新采集落库（`sync_checkpoints.updated_at` 停在重启前 10:00Z）；采集调度随重启接管情况未验证 | 低-中 | `33_data_freshness.txt` |
| **R6** | 验收副作用：为验证 H1，向生产库写入 1 条 `strategy_run`（`sr_1789223648181_000000`，status=succeeded，`strategy_run` 总数 345）。如需洁净数据面可删该行（本次未删，避免越权改数据） | 低（已披露） | `50_db_side_effects.txt` |
| **R7** | `web/src/api/types.ts` 仍把 run config 与 preset config 复用旧扁平 `WorkbenchFee`、`mock.ts` 返回扁平 fee（与真后端两段形状漂移）；属既有前端保真债，无运行时破坏的结论来自 014，**本次未复验** | 低 | `52_fe_static_note.txt` |

---

## 13. 原始证据索引（`eestock-rs/tester/evidence/015_post_deploy/`）

| 文件 | 内容 |
|---|---|
| `probe_015.py` / `spec_batch*.json` / `_probe_015_raw.log` | 探针源码、调用清单、HTTP 状态/耗时/会话留痕 |
| `01_tools_list.json` | `tools/list` 原始帧（34 工具） |
| `02_list_symbols.json` | `list_symbols` 原始帧（44 条） |
| `03_get_kline_unregistered_510300.json` | 未注册 isError |
| `04_get_kline_legacy_default.json` | 不带 from/to 旧形状 |
| `05_get_kline_window_date.json` | date 形式区间边界 |
| `06_get_kline_limit_over.json` | limit>10000 → -32602 |
| `07_get_kline_1h.json` | H1 数据面 |
| `08_get_kline_rfc3339_window.json` | RFC3339 区间边界 |
| `10/11_strategy_list_*.json` | D5 默认 vs include_source |
| `12_testrun_d9_unregistered.json` | D9 门禁 |
| `13_testrun_h1.json` | I-6 试算 H1 |
| `14_testrun_warmup250.json` | I-2 试算 warmup |
| `15/16/17/18/19_testrun_fee_*.json` | I-3/D11 五种口径载荷 |
| `20_bt_run_ensemble_h1.json` / `21_bt_run_ensemble_bad_period.json` / `22_bt_get_run_h1.json` / `23_bt_get_run_result_h1.json` | I-6 回测 H1 提交→轮询→结果（含 per_bar warmup） |
| `30_api_symbols.json` | REST `/api/symbols` 原始 44 条 |
| `31_tools_list_summary.txt` | 工具名清单与 schema 摘要 |
| `32_list_symbols_vs_api_compare.txt` | 双通道同源对拍 |
| `33_data_freshness.txt` | DB 新鲜度 / 计数（只读 SQL） |
| `34_logs_grep.txt` | 新日志全文 + ERROR/WARN/panic 计数 |
| `35_rollback_check.txt` | 备份 sha256 三元一致 + 回滚步骤 + 语义警告 |
| `36_process_and_health.txt` | 进程/端口/healthz/旧 PID |
| `37_crash_and_logscan.txt` | 崩溃/core/会话配对检查 |
| `40/41/42_*.json` | 518880 1m/1d 尾部 bar、sources health |
| `43_kline_i1_d2_check.txt` | 取数口径逐条判定 |
| `44_d5_strategy_list_check.txt` | D5 体积测算与判定 |
| `45_d9_check.txt` | D9 判定 |
| `46_i2_warmup_check.txt` | warmup 逐 bar/成交判定 |
| `47_i3_d11_fee_check.txt` | 费率两段与 Δpnl 判定 |
| `48_i6_h1_check.txt` | H1 三通道判定 |
| `49_tools_surface_check.txt` | 工具面/schema 判定 |
| `50_db_side_effects.txt` | 本次唯一写入留痕 |
| `51_git_state.txt` | 0 staged / 未跟踪清单 |
| `52_fe_static_note.txt` | 前端静态定位（R2/R7） |

---

## 14. 逐项结论汇总

| # | 验收项 | 结论 |
|---|---|---|
| 1 | MCP 工具面（34 工具 / list_symbols / 44 条 / type / 升序 / 同源） | ✅ PASS |
| 2 | I-1/D2 取数（未注册 isError、区间边界、limit 上限、旧形状、1h） | ✅ PASS |
| 3 | D5 目录瘦身（默认 19477 vs 全量 52656，−63.0%） | ✅ PASS |
| 4 | D9 未注册 symbol 门禁 | ✅ PASS |
| 5 | I-6/H1（试算 + 回测 + 数据面 + 枚举反例） | ✅ PASS |
| 6 | I-2 warmup（250/250 标记、warmup 段零成交） | ✅ PASS |
| 7 | I-3/D11 费率（profile/explicit、not_modeled、Δpnl≡Δstamp） | ✅ PASS |
| 8 | 数据面回归（44 条、新鲜度、sim-live 0/0、0 ERROR/panic、无 core） | ✅ PASS |
| 9 | 回滚可用性（三元 sha256 一致 + 步骤；附语义警告 R1） | ✅ PASS（含警告） |
| 10 | 未覆盖声明 | ✅ 已声明（§11 ⑩） |

**最终结论：部署成功；无需回滚。** 建议架构师就 R1（备份语义）与 R2（UI 路径印花税/回填）做一次显式裁决。
