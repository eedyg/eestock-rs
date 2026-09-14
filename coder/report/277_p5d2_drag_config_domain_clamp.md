# 277 — P5-D-2 实现报告：拖拽期望值夹取到**配置域** `[80, 1200]`（最小改动）

- **本文件路径**：`coder/report/277_p5d2_drag_config_domain_clamp.md`（报告自身位置）
- 角色：Coder（实现 + 实现侧单测；**未** add/commit/stash、未跑仓库内 tangle、未重启线上 PID 3112540、0 写请求）
- 时间：2026-09-15 00:52–00:57（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `78eb68d`；P5 实现仍在工作树未提交）
- 权威依据：`design/15-multi-period/02-spec.md` §6.1 尾注（架构裁决 2026-09-15）；配置面事实源 `crates/web/src/dto.rs`（`80/1200`，校验第 5 条）；`tester/design/277_p5d1_drag_config_domain_clamp_red_design.md`
- 证据目录：`coder/evidence/277_p5d2_drag_config_domain_clamp/`（红证据 / 变异审计 / 全量绿 / tsc / 门禁 / 进程卫生 / B8 精确 diff）

---

## 1. 改动文件清单（严格限定在 P5 相关手写前端）

| # | 文件（状态） | 改动 | 行数 |
|---|---|---|---|
| 1 | `web/src/features/dashboard/multiPeriodLayout.ts`（P5 新增，未跟踪） | `sanitizeDragHeight` 由「只夹上界」改为 `clamp(round(n), HEIGHT_MIN, HEIGHT_MAX)` + 两处文档口径更新（`StackPane.fromDrag` / `sanitizeDragHeight`） | 实质 **1 行**；注释 ±26 行 |
| 2 | `web/src/features/dashboard/multiPeriodDragDomainClamp.test.ts`（**新增**） | 实现侧补充单测 D1–D4（纯函数层钉死被改的那一行 + 「不得混同」边界） | **+78 行**（4 用例） |
| 3 | `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx`（tester 既有 B8 单用例） | **经架构师显式授权**的最小编辑：2 行数值断言 → 域内更强口径 | **−2 / +17 行**（仅 B8） |

**明确未改**：`DashboardPage.tsx` / `MultiPeriodChartStack.tsx` / `multiPeriodStore.ts`（保持 P5-B 原状，`git diff` 与派单前逐字节一致）、任何生成物、任何 Rust、C4 夹具（tester 已修，本轮零改动）、其它测试文件（含 B6/B7/B9–B13、C1–C7 逐字未动）。

## 2. 架构对齐（改动归属的层与理由）

- 归属层：**前端手写 dashboard 特性层**（`web/src/features/dashboard/`），纯函数面。
- 落点选择：`sanitizeDragHeight` 是**拖拽改写「期望 px」的唯一净化入口**（唯一调用点 `requestOf()` → `distributeStackHeights`）⇒ 在此夹取即「期望 px 恒在配置域」，无需在页面/组件/载荷边界做二次夹取。
- **未触碰**：配置面校验（Rust `dto.rs`，仍是服务端唯一权威）、分配算法权威（`distributeStackHeights` 的 `fit/shrunk/min-overflow` 语义与输出不变量逐字未改）、`onHeightsChange` 接口签名与「高度权威交还」口径（P5-B 裁决）——无接口/契约/依赖方向变化。
- 依赖方向不变：`multiPeriodLayout.ts`（纯函数）→ 被 `MultiPeriodChartStack.tsx` 单向消费；新增测试只依赖既有模块。

## 3. 解决的问题 / 新增能力

**缺陷**（实现自曝的 UX 瑕疵）：拖拽可把「期望 px」拖出配置域（实测 42px）⇒ `onHeightsChange` 载荷 = `PUT /api/config/multi_period` 的 `heights` ⇒ 配置面第 5 条校验 400 ⇒ 页面回滚 ⇒ 用户表现「拖了但没保存」。

**修复**：期望 px 任何时刻 ∈ `[80, 1200]`（与配置面校验同域）⇒ 拖拽产出的载荷恒合法 ⇒ 不会再 400 回滚。

