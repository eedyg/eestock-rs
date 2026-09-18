# ADR-024 P4b 修复（进度落库时间窗节流 ≥250ms）+ confirm 阈值 500k —— **tester 独立验收报告**

- **本报告自身路径**：`tester/report/adr024_p4b_fix_verification.md`
- 角色：tester（**只验不改生产代码**；未 `git add` / 未 `git commit`；临时库跑完即 `DROP … WITH (FORCE)`）
- 被执行对象：`coder/report/adr024_p4b_fix_and_confirm_threshold.md`（证据 `coder/evidence/adr024_p4b_fix/` 18 项 + 探针脚本）
- 本报告证据目录：`tester/evidence/255_adr024_p4b_fix_verify/`（**33 项原始输出 + 2 个 tester 自写探针**）
- 冻结目标（**验收对象** = HEAD `18d1b9a` + index；P4b 增量文件与其 index/工作区一致性已核对）：

| 文件 | index sha256 = 工作区 sha256 | 一致 |
|---|---|---|
| `crates/application/src/workbench.rs` | `2495e9cb7e022eff…` | ✅ YES |
| `crates/application/src/error.rs` | `5d4af7047788684b…` | ✅ YES |
| `crates/application/tests/workbench.rs` | `792e37e66ebf362b…` | ✅ YES |
| `crates/application/tests/resource_guard_contract_vectors.rs` | `f1ce97b1536b31f0…` | ✅ YES |
| `crates/web/tests/tester_p5_indep.rs`（tester 资产，**未入 index**） | 重钉前 `f463cc65…` → 重钉后 `2ea7a9a6…` | — |
| `design/16-backtest-scalability/contract-vectors.json` | index `838530ee…` ≠ 工作区 `113de0f6…` | ❌ **不一致（见 §6.4 阻塞项 B1）** |

> tester 在生产源码上做过 3 次**临时反向**改动（`PROGRESS_DB_MIN_INTERVAL` 250→0、`GUARD_CONFIRM_BARS` 500000→200000 ×2），
> 每次均**逐字节复原**：`workbench.rs` 与 `error.rs` 的 sha256 回到上表值，`git diff -- crates/` 行数 = 0，无 `TESTER-*` 标记残留（§3、§6）。

---

# 0. 判词（结论在最前）

## 0.1 七项逐条

| # | 任务 | 判词 | 关键证据 |
|---|---|---|---|
| **①** | **行为边界**（帧粒度 / 只降落库 / 终态必写 / 顺序不变） | **部分 FAIL**（4 条子项：3 PASS + **1 FAIL**） | 帧粒度 **PASS**（帧数 before==after：733/1001/1001，真路径 WS 亦 1001）；只降落库 **PASS**（落库 **733→2 / 1001→2 / 1001→3**，−99.7%）；顺序不变 **PASS**（静态 L1872 < L1923 + 行为：分块失败经排水返回 `chunk_err` 才落 `failed`）；**终态必写：完成 PASS / 失败 PASS / 取消 → 🟥 FAIL（真路径 DB 层）** —— 6 轮真路径取消，DB `progress` 停在**首帧**（`6.0987e-05`）而取消瞬间 WS 末帧已到 `0.27–0.64`（§1.3） |
| **②** | **独立前后对照（真路径 3 档）** | **PASS** | 自跑 before/after：帧数逐档不变；落库次数 **与 worker 逐格同值**；落库耗时 −98.5~−99.6%；permit 持有 −55~−95%；dur −55~−95%。时序量（ms）**同量级非逐格同值**（§2） |
| **③** | **反向证据** | **PASS** | R1 关节流 ⇒ `writes=1001=produced=1001` 断言必红（`0 passed; 1 failed`）；R2 常量改回 200000 ⇒ 向量绑定 `1 passed; 2 failed` + tester 资产复红；两次均**逐字节复原**（§3） |
| **④** | **阈值与契约** | **PASS**（+1 条冻结前必修，见 §0.3） | 常量 `500_000` / `2_000_000` 与 `contract-vectors.json::resource_guard` 绑定（3/3 绿）；边界 **499_999 放行 / 500_000 ⇒ 400 `resource_guard`（`detail.confirm_bars=500000`）/ `confirm:true` ⇒ 放行 / 2_000_001 ⇒ 硬拒（`confirmable=false`）** 逐点实测；tester 资产 `tester_p5_indep.rs` 重钉 500_000 后 **13/13 绿**，旧版必红（§4） |
| **⑤** | **回归** | **部分 FAIL**（349 / 350） | 全新临时库 `cargo test -p application -p web --no-fail-fast`：**349 passed / 1 failed**（37 个目标）。唯一红 = `tester_p5rect_verify::t_n1_http_every_400_is_structured_object`（**阈值漂移，非产品回归**，已因果证明）。`cargo check --all-targets` EXIT=0；`check-tangle` ✅；前端 vitest **94 files / 901 tests 全绿**（基线 90/864，**不减**）；`tsc -b` EXIT=0。P0–P6 点名面全绿（§5） |
| **⑥** | **卫生与范围** | **PASS** | 临时库 2 个已 `DROP … WITH (FORCE)`，回读仅 `{eestock, postgres}`+系统模板，`tmp_%` 计数 **0**；app 进程 0；core dump **0**；活库 `strategy_run` 最新 `created_at=2026-09-13`（早于本会话）⇒ **0027 未应用、活库零写**；本批越界路径 0（§6） |

## 0.2 三个明确结论

> ### 结论 A —— **P4b 修复可否冻结？**
> **可以冻结（产品行为面），但带 1 条口径裁决 + 1 条冻结前必修。**
>
> - 支撑：①帧粒度零变更（静态 + 真路径 WS 计数）②落库次数 −99.7%（before/after 自跑，与 worker 逐格同值）③反向证据双向可弄红且复原逐字节一致 ④顺序/通道/取消检查零 diff ⑤`cargo test -p application` 目标 **43/43 绿**（含 4 条 P4b 专测）⑥范围仅 4 个代码文件。
> - **需架构师一句裁决（不阻塞产品冻结，但阻塞"该条验收判 PASS"）**：派单把「**取消**路径必须落库最终进度」列为硬验收。真路径实测 **FAIL**：`cancel()` 先 `mark_canceled`（status→canceled），排水补写命中**既有** `store.update_progress` 的 `WHERE status='running'` 守卫 ⇒ 0 行受影响。
>   **重要事实：改动前（逐帧落库）同样不成立**（before 4/4 轮 DB≠取消瞬间进度，落后 0.23–0.62；after 落后 0.30–0.64）⇒ 这是**既有缺陷**，本批**未引入**、也未使其恶化（量级相当）。本批真正保证的是「**补写调用不被时间窗吞掉**」（计数可证：`writes = frames − throttled + 1`）。
>   两条可行裁决：**(i)** 接受现状（口径改为"写调用不被节流吞掉"）→ 本项可判 PASS；**(ii)** 要求 DB 可见 → 本项 FAIL，需另立小批（如 `mark_canceled` 同事务写入当时进度，或取消只置内存标记、DB 迁移交给排水）。
> - **冻结前必修（B1，1 条命令）**：`design/16-backtest-scalability/contract-vectors.json` 的架构师改动**只在工作区、未入 index**，而依赖它的 `resource_guard_contract_vectors.rs` **已入 index** ⇒ 只按 index 检出会让 3 条向量断言 panic（§6.4）。结项时须与该文件一并 add/commit。

