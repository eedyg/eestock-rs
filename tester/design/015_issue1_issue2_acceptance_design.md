# 测试设计 — 问题①/② 的独立验收（真实渲染，阶段 3 补跑）

- **报告自身路径（self-location）**：`tester/design/015_issue1_issue2_acceptance_design.md`
- **阶段**：阶段 3（补跑）——**独立验收**（不以修复车道脚本/结论为唯一依据；关键断言自建）
- **关联执行报告**：`tester/test/048_issue1_issue2_acceptance_execution.md`
- **证据目录**：`tester/evidence/048/`（harness 源码 + 原始 JSON + 截图 + 逐字节比对日志）
- **被测对象（工作树，HEAD=5a016cd）**：`design/06-web/01-dashboard.md`、`web/src/layouts/DashboardGrid.tsx`、`design/14-dcap-indicator/02-spec.md`、`design/14-dcap-indicator/03-test-plan.md`、`web/src/features/indicators/dcapIndicator.ts`、`web/src/features/indicators/dcapIndicator.test.ts`
- **权威口径**：`design/06-web/01-dashboard.md`（sub-chart 锚点=不可见占位）、`design/14-dcap-indicator/02-spec.md` §6（DCAP 图表契约 C：3 数据 figure + 常驻 0 参考线）、`design/14-dcap-indicator/03-test-plan.md` T8/T8-3b

---

## 1. 测试策略

| 维度 | 选择 | 理由 |
|---|---|---|
| 层级 | **E2E（真实渲染）** 为主 + 单测门禁回归 | 问题①是 DOM/CSS 计算样式 + 几何事实；问题②是「Y 轴自动标度 + 绘制像素」事实。jsdom（`css:false`）对 Tailwind 类假绿、无 canvas，不能判据 |
| 被测实例 | **临时端口上的仓库当前源码构建**（`vite build` 产物 / 由临时 `eestock-app` 实例托管） | 线上 8081 服务的是 20:32 旧构建（不含本轮修复）⇒ 必须另起构建；纪律要求只在临时端口跑并收尾拆除 |
| 观测通道 | ① `window.__CHARTS__`（经**临时 vite alias** 把 `klinecharts` 指到 `/tmp` spy）→ 公开 API：`getPaneOptions/getIndicators/getYAxes/convertToPixel/getSize/getDom/getSeparatorPanes`；② DOM 计算样式与 bounding box；③ **canvas `getImageData` 像素**（0 线颜色/虚线周期） | pane 列表/id/高度/indicator 数只有 Chart API 能如实取；0 线"可见"必须落到绘制像素，而不是"配置里写了 figure" |
| 数据形态控制（问题②） | 运行期 `chart.setDataLoader({getBars})` 注入合成 bars（触发 `resetData → getBars('init')`） | `Chart` 无公开 `applyNewData`；DataLoader 是唯一受支持的数据入口。可控形态：全正 / 跨 0 / 数据不足 |
| 反向证据 | ① 运行期 `addStyleTag` 注入同位置 `border-top`（= 恢复 `border-t`）；② **另建 `/tmp` 变体构建**：`@/features/indicators/dcapIndicator` alias 到 `/tmp/accept/dcapIndicator-nozero.ts`（figures 去掉 `zero`）并起第二个临时实例 | 两次都只改临时副本，**不动仓库文件**；负向断言必须变红 |
| 只读纪律 | 用例内 `page.route('**/*')`：非 GET 一律 abort，末尾断言 `nonGet == []` | 不写库、不写用户配置 |
| 线上隔离 | 不 kill/不重启 PID 2029836；临时实例用 `/tmp` 配置（同 DB、`alert_eval_ms=3600000` 降副作用、`mcp_listen` 另择端口） | 纪律：不动线上、不动用户配置 |

### 为什么需要"临时构建 + alias spy"
- 修复在源码里，线上 8081 的 `web/dist` 是旧构建（20:32，早于修复 21:01）⇒ 直接打 8081 只能验证**旧态**（会假红）。
- React 组件不暴露 `chartRef`，klinecharts 也不导出 `getChart` ⇒ 用临时 `resolve.alias` 把 `klinecharts` 换成 spy（`export *` + 包一层 `init` 记录实例到 `window.__CHARTS__`）。产物仍是仓库真实 `src`（DashboardGrid/KlineChart/dcapIndicator 全部真身）。

