# 139 · mock 构建事故：立即恢复 + 默认翻转根治

- 日期：2026-09-11（+08）
- 任务：线上事件修复 —— 8081 前端 bundle 为 mock 构建（漏 `VITE_API_MOCK=0`），全站假数据
- 报告文件自身：`eestock-rs/coder/report/139_mock_build_incident_fix.md`
- 前序诊断：`/tmp/ui_incident/INCIDENT_REPORT.md`（本任务仅按其已锁定根因执行修复）

## 1. 事故时间线（含引入考证）

| 时间（+08） | 事件 | 证据 |
|---|---|---|
| 2026-09-04 | commit 6aa4bcb 引入 `api/index.ts` 默认 mock 分支（`VITE_API_MOCK !== '0'`），Phase A 并行期设计 | incident 报告 §3 |
| 2026-09-10 23:41:38 | `web/dist/` 被重建（`index-BtKE6hDm.js`），**未带 `VITE_API_MOCK=0`** → mock bundle；同晚部署报告 137/138 仅记录 Rust 侧改动与二进制重启，均未提前端重建——系并行/验证性 `vite build` 的副产物 | dist mtime + bundle 静态分析（`/tmp/ui_incident/bundle.js`） |
| 2026-09-11 00:27:59 | 8081 进程重启（PID 2914780），开始服务 mock bundle | ps lstart |
| 2026-09-11 00:40 | 事件诊断完成：全站 4 假标的、518880=2.431（真实 44 标的/9.083）、全会话 0 条 /api 请求 | `/tmp/ui_incident/` |
| 2026-09-11 00:46 | **恢复**：`VITE_API_MOCK=0 npm run build` → `index-DwSJEjoC.js`（与 131 报告记录的已知良好部署 hash 完全一致）；kill 2914780 → 同配置 `/tmp/app_dev_8081.toml` 重启（新 PID 2932374），日志 `logs/app_incident_fix_20260911_0046.log` | 本报告 §3 |
| 2026-09-11 00:47–00:51 | **根治**：默认翻转（TDD）+ 语义化脚本 + 文档/部署对齐 | 本报告 §4–6 |

前科：tester/report/007 与 coder/report/013（Wave 2 Phase C）各记录过一次同类「mock 泄漏」，本次为第三次，故做默认翻转根治而非仅流程叮嘱。

## 2. 步骤 1：立即恢复（已完成）

1. `cd web && VITE_API_MOCK=0 npm run build` → `dist/assets/index-DwSJEjoC.js`（grep `契约桩|mock_seed|mock_dual_ma` = 0；含 `/api/symbols`×7、`/api/kline`、`/api/quality`×3）。
2. 重启：`kill 2914780` → `nohup target/debug/eestock-app --config /tmp/app_dev_8081.toml > logs/app_incident_fix_20260911_0046.log`，新 PID 2932374，8081/8082 正常 LISTEN，`/healthz` ok，`/api/symbols` 返回 44 真实标的（518880=华安黄金易ETF 9.083）。

## 3. 步骤 1 复验证据（Playwright）

脚本 `/tmp/verify_fix.mjs`（临时，不入仓）；证据 `/tmp/ui_incident_fix/{dashboard,symbols}.png` + `report.json`：

| 验收项 | 结果 |
|---|---|
| 看板/symbols 真实标的数 | **共 44 只**（mock 期 4 只）|
| 518880 现价 | **9.083**（mock 期 2.431）|
| 真实 /api 网络请求 | **7 条**（`/api/symbols`、`/api/config/ma`、`/api/config/kline`、`/api/sources/health`、`/api/kline?code=518880&period=15m&limit=34` 等；mock 期 0 条）|
| console error / page error / 失败请求 | **0 / 0 / 0** |

根治改动落地后二次复验（00:51）：同上指标全绿，服务未再重启（dist 内容与翻转后默认构建逐字节一致，hash 同为 `DwSJEjoC`）。

## 4. 步骤 2：根治变更清单（TDD）

