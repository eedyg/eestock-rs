# 证据目录 053 — 「切换 period / stock 重置指标视图布局」阶段 1 诊断（真实渲染）

- 执行报告：`tester/test/053_period_stock_switch_layout_diagnosis_execution.md`
- 测试设计：`tester/design/017_period_stock_switch_layout_red_test_design.md`
- 新增红测试：`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`
- 时间窗：2026-09-14 09:09 ~ 09:17 (+0800)；仓库根 `/home/eestock/workspace/git/eestock/eestock-rs`；**HEAD = `ece1d9d`**（无 tracked 改动）
- 被测形态（全部临时、全部在 /tmp）：root = 仓库 `web/`，alias `klinecharts` → `harness/kc-spy.ts`，产物 `/tmp/diag53/dist`，`vite preview` @ `127.0.0.1:18097`；`/api`、`/ws` 代理到**线上只读** `127.0.0.1:8081`（**只发 GET**；未发任何 PUT）
- 真实引擎：`klinecharts@10.0.3`（真身，未打桩；`kc-spy.ts` 仅包裹实例方法以记录调用序列 + 暴露 `window.__ACC__{inits,charts,log}`）
- 纪律：未 kill/重启/改配置 8081/8082（PID 2102695 全程未动）；未改线上 `web/dist`；未 `git add/commit/stash`；未跑 tangle；未改 `design/14-dcap-indicator` 的 `file=` 块；无崩溃、无 core dump（4 次探针 `pageErrors=[]`）

## 文件清单

| 文件 | 说明 |
|---|---|
| `harness/kc-spy.ts` | klinecharts 透传 spy（临时 alias）：暴露 `window.__ACC__{inits,charts,log}`；记录 `createIndicator/removeIndicator/overrideIndicator/setPaneOptions/setDataLoader/setSymbol/setPeriod/resetData` 调用序列 + 每次调用后 pane id 快照 |
| `harness/lib.mjs` | 公共库：页面状态快照（pane 渲染高度 = `getDom(paneId).getBoundingClientRect().height`、pane id、指标、dataList、视口）、分隔线拖拽、写防护路由、JSON 落盘 |
| `harness/vite.diag.config.ts` | 临时构建/预览配置（`ACC_ROOT`/`ACC_OUT`/`ACC_PORT` 可切）；端口 18097；`/api`、`/ws` 代理线上 8081 |
| `harness/probe_period.mjs` | **主探针**：①切 period（15m→1h）②切 stock（518880→161226）③首选「不 remount」原地切换实测 ④备选回放 setPaneOptions 实测 |
| `harness/probe_regress.mjs` | **回归探针**：warmup 取数口径（120 / 120+68）、ADR-020 手动缩放后切周期（remount 重算 fit）、备选回放（异步等待确认）、overlay 原地切换残留 |
| `harness/probe_extra.mjs` | 补测：1m→15m 切换 + 真实 wheel 手动缩放后原地切换（fit 不重算） |
| `harness/probe_viewport.mjs` | 触发面补测：`viewportBars` 变化（受控 `/api/config/kline` + `window.focus`）也触发 remount + 布局重置 |
| `harness/probe_shots.mjs` | 截图证据脚本 |
| `json/probe_period.json` | 主探针原始输出（A/B/C/D 场景 + checks + logBurst + wsFrames） |
| `json/probe_regress.json` | 回归探针原始输出 |
| `json/probe_extra.json` | 补测原始输出 |
| `json/probe_viewport.json` | viewportBars 触发面原始输出 |
| `shots/P1-dragged-15m.png` | 拖高 VOL/DCAP 后（15m） |
| `shots/P2-after-period-switch-1h.png` | 切 period 到 1h 后（副图缩回） |
| `shots/P3-dragged-before-stock.png` | 切回 15m、重新拖高（切 stock 前） |
| `shots/P4-after-stock-switch-161226.png` | 切 stock 到 161226 后（副图缩回） |
| `logs/red-test-run.txt` | 常驻红测试单跑原始输出（`Tests 2 failed | 1 passed (3)`） |
| `logs/vitest_full.txt` | 全量 vitest 原始输出（`58 files / 577 tests，2 failed / 575 passed`） |
| `logs/tsc_b.log` | `npx tsc -b` 输出（空 = 干净，exit 0） |

## 关键数值汇总

| 场景 | pane | 切换前 | 切换后 | Δ | `__ACC__.inits` |
|---|---|---|---|---|---|
| 切 period 15m→1h | VOL | 199 | 100 | −99 | 1→2 |
| 切 period 15m→1h | DCAP | 140 | 100 | −40 | 1→2 |
| 切 period 15m→1h | MA(candle) | 357 | 496 | +139 | 1→2 |
| 切 stock 518880→161226 | VOL | 199 | 100 | −99 | 3→4 |
| 切 period 1m→15m | VOL/DCAP | 199/140 | 100/100 | −99/−40 | 2→3 |
| viewportBars 120→200(focus) | VOL/DCAP | 199/140 | 100/100 | −99/−40 | 1→2 |
| 原地切换（首选） | VOL/DCAP | 220/170 | **220/170** | **0/0** | 4→4 |

## 复跑要点（全部临时端口；先建后拆）

```bash
# 1) 临时构建 + 预览（真实引擎 + spy）
cd /home/eestock/workspace/git/eestock/eestock-rs/web
NODE_PATH=$PWD/node_modules npx vite build --config /tmp/diag53/vite.diag.config.ts
NODE_PATH=$PWD/node_modules nohup npx vite preview --config /tmp/diag53/vite.diag.config.ts &

# 2) 探针
cd /tmp/diag53
node probe_period.mjs   # 主：切 period/stock + 首选/备选
node probe_regress.mjs  # 回归面
node probe_extra.mjs    # 1m→15m + 手动缩放
node probe_viewport.mjs # viewportBars 触发面
node probe_shots.mjs    # 截图

# 3) 常驻红测试（修复前 2 failed | 1 passed）
cd /home/eestock/workspace/git/eestock/eestock-rs/web
npx vitest run src/features/dashboard/KlineChartSwitchLayout.test.tsx
```
