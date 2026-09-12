# 017 — D11 v1.1 生产二次部署后验收报告（运行态 :8081/:8082 实证）

> 本文档自身路径：`eestock-rs/tester/report/017_post_deploy_v11_acceptance.md`
> 绝对路径：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/017_post_deploy_v11_acceptance.md`
> （同内容镜像：`/home/eestock/workspace/git/eestock/tester/report/017_post_deploy_v11_acceptance.md`）
> 原始证据目录：`eestock-rs/tester/evidence/017_post_deploy_v11/`
> （同内容镜像：`/home/eestock/workspace/git/eestock/tester/evidence/017_post_deploy_v11/`，`diff -rq` 判定 IDENTICAL）
> 证据规模：62 项（探针源码/spec、逐条 MCP/HTTP 原始载荷、Playwright 截图与 console/network 日志、日志与进程取证、回滚件核验）
> 被验对象：**运行中生产进程** PID 3923774（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，启动 2026-09-12 23:11:22）
> 验收时间：2026-09-12 23:12–23:24 CST
> 纪律：**只验证不改实现**；未改动任何实现/前端文件；未 `git add/commit`（0 staged）；**未重启/未停止服务**（PID 3923774 全程在线）

---

## 0. 结论

**部署成功（PASS，无 blocker）** —— 8 项验收全部通过。

**本批核心断言（v1.1 字段级回退）已在生产运行实例上成立**：
`strategy_test_run`（真实 ETF 510050）显式三键 fee（无 stamp）→ `fee.effective.stamp_duty_pct == 0.0` 且 `source == "explicit"`，
成交级 `stamp_sum == 0`（v1.0 在此会取 stock/旧默认 0.05）；省略 fee → `stamp == 0.0 / source == "profile"`；
显式 `stamp_duty_pct: 0.05` → 生效 `0.05`（旧行为可复现）。守卫对 `{}` / 全未知键 `isError`、对部分合法键放行并逐字段回退档案。

**部署事实复核成立**：运行镜像 sha256 `98635e74…13b33`（= tester 016 的 v1.1 构建），
与回滚件 `/tmp/eestock-app-v1.0-true.bak` sha256 `4183692d…a1d8ad`（**不含 v1.1 守卫串**）**确为两个不同版本** ——
这关闭了 tester 015 报告 R1「备份件=新二进制、无法行为回退」的问题。

**前端生产实例闭环未变**：真实浏览器 7/7 通过，费用输入框回填数值（非 `undefined`），UI 提交 ETF 回测成功且钉住 config 扁平 `stamp_duty_pct=0`，console 零消息/零错误。

剩余风险见 §9（均为低危或已披露，无本次部署引入的 blocker）。

---

## 1. 部署事实复核（`36_process_and_deploy_facts.txt`）

| 项 | 期望（架构师陈述） | 实测 | 结论 |
|---|---|---|---|
| 新进程 | PID 3923774 | PID 3923774，PPID 3923709，启动 `Sat Sep 12 23:11:22 2026`，cmd `./target/debug/eestock-app --config /tmp/app_dev_8081.toml` | ✅ |
| 旧进程 | 3767395 已 kill | `ps -p 3767395` → 不存在 | ✅ |
| 运行镜像 | v1.1 | `/proc/3923774/exe` sha256 `98635e74346fba06ef57519d5db4d13846fbf1e05b53e0118f50b6cc04813b33`（= `target/debug/eestock-app`，mtime 22:54） | ✅ |
| 新日志 | `logs/app_dev_8081_redeploy_20260912_231120.log` | `/proc/3923774/fd/1`、`fd/2` 均指向该文件 | ✅ |
| 监听 | :8081/:8082 | `ss -ltnp`：8081→pid 3923774 fd=11；8082→pid 3923774 fd=12 | ✅ |
| `/healthz` | ok | `{"status":"ok"}` HTTP 200 | ✅ |
| 启动日志 | 干净 | 6 行启动 INFO：`schema self-check ok`、`播种 seeded=0 skipped=0`、`sim-live 恢复 recovered=0 degraded=0`、`serving 0.0.0.0:8081`、`mcp serving 0.0.0.0:8082` | ✅ |

---

## 2. 验收项 1 — v1.1 核心：`strategy_test_run` 费率字段级回退（**PASS**）

探针：MCP SSE `tools/call`（`probe_017_mcp.py` + `spec_mcp_c.json`）；标的 `510050`（ETF），`D1`，`2026-06-01→2026-08-01`，`sim_position`。
双通道各测：`version_id=sv_1789013713975_000001`（已注册版本）与内联 `code=function on_bar(ctx){return 100;}`（架构师初检漏参即为此二选一契约，见 §4）。

原始逐字取值：`R2_fee_cases_raw_values.txt`；原始载荷：`mcp_10..mcp_17_*.json`。

| # | 断言 | 输入 | 实测 | 证据 |
|---|---|---|---|---|
| ① | 显式三键（**无 stamp**）→ `effective.stamp_duty_pct == 0`、`source == "explicit"` | `{rate_pct:0.025,min_fee:5,slippage_bp:2}` + version_id | `effective={commission_rate_pct:0.025, min_fee:5.0, slippage_bp:2.0, source:"explicit", stamp_duty_pct:0.0}`，`symbol_type=etf`，成交 `stamp_sum=0`，trades=4 | `mcp_10` |
| ①b | 同上，走**内联 code** 通道 | 三键 fee + 内联恒买 code | `stamp_duty_pct=0.0`、`source="explicit"`、`symbol_type=etf`、`stamp_sum=0`，trades=1 | `mcp_16` |
| ② | 省略 fee → `stamp == 0` 且 `source == "profile"` | 不传 fee | `stamp_duty_pct=0.0`、`source="profile"`、`stamp_sum=0` | `mcp_11` |
| ②b | 同上，内联 code | 不传 fee | `stamp_duty_pct=0.0`、`source="profile"` | `mcp_17` |
| ③ | 显式 `stamp_duty_pct:0.05` → 生效 0.05（可复现旧行为） | 三键 + `stamp_duty_pct:0.05` | `effective.stamp_duty_pct=0.05`、`source="explicit"`，成交 `stamp_sum=193.661113` | `mcp_12` |
| ④a | `fee.profile.not_modeled` 含经手费/证管费/过户费三项 | 任意调用 | `["exchange_fee_pct","regulatory_fee_pct","transfer_fee_pct"]` 三例恒现 | `mcp_10/11/12/15/16/17` |
| ④b | `effective` **不含**这三键 | — | `effective` 字段集恒为 `{commission_rate_pct, min_fee, slippage_bp, source, stamp_duty_pct}`；`not_modeled ∩ effective == []` | `R2_fee_cases_raw_values.txt` |

原始回显（`mcp_10`）：

```json
{"fee":{"effective":{"commission_rate_pct":0.025,"min_fee":5.0,"slippage_bp":2.0,
        "source":"explicit","stamp_duty_pct":0.0},
        "profile":{"not_modeled":["exchange_fee_pct","regulatory_fee_pct","transfer_fee_pct"], ...},
        "symbol_type":"etf"}, "trades":[{"stamp_duty":0.0, ...}], ...}
