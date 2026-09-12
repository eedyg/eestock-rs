# 016 — D11 v1.1（回归修复 + 守卫）独立复验报告（含 R-5 前端实跑）

- 报告自身路径：`eestock-rs/tester/report/016_d11_v11_acceptance.md`
- 绝对路径：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/016_d11_v11_acceptance.md`
- 同内容镜像：`/home/eestock/workspace/git/eestock/tester/report/016_d11_v11_acceptance.md`
- 原始证据目录：`eestock-rs/tester/evidence/016_d11_v11/`（70 项：探针源码/spec、逐条 HTTP/MCP 原始载荷、Playwright 截图与 console/network 日志、门禁与测试原始输出、拆除证据）
- 仓库：`eestock-rs`；分支 `master`；HEAD `88f558ae`（**工作树未提交**，本次复验不改工作树）
- 裁决依据：`design/01-architecture/adr/ADR-019-symbol-type-fee-profiles.md` §6（v1.1 修订 R-1..R-5）
- 实施报告：`coder/report/149_d11_v11_fee_regression_fix.md`（含 §10 守卫增量）
- 复验时间（UTC）：2026-09-12 14:54 ~ 15:05
- 纪律：**只验证不改实现**；不 git add/commit；不重启生产服务（生产 PID 3767395 全程在线，另运行于替代端口 18081/18082 的实例已拆除）

## 0. 结论（一句话）

**无阻断项**：ADR-019 v1.1 R-1/R-2/R-3 + R-2 补守卫在替代端口实例上逐项复现通过，R-5 前端真实浏览器闭环 9/9 通过，相关 crate 测试与门禁全绿，前端 `web/src`（TS）零改动，替代实例已拆除（端口释放 + 进程消失）。
**结论：可合并、可部署**；剩余风险见 §9（均为已披露/低危，其中「生产仍是 v1.0」意味着回归在线上仍生效，直至部署）。

## 1. 复验环境与替代实例（R-5 前置）

| 项 | 取值 | 证据 |
|---|---|---|
| 复验二进制 | `target/debug/eestock-app`（含 v1.1 工作树改动），sha256 `98635e74…13b33` | `43_env_and_build.txt`、`00_binary_sha256.txt` |
| 替代实例 | `127.0.0.1:18081`(web) / `127.0.0.1:18082`(MCP)，PID 3840565，2026-09-12T14:54:59Z 启动 | `40_alt_instance_app.log`、`40_alt_instance_config.toml` |
| 替代实例自建 config | 参照 `/tmp/app_dev_8081.toml`（同 DB），仅改 listen/mcp_listen + 静态目录绝对化 + `alert_eval_ms=3600000`（降低副作用） | `40_alt_instance_config.toml` |
| 启动期副作用 | `sim-live 启动恢复完成 recovered=0 degraded=0`（库内 `simsession` 12 行全 `ended`）、`strategy registry 播种 seeded=0 skipped=0` | `40_alt_instance_app.log` |
| 前端 | 真实浏览器 Playwright 1.63.0 + chromium（headless，1440×900，zh-CN），服务同一 `web/dist`（`web/src` 零改动 → 与生产同源字节） | `r5/r5_result.json` |
| 生产实例 | 未经接触：PID 3767395（exe 指向已删除 inode），8081/8082 全程 listening | `41_teardown.txt`、`43_env_and_build.txt` |

## 2. R-5 前端实跑（本次验收重点，9/9 通过）

脚本：`tester/evidence/016_d11_v11/r5_playwright_walkthrough.mjs`（同源真实浏览器操作 + 同源 fetch；产物 `r5/`）。
原始结果：`r5/r5_result.json`；console 原始日志 `r5/r5_console.log`（**空文件 = 零 console 消息**）；网络关键请求 `r5/r5_network_api.log`。

| # | 检查 | 结果 | 原始证据 |
|---|---|---|---|
| ① | 打开 `/backtest-workbench`（wb-config 渲染、预设下拉加载） | PASS | `r5/r5_01_preset_applied.png` |
| ① | 应用预设（`sp_…000002`，由新 run config 建立）→ 费用三输入框 = `0.025 / 5 / 2`（无 `undefined`/`NaN`） | PASS | `r5_result.json` → `R5-1-…` |
| ①+ | **加强证据**：应用取值与表单默认不同的预设（`0.011 / 3.5 / 7.25`）→ 三输入框**逐值等于预设 config**（证明输入框确由 `cfg.fee.*` 回填，而非"恰好等于默认值"） | PASS | `r5/r5_01b_preset_applied_distinct.png`、`r5_result.json` → `R5-1b-…` |
| ② | UI 点击「提交回测」→ `POST /api/workbench/runs` **201**，run `sr_1789225411103_000009` succeeded，`wb-result` 结果视图渲染 | PASS | `r5/r5_02_run_submitted.png`、`r5_network_api.log` |
| ② | 读回 run 钉住 `config.fee` = **扁平 4 键** `{min_fee:5, rate_pct:0.025, slippage_bp:2, stamp_duty_pct:0}`（**无 `effective`/`profile`**） | PASS | `r5_result.json` → `R5-2b-…` |
| ② | 响应回显：同源 `POST /api/strategies/test-run`（UI 三键 fee + ETF 510050）→ `fee.effective.stamp_duty_pct=0`、`source="explicit"`、`symbol_type="etf"`、`not_modeled=[exchange_fee_pct,regulatory_fee_pct,transfer_fee_pct]`、成交 `stamp_sum=0` | PASS | `r5_result.json` → `R5-2c-…` |
| ③ | 用该 run 的 config 新建预设（浏览器同源 POST，与前端 `store.createPreset` 同载荷）→ **201**（非 400），回显 fee 扁平 | PASS | `r5_result.json` → `R5-3a-…` |
| ③ | UI 路径：清空预设选择 + 填预设名 + 点「保存」→ 页面消息 **「已保存预设」** | PASS | `r5/r5_03_ui_preset_saved.png`、`r5_result.json` → `R5-3b-…` |
| ④ | 页面无 console error、无未捕获异常、无失败请求 | PASS | `r5_console.log`（空）、`r5_result.json`（`console_errors: []`, `pageerrors: []`, `requestfailed: []`） |

网络关键请求（`r5_network_api.log`，全 200/201）：`GET /api/workbench/presets`、`GET /api/strategies`、`GET /api/symbols`、`POST /api/workbench/presets/{id}/apply`（两次，对应两次预设回填）、`POST /api/workbench/runs` 201、`GET /api/workbench/runs/{id}` + `/result`、`GET /api/kline?code=510050…`、`POST /api/strategies/test-run` 200、`POST /api/workbench/presets` 201。

> 观察（非缺陷）：工作台 UI **不消费** run 的 fee（`ResultView` 只读 `buy_threshold/sell_threshold/slots`），`TestRunPanel` 亦不传/不显 fee 回显；故"两段回显 `effective/source`"在 UI 无可视呈现，本次以真实浏览器的同源 HTTP 调用取证（见 §9 风险 2）。

## 3. R-1 — 钉住 config 扁平 + 往返无损

替代实例上（原始载荷见 `http_01/http_05/http_06/http_07/http_09/http_10/http_13`、`mcp_10..mcp_15`）：

| 检查 | 结果 | 证据 |
|---|---|---|
| `POST /api/workbench/runs`（UI 三键 fee + 510050）201 响应 `config.fee` = 4 键扁平，`stamp_duty_pct=0` | ✅ | `http_01_submit_ui3_etf.json` |
| 省略 fee（分派 profile）201 响应 `config.fee` 同扁平 `stamp=0` | ✅ | `http_05_submit_no_fee_etf.json` |
| `GET /api/workbench/runs/{id}`、`GET /api/workbench/runs`（列表）、MCP `bt_get_run`、`bt_list_runs` 读回均为扁平 4 键（`effective/profile` 不存在） | ✅ | `http_06`、`http_07`、`mcp_12`、`mcp_13`、`mcp_15` |
| MCP `bt_run_ensemble` 显式 `stamp_duty_pct=0.07` → 钉住 `config.fee.stamp_duty_pct=0.07`（显式字段进钉住形态） | ✅ | `mcp_11`、`mcp_13` |
| `to_fee_model` 往返无损：以**不同数值**扁平 fee（`0.011/3.5/7.25/0.02`）建预设 → `GET` 读回**逐值相等**（回显同构） | ✅ | `http_13_preset_distinct_flat_fee.json`、`http_10_get_preset_from_run.json` |
| 两段结构**只**出现在试算/回测响应回显：`resolved_fee_to_json` 非测试调用点仅 `application/src/strategy.rs:701`（test_run 响应）；config 钉住两处均为 `fee_model_to_json`（`workbench.rs:357` submit、`:734` 预设） | ✅ | `42_call_sites.txt`、`35_ws_and_dto_diff.txt` |
| DB 侧实证：本次 6 条新 run 的 `config.fee` 全为 4 键扁平；全新库中两段结构仅剩历史 1 行（tester 015 所写） | ✅ | `37_db_after_verification.txt` |

## 4. R-2 — 字段级优先级五条用例（逐项原始取值）

真实库路径（替代实例 MCP `strategy_test_run`，510050=etf）与探针直调（stock/无档案两条真实库不可达）双通道：

| 用例 | 输入 | 实测输出 | 证据 |
|---|---|---|---|
| ① UI 三键（无 stamp）+ **ETF** | `{rate_pct:0.025,min_fee:5,slippage_bp:2}` | `effective{rate=0.025,min=5,slip=2,stamp=**0**,source=explicit}`，`symbol_type=etf`，成交 `stamp_sum=**0**`（v1.0 在此会取 0.05） | `mcp_01_testrun_ui3_etf.json`、`mcp_07`（rate=0.01 亦 stamp=0） |
| ② UI 三键（无 stamp）+ **stock** | 同上 + stock 档案 | `stamp_duty_pct=**0.05**`，`sell(1000@10).stamp=4.999` | `21_r2_five_cases_raw_values.txt`（`R2-2`）＋ `20_cargo_application_fee_unit.txt`（`explicit_three_keys_without_stamp_falls_back_to_stock_profile` ok） |
| ③ 显式 `stamp=0.07` | 三键 + `stamp_duty_pct:0.07`（stock / ETF 档案均测） | `stamp=**0.07**`，`source=explicit`；ETF 下 `sell().stamp=6.9986`，成交 `stamp_sum=271.0456` | `mcp_03_testrun_stamp007.json`、`21_…`（`R2-3`）、`mcp_13`（钉住 config=0.07） |
| ④ 无显式 + 档案 | fee 省略，510050 | `source=**profile**`、`stamp=0`、`not_modeled` 三项齐全 | `mcp_02_testrun_no_fee_etf.json`、`21_…`（`R2-4`） |
| ⑤ 无显式 + 无档案 | fee 省略 + 无档案 | `source=**default**`，`stamp=0.05`，`symbol_type=None` | `21_…`（`R2-5`）＋ `missing_fee_and_unknown_type_falls_back_to_legacy_default` ok |

补充：`partial_explicit_overrides_only_present_fields`（`{"rate_pct":0.01}` → rate 显式、其余逐字段回退）ok；`source` 口径（R-3）= 最高优先级来源，`explicit` 不等同"全字段显式"——①③⑥ 实测均为 `explicit` 且缺失字段来自档案，与文档口径一致。

## 5. 守卫（R-2 补守卫）与 HTTP 契约

| 检查 | 结果 | 原始证据（消息逐字） |
|---|---|---|
| MCP `fee={}` → `isError=true`，消息含**可识别字段集** | ✅ | `fee 对象不含任何可识别字段（可识别: rate_pct/min_fee/slippage_bp/stamp_duty_pct；当前收到: （空对象））` — `mcp_04` |
| MCP `fee={"foo":1}` → `isError=true`，消息含收到键 | ✅ | `…当前收到: foo` — `mcp_05` |
| MCP `fee={"commission_rate_pct":0.02}`（仅档案列名）→ `isError` | ✅ | `…当前收到: commission_rate_pct` — `mcp_08` |
| MCP `fee={"rate_pct":0.025}` → **成功**，缺失字段回退 ETF 档案（`min=5/slip=2/stamp=0`，rate 显式） | ✅ | `mcp_06`、`mcp_07`（rate=0.01 明确可辨） |
| 值域守卫未变：`stamp_duty_pct=1.5` → `isError` | ✅ | `fee.stamp_duty_pct 须 ∈ [0,1]（百分比）` — `mcp_09` |
| HTTP 层 `validate_backtest_fee` **三键契约未变** | ✅ | `fee={}`→400 `fee.rate_pct 缺失`；`{rate_pct}`→400 `fee.min_fee 缺失`；三键齐→201 — `http_02/03/04`；代码 diff 仅注释（`crates/web/src/dto.rs`）— `35_ws_and_dto_diff.txt` |

> **口径差异（需架构确认，非功能回归）**：任务书要求"`{}` → 400/isError 且**消息含可识别字段集**"。实测：**MCP/application 路径**满足（消息含 4 字段集与收到键）；**HTTP 路径**在到达守卫前被既有三键预校验拦下，400 消息为 `fee.rate_pct 缺失`，**不含**可识别字段集。ADR §6 明示"HTTP 三键预校验保持不变、守卫作用于应用层解析点"，故此为**裁决内的预期差异**，但要作为对外契约差异披露（§9 风险 1）。

## 6. 旧数据兼容（v1.0 两段结构历史 run 行）

历史行：`sr_1789223648181_000000`（510050/H1，tester 015 写入，`config.fee={effective,profile,symbol_type}`）。

| 读取/写入路径 | 实测 | 证据 |
|---|---|---|
| HTTP `GET /api/workbench/runs/{id}` | 200，**原样透传**（`fee_keys=[effective,profile,symbol_type]`），不崩 | `http_08_get_old_nested_run.json` |
| HTTP `GET /api/workbench/runs`（列表） | 200，新旧行并存，旧行形状不变 | `http_07_list_runs.json` |
| MCP `bt_get_run` | 成功，原样透传 | `mcp_14_bt_get_run_old_nested.json` |
| MCP `bt_list_runs`（100 行） | 成功，旧行原样 | `mcp_15_bt_list_runs.json` |
| 把旧两段 config 当**新预设**提交（HTTP） | **400** `fee.rate_pct 缺失或非数值`（显式错误，**非 panic**、无 5xx） | `http_11_preset_from_old_nested.json` |
| 仅把旧两段 fee 当新预设的 fee 提交 | **400** 同上 | `http_12_preset_nested_fee_only.json` |
| 服务端 panic / 日志异常 | 无（替代实例日志仅 4 行启动 INFO，无 ERROR/panic） | `40_alt_instance_app.log` |

## 7. 回归（crate 测试 / 门禁 / 工作树）

| 项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| fee 单测（含 R-2 五例 + 守卫） | `cargo test -p application --lib fee::` | **21 passed / 0 failed** | `20_cargo_application_fee_unit.txt` |
| application 全部 | `cargo test -p application` | **137 passed / 0 failed / 0 ignored** | `23_cargo_application_all.txt` |
| workspace lib | `cargo test --workspace --lib` | **270 passed / 0 failed / 0 ignored** | `22_cargo_workspace_lib.txt` |
| web lib | `cargo test -p web --lib` | **44 passed / 0 failed** | `25_cargo_web_lib.txt` |
| mcp lib | `cargo test -p mcp --lib` | **65 passed / 0 failed** | `26_cargo_mcp_lib.txt` |
| mcp 协议 | `cargo test -p mcp --test mcp_protocol` | **2 passed** | `27_cargo_mcp_protocol.txt` |
| 真实库只读 e2e | `cargo test -p mcp --test d11_fee_profile_e2e` | **1 passed** | `28_cargo_mcp_d11_e2e.txt` |
| 其余纯逻辑 crate（--tests） | `cargo test -p backtest -p strategy-core -p strategy-runtime -p simlive -p alert -p diagnose -p domain -p providers --tests` | **223 passed / 0 failed / 1 ignored** | `29_cargo_other_crates.txt` |
| 编译校验（含写库集成套件） | `cargo test --workspace --no-run` | **exit 0** | `30_cargo_workspace_norun.txt` |
| tangle 门禁 | `./scripts/check-tangle.sh` | **✅ 沙箱重生成逐字节一致，工作区未修改** | `31_tangle_gate.txt` |
| staged 文件 | `git diff --cached --name-only` | **0** | `32_git_state.txt` |
| 前端 `web/src`（TS）零改动（R-4 独立核验） | `git status -- web/`、`git diff HEAD -- web/src` | **0 改动、0 untracked** | `33_web_src_zero_changes.txt` |
| 无无关格式 churn | `git diff --numstat` vs `git diff -w --numstat` | 16 个改动文件**逐文件同值**（唯一差异：`fee.rs` 2 行空白/空行，补丁 1080→1078 行）；`Cargo.toml/lock` 未动 | `34_diff_hygiene.txt`、`35_ws_and_dto_diff.txt` |
| 临时探针夹具清理 | `crates/application/tests/zz_tester_016_fee_cases.rs` | 运行后**已删除**（副本留档 evidence） | `44_…`、`zz_tester_016_fee_cases.rs` |

> 说明：`crates/web/src`（Rust）有 **3 个文件仅注释变更**（`dto.rs`/`strategies.rs`/`workbench.rs`），`validate_backtest_fee` 行为未改（`35_ws_and_dto_diff.txt`）；R-4 所称"零改动"指**前端 `web/src`（TS）**，已独立核验成立。

## 8. 替代实例拆除证据（红线项）

| 检查 | 结果 | 证据 |
|---|---|---|
| 拆除前 | listeners `127.0.0.1:18081/18082` → PID 3840565（`/tmp/tester016/eestock-app_v11`） | `41_teardown.txt` |
| 拆除动作 | `SIGTERM` → 500ms 内退出（未用 SIGKILL） | `41_teardown.txt` |
| 进程消失 | `kill -0` 非零；`pgrep -x eestock-app_v11` = NONE | `41_teardown.txt` |
| 端口释放 | `ss -ltn \| grep 18081\|18082` = NONE；`curl` 两端口 http_code=000（连接失败） | `41_teardown.txt` |
| 临时件清理 | `/tmp/tester016/`、`/tmp/app_tester016.toml` 已删除（日志/config 副本留档 evidence） | `41_teardown.txt` |
| 生产未受影响 | 8081/8082 仍由 PID 3767395 listening | `41_teardown.txt` |

## 9. 残余风险 / 待架构确认

1. **HTTP 与 MCP 守卫消息不对称**（低）：`fee={}` 在 HTTP 层 400 消息为 `fee.rate_pct 缺失`（无"可识别字段集"），MCP 层为含字段集的守卫消息。ADR §6 明示 HTTP 三键预校验不变 → 属裁决内差异，但若对外要求"消息含字段集"则需架构决议（未改）。
2. **钉住 config 不携带 `source`/`symbol_type`**（低，观察项）：run 的 `config.fee` 只有 4 键，消费者无法从 run 行判断 `stamp=0` 来自 profile 还是显式 0；来源信息仅在试算/回测**响应回显**。前端 `ResultView`/`TestRunPanel` 均不读 fee，故当前无消费者受损；后续若要展示费率来源，需扩 contract（本批按 R-1 最小化，未加）。
3. **旧两段 run 行不可复用为预设**（低，已披露）：`to_fee_model` 对其显式 400（非崩溃）；读取路径全部透传不崩。
4. **部分字段合法（≥1 可识别）**：`{"rate_pct":…}` 合法并按档案回退；仅"空对象/全未知键"fail-fast——与裁决一致，但调用方若误传档案列名（`commission_rate_pct`）会得到 isError（已实测消息可识别）。
5. **生产仍为 v1.0（中）**：本次复验对象是替代端口的新二进制；生产 PID 3767395 未重启，**v1.0 的三处前端破坏在生产线上仍然存在**，直到部署 v1.1。
6. **验收副作用（已披露）**：向共享库写入 **6 条 `strategy_run`**（`sr_1789225123584_000000`、`sr_1789225123616_000001`、`sr_1789225152377_000004`、`sr_1789225167373_000005`、`sr_1789225397240_000006`、`sr_1789225411103_000009`，均 succeeded、fee 均扁平）；所有测试预设（6 条）已通过 API **全部删除**，`strategy_preset` 回到会话前状态（0 行）；`strategy_run` 345 → 351。run 行未删（不改他人数据面；如需洁净可另行裁定）。
7. **前端保真债未复验**（低）：`web/src/api/types.ts` 复用扁平 `WorkbenchFee`、`mock.ts` 返回扁平 fee（与真后端两段回显漂移）——014/015 已登记，本次未复验（R-4 只要求"前端无需改动"，已核验）。

## 10. 未覆盖声明（本批未做，不得据本报告推定）

1. **M1/M5/M15 逐周期端到端**：本次实跑仅 `D1`（HTTP 2 次 + MCP 2 次 + UI 2 次）；分钟级周期的费率/配置路径未端到端走查（周期枚举本身由 crate 测试覆盖）。
2. **并发**：未做多 run 并发提交（`DEFAULT_MAX_CONCURRENT=4`）与并发预设 CRUD；未做 WS 进度并发压测。
3. **stock 标的实际未注册**：`symbols` 表 44 只全为 `etf/lof`，`type IS NULL` = 0；故 R-2 ②（stock 档案）与 ⑤（无档案 default）**只有单测/探针证据**，无真实标的端到端。
4. **写库集成测试未运行**：`crates/storage`、`crates/web/tests/*`、`crates/mcp/tests/*`（`zz_tester_010_acceptance.rs` 等）仅 `--no-run` 编译校验；`crates/web` 集成套件中"fee 缺字段→400"断言依赖 HTTP 预校验（未改）未实跑。
5. **其他写型工具未回归**：`strategy_create/update/publish/archive`、`sim_*`、`bt_cancel/compare` 等未覆盖；本次未测 `bt_get_run_result` 对旧两段行的读取（`bt_get_run`/`bt_list_runs`/HTTP get+list 已覆盖）。
6. **未做**：git 提交/stage、实现或接口修改、前端改动、生产重启/部署、DB 结构变更。

## 11. 原始证据索引（`eestock-rs/tester/evidence/016_d11_v11/`）

| 证据 | 内容 |
|---|---|
| `probe_016_mcp.py` / `probe_016_http.py` + `spec_*.json` | 探针源码与调用清单（MCP SSE JSON-RPC / HTTP）；`_probe_016_*.log` 为 HTTP 状态/耗时/session 留痕 |
| `mcp_01..mcp_09_*` | R-2 五例 + 守卫 + 值域 + 部分字段（真实库路径，含 `fee.effective/profile` 逐字回显与成交 `stamp_duty`） |
| `mcp_10..mcp_15_*` | `bt_run_ensemble`（UI 三键 / 显式 0.07）钉住形态 + `bt_get_run`（新/旧）+ `bt_list_runs`（100 行） |
| `http_01..http_05_*` | HTTP 提交（UI 三键 / 省略 fee / fee `{}`、缺字段 400 契约） |
| `http_06..http_13_*` | 读回（run/list/旧两段）、预设往返（由 run config 建预设、不同数值扁平 fee 往返无损）、旧两段当预设 400 |
| `20_/21_/23_/44_*` | fee 单测、R-2 五例+守卫**原始取值**、application 全套、fee 相关用例名清单 |
| `22_/25_/26_/27_/28_/29_/30_*` | workspace lib / web lib / mcp lib / mcp 协议 / d11 真实库 e2e / 其余 crate / `--no-run` |
| `31_/32_/33_/34_/35_*` | tangle 门禁、git 状态（0 staged）、前端 `web/src` 零改动、diff 空白对拍、dto/Rust-web 注释 diff |
| `36_/37_*` | 预设清理（6→0）、库状态（351 run / 0 preset / 两段结构仅历史 1 行）+ 6 条新 run 的扁平 fee |
| `40_/41_/43_*` | 替代实例 config+启动日志、拆除证据（PID/端口/进程）、环境与二进制/静态资源 sha256 |
| `r5/` | Playwright 走查：`r5_result.json`（9/9 判定与逐项实测值）、`r5_console.log`（空）、`r5_network_api.log`、4 张截图 |
| `zz_tester_016_fee_cases.rs` | R-2 五例/守卫取值探针源码（**已从仓库删除**，仅留档） |
| `tmp_old_run.json` | 旧两段 run 的原始 GET 载荷（构造预设 400 用例输入） |

---

### 附：验收判定摘要

- R-1 扁平钉住 + 往返无损：**通过**
- R-2 字段级五例：**通过**（①③⑥ 真实库，②⑤ 单测/探针，②⑤ 无真实标的已在 §10 声明）
- R-2 补守卫 + HTTP 三键契约：**通过**（HTTP 守卫消息差异见 §9-1）
- 旧数据兼容（读不崩、写显式 400）：**通过**
- R-3 `source` 口径：**通过**
- R-4 前端零改动（TS）：**通过**
- R-5 前端实跑闭环（含 console/网络证据）：**9/9 通过**
- 回归门禁（crate 测试 / tangle / 0 staged / 无格式 churn）：**通过**
- 替代实例拆除：**完成**（端口释放 + 进程消失）
- **结论：可合并 / 可部署**（部署后建议复跑 R-5 于生产端口以关闭 §9-5）
