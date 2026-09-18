# ADR-024 P2b 独立验收 + M30 golden 补例 —— **tester 验收报告**

- **本报告自身路径**：`tester/report/adr024_p2b_and_m30_golden_verification.md`
- 角色：tester（**只验不改生产代码**；未 `git add`/`commit`；未新建数据库）
- 被执行对象：worker 交付 `coder/report/adr024_p2b_tryrun_simlive_linearization.md`
  （源码 `crates/application/src/strategy.rs` + `crates/simlive/src/plugin_orchestrator.rs` + 2 个新测试文件）
- 冻结源码状态：HEAD `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f` + index 中的 P0/P2/P2b（**worktree == index**）
- 证据目录：`tester/evidence/249_adr024_p2b_verify/`（**26 个原始输出**）；B 的产物落
  `tester/evidence/240_adr024_golden_baseline/{m30_1slot,m30_3slots}/`（+ README/compare.sh/freeze.sh/freeze.log/sensitivity）
- 新增测试设计报告：`tester/design/283_adr024_p2b_independent_design.md`；执行记录：`tester/test/300_adr024_p2b_and_m30_execution.md`
- 证据落点（新增，本批）：`tester/design/283_*`、`tester/test/300_*`、本报告

---

# 0. 判词（**结论在最前**）

| 任务 | 判词 | 未过项 | 备注 |
|---|---|---|---|
| **A. P2b 独立验收（A1–A5）** | **PASS** | **无 FAIL 项** | 2 项**验证强度/覆盖**残留（不构成 FAIL，见 §0.2 残留 R1/R2） |
| **B. M30 golden 两例** | **PASS** | **无 FAIL 项** | 1 项**告警**（`m30_1slot` 标准 selftest FAIL，探针点空仓；成因已定位，替换证据已给，见 §B-4） |

## 0.1 「P2b 可否冻结」——明确结论

> **可以冻结（PASS，建议随 P0/P2 一并 commit）。**
>
> 依据：① 复核对象（worker「改造前口径复刻」）经逐条对照**忠实**（§A1）；
> ② tester **自设计**的判别用例（warmup>0 试算 120 bar、sim-live 含 6 态持仓 + 3 策略 360 个评分点）
> 与改造前口径**逐位相同**（§A2）；③ 分配量在 n=1000/2000/4000 三点**常数**、墙钟 n 翻倍比 **≈2**
> （非 ≈4），且**同一度量下改造前形态仍线性增长**（ratio 1.985）⇒ 度量有判别力（§A3）；
> ④ 全仓**构造点实参**级枚举证明「含未来全量切片 + 每 bar `to_vec()`」写法在生产 src 已归零（§A4）；
> ⑤ 范围未越界（`design/16-*`、`docker-compose.yml`、DB/落库/结果 API/护栏常量/sim-live 业务逻辑
> 均未触碰，mtime + sha256 + 常量值三重证据），回归全绿（application 149 passed / simlive 46 passed，
> 退出码 0）（§A5）；⑥ 4 条反向对照（R-A/R-A2/R-B/R-C）证明机制断言**可被弄红**，且退化后
> **逐字节复原**（§A2-3）。
>
> **冻结时请一并知悉 3 条非阻塞残留**（§0.2 R1/R2/R3）——它们是「验证强度」而非「实现缺陷」。

## 0.2 未过项 / 残留逐条

| ID | 类别 | 内容 | 是否阻塞冻结 | 处理建议 |
|---|---|---|---|---|
| **R1** | A2/A4 验证强度 | **试算路径不存在「集成级」前视探针**：`run_pure_score` 内部自建 `QuickJsRuntime`（无法注入探针），且 JS `ctx` **不注入 `bars`**（`build_ctx_object` 仅注入 `index/params/bar/indicators/position/log`）⇒ 该路径「无前视」只能由**私有 helper 单测** + **静态单点枚举**断言（我已经做，见 §A4-3） | 否 | 已知即可。若要集成级强制，可在 `BarCtx::with_history` 加 `debug_assert!(self.bars.len() == self.index+1)`（worker §7.1-3 提过，会破坏 P2 的两个既有反向测试资产 `shared_history.rs:199/271`）⇒ 需架构师裁决另立小批 |
| **R2** | A1 覆盖 | worker 的等价性复刻未覆盖 **warmup>0**（试算）与 **position≠None**（sim-live）两种配置；而 P2b 恰改了 sim-live 的 `bars_since_entry` 取切片方式（`history.with_slice(...)`） | 否 | **已由 tester 独立用例补齐并全绿**（§A2-1/§A2-2） |
| **R3** | B 告警 | `m30_1slot` 的**标准 selftest** 判 FAIL：其 3 条 `[close]` 探针点（bar 500/999）恰为**空仓**，扰动不改变任何输出 | 否 | 已定位成因（首笔 trade 仅 1 根持仓 ⇒ 回退探针点 500）并在 README §4 注/§6-7 标注；非空跑由 **B-R1（年化因子）+ B-R2（持仓 bar 860 价格扰动）** 两条**有效探针**证明（§B-4） |

（另：worker 报告的自报数字与我的实测**无实质矛盾**；两处口径差异见 §A3-3。）

---

# A. P2b 独立验收（6 项，逐项原始输出）

## A1 复刻忠实性审查（**关键项**） —— 判词：**忠实（PASS）**

**方法**：用 `git show HEAD:<f>` 与 `git show :<f>`（index = P2b 开工前状态）取出**改造前真实代码**，
逐条比对 worker 新测试里的「改造前口径复刻」。

> 口径澄清（重要）：P2b 的「改造前」= **HEAD + 已 staged 的 P0/P2**（不是裸 HEAD）——
> 因为 P2 已经把 `build_indicators` 从 `bars[..=index].to_vec()` 改成 `bctx.history()`（兼容路径 =
> `BarHistory::from_bars(&self.bars[..=index])`）。worker 复刻采用的正是**staged 状态的调用形态**，
> 基线选择**正确**。

### A1-1 试算路径（`crates/application/tests/adr024_p2b_tryrun.rs::tryrun_pure_score_bitwise_equal_to_compat_path`）

