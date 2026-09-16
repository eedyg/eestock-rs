# 289 — ADR-023 D1（30m 数据 + 主图周期）实现报告

- **本文件位置（绝对路径）**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/289_adr023_period30m_d1_impl.md`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`（§2 决策 / §3 影响面 / §5 判据）
- 红测试（tester）：`tester/design/288_adr023_period30m_red_design.md`、`tester/test/288_adr023_period30m_red_execution.md`、`/tmp/adr023-red-20260916-224257/EVIDENCE.md`
- 证据目录（逐条命令原文 + 原始输出）：`/tmp/adr023-impl-20260916-224717/EVIDENCE.md`
- 仓库 @ 起始 commit：`3094018f352dae25752340d78b5e108c284aeecc`（HEAD 至终未变；无 staged、无 commit）
- 范围：**D1 = 30m 数据 + 主图周期**。多周期接入（`MULTI_PERIOD_ALLOWED` / `MULTI_PERIOD_PICKER_PERIODS` / `MEASURED_DENSITY_TABLE`）**一律未动**（J9 护栏全绿）。

## 1. 改了什么（23 tracked 文件；151 insertions / 19 deletions；+1 新迁移）

### 1.1 doc-first（事实源文档 → tangle 产物）

| # | 事实源文档 | 产物 | 改动 |
|---|---|---|---|
| D1 | `design/02-domain/contracts.md` | `crates/domain/src/types.rs` | `Period` 枚举加 `M30`（M15 与 H1 之间） |
| D2 | `design/07-app-plane/00-web-api.md` | `crates/storage/src/reader.rs` | 新增 `FALLBACK_30M`（kline_15m 查询期 rollup，`time_bucket('30 minutes', ts)`，first/max/min/last/sum）；`period_merged_sql` 加 `M30 => merged_sql("kline_accurate_30m", FALLBACK_30M)`；`forming_sql` 加 `M30 => "30 minutes"` |
| D3 | `design/07-app-plane/00-web-api.md` | `crates/web/src/dto.rs` | `parse_period` 加 `"30m" => Some(Period::M30)` |
| D4 | `design/07-app-plane/00-web-api.md` | `crates/web/src/rest.rs` | `GET /api/kline` 未知周期 400 文案改为全 8 档 `1m/5m/15m/30m/1h/1d/1w/1mo` |
| D5 | `design/04-storage/02-tushare-sync.md` | `crates/storage/src/accurate.rs` | `period_str` 加 `M30 => "M30"` |
| D6 | `design/04-storage/02-tushare-sync.md` | `crates/tushare/src/client.rs` | `fetch_history` Err 文案补 `M30` |
| D7 | `design/04-storage/02-tushare-sync.md` | （文档内）§1 表述 | 「M5/M15/H1/D1 本地衍生」→「M5/M15/M30/H1/D1」 |
| D8 | `design/04-storage/03-raw-writer.md` | `crates/storage/src/migrate_check.rs` | `EXPECTED_RELATIONS` 加 `"kline_accurate_30m"` |
| D9 | `design/04-storage/schema.md` | **`migrations/0026_period_30m.sql`（新建）** | 30m cagg（全历史）+ 四策略 remove/re-add 统一 `3 days` + 一次性全量刷 |
| D10 | `design/06-web/01-dashboard.md` | `web/src/layouts/DashboardGrid.tsx` | `export type Period` 加 `'30m'`（15m 与 1h 之间）+ §215 注释口径统一 |
| D11 | `design/06-web/01-dashboard.md` | （文档内）§202 / §312 | 工具栏周期口径统一为 8 档（`1m/5m/15m/30m/1h/日/周/月`） |
| D12 | `design/04-storage/schema.md` | （文档内）§4.4 注记 8 | 追加「ADR-023 §2.4 已根治」交叉引用（原句「未随 0020 一并改动」已过期） |
| D13 | `design/04-storage/schema.md` | （文档内）新增 §4.3.17 | 30m 档 + 刷新窗口根治的设计说明（口径/策略/幂等/应用方式/顺序硬约束） |

