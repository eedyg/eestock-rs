# Tester 报告 006：Wave 1 验收测试（应用面 web/diagnose/MCP/SPA + 部署口径）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/006_wave1_acceptance.md`
> 验收人：tester agent（只验收不改码，缺陷只写复现报告）
> 依据：design/10-wave-plans/wave-1.md 验收节 + 任务书 Wave 1 验收项 1–8
> 验收时间：2026-09-04（周五，交易日）10:00–10:30 CST 盘中（09:30–11:30 上午盘内）
> 被验部署：commit `188edef`（HEAD）；容器 eestock-app(:8081/:8082, 启动 01:52:54Z)、eestock-data(:8080, 启动 09-03 14:34Z)、eestock-timescaledb(:5433)——三容器均 healthy
> 纪律遵守：全程零代码/零配置改动、零 docker prune/rm、无杀源演练；测试标的 510300 与复位请求已 SQL 清理并记录（见 §10）

## 0. 执行摘要

| # | 验收项 | 结果 | 一句话证据 |
|---|--------|------|-----------|
| 1 | 门禁（tangle/test/clippy/vitest+build） | ✅ PASS | tangle 无 diff；**144 passed/0 failed**；clippy 0 警告；vitest **130 passed**；build exit 0 |
| 2 | REST 端点实盘（kline merge 优先/游标分页/升序、symbols latest+with_stats、sources/health 排除 na） | ✅ PASS（附 2 缺陷观察） | 518880 五周期实时可查；merge 准确层优先实证（重叠分钟 API 出 tushare 准确值而非 raw）；latest 两次快照 02:02→02:04Z 前进；health 口径 na 出分母 |
| 3 | WS /ws 订阅 + 实时帧 + 断线重连 | ✅ PASS（附性能观察） | bar@02:06:00Z 于 02:06:17Z 收到；quote 实时；health 3s 节拍（45s 内 7 帧）；断连重连后恢复推送 |
| 4 | SPA / 与深链 + 防穿越 + 页面渲染 | ✅ **PASS（D2 修复后复验 2026-09-04 10:30 CST）** | 容器 :8081 /、/sources、/symbols、未知路由全 200 SPA（static_dir=/app/dist 生效）；穿越向量无泄露；chromium 无头渲染三页骨架+真实数据（见 §13） |
| 5 | symbols 写端点全链路（POST→数据面热生效→PATCH 停→SQL 清理） | ✅ PASS | POST 510300→201；**~85s 内 kline_raw 出现 199 行**（collector 日志 `fetch ok code=510300 inserted=199`，ADR-017 控制通道实证）；PATCH 停用后 ≥3 周期无新行；清理归零 |
| 6 | 熔断手动复位全链路 | ✅ **PASS（D1 干净部署后复验 2026-09-04 10:47 CST）** | POST reset→202；行 1.6s 被消费（ResetWatcher）；manual_reset 事件落库；未知源 skip+warn；痕迹已清（见 §13.4） |
| 7 | MCP SSE：initialize/tools/call/协议错误帧 | ✅ PASS | 全链路真数据返回；-32601/-32602/404/400 均符 |
| 8 | 三容器 compose 口径 | ✅ PASS | restart=unless-stopped×3；健康检查齐全且现均 healthy；depends_on 语义符合 ADR-017 隔离设计；`docker-compose config` 通过 |

**结论（最终）：8/8 全 PASS —— Wave 1 可收官。** D1/D2 部署偏差均已修复并经实盘复验闭环（#4 见 §13.1、#6 见 §13.4）。残余风险见 §11。

---

## 1. 验收项 1：门禁 —— ✅ PASS（独立复跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| tangle | `./scripts/check-tangle.sh` | ✅ `tangle 后无 diff`（entangled v2.4.3，见 /tmp/wave1_tangle.log） |
| 全量测试 | `cargo test --workspace` | ✅ **144 passed / 0 failed / 0 ignored**（满足任务书"144+"；含需 :5433 实库的集成测试；见 /tmp/wave1_cargotest.log） |
| lint | `cargo clippy --workspace --all-targets` | ✅ exit 0，0 warning / 0 error（/tmp/wave1_clippy.log） |
| 前端单测 | `npm test`（vitest run） | ✅ **130 passed（17 files）**（/tmp/wave1_vitest.log） |
| 前端构建 | `npm run build` | ✅ exit 0（dist/assets/index-*.js/css 产出，web/dist 10:01 重建） |

