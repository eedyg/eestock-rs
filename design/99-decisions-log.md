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

## O1 结论（2026-09-04 深夜）：非产品缺陷
- 告警 WS 推送 HEAD 已正确接线（AlertEvaluator→hub→socket），载荷/topic 前后端对齐，双端测试本就存在且绿
- tester 早期"0 帧"= 探针脚本 break-on-first-timeout 提前断听 + 部署瞬态（app 09:51/09:54Z 重启）
- 处置：不改码；报告 coder/report/016_o1_alert_ws_push.md 记录证据链 + 正确探针写法
- 提示：验证"推送类无帧"时，禁止用 break-on-timeout 短听；须持续监听 ≥ 评估节拍窗口

## K 线默认视口 + 实时动态（2026-09-04，用户追加）
- 默认视口=当日+前一交易日；向前滚动分页可达最近 10-20 交易日
- 实时进行中 bar 画虚线 + 跳动闪烁，区分已收盘实体直条

## K1 + O1 + R1 处置（2026-09-04，排修轮）
- **K1（WS quote 字段契约）修复**：后端 WS `PushMsg::Quote` 载荷对齐 camelCase `changePct`
  （`crates/web/src/ws.rs` 对 `change_pct` 字段 `#[serde(rename = "changePct")]`），与前端/mock 一致；
  前端 `DashboardStore` 容错归一化 `msg.change_pct ?? msg.changePct ?? 0`（兼容历史帧 snake_case + 防空值 toFixed 崩溃）。
  全帧契约核对：quote=该字段 mismatch（本次修）；bar/health/alert 前后端一致（health `window_secs`、alert `rule_id` 等保持 snake_case，见 types.ts 注）。
- **O1（分时盘中不自动刷新）修复**：`TimeshareChart` 复用 `KlineDataFeed`（1m）`onChange`/`onRealtime`，
  订阅 `WS {type:"bar", code, period:"1m"}` 实时更新当日价格线+均价线（零额外接口）。
- **R1（记录，不修）——高周期 cagg 回填深度**：本容器 cagg（5m/15m/1h/1d）仅回填 ~3 交易日，
  「翻 10-20 交易日」仅在 1m（merged 深历史）验证通过。后续 backlog：考察高周期向前分页是否需扩大
  cagg 窗口或改按需聚合（超出前端组件范围，需后端回填评估），本轮不做。

---

# 统一策略系统决策（2026-09-08，三轮 Grill 定稿）

## 定案（D1-D16，权威细节见 design/12-strategy-system/01-adr.md + 02-plugin-abi.md）
- **统一策略系统**：唯一策略内核驱动 回测/模拟实盘/真实实盘（本期实盘仅 RiskGate+Executor Port 架构预留）；golang 旧系统仅参考，无迁移
- **插件化方案 C**：QuickJS（JS 文本即存即跑）先行，Host ABI 契约预留 WASM；确定性守卫（禁 Date/Random/IO、超时+内存硬上限、状态 save/load、sha256 寻址重放）
- **评分语义**：插件连续分 0-100；加权平均聚合（策略权重可调，无覆盖取 50）；阈值 60/40 可配
- **职责分层（D9）**：插件=决策层（ctx.position 只读全景，门控/DCA/软止损编码进评分）；引擎=执行层（笨规则+目标仓位幂等换算，无固定门控）
- **ExecutionPolicy**：LumpSum + DCA 双模式；止损三层（策略软止损 / Policy 硬止损 trigger:intrabar|close 默认 intrabar / RiskGate 实盘兜底）
- **Registry**：策略一等资源（版本化+sha256+draft→published→archived+权限三级）；编辑已发布版本自动落新 draft；版本 diff 视图；组合预设（P3 可裁剪）
- **Web**：策略列表/编辑器(CodeMirror 6+试算双模式)/回测工作台新页面；评分序列全量落库、UI 抽样
- **sim-live**：保留骨架换内核（Registry 策略源+QuickJS 实例，3策略×30股上限沿用）
- **MCP**：新工具 strategy_*/bt_* 落现有 SSE；Streamable HTTP 迁移维持独立 backlog
- **并存期**：新工作台独立页面/API 族；旧回测页+内建策略保留至 P4 验收后退役
- **实施分期**：P0 runtime+契约测试 → P1 strategy-core(聚合/Policy/引擎) → P2 Registry+编辑页 → P3 工作台+MCP → P4 sim-live 切源+旧退役 → P5 实盘契约文档化

