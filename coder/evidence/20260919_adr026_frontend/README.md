# ADR-026 阶段 3（前端披露）证据与交付说明

- **本文件位置**：`coder/evidence/20260919_adr026_frontend/README.md`
- **契约（冻结，已完整读取）**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`
  （本阶段实现 §2.3 的 `TradeDetail.reason` 消费、§2.4 的前端披露；**不改** §2.2 端点契约）
- **上游事实源**：`coder/evidence/20260919_adr026_backend/`（阶段 2 端点实测响应；字段名以
  `43_raw_audit_A3_A4.json.txt` 的真实响应为准，**未凭任务提示臆造**，逐字段交叉校验见 `raw/30_contract_field_crosscheck.txt`）
- **交付基线**：`git rev-parse HEAD` = `e807385449a303a1090ac00a52c722b7b77e62ec`（工作树基线见 `raw/00_baseline.txt`）
- **纪律**：**未执行任何 `git add / commit / checkout / stash / reset`**（`git diff --cached` 为空，
  见 `raw/80_changed_files_sha256.txt` 末段）；未改后端已验收行为；未改表结构/迁移；未创建临时库

---

## 1. Raw 证据索引

| 文件 | 内容 |
|---|---|
| `raw/00_baseline.txt` | 动手前 `git status --porcelain`（14 个 ` M` 全为既有基线改动）+ 7 个待改文件 sha256 基线 + `git diff --cached` 为空 |
| `raw/10_red_frontend.txt` / `10_red_frontend_full.txt` | **Red**：`Tests 14 failed \| 110 passed`（14 条新用例全红，既有用例零回归） |
| `raw/20_green_frontend.txt` | **Green**：三条目标文件 `125 passed`；15 条 ADR-026 用例逐条列出；ResultView 单文件 act 噪声 = 0 |
| `raw/21_green_full_web_suite.txt` | web 全量 `npx vitest run`（94 文件 / 916 用例全绿）+ `npx tsc -b` exit=0 + 一次与本批无关的 flake 记录 |
| `raw/30_contract_field_crosscheck.txt` | 后端真实响应字段 ↔ 前端 `WorkbenchRunAudit` 声明字段逐字段交叉校验（双向「无缺失」） |
| `raw/40_db_and_scope_check.txt` | 无 DB 测试（未建临时库）；只读回读库清单 = `{eestock, postgres}`、`tmp_%` 计数 0；`migrations/` 未触碰 |
| `raw/80_changed_files_sha256.txt` | 本批 8 文件 sha256（含新文件）+ 基线对照 + `git diff --stat` + `git diff --cached` 为空 |

## 2. 变更文件（本批仅 web/，8 个）

| 文件 | 状态 | sha256 |
|---|---|---|
| `web/src/api/types.ts` | M | `39a583dd0fa98f78d55f14f73e3cf4f486948d27e3425d031f83cb58e3df0b63` |
| `web/src/api/client.ts` | M | `55912f10b160d4e99e37417e4ef1f0a98fc8aede1288a5e03d25253b02751acc` |
| `web/src/api/mock.ts` | M | `c977bb8ffa94938cab48ecf2f04985b77dca297f262c4e75d47104559e4190ab` |
| `web/src/features/workbench/ResultView.tsx` | M | `1226b2e7a3acc62679533fe21f9f9e2793af0268089741b967bcab66492ba446` |
| `web/src/features/workbench/useRunAudit.ts` | **新增** | `b3492c899a687bee821d46d86fdb48fc6ceb1bbfcb2e72ae74eb4bd114dba3ad` |
| `web/src/api/client.test.ts` | M | `07e0ae6a69d1a8ebe2f6564535866d292a67a6d0da214e33e6bc788d7ef38b9f` |
| `web/src/api/mock.test.ts` | M | `632a8e889aa7d0c04210cd22e6b2addf712566cd0c91ccd8fea86a5554ebe32d` |
| `web/src/features/workbench/ResultView.test.tsx` | M | `089788b0d952aba0f463965d9124c1893e2f979449bcd3dd983bb6e0d90e4ab1` |

（`git diff --stat -- web/` = 7 files changed, **709 insertions(+), 21 deletions(-)**，外加 1 个新文件未跟踪。）

## 3. 契约逐条对照（ADR-026 §2.4 + §2.3）

| 契约要求 | 实现 | 用例 |
|---|---|---|
| §2.4-1 交易明细 Tab 表上方审计摘要行「成交 N 笔（逐笔源 /fills）｜回合 M 条（其中强平合成 K 条）｜名义投入 X%（分母 = 初始资金）」 | `AuditSummary`（`data-testid="wb-audit-summary"`）；N 取 `/fills` 的 `total`（**精确源**，非 `trades`、非抽样） | `ResultView > ADR-026：交易明细 Tab 审计摘要行…` |
| §2.4-1 `warnings` 非阻断提示条（带 data-testid） | `wb-audit-warnings` + 逐条 `wb-audit-warning-{code}`（warn=⚠ 红框 / info=ℹ 灰框）；**仍照常渲染表格**（非阻断） | 同上；空 warnings ⇒ 不渲染容器（`warnings 为空 ⇒ 不渲染提示条`） |
| §2.3 来源列（新 run：正常/止损/期末强平；历史 run 缺字段：未记录） | `tradeSourceLabel()`：`Policy→正常`、`StopTrigger→止损`、`ForceClose→期末强平`、缺失/null→`未记录`；列 `wb-trade-source-{i}` | `交易明细「来源」列…`（4 值逐一）+ `来源列历史 run 实测…`（mock 种子 run 实测「未记录」） |
| §2.4-2 8项绩效 Tab：口径注（分母 = 初始资金）+ 资金投入率 | `wb-metrics-basis`（口径注，含 `capital_basis` 金额）+ `wb-metrics-deployed`（资金投入率 = `deployed_pct`；并披露 `cash_consumed_pct`） | `8项绩效 Tab —— 口径注…` |
| §2.4-3 `profit_factor=null` → 「∞（无亏损）」并注明 | 表格值 = `∞（无亏损）`；注 = `wb-metrics-pf-note`（仅 null 时出现） | 同上 + `profit_factor 有值 ⇒ 显示数值且无 ∞ 注` |
| §2.4-3 审计按需懒加载（打开对应 Tab 才调用） | `useRunAudit({enabled})`：仅 `tab ∈ {trades, metrics}` 且 run 成功且有结果才请求；同一 run 只取一次（切 Tab 复用） | `审计按 Tab 懒加载…`（含 running run 不请求） |
| §2.4 三态（loading/error/retry 沿用既有模式） | 审计 loading 行 / 失败行 + 重试按钮（`wb-audit-loading` / `wb-audit-error` / `wb-audit-retry`） | `loading 三态骨架…` + `error → 重试三态…` |
| 阶段 2 移交项：`recorded=false` 须显「未记录」而非 0% | `wb-audit-unrecorded`（交易明细）+ `wb-metrics-deployed` 显「未记录」；**不渲染** `wb-audit-summary`（不暴露 0 值） | `recorded=false ⇒ 显式「未记录」，绝不把 0 渲染成投入率` |
| §2.1 口径消歧（敞口/资金占用分别命名披露） | 摘要第二行 `wb-audit-cash`：`现金消耗（含佣金）X%`（与「名义投入」分开命名） | `交易明细 Tab 审计摘要行…`（`41.61%` 断言） |

## 4. 交叉校验（字段名以真实响应为准）

`raw/30_contract_field_crosscheck.txt`：从阶段 2 证据 `43_raw_audit_A3_A4.json.txt` 解析 A3 真实响应，
与 `web/src/api/types.ts` 的 `WorkbenchRunAudit` / `WorkbenchAuditWarning` 声明字段比对：

```
后端有前端缺: 无
前端有后端缺: 无
warnings[0] keys = ['code','message','severity'] | WorkbenchAuditWarning = ['code','message','severity']
```

`ResultView.test.tsx` 中的 `AUDIT_BASELINE` 逐字段取该真实响应值（`41397.97208076086` /
`0.4139797208076086` / `41607.97208076086` / `0.41607972080760863` / 43-42-1 / 100 / 1-1 / 3 条 warnings），
因此「审计摘要 41.40% / 现金消耗 41.61%」的断言直接绑定冻结基准，而非自造数字。

## 5. TDD 记录

1. **Red**（先写测试，未写实现）：`raw/10_red_frontend.txt`
   `npx vitest run src/api/client.test.ts src/api/mock.test.ts src/features/workbench/ResultView.test.tsx`
   → `Tests 14 failed | 110 passed (124)`；失败根因样例：
   `Unable to find an element by: [data-testid="wb-audit-summary"]`、
   `api.getRunAudit is not a function`（14 条为新增用例，既有 110 条全绿 = 零回归）。
2. **Green**（最小实现）：`raw/20_green_frontend.txt` → 三条文件 `125 passed`；
   全量 `raw/21_green_full_web_suite.txt` → `94 files / 916 passed`，`tsc -b` exit=0。
   Green 后**补入 1 条**用例（`/fills 未记录 ⇒ 摘要行不得伪造 0 笔`，覆盖摘要行的诚实留白分支）
   ⇒ 新增用例共 **15** 条（14 红 + 1 补）。
3. **Refactor**：实现后仅做两处**测试健壮性**修整（不放松语义）：
   - 两条 metrics 断言改 `waitFor`（审计是异步取数，`findByTestId` 会命中「加载中」占位）；
   - 既有两条 legacy 用例（`legacy_single 路径零回归`、`切换 run …`）各补一行 `await screen.findByTestId('wb-audit-summary')`
     —— 否则它们在测试体结束后才落审计状态，产生 React `act(...)` 噪声（补后 act 噪声计数 = 0）。

## 6. 与 ADR 的偏差 / 自行取舍（契约未逐字覆盖处）

1. **摘要行加「现金消耗（含佣金）X%」第二行**：ADR §2.1 明文要求 `deployed_*`（敞口）与
   `cash_consumed*`（含佣金）**必须分别命名、分别披露**（禁止同物异名）。§2.4 只给了摘要行的最小句式，
   故实现把契约要求的四项放在第一行（逐字对齐），把「现金消耗（含佣金）」作为第二行单独披露
   （`wb-audit-cash`），未合并进同一百分比。
2. **来源列 = `TradeDetail.reason` 原样映射**（`Policy/StopTrigger/ForceClose`），JSON 里若出现未知取值则
   原样显示（不猜、不折叠成「未记录」）；`null`/缺字段才显「未记录」。
3. **懒加载边界**：把「需要审计」定义为 `tab ∈ {trades, metrics}` 且 run `succeeded` 且有结果
   —— 未选中/未成功/running 的 run 无结果即无审计，一律不发请求（ADR §4「仅在 UI 打开对应 Tab 时调用」）。
4. **同 run 只取一次**：`useRunAudit` 用 `runId#nonce` 作为已取数键，切 Tab 不重复打请求；
   `retry()` 显式重试；切 run 时清空旧数据（不残留上一个 run 的审计）。