> ### 结论 B —— **整批（migrate 0027 + P4 + P6 + P5 + P4b）是否具备上线条件？**
> **产品代码：具备。交付快照：尚不具备（缺 1 次 `git add` + 1 个 tester 资产重钉 + 1 条口径裁决）。**
>
> | 维度 | 状态 |
> |---|---|
> | 生产代码缺陷 | **0**（本批 4 个代码文件 + 回归 349/350，唯一红为测试资产漂移） |
> | P0–P6 面未回退 | ✅ M30/SSOT、P2 引擎线性化/会话等价（`backtest` 31 + `strategy-core` 33+25+6+7+1+3 全绿）、`/fills`+`recorded`（4/4）、分块写（6/6）、结构化错误（2/2 + tester ⑤）、区间收缩（`tester_p5rect_verify` 3/4，1 红系阈值）、`periods.ts`（前端 94/94） |
> | **上线前必修 1（B1）** | `git add design/16-backtest-scalability/contract-vectors.json`（+ `02-spec.md`）——否则 index 快照自相矛盾 |
> | **上线前必修 2（B2）** | `crates/web/tests/tester_p5rect_verify.rs` 1 例红：`runs/resource_guard(confirm=false)` 夹具区间 518880 M1 2021-01→2026-01 仅 **292,092 bar < 500,000** ⇒ 期望应改为「201/放行」或把区间换成 ≥50 万 bar。**未修**：派单只授权我改 `tester_p5_indep.rs`（§5.3） |
> | **上线前必修 3（B3）** | 结论 A 的取消口径裁决 |
> | migrate 0027 | **未对活库应用**（活库 `to_regclass('strategy_run_bars')` = NULL）；本批仅对临时库应用；上线需独立部署窗口（不在本批范围） |
> | 版本级风险（非本批） | `web/src/api/mock.ts` 仍 `MOCK_GUARD_CONFIRM_BARS=200_000`（dev-only mock，无红测试绑定）；worker 已列为其未决项② |

## 0.3 未过项 / 阻塞项一览

| ID | 类别 | 内容 | 影响 | 归属 |
|---|---|---|---|---|
| **F1** | 验收口径（真路径 FAIL） | 取消路径：DB `progress` ≠ 取消瞬间进度（补写被 `status='running'` 守卫丢弃） | 冻结判词「取消终态必写」是否成立 | 架构师裁决 B3 |
| **F2** | index 一致性 | `contract-vectors.json` 的 `max_bars_guard/confirm_bars` **只在工作区** | index 单独检出 ⇒ 向量断言 panic | 架构师（1 条 `git add`） |
| **F3** | 测试资产漂移 | `tester_p5rect_verify::t_n1_http_every_400_is_structured_object` 1 红 | 回归非全绿 | tester 复验轮（派单未授权本轮改） |
| **R1** | 既有缺陷（非本批） | 「取消瞬间进度」在 DB 不可见：**before 亦如此**（drain 背压 + 同一守卫） | 无新增风险 | 记录在案 |
| **R2** | 口径提示 | `RUN_FIXED_SECS = 0.85` 基于「1003 次写库」旧事实；节流后每 run 固定写库 2–3 次 | ADR D1 要求「P4b 之后重做标定」 | 后续轮（worker 已列） |
| **R3** | 环境性 | 首次回归（同库复用）时 `orphan_detect_endpoint_red::r1` 因**自身测试夹具残留**变红（2 孤儿行）；换**全新库**复跑全绿 | 非产品问题 | 记录在案（§5.2） |

---

# 1. ① 行为边界（最重要）

## 1.1 断言「WS 帧粒度未变」——**PASS**

**静态**（证据 `02_static_order_and_frames.txt`；对照物 = `tester/evidence/250_adr024_p2c_p4b_verify/delivered_index_state/crates_application_src_workbench.rs`，即上一轮 tester 独立验收过的 P4b 仪表交付态）：

| 项 | 改动前（250 快照） | 本批交付态 | 判 |
|---|---|---|---|
| `const PROGRESS_THROTTLE_MILLI: f64 = 1000.0` | L60 逐字 | L79 逐字相同 | ✅ 不变 |
| 取消每 bar 检查 `if flag2.load(Ordering::Relaxed) { return LoopControl::Break }` | L1008 | L1775 | ✅ 不变 |
| 帧判定式 `if milli != last_milli \|\| i + 1 == tot` | L1014 | L1781 | ✅ 不变 |
| 帧入队 `frames_produced.fetch_add` + `tx.send(RunMsg::Progress(…))` | 同一判定分支内 1 处 | 同一判定分支内 1 处 | ✅ 不变（仅 `tx.send` 载荷从元组改为枚举变体 = P4 已验收） |
| `sink.send` 调用点 | 1（L963） | 1（L1685） | ✅ 每帧仍推送 |
| `unbounded_channel` | 1 | 1（L1662） | ✅ 语义不变（无容量/`try_send`/drop 分支） |

**行为（真路径，after 二进制 + WS 客户端订阅 `strategy_run`）**（证据 `07_terminal_paths_realpath.txt`）：

```
complete（M1 16147 bar）：ws_frames=1001  ws_last_progress=1  ws_duplicate_consecutive=0
```

三档 before/after 帧数逐档相同（§2 表）：**733 / 1001 / 1001**，与 `min(1001, 喂入 bar)` 一致。
> 派单写的「`min(1001,bars)+2` 量级」：**帧数本身 = `min(1001, bars)`**；"+2" 是 D15 原话「每 run 固定 1003 次 **UPDATE**」里的 2 次状态迁移。改后每 run UPDATE 总数 = 写库次数 + 2：**before 735/1003/1003 → after 4/4/5**（证据 `32_order_behavioral.txt`）。

