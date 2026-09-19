# ADR-026 批 tangle 同步 —— 独立核验报告（tester，只验不改）

**本报告自身位置**：`tester/evidence/20260919_adr026_tangle_verify/README.md`
**证据目录**：`tester/evidence/20260919_adr026_tangle_verify/`（`raw/01..12` 原始输出 + 可复现命令 `commands.sh`）
**被核验对象（上游）**：`coder/evidence/20260919_adr026_tangle_sync/`（`README.md` + `raw/`）
**核验对象（仓库状态）**：`design/07-app-plane/00-web-api.md`、`design/07-app-plane/01-mcp.md`（未暂存 ` M`）
**环境**：Entangled 2.4.3 · git 2.43.0 · HEAD `e807385449a303a1090ac00a52c722b7b77e62ec` · 核验时刻 2026-09-19 12:54–12:56 (+08)
**核验立场**：全部判据由 tester 重新获取；不采信上游报告结论，只把它当索引。

---

## 0. 结论摘要

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | `./scripts/check-tangle.sh` 自跑 | ✅ **exit 0**（末次复跑亦 exit 0） | `raw/01`、`raw/12` |
| 2 | 4 个生成物字节未被门禁修绿过程改坏（工作区 = 暂存区 = 冻结包） | ✅ **4/4 三方全等**（sha256 + `cmp`） | `raw/02` |
| 2b | ADR-026 冻结包 26 个文件全部未变 | ✅ 26/26 `OK` | `raw/09`（末节） |
| 3 | 文档同步是真的（判据有区分度） | ✅ 4 组对照全部符合预期（❌→✅→❌→✅） | `raw/03`、`raw/04`、`raw/05` |
| 3b | 门禁非空转（灵敏度）：单字节篡改可被捕获 | ✅ 篡改目标文件 / 非本批文件各 1 例均 ❌ 且点名，还原后 ✅ | `raw/13` |
| 4 | 幂等：连续两次 `entangled tangle`，第 2 次零改动 | ✅ 仓库根 2 次零字节写入；空 filedb 沙箱第 2 次 `Nothing to be done` | `raw/07`、`raw/08` |
| 4b | 未被顺带改写的其它生成物 | ✅ 148/148 生成物 sha256 前后全等；全树 mtime 扫描无代码文件被触碰 | `raw/06`、`raw/07` |
| 5 | 越界审计（只改那 2 个 design md；无 add/commit/checkout/stash/reset） | ✅ 符合（1 处**预先存在**的差异已证伪归因，见 F6） | `raw/09` |
| 6 | 文档块内容与实现语义一致、无矛盾旧描述 | ✅ 4/4 块 1:1；路由/工具名/字段/告警码/计数逐项对上 | `raw/11` |
| — | 上游证据自洽性（前置/后置 sha256、/tmp 备份） | ✅ 与本次重测一致 | `raw/10` |

**裁决：VERDICT: PASS**（附 6 条 Finding，均**不**使"同步为真"这一结论失效；F1/F2/F3/F5 属超出本批 tangle 范围的文档/工具卫生项，留给父级决定是否追加）。

---

## 1. 判据 1：门禁自跑

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

- 原文：`raw/01_check_tangle_run.txt`（首次）、`raw/12_final_state.txt`（全部核验动作之后复跑，仍 exit 0）。
- **门禁自身不修改工作区**：其 §4/§5 在 `/tmp/check-tangle.XXXXXX` 沙箱内以空 filedb 跑 `entangled tangle -f` + 对全部目标逐字节 `cmp`（脚本 §2 注释与实现已读，沙箱 `trap ... EXIT` 清理）。
- 门禁输出语为 ✅ 的含义 = **文档在干净环境下重新生成的字节 == 仓库字节（全 148 个目标）**，与判据 3/4 的独立证据互相印证。

## 2. 判据 2：实现字节三方全等（工作区 / 暂存区 / 冻结包）

命令与原文：`raw/02_three_way_bytes.txt`

| 生成物 | worktree | `git show :<path>`（index） | 冻结包 `adr026_frozen_20260919T112937Z.tar.gz` | 结论 |
|---|---|---|---|---|
| `crates/web/src/lib.rs` | `c9ae22928247…` | 同左 | 同左 | **ALL-EQUAL** |
| `crates/mcp/src/rpc.rs` | `101811fbd9b7…` | 同左 | 同左 | **ALL-EQUAL** |
| `crates/mcp/src/tools.rs` | `d50ae8e5afe8…` | 同左 | 同左 | **ALL-EQUAL** |
| `crates/mcp/tests/mcp_protocol.rs` | `47f0b2ce2d62…` | 同左 | 同左 | **ALL-EQUAL** |