## 旧策略系统退役（2026-09-10，12-strategy-system P4b / D16 终章，架构裁决：彻底删除而非仅隐藏）
- **旧回测服务链删除**：`application::BacktestService`（service/params/types）+ web 旧 REST `/api/backtest/*`（handlers/DTO/WS `backtest_progress` topic）+ app bin DI + `PgBacktestStore`/`BacktestRunStore`/`BacktestProgressSink` 端口（backtest_runs/backtest_results 表保留于库内不再读写，迁移 0011/0012 不回收）。
- **backtest crate 摘除**：`engine.rs`（旧单策略 Engine/run）+ `strategies.rs`（7 款内建策略注册表）删除；保留 `fee/indicators/metrics/types`；ABI 共用类型 `ParamValue`/`StrategyParams` 迁入 `types.rs`（strategy-core/strategy-runtime/simlive/application 继续引用）。
- **simlive 旧编排器删除**：`RealtimeStrategyOrchestrator`（P4a 起 #[deprecated]）及其三档映射 `signal_to_score`/`signal_str`；聚合共享件（`weighted_aggregate`/`aggregate_to_signal`/`StockEvaluation`/`StrategyScore`/阈值常量）保留供 `PluginStrategyOrchestrator`。
- **旧回测前端删除**：页面⑤ /backtest（features/backtest 旧页组件、`BacktestGrid` 布局、05-backtest 预览、api client/mock/types 旧回测族）；导航旧入口移除；/backtest 路由重定向 /backtest-workbench。`chartUtils`/`format`/`ScopedKlineFeed` 被工作台复用保留。
- **迁移等价性测试退役**：strategy-core `tests/equivalence.rs`（旧引擎↔JS 插件逐 bar 等价，并存期验收使命完成）删除；`engine.rs` 费用 parity 交叉验证尾部移除（ensemble 自身断言保留）；`reference.rs` 插件顺序断言改硬编码 7 款 id。
- **保留判定**：`BacktestBarRead`/`BacktestBarReader`（strategy 试算/workbench/mcp bt_* 复用）、`application::fee::to_fee_model`、`parse_period`/`to_bt_bar`（迁 application::bar_map）、MCP 无旧回测工具（sim_*/strategy_*/bt_* 全为新系统）。

---

# 统一策略系统实施收官（2026-09-09~10，P0-P5 全六期）

## 实施裁决（架构师全权期，父级授权「所有决策你来做」）
- 新依赖批准：rquickjs 0.11（D1 运行时，MSRV 1.85 约束）、sha2 0.10（ABI G4 哈希寻址）、前端 CodeMirror 系（D13）
- 红线豁免 2 次（均增量加法+测试锁定）：strategy-core observer 钩子（P3a 进度/取消，EnsembleError::Canceled 独立枚举）；strategy-core validate 增 sell<50<buy（P4a MINOR-4，中立 50 必落 Hold 区）
- P4b 物理退役（D16 终章）：旧 BacktestService 链/内建 7 策略/旧编排器/旧回测页全删（-10500 行）；backtest crate 收敛 fee/indicators/metrics/types；过渡性测试（equivalence 等）按裁决 A 退役，验收证据在 git 历史
- sim-live actor 承载模型（QuickJS !Send 常驻实例）：每会话 worker 线程 + bounded(4) mpsc + oneshot；WorkerExitProbe/panic 隔离/代际守卫
- MCP 停用开关=B 方案（McpState 单一开关）：sim_* 开关是下单风险语义，不盲目复刻死能力
- 列表徽章口径：latest_published?.approval_level ?? latest_version（已发布版本权限优先）
- P5 实盘契约经 oracle 挑战修订：R7 增险/减险语义（减险永远放行）、R9-R12 市场硬约束（T+1 品种属性/整手/涨跌停/可用资金）、恢复三段式（halted→对账→人工复位）、Executor 四条款（幂等本地台账/fill 事件流/归一化/day-order）、开工条件+3（浸泡期/对账演练/绝对资金封顶）

---

# 技术债清算（2026-09-10，后端车道 TD-1~TD-3）

## TD-3 旧回测残留表回收（架构裁决：执行 DROP）
- **处置**：迁移 `0024_drop_legacy_backtest_tables.sql`（`DROP TABLE IF EXISTS backtest_results, backtest_runs`，先子后父：子表 `backtest_results.run_id` 存 FK 约束 `backtest_results_run_id_fkey` 引用父表 `backtest_runs(id)`（0011 建表，`ON DELETE CASCADE`），先 DROP 子表再 DROP 父表顺序正确且必要）；`migrate_check::EXPECTED_RELATIONS` 同步移除两表；design/04-storage/schema.md §4.3.5「未来 DROP 另立项」注记结案（见 §4.3.15）。
- **依据**：两表自 P4b（D16 终章）退役后全 workspace 零代码读写（仅 migrate_check 台账 + e2e 陈旧清理残留引用）；裁决明确接受 DROP 不可逆（历史回测数据随表删除）。
- **遗留（已结案 2026-09-10 收尾包）**：`web/e2e/simlive-deep.e2e.ts` / `backtest-form-task.e2e.ts` / `backtest-compare-gridrank.e2e.ts` 的 `backtest_runs` SQL 清理/快照残留已清理——`backtest-form-task.e2e.ts` / `backtest-compare-gridrank.e2e.ts` / `backtest-result-trade-modal.e2e.ts` 三个文件整体针对已退役旧回测页（/backtest + 已删 `/api/backtest/*`），整文件删除；`simlive-deep.e2e.ts` 主体仍测现存 sim-live 功能，仅清理段改为 strategy_run 系表清理（P4a 起对比 run 落 strategy_run，sr_ 前缀字符串 id，FK 级联 strategy_run_result）。

