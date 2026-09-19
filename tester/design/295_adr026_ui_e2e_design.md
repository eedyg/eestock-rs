# 设计报告 — ADR-026 回测工作台 UI 端到端（真浏览器）

- **本文件位置**：`tester/design/295_adr026_ui_e2e_design.md`
- **执行证据**：`tester/evidence/20260919_adr026_smoke_ui/README.md`（+ `raw/`）
- **被测机具（新增测试代码，位于证据目录内，不入业务路径）**：
  - `tester/evidence/20260919_adr026_smoke_ui/raw/ui_e2e.mjs`（sha256 `2971cde1cb018dc87b48c90b9a855f4c09f50415ef3c163635f73a476d068c9b`）
  - `tester/evidence/20260919_adr026_smoke_ui/raw/mutation_apply.py`（变异施加器，用于禁假绿反证）
- **待验契约**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`（§2.3 来源列、§2.4-1 审计摘要、§2.4-2/3 口径注与资金投入率、§2.1 口径消歧）

## 1. 测试策略

| 层 | 手段 | 本次是否使用 |
|---|---|---|
| 契约/单元 | `cargo test -p application --lib audit` | ✅ |
| 端点集成（真库） | `cargo test -p web --test adr026_run_audit`（ADR-025 临时库） | ✅ |
| 组件/前端单测 | `cd web && npx vitest run` | ✅ |
| **端到端（真浏览器）** | **Playwright + Chromium（非 jsdom）打线上 :8081** | ✅（本节重点） |
| 负面对照 / 变异反证 | 响应拦截 + 期望值错置 | ✅ |

真浏览器而非 jsdom 的理由：本刀的核心可验项（K 线 canvas 真实出图、`/fills` 标记、Tab 懒加载触发 `/audit` 网络请求、console/pageerror、失败请求）在 jsdom 下**无 canvas 光栅化、无真实网络**，会退化成「断言 DOM 文本存在」，正是假绿来源。

## 2. 用例设计（Given–When–Then 摘要）

| 组 | Given | When | Then |
|---|---|---|---|
| G1 结果视图 | 线上 :8081 + S1 已完成 run | 打开 `/backtest-workbench` 并点选该 run 行 | 结果容器可见；K 线容器内 canvas 存在、尺寸>200×100、**像素非空**；`/fills` note = `成交 N 笔（精确源 /fills）` 且 N>0；无 fills 错误提示 |
| G2 交易明细 Tab | 同上，默认 Tab | 读审计区 | `wb-audit-summary` 可见且含「成交合计/回合/名义投入」「现金消耗/计划批数/买入成交/未执行挂单」；warning 条存在；表头含「来源」；来源列取值 ∈ {正常,止损,期末强平} 且**无「未记录」** |
| G3 8 项绩效 Tab | 同上 | 点 `wb-tab-metrics` | 表 8 行；`wb-metrics-basis` 含「口径/分母/初始资金」；`wb-metrics-deployed` 含名义投入与含佣金两个口径 |
| G4 兼容性回归 | 历史 run（`TradeDetail.reason` 缺字段） | 同上 G1+G2 | 仍正常渲染；来源列**全部**为「未记录」（属预期，非错误） |
| G5 运行洁净度 | 全程 | 监听 console/pageerror/response | console error=0、pageerror=0、HTTP≥400 与 requestfailed=0 |
| G6 禁假绿 | 变异机具 | 断流 `/audit` + 把来源列允许集改成 `{正常}` | 同一套断言必须变红（A05–A08、A10，node exit 1） |

## 3. 选择器 / 事实源约定（避免绑实现细节）

- 只使用**稳定 `data-testid`**（`wb-kline-chart`/`wb-fills-note`/`wb-audit-summary`/`wb-audit-cash`/`wb-audit-warning-*`/`wb-audit-error`/`wb-trades-table`/`wb-trade-source-*`/`wb-metrics-table`/`wb-metrics-basis`/`wb-metrics-deployed`/`wb-tab-*`/`wb-run-select-<id>`），不使用 CSS 类与文案硬匹配做**唯一**判据（文案仅作 detail 记录）。
- 选 run 以**网络级确认**为准（等待 `/runs/{id}/{result|fills|audit}` 200），不依赖行标题文案（run 有 name 时标题不含 id）。
- 「出图」判据为**像素统计**（不同颜色数 > 1000、非背景占比 > 5%），避免「有 canvas 就算过」。

## 4. Mock/Stub 策略

- **零 mock**：直接打线上真进程、真库、真 bundle（bundle sha256 与 `web/dist` 比对一致）。唯一「注入」出现在**变异反证**中（`route.abort`），且那是为了证明断言可红，不参与正常态判定。

## 5. 边界与异常覆盖（设计预期）

1. 审计接口不可达（断流）⇒ 摘要区替换为 `wb-audit-error` + 重试按钮，断言必须红；
2. `recorded=false`（历史 run 无事实源）⇒ 显式「未记录」而非 0%（本次由历史 run 覆盖到「未记录」轻量路径）；
3. 来源列缺字段（旧 `TradeDetail`）⇒ 「未记录」；
4. 未覆盖（残留）：`wc` 级多行来源列混排（例：同 run 内既有 Policy 又有 ForceClose 的多回合 run）、`warnings.severity='warn'` 与 `info` 的配色差异断言、慢网/超时重试路径。

## 6. 覆盖目标与达成

| 目标 | 目标值 | 达成 |
|---|---|---|
| S1 run 关键可见面断言 | 100% | 25/25 checks（含 2 条选 run 前置确认） |
| 历史 run 兼容面 | 不回归 | 5/5 |
| 断言可红性（禁假绿） | ≥1 条 | 5 条（A05–A08、A10） |
| console/pageerror/失败请求 | 全 0 | 0/0/0 |

## 7. 不做的事（边界）

- 不修改业务代码、不加永久仪表；`web/src/**` 在变异反证中**未被触碰**（变异对象是证据目录内的机具文件，且逐字节还原，sha256 相同）。
- 不判定失败原因（本角色只观察与报告）；本阶段无失败项，故无归因需求。