- 三方各做 `cmp -s`（逐字节，不只看哈希）：`worktree-vs-index = SAME`、`worktree-vs-frozen = SAME`，4/4。
- 冻结包**只在 `/tmp/tv_frozen` 解压**（`tar xzf … -C /tmp/tv_frozen`），未覆盖仓库任何路径。
- 冻结包内即 `coder/backups/adr026_frozen_manifest_20260919T112937Z.txt` 所列文件；该清单 **26/26** 与当前工作区哈希相同（`raw/09` 末节，含 4 个目标、其余 12 个 `crates/**`、9 个 `web/**`、3 个 design 文档）⇒ 不只这 4 个文件，**整个本批实现包都未被门禁修绿过程改动**。
- 冻结包时间戳 11:29 < 文档改动时刻 12:52 ⇒ 冻结包确为**改文档之前**的状态。

## 3. 判据 3：文档同步是真的（worktree 差分对照）

命令与原文：`raw/03`（第 1 组）、`raw/04`（第 2 组）、`raw/05`（第 3、4 组）；worktree 用 `git worktree add --detach /tmp/tv_wt HEAD` 建立，**已 `git worktree remove` 清理**（`raw/12` 的 `git worktree list` 中已无 `/tmp/tv_wt`）。

| 组 | worktree 内容 | 期望 | 实测 |
|---|---|---|---|
| A | HEAD 代码 + **当前 design 两 md** | ❌ | **❌ exit 1**：恰好那 4 个文件 `not managed by Entangled` |
| B | A + **当前 4 个代码文件** | ✅ | **✅ exit 0** |
| C | **当前代码** + HEAD（旧）design 两 md | ❌ | **❌ exit 1**：同样 4 个文件 |
| D | 全部恢复为 HEAD（旧 md + 旧代码） | ✅ | **✅ exit 0**（复现"HEAD worktree 干净"的前提） |

**这组对照证明的三件事**：
1. **判据有区分度**：文档改而代码不改 → ❌；两头都改 → ✅；证明 ✅ 不是"门禁被喂饱"而是**两侧真的对齐**（若只是把门禁糊过去，B 组不会因代码文件变化而转绿——事实上唯一的变量就是那 4 个代码文件）。
2. **A 组失败原因恰为本批 4 个文件**，没有其它噪声：`raw/09` 前的独立统计显示，156 条 `file=` 声明中实际存在的 148 个生成物里，**只有这 4 个**与 HEAD 不同（其余 staged 批量改动都不落在 tangle 生成物集合内）⇒ A 组失败不可能被别的文件遮掩。
3. worktree 内的 4 个代码文件在叠加前经 `git show HEAD:<path> | cmp -` 验证**就是 HEAD 旧字节**，叠加后 sha256 与真仓库完全一致（`raw/04` 内并列打印）。

> 判据 1 的"工作区未被修改"与判据 3 的沙箱/worktree 结论一致：门禁与 worktree 试验都没有回写真仓库。

### 3.1 附加对照：门禁灵敏度（非空转）——`raw/13`

在另一个 worktree（`/tmp/tv_wt2`，已 `git worktree remove` 清理）叠加"当前文档 + 当前 4 代码文件"后：

| 组 | 注入 | 期望 | 实测 |
|---|---|---|---|
| 基线 | 无 | ✅ | **✅ exit 0** |
| E1 | 对本批目标 `crates/mcp/src/tools.rs` **追加 1 个字节** | ❌ 且点名该文件 | **❌ exit 1**：`WARNING \`crates/mcp/src/tools.rs\` not managed by Entangled` |
| E2 | 对**不在本批**的生成物 `crates/alert/src/engine.rs` 追加 1 个字节 | ❌ 且点名该文件 | **❌ exit 1**：`WARNING \`crates/alert/src/engine.rs\` not managed by Entangled` |
| F | 还原后再跑 | ✅ | **✅ exit 0** |

⇒ 门禁的 ✅ **不是空转**：它对任意生成物实施逐字节级比对，1 字节差异即硬失败；且 **不是**只针对已知的 4 个文件做特判。

## 4. 判据 4：幂等与副作用

### 4.1 仓库根 `entangled tangle` ×2（未加 `--force`）——`raw/07`

