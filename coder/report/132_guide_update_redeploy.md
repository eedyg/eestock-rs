# 132 — 策略手册 §4.5 更新生效 轻量重部署（dev 8081/8082）

- 时间：2026-09-10 18:53 (+08)
- HEAD：**bac9b70** `docs(strategy-guide): 手册补 §4.5 历史数据获取（边界声明+双通道+滚动窗口完整示例+bar_at 扩展备案）`
- 报告文件：`coder/report/132_guide_update_redeploy.md`（本文件自身路径）
- 源码改动：**无**（任务约束：不改源码；`git status --untracked-files=no` 无任何已跟踪文件修改）
- 部署惯例参照：`coder/report/131_strategy_delete_guide_redeploy.md`
- 背景：手册经 `include_str!` 编译期内嵌，手册内容更新必须重建二进制才能生效，故执行轻量重部署。

## 1. 构建

- `cargo build --bin eestock-app`（debug）→ 编译 mcp / web / app 三 crate，`Finished dev profile in 0.89s`。
- 二进制时间戳更新：`target/debug/eestock-app` Sep 10 18:53（204,009,176 bytes），即 include_str! 内嵌手册已随 bac9b70 重编译。

## 2. PID 切换

| 项 | 旧 | 新 |
|---|---|---|
| PID | 2326018（131 部署，HEAD 8d42fd8 时代二进制） | **2364935**（ss 确认端口持有者；nohup 壳 PID 2364933） |
| 端口 | 8081/8082（host `target/debug/eestock-app --config /tmp/app_dev_8081.toml`） | 同配置同端口 |
| 切换方式 | `kill 2326018`（SIGTERM，2s 后 ss 确认 8081/8082 无持有者，ports released） | `RUST_LOG=info nohup target/debug/eestock-app --config /tmp/app_dev_8081.toml > logs/app_bac9b70_up.log 2>&1 &` |
| 运行日志 | logs/app_8d42fd8_up.log | **logs/app_bac9b70_up.log** |

启动日志关键行（无 ERROR/WARN）：
- `schema self-check ok`
- `strategy registry 启动播种完成 seeded=0 skipped=0`（11 条播种策略已在库，幂等跳过）
- `eestock-app serving listen=0.0.0.0:8081 static_dir=./web/dist`
- `mcp server (HTTP/SSE) serving listen=0.0.0.0:8082`

## 3. 冒烟验证证据（全部通过）

### a. GET /api/strategies/guide 含「4.5 历史数据的获取」与「bar_at」✅
- 响应体 9,821 bytes。
- `grep -c '4.5 历史数据的获取'` → **1**；`grep -c 'bar_at'` → **1**（扩展备案段）。
- §4.5 正文确认：「插件拿不到原始历史 bar 数组——`ctx.bar` 只有当前这一根」+ 通道 1 指标（首选）+ 通道 2 自持滚动窗口。
- 对比 131 时期手册无此章节，证明新二进制内嵌手册已更新生效。

### b. GET /api/strategies → 200，11 条 ✅
- HTTP 200；JSON 数组长度 11（7 策略 + 4 模板，与 131 冒烟一致）。

### c. GET /api/workbench/runs → 200 ✅
- HTTP 200；返回历史 run `sr_1789013905608_000022`（smoke-ensemble-2strat，516380 D1，status=succeeded），数据面无损。

## 4. 残留风险与回滚

- 回滚：`kill 2364935` 后用 8d42fd8 时代二进制重启（需 `git stash`-free 环境检出旧 commit 重编译，或用 131 前备份）。旧进程日志 logs/app_8d42fd8_up.log 保留。
- debug 二进制性能低于 release，dev 环境可接受（沿袭 128/131 惯例）。
- 无源码改动；git 无已跟踪文件修改，无暂存（staged）文件。本报告及 logs/ 为未跟踪文件。
