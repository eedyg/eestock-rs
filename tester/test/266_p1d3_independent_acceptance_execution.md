# P1-D-3 独立验收执行报告（Tester，重跑 P1-C FAIL(1) 全部项 + 回归 + 反向证据）

- **本文件路径**：`tester/test/266_p1d3_independent_acceptance_execution.md`
- 时间：2026-09-14 21:03–21:12（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD `d6462da229f9264777e414be827d9d1017600778` **+ 工作树 P1 未提交改动**（11 个 tracked `M`，与本轮开始时逐条一致）
- 证据目录：`tester/evidence/266_p1d3/`（31 个文件）
- 上一轮：`tester/test/264_p1c_independent_acceptance_execution.md`（`VERDICT: FAIL(1)`，缺陷 D1–D4）
- 纪律：**未改动任何实现/设计/tracked 文件**；未 `git add/commit/stash`；未重启线上；**向线上 0 个写请求**；临时实例（`127.0.0.1:18147/18146`）已拆除；共享库 `app_config.multi_period` **0 行**（psql 复核，键集合仅 `dcap`，与基线一致）
- 本报告**不含任何失败分析/修复动作**（Tester 只观测与取证）

---

## 0. 总览

| # | 验收项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | **D1 复验**（去重 + 计数基于去重集合 + 无法用重复项构造 >12） | **通过** | §1；`probe_out.json` |
| 2 | **D2 复验**（越限错误串含被拒维度名） | **通过**（HTTP 面在 v1 不可达 >12 ⇒ 源码串 + 纯函数 + 突变三路取证） | §2；`06..09_mutation_*.txt` |
| 3 | **D3 复验**（`multi_period_pane_budget.rs` 头注释已修正） | **通过** | §3 |
| 4 | **D4 复验**（UI 级开关：乐观更新 / 失败回滚 / 关闭零残留） | **通过** | §4；`vitest_d4.log` |
| 5 | **上一轮其它项重跑（不得回归）**：§2 七条 + §7.4、GET 坏值、PUT 往返、负例不落库、`enabled=false` 等价性、生成物一致性、四套门禁 | **通过** | §5–§7 |
| 6 | **反向证据（突变检验）** | **通过（3 个突变全部按预期变红 + 历史前后对照）** | §8；`07/08/09_mutation_*.txt`、`11_reverse_evidence_pre_fix_vs_now.txt` |
| 7 | 卫生与归因 | **通过** | §9 |

**观察项（不改变上述判定）**：前端 mock 镜像 `web/src/api/mock.ts::assertMultiPeriodConfig` **仍保留去重前的语义**（按原始长度计 pane、不去重落库）⇒ 与后端 §2-6/§7.4 契约不一致；该残余由实现车道在 `coder/report/167_p1d2_d1_dedup_d2_error_string.md` §8.1 主动上报"待父级裁决"，**不在本轮派单的验收项清单内**。本轮独立复现并给出证据（§10），附最小修正建议。

---

## 1. 项 1 — D1 复验（独立 HTTP 探针，真实 axum，临时端口）

**机制**：用工作树源码重建的 `app` 二进制（`cargo build -p app --bin eestock-app`，`/tmp/p1d3/build.log`；源码零改动）拷至 `/tmp/p1d3/eestock-app-probe`，以 `/tmp/p1d3/probe.toml`（`listen=127.0.0.1:18147`、`mcp_listen=127.0.0.1:18146`、`database_url` = 共享 dev 库）启动；探针 `/tmp/p1d3/probe.py`（**Tester 自建，31 个用例，判据全部直接取自 `design/15-multi-period/02-spec.md` §2/§7.4，不引用实现方测试断言**）。

**结果：31 / 31 通过**（`probe_out.json`）。

