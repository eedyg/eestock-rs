# 测试设计 — 问题① 期望的 pane/分隔线形态（红测试）

- **报告自身路径（self-location）**：`tester/design/014_issue1_pane_separator_red_test_design.md`
- **阶段**：阶段 1（诊断）——本设计仅为「把期望形态写成一条当前必红的测试」；**未改任何产品代码**
- **关联**：执行/诊断取证报告 `tester/test/047_issue1_stray_separator_diagnosis_execution.md`；证据 `tester/evidence/047/`
- **被测缺陷**：K 线看板单图态，K线 与 VOL 副图之间多出一条**静态**分割线（拖高 VOL 后该线不动、一直存在）
- **权威口径**：
  - `design/06-web/01-dashboard.md` L2：`sub-chart` = 「成交量副图…无独立交互」，修复记录（2026-09-04）明确「`sub-chart` 作为 region 锚点以**绝对定位占位**（region 契约不变）」；
  - `design/14-dcap-indicator/02-spec.md` §6：DCAP = **独立副图 pane**（isStack），三线 s/m/l；
  - `design/14-dcap-indicator/03-test-plan.md` T8（前端渲染 spike：真实 klinecharts 实测/真实渲染，非单测）。

---

## 1. 测试策略

| 项 | 选择 | 理由 |
|---|---|---|
| 层级 | **E2E（真实渲染）** | 缺陷本体 = 「DOM/CSS 计算样式 + 几何」事实（那条多余的线是 `border-top: 1px solid rgb(229,231,235)`），且 klinecharts 的 `SeparatorPane` 只在真实渲染下存在 |
| 基建 | `web/e2e/*.e2e.ts` + `@playwright/test`（既有 E2E 栈，`playwright.config.ts`：baseURL 默认 `http://localhost:8081`） | 仓库既有基建；`testMatch: '**/*.e2e.ts'`，**不被 `npx vitest run` 收集**（vitest 只收 `*.test|spec.*`）⇒ 不会污染单测门禁 |
| 为什么**不用** jsdom/vitest 打桩 | vite 测试配置 `css: false` + jsdom：Tailwind 类（`border-t`）不参与级联 ⇒ `getComputedStyle().borderTopWidth` 恒 `0px` ⇒ 对该缺陷**假绿**。若改用「类名正则」断言，则退化为实现耦合且无法覆盖几何/分隔线形态 | 见 §4 边界说明 |
| 数据依赖 | 真实后端数据（看板既有标的） | 形态断言（线数/位置）与具体价格无关；`KlineChart` 即使 0 根 bar 也会建 candle+VOL pane |
| 只读纪律 | 用例内 `page.route('**/*')`：**非 GET 一律 abort**，末尾断言 `nonGet == []` | 线上实例正在服务用户：不得改动线上状态。DCAP 勾选=前端本地 state（已实测只有 GET 发出） |

## 2. 用例清单（1 条端到端用例，4 组断言）

用例名：`单图看板：K线 与 VOL 之间只应有 klinecharts 自带的 pane 分隔线（无骨架残留线）`

| # | Given / When | Then（期望形态） | 现状 |
|---|---|---|---|
| A | Given 单图看板默认态（MA 开、VOL 常开、DCAP 关） | klinecharts 分隔元素 **恰 1 条**（K线\|VOL）；`[data-region="main-chart"]` 内**无**其他全宽水平线；`[data-region="sub-chart"]` 锚点 `borderTopWidth == '0px'`（不可见占位） | **RED**：sub-chart 锚点带 `border-t` ⇒ 恒有一条 `rgb(229,231,235)` 静态线 |
| B | When 拖第一条分隔线向上 120px（用户场景） | 分隔线随 pane 边界上移（`top < 原 top − 50`）；仍无其他全宽水平线（「一直存在」必须消失） | RED（A 已红；隔离验证见 §3） |
| C | When 点 DCAP 开关（开） | 分隔线 1 → 2（内容 pane 3 ⇒ 2 条）；无残留线 | 该段当前**绿**（作为 pane 形态回归护栏） |
| D | When 再点 DCAP 开关（关）→ 收尾 | 分隔线 2 → 1（**无空 pane 残留**、分隔线数恒 = 内容 pane 数 − 1）；无残留线；全程无非 GET 请求 | 该段当前**绿** |

