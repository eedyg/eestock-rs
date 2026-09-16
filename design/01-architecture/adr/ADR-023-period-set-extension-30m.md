# ADR-023 — 周期档位扩展：新增 30m（含 accurate cagg 刷新窗口根治）

- 状态：**已裁决（2026-09-16）**。用户逐项确认：**① 30m 进多周期选择器；② 迁移现在落在线数据库；③ 同轮把 5m/15m 的刷新窗口一并根治**。
- 关联：ADR-003（双真值层）、ADR-004（只写 1m、高周期派生）、ADR-016（Provider 双抽象）、ADR-018（tangle 门禁）、ADR-020（视口=根数）、ADR-022（多周期框架）；`design/04-storage/{schema.md,02-tushare-sync.md,03-raw-writer.md}`、`design/02-domain/contracts.md`、`design/07-app-plane/00-web-api.md`、`design/06-web/01-dashboard.md`
- 证据基础（**全部为本次对活库 `eestock-data`(127.0.0.1:5433) 的实测查询输出，非推断**）：
  - 逐层 `max(ts)` 与逐交易日的物化行数（`kline_raw`/`kline_accurate`/`kline_5m`/`kline_15m`/`kline_accurate_{5m,15m,1h,1d}`）
  - `kline_accurate.synced_at` 分布（= accurate M1 的**实际落库时刻**）
  - `timescaledb_information.{jobs,job_stats,job_errors}`（刷新策略与执行结果）
  - 迁移应用先例：0007 / 0009 / 0021 / 0024 / 0025 的 `psql -f` 报告（`coder/report/{012,057,099,125,147}*.md`、`coder/evidence/147_d11/migration_apply.md`）
  - 既有根因记录：`design/04-storage/schema.md:1157`（第 8 条）

---

## 1. 需求与现状

### 1.1 需求
用户诉求三项：**① 补齐 30m 周期数据；② 30m 同时进多周期选择器；③ 迁移现在落在线数据库。**

### 1.2 现状（实测）
| 事实 | 证据 |
|---|---|
| `Period` 枚举只有 `M1/M5/M15/H1/D1/W1/MO1` | `crates/domain/src/types.rs:47` |
| 30m 无 cagg 视图（全仓 `CREATE MATERIALIZED VIEW` 名单无 30m 桶） | `migrations/{0002,0010,0014,0016,0017}.sql`；活库 `timescaledb_information.continuous_aggregates` 9 个视图，无 30m |
| 30m 无读源分支（逐周期硬编码 match，无「按 N 分钟现算」通用路径） | `crates/storage/src/reader.rs:103-112`、`forming_sql` 仅 M5/M15/H1 |
| `period=30m` 被拒 | `crates/web/src/dto.rs:28-36` → `rest.rs:33-35` 返回 **400** |
| 上游 tushare `stk_mins` **支持** 30min，但我们**没要**（freq 硬编码 `1min`） | `design/04-storage/02-tushare-sync.md:10`；`crates/tushare/src/client.rs:120`（`fetch_window(..., "1min", ...)`）与 `:108-111`（非 M1 直接 Err） |

**结论**：30m 属「**上游有、我们未建档**」，不是数据丢失，也不是被否决（仓内无「否决 30m」的书面裁决）。

---

## 2. 决策

### 2.1 数据来源：**1m 本地 cagg 衍生**（不取 tushare 原生 30min）

| 理由 | 说明 |
|---|---|
| 口径统一 | 现有 6 档（5m/15m/1h/1d/1w/1mo）**全部**是 1m 派生（`crates/tushare/src/client.rs:110`「tushare 原生仅 M1」），30m 单独走原生会形成**第二个口径** |
| 单一事实源 | 符合 ADR-004；避免「同一指标两个数」——这正是 ADR-021 双产物镜像纪律在防的失真模式 |
| 逐桶可对齐 | 同一 `time_bucket` 口径 ⇒ 30m 桶与 1m/15m 桶边界严格对齐，可逐桶校验 |
| 零采集改动 | `TushareClient::supported_periods()` 仍只报 `[M1]`，`client.rs` 无需改动语义 |

