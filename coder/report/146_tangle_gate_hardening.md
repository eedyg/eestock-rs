# 146 — F3 实施：tangle 门禁硬化 + 前端骨架漂移修复

> 报告自身路径：`eestock-rs/coder/report/146_tangle_gate_hardening.md`
> 关联决议：`design/01-architecture/adr/ADR-018-tangle-gate-hardening.md`
>（D-F3-1/2/4/5/6 逐条执行；D-F3-3 = **O1**，用户已拍板：8 份前端骨架保持全文件 tangle 治理）
> 日期：2026-09-12 · entangled 2.4.3（venv）/ 仓库 README 记录 2.4.0
> 纪律：**未 git add / 未 commit**（`git diff --cached` 为空）；`--force` 只在隔离沙箱内使用。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| F3-a 门禁硬化（D-F3-1/2） | 完成。①②用 `tangle -s` dry-run；漂移判据改为**沙箱重新生成 + 逐字节比对**（架构师 2026-09-12 裁决 D1=B）|
| F3-b 漂移修复（D-F3-4） | 完成。用**沙箱 scoped `stitch`** 把实现回写进 2 份 06-web 文档；两份 TSX **逐字节不变**（零回退）|
| F3-c 全仓扫描 | 完成：59 输入 + **151 生成物逐字节比对，drift=0 / missing=0**（修复前=2 drift，正是两份 TSX）|
| F3-d stitch 入口（O1，升为应做） | 完成：新增 `scripts/stitch.sh`（沙箱 scoped + round-trip 校验，**校验失败拒绝回写**）；全局 `entangled stitch` 实测破坏性 → 文档化为 HAZARD |
| F3-e 三态自测（D-F3-5） | 完成：`scripts/tests/test_check_tangle.sh`（**8 态 + 2 附加，38 PASS/0 FAIL**）；`scripts/tests/test_stitch.sh`（**19 PASS/0 FAIL**，含负样例）|
| 验收口径 6 条（架构师）| 逐条对应证据见 §8 |
| F3-f（新增，不阻塞） | 已定位并留证：`design/07-app-plane/{00-web-api,01-mcp}.md` 块内嵌 `~/~ begin` 遗留标记 → 全局 stitch 破坏性成因与影响面见 §6 |

---

## 1. 改动清单（What changed）

### 1.1 修改（tracked，`git diff --stat`）

```
 README.md                     |  64 ++++++++++++++---
 design/06-web/01-dashboard.md |  27 +++++--      （+21 / -6）
 design/06-web/10-simlive.md   |  33 +++++----     （+21 / -12）
 scripts/check-tangle.sh       | 164 +++++++++++++++++++++++++++++++++++++-----
 4 files changed, 245 insertions(+), 43 deletions(-)
```

### 1.2 新增（未跟踪）

| 文件 | 行数 | 作用 |
|---|---|---|
| `scripts/stitch.sh` | 324 | O1 回写入口：沙箱 scoped stitch + round-trip 校验，校验不过拒绝回写 |
| `scripts/lib/entangled_patterns.sh` | 47 | `path_matches`：watch_list 通配符匹配（`**` 需匹配"零个目录"）|
| `scripts/tests/test_check_tangle.sh` | 189 | 门禁 fixture 自测（8 态 + 可复跑 + glob + hook-symlink 回归）|
| `scripts/tests/test_stitch.sh` | 157 | stitch 入口自测（含"校验失败拒绝回写"负样例）|

### 1.3 不动的东西（边界）

- `design/01-architecture/adr/ADR-018-tangle-gate-hardening.md`、`ADR-007`：**未改一个字**（决议内容由架构师维护）。
- 8 份 `web/src/layouts/*.tsx`：**零改动**（见 §3 哈希证据）。
- 治理边界：按 O1 保持**全文件 tangle**（未做 O2 块治理 / O3 移出治理）。
- `.entangled/`：仅"re-baseline 缓存"（§4.4），文件属未版本化缓存，未纳入版本控制。

---

## 2. 架构对齐（Architecture alignment）

本次改动全部落在**工程基建层（门禁/脚本/工程文档）**，不触碰任何分层边界与接口：

