# ADR-026 批 tangle 同步（design ← 已验收实现）· 证据与裁决

**报告自身位置**：`coder/evidence/20260919_adr026_tangle_sync/README.md`
**证据目录**：`coder/evidence/20260919_adr026_tangle_sync/`（`raw/` 为原始输出，`commands.sh` 为可复现命令）
**被修事实源**：`design/07-app-plane/00-web-api.md`、`design/07-app-plane/01-mcp.md`
**载体**：pre-commit 钩子 `scripts/check-tangle.sh`（= `.git/hooks/pre-commit` symlink）
**工具版本**：Entangled 2.4.3

---

## 0. 结论摘要（TL;DR）

| 项 | 结果 |
|---|---|
| 门禁 `./scripts/check-tangle.sh` | ❌ exit 1（4 个 `not managed by Entangled`） → ✅ exit 0 |
| 二次复跑门禁 | ✅ exit 0（与首次一致） |
| 4 个生成物字节 | **零变化**，与"暂存区基线" sha256 逐位全等 |
| 全部 **148** 个 tangle 生成物 | **零变化**（改动前后 sha256 清单全等） |
| 代码改动文件数（`crates/**`、`web/**`） | **0**（未动任何实现字节） |
| 新增/修改的已跟踪文件 | **仅 2 份 design 文档**（均为未暂存 ` M`） |
| `git add` / `commit` / `checkout` / `stash` / `reset` | **均未执行** |
| `entangled tangle --force` | **未使用** |

文档改动规模 = 代码改动规模（对称性自证）：

```
design/07-app-plane/00-web-api.md |  2 +
design/07-app-plane/01-mcp.md     | 92 +++++++++++++++++++++++++++++++---
 2 files changed, 89 insertions(+), 5 deletions(-)          <-- 文档侧

 crates/mcp/src/rpc.rs            |  4 +-
 crates/mcp/src/tools.rs          | 84 +++++++++++++++++++++++++++++++++++++++-
 crates/mcp/tests/mcp_protocol.rs |  4 +-
 crates/web/src/lib.rs            |  2 +
 4 files changed, 89 insertions(+), 5 deletions(-)          <-- 实现侧
```

两侧 `89 insertions / 5 deletions` 完全一致 —— 文档块内新增/替换的行与实现新增/替换的行 **一一对应**。

---

## 1. 步骤 1：映射语义结论（块 ↔ 生成物）

### 实测语义（entangled 2.4.3）

生成物文件的字节构成恒为：

```
<生成物>  ==  [ "// ~/~ begin <<<doc>>#<target>>[init]" ]     // 一行 begin 标记
            +  <文档 fenced block 的内容行，逐字节原样>
            +  [ "// ~/~ end" ]                              // 一行 end 标记
            +  "\n"                                          // 末尾换行
```

由此得**逆向结论**（本次改文档所依据的等式）：

```
new_block_content  ==  generator_file_content.split("\n")[1:-2] 再以 "\n" 连接 + "\n"
                        ^^^ 剥掉 begin 标记行、end 标记行、split 产生的末尾 ''
```

即：**块内容就是生成物正文本身**（1:1，无缩进/转义改写）。

### 关于"块内嵌 `~/~ begin` 遗留标记"（与任务判定的重要出入）

任务背景称 *"这两份文档含历史遗留的块内标记，stitch 会跳过它们"*。**实测不成立**：

```
$ grep -c '~/~ begin' design/07-app-plane/00-web-api.md   -> 0
$ grep -c '~/~ begin' design/07-app-plane/01-mcp.md       -> 0
$ grep -rl '~/~ begin' design/                            -> 只有 8 份，均非这两份：
    design/01-architecture/adr/ADR-018-tangle-gate-hardening.md
    design/06-web/preview/0{1..8}-*.html
```

`scripts/stitch.sh` 的跳过判据是 `grep -q '~/~ begin' "$d"`（见 stitch.sh §"② 跳过块内嵌标记遗留文档"）。
**两份目标文档并不命中该判据** —— 命中它的是 `design/06-web/preview/*.html` 与 ADR-018 自身。

即便如此，本次仍按任务指定的正路（**改文档 → `entangled tangle`**）执行，不依赖 stitch，理由见 §7 取舍清单。

### 块边界（行号）

