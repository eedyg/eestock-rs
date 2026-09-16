# EVIDENCE — ADR-023 D2 离线独立验收（只验不改）

- **本报告绝对路径**：`/tmp/adr023-d2-verify-offline-20260916T155256Z/EVIDENCE.md`
- **VERDICT: PASS**
- 日期（UTC）：2026-09-16 15:52–16:02（本地 23:52–00:02）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD（开工/收工逐字节相同）：`3094018f352dae25752340d78b5e108c284aeecc`
- 被验对象：`coder/report/291_adr023_period30m_d2_impl.md`（D2 实现）+ `coder/report/292_adr023_d2_fixup.md`（收尾小修）**的自报 PASS 未被采信**；本报告全部结论由独立命令复算得出。
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §2.5 / §5.3(D2) / §6.1 第 7–8 条 / §6.2
- 纪律遵守：未改仓库任何文件（含未新建 tester 报告；本文件落在 `/tmp`，见 A7）、未 `git add/commit/stash`、未 `--force`、未重启/杀死 app（PID 68833 全程存活）、未对 `:5433`/`:8081`/`:8082` 发任何写 API、未做浏览器会话（故无需 `app_config` 浏览器前置快照；仍按 §6.2 做了只读 SQL 快照，见 A7）。
- 证据文件清单见文末 §F。

---

## 0. 结论摘要

| 判据 | 结论 |
|---|---|
| A1 multiPeriodPicker.test.tsx 结构性复核 | **PASS**（计数逐项一致 83/17/19/5/6；三条期望与契约推导逐项等价，已用独立契约模型可执行复算） |
| A2 改动集逐条对齐契约 + 四条密度值独立重算 | **PASS**（四条冻结值与 tester 原始实测**逐条一致**；改动集 6 处逐条命中） |
| A3 变异反证（/tmp 副本） | **PASS**（a: 去 mock 30m ⇒ 3 红；b: 15m:30m 改 1.9754 ⇒ 2 红含不变量；附加 b2: 删条目 ⇒ 不变量 source='composed' 红） |
| A4 全量回归独立复跑 | **PASS**（vitest 88/839；build 0；cargo 88 目标 721 passed/0 failed/1 ignored；tangle 0；与 worker 自报**零差异**） |
| A5 诚实降级复核 | **PASS**（5 条原因码逐条命中；30m 与 7 档已提供周期的**任一**配对均不返回 `unsupported-period`） |
| A6 边界与不变量 | **PASS**（1mo 仍不提供；既有 5 条密度值逐字未变；01-adr.md 逐字节未变；`static→composed→measured→none` 优先级未动） |
| A7 副作用审计 | **PASS**（版本化文件全体逐字节相同；HEAD 未变；无 staged；无残留；活库 `app_config` 未变；app 未触碰） |

---

## A1 multiPeriodPicker.test.tsx 结构性复核（强制项）

### 方法与命令

```bash
git show HEAD:web/src/features/dashboard/multiPeriodPicker.test.tsx > $E/A1_picker_test_BEFORE.tsx
cp web/src/features/dashboard/multiPeriodPicker.test.tsx            $E/A1_picker_test_AFTER.tsx
for t in 'expect(' 'it(' 'describe(' 'toEqual(' 'toContain(' 'filter(' 'not.toContain(' 'toHaveLength(' 'toBe(' 'toBeTruthy(' 'toBeNull('; do
  printf '%-16s %s\n' "$t" "$(grep -o -F "$t" <file> | wc -l)"; done
git diff --word-diff=porcelain -- web/src/features/dashboard/multiPeriodPicker.test.tsx
```

### (a) 断言条数与类型计数（BEFORE = HEAD 版；AFTER = 工作区）

| token | BEFORE | AFTER | Δ |
|---|---|---|---|
| `expect(` | 83 | 83 | 0 |
| `it(` | 17 | 17 | 0 |
| `describe(` | 4 | 4 | 0 |
| `toEqual(` | 19 | 19 | 0 |
| `toContain(` | 5 | 5 | 0 |
| `not.toContain(` | 3 | 3 | 0 |
| `filter(` | 6 | 6 | 0 |
| `toHaveLength(` | 2 | 2 | 0 |
| `toBe(` | 33 | 33 | 0 |
| `toBeTruthy(` | 1 | 1 | 0 |
| `toBeNull(` | 14 | 14 | 0 |