## 1.2 断言「只降落库频率」——**PASS**（基线**自跑**，不采信 worker 的 before）

| bars | 阶段 | 帧数 | 落库次数 | 落库耗时 ms | permit 持有 ms | 落库占 permit | dur s |
|---|---|---:|---:|---:|---:|---:|---:|
| 733 | before | 733 | 733 | 646.288 | 670.029 | 96.46% | 0.667454 |
| 733 | after | **733（不变）** | **2（−99.7%）** | **2.674（−99.6%）** | 36.127 | 7.40% | 0.033608 |
| 3865 | before | 1001 | 1001 | 842.379 | 910.761 | 92.49% | 0.907366 |
| 3865 | after | **1001（不变）** | **2（−99.8%）** | **3.023（−99.6%）** | 130.265 | 2.32% | 0.127279 |
| 16397 | before | 1001 | 1001 | 831.874 | 1054.962 | 78.85% | 1.044150 |
| 16397 | after | **1001（不变）** | **3（−99.7%）** | **12.165（−98.5%）** | 473.636 | 2.57% | 0.462931 |

原始输出：`05_before_probe.txt` / `06_after_probe.txt`（探针 `probe_255.sh`）；对照表 `26_before_after_vs_worker.txt`。

## 1.3 断言「终态必写」——完成 **PASS** / 失败 **PASS** / **取消 FAIL（真路径 DB 层）**

### (a) 完成路径 —— PASS

真路径三档全部 `status=succeeded`、DB `progress=1`（`05/06` 号 `|row|` 行）；WS 末帧 = 1.0；mock 级断言 `last_update_progress=Some(1.0)`（`p4b_progress_db_time_window_throttle_reduces_writes` 绿，§1.5 证据）。

### (b) 失败路径（**注入分块写失败**）—— PASS

在**临时库**给 `strategy_run_bars` 加 `CHECK (false) NOT VALID`（对**新行**生效），跑 4 块大 run，随后解除（证据 `10_fail_path_realpath.txt`、`11_fail_path_summary.txt`）：

```
注入前约束: kind_check / pkey / fkey          注入后 + t255_fail_inject | CHECK (false) NOT VALID
RESULT: status=failed  progress_in_db=1  ws_frames=1001  ws_last=1
        error="结果分块落库失败: … new row … violates check constraint \"t255_fail_inject\""
run 行: failed | progress=1 | error=结果分块落库失败: …
该 run 的 strategy_run_bars 行数 = 0（写失败确实发生）
日志: frames=1001 writes=3 throttled=998 outcome=failed_chunk_write   ⇒ 终止补写 = 3−(1001−998) = 0
```
⇒ 失败路径**终态进度 1.0 落库成功**，且**无多余写入**。

### (c) 取消路径 —— 🟥 **FAIL（真路径 · DB 可见性）**

**方法**：`probe_255_ws.mjs` 订阅 WS `strategy_run`（通配）逐帧记录 → 提交 16k bar run → 延迟 N ms `POST /runs/{id}/cancel` → 轮询终态 → 读 DB `progress`。**before / after 双二进制同条件对照**（证据 `16_cancel_before_vs_after.txt`、`08_cancel_race_5runs.txt`）：

| 二进制 | run_id | ws_frames | WS 末帧 | DB progress | DB==WS末帧 | 落后 |
|---|---|---:|---:|---:|:--:|---:|
| **before**（逐帧落库） | `…467639_000003` | 305 | 0.304019 | 0.075014 | NO | 0.229005 |
| **before** | `…467583_000004` | 508 | 0.507044 | 0.147039 | NO | 0.360005 |
| **before** | `…468588_000005` | 663 | 0.662011 | 0.210038 | NO | 0.451973 |
| **before** | `…469652_000006` | 915 | 0.914009 | 0.292005 | NO | 0.622004 |
| **after** | `…5128020_000005` | 269 | 0.268037 | 0.268037 | **YES** | 0.000000 |
| **after** | `…5129141_000006` | 305 | 0.304019 | **6.0987e-05** | **NO** | 0.303958 |
| **after** | `…5130511_000007` | 428 | 0.427029 | **6.0987e-05** | **NO** | 0.426968 |
| **after** | `…5131665_000008` | 610 | 0.609014 | **6.0987e-05** | **NO** | 0.608953 |
| **after** | `…5132889_000009` | 642 | 0.641032 | **6.0987e-05** | **NO** | 0.640971 |

**命中率（DB `progress` == 取消瞬间 WS 末帧）：before 0/4，after 1/5。**

**机理（静态可定位）**：`WorkbenchService::cancel()`（`workbench.rs:851`）先置协作标记、随即 `mark_canceled`（status→canceled）；
`Store::update_progress` 的 SQL 是 `UPDATE strategy_run SET progress=$2 WHERE id=$1 AND status='running'`（`storage/workbench.rs:162`）
⇒ 排水补写**调用发生但 0 行受影响**。after 的 1/5 命中 = 排水补写抢在 `mark_canceled` 提交之前完成，是**竞态**（非确定性）。

**判读（诚实边界）**：
1. 派单的验收文字「取消路径**必须**落库最终进度」在**真路径不成立**（after 4/5 不成立）⇒ 本子项判 **FAIL**。
2. **但这不是本批引入的**：before（逐帧落库）**同样不成立**（4/4 落后 0.23–0.62，机理 = 报告任务排空 1001 次写库的**背压** + 同一 `running` 守卫）。两态落后量级相当 ⇒ 本批**未恶化**该缺陷。
3. 本批**真正**保证的是「补写**调用**不被时间窗吞掉」——计数可证（§1.4 账目表 `终止补写=1` 仅在取消路径出现）。这正是 worker §未决项① 的自陈，**我的真路径证据把它从"未决"升级为"已实测确认"**。
4. mock 级断言 `p4b_progress_terminal_frame_persisted_on_cancel` 之所以绿：`MockRunStore::update_progress` **没有** `status='running'` 守卫 ⇒ 该测试**不能**代表 DB 层行为。**这是本报告最重要的发现，请架构师据此裁决（§0.2 结论 A / 阻塞项 F1）。**

## 1.4 断言「失败/取消时是否产生多余写入」——**PASS（无多余写入）**

证据 `25_write_accounting.txt`（恒等式 `frames = writes + throttled`；`writes = 收帧落库 + 终止补写`）：

