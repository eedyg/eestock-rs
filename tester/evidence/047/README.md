# 证据目录 047 — 问题①「K线 与 VOL 之间多出一条分割线」诊断取证

- 关联报告（执行/诊断）：`tester/test/047_issue1_stray_separator_diagnosis_execution.md`
- 关联报告（测试设计）：`tester/design/014_issue1_pane_separator_red_test_design.md`
- 关联红测试：`web/e2e/dashboard-pane-separator.e2e.ts`

## 沙箱 harness（真实 10.0.3 + 真实骨架 + 真实 KlineChart；全部在 /tmp 运行，不进产品代码）

| 文件 | 说明 |
|---|---|
| `kc-spy.ts` | klinecharts 模块 spy（esbuild `--alias:klinecharts=...`）：抓住 init() 的 Chart 实例 + 记录 createIndicator/removeIndicator/setPaneOptions 调用序列与 pane 列表前后快照 |
| `entry2.tsx` | 真实渲染入口：import 仓库**真实** `src/layouts/DashboardGrid.tsx`（tangle 产物）+ 真实 `KlineChart.tsx`；注入**线上 8081 当前构建 CSS**；变体 `dcap`（线上）/`never`（DCAP 从不注册、从不创建） |
| `run2.mjs` | 驱动：esbuild 打包 → Playwright chromium 渲染 → 按状态序列取 pane 列表/分割线计数与几何 → `out2-<variant>.json` |
| `live-initial.mjs` | 线上 8081 **零交互只读**探针（只 GET；非 GET 一律 abort）+ 截图 `live-initial.png` |
| `live-probe.mjs` | 线上 8081 只读探针 + 用户场景复现（拖第一条分隔线向上 120px；点 DCAP 开关——纯前端状态） |

复跑：
```bash
mkdir -p /tmp/dcap_sep01 && cd /tmp/dcap_sep01
ln -sfn /home/eestock/workspace/git/eestock/eestock-rs/web/node_modules node_modules
cp <本目录>/{kc-spy.ts,entry2.tsx,run2.mjs} . && cp <本目录>/live-8081-index-Cm6bbPuq.css /tmp/live.css
node run2.mjs dcap && node run2.mjs never
node live-initial.mjs      # 需要 8081 在跑（只读）
```

## 原始结果

| 文件 | 说明 |
|---|---|
| `out2-dcap.json` / `out2-never.json` | 沙箱 12 状态序列（pane 列表、配置高度、DOM 实测几何、分割线计数、全宽水平线清单、调用序列） |
| `live-initial.json` | 线上 8081 初始态（DCAP 关）探针结果 + 请求方法集合（仅 GET） |
| `live-8081-probe.json` | 线上 8081 拖高 VOL 后 / 点 DCAP 后探针结果 |
| `live-8081-index-Cm6bbPuq.css` | 线上 8081 当前构建的 CSS（含 `.border-t{border-top-width:1px}` 与 preflight `border-color:#e5e7eb`） |
| `live-initial.png` / `crop-initial-lines.png` / `crop-initial-subanchor.png` | 线上截图（初始态）与线附近裁剪；像素扫描：y=735→`rgb(229,231,235)`、y=773→`rgb(221,221,221)` |
| `shot2-never.png` | 沙箱（真实骨架 + 真实 CSS + DCAP 从不创建）整页渲染截图 |
