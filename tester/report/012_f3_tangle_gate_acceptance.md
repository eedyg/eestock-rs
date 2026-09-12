# 012 — F3 独立验收报告：tangle 门禁硬化 + 漂移修复

> 报告自身路径：`eestock-rs/tester/report/012_f3_tangle_gate_acceptance.md`
> 原始证据目录：`eestock-rs/tester/evidence/012_f3_tangle_gate/`
> 被验对象（工作区未 stage）：`scripts/check-tangle.sh`（重写）、新增 `scripts/stitch.sh` /
> `scripts/lib/entangled_patterns.sh` / `scripts/tests/{test_check_tangle.sh,test_stitch.sh}`、
> `design/06-web/{01-dashboard,10-simlive}.md`、`README.md`、
> `design/01-architecture/adr/ADR-018-tangle-gate-hardening.md`；实施报告 `coder/report/146_tangle_gate_hardening.md`
> 验收日期：2026-09-12 · 仓 HEAD `44adaf9` · entangled 2.4.3 · bash 5 / GNU coreutils / Linux
> 角色：Tester（只验证、不改实现；**未 git add / 未 commit / 未改任何被验文件**）

---

## 0. 结论

**可合并（建议合并前修一处文档数字，非阻塞）。**

9 项验收口径逐条通过，核心判据（原发场景由假绿变硬失败、门禁零副作用、TSX 零回退、
文档回写不越界、CI 可复现、stitch 拒绝回写、独立复核 drift=0、工程回归绿）均有原始输出。
唯一发现为**文档数字轻微不精确**（README/ADR 的 `-3583 行` 实测为删除 3579 行；实施报告
`-3378/-203` 实测为 `-3377/-202`）与**实施报告一处旧扫描计数未复现**（§4.5 修前
`generated_compared=139`，实测 151）——均不影响行为与结论。

---

## 1. 原发场景必须变红（本次 F3 成败判据）—— ✅ 通过

**隔离副本**：`/tmp/f3_accept/copy_clean`（rsync 自真实仓，含 `.entangled` DB）。
构造：先把 F3 change-set 提交成基线（使 `git diff` 干净），再**只手改生成物
`web/src/layouts/DashboardGrid.tsx`（块内加一行）、文档侧 `design/06-web/01-dashboard.md` 一字未动，
并提交**（= 复刻提交 `4d55f17` 的事故形态）。旧门禁安装为 pre-commit hook，提交时打印 ✅ 放行。

两版脚本 sha：
- 旧版 = `git show HEAD:scripts/check-tangle.sh` → `d6397313c984…`
- 新版 = 工作区 `scripts/check-tangle.sh` → `dc3be2c5b27c…`

**① 旧版门禁（同一状态）——假绿 `rc=0`：**

```
======= [1] OLD gate (sha d6397313c984) =======
[check-tangle] entangled tangle ...
[19:55:19] INFO     Welcome to Entangled v2.4.3!
           INFO     Nothing to be done.
[check-tangle] ✅ tangle 后无 diff，design 与生成物一致。
OLD_GATE_RC=0
```

**② 新版门禁（同一状态）——硬失败 `rc=1` + 可操作提示：**

```
======= [2] NEW gate (sha dc3be2c5b27c) =======
[check-tangle] ❌ entangled dry-run 报告冲突/未托管（生成物与 design/ 文档失同步）：
WARNING `web/src/layouts/DashboardGrid.tsx` not managed by Entangled INFO nothing is done

可操作下一步（二选一，勿用 --force 变绿）：
  • 改动在 design/ 文档侧（文档已改、生成物未重新生成）→ 运行： entangled tangle
  • 改动在代码侧（手改了生成物、文档未同步）        → 运行： ./scripts/stitch.sh
    （scripts/stitch.sh = 沙箱 scoped 回写 + round-trip 校验；校验不通过拒绝回写）
禁止：`entangled tangle --force` —— 它会用文档旧内容覆盖实现，等于回退已验收成果
（ADR-018 D-F3-6）；分不清方向时，先看下面列出的文件属于哪一侧。
NEW_GATE_RC=1
```

证据：`evidence/012_f3_tangle_gate/{incident_state.txt,incident_old_gate.out,incident_new_gate.out,old_hook_commit.out}`。

