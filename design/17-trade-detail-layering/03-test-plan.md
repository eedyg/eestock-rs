# 03-test-plan — TDD 规格、复现测试清单与验收门禁（ADR-027 + ADR-028）

> 契约事实源：`02-spec.md`。**无失败测试不得改引擎**（ADR-027 §4.4 / 项目 TDD 纪律）。
> 所有判据必须**正向断言**（断言具体值/集合/恒等式），禁止「没报错即通过」。

---

## 1. R 段：复现测试（**必须先红，后绿**）

| ID | 复现目标 | 构造 | 红判据（改前） | 绿判据（改后） |
|---|---|---|---|---|
| **R1** | 部分卖出下现有 `pnl` 不是回合真实盈亏 | 买 100@10 → 部分卖 50@12 → 清 50@11（费用按默认 FeeModel） | 断言 `pnl == Σ sell(proceeds) − Σ buy(total_cost)` **失败**（现实现只算末笔） | 断言成立（阈值 1e-9） |
| **R2** | 现有 L1 字段非全回合加总 | 同上；检查 `commission`/`stamp_duty`/`gross_value` | 断言 `L1.commission == Σ 各笔 commission` **失败** | 成立 |
| **R3** | sim-live `stamp_duty` 恒 0 | 会话内一笔卖出 | 断言 `stamp_duty > 0`（fee 含印花税时）**失败** | 成立 |
| **R4** | sim-live `bar_index` 由 `ts/bar_sec` 反算 | 非整点/跨周期 ts | 断言 `open_bar == 真实 bar 序号` **失败** | 成立 |
| **R5** | 零长回合归属 | 同一 bar 内 buy（挂单）+ sell（intrabar 止损） | 断言该回合 `l2_count == 2` 且归属同一 `rt_seq` **失败**（现无 `rt_seq`） | 成立 |
| **R6** | `fills` 与 `per_bar.events` 两源一致性 | 任一 run | 断言两源逐笔（`rt_seq`/金额三件套）相同 | 成立 |

> 证据要求：R1–R6 的红/绿输出与命令必须落盘到 `tester/evidence/<批次>/`，作为 ADR-027 §1.2「未取证项」的取证结论。

## 2. U 段：单元测试（引擎与聚合）

| ID | 用例 | 判据 |
|---|---|---|
| U1 | 聚合纯函数表驱动：单笔开平 / 多批加仓 / 部分卖出 / 多批 DCA 100 笔 / 零长回合 / 期末强平 | 逐字段 == 手算期望（含 `pnl`/`commission`/`stamp_duty`/`shares`/`hold_bars`/`l2_count`） |
| U2 | `rt_seq` 分配：开仓新 seq、加仓同 seq、清仓终结、再开仓 seq+1 | `distinct(rt_seq)` 序列与预期完全一致 |
| U3 | `Open` 回合：`pnl == None`、不参与绩效 | `trade_count == closed 计数`；`win_rate` 分母不含 Open |
| U4 | 费用三件套来源：`FillFact.commission/stamp_duty` == `FeeModel::buy/sell` 返回值（含最低佣金分支） | 逐位相等（`==`，非容差） |
| U5 | **I3 恒等式**：`nav[-1] == initial + Σ_closed pnl + Σ_open(…)` | 容差 `1e-6×max(1,|nav|)` 内成立 |
| U6 | **I4 自洽**：`distinct(rt_seq) == len(trades)`；ForceClose 终结数 == audit 字段 | 相等 |
| U7 | 持仓序列：`position_value + cash == nav` 逐点；`position_ratio == position_value/nav`（nav≤0 ⇒ 0） | 逐点成立 |
| U8 | 绩效口径影响披露：构造含部分卖出的 run，断言新 `win_rate/profit_factor` 与旧口径的差异有测试记录 | 断言新口径值（锁定基线） |

## 3. C 段：契约测试（HTTP/MCP/TS 形状）

