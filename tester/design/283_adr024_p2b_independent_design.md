# ADR-024 P2b 独立验收 —— 新增测试**设计报告**

- **本报告自身路径**：`tester/design/283_adr024_p2b_independent_design.md`
- 角色：tester（只验不改生产代码；本批**未** `git add`/`commit`）
- 判据来源：ADR-024 `design/16-backtest-scalability/{01-adr.md D7 修订,03-test-plan.md,04-implementation-plan.md §2 P2b}`；
  worker 交付 `coder/report/adr024_p2b_tryrun_simlive_linearization.md`（自报口径需**独立复核**）；
  tester P2 验收 §9 R2（发现来源）。
- 新增测试（2 个文件，**独立测试二进制**，均自带计数分配器）：

| # | 文件 | 目标路径 | 新增用例数 |
|---|---|---|---|
| 1 | `crates/application/tests/tester_p2b_tryrun_indep.rs` | `application/src/strategy.rs::run_pure_score`（试算 `pure_score`） | 3 |
| 2 | `crates/simlive/tests/tester_p2b_orchestrator_indep.rs` | `simlive/src/plugin_orchestrator.rs::evaluate/feed_bar` | 3 |

> 与 worker 交付的 `crates/{application,simlive}/tests/adr024_p2b_*.rs` **无断言复用**：worker 的两条
> 等价性测试用「warmup=0 + position=None」配置，本设计刻意补 **warmup>0**（试算）与 **position≠None**
> （sim-live）两个覆盖缺口，并加**度量判别力控制组**。

---

## 1. 测试策略（分层）

| 层 | 判据 | 手段 |
|---|---|---|
| 语义等价 | 新路径（前缀切片 + 共享增长式缓冲）与「改造前调用形态」**逐 bar 位级**一致 | 在测试内**复刻 HEAD/staged 的整段流程**（拉取→split→warmup 切片→逐 bar `BarCtx::new(..., bars, None)`），`f64::to_bits` 比较 |
| 无法前视（host 侧） | `ctx.bars.len() == index+1`、`ahead_visible == false`、**逐元素**等于已喂入前缀 | 注入探针 `PluginRuntime`（sim-live）；私有 helper 单测 + 静态单点枚举（试算，见 §4 局限） |
| 零复制机制 | 共享缓冲句柄已注入且**跨 bar 恒等**（`Rc::as_ptr`） | 探针 `ctx.shared_history()` |
| 持仓快照 | `ctx.position.{qty,avg_cost,entry_ts,bars_since_entry,unrealized_pnl}` 逐字段等于改造前公式 | 探针 + 测试内独立复刻 `bars.partition_point` 公式 |
| 分配量 | 每 bar 分配**不随 index 增长**（n 与 2n 比 ≤ 1.25）；且**改造前形态必须线性增长**（≥1.5） | 计数 `GlobalAlloc` 包装 `System`（`alloc+realloc` 字节），窗口内含 `spawn_blocking` 评分线程 |
| 墙钟 | n 翻倍比 ≈ 2（线性），非 ≈ 4 | `Instant`，debug 口径 |

**反向对照（硬要求）**：任何机制类断言必须能被「人为退化」弄红；退化后须**逐字节复原**（sha256 + `git diff` 双证）。

## 2. 用例清单（Given-When-Then）

### 2.1 `tester_p2b_tryrun_indep.rs`

| 用例 | Given | When | Then |
|---|---|---|---|
| `indep_tryrun_warmup_flow_bitwise_vs_prechange_replica` | 120 根 LCG bars，`warmup_bars=30`（`from`=bar[30].ts ⇒ 生效 warmup 30、`slice_start=0`）；插件评分**耦合 `index`/`bar.ts`/`bar.close`/`ma(5)`** | 跑公开入口 `StrategyService::test_run{PureScore}`；同时跑**测试内复刻的 HEAD 整段流程**（同一 split/warmup/slice 算术 + 逐 bar `BarCtx::new(i, bar, &bars_full, None)`） | 逐 bar `ts`/`warmup`/`score.to_bits()` 相等；`bar_count`/`warmup_requested`/`warmup_effective` 相等；`warmup=true` 恰 30 根；distinct scores > 50（非恒定 ⇒ 有鉴别力） |
| `indep_simposition_tryrun_matches_direct_engine` | 120 根，`warmup_bars=30`，脚本化评分插件（先强买 → 观望 → 强卖）；fee 显式三键（`stamp_duty_pct` 取生产缺省 0.05） | `test_run{SimPosition}` vs **直接引擎** `strategy_core::engine::run_ensemble_with_quickjs`（同槽位/阈值/policy/warmup/限额/fee） | 逐 bar `ts`/`warmup`/`aggregate.to_bits()`/`signal` 相等；`trades` JSON 位级相等；断言真实成交（`trades` 非空、`fills>0`）⇒ 非空跑 |
| `indep_alloc_flat_new_path_vs_growing_compat_path` | n=1000/2000/4000 两组：① 新路径（公开入口）② **测试内复刻改造前调用形态**（`BarCtx::new(i, bar, &bars_full, None)`，运行时内部按 `bars[..=i]` 建等价缓冲） | 分别测量每 bar 分配字节与墙钟 | 新路径 ratio(4000/2000) ≤ 1.25；**兼容路径 ratio ≥ 1.5**（度量判别力控制组）；新/兼容绝对量 ≥ 10× |