**补充（更严苛的 CI 形态）**：干净 `git clone`（HEAD `44adaf9`，无 `.entangled`）——旧门禁同样假绿：

```
### (c1) clean HEAD clone (pre-fix state), OLD gate
... INFO create ...（大量 create，随后）
   WARNING  `web/src/layouts/DashboardGrid.tsx` not managed by Entangled
   WARNING  `web/src/layouts/SimLiveGrid.tsx` not managed by Entangled
   ERROR    conflicts found, breaking off (use `--force` to run anyway)
[check-tangle] ✅ tangle 后无 diff，design 与生成物一致。
OLD_GATE_RC=0
### (c2) NEW gate on the same clean clone
[check-tangle] ❌ ... WARNING `web/src/layouts/DashboardGrid.tsx` not managed by Entangled
                     WARNING `web/src/layouts/SimLiveGrid.tsx` not managed by Entangled ...
NEW_GATE_RC=1
```
证据：`evidence/…/ci_headclone_old_gate.out`、`ci_headclone_new_gate.out`。

> 注（旧门禁假绿的精确条件）：手改必须是**已提交**（或至少 indexed）才假绿；若手改停留在
> unstaged，旧门禁的 `git diff --quiet` 会看到它而变红。原发事故 `4d55f17` 正是"已提交的手改生成物"。

---

## 2. 门禁零副作用 —— ✅ 通过

真实仓 `eestock-rs`：运行新门禁前后，**9563 个文件（排除 `.git`/`target`/`node_modules` 及本报告自身证据目录）
逐字节 sha256 完全一致**；`git status --short`、`git diff` 输出逐字节一致；`.entangled/` 未变化
（filedb.json mtime 停在会话前的 `Sep 12 20:47`）。

```
files compared (excl. tester evidence dir): 9563
FINAL_TREE_IDENTICAL_TO_BASELINE
--- git diff --cached (must be empty) ---
(empty above = nothing staged)
```

**"不创建 `.entangled/`"**：在**无 `.entangled` 的干净副本**（`/tmp/f3_accept/clean_nodb`，rsync 时排除 `.entangled`）运行新门禁：

```
### (a) clean no-DB copy, CURRENT (fixed) state -> expect PASS
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
CLEAN_CURRENT_RC=0
=== did gate create .entangled in clean copy? ===
ls: cannot access '/tmp/f3_accept/clean_nodb/.entangled': No such file or directory
```

**反向对照（旧门禁会改工作区）**：仅改文档侧（`maWindows += 60`，生成物未重新 tangle）时——

```
--- [OLD gate] ---
[check-tangle] entangled tangle ...
           INFO     write `web/src/layouts/DashboardGrid.tsx`      ← 旧门禁在真实工作区落盘
[check-tangle] ❌ tangle 产生了差异 ...
OLD_RC=1
--- TSX sha AFTER old gate ---
385fc3545a15041054b5317a86f9ae7e687de517e4afa076cda031d8aa2810fc   ← 9fda9247… 被改写（静默回退）
--- [NEW gate] on same state ---
[check-tangle] ❌ entangled dry-run 报告冲突/未托管 ...
NEW_RC=1
--- TSX sha AFTER new gate ---
9fda9247fb28b16f1e83ce49479ad4e27eb73c54135bbb5abc9e44d7648a790c   ← 逐字节不变
```

证据：`evidence/…/{baseline_*,after_new_gate_*,final_realrepo_sideeffect.txt,ci_clean_nodb_current.out,docside_old_vs_new.out}`。

---

## 3. TSX 零回退 —— ✅ 通过

```
worktree:
9fda9247fb28b16f1e83ce49479ad4e27eb73c54135bbb5abc9e44d7648a790c  web/src/layouts/DashboardGrid.tsx
f93402fbed5ed2647b8a949fd45b87ad789ca48d735b8c6df5b900470d143d35  web/src/layouts/SimLiveGrid.tsx
HEAD(44adaf9):
9fda9247fb28b16f1e83ce49479ad4e27eb73c54135bbb5abc9e44d7648a790c  web/src/layouts/DashboardGrid.tsx
f93402fbed5ed2647b8a949fd45b87ad789ca48d735b8c6df5b900470d143d35  web/src/layouts/SimLiveGrid.tsx
### git status for TSX (must be empty):
（空）
```

