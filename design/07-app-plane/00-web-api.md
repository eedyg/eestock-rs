# 07-app-plane / 00 — 应用面 Web API（web / diagnose / eestock-app / 部署）

> 本文档 tangle 生成：
> `crates/diagnose/src/{lib,health,quality}.rs`、`crates/diagnose/tests/{health_agg,quality}.rs`、
> `crates/storage/src/{reader,admin}.rs`、`crates/storage/tests/{kline_reader,symbol_admin}.rs`、
> `crates/web/src/{lib,dto,state,rest,ws,spa}.rs`、`crates/web/tests/{api_rest,ws_poller,api_admin,api_quality}.rs`、
> `crates/app/src/app_config.rs`、`crates/app/src/bin/eestock-app.rs`、`crates/app/tests/app_config.rs`、
> `Dockerfile.app`。
>
> 决策依据：ADR-017（部署双面分离：应用面与数据面零 API 直连，唯一耦合点 = TimescaleDB）、
> ADR-008（axum 栈）、ADR-010（免认证内网）、wave-1.md 2026-09-04 实施定稿（Phase A 后端）、
> Wave 1 Phase C 任务书（§8：symbols 写端点 + 熔断复位 DB 控制通道）。
>
> **数据面零改动**：collector/providers/tushare/storage 写入路径一行不动。仅有三处父级授权的加法扩展：
> ① `storage::reader`（只读查询模块，本节 §3）；② `app` crate 增加 `app_config` 模块与 `eestock-app` bin
> （`crates/app/src/lib.rs` 的 `pub mod app_config;` 声明维护在 design/03-collector/02-data-plane.md，
> 同理 `storage` lib.rs 的 `pub mod reader;` 声明维护在 design/04-storage/02-tushare-sync.md——均为纯加法）；
> ③ 无 domain 改动。
>
> 手写例外（不 tangle，README 既定口径）：`docker-compose.yml`（app 服务）、`config/app.toml.example`、
> 各 crate `Cargo.toml`、`.dockerignore`。
>
> ⚠️ 2026-09-04 审查返工记录（父级裁决，已执行）：
> ① **分层红线修复**——web 不再依赖 storage、diagnose 不再依赖 sqlx：domain::ports 增加只读端口
> `KlineRead` / `HealthEventsRead` + 读模型（KlineBarView / SymbolLatestView / HealthEventRow）
> （02-domain/contracts.md §2.4 纯加法）；storage 的 `KlineReader`/`HealthEventReader` 实现端口；
> diagnose 聚合下沉为纯函数 `aggregate_events`（口径不变）+ `HealthService` 端口注入；
> web handlers/Poller 只依赖 domain 端口与 diagnose 服务；storage/sqlx 仅在 web 的 dev-dependencies
> （集成测试装配与造数）。验证：`cargo tree -p web -e normal` 无 storage/sqlx、`-p diagnose` 无 sqlx。
> ② **Dockerfile.app 自包含**——新增 node:22 frontend 阶段（npm ci → npm run build），dist 由镜像内
> 构建产出，不再依赖构建上下文预存 dist；前端 dist 产物不入库（web/.gitignore 已含 dist/）。
>
> ⚠️ 2026-09-04 Phase D 加法（Wave 1 Phase D 任务书；全部口径见 design/07-app-plane/01-mcp.md）：
> `app_config.rs` +`mcp_listen`（默认 `0.0.0.0:8082`，env `MCP_LISTEN` 覆盖）、`eestock-app.rs` 装配
> MCP HTTP/SSE 服务（ADR-009 范围①②，与 web **同进程**、**端口独立** 8082，复用同一
> KlineRead/HealthEventsRead 端口实现实例）、`Dockerfile.app` `EXPOSE 8081 8082`——均为纯加法，
> web/diagnose/storage 既有块零改动。
>
> ⚠️ Wave 2 Phase B 加法（wave-2.md §2 页面⑦ 告警中心；全部口径见 design/07-app-plane/02-alerts.md）：
> `crates/web/src/alerts.rs`（handlers + AlertEvaluator，02-alerts.md tangle 生成，本文件 lib.rs 仅加法
> `pub mod alerts;` 与 3 条路由）、AppState +`alerts: alert::engine::AlertService`、WS Topic/PushMsg
> +`alert` 变体、`app_config.rs` +`alert_eval_ms`（默认 60000）、`eestock-app.rs` 装配 AlertService +
> AlertEvaluator 节拍任务——均为纯加法，既有端点/WS 通道/diagnose 零改动。

## 1. 端点契约

### 1.1 REST

| 方法/路径 | 参数 | 响应 | 数据源 | 错误态 |
|---|---|---|---|---|
| `GET /healthz` | — | `{"status":"ok"}` | 静态 | —（compose healthcheck 经 `--self-check` 调此路由） |
| `GET /api/kline` | `code`（必填）、`period=1m\|5m\|15m\|1h\|1d\|1w\|1mo`（默认 `1m`；看板 W1 增周 `1w`/月 `1mo`，回测周期不扩）、`before`（RFC3339 游标，不含该 ts 的更早一页）、`limit`（默认 240，封顶 1000） | `{"code","period","bars":[{ts,open,high,low,close,volume,amount,source?}],"next_before"}`；bars **升序**（图表口径）；`next_before`=本页最旧 ts，`null`=无更早数据 | 1m=`kline_merged` 合并视图（准确层优先，ADR-003）；5m/15m/1d=对应 cagg（ADR-004）；1h=`kline_15m` 查询期 rollup（schema 未建 kline_1h cagg，rollup 语义等价）；1w/1mo=`kline_accurate_1w/1mo`（0014 cagg）+`kline_1d` 查询期 rollup 兜底 | 400：`code` 空 / `period` 非法 / `before` 非 RFC3339；500 JSON `{"error":...}` |
| `GET /api/symbols` | — | `[{code,name,interval_secs,settlement,enabled,latest:{ts,last,change_pct}\|null}]`；`change_pct`=相对前一根 merge bar 收盘（%），无前值/无 bar → null | `symbols` + `kline_merged` 每 code 最近 2 根（LATERAL） | 500 |
| `GET /api/sources/health` | `window_secs`（默认 3600 = 页面② `SOURCES_DEFAULTS.successRateWindow='1h'`，钳制 60..604800） | `{"window_secs","sources":[{source,attempts,successes,success_rate,p50_ms,p95_ms,circuit_state,status,last_error,last_event_ts}]}`；`success_rate` 分母**排除 `err_kind='na'`**（03 §7），分母 0 → `null` | `source_health_events` 窗口聚合（diagnose crate，05-diagnose §1 口径） | 500 |
| `POST /api/symbols`（Phase C §8） | body `{code, name?, interval_secs?, settlement?, enabled?}`（缺省 interval=60 / settlement=T1 / enabled=true） | 201 `SymbolDto`（含 latest） | `symbols` 表写入（**DB 控制通道**：数据面 Scheduler 每周期重读热生效，无直连） | 400：code 非 6 位数字 / settlement 非法 / interval_secs<60；409：code 已注册；422：北交所前缀（4/8/920）拒绝「暂不支持」；500 |
| `PATCH /api/symbols/{code}`（Phase C §8） | body `{name?, interval_secs?, settlement?, enabled?}`（None=不改；code 主键不可改） | 200 `SymbolDto` | 同上，间隔修改下一采集周期热生效 | 400/422 同上；404：code 未注册；500 |
| `GET /api/symbols?with_stats=1`（Phase C §8） | `with_stats=1` 追加每标的当日统计 | 列表项追加 `today_bars`（当日 kline_raw 行数，Asia/Shanghai 日界；无 bar → 0） | `kline_raw` 当日窗口 GROUP BY | 500 |
| `GET /api/symbols`（看板收藏，Wave 3 页面①） | — | 列表项追加 `favorite: bool`、`favorite_sort: Option<i32>`；**收藏优先**（按 favorite_sort 升序，非收藏按原顺序在后）（注：仅影响 symbol-list 展示，不改变行情数据） | `symbols` + `kline_merged`（既有）+ `favorite_symbols`（0013，经 FavoriteStore.favorite_map 注入） | 500 |
| `POST /api/symbols/{code}/favorite`（看板收藏，Wave 3 页面①） | 路径 code | 200 幂等：已收藏再次收藏无副作用；未收藏则收藏并**自动置顶**（sort_order=max+1） | `favorite_symbols`（0013；应用面自有表，写不违 ADR-017） | 404：code 未注册；500 |
| `DELETE /api/symbols/{code}/favorite`（看板收藏，Wave 3 页面①） | 路径 code | 200 幂等：已收藏取消；未收藏（或不存在收藏）同样 200 无副作用 | 同上 | 404：code 未注册；500 |
| `PUT /api/symbols/favorites/order`（看板收藏，Wave 3 页面①） | body `{codes:[...]}` | 200：批量重排（sort_order=索引）；codes 顺序即收藏区展示顺序（可子集） | 同上 | 400：codes 含非已收藏 code；500 |
| `POST /api/sources/{id}/reset`（Phase C §8） | 路径 id = SourceId 文本（未知 id 也接受：应用面不知编译期源清单，数据面消费端跳过并告警） | 202 `{"status":"accepted"}`（**异步**：写 `circuit_reset_requests`，数据面 ResetWatcher ≤5s 内消费复位并发出 `manual_reset` 事件） | `circuit_reset_requests` 表（0007） | 400：id 空；500 |
| `GET /api/alerts`（Wave 2 Phase B） | `level=info\|warning\|critical`、`from`/`to`（RFC3339，last_fired_at 口径）、`source`、`limit`（默认 200，封顶 1000） | `[AlertEventDto]`（last_fired_at 降序；聚合防刷屏：同 rule+source 未恢复聚合一条，fire_count+last_fired_at） | `alert_events`（0009，应用面自有表） | 400：非法 level/from/to；500 |
| `POST /api/alerts/{id}/ack`（Wave 2 Phase B） | — | 200 `AlertEventDto`（status=acked + acked_at 持久化，刷新不丢） | 同上 | 404：未知 id 或非 triggered（仅未确认可确认）；500 |
| `GET /api/alert-rules`（Wave 2 Phase B） | — | `[AlertRuleDto]`（0009 种子 4 条内置规则，含阈值/开关/静默时长） | `alert_rules`（0009） | 500 |
| `PATCH /api/alert-rules`（Wave 2 Phase B） | body `{id, threshold?, enabled?, silence_minutes?}`（None=不改；仅这三项可调，无自由规则编辑器） | 200 `AlertRuleDto`（评估节拍每轮重读 → 热生效） | 同上 | 400：id 空 / silence_minutes<1 / threshold 非法；404：未知 id；500 |
| `GET /api/quality/divergence`（Wave 2 Phase A） | `code`（必填）、`from`/`to`（YYYY-MM-DD 必填，按 CST 日界闭区间，跨度钳制 ≤62 天）、`threshold_pct`（默认 0.5 = 页面④ `QUALITY_DEFAULTS.consistencyThresholdPct` 定稿口径） | `{"code","from","to","threshold_pct","summary":{"compared_bars","divergent_bars","divergence_rate","consistency_rate","max_deviation_pct"},"rows":[{"ts,raw_close,accurate_close,deviation_pct,raw_source}]}`；rows 按 \|偏差\| 降序；**只比 close**（D4 结案：amount 不跨层比对，04-storage §4.4 注记 7）；无比对数据 → rows 空 + summary 全 null/0 | `kline_raw ⋈ kline_accurate(period='M1')`（diagnose::quality） | 400：code 空 / from、to 非法或 from>to / threshold_pct 非正；500 |
| `GET /api/quality/source-accuracy`（Wave 2 Phase A） | `from`/`to`、`threshold_pct`（同上） | `{"from","to","threshold_pct","sources":[{"source,samples,consistency_rate,avg_deviation_pct,max_deviation_pct}]}`（一致率降序） | 同上（全标的对照行按 raw_source 归组） | 400/500 同上 |
| `GET /api/quality/gaps`（Wave 2 Phase A） | `code`（必填）、`from`/`to`（同上） | `{"code","from","to","days":[{"date","expected_bars","actual_bars","missing_bars","segments":[{"start","end","count","class"}]}]}`；仅含**有缺口的交易日**（周末 ∪ holidays[0008] 整日排除；未来分钟不算缺口）；start/end 为 CST "HH:MM"；class ∈ `source_fault`（窗口内有失败/陈旧/熔断事件）/ `upstream_no_data`（源可达但无该分钟数据：na 或仅成功事件）/ `system_gap`（邻近无事件：采集停摆/事件空窗，D5 口径） | 交易日历（0008 + 周末）× 241 分钟标签 − `kline_raw` 已有 ts；分类证据 = `source_health_events` 区间 | 400/500 同上 |
| `GET /api/tushare/status`（Wave 2 Phase A） | — | `{"checkpoints":[{"code,period,last_synced_date,updated_at}],"covered_codes","last_updated_at","last_event":{"ts","ok","err_kind"}\|null,"quota_remaining":null}`（积分余额未入库 → 恒 null，待 tushare 账户侧可查后单开） | `sync_checkpoints`（0005）+ `source_health_events` 最近 7 日 source='tushare' 事件 | 500 |
| `GET /api/config/ma`（看板 MA 可配置，后端 W1） | — | `{"windows":[5,10,20]}`（归一化升序去重；主图+宫格应用，回测弹窗不动） | `ma_config`（0015，应用面自有表；表空 → 默认 [5,10,20]） | 500 |
| `PUT /api/config/ma`（看板 MA 可配置，后端 W1） | body `{"windows":[5,10,20]}` | 200 `{"windows":[...]}`（校验+归一化升序去重后写回并返回） | 同上 | 400：1-3 条 / 每条 1-500 整数；500 |
| `GET /api/config/kline`（看板 K线默认视口，后端 W1） | — | `{"viewport_days":2}`（每周期实际 bar = 该周期每日 bar 数 × viewport_days；主图+宫格应用，回测弹窗不动） | `app_config`（0021，key="kline"；无键 → 默认 2） | 500 |
| `PUT /api/config/kline`（看板 K线默认视口，后端 W1） | body `{"viewport_days":10}` | 200 `{"viewport_days":10}`（校验后写回并返回） | 同上 | 400：viewport_days 1-50 整数（非整数/0/51 → 400）；500 |

字段口径（diagnose，05-diagnose §1 实现 Wave 1 最小集）：

- `circuit_state`：窗口内最近一条熔断迁移事件推导——`circuit_open`→`open`、`circuit_halfopen`→`half_open`、`circuit_closed`/`manual_reset`/无 → `closed`。
- `status` 状态灯：`open`→`circuit_open`；成功率 <95%→`degraded`；否则 `healthy`（非交易时段窗口内全 na → 分母 0 → `healthy`，源可达口径）。
- `last_error`：窗口内最近一条**非熔断迁移类**失败事件（`circuit_*`/`manual_reset` 不占最近错误位，它们是状态不是抓取错误）。
- `p50_ms`/`p95_ms`：窗口内 `ok=true` 且 `latency_ms` 非空事件的 `percentile_cont`（05 §1）。
- 窗口内无事件的源不出现在 `sources` 中（应用面不知编译期源清单；前端对缺失源按无数据渲染）。

### 1.2 WS `/ws`（订阅分发；断线指数退避重连由客户端负责，00-shell 既定）

客户端帧（JSON 文本帧，坏帧忽略——免认证内网 ADR-010）：

```json
{"type":"subscribe","topic":"bar","code":"518880","period":"1m"}
{"type":"unsubscribe","topic":"quote","code":"518880"}
```

- `topic`：`"bar" | "quote" | "health" | "alert"`（Wave 2 Phase B 加法）；`code`/`period` 省略 = 通配（该 topic 全量）。
- `bar` 订阅 `period` 必填（服务端据此决定轮询哪个周期）；`alert` 无需过滤字段（订阅即全量告警推送）。

服务端推送帧（serde 内部 tag，`type` 平铺）：

```json
{"type":"bar","code":"518880","period":"1m","bar":{ts,open,high,low,close,volume,amount,"source"?}}
{"type":"quote","code":"518880","ts":"...","last":1.234,"changePct":0.12}
{"type":"health","window_secs":3600,"sources":[SourceHealth...]}
{"type":"alert","id":12,"rule_id":"collection_stall","level":"critical","source":"collector","message":"...","status":"triggered","fire_count":1,"first_fired_at":"...","last_fired_at":"...","acked_at":null,"resolved_at":null}
```

- quote 帧载荷契约定稿：`last`/`changePct` 为 **camelCase**（与前端 store 读取、REST 客户端归一化后一致），
  `changePct` = 相对前一交易日收盘涨跌幅（%），无前值/无 bar → null。
- `alert` 帧（Wave 2 Phase B）：推送源 = **AlertEvaluator 评估节拍**（默认 1min，app_config `alert_eval_ms`），
  新建/续触发（fired）与恢复（resolved）事件逐一推送；info/warning 前端静默入列表，critical 由 shell 右上角 toast 强弹（07-alerts §4）。

**推送源 = 轮询**（ADR-017 铁律：应用面只读库，无数据面直连、无 NOTIFY 触发器）：Poller 按
`ws_poll_ms`（默认 3000）周期——对每个活跃 bar 订阅 (code,period) 取最新 bar，ts 前进才推；
任一 quote 订阅存在则推全量快照增量（连接侧按 code 过滤）；health 窗口聚合 `last_event_ts`
前进则整快照推。游标在 Poller 内存（进程级），重启重推一次最新值，无害。
broadcast lagged 丢帧由客户端重连/REST 重拉兜底。

### 1.3 SPA 静态托管

`web/dist` 存在即服务（按扩展名给 Content-Type）；未命中文件回退 `index.html`（history 路由深链）——
**例外（D6 结案，Wave 2 Phase A）**：任何 `/api` 前缀路径（含裸 `/api`）未命中**不回退** index.html，返回 404 JSON `{"error":"not found"}`
（API 路径回退 HTML 会把路由错误掩盖成前端解析错误，裸 `/api` 亦必须 404 而非回退 SPA 页）；路径含 `..`/反斜杠/空段 → 400（防目录穿越）；
dist 缺失 → 503 文本占位（Phase A 为占位页，Phase B 构建产物覆盖）。

**缓存头策略（SPA 缓存缺陷修复，Wave 2 收尾）**——根因：index.html 未设 Cache-Control，浏览器启发式缓存旧页 →
引用已替换的旧 bundle 哈希 → JS 404 → React 未挂载图空白。对策：
`index.html` 及一切**非哈希**静态 → `Cache-Control: no-store`（禁用启发式缓存，旧页每次重新验证/取新）；
**哈希**静态资产（`assets/<name>-<hash>.<ext>`，Vite 内容寻址产物，内容随哈希变化不可变）→
`Cache-Control: public, max-age=31536000, immutable`（可长期缓存，安全）。
判定规则：路径（相对 static_dir）位于 `assets/` 前缀且 basename 去扩展名后最后一个 `-` 分段长度 >= 8 → 视为哈希资产，
否则一律 `no-store`（保守回退：宁可不缓存，不缓存错）。
不引 tower-http：手写 ~60 行（ADR-017 最小攻击面同口径；零新增依赖）。

### 1.4 明确不做（边界）

**Phase A 不做**（Phase B/C 或 Wave 2）：`/api/sources/{id}/metrics|events|divergence`、
`/api/collection/gaps`、`/api/alerts*`（02-sources §8 / 03-symbols §6 所列其余端点）。
**Wave 2 Phase A 已交付**：`GET /api/quality/divergence|source-accuracy|gaps` + `GET /api/tushare/status`
（页面④ API 依赖节，06-web/04-quality.md §7）。
**Wave 2 Phase A 暂缓（待父级裁决）**：`POST /api/tushare/sync` 手动触发——需新增 DB 控制通道表 +
数据面 tushare 同步任务消费端（数据面改动超出本轮预批准范围「仅日历口径替换」，见 coder/report/011）。
**Wave 2 Phase B 已交付**：`/api/alerts*` + `GET/PATCH /api/alert-rules`（本节 §1.1 表尾四行，02-alerts.md）。
**Phase C 已交付**（§8）：`POST/PATCH /api/symbols`、`GET /api/symbols?with_stats=1`、
`POST /api/sources/{id}/reset`。
**不做物理删除**（03-symbols §4 定稿）：仅停用（`enabled=false`，历史数据保留），
无 `DELETE /api/symbols` 端点；物理删除仅限 DBA 手工 SQL，不在产品功能内。
WS topic 名采用任务书口径 `"health"`（02-sources 文档中 `"source_health"` 为同一通道，前端适配层映射）。

### 1.5 回测（Wave 3 Phase 3c；ADR 08-backtest §7）

> 本文档 tangle 生成 web 回测的**接口层声明**（路由 / DTO / 状态字段 / WS topic），但本 § 的
> `crates/web/src/backtest.rs`（REST handlers + `BacktestWsSink`）与 `crates/web/tests/api_backtest.rs`
> 为**非 tangle 手写**（ADR-007 例外：新功能模块/测试不纳入 tangle 块），契约描述在此、实际代码块不入本文档。
> 引擎/应用层在别处：`backtest` crate（纯逻辑，08-backtest/01-engine-adr.md，非 tangle）、
> `application::BacktestService`（非 tangle）、storage `BacktestBarReader`/`PgBacktestStore`
> （04-storage/schema.md，非 tangle）。本 § 只负责 REST/WS 接口与 app bin DI 装配。

#### REST

| 方法/路径 | 参数 | 响应 | 数据源 | 错误态 |
|---|---|---|---|---|
| `GET /api/backtest/strategies` | — | `[BacktestStrategyDto]`（id/name/description/params_schema，恰 7 款内置） | `BacktestService::strategies()`（backtest 注册表） | 500 |
| `POST /api/backtest/runs` | body `{code,period,from,to,strategy_id,params?,params_grid?,fee:{rate_pct,min_fee,slippage_bp},initial_capital?}` | 200 `{"run_id":N}` 或 `{"group_id":G,"run_ids":[N,...]}`（网格展开） | `BacktestService::submit`（入队，异步；限并发） | 400：code 空 / from、to 非 RFC3339 / period 非法（非 M1\|M5\|M15\|D1）/ fee 缺字段或非数值 / 无 params 且无 params_grid；404：strategy_id 未知；500 |
| `GET /api/backtest/runs` | `status=pending\|running\|done\|failed`、`group_id=G`、`limit`（默认 100，封顶 500）、`offset`（默认 0）（均可选） | `[BacktestRunDto]`（**轻量列表：不含 net_value/trades/metrics 结果列**；created_at DESC, id DESC 排序；`返回条数==limit` 表示还有更多，前端据此做分页） | `BacktestService::list_runs`（storage 走轻量 SELECT，无 LEFT JOIN backtest_results） | 400：status 非法；500 |
| `GET /api/backtest/runs/{id}` | — | `BacktestRunDto`（net_value/trades/metrics 完成才非 null） | `BacktestService::get_run` | 404：id 未知；500 |
| `DELETE /api/backtest/runs/{id}` | — | 200 `{"deleted":true}`（run 及其结果级联删除） | `BacktestService::delete_run`（store 删 run，FK 级联删 result） | 404：id 未知；500 |
| `GET /api/backtest/compare` | `ids=1,2,3`（逗号分隔必填） | `[BacktestRunDto]`（只含 store 存在的 run） | `BacktestService::compare` | 400：ids 空或含非数字；500 |

字段口径：`period` 取 `M1/M5/M15/D1`（支持周期间；`H1` 拒绝 400，08-backtest §3）。`from`/`to` 为 RFC3339，回测区间 `[from,to)`（B1 起持久化到 `backtest_runs.date_from/date_to`，`date_to` 存排除端点 `to`；`BacktestRunDto` 暴露 `initial_capital/date_from/date_to`，前端把 `date_from~date_to` 展示为区间）。`fee` 为用户可调 3 字段，`stamp_duty_pct` 由 application 层取 ADR bt-1 常量（0.05%）。`params` 单点（与 `params_grid` 二选一；网格场景作为公共基础参数），`params_grid` = `{k:"起:止:步长"}`（多键笛卡尔积展开 N 子任务，共享 `group_id`）。`BacktestRunDto.net_value` = `{series,drawdown}`（净值序列+回撤序列），`metrics`/`trades` 为 jsonb 直通（前端渲染）。

#### WS

新增订阅 topic `"backtest"`（客户端帧 `{"type":"subscribe","topic":"backtest","run_id":123}`；`run_id` 省略 = 通配全部回测进度）。服务端推送帧：

```json
{"type":"backtest_progress","run_id":123,"pct":50,"bar_ts":"..."}
```

推送源 = **application 层执行引擎的进度回调**（`BacktestService` 后台任务），经 `BacktestProgressSink`（web 实现 `BacktestWsSink`，持有 `WsHub`）发布 `PushMsg::BacktestProgress`；客户端按 `run_id` 订阅过滤。**无新增 Poller 轮询**——进度由引擎事件驱动（非库增量轮询）。`bar_ts` = 当前回测 bar 时刻（`current_ts`）。

#### DI（app bin §5）

`eestock-app.rs` 构造 `storage::backtest::BacktestBarReader(pool)` + `PgBacktestStore(pool)` + `web::backtest::BacktestWsSink(hub)` → `application::service::BacktestService::new(bar_read, store, sink, DEFAULT_MAX_CONCURRENT)` → 装入 `AppState.backtest` / `AppState.backtest_ws`。`web` crate 新增依赖 `application`（依赖方向：Presentation → Application → domain/backtest；app 为组合根）。并发上限用 `application::service::DEFAULT_MAX_CONCURRENT`（ADR §7 = 4），本期不开放配置（避免改动 config schema）。

### 1.6 模拟实盘（11-sim-live / L3b；ADR 11-sim-live §7/§8）

> 与 §1.5 同模式：本 § 的 `crates/web/src/simlive.rs`（REST handlers）为**非 tangle 手写**（ADR-007 例外），
> 契约描述在此、实际代码块不入本文档；`crates/web/src/lib.rs` 路由与 `crates/web/src/state.rs` 的 `AppState.sim`
> 字段为 tangle 加法；**MCP 与 web 共享同一 `SimLiveService` 实例**（app bin 把同一 Arc clone 装入 `AppState.sim` 与 `McpState.sim`）。
> 应用层在 `application::SimLiveService`（非 tangle）；storage `PgSimSessionStore`（迁移 0018，非 tangle）。

#### REST

| 方法/路径 | 参数 | 响应 | 数据源 | 错误态 |
|---|---|---|---|---|
| `GET /api/sim-live/state` | `?session_id=`（可选；缺省=当前运行会话） | `{active, session, account, positions, pnl, trading_enabled, mcp_enabled}`（当前会话聚合） | `SimLiveService::current_session_id` + `get_account`/`get_positions`/`get_pnl`/`trading_enabled`/`get_session`/`mcp_enabled` | 404：无运行会话；503：未配置；500 |
| `GET /api/sim-live/positions` | `?session_id=`（可选） | `{session_id, positions:[PositionView]}` | `SimLiveService::get_positions` | 同上 |
| `GET /api/sim-live/orders` | `?session_id=`（可选） | `{session_id, orders:[OrderView]}` | `SimLiveService::get_orders` | 同上 |
| `GET /api/sim-live/pnl` | `?session_id=`（可选） | `{session_id, pnl:PnlView}` | `SimLiveService::get_pnl` | 同上 |
| `GET /api/sim-live/strategies` | `?session_id=`（可选） | `{session_id, strategies:[{strategy_id,name,strongest:{code,score,signal}}], stocks:[StockEvaluation]}` | `SimLiveService::get_strategy_analysis` + `list_builtin_strategies`（名称映射） | 同上 |
| `GET /api/sim-live/sessions` | — | `[SessionListEntry]`（已结束附指标摘要；start_ts DESC） | `SimLiveService::list_sessions` | 503；500 |
| `GET /api/sim-live/sessions/{id}` | — | `SessionDetail`（元数据+结果） | `SimLiveService::get_session` | 404：未知 id；503；500 |
| `POST /api/sim-live/sessions/{id}/backtest-compare` | — | `BacktestCompareView`（session_result + run_ids） | `SimLiveService::run_backtest_compare` | 404：未知 id；400：区间无效；503；500 |
| `POST /api/sim-live/place-order` | body `{session_id?, code, side, qty, price, limit_price?, intent_id?, source?}`（`price`=模拟行情最新价） | 200 `{session_id, filled, fill}` 或 `{session_id, filled:false, fill:null, reason}` | `SimLiveService::place_order` | 400：side 非法/缺字段；404 无会话；503；500 |
| `POST /api/sim-live/cancel-order` | body `{session_id, order_id}` | `{session_id, order_id, cancelled}` | `SimLiveService::cancel_order` | 503；500 |
| `POST /api/sim-live/start-session` | body `{name, period, cash_init?, strategy_set?, stock_set?, source?}` | `{started:true, session:SimSessionView}` | `SimLiveService::start_session` | 400；503；500 |
| `POST /api/sim-live/stop-session` | body `{session_id?}` | `{session_id, stopped}` | `SimLiveService::stop_session` | 404 无会话；503；500 |
| `POST /api/sim-live/trading` | body `{enabled}` | `{session_id, trading_enabled}` | `SimLiveService::set_trading`（当前会话） | 404 无会话；503；500 |
| `POST /api/sim-live/mcp-toggle` | body `{enabled}` | `{mcp_enabled}` | `SimLiveService::set_mcp_enabled`（**共享实例**：关闭后 MCP sim_* 工具 isError） | 503；500 |

字段口径：`session_id` 缺省解析为**当前运行会话**（`SimLiveService::current_session_id`），历史回看必须显式传 id。
`strategies` 每策略的 `strongest` = 该策略独立分最高的 stock（供 strategy-panel）；`stocks` = 每 stock 的聚合+独立评分+信号（供 stock-scoring）。
`trading` 为统一交易开关（聚合评分→自动模拟单，作用于当前会话；无每策略开关）；`mcp-toggle` 共享 `SimLiveService` 的 `mcp_enabled`（web 开关即 MCP 服务开关）。

#### DI（app bin §5）

`eestock-app.rs` 已构造 `sim_service`（`application::simlive::SimLiveService::with_default_fee(PgSimSessionStore, SystemClock).with_backtest(backtest.clone()).with_kline(sim_kline.clone())`）；其中 `sim_kline = Arc::new(storage::reader::KlineReader::new(pool.clone()))`（实现 `domain::ports::KlineRead`，与 `state.kline` 同款/同库；持仓 latest/market_value 经行情源解析）。
本 § 加法：把**同一** `sim_service` Arc **也**装入 `AppState.sim`（原仅 `McpState.sim`），保证 web 与 MCP 共享同一实例（双通道一致性，ADR §7）。

## 2. diagnose crate：健康聚合查询（Application 层纯服务，端口注入）

分层红线：diagnose **不依赖 sqlx**。窗口事件经 `domain::ports::HealthEventsRead` 注入，
聚合逻辑为纯函数 `aggregate_events`（可离线 TDD）；`HealthService` 只做「读端口 → 纯函数」编排。
SQL 窗口读取下沉 storage（`HealthEventReader`），聚合口径与初版 SQL 版一致（测试锁定相同断言）。

``` {.rust file=crates/diagnose/src/lib.rs}
//! diagnose —— 应用层：健康指标聚合查询（读 source_health_events，03 §7 / 05 §1 口径）
//! 与数据质量服务（Wave 2 Phase A：raw vs accurate 对照 + 交易日历驱动缺口报告，本节 §2.1）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

/// crate 编译时版本（settings 页 system-info 展示；由 app 装配 CrateVersions）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod health;
pub mod quality;
```

