# 闸门 3 收尾 · 最后一批增量独立复验（P4c 后端一致性 / P5c 真渲染 E2E / P9 文档回写 + D3 历史清理）

**报告自身位置**：`tester/evidence/20260920_adr027_accept_final/report.md`
**原始输出目录**：`tester/evidence/20260920_adr027_accept_final/raw/`

---

## 0. 判词（前置）

**E2E 不通过（执行 4/4 绿，但断言不足：G1 居中判据被 `edge_clamped` 恒豁免、G2 L1 窗口只有下界且未断言居中） ｜ 后端三点修复 有牙（现场 before/after 双证） ｜ 回归 红（1 failed：`tester_p6_fills_indep`） ｜ check-tangle 绿 ｜ 树静止 是 ｜ D3 清理复核 通过 ｜ 总判词 = 冻结**

**阻断项**

| 编号 | 阻断项 | 证据 |
|---|---|---|
| **B1** | 回归红：`cargo test -p web`（真测试库）`tester_p6_fills_indep::t_p6_fills_is_exact_source_and_trades_misses_partial_fills` 断言失败——既有 **tester 冻结契约用例**仍要求 `/fills` 元素键集**恰为 7 个旧字段**，而 ADR-027 增量已把元素扩到 12 键（含 `code`/`rt_seq`/`trade_value`/`commission`/`stamp_duty`）。该用例自增量落地起即红，且因未设 `EESTOCK_TEST_DATABASE_URL` 而被 DB 门禁掩盖，从未被跑到。 | `raw/21_cargo_regression_testdb.txt:826,838-847` |
| **B2** | E2E 断言不足：L2「可见窗口中心 bar == 成交 bar」这一条**在默认参数下永远被豁免**（本次实跑 `edge_clamped=true`，实测中心 idx 254 与目标 idx 283 差 **29 根**，断言判定为「通过」）；L1 窗口只有**下界**且**不**断言居中 ⇒ 两类静默失败（窗口过宽 / 只改 barSpace 不滚动）可绿。 | `coder/evidence/20260920_adr027_p5c_e2e/raw/e2e.json`（我重跑复现）、`web/e2e/adr028-window-sync.e2e.ts:196-236`、`web/src/features/dashboard/klineWindowOps.ts:295-321` |

**非阻断发现（登记，不阻断放行）**：EV1 在跑的 `:8081` 是 **pre-P4c 旧二进制**（下文 §2.0）；EV2 未知回合 404 的响应体是字符串形 `{"error":"…"}` 而非 400 那套 `{code,message,detail}` 信封（与既有 404 口径一致，属既有形状不对称）。

**边界声明（角色纪律）**：本波**未改任何生产代码**（入口/出口生产源码哈希逐字节一致，见 §5）；未 `stitch`/未 `entangled tangle` 写盘；未执行任何 `DELETE`/`UPDATE`/`TRUNCATE`；对活库 `eestock` 只做只读 `SELECT` 与只读 `GET`；新增/修改的落盘文件全部在 `tester/evidence/20260920_adr027_accept_final/`（外加 `web/dist` 构建产物与 `/tmp` 临时文件）。**未分析失败、未尝试修复**（B1/B2 只报事实与「应该补什么」）。

---

## 1. 第 1 项：前端真渲染 E2E（自己重跑）

**运行方式**（与规格头部一致，真身 = 生产构建产物 + 真实 `:8081` 后端/库）：

```bash
cd web && npx vite build                       # EXIT=0（raw/05_vite_build.txt）
VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --port 4173 --strictPort &
E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list
```

**结果（`raw/10_playwright_adr028_tester_rerun.txt`，EXIT=0）**：

```
✓ E1_L1_jump：真渲染下 [跳转] 后 K 线可见窗口 == 回合区间（± buffer ±1 根） (3.7s)
✓ E2_L2_jump：真渲染下 [跳转] 后窗口中心 bar == 该笔成交 bar (4.1s)
✓ E4_reset_back：全览恢复全区间、历史回退恢复跳转窗口（真身） (4.6s)
✓ M1_mutation_silent_noop：拦截回合区间 ⇒ 原始基线真身断言必须变红 (3.6s)
4 passed (16.4s)
```

