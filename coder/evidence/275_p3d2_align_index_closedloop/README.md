# P3-D-2 真渲染自测证据（真身 klinecharts 10.0.3 + 生产 ChartSyncGroup）

复现步骤（0 外网、0 写请求；临时端口跑完即拆）：

```bash
# 1) 构建生产同步原语为 ESM（无桩、无 jsdom）
web/node_modules/.bin/esbuild web/src/features/dashboard/chartSyncGroup.ts \
  --bundle --format=esm --outfile=/tmp/p3d2-harness/chartSyncGroup.mjs
cp web/node_modules/klinecharts/dist/umd/klinecharts.min.js /tmp/p3d2-harness/
cp coder/evidence/275_p3d2_align_index_closedloop/real_render_harness.html /tmp/p3d2-harness/index.html
cp coder/evidence/275_p3d2_align_index_closedloop/real_render_driver.mjs /tmp/p3d2-harness/run.mjs
# 2) 本地静态服务（临时端口）+ playwright 驱动
cd /tmp/p3d2-harness && python3 -m http.server 18377 --bind 127.0.0.1 &
cd web && node /tmp/p3d2-harness/run.mjs        # 结果写 /tmp/p3d2-harness/out/p3d2_harness.json
```

- `p3d2_harness.json` / `harness_stdout.txt`：实测结果（`errors=[]`、非本地请求 `=[]`）。
- `real_render_dbg_trace.html` / `real_render_dbg_driver.mjs` / `dbg_call_trace.json`：follower 调用轨迹
  （用于定位「max-of-two 残差误判无改善」与取证引擎落点 = 请求索引 + 2 根）。