144 分布摘要（按测试二进制）：app 4（config_healthz 3 + app_config 1）；collector 33（probe 5/reset 2/circuit 4/executor 5/gapfill 3/scheduler 2/standby 6/calendar 2/lib 4）；domain contracts 13；mcp 4（protocol 2+tools_db 2）；providers golden 10 + http 4 + lib 部分；storage 17（accurate 2/event_sink 3/kline_reader 4/raw_writer 3/symbol_admin 3/symbols_registry 2）；tushare 22（daily_sync 11/golden 4/sync_plan 7）；web 5（api_admin 2/api_rest 2/ws_poller 1）；diagnose health_agg 4；等。

> ⚠️ 观察（披露）：`cargo test --workspace` 的集成测试直连实库 `127.0.0.1:5433/eestock`（各测试文件默认 URL），其中 `crates/web/tests/api_rest.rs` 会注册并自清理 code 996602——本次门禁运行顺带清理了 coder 遗留在 symbols 表的 **996602「测试ETF」残行**（验收前存在、验收后消失，见 §10.3），测试自身清理完整（996601/996602/web_test_src 残留计数均 0）。此为既有测试设计（自清），非本次缺陷。

## 2. 验收项 2：REST 端点实盘 —— ✅ PASS（附缺陷观察 D3/D4）

时段：10:00–10:05 CST 盘中实时抓取（REST 均在 127.0.0.1:8081）。

### 2.1 GET /api/kline（518880）
- **五周期实时可查**：1m 最新 bar `2026-09-04T02:01:00Z`（抓取时 wall 02:01:1x，即盘中实时）；5m/15m/1h/1d 均有数据，1d 含 09-03T16:00Z（=09-04 00:00 CST 日桶，盘中累计 volume 61,760,200）。
- **merge 准确层优先（DB+API 双层实证）**：`kline_merged` 视图 = `kline_accurate(period='M1') UNION ALL raw WHERE NOT EXISTS accurate`（pg_get_viewdef）。实证样本——09-03 07:00:00Z 重叠分钟：
  - accurate(tushare)：volume 3,478,000 / amount **31,667,190**
  - raw(tencent_ifzq)：amount **29,670**（同 ts 行）
  - API 1m 返回该分钟：amount **31,667,190、source=tushare** → 准确层优先生效、无重复 ts。
- **升序 + 游标分页**：limit=3 页内严格升序；`next_before` = 页首 ts（排他上界）；翻页 01:59→01:56 无重叠无缺口（delta=1 分钟精确续接）；`before=01:59` 只返回 ≤01:58；默认 limit=240。
- **校验**：非法 period → 400 `period 须为 1m/5m/15m/1h/1d`；未知 code → 200 空 bars（读端点放行语义）。
- **缺陷观察 D4（数据质量）**：当日（准确层未覆盖的分钟）REST 1m 直接暴露 raw 行，其中 tencent_ifzq 行的 amount ≈ volume×单价/1077（隐含单价 ~0.0085 元 vs 实际 ~9.2 元；510300 实测同签名）。证据：kline_raw 09-04 01:30Z 行 volume 5,311,100 / amount 45,350（正确量级应 ≈48.9M）；同表 sina_jsonp 行 amount 正常（1,612,500 股 → 14,825,898.6 元 ✓）。该签名跨 09-02/09-03/09-04 三天、518880/510300 两标的（日聚合隐含单价 min/max：tencent 0.008–0.0095 vs sina 8.9–9.2）。5m/15m/1h cagg 直接聚合 raw → amount 同比例低估（5m 01:35 桶 60,260 vs 应为 ~65M）。**准确层对已覆盖日（09-03 及以前）正确掩盖了该问题——ADR-003 语义本身工作正常；当日 raw 泄漏属数据面 Wave 0 侧问题在应用面表面的暴露**。复现路径完整，供后续裁定（建议归数据面/tencent 解析缺陷工单，Wave 1 不收口此项判定）。

