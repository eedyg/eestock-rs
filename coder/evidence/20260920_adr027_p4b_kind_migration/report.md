# P4b 报告 —— `kind='position'` 迁移修复（回归止血）+ 0028/0029 真库应用 + 两处「未挣得/假覆盖」整改

**报告自身位置**：`coder/evidence/20260920_adr027_p4b_kind_migration/report.md`

**判词（前置）**：
**迁移 0029 生成情况：生成成功（`entangled tangle` 首次即成功，未用 `reset`、未用 `--force`、未手改产物） ｜ check-tangle：绿（EXIT=0，沙箱重新生成 + 逐字节比对） ｜ 真库应用：成功（0028 + 0029 已应用；`\d strategy_run_bars` 含 `position` —— 证据 `30_migrate_apply_real_db.txt`；`\d sim_trades` 含 `commission`/`stamp_duty` —— 同文件） ｜ AUDIT_KEYS 修复：完成（15→18 精确键集 + 顺序断言；真库门禁测试**已挣得绿** 4 passed） ｜ R6 假覆盖：修复完成（自比较 → 真实两源逐笔全字段比对；突变验证证明有牙） ｜ 测试：绿（`cargo build --workspace` EXIT=0；`cargo test -p application` EXIT=0 全目标 0 failed；`cargo test -p strategy-core` EXIT=0；真库门禁 `web --test adr026_run_audit` 4 passed）**

**纪律遵守**：本波**未**执行任何 `TRUNCATE` / `DELETE` / `DROP TABLE`（唯一写操作 = `ALTER TABLE … DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT` + 真库与测试库的只读 `\d`；另有测试库内**事务回滚**的 INSERT 冒烟与测试自身既有 cleanup）。

---

## 0. 产物与证据索引（全部原始输出落盘）

| 文件 | 内容 |
|---|---|
| `00_check_tangle_baseline.txt` | 门禁**修前**基线（绿；确认既有漂移为零 ⇒ 后续红必属本波） |
| `10_tangle_try1.txt` | `entangled tangle` 原始输出（`create migrations/0029_strategy_run_bars_kind_position.sql`，EXIT=0） |
| `20_check_tangle_green.txt` | 迁移生成后门禁绿 |
| `21_check_tangle_final.txt` | **最终态**门禁绿（文档 + 迁移 + 两处测试修复全部落盘后重跑） |
| `30_migrate_apply_real_db.txt` | **真库应用证据**：0028 → 0029 → `\d strategy_run_bars` → `\d sim_trades` → 0029 幂等复跑 → `pg_constraint` 权威读回 |
| `31_constraint_acceptance_probe.txt` | 约束接受性冒烟（事务内 INSERT `'position'` 成功 + 非法 kind 哨兵被拒 + `ROLLBACK` 零残留） |
| `40_testdb_init.txt` | `scripts/testdb-init.sh` 原始输出（新建 `eestock_test` 并**全量应用含 0029 的迁移**，EXIT=0） |
| `41_testdb_fresh_path.txt` | 空库路径核验：`eestock_test` 的 CHECK 亦为**五值**、账本含 0029 |
| `50_web_adr026_run_audit_testdb.txt` | 真库门禁 `cargo test -p web --test adr026_run_audit` **4 passed**（AUDIT_KEYS v2 绿**已挣得**） |
| `51_mutation_web_audit_keys.txt` | 突变验证 1：退化为 v1 的 15 键集 ⇒ 2 用例**响红**（含首行/末行 sha256 一致，证明已还原） |
| `52_mutation_r6_two_sources.txt` | 突变验证 2：丢弃非末块 drain 结果 ⇒ R6 **响红**（附还原后复跑绿 + sha256 校验） |
| `60_workspace_build.txt` | `cargo build --workspace` → `Finished`，EXIT=0 |
| `61_application_tests.txt` | `cargo test -p application` 全目标 EXIT=0（47/2/2/2/6/3/3/57/41/3/53 passed，0 failed） |
| `62_strategy_core_adr027_repro.txt` | `cargo test -p strategy-core --test adr027_repro` → 4 passed / 0 failed |
| `63_strategy_core_all.txt` | `cargo test -p strategy-core` 全目标 EXIT=0（9 个 test binary 全 ok） |
| `70_end_to_end_position_chunk.txt` | **端到端回归修通证据**：真实 run（`sr_1789832284173_000004`）`succeeded` 且 `kind='position'` 分块已落库（6 点） |