``` {.rust file=crates/diagnose/src/health.rs}
//! 源健康窗口聚合（纯应用服务）：成功率（分母排除 err_kind='na'，03 §7）、延迟分位数、熔断态、最近错误。
//! 分层红线（Phase A 审查返工）：diagnose 不依赖 sqlx——窗口事件经 domain::ports::HealthEventsRead
//! 注入，聚合为纯函数（可离线 TDD；口径与初版 SQL 聚合一致，05 §1）。

use anyhow::Result;
use chrono::{DateTime, Utc};
use domain::ports::{HealthEventRow, HealthEventsRead};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// 熔断状态（由窗口内最近一条熔断迁移事件推导）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitState { Closed, HalfOpen, Open }

/// 状态灯（05 §1）：Healthy=无熔断且成功率≥95%（或无统计事件）；Degraded=<95%；CircuitOpen=熔断中。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusLight { Healthy, Degraded, CircuitOpen }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastError {
    pub err_kind: Option<String>,
    pub ts: DateTime<Utc>,
    pub code: Option<String>,   // 触发标的（源级事件为 None）
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceHealth {
    pub source: String,
    pub window_secs: i64,
    /// 成功率分母：窗口内非 na 事件数（03 §7：na=非交易时段可达，不入分母）。
    pub attempts: i64,
    pub successes: i64,
    /// attempts=0 → None（无统计意义，前端显示 —）。
    pub success_rate: Option<f64>,
    /// 延迟分位数：窗口内 ok=true 且 latency_ms 非空事件（05 §1；na 事件延迟照计）。
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub circuit_state: CircuitState,
    pub status: StatusLight,
    pub last_error: Option<LastError>,
    pub last_event_ts: Option<DateTime<Utc>>,
}

pub fn success_rate(successes: i64, attempts: i64) -> Option<f64> {
    if attempts <= 0 { None } else { Some(successes as f64 / attempts as f64) }
}

pub fn circuit_state_of(last_kind: Option<&str>) -> CircuitState {
    match last_kind {
        Some("circuit_open") => CircuitState::Open,
        Some("circuit_halfopen") => CircuitState::HalfOpen,
        // circuit_closed / manual_reset / 无迁移事件 → 闭合
        _ => CircuitState::Closed,
    }
}

pub fn status_of(circuit: CircuitState, rate: Option<f64>) -> StatusLight {
    match circuit {
        CircuitState::Open => StatusLight::CircuitOpen,
        _ => match rate {
            Some(r) if r < 0.95 => StatusLight::Degraded,
            _ => StatusLight::Healthy,
        },
    }
}

/// percentile_cont（PG 线性插值口径）：p∈[0,1]，空样本 → None。
pub fn percentile_cont(xs: &[f64], p: f64) -> Option<f64> {
    if xs.is_empty() { return None; }
    let mut v = xs.to_vec();
    v.sort_by(f64::total_cmp);
    let rank = p * (v.len() - 1) as f64;
    let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
    Some(v[lo] + (v[hi] - v[lo]) * (rank - lo as f64))
}

fn is_na(e: &HealthEventRow) -> bool { e.err_kind.as_deref() == Some("na") }

/// 熔断迁移类事件（circuit_* / manual_reset）：是状态不是抓取错误，不占 last_error 位。
fn is_circuit_migration(e: &HealthEventRow) -> bool {
    matches!(e.err_kind.as_deref(),
        Some("circuit_open") | Some("circuit_halfopen")
        | Some("circuit_closed") | Some("manual_reset"))
}

/// 窗口聚合纯函数（diagnose 唯一业务逻辑）：
/// 按 source 归组排序 → 计数（na 出分母）→ 分位数 → 熔断态（最近迁移事件）→ 最近非迁移错误。
pub fn aggregate_events(window_secs: i64, events: Vec<HealthEventRow>) -> Vec<SourceHealth> {
    let mut by_source: HashMap<String, Vec<HealthEventRow>> = HashMap::new();
    for e in events { by_source.entry(e.source.clone()).or_default().push(e); }
    let mut out: Vec<SourceHealth> = by_source.into_iter().map(|(source, mut evs)| {
        evs.sort_by_key(|e| e.ts);
        let attempts = evs.iter().filter(|e| !is_na(e)).count() as i64;
        let successes = evs.iter().filter(|e| e.ok && !is_na(e)).count() as i64;
        let lats: Vec<f64> = evs.iter()
            .filter(|e| e.ok && e.latency_ms.is_some())
            .map(|e| e.latency_ms.expect("filtered") as f64)
            .collect();
        let rate = success_rate(successes, attempts);
        let circuit = circuit_state_of(evs.iter().rev().find(|e| is_circuit_migration(e))
            .and_then(|e| e.err_kind.as_deref()));
        let last_error = evs.iter().rev()
            .find(|e| !e.ok && !is_circuit_migration(e))
            .map(|e| LastError { err_kind: e.err_kind.clone(), ts: e.ts, code: e.code.clone() });
        SourceHealth {
            source, window_secs, attempts, successes,
            success_rate: rate,
            p50_ms: percentile_cont(&lats, 0.5),
            p95_ms: percentile_cont(&lats, 0.95),
            circuit_state: circuit,
            status: status_of(circuit, rate),
            last_error,
            last_event_ts: evs.last().map(|e| e.ts),
        }
    }).collect();
    out.sort_by(|a, b| a.source.cmp(&b.source));
    out
}

/// 健康查询服务（Application）：注入只读端口；聚合全部走纯函数。
pub struct HealthService {
    reader: Arc<dyn HealthEventsRead>,
}

impl HealthService {
    pub fn new(reader: Arc<dyn HealthEventsRead>) -> Self { Self { reader } }

    /// REST /api/sources/health 与 WS health 推送共用入口。
    pub async fn aggregate(&self, window_secs: i64) -> Result<Vec<SourceHealth>> {
        let events = self.reader.window_events(window_secs).await?;
        Ok(aggregate_events(window_secs, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_rate_denominator_semantics() {
        assert_eq!(success_rate(2, 3), Some(2.0 / 3.0));
        assert_eq!(success_rate(0, 0), None, "窗口内无统计事件（全 na）→ None");
        assert_eq!(success_rate(0, 3), Some(0.0));
    }

    #[test]
    fn circuit_state_mapping() {
        assert_eq!(circuit_state_of(Some("circuit_open")), CircuitState::Open);
        assert_eq!(circuit_state_of(Some("circuit_halfopen")), CircuitState::HalfOpen);
        assert_eq!(circuit_state_of(Some("circuit_closed")), CircuitState::Closed);
        assert_eq!(circuit_state_of(Some("manual_reset")), CircuitState::Closed, "手动复位 → 闭合");
        assert_eq!(circuit_state_of(None), CircuitState::Closed);
    }

    #[test]
    fn status_light_matrix() {
        assert_eq!(status_of(CircuitState::Open, Some(1.0)), StatusLight::CircuitOpen);
        assert_eq!(status_of(CircuitState::HalfOpen, Some(0.99)), StatusLight::Healthy);
        assert_eq!(status_of(CircuitState::Closed, Some(0.94)), StatusLight::Degraded, "05 §1 边界 95%");
        assert_eq!(status_of(CircuitState::Closed, Some(0.95)), StatusLight::Healthy);
        assert_eq!(status_of(CircuitState::Closed, None), StatusLight::Healthy,
            "无统计事件（非交易时段全 na）不算降级");
    }

    #[test]
    fn percentile_cont_pg_linear_interpolation() {
        assert_eq!(percentile_cont(&[], 0.5), None);
        assert_eq!(percentile_cont(&[42.0], 0.95), Some(42.0));
        assert_eq!(percentile_cont(&[100.0, 300.0], 0.5), Some(200.0));
        assert_eq!(percentile_cont(&[100.0, 300.0], 0.95), Some(290.0),
            "与 PG percentile_cont 线性插值一致（rank=p*(n-1)）");
        // 乱序输入
        assert_eq!(percentile_cont(&[300.0, 100.0, 200.0], 0.5), Some(200.0));
    }
}
```

集成测试（需 TimescaleDB :5433；独立 source 名 + 前后清理，可重入）：

``` {.rust file=crates/diagnose/tests/health_agg.rs}
//! 健康窗口聚合测试（Phase A 返工：聚合为纯函数，无 DB；DB 读路径由 storage 端口测试锁定，
//! 端到端由 web 集成测试 /api/sources/health 锁定）。

use chrono::{Duration, TimeZone, Utc};
use diagnose::health::{aggregate_events, CircuitState, HealthService, SourceHealth, StatusLight};
use domain::ports::{HealthEventRow, HealthEventsRead};

fn ev_for(src: &str, secs_ago: i64, ok: bool, latency: Option<i32>, err: Option<&str>) -> HealthEventRow {
    HealthEventRow {
        ts: Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap() - Duration::seconds(secs_ago),
        source: src.into(), ok, latency_ms: latency, err_kind: err.map(Into::into), code: None,
    }
}

fn one<'a>(rows: &'a [SourceHealth], src: &str) -> &'a SourceHealth {
    rows.iter().find(|r| r.source == src).expect("聚合结果含测试源")
}

#[test]
fn success_rate_excludes_na_and_percentiles() {
    let src = "diag_test_rate";
    let mut events = vec![
        ev_for(src, 100, true, Some(100), None),
        ev_for(src, 90, true, Some(300), None),
        ev_for(src, 80, false, None, Some("timeout")),
    ];
    for i in 0..3 { events.push(ev_for(src, 70 - i, true, None, Some("na"))); }

    let rows = aggregate_events(3600, events);
    let h = one(&rows, src);
    assert_eq!(h.attempts, 3, "na 不入分母（03 §7）");
    assert_eq!(h.successes, 2);
    assert!((h.success_rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
    assert_eq!(h.p50_ms, Some(200.0));
    assert_eq!(h.p95_ms, Some(290.0), "percentile_cont 线性插值口径");
    assert_eq!(h.last_error.as_ref().unwrap().err_kind.as_deref(), Some("timeout"));
    assert_eq!(h.circuit_state, CircuitState::Closed);
    assert_eq!(h.status, StatusLight::Degraded, "0.667 < 0.95");
}

#[test]
fn circuit_state_from_latest_migration_and_last_error_excludes_migrations() {
    let src = "diag_test_circuit";
    let events = vec![
        ev_for(src, 50, false, None, Some("http")),
        ev_for(src, 40, false, None, Some("circuit_open")),
    ];
    let rows = aggregate_events(3600, events);
    let h = one(&rows, src);
    assert_eq!(h.circuit_state, CircuitState::Open);
    assert_eq!(h.status, StatusLight::CircuitOpen);
    assert_eq!(h.last_error.as_ref().unwrap().err_kind.as_deref(), Some("http"),
        "熔断迁移事件不占最近错误位（是状态不是抓取错误）");

    // 手动复位 → 闭合
    let events2 = vec![
        ev_for(src, 50, false, None, Some("http")),
        ev_for(src, 40, false, None, Some("circuit_open")),
        ev_for(src, 30, false, None, Some("manual_reset")),
    ];
    assert_eq!(one(&aggregate_events(3600, events2), src).circuit_state,
        CircuitState::Closed, "手动复位 → 闭合");
}

#[test]
fn healthy_when_all_ok_and_multi_source_sorted() {
    let events = vec![
        ev_for("b_src", 20, true, Some(80), None),
        ev_for("a_src", 20, true, None, None),
        ev_for("a_src", 10, true, Some(200), None),
    ];
    let rows = aggregate_events(3600, events);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].source, "a_src", "输出按 source 排序");
    assert_eq!(rows[1].source, "b_src");
    let a = one(&rows, "a_src");
    assert_eq!(a.success_rate, Some(1.0));
    assert_eq!(a.status, StatusLight::Healthy);
    assert_eq!(a.p50_ms, Some(200.0), "仅 ok 且带 latency 的事件计入分位数");
}

/// HealthService 经 domain 端口注入（mock 读端，证明 diagnose 与 storage 解耦）。
struct MockEvents(Vec<HealthEventRow>);

#[async_trait::async_trait]
impl HealthEventsRead for MockEvents {
    async fn window_events(&self, _window_secs: i64) -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn health_service_aggregates_via_injected_port() {
    let svc = HealthService::new(std::sync::Arc::new(MockEvents(
        vec![ev_for("mock_src", 10, true, Some(80), None)])));
    let rows = svc.aggregate(3600).await.unwrap();
    assert_eq!(one(&rows, "mock_src").success_rate, Some(1.0));
}
```

### 2.1 QualityService（Wave 2 Phase A 加法：数据质量对照 + 交易日历驱动缺口报告）

页面④（06-web/04-quality.md §7 API 依赖节）与 MCP④ 的数据源。与 health 同模式：
diagnose 不依赖 sqlx，全部读输入经 domain 端口注入（QualityRead / RawBarReader /
HealthEventsRangeRead / HolidayCalendarRead / TushareStatusRead），聚合与分类为纯函数（可离线 TDD）。

口径定稿：
- **分歧对照只比 close**（D4 结案：amount 跨层量纲不可比——tencent_ifzq raw amount 不可信且
  比值不恒定，无法换算，见 04-storage §4.4 注记 7）；默认阈值 0.5%（页面④ QUALITY_DEFAULTS 定稿）。
- **缺口 = 交易日历（周末 ∪ holidays[0008]）× 241 分钟标签 − kline_raw 已有 ts**；
  未来分钟不算缺口；与 collector 调度/回填同口径（domain::calendar 单一事实源）。
- **缺口分类（D5）**：source_fault（邻近窗口有失败/陈旧/熔断张开事件）/ upstream_no_data
  （na 或仅成功事件——源可达但该分钟无数据）/ system_gap（邻近无任何事件——采集停摆或事件空窗；
  非交易时段本就零事件[03 §9.9 静默跳过]，已被日历排除，不会误归此类）。

``` {.rust file=crates/diagnose/src/quality.rs}
//! 数据质量服务（Wave 2 Phase A，页面④ + MCP④；Application 层纯服务，端口注入，无 sqlx）。
//! 口径：本节 §2.1 头注释（close-only 对照 / 交易日历驱动缺口 / D5 三级分类）。

use anyhow::Result;
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Timelike, Utc};
use domain::calendar::{is_weekday, trading_minute_labels};
use domain::ports::{
    Clock, DivergenceRow, HealthEventRow, HealthEventsRangeRead, HolidayCalendarRead, QualityRead,
    RawBarReader, SyncCheckpointView, TushareStatusRead,
};
use domain::types::Code;
use domain::tz::{cst_to_utc, utc_to_cst};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// 默认分歧/一致阈值（%）：页面④ QUALITY_DEFAULTS.consistencyThresholdPct=0.5 定稿口径。
pub const DEFAULT_THRESHOLD_PCT: f64 = 0.5;
/// 日期跨度上限（天，含端点）：缺口逐日读库，防重查询。
pub const MAX_RANGE_DAYS: i64 = 62;

/// 偏差% = (raw − accurate) / accurate × 100；accurate≈0 防御（实盘不出现）：双≈0 → 0，否则 ±100。
pub fn deviation_pct(raw: f64, accurate: f64) -> f64 {
    if accurate.abs() < 1e-12 {
        return if raw.abs() < 1e-12 { 0.0 } else { 100.0 };
    }
    (raw - accurate) / accurate * 100.0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergenceItem {
    pub ts: DateTime<Utc>,
    pub raw_close: f64,
    pub accurate_close: f64,
    pub deviation_pct: f64,
    pub raw_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergenceSummary {
    pub compared_bars: i64,
    pub divergent_bars: i64,
    /// 分歧率 = |偏差|>threshold 的 bar 占比；无比对样本 → None。
    pub divergence_rate: Option<f64>,
    /// 一致率 = |偏差|≤threshold 占比（页面④「≤0.5% 计一致」同口径，threshold 可调）。
    pub consistency_rate: Option<f64>,
    pub max_deviation_pct: Option<f64>,
}

/// 分歧报告：rows 按 |偏差| 降序（页面④ 默认排序）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergenceReport {
    pub summary: DivergenceSummary,
    pub rows: Vec<DivergenceItem>,
}

/// 对照行 → 分歧报告（纯函数）。
pub fn summarize(rows: Vec<DivergenceRow>, threshold_pct: f64) -> DivergenceReport {
    let mut items: Vec<DivergenceItem> = rows.into_iter().map(|r| DivergenceItem {
        ts: r.ts,
        raw_close: r.raw_close,
        accurate_close: r.accurate_close,
        deviation_pct: deviation_pct(r.raw_close, r.accurate_close),
        raw_source: r.raw_source,
    }).collect();
    items.sort_by(|a, b| b.deviation_pct.abs().total_cmp(&a.deviation_pct.abs()));
    let n = items.len() as i64;
    let divergent = items.iter().filter(|i| i.deviation_pct.abs() > threshold_pct).count() as i64;
    DivergenceReport {
        summary: DivergenceSummary {
            compared_bars: n,
            divergent_bars: divergent,
            divergence_rate: if n > 0 { Some(divergent as f64 / n as f64) } else { None },
            consistency_rate: if n > 0 { Some((n - divergent) as f64 / n as f64) } else { None },
            max_deviation_pct: items.first().map(|i| i.deviation_pct.abs()),
        },
        rows: items,
    }
}

/// 源一致率排行卡（页面④ accuracy-cards；一致率降序，平手按 source 名序）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceAccuracy {
    pub source: String,
    pub samples: i64,
    pub consistency_rate: Option<f64>,
    pub avg_deviation_pct: Option<f64>,
    pub max_deviation_pct: Option<f64>,
}

/// 对照行按 raw_source 归组的一致率统计（纯函数）。
pub fn accuracy_by_source(rows: &[DivergenceRow], threshold_pct: f64) -> Vec<SourceAccuracy> {
    let mut by: HashMap<String, Vec<f64>> = HashMap::new();
    for r in rows {
        by.entry(r.raw_source.clone().unwrap_or_else(|| "unknown".into()))
            .or_default()
            .push(deviation_pct(r.raw_close, r.accurate_close).abs());
    }
    let mut out: Vec<SourceAccuracy> = by.into_iter().map(|(source, devs)| {
        let n = devs.len() as i64;
        let consistent = devs.iter().filter(|d| **d <= threshold_pct).count() as i64;
        SourceAccuracy {
            source,
            samples: n,
            consistency_rate: Some(consistent as f64 / n as f64),
            avg_deviation_pct: Some(devs.iter().sum::<f64>() / devs.len() as f64),
            max_deviation_pct: devs.iter().cloned().reduce(f64::max),
        }
    }).collect();
    out.sort_by(|a, b| b.consistency_rate.partial_cmp(&a.consistency_rate)
        .unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.source.cmp(&b.source)));
    out
}

/// 缺口分类（D5 口径，三级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GapClass { SourceFault, UpstreamNoData, SystemGap }

/// 失败证据类 err_kind（抓取失败/陈旧/熔断张开——源故障时段）。
/// circuit_closed/manual_reset 是恢复不是故障，不列入。
const FAULT_KINDS: &[&str] = &["timeout", "http", "parse", "rate_limited", "all_failed",
    "stale_data", "circuit_open", "circuit_halfopen"];

/// 缺口分钟分类（纯函数）：邻近事件窗口内——
/// ① 有失败证据 → SourceFault（源故障时段）；
/// ② 有 na（源可达无数据）或成功事件 → UpstreamNoData；
/// ③ 无任何事件 → SystemGap（采集停摆/事件空窗；非交易日已由日历排除，不会误归此类）。
pub fn classify_gap_minute(nearby: &[&HealthEventRow]) -> GapClass {
    if nearby.iter().any(|e| !e.ok
        && e.err_kind.as_deref().map(|k| FAULT_KINDS.contains(&k)).unwrap_or(false)) {
        return GapClass::SourceFault;
    }
    if nearby.iter().any(|e| e.ok || e.err_kind.as_deref() == Some("na")) {
        return GapClass::UpstreamNoData;
    }
    GapClass::SystemGap
}

/// 缺口段（连续同分类分钟合并；start/end = CST naive 标签时刻，含端点；count = 缺 bar 数）。
/// 午休两侧不跨段（11:30 → 13:01 标签差 91min > 1min，自然断段）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GapSegment {
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    pub count: i64,
    pub class: GapClass,
}

/// CST 标签 → "HH:MM"（页面④ 缺口段展示口径）。
pub fn hhmm(t: &NaiveDateTime) -> String { format!("{:02}:{:02}", t.hour(), t.minute()) }

/// 缺口分钟（CST naive，升序，带分类）→ 连续段（纯函数）。
pub fn segments_of(missing: &[(NaiveDateTime, GapClass)]) -> Vec<GapSegment> {
    let mut out: Vec<GapSegment> = vec![];
    for (m, class) in missing {
        match out.last_mut() {
            Some(seg) if seg.class == *class && *m - seg.end == Duration::minutes(1) => {
                seg.end = *m;
                seg.count += 1;
            }
            _ => out.push(GapSegment { start: *m, end: *m, count: 1, class: *class }),
        }
    }
    out
}

/// 单日缺口卡（仅当日有缺口时由 gaps() 产出）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayGap {
    pub date: NaiveDate,
    /// 应到 bar 数 = 已到期标签数（当日盘中为部分，历史日为 241）。
    pub expected_bars: i64,
    pub actual_bars: i64,
    pub missing_bars: i64,
    pub segments: Vec<GapSegment>,
}

/// tushare 最近事件视图（source_health_events source='tushare'；skip 审计 ok=true+na 也算可达证据）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TushareEventView {
    pub ts: DateTime<Utc>,
    pub ok: bool,
    pub err_kind: Option<String>,
}

/// 页面④ sync-panel 状态（quota 未入库 → 由 web 层恒置 null，见 §1.1）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TushareStatus {
    pub checkpoints: Vec<SyncCheckpointView>,
    pub covered_codes: usize,
    pub last_updated_at: Option<DateTime<Utc>>,
    pub last_event: Option<TushareEventView>,
}

/// MCP④ 单日质量卡（get_data_quality(code, date)）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DailyQuality {
    pub code: String,
    pub date: NaiveDate,
    pub trading_day: bool,
    /// 当日缺口卡（无缺口 / 非交易日 / 当日尚无到期标签 → None）。
    pub gap: Option<DayGap>,
    pub divergence: DivergenceSummary,
}

/// 范围校验（web/MCP 共用）：from<=to 且跨度 ≤ MAX_RANGE_DAYS。
pub fn validate_range(from: NaiveDate, to: NaiveDate) -> Result<()> {
    if from > to { anyhow::bail!("from 不得晚于 to"); }
    if (to - from).num_days() + 1 > MAX_RANGE_DAYS {
        anyhow::bail!("日期跨度上限 {MAX_RANGE_DAYS} 天");
    }
    Ok(())
}

/// 日期闭区间 [from, to]（CST 日界）→ UTC 半开区间 [from 00:00 CST, to+1 00:00 CST)。
pub fn day_range_utc(from: NaiveDate, to: NaiveDate) -> (DateTime<Utc>, DateTime<Utc>) {
    (cst_to_utc(from.and_hms_opt(0, 0, 0).expect("valid hms")),
     cst_to_utc((to + Duration::days(1)).and_hms_opt(0, 0, 0).expect("valid hms")))
}

/// 质量查询服务（Application）：注入只读端口；聚合/分类全部走纯函数。
/// Clone 派生：eestock-app 装配时 web/mcp 两状态共享同一组端口实例。
#[derive(Clone)]
pub struct QualityService {
    quality: Arc<dyn QualityRead>,
    raw: Arc<dyn RawBarReader>,
    events: Arc<dyn HealthEventsRangeRead>,
    holidays: Arc<dyn HolidayCalendarRead>,
    tushare: Arc<dyn TushareStatusRead>,
    clock: Arc<dyn Clock>,
}

impl QualityService {
    pub fn new(quality: Arc<dyn QualityRead>, raw: Arc<dyn RawBarReader>,
               events: Arc<dyn HealthEventsRangeRead>, holidays: Arc<dyn HolidayCalendarRead>,
               tushare: Arc<dyn TushareStatusRead>, clock: Arc<dyn Clock>) -> Self {
        Self { quality, raw, events, holidays, tushare, clock }
    }

    /// GET /api/quality/divergence 数据源。
    pub async fn divergence(&self, code: &str, from: NaiveDate, to: NaiveDate,
                            threshold_pct: f64) -> Result<DivergenceReport> {
        validate_range(from, to)?;
        let (lo, hi) = day_range_utc(from, to);
        let rows = self.quality.divergence_rows(Some(code), lo, hi).await?;
        Ok(summarize(rows, threshold_pct))
    }

    /// GET /api/quality/source-accuracy 数据源。
    pub async fn source_accuracy(&self, from: NaiveDate, to: NaiveDate,
                                 threshold_pct: f64) -> Result<Vec<SourceAccuracy>> {
        validate_range(from, to)?;
        let (lo, hi) = day_range_utc(from, to);
        let rows = self.quality.divergence_rows(None, lo, hi).await?;
        Ok(accuracy_by_source(&rows, threshold_pct))
    }

    /// GET /api/quality/gaps 数据源：仅返回有缺口的交易日（非交易日整日排除）。
    pub async fn gaps(&self, code: &str, from: NaiveDate, to: NaiveDate) -> Result<Vec<DayGap>> {
        validate_range(from, to)?;
        let holidays = self.holidays.holidays().await?;
        let (lo, hi) = day_range_utc(from, to);
        let evs = self.events.events_between(lo, hi).await?;
        // 缺口分类证据：该 code 事件 ∪ 源级事件（code=None，如 circuit_open 影响全部标的）
        let code_events: Vec<&HealthEventRow> = evs.iter()
            .filter(|e| e.code.as_deref() == Some(code) || e.code.is_none()).collect();
        let now_floor = {
            let c = utc_to_cst(self.clock.now());
            c.with_second(0).and_then(|t| t.with_nanosecond(0)).expect("valid minute floor")
        };
        let mut out = vec![];
        let mut day = from;
        while day <= to {
            if is_weekday(day) && !holidays.contains(&day) {
                let due: Vec<NaiveDateTime> = trading_minute_labels(day).into_iter()
                    .filter(|l| *l <= now_floor).collect();
                if !due.is_empty() {
                    let existing = self.raw.existing_ts(&Code(code.into()), day).await?;
                    let missing: Vec<(NaiveDateTime, GapClass)> = due.iter()
                        .filter(|l| !existing.contains(&cst_to_utc(**l)))
                        .map(|l| {
                            let wlo = cst_to_utc(*l - Duration::minutes(2));
                            let whi = cst_to_utc(*l + Duration::minutes(2));
                            let nearby: Vec<&HealthEventRow> = code_events.iter()
                                .filter(|e| e.ts >= wlo && e.ts < whi).copied().collect();
                            (*l, classify_gap_minute(&nearby))
                        }).collect();
                    if !missing.is_empty() {
                        out.push(DayGap {
                            date: day,
                            expected_bars: due.len() as i64,
                            actual_bars: (due.len() - missing.len()) as i64,
                            missing_bars: missing.len() as i64,
                            segments: segments_of(&missing),
                        });
                    }
                }
            }
            day += Duration::days(1);
        }
        Ok(out)
    }

    /// GET /api/tushare/status 数据源（最近事件窗口 7 天）。
    pub async fn tushare_status(&self) -> Result<TushareStatus> {
        let cps = self.tushare.sync_checkpoints().await?;
        let now = self.clock.now();
        let evs = self.events.events_between(now - Duration::days(7), now).await?;
        let last_event = evs.iter().rev().find(|e| e.source == "tushare")
            .map(|e| TushareEventView { ts: e.ts, ok: e.ok, err_kind: e.err_kind.clone() });
        Ok(TushareStatus {
            covered_codes: cps.len(),
            last_updated_at: cps.iter().map(|c| c.updated_at).max(),
            checkpoints: cps,
            last_event,
        })
    }

    /// MCP 工具④ get_data_quality(code, date)：单日质量卡（缺口 + 分歧汇总）。
    pub async fn daily_quality(&self, code: &str, date: NaiveDate) -> Result<DailyQuality> {
        let holidays = self.holidays.holidays().await?;
        let trading = is_weekday(date) && !holidays.contains(&date);
        let gap = self.gaps(code, date, date).await?.into_iter().next();
        let div = self.divergence(code, date, date, DEFAULT_THRESHOLD_PCT).await?;
        Ok(DailyQuality {
            code: code.into(), date, trading_day: trading,
            gap, divergence: div.summary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }
    fn ndt(day: NaiveDate, h: u32, mi: u32) -> NaiveDateTime { day.and_hms_opt(h, mi, 0).unwrap() }
    fn row(ts: DateTime<Utc>, raw: f64, acc: f64, src: &str) -> DivergenceRow {
        DivergenceRow { ts, code: "518880".into(), raw_close: raw, accurate_close: acc,
            raw_source: Some(src.into()) }
    }
    fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

    #[test]
    fn deviation_pct_guards_and_sign() {
        assert!((deviation_pct(10.1, 10.0) - 1.0).abs() < 1e-9);
        assert!((deviation_pct(9.9, 10.0) + 1.0).abs() < 1e-9);
        assert_eq!(deviation_pct(0.0, 0.0), 0.0, "双零防御");
        assert_eq!(deviation_pct(1.0, 0.0), 100.0, "accurate 零防御（不产出 inf/nan，JSON 安全）");
    }

    #[test]
    fn summarize_rates_and_deviation_desc_order() {
        let rows = vec![
            row(base(), 10.04, 10.0, "tencent_ifzq"),        // +0.4% ≤0.5 一致
            row(base() + Duration::minutes(1), 9.90, 10.0, "sina_jsonp"), // −1.0% 分歧
            row(base() + Duration::minutes(2), 10.20, 10.0, "sina_jsonp"), // +2.0% 分歧
        ];
        let rep = summarize(rows, 0.5);
        assert_eq!(rep.summary.compared_bars, 3);
        assert_eq!(rep.summary.divergent_bars, 2, "|偏差|>0.5% 计分歧");
        assert!((rep.summary.divergence_rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
        assert!((rep.summary.consistency_rate.unwrap() - 1.0 / 3.0).abs() < 1e-9);
        assert!((rep.summary.max_deviation_pct.unwrap() - 2.0).abs() < 1e-9);
        assert!((rep.rows[0].deviation_pct - 2.0).abs() < 1e-9, "默认 |偏差| 降序");
        assert!((rep.rows[1].deviation_pct + 1.0).abs() < 1e-9);
        assert_eq!(rep.rows[2].raw_source.as_deref(), Some("tencent_ifzq"));
        // 空样本
        let empty = summarize(vec![], 0.5);
        assert_eq!(empty.summary.compared_bars, 0);
        assert!(empty.summary.divergence_rate.is_none() && empty.summary.consistency_rate.is_none()
            && empty.summary.max_deviation_pct.is_none(), "无比对数据 → 汇总全 None（前端空态）");
    }

    #[test]
    fn accuracy_by_source_grouped_and_sorted() {
        let rows = vec![
            row(base(), 10.001, 10.0, "tencent_ifzq"),
            row(base() + Duration::minutes(1), 10.0, 10.0, "tencent_ifzq"),
            row(base() + Duration::minutes(2), 10.10, 10.0, "sina_jsonp"),   // 1.0% 分歧
            row(base() + Duration::minutes(3), 10.0, 10.0, "sina_jsonp"),
        ];
        let acc = accuracy_by_source(&rows, 0.5);
        assert_eq!(acc.len(), 2);
        assert_eq!(acc[0].source, "tencent_ifzq", "一致率降序");
        assert_eq!(acc[0].consistency_rate, Some(1.0));
        assert_eq!(acc[1].source, "sina_jsonp");
        assert_eq!(acc[1].consistency_rate, Some(0.5));
        assert!((acc[1].avg_deviation_pct.unwrap() - 0.5).abs() < 1e-9);
        assert!((acc[1].max_deviation_pct.unwrap() - 1.0).abs() < 1e-9);
        assert_eq!(acc[1].samples, 2);
    }

    fn ev(ts: DateTime<Utc>, ok: bool, kind: Option<&str>) -> HealthEventRow {
        HealthEventRow { ts, source: "tencent_ifzq".into(), ok, latency_ms: None,
            err_kind: kind.map(Into::into), code: Some("518880".into()) }
    }

    #[test]
    fn classify_gap_minute_matrix() {
        let t0 = base();
        // ① 失败证据优先（timeout / stale_data / all_failed / circuit_open 均属源故障）
        for k in ["timeout", "http", "parse", "rate_limited", "all_failed", "stale_data",
                  "circuit_open", "circuit_halfopen"] {
            let e = ev(t0, false, Some(k));
            assert_eq!(classify_gap_minute(&[&e]), GapClass::SourceFault, "{k} 属源故障");
        }
        // ② na / 成功事件 → 源可达无数据
        let na = ev(t0, true, Some("na"));
        assert_eq!(classify_gap_minute(&[&na]), GapClass::UpstreamNoData);
        let ok = ev(t0, true, None);
        assert_eq!(classify_gap_minute(&[&ok]), GapClass::UpstreamNoData);
        // 恢复类迁移不占故障位
        let closed = ev(t0, false, Some("circuit_closed"));
        let reset = ev(t0, false, Some("manual_reset"));
        assert_eq!(classify_gap_minute(&[&closed]), GapClass::SystemGap,
            "circuit_closed 是恢复不是故障（且 ok=false 不入 na/成功位）");
        assert_eq!(classify_gap_minute(&[&reset]), GapClass::SystemGap);
        // ③ 无事件 → 系统缺口（D5：事件空窗/采集停摆；非交易日已被日历排除）
        assert_eq!(classify_gap_minute(&[]), GapClass::SystemGap);
        // 混合：失败证据优先于 na
        let mix_ok = ev(t0, true, Some("na"));
        let mix_bad = ev(t0, false, Some("timeout"));
        assert_eq!(classify_gap_minute(&[&mix_ok, &mix_bad]), GapClass::SourceFault);
    }

    #[test]
    fn segments_merge_consecutive_same_class_and_break_lunch() {
        let day = d(2026, 9, 3);
        let missing = vec![
            (ndt(day, 10, 41), GapClass::SourceFault),
            (ndt(day, 10, 42), GapClass::SourceFault),
            (ndt(day, 10, 43), GapClass::SourceFault),
            (ndt(day, 11, 30), GapClass::SystemGap),
            (ndt(day, 13, 1), GapClass::SystemGap),   // 午休断段：与 11:30 不合并
            (ndt(day, 13, 2), GapClass::SystemGap),
        ];
        let segs = segments_of(&missing);
        assert_eq!(segs.len(), 3);
        assert_eq!((hhmm(&segs[0].start).as_str(), hhmm(&segs[0].end).as_str(), segs[0].count),
            ("10:41", "10:43", 3));
        assert_eq!(segs[0].class, GapClass::SourceFault);
        assert_eq!((hhmm(&segs[1].start).as_str(), segs[1].count), ("11:30", 1), "分类变即断段");
        assert_eq!((hhmm(&segs[2].start).as_str(), hhmm(&segs[2].end).as_str(), segs[2].count),
            ("13:01", "13:02", 2), "午休两侧不跨段");
    }

    #[test]
    fn validate_range_and_day_range_utc() {
        assert!(validate_range(d(2026, 9, 1), d(2026, 9, 3)).is_ok());
        assert!(validate_range(d(2026, 9, 3), d(2026, 9, 1)).is_err(), "from>to → 400");
        assert!(validate_range(d(2026, 1, 1), d(2026, 12, 31)).is_err(), "超 62 天跨度 → 400");
        let (lo, hi) = day_range_utc(d(2026, 9, 3), d(2026, 9, 3));
        assert_eq!(lo, Utc.with_ymd_and_hms(2026, 9, 2, 16, 0, 0).unwrap(), "CST 日界 → UTC");
        assert_eq!(hi, Utc.with_ymd_and_hms(2026, 9, 3, 16, 0, 0).unwrap());
    }
}
```