| 用例 | 期望（来自 spec） | 实测 |
|---|---|---|
| `GET_default_no_key` | 200 默认 `{enabled:false,periods:["1m"],heights:{"1m":420},indicators:["dcap"]}` | 一致 ✅ |
| **`D1_dup2_echo_dedup`** | `PUT periods=[1m,5m,15m] indicators=["dcap","dcap"]` ⇒ **200 且回显 `["dcap"]`** | 200，`echo.indicators=["dcap"]` ✅ |
| **`D1_dup2_readback_dedup`** | GET 读回 == 归一化后的**完整配置**（去重必须落库，非只在计数时去重） | 逐字节一致 ✅ |
| **`D1_dup_n_4periods_200`** | 4 周期 × `["dcap"]×n`（n=3,11,12,24）⇒ 每个 **200** + 回显 `["dcap"]` + 读回 `periods` 长度 4、`indicators=["dcap"]` | `[[3,200,[dcap],4,[dcap]],[11,200,[dcap],4,[dcap]],[12,200,[dcap],4,[dcap]],[24,200,[dcap],4,[dcap]]]` ✅ |
| **`D1_pane_count_equivalent`** | `["dcap"]×3` 与 `["dcap"]` 的 pane 计数一致 ⇒ 两次 PUT 回显/读回**逐字节相同**、均 200 | `one == three == GET` ✅ |
| `D1_4periods_legal_200` | 4 周期合法形态 ⇒ 200 | 200 ✅ |
| **`D1_no_http_over12_via_dups`** | **无法用重复项构造 >12 pane**：4 周期 × `["dcap"]×n`（n∈{1,2,3,4,5,6,8,10,12,16,20,40}）**无一触发 400** | `{"non200": []}` ✅（v1 去重后总 pane ≤ 4 ⇒ HTTP 面确实不可达 >12，与架构师 §7.4 注记一致） |

> D1 结论：**`["dcap","dcap"]` ⇒ 200 且读回 `["dcap"]`；`["dcap"]×3` 与 `["dcap"]` 计数一致；4 周期合法形态 200；重复项无法构造 >12 pane** —— 全部满足。

## 2. 项 2 — D2 复验（越限错误串含被拒维度名）

v1（受支持集合 = `{dcap}` 且去重）⇒ HTTP 面**不可达** >12 pane（§1 已穷举证明），故 D2 无法用 HTTP 负例直接取证。本轮用**三路独立证据**：

1. **源码串取证**（探针 `D2_pane_error_names_dimension`）：从 `crates/web/src/dto.rs::verify_multi_period_panes` 抽取错误串模板并代入 n=16 → `indicators 去重后总 pane 数 16 超上限 12（基准 1 + Σ_卫星(去重后指标) pane）` ⇒ **含被拒维度名 `indicators`**，且保留 `pane` 字样。判据为 Tester 独立实现（`indicators` 或字段标记形式 `pane:`/`pane=`/`[pane]`/句首 `pane`）。
2. **纯函数行为取证**（`cargo test -p web --test multi_period_pane_budget` ⇒ 8/8 通过，含 `d2_over_budget_error_names_the_rejected_dimension`）。
3. **突变取证**（§8 突变 C）：把错误串改回去重前形态 ⇒ D2 用例立刻变红。

> D2 结论：**通过**；同时确认 v1 HTTP 层无 >12 负例属**契约事实**（非测试遗漏），P2 扩容后须补 HTTP 负例（`02-spec.md` §7.4 注 + 测试文件头已声明）。

## 3. 项 3 — D3 复验（`multi_period_pane_budget.rs` 头注释修正）

`crates/web/tests/multi_period_pane_budget.rs` 第 7–24 行现表述（逐字）：

- 第 7 行：`//! ### 为什么用纯函数而不是 HTTP 负例（**修订版：P1-D-1 D3 修正**，原论断已被 P1-C 反证）`
- 第 9 行：`先被 indicators 未支持项规则拒掉」——该论断**不成立**（P1-C 实测：3 周期 × ["dcap"]×11 能构造出…`
- 第 14–15 行：`v1 受支持指标集合 = {dcap}（§2 校验 6）且去重后 ⇒ 每卫星至多 1 个指标 pane`；`卫星 ≤ 3 ⇒ **总 pane ≤ 1 + 3×1 = 4 < 12**`
- 第 18 行：`⇒ **在 v1（去重语义正确的前提下）HTTP 层无法构造 >12 pane**。「未去重时的 400」是假象，不是反例。`
- 第 24 行：`**P2 起**（受支持指标集合扩张 ⇒ 去重后仍可 >12）**必须补 HTTP 级负例**（现成构造：多个不同受支持指标）。`