| 文件 | 变更 | 层/归属 |
|---|---|---|
| `web/src/api/index.ts` | **默认翻转**：`useMock = import.meta.env.VITE_API_MOCK === '1'`（原 `!== '0'`）；注释更新。grep 全仓确认此为 `VITE_API_MOCK` 唯一代码引用点 | 前端 infrastructure（数据源选择），不改 `ApiClient` 接口契约 |
| `web/src/api/index.test.ts` | **新增**防回归测试 4 例：未设置 → 真实 client；`'0'` → 真实；`'1'` → mock；`'true'`（其他值）→ 真实。sentinel mock `./mock`/`./client` 工厂 + `vi.stubEnv` + `vi.resetModules` 动态 import | 前端测试 |
| `web/package.json` | scripts 增补 `"build:prod": "VITE_API_MOCK=0 vite build"`（部署用）、`"build:mock": "VITE_API_MOCK=1 vite build"`（契约桩开发用）；`build` 原样保留 | 前端工程化 |
| `Dockerfile.app` | frontend 阶段 `RUN VITE_API_MOCK=0 npm run build` → `RUN npm run build:prod`（**tangle 生成物，走正规流程**：改 design 源 → `entangled tangle` 再生成） | 部署（app-plane） |
| `design/07-app-plane/00-web-api.md` | §6：Dockerfile 代码块同步 + 散文改为 `npm run build:prod` 口径 + **新增部署惯例条目**（凡部署语义构建一律 `build:prod`；部署报告须附 `grep -c 契约桩 dist/assets/*.js` = 0 防呆证据） | 设计事实源 |
| `design/06-web/09-frontend.md` | §4「切换方式」改写为翻转后语义（仅 `'1'` 启用 mock，默认站在生产一侧）；构建表行补 `build:prod`/`build:mock` 说明 | 设计事实源 |

TDD 时序：先写 `index.test.ts` 4 例 → 跑出 **Red**（未设置/`'true'` 2 例失败，现行码返回 mock）→ 翻转一行实现 → **Green**（4/4 通过）→ 无重构需要（单行谓词）。

对齐检查结论：
- `web/e2e` / `playwright.config.ts`：E2E 打真实 app 容器，无自身构建步骤，无需对齐。
- `README.md`：无 `npm run build` 部署语义处。
- `scripts/deploy.sh`：无直接前端构建步骤（构建在 docker compose → `Dockerfile.app` 内），故脚本本身零改动；其触达的镜像构建已切 `build:prod`。
- cargo/Rust 侧：零改动（本任务纯前端 + 脚本 + 文档）。

## 5. 验证

| 命令 | 结果 |
|---|---|
| `npx vitest run src/api/index.test.ts`（Red） | 2 failed / 2 passed（预期失败，确认现行码缺陷）|
| 同上（Green，翻转后） | **4 passed** |
| `npm test`（cd web） | **46 文件 / 451 用例全绿** |
| `npm run build`（无 env，`--outDir /tmp/vb_default`） | 产物 `index-DwSJEjoC.js`，`grep -c "mock_seed\|契约桩"` = **0**（防呆回归达标）|
| `npm run build:mock -- --outDir /tmp/vb_mock` | 产物**含** mock 标记（grep = 1）|
| `npm run build:prod -- --outDir /tmp/vb_prod` | 0 mock 标记，hash 与默认构建一致 |
| `entangled tangle`（基线） | 「Nothing to be done」——改前 design 与生成物同步 |
| 改 design 后 `entangled tangle` | 仅重生成 `Dockerfile.app`（+2/-2）|
| `./scripts/check-tangle.sh`（git add 后） | ✅ tangle 后无 diff |
| Playwright 复验 ×2（恢复后 / 根治后） | 44 标的 / 9.083 / 7 条真实 /api / 0 console error |

注：验证用构建全部 `--outDir /tmp/...`，**不触碰** 8081 正在服务的 `web/dist`（避免验证性 mock 构建再次污染线上——正是本次事故机制）。

## 6. 残留风险

- `web/dist` 仍是「非入库、按请求读取」模式：任何终端里裸 `vite build` 都会改写线上产物。默认翻转后裸 build 也出真实 bundle，风险已根治；防呆 grep 检查项已写入 07-app-plane §6 部署惯例。
- dev server（`npm run dev`）默认亦翻转为真实 API；契约桩开发需显式 `VITE_API_MOCK=1`（已在 09-frontend §4 注明）。
- 8081 仍为 debug 二进制（沿袭 dev 惯例，与本次事件无关）。
