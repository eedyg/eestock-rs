# Tester 报告 007：Wave 2 验收测试（增量报告 — ⚠️ 用户暂停，部分项未验）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/007_wave2_acceptance.md`（本文件）
> 验收人：tester agent（只验收不改码）
> 依据：design/10-wave-plans/wave-2.md 验收节 + 任务书 Wave 2 验收项 1–7；报告线索 coder/report/011/012/013
> 验收时间：2026-09-04（周五，交易日）14:20–14:38 CST 首段 + **用户 17:52 CST 暂停指令**；期间环境经历 ~3h 挂起（app 容器 09:51:32Z 重启），续跑中断
> 被验部署：commit `7605b7d`（HEAD）；三容器 eestock-app(:8081/:8082)、eestock-data(:8080)、eestock-timescaledb(:5433) 均 healthy
> 纪律：规则阈值改动已恢复并验证（见 §10 台账）；无代码改动；无 docker prune/rm

## 0. 执行摘要（暂停时点快照）

| # | 验收项 | 状态（暂停时点） | 一句话证据 |
|---|--------|------------------|-----------|
| 1 | 门禁五件套 | ✅ PASS | tangle 无 diff；cargo test **194 passed/0 failed**；clippy **0 警告**；vitest **168/168**（21 文件）；vite build exit 0 |
| 2 | 交易日历 | ✅ PASS | holidays 表 34 行（2026 全量，含 10-01~10-08）；端午假日+周末实盘零缺口实证（06-15~06-22 窗口）；今日 518880 采集 209 bar 零缺口 |
| 3 | 页面④数据质量实盘 | ✅ PASS | 四端点真实数据（divergence 241 对照 2 分歧/只比 close；gaps 三级分类含真实 source_fault 段；tushare 44 标的）；无头渲染四区真实数据 + sync 按钮 disabled；518880 今日 days 空=零缺口（SQL 分钟序列对账 0 缺失） |
| 4 | 页面⑦告警+引擎实盘 | ⚠️ **部分 PASS** | 种子 4 规则✅ + 真实告警事件✅ + PATCH 阈值 1.0 生效✅ + 评估节拍 refire 落库✅（fire_count 2→3→…）+ 页面⑦无头渲染真实数据✅；**WS 推送帧 0 条收到（探测 A/B/C 三轮均空）⚠️ 未闭环**；ack 未由 tester 执行（环境挂起期间他方 07:15:49 ack） |
| 5 | backlog D3/D6 | ✅ PASS | /api/sources/health 2.4ms、/api/symbols 13ms（远 <100ms）；/api/nonexistent→404 JSON；未知前端路由仍回退 SPA 200 |
| 6 | MCP④ | ✅ PASS | get_data_quality(518880,2026-09-03) SSE 返回真实对照（trading_day true/241 比 2 分歧/一致性 99.17%） |
| 7 | 回归抽查 | ✅ PASS（含 1 观察） | /api/kline 1m 实时（06:27Z bar）；symbols 44 只；源健康卡真实；采集 44 行/分钟；**观察**：页面② gap-cards 404（旧端点从未交付，Wave1 页遗留，非本轮回归面） |

**暂停结论**：1/2/3/5/6/7 已验全 PASS；**#4 告警 WS 推送实盘证据缺失**（engine 状态机 DB 侧正常但 WS 帧未达订阅者，需续跑定位），且环境挂起造成验证窗口中断。**「Wave 2 可收官」结论未给出**，待续跑闭环 #4 后判定。

---

## 1. 验收项 1：门禁 —— ✅ PASS（独立复跑，2026-09-04 14:21 CST）

| 门禁 | 命令 | 结果 |
|---|---|---|
| tangle | `./scripts/check-tangle.sh` | ✅ `tangle 后无 diff，design 与生成物一致`（/tmp/wave2_gate_tangle.log） |
| 全量测试 | `cargo test --workspace --no-fail-fast` | ✅ **194 passed / 0 failed**（56 test binaries；/tmp/wave2_gate_cargotest.log） |
| lint | `cargo clippy --workspace --all-targets` | ✅ exit 0，0 warning / 0 error（/tmp/wave2_gate_clippy.log） |
| 前端单测 | `npx vitest run`（web/） | ✅ **168 passed（21 files）**（/tmp/wave2_gate_vitest.log） |
| 前端构建 | `npm run build` | ✅ exit 0，vite built（/tmp/wave2_gate_webbuild.log） |