### 2.2 读源：**accurate cagg + 查询期 rollup 兜底**（镜像 1h 先例）

- **新建且仅新建 1 个 cagg**：`kline_accurate_30m`
  - 定义：`FROM kline_accurate WHERE period = 'M1'` + `time_bucket('30 minutes', ts)` + `first/max/min/last/sum` 聚合，**全历史（禁止 `ts >= '2024-01-01'` 过滤）**（0017 教训）
- **兜底**：新增 `FALLBACK_30M` 常量 = 查询期 rollup `time_bucket('30 minutes', ts) FROM kline_15m`（与 `FALLBACK_1H` 同型）。**不新建** raw 层 `kline_30m`（5m/15m 有 raw 层 cagg，1h 走 rollup ⇒ 30m 采 1h 风格，少一个 schema 对象）
  - 桶对齐已证：15m 桶在 `:00/:15/:30/:45`，30m 桶在 `:00/:30` ⇒ 6 的倍数关系，2 个 15m 桶 = 1 个 30m 桶
  - **每日桶数（2026-09-16 修正）**：A 股真实 M1 形态是 241 根/日，且**含会话末打印**（11:30 与 15:00 各一根）、**无 13:00**；会话末打印落在对齐桶上 ⇒ 各自独占一桶，于是每个日内周期都比「理想对齐」**多 2 桶**：15m 实测 **18**/日、30m **10**/日、1h **6**/日（1h 的 6 已由活库 44×6=264 行/日独立佐证）。**判据必须是「与既有 15m/1h 几何同构」，不得写成理想值**；薄桶属既有数据形态，**不得为 30m 特殊处理**（否则与 15m/1h 口径分裂）
- `EXPECTED_RELATIONS`（启动自检）加入 `kline_accurate_30m`

### 2.3 forming 桶（实时右缘）：`M30 => "30 minutes"`

否则 30m 的进行中 bar 不随 1m 实时前进（`forming_sql` 目前只覆盖 M5/M15/H1）。WS 轮询器本身**与周期无关**（`crates/web/src/ws.rs:180-188` 按订阅的 `(code, period)` 调 `latest_bar`），故无需额外改动。

### 2.4 【本 ADR 核心】accurate cagg 刷新窗口根治：intraday 统一 `start_offset = 3 days`

#### 2.4.1 实测缺陷（**既有、正在复发**）
`kline_accurate_5m` 自 **2026-09-07** 起**每个交易日 0 行**：

| bar 日 | `kline_accurate_5m` | `kline_accurate_15m` | `kline_accurate`(M1) |
|---|---|---|---|
| 09-08 / 09-09 / 09-10 / 09-11 | **0 / 0 / 0 / 0** | 396 / 396 / 396 / 396 | 10604 / 10604 / 10604 / 10604 |
| 09-12 / 09-13（周末） | 0 / 0 | 0 / 0 | 0 / 0 |
| 09-14 / 09-15 / 09-16 | **0 / 0 / 0** | 0 / 396 / 396 | 10604 / 10604 / 10604 |

- `max(ts) FROM kline_accurate_5m` = **2026-09-07 07:00Z**（= 9/7 收盘）
- 其刷新作业 **一直报 Success**：job 1048，`total_runs=13681`、`total_failures=0`、`last_successful_finish=2026-09-16 14:19:37Z` ⇒ **「成功」是空转**（窗口内无失效数据可物化）
- 用户侧未暴露：`reader.rs` 的兜底用 raw 层 `kline_5m`（新鲜）反连接补位 ⇒ **5m 实际长期由兜底数据服务，准确层空缺**（第二事实源，潜在口径分歧）

