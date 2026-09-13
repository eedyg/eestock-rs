# P0 机制验证执行报告：entangled 对 js 产物的门禁有效性（只验不改）

- **报告文件自身路径**：`tester/test/038_p0_js_tangle_gate_mechanism_execution.md`
- **执行时间**：2026-09-13 14:58 ~ 15:00 CST（原始全部日志保留在 `/tmp/p0_probe/`，仓库外）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **commit**：`8745fd5`（执行期间 **未** 做任何 git add / commit / stash；`git diff` 为空）
- **依据**：`design/14-dcap-indicator/01-adr.md` D3/D3'、`03-test-plan.md` T9、`05-issue-drafts.md` #1、`design/01-architecture/adr/ADR-018-tangle-gate-hardening.md` §1/§2（D-F3-1、D-F3-1a、D-F3-2、D-F3-6）
- **性质**：机制验证（探针 + 既有门禁执行）。**未新增任何常驻测试、未改任何实现/契约/配置**；探针已删除。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| entangled 版本 | 2.4.3（`/home/eestock/.local/bin/entangled` → uv tool python3.13） |
| `js` 是否内置语言 | **是**：`Language("Javascript", ["javascript","js","ecma"], Comment("//"))`（`entangled/config/language.py:46`），`entangled.toml` **无需改动** |
| `{.js file=…}` 能否生成产物 | **能**：`INFO create \`web/src/features/indicators/zz_p0_probe.js\``，产物 = 块正文 + entangled `//` 标记行 |
| 门禁能否抓「手改产物不回写文档」 | **能**：`check-tangle` exit=**1**，点名该文件 |
| 门禁能否抓「改文档不重跑 tangle」 | **能**：`check-tangle` exit=**1**，点名该文件 |
| 门禁能否抓「产物被删除（文档仍声明）」 | **能**：exit=**1**，报「1 个缺失」 |
| ADR-018 假绿回归（js 产物类型） | **假绿在旧判据下可复现（旧判据 exit=0）**；**新门禁在同一状态 exit=1** ⇒ 新门禁对 js 产物**不假绿** |
| 崩溃 / core dump | **无** |
| 工作树残留 | `git status --porcelain` 前后**逐字一致**；无新未跟踪文件；探针文件/目录全删 |

**总判定：js 产物门禁有效（有效），且不引入 ADR-018 的假绿。**

## 1. 步骤与证据（命令 + 原始输出片段）

### 步骤 1：版本与 js 语言可用性

```
$ entangled --version
Entangled 2.4.3

$ head -1 /home/eestock/.local/bin/entangled
#!/home/eestock/.local/share/uv/tools/entangled-cli/bin/python

$ grep -n "Javascript" /home/eestock/.local/lib/python3.12/site-packages/entangled/config/language.py
46:    Language("Javascript", ["javascript", "js", "ecma"], Comment("//")),

$ grep -n "languages" /home/eestock/.local/lib/python3.12/site-packages/entangled/config/config_data.py
39:    languages: dict[str, Language] = field(default_factory=lambda: {
40:        i: lang for lang in languages for i in lang.identifiers
```

本仓 `entangled.toml` 的 `[[languages]]` 仅注册 SQL / Dockerfile / TSX / HTML，**本轮未修改该文件**（`git diff` 为空）。

### 步骤 2：探针生成（`{.js file=…}` → js 产物）

探针文档（临时）`design/14-dcap-indicator/zz_p0_probe.md` 内含：

````
``` {.js file=web/src/features/indicators/zz_p0_probe.js}
// zz_p0_probe — entangled js language probe (P0 gate verification; temporary)
```
````

**2.1 解析确认（dry-run，永不写盘）**

```
$ entangled tangle -s
INFO     create `web/src/features/indicators/zz_p0_probe.js`
INFO     nothing is done                     # -s 只是 dry-run
```

**2.2 首次 in-repo `entangled tangle` 被既有本地 filedb 状态阻断（重要观察，非本轮引入）**

