# 执行报告 — 问题①/② 独立验收（阶段 3 补跑，真实渲染）

- **报告自身路径（self-location）**：`tester/test/048_issue1_issue2_acceptance_execution.md`
- **测试设计**：`tester/design/015_issue1_issue2_acceptance_design.md`
- **证据目录**：`tester/evidence/048/`
- **执行时间**：2026-09-13 21:08 ~ 21:16 CST
- **仓库根 / commit**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `5a016cdb2cd593301ae517c65b70400cb58a2f14`
- **线上实例**：8081/8082 PID **2029836** —— 未 kill、未重启、未改其 `web/dist`（mtime 仍 20:32:08）、全程只读 GET
- **本报告性质**：执行真实渲染验收 + 单测/门禁回归 + 反向证据。**未改任何产品代码/接口/架构**；未 `git add/commit/stash`；**仓库内未跑 tangle**；E2E 只在临时端口（18081/18083）跑，已收尾拆除
- **无崩溃/无 core dump**（全部 chromium 正常退出；无 core 文件产生）

---

## 0. 结论摘要

| 项 | 结论 | 关键证据 |
|---|---|---|
| ① 骨架重复线 | **PASS** | 锚点 `borderTopWidth==0px`；主图区全宽水平线只来自 klinecharts；拖高 VOL 后线随 pane 移动；DCAP 关态 candle↔VOL 边界仍在（§1） |
| ① 反向证据 | **PASS（断言变红）** | 注入同位置 `border-top` ⇒ 锚点 1px + stray 线 @ 0.8×main-h 同时变红（§1.3） |
| ② 0 线常驻可见 | **PASS** | 两形态 + 真实数据 + 数据不足段：Y 轴含 0、`y0 == yAxis.y(0)`、canvas 在 y(0) 行绘出 `#76808F` 虚线（§2） |
| ② 反向证据 | **PASS（断言变红）** | `/tmp` 变体去掉 `zero` figure ⇒ figKeys 掉 `zero`、`#76808F` 像素归 0，5 条断言红（§2.6） |
| 回归（P3 契约） | **PASS** | `vitest run` 56 files / **562 tests 全绿**；`tsc -b` exit 0；figures s/m/l 仍在、precision 5、副图 paneId≠candle_pane、断线/降级单测通过（§3） |
| 生成物一致性 | **PASS** | `check-tangle.sh` exit 0；独立沙箱 `entangled tangle -f` 重生成后 `DashboardGrid.tsx`/`dcap.ts` 与仓库**逐字节相同**（§4） |
| 工作树/残留 | **PASS** | 无 staged；tracked 改动恰 6 文件；crates/migrations/config 零改动；临时端口已拆（§5） |
| VERDICT | **PASS** | |

---

## 1. 问题① — 真实渲染（临时实例 18081 = 当前源码构建 + 真实 klinecharts 10.0.3）

自建断言脚本 `accept_issue1.mjs`：**18/18 passed**（`tester/evidence/048/issue1-results.json`）。

### 1.1 pane 列表 / 分隔线计数（`getPaneOptions()` + DOM 实测）

默认态（DCAP 关；`main-chart` h=724、w=1299.31）：

| pane id | 配置高度 | DOM top/高 | indicator 数 | indicator |
|---|---|---|---|---|
| `candle_pane` | 100（弹性） | 0 / 597 | 1 | MA |
| `indicator_pane_…_7` | 100 | 598 / 100 | 1 | VOL |
| `x_axis_pane` | 100 | 698 / 26 | 0 | —（X 轴 pane） |

- 内容 pane 数 = 2，`x_axis` 除外；**分隔元素 = 1 = 2 − 1** ✅
- `[data-region="sub-chart"]`：`borderTopWidth='0px'`、`borderTopStyle='solid'`（preflight）、`borderTopColor=rgb(229,231,235)`（无宽度⇒不绘制）、`background=rgba(0,0,0,0)`、top=579.2（=0.8×724）、h=144.8
- **主图区全宽水平线清单**：仅 `DIV[klinecharts-separator]` @ top 597、bg `rgb(221,221,221)`、w 1299 ⇒ **stray 为空** ✅

DCAP 开启态：内容 pane 3（candle/MA、VOL、DCAP）、分隔线 **2** ✅；DCAP 关闭：回 3 pane / 1 分隔线、无空 pane ✅。