| ID | 用例 | 判据 |
|---|---|---|
| C1 | `/result` trades 元素 v2 形状 | 字段齐全 + 无旧字段残留 |
| C2 | `/round-trips` 分页与摘要（`l2_count`/`buy_count`/`sell_count`） | `total/has_more/next_offset` 正确；`l2_count` == 该回合 fills 数 |
| C3 | `/round-trips/{rt_seq}/fills` | 归属正确；**未知 rt_seq ⇒ 404**（禁空数组冒充） |
| C4 | `/fills?round_trip=` 过滤 + 元素新字段 | 过滤后集合 == 该回合 fills；`recorded=false` 语义不变 |
| C5 | `/curve?kind=position` + `from_ts/to_ts` | 窗口回显正确；`window_bars` == 窗口内原始根数；缺省全区间 **向后兼容** |
| C6 | `/curve` 拒 `kind=fills` | 400/错误码（白名单不变） |
| C7 | `/audit` 增量（`round_trips_closed/open`、`rt_reconcile`） | 与 L1 列表逐回合一致；`mismatched` 为空（正常 run） |
| C8 | 完整性契约：所有列表端点 | `total`/`has_more`/`next_offset`（或 `truncated`）齐备 |
| C9 | MCP 工具增量（新增 2 个 + 4 个参数/字段变更） | 形状与 HTTP 一致；错误语义一致 |

## 4. S 段：跨侧共享向量（**两侧同输入 ⇒ 同输出**）

- 产物：`design/17-trade-detail-layering/contract-vectors.json`（由本批次新增）。
- 内容：≥6 组成交序列（含部分卖出、DCA 多批、零长回合、Open 回合），每组给出期望 `RoundTrip[]` 与逐字段 L2。
- 判据：**回测聚合**（`strategy-core`）与 **sim-live 聚合**（结算 + 运行中读）对同一向量产出**逐字段相同**结果（浮点逐位）。
- 该向量同时作为两侧实现的一致性回归基线（一方改动导致另一方不一致 ⇒ 立即红）。

## 5. F 段：前端测试

| ID | 用例 | 判据 |
|---|---|---|
| F1 | L1 默认只渲染一层；`[明细]` 展开/收起 | 展开后 L2 行数 == `l2_count`；`aria-expanded` 状态断言 |
| F2 | L2 懒加载 | 展开前**无** L2 请求；展开后按 `rt_seq` 请求且分页正确 |
| F3 | L2 `[明细]` 展开字段详情 | 费用三件套/双口径均价/`cum_*` 可见 |
| F4 | **对账不一致告警** | 注入 `mismatched` ⇒ 顶部告警含 Δ 值且**冻结**两侧数值（不得静默按 L1 渲染） |
| F5 | `cum_*` 末行 == L1 字段 | 逐字段相等 |
| F6 | `mapLineByTs` 单测 | 给定 `domain`，点的 x 与 ts 线性映射一致；**`mapLine` 行为不变**（回归） |
| F7 | 窗口状态机：节流/rev 丢旧/回声抑制 | 连续 N 次 pan/zoom ⇒ 请求数 ≤ 节流允许值；旧响应不回写；程序化写窗不触发回写 |
| F8 | `onVisibleRangeChange` 回调（新增可选 prop） | 索引→ts 转换正确；**其它调用方不传 ⇒ 行为逐字节不变**（回归） |
| F9 | 跳转断言（防静默越界） | L2 跳转后窗口中心 bar == 目标；`setBarSpace` 越界路径必须被断言捕获（构造 max=50 场景） |
| F10 | 持仓比率视图 | 渲染 `position_ratio` 曲线；与 `nav` 口径标注同屏可辨 |
| F11 | 跨标的跳转（sim-live） | 切主图标的 + 显式提示出现 |
| F12 | K 线标记完整性（D11） | 成交 > 首页大小时标记拉全并显式披露 |

## 6. E 段：端到端（真渲染）

| ID | 用例 | 判据 |
|---|---|---|
| E1 | L1→`[跳转]`：K 线可见 bar ts 区间 == 回合区间（±1 根） | 断言 + 截图证据 |
| E2 | L2→`[跳转]`：中心 bar == 该笔成交 | 同上 |
| E3 | 窗口联动：各曲线视图 x 定义域 == 共享窗口；可见 bar ts 集合一致 | 断言 + 截图 |
| E4 | 全览/历史回退 | 窗口恢复正确；不产生额外请求风暴 |

## 7. 门禁与终止条件（三道闸门）

1. **闸门 1（架构师亲审）**：契约一致性（`02-spec.md` 逐条）、口径消歧、分层与 DRY（唯一聚合实现）、诊断与观测可查。
2. **闸门 2（reviewer 独立评审）**：反例挖掘（重复买入出血、假覆盖、测试只断言不抛错、口径回退）。
3. **闸门 3（tester 验收）**：R/U/C/S/F/E 全绿 + 证据落盘 + 树静止（验收时无 cargo/npm 活跃）。
4. **冻结条件**：任一 R 段未先红、任一恒等式（I1–I4）失败、`rt_reconcile.mismatched` 非空、静默失败路径存在 ⇒ **冻结并回退到 ADR/spec 修订**，不得带病合入。
