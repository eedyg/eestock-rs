# 019 — 窄范围独立复核：性能门禁 R-B / R-A 修复（提交 d6bbd47）

- **报告自身路径**：`tester/report/019_gate_rA_rB_recheck.md`
- **原始证据目录**：`tester/evidence/019/`（00–08 + `fixtures/`，见 §9）
- **复核对象**：`eestock-rs` 提交 `d6bbd471b9b892e2a30eeb9599027a5ebdccefd0`（HEAD；父 `6220b6a`）
  - 被测产物：`crates/storage/tests/kline_reader.rs`（`merged_1m_branch_index_limit_performance`）
  - tangle 事实源：`design/07-app-plane/00-web-api.md`
  - 报告：`coder/report/151_debt_cleanup_batch1.md` §收尾-2
- **本次性质**：对 018 报告 R-B / R-A 两项残留风险的**修复增量**做**窄范围独立复核**（仅验证，不改实现）
- **日期**：2026-09-13
- **环境**：16 核；TimescaleDB `127.0.0.1:5433/eestock`（只读查询为主；1 个临时 code 种入后已删）；测试二进制
  `target/debug/deps/kline_reader-552e3228620d3eed`（mtime 00:44:21，源文件 00:44:10 ⇒ 由 HEAD 源码构建）
- **纪律**：**未** `git add`/stage；**未**改任何 `crates/**/src`、`web/**`；**未**重启服务；未提交 git；
  两个临时复核夹具运行后**已删除**（`crates/storage/tests/` 无 `zz_*`/`*_tmp.rs` 残留）。

---

## 0. 结论（先给）

> **可接受（acceptable）**。R-B 已由「静默 return ⇒ vacuous PASS」改为「直接 panic（消息含期望/实得根数与指引）」，
> 行为级四例复现成立；R-A 阈值 0.6 → 0.25 在 **独立 12 次连跑**（比值 0.055–0.060，最坏余量 4.17×）与
> **诱导负载 load1 ≤18.7** 下**均未出现新余量不足（无 <3×，更无假红）**；突变实验独立复做比值 **1.003 ≥ 0.25 ⇒ 必红**，
> 对照真实路径 0.055 ⇒ 绿（判据非空、非恒红）。**无需再调阈值**。
>
> 唯一需登记的偏差：worker 声明「注释含『比值 max ≥0.15 则复审』」**不成立**——该复审条件只写在报告 151 §收尾-2.3，
> **未写入**测试源码注释（见 §6-D1；低等级，仅文档/声明不一致，不影响行为）。

---

## 1. worker 声明逐项独立复核

