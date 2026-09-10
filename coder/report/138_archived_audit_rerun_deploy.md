# 138 — 归档审计重跑功能上线 轻量重部署（dev 8081/8082）

- 时间：2026-09-10 23:51 (+08)
- HEAD：**1ecbd9b** `feat(workbench): 归档策略版本允许审计重跑（todo #11）`（功能实现与测试证据见 `coder/report/137_workbench_submit_archived_audit_rerun.md`）
- 报告文件：`coder/report/138_archived_audit_rerun_deploy.md`（本文件自身路径）
- 源码改动：**无**（任务约束：不改源码；`git status --porcelain --untracked-files=no` 无任何已跟踪文件修改）
- 部署惯例参照：`coder/report/132_guide_update_redeploy.md`

## 1. 构建

- `cargo build --bin eestock-app`（debug）→ `Finished dev profile in 0.06s`（二进制已随 HEAD 构建完成，无需重编译）。
- 二进制：`target/debug/eestock-app` Sep 10 23:40（204,020,600 bytes），对应 1ecbd9b 源码。

## 2. PID 切换

| 项 | 旧 | 新 |
|---|---|---|
| PID | 2462984（19:35 启动；`/proc/PID/exe` 显示 `(deleted)`，即 1ecbd9b 之前时代二进制） | **2877130**（ss 确认 8081/8082 持有者；nohup 壳 PID 2877128） |
| 端口 | 8081/8082（host `target/debug/eestock-app --config /tmp/app_dev_8081.toml`） | 同配置同端口 |
| 切换方式 | `kill 2462984`（SIGTERM，2s 后 ss 确认 8081/8082 无持有者，PORTS_RELEASED） | `RUST_LOG=info nohup target/debug/eestock-app --config /tmp/app_dev_8081.toml > logs/app_1ecbd9b_up.log 2>&1 &` |
| 运行日志 | （旧进程日志保留） | **logs/app_1ecbd9b_up.log** |

注：127.0.0.1:18081/18082 上的 PID 1858479 是另一实例（非本次目标），未触碰。

启动日志关键行（冒烟全程 0 条 ERROR/WARN）：
- `schema self-check ok`
- `strategy registry 启动播种完成 seeded=0 skipped=0`
- `eestock-app serving listen=0.0.0.0:8081 static_dir=./web/dist`
- `mcp server (HTTP/SSE) serving listen=0.0.0.0:8082`

## 3. 冒烟验证证据（全部通过）

### a. GET /api/strategies → 200，全 published，已归档策略不出现 ✅
- HTTP 200；12 条（11 播种 + wb2843451cxl-trend），version.status 集合 = `{published}`。
- 归档泄漏检查：库内 9 个已归档策略（T0做T-ORB、T0做T·主张段、基线买入持有、主涨段捕获×4、主涨段检验×2）的 strategy_id 均未出现在响应中（archived leaked: NONE）——含最近归档的「主涨段检验」两条。

### b. 已归档版本 sv_1789046242243_000120（主涨段捕获·Donchian(20/15)）审计重跑 → 201 + archived:true → succeeded ✅
- `POST /api/workbench/runs`：symbol=510050，period=D1，from=2025-09-08T16:00:00Z，to=2026-09-09T00:00:00Z（近1年，510050 D1 数据覆盖 2019-12-30 起，窗口内数据齐），fee ETF 口径 `{rate_pct:0.005, min_fee:0.0, slippage_bp:2.0, stamp_duty_pct:0.0}`。
- **HTTP 201**；run id `sr_1789055513552_000000`；响应 config 快照 `slots[0].archived=true`、`version_id` 钉住、Donchian 默认参数（brk_n=20/exit_n=15）快照在案；fee 快照 stamp_duty_pct=0.0。
- 轮询 `GET /api/workbench/runs/sr_1789055513552_000000` → 第 1 次轮询即 **succeeded**（error=null）；详情同样返回 `archived:true` 审计标记。
- 对照旧口径：137 之前 archived 版本 submit 会 400「仅 published 版本可运行」，现按裁决放行并打审计标记——新二进制行为生效。

### c. draft 版本提交 → 400（draft 拒绝口径）✅
- 库内原无 draft 版本，经 API 创建（数据面操作，非源码改动）：`POST /api/strategies/st_1789046242243_000119/versions {"from_version_id":"sv_1789046242243_000120"}` → 201，draft `sv_1789055556607_000001`（v2）。
- 用该 draft 提交同一 run 体 → **HTTP 400**，错误文案精确：`策略版本 sv_1789055556607_000001 未发布（status=draft），draft 版本不可运行（published/archived 版本可运行）`。

### d. GET /api/workbench/runs → 200 ✅
- HTTP 200；返回 100 条（分页上限），首条即本次冒烟 run `sr_1789055513552_000000 smoke-archived-audit-rerun-donchian succeeded`，历史 run 数据面无损。

## 4. 残留风险与回滚

- 回滚：`kill 2877130` 后用 1ecbd9b 之前时代二进制重启（需检出旧 commit 重编译）。
- 冒烟副产物（数据面，非源码）：draft 版本 `sv_1789055556607_000001` 与 run `sr_1789055513552_000000` 留存库中，可留作审计重跑活样本；如需清理走删除 API。
- debug 二进制性能低于 release，dev 环境可接受（沿袭 132 惯例）。
- 无源码改动；git 无已跟踪文件修改，无暂存（staged）文件。本报告及 logs/ 为未跟踪文件。