**与实测一致**：§1 穷举 `n∈1..40` 全部 200 证实"v1 去重后不可达 >12"；去重前的 400 由 §8 历史对照确认为假象。

> D3 结论：**通过**（旧论断已在文件内显式标注为"已被反证"，新表述准确，且给出 P2 的补例义务）。

## 4. 项 4 — D4 复验（UI 级开关，真实渲染）

`cd web && ./node_modules/.bin/vitest run src/features/dashboard/multiPeriodClosedEquivalence.test.tsx src/features/dashboard/multiPeriodStore.test.ts --reporter=verbose` ⇒ **2 files / 11 passed / 0 failed**，其中 D4 两条（真实 jsdom 渲染 + Toolbar 点击）：

- `D4 … > 点击 ⇒ 乐观 aria-pressed=true；PUT 失败 ⇒ 回滚 false 且无副作用（实例/订阅/取数不变）` ✅
- `D4 … > 成功 ⇒ true；再点击关闭 ⇒ false 且零残留（实例/订阅/请求计数与初态一致）` ✅

同时 T11 关闭态 4 条（DOM 冻结指纹、1 实例/1 `bar:` 订阅/1 次取数、容器透传、零残留）全绿。

> D4 结论：**通过**（实现侧已有 UI 级回归网，且真实渲染下通过）。

## 5. 项 5 — 上一轮其它项重跑（不得回归）

### 5.1 §2 七条校验 + §7.4 护栏（独立 HTTP 探针，**逐条**）

| spec 条目 | 用例 | 实测 |
|---|---|---|
| 校验 1 基准/卫星 ∈ 合法周期 \ {1mo} | `S2_1_base_1mo`、`S2_1_sat_1mo` | 均 400 含 `periods` ✅ |
| 校验 2 卫星 ≥ 基准 | `S2_2_sat_below_base`（15m→… 实际 [5m,1m]）、`S2_2_sat_below_base2`（[1d,1h]） | 均 400 含 `periods` ✅ |
| 校验 3（口径 10）含 `1w` ⇒ 基准 ≥ `1d` | `S2_3_1w_base_1h` 400；`S2_3_1w_base_1d_positive` **200**（护栏不得误拒） | 一致 ✅ |
| 校验 4 总周期 ≤ 4 且**不静默截断** | `S2_4_5periods` 400；`S2_4_no_silent_truncation` 拒绝后 GET == 前置 3 周期配置 | 一致 ✅ |
| 校验 5 `heights` 键一一对应 + 值 ∈ [80,1200] | 缺键/多键/79/1201 均 400 含 `heights`；**边界 80/1200 ⇒ 200** | 一致 ✅ |
| 校验 6 `indicators` ⊆ 受支持集合（+ 去重） | `[macd]`、`[dcap,boll]` 均 400 含 `indicators`；去重见 §1 | 一致 ✅ |
| 校验 7 周期去重 | `[1m,1m]`、`[1m,5m,5m]` 均 400 含 `periods` | 一致 ✅ |
| §7.4 总 pane ≤ 12，不得静默截断 | 见 §1 `D1_*`（v1 可达形态全部 ≤ 4）；越限拒绝 + 错误串见 §2 | 一致 ✅ |
| 体形状非法（不 500） | `body_shape_invalid_400`（`heights` 为数组）⇒ 400 | ✅ |

### 5.2 GET 坏值 ⇒ 回默认（不 500）

`GET_bad_stored_falls_back_default`：直接向共享库 `app_config[multi_period]` 播种 7 例坏值（非对象标量 / 缺字段 / 高度 5000 / 周期数 5 / 重复周期 / 含 `1mo` / 未支持指标 `macd`）⇒ **每例 HTTP 200 且回默认**；`GET_out_of_range_enabled_true_falls_back`（越界 + `enabled=true`）⇒ 200 且 `enabled=false`。全部 `enabled=false` 播种以最小化影响，跑后已删键。

