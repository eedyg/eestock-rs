# ADR-023 D1 落库后独立验收 — EVIDENCE

> **本文件路径（自指）**：`/tmp/adr023-postdeploy-20260916T151312Z/EVIDENCE.md`
> 证据目录：`/tmp/adr023-postdeploy-20260916T151312Z/`（含截图）
> 角色：Tester（独立验收，**只验不改**）。执行时段：2026-09-16 15:13Z → 15:48Z（UTC）；主机本地时间 23:13 → 23:48。
> 验收对象：在线实例 `127.0.0.1:8081`（PID 68833）+ 活库 `eestock` @ `127.0.0.1:5433`。
> 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`（读于本时段，含 §2.2 / §5.2 的 2026-09-16 更正版判据：30m=10 桶/日、15m=18、1h=6）。
> 判据归属：V1–V7 由架构师下达（本轮替换「必须用替代端口」旧口径为「直接对在线 8081 真渲染」）。

---

## 0. 验收基线（改动前快照）

| 项 | 值 |
|---|---|
| 仓库 | `/home/eestock/workspace/git/eestock/eestock-rs` |
| HEAD | `3094018f352dae25752340d78b5e108c284aeecc` |
| `git status --porcelain` sha256（基线） | `c20c326aabf27367bec0e0909c8d631837d0e35012dc0ccce314ebe9cb9aaa51` |
| staged 文件数 | 0 |
| 在线进程 | PID 68833 `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（启动于 15:13Z 前 02:45） |
| 监听 | 0.0.0.0:8081 / 0.0.0.0:8082（fd 11 / fd 12，同 PID） |
| 容器 | `eestock-timescaledb` Up 11 days (healthy)；`eestock-data` Up 11 days (healthy) |

证据文件：`baseline_git_status.txt`、`baseline_head.txt`。原始命令：

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
git status --porcelain=v1 > $E/baseline_git_status.txt && sha256sum $E/baseline_git_status.txt
git rev-parse HEAD > $E/baseline_head.txt
ps -o pid,ppid,etime,cmd -p 68833
(ss -ltnp | grep -E '8081|8082')
docker ps --format '{{.ID}} {{.Names}} {{.Status}}'
date -u +%Y-%m-%dT%H:%M:%SZ    # 2026-09-16T15:13:08Z
```

**纪律声明**：本时段内**未**重启/杀死 PID 68833；**未**执行 `git add/commit/stash`；**未**改仓库任何文件（含 `design/`、生成物、`migrations/`）；**未**执行 entangled 写操作（`check-tangle.sh` 自带沙箱，脚本自证「工作区未被修改」）；**未**使用 `--force`。所有验收脚本落在 `/tmp`，仓库内零残留。
**例外披露（重要）**：浏览器探针 V4 中**实际发生 1 次写请求** `PUT /api/config/multi_period`（由页面自身行为触发，非我显式调用），详见 §V4(g) 与 §V7；这是我方会话对在线实例唯一一次写操作，已如实登记。

---

## V1 全量回归（含集成目标）

### 命令原文

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
cargo test --workspace --tests                      # → v1_cargo_workspace.log
./scripts/check-tangle.sh                           # → v1_check_tangle.log
(cd web && npx vitest run)                          # → v1_vitest.log
(cd web && npm run build)                           # → v1_npm_build.log
# 独立复跑新增集成目标（7 个 period30m_* 目标）：
cargo test -p domain  --test period30m_contract
cargo test -p storage --test period30m_expected_relations
cargo test -p storage --test period30m_migration
cargo test -p storage --test period30m_period_str
cargo test -p storage --test period30m_read_source
cargo test -p web     --test period30m_api_contract
cargo test -p web     --test period30m_scope_guard   # → v1_period30m_rerun.log
```

### 原始输出摘要

