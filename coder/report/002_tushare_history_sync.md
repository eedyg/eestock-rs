# 报告 002：数据库落地 + tushare 历史数据首拉

- 日期：2026-09-03（CST）· worker：coder
- 范围：Task A（TimescaleDB 落地验证）+ Task B（tushare crate / storage 准确层，TDD）+ Task C（symbols 种子 + 首拉）
- **本报告位置**：`coder/report/002_tushare_history_sync.md`

## 0. TL;DR

- DB 落地完成：4 hypertable + 4 连续聚合（含新增 kline_accurate_1d）+ 刷新/压缩/保留策略全部就位（验证输出见 §2）
- 权限探测**颠覆预期**：`fund_daily` 无权限（40203），`stk_mins` 分钟接口有权限且历史深至 2013 → 父级裁决：只拉 1m 原生，D1 由 cagg 衍生
- TDD：12 测试全绿（golden 解析 4 + 编排 6 + 准确层集成 2）
- symbols 种子 44 只（43 旧库 + 161226 补入，含 settlement T0/T1 预填）
- 首拉后台进行中（PID 2678030）：核心 4 只已完成 3/4，已入 1.1M+ 分钟 bar，零限频错误

## 1. 父级裁决执行记录

| 决策 | 裁决 | 执行 |
|---|---|---|
| schema.md kline_1d SELECT 2参/3参不一致 bug | 选 A：修 design 重建卷 | ✅ 已修 schema.md（父级已落 commit e150153） |
| fund_daily 无权限 | 选 A 修正版：accurate 只写 M1 原生，D1 走 cagg 不物化 | ✅ 0005 建 kline_accurate_1d + 刷新策略 |
| HTTP client | 批准 reqwest 0.12 rustls-tls | ✅ 入 workspace deps |

另发现并修复（同 bug 修正先例，走 design 文档）：`design/02-domain/contracts.md` §2.2 provider.rs
代码块漏 `use chrono::{DateTime, Utc};`，HistoricalDataProvider 签名无法编译。已补导入（diff 仅 1 行注释+1 行 use）。

## 2. Task A：DB 验证输出

环境：PostgreSQL 16.15 + TimescaleDB 2.29.2，容器 eestock-timescaledb，宿主 5433。
初始化踩坑：initdb 首次因 `migrations/0001_init.sql` 宿主权限 600 失败（容器 postgres 不可读）→ chmod 644 + 重建卷后 0001-0005 全部干净执行。

```
hypertables: kline_accurate | kline_raw | metrics | source_health_events   (4/4 ✅)

连续聚合（timescaledb_information.continuous_aggregates）:
  kline_5m          FROM kline_raw      time_bucket 5min
  kline_15m         FROM kline_raw      time_bucket 15min
  kline_1d          FROM kline_raw      time_bucket 1 day + Asia/Shanghai  ← bug 修复后
  kline_accurate_1d FROM kline_accurate WHERE period='M1', 3参时区对齐     ← 0005 新增

刷新策略（jobs）:
  1000 kline_5m          every 1min, start_offset 1h,   end_offset 1min
  1001 kline_15m         every 1min, start_offset 2h,   end_offset 1min
  1002 kline_1d          every 1h,   start_offset 3d,   end_offset 1h
  1007 kline_accurate_1d every 1h,   start_offset 3d,   end_offset 1h

压缩/保留（jobs）:
  1003 policy_compression kline_raw            1004 policy_compression source_health_events
  1005 policy_retention   source_health_events 1006 policy_compression metrics
```

⚠️ 工作流转变（父级要求记录）：**0005 是最后一次免费 initdb**；后续迁移统一走 sqlx migrate。
⚠️ 运维：cagg 策略只刷近期窗口，**批量回填后须手动 `CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL);` 一次**（已验证：159638 回填后刷新出 984 个交易日 D1 bar，ts=当日 00:00 CST，口径正确）。

## 3. 权限探测结论（实测证据）

