import { useState } from 'react';
import type {
  BacktestStrategyDto,
  SimOrder,
  SimSessionDetail,
  SimSessionListEntry,
  SimStateDto,
  SimStrategiesDto,
  SymbolSnapshot,
} from '@/api/types';

/** 会话控制：状态 pill + 账户 KPI + 统一交易开关 + MCP 状态/停用按钮 + 停止/开始会话。
 *  未运行态额外展示「配置会话」面板：标的 multi-select + 策略 multi-select + 名称/周期/初始资金。 */
export function SessionControl({
  state,
  starting,
  stopping,
  togglingTrading,
  togglingMcp,
  symbols,
  strategies,
  onStart,
  onStop,
  onToggleTrading,
  onToggleMcp,
}: {
  state: SimStateDto;
  starting: boolean;
  stopping: boolean;
  togglingTrading: boolean;
  togglingMcp: boolean;
  symbols: SymbolSnapshot[];
  strategies: BacktestStrategyDto[];
  onStart: (p: { name: string; period: string; cash_init?: number; stock_set?: string[]; strategy_set?: string[] }) => void;
  onStop: () => void;
  onToggleTrading: (enabled: boolean) => void;
  onToggleMcp: (enabled: boolean) => void;
}) {
  const active = state.active && state.session?.status === 'running';
  // 配置会话（未运行态可编辑；选中集以 chips 呈现）。
  const [name, setName] = useState('手动会话');
  const [period, setPeriod] = useState('M1');
  const [cashInit, setCashInit] = useState('1000000');
  const [selectedStocks, setSelectedStocks] = useState<Set<string>>(new Set());
  const [selectedStrategies, setSelectedStrategies] = useState<Set<string>>(new Set());
  const [configError, setConfigError] = useState<string | null>(null);

  const toggleStock = (code: string) =>
    setSelectedStocks((prev) => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  const toggleStrategy = (id: string) =>
    setSelectedStrategies((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const start = () => {
    if (starting) return;
    if (selectedStocks.size === 0) {
      setConfigError('请选择至少一个标的');
      return;
    }
    if (selectedStrategies.size === 0) {
      setConfigError('请选择至少一个策略');
      return;
    }
    setConfigError(null);
    const cash = Number(cashInit);
    onStart({
      name: name.trim() || '手动会话',
      period,
      cash_init: Number.isFinite(cash) && cash > 0 ? cash : undefined,
      stock_set: Array.from(selectedStocks),
      strategy_set: Array.from(selectedStrategies),
    });
  };

  const fmt = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // KPI 项：label + 数值（等宽数字，复用 token 涨跌色）。
  const kpi = (label: string, value: string, testid: string, tone = 'text-[--txt]') => (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-[--dim]">{label}</span>
      <strong data-testid={testid} className={`num text-base ${tone}`}>{value}</strong>
    </div>
  );
  const chipCls = (on: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs ${on ? 'border-[--acc1] text-[--acc1]' : 'border-[--line] text-[--dim]'}`;
  const stockChip = (s: SymbolSnapshot) => (
    <button
      key={s.code}
      type="button"
      data-testid={`sim-config-stock-${s.code}`}
      data-on={selectedStocks.has(s.code)}
      className={chipCls(selectedStocks.has(s.code))}
      onClick={() => toggleStock(s.code)}
    >{s.code} {s.name !== s.code ? s.name : ''}</button>
  );
  const strategyChip = (st: BacktestStrategyDto) => (
    <button
      key={st.id}
      type="button"
      data-testid={`sim-config-strategy-${st.id}`}
      data-on={selectedStrategies.has(st.id)}
      className={chipCls(selectedStrategies.has(st.id))}
      onClick={() => toggleStrategy(st.id)}
      title={st.description}
    >{st.name}</button>
  );
  return (
    <div className="flex flex-col gap-4">
      {/* KPI 行 1：会话状态 pill + 账户指标 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[--dim]">会话状态</span>
          <span
            data-testid="sim-session-status"
            className={`inline-flex items-center gap-2 rounded-full border border-line bg-white/5 px-3 py-1 text-xs ${active ? 'text-[--up]' : 'text-[--dim]'}`}
          >
            <span className={active ? 'dot-live' : 'dot-idle'} />
            {active ? `运行中 · ${state.session?.id}` : '未运行'}
          </span>
        </div>
        {kpi('总资产', state.account ? `¥ ${fmt(state.account.equity)}` : '—', 'sim-equity')}
        {kpi('可用资金', state.account ? `¥ ${fmt(state.account.cash)}` : '—', 'sim-cash')}
        {kpi('已实现盈亏', state.account ? `¥ ${fmt(state.account.realized_pnl)}` : '—', 'sim-realized', 'text-[--up]')}
        {kpi('未实现盈亏', state.account ? `¥ ${fmt(state.account.unrealized_pnl)}` : '—', 'sim-unrealized', 'text-[--up]')}
      </div>

      {/* KPI 行 2：统一交易开关 + MCP 状态/停用 + 流程/操作 */}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <span className="text-[--dim]">统一交易开关</span>
          <input
            type="checkbox"
            data-testid="sim-trading-toggle"
            checked={state.trading_enabled}
            disabled={togglingTrading || !active}
            onChange={(e) => onToggleTrading(e.target.checked)}
          />
          <span className={state.trading_enabled ? 'text-[--down]' : 'text-[--dim]'}>{state.trading_enabled ? '开' : '关'}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[--dim]">MCP sim_* 服务</span>
          <span data-testid="sim-mcp-status" className={state.mcp_enabled ? 'text-[--down]' : 'text-[--dim]'}>
            {state.mcp_enabled ? '运行中' : '已停用'}
          </span>
          <button
            type="button"
            data-testid="sim-mcp-toggle"
            disabled={togglingMcp}
            onClick={() => onToggleMcp(!state.mcp_enabled)}
          >{state.mcp_enabled ? '停用' : '启用'}</button>
        </label>
        <button
          type="button"
          data-testid="sim-start-button"
          disabled={active}
          onClick={start}
        >{active ? '运行中' : '开始会话'}</button>
        <button
          type="button"
          data-testid="sim-stop-button"
          disabled={stopping || !active}
          onClick={onStop}
        >停止会话</button>
      </div>

      {/* 配置会话（未运行态）：标的/策略 multi-select chips + 名称/周期/初始资金。 */}
      {!active && (
        <div data-testid="sim-session-config" className="rounded border border-[--line] p-3">
          <div className="mb-2 text-[11px] text-[--dim]">配置会话（选择标的/策略后开始）</div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs">
              <span className="text-[--dim]">名称</span>
              <input
                data-testid="sim-config-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-28 rounded border border-line bg-transparent px-2 py-1 text-xs"
              />
            </label>
            <label className="flex items-center gap-1 text-xs">
              <span className="text-[--dim]">周期</span>
              <select
                data-testid="sim-config-period"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="rounded border border-line bg-transparent px-2 py-1 text-xs"
              >
                <option value="M1">1m</option>
                <option value="M5">5m</option>
                <option value="M15">15m</option>
                <option value="D1">日</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs">
              <span className="text-[--dim]">初始资金</span>
              <input
                data-testid="sim-config-cash"
                value={cashInit}
                onChange={(e) => setCashInit(e.target.value)}
                className="w-24 rounded border border-line bg-transparent px-2 py-1 text-xs"
              />
            </label>
          </div>
          <div className="mt-2">
            <div className="text-[11px] text-[--dim]">标的（multi-select）</div>
            <div className="flex flex-wrap gap-2">{symbols.map(stockChip)}</div>
          </div>
          <div className="mt-2">
            <div className="text-[11px] text-[--dim]">策略（multi-select；默认参数）</div>
            <div className="flex flex-wrap gap-2">{strategies.map(strategyChip)}</div>
          </div>
          {configError && (
            <div data-testid="sim-config-error" className="mt-2 text-xs text-[--down]">{configError}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 持仓表（现价=本系统行情，数量/成本=模拟账户）。 */
export function PositionTable({ positions }: { positions: SimStateDto['positions'] }) {
  if (positions.length === 0) return <div data-testid="sim-positions-empty">无持仓</div>;
  return (
    <table data-testid="sim-position-table">
      <thead><tr><th>code</th><th>名称</th><th>数量</th><th>成本价</th><th>现价</th><th>市值</th><th>浮动盈亏</th></tr></thead>
      <tbody>
        {positions.map((p) => (
          <tr key={p.code}>
            <td data-testid="sim-position-code">{p.code}</td>
            <td>{p.code}</td>
            <td>{p.qty.toLocaleString()}</td>
            <td>{p.avg_cost.toFixed(3)}</td>
            <td>{p.latest.toFixed(3)}</td>
            <td>{p.market_value.toLocaleString()}</td>
            <td className={p.unrealized_pnl >= 0 ? 'text-[--up]' : 'text-[--down]'}>{p.unrealized_pnl.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 3 策略独立评估（当前最强标的/分）。 */
export function StrategyPanel({ strategies }: { strategies: SimStrategiesDto['strategies'] }) {
  if (strategies.length === 0) return <div data-testid="sim-strategies-empty">未启动会话</div>;
  return (
    <div data-testid="sim-strategy-panel" className="flex flex-wrap gap-3">
      {strategies.map((s) => (
        <div key={s.strategy_id} className="rounded border border-[--line] p-3">
          <h4>{s.name}</h4>
          <div className="text-[--dim]">当前最强：
            {s.strongest ? (
              <strong data-testid={`sim-strategy-strongest-${s.strategy_id}`}>
                {s.strongest.code} {s.strongest.score.toFixed(0)} {s.strongest.signal}
              </strong>
            ) : '—'}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 股票评分表：聚评分（交易决策）+ 各策略独立分 + 信号。 */
export function StockScoringTable({ stocks }: { stocks: SimStrategiesDto['stocks'] }) {
  if (stocks.length === 0) return <div data-testid="sim-stock-scoring-empty">未评估</div>;
  return (
    <table data-testid="sim-stock-scoring">
      <thead><tr><th>标的</th><th>最新价</th><th>双均线</th><th>MACD</th><th>均线+RSI</th><th className="text-[--acc1]">聚合评分</th><th>信号</th></tr></thead>
      <tbody>
        {stocks.map((st) => {
          const score = (id: string) => st.per_strategy_scores.find((x) => x.strategy_id === id)?.score ?? 0;
          return (
            <tr key={st.code}>
              <td data-testid={`sim-score-code-${st.code}`}>{st.code}</td>
              <td>{st.latest_price.toFixed(3)}</td>
              <td data-testid={`sim-score-ma-${st.code}`}>{score('dual_ma').toFixed(0)}</td>
              <td data-testid={`sim-score-macd-${st.code}`}>{score('macd').toFixed(0)}</td>
              <td data-testid={`sim-score-rsi-${st.code}`}>{score('ma_rsi').toFixed(0)}</td>
              <td data-testid={`sim-score-aggregate-${st.code}`} className="text-[--acc1]">{st.aggregate_score.toFixed(0)}</td>
              <td data-testid={`sim-score-signal-${st.code}`} className={st.signal === 'buy' ? 'text-[--up]' : st.signal === 'sell' ? 'text-[--down]' : ''}>{st.signal}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 模拟委托/成交（source: strategy|manual；pending 可撤）。 */
export function OrderTradeList({ orders, onCancel }: { orders: SimOrder[]; onCancel: (id: string) => void }) {
  if (orders.length === 0) return <div data-testid="sim-orders-empty">无委托</div>;
  return (
    <table data-testid="sim-order-list">
      <thead><tr><th>时刻</th><th>code</th><th>方向</th><th>价格</th><th>数量</th><th>来源</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td>{new Date(o.ts).toLocaleTimeString('zh-CN')}</td>
            <td>{o.code}</td>
            <td className={o.side === 'buy' ? 'text-[--up]' : 'text-[--down]'}>{o.side === 'buy' ? '买入' : '卖出'}</td>
            <td>{o.filled_price?.toFixed(3) ?? o.limit_price?.toFixed(3) ?? '—'}</td>
            <td>{o.qty.toLocaleString()}</td>
            <td>{o.source}</td>
            <td data-testid={`sim-order-status-${o.id}`}>{o.status}</td>
            <td>
              {o.status === 'pending' && (
                <button type="button" data-testid={`sim-cancel-order-${o.id}`} onClick={() => onCancel(o.id)}>撤单</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 历史会话回看 + 「回测一下」对比（独立 Tab，不影响当前会话）。 */
export function SessionHistory({
  sessions,
  selected,
  compare,
  onSelect,
  onCompare,
}: {
  sessions: SimSessionListEntry[];
  selected: SimSessionDetail | null;
  compare: { data: { session_id: string; run_ids: number[] } | null; loading: boolean; error: string | null };
  onSelect: (id: string) => void;
  onCompare: (id: string) => void;
}) {
  if (sessions.length === 0) return <div data-testid="sim-history-empty">无历史会话</div>;
  return (
    <div data-testid="sim-history" className="flex flex-col gap-3">
      <table data-testid="sim-history-table">
        <thead><tr><th>session</th><th>周期</th><th>策略集</th><th>净收益</th><th>最大回撤</th><th>操作</th></tr></thead>
        <tbody>
          {sessions.map((h) => (
            <tr key={h.session.id}>
              <td data-testid={`sim-history-id-${h.session.id}`}>{h.session.id}</td>
              <td>{h.session.period}</td>
              <td>{h.session.strategy_set.join('+')}</td>
              <td className="text-[--up]">{h.metrics ? `${((h.metrics.net_profit as number) / h.session.cash_init * 100).toFixed(2)}%` : '—'}</td>
              <td className="text-[--down]">{h.metrics ? `${(h.metrics.max_drawdown as number).toFixed(1)}%` : '—'}</td>
              <td>
                <button type="button" data-testid={`sim-select-session-${h.session.id}`} onClick={() => onSelect(h.session.id)}>回看</button>
                <button type="button" data-testid={`sim-compare-${h.session.id}`} onClick={() => onCompare(h.session.id)}>回测对比</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div data-testid="sim-history-detail" className="border-t pt-3">
          <div className="text-[--dim]">会话详情 · {selected.session.id} · {selected.session.period}</div>
          <div className="flex gap-4">
            <span>净收益：{selected.session.cash_init ? <b>{( ( (selected.result?.metrics as Record<string, unknown>)?.net_profit as number ?? 0) / selected.session.cash_init * 100).toFixed(2)}%</b> : '—'}</span>
          </div>
        </div>
      )}

      {compare && (
        <div data-testid="sim-compare-result" className="border-t pt-3">
          {compare.loading ? '对比进行中…' : compare.error ? compare.error :
            compare.data ? `回测对比已触发 run_ids=${compare.data.run_ids.join(',')}` : '点击「回测对比」触发'}
        </div>
      )}
    </div>
  );
}
