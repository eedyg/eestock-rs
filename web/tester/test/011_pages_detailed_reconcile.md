# 011 五启用页面详细验收报告（功能 + DB/API 权威对账 + 边界/空态/错误态 + 跨页 + 置灰）

> 报告文件位置：`web/tester/test/011_pages_detailed_reconcile.md`（本文件自身）
> 执行角色：tester（只测不改：未修改任何源码/DB/SQL；仅做了可清理的测试性写入并已还原）
> 环境：`eestock-app`（d9ddb9441c07, healthy）；前端/API `http://192.168.50.100:8081`（同 192.168.50.100:8081）
> DB：`127.0.0.1:5433`（eestock-timescaledb）；权威对账全部直查 DB，不信页面/API 回显。
> 执行窗口：e2e 全量回归 2026-09-04 15:10–15:16Z；人工/程序化验收 15:17–15:35Z（环境时钟 2026-09-04，模拟交易日）。
> 证据目录：`/tmp/acct_evidence/`（末尾「证据索引」列出全部 100+ 文件：JSON/PNG/SQL 输出/脚本）。

---

## 0. 结论摘要

| 维度 | 结论 |
|---|---|
| 第1层 e2e 全量回归 | **55 通过 / 2 失败**（D9 = 既有；视觉-alerts = 数据敏感基线漂移，非本次引入） |
| 第2层 数据↔DB/API 对账 | **页面①③④⑦ 全一致；页面② 健康/缺口/预览全一致**（唯一发现=detail-panel 后端端点缺失，见缺陷 D1） |
| 第3层 边界/空态/错误/跨页/WS/置灰 | 全部按预期（含 4 处发现：D1 detail-panel 404、D2 停用后仍显示于行情、N1 空名可注册、N2 alerts 视觉基线数据敏感） |
| 崩溃 / core dump | 无（页面崩溃 0；无 core 文件） |
| 测试副作用 | alerts.e2e 确认 id=264（triggered→acked，台账备注）；symbols.e2e 510300 已 SQL 清理归零；tester 探针写入均已还原（见 §6） |

**页面核心数据对账速览**：symbol 最新价 **44/44 精确一致**；source 健康指标 **精确一致**；symbols 登记 **44/44 全字段一致**；quality 分歧 **577/577 行精确一致**、缺口逐日精确、源一致率 7/7 精确；alerts 列表/字段/状态 **精确一致**。

---

## 1. 第 1 层：e2e 全量回归（npx playwright test，baseURL=192.168.50.100:8081，workers=1，retries=1）

### 1.1 汇总
- 命令：`E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test`（web/ 下）
- 结果：**55 passed / 2 failed**（57 个用例；无 skipped；无中断崩溃），耗时 4.8 分钟，EXIT=1。
- 文件级：alerts/canvas/dashboard/data-success(5)/kline-matrix/kline-scale/quality/smoke/symbols/visual/walkthrough/ws 全文件执行。

### 1.2 通过明细（55 条 PASS，逐文件）
| 文件 | 结果 |
|---|---|
| alerts.e2e（告警确认流，flip 264→acked，容忍分支记录） | ✅ PASS |
| canvas.e2e（klinecharts 真实绘制非空白） | ✅ PASS |
| dashboard.e2e（选股/切周期/分时/宫格/缩放回最新） | ✅ PASS |
| data-success.e2e（①~⑦ 真实数据渲染 + 无错误横幅 ×5） | ✅ PASS |
| kline-matrix.e2e（A1…H18 全交互矩阵，除 D9 外全过，含 WS 注入 D10/E12/G16/G17 长稳） | ✅ PASS（D9 见 1.3） |
| kline-scale.e2e（比例/稳定性修复回归） | ✅ PASS |
| quality.e2e（默认范围分歧表 + 日期变更重查） | ✅ PASS |
| smoke.e2e（五页加载/data-region/未知路由回退/置灰回退/深链直达/缓存头 ×10） | ✅ PASS |
| symbols.e2e（注册 510300→列表出现→停用→SQL 清理归零；台账见 e2e/sql-ledger.md 15:15:51Z） | ✅ PASS |
| visual.e2e（dashboard/sources/symbols/quality 基线 4/5；alerts 基线见 1.4） | ⚠️ 4 PASS / 1 FAIL |
| walkthrough.e2e（五页截图走查产物落 design/06-web/preview/） | ✅ PASS |
| ws.e2e（/ws 连接 + 订阅 quote/health/bar 帧确定性 + TopBar 无连接/断开 pill） | ✅ PASS |