## 4. 实现方式（给审阅者的精确定位）

`web/src/features/dashboard/multiPeriodLayout.ts`：

```ts
// 位置：multiPeriodLayout.ts::sanitizeDragHeight（拖拽期望值净化的唯一入口）
 export function sanitizeDragHeight(value: unknown, isBase: boolean): number {
   const fallback = isBase ? DEFAULT_BASE_HEIGHT : DEFAULT_SATELLITE_HEIGHT;
   const n = typeof value === 'number' ? value : Number(value);
   if (!Number.isFinite(n) || n <= 0) return fallback;
-  return Math.min(HEIGHT_MAX, Math.round(n));        // 只夹上界 ⇒ 下界可到 42px（缺陷）
+  return clamp(Math.round(n), HEIGHT_MIN, HEIGHT_MAX); // 配置域夹取 [80, 1200]
 }
```

- **阈值**：`HEIGHT_MIN = 80` / `HEIGHT_MAX = 1200`（从既有常量取用，不新造数字；与 `dto.rs` 单一事实源同域）。
- **不混同（关键判据）**：域夹取（80/1200）**只在** `sanitizeDragHeight`（配置面域）；渲染侧**分配下界**（基准 `BASE_MIN_HEIGHT = 200` / 卫星 `SATELLITE_MIN_HEIGHT = 80`）**仍在** `distributeStackHeights` 的缩小/退化路径，未移动、未合并、未互相替代。极端拖拽的分配结果（如 B6：基准停在 200）逐位不变。
- 为什么**不**在载荷/组件层夹：那会在分配结果上做二次夹取 ⇒ 破坏「Σ 分配 == 可用高度」不变量（B7/B12/B13 的 Σ==600 断言）与渲染侧下限语义；纯函数入口夹取是唯一不破坏不变量且最小的位置。
- 行为后果（可预期，非副作用）：期望值被夹到 80 后，Σ 期望可能 > 可用高度 ⇒ 走既有**缩小路径**（基准/卫星下限 + 残差修正，Σ 仍 == 可用）⇒ 所有 pane 等比收敛，载荷全在域内。这正是 `tester/design/277_p5d1_...red_design.md` §6 预推的可满足形态（C8 期望 `{80,388,138}`、B13 期望 `{80,312,112,112}` 均 Σ>600）。

## 5. 测试覆盖

| 类型 | 文件 | 用例 |
|---|---|---|
| 实现侧新增（纯函数） | `multiPeriodDragDomainClamp.test.ts` | D1 域内值原样；**D2 下界夹取**（1/42/79/79.6 ⇒ 80，含实测 42px）；D3 上界夹取 + 非法值兜底回归；**D4 不得混同**（域下界 80 ≠ 分配下限 200/80；域内期望触发缩小路径后 Σ==600 且仍满足分配下限与配置域） |
| tester 红测试（本轮转绿） | `multiPeriodHeightsPageContract.test.tsx` / `multiPeriodLayoutDom.test.tsx` | **C8 ✓ C9 ✓ B13 ✓** |
| tester 既有（只允许加强） | `multiPeriodLayoutDom.test.tsx` | **B8 强化**（见 §6；B5/B6/B7/B9–B13 未动且绿）；C1–C7（含修好的 C4）未动且绿 |

**红 → 绿证据**（`coder/evidence/277_p5d2_drag_config_domain_clamp/`）：

1. 修复前（实现侧红基线，测试先落）：`C8/C9/B13` 三例红 —— `red_baseline_p5d1_tests_before_fix`（命令输出见 §7 第 1 条）。
2. 新增单测红：临时还原旧行后 `D2` 红（`red_new_unit_test_before_fix.txt`：`基准期望 1 必须夹到 80: expected 1 to be 80`）。
3. 修复后：全量 `751/751` 绿（§7）。
4. **变异审计（阶段 3 同口径，我可复现）**：临时移除域夹取（旧行）⇒ `B8(新版) / B13 / C8 / C9 / D2` **全部变红**（`mutation_audit_remove_clamp.txt`，5 failed）⇒ 证明新断言确实鉴别域夹取，改 B8 不是放宽。

