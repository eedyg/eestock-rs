import { useEffect, useMemo, useState } from 'react';
import { BACKTEST_DEFAULTS, type BacktestPeriod } from '@/layouts/BacktestGrid';
import type { BacktestStrategyDto, BacktestSubmitReq } from '@/api/types';

const DEFAULT_CODE = '518880';
const DEFAULT_FEE = { ratePct: 0.025, minFee: 5, slippageBp: 2 };
const DEFAULT_INITIAL_CAPITAL = 100000;

/** Date → 'YYYY-MM-DD'（date input 值格式，本地时区）。 */
function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 回测区间默认：to=今天，from=近一年（近一年或全历史，此处取近一年）。 */
function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  return { from: toDateInput(from), to: toDateInput(to) };
}

/** 日期串'YYYY-MM-DD' → RFC3339 起点（UTC 当日 00:00:00），与 client 默认 from/to 格式同构。 */
function dayToIso(day: string): string {
  return day ? `${day}T00:00:00.000Z` : day;
}

function defaultValues(schema: BacktestStrategyDto['params_schema']): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of schema) {
    if ('Num' in p.kind) out[p.key] = p.kind.Num.def;
    else out[p.key] = p.kind.Choice.def;
  }
  return out;
}

/**
 * 页面⑤策略表单：策略下拉（GET /api/backtest/strategies 7 款）+ schema 驱动参数表单 +
 * 周期/手续费/滑点 + 参数网格「起:止:步长」展开 + 提交。提交→POST /api/backtest/runs。
 * 三态：骨架表单 / 不可能空（内置策略编译期注册固定 7 款）/ 错误占位+重试；提交错误内联。
 */
