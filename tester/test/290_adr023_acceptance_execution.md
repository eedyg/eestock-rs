# 290 — ADR-023 本轮 4 次独立验收：证据入库汇总执行报告

- **本文件路径（自指）**：`tester/test/290_adr023_acceptance_execution.md`
- **证据根目录（自指）**：`tester/evidence/adr023/`
- 报告类型：**执行/汇总报告**（把本轮 4 次独立验收的证据链从 `/tmp` 落进仓库；**本轮未设计、未新增、未修改任何测试**，故无 design 报告）
- 性质：**只读归档 + 汇总**。本轮会话**未**运行任何被测命令来复现结论；文档中所有硬读数均为**从证据文件逐字摘录**（路径随行标注），未凭记忆。
- 归档时间：2026-09-17 00:10–00:28（+08:00）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD（本会话开始/结束均未变）：`34dbdc7`（`feat(period): 新增 30m 周期…（ADR-023）`）
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`
- 纪律：只读；**未** `git add/commit/stash`；**未**改 `design/`、实现代码、既有测试文件；**未**重启/杀死在线 app；**未**对活库做任何写；**未**调用任何写 API。新增文件**仅**位于 `tester/` 下。

---

## 0. 4 次验收一览

| # | 轮次 | 判据来源 | 结论（原报告） | 证据子目录 |
|---|---|---|---|---|
| 1 | D1 **上线前**（隔离库 + 静态/只读） | ADR-023 §5.1/§5.3 | **VERDICT: FAIL**（红项 A3(a)：30m 桶数 10 ≠ 旧判据 8；A1/§5.3 多周期子项本轮有意不做） | `tester/evidence/adr023/d1_predeploy/` |
| 2 | D1 **上线后**（在线 8081 真渲染 + 活库只读） | ADR-023 §2.2/§5.2（更正版：30m=10） | `V1–V6/V7` 除 `V4(g)`/`V6` 外 PASS；`V4(g)` **FAIL**（1 次 PUT）、`V6` **NOT-DONE** | `tester/evidence/adr023/d1_postdeploy/` |
| 3 | D2 **离线**（红测试 + 实现 + 收尾小修 + 独立验收） | ADR-023 §2.5/§5.3(D2)/§6.2 | 独立验收 **VERDICT: PASS** | `tester/evidence/adr023/d2_red/`、`d2_impl/`、`d2_fixup/`、`d2_offline/` |
| 4 | D2 **上线后**（D2 部署 + 在线 8081 真渲染） | ADR-023 §6.2 | 部署 **VERDICT: PASS**；上线后验收 **PASS**（残留裁决项 4 条） | `tester/evidence/adr023/d2_deploy/`、`d2_live/` |

---

## 1. 硬读数（逐条给出「判据 → 结论 → 关键原始读数」）

以下 7 条为本轮必须落盘的硬读数。

### 1.1 30m 每日桶数 = 10（44 标的 → 440 行/日），且与 15m=18 / 1h=6 同构

- **判据**：30m cagg 每日每标的 10 桶；44 标的 ⇒ 440 行/日；同法 15m=18（792 行/日）、1h=6（264 行/日），三者几何同构。
- **结论**：**满足**（D1 上线后 V2；D1 上线前曾按旧判据 8 记 FAIL，见 §3.2）。
- **关键原始读数**（`tester/evidence/adr023/d1_postdeploy/EVIDENCE.md` §V2）：

```
kline_accurate_30m | 440 × 12 日 | 44 | 10  | 44×10=440 | ✅
kline_accurate_15m | 792 × 12 日 | 44 | 18  | 44×18=792 | ✅
kline_accurate_1h  | 264 × 12 日 | 44 | 6   | 44×6=264  | ✅
kline_accurate_5m  | 2200 × 12 日| 44 | 50  | 44×50=2200| ✅
```

线上部署直证（`tester/evidence/adr023/d1_deploy/after-30m-daily.txt`，此前无 30m 行）：

```
2026-09-07|440
2026-09-08|440
...
2026-09-16|440
```

15m 对照（`d1_deploy/after-1h-daily.txt`）`2026-09-07|264 … 2026-09-16|264`。
桶起点对齐（`d1_postdeploy/v3_alignment.txt` 摘要）：`minute ∈ {0,30}` 且 `sec=0`，`0→220 行 / 30→220 行`，无第三值。
四者 `max(ts)` 一致（`d1_postdeploy/v2_max_ts.txt`）：

```
kline_accurate      | 2026-09-16 07:00:00+00 | 16344861
kline_accurate_5m   | 2026-09-16 07:00:00+00 | 3391050
kline_accurate_15m  | 2026-09-16 07:00:00+00 | 1220778
kline_accurate_30m  | 2026-09-16 07:00:00+00 | 678210
kline_accurate_1h   | 2026-09-16 07:00:00+00 | 406933
```

逐桶逐字段（`d1_postdeploy/v3_daywide_diff.txt`）：`c30_rows=440 / m1_buckets=440 / only_in_30m=0 / only_in_m1=0 / field_mismatch=50`，且 50 处**全部且仅仅** `amount` 不等（`|Δ| ≤ 2.98e-8`，double 求和序 ULP），其在**既有 15m 上同样存在且更广**（15m `792 桶 / 111 桶 amount 不等`）⇒ 判为与既有几何同构、非 30m 特有。

### 1.2 5m 缺口补齐（09-08 … 09-16 由全 0 → 每日 2200）

- **判据**：`kline_accurate_5m` 自 2026-09-07 起每日 0 行（既有缺陷，ADR §2.4.1），本轮 ADR §2.4 修复后必须补齐为 44×50 = 2200 行/日。
- **结论**：**满足**。
- **补齐前**（`d1_deploy/baseline-5m-daily.txt` 全文，仅 1 行）：

```
2026-09-07|2200
```

（即 09-08 起无行；ADR §2.4.1 表载 `09-08/09-09/09-10/09-11 = 0/0/0/0`、`09-14/09-15/09-16 = 0/0/0`，`max(ts) = 2026-09-07 07:00Z`。）
- **补齐后**（`d1_deploy/after-5m-daily.txt` 全文）：

```
2026-09-07|2200
2026-09-08|2200
2026-09-09|2200
2026-09-10|2200
2026-09-11|2200
2026-09-14|2200
2026-09-15|2200
2026-09-16|2200
```

- 佐证（`d1_postdeploy/EVIDENCE.md` §V2）：`missing_5m = missing_15m = missing_30m = 0`（对 `kline_accurate` 的 M1 日集合 anti-join，两次独立复跑一致，`v2_day_antijoin_repeat.txt`）⇒ 3572 个交易日全覆盖。

### 1.3 四条冻结密度值 24.1 / 5.0 / 1.8 / 1.67 及来源

- **判据**：ADR-023 §2.5「30m 配对禁用 composed（强制）」——`1m:30m=24.1`、`5m:30m=5.0`、`15m:30m=1.8`、`30m:1h=1.67`，须为**真渲染直接实测**（P0.3 口径：pane 520px、多取样逐位一致、禁名义比兜底）。
- **结论**：**满足**；四条值在红阶段测量、独立复算、实现表、设计文档、线上读数五处一致。
- **来源链**（三级）：
  1. **原始实测**：`tester/evidence/adr023/d2_red/EVIDENCE.md`（方法 §1.1：真渲染 klinecharts 10.0.3 UMD、两实例并排、pane 宽 520px、`probe_result.json` 记录 `panes.getSize().width === 520`），原始 JSON `d2_red/probe_result.json` / `probe_result_b.json`。
  2. **独立重算**（`d2_offline/A2_density_recompute.txt`，离线验收方独立复算，声明值↔复算值逐条一致）：

```
PAIR 1m:30m  (file probe_result.json )   frozen table value = 24.1
  (1) K8  equal-time-window median recomputed = 24.1 (declared 24.1, valid 5)
      K16 equal-time-window median recomputed = 24.1 (declared 24.1, valid 6)
  (2) per-day 241/10 = 24.1 …full-day ratio set (unique): [24.1]
