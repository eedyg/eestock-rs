import { useEffect, useState } from 'react';
import { DASHBOARD_DEFAULTS, type GridMode, type Period } from '@/layouts/DashboardGrid';
import { Button } from '@/components/ui/button';
import { DcapParamsPanel } from '@/features/indicators/DcapParamsPanel';
import { DEFAULT_DCAP_PARAMS, type DcapParams } from '@/features/indicators/dcapIndicator';

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
  /** MA 窗口（统一配置，主图+宫格共用；默认 [5,10,20]，从 GET /api/config/ma 读） */
  maWindows: number[];
  /** 保存 MA 窗口（乐观更新=由父级在处理内先同步 setMaWindows 再 await 接口；失败回滚） */
  onSaveMaWindows(windows: number[]): Promise<void>;
  /** dcap 显示参数（统一配置，主图+宫格共用；默认 8/26/60/1/1/1/1/3，从 GET /api/config/dcap 读）。
   *  缺省 = 默认值（兼容未接线的调用面）。 */
  dcapParams?: DcapParams;
  /** 保存 dcap 显示参数（PUT /api/config/dcap；父级乐观更新，失败回滚+rethrow）。缺省 = noop。 */
  onSaveDcapParams?(params: DcapParams): Promise<void>;
  /** 多周期开关态（统一配置，落服务端 config；缺省 = false ⇒ 与现状等价）。
   *  **宫格模式必须为 false**（§7.1「仅单图可用」：宫格隐藏入口/强制关闭，由页面传入）。 */
  multiPeriodEnabled?: boolean;
  /** 切换多周期开关（父级乐观更新 + 失败回滚；缺省 = noop）。宫格模式应传 `undefined`（禁用入口）。 */
  onToggleMultiPeriod?(enabled: boolean): void;
  /** 多周期区域是否可用（仅单图模式；缺省 = true）。false ⇒ **隐藏**开关与选择器入口（§7.1 宫格模式）。 */
  multiPeriodAvailable?: boolean;
  /** 两步周期选择器入口是否可用（仅 单图 + 已启用多周期）；false ⇒ 入口隐藏。 */
  multiPeriodPickerAvailable?: boolean;
  /** 选择器打开态（`aria-expanded`）。 */
  multiPeriodPickerOpen?: boolean;
  /** 打开两步周期选择器（缺省 = noop）。 */
  onOpenMultiPeriodPicker?(): void;
}

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '1d', label: '日' },
  { value: '1w', label: '周' }, // 周线（周期切 1w，chart 按新周期加载）
  { value: '1mo', label: '月' }, // 月线（周期切 1mo，chart 按新周期加载）
];

const TABS: Array<{ value: ChartTab; label: string }> = [
  { value: 'kline', label: 'K线' },
  { value: 'timeshare', label: '分时' },
];

const INDICATORS: Array<{ value: IndicatorName; label: string }> = [
  { value: 'ma', label: 'MA' },
  { value: 'vol', label: 'VOL' }, // 成交量副图：与 MA/MACD/KDJ/BOLL/DCAP 并列的开关（默认开，会话态）
  { value: 'macd', label: 'MACD' },
  { value: 'kdj', label: 'KDJ' },
  { value: 'boll', label: 'BOLL' },
  { value: 'dcap', label: 'DCAP' }, // ADR-021：定投收益率三线（默认关，独立副图）
];

const GRID_MODES: Array<{ value: GridMode; label: string }> = [
  { value: 'single', label: '单图' },
  { value: 'grid2x2', label: '2×2' },
  { value: 'grid2x3', label: '2×3' },
];

function Sep() {
  return <span className="mx-1.5 h-4 w-px bg-line" />;
}

/** MA 配置控件（W2）：`MA(5,10,20)` 点击展开，1-3 条窗口输入框，保存→onSaveMaWindows（PUT /api/config/ma）。
 *  与 MA 开关（indicator toggle）共存：toggle 控开关，本控件控窗口。保存调用父级 onSaveMaWindows（
 *  父级先同步 setMaWindows 乐观更新再 await 接口，失败回滚——主图+宫格统一应用配置窗口）。 */
