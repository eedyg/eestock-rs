# 278 — P5-E-2 实现报告：**持久化载荷夹取（最小改动）**

- **本文件路径**：`coder/report/278_p5e2_payload_domain_clamp.md`
- 角色：Coder（实现 + 自测取证；**未跑 tangle 修改、未触碰线上、0 写请求、未起临时实例**）
- 时间：2026-09-15 01:04–01:08（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `78eb68d`；P5 实现仍在工作树**未提交**）
- 依据：`design/15-multi-period/02-spec.md` §6.2（架构裁决 2026-09-15：「**持久化载荷恒合法，渲染分配可越域**」）
- 红测试来源：`tester/design/278_p5e1_payload_domain_red_design.md` + `tester/test/278_p5e1_payload_domain_red_execution.md`
- 证据目录：`coder/evidence/278_p5e2_payload_clamp/`
- 上级裁决（本轮）：**采用候选 C1**，并授权 Coder **就地修正 B14 末行主语**（`payload[BASE_PERIOD]` → `dom[BASE_PERIOD]`），
  仅限该行 + 一条防「改回」注释；实现方案（`toPersistableHeights`）已获认可。

---

## 1. What changed（改动文件清单 + 精确 diff）

| 文件 | 状态 | 本轮净增 | 内容 |
|---|---|---|---|
| `web/src/features/dashboard/multiPeriodLayout.ts` | 未跟踪（P5 新增文件） | **+19 行**（现 271 行） | 新增纯函数 `toPersistableHeights`（唯一新增符号） |
| `web/src/features/dashboard/MultiPeriodChartStack.tsx` | 已跟踪（P5 已改） | **+5 行 / −1 行**（现 356 行） | 载荷出口改用 `toPersistableHeights`（1 行替换）+ 1 行 import + 4 行注释 |
| `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx` | 未跟踪（P5 新增测试文件） | **+3 行 / −1 行**（现 710 行） | B14 末行主语修正（**上级授权范围内**）+ 3 行防回退注释 |

### 1.1 `multiPeriodLayout.ts`（新增，行 232–250）

```diff
+/**
+ * **持久化载荷夹取**（`onHeightsChange` 的唯一出口；02-spec §6.2，架构裁决 2026-09-15）：
+ * 每一项夹到配置域 `[HEIGHT_MIN, HEIGHT_MAX]`（= `[80, 1200]`，与 `crates/web/src/dto.rs` 的
+ * `validate_multi_period_config` 第 5 条同域）。
+ *
+ * 为什么必须有（P5-E-1 缺陷）：`fit` 路径让**基准吸收余量**（`基准 = H − Σ卫星请求`）
+ * ⇒ 可用高度 ≥ ~1201px 时**分配高度**可 > `HEIGHT_MAX`；若把分配结果原样当载荷，
+ * `PUT /api/config/multi_period` 会被配置面 400 拒绝并回滚（用户表现「调大窗口后拖一下就保存失败」）。
+ *
+ * **只夹载荷，不动渲染分配**：分配必须保持 `Σ == 可用高度` 不变量（强行夹分配会破坏它）；
+ * 故口径为 `payload == clamp(DOM 末次分配高度, 80, 1200)`——分配本就在域内时即为逐值相等。
+ */
+export function toPersistableHeights(heights: Record<string, number>): Record<string, number> {
+  const out: Record<string, number> = {};
+  for (const period of Object.keys(heights)) {
+    out[period] = clamp(Math.round(heights[period]!), HEIGHT_MIN, HEIGHT_MAX);
+  }
+  return out;
+}
```

（复用了本文件既有的私有 `clamp` 与既有常量 `HEIGHT_MIN/HEIGHT_MAX`；**未新增常量、未新增依赖**。）

### 1.2 `MultiPeriodChartStack.tsx`（夹取落点：`onHeightsChange` 之前）

```diff
   import {
     ...
     heightsByPeriod,
+    toPersistableHeights,
     type StackPane,
   } from './multiPeriodLayout';
```

```diff
   // 防抖持久化：拖拽期间用本地期望高度（乐观）；`DRAG_DEBOUNCE_MS` 静默后恰写一次「全 pane 布局高度」。
+  // **载荷夹取（P5-E-1）**：`fit` 路径下基准吸收余量 ⇒ 分配高度可 > `HEIGHT_MAX = 1200`（可用高度 ≥ ~1201px 时）
+  // ⇒ 原样回流会被 `PUT /api/config/multi_period` 400 拒绝并回滚。故持久化载荷逐项夹到 `[80,1200]`
+  // （`toPersistableHeights`）；**渲染分配不改**（`Σ == 可用高度` 不变量不得被夹取破坏）。
```