| 目标 | 结果 | 文件 |
|---|---|---|
| `cargo test --workspace --tests` | **88 个 `test result:` 段，全部 ok**；合计 **715 passed / 0 failed / 1 ignored**；进程 `EXIT=0` | `v1_cargo_workspace.log` |
| — 其中新增集成目标 | `period30m_contract` 1/1、`period30m_expected_relations` 2/2、`period30m_migration` 5/5、`period30m_period_str` 2/2、`period30m_read_source` 5/5、`period30m_api_contract` 2/2、`period30m_scope_guard` 3/3 = **20 passed / 0 failed** | `v1_period30m_targets.txt` |
| 独立复跑 7 个 `period30m_*` 目标 | 20 passed / 0 failed / **EXIT=0** | `v1_period30m_rerun.log` / `v1_period30m_rerun_summary.txt` |
| `./scripts/check-tangle.sh` | `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` **EXIT=0** | `v1_check_tangle.log` |
| `npx vitest run` | `Test Files 87 passed (87)` / `Tests 814 passed (814)` **EXIT=0**（17.11s） | `v1_vitest.log` |
| `npm run build` | `tsc -b && vite build` → `✓ 180 modules transformed` / `✓ built in 2.68s` **EXIT=0**（仅 chunk>500kB 警告） | `v1_npm_build.log` |

### 结论
**PASS**。含 `--tests` 集成目标（非仅 `--lib`）；新增 7 个 `period30m_*` 目标独立复跑全绿；门禁与前端双侧全绿。

---

## V2 活库只读正确性（更正后判据）

### 命令原文（节选，全部 `SELECT`，只读）

```bash
PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -c "
select (ts at time zone 'UTC')::date d, count(*), count(distinct code),
       count(*)/nullif(count(distinct code),0) from <cagg> group by 1 order by 1 desc limit 12"
# 8 张 cagg 逐一执行 → v2_daily_counts.txt
```

### 原始输出摘要（逐交易日）

| cagg | 最近 12 个交易日 行数/日 | 标的数 | 行数/标的 | 判据 | 判定 |
|---|---|---|---|---|---|
| `kline_accurate_30m` | 440 × 12 日 | 44 | **10** | 44×10=440 | ✅ |
| `kline_accurate_15m` | 792 × 12 日 | 44 | **18** | 44×18=792 | ✅ |
| `kline_accurate_1h` | 264 × 12 日（09-03 例外 269/49，历史非 44 标的日） | 44 | **6** | 44×6=264 | ✅ |
| `kline_accurate_5m` | 2200 × 12 日 | 44 | **50** | 44×50=2200 | ✅ |
| `kline_accurate_1d` | 44/日（1d cagg 落后至 09-14，**不在 V2 判据内**） | 44 | 1 | — | n/a |

周末（09-12/09-13）在 5m/15m/30m/1h 中 **0 行**（`v2_recent_days.txt` 显示 09-05..09-16 只有 7 个交易日有行）→ 正常。

**max(ts) 四者一致**（`v2_max_ts.txt`）：

```
kline_accurate      | 2026-09-16 07:00:00+00 | 16344861
kline_accurate_5m   | 2026-09-16 07:00:00+00 | 3391050
kline_accurate_15m  | 2026-09-16 07:00:00+00 | 1220778
kline_accurate_30m  | 2026-09-16 07:00:00+00 | 678210
kline_accurate_1h   | 2026-09-16 07:00:00+00 | 406933
```

`= 最近交易日 2026-09-16 收盘 07:00:00+00` ✅（四者一致；1d cagg = 09-14 16:00Z，属既有落后，非本轮）。

**5m 缺口已补齐**：09-08/09-09/09-10/09-11/09-14/09-15/09-16 各 2200 行（落库前为全 0，见 ADR §2.4.1 表）✅。
**1h 无缺口**：对 `kline_accurate` 的 M1 日集合做 anti-join，`missing_1h = 0`；同口径 `missing_5m = missing_15m = missing_30m = 0`（`v2_day_antijoin_repeat.txt` 两次独立复跑一致）→ 3572 个交易日全覆盖 ✅。
**30m 全历史无过滤**：`min(ts)` 5m/15m/30m 均 = `2012-01-04 01:30:00+00`，与 M1 相同；`kline_accurate_30m` 视图定义无 `ts >= '2024-01-01'` 类过滤（`v2_cagg_def.txt`）✅。
**策略生效**（`v2_jobs.txt`）：`start_offset` 已统一 `3 days` —— job 1051 `kline_accurate_5m`（原 2h）、1052 `kline_accurate_15m`（原 6h）、1053 `kline_accurate_30m`（新建）、1054 `kline_accurate_1h` ✅。
**EXPECTED_RELATIONS**：`timescaledb_information.continuous_aggregates` 共 10 张视图，含 `kline_accurate_30m`（mat hypertable 48），app 启动自检通过（PID 68833 存活 + `/` 200）✅。