| # | worker 声明 | 独立复核 | 判定 |
|---|---|---|---|
| 1a | R-B：目标侧前置不足改为**直接 panic**（消息含期望/实得根数与指引） | 源码 diff（`git show d6bbd47`）与行为级均确认：`return` → `panic!("数据前提不满足（期望 500 根 M1，实得 {} 根）… 请修复数据或显式另择 code。")`；0 根与 3 根两例均触发且消息可读（§2） | ✅ 成立 |
| 1b | 旧写法在 0 根下「test did not panic as expected」FAILED（vacuous pass 实证） | 独立新夹具把**旧写法逐字复制**为一条普通用例：0 根下静默 return ⇒ **该用例 PASS**（无测量）⇒ vacuous pass 成立（§2.3）。worker 以「should_panic 下 FAILED」表述、我以「静默 PASS 实证」表述，**同一事实、two-sided 等价** | ✅ 成立 |
| 1c | 终稿捕获 panic | 终稿前置检查片段复制到夹具，0 根/3 根均捕获到 panic，`#[should_panic]` 用例 ok（§2） | ✅ 成立 |
| 1d | 注释明令不得恢复静默通过 | 源码注释含「**不得恢复"静默 return 通过"的写法**…（含改名/`#[ignore]`/"打印后 return"三种变体）」 | ✅ 成立 |
| 2a | R-A：阈值 `0.6 → 0.25` | 源码 `assert!(ratio < 0.25, …)`（行 283）；无绝对墙钟断言（§4） | ✅ 成立 |
| 2b | 20/20 PASS，比值 min 0.054 / max 0.060 / mean 0.056 | **独立 12/12 PASS**：min 0.055 / max 0.060 / mean 0.0563 / median 0.0560（§3.1）——与声称分布一致 | ✅ 成立（独立样本） |
| 2c | 突变实验：修复前路径冒充目标 ⇒ 比值 1.014 ≥ 0.25 必红 | **独立复做**：比值 **1.003** ≥ 0.25 ⇒ panic 红（捕获）；对照真实路径 **0.055** 绿（§3.2） | ✅ 成立（同量级） |
| 2d | **不**叠加绝对墙钟上限 | 全文无 `as_millis()` 断言、无 `< 500` 耗时断言；唯一性能断言为 `ratio < 0.25`（`as_millis()<500` 仅出现在历史背景注释）（§4） | ✅ 成立 |
| 2e | 注释含「比值 max ≥0.15 则复审」 | **测试源码中不存在** `0.15` / `复审`（`grep -Fn` 全 miss）；该条件仅存在于报告 151 §收尾-2.3/§收尾-2.6（§6-D1） | ❌ **不成立（低）** |

---

## 2. R-B 行为级验证（重点）

**夹具（本次新建，非复用 018）**：`crates/storage/tests/zz_recheck019_rb_tmp.rs`（运行后删除；源码留存
`tester/evidence/019/fixtures/zz_recheck019_rb_tmp.rs.txt`）。做法：**逐字复制**终稿前置检查片段、
仅把 `real_code` 参数化；另复制旧写法作对照。**未触碰 `kline_reader.rs`**。

> 018 复核时 R-B 尚未被行为级测试（当时只登记为残留风险），018 用的是「缺表 → error-red」与「突变」两条
> 其它路径夹具。**故本次为新建夹具，非复用**。

原始输出（`tester/evidence/019/04_rB_behavior_raw.txt`，`--nocapture --test-threads=1`）：

```
running 4 tests
test rb_control_old_silent_return_is_vacuous_pass ... [bench-skip] 999999 无 500 根 M1（实际 0），跳过性能断言
[control] 旧写法在 0 根下已 return，未作任何测量 —— 本用例仍 PASS（vacuous）
ok
test rb_nonzero_insufficient_997799_panics - should panic ...
thread 'rb_nonzero_insufficient_997799_panics' panicked at crates/storage/tests/zz_recheck019_rb_tmp.rs:23:13:
数据前提不满足（期望 500 根 M1，实得 3 根）→ 门禁无法测量：997799 的 M1 数据缺失或不足。本测试不得静默通过（vacuous pass = 假绿），请修复数据或显式另择 code。
ok
test rb_normal_518880_green ... [control] 518880 前置检查通过（8 次均 500 根）→ 未 panic
ok
test rb_zero_bars_999999_panics - should panic ...
thread 'rb_zero_bars_999999_panics' (237293) panicked at crates/storage/tests/zz_recheck019_rb_tmp.rs:23:13:
数据前提不满足（期望 500 根 M1，实得 0 根）→ 门禁无法测量：999999 的 M1 数据缺失或不足。本测试不得静默通过（vacuous pass = 假绿），请修复数据或显式另择 code。
ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.25s
```

**判定**：
- 2.1 **0 根**（`code=999999`，实测 DB 0 行）⇒ **panic 且消息可读**（含「期望 500 根 / 实得 0 根」+ 处置指引）✅
- 2.2 **非零但不足 500 根**（临时种入 `997799` 3 根 M1，运行后已 `DELETE`，DB 复核 =0）⇒ **panic 且报「实得 3 根」** ✅
  （说明：真实库无 1–499 根的 code，`kline_accurate` M1 最小为 68203 行；故「非零不足」用临时 code 构造，属仓内既有
  `9977xx` 测试 code 惯例，仅 3 行且已清理。）
