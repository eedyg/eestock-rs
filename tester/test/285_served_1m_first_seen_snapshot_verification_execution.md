# 285 执行报告 —— 专项核实（只读）：当日 1m 在「对外提供」的序列里是否为首见快照（未回填）

- **报告自身路径**：`tester/test/285_served_1m_first_seen_snapshot_verification_execution.md`
- 设计报告：**无**（本任务为既有数据的专项核实，未新增测试代码，不产出 design 报告）
- 证据目录：`tester/evidence/285_served_stale/`（`00`–`11`，共 12 个只读证据文件）
- 前序（本轮存疑来源）：`tester/test/284_1m_bar_ts_phase_verification_execution.md`（1m ts=结束分钟；顺带发现 DB 当日行疑似首见快照）
- 仓库 / commit：`/home/eestock/workspace/git/eestock/eestock-rs` @ `64f3271`（工作树有 3 个 web 前端改动，**未触碰**）
- 被测实例：线上 8081（PID 3300395，09:21:15 启动）——**未重启、未写配置、未发任何写请求**
- 执行时间：2026-09-15 **09:55:33 ~ 09:57:30**（Asia/Shanghai，真实盘中；时间盒 ≤15min）
- 只读纪律：仅 `GET /api/kline`、**只读 SELECT**（psql `-c "SELECT ..."`）、外部只读 GET（`ifzq.gtimg.cn` mkline m1）；无写请求/PUT/重启；**未 git add/commit/stash**；仓库内新增仅本报告与 `tester/evidence/285_served_stale/*`

---

## 0. 结论先行

| 问题 | 结论 |
|------|------|
| 对外序列（`GET /api/kline?period=1m`）当日值 == 厂商最终值？ | **否**。19/19 标号的对外 volume 与 `kline_raw` **逐位相等**，其中 17/19 显著小于厂商最终值（最小 1%，见 §2 表）。只有 2 个标号（09:35、09:43）恰与厂商最终值相等——因其落库轮询恰好跨过窗口收盘 |
| 对外序列 == 首见快照 ≠ 厂商最终？ | **是**（`VERDICT: SERVED-STALE`） |
| 只是 `kline_raw` 保留原始快照、对外走 accurate？ | **否**。当日 `kline_accurate(M1)` **0 行**（max ts = 2026-09-14 15:00）；merged 读源（accurate 优先 + raw 反连接兜底）**回落 raw** ⇒ 对外当日 1m 即 raw 首见快照 |
| 分层与读源 | `/api/kline` 1m 实际读源 = `kline_accurate(M1)` ∪ `kline_raw`（accurrate 优先）的**逻辑合并**（`MERGED_1M_SQL`）；当日 accurate 空 ⇒ **实际命中的物理表是 `kline_raw`** |
| 回填时机 | `kline_raw` **永不回填**（写入为 `ON CONFLICT (code,ts) DO NOTHING`，首写胜出 ADR-002）；真值回填只发生在 **tushare accurate 层**，且当日无行 —— `sync_checkpoints(518880,M1).last_synced_date = 2026-09-14`（updated_at 2026-09-15 08:00 CST），即**次日 08:00 CST 前后**才把当日 1m 补进 accurate |
| 影响面 | 今日 1m 序列在整个交易时段内对外形态为「首见部分量快照」：多周期 LIVE 段的 1m 卫星、④（前端每分钟兜底 `GET /api/kline`）、含当日的盘中研究/回测 1m 区间；**量类信号被系统性低估（可低至 1~3%）**；价类（OHLC）相对稳健但亦有偏差（首见价非最终价）。**昨日及更早不受影响**（accurate 已覆盖并优先） |

---

## 1. 数据面分层与 `/api/kline` 实际读源（只读证据）