#### 2.4.2 根因（算术闭合，实测）
| 量 | 实测值 |
|---|---|
| 会话结束 | 15:00 CST = **07:00Z** |
| accurate M1 落库时刻 | bar 日 09-16 → `synced_at` **10:00Z**（18:00 CST 日增量槽）；bar 日 09-15 → **2026-09-16 00:00Z**（08:00 CST 槽） |
| 5m policy 窗口 | `[now−2h, now−1min]` ⇒ 10:00Z 时 = `[08:00Z, 09:59Z]` ⇒ **不含 07:00Z** ⇒ 当日桶**永不被物化** |
| 15m policy 窗口 | `[now−6h, now−1min]` ⇒ = `[04:00Z, 09:59Z]` ⇒ **含 07:00Z** ⇒ 正常 |

⇒ 阈值落在 **2h 与 6h 之间**；最坏观测延迟 = 会话结束 → 落库 **17h**（bar 日 09-15 的数据在次日 00:00Z 落库）。

#### 2.4.3 该根因文档已记录、根治被明确推迟
`design/04-storage/schema.md:1157` 原文：
> 「accurate cagg 物化滞后根因（0020）：cagg 刷新策略 start_offset（5m=2h/15m=6h）小于单次 tushare 回填批次跨度，大批量回填时**旧桶不落入刷新窗口** → 物化 watermark 停在回填边界。当前以「回填后全量刷新」作为运维惯例规避（0020 固化）；**根治选项=加大 start_offset 覆盖单次回填批次（建议 5m/15m ≥ 2d），属策略参数调整，未随 0020 一并改动**」

0020 的全量刷新是**一次性**的，此后无人再跑 ⇒ 9/8 起逐日复发。

#### 2.4.4 裁决
1. **intraday accurate cagg 的 `start_offset` 统一为 `INTERVAL '3 days'`**（5m / 15m / **30m** / 1h）；`end_offset` 与 `schedule_interval` 保持现值。
   - 3 天覆盖：最坏实测延迟 17h + 周末/节假日空档；成本可忽略（每次刷新扫约 3×10604 ≈ 3.2 万行 M1）
   - **成本实测（2026-09-16 落库后）：无虚惊** —— 放大窗口后 3 天窗**没有**造成刷新空转开销：job 1051/1052（5m/15m，1 分钟节拍）各跑 11 次、单次 `last_run_duration` ≈ **12.4 ms**，job 1053（30m、1 小时节拍）**16.5 ms**（TimescaleDB 只刷新被失效登记的区域，收盘后即近乎空转）
2. **新建 30m cagg 时即写入该策略**（**禁止照抄 0017 的 `2 hours`** —— 那会原样复制本缺陷）
3. 迁移内执行**一次性全量 refresh**：新建的 `kline_accurate_30m` + 既有 `kline_accurate_5m`/`_15m`（补齐 9/7 以来的缺口）
4. 策略变更须 **remove + re-add**（TimescaleDB 无 in-place 修改 API）：`remove_continuous_aggregate_policy(..., if_exists => true)` 后 `add_continuous_aggregate_policy(...)`

### 2.5 多周期：30m 进白名单，密度**必须实测**

- 后端：`MULTI_PERIOD_ALLOWED` 加 `"30m"`；`multi_period_rank` 在 `15m`(2) 与 `1h`(3) 之间插入 `30m`
- 前端：`MULTI_PERIOD_PICKER_PERIODS`（硬编码镜像）、`PERIOD_BUCKET_MS['30m'] = 1_800_000`
- **密度比**：`MEASURED_DENSITY_TABLE` **只认实测值，禁止按名义周期比兜底**（ADR-022/287 口径）。
  - 合成机制已存在（`composeDensity`，锚点法）：只需**一个**实测锚点条目 **`1m:30m`**，即可让 30m 与 `5m/15m/1h` 经 `1m` 锚点全互通（例：`15m↔30m` = `D(1m→30m)/D(1m→15m)`）
  - **仍须真渲染校验**合成值（漂移容差 + 有界闭环 + 诚实降级），不得只凭算术采纳
  - 30m 与 `1d/1w` 跨族不同步（锚点不相通）—— 与既有 1m/5m/15m/1h 行为一致，**属既有设计而非本轮缺陷**