PAIR 15m:30m (file probe_result.json )   frozen table value = 1.8
  (1) K8 = 1.8 / K16 = 1.8 ; full-day ratio set (unique): [1.8]
  (3) day-scale D_ceil [1.7826, 1.8889] / D_floor [1.5714, 1.8]
PAIR 5m:30m  (file probe_result_b.json)  frozen table value = 5.0
  (1) K8 = 5.0 / K16 = 5 ; full-day 50/10 = 5.0 ; 包络 (3) [5, 5.4444]
PAIR 30m:1h  (file probe_result_b.json)  frozen table value = 1.67
  (1) K8 = 1.6667 / K16 = 1.6667 ; full-day 10/6 = 1.6667 ; 包络 (3) [1.5714, 1.7]
```

  3. **落实现场**（`d2_impl/effective_density_probe.txt`，实现后运行时读取解析结果）：

```
TABLE 1m:30m = 24.1     TABLE 5m:30m = 5     TABLE 15m:30m = 1.8     TABLE 30m:1h = 1.67
EFFECTIVE 1m:30m  -> ratio=24.1   source=static
EFFECTIVE 5m:30m  -> ratio=5      source=static
EFFECTIVE 15m:30m -> ratio=1.8    source=static
EFFECTIVE 30m:1h  -> ratio=1.67   source=static
```

- **旁证（非表值来源，仅参考）**：D1 上线后曾以「基准日根数 ÷ 卫星日根数」旁推 `1m:30m ≈ 241/10 = 24.1`（`d1_postdeploy/EVIDENCE.md` §V6），明确标注**不得直接入表**；D2 真渲染定标后与表值一致。名义比（30 / 6 / 2 / 2）**一律禁用**。
- **落表位置**：`design/15-multi-period/02-spec.md` §3.2 新增 4 行 + 冻结口径注（diff 见 `d2_fixup/EVIDENCE.md` §②）；`web/src/features/dashboard/chartSyncGroup.ts` 表体（`d2_offline/EVIDENCE.md` §A2(a)#3）。

### 1.4 线上 `densityByFollower` 的 30m 项：`source=static`，比值 1.8 与 24.1

- **判据**：ADR-023 §2.5 不变量断言——30m 的任一配对经 `effectiveDensity` 解析必须为 `source='static'`（**永不使用 composed**）；且比值须精确等于冻结实测值。
- **结论**：**满足**（线上真渲染，非离线段）。
- **关键原始读数**（`tester/evidence/adr023/d2_live/EVIDENCE.md` §2 表 + `d2_live/result.json`）：

| 组合 | PUT 回显 periods | groupEstablished | syncableFollowerCount | `densityByFollower["30m"]` | 判定 |
|---|---|---|---|---|---|
| 基准 15m / 卫星 30m | `["15m","30m"]` | true | 1 | `{ratio: 1.8, source: "static"}` | PASS |
| 基准 1m / 卫星 30m | `["1m","30m"]` | true | 1 | `{ratio: 24.1, source: "static"}` | PASS |

`result.json` 原文（行号见文件）：`"densityByFollower": { "30m": { "ratio": 1.8,  "source": "static" } }`（L386-391、L1104-1109、L1130-1135）；`"30m": { "ratio": 24.1, "source": "static" }`（L566-571）。`excludedSatellites=[]`。

### 1.5 对齐 drift = 0.5 根卫星 bar

- **判据**：287 口径（复用）——有界闭环下右缘残差须 ≤ 1 根卫星 bar，且**不得虚假对齐**（能对齐时无角标，不能对齐时可见降级 + 可行动 title）。
- **结论**：**满足**。
- **关键原始读数**（`d2_live/EVIDENCE.md` §4.1 + `d2_live/result.json`）：

```
基准 15m: realFrom/realTo 13/87 ; realFromTs 1788918300000 / realToTs 1789438500000 ; spanMs 520200000
卫星 30m: realFrom/realTo 240/281; realFromTs 1788917400000 / realToTs 1789437600000 ; spanMs 520200000
跨度差 = 0 ms ; 右缘残差 = 900000 ms = 15 min = 0.5 根卫星 bar（30m bar）
stats: degraded=false, lastSpanDiffMinutes=15, spanResidualBars=0.5, edgeResidualBars=0.5,
       applied=40, suppressed=205, density={30m:{1.8,static}}