| run_id | outcome | frames | writes | throttled | 收帧落库 | **终止补写** | 自洽 |
|---|---|---:|---:|---:|---:|---:|:--:|
| `…066639_000000` | succeeded | 733 | 2 | 731 | 2 | 0 | OK |
| `…067310_000001` | succeeded | 1001 | 2 | 999 | 2 | 0 | OK |
| `…068168_000002` | succeeded | 1001 | 3 | 998 | 3 | 0 | OK |
| `…150959_000010` | **failed_chunk_write** | 1001 | 3 | 998 | 3 | **0** | OK |
| `…120523_000004` | canceled | 407 | 2 | 406 | 1 | **1** | OK |
| `…128020_000005` | canceled | 269 | 2 | 268 | 1 | **1** | OK |
| `…129141_000006` | canceled | 305 | 2 | 304 | 1 | **1** | OK |
| `…130511_000007` | canceled | 428 | 2 | 427 | 1 | **1** | OK |
| `…131665_000008` | canceled | 610 | 2 | 609 | 1 | **1** | OK |
| `…132889_000009` | canceled | 642 | 3 | 640 | 2 | **1** | OK |

- **成功 / 失败**：终止补写 **0**（完成帧由 `progress>=1.0` 无条件写在收帧分支内）⇒ **无多余写入**。
- **取消**：终止补写恰好 **1 次**（承载「末帧 <1.0 必须落库」语义，**非冗余**），但该次在 DB 层被守卫丢弃（§1.3c）。
- 任意路径均**未**出现「同一进度值写两次」：`pending` 在每次落库后清空。

## 1.5 断言「顺序不变」——**PASS**（静态 1 条 + 行为 1 条）

**静态**（证据 `02_static_order_and_frames.txt`）：

| 项 | 改动前（250 快照） | 本批 | 判 |
|---|---|---|---|
| `report_task.await` 行号 | L1043 | **L1872** | — |
| `mark_succeeded` 行号 | L1083 | **L1923** | ✅ **1872 < 1923（排水仍在状态迁移之前）** |
| `unbounded_channel` | 1 | 1 | ✅ |
| observer 取消检查 / 帧判定式 | L1008 / L1014 | L1775 / L1781 逐字 | ✅ |
| report 任务 consumer 净 diff | — | 仅「`while let Some((progress,ts))` 展平为 `match RunMsg` + 新增节流/补写/计数」，**`sink.send` 仍在每帧、且仍在 DB 写之前** | ✅ |

**行为**（证据 `32_order_behavioral.txt` + `10_fail_path_realpath.txt`）：
真路径注入分块写失败 ⇒ run 落 `failed` 且 `error` 携带分块写错误。该错误**只能**由 `report_task.await` 的返回值（`chunk_err`）经 outcome 分派传出 ⇒ 若排水被挪到 `mark_succeeded` 之后，此路径会误判 `succeeded`。辅以套件绿证：`t_p4_chunk_write_failure_marks_run_failed_not_succeeded`、`t_p4_success_path_writes_all_chunks_before_result_row`、`t_p4_cooperative_cancel_never_marks_succeeded`（均 ok）。

---

# 2. ② 独立前后对照（真路径）与 worker 表**逐格对照**

**方法**：`before` = `/tmp/eestock-app-before`（把 `PROGRESS_DB_MIN_INTERVAL` 临时设为 **0ms** ⇒ `due` 恒真 = 逐帧落库；其余与交付态逐字节相同，用后已复原）；`after` = `/tmp/eestock-app-after`（交付态）。两二进制 sha256 不同，均本轮 `cargo build -p app` 产出；同夹具（`dual_ma fast=5 slow=20`，`warmup_bars=250`）、同临时库、串行提交。

| bars | 项 | tester before | worker before | 一致? | tester after | worker after | 一致? |
|---|---|---|---|---|---|---|---|
| 733 | 帧数 | 733 | 733 | ✔ **同值** | 733 | 733 | ✔ **同值** |
| 733 | 落库次数 | 733 | 733 | ✔ **同值** | **2** | **2** | ✔ **同值** |
| 733 | 落库耗时 ms | 646.288 | 624.132 | ≈ 同量级（4%） | 2.674 | 2.685 | ≈ 同量级（0%） |
| 733 | permit 持有 ms | 670.029 | 642.757 | ≈ 同量级（4%） | 36.127 | 30.967 | ⚠ 偏差 17% |
| 733 | 落库占 permit % | 96.46 | 97.10 | ≈ 同量级（1%） | 7.40 | 8.67 | ⚠ 偏差 15% |
| 733 | 端到端 dur s | 0.667454 | 0.640918 | ≈ 同量级（4%） | 0.033608 | 0.028636 | ⚠ 偏差 17% |
| 733 | 引擎 ms | 15.705 | 14.279 | ≈ 同量级（10%） | 15.526 | 14.202 | ≈ 同量级（9%） |
| 3865 | 帧数 | 1001 | 1001 | ✔ **同值** | 1001 | 1001 | ✔ **同值** |
| 3865 | 落库次数 | 1001 | 1001 | ✔ **同值** | **2** | **2** | ✔ **同值** |
| 3865 | 落库耗时 ms | 842.379 | 853.790 | ≈ 同量级（1%） | 3.023 | 2.625 | ⚠ 偏差 15% |
| 3865 | permit 持有 ms | 910.761 | 910.276 | ≈ 同量级（0%） | 130.265 | 119.768 | ≈ 同量级（9%） |
| 3865 | 落库占 permit % | 92.49 | 93.79 | ≈ 同量级（1%） | 2.32 | 2.19 | ≈ 同量级（6%） |
| 3865 | 端到端 dur s | 0.907366 | 0.906628 | ≈ 同量级（0%） | 0.127279 | 0.116901 | ≈ 同量级（9%） |
| 3865 | 引擎 ms | 78.832 | 70.410 | ⚠ 偏差 12% | 74.166 | 70.362 | ≈ 同量级（5%） |
| 16397 | 帧数 | 1001 | 1001 | ✔ **同值** | 1001 | 1001 | ✔ **同值** |
| 16397 | 落库次数 | 1001 | 1001 | ✔ **同值** | **3** | **3** | ✔ **同值** |
| 16397 | 落库耗时 ms | 831.874 | 825.748 | ≈ 同量级（1%） | 12.165 | 3.730 | ⚠ 偏差 226% |
| 16397 | permit 持有 ms | 1054.962 | 1035.404 | ≈ 同量级（2%） | 473.636 | 393.244 | ⚠ 偏差 20% |
| 16397 | 落库占 permit % | 78.85 | 79.75 | ≈ 同量级（1%） | 2.57 | 0.95 | ⚠ 偏差 171% |
| 16397 | 端到端 dur s | 1.044150 | 1.025988 | ≈ 同量级（2%） | 0.462931 | 0.384372 | ⚠ 偏差 20% |
| 16397 | 引擎 ms | 309.546 | 298.639 | ≈ 同量级（4%） | 308.778 | 284.291 | ≈ 同量级（9%） |