---

# 杂项裁决补记（2026-09-10）
- **fee wire 增可选 stamp_duty_pct**（缺省 0.05 向后兼容）：原 ADR bt-1「印花税 0.05% 市场常量非用户参数」修订——ETF 现实无印花税，平台数据面大量 ETF 标的，硬编码属平台缺陷；ETF 类回测显式传 0。
- **T0 做T策略「T0做T·主张段捕获」发布**（st_1789041627252_000079）：16 轮实验+样本外冻结验证，诚实结论未达 50% 稳健年化（豆粕全窗 +23.5% 最可信）；适用边界=MA240 上行高波动 T+0 品种。

---

# ADR-020 看板默认 K 线视口：交易日 → 根数（2026-09-13，用户拍板）

- **触发**：用户报告「默认 K 线视口只影响 15m，其余周期不响应」，并要求改为「默认多少个 bar 且应用于所有 period」。
- **根因（证据链）**：配置单位=**交易日**（`feed.ts:8-25` `BARS_PER_TRADING_DAY[period]×days`）→ 初始可见根数由 `space = clamp(round(W/target),1,50)`（`KlineChart.tsx:247-255`）反推，而 klinecharts `barSpaceLimit={min:1,max:50}` 为**引擎硬限**且越界**静默 return**（`node_modules/klinecharts/dist/index.esm.js:13249 / 13667`，`visibleBarCount = _totalBarSpace/_barSpace` :13534）→ 可达可见根数恒为 `[W/50, W]`（W≈主图 980px）。target 落在区间外的周期被夹死：1d/1w/1mo 在 1–19 天恒显 ~20 根、1m ≥3 天即饱和且撞后端 `MAX_LIMIT=1000`，仅 15m（默认周期）全程有效 → 与用户观察一致。详见 `design/06-web/11-kline-viewport-bars.md` §1。
- **决策**：①`viewport_days` → **`viewport_bars`**（根数，与周期解耦），默认 **120**、范围 **30–600**（前后端同构）；②**不做旧值兼容**（旧 `{"viewport_days":n}` 视为未配置 → 回 120，不迁移不折算）；③**主图+宫格统一**同一配置（修 `GridCell.tsx:31` 硬编码 120），回测弹窗固定 120 根不读配置；④删除 `BARS_PER_TRADING_DAY`/`defaultPageSizeForPeriod`，`pageSize = viewportBars`；⑤`ResizeObserver` 宽度变化重算 barSpace，**用户手动缩放后不重算**，「回到最新」恢复；⑥夹取仅作安全网 + 结构化留痕（`data-viewport-fit` 属性 + 夹取告警）。
- **同源缺陷一并处置**：F2 单页 `241×days>1000` 截断致 `hasMore=false` 深翻封死（N≤600 后不可达）；F5 部署级 e2e `dashboard-periods-ma.e2e.ts:40` `INIT_PAGE={1w:30,1mo:24,1d:2,1m:482}` 陈旧口径。
- **产出物**：`design/06-web/11-kline-viewport-bars.md`（ADR + 接口契约 + TDD 规格 + 观测性）；契约表同步 `design/07-app-plane/00-web-api.md`、`06-web/01-dashboard.md`、`06-web/08-settings.md`。

---

# ADR-021 dcap 指标：镜像产物的单一源约定（2026-09-13，用户批复「按推荐」，方案 A1）

- **权威正文**：`design/14-dcap-indicator/01-adr.md`（同目录：`02-spec.md` 规格契约、`03-test-plan.md` TDD 规格、`04-implementation-plan.md` 派单、`05-issue-drafts.md` 工单草案）。
- **一句话结论**：dcap 指标的算法正文**只存在一处**（`02-spec.md` 的代码块，ADR-007 事实源），由 entangled 单向生成**两份镜像产物** —— 前端 `web/src/features/indicators/dcap.ts`（klinecharts 副图 `calc` 消费端）与插件 `crates/strategy-core/reference-plugins/dcap.js`（rquickjs 求值 + `reference.rs` 第 8 条播种）—— 靠「CORE 哨兵区间逐字节相同」单测 + 跨运行时黄金样本逐位等价 + `check-tangle` 漂移门禁三重兜底，杜绝「图上那条线与策略里那条线不是同一条线」的静默漂移。
- **决策要点**：
  - D1 单一源 = 文档代码块；D2 两份镜像产物（前端模块 + 插件）；
  - D3 **不改 `entangled.toml`**（JS 是 entangled 2.4.3 内置语言，带文件属性的 JS 代码块开箱可用）+ D3' 首用机制一次性验证（只验不改）；
  - D4 镜像体断言是**自动化单测**（哨兵区间逐字节相同），不是文档纪律（entangled 一块一文件、无法扇出）；
  - D5 跨运行时逐位等价（同一组黄金样本驱动两个产物）；D6 纳入既有门禁，**禁止 `--force` 变绿**；
  - **不改插件 ABI、不改引擎**：dcap 是插件内部实现细节，出口只有 0–100 分，走平台既有聚合与 60/40 阈值（不做「per_bar 留 raw 值」方案）。
