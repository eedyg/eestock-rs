# ADR-027 P9c 最终收尾 · 解冻（B1 陈旧断言 / B2 E2E 恒真豁免 / D1 重新部署 + 冒烟）

**判词（前置）**：**B1 通过 ｜ B2 通过 ｜ D1 部署与冒烟 通过 ｜ check-tangle 绿 ｜ 资源违规 无 ｜ 未做项：全量 vitest 未跑（本波判据未要求，且资源纪律限定全量最多一次；改跑 tsc 全绿）**

**报告自身位置**：`coder/evidence/20260920_adr027_p9c_final/report.md`
**原始输出目录**：`coder/evidence/20260920_adr027_p9c_final/raw/`
**冻结依据**：`tester/evidence/20260920_adr027_accept_final/report.md`（B1 / B2 / 部署项）
**增量落盘**：本节按 B1 / B2 / D1 完成顺序就地写入（见 §2 / §3 / §4）。

---

## 0. 上一车道交接与边界说明

- 上一车道 `coder/evidence/20260920_adr027_p9b_fix_freeze/raw/` 已把 B1/B2/D1 的**实现**落盘（B1 用例改 v2 12 键、E2E 硬化 6 用例、8081 于 00:27:56 重启），但**该目录没有 report.md** ⇒ 疑似该车道在写报告前中断（与任务书提示的「上一条车道 vitest 吃满内存」一致）。
- 本波（p9c）**独立复跑**并重新落盘到 `20260920_adr027_p9c_final/`，不复用 p9b 结论作为判据；p9b 的 raw 仅作对照。**所有本波判据数字均来自本波新跑**。
- **产品逻辑零改动**：B1/B2 只改测试与前端规格，D1 只做构建/重启/冒烟；未跑 `entangled tangle`/`stitch` 写盘。
- 本波是唯一活跃车道；**未 spawn 任何子代理**。

---

## 1. 资源纪律与进程卫生（每步快照）

| 时点 | 步骤 | total/used/free/available | swap used |
|---|---|---|---|
| 01:05:34 | 进入 | 46Gi / 18Gi / 25Gi / 28Gi | 5.5Gi |
| 01:08:40 | B2 vite preview + playwright（1 worker） | 46Gi / 18Gi / 23Gi / 28Gi | 5.3Gi |
| 01:09:36 | D1 重启后冒烟 | — | — |
| 01:09:51 | 全量 `cargo test -p web` 开始 | 46Gi / 17Gi / 24Gi / 28Gi | 5.3Gi |
| 01:14:32 | 全量跑完 + tsc | 46Gi / 17Gi / 23Gi / 28Gi | 5.3Gi |
| 01:14:46 | 退出 | 46Gi / 17Gi / 23Gi / 28Gi | 5.3Gi |

原始快照：`raw/00_mem_snapshot_entry.txt`、`raw/99_exit_snapshot.txt`。

**纪律执行**：
- playwright **只跑本任务指定的那一个规格文件**，`--workers=1`（配置本身 `workers: 1`）。
- **未跑全量 vitest**（判据不要求）。改跑 `tsc -b` 全绿（`raw/71_post_fullrun_orphans_tsc.txt`）。故无 vitest 内存风险。
- cargo 命令**全程串行**：任一时刻最多一个 cargo 进程（启动全量前显式确认无其它 cargo/vitest）。
- **残留进程清理记录**：
  - 首次 playwright 调用因我方 shell 变量拼写错误（`ADR028_E2E_OUT=$OUT_REAL` 未定义 → 空串）导致 6 用例在 `mkdirSync('')` 处快速失败；随后 `pkill -f 'vite preview'` 已确认 **:4173 不再监听**。
  - 正确重跑（`raw/31_b2_playwright.txt`）后再次 kill：`:4173` not listening；`ps` 无 `vite preview`、无 headless chromium（仅系统 Steam 自带 chrome 进程，非本波产生）。退出快照 `raw/99_exit_snapshot.txt` 复核 **4173 not listening、无 vite/chromium 残留**。
  - 退出时 `eestock-app` 恰 **1 个**（pid 1941108），8081/8082 正常监听。

---

## 2. B1 通过 —— `crates/web/tests/tester_p6_fills_indep.rs` 陈旧断言按 v2 契约跟随

