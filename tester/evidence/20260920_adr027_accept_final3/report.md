# ADR-027 解冻修复 · 最终独立复验（B1 / B2 / D1 + 回归 + 树静止）

**本报告位置**：`tester/evidence/20260920_adr027_accept_final3/report.md`
**原始输出目录**：`tester/evidence/20260920_adr027_accept_final3/raw/`
**复核对象**：上一冻结判词 `tester/evidence/20260920_adr027_accept_final/report.md`（B1/B2/D1 阻断项）与修复方 `coder/evidence/20260920_adr027_p9c_final/report.md`。
**角色**：tester。**未改任何生产代码**（`crates/*/src`、`web/src` 入口/出口逐字节一致，见 §6）；未分析失败、未尝试修复；本波为**唯一活跃车道**，**未 spawn 任何子代理**。

---

## 判词（前置，一行）

**B1 通过 ｜ B2 通过 ｜ D1 部署与冒烟 通过 ｜ 回归 绿 ｜ 树静止 是 ｜ 资源违规 无 ｜ 总判词 = 放行**

剩余阻断项：**无**。

---

## 0. 环境与资源纪律

| 时点 | 步骤 | total/used/free/available | swap used |
|---|---|---|---|
| 01:16:03 | 进入 | 46Gi / 17Gi / 23Gi / 28Gi | 5.3Gi |
| 01:16 | B1（单 target，DB 门禁） | 46Gi / 17Gi / 23Gi / 28Gi | 5.3Gi |
| 01:16 | B2 vite build + playwright | 46Gi / 17Gi / 23Gi / 28Gi | 5.3Gi |
| 01:20 | 回归（strategy-core/application/web 串行） | 46Gi / 18Gi / 22Gi / 28Gi | 5.3Gi |
| 01:21:28 | 退出 | 46Gi / 18Gi / 22Gi / 28Gi | 5.3Gi |

快照：`raw/01_mem_before_b1.txt`、`raw/20_mem_before_b2.txt`、`raw/30_mem_before_regression.txt`、`raw/70_exit_mem.txt`。

**纪律执行（对照任务书硬约束）**：
1. 唯一活跃车道，**未 spawn 任何子代理/并行任务**。
2. **未运行 vitest（全量或单文件均未跑）**——本波判据不含 vitest；raw 目录无 vitest 证据（已核）。
3. playwright **只跑 `web/e2e/adr028-window-sync.e2e.ts` 一个规格**，`--workers=1`（配置本身 `workers: 1`）。
4. cargo **串行**：`-p strategy-core` → `-p application` → `-p web` 依次单独执行，任一时刻仅一个 cargo 进程；每步前记录 `free -h` 快照。
5. 未出现单步超过 5 分钟无进展的挂起；每步均有产出。

**退出进程卫生（`raw/26_b2_exit_hygiene.txt`、`raw/71_exit_hygiene.txt`）**：`4173 not listening`；**无** `vite preview` / headless chromium / playwright 残留进程（跑完即 `pkill`，`ss`/`ps` 双查为空）；`eestock-app` 恰 **1** 个（pid 1941108），8081/8082 正常监听。**无残留需杀**（唯一被 `pkill` 的 vite preview 已随杀随清；未发现遗留 chromium）。

---

## 1. B1 —— `crates/web/tests/tester_p6_fills_indep.rs`（陈旧断言修复复验）**通过**

**裁决口径逐条核对（源码静态审读）**：
- 元素键集断言 = **v2 的 12 键精确集合**，且**非包含式**：`L325 assert_eq!(keys, FILL_KEYS_V2, ...)`（`Vec<&str>` 逐项相等 = 集合与顺序双验），`FILL_KEYS_V2: [&str; 12]` 显式声明完整清单（`crates/web/tests/tester_p6_fills_indep.rs:260-273`，sha256 `3ba4ab82…7334e79`）。
- `shares` 断言按 ADR-027 v2 契约（`design/17-trade-detail-layering/02-spec.md` §1.2/§2-I1）改为 **`trade.shares == Σ买入 qty`**（`L374-376`），并附 Closed 等值断言 `Σ买入 == shares == Σ卖出`（`L378-379`）；**费用 I1 对账**在位：`trade.commission == Σfills.commission`、`trade.stamp_duty == Σfills.stamp_duty`（`L382-385`）；`l2_count == 本回合成交笔数`（`L380`）。既有断言未删除。

