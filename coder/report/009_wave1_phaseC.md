# 009 — Wave 1 Phase C：页面②数据源诊断 + ③标的管理（前后端一体）

> 报告位置：`coder/report/009_wave1_phaseC.md`（本文件）
> 任务：补 Phase A 后端缺口（symbols 写端点 + 熔断手动复位 DB 控制通道）+ 前端页面②③ + 导航解锁②③。
> 依据：design/06-web/02-sources.md、03-symbols.md（定稿）、preview/02·03（视觉基线）、
> design/07-app-plane/00-web-api.md（Phase A 模式）、09-frontend.md、ADR-017（DB 唯一耦合点）。
> 断点续跑：首轮完成后端全绿 + 前端 api/ws/shell/sources-store；本轮（磁盘故障恢复后）补齐
> rate-limits 端点、页面②③组件、路由、全量验证与 stage。

## What changed（62 文件已 git add，未 commit）

### 设计事实源（先改 design 再 tangle，ADR-007）

- `design/07-app-plane/00-web-api.md`：§1.1 契约表 +4 端点行（POST/PATCH /api/symbols、
  with_stats、POST /api/sources/{id}/reset）；§1.4 边界更新（Phase C 已交付清单 + 无 DELETE 定稿）；
  §3 reader.rs 加 `SymbolStatsRead` 实现；§4 web lib/dto/state/rest 块扩展；两既有测试装配块补字段；
  eestock-app 装配块补 DI；**新增 §8 Phase C 专节**（决策注记 + admin.rs + 两个集成测试块 + TDD 要点）。
- `design/02-domain/contracts.md`（纯加法）：`SourceId::parse`（as_str 逆映射）；
  端口 `SymbolAdminWrite` / `SymbolStatsRead` / `CircuitResetWrite` / `CircuitResetChannel`
  + 读模型 `SymbolStatView` / `ResetRequest` + 输入模型 `SymbolAdminInput` / `SymbolPatch`；契约测试追加。
- `design/04-storage/schema.md`：新增 §4.3.1 + `migrations/0007_circuit_reset.sql`（DDL 变更按本文档递增编号既定口径）。
- `design/04-storage/02-tushare-sync.md`：storage lib.rs `pub mod admin;` 声明（Phase A reader 同模式）。
- `design/04-storage/03-raw-writer.md`：migrate_check 自检关系 +`circuit_reset_requests`（0001-0007 口径）。
- `design/03-collector/00-design.md`：新增 §10 熔断复位 DB 控制通道消费端（reset.rs + reset_test.rs 块）；lib.rs 声明。
- `design/03-collector/02-data-plane.md`：eestock-data 装配 ResetWatcher spawn（加法 5 行，同 tushare daily 模式）。

### 后端（tangle 生成物）

- **symbols 写端点**：`POST /api/symbols`（201/409/422/400）、`PATCH /api/symbols/{code}`（200/404/400）。
  校验（web/dto.rs 纯函数）：code 6 位数字 + 市场前缀（复用 domain `Code::market`，北交所 4/8/920→422
  「暂不支持」）、interval_secs≥60、settlement∈{T0,T1}——全部与 schema CHECK 同口径双保险。
  **写 symbols 表即控制通道**：数据面 Scheduler 每周期重读热生效（03-collector §2 既有机制，零直连）。
- **GET /api/symbols?with_stats=1**：追加 `today_bars`（当日 Asia/Shanghai 日界 kline_raw 行数）；
  不带参数时键不出现（Phase A 契约零回归，集成测试锁定）。
- **熔断手动复位**：`POST /api/sources/{id}/reset` → 202 异步——写 `circuit_reset_requests`（0007），
  数据面 `collector::reset::ResetWatcher`（5s 轮询，`UPDATE...RETURNING` 原子消费）→
  `CircuitRegistry::manual_reset`（既有方法，事件由数据面单写者发出）→ diagnose 聚合呈闭合 → WS 推送。
  未知 source id 应用面照收（202），数据面消费端跳过并 warn。

### ⚠️ 数据面加法标注（任务书要求）

全部为**纯加法扩展**，未改数据面任何既有逻辑行：
1. `crates/collector/src/reset.rs`（新文件，ResetWatcher）+ `tests/reset_test.rs`；
2. eestock-data.rs **插入 5 行**（构造 + spawn，未触碰既有装配行）；circuit.rs / service.rs /
   scheduler.rs / executor.rs 等一行未动（git diff 可证）；
3. `circuit_reset_requests` 新表（0007 迁移，普通表非 hypertable）；
4. migrate_check 自检数组 +1 项（storage 基础设施，两平面共用）；
5. domain 端口/方法全部追加于既有块尾部，未改既有签名。
`source_health_events` 写路径保持数据面单写者（应用面不写事件表，复位事件由消费端发出）。

