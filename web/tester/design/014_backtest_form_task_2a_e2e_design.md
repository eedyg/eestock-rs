# 014 · 回测批 2a 深度回归 E2E 设计（策略表单/提交/任务列表/删除/幂等）

> 本文件位置：`eestock-rs/web/tester/design/014_backtest_form_task_2a_e2e_design.md`（即仓库 `web/tester/design/`）

## 1. 目标与范围

对页面⑤回测工作台（`/backtest`）做批 2a 深度回归，交付**可提交**的 Playwright 真实环境用例文件
`web/e2e/backtest-form-task.e2e.ts`（本次不 commit，供架构师复核后入库）。聚焦：

1. **策略表单**：schema 驱动参数渲染（数值/选项）、初始金额（默认/非法）、日期区间、周期、费用、参数网格非法提示。
2. **提交**：POST /api/backtest/runs 200 + payload、任务行生命周期、WS backtest_progress 0→100、提交中禁用、幂等（dblclick 只建 1 run）。
3. **任务列表**：状态/进度/回测至显示、点已完成加载结果、失败 run 显示失败+错误。
4. **删除**：取消不删、确认 DELETE 200 行移除+结果区清空、404（重复删/不存在）、UI 内联删除失败。
5. **幂等/可重入**：重复同参数多 run 独立、删除后再删 404、提交后立即删除竞态不崩溃不复活。

## 2. 测试策略（分层）

| 层 | 方式 | 用例 |
|---|---|---|
| 契约/网络 | 真实容器 REST：GET strategies/runs/run、POST runs、DELETE runs（Node fetch + 页面监听双通道） | F1d/F2a payload/F4 系列 |
| 实时进度 | 页面 WS 订阅 `backtest` topic，捕获 `backtest_progress` 帧（run_id/pct/bar_ts） | F2a（1850 帧 0→100） |
| UI E2E | Playwright chromium 真浏览器，data-testid 定位，全程 pageerror/console.error/load 计数 | F1a–F5b 全部 |
| 清理/恢复 | 会话台账 created→afterAll 产品 DELETE；终态 GET /runs == 会话初快照 INI | afterAll 断言 |

无 mock/stub：全部走真实已部署容器 + 真实 DB（与既有 run 33/34/35/84/120 并存，不触碰）。

## 3. 用例清单（11 例，全部真容器可重复）

| 用例 | 场景 | 关键断言 |
|---|---|---|
| F1a | 表单渲染/默认值/schema | 7 策略；dual_ma 3 数值参数默认 5/20/1；boll mode 选项 select（mean_reversion/trend）；周期 4 档；费用 0.025/5/2；初始金额 100000；日期 from<to |
| F1b | 初始金额非法 | fill 0/清空 → 内联「初始金额须大于 0」；**0 POST**；type=number 拦非数；可改 200000 |
| F1c | 日期区间非法 | from>to / from==to / to 清空 → 内联「回测区间 from 须早于 to」；**0 POST** |
| F1d | 网格非法 | grid abc → 提交失败 HTTP 400 内联（范围应为 "起:止:步长"）+ 后端 400 + **不建 run** |
| F2a | 合法提交全链路 | POST 200 run_id；payload 全字段（M5/123456/0.03-3-1/区间 ISO）；行「运行中 % 回测至…」；WS 1850 帧 pct 0→100 单调；API done；reload→完成+查看；点查看→图+8 指标卡；长序列(>980 点)结果渲染 0 console.error（回撤负宽修复复验） |
| F2b | 提交中禁用+幂等 | POST 响应延迟下按钮 disabled +「提交中…」；**dblclick 只 1 次 POST / 只建 1 run** |
| F3+F4a | 已完成查看/删除 | 点查看→结果加载；删除→取消→0 DELETE 行保留；确认→DELETE 200→行移除+结果区占位清空；GET 404 |
| F4b | 已删再删 404 | 服务端先行删→UI 再删→DELETE 404→内联「删除失败：HTTP 404…run 不存在」→行保留不崩→reload 行消失 |
| F4c | 失败 run | code 999999→failed（错误=回测区间无 K 线 bar）；行显示 失败+title 错误可读；可删除 DELETE 200 |
| F5a | 重复提交幂等语义 | 同参数两次提交→r1≠r2 各自 done 独立行、可各自删除 |
| F5b | 提交后立即删除竞态 | M15 一年窗运行中(running 2%)即 DELETE→200；等过引擎时长不复活(404)；页面不崩；可继续提交 r3 并删除 |

## 4. 边界/异常与证据采集

- 非法输入**零提交**（0 POST）与**零建 run**（apiIds 前后相等）。
- 错误路径（网格 400/重复删 404）会触发浏览器原生 `Failed to load resource: ... 4xx` 诊断——
  设计中把这类浏览器网络诊断与**应用 console.error** 分离计数（`netErrs` vs `cerr`），断言后者为 0。
- 证据：逐用例截图 `/tmp/backtest_form_task_2a/*.png` + 结构化 `evidence.json`（payload/WS 帧数/pct 序列/DELETE 状态/内联文案）。

## 5. 覆盖目标与已知缺口（回归口径）

- 覆盖：表单校验全路径、提交幂等（UI 层）、WS 进度、删除 3 态、404、竞态、失败 run。
- 已知缺口（不入本次）：合法网格展开→grid-rank 排行（此前 015 §10 已验收，本次仅回归非法提示）；
  状态机「排队(pending)」几乎不可观测（POST 响应前 run 即进入 running），按 running→done 覆盖；
  页内完成自动翻转「完成」不做（同 015 观察#3，本套件按 reload 口径复核并记录）。

## 6. 运行方式与清理

```
cd web && E2E_BASE_URL=http://127.0.0.1:8081 E2E_SHOTS=/tmp/backtest_form_task_2a \
  npx playwright test e2e/backtest-form-task.e2e.ts --reporter=list
```

- retries=0（真库写用例；失败需整文件重跑保证台账确定性）；afterAll 产品 DELETE 清临时 run 并断言 DB 恢复 INI。
- 全程不改产品代码/接口；不 commit（spec 留待架构师复核入库）。
