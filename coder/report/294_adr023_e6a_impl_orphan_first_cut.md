# 292 — ADR-023 E6a 第一刀（P1-1 / P2-1 / P1-2）—— **实现报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/292_adr023_e6a_impl_orphan_first_cut.md`
- 证据目录：`/tmp/adr023-e6a-impl-20260917T011303Z/EVIDENCE.md`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §6.1 第 8 条 + §6.3 第 12 条
- 父级裁决：**(C1)**（驳回 A「storage→diagnose 依赖边」与 B「端口收 SQL 文本」），契约见下 §2
- 红测试（未重写判据部分）：`crates/web/tests/orphan_detect_endpoint_red.rs`、`crates/web/tests/orphan_detect_sql_constant_red.rs`、`crates/web/tests/orphan_probe/mod.rs`
- 超时披露：**超出 30 分钟时间盒**（§7）

---

## 1. What changed（文件 + 行数）

| 文件 | 归属 | 行数 Δ | 改动 |
|---|---|---|---|
| `design/02-domain/contracts.md` | 事实源（`file=crates/domain/src/ports.rs`） | +16/−1 | `OrphanReport` 读模型 + `QualityRead::orphan_rows()`（**带默认实现**） |
| `design/07-app-plane/00-web-api.md` | 事实源（6 个 `file=` 块 + API 表 1 行） | +96/−19 | ports 之外的 5 个产物 + API 表 |
| `crates/domain/src/ports.rs` | generated（tangle） | +16/−1 | 同上 |
| `crates/diagnose/src/quality.rs` | generated | +7/−2 | import `OrphanReport`；`QualityService::orphan_rows()` 仅**转发**端口 |
| `crates/storage/src/reader.rs` | generated | +48/−1 | `ORPHAN_TABLES` / `ORPHAN_ROWS_SQL`（**唯一 SQL 定义**）+ `impl QualityRead::orphan_rows` |
| `crates/web/src/rest.rs` | generated | +12/−0 | `get_quality_orphans` handler（只搬运类型化结果） |
| `crates/web/src/lib.rs` | generated | +1/−0 | `.route("/api/quality/orphans", get(rest::get_quality_orphans))` |
| `crates/storage/tests/kline_reader.rs` | generated | +34/−7 | `clean()` 删完即重算 + `cst_day_start/cst_month_start` 辅助 |
| `crates/web/tests/api_rest.rs` | generated | +26/−4 | `clean_kline` / `clean_sym` 删完即重算；`refresh` 串行化锁；P2-1 NULL,NULL → 显式窗口 |
| `crates/web/tests/api_kline_period.rs` | **手写**（非 tangle） | +10/−0 | `clean()` 删完即重算 W/MO |
| `crates/web/tests/orphan_detect_endpoint_red.rs` | tester 红测试（授权改 R2 only） | R2 重写 | (a)–(f) 新契约 |
| `crates/web/tests/orphan_detect_sql_constant_red.rs` | tester 红测试（授权改 R2 only） | import/注释 | `diagnose::quality::*` → `storage::reader::*` |

`git status` 中另有一个 ` M design/01-architecture/adr/ADR-023-….md`：**非本轮改动**（mtime 09:03:33，早于本轮 09:13 开工）。

## 2. Architecture alignment（按父级 (C1) 裁决）

- **domain（契约层）**：只新增**类型化**读模型 `OrphanReport{rows, by_table}` 与端口方法
  `QualityRead::orphan_rows()`，**签名不含任何 SQL 文本参数**；给 **默认实现**（`bail!`）⇒ 既有 4 个
  implementor（含 2 个 mock/测试替身）零改动、不静默返回空。
- **storage（基础设施）**：孤儿谓词与「哪 10 张 cagg」是 **schema 知识** ⇒ 唯一 SQL 定义
  `ORPHAN_ROWS_SQL` + 表清单 `ORPHAN_TABLES` 只出现在 `crates/storage/src/reader.rs`（**全仓一处**）。
- **diagnose（应用层）**：只 `self.quality.orphan_rows().await` 转发；**无**任何 cagg 表名/SQL 文本。
- **web（表现层）**：handler 只把 `OrphanReport` 折成 `{"rows","by_table"}`；经既有 `/api/quality/*`
  错误口径（`internal(e)` → 500）。
- **零新依赖边**：未改任何 `Cargo.toml`/`Cargo.lock`。实测 `cargo tree -e normal -p storage | grep -c diagnose = 0`、
  `cargo tree -e normal -p domain | grep -c sqlx = 0`。
- **发现但未顺手修**：`crates/web/src/dto.rs:28` 的**注释**里出现 `kline_15m` 字样（非 SQL 文本），
  故 R2(f) 的实现口径取「谓词 + `from <表>` SQL 形态」而非裸表名（见 §4 独立推导）。

## 3. Implementation approach & 窗口推导（硬规则：逐字符按桶边界）

**P1-2 端点**
- `GET /api/quality/orphans` → `200 {"rows": i64, "by_table": {10 键: i64}}`；`rows = Σ by_table`；
  SQL 逐表 `(table_name text, orphan_rows bigint)`，10 行全返回 ⇒ 恒 10 键。
