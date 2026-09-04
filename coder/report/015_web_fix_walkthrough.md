# Coder 报告 015：Web 截图走查 3 缺陷 + D6 根治 + E2E 数据成功断言

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/015_web_fix_walkthrough.md`
> 依据：design/06-web/09-frontend.md「E2E 测试栈」/「截图走查门槛」+ design/06-web/02-sources.md / 04-quality.md + design/07-app-plane/00-web-api.md §1.1/§1.3
> 运行目标：真实 app 容器 `:8081`（eestock-app + 真实 DB，用户选 a）
> 验收：`npm run e2e` 全绿（32/32）+ 5 页截图产物在 + 本报告含复现/验证 + 新增用例清单
>
> 父级裁决（架构歧义 → contact_supervisor `need_decision`，2026-09-04）：页②缺口区采用**方案 A**（单标的缺口摘要 + 标的选择器，复用页面④ GapReportList，设计向真实后端契约收敛）；issue#3 判断获批（补「最近 N 条告警」计数头部 + 时间改 CST）。

---

## 0. 执行摘要

| 项 | 结果 |
|---|---|
| `npm run e2e` | ✅ **32 passed / 0 failed**（chromium；workers=1 串行；retries=1）。含新增 5 数据成功断言 |
| `npm test`（vitest） | ✅ **170 passed / 21 files**（未混入 e2e） |
| `npm run build` | ✅ exit 0（`tsc -b && vite build`；`VITE_API_MOCK=0` 真后端契约构建） |
| `cargo test -p web --test api_quality` | ✅ 通过（D6 `/api*`→404 + SPA 仍回退断言） |
| `cargo test -p web --test api_rest` | ✅ 通过（SPA 深链/目录穿越基线未回归） |
| `cargo test -p web`（全量） | ⚠️ 1 例间歇失败（api_alerts `rules_list_patch_and_validation`，**单独跑通过**，test-order/共享 DB 隔离，预存在、与本次改动无关——见 §8） |
| 5 页截图走查产物 | ✅ 重新生成 `design/06-web/preview/real-*.png` ×5（quality 由 **13,214px → 720px** 高度受控） |
| D6 根治 | ✅ 源码修复 + 设计文档契约修正 + `cargo test` 锁定（见 §2） |

---

## 1. 修复项 ①：页面②缺口面板 URL/参数错误（真 Bug）

### 1.1 复现（修复前）
页② `gap-cards` 区域发 `GET /api/collection/gaps?date=today`——该端点在真实后端**不存在**（Wave 2 Phase A 只交付单 code 的 `/api/quality/gaps`，00-web-api §1.1）。真实 app 返回 404，前端渲染红色错误条：

```
curl http://localhost:8081/api/collection/gaps?date=today
HTTP 404 ct=application/json  {"error":"not found"}
```
走查截图 `real-sources.png`（修复前）显示「缺口数据加载失败：HTTP 404 /api/collection/gaps?date=today: not found」红色红条。

### 1.2 根因
`web/src/api/client.ts` 的 `getGaps()` 调用了不存在端点；`design/06-web/02-sources.md` §6/L2/L3/§8 把 gap-cards 设计为「每标的当日 1m 缺口率卡墙」并写 `/api/collection/gaps?date=today`——设计稿超纲/错配（ADR-014：契约以可实现为准）。

### 1.3 修复（方案 A，父级裁决）
- **client**：删除 `getGaps()` 方法（接口+mock+类型测试），页②数据源改用既有 `getQualityGaps({code,from,to})`（`GET /api/quality/gaps?code=&from=&to=`）。
- **store**：`SourcesStore` 新增 `symbols`（复用 `getSymbols()` 列表）与 `selectedCode`（默认首个标的，非任意），`gaps` 改为 `AsyncSlice<QualityGapsResponse>`；`init` 先载符号表定默认标的，再载缺口摘要（近 7 自然日 CST，`SOURCES_DEFAULTS.gapRangeDays=7`）；新增 `selectCode()` 切换即重查、`retryGaps()`。
- **组件**：`GapCards.tsx` 重写为「单标的缺口摘要」——轻量标的选择器（`<select>` 复用 symbols）+ 复用页面④ `GapReportList`（DRY）；三态=骨架行/「该范围无缺口」/错误占位+重试。
- **设计文档**（02-sources.md）：§6 改写为单标的摘要（含标的选择器/默认首个/「标的级全量缺口归页面④」）；L2 `gap-cards` 行、§8 API 依赖、L1 ASCII、L3 SourcesGrid 块同步收敛到 `/api/quality/gaps?code=&from=&to=`（`SOURCES_DEFAULTS` 移除 `gapWarnPct/gapCritPct`、加 `gapRangeDays`）。04-quality.md QualityGrid 块未动（页④只读方）。

### 1.4 验证（修复后）
真实 app（`VITE_API_MOCK=0` dist + 真实后端）：
```
/sources gap-cards：缺口摘要·标的 [159337 中证500ETF基金▾] 09-02缺 6 bar/应到 241缺 10:41-10:45（5 bar） 源故障…
errorTexts=0  docScroll=800
```
`real-sources.png` 显示缺口摘要（无红色错误条）、数据成功渲染。E2E `data-success.e2e.ts`「②数据源」断言通过（`gap-symbol-select` 可见 + 无「加载失败」）。

---

## 2. 修复项 ②：D6 根治（/api/* 未匹配 → 404）

### 2.1 复现（修复前）
`crates/web/src/spa.rs` 只有 `uri.path().starts_with("/api/")` 判定，**漏掉裸 `/api`**（无尾斜杠）路径：
```
curl http://localhost:8081/api
HTTP 200 ct=text/html; charset=utf-8   ← 回退 index.html，Bug
```
`/api/nonexistent`（`/api/` 前缀）已 404，但裸 `/api` 被当作前端路由回退 SPA 页。

### 2.2 修复
- **design/07-app-plane/00-web-api.md**：§1.3 叙事改为「任何 `/api` 前缀路径（含裸 `/api`）未命中不回退 index.html，返回 404 JSON」；`spa.rs` tangle 块 `starts_with("/api/")` → `starts_with("/api")`（并更新块头注释）。
- **tangle** 重生成 `crates/web/src/spa.rs`。
- **测试锁定**（design 文档 `api_quality.rs` 块 + tangle）：`GET /api`、`GET /api/nonexistent`、`GET /api/quality/nope` 均 404 JSON `{"error":"not found"}`；`POST /api/nonexistent` 同口径 404；对照 `GET /quality` 仍回退 index.html（前端 history 路由）。

### 2.3 验证
```
cargo test -p web --test api_quality   → ok 1 passed（含 D6 断言）
cargo test -p web --test api_rest      → ok 2 passed（SPA 深链/目录穿越未回归）
```

---

## 3. 修复项 ③：页面②告警行计数空

### 3.1 复现
`AlertPreview` 渲染告警行但**无「最近 N 条」计数头部**（样机口径「最近 10 条只读」缺失），且时间用 `ts.slice(11,16)` 直取 UTC 段，**偏移 8h**（显示 15:10 前应为 UTC 段 07:10；与页面⑦ CST 口径不一致）。

### 3.2 修复
`AlertPreview.tsx`：
- 新增计数头部 `最近 <N> 条告警`（`data-testid="alert-preview-count"`，N=`alerts.length`，真实渲染条数）。
- 时间改 CST（`Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai'})`，与 AlertList 同口径）。

