# 阶段 2 修复报告 — ① 骨架残留分割线（`sub-chart` 锚点 `border-t`）+ ② DCAP 副图常驻 0 参考线

- **报告自身路径（self-location）**：`coder/report/160_stray_separator_fix_and_dcap_zero_line.md`
- **执行时间**：2026-09-13 20:5x ~ 21:1x CST
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `5a016cd`（未提交、无 staged 文件）
- **线上实例**：8081/8082（PID **2029836**）**未 kill / 未重启 / 未改状态**；本任务对线上只有只读 GET（API 回源）与页面只读访问
- **前置**：阶段 1 结论 = `DIAGNOSED(c)`（`tester/test/047_issue1_stray_separator_diagnosis_execution.md`），非 INSUFFICIENT ⇒ 本阶段启动
- **架构裁决（本次）**：方案 **A（doc-first：改文档 → 沙箱重生成 → 只拷回 1 个生成物）** 已获架构师批准；C 明确否决

---

## 1. 改动文件清单（`git diff --stat`，共 5 文件 / +124 −27）

| 文件 | 规模 | 性质 | 归属层 |
|---|---|---|---|
| `design/06-web/01-dashboard.md` | 2 行（1 改） | **事实源**（L3 骨架代码块） | 设计文档（L3 布局骨架） |
| `web/src/layouts/DashboardGrid.tsx` | 2 行（1 改） | **tangle 生成物**（沙箱重生成后拷回） | 前端布局骨架（生成物） |
| `design/14-dcap-indicator/02-spec.md` | 5 行（3+/2−，**仅 §6 散文/表格**） | **事实源**（仅散文，未碰任何 `file=` 代码块） | 设计文档（图表契约 C） |
| `web/src/features/indicators/dcapIndicator.ts` | +67/−… | **手写**（klinecharts 注册接线层） | 前端指标接线层 |
| `web/src/features/indicators/dcapIndicator.test.ts` | +75/−… | **手写测试** | 前端指标接线层测试 |

- 未改：ABI / 引擎 / ExecutionPolicy / `/api/config/*` / `web/src/features/indicators/dcap.ts`（tangle 生成物）/ 其余 design 代码块
- 未做：`git add` / `commit` / `stash`；`entangled tangle`（仓库内一次未跑）；未写仓库 `.entangled/` DB

### 1.1 问题① 的最小 diff（两文件各 1 行）

```diff
-  <div data-region="sub-chart" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/5 border-t">
+  <div data-region="sub-chart" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/5">
```

（`data-region="sub-chart"` 锚点、`pointer-events-none absolute inset-x-0 bottom-0 h-1/5` 全部保留 ⇒ region 契约、`e2e/helpers/pages.ts` region 清单、`DashboardPage.test.tsx` 的 region 断言零影响）

---

## 2. 问题① — 根因与修法对应关系

| 诊断结论（tester/047） | 本次修法 | 一致性 |
|---|---|---|
| 那条多余线 = `DashboardGrid.tsx` 中 `[data-region="sub-chart"]` 锚点的 **`border-t`**（Tailwind preflight 默认 `#e5e7eb`），恒在 `0.8 × main-chart 高`，**不是 klinecharts 分隔线** | 从 **事实源**（`design/06-web/01-dashboard.md` L3 代码块）删掉这一个 utility class，沙箱重生成后拷回生成物 | ✔ 逐条对应 |
| **与 DCAP / `syncIndicators` 无关**（DCAP 从未注册的对照变体 + 线上 DCAP 关闭态同样有该线；无空 pane；DCAP 连切 3 次 3↔4 可逆） | **未改** `syncIndicators` / `INDICATOR_DEFS` / `createIndicator` / `removeIndicator` 任何逻辑 | ✔ 只按证据指向的根因改，未顺手改 pane 生命周期（诊断 §5.3 的「pane 高度不被记忆」仍是独立遗留项，本阶段不动） |
| 修法提案 §6.1「删 `border-t`；锚点与 region 契约保留；不得手改生成物」 | 按架构师批准的方案 A：改文档 → **/tmp 沙箱内**只对该单一目标块重生成 → **只拷回 `web/src/layouts/DashboardGrid.tsx` 一个文件** | ✔ 生成物未被手改；未触碰其余 151 个生成物 |
| 验收口径：删掉的必须是**重复的那条**，不能是**唯一的边界** | 见 §2.1（klinecharts 自身分隔线仍在，且条数恒 = 内容 pane 数 − 1） | ✔ |

### 2.1 「删的是重复线，不是唯一边界」的证据