| # | 核对项 | 改造前真实代码（staged `strategy.rs` = HEAD + P0；该区域与 HEAD 同形，行号 +2） | worker 复刻 | 判定 |
|---|---|---|---|---|
| 1 | **逐 bar ctx 构造** | `let ctx = BarCtx::new(i, bar.clone(), bars, None);`（**P2b 前**等价行：HEAD L905 / staged（+P0 净 +2 行后）≈ L907；P2b 后该行被 helper 调用取代 = 现 `strategy.rs:930`） | `strategy_runtime::BarCtx::new(i, bar.clone(), &bt_bars, None)`（测试 L318） | **一致** |
| 2 | **`bars` 切片口径** | `bars: &[backtest::Bar]` = `all[slice_start..]`（**含未来 bar** 的全量切片），`i` 为该切片内下标 | `&bt_bars`（同一整段） | **一致**（配置见 #3） |
| 3 | **warmup 切片算术** | `split = all.position(ts >= from)`；`warmup_effective = split.min(warmup_requested)`；`slice_start = split - warmup_effective`；`bars = all[slice_start..]`（staged L719-738；HEAD 为 L715-734） | 复刻**未显式复算**，但用例取 `warmup_bars=0` + `from=bars[0].ts` ⇒ `split=0, warmup_effective=0, slice_start=0` ⇒ `bars ≡ bt_bars`（切片恒等） | **一致**；但**未覆盖 warmup>0**（R2，已由本人补测，§A2-1） |
| 4 | **指标接入方式** | 运行时 `build_indicators`：`let hist: Rc<BarHistory> = bctx.history();` → 无共享句柄 ⇒ 兼容路径 `BarHistory::from_bars(&self.bars[..=self.index])` + `OnlineIndicators`（P2 引入，P2b 未改；`quickjs.rs:385`、`types.rs:124`） | 同一运行时、同一函数、未注入共享句柄 ⇒ 走**同一条**兼容路径 | **一致** |
| 5 | **position 快照** | `None`（`run_pure_score` 恒 `None`；ABI §2.5） | `None` | **一致** |
| 6 | **运行时限额 / 插件 / 参数** | `test_run_limits()`（per_call 20ms、mem 32MB、instantiate=max(20×,1s)，`strategy.rs:68-75`）；内联插件源码；`fill_and_validate_params(空 schema, {})` ⇒ 空 params | 复刻同公式（我逐字段核对源码）；同插件字符串常量；`StrategyParams::new()` | **一致** |
| 7 | **循环控制流** | `MAX_SCORE_POINTS` 截断 / `disabled` 熔断分支 / `ctx.take_logs()` 归集 | 复刻未建（400 bar 不触发截断/熔断；events 归集不影响 score） | **一致**（本用例不可达） |
| 8 | **`code_hash`** | 生产传 `sha256_hex(code)` | 复刻传 `"sha256:p2b"` | **一致**（ABI §4：仅用于错误信息标注；已核 `quickjs.rs` 中 `code_hash` 全部用法均在错误/标签路径，不参与执行语义） |

### A1-2 sim-live 路径（`crates/simlive/tests/adr024_p2b_orchestrator.rs::orchestrator_scores_bitwise_equal_to_compat_path`）

| # | 核对项 | 改造前真实代码（HEAD `plugin_orchestrator.rs`，P2b 前 **index == HEAD**） | worker 复刻 | 判定 |
|---|---|---|---|---|
| 1 | **逐 bar ctx 构造** | `let ctx = BarCtx::new(idx, latest_bar.clone(), bars, snapshot);`（HEAD L264） | `BarCtx::new(idx, b.clone(), &accumulated, None)`（测试 L278） | **一致**（`b` 即刚 push 的 `latest_bar`）；`snapshot` 见 #3 |
| 2 | **`bars` 切片口径** | `let bars = self.bars.get(code)?;`（累计 `Vec<Bar>`）；`let idx = bars.len()-1;`（HEAD L238-242） | `accumulated`（同序 push）；`idx = accumulated.len()-1` | **一致** |
| 3 | **position 快照** | `position.map(\|p\| PositionSnapshot{ qty, avg_cost, entry_ts, bars_since_entry: bars_since_entry(bars, idx, p.entry_ts), unrealized_pnl: p.qty*(latest.close-p.avg_cost) })`（HEAD L247-253） | 复刻传 `None`；且 `feed_bar(..., None)` ⇒ 两侧 `snapshot` 皆 `None` | **一致**（本配置下等价，但**未覆盖 position≠None** —— 而 P2b 恰好把 `bars_since_entry` 改为 `history.with_slice(\|bars\| ...)` ⇒ 该路径**未被 worker 测覆盖**；R2，已由本人补测 §A2-2） |
| 4 | **指标接入方式** | 同运行时 `build_indicators` → 兼容路径 | 同 | **一致** |
| 5 | **时长/策略数/权重** | `PluginStrategyOrchestrator::with_quickjs(cfgs, 60, 40, RuntimeLimits::default())`；1 策略、weight 1.0 | `QuickJsRuntime::new(RuntimeLimits::default())`；1 实例 | **一致**（`with_quickjs` 内部即 `QuickJsRuntime::new(limits)`） |
| 6 | **聚合/信号** | `weighted_aggregate((w,score))` + `aggregate_to_signal(·, 60, 40)` | 复刻比对的是 `per_strategy_scores[0].score`（原始分）；单策略下 `aggregate ≡ score`，未额外比对聚合/信号 | **一致**（信息不丢；多策略聚合已由本人 §A2-2 的 3 策略用例补齐） |

**A1 判词：复刻忠实（PASS）。** 无「差异行」；两处**覆盖缺口**（warmup>0、position≠None）如实标注并由 tester 补测。

---

## A2 等价性独立复核 + 反向对照 —— 判词：**PASS**

### A2-1 tester 自设计判别用例 ①：试算 **warmup>0** 全流程复刻（`crates/application/tests/tester_p2b_tryrun_indep.rs`）

复刻的是**HEAD 的整段流程**（拉取 → `split` → `warmup_effective` → `slice_start` → `all[slice_start..]`
→ 逐 bar `BarCtx::new(i, bar, bars_full, None)`），被判对象是**真实公开入口** `StrategyService::test_run`；
插件评分**同时耦合 `ctx.index` / `ctx.bar.ts` / `ctx.bar.close` / `ma(5)`**（任何 index 或窗口偏移都会变红）。