**真跑（隔离测试库 `EESTOCK_TEST_DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/eestock_test`）**：
- 基线全绿：`cargo test -p web --test tester_p6_fills_indep` → **4 passed / 0 failed**，EXIT=0（`raw/10_b1_baseline_green.txt`）。

**本波自做变异反证（我自己改，非引用他人）**：
- **变异①去掉一个键**：`FILL_KEYS_V2` 删 `"code"`（12→11）⇒ **必红**，EXIT=101（`raw/11_b1_mutation_missing_key.txt`）。
  `left: [12 键] / right: [11 键（缺 code）]`，`FAILED`。
- **变异②加一个键**：追加 `"zzz_extra"`（12→13）⇒ **必红**，EXIT=101（`raw/12_b1_mutation_extra_key.txt`）。
  `right: [..., "type", "zzz_extra"]`，`FAILED`。
- **恢复原状**：`cp /tmp/p6_tester_orig.rs` 覆盖，sha256 逐字节一致（`3ba4ab82…`），再跑 **4 passed / 0 failed**，EXIT=0（`raw/13_b1_restore_green.txt`）。

> 结论：键集断言既有精确集合又有牙（去键/加键皆红）；`shares`/I1 按 v2 契约在位。

---

## 2. B2 —— `web/e2e/adr028-window-sync.e2e.ts`（恒真豁免消除 + 断言补强）**通过**

**真跑方式（真身 = `vite build` 产物 + 真 `:8081` 后端/库）**：
```bash
cd web && npx vite build                                  # EXIT=0（raw/21_b2_fe_build.txt）
VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --port 4173 --strictPort &
E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/adr028-window-sync.e2e.ts --workers=1
```

**结果（`raw/22_b2_playwright.txt`，PW_EXIT=0）**：
```
✓ E1_L1_jump           ✓ E2_L2_jump_clamped      ✓ E3_L2_jump_centered
✓ E4_reset_back        ✓ M1_mutation_silent_noop ✓ M2_mutation_barspace_only_no_scroll
6 passed (26.0s)
```

**逐条核对判据（源码 + 真身读数）**：
1. **`edge_clamped` 恒真豁免已消失，clamp 场景断言精确期望值**：`l2ClampedMismatches()`（`L379-410`）按数据侧边界断言 —— ①居中确被末端阻断 ②`toIdx === dataEndIdx`（右缘**恰**钉末端）③`observedCenterIdx === dataEndIdx − floor((vis−1)/2)`。真身读数 `raw/e2b_l2_clamped_target.json`：`edgeClamped=true`、`toIdx=314=dataEndIdx`、`observedCenterIdx=254`，`vis=122`，**期望 314−⌊121/2⌋=254**，`mismatch=[]`。**无豁免分支**（旧版 `edgeClamped || …` 已删）。
2. **存在真实居中用例（`edge_clamped=false`）**：E3 真跑，读数 `raw/e3_l2_centered.json`：`edgeClamped=false`、`centerIdx=observedCenterIdx=74`、`observedCenterTs==fill.ts=1777219200`、`fromIdx=13≥1`，`mismatch=[]`（`raw/e3_l2_centered_mismatch.json`）。
3. **L1 有上界与居中断言**：`l1Mismatches()`（`L249-296`）第 4 条上界 `vis ≤ ceil(want×1.5)+tol`（防「取全量/过宽」）、第 5 条居中 `|observedCenterIdx−centerIdx| ≤ 1`。
4. **L2 有落在可见区间与跨度断言**：`l2CommonMismatches()`（`L307-339`）断言 `fromIdx ≤ centerIdx ≤ toIdx`（目标落窗）、`|可见根数−120| ≤ 5`（跨度双侧）、`state.spanBars == 真身可见根数`。
5. **规格内变异反证 M1/M2 实跑（`raw/22_b2_playwright.txt`）**：
   - M1：`raw/m1_mutation_mutated_mismatch.json={[]}`（窗口随变异区间）；`raw/m1_mutation_original_mismatch.json` = **2 条不匹配**（非恒真）。
   - M2（**「只改 barSpace 不滚动」**）：`raw/m2_mutation_no_scroll.json`：`baseCenteredMismatch=[]`；`mutatedMismatch` **3 条且红点落在居中**（`edgeClamped=true` / `centerIdx=57 observedCenterIdx=74` / 中心 ts 不符）；`scrollCalls=5`；变异前后窗口端点相同（`fromIdx/toIdx=13/135`）、`mutBarSpace=5`。