### 结论
**PASS**（30m=440、15m=792、1h=264、5m=2200；四者 max(ts) = 09-16 07:00Z；5m 缺口补齐；1h 无缺口；策略 3 days 生效）。

---

## V3 生产数据上的逐桶正确性（最强数据判据）

### 命令原文

```bash
# ① 单标的单日逐桶逐字段（code=510050, 2026-09-16）
PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -c "
with m1 as (select time_bucket('30 minutes', ts) bts, first(open,ts) open, max(high) high, min(low) low,
                   last(close,ts) close, sum(volume) volume, sum(amount) amount, count(*) m1_rows
            from kline_accurate where code='510050' and period='M1'
              and ts>='2026-09-16 00:00:00Z' and ts<'2026-09-17' group by 1),
     c30 as (select ts,open,high,low,close,volume,amount from kline_accurate_30m
             where code='510050' and ts>='2026-09-16 00:00:00Z' and ts<'2026-09-17')
select coalesce(m1.bts,c30.ts) bts, m1.m1_rows, ... , (m1.volume is not distinct from c30.volume) vol_eq,
       (m1.amount is not distinct from c30.amount) amt_eq,
       (m1.open=c30.open and m1.high=c30.high and m1.low=c30.low and m1.close=c30.close) ohlc_eq
from m1 full outer join c30 on m1.bts=c30.ts order by 1"          # → v3_bucket_compare.txt
# ② 全 44 标的当日双向差集 + 逐字段计数
... full outer join ... only_in_30m / only_in_m1 / field_mismatch   # → v3_daywide_diff.txt / v3_daywide_mismatch_detail.txt
# ③ 桶起点对齐
select extract(minute from ts)::int, extract(second from ts)::int, count(*) from kline_accurate_30m
where ts>='2026-09-16' group by 1,2 order by 1,2                   # → v3_alignment.txt
# ④ 既有 15m/1h 同法对照（基线同构性）
... 15m / 1h 的 amount / 非 amount 差异计数                          # → v3_baseline_15m_1h_ulp.txt
```

### 原始输出摘要

**① 510050 / 2026-09-16（10 桶，逐字段）**：10 行全部 `vol_eq=t amt_eq=t ohlc_eq=t`；`m1_rows` 依次
`30,30,30,30,1,29,30,30,30,1 = 241`（与 ADR §2.2 的「241 根/日 + 11:30/15:00 会话末打印各 1 根 + 无 13:00」逐桶吻合；03:30Z=11:30 CST 与 07:00Z=15:00 CST 为两个 1 根薄桶，**属正确输出**）。
双向差集：表为空（`full outer join`，两侧均无 NULL 行）✅。

**② 全 44 标的（440 桶）**：

```
 c30_rows | m1_buckets | only_in_30m | only_in_m1 | field_mismatch
      440 |        440 |           0 |          0 |             50
```

→ **双向差集 = 0 / 0** ✅（无重影、无空洞）；逐字段严格相等在 440 桶中有 50 桶不成立。

**②-明细**（`v3_daywide_mismatch_detail.txt`，50 行全表）：50 行**全部且仅仅** `amount` 一列不等（`o/h/l/c` 与 `volume` 全为 `f`=相等），绝对差 `|Δ| ≤ 2.98e-8`（例：`9458591.899999999` vs `9458591.9`，Δ=-1.86e-9；`111290578.49999999` vs `111290578.50000001`，Δ=-2.98e-8），即 double 求和结合序差异的 ULP 级偏差。
**④ 基线同构性对照**（同法对**既有已验收**的 15m/1h）：15m `792 桶 / 111 桶 amount 不等 / max|Δ|=1.49e-8 / 非 amount 差异 0`；1h `264 桶 / 0 / — / 0`。⇒ 该 ULP 现象**在既有 15m 上同样存在且更广**，非 30m 新增缺陷。