文件行数 BEFORE=713 / AFTER=713；sha256 BEFORE `79736741…` / AFTER `9242fcf5…`（内容仅 3 处字面量 + 1 处描述串，见下）。
交叉校验：`npx vitest run` 报告该文件 **17 tests**，与 `it(` 计数一致（无 `.skip`/`.only` 隐藏用例：全量跑里该文件 17 passed）。

`git diff --word-diff=porcelain` 的**全部**变更行（逐字符级，非行级 diff 文本）：

```
-1m/5m/15m/1h/1d/1w）',        +1m/5m/15m/30m/1h/1d/1w）',       (A1 用例标题，描述串)
-{15m,1h,1d}（1w              +{15m,30m,1h,1d}（1w             (A2 断言理由串)
+'30m',                        (A1 期望数组 1 处)
+'30m',                        (A2 期望数组 1 处)
+'30m',                        (B1 期望数组 1 处)
```
⇒ 无删断言、无 `toEqual`→`toContain` 放宽、无新增 `filter` 吞档位、无新增 skip。

### (b) 三条期望值是否等价于契约推导（不只看 diff：用**独立契约模型**可执行复算）

独立复算脚本（写在 `/tmp` 沙箱副本 `src/__verifyA1.verify.test.ts`，**不依赖被改测试的期望值、不依赖实现源码推理**：契约模型 `contractEnabled(base)` 由 ADR-023 §2.5 口径 1/口径 10 手写，全集顺序 `1m,5m,15m,30m,1h,1d,1w`）：

```
[A1] step1 = ["1m","5m","15m","30m","1h","1d","1w"]
[A1] base=15m enabled = ["15m","30m","1h","1d"] ; all = ["15m","30m","1h","1d","1w"]
[A1] base=1d  enabled = ["1d","1w"]
[A1] all bases = 1m=>[1m,5m,15m,30m,1h,1d] 5m=>[5m,15m,30m,1h,1d] 15m=>[15m,30m,1h,1d]
      30m=>[30m,1h,1d] 1h=>[1h,1d] 1d=>[1d,1w] 1w=>[1w]
Tests  4 passed (4)   EXIT=0
```

推导（手工，与脚本一致）：rank(1m,5m,15m,30m,1h,1d,1w)=0..6。
- `base=15m`（rank=2）⇒ `{P | rank(P) ≥ 2}` = `15m,30m,1h,1d,1w`；`1w` 因 `rank(base)=2 < rank(1d)=5` 被禁 ⇒ **enabled 恰为 `15m,30m,1h,1d`** ✔（等于新字面量）
- `base=1d`（rank=5）⇒ `1d,1w` 全 enabled，**与 D2 无关**（不受新增 30m 影响）✔
- 步骤 1 全集 = 7 档含 `30m`、不含 `1mo` ✔
- 7 个基准档全覆盖的 enabled 集合均与契约模型逐项相等（含 `30m` 作为基准时 `{30m,1h,1d}`、`1w` 禁用）

### (c) 是否引入放宽

**否**。证据：类型计数全等（上表）；`--word-diff` 全文只含 3 个 `+'30m',` 与 2 处描述串；`toEqual` 仍作用于 `filter(o => o.enabled).map(o => o.period)` 的**精确数组**（未改 `toContain`、未加 `toMatchObject`、未把断言包进 try/条件分支）。

**A1 结论：PASS。**

---

## A2 改动集逐条对齐契约 + 四条密度值独立重算

### (a) 改动集逐条核对（每条给出命中原文）

