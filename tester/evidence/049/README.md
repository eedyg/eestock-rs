# 证据目录 049 — 前端修复上线独立验收（tester 车道 C）

- 关联执行报告：`tester/test/049_frontend_deploy_independent_acceptance_execution.md`
- 被测形态：线上 `eestock-app`（PID 2102695，= 8081 + 8082），HEAD `d74bfb8`
- 纪律：只读取证。所有浏览器取证仅 GET（各轮 non-GET = 0）；未连用户 Chrome(9222)；未改仓库既有文件。

## harness（脚本 + 原始输出）

| 文件 | 说明 |
|---|---|
| `probe2.mjs` / `probe2-record.json` / `probe2-log.txt` | 问题①：默认 / 拖高 VOL / DCAP 开 / 关 四态几何 + **反向注入旧 `border-t`**（默认与拖高）四态；含 stray 分类（引擎分隔线 vs 非引擎全宽线）与 dash 几何 |
| `probe6.mjs` / `probe6-record.json` / `probe6-log.txt` | 问题②：4 形态（518880 15m/1m/日、161226 15m）DCAP pane 像素测量（0 线行、虚线几何、三数据线极值行/极值 x、图例带排除，鼠标移出图表区） |
| `probe7.mjs` / `p7-issue2-red-control.json` | 问题②反向对照：在 DCAP pane canvas 于**错误行 18** 注入 `#76808F` 虚线 → 检出（frac 0.50）⇒ `|row − y(0)|` 断言可红 |
| `pass7.mjs` / `pass7.json` | y(0) 独立计算（三线极值像素行 × 独立算出的 DCAP 序列，最小二乘）→ y(0)、残差、线行反推值 |
| `pass8.mjs` / `pass8.json` | 可见 bar 窗口暴力搜索（12,505 候选窗）：最小残差窗 + "尾窗族"两口径 y(0) 一致性 |
| `dcapSeriesRecompute.mjs` | 独立复算 DCAP 序列（`node --experimental-strip-types` 直接 import 仓库 CORE `web/src/features/indicators/dcapIndicator.ts` → `dcap.ts`），参数取自线上 `GET /api/config/dcap` |

## 截图

| 文件 | 说明 |
|---|---|
| `p2-default.png` / `p2-dragged.png` | 问题①：默认态 / 拖高 VOL 后（无 stray） |
| `p2-injected-default.png` / `p2-injected-dragged.png` | 问题①反向对照：注入旧 border-t 后出现僵线，且拖高后**不随 pane 移动** |
| `p6-s1-15m-518880.png` … `p6-s4-15m-161226.png` | 问题②：4 形态（DCAP 开、鼠标移出图表区） |
| `p7-issue2-red-control.png` | 问题②反向对照：错误行注入后的渲染 |

## 关键数值（详见报告 §3）

| 形态 | 0 线行 | y(0) 独立计算 | Δ |
|---|---|---|---|
| 518880/15m | 53 | 53.21 | 0.21 px |
| 518880/1m | 67 | 66.46 | 0.54 px |
| 518880/日 | 49 | 49.02 | 0.02 px |
| 161226/15m | 37 | 36.94 | 0.06 px |
