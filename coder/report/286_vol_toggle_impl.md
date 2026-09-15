# 286 · VOL 成交量副图 ⇒ 可关闭的普通指标开关（实现报告）

- **本报告路径（自身位置）**：`coder/report/286_vol_toggle_impl.md`
- 任务性质：实现阶段（TDD，让既存红测试转绿）
- 红测试（tester 产出，本阶段未修改一字）：`web/src/features/dashboard/volToggle.test.tsx`
- 设计依据：`tester/design/286_vol_toggle_red_design.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（前端 `web/`）
- 日期：2026-09-15

---

## 0. 结论

VOL 从「硬编码常开、无开关」改为「与 MA/MACD/KDJ/BOLL/DCAP 并列的全局指标开关（默认开、会话态）」：

1. **doc-first**：事实源 `design/06-web/01-dashboard.md` 的 `DashboardGrid.tsx` 代码块默认值加了 `vol: true`，
   该代码块其余内容逐字节未动。
2. **生成物真的更新了**（不是 tangle 假绿）：`web/src/layouts/DashboardGrid.tsx` 命中 `vol: true`，
   且 mtime 新于 design 文档；其 SHA-256 与「空 DB 沙箱内按文档重新生成」逐字节一致。
3. 删除两处 VOL 特权（类型逃逸 + 硬编码常开），**既有硬契约（状态差分：仅启用状态翻转才 create/remove，
   参数变化走 overrideIndicator，不销毁既有 pane）逐字保持**。
4. 全部门禁通过：`volToggle.test.tsx` 14/14 绿、全量 `vitest run` 85 files / 789 tests 全绿、
   `tsc -b` exit 0、`./scripts/check-tangle.sh` exit 0。
5. 未改任何后端文件（`crates/**`）、未改 config schema、未改 `multiPeriodStore.ts` / `MultiPeriodSatellite.tsx`
   / `web/dist/**`、未构建部署、未发任何 `/api` 写请求、未 `git commit`（仅 `git add` 暂存）。

红测试基线（实现前，仅作对照）：`Test Files 1 failed (1)` / `Tests 12 failed | 2 passed (14)`
（红的 12 条 = R1-1/R1-2/R2-1..4/R3-1/R3-2/R4-1/R5-1/R5-2/R7-1；预先声明为绿的 R3-3/R6-1 当时已绿）。

---

## 1. 改动文件清单

| # | 文件 | 侧 | 改动量 | 性质 |
|---|---|---|---|---|
| 1 | `design/06-web/01-dashboard.md` | 事实源 | +1/-1（第 216 行） | doc-first：默认值加 `vol: true` |
| 2 | `web/src/layouts/DashboardGrid.tsx` | 生成物 | +1/-1（第 8 行） | 由 tangle 按文档重新生成（未手改） |
| 3 | `web/src/features/dashboard/Toolbar.tsx` | 手写 | +1（第 61 行） | `INDICATORS` 加 VOL 开关（紧跟 `ma`） |
| 4 | `web/src/features/dashboard/KlineChart.tsx` | 手写 | +3/-3 | 删两处 VOL 特权 + 注释更新 |
| 5 | `web/src/features/dashboard/MultiPeriodChartStack.tsx` | 手写 | +1（第 74 行） | 内部兜底 `DEFAULT_INDICATORS` 加 `vol: true` |
| 6 | `web/src/features/dashboard/KlineChart.realtime.test.tsx` | 测试夹具 | +1/-1（71 行） | 必要适配 |
| 7 | `web/src/features/dashboard/KlineChart.test.tsx` | 测试夹具 | +1/-1（61 行） | 必要适配 |
| 8 | `web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx` | 测试夹具 | +3/-3（297/510/533 行） | 必要适配 |
| 9 | `web/src/features/dashboard/KlineChartSwitchLayout.test.tsx` | 测试夹具 | +1/-1（338 行） | 必要适配 |
| 10 | `web/src/features/dashboard/Toolbar.test.tsx` | 测试夹具 | +2/-2（13/45 行） | 必要适配 |
| 11 | `web/src/features/dashboard/multiPeriodLayoutAuthority.test.tsx` | 测试夹具 | +1/-1（101 行） | 必要适配 |
| 12 | `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx` | 测试夹具 | +1/-1（144 行） | 必要适配 |
| 13 | `web/src/features/dashboard/multiPeriodLayoutHandshake.test.tsx` | 测试夹具 | +1/-1（67 行） | 必要适配 |

`git diff --stat`（未含 tester 的新增红测试文件）：

```
 design/06-web/01-dashboard.md                                  | 2 +-
 web/src/features/dashboard/KlineChart.realtime.test.tsx        | 2 +-
 web/src/features/dashboard/KlineChart.test.tsx                 | 2 +-
 web/src/features/dashboard/KlineChart.tsx                      | 8 ++++----
 web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx   | 6 +++---
 web/src/features/dashboard/KlineChartSwitchLayout.test.tsx     | 2 +-
 web/src/features/dashboard/MultiPeriodChartStack.tsx           | 1 +
 web/src/features/dashboard/Toolbar.test.tsx                    | 4 ++--
 web/src/features/dashboard/Toolbar.tsx                         | 1 +
 web/src/features/dashboard/multiPeriodLayoutAuthority.test.tsx | 2 +-
 web/src/features/dashboard/multiPeriodLayoutDom.test.tsx       | 2 +-
 web/src/features/dashboard/multiPeriodLayoutHandshake.test.tsx | 2 +-
 web/src/layouts/DashboardGrid.tsx                              | 2 +-
 13 files changed, 19 insertions(+), 17 deletions(-)
```

另有一条**新增未跟踪文件**（tester 产出，本阶段**未修改**，随本次改动一并暂存）：`web/src/features/dashboard/volToggle.test.tsx`。

---

## 2. 逐处改动与理由

### 2.1 `design/06-web/01-dashboard.md`（事实源，doc-first）

第 216 行（`DashboardGrid.tsx` 代码块内）：

```diff
-  indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: false },
+  indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
```

**只改这一处**；该代码块（含 `// ~/~ begin` 标记、注释、`maWindows`/`view`/`chartTab`/`initialRange`、
`Period`/`GridMode`/`SymbolSnapshot`/`DashboardGridProps` 等）其余内容逐字节未动（`git diff` 只有 1 行变化，
见 §1 stat）。

理由：本仓库是文学式编程单向工作流（ADR-007），`design/` 是事实源、`web/src/layouts/DashboardGrid.tsx`
是 tangle 生成物（文件首行自带「禁止手改」）。`IndicatorName = keyof typeof DASHBOARD_DEFAULTS.indicators`
由生成物派生 ⇒ VOL 要成为「与其它 5 个并列的开关」，就必须先在文档里加键，再由 tangle 生成。

### 2.2 `web/src/layouts/DashboardGrid.tsx`（生成物，tangle 产出）

```diff
-  indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: false },
+  indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
```

**未手改**：全部内容来自 §3 的 scoped 沙箱重生成；`git diff` 只有上述 1 行。

生成后 `IndicatorName` 自动变为 `'ma' | 'vol' | 'macd' | 'kdj' | 'boll' | 'dcap'`，
`DashboardPage.tsx:111` 的 `{...DASHBOARD_DEFAULTS.indicators}` 会话态初始化因此默认含 `vol: true`
（页面接线无需改动；R7-1 已验证「点 VOL ⇒ 主图 VOL 消失且不写任何配置」）。

### 2.3 `web/src/features/dashboard/Toolbar.tsx`（手写）

```diff
 const INDICATORS: Array<{ value: IndicatorName; label: string }> = [
   { value: 'ma', label: 'MA' },
+  { value: 'vol', label: 'VOL' }, // 成交量副图：与 MA/MACD/KDJ/BOLL/DCAP 并列的开关（默认开，会话态）
   { value: 'macd', label: 'MACD' },
```

理由：任务口径要求 VOL 紧跟在 `ma` 之后，与 `KlineChart` 的 `INDICATOR_DEFS` 顺序一致（现为
`ma, vol, macd, kdj, boll, dcap`）。渲染循环（`aria-pressed={props.indicators[i.value]}`、
`onClick={() => props.onToggleIndicator(i.value)}`）**未改**——VOL 走的是与其余 5 个完全相同的通路，
没有任何特例分支（R2-1..4 断言其可点、按下态随 `indicators.vol` 变、点击回传 `'vol'`）。

### 2.4 `web/src/features/dashboard/KlineChart.tsx`（手写，删两处特权）

```diff
-const INDICATOR_DEFS: Array<{ key: IndicatorName | 'vol'; name: string; calcParams?: number[] }> = [
+const INDICATOR_DEFS: Array<{ key: IndicatorName; name: string; calcParams?: number[] }> = [
   { key: 'ma', name: 'MA' },
-  { key: 'vol', name: 'VOL' }, // 副图1 成交量默认开（无开关）
+  { key: 'vol', name: 'VOL' }, // 副图1 成交量：与其它指标并列的开关（默认开，见 DASHBOARD_DEFAULTS.indicators）
...
-  def: { key: IndicatorName | 'vol'; calcParams?: number[] },
+  def: { key: IndicatorName; calcParams?: number[] },
...
-    const enabled = def.key === 'vol' ? true : indicators[def.key];
+    const enabled = indicators[def.key];
```

- 特权①（类型逃逸 `| 'vol'`）删除：`INDICATOR_DEFS` 与 `desiredCalcParams` 的 `key` 收窄为
  `IndicatorName`，VOL 不再能绕过 props 面契约。
- 特权②（硬编码常开 `def.key === 'vol' ? true : ...`）删除：`enabled` 一律取 `indicators[def.key]`。

**既有硬契约逐字保持**（02-spec §6 图表契约）：
- 仅「启用状态翻转」才 `createIndicator` / `removeIndicator`（关态不残留空 pane）；
- 参数变化一律走 `chart.overrideIndicator({name, calcParams})`（原地改参数、不销毁 pane ⇒ 用户拖拽高度不丢）；
- 参数无变化 ⇒ 什么都不做（幂等）；
- 不依赖 `overrideIndicator` 返回值判成败；
- MA 仍走 `addOverlayIndicator(..., paneId:'candle_pane')`（唯一叠加指标），DCAP/VOL 等走
  `createIndicator(..., true)` 独立副图 pane。

VOL 的 `desiredCalcParams` 恒为 `[]` ⇒ `createIndicatorValue` 省略 `calcParams` 字段（保住 klinecharts
内置模板默认 `VOL [5,10,20]`，`KlineChartDcapSaveLayout.test.tsx` 的守卫断言仍然成立）。
改动全部落在「开关读取」这一处，没有引入任何新 API 调用路径。

### 2.5 `web/src/features/dashboard/MultiPeriodChartStack.tsx`（手写）

```diff
 const DEFAULT_INDICATORS: Record<IndicatorName, boolean> = {
   ma: true,
+  vol: true,
   macd: false,
```

理由：这是「栈未收到 `indicators` prop」时的内部兜底（`indicators = DEFAULT_INDICATORS` 默认形参），
必须与 `DASHBOARD_DEFAULTS.indicators` 同构；否则剥掉 prop 的调用面会静默丢掉 VOL（R6-1 即此守卫，
实现前后都必须是绿）。`MultiPeriodSatellite.tsx` 只透传 `indicators`，故自动获得 vol 语义（任务口径
明确不改它）。

---

## 3. tangle 生成证据（证明生成物真的更新，而非假绿）

### 3.1 反例（历史教训复现）：根目录 `entangled tangle` 是假绿

改完文档后在仓库根直接跑写入式 tangle：

```
[22:18:00] INFO     Welcome to Entangled v2.4.3!
           INFO     write `web/src/layouts/DashboardGrid.tsx`
           INFO     write `crates/web/src/lib.rs`
           INFO     write `crates/web/src/dto.rs`
           INFO     write `crates/web/src/rest.rs`
           WARNING  `web/src/layouts/DashboardGrid.tsx` changed outside the
                    control of Entangled
           WARNING  `crates/web/src/lib.rs` changed outside the control
                    of Entangled
           WARNING  `crates/web/src/dto.rs` changed outside the control
                    of Entangled
           WARNING  `crates/web/src/rest.rs` changed outside the control
                    of Entangled
           ERROR    conflicts found, breaking off (use `--force` to run anyway)
exit=0
```

`exit=0` 但**一个文件都没写**：随后 `grep -n "vol" web/src/layouts/DashboardGrid.tsx` **无** `vol: true`
命中 ⇒ 正是任务提示的「报 conflicts 却 exit 0 而不写文件」假绿。（根因：仓库 `.entangled/filedb.json`
记录的是「上次写入内容 digest」，而 `crates/web/*.rs` 等经 `scripts/stitch.sh` 回写路径更新过，
DB 已过期 ⇒ 非 force 模式一律拒绝写盘。这是仓库**既有状态**，非本次改动引入。）

### 3.2 写入方式：仓库既有的「隔离沙箱 scoped tangle」口径

`entangled tangle` 不支持按文件过滤（`--help` 仅 `-a/-f/-s`），且 `--force` **被明令禁止**在真实工作区使用
（ADR-018 D-F3-6：会用文档旧内容覆盖实现 = 回退成果）。因此按仓库既有方法学（`scripts/stitch.sh` 与
`scripts/check-tangle.sh` 的同一手法）在**临时沙箱**里生成，再**只把受影响的那一个生成物**拷回：

```bash
SBX=$(mktemp -d /tmp/tangle286.XXXXXX)
cp -a entangled.toml "$SBX/"; cp -a design "$SBX/"
(cd "$SBX" && entangled tangle -f)          # 空 DB + force，仅存在于隔离副本中
```

沙箱重生成的 139 个非 `design/` 生成物与仓库逐字节比对，**只有 1 个不同**（= 本次文档改动对应的那一个）：

```
=== files differing between sandbox-regen and repo (excluding design/, entangled.toml, .entangled) ===
139
DIFF web/src/layouts/DashboardGrid.tsx
```

差异内容恰好且仅为任务要求的一行：

```diff
--- /home/eestock/workspace/git/eestock/eestock-rs/web/src/layouts/DashboardGrid.tsx	2026-09-13 21:01:05
+++ /tmp/tangle286.fEjMpf/web/src/layouts/DashboardGrid.tsx	2026-09-15 22:18:16
@@ -5,7 +5,7 @@
 export const DASHBOARD_DEFAULTS = {
   period: '15m',                    // 周期：1m/5m/15m/1h/1d/1w(周)/1mo(月)，默认 15m
-  indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: false },
+  indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
   maWindows: [5, 10, 20],
```

随后**只拷贝该文件**回仓库（`cp -a "$SBX/web/src/layouts/DashboardGrid.tsx" …`），其它生成物一律不动。

### 3.3 生成物确已更新（grep + mtime + SHA-256）

grep 命中原文（文档第 216 行 / 生成物第 8 行）：

```
=== design doc line ===
216:  indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
=== generated line ===
8:  indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
```

mtime 对比（生成物**新于**文档）：

```
2026-09-15 22:17:57.228734618 +0800  design/06-web/01-dashboard.md
2026-09-15 22:18:16.215056409 +0800  web/src/layouts/DashboardGrid.tsx
doc mtime     = 1789481877.2287347
generated mtime = 1789481896.2150564
generated newer than doc: True
```

SHA-256（沙箱重生成 = 仓库拷贝，字节同一）：

```
b03f22f0a03d60e4b9565a84f54ad0c80b3660a15b80f23ae9ee513ba63e469b  web/src/layouts/DashboardGrid.tsx
b03f22f0a03d60e4b9565a84f54ad0c80b3660a15b80f23ae9ee513ba63e469b  /tmp/tangle286.fEjMpf/web/src/layouts/DashboardGrid.tsx
```

**二次独立复核**：另起一个全新空沙箱、再跑一次按文档重生成，与仓库文件 `cmp` 逐字节相同：

```
BYTE-IDENTICAL: repo generated file == fresh doc regeneration
```

---

## 4. 门禁原始输出

### 4.1 `cd web && ./node_modules/.bin/vitest run src/features/dashboard/volToggle.test.tsx`（exit 0）

```
 ✓ src/features/dashboard/volToggle.test.tsx (14 tests) 237ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  22:20:22
   Duration  1.51s (transform 363ms, setup 87ms, collect 519ms, tests 237ms, environment 273ms, prepare 172ms)
```

### 4.2 `cd web && ./node_modules/.bin/vitest run`（exit 0，全量）

```
 ✓ src/features/dashboard/volToggle.test.tsx (14 tests) 458ms

 Test Files  85 passed (85)
      Tests  789 passed (789)
   Start at  22:20:22
   Duration  6.62s (transform 3.38s, setup 3.48s, collect 13.50s, tests 33.20s, environment 26.04s, prepare 6.97s)
```

（测试条数与改动前基线一致：基线为 `789` 条中 `7 failed | 782 passed`；本次**未新增/未删除任何测试**，
只改夹具数据 ⇒ 789 条全绿。）

### 4.3 `cd web && ./node_modules/.bin/tsc -b`（exit 0，无输出）

```
$ ./node_modules/.bin/tsc -b
(no output)
tsc_exit=0
```

（改动过程中该命令曾真实报出 23 条 `error TS2741: Property 'vol' is missing…`，
逐条完成 §5 的必要夹具适配后归零——说明这不是增量缓存的假绿：它是「先红后绿」。）

### 4.4 `./scripts/check-tangle.sh`（exit 0）

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
exit=0
```

### 4.5 特权删除复核 grep（两条均无命中）

```
=== grep 'IndicatorName | .vol.' ===
grep1_exit=1
=== grep '=== .vol.' ===
grep2_exit=1
```

即 `KlineChart.tsx` 中既无类型逃逸 `IndicatorName | 'vol'`，也无 `=== 'vol'` 的恒 true 特例。

---

## 5. 既有测试适配逐条说明（必要适配 vs 削弱门禁）

**总原则**：`IndicatorName` 因生成物新增 `vol` 键而扩展 ⇒ 所有以 `Record<IndicatorName, boolean>` /
`Record<…5 个键…, boolean>` 形状构造 fixtures 的既有测试**在编译期必然失效**（tsc 真实报 23 条
`TS2741: Property 'vol' is missing`）。适配方式统一为：给夹具补上 `vol: true`。

`vol: true` 而非 `false` 的理由：改动前 `syncIndicators` **硬编码 `vol` 恒开** ⇒ 这些用例的运行时状态
本来就「有 VOL 副图」。补 `vol: true` 使**运行时行为与改动前逐字节等价**，从而**断言语义零变化**；
若补 `false` 反而是改变夹具语义（凭空删掉一个此前在场的副图 pane，可能改变 pane 计数类断言的输入）。
**本次没有改动任何一条断言语义（没有删除断言、没有放宽 matcher、没有改期望值）**，改动全部落在夹具数据上。

| # | 文件:行（改后行号） | 原夹具（改动前） | 新夹具 | 为什么是「必要适配」 |
|---|---|---|---|---|
| 1 | `KlineChart.realtime.test.tsx:71` | `const BASE_INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: false };` | 同左但插入 `vol: true` | tsc 必失败（缺 `vol` 键）；补 `true` 后与改动前「VOL 恒开」运行时完全一致。该文件断言实时标记/视口（与 VOL 无关），无断言被触碰 |
| 2 | `KlineChart.test.tsx:61` | `const BASE_INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: false };` | 插入 `vol: true` | 同上；该文件 7 处 `indicators={BASE_INDICATORS}` 全走同一夹具，改一处即修 7 条 TS 错 |
| 3 | `KlineChartDcapSaveLayout.test.tsx:297` | `const BASE_INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };` | 插入 `vol: true` | 该文件多处「拖拽 VOL 副图 + 保存 dcap/MA/warmup ⇒ pane 高度与 id 不变」的**前置断言直接读取 VOL pane**（`chart.getIndicators({name:'VOL'})[0].paneId`）；不补则前置取到 `undefined` ⇒ `TypeError`。补 `true` 恢复既有前置，断言本身（高度 ±1px / pane id 不变 / 无 create-remove churn）逐字未动 |
| 4 | `KlineChartDcapSaveLayout.test.tsx:510` | `indicators={{ ma: true, macd: true, kdj: true, boll: true, dcap: false }}` | 插入 `vol: true` | 「内置模板指标（VOL/MACD/KDJ/BOLL）创建时不得携带空 calcParams」这条守卫的 `for (const name of ['VOL',…])` 循环要求 VOL 真的被创建；补 `true` 使其回到改动前（VOL 恒开）的输入状态。守卫判据（`createIndicator` 参数中 `not.toContain('calcParams')`）未改、未放宽 |
| 5 | `KlineChartDcapSaveLayout.test.tsx:533` | `const tree = (indicators: Record<'ma' \| 'macd' \| 'kdj' \| 'boll' \| 'dcap', boolean>) => (` | 联合类型扩展为 `Record<'ma' \| 'vol' \| 'macd' \| 'kdj' \| 'boll' \| 'dcap', boolean>` | 这只是一个**局部类型标注**：它描述「本测试传入的开关集合」，而 `BASE_INDICATORS` 现在含 `vol` ⇒ 不收窄会 `TS2741`。断言（DCAP 关 ⇒ pane 移除；再开 ⇒ 重建且带参数）逐字未动 |
| 6 | `KlineChartSwitchLayout.test.tsx:338` | `const INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };` | 插入 `vol: true` | 该文件的 `dragPanes()` 明确「把 VOL / DCAP 拉高」，直接取 VOL pane id ⇒ 不补则 `TypeError`。断言（切 period/stock 后 pane 高度 ±1px、pane id 不变、无 create/remove、数据确实换）逐字未动 |
| 7 | `Toolbar.test.tsx:13` | `indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: false },`（`renderToolbar` 默认 props） | 插入 `vol: true` | tsc 必失败；该默认对象刻意镜像 `DASHBOARD_DEFAULTS`（其余键即默认值），故与新的 `DASHBOARD_DEFAULTS.indicators` 保持同构。本文件**没有任何**关于 VOL 存在/缺失或按钮数量的断言（已 grep 复核：唯一 `queryByRole` 是 `'MA 配置'`），故断言语义零变化 |
| 8 | `Toolbar.test.tsx:45` | `indicators={{ ma: true, macd: false, kdj: false, boll: false, dcap: false }}`（`MaConfigHarness`） | 插入 `vol: true` | 同上（MA 配置乐观更新/回滚测试，与 VOL 无关） |
| 9 | `multiPeriodLayoutAuthority.test.tsx:101` | `const INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };` | 插入 `vol: true` | tsc 必失败；补 `true` = 恢复改动前「VOL 恒开」的卫星输入（该文件断言高度权威/交还链路）。断言逐字未动 |
| 10 | `multiPeriodLayoutDom.test.tsx:144` | `const INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };` | 插入 `vol: true` | 同上（3 处使用点：163/180/501） |
| 11 | `multiPeriodLayoutHandshake.test.tsx:67` | `const INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };` | 插入 `vol: true` | 同上（高度交还/settle 语义） |

**未做的**（反面清单，证明没有削弱门禁）：
- 未改 `volToggle.test.tsx` 一个字符（tester 的红测试原样转绿）；
- 未删除/跳过（`.skip`/`.todo`）任何测试或断言；
- 未扩大容差、未把 `toEqual` 降级为 `toBeTruthy`、未改任何期望值；
- 未改后端/配置/MultiPeriodSatellite/multiPeriodStore。

---

## 6. 影响面复核与残余风险

**GitNexus 影响分析不可用（工具降级，已如实记录）**：项目规则要求编辑前跑
`impact({target, direction:"upstream"})`。本次 MCP/CLI 两条路径均失败：

```
$ node .gitnexus/run.cjs impact "syncIndicators" --direction upstream --repo .
{ "error": "LadybugDB unavailable for eestock-rs. Another process may be rebuilding the index.
  Retry later. (Runtime exception: Trying to read a database file with a different version.
  Database file version: 43, Current build storage version: 40)",
  "impactedCount": 0, "risk": "UNKNOWN" }
```

按规则，`risk: UNKNOWN` **不等于**低风险，必须用文本搜索复核调用方（已做）：

| 被改符号 | 可见性 | 文本搜索确认的调用方 |
|---|---|---|
| `syncIndicators` | 模块私有 | 仅 `KlineChart.tsx:155`（定义）/ `KlineChart.tsx:597`（唯一调用） |
| `desiredCalcParams` | 模块私有 | 仅 `KlineChart.tsx:137` / `:164` |
| `INDICATOR_DEFS` | 模块私有 | 仅 `KlineChart.tsx:111` / `:162` |
| `DEFAULT_INDICATORS` | 模块私有（栈内兜底） | 仅 `MultiPeriodChartStack.tsx:72` / `:112`（默认形参） |
| `INDICATORS`（Toolbar） | 模块私有 | 仅 `Toolbar.tsx:60` / `:205`（渲染循环） |
| `DASHBOARD_DEFAULTS` | 导出 | `Toolbar.tsx`（派生 `IndicatorName`）、`DashboardPage.tsx:111`（会话态初始化）、`store.ts:29-30`（只用 `period`/`view`）、`KlineResultChart.tsx:79`（工作台结果图直接用默认 indicators）、相关测试 |
| `IndicatorName` | 导出类型 | `Toolbar.tsx`、`KlineChart.tsx`、`MultiPeriodSatellite.tsx`、`MultiPeriodChartStack.tsx`、`DashboardPage.tsx` + 测试夹具（= §5 适配清单） |

**已复核的连带影响**：`web/src/features/workbench/KlineResultChart.tsx:79` 直接把
`DASHBOARD_DEFAULTS.indicators` 传给 `KlineChart` ⇒ 该图现在也拿到 `vol: true`。**但行为零变化**：
改动前 VOL 是硬编码恒开，工作台结果图本来就有 VOL 副图。相关测试（工作台/回测）全量绿。

**残余风险**（均非阻断）：
1. GitNexus 图数据库版本不匹配（DB 43 vs 存储 40），本次影响分析只能用文本搜索替代；
   需要父级/后续阶段跑 `npx gitnexus analyze` 重建索引后再做一次图级复核。
2. 真实浏览器中 VOL 开关依赖 klinecharts 内置 `VOL` 模板；本阶段只在 jsdom + 有状态迷你引擎下验证
   （与既有 `KlineChart*.test.tsx` 同一取舍），未做真机/真库渲染验证（本阶段禁止构建部署）。
3. 根目录 `entangled tangle` 的 filedb 过期是**既有**仓库状态（`crates/web/*.rs` 被标为
   "changed outside the control of Entangled"），本次未修复（超出任务范围）；`check-tangle.sh`
   按 ADR-018 已刻意不依赖 filedb，故门禁判据不受影响。

---

## 7. 声明

- **未改任何后端文件**：`crates/**` 零改动；`config` schema 零改动。
- **未改**：`web/src/features/dashboard/multiPeriodStore.ts`、`MultiPeriodSatellite.tsx`、
  `web/dist/**`、`/tmp/app_dev_8081.toml`（未触碰）。
- **未部署、未构建**：未执行任何 deploy/构建命令（`scripts/deploy.sh` 未运行）。
- **未发任何 `/api` 写请求**：未运行 curl/脚本对任何后端发起写请求；测试内的 HTTP 全部为
  vitest mock（`stubApi`/`vi.fn`），不发真实网络请求（R7-1 还额外断言 VOL 切换**不调用**
  `saveMaConfig`/`saveDcapConfig`/`saveMultiPeriodConfig`/`saveKlineConfig` 任何配置写接口）。
- **未 `git commit`**：仅 `git add` 暂存（见下方清单）。
- 本报告路径：`coder/report/286_vol_toggle_impl.md`。

### 暂存清单（`git add`，未 commit）

```
M design/06-web/01-dashboard.md
M web/src/layouts/DashboardGrid.tsx
M web/src/features/dashboard/Toolbar.tsx
M web/src/features/dashboard/KlineChart.tsx
M web/src/features/dashboard/MultiPeriodChartStack.tsx
M web/src/features/dashboard/KlineChart.realtime.test.tsx
M web/src/features/dashboard/KlineChart.test.tsx
M web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx
M web/src/features/dashboard/KlineChartSwitchLayout.test.tsx
M web/src/features/dashboard/Toolbar.test.tsx
M web/src/features/dashboard/multiPeriodLayoutAuthority.test.tsx
M web/src/features/dashboard/multiPeriodLayoutDom.test.tsx
M web/src/features/dashboard/multiPeriodLayoutHandshake.test.tsx
A web/src/features/dashboard/volToggle.test.tsx   （tester 产出，本阶段未修改）
```

---

## 8. 附录（2026-09-15 22:2x 追加）：全量套件的**既有**间歇性 flaky（与本次改动无关）

**结论（先给判据，后给数据）**：全量 `vitest run` 在本仓库存在**改动前就存在**的间歇性失败
（并行高负载下的 async 竞态），本次改动**不是**其成因，也**未**引入任何新的不稳定断言。

**观测 1 —— 改动后工作树（含 VOL 改动 + 14 条新红测试，共 789 条）连跑 12 次**：
10 次 `85 passed / 789 passed`，2 次各 1 条失败；其中一次抓到失败名：

```
 FAIL  src/features/strategies/StrategyEditorPage.test.tsx > StrategyEditorPage（策略编辑器 /strategies/:id/edit）
       > 加载：头部名称/描述 + 版本下拉默认最新版本（v2 draft）+ 状态徽章 + 代码入编辑器
AssertionError: expected '' to contain 'v2 draft 调整'
 ❯ src/features/strategies/StrategyEditorPage.test.tsx:60:78
```

**观测 2 —— 基线 HEAD（`8828d46`，`git worktree add --detach /tmp/base286 8828d46` + 软链 `node_modules`，
**无**本次改动、共 775 条）连跑 12 次**：同样 2 次失败，且**包含同一个文件同一条用例**：

```
baseline run9  -> Tests  1 failed | 774 passed (775)
 FAIL  src/features/dashboard/multiPeriodSyncBadge.test.tsx > T8bis-④/⑤ …
baseline run12 -> Tests  1 failed | 774 passed (775)
 FAIL  src/features/strategies/StrategyEditorPage.test.tsx > StrategyEditorPage … > 加载：头部名称/描述 + …
```

⇒ 双侧 flake 率同为 2/12，且 `StrategyEditorPage.test.tsx` 在基线也 flake ⇒ **pre-existing，非回归**。

**旁证**：`StrategyEditorPage.test.tsx` 未被本次改动触碰（`git status` 该路径为空），且其 import 面仅
`StrategyEditorPage` / `CodeEditor`（被打桩）/ `stubApi` / `MemoryRouter`，与 `DashboardGrid`、`Toolbar`、
`KlineChart`、多周期栈**无任何依赖关系**；单独跑该文件 10/10 全绿（只在全量并行时偶发）⇒ 典型负载竞态。

（worktree 已 `git worktree remove --force /tmp/base286` 清理；`git worktree list` 仅余本次任务之前就已存在的
`/tmp/dcap_ind_wt`、`/tmp/dcap_p5_wt`、`/tmp/p4a_baseline`。）

**最终门禁记录（工作树冻结、已暂存状态）**：

```
########## GATE 1: volToggle ##########   ✓ src/features/dashboard/volToggle.test.tsx (14 tests)
                                          Test Files 1 passed (1) / Tests 14 passed (14)
########## GATE 2: full vitest ########## Test Files 85 passed (85) / Tests 789 passed (789)   exit=0
########## GATE 3: tsc -b ##############  (no output) tsc_exit=0
########## GATE 4: check-tangle.sh #####  [check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改） tangle_exit=0
```

本附录不改变 §0–§7 的任何结论；仅补充「全量套件偶发失败 = 既有 flaky」的证据链。