**裁决口径**：元素键集改 **v2 的 12 键精确集合（含顺序声明，禁包含式）**；下游 `shares` 断言的旧前提（`shares < buy_qty`）按 `design/17-trade-detail-layering/02-spec.md` §1.2/§2-I1 改为 **`shares == Σ买入 qty`** 并补 I1 对账。**未删除任何既有断言**。

**改动（该文件本波工作树相对 HEAD：+60 / −13）**：
- 新增常量 `FILL_KEYS_V2: [&str; 12]`（字典序，声明为完整清单）；断言 `keys == FILL_KEYS_V2`（`Vec<&str>` 逐项相等，既验精确集合也验顺序）；`keys` 由 `serde_json`（未开 `preserve_order` ⇒ `BTreeMap` 字典序）给出。
- 保留并新增 v2 字段语义断言：`code == run.symbol`、`rt_seq/trade_value/commission/stamp_duty` 非 null、`rt_seq ≥ 1`、`trade_value > 0`、`commission/stamp_duty ≥ 0`。
- 下游按 v2：`trade.shares == Σ买入 qty`（ΣSell 同值，Closed）、`l2_count == 本回合成交笔数`、**I1**：`trade.commission == Σfills.commission`、`stamp_duty` 同；并保留 `trades 行数 1 ≠ fills 笔数 3` 与「部分卖出不得单独成行」的区分。

**真跑（设 `EESTOCK_TEST_DATABASE_URL` = 隔离测试库）**：
- 基线全绿：`raw/20_b1_green_baseline.txt` → `tester_p6_fills_indep` **4 passed / 0 failed**，EXIT=0。
- **变异反证（去掉一个键）**：`FILL_KEYS_V2` 删 `"code"`、长度 12→11 ⇒ **必红**。原始输出 `raw/21_b1_mutation_missing_key.txt`：
  `left: [12 键] / right: [11 键（缺 code）]`，`FAILED`，EXIT=101。
- **变异反证（再加一个键）**：追加 `"zzz_extra"`、长度 12→13 ⇒ **必红**。原始输出 `raw/22_b1_mutation_extra_key.txt`：
  `right: [..., "type", "zzz_extra"]`，`FAILED`，EXIT=101。
- **恢复原状**：`cp /tmp/p6_orig.rs` 覆盖；sha256 逐字节一致（`3ba4ab82…34e79` 两侧同值），再跑 4 passed/0 failed，EXIT=0（`raw/23_b1_restore_green.txt`）。

> 判据达成：v2 12 键精确集合 + 顺序声明 + 禁止包含式；去掉键、再加键均红；v2 shares/I1 断言在位；未删断言。

---

## 3. B2 通过 —— `web/e2e/adr028-window-sync.e2e.ts` 恒真豁免消除 + 断言补强

**对应冻结 B2 的 5 点要求**（逐条落地，文件本波 +720 行 / 相对索引 +321−36；默认落盘目录改 `20260920_adr027_p9c_final/raw`，仍可用 `ADR028_E2E_OUT` 覆盖）：

1. **clamp 场景断言精确期望值（不再豁免）**：`l2ClampedMismatches()` 按数据侧边界计算期望 —— ① `centerIdx + half > dataEndIdx`（居中确实被数据末端阻断）② `toIdx === dataEndIdx`（右缘**恰**钉在数据末端）③ `observedCenterIdx === dataEndIdx − floor((vis−1)/2)`（最大可居中程度的**精确值**）。`dataEndIdx` 由「数据末端目标」跳转回执自证（`toIdx === centerIdx`）。
2. **目标改不贴数据末端 + 减小 span 路径**：新增 **E3** 用例（run `sr_1789832517708_000005` / rt 3），目标两侧各 ≥60 根 ⇒ `edge_clamped === false` 路径**至少被真跑一次**，断言**真居中**。
3. **L1 补上界与居中**：`l1Mismatches()` 增 ④ 可见根数上界 `≤ ceil(want×1.5)+tol`（防「取全量/窗口过宽」）⑤ 居中 `|observedCenterIdx − centerIdx| ≤ 1`。
4. **L2 补目标落窗 + 跨度**：`l2CommonMismatches()` 断言 `fromIdx ≤ centerIdx ≤ toIdx`、`|可见根数 − 120| ≤ 5`、`state.span_bars == 真身可见根数`；E2 另显式锚定 `centerIdx == /fills.bar_index` 且 `toIdx == centerIdx`（索引空间漂移会响亮变红）。
5. **变异反证（两次）**：**M1** 拦截 `/round-trips` 把回合区间内收 20 根 ⇒ 用**变异**区间断言为空、用**原始**区间同一套断言**非空（红）**；**M2** 把真身图表 `scrollToDataIndex` 替换为 no-op（`barSpace` 仍生效）⇒ 基线居中判据绿、变异后**必红**。

