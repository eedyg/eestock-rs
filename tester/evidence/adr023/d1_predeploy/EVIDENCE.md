# ADR-023 D1（30m 数据 + 主图周期）独立验收 — EVIDENCE

- **本文件绝对路径**：`/tmp/adr023-verify-1789570824/EVIDENCE.md`
- 验收方：tester（独立验收，只验不改；未修改仓库任何文件，未分析失败根因）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD：`3094018f352dae25752340d78b5e108c284aeecc`（验收开始 = 结束，未变）
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`（§5 判据）
- 时间：2026-09-16 23:00–23:06（UTC 15:00–15:06）
- 原始输出目录：`/tmp/adr023-verify-1789570824/raw/`（本文件引用的所有 `.txt`/`.log` 均在此）
- 隔离库：`eestock_verify_30m`（全新安装链 + 桶正确性 + 策略有效性）、`eestock_verify_mut`（变异 A）
  —— 两者均已 `DROP DATABASE`，无残留（见 A8）

## VERDICT: FAIL

红项：**A3(a)**（生产数据形态下 30m 桶数 = 10 ≠ 判据 8）、**A1/ADR §5.3 多周期子项**（30m 未进多周期白名单，
按任务 A7 属本轮有意范围，D2 才开）。其余 A1–A13 全部有独立证据且绿。

---

## 环境与纪律

```
$ docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
eestock-timescaledb  timescale/timescaledb:2.29.2-pg16  Up 11 days (healthy)
eestock-data         eestock-rs_data                   Up 11 days (healthy)
$ ss -ltnp | grep -E '8081|8082'      # 在线 8081/8082（未触碰，PID 与开工时相同）
LISTEN 0.0.0.0:8081 users:(("eestock-app",pid=1342449,fd=11))
LISTEN 0.0.0.0:8082 users:(("eestock-app",pid=1342449,fd=12))
```
- 活库 `eestock@127.0.0.1:5433`：**仅只读 SELECT**（A13）。
- 所有写操作只在**一次性隔离库**内；`DROP DATABASE` 已执行（A8）。
- 未执行 `git add/commit/stash`、未用 `--force`、未对仓库执行 tangle/stitch/reset；
  变异测试只在 `/tmp/adr023-mut/`（rsync 副本）与 `/tmp` 内 SQL 文件里做。

---

## A1 契约逐条（ADR-023 §5.1 / §5.3）

### §5.1 后端
| 判据 | 我方独立证据（命令 + 原始输出） | 结论 |
|---|---|---|
| `parse_period("30m") == Some(Period::M30)` | `crates/web/src/dto.rs:34` `"30m" => Some(Period::M30)`（我方 grep，非引用 worker 测试）；运行期 200 由 A5 的 `crates/web/tests/period30m_api_contract.rs` 覆盖（我方复跑 cargo test 含该目标？→ 该目标为 `--test` 目标，见 A5 note） | PASS |
| `period_merged_sql(M30)` 走 `kline_accurate_30m` + 30m rollup 兜底；`forming_sql(M30)="30 minutes"`；非日内仍 None | `crates/storage/src/reader.rs:116 Period::M30 => merged_sql("kline_accurate_30m", FALLBACK_30M)`；`:131 Period::M30 => "30 minutes"`；`FALLBACK_30M` 定义 `:88-92`（`time_bucket('30 minutes', ts) FROM kline_15m`）；`:125` 注释「仅对日内周期 M5/M15/M30/H1 生效」 | PASS |
| 未知周期 400 且错误信息含 8 档 | `crates/web/src/rest.rs:34 "period 须为 1m/5m/15m/30m/1h/1d/1w/1mo"`（grep 原文） | PASS |
| `EXPECTED_RELATIONS` 含 `kline_accurate_30m` | `crates/storage/src/migrate_check.rs:15` 命中 `"kline_accurate_30m"` | PASS |

### §5.3 前端
| 判据 | 证据 | 结论 |
|---|---|---|
| `type Period` 含 `'30m'` | `web/src/layouts/DashboardGrid.tsx:15`（我方 grep）；`crates/web/tests/...` 不适用；J8-a 由前端测试覆盖（A5 全量 814 passed 含该 8 例） | PASS |
| 工具栏 8 档且顺序 `1m/5m/15m/30m/1h/日/周/月`；点击 30m 发 `period=30m` | `web/src/features/dashboard/Toolbar.tsx:45-54` `PERIODS` 8 项，30m 在 15m 与 1h 之间（grep 原文）；DOM 序与点击行为由 `period30m.test.tsx` J8-b/J8-c 覆盖，全量复跑绿（A5） | PASS |
| 主图：加载/铺满/实时右缘随 1m 前进 | `forming_sql(M30)="30 minutes"`（reader.rs:131）+ ws 轮询按 `(code,period)`（未改动）；**未做真渲染/真 WS 探针**（本轮未授权写在线 8081/8082） | PARTIAL（静态取证成立，动态未取证） |
| 多周期：30m 可作基准/卫星；密度用实测值 | `MULTI_PERIOD_ALLOWED` = `["1m","5m","15m","1h","1d","1w"]`（dto.rs:138，无 30m）；`MULTI_PERIOD_PICKER_PERIODS` = 6 档无 30m（multiPeriodPicker.tsx:24）；`MEASURED_DENSITY_TABLE` 无 `1m:30m`（chartSyncGroup.ts:206-212） | **NOT SATISFIED（本轮有意，见 A7 / D2）** |

---

## A2 迁移全新安装全链（隔离库）

```
$ psql -h 127.0.0.1 -p 5433 -U eestock -d postgres -c "CREATE DATABASE eestock_verify_30m;"
CREATE DATABASE
$ psql ... -d eestock_verify_30m -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
CREATE EXTENSION
$ for f in $(ls migrations/*.sql | sort); do psql -h 127.0.0.1 -p 5433 -U eestock -d eestock_verify_30m \
    -v ON_ERROR_STOP=1 -f "$f"; done
（0001..0026 逐个 rc=0；RC_ALL=0；日志全文 raw/A2_apply.log；grep -iE 'ERROR|FATAL' → 0 命中）
```
**(a) 连续聚合视图共 10 个**
```
$ psql -At -c "SELECT count(*) FROM timescaledb_information.continuous_aggregates;"
10
$ psql -c "SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1;"
kline_15m / kline_1d / kline_5m / kline_accurate_15m / kline_accurate_1d / kline_accurate_1h
kline_accurate_1mo / kline_accurate_1w / kline_accurate_30m / kline_accurate_5m      （10 行，含新 30m）
```
**(b) 重跑 0026 幂等**
```
$ psql ... -v ON_ERROR_STOP=1 -f migrations/0026_period_30m.sql
rerun_rc=0 ；grep -iE 'ERROR|FATAL' → NONE；重跑后 cagg 仍 10 个；刷新策略仍 10 条（无重复 policy）
```
**(c) 首次应用后 4 个刷新策略均存在（`timescaledb_information.jobs`）** —— 见 A10 映射表（首跑 job 1019-1022，重跑后 1023-1026）。

结论：**PASS**

---

## A3 桶正确性（隔离库逐桶逐字段）

### 夹具（严格复刻活库分钟集合）
先用只读查询取活库真实 M1 分钟集合（`kline_accurate`, `period='M1'`, code=513970, 2026-09-16）：
```
$ psql -d eestock -At -c "SELECT to_char(ts AT TIME ZONE 'Asia/Shanghai','HH24') AS hh, count(*) ... GROUP BY 1;"
09|30   10|60   11|31   13|59   14|60   15|1        -- 合计 241 根
$ 显式检查 11:28/11:29/11:30/13:00/14:59/15:00 → 命中 11:28,11:29,11:30,14:58,14:59,15:00（**13:00 不存在**）
```
⇒ 生产约定 = **09:30…11:30（含，121 根）+ 13:01…15:00（120 根）= 241 根**，与任务书「09:30–11:30 与 13:00–15:00，共 241 根」唯一自洽读法一致。

夹具（隔离库，`code='VERIFY30M'`，close=1000+i 可辨识递增）：
```
INSERT 0 241                                   -- raw/A3_run.txt
CALL refresh_continuous_aggregate('kline_accurate_30m', NULL, NULL);   -- CALL
```
**(a) 桶数**
```
$ SELECT count(*) FROM kline_accurate_30m WHERE code='VERIFY30M';
10            ← **不是 8**
$ SELECT to_char(time_bucket('30 minutes', ts) ...), count(*)  -- 桶 → 1m 行数
09:30|30  10:00|30  10:30|30  11:00|30  11:30|1  13:00|29  13:30|30  14:00|30  14:30|30  15:00|1
```
独立复核（**只读活库**，同一 `time_bucket('30 minutes')` 作用于真实 M1）：
```
$ psql -d eestock -c "SELECT code, count(*) AS buckets_30m FROM (SELECT code, time_bucket('30 minutes',ts) ts
    FROM kline_accurate WHERE period='M1' AND ts>='2026-09-16 01:30:00+00' AND ts<'2026-09-16 08:00:00+00'
    GROUP BY code,2) x GROUP BY code;"
159337|10  159577|10  159638|10  159740|10  159742|10      -- 生产形态 = 10 桶/标的/交易日
```
对照组（理想化 240 根：09:30–11:29 + 13:00–14:59）：
```
bars_240 = 240 ;  buckets_240 = 8        -- raw/A3_supp.txt  ⇒ 桶口径逻辑本身可产出 8
```
**(b) 桶起点对齐**
```
buckets=10, aligned=10（extract(minute from ts) ∈ {0,30} 且 second=0）, first_bucket=2026-09-15 09:30:00, last=15:00:00
```
**(c) 逐桶逐字段相等**（两个独立参照，双向 EXCEPT）
```
--- cagg vs independent manual aggregation（独立分桶表达式 hour+min>=30） ---
cagg_minus_manual | 0
manual_minus_cagg | 0
--- cagg vs pure arithmetic expectation（由夹具生成公式反推，无 time_bucket） ---
cagg_minus_arith | 0
arith_minus_cagg | 0
```
人工抽样核对（09:30 桶，i=0..29）：open=999.75=1000+0-0.25 ✔ / high=1029.5=1000+29+0.5 ✔ /
low=999.25=1000+0-0.75 ✔ / close=1029=1000+29 ✔ / volume=735=Σ(10+i) ✔ / amount=1470=Σ2(10+i) ✔。

结论：**(b) PASS；(c) PASS（逐桶逐字段 0 差异，两个独立参照）；(a) FAIL（生产形态 10 桶 ≠ 判据 8）**。
根因（仅陈述事实，不作修复建议）：生产 M1 分钟集合含 `11:30`（上午收盘）与 `15:00`（收盘）且缺 `13:00`，
`time_bucket('30 minutes')` 对这两个边界行各生成 1 根独立薄桶；同样现象在既有周期已存在
（同一日：15m=18 桶、1h=6 桶，与活库 `kline_accurate_1h` 每交易日 264 行 = 44 code × 6 桶完全吻合）。

---

## A4 策略有效性（防复发，ADR-023 核心）

场景：先建 **旧** 策略 `start_offset = 2 hours`，再投递 **1 天 13 小时前**（>2h，且在 3 天窗口内）的 M1 行，
然后 `CALL run_job(<30m job>)`；随后把策略改为 **新** 值 `3 days`，对**同一批数据**再次 `run_job`。

```
### STEP 1（旧窗口 2 hours）                                 raw/A4_run2.txt
now_utc = 2026-09-16 15:03:20Z ; late_ts = 2026-09-15 01:30:00+00 ; age = 1 day 13:33:20
job_id=1031  old_start_offset=02:00:00  end_offset=01:00:00
INSERT 0 240 ; late_m1_rows = 240
DO ; buckets_after_2h_policy = 0          ← 旧 start_offset **漏**
### STEP 2（新窗口 3 days，同一 job 重跑）
job_id=1032  new_start_offset=3 days  end_offset=01:00:00
DO ; buckets_after_3d_policy_v2 = 8       ← 新 start_offset **覆盖**
```
（首跑时 `job_30m=1025`，见 raw/A4_run.txt。）
结论：**PASS**（可复现命令：`raw/A4_step1b.sql` + `raw/A4_step2b.sql`）。

---

## A5 门禁与回归

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0                                                      raw/A5_tangle.log
$ cargo test --workspace --lib --no-fail-fast
（逐 crate "test result: ok." 共 15 条；聚合 passed=276 failed=0）EXIT=0        raw/A5_cargo_lib.log
$ cd web && npx vitest run
Test Files 87 passed (87) ; Tests 814 passed (814) ; EXIT=0                    raw/A5_vitest.log
$ cd web && npm run build        （tsc -b && vite build）✓ built in 2.32s EXIT=0 raw/A5_web_build.log
```
既有断言未被弱化/删除（我方核对方法 + 结论）：
1. 删除行审计（`git diff -U0` 全部 `-` 行，去 `---`）：**19 行**，逐行列出（raw 见 A12 段）。
   `grep -ciE 'assert|expect|#[[]test[]]|assert_eq'` → **0**。
2. 测试文件变更审计：`git diff --name-status | grep '^D'` → **NONE**（无删除）；
   `git diff --name-only | grep -iE 'test|spec'` → 仅 `crates/storage/src/backtest.rs`、`web/src/features/backtest/ScopedKlineFeed.ts`
   两个**路径含 test 字样的实现文件**（非测试文件）⇒ **既有测试文件 0 改动**。
3. 新增测试仅加法：`crates/{domain,storage,web}/tests/period30m_*.rs`（7 个）+ `web/src/features/dashboard/period30m.test.tsx`
   （8 例，含新 8 档断言，全绿）。
4. `rest.rs`/`client.rs` 文案变更属 ADR §2.6 明文契约修正，且仓内无断言旧文案的测试（我方仅审计删除行，未越权改）。 

结论：**PASS**（唯一未取证项：`cargo test --workspace --lib` 不含 `--tests` 目标 ⇒ 8 个新 `tests/period30m_*.rs`
本身未在本次复跑命令内；worker 报其 20/20 绿。我方 A5 复跑为 lib 目标 276/276，与本轮新增无回归）

---

## A6 假绿反证（变异测试，仅在 /tmp 副本）

副本：`rsync -a --exclude data/ target/ web/node_modules/ web/dist/ .git/ .entangled/ ./ /tmp/adr023-mut/`

### A6(a) 迁移 30m `start_offset` 3 days → 2 hours
```
$ perl -0pi -e "s/(add_continuous_aggregate_policy\('kline_accurate_30m',\s*start_offset => )INTERVAL '3 days'/\${1}INTERVAL '2 hours'/" migrations/0026_period_30m.sql
$ diff 原文件 变异文件
42c42
<     start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
>     start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 hour',      raw/A6a_mutation.txt

$ 新库 eestock_verify_mut 应用 0001..0026（变异） → all migrations applied
$ SELECT cagg, start_off, end_off, sched FROM jobs JOIN continuous_agg ...;
 kline_accurate_30m | 02:00:00 | 01:00:00 | 01:00:00        ← **A2/A10 的「start_offset = 3 days」断言变红**
 kline_accurate_5m/15m/1h = 3 days（未变异对照）              raw/A6a_mutated_jobs.txt

$ 同 A4 场景（240 根 1d13h 前的 M1） + run_job
late_m1_rows = 240 ; buckets_after_2h_policy_mut = 0        ← **A4 变红（漏物化）**   raw/A6a_A4red.txt
```
### A6(b) 前端 Toolbar 的 30m 换成 1h（破坏 8 档顺序）
```
$ perl -0pi -e "s/\{ *value: *'30m', *label: *'30m' *\}/{ value: '1h', label: '1h' }/" web/src/features/dashboard/Toolbar.tsx
$ sed -n '45,54p' Toolbar.tsx
45 const PERIODS ... [
46   { value: '1m', label: '1m' }, 47 '5m' 48 '15m' 49 { value: '1h', label: '1h' }, 50 { value: '1h', label: '1h' }, 51 '日' 52 '周' 53 '月' 54 ];
$ npx vitest run src/features/dashboard/period30m.test.tsx
 × J8-b ... 周期按钮按 DOM 序严格为 8 档          → FAIL
 × J8-b ... 点击 30m 按钮 → onPeriodChange("30m") → FAIL
 × J8-c ... 30m 断言                              → FAIL
 Test Files 1 failed (1) ; Tests 3 failed | 5 passed (8) ; rc=1        raw/A6b_vitest_mutated.txt
```
变异前后对照：变异前 `J8 8 passed / 0 failed`（A5 全量 814 passed 之内）；变异后 `3 failed / 5 passed`。
结论：**PASS**（两处变异均使判据变红，非假绿）。

---

## A7 范围边界

```
crates/web/src/dto.rs:138  pub const MULTI_PERIOD_ALLOWED: &[&str] = &["1m","5m","15m","1h","1d","1w"];   ← 无 30m
crates/web/src/dto.rs:153  fn multi_period_rank: "1m/5m/15m/1h/1d/1w" → 0..5, `_ => None`              ← 无 30m
web/src/features/dashboard/multiPeriodPicker.tsx:24  MULTI_PERIOD_PICKER_PERIODS = ['1m','5m','15m','1h','1d','1w'] ← 无 30m
web/src/features/dashboard/chartSyncGroup.ts:206  MEASURED_DENSITY_TABLE = {'1m:5m','1m:15m','1m:1h','1d:1w','1h:1w'} ← 无 1m:30m
web/src/features/dashboard/chartSyncGroup.ts:192  PERIOD_BUCKET_MS 含 '30m': 1_800_000                  ← 有
web/src/features/dashboard/chartSyncGroup.ts:216  periodBucketMs('30m') → 1_800_000（非 null）
```
结论：**PASS**（D1 边界如任务 A7 所述；对应 ADR §2.5 的多周期接入判据因此未满足，见 A1 §5.3 末行）

---

## A8 副作用审计

```
$ git rev-parse HEAD
3094018f352dae25752340d78b5e108c284aeecc          （= 开工时 HEAD，未变）
$ git diff --cached --stat | wc -l
0                                                   （无 staged）
$ git status --porcelain --untracked-files=no | wc -l
23                                                  （23 个 tracked 修改，全部为本改动集；
                                                      md5=4ac9bfbc6d7f647d23718a205a03168a，清单原文 raw/A8_sideeffects.txt）
$ git status --porcelain | wc -l
81（其中 untracked 58，均为本改动集的 tester/coder 产物 + 新测试 + 0026 + ADR，开工前已存在者亦同）
=== 隔离库清理 ===
$ psql -d postgres -c "DROP DATABASE IF EXISTS eestock_verify_30m;"  → DROP DATABASE
$ psql -d postgres -c "DROP DATABASE IF EXISTS eestock_verify_mut;" → DROP DATABASE
$ SELECT datname FROM pg_database ORDER BY 1;
 eestock | eestock_d11_probe | postgres | template0 | template1
（`eestock_d11_probe` 为**开工前既有**遗留（开工首查即在列），非本次产生；本次两库已消失 ⇒ 无残留）
$ 活库只读自查：
  SELECT count(*) FROM timescaledb_information.continuous_aggregates WHERE view_name='kline_accurate_30m'; → 0
  SELECT count(*) FROM kline_accurate WHERE code LIKE 'VERIFY%';                                          → 0
$ ss -ltnp | grep -E '8081|8082' → 仍为 pid=1342449（与开工相同，未被触碰）
$ docker ps | grep eestock → eestock-timescaledb / eestock-data 均 Up 11 days（未重建、未重启）
```
结论：**PASS**。副作用：仅为完成 A5 而在仓库 `target/`（git 忽略）写入编译产物；无 tracked/untracked 新增残留。

---

## A9 手写连带改动复核

**(1) 删任一处 M30 臂 ⇒ 编译失败（在 /tmp/adr023-mut 副本内，`CARGO_TARGET_DIR` 复用仓库 target 缓存）**
```
$ grep -n 'Period::M30' crates/storage/src/backtest.rs       → 92: Period::M30 => range_sql("kline_accurate_30m", FALLBACK_30M),
$ grep -n 'Period::M30 => 1_800' crates/application/src/bar_map.rs → 42（原文见 git diff）
$ 删除两处后：cargo check -p storage -p application
error[E0004]: non-exhaustive patterns: `&domain::types::Period::M30` not covered
  --> crates/application/src/bar_map.rs:38:31        (rc=101)
error[E0004]: non-exhaustive patterns: `domain::types::Period::M30` not covered
  --> crates/storage/src/backtest.rs:86:11           error: could not compile `storage` (lib)
```
⇒ 两处均为**编译强制**（穷尽 match），非随意扩张。raw/A9_cargo_deleted_arms.txt, raw/A9_cargo_storage_deleted_arm.txt

**(2) M30 读源口径一致性（backtest.rs vs reader.rs）**
```
reader.rs:88-92   const FALLBACK_30M: &str = r#"(SELECT code, time_bucket('30 minutes', ts) AS ts,
                    first(open,ts) AS open, max(high) AS high, min(low) AS low,
                    last(close,ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
                  FROM kline_15m GROUP BY code, time_bucket('30 minutes', ts))"#;
backtest.rs:65-69 常量正文**逐字节相同**（同源表 kline_15m、同分桶、同聚合、同兜底）
reader.rs:116     Period::M30 => merged_sql("kline_accurate_30m", FALLBACK_30M)
backtest.rs:92    Period::M30 => range_sql("kline_accurate_30m", FALLBACK_30M)
```
⇒ 同源表（accurate 层 `kline_accurate_30m`）+ 同兜底（`kline_15m` rollup），**一致**。raw/A9_sources.txt

**(3) `crates/application/src/bar_map.rs::parse_period` 仍拒绝字面 M30**
```
crates/application/src/bar_map.rs:11-20
pub fn parse_period(s: &str) -> ... { match s {
  "M1" | "M5" | "M15" | "H1" | "D1" => Ok(...), other => Err(anyhow!("未知周期: {other}")) } }
```
⇒ 回测 gate 未扩（M30/1w/1mo 仍被拒），`M30 => 1_800` 仅为类型穷尽。结论：**PASS**

---

## A10 策略四值

**迁移文本（`migrations/0026_period_30m.sql`）**
```
31-33 kline_accurate_5m : start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',  schedule_interval => INTERVAL '1 minute'
36-38 kline_accurate_15m: start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',  schedule_interval => INTERVAL '1 minute'
41-43 kline_accurate_30m: start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',    schedule_interval => INTERVAL '1 hour'
46-48 kline_accurate_1h : start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',    schedule_interval => INTERVAL '1 hour'
```
**隔离库 `timescaledb_information.jobs`（首跑 / 重跑后）**
```
 job_id |        cagg        |  sched   | start_off | end_off
   1023 | kline_accurate_5m  | 00:01:00 | 3 days    | 00:01:00
   1024 | kline_accurate_15m | 00:01:00 | 3 days    | 00:01:00
   1025 | kline_accurate_30m | 01:00:00 | 3 days    | 01:00:00
   1026 | kline_accurate_1h  | 01:00:00 | 3 days    | 01:00:00
（首跑对应 1019-1022，同值；对照：kline_accurate_1d=3 days、_1w=30 days、_1mo=120 days；raw layer kline_5m=1h/kline_15m=2h 未动）
```
结论：**PASS**（四值均为 3 days；end_offset 与 schedule_interval 保持现值）

---

## A11 无历史截断

```
$ grep -nE "202[0-9]|ts *>=|ts *>|ts *<" migrations/0026_period_30m.sql
3:-- ADR-023（架构裁决 2026-09-16）…        ← 注释
5:-- ③ 迁移内一次性全量刷新…（补齐 2026-09-07 以来…）→ 注释
（SQL 语句中 0 命中）
$ sed -n '15,21p' migrations/0026_period_30m.sql
CREATE MATERIALIZED VIEW IF NOT EXISTS kline_accurate_30m WITH (timescaledb.continuous) AS
SELECT code, time_bucket('30 minutes', ts) AS ts, first(open,ts) AS open, max(high) AS high,
       min(low) AS low, last(close,ts) AS close, sum(volume) AS volume, sum(amount) AS amount
FROM kline_accurate WHERE period = 'M1'
GROUP BY code, time_bucket('30 minutes', ts);
$ 隔离库 view_definition 实测（去注释）
 SELECT code, time_bucket('00:30:00'::interval, ts) AS ts, first(open, ts), max(high), min(low), last(close, ts), sum(volume), sum(amount)
   FROM kline_accurate WHERE (period = 'M1'::text) GROUP BY code, (time_bucket('00:30:00'::interval, ts));
```
⇒ 无任何 `ts` 过滤、无年份字面量（命中项全为注释）。结论：**PASS**

---

## A12 断言完整性

**(a) 删除行审计**：`git diff --unified=0` 全部被删除行共 **19 行**，逐行如下（文件: 内容）：
```
README.md: 后续增量迁移走 sqlx migrate 运维流程…
crates/domain/src/types.rs: pub enum Period { M1, M5, M15, H1, D1, W1, MO1 }
crates/storage/src/reader.rs: /// 仅对日内周期 M5/M15/H1 生效…
crates/tushare/src/client.rs: "tushare 原生仅 M1；M5/M15/H1/D1 由 … 衍生…"
crates/web/src/dto.rs: /// 前端周期口径…：1m/5m/15m/1h/1d…
crates/web/src/rest.rs: return err(..., "period 须为 1m/5m/15m/1h/1d");
design/02-domain/contracts.md / 04-storage/02-tushare-sync.md ×2 / 04-storage/schema.md:1157 / 06-web/01-dashboard.md ×3 / 07-app-plane/00-web-api.md ×3（文档口径）
web/src/layouts/DashboardGrid.tsx ×2: period 默认注释 + export type Period = 7 档
```
`grep -ciE 'assert|expect|#[[]test[]]|assert_eq'` → **0** ⇒ **0 行含 assert/expect/test 语义**。raw/A5_diff_audit.txt

**(b) `period30m.test.tsx` 3 处修正（我方独立方法）**
```
$ diff -u /tmp/adr023-impl-20260916-224717/backup/period30m.test.tsx web/src/features/dashboard/period30m.test.tsx
@@ -60,7 +60,7 @@
-    const tiers = m![1]
+    const tiers = m![1]!
@@ -219,6 +219,6 @@
-    expect(PERIOD_BUCKET_MS['30m'] / PERIOD_BUCKET_MS['15m']).toBe(2);
+    expect(PERIOD_BUCKET_MS['30m']! / PERIOD_BUCKET_MS['15m']!).toBe(2);
$ diff <(tr -d '!' < backup) <(tr -d '!' < current)      → **无差异（IDENTICAL）**
$ tr -cd '!' < current | wc -c  → 6 ;  backup → 3        ⇒ 净增 3 个 `!`
```
⇒ 独立证明：**只新增了 3 个非空断言 `!`，断言表达式、期望值、用例条数一字未改**（去掉 `!` 后两文件逐字节相同）。
（另一副本 `/tmp/adr023-redtree/web/.../period30m.test.tsx` 与现文件 `diff_rc=0`，说明该沙箱已被同步，不能作为"修正前"参照——已排除。）
结论：**(a)(b) 均 PASS**

---

## A13 1h 缺口核查（活库只读）

**(1) 1h 逐日计数非 0（证明「1h 不做全量刷」成立）**
```
$ psql -d eestock -c "SELECT (ts AT TIME ZONE 'Asia/Shanghai')::date AS bar_day, count(*) rows, count(DISTINCT code) codes
    FROM kline_accurate_1h WHERE ts >= now() - interval '10 days' GROUP BY 1 ORDER BY 1 DESC;"
2026-09-16|264|44   09-15|264|44   09-14|264|44   09-11|264|44
2026-09-10|264|44   09-09|264|44   09-08|264|44   09-07|264|44        （8 个交易日，逐日 264 = 44 code × 6 桶，无 0）
$ max(ts) FROM kline_accurate_1h → 覆盖至最近交易日（上表 09-16 有行）
```
**(2) 5m 在应用 0026 前的缺口基线（对照用）**
```
$ psql -d eestock -c "SELECT (ts AT TIME ZONE 'Asia/Shanghai')::date, count(*) FROM kline_accurate_5m
    WHERE ts >= now() - interval '12 days' GROUP BY 1 ORDER BY 1 DESC;"
2026-09-07|2200            ← **唯一有行日；09-08…09-16 共 7 个交易日 0 行（缺口确认，0026 尚未落活库）**
$ SELECT max(ts) FROM kline_accurate_5m;  → 2026-09-07 07:00:00+00
$ kline_accurate M1 逐日 10604 行（09-14/15/16），证明源数据齐备而 5m 物化为空
```
结论：**PASS**（1h 无缺口；5m 缺口基线已固定，落库后可按 ADR §5.2「新鲜度」复验）

---

## 残留风险与未决项

1. **A3(a) 是本次唯一实质红项**：判据/ADR §5.2 写「8 桶/交易日」，但生产 M1 分钟集合（241 根，含 11:30、15:00，缺 13:00）
   经 `time_bucket('30 minutes')` 得到 **10** 桶（多出 11:30 / 15:00 两根各 1 行的薄桶）。
   同样几何在既有周期一致（同日 15m=18、1h=6，活库 1h 每交易日 264 行 = 44×6 完全吻合）
   ⇒ 差异在**判据假设的数据形态**而非聚合算法（(b)(c) 全绿）。请架构侧裁决：改判据为「10 桶/交易日（含 2 根边界薄桶）」，
   或另立任务处理边界薄桶（本轮既未实现也未测试该数）。
2. **ADR §5.3「多周期：30m 可作基准/卫星 + 实测密度」未满足**（按任务 A7 属 D1 有意范围，D2 才开）⇒ ADR 字面判据与 D1 范围存在张力，建议在 ADR 中显式登记 D1/D2 分期，避免验收口径歧义。
3. **未做真渲染 / 真 WS 探针**：主图「实时右缘随 1m 前进」「30m 铺满」仅有静态取证（`forming_sql(M30)` + 未改动的 ws 轮询路径），
   因本轮禁止触碰在线 8081/8082。ADR §5.3 该子项为 PARTIAL。
4. **迁移未落活库**：`migrations/0026` 仅在本机隔离库验证（全新安装 + 幂等 + 策略四值 + 桶正确性）。
   活库 `eestock` 仍无 `kline_accurate_30m`；且新二进制 `EXPECTED_RELATIONS` 已含该关系 ⇒ **必须先落迁移再重启 app**（否则 `verify_schema` 拒绝启动）。落库耗时未知。
5. `cargo test --workspace --lib` 不含 `--tests` 目标 ⇒ 8 个新 `tests/period30m_*.rs` 未在本次复跑范围内（worker 报 20/20 绿，未被我方复现）。
6. 既有遗留：活库 `eestock_d11_probe` 数据库（开工前既有，非本次产生）；前端 `SettingsPage.test.tsx` 并行偶发 flaky（本次全量 814 passed 未复现）。
7. `crates/storage/src/backtest.rs` / `crates/application/src/bar_map.rs` 两处 M30 臂已证「编译强制 + 读源一致 + 回测 gate 未扩」，
   但从值域看 `bar_map::warmup_lookback(M30)=1800s` 与 `backtest::period_range_sql(M30)` 当前**不可达**（`parse_period` 拒绝 M30）——属可接受的连坐，登记备查。