### 1.3 失败① — kline-matrix D9（判定：**先于本次验收的既有失败**，用例断言过期）
- 断言：`e2e/kline-matrix.e2e.ts:363` `expect(hit.length).toBeGreaterThan(0)`，其中 hit=含 `period=1m` 且 `limit=480` 的 REST 请求。
- 实测（浏览器抓包证据）：切「分时」实际发出 **`/api/kline?code=159337&period=1m&limit=482`**（limit=482，非 480）→ 断言 0 命中 FAIL（两次 attempt+retry 均失败）。
- 根因证据：`web/src/features/dashboard/feed.ts` `BARS_PER_TRADING_DAY['1m']=241`、`defaultPageSizeForPeriod=period×2 → 482`（K 线修复提交 1a1a798 引入「2 交易日视口」口径），D9 用例仍断言旧值 480。
- 截图/产物：`/tmp/acct_evidence/kline-matrix.e2e.ts-…-D9…-chromium_test-failed-1.png`、`shot_*`（error-context 同目录 web/e2e/artifacts/test-results/）。
- 无 console error、无崩溃。

### 1.4 失败② — visual.e2e「视觉基线 告警 /alerts」（判定：**既有/非本次引入；基线对告警行数数据敏感**）
- 断言输出：Expected 1488×969 vs Received 1488×1015；68402 px（ratio 0.05）不同。
- 高度差来源（程序测量）：/alerts 页 alert-list 为自然高滚动容器（当前 20 行 ≈ 944px 高，docH=1015）；基线生成时（提交 5fa453e 17:59CST）事件 19 行 → 页高 969；**+46px ≈ 1 条告警行**。id=264 于 20:40 CST 触发（晚于基线生成）、23:11 CST 被 alerts.e2e 确认，行数 19→20。
- 排除本次引入：alerts 页面/布局代码自基线重建（5fa453e）以来零改动（git：`web/src/features/alerts/*` 最后提交 c22306f 13:38、AlertsGrid/AppShell 无 f524a58 后提交）；K 线修复系列（1a1a798/9e09cd2/26b711d）未触及 alerts 页。→ 数据驱动漂移，任何新告警事件都会再触发（固有 flaky；修复方向=固定高度/滚动容器或按行数 mask，交架构师）。
- 截图：actual/expected/diff 三件套已入 `/tmp/acct_evidence/visual.e2e.ts-…-alerts-full-{actual,expected,diff}.png`。

---

## 2. 第 2 层：各页关键展示数据 ↔ DB/API 权威对账（核心）

> 口径：权威 = 直查 timescaledb；SQL/自聚合脚本与输出存 `/tmp/acct_evidence/p0*.txt|json`。

### 2.1 ① 行情看板 `/` —— **一致（44/44 精确）**
- API vs DB：对每个 enabled code，`kline_accurate(period='M1')` 最新 close=last、与前一 bar close 算 change_pct。
  - 结果：44/44 条；`last` 最大差 **0**，`change_pct` 最大差 **0**（double 全等）；DB 有而 API 无 / API 有而 DB 无 = 空集。