- 2.3 **旧写法 vacuous 实证**：同一 0 根场景下旧写法静默 return ⇒ 用例 **PASS**、零测量 ⇒ 假绿灯口确实存在 ✅
- 2.4 **正常场景仍通过**：`518880` 前置检查 8 次均 500 根、**未 panic**；且真实门禁本体在 §3.1 连跑 12/12 全绿
  ⇒ **该 panic 未把门禁变成恒红** ✅

---

## 3. R-A 独立复做

### 3.1 连跑 12 次（真实门禁本体，终稿二进制）

命令：`target/debug/deps/kline_reader-552e3228620d3eed --exact merged_1m_branch_index_limit_performance --nocapture`
（二分/构建产物由 HEAD 源码构建；见§标题环境）。原始输出 `tester/evidence/019/03_rA_12runs_unloaded.txt`。

| run | load1 | 目标 min5 | 参考 min5 | 比值 | 结果 |
|---|---|---|---|---|---|
| 01 | 0.82 | 61ms | 1105ms | 0.055 | ok |
| 02 | 1.16 | 60ms | 1085ms | 0.056 | ok |
| 03 | 1.13 | 61ms | 1104ms | 0.055 | ok |
| 04 | 1.24 | 62ms | 1088ms | 0.057 | ok |
| 05 | 1.25 | 65ms | 1103ms | 0.059 | ok |
| 06 | 1.44 | 61ms | 1110ms | 0.055 | ok |
| 07 | 1.81 | 61ms | 1106ms | 0.055 | ok |
| 08 | 1.63 | 61ms | 1105ms | 0.055 | ok |
| 09 | 1.60 | 61ms | 1110ms | 0.055 | ok |
| 10 | 1.54 | 63ms | 1110ms | 0.057 | ok |
| 11 | 1.58 | 66ms | 1107ms | 0.060 | ok |
| 12 | 1.72 | 61ms | 1081ms | 0.056 | ok |

统计（`07_rA_stats.txt`）：**12 passed / 0 failed**；比值 **min 0.055 / max 0.060 / mean 0.0563 / median 0.0560**；
最坏余量 = 0.25/0.060 = **4.17×**；**<3× 余量样本 = 0**、**<1.5× = 0** ⇒ **无新余量不足**。

### 3.2 突变实验独立复做（判据非空）

**夹具（本次新建）**：`crates/storage/tests/zz_recheck019_mutation_tmp.rs`（运行后删除；源码留存
`tester/evidence/019/fixtures/zz_recheck019_mutation_tmp.rs.txt`）。目标侧替换为修复前路径（`kline_merged` 全量
Append + top-N），其余骨架/判据（8 预热 + min-of-5、2 预热 + min-of-5、`ratio < 0.25`）与终稿逐字一致。

原始输出（`tester/evidence/019/05_rA_mutation_raw.txt`）：

```
running 2 tests
test ra_control_real_path_is_green ... [ra-control ] 真实生产路径：目标 min5=61ms vs 参考 min5=1099ms（比值 0.055）
ok
test ra_mutation_pre_fix_as_target_must_be_red - should panic ... [ra-mutation] 目标=修复前路径：目标 min5=1098ms vs 参考 min5=1094ms（比值 1.003）

thread 'ra_mutation_pre_fix_as_target_must_be_red' panicked at crates/storage/tests/zz_recheck019_mutation_tmp.rs:76:5:
突变实验：修复前路径冒充目标时判据必须红（实测比值 1.003 ≥ 0.25；目标 min5=1098ms、参考 min5=1094ms）
ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 37.78s
```

**判定**：修复前路径冒充目标 ⇒ 比值 **1.003 ≥ 0.25** ⇒ 断言 panic ⇒ **必红**；对照真实路径 **0.055 < 0.25** ⇒ 绿
⇒ **判据非空且非恒红** ✅（与 worker 1.014、历史 0.983/1.021/1.275 同量级）。