### 前端（手写例外区，09-frontend.md 模式）

- **契约对齐**（Phase B 遗留 residual ①②收口）：HTTP client 对齐真实后端线格式——
  getKline 解 `{bars,next_before}` 包络、getSymbols 将 SymbolDto latest 展开为骨架 SymbolSnapshot、
  getSourcesHealth 用 snake_case 健康行；WS topic 别名适配（前端 `source_health` ↔ 后端 `health`，07 §1.4 既定）。
- **页面②数据源诊断**：SourcesGrid 骨架零改动 + RegionPortal 组合。汇总条（1m 可用/总数·快照池·
  系统灯——任一 1m 熔断🟡/全部🔴）、源健康卡片墙（状态灯/角色标签/近 1h 成功率/P50/最近错误/熔断卡
  附手动复位按钮，复位 stopPropagation 不触发展开）、点卡展开 detail-panel（成功率 SVG 时序 +
  范围 1h/今日/3日 + 分歧率行 + 限流计数器组 403/429/连接重置 + 事件流水 50 条 Trace ID 点击复制）、
  缺口卡（>5% 黄 >20% 红，SOURCES_DEFAULTS）、告警预览。WS health 推送→重拉→状态迁移卡闪烁（flashes）。
  全部区域三态齐备（骨架/空占位/错误条+重试）。
- **页面③标的管理**：SymbolsGrid 骨架零改动。工具条（注册入口+计数）、表格（code/名称/间隔/启停
  开关/今日 bar/最新时刻 UTC→CST/操作，停用行置灰）、注册/编辑共用模态（**遮罩点击不关闭**、
  code 编辑态只读、校验内联、**settlement 变更二次确认**⚠️ 回测撮合、提交中禁用+spinner、
  服务端 409/422 错误横幅）、启停切换（停用需确认，仅停用无物理删除）。
- **导航解锁②③**：navItems 启用 + App.tsx 路由 `/sources` `/symbols`（NavBar 测试同步更新）。

## Architecture alignment

- 分层红线保持：`cargo tree -p web -e normal` 无 storage/sqlx、`-p diagnose` 无 sqlx（实测输出为空）；
  web 只见 domain 端口，storage/sqlx 仅 dev-dependencies（测试装配）。
- 新端点全部走 domain 端口注入（Phase A 模式）：`SymbolAdminWrite`/`SymbolStatsRead`/`CircuitResetWrite`
  应用面侧，`CircuitResetChannel` 数据面侧；storage 实现，app bin 装配。
- ADR-017：应用面影响数据面仅经 DB（symbols 表 / circuit_reset_requests 表），无任何直连；
  事件表单写者原则保持。
- 骨架纪律：两页面 layouts/*Grid.tsx 零改动（tangle 生成物）；默认值取 SOURCES_DEFAULTS / SYMBOLS_DEFAULTS。
- 零新增依赖：前端时序图用轻量 SVG（依赖基线无 echarts，未引新库——09-frontend §2 表外依赖需父级审批，故不引）。

## 定稿冲突裁决记录（均按更高层约束/定稿文档执行，非阻塞歧义）

1. **DELETE /api/symbols 不实现**：任务书文字提及 DELETE，但 03-symbols §4 定稿「仅停用、
   UI 无物理删除入口、物理删除仅限 DBA 手工 SQL」→ 从定稿，§1.4 落稿。停用=PATCH {enabled:false}。
2. **名称不做服务端行情源反查**：03-symbols L2「注册时服务端反查名称」依赖行情源，与 ADR-017
   （应用面无数据面/外网直连）冲突 → 按 ADR-017 + 设计既定降级路径「失败留空可手工改」执行：
   name 由请求体携带或留空后续 PATCH；§8.1 落稿。
3. **settlement 分类预填**：前端无分类数据源（需行情源），默认 T1 + 人工确认可改（表单提示保留）。
4. **汇总条运行时长**：后端无该字段（07 §1.1），省略；采集在线状态由
   「任一源 10min 内有健康事件」客户端推导（sourceMeta.collectorRunningOf，TopBar 采集灯同源）。

## Test coverage

### 后端（cargo test --workspace：116 passed / 0 failed）

- domain：`source_id_parse_roundtrip_and_unknown`（全 13 变体往返 + 未知 None）。
- storage `symbol_admin.rs`（3 例，真实库 :5433）：注册/重复 false/COALESCE 编辑/未知 code/
  schema CHECK 双保险（interval<60、T2 库层仍拒）；today_stats 当日窗口；reset 通道原子消费不重复。
  （首轮实锤踩坑：同 binary 并行测试共享 clean 互删 → 每测试独立 clean，与 kline_reader 既定注记一致。）
- collector `reset_test.rs`（2 例，内存 channel + fake clock）：消费→manual_reset（Healthy+事件）/
  未知源跳过/空队列 noop。
- web `api_admin.rs`（2 例，真实 server+库）：注册 201+缺省值、409/422/400 矩阵、PATCH 回读 404、
  停用、with_stats 出/不出键、reset 202 + DB 行待消费 + 未知源 202。
- web dto 单测（4 例）：code/interval/settlement/name 校验与注册缺省反序列化。
- 既有 Phase A 测试全部保持绿（api_rest/ws_poller 装配块仅补新字段）。

### 前端（vitest：17 文件 130 例全绿）

- api：`client.test.ts`（真实线格式对齐 + 6 新方法 URL/body/错误透传）、`mock.test.ts`（健康行三态、
  标的管理闭环 409/422/404、页面②补充数据源形状）。
- ws：topic 别名双向映射 3 例（出站 health/入站分发/退订）。
- sources：`store.test.ts` 8 例（三路加载/错误重试/点卡详情/范围切换不重查 events/WS 刷新 flashes/
  复位往返/dispose 免疫）；`SourcesPage.test.tsx` 10 例（锚点齐备/汇总条计数/卡片与复位按钮/
  展开折叠/复位不展开/WS 实时刷新/缺口红黄/错误重试/空态/Trace 复制）。
- symbols：`validate.test.ts` 5 例、`store.test.ts` 8 例（含二次确认拦截、停用确认、启用免确认）、
  `SymbolsPage.test.tsx` 8 例（表格渲染/空态/错误重试/**遮罩点击不关闭**/注册闭环/北交所内联/
  编辑只读+二次确认/启停/提交中禁用）。