### 2.2 GET /api/symbols 与 ?with_stats=1
- **latest 实时性**：两次连续快照（间隔约 100s，均为抓取时 wall 前 1 分钟内数据）：
  - 快照1（wall ~02:01:5xZ）：159337 latest ts=**02:02:00Z**
  - 快照2（wall ~02:03:3xZ）：159337 latest ts=**02:04:00Z**，且 44 个 code 中 42 个 latest ∈ {02:02–02:04Z}（盘中实时）；仅 2 个滞后（非本时段活跃标）。
- **with_stats=1**：顶层 `today_bars`（如 159337=35，盘中 01:30Z 开盘至 02:04Z 的 1m 数一致）；无今日行的 code=0。
- **缺陷观察 D3（性能）**：`/api/symbols`（含/不含 with_stats）稳定 **15–20s** 才返回（四次 curl 实测 19.5–20.3s）；app 自身 sqlx slow log 佐证：`symbols_with_latest`（LEFT JOIN LATERAL kline_merged）每条超 1s 阈值告警、elapsed 15–20s。该慢查询同时拖累 WS quote 订阅期 poller 节拍（见 §3）。触发面：页面③、WS quote。

### 2.3 GET /api/sources/health（成功率口径排除 na）
- 返回结构：window_secs=3600，sources 含 attempts/successes/success_rate/p50/p95/circuit_state/last_error/last_event_ts。
- 实盘样本：sina_jsonp attempts=829 successes=829 rate=1.0；tencent_ifzq attempts=620 successes=599 rate=0.966（窗口内 21 个 timeout 失败 + 期间 na 事件不计入分母）。
- 口径核对（只读代码 + 实盘）：diagnose::health `attempts = 非 na 事件数；successes = ok 且非 na`（na=源可达非交易时段，出分母）。实证：02:04:01Z 存在 tencent ok=true err_kind=na 事件，而 health 输出 rate=599/620 且 last_error=timeout → na 未计入失败。

## 3. 验收项 3：WS /ws —— ✅ PASS（附性能观察）

协议：`{"type":"subscribe","topic":"bar|quote|health",...}`；服务端推送平铺帧 `{"type":"bar"|"quote"|"health",...}`（设计见 crates/web/src/ws.rs）。用 Node22 内置 WebSocket 客户端连 `ws://127.0.0.1:8081/ws`（脚本 /tmp/wave1_evidence/ws_test.mjs）。

- **盘中实时帧**（02:05:37–02:06:17Z 订阅 bar(518880,1m)+quote(518880)+health）：收到 **bar@2026-09-04T02:06:00Z**（分钟滚点后 ~17s 内经 poller 推送）、**quote@02:06:00Z last=9.213**、**health**（nsrc=2）。
- **health 节拍**：health-only 订阅 45s 收到 **7 帧，帧间 3.0s**（与 ws_poll_ms=3000 一致；数据面事件推进时逐 tick 推）。
- **断线重连**：连接1（20s，6 帧）后关闭；连接2 重连并重订阅后恢复接收（3 帧，02:10:02–02:10:08Z）。注意：连接2 首帧前有 ~26s 静默——查 DB `source_health_events` 10s 桶，数据面事件流在 **02:09:27→02:10:09Z 存在 42s 空窗**（非 WS 缺陷，见 D5 观察），事件恢复后推送即恢复。
- **性能观察**：订阅 quote 时 poller 每轮调用 `symbols_with_latest`（§2.2 的 15–20s 慢查询），使 bar/health 推送节拍被拖到 ~20s/轮（app 日志 02:05:59/02:06:23 两条 slow symbols 语句正落在该窗口）。功能不受影响，节拍劣化与 D3 同源。

## 4. 验收项 4：SPA —— ❌ FAIL（as-deployed，部署偏差 D2）

