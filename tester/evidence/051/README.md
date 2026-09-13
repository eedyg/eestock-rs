# 证据目录 051 — dcap 参数保存后布局被重置：复现/定位/可行性/红测试（阶段 1 诊断）

- 执行报告：`tester/test/051_dcap_save_layout_reset_diagnosis_execution.md`
- 测试设计：`tester/design/016_dcap_save_layout_red_test_design.md`
- 时间窗：2026-09-13 23:09 ~ 23:26 (+0800)；仓库根 `/home/eestock/workspace/git/eestock/eestock-rs`；HEAD = `d74bfb8`（工作树未被本车道修改产品代码）
- 被测形态：**临时构建 + 临时预览端口**，不含任何对线上实例的操作：
  - 构建：`vite build`（root = 仓库 `web/`，alias `klinecharts` → `/tmp/diag51/kc-spy.ts`），产物 `/tmp/diag51/dist`
  - 服务：`vite preview` 于 `127.0.0.1:18085`，`/api`、`/ws` 反向代理到**线上只读** `127.0.0.1:8081`（只发 GET）
  - 写防护：Playwright 在浏览器侧拦截一切非 GET；`PUT /api/config/dcap` 由 `route.fulfill(200, echo)` **本地兑现**，绝不发往后端/DB（逐条记录见各 `probe*.json` 的 `putIntercepted`）
  - 真实引擎：`klinecharts@10.0.3`（真身，未打桩；`kc-spy.ts` 仅包裹实例方法以记录调用序列）
- 纪律：未 kill/重启 8081/8082（PID 2102695 未动）；未改线上 `web/dist`；未 `git add/commit/stash`；DB 仅执行 **SELECT**（见 `db-readonly.txt`）；无崩溃、无 core dump（`pageErrors` 全空）

## 文件清单

| 文件 | 说明 |
|---|---|
| `kc-spy.ts` | klinecharts 模块 spy（临时 vite alias 生效）：暴露 `window.__CHARTS__` / `__KC_INITS__` / `__KC_LOG__`，包裹 `createIndicator/removeIndicator/overrideIndicator/setPaneOptions/setDataLoader/setSymbol/setPeriod/setStyles`（记录调用序列 + 每次调用前后 pane 快照 + 调用栈指纹） |
| `vite.diag.config.ts` | 临时构建/预览配置（outDir=/tmp/diag51/dist，preview 18085 + 代理到 8081） |
| `probe1.mjs` / `probe1.json` | 首轮探针（25 checks）；暴露两处探针缺陷：pane「高度」误用 `getPaneOptions().height`（弹性 pane 是拖拽残值，≠ 渲染高度）、warmup 参数误选 `n_m`（warmup 只由 `n_l`/`m` 决定） |
| `probe2.mjs` / `probe2.json` | 修订探针（31 checks）；改用 DOM 渲染高度判据、warmup 改 `m`、补机制微测；两处探针 bug：Y 轴量程误读 `axis.from/to`（accessor ⇒ null）、M2 断言写死了 VOL>200 |
| `probe3.mjs` / `probe3.json` | **最终探针（34 checks，33 绿；唯一红 = B4 的日志窗口截断，非被测行为）**：A（DCAP 关）/B（remount）/C（DCAP 开）/M（手工作坊机制）/E（override 能力）全场景 + 截图 |
| `probe4.mjs` / `probe4.json` | 备选修法取证：`chart.resetData()` 是否保布局、是否扰视口、是否重新取数 |
| `probe5.mjs` / `probe5.json` | 路径 B 的**全量调用序列**（probe3 的 `logTail` 只留 30 条，`setDataLoader` 落在窗口外；本条补全） |
| `A1-dragged-dcap-off.png` / `A2-after-save-dcap-off.png` | 缺陷复现截图（DCAP 关：拖高 VOL → 保存 r_s → VOL 被重置） |
| `B2-dragged-dcap-on.png` / `B3-after-save-m-remount.png` | 路径 B 截图（DCAP 开：拖高 → 保存 m → 整图 remount、布局全回默认） |
| `C1-dragged-dcap-on.png` / `C2-after-save-rm.png` | 路径 A 截图（DCAP 开：拖高 → 保存 r_m → pane 销毁重建） |
| `M1-dragged.png` / `M2-after-manual-churn.png` | 机制微测截图（手工 remove+create ⇒ 高度打回默认） |
| `E1-before-override.png` / `E2-after-override.png` | `overrideIndicator` 前后截图（高度/面板不变，线值与 Y 轴量程变） |
| `fix-candidates/KlineChart.fixed.v1-getIndicators.tsx` | 候选修复 v1（用 `chart.getIndicators` 判在场）——**副作用面证据：44 条既有测试红**（测试桩无 `getIndicators`） |
| `fix-candidates/KlineChart.fixed.v3-ref-state.tsx` + `fix-v3.diff` | 候选修复 v3（已应用状态由组件 ref 持有 + 参数变化走 `overrideIndicator`）——沙箱副本，**未改仓库产品代码** |
| `fix-candidates/green.test.v3.tsx` + `vitest.v3.config.mjs` | 用 v3 复跑新增红测试（变绿）+ 既有 3 个测试文件（仅 2 条红，均为旧 churn 断言） |
| `fix-candidates/sandbox-fix-runs.txt` | 上述两组沙箱复跑原始输出 |
| `red-test-run.txt` | 新增红测试定向运行 + 全量前端测试 + `tsc -b` 原始输出 |
| `db-readonly.txt` | 只读 SELECT 全记录（`app_config` schema + `key='dcap'` 的 value/updated_at + 复查） |