### 1.2 用户场景（拖第一条分隔线向上 120px）

| 量 | 拖前 | 拖后 |
|---|---|---|
| 分隔线 top | 597 | **487**（−110，随 pane 边界上移） |
| candle pane 高 | 597 | 487 |
| VOL pane 高 | 100 | **210** |
| 分隔线落点 vs pane 交界 | candle底=597, VOL顶=598（±1） | candle底=487, VOL顶=488（±1）✅ |
| stray / 锚点 borderTopWidth | 空 / 0px | **空 / 0px** ✅ |

⇒ 拉高 VOL 后**没有**「不随 pane 移动」的横线；也**没有**任何跨 pane 的僵线。（对照：反向注入的那条线恒在 0.8×main-h，见 §1.3。）

**DCAP 关态边界仍在**：唯一分隔线恰位于 candle pane 底与 VOL pane 顶（±2px）⇒ 删除的是**重复**的那条骨架线，不是唯一边界 ✅
（截图：`issue1-default.png`、`issue1-after-drag.png`、`issue1-dcap-on.png`）

### 1.3 反向证据（运行期注入同位置 border-top；临时实例，不动仓库）

注入 `[data-region="sub-chart"]{border-top-width:1px !important; border-top-style:solid !important; border-top-color:#e5e7eb !important}` 后：

```
锚点 borderTopWidth: 0px → 1px                    （①-1 断言红）
stray 线: [] → [{tag:"DIV[data-region=sub-chart]", kind:"border-top 1px solid rgb(229, 231, 235)", top:579.2, w:1299.31}]（①-4 断言红）
```

579.2 = 0.8 × 724，与诊断车道 `tester/evidence/047/` 的线上实测一致（旧缺陷线的位置/颜色/来源完全复现）。
⇒ 断言对「恢复 border-t」敏感，非假绿。截图：`issue1-reverse-injected.png`。

---

## 2. 问题② — 0 线真实渲染（临时实例 18081）

自建断言脚本 `accept_issue2.mjs`（真实构建）：**18/18 passed**（`issue2-results-real.json`）。
`figures.key == ['s','m','l','zero']`、`precision == 5`；每条 bar `zero === 0`（`resultLen` 与 `dataList` 一致，182 根）。

| 形态 | dataMin | dataMax | Y 轴 from | Y 轴 to | y(0)=`yAxis.convertToPixel(0)` | `convertToPixel({value:0})` | pane h | `round(y0)` 行 `#76808F` 像素 | 虚线周期(px) |
|---|---|---|---|---|---|---|---|---|---|
| 真实数据（s>0、m/l<0，跨 0） | −0.03002 | 0.01916 | −0.02245 | 0.02525 | 53 | 53 | 100 | **435** | {1,6} |
| 形态①单调上行（三线全正） | **+0.00888** | 0.13503 | **−0.01163** | 0.13960 | 92 | 92 | 100 | **435** | {1,6} |
| 形态②先降后升（跨 0） | −0.11250 | 0.12242 | −0.11188 | 0.16502 | 60 | 60 | 100 | **437** | {1,4,6} |
| 数据不足（5 根，三线全 null） | —（全 null） | — | −0.000048 | +0.000056 | 54 | 54 | 100 | **18** | {1,6} |

- **0 线 y 坐标 == pane 内 y(0) 映射**：4 形态均 `convertToPixel({value:0},{paneId}).y === getYAxes({paneId})[0].convertToPixel(0)`，且 `0 ≤ y0 ≤ paneH` ✅
- **0 线始终可见（真实绘制）**：`round(y0)` 行的主色恰为 `(118,128,143,255)` = **`#76808F`**，并呈周期性虚线（on≈3px / off≈5px，标称 `dashedValue [4,4]`）✅
- **形态①（三线全正）**：数据 min=+0.00888>0，而 Y 轴 `from=−0.01163 ≤ 0` ⇒ **0 被纳入标度**、0 线在 pane 内（y0=92）且像素可见 ⇒ 若无 `zero` figure，标度将不含 0（见 §2.6）✅
- **数据不足**：三条数据线全 `null`（断线），但 `zero` 仍每根 = 0，0 线仍绘制在 y(0)（18px，仅覆盖 5 根 bar 的宽度）✅
- **DCAP 关闭态**：`getIndicators()` 无 `DCAP`、无 DCAP pane ⇒ 无 0 线 ✅

