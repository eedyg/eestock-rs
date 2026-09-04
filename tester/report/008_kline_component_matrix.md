# Tester 报告 008：K 线组件完整交互验收矩阵（A–H，20 项 + 缺陷 K1/观察 O1）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/008_kline_component_matrix.md`（本文件）
> 验收人：tester agent（只验收不改码）
> 依据：design/06-web/01-dashboard.md §2 图表 / §3 实时 / §4 数据范围（含 2026-09-04 补定稿）；
> 组件范围：web/src/features/dashboard/{KlineChart,Toolbar,GridCell,TimeshareChart,SymbolList,DashboardPage,feed,store}.ts*
> 验收时间：2026-09-04 20:05–20:31 CST（收盘后静态数据）
> 被验部署：commit `1a1a798`（HEAD，git log 一致）；前端资产 `index-BeNyneSO.js/css` 与本地 web/dist 哈希一致（服务端无陈旧缓存）；真容器 http://192.168.50.100:8081（eestock-app），真后端，真 DB（44 标的，数据止于 2026-09-04 15:00 CST 收盘）
> 纪律：全程零改产品码、零 docker 操作、零 SQL 写库；WS 实时路径用浏览器侧注入服务端同形状帧模拟盘中（真实服务端 WS 收盘零增量，ws.e2e.ts 既有豁免口径）
> 测试基建：新增 `web/e2e/kline-matrix.e2e.ts`（21 用例，与既有 e2e 同构；残留见 §10 台账）

## 0. 执行摘要

| 区块 | 项 | 结果 | 一句话证据 |
|---|---|---|---|
| A 图表基础 | 1–4 | ✅ 全 PASS | 15m/首标的默认；蜡烛 leftBlank 0.0% / fill 99.9%；MA(5/10/20)+VOL；红涨绿跌采样 up1379/down2456；十字光标/画布有界 |
| B 周期切换 | 5–6 | ✅ 全 PASS | 5 周期 aria-pressed+数据源 limit 正确（1m482/5m98/15m34/1h10/1d2）+ 重绘；切后视口锁最右 |
| C 指标勾选 | 7–8 | ✅ 全 PASS | canvas 10→14→18→22 pane 出现、关后回 10；MA 联动不丢主图/量副图；2–3 副图不溢出 |
| D K线/分时 Tab | 9–10 | ✅ PASS + 观察 O1 | 分时=2 条线 ×241 点（当日完整 1m）+价格/均价；WS 注入下视图稳定零错；**分时无 WS 订阅、盘中需重挂载才刷新（O1）** |
| E 宫格 | 11–12 | ✅ PASS（注 K1 影响面） | 2×2=4 格/2×3=6 格/回单图无状态丢失；点格进单图；格内 quote 跳动（客户端契约形状）正常 |
| F 缩放/平移/分页 | 13–15 | ✅ 全 PASS | manual 后不再强拉、回到最新恢复锁定；?before= 分页 5 页 2410 bar 0 重复 0 缺口覆盖 10 交易日；缩放边界不崩 |
| G 实时动态 | 16–18 | ✅ 全 PASS | append/update 画布重绘+虚线跳动标记；≥60s 注入无崩溃/零 console error/内存 23MB 有界；15m 与 1m 都生效 |
| H 标的列表 | 19–20 | ✅ 全 PASS | 搜索 code/名称/无结果；切换 518880 主图换数据；快速连点 12 标的零崩、多 code 请求正确 |
| — | 缺陷 | **K1（高）** | 服务端 WS quote 帧 `change_pct`（snake）与客户端 store 读取 `changePct`（camel）不匹配 → 实盘 quote 推送整页崩溃 |

**结论：A–H 矩阵 20 项全部 PASS（按「客户端契约形状注入 + 静态/收盘数据 + 服务端同形状实时注入」验收口径）；K 线组件功能完整（K线主图/副图/指标/分时/宫格/缩放分页/实时/标的管理交互）。发现 1 个实时链路缺陷 K1（服务端 WS quote 字段契约不匹配，盘中真实推送会触发整页崩溃），另有观察 O1（分时视图盘中不自动刷新，重挂载才更新）。排修后需复测 K1（及 O1 产品定夺）。**

