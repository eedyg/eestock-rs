# 019 · sim-live「布局丢失」快速诊断 e2e 执行报告

> 本报告位置（self-location）：`eestock-rs/web/tester/test/019_simlive_layout_diag_execution.md`
> 设计：无新增用例设计（诊断型执行；`/tmp/simlive_layout_diag/diag.mjs|probe2.mjs|probe3.mjs` 一次性脚本，未入库）
> 结论：**布局未丢失（PASS）** —— region 全部存在且有实际内容、顺序与预期一致；console/pageerror=0、/api/sim-live/* 全 200。
> 附带发现（非布局丢失）：① `.tab-on` 活动 Tab 无任何 CSS（当前/历史按钮视觉完全一致）；② 视图高屏时内容仅占主区上部 ~45%、下部大段空白、region 无卡片间距（骨架单列堆叠）；③ 视口 <1488px 时全局横向溢出（/、/backtest 同现，非 sim-live 特有）；④ 数据异常：持仓 510880 现价 0.000/市值 0，而股票评分同标的现价 3.389。

## 1 运行信息

- 运行时间：2026-09-07 18:40–18:55 CST
- 运行对象：`eestock-app`（docker 镜像 `27be8225f2` / app `09254fb14668`），SPA `http://127.0.0.1:8081`，bundle `index-DIhzyPXq.js` + `index-BbwmiVpc.css`
- 本地 web 仓库：`eestock-rs/web` HEAD `c8544db`（sim-live 最后相关改动：`40eeb2c` L3b 面板 / `c8544db` F1/F2/O1 接线修复）；`dist/`（09-07 16:09 构建）与当前 src（15:1x）一致、served 文件 hash 与本地 dist 相同 → **所测即当前代码**
- 工具：Playwright 1.63.0 + chromium headless，视口 1440×900 / 1280×800 / 1600×1000
- 证据目录：`/tmp/simlive_layout_diag/`（截图 7 张：01_simlive_current / 02_simlive_history(未点 Tab 前) / 03_market_root / 04_backtest / 05_simlive_history_tab / 06_backtest / vp_1280x800_simlive / vp_1600x1000_simlive / vp_1600x1000_backtest；另有 probe2.out / served.css）
- 命令：
  - `node /tmp/simlive_layout_diag/diag.mjs`（初诊）
  - `node /tmp/simlive_layout_diag/probe2.mjs`（深探：DOM 树/溢出源/Tab 点击/对照页）
  - `node /tmp/simlive_layout_diag/probe3.mjs`（多视口 + computed style 验证）
  - `npx vitest run src/features/simlive/SimLivePage.test.tsx`（存量单测回归，8/8 过）

## 2 结论汇总

| 检查项 | 结果 | 证据摘要 |
|---|---|---|
| console / pageerror | PASS | 三页全部 `[]`，0 error / 0 warning |
| network（/api/sim-live/*） | PASS | state/strategies/orders/sessions + sources/health 全 200；无 404/500/失败请求 |
| 当前会话 region 存在性 | PASS | sim-live / session-control / position-table / strategy-panel / stock-scoring / order-trade-list 全存在 |
| 当前会话 region 内容 | PASS | 均非空锚点：KPI+开关（textLen 90）、持仓表 2 行(1 数据)、策略 2 卡、评分表 2 行(1 数据)、订单表 2 行(1 数据) |
| 布局度量（sim-live region） | PASS | display:flex / flex-direction:column 生效；1440 视口 x=208,y=40,w=1280,h=860；1600 视口 w=1392 自然铺满 |
| 内容顺序（对比静态 HTML） | PASS | 会话+账户→持仓→策略→评分→订单 自上而下（y=79→188→237→333→383），无重叠 |
| 历史 Tab（点击切换） | PASS | session-history 出现 w=1280 h=821：2 会话行（s_1788768814_0、s_1788766064_0）+ 回看/回测对比 + 提示；当前会话区随切换隐藏 |
| 对照页 / 与 /backtest | PASS | 均正常渲染（backtest 双列 320+960）；排除全局 CSS 故障 |
| 崩溃 / core dump | 无 | pageerror=0，无 reload/跳转 |

## 3 关键度量明细

### 3.1 当前会话 region（1440×900，networkidle+2.5s）

| region | exists | rect(x,y,w,h) | display | textLen | 行/单元格 | 内容摘录 |
|---|---|---|---|---|---|---|
| sim-live | ✓ | 208,40,1280,860 | flex column | 293 | — | — |
| session-control | ✓ | 208,79,1280,108 | block | 90 | 0/0 | 运行中·s_1788768814_0 / 总资产 ¥996,556.31 / 可用 ¥996,556.31 / 已实现 ¥0.00 / 未实现 ¥0.00 / 统一交易开关 开 / MCP 运行中 停用 / 停止会话 |
| position-table | ✓ | 208,188,1280,50 | block | 51 | 2/7 | 表头 + 1 数据行 510880 1,000 成本3.439 现价0.000 市值0 |
| strategy-panel | ✓ | 208,237,1280,96 | block | 43 | 0/0 | 双均线交叉→最强 510880 50 hold；动量突破→510880 50 hold |
| stock-scoring | ✓ | 208,333,1280,50 | block | 45 | 2/7 | 表头 + 1 数据行 510880 3.389 双均线50 MACD0 … 聚合50 hold |
| order-trade-list | ✓ | 208,383,1280,49 | block | 56 | 2/8 | 表头 + 1 数据行 00:52:48 510880 买入 3.439 1,000 manual filled |

testid 探针：sim-equity / sim-session-status / sim-position-table / sim-position-code / sim-strategy-panel / sim-score-aggregate-510880 / sim-order-list / sim-trading-toggle 均 n=1。

### 3.2 滚动与溢出

- 1440×900：`scrollWidth=1488 > clientWidth=1440`（横向 48px）；`scrollHeight=900 == clientHeight=900`（无纵向滚动）；`body overflow-x: visible`。
- 溢出源：`[data-region=sim-live]` 本体（class `flex min-w-[1280px] flex-1 flex-col`，w=1280 + nav 208 超出视口）——与 `/`（sw=1523）、`/backtest`（sw=1488）同型 → **全局 shell 特性，非 sim-live 特有**。
- 1280×800：hScrollbar=true、内容右缘 1488；1600×1000：sw=cw=1600 无任何滚动条 → 视口 ≥1488 完全正常。
- 纵向：主面板 `h-screen` 固定（AppShell `flex h-screen min-w-[1280px] flex-col`），sim-live 内容仅占上部（末 region 底 y=432 / 面板高 860），下部空白；当前数据量小无裁剪。

### 3.3 CSS 应用核对（computed style @1600）

- `text-[--dim]` span（总资产）color=rgb(139,147,176)=var(--dim) ✓；`text-[--up]` span（运行中·s_…）color=rgb(255,92,108)=var(--up) ✓；`min-w-[1280px]`、`text-[--up/dim/down]`、`border-[--line]` 均在 served CSS 中存在（初查误报为缺失，系 grep BRE 转义问题，复查 `grep -F` 确认全部存在）。
- **`.tab-on` 在 CSS bundle 与全源码均无任何规则**（仅 SimLiveGrid.tsx 引用）→ 活动 Tab computed 与未活动 Tab 完全一致（同 color/bg/border-radius/字号/字重）。Tab 切换功能正常（点击后 DOM 正确切换 current/history）。
- region section 无面板背景/圆角/间距（bg=transparent、仅 1px border-b，border 色 rgb(229,231,235)=Tailwind 默认而非 var(--line)），与静态 HTML 预览的卡片式分段（.card 背景/圆角/18px 段距）存在样式落差。

## 4 异常/留痕（非布局丢失）

1. `.tab-on` 无样式 → 当前/历史 Tab 无视觉高亮（轻微 UI 缺陷）。
2. 数据不一致（后端/数据侧，非前端）：持仓 510880 `现价 0.000`、市值/浮动盈亏 0；同标的在评分表 `最新价 3.389`。会话策略集仅 2 个（dual_ma+momentum，页面仅渲染 2 卡，静态设计示例为 3 策略）。
3. `#history` 锚点/深链不激活历史 Tab（store/页面无 location.hash 处理；导航点击才切换）。
4. 无纵向滚动容器：若订单/持仓数据增长超过主面板高，内容可能在底部被裁剪（当前数据量未触发，风险留痕）。

## 5 执行合规

- 只测不改：未修改任何源码/接口/布局文件；未 commit；git status 相对运行前后无新增变更（除本报告为新增未跟踪文件）。
- 崩溃 / core dump：无。

## 6 证据文件

- 截图：`/tmp/simlive_layout_diag/01_simlive_current.png`、`05_simlive_history_tab.png`、`vp_1280x800_simlive.png`、`vp_1600x1000_simlive.png`、`03_market_root.png`、`04_backtest.png`、`06_backtest.png`
- 数据：`/tmp/simlive_layout_diag/probe2.out`（DOM 大纲/溢出源/history Tab 度量）、`/tmp/simlive_layout_diag/served.css`（bundle 核对底稿）
- 脚本：`/tmp/simlive_layout_diag/diag.mjs`、`probe2.mjs`、`probe3.mjs`
