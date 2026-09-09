import { useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { StrategyCatalogEntry, WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
import { fmtHoldBars, fmtMoney, fmtPct, fmtRatio, fmtTs, periodLabel } from '@/features/backtest/format';
import { KlineResultChart } from './KlineResultChart';
import { AggregateScoreChart } from './AggregateScoreChart';
import { SlotScoresChart } from './SlotScoresChart';
import { EquityDrawdownChart } from './EquityDrawdownChart';
import { PerBarTable } from './PerBarTable';
import { EventLog } from './EventLog';

type TabKey = 'trades' | 'metrics' | 'perbar' | 'events';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'trades', label: '交易明细' },
  { key: 'metrics', label: '8项绩效' },
  { key: 'perbar', label: '逐bar评分' },
  { key: 'events', label: '事件日志' },
];

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '完成',
  failed: '失败',
  canceled: '已取消',
};

/** 8 项绩效表（口径由后端 strategy-core 锁定，前端只读展示）。 */
function MetricsTable({ result }: { result: WorkbenchRunResult }) {
  const m = result.metrics;
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'net_profit', label: 'net_profit（净盈亏）', value: fmtMoney(m.net_profit) },
    { key: 'max_drawdown', label: 'max_drawdown（最大回撤）', value: fmtPct(m.max_drawdown) },
    { key: 'sharpe', label: 'sharpe（夏普）', value: fmtRatio(m.sharpe) },
    { key: 'win_rate', label: 'win_rate（胜率）', value: fmtPct(m.win_rate) },
    { key: 'profit_factor', label: 'profit_factor（盈亏比）', value: fmtRatio(m.profit_factor) },
    { key: 'annualized_return', label: 'annualized_return（年化）', value: fmtPct(m.annualized_return) },
    { key: 'trade_count', label: 'trade_count（交易数）', value: String(m.trade_count) },
    { key: 'avg_hold_bars', label: 'avg_hold_bars（平均持仓）', value: fmtHoldBars(m.avg_hold_bars) },
  ];
  return (
    <table className="w-full border-collapse text-xs" data-testid="wb-metrics-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-line/40">
            <td className="px-2 py-1.5 text-dim">{r.label}</td>
            <td className="num px-2 py-1.5 text-right">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 交易明细表（TradeDetail jsonb 只读）。 */
function TradesTable({ result }: { result: WorkbenchRunResult }) {
  if (result.trades.length === 0) {
    return <div className="p-3 text-xs text-dim" data-testid="wb-trades-table">无成交</div>;
  }
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-xs" data-testid="wb-trades-table">
        <thead>
          <tr className="border-b border-line text-left text-[11px] text-dim">
            <th className="px-2 py-1 font-normal">开仓</th>
            <th className="px-2 py-1 font-normal">平仓</th>
            <th className="px-2 py-1 font-normal">开价</th>
            <th className="px-2 py-1 font-normal">平价</th>
            <th className="px-2 py-1 font-normal">股数</th>
            <th className="px-2 py-1 font-normal">盈亏</th>
            <th className="px-2 py-1 font-normal">持仓</th>
          </tr>
        </thead>
        <tbody>
          {result.trades.map((t, i) => (
            <tr key={i} className="border-b border-line/40" data-testid={`wb-trade-row-${i}`}>
              <td className="num px-2 py-1 text-dim">{fmtTs(t.open_ts)}</td>
              <td className="num px-2 py-1 text-dim">{fmtTs(t.close_ts)}</td>
              <td className="num px-2 py-1">{t.open_price.toFixed(3)}</td>
              <td className="num px-2 py-1">{t.close_price.toFixed(3)}</td>
              <td className="num px-2 py-1">{t.shares.toLocaleString('zh-CN')}</td>
              <td className={`num px-2 py-1 ${t.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(t.pnl)}</td>
              <td className="num px-2 py-1 text-dim">{fmtHoldBars(t.hold_bars)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 结果视图（ADR §13.5 布局定稿）：
 * K线+买卖标记（含硬止损 ⊗）/ 总分曲线（阈值线+三区着色）/ 各策略评分曲线（图例开关默认前 3）/
 * 净值+回撤 / Tab（交易明细 | 8项绩效 | 逐bar评分表 | 事件日志）。
 * 三态：未选中占位 / loading 骨架 / 错误+重试；失败 run 显示 error；非终态显示状态提示。
 */
export function ResultView({
  run,
  result,
  loading,
  error,
  onRetry,
  api,
  catalog,
  progressMap,
}: {
  run: WorkbenchRunView | null;
  result: WorkbenchRunResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  api: ApiClient;
  catalog: StrategyCatalogEntry[] | null;
  /** WS strategy_run_progress 增量（run_id → 进度），头部进度叠加覆盖 REST 行进度（与 RunList 同模式）。 */
  progressMap?: Record<string, { progress: number; barTs: string | null }>;
}) {
  const [tab, setTab] = useState<TabKey>('trades');

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-dim" data-testid="wb-result-empty">
        选择左侧已完成运行查看结果（或勾选 2-4 个运行进入对比）
      </div>
    );
  }

  // 头部进度叠加：WS progressMap 优先，REST 行进度兜底（与 RunList 行进度同口径）
  const progressPct = Math.round((progressMap?.[run.id]?.progress ?? run.progress) * 100);

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3" data-testid="wb-result">
      {/* 头部：run 概要 + 状态/错误 */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="text-sm text-txt" data-testid="wb-run-title">
          {run.name || run.id}
        </span>
        <span className="text-dim">
          {run.symbol} · {periodLabel(run.period)} · {STATUS_LABEL[run.status] ?? run.status} ·{' '}
          <span data-testid="wb-run-progress">进度 {progressPct}%</span>
        </span>
      </div>
      {run.status === 'failed' && (
        <div className="rounded-lg border border-up/40 bg-up/10 px-2 py-1 text-xs text-up" role="alert" data-testid="wb-run-error">
          运行失败：{run.error ?? '未知错误'}
        </div>
      )}

      {error ? (
        <div className="flex items-center gap-3 text-xs text-up" data-testid="wb-result-error">
          <span>结果加载失败：{error}</span>
          <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
            重试
          </button>
        </div>
      ) : loading ? (
        <div className="flex h-40 items-center justify-center" data-testid="wb-result-skeleton">
          <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
        </div>
      ) : run.status === 'succeeded' && result ? (
        <>
          <KlineResultChart run={run} result={result} api={api} />
          <AggregateScoreChart
            perBar={result.per_bar}
            buyThreshold={run.config.buy_threshold}
            sellThreshold={run.config.sell_threshold}
          />
          <SlotScoresChart perBar={result.per_bar} slots={run.config.slots} catalog={catalog} />
          <EquityDrawdownChart netValue={result.net_value} drawdown={result.drawdown} />
          <div className="rounded-lg border border-line bg-panel2">
            <div className="flex gap-1 border-b border-line px-2 pt-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`rounded-t px-3 py-1 text-xs ${tab === t.key ? 'bg-panel text-txt' : 'text-dim hover:text-txt'}`}
                  onClick={() => setTab(t.key)}
                  data-testid={`wb-tab-${t.key}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="p-2">
              {tab === 'trades' && <TradesTable result={result} />}
              {tab === 'metrics' && <MetricsTable result={result} />}
              {tab === 'perbar' && <PerBarTable perBar={result.per_bar} slotCount={run.config.slots.length} />}
              {tab === 'events' && <EventLog perBar={result.per_bar} />}
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-40 items-center justify-center text-xs text-dim" data-testid="wb-result-pending">
          {run.status === 'canceled'
            ? '运行已取消（无结果）'
            : run.status === 'failed'
              ? '运行失败（无结果）'
              : `运行${STATUS_LABEL[run.status] ?? run.status}…进度 ${progressPct}%`}
        </div>
      )}
    </div>
  );
}