满足任务书门槛：cargo test 194+ ✅、vitest 168+ ✅、clippy 0 ✅。

## 2. 验收项 2：交易日历 —— ✅ PASS

| 断言 | 证据 | 结果 |
|---|---|---|
| holidays 表 2026 数据 34 行 | SQL `count(*)=34`，min 2026-01-01 / max 2026-10-08，含 国庆 10-01~10-08 8 行 + 中秋 09-25~27 等 | ✅ |
| 今日（周五）交易日正常采集 | data 容器日志 `fetch ok` 持续；kline_raw 最近 2 分钟窗口 44 行/分钟；518880 今日 209 bar（14:27 CST，实时推进） | ✅ |
| 周末不计缺口（历史日期口径） | gaps API 2026-08-24~08-31：仅报 6 个交易日（08-24~28 + 08-31），**08-29/08-30 周末不出现** | ✅ |
| 法定假日不计缺口（历史日期口径） | gaps API 2026-06-15~06-22（含端午 06-19/20/21）：仅报 06-15~18 + 06-22 五个交易日，**06-19 端午假日（周五）不报缺口**（尽管当日 raw=0 bar）；holidays 表证 06-19 在册 | ✅ |
| 未来国庆窗口不产伪缺口 | gaps API 2026-09-28~10-09（含 10-01~10-08 国庆）：days=[]（未来交易日不在评估范围） | ✅ |
| 241 标签口径 | 09-03 交易日 518880 kline_raw=241 行（全天零缺口）；09-04 逐分钟对账 0 缺失（SQL 序列差集） | ✅ |

构造验证说明：接受项允许「用历史日期查询验证口径」——采用已过端午假日（系统 09-02 才部署、06-19 raw 必为 0）反向验证：若日历未排除假日，06-19 会与 06-15~18 一样被报为 system_gap；实测 06-19 缺席 → 日历排除生效。SQL 证据文件 /tmp/wave2_evidence/gaps_dw.json + psql 输出。

## 3. 验收项 3：页面④数据质量实盘 —— ✅ PASS

### 3.1 REST 四端点（09-03/09-04 真实数据，抓取 14:21 CST）

| 端点 | 结果要点 |
|---|---|
| `GET /api/quality/divergence?code=518880&from=2026-09-03&to=2026-09-04` | 200；rows=241；summary `{compared_bars:241, divergent_bars:2, divergence_rate:0.83%, consistency_rate:99.17%, max_deviation_pct:0.735%}`；rows 仅含 **close 三列**（raw_close/accurate_close/deviation_pct + raw_source/ts，**无 amount/volume 字段 → D4 只比 close 口径实证**）|
| `GET /api/quality/source-accuracy?from=2026-09-03&to=2026-09-04` | 200；7 源一致率降序（sina_jsonp 5527 samples 100%、tencent_ifzq 4856 samples 99.98%、ths_cs_approx 33 samples 96.97%、exchange_approx 48 samples 75%…） |
| `GET /api/quality/gaps?code=518880&from=2026-09-01&to=2026-09-04` | 200；09-01 全天缺 241 bar（system_gap 2 段 09:30-11:30/13:01-15:00）、09-02 缺 174；**09-03/09-04 不出现（零缺口）** |
| `GET /api/tushare/status` | 200；checkpoints **44 标的** last_synced_date 2026-09-03；last_event `{ok:true}`；quota_remaining null（文档口径） |

### 3.2 D5 三级分类实盘实证
- 09-02/09-03 采集未运行时段的缺口 → **system_gap**（多标的 26 只查询全 system_gap）。
- **真实 source_fault 段**：513100/513500/560010 @09-03 14:07–14:15 CST 被分类 `source_fault`（9 min）——与 source_health_events 中 tencent_ifzq 06:08:16–06:12:51Z timeout/circuit_open 失败簇时间吻合（失败证据驱动分类，SQL 对齐）。证据 /tmp/wave2_evidence/gaps_0903_all.jsonl。
- upstream_no_data：本次实盘窗口未见真实样本（由 diagnose 单测 14 例矩阵覆盖——归入门禁 194 内）。

