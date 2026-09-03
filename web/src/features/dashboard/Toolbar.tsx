import { DASHBOARD_DEFAULTS, type GridMode, type Period } from '@/layouts/DashboardGrid';
import { Button } from '@/components/ui/button';

export type ChartTab = 'kline' | 'timeshare';
export type IndicatorName = keyof typeof DASHBOARD_DEFAULTS.indicators;

export interface ToolbarProps {
  period: Period;
  onPeriodChange(p: Period): void;
  chartTab: ChartTab;
  onChartTabChange(t: ChartTab): void;
  indicators: Record<IndicatorName, boolean>;
  onToggleIndicator(name: IndicatorName): void;
  gridMode: GridMode;
  onGridModeChange(m: GridMode): void;
  followLatest: boolean;
  onBackToLatest(): void;
}

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '1d', label: '日' },
];

const TABS: Array<{ value: ChartTab; label: string }> = [
  { value: 'kline', label: 'K线' },
  { value: 'timeshare', label: '分时' },
];

const INDICATORS: Array<{ value: IndicatorName; label: string }> = [
  { value: 'ma', label: 'MA' },
  { value: 'macd', label: 'MACD' },
  { value: 'kdj', label: 'KDJ' },
  { value: 'boll', label: 'BOLL' },
];

const GRID_MODES: Array<{ value: GridMode; label: string }> = [
  { value: 'single', label: '单图' },
  { value: 'grid2x2', label: '2×2' },
  { value: 'grid2x3', label: '2×3' },
];

function Sep() {
  return <span className="mx-1.5 h-4 w-px bg-line" />;
}

/** toolbar 区域：周期 / K线·分时 Tab / 指标勾选 / 宫格 / 回到最新（静态控件无三态） */
export function Toolbar(props: ToolbarProps) {
  return (
    <div className="flex h-full items-center gap-1.5 px-3.5">
      {PERIODS.map((p) => (
        <Button
          key={p.value}
          aria-pressed={props.period === p.value}
          variant={props.period === p.value ? 'primary' : 'ghost'}
          onClick={() => props.onPeriodChange(p.value)}
        >
          {p.label}
        </Button>
      ))}
      <Sep />
      {TABS.map((t) => (
        <Button
          key={t.value}
          aria-pressed={props.chartTab === t.value}
          variant={props.chartTab === t.value ? 'primary' : 'ghost'}
          onClick={() => props.onChartTabChange(t.value)}
        >
          {t.label}
        </Button>
      ))}
      <Sep />
      {INDICATORS.map((i) => (
        <Button
          key={i.value}
          aria-pressed={props.indicators[i.value]}
          variant={props.indicators[i.value] ? 'primary' : 'ghost'}
          onClick={() => props.onToggleIndicator(i.value)}
        >
          {i.label}
        </Button>
      ))}
      <Sep />
      {GRID_MODES.map((g) => (
        <Button
          key={g.value}
          aria-pressed={props.gridMode === g.value}
          variant={props.gridMode === g.value ? 'primary' : 'ghost'}
          onClick={() => props.onGridModeChange(g.value)}
        >
          {g.label}
        </Button>
      ))}
      <span className="flex-1" />
      <Button disabled={props.followLatest} onClick={props.onBackToLatest}>
        回到最新
      </Button>
    </div>
  );
}
