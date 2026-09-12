# 151 — 债务清理批次 1：F3-f 孤立标记清理 / 1m 性能断言自校准 / 前端 fee 类型漂移复核

- **报告自身路径**：`coder/report/151_debt_cleanup_batch1.md`
- **证据目录**：`coder/evidence/151_debt_cleanup/`（01–08，见 §4.3）
- **状态**：三项完成（各自的独立证据见下）；`git diff --cached` = 0（无 staged）；tangle 门禁绿
- **日期**：2026-09-13
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`（分支 `master`，基线 HEAD `a5c2b93`）
- **纪律**：**未** `git add`/stage；**未**重启服务；DB **只读**（全部为 SELECT / EXPLAIN，无写库；无测试写库）

---

## 0. 变更清单

| # | 文件 | 变更 | 行数 |
|---|---|---|---|
| 1 | `crates/web/src/settings.rs` | 删 1 行孤立 `// ~/~ begin …` 标记注释 | −1 |
| 2 | `crates/web/tests/api_settings.rs` | 删 1 行孤立 `// ~/~ begin …` 标记注释 | −1 |
| 3 | `crates/storage/tests/kline_reader.rs` | 性能断言改**自校准**（+ 语义等价功能断言）；生成物侧 | +96 / −14 |
| 4 | `design/07-app-plane/00-web-api.md` | 上项的事实源回写（`./scripts/stitch.sh` 沙箱 stitch + round-trip 校验） | +96 / −14 |
| 5 | `coder/evidence/151_debt_cleanup/*`（新增，未跟踪） | 8 份证据文件 | 新增 |
| 6 | `coder/report/151_debt_cleanup_batch1.md`（本文件，新增，未跟踪） | 变更报告 | 新增 |

`git diff --stat`：

```
 crates/storage/tests/kline_reader.rs | 110 ++++++++++++++++++++++++++++++-----
 crates/web/src/settings.rs           |   1 -
 crates/web/tests/api_settings.rs     |   1 -
 design/07-app-plane/00-web-api.md    | 110 ++++++++++++++++++++++++++++++-----
 4 files changed, 192 insertions(+), 30 deletions(-)
```

（`kline_reader.rs` 与 `00-web-api.md` 的 110 行 = 96 行新增 + 14 行删除，两侧**逐行一致**，见 §2.7。）

---

## 1. 项 1：F3-f 残留——孤立 `begin` 标记清理（ADR-018 §7.1）

### 1.1 事实复核（架构师结论复现，证据 `07_item1_governance_and_compile.txt`）

| 事实 | 取证 |
|---|---|
| 二文件各含 **1 行孤立 `// ~/~ begin <<…>>[init]`**（无对应 `end`） | `git show HEAD:crates/web/src/settings.rs \| head -1`、`…/api_settings.rs \| head -1`（均命中） |
| `design/06-web/08-settings.md` **无**对应生成物声明块 | `grep -n 'file=' design/06-web/08-settings.md` → 仅 `preview/08-settings.html`、`web/src/layouts/SettingsGrid.tsx` 两处 |
| 全仓 `design/` 未声明二者 | `grep -rn 'settings.rs\|api_settings.rs' design/ \| grep 'file='` → 0 命中 |
| 二者**不在** `.entangled/filedb.json` | `crates/web/src/settings.rs: in filedb = False`、`crates/web/tests/api_settings.rs: in filedb = False`（filedb targets = 144） |

⇒ 二者确实**不受 tangle 治理**：既无声明块、也无 filedb 登记，标记行纯属误导（尤其 `settings.rs:2` 的
`//! 由 08-settings.md tangle 生成（ADR-007），禁止手改。` 属同源遗留描述——**本项按任务书"仅删标记行、
  零语义改动"未触碰**，登记为残留观察，见 §5-R3）。

### 1.2 改动与 diff（**恰 2 行删除**，`04_item1_marker_removal_diff.txt`）

```diff
--- a/crates/web/src/settings.rs
+++ b/crates/web/src/settings.rs
@@ -1,4 +1,3 @@
-// ~/~ begin <<design/06-web/08-settings.md#crates/web/src/settings.rs>>[init]
 //! 页面⑧ 系统设置 S1+S2：系统信息 / 危险运维 / 配置持久化 + PATCH / 只读快照端点（08-settings.md §6）。
--- a/crates/web/tests/api_settings.rs
+++ b/crates/web/tests/api_settings.rs
@@ -1,4 +1,3 @@
-// ~/~ begin <<design/06-web/08-settings.md#crates/web/tests/api_settings.rs>>[init]
 //! 页面⑧ 系统设置 S1 端点集成测试（需 TimescaleDB :5433）：真实起 axum server + reqwest 断言。
```

`git diff --numstat` = `0 1` + `0 1`（**恰 2 行删除、0 行新增**）；改后 `grep -c '~/~'` 对二文件均为 **0**。

### 1.3 编译确认

```
$ cargo check -p web --all-targets
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.92s      # 首次（含 test target）
$ cargo check -p web --test api_settings --lib
    Finished `dev` profile …                                                # 复用缓存，exit 0
```

（后续复验 `cargo check -p web --all-targets` 亦 exit 0，见证据 07。）