### 5.3 合法 PUT 读回一致 / 负例不落库

- `PUT_valid_roundtrip`：PUT 200 且回显 == 请求；GET == 请求 ✅
- `PUT_negative_not_persisted`：先落合法配置，再发非法 5 周期 PUT（400），GET 仍 == 上次被接受值 ✅

### 5.4 `enabled=false` 与 HEAD 等价性（DOM 指纹 / 请求 / 订阅 / 图表调用计数）

方法（与上一轮同源、本轮独立重跑）：`git archive HEAD` → `/tmp/p1d3/head`；工作树 `web/` → `/tmp/p1d3/wt/web`；**同一份 Tester 探针**分别运行并 dump 度量（`mcp` 无），离线逐字段比对。

| 度量 | HEAD `d6462da` | 工作树 | 判定 |
|---|---|---|---|
| `[data-region=main-chart]` 结构指纹 | 3 行 | **逐行相同** | ✅ 等价 |
| `[data-region=main-chart]` 原始 innerHTML | 165 字符 | **逐字节相同** | ✅ 等价 |
| `[data-region=sub-chart]` innerHTML | 0 | 0 | ✅ |
| `klinecharts.init` / `dispose` | 1 / 0 | 1 / 0 | ✅ |
| WS 订阅 topic | `{bar:518880:15m:1, quote:1}` | 同 | ✅ |
| 图表桩调用计数 + 去重调用序列 | — | **完全相同** | ✅ |
| ApiClient 调用计数 | getSymbols/getMaConfig/getDcapConfig/getKlineConfig/getKline 各 1 | **+ `getMultiPeriodConfig` 1** | Δ1（配置读取，`02-spec` §2 口径 12 的必要只读，与上一轮同一条差异，已解释） |
| 「多周期」开关 | 无 | 有（`aria-pressed=false`） | Δ2（派单要求新增的控件；`containerHTML` 8205→8518，+313 字符，位于 toolbar，**不在 main-chart 子树内**） |

> 与 P1-C 的等价性结论**完全一致**（同 2 处差异，均已解释）；main-chart 图表面逐字节等价。不可得项（诚实声明）：jsdom 无像素级渲染，"真实浏览器像素等价"仍不在覆盖内。

### 5.5 生成物一致性（沙箱全量重生成 + sha256）

- `./scripts/check-tangle.sh` ⇒ **exit 0**，`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。`
- **我自建沙箱**（`/tmp/p1d3/sbx`：`entangled.toml` + `design/` + 声明目标副本，删 `.entangled` 后 `entangled tangle -f`，**未在仓库内跑 tangle**）：产出 **224** 个文件（含 factsource）；对工作树逐文件 sha256 比对 ⇒ **identical 224 / differs 0 / missing 0**（`diff_report.txt`、`sandbox_manifest.sha256`）。
- 声明目标中工作树实存 **146** 个 ⇒ **0 漂移**（`gen_manifest.sha256`，146 行；清单中 1 条为 design 散文中被 grep 命中的垃圾串 "`"，非文件）。
- 相对 HEAD：146 个生成物中**仅 3 个**变化 —— `crates/web/src/dto.rs`（`fab9d2ce…`）、`crates/web/src/lib.rs`（`cefedb81…`）、`crates/web/src/rest.rs`（`8758160b…`）⇒ 其余 **143 个逐字节零变化**（`vs_head.txt`）。

### 5.6 四套门禁

| 命令 | 结果 |
|---|---|
| `cargo test -p web --no-fail-fast` | **109 passed / 0 failed**，exit 0（14 个 target；`api_multi_period_config` **17/17**、`multi_period_pane_budget` **8/8**） |
| `cd web && ./node_modules/.bin/vitest run` | **68 files / 628 passed / 0 failed**，exit 0（10.03s） |
| `cd web && ./node_modules/.bin/tsc -b` | **exit 0** |
| `./scripts/check-tangle.sh` | **exit 0** |