| # | 文件 | 契约要求 | 实测命中 | 结论 |
|---|---|---|---|---|
| 1 | `crates/web/src/dto.rs`（tangle 产物） | `MULTI_PERIOD_ALLOWED` 含 `30m` 且 `multi_period_rank` 位置正确（15m(2) 与 1h(3) 之间） | L138 `pub const MULTI_PERIOD_ALLOWED: &[&str] = &["1m","5m","15m","30m","1h","1d","1w"];`；L154-165 `"1m"=>0,"5m"=>1,"15m"=>2,"30m"=>3,"1h"=>4,"1d"=>5,"1w"=>6,_=>None` | ✔ |
| 2 | `web/src/features/dashboard/multiPeriodPicker.tsx` | 7 档镜像 | L25 `export const MULTI_PERIOD_PICKER_PERIODS: Period[] = ['1m','5m','15m','30m','1h','1d','1w'];` | ✔ |
| 3 | `web/src/features/dashboard/chartSyncGroup.ts` | 4 条冻结密度值 + `periodOrder` 含 30m | 表体新增 `'1m:30m':24.1 / '5m:30m':5.0 / '15m:30m':1.8 / '30m:1h':1.67`；`periodOrder` 变 `15m=3 → 30m=4 → 1h=5 → 1d=6 → 1w=7` | ✔ |
| 4 | `web/src/api/mock.ts` | 周期序含 30m | L211 `export const MOCK_MULTI_PERIOD_ORDER: string[] = ['1m','5m','15m','30m','1h','1d','1w'];`；L221 `const order = MOCK_MULTI_PERIOD_ORDER;` | ✔ |
| 5 | `web/src/api/multiPeriodMockParity.test.ts` | 新增 3 条 parity 断言 | `it(` 计数 2→5（该文件 20→23 用例，vitest 实测 23 passed）；新增 describe `mock ↔ 契约：多周期周期集合与顺序 parity`（集合逐项相等 / 接受集合逐档反证 / 顺序语义 8×7 逐对反证） | ✔ |
| 6 | `design/15-multi-period/02-spec.md` §3.2 | 新增 4 行 | `+ **1m→30m** 30 24.1(包络[24.0,25.3])`、`+ **5m→30m** 6 5.0(包络[4.84,5.08])`、`+ **15m→30m** 2 1.8`、`+ **30m→1h** 2 1.67` + 冻结口径注；既有 5 行内联 diff 未变 | ✔ |

补充：`design/07-app-plane/00-web-api.md`（事实源）同样含 `MULTI_PERIOD_ALLOWED = [...,"30m",...]`（L2744）与 `"30m" => Some(3)`（L2765），与 `dto.rs` 一致（doc-first 一致，且 `check-tangle` 沙箱重生成逐字节通过，见 A4）。

### (b) 四条密度值**独立重算**（引用 tester 原始实测 `/tmp/adr023-d2-red-20260916T152240Z/probe_result{,_b}.json`，**未重测**）

重算方法（脚本原文存 `A2_density_recompute.txt`）：直接从 probe JSON 的
① `kStats.K8/K16.detail[].r` 重算等时窗中位数（既有 5 条表值的同一估计器）；
② `perDayCounts` 逐整日 `base/day ÷ sat/day` 硬底；③ `samples[].D_sameWindow / D_sameWindowFloor` 包络。

| 配对 | 冻结表值（ADR §2.5 / 实现） | ①K8 中位（我重算） | ①K16 中位（我重算） | ②逐整日（我重算） | ③真渲染包络（我重算） | 结论 |
|---|---|---|---|---|---|---|
| `1m:30m` | 24.1 | **24.1**（valid 5） | **24.1**（valid 6） | **241/10 = 24.1**（4 个整日全同） | bs=1：D_ceil 25.2632 / D_floor 24.0（⇒ 24.1 被夹住） | **一致** |
| `5m:30m` | 5.0 | **5.0**（valid 8） | **5.0**（valid 13） | **50/10 = 5.0**（20 个整日全同） | bs=1：5.0 / 4.9485 | **一致** |
| `15m:30m` | 1.8 | **1.8**（valid 8） | **1.8**（valid 16） | **18/10 = 1.8**（全部整日） | bs=1：1.7978 / 1.7978（→1.8） | **一致** |
| `30m:1h` | 1.67 | **1.6667**（valid 8） | **1.6667**（valid 16） | **10/6 = 1.6667**（全部整日） | bs=1：1.6725 / 1.6667 | **一致**（1.6667 取 2 位 = 1.67） |