```
$ entangled tangle
INFO     write `web/src/layouts/SettingsGrid.tsx`
INFO     write `crates/storage/tests/kline_reader.rs`
INFO     write `crates/web/src/lib.rs`
INFO     create `web/src/features/indicators/zz_p0_probe.js`
WARNING  `web/src/layouts/SettingsGrid.tsx` changed outside the control of Entangled
WARNING  `crates/storage/tests/kline_reader.rs` changed outside the control of Entangled
WARNING  `crates/web/src/lib.rs` changed outside the control of Entangled
ERROR    conflicts found, breaking off (use `--force` to run anyway)
EXIT=0                                        # ← ADR-018 §1.1 的形态：ERROR 但退出码 0，且一个文件都没写
$ ls web/src/features/indicators/
ls: cannot access 'web/src/features/indicators/': No such file or directory
```

这 3 个文件是 **本地 `.entangled/filedb.json` 记录过期**（盘上内容与文档重新生成结果**逐字节一致**——由步骤 2.4 的基线/回归门禁 exit=0 证明），与本轮探针无关。为让 js 链路在本仓真实跑通（且**不使用 `--force`**），本轮采用「临时把 `.entangled` 换成空 DB」的方式预检后出产物；`.entangled` 已在清理阶段**逐字节还原**（见 §3）。

**2.3 空 DB 预检 + 正式 tangle（无 `-f`/`--force`）**

```
$ mv .entangled /tmp/p0_probe/entangled_stash
$ entangled tangle -s                      # 预检：与 sandbox 空 DB 行为一致
EXIT=0 ; 计划写入行数=145 ; warnings("changed outside")=0
INFO     create `web/src/features/indicators/zz_p0_probe.js`

$ entangled tangle
EXIT=0
INFO     create `web/src/features/indicators/zz_p0_probe.js`

$ ls -l web/src/features/indicators/zz_p0_probe.js
-rw------- 1 eestock eestock 198 Sep 13 14:59 web/src/features/indicators/zz_p0_probe.js

$ cat -A web/src/features/indicators/zz_p0_probe.js
// ~/~ begin <<design/14-dcap-indicator/zz_p0_probe.md#web/src/features/indicators/zz_p0_probe.js>>[init]$
// zz_p0_probe M-bM-^@M-^T entangled js language probe (P0 gate verification; temporary)$
// ~/~ end$
```

块正文与产物 `diff` 仅差 entangled 的两行标记（`//` 前缀 = 已按 js 语言注释风格写出）：

```
$ diff <(cat web/src/features/indicators/zz_p0_probe.js) /tmp/p0_probe/probe_block_body.txt
1d0
< // ~/~ begin <<design/14-dcap-indicator/zz_p0_probe.md#web/src/features/indicators/zz_p0_probe.js>>[init]
3d1
< // ~/~ end
```

**2.4 副作用核查**：既有 144 个生成物 **逐字节未变**

```
$ <sha256sum 144 个 file= 目标，tangle 前后各一遍>
$ diff -q hashes_before.txt hashes_after.txt
IDENTICAL: 144/144 既有生成物逐字节未变（in-repo tangle 无副作用）
$ git status --porcelain
?? .claude/ ... ?? design/14-dcap-indicator/ ... ?? tester/test/ ?? web/src/features/indicators/   # 仅新增探针目录
```

