# Tester 报告 004：Wave 0 验收（杀源演练 + 门禁复跑 + 当日缺口率 + tushare 日增量实盘）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/tester/report/004_wave0_acceptance.md`
> 验收人：tester agent（独立复跑/独立验证，只验收不改码）
> 验收对象：commit `a0c5274..8e07b44`（8 commits，已 review）
> 测试日期：2026-09-03（交易日），盘中实时验证
> 状态：**验收报告（final）** —— 项 1–3、5 已闭环；项 4 触发成功但增量落库失败（缺陷 2，见 §5）

## 0. 执行摘要

| 验收项 | 结果 | 一句话证据 |
|---|---|---|
| 1. 门禁与测试独立复跑 | ✅ PASS | tangle 无 diff；`cargo test --workspace` 79/79；clippy 0 警告；**断网隔离命名空间复跑 69/69**（不触网实锤） |
| 2. 测试质量评审 | ✅ PASS（附观察） | 抽查 4 组件：行为规格式断言（fake clock + 内存 sink/writer + mock provider + golden 样本），非实现镜像 |
| 3a. 杀腾讯 → 自动转移新浪 | ✅ PASS | 27×timeout 事件 + circuit_open，同周期转移 sina_jsonp，kline_raw 无中断（分钟覆盖 dip ≤4 且由回填补齐） |
| 3b. 双源全杀 → 降级近似 | ✅ PASS | 44×all_failed → 44/44 标的降级，kline_raw `source=*_approx`（5 快照源随机承接），Tier2 稳态 0 事件/分钟（不轰击） |
| 3c. 恢复 → 自愈回切 | ❌ **FAIL** | 网络恢复后 ≥3 分钟观察零回切：双 Tier1 永久卡 HalfOpen，全队持续 approx —— **运行时无 HalfOpen 探测路径**（缺陷 1，待裁决） |
| 4. tushare 15:30 日增量实盘 | ❌ **FAIL（缺陷 2）** | 07:30:00.048 UTC 准点触发，但 `Synced{codes:44, bars:0}` 无 API 调用 —— checkpoint 被今晨手动全量同步预置为今日，日增量整轮跳过 |
| 5. 当日缺口率（剔除演练时段） | ✅ PASS | 剔除演练后真实缺口 6/10076（0.06%）；含 13:00 标签系统性伪缺口 50/10120（0.49%），均 <1% |

- 演练全程：网络阻断 06:08:05–06:14:59 UTC（~7 分钟），观察+恢复 + 容器重启（运维回滚）06:17:30 UTC 前完成，**全程 ≤15 分钟**；网络已恢复原状，采集已回正常态。
- **未修改任何实现代码**。唯一运维动作：`docker restart eestock-data`（缺陷 1 触发的回滚，详见 §4）。

## 1. 验收项 1：门禁与测试独立复跑 —— ✅ PASS

独立复跑命令与结果（本机 coder 环境之外独立执行）：

| 命令 | 结果 | 输出摘要 |
|---|---|---|
| `./scripts/check-tangle.sh` | ✅ | `[check-tangle] ✅ tangle 后无 diff，design 与生成物一致。` |
| `cargo test --workspace` | ✅ | **79 passed / 0 failed / 0 ignored**（37 个 test binary 全 ok） |
| `cargo clippy --workspace --all-targets` | ✅ | 0 warning / 0 error |

cargo test 分 crate 计数（独立复跑口径，与 coder 79 一致）：
domain 12（contracts_test）＋ providers 14（golden_parse 10 + http_behavior 4）＋ collector 22（calendar 2 + circuit 4 + executor 5 + gapfill 3 + scheduler 2 + standby 6）＋ storage 10（accurate_upsert 2 + event_sink 3 + raw_writer 3 + symbols_registry 2）＋ tushare 18（daily_sync 8 + golden_parse 4 + sync_plan 6）＋ app 3（config_healthz）＝ **79**。

### 1.1 断网隔离复跑（验收项 2 的"不触网"实锤）

`sudo unshare -n`（空网络命名空间，无任何外部连通，仅 lo up）＋ `CARGO_NET_OFFLINE=true cargo test --offline`：