function MaConfigControl({
  maWindows,
  onSaveMaWindows,
}: {
  maWindows: number[];
  onSaveMaWindows(windows: number[]): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(maWindows.map(String));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  // 配置窗口由外部（统一配置源）驱动而变时，未打开的状态下同步草稿
  useEffect(() => {
    if (!open) setDraft(maWindows.map(String));
  }, [maWindows, open]);

  const updateDraft = (i: number, raw: string) => {
    setDraft((d) => {
      const next = [...d];
      while (next.length <= i) next.push('');
      next[i] = raw;
      return next;
    });
  };

  const handleSave = async () => {
    setError(false);
    const parsed = draft
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 500);
    if (parsed.length === 0) {
      setError(true);
      return;
    }
    setSaving(true);
    try {
      await onSaveMaWindows(parsed);
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative">
      <Button
        aria-pressed={false}
        aria-expanded={open}
        variant="ghost"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) setError(false);
        }}
        aria-label="MA 配置"
      >
        MA({maWindows.join(',')})
        <span className="ml-1 text-dim">▾</span>
      </Button>
      {open && (
        <div
          data-ma-editor
          className="absolute left-0 top-full z-20 mt-1 flex w-64 flex-col items-start gap-2 rounded-lg border border-line bg-panel p-2.5 shadow-lg"
          role="group"
          aria-label="MA 窗口配置"
        >
          <div className="text-xs text-dim">MA 窗口（1-3 条，1-500）</div>
          <div className="flex w-full items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                data-ma-input={i}
                aria-label={`MA 窗口 ${i + 1}`}
                value={draft[i] ?? ''}
                onChange={(e) => updateDraft(i, e.target.value)}
                inputMode="numeric"
                placeholder={String(i + 1)}
                className="h-7 w-full min-w-0 rounded border border-line bg-panel2 px-1.5 text-xs num"
              />
            ))}
          </div>
          {error && <div className="text-xs text-down">请输入 1-3 条 1-500 的整数窗口</div>}
          <div className="mt-1 flex gap-1.5">
            <Button variant="primary" size="sm" disabled={saving} onClick={handleSave}>
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  );
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
        <span key={i.value} className="flex items-center gap-1">
          <Button
            aria-pressed={props.indicators[i.value]}
            variant={props.indicators[i.value] ? 'primary' : 'ghost'}
            onClick={() => props.onToggleIndicator(i.value)}
          >
            {i.label}
          </Button>
          {i.value === 'ma' && (
            <MaConfigControl maWindows={props.maWindows} onSaveMaWindows={props.onSaveMaWindows} />
          )}
          {i.value === 'dcap' && (
            <DcapParamsPanel
              params={props.dcapParams ?? DEFAULT_DCAP_PARAMS}
              onSave={props.onSaveDcapParams ?? (async () => {})}
            />
          )}
        </span>
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
      {/* 多周期区域（§7.1「仅单图可用」）：宫格模式 ⇒ **整体隐藏**（入口隐藏 + 强制关闭，不留无效按钮）。 */}
      {(props.multiPeriodAvailable ?? true) && (
        <>
          {/* 两步周期选择器入口（P5.5；仅单图 + 已启用多周期时可用） */}
          {props.multiPeriodPickerAvailable && (
            <Button
              data-testid="mp-periods-open"
              aria-expanded={props.multiPeriodPickerOpen ?? false}
              aria-label="选择 K 线/指标周期"
              variant="ghost"
              onClick={() => props.onOpenMultiPeriodPicker?.()}
            >
              周期选择
            </Button>
          )}
          {/* 多周期开关入口（ADR-022 口径 4/§7.1：仅单图模式可用；宫格模式强制关闭） */}
          <Button
            aria-pressed={props.multiPeriodEnabled ?? false}
            variant={props.multiPeriodEnabled ? 'primary' : 'ghost'}
            onClick={() => props.onToggleMultiPeriod?.(!(props.multiPeriodEnabled ?? false))}
          >
            多周期
          </Button>
        </>
      )}
      <Sep />
      <Button disabled={props.followLatest} onClick={props.onBackToLatest}>
        回到最新
      </Button>
    </div>
  );
}
