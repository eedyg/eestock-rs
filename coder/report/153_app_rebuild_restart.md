# 153 — 重新构建 + 重启本机应用（8081/8082）使 ADR-020 生效

- **Report location (self)**: `/home/eestock/workspace/git/eestock/eestock-rs/coder/report/153_app_rebuild_restart.md`
- **Task type**: build / restart / smoke（**非编码**，未改动任何源码或 design 文档）
- **Date**: 2026-09-13
- **工作目录**: `/home/eestock/workspace/git/eestock/eestock-rs`
- **结论**: ✅ 全部通过 — 新后端 + 新前端已生效，ADR-020（`viewport_bars`，零兼容）实测成立，无遗留问题。

---

## 0. 环境与基线（重启前）

| 项 | 值 |
|---|---|
| 旧应用 PID | `3923774`（另有上次部署遗留的 nohup 包装 shell `3923709`） |
| 端口 | `0.0.0.0:8081`(app) / `0.0.0.0:8082`(mcp)，均由 pid=3923774 监听 |
| 旧 `GET /api/config/kline` | `{"viewport_days":2}` |
| 旧 bundle | `index-csVFM0jP.js` |

### 步骤 1 — 盘点与安全检查

```text
$ git status --short | grep -v '^??' | wc -l
31                      # 工作区 31 个已改文件仍在（含本轮 ADR-020 改动）

$ ps -eo pid,cmd | grep '[e]estock-app --config /tmp/app_dev_8081'
3923774 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml

$ ss -lntp | grep -E ':8081|:8082'
LISTEN 0 128 0.0.0.0:8081 ... users:(("eestock-app",pid=3923774,fd=11))
LISTEN 0 128 0.0.0.0:8082 ... users:(("eestock-app",pid=3923774,fd=12))
```

Sim-live 停机窗口检查（**kill 前**）：

```text
$ curl -s http://127.0.0.1:8081/api/sim-live/sessions | python3 -c "..."
statuses: ['ended']
non-ended: []
```

→ 无运行态会话，安全停机。

---

## 2. 前端构建

```text
$ cd web && npm run build:prod | tail
> VITE_API_MOCK=0 vite build
✓ 168 modules transformed.
dist/index.html                   0.40 kB
dist/assets/index-Cm6bbPuq.css   22.01 kB
dist/assets/index-D6ir823G.js  1,169.13 kB │ gzip: 360.62 kB
✓ built in 1.74s
```

**bundle 哈希变化**：`index-csVFM0jP.js` → `index-D6ir823G.js` ✅

类型检查（`build:prod` 不走 tsc，单独跑）：

```text
$ npx tsc -b 2>&1 | tail
(无输出)  exit=0
```

→ 类型检查**全绿，无既有错误**。

新 bundle 内容自检（本地 dist）：

```text
grep -c 'viewport_bars'  dist/assets/index-D6ir823G.js → 2
grep -c 'data-viewport-fit' dist/assets/index-D6ir823G.js → 1
grep -c 'viewport_days'  dist/assets/index-D6ir823G.js → 0   # 零兼容
```

---

## 3. 后端构建

```text
$ cargo build -p app | tail
   Compiling web v0.1.0 (...)
   Compiling app v0.1.0 (...)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.12s
cargo exit=0
```

二进制：`target/debug/eestock-app`（205,347,024 bytes，mtime `Sep 13 13:15`）— debug，与现网启动口径一致。

---

## 4. 重启

沿用宿主机既有范式（**未使用** `deploy.sh` / `--force`）：

```text
新日志：logs/app_dev_8081_redeploy_20260913_131556.log
old pid=3923774
旧进程已退出                     # kill 后 3s 内确认退出，ps -p 无输出
=== 新进程 ===
新应用 PID = 1299663  Sun Sep 13 13:15:58 2026
=== ss 8081/8082 ===
LISTEN 0 128 0.0.0.0:8081 ... pid=1299663
LISTEN 0 128 0.0.0.0:8082 ... pid=1299663
```

- **新 PID = 1299663**（权威 PID：`ss -lntp | grep ':8081'`）。pid `1299572` 是本轮 `nohup` 包装 shell（与上次遗留的 3923709 同性质，非应用进程）。
- 启动日志无 ERROR / WARN（各 0 条），关键行：