| 文档:块起始 | 生成物 | 改动前块内容行 | 改动后块内容行 |
|---|---|---|---|
| `design/07-app-plane/00-web-api.md:2610` | `crates/web/src/lib.rs` | 2611..2718（108） | 2611..2720（110） |
| `design/07-app-plane/01-mcp.md:255` | `crates/mcp/src/rpc.rs` | 256..380（125） | 256..382（127） |
| `design/07-app-plane/01-mcp.md:385` | `crates/mcp/src/tools.rs` | 386..3976（3591） | 386..4056（3671） |
| `design/07-app-plane/01-mcp.md:4395` | `crates/mcp/tests/mcp_protocol.rs` | 4396..4735（340） | 4396..4735（340） |

完整边界表：`raw/23_block_boundaries.txt`

### 4 处代码改动 ↔ 4 个块（本批新增内容）

| 生成物 | 本批改动（= 写进文档块的内容） |
|---|---|
| `crates/web/src/lib.rs` | `+2`：`// ADR-026 §2.2：执行完整度审计…` 注释 + `.route("/api/workbench/runs/{id}/audit", get(workbench::get_audit))` |
| `crates/mcp/src/rpc.rs` | `+2/-1`：测试内工具名单追加 `// ADR-026 §2.2…` + `"bt_get_run_audit"` |
| `crates/mcp/src/tools.rs` | `+84/-3`：`tool_schemas()` 新增 `bt_get_run_audit` schema（11 行）、`call_tool` 分发新增路由（1 行）、新增 `bt_get_run_audit()` 实现（14 行）、`tool_list_schema_contract` 由 34→35 且 bt_* 由 8→9、`bt_names` 断言追加、`by_name(...required)` 追加、新增测试 `bt_get_run_audit_tool_contract_and_gate`（50 行） |
| `crates/mcp/tests/mcp_protocol.rs` | `+2/-2`：`34 个工具`→`35 个工具` 注释与 `tools.len()` 断言 |

原文 diff：`raw/02_diff_rpc.txt`、`raw/03_diff_tools.txt`、`raw/04_diff_tests_weblib.txt`
块↔生成物差异（改动前）：`raw/05_diff_block_vs_file_tools.txt`

---

## 2. 步骤 2：基线字节（暂存区 sha256，必须保持不变）

```
== crates/web/src/lib.rs
  staged(:)  c9ae22928247a997c349a3b0c924c1d69e96d30d1bd0b5619e4b13497312f390
== crates/mcp/src/rpc.rs
  staged(:)  101811fbd9b771a6b96a7350392f90b79ce3d62bc90e2a52813f57ee02820171
== crates/mcp/src/tools.rs
  staged(:)  d50ae8e5afe85110795c254d8a99de28e8f18d0ada2a00fd4e640ff9e134a6f8
== crates/mcp/tests/mcp_protocol.rs
  staged(:)  47f0b2ce2d625458e3cca83e41d0700eef21d83248e658ad67dcf8b8f3193b8b
```

`worktree` 与 `staged(:)` 完全一致（无工作区游离改动）。
原始输出：`raw/01_baseline_sha256.txt`；4 个文件副本已另存 `/tmp/<path>.baseline`。
**全 148 个生成物**的改动前 sha256 清单：`raw/08_all_targets_sha256_pre_tangle.txt`。

---

## 3. 步骤 3：文档改动

### 改法（最小 hunk，不重排、不格式化其它区域）

`/tmp/sync_docs.py`：对每个块求 `difflib.SequenceMatcher(old_block, new_block=生成物 lines[1:-2])` 的最小 opcodes，
只把 `insert`/`replace` 的行写回文档对应块区间；**文档其它字节（块外全部内容、块内未变行）逐字节不动**。

hunk 明细（10 个 hunk，全部落在 4 个块内）：

```
### 00-web-api.md :: crates/web/src/lib.rs  (块行 2611..2718, 108 -> 110)
  hunk insert: #101..100 -> #101..102   (+2 行 audit 路由与注释)
### 01-mcp.md :: crates/mcp/src/rpc.rs      (块行 256..380,  125 -> 127)
  hunk replace: #119..119 -> #119..121  (名单追加 bt_get_run_audit)
### 01-mcp.md :: crates/mcp/src/tools.rs    (块行 386..3976, 3591 -> 3671)
  hunk insert: #463..462    -> #463..473    (+11  schema)
  hunk insert: #515..514    -> #526..526    (+1   dispatch)
  hunk insert: #1521..1520  -> #1533..1546  (+14  impl fn)
  hunk replace: #1552..1552 -> #1578..1578  (34 -> 35)
  hunk replace: #1588..1588 -> #1614..1616  (bt_names)
  hunk insert: #1618..1617  -> #1646..1647  (+2  by_name required)
  hunk insert: #3392..3391  -> #3422..3471  (+50 新测试)
### 01-mcp.md :: crates/mcp/tests/mcp_protocol.rs (块行 4396..4735, 340 -> 340)
  hunk replace: #203 -> #203  |  hunk replace: #209 -> #209
```