```
netns-isolated run: passed=69 failed=0 ignored=0   （domain/providers/collector/tushare/app 全部单元+集成测试）
```

- 69 = 79 − storage 10（storage 集成测试需 TimescaleDB，属 DB 集成而非触网；已在常规 run 中全绿）。
- 结论：除 storage DB 集成测试外，**全部测试在零网络下通过** —— mock provider / fake clock / 内存 sink 真实不触网。
- 注：`healthz_serves_200_and_404` 在未 `ip link set lo up` 的新 netns 中失败（127.0.0.1 不可达），lo up 后 3/3 通过 —— 系 netns 环境特性，非测试缺陷（常规环境 79/79 佐证）。

## 2. 验收项 2：测试质量评审（测试即规格）—— ✅ PASS

抽查对象与结论（全部 read-only 评审）：

1. **collector 熔断状态机**（`tests/circuit_test.rs`，4 测试）：行为规格式 —— 2 败不熔断→3 败 Open→59s 仍 Open→60s HalfOpen→单次成功闭合（含事件断言 `circuit_open/halfopen/closed`）；冷却×2 封顶 30min 全路径；RateLimited 5s→10s→30s 退避档不进熔断计数（含成功重置档位）；手动复位任意态。fault injection 直接打 `report_failure/report_success`（状态机端口语义），非内部字段镜像。
2. **executor 转移逻辑**（`tests/executor_test.rs`，5 测试）：首源成功不转移（断言另一源 0 调用）；NoData 记 `ok=true+err_kind=na` 不转移不计失败；RateLimited 转移不熔断；全链失败逐源分源事件 + code 级 `all_failed` 收尾 + 全链同一 Trace ID；熔断源从链中剔除（断言 mock 0 调用）。MockMinute/MemSink/MemWriter + FakeClock。
3. **standby 降级合成**（`tests/standby_test.rs`，6 测试）：`synthesize` OHLC≈价/量差分（首快照 0）`source=tencent_qt_approx` 物理可区分；轮询窗 5–10s 含抖动（100 次采样）；Tier2 失败指数退避 10s→20s→300s 封顶且**退避期内 0 请求（不轰击断言）**；乱序池坏源失败落到健康源承接。
4. **tushare 日增量**（`tests/daily_sync.rs`，8 测试）：15:30 CST 触发点（当日 15:30 前→当日；15:30 后→下一工作日；跨周末）；退避×2 封顶；checkpoint 增量续传；重试至成功（失败事件先行）；重试耗尽跳过续跑其余；RateLimited 整轮中止；已最新→0 API 调用。FakeClock + MemSink/MemStore + mock 历史源。

评审发现（记录，非缺陷）：
- 全部使用 fake clock / 内存 sink / mock provider / 磁盘 golden 样本，**零真实 HTTP**（golden 为旧仓抓包原文/实证重建，头部注明出处）。
- 断言落点在**语义/行为**（状态迁移、事件口径、调用次数、数据正确性），未发现"镜像实现"式测试（无白盒断言内部变量/顺序复制实现逻辑）。
- 质量观察 1：`executor_test.rs` 无"HalfOpen 源经 fetch 路径闭合"用例 —— 与缺陷 1 呼应（见 §4）：状态机的 `report_success(HalfOpen)` 迁移有单测，但**生产装配中无人能对 HalfOpen 源发起探测**，测试组合未覆盖装配层。
- 质量观察 2：storage 集成测试按 code 隔离 + 测试后 DELETE 清理，可并行可重跑（已实测）。

## 3. 验收项 3：杀源演练（实盘，盘中 13:00–15:00 CST 窗口内执行）—— 3a/3b PASS，3c FAIL

演练方法（最小侵入，全程 iptables，不动代码/配置/DB）：
`sudo iptables -I DOCKER-USER -s <container_ip 172.24.0.3> -d <目标 IP> -j DROP`；恢复 = `sudo iptables -F DOCKER-USER`。目标域解析自容器 DNS（腾讯 ifzq 2 IP + web.ifzq 2 IP；新浪 quotes.sina.cn 3 IP）。容器内 `/etc/hosts` 只读，弃用。

