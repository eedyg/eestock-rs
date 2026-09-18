# ADR-024 P1b — 增量落盘 STATUS（到点前防截断；判词在最前）

> 本文件路径：`tester/evidence/242_adr024_baseline_extension/STATUS.md`
> 写入时刻 UTC `2026-09-17T16:36Z`（engine_commit `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`，HEAD 未改）
> 原因：架构师 steer（~16:35Z）提示本 run 约 16:49Z 触发硬上限 ⇒ 先把已完成结论落盘。

---

## 判词（先看这里）

| # | 项 | 判词 | 证据 |
|---|---|---|---|
| ① | 持仓台账派生序列（P2 前硬依赖） | **完成**。11/11 例的 `derived`（ledger/position/trades_replay）已补进**改造前**冻结基线；A 层**位级**比较 11/11 PASS（96,648 个叶节点）；自证「由 fills+fee 反解台账能逐笔回放 trades」**11/11 PASS 且 dev>0 = 0（位级完全一致）**；`result` payload_sha256 **逐例未变**（证明只在基线里**新增**派生序列，未扰动既有期望值） | `242_.../compare_p1b_report.txt`、`242_.../freeze_p1b.log`、`242_.../pre_ledger/payload_sha256_{before,after}.txt` |
| ② | B 层容差 `max(1e-12, 1e-9×|expected|)` + 逐字段枚举 | **完成**。判据改为绝对值下限 **1e-12**（字面实现 `abs ≤ max(1e-12, 1e-9×|expected|)`）；比对器新增 **B′ 全量枚举**（所有 `dev>0` 条目逐条列出 `field/expected/actual/abs/rel/verdict/old_verdict`，禁止只给全局 max）；重跑 11 例 **仍全 PASS**，`dev>0` 条目 **0**，**收紧引入的新 FAIL = 0** | `242_.../compare_p1b_report.txt`、`242_.../tolprobe.txt`、`240_.../sensitivity/*_selftest.txt` |
| ③ | 指标重插件曲线 ⇒ P3 必要性 | **量级结论已成立**（矩阵按 steer 收窄为 5k/20k/50k/200k × 1 slot；3 slots 与全矩阵**主动放弃**）。重插件（每 bar `macd()+rsi(14)+atr(14)`）相对 `dual_ma` 在同 n 的**额外倍率**：**6.8× (5k) → 11.7× (20k) → 13.3× (50k) → 15.36× (200k)**；`t/n²` 收敛到 **5.99e-9 s/bar²**，是 `dual_ma` 的 **a=3.70e-10** 的 **16.2×** ⇒ **存在第三个二次项，且系数 ≈ 15× 「每 bar 上下文构造 + 历史复制」项**。**局部斜率仍 ≈1.96–2.00（未 >2.2）**—— 斜率不是本项的判别器（复制项本身已是二次，叠加二次项不改变渐近斜率），判别器是 `t/n²` 收敛值与倍率。**P3 结论：不能不做**（对使用 macd/rsi/atr/ema 的插件，P2 只消掉 1/16 的二次项） | `242_.../raw_heavy_plugin.txt`（含环境元数据 + 逐次 `/usr/bin/time -v` 原始输出） |
| ④ | 耗时口径分解（生产路径副本） | **完成核心判别（副本归因）**。n=3250/dual_ma：引擎 **15 ms** / jsonb 全链 **24 ms** / **进度写库 3,294 ms（1001 帧，avg 3.29 ms）** ⇒ full 副本 **979 bars/s**；n=1402 full=**466 bars/s**（n 越小 bars/s 越低 ⇒ 固定成本）。**结论：生产 ~1,600 bars/s 的主因是「每 run 固定 ~1,001 次进度 UPDATE」，不是引擎/jsonb/插件** | `243_.../raw_replica.txt` |
| ⑤ | 预估算子标定 | **完成（负结果，重要）**。N=374 真 run：`dur ~ bars` **R²=0.0007**（≈不相关）；`dur ~ min(1001,bars)` R²=**0.2773**，分档中位吻合（74/549/855/866 ms vs 预测 90/733/1225/1227）⇒ **`µs/bar` 形式的过渡期算子不可用**，必须含「每 run 固定项」 | `243_.../calibration/{runs_prod.csv,fit.txt}` |
| ⑥ | M30 用例 ×2 | **`BLOCKED: 待 P0`**。`crates/backtest/src/types.rs::Period` **无 `M30` 变体**（仅 `application::bar_map.rs:43` 有 M30 的 `warmup_lookback` 分支）；未自行改生产代码绕过 | `grep -n M30 crates/backtest/src/types.rs` = 无命中 |

---

## ③ 的原始点（中位，本轮实测）

| n | heavy 中位 wall_s | dual_ma(P1 同机同 commit) | 倍率 | heavy t/n² |
|---|---|---|---|---|
| 5,000 | 0.164（3 次：0.163/0.166/0.164） | 0.0240 | 6.8× | 6.56e-9 |
| 20,000 | 2.425（2.424/2.425/2.433） | 0.2070 | 11.7× | 6.06e-9 |
| 50,000 | 14.993（14.985/14.993/15.010） | 1.1270 | 13.3× | 6.00e-9 |
| 200,000 | 239.52（239.680/239.363 —— **第 3 次重复被主动终止**以让路 ④⑤） | 15.5840 | 15.36× | 5.99e-9 |

- 3 slots 与 200k×3 slots 点：**未跑**（按 steer 主动放弃，`run_heavy.sh` 中对应段落保留可续跑）。
- `raw_heavy_plugin.txt` 末尾**无** `[EXIT]`（最后一次重复被 operator 终止）——文件未被修改，标注在此。
- 已知观测瑕疵（不影响结论，已备案）：`scale` 子命令的 POINT 行 `plugin=` 字段对 `--plugin-file` 场景仍打印默认 `dual_ma`（harness 标签 bug，与真实插件无关；本文件头部记录了插件文件路径与 sha256，`tag=heavy_*` 亦已区分）。

## ④⑤ 已补跑（本文件写入后 10 分钟内完成；判词见上表）

- ④ 12 档全部 exit 0；写库只在**测试库**（run_id 前缀 `sr_adr024p1b_`）。
- ⑤ 只读导出 + 纯 python 回归（numpy 在本机不可用 ⇒ 闭式 OLS）。
- ③ 仍缺：3 slots 与 200k×3 slots（按 steer 主动放弃）。

## 未完成项与续跑入口

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
# ③ 补齐 3 slots（可选）
bash tester/evidence/242_adr024_baseline_extension/run_heavy.sh
# ④ 生产路径副本（测试库；绝不写生产库）
CARGO_TARGET_DIR=$PWD/target cargo build --offline --release --manifest-path tester/harness/adr024_replica/Cargo.toml
EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/eestock_test' \
  ./target/release/adr024_replica --bars-file tester/evidence/241_adr024_scale_curve/data/m1_200k.jsonl \
  --limit 3250 --slots 1 --stage engine --tag rep_engine_dual_ma
# ⑤ 标定样本（只读）
bash tester/evidence/243_adr024_attribution/calibration/export_runs.sh
```