- **落地范围**：插件侧（浮点确定性铁律：禁 `pow/exp/log`、禁增量累加、CORE = 无类型注解 ES2015 子集；`init` 内确定性归一化 `n_m←max(n_m,n_s+1)`、`n_l←max(n_l,n_m+1)`，幂等）；配置面 `GET/PUT /api/config/dcap`（复用 `app_config`，**无新迁移**；非单调 n 严格 400，与插件面「容忍并归一化」**有意不同**）；前端 DCAP 独立副图 + `precision: 5`；`th` 只属策略参数、不进图表接口。
- **关联**：ADR-007（文学式单一源 / `design/` 即事实源）、ADR-018（门禁硬化：沙箱权威判据 + `--force` 禁令 + 假绿回归）、插件 ABI（`design/12-strategy-system/02-plugin-abi.md`，本 ADR **不改 ABI**）。
- **产出物**：`design/14-dcap-indicator/**`；镜像产物 `web/src/features/indicators/dcap.ts`、`crates/strategy-core/reference-plugins/dcap.js`（`reference_plugins()` 7→8 条、播种计数 11→12）；编程手册 dcap 章节（`design/12-strategy-system/04-strategy-programming-guide.md` §12）；配置端点行已随 P3 落地（`design/07-app-plane/00-web-api.md`）。

---

# ADR-024 回测区间护栏重构（去日历天数档）与引擎 O(n²)→O(n) 流式化（2026-09-18，用户三轮确认：「不要上限限额，指定哪个时间范围就按时间范围回测」「应该使用流式计算才对」「全按推荐」；另追加「回测不能选择 30min」）

- **权威正文**：`design/16-backtest-scalability/{01-adr.md, 02-spec.md, 03-test-plan.md, 04-implementation-plan.md, contract-vectors.json}`。
- **一句话结论**：「分钟级≤3 个月（93 天）/ 日线≤5 年」这条护栏**不是产品需求，而是引擎每 bar 复制整段历史的 O(n²) 拐点被误写成规则**（`quickjs.rs:380` 每 slot×每 bar `bars[..=index].to_vec()`）⇒ 删除一切日历天数档，改「按实际资源 + 可确认放行」；引擎会话化 + 共享缓冲 + **指标增量（P2/P3 必须同批**：实测指标二次项 = 复制项的 **16.2×**，只做 P2 等于只做 1/16）；结果三类序列（per_bar/net_value/drawdown）改**分块落库 + 显式抽样**（后端不做*隐式*有损）；M30 打通回测/试算/MCP。
- **证据基础（全部实测）**：改造前渐近 log-log 斜率 **1.878–1.900**、分配字节与预测式 `slots×48B×Σ(i+1)` 吻合到 **1.0001**（`tester/evidence/241_*`）；指标重插件 200k bar = 239.7 s vs 轻插件 15.6 s（`242_*`）；真路径**每 run 固定 1003 次 `UPDATE strategy_run`**（`243_*`、`244_*`，推翻架构师「背压/丢弃」推断）。
- **决策要点**：D1 护栏语义（**无日历档**，极宽物理护栏 + 二次确认；预估算子须用生产端到端口径）；D2/D3 区间按**服务口径并集**（accurate ∪ 兜底，非 accurate 单层）收缩并回显 requested/effective/clamped，空交集 400；D6 指标增量（**必要性由实测升级**）；D7 插件 ABI 零变更（共享缓冲起步）；D8/D9 分块 + `result_format` 判别列（**禁止用空 jsonb 表达「数据在别处」**）+ summary/bars/curve 三读法；D10 ADR §13.4 口径修订为「不做隐式未标注的有损」；D15 每 run 固定开销治理（**先仪表后优化**）。
- **关联**：ADR-003/004（双真值层/派生）、ADR-007/018（文学式单一源 + tangle 门禁）、ADR-019、**ADR-023**（30m，本 ADR 修订其「回测 gate 拒绝 30m」注记）、**ADR-025**（测试载体治理）；`design/08-backtest/01-engine-adr.md`、`design/12-strategy-system/01-adr.md` §13.4/§13.5。
- **产出物**：`design/16-backtest-scalability/**`；**P0 已落地并验收**（M30 打通 + 周期白名单收敛为 `bar_map::supported_backtest_periods()` 单一事实源 + 四方防漂移断言）；P1/P1b/P1c 取证完毕；P2（引擎线性化）起为后续批次。

