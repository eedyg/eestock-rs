// =============================================================================
// 参考插件：boll —— BOLL 带突破（mean_reversion 默认 / trend 双模式）
// 迁移自 Rust 内建策略 crates/backtest/src/strategies.rs::BollStrategy（语义 1:1）。
// =============================================================================
//
// 评分映射口径（架构裁决，ADR §6/§13.1）：Buy→80 / Sell→20 / Hold→50。
//   等价性依据：默认聚合阈 60/40 下 80≥60 即 Buy、20≤40 即 Sell、50 即 Hold
//   （守门测试：tests/equivalence.rs）。
//
// 仓位说明：不含 position_pct——仓位换算是 ExecutionPolicy 职责（ADR §13.1）。
//
// 语义注记（与 Rust 版逐条对齐）：
//   - mode：mean_reversion（默认）= 收破下轨 Buy / 收破上轨 Sell（均值回归）；
//           trend = 收破上轨 Buy / 下破下轨 Sell（趋势突破）。
//   - 穿越判定：prev_close 相对**当前** band（上破：prev_close ≤ upper 且 close > upper；
//     下破：prev_close ≥ lower 且 close < lower），一次性信号。
//   - prev_close **无条件每 bar 记录**（含 band 不可用期间），确保 band 首次可用时
//     能检测到「越过 band」的一次性信号（Rust 同口径）。
//   - band 数据不足（boll 返回 null）→ 中立 50（仅记录 prev_close）。
//
// 参数编码注记：ABI §1 的 PARAMS_SCHEMA 仅支持 int/float，Rust 版的 Choice 参数
//   mode 在此编码为 int：0 = mean_reversion（默认）/ 1 = trend；缺省按 0 处理。
//
// 内部状态（ABI G3）：prevClose 模块级变量，经 save()/load() 快照/恢复。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "period", type: "int", default: 20, min: 2, max: 200, description: "周期" },
  { key: "k", type: "float", default: 2.0, min: 0.5, max: 4.0, description: "标准差倍数" },
  { key: "mode", type: "int", default: 0, min: 0, max: 1, description: "模式：0=mean_reversion（默认，均值回归）/ 1=trend（趋势突破）" }
];

// 上一 bar 收盘价；null = 首根之前（对应 Rust prev_close: Option<f64>）。
let prevClose = null;

function init(params) {
  prevClose = null;
}

function on_bar(ctx) {
  const close = ctx.bar.close;
  let score = 50;
  const b = ctx.indicators.boll(ctx.params.period, ctx.params.k);
  if (b !== null) {
    const crossedUp = prevClose !== null && prevClose <= b.upper && close > b.upper;
    const crossedDown = prevClose !== null && prevClose >= b.lower && close < b.lower;
    if (ctx.params.mode === 1) {
      // trend：收破上轨 Buy / 下破下轨 Sell。
      if (crossedUp) {
        score = 80;
      } else if (crossedDown) {
        score = 20;
      }
    } else {
      // mean_reversion（默认；mode 缺省/0）：收破下轨 Buy / 收破上轨 Sell。
      if (crossedDown) {
        score = 80;
      } else if (crossedUp) {
        score = 20;
      }
    }
  }
  prevClose = close; // 无条件记录（Rust 同口径）
  return score;
}

function save() {
  return { prevClose: prevClose };
}

function load(state) {
  prevClose = (state && typeof state.prevClose === "number") ? state.prevClose : null;
}
