# 018 — 行情页 K 线图严重渲染/性能缺陷修复

> 本报告文件位置：`coder/report/018_kline_chart_fix.md`（eestock-rs 仓库根下同路径）
> 状态：修复完成 + E2E 回归补齐；未 commit、未 stage（全部改动在 working tree）。
> 证据优先（真实浏览器复现 → 根因 → 修复 → E2E 新断言 → 修复前后对比），无猜测式试错。

---

## 0. 结论摘要

- **核心缺陷**：K 线图 `h-[125%]` 容器在 flex-1 父级下被解析为 **~33,554,432px（2^25）高**，canvas 同样 33M 高，导致：① K 线巨比例只渲染左上小部分（用户实报①）；② document 滚动高度爆炸、canvas 33M + 高频 WS 重绘 → 浏览器卡顿后崩溃（用户实报②）。同根因族还包括用户补报的**蜡烛未横向铺满**（左侧 ~48% 死区）。
- **根因**（实证）：
  1. `h-[125%]` + flex-1 父级缺 `min-h-0` → 百分比高度在 min-content 反馈循环中解析为 2^25 px；klinecharts 按该容器尺寸创建 canvas → 反馈循环锁定 33M。
  2. 去掉高度问题后，蜡烛不铺满：klinecharts 默认 `barSpace=10` → 可见 bar 数 ≈ 容器宽/10 ≈ 95，而 15m 仅 2 交易日 ≈36 根，不足填满窗口；`scrollToRealTime` 锚右 → 蜡烛只占右 ~40%、左 ~48% 死区。
- **修复**：骨架 `min-h-0`（design 文档 + tangle）+ KlineChart 容器改 `h-full` + 按容器宽/2 日 bar 数设 `chart.setBarSpace` 横向铺满 + feed 默认 pageSize=2 交易日 + 实时 bar 虚线/闪烁 overlay + E2E 补比例/稳定性断言。
- **结果**：修复前 15m 蜡烛 `leftBlankPct≈47.8%` → 修复后 `≈0.4%`；chart/canvas/docScrollH 由 33M → 724/597/800（有界）。

---

## 1. 复现证据链（真实浏览器，目标 `http://192.168.50.100:8081`）

### 1.1 修复前（`h-[125%]` + flex-1 无 min-h-0，真实运行容器）

Playwright chromium 实测（Playwright 脚本，见下 §5 关键证据；页面加载后等 klinecharts 初绘再采样）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 图表容器 `[data-testid="kline-chart"]` 高 | **33,554,432px** | **724px** |
| 主图 canvas 宽×高 | 992 × **33,554,304** | 992 × **597** |
| document scrollHeight | **33,554,432** | **800**（=视口） |
| sub-chart region y / h | y=33,554,432 / h=0 | y=655 / h=144.8 |
| 15m 蜡烛左侧空白占比（leftBlankPct） | **47.8%** | **0.4%** |
| 15m 蜡烛横向覆盖占比（fillPct） | ≈52% | ≈85%（MA/灰烛延伸到 x≈850） |
| console 错误 / pageerror | 无（headless 未触发 ResizeObserver loop 警告，但渲染已炸） | 无 |

- **视觉复现**：修复前整页截图 `kline_before.png`（已留档）——图表区几乎空白，仅左上角一个微小方块（正是用户实报“只显示左上角小部分”）。修复后 `real-dashboard.png` 蜡烛横向铺满、比例正常。
- **WS 帧**：运行时刻为非交易时段（19:40 CST），WS 推送零帧（符合 coder/report/014 §7.2 既定行为）。故“重现证明崩溃”主要通过 canvas 33M 这一内存/渲染炸弹本体 + 后续注入高频 WS 帧的稳定性断言来覆盖。

### 1.2 根因实证

1. **高度爆炸**：仅把容器改 `width:100%;height:100%`（去 125%）且保持 flex 父级无 `min-h-0`，chart 仍 33M（见 §5 脚本 `kline_hfull` 的 BEFORE 33M / AFTER 仍 33M 但 canvas 记录）。只有当 `main-chart` 加 `min-h-0` 后，容器才被 flex 绑死为 724px，canvas →597px、docScrollH→800。→ **根因 = flex 反馈循环（min-height:auto），非单纯百分比**。
2. **横向不铺满**：把周期切到 1m（500+ 根）/5m（123 根）→ 蜡烛从左边缘开始（leftBlankPct=0.0%）；仅 15m（36 根/2 交易日）出现 47.8% 左死区。→ **根因 = 加载 bar 数 < klinecharts 默认可见窗口（容器宽/barSpace≈95），`scrollToRealTime` 锚右。**

