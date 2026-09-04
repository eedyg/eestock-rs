# Wave 2 Phase C — 页面④数据质量前端 + 联调收尾（coder 变更报告）

> 本报告位置：`eestock-rs/coder/report/013_wave2_phaseC.md`
> 全程 TDD（先写失败测试再实现）；骨架 QualityGrid.tsx 零手改（RegionPortal 组合）；只 stage 未 commit。

## 1. 变更总览（what changed）

| 层 | 文件 | 变更 |
|---|---|---|
| api 契约 | `web/src/api/types.ts` | +页面④线格式类型 8 枚（QualityDivergenceResponse/SourceAccuracyResponse/QualityGapsResponse/TushareStatusResponse 等，snake_case 透传不驼峰转换），逐字段对齐 Phase A 实际端点（crates/web/src/rest.rs 实测核对） |
| api client | `web/src/api/client.ts` | +4 方法：getQualityDivergence / getSourceAccuracy / getQualityGaps / getTushareStatus；`qualityParams` 序列化（thresholdPct→threshold_pct，缺省不带由后端兜底 0.5） |
| api mock | `web/src/api/mock.ts` | +4 方法确定性实现（mockDivergenceRows |偏差|降序、两 1m 源交替归属、gaps 固定样例与 preview/04-quality.html 同构、tushare quota 恒 null） |
| 页面④ | `web/src/features/quality/`（8 新文件） | store.ts（四区独立三态状态机）+ format.ts（CST 时刻/偏差/比率纯函数）+ QualityFilterBar / DivergenceTable（+RegionError 共用）/ OverlayChart（双线同尺度 SVG + 最大偏差中心缩放）/ AccuracyCards / SyncPanel / GapReportList + QualityPage（骨架+RegionPortal 装配） |
| shell | `web/src/shell/navItems.ts` | ④ 数据质量解锁（去 W2 置灰标） |
| 路由 | `web/src/App.tsx` | +`/quality` 路由 |
| 部署 | `design/07-app-plane/00-web-api.md` §6 + `Dockerfile.app`（tangle） | **联调发现的生产缺陷修复**：frontend 阶段 `VITE_API_MOCK=0 npm run build`（见 §5） |

## 2. 架构对齐

- **骨架纪律**：`layouts/QualityGrid.tsx`（tangle 生成）零改动；业务组件全部经 `RegionPortal` 挂入 data-region 锚点（09-frontend.md §3 既定模式，同 AlertsPage）。
- **Props 契约遵循骨架**：QualityPage 将 store 状态接入 QualityGridProps（code/range/view/onFilterChange/onViewChange/onJumpToKline/onTriggerSync/syncRunning）；`QUALITY_DEFAULTS.consistencyThresholdPct=0.5` 口径复用，缺省不传 threshold_pct 由后端兜底同值。
- **页面纪律（04-quality §6 / ADR-003）**：纯只读 + 同步触发；手动同步按钮按 wave-2.md 边界（父级裁决 2026-09-04）**置灰 + tooltip「下阶段开放」**，`onTriggerSync` 回调不接线（骨架 prop 以 noop 填充），前端未实现任何 POST /api/tushare/sync 调用。
- **D4 口径**：分歧对照只比 close；偏差% = (raw−accurate)/accurate×100，阈值着色 |dev|>threshold → 红（分歧）否则绿（一致）。
- **源中文标签**：复用 `features/sources/sourceMeta.ts` metaOf（tencent_ifzq→腾讯ifzq 等）；实盘出现的 `*_approx` 源走既有未知源兜底（label=id），无双事实源。
- **无新增依赖**：全部依赖在既有 package.json 内。

## 3. 契约核对（对齐 Phase A 实际端点）

