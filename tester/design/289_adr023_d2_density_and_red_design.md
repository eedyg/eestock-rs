# 289 — ADR-023 D2 阶段一：实测密度比 D(1m→30m) + D2 红测试 —— **设计报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/design/289_adr023_d2_density_and_red_design.md`
- 类型：**Design report**（本轮**新设计并新编写**的两类产物：① 实测探针；② D2 红测试）
- 执行报告（结果/红证据）：`tester/test/289_adr023_d2_density_and_red_execution.md`
- 证据目录（原始测量值 + 逐条命令输出）：`/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §2.5（D2 口径）/ §5.3（D2 交付范围）/ §6.2（只读验收规程）
- 上游先例：`tester/test/260_p03_barspace_anchor_execution.md`（P0.3 密度口径；`Evidence/260_p03_barspace_anchor/p03_density_result.json` 即既有 5 条表值的来源）、`tester/test/250_multiperiod_route_probe_execution.md`（P7 真渲染探针手法）、`tester/test/287_sync_coverage_red.md`（守门口径）

---

## 1. 本阶段范围（只写测试与测量，不改实现）

| 产物 | 性质 | 落位 |
|---|---|---|
| A. 密度比实测探针（真渲染） | 只读测量；P0.3 口径 | **全部在 `/tmp`**（仓库零残留） |
| B. 后端 D2 红测试 | 新增手写集成测试 | `crates/web/tests/period30m_d2_multiperiod_red.rs` |
| C. 前端 D2 红测试 | 新增手写 vitest | `web/src/features/dashboard/period30mD2.test.ts` |

**禁改清单（本轮遵守）**：`design/**`、任何 `file=` 声明的 entangled 生成物（含 `crates/web/src/dto.rs`）、任何既有测试、任何实现；不 `git add/commit/stash`；不重启/不杀 app（PID 68833）；不发任何写 API；不点击会自发写配置的 UI 入口（`data-testid="mp-periods-open"`）。

---

## 2. 产物 A：密度比实测设计（P0.3 口径）

### 2.1 口径（钉死，源自 ADR-023 §2.5 + 260 P0.3）

- `D = 同窗基准 bar 数 / 卫星 bar 数`；pane 宽 **520px**；**必须真渲染**（klinecharts 实例，非算术推断）。
- **禁止**按名义周期比兜底；**禁止**把「日根数比」直接当实测值（历史：1m:5m 名义 5 实测 4.7；1m:1h 名义 60 实测 37.8）。
- 取样多样本 + 给离散度；交叉测 `D(15m→30m)` 自洽（应 ≈ `D(1m→30m)/D(1m→15m)`）。

### 2.2 夹具与隔离设计

| 项 | 设计 |
|---|---|
| 引擎 | klinecharts **10.0.3** UMD（`web/node_modules/klinecharts/dist/umd/klinecharts.min.js` 拷入 `/tmp`），Playwright Chromium（headless） |
| 实例 | 两个独立 `klinecharts.init` 实例并排，各 `width:520px; height:420px`（断言 `getSize().width === 520`） |
| 数据 | 只读 `GET http://127.0.0.1:8081/api/kline?code=518880&period={1m,5m,15m,30m,1h}&limit=1000`（curl 落盘）→ 本地静态页 fetch |
| 关键 API | `setSymbol` + `setPeriod({type,span})` + `setDataLoader({getBars})`（**P0.3 事实**：无 `applyNewData`；`setPeriod` 不接受裸字符串）；`setBarSpace`；`getVisibleRange()`（**数据索引空间**，`realTo` 可越过 `n-1` ⇒ 计数需 clamp）；`layout.barSpaceLimit` 必须放开 |
| 隔离 | 页面只访问本地静态端口；断言 `externalRequests === []`（⇒ 浏览器**从未**访问 8081/8082）与 `pageErrors === []` |
| 红线前置 | 起浏览器**之前**先快照 `app_config`（`psql -Atc select key,value::text,updated_at`）并落盘 + sha256（ADR-023 §6.2） |

### 2.3 同窗对齐算法（本设计的核心：把「同窗」做成可判定）

1. 设基准 `barSpace ∈ {1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 50}`（覆盖「1 天量级窗」到退化窗）。
2. 读基准 `getVisibleRange()` → clamp 出**实际渲染 bar** 索引区间 `[bFrom, bTo]` → 转 ts 区间 `[t0, t1]`（`t1 += baseBucket`）。
3. 卫星目标窗 = 与 `[t0, t1]` **相交**的卫星 bar（两种口径同时记录，真值被夹在中间）：
   - `D_ceil`：`ts ∈ [t0, t1]`（**不含**被 t0 部分覆盖的左桶）；
   - `D_floor`：`ts ∈ [floor_bucket(t0, satBucket), t1]`（**含**左桶）。
4. 卫星 `barSpace` 迭代收敛（`satBS ← satBS × nSatRendered/nSatTarget`，≤12 轮）使**实际渲染窗**与目标窗一致，再读回两侧渲染 bar 数 ⇒ `D_render`（自校验）。
5. 重复取样：`bs ∈ {1, 2, 4}` 各重复 3/2/2 次 ⇒ 检验渲染确定性。

### 2.4 旁证估计器（交叉用，**不入表**）

K=8 / K=16 **等时窗中位数**：把两侧覆盖交集按等长时间切片，逐窗 `nB/nS`（`nS ≤ 1` 作废）取中位。**这与 260 P0.3 产出既有 5 条表值（4.7/12.2/37.8/4.67/24）的估计器完全同法** ⇒ 新增 `1m:30m` 与既有条目同口径可比。

### 2.5 判据（Acceptance criteria of 产物 A）

| # | 判据 | 绿的条件 |
|---|---|---|
| A-1 | 真渲染确实发生 | `getSize().width === 520`（两侧）、`pageErrors === []`、截图非空 |
| A-2 | 隔离 | `externalRequests === []`；`app_config` before/after 逐字节相同 |
| A-3 | 测量可复现 | 同 `barSpace` 重复取样 `D` 逐位一致 |
| A-4 | 有离散度 | 报告 `min/median/max` 与 `D_ceil/D_floor` 双口径包络 |
| A-5 | 自洽 | `D(1m→30m)/D(1m→15m)` 与直接实测 `D(15m→30m)` 一致（同法下差 ≤2%） |
| A-6 | 建议值 | 与实测一致，**不得**取整成名义比 30；旁证值单独标注、不得充当依据 |

---

## 3. 产物 B：后端 D2 红测试设计

**文件**：`crates/web/tests/period30m_d2_multiperiod_red.rs`（新建，手写；`crates/web/src/dto.rs` 是**生成物**，只断言其行为）。

| 用例 | 判据 | 期望（红阶段） |
|---|---|---|
| `d2a_multi_period_allowed_contains_30m_between_15m_and_1h` | `MULTI_PERIOD_ALLOWED` 含 `"30m"` 且 `== ["1m","5m","15m","30m","1h","1d","1w"]` | **红**（无 30m） |
| `d2b_rank_30m_is_between_15m_and_1h_via_validate` | `multi_period_rank` 为**私有** ⇒ 经 `validate_multi_period_config` 间接断言：`15m+30m` Ok、`30m+1h` Ok、`30m+15m` 拒且**原因落在「须 ≥ 基准」分支**（避免「因 30m 未知而绿」的假绿）、`1h+30m` 同、`15m+30m+1h` Ok | **红** |
| `d2c_validate_accepts_config_containing_30m_and_echoes_it` | 含 30m 的配置 `validate_multi_period_config` Ok 且回显 `periods`/`heights` 键一一对应 | **红** |
| `d2d_pane_count_and_dedup_semantics_unchanged_with_30m` | §7.4 口径不回归：`3 周期 × ["dcap"×3] ⇒ 3 pane`；`4 周期 × 4 互异指标 ⇒ 13 pane ⇒ Err 且信息含 `indicators``；`normalize_multi_period_indicators` 去重保持首次序 | **绿护栏** |
| `d2e_put_multi_period_with_30m_must_not_be_400` | `PUT /api/config/multi_period`（`periods=[15m,30m]`）**不得 400**（400 = 校验门把 30m 判非法） | **红**（实测 400） |
| `d2f_1mo_still_not_offered_after_30m_lands` | `1mo` 仍不在白名单、含 `1mo` 配置仍拒、未知周期仍拒 | **绿护栏** |

**隔离设计**：`PgPoolOptions::connect_lazy` + **不可达端口 `127.0.0.1:59999`**（照 `period30m_api_contract.rs`）⇒ 绝不触达活库 `5433`，且 HTTP 用例走到落库阶段必然是 5xx ⇒ **零写**；契约只断言「**非 400**」，无库亦成立。

---

## 4. 产物 C：前端 D2 红测试设计

**文件**：`web/src/features/dashboard/period30mD2.test.ts`（新建，手写；被测面均为**手写文件**的导出，可直接静态 import）。

| describe / 用例 | 判据 | 期望（红阶段） |
|---|---|---|
| 选择器清单 · 完整顺序 | `MULTI_PERIOD_PICKER_PERIODS === ["1m","5m","15m","30m","1h","1d","1w"]` | **红** |
| 选择器清单 · 插位 | `indexOf('15m') < indexOf('30m') < indexOf('1h')` | **红** |
| 选择器清单 · 桶宽 | `periodBucketMs('30m') === 1800000` 且 `PERIOD_BUCKET_MS['30m'] === 1800000`（D1 已交付） | **绿护栏** |
| 密度表 · 值 | `MEASURED_DENSITY_TABLE['1m:30m'] == 24.1`（= 本轮实测；`toBeCloseTo(…,10)`） | **红** |
| 密度表 · 包络/非名义 | 值为正有限、落在真渲染包络 `[24.0, 25.3]`、**≠ 30** | **红** |
| 合成 · 非 null | `composeDensity('15m','30m') / ('5m','30m') / ('30m','1h')` 均非 null 正值 | **红** |
| 合成 · 漂移 | `composeDensity('15m','30m')` 与真渲染实测 `1.80` 漂移 ≤15%（ADR §2.5「仍须真渲染校验合成值」的宽松护栏；实测合成值 1.9754 = +9.7% ⇒ 通过） | **红**（现为 null） |
| 跨族护栏 · 拒绝 | `isSyncCombinationAllowed('30m','1d') === false`、`('30m','1w') === false` | **绿（假绿）**：现因 `periodOrder('30m') === null` 而拒 ⇒ 由下一条识别 |
| 跨族护栏 · **原因码** | `syncExclusionReason('30m','1d') === 'no-shared-anchor'`、`('30m','1w') === 'week-requires-day-or-above'`，且**不得**是 `'unsupported-period'`（禁静默/禁泛化拒绝） | **红** |
| 跨族护栏 · 卫星<基准 | `('1h','30m')`/`('1d','30m')` ⇒ `'satellite-lower-than-base'`；`('15m','30m')` 放行 | **红** |
| 反向护栏 · 既有 5 条 | `1m:5m 4.7 / 1m:15m 12.2 / 1m:1h 37.8 / 1d:1w 4.67 / 1h:1w 24` **逐字不变**，且键数 == 6（只许新增一条） | **红**（键数 5） |
| 反向护栏 · 既有拒绝 | `1m↔1d`/`1m↔1w`/`15m↔1w` 仍拒且原因码保持；含 `1mo`/未知周期 ⇒ `'unsupported-period'` | **绿护栏** |
| 反向护栏 · `1h↔1w` | 既有口径 10「1w 需基准 ≥1d」**不得放宽**（`1h↔1w` 仍拒） | **绿护栏** |
| 反向护栏 · 既有放行 | `1m↔5m/1m↔15m/1m↔1h/5m↔1h/15m↔1h/1d↔1w/同周期` 仍放行 | **绿护栏** |

**设计要点**：
1. 每条「拒绝」都要求**原因码**（不只 false）—— 否则 `unsupported-period` 会掩盖「30m 未被纳入周期集」的真实缺陷（本设计专门用一条断言把该假绿钉死）。
2. 密度值断言**双层**：等值（24.1）+ 包络（[24.0, 25.3]）+ 非名义（≠30），既钉死实测值又防止未来按名义比回退。
3. 合成值只做**漂移上限**（≤15%）而非等值 —— 因为既有 `1m:15m=12.2` 与当前数据实测 13.389 存在窗口差异（见执行报告 §遗留），若钉死等值会与「不改既有条目」的禁令冲突。

---

## 5. 红/绿判据总表（本阶段验收）

| 项 | 判据 |
|---|---|
| 新增测试**确实红** | Rust 6 用例 ≥4 红（且**编译成功** ⇒ 红因是实现缺失而非测试写错）；前端 14 用例 ≥9 红；逐条给出失败输出 |
| 既有测试**未被破坏** | 前端全量：失败集合 ⊆ 新增文件；Rust `--lib`：276 passed / 0 failed（与 D1 基线一致）；`--no-run` 全目标编译无错 |
| 测量**可复现** | 重复取样逐位一致；`probe_result.json` + 截图落盘 |
| 只读纪律 | `app_config` before == after；零写请求；零 UI 点击；探针零仓库残留 |

---

## 6. 已知冲突（须父级裁决，本轮**不动**）

`crates/web/tests/period30m_scope_guard.rs`（`j9_*`：白名单必须不含 30m）与 `web/src/features/dashboard/period30m.test.tsx`（`J9`：选择器必须不含 30m）是 **D1 的越界护栏**，D2 落地后**必红** —— 属设计意图（D1 期间防越界），D2 实现阶段须由父级授权同步改写/删除。

---

## 7. D2 第二阶段追加设计（2026-09-16，父级裁决：R3 升级 / R4 修复 / R1 授权）

### 7.1 背景（父级核实的事实）
`web/src/features/dashboard/chartSyncGroup.ts:980` 的 `effectiveDensity()` 解析序为
`static → **composed** → measured → none` ⇒ **`composeDensity` 的返回值会被当作缩放比使用，且优先级高于运行时实测**。
若 30m 配对缺直接条目，会静默采用合成值：`15m↔30m = 24.1/12.2 = 1.9754` vs 直接实测 `1.800`（+9.7%）⇒ **真实错对齐**。

### 7.2 追加设计 A：30m 的**四条直接条目**（同一 P0.3 口径实测）
| 条目 | 建议值 | 真渲染同窗包络（day 尺度） | K8/K16 中位 | 逐整日硬底 | 名义比（禁） |
|---|---|---|---|---|---|
| `1m:30m` | **24.1** | [24.0, 25.3] | 24.1 / 24.1 | 241/10 | 30 |
| `5m:30m` | **5.0** | [4.84, 5.08] | 5.0 / 5.0 | 50/10 | 6 |
| `15m:30m` | **1.8** | [1.78, 1.81] | 1.8 / 1.8 | 18/10 | 2 |
| `30m:1h` | **1.67** | [1.63, 1.69] | 1.6667 / 1.6667 | 10/6 | 2 |

取值容差 ±0.01（同估计器取整：`1.67 ↔ 1.6667`、`5 ↔ 5.0`）；`MEASURED_DENSITY_TABLE` 键数 5 → **9**；既有 5 条**逐字不动**。

### 7.3 追加设计 B：**不变量断言（可执行，防静默错对齐）**
- 判据：对 `1m:30m / 5m:30m / 15m:30m / 30m:1h` 每一对，`effectiveDensity` 的解析结果必须是
  `source === 'static'` 且 `ratio == 直接实测值`（`composed` 一律视为缺陷）。
- 可执行路径：`effectiveDensity` 为 **private** ⇒ 经公开可观测面 `ChartSyncGroup.stats.densityByFollower`
  （287 口径 C）读取：构造 `[基准, 30m 卫星]` 两成员组（真身 `ChartSyncGroup` + 忠实桩 `web/src/test/syncChartStub.ts`），
  `start()` 后做一次基准滚动触发对齐，读回 `{ratio, source}`。
- 红阶段表现：30m 卫星被 `isSyncCombinationAllowed` 排除（或组未建立）⇒ 读数 `undefined` ⇒ **断言失败（响亮）**。

### 7.4 追加设计 C：R4（自隔离 PUT 用例）
- 断言 ①`pool` 指向不可达端口且非活库 5433；②`pool.acquire()` 必然失败；③PUT 响应非 2xx；④`app_config.multi_period` 活库**只读**前后快照逐字节相同，不同 ⇒ 先恢复原值再 panic。
- **顺序硬约束（本轮踩坑修正）**：守卫 ③④ 必须**先于**契约断言 ⑤ 执行，否则红阶段 panic 会跳过守卫。

### 7.5 追加设计 D：R1 护栏改写（契约演进）
`crates/web/tests/period30m_scope_guard.rs` 与 `web/src/features/dashboard/period30m.test.tsx` 的 J9：
由「30m **不在**白名单/选择器」→「30m **必须**在，且顺序 `15m → 30m → 1h`」；**保留/加强**：`1mo` 不提供、既有 6 档一档不少、
`1m↔1d`/`1m↔1w`/`1h↔1w` 仍拒、`30m↔1d`/`30m↔1w` 仍拒且**给出原因码**。