离线服务级测试（mock 端口，无 DB；fake clock 确定性）：

``` {.rust file=crates/diagnose/tests/quality.rs}
//! QualityService 离线测试（mock 端口 + FixedClock，无 DB）：
//! 缺口日历口径（周末/节假日排除、未来分钟不算缺口）+ 三级分类 + 单日质量卡 + tushare 状态。

use chrono::{DateTime, NaiveDate, TimeZone, Timelike, Utc};
use diagnose::quality::*;
use domain::ports::*;
use domain::types::Code;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }

struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock { fn now(&self) -> DateTime<Utc> { self.0 } }

struct MemQuality(Vec<DivergenceRow>);
#[async_trait::async_trait]
impl QualityRead for MemQuality {
    async fn divergence_rows(&self, code: Option<&str>, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<DivergenceRow>> {
        Ok(self.0.iter().filter(|r| code.is_none_or(|c| r.code == c)).cloned().collect())
    }
}

/// 测试内存已有-ts 表类型（提取 type 别名降 clippy 复杂度）。
type TsMap = HashMap<(String, NaiveDate), HashSet<DateTime<Utc>>>;

#[derive(Default)]
struct MemRaw { ts: Mutex<TsMap> }
#[async_trait::async_trait]
impl RawBarReader for MemRaw {
    async fn existing_ts(&self, code: &Code, date: NaiveDate)
        -> anyhow::Result<HashSet<DateTime<Utc>>> {
        Ok(self.ts.lock().unwrap().get(&(code.0.clone(), date)).cloned().unwrap_or_default())
    }
}

struct MemRangeEvents(Vec<HealthEventRow>);
#[async_trait::async_trait]
impl HealthEventsRangeRead for MemRangeEvents {
    async fn events_between(&self, from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(self.0.iter().filter(|e| e.ts >= from && e.ts < to).cloned().collect())
    }
}

struct MemHolidays(HashSet<NaiveDate>);
#[async_trait::async_trait]
impl HolidayCalendarRead for MemHolidays {
    async fn holidays(&self) -> anyhow::Result<HashSet<NaiveDate>> { Ok(self.0.clone()) }
}

struct MemTushare(Vec<SyncCheckpointView>);
#[async_trait::async_trait]
impl TushareStatusRead for MemTushare {
    async fn sync_checkpoints(&self) -> anyhow::Result<Vec<SyncCheckpointView>> { Ok(self.0.clone()) }
}

fn svc(now: DateTime<Utc>, raw: Arc<MemRaw>, evs: Vec<HealthEventRow>, hol: HashSet<NaiveDate>,
       rows: Vec<DivergenceRow>, cps: Vec<SyncCheckpointView>) -> QualityService {
    QualityService::new(Arc::new(MemQuality(rows)), raw, Arc::new(MemRangeEvents(evs)),
        Arc::new(MemHolidays(hol)), Arc::new(MemTushare(cps)), Arc::new(FixedClock(now)))
}

fn ev_cst(day: NaiveDate, h: u32, mi: u32, s: u32, ok: bool, kind: Option<&str>, code: &str)
    -> HealthEventRow {
    HealthEventRow {
        ts: domain::tz::cst_to_utc(day.and_hms_opt(h, mi, s).unwrap()),
        source: "tencent_ifzq".into(), ok, latency_ms: None,
        err_kind: kind.map(Into::into), code: Some(code.into()),
    }
}

/// 把某日全部 241 标签（除 skip 列出的 CST (h,m)）标为已有。
fn seed_all_except(raw: &MemRaw, code: &str, day: NaiveDate, skip: &[(u32, u32)]) {
    let set: HashSet<DateTime<Utc>> = domain::calendar::trading_minute_labels(day).into_iter()
        .filter(|l| !skip.contains(&(l.time().hour(), l.time().minute())))
        .map(domain::tz::cst_to_utc).collect();
    raw.ts.lock().unwrap().insert((code.into(), day), set);
}

#[tokio::test]
async fn gaps_exclude_weekend_and_holiday() {
    let now = Utc.with_ymd_and_hms(2026, 10, 9, 2, 0, 0).unwrap();
    let raw = Arc::new(MemRaw::default());
    let mut hol = HashSet::new();
    for dd in 1..=8u32 { hol.insert(d(2026, 10, dd)); } // 国庆（0008 口径）
    for dd in 1..=3u32 { hol.insert(d(2026, 1, dd)); }  // 元旦（0008 口径）
    let s = svc(now, raw, vec![], hol, vec![], vec![]);
    // 周末
    assert!(s.gaps("518880", d(2026, 9, 5), d(2026, 9, 6)).await.unwrap().is_empty(),
        "周末整日排除（任务书验收点）");
    // 节假日（含工作日 10-01 周四）
    assert!(s.gaps("518880", d(2026, 10, 1), d(2026, 10, 8)).await.unwrap().is_empty(),
        "国庆整日排除、不算缺口（任务书验收点）");
    // 元旦（2026-01-01 周四）
    assert!(s.gaps("518880", d(2026, 1, 1), d(2026, 1, 1)).await.unwrap().is_empty(),
        "元旦排除");
}

#[tokio::test]
async fn gaps_classify_three_tiers_and_segments() {
    let day = d(2026, 9, 3); // 周四
    // now = 次日 → 当日 241 标签全到期
    let now = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();
    let raw = Arc::new(MemRaw::default());
    seed_all_except(&raw, "518880", day, &[(10, 41), (10, 42), (13, 5), (14, 0)]);
    let evs = vec![
        ev_cst(day, 10, 41, 30, false, Some("timeout"), "518880"),   // 源故障
        ev_cst(day, 13, 5, 20, true, Some("na"), "518880"),          // 源可达无数据
        // 14:00 邻近无事件 → 系统缺口
    ];
    let s = svc(now, raw, evs, HashSet::new(), vec![], vec![]);
    let days = s.gaps("518880", day, day).await.unwrap();
    assert_eq!(days.len(), 1, "仅缺口日出卡");
    let g = &days[0];
    assert_eq!(g.expected_bars, 241);
    assert_eq!(g.actual_bars, 237);
    assert_eq!(g.missing_bars, 4);
    assert_eq!(g.segments.len(), 3);
    assert_eq!((hhmm(&g.segments[0].start).as_str(), hhmm(&g.segments[0].end).as_str(),
                g.segments[0].count, g.segments[0].class),
        ("10:41", "10:42", 2, GapClass::SourceFault));
    assert_eq!((hhmm(&g.segments[1].start).as_str(), g.segments[1].class),
        ("13:05", GapClass::UpstreamNoData));
    assert_eq!((hhmm(&g.segments[2].start).as_str(), g.segments[2].class),
        ("14:00", GapClass::SystemGap), "交易日邻近零事件 → 系统缺口（D5）");
}

#[tokio::test]
async fn gaps_future_minutes_not_due_and_full_day_ok() {
    let day = d(2026, 9, 3);
    // now = 当日 10:00:30 CST：到期标签 = 09:30..=10:00 共 31
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    let raw = Arc::new(MemRaw::default()); // 零已有
    let s = svc(now, raw, vec![], HashSet::new(), vec![], vec![]);
    let days = s.gaps("518880", day, day).await.unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].expected_bars, 31, "未来分钟不算缺口");
    assert_eq!(days[0].missing_bars, 31);
    // 全天无缺口 → 不出卡
    let raw2 = Arc::new(MemRaw::default());
    seed_all_except(&raw2, "518880", day, &[]);
    let s2 = svc(Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap(), raw2, vec![],
        HashSet::new(), vec![], vec![]);
    assert!(s2.gaps("518880", day, day).await.unwrap().is_empty(), "无缺口日不出卡");
}

#[tokio::test]
async fn daily_quality_card_and_tushare_status() {
    let day = d(2026, 9, 3);
    let now = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();
    let raw = Arc::new(MemRaw::default());
    seed_all_except(&raw, "518880", day, &[]);
    let rows = vec![
        DivergenceRow { ts: domain::tz::cst_to_utc(day.and_hms_opt(9, 30, 0).unwrap()),
            code: "518880".into(), raw_close: 10.1, accurate_close: 10.0,
            raw_source: Some("tencent_ifzq".into()) },
        DivergenceRow { ts: domain::tz::cst_to_utc(day.and_hms_opt(9, 31, 0).unwrap()),
            code: "518880".into(), raw_close: 10.0, accurate_close: 10.0,
            raw_source: Some("tencent_ifzq".into()) },
    ];
    let cps = vec![SyncCheckpointView { code: "518880".into(), period: "M1".into(),
        last_synced_date: d(2026, 9, 3),
        updated_at: Utc.with_ymd_and_hms(2026, 9, 3, 22, 0, 0).unwrap() }];
    let evs = vec![
        HealthEventRow { ts: Utc.with_ymd_and_hms(2026, 9, 3, 10, 0, 0).unwrap(),
            source: "tushare".into(), ok: true, latency_ms: Some(42000), err_kind: None, code: None },
        HealthEventRow { ts: Utc.with_ymd_and_hms(2026, 9, 3, 10, 30, 0).unwrap(),
            source: "tencent_ifzq".into(), ok: true, latency_ms: None, err_kind: None, code: None },
    ];
    let s = svc(now, raw, evs, HashSet::new(), rows, cps);

    // MCP④ 单日卡：交易日、无缺口、分歧汇总
    let q = s.daily_quality("518880", day).await.unwrap();
    assert!(q.trading_day);
    assert!(q.gap.is_none(), "全天无缺口 → gap=None");
    assert_eq!(q.divergence.compared_bars, 2);
    assert_eq!(q.divergence.divergent_bars, 1, "+1.0% > 0.5% 默认阈值");
    assert!((q.divergence.consistency_rate.unwrap() - 0.5).abs() < 1e-9);

    // 节假日单日卡：trading_day=false
    let mut hol = HashSet::new();
    hol.insert(d(2026, 10, 1));
    let raw2 = Arc::new(MemRaw::default());
    let s2 = svc(now, raw2, vec![], hol, vec![], vec![]);
    let q2 = s2.daily_quality("518880", d(2026, 10, 1)).await.unwrap();
    assert!(!q2.trading_day);
    assert!(q2.gap.is_none());
    assert_eq!(q2.divergence.compared_bars, 0);

    // tushare 状态
    let st = s.tushare_status().await.unwrap();
    assert_eq!(st.covered_codes, 1);
    assert_eq!(st.last_updated_at, Some(Utc.with_ymd_and_hms(2026, 9, 3, 22, 0, 0).unwrap()));
    let le = st.last_event.expect("最近 tushare 事件");
    assert!(le.ok && le.err_kind.is_none(), "过滤 source='tushare' 且取最近一条");
}
```

## 3. storage 只读加法扩展（KlineReader）

父级授权口径：「storage 读接口如需加法扩展可以」。`reader.rs` 为纯新增文件，写路径（kline.rs /
accurate.rs / events.rs / symbols.rs）零改动；`pub mod reader;` 声明维护在 04-storage/02-tushare-sync.md。
审查返工后：`KlineReader`/`HealthEventReader` 实现 domain 只读端口（`KlineRead`/`HealthEventsRead`），
消费方（web/diagnose）不反向依赖本 crate。

- **统一读源（Wave 3，0010，用户定稿 2026-09-04）**：所有周期都走「accurate 优先 + 底层兜底」合并；
  读取 = `kline_merged_<P>` = `accurate_<P>`（优先，覆盖全历史 2012+；5m/15m/1h 由 0017 全量、1w/1mo 由 0016 全量）UNION ALL
  `兜底层_<P>`（5m/15m/1d 用 raw-derived cagg；1h 用 kline_15m rollup；1m 用 raw）+ NOT EXISTS 反连接；
- 1m 读 `MERGED_1M_SQL`（双侧 (code,ts) 索引 DESC LIMIT 后合并，准确层优先语义等价 `kline_merged`，ADR-003；旧直查视图全量 Append+top-N 排序 ~2.5s，改后 ~0.1s，与 domain merge.rs 契约一致）；
- 5m/15m/1h/1d 读 `merged_sql(accurate_<P>, 兜底)`（⚠️ cagg `volume` 列为 numeric，`::bigint` 归一；`amount` 恒 double）；
- 表名/片段只经内部 match 映射常量拼接，不接受外部输入（无注入面）
- **Wave 2 Phase A 加法**：`QualityRead`（raw⋈accurate 对照）/ `TushareStatusRead`（sync_checkpoints）
  挂 KlineReader；`HealthEventsRangeRead`（任意区间事件）挂 HealthEventReader；新增 `HolidaysReader`
  （0008 节假日表，collector 与应用面共用）。**D3 结案**：`symbols_with_latest` 重写为双侧索引回溯
  top-2 合并（不再扫 kline_merged 视图），语义经实盘 EXCEPT 互减 0 行验证，19,850ms → 13.5ms。

``` {.rust file=crates/storage/src/reader.rs}
//! 应用面只读扩展（Wave 1 Phase A 加法，ADR-017 授权口径；写入路径零改动）：
//! 实现 domain::ports::{KlineRead, HealthEventsRead}（分层红线：web/diagnose 只依赖 domain 端口）。
//! 统一读源（Wave 3 0010）：所有周期 accurate 优先 + 底层兜底（ADR-003 推广）。
//! - 1m：MERGED_1M_SQL 双侧 (code,ts) 索引 DESC LIMIT 合并（准确层优先语义等价 kline_merged，ADR-003）；5m/15m/1h/1d/w/m：merged_sql(accurate_<P> UNION ALL 兜底 反连接)
//! - forming 桶（实时右缘）：5m/15m/1h 在 latest 查询（before=None）额外聚合当前未闭合桶（kline_raw 实时）
//!   —— cagg(accurate/兜底) 只承载**已闭合**桶，右缘落后至上一闭合桶（5m 最多 ~5min），forming 分支让右缘随 live 前进。
//! - 周线 W1/月线 MO1（看板 W1）：accurate 用 kline_accurate_1w/1mo（0014 cagg）；兜底用 kline_1d 查询期 rollup
//! - symbols + 最新快照（REST /api/symbols latest 字段与 WS quote 推送数据源）
//! - source_health_events 窗口读取（diagnose 聚合输入）

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use domain::ports::{
    DivergenceRow, HealthEventRow, HealthEventsRangeRead, HealthEventsRead, HolidayCalendarRead,
    KlineBarView, KlineRead, QualityRead, SymbolLatestView, SymbolStatView, SymbolStatsRead,
    SyncCheckpointView, TushareStatusRead,
};
use domain::types::Period;
use sqlx::PgPool;
use std::collections::HashSet;

type BarTuple = (String, DateTime<Utc>, f64, f64, f64, f64, i64, f64, Option<String>);

/// 1m 统一读源（MERGED_1M_SQL，ADR-003 准确层优先语义等价 kline_merged）。
/// 旧版直查 kline_merged 视图（accurate(M1) UNION ALL raw 反连接剔重）：ORDER BY ts DESC LIMIT 无法
/// 下推到各分支 → 全量 Append（~77万行）+ top-N 排序 + raw 反连接逐行查 accurate，实测 ~2.5s。
/// 新版双侧各自 (code,ts) 索引回溯 DESC LIMIT 取候选 → 合并（同 ts 准确层优先，raw 经反连接剔重）
/// 再 DESC LIMIT。merge 尾部 top-N ⊆ 双侧 top-N 并集，语义等价（实盘 EXCEPT 互减 0 行）。
/// 实测（同库）：旧 ~1.05s → 新 ~0.1s。raw 分支保留实际 source（与 kline_merged 口径一致）；
/// accurate 分支 source 记 'tushare'（与准确层写入源一致）。
const MERGED_1M_SQL: &str = r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM (
    (SELECT a.code, a.ts, a.open, a.high, a.low, a.close, a.volume::bigint AS volume,
            a.amount, 'tushare'::text AS source
     FROM kline_accurate a
     WHERE a.code = $1 AND a.period = 'M1' AND ($2::timestamptz IS NULL OR a.ts < $2)
     ORDER BY a.ts DESC LIMIT $3)
    UNION ALL
    (SELECT f.code, f.ts, f.open, f.high, f.low, f.close, f.volume::bigint AS volume,
            f.amount, f.source
     FROM kline_raw f
     WHERE f.code = $1 AND ($2::timestamptz IS NULL OR f.ts < $2)
       AND NOT EXISTS (SELECT 1 FROM kline_accurate a
                       WHERE a.code = f.code AND a.ts = f.ts AND a.period = 'M1')
     ORDER BY f.ts DESC LIMIT $3)
) m
ORDER BY ts DESC LIMIT $3
"#;

/// 统一读源：accurate(优先) UNION ALL 兜底(反连接剔重)。
/// - accurate 分支：`{accurate}` 表（0010 cagg；D1 复用 kline_accurate_1d），覆盖全历史 2012+；
///   5m/15m/1h（0017）与 1w/1mo（0016）均全量（无 2024 过滤），pre-2024 也走 accurate。
///   source 记为 'tushare'（与 kline_merged M1 的 accurate 分支一致）。
/// - 兜底分支：`{fallback}`（表名或 1h rollup 片段），与 accurate 同 ts 的存在时被反连接剔重。
/// - cagg 无 source 列（以 NULL 归一行型）；volume 为 numeric → ::bigint。
///
/// 表名/片段只经 KlineRead::bars 内部 match 映射常量传入，不接受外部输入（无注入面）。
fn merged_sql(accurate: &str, fallback: &str) -> String {
    format!(r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM (
    SELECT code, ts, open, high, low, close, volume::bigint AS volume, amount, 'tushare'::text AS source
    FROM {accurate}
    WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
    UNION ALL
    SELECT f.code, f.ts, f.open, f.high, f.low, f.close, f.volume::bigint AS volume, f.amount, NULL::text AS source
    FROM {fallback} f
    WHERE f.code = $1 AND ($2::timestamptz IS NULL OR f.ts < $2)
      AND NOT EXISTS (SELECT 1 FROM {accurate} a WHERE a.code = f.code AND a.ts = f.ts)
) m
ORDER BY ts DESC LIMIT $3
"#, accurate = accurate, fallback = fallback)
}

/// 1h 兜底：kline_15m 查询期 rollup（schema 未建 kline_1h cagg；first/last 为 timescaledb 聚合）。
/// bucket ts = time_bucket 起点；before 过滤在桶级（与 accurate_1h 桶对齐后作反连接剔重）。
const FALLBACK_1H: &str = r#"
(SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_15m GROUP BY code, time_bucket('1 hour', ts))"#;

/// 周线 W1 兜底：kline_1d 查询期 rollup（schema 未建 kline_1w cagg；与 accurate_1w 同 time_bucket 对齐）。
/// 周=A股交易周（Asia/Shanghai 周一为界，time_bucket 三参形式）；first/last 为 timescaledb 聚合。
const FALLBACK_1W: &str = r#"
(SELECT code, time_bucket('1 week', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_1d GROUP BY code, time_bucket('1 week', ts, 'Asia/Shanghai'))"#;

/// 月线 MO1 兜底：kline_1d 查询期 rollup（schema 未建 kline_1mo cagg；与 accurate_1mo 同 time_bucket 对齐）。
/// 月=自然月（Asia/Shanghai 月界，time_bucket 三参形式）；first/last 为 timescaledb 聚合。
const FALLBACK_1MO: &str = r#"
(SELECT code, time_bucket('1 month', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_1d GROUP BY code, time_bucket('1 month', ts, 'Asia/Shanghai'))"#;

/// 周期 → 统一读源 SQL（1m 用 MERGED_1M_SQL 双侧索引 DESC LIMIT 合并；其余按 accurate 表 + 兜底片段）。
fn period_merged_sql(p: Period) -> String {
    match p {
        Period::M1 => MERGED_1M_SQL.to_string(),
        Period::M5 => merged_sql("kline_accurate_5m", "kline_5m"),
        Period::M15 => merged_sql("kline_accurate_15m", "kline_15m"),
        Period::H1 => merged_sql("kline_accurate_1h", FALLBACK_1H),
        Period::D1 => merged_sql("kline_accurate_1d", "kline_1d"),
        Period::W1 => merged_sql("kline_accurate_1w", FALLBACK_1W),
        Period::MO1 => merged_sql("kline_accurate_1mo", FALLBACK_1MO),
    }
}

/// 当前 forming（未闭合）桶聚合 SQL：从 kline_raw 实时聚合周期桶，供 live 图表右缘随最新 raw 1m 前进。
/// 仅对日内周期 M5/M15/H1 生效（D1/W1/MO1 由既有 cagg/rollup 承载其闭合桶）；非日内周期返回 None。
/// bucket 用 `time_bucket(interval, now())`——只产**当前**未闭合桶（≤1 行）；`source` 记 NULL（与兜底分支同型）。
fn forming_sql(period: Period) -> Option<String> {
    let interval = match period {
        Period::M5 => "5 minutes",
        Period::M15 => "15 minutes",
        Period::H1 => "1 hour",
        _ => return None,
    };
    Some(format!(r#"
SELECT code, time_bucket('{interval}', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount,
       NULL::text AS source
FROM kline_raw
WHERE code = $1 AND ts >= time_bucket('{interval}', now())
GROUP BY code, time_bucket('{interval}', ts)
"#, interval = interval))
}

/// 每 code 最近 2 根 merge bar（D3 优化版，Wave 2 Phase A）。
/// 旧版直查 kline_merged 视图（UNION ALL + NOT EXISTS 反连接阻断裂索引下推，实测 15-20s/次，
/// Wave 1 验收 D3）；新版双侧各自 (code,ts) 索引回溯 LIMIT 2 取候选 → 按 ts 去重（同 ts 准确层优先，
/// merge 语义）→ row_number 取最新两根。merge 尾部 top-2 ⊆ 双侧 top-2 并集，语义等价
/// （实盘全量 symbols 新老查询 EXCEPT 互减 0 行，证据见 coder/report/011）。
/// 实测（同库）：旧 19,850ms → 新 13.5ms。
const SYMBOLS_LATEST_SQL: &str = r#"
SELECT s.code, s.name, s.interval_secs, s.settlement, s.enabled,
       l.last_ts, l.last_close, l.prev_close
FROM symbols s
LEFT JOIN LATERAL (
  SELECT max(CASE WHEN rn = 1 THEN ts END)   AS last_ts,
         max(CASE WHEN rn = 1 THEN close END) AS last_close,
         max(CASE WHEN rn = 2 THEN close END) AS prev_close
  FROM (
    SELECT ts, close, row_number() OVER (ORDER BY ts DESC) AS rn
    FROM (
      SELECT DISTINCT ON (ts) ts, close
      FROM (
        (SELECT a.ts, a.close, 0 AS pri FROM kline_accurate a
         WHERE a.code = s.code AND a.period = 'M1' ORDER BY a.ts DESC LIMIT 2)
        UNION ALL
        (SELECT r.ts, r.close, 1 AS pri FROM kline_raw r
         WHERE r.code = s.code ORDER BY r.ts DESC LIMIT 2)
      ) cand
      ORDER BY ts, pri
    ) dedup
  ) ranked
) l ON true
ORDER BY s.code
"#;

const WINDOW_EVENTS_SQL: &str = r#"
SELECT ts, source, ok, latency_ms, err_kind, code
FROM source_health_events
WHERE ts > now() - make_interval(secs => $1)
ORDER BY source, ts
"#;

/// 当日（Asia/Shanghai 日界）kline_raw 每 code 行数与最新 ts（页面③ with_stats 数据源）。
const TODAY_STATS_SQL: &str = r#"
SELECT code, count(*)::bigint AS today_bars, max(ts) AS last_bar_ts
FROM kline_raw
WHERE ts >= $1 AND ts < $2
GROUP BY code
"#;

/// K线只读端口实现（PgPool）。
pub struct KlineReader {
    pool: PgPool,
}

impl KlineReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }

    /// 当前 forming（未闭合）桶：仅 M5/M15/H1 由 forming_sql 从最新 raw 1m 聚合（≤1 行）；其余无。
    async fn forming_bar(&self, period: Period, code: &str) -> Result<Option<KlineBarView>> {
        let Some(sql) = forming_sql(period) else { return Ok(None); };
        let rows: Vec<BarTuple> = sqlx::query_as(&sql).bind(code).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(
            |(code, ts, open, high, low, close, volume, amount, source)|
            KlineBarView { code, ts, open, high, low, close, volume, amount, source }
        ).next())
    }
}

#[async_trait]
impl KlineRead for KlineReader {
    /// ts < before（None=最新起），降序取 limit 行后翻转**升序**返回（图表口径）。
    async fn bars(&self, period: Period, code: &str,
                  before: Option<DateTime<Utc>>, limit: i64) -> Result<Vec<KlineBarView>> {
        let sql = period_merged_sql(period);
        let rows: Vec<BarTuple> = sqlx::query_as(&sql)
            .bind(code).bind(before).bind(limit)
            .fetch_all(&self.pool).await?;
        let mut bars: Vec<KlineBarView> = rows.into_iter().map(
            |(code, ts, open, high, low, close, volume, amount, source)|
            KlineBarView { code, ts, open, high, low, close, volume, amount, source }
        ).collect();
        bars.reverse();
        // 实时右缘：latest 查询（before=None 且 limit>0）合入当前 forming 桶（若存在且更新于已返回最后一根）。
        // - 更新（f.ts > 末根.ts）：剔除最旧一根保 limit，末根追加 f；
        // - 相同（f.ts == 末根.ts）：f 覆盖 cagg/rollup 的陈旧/部分桶（如 1h rollup 未闭合窗）。
        if before.is_none() && limit > 0 {
            if let Some(f) = self.forming_bar(period, code).await? {
                let last_ts = bars.last().map(|b| b.ts);
                if last_ts.map_or(true, |t| f.ts > t) {
                    if bars.len() as i64 >= limit {
                        bars.remove(0);
                    }
                    bars.push(f);
                } else if last_ts == Some(f.ts) {
                    *bars.last_mut().expect("non-empty") = f;
                }
            }
        }
        Ok(bars)
    }

    /// 注册表 + 最新快照（涨跌幅 = (last − prev_close) / prev_close，由调用方计算）。
    async fn symbols_with_latest(&self) -> Result<Vec<SymbolLatestView>> {
        type Row = (String, Option<String>, i32, String, bool,
                    Option<DateTime<Utc>>, Option<f64>, Option<f64>);
        let rows: Vec<Row> = sqlx::query_as(SYMBOLS_LATEST_SQL).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(
            |(code, name, interval_secs, settlement, enabled, last_ts, last_close, prev_close)|
            SymbolLatestView { code, name, interval_secs, settlement, enabled,
                               last_ts, last_close, prev_close }
        ).collect())
    }
}

/// 标的当日采集统计（SymbolStatsRead 实现；页面③ GET /api/symbols?with_stats=1 数据源）。
/// 当日 = Asia/Shanghai 日界（domain::tz 固定 +8 平移口径，与 RawBarReader::existing_ts 一致）。
#[async_trait]
impl SymbolStatsRead for KlineReader {
    async fn today_stats(&self) -> Result<Vec<SymbolStatView>> {
        let today_cst = domain::tz::utc_to_cst(Utc::now()).date();
        let start = domain::tz::cst_to_utc(today_cst.and_hms_opt(0, 0, 0).expect("valid hms"));
        let end = domain::tz::cst_to_utc((today_cst + chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0).expect("valid hms"));
        type Row = (String, i64, Option<DateTime<Utc>>);
        let rows: Vec<Row> = sqlx::query_as(TODAY_STATS_SQL)
            .bind(start).bind(end).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(code, today_bars, last_bar_ts)|
            SymbolStatView { code, today_bars, last_bar_ts }).collect())
    }
}

/// 健康事件窗口读取（diagnose 聚合输入；HealthEventsRead 实现）。
pub struct HealthEventReader {
    pool: PgPool,
}

impl HealthEventReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl HealthEventsRead for HealthEventReader {
    async fn window_events(&self, window_secs: i64) -> Result<Vec<HealthEventRow>> {
        type Row = (DateTime<Utc>, String, bool, Option<i32>, Option<String>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(WINDOW_EVENTS_SQL)
            .bind(window_secs as f64).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(ts, source, ok, latency_ms, err_kind, code)|
            HealthEventRow { ts, source, ok, latency_ms, err_kind, code }
        ).collect())
    }
}

// ── Wave 2 Phase A 加法：质量对照 / 节假日 / 事件区间 / tushare 同步状态（domain 端口契约见 §2）──

/// raw ⋈ accurate(M1) 双侧收盘对照（质量分歧表数据源）。
/// amount 刻意不查（D4 结案：跨层量纲不可比，04-storage §4.4 注记 7）。
const DIVERGENCE_SQL: &str = r#"
SELECT r.ts, r.code, r.close AS raw_close, a.close AS accurate_close, r.source AS raw_source
FROM kline_raw r
JOIN kline_accurate a ON a.code = r.code AND a.ts = r.ts AND a.period = 'M1'
WHERE ($1::text IS NULL OR r.code = $1)
  AND r.ts >= $2 AND r.ts < $3
ORDER BY r.ts
"#;

#[async_trait]
impl QualityRead for KlineReader {
    async fn divergence_rows(&self, code: Option<&str>, from: DateTime<Utc>, to: DateTime<Utc>)
        -> Result<Vec<DivergenceRow>> {
        type Row = (DateTime<Utc>, String, f64, f64, String);
        let rows: Vec<Row> = sqlx::query_as(DIVERGENCE_SQL)
            .bind(code).bind(from).bind(to).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(ts, code, raw_close, accurate_close, raw_source)|
            DivergenceRow { ts, code, raw_close, accurate_close, raw_source: Some(raw_source) }
        ).collect())
    }
}

/// tushare 同步检查点读（页面④ sync-panel 数据源）。
const SYNC_CHECKPOINTS_SQL: &str = r#"
SELECT code, period, last_synced_date, updated_at FROM sync_checkpoints ORDER BY code
"#;

#[async_trait]
impl TushareStatusRead for KlineReader {
    async fn sync_checkpoints(&self) -> Result<Vec<SyncCheckpointView>> {
        type Row = (String, String, NaiveDate, DateTime<Utc>);
        let rows: Vec<Row> = sqlx::query_as(SYNC_CHECKPOINTS_SQL).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(code, period, last_synced_date, updated_at)|
            SyncCheckpointView { code, period, last_synced_date, updated_at }).collect())
    }
}

/// 健康事件区间读（质量缺口分类输入；与窗口版同表，[from, to) 闭开区间）。
const RANGE_EVENTS_SQL: &str = r#"
SELECT ts, source, ok, latency_ms, err_kind, code
FROM source_health_events
WHERE ts >= $1 AND ts < $2
ORDER BY ts
"#;

#[async_trait]
impl HealthEventsRangeRead for HealthEventReader {
    async fn events_between(&self, from: DateTime<Utc>, to: DateTime<Utc>)
        -> Result<Vec<HealthEventRow>> {
        type Row = (DateTime<Utc>, String, bool, Option<i32>, Option<String>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(RANGE_EVENTS_SQL)
            .bind(from).bind(to).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(ts, source, ok, latency_ms, err_kind, code)|
            HealthEventRow { ts, source, ok, latency_ms, err_kind, code }
        ).collect())
    }
}

/// 节假日表读（0008；collector HolidayCalendar 刷新与 diagnose 缺口报告共用同一实现）。
pub struct HolidaysReader {
    pool: PgPool,
}

impl HolidaysReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl HolidayCalendarRead for HolidaysReader {
    async fn holidays(&self) -> Result<HashSet<NaiveDate>> {
        let rows: Vec<(NaiveDate,)> = sqlx::query_as("SELECT date FROM holidays")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(d,)| d).collect())
    }
}
```