```diff
-      const out = onHeightsChange({ ...payloadRef.current });
+      const out = onHeightsChange(toPersistableHeights(payloadRef.current));
```

**夹取落点（唯一出口）**：`MultiPeriodChartStack.tsx:219`，位于 `scheduleFlush` 的 `setTimeout`（防抖窗）内、
`onHeightsChange` 调用点之前。载荷仍是**新对象**（`toPersistableHeights` 返回新 map）⇒ 既有「不得回传内部引用」性质保持。

### 1.3 `multiPeriodLayoutDom.test.tsx`（B14 末行主语修正，上级授权范围）

```diff
+    // 主语必须是**渲染分配**（`dom`）：02-spec §6.2 的两条**并列**契约 = 「渲染分配**可越域**（>1200）」
+    // + 「持久化载荷被夹取（≤1200）」。本行钉前者（拖后分配仍越域 = 前置再现）；**不得**改回 `payload`
+    // ——payload 已被 ②（≤1200）与 ③（== clamp(dom) = 1200）钉死，改回即自相矛盾（P5-E-2 裁决）。
-    expect(payload[BASE_PERIOD]!, '基准 pane 是越域的那个（前置再现）').toBeGreaterThan(HEIGHT_MAX);
+    expect(dom[BASE_PERIOD]!, '基准 pane 是越域的那个（前置再现）').toBeGreaterThan(HEIGHT_MAX);
```

- **性质**：修复**主语错误**、恢复设计文档本意（`tester/design/278...md` §3 B14 第 1 点把「越域」定义为**渲染分配** 1260 > 1200），
  并使其与**已转绿的 B15** 逐字同构（B15 原本就写 `dom[BASE_PERIOD]`）。**不是放宽**：
  B14 原末行与同用例 ②（`payload ≤ 1200`）③（`payload == clamp(dom) == 1200`）**逻辑互斥**，任何实现都无法满足；
  该行是「分配可越域」这条 §6.2 契约的**唯一**护栏，删除（C2）才会丢护栏。
- **授权边界遵守**：只改这一行主语 + 增加上述注释；②③ 与 B14/B15 其它断言、本文件其它 13 例、其它测试文件**逐字未动**。

---

## 2. Architecture alignment（分层归属）

| 改动 | 层 | 理由 |
|---|---|---|
| `toPersistableHeights` | 前端**纯函数域**（`multiPeriodLayout.ts`，无 React/DOM/副作用） | 载荷域（`[80,1200]`）与分配算法同属「高度语义」单一事实源；与既有 `sanitizeRequestedHeight`/`sanitizeDragHeight`/`heightsByPeriod` 同层同族 |
| `onHeightsChange(toPersistableHeights(...))` | 前端**组件层**（组件 → 父层回调出口） | 契约要求载荷在**产出处**恒合法；页面层夹取不满足（tester 报告 §7 已说明组件级载荷仍会红） |
| `distributeStackHeights` / `paneHeights` / DOM inline 高度 | **未改** | 渲染分配是 `Σ == 可用高度` 的守门者，越域是**允许**的（§6.2）；不得因载荷域而夹分配 |

- **未触碰**：接口签名（`MultiPeriodChartStackProps.onHeightsChange` 类型未变）、`DashboardPage`、`multiPeriodStore`、
  生成物/Rust、`crates/web/src/dto.rs` 配置面校验（`[80,1200]` 事实源未动）。
- **未新增依赖/框架**；未改层边界、未改事件契约、未跨层依赖。

---

## 3. Problem solved（缺陷与修复）

- **缺陷**：可用高度 ≥ ~1201px 时，`distributeStackHeights` 的 `fit` 路径让**基准吸收余量**
  （`基准 = H − Σ卫星请求`）⇒ **分配高度可 > `HEIGHT_MAX = 1200`**；防抖回调把分配结果**原样**当载荷
  ⇒ `PUT /api/config/multi_period` 被配置面校验（`crates/web/src/dto.rs` 第 5 条 `[80,1200]`）**400 拒绝** ⇒ 回滚
  ⇒ 用户表现「**调大窗口后拖一下就保存失败**」。