---

## 1. 第一件事：文档先行（`design/04-storage/schema.md`）

### 1.1 改了什么

1. **新增 §4.3.20 `strategy_run_bars.kind` 扩 `position`（ADR-027 D9 / §4.1，0029）**：含事实源措辞
   （kind 全集 = 五值）、回归成因、实现语义（替换约束而非新建表）、幂等口径、顺序硬约束、
   应用方式（`psql -v ON_ERROR_STOP=1 -f migrations/0029_strategy_run_bars_kind_position.sql`）、
   回滚备查（本波**不执行**），**内嵌 0029 的 tangle 块**。
2. §4.3.18（0027 节）尾部追加 3 行**醒目修订提示**（prose，不入代码块）：0027 块的四值 CHECK
   **不是**当前全集；kind 全集由 §4.3.20 的 0029 扩为五值。

文档内的当前约束定义（事实源，唯一权威）：

```text
CHECK (kind IN ('per_bar','net_value','drawdown','fills','position'))
```

### 1.2 层内决策（未改层边界，仅文档/迁移层，**非**架构改动）

| 决策 | 内容 | 理由 |
|---|---|---|
| D1 | **0027 块保持原样**（不把 `'position'` 追加到 0027 的 `CREATE TABLE` 内联 CHECK），新增 0027 节提示句 | 0027 **已应用**于真库：其块内容 = 已应用产物记录，是审计基线；原地改写会让「文件 vs 真库」漂移，且对已存在库无效（`CREATE TABLE IF NOT EXISTS` 不重建约束）。成员扩展一律走**追加迁移**（0029）⇒ 文档内 kind 全集定义仍**唯一且含 `position`**（§4.3.20） |
| D2 | 0029 用 `DROP CONSTRAINT IF EXISTS` + **同名** `ADD CONSTRAINT` | 与既有迁移风格（`IF NOT EXISTS` 系）一致；幂等（已实测复跑 EXIT=0）；约束名由 0027 内联 CHECK 自动生成（`strategy_run_bars_kind_check`），故可精确 drop/add，列/索引/数据零改动 |
| D3 | 未改 `design/17-trade-detail-layering/02-spec.md` §8（其「无需其它 DDL」与事实不符） | 该文件是**另一车道**的工作区在改（`git status` 显示未暂存修改）；本波范围只到 `schema.md`，故只登记为残差（§8.2）交父级裁决 |

---

## 2. 迁移生成（tangle）

```
$ entangled tangle
[23:36:11] INFO     Welcome to Entangled v2.4.3!
           INFO     create `migrations/0029_strategy_run_bars_kind_position.sql`
EXIT=0
```

- **未用** `entangled reset`（首次 tangle 即成功，无「changed outside the control of Entangled」）；
  **未用** `entangled tangle --force`；**未手改** `migrations/**` 任何字节。
- 产物头尾标记为标准 entangled 形态（`-- ~/~ begin <<design/04-storage/schema.md#migrations/0029_…>>[init]` / `-- ~/~ end`）。

生成内容（与文档块逐字节一致）：

```sql
ALTER TABLE strategy_run_bars
    DROP CONSTRAINT IF EXISTS strategy_run_bars_kind_check;

ALTER TABLE strategy_run_bars
    ADD CONSTRAINT strategy_run_bars_kind_check
    CHECK (kind IN ('per_bar','net_value','drawdown','fills','position'));
```

## 3. 门禁（check-tangle）