结论：**四条冻结值与 tester 自己的原始实测逐条一致**，且均**不等于**名义比（30 / 6 / 2 / 2）⇒ 未触犯「禁名义比兜底」。
旁证复核（债的证据，未改）：同法重算 `1m:15m` = **13.3889**（K8/K16 中位与 241/18 逐整日均同），而表值仍是 **12.2** ⇒ 与 ADR §6.1 第 7 条「证据 A」一致（旧值窗口相关，本轮按令未改）。

**包络列的小瑕疵（不影响四条值）**：`1m:30m [24.0,25.3]` 与 `30m:1h [1.63,1.69]` 可从原始样本**精确复现**（分别是 bs=1 的 D_floor/D_ceil、bs=16/bs=10 的 D_ceil）；而 `5m:30m [4.84,5.08]`、`15m:30m [1.78,1.81]` 的两个端点各自都存在于原始样本中（如 4.84=bs4 的 D_floor、5.0833=bs8 的 D_ceil），但**「day 尺度」子集的筛选规则未在文档中精确定义**，无法逐字节复现同一子集。另注：ADR §2.5 表格给 `15m:30m` 的包络写作 `[1.63, 1.69]→直接实测 1.800`，与 tester 文件的 `[1.78,1.81]` **不一致**，且 `[1.63,1.69]` 恰是 `30m:1h` 的包络 ⇒ 疑为 ADR 表格该行包络列串行（**纯文档瑕疵，不影响 1.8 这个冻结值与实现**）。见 §R 残留风险 3。

**A2 结论：PASS。**

---

## A3 独立复现变异反证（全部只在 `/tmp` 仓库副本内；仓库本体零变异）

沙箱：`$E/mutant`（`tar` 复制 `web/`，`node_modules` 与 `design/` 以符号链接接回真实仓库只读使用）。
基线（未变异）：`Tests 44 passed (44)`（`period30mD2.test.ts` 21 + `multiPeriodMockParity.test.ts` 23），EXIT=0。

| 变异 | 命中位置 | 期望 | 实测红况 | 结果 |
|---|---|---|---|---|
| **(a)** mock 去 30m | `src/api/mock.ts` `MOCK_MULTI_PERIOD_ORDER` 去掉 `'30m'` | parity 断言变红 | **3 红**：①「mock 周期序逐项相等」`expected ['1m','5m','15m','1h','1d','1w'] to deeply equal [Array(7)]`；②「mock 接受集合 == 契约集合」`promise rejected "ApiError: HTTP 400: periods 基准周期非法：30m" instead of resolving`；③「顺序语义逐对反证」红。既有向量 parity 20 条仍绿 | ✔ 与 292 自报「3 红」一致 |
| **(b)** 15m:30m 改合成值 | `src/features/dashboard/chartSyncGroup.ts` `'15m:30m': 1.8` → `1.9754` | 不变量断言（source=static 且比值=实测）变红 | **2 红**：①直接条目等值断言 `实际 = 1.9754`；②**不变量断言** `15m:30m 的解析比值必须 == 直接实测 1.8（±0.01）；实际 = 1.9754`。`Tests 2 failed \| 19 passed (21)` | ✔ |
| **(b2)** 附加（我加的更强反证）：整条删除 `'15m:30m'` | 同上 | 不变量 source 子句必须变红 | **4 红**，其中不变量断言给出 `必须由**直接实测条目**解析（source='static'）；实际 = composed`（= 静默错对齐路径被真正抓住）；另有「四条齐备」「表恰好 9 键」红 | ✔ 证明不变量非空转 |

变异后对照：每次变异均 `cp` 还原并重跑基线 ⇒ `Tests 44 passed (44)`，沙箱复原（`chartSyncGroup.ts` sha256 `2ca9792c…`，与仓库一致）。
**仓库本体从未变异**（A7 的哈希审计为证）。

**A3 结论：PASS。**

---

## A4 全量回归独立复跑（命令原文 + 原始计数）