**真身读数（我重跑写出的 JSON 与 coder 原始文件 sha256 逐字节一致 ⇒ 可复现）**：

| 用例 | 真身读数（关键） |
|---|---|
| E1 | `ok=true`／`requested_barSpace=12`→`barSpace=11`／可见 `[259,314]`=56 根／`from_ts=1783008000 ≤ open_ts=1783353600`、`to_ts=1789660800 ≥ close_ts`／`center_idx=observed_center_idx=287`／4 个曲线视图 `data-x-domain` 全 = 共享窗口／`edge_clamped=false` |
| E2 | `ok=true`／成交 `fill.ts=1785945600`（bar 283）落在窗内／可见 `[193,314]`=122 根（|122−120|=2 ≤5）／**`observed_center_idx=254` vs `center_idx=283`（差 29 根）**／**`edge_clamped=true`** |
| E4 | 全览 `source=full`、历史栈「可回退 2 步」、曲线定义域 = run 全区间；回退后 `source=jump`、`[259,314]`、L1 判据复成立 |
| M1 | 变异后区间断言空、**原始区间断言非空**（2 条不匹配）⇒ 断言非恒真 |

**「跳转成功」断言是否真的存在**：**是**，但不是「没报错」——E1/E2 都断言了 `ok=true`、**真身可见 ts 区间覆盖回合区间**、可见根数（E1 下界 / E2 精确 120±5）、**共享窗口 == 真身实测窗口（端点精确相等）**、4 个曲线视图 x 定义域 == 共享窗口；M1 变异反证证明这套断言非恒真。**但断言不足以捕获两类静默失败**：

- **G1（对应任务点 1「可见窗口中心 bar 断言」）**：L2 的居中判据在**默认参数下恒被豁免**。`L2_SPAN_BARS=120` 需目标两侧各 ≥60 根，而本 run 的 L2 成交全部落在 bar 261–314，数据末根 = 314 ⇒ **任何成交都无法居中**（283+60=343 > 314）⇒ `edge_clamped` 恒为 `true` ⇒ 该判据在本 run 上**永远不会被执行**。实跑中中心偏差 29 根仍判「通过」。
- **G2（L1）**：`可见根数 ≥ 回合根数 + 2×buffer − 容差` **只有下界**，且**没有**任何居中断言。探针已经把 `center_idx`/`observed_center_idx` 上屏，断言却没用它们 ⇒ 「barSpace 生效但滚动被静默吞掉（窗口过宽、未居中）」可绿（本 run 的回合恰好贴数据末端，覆盖/端点相等两类断言对过宽窗口同样成立）。

**应该补什么（只提测试侧改法，不改实现）**：

1. L2 居中判据改为**可期望值断言**而不是豁免：
   `expected = clamp(idx, halfVis, last−halfVis)`，断言 `observed_center_idx === expected`（夹取时仍**精确**校验，而不是跳过）；或把 `L2_SPAN_BARS` 降到该数据可居中的值（如 40：需两侧各 20 根，bar 283 两侧充足），并保留 120 作为另一条覆盖用例。
2. 选一个**不贴数据末端**的 run（或成交下标）作为 E2 默认目标（`ADR028_E2E_RUN`/`ADR028_E2E_FILL` 已可覆盖参数），确保 `edge_clamped=false` 这条路径**至少被跑到一次**。
3. L1 加两条断言：`|observed_center_idx − center_idx| ≤ 1`（或上面的 clamp 期望值形式）＋可见根数**上界** `≤ 回合根数 + 2×buffer + 容差`；再加一条**负向/变异**用例：把 `setBarSpace` 静默吞掉的等价场景（桩内 `setBarSpace` 直接 return / 或滚动后退回原位）作为变异体，要求基线断言必须变红（现有 M1 只变异了回合区间，覆盖不到此路径）。
4. E2 的 `count == 120±5` 建议同时断言 `fill.bar_index ∈ [fromIdx,toIdx]`（现只断言 ts 落窗）与「窗口未超 span 上界」，防「窗口取全量也过」。

