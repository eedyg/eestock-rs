# 150 — F3-f：entangled 标记嵌套污染清理

- **报告自身路径**：`coder/report/150_f3f_marker_cleanup.md`
- 任务依据：ADR-018 §4「F3-f（另项）」+ §6；用户任务书「实施 F3-f」
- 状态：**完成**（门禁绿、语义零漂移、沙箱全局 stitch 破坏模式已消除）
- 日期：2026-09-12
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`

---

## 1. 需求 / 问题

`design/07-app-plane/{00-web-api,01-mcp}.md` 的 `file=` 代码块内**内嵌** `~/~ begin/end` 标记行
（历史全局 stitch 遗留）。entangled tangle 把块内内容（含标记）原样写入生成物，导致生成物累积标记；
全局 `entangled stitch` 因解析错乱把这些块改写成**自引用** `<<crates/...>>`，随后 `entangled tangle`
死于 `ERROR Cyclic reference`（F3 立案时发现的 HAZARD）。

本次目标：清掉**文档代码块内**的标记 + 由生成器重建生成物，且**代码语义零改动**，并验证全局 stitch 不再破坏。

## 2. 全仓标记清单（修复前 = Red 基线）

枚举范围 `design/**`、`crates/**`、`web/**`，按 `~/~ begin|end` 逐条分类：

| 类别 | 位置 | 判定 |
|---|---|---|
| **(a) 文档代码块内 = 污染** | `design/07-app-plane/01-mcp.md`：`crates/mcp/src/tools.rs` 块内 **2×begin（L384/385）+ 2×end（L3905/3906）**；`design/07-app-plane/00-web-api.md`：`crates/app/src/bin/eestock-app.rs` 块内 **1×begin（L4656）+ 1×end（L4861）** | 须清（本次对象，共 6 行） |
| **(b) 生成物注解 = 期望** | `crates/**` + `web/src/layouts/*.tsx` 约 60 份生成物各**恰 1 组** begin/end；**例外**：`crates/mcp/src/tools.rs` = 3 组（6 行）、`crates/app/src/bin/eestock-app.rs` = 2 组（4 行） | 清污染后须恰 1 组 |
| **(c) 散文提及** | `design/01-architecture/adr/ADR-018-*.md` 正文 §1.9、§4（`~/~ begin` 字样） | 保留 |
| **(d) `design/**/preview/*.html`** | `design/06-web/preview/*.html`(7 份) + `design/11-sim-live/preview/*.html`(2 份)，各恰 1 组 `<!-- ~/~ begin <<...>> -->` / `end` | 判定为 **tangle 生成物**：出处是 `design/06-web/*.md`、`design/11-sim-live/01-adr.md` 中声明生成物的代码块，且 9 份均在 `.entangled/filedb.json` 中登记。**非污染、非设计资产**，符合预期，保留 |

**附带发现（超出 F3-f 范围，仅登记）**：`crates/web/src/settings.rs`、`crates/web/tests/api_settings.rs`
各含 **1 行孤立 begin**（无对应 end；`design/06-web/08-settings.md` 已无对应生成物声明块，二者亦不在 filedb 中）。
二者不受 tangle 治理、也未被全局 stitch 触碰（无块可回写）。属独立治理缺口，**本次未处理**。

### 修复后清单

- 文档（`design/**/*.md`）代码块内标记：**0**（仅剩 ADR-018 散文提及，含本次新增 §7 的说明文字）。
- 生成物：`crates/mcp/src/tools.rs`、`crates/app/src/bin/eestock-app.rs` 均**恰 1 组 begin/end**；其余生成物不变。
- `preview/*.html`：9 份各恰 1 组（不变）。

## 3. 修复

- **只改文档代码块**：删除 (a) 的 6 个标记行（`01-mcp.md` 4 行、`00-web-api.md` 2 行）。**未手改任何生成物**。
  - 两份文档的 diff **仅**为这 6 行的删除（见 §5 验证）。
- 随后 `entangled tangle` 由生成器重建：`crates/mcp/src/tools.rs`（6→2 行标记）、
  `crates/app/src/bin/eestock-app.rs`（4→2 行标记）；**其余生成物零改动**。
- ADR-018 追加 §7（处置记录 + stitch 可用范围），未改既有决议文字。

## 4. 语义零漂移证据（关键）

对两份重建生成物做**忽略标记行**（`grep -v '~/'` 过滤 `~/~` 行）的逐字节比对：

| 生成物 | 修复前 filtered sha256 | 修复后 filtered sha256 | 结论 |
|---|---|---|---|
| `crates/mcp/src/tools.rs` | `da0396a4aeeb27865976cc3e3e73f17346004a2fb014d165f65e552bdafaab40` | `da0396a4aeeb27865976cc3e3e73f17346004a2fb014d165f65e552bdafaab40` | **完全一致** |
| `crates/app/src/bin/eestock-app.rs` | `dda3af6117f082fc6c9f7a190a9af35c9d8a6809e2901363714e0e86e425370f` | `dda3af6117f082fc6c9f7a190a9af35c9d8a6809e2901363714e0e86e425370f` | **完全一致** |

原始（含标记行）sha256 修复前：`tools.rs=a34228fd…3937`、`eestock-app.rs=91be62ca…3a0e5`
→ 修复后仅标记行减少，故原始哈希变化，过滤后哈希不变 = **本次只清标记、代码语义零改动**。

## 5. 终态验证

### ① tangle 幂等
`entangled tangle` 连跑两次，第二次/第三次均 `INFO Nothing to be done.`（无 write、无 ERROR）。

### ② 门禁
`./scripts/check-tangle.sh` → `✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。` exit 0。
（修复前基线亦为绿——印证 ADR-018 §1.9：污染在文档↔生成物两侧"自洽"，门禁抓不到，故须专门清理。）

### ③ 沙箱全局 `entangled stitch`（F3-f 成败判据）

修复前对照（隔离副本实测）：全局 stitch 把 `01-mcp.md`（4996→1474 行）、`00-web-api.md`（5749→5544 行）
改写成自引用 `<<crates/mcp/src/tools.rs>>` / `<<crates/app/src/bin/eestock-app.rs>>`，随后 tangle
`ERROR Cyclic reference`。

修复后（隔离副本，三种场景）：

| 场景 | 结果 |
|---|---|
| ① DB 同步态，直接全局 stitch | `Nothing to be done`，文档零改动 |
| ② DB 陈旧，直接全局 stitch | 仅报 `changed outside the control of Entangled` 冲突并 break off；`01-mcp.md`/`00-web-api.md` **未**被改写为自引用（`^<<` 计数 0），行数保持 4992/5747；随后 tangle 正常再生（无 Cyclic） |
| ③ 强制写回路径（块内注入代码侧探针 → stitch） | 探针**正确回写进文档块**（非自引用）；两份生成物内容不变；随后 tangle 无 `Cyclic reference`，二次 tangle `Nothing to be done` |

**结论**：自引用 + 循环引用破坏模式**已消除**，F3-f 成败判据满足。残留为**通用**性质（与 F3-f 无关）：
全局 stitch 会被"文档末次 tangle 后又被编辑"的无关冲突整体 break off（场景②），故 D-F3-4 的
沙箱 scoped `scripts/stitch.sh` + round-trip 校验仍是推荐路径。

### ④ 编译 / 测试
- `cargo check --workspace --all-targets` → `Finished` 无 error/warning。
- `cargo test -p mcp --lib` → `65 passed; 0 failed`。
- 门禁脚本自测：`scripts/tests/test_check_tangle.sh` PASS=38 FAIL=0、
  `test_stitch.sh` PASS=19 FAIL=0、`test_deploy_port_guard.sh` 6 passed。

### ⑤ 文档
ADR-018 追加 §7「F3-f 处置记录」（§7.1 清单 / §7.2 处置 / §7.3 零漂移 / §7.4 验证 / §7.5 stitch 可用范围 / §7.6 遗留）；
tangle 后门禁仍绿。

## 6. Architecture alignment

- 改动仅落在两层，未越界：
  - **事实源层**：`design/07-app-plane/{00-web-api,01-mcp}.md`（删标记行）、`design/01-architecture/adr/ADR-018-*.md`（追加记录）。
  - **生成物层**：`crates/{mcp/src/tools.rs, app/src/bin/eestock-app.rs}`——**由 `entangled tangle` 生成**，非手改。
- 未改任何接口、事件契约、层边界、依赖；未引入依赖。
- 单向工作流（ADR-007 / ADR-018 D-F3-3 O1）遵守：文档 → tangle → 生成物。

## 7. 变更文件（未 stage）

```
 M crates/app/src/bin/eestock-app.rs                  |  2 -
 M crates/mcp/src/tools.rs                            |  4 --
 M design/01-architecture/adr/ADR-018-...md           | 53 ++++++++++++++++++++++
 M design/07-app-plane/00-web-api.md                  |  2 -
 M design/07-app-plane/01-mcp.md                      |  4 --
 5 files changed, 53 insertions(+), 12 deletions(-)
```

`git diff --cached --name-only` 为空 → **未 stage 任何文件**。

## 8. 验证命令（复现）

```bash
# 清单
grep -rn '~/~' design crates web
# 零漂移（过滤标记行比对）
for f in crates/mcp/src/tools.rs crates/app/src/bin/eestock-app.rs; do grep -v '~/~' "$f" | sha256sum; done
# 幂等 + 门禁
entangled tangle && entangled tangle
./scripts/check-tangle.sh
# 编译 / 测试
cargo check --workspace --all-targets
cargo test -p mcp --lib
# 沙箱全局 stitch（隔离副本，勿在真实仓执行）
cp -a design crates web migrations .entangled entangled.toml "$(mktemp -d)" && cd "$_" && entangled stitch
```

## 9. 残留风险

1. **孤立 begin 标记**：`crates/web/src/settings.rs`、`crates/web/tests/api_settings.rs` 的 1 行 begin
   （无 end、无对应文档块、不在 filedb）。不影响本次结论（无块可回写，全局 stitch 未触碰它们），
   但属独立治理缺口，建议另立任务。
2. **全局 stitch 仍非默认路径**：破坏性自引用模式已消除，但全局执行 blast radius 大且会被无关冲突 break off；
   维持 D-F3-4（沙箱 scoped `scripts/stitch.sh` + round-trip）。
3. **复发防护（建议，未实施，待架构裁定）**：门禁可加一条"文档代码块内不得含 `~/~` 标记"的守卫。
   本次未加，避免扩大范围（门禁属 F3-a 领域）。

## 10. 结论

F3-f 完成：文档代码块内标记归零、生成物恰 1 组注解、语义零漂移、tangle 幂等、门禁绿、
编译与 mcp 单测绿、沙箱全局 stitch 破坏模式（自引用 + Cyclic reference）已消除。
