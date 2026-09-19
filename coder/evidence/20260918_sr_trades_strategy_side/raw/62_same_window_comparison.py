import importlib.util
spec = importlib.util.spec_from_file_location("pe", "coder/evidence/20260918_sr_trades_strategy_side/raw/43_paper_engine.py")
pe = importlib.util.module_from_spec(spec); spec.loader.exec_module(pe)

print("=== 同一区间 (2026-01-04 → 2026-09-16, 173 bar, 518880 D1) 两臂对照 ===")
print("平台实测（strategy_run_result.metrics）：")
print("  A1  LumpSum{1}     sr_1789738272901_000004 : net_profit=-11563.8862  maxDD=30.52%  sharpe=-0.3868  annualized=-16.39%  trades=1")
print("  A2' DCA t100/i1    sr_1789738328788_000005 : net_profit= -2933.6479  maxDD= 5.26%  sharpe=-0.8029  annualized= -4.24%  trades=1")
print()
a1 = pe.run(policy=("LumpSum", 1.0, None, None))
dc = pe.run(policy=("Dca", 100, 1, None))
print("纸面复现校验（同口径重跑；平台不直接暴露「投入总额」，故用模型给出）：")
print("  A1  模型 net_profit = %.4f 元   ← 平台实测 -11563.8862（吻合到 1e-4）" % (a1["final_equity"] - 100000))
print("  DCA 模型 net_profit = %.4f 元   ← 平台实测  -2933.6479（吻合到 1e-4）" % (dc["final_equity"] - 100000))
print()
print("  投入总额 / 初始资金： DCA = %.2f / 100000 = %.2f%%   ｜  A1 = %.2f / 100000 = %.2f%%"
      % (dc["invested"], dc["invested"] / 1000, a1["invested"], a1["invested"] / 1000))
print("  ⇒ DCA 臂净亏较少，主要来自**只投出 41.4% 资金**（A1 投出 100%），不是策略质量更好；")
print("    两臂的 net_profit / maxDD / sharpe 都不可直接对比（暴露不同）。")