| 层 | 对象 | 角色 | 当日（09-15）状态 |
|----|------|------|-------------------|
| raw | 表 `kline_raw`（hypertable，PK(code,ts)，含 `ingested_at`） | 实时采集落库；**首写胜出，永不回填** | **有当日行**（每标号 1 行，为轮询首见值） |
| accurate | 表 `kline_accurate`（PK 含 period） | tushare 真值层（ADR-003 统一读源） | **当日 0 行**（max ts = 09-14 15:00）；对 518880 M1 共 769,754 行 |
| merged | 视图 `kline_merged`（accurate M1 UNION ALL raw 反连接） | 历史/对外 1m 逻辑合并 | 当日部分 = raw |
| cagg | 视图 `kline_accurate_{5m,15m,1h,1d,1w,1mo}`、`kline_{5m,15m,1d}` | 高周期（均从 `kline_accurate` M1 聚合） | 当日无来源行可聚合（accurate 空） |

**读源代码证据**（`crates/storage/src/reader.rs`，证据 `08`）：

- `KlineReader::bars` → `period_merged_sql(period)`；`Period::M1 => MERGED_1M_SQL`（`reader.rs:103-113`）。
- `MERGED_1M_SQL`：branches = `(SELECT ... FROM kline_accurate a WHERE a.period='M1' ORDER BY a.ts DESC LIMIT $3)` **UNION ALL** `(SELECT ... FROM kline_raw f ... AND NOT EXISTS (SELECT 1 FROM kline_accurate a WHERE a.code=f.code AND a.ts=f.ts AND a.period='M1') ORDER BY f.ts DESC LIMIT $3)` → **accurate 优先，raw 兜底**（`reader.rs:40-57`）。
- M1 **不参与 forming 桶合入**：`forming_sql` 对 `Period::M1` 返回 `None`（`reader.rs:118-124`）⇒ 1m 右缘完全由 merged 结果决定，无独立的"实时聚合"分支。
- 应用/回测侧同语义：`crates/storage/src/backtest.rs` `BacktestBarReader::bars` M1 走 `M1_RANGE_SQL`，其 `FROM kline_merged`（证据 `09`）⇒ **API 与盘中研究/回测是同一条 1m 逻辑读源**。
- raw 写入：`crates/storage/src/kline.rs:26` `INSERT INTO kline_raw (...) ... ON CONFLICT (code, ts) DO NOTHING`（文件头注释即写「首写胜出，ADR-002」；证据 `07`）；全仓 `INSERT INTO kline_raw` 仅此一处（无 UPDATE/UPSERT 回填路径）。

**行为对照**（§2 表）：对外序列 19/19 标号 volume 与 raw 逐位相等 ⇒ 行为与代码一致，读源判定被双向证实。

---

## 2. 对比表（同一批今日已过去分钟，09:32–09:50；1m 标号 = 结束分钟）

单位＝手（对外/raw 的 `volume` 为股，表内已 ÷100 归一）。厂商值取 `ifzq` mkline m1 最终值（同一标号语义）；raw/对外取同一观测时刻（09:55:33–09:56:47）。

| 标号 | 厂商最终(手) | 对外序列(手) | raw(手) | raw `ingested_at`(CST) | 对外==raw | 对外 vs 厂商 |
|------|-------------:|-------------:|--------:|------------------------|-----------|--------------|
| 09:32 | 55940 | 25521 | 25521 | 09:31:26 | ✅ | **STALE 46%** |
| 09:33 | 28493 | 23254 | 23254 | 09:33:01 | ✅ | STALE 82% |
| 09:34 | 26277 | 25702 | 25702 | 09:34:12 | ✅ | STALE 98% |
| 09:35 | 43596 | 43596 | 43596 | 09:35:26 | ✅ | MATCH（轮询跨收盘，恰为首见终值） |
| 09:36 | 22586 | 6415 | 6415 | 09:35:26 | ✅ | **STALE 28%** |
| 09:37 | 30506 | 6636 | 6636 | 09:36:20 | ✅ | **STALE 22%** |
| 09:38 | 36230 | 15127 | 15127 | 09:37:27 | ✅ | **STALE 42%** |
| 09:39 | 28829 | 332 | 332 | 09:38:21 | ✅ | **STALE 1%** |
| 09:40 | 27048 | 3497 | 3497 | 09:39:07 | ✅ | **STALE 13%** |
| 09:41 | 28533 | 500 | 500 | 09:40:13 | ✅ | **STALE 2%** |
| 09:42 | 21062 | 416 | 416 | 09:41:09 | ✅ | **STALE 2%** |
| 09:43 | 47582 | 47582 | 47582 | 09:43:20 | ✅ | MATCH（轮询跨收盘） |
| 09:44 | 36702 | 1035 | 1035 | 09:43:20 | ✅ | **STALE 3%** |
| 09:45 | 17598 | 3909 | 3909 | 09:44:22 | ✅ | **STALE 22%** |
| 09:46 | 13694 | **1587** | 1587 | 09:45:18 | ✅ | **STALE 12%**（284 报告同一点） |
| 09:47 | 19855 | 14358 | 14358 | 09:47:05 | ✅ | **STALE 72%** |
| 09:48 | 17717 | 17948 | 17948 | 09:48:09 | ✅ | STALE 101%（换源 sina 后同现象） |
| 09:49 | 12222 | 11850 | 11850 | 09:49:01 | ✅ | STALE 97% |
| 09:50 | 23710 | 24497 | 24497 | 09:50:16 | ✅ | STALE 103%（换源 sina 后同现象） |