**真跑**（`raw/30_b2_fe_build.txt` 构建；`raw/31_b2_playwright.txt` 真身 = `vite build` 产物 + 真 `:8081` + 真实库）：

```
✓ E1_L1_jump            ✓ E2_L2_jump_clamped     ✓ E3_L2_jump_centered
✓ E4_reset_back         ✓ M1_mutation_silent_noop ✓ M2_mutation_barspace_only_no_scroll
6 passed (26.0s)   PW_EXIT=0
```

**两次变异的原始输出（落盘，可复核）**：
- `raw/m1_mutation_mutated_mismatch.json` = `{"mismatch":[]}`（窗口随变异区间）；`raw/m1_mutation_original_mismatch.json` = 2 条不匹配 ⇒ 断言非恒真。
- `raw/m2_mutation_no_scroll.json`：`baseCenteredMismatch=[]`；`mutatedMismatch=[3 条，含「窗口真居中…centerIdx=57 observedCenterIdx=74」]`；`scrollCalls=5`（生产确实调用过滚动、被 no-op 吞掉）；变异前后窗口端点相同（`fromIdx/toIdx=13/135`）且 `mutBarSpace=5` ⇒ 精确捕获「只改 barSpace 不滚动」。
- 关键真身读数：E2 `raw/e2b_l2_clamped_target.json`（`edgeClamped=true`、`toIdx=314=dataEndIdx`、`observedCenterIdx=254=314−floor(121/2)`，`mismatch=[]`）；E3 `raw/e3_l2_centered.json`（`edgeClamped=false`、`centerIdx=observedCenterIdx=74`、`observedCenterTs==fill.ts`，`mismatch=[]`）。

> 判据达成：clamp 精确期望、真居中路径被跑到、L1 上界+居中、L2 落窗+跨度、两次变异有牙（原始输出落盘）。

---

## 4. D1 通过 —— 8081 重新构建 + 重启 + 冒烟

**部署（按项目既有宿主二进制做法）**：
- 构建：`cargo build -p app --bin eestock-app` → `Finished`，EXIT=0；二进制 `sha256 530d2eca…250c41`，`mtime 2026-09-19 23:50:07 +0800`（源码未变 ⇒ 与旧盘同一产物）。原始输出 `raw/50_d1_pre_and_build.txt`。
- 重启：`kill -TERM` 旧 pid 1901936（其 `exe sha = 530d2eca…`，已非本波前 p9b 报告中的 pre-P4c 旧二进制）→ 新 pid **1941108**，`/proc/1941108/exe sha == 磁盘 sha`，`--config /tmp/app_dev_8081.toml`，日志 `logs/app_dev_8081_redeploy_p9c_20260920_010927.log`（**0 ERROR / 0 WARN**，7 行 INFO）。原始输出 `raw/51_d1_restart.txt`。
- **顺序关系**：新进程启动 **Sun Sep 20 01:09:27 2026** **晚于** 二进制 mtime **2026-09-19 23:50:07 +0800** ⇒ 线上运行的是「本波磁盘产物」。

**冒烟（`:8081`，全部原始输出 `raw/52_d1_smoke.txt` + `raw/53_d1_smoke_param_shape.txt`）**：

| 冒烟项 | 结果 |
|---|---|
| `/fills` 元素键集 | **12 键**且含 `code`（`code=159776`）；`total=36`、`recorded=true` ⇒ 新契约在线 |
| `/fills` vs `/round-trips/1/fills` | 两者元素键集**同形状**（12 键逐字段一致） |
| 未知 `round_trip` | `/fills?round_trip=9999` → **404**；`/round-trips/9999/fills` → **404** |
| 非法参数 | 6 条形态错误路径 **全部 400 + 三键信封**（`keys=['code','detail','message']`，`code=request_invalid`，`detail.param` 指出出错参数）；负向对照（形态合法）→ 200 |
| `/round-trips` | 200（`n=1`, `rt_seq=1`） |
| `/round-trips/{seq}/fills` | 200（`n_fills=36`, `total=36`） |
| `/curve?kind=position` | 200（`kind=position`, `n_points=5`）；`kind=net_value` 亦 200 |
| 线上前端产物 | `index.html` 引用 `index-D8WPpeNL.js`，与 `web/dist/assets` 一致 |