---

## 2. 第 2 项：后端三点修复（自己重跑 + 现场反证「有牙」）

### 2.0 现场双证（同一份数据、两个二进制）

在跑的 `:8081`（`target/debug/eestock-app`，进程 1781236，**启动 23:30:48**，其 exe 已被后续构建替换 ⇒ **pre-P4c 旧二进制**）与**当前源码构建**的新二进制（`cargo build -p app --bin eestock-app` → `target/debug/eestock-app`，另起 `127.0.0.1:18091`，连同一活库只读 GET）对照：

| 探针 | 旧二进制 `:8081`（`raw/60_stale_8081_probes.txt`） | 新二进制 `:18091`（`raw/61_fresh_binary_probes.txt`） | 判定 |
|---|---|---|---|
| `/fills?limit=2` 元素键 | 11 键，**无 `code`** | 12 键，**含 `code="159776"`**（= run 的 symbol） | 修复生效 |
| `/fills` vs `/round-trips/1/fills` 元素键集 | 11 vs 11 | **12 vs 12，逐字段一致** | 同形状 |
| `/fills?round_trip=9999` | **200 + `fills:[]`（口径混杂）** | **404** `{"error":"回合 9999 不属于运行 …（L1 回合账本无该 rt_seq）"}` | 修复生效 |
| `/round-trips/9999/fills` | — | **404**（两端口径对称） | 修复生效 |
| `/fills?round_trip=abc` | **400 纯文本** `Failed to deserialize query string: …` | **400 JSON 信封** `{"error":{"code":"request_invalid","message":"参数形态非法（round_trip/offset/limit 须为整数）","detail":{"param":…,"reason":…}}}` | 修复生效 |
| 8 条形态错误路径（`round_trip/offset/limit` 非数字、`-1`、空串、路径 `rt_seq` 非数字、两端口径） | — | **8/8 全为 400 + 信封（3 键 `code/message/detail`，`detail.param` 指出出错参数）** | 修复生效 |
| 负向对照：形态合法但 run 不存在 | — | 404（**非** 400）；已知回合过滤 = 200 + `total=16` | 未过度修复 |

⇒ 「缺少 `code`」「未知 `round_trip`」「非法参数」三种反向构造**都被错误码/形状抓住**：旧二进制上三种都能复现原症状，新二进制上三种全部按契约收敛，且断言（键集相等 + `code`==symbol；404 类错误；信封 3 键）**非恒真**（旧二进制会让它们全红）。

### 2.1 重跑测试

| 用例 | 结果 | 证据 |
|---|---|---|
| `cargo test -p application --test workbench` 的 `c4_fills_filter_and_element_increment`、`c4b_fills_round_trip_unknown_seq_is_404_symmetric_with_l2` | **ok / ok** | `raw/21_cargo_regression_testdb.txt:289,295` |
| `cargo test -p web --test adr027_fills_param_shape`（8 条形态表 + 负向对照，lazy 不可达池、零连库） | **2 passed** | `raw/21_cargo_regression_testdb.txt:566-572` |
| `cargo test -p application`（全 12 目标，真测试库） | **全绿**（47/2/2/2/6/3/3/57/41/3/54/2…） | 同上 |

**口径说明（不是修复，只是记录）**：`code` **只在读径注入**，DB 内 `strategy_run_bars.payload`（kind=`fills`）里**没有** `code`（§6 表）。与 P4c 报告「归一化发生在响应出口」一致，chunked 与 legacy 两条读径同时获得该字段。

---

## 3. 第 3 项：回归面