探针产物在位且与文档一致时，门禁为绿（证明**合法产物不误报**）：

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT_F=0
```

### 步骤 3：两个方向的漂移都被硬失败捕获

**(a) 手改生成物、不回写文档 → 红**

```
$ printf '// HAND-EDIT: drifted product, doc not updated\n' >> web/src/features/indicators/zz_p0_probe.js
$ ./scripts/check-tangle.sh
EXIT_G=1
[check-tangle] ❌ entangled dry-run 报告冲突/未托管（生成物与 design/ 文档失同步）：
WARNING `web/src/features/indicators/zz_p0_probe.js` not managed by Entangled INFO nothing is done
```

**(b) 只改文档块、不重跑 tangle → 红**

```
$ <把探针 md 块内注释改为 "// zz_p0_probe — DOC-ONLY EDIT, product not re-tangled"，不跑 tangle>
$ ./scripts/check-tangle.sh
EXIT_I=1
[check-tangle] ❌ entangled dry-run 报告冲突/未托管（生成物与 design/ 文档失同步）：
WARNING `web/src/features/indicators/zz_p0_probe.js` not managed by Entangled INFO nothing is done
```

**(c) 追加覆盖：产物文件被删除（文档块仍声明）→ 红（走的是「逐字节/缺失」权威判据，不是 dry-run）**

```
$ mv web/src/features/indicators/zz_p0_probe.js /tmp/p0_probe/17_probe_js_removed.bak
$ ./scripts/check-tangle.sh
EXIT_L=1
[check-tangle] ❌ 0 个漂移 + 1 个缺失。
design/ 文档声明但仓库中缺失的生成物：
  - web/src/features/indicators/zz_p0_probe.js
```

**(a)(b)(c) 均为「恢复后复检回绿」**（排除门禁"粘滞变红"）：

| 复检点 | 命令 | 退出码 |
|---|---|---|
| 恢复产物后 | `./scripts/check-tangle.sh` | 0 |
| 恢复文档块后 | `./scripts/check-tangle.sh` | 0 |
| 恢复被删产物后 | `./scripts/check-tangle.sh` | 0 |

### 步骤 4：ADR-018「假绿」回归（js 产物类型）—— 在 `/tmp` 隔离沙箱内

沙箱 `/tmp/p0_probe/sbx_falsegreen`：拷贝 `entangled.toml` + `design/` + **温 `.entangled`（filedb）** + 全部 file= 目标 + `scripts/`，`git init -q`（**仅为满足 `check-tangle.sh` 的 `git rev-parse --show-toplevel`；全程无 add/commit/stash**）。复现 ADR-018 D-F3-1a 原发形态：**有 DB + 仅手改生成物（文档侧未变）**，产物类型 = js。

```
$ printf '// HAND-EDIT: drifted js product, doc not updated\n' >> web/src/features/indicators/zz_p0_probe.js

# 旧门禁判据 = `entangled tangle` 之后 `git diff --quiet`
$ entangled tangle
EXIT=0
INFO     Nothing to be done.                        # ← 温 DB 认为文档未变，根本不看磁盘上的产物
$ <工作区所有文件 sha256 前后比对>
工作区零改动 => 旧判据 `git diff --quiet` 退出码 = 0 => 旧门禁打印 ✅（假绿复现）

# 同一漂移状态下的新门禁
$ ./scripts/check-tangle.sh
NEW_GATE_EXIT=1
[check-tangle] ❌ entangled dry-run 报告冲突/未托管（生成物与 design/ 文档失同步）：
WARNING `web/src/features/indicators/zz_p0_probe.js` not managed by Entangled INFO nothing is done
```

⇒ **js 产物类型下旧判据假绿可复现、新门禁在同一状态变红：不引入假绿。** 沙箱内亦复现了 ADR-018 §1.1 的「ERROR 但 exit=0」（见 §2.2），本轮真实仓输出与之同形。

### 步骤 5：清理与残留证明

```
$ rm design/14-dcap-indicator/zz_p0_probe.md
$ rm web/src/features/indicators/zz_p0_probe.js
$ rmdir web/src/features/indicators
removed empty dir web/src/features/indicators
$ rm -rf .entangled && mv /tmp/p0_probe/entangled_stash .entangled

$ ./scripts/check-tangle.sh          # 清理后
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT_O=0