- `scripts/*` 属 ADR-007 明示的**手写例外**（不入 tangle 治理）→ 不产生新的生成物依赖。
- 漂移修复只改 **design 事实源文档的代码块内容**（`design/06-web/*.md` 的 L3 块），未改文档结构、
  未改区域契约、未改任何 API/事件契约 → 生成物（TSX）字节不变，Web 层语义零变化。
- 门禁与 stitch 入口均**只依赖 git + entangled CLI**（无新依赖、无框架引入、无 CI 供应商绑定）。
- 文件布局遵循既有约定：`scripts/` 工程脚本、`scripts/tests/` 自测（对齐 `scripts/tests/test_deploy_port_guard.sh`）。

---

## 3. 解决的问题与实现路径

### 3.1 F3-d 先探明：stitch 可用性（证据先行）

**结论：`stitch` 对 TSX 可用（TSX 已在 `entangled.toml` 注册语言 + `//` 注释），但"仓库全局 stitch"是破坏性操作。两条路径都有实测证据。**

#### 路径 A（官方 stitch，scoped）— 可用 ✅

在隔离副本 `/tmp/f3/work`（含 `.entangled`）先 `entangled tangle` 刷新 filedb，再限定输入集 `stitch -f`：

```
[stitch] write `design/06-web/01-dashboard.md`
[stitch] write `design/06-web/10-simlive.md`
# 文档侧吸收实现内容（示例）：
+  period: '15m',  // 周期：1m/5m/15m/1h/1d/1w(周)/1mo(月)，默认 15m
+export type Period = '1m' | '5m' | '15m' | '1h' | '1d' | '1w' | '1mo';
+  enabled: boolean; / favorite?: boolean; / favoriteSort?: number | null;
+  const tabCls = (t: SimLiveTab) => `tab${props.activeTab === t ? ' tab-on' : ''}`;
+  className={`grid min-h-0 flex-1 grid-cols-2 ${props.gridMode === 'grid2x3' ? 'grid-rows-3' : 'grid-rows-2'}`}
# 两份 TSX：sha256 逐字节不变 ✅
```

判据 ①文档块是否吸收实现：**是**（`tabCls`、`1w/1mo`、`enabled/favorite/favoriteSort`、`grid-rows-2/3`）。
判据 ②是否引入无关改动：**否**（上述 hunk 全部落在 L3 代码块内；prose/表格/契约零改动）。
判据 ③`entangled tangle` 是否转为无冲突：**是**（回写后 `tangle` → `Nothing to be done.`）。

#### 路径 B（仓库全局 `entangled stitch`）— **破坏性** ❌

在隔离副本实测（同一份仓库状态）：

```
$ entangled stitch                 # 仓库根，无参数 = 全局
INFO  write `design/07-app-plane/00-web-api.md`
INFO  write `design/07-app-plane/01-mcp.md`
# 结果：上述两份文档的代码块被改写成"裸引用"：
- // ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/tools.rs>>[init]
- ...（-3378 行代码内容）...
+ <<crates/mcp/src/tools.rs>>
$ git diff --stat
 design/07-app-plane/01-mcp.md | 3378 +-------------------
 design/07-app-plane/00-web-api.md | 203 +--
$ entangled tangle                 # 随后直接坏掉
ERROR Cyclic reference in <<crates/app/src/bin/eestock-app.rs[0]>>: crates/app/src/bin/eestock-app.rs[0]
```

其它取证（同批）：
- `stitch` 会被**无关冲突整体阻断**：`WARNING …ADR-018… changed outside the control of Entangled`
  → `ERROR conflicts found, breaking off`，**退出码 0 且什么都不写**（ADR-018 §1 事实 1 复现）。
- `stitch -s`（dry-run）在真实仓库前后都会把 07-app-plane 两份列入 `write`——**误报**（§6 说明）。

→ 据此实现 `scripts/stitch.sh`：**只在临时沙箱内、把 watch_list scope 到候选文档**执行 stitch，
回写前做 round-trip 校验。**未走"人工同步"回退路径**（官方 stitch 可用且已验证）。

### 3.2 F3-b 漂移修复（D-F3-4）

用本次新增入口在真实仓库执行（`scripts/stitch.sh` 无参 = 自动 scoped 到漂移文件所属文档）：