- 数据文件：`10_comparison_table.txt`（生成脚本内联于证据目录同批命令）、`01_api_kline_518880_1m_limit60.json`、`02_vendor_ifzq_m1.json`、`03_db_kline_raw_today.txt`。
- **机制判读（观测层，不做修复分析）**：raw 标号 `T` 的 `ingested_at` 几乎恒为宿主 `T−1` 分钟内的轮询时刻（`T` 前的窗口进行中，如 09:39 ← 09:38:21、09:46 ← 09:45:18），此时厂商该行仅累积了部分成交 ⇒ 落库即**首见部分量**；因 `DO NOTHING`，此后不再更新，故对外整日保持该部分量。
- **反向核对（证明"不改写"而非"我观测过早"）**：09:56:47 再次拉取，已收盘 12~18 分钟的标号 09:39/09:41/09:44/09:46/09:47 对外仍为 332/500/1035/1587/14358（证据 `11_no_backfill_recheck.txt`）——窗口早已结束、厂商已终值，值仍不变。
- **跨日同类现象（旁证机制，非本次范围）**：`11_*.txt` 的 raw 历史行显示 09-04~09-14 的 raw 亦多为首见部分值（如 09-14 09:46 = 120 手，09-14 09:44 = 2524 手；而 09-03 全表 `ingested_at` 同为 13:54:37 系批量导入故为完整值）。**这些历史日对外的 1m 由 accurate 优先提供（= 厂商终值）**，故历史日对外正确 —— 与 284 报告"09-14 收盘行与厂商最终完全相等"一致。

---

## 3. 结论（三选一）

### `VERDICT: SERVED-STALE`

- 对外 1m 序列在**当日**切片上 == `kline_raw` 首见部分量快照 ≠ 厂商最终值（19/19 对外==raw；17/19 显著偏低，最低 1%）；
- 排除"仅 raw 为首见、对外走 accurate/merge 视图"的解释：当日 `kline_accurate(M1)` **0 行**，merged 读源必然回落 raw；
- `kline_raw` 无回填路径（`ON CONFLICT DO NOTHING`，单点写入）；真值仅在 **次日 08:00 CST 前后**（`sync_checkpoints.last_synced_date=2026-09-14`，tushare 日同步）进入 accurate 并接管对外。

---

## 4. 影响面（读"对外提供序列"的消费者）