```
$ cargo test -p application --test tester_p2b_tryrun_indep -- --nocapture --test-threads=1
running 3 tests
test indep_tryrun_warmup_flow_bitwise_vs_prechange_replica ...
[tester-indep/tryrun] warmup 位级等价：bars=120 warmup_effective=30 warmup_true=30 逐位相等=120 distinct_scores=117
[tester-indep/tryrun] 前 5 bar（新路径）：[(1788220800, Some(4626476121078649323), true), (1788220860, Some(4626465706504511029), true), (1788220920, Some(4626449662430838522), true), (1788220980, Some(4626503142676413546), true), (1788221040, Some(4632258461525216329), true)]
ok
test indep_simposition_tryrun_matches_direct_engine ...
[tester-indep/tryrun] SimPosition 回归对照：bars=120 warmup_effective=30 trades=1 fills=2 aggregate/ts/warmup/signal/trades 逐位一致
ok
test indep_alloc_flat_new_path_vs_growing_compat_path ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.28s
```

- 覆盖：`bar_count`/`warmup_requested`/`warmup_effective` 相等、**120 bar 逐位 score + ts + warmup 标记全等**、
  `warmup=true` 恰 30 根、distinct scores = 117（有鉴别力）。
- 附带的 SimPosition 回归对照（warmup 30 + 真实买卖 2 次成交 + events 映射）与**直接引擎调用**逐位一致
  （`aggregate`/`ts`/`warmup`/`signal`/`trades` 全等）。

> 注记（**硬止损的可表达性**）：试算路径**无法表达硬止损** —— `run_sim_position` 硬编码 `stop: None`
> （`strategy.rs:1027`）⇒ 任务书建议的「warmup + 买卖 + 硬止损」在本批两条路径上只能以
> 「warmup + 买卖」（试算）+「持仓态含离场/止损式清仓」（sim-live，§A2-2）覆盖；
> **引擎侧硬止损**由既有 golden `m1_1slot_stop`（ATR(2.0) Intrabar，47 次 StopTrigger 成交，本批 13 例比对 PASS）覆盖。

### A2-2 tester 自设计判别用例 ②：sim-live **含 6 态持仓 + 3 策略**（`crates/simlive/tests/tester_p2b_orchestrator_indep.rs`）

持仓脚本：空仓(0-9) → 建仓(10-24) → 加仓(25-34) → 部分卖出(35-44) → **清仓/止损式离场(45-49)** → 再建仓(50-59)；
插件评分**耦合 `index` / `bar` / `position` 全 5 字段 / `ma(5)`**；3 策略权重 1.0/0.5/1.5（覆盖加权聚合）。

```
$ cargo test -p simlive --test tester_p2b_orchestrator_indep -- --nocapture --test-threads=1
running 3 tests
test indep_orchestrator_alloc_flat_vs_growing_compat ...（见 §A3）
test indep_orchestrator_ctx_prefix_and_position_fields ...
[tester-indep/sim-live] ctx.bars 可见面（独立探针）：rows=60 违例=0 bars_len==index+1 全成立 ahead_visible 全 false 逐元素前缀相等=true 句柄恒等=true
  idx=0 bars_len=1 ahead_visible=false shared_handle=true history_ptr=0x71aee4005a10
  idx=1 bars_len=2 ahead_visible=false shared_handle=true history_ptr=0x71aee4005a10
  idx=2 bars_len=3 ahead_visible=false shared_handle=true history_ptr=0x71aee4005a10
[tester-indep/sim-live] ctx.position 复刻比对：60 bar 全等（null 15 / some 45）；抽印 idx=10,25,35,45,50 → [(10, Some(PositionSnapshot { qty: 1000.0, avg_cost: 12.9, entry_ts: 1700000600, bars_since_entry: 0, unrealized_pnl: -909.9999999999984 })), (25, Some(... bars_since_entry: 15 ...)), (35, Some(... bars_since_entry: 25 ...)), (45, None), (50, Some(... bars_since_entry: 0 ...))]
ok
test indep_orchestrator_scores_bitwise_vs_prechange_replica_with_positions ...
[tester-indep/sim-live] 位级等价（含持仓）：bars=120 slots=3 持仓 bar=105 逐位相等=360 distinct_scores=119 signals={"sell", "hold"}
ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.28s
```

- 360 个 slot 评分 + 聚合分 `to_bits()` 全等 + `signal` 全等 + `ts` 全等；
- `ctx.position` **60 bar 逐字段**等于改造前公式（含 `bars_since_entry = idx − partition_point(ts < entry_ts)`）⇒ **补上 R2**。

### A2-3 反向对照（人为退化 ⇒ 必须变红 ⇒ 逐字节复原）

| ID | 退化（临时改生产代码） | worker 断言 | tester 独立断言 | 复原 |
|---|---|---|---|---|
| **R-A** | `tryrun_bar_ctx`：`&bars[..=index]` → `bars`（暴露未来；保留共享句柄） | **lib 单测红**（`left: 8 right: 1`）；等价性/分配量仍绿 | **仍绿**（做不到 —— 见 §A4 读法与 R1） | sha256 `6d31ad10…77fe` 相同 + `git diff` 空 + 复绿（`A2R_A_*.txt`） |
| **R-A2** | 再删 `.with_history(...)`（= 改造前完整形态） | alloc 红：`50522.8 → 98518.0`（ratio **1.950**） | **alloc 红**：`25023.2 → 97010.3`（ratio **1.979**） | 同上 |
| **R-B** | `evaluate`：删 `.with_history(...)`（退回每 bar 复制） | 探针红 + alloc 红：`50727.5 → 98726.5`（ratio **1.946**） | **探针红 + alloc 红**：`49217.8 → 97216.0`（ratio **1.975**） | sha256 `b901affe…d87` 相同 + `git diff` 空 + 复绿（`A2R_B_*.txt`） |
| **R-C** | `evaluate`：`ctx.bars` = `bars + [当前 bar]`（暴露 index 之外） | 探针红（`left: 2`）+ alloc 红（145132→289130） | **探针红**（`left: 2`，`bars_eq_prefix=false`） | 同上（`A2R_C_*.txt`） |

