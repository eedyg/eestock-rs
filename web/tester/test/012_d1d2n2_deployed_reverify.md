# 012 已部署环境复验报告 — D1 / D2 / N2 修复生效确认 + 回归 + visual 基线

> 报告文件位置（本文件）：`/home/eestock/workspace/git/eestock/eestock-rs/web/tester/test/012_d1d2n2_deployed_reverify.md`
> 角色/口径：tester（**只测不改**：未修改任何源码 / DB / SQL / 接口；临时 Playwright 复验 spec 用后即删，无 commit / git add）
> 执行窗口：2026-09-05 00:38–00:44 UTC（CST 08:38–08:44）；环境模拟交易日 2026-09-05（休市时段，见 §7 残留风险）
> 证据目录：`/tmp/d1d2n2_evidence/`（截图 / JSON 度量 / notes.txt / 运行日志，末尾「证据索引」全列）

---

## 0. 复验对象（环境锁定）

| 项 | 值 |
|---|---|
| 应用容器 | `eestock-app` = `a69e022a2f3f680e…`（healthy，started 2026-09-05T00:32:31Z） |
| 镜像 | `sha256:5bc71314fd8372732c4c44c9b1abd14bf7dbfd0d6d8b4ecf3bbfe050450a0817` |
| SPA bundle | `index-B8z_Abxt.js`（`curl /` 实测；含 7fab9f1 修复逻辑：detailUnavailable 占位 / D2 enabled·last:null 渲染 / AlertList max-h-[680px]） |
| 前端/API | `http://127.0.0.1:8081`（= `192.168.50.100:8081`，两者均 200） |
| DB | `docker exec eestock-timescaledb psql -U eestock -d eestock`（只读查询；alert_events 20 条，全部 2026-09-04；CST 今日 0 条） |
| 测试栈 | Playwright 1.62.1 / chromium（web/ 配置：workers=1、retries=1、viewport 1280×720「Desktop Chrome」） |

本轮**全部采用方式 A（route 拦截）**，零 DB 写入 → 无需 SQL 清理、无 sql-ledger 新条目。

## 1. 结论摘要

| 验收项 | 结论 | 一句话证据 |
|---|---|---|
| D1 数据源详情面板降级 | ✅ **PASS** | detail-panel 显示占位文案；点击源卡后 **0 条** `/api/sources/{id}/metrics|events|divergence|rate-limits` 请求、0 个 ≥400 响应、console 无 404/error |
| D2 停用/无数据标的不显示 0.000 | ✅ **PASS**（方式 A） | 注入 `enabled:false+latest:null` → 行显「已停用」、`enabled:true+latest:null` → 「无数据」；整个列表无 `0.000`；停用行可点选中且 K 线 200 加载、canvas 渲染、无 pageerror |
| N2 告警列表页高恒定 + max-h 内部滚动 | ⚠️ **PARTIAL** | 溢出区间 20 行 = 30 行 = **751px**（恒定，修复目标达成）且容器 maxHeight=680px / overflow-y auto / 内部滚动实测生效；但 **1 条=720px vs 30 条=751px（Δ31px）**，任务字面标准「1 与 30 页高一致」**未达成** |
| N2 visual 基线（/alerts） | ✅ **PASS** | `playwright test e2e/visual.e2e.ts -g "告警"` EXIT=0（今日自然态 0 告警，与提交时重基线同数据态） |
| 回归 · 五页无「加载失败」横幅 | ✅ **PASS** | `/`、`/sources`、`/symbols`、`/quality`、`/alerts` banner=false |
| 回归 · kline-matrix F14 | ✅ **PASS** | `-g "F14"` EXIT=0（17.0s；forward 分页无重复） |
| 回归 · API JSON 正常 | ✅ **PASS** | `/api/kline`（bars=10）、`/api/symbols?with_stats=1`（44 只）均 200 合法 JSON |

---

## 2. D1 数据源详情面板降级 — ✅ PASS

复验方法：`/sources` 打开 → 监听 request/response/console/pageerror → 点击源卡（当前 1h 窗口唯一有事件的源 `tushare`，卡片健康态 closed）→ 断言 detail-panel。

**DOM 文本（detail-panel 实测 innerText，非预期值照抄）**：
```
详情数据将在后续版本提供（后端端点 Wave 2+ 上线）
```
- ✅ 断言命中占位文案；panel 文本不含 `404`、不含 `加载失败`。
- ✅ **network**：点击前后全页 0 条匹配 `GET /api/sources/{id}/(metrics|events|divergence|rate-limits)` 的请求（正则捕获数组为空）；全页 HTTP≥400 响应 = `[]`。
- ✅ **console**：error 级消息 = `[]`；pageerror = 0；无崩溃 / 无 core。
- ✅ **保留项**：summary-bar（`1m源 0/0 / 快照池 1/1 / 系统正常`）、源卡健康（`tushare（历史层）…健康 · 成功率 100.0%（1h）· P50 998ms · 最近错误：无`）、缺口摘要（缺口摘要 · 标的 + 44 只可选）、告警预览（最近 10 条告警…）点击前后均正常渲染。
- ✅ 再点同一卡 → detail-panel 收起（region count = 0），交互无异常。