**本波自做变异反证（我自己改，非引用他人）**：
- **变异 A（证明 `edge_clamped=false` 不是豁免、确实被断言）**：把 `l2CenteredMismatches` 的 `p.edgeClamped === false` 反转为 `=== true` ⇒ **E3 必红**（`raw/23_b2_mutationA_edgeclamped_inverted.txt`：`E3_L2_jump_centered ✘`，`Error: L2 真居中断言（无豁免；变异时必须变红）`；M2 因基线要求 `edgeClamped=false` 亦红）。E1/E2/E4/M1 仍绿 ⇒ 证明该断言真被求值、E3 的 `edge_clamped=false` 路径被真跑到。
- **变异 B（证明 L1 上界有牙）**：把 `L1_SPAN_UPPER_REL` 由 `1.5` 改 `0.1` ⇒ **E1 必红**（`raw/24_b2_mutationB_l1_upperbound.txt`：`E1_L1_jump ✘`，`Error: L1 跳转真身断言（变异时必须变红）`；E4/M1 亦红）。E2/E3/M2 仍绿 ⇒ 上界断言确实生效。
- **恢复原状**：`cp /tmp/e2e_spec_orig.ts` 覆盖，sha256 逐字节一致（`23267f5c…e1211a`），再跑 **6 passed / 0 failed**，PW_EXIT=0（`raw/25_b2_restore_green.txt`）。

> 结论：两类静默失败（窗口过宽 / 只改 barSpace 不滚动）均**必红**；clamp 精确期望、真居中路径、L1 上界+居中、L2 落窗+跨度全部在位。

---

## 3. D1 —— 8081 重新部署 + 冒烟 **通过**

**部署顺序（`raw/40_d1_deploy_check.txt`）**：
- 磁盘二进制 `target/debug/eestock-app`：sha256 `530d2eca…250c41`，mtime **2026-09-19 23:50:07 +0800**（epoch 1789833007）。
- 运行进程 pid **1941108**：启动 **Sun Sep 20 01:09:27 2026**（`/proc/1941108` epoch **1789837768**）。
- **1789837768 > 1789833007 ⇒ 进程启动时间晚于新二进制 mtime**；且 `/proc/1941108/exe` sha256 == 磁盘 sha（`530d2eca…`）⇒ 线上运行的就是本波磁盘产物。

**冒烟（`:8081`，只读 GET，`raw/41_d1_smoke.txt`）**：

| # | 冒烟项 | 结果 |
|---|---|---|
| S1 | `/fills` 元素键集 | **12 键**且含 `code`（`code="159776"`）；`total=16`、`recorded=true`；键序 = `bar_index,code,commission,price,qty,reason,rt_seq,side,stamp_duty,trade_value,ts,type` |
| S2 | `/fills?round_trip=9999`（未知回合） | **404** `{"error":"回合 9999 不属于运行 …"}` |
| S3 | `/round-trips/9999/fills`（未知回合） | **404** |
| S4a | `/fills?round_trip=abc`（非法参数） | **400 + 结构化信封**（`code/message/detail` 三键，`code=request_invalid`，`detail.param` 指错） |
| S4b | `/fills?offset=abc` | **400 + 信封** |
| S4c | `/fills?limit=xyz` | **400 + 信封** |
| S4d | `/round-trips/abc/fills`（路径非法） | **400 + 信封**（`detail.param=rt_seq`） |
| S5 | `/round-trips` | **200**（`total=1`，`rt_seq=1`，19 键） |
| S6 | `/round-trips/1/fills` | **200**（`n_fills=16`，`total=16`，12 键同形状） |
| S7 | `/curve?kind=position` | **200**（`kind=position`，`n_points=65`） |