### 1.2 手写（不受门禁覆盖）

| # | 文件 | 改动 |
|---|---|---|
| H1 | `web/src/features/dashboard/Toolbar.tsx` | `PERIODS` 插入 `{value:'30m',label:'30m'}`（15m 与 1h 之间）⇒ 共 8 档 |
| H2 | `web/src/features/dashboard/chartSyncGroup.ts` | `PERIOD_BUCKET_MS['30m'] = 1_800_000`。**`MEASURED_DENSITY_TABLE` 未动** |
| H3 | `README.md` | 改「后续增量迁移走 sqlx migrate」为与实现一致：活库无 `_sqlx_migrations`、app 只做 `schema 自检`、增量迁移只能手工 `psql -v ON_ERROR_STOP=1 -f migrations/00XX.sql`，且**先落迁移再重启 app** |

### 1.3 「`Period` 扩展的类型连坐改动」（编译强制，非功能扩张）

`Period` 加变体后，**穷尽 match / `Record<Period,…>` 不补键即编译失败**。经父级逐条批准（Q1）后补齐：

| # | 文件 | 补值 | 依据 |
|---|---|---|---|
| C1 | `web/src/api/mock.ts:92` `PERIOD_MS` | `'30m': 1_800_000` | 与既有直写毫秒风格一致 |
| C2 | `web/src/features/backtest/ScopedKlineFeed.ts:6` `PERIOD_STEP_MS` | `'30m': 1_800_000` | 同上（该表注释即「与 mock PERIOD_MS 口径一致」） |
| C3 | `web/src/features/dashboard/chartCommon.ts:5` `PERIOD_MAP` | `'30m': { type:'minute', span:30 }` | 与 `'15m': {minute, 15}` 同风格 |
| C4 | `web/src/features/dashboard/feed.ts:30` `PAGINATION_BATCH` | `'30m': 180` | 介于 15m=220 与 1h=120；单批 5400 分钟；≤ 后端 `MAX_LIMIT=1000`（`dto.rs:9` / `rest.rs:43`） |
| C5 | `crates/storage/src/backtest.rs` `period_range_sql` | 新增 `FALLBACK_30M` 常量 + `M30 => range_sql("kline_accurate_30m", FALLBACK_30M)` | 该函数对 7 档**全穷尽**；沿用同文件 W1/MO1 先例（注释明示仅保 match 穷尽、回测 gate 不受理）。**未获逐条预批，请复核** |
| C6 | `crates/application/src/bar_map.rs:38` `warmup_lookback` | `M30 => 1_800`（秒） | 30 分钟 = 1800s；intraday 分支（`_ => 30` 占空比系数）不变 |

> C1–C4 由父级 Q1【批准】；C5/C6 与 Q1 同类（加变体即编译失败的连坐），但**未逐条预批**，实现按文件自身注释先例（W1/MO1）取值，登记为待复核项（见 §残留风险 R4）。

### 1.4 tester 红测试文件的 3 处**类型**修正（经父级 Q2(a)【批准】）

`web/src/features/dashboard/period30m.test.tsx`：仅加非空断言（**断言表达式/期望值/条数一字未改**），精确 diff：

```diff
@@ -60,7 +60,7 @@
     expect(m, 'DashboardGrid.tsx 必须导出 `type Period = ...;`').not.toBeNull();
-    const tiers = m![1]
+    const tiers = m![1]!
       .split('|')
@@ -219,6 +219,6 @@
   it('30m 桶宽与 15m 桶宽严格 2:1（桶边界对齐 ≥ 前提）', () => {
-    expect(PERIOD_BUCKET_MS['30m'] / PERIOD_BUCKET_MS['15m']).toBe(2);
+    expect(PERIOD_BUCKET_MS['30m']! / PERIOD_BUCKET_MS['15m']!).toBe(2);
```