> 读法：**等价性测试对机制退化「无判别力」是设计使然**（它是对外行为守卫：`bctx.history()` 在有/无共享句柄
> 时都按 `bars[..=index]` 取值 ⇒ 退化后 score 仍逐位相同）。机制项由 **句柄断言 + 分配量比值** 把关 ——
> 这条分工 worker 已在报告 §5 明示，我的复现与之**一致**。

---

## A3 分配量与墙钟（独立测量） —— 判词：**PASS**

**测量方式**：计数 `GlobalAlloc`（`alloc+realloc` 字节）+ `Instant`；测量窗口内含 `spawn_blocking` 评分线程；
夹具构造在窗口外；同一二进制内 `SERIAL` 互斥。**同一二进制内同时测量「新路径」与「改造前调用形态（兼容路径）」**
⇒ 度量本身自带判别力控制组。

```
$ cargo test -p application --test tester_p2b_tryrun_indep indep_alloc -- --nocapture
[tester-indep/alloc·新路径] n=1000 703.2 B/bar（12.0 ms） | n=2000 695.3 B/bar（23.3 ms） | n=4000 690.3 B/bar（45.3 ms）
[tester-indep/alloc·新路径] ratio 4000/2000 = 0.993（期望 ≈1，常数）；wall ratio = 1.948（期望 ≈2）
[tester-indep/alloc·兼容路径(改造前形态)] n=2000 48736.1 B/bar（47.0 ms） | n=4000 96736.0 B/bar（145.0 ms）；ratio = 1.985（期望 ≈2，线性）

$ cargo test -p simlive --test tester_p2b_orchestrator_indep indep_orchestrator_alloc -- --nocapture
[tester-indep/alloc·新路径] n=2000 897.8 B/bar（24.3 ms） | n=4000 896.0 B/bar（47.1 ms）；ratio=0.998（期望 ≈1）；wall ratio=1.941（期望 ≈2）
[tester-indep/alloc·兼容路径(改造前形态)] n=2000 48736.1 B/bar（47.2 ms） | n=4000 96736.0 B/bar（146.5 ms）；ratio=1.985（期望 ≈2）
```

### A3-1 汇总表（tester 实测，debug 口径）

| 路径 | n | 每 bar 分配 B/bar | 比值(4000/2000) | 墙钟 ms | 墙钟比 |
|---|---|---|---|---|---|
| 试算·新路径 | 1000 / 2000 / 4000 | 703.2 / 695.3 / 690.3 | **0.993（常数）** | 12.0 / 23.3 / 45.3 | **1.95** |
| 试算·改造前形态（兼容路径） | 2000 / 4000 | 48,736.1 / 96,736.0 | **1.985（线性）** | 47.0 / 145.0 | 3.09 |
| sim-live·新路径 | 2000 / 4000 | 897.8 / 896.0 | **0.998（常数）** | 24.3 / 47.1 | **1.94** |
| sim-live·改造前形态（兼容路径） | 2000 / 4000 | 48,736.1 / 96,736.0 | **1.985（线性）** | 47.2 / 146.5 | 3.10 |

**判据达成**：n 翻倍 ⇒ 时间 ≈2×（线性）、每 bar 分配 ≈1×（常数），**不是** 4×/2×（二次项）。
「度量判别力」由同表内**改造前形态仍 1.985×** 独立证明（不是「两边都平」的空测）。

### A3-2 与 worker 自报对照

| 项 | worker 自报 | tester 重跑其测试 | tester 独立测量 | 结论 |
|---|---|---|---|---|
| 试算 alloc n=2000 → 4000 | 855.5 → 850.4（0.994） | **855.5 → 850.4（0.994）**（逐位复现） | 695.3 → 690.3（0.993） | **一致（比值）**；绝对量差异见 A3-3 |
| sim-live alloc n=2000 → 4000 | 1060.2 → 1058.8（0.999） | **1060.2 → 1058.8（0.999）**（逐位复现） | 897.8 → 896.0（0.998） | **一致（比值）** |
| 试算 wall n=2000 → 4000 | 33.6 → 65.9（1.965） | 36.4 → 65.4（1.795） | 23.3 → 45.3（1.948） | **一致（同一量级/同一 ≈2 定序）**；单次采样噪声 |
| sim-live wall | 34.0 → 67.5（1.986） | 34.2 → 67.8（1.981） | 24.3 → 47.1（1.941） | 同上 |
| 改造前 alloc | 50,522.8 → 98,518.0（1.950） | **50522.8 → 98518.0（1.950）**（R-A2 退化解：逐位复现） | 48,736.1 → 96,736.0（1.985） | **一致（比值）** |

### A3-3 口径差异（如实说明，**不是矛盾**）

- **绝对 B/bar 与夹具强相关**（含 QuickJS `ctx` 对象等常数项 + 插件调用面 + bar 序列）：
  我的判别插件只调 `ma(5)` 并耦合 index/ts/close，worker 的调 7 个指标 ⇒ 我测的新路径绝对量更低
  （695 vs 855 B/bar），改造前形态亦略低（48,736 vs 50,523 B/bar，约 −3.5%）。
- **只有「比值」是判据**（worker 亦如此自述，见其报告 §3）；双方比值互相印证：新路径 0.993–0.999、
  改造前 1.946–1.985、墙钟 1.79–1.99。
- **口径一致性证据**：在 R-A2/R-B 退化态下，**同一二进制、同一夹具**跑出的 pre 数字与 worker 完全一致
  （50522.8/98518.0、50727.5/98726.5）⇒ 双方测量口径无系统性偏差。
- 绝对值口径提醒：worker 自报「−98.3% / −97.9%」降幅按**其夹具**成立；按我的夹具为
  「试算 −98.6%（48,736→690）/ sim-live −98.2%（48,736→896）」⇒ 结论方向一致。

---

## A4 「可读未来」面彻底消除 —— 判词：**PASS**（附「读法/强度」说明）

### A4-1 两条 P2b 路径的断言输出

**sim-live（tester 独立探针，比 worker 探针更强：逐元素比对前缀）**：

```
[tester-indep/sim-live] ctx.bars 可见面（独立探针）：rows=60 违例=0
  bars_len==index+1 全成立 | ahead_visible 全 false | 逐元素前缀相等=true | 句柄恒等=true
```

**试算（worker 的 helper 单测；tester 重跑原始输出）**：