```
[12:55:3x] INFO  write `crates/domain/src/ports.rs` … write `crates/mcp/src/tools.rs` …（7 个）
           WARNING `…` changed outside the control of Entangled（7 个）
           ERROR   conflicts found, breaking off (use `--force` to run anyway)
EXIT=0
```

- **零字节写入**：7 个被点名的文件及全部 148 个生成物的 sha256 在两次运行前后**完全不变**；mtime 全部早于本次核验开始（最近 `2026-09-19 00:47`，核验 12:55）⇒ 「write …」只是重生成阶段的日志，**真正落盘前已 `breaking off`**。
- 第 2 次运行的 `git status --porcelain`（全量 + 过滤 `^A ` 各一份）与 `git diff --stat` 与第 1 次**逐字相同**；第 2 次对 148 个目标的 sha256 差集为**空**。
- 副作用扫描（`find -newermt '2026-09-19 12:54:00'`，排除 `.git/`、`target/`）仅列出 **tester 自己写的证据文件** + `.entangled/filedb.lock`（0 字节锁文件）⇒ **没有任何 design/、crates/、web/ 文件被触碰**。
- 说明（工具 quirk）：本地 `.entangled/filedb.json` 过期，导致仓库根 `entangled tangle` 一律 `breaking off`，且**该 ERROR 情形下 exit code 仍为 0**。门禁不依赖 exit code、也不依赖 filedb（脚本 §2 注释），故不影响判据 1；但对人手工流程是隐患（见 F5）。

### 4.2 空 filedb 沙箱 `entangled tangle` ×2（非 `--force`）——`raw/08`

沙箱 `/tmp/tv_sbx` = `entangled.toml` + `design/` + 148 个生成物副本，**无 `.entangled/`**：

| 运行 | 输出 | 结果 |
|---|---|---|
| 第 1 次 | `create …`（148 个目标全部重生成） | **沙箱生成结果与真仓库工作区 148/148 逐字节相同**（`cmp` 全过，`raw/08` 内 "ALL sandbox-generated files are BYTE-IDENTICAL to the repo working tree"） |
| 第 2 次 | `INFO Nothing to be done.` | 沙箱 236 个文件 sha256 差集为**空**（run1→run2 零改动） |

⇒ 幂等性在**真正发生生成**的环境下成立（仓库根那次因为 break-off 根本没写盘，单独看证据强度不足，故补此对照）。

## 5. 判据 5：越界审计 —— `raw/09`

```
$ git diff --stat
 .../adr/ADR-023-period-set-extension-30m.md        |  7 +-     <-- 预先存在，非本批（见 F6）
 design/07-app-plane/00-web-api.md                  |  2 +      <-- 本批
 design/07-app-plane/01-mcp.md                      | 92 ++++…   <-- 本批
 3 files changed, 95 insertions(+), 6 deletions(-)
```

- **`crates/**`、`web/**` 工作区零改动**：`git status --porcelain` 中 `crates|web` 条目全部是 `M `（staged；索引 vs HEAD，属预先存在的 ADR-026 批量暂存），**没有任何 ` M` / `??` / ` D`**。
- 未执行 `git add / commit / checkout / stash / reset`：`.git/index` mtime = **12:49:41**（早于本次核验 12:54；若执行过 `git add` 必然被刷新）；`git reflog -1` 仍是 `e807385 … commit: chore(deploy): ADR-024 …`（无新条目）；`git stash list` 为空；`.git/ORIG_HEAD` mtime = 2026-09-18 18:03（未动）。
- 未使用 `entangled tangle --force`：本次核验只跑过 `entangled tangle`（无参数）与 `entangled tangle -s`（门禁内部）。`-f` 仅出现在**门禁自身的隔离沙箱**（未修改真实工作区，脚本 §4 已读验证）。
- 未改动任何 `crates/**`、`web/**`：除 §2 的字节证据外，`find -newermt` 全树扫描（§4.1）再次佐证。
- 新增产物：`tester/evidence/20260919_adr026_tangle_verify/`（本报告 + `raw/` + `commands.sh`，未跟踪）；`/tmp/**` 下的沙箱与副本（未进入仓库）。

## 6. 判据 6：文档内容正确性抽查 —— `raw/11`