---

## 1. 验收方法（口径）

- **工具**：Playwright chromium（web/e2e 既有基建，`playwright.config.ts`），E2E_BASE_URL=http://192.168.50.100:8081；
  新增矩阵 spec `web/e2e/kline-matrix.e2e.ts`（21 用例，每项一测，测试名=矩阵项号）。
- **断言**：结构（aria-pressed / canvas 数量与分组 / DOM）、像素（蜡烛铺满、红涨绿跌、crosshair 内容变化、canvas 有界）、网络（/api/kline 请求 period/limit/before 游标、响应去重）、实时（WS 注入帧后 marker 文本/虚线样式/画布指纹变化、≥60s 稳定性、内存）、错误面（pageerror + console error 全程零容忍）。
- **实时模拟**：真实服务端 WS 收盘零帧（12s 探针 0 帧，与 ws.e2e.ts 豁免口径一致）。盘中行为用浏览器侧注入**服务端同形状帧**：`{type:"bar",code,period,bar:{ts,...}}` 与 `{type:"quote",code,ts,last,change_pct}`（形状取自 crates/web/src/ws.rs PushMsg serde 输出）。quote 的 camelCase 对照组用于区分「客户端功能正常」与「字段契约缺陷」（见 §9 K1）。
- **证据**：截图 `/tmp/kline_evidence/*.png`（每项关键状态）、量化值 `/tmp/kline_evidence/evidence_values.json`、`f14_evidence.json`、Playwright JSON 结果 `/tmp/kline_matrix_results.json`（21/21 passed）。证据文件清单见 §10。

## 2. A 图表基础 —— ✅ 全 PASS

| # | 断言要点 | 证据 |
|---|---|---|
| A1 | 默认 15m 按下（aria-pressed=true）；首标的（159337）选中；初始请求 `period=15m&limit=34`（2 交易日 pageSize）；蜡烛横向铺满无左死区 | 截图 A1_default15m_fill.png；实测 **leftBlankPct=0.0%、fillPct=99.9%、firstX=0**（修复后无 47.8% 死区复现；1a1a798 修复有效） |
| A2 | 默认结构 canvas=10（主图 597 + VOL 副图 100 + 时间轴 26，klinecharts 每 pane 同高双画布）；MA 关→画布内容变化（MA 线消失）、canvas 结构不变；MA 开恢复 | A2_MA_VOL_default.png；canvas 0 dataURL 开关前后不同；结构总数恒 10 |
| A3 | 红涨绿跌着色（#ff5c6c/#00e0a4）；十字光标 hover → overlay/axis canvas 内容变化（crosshair+OHLC tooltip 绘出） | A3_crosshair_tooltip.png；实测 up 采样 1379、down 2456（双色均存在）；hover 前后全画布指纹变化（odd canvases 1/3/5/9 变） |
| A4 | 主图非一角非畸形：容器 1040×724 在视口内（<innerHeight）；canvas max 992×597 有界；docScrollH<2000（无 33M 复现） | A4_bounds.png；chartH 724≤800、canvasMaxH 597<2000、canvasMaxW 992<1500 |

## 3. B 周期切换 —— ✅ 全 PASS

| # | 断言要点 | 证据 |
|---|---|---|
| B5 | 1m/5m/15m/1h/日 逐一切换 aria-pressed 跟随；数据源请求 period 与 limit=2 交易日 bar 数（1m=482、5m=98、15m=34、1h=10、1d=2）；重绘 canvas=10 非空 | B5_period_{1m,5m,15m,1h,1d}.png；请求 URL 断言逐项命中 |
| B6 | 切周期后默认视口仍≈当日+前一交易日：跟随保持锁定（「回到最新」禁用）、无强拉偏移 | B6_viewport_locked.png；每周期切换后 backBtn disabled |