| 时点 | 结果 | 证据 |
|---|---|---|
| 改动前基线 | ✅ EXIT=0 | `00_check_tangle_baseline.txt` |
| 迁移生成后 | ✅ EXIT=0 | `20_check_tangle_green.txt` |
| **最终态**（文档+迁移+测试修复全部完成后） | ✅ EXIT=0 | `21_check_tangle_final.txt` |

判据原文：`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。`

---

## 4. 真库应用（0028 + 0029）

连接按 `docker-compose.yml` + `scripts/testdb-init.sh` 惯例：`psql -h 127.0.0.1 -p 5433 -U eestock -d eestock`
（容器 `eestock-timescaledb`，宿主 5433）。原始输出全量见 `30_migrate_apply_real_db.txt`。

```
$ psql … -v ON_ERROR_STOP=1 -f migrations/0028_sim_trades_fee_split.sql
ALTER TABLE / COMMENT ×3                                     EXIT=0
$ psql … -v ON_ERROR_STOP=1 -f migrations/0029_strategy_run_bars_kind_position.sql
ALTER TABLE / ALTER TABLE                                    EXIT=0
$ psql … -c '\d strategy_run_bars'
Check constraints:
    "strategy_run_bars_kind_check" CHECK (kind = ANY (ARRAY['per_bar'::text, 'net_value'::text,
      'drawdown'::text, 'fills'::text, 'position'::text]))          ← 判据①：含 position ✓
$ psql … -c '\d sim_trades'
 commission | double precision | not null | 0
 stamp_duty | double precision | not null | 0                        ← 0028 生效 ✓
$ psql … -v ON_ERROR_STOP=1 -f migrations/0029_…sql      （幂等复跑）
ALTER TABLE / ALTER TABLE                                    EXIT=0  ← 幂等 ✓
$ psql … -c "select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='strategy_run_bars'::regclass"
strategy_run_bars_kind_check|CHECK ((kind = ANY (ARRAY['per_bar'::text, 'net_value'::text,
  'drawdown'::text, 'fills'::text, 'position'::text])))        ← 目录表权威读回 ✓
```

**约束接受性冒烟**（`31_constraint_acceptance_probe.txt`，事务内 INSERT + `ROLLBACK` ⇒ **零残留**）：

```
INSERT … kind='position'            → INSERT 0 1      ← 正例：position 被接受（回归修通，DB 层）
INSERT … kind='bogus_kind_sentinel' → ERROR: violates check constraint "strategy_run_bars_kind_check"
                                                        ← 哨兵：非法 kind 仍被拒（约束未被削弱为无约束）
ROLLBACK; select count(*) … kind='position' → 0         ← 无任何行落盘
```

**空库路径校验**（`40`/`41`）：`scripts/testdb-init.sh` 新建 `eestock_test` 并**按文件名顺序全量应用**
迁移（含 0029，账本 `_eestock_test_migrations` 最新三条 = 0029/0028/0027）⇒ 该库 CHECK 亦为**五值**
（`0027 四值 → 0029 五值` 的时序在空库上同样收敛，验证 D1/D2 的组合无误）。

⚠️ 旧 run 历史数据**未做任何清理**（禁 `DELETE/TRUNCATE`，属收尾波次）。

---

## 5. 顺带修复 A：`crates/web/tests/adr026_run_audit.rs`（「未挣得的绿」）

### 5.1 问题（tester §3.3-B）
`AUDIT_KEYS: [&str; 15]` + `assert_eq!(obj.len(), AUDIT_KEYS.len())` 未随 ADR-027 §5.5 的 `/audit` 增量
（`round_trips_closed` / `round_trips_open` / `rt_reconcile`）更新 ⇒ 提供测试库后**必红**；P3 报告的
「逐条绿」因该文件受 `EESTOCK_TEST_DATABASE_URL` 门禁而**从未被挣得**。