1. **块内容 ↔ 生成物正文 1:1（4/4 IDENTICAL）**：剥离 `// ~/~ begin` / `// ~/~ end` 两行标记后，文档块行序列与文件正文**逐字节相同**（行数 110/127/3671/340 与文件一致，块哈希 = 正文哈希）。⇒ 文档块就是实现本身，不存在"文档写一套、代码是另一套"。
2. **路由路径**：文档块 `.route("/api/workbench/runs/{id}/audit", get(workbench::get_audit))` ↔ 实现 `crates/web/src/lib.rs:103` 同字节；handler `crates/web/src/workbench.rs:568 pub async fn get_audit` 存在；`bt_get_run_audit` 文档注释所声称的"与 web 同一纯函数口径"成立——两侧都调用 `WorkbenchService::run_audit`（`application/src/workbench.rs:1306`），web 侧 `workbench.rs:580`、MCP 侧 `tools.rs:1542`。前端 `web/src/api/client.ts:593` 亦请求同一路径。
3. **工具名/注册**：`"bt_get_run_audit"` 同时出现在 `tool_schemas()`（`tools.rs:466`）、`call_tool` 分发（`tools.rs:527`）、rpc 名单断言（`rpc.rs:122`）、契约断言与端到端测试（`tools.rs:1579/1617/1647/3431…3467`）。
4. **计数口径**：实现实际注册 `bt_*` = **9 个**（含 `bt_get_run_audit`）；`tools.len() == 35` 在 `tools.rs:1579` 与 `mcp_protocol.rs:210` 同时成立，与文档块内 `34→35` / `8→9 bt_*` 的改写一致。
5. **审计载荷字段**：文档描述的 `deployed_notional / deployed_pct / cash_consumed / cash_consumed_pct / planned_tranches(Option→null) / reachable_batches / batches_done / unexecuted_orders / last_bar_unfilled / round_trips_total / round_trips_force_closed / warnings[] ` 与 `crates/application/src/audit.rs:112-141` 的 `AuditReport` 字段**逐名对上**（另 `run_id`/`capital_basis` 见 `RunAudit`）。
6. **告警语义**：文档声称的 `PARTIAL_DEPLOYMENT`（敞口 <99%）、`DCA_PLAN_UNDERFILLED`、`ORDERS_UNEXECUTED` 与实现常量一致，且阈值 `PARTIAL_DEPLOYMENT_THRESHOLD = 0.99`（严格小于）与 `audit.rs:35/38/40/42` 相同。
7. **无矛盾旧描述**：两份目标文档内已无 `34 个工具` / `8 个 bt_*` 之类旧计数（`raw/11` §6.7）；文档块中新增内容与实现语义一致，未发现与实现冲突的遗留描述。

---

## 7. Findings（不影响本判据裁决，供父级定性）