- **修复**：在**唯一载荷出口**（`onHeightsChange` 之前）逐项夹到 `[80,1200]`；渲染分配保持越域能力与 `Σ == 可用` 不变量。
- **口径**：`payload == clamp(DOM 末次分配高度, 80, 1200)`（分配本就在域内 ⇒ 逐值相等）。
- **被作废的旧字面值**：`600−80−112−112=296` 未使用、未编码（以 §6.2「各项期望独立夹取」口径为准；本轮**未改**拖拽语义）。

---

## 4. Implementation approach（在批准架构内的关键决策）

1. **落点选在组件载荷出口**而非页面/分配：页面侧夹取不满足组件级判据（tester §7）；分配侧夹取会破坏 `Σ == 可用`。
2. **夹取实现为纯函数**（`toPersistableHeights`）放在 `multiPeriodLayout.ts`：与分配算法共用 `HEIGHT_MIN/HEIGHT_MAX` 单一事实源，
   便于后续单测/变异审计定位；避免在组件内塞域逻辑。
3. **只夹一次、只在一个出口**：`scheduleFlush` 是组件唯一调用 `onHeightsChange` 的位置 ⇒ 无第二出口、无重复夹取。
4. **不夹「期望值」之外的任何东西**：`dragRequest`/`sanitizeDragHeight`（P5-D-1 的域夹取）与分配算法**未改**，
   故 B1–B13/C1–C9/D1–D4 语义不变（域内 `clamp` 为恒等映射）。
5. **保持载荷为副本**：返回新 map，不泄漏内部引用（既有性质不变）。

---

## 5. Test coverage

- **新增用例（Tester 侧，本轮转绿）**：`multiPeriodLayoutDom.test.tsx` B14 / B15 —— 超宽屏（1800px，基准分配 1261）与
  3-pane（1400px，基准 1240）两条「分配越域」夹具，钉死：载荷域 `[80,1200]` + 口径等式 `payload == clamp(DOM)` +
  反作用护栏 `Σ DOM == 可用高度`（1800 / 1400）。
- **本轮 Coder 侧未新增测试**：唯一测试改动 = B14 末行主语修正（授权范围；**加强**语义：它把不可满足的断言改回文档本意的护栏）。
- **既有测试只加强、无放宽**：B1–B13、C1–C9、D1–D4、A1–A15 断言逐字未动（全量 753 全绿）。

---

## 6. Verification（红转绿 + 全量 + 门禁）

### 6.1 红基线（改动前，目标套件）
`cd web && ./node_modules/.bin/vitest run src/features/dashboard/multiPeriodLayoutDom.test.tsx`
⇒ **2 failed | 13 passed (15)**；失败 = B14/B15（同 Tester 归档 `tester/evidence/277_p5e1_red/layout_dom_b14_b15_red.txt`）。

### 6.2 实现后（目标套件，转绿）
```
 ✓ src/features/dashboard/multiPeriodLayoutDom.test.tsx (15 tests) 186ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```
（`coder/evidence/278_p5e2_payload_clamp/target_suite_green.txt`、`final_target_suite.txt`）

### 6.3 变异探针（前置自证：移除夹取 ⇒ 目标用例必须变红）
临时把载荷出口还原为 `onHeightsChange({ ...payloadRef.current })`（唯一改动）后：
```
 × B14 … → 15m 载荷必须 ≤ 1200（…），收到 1261；口径要求 payload == clamp(DOM 1261, 80, 1200) = 1200
 × B15 … → 15m 载荷必须 ≤ 1200，收到 1240；口径要求 payload == clamp(DOM 1240, 80, 1200) = 1200
 Test Files  1 failed (1) / Tests  2 failed | 13 passed (15)
```
⇒ B14（主语修正后）与 B15 **仍能鉴别「载荷夹取」**；探针已还原，还原前后被改文件
`sha256 = 46f9e63cc82de5dc9d41c26e1bb7a9b23528c4dee48923c5695e4d61d0197516`（**逐字节一致**）。
（证据：`coder/evidence/278_p5e2_payload_clamp/mutation_probe_remove_clamp.txt`）