### 1.4 全仓 `~/~` 行分类清单（逐条分类，证据 `01_tangle_inventory_after.txt`）

枚举：仓库根，排除 `.git/`、`target/`、`node_modules/`、`.entangled/`、`.claude/`、`.pi/`、`.gitnexus/` 与二进制资产；
分类器区分**真标记行**（`[注释前缀] ~/~ begin <<…>>` / `… ~/~ end`）与**散文提及**（其余含 `~/~` 的行）。

| 类别 | 判定 | 清理后实测 |
|---|---|---|
| **(a) 受治理生成物** | 期望：各**恰 1 组** begin/end，且 filedb 登记 | **144 文件**，全部恰 1 组 ✅ |
| **(b) 设计文档代码块内** | 期望 **0** | **0** ✅（`design/**/*.md` 仅剩散文提及，见 (d)；ADR-018 的 8 处提及经 `in_fence` 判定全在围栏外） |
| **(c) 孤立（begin/end 不成对）** | 须清 | **0** ✅（本批清理前为 2：`settings.rs`、`api_settings.rs`；即本批 2 行删除） |
| **(d) 散文提及 / 证据文本** | 保留 | **15 文件 50 行**：`README.md`、`scripts/stitch.sh`(5)、`ADR-018`(8)、`coder/report/{034,082,145,146,150}`、`tester/report/012`、`tester/test/{035,036}`、`tester/evidence/012/*`(3) |
| **(c′) 成对但"无主"（不在 filedb、未被任何文档声明）** | 本批**不属"孤立"**，登记为待裁定（见 §5-R1） | **5 文件**：`crates/storage/src/system.rs`(1 组)、`design/11-sim-live/preview/{sim-live,sim-live-history}.html`(各 1 组)、`scripts/tests/{test_stitch,test_check_tangle}.sh`（**后 2 者**为合成夹具内的**数据**，非本仓标记，保留） |

合计：**164 文件 / 348 行**，其中真标记行 begin=149 / end=149（成对）、散文提及 50 行。

> **(a) 说明**：144 = `.entangled/filedb.json` 的 `targets` 全长（含 7 份 `design/06-web/preview/*.html`）。
> **(b) 说明**：报告 150 §2 的结论（文档代码块内已清零）本次**独立复核成立**。

---

## 2. 项 2：flaky 性能断言根治 —— 自校准（方案 a）

### 2.1 问题与根因（含实测）

- 现象：`crates/storage/tests/kline_reader.rs:178`（原）绝对墙钟断言 `dt.as_millis() < 500` 在 tester 014 全量回归中**偶发 1 次红**（504ms vs 500ms）；隔离重跑 3/3 绿（282/290/288ms）。
- 本次实测根因（DB 只读 EXPLAIN，`psql … EXPLAIN (ANALYZE, BUFFERS)`）：

| 观测 | 值 |
|---|---|
| 目标 SQL（新 `MERGED_1M_SQL`）**Planning Time** | **585–800 ms**（hypertable ~1000 chunk 子计划） |
| 目标 SQL **Execution Time** | **173–177 ms**（psql 冷语句）；稳态（prepared + generic plan）实测样本 60–390 ms |
| 修复前路径（`kline_merged` 直查 + DESC LIMIT） | 恒 ~1.1–1.5 s（全量 Append 769k 行 + top-N） |

⇒ 断言测到的是「**执行 + 计划**」之和。sqlx 复用已 prepare 语句且 PG 数次执行后选定 generic plan ⇒ 稳态 60–390ms；
但同 binary 其它测试的 `refresh_continuous_aggregate` / `DELETE` 会**让计划缓存失效并退回 custom plan**，
该次执行把 planning 一起计 ⇒ ~500ms 假红。**与机器负载无关**——绝对阈值本质不稳。

### 2.2 方案选择（按任务书优先级 (a) > (b) > (c)）

- **(b) 不可用**：无可观测的"查询次数/N+1"面——`pg_stat_statements` **未预加载**（`shared_preload_libraries=timescaledb`，
  启用需重启服务 = 红线）；生产 SQL 常量 `MERGED_1M_SQL` 为 `storage::reader` 私有，测试无法取文本做 plan 断言
  （把它改 `pub` = 扩接口，须另行裁定）。
- **(c) 不采用**：仅放宽阈值仍会把 planning 抖动留在判据内，且"远高于抖动"的阈值（≥1s）已接近修复前路径量级，门禁意义趋零。
- **(a) 采用（本轮实现）**：**同一次运行内**测参考操作 = **修复前路径原文**（ab470b2 前的 `MERGED_1M_SQL`，
  即 `PRE_FIX_1M_SQL`：`SELECT … FROM kline_merged WHERE code=$1 AND (before) ORDER BY ts DESC LIMIT $3`），
  判据 `min(目标) × 2 < min(参考)`（比值 < 0.5）。

### 2.3 系数依据（实测，`03_perf_ratio_probe_and_mutation.txt`）

- 探针 11 次运行 × 各 5 样本（含 3 次**并发压测**：与整套 `kline_reader` 同跑）：
  - `min(目标)/min(参考)` ∈ **[0.052, 0.069]**
  - 最坏 `max(目标)/min(参考)` = **0.342** ⇒ 稳态比值 ≤ 0.35