---

## 2. 用例清单（Given–When–Then）

### 2.1 问题①（真实 app + 真实 klinecharts）

| # | Given/When | Then | 备注 |
|---|---|---|---|
| ①-1 | 单图看板默认态（MA 开、VOL 常开、DCAP 关） | `[data-region="sub-chart"]` computed `borderTopWidth == '0px'`、背景透明 | 锚点仍存在（①-2 region 契约） |
| ①-3 | 同上 | klinecharts 分隔元素数 == 内容 pane 数 − 1（2−1=1） | 内容 pane = `getPaneOptions()` 去掉 `x_axis_pane` |
| ①-4 | 同上 | `main-chart` 内**无**任何非 klinecharts 的全宽水平线（border-top/bottom 或 ≤3px 不透明条） | 自建判据（不依赖修复车道脚本） |
| ①-5 | 同上 | pane 列表 = `candle_pane(MA)` / `indicator_pane_*(VOL)` / `x_axis_pane` | id/高度/indicator 数逐项记录 |
| ①-6 | 同上 | 唯一分隔线恰位于 candle pane 底 与 VOL pane 顶（±2px）⇒ DCAP 关态 candle↔VOL 边界**仍在**（删的是重复线） | 关键：证明不是把唯一边界删了 |
| ①-8/9/10 | 拖第一条分隔线向上 120px | 分隔线 top 显著变小（随 pane 边界）；stray 仍为空；锚点仍未画线 | 用户场景「拉高 VOL」 |
| ①-11 | 同上 | 分隔线仍与实测 pane 交界一致（±2px） | 排除"僵线" |
| ①-12~15 | DCAP 开→关 | 内容 pane 3⇒分隔线 2；关回 2⇒1；无空 pane；全程 stray 为空 | pane 形态回归 |
| ①-16 | 全程 | 只发 GET（`nonGet == []`） | 只读 |
| ①-REV | 注入 `[data-region="sub-chart"]{border-top-width:1px !important; …}` | 锚点 `borderTopWidth` 断言与 stray 断言**双双变红** | 反向证据（临时实例，不动仓库） |

### 2.2 问题②（真实 app + 真实 klinecharts；两组数据形态 + 边界 + 反向）

| # | Given/When | Then |
|---|---|---|
| ②-0 | DCAP 关闭态 | 无 DCAP 指标/pane ⇒ 无 0 线 |
| ②-1 | DCAP 开 | `figures.key == ['s','m','l','zero']`，`precision == 5` |
| ②-2 | DCAP 开 | `calc` 结果每根 bar `zero === 0` |
| ②-3/4/5/6 | 真实数据（s>0，m/l<0 ⇒ 三线跨 0） | 三线 min<0<max；pane Y 轴范围含 0；0 线 y == `yAxis.convertToPixel(0)` 且在 pane 内；canvas 在 `round(y0)` 行渲染出 `#76808F` 虚线（像素计数 + 虚线周期） |
| ②-7~10 | 形态①：单调上行 close（三线全正） | 数据 min>0；**Y 轴 from ≤ 0 < 数据 min**（0 被纳入标度）；0 线 y 映射正确且在 pane 内；像素可见 |
| ②-11~14 | 形态②：先降后升（负值跨越 0） | 三线 min<0<max；Y 轴含 0；0 线 y 映射正确；像素可见 |
| ②-15~17 | 数据不足（5 根 < warmup） | 三条数据线全 null（断线）；`zero` 仍每根 = 0；Y 轴含 0 且 0 线仍绘制在 y(0)（像素 >5） |
| ②-REV | 第二个临时实例：`figures` 去掉 `zero` | ②-1/②-6/②-10/②-14/②-17 **变红**（figKeys 掉 `zero`；`#76808F` 像素计数归 0） |

---

## 3. 打桩/替身

| 替身 | 范围 | 说明 |
|---|---|---|
| klinecharts spy（`kc-spy.ts`） | 临时 vite alias（`/tmp`） | 仅记录 `init` 实例；其余 `export *` 真身 ⇒ 被测渲染是真实 10.0.3 |
| DCAP no-zero 变体（`dcapIndicator-nozero.ts`） | 临时 vite alias（`/tmp`） | 仅反向证据；figures 去 `zero`，其余逐字一致 |
| 合成 bars | 运行期注入（DataLoader） | 只改临时实例内存，不落盘 |
| 临时 app 配置（`app_accept.toml`/`app_nozero.toml`） | `/tmp` | 同 DB；`alert_eval_ms=3600000`；端口 18081/18091、18083/18093 |