| 项 | 命令 | 结果 |
|---|---|---|
| Rust（strategy-core / application / web） | `EESTOCK_TEST_DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/eestock_test cargo test --no-fail-fast -p strategy-core -p application -p web` | **红**：488 passed / **1 failed** / 1 ignored / 52 个目标（`raw/21_cargo_regression_testdb.txt`） |
| ↳ 唯一失败 | `-p web --test tester_p6_fills_indep::t_p6_fills_is_exact_source_and_trades_misses_partial_fills` | `crates/web/tests/tester_p6_fills_indep.rs:300`：`元素字段集合应恰为 ["type","bar_index","ts","side","qty","price","reason"]；实际 ["bar_index","code","commission","price","qty","reason","rt_seq","side","stamp_duty","trade_value","ts","type"]`（left 12 vs right 7） |
| 无 `EESTOCK_TEST_DATABASE_URL` | 同上（先跑的一遍） | 在 `-p web --test adr024_structured_errors` 处**响亮失败**（`test-support` 门禁 panic，点名环境变量）⇒ 门禁有效；此形态下 web 侧真库用例**全部无法被跑到**（正是 B1 长期未被发现的原因） |
| vitest | `cd web && npx vitest run` | **绿**：`Test Files 100 passed (100)` / `Tests 963 passed (963)`（`raw/30_vitest_full.txt`） |
| tsc | `cd web && ./node_modules/.bin/tsc -b` | **绿** EXIT=0，无输出（`raw/31_tsc.txt`） |

**测试库口径**：环境里原本**未设** `EESTOCK_TEST_DATABASE_URL`。我按 `scripts/testdb-init.sh` 的约定（库 `eestock_test`，哨兵表 `_eestock_test_db=test`，与活库 `eestock` 分离）**只设了环境变量**并真跑（未执行 init 脚本，库与哨兵已存在）；`test-support` 的哨兵断言通过 ⇒ 写入只落在测试库。

---

## 4. 第 4 项：门禁

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

（`raw/40_check_tangle.txt`；沙箱重生成，未写真实工作区）

---

## 5. 第 5 项：树静止与生产源码哈希

`find crates web/src -type f \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -not -path '*/target/*' -not -path '*/node_modules/*' | sort | xargs sha256sum > sums.txt; sha256sum sums.txt`

| 时点 | 文件数 | 汇总 sha256 |
|---|---|---|
| 进入（00:15:23） | 458 | `33e31881d9fe8e5aa7e6d90b565abd15c8ac1789aaa29d078dc2ee4ff8896ac9` |
| 退出（00:19） | 458 | `33e31881d9fe8e5aa7e6d90b565abd15c8ac1789aaa29d078dc2ee4ff8896ac9` |

逐行 `diff` 为空 ⇒ **树静止 = 是**（验收全程无人改生产码；本波自身也未产生任何生产改动）。
附：`find` 的本版本**不支持** `--exclude-dir`（`find: unknown predicate`），已改用等价的 `-not -path '*/target/*' -not -path '*/node_modules/*'`（`grep` 侧仍按要求带 `--exclude-dir`）。

---

## 6. 第 6 项：D3 历史清理复核（只读）

`raw/70_d3_cleanup_readonly.txt`，cutoff = 归档时刻 `2026-09-19T14:41:56Z`：

| 复检项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| `strategy_run` 旧数据（`created_at < cutoff`） | 0 | **0** | ✅ |
| `strategy_run` v2 数据（`created_at ≥ cutoff`） | 7 | **7** | ✅ |
| 7 条 run 明细 | 全在归档之后 | 5 succeeded + 2 failed，`created_at` 2026-09-19 15:31:06Z ~ 15:41:57Z | ✅ |
| `simsession` 旧数据（`start_ts < cutoff`） | 0 | **0**（表总行数 0，旧 12 条已删） | ✅ |
| **口径混杂**：v2 run 的 L2 fills 块缺 `rt_seq` | 不得存在 | 7/7 run 全为 `with_rtseq = n`（16/16、4/4、16/16、126/126、36/36、10/10、96/96） | ✅ |
| 同项 L1：`strategy_run_result.trades` 缺 `rt_seq` | 不得存在 | 5/5 有结果行的 run 全为 `l1_with_rtseq = l1_n`（1/1、1/1、1/1、5/5、48/48） | ✅ |
| 抽样 3 条（`…000002`/`…000005`/`…000006`） | 逐笔核对 | L1 行 `rt_seq` 100% 覆盖；L2 块 `rt_seq` 100% 覆盖 | ✅ |
| 分块完整性 | — | `drawdown/net_value/per_bar/fills` 各 7 run、`position` 5 run | ✅ |