- 取 **0.5** 作判据：对最坏实测仍留 **1.43×** 余量；对典型值留 3–20×（"宽松系数"）。
- 估计量取 **min**（非均值/单次）：计划抖动与调度延迟只会抬高个别样本，不会抬高最小值。
- 相对判据的关键性质：机器快慢、缓存冷热、并行负载**在两侧同向抵消**。
- 样本留存：3 次（含等价断言 OK 行）+ 突变实验 + 参考路径剖面（首发 1504/1567ms、稳态 1083–1128ms
  ⇒ 参考侧预热 2 次恰好越过冷启动）。

### 2.4 失效场景（本判据**才会红**的情形）

| # | 场景 | 实测证据 |
|---|---|---|
| ① | **1m 读源退回「全量 Append + top-N」**（分支级索引 DESC LIMIT 被绕过/删除）→ 目标 ≈ 参考 | **突变实验**（以修复前路径冒充"目标"，判据不变）：`target=1090ms ref=1109ms ratio=0.983`（另一次 1.275）⇒ **≥0.5 必红** ✅ 判据非空 |
| ② | 该路径整体慢 ≥2×（含计划开销） | 由 ① 的同一单调性覆盖 |
| ③ | **参考基线不可用**（`kline_merged` 视图被退役 / 无权限） | `pre_fix_1m_rows` 用 `.expect("1m 修复前路径（参考基线）可用")` —— PG 缺表是 **ERROR**（实测 `ERROR: relation "kline_no_such_base" does not exist`），sqlx 映射为 `Err` ⇒ **panic 红**，**不会**静默放行 ✅（该路径无 `return`/skip 分支） |
| — | **不再**会红的情形 | 单次计划抖动、机器负载波动（原先 504ms 假红的成因） |

> 唯一 skip 分支仍是**目标侧**的既有前置（`518880` 无 500 根 M1 → `[bench-skip]` 提前 return，避免假阴性）；
> 该分支与判据无关，且真实库该 code 有 769,513 行 M1，本批 21 次连跑未触发。

### 2.5 功能覆盖**加强**（未削弱）

| 断言 | 改前 | 改后 |
|---|---|---|
| 500 根 | ✅ | ✅ |
| 严格升序（⇒ 无重复） | ✅ | ✅ |
| **语义等价**：与修复前路径同参结果逐根比对 `ts/open/high/low/close/volume/amount/source` | ✗ | ✅ **新增**（锁定「双侧索引 DESC LIMIT 合并」与旧全量合并同口径；探针多次 `PROBE equivalence = OK`；DB 侧 `EXCEPT` 双向 0 行） |
| 性能 | 绝对墙钟 <500ms（不稳） | 自校准相对判据（机器无关） |

### 2.6 ≥20 次连跑（**全绿**）

| 批次 | 对象 | 结果 |
|---|---|---|
| 第 1 批（`02_perf_selfcalib_21runs.txt`） | 改后断言（与终稿**代码/断言逐字节相同**，此后仅改注释文字） | **21/21 PASS**，比值 0.237–0.283（mean 0.262）；目标 min-of-3 = 284–390ms，参考 min-of-3 = 1087–1461ms |
| 第 2 批（`02_perf_selfcalib_21runs_final.txt`） | **终稿**（含 tangle 回写后的最终字节） | **21/21 PASS**（0 failed），比值 **0.142–0.490**（mean 0.277）；目标 min-of-3 = 298–627ms，参考 min-of-3 = 1122–2334ms |

> 第 2 批覆盖到一次**外部负载窗口**（run 03–05：目标 min 537–627ms ≈ 静默态 2.1×、参考仅 ≈1.16×），
> 其中 run 05 比值 **0.490**（对判据 0.5 的余量 **1.02×**）——全绿，但余量收窄，已登记 §5-R5（建议与依据同处）。

每行输出格式（可独立复核）：

```
run 01: PASS | 目标 min=342ms vs 修复前路径 min=1362ms（比值 0.251，判据 <0.5） | test result: ok. 1 passed; 0 failed; …
…
== 连跑汇总：21 passed / 0 failed（共 21 次）==
```

