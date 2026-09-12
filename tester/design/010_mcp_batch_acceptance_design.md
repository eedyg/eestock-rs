# 010 · 测试设计报告（MCP 接口批 + 引擎口径批 独立验收）

> 本文件位置（self-reference）：`tester/design/010_mcp_batch_acceptance_design.md`
> 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
> 角色：Tester（只验证不改实现）。设计目的：为 010 批（D1/D2/D5/D9 + I-6/H1 + I-2 + I-3）建立
> **独立于 coder 自述**的验收证据链。

## 1. 测试策略

| 层次 | 手段 | 目的 |
|---|---|---|
| 契约层（schema） | `tools/list` 响应断言（dispatch + SSE 真链路双通道） | 工具入参面、required、enum、默认值描述 |
| 工具层（handler） | `mcp::rpc::dispatch` + 真实 storage/DB 装配 | 逐项功能与边界（D1/D2/D5/D9/I-6/I-2/I-3） |
| 传输层 | `mcp::server::build_router` + reqwest SSE 客户端（真 HTTP/SSE） | 证明非仅单元路径（tools/list、tools/call、协议错误帧） |
| Web 通道 | `web::build_router` + 独立 AppState 装配（复制 api_workbench 口径） | H1 白名单与试算 DTO（warmup/fee/policy/capital）在 REST 侧同口径 |
| 双通道对照 | 同一 strategy version + 同一区间/参数 → `strategy_test_run` vs `bt_run_ensemble`→`bt_get_run_result` | I-3「两通道口径一致」逐位对拍 |
| 数据层独立期望 | 绕过工具、直接用同一 domain 端口 `KlineRead::bars` 复算区间，与工具输出对拍 | D2 边界不依赖实现内部假设 |
| 工程门禁 | `cargo test` 指定包、`cargo check --workspace --all-targets`（先 `cargo clean` 强制重编）、临时目录 `entangled tangle` 幂等对拍、忽略空白 numstat 对拍 | 回归 + 生成物一致性 + 无格式化 churn |

## 2. 新增测试夹具（本次设计并编写，未提交）

| 文件 | 说明 |
|---|---|
| `crates/mcp/tests/zz_tester_010_acceptance.rs` | 主夹具：D1/D2/D5/D9/I-6/I-2/I-3 + 双通道对照 + SSE 传输 + schema 断言；原始证据落 `$EV_DIR` |
| `crates/web/tests/zz_tester_010_web.rs` | Web 通道夹具：H1 白名单 + 试算 DTO（warmup/fee/policy/capital）；自建独立 symbol/策略前缀，跑完清理 |
| `tester/evidence/010_mcp_batch/probe_mcp_sse.py` | 对**生产** `:8082` 的只读 JSON-RPC(SSE) 探针（tools/list、tools/call） |

均为 untracked 新增测试代码；不含任何实现改动（`git diff --cached` 为空，实现文件零触碰）。

## 3. 用例清单（should-when 命名）

- **D1** `list_symbols` 无必填入参 → tools/list schema 无 `required`；已注册集合+顺序+字段与 `select … from symbols order by code` 逐行对拍；与生产 web `/api/symbols` 逐 code 字段对拍；未知参数被忽略；注册表故障 → isError。
- **D2** `get_kline` 不传 from/to → `{bars,code,period}` 形状与 240 根；`limit=10001` → -32602（含「10000」「分段」）；用同一端口构造「区间恰 10000 根」→ 正常返回 10000 根；「区间 10001 根 > limit 10000」→ 显式 isError；date 形式 from/to 的 CST 日界换算与端口期望对拍；date 形式 ≡ 显式 RFC3339；同日/混合形式边界；非法 from/limit/from≥to → -32602；`period=1h` 数据层可用。
- **D5** `strategy_list` 默认（瘦身）vs `include_source=true`（全量）体积/字段对拍，全量体积与改前 39097 字符基准对拍；`include_source:"yes"` → -32602。
- **D9** `strategy_test_run` 未注册 symbol → isError（含被拒 code 与「未注册」）；已注册 → 正常；注册表故障 → isError。
- **I-6** `strategy_test_run`/`bt_run_ensemble` `period=H1` 正向；H1 区间 5y 过 / 6y 拒且与 D1 同上限；`W1` 仍拒；web REST 白名单 H1 过 / `1h` 拒。
- **I-2** 探针策略恒 buy（`return 100`）：`warmup_bars=0/5/缺省250` 三档 → requested/effective 回声、逐 bar `warmup` 前缀标记、warmup 段信号为 buy 但零成交、首个成交 open_bar ≥ warmup_effective；贴数据起点构造 history shortfall（effective < requested）；bt 通道 `net_value.len() == bar_count − warmup_effective`、`per_bar` 前 warmup_effective 根 `warmup=true`。
- **I-3** 缺省 fee 回声（stamp_duty_pct=0.05）与印花税合计 >0；显式 `stamp_duty_pct=0` → 回声 0 且印花税合计 0（佣金逐位相同、pnl 差 = 印花税）；`capital=200000` → 首笔 shares ×2.0；`policy=LumpSum 0.5` → shares ×0.5；`policy=Dca` 两通道一致；非法 fee/policy/capital/warmup 的分类（-32602 vs isError）。
- **双通道** 同 version/区间/参数（LumpSum 与 Dca 各一遍）→ `trades` 逐位相等、`config` 钉住 warmup_requested/effective + **生效** fee。
- **工程** 指定包 `cargo test` 全绿；强制重编 `cargo check --workspace --all-targets` 0 error/0 warning；临时目录 tangle 幂等且 136 个生成物与工作区逐字节相同；忽略空白对拍定位格式化 churn 归属；`git diff --cached` 空。
- **生产** `:8081/healthz`、`:8082` tools/list（SSE）；进程启动时间 vs 本批文件 mtime；生产旧行为对照（未注册 code 静默空 bars、无 list_symbols、limit 上限 1000）。

## 4. 边界与异常覆盖

- 数值边界：limit=10000/10001、区间根数 =10000/10001、H1 跨度 1826d/2192d、warmup=0/5/250、capital=0/-5、`warmup_bars=-1/1.5`。
- 时间边界：CST 日界（UTC 16:00 对齐）、`to` 含整日、from 闭/to 开、同日 date 形式、混合形式、RFC3339 归一。
- 故障注入：注册表查询失败（fail-closed）垫片；服务层校验失败（fee/policy）。
- 数据不可得：注册但区间无 bars、数据起点附近的 warmup shortfall。

## 5. 覆盖目标

- 010 批每一条验收项均有**至少一条原始输出证据**（`tester/evidence/010_mcp_batch/`），不采信 coder 自述。
- 不做（本设计明确排除）：前端 UI（web/src/features）、D11 标的类型推断印花税、生产重新部署。

## 6. 局限声明

- 夹具走 `mcp::rpc::dispatch` 为主 + 少量 SSE；未启动第二个 app 进程（避免触发 `WorkbenchService::recover` 等启动期写库路径干扰共用 dev DB/生产）。
- cagg（`kline_accurate_1h`）实时聚合窗口内的边界数据未刻意构造，H1 只验证「接受 + 与 D1 同上限 + 数据层可读」。