### 3.3 验证
`real-sources.png` 显示「最近 10 条告警」头部 + ● 15:10 sina_jsonp …（CST 时刻）。E2E「②数据源」断言 `alert-preview-count` 文本匹配 `/最近\s*\d+\s*条告警/` 通过。

---

## 4. 修复项 ④：页面④质量页超长布局

### 4.1 复现（修复前）
`real-quality.png` 尺寸 **1488×13,214**（全页截图过高）。根因：`QualityGrid` 的 `divergence-table` 区域 `flex-1` 但**缺 `min-h-0`**，flex 项 `min-height:auto` 禁止收缩到内容高以下，大表（数百行）撑满 docScroll≈13,214px。

### 4.2 修复
- **design/06-web/04-quality.md** QualityGrid L3 块：页根 `flex` 加 `min-h-0`；`divergence-table`/`overlay-chart` 区域改 `flex-1 min-h-0 flex-col overflow-hidden`；固定区（filter-bar/accuracy-cards/底部 sync+gap）加 `shrink-0`。
- **tangle** 重生成 `web/src/layouts/QualityGrid.tsx`（`DivergenceTable` 本身已 `flex-1 overflow-auto`，容器受界后即可视口内滚动）。

### 4.3 验证（修复后）
```
/quality docScroll=800（内层H=800）  errorTexts=0
[divergence-table] scrollH=481 clientH=481（表体在视口内滚动，不再撑爆）
real-quality.png  1488×720（原 13,214px）
```