```
[stitch] ⚠️  无参数默认 scoped 回写（不做全局 stitch —— 全局 stitch 已证破坏性，见 --help HAZARD）。
[stitch] 检测到 2 个漂移生成物：web/src/layouts/DashboardGrid.tsx web/src/layouts/SimLiveGrid.tsx
[stitch] round-trip 校验中（全新沙箱：回写后的文档能否重新生成出仓库中的生成物）...
[stitch] ✅ 已回写 2 份文档（沙箱 stitch + round-trip 校验通过）：
  - design/06-web/01-dashboard.md
  - design/06-web/10-simlive.md
   design/06-web/01-dashboard.md | 27 +++++++++++++++++++++------
   design/06-web/10-simlive.md   | 33 +++++++++++++++++++++------------
[stitch] 实现侧生成物一个字节都没动（零回退）。
```

**实现成果零回退（D-F3-4 硬要求）**：

```
$ sha256sum web/src/layouts/DashboardGrid.tsx web/src/layouts/SimLiveGrid.tsx
9fda9247fb28b16f1e83ce49479ad4e27eb73c54135bbb5abc9e44d7648a790c  web/src/layouts/DashboardGrid.tsx
f93402fbed5ed2647b8a949fd45b87ad789ca48d735b8c6df5b900470d143d35  web/src/layouts/SimLiveGrid.tsx
# 修复前基线（/tmp/f3/baseline_hashes.txt）逐字节相同 → diff 为空 ✅
```

验收（ADR D-F3-4）：`entangled tangle` 无冲突（`Nothing to be done.`，rc=0）+ 门禁 `✅`（§4.1）+ TSX 逐字节不变 ✅。

> 过程中的一个**操作陷阱**（已写入 README）：回写文档后，本地 `.entangled`（filedb，未版本化）里
> 记录的仍是"回写前写入内容 digest"，于是 `entangled tangle` 会打印
> `ERROR conflicts found, breaking off`（**rc 仍为 0**，且不写文件）。用 `entangled reset` 重建缓存即恢复
> `Nothing to be done.`（实测 `reset` 只重写 `.entangled/`，仓库内其它文件 sha256 全不变）。
> 门禁自身**不依赖**该缓存，因此不受此陷阱影响。

### 3.3 F3-a 门禁硬化（D-F3-1 / D-F3-2；架构师裁决 D1=B）

`scripts/check-tangle.sh` 新判据：

1. **①②（dry-run，永不写盘）**：`entangled tangle -s` 输出含 `conflicts found` / `ERROR` /
   `not managed by Entangled` / `changed outside the control of Entangled` → 硬失败；
2. **④（权威漂移判据）**：把 `watch_list` 输入 + 目标文件副本 + `.entangled` 拷进 `mktemp -d` 沙箱，
   **清空沙箱 DB** 后 `entangled tangle -f` 重新生成，再与真实仓库**逐字节比对**；
   缺失/不一致即硬失败，列出文件 + 打印两条出路（改文档 → `entangled tangle`；改码 → `./scripts/stitch.sh`）
   + 禁止 `--force` 变绿（D-F3-6）。
3. 失败/成功文案均明示"工作区未被修改"；`entangled` 缺失时保持原有硬失败 + 安装指引。

**为什么要 ④（实测推翻字面 ①②③）**：

| 场景 | 旧门禁（`tangle` + `git diff --quiet`） | 新门禁 |
|---|---|---|
| 真实仓库 + 有 DB + **仅手改生成物**（4d55f17 原例） | `tangle` 打印 `Nothing to be done.` → **✅ 假绿** | ❌ 报出 2 个漂移文件 |
| 干净副本（无 DB）+ 漂移（CI） | 打印 `ERROR conflicts found, breaking off` 后**仍 ✅ 假绿** | ❌ 报出漂移/未托管 |
| 干净副本（无 DB）+ 一致提交 | ✅ | ✅（同样正确）|
| 文档已改、生成物未重 tangle | ❌ 但**门禁自己把生成物覆盖了**（改了工作区）| ❌ 且**不动工作区** |