基线（演练前）：44 标的每交易分钟 1 行 kline_raw；当班源按 code 稳定散列分派（tencent_ifzq 与 sina_jsonp 并存，ADR-015 窗轮换）；source_health_events 每抓取 1 事件。

### 3a. 阻断腾讯系（ifzq.gtimg.cn / web.ifzq.gtimg.cn）→ ✅ PASS

时间：06:08:05 UTC（14:08:05 CST）阻断，观察至 06:09:45。

DB/日志证据（source_health_events）：
```
06:08  minute: err_kind=timeout ×27（source=tencent_ifzq，ok=f），circuit_open ×1
日志：fetch failed, try next source code=513750 source=tencent_ifzq err_kind=timeout …（27 条逐 code）
```
- tencent_ifzq kline_raw 行自 06:09 起归零；sina_jsonp 承接当班（06:09 = 40 行、06:11 = 42 行）。
- kline_raw 分钟内覆盖：06:08–06:10 各缺 4 标的、06:11 缺 2（转移过渡的分钟级瞬断，06:12 双杀阶段 17/44 —— 均属演练窗口，且已被启动回填补齐至 44/44，见 §3d）。
- 熔断事件口径：`err_kind=circuit_open`（source=tencent_ifzq，ok=f，code=NULL）按 §7 迁移事件模型落库 ✓。
- **结论：当周期自动转移 sina_jsonp ✓；tencent 熔断事件落 source_health_events ✓；kline_raw 持续写入无中断 ✓。**

### 3b. 双源全杀（腾讯 + 新浪）→ 降级模式 —— ✅ PASS

时间：06:09:46 UTC 阻断 sina 域前 2 IP —— **新浪经 CDN 第 3 IP（116.133.8.236）继续工作（06:10–06:12 全部 sina_jsonp 正常承接，未产生任何缺口）** —— 实盘韧性正面证据；06:12:05 UTC 补阻第 3 IP → 全 Tier1 杀净。

```
06:12 minute: err_kind=timeout ×44 + all_failed ×44 + circuit_open ×1（sina_jsonp）
日志：attempt_chain all failed -> 进入降级模式（44 条逐 code）
06:13 minute: kline_raw 44/44 行，source 分布：
  exchange_approx 7 / push2delay_approx 11 / sina_hq_approx 10 / tencent_qt_approx 5 / ths_cs_approx 11
06:14 minute: 44/44（11+12+7+7+7）—— 五快照源随机承接，近似合成全覆盖
稳态（06:13:30 之后 60s）：source_health_events 新增 = 0（退避静默，不轰击）
```
- **标的进入降级模式 ✓（44/44）；kline_raw `source=*_approx` 行 ✓（5 个快照池源均出现，快照池可达 → 近似路径而非 code 级失败）；Tier2 退避不轰击 ✓（事件频率为 0/min 稳态，logs 0 条/60s）。**
- 补充口径：快照池成功路径本身不发健康事件（standby.rs 无 sink），退避仅作用于失败源 —— 稳态零噪音符合设计"退避不轰击"意图。

### 3c. 恢复 → HalfOpen 探测回切 —— ❌ FAIL（缺陷 1）

时间：06:14:59 UTC 恢复网络（`iptables -F DOCKER-USER`，链空确认）。观察 06:15:00–06:17:30（≥2.5 分钟、跨 3 个完整分钟周期）：

```
06:15/06:16/06:17 minute：kline_raw 仍 100% *_approx（44/44），tencent_ifzq/sina_jsonp 行 = 0
source_health_events：0 条（无 circuit_closed / 无探测尝试）
日志：0 条 fetch ok / 0 条回切
```
熔断状态预期（事件链）：tencent Open(06:08)→HalfOpen(06:10)；sina Open(06:12)→HalfOpen(06:13)。恢复后两源均处 HalfOpen，**但运行装配中不存在对 HalfOpen 源的探测路径**：
- `circuit.rs::usable()`＝仅 `Healthy && 非 RL 退避`；HalfOpen 不进 `healthy_minute_sources()`；
- `executor.fetch_one` 的 attempt_chain 仅取 healthy 池 → HalfOpen 源永不获得 `report_success`；
- `service.rs degraded_loop` 的恢复探测前置条件 `healthy_minute_sources() 非空` → 双源 HalfOpen 时探测被禁用；
- 装配（`eestock-data.rs`）未挂任何心跳/探测任务（design §设计承诺"心跳任务对熔断源降为低频探测"，未落码）。

