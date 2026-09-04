# 统一读源 — 所有周期「accurate 优先 + 底层兜底」（coder 变更报告）

> 本报告位置：`eestock-rs/coder/report/021_unified_read_source.md`
> 用户定稿 2026-09-04。修「往前翻几天就没数据」：所有周期都能深翻历史，返回 2024 起即可。
> 全程 TDD（先改 design 代码块 → entangled tangle 生成 → 测试 → 手动应用迁移 + 实盘验证）。
> 门禁三件套：`cargo test --workspace` / `cargo clippy` / `check-tangle` 全绿（见 §6）。

## 1. 变更总览（what changed）

| 层 | 文件 | 变更 |
|---|---|---|
| design | `design/04-storage/schema.md` | +§4.3.4 统一读源 accurate 连续聚合（0010 块）+ 运维注记 |
| design | `design/04-storage/03-raw-writer.md` | migrate_check `EXPECTED_RELATIONS` +`kline_accurate_5m/15m/1h` |
| design | `design/07-app-plane/00-web-api.md` | §3 读源口径改写；`reader.rs` 块：`merged_sql`/`FALLBACK_1H`/`period_merged_sql` 替换 `cagg_sql`/`ROLLUP_1H_SQL`；§9 kline_reader.rs 测试块改写 + 新增深翻测试 |
| migrations | `0010_accurate_caggs.sql`（新） | `kline_accurate_5m/15m/1h` continuous aggregate（`kline_accurate` M1 聚合，`WHERE ts >= '2024-01-01'`）+ 3 条刷新策略 |
| storage | `src/reader.rs` | `bars()` 所有周期统一走 `period_merged_sql()`（accurate 优先 + 兜底反连接）；**删除**「其余周期直查 cagg」分支 |
| storage | `src/migrate_check.rs` | EXPECTED_RELATIONS +3 新 cagg |
| storage | `tests/kline_reader.rs` | `merged_periods_accurate_first_and_1h_rollup`（旧 `cagg_periods_and_1h_rollup` 改写为 accurate-first）；+ `unified_read_deep_history_to_2024` |

行数：设计/生成物 6 文件修改 + 1 新迁移文件（`git diff --stat` 见 §6）。

## 2. 问题与根因（problem solved）

- **根因**：`reader.rs` 的 `1m` 走 `kline_merged`（accurate M1 优先，深历史），但 `5m/15m/1d` 直查
  raw-derived cagg（`kline_5m/15m/1d`），而 raw 只采集 ~2 周（实盘 `kline_15m` 仅 42 行/518880，
  2018-09 后无数据——实测见 §7.1）→ 往前翻几天就断档；`1h` 由 `kline_15m` rollup，同样只 2 周。
- **修复**：把 ADR-003「accurate 优先 + 底层兜底」语义推广到所有周期。`kline_accurate` M1
  （2012→今，16.26M 行）为全历史真值；新增 accurate 高周期 cagg（2024→今）+ 底层兜底反连接。

## 3. 统一读源模型（每个周期 P）

```
读取 = accurate_<P>（优先，覆盖 2024-01-01→今）
      UNION ALL 兜底层_<P>（raw→P=1m；cagg_<P>→5m/15m/1d；15m-rollup→1h）
      + NOT EXISTS 反连接（accurate 已覆盖的剔除兜底层 → accurate 优先）
```

- `P=1m`：现有 `kline_merged` 语义（accurate M1 + raw 兜底），未动。
- `P=5m/15m/1h`：新 `kline_accurate_5m/15m/1h` cagg，从 `kline_accurate WHERE period='M1' AND ts >= '2024-01-01'` 聚合。
- `P=1d`：**复用** `0005` 既有 `kline_accurate_1d`（聚合全量 M1），未 DROP/重建（避免破坏生产已物化数据）。
- 兜底：5m/15m/1d 用现 `kline_5m/15m/1d`；1h 用 `kline_15m` 查询期 rollup；1m 用 raw。