| # | 命令（cwd） | 原始输出摘要 | EXIT |
|---|---|---|---|
| 1 | `npx vitest run`（`web/`） | `Test Files 88 passed (88)` / `Tests 839 passed (839)` | 0 |
| 2 | `npm run build`（`web/`） | `tsc -b && vite build`；`✓ 180 modules transformed`；`dist/assets/index-J50SI06a.js 1,217.84 kB`；`✓ built in 1.87s` | 0 |
| 3 | `cargo test --workspace --tests` | `88` 条 `test result: ok`；合计 **passed 721 / failed 0 / ignored 1**；`CARGO_EXIT=0` | 0 |
| 4 | `./scripts/check-tangle.sh` | `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。` | 0 |

D2 相关测试目标（本次独立复跑实测）：
`period30m_d2_multiperiod_red.rs` **6 passed**；`period30m_scope_guard.rs` **3 passed**；`period30m_api_contract.rs` 2；`period30m_contract.rs` 1；`period30m_expected_relations.rs` 2；`period30m_migration.rs` 5；`period30m_period_str.rs` 2；`period30m_read_source.rs` 5。
前端：`period30mD2.test.ts` **21**；`period30m.test.tsx` **9**；`multiPeriodPicker.test.tsx` **17**；`multiPeriodMockParity.test.ts` **23**。

### 与 worker 自报计数对照

| 项 | worker 自报（291 / 292） | 我实测 | 差异 |
|---|---|---|---|
| vitest | 291: 836 passed / 88 files；292: 839 passed | **839 passed / 88 files** | 0（836→839 的 +3 = 292 新增 parity 3 条，自洽） |
| build | 291/292: exit 0 | exit 0 | 0 |
| cargo `--workspace --tests` | 291: 88× ok、721 passed / 0 failed / 1 ignored | **同** | **0** |
| check-tangle | 0 | 0 | 0 |
| D2 目标计数 | 6/3/21/9/23 | 同 | 0 |

**无差异 ⇒ 无需解释性说明**（唯一需说明的是 291 的 836 与 292 的 839 之间 +3，已由 292 新增 3 条 parity 断言解释，且我实测 839）。

**A4 结论：PASS。**

---

## A5 诚实降级复核（独立可执行复算）

独立脚本 `src/__verifyA5A6.verify.test.ts`（/tmp 沙箱，直接 import 真实现），原始输出：

```
[A5] 30m->1d: allowed=false reason=no-shared-anchor
     30m->1w: allowed=false reason=week-requires-day-or-above
     1h->30m: allowed=false reason=satellite-lower-than-base
     1d->30m: allowed=false reason=satellite-lower-than-base
     15m->30m: allowed=true  reason=null
[A5 matrix all] 1m->30m:allow 30m->1m:deny:satellite-lower-than-base 5m->30m:allow 30m->5m:deny:satellite-lower-than-base
                15m->30m:allow 30m->15m:deny:satellite-lower-than-base 30m->30m:allow
                1h->30m:deny:satellite-lower-than-base 30m->1h:allow
                1d->30m:deny:satellite-lower-than-base 30m->1d:deny:no-shared-anchor
                1w->30m:deny:satellite-lower-than-base 30m->1w:deny:week-requires-day-or-above
                1mo->30m:deny:unsupported-period 30m->1mo:deny:unsupported-period
Tests 5 passed (5)  EXIT=0
```

- `30m→1d` = `no-shared-anchor` ✔；`30m→1w` = `week-requires-day-or-above` ✔（由原因码优先级决定，是**正确码**，不是泛化 `unsupported-period`）
- `1h→30m`、`1d→30m` = `satellite-lower-than-base` ✔；`15m→30m` 放行（`allowed=true`，`reason=null`）✔
- **零 `unsupported-period`**：对 `{1m,5m,15m,30m,1h,1d,1w} × {30m}` 的双向配对（含 `30m→30m`）逐一断言，**没有任何**配对返回 `unsupported-period`，且每个拒绝都有非空原因码（offenders = []）✔
- 仅 `1mo` / 未知周期（`30x`）相关配对返回 `unsupported-period` —— 这是**应有**行为（A6 要求 1mo 仍不提供）

**A5 结论：PASS。**

---

## A6 边界与不变量（独立可执行 + 逐字节比对）