### 3.3 518880 今日 days 为空（零缺口）正确性
- gaps API `days:[]`（from=to=2026-09-04）+ SQL 分钟序列差集：`generate_series(01:30Z..06:27Z)`（交易标签 ∪ 午休排除）与 kline_raw(518880,09-04) EXCEPT = **0 行缺失** → 零缺口判定正确。

### 3.4 无头渲染页面④
- chromium headless `--dump-dom :8081/quality`（/tmp/wave2_evidence/dom_quality.html，155KB）：
  - regions：`filter-bar / divergence-table / accuracy-cards / gap-report / sync-panel / nav / topbar` 全齐。
  - **divergence-table**：真实行 `09-03 14:02 1.784 1.788 −0.22% 腾讯ifzq …`。
  - **accuracy-cards**：真实源卡（新浪jsonp 100.0% 样本 7630 / 腾讯ifzq 100.0% 6128 / exchange_approx 75.0%…）。
  - **gap-report**：真实缺口日（08-31/09-01 缺 241 bar、09-02 缺 146 bar…段 + 「系统缺口」分类标签）。
  - **sync-panel**：`<button disabled title="下阶段开放">`（**置灰实证**）+ 「覆盖 44 只 · 最近事件 成功」真实状态。

## 4. 验收项 4：页面⑦告警中心 + 引擎实盘 —— ⚠️ 部分 PASS（WS 推送未闭环；tester 未做 ack；需续跑）

### 4.1 已验 ✅
- **种子 4 规则**：alert_rules 4 行（source_success_rate/symbol_gap_rate/collection_stall/tushare_daily_sync），阈值/静默/开关齐备。
- **真实告警产出**：alert_events 19 行——sina_jsonp source_success_rate triggered（部署后真实产出，fire_count 起点 2）+ symbol_gap_rate 多标的 resolved 链（13~219 id 区间）。
- **PATCH 规则热生效**：PATCH `/api/alert-rules` `{id:source_success_rate, threshold:1.0}` → 200 回读 threshold=1.0（DB updated_at 06:25:41Z）；恢复 PATCH 0.95/10 → 200 + DB 验证（09:51:50Z，见 §10）。
- **评估节拍落库**：阈值 1.0 + 临时静默 1min 后，DB refire 连续推进：`fire_count 2→3 (06:29:57Z)` → `→41 (07:10:00Z)`（last_fired_at 推进证明 1min 节拍持续评估 + 聚合防刷屏单条聚合生效）。engine 状态机 DB 侧工作正常。
- **页面⑦无头渲染**：`--dump-dom :8081/alerts`（dom_alerts.html）regions `alert-list / alert-filter / rule-panel / nav`；alert-list 含真实行「warning 14:19 sina_jsonp 成功率 94.7% < 95%（10min 窗口，160/169）×2 确认」+ 已恢复的 symbol_gap 行；rule-panel 四规则卡含阈值输入。

### 4.2 ⚠️ 未闭环（阻塞 #4 全 PASS）
- **WS 推送帧未达订阅者**：Node WS 客户端订阅 `topic:"alert"`（与前端同构帧）三轮探测：
  - probeA 06:25:06–06:32:06（7min）：0 帧 —— 期间 06:29:57 refire 已落库；
  - probeB 06:32:53–06:35:53：0 帧 —— 期间 refire 持续；
  - probeC 06:36:34–06:40:34：0 帧 —— 期间 06:37:58 refire 落库。
  - 对照：同脚本订阅 `health` 每 3s 稳定收帧（probe2 20s 收 6 帧）→ WS 通道本身通、alert topic 订阅无帧。DB refire 与 WS 帧缺失并存 → **WS alert 推送路径需续跑定位**（疑似 alert 评估推送与 WS hub 接线或评估器推送在本次部署中未生效；不做根因分析，仅记录现象）。证据：/tmp/wave2_evidence/ws_alert_probe{A,B,C}.log（均为 0 帧）。
