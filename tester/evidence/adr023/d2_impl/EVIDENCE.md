# ADR-023 D2 实现 — 证据（EVIDENCE）

- 日期（UTC）：2026-09-16T15:44Z（本地 23:44 CST）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- 任务：把 tester 已产出的 D2 红测试转绿（多周期 30m：白名单 / rank / 选择器 / 冻结密度值 / 原因码）
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §2.5 / §5.3(D2) / §6.1 第 7–8 条
- HEAD（未变）：`3094018f352dae25752340d78b5e108c284aeecc`
- 本文件路径：`/tmp/adr023-d2-impl-20260916T154107Z/EVIDENCE.md`

> 重要说明：本工作区在本次任务开始前已有 **D1 的未提交改动**（`git status` 起始快照见 `./git_status_pre_note.md`）。
> 下面标注「D2」的 hunk 才是本次会话的改动；`dto.rs` / `00-web-api.md` / `chartSyncGroup.ts` 三文件的任务前 diff（vs HEAD）同时含 D1 改动。

---

## 0. 起始快照（会话开始时的 git status）

会话开始时已处于 modified 状态的文件（D1 遗留）：
`README.md, crates/application/src/bar_map.rs, crates/domain/src/types.rs, crates/storage/src/accurate.rs,
crates/storage/src/backtest.rs, crates/storage/src/migrate_check.rs, crates/storage/src/reader.rs,
crates/tushare/src/client.rs, crates/web/src/dto.rs, crates/web/src/rest.rs, design/02-domain/contracts.md,
design/04-storage/{02-tushare-sync,03-raw-writer,schema}.md, design/06-web/01-dashboard.md,
design/07-app-plane/00-web-api.md, web/src/api/mock.ts, web/src/features/backtest/ScopedKlineFeed.ts,
web/src/features/dashboard/{Toolbar.tsx,chartCommon.ts,chartSyncGroup.ts,feed.ts},
web/src/layouts/DashboardGrid.tsx`

**本次会话新增的 modified 文件仅 3 个**：`design/15-multi-period/02-spec.md`、
`web/src/features/dashboard/multiPeriodPicker.tsx`、`web/src/features/dashboard/multiPeriodPicker.test.tsx`（经父级授权）。

---

## 1. doc-first 改动（文档 → 产物）

### 1.1 事实源 `design/07-app-plane/00-web-api.md`（dto.rs 块 @2607–3685）
```
-/// 全部可选周期（`1mo` 用户裁决不提供；ADR-022 §2.5）。
-pub const MULTI_PERIOD_ALLOWED: &[&str] = &["1m", "5m", "15m", "1h", "1d", "1w"];
+/// 全部可选周期（`1mo` 用户裁决不提供；ADR-022 §2.5；ADR-023 §2.5 追加 `30m`）。
+pub const MULTI_PERIOD_ALLOWED: &[&str] = &["1m", "5m", "15m", "30m", "1h", "1d", "1w"];

/// 周期序（越小越短；判「卫星 ≥ 基准」用）；`1mo` 返回 None（不提供）。
+/// ADR-023 §2.5：`30m` 插在 `15m`(2) 与 `1h`(3) 之间，其后档位顺延（保持「越小越短」）。
 fn multi_period_rank(p: &str) -> Option<u8> {
     match p {
         "1m" => Some(0), "5m" => Some(1), "15m" => Some(2),
-        "1h" => Some(3), "1d" => Some(4), "1w" => Some(5),
+        "30m" => Some(3), "1h" => Some(4), "1d" => Some(5), "1w" => Some(6),
         _ => None,
     }
 }
```

### 1.2 写入式 tangle（**无 `--force`；未用全局 `entangled stitch`**）
命令：`entangled tangle`（工作目录 = 仓库根）
原始输出（`./tangle_output.txt`）：
```
[23:42:24] INFO     Welcome to Entangled v2.4.3!
           INFO     write `crates/web/src/dto.rs`
EXIT=0
```
- 无 `conflicts found`、无 `changed outside the control of Entangled`、无 `not managed by Entangled`。
- tangle **只**写了一个文件：`crates/web/src/dto.rs`（与文档块声明 `file=crates/web/src/dto.rs` 一致）。