- UI vs API：页面 symbol-list 渲染 44 行与 API 同序同值；逐行 price/pct 文本与 API 值全等（price ±0.0005，pct 文本 = API change_pct 格式化）。551000 无名称（DB name=NULL）UI 以 code 兜底展示（既有数据形态，非缺陷）。
- 默认主图：1m 视口请求 = `15m&limit=34`（2 交易日）；分时 `1m&limit=482`；K 线交互矩阵全 PASS（第 1 层已覆盖）。

### 2.2 ② 数据源诊断 `/sources` —— **一致（健康指标精确）**
- 源健康卡 vs `source_health_events` 自聚合（复刻 `diagnose::health::aggregate_events` 纯函数口径：na 出分母、ok 延迟分位、最近迁移事件推熔断态）：
  - window=3600：sina_jsonp attempts 2 / successes 2 / rate 1.0 / p50 **595.5** / p95 **854.25** / closed / last_event 14:36:00.825568Z —— 全部与 API 全等（仅 `+00` vs `Z` 序列化格式差异）。
  - tencent_ifzq 同法全等（p50 592.0 / p95 805.3）；window=600 抽查（1 次失败事件 → attempts1/successes0/rate0.0/p50 null）与 SQL 一致。
  - UI 卡片文本 = API（成功 100.0%（1h）·P50 596ms；tencent 降级 66.7% 实时同步显示；熔断/最近错误区正常）。
- 缺口摘要标的 vs `/api/quality/gaps`（159337, 近 7 日）：08-31 241/0/241、09-01 241/0/241、09-02 241/95/146（含 13:01–13:12 等分段明细），09-03/09-04 无缺口 —— 与 raw 逐分钟对账一致（脚本逐日统计）。
- 告警预览计数 vs `/api/alerts?limit=10`：UI「最近 10 条告警」，10 条内容/顺序（CST 20:40=264、15:10=219、14:54=229…）与 DB `alert_events` 按 last_fired_at 降序前 10 全等。
- ⚠️ 例外发现：源卡点击后 detail-panel 调用的 4 个端点后端不存在（404），见缺陷 **D1**（与「显示数据一致性」无关，属第 3 层错误态范畴）。

### 2.3 ③ 标的管理 `/symbols` —— **一致（44/44 全字段）**
- `GET /api/symbols?with_stats=1`（44 行）vs `symbols` 表 + `kline_raw` 当日计数（Asia/Shanghai 日界）：
  - code/name/interval_secs/settlement/enabled 全等；`today_bars` 与 DB 当日 raw 计数全等（含异常行 516380=240、551000=239——API/DB 同为该值，非不一致）。
  - UI 表格 44 行与 DB 逐行一致（今日已采 240/239 亦一致）；「最新 bar 时刻 15:00:00」= kline ts 07:00Z→CST。
- 关联：`/api/symbols`（不带 with_stats）与质量页/数据源页标的选择器数据源同一（44 行）。

### 2.4 ④ 数据质量 `/quality` —— **一致（分歧 577/577 行精确 + 缺口逐日 + 源一致率 7/7 + tushare 44/44）**
- 分歧表（默认 code=159337, 08-29..09-04, threshold 0.5%）：API summary `compared=577 / divergent=0 / consistency=1.0 / max_dev=0.2237136465324387` 与直查 `kline_raw ⋈ kline_accurate(M1)` SQL 全等；**577/577 行**（ts/raw_close/accurate_close/deviation_pct/raw_source/排序）字段级全等（实差 0；仅时间戳 +00/Z 序列化差异）。注意实现口径：dev=(raw−accurate)/accurate×100（任务描述中的 /raw_close 为近似描述，代码与 DB 侧均以 accurate 为分母——此处以代码/DB 为权威，页面、API、SQL 三方一致）。
- 缺口报告：与 raw 逐 trading-minute 对账逐日相等（见 2.2 缺口段；页面 ④ gap-report 与页 ② 缺口摘要同源同值）。
- source-accuracy：7/7 源 samples/consistency_rate/avg/max 与 DB 自聚合全等（to 1e-6）：push2delay_approx 50/1.0、sina_jsonp 12608/1.0、tencent_ifzq 11751/0.9999149、ths_cs_approx 33/0.969697、exchange_approx 48/0.75 等。UI 卡片同值（一致率四舍五入 99.99→100.0% 属显示取整，非不一致）。
- tushare 状态（sync-panel）vs `sync_checkpoints`：44/44 行（code/period/last_synced_date=2026-09-04/updated_at=10:00:0xZ→18:00 CST）全等；covered=44；last_event ok 18:00 CST；UI「最近同步 09-04 18:00 · 覆盖 44 只 · 最近事件 成功 09-04 18:00」一致；quota_remaining=null（后端恒置，UI 显示 —，与设计一致）。
- 空态（2020-01-01..07）：分歧表显示设计空态文案「该范围无比对数据（accurate 未同步时常见…）」；缺口报告列出历史空窗日（2020 无节假日行 → 按工作日 241 全缺，逻辑与后端规则一致）——**记为「空态正常」，不计不一致**。