- **ack 生命周期段未由 tester 执行**：POST ack / WS 恢复事件均未完成 —— 环境挂起 ~3h（06:38→09:51Z 时钟跳变）期间，event 219 于 **07:15:49Z 被外部方 ack**（acked_at 置位、fire_count 冻结 41、resolved_at 仍空）；非 tester 操作，需与父级/用户对账。

### 4.3 续跑建议（#4 补齐清单）
1. WS 订阅 alert topic 复测 + 定位推送缺失（检查部署 app 是否含 evaluator→hub publish 接线，012 报告 §6 api_alerts 集成测试在 repo 内通过）。
2. 阈值 1.0 → refire → **WS 帧捕获** → POST ack → 阈值恢复 0.95 → 恢复事件（resolved + WS 帧）全链路。
3. 与父级确认 event 219 状态（外部 ack 是否合规；如需复位 fire_count/acked_at 由数据面/父级裁决）。

## 5. 验收项 5：backlog 关闭复核 —— ✅ PASS

| 项 | 断言 | 实测 | 结果 |
|---|---|---|---|
| D3 | /api/sources/health 实盘耗时 <100ms | **2.3–2.7ms**（5 连测）；/api/symbols **13ms**（Wave1 实测 15–20s → 提速 3 个数量级） | ✅ |
| D6 | /api/nonexistent 返回 404 JSON 而非 index.html | `/api/nonexistent` → **404 `{"error":"not found"}`**（content-type application/json）；`/api/quality/nope` 同 404 | ✅ |
| D6 | 未知前端路由仍回退 SPA | `/some/unknown/route`、`/quality`、`/alerts` → 200 text/html index.html（SPA 回退限前端路由） | ✅ |

## 6. 验收项 6：MCP④ —— ✅ PASS

- Node SSE 全链路（/tmp/wave2_evidence/mcp_quality2.mjs，证据 mcp_quality2_raw.json）：GET /sse → endpoint 帧 → initialize → tools/list = `[get_kline, get_sources_health, get_data_quality]`。
- `tools/call get_data_quality {code:"518880", date:"2026-09-03"}` → **真实对照数据**：
  `{"trading_day":true, "gap":null, "divergence":{"compared_bars":241, "divergent_bars":2, "divergence_rate":0.83%, "consistency_rate":99.17%, "max_deviation_pct":0.735%}}` —— 与 REST 同服务同口径（同源一致）。

## 7. 验收项 7：回归抽查 —— ✅ PASS（附 1 观察）

| 链路 | 实测 | 结果 |
|---|---|---|
| /api/kline 1m 实时 | 518880 最新 bar `2026-09-04T06:27:00Z`（抓取 wall 同时刻，盘中实时），bars 升序 | ✅ |
| symbols 列表 | /api/symbols 200、44 只（含 518880/159337…），13ms | ✅ |
| 源健康卡片 | 页面② source-cards 真实渲染：新浪jsonp 97.2%（P50 9105ms）·腾讯ifzq 100.0%（P50 10137ms）；DOM 实证 | ✅ |
| 采集 44 行/分钟 | kline_raw 最近 1min 窗口 = 44 行（44 标的 × ~1）；data 日志 fetch ok 持续无 error/panic | ✅ |
| 页面① symbol-list | 无头渲染真实行情（159337 1.763 −0.06%…） | ✅ |
| **观察（非本轮缺陷）** | 页面② gap-cards 区报「HTTP 404 /api/collection/gaps?date=today」——该端点 Wave1 文档列示但**从未交付**（00-web-api §1.4「Phase A 不做」），Wave1 期被 VITE_API_MOCK 泄漏掩盖；Wave2 Phase C mock 泄漏修复后暴露。页面② 属 Wave1 地盘、Wave2 未触及；quality gaps 正确归属页面④（已 PASS）。**建议记 backlog：页面② gap-cards 接 /api/quality/gaps 或下线该区** | 记录 |

## 8. 复现观察清单（不改码）