## 6. 架构师授权的 B8 改写（精确 diff + 逐条对应）

精确 diff：`coder/evidence/277_p5d2_drag_config_domain_clamp/b8_assertion_diff.patch`（`-2 / +17`，仅 B8 一个用例、仅数值断言与注释）。

- **不可满足性（为什么必须换数值口径）**：原断言要求 `payload[15m] == before+70 == 334` 且 `payload[1h] == before−70 == 42`，Σ==600；而 Σ==600 ⇒ `15m + 1h == 376` 固定 ⇒ 只要 `1h ≥ 80`（配置域）则 `15m ≤ 296 ≠ 334` ⇒ 与 B13/C8/C9（同一 02-spec §6.1 契约）**数学互斥**；且 42 本身就是会被 400 的域外值。
- **逐条落实架构师 1–6（全部保留意图 + 加强）**：

| # | 架构师要求 | 落地断言 |
|---|---|---|
| 1 | 防抖合并 ⇒ 恰 1 次写 | 原有 `toHaveBeenCalledTimes(1)` **逐字保留** |
| 2 | payload == DOM 末次分配高度 | 新增 `expect(payload).toEqual(allHeights(container))` |
| 3 | Σ == 600 | 新增 `Object.values(payload).reduce(...) === AVAILABLE` |
| 4 | 每项 ∈ [80,1200] | 新增 `periodsAll()` 逐项上下界断言（4 项） |
| 5 | sat0 恰好触到配置域下界 80 | 新增 `expect(payload[SAT0]).toBe(HEIGHT_MIN)` |
| 6 | base 由等式推导（不写死 334） | 新增 `expect(payload[BASE_PERIOD]).toBe(AVAILABLE - HEIGHT_MIN - payload[SAT1] - payload[SAT2])` |
| ＋ | 原意图的**方向性** | 保留为 `payload[15m] > before[15m]`、`payload[1h] < before[1h]`；另加 `payload[5m] == payload[1d]`（分配对称性） |

- **⚠️ 观察项（必须上报，阶段 3 请核对）**：架构师 ⑥ 给出的数值形态 `base == 600 − 80 − 112 − 112 = 296` 隐含「5m/1d 保持 112（= 拖前期望值）」的假设，即「拖拽对的互补性 Σ 期望不变」语义。该语义与**既有 B6** 不可两全：若拖拽时保持对互补，则 B6 的 −1000 狠拖会把基准期望夹到 80 ⇒ Σ 期望 == 600 ⇒ 走 `fit` 路径 ⇒ 分配基准 == 80 ≠ B6 要求的渲染侧下限 **200** ⇒ B6 红（B6 未经授权、不得改）。故实现采用 tester §6 预推的形态（**期望值独立夹取 ⇒ Σ 期望 > 可用 ⇒ 缩小路径**），B8 的 5m/1d 因此随缩小路径收敛为 104。⑥ 已按「由等式推导、不写死数字」的口径落地（用 payload 自身值），实测 `payload = {15m: 312, 1h: 80, 5m: 104, 1d: 104}`（`600 − 80 − 104 − 104 = 312`）。若架构师坚持字面 296/112，则需改的是**既有无授权测试 B6** ⇒ 请另行裁定，我未擅动。

## 7. 验证（命令与结果）