| 项 | 命令/方法 | 原始证据 | 结论 |
|---|---|---|---|
| 1mo 仍不提供 | 独立脚本断言 + grep | `MULTI_PERIOD_PICKER_PERIODS` 不含 `1mo`；`PERIOD_BUCKET_MS['1mo'] === undefined`；`isSyncCombinationAllowed('1m','1mo') === false` 且 `syncExclusionReason === 'unsupported-period'`；`isSyncCombinationAllowed('1d','1mo') === false`。全部通过 | ✔ |
| 既有 5 条密度值逐字未变 | 提取 HEAD 与工作区表体逐行 `diff` | `diff` 输出**只有 `6a7,14` 纯新增**（4 条 30m 条目 + 3 行注释）；`'1m:5m':4.7 / '1m:15m':12.2 / '1m:1h':37.8 / '1d:1w':4.67 / '1h:1w':24` 五行与 HEAD **逐字节相同**；表键总数 5→9（恰 +4） | ✔ |
| `design/15-multi-period/01-adr.md`（ADR-022 历史正文）未被改动 | `git status --porcelain -- <path>`（空）+ 哈希 | `git show HEAD:…01-adr.md \| sha256sum` = 工作区 `sha256sum` = `c83fc31bd633d495548f57ca9ba1ef57e86870d6b89be1e5a9f896f836d37605` | ✔ |
| `composed`/`measured` 解析优先级未改动（ADR §6.1 第 7 条约定本轮不动） | HEAD vs 工作区 `effectiveDensity` 函数体逐行比对 + `composeDensity` 函数体哈希 | `effectiveDensity` 体：`static → composed → measured → none` 与 HEAD 逐行相同（仅整体下移 10 行）；`composeDensity` 函数体 sha256 HEAD=工作区=`4889ecae7c1c8e04e770027a7fb89a58517dfd52827aac8a9c4bc6949489172d` | ✔ |
| `PERIOD_BUCKET_MS` 既有档位未变、新增 30m=1800000 | 独立脚本 | `1m/5m/15m/1h/1d/1w` = 60000/300000/900000/3600000/86400000/604800000 全部未变；`'30m' === 1_800_000` | ✔ |

补充（A1/A2 口径的全域扫描，独立于 worker 的「受影响测试全域扫描」自述）：`grep -rn "'15m', *'1h'\|15m/1h"` 在全仓（web/src、crates、相关 design）命中若干**历史上就不含 30m** 的测试夹具/标题（`Toolbar.test.tsx:58-60`、`feed.test.ts:15`、`mock.test.ts:687`、`multiPeriodSatellite*.test.tsx`、`syncCoverage.test.ts:343` 等）。它们要么是**子集夹具**（如卫星 `['1m','5m','15m','1h']`），要么是**存在性循环**（`Toolbar.test.tsx` 对 7 个按钮逐个 `getByRole` 存在性断言，非集合相等），全部仍然通过；真正的**严格 8 档顺序断言**由 `period30m.test.tsx` J8-b 覆盖（`expect(got).toEqual(['1m','5m','15m','30m','1h','日','周','月'])`）。⇒ 无「旧契约残留导致假绿」的实例；`Toolbar.test.tsx` 的标题/覆盖未随 D1/D2 更新，属文档级陈旧（见 §R 残留风险 2）。

**A6 结论：PASS。**

---

## A7 副作用审计（逐字节/进程/库）