5. **`wb-audit-error` / `wb-audit-retry` 在两个 Tab 复用同一 testid**：同一时刻只有一个 Tab 挂载
   （不会重复出现在 DOM 中），两处语义完全一致（审计加载失败 + 重试），故复用而非另造命名。
6. **`Metrics.profit_factor` 由 `number` 放宽为 `number | null`**：这是后端既有语义（JSON 无法表达 ∞，
   阶段 2 实测 A4 亦为数值/null 两态），前端原类型声明与后端不符。放宽后仅两处消费者（`fmtRatio` 与
   本 Tab）受影响，`fmtRatio` 本就接受 `null`，故 `tsc -b` 全绿、无连带改动。
7. **mock 新增 `workbenchAuditMissing` 开关**（与既有 `workbenchFillsMissing` 同风格）用于
   `recorded=false` 场景；mock 的审计**不重写一套算法**，而是照 ADR §2.1 从 `per_bar.orders/events`
   + run config 派生（逐笔佣金 `max(额×费率, 最低)`），并与 `/fills` 交叉自洽。
8. **mock 的 `TradeDetail.reason`**：新提交 run（`chunked_v1`）由生成器写入来源；
   种子 run（= `legacy_single` 历史 run）**删掉** `reason` 键，以忠实模拟「历史 run 永久为 null」。

