# 291 — ADR-023 D2 实现：多周期接入 30m（白名单 / rank / 选择器 / 冻结密度值 / 原因码）

- **本报告路径**：`coder/report/291_adr023_period30m_d2_impl.md`
- 日期：2026-09-16（本地 23:45 CST）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §2.5 / §5.3(D2) / §6.1 第 7–8 条
- 阶段：D2（实现）——把 tester 红测试转绿
- **VERDICT: PASS**
- 证据目录（绝对路径）：`/tmp/adr023-d2-impl-20260916T154107Z/EVIDENCE.md`

---

## 1. 解决的问题 / 新增的能力

让 **30m 真正进入多周期同显**（ADR-023 §5.3 的 D2 交付范围），三处**同时**打开，避免「可选却被静默排除 / 可选却被 400 拒」的半成品：

1. 后端白名单 `MULTI_PERIOD_ALLOWED` 加 `"30m"`（7 档）；
2. 后端周期序 `multi_period_rank` 在 `15m`(2) 与 `1h`(3) 之间插入 `30m`，后续档位顺延；
3. 前端 `MULTI_PERIOD_PICKER_PERIODS` 同步 7 档（与后端 rank 镜像）；
4. `MEASURED_DENSITY_TABLE` 新增 **30m 与 {1m,5m,15m,1h} 的四条直接实测（冻结）条目**；
5. `chartSyncGroup` 的 `periodOrder` 纳入 30m（否则 `syncExclusionReason` 会把 30m 误判为 `unsupported-period`）；
6. 原因码语义正确：`30m↔1d` = `no-shared-anchor`、`30m↔1w` = `week-requires-day-or-above`、`1h/d↔30m` = `satellite-lower-than-base`。

---

## 2. What changed（文件 + 行数；D2 增量）

工作区会话前已有 **D1 的未提交改动**（说明见证据 `git_status_pre_note.md`）。下表「numstat」为 vs HEAD 的整文件统计，其中 `dto.rs`/`00-web-api.md`/`chartSyncGroup.ts` 含 D1 遗留改动。

| 文件 | 类型 | numstat(+/-) | D2 内容 |
|---|---|---|---|
| `design/07-app-plane/00-web-api.md` | doc-first 事实源 | 22/8（含 D1） | `MULTI_PERIOD_ALLOWED` 加 `"30m"`；`multi_period_rank` 插 `30m=3` 并顺延 |
| `crates/web/src/dto.rs` | **tangle 产物**（未手改） | 10/6（含 D1） | 同上（由 `entangled tangle` 写入） |
| `web/src/features/dashboard/multiPeriodPicker.tsx` | 手写 | 3/2 | `MULTI_PERIOD_PICKER_PERIODS` 7 档 |
| `web/src/features/dashboard/chartSyncGroup.ts` | 手写 | 13/3（含 D1） | 4 条冻结密度值 + `periodOrder` 插 30m |
| `design/15-multi-period/02-spec.md` | 设计散文 | 2/1 | §3.2 无公共锚点周期集合含 30m（纯散文，无 `file=` 产物） |
| `web/src/features/dashboard/multiPeriodPicker.test.tsx` | 测试（**父级授权 A**） | 5/5 | 3 处期望字面量 + 1 描述串更新为 D2 契约 |

冻结值（**逐字照 ADR §2.5，未取整/未调整**）：`'1m:30m': 24.1`、`'5m:30m': 5.0`、`'15m:30m': 1.8`、`'30m:1h': 1.67`。
既有 5 条表值（`4.7/12.2/37.8/4.67/24`）**逐字未动**。

---

## 3. Architecture alignment（各改动属于哪一层）

- `design/07-app-plane/00-web-api.md → crates/web/src/dto.rs`：**应用层 API 契约**（doc-first）。文档是事实源，产物由 `entangled tangle` 单向生成，符合 ADR-007/ADR-018。
- `multiPeriodPicker.tsx` / `chartSyncGroup.ts`：**前端展示层（web/src/features/dashboard）**，手写不受 tangle 门禁覆盖（ADR-023 §6.1 第 2 条债），改动自证。
- `design/15-multi-period/02-spec.md`：**设计散文**（无 `file=` 块 ⇒ 不涉 tangle 产物），与 ADR-023 §2.5 口径对齐。
- 未触碰任何**接口签名 / 事件契约 / 层边界 / 依赖方向**：`MULTI_PERIOD_ALLOWED` 是常量、`multi_period_rank` 是私有纯函数、`MEASURED_DENSITY_TABLE`/`periodOrder` 是模块内常量/私有函数。

---

## 4. Implementation approach（在既定架构内的关键决策）

1. **doc-first 严格执行**：先改文档，再 `entangled tangle`（**写入式、无 `--force`、未用全局 stitch**），产物 mtime 晚于文档 + grep 命中（见 §7）。
2. **只加不减**：白名单/周期序/选择器对既有 6 档为纯加法面，`1mo` 仍不提供（既有用户裁决）。
3. **直接条目而非 rely-compose**：`effectiveDensity` 解析序 `static→composed→measured→none`，`composed` 被当缩放比且优先级高于运行时实测；30m 与同族每一对都写**直接实测条目**，使 30m 配对恒为 `source='static'`（ADR §2.5 不变量）。
4. **原因码语义**：30m 有 `1m` 锚点 ⇒ 与 `5m/15m/1m/1h` 同族；与 `1d/1w` 跨族天然无共同锚点 ⇒ 分别落 `no-shared-anchor` / `week-requires-day-or-above`（**不得**降级为 `unsupported-period`）。
5. **本轮明确不做**：`composed`/`measured` 解析优先级（ADR §6.1 第 7 条 F5，待用户裁决）保持现状；既有 5 条旧密度值不刷新（独立债）。