以 `crates/web/src/rest.rs` + `crates/diagnose/src/quality.rs` 实际 serde 输出为事实源逐字段核对：
- divergence：`{code,from,to,threshold_pct,summary{compared_bars,divergent_bars,divergence_rate,consistency_rate,max_deviation_pct},rows[{ts,raw_close,accurate_close,deviation_pct,raw_source}]}`，rows |偏差|降序、无比对样本 summary 比率/极值 null ✅
- source-accuracy：`{from,to,threshold_pct,sources[{source,samples,consistency_rate,avg_deviation_pct,max_deviation_pct}]}`，**不带 code 参数**（窗口全源口径）✅
- gaps：`{code,from,to,days[{date,expected_bars,actual_bars,missing_bars,segments[{start,end,count,class}]}]}`，start/end 为 CST "HH:MM"（web 层 hhmm 转换）、class ∈ source_fault/upstream_no_data/system_gap ✅
- tushare/status：`{checkpoints[{code,period,last_synced_date,updated_at}],covered_codes,last_updated_at,last_event{ts,ok,err_kind}|null,quota_remaining:null}`（quota 恒 null → 前端渲染 —）✅
- 实盘冒烟：四端点 HTTP 200，载荷形状与上述一致（见 §6）。

## 4. TDD 记录

1. **Red**（api）：client.test.ts +4 用例 / mock.test.ts +1 用例 → 5 失败（方法不存在）。
2. **Green**（api）：types/client/mock 实现 → 30/30 绿。
3. **Red**（页面④）：store.test.ts 6 用例 + QualityPage.test.tsx 6 用例 → 模块不存在失败。
4. **Green**（页面④）：store + 6 组件 + QualityPage + nav/route 接线；NavBar.test 同步更新解锁口径（④ W2 解锁后 W2 标签归零）。
5. **Refactor**：OverlayChart 双线共用 y 轴（初版逐序列缩放会使双线失真，测试保护下修正）；三处测试断言按实际渲染收紧（汇总行 testid、从未同步正则、腾讯ifzq getAll）。

## 5. 联调发现与修复（重要）

**缺陷**：部署镜像内 `npm run build` 未设 `VITE_API_MOCK=0`，`api/index.ts` 默认 mock（09-frontend §4「默认开发态 mock 开启」）导致**生产 SPA 静默渲染 mock 数据**——重建后首次无头验证页面④显示 24 条 mock 行/覆盖 3 只（mock 值），与真库 336 行/44 只不符。
**修复**（设计优先，文学式纪律）：改 `design/07-app-plane/00-web-api.md` §6 文档行 + Dockerfile.app 代码块（frontend 阶段 `RUN VITE_API_MOCK=0 npm run build`），`entangled tangle` 再生成，check-tangle 绿。修复后无头渲染为真实数据（§6 对账）。
**性质说明**：Dockerfile.app 非 crates 后端逻辑，红线未触；crates/ 零改动。

**环境注记**：本机 docker-compose 1.29.2 + Docker 29.1.3 存在已知不兼容（`KeyError: 'ContainerConfig'`，Docker 29 已移除 image inspect 废弃字段，compose recreate 路径必炸）。绕过方式：`docker rm <旧容器>` 后 `up -d` 走全新创建路径（仅触碰 eestock 自身容器）。后续部署窗口建议升级 compose v2。

## 6. 部署验证证据（2026-09-04 14:05-14:15 CST，交易时段）