---

## 5. 修复项 ⑤：E2E 数据成功断言（堵弱断言漏洞）

新增 `web/e2e/data-success.e2e.ts`：每页等**骨架消失**（`.animate-pulse` 归零）→ 断言**无「加载失败」错误横幅**（`getByText(/加载失败/)` 为 0）→ 断**关键区域真实数据渲染**（不复用「仅 data-region 齐/仅骨架在」弱断言；空态「该范围无比对数据」/「暂无告警」按正常无数据态容忍）。

| 用例 | 断言要点 |
|---|---|
| ①行情 `/` | `symbol-list` 可见 + `.num` 首个匹配 `\d{6}`（真实代码+价格） |
| ②数据源 `/sources` | `source-cards [data-source]` 可见 + `gap-symbol-select` 可见（复用 symbols）+ `alert-preview-count` 文本匹配 `最近 N 条` |
| ③标的 `/symbols` | `symbol-table tbody tr` 有数据行 或「未注册标的」空态 |
| ④质量 `/quality` | `divergence-rows` 有行 或「该范围无比对数据」空态 + `accuracy-cards` 可见 |
| ⑦告警 `/alerts` | `alert-list` 行（`[class*="mb-1.5"]`）或「暂无告警」空态 |

状态容忍：不锁价格/时间/行数，只断「真实数据已渲染 + 无错误横幅」。

---

## 6. E2E 新增用例清单

- 新增 `web/e2e/data-success.e2e.ts`：**5 用例**（第①/②/③/④/⑦页数据成功断言）。
- 视觉基线**重新基线化** 3 张：`sources-full`、`quality-full`、`alerts-full`（因本次有意 UI 变更：页②缺口/告警、页④布局；`npm run e2e:update` 仅在有意 UI 变更后人工执行）。
- 总计数：原 27 + 新增 5 = **32 用例**，`npm run e2e` 32/32 全绿。

---

## 7. 重新生成的 5 页实时截图产物

| 产物 | 修复前 | 修复后 |
|---|---|---|
| `design/06-web/preview/real-dashboard.png` | 1280×720（视口；KlineChart 布局缺陷 `h-[125%]` 属独立既有缺陷，report 014 §7.1，本次未动） | 1280×720 |
| `design/06-web/preview/real-sources.png` | 1488×720（缺口红条 + 告警无计数） | 1488×741（缺口摘要+标的选择器 + 「最近 10 条告警」计数） |
| `design/06-web/preview/real-symbols.png` | 1488×1996 | 1488×1996 |
| `design/06-web/preview/real-quality.png` | **1488×13,214** | **1488×720**（大表视口内滚动，高度受控） |
| `design/06-web/preview/real-alerts.png` | 1488×969 | 1488×969 |