> 结论：8081 进程晚于新二进制、运行产物 == 磁盘产物；六类冒烟全按契约（12 键含 code / 未知回合 404 / 非法参数 400 信封 / 两条 round-trips 径 / curve position）。

---

## 4. 回归面 **绿**

| 项 | 命令（均设 `EESTOCK_TEST_DATABASE_URL` = 隔离测试库） | 结果 | 证据 |
|---|---|---|---|
| strategy-core | `cargo test -p strategy-core --no-fail-fast` | **绿** EXIT=0（36/4/26+1ign/6/9/7/1/3/0） | `raw/31_reg_strategy_core.txt` |
| application | `cargo test -p application --no-fail-fast` | **绿** EXIT=0（12 目标，47/2/2/2/6/3/3/57/41/3/54/0） | `raw/32_reg_application.txt` |
| web | `cargo test -p web --no-fail-fast` | **绿** EXIT=0，**31 target / 177 passed / 0 failed / 0 ignored**，`FAILED` 计数 0 | `raw/33_reg_web.txt` |
| ↳ 关键 target | `tester_p6_fills_indep`(4) / `tester_p5_indep`(13) / `orphan_detect_endpoint_red`(4) / `adr027_fills_param_shape`(2) 均 `ok` | — | 同上（L139/299/367/396 等） |
| tsc | `cd web && ./node_modules/.bin/tsc -b` | **绿** EXIT=0，无输出 | `raw/34_tsc.txt` |

对照上一冻结判词：唯一红（`tester_p6_fills_indep` 陈旧 7 键断言）已转绿；`orphan_detect_endpoint_red::r1` 亦绿（测试库孤儿 = 0）。**未跑全量 vitest**（判据未要求，且资源纪律限定最多一次）——以 `tsc -b` 全绿替代。

---

## 5. 只读复核：孤儿计数 + 活库未触碰 **通过**

`raw/50_orphan_readonly.txt`（两库均以 `default_transaction_read_only=on` 只读查询，ORPHAN_ROWS_SQL 同源 10 表）：
- **隔离测试库 `eestock_test`：10 表孤儿总计 = 0**（逐表全 0）。
- **活库 `eestock`：10 表孤儿总计 = 0**（逐表全 0）。
- **本波对活库零写**：本轮全部 DB 操作为只读 SELECT；未执行任何 `DELETE/UPDATE/TRUNCATE/REFRESH`（上一波对 `eestock_test` 的一次性清理授权与活库无关，本轮未复现）。

---

## 6. 树静止与生产源码哈希（进入/退出一致）**是**

`raw/62_src_hash_consistent.txt`：
- 生产源码 `crates/*/src/**/*.rs`：before = after = `c4281b18d83bff48087d7d806893845441236b7a0bd605a715170d7704cf5a8d` → **同一**。
- 前端源码 `web/src/**/*.{ts,tsx}`：before = after = `c2d26a008fc9c9bb24e118598ab386e51d3d23ceae6d475ba6bc33b117c4d97c` → **同一**。
- 变异用到的两个测试文件均已逐字节恢复：`crates/web/tests/tester_p6_fills_indep.rs` = `3ba4ab82…7334e79`、`web/e2e/adr028-window-sync.e2e.ts` = `23267f5c…e1211a`（与变异前 sha 相同）。
- 工作树相对索引：`git diff --stat` 对这三个测试文件为空（工作树 == 暂存区）；tracked 修改计数 before = after = **193**（`raw/60_tree_static_after.txt`）。

> `web/dist`（构建产物，已 gitignore）随复跑重建，非生产源码；产品二进制与 `web/dist` 同源码构建。

---

## 7. 证据索引（`raw/`）