## 7. 回归

- `raw/21_green_full_web_suite.txt`：
  - `npx vitest run`（web 全量）→ **94 files / 916 tests passed**（exit=0）。
  - `npx tsc -b` → exit=0（`noUnusedLocals`/`verbatimModuleSyntax`/`noUncheckedIndexedAccess` 全通过）。
- **一次与本批无关的 flake**（同文件已如实记录）：某次全量运行中
  `src/features/settings/SettingsPage.test.tsx > 源参数面板：保存启用，编辑速率→PATCH 乐观更新…` 报
  `expected 110 to be 10`（输入被重复键入）。该文件与 ADR-026 零交集；单文件隔离重跑 3/3 通过
  （11 passed ×3），全量重跑亦全绿。**登记给主代理/测试者处置**，本批不代改。

## 8. 未做 / 残留风险

1. **活库 :8081 尚未含 `/audit`**（实测 `curl http://127.0.0.1:8081/api/workbench/runs/sr_1789738328788_000005/audit`
   → `404 {"error":"not found"}`；在跑进程 `ps` 显示 `Fri Sep 18 18:04:44 2026 ./target/debug/eestock-app`，
   早于阶段 2 改动）。⇒ **ADR-026 §5 A6 真浏览器 E2E（阶段 4）需先重新部署工作树二进制**；
   本车道按纪律未改部署、未动进程。前端消费的字段则以阶段 2 已验收端点响应为事实源并逐字段交叉校验。