根因（源码级，已复核）：entangled `io/filedb.py:check()` 比较的是"**上次写入内容的 digest**"，
文档侧未变即判定 target unchanged，**从不检查磁盘上的生成物**；而 `io/transaction.py` 在冲突时
`logging.error(...)` 后 `return`——**退出码 0 且不落盘**。因此：
- 只靠 `tangle` 输出/退出码 → 原例必然假绿；
- 只靠 `git diff` → 既会误报（未提交的文档编辑），又会漏报（pre-commit 已 staged 的漂移），
  更会在"文档侧改动"时**静默回退生成物**。

**可复现性（D-F3-2）**：判据 ④ 与 `.entangled/` 无关（**沙箱故意不拷 filedb**，比对前无条件重新生成），
故真实仓库与 CI 新克隆结果一致（§5 证据 5/6）；`watch_list` 解析、目标路径、`**` 零目录匹配、
临时目录清理（`trap`）均已固定。

**测试阶段发现并修掉的三个门禁缺陷**（均已转为常驻回归用例）：

1. **折不折行假阳性陷阱**：rich 日志按终端宽度折行（`WARNING \`long/path\` not managed by\n Entangled`），
   直接按整词 grep 会**漏报** → 改为"先拉平换行再匹配、命中后按日志级别重新分行展示"。
   （此缺陷是在写 case[7] 时暴露的：先修好它，旧行为才把 case[7] 变成 Red。）
2. **filedb 过期导致假阳性**：最初把仓库 `.entangled` 拷进沙箱，于是"文档与生成物其实一致、只是
   本地缓存旧（刚用 `stitch` 回写过）"的仓库会报 `changed outside the control of Entangled` → 硬失败。
   **已改为沙箱不拷 filedb**：空 DB 下 dry-run 的 `not managed by Entangled` 就等价于"磁盘生成物 ≠
   文档重新生成结果"（漂移语义），既无假阳性，也与本地状态无关。常驻用例 case[7] `stale-db` 锁定。
3. **hook symlink 场景依赖解析失败**：pre-commit 是 symlink（`.git/hooks/pre-commit →
   ../../scripts/check-tangle.sh`），`dirname "$BASH_SOURCE"` 会指向 `.git/hooks/` → 找不到
   `scripts/lib/`（实测报 `No such file or directory`，干净态也会失败）。**已改为 `readlink -f` 解析
   真实路径 + 缺依赖时硬失败**；常驻用例 case[8] `hook-symlink` 锁定（并断言真实仓库已安装的 hook 可用）。

### 3.4 F3-d stitch 入口（O1 最低摩擦）

```
用法：./scripts/stitch.sh [--all|<code-file> ...]      # 无参 = 只回写"检测到漂移"的文件所属文档
```
- **默认 scoped**，并显式警告"全局 stitch 已证破坏性，本脚本仅做沙箱 scoped 回写"（架构师归档要求）；
- `--help` 内置 **O1 纪律操作说明**（改文档 → `entangled tangle`；改码 → `./scripts/stitch.sh`）
  + HAZARD（全局 stitch / `--force` / filedb 缓存过期）——任何 agent 照同一套流程执行；
- 流程：选候选 → **跳过块内嵌 `~/~ begin` 文档**（告警）→ 沙箱 A（scope 到候选文档）`stitch -f`
  → **全新沙箱 B round-trip 校验**（清空 DB + `tangle -f`，生成物必须与仓库逐字节一致）
  → 仅把有变化的文档拷回；生成物零改动。

---

## 4. 测试与验证（Test coverage / Verification）

### 4.1 新增/更新的测试

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `scripts/tests/test_check_tangle.sh` | 8 态：clean-db / clean-no-db / silent-drift（假绿原例）/ conflict / empty-db-drift（CI）/ doc-side-drift / **stale-db（缓存过期不误报）** / **hook-symlink（pre-commit 安装方式）** + 可复跑 + glob 回归 | **PASS=38 FAIL=0** |
| `scripts/tests/test_stitch.sh` | 默认 scoped 回写（T1）/ 显式 scoped（T2）/ **校验失败拒绝回写（T3 负样例）** / 无漂移（T4）/ `--help` O1+HAZARD（T5） | **PASS=19 FAIL=0** |

每个失败态除退出码与文案外，还断言**门禁未修改工作区**（跑前/跑后全文件 sha256 指纹一致）。