---

## 5. Test coverage（新增 / 更新）

- **未新增测试文件**（tester 已产出红测试）。
- 转绿：`crates/web/tests/period30m_d2_multiperiod_red.rs`（6/6）、`crates/web/tests/period30m_scope_guard.rs`（3/3）、`web/src/features/dashboard/period30mD2.test.ts`（21/21）、`web/src/features/dashboard/period30m.test.tsx`（9/9）。
- **唯一被改的测试文件**：`web/src/features/dashboard/multiPeriodPicker.test.tsx` —— 父级授权 (A) 的最小契约演进（3 条既断言的期望字面量 + 同事实描述串；结构零变）。其期望值由「D2 契约 + 既有 `indicatorPeriodOptions` 过滤逻辑」**独立推导**，非从实现输出倒推。

---

## 6. Verification（命令原文与结果）

| # | 命令 | 结果 |
|---|---|---|
| V1a | `npx vitest run src/features/dashboard/period30mD2.test.ts src/features/dashboard/period30m.test.tsx` | 改前 `Tests 18 failed \| 12 passed (30)` → 改后 `Tests 30 passed (30)` |
| V1b | `cargo test -p web --test period30m_d2_multiperiod_red --test period30m_scope_guard` | 改前 `4 failed; 2 passed` → 改后 `6 passed; 0 failed` + `3 passed; 0 failed`（EXIT=0） |
| V2a | `npx vitest run`（web/） | `Test Files 88 passed (88)`；`Tests 836 passed (836)`；EXIT=0 |
| V2b | `npm run build`（web/） | `tsc -b && vite build`；`✓ built in 1.96s`；EXIT=0 |
| V2c | `cargo test --workspace --tests` | 88× `test result: ok`、0 FAILED；`total passed=721 failed=0 ignored=1`；EXIT=0 |
| V2d | `./scripts/check-tangle.sh` | `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。`；EXIT=0 |
| V4 | `entangled tangle` | `INFO write \`crates/web/src/dto.rs\``；无 conflicts/outside-control；EXIT=0 |

**tangle 输出原文**：
```
[23:42:24] INFO     Welcome to Entangled v2.4.3!
           INFO     write `crates/web/src/dto.rs`
```
**门禁输出原文**：`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。`

**30m 各配对 `effectiveDensity` 实测（source / 比值）**：
```
EFFECTIVE 1m:30m  -> ratio=24.1  source=static
EFFECTIVE 5m:30m  -> ratio=5     source=static
EFFECTIVE 15m:30m -> ratio=1.8   source=static
EFFECTIVE 30m:1h  -> ratio=1.67  source=static
REASON 30m->1d = no-shared-anchor  |  30m->1w = week-requires-day-or-above
REASON 1h->30m = satellite-lower-than-base  |  1d->30m = satellite-lower-than-base
REASON 15m->30m = null (allowed)
```

---

## 7. V3 / V4 / V5 摘要

- **V3 断言未弱化**：tester 4 个 D2 测试文件 sha256 前后逐字节相同；唯一被改测试文件结构计数 `expect(` 83→83、`it(` 17→17、`toEqual(` 19→19、`toContain(` 5→5、`filter(` 6→6（无删除/放宽）。
- **V4 tangle 真实**：`dto.rs` grep 命中 `"30m"`（138/159 行等）；产物 mtime `23:42:24.240` **晚于**文档 mtime `23:42:17.568`（6.67s）。
- **V5 零副作用**：HEAD 未变（`3094018f…`）；无 staged（未 `git add/commit/stash`）；无临时残留（探针文件已删）；`.entangled` 无异常；未碰在线 app/活库写、未改 `.gitignore`；未用 `--force`、未用全局 `stitch`。

---

## 8. 残留风险

1. `web/src/api/mock.ts:215` 的 `order` 未含 30m（不在本任务清单内，未动）⇒ mock 模式下多周期含 30m 会被前端 mock 400。真实后端已接受。建议独立小任务补镜像（属 ADR-023 §6.1 第 1 条债）。
2. ADR §6.1 第 7 条（`effectiveDensity` 优先级 F5）按任务要求**不动**。
3. `design/15-multi-period/02-spec.md` §3.2 的旧实测密度表未加 30m 行（权威值在 ADR §2.5；本报告 §2）。
4. 测试隔离债（ADR §6.1 第 8 条）未处置；`d2e` 用例只读活库快照，实测前后逐字节未变。
5. `period30m_scope_guard.rs` 红侧原始计数未直接量到（cargo 首个失败目标即中止）；其红因见文件头叙事 + 改后 3/3 绿。

---

## 9. 相关路径

- 证据：`/tmp/adr023-d2-impl-20260916T154107Z/EVIDENCE.md`
- 本报告：`coder/report/291_adr023_period30m_d2_impl.md`