### 5.2 修法
1. `AUDIT_KEYS` → `[&str; 18]`，顺序 = **事实源声明序**（`crates/application/src/audit.rs::AuditReport`
   字段序；`RunAudit` 的 `run_id` 在 flatten 之前 ⇒ 首键）：
   `…, round_trips_total, round_trips_force_closed, **round_trips_closed, round_trips_open, rt_reconcile**, warnings`。
2. `assert_eq!(obj.len(), AUDIT_KEYS.len())` **保留**（精确集合：不多不少）——**未**放宽为「包含」式；
   `contains_key` 循环保留（缺字段的定向报错）。
3. 新增**顺序断言** `assert_audit_key_order(raw: &str)`：在**原始响应文本**上按契约序逐键下标递增查找
   （`serde_json::Value` 底层是 `BTreeMap`，键序不可断言 ⇒ 必须用 raw body；首键固定 `run_id`），
   并在 200 用例中接入（先取 `r.text()` → 顺序断言 → 再 `serde_json::from_str` 做集合/语义断言）。
4. 顺带补齐 §5.5 增量的**形状**断言（`round_trips_closed/open` 为 u64；`rt_reconcile` 为对象且
   `checked` u64 / `mismatched` 数组 / `tolerance` 数值）——只冻结存在性与类型，**不**冻结值。

### 5.3 绿是**挣得的**（不是声明的）
```
$ EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/eestock_test' \
  cargo test -p web --test adr026_run_audit
running 4 tests
test adr026_replay_target_run_matches_frozen_baseline ... ok
test audit_recorded_false_when_facts_are_missing ... ok
test audit_endpoint_emits_required_tracing_fields ... ok
test audit_endpoint_matches_recorded_facts_and_404_semantics ... ok
test result: ok. 4 passed; 0 failed; finished in 0.71s            EXIT=0
```
（`50_web_adr026_run_audit_testdb.txt`；测试库由 `scripts/testdb-init.sh` 幂等供应，对活库**只读**。）

### 5.4 突变验证（证明断言是活的）
把 `AUDIT_KEYS` 退回 v1 的 15 键集（并同步类型 18→15）后重跑 ⇒ **2 用例响红**：

```
assertion `left == right` failed: audit 不得多出/少出字段：{"…","round_trips_closed":1,"round_trips_open":0,
  "rt_reconcile":{"checked":1,"mismatched":[],"tolerance":1e-6}, …}
test result: FAILED. 2 passed; 2 failed                              ← 复现 tester「必红」判定
```
突变后**已还原**：`sha256sum -c` 校验通过（首行/末行 sha256 一致，`51_mutation_web_audit_keys.txt`）。
> 附注（诚实记录）：突变第 1 次尝试的 `sed` 把类型写坏成 `[[&str; 18]str; 15]` ⇒ 编译错（非测试失败），
> 已作废并在同一证据文件头注明，随后按正确写法重做。

---

## 6. 顺带修复 B：`crates/strategy-core/tests/adr027_repro.rs` R6（假覆盖）

### 6.1 问题（tester §3.3-A）
原文「两源一致性」为 `let events_side: Vec<FillFactNow> = f.clone(); assert_eq!(events_side, f)` ——
**自比较**（值与自身 clone 相等，恒真、零信息），把「两源逐笔同 tuple」这一判据伪装成已覆盖。

### 6.2 修法（**不删**，改为真实两源比对）
新增两条**独立产径**，在同一场景（`partial_sell_case()`：capital=100k、LumpSum 0.5、价序
10,10,10,10,12,12,11,11）上逐笔比对**全字段**（10 字段）：

- **源 A `fill_source_per_bar`**：批式入口 `run_ensemble` 的 `res.per_bar[].events`（= `/bars?kind=per_bar`
  payload 同源）。
- **源 B `fill_source_chunked`**：**`/fills` 块的实际产径** —— 按 `crates/application/src/workbench.rs`
  同序列驱动 `EnsembleSession`：`set_total_hint` → 按 chunk（**chunk=2**，强制多块）`push_batch` →
  **非末块 `drain_records()` 逐块收集** → `finish()` 纳末块；扫描口径与 `workbench.rs::collect_fills`
  逐字同形（`collect_fill_facts`）。