---

# ADR-025 TimescaleDB 作业层可观测性与测试隔离载体治理（2026-09-18，用户「全部按推荐」）

- **权威正文**：`design/01-architecture/adr/ADR-025-tsdb-job-observability-and-test-carrier-governance.md`。
- **触发事故**：**2026-09-17 03:56:20Z → 09-18 02:32Z（22.6 小时）生产 5m/15m 数据停摆、日涨跌幅昨收被冻结**（用户可见：5m/15m「像每 30 分钟才更新」、增幅错 0.688% vs 真值 0.779%）。
- **根因（精确到秒）**：TimescaleDB **每库一个常驻 scheduler** 占用 `max_worker_processes` 槽位（配 8，而 `timescaledb.max_background_workers`=16，**配置不一致**）；带 TSDB 的库增至 6 个（其中 **4 个是 09-17 03:47–04:02 创建的 ADR-023 E6b 隔离测试库**）⇒ 常驻 7/8 ⇒ 全部 job `failed to start a background worker` ⇒ 生产 job 连续失败 **75,173 次**、17 个 job 全逾期。
- **处置**：删 5 个遗留测试库（槽位 7→3，作业即刻转 Success）+ 手工 `refresh_continuous_aggregate` ×8 回填缺口（5m 09-17 行数 1100→2200、15m 396→792、昨收 8.864→**8.856**）+ `max_worker_processes` 8→**32**（compose `-c`，防复发）。证据：`tester/evidence/245_tsdb_worker_slot_incident/**`。
- **为什么没人清（用户追问，逐条有原文）**：①各车道只清「自己前缀」、对别人的明文「未动」；②门禁只管「不新增」不管「不残留」；③「登记残留」当成了处置；④**工具只建不删**（`scripts/testdb-init.sh` 全篇无 teardown）；⑤收尾动作最先被 30 分钟上限截断；⑥先例被点名也没人动。
- **决策要点**：D1 worker 名额自洽不变量 + 启动自检；D2 **DB 作业层进观测面**（cagg 新鲜度 / job 失败率 / 槽位占用，复用 `alert_rules` 通道）；D3 测试载体治理（命名 `tmp_<lane>_<ts>`、必须 `--drop`、验收用**正向断言**、隔离优先 **schema 级** 而非整库、清理不得放最后一步、**残留必须带 owner+到期日**）；D4 事故顺序纪律（先量化缺口 → 再修因 → 最后回填）；D5 ADR-023 §6.1 第 8 条升级为本 ADR 强制规则。
- **产出物**：ADR-025 本体（已裁决待实现）+ 项目 skill `eestock-db-migration-and-cagg-ops` 的 Pitfalls/Verification 补充；实现项 4 项待派（`testdb-init.sh --drop`、三项监控、启动自检、车道模板）。

---

# ADR-026 回测结果的执行完整度审计与口径披露（2026-09-19，用户授权「按建议修复，自主决策」）

- **权威正文**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`。
- **触发事件**：`sr_1789738328788_000005`（518880/D1，`Dca{tranches:100,interval:1}`）被读成「交易明细只有一条」，实测为「名义只投出 **41.40%**（敞口）/ **41.61%**（含佣金）、计划 100 批只推进 **42** 批、回合数 **1** 且由期末**强平合成**」；全库 174/359 个「有已实现回合」的 run 全程无真实卖出，其中 132 个读出「胜率 100%」。
- **决策要点**：新增**只读派生的执行完整度审计**（按需从已落库事实计算，落库与读侧解耦）：D1 唯一口径（意图/成交/未执行/敞口/资金占用/回合/强平合成，见 §2.1）；D2 `GET /api/workbench/runs/{id}/audit` + MCP `bt_get_run_audit`；D3 **`deployed_*`（敞口，不含费用）与 `cash_consumed*`（含佣金）必须分别命名**（固化「41.40% vs 41.61%」同物异名的教训）；D4 判据常量具名（`PARTIAL_DEPLOYMENT` 阈值 `deployed_pct < 0.99` 等）；D5 `TradeDetail` 增 `reason: Option<String>`（`Policy|StopTrigger|ForceClose`，`#[serde(default)]` 兼容历史 run，**不改 `trade_count` 语义**）；D6 警告**非阻断**（仅披露）。
- **明确不做**（登记为技术债）：提交期体检、发布期信号分布体检、历史 run 回填、未执行挂单归因（仅区分 `last_bar_unfilled`）。
- **关联**：ADR-024 P6（`/fills` 为成交事实源）、ADR-019（fee 契约复算佣金）、ADR-025（测试载体治理）；`design/12-strategy-system/01-adr.md` §13.4。
- **产出物**：ADR-026 本体（已裁决）+ 本批实现（纯函数审计 `crates/application/src/audit.rs`、端点、MCP 工具、`TradeDetail.reason`、可观测性）；证据 `coder/evidence/20260919_adr026_backend/**`。

