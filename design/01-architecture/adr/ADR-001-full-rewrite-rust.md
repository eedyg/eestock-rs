# ADR-001：全量重写 + Rust

- 状态：✅ 已定（2026-09-02 用户拍板）
- 背景：eestock（Go）技术债与架构不满足要求；终端操作形态不便，需要完整 Web
- 决策：行情/交易/回测/Web/策略**全部重写**，语言 **Rust**
- 旧系统：冻结只读、立即停跑（数据断档已接受）
- 已知风险：Rust 浏览器自动化（chromiumoxide）成熟度弱于 go-rod → Wave 3 交易 spike 先行验证（见 ADR-012）；tushare 无官方 Rust SDK（HTTP JSON 直连即可，风险低）
- 遗产利用：旧项目源码/报告/脚本保留在父目录供 agent 检索；数据源验证结论直接继承（00-vision §5）