## 复跑要点（全部在临时端口；先建后拆）

```bash
# 1) 构建 + 起预览（18085 → 只读代理 8081）
cd web && NODE_PATH=$PWD/node_modules npx vite build --config /tmp/diag51/vite.diag.config.ts
cd web && NODE_PATH=$PWD/node_modules npx vite preview --config /tmp/diag51/vite.diag.config.ts &
# 2) 探针（BASE 默认 http://127.0.0.1:18085；OUT 默认 /tmp/diag51）
cd web && node /tmp/diag51/probe3.mjs           # 主探针（A/B/C/M/E）
cd web && node /tmp/diag51/probe4.mjs           # resetData 备选修法
cd web && node /tmp/diag51/probe5.mjs           # 路径 B 全量序列
# 3) 红测试
cd web && npx vitest run src/features/dashboard/KlineChartDcapSaveLayout.test.tsx   # 期望 1 failed | 1 passed
# 4) 候选修复沙箱复跑（副本落在 web/node_modules/.diag51/，node_modules 被 gitignore）
#    （见 fix-candidates/vitest.v3.config.mjs；跑完删除 web/node_modules/.diag51/）
```

## 关键原始数字（摘自 probe3.json）

- A（DCAP 关，保存 r_s 1→1.2）：渲染高度 `{MA:460, VOL:237}` → `{MA:597, VOL:100}`；VOL pane id 更换；`__KC_INITS__ 1→1`
- B（DCAP 开，保存 m 3→5 ⇒ warmup 62→64）：`{MA:359,VOL:145,DCAP:192}` → `{MA:496,VOL:100,DCAP:100}`；`__KC_INITS__ 2→3`；全部 pane id 更换
- C（DCAP 开，保存 r_m 1→1.5 ⇒ warmup 不变）：`{MA:359,VOL:145,DCAP:192}` → `{MA:496,VOL:100,DCAP:100}`；`__KC_INITS__ 3→3`
- E：`overrideIndicator` 后 6 条 pane 渲染高度逐值相等、pane id 不变、DCAP/s/m/l/zero 值变、Y 轴量程 `[-0.02116329, 0.02402008] → [-0.02245367, 0.02524694]`、无 `init`、无新 `/api/kline` 请求
- 本车道发出的非 GET 请求：`PUT /api/config/dcap` 共 **10 条**（probe1 3 + probe2 3 + probe3 3 + probe5 1，**全部由 Playwright 本地兑现**，未发往后端/DB；请求体逐条见各 `probe*.json` 的 `putIntercepted` / `puts`，无一条含 `r_l:1.02`）、`nonGetOther` = **0 条**（全部 probe 均为空数组）
