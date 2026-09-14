# P1-C 独立验收 — 探测设计报告（Tester 自建探针）

- **本文件路径**：`tester/design/264_p1c_independent_acceptance_design.md`
- 目标：对 P1（多周期配置面 + 前端骨架）做**独立于实现车道测试**的验收测量
- 依据：`design/15-multi-period/02-spec.md` §2/§7、`design/07-app-plane/00-web-api.md`（doc-first 生成物）、派单 P1-C
- 被验对象：HEAD `d6462da` + 工作树 P1 未提交改动（改动清单见执行报告 §7）

## 1. 设计原则（为什么不用实现车道的测试当证据）

1. **判据自建**：实现车道的等价性测试内嵌了「HEAD 冻结指纹」（由实现方取证），其判据来源与实现同源。本设计改为**双副本对跑**：`git archive HEAD` 副本 vs 工作树副本，用**同一份探针源码**分别度量，离线比对 ⇒ 判据不是常量，而是真实现渲染结果。
2. **观测优先、断言次之**：探针只 dump 度量（DOM 原文 + 指纹 + 调用计数），不写入断言判据 ⇒ 不引入实现方口径。
3. **反向证据（突变检验）**：任何"未检出差异"的结论必须先证明**探针有检出能力**（在 /tmp 副本里注入违规包裹层，探针必须立刻报差异）。
4. **只读优先**：仓库文件零改动；探针与副本全部在 `/tmp/p1c/`；共享库只允许 `app_config/multi_period` 键且必须收敛回无键。

## 2. 探针清单与层覆盖

| 探针 | 文件（证据副本） | 覆盖 | 隔离方式 |
|---|---|---|---|
| A 等价性 | `/tmp/p1c/probe/zz_p1c_equiv_probe.test.tsx` → `tester/evidence/264_p1c/zz_p1c_equiv_probe.test.tsx` | 关闭态 DOM/请求/订阅/图表实例/指标注册 | 同一文件放入 `/tmp/p1c/head/web` 与 `/tmp/p1c/wt/web`，各自 dump JSON |
| B 开关行为 | `zz_p1c_toggle_probe.test.tsx` | 乐观更新 / 失败回滚 / 关闭零残留 / `enabled=true` 单图无错 | 仅 `/tmp/p1c/wt/web`（HEAD 无开关） |
| C 配置面 HTTP | `t6_probe.py` | §2 七条校验 + §7.4 + GET 坏值回默认 + 读回一致 + 边界 4 周期 | 真实 axum 二进制，临时端口 `127.0.0.1:18099`，共享 DB 同一临时键 |
| D 生成物一致性 | `scripts/check-tangle.sh` + 自建沙箱重生成 | 139 生成物 sha256 全量清单 | 门禁自带沙箱 + 自建 `/tmp/p1c/sbx` 沙箱（只读比对） |

## 3. 度量口径（A 探针）

1. `klinecharts.init/dispose` 调用次数（图表实例数）；
2. `[data-region=main-chart]`、`[data-region=sub-chart]` 子树：结构性指纹（tag+深度+`data-*`/`type`/`aria-pressed`）**与原始 innerHTML 双份**；
3. ApiClient 逐方法调用计数 + 参数摘要（排序集合）；
4. WS `subscribe(topic)` 逐 topic 计数；
5. 图表桩逐方法调用计数 + 去重调用序列（指标注册 `createIndicator/removeIndicator/getIndicators` 与 pane 结构经此暴露）；
6. 整页 innerHTML（用于定位差异落在哪个 region）。

**模拟策略**：jsdom 无 canvas ⇒ `vi.mock('klinecharts')` 用 Proxy 桩（`getIndicators` 返回非空以满足 `addOverlayIndicator` 非空断言）；ApiClient 用 `createMockClient()` 为底座 + Proxy 记账 + 逐方法覆写为**确定性**数据；WsClient 用记账假件。

## 4. 边界与异常用例

- §2 七条：`periods[0]=1mo`、卫星 `1mo`、卫星 < 基准、含 `1w` 且基准 < `1d`（含正向对照 `1d+1w`）、周期数 5 > 4、`heights` 键缺项/多项、`height=79/1201`、边界内 `80/1200`、`indicators=macd`、周期重复；
- §7.4：`1 + Σ_卫星指标 pane > 12`；v1 可达性用 `indicators=["dcap"]×11` 构造（见反向证据）；
- GET 坏值三形态：非对象 JSON、越界旧值（`1mo`+`height 9999`+未支持指标）、缺字段对象 ⇒ 一律 200 默认；
- 不落库：非法 PUT 后 GET 必须等于**上一次被接受**的配置；DB 行内容复核；
- 边界正向：v1 最大合法形态 4 周期 ⇒ 200；
- 开关：`enabled=true` 且未选周期 ⇒ 仍单图、无卫星节点、无报错、实例数不变。

## 5. 覆盖目标与缺口

- 目标：P1 交付面（配置面校验/读取鲁棒性/落库、关闭态等价、开关行为、生成物一致性、回归）**逐项有独立测量**；
- 已知不可覆盖项（诚实声明）：
  - **像素级截图/DOM 视觉等价**：jsdom 无渲染像素；本轮以「结构化指纹 + 原始 HTML 逐字节」替代，真实浏览器渲染等价留待 e2e（且本案禁止在线上发写请求，"关闭态"无写语义，如需可另派 e2e）。
  - **§7.4 pane 上限 >12 的"自然"形态**：v1 指标集仅 `dcap`，只能靠重复项构造（见反向证据）。

## 6. 反向证据设计（突变检验）

在 `/tmp/p1c/wt` 副本（**不改仓库**）对 `MultiPeriodChartStack` 注入 `<div data-p1c-mutant>` 包裹层 ⇒ A 探针必须报 `mainFP/mainHTML` 不等；随后从 `.bak` 还原并用 `diff -q` 复核副本与仓库文件一致。