export function StrategyForm({
  strategies,
  loading,
  error,
  onRetry,
  submitting,
  submitError,
  onSubmit,
}: {
  strategies: BacktestStrategyDto[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (req: BacktestSubmitReq) => void;
}) {
  const [strategyId, setStrategyId] = useState<string>('');
  const [values, setValues] = useState<Record<string, number | string>>({});
  const [grids, setGrids] = useState<Record<string, string>>({});
  const [code, setCode] = useState(DEFAULT_CODE);
  const [period, setPeriod] = useState<BacktestPeriod>('1d');
  const [fee, setFee] = useState(DEFAULT_FEE);
  const [initialCapital, setInitialCapital] = useState(DEFAULT_INITIAL_CAPITAL);
  const [dateFrom, setDateFrom] = useState<string>(() => defaultDateRange().from);
  const [dateTo, setDateTo] = useState<string>(() => defaultDateRange().to);
  const [formError, setFormError] = useState<string | null>(null);

  const strategy = useMemo(
    () => strategies?.find((s) => s.id === strategyId) ?? null,
    [strategies, strategyId],
  );

  // 策略清单载入/切换：兜底默认选第一款并重置参数 schema 默认值
  useEffect(() => {
    if (!strategies || strategies.length === 0) return;
    if (!strategyId || !strategies.some((s) => s.id === strategyId)) {
      const first = strategies[0]!;
      setStrategyId(first.id);
      setValues(defaultValues(first.params_schema));
      setGrids({});
    }
  }, [strategies, strategyId]);

  const onStrategyChange = (id: string) => {
    const s = strategies?.find((x) => x.id === id);
    setStrategyId(id);
    setValues(s ? defaultValues(s.params_schema) : {});
    setGrids({});
  };

  if (error) {
    return (
      <div className="flex flex-col gap-3 p-3 text-xs text-up">
        <span>策略清单加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="self-start rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading || !strategy) {
    return (
      <div className="flex flex-col gap-3 p-3" data-testid="strategy-form-skeleton">
        <div className="h-8 animate-pulse rounded bg-white/10" />
        <div className="h-8 animate-pulse rounded bg-white/10" />
        <div className="h-8 animate-pulse rounded bg-white/10" />
      </div>
    );
  }

  const setValue = (key: string, v: number | string) => setValues((s) => ({ ...s, [key]: v }));
  const setGrid = (key: string, v: string) => setGrids((s) => ({ ...s, [key]: v }));

  const handleSubmit = () => {
    const cap = Number(initialCapital);
    if (!Number.isFinite(cap) || cap <= 0) {
      setFormError('初始金额须大于 0');
      return;
    }
    if (!dateFrom || !dateTo || dateFrom >= dateTo) {
      setFormError('回测区间 from 须早于 to');
      return;
    }
    setFormError(null);
    const merged: Record<string, number | string> = { ...values };
    for (const p of strategy.params_schema) {
      const g = grids[p.key];
      if (g && g.trim()) merged[p.key] = g.trim(); // 网格「起:止:步长」覆盖单值
    }
    onSubmit({
      strategyId: strategy.id,
      params: merged,
      code: code.trim(),
      period,
      fee,
      initialCapital: cap,
      from: dayToIso(dateFrom),
      to: dayToIso(dateTo),
    });
  };

  return (
    <form
      className="flex flex-col gap-3 p-4 text-xs"
      data-testid="strategy-form"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <div>
        <label className="mb-1 block text-dim">策略（内置 {strategies?.length ? `已载入 ${strategies.length} 款` : '—'}）</label>
        <select
          className="h-8 w-full rounded-lg border border-line bg-panel2 px-2 text-txt"
          value={strategy.id}
          onChange={(e) => onStrategyChange(e.target.value)}
          data-testid="strategy-select"
        >
          {strategies?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* schema 驱动参数表单 */}
      <div className="flex flex-col gap-2" data-testid="param-form">
        {strategy.params_schema.map((p) => (
          <div key={p.key}>
            <label className="mb-1 block text-dim">{p.label}</label>
            <div className="flex gap-2">
              {('Num' in p.kind ? (
                <input
                  type="number"
                  step={p.kind.Num.step}
                  min={p.kind.Num.min}
                  max={p.kind.Num.max}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
                  value={Number(values[p.key] ?? p.kind.Num.def)}
                  onChange={(e) => setValue(p.key, Number(e.target.value))}
                  data-testid={`param-${p.key}`}
                />
              ) : (
                <select
                  className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
                  value={String(values[p.key] ?? p.kind.Choice.def)}
                  onChange={(e) => setValue(p.key, e.target.value)}
                  data-testid={`param-${p.key}`}
                >
                  {p.kind.Choice.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ))}
              {'Num' in p.kind && (
                <input
                  className="h-8 w-24 rounded-lg border border-line bg-panel2 px-2 text-dim"
                  placeholder="起:止:步长"
                  value={grids[p.key] ?? ''}
                  onChange={(e) => setGrid(p.key, e.target.value)}
                  data-testid={`grid-${p.key}`}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div>
        <label className="mb-1 block text-dim">标的 / 周期（1m/5m/15m/日）</label>
        <div className="flex gap-2">
          <input
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="code-input"
          />
          <select
            className="h-8 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={period}
            onChange={(e) => setPeriod(e.target.value as BacktestPeriod)}
            data-testid="period-select"
          >
            {BACKTEST_DEFAULTS.periods.map((p) => (
              <option key={p} value={p}>
                {p === '1d' ? '日' : p}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-dim">初始金额 / 回测区间</label>
        <div className="flex gap-2">
          <input
            type="number"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={initialCapital}
            onChange={(e) => setInitialCapital(Number(e.target.value))}
            data-testid="initial-capital"
          />
          <input
            type="date"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="date-from"
          />
          <input
            type="date"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="date-to"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-dim">手续费% / 最低费用 / 滑点 bp</label>
        <div className="flex gap-2">
          <input
            type="number"
            step="0.001"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={fee.ratePct}
            onChange={(e) => setFee((f) => ({ ...f, ratePct: Number(e.target.value) }))}
            data-testid="fee-rate"
          />
          <input
            type="number"
            step="1"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={fee.minFee}
            onChange={(e) => setFee((f) => ({ ...f, minFee: Number(e.target.value) }))}
            data-testid="fee-min"
          />
          <input
            type="number"
            step="1"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={fee.slippageBp}
            onChange={(e) => setFee((f) => ({ ...f, slippageBp: Number(e.target.value) }))}
            data-testid="fee-slippage"
          />
        </div>
      </div>

      {formError && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="form-error">
          {formError}
        </div>
      )}

      {submitError && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="submit-error">
          提交失败：{submitError}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-1 rounded-lg bg-gradient-to-r from-acc1 to-acc2 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        data-testid="submit-btn"
      >
        {submitting ? '提交中…' : '提交回测'}
      </button>
    </form>
  );
}