原始输出：`raw/10_doc_edits.txt`

### 文档 sha256（动手前 / 动手后）

| 文档 | 改前 | 改后 |
|---|---|---|
| `design/07-app-plane/00-web-api.md` | `0789d3fb34c5a926d0b315c34394db66786556103f5dd5763e212eeb2559f987` | `137a78762c2aa2110669e1e082d02fc0e24f014d457a4d5ec110e0d0d5c2491b` |
| `design/07-app-plane/01-mcp.md` | `a6c4367caed2808f0c2109c5fb1285a9cc7f76cdb776aa89ba414ebb5835b4a1` | `601633909f1381b69cdfd7f05c4b662da9eba31e2f19cfcf337a21d3dfada10f` |

`raw/00_pre_docs_sha256.txt`、`raw/11_post_docs_sha256.txt`；完整 diff：`raw/18_doc_diff.patch`（hunk 头：`raw/20_doc_diff_hunks.txt`）。

### 先验校验（改真仓库之前）

先在**沙箱**（`/tmp/sbx_val2` = 仓库 `design/` + 4 生成物副本 + 空 filedb）跑同一脚本 + `entangled tangle -f`，
确认 4 个生成物与仓库基线逐字节相等；随后 **真仓库两份文档与沙箱文档 `cmp` 全等**，再落真仓库：

```
00-web-api.md: IDENTICAL to sandbox
01-mcp.md:     IDENTICAL to sandbox
```

---

## 4. 步骤 4：重新 tangle（文档 → 生成物）与字节断言

```
$ entangled tangle            # 仓库根，未加 --force
  INFO  write `crates/web/src/lib.rs`
  INFO  write `crates/mcp/src/rpc.rs`
  INFO  write `crates/mcp/src/tools.rs`
  INFO  write `crates/mcp/tests/mcp_protocol.rs`
  WARNING ... changed outside the control of Entangled   (7 个，见 raw/12)
  ERROR  conflicts found, breaking off (use `--force` to run anyway)
```

> **说明**：仓库根的 `entangled tangle` 因**本地 `.entangled/filedb.json` 过期**而 `breaking off`，**未写盘**。
> 这属**改动前既有状态**（改动前 dry-run 已报 5 个 conflict；改动后 7 个），且门禁按设计**不依赖 filedb**
> （见 check-tangle.sh 注释：filedb 未版本化、回写后即过期，故沙箱内一律清空）。
> 为真正证明"文档→生成物"方向一致且幂等，另在**空 filedb 沙箱**（与门禁同法、非 `--force`）跑了两次 `entangled tangle`，
> 见 §5 与 `raw/24_sandbox_idempotence.txt`。

### 断言 A：4 个生成物字节 == 步骤 2 基线

```
=== sha256 triple (baseline / pre-edit worktree / post-tangle) ===
crates/web/src/lib.rs                    baseline=c9ae22928247 pre=c9ae22928247 post=c9ae22928247
crates/mcp/src/rpc.rs                    baseline=101811fbd9b7 pre=101811fbd9b7 post=101811fbd9b7
crates/mcp/src/tools.rs                  baseline=d50ae8e5afe8 pre=d50ae8e5afe8 post=d50ae8e5afe8
crates/mcp/tests/mcp_protocol.rs         baseline=47f0b2ce2d62 pre=47f0b2ce2d62 post=47f0b2ce2d62

=== 4-file direct cmp vs baseline ===
cmp OK  crates/web/src/lib.rs
cmp OK  crates/mcp/src/rpc.rs
cmp OK  crates/mcp/src/tools.rs
cmp OK  crates/mcp/tests/mcp_protocol.rs
all_cmp_ok=1
```

`raw/22_sha256_triple.txt`。**无任一字节变化 ⇒ 不需要回滚文档。**

### 断言 B：全部 148 个生成物零变化

```
=== ALL 148 targets: pre-tangle vs now ===
✅ ALL 148 tangle targets byte-identical to pre-tangle snapshot (zero code bytes changed)
```

---

## 5. 步骤 5：门禁复验 + 幂等

### 门禁（改动前失败 → 改动后通过）

改动前（`raw/07_gate_baseline_fail.txt`，exit 1）：

