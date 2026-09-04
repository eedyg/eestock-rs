# Tester 报告 005：Wave 0 缺陷修复复验（CircuitProber 自愈 + tushare 三时点/审计 + 3c 实盘复验）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/005_wave0_reverify.md`
> 复验人：tester agent（只验收不改码）
> 复验对象：commit `aa063b2`（collector CircuitProber，缺陷 1）+ `727bde1`（tushare 缺陷 2/三时点），依据 coder/report/005_wave0_defect_fix.md 与 tester/report/004_wave0_acceptance.md
> 复验日期：2026-09-03（周四，交易日）18:0x CST 启动 → 跨夜至 09-04 晨（00:00 / 08:00 CST 触发点 + 盘中 3c 最小演练）
> 状态：**进行中（分段落库）**—— 项 1/2 已闭环；项 3/4/5 为时间门（00:00 CST / 盘中 09:30+ / 08:00 CST）

## 0. 执行摘要（最终版在收尾时更新）

| 复验项 | 结果 | 一句话证据 |
|---|---|---|
| 1. 修复质量评审（probe_test 5 测试行为规格式 + CircuitProber 不占交易通道） | ✅ PASS | 见 §1 |
| 2. 门禁复跑（check-tangle / test 88 / clippy 0） | ✅ PASS | tangle 无 diff；88 passed / 0 failed；clippy --all-targets 0 警告（见 §2） |
| 3. 00:00 CST 触发点实盘 | ✅ PASS（16:00:46Z 第二轮，bars=10604，kline_accurate 09-03=10,604） | 见 §3 + 增量节 |
| 4. 3c 自愈复验（盘中最小演练） | ✅ PASS（open→60s→halfopen→235ms→closed→腾讯回切，阻断 94s，零缺口零重启） | 见 §4 + 增量节 |
| 5. 08:00 CST 触发点 + kline_accurate 09-03 收敛 | ✅ PASS（数据收敛 10,604；第三触发准点但被 ENOSPC 环境阻断，语义正确重排 18:00 CST；待 parent 裁决闭环口径） | 见 §5 + §6 |

## 1. 复验项 1：修复质量评审 —— ✅ PASS

### 1.1 probe_test.rs 5 个装配级测试（行为规格式，非实现镜像）

逐个 read-only 评审（文件 `crates/collector/tests/probe_test.rs`，171 行，tangle 源 design §9.11）：

| 测试 | 断言落点 | 评审结论 |
|---|---|---|
| `halfopen_probe_success_closes_circuit_and_restores_source` | 双源 3 连败→健康池空→60s 后懒迁移 HalfOpen→probe_round 返回 2、两源各 1 次调用→状态回 Healthy、`circuit_closed` 事件落 sink、健康池含双源、`should_probe_recover` 放行 | 行为式：tester 004 §3c 的 fake-clock 全链路复现（双杀→冷却→探测闭合），断言在状态迁移/事件/调用次数，非内部字段 |
| `probe_failure_reopens_with_doubled_cooldown` | 探测失败→Open、119s 内整轮 0 调用（冷却未到期不打扰源）→120s 到期再探测成功→Healthy+closed 事件 | 行为式：冷却翻倍与"退避期不轰击"断言 |
| `probe_noop_without_halfopen_sources` | 全健康→probe_round=0、两源 0 调用 | **不占交易通道的直接断言** |
| `probe_nodata_means_reachable_closes_circuit` | NoData→Healthy + ok=true/err_kind=na 事件 + closed 事件（与 executor na 口径一致） | 行为式：源应答可达即存活口径 |
| `full_recovery_cycle_degraded_code_returns_to_normal` | **装配级全链路**：经 FetchExecutor fetch_one 路径双杀（非直调 report_failure）→AllFailed→standby 激活→60s→probe 闭合双源→健康池非空→should_probe_recover→正常链 fetch Ok→deactivate | 行为式：§3c 全链路复现（executor→熔断→降级→探测→回切），覆盖 004 报告"质量观察 1"缺口 |

评审发现：全部使用 FakeClock + MockMinute/MemSink/MemWriter/MemRegistry 端口替身，零真实 HTTP；断言在可观测端口（状态、事件、调用次数、降级位）；无白盒镜像断言。**5/5 在常规 `cargo test --workspace` 下通过**（见 §2）。

### 1.2 CircuitProber 实现 vs「不占交易通道」口径 —— PASS

`crates/collector/src/probe.rs`（104 行）+ `circuit.rs::halfopen_sources`（17 行）+ `service.rs` spawn + `eestock-data.rs` 装配，逐条对照：