- 前端 `MULTI_PERIOD_PICKER_PERIODS` 与后端 `MULTI_PERIOD_ALLOWED` 是**镜像关系**：两者必须同时改，否则出现「可选却被 400 拒」或「可选却不可同步」
- **30m 配对禁用 composed（强制，2026-09-16 追加）**：必须为 30m 与 `{1m,5m,15m,1h}` 的**每一对**写**直接实测条目**，**冻结值**（同一 P0.3 口径真渲染、pane 520px、多取样逐位一致、禁名义比）：
  | 配对 | 实测值 | 包络 | 名义比（禁用） | 与 composed 的差 |
  |---|---|---|---|---|
  | `1m:30m` | **24.1** | [24.0, 25.3] | 30 | — |
  | `5m:30m` | **5.0** | [4.84, 5.08] | 6 | +2.6%（compose 5.128） |
  | `15m:30m` | **1.8** | [1.78, 1.89]（真渲染同窗取样 1.7826–1.8889；取整日中位 1.800） | 2 | **+9.7%**（compose 1.9754） |
  | `30m:1h` | **1.67** | [1.63, 1.69] | 2 | −5.9%（compose 1.5684） |
  并配一条**不变量断言**：30m 的任一配对经 `effectiveDensity` 解析必须为 `source='static'`（即永不使用 `composed`）。理由见 §6.1 第 7 条（`composed` 的值被当缩放比且优先级高于运行时实测，陈旧表值会直接造成错对齐——上表右列即实测证据）。
- **既有 5 条表值本轮逐字不动**（不得借机制刷新旧值——那是独立债，见 §6.1 第 7 条）。

### 2.6 同轮顺带修（均为已发现的**错误信息/错误文档**，非新功能）

| # | 问题 | 位置 |
|---|---|---|
| 1 | 错误信息与实际契约不符（缺 `1w/1mo`，本轮再缺 `30m`） | `crates/web/src/rest.rs:34` |
| 2 | Err 文案只提 `M5/M15/H1/D1` | `crates/tushare/src/client.rs:110` |
| 3 | **README 与实现不符**：写「后续增量迁移走 sqlx migrate 运维流程」，实际活库**无 `_sqlx_migrations` 表**、app 只跑 `verify_schema`、迁移只能手工 `psql -f` | `README.md:92` |
| 4 | 设计文档自相矛盾：§202/§312 写工具栏 5 档（`1m/5m/15m/1h/日`），§215 与实现是 8 档 | `design/06-web/01-dashboard.md` |
| 5 | §1 表述「M5/M15/H1/D1 全部标注本地衍生」需含 M30 | `design/04-storage/02-tushare-sync.md:16` |

---

## 3. 影响面（变更清单）

### 3.1 doc-first（**必须改事实源再 tangle，禁手改产物**）

| 事实源文档 | 产物 |
|---|---|
| `design/02-domain/contracts.md` | `crates/domain/src/types.rs`（`Period` 加 `M30`） |
| `design/07-app-plane/00-web-api.md` | `crates/storage/src/reader.rs`、`crates/web/src/{dto,rest,ws}.rs`（含 2.5 后端白名单/rank、2.6-1 错误信息） |
| `design/04-storage/02-tushare-sync.md` | `crates/storage/src/accurate.rs`（`period_str`）、`crates/tushare/src/client.rs`（2.6-2 文案）、§1 表述（2.6-5） |
| `design/04-storage/03-raw-writer.md` | `crates/storage/src/migrate_check.rs`（`EXPECTED_RELATIONS` 加新关系） |
| `design/04-storage/schema.md` | **`migrations/0026_*.sql`**（新：30m cagg + 策略根治 + 全量刷） |
| `design/06-web/01-dashboard.md` | `web/src/layouts/DashboardGrid.tsx`（`type Period` 加 `'30m'`）、§202/§312/§215 口径（2.6-4） |