| 检查 | 命令 | 开工前 | 收工后 | 结论 |
|---|---|---|---|---|
| HEAD | `git rev-parse HEAD` | `3094018f352dae25752340d78b5e108c284aeecc` | 同 | 未变 ✔ |
| `git status --porcelain` | 全文 diff | 92 行（存 `status_before.txt`） | 92 行（`status_after.txt`） | `diff` ⇒ **STATUS_IDENTICAL** ✔ |
| staged | `git diff --cached --name-only \| wc -l` | — | `0` | 无 staged ✔（未 `git add/commit/stash`；`git stash list` 计数 0；`.git/index` mtime `2026-09-16 00:00:32 +0800` = 今日开工前） |
| 版本化文件整体 | `git ls-files -z \| xargs -0 sha256sum \| sha256sum` | `bdcc3df4c5c99d3e73fd94673abd09e706b7a2001bd2a783d79b75b02af1affb` | **同值** | 逐字节相同 ✔ |
| 未跟踪非忽略文件整体 | `git status ?? → sha256` | `b45ef1075aa718825f5f11417c7f2058c9d2a0d3e09731abff3cae0f24b3a779` | **同值** | 逐字节相同 ✔（我未在仓库内新建任何文件，含 tester 报告） |
| 临时残留 | `find . -newermt "2026-09-16 23:52:00" -type f`（排除 target/node_modules/dist/.git/data） | — | **空** | 无残留 ✔ |
| 活库 `app_config` | 只读 `psql -Atc "select key,value::text,updated_at::text from app_config order by key"` | 1 行：`dcap\|{...}\|2026-09-13 15:27:38.121703+00` | **逐字节同** | 未触活库写 ✔ |
| 在线 app / 端口 | `ps -o pid,etime,cmd -p 68833`；`ss -ltn` | PID 68833 alive（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，etime 43:05） | PID 68833 **alive**（etime 46:35）；`:5433`/`:8081`/`:8082` 仍在监听 | 未重启/未杀死/未触碰 ✔ |
| 写 API | 全程未发任何 `PUT/POST/DELETE` 到 `:5433`/`:8081`/`:8082` | — | 无 | ✔ |
| `web/dist`（被 `:8081` 在线 app 服务的静态目录） | `find web/dist -type f \| xargs sha256sum` 前后对比 | 3 文件（`index-BpQVDpqf.css` / `index-J50SI06a.js` / `index.html`） | **逐字节相同**⇒ `DIST_IDENTICAL` | `npm run build` 未改变在线产物（重建确定）✔ |
| gitignore 缓存（唯一被触碰项，如实披露） | `find web/node_modules/.vite -newermt …` | — | 仅 `web/node_modules/.vite/vitest/<hash>/results.json`（vitest 运行缓存；`git check-ignore` 命中 `.gitignore:5 node_modules/`）；`web/dist`、`target/` 同属 gitignore | 不属版本化内容；由「必须执行 A4 命令」不可避免产生 ✔（已披露） |

关于 `cargo test --workspace --tests` 的库写入面（**主动披露**）：该命令下的既有集成测试会向**共享 dev 库**（`127.0.0.1:5433`）写入**自带清理**的临时行（如 `code='999999'`、自建 app_config 键、`api_multi_period_config.rs` 的 `multi_period` 键增删）。本次实测：运行前后 `app_config` **只有 `dcap` 一行且逐字节未变**（该键当前不存在 ⇒ `api_multi_period_config.rs` 的「清键 → PUT(enabled=false) → 清键」收敛回「无键 = 现状」；`api_settings.rs` 删的 `sources/collector/mcp` 亦本不存在）⇒ 对在线 app 的**净影响为零**；`period30m_d2_multiperiod_red.rs` 明确使用**不可达 pool** `127.0.0.1:59999`（文件头 + 断言 `URL 出现 :59999 且不出现 :5433`），并对活库只做**只读** `app_config.multi_period` 前后快照守卫（`d2_blocked_30m_to_1d_and_1w_*` 用例内断言「PUT 前后 value/updated_at 逐字节相同」，用例 **passed**；注：cargo 默认捕获通过用例的 stdout，故该守卫的 `println!` **未出现在输出里**，活库未变的**独立**证据是我自己的 `psql` 前后快照对比）。此外 D2 补充：ADR §6.1 第 8 条（测试隔离债）在本轮的**新增**红测试上已被「不可达 pool + 只读快照守卫」消解，既有 `config_store.rs`/`api_settings.rs` 的共享库写入债仍在。

**A7 结论：PASS（仓库版本化内容零改动；唯一副作用为 gitignore 的 vitest 缓存文件）。**

---

## F. 证据文件清单（本目录）