**③ 桶起点对齐**（440 行）：`minute ∈ {0,30}` 且 `sec=0`，`0→220 行 / 30→220 行`，无第三值 ✅。

### 结论
**PASS（附 ULP 级浮点附注）**。双向差集为空、桶起点对齐、`open=first/high=max/low=min/close=last/volume=sum` 在 440/440 桶严格相等；`amount=sum`（double 列）在 50/440 桶存在 ≤2.98e-8 的 ULP 级差，且在既有 15m（111/792）上同样存在 ⇒ 判为与既有几何同构、非 30m 特有。**若验收要求 `amount` 位级相等，则 V3 应记为不满足**（见 §残留风险 R3）。

---

## V4 真渲染（在线 8081，headless Chromium，只读）

工具：`playwright@1.63.0`（`web/node_modules`，bundled chromium-1234），viewport 1600×900，脚本 `v4_probe.cjs` / `v4_probe2.cjs`（均位于 `/tmp`，**不在仓库内**）。

### 命令原文

```bash
node /tmp/adr023-postdeploy-20260916T151312Z/v4_probe.cjs    # → v4_probe_stdout.txt / v4_probe_result.json
node /tmp/adr023-postdeploy-20260916T151312Z/v4_probe2.cjs   # → v4_probe2_result.json
```

### (a) 工具栏 8 档 + 严格 DOM 顺序 — ✅

```json
"label_indices": [44,45,46,47,48,49,50,51], "contiguous": true,
"ordered_first_8": ["1m","5m","15m","30m","1h","日","周","月"]
```
页面共 67 个 button；周期档位在第 44–51 位**连续且严格有序**，其后依次为 `K线/分时/MA/…/多周期/回到最新`。`aria-pressed=true` 的默认档 = `15m`。

### (b) 点击 30m → `period=30m` 且 200 — ✅

```json
[{"status":200,"url":"/api/kline?code=518880&period=30m&limit=120","method":"GET"},
 {"status":200,"url":"/api/kline?code=518880&period=30m&before=2026-09-01T01:30:00Z&limit=180","method":"GET"}]
```
两条均为 **GET / 200**。

### (c) 蜡烛真实渲染（可见 bar 数 > 0） — ✅

- 主图 canvas：`1438×697`（cssW/cssH 同），位于 `x=414,y=76`；另有 5m 副窗 1438×100 与 1438×26 轴窗。
- `data-viewport-fit = {"bars":120,"space":12,"visible":124,"clamped":false}`（app 写的视口适配留痕）。
- 像素分析（主 canvas）：`nonBgPixels=26707`，`candleColumns=560 > 0`（红/绿实体或影线列计数，**已排除灰度十字星**）。
- 截图：`v4_a_default_15m.png`（默认 15m）、`v4_b_30m_main.png`（30m 全页）、`v4_b_30m_canvas.png`（主 canvas 元素级）。

### (d) 视口铺满 — ✅（附量测口径说明）

- `leftBlankRatio = 0`（最左蜡烛列 = canvas 第 0 列）；`rightBlankRatio = 0.0647`（最右蜡烛列 1344 / 1438）。
- 口径说明：右端 6.5% 空白**不能**判为未铺满 —— 像素判定只识别红/绿，而当日最后一根 30m 桶（07:00Z）`open=close=2.98` 为十字星（灰度），相邻若干根同理，故右端 gap 与 `visible=124 > bars=120` 同源；权威量测 `data-viewport-fit` 显示 `space=12` 是**按容器宽 1438 反解**出来的（120 bar × 12px = 1440 ≈ 容器宽），且 `clamped=false`（未触上下限）。
- 附注：canvas 右邻 y 轴窗位于 `x=1852`，即布局内容宽 1912 > 视口 1600（`min-w-[1280px]` 主区），页面横向可滚动 —— 属既有布局，与本轮无关，不影响 pane 内铺满。

### (e) 控制台无 error 级报错 — ✅

```json
"console_errors": [], "console_warning_count": 0, "page_errors": []
```
（两次探针合计：0 error / 0 warning / 0 pageerror。）

### (f) 多周期选择器**不提供** 30m — ✅

探针 2（真渲染，`v4_c_multi_period_picker.png`）：

