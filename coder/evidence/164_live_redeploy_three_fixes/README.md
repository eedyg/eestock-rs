# 证据目录 164 — 重建前端并重启 8081/8082，上线三处前端修复（运维车道）

- 执行报告（coder 车道）：`coder/report/164_app_rebuild_restart_three_fixes.md`（本目录的结论来源）
- 仓库根 `/home/eestock/workspace/git/eestock/eestock-rs`；HEAD `6391a4d`；时间窗 2026-09-14 10:00 ~ 10:07 (+0800)
- 上线内容：`181c35a`（① 分割线+0 线）+ `7949c0b`（② 保存参数不重建 pane）+ `5d8eff4`（③ 切 period/stock 不重置布局）—— **纯前端**
- 旧 PID `2102695` → 新 PID **`2948632`**（同进程持 8081 + 8082）；后端 cargo 空跑（二进制 sha 未变 `8eb98376…`）

## 文件清单

| 文件 | 说明 |
|---|---|
| `01_form_gate_rollback.txt` | 形态确认（ss/cwd/cmdline/exe sha）+ sim-live 门禁 + 回滚件 |
| `02b_simlive_pre.json` | 停机前 `/api/sim-live/sessions` 原始 JSON（12 条全 ended） |
| `04_config_baseline.txt` | 三份配置 PRE/POST 与架构师基线逐字节比对（PASS）+ 取证后 Node 直连复读 |
| `05_frontend_build.txt` | `npx tsc -b`（exit 0）+ `npm run build:prod`（exit 0）+ BEFORE/AFTER dist 哈希 + bundle 内修复痕迹 |
| `05a_tsc_b.log` / `05b_build_prod.log` | 上述两条命令原始日志 |
| `06_backend_build.txt` | `cargo build -p app` 空跑（0.13s，sha 未变） |
| `07_restart.txt` | kill → sleep 3 → 仓库根 nohup 启动 + 新进程属性 + 启动日志全文（0 ERROR / 0 WARN） |
| `08_smoke.txt` | 冒烟 9 项逐项原始输出（healthz / 三份 config / symbols / kline / bundle 引用 / served-vs-dist cmp / ERROR 计数） |
| `09_closing_state.txt` | 收尾状态（PID/cwd/cmdline/sha、sim-live、git 暂存区为空、未触碰范围） |
| `live-render/` | 三处修复的线上只读取证：探针脚本 + 65/65 原始 JSON/日志 + 截图 + 既有 e2e 对线上 8081 的日志 + 关键数值 README |

## 纪律小结

- **零线上写请求**：`PUT /api/config/dcap` ×2 由 Playwright route 在**浏览器侧本地兑现**（记录 body、绝不转发）；`nonGetOther=[]`、`pageErrors=[]`；取证结束后 Node 直连复读配置仍与基线逐字节一致。
- 未 `git add/commit/stash`；未用 `scripts/deploy.sh`；未碰 8080/5433；除旧 PID 2102695 外未 kill 任何服务。
- 本轮未新建临时端口实例（取证直接对线上 8081 只读）⇒ 无临时实例需拆除。