```
$ cargo test -p application --lib p2b -- --nocapture
[P2b/tryrun] ctx.bars 可见面（n=8）：
  idx=0 bars_len=1 cur_eq_ctx_bar=true shared_handle=true
  ... （idx=7 bars_len=8 cur_eq_ctx_bar=true shared_handle=true）
test strategy::p2b_tests::tryrun_bar_ctx_narrows_to_prefix_and_shares_history ... ok
```

**试算路径的独立复核（tester，静态单点枚举）**：

```
$ awk '/^fn run_pure_score\(/,/^}$/' crates/application/src/strategy.rs | grep -n "BarCtx::new\|tryrun_bar_ctx\|hist\.push"
  run_pure_score 内第 49:        hist.push(bar.clone());
  run_pure_score 内第 62:        let ctx = tryrun_bar_ctx(i, bar, bars, &hist);
$ grep -n "BarCtx::new" crates/application/src/strategy.rs
  crates/application/src/strategy.rs:861:    BarCtx::new(index, bar.clone(), &bars[..=index], None).with_history(hist.clone())
```

⇒ `run_pure_score` 体内**恰一处** ctx 构造，且唯一实参形态是 helper 的 `&bars[..=index]`。

> **读法与强度（R1）**：试算路径**无法**注入探针 runtime、JS `ctx` **不注入 `bars`**
> ⇒ 「无前视」在该路径上**不存在集成级运行时断言**，证据 = 「私有 helper 单测（worker）」+
> 「构造点单点枚举（tester）」。**不构成缺陷**（该属性在 helper 内是单点、可回归），但**验证强度弱于 sim-live**；
> 该强度缺口正是 R-A 反向对照中「只有 worker 的 helper 单测变红」的原因。

### A4-2 全仓枚举（构造点实参级，2026-09-18 工作树 = index）

```
$ grep -rn --include=*.rs --exclude-dir=target,node_modules,.git,data "BarCtx::new" crates/ | grep -v "/tests/"
crates/application/src/strategy.rs:861                     ← P2b：&bars[..=index] + with_history
crates/simlive/src/plugin_orchestrator.rs:276              ← P2b：bars（= 共享缓冲 with_slice，len 恒 = idx+1）+ with_history
crates/strategy-core/src/engine.rs:656                     ← P2：bars（= shared.with_slice 内的缓冲切片，len 恒 = i+1）+ with_history

$ grep -rn --include=*.rs --exclude-dir=target,node_modules,.git,data "to_vec()" crates/*/src/ | grep -iE "bars|hist"
crates/application/src/strategy.rs:738:        let bars: Vec<backtest::Bar> = all[slice_start..].to_vec();   ← 每 run 一次（非每 bar）
crates/application/src/workbench.rs:318:       let bars: Vec<backtest::Bar> = all[slice_start..].to_vec();   ← 每 run 一次（非每 bar）
（其余命中为 rustdoc 文本）

$ grep -rn --include=*.rs --exclude-dir=target,node_modules,.git,data -E 'bars\[[^]]*(index|idx)[^]]*\+|bars\.last\(\)|bars\[bars\.len\(\)' crates/
crates/tushare/src/bin/tushare_sync.rs:133   bars.last()   ← 数据面（与插件 ctx 无关）
crates/storage/src/reader.rs:246             bars.last()   ← 数据面
crates/storage/tests/kline_reader.rs:792     bars.last()   ← 测试
crates/application/tests/adr024_p2b_tryrun.rs:277  bars[bars.len()-1].ts  ← 测试夹具

$ grep -rn ... 'ctx\.bars\.(get|iter|len|first|last)|bctx\.bars\.(...)' crates/
crates/application/src/strategy.rs:1146/1174/1175/1183/1184   ← P2b 新增断言自身
crates/simlive/tests/adr024_p2b_orchestrator.rs:159-161       ← worker 探针自身
（生产路径除断言/探针外 0 处读取 ctx.bars）
```

**命中清单解读**：

1. 生产 src 内 `BarCtx::new` **仅 3 处**：P2b 两处（前缀/共享缓冲切片 + 共享句柄）、P2 引擎一处
   （`shared.with_slice(|bars| …)` 内，`bars.len() == i+1` ⇒ 前缀）⇒ **三条宿主路径均无「全量含未来切片」**。
2. 「每 bar `to_vec()` 复制历史」写法在生产 src **已归零**；剩余 `to_vec()` 均为**每 run 一次**的
   `all[slice_start..]` 行复制（`strategy.rs:738` / `workbench.rs:318`），与 per-bar 二次项无关。
3. 数据面 `bars.last()`（tushare 同步 / storage reader）与插件 `ctx` 无关，不属本面。
4. **方法学补强**：worker 的 `22_no_future_surface.txt` 只用「越界下标模式」grep
   （`bars[(index|idx)…+]` / `bars.last()` / `ctx.bars.*`），**捕获不了**「传全量切片但下标不越界」这种形态
   （= 改造前形态本身）。本报告改用**构造点实参枚举**（上面第 1 条）⇒ 这正是 `A4_02/A4_03` 的价值。

**A4 判词：PASS。** 两条目标路径 `bars_len == index+1` / `ahead_visible == false` 成立（sim-live 集成探针
逐元素；试算 helper 单测 + 单点枚举），全仓「构造点实参」级枚举证明该写法已消除。

---

## A5 范围与回归 —— 判词：**PASS**

### A5-1 `git diff HEAD --stat`（全量 134 文件）与归属分类

原始输出：`A5_01_git_diff_stat.txt`（HEAD=`18d1b9a…`，`134 files changed, 11318 insertions(+), 389 deletions(-)`）。
按批次归属分类：

