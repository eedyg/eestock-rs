# EVIDENCE — ADR-023 D2 收尾小修（mock↔契约 parity + §3.2 密度表补 30m 四行）

- 本文件绝对路径：`/tmp/adr023-d2-fixup-20260916-234640/EVIDENCE.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD（未变）：`3094018f352dae25752340d78b5e108c284aeecc`
- 时间盒：20 min；本会话未改行为契约、未提交、未 stage、未触碰活库/在线实例。
- 结论：**VERDICT: PASS**

---

## ① mock.ts 周期集合/排序/候选收窄 —— 全量扫描结果

`web/src/api/mock.ts` 里与「周期集合 / 排序 / 候选收窄」有关的位置（逐处）：

| # | 位置 | 形态 | 契约口径 | 对齐结果 |
|---|---|---|---|---|
| 1 | `mock.ts:92` `PERIOD_MS: Record<Period, number>` | **步长查找表**（非选择器集合；含 `30m`=1_800_000 与 `1mo`） | 键必须是**全部** `Period` 成员（TS 强制），供 `mock.ts:804 const step = PERIOD_MS[period]` 生成 K 线 | ✅ 已含 `30m`（D1 交付）；`1mo` 为合法时长条目（非候选面），无需改 |
| 2 | `mock.ts:211`（**唯一**周期序/集合点） `MOCK_MULTI_PERIOD_ORDER` | 多周期基准/卫星**周期序 + 合法集合 + 候选收窄**（`rank(p)` 判断卫星≥基准；含 `1w` 需基准≥`1d`） | 全集顺序 `1m,5m,15m,30m,1h,1d,1w`；`1mo` 不提供；`30m` 插在 `15m` 与 `1h` 之间 | ❌→✅：修复前 `order=['1m','5m','15m','1h','1d','1w']`（**缺 30m**，含 30m 配置被误判 400）；已改为 `MOCK_MULTI_PERIOD_ORDER=['1m','5m','15m','30m','1h','1d','1w']` |
| 3 | `mock.ts:194` `DEFAULT_MULTI_PERIOD_CONFIG.periods=['1m']` | 默认值（单基准 1m） | 与后端 `MultiPeriodConfigDto::default()` 同构 | ✅ 无需改（默认基准 1m，与契约一致） |
| 4 | `mock.ts:925` `range === '1h'` | **DetailRange**（详情区间），非周期档位 | 另一维度 | ✅ 无关 |
| 5 | `mock.ts:1003` `period: '1m'`；`1912-1923` `role: '1m'` | 固定字面量 / 源角色标签，非周期集合 | 另一维度 | ✅ 无关 |

**结论**：全仓 `web/src/api/mock.ts` 仅 **1 处**真正的「周期集合与顺序 + 候选收窄」逻辑（#2），另 1 处为必须含全成员的总映射（#1，已含 30m）。两处均已与真契约对齐。步骤 2 候选语义（`{P ≥ base}` 拒绝 + `1w` 在 base<1d 时拒绝）在 mock 中与后端 `validate_multi_period_config` 完全一致（`assertMultiPeriodConfig` 的 `rank(p) < baseRank` 与 `periods.includes('1w') && base !== '1d' && base !== '1w'` 两分支）。

### parity 断言落地位置

扩展**既有**同类 parity 测试（遵循「按其既有模式扩展，不另起口径」）：
- 文件：`web/src/api/multiPeriodMockParity.test.ts`（既有文件；原只消费 `contract-vectors.json` 行为向量）
- 新增 `describe('mock ↔ 契约：多周期周期集合与顺序 parity（MULTI_PERIOD_PICKER_PERIODS）')`，**3 条**断言：
  1. `MOCK_MULTI_PERIOD_ORDER` **逐项相等** `MULTI_PERIOD_PICKER_PERIODS`（含 30m、不含 1mo）；
  2. **接受集合**逐档反证：对候选集 `{1m,5m,15m,30m,1h,1d,1w,1mo}` 逐档经 `saveMultiPeriodConfig` 真实调用，`∈契约⇒200 / ∉契约（1mo）⇒400`；
  3. **顺序语义**逐对反证：8×7 对经 `saveMultiPeriodConfig`，`{P ≥ base}` + `1w 需基准≥1d` 与契约逐对一致。
- 为使断言 1 可「逐项相等」，mock.ts 将原局部 `const order=[...]` 提升为 **导出常量** `MOCK_MULTI_PERIOD_ORDER: string[]`（唯一真相在 mock 内部；跨层 import 到 `features/` 会引入 `api→features` 反向依赖，故未采用，避免架构改动）。断言 2/3 用**真实行为**反证，防止「常量漂移但校验仍用旧序」的假绿。

### 是否 doc-first？

**否，直接改手写文件**（已复核）：
- `design/06-web/09-frontend.md §1`「构建配置（手写例外，不 tangle）」明列 `web/src/` 下除 `layouts/*Grid.tsx` 骨架外**全部为手写工程代码**；
- `entangled.toml` 的 `watch_list = ["design/**/*.md"]`（仅 design 下 markdown 为事实源）；全仓 `grep 'file=' design/` **无任何**指向 `web/src/api/mock.ts` 的产物声明。
- ⇒ `mock.ts` 为手写，直接编辑即可，无需改文档/tangle。

