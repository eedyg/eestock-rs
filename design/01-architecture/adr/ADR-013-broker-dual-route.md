# ADR-013：券商通道双路线

- 状态：✅ 已定（2026-09-02 用户拍板）
- 决策：BrokerGateway trait + 双实现——A. 东方财富 CDP 网页自动化（chromiumoxide）；B. 银河证券量化 API（xtquant 系 Python SDK → Python sidecar + IPC）
- 运行时配置二选一；诊断面板接入两路线探活
- 风险与对策：chromiumoxide 成熟度（Wave 3 spike 三关验证：登录态/持仓查询/下单）；QMT 终端常驻环境约束（sidecar 部署文档化）；双失败 → 回用户重新决策
- 券商私有数据（持仓/账户）：交易时实时查，不常驻采集（ADR-012 既定）
