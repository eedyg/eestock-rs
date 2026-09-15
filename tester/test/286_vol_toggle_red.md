# 286 — VOL 副图 → 可关闭的普通指标开关：红测试执行报告

> **本报告位置**：`tester/test/286_vol_toggle_red.md`
> 类型：Execution report（执行本轮新落的红测试；**未修改任何既有测试 / 产品实现 / 接口 / 生成物 / 设计文档**）
> 设计报告（契约与用例判据权威定义）：`tester/design/286_vol_toggle_red_design.md`
> 新增测试文件（本轮唯一改动，未跟踪、未 add）：`web/src/features/dashboard/volToggle.test.tsx`
> 证据目录：`tester/evidence/286_vol_red/`

## 0. 运行环境与口径

| 项 | 值 |
|---|---|
| 仓库 | `/home/eestock/workspace/git/eestock/eestock-rs`（cwd = `web/`） |
| HEAD（执行时） | `8828d46`（`docs(adr): 选择器实现落位口径（派生观测，无快照字段）+ 台账 D7/D8`；本 Agent 未提交任何内容） |
| 时间 | 2026-09-15 22:11–22:16（+08:00） |
| 运行时 | vitest `3.2.7`（jsdom）+ @testing-library/react 16.3 |
| 出网 / 写请求 | **0**：api 全为本地 stub（`stubApi`）/ 假 ws；`save*Config` 均为 `vi.fn`，未发任何 `/api` 请求 |
| 构建 / dist | **未构建、未部署**；`web/dist` 未被触碰（本 Agent 只跑 `vitest` / `tsc -b`，二者不写 dist） |
| git 卫生 | staged **空**；`git status --porcelain` 中非 `??` 行 **0**（tracked 零改动）；唯一新增 = 未跟踪的测试文件；未 add / commit / stash；未跑 tangle |
| 临时实例 / 端口 | 无（未起任何服务） |
| crash / core dump | **无**：仓库 3 层内近 3 小时无 `core*` 文件；红失败全部为 `AssertionError`（无 TypeError / ReferenceError / 语法错 / 收集失败） |

## 1. 结果总览

| 套件 | 命令（cwd = `web/`） | 退出码 | files | total | passed | failed | skipped | 判读 |
|---|---|---|---|---|---|---|---|---|
| 本轮新增红测试 | `./node_modules/.bin/vitest run src/features/dashboard/volToggle.test.tsx` | **1** | 1 | 14 | 2 | **12** | 0 | R1/R2/R3/R4/R5/R7 全红且**全是断言失败**；R3-3 / R6-1 为绿**守卫** |
| 全量基线（改造前） | `./node_modules/.bin/vitest run` | 0 | 84 | 775 | 775 | 0 | 0 | 基线干净：既有 84 文件 / 775 例全绿 |
| 全量基线（新增红之后） | `./node_modules/.bin/vitest run` | **1** | 85 | 789 | 777 | **12** | 0 | 失败**全部**来自新增文件（`1 failed | 84 passed`）⇒ 既有 775 例**零回归**（777 = 775 + 2 新增守卫） |
| 类型检查 | `./node_modules/.bin/tsc -b` | 0 | — | — | — | 0 | — | 零输出（`tsc_b.txt` = 0 字节）：红阶段不被类型错误阻塞，实现方构建门禁未受影响 |

**原始输出**：
`tester/evidence/286_vol_red/vitest_volToggle_red.txt`（红运行）、`vitest_volToggle_red_rerun.txt`（复跑：逐用例状态一致，仅耗时不同）、
`vitest_full_suite_BEFORE.txt`、`vitest_full_suite_AFTER.txt`（+ `vitest_full_suite_AFTER_rerun2.txt` 复跑一致）、`tsc_b.txt`。
**被测文件指纹**：`web/src/features/dashboard/volToggle.test.tsx` =
`sha256:7509ddb435a5f1b52ff238a0ee57fefbb792825add3b293af16c1035c3741a9e`（`tester/evidence/286_vol_red/test_file_sha256.txt`）。

## 2. 逐用例红/绿状态与红原因分类