---

## 4. 无绝对墙钟上限（补充核验 2d）

- `grep -n "as_millis\|< 500\|<500\|< 600" kline_reader.rs` 仅命中第 183 行的**历史背景注释**
  （「原判据为绝对墙钟 `dt.as_millis() < 500`…」）；**无**任何耗时绝对值断言。
- 唯一性能断言：行 283 `assert!(ratio < 0.25, …)`。
- 事实源 `design/07-app-plane/00-web-api.md` 同步含同一 panic 片段与 `assert!(ratio < 0.25,`（行 1960–1961 / 2004）；
  `check-tangle.sh` 绿 ⇒ 生成物与事实源逐字节一致。

---

## 5. 反向风险核查：阈值收紧到 0.25 后是否更易假红？（架构师特别关注）

**手段**：诱导外部 CPU 负载（`yes` busy-loop 占核），在负载下运行真实门禁本体。原始输出
`tester/evidence/019/06_rA_induced_load.txt`。

| 轮次 | busy-loop 数 | load1 前→后 | 目标 min5 | 参考 min5 | 比值 | 余量 | 结果 |
|---|---|---|---|---|---|---|---|
| 1 | 16 | 3.70 → 8.82 | 123ms | 2234ms | **0.055** | 4.5× | ok |
| 2 | 32 | 11.23 → 18.73 | 104ms | 1891ms | **0.055** | 4.5× | ok |

**结论**：负载把两侧耗时**同向抬高**（目标 61→104–123ms、参考 ~1100→1891–2234ms），**比值稳定在 0.055**
（与空载无异）⇒ 在 `load1` 高达 **18.73**（16 核、超订约 1.2×）下**未出现假红，也未接近 0.25**。
结合 018 诱导负载最坏 0.075（余量 3.33×）与 workder 记录 0.055→0.075，**0.25 在更慢/受扰环境下仍保留 ≥3.3× 余量**。
诱导负载后已确认无残留 busy 进程（`pgrep -c yes = 0`）。

**残留理论路径（登记，非本次实测触发）**：已知唯一能大幅抬高比值的是**目标侧计划缓存失效**（历史 504ms flaky 根因：
hypertable ~1000 chunk 的 custom plan 规划 ~600ms）。min-of-5 已把单次规划抖动从估计量中剔除；仅当**连续 5 个样本
全部**落入 custom plan（需在取样窗口内反复失效计划缓存）时，目标 min5 才可能逼近 0.25×参考。本次 CPU 负载**不**触发该
路径（比值恒 0.055）。相对 0.6，0.25 把安全余量由 ~10.9× 收窄至 ~4.17×，理论上略增该极端路径的暴露——但**当前数据不支持
再放宽**（放宽即回到 018-R-A「门禁过松」）。**建议：维持 0.25**；若未来 ≥20 次连跑比值 max ≥0.15（余量 <1.7×），按报告 151
§收尾-2.3 候选方案复审（min-of-9 或 比值+宽松绝对下限双判据）。**建议阈值：维持 0.25。**

---

## 6. 无副作用 / 纪律核查

| 项 | 命令 | 结果 |
|---|---|---|
| 改动范围（提交） | `git show --stat d6bbd47`（`01_commit_stat.txt`） | **21 路径**：1 测试文件 `crates/storage/tests/kline_reader.rs`、1 事实源 `design/07-app-plane/00-web-api.md`、1 报告 `coder/report/151_…md`、**18 个此前未跟踪的 `coder/evidence/151_debt_cleanup/*`**。**无任何 `crates/**/src`、`web/**`、`scripts/**` 生产代码**（`02_commit_nameonly.txt`） |
| 编译门禁 | `cargo check -p storage --all-targets` | ✅ 绿（`Finished dev profile`） |
| tangle 门禁 | `./scripts/check-tangle.sh` | ✅ 绿（沙箱重生成 + 逐字节比对通过，工作区未改） |
| staged | `git diff --cached --name-only \| wc -l` | **0** |
| 工作区被跟踪改动 | `git status --porcelain \| grep -c '^ M'` | **0**（`08_git_status_after.txt`） |
| 新增未跟踪夹具 | `ls crates/storage/tests/ \| grep -E 'zz_\|_tmp'` | **NONE**（两个临时夹具已删） |
| core dump | `find … -name 'core*'` | 无 |
| 临时 DB 写入 | `997799` 种入 3 行 → 运行后 `DELETE` | 复核 `count=0`（已还原只读态） |

