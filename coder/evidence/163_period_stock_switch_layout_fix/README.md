# 证据目录 163 — 「切 period / 切 stock 不得重置指标视图布局」阶段 2 修复（真渲染验收）

- 执行报告（coder 车道）：`coder/report/163_period_stock_switch_layout_fix.md`
- 阶段 1 诊断输入：`tester/test/053_period_stock_switch_layout_diagnosis_execution.md`（VERDICT: DIAGNOSED）
- 阶段 1 红测试（本车道未改动，现已转绿）：`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`
- 时间窗：2026-09-14 09:24 ~ 09:36 (+0800)；仓库根 `/home/eestock/workspace/git/eestock/eestock-rs`

## 临时形态（全部在 /tmp，仓库零污染）

- 临时构建 1（**修复后**）：root = 仓库 `web/`，alias `klinecharts` → `/tmp/fix2/kc-spy.ts`（透传真身 `klinecharts@10.0.3`，仅包裹实例方法暴露 `window.__ACC__{inits,charts,log}`），产物 `/tmp/fix2/dist`，`vite preview` @ `127.0.0.1:18098`
- 临时构建 2（**修复前对照**，git HEAD 版 `KlineChart.tsx`）：产物 `/tmp/fix2/dist-old`，`127.0.0.1:18099`
- `/api`、`/ws` 反向代理到线上只读 `127.0.0.1:8081`；浏览器侧 `installRoutes` 拦截：**GET 放行，PUT `/api/config/*` 本地兑现（不发后端/DB），其余非 GET 一律 abort**
- 纪律：线上 8081/8082（PID 2102695）全程未动（未 kill/未重启/**未 PUT**）；未改线上 `web/dist`；未 `git add/commit/stash`；未跑 tangle 回写；未改 `design/14-dcap-indicator` 的 `file=` 块；探针 `nonGetOther=[]`、`pageErrors=[]`
- 临时资源收尾：18098 / 18099 均已释放

## 文件清单

| 文件 | 说明 |
|---|---|
| `probe_fix.mjs` | 阶段 2 真渲染探针（27 条判据；A 切 period / B 切 stock / C 手动缩放后切 period / D DCAP 开关 / E 只读保证） |
| `probe_fix.json` | 修复后探针原始 JSON（`checks` / `scenarios` / `klineUrls` / `wsFrames`） |
| `probe_fix-run.log` | 修复后探针 stdout（`checks: 27/27 passed`） |
| `probe_fix-prefix-control-run.log` | **修复前对照**（HEAD 版构建，同一探针）：`checks: 19/27 passed` |
| `vite.fix.config.ts` | 临时构建/预览配置（端口 18098，代理线上 8081） |
| `kc-spy.ts` / `lib.mjs` | 阶段 1 harness 的透传 spy 与公共库（复用；未改仓库文件） |
| `e2e-fixedbuild-pane-separator.log` | 只读 e2e `e2e/dashboard-pane-separator.e2e.ts` @ 临时端口（修复后构建）：1 passed |
| `e2e-fixedbuild-kline-matrix-subset.log` | `e2e/kline-matrix.e2e.ts -g "D9\|D10\|G16\|G18"` @ 临时端口：3 failed / 1 passed |
| `e2e-oldbuild-8081-kline-matrix-subset-control.log` | **同一组 4 项** @ 线上 8081（HEAD 版旧构建）：3 failed / 1 passed（同一条用例、同一断言）⇒ 属既有/环境性失败 |
| `vitest-full.log` | `cd web && npx vitest run`：58 files / 577 tests 全绿 |
| `tsc-b.log` | `cd web && npx tsc -b`（空 = 干净，exit 0） |
| `check-tangle.log` | `./scripts/check-tangle.sh`：exit 0（沙箱重新生成 + 逐字节比对通过） |

## 关键数值（修复前 → 修复后，同一探针）

| 场景 | 判据 | 修复前（对照） | 修复后 |
|---|---|---|---|
| 切 period 15m→1h（拖高后） | VOL / DCAP / MA 渲染高度 | 199→**100** / 140→**100** / 357→**496** | 199→**199** / 140→**140** / 357→**357** |
| 切 period | pane id | 全换（`…_3`/`…_2` → 新时间戳） | 完全一致 |
| 切 period | `__ACC__.inits` | 1→**2**（整图 remount） | 1→**1** |
| 切 period | burst | `setDataLoader/setSymbol/setPeriod/createIndicator×3` | `setDataLoader/setSymbol/setPeriod`（无 create/remove） |
| 切 stock 518880→161226 | pane id | 全换 | 完全一致 |
| 切 stock | `__ACC__.inits` | 3→**4** | 1→**1** |
| 切 period / 切 stock | `/api/kline` GET 次数 | 1 | 1（窗口 `limit=188` = viewport 120 + warmup 68） |
| 真实 wheel 手动缩放后切 period | 可见根数（`data-viewport-fit`） | 回 fit（≈118） | 回 fit（≈118，ADR-020 口径不变） |
| DCAP 关→开 | pane 数 3→2→3、`inits` | 不 remount | 不 remount（precision 5、`zero` figure 常驻） |
| 全程 | 非 GET 请求 / 页面异常 | 0 / 0 | 0 / 0 |

## 复跑要点（先建后拆，全部临时端口）

```bash
# 1) 临时构建 + 预览（修复后）
cp -a <仓库>/tester/evidence/053/harness/{kc-spy.ts,lib.mjs} /tmp/fix2/
cp -a <本目录>/vite.fix.config.ts /tmp/fix2/
cd <仓库>/web && NODE_PATH=$PWD/node_modules npx vite build --config /tmp/fix2/vite.fix.config.ts
NODE_PATH=$PWD/node_modules nohup npx vite preview --config /tmp/fix2/vite.fix.config.ts &
# 2) 探针
cd /tmp/fix2 && node probe_fix.mjs                 # 期望 checks: 27/27 passed
# 3) 只读 e2e（临时端口）
cd <仓库>/web && E2E_BASE_URL=http://127.0.0.1:18098 npx playwright test e2e/dashboard-pane-separator.e2e.ts
```