### 3.2 手写（不受门禁覆盖，改动须自证）
`web/src/features/dashboard/Toolbar.tsx`（`PERIODS` 插 30m，序：15m → **30m** → 1h）、`web/src/features/dashboard/multiPeriodPicker.tsx`（镜像）、`web/src/features/dashboard/chartSyncGroup.ts`（`PERIOD_BUCKET_MS` + **实测** `1m:30m`）、`README.md`（2.6-3）

### 3.3 新增迁移
`migrations/0026_period_30m.sql`（文件名以 schema.md 的声明为准）；权限 **644**

---

## 4. 部署与回滚（已核实）

### 4.1 落库路径
- **无 sqlx migrate**：活库无 `_sqlx_migrations`；app 启动只做 `migrate_check::verify_schema`（`crates/app/src/bin/eestock-app.rs:35`）
- `docker-compose.yml:26` 的 `./migrations:/docker-entrypoint-initdb.d:ro` **仅在空卷首次初始化时**执行 ⇒ 现网增量的**唯一**路径 = 手工
  ```
  psql -v ON_ERROR_STOP=1 -f migrations/0026_*.sql   # 对 127.0.0.1:5433
  ```
- ⚠️ **顺序硬约束**：新二进制把 `kline_accurate_30m` 加进 `EXPECTED_RELATIONS` 后，`verify_schema` 失败会让 app **直接起不来** ⇒ **必须先落迁移、再重启 app**
- ⚠️ **必须实测确认**：cagg 的 `CREATE MATERIALIZED VIEW ... (timescaledb.continuous)` 与 `refresh_continuous_aggregate` **不可置于显式事务块**内 ⇒ `psql` **不得加 `-1/--single-transaction`**（各语句 autocommit）。若实测与此不符，以实测为准并回写本文档
- 迁移须**幂等**（重跑输出 `NOTICE ... already exists, skipping` 语义；先例 0025 的二次执行证据）

### 4.2 回滚
| 对象 | 回滚 |
|---|---|
| 刷新策略 | `remove_continuous_aggregate_policy` + 按原值 `add`（5m=2h / 15m=6h） |
| `kline_accurate_30m` | `DROP MATERIALIZED VIEW kline_accurate_30m`（纯加法，无代码依赖时可即时回滚） |
| 代码 | `git revert`（`Period::M30` 删除后旧行为完全恢复） |
| 影响面 | 重启 app ⇒ 8081/8082 短暂不可用；全量 refresh 期间占用 DB（**须实测并记录耗时**） |

---

## 5. 验证判据（TDD 契约，红→绿）

### 5.1 后端
- `parse_period("30m") == Some(Period::M30)`
- `period_merged_sql(M30)` 走 `kline_accurate_30m` + 30m rollup 兜底；`forming_sql(M30) = "30 minutes"`；非日内周期仍 `None`
- `GET /api/kline?period=30m` → 200；未知周期 → **400** 且错误信息**含全部现行档位**（`1m/5m/15m/30m/1h/1d/1w/1mo`）
- `EXPECTED_RELATIONS` 含 `kline_accurate_30m`