---

## 2. 手写改动（不受 tangle 门禁覆盖）

### 2.1 `web/src/features/dashboard/multiPeriodPicker.tsx`
```diff
-/** 周期秩升序全集（**不含 `1mo`**；ADR-022 §2.5 用户裁决：`1mo` 不提供）。 */
-export const MULTI_PERIOD_PICKER_PERIODS: Period[] = ['1m', '5m', '15m', '1h', '1d', '1w'];
+/** 周期秩升序全集（**不含 `1mo`**；ADR-022 §2.5 用户裁决：`1mo` 不提供）。
+ *  ADR-023 §2.5：`30m` 插在 `15m` 与 `1h` 之间（与后端 `multi_period_rank` 同步，共 7 档）。 */
+export const MULTI_PERIOD_PICKER_PERIODS: Period[] = ['1m', '5m', '15m', '30m', '1h', '1d', '1w'];
```

### 2.2 `web/src/features/dashboard/chartSyncGroup.ts`
- `MEASURED_DENSITY_TABLE` **新增四条冻结直接实测条目**（既有 5 条逐字不动）：
  `'1m:30m': 24.1`、`'5m:30m': 5.0`、`'15m:30m': 1.8`、`'30m:1h': 1.67`
- `periodOrder`：`'30m': 4` 插在 `'15m': 3` 与 `'1h': 5` 之间，其后顺延（`1h:5/1d:6/1w:7`）。
  （`PERIOD_BUCKET_MS['30m']=1_800_000` 属 D1 已有，本次未动。）
- `PERIOD_BUCKET_MS` / 任何其它周期序表：已核，仅 `periodOrder` 需插 30m（`grep` 确认）。

### 2.3（经父级授权的最小契约演进）`web/src/features/dashboard/multiPeriodPicker.test.tsx`
仅 3 处期望字面量 + 1 处描述串（+5/−5，结构零变）：
```diff
-  it('A1 步骤 1 全集 = 全部周期 \\ {1mo}（顺序 1m/5m/15m/1h/1d/1w）', ...
-    expect(m.MULTI_PERIOD_PICKER_PERIODS).toEqual(['1m', '5m', '15m', '1h', '1d', '1w']);
+  it('A1 步骤 1 全集 = 全部周期 \\ {1mo}（顺序 1m/5m/15m/30m/1h/1d/1w）', ...
+    expect(m.MULTI_PERIOD_PICKER_PERIODS).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w']);
...
-      'base=15m ⇒ 候选 = {15m,1h,1d}（1w 因基准 <1d 被禁）',
-    ).toEqual(['15m', '1h', '1d']);
+      'base=15m ⇒ 候选 = {15m,30m,1h,1d}（1w 因基准 <1d 被禁）',
+    ).toEqual(['15m', '30m', '1h', '1d']);
...
-    ).toEqual(['1m', '5m', '15m', '1h', '1d', '1w']);     // B1 步骤 1 DOM 序
+    ).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w']);
```
结构计数对照（`git show HEAD:<file>` vs 现状）：`expect(` 83→83、`it(` 17→17、`toEqual(` 19→19、
`toContain(` 5→5、`filter(` 6→6 ⇒ **无新增/删除用例，无断言放宽**。B1 后半段（`base=1d ⇒ ['1d','1w']`）未动。

### 2.4 设计散文 `design/15-multi-period/02-spec.md`（无 `file=` 产物 ⇒ 纯散文）
§3.2 第 4 条「真无公共锚点」的周期集合枚举由 `5m/15m/1m/1h ↔ 1d`、`5m/1m ↔ 1w` 更新为含 30m，
并追加一句 D2 说明（30m 同族走 static、跨族归 no-shared-anchor / week-requires-day-or-above）。

---

## 3. V1 — D2 红转绿（红/绿计数对照）

