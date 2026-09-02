# ADR-008：Web 技术栈与实时推送

- 状态：✅ 已定
- 范围：8 页全量（行情看板/数据源诊断/标的管理/数据质量/回测工作台/交易面板/告警中心/系统设置），诊断系统以 Web 页面形态落地（无独立 CLI 诊断工具）
- 前端：**React + TypeScript + Tailwind/shadcn**（AI 协作语料最多、组件生态最大）；K线主图 **klinecharts**（MA/MACD/KDJ/BOLL 内置）；诊断仪表盘 **ECharts**
- 后端：axum REST + **WebSocket 实时推送**（行情 bar、源健康变化、告警）
- 设备：桌面优先（暂不做响应式）；多用户但免认证（ADR-010）