### 5.2 存储 / DB 层（**硬判据，不得只看接口 200**）
- **逐桶正确性**：用 `kline_accurate` M1 手工聚合出的 30m 桶，与 `kline_accurate_30m` **逐桶逐字段**比对：`open=first`、`high=max`、`low=min`、`close=last`、`volume=sum`；`amount` 为 double 求和序所致，**允许 ULP 级差异、不得要求位级相等**（2026-09-16 生产实测：30m 为 50/440 桶不等、`max|Δ|=2.98e-8`，且既有且已验收的 **15m 同现象更广（111/792 桶、`max|Δ|=1.49e-8`）** ⇒ 若坚持位级相等，既有周期亦不合格，属既有事实而非 30m 缺陷）
- **桶边界**：桶起点 09:30 对齐（minute ∈ {0,30}、sec=0）；`time_bucket` 与 15m 兜底桶边界一致
- **每日桶数（与既有几何同构，非理想值）**：30m = **10**/交易日，且必须同时成立 15m = **18**、1h = **6**（后两者为既有已接受行为）。11:30 与 15:00 两个薄桶（各 1 根）是**正确输出**，不是缺陷。本节初版写的「8 桶/交易日」系笔误（漏算会话末打印），已按实测更正，并作为一次「判据假设 vs 真实数据形态」的纠错记录在案。
- **新鲜度（本轮新增的关键判据）**：落库后 `max(ts) FROM kline_accurate_30m` **必须 = 最近交易日收盘**；并验证 `kline_accurate_5m` 的 9/7 以来缺口**已补齐**
- **策略生效**：断言新 `start_offset` 已在 `timescaledb_information.jobs` 生效，且**实测一次「模拟数据到达晚于窗口」的情形不再漏物化**（最低要求：策略参数断言 + 全量刷后逐日计数非 0）

### 5.3 前端
- `type Period` 含 `'30m'`；工具栏 **8 档**且顺序 `1m/5m/15m/30m/1h/日/周/月`；点击 30m 发出 `period=30m`
- 主图：加载、铺满（`barSpaceForViewport`）、实时右缘随 1m 前进
  - **验证方式**：必须真渲染（替代端口上的验证实例 + 真浏览器），**不得**用静态源码取证代替；因 app 启动自检要求 `kline_accurate_30m` 存在，本项**只能在落库之后**验证（见 §4.1 顺序约束）
- 【**D1 交付范围**】= 本节第 1、2 条（30m 数据 + 主图周期）
- 【**D2 交付范围，本轮不做**】多周期：30m 可作为基准/卫星；密度用**实测**值；不可用组合**诚实降级并可见化**（禁静默虚假对齐）
  - **分期理由（登记）**：`MEASURED_DENSITY_TABLE` 的纪律是**实测值、禁名义比**，而 `1m:30m` 只能在「30m 已部署的实例」上真渲染量取 ⇒ D1 先落库，D2 再量取并**同时**打开三处（`MULTI_PERIOD_ALLOWED` / `MULTI_PERIOD_PICKER_PERIODS` / `MEASURED_DENSITY_TABLE`）。D1 交付后 30m 不在多周期白名单内 = **有意的一致状态**（不制造「可选却被静默排除」的半成品）

### 5.4 门禁与回归
- `./scripts/check-tangle.sh` 绿（sandbox 重生成 + 逐字节比对）
- 既有 6 档周期相关断言**一条都不得弱化/删除**；既有全量测试不得回归
- **测试目标覆盖**：必须跑 `cargo test --workspace`（**含 `--tests` 集成测试目标，不得只跑 `--lib`**）——新增的 `crates/*/tests/period30m_*.rs` 属集成目标。
- **假绿反证（变异，只在 `/tmp` 副本内做）**：① 迁移里 30m 的 `start_offset` 由 `3 days` 改回 `2 hours` ⇒ 策略断言与「晚到数据」场景必须变红；② 前端工具栏把 `30m` 换成 `1h`（破坏 8 档顺序）⇒ 档位顺序断言必须变红。

---

## 6. 已知债（本轮**不做**，登记在册）

1. **档位清单散落 8 处无单一事实源**：`Period` 枚举 / `parse_period` / `period_merged_sql` / `forming_sql` / `MULTI_PERIOD_ALLOWED` / `multi_period_rank` / cagg 迁移 / 前端 `PERIODS`+`MULTI_PERIOD_PICKER_PERIODS`+`PERIOD_BUCKET_MS`。加一档需人工同步全部 ⇒ 建议单独立 ADR 收敛（前后端同构）
2. **手写文件无漂移门禁**：`Toolbar.tsx`、`chartSyncGroup.ts`、`multiPeriodPicker.tsx` 不在 `file=` 声明内 ⇒ 文档与实现偏差不会被 `check-tangle` 拦截（2.6-4 即为实例）
3. **`materialized_only = true`**：全部 cagg 查询完全依赖物化，无 real-time 兜底；本轮以 §2.4 修窗口根治，**不改模式**（避免制造口径分裂）