``` {.rust file=crates/storage/tests/kline_reader.rs}
//! KlineReader 只读集成测试（需 TimescaleDB :5433）：merge 准确层优先、游标分页、cagg/1h rollup、最新快照。

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use domain::ports::{HealthEventsRangeRead, HealthEventsRead, HolidayCalendarRead, KlineRead,
    QualityRead, TushareStatusRead};
use domain::types::Period;
use sqlx::PgPool;
use storage::reader::{HealthEventReader, HolidaysReader, KlineReader};

// 每测试独立 code：同 binary 测试并行执行，共享 code 会被彼此的 clean 误删（实锤踩坑）。
const CODE_MERGE: &str = "997701";
const CODE_CAGG: &str = "997711";
const CODE_SYM: &str = "997721";
const CODE_SYM_EMPTY: &str = "997722";
const CODE_DEEP: &str = "997751";
const CODE_WM: &str = "997733";   // 周/月聚合测试独占 code（避免与其他并行测试互删；997731 已被 CODE_QUAL 占用）
const CODE_WM_DEEP: &str = "997752"; // W1/MO1 全历史深翻测试独占 code（0016 前 cagg 有 ts>=2024 过滤）

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool, code: &str) {
    for t in ["kline_raw", "kline_accurate", "symbols"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(code).execute(pool).await.unwrap();
    }
}

/// 5 根 1m raw bar（收盘 1..5，各 100 股）+ base+1min 处准确层覆盖（收盘 9.99，777 股）。
async fn seed(pool: &PgPool, code: &str) {
    for i in 0..5i64 {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 'M1', 9.99, 9.99, 9.99, 9.99, 777, 777.0, 'tushare') \
                 ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
        .bind(code).bind(base() + Duration::minutes(1))
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn merged_1m_accurate_first_and_cursor_pagination() {
    let pool = pool().await;
    clean(&pool, CODE_MERGE).await;
    seed(&pool, CODE_MERGE).await;
    let r = KlineReader::new(pool.clone());

    let bars = r.bars(Period::M1, CODE_MERGE, None, 10).await.unwrap();
    assert_eq!(bars.len(), 5);
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "升序返回（图表口径）");
    assert_eq!(bars[1].close, 9.99, "准确层优先（ADR-003 merge 视图）");
    assert_eq!(bars[1].volume, 777);
    assert_eq!(bars[1].source.as_deref(), Some("tushare"));
    assert_eq!(bars[4].close, 5.0);
    assert_eq!(bars[4].source.as_deref(), Some("tencent_ifzq"));

    // 游标：before 不含该 ts 本身
    let page = r.bars(Period::M1, CODE_MERGE, Some(base() + Duration::minutes(3)), 10).await.unwrap();
    assert_eq!(page.iter().map(|b| b.close).collect::<Vec<_>>(), vec![1.0, 9.99, 3.0]);

    // limit 降序取后翻转
    let top2 = r.bars(Period::M1, CODE_MERGE, None, 2).await.unwrap();
    assert_eq!(top2.iter().map(|b| b.close).collect::<Vec<_>>(), vec![4.0, 5.0]);
    assert_eq!(r.latest_bar(Period::M1, CODE_MERGE).await.unwrap().unwrap().close, 5.0);
    assert!(r.latest_bar(Period::M1, "000000").await.unwrap().is_none());
    clean(&pool, CODE_MERGE).await;
}

#[tokio::test]
async fn merged_1m_branch_limit_merge_correctness() {
    // MERGED_1M_SQL 改为双侧各自 (code,ts) 索引 DESC LIMIT 后合并：语义与旧 kline_merged 视图等价。
    // 本测试用「准确层与 raw 交替、双侧行数 > limit」的种子，锁 per-branch LIMIT 合并正确性：
    // ① 准确层优先（同 ts）② raw 兜底（仅无准确层时）③ 无重复 ④ 升序 ⑤ limit 生效 ⑥ before 深翻。
    const CODE_BRANCH: &str = "997763";
    let pool = pool().await;
    clean(&pool, CODE_BRANCH).await;
    // accurate：偶数分钟 0..=24（13 根）；raw：奇数分钟 1..=25（13 根）——交替、无重叠 ts。
    for i in 0..26i64 {
        let ts = base() + Duration::minutes(i);
        if i % 2 == 0 {
            sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                         VALUES ($1, $2, 'M1', $3, $3, $3, $3, 200, 200.0, 'tushare') ON CONFLICT DO NOTHING")
                .bind(CODE_BRANCH).bind(ts).bind(100.0 + i as f64)
                .execute(&pool).await.unwrap();
        } else {
            sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                         VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'webq_src') ON CONFLICT DO NOTHING")
                .bind(CODE_BRANCH).bind(ts).bind(200.0 + i as f64)
                .execute(&pool).await.unwrap();
        }
    }
    let r = KlineReader::new(pool.clone());
    let bars = r.bars(Period::M1, CODE_BRANCH, None, 5).await.unwrap();
    // 总量 26 根（准确 13 + raw 13，无重叠）；limit=5 取最新 5 根 = ts 21..25，升序返回。
    assert_eq!(bars.len(), 5, "limit=5 生效，返回最新 5 根");
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "升序返回（图表口径）");
    let expected: Vec<(i64, f64, &str)> = vec![
        (21, 221.0, "webq_src"), // raw 奇数分钟
        (22, 122.0, "tushare"),  // accurate 偶数分钟
        (23, 223.0, "webq_src"),
        (24, 124.0, "tushare"),
        (25, 225.0, "webq_src"),
    ];
    for (b, (min, close, src)) in bars.iter().zip(&expected) {
        assert_eq!(b.ts, base() + Duration::minutes(*min), "ts 对齐");
        assert_eq!(b.close, *close, "close 对齐（准确层优先/raw 兜底）");
        assert_eq!(b.source.as_deref(), Some(*src),
            "source：raw 保留实际来源，accurate 层 = tushare");
        assert_eq!(b.volume, if *src == "tushare" { 200 } else { 100 }, "volume 按来源区分");
    }
    // before 深翻：before=24min 取下一页（limit=5）→ ts 19..23，降序翻页、无重复/缺口。
    let page = r.bars(Period::M1, CODE_BRANCH, Some(base() + Duration::minutes(24)), 5).await.unwrap();
    assert_eq!(page.len(), 5);
    assert!(page.iter().all(|b| b.ts < base() + Duration::minutes(24)), "before 不含该 ts 本身");
    let distinct: std::collections::HashSet<_> = page.iter().map(|b| b.ts).collect();
    assert_eq!(distinct.len(), page.len(), "深翻页内无重复数据点");
    clean(&pool, CODE_BRANCH).await;
}

#[tokio::test]
async fn merged_1m_branch_index_limit_performance() {
    // 基准（可加；若 518880 无 500 根 M1 则跳过断言以免假阴性）：MERGED_1M_SQL 改为双侧
    // (code,ts) 索引 DESC LIMIT 合并后，1m 500 bars（无 before）直接走各分支索引 LIMIT，
    // 不再全量 Append + top-N 排序。改前（直查 kline_merged 视图，~77万行全量 Append+top-N）
    // 实测 ~1.05s；改后 ~0.1s。目标 <500ms。
    let pool = pool().await;
    let r = KlineReader::new(pool.clone());
    let real_code = "518880"; // 真实全量 M1 code（77万+ 行），只读不改。
    // 预热几次：① 命中 sqlx 语句缓存 ② 让 Postgres 切换到 prepared statement 的 generic plan
    // （hypertable 上千 chunk 子计划，单次计划 ~600ms 不属稳态）。预热后测稳态执行时间。
    for _ in 0..8 {
        let w = r.bars(Period::M1, real_code, None, 500).await.unwrap();
        if w.len() != 500 {
            eprintln!("[bench-skip] {real_code} 无 500 根 M1（实际 {}），跳过性能断言", w.len());
            return;
        }
    }
    let t = std::time::Instant::now();
    let bars = r.bars(Period::M1, real_code, None, 500).await.unwrap();
    let dt = t.elapsed();
    assert_eq!(bars.len(), 500);
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "升序返回（图表口径）");
    eprintln!("[bench] M1 500 bars 稳态执行 = {}ms（双侧索引 DESC LIMIT 合并）", dt.as_millis());
    assert!(dt.as_millis() < 500,
        "1m 500 bars 稳态应在 <500ms 内返回（双侧索引 DESC LIMIT 合并），实际 {}ms；改前全量 Append+top-N 仅执行已超 1s",
        dt.as_millis());
}

#[tokio::test]
async fn merged_periods_accurate_first_and_1h_rollup() {
    let pool = pool().await;
    clean(&pool, CODE_CAGG).await;
    seed(&pool, CODE_CAGG).await;
    // 统一读源：所有周期读 merged（accurate 优先）。refres：accurate cagg（窗口覆盖 base() 数据
    // + D1 桶对齐）与 raw-derived cagg（兜底）。窗口 [09-02, 09-04] UTC 覆盖 base()=09-03 01:30 UTC
    // 的 M1 种子（01:30-01:34 UTC）与 D1 桶 ts（09-02 16:00 UTC）。
    for v in ["kline_accurate_5m", "kline_accurate_15m", "kline_accurate_1h", "kline_accurate_1d",
              "kline_5m", "kline_15m", "kline_1d"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2026-09-02 00:00:00+00', '2026-09-04 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    // 准确层优先：overlap 分钟返回 accurate（close=9.99, vol=777, source=tushare），而非 raw 侧。
    for p in [Period::M5, Period::M15, Period::H1, Period::D1] {
        let bars = r.bars(p, CODE_CAGG, None, 10).await.unwrap();
        assert_eq!(bars.len(), 1, "{p:?} 一个桶");
        assert_eq!(bars[0].open, 9.99, "{p:?} accurate 优先（ADR-003 推广）");
        assert_eq!(bars[0].close, 9.99);
        assert_eq!(bars[0].volume, 777, "{p:?} accurate cagg 数值归一");
        assert_eq!(bars[0].source.as_deref(), Some("tushare"), "{p:?} accurate 层来源");
    }
    clean(&pool, CODE_CAGG).await;
}

#[tokio::test]
async fn weekly_monthly_periods_aggregate() {
    let pool = pool().await;
    clean(&pool, CODE_WM).await;
    // 种子：kline_accurate M1 跨两周/两月，验证 W1/MO1 聚合（周=A股交易周周一为界、月=自然月）。
    // 2026-08-31(Mon) 两根 + 2026-09-07(Mon) 一根 → 两周（周 A/B）两月（8月/9月）；
    // 周内多根验证 first(open)/last(close)/sum(volume)。
    for (ts, c) in [
        (Utc.with_ymd_and_hms(2026, 8, 31, 1, 30, 0).unwrap(), 1.0),
        (Utc.with_ymd_and_hms(2026, 8, 31, 2, 0, 0).unwrap(), 2.0),
        (Utc.with_ymd_and_hms(2026, 9, 7, 1, 30, 0).unwrap(), 3.0),
    ] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') \
                     ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
            .bind(CODE_WM).bind(ts).bind(c)
            .execute(&pool).await.unwrap();
    }
    // 刷新 W1/MO1 cagg：refresh_continuous_aggregate 只物化**完全落在窗口内**的桶（含整桶起止），
    // 故窗口须从最早一周桶起点（08-30 16:00 UTC）之前到最晚一月桶终点之后（09 月桶=08-31 16:00→09-30 16:00 UTC）。
    for v in ["kline_accurate_1w", "kline_accurate_1mo"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2026-07-25 00:00:00+00', '2026-10-03 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    // 周线：两个交易周（周一为界）。第一周（2026-08-31）聚合两根 → open=first=1.0, close=last=2.0, vol=200。
    let weekly = r.bars(Period::W1, CODE_WM, None, 10).await.unwrap();
    assert_eq!(weekly.len(), 2, "W1：两个交易周");
    assert_eq!(weekly[0].open, 1.0, "W1 首周 open = first(open)");
    assert_eq!(weekly[0].close, 2.0, "W1 首周 close = last(close)");
    assert_eq!(weekly[0].volume, 200, "W1 首周 volume = sum(volume)");
    assert_eq!(weekly[1].open, 3.0, "W1 第二周单根");
    assert_eq!(weekly[1].close, 3.0);

    // 月线：8月（两根）+ 9月（一根）→ 两月。
    let monthly = r.bars(Period::MO1, CODE_WM, None, 10).await.unwrap();
    assert_eq!(monthly.len(), 2, "MO1：自然月（8月 + 9月）");
    assert_eq!(monthly[0].open, 1.0, "MO1 8月 open = first(open)");
    assert_eq!(monthly[0].close, 2.0, "MO1 8月 close = last(close)");
    assert_eq!(monthly[0].volume, 200, "MO1 8月 volume = sum(volume)");
    assert_eq!(monthly[1].open, 3.0, "MO1 9月单根");
    assert_eq!(monthly[1].close, 3.0);

    clean(&pool, CODE_WM).await;
}

#[tokio::test]
async fn unified_read_deep_history_to_2024() {
    // 修“往前翻几天就没数据”：所有周期能深翻历史。在 2024-01-01 与 2024-01-02 各种子一根 M1
    // （穿越 5m/15m/1h/1d 桶），before 游标从 2024-01-03 往回翻页应持续推进到 2024-01-01，无重复/缺口。
    let pool = pool().await;
    clean(&pool, CODE_DEEP).await;
    for (ts, c) in [
        (Utc.with_ymd_and_hms(2024, 1, 1, 1, 35, 0).unwrap(), 1.0),
        (Utc.with_ymd_and_hms(2024, 1, 2, 2, 0, 0).unwrap(), 2.0),
    ] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') \
                     ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close")
            .bind(CODE_DEEP).bind(ts).bind(c)
            .execute(&pool).await.unwrap();
    }
    // 刷新 accurate cagg（覆盖 2024 窗口：种子在 01-01/01-02。D1 用 Asia/Shanghai 日界，
    // 2024-01-01 交易日的桶 ts = 2023-12-31 16:00 UTC，故窗口须扩展到其前，否则该桶不被刷新）
    for v in ["kline_accurate_5m", "kline_accurate_15m", "kline_accurate_1h", "kline_accurate_1d"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2023-12-31 00:00:00+00', '2024-01-04 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    for p in [Period::M1, Period::M5, Period::M15, Period::H1, Period::D1] {
        // 翻页（limit=1）从 2024-01-03 往回：cursor 持续前进、无重复、至少覆盖两个 2024 数据点。
        let mut cursor = Utc.with_ymd_and_hms(2024, 1, 3, 0, 0, 0).unwrap();
        let mut got: Vec<DateTime<Utc>> = Vec::new();
        for _ in 0..3 {
            let page = r.bars(p, CODE_DEEP, Some(cursor), 1).await.unwrap();
            assert!(page.len() <= 1, "{p:?} 翻页每页 ≤1（limit=1）");
            if page.is_empty() { break; }
            let t = page[0].ts;
            assert!(t < cursor, "{p:?} before 不含该 ts 本身");
            got.push(t);
            cursor = t;
        }
        assert!(got.len() >= 2, "{p:?} 深翻应覆盖两个 2024 数据点，实际 {got:?}");
        assert!(got.windows(2).all(|w| w[0] > w[1]), "{p:?} 降序翻页 cursor 严格前进");
        let distinct: std::collections::HashSet<_> = got.iter().collect();
        assert_eq!(distinct.len(), got.len(), "{p:?} 无重复数据点");
    }
    clean(&pool, CODE_DEEP).await;
}

#[tokio::test]
async fn symbols_with_latest_snapshot() {
    let pool = pool().await;
    clean(&pool, CODE_SYM).await;
    clean(&pool, CODE_SYM_EMPTY).await;
    seed(&pool, CODE_SYM).await;
    for (c, n) in [(CODE_SYM, "测试ETF"), (CODE_SYM_EMPTY, "无数据ETF")] {
        sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, $2) \
                     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
            .bind(c).bind(n).execute(&pool).await.unwrap();
    }
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();

    let s = rows.iter().find(|r| r.code == CODE_SYM).expect("含测试标的");
    assert_eq!(s.name.as_deref(), Some("测试ETF"));
    assert_eq!(s.last_close, Some(5.0));
    assert_eq!(s.prev_close, Some(4.0), "前一根 bar 收盘（涨跌幅输入）");
    assert!(s.last_ts.is_some());

    let empty = rows.iter().find(|r| r.code == CODE_SYM_EMPTY).expect("含无数据标的");
    assert!(empty.last_ts.is_none() && empty.last_close.is_none() && empty.prev_close.is_none(),
        "无 bar 标的 latest 字段全空（前端 — 占位）");
    clean(&pool, CODE_SYM).await;
    clean(&pool, CODE_SYM_EMPTY).await;
}

#[tokio::test]
async fn window_events_filters_window_and_maps_fields() {
    const SRC: &str = "storage_test_events";
    let pool = pool().await;
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
    let now = Utc::now();
    let rows_in = [
        (now - Duration::seconds(20), true, Some(120), None, None),
        (now - Duration::seconds(10), false, None, Some("timeout"), Some("518880")),
        (now - Duration::hours(2), true, Some(50), None, None),   // 窗口外
    ];
    for (ts, ok, lat, err, code) in rows_in {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms, err_kind, code) \
                     VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(ts).bind(SRC).bind(ok).bind(lat).bind(err).bind(code)
            .execute(&pool).await.unwrap();
    }
    let all = HealthEventReader::new(pool.clone()).window_events(3600).await.unwrap();
    let mine: Vec<_> = all.iter().filter(|r| r.source == SRC).collect();
    assert_eq!(mine.len(), 2, "窗口外事件不入选");
    assert!(mine[0].ts < mine[1].ts, "按 ts 升序");
    assert!(mine[0].ok && mine[0].latency_ms == Some(120) && mine[0].err_kind.is_none());
    assert!(!mine[1].ok && mine[1].err_kind.as_deref() == Some("timeout"));
    assert_eq!(mine[1].code.as_deref(), Some("518880"), "触发标的字段透传");
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
}

// ── Wave 2 Phase A：质量对照 / 节假日 / 事件区间 / 同步状态 / D3 merge 尾部优先级 ──

const CODE_QUAL: &str = "997731";
const CODE_LATEST: &str = "997741";

#[tokio::test]
async fn divergence_rows_join_code_filter_and_range() {
    let pool = pool().await;
    clean(&pool, CODE_QUAL).await;
    // raw 3 根（09:30-09:32 CST）；accurate 覆盖 09:30（close 不同）、09:31（相同）；09:32 无准确层
    for (i, c) in [(0i64, 10.10), (1, 10.0), (2, 10.0)] {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'webq_src') ON CONFLICT DO NOTHING")
            .bind(CODE_QUAL).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    for (i, c) in [(0i64, 10.0), (1, 10.0)] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0) ON CONFLICT DO NOTHING")
            .bind(CODE_QUAL).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());
    // code 过滤 + 仅重叠 ts（09:32 无准确层不入选）
    let rows = r.divergence_rows(Some(CODE_QUAL), base() - Duration::days(1),
        base() + Duration::days(1)).await.unwrap();
    let mine: Vec<_> = rows.iter().filter(|x| x.code == CODE_QUAL).collect();
    assert_eq!(mine.len(), 2, "raw ⋈ accurate 仅重叠 ts");
    assert!(mine[0].ts < mine[1].ts, "ts 升序");
    assert_eq!(mine[0].raw_close, 10.10);
    assert_eq!(mine[0].accurate_close, 10.0);
    assert_eq!(mine[0].raw_source.as_deref(), Some("webq_src"));
    // 区间 [from, to) 边界
    let narrow = r.divergence_rows(Some(CODE_QUAL), base() + Duration::minutes(1),
        base() + Duration::minutes(2)).await.unwrap();
    assert_eq!(narrow.len(), 1, "半开区间只含 09:31");
    // 无 code 过滤（source-accuracy 数据源）：至少含本测试行
    let all = r.divergence_rows(None, base() - Duration::days(1),
        base() + Duration::days(1)).await.unwrap();
    assert!(all.iter().any(|x| x.code == CODE_QUAL));
    clean(&pool, CODE_QUAL).await;
}

#[tokio::test]
async fn holidays_reader_reads_0008_seed() {
    let pool = pool().await;
    let h = HolidaysReader::new(pool).holidays().await.unwrap();
    assert!(h.contains(&NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()), "国庆在表");
    assert!(h.contains(&NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()), "元旦在表");
    assert!(h.len() >= 34, "2026 全量 34 行（迁移内嵌官方口径）");
}

#[tokio::test]
async fn events_between_and_sync_checkpoints() {
    const SRC: &str = "storage_test_range";
    let pool = pool().await;
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM sync_checkpoints WHERE code = $1")
        .bind(CODE_QUAL).execute(&pool).await.unwrap();
    let t0 = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 0).unwrap();
    for (i, ok) in [(0i64, true), (1, false), (2, true)] {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind, code) \
                     VALUES ($1, $2, $3, $4, $5)")
            .bind(t0 + Duration::minutes(i)).bind(SRC).bind(ok)
            .bind(if ok { None } else { Some("timeout") }).bind(Some(CODE_QUAL))
            .execute(&pool).await.unwrap();
    }
    // [from, to) 半开区间 + ts 升序
    let evs = HealthEventReader::new(pool.clone())
        .events_between(t0, t0 + Duration::minutes(2)).await.unwrap();
    let mine: Vec<_> = evs.iter().filter(|e| e.source == SRC).collect();
    assert_eq!(mine.len(), 2, "[from, to) 不含 to 边界行");
    assert!(mine[0].ts < mine[1].ts);
    assert!(!mine[1].ok && mine[1].err_kind.as_deref() == Some("timeout"));

    sqlx::query("INSERT INTO sync_checkpoints (code, period, last_synced_date) \
                 VALUES ($1, 'M1', '2026-09-03') ON CONFLICT (code, period) \
                 DO UPDATE SET last_synced_date = EXCLUDED.last_synced_date")
        .bind(CODE_QUAL).execute(&pool).await.unwrap();
    let cps = KlineReader::new(pool.clone()).sync_checkpoints().await.unwrap();
    let cp = cps.iter().find(|c| c.code == CODE_QUAL).expect("含测试检查点");
    assert_eq!(cp.period, "M1");
    assert_eq!(cp.last_synced_date, NaiveDate::from_ymd_opt(2026, 9, 3).unwrap());
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM sync_checkpoints WHERE code = $1")
        .bind(CODE_QUAL).execute(&pool).await.unwrap();
}

#[tokio::test]
async fn symbols_latest_d3_merge_tail_semantics() {
    // D3 重写语义锁定（merge 尾部 top-2）：
    // ① 准确层比 raw 更新 → 最新取准确层；② 同 ts 并列 → 准确层优先（merge 准确层优先语义）。
    let pool = pool().await;
    clean(&pool, CODE_LATEST).await;
    sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, 'D3测试') ON CONFLICT (code) DO NOTHING")
        .bind(CODE_LATEST).execute(&pool).await.unwrap();
    // raw：09:30(1.0)、09:31(2.0)；accurate：09:31 同 ts 覆盖(9.99) + 09:32 更新(8.88)
    for (i, c) in [(0i64, 1.0), (1, 2.0)] {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'webq_src') ON CONFLICT DO NOTHING")
            .bind(CODE_LATEST).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    for (i, c) in [(1i64, 9.99), (2, 8.88)] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0) ON CONFLICT DO NOTHING")
            .bind(CODE_LATEST).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();
    let s = rows.iter().find(|r| r.code == CODE_LATEST).expect("含测试标的");
    assert_eq!(s.last_ts, Some(base() + Duration::minutes(2)), "准确层更新的 ts 为最新");
    assert_eq!(s.last_close, Some(8.88));
    assert_eq!(s.prev_close, Some(9.99), "同 ts 并列准确层优先（raw 2.0 被掩盖）");
    clean(&pool, CODE_LATEST).await;
}

#[tokio::test]
async fn weekly_monthly_deep_scroll_before_2024() {
    // 修复问题①：W1/MO1 accurate cagg 全历史（0016 去掉 ts >= '2024-01-01' 过滤）。
    // 种子 pre-2024（2023）M1 → 周/月桶 <2024；refresh accurate cagg 后深翻应能翻到 <2024-01-01，
    // 且走 accurate（source='tushare'）而非兜底 kline_1d rollup（kline_1d 仅近 2 周数据，无 pre-2024 行）。
    // 〇 兜底保留：FALLBACK_1W/1MO 作为 accurate 缺失时的安全网（reader.rs 不删）；全历史 cagg 后 pre-2024
    //   也走 accurate，故本测试断言 source='tushare' 印证「pre-2024 走 accurate」。
    let pool = pool().await;
    clean(&pool, CODE_WM_DEEP).await;
    for (ts, c) in [
        (Utc.with_ymd_and_hms(2023, 1, 2, 1, 30, 0).unwrap(), 1.0),
        (Utc.with_ymd_and_hms(2023, 6, 5, 1, 30, 0).unwrap(), 2.0),
    ] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') \
                     ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
            .bind(CODE_WM_DEEP).bind(ts).bind(c)
            .execute(&pool).await.unwrap();
    }
    // refresh W1/MO1 cagg 覆盖 2023 桶（整桶起止须落窗内；周桶=2023-01-01 16:00 UTC / 2023-06-04 16:00 UTC；
    // 月桶=2022-12-31 16:00 UTC（1月）/2023-05-31 16:00 UTC（6月）。放宽窗口覆盖全部）。
    for v in ["kline_accurate_1w", "kline_accurate_1mo"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2022-12-01 00:00:00+00', '2023-07-01 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    let cutoff = Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap();
    let start = Utc.with_ymd_and_hms(2024, 1, 15, 0, 0, 0).unwrap();
    for p in [Period::W1, Period::MO1] {
        let mut cursor = start;
        let mut got: Vec<DateTime<Utc>> = Vec::new();
        for _ in 0..8 {
            let page = r.bars(p, CODE_WM_DEEP, Some(cursor), 1).await.unwrap();
            if page.is_empty() { break; }
            let b = &page[0];
            assert!(b.ts < cursor, "{p:?} before 不含该 ts 本身");
            assert_eq!(b.source.as_deref(), Some("tushare"), "{p:?} pre-2024 走 accurate cagg（0016 全历史）");
            got.push(b.ts);
            cursor = b.ts;
        }
        let before_cutoff = got.iter().filter(|t| **t < cutoff).count();
        assert!(before_cutoff >= 1, "{p:?} 深翻应覆盖 <2024-01-01 数据点，实际 {got:?}");
        assert!(got.windows(2).all(|w| w[0] > w[1]), "{p:?} 降序翻页 cursor 严格前进");
        let distinct: std::collections::HashSet<_> = got.iter().collect();
        assert_eq!(distinct.len(), got.len(), "{p:?} 无重复数据点");
    }
    clean(&pool, CODE_WM_DEEP).await;
}

#[tokio::test]
async fn high_period_forming_bucket_included_on_latest() {
    // 实时右缘：bars(None) 在日内周期合入「当前未闭合桶」（从最新 raw 聚合），而非停在上一闭合桶。
    // cagg(accurate/兜底) 只承载已闭合桶：5m 右缘落后至上一闭合桶（最多 ~5min）——本测试锁 forming 分支。
    const CODE_FORMING: &str = "997762";
    let pool = pool().await;
    clean(&pool, CODE_FORMING).await;
    // 从 DB now() 取当前 forming 5m 桶（避免测试进程与 DB 时钟偏移/跨桶竞态）。
    let row: (Option<DateTime<Utc>>,) = sqlx::query_as("SELECT time_bucket('5 minutes', now())")
        .fetch_one(&pool).await.unwrap();
    let fb = row.0.expect("forming 5m bucket");
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 10.0, 10.5, 9.9, 10.2, 300, 3000.0, 'webq_src') ON CONFLICT DO NOTHING")
        .bind(CODE_FORMING).bind(fb)
        .execute(&pool).await.unwrap();
    let r = KlineReader::new(pool.clone());
    let bars = r.bars(Period::M5, CODE_FORMING, None, 10).await.unwrap();
    let last = bars.last().expect("非空：forming 桶");
    assert_eq!(last.ts, fb, "M5 latest 含当前 forming 桶（右缘随 live 前进）");
    assert_eq!(last.open, 10.0);
    assert_eq!(last.high, 10.5);
    assert_eq!(last.low, 9.9);
    assert_eq!(last.close, 10.2);
    assert_eq!(last.volume, 300);
    assert!(last.source.is_none(), "forming 桶 source 与兜底同型（NULL，非 accurate）");
    // 游标分页（before=Some(fb)）不含 forming 桶（形成于 latest 私有分支，不回填到历史页）。
    let paged = r.bars(Period::M5, CODE_FORMING, Some(fb), 10).await.unwrap();
    assert!(paged.iter().all(|b| b.ts < fb), "before 游标不含 forming 桶");
    clean(&pool, CODE_FORMING).await;
}
```

## 4. web crate（Presentation 层）

> ⚠️ Wave 3 Phase 3c 加法：`crates/web/src/backtest.rs`（REST handlers + `BacktestWsSink`）为**非 tangle 手写**，
> 契约在 §1.5，组件在 lib.rs（`pub mod backtest;` + 本节 5 条回测路由）装配；`dto.rs`/`state.rs`/`ws.rs` 三块为 tangle 加法。

``` {.rust file=crates/web/src/lib.rs}
//! web —— Presentation：axum REST + WebSocket + SPA 静态托管（应用面，ADR-017）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

// alerts：页面⑦ 告警中心（Wave 2 Phase B 加法；代码块在 design/07-app-plane/02-alerts.md）
pub mod alerts;
// Wave 3 Phase 3c：回测 REST handlers + WS 进度 sink（§1.5；非 tangle 手写，web 依赖 application）
pub mod backtest;
pub mod dto;
pub mod rest;
pub mod settings; // 页面⑧ 系统设置 S1（08-settings.md；只读/运维端点）
// 11-sim-live / L3b：模拟实盘 REST handlers（§1.6；非 tangle 手写，web 依赖 application，与 MCP 共享 SimLiveService）
pub mod simlive;
pub mod spa;
pub mod state;
pub mod ws;

use axum::{routing::{get, patch, post, put}, Router};
use std::sync::Arc;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/healthz", get(rest::healthz))
        .route("/api/kline", get(rest::get_kline))
        // Phase C：symbols 写端点（注册 POST / 编辑 PATCH；无物理删除，03-symbols §4）
        .route("/api/symbols", get(rest::get_symbols).post(rest::register_symbol))
        .route("/api/symbols/{code}", patch(rest::update_symbol))
        // 看板收藏（Wave 3 页面①）：一键收藏 POST（幂等）/ 取消 DELETE（幂等）/ 拖拽排序 PUT
        .route("/api/symbols/{code}/favorite", post(rest::star_favorite).delete(rest::unstar_favorite))
        .route("/api/symbols/favorites/order", put(rest::reorder_favorites))
        .route("/api/sources/health", get(rest::get_sources_health))
        // Phase C：熔断手动复位（DB 控制通道，ADR-017）
        .route("/api/sources/{id}/reset", post(rest::reset_source))
        // Wave 2 Phase B：页面⑦ 告警中心（列表/确认/规则 CRUD；02-alerts.md）
        .route("/api/alerts", get(alerts::list_alerts))
        .route("/api/alerts/{id}/ack", post(alerts::ack_alert))
        .route("/api/alert-rules", get(alerts::list_rules).patch(alerts::patch_rule))
        // Wave 2 Phase A：页面④ 数据质量 + tushare 同步状态（04-quality.md §7；sync 手动触发暂缓，§1.4）
        .route("/api/quality/divergence", get(rest::get_quality_divergence))
        .route("/api/quality/source-accuracy", get(rest::get_quality_source_accuracy))
        .route("/api/quality/gaps", get(rest::get_quality_gaps))
        .route("/api/tushare/status", get(rest::get_tushare_status))
        // Wave 3 Phase 3c：回测（§1.5；strategies / submit / list / detail / delete / compare，handlers 在 backtest.rs）
        .route("/api/backtest/strategies", get(backtest::strategies))
        .route("/api/backtest/runs", get(backtest::list_runs).post(backtest::submit_run))
        .route("/api/backtest/runs/{id}", get(backtest::get_run).delete(backtest::delete_run))
        .route("/api/backtest/compare", get(backtest::compare_runs))
        // 11-sim-live / L3b：模拟实盘 web 面板（§1.6；handlers 在 simlive.rs，与 MCP 共享同一 SimLiveService）
        .route("/api/sim-live/state", get(simlive::state))
        .route("/api/sim-live/positions", get(simlive::positions))
        .route("/api/sim-live/orders", get(simlive::orders))
        .route("/api/sim-live/pnl", get(simlive::pnl))
        .route("/api/sim-live/strategies", get(simlive::strategies))
        .route("/api/sim-live/sessions", get(simlive::list_sessions))
        .route("/api/sim-live/sessions/{id}", get(simlive::get_session))
        .route("/api/sim-live/sessions/{id}/backtest-compare", post(simlive::backtest_compare))
        .route("/api/sim-live/place-order", post(simlive::place_order))
        .route("/api/sim-live/cancel-order", post(simlive::cancel_order))
        .route("/api/sim-live/start-session", post(simlive::start_session))
        .route("/api/sim-live/stop-session", post(simlive::stop_session))
        .route("/api/sim-live/trading", post(simlive::trading))
        .route("/api/sim-live/mcp-toggle", post(simlive::mcp_toggle))
        // 页面⑧ 系统设置 S1（08-settings.md §6）：系统信息 + 只读配置快照 + 危险运维
        .route("/api/system/info", get(settings::system_info))
        .route("/api/system/purge-raw", post(settings::purge_raw))
        .route("/api/system/reset-circuits", post(settings::reset_circuits))
        // S2：config 持久化 PATCH（GET 读持久 + PATCH 写；缺则默认）
        .route("/api/config/sources", get(settings::get_config_sources).patch(settings::patch_config_sources))
        .route("/api/config/collector", get(settings::get_config_collector).patch(settings::patch_config_collector))
        .route("/api/config/mcp", get(settings::get_config_mcp).patch(settings::patch_config_mcp))
        // 行情看板 MA 可配置（后端 W1：GET 读 / PUT 写归一化升序窗口；主图+宫格应用，回测弹窗不动）
        .route("/api/config/ma", get(rest::get_ma_config).put(rest::put_ma_config))
        // 行情看板 K线默认视口（后端 W1：GET /api/config/kline 读 / PUT 写 viewport_days；app_config 0021；缺省 2）
        .route("/api/config/kline", get(settings::get_config_kline).put(settings::put_config_kline))
        .route("/ws", get(ws::ws_handler))
        .fallback(spa::spa_fallback)
        .with_state(state)
}
```

