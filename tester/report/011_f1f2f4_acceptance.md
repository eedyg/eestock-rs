# 011 · 增量验收：F1/F2/F4 修复（窄范围，只验证不改实现）

> 本文件位置（self-reference）：`eestock-rs/tester/report/011_f1f2f4_acceptance.md`
> 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
> 基线：HEAD `cc324960cd0ea498cd3a6f5a091bc7c6293e0056`
> 被测：`coder/report/145_f1_f2_f4_mcp_batch_defects.md` 所述改动（工作区**未 stage**）
> 范围：F1/F2/F4 + 回归 + F3 定性复核 + 生产侧状态；**不改实现、不提交 git**
> 原始证据目录：`tester/evidence/011_f1f2f4/`
> 设计报告：`tester/design/011_f1f2f4_acceptance_design.md`
> 新夹具：`crates/web/tests/zz_tester_011_f2_path.rs`

---

## 0. 结论

**可合并（merge with F3 separately tracked）** —— F1/F2/F4 三项修复均独立复现通过；无回归；无放宽后变非法；index 无 staged。

| 验收项 | 结论 | 关键证据 |
|---|---|---|
| 1. F1 语义正确性（含镜像 + 行为矩阵 + 方向性） | ✅ PASS | §1 |
| 2. F2 路径区分（白名单 vs 数据路径） | ✅ PASS | §2 |
| 3. F4 注释一致 | ✅ PASS | §3 |
| 4. 回归（test/check/tangle/staged） | ✅ PASS | §4 |
| 5. F3 定性复核（仅确认） | ✅ 定性一致（与本批无关） | §5 |
| 6. 生产侧状态 | ⚠ 如实报告（二进制陈旧，非本批） | §6 |

---

## 1. F1 语义正确性（重点）

### 1.1 事实源 ↔ 生成物 byte-for-byte 镜像（独立复现）

**方法**：在 `/tmp` 隔离目录仅放入 `entangled.toml` + `design/`（工作区现状），执行 `entangled tangle` 从零重生成全部目标，再把生成的 `crates/mcp/src/tools.rs` 与工作区文件做 `cmp`。

```
$ TMP=$(mktemp -d); cp entangled.toml "$TMP/"; cp -r design "$TMP/"; (cd "$TMP" && entangled tangle)
$ cmp -s "$TMP/crates/mcp/src/tools.rs" crates/mcp/src/tools.rs
IDENTICAL: tools.rs byte-for-byte match          # cmp exit=0
```

→ **worker 的「byte-for-byte 镜像」声明成立**：工作区 `tools.rs` 恰等于由 `design/07-app-plane/01-mcp.md` 单向生成的内容（非手改生成物）。
证据：`tester/evidence/011_f1f2f4/f1_mirror_regen.txt`。

事实源内含 F1 修正与新用例：
```
design/07-app-plane/01-mcp.md:994  // F1（010 验收）：**本归一必须先于下面的是否空区间判定**…
design/07-app-plane/01-mcp.md:2161 async fn get_kline_same_day_date_bounds_legal()
design/07-app-plane/01-mcp.md:2188 注：同日 date 形式（from=to=YYYY-MM-DD）合法…
```

### 1.2 行为验证矩阵 ①–⑥（`cargo test -p mcp --lib get_kline` → 14 passed / 0 failed）

