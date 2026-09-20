# ADR-028 D4.1 复验 —— 执行报告（回归规格部分）

- 本报告路径：`tester/test/304_adr028_d41_features_verify_execution.md`
- 主报告（含判词与逐项证据）：`tester/evidence/20260920_adr028_features_verify/report.md`
- 设计报告：`tester/design/304_adr028_d41_features_verify_design.md`
- 时间：2026-09-20（Asia/Shanghai）；commit `aa5444eb98e2e4876e8d6a3fb414c87ca08966d2`（未提交工作树 + 实现方已 `git add` 的改动）
- 真身：`http://localhost:8081`（`E2E_BASE_URL` 默认 baseURL）

## 1. 总览

| # | 套件 | 命令（均加 `timeout`） | 结果 |
|---|---|---|---|
| 1 | 类型检查 | `cd web && npx tsc -b` | **exit 0** |
| 2 | 回归（既有） | `E2E_BASE_URL=http://localhost:8081 ADR028_E2E_OUT=…/raw/spec_out/window-sync npx playwright test e2e/adr028-window-sync.e2e.ts --workers=1 --retries=0` | **6/6 passed**（23.4s） |
| 3 | 回归（本车道保有 v2） | `E2E_BASE_URL=http://localhost:8081 ADR027_ALIGN_OUT=…/raw/spec_out/axis-align-probe npx playwright test e2e/adr028-axis-align-probe.e2e.ts --workers=1 --retries=0` | **2/2 passed**（43.4s） |
| 4 | 新功能复验（自有规格） | `E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0` | **9 passed / 1 failed**（1.1m） |
| 5 | 离线像素复算 | `python3 tester/evidence/20260920_adr028_features_verify/raw/pixel_analyze.py` | 完成（与页面侧读数一致） |
| 6 | 变异反证 ×3 | 见主报告 §6（临时 `dist-mut` + preview :4175） | M1/M2/M3 **均红**；恢复后 bundle sha256 与实现方逐字节一致 |
| 7 | 实现方单测（独立复跑单文件） | `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run src/features/workbench/adr028FocusHighlight.test.tsx --maxWorkers=1` | **6/6 passed**（149ms） |

- 崩溃/核心转储：**无**（无任何 playwright 进程异常退出、无 core dump 文件）。
- 退出码：套件 2/3/5/6 为 0；套件 4 为 1（**T7 红**，非 harness 问题，是真实回归发现）。
- 覆盖：本波只跑与本交付相关规格（自建复验规格 + `adr028-window-sync` + `adr028-axis-align-probe` v2），未跑全量 e2e（资源纪律）。

## 2. 套件 4（自建复验规格）逐用例

| 用例 | 结果 | 摘要 |
|---|---|---|
| T0 真身锚定（bundle sha256） | 绿 | 被服务 bundle == `web/dist/assets/index-DhgvwmsX.js`（`8d6022e1…44fb`） |
| T1 醒目化结构（store） | 绿 | 44 个 `fillDot`；除标记/高亮外无其它 overlay；同 bar 双笔 stack 0/1、y 差 11px、标签互异 |
| T2 标签像素（ink 覆盖率） | 绿 | 覆盖率 0.842、span 红墨 234（阈值 0.6 / 120） |
| T3 focus 滚动 | 绿 | scrollTop 2391→40；锚点在滚动容器内且 K 线整体在视口内 |
| T4 精确到笔高亮 + 3s 回常态 | 绿 | store 高亮恰 1 条；白簇恰 1 个、质心 Δ≤0.7px；两次点击质心差 11.4px；3s 后 0 簇 |
| T5 曲线竖线 | 绿 | 4 视图、ts 唯一；跨 3s 保留；下一次跳转更新；全览清 0 |
| T6a unmatched（注入） | 绿 | `data-state=unmatched`、文案非空、窗口仍跳 |
| T6b unrecorded（注入） | 绿 | `data-state=unrecorded`、文案非空、窗口仍跳 |
| T6c loading（注入延迟 14s） | 绿 | 未到位期间显式「加载中」+ 标记 0；L2 不可达（分支 UI 不可达）；放行后高亮恢复 |
| **T7 回归：控制条可点击性** | **红** | L2 跳转后 K 线容器溢出卡片 **27px**，`全览`/`历史回退` 按钮中心命中 `canvas` ⇒ 真实 `click()` 超时；L1 跳转（提示消失）后溢出 −1px、按钮可点 |

**失败用例（1 条）**

| 用例 | 错误信息（摘） | 崩溃/core |
|---|---|---|
| T7 回归：L2 跳转后「全览/历史回退」必须仍可点击 | `Error: K 线容器不得溢出卡片（溢出即盖住下方控制条）: expect(received).toBeLessThanOrEqual(expected) Expected: <= 1 Received: 27`（`e2e/adr028-features-verify.e2e.ts:935`） | 无 |

堆栈：`web/e2e/adr028-features-verify.e2e.ts:935` → `at …`（playwright worker，非崩溃）；playwright 落图 `web/e2e/artifacts/test-results/…-chromium/test-failed-1.png`（该目录为 gitignore）。

## 3. 结论

- 指定回归项（window-sync 6 用例、探针 v2 2 用例、`tsc -b`）**全绿**。
- 但本波引入的 **T7 回归红**（高亮提示换行 ⇒ K 线卡片溢出 ⇒ 画布遮挡控制条按钮）已记为**阻断项**，总判词见主报告首行。

## 4. 纪律

未改生产代码（三次变异均已逐字节复原、`git diff` 工作区 0 行）；未 `git add`/`commit`；未覆盖既有证据目录（两个既有规格的产物目录已改写到本复验 `raw/spec_out/`）；结束核验 `pgrep -f '[v]ite preview'` 空、chromium 进程 0。