- **容器实况**：`GET /`、`/sources`、`/symbols` 均 **HTTP 503**，body=`SPA 未构建：web/dist 缺失（前端 Wave 1 Phase B 产出）`；`/../` 与编码穿越同落 503（静态服务未启用，穿越面无法在容器侧实盘验证）。
- **根因复现（D2）**：容器内 `ls /app/dist` 存在（镜像 multi-stage frontend 产出，01:51Z 构建），而进程 CWD=`/`、生效配置 `static_dir="./web/dist"` → 解析 `/web/dist` 不存在。比对：入库模板 `config/app.toml.example` 为 `static_dir="/app/dist"`；**宿主本地 dev 配置 `config/app.toml`（`./web/dist`）经 compose volume 挂载进容器覆盖了容器语义** → 接线/配置缺陷。修复方向（未动）：容器挂载配置用 `/app/dist` 或 config 挂载区分 dev/prod。
- **前端本身可用性（补偿证据，非放行依据）**：
  1. `crates/web/tests/api_rest.rs` 集成测试覆盖「/ 与深链回退 index.html（body 含 eestock）＋ 穿越（`..%2F..` 不做解码→回退）」，本门禁 **2/2 绿**（从 repo 以 host dist 装配）。
  2. **无头渲染实证**：web `npm run build` 产物经 vite dev（VITE_PROXY_TARGET=:8081 同源代理真实后端）用 chromium headless `--dump-dom` 渲染三路由，DOM 均含预期 `data-region` 骨架且拉取到真实后端数据：
     - `/`：regions `dashboard/main-chart/sub-chart/symbol-list/toolbar/topbar/nav`（页面①）
     - `/sources`：regions `source-cards/summary-bar/gap-cards/alert-preview`（页面②）
     - `/symbols`：regions `symbol-table/table-toolbar`，DOM 含真实标的行 **518880**（来自 /api/symbols 实库数据）（页面③）
     证据文件：/tmp/wave1_evidence/dom_root.html、dom_sources.html、dom_symbols.html、shot_dash.png。
- **判定**：验收目标（正在运行的 app 容器）不满足「/ 与深链返回页面」→ FAIL；缺陷为部署接线（D2），代码/构建/渲染侧均已实证健康。

## 5. 验收项 5：symbols 写端点全链路 —— ✅ PASS

时序（盘中）：POST(02:12:44Z) → 数据面下一周期热生效(02:14:04Z) → PATCH 停用(02:14:56Z) → 停采确认(至 02:17:49Z) → SQL 清理(02:18Z)。

1. **POST 注册 510300**（name「沪深300ETF(验收临时)」interval 60s T1 enabled）→ 201 语义（含回读 dto，latest:null）；重复 POST → **409** `code 已注册`；坏 code(`12ab`)→**400**；北交所(`430047`)→**422**。
2. **数据面下一周期热生效（ADR-017 控制通道实证）**：POST 前 kline_raw 中 510300 计数=0；POST 后 **~85s**（02:14:04Z）collector 日志：
   `fetch ok code=510300 source=tencent_ifzq fetched=199 inserted=199`
   → kline_raw 出现 **199 行**（09-03 02:58Z 回填至 09-04 02:15Z 实时），并落 source_health_events（ok=true）。全程零重启、零数据面 API 直连 → 控制通道热生效闭环。
3. **PATCH 停用**：`PATCH /api/symbols/510300 {"enabled":false}` → 200 回读 `enabled:false`；其后 **≥3 个采集周期（02:15–02:17Z）kline_raw 510300 无新增行**（ts≥02:15 行数恒=1）→ 停用即时生效。
4. **清理（纪律记录）**：DELETE 端点未实现为定稿；用 SQL 直删测试标的并注明：
   `DELETE FROM symbols/kline_raw/source_health_events WHERE code='510300'`（1 + 199 + 2 行），清理后三表计数均 0 复核。

## 6. 验收项 6：熔断手动复位全链路 —— ❌ FAIL（as-deployed，部署偏差 D1）

