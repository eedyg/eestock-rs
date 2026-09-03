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

---

# Wave 0 决策补记（2026-09-03）

## 定案
- **Wave 0 新设，目标重定义**：完备产品级数据获取——本轮后历史+实时数据链路产品级 ready（交易系统数据除外）；原 Wave 1 顺延
- 范围：domain 补测试 + providers 全量（Tier1 双源 + Tier2 快照池）+ collector 全量（**含 ADR-015 降级模式**）+ storage kline_raw + tushare 日增量 + 部署
- **ADR-017 部署双面分离**：数据面（eestock-data）/ 应用面（eestock-app），唯一耦合点 TimescaleDB，禁止 API 直连，控制通道走库；数据面仅暴露 /healthz（用户选定方案 ii）
- 否决：采集与 DB 同容器（反模式）；数据库内核内采集（违反分层）；宿主机 nohup（非交付形态）
- tushare 日增量：数据面容器内置，交易日 15:30 触发，退避重试 3 次
- 旧 Go 系统彻底停跑（用户确认）
- 验收：实盘 1 日缺口率 <1%；杀腾讯源自动转移新浪+熔断落库；双源全杀进降级模式出 *_approx；tushare 增量 fake-clock 单测 + 真实收盘成功

## 行动项（用户）
- [ ] 旧系统停跑确认（✅ 2026-09-03）
- [ ] Wave 2 前实测 tushare 分钟级接口权限（⚠️ 提前：Wave 0 日增量依赖分钟档权限，首日真实增量即验证）
- [ ] git 远端后续处理

## 勘误（2026-09-03，Wave 0 实施期，父级裁决）

1. **Exchange 深交所端点修正**（design/03-collector/01-providers-spec.md §3）：
   `api/report/ShowReport?CATALOGID=1110` → `api/market/ssjjhq/getTimeData?marketId=1&code={code}`。
   理由：ShowReport 无实盘样本支撑；getTimeData 经 028 verify_quotes_highintensity.py + 冒烟 CSV 实盘验证（证据驱动纪律）。
2. **Code 市场前缀规则修正**（design/02-domain/contracts.md §2.1）：
   920 开头为北交所，须先于 '9'→沪 规则排除（原规则把 920xxx 误判沪市；domain 契约测试实锤）。
3. **SourceId 扩展 `*Approx` 变体**（contracts.md §2.1）：03 §6 降级模式 `source=*_approx` 标记的载体；
   快照池 5 源各一个近似变体，`as_str()` 为落库文本单一事实源（storage 共用）。
4. **依赖批准**：encoding_rs（GBK 解码）+ toml（数据面配置）；不引 uuid，Trace ID 用 rand 生成 32 位 hex。

## 调度变更（2026-09-03，用户决策）

5. **tushare 日增量调度：单一 15:30 → 三时点 18:00 / 00:00 / 08:00（Asia/Shanghai）**（design/04-storage/02-tushare-sync.md §6.2）。
   理由：tushare ETF 历史整理耗时长，收盘后不能立即更新，需多次补全直至收敛。
   口径：三时点各自独立触发完整增量（目标=最近已收盘工作日）、独立退避重试 3 次、各自落审计事件（含零调用轮）；
   前提 = 准确层 upsert 覆盖语义（storage accurate_upsert 测试锁定，已验证成立）；
   与缺陷 2 checkpoint 语义修正（盘中不封当日 / 强制同步目标交易日）并存。