- **直调 provider**：`probe_round()` 对 HalfOpen 源 `providers.get(&src)` 后直接 `provider.fetch_m1(&code, PROBE_LIMIT)` —— 不经 `attempt_chain`/`FetchExecutor`，不写 duty/roster → **不占交易抓取通道、不影响当班轮换** ✓
- **不写 kline_raw**：probe 无 writer 依赖（构造参数仅 providers/circuits/registry/sink/clock）→ 数据由恢复后的正常链接管 ✓
- **60s 节拍**：`PROBE_INTERVAL = 60s`，`run_forever` sleep 60s 后扫一轮 ✓
- **limit=1 / 单只代表标的**：`PROBE_LIMIT = 1`；仅当 `halfopen_sources()` 非空才取 `enabled_codes()[0]` 单发探测；无 HalfOpen 源或无启用标的 → 整轮零调用（test #3 锁定）✓
- **NoData=源可达口径**：闭合熔断 + ok=true/err_kind=na 事件（与 executor na 口径一致）✓
- **失败语义**：HalfOpen 失败 → `report_failure` 重开 Open、冷却 ×2 封顶 30min（circuit.rs 既有语义，test #2 锁定 120s）✓
- **懒迁移**：`halfopen_sources()` 在锁内 resolve Open→HalfOpen（冷却到期）并事后发迁移事件 —— 探测路径自身承担状态推进 ✓
- **运行态零打扰实证**：容器自 08:57:11Z 重启以来（至 18:30 CST）日志 **0 条 probe 记录**、DB `source_health_events` 自 08:57Z 起 **err_kind 全 NULL（176 条 ok）**，无 circuit_open/halfopen/closed —— 全健康期探测任务零动作 ✓（实盘不占通道的旁证）
- **回切衔接**：探测闭合→健康池非空→degraded_loop 恢复探测（`should_probe_recover`，service.rs §6 既有逻辑）接管标的回切 —— 组合既有语义而非新造回切路径；装配级 test #5 全链路锁定

### 1.3 daily_sync / sync_plan 新增测试（行为规格式）—— PASS

`crates/tushare/tests/daily_sync.rs` 11 个测试（原 8 → 净 +3）：三时点调度 3（`next_run_three_triggers_same_day`、`next_run_cross_midnight_and_weekend`、`sync_target_is_latest_closed_weekday`，含严格晚于、跨午夜、跨周末回退周五、15:00 收盘边界、08:00 周一补周五）+ 缺陷 2 复现 3（`checkpoint_today_still_fetches_today_after_close` 收盘后 cp==今日仍拉取当日 / `intraday_run_does_not_advance_checkpoint_to_today` 盘中 cp 封顶前一自然日 / `zero_call_round_emits_audit_event` 零调用轮落 ok=true+err_kind=na+`trace_id=skip:*`）+ 既有 5 个运行语义（退避/增量/重试/限频）保留。

`crates/tushare/tests/sync_plan.rs` 7 个（原 6 → +1 `checkpoint_cap_intraday_vs_after_close`：14:59 CST 盘中封顶前一日、15:00 整允许当日、09:30 盘中封顶、16:00 盘后允许、次日 00:00 CST 边界按 CST 日期）。

评审结论：断言全在可观测端口（DailyOutcome、mock 调用次数、MemStore checkpoint 终值、MemSink 事件形状），FakeClock 注入，**行为规格式**；旧测试 `up_to_date_code_no_api_call` 编码的恰是缺陷语义，已按裁决口径改写为复现测试本体（非删除规避）。

## 2. 复验项 2：门禁复跑 —— ✅ PASS（独立复跑，与 coder 报告一致）

| 门禁 | 命令 | 结果 |
|---|---|---|
| tangle | `./scripts/check-tangle.sh` | ✅ `tangle 后无 diff，design 与生成物一致`（git status 仅非代码 untracked） |
| 全量测试 | `cargo test --workspace` | ✅ **88 passed / 0 failed / 0 ignored** |
| lint | `cargo clippy --workspace --all-targets` | ✅ 0 warning / 0 error（exit 0） |

88 分布（独立计数，与 coder 005 §6 一致）：domain contracts 12 ＋ providers golden 10 + http 4 = 14 ＋ collector calendar 2 + circuit 4 + executor 5 + gapfill 3 + **probe 5** + scheduler 2 + standby 6 = 27 ＋ storage accurate 2 + event_sink 3 + raw_writer 3 + symbols 2 = 10 ＋ tushare daily_sync 11 + golden 4 + sync_plan 7 = 22 ＋ app config_healthz 3 = **88**。（79 → 88：+5 probe、+1 sync_plan cap、+3 daily_sync。）