``` {.rust file=crates/web/src/dto.rs}
//! REST/WS 线格式（serde DTO）与查询参数校验纯函数。

use chrono::{DateTime, Utc};
use domain::ports::{KlineBarView, RunView, SymbolLatestView};
use domain::types::Period;
use serde::{Deserialize, Serialize};

pub const MAX_LIMIT: i64 = 1000;

fn default_period() -> String { "1m".into() }
fn default_limit() -> i64 { 240 }
fn default_window() -> i64 { 3600 }

/// GET /api/kline 查询参数：before=游标（不含该 ts 的更早一页），limit 封顶 1000。
#[derive(Debug, Deserialize)]
pub struct KlineQuery {
    pub code: String,
    #[serde(default = "default_period")]
    pub period: String,
    pub before: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

/// 前端周期口径（06-web/01-dashboard 定稿）：1m/5m/15m/1h/1d；看板 W1 增 1w/1mo（周/月，用户定稿）。
/// ⚠️ 1m 已=分钟，故周/月用 1w/1mo（避免与 1m 混淆）；domain 变体名为 W1/MO1。仅看板读源，回测周期不扩。
pub fn parse_period(s: &str) -> Option<Period> {
    match s {
        "1m" => Some(Period::M1),
        "5m" => Some(Period::M5),
        "15m" => Some(Period::M15),
        "1h" => Some(Period::H1),
        "1d" => Some(Period::D1),
        "1w" => Some(Period::W1),
        "1mo" => Some(Period::MO1),
        _ => None,
    }
}

/// GET/PUT /api/config/ma 响应/请求体：MA 窗口列表（归一化升序去重，默认 [5,10,20]；主图+宫格应用，回测弹窗不动）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MaConfigDto {
    pub windows: Vec<i32>,
}

/// MA 窗口校验 + 归一化（纯函数，web handler 层 400 用）：
/// - 条目数 1..=3（最多 3 条 MA）
/// - 每条 1..=500 整数
/// - 归一化：去重（保留首次出现）+ 升序排序（升序/去重归一，存库前统一口径）
///
/// 失败返回描述性错误（handler `err(400, e)`）。
pub fn validate_ma_windows(windows: &[i32]) -> Result<Vec<i32>, String> {
    // count
    if windows.is_empty() { return Err("MA 至少 1 条".into()); }
    if windows.len() > 3 { return Err("MA 最多 3 条".into()); }
    for &w in windows {
        if !(1..=500).contains(&w) { return Err(format!("MA 窗口须为 1..=500 整数，不合规值：{w}")); }
    }
    // 归一化：去重（保持首次出现）+ 升序
    let mut out: Vec<i32> = Vec::new();
    for &w in windows {
        if !out.contains(&w) { out.push(w); }
    }
    out.sort_unstable();
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BarDto {
    pub ts: DateTime<Utc>,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
    pub amount: f64,
    /// 仅 1m merge 视图带来源；cagg 序列化时省略该键。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl From<&KlineBarView> for BarDto {
    fn from(r: &KlineBarView) -> Self {
        BarDto {
            ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close,
            volume: r.volume, amount: r.amount, source: r.source.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KlineResponse {
    pub code: String,
    pub period: String,
    pub bars: Vec<BarDto>,
    /// 下一页游标（本页最旧 ts）；None = 没有更早数据。
    pub next_before: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatestDto {
    pub ts: DateTime<Utc>,
    pub last: f64,
    /// 相对前一根 merge bar 收盘（%）；无前值 → None。
    pub change_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SymbolDto {
    pub code: String,
    pub name: Option<String>,
    pub interval_secs: i32,
    pub settlement: String,
    pub enabled: bool,
    pub latest: Option<LatestDto>,
    /// 仅 with_stats=1 时填充：当日（Asia/Shanghai 日界）kline_raw 行数（无 bar → 0）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub today_bars: Option<i64>,
    /// 是否收藏（Word 3 页面① 看板收藏；由 get_symbols handler 经 FavoriteStore.favorite_map 注入）。
    pub favorite: bool,
    /// 收藏排序（置顶/拖拽后 sort_order；非收藏 → None）。
    pub favorite_sort: Option<i32>,
}

impl From<&SymbolLatestView> for SymbolDto {
    fn from(r: &SymbolLatestView) -> Self {
        let latest = r.last_close.map(|last| LatestDto {
            ts: r.last_ts.expect("last_close 伴随 last_ts（同行 LATERAL 查询）"),
            last,
            change_pct: r.prev_close.filter(|p| *p != 0.0)
                .map(|p| (last - p) / p * 100.0),
        });
        SymbolDto {
            code: r.code.clone(), name: r.name.clone(), interval_secs: r.interval_secs,
            settlement: r.settlement.clone(), enabled: r.enabled, latest, today_bars: None,
            favorite: false, favorite_sort: None,
        }
    }
}

// ── Wave 3 页面① 看板收藏 DTO（favorite_symbols 表，0013）──

/// PUT /api/symbols/favorites/order 请求体：codes 顺序即收藏区展示顺序（可子集，须均为已收藏 code）。
#[derive(Debug, Deserialize)]
pub struct ReorderFavoritesReq {
    pub codes: Vec<String>,
}

/// GET /api/sources/health 查询参数。
#[derive(Debug, Deserialize)]
pub struct HealthQuery {
    #[serde(default = "default_window")]
    pub window_secs: i64,
}

// ── Wave 2 Phase A：数据质量（页面④）查询参数与校验纯函数 ──

/// GET /api/quality/divergence 查询参数。
#[derive(Debug, Deserialize)]
pub struct DivergenceQuery {
    pub code: String,
    pub from: String,
    pub to: String,
    pub threshold_pct: Option<f64>,
}

/// GET /api/quality/source-accuracy 查询参数（全标的，无 code）。
#[derive(Debug, Deserialize)]
pub struct SourceAccuracyQuery {
    pub from: String,
    pub to: String,
    pub threshold_pct: Option<f64>,
}

/// GET /api/quality/gaps 查询参数。
#[derive(Debug, Deserialize)]
pub struct GapsQuery {
    pub code: String,
    pub from: String,
    pub to: String,
}

/// YYYY-MM-DD 解析（前端日期控件口径；严格定长——chrono %Y-%m-%d 容忍未补零）。
pub fn parse_date(s: &str) -> Option<chrono::NaiveDate> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' { return None; }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// 阈值校验（%）：>0 且 ≤100。
pub fn validate_threshold(t: f64) -> Result<(), String> {
    if !(t > 0.0 && t <= 100.0) { return Err("threshold_pct 须在 (0, 100]".into()); }
    Ok(())
}

// ── Phase C：标的管理写端点与熔断复位 DTO/校验（§8 契约）──

/// GET /api/symbols 查询参数：with_stats=1 追加当日采集统计。
#[derive(Debug, Deserialize)]
pub struct SymbolsQuery {
    pub with_stats: Option<String>,
}

fn default_interval() -> i32 { 60 }
fn default_settlement() -> String { "T1".into() }
fn default_enabled() -> bool { true }

/// POST /api/symbols 请求体（缺省与 schema DEFAULT 同口径：60s / T1 / 启用）。
#[derive(Debug, Deserialize)]
pub struct RegisterSymbolReq {
    pub code: String,
    pub name: Option<String>,
    #[serde(default = "default_interval")]
    pub interval_secs: i32,
    #[serde(default = "default_settlement")]
    pub settlement: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// PATCH /api/symbols/{code} 请求体（None = 不改；code 主键不可改）。
#[derive(Debug, Deserialize)]
pub struct UpdateSymbolReq {
    pub name: Option<String>,
    pub interval_secs: Option<i32>,
    pub settlement: Option<String>,
    pub enabled: Option<bool>,
}

/// 校验错误分类：400 = 格式/取值错误；422 = 业务拒绝（北交所）。
#[derive(Debug, PartialEq, Eq)]
pub enum FieldError {
    BadRequest(String),
    Unprocessable(String),
}

/// code 校验（03-symbols §3）：6 位数字 → 市场前缀（复用 domain Code::market 契约，
/// 5/6/9→沪、0/1/2/3→深、4/8/920 北交所拒绝）。
pub fn validate_code(code: &str) -> Result<(), FieldError> {
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(FieldError::BadRequest("code 须为 6 位数字".into()));
    }
    domain::types::Code(code.into()).market().map_err(|_|
        FieldError::Unprocessable("北交所标的（4/8/920 前缀）暂不支持".into()))?;
    Ok(())
}

/// interval_secs 校验：下限 60（schema CHECK interval_secs>=60 同口径，双保险）。
pub fn validate_interval(secs: i32) -> Result<(), FieldError> {
    if secs < 60 {
        return Err(FieldError::BadRequest("interval_secs 下限 60（秒）".into()));
    }
    Ok(())
}

/// settlement 校验：T0/T1（schema CHECK 同口径）。
pub fn validate_settlement(s: &str) -> Result<(), FieldError> {
    if s != "T0" && s != "T1" {
        return Err(FieldError::BadRequest("settlement 须为 T0 或 T1".into()));
    }
    Ok(())
}

/// name 归一：空串/纯空白 → None。
pub fn normalize_name(name: Option<String>) -> Option<String> {
    name.and_then(|n| { let t = n.trim().to_string(); if t.is_empty() { None } else { Some(t) } })
}

// ── 页面⑧ 系统设置 S1（08-settings.md §6）：系统信息 / 运维 / 只读配置快照 DTO ──

/// 各应用面 crate 版本（由 app 装配注入；web 不依赖 collector/storage，纯 DI）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CrateVersions {
    pub collector: String,
    pub storage: String,
    pub diagnose: String,
}

/// GET /api/system/info 响应（只读；db_ok=false 表示进程在线但 DB 断开，非错误态）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SystemInfoDto {
    pub app_version: String,
    pub crate_versions: CrateVersions,
    pub db_ok: bool,
    pub uptime_secs: u64,
}

/// POST /api/system/purge-raw 与 reset-circuits 请求体（confirm 可选：
/// 缺失/不匹配 → 400 服务端拒绝；用 Option 而非必填，避免 axum Json 缺字段返回 422）。
#[derive(Debug, Deserialize)]
pub struct ConfirmReq {
    pub confirm: Option<String>,
}

/// POST /api/system/purge-raw 响应（rows_deleted=清理的 kline_raw 行数）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PurgeRawResultDto {
    pub rows_deleted: u64,
}

/// POST /api/system/reset-circuits 响应（requests=写入的熔断复位请求数）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResetCircuitsResultDto {
    pub requests: usize,
}

/// GET /api/config/sources 单源只读快照项。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceConfigItemDto {
    pub id: String,
    pub label: String,
    pub role: String,
    pub rate_per_sec: i64,
    pub jitter_ms: i64,
    pub circuit_fail_count: i64,
    pub backoff_steps: Vec<String>,
    pub enabled: bool,
    pub rotation_locked: bool,
}

/// GET /api/config/sources 响应（当前只读快照；S1 不落库，值为 SETTINGS_DEFAULTS 默认）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceConfigSnapshotDto {
    pub sources: Vec<SourceConfigItemDto>,
}

/// GET /api/config/collector 响应（交易时段写死只读）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CollectorConfigSnapshotDto {
    pub default_interval_sec: i64,
    pub trading_hours: String,
}

/// GET /api/config/mcp 响应（只读；交易工具默认关，开启需二次确认 ADR-009）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpConfigSnapshotDto {
    pub enabled: bool,
    pub trading_tools_enabled: bool,
    pub daily_limit_amount: i64,
    pub daily_limit_count: i64,
}

// ── 页面⑧ 系统设置 S2：配置持久化 PATCH 请求体 / 校验（08-settings.md §6 + 00-web-api.md config 契约）──
// 前端编辑 → PATCH /api/config/{sources,collector,mcp}；值域校验（非法 → 400）、
// 东财末位（ADR-006）、≥60（collector 间隔）、≥0（限额）在 web 层完成；storage ConfigStore 只存 jsonb。

/// PATCH /api/config/sources 单源可编辑参数（label/role/rotation_locked 由服务端按 SOURCE_CONFIG 派生）；
/// 轮转序 = sources 数组顺序；push2delay（东财系）必须为末位（ADR-006 服务端校验）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceConfigPatchItemDto {
    pub id: String,
    pub rate_per_sec: i64,
    pub jitter_ms: i64,
    pub circuit_fail_count: i64,
    pub backoff_steps: Vec<String>,
    pub enabled: bool,
}

/// PATCH /api/config/sources 请求体：完整源清单（含轮转序）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SourceConfigPatchDto {
    pub sources: Vec<SourceConfigPatchItemDto>,
}

/// PATCH /api/config/collector 请求体（交易时段写死只读，不可改）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectorConfigPatchDto {
    pub default_interval_sec: i64,
}

/// PATCH /api/config/mcp 请求体（总开关/交易工具/每日限额）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpConfigPatchDto {
    pub enabled: bool,
    pub trading_tools_enabled: bool,
    pub daily_limit_amount: i64,
    pub daily_limit_count: i64,
}

/// 单源可编辑参数值域校验（纯函数，单元可测）：速率/抖动/熔断次数 ≥0；退避档位非空且每档非空字符串。
pub fn validate_source_config_item(it: &SourceConfigPatchItemDto) -> Result<(), String> {
    if it.id.trim().is_empty() { return Err("源 id 不能为空".into()); }
    if it.rate_per_sec < 0 { return Err(format!("源 {} 速率 rate_per_sec 须 ≥0", it.id)); }
    if it.jitter_ms < 0 { return Err(format!("源 {} 抖动 jitter_ms 须 ≥0", it.id)); }
    if it.circuit_fail_count < 0 { return Err(format!("源 {} 熔断次数 circuit_fail_count 须 ≥0", it.id)); }
    if it.backoff_steps.is_empty() { return Err(format!("源 {} 退避档位不能为空", it.id)); }
    if it.backoff_steps.iter().any(|b| b.trim().is_empty()) {
        return Err(format!("源 {} 退避档位含空字符串", it.id));
    }
    Ok(())
}

/// sources 清单校验（纯函数）：全部为已知内置源、无重复 id、每源值域合法、含全部内置源、
/// push2delay（东财系）必须为末位（ADR-006）。失败返回描述性错误（handler `err(400, e)`）。
pub fn validate_source_config(dto: &SourceConfigPatchDto) -> Result<(), String> {
    if dto.sources.is_empty() { return Err("源清单不能为空".into()); }
    let mut seen = std::collections::HashSet::new();
    for it in &dto.sources {
        if !RESET_SOURCES.contains(&it.id.as_str()) { return Err(format!("未知源 id：{}", it.id)); }
        if !seen.insert(it.id.clone()) { return Err(format!("源 id 重复：{}", it.id)); }
        validate_source_config_item(it)?;
    }
    // 必须包含全部内置真实源（完整轮转序），否则视为残缺
    for id in RESET_SOURCES {
        if !seen.contains(*id) { return Err(format!("源清单缺 {}（须为完整内置源清单）", id)); }
    }
    // 东财末位（ADR-006）：push2delay 必须为最后一个元素
    if dto.sources.last().map(|s| s.id.as_str()) != Some("push2delay") {
        return Err("轮转序违规：push2delay（东财系）必须为末位（ADR-006）".into());
    }
    Ok(())
}

/// collector 间隔校验（纯函数）：≥60 秒（全局默认抓取间隔下界）。
#[allow(dead_code)]
pub fn verify_collector_interval(sec: i64) -> Result<(), String> {
    if sec < 60 { return Err(format!("default_interval_sec 须 ≥60，收到 {sec}")); }
    Ok(())
}

/// MCP 限额校验（纯函数）：金额/笔数 ≥0。
#[allow(dead_code)]
pub fn verify_mcp_daily_limit(m: &McpConfigPatchDto) -> Result<(), String> {
    if m.daily_limit_amount < 0 { return Err(format!("daily_limit_amount 须 ≥0，收到 {}", m.daily_limit_amount)); }
    if m.daily_limit_count < 0 { return Err(format!("daily_limit_count 须 ≥0，收到 {}", m.daily_limit_count)); }
    Ok(())
}

/// 熔断复位内置源清单（reset-circuits 全部源；非近似变体，即数据面真实注册源）。
/// 顺序与 rotation（SOURCE_CONFIG）一致：push2delay（东财系，ADR-006）锁定末位。
pub const RESET_SOURCES: &[&str] = &[
    "tencent_ifzq", "sina_jsonp", "tencent_qt", "sina_hq",
    "ths_cs", "exchange", "tushare", "push2delay",
];

// ── Wave 3 Phase 3c：回测（§1.5；DTO 与校验纯函数）──

fn default_backtest_params() -> serde_json::Value { serde_json::json!({}) }

/// POST /api/backtest/runs 请求体（from/to 为 RFC3339 字符串，handler 解析为 DateTime<Utc>）。
#[derive(Debug, Deserialize)]
pub struct BacktestSubmitReq {
    pub code: String,
    /// M1/M5/M15/D1（H1 回测不支持）。
    pub period: String,
    pub from: String,
    pub to: String,
    pub strategy_id: String,
    /// 单点策略参数（缺省 `{}`；`params_grid` 场景下作为公共基础参数）。
    #[serde(default = "default_backtest_params")]
    pub params: serde_json::Value,
    /// 参数网格 `{k: "起:止:步长"}`（缺省 None = 单 run）。
    #[serde(default)]
    pub params_grid: Option<serde_json::Value>,
    /// 费用 `{rate_pct, min_fee, slippage_bp}`。
    pub fee: serde_json::Value,
    /// 初始资金（缺省 100_000，ADR §4）。
    #[serde(default)]
    pub initial_capital: Option<f64>,
}

/// 回测周期校验：M1/M5/M15/D1（H1 回测不支持，08-backtest §3）。
pub fn validate_backtest_period(s: &str) -> Result<(), FieldError> {
    match s {
        "M1" | "M5" | "M15" | "D1" => Ok(()),
        other => Err(FieldError::BadRequest(format!("period 须为 M1/M5/M15/D1，实际 {other}"))),
    }
}

/// 校验提交体至少含 params 或 params_grid 之一（§1.5：二选一）。
pub fn validate_backtest_params_present(
    params: &serde_json::Value,
    params_grid: &Option<serde_json::Value>,
) -> Result<(), FieldError> {
    if params_grid.is_none() && params.is_null() {
        return Err(FieldError::BadRequest("params 或 params_grid 必填其一".into()));
    }
    Ok(())
}

/// 费用校验：`{rate_pct, min_fee, slippage_bp}` 三字段必须齐、均为数值。
pub fn validate_backtest_fee(fee: &serde_json::Value) -> Result<(), FieldError> {
    let obj = fee.as_object().ok_or_else(|| FieldError::BadRequest("fee 应为对象".into()))?;
    for key in ["rate_pct", "min_fee", "slippage_bp"] {
        match obj.get(key) {
            Some(v) if v.is_number() => {}
            Some(_) => return Err(FieldError::BadRequest(format!("fee.{key} 应为数值"))),
            None => return Err(FieldError::BadRequest(format!("fee.{key} 缺失"))),
        }
    }
    Ok(())
}

/// GET /api/backtest/runs 查询参数（status/group_id 均可选）。limit/offset 分页：limit 默认 100 封顶 500（handler 内 clamp）。
#[derive(Debug, Deserialize)]
pub struct BacktestListQuery {
    pub status: Option<String>,
    pub group_id: Option<String>,
    #[serde(default = "default_backtest_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_backtest_limit() -> i64 { 100 }

/// GET /api/backtest/runs 列表单页上限（handler 以 `limit.clamp(1, MAX_BACKTEST_LIMIT)` 归一）。
pub const MAX_BACKTEST_LIMIT: i64 = 500;

/// GET /api/backtest/compare 查询参数（ids 逗号分隔）。
#[derive(Debug, Deserialize)]
pub struct BacktestCompareQuery {
    pub ids: String,
}

/// 解析 `ids=1,2,3` 为 `Vec<i64>`；空/含非数字 → FieldError。
pub fn parse_backtest_ids(s: &str) -> Result<Vec<i64>, FieldError> {
    let mut out = Vec::new();
    for part in s.split(',') {
        let t = part.trim();
        if t.is_empty() { continue; } // 容忍尾部/重复逗号
        match t.parse::<i64>() {
            Ok(v) => out.push(v),
            Err(_) => return Err(FieldError::BadRequest(format!("ids 含非数字: {t}"))),
        }
    }
    if out.is_empty() {
        return Err(FieldError::BadRequest("ids 必填（逗号分隔的 run id）".into()));
    }
    Ok(out)
}

/// 回测 run 读模型（GET /api/backtest/runs、/{id}、compare 响应项）。
/// B1 增补：initial_capital/date_from/date_to（迁移 0012 持久化；前端展示区间）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BacktestRunDto {
    pub id: i64,
    pub code: String,
    pub period: String,
    pub strategy_id: String,
    pub params: serde_json::Value,
    pub fee: serde_json::Value,
    pub initial_capital: f64,
    pub date_from: DateTime<Utc>,
    pub date_to: DateTime<Utc>,
    pub status: String,
    pub progress: i32,
    pub current_ts: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trades: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<serde_json::Value>,
}

impl From<&RunView> for BacktestRunDto {
    fn from(r: &RunView) -> Self {
        let result = r.result.as_ref();
        BacktestRunDto {
            id: r.id,
            code: r.code.clone(),
            period: r.period.clone(),
            strategy_id: r.strategy_id.clone(),
            params: r.params.clone(),
            fee: r.fee.clone(),
            initial_capital: r.initial_capital,
            date_from: r.date_from,
            date_to: r.date_to,
            status: r.status.as_str().to_string(),
            progress: r.progress,
            current_ts: r.current_ts,
            created_at: r.created_at,
            finished_at: r.finished_at,
            error: r.error.clone(),
            group_id: r.group_id.clone(),
            net_value: result.map(|res| res.net_value.clone()),
            trades: result.map(|res| res.trades.clone()),
            metrics: result.map(|res| res.metrics.clone()),
        }
    }
}

/// 策略目录项（GET /api/backtest/strategies）。params_schema 直通 backtest::ParamDef 的 JSON 形态。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BacktestStrategyDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub params_schema: Vec<serde_json::Value>,
}

/// 8 项绩效指标（BacktestMetrics 的 jsonb 形态；供前端/测试类型化解析）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetricsDto {
    pub net_profit: f64,
    pub max_drawdown: f64,
    pub sharpe: f64,
    pub win_rate: f64,
    pub profit_factor: f64,
    pub annualized_return: f64,
    pub trade_count: usize,
    pub avg_hold_bars: f64,
}

/// 单笔交易（TradeDetail 的 jsonb 形态）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TradeDto {
    pub open_ts: i64,
    pub close_ts: i64,
    pub open_bar: usize,
    pub close_bar: usize,
    pub open_price: f64,
    pub close_price: f64,
    pub shares: f64,
    pub gross_value: f64,
    pub commission: f64,
    pub stamp_duty: f64,
    pub pnl: f64,
    pub hold_bars: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_period_front_contract() {
        assert_eq!(parse_period("1m"), Some(Period::M1));
        assert_eq!(parse_period("5m"), Some(Period::M5));
        assert_eq!(parse_period("15m"), Some(Period::M15));
        assert_eq!(parse_period("1h"), Some(Period::H1));
        assert_eq!(parse_period("1d"), Some(Period::D1));
        // 看板 W1 增 周/月：1w/1mo（1m 已=分钟，避免歧义）；回测周期不扩。
        assert_eq!(parse_period("1w"), Some(Period::W1));
        assert_eq!(parse_period("1mo"), Some(Period::MO1));
        assert_eq!(parse_period("3m"), None);
        assert_eq!(parse_period("M1"), None, "domain 变体名不是前端口径");
        assert_eq!(parse_period("1m"), Some(Period::M1), "1m 仍=分钟，不与月混淆");
    }

    #[test]
    fn ma_windows_validation_and_normalize() {
        // 合法：升序去重归一化
        assert_eq!(validate_ma_windows(&[5, 10, 20]).unwrap(), vec![5, 10, 20]);
        assert_eq!(validate_ma_windows(&[20, 5, 10]).unwrap(), vec![5, 10, 20], "乱序归一化升序");
        assert_eq!(validate_ma_windows(&[5, 5, 10]).unwrap(), vec![5, 10], "去重");
        assert_eq!(validate_ma_windows(&[1]).unwrap(), vec![1], "最少 1 条");
        assert_eq!(validate_ma_windows(&[500]).unwrap(), vec![500], "上界 500");
        // 非法：条目数
        assert!(validate_ma_windows(&[]).is_err(), "至少 1 条");
        assert!(validate_ma_windows(&[5, 10, 20, 30]).is_err(), "最多 3 条");
        // 非法：量纲
        assert!(validate_ma_windows(&[0]).is_err());
        assert!(validate_ma_windows(&[501]).is_err());
        assert!(validate_ma_windows(&[-1]).is_err());
    }

    #[test]
    fn ma_config_dto_roundtrip() {
        let dto = MaConfigDto { windows: vec![5, 10, 20] };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["windows"][0], 5);
        let back: MaConfigDto = serde_json::from_value(v).unwrap();
        assert_eq!(back.windows, vec![5, 10, 20]);
    }

    // ── 页面⑧ S2：配置持久化 PATCH 校验纯函数（值域 / 东财末位 ADR-006 / ≥60 / ≥0）──

    fn patch_item(id: &str) -> SourceConfigPatchItemDto {
        SourceConfigPatchItemDto {
            id: id.into(), rate_per_sec: 1, jitter_ms: 0, circuit_fail_count: 3,
            backoff_steps: vec!["5s".into(), "10s".into(), "30s".into()], enabled: true,
        }
    }

    /// 完整合法 sources 清单（前 7 真实源 + push2delay 末位，ADR-006）。
    fn valid_sources_patch() -> SourceConfigPatchDto {
        let mut items: Vec<SourceConfigPatchItemDto> = RESET_SOURCES
            .iter().filter(|s| **s != "push2delay").map(|s| patch_item(s)).collect();
        items.push(patch_item("push2delay")); // 末位
        SourceConfigPatchDto { sources: items }
    }

    #[test]
    fn source_config_patch_validation_ok() {
        assert!(validate_source_config(&valid_sources_patch()).is_ok(), "完整且东财末位 → 合法");
    }

    #[test]
    fn source_config_patch_validation_rejects_bad_values() {
        // rate<0
        let mut p = valid_sources_patch();
        p.sources[0].rate_per_sec = -1;
        assert!(validate_source_config(&p).is_err(), "rate<0 → 拒绝");
        // jitter<0
        let mut p = valid_sources_patch();
        p.sources[0].jitter_ms = -1;
        assert!(validate_source_config(&p).is_err());
        // circuit<0
        let mut p = valid_sources_patch();
        p.sources[0].circuit_fail_count = -1;
        assert!(validate_source_config(&p).is_err());
        // 空退避
        let mut p = valid_sources_patch();
        p.sources[0].backoff_steps = vec![];
        assert!(validate_source_config(&p).is_err());
    }

    #[test]
    fn source_config_patch_validation_rejects_eastmoney_not_last() {
        // push2delay 挪到非末位（首元素）→ 拒（ADR-006）
        let mut p = valid_sources_patch();
        let push = p.sources.remove(p.sources.len() - 1);
        p.sources.insert(0, push);
        assert!(validate_source_config(&p).is_err(), "push2delay 非末位 → 拒（ADR-006）");
    }

    #[test]
    fn source_config_patch_validation_rejects_unknown_dup_missing() {
        // 未知源
        let mut p = valid_sources_patch();
        p.sources[0].id = "not_a_source".into();
        assert!(validate_source_config(&p).is_err(), "未知源 id → 拒");
        // 重复 id
        let mut p = valid_sources_patch();
        p.sources[1].id = p.sources[0].id.clone();
        assert!(validate_source_config(&p).is_err(), "重复 id → 拒");
        // 缺内置源（末位后仍保留 push2delay，但缺某真实源）
        let mut p = valid_sources_patch();
        p.sources.retain(|s| !s.id.is_empty());
        let missing = p.sources.remove(0); // 移除首元素
        assert!(validate_source_config(&p).is_err(), "缺内置源 → 拒");
        let _ = missing;
    }

    #[test]
    fn source_config_patch_item_value_domain() {
        assert!(validate_source_config_item(&patch_item("tencent_ifzq")).is_ok());
        let mut it = patch_item("x");
        it.rate_per_sec = -5;
        assert!(validate_source_config_item(&it).is_err());
        let mut it = patch_item("x");
        it.jitter_ms = -1;
        assert!(validate_source_config_item(&it).is_err());
        let mut it = patch_item("x");
        it.circuit_fail_count = -1;
        assert!(validate_source_config_item(&it).is_err());
    }

    #[test]
    fn collector_interval_validation() {
        assert!(verify_collector_interval(60).is_ok());
        assert!(verify_collector_interval(120).is_ok());
        assert!(verify_collector_interval(59).is_err(), "<60 → 拒");
        assert!(verify_collector_interval(0).is_err());
    }

    #[test]
    fn mcp_daily_limit_validation() {
        let ok = McpConfigPatchDto { enabled: true, trading_tools_enabled: false,
            daily_limit_amount: 50000, daily_limit_count: 20 };
        assert!(verify_mcp_daily_limit(&ok).is_ok());
        let mut bad = McpConfigPatchDto { enabled: true, trading_tools_enabled: false,
            daily_limit_amount: -1, daily_limit_count: 20 };
        assert!(verify_mcp_daily_limit(&bad).is_err(), "金额<0 → 拒");
        bad.daily_limit_amount = 100;
        bad.daily_limit_count = -1;
        assert!(verify_mcp_daily_limit(&bad).is_err(), "笔数<0 → 拒");
    }

    #[test]
    fn kline_response_json_shape() {
        let resp = KlineResponse { code: "518880".into(), period: "1m".into(), bars: vec![],
            next_before: None };
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["code"], "518880");
        assert!(v["next_before"].is_null(), "无更早数据 → 显式 null（前端停拉信号）");
    }

    #[test]
    fn symbol_without_bars_serializes_null_latest() {
        let row = SymbolLatestView { code: "997702".into(), name: None, interval_secs: 60,
            settlement: "T1".into(), enabled: true,
            last_ts: None, last_close: None, prev_close: None };
        let v = serde_json::to_value(SymbolDto::from(&row)).unwrap();
        assert!(v["latest"].is_null());
        assert!(v.get("today_bars").is_none(), "非 with_stats 请求不出 today_bars 键");
    }

    // ── Wave 3 页面① 看板收藏 DTO（favorite/favorite_sort 恒输出；ReorderFavoritesReq 反序列化）──

    #[test]
    fn symbol_dto_favorite_fields_always_serialize() {
        // 非收藏 → favorite=false, favorite_sort=null（Always 输出，前端置顶 UI 依据）
        let row = SymbolLatestView { code: "997702".into(), name: None, interval_secs: 60,
            settlement: "T1".into(), enabled: true,
            last_ts: None, last_close: None, prev_close: None };
        let v = serde_json::to_value(SymbolDto::from(&row)).unwrap();
        assert_eq!(v["favorite"], false);
        assert!(v["favorite_sort"].is_null());
        // 收藏标注（handler 注入）：favorite=true, favorite_sort=1
        let mut dto = SymbolDto::from(&row);
        dto.favorite = true;
        dto.favorite_sort = Some(1);
        let v2 = serde_json::to_value(&dto).unwrap();
        assert_eq!(v2["favorite"], true);
        assert_eq!(v2["favorite_sort"], 1);
    }

    #[test]
    fn reorder_favorites_req_deserialize() {
        let req: ReorderFavoritesReq = serde_json::from_str(r#"{"codes":["600519","518880"]}"#).unwrap();
        assert_eq!(req.codes, vec!["600519", "518880"]);
        // 空数组可接受（无收藏 → 空重排，无需收藏 400）
        let empty: ReorderFavoritesReq = serde_json::from_str(r#"{"codes":[]}"#).unwrap();
        assert!(empty.codes.is_empty());
    }

    // ── Phase C：symbols 写端点校验（03-symbols §3 口径 + schema CHECK 对齐）──

    #[test]
    fn validate_code_format_and_market() {
        assert!(validate_code("600519").is_ok(), "沪");
        assert!(validate_code("159915").is_ok(), "深");
        assert!(validate_code("518880").is_ok());
        assert!(matches!(validate_code("60051"), Err(FieldError::BadRequest(_))), "非 6 位");
        assert!(matches!(validate_code("60051a"), Err(FieldError::BadRequest(_))), "非数字");
        assert!(matches!(validate_code(""), Err(FieldError::BadRequest(_))));
        for bse in ["430001", "830799", "920001"] {
            assert!(matches!(validate_code(bse), Err(FieldError::Unprocessable(_))),
                "{bse} 北交所前缀 → 422");
        }
    }

    #[test]
    fn validate_interval_and_settlement() {
        assert!(validate_interval(60).is_ok());
        assert!(validate_interval(300).is_ok());
        assert!(matches!(validate_interval(59), Err(FieldError::BadRequest(_))),
            "下限 60（schema CHECK 同口径）");
        assert!(validate_settlement("T0").is_ok());
        assert!(validate_settlement("T1").is_ok());
        assert!(matches!(validate_settlement("T2"), Err(FieldError::BadRequest(_))));
        assert!(matches!(validate_settlement("t0"), Err(FieldError::BadRequest(_))));
    }

    #[test]
    fn normalize_name_and_register_defaults() {
        assert_eq!(normalize_name(Some("  黄金ETF  ".into())), Some("黄金ETF".into()));
        assert_eq!(normalize_name(Some("   ".into())), None);
        assert_eq!(normalize_name(None), None);
        let req: RegisterSymbolReq = serde_json::from_str(r#"{"code":"600519"}"#).unwrap();
        assert_eq!(req.interval_secs, 60, "缺省 60s（schema DEFAULT 同口径）");
        assert_eq!(req.settlement, "T1");
        assert!(req.enabled);
        assert!(req.name.is_none());
    }

    // ── Wave 2 Phase A：质量端点查询参数校验 ──

    #[test]
    fn parse_date_and_threshold_validation() {
        assert_eq!(parse_date("2026-09-03").unwrap(),
            chrono::NaiveDate::from_ymd_opt(2026, 9, 3).unwrap());
        assert!(parse_date("2026/09/03").is_none());
        assert!(parse_date("2026-9-3").is_none(), "严格 %Y-%m-%d");
        assert!(parse_date("").is_none());
        assert!(validate_threshold(0.5).is_ok());
        assert!(validate_threshold(0.3).is_ok());
        assert!(validate_threshold(0.0).is_err());
        assert!(validate_threshold(-1.0).is_err());
        assert!(validate_threshold(100.0).is_ok());
        assert!(validate_threshold(100.1).is_err());
    }

    #[test]
    fn backtest_period_fee_and_params_validation() {
        assert!(validate_backtest_period("M1").is_ok());
        assert!(validate_backtest_period("D1").is_ok());
        assert!(matches!(validate_backtest_period("H1"), Err(FieldError::BadRequest(_))));
        assert!(matches!(validate_backtest_period("1m"), Err(FieldError::BadRequest(_))), "前端 1m 非回测口径");

        let ok = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
        assert!(validate_backtest_fee(&ok).is_ok());
        let missing = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0});
        assert!(matches!(validate_backtest_fee(&missing), Err(FieldError::BadRequest(_))));
        let nonnum = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": "2"});
        assert!(matches!(validate_backtest_fee(&nonnum), Err(FieldError::BadRequest(_))));
        assert!(matches!(validate_backtest_fee(&serde_json::json!(42)), Err(FieldError::BadRequest(_))));

        assert!(validate_backtest_params_present(&serde_json::json!({}), &None).is_ok());
        assert!(validate_backtest_params_present(&serde_json::json!({}), &Some(serde_json::json!({}))).is_ok());
        assert!(matches!(
            validate_backtest_params_present(&serde_json::Value::Null, &None),
            Err(FieldError::BadRequest(_))
        ), "无 params 且无 params_grid → 400");
    }

    #[test]
    fn backtest_parse_ids() {
        assert_eq!(parse_backtest_ids("1,2,3").unwrap(), vec![1, 2, 3]);
        assert_eq!(parse_backtest_ids("1, 2 ,3").unwrap(), vec![1, 2, 3], "容忍空格");
        assert_eq!(parse_backtest_ids("1,,2").unwrap(), vec![1, 2], "容忍空段");
        assert!(matches!(parse_backtest_ids(""), Err(FieldError::BadRequest(_))));
        assert!(matches!(parse_backtest_ids("abc"), Err(FieldError::BadRequest(_))));
    }

    #[test]
    fn backtest_dto_json_shapes() {
        // RunView → BacktestRunDto（status 用 as_str()，result 未完成时结果字段 None 跳过序列化）
        let v = serde_json::to_value(BacktestRunDto::from(&RunView {
            id: 7, code: "600000".into(), period: "D1".into(), strategy_id: "dual_ma".into(),
            params: serde_json::json!({}), fee: serde_json::json!({}),
            initial_capital: 100_000.0,
            date_from: chrono::Utc::now(), date_to: chrono::Utc::now(),
            status: domain::ports::RunStatus::Pending, progress: 0, current_ts: None,
            created_at: chrono::Utc::now(), finished_at: None, error: None, group_id: None, result: None,
        })).unwrap();
        assert_eq!(v["status"], "pending");
        assert_eq!(v["initial_capital"], 100_000.0);
        assert!(v.get("date_from").is_some(), "date_from 输出（B1 持久化展示）");
        assert!(v.get("date_to").is_some());
        assert!(v.get("net_value").is_none(), "未完成不输出 net_value 键");
        assert!(v.get("metrics").is_none());

        // 策略目录 DTO：params_schema 为数组直通
        let s = BacktestStrategyDto { id: "dual_ma".into(), name: "双均线".into(),
            description: "d".into(), params_schema: vec![serde_json::json!({"key": "fast"})] };
        let sv = serde_json::to_value(&s).unwrap();
        assert_eq!(sv["id"], "dual_ma");
        assert_eq!(sv["params_schema"][0]["key"], "fast");

        // Metrics/Trade DTO 可反序列化（锁定 jsonb 字段名）
        let m: MetricsDto = serde_json::from_value(serde_json::json!({
            "net_profit": 8.9, "max_drawdown": 0.1, "sharpe": 4.58, "win_rate": 0.5,
            "profit_factor": 2.0, "annualized_return": 214.0, "trade_count": 2, "avg_hold_bars": 2.5,
        })).unwrap();
        assert_eq!(m.trade_count, 2);
        let t: TradeDto = serde_json::from_value(serde_json::json!({
            "open_ts": 0, "close_ts": 1, "open_bar": 0, "close_bar": 1, "open_price": 1.0,
            "close_price": 1.1, "shares": 100.0, "gross_value": 110.0, "commission": 0.1,
            "stamp_duty": 0.05, "pnl": 9.9, "hold_bars": 1,
        })).unwrap();
        assert_eq!(t.pnl, 9.9);
    }
}
```

