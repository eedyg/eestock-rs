# P5 最终独立验收（真渲染几何 + 配置域 + 持久化 + 测试改写审计）

> 本报告位置：`tester/test/278_p5_final_independent_acceptance_execution.md`
> 证据目录：`tester/evidence/278_p5_final_acceptance/`
> 角色：Tester（独立验收；**未修改任何实现/测试/设计文件**，未分析失败根因后再改动代码）

## 0. 运行环境与口径

| 项 | 值 |
|---|---|
| 仓库 / HEAD | `/home/eestock/workspace/git/eestock/eestock-rs` @ `78eb68d95d149e091c678a5a2a97aecd872f895f`（P5 实现在工作树未提交） |
| 时间 | 2026-09-15 01:09–01:14 (+08:00) |
| 真渲染几何 | chromium（playwright）+ 真实产品组件 + 真实 Tailwind/klinecharts；harness **临时副本** `/tmp/p5acc/harness`（源 = `web/tester/p5-layout-harness`，仅参数化 available/base/heights/写路径） |
| 变异探针 | **内存 transform**（`/tmp/p5acc/vitest.config.ts` 与 harness vite 配置的 `MUT` 插件）⇒ 仓库文件字节未变 |
| 出网 / 写请求 | 全部走 `127.0.0.1:<随机端口>` 静态服务；harness 记录 `nonLocal=0`、`writes` 全部指向**页面内桩**（假服务端）⇒ **0 真实写请求**，未触碰 8081/8082 |
| 线上进程 | PID 3112540（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`）**未触碰**（证据 `hygiene_and_env.txt`：etime 连续增长） |
| 被验实现哈希 | `multiPeriodLayout.ts` = `1b94fa…`、`MultiPeriodChartStack.tsx` = `46f9e6…`、`multiPeriodLayoutDom.test.tsx` = `c9113a…` —— 与 `coder/evidence/278_p5e2_payload_clamp/hashes_and_status.txt` **逐字节一致**（⇒ 本次验收对象与已记录证据同一状态，期间无静默改动） |

## A. 真渲染几何与分配 —— **全部通过**

### A1 默认配置（基准 420 + 3×180 vs 可用 600）—— ✅
- `main-chart`：`clientHeight = 600`、`scrollHeight = 600` ⇒ **0 溢出**（修前 1140/600 = 540px 溢出）。
- 各 pane 真实高度：`15m=264 / 1h=112 / 5m=112 / 1d=112`，**Σ = 600 == 可用**（±1 达标）。
- 基准 KlineChart 真实高 264 == 基准 pane 高 264（±1 达标）；pane 4 / 分隔条 3 / 每 pane 声明高 == 真实高。
- 分配 `reason=shrunk`（D=420+3×180=960 > H=600 ⇒ 走比例缩小，**非** fit）——与 §6.1-2 一致。
- 截图：`tester/evidence/278_p5_final_acceptance/A1_avail600_0overflow.png`；数据 `real_geometry_green.json`。

### A2 D>H 比例缩小 + 下界；再缩 ⇒ 可滚动退化（可观测）—— ✅

| 可用 H | reason | pane 高度 | Σ | main 溢出 | 可滚动可观测 |
|---|---|---|---|---|---|
| 500（440 ≤ H < 960） | `shrunk` | 基准 221 / 卫星 93,93,93 | 500 == H | 0 | `data-mp-stack-scrollable=false` |
| 200（H < 下限和 440） | `min-overflow` | 基准 **200** / 卫星 **80,80,80** | **440**（= 下限和） | 0（不静默裁剪） | `=true` + `overflowY:auto` + 真实 `scrollHeight 440 > clientHeight 200` |
| 1000（D=960 ≤ H） | `fit` | 基准 **460** / 卫星 **180,180,180**（逐值 == 配置 px） | 1000 == H | 0 | `=false` |

- 结论：`D>H` ⇒ 比例缩小且**基准 ≥200 / 卫星 ≥80**；再缩到下限和以下 ⇒ **退化可滚动且可观测**（`data-mp-stack-scrollable="true"` + 真实滚动，非静默裁剪）；`D≤H` ⇒ 卫星按配置 px，基准吸收余量（Σ==可用）。
- 截图：`A2_avail500_shrunk.png`、`A2_avail200_scrollable.png`。

### A3 超宽可用（1800 ≥ 1201）—— ✅ **渲染分配越域 / 载荷被夹**
- 拖前渲染分配基准 = **1260 > 1200**（越域前置成立）；**Σ 渲染分配 == 1800**（不变量未被夹取破坏）。
- 拖 +1 后：渲染分配基准 = **1261 > 1200**（分配**未**被夹），载荷 = `{15m:1200, 1h:179, 5m:180, 1d:180}`
  - 每项 ∈ [80,1200] ✅；逐项 **== clamp(DOM 分配, 80, 1200)** ✅；恰 1 次写 ✅。
- 截图 `A3_avail1800_payload_clamp.png`。

## B. 拖拽 / 持久化 / 域

### B4 拖拽往返 / 域外 / 持久化 / 回滚

| 用例 | 结果 | 实测 |
|---|---|---|
| B4a 往返精确（+20 再 −20） | ✅ | `264/112/112/112 → 284/92/112/112 → 264/112/112/112`（逐值回到初值），Σ 恒 600、main 全程 0 溢出 |
| B4a 上界域外（+1000） | ✅ | 载荷 `{15m:360, 1h:80, 5m:80, 1d:80}` 每项 ∈[80,1200]；Σ=600；卫星停在下限 80 |
| B4a 下界域外（−400） | ✅ | 载荷 `{15m:203, 1h:237, 5m:80, 1d:80}` 每项 ∈[80,1200]；基准 ≥200；Σ=600 |
| B4a 防抖（每次拖拽恰 1 次写） | ✅ | 4 次拖拽 ⇒ writes 0→3→4（每次拖拽恰 1 次，拖拽期间 0 写） |
| B4b 防抖持久化 ⇒ 重载保持 | ✅ | 以载荷 `{15m:360,1h:80,5m:80,1d:80}` 作为「服务端值」重新挂载 ⇒ panes = `360/80/80/80`（逐值 ±1）、Σ=600、0 溢出 |
| B4c 写失败 ⇒ 回滚 | ✅ | 假服务端 400 ⇒ DOM 逐值回到拖前 `264/112/112/112`；0 pageerror（不抛穿页面） |

### B5 边界时序：越域场景「保存成功后再拖」—— ❌ **实测发现缺陷（见 D-5 结论 / 报告 §残余风险 R1）**

超宽（1800）场景实测（`real_geometry_green.json` B5 块）：

| 步 | 渲染分配 | 载荷 | 说明 |
|---|---|---|---|
| 初始 | `15m=1260` | — | 已有 60px 越域 |
| 拖 +1 | `15m=1261` | `15m=1200`（夹取） | **屏幕 1261 / 服务端 1200 分叉 61px** |
| 保存成功回显后再拖 −20 | `15m=1261`、`1h=179`（**均未变**） | `{15m:1200, 1h:199}` | 拖拽对屏幕**零反馈**（回弹，见 R1）；服务端却已变 ⇒ 屏幕/服务端分叉 |
| 「重载」（以**真实服务端值** `{1200,199,180,180}` 重新挂载） | `15m=1241`、`1h=199` | — | 与屏幕上 1261/179 相差 **20px** ⇒ **重载跳变 20px 已实测**（`b5_true_server_reload_jump.txt`：`jumpPx=-20`；用旧值 p1 重载反得 1261，反证屏幕停留在 p1 时代的 props）|

补充复现 ①（600px 常规窗口，`b5b_echo_snapback_repro.json`）——**拖拽后视觉回弹**：
```
③ 连续第二次卫星↔卫星拖拽（基准 props 不变）：
   before = {15m:294, 1h:97,  5m:97, 1d:112}
   during = {15m:294, 1h:112, 5m:82, 1d:112}   ← 拖拽中的真实渲染
   载荷   = {15m:294, 1h:112, 5m:82, 1d:112}   ← 已按防抖持久化（服务端）
   after  = {15m:294, 1h:97,  5m:97, 1d:112}   ← 父层回执 settle 后 DOM **回弹到拖前**