注：1m 读 merged 准确层（深历史，2024-09-20 起）、5m/15m/1h/1d 读 cagg（本容器仅回填 3 个交易日，见 §8 残余风险 R1——数据侧事实，非前端缺陷）。

## 4. C 指标勾选（热切换） —— ✅ 全 PASS

| # | 断言要点 | 证据 |
|---|---|---|
| C7 | MACD 开→canvas 10→14（新增副图 pane）；KDJ→18；BOLL→22；逐个关→18/14/10；MA 开关联动只改主图内容不改结构；主图仍占大头（≥300px）、VOL 副图 100px 保留 | C7_macd_on.png / C7_all_on.png / C7_all_off.png |
| C8 | 2 副图（MACD+KDJ）canvas 18、3 副图（+BOLL）canvas 22；容器 724px 不溢出、docScrollH<2000、canvas 有界可渲染 | C8_2indicators.png / C8_3indicators.png；maxH<2000 全程成立 |

## 5. D K线 / 分时 Tab —— ✅ PASS（附观察 O1）

| # | 断言要点 | 证据 |
|---|---|---|
| D9 | 切「分时」：触发 `period=1m&limit=480` 拉当日数据；SVG 呈现 2 条 polyline（价格线+均价线）；实测各 **241 点**（当日完整交易时段 1m bar 数，无缺口）；末值文本 1.761 / 均价 1.772 合理；切回「K线」canvas 恢复 | D9_timeshare.png / D9_back_kline.png；polys=2、points=[241,241]、texts 含均价 |
| D10 | 分时视图下注入服务端形状 WS bar 帧 ×10：视图不崩、无 console error、切回 K线正常 | D10_timeshare_dynamic.png；errs=[] |

> ⚠️ **观察 O1（待产品/架构定夺，非阻塞）**：`TimeshareChart` 无 WS 订阅、无定时刷新，仅 mount 时按 `api/code` 拉一次 REST 1m 快照。真盘中若用户停留在「分时」页不切换，价格线不会随新 1m bar 自动前进（重挂载/切标的/切 Tab 才刷新）。设计定稿 §2「零额外接口」未写明刷新策略；任务项 10「分时在数据动态时正确」若指盘中实时联动，需产品确认是否加 WS/轮询（建议与架构 lead 拍板，严重度候选：中-功能缺口）。

## 6. E 宫格 单图/2×2/2×3 —— ✅ PASS（K1 影响面见 §9）

| # | 断言要点 | 证据 |
|---|---|---|
| E11 | 2×2→4 格、2×3→6 格，每格缩略图 canvas=6（K线+MA，无副图），格头 code/名称/涨跌幅独立；回单图 canvas/周期/指标/选中无状态丢失（MACD 开态下回单图 canvas=14） | E11_grid2x2.png / E11_grid2x3.png / E11_back_single.png |
| E12 | 格内最新值跳动：quote 注入（客户端契约 camelCase 形状）→ 第 2 格涨跌幅文本变 -5.55%（store quote 路径功能正常）；点格 → 单图聚焦该标的（选中高亮+对应 code 请求） | E12_cell_quote_jump.png / E12_cell_focus.png |

> 注：格内实时跳动用**客户端契约形状**（camelCase `changePct`，store.ts quote 分支按此编写）验证功能路径。真实服务端帧是 snake_case `change_pct` → 整页崩溃（**缺陷 K1**，服务端同形状复现见 §9；K1 修复前，真盘中 E/H 实时跳动不可用）。

## 7. F 缩放 / 平移 / 回到最新 —— ✅ 全 PASS