复现命令（单次）：

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
cargo test -p storage --test kline_reader merged_1m_branch_index_limit_performance -- --nocapture
# 连跑：见 coder/evidence/151_debt_cleanup/02_perf_selfcalib_21runs*.txt 内脚本形态
```

### 2.7 TDD 与文档回写（ADR-007 / ADR-018）

- **Red**：先做**突变实验**（`zz_mutation_pre_fix_gate.rs`，临时夹具）：以修复前路径冒充目标 ⇒ 同判据 **必红**
  （ratio 0.983 / 1.275 ≥ 0.5）——证明判据非空、且在"退回全量合并"时确实失败。
- **Green**：实现自校准判据 ⇒ 测试绿（首跑 `目标 min=352ms vs 修复前路径 min=1275ms（比值 0.276）`）。
- **Refactor/回写**：生成物改完后 `./scripts/stitch.sh crates/storage/tests/kline_reader.rs`
  → 沙箱 stitch + round-trip 校验通过，回写 `design/07-app-plane/00-web-api.md`（**生成物零回退**）。
- **两侧一致性独立复核**（`06_item2_diff_and_roundtrip.txt`）：抽出 `00-web-api.md` 内 `{.rust file=crates/storage/tests/kline_reader.rs}`
  块（728 行）与生成物（去掉首行 begin 标记后 728 行）**逐行一致 = True**。

---

## 3. 项 3：前端 TS 类型漂移**复核**（tester 014 §11 / R2 指认 `types.ts:873`、`mock.ts:1406`）

### 3.1 判定结论：**属 (a) 钉住 config 的 `fee`（扁平）⇒ 非漂移，未改动**

**行号反证证据**（证据 `05_item3_ts_fee_evidence.txt`）：

| 位置 | 实际内容 | 所属形状 |
|---|---|---|
| `web/src/api/types.ts:873` | `fee: WorkbenchFee;` —— 位于 `export interface WorkbenchRunConfig`（866–874 行）内 | **钉住 config 快照**（`strategy_run.config` / `strategy_preset.config` / apply 返回；见该接口 866 行注释） |
| `web/src/api/mock.ts:1406` | `fee: req.fee,` —— 位于 mock 的 `const config: WorkbenchRunConfig = {…}`（1399–1407）内 | 同上：**钉住 config 的构造点**，非任何响应 DTO |

**数据形状来源（后端 = 事实源）**：

| 形状 | 产生点 | 键 |
|---|---|---|
| 钉住 config（**扁平**） | `crates/application/src/fee.rs::fee_model_to_json`；写入点 `crates/application/src/workbench.rs:357`（`"fee": crate::fee::fee_model_to_json(&fee)`） | `{rate_pct, min_fee, slippage_bp, stamp_duty_pct}`（4 键） |
| 响应回显（**两段**） | `crates/application/src/fee.rs::resolved_fee_to_json`；仅用于 `crates/application/src/strategy.rs` 的 `TestRunResponse.fee`（885/969/1070）与 MCP 回显 | `{effective:{commission_rate_pct,min_fee,stamp_duty_pct,slippage_bp,source}, profile:{…,not_modeled}, symbol_type}` |

**设计事实源（ADR-019 §6 v1.1 R-1，`design/01-architecture/adr/ADR-019-symbol-type-fee-profiles.md:83`）**：

> 「钉住 config 保持**扁平**（`fee_model_to_json`）：`strategy_run.config.fee` 与预设往返/前端读取**必须**向后兼容。
> 两段结构**只用于试算/回测的响应回显**（`resolved_fee_to_json`），且不得混入 config。」

（ADR-019:94 亦点名 `workbench.rs::submit` 的写入点。v1.0 曾把两段写进 config，v1.1（commit `2844cc3`）已回退为扁平。）

**运行时消费者证据**（`ConfigPanel.tsx` 按扁平读取钉住 config）：

```
web/src/features/workbench/ConfigPanel.tsx:360  setFeeRate(String(cfg.fee.rate_pct));
web/src/features/workbench/ConfigPanel.tsx:361  setFeeMin(String(cfg.fee.min_fee));
web/src/features/workbench/ConfigPanel.tsx:362  setFeeSlippage(String(cfg.fee.slippage_bp));
web/src/features/workbench/ConfigPanel.tsx:87/100/322  fee: cfg.fee（回填→提交/建预设）
```

⇒ `types.ts:873` 与 `mock.ts:1406` 描述的都是**扁平钉住 config**，与 v1.1 R-1 一致 ⇒ **非漂移，按任务书"属 (a) 不要改动"处理，`web/src` 本批零改动**。

### 3.2 复核中发现的**旁证**（tester 014 R2 指认点错位；**未改动**，登记 §5-R2）

1. 真正的「两段响应 fee」面在 `StrategyTestRunResp`（`types.ts:784–794`）——该接口**没有 `fee` 字段**
   （`grep -rn 'not_modeled\|fee.effective\|fee.profile' web/src` → **0 命中**：既无类型也无消费者）。
   即：不是"类型写错"，而是"响应字段未建模"（缺口），无运行时漂移。
2. 钉住 config 的扁平形状为 **4 键**（含 `stamp_duty_pct`），而 `WorkbenchFee`（`types.ts:832–836`）只声明 **3 键**；
   无消费者读取 `stamp_duty_pct` 且钉住 config 的额外键对 TS 结构化类型无害 ⇒ 不构成漂移（若将来要读/回写，
   补一个可选字段即可；本批按"属 (a) 不改"处理）。
3. mock 保真度观察：mock 直接 `fee: req.fee`（3 键请求形状），真实后端落库为 `fee_model_to_json` 的 4 键
   （含 stamp 实际取值）⇒ 开发态 mock 与生产形状有**键集差异**（非类型漂移、无运行时消费者）。

`tsc`/`vitest`：本批 `web/src` **零改动**（`git diff --stat` 无 web/src 条目），故不构成 gate 对象；
如需基线，tester 014 证据 `13_frontend_tsc_vitest.txt` 记录 tsc 0 error / vitest 457 passed。

---

## 4. 门禁 / 纪律 / 证据清单

### 4.1 门禁

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
```