```text
"eestock-app starting" config=/tmp/app_dev_8081.toml
"schema self-check ok"
"strategy registry 启动播种完成" seeded=0 skipped=0
"sim-live 启动恢复完成" recovered=0 degraded=0
"eestock-app serving" listen=0.0.0.0:8081 static_dir=./web/dist
"mcp server (HTTP/SSE) serving" listen=0.0.0.0:8082
```

---

## 5. 冒烟结果（期望 vs 实际）

| # | 检查 | 命令（要点） | 期望 | 实际 | 结果 |
|---|---|---|---|---|---|
| 1 | 健康 | `GET /healthz` | `{"status":"ok"}` | `{"status":"ok"}` | ✅ |
| 2 | 新口径 | `GET /api/config/kline` | `{"viewport_bars":120}` 且无 `viewport_days` | `{"viewport_bars":120}` | ✅ |
| 3 | 可写 | `PUT {"viewport_bars":200}` | 200 回显 200 | `{"viewport_bars":200}` HTTP=200 | ✅ |
| 4 | 落库 | `GET` 复核 | `{"viewport_bars":200}` | `{"viewport_bars":200}` | ✅ |
| 5 | 下界 | `PUT {"viewport_bars":29}` | 400 | HTTP=400 | ✅ |
| 6 | 上界 | `PUT {"viewport_bars":601}` | 400 | HTTP=400 | ✅ |
| 7 | 零兼容 | `PUT {"viewport_days":8}` | 400 | HTTP=400 | ✅ |
| 8 | 复位 | `PUT {"viewport_bars":120}` | 200 | `{"viewport_bars":120}` HTTP=200 | ✅ |
| 9 | 复位复核 | `GET` | 120 | `{"viewport_bars":120}` | ✅ |
| 10 | 业务冒烟 | `GET /api/symbols \| head -c 200` | JSON 标的列表 | `[{"code":"518880","name":"华安黄金易ETF",...}]` | ✅ |
| 11 | SPA 生效 | `GET /` bundle | `index-D6ir823G.js`（≠旧哈希） | `index-D6ir823G.js` | ✅ |
| 12 | 新前端被服务 | `GET /assets/index-D6ir823G.js` | 含 `viewport_bars`、`data-viewport-fit` | HTTP=200；`viewport_bars`×2、`data-viewport-fit`×1 | ✅ |
| 13 | 资产一致性 | sha256(served) vs sha256(dist) | 相同 | `00f93360…007d8e` == `00f93360…007d8e` | ✅ |

原始输出片段：

```text
$ curl -s http://127.0.0.1:8081/api/config/kline
{"viewport_bars":120}
$ curl -s -X PUT -d '{"viewport_bars":200}' .../api/config/kline
{"viewport_bars":200}   HTTP=200
$ curl -s -o /dev/null -w '%{http_code}' -X PUT -d '{"viewport_bars":29}'  ... → 400
$ curl -s -o /dev/null -w '%{http_code}' -X PUT -d '{"viewport_bars":601}' ... → 400
$ curl -s -o /dev/null -w '%{http_code}' -X PUT -d '{"viewport_days":8}'   ... → 400
$ curl -s -X PUT -d '{"viewport_bars":120}' ... → {"viewport_bars":120}  HTTP=200
$ curl -s http://127.0.0.1:8081/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
index-D6ir823G.js
```

---

## 6. 归档 / 遗留

- **新 PID**：1299663
- **新 bundle 哈希**：`index-D6ir823G.js`（served == dist，sha256 `00f93360…`）
- **`/api/config/kline` 实测返回体**：`{"viewport_bars":120}`（默认已复位）
- **部署日志**：`logs/app_dev_8081_redeploy_20260913_131556.log`
- **未做**：`git add` / `commit` / `push`（本任务明令禁止）；未改任何源码/design 文档；未触碰 `data`/`timescaledb` 容器。
- **残留观察（非阻塞）**：`nohup` 包装 shell（1299572，及上次遗留 3923709）会残留在 `ps | grep 'eestock-app --config'` 输出中，可能干扰后续“取 PID”。建议后续一律用 `ss -lntp | grep ':8081'` 取权威 PID，或 `pgrep -f 'target/debug/eestock-app --config'`。
- **未验证项**：无。

---

## 提示

本文件为构建/重启证据报告；未修改工作区代码，故 `git status` 改动文件数仍为 31（与执行前一致）。