执行（02:18:19Z）：
- `POST /api/sources/tencent_ifzq/reset` → **202** `{"status":"accepted"}`；`POST /api/sources/nope_source/reset`（未知源）→ 202（消费端应 skip+warn）。
- app 侧写通道正常：circuit_reset_requests 落 3 行（id 51–53，requested_at 02:18:19.30Z）。
- **消费端缺失**：等待 >5min，3 行 `consumed_at` 恒 NULL；source_health_events 无任何 `manual_reset` 事件（全表历史 0 条）；eestock-data 日志无 `circuit manual reset consumed`。
- **根因复现（D1）**：运行中 data 容器为 **Phase C 前镜像**（Created 09-03T08:57Z / Started 09-03T14:34Z），`strings /usr/local/bin/eestock-data | grep -c "circuit manual reset consumed"` = **0**（消费端代码不存在）；而 HEAD 代码 `crates/app/src/bin/eestock-data.rs:81-83` 已 spawn `collector::reset::run_forever(ResetWatcher)`（5s 轮询，49fc859 提交）。即：app 面已部署 Phase C+D，**data 镜像未随 49fc859 重建** → 控制通道有写无读。修复方向（未动）：`docker compose build data && docker compose up -d data` 后复验本项。
- 测试行已 SQL 清理（DELETE id 51–53，表归零，与验收前状态一致——验收前该表本为空）。

## 7. 验收项 7：MCP（HTTP/SSE :8082）—— ✅ PASS

Node 全链路（/tmp/wave1_evidence/mcp_test.mjs）：
1. `GET /sse` → 200 `text/event-stream`，首帧 `event: endpoint, data: /messages?sessionId=<32hex>`。
2. `POST /messages?sessionId=…` initialize → **202** + SSE `message` 帧：`result{capabilities.tools, protocolVersion:"2024-11-05", serverInfo{name:"eestock-mcp",version:"0.1.0"}}`。
3. `notifications/initialized` → 202（无响应帧，不悬挂）。
4. `tools/list` → `["get_kline","get_sources_health"]`。
5. `tools/call get_kline{code:518880,period:1m,limit:3}` → **真实 bar**（`ts 2026-09-04T02:17:00Z source sina_jsonp …`，盘中实时）。
6. `tools/call get_sources_health{}` → **真实聚合**（sina_jsonp attempts=1151 success_rate=1.0 circuit closed last_event_ts 02:19:12Z 等）。
7. **协议错误帧**：未知 method → 错误帧 `id:5 code:-32601 "method not found"`；未知工具 → `-32602 "未知工具"`；未知 sessionId POST → **404**；缺 sessionId → **400**。

## 8. 验收项 8：三容器 compose 口径 —— ✅ PASS

（docker-compose.yml 只读核对 + docker inspect/ps 实况）
- **restart**：三服务均 `unless-stopped`（inspect 实测）。
- **健康检查**：timescaledb `pg_isready -U eestock -d eestock`（5s/3s/12/10s）；data/app 用二进制自检 `--self-check`（运行镜像无 curl/wget，30s/5s/3/15s）——三项当前均 **healthy**（inspect State.Health）。
- **depends_on**：data→timescaledb（condition: service_healthy）；app→timescaledb（service_healthy），**app 不依赖 data**（注释明示故障隔离，符合 ADR-017 两平面解耦）。
- **配置校验**：`docker-compose config`（v1.29.2）通过（注：本机无 docker compose v2 插件，`docker compose` 子命令不存在——环境提示，非 compose 文件问题）。
- 端口/卷：5433/8080/8081/8082 映射、data.toml/app.toml 只读挂载、timescaledb 数据 bind `./data/timescaledb`、镜像 pin（timescaledb 2.29.2-pg16）均已核对。

## 9. 复现报告（缺陷/观察清单，不改码）