| 消费者 | 读源 | 受影响？ | 说明 |
|--------|------|---------|------|
| 多周期 LIVE 段（1m 卫星；282/284 专项的宿主） | `GET /api/kline?period=1m` → merged | **是（今日全程）** | 1m 卫星末根及历史分钟均为首见部分量；成交量/金额直接失真，价格为首见价 |
| ④ 前端每分钟兜底 | 前端轮询 `GET /api/kline`（合约见 `tester/report/055_*.md`） | **是（今日全程）** | 兜底序列被同一陈旧值填充；"更晚 append / 同 ts 覆盖"机制本身不受破坏（值内容陈旧） |
| 盘中研究 / 含当日的 1m 回测（`application::strategy/workbench`、`BacktestBarRead`） | `kline_merged`（M1_RANGE_SQL） | **是（窗口含今日时）** | 与 API 同一逻辑读源；量类因子（量比、放量阈值、VWAP/amount 类）当日系统性失真 |
| 高周期 5m/15m/1h 的 forming 桶 | `forming_sql` 聚合 **kline_raw** | **是** | forming 桶直接从 raw 求和 ⇒ 当日未闭合/已闭合桶的成交量同样为首见和的量级；且 1m 已闭合桶在 raw 中永不修正 ⇒ 若 cagg 未覆盖当日，则高周期当日量同样偏低 |
| 历史（≤ 09-14）一切读取 | accurate 优先 | 否 | accurate 覆盖并优先，raw 陈旧被屏蔽（284 已实证） |

**观测到的最大失真**：单分钟成交量最低仅剩厂商终值的 **1%**（09:39：332 vs 28829 手）。

---

## 5. 最小复现（只读，任何人可重放）

1. `curl -s "http://127.0.0.1:8081/api/kline?code=518880&period=1m&limit=60"` → 取标号 `09:39` 的 `volume`（观测值 33200 = 332 手，`source=tencent_ifzq`）。
2. `curl -s "http://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh518880,m1,,40"` → `m1` 中 `202609150939` 的第 6 字段 = `28829.000` 手。
3. `psql ... -c "SELECT volume/100, ingested_at FROM kline_raw WHERE code='518880' AND ts='2026-09-15 01:39:00+00'"` → `332 | 2026-09-15 09:38:21+08`。
4. `psql ... -c "SELECT count(*) FROM kline_accurate WHERE code='518880' AND period='M1' AND ts >= '2026-09-15 00:00:00+08'"` → `0`。
⇒ 三值关系：对外 332 == raw 332 ≠ 厂商 28829；且 raw 该行写于窗口进行中（09:38:21）。

**候选修法方向（仅列方向，未动手、不在本任务授权内）**：raw 层写入改为"窗口内 UPDATE / 收盘后覆盖"（如 `ON CONFLICT DO UPDATE`，或窗口闭合后二次 upsert）以保留终值；或在阅读侧对当日未闭合/已闭合分钟走"实时重取"；或把当日准确层同步频率提高（当前日同步 ⇒ 当日无 accurate）。**上述均需架构决策，本报告不改代码、不定方案。**

---

## 6. 残余不确定

1. **未验证 04（前端）真机行为**：④ 兜底为前端契约（055 报告），本次仅核实其后端数据源；前端是否另有本地累积/覆盖逻辑未实测。
2. **未逐分钟核对价格（OHLC）**：本轮聚焦 volume（最尖锐且可判定的指标）；对外 OHLC 与厂商最终 OHLC 的逐分钟差异未展开（首见快照性质上应同样存在，但未逐一取证）。
3. **sina 段单位/口径**：09:48 起 `source=sina_jsonp`，其对外值与厂商终值出现 101%/103%（略大于终值），提示换源后口径（如是否含盘后/单位）可能另有细节，本次未深究（不影响"对外==raw≠终值"的判定）。
4. **回填确切时刻**：仅由 `sync_checkpoints.last_synced_date=2026-09-14` + `updated_at 08:00 CST` 推断"次日 08:00 CST 前后"；未观察一次真实回填跨越（需等次日）。
5. **未覆盖其它标的/周期**：仅 `518880` 1m；判断上属系统性机制（写入路径与读源为全局代码），但未抽样第二标的。

---

`VERDICT: SERVED-STALE(对外 1m 当日 == kline_raw 首见部分量快照 ≠ 厂商终值；kline_accurate(M1) 当日 0 行，merged 读源必然回落 raw，raw 为 ON CONFLICT DO NOTHING 永不回填；19/19 标号对外==raw，最低仅 1% 终值；影响多周期 1m LIVE 卫星、④ 兜底、含当日盘中研究)`