截图：`issue2-real.png` / `issue2-all-positive.png` / `issue2-cross-zero.png` / `issue2-insufficient.png`；0 线放大裁剪：`crop-zero-*.png`、`zero-insufficient-fullpane.png`。

### 2.6 反向证据（`/tmp` 变体：figures 去掉 `zero`；第二个临时实例 18083）

变体构建产物 `dist-nozero` 的 `figKeys == ['s','m','l']`。同一脚本 `EXPECT=nozero`：**13/18 passed，5 条红**：

| 变红的断言 | 原因 |
|---|---|
| ②-1 `figKeys = s/m/l/zero` | 无 `zero` figure |
| ②-6 真实数据：y(0) 行 `#76808F` 像素 > 100 | 像素计数 **0** |
| ②-10 形态①(全正)：像素 > 100 | 像素计数 **0** |
| ②-14 形态②(跨 0)：像素 > 100 | 像素计数 **0** |
| ②-17 数据不足：含 0 且 0 线绘制 | 像素计数 **0** |

⇒ 断言对「去掉 zero figure」敏感；0 线的可见性**由渲染像素**（而非配置声明）判定，非假绿。
（注：无 `zero` 时 `calc` 仍返回 `zero:0`（手写层就地扩展，`DcapValues` 契约未变），故 ②-2「result.zero 恒 0」在变体下仍绿——**可见性**才是判据。）

---

## 3. 回归（P3 契约不得被破坏）

| 命令 | 结果 |
|---|---|
| `cd web && npx vitest run` | **56 test files / 562 tests 全通过**（其中 `dcapIndicator.test.ts` 19、`dcapInsufficient.test.ts` 4、`dcapMirror.test.ts` 11、`dcapWiringP3.test.tsx` 13、`dcapWarmupP3.test.ts` 5 均绿（定向复跑 5 files / 52 tests 全绿）） |
| `cd web && npx tsc -b` | **exit 0**（无输出） |
| 真实渲染 | DCAP 副图 `paneId != candle_pane`（§1.1：DCAP pane = `indicator_pane_…`）；`figures s/m/l` 仍在 + precision 5（§2）；数据不足断线/异常降级见单测 `dcapIndicator.test.ts`（`bar.close` 抛异常、非数组、非法 calcParams 均不抛且零线仍在） |
| 仓库既有红测试 | `E2E_BASE_URL=http://127.0.0.1:18081 npx playwright test e2e/dashboard-pane-separator.e2e.ts --retries=0` → **1 passed (5.0s)**（原诊断阶段为 RED） |

---

## 4. 生成物与事实源一致性

| 检查 | 命令/方法 | 结果 |
|---|---|---|
| 仓库门禁 | `./scripts/check-tangle.sh` | **exit 0**：`✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` |
| 独立沙箱重生成（自建，不复用门禁脚本） | `mktemp` 沙箱只拷 `entangled.toml` + `design/`，`entangled tangle -f`（沙箱内允许；仓库内未跑） | `tangle_exit=0` |
| `DashboardGrid.tsx` 逐字节 | `cmp` 沙箱重生成 vs 仓库 | **IDENTICAL**；sha256 `a6401df1…e91432`（两侧相同） |
| `dcap.ts` 逐字节 | 同上 | **IDENTICAL**；sha256 `521c2696…566fb1f`（两侧相同） |
| `02-spec.md`/`03-test-plan.md` 的 `file=` 块未被改动 | 自建脚本提取 HEAD 与工作树两侧 `file=` 代码块做逐字节比较 | `02-spec.md`：旧/新块均 `{dcap.js, dcap.ts}`，**changed blocks: NONE**；`03-test-plan.md`：无 `file=` 块 |
| `dcap.ts` 工作树零改动 | `git diff -- web/src/features/indicators/dcap.ts` | 空（零改动） |

沙箱 tangle 日志：`tester/evidence/048/sbx-tangle.log`。

---

## 5. 工作树 / 残留 / 归因

### 5.1 staged
`git diff --cached --name-status` → **空**（无 staged 文件）。

### 5.2 tracked 改动逐条归因（`git diff --name-status`，恰 6 条）

