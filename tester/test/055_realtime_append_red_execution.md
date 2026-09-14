# 实时通路红测试执行报告（T-R1~T-R5 Red 证据 + 既有 e2e 时间炸弹修正）

- 本文件自身路径：`tester/test/055_realtime_append_red_execution.md`
- 层级：执行报告（**只执行/观测**：记录运行命令、结果、失败清单与证据；不做失败分析、不修产品代码）
- 落地设计记录：`tester/design/056_realtime_append_red_tests_landed.md`
- 上游设计/诊断：`tester/design/055_realtime_append_red_test_design.md`、`tester/report/055_kline_realtime_bar_append_diagnosis.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`；HEAD = `6391a4d`（工作树仅测试文件变更：4 新增 + 1 修改）
- 运行时间：2026-09-14 10:19–10:34（本地时钟，Asia/Shanghai）
- 证据目录：`tester/evidence/055/red/`
- 本报告自身路径：`tester/test/055_realtime_append_red_execution.md`
- 纪律：未改产品代码；未 `git add/commit/stash`；未 tangle；未 kill/重启线上实例（PID 2948632 持有 8081/8082）；
  e2e 只跑 `kline-matrix.e2e.ts`（该文件**无任何写请求路径**，见 §6）。

---

## 1. 命令与结果总览

| # | 命令（工作目录 `web/`） | 结果 | 日志 |
|---|------------------------|------|------|
| 1 | `npx vitest run --reporter=basic`（基线，新增测试前） | **58 文件 / 577 用例 全绿**，exit 0 | `vitest_baseline.log` |
| 2 | `npx vitest run src/ws/WsClient.watchdog.test.ts src/features/dashboard/feedRealtimeReconnect.test.ts src/features/dashboard/feedRealtimePoll.test.ts src/features/dashboard/KlineChart.realtime.test.tsx --reporter=basic` | **4 文件 / 21 用例：14 失败 / 7 通过**，exit 1 | `vitest_red_1.log`、`vitest_red_2.log`（两次结果逐条一致 ⇒ 可重复） |
| 3 | `npx vitest run --reporter=basic`（新增测试后全量） | **62 文件 / 598 用例：14 失败 / 584 通过**，exit 1；既有 58 文件的 **577 条全部仍绿**（无附带破坏） | `vitest_full_after.log` |
| 4 | `npx tsc -b`（`npm run build` 的类型检查段；测试文件也在 `tsconfig.app` 的 `src` 内） | exit 0（无类型错误） | `tsc_check.log`（空输出）+ `tsc_check_note.txt` |
| 5 | `E2E_BASE_URL=http://localhost:8081 npx playwright test kline-matrix.e2e.ts --retries=0 -g "G16\|G18"` ×2 | **2/2 passed ×2 次（无 retry）** | `e2e_g16_g18_after.log`、`e2e_g16_g18_after_2runs.log` |
| 6 | 同前，但用 **HEAD 版旧 G16/G18**（临时副本，跑完即删） | **G16 ✘ / G18 ✘**（硬编码 `2026-09-04` 时间戳 ⇒ 被 `applyRealtime` 判 `ignore`、标记不出现） | `e2e_g16_g18_before.log` |
| 7 | `E2E_BASE_URL=… npx playwright test kline-matrix.e2e.ts --retries=0`（全矩阵，验新 harness 未破坏其它用例） | 20 passed / 1 failed（E12 失败见 §7） | `e2e_fullfile_after.log` |
| 8 | `… -g "E12" --retries=0` ×3（隔离复跑） | 3/3 passed ⇒ E12 失败为真实 quote 串扰 flake，非 harness 回归 | `e2e_e12_repeat.log` |

## 2. Red 失败清单（14 条；全部为 `AssertionError`，无异常崩溃）