**未跟踪项**：`tester/evidence/019/`、`tester/report/018_…md`（既有）等——均为证据/报告产物，**非夹具**。
> 注：worker §收尾-2.1 称「改动范围仅 kline_reader.rs + 00-web-api.md、`git diff --stat` = 2 files」对**工作树 diff**（当时
> evidence/report 尚未跟踪）是准确的；但**提交 `d6bbd47` 本体**额外吸收了 18 个此前未跟踪的 `coder/evidence` 文件。
> 均为文档/证据，**无实现代码**，不构成功能副作用（低，登记 D2）。

### 6.1 发现的偏差

| # | 级别 | 内容 | 影响 |
|---|---|---|---|
| **D1** | 低（声明/文档） | worker 声明「注释含『比值 max ≥0.15 则复审』」**不成立**：`grep -Fn "0.15"` 与 `grep -Fn "复审"` 在 `crates/storage/tests/kline_reader.rs` **均 0 命中**；该复审条件仅存在于报告 151 §收尾-2.3/§收尾-2.6。 | 仅「注释已写入」这一句失实；**阈值与行为不受影响**。若确需该自省条款落到源码，可后续在函数头注释补一句（非阻塞）。 |
| **D2** | 低（提交卫生） | `git show --stat d6bbd47` 含 18 个 `coder/evidence/151_debt_cleanup/*`（此前未跟踪），与提交信息「顺带报告勘误」的叙事不完全对应。 | 非实现代码；不影响门禁/行为。 |

**无 blocker、无 MUST-FIX。**

---

## 7. 未覆盖 / 未行为级验证声明（逐项）

1. **未跑完整 `kline_reader` 套件**（含写库用例 `9977xx` 与 cagg refresh）：为遵守 018/本批「少写共享库」纪律，仅跑性能门禁单测 +
   两个只读/临时夹具。⇒「全量并行套件（cagg refresh/DELETE 令计划缓存失效）」这一**极端假红路径未直接复现**（§5 已登记）。
2. **未复现 worker 的 20 次原始批次**：以**独立 12 次**连跑替代（≥10 满足要求）；未逐次比对 15 号证据的 20 行。
3. **R-B「非零不足 500 根」用临时 code 构造**（真实库无 1–499 根 code）：已种入 3 行并清理；**未**覆盖「raw 侧不足 / merge 部分命中」等
   更细的数据形状。
4. **未验证 worker 的 `zz_rbra_tmp.rs` 夹具本身**（未入库、仅有证据 16 文本）：R-B 红/绿结论由**本次独立新夹具**复现，未对 worker 夹具逐行核。
5. **事实源一致性仅经门禁间接确认**：`check-tangle.sh` 绿（沙箱重生成+逐字节比对）；**未**手工逐行 diff `kline_reader.rs` 与 `00-web-api.md`。
6. **未做 DB 层 SQL 语义交叉核验**（如 `EXCEPT` 双向比对）：语义等价断言的正确性未独立复核（超出本次 R-A/R-B 范围）。
7. **未评估阈值 0.25 对「目标侧中度劣化（如慢 3× 仍未退回全量）」的语义**：0.25 = 要求 ≥4×，慢 3×（比值≈0.165）**仍会绿**——这是
   阈值的固有边界（018-R-A 的取舍延续），本次**未**主张它应更严。