与报告声称的 `9fda9247…`/`f93402fb…` 一致；工作区 = HEAD（因 F3 change-set 未提交，HEAD 即修复前状态），
即**与修复前工作区逐字节一致**，且 `git status` 对 `web/src/layouts/` 无任何改动。
证据：`evidence/…/tsx_hashes.txt`。

---

## 4. 文档回写范围（hunk 全部落在 L3 代码块内）—— ✅ 通过

独立检查器 `evidence/…/check_hunks_in_codeblock.py`（自身实现，非复用被验脚本）：对每个文件取
`HEAD:` 版与工作区版做 `difflib` opcode，把每条增/删行映射到围栏代码块归属，断言块外零改动。

```
### Item 4: doc hunks must all be inside fenced code blocks (L3)
design/06-web/01-dashboard.md: changed_lines=27 outside_block=0
design/06-web/10-simlive.md: changed_lines=33 outside_block=0
RC=0
```

围栏布局佐证：`01-dashboard.md` L3 TSX 块 = 行 209–300；`10-simlive.md` = 行 36–162，
全部改动行落在其中。散文/表格/契约零改动。
证据：`evidence/…/{doc_hunks_in_block.out,check_hunks_in_codeblock.py}`。

---

## 5. CI 可复现 —— ✅ 通过

**(a)** 无 `.entangled` 干净副本人（当前修复态）→ 通过，且不创建 `.entangled/`（见 §2）。

**(b)** 同一"手改生成物"构造在两处得**逐字节一致的失败输出**：
`/tmp/f3_accept/clean_nodb`（**无** DB）× `/tmp/f3_accept/with_db`（**有** DB），对同一处
`DashboardGrid.tsx` 块内加同一行：

```
### (b1) clean NO-DB copy + hand-edit ...  CLEAN_NO_DB_RC=1
### (b2) has-DB copy + same hand-edit ...  WITH_DB_RC=1
### compare the two failure outputs (normalise headings) ###
CONSISTENT_FAILURE_OUTPUT
```

（两版输出 `diff` 为空，均报同一文件 `not managed by Entangled` + 同样提示。）
证据：`evidence/…/{ci_clean_nodb_handedit.out,ci_with_db_handedit.out}`。

**(c)** 干净 HEAD clone 两版对照见 §1 补充。

---

## 6. 自测三态 + stitch 负样例 —— ✅ 通过

**可复跑 / 确定性**（各连跑两次，输出 `diff` 为空）：

```
check_tangle run1/2 tail: ===== test_check_tangle: PASS=38 FAIL=0 =====（两次）
stitch      run1/2 tail: ===== test_stitch: PASS=19 FAIL=0 =====（两次）
diff run1 vs run2: IDENTICAL
```

失败态覆盖：`silent-drift`(原例)/`conflict`/`empty-db-drift`/`doc-side-drift` 均断言红 + 文件指针 +
两条出路 + 工作区指纹不变；通过态含 `clean-db`/`clean-no-db`/`stale-db`/`hook-symlink`。

**门禁自身确定性**：真实仓连跑两次输出逐字节一致（`OUTPUTS_IDENTICAL`）。

**stitch 负样例（我自己构造，独立于 `test_stitch.sh` T3）**：fixture 中
`web/src/layouts/Grid.tsx` 无 tangle 标记且含一行手工内容 → 文档无法重新生成它 → round-trip 必失败：

```
### run: bash stitch.sh  (default scoped)
STITCH_RC=1
[stitch] round-trip 校验中（全新沙箱：回写后的文档能否重新生成出仓库中的生成物）...
[stitch] ❌ round-trip 校验失败：回写后的文档无法重新生成出仓库中的生成物；**已拒绝回写**（仓库未被修改）。
  - 不一致: web/src/layouts/Grid.tsx
--- doc  unchanged: YES
--- code unchanged: YES
--- git status: （空）
```

证据：`evidence/…/{selftest_*,stitch_negative_probe.out,gate_determinism.txt}`。

---

## 7. 全仓漂移独立复核 —— ✅ 通过（脚本未自证）