（注：本机 storage 集成测试需要 TimescaleDB 容器，本环境容器 healthy 在跑，10/10 通过。）

## 3. 复验项 3：00:00 CST 触发点实盘（今晚 16:00 UTC）—— ⏳ 待验证

前置证据（18:00 CST 首触发已实盘，容器日志 + DB 双重确认）：

```
10:00:46.598Z  tushare daily round done  outcome="Synced { codes: 44, bars: 0 }"   ← 18:00 CST 首触发（三时点第 1 次）
10:00:46.598Z  tushare daily scheduled  next_run="2026-09-03 16:00:00 UTC" wait_secs=21553  ← 00:00 CST 已排程
DB 2026-09-03 10:00:00.349–10:00:46.597Z：source_health_events source=tushare ok=true ×44（逐 code，不再静默）
sync_checkpoints：44/44 last_synced_date=2026-09-03（18:00 盘后轮，cap 允许含当日）
kline_accurate 09-03 行数 = 0（tushare 端 09-03 分钟数据未就绪）；09-02 = 10,604 行完整
容器 08:57:11Z 启动日志 next_run="2026-09-03 10:00:00 UTC"（三时点排程生效 = 部署代码含修复）
```

待 16:00:00 UTC（00:00 CST）触发后验证：第二次触发执行（log round done + next_run=09-04 00:00 UTC）；整轮事件审计（预期 44×ok=true，非静默）；若 bars=0 记录并核对是否含 na 审计（语义注：na 审计事件在实现中对应「零调用轮」，44 标的下不触发——见 §3 验证口径说明）；若有数据核对 kline_accurate 09-03 落库行数。**[结果落库见文件尾部时间戳追加节]**

## 4. 复验项 4：3c 自愈复验（下一交易日 09-04 盘中 09:30 CST 后）—— ⏳ 待演练

最小化演练预案（只阻断腾讯 ifzq 单源，全程不重启容器，阻断总时长 ≤5 分钟）：
1. 解析容器 IP（172.24.0.3）与 tencent ifzq 域当前 A 记录（若多个 IP 全量阻断）。
2. `sudo iptables -I DOCKER-USER -s 172.24.0.3 -d <tencent IP> -j DROP`。
3. 观察 source_health_events：tencent_ifzq timeout 事件 → `circuit_open`（tencent）；kline_raw 该周期由 sina_jsonp 全量承接（单源故障不降级）。
4. **立即** `sudo iptables -F DOCKER-USER` 恢复网络（观察到 circuit_open + 转移即恢复，目标把阻断压在 ≤5min）。
5. 验证自愈链：prober 60s 节拍 → HalfOpen 懒迁移（`circuit_halfopen` 事件，若在探测轮才迁移）→ 单发探测成功 → `circuit_closed` 事件 + 日志 `circuit probe ok -> closed` → tencent 回 Healthy → 当班轮换/回切恢复 tencent_ifzq 行。
6. 全程零重启；演练后 iptables 链空确认 + 采集恢复正常态。

判定：出现 `circuit_closed` 事件 + tencent_ifzq kline_raw 行恢复 = PASS；观察 ≥5 分钟无 probe 活动/无闭合 = FAIL（附时间线与证据）。**[结果落库见文件尾部]**

## 5. 复验项 5：08:00 CST 触发点 + kline_accurate 09-03 收敛（09-04 08:00 CST = 00:00 UTC）—— ⏳ 待验证

同 §3 口径验证第三触发；确认 kline_accurate 09-03 数据最终收敛（00:00/08:00 两轮后应为非 0；若 tushare 端 09-03 数据仍未就绪则记录，判别为外部数据就绪问题而非代码缺陷，按 §7 口径裁决）。**[结果落库见文件尾部]**

---

## 时间戳追加节（跨夜观测实录）

<!-- 每次观测追加，不覆盖历史 -->

### [增量] 2026-09-03 22:34 CST 机器重启后基线复检（tester 会话 2，重启续跑）—— 项 3 前置 ✓