`EVIDENCE.md`（本文件）、`A1_picker_test_BEFORE.tsx` / `A1_picker_test_AFTER.tsx` / `A1_picker_test.diff` / `A1_contract_check.txt`、`A2_density_recompute.txt` / `A2_extra_scan.txt`、`A3_mutant_baseline.txt` / `A3_mutationA_red.txt` / `A3_mutationB_red.txt` / `A3_mutationB2_red.txt`、`A4_vitest.txt` / `A4_build.txt` / `A4_cargo_test.txt` / `A4_tangle.txt`、`A5_A6_independent.txt`、`A6_checks.txt` / `density_table_HEAD.txt` / `density_table_WORK.txt`、`A7_audit.txt` / `head_before.txt` / `status_before.txt` / `status_after.txt` / `tracked_hash_before.txt` / `untracked_hash_before.txt` / `app_config_before.txt` / `dist_before.txt` / `dist_after.txt`、`mutant/`（变异沙箱）。

---

## R. 残留风险与未决项（均不构成本轮 D2 阻断）

1. **`MEASURED_DENSITY_TABLE` 既有 5 条与当前数据口径不一致（既有债，本轮按令未改）**：我独立重算 `1m:15m` 当前同法 = **13.3889**，表值 **12.2**（ADR §6.1 第 7 条「证据 A」复现）。⇒ 既有配对（含靠 `composed` 解析的 `5m↔1h` 等）仍继承该误差；`composed` 优先级高于 `measured` 的设计未动（ADR §6.1 第 7 条待裁决）。本轮 30m 用「直接条目」规避，**不覆盖既有 5 条**。
2. **测试夹具/标题的周期清单陈旧（文档级）**：`Toolbar.test.tsx:58-60`、`feed.test.ts:15`、`mock.test.ts:687`、`multiPeriodSatellite*.test.tsx`、`syncCoverage.test.ts:343` 等仍只列 6/7 档。实测**不产生假绿**（严格 8 档断言由 `period30m.test.tsx` J8-b 承担；其余为子集夹具或存在性循环），但违反 ADR §6.2「契约变更须全域扫描」的**面**要求，建议后续单独立项清理。
3. **包络列（非冻结值）出处不精确**：`5m:30m [4.84,5.08]`、`15m:30m [1.78,1.81]` 的「day 尺度」子集筛选规则未在文档中定义，无法逐字节复现同一子集（端点均确实存在于原始样本）；且 ADR §2.5 给 `15m:30m` 的包络 `[1.63,1.69]` 与 tester 文件的 `[1.78,1.81]` **不一致**，疑为 ADR 该行串了 `30m:1h` 的包络。**四条冻结值（24.1/5.0/1.8/1.67）不受影响**，但建议回写 ADR §2.5 包络列以免未来误引。
4. **`multiPeriodMockParity.test.ts` 存在 `api → features` 的跨层 import**：`import { MULTI_PERIOD_PICKER_PERIODS } from '@/features/dashboard/multiPeriodPicker';`（测试文件内，非生产依赖）。292 报告「未跨层 import（避免 api→features 反向依赖）」的表述与该测试文件不符（生产侧 `mock.ts` 确实未跨层）。属**报告表述瑕疵 + 测试层依赖方向 nit**，非功能缺陷（若未来给 `api` 层加依赖方向门禁，会在此测试文件上告警）。
5. **`cargo test --workspace --tests` 的既有共享 dev 库写入债未消解**（ADR §6.1 第 8 条后半）：`crates/storage/tests/config_store.rs`、`crates/web/tests/api_settings.rs`、`api_multi_period_config.rs` 仍直接读写活库 `app_config`（自带清理，本次净影响为零）。本轮新增的 D2 测试已自隔离，但**全仓测试隔离**仍是未闭环项。
6. **未做浏览器真渲染复核**：依纪律（§6.2 只读验收前置 + 禁点 `mp-periods-open`）与「离线独立验收」范围，本轮**未**开浏览器会话，故「30m 配对真渲染同窗对齐」的**端到端闭环**未由我方复现（A3 的 `syncChartStub` 忠实桩已证明解析路径与比值；真身闭环仍待后续在线验收）。
7. **`web/node_modules/.vite/vitest/*/results.json` 被测试运行触碰**（gitignore）；如需「零缓存写入」，须在只读挂载的文件系统上执行 A4 —— 当前环境不可行，已如实披露。
