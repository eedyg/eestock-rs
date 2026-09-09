# 084 — sim-live web 会话配置（添加标的 + 添加策略）

- 报告位置：`eestock-rs/coder/report/084_simlive_session_config.md`
- 作用域：仅 `web/src/features/simlive/` + `web/src/api/`（sim-live 相关契约/mock）；后端零改动；其它页面零改动。
- 状态：实现完成，TDD 绿，`tsc -b`/`vite build` 通过，tangle 幂等，未 commit、未 stage。

## 问题（根因）

`store.startSession({name,period,cash_init})` 未发 `strategy_set`/`stock_set`；`SessionControl` 只 `onStart({name:'手动会话',period:'M1'})`，无标的选择/策略选择。后端 `StartSessionReq{strategy_set,stock_set}` + `sim_start_session` 已接受。

## 改了什么

### 1. 会话配置 UI（`web/src/features/simlive/panels.tsx`）
`SessionControl` 新增「配置会话」面板（仅未运行态显示，`data-testid="sim-session-config"`）：
- 标的 multi-select（chips，来自 `GET /api/symbols`）、策略 multi-select（chips，来自 `GET /api/backtest/strategies`）。
- 名称（默认「手动会话」）、周期（1m/5m/15m/日 → M1/M5/M15/D1）、初始资金（默认 1000000）。
- 选中集以 chips 展示（`data-testid="sim-config-stock-<code>"` / `sim-config-strategy-<id>"`）。
- 校验：未选标的/策略时点「开始会话」→ 显示 `sim-config-error` 提示、不调用 `onStart`。
- `onStart` 类型扩为 `{name, period, cash_init?, stock_set?, strategy_set?}`。

### 2. `store.startSession` 增强（`web/src/features/simlive/store.ts`）
签名扩为 `{ name; period; cash_init?; stock_set?; strategy_set? }`，透传至 `api.startSimSession`。

### 3. `SimLivePage` 装配（`web/src/features/simlive/SimLivePage.tsx`）
- 新增 `useEffect` 拉取 `getSymbols()`（标的目录）与 `getStrategies()`（策略目录）。
- 以 `symbols`/`strategyCatalog` 传入 `SessionControl`；`onStart` 仍 `store.startSession(p)`。
- 启动后 `refreshCurrent()` 重拉 `/strategies`，策略面板/评分区据此展示所选。

### 4. client/mock/types 同步
- `SimStartSessionReq` 已含 `strategy_set?/stock_set?`，`client.startSimSession` 以 `JSON.stringify(req)` 透传 —— **未改 `client.ts`**，仅更新 `client.test.ts` 断言 body 含 `stock_set`。
- `mock.ts`：`simStrategiesView` 改为由 `session.strategy_set/stock_set` 派生（开会话选集即刻反映到策略面板/评分区）；不在内置种子集（518880/159577/161226 × dual_ma/macd/ma_rsi）的组合用确定性哈希补位；内置种子集保留原始分数/聚合/信号（兼容既有 mock 测试锁定值）。

### 5. MCP 配置（可选/注明）
`sim_start_session` 已支持 `strategy_set/stock_set`（后端口径），MCP 可经它带股票/策略开会话。per-strategy 参数/标的映射（`configure_strategies` 更细粒度）**本次不做**，先做会话级 `stock_set`+`strategy_set`（默认参数）。

## 架构对齐
- `session-control` 区域：`panels.tsx`（手写展示层）+ `store.ts`（业务/交互层）——符合 SimLivePage 现有分层。
- tangle 骨架 `layouts/SimLiveGrid.tsx` **零改动**（`entangled tangle` 幂等，"Nothing to be done"）。
- 数据源均走现有 `ApiClient` 契约（`getSymbols`/`getStrategies`/`startSimSession`），无新依赖。

## TDD（Red→Green）
先写失败测试确认红，再实现转绿：
- `web/src/features/simlive/store.test.ts`（新增）：选股+选策略 → `startSimSession` body 含 `stock_set/strategy_set`；缺省不带。
- `web/src/features/simlive/SimLivePage.test.tsx`：未运行可配置并开始 → body 含 `stock_set/strategy_set`；chips 展示；未选择 → 提示且不调 `startSimSession`；开始后策略面板/评分区采用所选（mock 派生）；改既有「可开始会话」为先选后启。
- `web/src/api/client.test.ts`：`startSimSession` body 断言补 `stock_set`。

## 验证
- `cd eestock-rs/web && npx vitest run` → 39 文件 358 用例全绿（含 simlive 15 + store 2 + mock 27 + client 39）。
- `VITE_API_MOCK=0 npx tsc -b` → 通过。
- `VITE_API_MOCK=0 npx vite build` → 通过（仅既有的 chunk>500kB 警告）。
- `entangled tangle` → idempotent（"Nothing to be done"，layouts 无 diff）。
- 未执行 `git commit`；`git diff --cached` 为空（未 stage）。

## 残留风险
- mock 的 `simStrategiesView` 对「非内置种子集」的 stock×strategy 用确定性哈希补位（分数为模拟值，非真实回测）；联调以后端为准。
- per-strategy 参数/「策略×标的」映射配置未做（本次为会话级 `stock_set+strategy_set` 默认参数），需后续用后端 `configure_strategies`。
- 会话配置仅覆盖「未运行态」；运行中不能改选集（需先停止——符合后端一次会议程）。
- `cash_init` 输入为字符串解析；非法/≤0 回退为 `undefined`（后端兜底）。