| # | 用例 | 位置 | 失败断言（原文摘要） | 崩溃/core |
|---|------|------|----------------------|-----------|
| 1 | T-R1-a 静默达阈值 → 主动 close() 并重连 | `WsClient.watchdog.test.ts:131` | `AssertionError: expected +0 to be 1`（`s0.closeCalls`） | 无 |
| 2 | T-R1-b 半开连接（无 onclose）仍必须重连 | `WsClient.watchdog.test.ts:156` | `expected +0 to be 1`（`s0.closeCalls`） | 无 |
| 3 | T-R1-c 持续入站帧后到阈值必须关 | `WsClient.watchdog.test.ts:187` | `expected +0 to be 1`（`s0.closeCalls`） | 无 |
| 4 | T-R1-d 自愈后必须做一次 HTTP 补偿 | `WsClient.watchdog.test.ts:223` | `expected +0 to be 1`（看门狗未触发） | 无 |
| 5 | T-R2-a 断线错过 3 根 → 重连补齐 | `feedRealtimeReconnect.test.ts:127` | `expected [ '…01:50Z', …(3) ] to deeply equal [ '…01:50Z', …(6) ]` | 无 |
| 6 | T-R3-a 每 60s 恰一次（limit 3~5） | `feedRealtimePoll.test.ts:115` | `expected "spy" to be called 2 times, but got 1 times` | 无 |
| 7 | T-R3-a2 合并语义（append/覆盖/忽略） | `feedRealtimePoll.test.ts:145` | `expected [ '…01:50Z', …(2) ] to deeply equal [ '…01:50Z', …(3) ]` | 无 |
| 8 | T-R3-b 与 WS 不重复写入 | `feedRealtimePoll.test.ts:178` | `expected 1.5 to be 1.7`（同 ts 改 OHLC 未覆盖） | 无 |
| 9 | T-R3-d2 不可见暂停 → 可见恢复 | `feedRealtimePoll.test.ts:210` | `expected 1 to be greater than 1`（无兜底轮询） | 无 |
| 10 | T-R3-e1 退避 1→2→4→8→60s | `feedRealtimePoll.test.ts:251` | `expected 1 to be 2`（第 2 次调用不存在） | 无 |
| 11 | T-R4-a 注册前 bar 必须缓冲补投 | `KlineChart.realtime.test.tsx:152` | `expected "spy" to be called 2 times, but got 0 times` | 无 |
| 12 | T-R3-c2 manualAdjusted 时不得滚动 | `KlineChart.realtime.test.tsx:208` | `expected 2 to be 1`（新 bar 触发了 `scrollToRealTime`） | 无 |
| 13 | T-R5-a 视口外新 bar 提示且不滚动 | `KlineChart.realtime.test.tsx:228` | `expected 0 to be greater than 0`（无「新数据」提示） | 无 |
| 14 | T-R5-b 点击提示跳转最新 | `KlineChart.realtime.test.tsx:240` | `expected undefined to be truthy`（无提示可点） | 无 |

**崩溃 / core dump**：无。日志中 `grep "Unhandled|Segmentation|core dumped|Worker|FATAL"` 零命中；
失败均为断言级，进程 exit 1（测试失败）而非异常终止。

### 2.1 通过（守卫型）用例 7 条 —— 当前绿、**修复后必须仍绿**
| 用例 | 位置 | 说明 |
|------|------|------|
| T-R2-b 补偿窗口只含已知 bar ⇒ 幂等 | `feedRealtimeReconnect.test.ts` | 当前「绿」因无补偿动作；修后须真幂等 |
| T-R3-d 非交易时段跳过 | `feedRealtimePoll.test.ts` | 当前「绿」因无轮询；修后须真跳过 |
| T-R3-e2 空返回不得清空/重建 | `feedRealtimePoll.test.ts` | 同上 |
| T-R3-c1 非跟随态不得滚动 | `KlineChart.realtime.test.tsx` | 防回归（口径①） |
| T-R4-b 无竞态时不得重复投递 | `KlineChart.realtime.test.tsx` | 防「缓冲永不冲刷」 |
| T-R5-c 跟随态不提示 | `KlineChart.realtime.test.tsx` | 提示语义负例 |
| T-R5-d 视口内不提示 | `KlineChart.realtime.test.tsx` | 任务 T-R5 限定条件 |