### 2.5 ⑦ 告警中心 `/alerts` —— **一致（列表/字段/状态/过滤精确）**
- DB 现状：20 条（acked 2 / resolved 18 / triggered 0），17 个来源，4 规则。
- 列表 vs DB：页面默认「时间：今日」列出 20 行，行内容/顺序 = `alert_events` last_fired_at 降序（CST 显示：23:11/20:40/15:10/14:54/14:05…）；`×41`=fire_count 41；状态徽标「已确认/已恢复」+ CST 时刻与 acked_at/resolved_at 全等（实差仅 +00/Z 格式）。API `limit=10` 前 10 条 id=[264,219,229,228,211..216] 与 DB 前 10 全等。
- 来源过滤下拉 = DB 17 个来源（全等）；规则面板 4 规则 id/name/level 与 `alert_rules` 全等（阈值/静默值于输入控件内，DB：symbol_gap_rate threshold=1/silence 30 等；「委托异常/废单 …Wave 4 预留」为 UI 占位，DB 无此行——设计内）。
- ack 闭环（见 §3）：triggered→200→acked_at 落库；已 ack/已 resolved/不存在 → 404。
- 空态：level=critical 过滤（无 critical 事件）→ 显示「暂无告警」空态（非错误）✅。

---

## 3. 第 3 层：功能边界 / 空态 / 错误态 / 跨页一致性 / WS / 置灰

### 3.1 表单与校验（/symbols 注册）
| 输入 | 结果（HTTP + UI 内联提示） |
|---|---|
| code=12345（5 位） | 400 `code 须为 6 位数字`；UI 内联提示同文案 ✅ |
| code=60051a（非数字） | 400 同文案 ✅ |
| code=430001 / 920001（北交所） | 422 `北交所标的（4/8/920 前缀）暂不支持`；UI 内联 ✅ |
| interval_secs=30 | 400 `interval_secs 下限 60（秒）` ✅ |
| settlement=XX | 400 `settlement 须为 T0 或 T1` ✅ |
| 重复注册已存在 code | 409 `code 已注册（编辑用 PATCH）` ✅ |
| 合法 code 且**名称留空** | **201 成功（name=NULL 入库）** —— 后端 name 可选（`normalize_name`→None，与库内既有 551000 形态一致）。任务预期「缺 name→400/422」与后端设计不符 → 记为观察 N1，非阻塞 |