### 4.2 Red → Green（先证明现门禁假绿，再实现）

```
$ GATE_UNDER_TEST=/tmp/f3/check-tangle.OLD.sh bash scripts/tests/test_check_tangle.sh   # 旧门禁（HEAD 版）
  ❌ silent-drift: 期望硬失败，实际 rc=0（假绿）          # 原例
  ❌ conflict:    期望硬失败，实际 rc=0（假绿）
  ❌ empty-db-drift: 期望硬失败，实际 rc=0（假绿）
  ❌ empty-db-drift: 门禁改动了工作区
  ❌ doc-side-drift: 门禁改动了工作区
===== test_check_tangle: PASS=20 FAIL=13 =====

$ bash scripts/tests/test_check_tangle.sh                                              # 新门禁
===== test_check_tangle: PASS=38 FAIL=0 =====
```
`check-tangle.OLD.sh` = `git show HEAD:scripts/check-tangle.sh`（可复现 Red）。
新门禁自身的两个"仅测试期才能发现"的缺陷也留下了 Red→Green 轨迹：

```
# case[7] stale-db：文件内容一致、仅本地 filedb 过期 → 必须放行
（沙箱拷 filedb 的版本）  ❌ stale-db: 期望放行，实际 rc=1     ← 假阳性
（不拷 filedb 的最终版）  ✅ stale-db: 退出码 0（放行）

# case[8] hook-symlink：pre-commit symlink 安装方式
GATE_UNDER_TEST=/tmp/f3/naive/check-tangle.sh …   # naive dirname(BASH_SOURCE) 版本
  ❌ hook-symlink: rc=1 / ❌ 依赖解析失败（缺少 scripts/lib/…）
（readlink -f 最终版）  ✅ hook-symlink: 干净态放行 / ✅ 依赖解析正常 / ✅ 漂移态硬失败
```
旧门禁"改动工作区"的取证（doc-side-drift 态，生成物被门禁覆盖）：

```
--- code file BEFORE old gate ---   export const A = 1;
--- code file AFTER  old gate ---   export const A = 42;   # 门禁把生成物改了
```

### 4.3 命令与输出（已完成）

```
1) bash scripts/tests/test_check_tangle.sh              → PASS=38 FAIL=0
2) bash scripts/tests/test_stitch.sh                    → PASS=19 FAIL=0
3) bash .git/hooks/pre-commit           （真实仓库已安装 symlink）→ ✅ rc=0，工作区指纹不变
4) ./scripts/check-tangle.sh            （真实仓库）     → ✅ rc=0
5) sha256sum web/src/layouts/{DashboardGrid,SimLiveGrid}.tsx → 与修复前基线逐字节相同
6) git diff --cached --stat                              → 空（未 stage，遵任务纪律）
```

端到端原例复刻（仓库副本，未影响真实仓库）：

```
A) 有 DB + 只手改 DashboardGrid.tsx（未提交）→ ❌ rc=1：WARNING … not managed by Entangled
B) 同上但已提交                         → ❌ rc=1（不是靠 git diff，而是靠重新生成比对）
C) 回退探针                            → ✅ rc=0
```

### 4.4 干净副本 / CI 复核（D-F3-2）

```
# 全新 clone（无 .entangled）+ HEAD 版文档（漂移态）
$ ./scripts/check-tangle.sh
[check-tangle] ❌ entangled dry-run 报告冲突/未托管：WARNING `web/src/layouts/DashboardGrid.tsx` not managed by Entangled …
rc=1                     # 旧门禁此处为 ✅（假绿）

# 全新 clone（无 .entangled）+ 修复后文档
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
rc=0                     # 工作区 sha256 全量指纹不变；门禁**未创建** .entangled/
```

### 4.5 F3-c 全仓扫描结论

```
SCAN（沙箱 tangle -f + 全量逐字节比对）:
  inputs(watch_list)=59   generated_compared=151   drift=0   missing=0
修复前同一扫描:           generated_compared=139   drift=2   missing=0   → 恰为两份 TSX
```
交叉验证：
- `entangled tangle -s`（真实仓库，有 DB）：`Nothing to be done.`（**对漂移完全失明**，正是假绿机理）；
  干净副本：对两份 TSX 报 `not managed by Entangled` + `create`（其余 137 个无异常）。