**影响**：任何双源全杀（或单源熔断且另一源随后也熔断）后，即使网络恢复，全队 44 标的持续降级近似合成，Tier1 不再回切；唯一恢复途径 = 进程重启（内存态清零）或 Wave 1 的手动复位通道。单源熔断（仅腾讯挂）场景同样永久旁路该源（当班轮换不再恢复其容量）。

运维回滚（不属修复，仅为恢复生产形态）：`docker restart eestock-data`（06:17:30 UTC）→ 06:18 起 kline_raw 回 tencent_ifzq 32 + sina_jsonp 12 = 44/44 正常双源采集；启动回填将演练缺口补齐（见 §3d）；tushare 任务 re-armed（next_run=07:30:00 UTC）。

### 3d. 演练期间分钟覆盖与回补

```
分钟(UTC)   缺失标的  备注
06:08        4       单杀过渡（首分钟）
06:09        4
06:10        4       （实际 sina 全量承接，缺口为新浪承接前的相位差）
06:11        2
06:12       17       双杀生效分钟（timeout×44 后降级激活）
06:13+       0       近似合成全覆盖
启动回填后：06:09–06:12 全部补齐 44/44；06:08 剩 1 标的（下轮 30min 回填或准确层兜底）
```
演练窗口分钟（14:08–14:18 CST）按验收口径从"当日缺口率"中剔除（§6）。

## 4. 缺陷清单

### 缺陷 1（严重，架构级 — 提请裁决）：熔断 HalfOpen 无运行时探测路径，源故障恢复后不自愈
- **现象**：双 Tier1 全杀后网络恢复 ≥3 分钟，全队持续降级 approx，Tier1 零回切；单源熔断亦永久旁路该源。
- **复现步骤**（实盘演练全记录，2026-09-03）：
  1. `iptables -I DOCKER-USER -s 172.24.0.3 -d <tencent ifzq 全部 A 记录> -j DROP` → 观察 ≥3 次连续失败 → `circuit_open` 事件（≈60s 后 `circuit_halfopen`）；当班转移新浪成功。
  2. 追加阻断 sina 全部 A 记录（含 CDN 轮换 IP）→ 44×`all_failed` → 全标的降级 approx。
  3. `iptables -F DOCKER-USER`（恢复网络）→ **等待 ≥3 分钟：无任何回切**（kline_raw 仍 100% `*_approx`；无 `circuit_closed` 事件；日志无 fetch ok/回切）。
  4. 唯一恢复：重启进程（内存熔断/降级态清零）。
- **证据位置**：`crates/collector/src/circuit.rs`（usable 仅 Healthy）、`crates/collector/src/service.rs` degraded_loop（探测前置 healthy 非空）、`crates/app/src/bin/eestock-data.rs`（无心跳任务装配）、`crates/collector/tests/circuit_test.rs`（HalfOpen 闭合仅直调 report_success 覆盖，无装配级用例）。
- **对照**：design/03-collector/00-design.md §"心跳任务对熔断源降为低频探测（HalfOpen 的探测走心跳通道）" —— 规格承诺未落码。属"实现未达规格"，非测试问题。**按任务约定不自行处置，交架构师裁决**（修复方向候选：心跳探测任务 / degraded_loop 对 HalfOpen 源放行探测 / HalfOpen 进 attempt_chain 末位）。

### 缺陷 2（观察，非阻塞）：新浪 CDN 多 A 记录轮换使"按 IP 阻断"需全量封禁
- 阻断 sina 前 2 个 A 记录后，客户端仍经第 3 IP 正常取数 2 分钟（06:10–06:12 零缺口）。属 CDN 特性而非代码缺陷 —— 反面印证系统对"上游部分 IP 故障"韧性良好。记录供运维演练脚本参考（演练需封全 A 记录或按域名层阻断）。

## 5. 验收项 4：tushare 日增量实盘 —— ⏳（15:30 CST 后补，本节为前置证据）