（本批改动后复跑；基线（改动前）同样为 ✅，两处均在 session 内执行。）

### 4.2 纪律核对

- `git diff --cached --name-only | wc -l` → **0**（无 staged；上游任务书要求"不 git add"）。
- DB 只读：全部为 `SELECT` / `EXPLAIN (ANALYZE)` / 被测只读查询；无写库（`kline_reader` 其余用例的写库行为未被本批触发/改变）。
- 未重启任何服务。

### 4.3 证据清单（`coder/evidence/151_debt_cleanup/`）

| # | 文件 | 内容 |
|---|---|---|
| 01 | `01_tangle_inventory_after.txt` | 全仓 `~/~` 行分类清单（终态，含 (a) 144 文件清单、各类判定） |
| 02 | `02_perf_selfcalib_21runs.txt` / `02_perf_selfcalib_21runs_final.txt` | 两批 ≥20 次连跑计数输出（判定输出 + 比值 + 汇总行） |
| 03 | `03_perf_ratio_probe_and_mutation.txt` | 探针 3 次比值分布 + 等价断言 OK + **突变实验（Red）** + 参考路径耗时剖面 |
| 04 | `04_item1_marker_removal_diff.txt` | 项 1 的 diff（恰 2 行删除） |
| 05 | `05_item3_ts_fee_evidence.txt` | 项 3 全部取证（行号、前后端形状来源、消费者、设计事实源、检索 0 命中） |
| 06 | `06_item2_diff_and_roundtrip.txt` | diff --stat + 设计文档块 vs 生成物逐行一致 = True |
| 07 | `07_item1_governance_and_compile.txt` | 项 1 治理取证（声明块/filedb/前后首行）+ `cargo check -p web --all-targets` |
| 08 | `08_inventory_script.py` | 清单分类脚本（可复现） |

### 4.4 复现命令

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
cargo check -p web --all-targets                       # 项 1
cargo test -p storage --test kline_reader              # 项 2（整文件；单测见 §2.6）
./scripts/check-tangle.sh                              # 门禁
python3 coder/evidence/151_debt_cleanup/08_inventory_script.py   # 项 1 全仓清单
```

---

## 5. 残留风险 / 待裁定（**均为登记项，未扩大范围**）

| # | 事项 | 等级 | 说明 / 建议 |
|---|---|---|---|
| R1 | **3 处"无主"标记**（成对但无声明、不在 filedb）：`crates/storage/src/system.rs`（1 组，L1/L58）、`design/11-sim-live/preview/sim-live.html`、`sim-live-history.html`（各 1 组） | 低 | 与项 1 同源（手工粘贴标记 + 无声明块）。`system.rs` 在任何历史 revision 中**从未**被 `design/` 声明（`git log -S 'file=crates/storage/src/system.rs' -- design/` → 0 命中）；sim-live 两份同为 e6266bc 引入的静态样机资产，其 `<<design/11-sim-live/01-adr.md#…>>` 是**悬空引用**（该文档 `file=` 计数 = 0）。建议另开 1 项：删 3 文件各 1 组标记（共 6 行、零语义）。**本批按任务书"应恰为 2 行删除"未触碰**。 |
| R2 | 响应侧两段 fee 在 TS **未建模**（`StrategyTestRunResp` 无 `fee` 字段） | 低 | 无消费者（0 命中）。建议 follow-up：新增 `ResolvedFee`（`effective/profile/symbol_type`）+ 注释标注事实源 `design/07-app-plane/01-mcp.md:109`、ADR-019 §6。**本批未改动**（任务书对"(a)"要求不改动）。 |
| R3 | `crates/web/src/settings.rs:2` 仍写「由 08-settings.md tangle 生成…禁止手改」 | 低 | 项 1 后该描述已失实（该文件不受治理）。属注释语义修正，本批按"仅删标记行、零语义改动"未动。 |
| R4 | 参考基线依赖 legacy 视图 `kline_merged` | 低 | 若该视图退役，测试以**缺表 panic 红**（已确认非静默），须同步替换参考基线；注释已写明。 |
| R5 | 自校准判据在**外部重负载**下余量收窄 | 低 | 实测：静默态比值 0.24–0.28；负载窗口 (run 03–05) 升至 0.406–**0.490**（余量 1.02×，仍全绿）。机理：目标侧含 planning（对 load 敏感），参考侧主要为 cached-plan 执行（较不敏感）→ 二者负载弹性不对称。建议（供架构裁量，**本轮未改**以免重做 ≥20 次验证）：目标侧改 **min-of-5**（+~0.6s 运行时间，抗瞬时干扰更强）或系数放宽至 **0.6**（=要求 ≥1.67×，按 §2.3 实测分布仍能抓住"退回全量合并"的真回归：突变实验比值 0.983/1.275 ≫ 0.6）。 |
| R6 | 原报告 150 §2(d) 称 9 份 preview 均在 filedb | 信息更正 | 实测 filedb 仅含 `design/06-web/preview/*.html` **7 份**；sim-live 2 份**未登记**（见 R1）。 |

