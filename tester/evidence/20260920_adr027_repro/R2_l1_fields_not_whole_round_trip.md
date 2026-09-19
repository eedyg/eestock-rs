# R2 证据 — L1 的 `commission`/`stamp_duty`/`gross_value` 不是全回合加总

- **文件位置**：`tester/evidence/20260920_adr027_repro/R2_l1_fields_not_whole_round_trip.md`
- **判词**：🔴 **红**（复现成立：三字段全部不为全回合加总，现口径只覆盖末笔卖出）
- **批次**：20260920_adr027_repro
- **commit**：`0fdd83e`（工作区含本批次新增测试文件，未提交）
- **时间（UTC）**：2026-09-19T14:45Z
- **被测代码（只读）**：`crates/strategy-core/src/engine.rs:877-892`（清仓合成：`gross_value = exec.trade_value`；
  `commission = h.buy_commission + exec.commission`；`stamp_duty = exec.stamp_duty`）与 `:896-901`（部分卖出仅摊薄、无台账）
- **契约事实源**：`02-spec.md` §1.2/§2 与恒等式 I1/I2；判据出处：`03-test-plan.md` §1 R2；裁决：`ADR-027` §2.2 D1

## 1. 可执行命令

```bash
cargo test -p strategy-core --test adr027_repro -- --exact \
  r2_l1_amount_fields_are_not_whole_round_trip_sums
```

测试文件：`crates/strategy-core/tests/adr027_repro.rs`。
原始输出全文：`tester/evidence/20260920_adr027_repro/raw/r2_l1_amount_fields_are_not_whole_round_trip_sums.txt`

## 2. 构造

与 R1 同一 run（同一 helper，价序 `10,10,10,10,12,12,11,11`、capital 100_000、LumpSum pct 0.5、默认 FeeModel），
成交序列：`bar1` 买 5000.0 股@10.002 → `bar5` 部分卖 417.60427083333343 股@11.9976 → `bar7` 清 4582.395729166667 股@10.9978。

期望值（02-spec §2 全回合口径，由 fills 的 `(qty, price)` 经 `FeeModel` 逐笔复算——**仅作测试 oracle**，
不改变生产「禁止下游复算」的 D4 红线）：

| 字段 | 期望（全回合） | 实际（L1） | Δ |
|---|---|---|---|
| `gross_value` | `Σ_sell trade_value` = 55406.520749979165 | 50396.27175022916 | **−5010.2489997500015** |
| `commission` | `Σ_buy commission + Σ_sell commission` = 30.101567937557288 | 24.057348458338538 | **−6.04421947921875** |
| `stamp_duty` | `Σ_sell stamp_duty` = 27.703260374989583 | 25.19813587511458 | **−2.505124499875002** |

## 3. 原始输出片段（逐字）

```text
running 1 test
test r2_l1_amount_fields_are_not_whole_round_trip_sums ... FAILED

---- r2_l1_amount_fields_are_not_whole_round_trip_sums stdout ----

thread 'r2_l1_amount_fields_are_not_whole_round_trip_sums' (1604782) panicked at crates/strategy-core/tests/adr027_repro.rs:234:5:
R2：L1 金额字段必须 == 全回合加总（02-spec §2），实得 3 项不符:
  L1.gross_value: 全回合期望 55406.520749979165，实际 50396.27175022916（Δ = -5010.2489997500015）
  L1.commission: 全回合期望 30.101567937557288，实际 24.057348458338538（Δ = -6.04421947921875）
  L1.stamp_duty: 全回合期望 27.703260374989583，实际 25.19813587511458（Δ = -2.505124499875002）

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

**断言失败的具体行**：`crates/strategy-core/tests/adr027_repro.rs:234`（三项 Δ 一次性汇总断言，避免首项遮蔽）。

## 4. 该结果证明了什么

1. **三字段各自红，且 Δ 有精确物理解释**（三者互证，缺一不可）：
   - `gross_value` Δ `= −5010.249` **恰等于部分卖出那一笔的 `trade_value`**（`417.60427083333343 × 11.9976 = 5010.2489997500015`）
     ⇒ 现口径的 `gross_value` **只覆盖末笔卖出**（F2 实测证实）。
   - `stamp_duty` Δ `= −2.505124…` **恰等于部分卖出那一笔的印花税**（`5010.249 × 0.05% = 2.505124…`）
     ⇒ 漏掉的是部分卖出的印花税。
   - `commission` Δ `= −6.044219…` = 部分卖出那一笔的佣金 `5.0`（最低佣金分支）**+** 买入佣金被按比例摊薄掉的差额 `1.044219…`
     （`buy_commission 12.5025 × ratio 0.0835208… = 1.044219…`）⇒ **既漏笔、又错摊**（部分卖出把买入佣金也摊走，而它本应计入全回合）。
2. 因此 ADR-027 §1.1 F2「L1 的金额字段只覆盖末笔卖出」与 §1.2「Σ L2 == L1 在当前 L1 定义下不可能成立」**由实测取证成立**。
3. 恒等式 I1（`Σ_fills 逐字段 == RT 字段`）与 I2（UI 末行累计 == L1 行）在当前实现下**必然失败**（本测试即其反例）。

## 5. 该结果**未**证明什么

- 未证明 `/result` 端点 jsonb 落库后的字段值（策略层测试不触存储/HTTP；端点口径变更属 C 段契约测试）；
- 未证明 `avg_price`/`open_price` 双口径（D9，L2 列集）相关的任何行为——本测试只碰三个金额字段；
- 未证明「部分卖出漏记」在**多标的 sim-live**侧的表现（R3/R4 另有取证）；
- 未证明绩效指标口径变更幅度（`03-test-plan` U8 段，本批次不做）。

## 6. 构造方式的不确定性

1. **oracle 采用逐笔复算**（`trade_value = qty × price`，再经 `FeeModel::commission/stamp_duty`）。
   该复算在**本构造**下与原实现逐位一致，理由是分支判定：
   买腿 `trade_value ≈ 50010 × 0.025% = 12.5025 > 5` ⇒ 比例分支（`commission = tv × 0.025%`，可逆）；两笔卖腿均 `< 20000` ⇒ 最低佣金分支（`commission = 5.0`，可逆）。
   但 **ADR-027 §1.1 F10 的一般性结论（最低佣金分支「先减后除」不可逆）在本测试中未被触达**——
   本构造不能证明「复算在生产中不可用」，只能证明「本场景下 oracle 成立」。
   （生产侧仍必须按 D4 由撮合点写入，本报告不以此 oracle 质疑 D4。）
2. 与 R1 同一处构造限制：字面 `买100/部分卖50/清50` 经公开 API 不可达（原因见 `R1_partial_sell_pnl.md` §6），
   本用例用同形态、不同量级的序列；Δ 的**物理归因**（分别等于部分卖的 trade_value / stamp / commission+摊薄差额）
   与股数无关，是口径事实。
3. 断言容差 `1e-9` 为测试内显式声明（02-spec 未规定该字段容差；Δ 量级 5.0/6.0 远超容差 ⇒ 判决不受容差选择影响）。

## 7. 纪律声明

- 未修改任何生产代码（`crates/**/src/**` 零改动）；未尝试修复失败；未做永久性插桩。
- 失败归因判断交父级；本报告只给观测与量值。