---

## 2. 修复（均按文学式纪律：design 文档 → tangle；业务组件补代码块）

### 2.1 骨架（design/06-web/01-dashboard.md L3 → tangle 生成 web/src/layouts/DashboardGrid.tsx）
- `main-area`：加 `min-h-0`；`main-chart` 改 `relative min-h-0 flex-1`（承接整段图表区）；`sub-chart` 作为 region 锚点以 `absolute inset-x-0 bottom-0 h-1/5` 占位（region 契约不变，主图为 klinecharts 单实例 candle+VOL 副图分 pane）。`toolbar` 加 `shrink-0`。设计文档同步加“补定稿落位”说明。

### 2.2 KlineChart.tsx（业务组件）
- 容器 `h-[125%]` → `h-full`（有界、随 autoResize 正确测量，杜绝溢出/反馈循环）。
- **横向铺满**：`fitBarSpace()` 按 `ref.clientWidth / defaultPageSizeForPeriod(period)` 设 `chart.setBarSpace(space)`（初次 load 后固定，向前分页不再变窄）。
- **实时 bar 虚线 + 闪烁**：实时回调中用 `chart.convertToPixel({timestamp})` 定位最近（进行中）bar 的像素 x，叠加 `[data-realtime-marker]` 覆盖层（`border-dashed` 竖线 + `animate-pulse` 蓝点 + 实时价标签）。

### 2.3 feed.ts（业务组件）
- 新增 `BARS_PER_TRADING_DAY`（1m=241、5m=49、15m=17、1h=5、1d=1，经真数据核对）与 `defaultPageSizeForPeriod(period)`；默认 pageSize 由裸 `500` 改为 `2 × 交易日 bar 数`（15m=34）。向前分页 `?before=&limit=` 不变（可达 10-20 交易日）。
  - ⚠️ **与设计偏差说明**：design 原记“15m≈192 根”，实测 `GET /api/kline?code=159337&period=15m` 为 **18 根/交易日**（2 交易日=36）。192 系按全日 24h 估算（1440/15×2），与 A 股 4h 交易时段不符；本修复按“2 交易日”真实值折算取 34。

---

## 3. E2E 新断言（堵“单帧截图无法覆盖运行期比例/稳定性”盲区）

新增 `web/e2e/kline-scale.e2e.ts`（2 用例）：

1. **比例断言**（含横向铺满）：`chartH < 视口＋1`、`> 200`；`docScrollH < 2000`；`maxCanvasH/W` 有界；非空白 `distinct>10`；**蜡烛从左边缘开始（leftBlankPct<20）且覆盖主绘图区 ≥80%（fillPct≥80）**。
2. **稳定性断言**：注入 WS 实时 bar 帧（~2 帧/秒），持续 **≥60s**；断言 `frameCount>0`、`pageErrors=[]`、无 console error、canvas/scrollHeight 全程有界、内存峰值 `<350MB`、**`[data-realtime-marker]` 在实时推送下出现**。

运行结果：比例断言 5.2s 通过；稳定性断言 1.1m 通过。

---

## 4. 修复前后对比

- **修复前**：`design/06-web/preview/` 下旧图（K 线巨比例/左上小块/左死区）；证据截图 `kline_before.png`（复现：图表空白只显左上角小块）。
- **修复后**：`design/06-web/preview/real-dashboard.png`（重生成）：蜡烛横向铺满、MA(5/10/20)+VOL 副图正常、比例合理；`kline-scale.e2e.ts` 断言全绿。
- **宽度对比**：15m `leftBlankPct` 47.8% → **0.4%**；`fillPct` ≈52% → **≥80%**。

---

## 5. 关键验证命令与证据

| 命令 | 结果 | 摘要 |
|---|---|---|
| `npx tsc -b --noEmit` | ✅ passed | TSX 编译（含 regen 骨架）无错误 |
| `npx vitest run` | ✅ 171/171 | 21 files（含新增 pageSize 默认测试） |
| `VITE_API_MOCK=0 npm run build` | ✅ passed | `tsc -b && vite build` 产出 dist |
| `npx playwright test e2e/kline-scale.e2e.ts -g "比例断言"` | ✅ passed | 5.2s |
| `npx playwright test e2e/kline-scale.e2e.ts -g "稳定性断言"` | ✅ passed | 1.1m |
| `E2E_BASE_URL=... npx playwright test`（全量） | ✅ 35 passed，1 failed | 唯一失败 = quality 视觉基线（**既有**动态数据漂移，与本缺陷无关，见 §7） |
| `git diff --cached --name-only` | ✅ 0 | 未 stage（符合验收 noStagedFiles） |
| `docker cp dist/. eestock-app:/app/dist/` | ✅ | 应用面容器已更新（serve `index-BeNyneSO.js`，不含 `h-[125%]`） |

