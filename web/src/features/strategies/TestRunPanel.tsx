import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type {
  StrategyParamDef,
  StrategyTestMode,
  StrategyTestRunResp,
} from '@/api/types';
import { ScoreChart } from './ScoreChart';
import { formatDateTime } from './format';

function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 默认试算区间：近一年（日线语义；分钟级区间上限 3 个月由后端校验兜底 400 友好展示） */
function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  return { from: toDateInput(from), to: toDateInput(to) };
}

function dayToIso(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * 试算面板（ADR §13.5 双模式）：symbol / 周期 M1/M5/M15/D1 / 区间 / 参数（按 schema 渲染）/
 * 模式 pure_score|sim_position → POST /api/strategies/test-run（内联 code，即写即跑）。
 * 结果：评分曲线（ScoreChart）+ sim_position 成交表/事件列表 + 截断提示；
 * 错误（400 参数越界/区间超限）内联友好展示。
 */
export function TestRunPanel({
  api,
  code,
  schema,
}: {
  api: ApiClient;
  code: string;
  schema: StrategyParamDef[];
}) {
  const [symbol, setSymbol] = useState('518880');
  const [period, setPeriod] = useState<'M1' | 'M5' | 'M15' | 'D1'>('D1');
  const [dateFrom, setDateFrom] = useState(() => defaultRange().from);
  const [dateTo, setDateTo] = useState(() => defaultRange().to);
  const [mode, setMode] = useState<StrategyTestMode>('pure_score');
  const [paramText, setParamText] = useState<Record<string, string>>(() =>
    Object.fromEntries(schema.map((p) => [p.key, String(p.default)])),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StrategyTestRunResp | null>(null);

  // schema 变化（版本切换）时重置参数默认值（保留已有 key 的输入）
  const schemaKeys = useMemo(() => schema.map((p) => p.key).join(','), [schema]);
  useEffect(() => {
    setParamText((cur) => {
      const next: Record<string, string> = {};
      for (const p of schema) next[p.key] = cur[p.key] ?? String(p.default);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKeys]);

  const handleRun = async () => {
    if (!symbol.trim()) {
      setFormError('标的代码必填');
      return;
    }
    if (!dateFrom || !dateTo || dateFrom >= dateTo) {
      setFormError('试算区间 from 须早于 to');
      return;
    }
    // 参数校验（schema min/max；type int 须整数）
    const params: Record<string, number> = {};
    for (const p of schema) {
      const raw = paramText[p.key] ?? String(p.default);
      const v = Number(raw);
      if (raw.trim() === '' || Number.isNaN(v)) {
        setFormError(`参数 ${p.key} 须为数值`);
        return;
      }
      if (p.type === 'int' && !Number.isInteger(v)) {
        setFormError(`参数 ${p.key} 须为整数`);
        return;
      }
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) {
        setFormError(`参数 ${p.key} 超出范围 [${p.min ?? '-∞'}, ${p.max ?? '+∞'}]`);
        return;
      }
      params[p.key] = v;
    }
    setFormError(null);
    setRunError(null);
    setRunning(true);
    try {
      const resp = await api.runStrategyTest({
        code,
        params,
        symbol: symbol.trim(),
        period,
        from: dayToIso(dateFrom),
        to: dayToIso(dateTo),
        mode,
      });
      setResult(resp);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : '试算失败');
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const truncatedHints = result
    ? ([
        result.truncated.scores ? '评分序列' : null,
        result.truncated.events ? '事件日志' : null,
        result.truncated.trades ? '成交明细' : null,
      ].filter(Boolean) as string[])
    : [];

  return (
    <div className="flex flex-col gap-3 overflow-auto p-3 text-xs" data-testid="testrun-panel">
      {/* 表单 */}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-dim">
          标的
          <input
            className="mt-0.5 h-7 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            data-testid="tr-symbol"
          />
        </label>
        <label className="block text-dim">
          周期
          <select
            className="mt-0.5 h-7 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={period}
            onChange={(e) => setPeriod(e.target.value as typeof period)}
            data-testid="tr-period"
          >
            <option value="M1">M1</option>
            <option value="M5">M5</option>
            <option value="M15">M15</option>
            <option value="D1">D1</option>
          </select>
        </label>
        <label className="block text-dim">
          起始
          <input
            type="date"
            className="mt-0.5 h-7 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="tr-date-from"
          />
        </label>
        <label className="block text-dim">
          截止
          <input
            type="date"
            className="mt-0.5 h-7 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="tr-date-to"
          />
        </label>
      </div>

      {schema.length > 0 && (
        <div className="grid grid-cols-2 gap-2" data-testid="tr-params">
          {schema.map((p) => (
            <label key={p.key} className="block text-dim">
              {p.key}
              {p.description ? `（${p.description}）` : ''}
              <input
                type="number"
                className="mt-0.5 h-7 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
                value={paramText[p.key] ?? String(p.default)}
                min={p.min}
                max={p.max}
                step={p.type === 'int' ? 1 : 'any'}
                onChange={(e) => setParamText((s) => ({ ...s, [p.key]: e.target.value }))}
                data-testid={`tr-param-${p.key}`}
              />
            </label>
          ))}
        </div>
      )}

      <label className="block text-dim">
        模式
        <select
          className="mt-0.5 h-7 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
          value={mode}
          onChange={(e) => setMode(e.target.value as StrategyTestMode)}
          data-testid="tr-mode"
        >
          <option value="pure_score">纯评分（position 恒 null，看原始反应）</option>
          <option value="sim_position">模拟持仓（默认 60/40 阈值 + LumpSum 模拟成交）</option>
        </select>
      </label>

      {formError && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="tr-form-error">
          {formError}
        </div>
      )}

      <button
        type="button"
        disabled={running}
        className="rounded-lg bg-gradient-to-r from-acc1 to-acc2 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        onClick={() => void handleRun()}
        data-testid="tr-run"
      >
        {running ? '试算中…' : '运行试算'}
      </button>

      {runError && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="tr-run-error">
          试算失败：{runError}
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-2" data-testid="tr-result">
          <div className="text-dim">
            {result.symbol} / {result.period} / {result.bar_count} bar
            （{result.mode === 'pure_score' ? '纯评分' : '模拟持仓'}）
          </div>
          {truncatedHints.length > 0 && (
            <div className="rounded-lg border border-acc2/40 bg-acc2/10 p-2 text-acc2" data-testid="tr-truncated">
              结果已截断（{truncatedHints.join('、')}超出上限，仅展示前段）
            </div>
          )}
          <ScoreChart scores={result.scores} signals={result.signals} />

          {result.trades.length > 0 && (
            <div className="overflow-auto rounded-lg border border-line" data-testid="tr-trades">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-line text-dim">
                    <th className="px-2 py-1 font-normal">开仓</th>
                    <th className="px-2 py-1 font-normal">平仓</th>
                    <th className="px-2 py-1 font-normal">股数</th>
                    <th className="px-2 py-1 font-normal">盈亏</th>
                    <th className="px-2 py-1 font-normal">持仓 bar</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((t, i) => (
                    <tr key={i} className="border-b border-line/50 last:border-0">
                      <td className="px-2 py-1 text-dim">{formatDateTime(new Date(t.open_ts * 1000).toISOString())} @ {t.open_price}</td>
                      <td className="px-2 py-1 text-dim">{formatDateTime(new Date(t.close_ts * 1000).toISOString())} @ {t.close_price}</td>
                      <td className="px-2 py-1 text-txt">{t.shares}</td>
                      <td className={`px-2 py-1 ${t.pnl >= 0 ? 'text-up' : 'text-down'}`}>{t.pnl}</td>
                      <td className="px-2 py-1 text-dim">{t.hold_bars}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.events.length > 0 && (
            <div className="max-h-40 overflow-auto rounded-lg border border-line p-2" data-testid="tr-events">
              <div className="mb-1 text-dim">事件日志（{result.events.length}）</div>
              {result.events.map((e, i) => (
                <div key={i} className="font-mono text-[11px] text-dim">
                  [bar {e.bar_index}] {e.type}: {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
