# 017 · 回测批 2a 深度回归 E2E 执行报告（策略表单/提交/任务列表/删除/幂等）

> 本文件位置：`eestock-rs/web/tester/test/017_backtest_form_task_2a_e2e_execution.md`（即仓库 `web/tester/test/`）

## 1. Run facts

- 执行时间：2026-09-07 00:07–00:08 CST（UTC+8）；套件总耗时 **23.6s**（11/11）。
- 环境：`http://127.0.0.1:8081`（=192.168.50.100:8081），容器 `eestock-app`=`f4256b901b30`（Up healthy），SPA `assets/index-yw4TZbPb.js`，DB `eestock-timescaledb`（127.0.0.1:5433）。
- 用例文件（新建，未 commit）：`web/e2e/backtest-form-task.e2e.ts`（self-location 见文件头注释）。
- 设计文档：`web/tester/design/014_backtest_form_task_2a_e2e_design.md`。
- 会话初快照 INI：`backtest_runs` = `[33,34,35,84,120]`（5 行，既有 run 全程未触碰）。

## 2. Suite results

**total=11 · passed=11 · failed=0 · skipped=0**（`npx playwright test e2e/backtest-form-task.e2e.ts --reporter=list`，workers=1，本文件 retries=0）

| # | 用例 | 耗时 | 结果 | 一句话证据 |
|---|---|---|---|---|
| 1 | F1a 表单渲染/默认值/schema | 254ms | ✅ PASS | 7 策略；dual_ma fast/slow/position_pct=5/20/1；boll mode=选项 select(mean_reversion/trend)；周期 1m/5m/15m/日；费用 0.025/5/2；初始金额 100000；日期 from<to |
| 2 | F1b 初始金额非法 | 281ms | ✅ PASS | cap=0/清空 → 内联「初始金额须大于 0」，**POST=0**；type=number 原生拦非数（fill('abc') 被浏览器拒绝，值不落地）；可改 200000 |
| 3 | F1c 日期区间非法 | 312ms | ✅ PASS | from>to / from==to / to 清空 → 内联「回测区间 from 须早于 to」，**POST=0** |
| 4 | F1d 网格非法 | 1.2s | ✅ PASS | grid-fast=abc → POST 400 + 内联「提交失败：HTTP 400 … 范围应为 "起:止:步长"，实际: abc」；**runsDelta=0 不建 run** |
| 5 | F2a 合法提交全链路 | 3.9s | ✅ PASS | POST 200 run_id=224；payload 全字段匹配（M5/initial_capital 123456/fee 0.03-3-1/区间 ISO）；行「运行中 3% 回测至 01-06 11:20」；**WS 1850 帧 pct 0→100 单调**；API done 且 capital/date 落库；reload→完成+查看；点查看→equity-drawdown-chart + 8 metric-card；1850+ 点长序列结果渲染 **console.error=0**（回撤负宽修复仍生效） |
| 6 | F2b 提交中禁用+幂等 | 4.5s | ✅ PASS | 响应延迟下按钮 disabled +「提交中…」；**dblclick → 1 次 POST / 只建 1 run(225)**（幂等不重复建） |
| 7 | F3+F4a 查看/删除 | 761ms | ✅ PASS | 查看→结果加载；删除→取消→0 DELETE、行保留；确认→**DELETE 200**→行移除+结果区回「选择已完成任务查看结果」；GET →404 |
| 8 | F4b 已删再删 | 715ms | ✅ PASS | 服务端先行删→UI 再删→**DELETE 404**→内联「删除失败：HTTP 404 … run 不存在」→行保留、页面不崩→reload 行消失 |
| 9 | F4c 失败 run | 612ms | ✅ PASS | code 999999→failed，错误=「回测区间无 K 线 bar（code=999999, period=D1）」；行显 失败 + title 错误可读；删除 DELETE 200 |
| 10 | F5a 重复提交幂等语义 | 846ms | ✅ PASS | 同参数两次提交→run 不同（各自独立）；两行各自完成、各自删除（同 payload 两 run，符合多 run 独立语义） |
| 11 | F5b 提交后立即删除竞态 | 9.7s | ✅ PASS | M15 一年窗提交后**running(2%)**即 DELETE→**200**；引擎跑完后 run 不复活（连续 404）；页面不崩（pageerror/console.error=0）；可继续提交并删除 run 232 |

