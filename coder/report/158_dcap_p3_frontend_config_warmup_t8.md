# P3 报告 — dcap 前端副图 + 参数面板 + 配置 API + 取数 warmup + T8 渲染 spike

- **报告自身路径**：`coder/report/158_dcap_p3_frontend_config_warmup_t8.md`
- **执行时间**：2026-09-13 18:44 ~ 19:00 CST
- **仓库根（主树）**：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD = `3f5425c`，未 commit、**未 git add**）
- **权威口径**：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`（ADR-021）
- **本任务范围**：`02-spec.md` §6（图表契约 C）/ §7（配置面 D）/ §8 裁决 13/17/18/19；`03-test-plan.md` T8/T10/T11；`04-implementation-plan.md` P3
- **并行车道**：P4（`design/12-strategy-system/04-strategy-programming-guide.md`、`design/99-decisions-log.md`，其 report 为 `157_*`）、P5（`tester/**`）同时在主树工作；本报告与其无文件交叠（见 §7）

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 指标注册/副图（`dcapIndicator.ts`） | ✅ 名 `DCAP`、3 figure（s/m/l）、**独立副图 pane**（isStack=true，`paneId ≠ candle_pane`）、`precision: 5`、`calcParams=[n_s,n_m,n_l,r_s,r_m,r_l,smooth,m]`、calc 调生成物 `computeDcapSeries` |
| 异常降级 | ✅ 数据不足 → null 断线；**任何异常（含恶意 getter）→ 全 null 断线且不抛**（T8-2a/2b 机检 PASS） |
| Toolbar DCAP（默认关）+ 参数面板 | ✅ `DASHBOARD_DEFAULTS.indicators.dcap=false`（**生成物**，改文档后 tangle）；面板形态照 MA windows（内联 + 服务端读写） |
| 配置 API `GET/PUT /api/config/dcap` | ✅ 8 显示参数（不含 th）；落库 `ConfigStore`/`app_config` key=`dcap`（**无新迁移**）；非单调 n/越界/非整数 → **400**；GET 无键/坏 JSON/越界旧值 → 默认（**不 500**） |
| 取数 warmup | ✅ `limit = viewport_bars + (n_l + m − 1)`（`feed.warmupBars`，**开 DCAP 时生效**，多取不上图） |
| 前端自测 | ✅ `npx vitest run` **558 passed / 56 files**（基线 514 ≤ 现 558，**+44 新测试**）；`npx tsc -b` **exit=0** |
| Rust 自测 | ✅ `cargo test -p web --lib` **49 passed**（基线 45，+4）；`cargo check -p app -p web` OK；`api_settings/api_ma_config/api_rest` 集成测试全绿 |
| T8 渲染 spike | ✅ 10/10 断言 PASS（真实 klinecharts **10.0.3** + 真实产物），4 张截图 + JSON 取证 |
| T8-⑤ 性能 | ✅ 600 根 + `n_l=250` + `m=60`：**median 0.60ms / max 1.8ms**（预算 16ms，余量 ~26×） |
| tangle | ✅ 3 次 tangle 均**显式确认落盘**（mtime+内容），`./scripts/check-tangle.sh` **exit=0**（3 次） |
| 未达标项 | **无硬性未达标**；2 项带观察项（§8） |

**VERDICT：见文末。**

---

## 1. 改动文件清单（区分生成物/手写）

### 1.1 tangle 生成物（**只改文档块 → `entangled tangle` 落盘**）

| 生成物 | 来源文档块 | 改动 | 落盘确认（mtime/size/sha 变化） |
|---|---|---|---|
| `web/src/layouts/DashboardGrid.tsx` | `design/06-web/01-dashboard.md` L3 块（`file=web/src/layouts/DashboardGrid.tsx`） | `DASHBOARD_DEFAULTS.indicators` 加 `dcap: false` | 18:50:19，5205→**5218 B**（`9fda9247…`→`bdee1637…`），第 8 行实测 `indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: false }` |
| `crates/web/src/dto.rs` | `design/07-app-plane/00-web-api.md` dto.rs 块 | +`DcapConfigDto` + `Default` + `validate_dcap_config` + `dcap_config_or_default` + 4 单测 | 18:52:42（测试）/18:53:08（实现），33310→37330→**40374 B** |
| `crates/web/src/rest.rs` | 同文档 rest.rs 块 | +`K_DCAP` + `get_dcap_config` + `put_dcap_config` | 18:53:08，17609→**19302 B** |
| `crates/web/src/lib.rs` | 同文档 lib.rs 块 | +`/api/config/dcap` get/put 路由 | 18:53:08，7406→**7645 B** |

> 关键纪律（P0 教训）：每次 tangle 后**逐文件核对 mtime 与内容**（上表即实测），并跑门禁；`entangled tangle` 的 INFO 输出确认只写这 4 个文件（其它 144 个生成物逐字节未变）。

### 1.2 事实源文档（手改；非代码块部分）

| 文件 | 改动 |
|---|---|
| `design/06-web/01-dashboard.md`（+15/-2） | §2 图表：DCAP 加入可选指标清单 + 独立副图/precision 5/断线/参数面板/warmup 口径；§5 API 依赖表：加 `GET/PUT /api/config/dcap` 行 + kline 行补 warmup 说明 |
| `design/07-app-plane/00-web-api.md`（+169） | §1.1 契约表 +2 行（`GET/PUT /api/config/dcap`：body/200/落库/400 语义）；dto.rs 块 +（DTO/校验/GET 韧性/4 单测）；rest.rs 块 +（2 handler）；lib.rs 块 +（1 路由行） |

### 1.3 手写前端（新文件）

| 文件 | 行 | 说明 |
|---|---|---|
| `web/src/features/indicators/dcapIndicator.ts` | 161 | registerIndicator 注册层：模板（DCAP/precision 5/3 figure/8 calcParams）、`dcapCalcParams`/`dcapParamsFromCalcParams`/`dcapWarmupBars`/`validateDcapParams`、`ensureDcapIndicatorRegistered`（幂等 + 无 registerIndicator 时兜底跳过）、calc 异常降级 |
| `web/src/features/indicators/DcapParamsPanel.tsx` | 190 | Toolbar 内联参数面板（形态照 `MaConfigControl`）：8 输入 + smooth 选择 + 即时校验提示 + 保存/取消/错误态 |
| 测试（新）：`dcapIndicator.test.ts` 183 / `DcapParamsPanel.test.tsx` 116 / `dcapWarmupP3.test.ts` 77 / `dcapWiringP3.test.tsx` 305 | 681 | T8 前置单测 + warmup + 接线（详见 §5） |

### 1.4 手写前端（改动）

| 文件 | 改动 |
|---|---|
| `web/src/features/dashboard/KlineChart.tsx` | +`dcapParams` prop；`INDICATOR_DEFS` 加 DCAP；`syncIndicators(..., dcapParams)`：DCAP 走 `ensureDcapIndicatorRegistered()` + `createIndicator({name:'DCAP',calcParams}, true)`（**独立副图**） |
| `web/src/features/dashboard/Toolbar.tsx` | 指标列表加 `DCAP`；`dcapParams?`/`onSaveDcapParams?` props；由 `DcapParamsPanel` 承接 |
| `web/src/features/dashboard/DashboardPage.tsx` | +`dcapParams` 状态（默认 8/26/60/1/1/1/1/3）+ `readDcapParams`（**重试 3 次/指数退避**）+ focus/visibilitychange **重读** + `saveDcapParams`（乐观更新+失败回滚+rethrow）+ warmup 计算并注入 feed |
| `web/src/features/dashboard/feed.ts` | +`warmupBars` 依赖项 + `initialLimit` getter（`pageSize + warmupBars`，非法值归 0）；初始取数与 `hasMore` 用 `initialLimit` |
| `web/src/api/types.ts` | +`DcapConfigDto`（8 参，注释钉住范围/跨字段/GET 回退语义） |
| `web/src/api/client.ts` | +`getDcapConfig` / `saveDcapConfig`（`GET/PUT /api/config/dcap`） |
| `web/src/api/mock.ts` | +`DEFAULT_DCAP_CONFIG` + `assertDcapConfig`（与后端同构 400）+ 2 个 handler |
| `web/src/api/client.test.ts` / `mock.test.ts` | +2 / +2 测试（端点与 400 语义） |
| `web/src/features/dashboard/KlineChart.test.tsx` / `Toolbar.test.tsx` | 指标 map 补 `dcap: false`（**类型必需**：`IndicatorName = keyof DASHBOARD_DEFAULTS.indicators` 扩展后，`Record<IndicatorName,boolean>` 字面量缺键会 tsc 失败；断言未放宽） |

`git diff --stat` 合计：**19 tracked 文件，+786/−20**（不含 6 个新前端文件 842 行 + `coder/evidence/**`）。

### 1.5 明确未动（scope 边界）

`design/14-dcap-indicator/**`（口径冻结，**未重新 tangle**）、`/api/config/ma`（MA 三处零改动）、插件 ABI/`clamp_score`/`aggregate`/`classify`/60-40 阈值/`ExecutionPolicy`、`migrations/**`（**无新迁移**）、`GridCell.tsx`（宫格缩略图不画副图；与 §7「主图/宫格/工作台共用**同一套参数**」不冲突——共享的是配置 key，缩略图无副图）。

---

## 2. 架构对齐（分层归位）

| 改动 | 层 | 为什么在这一层 |
|---|---|---|
| `dcapIndicator.ts` / `DcapParamsPanel.tsx` | Presentation（前端 feature 模块，手写） | klinecharts 适配与 UI 只属表现层；**算法正文仍在 `dcap.ts` 生成物内**（CORE 单一事实源，未复制算法） |
| `Toolbar/KlineChart/DashboardPage/feed/api/*` | Presentation（前端，手写） | 指标开关/面板/取数 limit/配置读写都是表现层职责；未引入新依赖、未改任何跨层契约 |
| `dto.rs`（DTO + 校验 + GET 韧性纯函数） | Presentation（web crate 线格式层，**tangle 生成物**） | 与 MA 同构：线格式与值域校验属 web 边界（`ConfigStore` 只存 jsonb，不解释语义） |
| `rest.rs`（2 handler） | Presentation（web crate 路由层，**tangle 生成物**） | 形状比照 MA（`dto 校验 + rest 端点`），落库比照 kline（`ConfigStore`）——两句口径**分别**落实，未混用端口 |
| `lib.rs`（路由注册） | Presentation（装配层，**tangle 生成物**） | 端点装配唯一入口 |
| 文档（`01-dashboard.md` / `00-web-api.md`） | 事实源（design） | doc-first：改生成物必先改文档块再 tangle（ADR-007） |

**未越界**：没有新增端口/表/迁移；没有修改 domain/application 任何接口；没有改插件 ABI；`ConfigStore` 复用既有端口（ADR-020 先例）。

---

## 3. 解决的问题（需求 → 实现）

1. **dcap 上 K 线副图**（§6 图表契约 C）：`registerIndicator` 名 `DCAP`、3 figure（s/m/l）、**独立副图**（`createIndicator(..., true)`；模板不带 `paneId` ⇒ 不可能叠 `candle_pane`）、**显式 `precision: 5`**、`calcParams` 8 参、calc → `computeDcapSeries`；数据不足 `null` 断线（表现为线从 `n_i+m−1` 起），异常一律降级断线。
2. **Toolbar + 参数面板**（§7/裁决 17）：DCAP 加入指标列表且**默认关**（`DASHBOARD_DEFAULTS` 生成物 → 文档 + tangle）；参数面板形态照 MA windows（内联编辑 + 服务端读写）；8 参（`th` 不在列）。参数热切换会即时重刷指标 `calcParams`。
3. **配置 API**（§7/裁决 18）：`GET/PUT /api/config/dcap`；读走 `ConfigStore.get("dcap")` + `dcap_config_or_default`（无键/坏 JSON/越界旧值 → 默认，**不 500**）；写做单参数范围 + **跨字段 `n_s<n_m<n_l`** 严格校验 → 400；非整数由 serde 反序列化拒绝（400）。
4. **取数 warmup**（§6/裁决 19）：`feed.warmupBars` ⇒ 初始 `limit = viewport_bars + (n_l+m−1)`；视口仍由 `viewportBars` 决定 barSpace，多取部分天然不上图 —— **视口最左那根不再断线**。
5. **前端读取韧性**（ADR-020 教训）：`readDcapParams` 重试 3 次（500ms/1s 指数退避）+ `focus`/`visibilitychange` 重读，避免「重启回默认」假象。

---

## 4. 实现要点（架构内决策）

| 决策 | 依据 / 权衡 |
|---|---|
| **warmup 仅在 DCAP 开启时生效**（未开 = 0，`limit = viewport_bars`） | 未开 DCAP 时多取无用途；且无条件 warmup 会改变 ADR-020 既有取数口径（会破坏既有 3 处 `limit=200/300/600` 断言）。**列为观察项 §8-1** |
| **DCAP 走 `rest.rs` + `dto.rs`（而非 `settings.rs`）** | 04-implementation-plan P3 原文「dto 校验 + rest + config_store key=dcap」+ §7「形状比照 MA」；`ConfigStore` 落库比照 kline。两者**同属 web presentation 层**，无跨层影响 |
| **`dcap_config_or_default` 抽成纯函数** | 让「GET 无键/坏 JSON/越界旧值 → 默认不 500」可在**无 DB** 下单测（4 例）；handler 只剩 3 行 |
| **`calc` 双层防御**（`Array.isArray` + try/catch + 长度/值类型规整 + 非有限值 → null） | §9 可观测性硬要求「异常降级为断线，不得打断渲染」；同时防止把 `NaN` 交给渲染 |
| **`ensureDcapIndicatorRegistered` 幂等 + `typeof registerIndicator !== 'function'` 兜底** | klinecharts 全局注册重复会覆盖；jsdom 测试环境整体打桩（同 `tradeRange` overlay 先例） |
| **`dcapParams`/`onSaveDcapParams` 设为可选 prop（带默认）** | 兼容既有调用面（`KlineResultChart` 只传 `DASHBOARD_DEFAULTS.indicators`）与既有测试，**避免削弱既有断言** |
| **T11 服务端行为用「临时 scratch 集成测试」取证后删除** | 避免与 tester 的 T11 正式用例文件撞名；证据（输出 + harness 源码）已留档（§6） |

---

## 5. 测试覆盖（新增/更新）

### 5.1 新增前端测试（+44 例，TDD：先红后绿）

| 文件 | 例 | 覆盖 |
|---|---|---|
| `web/src/features/indicators/dcapIndicator.test.ts` | 15 | ① 注册面（名/3 figure/precision 5/**无 paneId**/calcParams 8 参/幂等注册）；② calc 对齐 `computeDcapSeries` 逐位 + null 位置（9/27/61）+ 参数生效 + 非单调归一；③ **降级面**（空/非数组/恶意 getter/缺参数 → 全 null 或 `[]`，不抛）；④ `dcapParamsFromCalcParams`/`dcapWarmupBars`(62/309)/`validateDcapParams` 规则 |
| `web/src/features/indicators/DcapParamsPanel.test.tsx` | 7 | 收起/展开、8 输入齐备且初值正确（**无 th 输入**）、合法保存解析（小数 r / smooth=0 / 整数 m）、非单调 n → 拒绝且不落库、4 组越界拒绝、服务端失败 → 面板保持打开报错、外部参数同步 + 保存成功收起 |
| `web/src/features/dashboard/dcapWarmupP3.test.ts` | 5 | `limit = viewport + 62`、缺省 warmup = viewport（ADR-020 不变）、上界 `+309`、非法 warmup 归 0、`hasMore` 按 warmup 后请求量 |
| `web/src/features/dashboard/dcapWiringP3.test.tsx` | 13 | Toolbar：DCAP 默认关 + 点击回调 + 面板内联保存；KlineChart：注册（precision 5 模板）+ `createIndicator(..., true)` 独立副图 + 非默认参数进 calcParams + **关时零创建** + MA/MACD 不受扰；DashboardPage：默认关 limit=120、开 DCAP limit=**182**、配置驱动（200+309=**509**）、保存 PUT 8 参 + 乐观更新、GET 失败保持默认；`readDcapParams` 重试/耗尽。 |
| `web/src/api/client.test.ts` | +2 | `getDcapConfig → GET /api/config/dcap`、`saveDcapConfig → PUT`（body = 8 参原样） |
| `web/src/api/mock.test.ts` | +2 | mock 默认/持久化/回显；7 组非法 → 400 且不落库 |