**新引入的未跟踪临时夹具：0**（会话内曾用 `crates/storage/tests/zz_{probe_perf_ratio,mutation_pre_fix_gate,ref_profile}.rs` 三个探针，
**均已删除**；`git status` 中 `??` 仅剩本批证据/报告目录与仓库既有未跟踪项）。

---

# §收尾（2026-09-13，架构师三项裁决落实）

- **范围**：仅裁决 1/2/3 三项小增量；无其它改动。
- **基线 HEAD**：`3cbd757`（本批未提交任何内容；`git diff --cached --name-only | wc -l` = **0**）。
- **本 § 的证据文件**：`coder/evidence/151_debt_cleanup/09…14`（见 §收尾-4）。
- **时间盒**：本收尾实际耗时 ≈ **22 分钟**（超 12 分钟预算），主因是裁决 1 要求 ≥20 次连跑（单次含 13 次目标 + 7 次参考查询，且期间机器 load average 5–7 的外部负载）。**未静默缩减项**：三项全部完成，未完成项 = 无。

## §收尾-1 裁决 1：性能断言双加固（min-of-5 + 阈值 0.6）

### 改动（`crates/storage/tests/kline_reader.rs` + 事实源 `design/07-app-plane/00-web-api.md`）

| 项 | 改前（批次 1） | 改后（本收尾） |
|---|---|---|
| 目标侧样本 | 3 次取 min（另 8 次预热） | **5 次取 min**（另 8 次预热） |
| 参考侧样本 | 2 次预热 + 3 次取 min | **2 次预热 + 5 次取 min**（与目标侧**对称**） |
| 判据 | `min3(目标) × 2 < min3(参考)`（等价比值 <0.5） | `比值 = min5(目标)/min5(参考) < 0.6` |
| 断言表达 | `t_target * 2.0 < t_ref` | `ratio < 0.6`（`ratio` 计算一次并进失败消息/日志） |

**为什么两侧都取 min-of-5（而非只改目标侧）**：估计量仍是 min（单次计划抖动/调度延迟只会抬高个别样本，
不会抬高最小值）。两侧样本数相同避免「一侧 min-of-3、一侧 min-of-5」的估计量口径歧义。**实测净效果**：
对称取样把比值从批次 1 的 0.237–0.490 压到 **0.030–0.063**（见下）——说明多取样本主要压低了**目标侧**
（含 planning、对负载敏感）的最小值，而参考侧（cached plan 执行）的最小值几乎不动，故对称取样整体拉大余量。
**改动未触碰任何生产/运行时路径**（`crates/` 仅测试文件与前置注释；语义等价断言、skip 分支、参考基线一律保留）。

### 连跑 ≥20 次：计数与比值分布（证据 `09_perf_min5_20runs.txt` + `09_stats.py`）

```
runs = 20   PASS = 20   FAIL = 0
比值 min=0.030  max=0.063  mean=0.055  median=0.056
目标 min5(ms) min=60   max=122    mean=70.9
参考 min5(ms) min=1087 max=2424   mean=1326.1
阈值 = 0.6；最坏比值 0.063 ⇒ 余量 = 0.6/0.063 = 9.52×   （要求 ≥1.5× ✅）
```

**该批次的负载背景不是静默态**：机器 `load average ≈ 5.5–7.2`（16 核，含其它 session），期间
run 12–19 明确落在**外部负载窗口**（参考 min5 从 1087ms 抬到 2424ms、目标 min5 从 60ms 抬到 122ms），
但**比值仍稳定在 0.030–0.063**——两侧同向膨胀（这正是相对判据的设计性质），余量未被吃穿。
**故本轮不再需要"下一档方案"**（原 R5 建议的 0.6 档已足够；min-of-5 使最坏余量从 1.02× 提升到 9.52×）。

### 突变实验（Red 非空证明，`13_mutation_min5_gate.txt`）

夹具 `crates/storage/tests/zz_mutation_min5_gate.rs`（**临时，运行后已删除、不入库**）：以「修复前路径」
（`PRE_FIX_1M_SQL`：`kline_merged` 全量 Append + top-N）**冒充目标**，判据与终稿**逐字相同**
（比值 = min5(目标)/min5(参考) < 0.6；预热 8+2、双侧各 5 样本）：

```
[mutation] 修复前路径冒充目标：目标 min5=1455ms vs 参考 min5=1425ms（比值 1.021，判据 <0.6）
thread '…' panicked at crates/storage/tests/zz_mutation_min5_gate.rs:47:5:
突变实验：修复前路径冒充目标时判据必须红（实测比值 1.021 ≥ 0.6）——判据非空证明
test result: FAILED. 0 passed; 1 failed
```

⇒ **判据非空**：分支级索引 DESC LIMIT 被绕过（退回全量 Append + top-N）时比值 ≈1.0 ≫ 0.6，**必红** ✅。
（对照批次 1 的突变实测 0.983 / 1.275，同量级；阈值从 0.5 放宽到 0.6 后仍与真回归量级差 ≥16×。）

### 回写与门禁