- 断言：先逐字段（`ts/bar_index/side/rt_seq/reason` 精确相等；`qty/price/trade_value/commission/stamp_duty`
  以 `assert_close(…, 0.0)` 逐位相等，带字段名与两源现场），再整表 `assert_eq!(facts_side, events_side)`
  （**顺序敏感 + 长度敏感**，防「只比前半」类退化）。R6 原红判据（`EngineEvent::Fill` Debug 含
  `rt_seq/trade_value/commission/stamp_duty` 四字段）**原样保留**。

所有既有断言未被删改（diff 核对：R1/R2/R5 未动；`partial_sell_run()` 拆出 `partial_sell_case()` 仅为
让 R6 能用同一场景驱动两径，R1/R2/R5 调用点不变）。

### 6.3 绿 + 突变验证（有牙）
```
$ cargo test -p strategy-core --test adr027_repro
running 4 tests … test result: ok. 4 passed; 0 failed                      EXIT=0
```
突变：`fill_source_chunked` 内**丢弃非末块 drain 结果**（模拟分块边界丢成交）⇒ 立即响红：

```
assertion `left == right` failed: 两源笔数须相等（不等 ⇒ 分块 drain 丢/重成交）：
  事件源 [bar1 Buy 5000 @10.002 …, bar5 Sell 417.6 @11.9976 …, bar7 Sell 4582.4 @10.9978 …] / 事实源 [bar7 Sell …]
  left: 1  right: 3
test result: FAILED. 0 passed; 1 failed
```
突变后**已还原**并复跑绿；`sha256sum -c` 校验通过（`52_mutation_r6_two_sources.txt`）。
⇒ 该断言现在真的在「看两条产径」，不再是恒真式。

---

## 7. 端到端：回归是否修通（position 分块真落库）

`70_end_to_end_position_chunk.txt`（测试库 `eestock_test`，**非**活库）：

```
strategy_run_bars:  drawdown 1 ｜ fills 1 ｜ net_value 1 ｜ per_bar 1 ｜ **position 1**
strategy_run:       sr_1789832284173_000004  succeeded  chunked_v1
strategy_run_bars:  sr_1789832284173_000004  position  seq=0  points=6
```

该 run 由真库门禁测试 `web --test adr026_run_audit`（真实回测 run 提交 + 结果分块落库 + `/audit` 读取）
产生 —— **这正是 tester E 段阻塞的失败点**（`position` 块 INSERT 被 CHECK 拒绝 ⇒ `status=failed`），
现为 `succeeded` 且五类分块齐全。

## 8. 未做项与残差（诚实留白）

1. **未在活库（`eestock`）跑新回测 run 做 8081 冒烟**：本波禁止 `DELETE`（无法回收冒烟 run），
   且 E 段属 tester 车道。已提供的等价证据为「真库测试库上的真实 succeeded run + position 分块落库」
   与「活库 CHECK 五值」。**tester 可直接按 `20260920_adr027_accept/report.md` §7.4 第 3 步复跑 E 段**。
2. **`design/17-trade-detail-layering/02-spec.md` §8「无需其它 DDL」与事实不符**（tester §7.4 第 1 步点名）：
   本波只改 `design/04-storage/schema.md`（派单边界）；该文件当前有**另一车道的未暂存修改**，
   为避免跨车道写冲突**未触碰** —— 建议父级裁决由哪条车道补一行「0029 = kind 扩 position」的修订。
3. **`design/04-storage/schema.md` 的 0027 块未追加 `position`**（决策 D1，见 §1.2）：若闸门要求
   「0027 块的 CHECK 定义也含 position」，请明示 —— 那会把已应用迁移 0027 的生成物一并改写
   （`entangled tangle` 可生成，但违背「已应用迁移 = 只读历史」），本波按克制原则未做。