### 3.2 跨页一致性（注册→停用→清理全流程实测）
1. `POST /api/symbols` 注册 510300（真实沪深300ETF，临时）→ 201；**立即**在 `/api/symbols`（45 行）、页面①行情列表、页面③表格出现（无需刷新/重部署）；页面①点击该行可选中并加载 K 线（canvas 正常，0 错误）。✅ 注册立即可见。
2. 页面③「停用」（confirm 二次确认）→ 行内按钮翻转为「启用」，PATCH enabled=false 生效（DB 复核 enabled=t→f）。✅ 停用动作本身。
3. **发现 D2**：停用后该 code 仍留在 `/api/symbols`（45 行）且页面①行情列表仍显示该行（last 0.000 / +0.00%）。后端 `SYMBOLS_LATEST_SQL` 无 enabled 过滤；设计文档（03-symbols）：「仅停用、历史数据保留、无物理删除入口；停用后…行情看板可查历史」——但行情**列表**展示 0.000 的假读数与任务「停用后消失」预期冲突，需架构决策（隐藏 disabled 行 or 接受按设计保留）。清理（SQL DELETE）后列表立即消失。→ **缺陷 D2**。
4. SQL 清理 510300 归零（symbols/kline_*/source_health_events/alert_events 复核全 0），DB 回 44 只；列表/API 恢复 44。✅ 副作用已还原（另见 §6 记账）。

### 3.3 告警 ack 边界
- 正向：注册 510300 触发真实告警事件 id=293（symbol_gap_rate，100% 缺口，triggered，UI 显示「确认」按钮）→ `POST /api/alerts/293/ack` = **200**，DB 翻转 triggered→acked 且 `acked_at=2026-09-04T15:25:26Z`（UI 变「已确认」）。闭环完整。之后 293 已清理。
- 负向：已确认 264 → 404；已恢复 229 → 404；不存在 424242 → 404（错误文案「告警不存在或不在未确认状态」）。✅
- 说明：本次 e2e 中 alerts.e2e 亦完成一次真实 ack（264，15:11:18Z 落库，台账备注允许项）。

### 3.4 空态
- /quality 无数据范围 → 设计空态文案（§2.4）✅；/alerts 无匹配（critical）→「暂无告警」✅；/symbols「未注册标的」空态需 0 只标的方可呈现（本环境 44 只，无法在不动库前提下触发——不以「不通过」计，标注未验证）。

### 3.5 错误态（路由阻断注入；均无页面崩溃）
| 页面（阻断 API） | 表现 |
|---|---|
| / 阻断 /api/symbols | symbol-list 区错误横幅 + 不崩 ✅ |
| /sources 阻断 /api/sources/health | summary/卡片错误态 + 不崩 ✅ |
| /alerts 阻断 /api/alerts | 「告警加载失败」/「暂无告警」区分 + 不崩 ✅ |
| /quality 阻断 /api/quality/divergence | divergence 区「加载失败：Failed to fetch + 重试」+ 其余区正常 + 不崩 ✅ |
| `POST /api/sources/{id}/reset` | 202 `{"status":"accepted"}` + `circuit_reset_requests` 落行（async 控制通道）；空 id → 400 ✅（探针行已清理） |

### 3.6 WS 实时
- ① `/`：注入 `{type:'quote', code:159337, last:9.876, changePct:1.23}` → 列表该行价格/涨幅**即时更新**（1.761/+0.00% → 9.876/+1.23%），0 崩溃/0 console error。✅
- ② `/sources`：注入 `{type:'health', sources:[…]}` → WsClient `health→source_health` 别名分发 → 触发 REST 健康重拉（请求增量 +2）→ 卡片随真实最新数据重绘（tencent 降级 66.7% 实时可见）；0 崩溃。✅
- K 线 bar 帧（append/update/虚线进行中标记）与宫格 quote 已在 kline-matrix D10/E12/G16/G17 全过；ws.e2e 确定性断言订阅帧（quote/health/bar）通过。✅

### 3.7 置灰页回退
- 导航：⑤ 回测工作台(W3) / ⑥ 交易面板(W4) / ⑧ 系统设置 —— **无 <a> 链接、opacity:0.4、cursor:not-allowed**（程序取样式证据）；其余 5 项为 NavLink。✅
- 直达 URL：`/backtest`、`/trading`、`/settings` 均 SPA 回落首页 `/`（App.tsx catch-all → `/`）。✅（smoke.e2e 同断言亦 PASS）