| 接口 | 结果 | 证据 |
|---|---|---|
| stk_mins 1min/5min | ✅ | 518880 2025-08-01 全天 241 根；2013-08（上市初）有数据；510300 2013-01 有数据 |
| fund_daily | ❌ 40203 | `{"code":40203,"msg":"抱歉，您没有接口(fund_daily)访问权限"...}` |
| daily / index_daily / fund_basic | ❌ 40203 | 同上 |
| fund_weekly | ❌ | 「请指定正确的接口名」（接口不存在） |

→ `supported_periods()` 实报 `[M1]`；M5/M15/H1/D1 标注「本地衍生（cagg）」。
golden 样本落盘 `crates/tushare/testdata/`（stk_mins_1min_sample.json 241 根真实响应、stk_mins_empty.json、err_permission.json、fund_daily_sample.json=拒绝响应）。

**ts 口径发现**：tushare 1m 每日 241 根（09:30–11:30 共 121 + 13:01–15:00 共 120），与旧 Go 库存储一致，原样入库。
⚠️ 风险：午后 bar 疑为末时刻标注，与 raw 层「bar 起始」口径可能错 1 分钟 → merge 视图精确 ts 匹配午后可能两侧并存（留诊断系统，见 §7 风险）。

## 4. Task B：TDD 证据

**Red**：先落测试+`todo!()` 桩 → `cargo test` 失败（parse.rs:43 todo panic 3 个 golden 测试 + storage 2 集成测试失败）。
**Green**：填实现 → 全绿。全程代码由 `design/04-storage/02-tushare-sync.md` tangle 生成（ADR-007）。

收尾复跑（2026-09-03 02:45 CST，`cargo test -p tushare -p storage` 全量）：**12 passed / 0 failed**，未改任何测试。

```
running 4 tests (tests/golden_parse.rs)   ... ok  4 passed   ← 241根/ts边界/单位/错误分类
running 6 tests (tests/sync_plan.rs)      ... ok  6 passed   ← 窗口规划/断点续传/节流门
running 2 tests (storage accurate_upsert) ... ok  2 passed   ← DO UPDATE 覆盖语义 + checkpoint roundtrip
test result: ok. 4 passed; 0 failed  /  ok. 6 passed; 0 failed  /  ok. 2 passed; 0 failed
```

关键锁定：
- 准确层 `ON CONFLICT (code,ts,period) DO UPDATE`（修正覆盖）vs raw 层 DO NOTHING（首写胜出）——`conflict_updates_row_not_keeps_first` 测试锁定
- 限频：间隔节流门默认 1000ms（`throttle_enforces_interval` 锁定；旧 Go 为 200ms，任务书取保守默认）
- 错误分类：403/429→RateLimited；超时→Timeout；业务 code≠0（含 40203）→Http 携带 code+msg；空窗口非错误返回空 vec

## 5. Task C：symbols 种子 + settlement 判定

**44 只入库**（旧库 akshare `fund_[0-9]+` 43 只 + **161226 补入**：核心标的但旧库无 fund_161226 表，fund_list 有记录「国投瑞银白银期货(LOF)A|商品」；不补则阶段 2 无法覆盖它——请父级确认此偏差）。
全部 interval_secs=60, enabled=true。名称 42/43 匹配 akshare.fund_list；551000 匹配不到留空。

settlement 预填（规则：跨境QDII/债券固收/商品/货币→T0；沪深股票型→T1）：**T0=16，T1=28**。

核心 4 只：518880 黄金→T0；513310 中韩半导体QDII→T0；161226 白银期货LOF→T0；159776 港股通医药卫生→T1（见待确认）。

**待人工确认清单（转用户终审）**：
| code | 名称 | 现判定 | 疑点 |
|---|---|---|---|
| 159776 | 银华中证港股通医药卫生 | T1 | 港股通跨境 ETF，类型列标「指数型-股票」按规则落 T1，实务 T+0 回转 |
| 513690 | 博时恒生高股息 | T1 | 同上（恒生系） |
| 513750 | 广发中证港股通非银 | T1 | 同上 |
| 513920 | 华安恒生港股通央企红利 | T1 | 同上 |
| 551000 | （名称缺失） | T1 | fund_list 无记录，类型未知 |