| 批次 | 文件（生产/测试/设计） |
|---|---|
| **P0（M30 打通 + 周期 SSOT）** | `crates/backtest/src/types.rs`、`crates/application/src/bar_map.rs`、`crates/application/src/simlive.rs`(+4，穷尽性补丁)、`crates/mcp/src/tools.rs`、`crates/storage/src/backtest.rs`、`crates/domain/src/ports.rs`、`crates/web/src/workbench.rs`、`web/src/api/{mock,types}.ts`、`web/src/features/backtest/{format,periods}.ts`、`web/src/features/{strategies/TestRunPanel,workbench/ConfigPanel}.tsx`、`design/02-domain/contracts.md`、`design/07-app-plane/01-mcp.md` + P0 新测试（`backtest_periods_ssot.rs`、`adr024_period_ssot_drift.rs`、`adr024_workbench_period_ssot.rs`、`periods.test.ts`）+ `coder/evidence/adr024_p0_m30/**`、`coder/report/adr024_p0_*.md` |
| **P2（引擎线性化）** | `crates/strategy-core/src/{engine,lib}.rs`、`crates/backtest/src/{indicators.rs,lib.rs}`、`crates/strategy-runtime/src/{history.rs(新),lib,quickjs,types}.rs` + P2 新测试（`session*.rs`、`shared_history*.rs`、`online_indicators_fixture.rs`）+ `coder/evidence/adr024_p2/**`、`coder/report/adr024_p2_engine_linearization.md` |
| **P2b（本批）** | `crates/application/src/strategy.rs`（**116/2**）、`crates/simlive/src/plugin_orchestrator.rs`（**28/12**）、`crates/application/tests/adr024_p2b_tryrun.rs`（+362）、`crates/simlive/tests/adr024_p2b_orchestrator.rs`（+326）、`coder/evidence/adr024_p2b/**`、`coder/report/adr024_p2b_*.md` |
| 架构师 | `design/16-backtest-scalability/**`（01/02/03/04 + contract-vectors.json） |
| **开工前既存 unstaged（非任何批次，未 `git add`）** | `design/01-architecture/adr/ADR-023-*.md`、`design/99-decisions-log.md`、`docker-compose.yml` |

**P0 / P2b 在 `strategy.rs` 内的切分**（`A5_02_strategy_rs_staged_diff.txt` 逐 hunk 核对）：
index-vs-HEAD = **122/6** = P0（**6/4**，纯 M30 文档/注释与白名单文案，**无行为改动**）
+ P2b（**116/2**，`Rc/BarHistory` import、`tryrun_bar_ctx`、`run_pure_score` 的 hist、`p2b_tests` 单测）。
⇒ 与 worker 自报「+116/−2」**一致**。

### A5-2 未触碰断言（三重证据：内容 sha256 / 常量值 / mtime）

| 断言 | 证据 | 结论 |
|---|---|---|
| `design/16-backtest-scalability/**` 未触碰 | 全部为 `A`（staged，无 worktree 偏离）；mtime **13:37** < P2b 窗口（测试文件 13:45、证据目录 13:47、源文件 13:52） | **成立** |
| `docker-compose.yml` 未触碰 | `MM` 于开工前既存（mtime **12:16**，早于 P2b 窗口）；未纳入任何 `git add` | **成立** |
| DB schema / 落库 / 结果 API（`storage/**`、`web/**`、`mcp/**`）未触碰 | `crates/storage/src/backtest.rs` 12:44、`crates/web/src/workbench.rs` 12:52、`crates/mcp/src/tools.rs` 12:40 —— 均为 **P0 时段**，早于 P2b 窗口 13:45+ | **成立** |
| 区间护栏常量未改 | `MAX_SCORE_POINTS=50_000`、`MAX_EVENTS=1_000`、`MAX_TRADES=5_000`、`D1_MAX_SPAN_DAYS=366*5`、`MINUTE_MAX_SPAN_DAYS=93` **值全等**（行号因新增代码位移 +2/+3） | **成立** |
| sim-live 业务逻辑未触碰 | `session.rs` / `fill.rs` / `account.rs` / `strategy_orchestrator.rs` 的 **sha256 与 HEAD 逐文件相同**；mtime 仍为 2026-09-12（P4a） | **成立** |
| `application/src/simlive.rs` 的 4 行属 P0 | mtime 12:38（P0 时段）；内容为 M30 穷尽性补丁（架构师初核） | **成立**（非 P2b） |

原始输出：`A5_03_constants_and_untouched.txt`。

### A5-3 回归套件

```
$ cargo test -p application --no-fail-fast
     Running unittests src/lib.rs                                  27 passed
     Running tests/adr024_p2b_tryrun.rs                             2 passed
     Running tests/backtest_periods_ssot.rs                         6 passed
     Running tests/simlive.rs                                      55 passed
     Running tests/strategy.rs                                     39 passed
     Running tests/tester_p2b_tryrun_indep.rs     ← tester 新增     3 passed
     Running tests/workbench.rs                                    17 passed
     Doc-tests application                                          0 passed
   合计 149 passed / 0 failed（exit=0）

$ cargo test -p simlive --no-fail-fast
    lib                                                           40 passed
    tests/adr024_p2b_orchestrator.rs                               3 passed
    tests/tester_p2b_orchestrator_indep.rs       ← tester 新增     3 passed
    Doc-tests                                                      0 passed
   合计 46 passed / 0 failed（exit=0）
```

与 worker 自报对照：worker 报 application **146**（143 + 本批 3）⇒ 146 + tester 3 = **149** ✓；
simlive **43**（40 + 3）⇒ 43 + tester 3 = **46** ✓。**一致**。

**A5 判词：PASS**（范围未越界 + 回归全绿 + 退出码 0）。

---

# B. M30 golden 两例（P2b 验收任务 B） —— 判词：**PASS**

## B-1 产物

| 路径 | 内容 |
|---|---|
| `tester/evidence/240_adr024_golden_baseline/m30_1slot/{case.json,bars.jsonl,expected.json}` | M30 × 1 slot（`dual_ma{fast:5,slow:20,w:1.0}`） |
| `tester/evidence/240_adr024_golden_baseline/m30_3slots/{case.json,bars.jsonl,expected.json}` | M30 × 3 slots（+ `macd{12,26,9,w:0.5}` + `kdj{9,3,3,w:1.5}`） |

- 数据源：`kline_accurate_30m`（活库 `eestock-timescaledb`，**只读导出**）；`export_bars.sh m30_* kline_accurate_30m 510880 1000`
  ⇒ `ORDER BY ts DESC LIMIT 1000` 后升序；窗口 `2026-04-27T05:30:00Z ~ 2026-09-17T07:00:00Z`；
  `bars_sha256` 双双为 `4a0f289b…df9d`（两例同输入）。