``` {.rust file=crates/web/src/state.rs}
//! 应用状态：DI 装配产物（app crate 注入具体实现）。
//! 分层红线（Phase A 审查返工）：web 只见 domain 端口 + diagnose 服务，不依赖 storage/sqlx。

use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    /// K线只读端口（domain::ports::KlineRead；具体实现由 app 装配，storage 提供）。
    pub kline: Arc<dyn domain::ports::KlineRead>,
    /// 健康查询服务（diagnose；内部注入 domain::ports::HealthEventsRead）。
    pub health: diagnose::health::HealthService,
    /// 标的管理写端口（Phase C：POST/PATCH /api/symbols；DB 控制通道，ADR-017）。
    pub symbols_admin: Arc<dyn domain::ports::SymbolAdminWrite>,
    /// 标的当日统计只读端口（Phase C：GET /api/symbols?with_stats=1）。
    pub symbol_stats: Arc<dyn domain::ports::SymbolStatsRead>,
    /// 熔断复位写端口（Phase C：POST /api/sources/{id}/reset；DB 控制通道）。
    pub resets: Arc<dyn domain::ports::CircuitResetWrite>,
    /// 数据质量服务（Wave 2 Phase A：diagnose::quality，页面④ 三端点 + tushare status 数据源）。
    pub quality: diagnose::quality::QualityService,
    /// 告警引擎服务（Wave 2 Phase B：alert crate，Application 层；02-alerts.md）。
    /// 评估节拍由 web::alerts::AlertEvaluator 驱动；本字段供 REST handlers 查询/确认/规则调整。
    pub alerts: alert::engine::AlertService,
    /// 页面⑧ 系统信息数据源（S1：版本/DB 探测/运行时长；08-settings.md）。
    pub system_info: crate::settings::SystemInfoSource,
    /// 页面⑧ raw 层清空端口（S1：POST /api/system/purge-raw；08-settings.md）。
    pub raw_purge: Arc<dyn domain::ports::RawPurgePort>,
    /// 回测服务（Wave 3 Phase 3c：application 层 BacktestService，§1.5；app bin 装配）。
    pub backtest: Arc<application::service::BacktestService>,
    /// 回测 WS 进度分发 sink（Wave 3 Phase 3c：web 实现 domain::ports::BacktestProgressSink，§1.5）。
    pub backtest_ws: Arc<dyn domain::ports::BacktestProgressSink>,
    /// 看板收藏端口（Wave 3 页面①：FavoriteStore，favorite_symbols 表，0013；POST/DELETE/PUT 收藏端点 + /api/symbols 注入）。
    pub favorites: Arc<dyn domain::ports::FavoriteStore>,
    /// 行情看板 MA 可配置端口（后端 W1：MaConfigStore，ma_config 表，0015；GET/PUT /api/config/ma——主图+宫格应用，回测弹窗不动）。
    pub ma_config: Arc<dyn domain::ports::MaConfigStore>,
    /// 页面⑧ 系统设置 S2 配置持久化端口（ConfigStore，app_config 表，0021：sources/collector/mcp 三块；GET 读持久 + PATCH 写）。
    pub config: Arc<dyn domain::ports::ConfigStore>,
    /// 模拟实盘服务（11-sim-live / L3b：web 面板 /api/sim-live/*；与 MCP 共享同一 SimLiveService 实例）。
    /// `None` = 未配置，/api/sim-live/* 返回 503。storage::sim::PgSimSessionStore 由 app bin 装配。
    pub sim: Option<Arc<application::simlive::SimLiveService>>,
    pub static_dir: PathBuf,
    /// /api/sources/health 与 WS health 推送的默认窗口（秒）。
    pub health_window_secs: i64,
    pub hub: crate::ws::WsHub,
    pub subs: crate::ws::SubscriptionRegistry,
}
```

``` {.rust file=crates/web/src/rest.rs}
//! REST 端点处理（契约见本文档 §1.1）。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use domain::ports::{SymbolAdminInput, SymbolPatch};
use std::sync::Arc;

use crate::dto::*;
use crate::state::AppState;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "rest handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// GET /healthz —— 存活探测（compose healthcheck 经 --self-check 调此路由）。
pub async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

pub async fn get_kline(State(st): State<Arc<AppState>>, Query(q): Query<KlineQuery>) -> Response {
    if q.code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 必填"); }
    let Some(period) = parse_period(&q.period) else {
        return err(StatusCode::BAD_REQUEST, "period 须为 1m/5m/15m/1h/1d");
    };
    let before = match q.before.as_deref() {
        None => None,
        Some(s) => match DateTime::parse_from_rfc3339(s) {
            Ok(t) => Some(t.with_timezone(&Utc)),
            Err(_) => return err(StatusCode::BAD_REQUEST, "before 须为 RFC3339 时间戳"),
        },
    };
    let limit = q.limit.clamp(1, MAX_LIMIT);
    match st.kline.bars(period, &q.code, before, limit).await {
        Ok(rows) => {
            // 取满一页 → 可能还有更早数据，游标 = 本页最旧 ts（bars 已升序）
            let next_before = if rows.len() as i64 == limit {
                rows.first().map(|r| r.ts)
            } else { None };
            Json(KlineResponse {
                code: q.code.clone(),
                period: q.period.clone(),
                bars: rows.iter().map(BarDto::from).collect(),
                next_before,
            }).into_response()
        }
        Err(e) => internal(e),
    }
}

pub async fn get_symbols(State(st): State<Arc<AppState>>,
                         Query(q): Query<SymbolsQuery>) -> Response {
    let with_stats = q.with_stats.as_deref() == Some("1");
    let rows = match st.kline.symbols_with_latest().await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    // 看板收藏（Wave 3 页面①）：经 FavoriteStore.favorite_map 注入 code→sort_order（非收藏不在 map）
    let fav_map = match st.favorites.favorite_map().await {
        Ok(m) => m,
        Err(e) => return internal(e),
    };
    let mut list: Vec<SymbolDto> = rows.iter().map(SymbolDto::from).collect();
    for d in &mut list {
        if let Some(sort) = fav_map.get(&d.code).copied() {
            d.favorite = true;
            d.favorite_sort = Some(sort);
        }
    }
    if with_stats {
        match st.symbol_stats.today_stats().await {
            Ok(stats) => {
                let map: std::collections::HashMap<String, i64> =
                    stats.into_iter().map(|s| (s.code, s.today_bars)).collect();
                for d in &mut list {
                    d.today_bars = Some(map.get(&d.code).copied().unwrap_or(0));
                }
            }
            Err(e) => return internal(e),
        }
    }
    // 收藏优先：按 favorite_sort 升序；非收藏保持原顺序（symbols_with_latest 按 code 序）。
    // sort_by 为稳定排序（equal 不重排），锁住非收藏原序。
    list.sort_by(|a, b| match (a.favorite_sort, b.favorite_sort) {
        (Some(ao), Some(bo)) => ao.cmp(&bo),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    Json(list).into_response()
}

/// 字段校验错误 → 400/422 JSON（FieldError 分类）。
fn field_err(e: FieldError) -> Response {
    match e {
        FieldError::BadRequest(m) => err(StatusCode::BAD_REQUEST, &m),
        FieldError::Unprocessable(m) => err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    }
}

/// 写后回读（经 merge 视图返回含 latest + 收藏标注的完整行）；写成功但回读缺失 → 500（不自洽）。
async fn read_symbol(st: &AppState, code: &str) -> anyhow::Result<Option<SymbolDto>> {
    let fav_map = st.favorites.favorite_map().await?;
    Ok(st.kline.symbols_with_latest().await?.iter()
        .find(|r| r.code == code)
        .map(|r| {
            let mut d = SymbolDto::from(r);
            if let Some(sort) = fav_map.get(&r.code).copied() {
                d.favorite = true;
                d.favorite_sort = Some(sort);
            }
            d
        }))
}

/// POST /api/symbols —— 注册标的（校验 03-symbols §3；写 symbols 表即控制通道，热生效）。
/// 名称不经服务端行情源反查（ADR-017：应用面无数据面直连）——请求体携带或留空后续 PATCH。
pub async fn register_symbol(State(st): State<Arc<AppState>>,
                             Json(req): Json<RegisterSymbolReq>) -> Response {
    if let Err(e) = validate_code(&req.code) { return field_err(e); }
    if let Err(e) = validate_interval(req.interval_secs) { return field_err(e); }
    if let Err(e) = validate_settlement(&req.settlement) { return field_err(e); }
    let input = SymbolAdminInput {
        code: req.code.clone(), name: normalize_name(req.name),
        interval_secs: req.interval_secs, settlement: req.settlement.clone(),
        enabled: req.enabled,
    };
    match st.symbols_admin.register(&input).await {
        Ok(true) => match read_symbol(&st, &req.code).await {
            Ok(Some(dto)) => (StatusCode::CREATED, Json(dto)).into_response(),
            Ok(None) => internal(anyhow::anyhow!("register 后回读缺失 {}", req.code)),
            Err(e) => internal(e),
        },
        Ok(false) => err(StatusCode::CONFLICT, "code 已注册（编辑用 PATCH）"),
        Err(e) => internal(e),
    }
}

/// PATCH /api/symbols/{code} —— 编辑（间隔/启停/名称/settlement；code 主键不可改）。
/// 仅停用、无物理删除（03-symbols §4）；间隔修改下一采集周期热生效。
pub async fn update_symbol(State(st): State<Arc<AppState>>, Path(code): Path<String>,
                           Json(req): Json<UpdateSymbolReq>) -> Response {
    if let Some(secs) = req.interval_secs {
        if let Err(e) = validate_interval(secs) { return field_err(e); }
    }
    if let Some(s) = &req.settlement {
        if let Err(e) = validate_settlement(s) { return field_err(e); }
    }
    let patch = SymbolPatch {
        name: normalize_name(req.name),
        interval_secs: req.interval_secs,
        settlement: req.settlement.clone(),
        enabled: req.enabled,
    };
    match st.symbols_admin.update(&code, &patch).await {
        Ok(true) => match read_symbol(&st, &code).await {
            Ok(Some(dto)) => Json(dto).into_response(),
            Ok(None) => internal(anyhow::anyhow!("update 后回读缺失 {code}")),
            Err(e) => internal(e),
        },
        Ok(false) => err(StatusCode::NOT_FOUND, "code 未注册"),
        Err(e) => internal(e),
    }
}

// ── Wave 3 页面① 看板收藏端点（favorite_symbols 表，0013；应用面自有表，写不违 ADR-017）──

/// 符号存在性探测（不存在 → 404）。复用 PgSymbolAdmin::update 的「无字段 no-op 探测」：
/// `UPDATE symbols SET name=COALESCE(NULL,name) ... WHERE code=$1` → rows_affected>0 表示存在。
/// 不新增 FavoriteStore 端口方法（契约最小集），符号存在性经既有 SymbolAdminWrite::update 探测。
#[allow(clippy::result_large_err)]
async fn symbol_exists(st: &AppState, code: &str) -> Result<bool, Response> {
    match st.symbols_admin.update(code, &SymbolPatch::default()).await {
        Ok(exists) => Ok(exists),
        Err(e) => Err(internal(e)),
    }
}

/// POST /api/symbols/{code}/favorite —— 一键收藏（自动置顶 sort_order=max+1）。
/// 幂等语义（父级批准）：已收藏再次收藏 → 200 无副作用（不做 409）。
pub async fn star_favorite(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Response {
    if code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 空"); }
    match symbol_exists(&st, &code).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "code 未注册"),
        Err(e) => return e,
    }
    match st.favorites.star(&code).await {
        Ok(()) => (StatusCode::OK,
            Json(serde_json::json!({ "code": &code, "favorite": true }))).into_response(),
        Err(e) => internal(e),
    }
}

/// DELETE /api/symbols/{code}/favorite —— 取消收藏（不存在收藏 → 200 幂等）。
pub async fn unstar_favorite(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Response {
    if code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 空"); }
    match symbol_exists(&st, &code).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "code 未注册"),
        Err(e) => return e,
    }
    match st.favorites.unstar(&code).await {
        Ok(()) => (StatusCode::OK,
            Json(serde_json::json!({ "code": &code, "favorite": false }))).into_response(),
        Err(e) => internal(e),
    }
}

/// PUT /api/symbols/favorites/order —— 批量重排（sort_order=索引；codes 顺序即展示顺序，可子集）。
/// 校验：codes 所有 code 均须已收藏（favorite_map 预检），否则 400。
pub async fn reorder_favorites(State(st): State<Arc<AppState>>,
                               Json(req): Json<ReorderFavoritesReq>) -> Response {
    let fav_map = match st.favorites.favorite_map().await {
        Ok(m) => m,
        Err(e) => return internal(e),
    };
    for c in &req.codes {
        if !fav_map.contains_key(c) {
            return err(StatusCode::BAD_REQUEST, &format!("code {c} 未收藏"));
        }
    }
    match st.favorites.reorder(&req.codes).await {
        Ok(()) => (StatusCode::OK,
            Json(serde_json::json!({ "codes": req.codes, "reordered": true }))).into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/sources/{id}/reset —— 熔断手动复位（DB 控制通道，ADR-017）。
/// 202 异步：写 circuit_reset_requests；数据面 ResetWatcher ≤5s 消费并发出 manual_reset 事件
/// （未知源 id 由消费端跳过并告警——应用面不知编译期源清单，不在此校验）。
pub async fn reset_source(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if id.trim().is_empty() { return err(StatusCode::BAD_REQUEST, "source id 空"); }
    match st.resets.request_reset(&id).await {
        Ok(()) => (StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "accepted" }))).into_response(),
        Err(e) => internal(e),
    }
}

pub async fn get_sources_health(State(st): State<Arc<AppState>>,
                                Query(q): Query<HealthQuery>) -> Response {
    let window = q.window_secs.clamp(60, 7 * 24 * 3600);
    match st.health.aggregate(window).await {
        Ok(sources) => Json(serde_json::json!({
            "window_secs": window,
            "sources": sources,
        })).into_response(),
        Err(e) => internal(e),
    }
}

// ── Wave 2 Phase A：数据质量（页面④，04-quality.md §7）+ tushare 同步状态 ──
// 范围/阈值校验在 web 层（400）；service 内部同口径防御性复核。

/// 解析 from/to（YYYY-MM-DD）+ 范围校验；失败 → 400 Response。
/// （Err 载荷为 axum Response 属大类型——handler 短路返回模式既定，allow 之；与 alerts.rs 同口径）
#[allow(clippy::result_large_err)]
fn parse_range(from_s: &str, to_s: &str)
    -> Result<(chrono::NaiveDate, chrono::NaiveDate), Response> {
    let (Some(from), Some(to)) = (parse_date(from_s), parse_date(to_s)) else {
        return Err(err(StatusCode::BAD_REQUEST, "from/to 必填且须为 YYYY-MM-DD"));
    };
    if let Err(e) = diagnose::quality::validate_range(from, to) {
        return Err(err(StatusCode::BAD_REQUEST, &e.to_string()));
    }
    Ok((from, to))
}

/// 阈值解析（默认 = 页面④ QUALITY_DEFAULTS.consistencyThresholdPct=0.5）+ 校验。
#[allow(clippy::result_large_err)]
fn parse_threshold(q: Option<f64>) -> Result<f64, Response> {
    let t = q.unwrap_or(diagnose::quality::DEFAULT_THRESHOLD_PCT);
    if let Err(m) = validate_threshold(t) { return Err(err(StatusCode::BAD_REQUEST, &m)); }
    Ok(t)
}

/// GET /api/quality/divergence?code=&from=&to=&threshold_pct=
pub async fn get_quality_divergence(State(st): State<Arc<AppState>>,
                                    Query(q): Query<DivergenceQuery>) -> Response {
    if q.code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 必填"); }
    let (from, to) = match parse_range(&q.from, &q.to) { Ok(r) => r, Err(r) => return r };
    let threshold = match parse_threshold(q.threshold_pct) { Ok(t) => t, Err(r) => return r };
    match st.quality.divergence(&q.code, from, to, threshold).await {
        Ok(rep) => Json(serde_json::json!({
            "code": q.code, "from": q.from, "to": q.to, "threshold_pct": threshold,
            "summary": rep.summary, "rows": rep.rows,
        })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/quality/source-accuracy?from=&to=&threshold_pct=
pub async fn get_quality_source_accuracy(State(st): State<Arc<AppState>>,
                                         Query(q): Query<SourceAccuracyQuery>) -> Response {
    let (from, to) = match parse_range(&q.from, &q.to) { Ok(r) => r, Err(r) => return r };
    let threshold = match parse_threshold(q.threshold_pct) { Ok(t) => t, Err(r) => return r };
    match st.quality.source_accuracy(from, to, threshold).await {
        Ok(sources) => Json(serde_json::json!({
            "from": q.from, "to": q.to, "threshold_pct": threshold, "sources": sources,
        })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/quality/gaps?code=&from=&to=
/// 仅含有缺口的交易日；segments 的 start/end 为 CST "HH:MM"（页面④ 展示口径）。
pub async fn get_quality_gaps(State(st): State<Arc<AppState>>,
                              Query(q): Query<GapsQuery>) -> Response {
    if q.code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 必填"); }
    let (from, to) = match parse_range(&q.from, &q.to) { Ok(r) => r, Err(r) => return r };
    match st.quality.gaps(&q.code, from, to).await {
        Ok(days) => Json(serde_json::json!({
            "code": q.code, "from": q.from, "to": q.to,
            "days": days.iter().map(|d| serde_json::json!({
                "date": d.date,
                "expected_bars": d.expected_bars,
                "actual_bars": d.actual_bars,
                "missing_bars": d.missing_bars,
                "segments": d.segments.iter().map(|s| serde_json::json!({
                    "start": diagnose::quality::hhmm(&s.start),
                    "end": diagnose::quality::hhmm(&s.end),
                    "count": s.count,
                    "class": s.class,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/tushare/status —— 页面④ sync-panel 状态区。
/// quota_remaining 恒 null：tushare 积分余额未入库（§1.1 注明，待账户侧可查后单开）。
pub async fn get_tushare_status(State(st): State<Arc<AppState>>) -> Response {
    match st.quality.tushare_status().await {
        Ok(s) => Json(serde_json::json!({
            "checkpoints": s.checkpoints,
            "covered_codes": s.covered_codes,
            "last_updated_at": s.last_updated_at,
            "last_event": s.last_event,
            "quota_remaining": serde_json::Value::Null,
        })).into_response(),
        Err(e) => internal(e),
    }
}

// ── 行情看板 MA 可配置（后端 W1：GET /api/config/ma 读 + PUT 写；主图+宫格应用，回测弹窗不动）──
// 校验在 web 层（validate_ma_windows，400）；storage 只存归一化（升序去重）结果，见 §1.1 契约表。

/// GET /api/config/ma —— 读当前 MA 窗口（ma_config 表；表空 → 默认 [5,10,20]）。
pub async fn get_ma_config(State(st): State<Arc<AppState>>) -> Response {
    match st.ma_config.get().await {
        Ok(windows) => Json(MaConfigDto { windows }).into_response(),
        Err(e) => internal(e),
    }
}

/// PUT /api/config/ma —— body {windows:[...]}：校验（1-3 条、每条 1-500、升序/去重归一）→ 存 DB → 返回归一化。
/// 400：条目数/量纲不合规；500：存储失败。
pub async fn put_ma_config(State(st): State<Arc<AppState>>,
                           Json(req): Json<MaConfigDto>) -> Response {
    let windows = match validate_ma_windows(&req.windows) {
        Ok(w) => w,
        Err(e) => return err(StatusCode::BAD_REQUEST, &e),
    };
    match st.ma_config.set(&windows).await {
        Ok(w) => Json(MaConfigDto { windows: w }).into_response(),
        Err(e) => internal(e),
    }
}
```

``` {.rust file=crates/web/src/ws.rs}
//! WS /ws 订阅分发：{type:"bar"|"quote"|"health"} 推送；断线退避重连由客户端（00-shell 既定）。
//! ADR-017：应用面只读库——无数据面直连，推送源 = Poller 短周期轮询库增量（§1.2）。

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::Response,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

use crate::dto::{parse_period, BarDto};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Topic { Bar, Quote, Health, Alert, Backtest }

/// 客户端帧：{"type":"subscribe","topic":"bar","code":"518880","period":"1m"}（unsubscribe 同形）。
/// Backtest 订阅带 run_id（Wave 3 Phase 3c；省略 = 通配全部回测进度）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Subscribe { topic: Topic, code: Option<String>, period: Option<String>, run_id: Option<i64> },
    Unsubscribe { topic: Topic, code: Option<String>, period: Option<String>, run_id: Option<i64> },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Subscription {
    pub topic: Topic,
    pub code: Option<String>,     // None = 全部标的
    pub period: Option<String>,   // bar 订阅必填（"1m"/"5m"/"15m"/"1h"/"1d"）
    pub run_id: Option<i64>,      // backtest 订阅的 run（None = 全部回测进度；Wave 3 Phase 3c）
}

/// 服务端推送帧：serde 内部 tag 平铺为 {"type":"bar"|"quote"|"health"|"alert", ...}。
/// Alert（Wave 2 Phase B）：newtype 变体内联事件字段（{"type":"alert", id, level, ...}），
/// 推送源 = web::alerts::AlertEvaluator 评估节拍（非本 Poller）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushMsg {
    Bar { code: String, period: String, bar: BarDto },
    Quote { code: String, ts: DateTime<Utc>, last: f64, #[serde(rename = "changePct")] change_pct: Option<f64> },
    Health { window_secs: i64, sources: Vec<diagnose::health::SourceHealth> },
    Alert(crate::alerts::AlertEventDto),
    /// 回测进度（Wave 3 Phase 3c；推送源 = application 层引擎回调，经 BacktestWsSink → hub）。
    BacktestProgress { run_id: i64, pct: i32, bar_ts: Option<DateTime<Utc>> },
}

/// 订阅匹配：topic 一致且（sub.code/period/run_id 为 None 通配或与消息相等）。
pub fn matches(sub: &Subscription, msg: &PushMsg) -> bool {
    let hit = |want: &Option<String>, got: &str| want.as_deref().is_none_or(|w| w == got);
    match (sub.topic, msg) {
        (Topic::Bar, PushMsg::Bar { code, period, .. }) => hit(&sub.code, code) && hit(&sub.period, period),
        (Topic::Quote, PushMsg::Quote { code, .. }) => hit(&sub.code, code),
        (Topic::Health, PushMsg::Health { .. }) => true,
        (Topic::Alert, PushMsg::Alert(_)) => true,   // 订阅即全量告警推送（07-alerts §6）
        (Topic::Backtest, PushMsg::BacktestProgress { run_id, .. }) =>
            sub.run_id.is_none_or(|sid| sid == *run_id),
        _ => false,
    }
}

/// 推送总线（进程内 broadcast；lagged 丢帧由客户端重连/REST 重拉兜底）。
#[derive(Clone)]
pub struct WsHub { tx: broadcast::Sender<PushMsg> }

impl WsHub {
    pub fn new() -> Self { Self { tx: broadcast::channel(256).0 } }
    /// 无订阅者时 send 返回 Err，属常态，忽略。
    pub fn publish(&self, msg: PushMsg) { let _ = self.tx.send(msg); }
    pub fn subscribe(&self) -> broadcast::Receiver<PushMsg> { self.tx.subscribe() }
}

impl Default for WsHub {
    fn default() -> Self { Self::new() }
}

/// 全连接订阅登记表（Poller 据此决定轮询哪些 code/period）。std Mutex 不跨 await。
#[derive(Clone, Default)]
pub struct SubscriptionRegistry { inner: Arc<Mutex<HashSet<Subscription>>> }

impl SubscriptionRegistry {
    pub fn add(&self, sub: Subscription) { self.inner.lock().expect("subs poisoned").insert(sub); }
    pub fn remove(&self, sub: &Subscription) { self.inner.lock().expect("subs poisoned").remove(sub); }
    pub fn snapshot(&self) -> HashSet<Subscription> { self.inner.lock().expect("subs poisoned").clone() }
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(st): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(move |sock| handle_socket(st, sock))
}

async fn handle_socket(st: Arc<AppState>, mut sock: WebSocket) {
    let mut rx = st.hub.subscribe();
    let mut mine: HashSet<Subscription> = HashSet::new();
    loop {
        tokio::select! {
            msg = sock.recv() => match msg {
                Some(Ok(Message::Text(t))) => apply_client_msg(&st.subs, &mut mine, t.as_str()),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}    // ping/pong/binary 忽略（axum 自动回 pong）
                Some(Err(_)) => break,
            },
            push = rx.recv() => match push {
                Ok(m) if mine.iter().any(|s| matches(s, &m)) => {
                    if let Ok(text) = serde_json::to_string(&m) {
                        if sock.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                }
                Ok(_) => {}                                     // 未订阅的消息
                Err(broadcast::error::RecvError::Lagged(_)) => {} // 丢帧由客户端重连兜底
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
    for s in &mine { st.subs.remove(s); }   // 连接关闭即注销（Poller 不再空轮询）
}

fn apply_client_msg(reg: &SubscriptionRegistry, mine: &mut HashSet<Subscription>, text: &str) {
    let Ok(msg) = serde_json::from_str::<ClientMsg>(text) else { return }; // 坏帧忽略（ADR-010 内网）
    match msg {
        ClientMsg::Subscribe { topic, code, period, run_id } => {
            let sub = Subscription { topic, code, period, run_id };
            mine.insert(sub.clone());
            reg.add(sub);
        }
        ClientMsg::Unsubscribe { topic, code, period, run_id } => {
            let sub = Subscription { topic, code, period, run_id };
            mine.remove(&sub);
            reg.remove(&sub);
        }
    }
}

/// 推送轮询器（应用面唯一推送源）：按订阅注册表轮询库，ts 前进的增量发布到 hub。
/// 游标在内存（进程级），重启重推一次最新值，无害。
pub struct Poller {
    state: Arc<AppState>,
    interval: Duration,
    last_bar: HashMap<(String, String), DateTime<Utc>>,
    last_quote: HashMap<String, DateTime<Utc>>,
    last_health_ts: Option<DateTime<Utc>>,
}

impl Poller {
    pub fn new(state: Arc<AppState>, interval: Duration) -> Self {
        Self {
            state, interval,
            last_bar: HashMap::new(),
            last_quote: HashMap::new(),
            last_health_ts: None,
        }
    }

    pub async fn run(mut self) {
        loop {
            if let Err(e) = self.tick().await {
                tracing::warn!(error = %e, "ws poller tick failed");
            }
            tokio::time::sleep(self.interval).await;
        }
    }

    /// 单轮轮询（测试可直调）：bar 按 (code,period) 去重；quote 全量快照增量；health 快照变更。
    pub async fn tick(&mut self) -> anyhow::Result<()> {
        let subs = self.state.subs.snapshot();

        // bar：按 (code, period) 去重轮询，ts 前进才推
        let mut keys: HashSet<(String, String)> = HashSet::new();
        for s in subs.iter().filter(|s| s.topic == Topic::Bar) {
            if let (Some(code), Some(period)) = (&s.code, &s.period) {
                keys.insert((code.clone(), period.clone()));
            }
        }
        for (code, period) in keys {
            let Some(p) = parse_period(&period) else { continue };
            if let Some(bar) = self.state.kline.latest_bar(p, &code).await? {
                let key = (code.clone(), period.clone());
                if self.last_bar.get(&key).is_none_or(|ts| bar.ts > *ts) {
                    self.last_bar.insert(key, bar.ts);
                    self.state.hub.publish(PushMsg::Bar { code, period, bar: BarDto::from(&bar) });
                }
            }
        }

        // quote：任一 quote 订阅存在则全量快照推进（连接侧按 code 过滤）
        if subs.iter().any(|s| s.topic == Topic::Quote) {
            for row in self.state.kline.symbols_with_latest().await? {
                let (Some(ts), Some(last)) = (row.last_ts, row.last_close) else { continue };
                if self.last_quote.get(&row.code).is_none_or(|t| ts > *t) {
                    self.last_quote.insert(row.code.clone(), ts);
                    let change_pct = row.prev_close.filter(|p| *p != 0.0)
                        .map(|p| (last - p) / p * 100.0);
                    self.state.hub.publish(PushMsg::Quote { code: row.code, ts, last, change_pct });
                }
            }
        }

        // health：窗口聚合 last_event_ts 前进 → 整快照推送
        if subs.iter().any(|s| s.topic == Topic::Health) {
            let sources = self.state.health.aggregate(self.state.health_window_secs).await?;
            let newest = sources.iter().filter_map(|h| h.last_event_ts).max();
            if newest.is_some() && newest != self.last_health_ts {
                self.last_health_ts = newest;
                self.state.hub.publish(PushMsg::Health {
                    window_secs: self.state.health_window_secs, sources });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn bar_msg(code: &str, period: &str) -> PushMsg {
        PushMsg::Bar { code: code.into(), period: period.into(), bar: BarDto {
            ts: Utc.with_ymd_and_hms(2026, 9, 4, 1, 30, 0).unwrap(),
            open: 1.0, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105.0, source: None,
        } }
    }

    #[test]
    fn matches_bar_code_and_period() {
        let sub = Subscription { topic: Topic::Bar,
            code: Some("518880".into()), period: Some("1m".into()), run_id: None };
        assert!(matches(&sub, &bar_msg("518880", "1m")));
        assert!(!matches(&sub, &bar_msg("518880", "5m")));
        assert!(!matches(&sub, &bar_msg("513310", "1m")));
    }

    #[test]
    fn matches_none_is_wildcard() {
        let sub = Subscription { topic: Topic::Quote, code: None, period: None, run_id: None };
        let q = PushMsg::Quote { code: "518880".into(), ts: Utc::now(), last: 1.0, change_pct: None };
        assert!(matches(&sub, &q));
        let scoped = Subscription { topic: Topic::Quote, code: Some("513310".into()), period: None, run_id: None };
        assert!(!matches(&scoped, &q));
    }

    #[test]
    fn cross_topic_never_matches() {
        let sub = Subscription { topic: Topic::Health, code: None, period: None, run_id: None };
        assert!(!matches(&sub, &bar_msg("518880", "1m")));
        assert!(matches(&sub, &PushMsg::Health { window_secs: 3600, sources: vec![] }));
    }

    #[test]
    fn matches_backtest_progress_by_run_id() {
        let prog = PushMsg::BacktestProgress { run_id: 7, pct: 50, bar_ts: None };
        let scoped = Subscription { topic: Topic::Backtest, code: None, period: None, run_id: Some(7) };
        assert!(matches(&scoped, &prog), "run_id 匹配");
        let other = Subscription { topic: Topic::Backtest, code: None, period: None, run_id: Some(8) };
        assert!(!matches(&other, &prog), "不同 run_id 不匹配");
        let wildcard = Subscription { topic: Topic::Backtest, code: None, period: None, run_id: None };
        assert!(matches(&wildcard, &prog), "run_id 省略 = 通配");
        let bar = Subscription { topic: Topic::Bar, code: None, period: None, run_id: None };
        assert!(!matches(&bar, &prog), "跨 topic 不匹配");
        // 帧 JSON 形状：type=backtest_progress
        let v = serde_json::to_value(&prog).unwrap();
        assert_eq!(v["type"], "backtest_progress");
        assert_eq!(v["run_id"], 7);
        assert_eq!(v["pct"], 50);
        assert!(v["bar_ts"].is_null());
    }

    #[test]
    fn push_msg_json_tag_shape() {
        let v = serde_json::to_value(bar_msg("518880", "1m")).unwrap();
        assert_eq!(v["type"], "bar");
        assert_eq!(v["code"], "518880");
        assert_eq!(v["bar"]["close"], 1.05);
        let h = serde_json::to_value(PushMsg::Health { window_secs: 3600, sources: vec![] }).unwrap();
        assert_eq!(h["type"], "health");
    }

    #[test]
    fn push_msg_quote_frame_camel_case() {
        // K1 契约修复：WS quote 帧载荷与前端/mock 统一为 camelCase（前端 store 读 changePct）。
        let q = PushMsg::Quote { code: "518880".into(), ts: Utc::now(), last: 1.234, change_pct: Some(0.12) };
        let v = serde_json::to_value(&q).unwrap();
        assert_eq!(v["type"], "quote");
        assert_eq!(v["code"], "518880");
        assert_eq!(v["changePct"], 0.12);
        assert!(v.get("change_pct").is_none(), "不得再输出 snake_case change_pct");
        assert_eq!(v["last"], 1.234);
    }

    #[test]
    fn push_msg_alert_frame_shape() {
        // Wave 2 Phase B：alert 帧平铺事件字段（07-alerts §6：{type:"alert", level, ...}）
        let dto = crate::alerts::AlertEventDto {
            id: 1, rule_id: "collection_stall".into(), level: domain::ports::AlertLevel::Critical,
            source: "collector".into(), message: "停摆".into(),
            status: domain::ports::AlertStatus::Triggered, fire_count: 1,
            first_fired_at: Utc::now(), last_fired_at: Utc::now(), acked_at: None, resolved_at: None,
        };
        let v = serde_json::to_value(PushMsg::Alert(dto)).unwrap();
        assert_eq!(v["type"], "alert");
        assert_eq!(v["level"], "critical");
        assert_eq!(v["status"], "triggered");
        // 订阅匹配：alert topic 全量
        let sub = Subscription { topic: Topic::Alert, code: None, period: None, run_id: None };
        let dto2 = crate::alerts::AlertEventDto {
            id: 2, rule_id: "symbol_gap_rate".into(), level: domain::ports::AlertLevel::Warning,
            source: "513310".into(), message: "缺口".into(),
            status: domain::ports::AlertStatus::Resolved, fire_count: 4,
            first_fired_at: Utc::now(), last_fired_at: Utc::now(), acked_at: None,
            resolved_at: Some(Utc::now()),
        };
        assert!(matches(&sub, &PushMsg::Alert(dto2)));
        assert!(!matches(&sub, &bar_msg("518880", "1m")), "跨 topic 不匹配");
    }

    #[test]
    fn client_subscribe_unsubscribe_roundtrip() {
        let reg = SubscriptionRegistry::default();
        let mut mine = HashSet::new();
        apply_client_msg(&reg, &mut mine,
            r#"{"type":"subscribe","topic":"bar","code":"518880","period":"1m"}"#);
        assert_eq!(reg.snapshot().len(), 1);
        apply_client_msg(&reg, &mut mine,
            r#"{"type":"unsubscribe","topic":"bar","code":"518880","period":"1m"}"#);
        assert!(reg.snapshot().is_empty());
        apply_client_msg(&reg, &mut mine, "not json");   // 坏帧忽略不 panic
        apply_client_msg(&reg, &mut mine, r#"{"type":"subscribe","topic":"unknown"}"#);
        assert!(reg.snapshot().is_empty(), "未知 topic 忽略");
    }

    #[test]
    fn client_subscribe_backtest_run_id() {
        let reg = SubscriptionRegistry::default();
        let mut mine = HashSet::new();
        apply_client_msg(&reg, &mut mine, r#"{"type":"subscribe","topic":"backtest","run_id":7}"#);
        assert_eq!(reg.snapshot().len(), 1, "backtest 订阅应登记");
        let sub = reg.snapshot().into_iter().next().unwrap();
        assert_eq!(sub.topic, Topic::Backtest);
        assert_eq!(sub.run_id, Some(7));
        apply_client_msg(&reg, &mut mine, r#"{"type":"unsubscribe","topic":"backtest","run_id":7}"#);
        assert!(reg.snapshot().is_empty(), "退订应清除");
    }
}
```