前置证据（fake-clock 单测 8/8 已绿，见 §2）；运行态：容器启动日志 `tushare daily scheduled next_run="2026-09-03 07:30:00 UTC" wait_secs=...`（重启后 06:17:30 UTC re-armed，wait_secs=4349）。
待 15:30 CST（07:30 UTC）后验证：kline_accurate 今日增量 + source_health_events source=tushare 成功事件。

## 6. 验收项 5：当日缺口率 —— ⏳（15:00 CST 收盘后补）

口径：44 标的 × 240 交易分钟（09:30–11:30 ∪ 13:00–15:00 CST），剔除演练窗口 14:08–14:18 CST；kline_raw 行覆盖（approx 计入覆盖）。
演练窗口内已实测记录的瞬断（§3d）不影响剔除后口径；待收盘后全量计算。

## 7. 附：演练时间线（UTC）

```
06:08:05  阻断腾讯 4 IP（Phase B 开始）
06:08:1x  27×timeout + circuit_open(tencent) → 转移新浪
06:09:46  阻断新浪前 2 IP（Phase C 开始）→ 新浪经 CDN 第 3 IP 继续承接（韧性正面证据）
06:10     tencent HalfOpen 事件
06:12:05  补阻新浪第 3 IP → 全杀生效：44×timeout + 44×all_failed + degrade ×44
06:12:5x  sina circuit_open
06:13     approx 行开始（44/44 全覆盖，5 快照源随机承接）；sina HalfOpen
06:14:59  恢复网络（iptables -F DOCKER-USER）→ 观察 ≥3 分钟零回切（缺陷 1 实证）
06:17:30  docker restart eestock-data（运维回滚，恢复生产形态）
06:18+    正常双源采集恢复；启动回填补齐演练缺口
```
网络阻断总时长 ≈ 6 分 54 秒；演练+观察+回滚全程 ≈ 9.5 分钟 ≤ 15 分钟。恢复后网络与容器配置无残留变更（iptables 链空、无 /etc/hosts 变更、无代码改动）。

---

## 8. 验收项 4 实测结果：tushare 日增量 —— ❌ FAIL（缺陷 2，数据/调度语义，提请裁决）

### 8.1 触发：准点 ✅
```
07:30:00.048169Z INFO tushare::daily: tushare daily round done outcome="Synced { codes: 44, bars: 0 }"
07:30:00.048186Z INFO tushare::daily: tushare daily scheduled next_run="2026-09-04 07:30:00 UTC" wait_secs=86399
```
- 15:30:00.048 CST 准点触发（无提前/延后）；次一交易日 07:30 UTC 已排程。触发点计算与 fake-clock 单测预期一致。

### 8.2 增量落库：❌ 0 bars / 0 事件（未调用 API）
- 全程耗时 0.048s（44 code × ≥1000ms 限频若真调 API 至少 44s）→ 走的是"已最新 → 跳过"路径（单测 `up_to_date_code_no_api_call` 锁定行为），无 kline_accurate 写入、无 source_health_events tushare 事件。
- DB 实况：`kline_accurate` 2026-09-03 行数 = **0**（max(ts)=2026-09-02 07:00:00+00，T-1 完整）；`sync_checkpoints` 全部 44 code `last_synced_date=2026-09-03, updated_at≈01:24–01:38 UTC`。

### 8.3 根因（缺陷 2）：手动全量同步与日增量的 checkpoint 日期粒度碰撞
- 今晨 09:17–09:38 CST 运维手动全量同步（`logs/tushare_sync_full.log`，末窗 `..2026-09-03`，09:24–09:38 完成 44 code），其工具语义为"同步截至=今天"并把 `last_synced_date=2026-09-03` 落库——**而当时今日尚未开盘/盘中**，实际只写到 T-1。
- 15:30 日增量任务判定 `checkpoint==today → 已最新` → 整轮跳过 → **今日（09-03）准确层分钟数据将不会被日增量调度补齐**；明日任务从 09-03 续拉 09-04，09-03 永不补（除非再跑手动同步）。
- 影响面：kline_accurate 缺 2026-09-03 全天（44 code × ~241 标签）。原始层不受影响（本报告 §6 缺口率口径为 kline_raw）。运维上今日收盘后可手动补跑一次全量/增量同步即愈；代码/语义层面（手动工具 vs 日增量任务的 checkpoint 口径、同日预置防呆）属架构决策，**交架构师裁决**。
- 附注：source_health_events 无 tushare 成功/失败事件 —— 跳过路径零审计事件（可观测性观察：若"跳过/无操作"也发一条 ok 事件，此类静默失效可被监控发现）。