---

# ADR-027 交易明细分层显示（L1 回合 / L2 逐笔）与回合口径统一（2026-09-20，Grill 十问闭合；P1/P2「按推荐」确认）

- **权威正文**：`design/01-architecture/adr/ADR-027-trade-detail-two-level-round-trip-model.md`。
- **触发事件**：交易明细无法回答「这一笔交易是怎么形成的」——DCA 分批建仓/部分卖出在 `trades` 里不可见（`TradeDetail` 仅在完全平仓时合成），与 ADR-026 触发事件（`sr_1789738328788_000005`）同源；用户提出「第一层=完整一次交易、第二层=该交易内的买入卖出细则」。
- **决策要点**：D1 **L1 = 全回合口径**（金额字段 = 该回合所有成交加总；`pnl` = 回合真实已实现盈亏，部分卖出分支必须进账本）；D2 **Scope 全域统一**（回测 + 在线试算 + sim-live 共用同一回合定义/聚合实现/测试向量）；D3 **历史清空**（先 `pg_dump` 归档 → `TRUNCATE`，保表结构与迁移链，禁 DROP）；D4 **费用上游事实源分列**（回测 Fill 补 `trade_value/commission/stamp_duty`；sim-live 把合并 `fee` 拆回两列；**禁止下游复算**——`fee.rs:90-98` 最低佣金分支不可逆）；D5 **L1 粒度 = 整仓回合**（FIFO/lot 降级为归属算法；`trade_count` = 已清仓回合数不变）；D6 **归属键 = 引擎成交时刻打 `rt_seq`**（整数序号，禁 `[open_bar, close_bar]` 窗口推断）；D7 **L1 = ledger 派生视图**（唯一聚合实现；`Open` 态回合进同一列表；回测保留强平、sim-live **不**强平；sim-live 增运行中读路由）；D8 **L2 懒加载**（L1 带摘要元数据，展开按 `rt_seq` 拉分页）；D9 **L2 双口径 + 累计列**（`avg_price_excl_fee` / `avg_cost_incl_fee` 必须带限定词；`cum_*` 末行 == L1）；D10 **UI 手风琴展开** + 对账不一致**强制显式告警**（冻结两侧数值，禁静默按 L1 渲染）；D11 **取数完整性统一契约**纳入范围（含 K 线标记 5000 首屏缺口整改）。
- **明确不做**：不引入「成本对手方 / lot 归属」列；不对 sim-live 引入期末强平；不做历史数据回填或双写兼容；不改 `net_profit`/`max_drawdown`/`sharpe` 算法。
- **影响披露**：D1 生效后 `win_rate`/`profit_factor`/`avg_hold_bars` 取值会变（源自 nav 的三项不受影响）；sim-live `trade_count` 语义由「lot 匹配数」变为「已清仓回合数」⇒ 既有结论不可比（与 D3 同步）。
- **关联**：ADR-024 P6（`/fills` 成交事实源）、**ADR-026 D5**（`TradeDetail.reason`；本 ADR 扩展其字段与语义）、ADR-019（fee 契约）、ADR-025（测试载体治理）、ADR-007/018（tangle 门禁）、ADR-003/004。
- **产出物（分阶段）**：第一批 = ADR-027 本体 + 本条目；第二批（待评审通过）= `design/17-trade-detail-layering/02-spec.md`、`03-test-plan.md`、`04-implementation-plan.md`；实现由 coder/tester 子代理按 TDD 执行（**先复现测试后改引擎**）。

---

# ADR-028 回测结果可视化：持仓比率序列、结果页时间窗联动、L1/L2 跳转定位（2026-09-20，用户补充需求；「全部按推荐」）

