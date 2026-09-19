# 04-implementation-plan — 分批实施、门禁、回滚与派工边界

> 契约事实源：`02-spec.md`；测试判据：`03-test-plan.md`。
> 裁决事实源：`design/01-architecture/adr/ADR-027-*.md`、`ADR-028-*.md`。
> **批次**：ADR-027 与 ADR-028 **同批实现**（「结果载荷 v2」，只清一次历史、只发一次不兼容版本）。

---

## 1. 阶段划分（每阶段 ≤1 次派工，独立可验收）

| 阶段 | 内容 | 执行者 | 产物/证据 | 门禁 |
|---|---|---|---|---|
| **P0** | 历史归档与清空：`pg_dump` 归档回测/模拟实况表 → **隔离库恢复校验**（行数 + 校验和）→ `TRUNCATE`（保表结构/迁移链，禁 DROP） | worker | 归档文件 + 校验记录 `coder/evidence/<批次>/p0_purge/**` | 校验通过才允许 TRUNCATE |
| **P1** | 后端事实源（`backtest` + `strategy-core`）：`FillFact` 三件套 + `rt_seq` + `aggregate_round_trips`（唯一实现）+ `RoundTrip` v2 + `ResultKind::Position` 序列 + 期末强平归属 | worker | R1/R2/R5 先红后绿证据；U1–U8 全绿 | R 段必须先红 |
| **P2** | sim-live：`Fill`/`SimTrade`/`sim_trades` 费用拆列（含 `stamp_duty` 真值）+ `code` + `status` + 真实 `bar_index` + 复用聚合函数 + 运行中 L1/L2 读 + **不引入期末强平** | worker | R3/R4 先红后绿；S 段共享向量两侧一致 | 与 P1 **串行**（同 crate 编译竞争） |
| **P3** | application/domain/web-api：`/round-trips`、`/round-trips/{rt_seq}/fills`、`/fills` 过滤与字段、`/curve` 窗口参数、`/audit` 逐回合自洽、完整性契约、`sim_trades` 迁移（经 `design/04-storage/schema.md` tangle） | worker | C1–C9 全绿；迁移文件由 tangle 生成（禁手改） | tangle 后 `git diff` 与产物一致 |
| **P4** | MCP 面：新增 2 工具 + 4 处增量 | worker | C9 | 与 P3 契约一致 |
| **P5** | 前端：types v2、L1/L2 表与四枚按钮、懒加载、对账告警、窗口状态机（节流/rev/回声抑制）、`mapLineByTs`、`onVisibleRangeChange`、`barSpaceLimit` 边界、持仓比率视图、K 线标记完整性 | worker | F1–F12 全绿 | 与后端验收**并行**（前端 npm 写不与 cargo 验收同跑） |
| **P6** | 验收与文档回写：E1–E4 真渲染 + 三闸门 + 文档口径注同步 | tester + 架构师 | E 段证据；文档修订 | 树静止后验收 |

## 2. 派工边界（硬约束）

1. **架构师（本代理）不动代码、不写测试、不调试**：只做契约冻结、派工、原则评审、冻结/放行裁决。
2. **编码 → worker**；**测试/验收 → tester**；**`debugger` 已 disabled** ⇒ 调试必须由 worker 按**证据链**修（禁止代码阅读猜测；日志/工具输出为唯一依据）。
3. **车道纪律**：编译型车道（P1/P2/P3/P4）之间**串行**，禁与 `cargo test/build` 验收车道并行；前端写（P5）可与后端验收并行；只读可并行；验收前树须静止（无 cargo/npm/vite 活跃且近 60s 无写入）。
4. **派单文本一律用字符串数组 `join(String.fromCharCode(10))` 拼接，正文禁用 ASCII 引号**（workflowScript 静默不启动的已知坑）；引用一律用「」。
5. **判词前置 + 增量落盘**：每完成一个子项立即写证据文件；不把结论攒到最后（30 分钟硬上限）。
6. **多阶段 continuation 不可靠**：每阶段结束后由架构师**自核产物是否存在**，必要时显式补跑；不假设自动续跑。

## 3. 回滚与恢复

| 对象 | 回滚手段 |
|---|---|
| 代码 | `git revert`（分批提交，P1–P5 各自独立可回滚） |
| 数据 | P0 归档文件（`pg_restore` 到隔离库或原库） |
| 迁移 | `sim_trades` 为 ADD COLUMN（非破坏性，可保留）；无 DROP 语句 |
| 前端 | 与后端同批次发布；若需回退，`dist/index` 产物同步回退 |

## 4. 风险登记

| 风险 | 处置 |
|---|---|
| 30 分钟派工上限截断 | 判词前置 + 增量落盘；超时先盘点宿主产物，再 `resume` 收尾（**不重启任务**） |
| 子代理以提问结束回合被误判 completed | 恢复后先核对产物是否仍在写；必要时 `steer` 直投裁决（supervisor 通道有假送达历史） |
| 编译竞争导致假阳性 | 车道纪律 + 验收前树静止 |
| 前端旧 mock/e2e 数据仍按旧 `Trade` 形状 | P5 必须同步更新 mock 与 e2e fixture，否则「假绿」 |
| 绩效口径变更引发旧结论不可比 | 已由 ADR-027 D3 清空历史覆盖；P6 必须在文档与 UI 披露口径注 |

## 5. 全局「完成」定义（DoD）

1. `02-spec.md` 逐条落地：字段、端点、口径、命名消歧、完整性契约。
2. `03-test-plan.md` 的 R/U/C/S/F/E 全绿，且有证据落盘（先红后绿记录完整）。
3. 恒等式 I1–I4 在真实 run 上成立；`/audit.rt_reconcile.mismatched` 为空。
4. 三道闸门全过；无静默失败路径（跳转/取数/抽样/截断均显式）。
5. P0 归档可恢复（隔离库校验记录在册）；迁移由 tangle 生成且 `check-tangle` 通过。
6. 文档回写完成：`design/07-app-plane/00-web-api.md`、`01-mcp.md`、`design/08-backtest/01-engine-adr.md`、`design/11-sim-live/01-adr.md`、`design/12-strategy-system/01-adr.md`（§13.4/§13.5）、`web/src/api/types.ts` 口径注。

## 6. 提交与门禁

- 分批提交（P0 / P1 / P2 / P3+P4 / P5 / P6 文档），每批提交前跑 `gitnexus_detect_changes` 核验影响面；
  含 schema/路由/工具列表等 entangled 托管生成物的批次，提交前跑 pre-commit 的 `check-tangle`（沙箱逐字节比对）。
- 任一门禁失败 ⇒ **冻结**，输出整改单，回退到 ADR/spec 修订后再派工。