- 口径 = `code NOT IN (SELECT code FROM symbols)`（反连接）在 7 accurate + 3 raw 派生 cagg 上的并集计数。

**P1-1 / P2-1 clean() 删完即重算 —— 每个端点逐字符核过的窗口**
> TimescaleDB `refresh_continuous_aggregate` **只重算完全落入窗口的桶**（§6.2 第三次出错教训）；
> CST 日/周/月边界在 UTC 恒为 **16:00**。

| 清理点 | 表 | 窗口（逐字符） | 推导 |
|---|---|---|---|
| `api_rest.rs::clean_kline`（CODE=996601，base=2026-09-03 01:30Z） | `kline_5m` | `['2026-09-03 01:30:00+00','2026-09-03 01:35:00+00')` | 5 根 1m = UTC 5m 桶 [01:30,01:35) 整桶 |
| 同 | `kline_1d` | `['2026-09-02 16:00:00+00','2026-09-03 16:00:00+00')` | CST 2026-09-03 日桶；日界 UTC = 前一 16:00 |
| `api_rest.rs::clean_sym`（SCODE=996602） | `kline_1d` | 同上 | 同上 |
| `api_rest.rs:151`（P2-1，原 `NULL,NULL`） | `kline_5m` | `['2026-09-03 01:30:00+00','2026-09-03 01:35:00+00')` | 同上 |
| `api_kline_period.rs::clean`（CODE=997732；夹具 08-31(一) ×2 + 09-07(一) ×1） | `kline_accurate_1w` / `1mo` | `['2026-07-31 16:00:00+00','2026-10-31 16:00:00+00')` | 两端**均为 CST 月桶起点**（07-31 16:00Z = 08 月桶起、10-31 16:00Z = 11 月桶起）；含 8/9/10 月桶与其中全部周桶（08-30 16:00Z→09-06 16:00Z、09-06→09-13） |
| `kline_reader.rs::clean`（通用，夹具 2023-01 → now()） | intraday+D1：`kline_accurate_5m/15m/1h/1d`、`kline_5m/15m/1d` | `[cst_day_start(lo), cst_day_start(hi)+1d)` | CST 日 = 整 24h，是 5m/15m/1h 桶的**整数倍且端点对齐** |
| 同 | `kline_accurate_1w` / `1mo` | `[cst_month_start(lo,0), cst_month_start(hi,2))` | 整周/整月桶须完全落窗 ⇒ 上界取「hi 所在 CST 月 + 2 个月首」 |

`lo/hi` 由 **该 code 自身夹具跨度**（`min/max(ts)` over `kline_accurate ∪ kline_raw`，**删前**取）推出。

### 3.1 两次返工（实测踩坑，写下来给后续）

1. **全局宽窗破坏并行测试**：初版 `clean()` 用「2022-12-31 16:00Z → now 后第二个月首」的固定宽窗，
   并行测试的 `clean()` 会顺手物化 `CODE_D1_NEW` 刻意保持未物化的 2026-08-20 日桶 ⇒
   `symbols_latest_prev_close_is_prev_trading_day_d1` 的 `prev_close is_none()` 断言变红（**既有断言不许弱化，故返工**）。
   ⇒ 改为**按夹具跨度**推导窗口。
2. **漏表即留孤儿**：只清 1d/1w/1mo 时，全量跑一次后活库仍有 **48 行**孤儿
   （resident 在 `a5m/a15m/a1h/k5m/k15m`，码 997701/997711/997721/997741/997751/997763/997771）。
   ⇒ 把测试实际 refresh 过的**全部 cagg** 纳入 clean（漏一张就留孤儿）。
3. **55P03 并发 refresh**：`api_rest.rs` 两测试并行、窗口重叠 ⇒
   `could not refresh continuous aggregate "kline_1d" due to a concurrent refresh`。
   ⇒ 照 `kline_reader.rs` 既有先例加 `cagg_refresh_lock()`（同 binary 串行化）。

## 4. R2 断言的改写（授权边界内，附独立推导）

原断言意图＝「口径**单一事实源**、不得端点/测试各抄一份」。归属按裁决改到**基础设施**后，
新断言集合 **(a)–(f)** 与旧集合的等价性推导：