`./scripts/stitch.sh crates/storage/tests/kline_reader.rs` → 沙箱 stitch + round-trip 校验通过，
回写 `design/07-app-plane/00-web-api.md`（+104/−14，与生成物 `crates/storage/tests/kline_reader.rs`
**逐侧同数**）；抽出文档块与生成物（去首行 begin 标记、去尾行 end 标记）**逐行一致 = True**
（`生成物 body 738 行`含尾标记与空行 → 实际 736 行 == 文档块 736 行）。
`./scripts/check-tangle.sh` → ✅（沙箱重新生成 + 逐字节比对通过）。

## §收尾-2 裁决 2：TS 类型层补缺口（零运行时影响）

**改动 1**：新增 `ResolvedFee` 接口 + `StrategyTestRunResp` 补 **可选** `fee?: ResolvedFee`
（`web/src/api/types.ts`）。形状取自后端事实源 `crates/application/src/fee.rs::resolved_fee_to_json`：

| 段 | 字段（本批类型声明） |
|---|---|
| `effective` | `commission_rate_pct` / `min_fee` / `stamp_duty_pct` / `slippage_bp` / `source: 'explicit'\|'profile'\|'default'` |
| `profile?`（**可选**：后端仅在解析到档案时输出该段） | `type` / `commission_rate_pct` / `min_fee` / `exchange_fee_pct` / `regulatory_fee_pct` / `stamp_duty_pct` / `transfer_fee_pct` / `note` / `source` / **`not_modeled: string[]`** |
| `symbol_type` | `string \| null`（未解析 = null） |

**对裁决文字的**一处**实现细化（已按事实源落地，非静默偏离）**：裁决把 `not_modeled:string[]` 与 `profile{...}`
并列为 `ResolvedFee` 的成员；按 `resolved_fee_to_json` 实际线格式，`not_modeled` 位于 **`profile` 段内**，
且 `profile` 段**仅在解析到档案时出现**（后端 `if let Some(p) = &r.profile`）。故声明为
`profile?: { …, not_modeled: string[] }`。`fee` 选**可选**而非必填，另有硬约束：既有测试
`web/src/features/strategies/TestRunPanel.test.tsx:76` 构造的 `StrategyTestRunResp` 字面量不含 `fee`，
必填会直接让 `tsc` 红。设计事实源：`design/07-app-plane/01-mcp.md:107–117`「⚠️ WIRE 变更（ADR-019 D11）」。

**改动 2**：`WorkbenchFee` 补**可选** `stamp_duty_pct?: number`（+ 注释说明"入参三键、钉住 config 落库
4 键"）。事实源：`fee.rs::fee_model_to_json` 输出 `{rate_pct,min_fee,slippage_bp,stamp_duty_pct}`（4 键）。
**可选**是必需的——`WorkbenchFee` 同时被 `WorkbenchSubmitReq`（web 层三键入参）与 `WorkbenchRunConfig`
（钉住快照）复用，必填会让前端提交路径 `tsc` 红。

**与 design 事实源是否冲突**：**否**。`types.ts` 非 tangle 生成物（首行无 `~/~`、`grep -c '~/~' = 0`、
不在 `.entangled/filedb.json`、全 design/ 无 `file=web/src/api/types.ts` 声明）⇒ 直接编辑不需回写文档；
且本批只**补类型声明**、不引入新语义（两个字段都是可选，未改任何运行时逻辑/消费者/mock）。

**验证（`14_frontend_tsc_vitest.txt`）**：`npx tsc -b --force` → **exit 0**（另做过反事实自检：临时塞入
`const x: number = 'a'` 时 tsc 报 TS2322/TS6133 exit 2，证明 `tsc -b` 确在检查本目录）；
`npx vitest run` → **47 files / 457 tests 全通过**。`web/src` 运行时逻辑零改动
（`git diff web/src` 仅 `api/types.ts` 一个类型文件）。

## §收尾-3 裁决 3：标记残留分类（含 150 勘误）

### ① 报告 150 勘误（保留原文，追加不改历史）

已在 `coder/report/150_f3f_marker_cleanup.md` **追加 §11 勘误（2026-09-13）**：§2(d) 的
「9 份 preview …**均在** filedb」更正为 **仅 7 份**（全为 `design/06-web/preview/*.html`）；
`design/11-sim-live/preview/{sim-live,sim-live-history}.html` **未登记**。原文一字未删。

### ② 5 处"成对但无主"逐处判定（证据 `10_marker_ownership_classification.txt`）

判定规则：全 `design/` 搜索 `file=<相对路径>`（含更宽松的裸路径搜索与 `git log -S` 历史搜索）+
`.entangled/filedb.json` 成员检查。