| # | 断言要点 | 证据 |
|---|---|---|
| F13 | ctrl+滚轮缩放 → manual（回到最新可用）；实时新 bar 注入后**不被强拉**（按钮保持可用=跟随未回弹）；点「回到最新」→ 按钮禁用 + 视图滚回最右（canvas 指纹变化） | F13_manual_zoom.png / F13_not_following.png / F13_back_to_latest.png |
| F14 | 1m 下反复右拖（看更早）触发 `?before=` 分页：实测 **5 页 2410 bar，重复 0，缺口 0，覆盖 10 个交易日**（2026-08-20→2026-09-04，默认 2 日起步向前翻页，符合「10-20 交易日」设计下限） | F14_pagination_1m.png；f14_evidence.json；errs=[] |
| F15 | 缩放到底/到顶各 80 步狂转：canvas 有界、图表存活、零错误 | F15_zoom_edges.png；errs=[] |

> 数据深度说明：本容器 1m（merged 准确层）可翻页 ≥10 交易日（实测 10+，DB 自 2024-09-20 起更深）；15m/5m/1d cagg 仅回填 ~3 交易日（见 R1）。分页机制本身以 1m 深历史验证通过。

## 8. G 实时动态（WS 注入模拟盘中） —— ✅ 全 PASS

| # | 断言要点 | 证据 |
|---|---|---|
| G16 | appendBar（更晚 ts）→ marker 出现、文本=注入 close 9.15、画布重绘；**同 ts updateBar** → marker 变 9.28、画布重绘（闪动替换）；进行中 bar 标记 `border-dashed`（虚线）+ animate-pulse 蓝点样式在 DOM 可证 | G16_append_update_marker.png；borderLeftStyle='dashed'；append/update 两次全画布指纹均变化；errs=[] |
| G17 | 服务端同形状 bar 帧连续注入 **62s（>60s）**：62 帧送达、marker 持续出现、**0 pageerror / 0 console error**、内存 23MB（阈值 400MB 内） | 测试 G17 passed（62s 实跑）；errs=[]；mem≈23MB |
| G18 | 实时叠加 15m 生效（marker 9.17）→ 切 1m 实时叠加同样生效（marker 9.19） | G18_realtime_1m.png；errs=[] |

## 9. H 标的列表 —— ✅ 全 PASS；缺陷 K1（高）

| # | 断言要点 | 证据 |
|---|---|---|
| H19 | 搜索 code「5188」→ 1 条命中 518880；名称「黄金」→ 命中；「不存在标的zz」→ 「无匹配标的」；点击 518880 → 标题/选中更新 + `code=518880&period=15m` 请求 | H19_search_none.png / H19_symbol_switch.png；errs=[] |
| H20 | 列表快速连点 12 个标的（40ms 间隔）：零崩溃、图表存活、末选中正确、**11+ 个不同标的的 kline 请求都发出** | H20_rapid_switch.png；errs=[]；请求 code 集合 size>3（实测 11） |

### 缺陷 K1（高）—— 服务端 WS quote 帧字段契约不匹配 → 实盘 quote 推送整页崩溃

- **编号/严重度**：K1 / **高（盘中必现：真实服务端每推一条 quote 即整页白屏）**
- **现象**：注入一条**服务端真实形状** quote 帧 `{"type":"quote", code, ts, last, change_pct:3.21}`（形状取自 `crates/web/src/ws.rs` `PushMsg::Quote` serde 输出：snake_case）后，约 1s 内页面报错并卸载：
  - console：`TypeError: Cannot read properties of undefined (reading 'toFixed')` at `index-BeNyneSO.js`（SymbolList 渲染 `s.changePct.toFixed(2)`）
  - pageerror：同 TypeError
  - 结果：symbol-list 按钮数 0、kline-chart canvas 不可见（整页崩溃）
- **根因（只读定位，不改码）**：`web/src/features/dashboard/store.ts` quote 分支读取 `msg.changePct`（camelCase）；服务端 WS 推送字段为 `change_pct`（snake，见 ws.rs PushMsg::Quote 定义与 push_json_tag_shape 测试同形）；WsClient 无 snake→camel 归一化 → `msg.changePct` 为 undefined → SymbolList/GridCell `changePct.toFixed(2)` 抛 TypeError → React 整树卸载。
- **对照**：注入 camelCase `changePct` 帧 → 列表/格子正常更新（1.999/+3.21%），证明客户端路径本身可用，缺陷在字段契约。
- **复现步骤**：
  1. 打开 http://192.168.50.100:8081/，等 K 线加载完成（~6s）；
  2. 向该页 WS 注入 `{type:"quote", code:"<任意列表内 code>", ts:<RFC3339>, last:1.999, change_pct:3.21}`（浏览器侧/真实服务端推送均可）；
  3. 观察 ≤1.5s：symbol-list 与整页卸载，console/pageerror 出现上述 TypeError。