**对照判读**：
- **强一致（逐格同值）**：帧数、落库次数（3 档全部）；before 的帧数/落库次数亦同值。**即本批的两个"结构性"断言与 worker 完全一致。**
- **弱一致（同量级、非逐格同值）**：所有**时序量**（落库 ms / permit 持有 / dur / 引擎 ms）。我这一侧普遍略高：落库 2.67/3.02/12.17ms vs 2.69/2.63/3.73ms；持有 36/130/474ms vs 31/120/393ms；dur 0.034/0.127/0.463s vs 0.029/0.117/0.384s。
  同批 **before 也整体偏离 worker 2–10%**（引擎 14.3→15.7 / 70.4→78.8 / 298.6→309.5）⇒ **单机时序噪声**（PG fsync 抖动、临时库 autovacuum、并发环境），非实现差异。
- **结论方向逐档一致**：落库从 permit 主导项（96.5% / 92.5% / 78.9%）降到个位/十分位（7.4% / 2.3% / 2.6%）；dur 降 55–95%。
- 我**未采信** worker 的 before 数字，全部为自跑；`coder/evidence/adr024_p2c_p4b/` 目录**不存在**（worker 指出的实际基线目录为 `adr024_p2c_p4b`）一事，与我的自跑结果无冲突。

---

# 3. ③ 反向证据

## R1 —— 关闭时间窗节流（退回逐帧落库）⇒「落库次数下降」断言必红

**操作**：`PROGRESS_DB_MIN_INTERVAL` 由 `Duration::from_millis(250)` 临时改为 `0`（`due` 恒真 ⇒ 逐帧落库）。证据 `12_reverse_R1_throttle_off_red.txt`：

```
thread 'p4b_progress_db_time_window_throttle_reduces_writes' panicked at tests/workbench.rs:1504:
时间窗节流应显著减少落库：writes=1001 produced=1001（相等 ⇒ 节流未生效）
test result: FAILED. 0 passed; 1 failed; …      EXIT=101
```
- **红**成立；且同测试中**帧数断言（`produced == 1_001`）仍通过** ⇒ 断言是**判别性**的（只对落库次数敏感，不受帧数干扰）。
- **复原**：sha256 回到 `2495e9cb7e022eff…`，`git diff -- crates/application/src/workbench.rs` = 0 行，无 `TESTER-R1-REVERSE` 残留。

## R2 —— `GUARD_CONFIRM_BARS` 改回 `200_000` ⇒ 向量绑定断言必红

证据 `15_reverse_R2_confirm_bars_red.txt`：

```
# coder 向量绑定（resource_guard_contract_vectors）
---- confirm_bars_matches_contract_vector stdout ----
assertion `left == right` failed: GUARD_CONFIRM_BARS(200000) != contract-vectors.json `resource_guard.confirm_bars`(500000)
  left: 200000   right: 500000
---- guard_bars_runtime_thresholds_match_contract_vector stdout ----
confirm_bars - 1 = 499999 必须放行（无护栏）
test result: FAILED. 1 passed; 2 failed;          EXIT=101

# tester 重钉后资产（tester_p5_indep ④）
499_999 < 500_000 ⇒ 放行: [resource_guard] 预估 499999 根 bar（≈313.3 秒）达到二次确认阈值 200000 根…
test result: FAILED. 0 passed; 1 failed;          EXIT=101
```
- **双向绑定成立**：常量改 ⇒ 测试红；向量改 ⇒ 测试亦红（后者由 worker `01_red` 证明，我复现为"常量 200000 vs 向量 500000"）。
- **复原**：`error.rs` sha256 回到 `5d4af7047788684b…`，`git diff` = 0 行，无残留标记；复原后两组测试**复绿**（`3 passed` / `1 passed`）。

（第 3 次反向 = 因果验证，见 §5.3，同样逐字节复原。）

---

# 4. ④ 阈值与契约

## 4.1 常量与向量绑定

```
crates/application/src/error.rs:142: pub const MAX_BARS_GUARD: usize = 2_000_000;
crates/application/src/error.rs:150: pub const GUARD_CONFIRM_BARS: usize = 500_000;
design/16-backtest-scalability/contract-vectors.json（工作区）:
  span_limit_semantics.resource_guard = {…, "max_bars_guard": 2000000, "confirm_bars": 500000, "note": "…"}
```
`cargo test -p application --test resource_guard_contract_vectors`：**3 passed / 0 failed**
（`max_bars_guard_matches_contract_vector`、`confirm_bars_matches_contract_vector`、`guard_bars_runtime_thresholds_match_contract_vector`）。
⚠ 该 3 条绿的前提是**工作区**的 contract-vectors.json；index 版缺键 ⇒ 见 §6.4。

## 4.2 边界行为（真路径 web 层 + 应用层，实测输出）

证据 `13_threshold_contract_and_repin.txt`（`t_p5_resource_guard_thresholds_and_confirm` 重钉后绿，`--nocapture`）：

| 输入 bars | confirm | 期望 | 实测 |
|---:|---|---|---|
| 499_999 | false | 放行 | ✅ 放行（run 提交成功） |
| **500_000** | false | 400 `resource_guard` | ✅ `code=resource_guard`，`detail={"confirm_bars":500000,"limit_bars":2000000,"requested_bars":500000,"confirmable":true,"estimated_secs":313.35,…}` |
| 500_000 | **true** | 放行 | ✅ 放行（`config.estimated_bars=500000`） |
| 2_000_001 | true | **硬拒** | ✅ `code=resource_guard`，`confirmable=false`，message「预估 2000001 根 bar 超过硬上界 2000000 根（资源护栏；不可放行）」 |
| HTTP：518880 M1 全历史（≈77 万 bar） | false | 400（`detail.confirm_bars=500000`、`requested_bars ≥ 500000`） | ✅ `t_p5_http_structured_error_shape` ok |
| 518880 M1 2021-01→2026-01（**292,092 bar**） | false | **新契约下不再触发** | ✅ 201 放行（旧契约下会 400 ⇒ 见 §5.3 F3） |