## 3. 每条红测试钉死的口径（与任务口径 ①–④ 的对应）

| 口径 | 由哪些用例钉死 |
|------|----------------|
| ① 绝不自动把非跟随态视口拉回最右 | T-R3-c1（守卫绿）、T-R3-c2（红）、T-R5-a（红，且断言不滚动）、T-R5-b（点击才跳转） |
| ② 兜底与 WS 复用同一 `applyRealtime`、按 ts 唯一键合并（更晚 append / 同 ts 覆盖 / 更早忽略） | T-R3-a2（红）、T-R3-b（红）、T-R2-a（红，逐根经 `onRealtime` 下发）、T-R2-b / T-R3-e2（守卫）、T-R1-d（重连后的补偿走同一最新窗口口径） |
| ③ 非交易时段跳过分钟轮询 | T-R3-d（守卫）、T-R3-a（交易时段必须轮询，红） |
| ④ 失败指数退避 1→2→4→8→60s、成功复位、不弹错 | T-R3-e1（红：边界逐段计数 + 失败期数据不变 + 无异常抛出）；T-R3-d2（页面不可见暂停/恢复） |
| 任务 T-R1（静默自愈） | T-R1-a/b/c（红） |
| 任务 T-R4（启动竞态不得静默丢弃） | T-R4-a（红）、T-R4-b（守卫） |
| 任务 T-R5（可见性提示） | T-R5-a/b（红）、T-R5-c/d（守卫） |

## 4. e2e「时间炸弹」修正（修测试缺陷，非放宽断言）

修正点（`web/e2e/kline-matrix.e2e.ts`）：
1. **时间戳相对化**：新增 `latestBarTs()`（只读 `GET /api/kline?...&limit=3` 取最新 bar ts）与 `nextTs()`（+n 个周期步长），
   G16/G18 注入帧不再使用硬编码 `2026-09-04T08:00:00Z`/`08:15:00Z`/`08:01:00Z`（数据推进后必被 `applyRealtime` 判 ignore）。
   1m 注入改 +2 分钟，避开诊断 §2.4「采集侧 1m 行标签领先墙钟 45–60s」窗口。
2. **与真实流隔离**：注入底座新增 `__isolateBarStream(true)` —— 只**丢弃真实 WS 的 `bar` 帧**（health/quote 等照旧放行，
   不影响连接活性/未来看门狗判定），注入帧经 `__push` 直投 app 原始 `onmessage` 不受影响；G16/G18 在 `gotoPage` 前开启。
3. **确定性等待替代固定 sleep**：底座记录 app 实际发出的帧（`__sent`），新增 `waitSubscribed(page,'bar',{code,period})`；
   G18 切 1m 时改为等 `period=1m` 的 `/api/kline` 响应 + 订阅建立（原为 `waitForTimeout(4000)`）。
4. **断言强度不变**：仍断言 append 后 `[data-realtime-marker]` 出现并显示**注入帧**的价（9.15）、虚线样式、
   画布指纹变化；同 ts 改价（9.28）后标记与画布再次变化。仅把「同一帧可重发」限定在
   `pushBarExpectMarker()` 的启动竞态兜底（最多 4 次，最终仍必须显示注入帧价）。

A/B 证据（同一线上实例，`--retries=0`）：
```
# 修前（HEAD 版旧用例，临时副本，跑完即删）
1) … G16 WS 新 bar appendBar + 同 ts updateBar … ✘
   Error: expect(locator).toHaveCount(expected) failed / Locator: [data-realtime-marker] / Expected: 1 / Received: 0 / Timeout: 5000ms
2) … G18 实时叠加在 15m 与 1m 都生效 ✘
   Expected substring: "9.17" / Error: element(s) not found
   2 failed

# 修后（本轮改版，连跑 2 次）
=== RUN 1 ===  ✓ G16 (4.5s)   ✓ G18 (3.3s)   2 passed (8.1s)
=== RUN 2 ===  ✓ G16 (4.5s)   ✓ G18 (3.3s)   2 passed (8.1s)
```