**机器/容器自愈证据（22:48 CST 采集，重启后 14 min）**
- `uptime`：up 14 min（22:34 CST 重启）；`docker ps`：`eestock-data` Up 14 minutes (healthy) + `eestock-timescaledb` Up 14 minutes (healthy)，RestartCount=0 —— **restart: unless-stopped 自恢复生效**（RestartCount 未涨 = 机器重启非容器崩溃）。
- `git log`：HEAD=`a6671dc`（004 验收报告 md），相对修复目标 `727bde1` 仅新增 `tester/report/004_wave0_acceptance.md`，**无代码 diff**；image `eestock-rs_data` Created=`08:55:31Z`（16:55 CST，含修复的部署镜像，GitNexus/上一会话证据一致）。
- 容器日志（重启后）：
  - `14:34:17.816Z  tushare daily task enabled`
  - `14:34:17.816Z  tushare daily scheduled  next_run="2026-09-03 16:00:00 UTC" wait_secs=5142` —— **调度器重启后正确重排到 00:00 CST（=16:00 UTC）触发点** ✓（符合预期：应排 00:00 或 08:00）
- 数据库基线（22:50 CST 采集）：
  - `kline_raw` 09-03：**10,602 行**（sina_jsonp 5,527 + tencent_ifzq 4,855 + 其余小源），ts 覆盖 01:30–07:00 UTC（09:30–15:00 CST 全交易时段），44 codes / 241 distinct minutes —— 重启未损数据 ✓
  - `kline_accurate` 09-03：**0 行**（tushare 端 09-03 分钟数据未就绪，符合背景预期）；09-02 = 10,604 行完整
  - `sync_checkpoints`：44/44 = 2026-09-03
  - 重启后 `source_health_events` 全部 ok=true 无 err_kind（sina 32 + tencent 12）—— 双源健康、无 probe 活动
- 历史故障事件排他性确认：09-03 全天仅 4 条 circuit_open/halfopen（tencent 06:08:18Z → sina 06:12:10Z，**无 circuit_closed**），timeout/all_failed 集中于 06:08–06:12Z —— 均为 **14:08–14:13 CST（修复部署 16:55 CST 之前）的 004 杀源演练时段**，恰为缺陷 1 现场（HalfOpen 无自愈）；当前运行期（14:34Z 重启后）**0 条 probe/circuit 记录** = 全健康期探测零动作旁证。
- tushare ok=true 审计事件 88 条分解：44 @ 07:00 UTC 段（15:30 CST，部署前旧任务末轮）+ 44 @ 10:00 UTC 段（18:00 CST，修复后首轮，与 §3 前置证据逐条吻合）—— 无 err_kind=na（na 仅对应真零调用轮，44 标的下不发生）。

**结论**：重启未破坏任何复验前置状态；项 3 验证窗口（16:00:00 UTC = 00:00 CST）保留。等待触发中……

### [增量] 项 3 验证结果：00:00 CST 第二次触发 —— ✅ PASS（2026-09-03 16:01 UTC 采集）

| 断言 | 证据 | 结果 |
|---|---|---|
| 第二次触发准时执行（16:00:00 UTC） | 容器日志 `16:00:46.250Z  tushare daily round done  outcome="Synced { codes: 44, bars: 10604 }"`（与排程差 46s = 首 code 拉取耗时，无延迟/漂移） | ✅ |
| 数据轮（非零数据轮） | bars=10604 > 0 —— 走「若有数据」口径分支（na 审计事件仅对应真零调用轮，本轮 44 code 逐 code 调用并落审计，见下） | ✅ |
| kline_accurate 09-03 落库 | DB：**10,604 行** = 44 codes × 241 minutes，ts 覆盖 01:30–07:00 UTC 全交易时段（与 09-02 收敛形态 10,604 行一致） | ✅ |
| 审计事件（source=tushare ok=true） | 16:00:00Z 起 44 条全部 `ok=true, err_kind=NULL, source=tushare`（逐 code，无静默） | ✅ |
| checkpoint 推进口径 | 44/44 仍 = 2026-09-03（00:00 CST 时点 cap=最近已收盘 09-03，through 封顶正确，不误标 09-04） | ✅ |
| 第三次触发排程 | `next_run="2026-09-04 00:00:00 UTC" wait_secs=28753`（= 08:00 CST 09-04，正确） | ✅ |

结论：修复后三时点第二次触发执行正确；tushare 端 09-03 数据在午夜前已就绪，09-03 准确层已首轮收敛至 10,604 行（44×241）。项 5 的 00:00 UTC（08:00 CST）第三触发已排程，等待中……

### [增量] 2026-09-04 00:35-08:40 CST 复验中断（ENOSPC）后取证 —— 项 5（08:00 CST 第三触发）证据 + 环境事件链