``` {.rust file=crates/web/src/spa.rs}
//! SPA 静态托管：dist 存在即服务并回退 index.html（history 路由深链）；dist 缺失 → 503 占位。
//! 不引 tower-http（零新增依赖，ADR-017 最小攻击面同口径）。

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::AppState;

/// 未知路径兜底：任何 /api 前缀（含裸 /api）→ 404 JSON（D6：API 路径不回退 index.html，§1.3）；
/// 其余 → 静态文件 → SPA index.html → 503 占位。
pub async fn spa_fallback(State(st): State<Arc<AppState>>, uri: Uri) -> Response {
    if uri.path().starts_with("/api") {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" }))).into_response();
    }
    serve_path(&st.static_dir, uri.path()).await
}

async fn serve_path(dir: &Path, req_path: &str) -> Response {
    match sanitize(req_path) {
        None => (StatusCode::BAD_REQUEST, "bad path").into_response(),
        Some(rel) => {
            let candidate = dir.join(&rel);
            if candidate.is_file() {
                return file_response(&candidate, rel.to_str().unwrap_or("index.html")).await;
            }
            let index = dir.join("index.html");
            if index.is_file() { return file_response(&index, "index.html").await; }
            (StatusCode::SERVICE_UNAVAILABLE,
             "SPA 未构建：web/dist 缺失（前端 Wave 1 Phase B 产出）").into_response()
        }
    }
}

/// 防目录穿越：拒绝 .. / 反斜杠 / 空段；空路径 → index.html。
pub fn sanitize(path: &str) -> Option<PathBuf> {
    let p = path.trim_start_matches('/');
    if p.is_empty() { return Some(PathBuf::from("index.html")); }
    let mut out = PathBuf::new();
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\') { return None; }
        out.push(seg);
    }
    Some(out)
}

pub fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn file_response(path: &Path, cache_key: &str) -> Response {
    let cache = cache_control_for(cache_key);
    match tokio::fs::read(path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime_of(path)),
                (header::CACHE_CONTROL, cache),
            ],
            Body::from(bytes),
        ).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// 相对 static_dir 路径的 Cache-Control 策略（§1.3 缓存头策略）：
/// 哈希静态资产（`assets/<name>-<hash>.<ext>`）→ 长期不可变缓存；其余（含 index.html）→ no-store。
fn cache_control_for(rel: &str) -> &'static str {
    if is_hashed_asset(rel) {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    }
}

/// 判定是否为 Vite 内容寻址哈希资产：路径位于 `assets/` 前缀，且 basename 去扩展名后
/// 形如 `<name>-<hash>`，其中 `<hash>` 为第一个 `-` 之后的部分，长度 >= 8 且均为
/// [A-Za-z0-9_-]（Vite 默认 8+ 位 url-safe hash，可能自带 `-`/`_`，如 index-D4J30-jW.css）。
/// 保守：不满足一律视为非哈希（no-store）。
fn is_hashed_asset(rel: &str) -> bool {
    let p = rel.trim_start_matches('/');
    if !p.starts_with("assets/") { return false; }
    let basename = p.rsplit('/').next().unwrap_or(p);
    let stem = basename.rsplit_once('.').map(|(s, _)| s).unwrap_or(basename);
    match stem.split_once('-') {
        Some((_, hash)) => {
            hash.len() >= 8 && hash.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize("../etc/passwd").is_none());
        assert!(sanitize("/../../x").is_none());
        assert!(sanitize("assets/..\\evil").is_none());
        assert!(sanitize("a//b").is_none(), "空段拒绝（防规范化歧义）");
    }

    #[test]
    fn sanitize_normalizes() {
        assert_eq!(sanitize("/"), Some(PathBuf::from("index.html")));
        assert_eq!(sanitize("/assets/app.js"), Some(PathBuf::from("assets/app.js")));
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_of(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_of(Path::new("a.js")), "text/javascript");
        assert_eq!(mime_of(Path::new("a.woff2")), "font/woff2");
        assert_eq!(mime_of(Path::new("a.bin")), "application/octet-stream");
    }

    #[test]
    fn cache_control_index_html_is_no_store() {
        assert_eq!(cache_control_for("index.html"), "no-store");
        assert_eq!(cache_control_for("/"), "no-store");
        assert_eq!(cache_control_for(""), "no-store");
    }

    #[test]
    fn cache_control_non_hashed_static_is_no_store() {
        assert_eq!(cache_control_for("favicon.ico"), "no-store");
        assert_eq!(cache_control_for("assets/vite.svg"), "no-store");
        assert_eq!(cache_control_for("assets/index.js"), "no-store");
        assert_eq!(cache_control_for("assets/foo-123.js"), "no-store");
    }

    #[test]
    fn cache_control_hashed_assets_is_immutable() {
        assert_eq!(
            cache_control_for("assets/index-D3fG4fH1.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_control_for("assets/index-AbCdEf12.css"),
            "public, max-age=31536000, immutable"
        );
    }

    #[test]
    fn is_hashed_asset_detection() {
        assert!(is_hashed_asset("assets/index-12345678.js"));
        assert!(is_hashed_asset("assets/logo-AbCdEfGh.svg"));
        // Vite url-safe hash 可含 '-'（真实样例 index-D4J30-jW.css）：首 '-' 后整段即 hash
        assert!(is_hashed_asset("assets/index-D4J30-jW.css"));
        assert!(!is_hashed_asset("assets/index.js"));
        assert!(!is_hashed_asset("index.html"));
        assert!(!is_hashed_asset("assets/foo-123.js"));
    }
}
```

集成测试（真实库 + 真实起 server，reqwest 断言）：

``` {.rust file=crates/web/tests/api_rest.rs}
//! REST/SPA 集成测试（需 TimescaleDB :5433）：真实起 axum server + reqwest 断言。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996601";
const SCODE: &str = "996602";
const HSRC: &str = "web_test_src";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅出现在 dev-dependencies（正常依赖图不含，cargo tree -e normal 验证）。
fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（与 app bin 同口径；本文件不涉及行为，仅装配齐全）
    let backtest_hub = WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        // Phase C：symbols 写 / 当日统计 / 熔断复位 DB 通道
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎装配（02-alerts.md；本文件不涉及行为，仅装配齐全）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（quality 端口组；仅装配齐全，行为测试见 api_quality.rs）
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // 页面⑧ S1：设置页新增字段（装配齐全；行为测试见 api_settings.rs）
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest,
        backtest_ws,
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        // 行情看板 MA 可配置（装配齐全；行为测试见 api_ma_config.rs）
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

/// n 根 1m raw bar（收盘 1..n）。
async fn seed_bars(pool: &PgPool, code: &str, n: i64) {
    for i in 0..n {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(pool).await.unwrap();
    }
}

// 两测试并行执行：各自的 clean 只碰自己的 code/source（共享清理会互删，实锤踩坑）。
async fn clean_kline(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
}

async fn clean_sym(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(SCODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(SCODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM source_health_events WHERE source = $1").bind(HSRC)
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn kline_cursor_pagination_cagg_and_validation() {
    let pool = pool().await;
    clean_kline(&pool).await;
    seed_bars(&pool, CODE, 5).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 第 1 页：limit=2 → 最新 2 根升序 [4,5]
    let v: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2")])
        .send().await.unwrap().json().await.unwrap();
    let bars = v["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 2);
    assert_eq!(bars[0]["close"], 4.0);
    assert_eq!(bars[1]["close"], 5.0);
    let cursor = v["next_before"].as_str().expect("还有更早页").to_string();

    // 第 2 页：before=游标 → [2,3]，无重叠
    let v2: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2"), ("before", &cursor)])
        .send().await.unwrap().json().await.unwrap();
    let closes: Vec<f64> = v2["bars"].as_array().unwrap()
        .iter().map(|b| b["close"].as_f64().unwrap()).collect();
    assert_eq!(closes, vec![2.0, 3.0], "游标页无重复/缺漏");
    let cursor2 = v2["next_before"].as_str().unwrap().to_string();

    // 第 3 页：[1]，next_before=null（前端停拉信号）
    let v3: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2"), ("before", &cursor2)])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v3["bars"].as_array().unwrap().len(), 1);
    assert!(v3["next_before"].is_null());

    // 参数校验
    for q in [[("code", CODE), ("period", "3m")], [("code", CODE), ("period", "M1")]] {
        let r = http.get(format!("{url}/api/kline")).query(&q).send().await.unwrap();
        assert_eq!(r.status(), 400, "非法 period → 400");
    }
    let r = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("before", "not-a-time")]).send().await.unwrap();
    assert_eq!(r.status(), 400, "非法 before → 400");

    // cagg 周期（5m 桶：开 1 收 5 量 500）
    sqlx::query("CALL refresh_continuous_aggregate('kline_5m', NULL, NULL)")
        .execute(&pool).await.unwrap();
    let v5: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "5m")]).send().await.unwrap().json().await.unwrap();
    let bars5 = v5["bars"].as_array().unwrap();
    assert_eq!(bars5.len(), 1);
    assert_eq!(bars5[0]["open"], 1.0);
    assert_eq!(bars5[0]["close"], 5.0);
    assert_eq!(bars5[0]["volume"], 500);
    assert!(bars5[0].get("source").is_none(), "cagg 无 source 键");
    clean_kline(&pool).await;
}

#[tokio::test]
async fn symbols_latest_healthz_spa_and_sources_health() {
    let pool = pool().await;
    clean_sym(&pool).await;
    sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, '测试ETF') \
                 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
        .bind(SCODE).execute(&pool).await.unwrap();
    seed_bars(&pool, SCODE, 2).await;   // 收盘 1,2 → change_pct=100
    for i in 0..3 {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms) \
                     VALUES (now() - make_interval(secs => $1), $2, true, 120)")
            .bind(10 + i).bind(HSRC).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind) \
                 VALUES (now(), $1, false, 'timeout')")
        .bind(HSRC).execute(&pool).await.unwrap();
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // /api/symbols 含 latest 快照字段
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == SCODE).expect("含测试标的");
    assert_eq!(s["latest"]["last"], 2.0);
    assert!((s["latest"]["change_pct"].as_f64().unwrap() - 100.0).abs() < 1e-6);

    // /api/sources/health：3 成功 + 1 失败 → 成功率 0.75、degraded
    let v: Value = http.get(format!("{url}/api/sources/health"))
        .query(&[("window_secs", "3600")]).send().await.unwrap().json().await.unwrap();
    let h = v["sources"].as_array().unwrap().iter()
        .find(|x| x["source"] == HSRC).expect("含测试源");
    assert_eq!(h["attempts"], 4);
    assert!((h["success_rate"].as_f64().unwrap() - 0.75).abs() < 1e-9);
    assert_eq!(h["status"], "degraded");
    assert_eq!(h["last_error"]["err_kind"], "timeout");

    // /healthz
    let v: Value = http.get(format!("{url}/healthz")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["status"], "ok");

    // SPA：/ 与深链均回退占位 index.html
    for path in ["/", "/symbols", "/assets/nonexistent.js"] {
        let body = http.get(format!("{url}{path}")).send().await.unwrap().text().await.unwrap();
        assert!(body.contains("eestock"), "{path} 回退 index.html");
    }
    // 目录穿越：编码形式不做百分比解码，"..%2F.." 只是普通文件名 → 回退 index.html，
    // 绝不会读到 dist 之外（sanitize 拒绝的是解码后语义中的 ".." 段，即字面段）。
    let r = http.get(format!("{url}/..%2F..%2Fetc%2Fpasswd")).send().await.unwrap();
    let body = r.text().await.unwrap();
    assert!(body.contains("eestock") && !body.contains("root:"), "穿越尝试只能拿到 SPA 页");
    // 字面 ".." 段（构造未经客户端规范化的路径）→ sanitize 拒绝 → 400
    let r = http.get(format!("{url}/assets/%2e%2e")).send().await.unwrap();
    assert!(r.status() != 500);
    clean_sym(&pool).await;
}
```

``` {.rust file=crates/web/tests/ws_poller.rs}
//! WS Poller 集成测试（需 TimescaleDB :5433）：库增量 → hub 推送；无增量不重推；新 bar 再推。

use chrono::{DateTime, Duration, TimeZone, Utc};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use web::state::AppState;
use web::ws::{Poller, PushMsg, Subscription, SubscriptionRegistry, Topic, WsHub};

const CODE: &str = "996603";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅出现在 dev-dependencies（正常依赖图不含，cargo tree -e normal 验证）。
fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（与 app bin 同口径；本文件不涉及行为，仅装配齐全）
    let backtest_hub = WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        // Phase C：symbols 写 / 当日统计 / 熔断复位 DB 通道（本文件不涉及行为，仅装配齐全）
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎装配（02-alerts.md；本文件不涉及行为，仅装配齐全）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（quality 端口组；仅装配齐全，行为测试见 api_quality.rs）
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest,
        backtest_ws,
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        // 行情看板 MA 可配置（装配齐全；行为测试见 api_ma_config.rs）
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn seed(pool: &PgPool, min: i64, close: f64) {
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
        .bind(CODE).bind(base() + Duration::minutes(min)).bind(close)
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn poller_publishes_increments_only() {
    let pool = pool().await;
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO symbols (code) VALUES ($1) ON CONFLICT (code) DO NOTHING")
        .bind(CODE).execute(&pool).await.unwrap();
    seed(&pool, 0, 1.0).await;

    let st = state(pool.clone());
    st.subs.add(Subscription { topic: Topic::Bar,
        code: Some(CODE.into()), period: Some("1m".into()), run_id: None });
    st.subs.add(Subscription { topic: Topic::Quote, code: None, period: None, run_id: None });
    let mut rx = st.hub.subscribe();
    let mut poller = Poller::new(st.clone(), StdDuration::from_secs(60));

    // 第 1 轮：bar + quote 各一帧（其他标的的 quote 可能有，过滤找本 code）
    poller.tick().await.unwrap();
    let mut bar_seen = false;
    let mut quote_seen = false;
    while let Ok(m) = rx.try_recv() {
        match m {
            PushMsg::Bar { code, period, bar } if code == CODE => {
                assert_eq!(period, "1m");
                assert_eq!(bar.close, 1.0);
                bar_seen = true;
            }
            PushMsg::Quote { code, last, .. } if code == CODE => {
                assert_eq!(last, 1.0);
                quote_seen = true;
            }
            _ => {}
        }
    }
    assert!(bar_seen && quote_seen, "首轮推送 bar 与 quote");

    // 第 2 轮：无增量 → 不重推
    poller.tick().await.unwrap();
    let mut resent = false;
    while let Ok(m) = rx.try_recv() {
        match m {
            PushMsg::Bar { code, .. } | PushMsg::Quote { code, .. } if code == CODE => resent = true,
            _ => {}
        }
    }
    assert!(!resent, "游标推进，无增量不重推");

    // 新 bar → 再推（bar 与 quote 均为最新值）
    seed(&pool, 1, 2.0).await;
    poller.tick().await.unwrap();
    let mut new_close = None;
    while let Ok(m) = rx.try_recv() {
        if let PushMsg::Bar { code, bar, .. } = m {
            if code == CODE { new_close = Some(bar.close); }
        }
    }
    assert_eq!(new_close, Some(2.0));

    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
}
```

## 5. eestock-app（app crate 加法：应用面进程入口）

`crates/app/src/lib.rs` 增加 `pub mod app_config;`（声明维护在 03-collector/02-data-plane.md，纯加法）。
`--self-check` 子命令复用 `app::healthz::self_check`（同步 TCP 探测 /healthz，compose healthcheck 用）。

``` {.rust file=crates/app/src/app_config.rs}
//! 应用面配置：TOML 文件 + 环境变量覆盖（DATABASE_URL / APP_LISTEN）。
//! 与数据面 DataConfig 并列（同文件级惯例：secret 走 env，不落配置文件）。

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub database_url: String,
    /// 监听地址（REST/WS/SPA 同端口）
    #[serde(default = "default_listen")]
    pub listen: String,
    /// SPA 静态目录（容器 /app/dist；本地 ./web/dist）
    #[serde(default = "default_static_dir")]
    pub static_dir: String,
    /// /api/sources/health 与 WS health 推送的默认统计窗口（秒）
    #[serde(default = "default_health_window")]
    pub health_window_secs: i64,
    /// WS 推送轮询周期（毫秒）
    #[serde(default = "default_ws_poll_ms")]
    pub ws_poll_ms: u64,
    /// MCP HTTP/SSE 监听地址（Wave 1 Phase D，ADR-009；与 web 同进程、端口独立，仅局域网）
    #[serde(default = "default_mcp_listen")]
    pub mcp_listen: String,
    /// 告警评估节拍（毫秒，Wave 2 Phase B；页面⑦ 告警引擎 1min 一轮）
    #[serde(default = "default_alert_eval_ms")]
    pub alert_eval_ms: u64,
}

fn default_listen() -> String { "0.0.0.0:8081".into() }
fn default_mcp_listen() -> String { "0.0.0.0:8082".into() }
fn default_static_dir() -> String { "./web/dist".into() }
fn default_health_window() -> i64 { 3600 }
fn default_ws_poll_ms() -> u64 { 3000 }
fn default_alert_eval_ms() -> u64 { 60_000 }

/// 加载：TOML → env 覆盖（DATABASE_URL / APP_LISTEN）。
pub fn load(path: &str) -> anyhow::Result<AppConfig> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read config {path}: {e}"))?;
    let mut cfg: AppConfig = toml::from_str(&text)
        .map_err(|e| anyhow::anyhow!("parse config {path}: {e}"))?;
    if let Ok(v) = std::env::var("DATABASE_URL") { cfg.database_url = v; }
    if let Ok(v) = std::env::var("APP_LISTEN") { cfg.listen = v; }
    if let Ok(v) = std::env::var("MCP_LISTEN") { cfg.mcp_listen = v; }
    Ok(cfg)
}
```

``` {.rust file=crates/app/src/bin/eestock-app.rs}
//! eestock-app —— 应用面进程（web REST/WS + diagnose 读库 + SPA 托管）。
//! ADR-017：与数据面零 API 直连，唯一耦合点 = TimescaleDB；启动 schema 自检复用 storage::migrate_check。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

use app::app_config;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // compose healthcheck 子命令（运行时镜像无 curl/wget；复用数据面 healthz::self_check）
    if args.iter().any(|a| a == "--self-check") {
        let port: u16 = arg_val(&args, "--port")
            .and_then(|v| v.parse().ok())
            .or_else(|| std::env::var("APP_PORT").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(8081);
        std::process::exit(if app::healthz::self_check(port) { 0 } else { 1 });
    }
    let config_path = arg_val(&args, "--config")
        .unwrap_or_else(|| "./config/app.toml".to_string());
    let cfg = app_config::load(&config_path)?;

    // JSON 日志（与数据面同口径）
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into()))
        .init();
    tracing::info!(config = %config_path, "eestock-app starting");

    let pool = PgPool::connect(&cfg.database_url).await?;
    storage::migrate_check::verify_schema(&pool).await?;
    tracing::info!("schema self-check ok");

    // DI 装配（ADR-017：app 是唯一持有 storage 具体实现的应用面组件；
    // web 只见 domain::ports，diagnose 只见 domain::ports::HealthEventsRead）
    // Phase D：HealthEventsRead 实现实例 web 与 mcp 共享（同一 Arc）
    let health_events: Arc<dyn domain::ports::HealthEventsRead> =
        Arc::new(storage::reader::HealthEventReader::new(pool.clone()));
    // 页面⑧ S1：系统信息（crate 版本走 env!，web 不依赖 collector/storage）；uptime 以进程启动 Instant 起算
    let system_info = web::settings::SystemInfoSource {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        crate_versions: web::dto::CrateVersions {
            collector: collector::VERSION.to_string(),
            storage: storage::VERSION.to_string(),
            diagnose: diagnose::VERSION.to_string(),
        },
        db: storage::system::system_info(pool.clone()),
        started_at: std::time::Instant::now(),
    };
    // Wave 3 Phase 3c：回测 DI（storage BarReader + PgBacktestStore + WS 进度 sink → application BacktestService）
    // 并发上限用 application::service::DEFAULT_MAX_CONCURRENT（ADR §7 = 4；本期不开放配置）
    let backtest_hub = web::ws::WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    // Wave 3 页面①：看板收藏（FavoriteStore，favorite_symbols 表 0013）
    let favorites: Arc<dyn domain::ports::FavoriteStore> =
        Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone()));
    // 行情看板 MA 可配置（MaConfigStore，ma_config 表 0015；主图+宫格应用，回测弹窗不动）
    let ma_config: Arc<dyn domain::ports::MaConfigStore> =
        Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone()));
    // 页面⑧ 系统设置 S2：配置持久化（ConfigStore，app_config 表 0021；sources/collector/mcp 三块）
    let config: Arc<dyn domain::ports::ConfigStore> =
        Arc::new(storage::config_store::PgConfigStore::new(pool.clone()));
    // 11-sim-live / L1：模拟实盘服务（sim_* 工具 + web 面板 /api/sim-live/*；SimSessionStore + SystemClock + 默认 FeeModel）。
    // L3「回测一下」：注入回测服务，sim_run_backtest_compare 复用既有 backtest 引擎触发对比 run。
    // **MCP 与 web 共享同一服务实例**（ADR 11-sim-live §7 双通道一致性）：同一 Arc 同时装入 AppState.sim 与 McpState.sim。
    // 持仓 latest/market_value 经行情源读端口解析（复用 state.kline 同款 KlineReader）；缺行情才回退 0.000。
    let sim_kline: Arc<dyn domain::ports::KlineRead> =
        Arc::new(storage::reader::KlineReader::new(pool.clone()));
    let sim_service = Arc::new(application::simlive::SimLiveService::with_default_fee(
        Arc::new(storage::sim::PgSimSessionStore::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    )
    .with_backtest(backtest.clone())
    .with_kline(sim_kline.clone()));
    // 11-sim-live 启动恢复：收敛/恢复进程重启遗留的 running 会话（读 simsession_state 重建内存续跑；无 state → ended+告警）。
    let sim_recovery = sim_service.recover_sessions().await?;
    tracing::info!(recovered = %sim_recovery.recovered.len(), degraded = %sim_recovery.degraded.len(), "sim-live 启动恢复完成");
    let state = Arc::new(web::state::AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(health_events.clone()),
        // Phase C：symbols 写端点 / with_stats 当日统计 / 熔断复位 DB 控制通道
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎（评估读端口 + 应用面自有表持久化 + SystemClock；02-alerts.md）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（页面④ 三端点 + tushare status；MCP④ 复用同实例）
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info,
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest: backtest.clone(),
        backtest_ws,
        // Wave 3 页面①：看板收藏（FavoriteStore）
        favorites,
        // 行情看板 MA 可配置（MaConfigStore）
        ma_config,
        // 页面⑧ 系统设置 S2：配置持久化（ConfigStore）
        config,
        // 11-sim-live / L3b：模拟实盘服务（与 MCP 共享同一 SimLiveService 实例）
        sim: Some(sim_service.clone()),
        static_dir: cfg.static_dir.clone().into(),
        health_window_secs: cfg.health_window_secs,
        hub: backtest_hub,
        subs: web::ws::SubscriptionRegistry::default(),
    });
    tokio::spawn(web::ws::Poller::new(state.clone(), Duration::from_millis(cfg.ws_poll_ms)).run());

    // Wave 2 Phase B：告警评估节拍（默认 1min；新建/续触发/恢复事件经 WS {type:"alert"} 推送）
    tokio::spawn(web::alerts::AlertEvaluator::new(
        state.clone(), Duration::from_millis(cfg.alert_eval_ms)).run());

    // 11-sim-live / L4（F2）：实时评分 feed（poll 式：每 DEFAULT_POLL_INTERVAL 查每标的最近 bar ts，
    // 新 bar 即 process_bar → 评估/评分/聚合/达阈值+统一开关开 → 自动模拟单）。复用 state.kline。
    tokio::spawn(application::simlive_feed::SimLiveFeed::new(
        sim_service.clone(),
        state.kline.clone(),
        application::simlive_feed::DEFAULT_POLL_INTERVAL,
    ).run());

    // Wave 1 Phase D：MCP HTTP/SSE 服务（ADR-009 范围①②）——与 web 同进程、端口独立
    // （design/07-app-plane/01-mcp.md；复用同一 KlineRead/HealthEventsRead 端口实现实例）
    let mcp_state = Arc::new(mcp::state::McpState {
        kline: state.kline.clone(),
        health: diagnose::health::HealthService::new(health_events),
        // Wave 2 Phase A：MCP④ get_data_quality（与 web 共享同一 QualityService 实例，Clone=同 Arc 组）
        quality: state.quality.clone(),
        default_window_secs: cfg.health_window_secs,
        sessions: mcp::state::SessionRegistry::default(),
        sim: Some(sim_service),
    });
    let mcp_listen = cfg.mcp_listen.clone();
    tokio::spawn(async move {
        if let Err(e) = mcp::server::serve(mcp_state, &mcp_listen).await {
            tracing::error!(error = %e, "mcp server exited");
        }
    });

    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    tracing::info!(listen = %cfg.listen, static_dir = %cfg.static_dir, "eestock-app serving");
    axum::serve(listener, web::build_router(state)).await?;
    Ok(())
}

fn arg_val(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}
```

``` {.rust file=crates/app/tests/app_config.rs}
//! 应用面配置解析测试（TOML 默认值 + env 覆盖）。

use app::app_config;

#[test]
fn parse_minimal_uses_defaults_and_env_overrides() {
    let dir = std::env::temp_dir().join(format!("eestock-app-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("app.toml");
    std::fs::write(&p, "database_url = \"postgres://u:p@db:5432/eestock\"\n").unwrap();
    // env 覆盖测试与解析测试同进程：先暂存并清除真实 env
    let saved_db = std::env::var("DATABASE_URL").ok();
    let saved_listen = std::env::var("APP_LISTEN").ok();
    let saved_mcp = std::env::var("MCP_LISTEN").ok();
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("APP_LISTEN");
    std::env::remove_var("MCP_LISTEN");

    let cfg = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg.database_url, "postgres://u:p@db:5432/eestock");
    assert_eq!(cfg.listen, "0.0.0.0:8081");
    assert_eq!(cfg.static_dir, "./web/dist");
    assert_eq!(cfg.health_window_secs, 3600);
    assert_eq!(cfg.ws_poll_ms, 3000);
    assert_eq!(cfg.mcp_listen, "0.0.0.0:8082", "Phase D：MCP 缺省端口 8082（独立端口）");
    assert_eq!(cfg.alert_eval_ms, 60_000, "Wave 2 Phase B：告警评估节拍默认 1min");

    // env 覆盖（容器 secret/地址注入口径）
    std::env::set_var("DATABASE_URL", "postgres://override@h/db");
    std::env::set_var("APP_LISTEN", "127.0.0.1:9999");
    std::env::set_var("MCP_LISTEN", "127.0.0.1:9998");
    let cfg2 = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg2.database_url, "postgres://override@h/db");
    assert_eq!(cfg2.listen, "127.0.0.1:9999");
    assert_eq!(cfg2.mcp_listen, "127.0.0.1:9998", "MCP_LISTEN env 覆盖");

    match saved_db { Some(v) => std::env::set_var("DATABASE_URL", v), None => std::env::remove_var("DATABASE_URL") }
    match saved_listen { Some(v) => std::env::set_var("APP_LISTEN", v), None => std::env::remove_var("APP_LISTEN") }
    match saved_mcp { Some(v) => std::env::set_var("MCP_LISTEN", v), None => std::env::remove_var("MCP_LISTEN") }
    std::fs::remove_dir_all(&dir).ok();
}
```