| 文件 | 归因 |
|---|---|
| `design/06-web/01-dashboard.md` | 问题①：删 `[data-region="sub-chart"]` 锚点的 `border-t`（事实源，散文/类名） |
| `web/src/layouts/DashboardGrid.tsx` | 问题①：tangle 生成物同步（沙箱重生成后拷回；逐字节一致，见 §4） |
| `design/14-dcap-indicator/02-spec.md` | 问题②：§6 表格/散文（三数据 figure + 0 参考线）——`file=` 块未改 |
| `design/14-dcap-indicator/03-test-plan.md` | 问题②：T8-3/3b + 跨面板布局项（散文/断言描述）——无 `file=` 块 |
| `web/src/features/indicators/dcapIndicator.ts` | 问题②：手写层第 4 figure `zero`（就地扩展 `{...values, zero:0}`） |
| `web/src/features/indicators/dcapIndicator.test.ts` | 问题②：新增 zero figure/0 线断言 |

### 5.3 未触碰确认
- `git diff --name-only -- crates/ migrations/ config/ scripts/` → **空**（ABI/引擎/ExecutionPolicy/api-config/后端零改动）
- `web/src/features/indicators/dcap.ts`（CORE 镜像生成物）→ **零改动**（§4）
- 线上 `web/dist` 未被覆盖（mtime 20:32:08 不变）⇒ 线上 8081 服务的仍是旧构建，未被本轮构建替换

### 5.4 本轮新增（untracked，tester 侧）
- `tester/design/015_issue1_issue2_acceptance_design.md`（本设计）
- `tester/test/048_issue1_issue2_acceptance_execution.md`（本报告）
- `tester/evidence/048/**`（harness + JSON + 截图 + 沙箱日志）
- 说明：`web/e2e/dashboard-pane-separator.e2e.ts`、`tester/design/014_*.md`、`tester/evidence/047/`、`tester/test/047_*.md`、`coder/report/160_*.md` 为本轮**之前**（诊断/修复阶段）已存在，非本轮新增。

### 5.5 临时端口/进程收尾
- 临时实例：18081/18091（验收构建）、18083/18093（nozero 反向变体）→ **已 kill**（2086038、2091088）
- 复核：`ss -ltn` 无 18081/18083/18091/18093；`ps` 仅剩线上 PID 2029836；无 headless chromium 残留；`/tmp/accept` 已删除
- 线上 8081/8082：PID 2029836 未动，`curl / → 200`

---

## 6. 未做 / 边界

- 未评价 DCAP 信息量/研究结论（问题② 只验观感契约）
- 未重启/未改线上；未改用户配置；仓库内未跑 tangle；未 `git add/commit/stash`
- 覆盖度工具未启用 ⇒ 无覆盖率数字（本报告不含 coverage summary）
- 未改修复车道的既有脚本/结论，也未以其为唯一依据（关键断言全部自建，另加两组反向证据）

---

## 7. 最小修正建议

- **无阻塞项**（VERDICT: PASS）。以下为可选、低优先的观察（**不在本次范围**，勿顺带改）：
  1. 反向证据显示：只要在 `sub-chart` 锚点上再叠任何 `border/背景`，就会在 0.8×main-h 处产生不随 pane 移动的僵线 ⇒ 建议把「该锚点不得绘制线」写进 region 契约注释（设计文档已删 utility，但未显式禁止回归）。
  2. 数据不足段的 0 线只覆盖已绘 bar 的宽度（本实测 18px）；这是 klinecharts 按数据范围绘制的自然结果，非缺陷，无需处理。

---

## 8. 产物清单

| 路径 | 内容 |
|---|---|
| `tester/design/015_issue1_issue2_acceptance_design.md` | 本阶段测试设计 |
| `tester/test/048_issue1_issue2_acceptance_execution.md` | 本报告 |
| `tester/evidence/048/issue1-results.json` | 问题① 18 条断言 + 5 个状态原始数据 |
| `tester/evidence/048/issue2-results-real.json` / `issue2-results-nozero.json` | 问题② 正/反向断言与像素数据 |
| `tester/evidence/048/*.png` | 真实渲染截图 + 0 线裁剪 |
| `tester/evidence/048/{kc-spy.ts,dcapIndicator-nozero.ts,vite.*.config.ts,accept_*.mjs,*.mjs,*.toml}` | harness 源码（可复跑） |
| `tester/evidence/048/sbx-tangle.log` | 独立沙箱重生成日志 |

**末行结论：VERDICT: PASS**