1. **修复前**：`expect(s0.separators).toHaveLength(1)` **通过**、失败发生在下一行 `strayLines` ⇒ 两条线**同时存在**：klinecharts 分隔线 1 条 + 骨架残留线 1 条。
2. **修复后（真实渲染实测，沙箱预览 5174，1280×800）**：

| 状态 | klinecharts 分隔线（bg / topInMain） | 骨架残留线 | `sub-chart` 锚点计算样式 |
|---|---|---|---|
| DCAP 关 | **1 条** `rgb(221,221,221)` @ **517**（= K线\|VOL 边界，main-chart h=644） | **[] 空** | `borderTopWidth: 0px`，`background: rgba(0,0,0,0)` |
| DCAP 开 | **2 条** @ **416 / 517**（candle\|VOL\|DCAP） | **[] 空** | 同上 |

3. E2E 断言「把第一条分隔线向上拖 120px → 分隔线随 pane 边界上移」**通过** ⇒ K线↔VOL 的可见边界由 klinecharts 提供（可拖动、随 pane 走），删除的静态线只是叠在上面的重复线。

### 2.2 门禁/范围证据（架构师约束 2）

- `./scripts/check-tangle.sh` → **`exit=0`**，`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）`
- `git diff --stat` → **恰好 2 个文件**（`design/06-web/01-dashboard.md` + `web/src/layouts/DashboardGrid.tsx`，各 1 行）—— 问题① 落地当时实测。
- 沙箱重生成时的 `diff -u` 输出：**只有目标那一行不同**（其余 5209 字节逐字节一致）。

### 2.3 只读普查：其它 7 个 `*Grid.tsx`（架构师约束 4，仅报告不改）

| 文件 | `border-t` | 判定 |
|---|---|---|
| `TradingGrid.tsx:62,68` | `order-list` / `trade-list` 各 1 处 `h-1/3 border-t` | **不是本缺陷同类**：交易面板内两块表之间的**真实区域边界**，该页无 klinecharts pane、无重叠锚点，不产生「双线」（顺带观察：两个 `h-1/3` + `account-card h-24` 的纵向分配可另案评估，非本任务范围） |
| `AlertsGrid / QualityGrid / SourcesGrid / SymbolsGrid / SimLiveGrid` | 仅 `border-b`（区域底边） | 同上，无 klinecharts 重叠 |
| `DashboardGrid.tsx` | **0 处**（已修） | 唯一「锚点绝对覆盖在图表区内部」的 `border-t` ⇒ **该问题在别的页面不会复发**（关键差异：`absolute` 覆盖 + 图表自带分隔线两条线叠画）。`grep -n "absolute" web/src/layouts/*.tsx` 现仅剩这一处锚点 |
| L1.5 静态样机 `design/06-web/preview/01-dashboard.html`（`.sub { border-top: 1px solid var(--line) }`） | 1 处 | **未改**：它是**静态 HTML 样机**（浏览器直接打开的预览，非 app 运行时 DOM）；改动会新增第 3 个生成物、违反「恰好 2 文件」，留作观察项（§7） |

---

## 3. 问题② — DCAP 副图第 4 个 figure（常驻 0 参考线）

### 3.1 落地位置与形状（`web/src/features/indicators/dcapIndicator.ts`，手写层）

```ts
export const DCAP_ZERO_FIGURE_KEY = 'zero';
export const DCAP_ZERO_FIGURE_TITLE = '0: ';
/** 细（size 1）、灰（#76808F）、虚线 */
export const DCAP_ZERO_LINE_STYLE: IndicatorFigureStyle = {
  color: '#76808F', style: 'dashed', size: 1, dashedValue: [4, 4], smooth: false,
};

export interface DcapFigureValues extends DcapValues { zero: 0; }   // 本地类型（不改生成物契约）

figures: [
  { key: 's', title: 'S: ', type: 'line' },
  { key: 'm', title: 'M: ', type: 'line' },
  { key: 'l', title: 'L: ', type: 'line' },
  { key: 'zero', title: '0: ', type: 'line', styles: () => DCAP_ZERO_LINE_STYLE }, // 每条 bar 恒 0
],
```

- **`web/src/features/indicators/dcap.ts`（tangle 生成物）零改动**；`DcapValues` 契约不变 —— 第 4 figure 的值由 `calc` 在返回对象上**就地扩展**（`{ ...v, zero: 0 }`），故 `precision: 5` / CORE 镜像（`dcapMirror.test.ts`）/ 插件产物 / 路由 / 配置面全不受影响。
- **为什么必须常驻 0**：klinecharts 副图 Y 轴区间 = 该 pane 内各 indicator 各 figure 值的 min/max（`node_modules/klinecharts/dist/index.esm.js:1045-1056`，`createRangeImp` 遍历 `figures.forEach(figure => data[figure.key])`）⇒ **只有把 0 纳入标度，0 线才可能在任何时段/缩放/数据不足段可见**；退化情形（可视范围内三线全 null ⇒ min=max=0）由该库 `realFrom === realTo || realRange < minSpan` 分支兜底（`index.esm.js:1087`），不会除零/NaN。
- 取舍（已向用户说明）：副图 Y 轴**始终包含 0**，三线整体远离 0 时信号被压缩。