$ diff -u git_status_before.txt git_status_after.txt
IDENTICAL: git status --porcelain 前后完全一致
$ git diff --stat ; echo "git diff exit=$?"
git diff exit=0                       # tracked 文件内容零改动
$ sha256sum .entangled/filedb.json /tmp/p0_probe/filedb.backup.json
2581f08c14631dfce6c272beb2ecc7aab3f51f253431415f4e1ddea31eec1901  .entangled/filedb.json
2581f08c14631dfce6c272beb2ecc7aab3f51f253431415f4e1ddea31eec1901  /tmp/p0_probe/filedb.backup.json
$ find . -path ./.git -prune -o -name "*zz_p0*" -print
（空）
$ find . -path ./.git -prune -o -type f -newermt '2026-09-13 14:57' -print | (tracked/untracked 分类)
UNTRACKED ./.entangled/filedb.lock                                  # gitignore 的 0 字节锁文件
UNTRACKED ./logs/app_dev_8081_redeploy_20260913_133146.log          # 既有进程正在追写的日志（基线 `?? logs/`）
```

**清理前后 check-tangle 退出码：清理前（探针在位且一致）= 0；清理后 = 0**（中间三次故意漂移各 = 1）。工作树无探针残留；mtime 层面仅 2 个仓库外/无关的已 gitignore 文件，tracked 文件 mtime 亦未被改动（entangled 对既有产物做了 no-op 跳过，144/144 sha256 未变）。

## 2. 用例结果表

| # | 用例 | 期望 | 实测退出码 | 判定 |
|---|---|---|---|---|
| P0-1 | `entangled --version` / js 是否内置 | 2.4.3 / 内置 | — | PASS |
| P0-2 | `{.js file=…}` 解析并生成产物 | 产物出现且=块正文+标记 | tangle 0，产物存在 | PASS |
| P0-3 | 一致状态门禁 | 0 | 0 | PASS |
| P0-4 | 方向(a) 手改产物 | 非 0 | 1 | PASS |
| P0-5 | 方向(b) 只改文档 | 非 0 | 1 | PASS |
| P0-6 | 方向(c) 产物被删 | 非 0 | 1 | PASS |
| P0-7 | 三次恢复后复检 | 0 | 0 / 0 / 0 | PASS |
| P0-8 | ADR-018 假绿回归（js，温 DB+手改产物） | 旧判据 0；新门禁非 0 | 旧 0；新 1 | PASS（无假绿） |
| P0-9 | 清理后门禁 | 0 | 0 | PASS |
| P0-10 | 工作树残留 | 无 | porcelain 前后一致 | PASS |

**崩溃 / core dump：无。** 跳过用例：无。覆盖率工具：不适用（本轮为门禁机制验证，非代码单测）。

## 3. 未做的（遵约束）与残余风险

- 未改 `entangled.toml`、未改任何实现/接口/契约/阈值/Policy/`/api/config/ma`；未 `git add/commit/stash`；未启动 8081/8082；未使用 `entangled tangle --force` 于真实仓库（`--force` 仅出现在 `/tmp` 隔离沙箱与既有 `check-tangle.sh` 自身的沙箱逻辑中）。
- **残余风险 1（既有状态，非本轮引入）**：本仓本地 `.entangled/filedb.json` 对 `web/src/layouts/SettingsGrid.tsx`、`crates/storage/tests/kline_reader.rs`、`crates/web/src/lib.rs` 已过期 ⇒ 真实仓内 `entangled tangle`（无 `-f`）会 `ERROR conflicts found, breaking off`（exit=0）而**不写任何文件**。这会让开发者在真实仓内"跑了 tangle 但什么都没生成"。门禁不受影响（沙箱空 DB，ADR-018 D-F3-2），但**新 js 产物首次 in-repo 生成可能因此被静默阻断**，需架构师决定是否 `entangled reset` / 重新 tangle 一次以刷新本地 filedb（本轮未擅自做，仅临时替换并已还原）。
- 残余风险 2：`.entangled/filedb.lock` 的 mtime 因本轮操作被更新（0 字节、gitignore、非版本化）。
- 残余风险 3：本轮只验证了**单文件、1 行注释**的最小 js 产物；未验证多块同名/同文件扇出、未验证大体积 js（ADR-021 D4 的双产物）——属后续 #2 的范围。

---

**报告自身路径**：`tester/test/038_p0_js_tangle_gate_mechanism_execution.md`
**原始证据（仓库外）**：`/tmp/p0_probe/`（`00_dryrun_baseline.txt` … `20_checktangle_after_cleanup.txt`、`filedb.backup.json`、`targets_backup.tgz`）

VERDICT: PASS
