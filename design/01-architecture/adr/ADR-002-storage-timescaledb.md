# ADR-002：TimescaleDB 单库存储

- 状态：✅ 已定
- 决策：**PostgreSQL 16 + TimescaleDB 扩展**为唯一在线存储
- 理由：压缩（列式压缩策略 90%+，按 code 分段）✅ 用户硬指标；连续聚合内置 1m→N（ADR-004）；ON CONFLICT 首写胜出零成本；MVCC 多读多写成熟；团队 PG 运维经验；Rust sqlx 一等支持
- 否决项：ClickHouse（压缩最强但更新语义绕、新组件运维成本）；TDengine（AGPL+功能墙）；vanilla PG（无压缩不达标）；DuckDB 在线化（单写者模型与多消费者冲突）
- 观察清单（触发再评估）：DuckDB 离线分析（①多年全市场冷归档 ②重型分析需物理隔离 ③深度 pandas 生态）；pg_duckdb（time_bucket 与 Timescale 冲突 issue#934 解决后）