证据：`d1_detail_panel_tushare.png`、`d1_sources_page.png`、notes.txt（D1 段含全部 DOM 文本与请求/响应数组）。

## 3. D2 停用/无数据标的不显示 0.000 — ✅ PASS（方式 A，route 拦截）

复验方法：拦截 `GET /api/symbols` 返回 `[TEST_OFF(enabled:false, latest:null), TEST_NODATA(enabled:true, latest:null), ...44 个真实标的]`；拦截 `/api/kline`（仅 TEST_ 码用真实 159337 bars 应答，真实码 `route.continue()`）。

**列表 DOM（symbol-list innerText）**：
- `TEST_OFF` 行（button）文本：`TEST_OFF 停用验证标的 已停用` ✅
- `TEST_NODATA` 行：`TEST_NODATA 无数据验证标的 无数据` ✅
- 整个列表文本 **不含 `0.000`** ✅（含真实标的行，无一处伪造 0）
- 真实标的 159337 行：`159337 中证500ETF基金 1.761 +0.00%` ✅（真实价格/涨跌幅不受影响）

**行可点击 / K线不崩**：
- 点击 `TEST_OFF` → `data-selected=true`；随即发出 `GET /api/kline?code=TEST_OFF&period=15m&limit=34`，响应 **200**（拦截应答）；主图 canvas 数=10，绘制正常；pageerror = `[]`。
- 再点真实 159337 → 选中正常、无 pageerror。

证据：`d2_symbol_list_before_click.png`、`d2_disabled_row_selected_chart.png`、`d2_normal_row_selected.png`、notes.txt（D2 段含行文本与 kline 请求/响应 URL）。

> 注：初版 spec 的 kline 断言曾超时——原因是 route handler 内嵌套 `page.request.get` 异步拉数导致响应事件丢失（**测试脚手架问题，非产品问题**）；改为同步预取 + `route.fulfill` 后稳定通过（3.1s ×2 次运行）。此处如实记录，避免误判。

## 4. N2 告警列表页高恒定 + visual 基线 — ⚠️ PARTIAL（内滚与溢出区恒定 PASS；「1 与 30 页高一致」FAIL）

### 4.1 页高度量（route 拦截 `/api/alerts`，全页 docScrollH，单位 px）

| 场景 | 行数 | docScrollH | alert-list region 高 | 列表容器(clientH/scrollH) | 说明 |
|---|---|---|---|---|---|
| natural（今日 0 告警） | 0（暂无告警） | **720** | 632 | 无容器（空态） | 空态占位 |
| 注入 1 条 | 1 | **720** | 632 | 70 / 70 | 不溢出，容器=内容高 |
| 注入 20 条 | 20 | **751** | 680 | 680 / **944** | 溢出 → 容器 cap 680、内部滚 |
| 注入 30 条 | 30 | **751** | 680 | 680 / **1404** | 同上 |

- ✅ **溢出区间页高恒定（修复目标）**：20 行 = 30 行 = 751px，随行数增长页高不再变化（修复前 19→20 行会 +46px/行漂移）。容器 computed `maxHeight=680px`、`overflow-y: auto`；30 行 `scrollHeight 1404 > clientHeight 680`；`scrollTop=300` 设置实测生效（内部滚动）。容器内行高 ≈46.8px/行，与真实告警行同结构。
- ❌ **任务字面标准未达成**：「压 1 条与 30 条对比页高一致」→ 实测 **720 vs 751，Δ=31px**（两轮复测一致，含 retry）。空态(0 条)与 1 条同为 720；溢出后整体跃迁 751 并保持恒定。
- 观察（不修，仅供架构师裁决）：AlertList 是 `max-h-[680px]`（非定高 `h-[680px]`），flex 行高在「不溢出→溢出」边界会由 632 增至 680（Δ48px → doc Δ31px）。即：页高只在「少/空 ⇄ 溢出」边界发生一次性 +31px 跃迁，进入溢出区间后不再随行数变化。

### 4.2 visual 基线（/alerts）
命令（baseURL 指向已部署 192.168.50.100:8081）：
```
E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/visual.e2e.ts -g "告警"
```
结果：**1 passed（EXIT=0）**，log 见 `visual_alerts.log`。今日自然态 = 0 告警 = 空态（doc 720），与本次提交（7fab9f1）按定高重基线时的数据态一致 → 基线 PASS。