| # | 输入 | 期望 | 覆盖用例 | 结果 |
|---|---|---|---|---|
| ① | `from=to=2026-09-03`（同日 date） | 合法=该 CST 日整日（from 回声 `09-02T16:00Z`、to 回声 `09-03T16:00Z`、2 根样例 bar） | `get_kline_same_day_date_bounds_legal` | ok |
| ② | `from==to` RFC3339 `09-02T00:00:00Z` | 非法 -32602（空区间，不静默空 bars） | `get_kline_from_to_validation_is_32602` | ok |
| ③ | reversed date `09-03 → 09-02` | 非法 -32602 | 同上 | ok |
| ④ | RFC3339 from 晚于 date-to 展开日界（`09-03T01:31Z` + `to=2026-09-02`） | 非法 -32602 | 同上 | ok |
| ⑤ | 混合 `from=09-03T01:31Z` + `to=2026-09-03` | 合法（取数 before = 展开后的 to `09-03T16:00Z`；仅 1 根） | `get_kline_same_day_date_bounds_legal` | ok |
| ⑥ | 既有合法回归：from 闭/to 开、超 limit、区间超限、无界 | 语义不变 | `get_kline_from_to_date_bounds_and_range_filter` / `get_kline_limit_cap_and_segment_hint` / `get_kline_range_over_limit_is_tool_error` / `get_kline_without_bounds_keeps_legacy_shape` | ok |

### 1.3 被替换断言：原断言确曾固化 F1（独立核对）

worker 的「原断言固化 bug」声明经**恢复到的 pre-fix 快照**（worker 隔离目录 `/tmp/145_before/crates__mcp__src__tools.rs`）独立核实：

```diff
-            json!({ "code": "518880", "from": "2026-09-02", "to": "2026-09-02" }),   // ← 旧断言把「同日 date」列为非法
             json!({ "code": "518880", "from": "2026-09-03", "to": "2026-09-02" }),
+            json!({ "code": "518880", "from": "2026-09-02T00:00:00Z", "to": "2026-09-02T00:00:00Z" }),
+            json!({ "code": "518880", "from": "2026-09-03T01:31:00Z", "to": "2026-09-02" }),
```
同快照同时显示 pre-fix 顺序为「先比较、后展开」（`- if f >= t {...}` 位于 `let to = match …` 之前）。
证据：`tester/evidence/011_f1f2f4/f1_prefix_snapshot_diff.txt`。

**新断言组逐条由「from 闭 / to 开」推导**（归一后判据 = `t > f`）：
- 同日 date：`D 00:00CST < D+1 00:00CST` → 非空 → 合法；
- 混合：`f < D+1 00:00CST` → 合法；
- 反向 date：`f == t` → 空 → 非法；
- RFC3339 `f==t` → 空 → 非法；
- RFC3339 from ≥ 展开后日界 → 空 → 非法。
无一条为「迁就实现」。

### 1.4 方向性检查（t 只能严格递增 ⇒ 只放宽、不变非法）

**实质**：比较点由 date-展开**前**移至**后**；对 date 形式 `to`，归一使 `t` 严格 `+1 天`（非 date 形式 `t` 不变）。故新判据 `f >= t+Δ` 的拒绝集 ⊆ 旧判据 `f >= t` 的拒绝集 → **只可能放宽**。

**独立暴力验证**（Python 复刻两种顺序，网格 = 4 个 date + 20 个 RFC3339 瞬时 + 无界，576 对）：
```
TIGHTENED (合法→非法): 0            # 不存在放宽后变非法的输入
LOOSENED  (非法→合法): 22           # 全部为 date 形式 to 且 from 落在该 CST 日内 = 预期 F1 修复面
loosened 中 to 非 date 形式: 0
非 date to 的裁决不一致: 0
```
证据：`tester/evidence/011_f1f2f4/f1_direction_sim.txt`。

→ **无任何此前合法输入变为非法**；仅 F1 涉及的两类形式由非法变合法；超限（`f>=t`）、区间超限 isError、`to` 开边界（`b.ts < t`）均未动。

---

## 2. F2 路径区分（动态构造证据）

`crates/web/tests/zz_tester_011_f2_path.rs::f2_period_paths_are_distinguishable`（新夹具，需 TimescaleDB :5433）成对提交，实测：

```
F2 EVIDENCE path_A(W1) status=400 error="period 须为 M1/M5/M15/H1/D1"
F2 EVIDENCE path_B(H1) status=400 error="区间内无 K 线数据（893581 H1 2026-09-09 01:29:00 UTC~2026-09-09 01:40:00 UTC）"
test result: ok. 1 passed; 0 failed
```

