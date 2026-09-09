# 013 设计报告 — 内嵌图表深度细化 e2e（宫格内嵌 K线缩略 + 单图组件）

> **本文件位置**：`/home/eestock/workspace/git/eestock/eestock-rs/web/tester/design/013_embedded_charts_design.md`
> 角色/纪律：tester（只测不改产品码；新增测试文件 `web/e2e/embedded-charts.e2e.ts`，不 commit / git add）
> 设计时间：2026-09-05 11:20 CST（部署环境：eestock-app healthy，镜像 9d39b951…，SPA `index-DLbas1AF.js`）

## 0. 设计摘要

对部署环境中宫格内嵌 K 线缩略图（DashboardPage → GridCell，pageSize=120，无副图/无实时视觉）与单图内嵌
组件（KlineChart/TimeshareChart）做深度验收，覆盖任务 ①–⑥。新 e2e 固化深层断言（10 用例：8 常态验收 + 2
缺陷复现），以数据对账（REST ↔ DB 权威重算）与几何/画布/网络/Wire 级断言补足既有 E11/E12 只数「格数 +
canvas 数量」的浅覆盖。

## 1. 分层覆盖计划

| 层 | 覆盖点 | 用例 |
|---|---|---|
| 数据正确性 | 格 code=前 N、格内 K 线=最新 120 根 15m（升序）、逐 bar OHLC/vol 与 DB 一致、多格不串 | T1 / T2 |
| 布局/溢出 | canvas 有界（非 33M）、行高分布、页面无超单图基线的横向溢出、反复切换不失控 | T3 / T3-DEFECT |
| 生命周期 | 单图↔2×2↔2×3×3 循环 canvas 归位、WS bar 订阅净余额、切周期重初始化 | T4 / T5 |
| D2 口径 | 前4含 disabled+latest:null / enabled+latest:null → 格表头 vs SymbolList 同口径、空态不崩 | T6 / T6-DEFECT |
| 单图回归 | 网格交互后 VOL/MA/MACD/KDJ/BOLL pane、分时线/均价线、1m 当日 DB 对账 | T7 |
| WS 隔离 | 单图实时 → 格内无实时 bar 视觉追加 → 格表头 quote 更新 → 回单图实时恢复 | T8 |

## 2. 用例与断言清单（web/e2e/embedded-charts.e2e.ts）

| # | 名称 | 断言要点 |
|---|---|---|
| T1 | 2×2 数据正确性 | ①格 code==前4 且顺序一致；②每格发出 `period=15m&limit=120`（无 before）且 200；③REST 载荷==DB 权威重算（count=120、升序、逐 bar ts/OHLC≤1e-6/vol 相等、mismatch=0）；④任意两格首 bar 不同（不串） |
| T2 | 2×3 数据正确性 | 同 T1 于 6 格全量 + 每格主画布点亮像素>8（数据真实绘制） |
| T3 | 布局与溢出 | 每格 6 canvas 且 h<2000（无 33M）；格宽≤网格容器；doc scrollWidth ≤ 单图基线 1488（宫格无额外横向溢出，EV-2 基线除外）；反复切换 3 次回单图 canvas 归位=10、无 data-grid-cell 残留、scrollH<2000 |
| T3-DEFECT | 行高不均/末行坍缩**复现** | fresh 2×2 两行高 ratio>1.6；E11 顺序（2×2→2×3）出现 mainH=0 或 h≤60 的末行格 / 页面纵滚——缺陷存在则 PASS 留证（K1 式反转，修复后翻转） |
| T4 | 生命周期/泄漏 | ×3 循环 2×2 canvas=24、2×3 canvas=36、回单图=10 且 0 格；WS bar 主题出站余额回单图后≤1（格内 feed 随 dispose 释放）；JS heap 有界；crash/console(other)=0 |
| T5 | grid 切周期 15m→1m | 每格发出 `period=1m&limit=120`；画布结构 6/格、点亮>2；EV-1（DB shm 500）自然重试取证 |
| T6 | no-data 格空态 | route 注入 disabled/无数据 至前4 → SymbolList「已停用/无数据」（D2 修复层，无 0.00）；格结构 6 canvas 不崩、画布有界；TEST 码 kline 请求 200 空 |
| T6-DEFECT | 格表头 0.00% **复现** | 格表头对 disabled/no-data 仍 `+0.00%`（vs SymbolList 已停用/无数据）——缺陷存在则 PASS 留证（修复后翻转） |
| T7 | 单图回归+分时对账 | 网格交互后：canvas 10 → MACD 14/KDJ 18/BOLL 22 → 关回 10；分时 1m 源（limit=482）当日 241 根与 DB M1 逐 bar 一致；WS 注入 12 根今日 bar → 2 polyline×12 点、最新价/均价文本==确定性计算值；切回 K 线正常 |
| T8 | WS 隔离 | 单图注入 9.15 marker 出现 → 2×2 注入更晚 bar 帧：格内无 marker、格画布指纹不变 → snake_case quote 注入格表头 -5.55% → 回单图注入 9.31 marker 恢复 |

## 3. Mock/Stub 与外部依赖

- **WS 注入底座**（addInitScript）：捕获 app 唯一 socket，暴露 `__push`（服务端真实形状：bar 帧
  `{type:'bar',code,period,bar:{ts,...}}`、quote 帧 `{type:'quote',code,ts,last,change_pct}` snake_case）+
  `__sent`（出站 subscribe/unsubscribe 帧记录，T4 余额用）。
- **DB 权威重算**（read-only psql，helpers/db.ts 既有连接 127.0.0.1:5433）：15m = kline_accurate(M1) →
  `time_bucket('15 minutes',ts)` first/max/min/last/sum（与 cagg `kline_accurate_15m` 定义同式，含 2024-01-01
  截断），最新 120 根升序；1m 当日 = M1 `[dayStartZ, dayEndZ)`（CST 日界）。
- **route 拦截**：T6/T6-DEFECT 拦 `/api/symbols` 注入 TEST_OFF/TEST_NODATA（真实标的快照前置拉取再拼接）。
- 不使用 DB 写、不清理（零写入用例）。

## 4. 边界与异常用例

- 数据为空/接口 500（T6 no-data 格 200 空；T5 对 EV-1 间歇 500 的重试与取证）。
- 非交易日（休市）分时「该时段无数据」占位（T7 记录 t0，另以 WS 注入构造盘中验证线计算）。
- 状态保持切换（E11 路径 2×2→2×3；行高/画布塌缩捕捉 T3-DEFECT）。

## 5. 覆盖目标

- 数据对账：≥10 个 (code×120 15m bars) REST↔DB 全量逐 bar（4+6 格 × 120 根 = 1200 根/次），另 1m 当日 241 根。
- 布局：每格画布尺寸/数量、行高分布、scroll 溢出、3 轮循环稳定性、JS heap。
- 失败证据：/tmp/embedded_evidence/*.json + 截图，report 013 引用。

## 6. 已知环境条件（设计期校准，非断言目标）

- EV-1：eestock-timescaledb /dev/shm=64MB → 并发 1m 深查间歇 500（app log「could not resize shared memory
  segment…No space left on device」）。
- EV-2：整站壳层 min-w-[1280px]+nav 使 docScrollW=1488（全页一致，非宫格引入）。
- 休市日今日（2026-09-05 周六）0 根 1m，分时占位属设计行为。