### 6.1 落库后新登记（2026-09-16，证据见 `/tmp/adr023-postdeploy-20260916T151312Z/`）

4. **30m 刷新策略的 `end_offset`/`schedule_interval` = 1 hour（沿用 1h 先例）⇒ 最坏物化滞后 ~1h**。ADR §2.4.4 只裁决了 `start_offset`，此项未决。可见影响被兜底吸收（缺桶由 `FALLBACK_30M` 的 15m rollup 查询期补齐）。若要收紧，改成 `end_offset => '1 minute'` + `schedule_interval => '1 minute'` 即可，**代价经实测仅 ~12 ms/次**（见 §2.4.4 成本实测）⇒ 建议出现可见滞后时再单独出迁移，勿混入本轮。
5. ~~【产品发现·待裁决】多周期选择器“打开即写服务端”~~ **已撤回（2026-09-17，自证伪）**：精确插桩（逐动作记录请求）后实测——打开入口 `data-testid="mp-periods-open"` **不产生任何请求**（`[picker open] 触发请求 = []`）；PUT 实际来自**真实用户动作**：「多周期开关」1 次 + 选择器「确定」5 次 ⇒ 属**预期行为**（ADR-022 §12：每实例布局落服务端 config），**无需修复**。
   - **教训（写入纪律）**：初版归因错在**用整段会话的方法汇总去归因单个动作**。凡“某 UI 动作产生了写”的结论，**必须逐动作插桩取证**，不得用会话级汇总反推。
6. **`kline_accurate_1d` 落后（与本次修好的 5m 同族）**：2026-09-16 实测 `max(ts) = 2026-09-14 16:00Z`（落后 1–2 交易日），被 `kline_1d` 兜底掩盖 ⇒ 未暴露。本轮不在 D1 范围，登记待排查。
7. **【既有功能风险·待裁决】静态密度表口径不一致 + `composed` 优先级高于运行时实测**：
   - 证据 A（口径不一致）：同法重测 `1m→15m` = **13.389**，而表值为 **12.2**；
   - 证据 B（compose 与直接实测不符）：`composeDensity('15m','30m')` = 24.1/12.2 = **1.9754**，而直接实测 = **1.800**（**+9.7%**）；
   - 证据 C（造成实际错对齐的机制）：`chartSyncGroup.ts:986` 的 `effectiveDensity()` 解析顺序为 **static → composed → measured → none** ⇒ `composed` 的值被当作**缩放比**使用，且**优先于运行时实测**（后者本可准确）。
   - 影响：既有配对中凡是靠 `composed` 解析的（如 `5m↔1h` = 37.8/4.7 ≈ 8.04，ADR-022 文档引为例证）都会继承该误差；新 30m 配对已用「直接条目」规避（§2.5）。
   - **待用户裁决**：① 把 `measured` 提到 `composed` 之前（架构级，改 287 口径 C 的优先级）；或 ② 为所有受支持配对补直接实测值；或 ③ 维持现状并仅登记。**本轮不动既有行为**。