证据：`n2_natural.json` / `n2_1row.json` / `n2_20rows.json` / `n2_30rows.json`（含 innerHeight/docClientH/docScrollH/region/scrollable/rulePanel 全量度量）、`n2_alerts_1row.png`（1488×720）、`n2_alerts_30rows.png`（1488×751）、notes.txt。

## 5. 回归（本轮未破坏确认）

| 检查 | 结果 |
|---|---|
| `/`、`/sources`、`/symbols`、`/quality`、`/alerts` 加载无「加载失败」横幅 | ✅ 全 5 页 banner=false（`regression_pages.json`，每页附 200 字符 DOM 样本） |
| kline-matrix **F14**（forward 分页 ?before= 无重复，可达≥10 交易日） | ✅ PASS（17.0s，`kline_f14.log`） |
| `/api/kline?code=159337&period=1m&limit=10` | ✅ 200 JSON，bars=10，含 ts/close 字段 |
| `/api/symbols?with_stats=1` | ✅ 200 JSON，44 只，code/enabled/latest 齐 |
| 佐证：`/api/sources/health` 1 源 healthy、`/api/alerts` 20 条 | ✅ |

## 6. 副作用与清理

- 全程**只测不改**：无源码 / DB / SQL 修改；D2、N2 均为 route 拦截（方式 A）→ **无临时造数、无 SQL 清理需求**（sql-ledger 无新增）。
- 临时复验 spec（`web/e2e/zzz_verify_d1d2n2.e2e.ts`）已删除；其 `test-results` 产物已清理。
- 无 commit / git add；`git status --porcelain` 与执行前一致（无新增 staged / tracked 改动）。

## 7. 残留风险（供架构师评估，非本 tester 修复项）

1. **N2「1 vs 30 页高」Δ31px**：溢出边界页高跃迁客观存在。若视觉基线在「空/少」态采集、之后盘中告警积累越界，fullPage 基线仍可能再漂 ~31px。缓解方向（供裁决）：AlertList 改定高 `h-[680px]`（min 约束）或按数据态分别重基线/加大 mask。**本次 visual 基线 PASS 不受影响**（今日自然态=空态=基线态）。
2. 复验窗口为**休市时段**：1m 实时源 0/0、今日 0 告警、仅 tushare 历史层健康事件；自然页多处于空态。D1/D2 逻辑与行情态无关（断言数据不依赖），N2 溢出态已用合成 20/30 行覆盖，但「交易时段真实告警堆积中的视觉稳定性」仍建议择交易日盘中复跑一次 visual 全套确认。
3. D1 当前 1h 窗口仅 1 张源卡（tushare）可点；多源卡态由同一 selectSource/渲染代码路径保证，未实测多卡并列展开。
4. 本地 HEAD（fc813de）比部署 bundle 新 1 个仅涉 quality e2e 断言确定性的 commit，无产品代码差异；本报告全部结论针对**已部署** bundle。

## 8. 证据索引（/tmp/d1d2n2_evidence/）

- notes.txt —— 全部 DOM 文本 / 请求与响应数组 / console / 页高度量（附全文）
- d1_detail_panel_tushare.png、d1_sources_page.png —— D1 面板与整页
- d2_symbol_list_before_click.png、d2_disabled_row_selected_chart.png、d2_normal_row_selected.png —— D2 列表与选中态
- n2_natural.json、n2_1row.json、n2_20rows.json、n2_30rows.json —— N2 度量
- n2_alerts_1row.png（1488×720）、n2_alerts_30rows.png（1488×751）
- regression_pages.json、regression_api.json
- visual_alerts.log、kline_f14.log、spec_run.log

## 9. 复验用命令清单

| 命令 | 结果 |
|---|---|
| `curl http://127.0.0.1:8081/`（确认 bundle `index-B8z_Abxt.js`） | passed |
| `EVID_DIR=/tmp/d1d2n2_evidence E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test e2e/zzz_verify_d1d2n2.e2e.ts`（临时 spec：D1/D2/N2/回归/API） | 4 passed / 1 failed（failed=N2 字面断言 1vs30 Δ31px，记录用）→ spec 已删除 |
| `E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/visual.e2e.ts -g "告警"` | passed |
| `E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/kline-matrix.e2e.ts -g "F14"` | passed |
| API 抽查（curl / playwright request） | passed |

---

## 10. 验收报告