### 2.2 `tester_p2b_orchestrator_indep.rs`

| 用例 | Given | When | Then |
|---|---|---|---|
| `indep_orchestrator_ctx_prefix_and_position_fields` | 60 根 bars + **持仓脚本**（空仓 0..9 → 建仓 10..24 → 加仓 25..34 → 部分卖出 35..44 → 清仓/硬止损离场 45..49 → 再建仓 50..）；探针 `PluginRuntime` | 逐 bar `feed_bar(code, bar, script[i])` | 每 bar：`index` 对齐、`bars_len == index+1`、`ahead_visible == false`、**`ctx.bars` 与已喂入前缀逐元素相等**、`ctx.bars[index]==ctx.bar`、共享句柄存在且 `Rc::as_ptr` 跨 bar 恒等；`ctx.position` 逐字段 == 测试内独立复刻的改造前公式（含 `bars_since_entry = idx − partition_point(ts < entry_ts)`）；覆盖 null 15 / some 45 |
| `indep_orchestrator_scores_bitwise_vs_prechange_replica_with_positions` | 120 根 + 同一持仓脚本；**3 策略**（权重 1.0/0.5/1.5）；QuickJS 插件评分耦合 `index`/`bar`/**`position` 全 5 字段**/`ma(5)` | 新路径：真实 `PluginStrategyOrchestrator::with_quickjs` + `feed_bar`；复刻：累计 `Vec<Bar>` + 逐 bar `BarCtx::new(idx, bar, &accumulated, snapshot)`（**改造前调用形态**，snapshot 由测试内公式构造） | 360 个 slot 评分 + 聚合分 `to_bits()` 全等、`signal` 全等、`ts` 全等；持仓 bar ≥ 40；distinct > 60 |
| `indep_orchestrator_alloc_flat_vs_growing_compat` | n=2000/4000 两组（新路径 / 改造前调用形态） | 同 2.1 第三例 | 同上（sim-live 侧） |

## 3. Mock / Stub 策略

- 试算：`BacktestBarRead` 内存桩（忽略 from/to 返回整段，用于**精确构造 warmup 切片**）；
  `Clock` 固定；`StrategyStore` 全 `unreachable!` 桩（触达即 panic ⇒ 自证「无 DB / 无 IO」）。
- sim-live：`ProbeRuntime/ProbeInstance`（记录 `ctx` 全字段，返回常数分）；QuickJS 真实实例用于评分比对
  （与生产同 `RuntimeLimits::default()`）。
- 线程局部 `FED`（探针进度镜像）仅用于「逐元素前缀相等」的期望值，**不参与生产路径**。
- 计数分配器：`#[global_allocator]` 包装 `System`；`SERIAL` 互斥使测量窗口内无并发分配；
  夹具构造在窗口外（与 worker 同口径，便于数字对照）。

## 4. 边界与例外

- warmup：`warmup_effective == warmup_requested == 30` 且 flags 恰 30 根 true（含「warmup 段仍评分」语义）。
- 空仓/建仓/加仓/部分卖出/清仓/再建仓 六态 position（含「sticky-first-entry」不前进）。
- 硬止损：**试算路径不可表达**（`run_sim_position` 硬编码 `stop: None`）⇒ 以「持仓区间内离场」在
  sim-live 用例中覆盖 + 引用既有 `m1_1slot_stop` golden 覆盖引擎止损路径（见验收报告 §B 注）。
- 已知验证强度局限（**诚实标注**）：试算路径无法注入探针 `PluginRuntime`
  （`run_pure_score` 内部自建 `QuickJsRuntime`），且 JS `ctx` **不注入 `bars`**（`build_ctx_object` 仅注入
  `index/params/bar/indicators/position/log`）⇒ 「试算路径无前视」只能由 **私有 helper 单测 + 静态单点枚举**
  断言，**不存在集成级运行时探针**。这是机制能力边界，非本批缺陷（验收报告 §A2 局限性、§A4 读法）。
- sim-live 通用：多 slot 同 index 重复调用指标（`OnlineIndicators` 游标对同 index 幂等）已在 3 策略用例覆盖。

## 5. 覆盖率目标

| 项 | 目标 | 实测 |
|---|---|---|
| 位级比较点 | ≥ 2×worker 规模 | 试算 120 bar（score/ts/warmup）+ SimPosition 120 bar（aggregate/signal/trades）；sim-live 120×3=360 slot 分 + 聚合 + signal |
| position 字段覆盖 | 5/5 字段 × 6 态 | ✓（60 bar 逐字段，null 15/some 45） |
| 度量判别力 | 反向控制组必红 | 兼容路径 ratio 1.985（≥1.5）✓ |
| 反向对照 | 每条机制断言可弄红 | R-A/R-A2（试算）/ R-B/R-C（sim-live）✓ |

## 6. 证据

- 绿态原始输出：`tester/evidence/249_adr024_p2b_verify/A2_02_*`、`A2A4_03_*`、`A5_04_*`、`A5_05_*`
- 反向对照：`A2R_A_*`（试算）、`A2R_B_*`（sim-live 无共享句柄）、`A2R_C_*`（sim-live 暴露未来）
- 最终状态复核：`A5_07_final_state_recheck.txt`
- 汇总判词：`tester/report/adr024_p2b_and_m30_golden_verification.md`