**顺序证据**（父级硬条件 3）：在 `git archive HEAD` 得到的**无实现**沙箱内 —

| 步骤 | 命令 | 结果 |
|---|---|---|
| ① tester 原文件 | `npx tsc -b` | **exit=2**，3× TS2532（:63, :222×2） |
| ① tester 原文件 | `npx vitest run …/period30m.test.tsx` | **7 failed / 1 passed**（红） |
| ② 仅加 3 处 `!` | `npx tsc -b` | **exit=0**（净剩编译错误 → 0） |
| ② 仅加 3 处 `!` | `npx vitest run …/period30m.test.tsx` | **仍 7 failed / 1 passed**（红，未被"弄绿"） |
| ③ 主仓（实现齐备） | `npx vitest run …/period30m.test.tsx` | **8 passed**（绿） |

⇒ 修正的是**编译错误**，不是断言。

## 2. 架构对齐（各改动属于哪一层，为什么）

| 层 | 改动 | 说明 |
|---|---|---|
| domain（纯类型） | `Period::M30` | 周期是领域概念；新增变体是**加法**，不动任何既有变体语义 |
| storage（读源 / 写源 / 自检） | `reader.rs`（读源 SQL + forming 桶）、`accurate.rs`（落库口径文本）、`migrate_check.rs`（启动自检台账）、`backtest.rs`（回测读源穷尽） | 全部在 storage 层，未跨越层边界；`reader.rs` 复用既有 `merged_sql(accurate, fallback)` 与 `FALLBACK_*` 模式（1h 先例） |
| tushare（采集适配） | `client.rs` Err 文案 | 采集语义未变（`supported_periods()` 仍只报 M1，ADR-023 §2.1「零采集改动」） |
| web（API 线格式 + handler） | `dto.rs::parse_period`、`rest.rs` 错误信息 | 前端口径映射与错误信息属 handler/dto 层；未改路由/端口契约 |
| SQL 迁移（数据面） | `migrations/0026_period_30m.sql` | 由 `design/04-storage/schema.md` 单向 tangle 生成（文件头标注「禁止手改」） |
| web（前端） | `DashboardGrid.tsx`（类型契约，tangle 产物）、`Toolbar.tsx`/`chartSyncGroup.ts`（手写实现） | 类型契约在骨架（tangle），交互实现在组件（手写）——与既有分工一致 |
| application | `bar_map.rs`（warmup 回溯跨度） | 仅类型穷尽；未改回测受理周期（`parse_period` 仍只受 M1/M5/M15/H1/D1） |

## 3. 解决的问题 / 新增的能力

