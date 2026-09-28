// fixture: adr029_step1_5_scripted —— 按 bar 序号**硬编码**脚本评分（ADR-029 Step 1.5 Lane A
// 特征化基线 golden 定序用）。序列固定（无 RNG / 无系统时间 / 无参数）：
//   bar 0-2  Buy(80)  → 建仓（ScoreMapped 意图 0.35；Fixed 意图 = 冻结 30%）
//   bar 3-4  Hold(50) → 中立带（Pause 冻结 / Fixed 解冻）
//   bar 5    Sell(30) → 降档（Scaled 意图 0.15；Fixed 意图 0）
//   bar 6-8  Hold(50) → 降档后的中立带
//   bar 9-10 Buy(95)  → 回暖加仓（ScoreMapped 意图 0.4625）
//   bar 11-12 Hold(50)
//   bar 13-15 Sell(0) → 清仓（含尾段）
//   bar 16-17 Buy(95) → 清仓后重建
const SCORES = [80, 80, 80, 50, 50, 30, 50, 50, 50, 95, 95, 50, 50, 0, 0, 0, 95, 95];
function on_bar(ctx) {
  var s = SCORES[ctx.index];
  return s === undefined ? 50 : s;
}