---

## ② design/15-multi-period/02-spec.md §3.2 密度表 diff

**复核**：`grep -n 'file=\|tangle\|entangled' design/15-multi-period/02-spec.md` ⇒ 仅 1 处 prose 提及（第 197 行「不改 tangle 生成物」），**无 `file=` 产物声明** ⇒ 该文档非 tangle 生成物，直接改块，**无需 tangle**（与父级复核一致）。

既有 5 条 D 值行（1m→5m / 1m→15m / 1m→1h / 1d→1w / 1h→1w）与第 6 行（1m→1d/1m→1w）**逐字未动**；仅在 `1h→1w` 与第 6 行之间**新增 4 行**，并在表后加一段冻结口径注。

```diff
@@ -88,8 +88,17 @@ class ChartSyncGroup {
 | 1m→1h | 60 | 37.8 | +58 min | 1 | ❌ baseBS>7 时退化 |
 | **1d→1w** | 7 | **4.67** | **+4,320 min（+0.43 周 bar）** | 3 | ✅（必须用密度比） |
 | 1h→1w | 168 | 24 | +1,980 min | 1 | ❌ baseBS>11 时退化 |
+| **1m→30m** | 30 | **24.1**（包络 [24.0, 25.3]） | — | — | ✅ 直接实测（禁名义比兜底） |
+| **5m→30m** | 6 | **5.0**（包络 [4.84, 5.08]） | — | — | ✅ 直接实测（禁名义比兜底） |
+| **15m→30m** | 2 | **1.8** | — | — | ✅ 直接实测（禁名义比兜底） |
+| **30m→1h** | 2 | **1.67** | — | — | ✅ 直接实测（禁名义比兜底） |
 | 1m→1d / 1m→1w | 1440 / 10080 | 120.5 / 无重叠 | 失效 | 1 | ❌ 恒退化 |
 
+> **30m 四行（ADR-023 D2 冻结实测，2026-09-16）**：口径 = **真渲染 pane 520px，同窗基准 bar 数 / 卫星 bar 数**（与既有行同法），
+> 取 K8/K16 等时窗中位数 = `1m:30m` **24.1**、`5m:30m` **5.0**、`15m:30m` **1.8**、`30m:1h` **1.67**；
+> **禁名义比兜底**（名义比 30 / 6 / 2 / 2 一律不得使用——30m 为 1m 本地衍生 cagg，非连续序列下名义比不成立）。
+> `@baseBS=8 误差` / `卫星可见 bar @baseBS=50` 两列属 P0.3 口径，本轮 D2 冻结集未量取 ⇒ 标 `—`（**不得**以名义比反推填充）。
+
```
（同文件另有 D2 前序未提交改动：§3.2 第 4 条 `none` 源清单补 `30m` —— 非本会话所改，见 `git status`。）

**未触及**：`design/15-multi-period/01-adr.md`（ADR-022 历史正文）——本会话零改动。**未触及** `composed`/`measured` 解析优先级。

---

## V1 门禁（原始输出）

命令：`./scripts/check-tangle.sh`（仓库根）

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
V1 exit=0
```

## V2 前端全量

### V2a `npx vitest run`

```
 Test Files  88 passed (88)
      Tests  839 passed (839)
   Duration  6.68s (transform 3.24s, setup 3.59s, collect 12.93s, tests 33.80s, environment 27.70s, prepare 6.88s)