- 路径 A（`W1`，白名单外，`crates/web/src/workbench.rs:145-146` 预校验）→ 文案 **含 `period`**，且含白名单 `M1…D1`；
- 路径 B（`H1`，已合法 → 服务层数据路径无 H1 数据）→ 文案 **不含 `period`**（含的是周期值 `H1` 而非字面 `period`）。

→ `api_workbench.rs::submit_validation_error_matrix` 中 `msg.contains("period")` 断言**唯一命中白名单分支**，不再是「数据路径碰巧 400」。证据：`tester/evidence/011_f1f2f4/f2_path_distinction.txt`。
（静态旁证：`crates/web/src/workbench.rs` 内唯一含字面 `period` 的 400 文案即 line 146；application 层文案均为 `symbol/from/to/区间/bar/policy/stop`，不含 `period`。）

---

## 3. F4 注释一致

`crates/application/src/strategy.rs:40-41` 注释现为「M1/M5/M15/H1/D1；I-6/D3 起 H1 已支持，W1/MO1 为看板读源扩展、不入回测」。
对照 `crates/application/src/bar_map.rs::parse_period`（`M1/M5/M15/H1/D1`，其余 `Err`）与模块头「W1/MO1 为看板读源扩展，不入回测」→ **一致**。无行为变更。

---

## 4. 回归

| 命令 | 结果 | 摘要 |
|---|---|---|
| `cargo test -p mcp -p web -p application` | **EXIT=0** | 22 个测试二进制 + 3 doc-test 目标，**272 passed / 0 failed / 0 ignored** |
| `cargo check --workspace --all-targets`（touch 全量 `.rs` 强制重编，重放告警） | **EXIT=0** | 15 crates 全部 `Checking`，**0 error / 0 warning** |
| `entangled tangle`（工作区） | **EXIT=0** | `Nothing to be done`；复跑 `git diff` sha256 不变 → **幂等** |
| `git diff --cached --name-only` | 空 | **index 无 staged**（0 文件） |

新夹具单跑亦通过（§2），`cargo test -p mcp --lib get_kline` = 14 passed。
证据：`cargo_test_mcp_web_application.txt`、`cargo_check_workspace_forced.txt`、`entangled_tangle_worktree*.txt`。

---

## 5. F3 定性复核（仅确认，未修）

在 `git archive HEAD` 纯净快照（`git init`+commit，无 `.entangled` 缓存）独立复现：

```
[2] entangled tangle    → WARNING `web/src/layouts/DashboardGrid.tsx` not managed by Entangled
                          WARNING `web/src/layouts/SimLiveGrid.tsx` not managed by Entangled
                          ERROR   conflicts found, breaking off (use `--force` to run anyway)
    ENTANGLED_EXIT=0
[3] git status after tangle → (空)   ← 未写任何文件
[4] ./scripts/check-tangle.sh → [check-tangle] ✅ tangle 后无 diff … ; SCRIPT_EXIT=0   ← 假绿
[5] entangled tangle --force → WARNING conflicts found, but continuing anyway ; FORCE_EXIT=0
[6] git status after --force → M web/src/layouts/DashboardGrid.tsx ; M web/src/layouts/SimLiveGrid.tsx
```

→ **worker 定性成立**：干净 HEAD 下门禁是**假绿**（entangled break-off 退出码 0 + 不写文件 → 脚本比较无 diff → 打印 ✅），而非红；`--force` 会把两份 TSX 改回**陈旧文档内容**（22 行净减）。证据：`f3_pristine_reproduction.txt`。

**当前工作区 check-tangle 红的归因**：`entangled tangle` 侧为 `Nothing to be done`（无生成漂移）；红来自脚本 `git diff --quiet` 比较 **worktree vs index**，而工作区有未提交改动。`git diff --stat` 列出 23 个文件（含 144/010 批次 19 个 + 本批 4 个），**与 tangle 语义无关，纯属「未 stage」产物**。
→ 注：任务书「仅因**本批**未 stage 的改动」表述略窄——实际红也含 144/010 批次未 stage 改动；但两者同为「未 stage」，定性（非漂移）一致。
证据：`check_tangle_worktree.txt`、`entangled_tangle_worktree.txt`、`git diff --stat`。

