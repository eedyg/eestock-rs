# Coder 报告 005：Wave 0 验收缺陷修复（HalfOpen 探测自愈 + tushare checkpoint 语义 + 三时点调度）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/005_wave0_defect_fix.md`
> 依据：tester/report/004_wave0_acceptance.md（缺陷 1/2，复现步骤与证据）+ 父级批准的两个修复方向
> 追加需求（用户决策 2026-09-03，mid-run steering）：tushare 日增量 15:30 单触发 → **18:00 / 00:00 / 08:00 CST 三时点**
> 工作方式：TDD（Red→Green→Refactor）+ 文学式单向 tangle（design/ 为事实源）+ 只 stage 不 commit

## 1. 改动清单（git diff --cached --stat：15 文件，+1062/−100）

| 文件 | 变更 | 层 |
|---|---|---|
| design/03-collector/00-design.md | §4 探测规格落码文字 + §8 TDD 要点 + §9.10 CircuitProber 新节 + §9.11 测试节（原 9.10 顺延）+ circuit/service/lib 生成块 | 事实源 |
| design/03-collector/02-data-plane.md | eestock-data 装配接线 prober + 注释口径 | 事实源 |
| design/04-storage/02-tushare-sync.md | §6.1 checkpoint 语义修正 + §6.2 三时点调度 + sync/daily/bin/测试生成块 | 事实源 |
| design/99-decisions-log.md | 追加调度变更决策记录（第 5 条） | 事实源 |
| crates/collector/src/probe.rs | **新增** CircuitProber（104 行） | 应用层（collector） |
| crates/collector/src/circuit.rs | +`halfopen_sources()`（17 行，inherent 方法，不动 domain HealthMonitor trait） | 应用层 |
| crates/collector/src/service.rs | prober 字段 + run() spawn 探测循环 | 应用层装配 |
| crates/collector/src/lib.rs | +`pub mod probe;` | — |
| crates/collector/tests/probe_test.rs | **新增** 5 个装配级测试（171 行） | 测试 |
| crates/app/src/bin/eestock-data.rs | 装配 prober（clone providers/circuits） | 装配 |
| crates/tushare/src/sync.rs | +`checkpoint_through_cap()` 纯函数 | 基础设施（tushare） |
| crates/tushare/src/daily.rs | 强制同步目标交易日 + 零调用审计事件 + 三时点 next_run_after + sync_target_date | 基础设施 |
| crates/tushare/src/bin/tushare_sync.rs | checkpoint cap + 「已最新」跳过落审计事件 | 基础设施（运维 bin） |
| crates/tushare/tests/daily_sync.rs | 缺陷 2 复现测试 3 个 + 三时点调度测试 3 个（替换 1 个缺陷语义旧测试） | 测试 |
| crates/tushare/tests/sync_plan.rs | +checkpoint_through_cap 边界测试 | 测试 |

## 2. 缺陷 1 修复：熔断 HalfOpen 低频探测任务（CircuitProber）

**问题**：`usable()` 仅 Healthy；`degraded_loop` 恢复探测前置「健康池非空」；装配无任何探测任务
→ 双源 HalfOpen 后运行时无探测路径，源恢复不自愈（tester 004 §3c 实盘实证）。

**实现**（批准方案逐字落地）：
- `CircuitRegistry::halfopen_sources()`：HalfOpen 态 Tier1 源枚举（含懒迁移 Open→HalfOpen + 事件）。
- `CircuitProber::probe_round()`：对每个 HalfOpen 源**单发轻量探测**（1 只代表标的 = symbols 表首只启用标的，
  m1，limit=1；直调 provider，**不经 attempt_chain** → 不占交易抓取通道、不影响当班轮换；探测不写 kline_raw）。
  - `Ok` → `report_success`（HalfOpen→Healthy + circuit_closed 事件）→ 健康池恢复 → 降级标的由既有
    degraded_loop 恢复探测（`should_probe_recover`）接管回切（§6 既有语义，组合而非新造）。
  - `NoData` → 源应答正常即存活（与 executor na 口径一致），闭合熔断 + ok=true/err_kind=na 事件。
  - 其他错误 → `report_failure`（HalfOpen 失败 → Open + 冷却 ×2 封顶 30min，circuit.rs 既有语义）+ 分源失败事件。
- `run_forever`：60s 节拍扫描（低频；重试节奏由冷却翻倍主导：60s→120s→…→30min）。
- 装配：CollectorService::new 增加 prober 参数，run() spawn；eestock-data.rs 构建并注入。