### 3.2 断线/降级语义

| 路径 | 三条数据线 | `zero` |
|---|---|---|
| 数据充足 | 各按 `n_i+m−1` 起有值 | **0** |
| 数据不足（该 bar 无值） | `null`（断线） | **0**（0 线仍在） |
| `bar.close` 读取抛异常 / `calcParams` 非法 / 任何异常 | 全 `null` 断线（长度仍 = `dataList.length`） | **0** |
| `dataList` 非数组 | `[]`（既有行为不变） | — |

---

## 4. 文档同步（doc-first，仅散文）

`design/14-dcap-indicator/02-spec.md` **§6 表格**（散文/表格行，**未触碰该文档任何 `file=` 代码块**）：

- 「三线 | 一个指标的 3 个 figure：`s`/`m`/`l`」→ 「**figure 构成** | **3 个数据 figure**（`s`/`m`/`l`）+ **1 条常驻 0 参考线**（第 4 figure `zero`，值恒 `0`）」
- 新增一行「**0 参考线**」：每条 bar 返回 0（数据不足仍返回 0）、样式细/灰 `#76808F`/虚线、**参与副图 Y 轴自动标度**（含 `index.esm.js:1045-1056` 依据）、**不参与策略口径**（CORE/插件/路由零影响；`DcapValues` 不变，值由手写层就地扩展）+ 取舍说明（Y 轴始终含 0）
- 「断线」行补注：**0 参考线不参与断线**（恒返回 0）
- 验证：`./scripts/check-tangle.sh` → **exit=0**（散文改动不产生漂移；`dcap.ts` 字节未变，见 §5 门禁输出）

---

## 5. 验证与证据

### 5.1 问题① 红测试转绿（真实渲染，非单测）

前置沙箱（**不碰线上**）：`vite build` 到 `/tmp/e2e-spa` + `vite preview` 于 **5174**（`/api`、`/ws` 只读回源 8081）+ 真实 klinecharts 10.0.3 + 真实后端数据；`E2E_BASE_URL=http://localhost:5174 npx playwright test e2e/dashboard-pane-separator.e2e.ts --retries=0`。

| 轮次 | 产物 | 结果 |
|---|---|---|
| 修复前（HEAD 源码） | 未改 `DashboardGrid.tsx` 的构建 | **1 failed（RED）**：`主图区内出现了非 klinecharts 的水平分割线`；残留线 `{"tag":"DIV[data-region=sub-chart]","kind":"border-top 1px solid rgb(229, 231, 235)","topInMain":515.2,"h":128.8,"w":1299.31}`（= 0.8×644）；同轮 `separators` 断言已通过（1 条） |
| 修复后（问题① 落地） | 同上重构建 | **1 passed (5.0s)** |
| 问题② 落地后回归 | 再次重构建 | **1 passed (5.0s)**（② 未破坏 ① 的形态契约） |

用 `E2E_BASE_URL` 覆盖为 5174 ⇒ 线上 8081/8082 全程未被 E2E 访问（该用例本身另有「非 GET 一律 abort + 末尾断言 0 条」的只读自保）。

### 5.2 问题② 真实渲染证据（DCAP 副图 0 线可见）

沙箱预览 5174 实测（`getImageData` 直接扫 klinecharts 各 pane 画布）:

```
DCAP 关：分隔线 [517]                     ；DCAP pane 画布不存在
DCAP 开：分隔线 [416, 517]
  DCAP pane 内容画布（1239×100，host 内 top=518）：
    唯一全宽灰虚线行 y=53：非透明像素 816，其中 rgb(118,128,143)=#76808F 共 639 px
    虚线形态：145 个 dash run，run 长度集中在 4px（= dashedValue [4,4]）
    同 pane 三条数据线颜色（与之明显区分）：rgb(255,150,0) / rgb(146,93,189) / rgb(22,118,255)
对比：DCAP 关时同一位置画布无任何 #76808F 全宽行 ⇒ 该线由第 4 figure 产生
```

（另：candle pane 内存在一条既有的「最后价」灰虚线，DCAP 开/关两态同在、位置固定，与本改动无关，仅作排除说明。）

### 5.3 门禁输出