**我自己的扫描器** `evidence/…/independent_drift_scan.py`（独立实现：解析 watch_list + 收集
`file=` 目标 → 拷入 `mktemp` 沙箱 → 清 DB → `tangle -f` → 全量逐字节比对），不调用
`scripts/check-tangle.sh`：

```
=== POST-FIX (real repo working tree) ===
roots=['design'] inputs=59 generated_compared=151 drift=0 missing=0

=== PRE-FIX (git archive 44adaf9, before doc rewrite) ===
roots=['design'] inputs=58 generated_compared=151 drift=2 missing=0
  DRIFT: web/src/layouts/DashboardGrid.tsx
  DRIFT: web/src/layouts/SimLiveGrid.tsx
```

→ 当前 `drift=0 / missing=0` 独立成立；修复前确为**恰好 2 个漂移 = 两份 TSX**（与报告一致）。
两态的 distinct 声明目标集合均为 145，完全一致（`TARGET SETS IDENTICAL`）。
证据：`evidence/…/{independent_scan_postfix.out,independent_scan_prefix.out,independent_drift_scan.py}`。

> 计数说明：报告 §4.5 称修前 `generated_compared=139`；我的独立扫描器在修前/修后**均为 151**
> （该计数含沙箱内被拷贝的 `entangled.toml` 及 `design/…/preview/*` 非 `.md` 资产）。**drift=2 的
> 实质结论复现**；139 这一旧数字未复现（见 §10 残余）。

---

## 8. 工程回归 —— ✅ 通过

```
$ cargo check --workspace --all-targets
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.46s
cargo check rc=0    （0 warning）
```

**门禁在干净 HEAD 上不再假绿**：干净 clone（HEAD `44adaf9`）→ 新版 ❌ `rc=1`（旧版 ✅ 假绿）见 §1 补充。
**pre-commit 安装路径**：真实仓 hook 为 `../../scripts/check-tangle.sh` symlink，直接 `bash .git/hooks/pre-commit` → ✅ `rc=0`（symlink 场景依赖解析正常）。

**README / ADR-018 与实测行为一致（逐条抽验）**：
- README「门禁逻辑 ①②④」「不修改工作区」「与 `.entangled` 无关」—— 与脚本实现及上述实测一致。
- README「旧实现会假绿」—— 已复现（§1、§2）。
- README「`entangled tangle -s` 永不写盘」「`entangled reset` 只动 `.entangled/`」—— 实测非 `.entangled`
  文件指纹前后一致。
- ADR-018 D-F3-1（①② dry-run / ④ 沙箱重生成逐字节为权威 / 严禁改真实工作区）、D-F3-2（无 DB 可复现）、
  D-F3-4（stitch scoped、TSX 零回退）、D-F3-5（fixture 自测）、D-F3-6（`--force` 仅沙箱）—— 全部与实测一致。
- README/ADR HAZARD「全局 `entangled stitch` 破坏性」—— **独立复现**（带 DB 的一次性副本）：
  ```
  --- git diff --stat after global stitch ---
   design/07-app-plane/00-web-api.md |  203 +--
   design/07-app-plane/01-mcp.md     | 3378 +------------------------------------
   2 files changed, 2 insertions(+), 3579 deletions(-)
  +<<crates/mcp/src/tools.rs>>
  --- subsequent 'entangled tangle' ---
             ERROR    Cyclic reference in <<crates/app/src/bin/eestock-app.rs[0]>>: ...
  ```
  `design/07-app-plane/{00-web-api,01-mcp}.md` 确含块内嵌 `~/~ begin` 遗留标记
  （00-web-api.md:4613/4814；01-mcp.md:375-376/3750-3751），`stitch.sh` 已硬跳过（代码 + 告警）。

证据：`evidence/…/{cargo_check_workspace_alltargets.out,final_misc.txt,readme_claims_probe.out,global_stitch_hazard_db.out,hazard_markers.txt}`。

---

## 9. 未覆盖项声明 —— 显式列出

以下**未覆盖**，请知悉（不构成本次阻塞）：

1. **非 Linux / 非 GNU 环境**：`readlink -f`、`cp -a`、`find`、`sed -i`、`shopt globstar` 依赖 GNU 语义；
   macOS/BSD 未测。脚本对 `readlink -f` 缺失有回退，但未在 BSD 上实测。