### 3.1 D1 复用裁决（偏离「新建 kline_accurate_1d」）

任务书写「新建 kline_accurate_1d」，但 `0005` 已建 `kline_accurate_1d`（聚合全量 M1，无 2024 过滤）。
未 DROP/重建（DROP 会清空其已物化数据并移除其刷新策略 job 1037，属生产破坏性操作）。改为**复用**并在
本轮做全量刷新（`CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL)`，16.8s），
物化 `2012-01-03→2026-09-03`（67469 行）。后果：D1 深历史为 2012+（**超集**，优于「2024 即可」），
而非严格 2024 起；功能正确，仅与 5m/15m/1h（2024 起）在「起点」上不一致。已在 §5 残余风险标注。

## 4. Implementation approach

- **迁移**：TimescaleDB continuous aggregate（`CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)`），
  与现有 `0005 kline_accurate_1d` / `0002 kline_5m` 语法一致。5m/15m 用 2 参 `time_bucket`（UTC 桶，
  与 `kline_5m/15m` 一致），1h 同；D1 复用既有 `kline_accurate_1d`（Asia/Shanghai 3 参桶）。
  刷新策略近期窗口增量（5m start_offset 2h、15m 6h、1h 2d），深历史由创建时自动 refresh + 手动 refresh 物化。
- **reader 统一 merged 查询**：`merged_sql(accurate_table, fallback)` 构造
  `accurate SELECT ... UNION ALL fallback SELECT ... WHERE NOT EXISTS(...)`，外层 `ORDER BY ts DESC LIMIT $3`。
  保持 `bars()` 游标分页签名不变（before/limit + 升序翻转），`source` 列：accurate 分支 `'tushare'`，
  兜底分支 `NULL`。1h 兜底为 `kline_15m` 桶级 rollup（`FALLBACK_1H` 片段），桶 ts 与 `accurate_1h` 对齐后反连接。
  表名/片段均内部 match 常量拼接（无注入面）。
- **回填/刷新**：迁移创建时自动 `REFRESH`（物化 2024→今）；另手动 `CALL refresh_continuous_aggregate`
  对 `kline_accurate_1d` 全量刷新以物化深历史。实盘 518880 各周期 2024 数据查询见 §7。

## 5. Test coverage

- **更新**：`merged_periods_accurate_first_and_1h_rollup`（原 `cagg_periods_and_1h_rollup`）——断言
  各周期 overlap 分钟返回 accurate（close=9.99/vol=777/source='tushare'）而非 raw 侧。
- **新增**：`unified_read_deep_history_to_2024`——在 2024-01-01/01-02 种 M1，before 游标（limit=1）从
  2024-01-03 往回翻，断言持续推进到 2024-01-01、降序 cursor 严格前进、无重复数据点（覆盖 M1/M5/M15/H1/D1）。
  ⚠️ D1 用 Asia/Shanghai 日界，2024-01-01 交易日桶 ts=2023-12-31 16:00 UTC，故测试刷新窗口扩展到 2023-12-31。
- 其余 storage 集成测试（accurate_upsert / alert_store / event_sink / raw_writer / symbol_admin / symbols_registry）
  与下游 mcp/web kline 测试全部保持通过（无回归）。

## 6. Verification（commands-run）

| 命令 | 结果 | 说明 |
|---|---|---|
| `entangled tangle` | passed | design → 生成物单向 tangle 一致 |
| `cargo check --workspace` | passed | 全 workspace 编译通过 |
| `cargo test --workspace` | passed | 全 workspace 测试 0 失败（含 storage kline_reader 9/9） |
| `cargo clippy --workspace --all-targets` | passed | 0 warning（修复了 `doc_lazy_continuation`） |
| `./scripts/check-tangle.sh` | passed | tangle 后无 diff，design 与生成物一致 |
| `cargo test -p storage --test kline_reader` | passed | 9/9（含两个新/改写测试） |
| 迁移应用 `psql -f migrations/0010_accurate_caggs.sql` | passed | 12.5s；建 kline_accurate_5m/15m/1h + 3 策略 |
| `CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL)` | passed | 16.8s；物化 2012→2026（67469 行） |
| 实盘 518880 各周期 merged 查询（before=2024-03-01） | passed | 1m/5m/15m/1h/1d 均返回 2024-02 数据（source=tushare） |