## 4.3 tester 资产重钉（`crates/web/tests/tester_p5_indep.rs`，**本批唯一被授权改动的文件**）

改动前后 diff（12 处，全部为 `200_000 ⇒ 500_000` 与 `199_999 ⇒ 499_999` 的契约重钉）：

```
349: assert_eq!(application::error::GUARD_CONFIRM_BARS, 200_000) → 500_000
508: 文档「≥200,000」→「≥500,000」
526-528: 注释 + mk(199_999).expect("199_999 < 200_000 ⇒ 放行") → mk(499_999) / "499_999 < 500_000 ⇒ 放行"
532-533: mk(200_000) + "≥200_000 且无 confirm ⇒ 必须 400" → mk(500_000) / "≥500_000 …"
538-539: detail.confirm_bars / requested_bars json!(200_000) → json!(500_000)
548: mk(200_000) confirm=true ⇒ 放行 → mk(500_000)
581: estimate_secs(200_000) → estimate_secs(500_000)（符号式，符号不变）
626-627: HTTP detail.confirm_bars 200_000 → 500_000；requested_bars ≥ 200_000 → ≥ 500_000
```

| 相位 | 输出 | 结果 |
|---|---|---|
| **重钉前**（旧 200_000 硬断言 vs 新契约） | `14_repin_before_red.txt`：`panicked at tester_p5_indep.rs:533: ≥200_000 且无 confirm ⇒ 必须 400` | **0 passed; 1 failed**（必红） |
| **重钉后** | `13_threshold_contract_and_repin.txt`：`t_p5_resource_guard_thresholds_and_confirm ... ok`；整文件 `13 passed; 0 failed` | ✅ 全绿 |
| **重钉后 + 常量临时回 200_000** | `15_…_red.txt`：`499_999 < 500_000 ⇒ 放行: [resource_guard] …阈值 200000…` | **0 passed; 1 failed**（复红，证明重钉后的断言与常量**双向绑定**） |

sha256：重钉前 `f463cc653f7adc63…` → 重钉后 `2ea7a9a6b530a6e0…`（该文件**未入 index**，属 tester 自有资产）。

---

# 5. ⑤ 回归

## 5.1 后端（**全新临时库** `tmp_p4bviv2_1789725410`，避免夹具残留）

`cargo test -p application -p web --no-fail-fast` → **349 passed / 1 failed / 0 ignored，37 个测试目标**（EXIT=101）：

| # | target | passed | failed | | # | target | passed | failed |
|---|---|---:|---:|---|---|---|---:|---:|
| 1 | `application` (lib) | 28 | 0 | | 20 | `api_settings` | 6 | 0 |
| 2 | `adr024_p2b_tryrun` | 2 | 0 | | 21 | `api_strategies` | 9 | 0 |
| 3 | `backtest_periods_ssot` | 6 | 0 | | 22 | `api_workbench` | 9 | 0 |
| 4 | `resource_guard_contract_vectors` | 3 | 0 | | 23 | `multi_period_contract_vectors` | 4 | 0 |
| 5 | `simlive` | 55 | 0 | | 24 | `multi_period_pane_budget` | 8 | 0 |
| 6 | `strategy` | 41 | 0 | | 25 | `orphan_detect_endpoint_red` | 4 | 0 |
| 7 | `tester_p2b_tryrun_indep` | 3 | 0 | | 26 | `orphan_detect_sql_constant_red` | 2 | 0 |
| 8 | **`workbench`** | **43** | 0 | | 27-29 | `period30m_*`（3 目标） | 11 | 0 |
| 9 | `web` (lib) | 49 | 0 | | 30 | `tester_p4_endpoints_indep` | 3 | 0 |
| 10 | `adr024_structured_errors` | 2 | 0 | | 31 | `tester_p4_writepath_indep` | 6 | 0 |
| 11 | `adr024_workbench_period_ssot` | 4 | 0 | | 32 | **`tester_p5_indep`** | **13** | 0 |
| 12 | `api_admin` | 3 | 0 | | 33 | **`tester_p5rect_verify`** ❌ | 3 | **1** |
| 13 | `api_alerts` | 3 | 0 | | 34 | `tester_p6_fills_indep` | 4 | 0 |
| 14 | `api_favorites` | 2 | 0 | | 35-37 | `ws_poller`（3 目标） | 1 | 0 |
| 15-19 | `api_kline_period`/`api_ma_config`/`api_multi_period_config`/`api_quality`/`api_rest` | 22 | 0 | | | **合计** | **349** | **1** |

- P4b 专测 4 条**全绿**：`p4b_run_summary_counters_are_self_consistent`、`p4b_progress_db_time_window_throttle_reduces_writes`、`p4b_progress_terminal_frame_persisted_on_chunk_write_failure`、`p4b_progress_terminal_frame_persisted_on_cancel`（证据 `28_p4b_unit_tests_in_suite.txt`）。
- 无 crash / 无 panic 崩溃 / **core dump 0**。

## 5.2 首轮（复用同一临时库）的 2 红 → 已定位为**夹具残留**，非产品缺陷

首轮输出 `18_regression_application_web.txt`（`--no-fail-fast` 版 `18b…`）里另有 `orphan_detect_endpoint_red::r1_orphan_endpoint_exists_and_reports_zero_on_clean_db` 红：
`left: 2, right: 0`（该库有 2 行孤儿 cagg：`kline_accurate_1w` 等 1 行 + 1 行）。原因是**同库被本会话的 run/测试反复使用**，测试夹具符号被删而 cagg 行留存（ADR-023 E6a 已知的测试隔离债）。
**换全新库复跑（19 号）该测试转绿（4/4）** ⇒ 与 P4b 无关。

## 5.3 唯一红：`tester_p5rect_verify::t_n1_http_every_400_is_structured_object`（**阈值漂移，非回归**）

```
[runs/resource_guard(confirm=false)] 期望 400，实得 201；
  body: …"estimated_bars":292092… "symbol":"518880","period":"M1",
        "requested_from":"2021-01-01…","requested_to":"2026-01-01…" …
```
**因果证明**（证据 `24_p5rect_failure_attribution.txt`）：把 `GUARD_CONFIRM_BARS` 临时改回 `200_000` ⇒ 同文件 **4 passed / 0 failed**；复原 500_000 ⇒ 复红 1 例。⇒ 100% 由 confirm 阈值上移引起（292,092 < 500,000）。