- 口径与既有 11 例一致：标的 `510880`、`buy/sell=60/40`、`policy=LumpSum(1.0)`、`initial_capital=1e5`、
  `FeeModel::default()`、`warmup_bars=0`、`stop=null`、同插件/权重集合。
- **粒度健全性**（防「M15/M1 冒充 M30」）：ts 步长集合含 **1800s**（M30）——`m15_1slot` 对照组为 900s。

## B-2 「P2 后基线」标注（硬要求）

| 位置 | 写法 |
|---|---|
| `case.json` | `"baseline_kind": "post_p2_regression"` + `baseline_reason`（pre-P2 M30 不可捕获；引擎路径与周期无关 ⇒ 跨 P2 等价由既有 5 周期 11 例覆盖）+ `"source_state": "HEAD=18d1b9a… + staged P0(M30 打通)/P2(引擎线性化)/P2b(试算/sim-live 线性化)"` + `data_view` + `bar_window_utc` |
| `expected.json` | 同名字段由 harness 落盘（`baseline_kind="post_p2_regression"`、`source_state="HEAD=18d1b9a… + staged P0(M30)/P2(engine)/P2b(tryrun+simlive)"`），另有 `engine_commit=18d1b9a…`、`captured_at=2026-09-18T05:54:3x Z` |
| `README.md` §1.1（新增） | 表 + 三条理由 + **判读纪律**：「看到 post_p2_regression 全绿只能说『相对 P2 后状态未回归』，**不能**反推『P2 未改变行为』」 |
| `compare.sh` 头注释 | 13 例自动枚举 + 同一判读纪律 |

**为什么「不得作为跨 P2 等价证据」**（README §1.1 三条，摘要）：
① pre-P2 的 M30 **不可捕获**（M30 是 P0 才打通）⇒ 用 post-P2 冻结的 M30 去证「P2 没改 M30」是**自证循环**；
② P2 改的是**与周期无关**的喂数据机制 ⇒ 跨 P2 等价由既有 **11 例（5 周期 × 1/3 slots + contain）**承担；
③ M30 两例的正确用途是 **P2/P2b 之后的回归守卫**（B-R1/B-R2 已证明它对真实扰动敏感）。

## B-3 比对跑通（13 例）

```
$ bash tester/evidence/240_adr024_golden_baseline/compare.sh
case_id                     bars   A_ck   B_ck  max_abs_dev max_rel_dev  dev>0  ledger_ck  ledger  layer
d1_1slot                     500    3239    2189     0.000e0     0.000e0      0       3736    PASS  A/B PASS
d1_3slots                    500    4728    3555     0.000e0     0.000e0      0       4028    PASS  A/B PASS
h1_1slot                     800    5175    3493     0.000e0     0.000e0      0       5796    PASS  A/B PASS
h1_3slots                    800    7476    5628     0.000e0     0.000e0      0       6392    PASS  A/B PASS
m15_1slot                   1000    6407    4318     0.000e0     0.000e0      0       7356    PASS  A/B PASS
m15_3slots                  1000    9433    7101     0.000e0     0.000e0      0       8028    PASS  A/B PASS
m1_1slot                    1500    9815    6630     0.000e0     0.000e0      0      10652    PASS  A/B PASS
m1_1slot_stop               3000   19324   13030     0.000e0     0.000e0      0      20020    PASS  A/B PASS
m1_3slots                   1500   14334   10790     0.000e0     0.000e0      0      12036    PASS  A/B PASS
m30_1slot                   1000    6443    4345     0.000e0     0.000e0      0       7176    PASS  A/B PASS   ← 新增
m30_3slots                  1000    9377    7055     0.000e0     0.000e0      0       7936    PASS  A/B PASS   ← 新增
m5_1slot                    1200    7828    5287     0.000e0     0.000e0      0       9076    PASS  A/B PASS
m5_3slots                   1200   11282    8493     0.000e0     0.000e0      0       9528    PASS  A/B PASS
A/B 层：13 用例，失败 0 用例
C 层偏差-规模 log-log 斜率 = n/a（全部 dev==0）→ PASS
持仓台账：bitwise FAIL 0 用例 / 自证 FAIL 0 用例 / 自证 dev>0 条目 0
== VERDICT: PASS ==       （exit=0）
```

附加事实：
- **既有 11 例的 `payload_sha256` 冻结前后逐例未变**（说明本次只新增两例，且未用 post-P2 源码覆盖 pre-P2 期望值）；
- 两例**非空跑**：`m30_1slot` 26 笔交易 / 52 次成交；`m30_3slots` 80 笔交易 / 163 次成交；台账自证 PASS；
- `m30_3slots` 的 `compare.sh --selftest` = **PASS**（含 3-slot 权重扰动 FAIL、三种 close 扰动 FAIL）；
- `m30_1slot` 的 `compare.sh --selftest` = **FAIL（告警，见 B-4）**。

## B-4 反向证据（证明两例不是空跑）

**B-R1（年化因子人为改错）** —— 原始输出 `B_04_reverse_m30_annualization.txt`：

```
改动：crates/backtest/src/types.rs: Period::M30 => 252.0 * 8.0  →  252.0 * 4.0
--- m30_1slot ---
[B-FAIL] m30_1slot: 浮点偏差超限 @result.metrics.annualized_return: expected=5.09351897036445234e-2 actual=2.51513008837498386e-2 abs=2.578e-2 rel=5.062e-1 tol=5.094e-11
[B-FAIL] m30_1slot: 浮点偏差超限 @result.metrics.sharpe:            expected=4.89555139321183552e-1 actual=3.46167758778733903e-1 abs=1.434e-1 rel=2.929e-1
== VERDICT: FAIL ==   [exit] 2
--- m30_3slots ---
[B-FAIL] m30_3slots: ... annualized_return rel=4.775e-1 ; sharpe rel=2.929e-1
== VERDICT: FAIL ==   [exit] 2
--- 控制组 m15_1slot（非 M30）---
== VERDICT: PASS ==   [exit] 0
复原：sha256 177048cb84a2005563e5cdafc5f52787dc98eb407bfefdc1b99d870e83717b97（与备份相同）；git diff 空；复跑两例 PASS
```

**B-R2（持仓区间内真实价格扰动；复用官方比对器）** —— `B_06_reverse_m30_price_probe.txt`：