| # | 用例 | 状态 | 红原因分类 | 错误原文（摘要） | 位置 |
|---|---|---|---|---|---|
| R1-1 | `indicators.vol === true（默认开）` | **红** | 断言失败 | `DASHBOARD_DEFAULTS.indicators.vol 必须为 true（默认开）: expected undefined to be true` | `:451` |
| R1-2 | `开关集合 = {ma,macd,kdj,boll,dcap,vol}` | **红** | 断言失败 | `expected [ 'boll','dcap','kdj','ma','macd' ] to deeply equal […,'vol']`（差 `vol` 一项） | `:456` |
| R2-1 | `VOL 开关存在（文本含 VOL），既有 5 个开关仍在` | **红** | 断言失败 | `工具栏必须渲染出 VOL 开关（元素文本含 VOL）: expected null not to be null` | `:500` |
| R2-2 | `默认开 ⇒ aria-pressed="true"` | **红** | 断言失败 | `VOL 默认开 ⇒ 开关须为按下态: expected undefined to be 'true'` | `:505` |
| R2-3 | `关态 ⇒ aria-pressed="false"` | **红** | 断言失败 | `VOL 关 ⇒ 开关须为未按下态: expected undefined to be 'false'` | `:510` |
| R2-4 | `点击 VOL ⇒ onToggleIndicator("vol")` | **红** | 断言失败 | `前置：VOL 开关必须存在: expected null not to be null` | `:516` |
| R3-1 | `初始 vol:false ⇒ 无 VOL、无残留 pane、其它指标不受影响` | **红** | 断言失败 | `vol:false 时不得创建 VOL 指标: expected 1 to be +0`（硬编码常开，关不掉） | `:545` |
| R3-2 | `true ⇒ false ⇒ VOL 消失；MA/MACD 不被动到` | **红** | 断言失败 | `vol 由 true 翻到 false ⇒ VOL 必须被移除: expected 1 to be +0` | `:570` |
| R3-3 | `vol:true ⇒ 有且仅有一个 VOL（独立副图 pane）` | **绿（守卫）** | — | 现状经硬编码常开恰好满足；实现后必须仍绿（防「删特权时把 VOL 定义一并删掉」） | — |
| R4-1 | `true→false→true：非 VOL pane id/顺序不变、拖拽高度保持、无其它指标 churn` | **红**（首个未满足判据 = 「关 VOL 未移除」） | 断言失败 | `vol:false ⇒ VOL 副图必须消失: expected 1 to be +0` | `:630` |
| R5-1 | `MultiPeriodSatellite（vol:false）⇒ 卫星不创建 VOL` | **红** | 断言失败 | `卫星必须继承 vol=false（不得有 VOL 副图）: expected 1 to be +0` | `:715` |
| R5-2 | `MultiPeriodChartStack 透传 vol=false ⇒ 卫星不创建 VOL` | **红** | 断言失败 | `栈透传 vol=false ⇒ 卫星不得创建 VOL: expected 1 to be +0` | `:736` |
| R6-1 | `不传 indicators ⇒ 卫星仍创建 VOL（兜底默认 vol:true）` | **绿（守卫）** | — | 现状经硬编码常开恰好满足；实现后必须仍绿（防「栈兜底默认漏 vol」） | — |
| R7-1（附加） | `点击 VOL ⇒ 主图 VOL 副图消失；不调用任何配置写接口` | **红** | 断言失败 | `前置：工具栏必须渲染出 VOL 开关: expected null not to be null` | `:812` |

**R4-1 的分解说明（重要，避免误读）**：该用例是一条复合判据。本阶段最早命中的是
「`vol:false` ⇒ VOL 副图必须消失」（红，`expected 1 to be +0`）；其后的**pane id/顺序不变、拖拽高度 240 保持、
churn 白名单、`setPaneOptions` 计数为 0、`init` 恒 1 次**等断言在当前实现下**本就满足**（现状对 vol 翻转
什么都不做 ⇒ 谈不上重建）。它们在**实现后**转为真正的把关项（见设计报告 §8 变异 M7/M8）。

**红原因分类结论**：12 条红**全部为 `AssertionError`**（grep 统计：`AssertionError` 12 / `TypeError|ReferenceError|SyntaxError|Error:` 0），
**不存在**模块不存在 / 语法错 / 收集失败 / 超时 / crash。

## 3. 失败用例名清单（原文，全量套件视角）

`tester/evidence/286_vol_red/vitest_full_suite_AFTER.txt` 中 `FAIL` 行共 12 条，**全部**位于
`src/features/dashboard/volToggle.test.tsx`（唯一失败文件：`1 failed | 84 passed (85)`）：