**未修（授权边界）**：派单限定「`crates/web/tests/tester_p5_indep.rs` 是你唯一被授权改的文件」，故本轮**未触碰** `tester_p5rect_verify.rs`（sha256 `18119a46…` 未变）。
建议修法（二选一）：① 该表项期望由 `resource_guard` 改为 `201`/放行，并另加一个 ≥50 万 bar 的 `resource_guard` 表项；② 把该行区间换成 518880 M1 全历史（≈77 万 bar）。
同类影响点：同文件 L483-485（`test-run` 路径，同一区间）与 L556-584（`confirm=true` ⇒ 201/200，语义变为"本就无需确认"，仍绿）。

## 5.4 其它门禁

| 检查 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 全目标编译 | `cargo check --all-targets` | **EXIT=0**（仅既有 warning） | `21_cargo_check_all_targets.txt` |
| 文学式一致性 | `./scripts/check-tangle.sh` | **✅ design 与生成物一致（沙箱重生成 + 逐字节比对），EXIT=0** | `20_check_tangle.txt` |
| 前端用例 | `npx vitest run` | **94 files / 901 tests passed，EXIT=0**（基线 252 轮 90/864 ⇒ **不减**） | `22_frontend_vitest.txt` |
| 前端类型 | `npx tsc -b` | **EXIT=0** | `23_frontend_tsc.txt` |
| P2 引擎面 | `cargo test -p backtest -p strategy-core --no-fail-fast` | 31 + 33 + 25(+1 ignored) + 6 + 7 + 1 + 3，**0 failed** | `27_p0_p6_surface.txt` |

## 5.5 P0–P6 点名面未回退（逐面取证）

| 面 | 承载测试（本轮结果） |
|---|---|
| M30 / period SSOT | `backtest_periods_ssot` 6/6、`adr024_workbench_period_ssot` 4/4、`multi_period_contract_vectors` 4/4、`period30m_api_contract` 2/2、`period30m_d2_multiperiod_red` 6/6、`period30m_scope_guard` 3/3 |
| 引擎线性化 / 会话等价（P2） | `backtest` 31/31、`strategy-core` 33+25+6+7+1+3（`session`/`session_alloc`/`engine` 全绿） |
| `/fills` + `recorded`（P6） | `tester_p6_fills_indep` 4/4、`tester_p4_endpoints_indep` 3/3 |
| 分块写 / 先于 `mark_succeeded`（P4/D8） | `tester_p4_writepath_indep` 6/6、`workbench` 43/43 |
| 结构化错误（P5） | `adr024_structured_errors` 2/2、`tester_p5_indep::t_p5_structured_error_serializes_as_object` + `t_p5_http_structured_error_shape` ok |
| 区间收缩（P5-rect D3） | `tester_p5_indep` ② 全绿（`t_p5_clamp_left_right_both_and_exact`、`t_p5_exec_time_clamp_uses_real_first_last_bar`）、`tester_p5rect_verify::t_n3_long_d1_accepted_and_no_intersection_range_empty` ok |
| `periods.ts`（前端 SSOT） | 前端 94 files / **901 tests** 全绿（含 `src/features/backtest/periods.test.ts` 3 tests） |

---

# 6. ⑥ 卫生与范围

## 6.1 临时库 / 进程 / 残留（收尾后回读，证据 `31_teardown.txt`）

| 项 | 结果 |
|---|---|
| 本批临时库 | `tmp_p4bviv_1789724951`（真路径前后对照 + 终态三路径 + 全量回归首轮）、`tmp_p4bviv2_1789725410`（全量回归**干净库**复跑） |
| DROP | 两库均 `DROP DATABASE … WITH (FORCE)` → `DROP DATABASE` |
| **回读库清单** | `eestock, postgres, template0, template1`；`SELECT count(*) … datname LIKE 'tmp_%'` = **0** |
| app 进程 | **0**（`/tmp/eestock-app-{before,after}` 已删除） |
| core dump | **0**（`30` 号 B5 报的 1 项经复核为 `web/node_modules/is-core-module/core.json` 假阳性） |
| 本批 tester 资产 | `tester/evidence/255_adr024_p4b_fix_verify/`（33 输出 + `probe_255.sh` + `probe_255_ws.mjs`）、本报告 |

## 6.2 活库保护（**严禁对活库应用 0027**）

- 活库 `eestock`：`to_regclass('public.strategy_run_bars')` = **NULL** ⇒ **0027 未应用**；
  `strategy_run` 最新 `created_at = 2026-09-13 06:59:56Z`（早于本会话 2026-09-18T09:48Z）⇒ **本批对活库零写**；`symbols` = 44（未变）。
- 诚实披露：我**误启动过 2 次** `/tmp/eestock-app-{before}` **未带 `--config`** ⇒ 读 `./config/app.toml`（指向活库）→
  `storage::migrate_check::verify_schema`（纯 SELECT）报「缺失关系 `["strategy_run_bars"]`」→ `anyhow` 返回、进程立即退出。
  **未建表 / 未应用迁移 / 未写行**，且该失败恰好**反证**活库未上 0027（证据 `30_hygiene_pre_teardown.txt` 及其"更正"段）。

## 6.3 范围分类（证据 `29_scope_classification.txt`）

- `git diff --cached --name-only` = **303 个文件**（= ADR-024 P0–P6 全部批次的 index 快照）；工作区未暂存改动 5 个（`design/16-*`×2、`design/99-decisions-log.md`、`design/01-…/ADR-023-*.md`、`docker-compose.yml`）。
- **本批（P4b 修复）实际触碰**：
  `crates/application/src/workbench.rs`、`crates/application/src/error.rs`、
  `crates/application/tests/workbench.rs`、`crates/application/tests/resource_guard_contract_vectors.rs`、
  `coder/report/adr024_p4b_fix_and_confirm_threshold.md`、`coder/evidence/adr024_p4b_fix/*`、
  `design/16-backtest-scalability/contract-vectors.json`（**工作区改动 = 架构师**）。
- **越界路径检查**：`crates/backtest|strategy-core|storage|domain|mcp|simlive|strategy-runtime`、`migrations/`、`docker-compose.yml` 的 staged 内容均**属前序批次**（mtime ≤ 16:56，本批窗口 17:30–17:47 内无其一）；本批**新增 0 条**越界路径。
- **`design/16-backtest-scalability/**` 仅架构师改动**：staged 6 个文件为本批之前版本；唯一 P4b 相关改动在**工作区**（`contract-vectors.json` 加 `max_bars_guard/confirm_bars`、`02-spec.md` 加 D3 收窄段）—— 内容与架构师 D1 修订一致，非 worker 手笔（worker 报告 §6 明示未 add/未改）。
- **`git add` 次数：0**（index 文件数本轮开始/结束均为 303；工作区唯一新增 = 我的证据目录与报告）。