### 5.2 新增 Rust 单测（+4 例，写在 dto.rs 块内 → tangle 生成）

`dcap_config_default_and_roundtrip` / `dcap_config_validation_ranges_and_monotonic`（5 组非单调 + 7 组越界 + 边界合法）/ `dcap_config_non_integer_or_wrong_type_rejected_at_deserialize` / `dcap_config_or_default_falls_back_on_missing_bad_or_out_of_range`。

### 5.3 既有测试改动（仅类型必需，无断言放宽）

`KlineChart.test.tsx`（`BASE_INDICATORS` 补 `dcap:false`）、`Toolbar.test.tsx`（2 处指标 map 补 `dcap:false`）。**未删改任何既有断言**。

---

## 6. 验证（命令与输出）

| 命令 | 结果 |
|---|---|
| `cd web && npx vitest run` | ✅ **Test Files 56 passed (56) / Tests 558 passed (558)**（基线 52/514） |
| `cd web && npx tsc -b` | ✅ **exit=0** |
| `cargo test -p web --lib` | ✅ **49 passed; 0 failed**（基线 45） |
| `cargo check -p app -p web` | ✅ Finished（app 装配未破） |
| `cargo test -p web --test api_settings --test api_ma_config --test api_rest` | ✅ 6 / 1 / 2 passed |
| `./scripts/check-tangle.sh` | ✅ **exit=0**（3 次：DashboardGrid 后、dto 测试（红）后、dto+rest+lib 实现后） |
| `entangled tangle` ×3 | ✅ 每次显式核对落盘（§1.1 表）；INFO 仅写目标生成物 |