---

## 6. 生产侧状态

| 观察 | 值 |
|---|---|
| PID（:8081 与 :8082 同进程） | **3696673，未变**，启动 `Fri Sep 11 11:24:16 2026`（`target/debug/eestock-app --config /tmp/app_dev_8081.toml`） |
| `/proc/3696673/exe` | `…/target/debug/eestock-app (deleted)` → 运行进程用的是**更旧的、已被删除**的二进制 |
| :8081 healthz | **HTTP 200** `{"status":"ok"}` |
| :8082 | MCP 端点：`/healthz` 404（符合预期）、`/sse` 200 |
| :8082 行为 | **改前行为**：`get_kline` 完全无视 `from/to`，返回最近 10 根（payload 仅 `[bars,code,period]`，无 from/to 回声）；`HEAD:crates/mcp/src/tools.rs` 亦无 from/to 代码 → 运行/在盘二进制均为 **pre-144**，与本批无关 |
| `target/debug/eestock-app` mtime | **2026-09-12 18:41:58**；本批源码编辑时间 **18:45:29–18:45:48**（`.entangled/filedb.json` 记录 design/07=18:45:29、tools.rs=18:45:31）→ 二进制**早于**本批改动 |
| 在盘二进制内容 | `strings` 中 **无** `from 须早于 to` / `to 含整日` / `区间内根数` → **不含** from/to 特性（更遑论本批 F1 修复） |

**判断**：`target/debug/eestock-app`（18:41:58）**不是**含本批改动的新二进制——它早于本批编辑 4 分钟，且不含本批/144 批次特性；运行进程（PID 3696673）用的是**更旧的 deleted 二进制**。生产两端口未重启、未受影响，与上轮 tester `cargo clean` 副作用一致（在盘二进制为后来重建的中间产物）。
证据：`prod8082_get_kline_pre005.txt`、`prod8082_same_day_detail.txt`、进程/healthz 记录（见 §6 命令）。

---

## 7. 残余风险

1. **F3 另行立项**：门禁在干净 HEAD 为「假绿」；`--force` 会回退 2 份 TSX。修复时需同时校正 `entangled` break-off 退出码语义或维护「手写例外 + 门禁校验退出码」。本批未碰，符合范围。
2. **F1 为放宽**：若外部调用方依赖旧的「同日 date 报 -32602」误判行为，会看到行为变化；但该行为与事实源契约不符（契约「from 闭 / to 开 / to 含整日」已蕴含同日 date 合法），且放宽不产生静默截断/静默空结果。
3. **生产未部署**：:8081/:8082 仍为陈旧二进制；本批改动**未经任何真机运行**（仅单测/集成测 + DB e2e）。若需上线，需重启并复跑生产烟测。
4. **在盘二进制陈旧且与运行进程不一致**（deleted exe）：任何后续「部署/验证」需先重建再重启，勿误用当前 `target/debug/eestock-app`。
5. 未跑前端 e2e；未改任何实现、未 `git add`/`commit`。

---

## 8. 变更清单（本次验收新增文件，未 stage）

| 文件 | 类型 | 说明 |
|---|---|---|
| `tester/report/011_f1f2f4_acceptance.md` | 报告 | 本文件 |
| `tester/design/011_f1f2f4_acceptance_design.md` | 设计 | 验收测试设计 |
| `crates/web/tests/zz_tester_011_f2_path.rs` | 新夹具 | F2 路径区分动态证据（tester 夹具命名空间，非生成物） |
| `tester/evidence/011_f1f2f4/*` | 原始证据 | 见目录 |

> 未修改任何实现/接口/生成物；import 无 `git add`（`git diff --cached` 空）。