2. **CI 供应商集成**：仓库无 CI 配置被验证；hook 为本地 symlink 不入库（README 已注明克隆后需重装），
   CI 需显式调用 `./scripts/check-tangle.sh` 的路径未被端到端跑（仅手工模拟干净 clone）。
3. **`--all` 模式的 stitch 端到端**：我只验证了默认 scoped 与显式 scoped（以及负样例）；`stitch.sh --all`
   未独立端到端执行（自测 T5 仅校验 `--help` 文案）。`--all` 会走"跳过块内嵌标记文档"分支，未实测
   在真实仓的完整行为。
4. **规模/性能边界**：本仓门禁实测 ~0.8s（design 3.3M / 151 产物）；design 数量级增长后的表现未测。
5. **多行 TOML `watch_list` / 自定义 `entangled.toml` 变体**：仅单行数组被覆盖（门禁设计为对该情况硬失败）。
6. **`entangled` 版本矩阵**：仅 2.4.3 实测（README 仍记录"验证版本 2.4.0"，见 §10）。
7. **旧门禁在 unstaged 手改下**：会因 `git diff` 而变红（非假绿）——即旧门禁假绿的**精确条件**是
   "手改已提交/已入 index"，本报告确认了该边界但未穷举所有 git 状态。

---

## 10. 残余风险 / 轻微不一致（均非阻塞）

1. **文档数字轻微不精确**（低）：实测全局 stitch 删除 **3579** 行（01-mcp.md `-3377`、00-web-api.md `-202`，
   `2 insertions`）。但 `README.md:77` 与 `ADR-018:27` 写 `-3583 行`；`coder/report/146:103/106/337`
   写 `-3378 行` / `-203 行`。量与行为方向一致，仅数字差 1–4。**建议合并前统一为实测值**。
2. **实施报告 §4.5 修前计数未复现**（低）：报告称修前 `generated_compared=139`，我独立扫描修前/修后
   均为 151（含 `entangled.toml` 与 `preview/*` 非 `.md` 资产）。**drift=2 的结论复现**，139 这数字不实。
3. **README 版本号**（低，可能为既有）：README 写 entangled「验证版本 2.4.0」，实际环境/实施报告为 2.4.3。
4. **`stitch.sh` 对块内嵌标记文档是"硬跳过"**（设计如此）：这类文档（`design/07-app-plane/` 两份）
   目前无法经 stitch 回写，需人工同步（F3-f 待办）。已在 README/`--help`/报告声明。
5. **门禁依赖 `entangled` 可执行文件**：缺失时硬失败（设计如此），CI 需确保安装。

---

## 11. 证据清单

`tester/evidence/012_f3_tangle_gate/`：
`incident_state.txt` `incident_old_gate.out` `incident_new_gate.out` `old_hook_commit.out`、
`real_new_gate.out` `real_new_gate.rc`、`baseline_*` `after_new_gate_*` `final_realrepo_sideeffect.txt`、
`copy_incident_sideffect.txt`、`tsx_hashes.txt`、`doc_hunks_in_block.out` `check_hunks_in_codeblock.py`、
`ci_clean_nodb_current.out` `ci_clean_nodb_handedit.out` `ci_with_db_handedit.out`
`ci_headclone_old_gate.out` `ci_headclone_new_gate.out`、`docside_old_vs_new.out`、
`selftest_check_tangle_run{1,2}.out` `selftest_stitch_run{1,2}.out` `selftest_runs.txt` `gate_determinism.txt`、
`stitch_negative_probe.sh` `stitch_negative_probe.out`、
`independent_drift_scan.py` `independent_scan_prefix.out` `independent_scan_postfix.out`、
`language_probe_sql_docker_html.out` `missing_target_branch.out`、
`cargo_check_workspace_alltargets.out` `final_misc.txt` `readme_claims_probe.out`
`global_stitch_hazard.out` `global_stitch_hazard_db.out` `hazard_markers.txt`。

**验证执行未触碰被验实现**：真实仓非证据文件在全部验证活动前后逐字节一致（9563 文件），
`git diff --cached` 为空，无 commit、无 stage、无实现改动。