DOM: [data-mp-sync-degraded] 不存在（domAfterDrag degraded=[null]）
```

（`result.json` L1123–L1126 原文：`"lastSpanDiffMinutes": 15, "spanResidualBars": 0.5, "edgeResidualBars": 0.5`。）
退化必须可见的对照（同 §4.2）：缩放后 `degraded=true`、`degradedPeriod="30m"`、`lastSpanDiffMinutes=5775`、`spanResidualBars=192.5`、`lastUnalignedReason="30m:no-improvement"`、DOM `[data-mp-sync-degraded="30m"] data-mp-span-diff-min="5775"` 且 `visible=true`；`1m→30m` 组合 `lastUnalignedReason="30m:unreachable"`、`spanResidualBars=2.27`、`edgeResidualBars=0.567`。
**30m 基准 1d 卫星**（`d2_live/EVIDENCE.md` §3a）：`[data-mp-sync-excluded="1d"] data-mp-sync-excluded-reason="no-shared-anchor"`，`groupEstablished=false`、`groupReason="no-syncable-follower"`，**非静默**。

### 1.6 `unsupported-period` 命中 0

- **判据**：30m 与 7 档已提供周期的任一配对**均不返回** `unsupported-period`。
- **结论**：**满足（命中 0）**。
- **关键原始读数**：
  - 线上（`d2_live/EVIDENCE.md` §3e）：`全程 result.json 中 unsupported-period 命中 0 次（grep -c = 0）`；实测复算：`grep -o 'unsupported-period' tester/evidence/adr023/d2_live/result.json | wc -l` ⇒ **0**。
  - 离线（`d2_offline/EVIDENCE.md` §A5）：5 条原因码逐条命中；30m 与 7 档已提供周期的任一配对均不返回 `unsupported-period`。
  - 实际观测到的原因码仅：`no-shared-anchor`（卫星排除）与 picker 禁用原因「`1w` 需基准 ≥ `1d`」。

### 1.7 隔离库全链 0001→0026 rc=0，且 0026 重跑幂等

- **判据**：全新安装（隔离库）逐迁移 `ON_ERROR_STOP=1` 全部 `rc=0`；`0026_period_30m.sql` 重复执行幂等。
- **结论**：**满足**。
- **关键原始读数**（`tester/evidence/adr023/d1_predeploy/`）：
  - 全链（`raw/A2_apply.log` 末尾）：`RC_ALL=0`；期间 `grep -iE 'ERROR|FATAL'` **0 命中**；`raw/A2a_caggs.txt`：

```
=== A2a cagg count/list ===
10
kline_15m / kline_1d / kline_5m / kline_accurate_15m / kline_accurate_1d
kline_accurate_1h / kline_accurate_1mo / kline_accurate_1w
kline_accurate_30m / kline_accurate_5m
```

  - 0026 重跑幂等（`raw/A2b_rerun0026.txt`）：

```
psql:migrations/0026_period_30m.sql:21: NOTICE:  continuous aggregate "kline_accurate_30m" already exists, skipping
... remove_continuous_aggregate_policy ×4 ... add_continuous_aggregate_policy → 1023/1024/1025/1026
psql:...:52/53/54: NOTICE: continuous aggregate "kline_accurate_30m"/"5m"/"15m" is already up-to-date
rerun_rc=0
=== post-rerun cagg count + jobs ===
10
1023|policy_refresh_continuous_aggregate|00:01:00|3 days|00:01:00
1024|policy_refresh_continuous_aggregate|00:01:00|3 days|00:01:00
1025|policy_refresh_continuous_aggregate|01:00:00|3 days|01:00:00
1026|policy_refresh_continuous_aggregate|01:00:00|3 days|01:00:00
```

（4 条策略先 `remove_continuous_aggregate_policy` 再 `add_…`，净增 0 条重复策略；cagg 仍 10 个。）
  - 隔离库 `eestock_verify_30m` / `eestock_verify_mut` 均已 `DROP DATABASE`，无残留（`raw/A8_cleanup.txt`、`raw/A8_sideeffects.txt`）。
  - 线上策略参数量测（`d1_postdeploy/v2_jobs.txt` 摘要）：job 1051 `kline_accurate_5m`、1052 `kline_accurate_15m`、1053 `kline_accurate_30m`（新建）、1054 `kline_accurate_1h`，`start_offset` 统一 `3 days`。

---

## 2. 分节：4 次验收的「判据 → 结论 → 关键原始读数」

### 2.1 第 1 次：D1 上线前（`tester/evidence/adr023/d1_predeploy/`）

- **原报告路径**：`/tmp/adr023-verify-1789570824/EVIDENCE.md`（已复制，本报告内为 `d1_predeploy/EVIDENCE.md`）
- **对象**：HEAD `3094018f…`；隔离库全链 + 桶正确性 + 变异 A + 只读活库复核。
- **原结论**：**VERDICT: FAIL**。
- **红项**（原文）：
  - **A3(a)**：生产数据形态下 30m 桶数 = **10 ≠ 判据 8**。
    ```
    $ SELECT count(*) FROM kline_accurate_30m WHERE code='VERIFY30M';  →  10   ← 不是 8
    桶→1m 行数：09:30|30 10:00|30 10:30|30 11:00|30 11:30|1 13:00|29 13:30|30 14:00|30 14:30|30 15:00|1
    只读活库同法复核（真实 M1）：159337|10 159577|10 159638|10 159740|10 159742|10  -- 生产形态 = 10 桶/标的/交易日
    对照组（理想化 240 根）：bars_240 = 240 ; buckets_240 = 8   -- raw/A3_supp.txt ⇒ 桶口径逻辑本身可产出 8
    ```
    成因（原文）：生产约定为 **09:30…11:30（含，121 根）+ 13:01…15:00（120 根）= 241 根/日，无 13:00**，故 30m 桶数为 10（含 11:30 / 15:00 两个 1 根薄桶）。
  - **A1 / ADR §5.3 多周期子项**：30m 未进多周期白名单（`MULTI_PERIOD_ALLOWED` = 6 档无 30m）——**按任务 A7 属本轮有意范围，D2 才开**。
- **绿项**：A1–A13 其余全部有独立证据且绿，含 §1.7 的隔离库全链与幂等、A8 无残留、A13 活库仅只读 `SELECT`。
- **纪律旁证**（原文）：验收期间在线 8081/8082 的 PID 与开工时相同（未触碰）；未执行 `git add/commit/stash`；变异测试只在 `/tmp/adr023-mut/` 副本内做。
- **本轮的定位**：该 FAIL 是**判据本身错误**（旧判据 8 桶/日），已由更正后的 ADR §2.2/§5.2（30m = 10 桶/日）裁决，并在第 2 次验收中按更正判据复核为 PASS。

### 2.2 第 2 次：D1 上线后（`tester/evidence/adr023/d1_postdeploy/`）

- **原报告路径**：`/tmp/adr023-postdeploy-20260916T151312Z/EVIDENCE.md`（已复制）
- **对象**：在线实例 `127.0.0.1:8081`（PID 68833）+ 活库 `eestock` @5433；判据 V1–V7 由架构师下达。
- **分项结论**：

| 项 | 判据 | 结论 | 关键原始读数 |
|---|---|---|---|
| V1 全量回归 | 含 `--tests` 集成目标全绿 | **PASS** | `cargo test --workspace --tests` **88 个 test result 段全 ok，715 passed / 0 failed / 1 ignored，EXIT=0**；7 个 `period30m_*` 目标独立复跑 **20 passed / 0 failed / EXIT=0**；`check-tangle.sh` `✅ design 与生成物一致` EXIT=0；`npx vitest run` **87 files / 814 passed** EXIT=0；`npm run build` `✓ 180 modules transformed` EXIT=0 |
| V2 活库只读正确性 | 30m=440、15m=792、1h=264、5m=2200；四者 `max(ts)` 一致；5m 缺口补齐；1h 无缺口 | **PASS** | 见 §1.1 / §1.2；`missing_1h = missing_5m = missing_15m = missing_30m = 0`；`min(ts)` 5m/15m/30m 均 `2012-01-04 01:30:00+00`；cagg 视图无 `ts >= '2024-01-01'` 类过滤 |
| V3 生产数据逐桶 | 双向差集 0/0；桶起点对齐；`open=first/high=max/low=min/close=last/volume=sum` 严格相等 | **PASS（附 ULP 附注）** | 440 桶 `only_in_30m=0 / only_in_m1=0`；50 桶仅 `amount` 差 `≤2.98e-8`（既有 15m 111/792 同现象）；起点 `0→220 / 30→220`，`sec=0` |
| V4 真渲染 | 工具栏 8 档严格有序；点击 30m → 200；蜡烛真渲染；铺满；0 console error；多周期不含 30m；(g) 无写请求 | (a)(b)(c)(d)(e)(f) **PASS**；**(g) FAIL** | `"ordered_first_8": ["1m","5m","15m","30m","1h","日","周","月"]`、`contiguous: true`；`GET /api/kline?...period=30m...` **200**；`candleColumns=560 > 0`；`console_errors: []`；picker 只给 `1m/5m/15m/1h/1d/1w`；探针 2 方法直方图 `{"GET": 11, "PUT": 1}` |
| V5 实时右缘 | 最新查询 + WS 订阅被接受 | 部分 **PASS**，实时增量推进 **NOT-OBSERVABLE** | `bars=240, last=2026-09-16T07:00:00Z`；WS `frame_count=1`，`bar` 帧 `period=30m`；当时为北京 23:1x 已收盘 |
| V6 实测密度 `1m:30m` | P0.3 口径真渲染定标 | **NOT-DONE** | D1 实例上**结构不可做**（多周期不含 30m ⇒ 无 520px pane 可量）；仅给旁证 `241/10 = 24.1`，明示「不得直接入表」 |
| V7 副作用审计 | 仓库零改动、进程未重启、无写 API | 除写请求外全 ✅ | `GIT_STATUS_IDENTICAL`（sha256 前后同）、`HEAD_IDENTICAL`、staged=0、PID 68833 同命令行、8081 `/`=200 |

- **`(g)` FAIL 的原始读数**（`d1_postdeploy/EVIDENCE.md` §V4(g) 与 §V7）：`"method_histogram": {"GET": 11, "PUT": 1}`、`write_requests: [{"method":"PUT","url":"http://127.0.0.1:8081/api/config/multi_period"}]`；活库佐证 `app_config.updated_at = 2026-09-16 15:18:09.178116+00`（只读 SELECT）。**该归因已于第 3/4 次验收中被自证伪并撤回，见 §3.1**。

### 2.3 第 3 次：D2 离线（`d2_red/` + `d2_impl/` + `d2_fixup/` + `d2_offline/`）

- **四个子阶段的原始报告**：`/tmp/adr023-d2-red-20260916T152240Z/`（红阶段 + 520px 真渲染密度测量）、`/tmp/adr023-d2-impl-20260916T154107Z/`（实现）、`/tmp/adr023-d2-fixup-20260916-234640/`（收尾小修）、`/tmp/adr023-d2-verify-offline-20260916T155256Z/`（独立离线验收）。
- **独立验收结论**：**VERDICT: PASS**（`d2_offline/EVIDENCE.md` 首部）。
- **判据 → 结论 → 关键原始读数**（`d2_offline/EVIDENCE.md` §0 摘要表）：

| 判据 | 结论 | 关键原始读数 |
|---|---|---|
| A1 picker 测试结构性复核（未放宽断言） | PASS | token 计数逐项一致：`expect( 83/83`、`it( 17/17`、`describe( 4/4`、`toEqual( 19/19`、`toContain( 5/5`、`not.toContain( 3/3`、`filter( 6/6`、`toHaveLength( 2/2`、`toBe( 33/33`、`toBeTruthy( 1/1`、`toBeNull( 14/14`；行数 BEFORE=713/AFTER=713；`--word-diff` 全文仅 `3 × +'30m',` + 2 处描述串 |
| A1(b) 三条期望等价于契约推导（独立契约模型可执行复算） | PASS | `[A1] step1 = ["1m","5m","15m","30m","1h","1d","1w"]`；`base=15m enabled = ["15m","30m","1h","1d"]`；`Tests 4 passed (4) EXIT=0` |
| A2 改动集逐条对齐契约 + 四条密度独立重算 | PASS | 6 处逐条命中；四条冻结值与红阶段原始实测**逐条一致**（见 §1.3） |
| A3 变异反证（/tmp 副本） | PASS | a：去 mock 30m ⇒ **3 红**；b：`15m:30m` 改 **1.9754** ⇒ **2 红（含不变量）**；b2：删条目 ⇒ 不变量 `source='composed'` 红 |
| A4 全量回归独立复跑 | PASS | vitest **88 files / 839 passed**；build 0；cargo **88 目标 721 passed / 0 failed / 1 ignored**；tangle 0；与 worker 自报零差异 |
| A5 诚实降级复核 | PASS | 5 条原因码逐条命中；**不返回 `unsupported-period`**（见 §1.6） |
| A6 边界与不变量 | PASS | `1mo` 仍不提供；既有 5 条密度值**逐字未变**；`01-adr.md` 逐字节未变；`static→composed→measured→none` 优先级未动 |
| A7 副作用审计 | PASS | 版本化文件全体逐字节相同；HEAD 未变；无 staged；无残留；活库 `app_config` 未变；app 未触碰（PID 68833 全程存活） |

- **收尾小修（`d2_fixup/EVIDENCE.md`，VERDICT: PASS）**：`web/src/api/mock.ts` 唯一周期序点 `MOCK_MULTI_PERIOD_ORDER` 由 `['1m','5m','15m','1h','1d','1w']` 修为 `['1m','5m','15m','30m','1h','1d','1w']`（修复前含 30m 配置被误判 400）；`design/15-multi-period/02-spec.md` §3.2 新增 4 行（既有 5 条 D 值行逐字未动）；`multiPeriodMockParity.test.ts` 新增 3 条 parity 断言（`it(` 2→5，该文件 20→23 用例）；`check-tangle.sh` `exit=0`。
- **红阶段测量口径（`d2_red/EVIDENCE.md` §1.1）**：真渲染 klinecharts `10.0.3` UMD，两独立实例并排，pane 宽 **520px**（`getSize().width === 520` 实测记录于 `probe_result.json.panes`），`layout.barSpaceLimit` 放开；`pageErrors=[]`、`externalRequests=[]`。诚实标注：`D(1m→30m)` 在**窗宽**上仍有系统噪声（24.0–26.7 属真实几何，非测量误差），故表值取「整日/等时窗中位数」`24.1`（与既有 5 条同口径）**并给包络**。

### 2.4 第 4 次：D2 上线后（`d2_deploy/` + `d2_live/`）

- **部署车道**（`/tmp/adr023-d2-deploy-20260916-235846/EVIDENCE.md`，首行 **VERDICT: PASS**）：
  - 部署物：D2（多周期接入 30m）—— 后端 `crates/web/src/dto.rs`（白名单 7 档 + rank 插位）+ 前端 dist 入口 bundle。
  - 关键读数：`/healthz` 200、`/api/symbols` = **44**、`period=30m` 端到端 **200 且 60 bars**、启动日志 **ERROR=0**、8081/8082 均属新 PID、**S3 回滚路径未触发**。
  - bundle 内新契约存在性：`count of "30m" in served /assets/index-J50SI06a.js: 8`；四条冻结密度键各出现 1 次（`1m:30m` / `5m:30m` / `15m:30m` / `30m:1h`）。
  - `multi_period_config.json`（部署往返快照）= `{"enabled":false,"periods":["1m"],"heights":{"1m":420},"indicators":["dcap"]}`。
- **上线后独立验收**（`/tmp/adr023-d2-verify-live-20260917-000127/EVIDENCE.md`）：
  - **结论**：30m 在线上多周期中真实可用；选择器两步均提供 30m 且顺序正确（`1mo` 不提供）；`15m↔30m` 与 `1m↔30m` 均 `groupEstablished=true`、`syncableFollowerCount=1`，密度读数 `source=static` 且精确等于冻结实测值 `1.8` / `24.1`；对齐退化一律可见且带可行动 title；无 `unsupported-period`，无静默。
  - **强制规程（ADR §6.2）`app_config.multi_period` 前后快照**：
    | 时点 | value | updated_at |
    |---|---|---|
    | **T0 = 会话前 00:01** | **无该行（键 ABSENT）** | 无 |
    | T-mid 16:04:46Z | `{"enabled":true,"heights":{"1m":420},"periods":["1m"],"indicators":["dcap"]}` | `2026-09-16 16:04:46.062696+00` |
    | **T1 = 会话后 16:06:17Z** | `{"enabled":true,"heights":{"15m":420,"30m":180},"periods":["15m","30m"],"indicators":["dcap"]}` | `2026-09-16 16:06:17.320858+00` |
  - **B1 选择器实渲染顺序**：步骤 1（基准）= `1m, 5m, 15m, 30m, 1h, 1d, 1w`；步骤 2（卫星）随基准收窄：`base=1m → 1m,5m,15m,30m,1h,1d,1w`、`base=15m → 15m,30m,1h,1d,1w`、`base=30m → 30m,1h,1d,1w`、`base=1h → 1h,1d,1w`、`base=1d → 1d,1w`；`1mo` 两步骤均不存在。
  - **B2**：见 §1.4。**B3**：30m 基准 + 1d 卫星可达且 `no-shared-anchor` 非静默；30m 基准 + 1w 卫星在 picker 层以「`1w` 需基准 ≥ `1d`（避免恒退化）」禁用；**1h 基准 + 30m 卫星结构性不可达**（picker 强制候选 ≥ 基准，`sanitizeSelection` 主动丢弃非法已选项）。**B4**：见 §1.5。
  - **B5 只读与副作用审计**：`{"GET": 21, "PUT": 6}`，无 POST/PATCH/DELETE；6 条 PUT 全为 `PUT /api/config/multi_period`（**多周期开关 1 次 + 选择器「确定」5 次**，body 全量列出）；`consoleAll=[]`（含 error 级 0 条）、`pageErrors=[]`；无 core dump、无崩溃；仓库零改动；HEAD 未变；在线 PID 未变（178558）。
  - **与任务前提的偏差（重要，已如实登记）**：「打开 `data-testid=mp-periods-open` 入口即触发 PUT」**未被观测到**（脚本记录 `[picker open] 触发请求 = []`）。已按实测记录。

---

## 3. 已知偏差、撤回项与债务登记（如实，交叉引用 ADR-023 §6.1）

### 3.1 【撤回】F1「多周期选择器‘打开即写服务端’」——**已自证伪并撤回**

- **当初结论**（第 2 次验收 `d1_postdeploy/EVIDENCE.md` §V4(g) / §V7）：「打开多周期选择器入口 ⇒ 页面自动 PUT，属越权写」，并记为残留风险 R1「需架构师裁决」。
- **撤回依据**（ADR-023 §6.1 第 5 条，原文）：精确插桩（**逐动作**记录请求）后实测——打开入口 `data-testid="mp-periods-open"` **不产生任何请求**（`[picker open] 触发请求 = []`）；PUT 实际来自**真实用户动作**：**「多周期」开关 1 次 + 选择器「确定」5 次** ⇒ 属**预期行为**（ADR-022 §12：每实例布局落服务端 config），**无需修复**。
- **根因**：初版归因**用整段会话的方法汇总去归因单个动作**（会话级 `{"GET":11,"PUT":1}` 反推到「打开选择器」）。
- **教训（已写入纪律）**：凡「某 UI 动作产生了写」的结论，**必须逐动作插桩取证**，不得用会话级汇总反推。
- **落地佐证**：第 4 次验收（`d2_live/EVIDENCE.md` §0「与任务前提的偏差」）再次独立复现「入口不写、开关/确定才写」，6 条 PUT body 全量可逐条对上。

### 3.2 ADR §2.5「包络列」笔误——**已修**

- 第 1 次验收暴露判据口径错误（`30m 桶数 10 ≠ 8`，见 §2.1）；更正后的 ADR §2.2/§5.2 采用 30m = 10 桶/日。
- 另登记：ADR §2.5 包络列曾把 `15m:30m` 的包络误写成 `30m:1h` 的包络（即 `15m:30m` 曾误用 `[1.63, 1.69]`），**已修**；现行正确值见 ADR §2.5 表（`15m:30m` 包络 `[1.78, 1.89]`，取整日中位 `1.800`）与本节 §1.3 的独立重算读数（`D_ceil [1.7826, 1.8889]`）。

### 3.3 既有 5 条密度值口径陈旧 + `composed` 优先级高于实测（ADR §6.1 第 7 条）

- **证据 A（口径不一致）**：同法重测 `1m→15m` = **13.389**，而表值为 **12.2**。
  - 原始读数：`d2_offline/A2_density_recompute.txt` → `PAIR 1m:15m … K8 median recomputed = 13.3889 / K16 = 13.3889`；`full-day ratio set (unique): [13.3889]`；`all-sample D_ceil median = 13.4167`。
- **证据 B（compose 与直接实测不符）**：`composeDensity('15m','30m')` = `24.1/12.2` = **1.9754**，而直接实测 = **1.800**（**+9.7%**）。
- **证据 C（造成实际错对齐的机制）**：`chartSyncGroup.ts:986` 的 `effectiveDensity()` 解析顺序为 **static → composed → measured → none** ⇒ `composed` 的值被当作**缩放比**使用，且**优先于运行时实测**。
- **处置**：本轮**不改既有行为**（既有 5 条表值逐字不动，已由 `d2_offline` §A6 与 `d2_fixup` §② 双向验证）；新 30m 配对以「直接条目」规避（ADR §2.5）。**待裁决**：① 把 `measured` 提到 `composed` 之前；② 为所有受支持配对补直接实测值；③ 维持现状仅登记。

### 3.4 `kline_accurate_1d` 落后 1–2 交易日（ADR §6.1 第 6 条）

- 原始读数：`d1_postdeploy/EVIDENCE.md` → `kline_accurate_1d max(ts) = 2026-09-14 16:00Z`（登记时点 2026-09-16，落后 **2** 个交易日；同段文字亦述「落后 1–2 交易日」）。被 `kline_1d` 兜底掩盖 ⇒ 未暴露。本轮不在 D1 范围，登记待排查。
- 佐证读数：`d1_postdeploy/v2_daily_counts.txt` 摘要 `kline_accurate_1d | 44/日（落后至 09-14，不在 V2 判据内）`。

### 3.5 测试隔离债：集成测试读写共享 dev 库 `app_config`（ADR §6.1 第 8 条）

- 既有 `crates/web/tests/api_settings.rs:88`（`DELETE FROM app_config WHERE key IN (...)`，注释自认「共享 dev 库」）与 `crates/storage/tests/config_store.rs` 直接读写活库该表；本轮新增的 D2 测试也会对活库发 `PUT /api/config/multi_period`（已做快照 + 恢复自隔离，但**仍会临时改活库**）。
- 实测佐证：线上 `multi_period` 键在 15:52Z 的一轮测试后**一度不存在**（GET 退默认）。全仓测试隔离作为**独立债**登记。

### 3.6 `satellite-lower-than-base` 结构性不可达（ADR §6.1 第 10 条）

- 真渲染实测（`d2_live/EVIDENCE.md` §3c）：选择器强制「候选 ≥ 基准」，故 **1h 基准 + 30m 卫星在 UI 层构造不出来**（由单测覆盖），该项**未被观测**，列为裁决项。同理 `30m↔1w` 的降级只体现在 picker 禁用原因上（「`1w` 需基准 ≥ `1d`」），不进同步层原因码。
- 离线侧原读数（`d2_impl/effective_density_probe.txt`）：`REASON 1h->30m = satellite-lower-than-base allowed=false`、`REASON 1d->30m = satellite-lower-than-base allowed=false`（逻辑可达、UI 不可达）。

### 3.7 强缩放下 30m 卫星 degraded（ADR §6.1 第 9 条）

- 原始读数（`d2_live/EVIDENCE.md` §4.2）：缩放后 `degraded=true`、`degradedPeriod="30m"`、`lastSpanDiffMinutes=5775`、`spanResidualBars=192.5`、`lastUnalignedReason="30m:no-improvement"`；`1m↔30m` 强缩放下 `lastUnalignedReason="30m:unreachable"`、`spanResidualBars=2.27`、`edgeResidualBars=0.567`。属**诚实降级**（产物 DOM 可见 + 可行动 title，非缺陷），但意味着 30m 与 1m/15m 近比配对在高倍缩放下**长期处于「对齐受限」**，体验/可用性取舍交由父级。
- 对照（对齐态）：§1.5 的 `spanResidualBars=0.5`、`edgeResidualBars=0.5`、`degraded=false`、DOM 无角标 ⇒ **无虚假对齐**。

### 3.8 面不齐：多条既有夹具/标题只列 6–7 档（ADR §6.1 第 11 条）

- 涉及 `Toolbar.test.tsx:58-60`、`feed.test.ts:15`、`mock.test.ts:687`、`multiPeriodSatellite*.test.tsx`、`syncCoverage.test.ts:343`。
- 实测**不产生假绿**（严格 8 档由 `period30m.test.tsx` J8-b 覆盖），但违反 §6.2「契约变更全域扇扫」的面要求。

### 3.9 其它已登记但未闭环项（供父级裁决，非本轮判据）

| # | 项 | 出处 |
|---|---|---|
| a | 30m 刷新策略 `end_offset`/`schedule_interval` = 1 hour（沿用 1h 先例）⇒ 最坏物化滞后 ~1h；ADR §2.4.4 只裁决 `start_offset` | ADR §6.1 第 4 条；`d1_postdeploy/v2_jobs.txt` job 1053 |
| b | V3 的 `amount` 非位级相等（50/440 桶，`≤2.98e-8`；既有 15m 111/792）——若验收要求位级相等，V3 应记不满足 | `d1_postdeploy/EVIDENCE.md` R3 |
| c | 档位清单散落 8 处无单一事实源；手写文件无漂移门禁（`Toolbar.tsx`/`chartSyncGroup.ts`/`multiPeriodPicker.tsx` 不在 `file=` 声明内） | ADR §6.1 第 1、2 条 |
| d | 线上 `multi_period` 配置被第 4 次验收按其规程改为 `enabled:true / ["15m","30m"]`（**未自行恢复**），是否保留/还原由父级裁决 | `d2_live/EVIDENCE.md` §6 残留风险 4 |
| e | 第 2 次验收的实际用时约 35 分钟（超 30 分钟盒 5 分钟），`V6` 为 `NOT-DONE` | `d1_postdeploy/EVIDENCE.md` R6 |

---

## 4. 证据归档范围与取舍（重要：本轮的复制取舍与源目录状态）

### 4.1 源目录存在性核对（`ls -d /tmp/adr023-*` 实况）

本会话开始时 `/tmp` 下实际存在 **16** 个 `adr023-*` 条目（`ls -d` 原文）：

```
/tmp/adr023-d2-deploy-20260916-235846        /tmp/adr023-impl-20260916-224717
/tmp/adr023-d2-fixup-20260916-234640         /tmp/adr023-impl-current      （空目录/符号残留）
/tmp/adr023-d2-impl-20260916T154107Z         /tmp/adr023-mut              （248M，整仓 rsync 副本）
/tmp/adr023-d2-impl-dir.txt                  /tmp/adr023-postdeploy-20260916T151312Z
/tmp/adr023-d2-red-20260916T152240Z          /tmp/adr023-red-20260916-224257
/tmp/adr023-d2-verify-live-20260917-000127   /tmp/adr023-redtree          （122M，整仓副本）
/tmp/adr023-d2-verify-offline-20260916T155256Z /tmp/adr023-ts.env
/tmp/adr023-deploy-20260916-230726           /tmp/adr023-verify-1789570824
```

**结论：任务书中预期的 8 个证据目录全部存在，无任何一处已被清理。** 另有 4 个本条任务未点名但同属本轮的目录（`adr023-red-*`、`adr023-impl-*`，以及两个整仓副本 `adr023-mut` / `adr023-redtree`）也已一并盘点、并在下文说明取舍。

### 4.2 已复制（`tester/evidence/adr023/`，按 run 分子目录）

| 子目录 | 来源 `/tmp` 目录 | 复制内容 | 取舍说明 |
|---|---|---|---|
| `d1_predeploy/` | `adr023-verify-1789570824` | `EVIDENCE.md` + **整个 `raw/`**（约 45 个小文本/SQL/log） | 源目录仅 292K，**全量净文本**；无大二进制，无需取舍 |
| `d1_deploy/` | `adr023-deploy-20260916-230726` | `EVIDENCE.md` + 全部 `*.txt` / `*.json` / `*.headers` / `.ts` | **排除** `eestock-app.rollback`（**207 MB** 二进制）与其余产物二进制/bundle。判据所需的 `baseline-*-daily.txt` / `after-*-daily.txt` / `smoke-*.json` 均已保留 |
| `d1_postdeploy/` | `adr023-postdeploy-20260916T151312Z` | `EVIDENCE.md` + 全部 `*.txt` / `*.json` / `*.cjs` + **2 张截图**（`v4_b_30m_main.png`、`v4_c_multi_period_picker.png`） | **排除** 另 2 张截图（`v4_a_default_15m.png`、`v4_b_30m_canvas.png`，与已保留者同判据）；未复制 `*.log` 原始大日志（`v1_cargo_workspace.log` 等，结论已逐行摘入 `EVIDENCE.md`） |
| `d2_red/` | `adr023-d2-red-20260916T152240Z` | `EVIDENCE.md` + 全部 `*.json`（含 `probe_result{,_b}.json`）+ 全部 `*.txt` + `run.mjs` + `data/`（6 个 kline JSON 快照 + `app_config` 快照）+ **2 张截图**（`shot_15m_30m.png`、`shot_1m_30m.png`） | **排除** `klinecharts.min.js`（第三方 UMD）与另 3 张截图；**排除** `*.before.*` / `diff_*.diff` 源码形态副本（其结论已逐字摘入 `EVIDENCE.md`）。四条冻结密度值的原始 JSON 已完整保留 |
| `d2_impl/` | `adr023-d2-impl-20260916T154107Z` | `EVIDENCE.md` + 全部 `*.txt` | 源目录 256K，近乎全量；未复制 `*.sha256` 单文件与 `backup/`（同内容已含） |
| `d2_offline/` | `adr023-d2-verify-offline-20260916T155256Z` | `EVIDENCE.md` + 顶层**全部文件**（`A1`–`A7` 文本、`density_table_*`、`status_*`、`*.sha256`） | **排除** `mutant/`（约 9.3 MB 的整仓变异副本）；其结论（变异 A/B/B2 ⇒ 3/2/2 红）已逐字含于 `A3_mutation*_red.txt` 与 `EVIDENCE.md` |
| `d2_fixup/` | `adr023-d2-fixup-20260916-234640` | `EVIDENCE.md` + 全部 `*.txt` | 源目录 9.2M，其中绝大部分为源码副本（未复制）；`V1`–`V4` 原始读数与 3 个 `diff_*` 已保留 |
| `d2_deploy/` | `adr023-d2-deploy-20260916-235846` | `EVIDENCE.md` + `*.json` / `*.txt`（`kline30m.json`、`symbols.json`、`hz.json`、`multi_period_config.json`、`status_after.txt`、`LOG_PATH`） | **排除** `pre_s1_eestock-app` 与 `rollback_eestock-app`（各约 **207 MB** 二进制二进制/回滚副本）。部署判据所需读数全在 `EVIDENCE.md` 与上述小文件中 |
| `d2_live/` | `adr023-d2-verify-live-20260917-000127` | `EVIDENCE.md` + `result.json` + `run.log` + `00/10/11_*` 快照 + `acceptance.mjs` + **4 张截图**（`shot_B1_picker`、`shot_B2_combo_15m_30m`、`shot_B4_15m_30m`、`shot_B3c_1h_base_picker`） | **排除** `shot_00_initial`、`shot_01_enabled`、`shot_B2_combo_1m_30m`、`shot_B3a/B3b/B3d`、`shot_final`（7 张，与已保留者同族）；`result.json` 为全量原始读数，未裁剪 |

**未复制清单（有意）：**

| 未复制对象 | 体积 | 理由 |
|---|---|---|
| `adr023-mut/` | 248 MB | 整仓 rsync 副本（变异测试沙箱），非证据文本；其结论已在 `d2_offline/A3_mutation*_red.txt` |
| `adr023-redtree/` | 122 MB | 整仓副本（红树沙箱），同上 |
| `*.rollback` / `pre_s1_eestock-app` / `rollback_eestock-app` | 各 ~207 MB | 二进制回滚副本，无文本判据价值 |
| `mutant/`（offline 内） | ~9.3 MB | 离线验收的变异沙箱副本，结论已入文本 |
| `klinecharts.min.js`、`sh*t_*.png` 其余张、`*.log` 大日志 | — | 同族重复或体积冗余；单份关键截图/原始 JSON 已保留 |

**未被复制但已在本文档体现的源目录**：`adr023-red-20260916-224257`（D1 红测试，312K）与 `adr023-impl-20260916-224717`（D1 实现，392K）——两者属 **D1** 车道的红/实现阶段，其结论已由第 1、2 次验收报告覆盖，且第 3 次验收（`d2_offline`）已对同族目录做逐条复核；考虑到本轮入库范围被限定为「4 次验收」，此两目录**未复制**（如需可后续补入 `d1_red/`、`d1_impl/`）。`adr023-impl-current`（空）、`adr023-ts.env`、`adr023-d2-impl-dir.txt` 为辅助残留，未复制。

### 4.3 归档体积

```
tester/evidence/adr023/
├── d1_predeploy/   292K
├── d1_deploy/      176K
├── d1_postdeploy/  752K
├── d2_red/         1.2M
├── d2_impl/        244K
├── d2_offline/     312K
├── d2_fixup/        88K
├── d2_deploy/       52K
└── d2_live/        1.5M
合计 ≈ 4.5 MB / 223 个文件
```

---

## 5. 是否有证据已丢失

**明确结论：无。本轮 4 次验收的证据无任何丢失。**

- 任务书预期的 8 个 `/tmp/adr023-*` 证据目录（`verify/postdeploy/d2-red/d2-verify-offline/d2-verify-live/d2-impl/deploy/d2-fixup`）**全部存在于 `/tmp`**，本会话已逐一核对并复制其关键文本证据与截图。
- 所有本任务点名要求的硬读数均**在保留的文件中可逐字复现**：§1.1（30m=10 / 15m=18 / 1h=6 / 440-792-264）、§1.2（5m `0 → 2200`）、§1.3（24.1 / 5.0 / 1.8 / 1.67 及三处独立来源）、§1.4（线上 `source=static` + 1.8 / 24.1）、§1.5（drift 0.5 bar）、§1.6（`unsupported-period` = 0）、§1.7（`RC_ALL=0` + `rerun_rc=0`）。
- **唯一「未入库」的是体积型对象**（整仓副本 `adr023-mut`/`adr023-redtree`、~207 MB 级的 rollback 二进制、`mutant/` 沙箱、第三方 UMD、同族重复截图）——这些**不是判据承载物**，且其结论文本（如变异红项计数）已随对应 `*.txt` / `EVIDENCE.md` 一并入库。**未入库 ≠ 丢失**：源目录仍在 `/tmp` 原位，可随时补取。
- **已如实登记的偏差**：第 2 次验收的 `V6`（`1m:30m` 密度）在当时**未能实测**（`NOT-DONE`，D1 实例结构不可做）——这不是证据丢失，而是**该项由第 3 次验收（D2 红阶段 520px 真渲染）补齐**，且补齐后的原始 JSON（`d2_red/probe_result.json`）已入库。

---

## 6. 本会话的纪律与副作用（自审）

- **新增文件仅位于 `tester/`**：`tester/test/290_adr023_acceptance_execution.md` + `tester/evidence/adr023/**`（223 个文件）。
- **未执行**：`git add` / `git commit` / `git stash` / `git commit --force`。
- **未修改**：`design/`、实现代码（`crates/`、`web/src/`）、既有测试文件、迁移文件、生成物。
- **未触碰在线实例**：未重启、未杀死 app，**未**对 `:8081` / `:5432|5433` 发任何 HTTP 写或 SQL 写；本会话**未发起任何网络请求到被测实例**，仅做 `cp` / `ls` / `grep` / `cat` / `du` 文件级只读操作与写入 `tester/` 的落盘。
- **未做失败分析**：本报告只做「读数 → 结论」归档；失败根因分析见各原始 `EVIDENCE.md` 归因段（非本会话产出）。

---

## 附录 A — 入库文件索引（`tester/evidence/adr023/`）

各子目录均含其来源 `EVIDENCE.md`（均带**自指绝对路径**），以及该轮判据的原始读数文件：

| 子目录 | 主要文件 |
|---|---|
| `d1_predeploy/` | `EVIDENCE.md`；`raw/A2_apply.log`、`A2a_caggs.txt`、`A2b_rerun0026.txt`、`A3_run.txt`、`A3_compare.txt`、`A3_supp.txt`、`A4_run.txt`、`A5_*.log`、`A6a_*`、`A8_*.txt`、`A9_*`、`A10_jobs_mapped.txt`、`A12b_*` |
| `d1_deploy/` | `EVIDENCE.md`；`baseline-5m-daily.txt`、`after-5m-daily.txt`、`after-30m-daily.txt`、`after-15m-daily.txt`、`after-1h-daily.txt`、`baseline-1h-daily.txt`、`baseline-max-ts.txt`、`smoke-30m.json`、`smoke-30x.json`、`smoke-symbols.txt`、`s7-untracked.txt` 等 |
| `d1_postdeploy/` | `EVIDENCE.md`；`v2_daily_counts.txt`、`v2_max_ts.txt`、`v2_jobs.txt`、`v2_cagg_def.txt`、`v2_day_antijoin_repeat.txt`、`v3_bucket_compare.txt`、`v3_daywide_diff.txt`、`v3_alignment.txt`、`v3_baseline_15m_1h_ulp.txt`、`v4_probe{2,}_result.json`、`v5_latest_30m_raw.json`、`v7_*.txt`、`v4_b_30m_main.png`、`v4_c_multi_period_picker.png` |
| `d2_red/` | `EVIDENCE.md`；`probe_result.json`、`probe_result_b.json`、`red_*.txt`、`green_rust_lib_baseline*.txt`、`run.mjs`、`data/`、`shot_15m_30m.png`、`shot_1m_30m.png` |
| `d2_impl/` | `EVIDENCE.md`；`effective_density_probe.txt`、`post_cargo_*.txt`、`post_vitest_*.txt`、`tangle_output.txt`、`d2_handwritten_and_prose_diff.txt`、`numstat.txt`、`git_status_post.txt` 等 |
| `d2_offline/` | `EVIDENCE.md`；`A1_contract_check.txt`、`A1_picker_test.diff`、`A2_density_recompute.txt`、`A2_extra_scan.txt`、`A3_mutationA_red.txt`、`A3_mutationB_red.txt`、`A3_mutationB2_red.txt`、`A4_cargo_test.txt`、`A4_vitest.txt`、`A4_tangle.txt`、`A5_A6_independent.txt`、`A6_checks.txt`、`A7_audit.txt`、`density_table_{HEAD,WORK}.txt`、`status_{before,after}.txt` |
| `d2_fixup/` | `EVIDENCE.md`；`V1_tangle.txt`、`V2a_*.txt`、`V2b_*.txt`、`V3_contrast.txt`、`V4_git.txt`、`diff_spec.txt`、`diff_mock_hunks.txt`、`diff_parity_test.txt` |
| `d2_deploy/` | `EVIDENCE.md`；`kline30m.json`、`symbols.json`、`hz.json`、`multi_period_config.json`、`status_after.txt`、`LOG_PATH` |
| `d2_live/` | `EVIDENCE.md`；`result.json`、`run.log`、`00_snapshot_t0.txt`、`10_snapshot_t1.txt`、`11_git_status_after.txt`、`acceptance.mjs`、`shot_B1_picker.png`、`shot_B2_combo_15m_30m.png`、`shot_B4_15m_30m.png`、`shot_B3c_1h_base_picker.png` |

## 附录 B — 各原始 `EVIDENCE.md` 的原始位置（供追溯）

| 轮次 | 原始绝对路径 | 入库位置 |
|---|---|---|
| D1 上线前 | `/tmp/adr023-verify-1789570824/EVIDENCE.md` | `tester/evidence/adr023/d1_predeploy/EVIDENCE.md` |
| D1 部署车道 | `/tmp/adr023-deploy-20260916-230726/EVIDENCE.md` | `tester/evidence/adr023/d1_deploy/EVIDENCE.md` |
| D1 上线后 | `/tmp/adr023-postdeploy-20260916T151312Z/EVIDENCE.md` | `tester/evidence/adr023/d1_postdeploy/EVIDENCE.md` |
| D2 红阶段 | `/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md` | `tester/evidence/adr023/d2_red/EVIDENCE.md` |
| D2 实现 | `/tmp/adr023-d2-impl-20260916T154107Z/EVIDENCE.md` | `tester/evidence/adr023/d2_impl/EVIDENCE.md` |
| D2 独立离线验收 | `/tmp/adr023-d2-verify-offline-20260916T155256Z/EVIDENCE.md` | `tester/evidence/adr023/d2_offline/EVIDENCE.md` |
| D2 收尾小修 | `/tmp/adr023-d2-fixup-20260916-234640/EVIDENCE.md` | `tester/evidence/adr023/d2_fixup/EVIDENCE.md` |
| D2 部署车道 | `/tmp/adr023-d2-deploy-20260916-235846/EVIDENCE.md` | `tester/evidence/adr023/d2_deploy/EVIDENCE.md` |
| D2 上线后 | `/tmp/adr023-d2-verify-live-20260917-000127/EVIDENCE.md` | `tester/evidence/adr023/d2_live/EVIDENCE.md` |