| 文件 | 内容 |
|---|---|
| `00_prod_src_hash_before.txt` / `00_web_src_hash_before.txt` | 进入时生产源码哈希 |
| `01/20/30/70_mem_*.txt` | 进入 / B1 / B2 / 回归 / 退出的内存快照 |
| `10_b1_baseline_green.txt` | B1 基线 4 passed |
| `11_b1_mutation_missing_key.txt` / `12_b1_mutation_extra_key.txt` | 本波 B1 两次变异必红（去键/加键） |
| `13_b1_restore_green.txt` | B1 恢复原状 + 全绿 |
| `21_b2_fe_build.txt` / `22_b2_playwright.txt` | B2 构建 + 6 passed |
| `23_b2_mutationA_edgeclamped_inverted.txt` | 本波变异 A：反转 `edge_clamped` ⇒ E3 红（证无豁免） |
| `24_b2_mutationB_l1_upperbound.txt` | 本波变异 B：`L1_SPAN_UPPER_REL=0.1` ⇒ E1 红（证上界有牙） |
| `25_b2_restore_green.txt` | B2 恢复原状 + 6 passed |
| `26_b2_exit_hygiene.txt` / `71_exit_hygiene.txt` | B2 后 / 退出时进程卫生（无 vite/chromium 残留） |
| `e1_*/e2a_*/e2b_*/e3_*/e4_*/m1_*/m2_*.json` | B2 真身读数与规格内两次变异反证 |
| `31_reg_strategy_core.txt` / `32_reg_application.txt` / `33_reg_web.txt` / `34_tsc.txt` | 回归四件套原始输出 |
| `40_d1_deploy_check.txt` / `41_d1_smoke.txt` | D1 部署顺序 + 冒烟（S1–S7） |
| `50_orphan_readonly.txt` | 两库只读孤儿审计（均 0） |
| `60_tree_static_after.txt` / `62_src_hash_consistent.txt` | 树静止 + 前后源码哈希一致 |

---

## 8. 残留风险 / 未做项（不隐瞒）

1. **未跑全量 vitest**（判据未要求 + 资源纪律限定）。以 `tsc -b` 全绿替代；如需前端单测护栏，可另行授权单文件运行。
2. **E2E 依赖活库特定 run/下标**（`sr_1789832477006_000002` 的 L2 行 7/15、`sr_1789832517708_000005` rt3 行 1）。库清理或缺数据时会**显式失败**（非静默），但非本波范围。
3. **孤儿债同类隐患**：本波只验证被点名的 `tester_p5_http_structured_error_shape` 已根治（连跑不累积）；其它向 `kline_accurate` 写原始行的测试若既不删原始行也不 refresh 窗口，理论上仍可能在别的 cagg 窗口累积（本波全库审计当前仅此一处，且已=0）。
4. 本波为**测试层复验**，未覆盖其它历史 E2E 套件与 MCP 端到端（不在任务范围）。
5. `find` 不支持 `--exclude-dir`（该 flag 属 grep）；生产源码哈希以「同一命令 before/after 比对」实现（`-not -path '*/target/*'` 排除 target，`crates/*/src`/`web/src` 天然不含 node_modules/.git）。此为本轮对任务书 `find --exclude-dir` 措辞的一处**方法学偏差**，不影响结论（文件集 118 个，before/after 命令完全一致）。

---

## 9. 边界声明（角色纪律）

- 本波**未改任何生产代码**（`crates/*/src`、`web/src` 前后哈希一致，§6）；**未分析任何失败、未尝试修复**。
- 变异反证仅临时改动**测试资产**（`tester_p6_fills_indep.rs`、`adr028-window-sync.e2e.ts`），跑后**逐字节恢复**（sha 一致，§6）。
- 未 `stitch`/未 `entangled tangle` 写盘；未执行任何 `DELETE/UPDATE/TRUNCATE/REFRESH`（§5）。
- 新增文件全部在 `tester/evidence/20260920_adr027_accept_final3/`（外加 `web/dist` 构建产物与 `/tmp` 临时脚本）。
