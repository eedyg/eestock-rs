# Wave 2 Phase A — 数据质量后端 + 交易日历 + 后端 backlog 清零（coder 变更报告）

> 本报告位置：`eestock-rs/coder/report/011_wave2_phaseA.md`
> 全程 TDD（先改 design 代码块 → tangle → 测试），门禁三件套 + 实盘冒烟见 §6。

## 1. 变更总览（what changed）

**我的范围**（与并行告警 worker 已协调；对方范围 crates/alert、web/src/alerts.rs、web/src/features/alerts/、design/07-app-plane/02-alerts.md、0009 迁移不在本报告）：

| 层 | 文件 | 变更 |
|---|---|---|
| design | `design/04-storage/schema.md` | +§4.3.2 交易日历节假日表（0008 块）+ §4.4 注记 6/7（日历口径、D4 结案） |
| design | `design/02-domain/contracts.md` | ErrKind+`StaleData`；+§2.8 domain::calendar（241 标签实盘实证口径）；§2.4 加法端口 QualityRead / HolidayCalendarRead / HealthEventsRangeRead / TushareStatusRead + 读模型 |
| design | `design/03-collector/00-design.md` | §2/§5 日历口径、+§3.1 粘源陈旧检测规格、§7 事件模型 +stale_data 行 + D5 注记；calendar.rs/scheduler.rs/gapfill.rs/service.rs/executor.rs 块改写；4 个测试文件块更新/新增 |
| design | `design/03-collector/02-data-plane.md` | eestock-data 装配 HolidayCalendar + HolidaysReader |
| design | `design/04-storage/03-raw-writer.md` | migrate_check EXPECTED_RELATIONS +"holidays" |
| design | `design/07-app-plane/00-web-api.md` | §1.1 REST 表 +4 端点、§1.3 D6、§1.4 边界、+§2.1 QualityService、§3 reader.rs D3 重写 + 新读端口、§4 web dto/rest/state/lib/spa、§5 eestock-app 装配、+§9 集成测试 |
| design | `design/07-app-plane/01-mcp.md` | MCP④ get_data_quality（schema/dispatch/impl/tests/mocks/装配注记） |
| design | `design/05-diagnose/00-design.md` | 分歧率定稿口径 + QualityService 接口行 |
| design | `design/06-web/04-quality.md` | §7.1 响应线格式定稿 + POST sync 暂缓注记 |
| design | `design/99-decisions-log.md` | Wave 2 Phase A 裁决记录 7 条 |
| migrations | `0008_holidays.sql`（新） | holidays 表 + 2026 全量 34 行（来源：国务院办公厅 2026 年节假日安排通知 2025-11 发布 + 沪深交易所休市安排；块头注明 tushare trade_cal 复核手段） |
| domain | `src/calendar.rs`（新）、`src/lib.rs`（手写例外 +1 行）、`src/ports.rs`（tangle） | 241 标签/会话窗口/陈旧判定纯函数 + 内联单测；新端口 |
| collector | `calendar.rs` | WeekdayCalendar → **HolidayCalendar**（RwLock 快照 + refresh；空快照 fail-open=仅工作日，与 Wave 0/1 行为一致）；TradingCalendar **trait 未动**（预批准范围内） |
| collector | `scheduler.rs` | `fetch_limit(now, trading_day)` 日历驱动 |
| collector | `gapfill.rs` | GapBackfiller 注入 TradingCalendar；非交易日零缺口零抓取；GAP_LIMIT 240→244（241+3） |
| collector | `service.rs` | 节假日刷新任务（启动即刷 + 1h 节拍，失败保留旧快照）；calendar 共享实例 |
| collector | `executor.rs` | §3.1 陈旧检测：会话时段 `is_stale` 命中 → stale_data 事件 + 进熔断计数 + 链上转移、不写陈旧 bar |
| storage | `reader.rs` | **D3**：SYMBOLS_LATEST_SQL 重写（双侧索引回溯 top-2 合并，替代 kline_merged 视图扫描）；+QualityRead/TushareStatusRead（KlineReader）、HealthEventsRangeRead（HealthEventReader）、HolidaysReader |
| diagnose | `src/quality.rs`（新）、`lib.rs` | QualityService（端口注入，无 sqlx）：divergence/source_accuracy/gaps/tushare_status/daily_quality + 纯函数 summarize/accuracy_by_source/classify_gap_minute/segments_of |
| web | `rest.rs/dto.rs/state.rs/lib.rs/spa.rs` | 4 端点 handler + 校验纯函数 + **D6**：/api/* 未命中 404 JSON |
| mcp | `tools.rs/state.rs/mocks.rs` | 工具④ get_data_quality(code, date) |
| app | `bin/eestock-app.rs`、`bin/eestock-data.rs` | DI 装配（quality 服务 web/mcp 共享 Clone；数据面日历） |
| tests（新/改） | collector 4 项、diagnose 2 项（lib 内联 + tests/quality.rs）、storage kline_reader +4、web api_quality.rs（新）+ dto 单测 + api_rest D6 断言、mcp 3 项 | 见 §6 |

## 2. 架构对齐

- **calendar 口径替换在预批准范围内**：`TradingCalendar` trait 签名零改动；仅实现替换 + collector 内部装配变化。分钟标签纯函数上移 `domain::calendar`（纯加法新模块）——collector 与 diagnose 需要同一口径而 diagnose 不得依赖 collector（05 §3），domain 是唯一合法共享层；contracts.md 注明。
- **domain 端口全部纯加法**（Wave 1 既有模式）：新 trait 四枚，既有 trait 零改动（HealthEventsRead 未动——区间读另立 HealthEventsRangeRead）。
- **diagnose 不依赖 sqlx / web、mcp 不依赖 storage**（分层红线复验：`cargo tree -p web -e normal` / `-p diagnose` / `-p mcp` 均无 storage/sqlx，实测 0 命中）。
- **数据面改动 = 仅日历口径 + executor 陈旧检测**（任务书明确范围）；providers 零改动。
- ADR-017：质量/tushare 状态全部只读库查询；无数据面直连。

## 3. backlog 清零证据（逐项）

### D3（慢查询，/api/symbols + WS quote 节拍）— 结案
⚠️ 口径修正：任务书/wave-2 写「/api/sources/health」，tester/report/006 D3 实证慢查询是
`symbols_with_latest`（/api/symbols 15–20s 并拖垮 WS quote poller）；health 窗口聚合实测 0.4ms 无问题。
- **Before**（现网库 EXPLAIN ANALYZE）：旧 SQL（LATERAL over kline_merged）`Execution Time: 19850.412 ms`（与验收实测 15–20s 吻合；JIT 4150 函数、ChunkAppend 逐符号扫视图）。
- **After**：同库同机 `Execution Time: 13.524 ms`（Planning 446ms）；新二进制实盘 `GET /api/symbols` 0.52s（冷）→ 0.12s/0.018s（热）。**提速 ~40–150×**。
- **语义等价**：现网 44 标的新旧查询 EXCEPT 互减 = **0 行**；新增测试 `symbols_latest_d3_merge_tail_semantics` 锁定 merge 尾部语义（准确层更新 ts 优先 + 同 ts 并列准确层掩盖 raw）。
- 连带：WS quote poller 每 3s 调用同一函数，节拍不再被拖垮（D3 衍生问题解决）。

### D4（amount 量纲）— 结案（查证推翻原假设）
- **查证（实盘 SQL）**：`kline_accurate.amount` = 元（amount ≈ close×volume，sanity=1.000 全样本成立；parse.rs 直取 tushare stk_mins 无需换算）；sina_jsonp raw 行同为元（比值 1.0）；**tencent_ifzq raw 行 amount 不可信**：raw/accurate 比值随标的不恒定（588000≈1/885、518880≈1/1044、159337≈1/4.9；golden 样本 518880@15:00 field7=2.917 对实际 30.44M 元同签名）——非固定量纲比，**无法视图层换算**（「raw 元 vs accurate 千元」假设不成立：accurate 本就是元）。
- **处置**：文档锁定（schema.md §4.4 注记 7 + 决策日志）：两表规范口径均为元；质量对照**只比 close**；tencent amount 当日泄漏（含 cagg 低估）记已知缺陷，providers 红线本轮不改，留数据面专项工单。

### D5（事件空窗）— 结案
- 口径对齐 03 §9.9 静默跳过注记：非交易时段零事件是既定行为，不是异常。落地 = 质量缺口报告三级分类：交易日历排除非交易日（周末∪holidays）后，缺口分钟按邻近事件证据分 `source_fault`（失败/陈旧/熔断张开事件）/ `upstream_no_data`（na 或仅成功事件）/ `system_gap`（邻近零事件 = 采集停摆/事件空窗）。测试：classify 矩阵 14 例 + 服务端到端（diagnose/tests/quality.rs、web api_quality.rs）+ 实盘 09-02 缺口正确归类 system_gap（当日上午采集未运行）。

### 13:00 标签伪缺口 — 结案（查真实数据定口径）
- **实证**：kline_raw 与 kline_accurate 双侧均无 13:00 标签、均有 11:30 与 15:00 标签；准确层 518880 每日 241 行；上游标签集合 = 09:30..=11:30 ∪ 13:01..=15:00（241）。旧 240「bar 起始时刻」口径每日每标的恒缺 13:00。
- **处置**：domain::calendar 241 标签口径（采集会话窗口 09:30..=11:31 ∪ 13:00..=15:01 覆盖标签可得性滞后）；scheduler/gapfill/质量报告同口径。实盘验证：09-03（全天 241 行）缺口报告零出卡。

### 粘源陈旧检测 — 结案
- 03 §3.1 新规格 + executor 实现 + ErrKind::StaleData 契约加法。测试：陈旧→转移备源+事件+连续 3 次熔断、午休边缘不误判（13:01:30 宽限内 / 13:02:30 判陈旧）、陈旧 bar 不落库。

## 4. 交易日历（任务书项 1）
- 0008 holidays 表 + 2026 数据 34 行（**已落库 :5433**，min 2026-01-01 / max 2026-10-08）。
- HolidayCalendar 刷新任务（启动 + 1h；失败 fail-open 仅工作日口径，不扩大停采面）。
- 测试覆盖任务书三点：周末 / 国庆（10-01..08 盘中时刻也不采集）/ 元旦（calendar_test、gapfill 节假日整轮跳过零调用、diagnose/web/mcp 节假日排除多层）。

## 5. QualityService + REST + MCP④（任务书项 2/4）
- 端点（04-quality.md §7）：`GET /api/quality/divergence|source-accuracy|gaps`、`GET /api/tushare/status`（quota_remaining 恒 null——积分未入库，文档注明）。
- 阈值口径：**默认 0.5%**（页面④ QUALITY_DEFAULTS.consistencyThresholdPct 定稿），`threshold_pct` 查询参数可调。⚠️ 任务书正文写 0.3%，以页面定稿文档为准（页面 L3 骨架常量 0.5 且前端已定稿）——如需 0.3 改前端常量+文档即可，后端参数已支持。
- MCP④ get_data_quality(code, date)：trading_day + gap 卡 + 分歧汇总（与 REST 同服务同口径）。
- **⚠️ 暂缓待裁决**：`POST /api/tushare/sync`（手动触发）——需新增 DB 控制通道表 + **数据面 tushare 同步任务消费端**（数据面改动超出本轮预批准「仅日历口径替换」范围）。已在 §1.4/04-quality.md §7 标注，前端同步按钮本期置灰。已上报父级（intercom）。

## 6. 验证（verification）

| 门禁 | 结果 |
|---|---|
| `./scripts/check-tangle.sh` | ✅ tangle 后无 diff（staging 后复核） |
| `cargo test --workspace` | ✅ **194 passed / 0 failed**（含本批新增 ~30 项） |
| `cargo clippy --workspace --all-targets` | 本范围 0 警告；残留 4 条全部属告警 worker 文件（crates/alert/tests/engine.rs sort_by_key ×1、crates/web/src/alerts.rs result_large_err ×3）——已 intercom 通知对方 |
| 分层红线 | `cargo tree -p web/-p diagnose/-p mcp -e normal` 无 storage/sqlx（0/0/0） |
| 实盘冒烟（新二进制直连 :5433） | /api/symbols 0.52s→0.12s（D3）；divergence 518880@09-03 = 241 对照 / 2 分歧（max 0.735%，首位 exchange_approx 近似 bar——符合降级语义）；gaps 518880@09-02 = 174 缺 2 段全 system_gap（当日采集未运行，正确）、09-03/09-04 零缺口不出卡；tushare/status 44 标的 + 最近事件 ok；/api/nope → 404（D6） |

## 7. 建议 commit 切分（git commit 与我无关，仅供父级参考）

同树并行（告警 worker 未暂存改动与我共享 4 个文件：contracts.md / 00-web-api.md / 03-raw-writer.md / schema.md + 其独有文件），路径级可分、共享文件需 `git add -p` 按 hunk 分：

1. **feat(calendar)**: schema.md（§4.3.2+注记6）、migrations/0008_holidays.sql、contracts.md（§2.8 + ErrKind hunk）、domain calendar/lib、03-collector 两文档 + collector src/tests、02-data-plane/eestock-data.rs、03-raw-writer.md（holidays 行 hunk）
2. **feat(quality+mcp④+D3-D6)**: contracts.md（Phase A 端口 hunk）、storage reader.rs + kline_reader 测试、diagnose quality、web 五源文件 + api_quality.rs、app 两 bin、00-web-api.md、01-mcp.md + crates/mcp、05-diagnose、06-web/04-quality.md、99-decisions-log.md
3. **feat(alerts)**: 告警 worker 范围（crates/alert、web alerts 前后端、02-alerts.md、0009、共享文件 Phase B hunks）

（实测顺序建议 1→2→3：0008 先于依赖它的日历代码语义上成立；2 与 1 同批亦可——domain 端口同文件。）

## 8. 残余风险 / 遗留

- **POST /api/tushare/sync 暂缓**（待父级裁决数据面消费端）——页面④ sync-panel 手动触发按钮本期不可用。
- tencent_ifzq amount 缺陷未修（providers 红线）——当日 raw/cagg amount 低估为已知泄漏，merge 视图对已同步日掩盖。
- tushare 日增量「最近已收盘工作日」回退仍是纯工作日口径（daily.rs）——节假日目标日会拉到空数据且 checkpoint 语义安全（无该日数据可落），未改（超预批准范围，影响≈零）。
- 告警 worker 的 4 条 clippy 警告待其修复后门禁全绿。
- 我改了 02-alerts.md 中 api_alerts.rs 的 state() 装配（+quality 字段，编译必需）——已通知对方勿覆盖。