| # | 级别 | 现象 | 复现路径 | 归属推断 |
|---|------|------|----------|----------|
| D1 | 缺陷（部署） | 熔断复位链消费端缺失：reset 请求 202 后永不消费、无 manual_reset 事件 | POST /api/sources/{id}/reset → 查 circuit_reset_requests.consumed_at 恒 NULL；data 镜像 strings 无 ResetWatcher 标记 | data 镜像未随 49fc859 重建（部署滞后） |
| D2 | 缺陷（部署） | SPA 全路径 503「web/dist 缺失」 | 容器 config static_dir=`./web/dist`(CWD=/) vs 镜像 `/app/dist`；宿主 config/app.toml 挂载覆盖 | compose 挂载了 dev 语义 config，未用 /app/dist |
| D3 | 性能 | /api/symbols 15–20s；WS quote 订阅拖慢 poller 节拍 | 重复 GET /api/symbols；app slow log（elapsed 15–20s，阈值 1s） | symbols_with_latest 慢 SQL（应用面读路径） |
| D4 | 数据质量（数据面泄漏到应用面当日分钟） | kline_raw tencent_ifzq 行 amount ≈ volume×单价/1077（隐含单价 0.0085 vs 9.2 等） | 查 kline_raw 09-02/03/04 三日期指隐含单价聚合；REST 1m 当日分钟返回该错误 amount；5m/15m/1h cagg 同步低估 | tencent ifzq amount 解析/单位（Wave 0 数据面侧）；准确层掩盖只覆盖已同步日 |
| D5 | 观察 | 数据面健康事件流 42s 空窗（02:09:27→02:10:09Z） | source_health_events 10s 桶计数 | 数据面调度（Wave 0 范围，仅记录） |

## 10. 数据变更台账（纪律：全部 SQL 清理并注明）

1. POST/PATCH 生命周期标的 510300：注册 → 热生效（199 raw 行 + 2 事件）→ 停用 → **SQL 删除** symbols 1 + kline_raw 199 + source_health_events 2（`WHERE code='510300'`），清理后三表 0 行复核。**保留**：数据面为 510300 拉取产生的 09-03/09-04 历史回填行已随 kline_raw 删除一并清除（无残留）。
2. 复位请求测试行 id 51–53（tencent_ifzq×2 + nope_source×1）：**SQL 删除**（消费端缺失，不删会永挂 pending），表归零与验收前一致。
3. **既有残行 996602「测试ETF」**：验收前存在于 symbols（enabled，latest 停更于 09-03）——由本验收门禁 `cargo test` 的 web api_rest 集成测试自清理移除（其测试固定 code 即 996602）。已如实披露，非本次验收有意操作；残留计数 0。
4. 遗留既有状态未动：551000（空 name、enabled，backup_symbols.sql 可见的旧测试行）维持原状，仅记录。

## 11. 判定与残余风险

- **判定**：#1/#2/#3/#5/#7/#8 = PASS；#4/#6 = FAIL，且两者均定位为**部署偏差**（data 镜像滞后于 49fc859；app config 用 dev 语义 static_dir 挂载），非功能代码缺陷路径——对应功能均有 HEAD 代码与集成/单测绿证 + 无头渲染实证。**「Wave 1 可收官」暂不能判定**：需 parent/用户对 D1/D2 处置裁决（重建 data 镜像 + 容器配置改 /app/dist 或挂载 prod 语义 config），修复后复验 #4/#6 两项即可转全绿收官。
- **残余风险**：
  1. D4 影响面（tencent amount ~×1000）波及所有当日由 tencent_ifzq 服务的标的 1m/5m/15m/1h amount 列，历史已由 tushare 准确层掩盖；需数据面工单收口（超出 Wave 1 范围判定）。
  2. D3 使页面③/WS quote 体验受 15–20s 拖累，需应用面 SQL/索引优化工单。
  3. 本次验收窗口为单日盘中 ~30min；latest 空值/非交易时段语义、跨日 1d 完整收盘聚合未全覆盖（既有测试覆盖）。
  4. 本机无 `docker compose` v2（仅 docker-compose v1.29.2），compose 校验基于 v1。
  5. cargo test 集成测试与实库共用（自清设计），运行门禁会瞬时占用 symbols 表并清理其固定测试 code（已在 §10.3 披露，无残留）。

## 12. 证据文件索引