2. **mock 保真度差异（非缺陷，供 E2E/后续判读）**：mock 的简薄撮合只投出约 90% 资金且 `per_bar.orders`
   恒为空（mock 不生成订单意图），因此 mock 下 `PARTIAL_DEPLOYMENT` 天然出现、`reachable_batches=0`；
   真实后端的这些值取决于 run 形态（A3=43/42/1，A4 满仓无告警）。**阶段 4 判据以真实后端为准，不读 mock 数值。**
3. 历史 run 的 `TradeDetail.reason` 永久缺失 ⇒ 来源列永久显「未记录」（ADR §2.3 已接受，审计端点以
   `round_trips_force_closed` 补足披露）。
4. 审计端点全量扫 `per_bar`（ADR §6 已知成本）⇒ 仅在相关 Tab 按需调用，未做增量索引。
5. 本阶段**未**新增文档章节（ADR §2.4 未要求改设计文档；如需在 `design/09-frontend.md` 登记前端契约，
   属文档侧独立处理）。

## 9. 交付纪律自检

- `git add / commit / checkout / stash / reset`：**均未执行**（`git diff --cached` 为空）。
- 后端文件（`crates/**`）本批**未触碰**：`git status --porcelain -- crates/` 的 12 个 M 与 2 个 ?? 与
  `raw/00_baseline.txt` 完全一致（阶段 2 产物）。
- 表结构 / 迁移：未改、未新增（`raw/40_db_and_scope_check.txt`）。
- 引擎语义：无接触（本批仅 web/ 前端）。