8. **测试隔离债：集成测试写共享 dev 库的 `app_config`**：既有 `crates/web/tests/api_settings.rs:88`（`DELETE FROM app_config WHERE key IN (...)`，注释自认「共享 dev 库」）与 `crates/storage/tests/config_store.rs` 直接读写活库该表；本轮新增的 D2 测试也会对活库发 `PUT /api/config/multi_period`（已做快照+恢复自隔离，但**仍会临时改活库**）。实测佐证：线上 `multi_period` 键在 15:52Z 的一轮测试后**一度不存在**（GET 退默认），说明测试确实能改变活库该键。⇒ 本轮强制 D2 自带测试自隔离（已做）；**全仓测试隔离作为独立债登记**。
9. **【UX 限制·登记】30m 卫星在强缩放下常 `degraded`**：真渲染实测——对齐态 drift 0.5 卫星 bar（无虚假对齐）；强缩放时 30m 卫星报 `degraded=true`（`no-improvement`/`unreachable`，DOM 可见 + 可行动 title）；`1m↔30m` 强缩放下为 `unreachable`。属**诚实降级**（非缺陷），但意味着 30m 与 1m/15m 近比配对在高倍缩放下体验受限。
10. **【结构性不可达·登记】**`satellite-lower-than-base` 在真渲染**无法观测**：选择器已强制「候选 ≥ 基准」，故 1h 基准 + 30m 卫星在 UI 层构造不出来（由单测覆盖）。同理 `30m↔1w` 的降级只体现在 picker 禁用原因上，不进同步层原因码。
11. **【面不齐·登记】**多条既有测试夹具/标题仍只列 6–7 档（`Toolbar.test.tsx:58-60`、`feed.test.ts:15`、`mock.test.ts:687`、`multiPeriodSatellite*.test.tsx`、`syncCoverage.test.ts:343`）：实测**不产生假绿**（严格 8 档由 `period30m.test.tsx` J8-b 覆盖），但违反 §6.2「契约变更全域扇扫」的面要求。

### 6.2 只读验收的流程教训（强制）

- 浏览器只读会话**必须先快照 `app_config`**，否则无法证明未被改动（本次即因未快照而无法完全排除）。
- **把“会自动写配置的 UI 入口”列入禁点清单**（实测：多周期选择器入口 `data-testid="mp-periods-open"`）。
- **契约变更必须做「受影响测试全域扫描」（2026-09-16 追加，来自 D2 实例）**：本次 D2 把多周期可选周期集合由 6 档扩到 7 档，tester 改写了 2 个编码旧契约的测试文件（`period30m.test.tsx` / `period30m_scope_guard.rs`），**漏了第 3 个**（`multiPeriodPicker.test.tsx` 的 A1/A2/B1），导致实现完成后仍有 3 条旧契约断言变红。⇒ 凡改变契约，须先**全域枚举**所有编码旧契约的测试（而非碰到才改）。
- **旧契约断言只能按「契约推导」更新，不得按「实现输出」倒推**：授权实现方做该类字面量更新时，必须同时给出独立推导（本次三条分别为：全集 7 档顺序；`base=15m ⇒ {P≥15m}` 过滤后 `1w` 因基准 `<1d` 被禁 ⇒ `enabled=[15m,30m,1h,1d]`；`base=1d ⇒ [1d,1w]` 不受 D2 影响），并由独立验收方做**结构性复核**（断言条数/类型/期望集合是否等价于契约推导，而非只看 diff 文本）。

---

## 7. 风险与未闭环

| # | 风险 | 处置 |
|---|---|---|
| 1 | 全量 refresh 耗时未知（先例：0020 曾对 5m 全量刷至 337 万桶物化行） | 落库时**实测并记录**；必要时分批 |
| 2 | 30m 兜底（15m rollup）与 accurate 30m 桶边界若不一致会造出重影/空洞 | 已论证 6 的倍数对齐 + 逐桶比对判据（§5.2） |
| 3 | 多周期 30m 密度若只用算术合成而不真渲染校验，会产生「虚假对齐」 | §2.5 强制真渲染校验 + 诚实降级 |
| 4 | 既有 `kline_accurate_5m` 长期由兜底服务造成的**口径分歧**（准确层 vs raw 层） | §2.4 补齐后消除；验收含「缺口已补齐」断言 |
| 5 | 本次修复**不在 commit 内**的对应物：`.entangled/filedb.json` 为 gitignore 的本地状态 | 与本 ADR 无关（周期档位不含 DB 状态）；见 skill `eestock-entangled-root-db-repair` |