- `entangled stitch -s`：真实仓库列 4 份文档 = 2 份真漂移 + 2 份 07-app-plane 遗留污染（**误报**）；
  修复 + `reset` 后仅列 2 份遗留污染 → 说明 **stitch 输出不能作为门禁判据**（④ 才是）。
- 结论：**除这两份外无其它被 break off 掩盖的失同步文件**（151/151 一致；0 缺失）。

---

## 5. 风险与残余（Residual risks）

1. **07-app-plane 两份文档的遗留标记（F3-f，非漂移）**：见 §6。当前不影响门禁（④ 与 DB/块格式无关，
   两份文档的生成物 `crates/mcp/src/tools.rs`、`crates/app/src/bin/eestock-app.rs` 实测 in-sync），
   但会污染 `stitch -s` 判定，并使**全局 stitch** 破坏性。`scripts/stitch.sh` 已对其硬跳过 + 告警。
2. **门禁成本**：每次运行多一次沙箱 `tangle -f`（本仓库 design 3.3M / 151 生成物，实测 < 2s，可接受）。
   若未来 design/ 数量级增长，需评估（可缓存/增量）。
3. **沙箱依赖外部命令**：`entangled` + GNU `cp/find/sed/grep/cmp` + `mktemp`（Linux/CI 常规）；
   `readlink -f` 不可用时回退到 `dirname(BASH_SOURCE)`（此时 symlink 安装需保证脚本与 `lib/` 同目录树——
   已加缺失依赖硬失败保护）。
4. **watch_list 解析**：门禁用单行 `watch_list = [...]` 解析；若改为多行 TOML 数组会 `die`（硬失败而非静默放行）。
   已加"根为仓库根 / 绝对路径 / `..`"防护。
5. **hook 安装**：`.git/hooks/pre-commit` 是本地 symlink，不随克隆分发（README 已注明）；CI 需显式调用
   `./scripts/check-tangle.sh`。
6. **未提交状态**：本报告所有改动均**未 stage/未 commit**，留给评审；`.entangled/` 为本地缓存，
   其内容（re-baseline 后）不影响门禁与任何版本化产物。

---

## 6. F3-f 取证：`design/07-app-plane/{00-web-api,01-mcp}.md` 块内嵌遗留标记

**现象/成因（实测）**
- 这两份文档的 fenced `file=` 块里**嵌着 entangled 自己的注释标记**：
  `01-mcp.md:375-376` 两条 `// ~/~ begin <<…#crates/mcp/src/tools.rs>>[init]`、`3750-3751` 两条 `// ~/~ end`；
  `00-web-api.md:4613 / 4814` 一对（对应 `crates/app/src/bin/eestock-app.rs`）。
- 对应生成物文件同样带**重复标记**：`crates/mcp/src/tools.rs` 行 1-3 三连 `begin`、行 3377-3379 三连 `end`
  （`eestock-app.rs` 为双份）。即历史上某次"回写/搬运"把生成物的注释标记连同代码一起写进了文档块，
  之后每次 tangle 又按标记重新包裹 → 标记逐层累积。
- 影响面（两条，均已实测）：
  1. **全局 `entangled stitch` 会破坏内容**：`load_code` 把这些块当作"引用段"读入，回写时渲染成**裸引用**
     `<<crates/mcp/src/tools.rs>>`（-3378 行）与 `<<crates/app/src/bin/eestock-app.rs>>`（-203 行）；
     后者是**自引用**，使后续 `entangled tangle` 直接失败：`ERROR Cyclic reference in <<crates/app/src/bin/eestock-app.rs[0]>>`。
  2. **污染 `stitch` 判定**：`stitch -s` 恒把这两份列为 `write`（误报），但**不污染门禁**——
     门禁 ④ 是"文档重新生成的字节 vs 仓库字节"，两份文档的生成物实测 in-sync（§4.5），故门禁正确放行。