## 6. 首拉进度（nohup 后台，可断点续传）

- **进程**：PID **2678030**（`./target/debug/tushare_sync --interval-ms 1000`）
- **日志**：`logs/tushare_sync_20260903.log`；PID 文件 `logs/tushare_sync.pid`
- 顺序：核心 4 只优先（159776→161226→513310→518880）→ 其余按代码序
- 机制：首年探测（2012 起逐年，防空窗口浪费 quota）→ 30 天窗口步进 → 逐窗口 upsert + `sync_checkpoints` 落库；遇 RateLimited 整体退出（exit 2）明日续传
- 快照（2026-09-03 02:46 CST）：
  - **核心 4 只全部完成**：159776（259,798 bars）、161226（646,844）、513310（215,936）、518880（767,826）
  - 另完成：159638（冒烟，237,144）、159337（113,993）；进行中：159577（checkpoint 2026-05-19，接近收尾）
  - sync_checkpoints 7 行；kline_accurate 累计 **2,291,187 行**
  - **阶段完成数：核心 4/4 ✅；总进度 6/44**（进程健康推进中，未干预）
- **quota 观察**：~1 调用/秒匀速，全程零 403/429/业务错误；单次窗口 ≈7230 行远低于 8000 上限（满批续传未触发）

## 7. design 落档核对（收尾复核 02:45 CST）

- `design/04-storage/02-tushare-sync.md` §2 含 `0005_sync_checkpoints.sql` 完整代码块（sync_checkpoints 表 + kline_accurate_1d cagg + 刷新策略）✅，与 `migrations/0005_sync_checkpoints.sql` tangle 一致（仅 entangled 头尾标记差异）
- DB 侧：`sync_checkpoints` 表存在且已有 7 行运行数据；`timescaledb_information.continuous_aggregates` 含 kline_accurate_1d（刷新策略 job 1007 在役）✅（`\dm+` 不显示 cagg 是 psql 展示口径问题，以 information 视图为准）
- 无需补档

## 8. 风险清单

1. **tushare 1m 午后 ts 口径**（末时刻标注疑点）与 raw 层 bar-start 口径或错 1 分钟 → merge 视图午后可能双份；建议诊断系统做分歧比对时感知（ADR-003 不改数据原则内）
2. **quota 未知上限**：付费档位日额度未实测触顶；若中途 RateLimited 进程自动停在 checkpoint（exit 2），需明日重启续传（`--only` 可定向）
3. **kline_accurate_1d 全量回填后须手动 refresh 一次**（§2 运维注记）——首拉完成后执行
4. 551000 名称/类型缺失，settlement 暂 T1
5. 港股通 4 只 settlement 判定存疑（§5）
6. 0005 之后迁移须走 sqlx migrate，initdb 不再生效（工作流转变）
7. 满批（8000 行）续传路径有防御代码但实测未触发（30 天窗口 1min 约 7230 行），属低覆盖分支

## 9. 变更文件（不 commit、不 stage——按父级收尾指令保持工作区原样）

- 新增设计文档：`design/04-storage/02-tushare-sync.md`（tangle 事实源）
- 修复：`design/02-domain/contracts.md`（provider.rs 漏导入，+1 行）；schema.md kline_1d 修复父级已落 e150153
- 迁移：`migrations/0005_sync_checkpoints.sql`
- tushare crate：`src/{lib,parse,client,sync}.rs`、`src/bin/tushare_sync.rs`、`tests/{golden_parse,sync_plan}.rs`、`testdata/`×4
- storage crate：`src/{lib,accurate}.rs`、`tests/accurate_upsert.rs`
- 工程：workspace `Cargo.toml`（+reqwest 0.12 rustls-tls）、`Cargo.lock`、两 crate `Cargo.toml`
- 运行物：`logs/`（日志+PID）
