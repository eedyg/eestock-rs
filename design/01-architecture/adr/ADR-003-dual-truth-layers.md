# ADR-003：双真值层与准确层优先

- 状态：✅ 已定
- 决策：两张 K线表——`kline_raw`（自抓层，新源采集）与 `kline_accurate`（tushare 准确层）。查询经 merge 视图：**accurate 优先，raw 只补 accurate 没有的时点**（继承旧 buildMergedKlineSQL 语义）
- 不设"校验后自动修正"链路：accurate 优先使 raw 层错误天然不可达，raw 保留自抓原貌供诊断分析
- 分歧比对仍产生（诊断系统消费，作为源质量评分输入），但不改数据
- 开放点：~~accurate 层最小粒度受 tushare 积分配额约束~~ **已收敛（2026-09-02）**：用户持付费 ETF 历史档位，全部 ETF 历史数据可查（日级保底）；分钟级接口权限 Wave 2 启动时实测确认