- shell：NavBar/AppShell 测试随解锁与新健康契约更新；dashboard 两 fake 迁移至共享 stubApi（新文件 `test/apiStub.ts`）。

## Verification

```
entangled tangle            → Nothing to be done；./scripts/check-tangle.sh ✅（stage 后无 diff）
cargo test --workspace      → 116 passed / 0 failed（47 个 test binary 全 ok）
cargo clippy --workspace --all-targets → 0 warning
cargo tree -p web -e normal → 无 storage/sqlx；-p diagnose 无 sqlx
npx vitest run              → Test Files 17 passed / Tests 130 passed
npm run build               → tsc -b && vite build ✓（dist js 484.88 kB / gzip 142.5 kB）
psql -f migrations/0007_circuit_reset.sql（本地 :5433）→ CREATE TABLE / CREATE INDEX
```

## 建议 commit 切分

1. `feat(domain+storage+collector): Phase C 控制通道端口 + admin/reset 加法扩展 + 0007 迁移`
   （contracts.md / schema.md / 02-tushare-sync.md / 03-raw-writer.md / 03-collector 两篇 +
   domain·storage·collector 生成物 + migrations/0007）
2. `feat(web+app): symbols 写端点 + with_stats + 熔断复位 REST（Phase C §8）`
   （00-web-api.md + crates/web + eestock-app/eestock-data 装配）
3. `feat(frontend): 契约对齐真实后端（kline 包络/symbols latest/health 行/WS health 别名）`
   （api/* + ws/* + shell/* + dashboard fake 迁移 + test/apiStub）
4. `feat(frontend): 页面②数据源诊断 + ③标的管理 + 导航解锁②③`
   （features/sources、features/symbols、App.tsx、navItems）

## Residual risks / 待后续对齐

1. **页面② detail-panel / gap-cards / alert-preview 的后端端点未实现**（metrics/events/divergence/
   rate-limits/gaps/alerts）——本任务后端范围仅 symbols 写 + reset（07 §1.4 边界内，Phase C 后续/Wave 2）。
   前端契约已定（client+mock 完整），真实模式这些区域走错误三态+重试；mock 模式完整可览。
2. **复位为异步语义**（≤5s 数据面消费）：UI 点击后健康态在消费+下次 WS 推送后翻转，
   与 L2「立即摘除」存在秒级窗口（ADR-017 DB 通道的固有代价，§8.1 落稿）。
3. **名称反查缺失**（ADR-017 裁决，见上）：注册后 name 为空时表格显示 —，需手工编辑补录。
4. **部署注意**：0007 迁移需在既有库手工执行（compose initdb 只对空卷生效）；本机 :5433 已执行。
   新部署空卷自动包含。
5. 角色/中文名静态映射（sourceMeta）需随新源接入手工更新；未知源安全兜底（label=id、不计 1m 统计）。
6. 采集运行状态为客户端推导（10min 事件近因），非数据面真实存活；真实存活仅数据面 /healthz 可知。