## 3. 全程质量断言

- 全用例 pageerror=0、**应用 console.error=0**。错误路径（F1d 400 / F4b 404）仅触发浏览器原生网络诊断
  `Failed to load resource: …400/404`（有意请求非 2xx 时浏览器自动打印），已单列 `netErrs` 证据，非应用错误。
- 无跳转：各用例 URL 恒为 `/backtest`；`load` 计数 = 初始 1（F2a/F4c/F5a/F5b 为初始+有意 reload=2），无意外重载。
- 截图 10 张 + `evidence.json`：`/tmp/backtest_form_task_2a/`（F1a 表单默认 / F1b 初始金额内联错误 / F1c 日期内联错误 /
  F1d 网格 400 / F2a 运行中行+结果 / F2b 提交中禁用 / F4a 删除后占位 / F4b 404 内联 / F4c 失败行）。

## 4. Cleanup & data state

- 会话临时 run 台账 9 个（F2a/F2b 各 1 留至收尾；其余在用例内已删）：afterAll 产品 DELETE 清理（200=2，404=7=用例内已删）。
- 终态复核：`GET /api/backtest/runs` = `[33,34,35,84,120]` **与 INI 完全一致（5 行）**；无需 SQL。
- git：`web/e2e/backtest-form-task.e2e.ts` + `web/tester/` 为未跟踪新文件；**无 staged、无 commit**（eestock-rs 与上层仓库 `git diff --cached` 均空）。

## 5. 容器日志（竞态窗口）

`docker logs eestock-app` 在删除运行中 run 时出现 3 次 `ERROR mark_done 失败`：
`insert or update on table "backtest_results" violates foreign key constraint backtest_results_run_id_fkey`（run 207/216/231 = 探针+F5b 竞态删除）。
- 表现：DELETE 200、run 不复活、应用不崩溃、无 panic；后续提交正常。属**删除与引擎收尾并发的预期日志噪音**（引擎收尾时行已被删）。
- 非用户可见；但可作为产品层改进点交架构师知悉（引擎 mark_done 前可先确认行存在或容忍该竞态，消除 ERROR 日志）。

## 6. 观察与残余风险（非阻塞，供架构师知悉）

1. **页内完成不自动翻「完成」**（015 观察#3 复现确认）：F2a 中 run API done 后页内行仍「运行中 100% 回测至…」，需 reload/下一次提交刷新列表。本套件按此口径通过；是否自动刷新由架构师决策。
2. **UI 幂等护栏窗口（微）**：真实 dblclick（Playwright）→ 1 run（PASS）；但同 JS 任务内同步两次 `el.click()`（合成事件，真人不可达）可发 2 次 POST → 2 run。提交幂等依赖 React 渲染刷新禁用按钮；如需对极端重复点击也硬防护，可在 store.submit 加 in-flight 去重（属新改动，不在本次范围）。
3. 失败 run 的错误文案仅存于行内 `title`（hover 可读），无其它可见错误区 —— 若产品希望失败原因常驻可见，需架构师定夺。
4. 合法网格展开（→grid-rank 组）未在本文件重测（015 §10 已覆盖）；本批只回归非法提示。
5. 「排队(pending)」状态在真容器几乎不可见（提交响应到达前通常已 running），生命周期断言按 running→done 落地。

## 7. 结论

批 2a 聚焦范围（表单校验/提交/WS 进度/任务列表/删除/404/幂等/竞态）在真实已部署环境**全绿 11/11 PASS**，无产品功能级 FAIL；
产出可提交回归 spec `web/e2e/backtest-form-task.e2e.ts`（未 commit，供架构师复核入库），DB 恢复 INI，未改任何产品代码。