---

## 5. 环境阻塞与一次性豁免清理（**须显式记录**）

**阻塞事实**：隔离测试库上 `cargo test -p web` 唯一红 = `orphan_detect_endpoint_red::r1`（断言测试库孤儿行 = 0；实测 left: 4）。原始输出 `raw/01_orphan_test_current_state.txt`。

**根因（与 B1 无关）**：`crates/web/tests/tester_p5_indep.rs::t_p5_http_structured_error_shape`（L593-594：`code = format!("83{:04}", (pid+4)%10000)` + `seed_symbol_and_m1(...,6)`，夹具 base=2026-09-09）**收尾只删 `strategy_run`/`symbols`，未删自己的 `kline_accurate` 原始行、也未对有界 cagg 窗口 refresh** ⇒ 原始行留存 + cagg 物化行在 symbols 删除后成孤儿（1w/1mo 各 1 条/次，每跑一次 +2）。B1 的 p6 用例 code 前缀 76–79，无关。冻结判词时 r1 绿只因当时库从 0 起跑。

**豁免范围（supervisor 裁决 A，严格限定）**：
- **库**：仅 `eestock_test`（隔离测试库）。**活库 `eestock` 全程零触碰**（清理前/后均只读 SELECT，事后复核活库孤儿 = 0）。
- **行 / code**：`kline_accurate` 中 3 个测试残留 code —— `838469`、`831554`（`DELETE 12`）与 `836963`（`DELETE 6`）；对应 cagg 物化行经有界 refresh 清除。
  - 说明：首轮删 `838469/831554` + refresh 后，refresh 把同类的**未物化**原始残留 `836963` 物化出来（同签名 close=100/vol=600，同 base）⇒ 必须一并清理（同库、同类、且由我的 refresh 触发，不清理会使基线更差）。总计 **3 个 code、18 根原始行**。
- **窗口**：`kline_accurate_1w` ∈ `[2026-08-30 16:00Z, 2026-09-13 16:00Z)`；`kline_accurate_1mo` ∈ `[2026-07-31 16:00Z, 2026-09-30 16:00Z)`（CST 桶边界；**禁 NULL,NULL 全量刷**）。
- 原始输出：清理前证据 `raw/10_orphan_cleanup.txt`、清理执行 `raw/11_orphan_cleanup_exec.txt` 与 `raw/12_orphan_cleanup_exec2.txt`；清理后 **10 表孤儿 = 0**；`kline_accurate`/`kline_raw` 三 code 残留 = 0 行。

**根因修复（只改测试，未改产品代码）**：给该用例收尾补 `DELETE FROM kline_accurate WHERE code=$1` + 对 `kline_accurate_1w`/`_1mo` 各一次**有界** `refresh_continuous_aggregate`（`f4a`/`R5` 结构约束相容）。**连跑该用例两次**（`raw/14_p5_rootcause_twice.txt`）：两次均 `ok`，且每次后孤儿计数 **1w/1mo = 0/0**。

**r1 恢复绿**：`raw/13_orphan_test_after_cleanup.txt` → `orphan_detect_endpoint_red` **4 passed / 0 failed**（`r1_orphan_endpoint_exists_and_reports_zero_on_clean_db ... ok`）。全量 `-p web` 跑完后孤儿计数仍 **0**（`raw/71_post_fullrun_orphans_tsc.txt`）。

---

## 6. 回归：`cargo test -p web`（隔离测试库）**全绿**

命令：`EESTOCK_TEST_DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/eestock_test cargo test -p web --no-fail-fast`
原始输出：`raw/70_cargo_test_web.txt`

- **31 个 target，177 passed / 0 failed / 0 ignored，EXIT=0**（无 `FAILED` 字样）。
- 关键 target：`tester_p6_fills_indep`（4 passed）、`tester_p5_indep`（**13 passed**，含修复后的 `t_p5_http_structured_error_shape ... ok`）、`orphan_detect_endpoint_red`（4 passed，r1 ok）、`api_kline_period`（ok）、doc-tests（ok）。
- 对照：p9b 车道同一命令为 31 target / 176 passed / **1 failed**（orphan r1）⇒ 本波把唯一红转为绿，未引入新红。