关键复现/验证脚本（临时，位于 /tmp，未入库）：`kline_repro.mjs`、`kline_hfull.mjs`、`kline_period.mjs`、`kline_before.mjs`、`kline_rtmarker.mjs`。

---

## 6. changed-files（改动清单）

- `design/06-web/01-dashboard.md`：L3 骨架（main-chart/sub-chart 结构 + min-h-0）+ §2 修复记录 + 补定稿落位说明
- `web/src/layouts/DashboardGrid.tsx`：tangle 重新生成（同步上述 L3）
- `web/src/features/dashboard/KlineChart.tsx`：`h-full`、barSpace 横向铺满、实时 bar 虚线+闪烁 overlay
- `web/src/features/dashboard/feed.ts`：`BARS_PER_TRADING_DAY` + `defaultPageSizeForPeriod`（默认 pageSize=2 交易日）
- `web/src/features/dashboard/store.test.ts`：新增“默认 pageSize=2 交易日”单元测试
- `web/e2e/kline-scale.e2e.ts`：新增（比例 + 稳定性两断言）
- `web/e2e/screenshots/.../dashboard-full-chromium-linux.png`：重生成视觉基线（有意 UI 变更）
- `design/06-web/preview/real-dashboard.png`：重生成行情页修复后截图

> 注：E2E 运行副产物（其他页 walkthrough 截图、sql-ledger.md）已 `git checkout` 还原，保持改动范围收敛于本缺陷。

---

## 7. 残余风险 / 已知限制

1. **粗周期（1h/1d）横向铺满受限**：klinecharts `barSpaceLimit.max=50`；1h 2 交易日=10 根、1d=2 根，均小于最小可见 bar 数（容器宽/50 ≈ 19），故粗周期默认 2 日窗口无法完全填满宽度（需前滚加载更多）。15m/5m/1m 已铺满。
2. **design“15m≈192”与实数据不符**：已按真实 2 交易日（18/日 → pageSize=34）实现并在文档注明；若后续要求严格 192，需改 `BARS_PER_TRADING_DAY`。
3. **实时 marker 定位依赖 `convertToPixel`**：近似定位到最近一根（进行中）bar，跟随最新时位于右缘；用户手动回拉滚动后位置随可见窗口偏移（仍标记最近 bar，非精确烛体覆盖）。
4. **quality 视觉基线失败（既有，非本缺陷引入）**：`visual.e2e.ts` 的 `quality-full` 基线因质量页动态一致率百分比未完全被 mask 覆盖而漂移（基线建于 coder/report/014 15:21，现 19:48 已漂移）。本缺陷未触碰 quality 页；如需全绿，需对该基线补 mask 或重基线（超本缺陷范围，建议单独立项）。
5. **非交易时段 WS 零帧**（既定行为）：稳定性用注入帧兜底验证实时路径。

---