```json
"picker_present": 1,
"groups": [{"label":"K 线周期","buttons":["1m","5m","15m","1h","1d","1w"]},
           {"label":"指标周期","buttons":["15m","1h","1d","1w"]}],
"innerText": "步骤 1：K 线（基准）周期 … 步骤 2：指标周期（≥ 15m；最多 3 个）… 已选 0/3；总 pane 1/12（剩余 11）；候选已按步骤 1 收窄为 ≥ 15m，`1mo` 不提供。"
```
K 线基准档 **无 30m**，与 `MULTI_PERIOD_PICKER_PERIODS = ['1m','5m','15m','1h','1d','1w']` 一致 ⇒ D1 有意的一致状态成立（不制造「可选却被 400 拒」）。

### (g) 关掉页面后确认只有只读请求 — ⚠️ **未达成：实际发生 1 次 PUT**

探针 1（点击 30m）方法直方图：`{"GET": 14}`，写请求 `[]` ✅。
探针 2（打开多周期选择器入口 `[data-testid="mp-periods-open"]`，按钮文案「周期选择」）：

```json
"method_histogram": {"GET": 11, "PUT": 1},
"write_requests": [{"method":"PUT","url":"http://127.0.0.1:8081/api/config/multi_period"}]
```

活库侧独立佐证（只读 SELECT）：

```sql
select key, value, updated_at from app_config order by key;
-- multi_period | {"enabled": true, "heights": {"1m": 420}, "periods": ["1m"], "indicators": ["dcap"]} | 2026-09-16 15:18:09.178116+00
```
时间戳（15:18:09Z）落在探针 2 窗口（15:18:05→15:18:13）内 ⇒ **写确实落库**。
**归因与影响评估（观察，不含修复建议）**：
- 该 PUT 由页面行为触发（`DashboardPage` 的多周期配置保存路径），非我显式调用；探针 2 只点击了「周期选择」入口。
- 页面工具栏仅当 `multiPeriodPickerAvailable`（= 多周期已启用）时才渲染该入口，而**探针 2 在任何点击之前** `[data-testid="mp-periods-open"]` 即已存在（`opener_found=true` 分支）⇒ 写入前 `enabled` 已为 `true`。
- 落库值与 `coder/evidence/281_mp_deploy_p0_p5/verify_mp_deploy.mjs` 记录的基线 **CFG_OFF** `{enabled:false, periods:['1m'], heights:{'1m':420}, indicators:['dcap']}` 相比仅 `enabled` 位不同；因**我在探针前未快照 `app_config`**，**无法证明**该位是被我这次会话翻转的，也无法排除 `heights` 被重写（同值）。

### 结论
(a)(b)(c)(d)(e)(f) **PASS**；(g) **FAIL**（存在 1 次 PUT，无法满足「全程无写请求」的留证要求）。

---

## V5 实时右缘（诚实标注可观测性）

### 命令原文 / 输出

1. 最新查询（`before=None`）：
```bash
curl -s "http://127.0.0.1:8081/api/kline?code=510050&period=30m" -o v5_latest_30m_raw.json
```
→ `code:200`，`period=30m`，`bars=240`，`first=2026-08-14T01:30:00Z`，`last=2026-09-16T07:00:00Z`，`next_before=2026-08-14T01:30:00Z` ⇒ 无 `before` 时返回**最近窗口**且以最新收盘桶收尾 ✅。

2. WS 只读订阅 `bar/period=30m`（浏览器内原生 WebSocket，探针 1）：
```json
"sent": [{"type":"subscribe","topic":"bar","code":"510050","period":"30m"}],
"openClose": {"opened": true, "closed": true, "error": null},
"frame_count": 1,
"frames": [{"type":"bar","code":"510050","period":"30m",
            "bar":{"ts":"2026-09-16T07:00:00Z","open":2.98,"high":2.98,"low":2.98,"close":2.98,
                   "volume":5959100,"amount":17758118,"source":"tushare"}}]
```
⇒ 订阅帧**被接受**，socket 正常 open/close、无 error 事件，服务端**推送了 1 条 `period=30m` 的 bar 帧**（内容 = `latest_bar(M30)` = 09-16 收盘桶）✅；无错误帧、无 4xx/5xx、无页面错误。