**环境事件链（容器日志 + DB 日志重建）**
- 09-03 19:00:00.000Z（03:00 CST）：PG 出现 `terminating connection because of crash of another server process` ×10 —— **ENOSPC 引发 PG 后端崩溃**，随后 5.5h 处于 crash recovery（磁盘满无法写 WAL，恢复卡死）。
- 09-03 19:00:48Z – 09-04 00:33:48Z：collector `symbols re-read failed (keep current set)` / `gap backfill round failed`，全部 `pool timed out while waiting for an open connection`（90s 节拍持续记录）—— DB 不可达期。
- 09-04 00:35:08.110Z：**PG crash recovery 完成** `database system is ready to accept connections`（supervisor 回收 151GB 后恢复完成，容器零重启：StartedAt 仍 14:34:17Z，RestartCount=0）。
- 00:35:10Z 起 collector 池重连成功（pg_stat_activity 实证：12 条连接，symbols 重读/interval 查询 11-20s 前活跃）—— 恢复健康，日志静默=成功路径（symbols 重读仅失败才打日志）。
- 数据完整性（崩溃恢复后复查）：kline_accurate 09-03 = **10,604** ✓；kline_raw 09-03 = 10,602 ✓；sync_checkpoints 44/44=09-03 ✓；无损坏。

**项 5 判据取证（08:00 CST = 00:00 UTC 09-04 第三触发）**
| 断言 | 证据 | 结果 |
|---|---|---|
| 第三触发准点执行 | 容器日志 `00:00:30.001Z  ERROR tushare daily: read symbols failed  error="pool timed out while waiting for an open connection"`（= 触发后 sqlx 30s acquire 超时）；随后 `00:01:00.002Z round done  outcome="Failed"` | ✅ 准点触发（执行体被环境阻断） |
| 失败语义（非静默、不崩、正确重排） | `00:01:00.002Z tushare daily scheduled  next_run="2026-09-04 10:00:00 UTC" wait_secs=35939` —— round Failed 后正确重排到下一时点（18:00 CST）；ERROR/WARN 日志完整留痕；checkpoint 未被破坏（44/44 仍 09-03） | ✅ 修复口径内行为 |
| 审计事件（na） | 本轮未能落库 source_health_events（emit 自身也因 pool 超时失败：`00:01:00.002Z WARN tushare daily event emit failed`）—— 属 DB 不可达的极端情形，事件落库依赖不可用，非静默 bug（进程日志有完整记录） | ⚠️ 环境性旁路（已记录） |
| kline_accurate 09-03 最终收敛 | **10,604 行非 0**（44×241，00:00 CST 轮已收敛；08:00 轮为幂等补全轮，其环境性失败不影响已落库数据） | ✅ |
| 下一轮已武装 | 18:00 CST（10:00 UTC）触发已排程 | ✅ |

**判定**：项 5 数据收敛判据满足（非 0、完整、崩溃恢复后无损）；第三触发准点且失败语义符合设计。**唯一未闭环点**：第三轮（08:00）因 ENOSPC 环境未成功执行，补全延至今日 18:00 CST 轮。待 parent 裁决：以当前收敛证据闭环，还是待 18:00 CST 轮成功日志（预计 09-04 22:35Z 后，`Synced { codes: 44, bars: 10604 }`）补证后闭环。→ **裁决请求（见 §6）**

## 6. 裁决请求与红线合规记录（2026-09-04 08:41 CST 追加）

1. **项 5 闭环裁决请求**：08:00 CST 第三触发准点但执行体被 ENOSPC 环境阻断（DB crash recovery 5.5h，00:35:08Z 恢复），已按设计语义重排至今日 18:00 CST（10:00 UTC）。数据收敛判据已满足（kline_accurate 09-03 = 10,604 非 0，崩溃恢复后无损）。选项 A：以当前证据闭环项 5（推荐——失败纯环境性、数据目标已达成）；选项 B：待 18:00 CST 轮成功日志补证后闭环（预计 09-04 10:00:xx UTC，`Synced { codes: 44, bars: 10604 }`）。**默认按 A 记 PASS，若 parent 选 B 请指示，本报告 §5 留待补证**。
2. **红线合规**（用户直批 2026-09-04）：全程未执行任何 Docker 清理类操作（无 prune/rm image/container/volume）；eestock 容器 restart 与 iptables 演练恢复均在授权范围内使用。演练仅用 `iptables -I/-F DOCKER-USER`，无 Docker 写操作。

