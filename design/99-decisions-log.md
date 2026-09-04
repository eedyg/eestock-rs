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

## 补记（2026-09-03 晚）
- **Web 文档布局表达三层法定为标准**（用户批准）：L1 ASCII 线框（空间骨架）+ L2 区域规格表（六列：id/内容/数据源/三态/交互，与 data-region 锚点一一对应）+ L3 布局骨架代码块（tangle 生成静态结构，视觉样式手写）。规范落 06-web/00-shell.md，试点 01-dashboard.md，用户过目后推广其余 7 页

## 补记（2026-09-03 深夜）— web 布局 8 项裁决
1. **02 告警预览端点**：批准 `GET /api/alerts?limit=10`（复用页面⑦接口形态，W2 实现时最终定稿）
2. **02 告警预览交互**：批准——点击条目跳页面⑦对应告警
3. **05 手续费/滑点默认值**：推迟至 Wave 3 开工时对照旧系统 golang 口径定稿（样机数值仅示意，文档标 TODO-W3）
4. **05 回测默认周期**：批准默认 15m（与 dashboard 先例一致）
5. **06 现价端点**：批准复用 `GET /api/symbols` latest + WS quote
6. **06 市价五档数据源**：推迟至 Wave 4 spike（券商通道 vs 本系统快照池 TencentQt 五档字段，届时实测定夺，文档标 TODO-W4）
7. **03 表单弹窗形态**：批准模态弹窗（遮罩点击不关闭防误触）
8. **布局空间自决项**（04 50/50 并排、06 右栏 W=320、08 锚点导航）：批准

## 补记（2026-09-04）— Wave 1 Phase D：MCP server 裁决

1. **MCP transport 维持 SSE（spec 2024-11-05）口径**（ADR-009「HTTP/SSE 常驻服务」字面合规）；
   批准 mcp crate 引入 `tokio-stream`（workspace 级声明 `0.1`，features `sync`）——
   锁文件零变化（sqlx 传递依赖已在树内，实际零新增编译单元）。
   候选取舍：A tokio-stream（批准，代码最少风险最低）/ B futures-core 手写 Stream impl（多 poll 样板）/
   C 零依赖 Streamable-HTTP-JSON（偏离 ADR-009 字面口径，否决）。决策注记落 design/07-app-plane/01-mcp.md §0。
2. **Backlog（Wave 2 评估）**：MCP Streamable HTTP transport（2025-03-26 spec；SSE transport 已标记
   deprecated）——届时评估双 transport 并存或迁移，本期不做。
3. **部署形态**：MCP 与 web 同进程（eestock-app 复用同一 DI 产物，KISS）、端口独立 8082
   （配置项 `mcp_listen`，env `MCP_LISTEN`）；SSE 端点连接泄漏防护 = SessionGuard drop 注销会话 + 15s 保活帧。

## Wave 0 收官（2026-09-04，架构师终审）
- 复验 5/5 PASS（tester/report/005）：修复质量/门禁/00:00 触发/**3c 实盘自愈（阻断 94s 零缺口零重启）**/准确层收敛 10,604 行
- 项 5 口径裁决：闭环成立——数据已于 00:00 收敛（主目标达成）；08:00 触发失败属环境性（磁盘满，已解除），调度器重排 18:00 + 审计事件行为正确，触发机制已被 18:00/00:00 两次实盘验证
- **Wave 0（完备产品级数据获取）正式收官**：历史（tushare 准确层，三时点自动补全）+ 实时（Tier1 双源轮值+熔断+降级+自愈回切）链路产品级 ready

## Wave 1 收官（2026-09-04，架构师终审）
- 验收 8/8 PASS（tester/report/006）：门禁/REST/WS/SPA/symbols 写链热生效/熔断复位全链/MCP/compose
- 部署偏差 D1（data 镜像滞后）+ D2（static_dir 残留旧值）已修复并实盘复验闭环；红线范围澄清：eestock 自身 docker 归架构师照管
- Backlog 转 Wave 2：D3 慢查询优化、D4 amount 量纲、D5 事件空窗、D6 SPA 回退过宽（/api/* 应 404）、MCP Streamable HTTP 评估、13:00 标签伪缺口、粘源陈旧检测、节假日表

## Wave 2 定稿（2026-09-04，用户确认）
- 告警通知渠道：仅页面⑦展示 + WS 推送；webhook 按需后续单开
- 筹码分布留 Wave 3（ADR-011 不变）；dashboard 密集区叠加随之 Wave 3
- Wave 1 backlog 修复包（D3-D6 + 13:00 标签 + 粘源陈旧）全部并入 Wave 2
- MCP Streamable HTTP 仅 spike 评估，不直接实施

## 补记（2026-09-04 晚）— Wave 2 Phase A 实施裁决记录（质量后端 + 日历 + backlog 清零）

1. **13:00 伪缺口结案（实盘实证）**：上游三源（tencent/sina/tushare）bar 标签集合一致 =
   09:30..=11:30 ∪ 13:01..=15:00（241 个；无 13:00，有 11:30/15:00）。旧「bar 起始时刻 240」口径废止，
   分钟标签纯函数上移 domain::calendar（contracts §2.8），collector/diagnose 共用单一事实源。
2. **D4 结案（实盘查证）**：kline_raw/kline_accurate 的 amount 规范口径均为**元**；真正缺陷是
   tencent_ifzq amount 字段不可信（比值随标的不恒定 1/885~1/1044~1/4.9，无法视图换算）。
   providers 红线本轮不改 → 质量对照只比 close；tencent amount 泄漏记已知缺陷（04-storage §4.4 注记 7）。
3. **D3 结案**：symbols_with_latest 重写为双侧索引回溯 top-2 合并（不再扫 kline_merged 视图），
   实盘 EXCEPT 互减 0 行验证语义等价；19,850ms → 13.5ms（同库 EXPLAIN ANALYZE）。
4. **D5 口径**：非交易时段零事件是既定行为（03 §9.9 静默跳过注记）——质量缺口报告经日历排除
   非交易日，缺口分类三级（source_fault / upstream_no_data / system_gap）承载「事件空窗」区分。
5. **D6 结案**：/api/* 未命中 → 404 JSON，仅非 /api 路径回退 index.html。
6. **StaleData**：ErrKind 新增 stale_data（契约加法）；executor 会话时段陈旧 bar → 事件 + 进熔断 +
   链上转移（03 §3.1 规格）。
7. **POST /api/tushare/sync 暂缓**（父级裁决：采纳候选 B，留 Wave 2 后续 Phase 单开工单——手动轮与
   三时点轮的 checkpoint/退避幂等交互单独评审；过渡态定稿：页面④ 手动触发按钮置灰）。GET /api/tushare/status
   已交付（quota_remaining 恒 null——积分余额未入库）。

## E2E 测试栈定稿（2026-09-04，用户拍板）
- 引入 Playwright E2E（真实浏览器）；运行打真实容器 :8081（a）
- 视觉回归基线从初始建立（b）；动态区域用 mask 结构化基线防分钟级噪声
- 截图走查并入页面验收门槛（用户过目才交付）