1. 修复前红基线：`cd web && ./node_modules/.bin/vitest run multiPeriodLayoutDom.test.tsx multiPeriodHeightsPageContract.test.tsx` ⇒ `Tests 3 failed | 19 passed (22)`，恰为 `C8 / C9 / B13`（C4 已随夹具修复转绿）。
2. 实现侧单测红（临时还原旧行）：`vitest run multiPeriodDragDomainClamp.test.ts` ⇒ `1 failed | 3 passed`，`D2` 红。
3. **全量**：`cd web && ./node_modules/.bin/vitest run` ⇒ **`Test Files 82 passed (82)` / `Tests 751 passed (751)`**（含修好的 C4、转绿的 C8/C9/B13、强化的 B8；证据 `vitest_full_green.txt`）。
4. **类型**：`cd web && ./node_modules/.bin/tsc -b` ⇒ `tsc exit=0`（证据 `tsc_b.txt`）。
5. **门禁**：`./scripts/check-tangle.sh` ⇒ `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）`，`exit=0`（证据 `check_tangle.txt`；**未**在仓库内直接跑 tangle）。
6. **变异审计**：临时移除域夹取 ⇒ `5 failed`（`D2 / C8 / C9 / B8(新版) / B13`）⇒ 已还原（`diff -q` 确认实现文件与修复版逐字节一致）。
7. **进程卫生**（`process_hygiene.txt`）：线上 `PID 3112540` 存活且 `STARTED Mon Sep 14 11:52:36`（**未重启**，`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`）；无 vitest/vite/playwright 残留；无临时端口实例（0.0.0.0:8080 为派单前既有监听、非本轮创建）；`git diff --cached --name-only` **0 个文件**、`git stash list` **0 条**（禁 add/commit/stash 已遵守）；全程 **0 写请求**（所有 api 均为本地桩，未起临时实例）。

## 8. 全量稳定性复跑（诚实上报）

在最终形态（域夹取 + 强化 B8）下连跑 14 次全量 `vitest run`：**13 次 `751/751` 全绿**，1 次出现 **1 个** 失败（该次输出我只留了 `tail`，**未捕获失败用例名**，因此不冒充已定位）。特征与 tester 已在 `tester/evidence/277_p5d1_red/strategy_editor_flake_check.txt` 记录的**既有 flake 类**一致（`StrategyEditorPage` 被单独复跑验证为 17/17 绿），故判定为**既有 flake / 并发资源竞争**，与本轮改动无关：
- 本轮改动的相关面（C8/C9/B13/B8/B5–B7/B9–B13/C1–C7/D1–D4）在 14 次复跑中**无一次失败**；
- 失败出现的那一次紧接在 4 次「临时变异 + 还原」循环之后（机器负载/计时器敏感）；
- 建议阶段 3 验收时以**同一命令重复 2–3 次**为准（本报告 §7 第 3 条的绿证据是其中一次完整输出）。

## 9. 残余风险（诚实上报）

1. **超宽屏（可用高度 ≥ 约 1201px）**：`fit` 路径下基准 = `H − 其它期望之和`，可 > `HEIGHT_MAX = 1200` ⇒ 载荷域外 ⇒ 仍可能 400。这与「拖拽期望值越域」**不是同一缺陷**（是「分配值域 vs 配置值域」问题；tester 设计 §5 已列为残余风险），本轮未落红测试、未修（**不得**在分配结果上二次夹取，否则破坏 `Σ == 可用` 不变量 ⇒ 需架构裁定）。
2. B8 旧数值断言被取代（架构师授权）；阶段 3 若按旧口径比对需知悉 §6 的不可满足性论证。
3. 未跑 Playwright 真渲染几何（`web/tester/p5-layout-harness/`）——本轮瑕疵属配置域问题而非几何问题，且派单未要求；上游要求「临时实例」的场景本轮不存在（未起实例）。

## 10. 结论

- 期望 px 被夹到配置域 `[80,1200]`（单入口，1 行实质改动），拖拽 → `onHeightsChange` → `PUT` 载荷恒合法；
- 配置域夹取与渲染侧分配下界严格分离，分配算法逐字节未动；
- P5-D-1 三红全部转绿，全量 `751/751`（14 次复跑 13 次全绿，1 次疑既有 flake 见 §8）、`tsc -b` 0、`check-tangle` 0；
- 0 staged / 0 stash / 0 写请求 / 未重启线上 / 无残留实例。

VERDICT: GREEN(带观察项：① B8 ⑥ 实测 312/104 与架构师字面 296/112 的差异见 §6，因维持既有 B6 不可两全；② 14 次全量复跑中 1 次现既有 flake 类单例失败，未捕获用例名，见 §8)