**类型检查**：`web/tsc -b` EXIT=0（`raw/71_post_fullrun_orphans_tsc.txt`）。

---

## 7. 门禁 check-tangle

`./scripts/check-tangle.sh` → `✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）`，**EXIT=0**（`raw/60_check_tangle.txt`）。

---

## 8. 改动清单（本波，已 `git add` 暂存，未 commit）

| 文件 | 变更 | 层 / 性质 |
|---|---|---|
| `crates/web/tests/tester_p6_fills_indep.rs` | +60 / −13（相对 HEAD） | web 集成测试（B1：v2 12 键精确集合 + v2 shares/I1） |
| `web/e2e/adr028-window-sync.e2e.ts` | 相对索引 +321 / −36（本波仅改默认 `OUT` 落盘目录为 p9c；其余为 p9b 已落盘的 B2 硬化） | 前端 E2E 规格（B2） |
| `crates/web/tests/tester_p5_indep.rs` | +15 | web 集成测试（测试卫生根因修复，防孤儿累积） |
| `coder/evidence/20260920_adr027_p9c_final/**` | 新增（report + raw 33 项） | 证据 |

边界：`crates/*/src` **零改动**；生产二进制与 `web/dist` 为同一源码构建（未改产品逻辑）。

---

## 9. 残留风险 / 未做项（不隐瞒）

1. **未跑全量 vitest**（判据未要求 + 资源纪律限定最多一次）。以 `tsc -b` 全绿替代；上一车道 vitest 唯一失败是一次 flaky（config sources，重跑即绿）。
2. **孤儿债仍有同类隐患**：本波只根治被点名的 `t_p5_http_structured_error_shape`。其它插入 `kline_accurate` 的测试若既不删原始行也不 refresh 1w/1mo 窗口，仍可能在**其它** cagg 窗口累积（本波全库审计显示当前仅此一处可见）。
3. **一次性 DELETE 豁免**已严格限定 `eestock_test` 的 3 个 code；活库未触碰（事后只读复核孤儿 = 0）。
4. `:8081` 现为本波重启的 pid 1941108；无 sim-live 恢复项（recovered=0/degraded=0）。
5. E2E 依赖活库特定 run（`sr_1789832477006_000002` / `sr_1789832517708_000005`）与固定下标；库清理后需重选（缺失会显式失败，非静默）。
6. 未跑其它历史 E2E 套件（不在本任务范围）。

---

## 10. 证据索引（`raw/`）

| 文件 | 内容 |
|---|---|
| `00_mem_snapshot_entry.txt` / `99_exit_snapshot.txt` | 进入/退出内存与进程快照（含 4173/vite/chromium 残留复核） |
| `01_orphan_test_current_state.txt` | 阻塞现场：r1 left:4（清理前） |
| `10_orphan_cleanup.txt` / `11_orphan_cleanup_exec.txt` / `12_orphan_cleanup_exec2.txt` | 豁免清理：清理前证据 / 首轮 / 补清 836963 + 孤儿归零 |
| `13_orphan_test_after_cleanup.txt` | r1 恢复绿（4 passed） |
| `14_p5_rootcause_twice.txt` | 根因修复用例连跑两次、孤儿不累积 |
| `20_b1_green_baseline.txt` | B1 基线全绿 |
| `21_b1_mutation_missing_key.txt` / `22_b1_mutation_extra_key.txt` | B1 两次变异必红 |
| `23_b1_restore_green.txt` | 恢复原状（sha 一致）+ 全绿 |
| `30_b2_fe_build.txt` / `31_b2_playwright.txt` | B2 构建 + 6 passed |
| `e1_*/e2a_*/e2b_*/e3_*/e4_*/m1_*/m2_*.json` | B2 真身读数与两次变异反证（含 mismatch 明细） |
| `50_d1_pre_and_build.txt` / `51_d1_restart.txt` / `52_d1_smoke.txt` / `53_d1_smoke_param_shape.txt` | D1 构建/重启/冒烟（含启动时间 vs 二进制 mtime 顺序） |
| `70_cargo_test_web.txt` | 全量 `-p web`：31 target / 177 passed / 0 failed / EXIT=0 |
| `71_post_fullrun_orphans_tsc.txt` | 跑后孤儿 = 0 + tsc EXIT=0 |
| `60_check_tangle.txt` | check-tangle EXIT=0 |