### 6.1 T11 服务端行为取证（真实 DB :5433 + 真实 axum 路由；scratch 测试运行后已删除）

- 证据：`coder/evidence/dcap_p3/t11_dcap_config_http_contract.txt`（运行输出）、`…harness.rs.txt`（harness 源码存档）
- 结果：`test dcap_config_http_contract ... ok`（GET 无键→默认 8 参且无 `th`；PUT 合法→200 回显+读回一致；**10 组非法 PUT → 400 且不落库**；库中坏 JSON / 越界旧值 → 200 默认）
- 收尾：`DELETE FROM app_config WHERE key='dcap'`（已 psql 复核：该 key 不存在，**未污染 dev 库**）

### 6.2 T8 渲染 spike 五项证据（真实 klinecharts 10.0.3 + 真实产物；harness 可复跑）

**Harness**：`coder/evidence/dcap_p3/spike/{index.html,spike.ts,run_spike.mjs}`（esbuild 打包含仓库真实 `dcapIndicator.ts`/`dcap.ts`；Playwright chromium 真实 canvas 渲染；hook `CanvasRenderingContext2D.fillText` **捕获真实渲染文本**作为机器可校验证据）→ 复跑：`node coder/evidence/dcap_p3/spike/run_spike.mjs`

| # | 证据路径 | 机检结论（`t8_assertions.txt`） |
|---|---|---|
| ① | `t8_1_precision_0.004578_p4_vs_p5.png`、`t8_1b_precision_0.0048_p4_vs_p5.png`、`t8_assertions.txt`、`t8_probe_results.json` | **PASS ×3**：精确值 `0.0045787545787547845`（与 §4 冻结值一致）→ 5 位渲染文本含 `0.00458`、4 位含 `0.0046`；`0.0048` → 5 位 `0.00480` / 4 位 `0.0048`；实例化 precision：DCAP=**5**、不设 precision 的对照 DCAP4=**4**（klinecharts 默认，事实核对成立） |
| ② | `t8_2_3_insufficient_break_and_3figures.png`、`t8_probe_results.json.degraded` | **PASS ×2**：1 根数据 → 三线全 null；恶意 getter → 降级全 null；空/非数组/缺参数 → `[]`/全 null；**5 种场景 threw=false**（含） |
| ③ | 同上截图（80 根，默认参数） + `t8_probe_results.json.charts.D_break_3figures` | **PASS ×3**：figures=`["s","m","l"]`；`paneId=indicator_pane_…`（**≠ candle_pane**）；断线首值 s=9 / m=27 / l=61（0-based，= `n_i+m−1`）；两张副图 `paneId`/`yAxisId` **互不相同**（独立副图 + 独立 Y 轴） |
| ④ | `t8_4_decimal_fold_0.00048.png`、`t8_probe_results.json.rawValues` | **PASS**：`formatFoldDecimal("0.00048",3)="0.0{3}48"`（`0.0048` 不折叠；`0.000048`→`0.0{4}48`）；轴刻度渲染文本实测出现折叠形态 `0.0{3}80` → **默认 threshold=3 无需调整即可读**（观察项 §8-2） |
| ⑤ | `t8_probe_results.json.perf`、`t8_assertions.txt`（T8-5） | **PASS**：600 根 + `n_l=250` + `m=60` → `computeDcapSeries` **min 0.5 / median 0.60 / max 1.8 ms**（7 次；预算 16ms） |
| 汇总 | `t8_assertions.txt` | **合计 10 项：PASS 10 / FAIL 0**；浏览器 console 无 error（仅 klinecharts 版本 banner） |