```

> 对照 v1.0：旧进程 3767395（现已被 kill）在 015 期实测「显式三键无 stamp + ETF → 0.05」，本批 ① 实测 0 → **修复生效**。

---

## 3. 验收项 2 — 守卫（**PASS**）

| 用例 | 输入 | 实测 | 证据 |
|---|---|---|---|
| 空对象 | `fee: {}` | `isError=true`，消息 `工具执行失败：fee 对象不含任何可识别字段（可识别: rate_pct/min_fee/slippage_bp/stamp_duty_pct；当前收到: （空对象））` | `mcp_13_testrun_empty_obj.json` |
| 全未知键 | `fee: {"foo":1}` | `isError=true`，消息 `…（可识别: rate_pct/min_fee/slippage_bp/stamp_duty_pct；当前收到: foo）` | `mcp_14_testrun_unknown_key.json` |
| 部分合法键 | `fee: {"rate_pct":0.025}` | **成功**；`rate_pct=0.025` 显式，缺失字段逐字段回退 ETF 档案 → `min_fee=5.0 / slippage_bp=2.0 / stamp_duty_pct=0.0`，`source="explicit"` | `mcp_15_testrun_partial_rate.json` |

三例均在生产运行实例复现，消息含**可识别字段集**与**收到键**，且字段级回退方向正确（stamp 由档案给出 0）。✅

---

## 4. 验收项 3 — 钉住 config 形状（**PASS**）

证据：`spec_mcp_c`/`m17_mcp.py` 提交 + 轮询；`mcp_20/21/22/23`、`http_03/04`。

| 子项 | 实测 |
|---|---|
| `bt_run_ensemble`（三键 fee，510050/D1）提交 | `POST` 成功，返回 `run_id=sr_1789226254329_000000` |
| 提交响应 `config.fee` | **扁平 4 键** `{min_fee:5.0, rate_pct:0.025, slippage_bp:2.0, stamp_duty_pct:0.0}`（无 `effective`/`profile`） |
| `bt_get_run` 轮询 | `status=succeeded`、`progress=1.0`、`error=null`；`config.fee` 同扁平 4 键，`stamp_duty_pct=0.0` |
| `bt_list_runs`（page_size=5） | HTTP 成功；首行即本次 run，`config.fee` 扁平 4 键 |
| REST 读回 `GET /api/workbench/runs/{id}` | 200，`config.fee` 扁平 4 键 |
| REST 列表 `GET /api/workbench/runs` | 200，100 行，`config.fee` 扁平 |
| 旧两段历史行读取 | `bt_get_run sr_1789223648181_000000` → 成功、原样透传 `fee={effective,profile,symbol_type}`，**不崩**（`mcp_24`） |

> 契约差异说明：`bt_run_ensemble` 工具描述仍称「**v1.1 补守卫**：显式对象存在但无可识别字段 → isError」，而任务书项 2 仅要求 `fee:{}`/`fee:{foo:1}` 在 `strategy_test_run` 侧 isError；本项 3 用**合法三键**提交，未触发 isError，`config` 钉住形态符合 R-1。两者不冲突。

---

## 5. 验收项 4 — 前端轻量实跑（生产 :8081，**PASS 7/7**）

脚本：`r5p_playwright_walkthrough.mjs`（Playwright 1.63.0 + chromium headless，1440×900，zh-CN，服务同 `web/dist`）。
产物：`r5p/r5p_result.json`、`r5p/r5p_console.log`、`r5p/r5p_network_api.log`、4 张截图。

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| ① | 打开 `/backtest-workbench`（wb-config 渲染、预设下拉加载） | PASS | `r5p_01_default.png` |
| ② | 默认费用输入框 = `0.025 / 5 / 2`（**非 undefined/NaN/空**） | PASS | `r5p_result.json` → `R5-1` |
| ③ | 应用取值与默认不同的预设（`0.011 / 3.5 / 7.25`）→ 三输入框**逐值等于预设 config**（证明由 `cfg.fee.*` 回填，非"恰好等于默认"） | PASS | `r5p_02_preset_applied.png`、`R5-1b` |
| ④ | UI 点击「提交回测」→ `POST /api/workbench/runs` **201**，run `sr_1789226552437_000003` succeeded，`wb-result` 渲染 | PASS | `r5p_03_run_submitted.png`、`R5-2` |
| ⑤ | 读回 run 钉住 `config.fee` = **扁平 4 键** `{min_fee:5, rate_pct:0.025, slippage_bp:2, stamp_duty_pct:0}`（无 `effective/profile`） | PASS | `R5-2b` |
| ⑥ | 同源 `POST /api/strategies/test-run`（三键 fee + 510050）→ `effective.stamp_duty_pct=0`、`source="explicit"`、`symbol_type="etf"`、成交 `stamp_sum=0` | PASS | `R5-2c` |
| ⑦ | 无 console error、无未捕获异常、无失败请求 | PASS | `r5p_console.log`（**1 字节空文件 = 零 console 消息**）、`R5-4`（`console_errors:[]`/`pageerrors:[]`/`requestfailed:[]`） |

网络关键请求（`r5p_network_api.log`，全 200/201）：`GET /api/strategies`、`GET /api/workbench/presets`、`GET /api/sources/health`、`GET /api/workbench/runs`、两次 `POST /api/workbench/presets/{id}/apply`、`GET /api/symbols`、`POST /api/workbench/runs 201`、`GET /api/workbench/runs/{id}` + `/result`、`GET /api/kline?code=510050…`、`POST /api/strategies/test-run 200`。

> 与 016 在替代端口同构建的 9/9 对比：本次为**生产实例**上的轻量勾稽（含费用回填/提交/钉住/console），闭环未变。

---

## 6. 验收项 5 — 回归面（与 tester 015 基线对比，**PASS**）

### 6.1 MCP 工具面（`49_tools_surface_check.txt`、`mcp_01`）

| 项 | 015 基线 | 本次实测 | 结论 |
|---|---|---|---|
| `tools/list` 工具数 | 34 | **34** | ✅ |
| 含 `list_symbols` | 是 | 是 | ✅ |
| `list_symbols` 条数 | 44 | **44**（etf 42 / lof 2，`type is null`=0，code 升序=True） | ✅ |
| `period.enum` | `[M1,M5,M15,H1,D1]` | `[M1,M5,M15,H1,D1]`（test_run / bt_run 均同） | ✅ |
| `strategy_test_run.fee.description` | — | 含 v1.1 补守卫措辞与「explicit/profile/default」source 口径 | ✅ |

### 6.2 `get_kline` 取数（`mcp_30..35`）

| 子项 | 015 基线 | 本次实测 |
|---|---|---|
| 未注册 510300 | isError | `isError=true`，`标的 510300 未注册（不在平台 symbols 注册表内）…` ✅ |
| `limit=10001` | `-32602` | `{"code":-32602,"message":"limit 超上限 10000——请缩小 limit 或用 from/to 分段取数"}` ✅ |
| 不带 from/to 旧形状 | keys `[bars,code,period]`、240 bar | keys `["bars","code","period"]`、**240** bar ✅ |
| date 区间 `2026-08-03→2026-08-10` | from 08-02T16Z / to 08-10T16Z；含 08-10 整日 | `from=2026-08-02T16:00:00Z`、`to=2026-08-10T16:00:00Z`；bars `[08-03,08-04,08-05,08-06,08-07,08-10]` ✅ |
| RFC3339 区间 `[08-03,08-06)` | 严格开区间 | bars `[08-03,08-04,08-05]`（不含 08-06） ✅ |
| `1h` | 可用 | 5 根 `T02/T03/T05/T06/T07Z` ✅ |

### 6.3 `strategy_list` 瘦身（`mcp_03/04`）

| 口径 | 015 基线（字符） | 本次实测（payload text） | 结论 |
|---|---|---|---|
| 默认 | 19477 | **19477**（15 条目；`version` 无 `code`） | ✅ 一致 |
| `include_source=true` | 52656 | **52656**（`version` 增 `code`，payload 含 `on_bar`） | ✅ 一致 |
| 缩减 | −63.0% | **−63.0%**（19477 vs 52656） | ✅ 一致 |

### 6.4 H1 与 warmup（`mcp_40/41`、`warmup_i2_summary.txt`）

| 子项 | 实测 |
|---|---|
| `strategy_test_run period=H1` | 成功：`bar_count=514`、`scores=514`、`signals=514`、`warmup_requested=250/effective=250`；`fee.effective.source="profile"`、`stamp=0.0` ✅ |
| 枚举反例 `period=M7` | `{"code":-32602,"message":"period 须为 M1/M5/M15/H1/D1"}` ✅ |
| warmup 字段 | 响应含 `warmup_requested` / `warmup_effective`（250/250）、`bar_count=280` |
| 逐 bar 标记 | `scores` 280 条均带 `warmup`；`warmup=true` 计数 **250**，首个 `warmup=false` 下标 **250**；`signals` 同 |
| warmup 段无成交（恒买探针） | trades=1，**warmup 段 [0,249] 成交 0**，首笔成交 `open_bar=251, close_bar=279` ✅ |
| 样例 | `score[0]={"ts":1753113600,"score":100.0,"warmup":true}`；`score[250]={"ts":1785686400,...,"warmup":false}` |

---

## 7. 验收项 6 — 数据面与健康（**PASS**）

证据：`33_data_health.txt`、`34_logs_grep.txt`、`34_new_log_copy.log`、`36_process_and_deploy_facts.txt`。

| 子项 | 实测 |
|---|---|
| `/api/symbols` | HTTP 200，**44 条**，`type` 分布 `etf 42 / lof 2`，`type is null`=0 ✅ |
| DB（只读） | `symbols=44 type_null=0`、`fee_profiles=3`、`simsession_total=12 running=0` ✅ |
| sim-live 恢复计数 | 启动日志 `sim-live 启动恢复完成 recovered=0 degraded=0`；库内 `running=0` ✅ |
| 日志 ERROR/WARN/panic | `level:ERROR=0`、`level:WARN=0`、`panic=0`、`panicked=0`、`SIGSEGV\|SIGABRT=0`；日志 64 行**全 INFO** ✅ |
| SSE 会话泄漏 | `session opened=29` / `session closed=29`（**配对无泄漏**） ✅ |
| 崩溃/core | cwd 无 `core*`；`ulimit -c=0`；`/var/crash` 无 eestock 条目；验收期间 PID 未变 ✅ |
| 数据新鲜度 | `sync_checkpoints.max(last_synced_date)=2026-09-11`（周五，最近交易日）；采集时刻 2026-09-12 为周六 → 正常 ✅ |

原始 grep 输出（节选，`34_logs_grep.txt`）：

```
log=logs/app_dev_8081_redeploy_20260912_231120.log
lines=64
level_ERROR=0
level_WARN=0
panic=0
panicked=0
SIGSEGV_or_SIGABRT=0
sse_opened=29
sse_closed=29
--- non-INFO lines (expect none) ---
```

---

## 8. 验收项 7 — 回滚件可用性（**PASS**）

证据：`35_rollback_check.txt`。

| 项 | 实测 |
|---|---|
| 存在 | `/tmp/eestock-app-v1.0-true.bak`，`205180096` B，mtime 2026-09-12 23:11 |
| 类型 | ELF 64-bit LSB pie executable，BuildID `7249c2184ce806165039fa94f736aa95a5d6fabf` |
| 可执行 | `test -x` → **YES** |
| sha256 | `4183692d2afd5612b7dd19dd60dca275c5c56a6542b3afb230568deb80a1d8ad` |
| 不含 v1.1 守卫串 | `grep -c 'rate_pct/min_fee/slippage_bp/stamp_duty_pct'` → **0** |
| 对比：部署件/运行镜像 | 同串计数 **1**；sha `98635e74…13b33` |
| 版本关系 | 回滚件 sha = 015 期旧进程 `/proc/3767395/exe`（行为级 v1.0）；部署件 = 016 期 v1.1 构建 → **两版本确实不同，可行为回退** |

**回滚步骤（供架构师执行；本次不执行、不重启）**：

```bash
# 1) 留档当前 v1.1 现场（可选）
cp -p eestock-rs/target/debug/eestock-app /tmp/eestock-app-v1.1.current.$(date +%Y%m%d_%H%M%S)
# 2) kill 新进程并确认端口释放
kill 3923774                       # 5s 未退出则 kill -9 3923774
ss -ltnp | grep -E ':8081|:8082'   # 期望无输出
# 3) 恢复 v1.0 回滚件
cp -p /tmp/eestock-app-v1.0-true.bak eestock-rs/target/debug/eestock-app
sha256sum eestock-rs/target/debug/eestock-app   # 期望 4183692d2afd5612b7dd19dd60dca275c5c56a6542b3afb230568deb80a1d8ad
# 4) 以同参数重启
cd eestock-rs && nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml \
  >> logs/app_dev_8081_rollback_$(date +%Y%m%d_%H%M%S).log 2>&1 &