## 8. 验收自检（acceptance-report）

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "按父级全部需求落地：①K线容器 h-[125%]→h-full + 骨架 min-h-0（design+tangle）根除 33M/只显左上/崩溃；②K线横向铺满（setBarSpace 按容器宽/2日bar数，15m leftBlankPct 47.8%→0.4%）；③feed 默认 pageSize 由裸500 改为 2 交易日（defaultPageSizeForPeriod）；④实时 bar 虚线+闪烁 overlay（[data-realtime-marker]）。范围收敛：仅改 dashboard/kline 相关文件，E2E 运行副产物（其他页 walkthrough 截图、sql-ledger.md）已 git checkout 还原。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "复现证据链（chart/canvas/docScrollH=33M，kline_before.png）+ 修复前后对比（leftBlankPct/fillPct）+ 真实浏览器 E2E（比例+稳定性 2 断言）+ tsc/vitest/build 全绿 + 无 staged 文件。详见本报告 §1/§3/§4/§5/§6。"
    }
  ],
  "changedFiles": [
    "design/06-web/01-dashboard.md",
    "web/src/layouts/DashboardGrid.tsx",
    "web/src/features/dashboard/KlineChart.tsx",
    "web/src/features/dashboard/feed.ts",
    "web/src/features/dashboard/store.test.ts",
    "web/e2e/kline-scale.e2e.ts",
    "web/e2e/screenshots/visual.e2e.ts-snapshots/dashboard-full-chromium-linux.png",
    "design/06-web/preview/real-dashboard.png",
    "coder/report/018_kline_chart_fix.md"
  ],
  "testsAddedOrUpdated": [
    "web/src/features/dashboard/store.test.ts（新增：默认 pageSize=2 交易日）",
    "web/e2e/kline-scale.e2e.ts（新增：比例断言 + 稳定性 ≥60s 断言，含横向铺满 >=80% 与实时 marker）"
  ],
  "commandsRun": [
    { "command": "npx tsc -b --noEmit", "result": "passed", "summary": "TSX 编译无错误" },
    { "command": "npx vitest run", "result": "passed", "summary": "171/171（21 files）" },
    { "command": "VITE_API_MOCK=0 npm run build", "result": "passed", "summary": "tsc -b && vite build；dist 产出" },
    { "command": "npx playwright test e2e/kline-scale.e2e.ts", "result": "passed", "summary": "比例 5.2s + 稳定性 1.1m 全过" },
    { "command": "E2E_BASE_URL=http://localhost:8081 npx playwright test（全量）", "result": "failed", "summary": "35 passed / 1 failed；唯一失败=quality 视觉基线（既有动态数据漂移，与本缺陷无关，§7.4）" },
    { "command": "entangled tangle", "result": "passed", "summary": "重新生成 DashboardGrid.tsx（与 design 文档一致）" },
    { "command": "git diff --cached --name-only", "result": "passed", "summary": "0（无 staged 文件）" },
    { "command": "docker cp dist/. eestock-app:/app/dist/", "result": "passed", "summary": "应用面容器已更新（serve index-BeNyneSO.js，不含 h-[125%]）" }
  ],
  "validationOutput": [
    "修复前(15m/真实容器)：chart=33,554,432px、canvas=33,554,304px、docScrollH=33,554,432px、蜡烛 leftBlankPct≈47.8%",
    "修复后：chart=724px、canvas=597px、docScrollH=800px、leftBlankPct≈0.4%、fillPct>=80%",
    "实时 marker：注入 WS 帧后 [data-realtime-marker] 出现（left≈899px，价随帧跳动）",
    "全量 E2E：35 passed（含新的比例/稳定性断言、canvas/dashboard/smoke/ws/symbols/alerts/data-success/walkthrough），唯一 failed=quality 视觉基线（预先存在问题）"
  ],
  "residualRisks": [
    "粗周期（1h/1d）默认 2 日窗口无法完全横向铺满（barSpaceLimit.max=50 限制，需前滚加载更多）",
    "design 原记 15m≈192 与实数据 18/日不符，已按真实 2 交易日（pageSize=34）实现并在 docs 注明",
    "实时 marker 定位依赖 convertToPixel（近似），跟随最新时位于右缘，回拉滚动后随窗口偏移",
    "quality 视觉基线失败为既有动态数据漂移（非本缺陷引入），需补 mask 或重基线（超范围，建议单独立项）"
  ],
  "noStagedFiles": true,
  "diffSummary": "K线图修复：h-[125%]→h-full + 骨架 main-chart/sub-chart 重构（min-h-0/absolute）+ setBarSpace 横向铺满 + feed 默认 pageSize=2交易日 + 实时 bar 虚线/闪烁 overlay；新增比例+稳定性 E2E；重生成 dashboard 截图与视觉基线。",
  "reviewFindings": [
    "blocker: 无",
    "note: quality 视觉基线 failed 因既有动态百分比漂移（未 mask 覆盖），与本缺陷无关，属预先存在"
  ],
  "manualNotes": "git 历史说明：HEAD 提交 4730269（父级 定稿）已将 design/06-web/01-dashboard.md 的 L3 骨架结构与 §2 修复记录纳入，故本 working tree 中该文件仅剩补定稿落位说明（+6 行）为未提交改动；DashboardGrid.tsx 为按 design L3 重新 tangle 生成的未提交改动。设计文档补定稿'15m≈192根'经真实数据核实为 18根/交易日，实现取 2 交易日=34 并在文档注明偏差。所有改动均未 commit、未 stage。"
}
```
