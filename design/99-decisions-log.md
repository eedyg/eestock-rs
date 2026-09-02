# Grill 决策全记录（2026-09-02，一日收官）

## 定案
- 项目名 **eestock-rs**；eestock 子目录独立 git；entangled 单向文学式 + 一致性门禁
- 全量重写（行情/交易/回测/Web/策略），**Rust**；旧系统冻结只读+立即停跑
- 存储 **PG16+TimescaleDB 单库**（压缩/连续聚合/ON CONFLICT 首写胜出）
- 双真值层：kline_raw + kline_accurate（tushare 付费 ETF 历史档位），查询准确层优先，无校验修正链路
- 只写 1m（间隔可配≥60s），高周期连续聚合；时间范围=增量+当日缺口回填
- 源选取：逐股随机起点+轮询转移；心跳仅限快照池；东财系最低优先级+锁末位；不压测
- Web 8 页全量（06-web 逐页定稿）：React+TS+Tailwind/shadcn+klinecharts+ECharts+WebSocket，桌面优先，局域网免认证
- MCP HTTP/SSE 常驻：行情/源健康/数据质量/交易（独立开关默认关）
- 券商双路线：东财 CDP（chromiumoxide）+ 银河 QMT（xtquant Python sidecar），Wave 3 spike，Wave 4 仅手工
- 回测：7 个全新内置经典策略，展示对标 TradingView/Freqtrade，异步任务+简单参数网格
- Metrics 框架（ADR-014）：trait 编译期注册，写 bar 增量算+回填，metrics hypertable；首批 MA/EMA/MACD/KDJ/BOLL/RSI/ATR/换手率/筹码分布
- 部署：Docker Compose（app+timescaledb）；可观测性=tracing+自产指标（无 Prometheus）

## 行动项（用户）
- [ ] 旧系统停跑确认
- [ ] Wave 2 前实测 tushare 分钟级接口权限
- [ ] git 远端后续处理
