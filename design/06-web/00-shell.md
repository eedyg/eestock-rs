# 06-web / 00 — Web 应用骨架

> 8 页的公共骨架。技术栈 ADR-008：React+TS+Vite+Tailwind/shadcn，klinecharts（K线）+ECharts（仪表盘），axum 后端，WebSocket 实时。

## 路由与页面索引

| 路由 | 页面 | 文档 | 波次 |
|---|---|---|---|
| `/` | ① 行情看板 | 01-dashboard.md | W1 |
| `/sources` | ② 数据源诊断 | 02-sources.md | W1 |
| `/symbols` | ③ 标的管理 | 03-symbols.md | W1 |
| `/quality` | ④ 数据质量 | 04-quality.md | W2 |
| `/backtest` | ⑤ 回测工作台 | 05-backtest.md | W3 |
| `/trading` | ⑥ 交易面板 | 06-trading.md | W4 |
| `/alerts` | ⑦ 告警中心 | 07-alerts.md | W2 |
| `/settings` | ⑧ 系统设置 | 08-settings.md | 各波次 |

## 骨架组件

- 左侧导航栏（8 项，按波次逐步解锁，未上线页面置灰标 wave 标签）
- 顶部状态条：交易时段状态、采集服务状态灯、1m 源健康数（点击跳 /sources）
- WS 客户端：单连接 `/ws`，订阅分发模式（各页订阅自己的 topic，断线指数退避重连）
- 免认证（ADR-010）；桌面优先布局（min-width 1280）

## 布局表达规范（三层法，2026-09-03 定为 web 文档标准，用户批准）

每页文档的布局节必须按三层表达，职责单一、逐层细化：

### L1 ASCII 线框（空间骨架）

- 纯文本盒图，一目了然表达区域划分、尺寸约束（px 或 flex）、包含关系
- 约定：宽度标 `W=`、高度标 `H=`、弹性区标 `flex-1`；多视图模式（如宫格）各画一幅
- 全局约束线下注明（如 `min-width: 1280px`）

### L2 区域规格表（数据契约与状态机）

每个命名区域一行，列为固定六列：

| 区域 id | 内容 | 数据源 | loading/空/错误态 | 交互 |

- 区域 id 用 kebab-case，与 L1 线框、L3 骨架的 `data-region` 锚点**三者必须一一对应**
- 数据源注明 REST 端点 / WS topic / 客户端计算
- 状态三件套（loading/空/错误）不允许留空，无内容态也要写「不可能空（理由）」

### L3 布局骨架代码块（tangle 生成，文学式纪律延伸）

- 代码块 `file=web/src/layouts/<Page>Grid.tsx`，由 entangled 单向生成**静态结构骨架**
- 骨架职责边界：只表达 DOM 结构 + 区域锚点（`data-region`）+ 布局尺寸类（w/h/flex）；**视觉样式（颜色/间距细节/hover 等）手写于组件内**，不进骨架
- 改布局 = 改本文档 L3 代码块再 tangle，禁止手改生成的骨架文件