## 7. 复验项 4 演练实录：3c 自愈复验 —— ✅ PASS（2026-09-04 09:30+ CST 盘中，全程零容器重启）

**演练时间线（UTC）**：T0=01:32:36 阻断 → 01:33:18 circuit_open → **01:34:10 恢复网络（阻断总时长 94s ≤ 5min）** → 01:34:18 自愈完成 → 01:35 起腾讯行恢复。

| 阶段 | 时间(UTC) | 证据 |
|---|---|---|
| 基线（盘中确认） | 01:32 | 44 codes/分钟双源正常（sina 21 + tencent 23）；88 fetch ok/2min |
| T0 阻断腾讯单源 | 01:32:36 | `iptables -I DOCKER-USER -s 172.24.0.2 -d {157.148.49.175,157.148.63.205,157.255.4.117,157.255.4.35} -j DROP`（4 IP，演练前 DNS 现解） |
| 连续失败累积 | 01:33:19–24 | tencent_ifzq timeout ×19（逐秒连发）；sina 承接 fetch ok ×69 |
| **circuit_open** | 01:33:18.104 | source_health_events `tencent_ifzq ok=f err_kind=circuit_open`（阻断后 42s，3 连败阈值） |
| 当班转移（零缺口） | 01:33–01:34 分钟 | kline_raw 每交易分钟仍 44/44：01:33=sina34+t10、01:34=sina42+t2（sina 全量承接腾讯份额） |
| **恢复网络** | 01:34:10 | `iptables -F DOCKER-USER`（链空确认，0 DROP 残留）；阻断 94s |
| 冷却到期懒迁移 | 01:34:18.535 | `circuit_halfopen`（opened_at 01:33:18 + 60s 精确到期） |
| **探测闭合** | 01:34:18.770 | `circuit_closed` + 日志 `circuit probe ok -> closed`（halfopen 后 **235ms** 单发探测成功，60s 节拍内首拍即闭合） |
| **腾讯源回切** | 01:35 分钟起 | kline_raw tencent_ifzq 行恢复：01:35=17、01:36=18、01:37=17（与基线 01:32=23 同量级，双源轮换形态复原） |
| 事后确认 | 01:37+ | 闭合后事件 154 条全 ok=true（sina 100 + tencent 54；含 2 条 ok=true/err_kind=na 的 NoData 可达口径事件，非故障）；容器 **StartedAt 未变、Restarts=0（零重启）**；DOCKER-USER 空；当前 fetch ok 44/60s |

**与缺陷 1 现场对比**：004 演练（修复前）open→halfopen 后 **≥2.5 分钟零闭合、零回切**；本次 open→halfopen→closed 全程 **1.0s**（60s 冷却到期后探测首拍即闭合），腾讯行 1 分钟内回切。CircuitProber（aa063b2）缺陷修复实盘闭环。

**判定：PASS** —— circuit_closed 事件出现 + 腾讯源 kline_raw 行恢复 + 零重启 + 阻断 ≤5min + 链空复原，五项演练判据全部满足。

## 8. 收尾执行摘要（Wave 0 复验最终版，2026-09-04 09:40 CST）

| 复验项 | 结果 | 关键证据 |
|---|---|---|
| 1. 修复质量评审（probe_test 5 测试行为规格 + 不占交易通道） | ✅ PASS | §1 |
| 2. 门禁复跑（tangle / test 88 / clippy 0） | ✅ PASS | §2 |
| 3. 00:00 CST 第二次触发 | ✅ PASS | 16:00:46Z Synced{44,10604}；kline_accurate 09-03=10,604；44×ok 审计 |
| 4. 3c 自愈复验（盘中演练） | ✅ PASS | open→60s→halfopen→235ms→closed→回切；阻断 94s；零缺口零重启（§7） |
| 5. 08:00 CST 第三触发 + 09-03 收敛 | ✅ PASS* | 数据收敛 10,604 非 0 且崩溃恢复无损；第三触发准点、环境性失败语义正确、重排 18:00 CST（§5 增量 + §6 裁决） |

*项 5 带环境性脚注：08:00 轮执行体被 ENOSPC（PG crash recovery 5.5h，00:35:08Z 恢复）阻断，非代码缺陷；收敛判据独立满足。闭环口径见 §6 裁决请求。

**Wave 0 结论：可收官**（1-4 无保留 PASS；项 5 按 §6 选项 A 数据收敛口径 PASS）。未改任何代码；报告位置：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/005_wave0_reverify.md`。