```
cd web && npx vitest run      → Test Files 56 passed (56) / Tests 562 passed (562)   （基线 558，+4 = 本次新增）
cd web && npx tsc -b          → TSC_EXIT=0
./scripts/check-tangle.sh     → ✅ design 与生成物一致… CHECK_TANGLE_EXIT=0
E2E(BASE_URL=5174) 修复前      → 1 failed（RED，残留线即根因）
E2E(BASE_URL=5174) 修复后×2    → 1 passed
```

`git diff --stat`（终态）：5 文件 / +124 −27；`git diff --cached` **空（无 staged 文件）**。

---

## 6. 测试覆盖

`web/src/features/indicators/dcapIndicator.test.ts`（19 tests，全绿；本次 +4）：

1. 注册面：`figures` key 改为 `['s','m','l','zero']`、均为 `line`、第 4 figure `title='0: '`；precision=5 与无 `paneId` 断言保持。
2. **新增**：第 4 figure `styles()` 返回 `{color:'#76808F', style:'dashed', size:1, dashedValue:[…]}`，且 s/m/l 三个 figure **不覆写样式**（数据线保持面板默认色）。
3. **新增 describe「DCAP 常驻 0 参考线」**（3 条）：
   - 每条 bar 都 `zero === 0`（含三线全断的前 9 根）；
   - `zero` 进入值域 ⇒ `min ≤ 0 ≤ max`（三线全 null 时仅剩 0，仍含 0）；
   - 异常降级路径（`close` 抛异常 / 非数组 / `calcParams` 非法）不抛且 `zero` 恒 0。
4. 既有用例按新契约更新（非删除）：逐位对齐断言改为「去掉 `zero` 后与 `computeDcapSeries` 逐位相等」+ 断线/异常路径的期望对象补 `zero: 0`。

问题① 的防回归：`web/e2e/dashboard-pane-separator.e2e.ts`（阶段 1 产出，**保留未改**，现由 RED 转 GREEN），覆盖默认态 1 条分隔线/无残留线/锚点 `borderTopWidth=0px`、拖高 VOL 后分隔线随动、DCAP 开↔关 1↔2 可逆、全程无非 GET 请求。

---

## 7. 未达标项 / 残留风险（如实记录）

1. `design/14-dcap-indicator/03-test-plan.md` **T8 第 3 点仍写「三 figure（s/m/l）」** —— 任务只授权改 `02-spec.md §6` 散文，故**未改**该处；与实现（3 数据 figure + 1 常驻 0 线）存在文字落差，建议下一阶段一并更正（一行散文）。
2. `design/06-web/preview/01-dashboard.html`（L1.5 静态样机）仍画 `.sub { border-top }` —— 样机不在 app 运行时 DOM 中，且改动会新增第 3 个生成物（违反本轮「恰好 2 文件」约束），未改；若产品要求样机与实现完全一致，需单独一轮。
3. 诊断 §5.3 的两个附带观察（用户拖拽的 pane 高度不被记忆 = 每次同步 remove+create；新建 pane 同 tick 内 `xAxis` 顺序瞬时非规范）**本阶段未动**（与问题① 根因无关，超出最小修复范围）。
4. 问题② 的既定取舍保留：副图 Y 轴始终包含 0 ⇒ 三线远离 0 时信号压缩；「仅当 0 落在自动范围内才画」需另行定口径（本阶段不做）。
5. 线上 8081 **仍是旧构建**（`web/dist` 未重新生成 —— 该目录是运行期只读来源，构建它会立刻改变用户所见，故本轮刻意不构建）；本修复需由后续部署阶段产出新构建后才会对用户可见。
6. 本轮 E2E 走的是临时预览端口（5174）的**产物形态**（与线上同源同 hash 的 CSS/JS 来源）；线上容器的最终形态验收仍应由阶段 3 在真实部署上复核。

---

## 8. 纪律复核

- 线上 8081/8082（PID 2029836）：**未 kill、未重启、未改状态**（`ps` 复核同一 PID 存活、`GET /` → 200；只在 E2E 沙箱中作为**只读 API 回源**使用）
- 未 `git add/commit/stash`（`git diff --cached` 为空）；未跑 `entangled tangle`（仅在 `/tmp` 沙箱内 `tangle -f` 生成，且只拷回 1 个文件）；未手改任何 tangle 生成物；未改 `web/src/features/indicators/dcap.ts`、ABI、引擎、ExecutionPolicy、`/api/config/*`
- 临时文件已清理：`web/vite.e2e-sandbox.config.mts` 已删除；临时 dev/preview 进程（5173/5174）已停止（`ss` 复核端口空闲）；`git status -- web` 仅剩阶段 1 的红测试（未跟踪）与 3 个已改文件