4. **`/fills` 元素缺 `code`**、`/curve` 响应新增 `recorded`、`/fills?round_trip=` 空页语义：
   均属 P3/P4 已申报的契约歧义，本波未触碰（不在派单范围）。
5. **`mcp::real_db_*` 等真库门禁测试未运行**（本波判据豁免）；`web` 侧真库门禁目标已跑通一个
   （`adr026_run_audit`，4 passed）。
6. **测试库 `eestock_test` 为新建库**（`scripts/testdb-init.sh`，1.63M 行 kline 播种 + cagg 全量刷新），
   后续车道可直接 `export EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/eestock_test'`。

---

## 9. 变更清单（本波）

| 文件 | 变化 | 性质 |
|---|---|---|
| `design/04-storage/schema.md` | +55/-0（§4.3.20 新节 + §4.3.18 三行修订提示） | 事实源（文档先行） |
| `migrations/0029_strategy_run_bars_kind_position.sql` | 新增（21 行；tangle 生成，禁手改） | 生成物 |
| `crates/web/tests/adr026_run_audit.rs` | +41/-4（AUDIT_KEYS 15→18 + 顺序断言 + §5.5 形状断言） | 测试（手写） |
| `crates/strategy-core/tests/adr027_repro.rs` | +152/-10（两源产径 + 全字段逐笔比对；R6 自比较移除） | 测试（手写） |
| `coder/evidence/20260920_adr027_p4b_kind_migration/**` | 本报告 + 15 份原始输出/证据 | 证据 |

**未触碰**：`crates/*/src/**`（零生产代码改动）、`web/**` 前端、Cargo 依赖、`migrations/0001..0028`、
`design/17-trade-detail-layering/02-spec.md`、`design/01-architecture/adr/ADR-023-*.md`（属其它车道的
既有工作区改动，**故意不 `git add`**）。

> **diffstat 口径说明（避免误读）**：上表「变化」列是**本波相对「本波开始时的索引」**的增量
> （`git diff -- <file>`）。与 HEAD 相比的 `git diff --cached --stat` 会更大（例：
> `crates/strategy-core/tests/adr027_repro.rs` 在索引中是**整文件新增**（`A`，该文件由 P1b 车道新建、
> 本波追加）；`design/04-storage/schema.md` 索引版含 P0–P4 车道已暂存的 36 行）。
>
> **禁行令核验**：本波全部证据文件中 `TRUNCATE` / `DELETE FROM` / `DROP TABLE` 的出现仅两处，
> 均为**纪律声明散文**（`30_…:3`、`31_…:1`），**无任何命令回显**；`31_…` 的 INSERT 冒烟在事务内
> `ROLLBACK`，落盘残留 = 0。

## 10. 验证矩阵（判据逐条）

| 判据 | 结果 | 证据 |
|---|---|---|
| `\d strategy_run_bars` 原始输出含 `position` | ✅ | `30_migrate_apply_real_db.txt` |
| `\d sim_trades` 含 `commission`/`stamp_duty`（0028 生效） | ✅ | 同上 |
| `./scripts/check-tangle.sh` 绿 | ✅ EXIT=0 | `21_check_tangle_final.txt` |
| `cargo build --workspace` 绿 | ✅ EXIT=0 `Finished` | `60_workspace_build.txt` |
| `cargo test -p application` 绿 | ✅ EXIT=0（219 passed / 0 failed，11 个目标） | `61_application_tests.txt` |
| R6 用例修复后仍通过且为真实比较 | ✅ 4 passed + 突变响红 | `62_…`、`52_mutation_…` |
| AUDIT_KEYS 精确集合（18，含顺序声明） | ✅ 4 passed（真库门禁）+ 突变响红 | `50_…`、`51_mutation_…` |
| `cargo test -p strategy-core` 全目标 | ✅ EXIT=0 | `63_strategy_core_all.txt` |
| 禁 `TRUNCATE`/`DELETE`/`DROP TABLE` | ✅ 未执行任何一条 | 全文命令见证据文件 |
