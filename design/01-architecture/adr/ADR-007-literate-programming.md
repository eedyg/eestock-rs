# ADR-007：文学式编程单向工作流

- 状态：✅ 已定
- 工具：**entangled**；方向：**design → src 单向**（src 为生成物，改码必改文档）
- 门禁：git hook / CI 执行 `entangled tangle && git diff --exit-code`，不一致拒绝提交
- 手写例外：entangled.toml、Cargo.toml workspace 骨架、前端构建配置（package.json 等）属工程基建，不 tangle
- 文档结构：00-vision / 01-architecture(总览+ADR) / 02-domain / 03-collector / 04-storage / 05-diagnose / 06-web(一页一文档) / 07-mcp / 08-backtest / 09-trading / 10-wave-plans / 99-glossary
- 仓库：eestock 子目录独立 git（父仓 .gitignore 已配）；远端用户后续处理