- 门禁日志：/tmp/wave1_tangle.log、/tmp/wave1_cargotest.log（144/0）、/tmp/wave1_clippy.log、/tmp/wave1_vitest.log（130）、/tmp/wave1_webbuild.log
- 请求证据：/tmp/wave1_evidence/symbols.json、symbols_stats.json（latest 两次快照/today_bars）、kline240.json、p1.json（分页）、dom_root/sources/symbols.html + shot_dash.png（无头渲染）、ws_test.mjs/ws_health_only.mjs/ws_reconnect2.mjs（WS 三探针输出见本报告 §3）、mcp_test.mjs（MCP 全链路输出见 §7）
- 容器证据：docker ps/inspect（healthy、restart、depends_on）、app slow log（D3）、data strings 无 ResetWatcher（D1）、`ls /app/dist`（D2）
- 本报告自身位置：见文件头。

## 13. D1/D2 修复后复验（2026-09-04 10:30–10:40 CST 追加；tester 会话续跑）

### 13.1 #4 SPA 复验 —— ✅ PASS（D2 闭环）

D2 修复（config/app.toml `static_dir=/app/dist` + app 容器 02:29:04Z 重启）后复验：

| 断言 | 证据 | 结果 |
|---|---|---|
| 静态目录生效 | app 启动日志 `eestock-app serving listen=0.0.0.0:8081 static_dir="/app/dist"`；容器内 `ls /app/dist/assets` 含 index-Bv4hk1Ao.js/css | ✅ |
| / 与深链 200 | `GET /`、`/sources`、`/symbols`、`/nonexistent-route` → 全部 HTTP 200，body=SPA index.html（`<title>eestock · 行情看板</title>` + root div + assets 引用） | ✅ |
| 防穿越 | 四个编码穿越向量 `..%2F..%2Fetc%2Fpasswd`、`/static/..%2F..`、`%2e%2e/%2e%2e`、`/assets/..%2F..%2Fapp.toml` → 全部回退 index.html，**无 /etc/passwd、无 app.toml 泄露** | ✅ |
| 真实资源 | `/assets/index-Bv4hk1Ao.js` → 200 (484,883B) | ✅ |
| 三页渲染（容器同源 chromium 无头） | `/`：regions dashboard/main-area/main-chart/nav/sub-chart/symbol-list/toolbar/topbar，symbol-list 含**真实行情**（518880 黄金ETF 2.431 +0.62% 等，data-up 样式）；`/sources`：regions source-cards/summary-bar/gap-cards/alert-preview + tencent/sina 卡含 success_rate 真实值；`/symbols`：regions symbol-table/table-toolbar + 真实标的行 518880。证据：/tmp/wave1_evidence/dom2_{root,sources,symbols}.html | ✅ |
| API 不被 SPA 吞 | `/api/sources/health` → 200 JSON（路由优先于静态回退） | ✅ |