### 结论
- 「`before=None` 最新查询行为」+「WS 订阅 bar/30m 被接受且服务端无错误」= **PASS**。
- **实时增量推进 = NOT-OBSERVABLE**。理由：当前 UTC 15:1x–15:4x = 北京 23:1x–23:4x，A 股已收盘，30m 桶不再前进；且 D1 的 forming 桶只在有 1m 实时数据时前进。**落地窗口**：下一交易日 09:30–15:00 CST（01:30–07:00Z）观察 30m 出现新桶（或 30m 末桶随 1m 实时变化）即可闭环；本轮不记为 PASS/FAIL。

---

## V6 实测密度比 1m:30m（D2 输入）

### 结论：**NOT-DONE**

未做，且**在 D1 实例上结构不可做**：P0.3 口径要求「pane 宽 520px 下真渲染量取 `同窗基准 bar 数 / 卫星 bar 数`」，而本轮 V4(f) 已证实**多周期 K 线基准档不含 30m**（D1 有意），故在线实例不存在「以 30m 为基准或卫星的 520px pane」可量。未做任何近似替代（不按名义周期比兜底 —— ADR §2.5 明令）。

可交付的**旁证（非 P0.3 口径，不得直接入表）**：`MEASURED_DENSITY_TABLE` 现有条目 `1m:5m=4.7 / 1m:15m=12.2 / 1m:1h=37.8`，与「基准日根数 ÷ 卫星日根数」高度接近（241/50=4.82、241/18=13.4、241/6=40.2）；按同法 `1m:30m ≈ 241/10 = 24.1`。**仅供参考，需 D2 真渲染定标。** 合成值漂移校验（15m↔30m、5m↔30m、30m↔1h）同因 30m 不可选而未做。

---

## V7 副作用审计

| 审计项 | 命令 | 结果 | 判定 |
|---|---|---|---|
| `git status` 未变 | `git status --porcelain > final_git_status.txt; diff baseline final` | `GIT_STATUS_IDENTICAL`；sha256 前后均 `c20c326aabf27367bec0e0909c8d631837d0e35012dc0ccce314ebe9cb9aaa51` | ✅ |
| HEAD 未变 | `git rev-parse HEAD` | 前后均 `3094018f352dae25752340d78b5e108c284aeecc`（`HEAD_IDENTICAL`） | ✅ |
| 无 staged | `git diff --cached --name-only \| wc -l` | `0` | ✅ |
| 无临时残留 | 全部脚本/日志/截图在 `/tmp/adr023-postdeploy-20260916T151312Z/` | 仓库内新增文件 0（git status 逐字节相同即证） | ✅ |
| 在线进程 | `ps -o pid,etime,cmd -p 68833` | 仍为 PID 68833，同一命令行，`ELAPSED 08:27`（未重启，仅时长增长） | ✅ |
| 端口 | `ss -ltnp \| grep -E '8081\|8082'` | 0.0.0.0:8081、0.0.0.0:8082 仍属 PID 68833 | ✅ |
| 可用性 | `curl -o /dev/null -w %{http_code} /` | `8081 / = 200`；`8082 / = 404`（MCP 面，非 HTTP 根路径） | ✅ |
| 容器未动 | `docker ps` | `eestock-timescaledb Up 11 days (healthy)`、`eestock-data Up 11 days (healthy)`（与基线同） | ✅ |
| 无写 API 痕迹 | 探针请求日志 + `app_config.updated_at` | **1 次 `PUT /api/config/multi_period`**（见 V4(g) / `v7_app_config.txt`），无 POST/DELETE/PATCH | ⚠️ **FAIL** |
| 无 entangled 写 | 未执行 `entangled tangle`/`stitch`；`check-tangle.sh` 自带沙箱并自证未改工作区 | ✅ |

---

## 残留风险与未决项