### 3.1 前端（vitest）
| 阶段 | 命令 | 结果 |
|---|---|---|
| 红（改前） | `npx vitest run src/features/dashboard/period30mD2.test.ts src/features/dashboard/period30m.test.tsx` | `Test Files 2 failed (2)`；`Tests 18 failed \| 12 passed (30)` |
| 绿（改后） | 同上 | `Test Files 2 passed (2)`；`Tests 30 passed (30)` |

红因样例（原文，`./pre_red_vitest.txt`）：
```
 FAIL  ...period30mD2.test.ts > ... 15m:30m：effectiveDensity 必须解析为 source='static'
AssertionError: 无法读到 15m:30m 的密度读数（卫星被排除/组未建立/未对齐）⇒ 30m 未真正进入多周期
 FAIL  ... 拒绝必须给出**原因码**...
AssertionError: 30m 已进入周期集 ⇒ 原因不得是 'unsupported-period'；实际 = unsupported-period
 FAIL  ... 既有 5 条实测密度值逐字不变（D2 只许**新增** 30m 的 4 条）
AssertionError: ...实际键 = ["1m:5m","1m:15m","1m:1h","1d:1w","1h:1w"]: expected 5 to be 9
```

### 3.2 后端（cargo）
| 阶段 | 目标 | 结果 |
|---|---|---|
| 红（改前） | `cargo test -p web --test period30m_d2_multiperiod_red --test period30m_scope_guard` | `period30m_d2_multiperiod_red`: `4 failed; 2 passed`（cargo 在首个失败目标即中止 ⇒ `period30m_scope_guard` 当次未执行；其红侧叙事见文件头「红因（红阶段）：MULTI_PERIOD_ALLOWED 仍为 6 档 ⇒ 断言失败」） |
| 绿（改后） | 同上 | `period30m_d2_multiperiod_red`: `6 passed; 0 failed`；`period30m_scope_guard`: `3 passed; 0 failed`（EXIT=0） |

红因原文（`./pre_red_cargo.txt`）：
```
---- d2a_multi_period_allowed_contains_30m_between_15m_and_1h ---
ADR-023 §2.5：D2 必须把 "30m" 加入 MULTI_PERIOD_ALLOWED；实际 = ["1m", "5m", "15m", "1h", "1d", "1w"]
---- d2c_validate_accepts_config_containing_30m_and_echoes_it ---
... 实际 = Err("periods 卫星周期非法（须 ∈ [\"1m\", \"5m\", \"15m\", \"1h\", \"1d\", \"1w\"]）：30m")
---- d2e_put_multi_period_with_30m_must_not_be_400 [R4 守卫] ---
[证据] PUT /api/config/multi_period periods=[15m,30m] 实际状态码 = 400
[R4 守卫] 活库 app_config.multi_period 逐字节未变（value/updated_at 均相同）✔
```

---

## 4. V2 — 既有回归

| 门禁 | 命令 | 结果 |
|---|---|---|
| 前端全量 | `npx vitest run`（web/） | `Test Files 88 passed (88)`；`Tests 836 passed (836)`；EXIT=0 |
| 前端构建 | `npm run build`（web/） | `tsc -b && vite build` OK；`✓ built in 1.96s`；EXIT=0 |
| 后端全量 | `cargo test --workspace --tests` | 88 个 `test result: ok`、0 个 FAILED；`total passed=721 failed=0 ignored=1`；EXIT=0 |
| tangle 门禁 | `./scripts/check-tangle.sh` | `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。`；EXIT=0 |

（改前基线：`./pre_tangle.txt` = `[check-tangle] ✅ …` EXIT=0 —— 即门禁在改动前后均为绿。）

---

## 5. V3 — 断言未被弱化