---

## 7. 并行车道纪律核对

- 未触 `design/12-strategy-system/04-strategy-programming-guide.md`、`design/99-decisions-log.md`（grep 确认二者**无 `file=` 块** ⇒ 我的 3 次 tangle 不可能写它们）；未触 `tester/**`。
- 未触 `design/14-dcap-indicator/**`（口径冻结；**未重新 tangle 该目录产物**）。
- 未执行 `git add/commit/stash/checkout`；`git diff --cached` 为空（**无 staged 文件**）。
- 未起 8081/8082（未启动任何服务；T8/T11 取证走 file:// 与随机端口 axum）。
- 生产数据面：只读；唯一写入为 dev 库 `app_config` 临时 key（已清理，见 §6.1）。

---

## 8. 未达标项 / 观察项（需架构师或 tester 关注）

1. **观察项（决策留痕）**：warmup 口径取「**开 DCAP 才有 warmup**」。若 T10 用例按「无条件 `limit = viewport + n_l+m−1`」书写则与本实现冲突——请以 §6「多取部分仅供计算」的**目的**（dcap 计算需要）为准；改成无条件会同时改动 ADR-020 既有取数断言（需架构裁决）。
2. **观察项**：`decimalFold.threshold` 维持默认 3（实测 `~0.00048` 值域下折叠为 `0.0{3}48`，可读，无需调阈值）。若产品要求 ≥5 位有效数字不被折叠，需另改全局 `setDecimalFold`（会影响所有指标，超出本任务范围）。
3. **已知 flake（与本次改动无关）**：`web/src/features/strategies/StrategyEditorPage.test.tsx` 在全量并行套件下偶发一次失败（CodeMirror 在 jsdom 的时序），单跑/复跑均绿；该文件未被我触碰。
4. **未覆盖**：未跑真机 e2e（禁起 8081/8082）——「Toolbar 面板 ↔ 真实后端」的端到端联调留待 tester 的 T8/T11 与部署核验。
5. **未做（口径明确）**：宫格缩略图不画 DCAP 副图（副图为单图专属；共享的是同一配置 key）。

---

## VERDICT

**GREEN（带观察项）** —— 需求 1)–5) 全部落地且机检通过：`dcapIndicator` 副图（独立 pane / precision 5 / 断线降级）、Toolbar DCAP 默认关 + MA 形态参数面板、`GET/PUT /api/config/dcap`（400 严格 + GET 韧性）、取数 warmup、T8 十项断言全绿（含 600 根 + `n_l=250` + `m=60` 的 0.6ms 中位耗时）。观察项为 §8-1（warmup 触发条件属实现口径解释，已留痕待复核）与 §8-2/3/4（阈值维持默认、既有 flake、未跑真机 e2e）。