```
把 m30_1slot 的 bar 860（持仓区间 846..880 内）close ×1.001 放进临时 case（expected = 冻结基线原文）
[B-FAIL] m30_1slot_probe: @result.net_value[860][1]  expected=1.01265360826094329e5 actual=1.01366626186920432e5 abs=1.013e2 rel=1.000e-3
[B-FAIL] m30_1slot_probe: @result.metrics.sharpe    expected=4.89555139321183552e-1 actual=4.89763368228950446e-1 rel=4.253e-4
[A-FAIL·台账位级] m30_1slot_probe: @derived.position[860].unrealized_pnl expected=159.094080525334 actual=260.35944135143654（位级不等）
== VERDICT: FAIL ==   [exit] 2
--- 控制组：原 m30_1slot（未扰动）== VERDICT: PASS ==   [exit] 0
（临时用例目录已删除）
```

**告警 B-R3（`m30_1slot` 标准 selftest FAIL，成因已定位，非比对器缺陷）**：

```
[close] bars[500].close ×1.001（中段/持仓中）→ PASS（A-FAIL 0 / B-FAIL 0；max_abs_dev=0.000e0）  ← 期望 FAIL
[close] bars[999].close ×1.001（末根）        → PASS（同上）
[close] bars[500].close ×1.000001             → PASS（同上）
[L1]/[L2]/[L3]/[L0] 全部符合预期
== SELFTEST VERDICT: FAIL（比对器敏感性不足或控制组误报） ==
```

成因（已用 trades 还原持仓区间验证）：selftest 的中段探针点取「首笔 trade 的 `open_bar+1`（该笔 hold>1 时）」
否则回退 `len/2`；`m30_1slot` 首笔 trade = **(50, 51, hold=1)** ⇒ 回退 **500**，而该例
**bar 500 与 bar 999 均空仓**（末笔交易 924..947）⇒ 对空仓 bar 改 close 不改变任何订单/净值/指标输出。
`m15_1slot` 之所以通过，是因为它在 bar 500/999 **持仓中**。
**不修改 selftest 逻辑**（与既有 3 例口径保持一致）；该例的敏感性与非空跑由 **B-R1 + B-R2** 承担，
已在 README §4 注 / §6 第 6–7 条标注。⇒ **不构成 B 的 FAIL**，但需架构师知悉。

**实施说明（harness，tester 资产）**：`tester/harness/adr024_harness/src/main.rs::CaseFile::period()` 原**无 M30 分支**
（P1 冻结时尚无该档）⇒ 补 `"M30" => Ok(Period::M30)`，并加 `--baseline-kind/--source-state` 两个可选参数
用于落「P2 后基线」标注（既有 11 例不受影响，字段缺省为空）。未补之前以 M30 用例跑比对会直接报
`未知周期 M30`（⇒ 新增两例确实被 harness 读取，未被静默跳过）。

---

# C. 纪律与产物清单

- **未改生产代码**（最终 `git diff -- crates/` 为空；三处临时退化已逐字节复原）：`A5_06_discipline_check.txt`；
- **未 `git add` / `commit`**：`git diff --cached --name-only | grep tester` 为空；tester 产物全为 untracked；
- **未新建数据库**（M30 输入仅从既有活库只读导出）；
- 新增/修改的 tester 产物：
  - 测试（新增）：`crates/application/tests/tester_p2b_tryrun_indep.rs`、`crates/simlive/tests/tester_p2b_orchestrator_indep.rs`
  - 证据（新增）：`tester/evidence/249_adr024_p2b_verify/**`（23 文件）
  - B 产物：`tester/evidence/240_adr024_golden_baseline/m30_1slot/**`、`m30_3slots/**`、
    `sensitivity/m30_{1slot,3slots}_selftest.txt`；**修改**：`README.md`（§1/§1.1/§2/§3.1/§4/§5/§6）、
    `compare.sh`（头注释）、`freeze.sh`（M30 两例自动带标注）、`freeze.log`（追加 P2b 段）、
    `tester/harness/adr024_harness/src/main.rs`（M30 周期分支 + 两个可选标注参数）
  - 报告：`tester/design/283_adr024_p2b_independent_design.md`、`tester/test/300_adr024_p2b_and_m30_execution.md`、**本报告**

# D. 证据索引（`tester/evidence/249_adr024_p2b_verify/`）

| 文件 | 对应 |
|---|---|
| `00_baseline_hashes.txt` | 开工前 4 个目标文件 sha256 |
| `A2A3_01/02_worker_*_rerun.txt`、`A4_01_worker_lib_p2b_rerun.txt` | worker 断言重跑（A2/A3/A4） |
| `A2_02_tester_indep_tryrun.txt`、`A2A4_03_tester_indep_simlive.txt` | tester 新增判别用例绿态 |
| `A2R_A_*`（试算暴露未来/无句柄）、`A2R_B_*`（sim-live 无句柄）、`A2R_C_*`（sim-live 暴露未来） | 反向对照 + 复原 |
| `A4_02_grep_no_future_surface.txt`、`A4_03_static_enumeration.txt` | 全仓枚举 / 构造点实参级复核 |
| `A5_01_git_diff_stat.txt`、`A5_02_strategy_rs_staged_diff.txt`、`A5_03_constants_and_untouched.txt` | 范围（P0/P2/P2b 归属 + 未触碰三重证据） |
| `A5_04/A5_05_cargo_test_{application,simlive}.txt` | 回归套件 |
| `A5_06_discipline_check.txt` | 纪律核查 |
| `A5_07_final_state_recheck.txt` | 报告定稿后的最终状态复核（哈希/复跑/无残留） |
| `B_00_compare_report_11cases_before.txt` | 变更前 11 例报告留档 |
| `B_01_export_m30_bars.txt`、`B_02_freeze_m30.txt` | M30 输入导出 + 冻结（含 11 例 hash 未变证据） |
| `B_03_compare_13cases.txt`、`B_07_final_state.txt` | 13 例比对 / 最终态 |
| `B_04_reverse_m30_annualization.txt`、`B_06_reverse_m30_price_probe.txt` | B 反向证据（非空跑） |
| `B_05_selftest_m30.txt` | 两例 selftest（含 `m30_1slot` FAIL 告警原始输出） |