| ID | 级别 | 内容 | 证据 |
|---|---|---|---|
| **F1** | 提示（文档完整性） | `design/07-app-plane/00-web-api.md` 的**接口表**（295–301 行）逐行登记 `/runs/{id}`、`/result`、`/brief`、`/bars`、`/curve`、`/fills`、`/cancel`，**但未新增 `/runs/{id}/audit` 行**。该表是散文、不在 tangle 块内，门禁不覆盖；不是"与实现矛盾"，而是**遗漏**（ADR-026 文档本身 53 行已登记该路由）。 | `raw/11` §6.2；`grep -n 'workbench/runs/{id}' design/07-app-plane/00-web-api.md` |
| **F2** | 提示（文档完整性） | `01-mcp.md` §1 散文的 `bt_*` 工具枚举（118–122 行）**未加入 `bt_get_run_audit`**（该处枚举了其余 8 个）。同样不在 tangle 块内。 | `sed -n '105,135p' design/07-app-plane/01-mcp.md` |
| **F3** | 提示（历史文本） | `design/12-strategy-system/01-adr.md:121` 仍写「最终矩阵 strategy_*×7 + bt_*×8」，现应为 ×9；该句为 2026-09-09 的历史决议记录，且句尾自带「权威 schema 以 `design/07-app-plane/01-mcp.md` 为准」，故不构成矛盾，但数值已过时。 | `raw/11` §6.7 |
| **F4** | 观察（副作用） | 两份被改文档的**文件权限由 664 变为 600**（`-rw-------`），系改文档脚本写盘所致；git 只看可执行位（索引仍 `100644`），不影响门禁与提交；其余 design 文档仍为 664。 | `raw/09` 末节 / `stat -c '%a'` |
| **F5** | 观察（工具/流程） | 仓库根 `entangled tangle` 因 `.entangled/filedb.json` 过期**恒 `breaking off`**，且**该 ERROR 情形 exit code 仍为 0**。门禁不受影响（沙箱 + 不依赖 filedb + 解析输出而非 exit code），但开发者手工跑 `entangled tangle` 会"看起来成功、实际没写盘"。上游报告残余风险 1 与之相同。 | `raw/07`；`raw/01` 脚本头注释 |
| **F6** | 澄清（范围归因） | `git diff --stat` 出现**第 3 个** design 文档 `design/01-architecture/adr/ADR-023-period-set-extension-30m.md`（7 行），**不是本批产物**：mtime = 2026-09-17 13:34（早两天），且 sha256 与 11:29 冻结清单一致（`7cfbfbbf…`）⇒ 在本批基线之前就已存在。 | `raw/09`、`raw/02`/`10` |
| **F7** | 澄清（任务前提有误） | 任务背景称「`scripts/stitch.sh` 会跳过这两份文档（含历史遗留块内标记）」。**实测不成立**：`grep -c '~/~ begin'` 在 `00-web-api.md`、`01-mcp.md` 均为 **0**（HEAD 及 HEAD~2 亦然），含标记的是 `design/01-architecture/adr/ADR-018-tangle-gate-hardening.md` 与 `design/06-web/preview/0{1..8}-*.html`（8 份）。`stitch.sh` 的跳过判据是代码里的 `grep -q '~/~ begin' "$d"`（247 行），其**头注释「当前仅上述两份」已陈旧**（第 11、17 行）。⇒「回写路径不可用」不成立；但 coder 选择「改文档 → `entangled tangle`」在方向上**正确**（本批改动应当落在设计侧），故该错误前提未造成实质损害。 | 见下方命令输出 |
| **F9** | 澄清（核验动作） | 灵敏度试验在独立 worktree `/tmp/tv_wt2` 内进行，该 worktree 内文件被叠加/篡改后以 `git worktree remove --force` 清理；**主仓库未受影响**（终态门禁复跑 ✅、`git worktree list` 无残留、`git status` 仅 design ` M` 与既有 staged 批量条目）。此处 `--force` 属 git worktree 清理参数，**与硬禁的 `entangled tangle --force` 无关**。 | `raw/13`、`raw/12` |
| **F8** | 证据整理 | 本目录 `raw/07a_…_SUPERSEDED_filter_artifact.txt` 是我第一次做幂等测量时的中间产物：把**未过滤**的 pre 状态与**已过滤 `^A `** 的 post 状态相比，产生了虚假差异行；已重做为 `raw/07`（口径一致，全量 + 过滤两份都保留）。保留原件以示可追溯。 | `raw/07a` vs `raw/07` |

F7 复核命令与结果：

```
$ grep -rl '~/~ begin' design/ | sort
design/01-architecture/adr/ADR-018-tangle-gate-hardening.md
design/06-web/preview/0{1..8}-*.html            # 共 8 份，均非本次两份文档
$ grep -c '~/~ begin' design/07-app-plane/00-web-api.md   -> 0
$ grep -c '~/~ begin' design/07-app-plane/01-mcp.md       -> 0
$ git show HEAD~2:design/07-app-plane/00-web-api.md | grep -c '~/~ begin'  -> 0   （01-mcp 同）
```

---

## 8. 上游证据自洽性复核 —— `raw/10`

| 上游声明 | tester 复核 | 结论 |
|---|---|---|
| 改前文档 sha256 `0789d3fb…` / `a6c4367c…` | `/tmp/00-web-api.md`、`/tmp/01-mcp.md`（coder 动手前备份，mtime 12:50:49 < 文档 mtime 12:52）哈希与声明一致 | 一致 |
| 改后文档 sha256 `137a7876…` / `60163390…` | 当前仓库文档哈希与声明一致（核验全程未变，`raw/12`） | 一致 |
| 文档改动仅限 4 个块内的最小 hunk（2 / 92 行） | 与 `/tmp` 改前备份做 `diff`：`00-web-api.md` 2 行变更；`01-mcp.md` 92 行变更 | 一致 |
| 4 个生成物零字节变化 | 与**暂存区**、**冻结包**三方 `cmp` 全等（§2） | 一致 |
| 148 个生成物零变化 | 143 个真实目标 + 其余；本次前后 sha256 全等（§4.1）；空 filedb 沙箱 148/148 与仓库逐字节相同（§4.2） | 一致（并加强了：从"前后不变"升级为"文档重新生成即等于仓库字节"） |

---

## 9. 原始证据索引