## 6. 项 6 — 反向证据（突变检验）

### 6.1 真突变（对 dto.rs 逐字节抽取的纯函数源码做 3 个突变）

harness：`/tmp/p1d3/harness.rs` = `dto.rs` 第 142 行 + 193–219 行**逐字节抽取**的函数体（sha256 见 `10_verbatim_fn_sha256.txt`）+ Tester 自写 main；`rustc --edition 2021 -O` 独立编译（无 cargo/无 workspace）。

| 突变 | 内容 | 实测 |
|---|---|---|
| 基线（无突变） | — | `HARNESS fail_count=0`；`pane_count(4p,["dcap"]×11)=4`；边界 12 允许 / 13 拒绝 ✅ |
| **A：去掉去重** | `n_inds = normalize(...).len()` → `indicators.len()` | **D1 用例立刻变红**：`fail_count=6`；`["dcap"]×11 → pane 34 ≠ 4`；`4 周期 × ["dcap"]×11 被误拒`（复现 P1-C 缺陷 D1） |
| **B：放宽 §7.4** | `MULTI_PERIOD_MAX_PANES = 12` → `100` | **护栏负例立刻变红**：`fail_count=1`；`S74_RED: 16 pane 未被拒绝`；13-pane 边界不再拒绝 |
| **C：去掉被拒维度名** | 错误串回退为去重前形态 | **D2 用例立刻变红**：`fail_count=1`；`names_dimension=false` |

### 6.2 历史前后对照（同一输入，修复前 vs 修复后）

- 修复前（P1-C 独立探针，2026-09-14 20:43–20:48，`tester/evidence/264_p1c/t6_http_responses.txt`）：`PUT periods=[1m,5m,15m] indicators=["dcap"]×11` ⇒ **400** `{"error":"总 pane 数 23 超上限 12（基准 1 + Σ_卫星指标 pane）"}`。
- 本轮（P1-D-3 独立探针）：**同一输入 ⇒ 200**，回显/读回 `indicators=["dcap"]`。
- 对照原文见 `11_reverse_evidence_pre_fix_vs_now.txt`。

## 7. 崩溃 / core dump

**无**。31 个 HTTP 用例 + 224 文件比对 + 3 个突变二进制 + 4 套测试全绿，未见进程崩溃或 core dump（无 `core.*` 产出；临时实例日志 `probe_app.log` 无 panic/ERROR 级条目）。

## 8. 失败用例表

**无失败用例**（`cargo test -p web` 0 failed；`vitest` 0 failed；独立 HTTP 探针 31/31；突变 A/B/C 的"红"是**预期的反向证据**，非产品缺陷）。

## 9. 卫生与归因

| 约束 | 实测 |
|---|---|
| 未改仓库文件（实现/设计/tracked） | ✅ `git diff --cached` 空；tracked `M` 数为 **11**（与本轮开始完全一致，清单未变）；本轮**新增**仅 `tester/evidence/266_p1d3/` 与 `tester/test/266_*.md`（未跟踪报告与证据） |
| 禁 `git add/commit/stash` | ✅ 未执行 |
| 禁仓库内跑 tangle | ✅ 仅 `/tmp/p1d3/sbx` 内 `tangle -f` |
| 不重启线上 | ✅ PID **3112540** 存活（`09:16` 运行时长），未触碰 |
| 线上写请求 | ✅ **0**（唯一一次线上请求为只读 `GET /api/health`（404），用于存活探测；诚实披露） |
| 临时实例/端口 | ✅ 实例 `1724122` 已 kill；`18147/18146`、`18098/18099` 均无监听 |
| 共享库清理 | ✅ `app_config` 键集合 = `{dcap}`；`multi_period` **count(\*)=0**（psql 复核） |
| 临时资产 | ✅ 仓库外 `/tmp/p1d3/`（探针、沙箱、副本、证据原件）；**仓库内仅 tester 报告/证据** |