# 5) 验收
curl -s 127.0.0.1:8081/healthz
curl -s 127.0.0.1:8081/api/symbols | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'   # 期望 44
```

> 语义提示：回滚到 v1.0 会**同时回退 v1.1 的修复**（含前端费用回填与 ETF 印花税字段级回退），即恢复 015 §9 所记已知缺陷。

---

## 9. 残余风险 / 待架构确认

| # | 风险 | 级别 | 证据/说明 |
|---|---|---|---|
| R1 | **二进制与提交时点不一致（构建可复现性未证）**：仓库 HEAD `2844cc3d`（提交时间 2026-09-12 23:05:29），而部署二进制 mtime 22:54（016 于工作树构建）。运行二进制 == 016 复验的构建，但**无法在本次只读验收中证明其字节等价于已提交源码**（未重新 build/比对） | 低-中 | `git log -1`；`ls -la target/debug/eestock-app`；016 §1 |
| R2 | **回滚即回退修复**：`/tmp/eestock-app-v1.0-true.bak` 为真 v1.0 → 回滚会恢复 015 §9 前端与 ETF 印花税缺陷 | 低（已知） | §8 |
| R3 | **HTTP 与 MCP 守卫消息不对称（沿用 016 R1）**：`fee={}` 在 HTTP 层被既有三键预校验拦下（消息不含可识别字段集），MCP/application 层含字段集 | 低（裁决内） | 016 §9-1；本次只验 MCP 侧 |
| R4 | **钉住 config 不携带 `source`/`symbol_type`**：run 的 `config.fee` 仅 4 键，来源不可从 run 行判读（两段回显仅在试算/回测响应） | 低（观察项） | §4；016 §9-2 |
| R5 | **验收副作用**：向生产库写入 2 条 `strategy_run`（`sr_1789226254329_000000` MCP、`sr_1789226552437_000003` UI），`strategy_run` 351→353；另建的 2 条测试预设已通过 API 删除（`strategy_preset` 回到 0）。run 行**未删**（避免越权改他人数据面） | 低（已披露） | `50_db_side_effects.txt` |
| R6 | **重启后采集调度未取正证**：`sync_checkpoints.updated_at` 未在本次窗口观察到新写入（周六非交易日，属正常），但「采集调度随重启接管」无正证 | 低 | `33_data_health.txt` |
| R7 | **stock 类型 / 无档案 `source="default"` 分支未在生产实测**：注册表 44 只全为 etf/lof，`type is null`=0 | 低（数据面限制） | `33_data_health.txt` |

---

## 10. 验收项 8 — 未覆盖声明（本批未做，不得据本报告推定）

1. **M1/M5/M15 分钟级逐周期端到端**：本次仅实打 `D1`（试算/回测/UI）与 `H1`（试算）；分钟级费率/配置路径未端到端走查（周期枚举由响应契约反例覆盖 `M7`）。
2. **并发/压测**：单会话串行调用；未做多 run 并发提交（`DEFAULT_MAX_CONCURRENT=4`）、并发预设 CRUD、WS 进度并发（SSE 仅 29 对，串行）。
3. **写型工具未回归**：`strategy_create/update/publish/archive`、`sim_*` 全系列（仅读取 DB 运行态）、`bt_cancel_run`/`bt_compare_runs`/`bt_get_run_result` 未覆盖；`bt_run_ensemble` 仅 happy path（无失败/取消/归档重跑）。
4. **stock 标的与 `source="default"` 兜底路径**：生产无 stock/无档案标的，未做真实标的端到端（见 R7）。
5. **crate 测试 / 门禁未复跑**：本次为**部署后运行态验收**，未运行 `cargo test`、tangle 门禁、CI（016 已覆盖构建期回归）。
6. **旧两段 run 行写入路径未复验**：仅复验读取透传（`mcp_24`）；「旧两段 config 当预设提交 → 400」未在本次复跑。
7. **未验证重启后采集调度/数据源健康正证**：`get_sources_health` 未单独调用；`sync_checkpoints` 未见新写入（见 R6）。
8. **费率值域边界未穷举**：未测 `stamp_duty_pct>1`/负值/`min_fee` 极值（016 单测已覆盖 [0,1] 值域）。
9. **未做**：git 提交/stage、实现或接口修改、前端改动、生产重启/部署、DB 结构变更。
10. **前端仅轻量勾稽**：未跑 016 的完整 9/9（含预设新建 UI 路径、`wb-result` 结果页深度断言），本次聚焦费用回填 + 提交 + 钉住 + console（任务书范围）。

---

## 11. 原始证据索引（`eestock-rs/tester/evidence/017_post_deploy_v11/`）

| 证据 | 内容 |
|---|---|
| `probe_017_mcp.py` / `probe_017_http.py` / `m17_mcp.py` + `spec_mcp_a..e.json` / `spec_http_a.json` | 探针源码与调用清单（MCP SSE JSON-RPC / HTTP）；`_probe_017_*_raw.log` 为原始状态/耗时/session 留痕 |
| `mcp_01` / `mcp_01_tools_names.txt` | `tools/list` 原始帧（34 工具）与清单 |
| `mcp_02_list_symbols.json` | `list_symbols` 原始帧（44 条） |
| `mcp_03/04_strategy_list_*.json` | D5 默认 vs include_source |
| `mcp_10..mcp_17` | **项 1/2 核心**：显式三键（version_id + 内联 code）、省略 fee、显式 0.05、空对象、未知键、部分键逐字回显 |
| `R2_fee_cases_raw_values.txt` | 项 1/2 判定与逐条实测取值 |
| `mcp_20/21/22/22_summary` | `bt_run_ensemble` 提交 → 轮询 → 钉住 config |
| `mcp_23_bt_list_runs.json` / `mcp_24_bt_get_run_old_nested.json` | 列表读回 / 旧两段历史行透传 |
| `mcp_30..35` | `get_kline` 未注册/超限/旧形状/date/RFC3339/1h |
| `mcp_40..43` | H1 试算 / warmup250 / 周期反例 / code+version 二选一反例 |
| `warmup_i2_summary.txt` | warmup 逐 bar 与成交判定 |
| `http_01..06` | healthz / symbols / run 读回 / runs 列表 / 预设创建（含 distinct-fee） |
| `r5p/` | Playwright 生产走查：`r5p_result.json`（7/7 与逐项实测值）、`r5p_console.log`（空）、`r5p_network_api.log`、4 张截图（`r5p_01_default` / `r5p_02_preset_applied` / `r5p_03_run_submitted` / `r5p_04_final`） |
| `33_data_health.txt` / `34_logs_grep.txt` / `34_new_log_copy.log` | 数据面/健康、日志 ERROR/WARN/panic 原始 grep、新日志副本 |
| `35_rollback_check.txt` | 回滚件 sha256/可执行/守卫串核验 + 回滚步骤 |
| `36_process_and_deploy_facts.txt` | 进程/端口/fd/healthz/旧 PID 复核 |
| `49_tools_surface_check.txt` | 工具面与 fee 描述/schema |
| `50_db_side_effects.txt` | 本次写入留痕（2 run；2 预设已删） |

---

## 12. 逐项结论汇总

| # | 验收项 | 结论 |
|---|---|---|
| 1 | **v1.1 核心**：显式三键无 stamp → `stamp=0/source=explicit`（version_id + 内联 code）；省略 → `0/profile`；显式 0.05 → 0.05；`not_modeled` 三项在 / `effective` 不含 | ✅ PASS |
| 2 | 守卫：`{}`→isError（含字段集）、`{foo:1}`→isError、`{rate_pct}`→成功且回退档案（stamp=0） | ✅ PASS |
| 3 | 钉住 config 形状：`bt_run_ensemble` → 扁平 4 键 `stamp=0`；`bt_get_run`/`bt_list_runs` 正常 | ✅ PASS |
| 4 | 前端生产实例轻量实跑（费用回填数值 / UI 提交 / 钉住 stamp=0 / console 零错误） | ✅ PASS 7/7 |
| 5 | 回归面（34 工具含 list_symbols / get_kline 四口径 / strategy_list 19477 vs 52656 / H1 / warmup 250 标记与零成交） | ✅ PASS |
| 6 | 数据面与健康（`/api/symbols` 44 / sim-live 0/0 / 0 ERROR·WARN·panic / SSE 29↔29 / 无 core） | ✅ PASS |
| 7 | 回滚件可用性（存在/可执行/不含守卫串 = 真 v1.0；附步骤） | ✅ PASS |
| 8 | 未覆盖声明 | ✅ 已声明（§10） |

**最终结论：部署成功；无需回滚。** 剩余风险见 §9，其中 R1（构建与提交时点）建议架构师知悉。