| 文件 | 内容 |
|---|---|
| `commands.sh` | 可复现命令清单（本核验全部步骤） |
| `raw/01_check_tangle_run.txt` | 门禁自跑（exit 0） |
| `raw/02_three_way_bytes.txt` | 4 生成物 worktree/index(:)/冻结包 三方 sha256 + `cmp` |
| `raw/03_worktree_step1_docs_only.txt` | worktree A 组：新文档 + 旧代码 → ❌ |
| `raw/04_worktree_step2_docs_plus_code.txt` | worktree B 组：新文档 + 新代码 → ✅ |
| `raw/05_worktree_controls.txt` | worktree C 组（新代码 + 旧文档 → ❌）与 D 组（全 HEAD → ✅） |
| `raw/06_all_targets_sha256_pre_tangle.txt` | 148 个 tangle 生成物改动前 sha256 清单 |
| `raw/07_repo_root_tangle_idempotence.txt` | 仓库根 `entangled tangle` ×2：零写入、status/diff 不变、148 目标零变更、mtime 扫描 |
| `raw/07a_repo_root_tangle_x2_SUPERSEDED_filter_artifact.txt` | 同上（被作废的初版，口径不一致，见 F8） |
| `raw/08_sandbox_tangle_idempotence.txt` | 空 filedb 沙箱 ×2：148/148 与仓库逐字节相同；第 2 次零改动 |
| `raw/09_scope_audit.txt` | 越界审计：diff --stat/name-status、crates+web 零改动、index/reflog/stash、26 文件冻结比对、文件权限 |
| `raw/10_upstream_evidence_authcheck.txt` | 上游 sha256 与 /tmp 备份复核 |
| `raw/11_doc_content_correctness.txt` | 块↔正文 1:1、路由/handler/工具/字段/告警码/计数逐项对照、旧描述扫描 |
| `raw/12_final_state.txt` | 终态：门禁复跑 ✅、文档与 4 生成物 sha256、worktree 已清理、最终 status/diff/reflog |
| `raw/13_gate_sensitivity_mutation.txt` | 门禁灵敏度变异试验：目标文件/非本批文件各 1 字节篡改 → ❌ 点名；还原 → ✅ |

`raw/*.txt` sha256：见本节末（由 `commands.sh` 可重算）。

## 10. 残留不确定性（显式列出）

1. **未跑 Rust / 前端测试**：本核验只验"文档 ↔ 生成物字节与语义一致性"，按只验不改、且实现字节已被冻结包三方证明未变，测试不构成本次判据的一部分。tangle 同步**不引入**新的行为验证。
2. **`.entangled/filedb.json` 仍过期**（改动前既有）：仓库根 `entangled tangle` 依旧 `breaking off`；本次按硬纪律**未刷新/未删除** filedb（避免触发全量写盘越界）。门禁不受影响，但下一次"改码后手工 tangle"的体验仍受限（F5）。
3. **F1/F2/F3 的散文同步未做**：接口表缺 `/audit` 行、`01-mcp.md` §1 工具枚举缺 `bt_get_run_audit`、`12-strategy-system/01-adr.md` 的「bt_*×8」历史数。它们不在 tangle 块内，**不触发门禁**，也不与实现冲突（均为遗漏/历史文本），但若验收要求"设计文档整体反映 ADR-026"，需另开小改动。本次未改（严守"只验不改"与范围纪律）。
4. **F7 的工具注释陈旧**：`scripts/stitch.sh` 头注释对"哪两份文档含块内标记"的描述与仓库实况不符；本次未改脚本（越界）。若后续按旧注释推理，可能再次误判"回写路径不可用"。
5. **F4 文件权限 600**：仅本地元数据，git 不跟踪、不影响提交与门禁；若团队有 umask/权限校验规则需注意。
6. **未验证的边界**：本核验未模拟"CI 全新克隆"（无 filedb、无本地 `.entangled/`）下的 `check-tangle.sh` 表现——但 `raw/08` 的空 filedb 沙箱与门禁 §2 的沙箱化设计已覆盖其等价路径（门禁不依赖 filedb）。
7. **门禁 exit-code 语义**：`entangled tangle` 在冲突时 exit 0（F5），门禁靠**解析输出**判定。本次已用变异试验（`raw/13`）证明门禁对单字节篡改**敏感且非特判**，但所有 ❌ 都发生在脚本 §3（dry-run 冲突分支）；§4/§5（沙箱重新生成 + 逐字节比对）的**失败分支**未被单独触发/证伪（§3 在结构上先于 §5 且覆盖同一类不一致，故该分支属冗余保险）。

---

VERDICT: PASS