---

## 8. 已知残留 / 豁免

- **api_alerts 间歇失败（与本次无关）**：`cargo test -p web` 全量跑时 `api_alerts::rules_list_patch_and_validation` 偶发失败（阈值 1.0 vs 0.95）；**单独跑通过**（`cargo test -p web --test api_alerts rules_list_patch_and_validation` → ok）。属 test-order/共享 DB 隔离问题，**预存在**，非本次改动引入（`api_alerts.rs` 及 alert 逻辑未触碰）。
- **运行容器二进制陈旧**：为跑 e2e/走查截图，已将新 `web/dist`（`VITE_API_MOCK=0`）经 `docker cp` 复制入 `eestock-app:/app/dist` 并 restart；但**后端二进制未重建**（spa.rs D6 `/api` 裸路径修复已源码+测试锁定；`docker compose up -d --build app` 重建后线上生效）。故**线上 curl `/api` 仍 200**（旧二进制），与源码修复不一致需重建。
- **页②标的级全量缺口卡墙**：按父级裁决归 Wave 3（本周不做）。
- **gitnexus**：`detect-changes` 报 index 陈旧/多仓库（eestock / eestock-rs），提示需重新 analyze；本批为前端 React + spa.rs/设计文档改动，经 `git status`/编译/测试人工核实范围。

---

## 9. 验证证据

| 命令 | 结果 | 摘要 |
|---|---|---|
| `npm run e2e` | ✅ passed | 32/32（chromium；26.3s；含新增 5 数据成功断言） |
| `npm run e2e:update` | ✅ passed | 重基线 3 张（sources/quality/alerts） |
| `npm test -- --run` | ✅ passed | 170/170（21 files） |
| `npm run build`（`VITE_API_MOCK=0`） | ✅ passed | `tsc -b && vite build` exit 0；dist 产出 |
| `cargo test -p web --test api_quality` | ✅ passed | D6 `/api*`→404 + SPA 回退 |
| `cargo test -p web --test api_rest` | ✅ passed | SPA 深链/目录穿越基线未回归 |
| `cargo test -p web`（全量） | ⚠️ 1 例间歇 | api_alerts 阈值（单独跑通过，预存在隔离问题） |
| playwright 实测 `/sources` `/quality` | ✅ | docScroll=800、errorTexts=0、缺口摘要/告警计数/分歧表滚动均真实渲染 |

---

## 10. changed-files（改动清单）

- **后端（D6）**：`crates/web/src/spa.rs`、`crates/web/tests/api_quality.rs`、`design/07-app-plane/00-web-api.md`（§1.3 + spa.rs/api_quality tangle 块）
- **前端**：`web/src/api/client.ts` / `client.test.ts` / `mock.ts` / `mock.test.ts`；`web/src/features/sources/{store,store.test,SourcesPage,SourcesPage.test,GapCards,AlertPreview}.tsx/ts`；`web/src/layouts/{QualityGrid,SourcesGrid}.tsx`
- **设计文档**：`design/06-web/02-sources.md`（§6/L1/L2/L3/§8）、`design/06-web/04-quality.md`（QualityGrid L3）
- **E2E**：`web/e2e/data-success.e2e.ts`（新增）、`web/e2e/screenshots/visual.e2e.ts-snapshots/{sources,quality,alerts}-full-*.png`（重基线）、`web/e2e/sql-ledger.md`
- **走查产物**：`design/06-web/preview/real-{dashboard,sources,symbols,quality,alerts}.png`（重新生成）

> 已 `git add`（staged，未 commit）。未纳入的无关 untracked：`.claude/`、`AGENTS.md`、`CLAUDE.md`、`backup_symbols.sql`、`logs/*`、`tester/report/007_wave2_acceptance.md` 等预存/无关文件。
