# 129 — 策略删除功能 + 策略编程手册双通道暴露

报告位置：`coder/report/129_strategy_delete_and_guide_exposure.md`（eestock-rs 仓内）。

## 需求

1. **策略删除**（裁决 2026-09-10）：仅当策略全部版本均为 draft（或无版本）时可删；任何版本曾为
   published（含已归档）→ 禁止（历史 run 钉住 sha256，删除破坏复现性）。domain 端口 + storage
   单语句防竞态 + application 404/409 映射 + REST DELETE 204/404/409 + manage 列表 `deletable`
   字段 + 前端删除按钮（禁用态 tooltip / 二次确认 / 409 友好提示）。
2. **手册暴露**：REST `GET /api/strategies/guide`（text/markdown 全文）+ MCP `strategy_guide`
   工具（无参数；`strategy_tools_enabled` 开关同样生效）+ 前端编辑器文档侧栏与列表页帮助入口。

## 变更文件（已 git add，未 commit）

| 层 | 文件 | 变更 |
|---|---|---|
| design（事实源） | `design/02-domain/contracts.md` | `StrategyManageItem` 增 `deletable: bool`；`StrategyStore` 增 `delete_strategy` 契约（单语句语义 + 404/409 归属） |
| design | `design/04-storage/schema.md` | §4.3.13 补 deletable 标量子查询与 delete_strategy 单语句防竞态口径（纯散文，无 SQL 变更） |
| design | `design/07-app-plane/00-web-api.md` | §1.7 REST 表增 DELETE/guide 两行 + 删除规则裁决段；lib.rs 路由块增 guide 静态段与 `.delete()` |
| design | `design/07-app-plane/01-mcp.md` | §1.3 工具清单 + strategy_guide schema/dispatch/handler/测试（tools.rs、rpc.rs、mcp_protocol.rs 三处块） |
| design | `design/12-strategy-system/04-strategy-programming-guide.md` | **未改一字**；仅 `git add`（此前未跟踪，guide 端点 include_str! 依赖它） |
| domain | `crates/domain/src/ports.rs` | tangle 生成（contracts.md） |
| storage | `crates/storage/src/strategy.rs` | `delete_strategy` 实现；manage_list SQL 增 `NOT EXISTS … AS deletable` 列；ManageJoinRow + FromRow + into_item 同步 |
| storage | `crates/storage/tests/strategy_store.rs` | +3 测试（见测试矩阵）；新测试 id 前缀改 `x_` 避免与既有 `d_v1` 同进程撞键 |
| application | `crates/application/src/strategy.rs` | `StrategyService::delete_strategy`（get_strategy 探测 404 → 单语句删除 0 行 → 409「含已发布版本的策略不可删除，请归档」）；模块文档补职责行 |
| application | `crates/application/tests/strategy.rs` | MockStore 增 delete_strategy（锁内原子同语义）+ manage_list deletable；+5 服务测试 |
| application | `crates/application/tests/{workbench,simlive}.rs` | Mock StrategyStore 补 `delete_strategy` unimplemented!（trait 加法连带） |
| web | `crates/web/src/strategies.rs`（非 tangle 手写） | `guide` handler（include_str! + text/markdown; charset=utf-8）；`delete_strategy` handler（204/404/409） |
| web | `crates/web/src/lib.rs` | tangle 生成：`/api/strategies/guide` 先于 `{id}` 注册；`{id}` 路由增 `.delete()` |
| web | `crates/web/tests/api_strategies.rs` | +2 端点测试（删除 204/404/409 + deletable 字段；guide 全文 = design 字节） |
| mcp | `crates/mcp/src/{tools,rpc}.rs`、`crates/mcp/tests/mcp_protocol.rs` | tangle 生成（01-mcp.md） |
| 前端 | `web/src/api/types.ts` | `StrategyManageItem.deletable: boolean` |
| 前端 | `web/src/api/client.ts` | `ApiClient.deleteStrategy` + http 实现；`request` 增 204 无体容忍 |
| 前端 | `web/src/api/mock.ts` | manage mock 计算 deletable；`deleteStrategy` mock（404/409/级联删） |
| 前端 | `web/src/features/strategies/StrategiesPage.tsx` | 行内「删除」按钮（deletable=false 禁用 + tooltip 文案）+ confirm 二次确认 + 409 友好提示；页头「📖 完整编程手册」链接（_blank） |
| 前端 | `web/src/features/strategies/DocSidebar.tsx` | 侧栏顶部「📖 完整编程手册」链接（/api/strategies/guide，新窗口） |
| 前端 | `StrategiesPage.test.tsx` / `StrategyEditorPage.test.tsx` | +4/+1 测试 |

## 删除防竞态设计

- **单语句原子**：`DELETE FROM strategy WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM
  strategy_version WHERE strategy_id=$1 AND status<>'draft')`——守卫与删除同属一条语句，
  无「先 SELECT 后 DELETE」TOCTOU 窗口；并发 publish 在语句执行间隙到达 → 0 行命中不删。