| # | 位置 | 声明搜索（命令 → 命中） | filedb | 判定 | 处置 |
|---|---|---|---|---|---|
| 1 | `crates/storage/src/system.rs` L1/L58 | `grep -rn 'file=crates/storage/src/system.rs' design/` → **0**；`grep -rn 'system\.rs' design/` → **0**；`git log -S 'file=…system.rs' -- design/` → **空** | False | **无任何声明** ⇒ 历史遗留、现手维护 | **删标记**（−2 行） |
| 2 | `design/11-sim-live/preview/sim-live.html` L1/L151 | `grep -rn 'file=design/11-sim-live/preview/sim-live.html' design/` → **0**；被引用文档 `01-adr.md` 自身 `grep -c 'file=' = 0` | False | 同上（标记内 `<<…01-adr.md#…>>` 是**悬空引用**） | **删标记**（−2 行） |
| 3 | `design/11-sim-live/preview/sim-live-history.html` L1/L99 | `grep -rn 'file=design/11-sim-live/preview/sim-live-history.html' design/` → **0** | False | 同上 | **删标记**（−2 行） |
| 4 | `scripts/tests/test_stitch.sh`（1 组） | 夹具内**数据**（合成 `design/page.md` 场景） | n/a | **非本仓标记**（被测字符串） | 不动（登记） |
| 5 | `scripts/tests/test_check_tangle.sh`（1 组） | 同上 | n/a | 同上 | 不动（登记） |

**无一处属"存在声明但未在 filedb"** ⇒ 本项**未产生治理缺口登记**；三处均落在"无声明 ⇒ 删标记"分支。
对照确认分类器可辨别（受治理的 `design/06-web/preview/08-settings.html` 有 `file=` 声明，命中）。

### ③ 删除实现与零语义证明（证据 `11_marker_removal_diff.txt`）

- 仅删**标记行**（注释），每份**恰 2 行删除、0 行新增**：`git diff --numstat` = `0 2` ×3。
- 删标记行后的 **filtered sha256（HEAD vs 工作区）逐份相同**（`grep -v '~/~'` 后比对）：
  `system.rs 87ef565a…`、`sim-live.html 35d40f7f…`、`sim-live-history.html 0f8dea37…` ⇒ **零语义改动**。
- 清理后三文件 `grep -c '~/~'` 均为 **0**；`cargo check -p storage --all-targets` → Finished exit 0。
- **残留观察（登记，未动）**：`crates/storage/src/system.rs:2` 仍写「由 08-settings.md tangle 生成（ADR-007），
  禁止手改」——与 R3（`crates/web/src/settings.rs:2`）同源失实描述；本批按"仅删标记行、零语义改动"未触碰。

## §收尾-4 门禁 / 纪律 / 证据

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
$ git diff --cached --name-only | wc -l   → 0   （未 stage；按收尾纪律）
```

**本收尾新增证据**（`coder/evidence/151_debt_cleanup/`）：

| # | 文件 | 内容 |
|---|---|---|
| 09 | `09_perf_min5_20runs.txt` + `09_stats.py` | 加固后 20 次连跑（逐次 PASS + 比值）+ 汇总统计（min/max/mean/median + 余量 9.52×） |
| 10 | `10_marker_ownership_classification.txt` | 5 处"成对但无主"的逐处声明搜索/filedb/历史搜索证据 |
| 11 | `11_marker_removal_diff.txt` | 3 文件删标记的 diff + numstat(0/2×3) + filtered sha256 相同证明 |
| 12 | `12_ts_type_gap_closure.txt` | types.ts 非生成物复核 + 后端/设计事实源原文 + 改动 diff |
| 13 | `13_mutation_min5_gate.txt` | **突变实验（Red）**：修复前路径冒充目标 → 比值 1.021 ≥ 0.6 ⇒ 预期失败（判据非空） |
| 14 | `14_frontend_tsc_vitest.txt` | `tsc -b --force` exit 0 + `vitest run` 457 passed |

**复现命令**：

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
cargo test -p storage --test kline_reader merged_1m_branch_index_limit_performance -- --nocapture  # 单次（含 min5 比值输出）
python3 coder/evidence/151_debt_cleanup/09_stats.py                                               # 比值分布/余量
cd web && npx tsc -b --force && npx vitest run                                                    # 项 3 类型与测试
```

## §收尾-5 残留风险更新（仅列变化项）

| 原 # | 状态 | 说明 |
|---|---|---|
| **R5** | **已关闭** | 双加固落地（min-of-5 两侧 + 阈值 0.6），20/20 PASS、最坏比值 0.063、**余量 9.52×**（要求 ≥1.5×）；突变实验比值 1.021 仍必红。 |
| **R1** | **已关闭（按"无声明 ⇒ 删标记"分支）** | 3 处无主标记已移除（各 −2 行，filtered sha256 相同）；2 处 `scripts/tests/*.sh` 为夹具数据、保留。 |
| **R6** | **已勘误** | 报告 150 追加 §11（7 份而非 9 份）。 |
| **R2** | **已落实** | `ResolvedFee` + `fee?: ResolvedFee` 已补（零运行时影响）。 |
| **R3** | 仍开放（登记） | `crates/web/src/settings.rs:2`；**新增同型**：`crates/storage/src/system.rs:2`（均为"tangle 生成/禁止手改"失实注释，属注释语义修正，未在"仅删标记行"范围内）。 |
| **R4** | 不变 | 参考基线依赖 legacy `kline_merged`；缺表仍以 panic 红（非静默）。 |
| 新增 | 低 | 本批未新增运行时风险：`crates/` 改动仅测试文件 + `system.rs` 删注释；前端仅类型声明。临时夹具 `zz_mutation_min5_gate.rs` 已删除（`git status` 无残留）。 |