### 6.4 全量 + 静态 + 门禁
| 命令 | 结果 | 证据 |
|---|---|---|
| `cd web && ./node_modules/.bin/vitest run` | **Test Files 82 passed (82) / Tests 753 passed (753)**，exit 0 | `final_full_tsc_tangle.txt` |
| `cd web && ./node_modules/.bin/tsc -b` | **exit 0**（无类型错误） | 同上 |
| `bash $PWD/scripts/check-tangle.sh`（仓库根调用） | **`[check-tangle] ✅ design 与生成物一致…` exit 0** | 同上 |

- 全量总数对照：P5-D 收口时 751 ⇒ 本轮 **753**（+2 = Tester 新增 B14/B15），**0 回归、0 skip**。
- 门禁调用姿势说明：首次在 `web/` 内以相对路径 `../scripts/check-tangle.sh` 调用时该脚本自身 `cd` 基准报错（exit 1，
  `cd: ../scripts: No such file or directory`），改从仓库根以绝对路径调用即通过 ⇒ 属**调用姿势**问题，非门禁红；两次输出均已归档备查。
- 域内用例（600px 夹具）未受影响：`clamp` 为恒等映射 ⇒ B7/C8/C9 等断言仍逐字节成立。

### 6.5 改动面 / 卫生
- `git diff --cached --name-only` **为空**（遵守「禁 `git add`/`commit`/`stash`」；本轮 **0 staged 文件**）
- 本轮触碰文件 **恰 3 个**（上表）；`git status --porcelain` 中未出现任何新增/意外文件（证据 `hashes_and_status.txt`）
- 线上 PID 3112540 **未触碰**；0 写请求（全部本地 `vitest + jsdom`）；**未起临时实例**（无需拆）
- 未在仓库内跑 tangle 的**生成流程**（仅运行只读门禁 `check-tangle.sh`，其内部在沙箱重新生成并比对，工作区零修改）

---

## 7. Residual risks / 交接

1. **B14 末行主语缺陷归属**：`multiPeriodLayoutDom.test.tsx` B14 末行由 **Tester 侧编写疏漏**引入（②③ 与末行互斥，任何实现都无法同时满足）；
   本轮经上级裁决 **C1** 授权 Coder 就地修正**仅该行主语** + 加防回退注释。已如实标注（详见 §1.3）。
2. **分配越域仍在 UI 上真实存在**（本轮**有意**保留，属 §6.2 契约）：基准 pane 在超宽屏下可 > 1200px 高度、`Σ == 可用`。
   若未来产品要求「分配也恒 ≤ 1200」，那需要**新的**架构裁决（例如把余量另立 pane），本轮**不得**自行实现。
3. **载荷 ≠ 分配**（越域时）：保存成功后服务端回显 `1200` ⇒ 下一次拖拽基线取「当前分配」（1261）而非回显值 —— 与 P5-B 的
   「拖拽基线 = 当前已分配高度」既有语义一致；若验收发现「保存后立刻再拖」出现瞬时跳变，需另立用例（本轮未覆盖该时序）。
4. **页面级兜底未加**：若将来出现绕过组件的载荷出口（如新的批量布局 API 调用），夹取需同步补位（当前 `onHeightsChange` 是唯一出口）。
5. 变异审计（上级「阶段 3」）由上级执行；本轮已给出**同向**探针证据（§6.3）作为输入。

---

## 8. 硬约束遵守核对

| 约束 | 状态 | 证据 |
|---|---|---|
| 禁 `git add` / `commit` / `stash` | ✅ 未执行（staged 为空） | §6.5 |
| 禁在仓库内跑 tangle | ✅ 仅跑只读门禁脚本，未运行生成流程 | §6.4 |
| 不重启线上（PID 3112540） | ✅ 未发出任何针对线上实例的命令 | — |
| 0 写请求 | ✅ 本地 vitest/jsdom，`onHeightsChange` 为 `vi.fn` 桩 | §6.2 |
| 临时实例用临时端口并收尾全拆 | ✅ 未启动实例 | — |
| 清理进程用不自匹配写法 | ✅ 无需清理进程（未用 `pkill` 类匹配） | — |
| 既有测试只允许加强 | ✅ 既有断言逐字未动；唯一测试改动 = 授权的主语修正（加强/恢复本意） | §1.3 |
| 输出末行打印 VERDICT | ✅ 见最终回复末行 | — |

**VERDICT: GREEN**（目标套件 15/15、全量 753/753、`tsc -b` exit 0、`check-tangle` exit 0；B14 主语修正已获上级授权且不构成放宽）
