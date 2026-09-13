# 证据目录 048 — 问题①/② 独立验收（阶段 3 补跑，真实渲染）

- 关联报告（执行）：`tester/test/048_issue1_issue2_acceptance_execution.md`
- 关联报告（设计）：`tester/design/015_issue1_issue2_acceptance_design.md`
- 被测 commit：`5a016cdb2cd593301ae517c65b70400cb58a2f14`（工作树含本轮 6 处 tracked 改动）

## harness（全部只在 /tmp 跑；仓库内未跑 tangle、未改产品代码）

| 文件 | 说明 |
|---|---|
| `kc-spy.ts` | klinecharts 模块 spy（临时 vite `resolve.alias` 生效）：`export *` 真身 + 包 `init`，把 Chart 实例记到 `window.__CHARTS__`（组件不暴露 chartRef、库不导出 getChart） |
| `vite.accept.config.ts` | 临时构建：root=仓库 `web/`，alias `klinecharts`→spy，产物 `/tmp/accept/dist` |
| `vite.nozero.config.ts` + `dcapIndicator-nozero.ts` | 反向证据变体：alias `@/features/indicators/dcapIndicator`→去掉 `zero` figure 的 /tmp 副本，产物 `/tmp/accept/dist-nozero` |
| `accept_issue1.mjs` | 问题① 自建 18 条断言（锚点/分隔线来源/pane 列表/拖高 VOL/DCAP 开关/反向注入） |
| `accept_issue2.mjs` | 问题② 自建 18 条断言（figKeys/precision/两形态/数据不足/像素可见/DCAP 关态），`EXPECT=nozero` 做反向 |
| `app_accept.toml` / `app_nozero.toml` | 两个临时 `eestock-app` 实例配置（同 DB；`alert_eval_ms=3600000`；端口 18081/18091、18083/18093） |
| `crop.mjs` / `probe2b.mjs` / `probe4.mjs` / `probe5.mjs` / `recon.mjs` | 侦察与 0 线像素裁剪 |

## 原始结果

| 文件 | 说明 |
|---|---|
| `issue1-results.json` | 问题① 18 条断言逐条 ok/detail + 5 个状态（默认/拖后/DCAP 开/关/反向注入）的 pane 列表、分隔线、stray、锚点 |
| `issue2-results-real.json` | 问题② 真实构建 18/18 通过；含每形态 dataMin/Max、Y 轴范围、y0/yAxisY0、`#76808F` 像素计数与虚线 x 间距 |
| `issue2-results-nozero.json` | 反向变体：figKeys 掉 `zero`、像素计数全 0、5 条断言红 |
| `issue1-default.png` / `issue1-after-drag.png` / `issue1-dcap-on.png` / `issue1-reverse-injected.png` | 问题① 截图（含反向注入后多出的那条静态线） |
| `issue2-real.png` / `issue2-all-positive.png` / `issue2-cross-zero.png` / `issue2-insufficient.png` | 问题② 四形态整页截图 |
| `crop-zero-real.png` / `crop-zero-all-positive.png` / `crop-zero-cross-zero.png` / `crop-zero-insufficient.png` / `zero-insufficient-fullpane.png` | 0 线像素裁剪（`#76808F` 虚线） |
| `recon.png` / `recon-dcap.png` | 侦察截图 |
| `sbx-tangle.log` | 独立沙箱 `entangled tangle -f` 重生成日志（exit 0） |

## 复跑要点

```bash
cd web && npx vite build --config /tmp/accept/vite.accept.config.ts
cd web && npx vite build --config /tmp/accept/vite.nozero.config.ts
./target/debug/eestock-app --config /tmp/accept/app_accept.toml &
./target/debug/eestock-app --config /tmp/accept/app_nozero.toml &
BASE=http://127.0.0.1:18081 node /tmp/accept/accept_issue1.mjs
BASE=http://127.0.0.1:18081 node /tmp/accept/accept_issue2.mjs
BASE=http://127.0.0.1:18083 EXPECT=nozero node /tmp/accept/accept_issue2.mjs
# 收尾：kill 两个临时实例，复核 18081/18083/18091/18093 释放
```