**TDD 证据**：Red = `probe_test.rs` 编译失败（`collector::probe` 不存在）；Green 后 5/5：
- `halfopen_probe_success_closes_circuit_and_restores_source`（tester §3c fake-clock 复现：双杀→Open→冷却到期→探测闭合→回健康池+circuit_closed 事件）
- `probe_failure_reopens_with_doubled_cooldown`（失败重开、120s 未到期零打扰、到期再探测闭合）
- `probe_noop_without_halfopen_sources`（无 HalfOpen → 0 调用，不占交易通道）
- `probe_nodata_means_reachable_closes_circuit`（na 口径）
- `full_recovery_cycle_degraded_code_returns_to_normal`（全链路装配级：executor 路径驱动双熔断→降级→探测→正常链回切成功）

## 3. 缺陷 2 修复：checkpoint 语义修正 + 禁止静默跳过

**a. checkpoint 语义**（`sync::checkpoint_through_cap`，daily 与手动 bin 共用）：
- 盘中（CST 15:00 收盘前）checkpoint 推进**封顶前一自然日**，不得将当日标记为完成；收盘后允许含当日。
- 日增量对目标交易日**强制同步**：拉取窗口 = `[min(checkpoint+1日, target), target]`，checkpoint==当日也重拉
  （准确层 ON CONFLICT DO UPDATE 幂等去重，重拉无副作用）。
- 手动 bin `tushare_sync` 逐窗口 checkpoint 与「无数据标记完成」分支同样过 cap。

**b. 禁止静默跳过**：整轮零调用（无启用标的）落审计事件 source=tushare/ok=true/err_kind=na（原因载于
trace_id 形如 `skip:<reason>`；0001 schema 无 detail 列，PgEventSink 持久化 ts/source/ok/err_kind/code，
监控以 na 事件为信号、原因查日志——已在 design §6.1 注明）。手动 bin「已最新」零调用跳过同样落审计。

**TDD 证据**：Red = 3 个复现测试全失败（`checkpoint_today_still_fetches_today_after_close` 断言失败 /
`intraday_run_does_not_advance_checkpoint_to_today` 断言失败 / `zero_call_round_emits_audit_event` 断言失败）
+ `checkpoint_cap_intraday_vs_after_close` 编译失败（函数不存在）；Green 后全绿。
旧测试 `up_to_date_code_no_api_call` 编码的正是缺陷语义（checkpoint==今日→跳过），按批准的口径变更改写为
`checkpoint_today_still_fetches_today_after_close`（复现测试本体）。

**实盘验证（修复后镜像，2026-09-03 18:00 CST 触发）**：
```
10:00:46Z  tushare daily round done outcome="Synced { codes: 44, bars: 0 }"   ← 耗时 46s（44 code × ~1s 限频真实调 API）
10:00:46Z  next_run="2026-09-03 16:00:00 UTC"（= 00:00 CST，三时点排程生效）
DB: source_health_events source=tushare 10:00 后 44 行 ok=true（不再静默）
```
对照缺陷时 07:30:00.048Z 整轮 0.048s 跳过：触发后**强制发起当日拉取** ✓（bars=0 因 tushare 当日数据未就绪，见 §5）。

## 4. 三时点调度（用户决策 2026-09-03，并入本轮）

- `RUN_TIMES = [00:00, 08:00, 18:00] CST`，`next_run_after` 每自然日三时点（含周末；周末轮目标回退周五）。
- `sync_target_date(now)` = 最近已收盘（15:00 CST 已过）工作日：18:00→当日；00:00/08:00→前一交易日（跨周末回退）。
- 三时点各自独立完整增量、独立退避重试 3 次、各自落事件（含零调用审计）。
- **前提已验证**：`cargo test -p storage --test accurate_upsert` → `conflict_updates_row_not_keeps_first` ok
  （准确层确为 upsert 覆盖语义，后次同步可修正前次不完整数据），无需上报。
- 与缺陷 2 修正并存：每轮均含目标交易日；cap 语义不变（through = min(target, cap)，触发点上恒等于 target）。
- design/99-decisions-log.md 追加决策记录（第 5 条）。
- 测试：`next_run_three_triggers_same_day` / `next_run_cross_midnight_and_weekend` /
  `sync_target_is_latest_closed_weekday`（含跨午夜、跨周末、08:00 补前一交易日、15:00 边界）。

## 5. 收尾运维动作

1. **重建+重启**：`docker-compose build data` → 镜像 eestock-rs_data（created 2026-09-03T08:55:31Z）；
   `docker-compose up -d data`（compose 1.29.2 KeyError: 'ContainerConfig' 已知 bug → stop/rm 旧容器后重建）；
   容器 Up healthy，启动日志 `tushare daily scheduled next_run="2026-09-03 10:00:00 UTC"`（三时点生效）。
   重启清零内存熔断态（HalfOpen 卡死回滚动作）。