| # | 级别 | 现象 | 复现路径 | 归属 |
|---|------|------|----------|------|
| O1 | 阻塞 #4 | WS `topic:"alert"` 订阅 0 帧，而 DB refire 持续落库（engine 状态机正常） | 3 轮 Node WS 探测（probeA/B/C，累计 ~15min）均 0 帧；health topic 同脚本收帧正常 | alert WS 推送路径（部署装配或 evaluator→hub 接线待查；012 集成测试 repo 内绿） |
| O2 | 观察 | 页面② gap-cards 404（/api/collection/gaps 从未交付） | 无头渲染 /sources；DOM「缺口数据加载失败：HTTP 404」 | Wave1 页遗留（mock 泄漏掩盖期产物），建议 backlog |
| O3 | 环境 | 验证窗口 06:38→09:51Z 时钟跳变 ~3h；app 容器 09:51:32Z 重启（RestartCount=0）；event 219 于 07:15:49Z 被外部方 ack | 睡眠轮询返回时发现 | 运行环境/编排侧（非 eestock 容器操作，无 docker 命令由 tester 发出） |

## 9. 判定与残余风险（暂停时点）

- **判定**：#1 #2 #3 #5 #6 #7 = PASS；#4 = **部分 PASS**（种子/真实事件/PATCH 热生效/评估节拍落库/页面渲染全过；**WS 推送实盘证据缺失 + ack/恢复段未闭环**）。
- **「Wave 2 可收官」未给出**：需续跑闭环 #4（O1 定位 + 全生命周期 + WS 帧）+ 父级对账 event 219 外部 ack。
- **残余风险**：
  1. O1 WS alert 推送：若为部署装配缺失（evaluator 未 publish 或 hub 未接线），影响页面⑦实时刷新（REST 列表仍可用）；012 集成测试与 repo 代码均证功能存在，倾向部署/接线层。
  2. 环境时钟跳变 + app 重启（09:51:32Z）：恢复后 app 评估器已重跑（restart 后 alert_rules 恢复行 09:51:50Z 生效），但事件 219 保持外部 ack 状态；续跑需重设基线。
  3. alert_eval 期间 fire_count 41 为阈值 1.0+静默 1min 实验的聚合副作用（单条聚合防刷屏按设计），恢复 0.95/10 后不再快速 refire。
  4. upstream_no_data 实盘样本缺失（单测覆盖，未实盘取证）。
  5. page② gap-cards 404 观察项（O2）待 backlog 裁决。

## 10. 数据变更台账（纪律）

1. **alert_rules.source_success_rate**：14:25:41Z PATCH threshold 0.95→**1.0**（实验）；14:32:55Z PATCH silence_minutes 10→**1**（加速节拍取证）；**09:51:50Z 恢复 PATCH threshold=1.0→0.95 + silence_minutes=1→10** → DB 复核 `threshold=0.95, silence_minutes=10, enabled=t` ✅（四规则行全部回到初始种子值）。
2. **event 219（sina_jsonp source_success_rate）**：实验前状态 triggered/fire_count=2（真实产出）；实验期 refire 至 fire_count 41（1min 静默聚合）；**07:15:49Z 被外部方 ack**（tester 未执行 ack，已披露，待父级对账处置）。未做 SQL 篡改。
3. 无 docker 操作（未 restart/rm/prune）；无代码/配置改动；kline/symbols 零写入。
4. 证据文件全部在 /tmp/wave2_evidence/（门禁日志 wave2_gate_*.log、API JSON、DOM、WS 探测、MCP 原始帧）。

## 11. 续跑指引（恢复时从何继续）

1. 基线重取：alert_rules 四行种子值、event 219 状态（与父级对账 ack 处置）。
2. #4 闭环：WS alert 订阅复测（先健康探测验证 WS 通 → 再验 alert topic）→ 阈值 1.0 → refire → WS 帧 → POST ack → 恢复 0.95 → resolved + WS 帧 → 恢复种子值 + 台账。
3. O1 若复现：查部署 app 装配（AlertEvaluator→hub publish 链路）与 WS 订阅匹配；repo 集成测试可离线佐证。
4. 补验：upstream_no_data 实盘样本（可选）、event 219 外部 ack 合规确认。