## 5. 覆盖率

未采集：`web/package.json` 未配置 coverage provider（无 `@vitest/coverage-v8`/`--coverage` 脚本），本轮不新增依赖。
替代口径：每个口径/分支均有对应用例（见 §3 映射表）；`applyRealtime` 三分支 + 兜底幂等 + 看门狗正反例齐备。

## 6. 线上实例与写请求纪律（含一次运行范围意外，已验证无写请求）

- 全程未 kill/重启 PID 2948632（8081/8082）；e2e 只连 `localhost:8081` 做浏览器交互（页面本身只发 GET）。
- `e2e/kline-matrix.e2e.ts` 经检查**不含任何写请求路径**：`grep -n "request\.(post|put|delete|patch)|fetch\(|db\.|preClean|cleanupSymbol|PURGE"` → 0 命中；
  也无「保存 MA/DCAP/K线配置」按钮点击（指标开关为页面本地状态）。
- **运行范围意外**：第 6 号命令本意只跑旧版 G16/G18，但 Playwright 的 `-g` 未生效（同参数在 `kline-matrix.e2e.ts` 上正常，
  在临时副本文件名上失效；`--list` 复现同为 21 条），实际执行了该文件的 21 条用例（19 通过 + 旧 G16/G18 失败，3.9 分钟）。
  **后果评估**：该文件内无写请求路径（上述 grep），因此未对线上发任何写请求、未改库；其余 19 条为只读交互用例且全部通过。
  临时副本 `e2e/ab-old-g16g18.e2e.ts` / `e2e/_ab_old_g16g18.e2e.ts` 已删除，`git status` 仅剩 1 个已修改文件 + 4 个新增测试文件。
  后续同类 A/B 请先 `--list` 确认条数。

## 7. 本次执行观察到、**未修复**的既有问题（超出本任务范围，仅上报）

| 现象 | 证据 | 初判（仅记录，不作分析） |
|------|------|--------------------------|
| 全矩阵复跑时 `E12 点击宫格格子进单图聚焦该标的 + 格内最新价跳动（quote 注入）` 失败：期望单元格显示注入的 `-5.55`，实际显示真实行情 `-0.78%` | `e2e_fullfile_after.log`（20 passed / 1 failed）；隔离复跑 3/3 通过（`e2e_e12_repeat.log`） | 与本次 harness 改动无关（E12 未开启 bar 帧隔离，真实 `quote` 帧可覆盖注入值），属「真实流串扰」型既有 flake |

## 8. 未做的事（按角色与任务约束）

- 未修改任何产品代码/接口/架构（`web/src/**` 仅新增 `*.test.*`）。
- 未尝试修复红测试失败（不进入失败分支、不调试实现）。
- 未新增覆盖率依赖、未改 CI/构建配置。
- 未改 `design/14-dcap-indicator` 的 `file=` 代码块、未改 ABI/引擎/ExecutionPolicy、未 tangle。

## 9. 证据索引（`tester/evidence/055/red/`）

| 文件 | 内容 |
|------|------|
| `vitest_baseline.log` | 基线：58 文件 / 577 用例全绿（新增测试前） |
| `vitest_red_1.log` / `vitest_red_2.log` | 4 个新文件两次独立运行：14 红 / 7 通过（逐条一致） |
| `vitest_full_after.log` | 全量：62 文件 / 598 用例，14 红（全在新文件内）/ 584 通过 |
| `tsc_check.log` + `tsc_check_note.txt` | `npx tsc -b` exit 0（测试文件类型检查通过） |
| `e2e_g16_g18_before.log` | 修前（HEAD 版 G16/G18）失败原文 |
| `e2e_g16_g18_after.log` / `e2e_g16_g18_after_2runs.log` | 修后 2/2 绿（连跑 2 次，`--retries=0`） |
| `e2e_fullfile_after.log` | 全矩阵复跑（验 harness 兼容性）：20 通过 / E12 失败 |
| `e2e_e12_repeat.log` | E12 隔离复跑 3/3 通过（证明为 flake） |