---

## 4. 发现缺陷 / 观察清单（含最小复现 + 证据）

| # | 类型 | 描述 | 最小复现 | 证据 | 新/既有 |
|---|---|---|---|---|---|
| **D1** | 后端端点缺失（页② detail-panel 整区不可用） | 点击源健康卡后 detail-panel 四子区（时序/事件流水/分歧率/限流）全部报错：前端调用 4 个后端**不存在**的路由 → 4×404 console error。`build_router` 无 `/api/sources/{id}/events|metrics|divergence|rate-limits`；但 `ApiClient`/SourcesStore 照常调用并渲染错误态 | 打开 /sources → 点任一张源卡 | 4×`HTTP 404 …not found`（console）；UI「时序加载失败…404」「事件流水加载失败…404」「分歧率统计 加载失败」「限流计数器组 加载失败」；截图 `shot_sources_after_select.png`；`/tmp/acct_evidence/p02_api_*.json` error 体 | 既有（非 K 线修复引入；UI 不崩、错误态正确，但功能不可用） |
| **D2** | 行为/语义（停用与行情列表） | 停用标的仍出现在 `/api/symbols` 与页面①列表（last=0.000, +0.00% 假读数）；任务预期「停用后消失」未满足；后端 `SYMBOLS_LATEST_SQL` 无 enabled 过滤，设计文档语义为「仅停采、可查历史」 | 注册 510300 → 页面③停用 → 页面①仍显示该行 0.000 | `shot_dash_disabled_510300.png`、`shot_symbols_disabled_510300.png`；停用后 /api/symbols=45 行含 510300；DB enabled=f | 需架构决策（既有行为，任务验收口径冲突） |
| N1 | 设计口径（非缺陷） | 「缺 name 注册」服务端放行（name 可选、入库 NULL，与 551000 一致），UI 无内联错误——与任务描述「缺 name→400/422」不符，实为设计如此 | 表单 name 留空 + 合法 code 保存 → 201 | POST 201 + name:null；`shot_symbols_form_validation.png` | 设计内 |
| N2 | 测试基线健壮性（第 1 层失败②根因） | visual「告警基线」对 alert_events 行数敏感：行数 +1 → 页高 +46px(969→1015) → 5% 像素差，日内任意新告警都会触发 | DB 告警 19→20 行后跑 visual alerts 用例 | expected/actual/diff PNG；高度测量（list 944px / 20 行，空态 912px） | 既有 flaky（数据驱动） |

---

## 5. 用例级清单：页面①-⑦ × 第 1/2/3 层 判定

| 页面 | 第1层(e2e) | 第2层(数据对账) | 第3层(边界/交互) | 备注 |
|---|---|---|---|---|
| ① 行情 / | PASS | **PASS 44/44 精确** | PASS（quote 注入即时更新；D9 属 K 线面板既有失败） | |
| ② 数据源 /sources | PASS | **PASS**（健康/缺口/预览精确） | PASS 交互 + **D1**（detail-panel 404） | |
| ③ 标的 /symbols | PASS | **PASS 44/44 全字段** | PASS 校验/注册/停用/清理 + **D2**（停用仍显示） | 空态未触发（44 只） |
| ④ 质量 /quality | PASS | **PASS**（577 行/缺口/一致率/tushare 精确） | PASS 空态/错误态/日期重查 | |
| ⑦ 告警 /alerts | PASS | **PASS**（列表/过滤/状态精确） | PASS ack ±/空态/过滤 | visual 基线 N2 |
| 置灰 ⑤⑥⑧ | PASS（smoke） | — | PASS（opacity0.4/no-link/回退 /） | |