**归因（tracked 改动，11 个 `M`，均非本轮产生）**：
- 事实源（手写）：`design/07-app-plane/00-web-api.md`、`design/15-multi-period/02-spec.md`、`design/15-multi-period/03-test-plan.md`
- tangle 生成物（3 个）：`crates/web/src/{dto,lib,rest}.rs`
- 前端手写：`web/src/api/{client,mock,types}.ts`、`web/src/features/dashboard/{DashboardPage,Toolbar}.tsx`

> 说明（不影响验收）：为使探针运行的是**含 D1/D2 修复**的二进制，本轮执行了 `cargo build -p app --bin eestock-app`（`target/` 为 gitignore 构建产物，源码零改动）；线上进程继续运行其原有可执行映像，存活未受影响。

## 10. 观察项（残余风险，非本轮验收项；附最小修正建议）

**M1（mock 镜像未同步 D1/D2 契约）** — 位置：`web/src/api/mock.ts::assertMultiPeriodConfig`（tangle 生成物，其 design 块在 `design/07-app-plane/00-web-api.md`）。
独立复现（`zzz_p1d3_mock_probe.test.ts`，在 `/tmp` 副本运行，仓库零改动）：

| 输入 | 后端（真实 axum，本轮实测） | mock（本轮实测） |
|---|---|---|
| `periods=[1m,5m,15m]`、`indicators=["dcap"]×11` | **200**（去重后 3 pane） | **抛 ApiError 400** `HTTP 400: 总 pane 数 23 超上限 12`（按原始长度计数） |
| `indicators=["dcap","dcap"]` | 落库/读回 **`["dcap"]`**（归一化） | 落库/读回 **`["dcap","dcap"]`**（未去重） |

即：mock 泳道仍保留 D1 的**去重前语义**（原始长度计 pane + 不去重落库），与 §2-6/§7.4 契约不一致。**最小修正建议**：doc-first 改 `design/07-app-plane/00-web-api.md` 的 mock 代码块—— `indicators` 先去重（保留首现序）再计数/落库，且 pane 错误串含 `indicators`；再 `scripts/stitch.sh` 回写 `mock.ts`。属**独立派单项**（P1-D-2 已上报待裁决，本轮未越权实施）。

**M2（诚实声明，沿用上一轮）** D4 的计数类断言（实例/订阅/取数零残留）在 P1（无卫星实例）下结构性地恒真，属 P2 就绪回归守卫；真实灵敏度已由突变 A/B/C 与 §5.4 等价性度量补强。

---

## 11. 命令清单（本轮实际执行）

```
cargo build -p app --bin eestock-app                     # 取得含 D1/D2 修复的探针二进制（源码零改动）
/tmp/p1d3/eestock-app-probe --config /tmp/p1d3/probe.toml   # 临时实例 127.0.0.1:18147 / MCP 18146
python3 /tmp/p1d3/probe.py                               # 31 用例独立 HTTP 探针（真实 axum，临时端口）
kill 1724122                                             # 临时实例收尾
psql … "DELETE FROM app_config WHERE key='multi_period'" ; "SELECT count(*)"   # 库卫生复核 = 0
cargo test -p web --no-fail-fast                          # 109 passed / 0 failed
cd web && ./node_modules/.bin/vitest run                  # 68 files / 628 passed
cd web && ./node_modules/.bin/vitest run src/features/dashboard/multiPeriodClosedEquivalence.test.tsx src/features/dashboard/multiPeriodStore.test.ts --reporter=verbose   # D4/T11 11 passed
cd web && ./node_modules/.bin/tsc -b                      # exit 0
./scripts/check-tangle.sh                                 # exit 0
entangled tangle -f                                       # 仅在 /tmp/p1d3/sbx 沙箱；224 文件 0 漂移
rustc --edition 2021 -O harness.rs / mutA.rs / mutB.rs / mutC.rs   # 突变检验（源码逐字节抽取）
git diff --cached --name-only ; git status --porcelain    # 卫生
```

**未做**：未修改任何实现/设计/接口/架构；未调试或修复任何失败；未新增仓库内测试；未加instrumentation。

**VERDICT: PASS**