- 处理：本次**不改动**这两份文档（避免把 F3 扩成文档重构）；`scripts/stitch.sh` 对"块内含 `~/~ begin`"
  的文档**硬跳过 + 告警**，并在 README/`--help` 写明"禁止全局 stitch"。后续项（F3-f）建议：清掉这些
  块内的标记行并核对生成物不变，届时全局 stitch 方可安全。

---

## 7. 复现步骤（Reviewer quick path）

```bash
cd eestock-rs
# 1) 看 Red：旧门禁在 4 个失败态假绿/改工作区
GIT_SHOW_OLD=$(git show HEAD:scripts/check-tangle.sh) ; echo "$GIT_SHOW_OLD" > /tmp/check-tangle.OLD.sh
GATE_UNDER_TEST=/tmp/check-tangle.OLD.sh bash scripts/tests/test_check_tangle.sh   # PASS=20 FAIL=13
# 2) 看 Green：新门禁 + stitch 入口
bash scripts/tests/test_check_tangle.sh      # PASS=38 FAIL=0
bash scripts/tests/test_stitch.sh            # PASS=19 FAIL=0
./scripts/check-tangle.sh                    # ✅ rc=0（真实仓库）
bash .git/hooks/pre-commit                   # ✅ rc=0（symlink 安装方式）
# 3) 干净副本（CI）
git clone -q . /tmp/ci-f3 && cp design/06-web/0{1-dashboard,10-simlive}.md /tmp/ci-f3/design/06-web/ \
  && cd /tmp/ci-f3 && cp ../scripts/check-tangle.sh scripts/ && mkdir -p scripts/lib \
  && cp ../scripts/lib/entangled_patterns.sh scripts/lib/ && ./scripts/check-tangle.sh   # ✅ rc=0
# 4) 零回退
sha256sum web/src/layouts/{DashboardGrid,SimLiveGrid}.tsx   # 与 9fda9247…/f93402fb… 相同
git status --porcelain --untracked-files=no      # 仅 README/2 文档/check-tangle.sh
```

---

## 8. 验收口径对照（架构师 2026-09-12 裁决的 6 条）

| # | 口径 | 证据 | 结果 |
|---|---|---|---|
| ① | 门禁在真实仓 + 干净副本两处都对（含原例必须**红**）| 真实仓：`./scripts/check-tangle.sh` / `bash .git/hooks/pre-commit` → ❌（修前，列出 2 个 TSX）/ ✅（修后）；干净副本（新 clone，无 `.entangled`）：HEAD 版文档 → ❌ rc=1，修后文档 → ✅ rc=0；原例（有 DB + 只手改生成物，未提交/已提交）→ ❌ rc=1（仓库副本端到端复刻）| ✅ |
| ② | 两份 TSX **逐字节不变** | `sha256sum` 与修复前基线完全一致（9fda9247… / f93402fb…），`git status` 无 TSX 改动 | ✅ |
| ③ | 门禁三态自测可复跑 | 8 态 fixture（含 干净 / 冲突 / 空DB）+ 可复跑断言：`PASS=38 FAIL=0`，确定性（`mktemp` 隔离 + 固定 fixture）| ✅ |
| ④ | 门禁不修改工作区 | 每例断言跑前/跑后全文件 sha256 指纹一致（含 `.entangled`）；新 clone 验证：门禁**未创建** `.entangled/`；旧门禁在 doc-side-drift 态把生成物改了（A=1 → A=42）——已作为反例锁进测试 | ✅ |
| ⑤ | 全仓扫描结论 | 59 输入 / **151 生成物逐字节比对，drift=0 missing=0**（修前 139/2）；`tangle -s`、`stitch -s`、`status` 交叉验证见 §4.5 | ✅ |
| ⑥ | stitch 入口校验失败时拒绝回写（负样例）| `test_stitch.sh` T3：文档声明了仓库中缺失的生成物 → round-trip 校验失败 → **rc≠0，文档与生成物逐字节不变**，输出说明失败原因 | ✅ |

额外交付（steering 要求）：`scripts/stitch.sh` 默认 **scoped** + 无参时明确警告"全局 stitch 已证破坏性"；
`--help` / README / 本报告均含 **O1 纪律操作说明**（改文档 → `entangled tangle`；改码 → `./scripts/stitch.sh`）
与 HAZARD（全局 stitch / `--force` / filedb 缓存过期）。