## 6.4 🟥 阻塞项 B1：index 与工作区**不一致**（证据 `33_index_vs_worktree_consistency.txt`）

```
$ git show :design/16-backtest-scalability/contract-vectors.json | grep -c max_bars_guard   → 0
$ grep -c max_bars_guard design/16-backtest-scalability/contract-vectors.json               → 1
```

| 版本 | `resource_guard` |
|---|---|
| **index** | `{"hard_reject":false,"requires_confirmation":true,"code":"resource_guard"}`（**无** `max_bars_guard`/`confirm_bars`） |
| **工作区**（架构师未 add） | `{…, "max_bars_guard":2000000, "confirm_bars":500000, "note":"…"}` |

而 `crates/application/tests/resource_guard_contract_vectors.rs` **已入 index**，其 `guard_field()` 在键缺失时
`panic!("contract-vectors.json 缺 span_limit_semantics.resource_guard.{key}（整数）")`。
⇒ **只按 index 检出/提交**（不带上工作区的 design/16 改动）⇒ **3 条向量绑定断言全部 panic**。
**处置**：结项时把 `design/16-backtest-scalability/contract-vectors.json`（+ `02-spec.md`）与 index 一并 add/commit，交付物 = index **+** 该工作区改动。

---

# 7. 未过项与建议（按优先级）

| 优先级 | 项 | 建议 |
|---|---|---|
| **P0（冻结前必修）** | F2 index↔工作区不一致 | `git add design/16-backtest-scalability/contract-vectors.json design/16-backtest-scalability/02-spec.md` |
| **P0（口径裁决）** | F1 取消路径 DB 终态 | 架构师二选一：接受"写调用成立"口径（改派单验收文字）⇒ ①可判 PASS；或另立小批让取消终态在 DB 可见 |
| **P1（测试资产）** | F3 `tester_p5rect_verify` 1 红 | tester 复验轮重钉该表项（换 ≥50 万 bar 区间或改期望 201）。本轮**未改**（授权边界） |
| **P2（版本级）** | ✅ 已完成（本轮） | `crates/web/tests/tester_p5_indep.rs` 已重钉 500_000（12 处），红→绿→反向红三相位齐备 |
| **P2** | `web/src/api/mock.ts` 仍 `200_000`（dev-only） | 前端 owner 裁定是否同步（不改不影响生产；worker 仍未决项②） |
| **P3** | `RUN_FIXED_SECS = 0.85` 需重标定 | 节流后每 run 固定写库从 1003 降到 2–5 ⇒ ADR D1 的「P4b 之后重做标定」 |
| **P3** | 单机时序噪声 | 若后续轮要求逐格可复现，需固定负载/关 autovacuum/多轮取中位 |

---

# 8. 证据清单（`tester/evidence/255_adr024_p4b_fix_verify/`）

| 文件 | 内容 |
|---|---|
| `00_hygiene_baseline.txt` | 会话起点：HEAD / git status 计数 / 工作区改动 / 库清单 |
| `01_static_report_task_before_after.txt` | report 任务 consumer 改动前（250 轮交付态快照）vs 本批 + diff |
| `02_static_order_and_frames.txt` | 帧判定式 / 取消检查 / `sink.send` / `unbounded_channel` / 排水顺序 行号核对 |
| `03_before_binary_constant_patch.txt` | before 二进制构造（常量 250→0）+ **逐字节复原**证明 |
| `04_app_configs.txt` | before/after 第二实例配置（临时库 + 独立端口） |
| `05_before_probe.txt` / `06_after_probe.txt` | **自跑**真路径 3 档 before / after 原始汇总 |
| `07_terminal_paths_realpath.txt` | 真路径 完成 / 取消（含 WS 帧捕获） |
| `08_cancel_race_5runs.txt` | 真路径取消 5 轮（不同延迟）—— 竞态与 DB 落后 |
| `09_after_log_all_runs.txt` | after 全部 run 的 `p4b.run_summary` 字段表 |
| `10_fail_path_realpath.txt` | **注入分块写失败**的真路径失败路径 + 约束注/解 |
| `11_fail_path_summary.txt` | 失败 run 的计数与 DB 行 |
| `12_reverse_R1_throttle_off_red.txt` | R1 反向（关节流）红 + 复原 |
| `13_threshold_contract_and_repin.txt` | 常量/向量/边界四点 + tester 资产重钉后绿 |
| `14_repin_before_red.txt` | 重钉**前**必红 |
| `15_reverse_R2_confirm_bars_red.txt` | R2 反向（常量回 200000）红 + 复原后复绿 |
| `16_cancel_before_vs_after.txt` | 取消路径 **before vs after** DB↔WS 逐轮对照（本文 §1.3c 表） |
| `17_before_cancel_log_summary.txt` | before 取消 run 的 `writes == frames` 台账 |
| `18_regression_application_web.txt` / `18b_…_nofailfast.txt` | 首轮回归（复用库，2 红含夹具残留） |
| `19_regression_freshdb.txt` / `19b_freshdb_per_target.txt` | **全新库**全量回归 349/1，逐目标 |
| `20_check_tangle.txt` / `21_cargo_check_all_targets.txt` | 门禁 |
| `22_frontend_vitest.txt` / `23_frontend_tsc.txt` | 前端 |
| `24_p5rect_failure_attribution.txt` | 唯一红例的**因果证明** + 复原 |
| `25_write_accounting.txt` | 写入账目自洽 + **多余写入**检查 |
| `26_before_after_vs_worker.txt` | 与 worker 表**逐格对照** |
| `27_p0_p6_surface.txt` / `28_p4b_unit_tests_in_suite.txt` | P0–P6 点名面 + P4b 专测 |
| `29_scope_classification.txt` | 范围分类 / 越界检查 / tester 资产 sha256 |
| `30_hygiene_pre_teardown.txt`（含"更正"段） | 活库保护 / 误启动披露 / core 假阳性更正 |
| `31_teardown.txt` | DROP 临时库 + 回读 + 复原确认 |
| `32_order_behavioral.txt` | 「顺序不变」的行为证据 + UPDATE 计数口径 |
| `33_index_vs_worktree_consistency.txt` | **阻塞项 B1**：index 与工作区不一致 |
| `probe_255.sh` / `probe_255_ws.mjs` | tester 自写真路径探针（HTTP）与 WS 帧捕获探针 |