- **tester 的 4 个 D2 测试文件 sha256 前后逐字节相同**（`./tester_tests_pre.sha256` vs `./tester_tests_post.sha256`，`diff` 输出为空）：
```
6a0d220dd3aa736d00136276c7305da624a67010210b8e75bc77bccea66712af  crates/web/tests/period30m_d2_multiperiod_red.rs
dfc6d3cd94b0b0f459b84fa17e335374579e257547cd0ad42dea8bbde4497c1c  crates/web/tests/period30m_scope_guard.rs
82dc2d85d65d22c0862c73a85bc0724b637f434063189e5c8f650ba1ee59c9f5  web/src/features/dashboard/period30mD2.test.ts
5cc0c9725a588eb2d8ea883a9fc7f14c217ddaf2d5e22bd499f8e56938177c77  web/src/features/dashboard/period30m.test.tsx
```
- **唯一被改的测试文件** = `web/src/features/dashboard/multiPeriodPicker.test.tsx`（父级授权 A）：
  sha256 `79736741ce98eb13029866784eb60016862db33380fd03214a4e7339c65a40e1` →
  `9242fcf5a91ec080e7dd302acf125b5c0692ce636f2b9acd3ae8b68973e023c7`，`+5/−5`，见 §2.3。
- 无任何 `expect(`/`assert` 被删除或放宽；结构计数 §2.3 全部相等。
- 除上表外，**其它测试文件（cargo `crates/*/tests/*`、`web/src/**/*.test.*`）零改动**（`git status` 对照起始快照，见 §7）。

---

## 6. V4 — tangle 真实性（产物真被更新）

- 产物 `crates/web/src/dto.rs` **grep 命中 30m**（`./dto_30m_grep.txt`）：
```
137:/// 全部可选周期（`1mo` 用户裁决不提供；ADR-022 §2.5；ADR-023 §2.5 追加 `30m`）。
138:pub const MULTI_PERIOD_ALLOWED: &[&str] = &["1m", "5m", "15m", "30m", "1h", "1d", "1w"];
153:/// ADR-023 §2.5：`30m` 插在 `15m`(2) 与 `1h`(3) 之间，其后档位顺延（保持「越小越短」）。
159:        "30m" => Some(3),
```
- **mtime 证据**（`prod newer than doc`）：
  - 文档 `design/07-app-plane/00-web-api.md`：`2026-09-16 23:42:17.567760924 +0800`
  - 产物 `crates/web/src/dto.rs`：`2026-09-16 23:42:24.240328066 +0800` ⇒ **晚于文档 6.67s**（`prod_newer True`）
  - 会话前产物 mtime：`2026-09-16 22:51:45.273128452 +0800`（`./dto_mtime_before.txt`）

---

## 7. V5 — 零副作用

- `git status --short` 增量（相对会话起始快照）= **仅 3 个**：`design/15-multi-period/02-spec.md`、
  `web/src/features/dashboard/multiPeriodPicker.tsx`、`web/src/features/dashboard/multiPeriodPicker.test.tsx`；
  另 3 个被改文件（`crates/web/src/dto.rs`、`design/07-app-plane/00-web-api.md`、
  `web/src/features/dashboard/chartSyncGroup.ts`）在会话前已是 modified（D1）。（完整 `./git_status_post.txt`）
- **HEAD 未变**：`3094018f352dae25752340d78b5e108c284aeecc`
- **无 staged**：`git diff --cached --name-only` 输出为空；未执行 `git add` / `git commit` / `git stash`。
- **无临时残留**：探针文件 `web/src/features/dashboard/zz_evidence_tmp.test.ts` 已删除（`ls` 报 No such file）。
- **`.entangled` 状态**：`filedb.json`(39533B, 23:42) + `filedb.lock`(0B) + `tmp/`(空)；`check-tangle.sh` 沙箱重生成通过
  ⇒ 无异常。（`./entangled_state.txt`）
- 未触碰在线 app（PID 68833）、未对活库/在线实例写任何数据；未改 `.gitignore`；未动其它项目。
- 未使用 `entangled tangle --force`、未用全局 `entangled stitch`。

---

## 8. 30m 各配对在实现后 `effectiveDensity` 的 source 与比值实测

（探针：真实 `ChartSyncGroup` + 忠实桩 `createSyncChartStub`；文件即 `period30mD2.test.ts` 的不变量用例。`./effective_density_probe.txt`）