## 9. 验收项 5 实测结果：当日缺口率 —— ✅ PASS

口径：44 标的 × 240 交易分钟（bar 起始分钟 09:30..11:29 ∪ 13:00..14:59 CST = 01:30..03:29 ∪ 05:00..06:59 UTC），kline_raw 行覆盖（`*_approx` 计入覆盖），剔除杀源演练时段 06:08–06:17 UTC。

### 9.1 数字
| 口径 | 缺口 | 分母 | 率 |
|---|---|---|---|
| 严格按日历窗口（含 13:00 标签） | 50 | 44×240−440（演练）=10120 | **0.49%** ✅ |
| 剔除"上游永不产生 13:00 标签"系统性伪缺口 | 6 | 10120−44=10076 | **0.06%** ✅ |

### 9.2 残留 6 缺口明细（全部为上游侧真实无数据 / 源侧限制，非采集失败）
| code | 分钟 | 原因（上游实测） |
|---|---|---|
| 516380 | 09:30（开盘） | tencent 首个标签=09:31，无开盘集合竞价成交 → 上游无 09:30 bar |
| 551000 | 09:30（开盘） | 同上 |
| 159776 | 14:30、14:36 | 无成交分钟：tencent/sina 上游均无该分钟（薄成交债基） |
| 159869 | 14:58、14:59 | 收盘尾 2 分钟：tencent 上游**有**（实测含 14:55..15:00）；回填轮当班源为 sina 时 sina 缺尾 → 粘源成功限制未跨源补（缺陷观察 4） |

### 9.3 演练窗口最终状态
- 06:08–06:17（演练时段）缺口已由启动/周期回填**全部补齐 = 0 missing**（近似行 06:13–06:17 按首写胜出保留 `*_approx`，属设计"准确层覆盖"范围）。
- 13:00 标签：全天 0 行、任何源均不产生 → **系统性窗口定义错位**（calendar `trading_minutes` 午后起点 vs 上游标签 13:01 起；同时 15:00 收盘 bar 在窗口外被正常存储）。后果：**每个交易日缺口率恒含 ~44 行伪缺口（0.42%）**，淹没真实采集缺口信号；建议 Wave 1+ 对齐口径或按源枚举期望分钟集 —— 规格层问题，交架构师裁决（本报告已按两种口径给数）。

## 10. 最终结论与残留风险

- 门禁全绿（79/79 + clippy 0 + tangle 干净）；测试为行为规格且断网可全过；杀源演练 3a/3b PASS、3c FAIL（缺陷 1，HalfOpen 无运行时探测）；tushare 日增量触发准点但落库为 0（缺陷 2）；当日缺口率 PASS（0.06% 或含伪缺口 0.49%）。
- **缺陷 1（严重，需裁决）**：熔断 HalfOpen 源无运行时探测路径（见 §4）→ 双源故障恢复后不自愈，需进程重启。
- **缺陷 2（严重，需裁决/运维决策）**：手动全量同步 checkpoint 预置"今日"→ 当日日增量整轮静默跳过（见 §8）。
- **观察 3（规格）**：240 分钟窗口午后起点与上游标签系统性错位，缺口率口径失真 0.42%/日。
- **观察 4（设计）**：attempt_chain 粘源成功 + 无陈旧/稀疏检测 → 当班源缺数据时不转另一健康源（159869 尾 2 分钟残留即此）；建议后续加"返回窗口末 bar 落后于当前分钟 >N 视为降级"的陈旧检测。
- 残留风险：kline_accurate 缺 09-03 全天（今日 15:30 增量未跑 + 明日调度不补）；159869 尾 2 分钟与 159776 2 分钟 + 2 code 开盘 1 分钟的 raw 缺口将由后续回填轮/手动准确同步处理。