```
[check-tangle] ❌ entangled dry-run 报告冲突/未托管（生成物与 design/ 文档失同步）：
WARNING `crates/web/src/lib.rs` not managed by Entangled
WARNING `crates/mcp/src/rpc.rs` not managed by Entangled
WARNING `crates/mcp/src/tools.rs` not managed by Entangled
WARNING `crates/mcp/tests/mcp_protocol.rs` not managed by Entangled
```

改动后（`raw/13_gate_after_fix.txt`，exit 0）：

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
```

二次复跑（`raw/15_gate_rerun.txt`，exit 0）逐字相同 → 门禁稳定，非偶然。

> 门禁的内部判据本身就包含一次**空 filedb 沙箱 `entangled tangle -f` + 对全部生成物逐字节比对**（check-tangle.sh §4/§5），
> 因此"✅"等价于"文档在干净环境下重新生成的字节 == 仓库字节（全 148 个目标）"。

### 幂等

| 执行 | 结果 |
|---|---|
| 仓库根 `entangled tangle`（第 1 次） | 因过期 filedb break off，**零字节写入** |
| 仓库根 `entangled tangle`（第 2 次） | 同上，**零字节写入**；148/148 目标 sha256 不变 |
| **空 filedb 沙箱** `entangled tangle`（非 --force，第 1 次） | 生成 148/148 目标，与仓库**逐字节全等**（differing targets: 0） |
| **空 filedb 沙箱** `entangled tangle`（第 2 次） | `INFO Nothing to be done.`；**0 / 236 文件变化** |

沙箱原文：`raw/24_sandbox_idempotence.txt`

---

## 6. 步骤 6：范围核查

### 状态增量（`git status --porcelain`，非 `A ` 条目，sort 后 diff）

```
=== DELTA in non-staged-add entries (before -> after) ===
37a38,39
>  M design/07-app-plane/00-web-api.md
>  M design/07-app-plane/01-mcp.md
```

**恰好 2 条新增，均为 design 文档的未暂存 ` M`**：
无新增代码 `M`、无新增 `??`/`A ` 文件（证据目录 `coder/evidence/20260919_adr026_tangle_sync/` 在改动前已存在并已出现于 `.06`/`raw/09` 基线状态）。
`raw/17_status_delta.txt`（全量状态：`raw/16_git_status_after.txt`）。

### `git diff --stat`（本批 design 改动）

```
 design/07-app-plane/00-web-api.md |  2 +
 design/07-app-plane/01-mcp.md     | 92 ++++++++++++++++++++++++++++++++++++---
 2 files changed, 89 insertions(+), 5 deletions(-)
```

### `git diff --stat HEAD`（对应的 4 个生成物，未发生改动）

```
 crates/mcp/src/rpc.rs            |  4 +-
 crates/mcp/src/tools.rs          | 84 +++++++++++++++++++++++++++++++++++++++-
 crates/mcp/tests/mcp_protocol.rs |  4 +-
 crates/web/src/lib.rs            |  2 +
 4 files changed, 89 insertions(+), 5 deletions(-)
