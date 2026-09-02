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
