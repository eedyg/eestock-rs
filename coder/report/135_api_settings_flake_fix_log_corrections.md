# 135 · api_settings 间歇 flake 根治 + 主涨段实验日志记录修正

> 本报告位置：`coder/report/135_api_settings_flake_fix_log_corrections.md`

## 任务 1：api_settings::config_snapshots_return_readonly_defaults 间歇失败根治

### 根因（证据链）

1. **唯一写入方取证**：grep 全仓 `trading_tools` / `config/mcp` / `app_config` 写入方，确认把
   `trading_tools_enabled` 置 `true` 的只有**同 binary** 的
   `config_patch_persists_get_reads_back_and_validates`（crates/web/tests/api_settings.rs PATCH 合法 mcp 用例）。
   tester 推测的 api_strategies / api_workbench / mcp 工具测试均**不写** mcp 键（grep 零命中）。
2. **竞态机制**：`cargo test` 同一 binary 内测试默认多线程并行。snapshot 测试时序为
   「`DELETE FROM app_config` → spawn server → GET /api/config/mcp 读默认」；
   patch 测试在中间窗口写入 `trading_tools_enabled=true` → snapshot 读到 `true`（line 123 断言期望 false）。
   单独跑 DB 延迟低、窗口窄（3/3 通过）；全量 workspace 跑并行 binary 争用同一 dev 库、窗口拉宽（≈1/3 失败率）。
3. **压测复现**：4 实例并行 × 10 批共 40 跑 **25 败**，失败形态含 line 123 原样失败
   （`trading_tools_enabled` 期望 false 拿到 true）、line 116/195/246（patch 与 snapshot 互踩）、
   line 274/282（kline 测试的 kline 键被全表 DELETE 抹掉）。

### 修复方案（测试代码内，零新依赖，未削弱任何断言）

选用 **(c) binary 内串行 + (a) 测试自理强化** 组合，未引入 `serial_test` 新依赖（用已有 tokio 实现同等语义）：

- `static CONFIG_LOCK: OnceLock<tokio::sync::Mutex<()>>`：三个读写 app_config 的测试
  （snapshot / patch / kline）进入时 `lock().await`，binary 内互斥 → 竞态窗口确定性关闭。
  跨 binary 无其他测试写 sources/collector/mcp 键（grep 全仓确认），故 binary 内互斥即根治。
- `clear_config` 由 `DELETE FROM app_config`（全表）改为只删 `sources/collector/mcp` 三键：
  消除对 kline 键（同 binary kline 测试）与其他 binary/部署实例键（storage config_store 测试独立键）的误删，
  对共享 dev 库更鲁棒。
- 不选方案 (b)（独立 schema/命名空间）：端点读固定键，命名空间需改应用层代码，属架构变更且收益不增。

### 连带发现（验收阻塞项，父级裁决后根治）

10 连跑第 4 跑起 `storage::alert_store::list_events_filters` 持续失败（left 2 right 3）：
共享 dev 库有**两个运行中的 eestock-app 实例**（pid 1858479/2462984）持续写真实告警事件
（alert_events 222 行、193 行新于测试固定 t0=2026-09-07），该测试先 `limit:200` 截断再内存按 source 过滤，
测试事件被实时事件挤出窗口（TD-2 修复遗漏模式：当时只加了 source 过滤，未处理 LIMIT 先截断）。
父级裁决做根治 (c)：测试改为按唯一 source 标记分别查询（source 过滤本就在 SQL WHERE、LIMIT 之前，
见 storage/src/alerts.rs:136-149）再合并排序，窗口/排序语义不削弱。
按 tangle 纪律改 `design/07-app-plane/02-alerts.md` 源块后 `entangled tangle` 重新生成 .rs。

### 验证（10 连跑记录）

| 证据 | 结果 |
|---|---|
| 修复前压测 | 4 实例并行 40 跑 25 败（含 line 123 原样失败） |
| 修复后单 binary 串行 30 连跑 | 0 败 |
| `cargo test --workspace --no-fail-fast` 连跑 | **10/10 全绿**（每跑 86 套件全 ok；日志 /tmp/final_run1..10.log） |
| clippy lint 修复后追加连跑 | 3/3 全绿（合计 13 连绿） |
| `cargo clippy --workspace --all-targets` | 0 warning |
| `./scripts/check-tangle.sh` | ✅ tangle 后无 diff |
| `web npm test` | 45 文件 447 测试全过 |

## 任务 2：实验日志/报告记录修正（结论不变）

文件：`coder/wave_strategy/experiment_log.md` + `coder/report/134_main_wave_capture_strategy.md`

1. H1 表 wave_donchian −1.7% → **−1.4%**（eng_b2 八标的算术均值 −1.45% 四舍五入口径，已注明原记有误）；
   报告「全过滤版（−1.7%）」同步改 −1.4%。
2. H1 表 wave_fused −0.1% → **+0.7%**（b2 均值 +0.69%），并注明淘汰依据实为交易频率形态
   （70~124 笔 / avg hold 2.6~4.6 bar）而非均值方向。
3. 「约 1000 个快照」→ **runs/ 实际 586 个 .json、约 590 个量级**（实测 coder/wave_strategy/ 共 608 文件含脚本）。
4. 「假突破过滤 7 条清单逐条消融后全部弃用」→ 如实改写：量比①/Regime+ADX③/挤压④/回踩⑥ 共 5 项逐条消融后弃用；
   第 2 条（收盘站稳）与第 5 条（板块/市场共振）未独立消融；第 7 条为回测纪律已采纳。
5. NIT-1：日志与报告冻结表**路径B OOS 全部标的补 ⚠**（均 <30 笔，与路径A 同规）。
6. NIT-2：回撤均值注明「**8 标的等权算术平均**」口径（日志脚注 + 报告脚注与结论段）。
7. MINOR-3：日志 §0 补「迷你引擎存在理由与证据缺口」行（~50 组假设迭代速度、终审 16 run 全在平台执行；
   校验产物未落盘的证据缺口如实声明）。

## 变更清单

| 文件 | 变更 |
|---|---|
| crates/web/tests/api_settings.rs | +CONFIG_LOCK 互斥；clear_config 改删三键；3 测试加 guard |
| design/07-app-plane/02-alerts.md | list_events_filters 源块改 source 下推查询（tangle 事实源） |
| crates/storage/tests/alert_store.rs | 由 entangled tangle 重新生成 |
| coder/wave_strategy/experiment_log.md | 7 项记录修正 |
| coder/report/134_main_wave_capture_strategy.md | 同步修正（−1.4% / 快照数 / B 列 ⚠ / 回撤口径） |

全部已 `git add`（未 commit）。残余风险：若未来新增其他写 sources/collector/mcp 键的测试 binary，
需同样遵守「不写这三键或同 binary 互斥」纪律（已在 clear_config 注释中记录该不变量）。
