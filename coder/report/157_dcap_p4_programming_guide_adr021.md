# 157 — P4 文档收口：编程手册 dcap 章节 + 99-decisions-log 登记 ADR-021

- 报告自身位置：`coder/report/157_dcap_p4_programming_guide_adr021.md`
- 车道：**P4（文档收口）**；HEAD = `3f5425c`（dcap P0–P2 已入库）
- 派单：`design/14-dcap-indicator/04-implementation-plan.md` §2 P4 / `05-issue-drafts.md` #6
- 权威口径：`design/14-dcap-indicator/01-adr.md`（ADR-021）、`02-spec.md`（§2/§4/§5/§8）、`03-test-plan.md`（T5a/T5b/T7）
- 隔离纪律：未 `git add` / `commit` / `stash` / `checkout`；未跑 tangle（两份文档 `file=` 块均为 0）；未碰 P3/P5 文件；未起 8081/8082

---

## 1. 变更清单

| 文件 | 增/删 | 内容 |
|---|---|---|
| `design/12-strategy-system/04-strategy-programming-guide.md` | **+155 / −2** | 新增 `## 12. dcap 指标（假想定投收益率，参考插件）`（§12.1–§12.7）；§10 参考插件列表 7→8 并补 `dcap`（一致性修正，见 §5） |
| `design/99-decisions-log.md` | **+16 / −0** | 追加 `# ADR-021 dcap 指标：镜像产物的单一源约定（2026-09-13，用户批复「按推荐」，方案 A1）` 条目 |
| `coder/report/157_dcap_p4_programming_guide_adr021.md` | 新增 | 本报告（角色要求产物，非设计/源码文件） |

合计：2 份受派单约束的文档 +171 / −2。

## 2. 归属层与架构对齐

- 两份文件均属 **文档事实源层**（`design/`，ADR-007：`design/` 是事实源）。
- 编程手册被 `crates/web/src/strategies.rs:23` 与 `crates/mcp/src/tools.rs:1251` 以 `include_str!` **编译期内嵌**，经 `GET /api/strategies/guide` 与 MCP `strategy_guide` 双通道同字节分发 ⇒ 改文档即改产品内可见内容（无需 tangle、无需改码）。
- **无接口 / 契约 / 分层改动**：未动插件 ABI、`clamp_score` / `aggregate` / `classify` / 60-40 阈值 / `ExecutionPolicy`；未动 `design/14-dcap-indicator/**`；未新增依赖。
- 分类：纯需求文档补齐（README/docs 层），无代码路径变更。

## 3. 解决的问题 / 交付的能力

P4 前，dcap 的口径只存在于实现与 `14-dcap-indicator/**`，**策略作者视角的手册（`strategy_guide` / DocSidebar 全文）里没有 dcap** —— 作者拿不到参数默认值/范围、三线语义、数据不足行为、评分公式，以及最容易踩的「插件面归一化 vs 配置端点面 400」两个面语义差异。本章节据 `02-spec.md`（§2/§3/§4/§5/§8 裁决）与 `03-test-plan.md`（T5a/T5b/T7）写成，逐条覆盖派单要求：

| 派单要求 | 落位 |
|---|---|
| 指标语义（假想定投收益率；资金加权 = `P_n/H_w − 1`，`H_w` 调和均值；`r=1 ≡ 遗留 DCAP`） | §12.1（含公式块：三种等价表述） |
| 9 参数表（默认 / 范围 / 含义） | §12.2（`n_s/n_m/n_l/r_s/r_m/r_l/smooth/m/th`，含 `n≥2` 特殊下界说明） |
| 三线 `s`/`m`/`l` 语义 | §12.3（各自独立窗口/`r`/平滑/数据充足性；SMA；首个有值位置 `n_i+m−1`） |
| 数据不足语义（单线不入 N；三线全不足 → 50） | §12.4（含「不打 `ctx.log`」） |
| 评分映射公式（连续式等权三线） | §12.4（`score = clamp(50 − (50/N)·Σ clamp(roi_i/th, −1, +1), 0, 100)` + `roi=±th → 0/100` 锚点表） |
| 参数归一化「两个面语义不同」 | §12.5（插件面 `init` 归一化幂等/顺序归一/不拒绝 vs 配置端点面严格 400 的对照表 + 两条易错提醒） |
| 可直接复制的用法示例（非 `file=` 块） | §12.6（单线 dcap 策略：滚动窗 + `dcapRoi` + 连续式映射 + `save/load`） |
| 口径提醒（滞后型加权动量 / 与 DCAP、BIAS 高度共线 / 阈值按 `n`&`r` 标定） | §12.7 |
| 99-decisions-log 登记 ADR-021 | 文件末尾新条目（一句话结论 + 日期 2026-09-13 + 关联 ADR-007 / ADR-018 / 插件 ABI + 指向 `design/14-dcap-indicator/01-adr.md`） |

## 4. 实现方法（架构内决策）

