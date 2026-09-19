# D6 独立核验报告 —— `Dca.interval`（fail loud + 省略 = 1）

- **本文件位置**：`tester/evidence/20260919_d6_dca_interval_verify/README.md`
- **原始证据**：同目录 `raw/`（索引见文末）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`，基线 HEAD `40d16e1`（工作区含 coder 未提交改动，**本核验未 add/commit/checkout/stash/reset**）
- **日期**：2026-09-19｜**车道**：tester（只验不改；唯一写入 = 突变-还原，已以 sha256 证明逐字节还原）
- **临时库**：`tmp_d6v_1789806694`（ADR-025，已 teardown，回读库清单 = `{eestock, postgres, template0, template1}`）

> 上游判据一律**重新取证**，未采信 coder 报告中的任何数字。

---

## 0. 结论速览

| 核验项 | 结果 | 关键证据 |
|---|---|---|
| ①① HTTP `POST /api/workbench/runs` interval=0 → 结构化拒绝 | ✅ | 400 `{"error":{"code":"policy_invalid",...,"message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}`（Equal/FixedAmount 两模式均拒） |
| ①② MCP `bt_run_ensemble` interval=0 → 拒绝 | ✅（但**无 `code` 字段**，见 §6.2） | `isError=true`，`content[0].text="工具执行失败：Dca.interval 必须 ≥ 1（省略即为默认 1）"` |
| ①③ MCP `strategy_test_run` interval=0 → 拒绝 | ✅（同上，无 code） | 同文案 `isError=true`；省略 interval → 正常返回试算结果 |
| ② 省略 == 显式 1（防假绿） | ✅ | `/audit` 除 run_id 外**逐字段相同**；`batches_done` 6=6、`deployed_notional` 57658.32074472561=57658.32074472561；`/fills` 8/8 条**逐字段**相同；`/curve`、`/bars`、`/result.trades` 相同（`/result` 仅 summary 的 id/name/时间戳天然不同） |
| ③ 不回归（interval=1/5/20） | ✅ | **修复前二进制 vs 修复后二进制**在同一临时库/同一夹具/同一参数上 A/B：1→6 批、5→2 批、20→2 批，`deployed_notional`/`cash_consumed`/`unexecuted_orders` **全等**（`raw/32`）；并附纸面重算 |
| ④ 突变反证 | ✅ | 注掉新校验 ⇒ **3 条测试变红**（跨 2 个测试二进制）；还原后 sha256 与突变前逐字节一致且全绿 |
| ⑤ 门禁/越界 | ✅ | `./scripts/check-tangle.sh` exit 0（✅）；`git diff --cached` 空；tracked 改动仅 4 个本单文件；无 add/commit/checkout/stash/reset；仓内无探针残留（探针在 `/tmp`） |
| ⑥ 文档一致性 | ✅ | `design/12-strategy-system/01-adr.md:99` 与实现一致（`interval?: k（≥1；省略 = 1）` + 「0 fail loud、不再静默归一化」） |

**VERDICT: PASS**，但带 3 条必须上报的残留（§6，其中第 1 条是部署面硬缺口）。

---

## 1. 关键方法学：**修复前二进制**的取得（使 ③ 成为真 A/B，而非纸面推演）

线上服务 PID 818710 于 **11:17:10** 启动、持有 **01:13** 构建的 `target/debug/eestock-app`；而 `crates/strategy-core/src/policy.rs` 修改时间为 **16:29** ⇒ 该进程持有的是**修复前**代码。其 inode 在进程存活期间仍可达，遂直接取用：

```
$ cp /proc/818710/exe /tmp/d6v_prefix_app          # 修复前二进制（旧 inode）
$ sha256sum /tmp/d6v_prefix_app target/debug/eestock-app      # raw/05
895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b  /tmp/d6v_prefix_app
ead45c291f632563524edbc14192adf843ecfb98660d5bce361012138cbb4d02  target/debug/eestock-app
$ grep -ac "省略即为默认 1" /tmp/d6v_prefix_app   → 0   （修复前）
$ grep -ac "省略即为默认 1" target/debug/eestock-app → 1 （修复后，含新校验）
```

两者先后以同一配置指向**同一临时库**启动（修复后 `127.0.0.1:18081/18082`，修复前 `127.0.0.1:18091/18092`），**串行**执行探针以避免队列串抢。

## 2. 三入口拒 0（原始请求/响应）

夹具（自建，独立于 coder）：symbol `D6V01` + 12 根 M1（收 100,100,110,110,110,110,100,100,110,110,100,100）⇒ Buy 段 = bar2–5 与 bar8–9；趋势策略 `close>105 ? 90 : 20`。

### 2.1 HTTP（修复后，`:18081`，`raw/10_fixed_http_probe.txt`）
```
REQ  policy={"Dca":{"mode":"Equal","tranches":2,"interval":0}}
RESP 400 {"error":{"code":"policy_invalid","detail":{"period":"M1"},"message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}
REQ  policy={"Dca":{"mode":"FixedAmount","amount":1000.0,"tranches":2,"interval":0}}
RESP 400 {"error":{"code":"policy_invalid","detail":{"period":"M1"},"message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}
```
⇒ `code=policy_invalid`（复用既有体系，未新增码）、HTTP 400（非 422/500）、文案含「≥ 1」且点名字段与「省略即为默认 1」；**未落 run**。

### 2.2 MCP SSE（修复后，`:18082`，`raw/20_fixed_mcp_probe.txt`）
```
# bt_run_ensemble, policy={"Dca":{"mode":"Equal","tranches":2,"interval":0}}
POST /messages -> HTTP 202
RAW JSON-RPC {"id":10,"jsonrpc":"2.0","result":{"content":[{"text":"工具执行失败：Dca.interval 必须 ≥ 1（省略即为默认 1）","type":"text"}],"isError":true}}

# strategy_test_run, policy={"Dca":{...,"interval":0}}
RAW JSON-RPC {"id":15,"jsonrpc":"2.0","result":{"content":[{"text":"工具执行失败：Dca.interval 必须 ≥ 1（省略即为默认 1）","type":"text"}],"isError":true}}
```
语义对照（证明断言可判别、非恒真）：`bt_get_run_audit` 未知 run → `isError=true`「运行不存在: sr_nope」；param 类型错误走 JSON-RPC `-32602`（如 `slots[0].strategy_id 必填`）。`tools/list` = 35 工具，含三目标工具。

### 2.3 省略 = 1 在 MCP 侧同样成立
`bt_run_ensemble` 省略 interval → 成功返回 `run_id`；`bt_get_run_audit` 对照：
`omitted sr_1789806785356_000006` 与 `explicit interval=1 sr_1789806785714_000007` 的
`deployed_notional=57658.32074472561`、`deployed_pct=0.5765832074472561`、`cash_consumed=57688.32074472561`、`planned_tranches=10` **逐字段相同**。
`strategy_test_run` 省略 interval → 正常返回 12 bar 试算（scores/signals/trades 完整）。

## 3. 省略 vs 显式 1 等价性（关键防假绿）

| 端点（除 `run_id` 外） | 省略 interval | 显式 interval=1 | 结论 |
|---|---|---|---|
| `/audit` 全字段 | `batches_done=6, reachable_batches=6, planned_tranches=10, deployed_notional=57658.32074472561, cash_consumed=57688.32074472561, unexecuted_orders=0, round_trips_total=2` | 同左 | **逐字段相同** |
| `/fills` | 8 条 | 8 条 | **逐条逐字段相同**（`bar_index/price/qty/side/reason/ts/type`） |
| `/curve`、`/bars` | — | — | 逐字段相同 |
| `/result` | — | — | `drawdown/metrics/net_value/per_bar/trades/result_format` 全同；仅 `summary`（id/name/时间戳）天然不同 |
| `/brief` | — | — | 仅 id/name/created_at/started_at/finished_at 不同 |

**非空性（防「两端口都空 ⇒ 都相同」的假绿）**：fills 8 条非空、`deployed_notional≈57.7%` 非 0；且区间=1 的结果 **≠** interval=5 的结果（`19906.69137925272`），说明该等价性判据**可判别**。对账脚本：`raw/11_omitted_vs_explicit1_fieldwise.txt`、`raw/12_result_substance_equal.txt`。

## 4. 不回归（真 A/B，修复前 vs 修复后二进制）

`raw/32_prepost_ab_summary.txt`（同一 temp DB、同一夹具、同一参数）：
```
case         pre-batches post-batches         pre-notional        post-notional  same
explicit1              6            6    57658.32074472561    57658.32074472561    EQ   (audit 除 run_id 逐字段相同 = True)
k5                     2            2    19906.69137925272    19906.69137925272    EQ   (= True)
k20                    2            2    19906.69137925272    19906.69137925272    EQ   (= True)
```
纸面重算（既有触发逻辑：段内第 0 bar 触发、之后每 k bar 一批）：k=1→4+2=6；k=5→1+1=2；k=20→1+1=2 ⇒ 与 pre/post 实测**同时吻合**。
**代码面旁证**（`git diff`）：`norm_interval` 的函数体 `interval.max(1)` 未变（仅注释改写）；新增分支仅在 `*interval == 0`；`serde(default)` 仅作用省略场景 ⇒ 对 `interval ∈ {1,5,20}` 无可达路径变化。
**反向证伪**：修复前二进制在 **同一夹具** 上交出**完全不同**的结果 —— interval=0 → `201 succeeded`（静默当 1，`deployed_notional=186691.14147083063`）、省略 → `400 policy_invalid: missing field interval` ⇒ 两条契约各自都真的改变了行为，不是「改了等于没改」。

## 5. 突变反证（判据有效性）

把 `validate()` 中新增的 `interval == 0` 分支**临时注掉**（`raw/41_mutation_red.txt`）：

| 二进制 | 变红用例 | 结果 |
|---|---|---|
| `strategy-core --lib policy` | `dca_interval_zero_is_rejected_loudly`、`policy_validation` | `FAILED. 16 passed; 2 failed` |
| `application --test d6_dca_interval_serde` | `dca_interval_explicit_zero_parses_but_validate_rejects` | `FAILED. 2 passed; 1 failed` |

⇒ **3 条**测试变红（要求 ≥2）✔。还原（`cp` 回备份，**未用任何 git 命令**）：
```
raw/40_mutation_sha256_before.txt        cec749d83b8bcbf1cfdd10a8780bd9ca881ef2df3144ef333ee93cb1956245c5
raw/42_mutation_sha256_after_restore.txt cec749d83b8bcbf1cfdd10a8780bd9ca881ef2df3144ef333ee93cb1956245c5
SHA256_IDENTICAL=YES
```
还原后复跑：`strategy-core --lib policy` 18 passed/0 failed；`d6_dca_interval_serde` 3 passed/0 failed（`raw/43`）。

## 6. 门禁、越界、文档

### 6.1 门禁
- `./scripts/check-tangle.sh` → exit 0，`✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）`（`raw/50`）。
- `git diff --cached --name-only` → **空**（无暂存）；tracked 改动仅：`crates/strategy-core/src/policy.rs`、`design/12-strategy-system/01-adr.md`、`design/01-architecture/adr/ADR-023-*.md`、`web/src/features/workbench/ConfigPanel.test.tsx`（后者与 ADR-023 的改动均为上游既有、非新增；我只在 `tester/evidence/20260919_d6_dca_interval_verify/` 下新增文件）。
- 全程**未**执行 `git add/commit/checkout/stash/reset`；探针脚本均落在 `/tmp`（`d6v_probe.py`、`d6v_mcp_probe.py`、`d6v_app.toml`、`d6v_prefix.toml`），仓库内**零探针残留**。
- 临时库 teardown：`DROP DATABASE "tmp_d6v_1789806694" WITH (FORCE)`；回读库清单只剩 `{eestock, postgres, template0, template1}`（`raw/51`）。

### 6.2 ⚠️ 偏离 1：**MCP 线格式不含 `code` 字段**（与任务书字面断言不符，**非 D6 引入**）
任务书要求「既有结构化错误码（**含 code 字段**）」。实测：HTTP 面有 `code=policy_invalid`；MCP 面**没有** `code`——`tool_fail` 只透传 `format!("工具执行失败：{e}")`，`WorkbenchValidation`/`StrategyValidation` 的 `Display` 不含 `[code]`。该形状对**全部 35 个工具**的语义失败一致（本次另测 `bt_get_run_audit` 未知 run 同形），与 coder 报告 §7.2 的登记一致 ⇒ **属既有 wire 契约，非本单回归**。若要求 MCP 面也带码，属接口扩张（改 `tool_fail` 影响 35 工具），应由主代理另行裁决。

### 6.3 文档一致性
`design/12-strategy-system/01-adr.md:99` 现描述为 `Dca{..., interval?: k（**≥ 1**；省略 = 1）}` + 「`tranches<1`/`interval=0` 均非法配置，`validate` fail loud，**不再**静默归一化」+「省略时 serde default = 1，与显式 1 等价」 ⇒ 与实测实现**逐条一致**。未发现其他被改动的 API 文档描述（`crates/mcp/src/tools.rs` policy 描述串未改动，故 `design/07-app-plane/01-mcp.md` 无需同步；与 coder 声明一致）。
前端 `ConfigPanel.tsx` 的 `DCA 批间隔须为 ≥1 整数`（`input min=1`）未改动。

## 7. 残留不确定性（显式列出）

1. **【硬缺口】线上服务不是修复后的构建**：PID 818710（`:8081/:8082`，binary `2026-09-19 01:13`，进程 11:17 启动）持有**修复前**代码。直连实测（`raw/30`）：`interval=0` → **HTTP 201 且入队 succeeded**；省略 interval → `400 "policy 非法: missing field \`interval\`"` ⇒ **债务 D6 在部署面仍然存在**，需重新构建 + 重启（重建/上线不属 tester 授权，交主代理）。**本单所有 PASS 判据针对工作区源码构建的二进制（sha `ead45c29…`）**。
2. **MCP 面无 `code` 字段**（§6.2）——任务书字面判据在 MCP 面不成立；已按「不扩张 35 工具 wire 契约」处理，需主代理追认。
3. **我在活库写入 2 条探针 run**（活库只读原则的例外，因需实测线上入口）：`sr_1789806801403_000010`、`sr_1789806807357_000011`（均 `d6v_live_probe*`，`interval=0`，succeeded）。**未自行删除**（删活库行越界），请主代理决定清理或留作对照。
4. **前端 vitest 未由我复跑**（25 分钟硬时限内取舍）：故 coder 新增的 `ConfigPanel.test.tsx` D6 用例**未获独立执行证据**；我只核对了其断言语义与 `ConfigPanel.tsx:280-294` 既有校验（`Number.isInteger(interval) && interval >= 1` → 文案 `DCA 批间隔须为 ≥1 整数`；且 `:294` 总是显式发送 `interval`）在文案/行为上同口径。
5. `crates/web/tests/d6_dca_interval.rs`、`crates/mcp/tests/d6_dca_interval.rs`（coder 手写测试）我**未执行**（时限内改用等价的自建 curl/SSE 入口探针，覆盖面更靠近真实 wire）。以「我的入口探针」为准。
6. 活库 `interval=0` 历史 run `sr_1789787981802_000007` 仍存（对照，未动）；修复上线后同类请求将 400。

## 8. 证据索引（`tester/evidence/20260919_d6_dca_interval_verify/raw/`）

| 文件 | 内容 |
|---|---|
| `05_prefix_vs_fixed_binary_sha256.txt` | 修复前（从 /proc 取）/修复后二进制 sha256 |
| `10_fixed_http_probe.txt` / `.json` | 修复后 HTTP 全量原始请求/响应 + audit/fills 摘要 |
| `11_omitted_vs_explicit1_fieldwise.txt` | 省略 vs 显式 1 逐字段对账（audit/fills/curve/bars/result） |
| `12_result_substance_equal.txt` | `/result` 分段等价（trades/metrics/net_value/…） |
| `20_fixed_mcp_probe.txt` | 修复后 MCP SSE 八组原始 JSON-RPC 响应 |
| `30_live_stale_service_probe.txt` | 线上（修复前构建）直连原始响应 + 2 条探针 run |
| `31_prefix_http_probe.txt` / `.json` | 修复前二进制在同库同夹具上的全量响应 |
| `32_prepost_ab_summary.txt` | 修复前/后 A/B 汇总 + 纸面重算 |
| `40/42_mutation_sha256_*.txt`、`41_mutation_red.txt`、`43_post_mutation_green.txt` | 突变-还原证据链 |
| `50_check_tangle.txt` | `./scripts/check-tangle.sh` ✅ |
| `51_db_teardown.txt` | 临时库 DROP + 库清单回读 |

---
`VERDICT: PASS`（残留见 §7，其中 §7.1 为部署面硬缺口）