```

### 索引（staged）核查

本任务**未执行** `git add`（也未 commit/checkout/stash/reset）。工作区索引中已存在的约 700 条
批量暂存条目（ADR-026 批产物）**全部先于本任务**，与本次增量无关；本次增量仅为 2 条**未暂存** design 文档。

---

## 7. 自行取舍清单（discretion list）

1. **不用 `scripts/stitch.sh`**：任务称其会跳过这两份文档 —— 实测**不成立**（`grep -c '~/~ begin'` 为 0，见 §1）。
   仍按任务指定正路（改文档 → `entangled tangle`）执行。取舍理由：(a) 任务明确指定；
   (b) 手写最小 hunk 比 stitch 的"整文档整块回写"更贴合"只加本批新增、不得重排/格式化其它区域"的硬约束；
   (c) 避免 stitch 触碰同文档其它块带来的范围扩大。
2. **`entangled tangle` 报 `conflicts found, breaking off` 未写盘**：判定为**本地 filedb 过期**所致的预期行为
   （改动前即存在；门禁设计上不依赖 filedb）。**未使用 `--force`**（硬禁），**未删除/刷新 `.entangled/filedb.json`**
   （避免触发对全部生成物的写盘、越出"本阶段只允许改 design 文档"的范围）。
   转而用**门禁同款空 filedb 沙箱**做两次非 `--force` 全量 tangle，取得"148/148 逐字节一致 + run2 零改动"的硬证据。
3. **未跑 Rust/前端测试**：本阶段**不改实现字节**（已由全生成物 sha256 清单证明），测试不构成本次改动的证据；
   "文档→生成物"一致性由门禁的逐字节回归完整覆盖。
4. **改文档用脚本而非逐个 `edit`**：以 `difflib` 最小 hunk 代替肉眼字符串替换，规避
   `"bt_cancel_run"…"bt_apply_preset"]);` 这类在 `rpc.rs` 块与 `tools.rs` 块重复出现的锚点造成的误替换；
   hunk 表（§3）即为可审计的"精确改动"凭证。
5. **先沙箱后真仓库**：真仓库落笔前，先在同一套输入上验证"文档 → 生成物 == 基线"，
   并在落笔后用 `cmp` 证明真仓库文档 == 已验证沙箱文档。

---

## 8. 残余风险

1. **本地 `.entangled/filedb.json` 过期**（改动前既有）：之后在仓库根直接跑 `entangled tangle` 仍会 `breaking off`，
   须先按团队流程刷新/重建 filedb。**不影响 pre-commit 门禁**（门禁沙箱内一律清空 filedb）。
   改动把 conflict 数从 5 增到 7（新增 `rpc.rs`、`mcp_protocol.rs`）：其文档块摘要变了、磁盘文件也已是最新内容，
   对 filedb 表现为"两边都动过"⇒ 判 conflict；**该 conflict 是良性的**（`--force` 只会写出与现状逐字节相同的内容）。
2. **任务背景中"块内嵌标记"的描述与仓库实况不符**：建议核对 ADR-018 F3-f 卫生债清单 ——
   真正的遗留标记在 `design/06-web/preview/*.html` 与 `design/01-architecture/adr/ADR-018-tangle-gate-hardening.md`，
   **不含**本次两份目标文档。若后续仍按旧描述推理，可能误判"回写路径不可用"。
3. 未对 `design/06-web/preview/*.html` 等真正含遗留标记的文档做任何处理（超出本批范围）。

---

## 9. 原始证据索引（`coder/evidence/20260919_adr026_tangle_sync/`）

| 文件 | 内容 |
|---|---|
| `commands.sh` | 可复现命令清单 |
| `raw/00_pre_docs_sha256.txt` | 改前文档 sha256 |
| `raw/01_baseline_sha256.txt` | 4 生成物 暂存区/工作区 sha256 基线 |
| `raw/02_diff_rpc.txt`、`raw/03_diff_tools.txt`、`raw/04_diff_tests_weblib.txt` | 本批代码 diff（事实输入） |
| `raw/05_diff_block_vs_file_tools.txt` | 块内容 vs 生成物（改动前）差异 |
| `raw/06_dryrun_baseline_repo.txt` | 仓库根 dry-run（含本地 filedb 视角） |
| `raw/07_gate_baseline_fail.txt` | 门禁失败原文（exit 1） |
| `raw/08_all_targets_sha256_pre_tangle.txt` | 全 148 生成物改动前 sha256 |
| `raw/09_git_status_before.txt` | 改动前 `git status`（非 `A `） |
| `raw/10_doc_edits.txt` | 文档最小 hunk 明细 |
| `raw/11_post_docs_sha256.txt` | 改后文档 sha256 |
| `raw/12_entangled_tangle_repo.txt` | 仓库根 `entangled tangle`（第 1 次） |
| `raw/13_gate_after_fix.txt` | 门禁通过（exit 0） |
| `raw/14_entangled_tangle_repo_2nd.txt` | 仓库根 `entangled tangle`（第 2 次） |
| `raw/15_gate_rerun.txt` | 门禁二次复跑（exit 0） |
| `raw/16_git_status_after.txt` | 改动后全量 `git status` |
| `raw/17_status_delta.txt` | 状态增量（仅 2 条 design ` M`） |
| `raw/18_doc_diff.patch` | 文档完整 diff |
| `raw/19_doc_diff_stat.txt`、`raw/21_code_diff_stat.txt` | 文档/代码 `diff --stat` 对照 |
| `raw/20_doc_diff_hunks.txt` | 文档 hunk 头 |
| `raw/22_sha256_triple.txt` | 4 生成物 基线/改前/改后 三方 sha256 + `cmp` |
| `raw/23_block_boundaries.txt` | 映射语义结论 + 块边界表 |
| `raw/24_sandbox_idempotence.txt` | 空 filedb 沙箱两次非 `--force` tangle：148/148 一致 + 幂等 |

---

VERDICT: DONE