| 新 | 断言 | 为何不弱于旧意图 |
|---|---|---|
| (a) | 谓词 `not in (select code from symbols)` 在 `crates/*/src` 下**恰一处** | 旧的「定义恰 1 处」骨架不变（原来靠 10×`from`+反连接识别，现靠**字面谓词**识别 —— 更精确，不再依赖 `symbols s` 这类脆弱 token） |
| (b) | 该处 10 张表**逐张**在谓词邻域内作为 `from` 目标出现 | 等价旧 `hits == 10`；实现用「逐处扫描」而非首次命中，修掉了 `from kline_1d` 被同名兜底 SQL 抢首命中导致的假红/假绿 |
| (c) | `web/src/rest.rs` 必含 `st.quality.orphan_rows()`；`diagnose/src/quality.rs` 必含 `self.quality.orphan_rows()` | 等价旧 `rest.contains(sym)` 的**链路**语义（旧版查符号名，可被注释里的符号名假绿；新版钉调用点）。语义等价性另有**运行期对拍**兜底（见下） |
| (d) | `cargo tree -e normal -p storage` 不含 `diagnose` | 旧集合**没有**；新增（防 A 被误引入）⇒ **严格更强** |
| (e) | `cargo tree -e normal -p domain` 不含 `sqlx` | 新增 ⇒ **严格更强** |
| (f) | `diagnose/src` 与 `web/src` **不得**出现谓词或 `from <cagg>` SQL 形态 | 新增（防 B 的 SQL 透传形态）⇒ **严格更强** |
| 运行期 | `orphan_detect_sql_constant_red.rs` 用 `storage::reader::ORPHAN_ROWS_SQL` 查库，与端点 `by_table`/`rows` **逐表对拍** | 旧版同款对拍（仅 import 路径随归属改变）——这是「同一份 SQL」的**可验证含义** |

**注意 (f) 的口径取「SQL 形态」（`from <表>`）而非裸表名**：`crates/web/src/dto.rs:28` 的散文注释里
出现 `kline_15m` 字样（非 SQL），裸表名口径会误报。谓词口径（`not in (select code from symbols)`）
仍按字面 grep。⚠️ **这一取舍请独立验收方按 (f) 原文复核是否接受**。

未改动：R1 / R3 / R4(a) / R4(b) / R5 一字未动；**用例未增未删**（4 + 2 = 6 个 test attr，函数名不变）。

## 5. Test coverage

- 未新增测试（本轮是「把红转绿」轮）。
- 改动既有测试的**仅**：`api_rest.rs` / `kline_reader.rs` / `api_kline_period.rs` 的 **clean/refresh 路径**
  与一处 `NULL,NULL`；三文件断言行与 HEAD **逐字相同**、计数相同（23/101/11）。
- 红测试 6 例全部转绿（V1）。

## 6. Verification（原始输出见 `EVIDENCE.md`）

| 判据 | 结果 |
|---|---|
| V1 | 红 `0 passed; 4 failed` + `E0432` ⇒ 绿 `4 passed` + `2 passed` |
| V2 | `./scripts/check-tangle.sh` → `✅ …一致`，**EXIT=0** |
| V3 | `cargo test --workspace --tests` **EXIT=0**（90 个 `test result: ok`，0 FAILED）；`npx vitest run` 88 文件 / **839 passed**；`npm run build` ✓ built。既有断言逐字未变 |
| V4 | 7 产物由写入式 `entangled tangle` 产出；复跑 `Nothing to be done.`；门禁沙箱全量重生成逐字节一致；grep 命中见上；mtime 口径注记见 EVIDENCE §V4 |
| V5 | 手工命令全程只读 `SELECT`；孤儿只读读数 **开工前 0 → 全量测试跑完后仍 0**（10 行全 0）。**不完全成立处照实报告**：V3 要跑的全量测试按既有设计连共享 dev 库（§6.1 第 8 条隔离债，P0 本轮不动） |
| V6 | HEAD 未变；`git diff --cached` 空；无 stash；tangle 幂等；无隔离库残留；修改文件 = 预期清单 + 预先存在的 ADR 文件 |

## 7. 残留风险 / 交接注记

1. **超时**：超出 30 分钟时间盒（含一次父级裁决往返 + §3.1 的两次返工）。已完成全部 V1–V6；未做的是
   「更激进的自清洁验证」（如把 clean 的窗口推导做成共享 helper 供 `api_rest.rs` 复用）。
2. **跨进程 55P03**：`cagg_refresh_lock()` 只在**单 binary 内**串行化。`crates/storage/tests/kline_reader.rs`
   与 `crates/web/tests/api_rest.rs` / `api_kline_period.rs` 属**不同进程**，若窗口重叠且同时 refresh，
   TimescaleDB 仍可能报 55P03。此风险**改造前已存在**（D1 窗口 [09-02,09-04) 原本就跨进程重叠），
   本轮全量回归 1 次 EXIT=0，**未做多次重复跑以证明不 flaky**（时间盒）。
3. **`kline_reader.rs::clean` 成本**：每次调用 9 张 cagg × 夹具日/月窗（实测该目标 15 例 27.9 s，
   与改造前同量级；全量 90 个目标 EXIT=0 内跑完）。
4. **依赖既有测试的自清洁**：活库孤儿归零**依赖跑测试**（P1-1 的 clean 是清理机制）。若将来新增测试
   refresh 了 `clean` 未覆盖的 cagg 或窗口，孤儿会重新出现 ⇒ R1（断言 0）会变红，可当**哨兵**。
5. **R2(f) 口径取舍**（§4 末尾）需独立验收方按原文复核。
6. **未做**（派单未要求且时间盒内不扩面）：把 `orphan` 检测接入前端质量页、把 `kline_accurate_30m`
   纳入 `ORPHAN_TABLES` 之外的表、`Cargo.toml`/`Cargo.lock` 一字未动（(d)(e) 实测 0）。