1. **30m 档位贯通**：`Period::M30` → 落库口径 `"M30"` → 读源 `kline_accurate_30m`（+ `kline_15m` rollup 兜底）→ forming「30 minutes」→ 前端 `parse_period("30m")` → 工具栏 8 档 → 主图请求 `period=30m`。
2. **新增数据对象**：迁移 0026 新建 `kline_accurate_30m` 连续聚合（**全历史**，源 `kline_accurate` 的 M1 行）。
3. **根治既有缺陷**（ADR-023 §2.4）：`kline_accurate_5m` 自 2026-09-07 起逐交易日 0 行的刷新窗口缺陷 —— 5m/15m/30m/**1h** 的 `start_offset` 统一 `INTERVAL '3 days'`，并在迁移内对 30m/5m/15m 做一次性全量刷新。
4. **同轮修正错误信息/错误文档**（ADR-023 §2.6）：rest 400 文案、tushare Err 文案、README 迁移口径、dashboard 文档三处自相矛盾。

## 4. 实现路径与关键决策（均在已批准架构内）

- **30m 只走 1m 本地衍生**（不取 tushare 原生 30min），避免第二口径（ADR-004 单一事实源）；`FALLBACK_30M` 镜像 `FALLBACK_1H`，**不新建** raw 层 cagg（缺 `kline_30m` 字面量，J4e 护栏绿）。
- **策略变更 = remove + re-add**（TimescaleDB 无 in-place API），`remove_…_policy(…, if_exists => true)` 保幂等。
- **迁移幂等**：`CREATE MATERIALIZED VIEW IF NOT EXISTS` + `if_exists => true`；重跑 `refresh_continuous_aggregate` 为等价重物化。
- **不越界**：`MULTI_PERIOD_ALLOWED` / `MULTI_PERIOD_PICKER_PERIODS` / `MEASURED_DENSITY_TABLE` 全未动（D2 才做，需实测密度）。
- 1h 策略改动按父级 Q3 裁决执行（以 ADR-023 §2.4.4 为准，任务书清单漏列 1h 属笔误）。

## 5. 测试覆盖

- **新增删改测试**：0（tester 已产出的 8 个红测试文件原样保留；仅按父级批准对前端文件加 3 处非空断言）。
- tester 红测试 **J1–J9 全绿**（Rust 20/20 + 前端 8/8），红↔绿对照见 §6 V1。
- 既有测试**零弱化**：`cargo test --workspace --lib` = **276 passed / 0 failed**（与 tester 绿基线逐字相同）；前端全量 `87 files / 814 passed`（= 既有 806 + 新 8）。

## 6. 验证（V1–V5，原始输出见 `/tmp/adr023-impl-20260916-224717/`）

### V1 红→绿（逐判据对照）

| 判据 | 红（实现前） | 绿（实现后） |
|---|---|---|
| J1 `Period::M30` | 编译失败（2× E0599） | 1 passed |
| J2 `parse_period("30m")` | 2 failed（返回 None） | 2 passed（`dto.rs:34`） |
| J3 `period_str(M30)` | 编译失败（1× E0599） | 2 passed |
| J4 M30 读源/兜底/forming | 3 failed / 2 passed | 5 passed |
| J5 `period=30m` 非 400 + 400 文案 8 档 | 2 failed（实测 400 `period 须为 1m/5m/15m/1h/1d`） | 2 passed |
| J6 `EXPECTED_RELATIONS` | 1 failed / 1 passed | 2 passed |
| J7 迁移 0026 | 5 failed（无 0026） | 5 passed |
| J8 前端主图 30m | 6 failed（type Period 7 档 / 按钮 7 档 / 找不到 30m 按钮） | 6 passed |
| J9 范围护栏 | 前端 2 failed（`PERIOD_BUCKET_MS['30m']` undefined）；后端 3 passed；前端 picker 1 passed | 5 passed（D1 期间后端/前端多周期白名单**仍不含** 30m） |
| 合计 | Rust 2 目标编译失败 + 可运行 11F/6P；前端 7F/1P | **Rust 20 passed / 0 failed；前端 8 passed / 0 failed** |

```
$ cargo test -p domain -p storage -p web --test period30m_*   # exit=0
test result: ok. 1 passed（J1）/ 2 passed（J6）/ 5 passed（J7）/ 2 passed（J3）/ 5 passed（J4）/ 2 passed（J2+J5）/ 3 passed（J9 后端）
$ cd web && npx vitest run src/features/dashboard/period30m.test.tsx   # exit=0 → Tests 8 passed (8)
```

### V2 门禁

```
$ ./scripts/check-tangle.sh        # exit=0
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
```
（改前同样为绿：`V2_pre_check_tangle.txt`。）

### V3 全量回归（含"既有断言不得弱化"逐条核对）

| 命令 | 结果 |
|---|---|
| `cargo check --workspace --all-targets` | **exit=0**（全部 lib + 全部测试目标编译通过） |
| `cargo test --workspace --lib --no-fail-fast` | **exit=0，276 passed / 0 failed**（== tester 基线 276，逐条相同） |
| `cd web && npx vitest run` | 首跑 1 failed（`SettingsPage.test.tsx` 源参数面板，**与本改动无关的 flaky**：单跑两次均 11 passed，HEAD 沙箱同样 11 passed）；**复跑 87 files / 814 passed，exit=0** |
| `cd web && npm run build`（`tsc -b && vite build`） | **exit=0** |
| 既有断言语义核对 | 我的改动**未删除/未放宽任何既有断言**；`rest.rs` 的 400 文案、`client.rs` 的 Err 文案变更**是 ADR-023 §2.6 明文要求的契约修正**，且仓内**无任何测试断言旧文案**（`grep -rn 'period 须为\|tushare 原生仅 M1'` 仅命中实现自身，未命中测试） |
| 既有多周期白名单 | `MULTI_PERIOD_ALLOWED` == `["1m","5m","15m","1h","1d","1w"]` 原样（J9 后端 3 条护栏绿）；`MULTI_PERIOD_PICKER_PERIODS` 原样（J9 前端绿） |

### V4 tangle 真实性（产物确实被写 + mtime 对比）

```
$ entangled tangle      # exit=0，零 conflicts / 零 WARNING / 零 ERROR
INFO write `crates/domain/src/types.rs`
INFO write `crates/tushare/src/client.rs`
INFO write `crates/storage/src/accurate.rs`
INFO write `crates/storage/src/migrate_check.rs`
INFO create `migrations/0026_period_30m.sql`
INFO write `web/src/layouts/DashboardGrid.tsx`
INFO write `crates/storage/src/reader.rs`
INFO write `crates/web/src/dto.rs`
INFO write `crates/web/src/rest.rs`
$ entangled tangle      # 第二次：仅 write `migrations/0026_period_30m.sql`（1h 策略改动）
$ entangled tangle      # 第三次：Nothing to be done.（幂等）
```

产物 mtime **新于**事实源文档：**9/9 OK**（`V4_mtime_proof.txt`，例：`crates/domain/src/types.rs` 22:51:45 > `design/02-domain/contracts.md` 22:50:53；
`migrations/0026_period_30m.sql` 22:53:50 > `design/04-storage/schema.md` 22:53:46）。grep 命中证据（`V4_artifacts.txt`）：
`types.rs:47 Period { M1, M5, M15, M30, … }`、`accurate.rs:15 Period::M30 => "M30"`、`client.rs:110 M5/M15/M30/H1/D1`、
`migrate_check.rs:15 "kline_accurate_30m"`、`reader.rs:88 FALLBACK_30M` / `:116 attached arm` / `:131 "30 minutes"`、
`dto.rs:34 "30m" => Some(Period::M30)`、`rest.rs:34 1m/5m/15m/30m/1h/1d/1w/1mo`、`DashboardGrid.tsx:15 '30m'`、
`0026:15 CREATE MATERIALIZED VIEW IF NOT EXISTS kline_accurate_30m … timescaledb.continuous`。

**额外（隔离库实测，父级 Q3 要求）**：一次性探针容器 `adr023probe`（镜像 `timescale/timescaledb:2.29.2-pg16`，宿主 **15433**）应用
0001..0026 → `rc=0`；**重跑 0026 → rc=0（幂等）**；`timescaledb_information.jobs` 实测四值：

```
 job_id |        cagg        | schedule_interval | start_offset | end_offset
   1023 | kline_accurate_5m  | 00:01:00          | 3 days       | 00:01:00
   1024 | kline_accurate_15m | 00:01:00          | 3 days       | 00:01:00
   1025 | kline_accurate_30m | 01:00:00          | 3 days       | 01:00:00
   1026 | kline_accurate_1h  | 01:00:00          | 3 days       | 01:00:00
（对照：kline_accurate_1d = 3 days、_1w = 30 days、_1mo = 120 days → 与父级「统一 3 days、周/月例外」规则一致）
```
探针容器已 `docker rm -f`；活库 `eestock-timescaledb`(5433) / `eestock-data` 全程未连、未动（`Up 11 days`）。

### V5 零副作用

```
$ git rev-parse HEAD           → 3094018f352dae25752340d78b5e108c284aeecc（未变）
$ git diff --cached --stat     → 空（无 staged）
$ git status --porcelain --untracked-files=no  → 23 行，全部为该改动集（6 design + 9 产物 + 3 手写 + 4 前端连坐 + 2 Rust 连坐 + tester 文件）
$ 无删除、无 .gitignore 改动、无其他项目改动；无临时残留（唯一新增文件 = migrations/0026_period_30m.sql，mode 644）
```

## 7. 残留风险与未决项

| # | 风险 / 未决 | 处置 |
|---|---|---|
| R1 | **活库尚未落库**：0026 未应用到 `eestock@5433`（本阶段禁令）。新二进制的 `EXPECTED_RELATIONS` 已含 `kline_accurate_30m` ⇒ **未落迁移就重启 app 会启动失败** | 落库由父级审核 diff 后另行安排；**顺序硬约束：先 `psql -v ON_ERROR_STOP=1 -f migrations/0026_period_30m.sql`，再重启 app**（ADR-023 §4.1）。隔离库已证 RC=0 + 幂等 |
| R2 | 迁移只做了**真实隔离库**验证（非活库数据量）；活库全量刷 30m/5m/15m 的**耗时未知**（ADR §7 风险 1） | 落库时实测并记录；必要时分批 |
| R3 | 1h 策略按父级 Q3 改为 3 days，但**未**对 1h 做全量刷（无已知缺口；ADR §2.4.4 第 3 条只列 30m/5m/15m） | 已写入迁移注释与 §4.3.17；如父级要求一并全量刷 1h，一行可加 |
| R4 | **C5/C6 两处 Rust 连坐未逐条预批**（`backtest.rs` 的 M30 读源 + `bar_map.rs` 的 1800s）；C5 的读源选择沿用 W1/MO1 先例（回测 gate `bar_map::parse_period` 仍拒绝 30m/1w/1mo ⇒ 实际不可达） | 请父级复核；若不接受，最保守替代是让 M30 走占位分支（不推荐：会给出错误量纲数据） |
| R5 | `application` 的 sim-live 周期文本解析（`simlive_feed.rs:105`、`simlive.rs:1821`）**未加** 30m —— 非类型强制（字符串 match 有 `_` 分支），属 ADR-023 §6.1「档位清单散落」既有债 | 不在 D1 改动清单内，未动；登记为 D2/后续债 |
| R6 | `design/04-storage/02-tushare-sync.md:22` 仍有「之后的迁移一律走 sqlx migrate」的旧表述（与 README 同源错误），本轮改动清单只授权 README（§2.6-3） | 未动（避免扩范围）；建议后续一并纠正 |
| R7 | tester 红测试文件未过 `tsc -b`（3× TS2532，`noUncheckedIndexedAccess`）——**流程缺口**：tester 自检只跑 vitest，未跑构建级类型检查 | 已按父级 Q2(a) 做纯类型修正并留精确 diff；建议 tester 自检加入 `npm run build`/`tsc -b` |
| R8 | 前端 `SettingsPage.test.tsx` 在全量并行下**偶发**失败（首跑 1 failed；单跑 2 次 + HEAD 沙箱 + 全量复跑均绿） | 与本改动无关的既有 flaky；建议后续单独收敛（不在本轮范围） |
| R9 | J4 组为**源码文本断言**（`period_merged_sql`/`forming_sql` 为私有函数，无 pub 访问器） | tester 已登记；运行时行为（SQL 真打 DB）需落库后按 ADR §5.2 验收（逐桶/新鲜度/策略生效） |