1. **落位选新顶层章节 `§12`（追加在文末）**，不插入 §4/§5 之间：dcap **不是宿主指标 API**（无 `ctx.indicators.dcap`），放进 §4「指标 API（宿主侧计算）」会误导；追加也避免重编号破坏文内交叉引用（§4/§4.5/§10）。
2. **章节内显式声明"不是宿主指标"**（导语），并指向 §4.5 通道 2（自持滚动窗口）——与 `dcap.js` 的实际形态一致。
3. **归一化语义用对照表 + 两条反例**写：把 T5a/T5b 的差异直接翻译成作者语言（"插件会静默归一、端点会 400"），这是派单点名的"最容易写错的地方"。
4. **示例刻意写成"单线版"而非全文三线**：手册既有示例均为可复制的最小骨架（§1/§4.5 风格）；三线版已在策略列表以 `dcap` 参考插件提供，文末一句指路即可，避免手册塞入 300 行生成物同文（也避免与 `02-spec.md` 唯一事实源重复）。
5. **示例口径与 `02-spec.md` §4 浮点铁律对齐**：迭代乘法（不用 `Math.pow`）、`k=n→1` 反向累加、每 bar 完整重算、非法价返回 `null` 不抛错、状态进 `save()/load()`。
6. **`file=` 关键字 0 命中**：全部代码块使用无属性围栏（```js / ```），避免 entangled 误识别；两文档均严禁 tangle。

## 5. 与派单的两处说明（请审阅）

1. **§10 参考插件列表 7→8（+1/−1 行）**：本手册 §10 原文为「7 款参考插件：dual_ma / … / atr_channel」，而 HEAD 的 `crates/strategy-core/src/reference.rs` 已播种**第 8 条 `dcap`**（`reference_plugins()` 8 条、播种计数 12）。新章节若不修此处会造成同文件内「7 款」与「第 8 款」自相矛盾。属**同一文件内的既成事实一致性修正**，非新增范围；若审阅认为应单开任务，可回退此 1 行而不影响 §12 章节。
2. **未改** 手册头部 `> 版本：v1（2026-09-10）`、未改 `design/07-app-plane/00-web-api.md`（P3 车道）、未改 `design/14-dcap-indicator/**`（口径冻结）。

## 6. 测试覆盖

本任务为纯文档变更，**无新增/修改任何测试**（不适用 TDD 红绿；无代码路径变更）。既有守门测试继续覆盖本次产物：

| 测试 | 位置 | 关系 |
|---|---|---|
| `strategy_guide_returns_handbook_full_text` | `crates/mcp/src/tools.rs:3490` | 断言内嵌手册 == `design/…/04-strategy-programming-guide.md` 全文 + 含 `PARAMS_SCHEMA`/`ctx.position`（本次已实测 pass） |
| `guide_endpoint_returns_markdown_full_text` | `crates/web/tests/api_strategies.rs:546` | REST 通道同字节（需 DB，未跑） |
| T3/T5a/T5b/T7（dcap 镜像体 / 归一化 / 重放） | `web/src/features/indicators/*.test.ts`、`crates/strategy-core` | 与本变更无交集（不动产物） |

## 7. 验证

1. **`file=` 关键字仍为 0 命中**（tangle 禁用前提）：
   ```
   $ grep -c 'file=' design/12-strategy-system/04-strategy-programming-guide.md design/99-decisions-log.md
   design/12-strategy-system/04-strategy-programming-guide.md:0
   design/99-decisions-log.md:0            # grep exit=1（无命中）
   $ grep -n '^```{' <两文件>   → 无输出（无带属性围栏）
   ```
2. **编译通过**（`include_str!` 内嵌重编译）：
   ```
   $ touch crates/web/src/strategies.rs && cargo build -p web
   Finished `dev` profile … in 4.63s        # EXIT=0
   $ cargo build -p mcp
   Finished `dev` profile … in 2.66s        # EXIT=0（第二处 include_str! 亦编译）
   $ cargo test -p mcp --lib strategy_guide_returns_handbook_full_text
   test tools::tests::strategy_guide_returns_handbook_full_text ... ok   # 1 passed（内嵌 == 设计源）
   ```
3. **tangle 门禁绿**（沙箱重新生成 + 逐字节比对，工作区未被修改）：
   ```
   $ ./scripts/check-tangle.sh
   [check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。   # EXIT=0
   ```
   注：本次**未运行任何 `entangled tangle`**（两文档 0 个 `file=` 块），故无"exit=0 零写入"风险窗口；门禁运行仅为证明既有生成物漂移判据未被本次编辑影响。已确认工作区仅 2 份文档变更（`git diff --numstat`）。
4. **示例口径自核**（把 §12.6 示例函数原样抽出跑）：`closes=[100,90,95], n=3, r=1.2` → `0.0045787545787547845`（与 `02-spec.md` §4 实测值**逐位相同**）；`r=1.0` → `0.0018518518518517713`（T1 值），与遗留 DCAP `close/HM−1 = 0.0018518518518519933` 差 `2.22e-16`（< T1 的 `1e-12` 容差）；`n > len` → `null`；`close=0` → `null`；评分锚点 `−th→100 / 0→50 / +th→0`。
5. **范围自检**：`git status --porcelain` → 仅 `M design/12-strategy-system/04-strategy-programming-guide.md`、`M design/99-decisions-log.md`（其余为既有未跟踪项，非本次产生）；`git diff --cached --name-only` 为空（**未 stage**）。