```
即：**拖拽被正确夹取/持久化，但渲染在回执落定后回退**，屏幕值 ≠ 服务端值（该用例每 pane 15px；超宽越域用例整图 20px，最长可达死区 61px）。重载后才会显示拖拽结果。**判 FAIL(5)**（严重度理由见 §残余风险 R1）。

## C. 反向证据（同一环境可复现，≥3 处）—— ✅ 全部必红

| # | 变异（内存文本替换） | 环境 | 结果 |
|---|---|---|---|
| C1 | 去掉比例缩小（`requestedTotal <= H` ⇒ `if (true)`） | **真渲染几何**（同 harness） | A1.1 `scrollHeight 740 > clientHeight 600` ⇒ **140px 溢出**（默认配置场景）；A2[500] 溢出 460px；A2[200] 溢出 760px；`reason=fit`、Σ=740/960 ≠ 可用 ⇒ **溢出/Σ 断言必红**（`reverse_no_shrink_real_geometry.txt`） |
| C1' | 同上 | vitest（A/B/D 测试） | A1/A5/A6/A12/A13/A15/B1/B2/B6/**B8**/D4 共 11 红（`reverse_mut_no-shrink.txt`） |
| C2 | 去掉拖拽域夹取（`sanitizeDragHeight` 不夹） | vitest | D2/D3/**B8** 必红（3 红，`reverse_mut_no-drag-clamp.txt`） |
| C3 | 去掉**载荷**夹取（`toPersistableHeights` 恒等） | vitest | **B14/B15** 必红（`reverse_mut_no-payload-clamp.txt`）：B14 `收到 1261`、B15 `收到 1240`，与 coder 探针 `278_p5e2_payload_clamp/mutation_probe_remove_clamp.txt` 一致 |

## D. 测试改写审计（B8 / B14）—— ✅ 两处均**非放宽**

### D-1 B8（`multiPeriodLayoutDom.test.tsx` B8「连续拖拽合并为一次写入」）
- 原意图保留：`onHeightsChange` **恰 1 次**（`toHaveBeenCalledTimes(1)`）✅；「参数 = 末次结果」由 `payload == 末次分配结果（与 DOM 逐项一致，`toEqual(allHeights)`）` 承接 ✅。
- 新增/加强断言**存在**且更严：Σ == 可用 600；方向（基准增大 / 被压卫星减小）；**每项 ∈[80,1200]**；**被压方恰好触到配置域下界 80**；未拖拽两颗卫星相等；基准 = 可用 − 其它三项（等式推导，不写死数值）。
- 旧数值口径（`payload[15m]==334 / payload[1h]==42`）在域夹取 + Σ==600 下**数学不可满足**（`42 < 80`，且 Σ==600 ⇒ base+1h==376 ⇒ 只要 1h ≥80 则 base ≤296 ≠334）⇒ 该改动是**契约变更后的必要改写，不是放宽**。
- **独立性验证**：把域夹取（`sanitizeDragHeight`）变异掉 ⇒ **B8 变红**（C2）⇒ 新版 B8 仍钉死域契约。

### D-2 B14（超宽 1800）
- 末行主语 `payload` → `dom` 后，两条并列契约**同时被钉住**：
  - 「**载荷被夹**（≤1200）」：② 每项 `≤ HEIGHT_MAX` + ③ `payload == clamp(DOM)`（三处逐项）；
  - 「**渲染分配可越域**（>1200）」：末行 `expect(dom[BASE_PERIOD]).toBeGreaterThan(HEIGHT_MAX)`（前置再现 + 拖后仍越域）。
- 逻辑自洽性核对：绿态下 `payload[base] == 1200`，故末行若仍写 `payload` 则 `1200 > 1200` 为假 ⇒ **B14 在绿态不可能通过** ⇒ 主语必须是 `dom`；该行**新增**了「分配不得为凑载荷域而被夹取」这条约束（原口径没有）⇒ **严格更强**。
- **独立性验证**：去掉载荷夹取 ⇒ **B14 必红**（C3，红在 `≤1200` 断言，行 636）；若实现改为夹取**分配**来凑载荷域 ⇒ 末行 `dom > 1200` 变红 ⇒ 两个方向都被覆盖。
- 授权核对：改动处注释标注「架构裁决 2026-09-15 / P5-D-2 授权最小编辑」；B8 的逐字 diff 见 `coder/evidence/277_p5d2_drag_config_domain_clamp/b8_assertion_diff.patch`。**注意：仓库内无法独立核验授权本身**（无授权记录文件），本次仅核验「改动内容 ↔ 契约」一致性。

### D-3 实现侧自述复核（①）
- `toPersistableHeights` **唯一调用点** = `MultiPeriodChartStack.tsx:219` 的 `onHeightsChange(toPersistableHeights(payloadRef.current))` ⇒ 「载荷出口唯一夹取、且在 `onHeightsChange` 之前」**成立**（`grep` 全量：定义 1 处 + import 1 处 + 调用 1 处）。
- 分配算法 `distributeStackHeights` **未被夹取影响**（A3 实测 Σ==1800 且分配 1261>1200）；域常量与配置面同域：`crates/web/src/dto.rs` `MULTI_PERIOD_HEIGHT_MIN=80 / MAX=1200` ↔ `multiPeriodLayout.ts` `HEIGHT_MIN=80 / HEIGHT_MAX=1200`。

## E. 回归与卫生 —— ✅

| 项 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `web`: `vitest run` | **82 files / 753 passed / 0 failed**（EXIT=0；含 C4 修复） |
| 类型 | `web`: `tsc -b` | EXIT=0（0 错） |
| 文学式门禁 | `./scripts/check-tangle.sh` | EXIT=0「design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）」（tangle 全部在 `/tmp/check-tangle.*` 沙箱内跑） |
| P1–P4 / ①②③④ / dcap 契约 | 全量套件内对应文件 | 全绿（无回归） |
| 线上进程 | `ps -p 3112540` | 未触碰（etime 连续 13h20m+） |
| 写请求 | harness 记录 | **0**（`nonLocal=0`；`writes` 全为页面内桩） |
| git 卫生 | `git status --porcelain` / `git diff --cached` | staged **空**；tracked 改动仅 4 个：`design/15-multi-period/02-spec.md`（§6.1–6.4）+ `DashboardPage.tsx`（写路径/去除基准 `heightPx`）+ `MultiPeriodChartStack.tsx`（栈/pane/分隔条/拖拽/持久化）+ `multiPeriodStore.ts`（`setHeights`）；新增未跟踪：`multiPeriodLayout.ts`、`multiPeriodLayoutDom.test.tsx` 等测试 + `web/tester/*` harness ⇒ 归因清楚（P5 手写前端 + 新测试 + 设计文档） |
| 临时实例 | `pgrep -af "run.mjs|b5b.mjs|vite build"` / `ss -ltnp \| grep node` | 空 / 0（随机端口实例与浏览器全部已拆） |

## 残余风险（含严重度理由）

- **R1（阻断级，判 FAIL(5)）——「卫星高度 props 变化被忽略 + 回执后视觉回弹」**：`MultiPeriodChartStack.tsx` 的 `specPanes = useMemo(..., [basePeriod, baseHeight, periodsKey])` **未包含卫星高度**（`satellites[i].height`）。当父层回写只改卫星高度（基准载荷因夹取不变）时，组件**继续用旧卫星请求值**分配 ⇒ 拖拽在 ~300ms 后**回弹**到拖前布局（600px 常规窗口即可复现，`b5b_echo_snapback_repro.json` ③），且**屏幕值与服务端值分叉**（最长 = 越域死区 61px，重载后才显示拖拽结果）。同时违反 §6.3「服务端配置（唯一权威）→ 父层 props → 组件」（跨标签页/终端改卫星高度在该会话内被静默忽略，仅重载/周期列表或基准高度变化后才生效）。理由：用户可感知（拖了又弹回）、且屏幕与服务端数据分叉，非纯视觉瑕疵。
- **R2（中）——超宽越域死区（≤61px）**：可用 ≥1201px 时 `payload = clamp(分配)`，屏幕分配可比持久化值最多大 61px。实测（1800px）：屏幕 `15m=1261` / 服务端 `15m=1200`；真正按服务端值重载 ⇒ 1241，相对拖后屏幕 1261 **跳变 20px**（`b5_true_server_reload_jump.txt`）。属设计裁决（§6.2 载荷恒合法）的已知取舍，不单独判 FAIL，但建议在 §6.2 显式记为已知偏差（当前 §6.2 未写「屏幕与载荷可相差 ≤(BASE_MAX?)」）。
- **R3（低）——快照断言依赖 jsdom 无布局引擎**：`availableHeight` 注入口（测试）与真实 `ResizeObserver` 路径并存；本次真渲染已覆盖 RO 路径（harness 不传 `availableHeight`），测试与真实路径一致性好，风险低。
- **R4（信息）——授权不可自证**：B8/B14 的架构师授权仅能从实现/证据注释追溯，仓库内无独立授权记录。

## 最小修正建议（**未实施**，仅建议）
1. R1：把卫星高度纳入 `specPanes` 的 memo 键（例如 `const satSig = satellites.map((s) => `${s.period}:${s.height}`).join('|')`，加入 deps）——一处依赖即可修，无接口变更；回归重点：B8/B9/B13/B14/B15 + `multiPeriodHeightsPageContract`。
2. R2：在 `02-spec §6.2` 补一句已知偏差（屏幕分配 vs 持久化载荷可差至 clamp 死区 61px；`Σ==可用` 优先），或把「回显后以服务端值为准」的口径显式写入 §6.3。
3. R4：把「B8/B14 授权」落到 `design/15-multi-period/03-test-plan.md` 的变更记录或 `tester/` 旁边的授权证据文件，便于下次独立验收自证。