```
TABLE 1m:5m = 4.7        TABLE 1m:15m = 12.2      TABLE 1m:1h = 37.8
TABLE 1d:1w = 4.67       TABLE 1h:1w = 24
TABLE 1m:30m = 24.1      TABLE 5m:30m = 5         TABLE 15m:30m = 1.8      TABLE 30m:1h = 1.67
EFFECTIVE 1m:30m  -> ratio=24.1  source=static
EFFECTIVE 5m:30m  -> ratio=5     source=static
EFFECTIVE 15m:30m -> ratio=1.8   source=static
EFFECTIVE 30m:1h  -> ratio=1.67  source=static
REASON 30m->1d = no-shared-anchor            allowed=false
REASON 30m->1w = week-requires-day-or-above  allowed=false
REASON 1h->30m = satellite-lower-than-base   allowed=false
REASON 1d->30m = satellite-lower-than-base   allowed=false
REASON 15m->30m = null                        allowed=true
```

判据对齐：
- 四条 30m 配对 `source='static'` 且比值 == 冻结值（禁 composed/measured/none）。
- `30m↔1d` = `no-shared-anchor`（**非** `unsupported-period`）；`30m↔1w` = `week-requires-day-or-above`；
  `1h↔30m`、`1d↔30m` = `satellite-lower-than-base`；`15m↔30m` 放行。
- 合成值（用于对照，非采用）：`15m→30m` compose = 24.1/12.2 = **1.9754**（vs 直接实测 1.800 = +9.7%）⇒ 证明「必须走 direct 条目」。

---

## 9. 残留风险

1. **`web/src/api/mock.ts:215` 的 `order = ['1m','5m','15m','1h','1d','1w']` 未含 30m**（不在本任务改动清单内，未动）。
   影响：`VITE_API_MOCK=1`（mock 模式）下多周期配置含 30m 会被前端 mock 校验 `ApiError(400)` 拒。
   真实后端（dto.rs/tangle 产物）已接受 30m。**建议独立小任务补 mock 镜像**（属 ADR-023 §6.1 第 1 条「档位清单散落无单一事实源」债）。
2. **ADR-023 §6.1 第 7 条（F5）未动**（本任务明确不做）：`effectiveDensity` 的 `static→composed→measured` 优先级保持现状。
3. **`design/15-multi-period/02-spec.md` §3.2 的实测密度表**（ADR-022 旧表）未加 30m 行；权威 30m 冻结值在 ADR-023 §2.5 与本 EVIDENCE §8。仅散文同步了「周期集合/无公共锚点」枚举（任务书要求范围）。
4. **测试隔离债（ADR-023 §6.1 第 8 条）**：`period30m_d2_multiperiod_red.rs` 的 `d2e` 用例会对活库做**只读**快照（本次实测显示快照前后逐字节一致 ✔）；其 PUT 用不可达 pool ⇒ 零写。本次未对该债做处置。
5. `period30m_scope_guard.rs` 的**红侧原始计数**未直接量到（cargo 在首个失败目标中止）——其红/绿状态以文件头叙事 + 改后 3/3 绿为证。

---

## 10. 证据文件清单（同目录）

`git_status_pre_note.md`（起始快照）· `tester_tests_pre.sha256` / `tester_tests_post.sha256`
· `pre_red_vitest.txt` / `pre_red_cargo.txt` · `pre_tangle.txt` · `tangle_output.txt`
· `dto_mtime_before.txt` / `dto_mtime_after.txt` / `doc_mtime.txt` / `dto_30m_grep.txt`
· `post_vitest_d2.txt` · `post_cargo_d2.txt` · `post_vitest_full.txt` / `post_vitest_full2.txt`
· `post_npm_build.txt` · `post_cargo_workspace.txt` · `post_tangle_check.txt`
· `mpp_test_diff.txt` / `mpp_test_sha_before.txt` / `mpp_test_sha_after.txt`
· `d2_handwritten_and_prose_diff.txt` · `numstat.txt` · `effective_density_probe.txt`
· `git_status_post.txt` · `entangled_state.txt`

**VERDICT: PASS**