| 验证项 | 命令/方式 | 结果 |
|---|---|---|
| 镜像重建 | `docker-compose build app data`（logs/phaseC_build.log；修复后 build app：phaseC_build2.log） | ✅ exit 0 |
| 容器健康 | `docker-compose ps` | ✅ eestock-app / eestock-data / timescaledb 全 Up (healthy) |
| divergence | `curl :8081/api/quality/divergence?code=518880&from=2026-09-03&to=2026-09-04` | ✅ 200，真实行（exchange_approx/ths_cs_approx/tencent_ifzq 源，|偏差|降序） |
| source-accuracy | `curl :8081/api/quality/source-accuracy?from=2026-09-03&to=2026-09-04` | ✅ 200，5 源一致率降序 |
| gaps | `curl :8081/api/quality/gaps?code=513310&from=2026-09-01&to=2026-09-04` | ✅ 200，真实缺口日（09-01 缺 241 bar，segments HH:MM+class） |
| tushare/status | `curl :8081/api/tushare/status` | ✅ 200，checkpoints 44 只、last_synced_date 2026-09-03、quota_remaining null |
| D6 回归 | `curl :8081/api/nope` | ✅ 404 `{"error":"not found"}`（SPA 回退不过宽） |
| 页面④无头渲染 | `chromium --headless --dump-dom :8081/quality`（修复后 /tmp/quality_dom2.html，155KB） | ✅ 真实数据：汇总「比对 336 bar / 一致率 100.0%」；sync-panel「覆盖 44 只 · 最近事件 成功」；gap-report 真实缺口段；accuracy-cards 多源卡 |
| 页面对账 | DOM 行 `09-03 09:30 / 1.778 / 1.780 / −0.11%` vs API `2026-09-03T01:30:00Z raw 1.778 accurate 1.78 dev -0.11`（159337） | ✅ 逐值一致（CST 时刻换算正确） |
| 数据面采集 | `docker logs eestock-data --since 3m` | ✅ 交易时段 132 条 fetch ok，gap backfill 运转，无 error/panic |
| alert evaluator | `docker logs eestock-app` 全量 + `/api/alerts?limit=5` | ✅ 启动（06:05:11Z）后 06:09:12Z 产出新告警事件（source_success_rate/sina_jsonp），与 1min 节拍吻合；全日志 0 条 "tick failed"（评估器静默打拍为既定设计，仅失败时 warn） |

门禁三件套 + 前端：
- `web: npx vitest run` ✅ 21 文件 168/168
- `web: npm run build`（tsc -b && vite build）✅ 成功
- `./scripts/check-tangle.sh` ✅ Nothing to be done，无 diff（stage 后复验）

## 7. 测试覆盖（新增/更新）

- `web/src/api/client.test.ts` +4：四端点 URL/参数序列化/响应透传/threshold_pct 可选
- `web/src/api/mock.test.ts` +1：页面④ mock 契约形状（降序、确定性、quota null、segment 形状）
- `web/src/features/quality/store.test.ts`（新）6：init 默认首标的+默认范围三端点、标的/日期变更即重查、视图切换不重查、错误隔离+retry、无标的不发请求
- `web/src/features/quality/QualityPage.test.tsx`（新）6：五区齐备（分歧表降序+汇总行/一致率卡/置灰按钮+tooltip/缺口段/filter-bar）、空态×4、错误+重试、视图切换叠加图双线、点行跳 /?code=&ts=、标的切换重查
- `web/src/shell/NavBar.test.tsx` 更新：④ 解锁，W2 标签归零

## 8. 残余风险

1. **点行跳转落地页①尚不消费 query 参数**：onJumpToKline 导航至 `/?code=&ts=`，DashboardPage 当前不读 searchParams（落到默认视图）。需页面①加深链支持，建议后续 Phase 单开工单（涉页面①地盘，本波红线内未动）。
2. **docker-compose v1 与 Docker 29 不兼容**（§5）：recreate 路径需先 `docker rm` 旧容器绕过；建议部署窗口升级 compose v2。
3. **`*_approx` 源无中文名**：实盘 divergence/gaps 出现 exchange_approx/ths_cs_approx 等源 id，前端按既有兜底显示原 id（sourceMeta 未知源约定）；如需中文标签属 sourceMeta 加法，不影响功能。
4. **overlay 缩放为按钮式（放大 ×2/重置，以最大偏差点为中心窗口化）**，非拖拽框选；满足 L2「偏小区间肉眼分辨」意图的最低实现，增强留后续。
5. 页面②告警预览遗留 mock 样例（012 报告 §9-4 已记，features/sources 地盘未动）。