判定：D1 ✅、D2 ✅、回归 ✅、N2 visual 基线 ✅；N2「页高恒定」= 溢出区间达成（20=30=751）但**字面验收项「1 条 vs 30 条页高一致」= FAIL（720 vs 751，Δ31px）**，详见 §4.1/§7，交架构师定夺是否需要把 `max-h` 改定高。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "只测不改：未修改任何源码/DB/SQL/接口；D2/N2 用 route 拦截（方式 A），零 DB 写入，无 SQL 清理需求；临时复验 spec 用后删除，无 commit/git add，git status 无新增改动"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "证据齐全可独立复核：D1 detail-panel DOM 文案+0 请求/0 404/console 空；D2 列表行文本（已停用/无数据/无0.000）+kline 200+canvas；N2 页高 JSON（0/1/20/30 行=720/720/751/751px）+scrollH/clientH+容器 computed 680px；visual 告警基线 PASS 输出与 F14 PASS 输出；截图与日志存 /tmp/d1d2n2_evidence/（见报告 §8 索引）"
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "E2E_BASE_URL=http://127.0.0.1:8081 npx playwright test e2e/zzz_verify_d1d2n2.e2e.ts（临时 spec，D1/D2/N2/回归/API）",
      "result": "failed",
      "summary": "4 passed / 1 failed；failed 为 N2 字面断言「1 vs 30 页高一致」（720 vs 751，Δ31px，两轮复测一致），作为证据记录；spec 已删除"
    },
    {
      "command": "E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/visual.e2e.ts -g \"告警\"",
      "result": "passed",
      "summary": "视觉基线 /alerts 1 passed，EXIT=0（今日自然态=0 告警=重基线数据态）"
    },
    {
      "command": "E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/kline-matrix.e2e.ts -g \"F14\"",
      "result": "passed",
      "summary": "F14 forward 分页无重复 PASS（17.0s）"
    },
    {
      "command": "API 抽查 /api/kline 与 /api/symbols?with_stats=1",
      "result": "passed",
      "summary": "kline bars=10 合法 JSON；symbols 44 只含 code/enabled/latest"
    },
    {
      "command": "五页横幅回归（/ /sources /symbols /quality /alerts）",
      "result": "passed",
      "summary": "全 5 页无「加载失败」文本（regression_pages.json）"
    }
  ],
  "validationOutput": [
    "D1: detail-panel 文案=「详情数据将在后续版本提供（后端端点 Wave 2+ 上线）」；0 条 sources/{id}/(metrics|events|divergence|rate-limits) 请求；HTTP≥400=[]；console error=[]；pageerror=0",
    "D2(方式A): TEST_OFF 行=已停用、TEST_NODATA 行=无数据、列表无 0.000；真实行 159337 显 1.761/+0.00%；TEST_OFF 点击后 data-selected=true、/api/kline?code=TEST_OFF&period=15m&limit=34 200、canvas=10、无 pageerror",
    "N2: docScrollH natural(0条)=720 / 1条=720 / 20条=751 / 30条=751；20=30 恒定达成；容器 maxHeight=680px overflow-y=auto；30行 scrollH=1404>clientH=680，scrollTop=300 生效；1 vs 30 Δ=31px 未达字面标准",
    "visual 基线 /alerts PASS；F14 PASS；五页无失败横幅；/api/kline、/api/symbols?with_stats=1 JSON 正常",
    "部署对象：eestock-app a69e022a2f3f（healthy），镜像 sha256:5bc71314fd83，bundle index-B8z_Abxt.js"
  ],
  "residualRisks": [
    "N2「1 vs 30 页高」Δ31px：溢出边界页高 720→751 一次性跃迁，视觉基线在「空/少⇄溢出」两数据态间仍可能漂 ~31px（本次基线在空态，PASS 不受影响）；建议架构师裁决是否 AlertList 改定高 h-[680px] 或按数据态处理",
    "复验窗口为休市时段（今日 0 告警、1m 源 0/0）：交易时段真实告警堆积中的视觉稳定性建议择日盘中复跑 visual 全套",
    "D1 当前仅 1 张源卡（tushare）可点；多源卡并列态未实测",
    "本地 HEAD 较部署 bundle 多 1 个仅涉 quality e2e 断言确定性的 commit（fc813de），无产品差异"
  ],
  "noStagedFiles": true,
  "diffSummary": "无源码/测试文件改动残留：临时复验 spec 已删除，未 commit 未 git add；本报告为唯一新增文件（web/tester/test/012_d1d2n2_deployed_reverify.md，untracked）",
  "reviewFindings": [
    "non-blocker: N2 字面验收「1 条 vs 30 条页高一致」FAIL —— 实测 720px vs 751px（Δ31px）；溢出区间（20=30=751px）恒定与 max-h-[680px] 内部滚动均已达成，visual /alerts 基线 PASS",
    "no-blocker: D1 / D2 / 回归 / F14 / API 抽查全部 PASS"
  ],
  "manualNotes": "执行环境与容器/镜像/bundle 三重核对通过。所有证据文件位于 /tmp/d1d2n2_evidence/（notes.txt 含全量 DOM/network/console/度量文本，可直接复核）。"
}
```