- **R1（本时段唯一副作用，需架构师裁决）**：V4 探针 2 打开多周期选择器入口时，页面自身发出 `PUT /api/config/multi_period` 并落库（`app_config.updated_at = 2026-09-16 15:18:09Z`），落库值 `{"enabled":true,"periods":["1m"],"heights":{"1m":420},"indicators":["dcap"]}`。未决：① 该位是否被我翻转（探针前未快照，页面入口可见性反证 `enabled` 早已为 `true`，但**不可证**）；② 是否值得把「打开选择器 ⇒ 页面自动 PUT」本身登记为缺陷（**越权写**：一次只读意图的 UI 交互产生持久化写）。**另请后续验收纪律补一条：浏览器只读验收前必须快照 `app_config` 全表。**
- **R2（可观测性）**：在线实例的 `kline_accurate` 在验收期间**并非静止快照**：M1 行数 16344861 → 16344877 → 16344861、`count(distinct code)` 53 → 44、M1 日集合 3574 → 3572。与既有 sim-live/写路径相关（非本 ADR 范围），但**会使 V2/V3 的计数在极端时点漂移**；本轮两次独立复跑均为 0 缺口、440/792/264/2200，结论稳定。
- **R3（判据口径）**：V3 的 `amount` 在 50/440 桶非位级相等（≤2.98e-8，double 求和序）。既有 15m 同现象（111/792）。若架构师要求位级相等，需把判据改为容差（如相对 1e-12）或改列类型；本轮按「与既有几何同构」判 PASS 并显式披露。
- **R4（策略参数观感）**：新建 `kline_accurate_30m` 沿用 1h 先例，`schedule_interval = 1 hour`、`end_offset = 1 hour`（`v2_jobs.txt` job 1053）；即 30m 桶最坏滞后约 1h 物化。ADR §2.4.4 只强制 `start_offset`，未见对 30m 调度间隔的裁决 → **未决项**（非本轮判据）。
- **R5（V6 未做）**：`D(1m→30m)` 与合成值漂移校验未测（理由见 V6）；D2 需另派。
- **R6（时间盒）**：本时段实际用时约 35 分钟（超 30 分钟盒 5 分钟）。V1–V5、V7 已完成，V6 NOT-DONE；无「证据未落盘」项。
- **R7（1d cagg 落后）**：`kline_accurate_1d` `max(ts)=2026-09-14 16:00Z`，落后 2 个交易日（既有现象，不在 V2 判据内，登记备查）。

---

## 证据文件索引（目录 `/tmp/adr023-postdeploy-20260916T151312Z/`）

| 文件 | 内容 |
|---|---|
| `EVIDENCE.md` | **本文件（自指）** |
| `baseline_git_status.txt` / `baseline_head.txt` / `final_git_status.txt` / `final_head.txt` | V7 前后快照 |
| `v1_cargo_workspace.log` / `v1_period30m_targets.txt` / `v1_period30m_rerun.log` / `v1_period30m_rerun_summary.txt` | V1 Rust |
| `v1_check_tangle.log` / `v1_vitest.log` / `v1_npm_build.log` | V1 门禁 / 前端 |
| `v2_caggs2.txt` / `v2_cagg_def.txt` / `v2_jobs.txt` / `v2_daily_counts.txt` / `v2_max_ts.txt` / `v2_ranges.txt` / `v2_recent_days.txt` / `v2_day_antijoin.txt` / `v2_day_antijoin_repeat.txt` / `v2_missing_days.txt` / `v2_m1_period_dist.txt` / `v2_small_codes.txt` / `v2_unknown_period.txt` | V2 活库 |
| `v3_schema.txt` / `v3_bucket_compare.txt` / `v3_daywide_diff.txt` / `v3_daywide_mismatch_detail.txt` / `v3_alignment.txt` / `v3_baseline_15m_1h_ulp.txt` | V3 逐桶 |
| `v4_probe.cjs` / `v4_probe_stdout.txt` / `v4_probe_result.json` / `v4_probe2.cjs` / `v4_probe2_result.json` | V4/V5 浏览器探针（脚本与原始 JSON） |
| `v4_a_default_15m.png` / `v4_b_30m_main.png` / `v4_b_30m_canvas.png` / `v4_c_multi_period_picker.png` | 截图 |
| `v5_latest_30m_raw.json` / `v5_latest_30m.txt` | V5 最新查询 |
| `v7_tup_stats.txt` / `v7_app_config.txt` / `v7_multi_period_config_after.json` | V7 审计 |