### 6.1 实盘深翻验证证据（518880，before='2024-03-01T00:00:00Z'，limit=3）

- 兜底 raw-derived `kline_15m`：`count=42, 2026-09-02→2026-09-04`（只 2 周）→ 修复前深翻必断档。
- `15m` merged 返回：`2024-02-29 07:00:00+00 / 06:45 / 06:30 ... source=tushare`。
- `5m` merged 返回：`2024-02-29 07:00/06:55/06:50 ... source=tushare`。
- `1d` merged 返回：`2024-02-29 16:00 / 2024-02-28 16:00 / 2024-02-27 16:00 ... source=tushare`（Asia/Shanghai 日桶）。
- `1h` merged 返回：`2024-02-29 07:00/06:00/05:00 ... source=tushare`（accurate_1h + kline_15m rollup 反连接）。
- `1m` merged（kline_merged）：`2024-02-29 07:00/06:59/06:58 ... source=tushare`。

各周期 next_before 游标在 `unified_read_deep_history_to_2024` 集成测试中锁定（双点翻页持续推进）。

## 7. 架构对齐 / 红线

- **分层**：仅改 `storage`（reader/migrate_check）+ 迁移 + 相关 design 文档；`KlineRead` 端口签名、事件契约、
  web/mcp 消费方零改动（web/mcp 测试全绿佐证）。未改接口/层边界/依赖方向。
- **DB 红线**：未重建 eestock-timescaledb 数据卷；迁移经 **psql 手动应用**（含执行）。未触其他项目 docker。
- **反向验证**：`unified_read_deep_history_to_2024` 已证明 before 到 2024 边界后 reader 正常返回，
  且 API 边界（`kline_cursor_pagination_cagg_and_validation`）确认前端 feed/pageSize 逻辑不变"；（前端未改，翻到无数据自然停）。

## 8. Residual risks

1. **D1 复用偏离**：`kline_accurate_1d` 复用既有 cagg（无 2024 过滤），全量刷新后为 2012+ 数据（超集），
   而非任务书「严格 2024 起、不聚合 2012 前」。功能正确、深历史更深；如需严格 2024 起需 DROP+重建（生产破坏性，未做）。
2. **API 级 `GET /api/kline` curl 未执行**：eestock-app 容器未重建/重启（避免瞬断运行服务）；已用
   `cargo test`（reader 直接验证）+ 生产库 SQL（mirror API 返回）双重验证。若需 API curl，需 `docker compose build app && up -d app`。
3. **深翻性能未基准**：merged 反连接查询在深翻（多页 before）场景下功能正确，但未对旧「直查 cagg」做
   多页深翻性能对比；单页索引扫描 + 排序 + LIMIT 已在集成测试中执行。
4. **cagg 策略/数量新增**：新增 job 1039/1040/1041（accurate 5m/15m/1h 刷新策略）；创建时自动 refresh
   物化了 2024→今（5m 1.4M、15m 502k、1h 167k 行）。运维注意勿与 kline_accurate_1d（job 1037）混淆。
5. **前端未实测深翻 UI**：本轮只改读层；前端 feed 逻辑不变（调用方契约未变），但未在浏览器实测多页翻回 2024。

## 9. Staging 说明

已 `git add` 本任务 7 个文件（1 新迁移 + 6 修改），**未 commit**。预存 untracked 文件（.claude/、AGENTS.md、
logs/*、backup_symbols.sql、tester/report/007_wave2_acceptance.md 等）**未纳入**本任务 staged 集。
`check-tangle.sh` 在 staged 后通过（worktree==index 无 diff）。