## 6. 测试副作用与还原（台账）
- alerts.e2e 对 DB 内真实告警 id=264 执行 ack（triggered→acked，15:11:18Z）——**运行允许项**，为告警引擎真实状态翻转（非测试造数），保留并在本报告注明。
- symbols.e2e 注册 510300 → 停用 → SQL 清理归零（`e2e/sql-ledger.md` 15:15:51Z 两行，前后计数复核 0）。
- tester 探针产生的写入均已还原并复核：
  - 510300 注册×2 → 停用/删除 → symbols/kline_raw/kline_accurate/source_health_events/alert_events 计数 0（终态 44 只）。
  - 告警 id=293（510300 100% 缺口，注册期间引擎真实触发）→ ack 闭环后用毕删除 → alert_events 回 20（acked 2 / resolved 18）。
  - circuit_reset_requests 探针行（id=196）已删除 → pending 0。
  - 终态复核：symbols=44、alert_events=20、alert_rules=4、pending reset=0、`/api/symbols`=44。
- 本报告与探针脚本不涉及任何源码/SQL 修改；未 git add / 未 commit（子仓库存在先于本任务的 3 个 staged 文件：KlineChart.tsx/klineDataLoader.ts/klineDataLoader.test.ts——非本次动作，未触碰）。

## 7. 证据索引（/tmp/acct_evidence/）
- 第1层：`e2e_full_run.log`（全量输出 EXIT=1）、两个失败测试的 `test-failed-1.png`/`alerts-full-{actual,expected,diff}.png`
- 页面数据：`p01_api_symbols.json`、`p01_db_last{,_exact}.csv|txt`、`p02_health_rows.txt`、`p02_api_health{3600,600}.json`、`p03_db_symbols.txt`、`p03_db_raw_today.txt`、`p04_db_divergence_all.txt`、`p04_db_rows_159337.txt`、`p04_db_accuracy.txt`、`p04_api_{divergence_159337,accuracy_7d,gaps_159337,tushare}.json`、`p04_db_checkpoints_all.txt`、`p07_api_alerts10.json`、`p07_db_top10.txt`
- UI DOM/截图：`ui_{dashboard,sources,symbols,quality,alerts}.json`、`shot_{dashboard,sources,symbols,quality,alerts}.png`、`shot_alerts_fullpage_now.png`、`shot_dash_510300_selected.png`、`shot_dash_disabled_510300.png`、`shot_symbols_{with_510300,disabled_510300,form_validation,after_disable}.png`、`shot_quality_empty.png`、`shot_alerts_{today,level_critical_empty,source_filter}.png`、`shot_err_{dashboard,sources,alerts,quality_divergence}.png`、`shot_sources_{after_select,detail_click,health_push}.png`、`shot_dash_quote_push.png`
- 探针脚本：`probe_*.js`（复现步骤即脚本本体）、`dump_pages.js`

## 8. 复现说明（架构师驱动修复用最小步骤）
- D1：`open /sources; click first source card` → 4×404（无后端路由）。
- D2：`POST /api/symbols {"code":"510300","settlement":"T1"}` → `PATCH /api/symbols/510300 {"enabled":false}` → `GET /api/symbols` 仍含 510300；页面①仍显示（0.000）。清理：`DELETE FROM symbols WHERE code='510300'`。
- N2：`INSERT` 级联任一新 alert_events（或等引擎新事件）→ 行数 +1 → visual /alerts 基线 969→1015 失败。

## 9. 残余风险
- 行情看板为「收盘后/模拟市」快照口径（last=当日 15:00 bar、change_pct 对前一根）——盘中动态价格的对账（quote 实时价 vs DB）未在本次做（WS quote 帧为快照推送、不入库，无权威落库源可比）；已在第 3 层验证前端能按帧更新。
- /symbols「未注册标的」空态、告警「近三日/全部」时间过滤的更大数据量组合未穷举（与当前 DB 行数相关）。
- 置灰页内部「点击」不可用性依赖无 `<a>` + opacity 判定（smoke 同断言），未做更深层导航拦截注入。