```
R1 默认值… > R1-1 indicators.vol === true（默认开，与 ma/macd/kdj/boll/dcap 并列）
R1 默认值… > R1-2 开关集合 = {ma,macd,kdj,boll,dcap,vol}（VOL 是一个**并列**开关，不是隐藏特权）
R2 工具栏开关… > R2-1 VOL 开关存在（文本含 VOL），且既有 5 个开关仍在（并列，不是替换）
R2 工具栏开关… > R2-2 默认开：indicators.vol=true ⇒ VOL 开关 aria-pressed="true"
R2 工具栏开关… > R2-3 关态：indicators.vol=false ⇒ VOL 开关 aria-pressed="false"
R2 工具栏开关… > R2-4 点击 VOL ⇒ onToggleIndicator 收到 "vol"
R3 图表生效… > R3-1 初始即 vol:false ⇒ 无 VOL 指标、无残留 VOL 副图 pane，且其它指标不受影响
R3 图表生效… > R3-2 true ⇒ false（会话内关掉）⇒ VOL 副图消失；MA/MACD 不被动到
R4 vol 翻转不得重建其它 pane… > R4-1 true→false→true：非 VOL pane 的 id/顺序不变、拖拽高度保持、无其它指标 churn
R5 卫星继承… > R5-1 MultiPeriodSatellite（indicators.vol=false）⇒ 卫星不创建 VOL，MA 仍在
R5 卫星继承… > R5-2 MultiPeriodChartStack 透传 vol=false ⇒ 卫星同样不创建 VOL
R7（附加）页面级… > R7-1 点击 VOL ⇒ 主图 VOL 副图消失；不调用任何配置写接口
```

## 4. 全程 crash / core dump

- 无 crash：`vitest` 退出码 1 仅因断言失败；无 `Unhandled` / `unhandled rejection` 记录；
- 无 core dump：`find . -maxdepth 3 -name 'core*' -newermt '-3 hours'`（排除 `node_modules`）**空**；
- `stderr` 仅有 React Router v7 future-flag 提示（R7-1 页面级渲染所致，非错误）。

## 5. 既有套件基线对照（零回归证据）

| 运行 | 命令 | files | tests | 结论 |
|---|---|---|---|---|
| BEFORE（新增前） | `vitest run` | 84 passed (84) | 775 passed (775) | 基线全绿 |
| AFTER（新增后，主证据） | `vitest run` | 1 failed / 84 passed (85) | 12 failed / 777 passed (789) | 增量 = 14 例（12 红 + 2 绿守卫）；既有 775 例全部仍绿 |
| AFTER 复跑 | `vitest run` | 1 failed / 84 passed (85) | 12 failed / 777 passed (789) | 与主证据逐数一致（`vitest_full_suite_AFTER_rerun2.txt`） |

**一次非复现的既有抖动（如实登记，非本改动引入）**：在 22:14:48 的一次全量运行中，
`src/features/settings/SettingsPage.test.tsx > 源参数面板：东财（push2delay）不可上移（ADR-006），参数<0 禁用保存`
曾出现 1 次 `expect(element).toBeDisabled()` 失败（→ `Test Files 2 failed | 83 passed`，`Tests 13 failed | 776 passed`）。
原始输出留存为 `tester/evidence/286_vol_red/vitest_full_suite_AFTER_settings_flake.txt`。该文件**单独运行 11/11 全绿**，
且随后两次全量复跑均未再现 ⇒ 判定为**与本次改动无关的既有抖动**（并行负载下的时序敏感）；本 Agent 未做任何根因分析、未修改该文件。

## 6. 覆盖摘要

- 未启用 coverage reporter（口径 = 设计报告 §7 的**分支枚举**，不报数值）；
- 已覆盖：常量默认值/并列集合（R1）、DOM 开关与回调（R2）、图表在场/离场与残留 pane（R3）、
  pane 生命周期与拖拽高度（R4）、卫星继承（R5）、栈兜底（R6）、页面接线 + 会话态（R7）；
- 明确未覆盖（设计报告 §7）：宫格（现状即无副图）、工作台（静态默认，非会话态）、像素级渲染/e2e、
  真实服务端配置读写（本阶段 0 写请求）。

## 7. 纪律自证

- 未修改任何实现文件 / tangle 生成物（`web/src/layouts/DashboardGrid.tsx`）/ 设计文档 / 既有测试；
- `git add` / `commit` / `stash` **未执行**（staged 空、tracked 零改动）；
- 未跑 tangle、未构建、未部署、未写 `web/dist`、未起任何服务、未发任何 `/api` 请求；
- 未做任何失败根因分析（只观察与记录），未尝试任何修复；
- 本报告路径：`tester/test/286_vol_toggle_red.md`；设计报告路径：`tester/design/286_vol_toggle_red_design.md`；
  证据目录：`tester/evidence/286_vol_red/`。