- **权威正文**：`design/01-architecture/adr/ADR-028-result-visualization-position-ratio-and-window-sync.md`。
- **批次**：与 **ADR-027 合并**为「结果载荷 v2」不兼容批次（M1：只清一次历史、只发一次不兼容版本）。
- **触发需求（用户原话）**：①新增「持仓比率」视图（像净值一样的图，详细来定）；②K 线/vol 可平移缩放，但净值、聚合总分、各策略评分等视图**不跟随** K 线时间范围；③L2 交易明细需一个按钮，点击后**所有视图跳转到该笔成交的时间段**。
- **决策要点**：D1 持仓比率 = **引擎逐 bar 写下的可抽样事实**（`BarRecord` 增 `qty`/`position_value`/`cash`，新增 `ResultKind::Position`；引擎在净值压入点已同时持有两者，零成本可得）；**口径消歧强制**：`position_ratio`（时点市值/时点净值）与 ADR-026 的 `deployed_pct` / `cash_consumed_pct`（区间累计/初始资金）**三物分别命名**；D2 结果页时间窗 = **页面级多源共享状态**（K 线交互 / L1-L2 跳转 / 重置回退），程序化写窗必须回声抑制 + `rev` 防乱序；D3 `/curve` 增 `from_ts`/`to_ts`（缺省全区间 ⇒ 向后兼容）+ 窗口内重采样 + ~200ms 节流以最后一次为准（**禁**前端裁剪点变稀、**禁**旧数据静默顶替）；D4 L2→「定位」（成交居中 120 根）、L1→「看全过程」（回合区间）+ **按钮语义方案②：L1 行 `[明细]`（展开 L2）+ `[跳转]`（回合区间）、L2 行 `[明细]`（该笔完整字段）+ `[跳转]`（定位该笔）**，取消隐式“点击整行展开”；带窗口历史栈 + 全览；sim-live 跨标的则**切换 K 线标的并显式提示**；D5 ADR-027 D11 完整性契约同样约束窗口路径。
- **补问二结论（现状勘查）**：结果页与其他视图之间**根本没有同步逻辑**——`ChartSyncContext.Provider` 全仓唯一挂载点在看板 `MultiPeriodChartStack.tsx:337`（结果页为 NOOP 注册表）；`KlineResultChart` 把 `onManualZoom` 传空实现；三条曲线走 `/curve?k=2000` 全区间一次抽样；`mapLine` 按**数组下标**映射 x（忽略 ts）⇒ SVG 视图**连时间轴都没有**。⇒ 新增 **D2.1 视图时间轴重建**：新增 `mapLineByTs`、x 定义域必须为共享窗口（禁用数据自带 min/max）、对齐基准 = K 线可见 bar 的 ts 区间（误差 ≤1 根 bar）。
- **关键坑（已核实）**：`setBarSpace` 越界会**静默 return**（默认 max=50）⇒ 宽窗口跳转必须放宽 `barSpaceLimit` 或改 `scrollToDataIndex`，并**断言跳转成功**（`syncChartStub.ts:7`）；`mapLine` 按索引铺排（`chartUtils.ts:9-22`，3 个调用点 `AggregateScoreChart:38` / `EquityDrawdownChart:41` / `ComparePanel:47`）⇒ 不得改其语义，只能新增 `mapLineByTs` 并一并核对调用点。
- **明确不做**：不做双向自动联动（除程序化跳转）；不做本地聚合（ADR-022 禁令）；不新增成本口径持仓比率。
- **关联**：**ADR-027**（同批次）、**ADR-022**（跨图同步原语 / 时间跨度误差 ≤ 1 根 bar）、ADR-024 P6 + D10（显式抽样披露）、ADR-026（口径消歧先例）、ADR-020（回到最新 / barSpace 语义）。
- **产出物**：本 ADR + 本条目；契约增量并入 `design/17-trade-detail-layering/02-spec.md`（第二批，与 ADR-027 合并）。

---

# ADR-028 D2.4｜曲线只画**评估段**：预热段（warmup）不参与分数曲线（2026-09-22，用户实测 + 决策 A）

- **权威正文**：`design/01-architecture/adr/ADR-028-result-visualization-position-ratio-and-window-sync.md` §2.2e（D2.4）。
- **触发事件（用户原话）**：「发现聚合总分和各策略评分的缩放比例和净值不一样，导致显示错误」→ 复核后用户判词：「**聚合和各策略评分的 scale 不对，净值是对的**」。
- **取证**（用户截图逐像素分析；本容器无浏览器，用 JPEG 解码 + 逐列亮度/色度迹线）：净值/持仓只覆盖右侧 **≈17% / ≈12%**（左侧 80% 对比度增强后为纯背景），聚合总分/各策略评分铺到 **≈83% / ≈85%**，K 线蜡烛与两者同尺度（≈8 px/bar）。报告：`coder/report/adr028_curve_y_scaling_mismatch_analysis.md`。
- **根因**：引擎在 **warmup 预热段**仍逐 bar 评分（`per_bar` 全量记录并标 `warmup`），但**不产净值/回撤/持仓**（`crates/strategy-core/src/engine.rs:937-959`）⇒ 四条曲线共享同一 x 轴时，两条分数曲线横跨预热段、价值类曲线只覆盖执行段；前端此前**不知道预热段存在**（`WorkbenchBarRecord` 无 `warmup` 列）。
- **决策（用户选 A）**：**分数曲线不画预热段** —— 曲线数据裁到 run 的评估区间 `[from_ts, to_ts]`（后端 effective 区间）；K 线卡本就取 `[run.from_ts, run.to_ts]` ⇒ 四条曲线与 K 线同段对齐。
- **硬约束**：① 边界含端点、**只按 `ts` 判定**（legacy/旧 run 同样成立）；② `from/to` 不可得或 `from > to` ⇒ **不裁剪**（不静默清空）；③ **禁止静默有损**：裁剪根数必须回传并由 UI 标注「预热段 N 根不计入」（N 优先取 `config.warmup_effective`），脚注口径改为「评估段 共 M bar」；④ 逐 bar 明细/事件日志（事实表）**不裁**；⑤ **不新增/不改 `/curve` 请求参数**（不触碰「全览 ⇒ 不传窗口参数」的冻结口径），裁剪在客户端派生层单点完成。
- **明确不做**：不改后端序列（不为 warmup 段补净值/持仓点——留待需要「全区间可比」时另裁）；不在本波暴露 `per_bar.warmup` 列到事实表（技术债，见报告 §「残留」）。
- **关联**：ADR-024 D10（禁静默有损）、ADR-028 D2.1/D2.3（x 域与共用绘图区几何）、ADR-026 §2.1（口径消歧先例）、`design/12-strategy-system/01-adr.md` §13.5.1（warmup 口径）。
- **产出物**：`web/src/features/workbench/runSeriesRange.ts`（新，纯函数）+ `useRunSeries`（chunked/legacy 两路径同口径）+ 两张分数卡脚注披露；测试 `runSeriesRange.test.ts`(7) / `useRunSeries.test.ts`(+2) / `scoreCurveWarmupNote.test.tsx`(3)。