新观察（backlog D6，不阻塞）：未匹配路径一律回退 index.html——`/api/nonexistent` 与 `/assets/nonexistent.js` 均 200 HTML 而非 404。SPA 回退应只作用于前端路由，/api/* 应 404（parent 已裁定 Wave 2 修，记录不阻塞）。

### 13.2 #6 复验阻塞记录 + 止血（D1 部署事故链）

1. **data 镜像重建完成**：`eestock-rs_data:latest` = 9aae5806036e（10:29:56 CST，含 ResetWatcher——cargo build RUN 完成）。
2. **`docker-compose up -d data` 崩溃**（10:30 CST，logs/data_rebuild.log 完整 traceback）：compose v1.29.2 `service.py:1579 get_container_data_volumes` → `KeyError: 'ContainerConfig'`——旧 data 容器镜像（f7ac0551cba7）为 BuildKit 产物、无 legacy `ContainerConfig` 字段（新/旧/app 三镜像同况实证），compose v1 recreate 合并卷时崩溃。
3. **事故形态**：旧容器被改名 `c3942400566a_eestock-data` 且 Exited(137)，新容器未创建，**数据面停机 02:30:06–02:34:26Z（~4.3 min，盘中）**。
4. **止血（parent 裁决 B，红线内 restart 授权）**：02:34:26Z `docker start c3942400566a_eestock-data`（旧镜像）→ 12s 内 healthy；采集恢复（fetch ok 84/90s）；**启动回填补齐停机缺口**（02:30–02:34Z 每分钟 42–44/44 行全覆盖实证）；tushare 调度器重排正确（next_run=10:00 UTC=18:00 CST，wait 26733s）。
5. **D1 干净部署待决（parent 上报用户中）**：A 方案需用户豁免红线（`docker rm c3942400566a_eestock-data` 残留碎片——compose 成功时本会自动移除）→ 随后 compose up 干净部署新镜像。豁免批复后执行 A 并复验 #6。
6. **#6 复验前置确认（app 侧仍就绪）**：app 容器 02:29:04Z 起 healthy，POST reset 写通道此前已验证正常（202 + circuit_reset_requests 落行）；待数据面含 ResetWatcher 后复验消费端。

### 13.3 台账更新
- 本段无 SQL 数据变更；无 docker prune/rm（红线遵守）；残留容器 c3942400566a_eestock-data 为 compose 崩溃碎片，处置待用户裁决。

### 13.4 #6 熔断手动复位复验 —— ✅ PASS（D1 闭环，2026-09-04 10:47–10:50 CST）

前置：用户澄清红线范围（eestock 自身 docker 归架构师照管）→ 残留容器已由架构师删除 → D1 干净部署完成：eestock-data 容器（新镜像 9aae5806036e，Started 02:45:51Z，RestartCount=0，healthy）；运行中二进制 ResetWatcher 标记实证（`grep -c "circuit manual reset consumed" /usr/local/bin/eestock-data` = 1）；采集恢复 + 启动回填补齐切换缺口（02:45–02:46Z 停机窗口 44/44 行/分钟实证）。测试基线：circuit_reset_requests=0、manual_reset 事件=0。

**复验时序（UTC）**：
| 步骤 | 时间 | 证据 |
|---|---|---|
| POST tencent_ifzq reset | 02:47:39 | `{"status":"accepted"}` **HTTP 202**；circuit_reset_requests 落行 id=54（requested_at 02:47:39.910Z） |
| ResetWatcher 消费 | 02:47:41.553 | 行 54 `consumed_at` 置位（**1.64s**，5s 轮询首拍） |
| manual_reset 事件落库 | 02:47:41.562 | source_health_events `tencent_ifzq ok=f err_kind=manual_reset`（数据面单写者） |
| 数据面日志 | 02:47:41.562 | INFO `circuit manual reset consumed source=tencent_ifzq request_id=54` |
| 未知源 skip 路径 | 02:47:59 | POST nope_source/reset → 202；行 55 消费 2.27s；WARN `reset request for unknown source skipped source=nope_source request_id=55`；无 manual_reset 事件（正确） |
| 采集无扰动 | 02:47–02:49 | sina 16 ok + tencent 18 ok 事件；kline_raw 实时推进 02:49:00Z（88 行/90s，盘中双源满速） |
| 清理 | 02:50 | DELETE 行 54/55 + 测试 manual_reset 事件（ts 02:47:41.562）；复核 circuit_reset_requests=0、manual_reset 事件=0（与测试前基线一致） |

**判定：PASS** —— 202 受理 → DB 控制通道 → ResetWatcher 5s 轮询消费（1.6s）→ manual_reset 事件落库（数据面单写者实证）→ 未知源 skip+warn → 采集零扰动 → 痕迹清零，全链路闭环（与 004/006 原始 FAIL 时"行永不消费"形成直接对比：D1 修复生效）。

### 13.5 Wave 1 收官结论（最终）

**8/8 全 PASS**：门禁(144/0+130/clippy 0) / REST / WS / SPA(#4 复验) / symbols 写链路 / 熔断复位(#6 复验) / MCP / compose 口径。D1（data 镜像滞后）与 D2（static_dir 接线）两部署偏差均已修复并经实盘复验闭环。**Wave 1 判定：可收官。** 残余风险与 backlog（D3 慢查询、D4 amount 量纲、D5 事件空窗、D6 SPA 回退过宽 → Wave 2）见 §11 与 §13.1，均不阻塞收官。