2. **Tier1 采集恢复确认**：午后时段（05:00–07:00 UTC）kline_raw 由 tencent_ifzq(1253 行/44 code) +
   sina_jsonp(1211 行/44 code) 完整承接到 15:00 CST；`*_approx` 行止于 06:17（演练窗口，首写胜出保留，属设计）。
   探测任务全程 0 日志（无 HalfOpen 源 → 零打扰，符合"不占交易通道"）。
3. **一次性补数（09-03 准确层）**：17:00 CST 手动 `UPDATE sync_checkpoints SET last_synced_date='2026-09-02'`（44 行）
   + 宿主机跑 `tushare_sync` bin → 44/44 code 窗口 2026-09-03..2026-09-03 全部 0 bars。
   **结论：tushare 端 09-03 分钟数据 17:00 时尚未整理就绪**（收盘后 2h）——符合三时点调度设立的初衷；
   18:00 CST 实盘触发已复核仍为 0（tushare 未就绪），后续 00:00/08:00 轮次自动收敛（强制同步当日，checkpoint 不再阻断）。
   若 09-04 早间仍缺，需再跑一次手动 bin（checkpoint 已过 cap 语义保护，重跑无副作用）。

## 6. 全量自检

| 门禁 | 结果 |
|---|---|
| `./scripts/check-tangle.sh` | ✅ tangle 后无 diff |
| `cargo test --workspace` | ✅ **88 passed / 0 failed**（79 → 88：+5 probe、+1 sync_plan cap、+3 daily_sync 净增） |
| `cargo clippy --workspace --all-targets` | ✅ 0 warning / 0 error |

测试分布：domain 12 + providers 14 + collector 27（+probe 5）+ storage 10 + tushare 22（+4 净增）+ app 3 = 88。

## 7. 残留风险 / 已知边界

- kline_accurate 09-03 仍为 0 行（tushare 端数据未就绪，非代码缺陷）；00:00/08:00 自动补全，明早需复核。
- 「附跳过原因」载体：HealthEvent 无 reason 字段且 0001 schema 无 detail 列 → 原因载于 trace_id（内存/日志可见，
  DB 行不含原因文本）。若诊断面板需要 DB 内原因列，属 schema/接口变更，提请架构师裁决（未擅自改）。
- 手动 bin 的 `today = Local::now().date_naive()` 依赖宿主/容器 TZ（当前宿主 CST 正确）；跨 TZ 部署时需留意（既有行为，未扩大）。
- sync_target_date 周末回退不含节假日表（Wave 0 日历=仅工作日，与既有口径一致；节假日轮次会拉空窗口，幂等无害）。
- compose 1.29.2 recreate bug（KeyError: 'ContainerConfig'）：运维侧知悉即可，重建需 stop/rm 后 up。

## 8. 建议 commit 切分

```
commit 1  fix(collector): 熔断 HalfOpen 低频探测任务 CircuitProber（缺陷 1，HalfOpen 自愈回切）
          design/03-collector/00-design.md + design/03-collector/02-data-plane.md
          crates/collector/src/{probe,circuit,service,lib}.rs + crates/collector/tests/probe_test.rs
          crates/app/src/bin/eestock-data.rs
commit 2  fix(tushare): checkpoint 语义修正 + 禁止静默跳过 + 三时点调度（缺陷 2 + 用户决策 2026-09-03）
          design/04-storage/02-tushare-sync.md + design/99-decisions-log.md
          crates/tushare/src/{sync,daily}.rs + crates/tushare/src/bin/tushare_sync.rs
          crates/tushare/tests/{daily_sync,sync_plan}.rs
```
注：三时点与缺陷 2 修正在 daily.rs/测试中交织（mid-run steering 并入同一 Green 阶段），强行再拆会破坏
tangle 一致性，故合为 commit 2；message 中并列两条动机。

## 9. GitNexus 影响面（编辑前已跑）

- `DailySync::sync_code` upstream：LOW（2 impacted：run / run_forever）
- `resume_from` LOW（3 impacted）；`set_checkpoint` LOW；`degraded_loop` LOW
- `halfopen_sources`/`CircuitProber` 为新增符号（无既有调用方）；domain 端口/trait 零改动
- 父仓索引不覆盖 eestock-rs（嵌套 git 仓），已对 eestock-rs 单独建索引后执行 impact（.gitnexus/ 未入库）

**状态：已 stage（git add），未 commit，待 reviewer 验收。**
