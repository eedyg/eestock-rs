# 执行报告 054 — 阶段 3 独立验收（真实渲染）：切 period / 切 stock 不得重置指标视图布局

- **本文件位置（self-location）**：`tester/test/054_period_stock_switch_layout_phase3_acceptance_execution.md`
- 测试设计（新增探针）：`tester/design/019_phase3_real_render_acceptance_probes.md`
- 证据目录：`tester/evidence/phase3_accept/`（`probes/` 探针源码、`json/` 原始 JSON、`4x_*.log` stdout、
  `00_baseline.txt` / `20_gates_and_changes.txt` / `30_hygiene.txt` / `31_post_teardown.txt`）
- 运行时间：2026-09-14 09:40 ~ 09:53 (+0800)
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`；`HEAD = ece1d9d`（工作树含未提交修复）
- 被测形态：全部 `/tmp` 临时构建 + 临时端口（18091 A / 18092 B / 18093 C / 18095 H）+ 真实 klinecharts 10.0.3
- 纪律：线上 8081/8082（PID 2102695）**全程未动**（无 kill/restart/**无任何 PUT 到线上**）；
  未覆盖线上 `web/dist`；未 `git add/commit/stash`；未跑 tangle 回写；未改 `design/14-dcap-indicator` 的
  `file=` 代码块；未改 `web/src/features/indicators/dcap.ts`；临时端口 18091-18095 已全部释放、无残留进程

---

## 1. 结论总表

| 构建 | 判据总数 | 通过 | H 族失败 | D 族失败 | 说明 |
|---|---|---|---|---|---|
| **A 修复/工作树** | 104 | **104 / 104** | 0 | 0 | 全部绿 |
| **B HEAD 旧行为（反向对照①）** | 104 | 75 / 104 | **29** | 0 | 高度/身份族红；数据族绿 |
| **C 变异「不换数据」（反向对照②）** | 104 | 85 / 104 | 0 | **19** | 高度/身份族绿；数据族红 |
| **H 受控 harness** | 16 | **16 / 16** | — | — | overlay/WS/DCAP/热更新全绿 |

→ **两族断言互不掩盖**：B 只红 H 族、C 只红 D 族。

## 2. 核心需求①：拖到非默认高度后，切 period / 切 stock 保持布局

拖拽后基线（真实 DOM）：`MA(candle)=457px / VOL=179px / DCAP=160px`，pane id
`candle_pane / indicator_pane_…_3 / indicator_pane_…_2`。

构建 A 逐次切换（同一 chart 实例）：

| 切换 | 高度 before → after | pane id | inits | disposes | burst（切换窗口调用） |
|---|---|---|---|---|---|
| period 15m→1h | 457/179/160 → **457/179/160** | 不变 | 1→**1** | 0→0 | `setDataLoader,setSymbol,setPeriod,removeOverlay` |
| period 1h→1m | 457/179/160 → **457/179/160** | 不变 | 1→**1** | 0→0 | 同上 |
| period 1m→15m | 457/179/160 → **457/179/160** | 不变 | 1→**1** | 0→0 | 同上 |
| stock 518880→161226 | 457/179/160 → **457/179/160** | 不变 | 1→**1** | 0→0 | 同上 |
| stock 161226→513310 | 457/179/160 → **457/179/160** | 不变 | 1→**1** | 0→0 | 同上（+`scrollToRealTime`） |

- 每个切换的 5 条 H 断言（±1px / pane id / init 不递增 / 无 dispose / 无 create-remove churn）**全绿**。
- 关键负面对照：构建 B 的**首次**切换（15m→1h）即 `457/179/160 → 596/100/100`（VOL/DCAP 回默认 100px，
  MA 吸收 139px）、`inits 1→2`、`disposes 0→1`、burst 含 `dispose + createIndicator×3` —— 9 类 H 断言 29 条红。

## 3. 核心需求②：数据确实重置

构建 A 逐次切换（chart `dataList` vs 独立 ground truth `GET /api/kline`）：

| 切换 | 期望 (code/period) | chart 首根 ts 变化 | 末根 close 变化 | 窗口/取值与 GT | 新请求 |
|---|---|---|---|---|---|
| 15m→1h | 518880/1h | 08-28T05:45Z → **07-30T07:00Z** | 8.925（同标的） | overlap 188/188、valueAgree 188/188 | `…code=518880&period=1h&limit=188` |
| 1h→1m | 518880/1m | 07-30T07:00Z → **09-11T02:42Z** | 8.925 | 188/188 一致 | `…period=1m&limit=188` |
| 1m→15m | 518880/15m | 09-11T02:42Z → **08-28T05:45Z** | 8.925 | 188/188 一致 | `…period=15m&limit=188` |
| 518880→161226 | 161226/15m | 08-28T05:45Z（同栅格） | **8.925 → 1.895** | 188/188 一致 | `…code=161226&period=15m&limit=188` |
| 161226→513310 | 513310/15m | 08-28T05:45Z | **1.895 → 4.629** | 188/188 一致 | `…code=513310&period=15m&limit=188` |

- 每切换 5 条 D 断言（symbol/period/窗口/取值/新请求）**全绿**；`getPeriod()` 分别
  `{minute,15}→{hour,1}→{minute,1}→{minute,15}`，`getSymbol().ticker` 随标的更新。
- 构建 C（变异「布局保持但 `getBars` 恒用首个 feed」）：高度/身份族**全绿（0 失败）**，而
  `D_data_window_matches_GT` / `D_data_values_match_GT` / `D_data_changed_from_before` 共 **19 条红**
  （例：S1 切 161226 后末根 close 仍 8.934 而非 1.895；valueAgree 0/188）。

## 4. 回归项

| 回归 | 结果 | 证据 |
|---|---|---|
| ADR-020 视口 = 根数，切周期后 ≈ viewport_bars | ✅ | `data-viewport-fit={"bars":120,"space":11,"visible":118,"clamped":false}`；`getVisibleRange` 可见 115；`space==clamp(round(W/120),1,50)==11` 且 ∈[1,50]（构建 A/B 均绿；`barSpaceFit.test.ts` 单测覆盖 1/50 夹取边界） |
| 手动缩放后不被重算 | ✅ | 真实 wheel：`bar 11→12.1`；随后 resize → `bar 仍 12.1`（不重算）；再切周期 → 回 `bar 11 / visible 118`（自动归一） |
| WS 实时 bar 仍追加 | ✅ | 真实 WS 帧（捕获 app `WebSocket` + `dispatchEvent`）：dataList 188→**189**，末根 ts = 推送 ts `2026-09-14T01:45:00Z`；`data-realtime-marker` 渲染 |
| followLatest 仍工作 | ✅ | `followLatest=true` ⇒ burst 含 `scrollToRealTime`；wheel 后（`noteManualZoom` ⇒ false）⇒ 追加但 burst **无** `scrollToRealTime`；harness H3 同结论 |
| overlay 仍正确创建清理 | ✅（harness H1/H2） | 创建 3 个（`simpleTag`/`tradeRange`/`simpleAnnotation`）；切 feed ⇒ burst 含 `removeOverlay` + `createOverlay×2`，`getOverlays()=2`（非 5，无残留）；同实例、inits 1→1、高度 513/100 不变 |
| DCAP warmup 取数口径 | ✅ | 关 DCAP 初始 `limit=120`；开 DCAP 差额补取 `before=…&limit=68`（窗口 120+68=**188**）；其后每次切周期 `limit=188`；仅 1 次/切换 |
| 上一轮修复：保存参数不重建 pane | ✅ | 真实 UI 保存（PUT 本地兑现）：inits 1→1、disposes 0、高度 ±1px、pane id 不变、burst=`overrideIndicator`（+`resetData`）、`calcParams [8,36,66,…,3]→[8,36,70,…,5]`；harness H5 同结论 |
| DCAP 独立副图 / precision 5 / figures s,m,l,zero | ✅ | `paneId != candle_pane`；`precision=5`；`figKeys=[s,m,l,zero]` |
| DCAP 数据不足断线 | ✅ | 线上 188 根：l 线首非空索引 >0（warmup 段全 null）；harness 10 根 ⇒ l 线 10/10 null（断线），仍不抛错 |
| 反向对照①（退回旧行为） | ✅ | 构建 B：H 族 **29 红**、D 族 0 红 |
| 反向对照②（不换数据） | ✅ | 构建 C：H 族 0 红、D 族 **19 红** |

## 5. 门禁与改动面

| 门禁 | 结果 |
|---|---|
| `./scripts/check-tangle.sh` | exit **0**（`✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）`） |
| `npx vitest run`（web） | **58 files / 577 tests 全绿**（exit 0） |
| 定向 `vitest run KlineChartSwitchLayout KlineChart DashboardPage` | **41 passed**（exit 0） |
| `npx tsc -b`（web） | 空输出、exit **0** |
| `git diff --cached` | **空**（无暂存） |

tracked 改动（4 个，全部在预期范围）：

| 文件 | 层 | 内容 |
|---|---|---|
| `web/src/features/dashboard/KlineChart.tsx` | 组件接线层 | 建图 effect 拆 Effect L（生命周期 `[]`）+ Effect W（数据接线 `[feed]`）；overlay 先清后建 |
| `web/src/features/dashboard/KlineChart.test.tsx` | 测试（加强） | 切周期后 `init` 恰 1 次、`dispose` 从未调用 |
| `web/src/features/dashboard/DashboardPage.test.tsx` | 测试（加强） | 切周期后 `init` 恰 1 次 |
| `design/14-dcap-indicator/02-spec.md` | 契约文档（**仅散文**） | §6 表格新增一行「切 period / 切 stock 不得重置 pane 布局」；**未触碰任何 `file=` 代码块**（`git diff | grep -c "file="` == 0；check-tangle 沙箱重生成逐字节一致） |

- **未触碰**：ABI / 引擎 / ExecutionPolicy / `api-config` / `web/src/features/indicators/dcap.ts`（tangle 生成物）/
  workbench（`git diff --name-only | grep -E "crates/|dcap\.ts$|workbench|api-config|ExecutionPolicy"` 为空）。
- 新增（未跟踪，测试车道）：`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`（阶段 1 红测，已转绿）。

## 6. 卫生 / 只读保证

- 线上 8081/8082：PID **2102695**，started `Sun Sep 13 21:21:46 2026`（前后一致，未被触碰）；
  重读配置 `kline=120 / dcap n_l=66,m=3 / ma=[5,10,20]` 与基线**完全一致**（证实无 PUT 落地）。
- 线上 `web/dist`：`md5(index.html)=6e18ff…`、全量聚合 `00325b46…` —— 与基线**逐字节一致**（未被覆盖）。
- **未对线上发任何 PUT**：三次探针 `nonGetOther=[]`；唯一的 `PUT /api/config/dcap` 被浏览器侧
  `route.fulfill` 本地兑现（`action=fulfilled-locally(未发往后端/DB)`）。
- 临时端口 18091/18092/18093/18095 已释放，`ps` 无 `acc3` 残留进程；
  （注：18096-18099 上的 `eestock-app` PID 2925884/2934705 **非本轮创建**，属其它车道，未触碰。）

## 7. 崩溃 / 异常

- 全部探针 `pageErrors=[]`（无页面异常、无 console error、无崩溃、无 core dump）。

## 8. 最小修正建议

**无需修正。** 复核中发现的两点均为「已达标、非缺陷」，供上游知悉：
1. Effect W 无条件调用 `chart.removeOverlay()`（看板无 overlay 时为无害空操作）；
   若后续要极致省事，可加 `props.overlays?.length` 判断，但**非必需**，且当前写法对「清旧」更稳妥。
2. 线上 dcap 配置 `n_l=66,m=3` ⇒ warmup 68、窗口 188（与默认 60/3 的 182 不同）——属配置面事实，
   口径计算（`viewport_bars + n_l + m − 1`）正确，无需处理。

## 9. 残余风险

- 「旧 feed 迟到回调打点」的 `cancelled` 代际守卫为竞态路径，本轮未构造真实竞态（仅静态确认逻辑与既有断言）。
- harness 的 `ResizeObserver` 场景未单独复跑（已由构建 A 的真实 resize 覆盖）。

## 10. 复跑要点（全部临时，先建后拆）

```bash
# 1) 构建 A / B / C（root：A=仓库 web；B=/tmp/acc3/alt=HEAD 版 KlineChart；C=/tmp/acc3/mut=工作树+变异）
cd <仓库>/web
NODE_PATH=$PWD/node_modules ACC_ROOT=$PWD           ACC_OUT=/tmp/acc3/dist-a ACC_PORT=18091 npx vite build --config /tmp/acc3/vite.a.config.ts
NODE_PATH=$PWD/node_modules ACC_ROOT=/tmp/acc3/alt  ACC_OUT=/tmp/acc3/dist-b ACC_PORT=18092 npx vite build --config /tmp/acc3/vite.a.config.ts
NODE_PATH=$PWD/node_modules ACC_ROOT=/tmp/acc3/mut  ACC_OUT=/tmp/acc3/dist-c ACC_PORT=18093 npx vite build --config /tmp/acc3/vite.a.config.ts
# 2) 预览（各自 nohup）+ 探针
cd /tmp/acc3 && BASE=http://127.0.0.1:18091 OUT=/tmp/acc3/probe-a.json LABEL=A node probe.mjs   # 期望 104/104
cd /tmp/acc3 && BASE=http://127.0.0.1:18092 OUT=/tmp/acc3/probe-b.json LABEL=B node probe.mjs   # 期望 H 族红
cd /tmp/acc3 && BASE=http://127.0.0.1:18093 OUT=/tmp/acc3/probe-c.json LABEL=C node probe.mjs   # 期望 D 族红
cd /tmp/acc3 && node probe-h.mjs                                                                # 期望 16/16
```

**VERDICT: PASS**