## 6. 部署

- `Dockerfile.app`（本文档 tangle，审查返工后自包含）：三阶段——`frontend`（node:22，`npm ci` 严格按
  lock 安装 → **`VITE_API_MOCK=0 npm run build`**：镜像产物为生产部署，必须直连真后端，
  09-frontend §4 的 mock 默认仅限开发态；Wave 2 Phase C 联调发现缺该 env 会静默出 mock 数据）
  → `builder`（rust 编译 eestock-app）→ runtime（debian-slim 非 root，
  dist 从 frontend 阶段 COPY）。构建上下文无需预存 dist；`.dockerignore` 排除 node_modules/target/data 等。
  前端阶段构建前 `rm -rf dist` 清空历史产物（防旧镜像遗留的旧哈希 bundle 被 COPY 到运行时）。
  **builder 依赖缓存分层**（纯构建提速、零功能改动）：依赖图以各 crate 的 `Cargo.toml` 为层键——
  先 COPY 锁文件与 10 个 crate 清单（不含源码），`cargo fetch` 仅下载依赖；清单不变则本层与 fetch 层命中缓存，
  源码变更只触发 `COPY crates` 与 `cargo build` 重编。workspace 特例：`crates/*` 无显式 `[lib]`/`[[bin]]`，
  cargo 自动发现目标需 src，故先补 10 个空 `src/lib.rs` 使 fetch 可加载依赖图（见 data-plane.md §5 同注记），
  随后 `COPY crates ./crates` 以真实源码覆盖。
- compose `app` 服务（docker-compose.yml 手写例外）：`depends_on: timescaledb(healthy)`——
  **不依赖 data 服务**（两面零耦合，库为唯一耦合点）；`8081:8081`（数据面 8080 不动）；
  `./config/app.toml` 只读挂载（.gitignore；模板 config/app.toml.example 入库）；
  healthcheck 复用二进制 `--self-check`。
- `docker compose up -d` 一条命令起三容器（db/data/app），wave-1.md 验收口径。

``` {.dockerfile file=Dockerfile.app}
# Dockerfile.app — 应用面镜像（由 design/07-app-plane/00-web-api.md tangle 生成，禁止手改）
# 多阶段自包含（Phase A 审查返工）：frontend(node:22 构建 web/dist) → builder(rust) → runtime(非 root)
# dist 由镜像内构建产出，不依赖构建上下文预存（前端 dist 产物不入库，web/.gitignore 已含 dist/）
FROM node:22-bookworm-slim AS frontend
WORKDIR /web
# 锁文件先行：依赖层缓存（npm ci 严格按 lock 安装）
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# 清空历史构建产物：vite build 默认 emptyOutDir，但 COPY 的本地 web/dist 可能遗留旧哈希 bundle，
# 导致 /app/dist 出现多个历史 index-*.js（旧镜像产物残留）。删净避免旧 bundle 被侥幸 COPY 到运行时。
RUN rm -rf dist
# 生产镜像直连真后端（09-frontend §4：mock 开关默认仅开发态；缺省构建会静默出 mock 数据）
RUN VITE_API_MOCK=0 npm run build

FROM rust:1-bookworm AS builder
WORKDIR /build
# 依赖缓存分层：先 COPY 锁文件与 13 个 crate 的清单（层键=清单内容），cargo fetch 仅下载依赖、不碰源码；
# 清单不变 → 本层及 fetch 层命中 Docker 缓存，源码变更只触发 COPY crates 与 cargo build 重编（依赖已 fetch）。
COPY Cargo.toml Cargo.lock ./
COPY crates/alert/Cargo.toml crates/alert/Cargo.toml
COPY crates/app/Cargo.toml crates/app/Cargo.toml
COPY crates/application/Cargo.toml crates/application/Cargo.toml
COPY crates/backtest/Cargo.toml crates/backtest/Cargo.toml
COPY crates/collector/Cargo.toml crates/collector/Cargo.toml
COPY crates/diagnose/Cargo.toml crates/diagnose/Cargo.toml
COPY crates/domain/Cargo.toml crates/domain/Cargo.toml
COPY crates/mcp/Cargo.toml crates/mcp/Cargo.toml
COPY crates/simlive/Cargo.toml crates/simlive/Cargo.toml
COPY crates/providers/Cargo.toml crates/providers/Cargo.toml
COPY crates/storage/Cargo.toml crates/storage/Cargo.toml
COPY crates/tushare/Cargo.toml crates/tushare/Cargo.toml
COPY crates/web/Cargo.toml crates/web/Cargo.toml
# workspace 特例：crates/* 无显式 [lib]/[[bin]]，cargo 自动发现目标需 src。故先补空 src/lib.rs 使
# 每个 crate 可加载解析依赖图；随后 COPY crates ./crates 以真实源码覆盖（各 crate 均含真实 lib.rs，零残留）。
RUN for c in alert app application backtest collector diagnose domain mcp providers storage tushare web simlive; do mkdir -p "crates/$c/src"; : > "crates/$c/src/lib.rs"; done
RUN cargo fetch
COPY crates ./crates
RUN cargo build --release --bin eestock-app

FROM debian:bookworm-slim
RUN useradd --system --uid 10002 --no-create-home eestock
COPY --from=builder /build/target/release/eestock-app /usr/local/bin/eestock-app
# SPA 静态资源来自 frontend 阶段构建产物
COPY --from=frontend /web/dist /app/dist
USER eestock
EXPOSE 8081 8082
ENTRYPOINT ["/usr/local/bin/eestock-app"]
CMD ["--config", "/etc/eestock/app.toml"]
```

## 7. TDD 规格要点（Red-Green 记录）

- diagnose：成功率分母排除 na / percentile_cont 线性插值（与 PG 口径一致）/ 熔断态取最近迁移事件 /
  最近错误排除迁移类 / 状态灯 95% 边界 / 多源归组排序 / HealthService 端口注入（纯函数 + mock 端口，无 DB）；
  窗口过滤与字段映射由 storage 端口集成测试锁定（真实库 :5433）。
- storage reader：merge 视图准确层优先 / 游标不含 before 本身 / limit 降序取翻转升序 /
  cagg volume numeric→bigint / 1h rollup / symbols 最新快照与无 bar 标的（集成测试）。
- web：parse_period 前端口径 / 游标分页无重复缺漏 / 400 校验 / SPA 深链回退与目录穿越 /
  WS matches 矩阵与 JSON tag 形状 / Poller 增量推送不重复（单测 + 集成测试）。
- app：TOML 默认值 + env 覆盖。

## 8. Phase C：symbols 写端点 + 熔断复位 DB 控制通道（Wave 1 Phase C 任务书）

> 2026-09-06 Phase C 定稿节后落稿。契约表见 §1.1（Phase C 行）、边界见 §1.4。
> 事实约束（ADR-017 铁律）：应用面影响数据面**只能经 DB**。本阶段两条控制通道：
> ① symbols 表写入（数据面 Scheduler 每周期重读，间隔/启停热生效，03-collector §2 既有机制）；
> ② `circuit_reset_requests` 表（0007 迁移）+ 数据面 `collector::reset::ResetWatcher`
> 轮询消费（03-collector §10，纯加法扩展，数据面既有逻辑零改动）。

### 8.1 决策注记

- **名称不经服务端行情源反查**：03-symbols L2 的「注册时服务端反查名称」依赖行情源，
  与 ADR-017（应用面无数据面/外网直连）冲突 → 按 ADR-017 裁决：name 由请求体携带或留空
  （设计既定降级路径「失败留空可手工改」），可后续 `PATCH` 补录。
- **无 `DELETE /api/symbols`**：03-symbols §4 定稿仅停用（`enabled=false`），物理删除不在产品内。
- **复位为异步语义**：202 仅表示请求落库；数据面 ≤5s 消费后由数据面发出 `manual_reset`
  事件（单写者原则），diagnose 聚合呈现闭合、WS `health` 推送经 Poller 增量生效。
- **复位 id 不在应用面校验**：应用面不知编译期源清单；未知 id 由数据面消费端跳过并 warn。

### 8.2 storage 写/控制通道加法扩展（admin.rs）

父级授权口径同 Phase A reader（「storage 接口加法扩展可以」）：`admin.rs` 为纯新增文件，
写路径（kline/accurate/events/symbols.rs）零改动；`pub mod admin;` 声明维护在
design/04-storage/02-tushare-sync.md。实现 domain Phase C 端口（02-domain/contracts.md §2.4 尾部）。

``` {.rust file=crates/storage/src/admin.rs}
//! 应用面写/控制通道加法扩展（Wave 1 Phase C，ADR-017 授权口径；数据面既有写路径零改动）：
//! - PgSymbolAdmin：symbols 表注册/编辑（写即控制通道——Scheduler 每周期重读热生效）
//! - PgResetStore：熔断复位 DB 通道（应用面 request_reset 插入；数据面 take_pending 原子消费）
//!
//! 字段校验在 web 层完成（dto.rs 纯函数，与 schema CHECK 同口径）；本层仅落库，CHECK 兜底。

use anyhow::Result;
use async_trait::async_trait;
use domain::ports::{
    CircuitResetChannel, CircuitResetWrite, ResetRequest, SymbolAdminInput, SymbolAdminWrite,
    SymbolPatch,
};
use sqlx::PgPool;

/// symbols 表管理写（POST /api/symbols、PATCH /api/symbols/{code}）。
pub struct PgSymbolAdmin {
    pool: PgPool,
}

impl PgSymbolAdmin {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl SymbolAdminWrite for PgSymbolAdmin {
    /// 注册；ON CONFLICT DO NOTHING → rows_affected=0 即已存在（Ok(false)，web 映射 409）。
    async fn register(&self, input: &SymbolAdminInput) -> Result<bool> {
        let n = sqlx::query(
            "INSERT INTO symbols (code, name, interval_secs, settlement, enabled) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING")
            .bind(&input.code).bind(&input.name)
            .bind(input.interval_secs).bind(&input.settlement).bind(input.enabled)
            .execute(&self.pool).await?
            .rows_affected();
        Ok(n > 0)
    }

    /// 编辑（COALESCE 语义：None 字段不改）；code 不存在 → Ok(false)（web 映射 404）。
    async fn update(&self, code: &str, patch: &SymbolPatch) -> Result<bool> {
        let n = sqlx::query(
            "UPDATE symbols SET \
                 name = COALESCE($2, name), \
                 interval_secs = COALESCE($3, interval_secs), \
                 settlement = COALESCE($4, settlement), \
                 enabled = COALESCE($5, enabled) \
             WHERE code = $1")
            .bind(code).bind(&patch.name).bind(patch.interval_secs)
            .bind(&patch.settlement).bind(patch.enabled)
            .execute(&self.pool).await?
            .rows_affected();
        Ok(n > 0)
    }
}

/// 熔断复位 DB 控制通道（circuit_reset_requests，migrations/0007）：
/// 应用面写（CircuitResetWrite）+ 数据面消费（CircuitResetChannel），单表双角色。
pub struct PgResetStore {
    pool: PgPool,
}

impl PgResetStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl CircuitResetWrite for PgResetStore {
    async fn request_reset(&self, source: &str) -> Result<()> {
        sqlx::query("INSERT INTO circuit_reset_requests (source) VALUES ($1)")
            .bind(source).execute(&self.pool).await?;
        Ok(())
    }
}

#[async_trait]
impl CircuitResetChannel for PgResetStore {
    /// UPDATE ... RETURNING 原子消费（并发下同行只被一个消费者取出；
    /// circuit_reset_pending_idx 部分索引覆盖 consumed_at IS NULL）。
    async fn take_pending(&self) -> Result<Vec<ResetRequest>> {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "UPDATE circuit_reset_requests SET consumed_at = now() \
             WHERE id IN (SELECT id FROM circuit_reset_requests \
                          WHERE consumed_at IS NULL ORDER BY id) \
             RETURNING id, source")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id, source)| ResetRequest { id, source }).collect())
    }
}
```

集成测试（真实库 :5433；独立 code 段 9968xx + 独立 source 名，前后清理可重入）：

``` {.rust file=crates/storage/tests/symbol_admin.rs}
//! PgSymbolAdmin / PgResetStore / today_stats 集成测试（需 TimescaleDB :5433，含 0007 迁移）。

use chrono::{Duration, Utc};
use domain::ports::{
    CircuitResetChannel, CircuitResetWrite, SymbolAdminInput, SymbolAdminWrite, SymbolPatch,
    SymbolStatsRead,
};
use sqlx::PgPool;
use storage::admin::{PgResetStore, PgSymbolAdmin};
use storage::reader::KlineReader;

const CODE: &str = "996810";
const CODE2: &str = "996811";
const STATS_CODE: &str = "996812";
const RSRC: &str = "storage_test_reset_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool) {
    for c in [CODE, CODE2] {
        sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(c).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(c).execute(pool).await.unwrap();
    }
}

// 每测试独立 clean（同 binary 测试并行执行，共享清理会互删——实锤踩坑，见 kline_reader.rs 注记）
async fn clean_stats(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(STATS_CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(STATS_CODE).execute(pool).await.unwrap();
}

async fn clean_reset(pool: &PgPool) {
    sqlx::query("DELETE FROM circuit_reset_requests WHERE source = $1")
        .bind(RSRC).execute(pool).await.unwrap();
}

fn input(code: &str) -> SymbolAdminInput {
    SymbolAdminInput { code: code.into(), name: Some("测试ETF".into()),
        interval_secs: 60, settlement: "T1".into(), enabled: true }
}

#[tokio::test]
async fn register_update_roundtrip_and_conflict() {
    let pool = pool().await;
    clean(&pool).await;
    let admin = PgSymbolAdmin::new(pool.clone());

    assert!(admin.register(&input(CODE)).await.unwrap(), "首次注册成功");
    assert!(!admin.register(&input(CODE)).await.unwrap(), "重复注册 → false（409 语义）");

    // 编辑：间隔 60→300 + 停用（COALESCE 只动给定字段）
    let patch = SymbolPatch { interval_secs: Some(300), enabled: Some(false), ..Default::default() };
    assert!(admin.update(CODE, &patch).await.unwrap());
    let row: (i32, String, bool, Option<String>) =
        sqlx::query_as("SELECT interval_secs, settlement, enabled, name FROM symbols WHERE code = $1")
            .bind(CODE).fetch_one(&pool).await.unwrap();
    assert_eq!(row.0, 300, "间隔更新落库（数据面下周期热生效）");
    assert_eq!(row.1, "T1", "未给字段保持原值");
    assert!(!row.2, "停用落库（仅停用，无物理删除）");
    assert_eq!(row.3.as_deref(), Some("测试ETF"));

    assert!(!admin.update("996899", &SymbolPatch::default()).await.unwrap(),
        "未知 code → false（404 语义）");

    // schema CHECK 对齐双保险：web 层已拦 <60，此处锁库层约束仍生效
    let bad = SymbolAdminInput { interval_secs: 30, ..input(CODE2) };
    assert!(admin.register(&bad).await.is_err(), "interval_secs<60 被 schema CHECK 拒绝");
    let bad2 = SymbolAdminInput { settlement: "T2".into(), ..input(CODE2) };
    assert!(admin.register(&bad2).await.is_err(), "非法 settlement 被 schema CHECK 拒绝");
    clean(&pool).await;
}

#[tokio::test]
async fn today_stats_counts_shanghai_day_window() {
    let pool = pool().await;
    clean_stats(&pool).await;
    // 今日 2 根 + 昨日 3 根（Asia/Shanghai 日界由实现侧 domain::tz 计算）
    let now = Utc::now();
    for i in 0..2 {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(STATS_CODE).bind(now - Duration::minutes(i + 1)).execute(&pool).await.unwrap();
    }
    for i in 0..3 {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(STATS_CODE).bind(now - Duration::days(1) - Duration::minutes(i))
            .execute(&pool).await.unwrap();
    }
    let stats = KlineReader::new(pool.clone()).today_stats().await.unwrap();
    let s = stats.iter().find(|r| r.code == STATS_CODE).expect("含测试标的");
    assert_eq!(s.today_bars, 2, "仅当日（Asia/Shanghai 日界）行数");
    assert!(s.last_bar_ts.is_some());
    clean_stats(&pool).await;
}

#[tokio::test]
async fn reset_channel_write_take_consume_once() {
    let pool = pool().await;
    clean_reset(&pool).await;
    let store = PgResetStore::new(pool.clone());

    store.request_reset(RSRC).await.unwrap();
    store.request_reset(RSRC).await.unwrap();
    let taken = store.take_pending().await.unwrap();
    let mine: Vec<_> = taken.iter().filter(|r| r.source == RSRC).collect();
    assert_eq!(mine.len(), 2, "待消费请求原子取出");
    assert!(mine[0].id < mine[1].id, "按 id 顺序");
    let again = store.take_pending().await.unwrap();
    assert!(!again.iter().any(|r| r.source == RSRC), "已消费不重复取出");
    clean_reset(&pool).await;
}
```

### 8.3 web 集成测试（真实库 + 真实 server，契约锁定）

``` {.rust file=crates/web/tests/api_admin.rs}
//! Phase C 写端点集成测试（需 TimescaleDB :5433）：
//! POST/PATCH /api/symbols（校验 400/422、冲突 409、未知 404、with_stats）、
//! POST /api/sources/{id}/reset（202 + DB 通道行落库待消费）。

use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996820";
const RSRC: &str = "web_test_reset_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构；storage/sqlx 仅 dev-dependencies）。
fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（与 app bin 同口径；本文件不涉及行为，仅装配齐全）
    let backtest_hub = WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎装配（02-alerts.md；本文件不涉及行为，仅装配齐全）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（quality 端口组；仅装配齐全，行为测试见 api_quality.rs）
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest,
        backtest_ws,
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        // 行情看板 MA 可配置（装配齐全；行为测试见 api_ma_config.rs）
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

// 每测试独立 clean（同 binary 测试并行执行，共享清理会互删——实锤踩坑）
async fn clean(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
}

async fn clean_reset(pool: &PgPool) {
    sqlx::query("DELETE FROM circuit_reset_requests WHERE source IN ($1, 'no_such_source')")
        .bind(RSRC).execute(pool).await.unwrap();
}

#[tokio::test]
async fn symbols_register_edit_disable_and_stats() {
    let pool = pool().await;
    clean(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 注册（缺省值：interval=60 / settlement=T1 / enabled=true）→ 201 + 回读完整行
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": CODE})).send().await.unwrap();
    assert_eq!(r.status(), 201);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["code"], CODE);
    assert_eq!(v["interval_secs"], 60);
    assert_eq!(v["settlement"], "T1");
    assert_eq!(v["enabled"], true);
    assert!(v["latest"].is_null(), "无 bar 标的 latest 为 null");

    // 重复注册 → 409
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": CODE, "interval_secs": 120})).send().await.unwrap();
    assert_eq!(r.status(), 409);

    // 校验：北交所 422 / 非 6 位数字 400 / 间隔下限 400 / 非法 settlement 400
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "830799"})).send().await.unwrap();
    assert_eq!(r.status(), 422, "北交所前缀拒绝（暂不支持）");
    let body: Value = r.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("北交所"));
    for bad in [serde_json::json!({"code": "12345"}), serde_json::json!({"code": "60051a"})] {
        let r = http.post(format!("{url}/api/symbols")).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), 400, "{bad} → 400");
    }
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "996821", "interval_secs": 30})).send().await.unwrap();
    assert_eq!(r.status(), 400, "interval_secs<60 → 400");
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "996821", "settlement": "T2"})).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // 编辑：间隔 60→300 + 名称（热生效语义由数据面重读承载，本层锁落库与回读）
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"interval_secs": 300, "name": "测试ETF"})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["interval_secs"], 300);
    assert_eq!(v["name"], "测试ETF");
    assert_eq!(v["settlement"], "T1", "未给字段不变");

    // 停用（唯一删除语义，03-symbols §4）
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"enabled": false})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["enabled"], false);

    // 未知 code → 404；非法 PATCH 值 → 400
    let r = http.patch(format!("{url}/api/symbols/996899"))
        .json(&serde_json::json!({"enabled": true})).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"interval_secs": 10})).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // with_stats=1：今日 bar 数入列；不带参数不出 today_bars 键（Phase A 契约不回归）
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
        .bind(CODE).bind(Utc::now() - Duration::minutes(1)).execute(&pool).await.unwrap();
    let v: Value = http.get(format!("{url}/api/symbols"))
        .query(&[("with_stats", "1")]).send().await.unwrap().json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == CODE).expect("含测试标的");
    assert_eq!(s["today_bars"], 1);
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == CODE).unwrap();
    assert!(s.get("today_bars").is_none(), "无 with_stats 不出 today_bars 键");
    clean(&pool).await;
}

#[tokio::test]
async fn reset_endpoint_enqueues_db_control_row() {
    let pool = pool().await;
    clean_reset(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    let r = http.post(format!("{url}/api/sources/{RSRC}/reset")).send().await.unwrap();
    assert_eq!(r.status(), 202, "异步接受（数据面消费后生效）");
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "accepted");

    // DB 控制通道行落库且待消费（数据面 ResetWatcher 轮询取出）
    let (cnt,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM circuit_reset_requests WHERE source = $1 AND consumed_at IS NULL")
        .bind(RSRC).fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1);

    // 未知源 id 同样 202（应用面不知编译期源清单；数据面消费端跳过并告警）
    let r = http.post(format!("{url}/api/sources/no_such_source/reset")).send().await.unwrap();
    assert_eq!(r.status(), 202);
    clean_reset(&pool).await;
}
```

### 8.4 Phase C TDD 规格要点（Red-Green 记录）

- domain：`SourceId::parse` 全变体往返 + 未知文本 None（契约测试）。
- storage admin：注册/重复/编辑 COALESCE/未知 code/schema CHECK 双保险（interval<60、非法 settlement
  库层仍拒绝）；today_stats 当日 Asia/Shanghai 窗口；reset 通道原子消费不重复（集成测试）。
- collector reset：消费 → manual_reset（Healthy + 事件发出）；未知 source 跳过；空队列 noop
  （内存 channel + fake clock，无 DB）。
- web：注册 201+缺省值、409/422/400 矩阵、PATCH 回读与 404、停用、with_stats 出/不出键、
  reset 202 + DB 行待消费（集成测试）；dto 校验纯函数单测（code/interval/settlement/name）。

## 9. Wave 2 Phase A：数据质量端点 + D6 SPA 404（TDD 记录与集成测试）

- diagnose：deviation/summarize/accuracy_by_source/classify_gap_minute/segments_of 纯函数单测；
  QualityService 离线 mock 端口测试（周末/国庆/元旦排除、未来分钟不算缺口、三级分类、单日卡、
  tushare 状态聚合）——`crates/diagnose/tests/quality.rs`。
- storage：divergence_rows（重叠 ts/半开区间/code 过滤）、holidays 全表、events_between 半开区间、
  sync_checkpoints、**D3 重写语义锁定**（准确层更新 ts 优先 + 同 ts 并列准确层掩盖 raw）——
  kline_reader.rs 测试块尾部。
- web：三端点 + tushare status 真实库集成测试（下）；SPA `/api/*` 未命中 404（api_rest.rs SPA 节）。

``` {.rust file=crates/web/tests/api_quality.rs}
//! 数据质量端点集成测试（需 TimescaleDB :5433；真实库 + 真实 server）：
//! divergence / source-accuracy / gaps（含三级分类与节假日/周末排除）/ tushare status / D6 SPA 404。

use chrono::{DateTime, NaiveDate, Timelike, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996611";   // 独立测试标的（并行安全）
const SRC: &str = "webq_test_src";
const DAY: &str = "2026-09-02"; // 周三，交易日（测试运行时已成历史日，241 标签全到期）

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（与 app bin 同口径；本文件不涉及行为，仅装配齐全）
    let backtest_hub = WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase B：告警引擎（仅装配齐全，本文件不涉及其行为）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest,
        backtest_ws,
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        // 行情看板 MA 可配置（装配齐全；行为测试见 api_ma_config.rs）
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

fn cst(day: NaiveDate, h: u32, mi: u32, s: u32) -> DateTime<Utc> {
    domain::tz::cst_to_utc(day.and_hms_opt(h, mi, s).unwrap())
}

async fn clean(pool: &PgPool) {
    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(CODE).execute(pool).await.unwrap();
    }
    sqlx::query("DELETE FROM source_health_events WHERE code = $1")
        .bind(CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM sync_checkpoints WHERE code = $1")
        .bind(CODE).execute(pool).await.unwrap();
}

/// 造数：交易日 2026-09-02 全 241 标签（除 10:41/10:42/13:05/14:00 四分钟缺口）；
/// accurate 全覆盖（09:30 close 10.00 vs raw 10.10 → +1.0% 分歧 bar；其余一致）；
/// 事件：10:41:30 timeout（源故障）、13:05:20 na（源无数据）、14:00 邻近无事件（系统缺口）。
async fn seed(pool: &PgPool) {
    let day = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let skip = [(10u32, 41u32), (10, 42), (13, 5), (14, 0)];
    for l in domain::calendar::trading_minute_labels(day) {
        let (h, m) = (l.time().hour(), l.time().minute());
        if skip.contains(&(h, m)) { continue; }
        let ts = domain::tz::cst_to_utc(l);
        let raw_close = if (h, m) == (9, 30) { 10.10 } else { 10.00 };
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, $4) ON CONFLICT DO NOTHING")
            .bind(CODE).bind(ts).bind(raw_close).bind(SRC)
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount) \
                     VALUES ($1, $2, 'M1', 10.0, 10.0, 10.0, 10.0, 100, 100.0) ON CONFLICT DO NOTHING")
            .bind(CODE).bind(ts)
            .execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind, code) \
                 VALUES ($1, $2, false, 'timeout', $3), ($4, $2, true, 'na', $3)")
        .bind(cst(day, 10, 41, 30)).bind(SRC).bind(CODE).bind(cst(day, 13, 5, 20))
        .execute(pool).await.unwrap();
    sqlx::query("INSERT INTO sync_checkpoints (code, period, last_synced_date) \
                 VALUES ($1, 'M1', '2026-09-02') ON CONFLICT (code, period) DO NOTHING")
        .bind(CODE).execute(pool).await.unwrap();
}

#[tokio::test]
async fn quality_endpoints_full_flow() {
    let pool = pool().await;
    clean(&pool).await;
    seed(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // ── divergence：对照汇总 + 降序 + 只比 close ──
    let v: Value = http.get(format!("{url}/api/quality/divergence"))
        .query(&[("code", CODE), ("from", DAY), ("to", DAY)])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v["code"], CODE);
    assert_eq!(v["threshold_pct"], 0.5, "默认阈值 = 页面④ 定稿 0.5");
    assert_eq!(v["summary"]["compared_bars"], 237);
    assert_eq!(v["summary"]["divergent_bars"], 1, "仅 09:30 +1.0% 超阈");
    let rate = v["summary"]["divergence_rate"].as_f64().unwrap();
    assert!((rate - 1.0 / 237.0).abs() < 1e-9);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 237);
    assert!((rows[0]["deviation_pct"].as_f64().unwrap() - 1.0).abs() < 1e-6, "偏差降序首位 = 最大偏差");
    assert_eq!(rows[0]["raw_source"], SRC);
    // 阈值参数可调
    let v2: Value = http.get(format!("{url}/api/quality/divergence"))
        .query(&[("code", CODE), ("from", DAY), ("to", DAY), ("threshold_pct", "2")])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v2["summary"]["divergent_bars"], 0, "阈值 2% 时 +1.0% 计一致");

    // ── source-accuracy：按 raw_source 归组（本测试源独立，不受库中真实数据污染）──
    let v: Value = http.get(format!("{url}/api/quality/source-accuracy"))
        .query(&[("from", DAY), ("to", DAY)]).send().await.unwrap().json().await.unwrap();
    let mine = v["sources"].as_array().unwrap().iter()
        .find(|s| s["source"] == SRC).expect("含本测试源");
    assert_eq!(mine["samples"], 237);
    let cr = mine["consistency_rate"].as_f64().unwrap();
    assert!((cr - 236.0 / 237.0).abs() < 1e-9);

    // ── gaps：三级分类 + 段合并 + 仅缺口日出卡 ──
    let v: Value = http.get(format!("{url}/api/quality/gaps"))
        .query(&[("code", CODE), ("from", DAY), ("to", DAY)])
        .send().await.unwrap().json().await.unwrap();
    let days = v["days"].as_array().unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0]["date"], DAY);
    assert_eq!(days[0]["expected_bars"], 241);
    assert_eq!(days[0]["actual_bars"], 237);
    assert_eq!(days[0]["missing_bars"], 4);
    let segs = days[0]["segments"].as_array().unwrap();
    assert_eq!(segs.len(), 3);
    assert_eq!((segs[0]["start"].as_str().unwrap(), segs[0]["end"].as_str().unwrap(),
                segs[0]["count"].as_i64().unwrap(), segs[0]["class"].as_str().unwrap()),
        ("10:41", "10:42", 2, "source_fault"));
    assert_eq!((segs[1]["start"].as_str().unwrap(), segs[1]["class"].as_str().unwrap()),
        ("13:05", "upstream_no_data"));
    assert_eq!((segs[2]["start"].as_str().unwrap(), segs[2]["class"].as_str().unwrap()),
        ("14:00", "system_gap"));

    // 节假日/周末整日排除（0008 已落库：国庆 10-01..08；09-05/06 周末）
    for (from, to) in [("2026-10-01", "2026-10-08"), ("2026-09-05", "2026-09-06"),
                       ("2026-01-01", "2026-01-01")] {
        let v: Value = http.get(format!("{url}/api/quality/gaps"))
            .query(&[("code", CODE), ("from", from), ("to", to)])
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(v["days"].as_array().unwrap().len(), 0, "{from}..{to} 非交易日排除");
    }

    // ── tushare status：检查点透传 + quota 恒 null ──
    let v: Value = http.get(format!("{url}/api/tushare/status")).send().await.unwrap()
        .json().await.unwrap();
    let cps = v["checkpoints"].as_array().unwrap();
    assert!(cps.iter().any(|c| c["code"] == CODE
        && c["last_synced_date"] == "2026-09-02"), "检查点含测试标的");
    assert!(v["covered_codes"].as_i64().unwrap() >= 1);
    assert!(v["quota_remaining"].is_null(), "积分余额未入库 → 恒 null（§1.1 注明）");
    assert!(v.as_object().unwrap().contains_key("last_event"));

    // ── 参数校验 400 矩阵 ──
    for q in [
        vec![("from", DAY), ("to", DAY)],                          // 缺 code
        vec![("code", ""), ("from", DAY), ("to", DAY)],            // code 空
        vec![("code", CODE), ("from", "2026/09/02"), ("to", DAY)], // 非法日期
        vec![("code", CODE), ("from", DAY), ("to", "2026-09-01")], // from>to
        vec![("code", CODE), ("from", "2026-01-01"), ("to", "2026-12-31")], // 超跨度
        vec![("code", CODE), ("from", DAY), ("to", DAY), ("threshold_pct", "0")], // 阈值非正
    ] {
        let r = http.get(format!("{url}/api/quality/divergence")).query(&q).send().await.unwrap();
        assert_eq!(r.status(), 400, "{q:?} → 400");
    }
    let r = http.get(format!("{url}/api/quality/gaps"))
        .query(&[("from", DAY), ("to", DAY)]).send().await.unwrap();
    assert_eq!(r.status(), 400, "gaps 缺 code → 400");

    // ── D6：/api/* 未命中不回退 index.html → 404 JSON ──
    for p in ["/api", "/api/nonexistent", "/api/quality/nope"] {
        let r = http.get(format!("{url}{p}")).send().await.unwrap();
        assert_eq!(r.status(), 404, "D6：{p} 未匹配 → 404");
        assert_eq!(r.json::<Value>().await.unwrap()["error"], "not found");
    }
    // POST 方法同口径：/api/* 未匹配 → 404 JSON（非 index.html）
    let r = http.post(format!("{url}/api/nonexistent")).send().await.unwrap();
    assert_eq!(r.status(), 404, "D6：POST /api/* 未匹配 → 404");
    assert_eq!(r.json::<Value>().await.unwrap()["error"], "not found");
    // 对照：非 /api 深链仍回退 index.html（前端 history 路由）
    let body = http.get(format!("{url}/quality")).send().await.unwrap().text().await.unwrap();
    assert!(body.contains("eestock"), "页面④ 深链回退 index.html");

    clean(&pool).await;
}
```