- **级联**：draft 版本随 `ON DELETE CASCADE`（0022 既有）一并清除；published 行本被
  BEFORE DELETE trigger 拦截，NOT EXISTS 守卫与之同向双保险。
- **404/409 区分归 application**：先 `get_strategy`（None → 404 StrategyNotFound），再调端口；
  0 行 = 存在但含非 draft 版本（含并发漂移）→ 409 StrategyInvalidTransition，文案
  「含已发布版本的策略不可删除，请归档」。端口返回 `u64` 行数，不泄漏存在性判断到 SQL 层。

## 手册暴露方式

- 单一字节源：`include_str!("../../../design/12-strategy-system/04-strategy-programming-guide.md")`
  分别内嵌于 `crates/web/src/strategies.rs`（`STRATEGY_GUIDE`）与 mcp tools.rs（同名常量，
  tangle 自 01-mcp.md）——REST 与 MCP 同字节，web/mcp 测试均断言响应 == design 文件全文。
- REST：`GET /api/strategies/guide` → 200 text/markdown；不经 StrategyService（静态内容恒 200，
  未装配也不 503）；路由静态段 guide 先于 `{id}`（matchit 静态优先双保险）。
- MCP：`strategy_guide()` 无参数 → `{format:"markdown", guide:<全文>}`；不经 StrategyService，
  但 `strategy_tools_enabled=false` → isError（strategy_gate 前置，与 strategy_*/bt_* 同开关）。
- 前端：两处 `<a href="/api/strategies/guide" target="_blank" rel="noopener noreferrer">`（SPA 外直链，
  不经 router）。

## 测试矩阵（TDD：每层先 Red 后 Green）

| 层 | 测试 | 覆盖 |
|---|---|---|
| storage（strategy_store.rs，真实 DB） | `delete_strategy_all_draft_succeeds_and_cascades` | 全 draft 可删、版本级联清除、零版本可删 |
| storage | `delete_strategy_blocked_with_published_or_archived_history` | published → 0 行不删；published→archived 历史 → 0 行；未知 id → 0 行 |
| storage | `manage_list_deletable_flag` | published+draft=false / 仅 draft=true / 零版本=true / archived 历史=false |
| application（strategy.rs，mock store） | `delete_strategy_all_draft_ok_and_cascades` / `…_with_published_is_409` / `…_with_archived_history_is_409` / `…_unknown_id_is_404` / `…_zero_version_ok` | 服务语义 + 409 文案 + deletable 透传 |
| web（api_strategies.rs，真实 server+DB） | `delete_endpoint_all_draft_204_published_or_archived_409_unknown_404` | 204/404/409 全路径 + manage deletable 字段 + 409 文案 |
| web | `guide_endpoint_returns_markdown_full_text` | 200 + content-type text/markdown + 含 PARAMS_SCHEMA/ctx.position + == design 字节 |
| mcp（tools.rs 内测试 + mcp_protocol.rs） | `strategy_guide_returns_handbook_full_text` / `strategy_tools_gated_by_mcp_disable_switch`（增 strategy_guide 断言）/ schema 契约 33 工具 | 全文/关键字/未装配可用/开关停用 isError |
| 前端（vitest） | 删除按钮禁用态+tooltip / 确认流（取消不调 API、确认后删除刷新行消失）/ 409 友好提示 / 列表页+编辑器 guide 链接 | 5 新测试 |

## 验证

- `cargo build --workspace`：0 error 0 warning。
- `cargo test -p domain -p storage -p application -p web -p mcp -p app`：47 个测试目标全绿
  （storage 16 / application strategy 55+13+33+8 / web api_strategies 9 / mcp 43+2+3 …，0 failed）。
- `cargo clippy --workspace --all-targets`：0 warning。
- `entangled tangle` 连跑两次「Nothing to be done」——生成物与 design 源同步，无 diff。
- `cd web && npm run build`：0 error；`npm test`：45 文件 447 测试全绿。

## 遗留风险

1. **GitNexus 索引不可用**（LadybugDB 版本不匹配，数据库文件 v43 vs 工具 v40）：impact/
   detect_changes 无法执行。缓解：全部变更为加法（新 trait 方法/新字段/新端点/新工具），
   爆炸半径由 workspace 全量 build+test 覆盖验证。
2. **delete 404/409 竞态残留窗口**：get_strategy（存在性）与单语句 DELETE 之间存在极窄窗口
   （并发方在此间隙删除策略 → 本请求报 409 而非 404）。语义上可接受（409 提示「请归档」），
   裁决规则未要求消除。
3. `web/src/api/client.ts` 的 `request` 增 204 容忍为共享 helper 行为变更：此前无 204 端点
   使用该 helper（workbench preset DELETE 返回 200 JSON），无回归面。
4. 手册文件此前未被 git 跟踪，本次随变更一并 `git add`（未 commit）——若父级另有安排可摘除。
5. 未触碰红线：strategy-runtime/core/backtest/simlive 零改动；04 手册文件零改动；无新外部依赖。