**注意（登记，非混杂）**：DB 内 `fills` 块**不含** `code`（7/7 run `with_code=0`）——`code` 是 ADR-027 §5.4 的**读径注入**字段，与「口径混杂」不同类；`result_format` 全为 `chunked_v1`（ADR-024 存储格式标签，与 ADR-027「结果载荷 v2」不是同一维度；见 `design/04-storage/schema.md:1235`）。

---

## 7. 产物索引

| 文件 | 内容 |
|---|---|
| `raw/00_tree_hash.txt` | 进入时生产源码哈希（分组汇总 + 方式说明） |
| `raw/05_vite_build.txt`、`raw/11_vite_preview.txt` | `vite build` / `vite preview`（:4173）输出 |
| `raw/10_playwright_adr028_tester_rerun.txt` | 我重跑 E2E 的原始输出（4 passed，EXIT=0） |
| `raw/10_p5c_raw_before_sha256.txt`、`raw/p5c_raw_before/`、`raw/p5c_raw_tester_rerun/` | E2E 规格会覆写 `coder/evidence/…/p5c_e2e/raw/*.json`：运行前快照 + 运行后快照（**比对结果逐字节一致**，故无需回滚） |
| `raw/20_cargo_regression_no_db_env.txt` | 未设测试库环境变量时的跑（暴露 DB 门禁响亮失败） |
| `raw/21_cargo_regression_testdb.txt` | 真测试库下 `-p strategy-core -p application -p web` 全量（含唯一失败与全部 52 个目标） |
| `raw/30_vitest_full.txt`、`raw/31_tsc.txt` | vitest 100/963、tsc EXIT=0 |
| `raw/40_check_tangle.txt` | 门禁输出（EXIT=0） |
| `raw/50_app_build.txt`、`raw/51_fresh_app_18091.log` | 新二进制构建与起服日志（:18091，只读探测用；已停） |
| `raw/60_stale_8081_probes.txt` | 在跑 `:8081`（pre-P4c）三处原症状 |
| `raw/61_fresh_binary_probes.txt` | 当前源码二进制上三处修复的 HTTP 级证据（含 8 条形态错误表与负向对照） |
| `raw/70_d3_cleanup_readonly.txt` | D3 清理只读复核（含逐 run 明细与 `rt_seq` 覆盖） |

---

## 8. 残留风险 / 未做项（不隐瞒）

1. **B1 的处置口径属产品/契约决策，不属 tester 权限**：`tester_p6_fills_indep` 断言的是 ADR-027 之前的元素形状（7 键）。要么按 §5.4 更新该冻结用例（属「测试随契约更新」，需父级授权并记录），要么认定元素扩键属违约回退；在裁决前 `cargo test -p web` 恒红。
2. **E2E 依赖真实库中的特定 run**（`sr_1789832477006_000002`）与固定成交下标；库清理后需重选（用例对缺失 run 会显式失败，不静默）。本次依赖仍成立（§6）。
3. **`:8081` 正在跑 pre-P4c 旧二进制**（§2.0）：任何「用 :8081 做验收」的做法都会看到旧的 `code/404/信封` 语义；建议后续验收固定用「当前源码构建的新二进制」或重启实例（我未重启共享实例，避免影响他人）。
4. 未知回合 **404 响应体是字符串形** `{"error":"…"}`，与 400 的 3 键信封不同形（与既有 404 口径一致，未纳入本次三点修复范围）⇒ 若前端要编程消费 404 需另立增量。
5. 我**未**运行 `web/e2e/` 其它历史 E2E 套件（不在本波范围），也**未**对 B1/B2 做任何修复尝试（角色边界）。
6. 时间：本波实际用时约 40 分钟（超 30 分钟硬上限约 10 分钟）；超时发生在第 3 项（真库全量 Rust 回归）与第 6 项收尾之间，未因此跳过任一条必验项。