**未使用**：jsdom/vitest 打桩（对①假绿、对②无 canvas）；修复车道提供的任何脚本结论。

---

## 4. 边界与例外

| 边界 | 处理 |
|---|---|
| 线上 8081 是旧构建 | 不以其为修复判据；只在临时端口对**当前源码构建**下结论 |
| 视口差异 | 断言用「条数/来源/与 pane 几何关系」而非固定像素；0 线断言用「y(0) 映射 + 该行像素」 |
| 0 线颜色阈值 | `#76808F`（=118,128,143），容差 ±25 且 alpha>150；虚线周期由 gray x 间距集合给出 |
| 数据不足 | 合成 5 根（< n_s+m−1=10）确保三线全 null；0 线因只覆盖约 5 根 bar 宽度像素较少（实测 18px）⇒ 阈值 >5 而非 >100 |
| 无数据/错误态 | chart/`[data-testid="kline-chart"]` 不可见 → 断言失败（不静默通过） |
| 只读 | 非 GET abort + `nonGet==[]` 断言 |

---

## 5. 覆盖目标

| 面 | 目标 | 覆盖 |
|---|---|---|
| 骨架锚点 | sub-chart 不画线（计算样式）+ region 契约仍在 | ①-1/①-2/①-10 |
| 分隔线来源唯一性 | 主图区全宽水平线只来自 klinecharts | ①-4/①-9/①-13/①-15 |
| pane 结构契约 | 分隔线数 = 内容 pane 数 − 1；id/高度/indicator 数；无空 pane | ①-3/①-5/①-7/①-12/①-14 |
| 用户场景 | 拖高 VOL 后线随 pane 移动、无僵线 | ①-8/①-9/①-11 |
| DCAP 边界 | 关态 candle↔VOL 仍有可见边界 | ①-6 |
| 0 线契约 | 两形态恒可见、y==y(0)、关态不存在、数据不足仍在 | ②-0…②-17 |
| 反向证据 | 注入 border-top / 去 zero figure ⇒ 断言变红 | ①-REV/②-REV |
| 生成物纪律 | check-tangle + 独立沙箱逐字节比对 | 执行报告 §5 |

---

## 6. 运行方式（临时端口，收尾拆除）

```bash
# 0) 构建（临时 alias 构建；产物落 /tmp，不碰 web/dist）
cd web && npx vite build --config /tmp/accept/vite.accept.config.ts          # → /tmp/accept/dist
cd web && npx vite build --config /tmp/accept/vite.nozero.config.ts          # 反向证据 → /tmp/accept/dist-nozero
# 1) 两个临时实例（/tmp 配置，同 DB，端口 18081/18091、18083/18093）
./target/debug/eestock-app --config /tmp/accept/app_accept.toml
./target/debug/eestock-app --config /tmp/accept/app_nozero.toml
# 2) 自建断言
BASE=http://127.0.0.1:18081 node /tmp/accept/accept_issue1.mjs
BASE=http://127.0.0.1:18081 node /tmp/accept/accept_issue2.mjs
BASE=http://127.0.0.1:18083 EXPECT=nozero node /tmp/accept/accept_issue2.mjs
# 3) 仓库既有红测试（应已转绿）
cd web && E2E_BASE_URL=http://127.0.0.1:18081 npx playwright test e2e/dashboard-pane-separator.e2e.ts --retries=0
```

依赖：`@playwright/test` 1.62.1 + chromium（`~/.cache/ms-playwright/chromium-1234`）。

---

## 7. 期望的修复后状态（对照）

1. `[data-region="sub-chart"]` 计算 `borderTopWidth==0px`，且主图区全宽水平线只剩 klinecharts 分隔元素；
2. 分隔线数恒 = 内容 pane 数 − 1；拖高 VOL 后线随 pane 移动；
3. DCAP 副图 figures = s/m/l + zero，precision 5，0 线在任意数据形态/数据不足段恒可见且落在 y(0)；
4. design 与生成物逐字节一致（check-tangle 绿 + 沙箱重生成 cmp 相同）。