> 断言 A 的红**就是**本缺陷；B 是把用户报告的「拉大 VOL 后仍存在」写进自动化；C/D 把「pane 数只增不减 / 空 pane」这一契约钉住（当前已满足，防回归）。

## 3. 打桩/替身与隔离验证

- **无打桩**：真实 eestock-app（8081）+ 真实 klinecharts + 真实数据；只读 GET。
- **红→绿的隔离验证（本设计已执行）**：把同一用例拷成临时文件，仅在运行期注入
  `[data-region="sub-chart"]{border-top-width:0 !important}`（= 模拟最小修复「删掉 `border-t`」），
  其余断言全部保留 → **临时副本 PASS（5.0s）**，原用例 RED。结论：本用例**只**因那条残留线变红，
  其余 pane/分隔线断言在修复后可满足（无「修完仍红」的第二处缺陷混入）。
  （临时副本已删除，零残留；见执行报告 §7。）

## 4. 边界与例外

| 边界 | 处理 |
|---|---|
| jsdom 假绿 | 明确不用 jsdom 断言计算样式；E2E 才可观测（前置：`E2E_BASE_URL` 上的 app + chromium） |
| 视口差异 | 默认 1280×800：main-chart `h=644` ⇒ 残留线在 `515.2`、klinecharts 分隔线在 `517`（相距 1.8px，形成「双线」观感）；1440×900：main-chart `h=824` ⇒ `659.2` vs `697`（相距 38px，形成「多一条线」观感）。断言用「条数/来源」而非固定像素 ⇒ 视口无关 |
| 无数据/错误态 | `[data-testid="kline-chart"]` 不可见时用例失败并给出诊断（无法验证形态 ≠ 通过） |
| DCAP 开关选择器歧义 | 工具栏另有「DCAP 配置」按钮 ⇒ 必须 `getByRole('button', {name:'DCAP', exact: true})`（已修，见执行报告 §7） |
| 拖拽落点 | 分隔元素的拖拽层为 7px 高的 `cursor:ns-resize` widget（`top:-3px`）⇒ 命中点取 widget 中心 |
| 只读 | 非 GET abort + 末尾断言；DCAP 勾选不写 `/api/config/*`（实测请求方法集合 = {GET}） |

## 5. 覆盖目标

| 面 | 目标 | 本用例覆盖 |
|---|---|---|
| 用户可见分隔线形态 | 单图看板主图区「全宽水平线来源唯一性」 | ✅ A/B/C/D |
| pane 结构契约（无空 pane / 分隔线数 = pane 数 − 1） | DCAP 开/关可逆 | ✅ C/D（DOM 侧）；pane 列表本身见执行报告 §3（`getPaneOptions` 实测） |
| canvas 绘制 | 不新增 | 既有 `e2e/canvas.e2e.ts` 已覆盖 |
| 单测门禁 | 不受影响 | 该文件不被 vitest 收集 |

## 6. 期望的修复后状态（供实施方对照）

1. 单图看板主图区内全宽水平线**只剩** klinecharts pane 分隔元素；
2. `[data-region="sub-chart"]` 仍存在（region 契约/`e2e/helpers/pages.ts` 的 region 清单要求其存在）但**不绘制任何线**（无 `border`/背景/阴影）；
3. 拖高 VOL：唯一那条线随 pane 边界移动；
4. DCAP 开/关：1↔2 可逆、无空 pane。

## 7. 运行方式与前置

```bash
# 前置：eestock-app 在 E2E_BASE_URL（默认 http://localhost:8081）服务本仓库当前构建的 SPA + 后端
cd web
E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/dashboard-pane-separator.e2e.ts
```

- 依赖：`@playwright/test` + chromium（本机 `~/.cache/ms-playwright/chromium-1234` 已就绪）
- 当前结果：**1 failed**（RED 在断言 A；见执行报告 §6）