- **影响面**：盘中真实服务端对任一订阅标的推 quote（数据前进即推，见 ws.rs poller `PushMsg::Quote`）→ 看板整页崩溃。E12 格内实时跳动、H 列表实时价在真盘中均不可用。**修复建议（供排修）**：store quote 分支兼容 `msg.change_pct ?? msg.changePct`（或 WsClient 归一化），二选一与 ws.rs 契约对齐。
- **复现证据**：K1_quote_crash.png；K1_EVIDENCE defect=true listVisible=false chartVisible=false；`TypeError: Cannot read properties of undefined (reading 'toFixed')`（含堆栈前 6 帧）。

## 10. 数据变更 / 测试残留台账（纪律）

1. **零 SQL 写库、零 docker 操作、零产品码改动**：全程只读 REST+WS（WS 注入为浏览器侧合成帧，不回写后端）。
2. **新增测试文件**：`web/e2e/kline-matrix.e2e.ts`（21 用例，矩阵自动化；untracked，未入库——父级可决定保留入库供复测或删除）。
3. **运行产物（Playwright artifacts，gitignored）**：`web/e2e/artifacts/test-results/`（瞬时失败截图/trace，本轮全绿、空残留可清）。
4. **证据文件（/tmp，非库内）**：
   - 截图：`/tmp/kline_evidence/*.png`（A1..K1 共 30+ 张，见 §2-§9 各行引用）
   - 量化值：`/tmp/kline_evidence/evidence_values.json`（A1 fill/colors/D9 timeshare/K1 errs）
   - F14 分页：`/tmp/kline_evidence/f14_evidence.json`（5 页/2410bar/0 dup/10 交易日/0 err）
   - Playwright 结果：`/tmp/kline_matrix_results.json`（21 passed）
   - 本报告引用以上路径；如需随报告留存请父级决定迁移位置。
5. 无 DB 残留行、无服务端状态变更（验收前后 /api/symbols 44 条一致、无测试标的写入）。

## 11. 残余风险

- **R1（数据侧，非前端缺陷）**：高周期 cagg（5m/15m/1h/1d）本容器仅回填 3 个交易日 → 15m 默认周期下翻页最远 ~3 日即 `hasMore=false`；「翻到 10-20 交易日」仅在 1m（merged 深历史）验证（实测 10 日+）。若产品预期高周期也能翻 10-20 日，需后端回填 cagg 深度（超出前端组件范围，建议排修时评估）。
- **R2（待修复）**：K1 修复前，真盘中 WS quote 推送会触发整页崩溃（本报告在收盘静态期以服务端同形状注入复现，实盘必现概率高）。
- **R3（待定夺）**：O1 分时盘中自动刷新策略（见 §5），需产品/架构确认是否本轮修复。
- **R4（验收窗口）**：本验收基于收盘后静态数据 + 注入模拟，未覆盖「真实盘中 09:30–15:00 连续运行 + 真推送」组合；建议 K1 修复后在下一个交易时段补一轮真盘抽查（G16/G17/K1 三项）。

## 12. 附：矩阵自动化明细（/tmp/kline_matrix_results.json 摘要）

21/21 passed：A1,A2,A3,A4,B5,B6,C7,C8,D9,D10,E11,E12,F13,F14,F15,G16,G17(62s),G18,H19,H20,K1(缺陷复现=缺陷存在，PASS 语义)。
复测命令：`cd web && E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/kline-matrix.e2e.ts --reporter=line --workers=1 --timeout=220000`
