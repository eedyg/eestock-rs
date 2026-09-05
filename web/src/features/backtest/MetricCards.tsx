import type { Metrics } from '@/api/types';
import { deltaClass, formatAvgHold, fmtMoney, fmtPct, fmtRatio } from './format';

interface MetricCardDef {
  key: keyof Metrics;
  label: string;
  deco: (m: Metrics) => string;
  cls?: (m: Metrics) => string;
}

const METRIC_DEFS: MetricCardDef[] = [
  { key: 'net_profit', label: 'Net Profit', deco: (m) => fmtMoney(m.net_profit), cls: (m) => deltaClass(m.net_profit) },
  { key: 'max_drawdown', label: 'Max Drawdown', deco: (m) => fmtPct(m.max_drawdown), cls: () => 'text-down' },
  { key: 'sharpe', label: 'Sharpe', deco: (m) => fmtRatio(m.sharpe) },
  { key: 'win_rate', label: '胜率', deco: (m) => fmtPct(m.win_rate) },
  { key: 'profit_factor', label: '盈亏比', deco: (m) => fmtRatio(m.profit_factor) },
  { key: 'annualized_return', label: '年化', deco: (m) => fmtPct(m.annualized_return), cls: (m) => deltaClass(m.annualized_return) },
  { key: 'trade_count', label: '总交易数', deco: (m) => String(m.trade_count) },
  { key: 'avg_hold_bars', label: '平均持仓', deco: (m) => formatAvgHold(m.avg_hold_bars) },
];

/**
 * 页面⑤指标卡（8 项绩效，口径 08-backtest §6 由后端单测锁定，前端只读）。
 * 三态：骨架卡 / 随 result-overview / 错误占位+重试。
 */
export function MetricCards({
  metrics,
  loading,
  error,
  onRetry,
}: {
  metrics: Metrics | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="flex w-full items-center gap-3 p-2 text-xs text-up">
        <span>指标加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading || !metrics) {
    return (
      <div className="flex h-full flex-1 gap-2">
        {METRIC_DEFS.map((d) => (
          <div key={d.key} className="flex-1 animate-pulse rounded-lg border border-line bg-panel2 p-3" data-testid={`metric-skeleton-${d.key}`}>
            <div className="h-3 w-12 rounded bg-white/10" />
            <div className="mt-2 h-5 w-16 rounded bg-white/15" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-1 gap-2">
      {METRIC_DEFS.map((d) => (
        <div key={d.key} className="flex-1 rounded-lg border border-line bg-panel2 p-3" data-testid={`metric-card-${d.key}`}>
          <div className="text-[11px] text-dim">{d.label}</div>
          <div className={`num mt-1 text-[15px] ${d.cls ? d.cls(metrics) : 'text-txt'}`}>{d.deco(metrics)}</div>
        </div>
      ))}
    </div>
  );
}