---

## 8. 残余风险（登记）

| # | 风险 | 说明 |
|---|---|---|
| R1 | 目标侧计划缓存失效导致的理论假红 | 仅当连续 5 样本全 custom plan 才可能使 min5 逼近 0.25×参考；本次 CPU 负载（load1 ≤18.7）未触发（比值恒 0.055）。阈值收紧后余量由 ~10.9× 降为 ~4.17×。**建议维持 0.25**；触发复审线建议落到源码注释（D1）。 |
| R2 | R-B panic 依赖 `518880` ≥500 根 | 数据消失/不足时门禁**红并要求人介入**（正是预期）；若未来需小库运行，按注释在 CI 层显式换 code/排除，**不得**恢复静默 return。 |
| R3 | 参考基线耦合 legacy `kline_merged` 视图（继承 018-R-C） | 视图退役 ⇒ 参考 `.expect` panic ⇒ 红（非静默）；须同步替换基线。本次未变。 |
| R4 | D1「注释已写入复审条件」失实 | 仅文档；若审计以源码注释为准，需以本报告 + 报告 151 §收尾-2.3 为准。 |
| R5 | D2 提交吸收 18 个未跟踪 evidence 文件 | 非实现代码；仅提交范围叙事与 `git show --stat` 不完全对应。 |

---

## 9. 原始证据清单（`tester/evidence/019/`）

| # | 文件 | 内容 |
|---|---|---|
| 00 | `00_git_status_before.txt` | 复核前 `git status --porcelain` |
| 01 | `01_commit_stat.txt` | `git show --stat d6bbd47`（21 路径） |
| 02 | `02_commit_nameonly.txt` | `git show --name-only d6bbd47` + 生产源码过滤（仅测试文件命中） |
| 03 | `03_rA_12runs_unloaded.txt` | R-A 连跑 12 次逐次 `[bench]` 比值 + load1 + 结果 |
| 04 | `04_rB_behavior_raw.txt` | R-B 四例原始输出（0 根 / 3 根 panic、旧写法 vacuous PASS、518880 绿） |
| 05 | `05_rA_mutation_raw.txt` | 突变实验 + 对照原始输出（判据非空） |
| 06 | `06_rA_induced_load.txt` | 诱导负载 2 轮（load1 8.82 / 18.73） |
| 07 | `07_rA_stats.txt` | 12 次比值统计 + 余量不足计数 |
| 08 | `08_git_status_after.txt` | 复核后 `git status --porcelain`（0 staged / 0 ` M`） |
| — | `fixtures/zz_recheck019_{rb,mutation}_tmp.rs.txt` | 两个临时复核夹具源码（可复现；原 `.rs` 已删除） |

## 10. 复现命令

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
cargo check -p storage --all-targets
cargo test -p storage --test kline_reader --no-run          # 取得 kline_reader-<hash>
target/debug/deps/kline_reader-<hash> --exact merged_1m_branch_index_limit_performance --nocapture   # 连跑 N 次
./scripts/check-tangle.sh
# R-B / 突变：按 tester/evidence/019/fixtures/*.rs.txt 重建临时夹具后
#   cargo test -p storage --test zz_recheck019_rb_tmp -- --nocapture --test-threads=1
#   cargo test -p storage --test zz_recheck019_mutation_tmp -- --nocapture --test-threads=1   # 跑完删除
```

---

## 11. 判定

**可接受（acceptable）** — R-B 修复成立（响亮失败，红/绿行为级齐备）；R-A 独立复做一致（12/12、最坏余量 4.17×、
诱导负载 3.3–4.5×），突变判据非空，无绝对墙钟上限，无假红证据。**建议阈值：维持 0.25**。
需登记的仅文档级偏差 D1（复审条件未落源码注释）与 D2（提交吸收未跟踪 evidence），均不影响行为，**非阻塞**。