---

# ADR-028 D6/D7｜结果页「K 线尺寸」与「明细上下分层」（2026-09-23，用户逐条裁定 + 真渲染取证）

- **权威正文**：`design/01-architecture/adr/ADR-028-result-visualization-position-ratio-and-window-sync.md` §2.6（D6）/§2.7（D7）/§4 第 8–10 条/§5。
- **触发（用户原话）**：「k 线窗口太小了，根本看不出来变化」「无法调节其窗口高度（之前不是提了调整窗口的需求了嘛，为什么没有做）」「k 线视图默认就要大一些，然后可以调节」「交易明细…跳转之后整个 scale 变得特别小，也是完全无法观看」「买入卖出点完全把 k 线图遮挡完了」「明细做成另外一个视图，不在 k 线/持仓比例等一组里」。
- **取证（真渲染，`tester/evidence/20260923_result_ux_probe/`）**：①卡高拖拽**本身可用**（256→496、持久化、双击复位），但把手 **6px、悬停恒透明**（服务构建 `hover:bg-acc1/40` 规则数 = **0**）、可命中带仅 `y=329..334`（上方 20px 属 klinecharts），同卡内另有引擎分隔条充当「假把手」；②默认态 **蜡烛主图 67px < VOL 100px**、蜡烛实体高中位 2px（p10=0）、卡头 61px（其中 40px = D4.2 指标行）⇒ 「看不出变化」归因为**卡高**；③既有 D4.2/D5 规格覆盖了「默认 256/拖 +150/复位/持久化」，盲区 = 主图高、卡头高、遮挡率、跳转 scale 自洽性、跳转后曲线空、跳转后明细可见性；④跳转把整页 `scrollTop` 1388→40、表体 `top 1592`（视口 800）⇒ 明细被顶出视口。
- **裁决（用户选）**：D6 = 默认 **520px** + 头部预设 **S/M/L 260/420/560** + 拖拽微调 + 双击复位；**min 200 / max 视口高−200**；**记忆**（结果页独立 key）；**主图 ≥320px（520 卡高）、副图合计 ≤120px、卡头 ≤48px、主图硬下限 ≥160px**；把手 **≥12px + 悬停可见**（修 CSS 规则缺失）。D7 = **上下分层**（上栏含 K 线+窗口条+四曲线卡、全宽、内部滚动；下栏 = 明细四块 + 内部 tab、独立滚动；**整页不滚**）；下栏默认 **40% 视口高**、可拖拽、可折叠、记忆；**跳转时下栏完全不动**，只在上栏内部把 K 线滚回可见 + 保留 D4.1 高亮。
- **明确不做（挂起，仅登记）**：跳转 scale 缺陷（含 `wb-window-probe` `ok=true` 假绿、跳转后 4 张曲线卡空白，机制未定位）、标记遮挡 37.1% 降噪口径、D2.4「预热窗口内空图缺 view 级文案」、明细独立路由页/切换式。
- **关联**：ADR-028 §2.4b（D4.1 高亮）/§2.4c（D4.2 缩放与配置隔离）/§2.5（D5 完整性）、ADR-024 D10（禁静默有损）、ADR-023 §6.2（改契约须全域枚举受影响测试）、ADR-018（tangle 门禁）、`AGENTS.md`（gitnexus 门禁 + **代理产物不入库**）。
- **产出物**：本条目 + ADR-028 §2.6/§2.7 + `design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md`（方案与实施计划）；实施 = `web/src/features/workbench/{resultCardHeights.ts,resultLayout.ts,useResultLayout.ts,DetailPane.tsx}` + `cardResize/KlineResultChart/ResultView` 改造 + `web/e2e/adr028-d6-kline-size.e2e.ts`、`adr028-d7-detail-split.e2e.ts`。