```

（新增 parity 断言使 `web/src/api/multiPeriodMockParity.test.ts` 由 20→23 条，全绿；全量 839 passed。）

### V2b `npm run build`

```
vite v6.4.3 building for production...
✓ 180 modules transformed.
dist/index.html                     0.40 kB │ gzip:   0.30 kB
dist/assets/index-BpQVDpqf.css     22.93 kB │ gzip:   5.76 kB
dist/assets/index-J50SI06a.js   1,217.84 kB │ gzip: 375.83 kB
✓ built in 1.88s
BUILD_EXIT=0
```

## V3 变红反证（**在 /tmp 仓库副本内**做变异，仓库本体零变异）

副本：`/tmp/adr023-d2-fixup-20260916-234640/mut`（`web/`（排除 node_modules/dist）+ `design/15-multi-period/contract-vectors.json`，`node_modules` 软链原件）。
命令：`cd mut/web && npx vitest run src/api/multiPeriodMockParity.test.ts`

```
===== baseline (both restored) =====
 Test Files  1 passed (1)
      Tests  23 passed (23)

===== MUTATION A: mock order 去掉 30m =====
mock order = MOCK_MULTI_PERIOD_ORDER: string[] = ['1m', '5m', '15m', '1h', '1d', '1w'];
⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯
 FAIL  ... > mock 周期序逐项相等 MULTI_PERIOD_PICKER_PERIODS（含 30m，不含 1mo）
 FAIL  ... > mock 接受集合 == 契约集合（逐档反证：含 30m 接受、含 1mo 拒绝）
 FAIL  ... > mock 顺序语义 == 契约（{P ≥ base} + 1w 需基准 ≥ 1d）逐对反证
 Test Files  1 failed (1)
      Tests  3 failed | 20 passed (23)

===== MUTATION B: parity 断言期望改错（漏 30m）=====
⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯
 FAIL  ... > mock 周期序逐项相等 MULTI_PERIOD_PICKER_PERIODS（含 30m，不含 1mo）
 Test Files  1 failed (1)
      Tests  1 failed | 22 passed (23)

===== restored after mutation =====
 Test Files  1 passed (1)
      Tests  23 passed (23)
```

**对照**：未变异 23 pass ⇒ 变异 A（mock 去 30m）3 红、变异 B（期望改错）1 红 ⇒ 新 parity 断言**确能变红**。
（早先一次捕获脚本因 A 未复位即叠加 B 而污染为 2 红，已弃用并按上式重测；仓库本体从未变异。）

## V4 零副作用

命令：`git status --short` / `git rev-parse HEAD` / `git diff --cached --stat`

```
HEAD: 3094018f352dae25752340d78b5e108c284aeecc   （与任务 baseline 一致 ⇒ HEAD 未变）
--- staged ---
（空 ⇒ 无 staged）
```

本会话净改动（相对会话前快照）**仅 3 个文件**：
- `M web/src/api/mock.ts`（会话前本就 M，本会话只加 export + 换用常量）
- `M web/src/api/multiPeriodMockParity.test.ts`（本会话新增改动）
- `M design/15-multi-period/02-spec.md`（会话前本就 M，本会话加 4 行 + 注）

`git status` 其余 `M`/`??` 条目均为**会话前既有**的工作树状态（D1/D2 前序、tester/、coder/ 报告等），本会话未触碰。
`web/dist` 由 `npm run build` 重新生成但被 `.gitignore` 忽略（`git check-ignore web/dist` 命中）⇒ 无仓库残留。`/tmp` 副本与证据均在仓外。

---

## 残留风险 / 须父级知情

1. **§3.2 表两列标 `—`**：`@baseBS=8 误差` 与 `卫星可见 bar @baseBS=50` 属 P0.3 口径，本轮 D2 冻结集（任务给定）**只含 D 值与包络**，故这两列标 `—` 并以注说明「不得以名义比反推」。若父级希望补齐这两列的**真渲染实测值**（D2 只读证据 `/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md` 的 bs=8/bs=50 行内有原始数据），需另开小任务按 P0.3 同一估计器量取后填。
2. **`MOCK_MULTI_PERIOD_ORDER` 为新增导出**（mock.ts 内部常量提升）。仅为可测试性；未改任何函数签名/对外 ApiClient 契约、未引入依赖、未跨层 import。若父级评审认为 dev-double 不宜扩导出，可改为纯行为 parity（现有断言 2/3 已可独立变红），删断言 1 即可。
3. **既有 5 条旧值债未动**（`1m:15m=12.2` 等）：属 ADR-023 §6.1 第 7 条 / F5 的独立债，本轮按令**逐字保留**。
4. **`composed`/`measured` 解析优先级未动**（F5 待用户裁决）。
