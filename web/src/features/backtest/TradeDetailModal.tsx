import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { defaultApi } from '@/api';
import type { ApiClient } from '@/api/client';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import type { Period, Trade } from '@/api/types';
import { KlineChart, type KlineOverlay } from '@/features/dashboard/KlineChart';
import type { IndicatorName } from '@/features/dashboard/Toolbar';
import { Button } from '@/components/ui/button';
import { deltaClass, fmtHoldBars, fmtPct, fmtPnl, fmtTs, periodCodeToPeriod } from './format';
import { ScopedKlineFeed } from './ScopedKlineFeed';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-dim">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** 弹窗内周期可选集（回测周期上界 1m/5m/15m/1d，无 1h）。 */
const PERIOD_OPTS: Array<{ value: Period; label: string }> = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1d', label: '日' },
];

/** 指标勾选（MA/VOL 默认开；MACD/KDJ/BOLL 由用户勾选）。 */
const INDICATOR_OPTS: Array<{ value: IndicatorName; label: string }> = [
  { value: 'ma', label: 'MA' },
  { value: 'macd', label: 'MACD' },
  { value: 'kdj', label: 'KDJ' },
  { value: 'boll', label: 'BOLL' },
];

/** 默认尺寸：min(1200px, 90vw) × min(80vh, 85vh)；min 尺寸防过小。 */
function defaultSize() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight : 900;
  return {
    w: Math.min(1200, Math.round(w * 0.9)),
    h: Math.min(Math.round(h * 0.8), Math.round(h * 0.85)),
  };
}

/**
 * 交易明细弹窗（页面⑤）：点交易行 → 弹窗展示该笔交易（不跳行情看板、不重载）。
 *
 * 从「仅交易字段」升级为：大尺寸可 resize 弹窗
 *  - 上方：紧凑交易字段行（标的/方向/开平时刻/价格/数量/盈亏/时长/费用）+ 周期/指标切换
 *  - 主体：复用看板 `KlineChart`（完整 klinecharts）交互式 K 线（MA+VOL 默认开，MACD/KDJ/BOLL 可勾选，
 *           可平移/缩放，周期可切换，默认=该 run 回测周期）
 *  - 数据范围：该标的 code + 当前周期「开仓→平仓 + 前后 buffer」区间（经 `ScopedKlineFeed` 区间取数）
 *  - overlay：开/平仓两条价位线（simpleTag 满宽价线）+ 开平仓区间高亮（tradeRange 全高背景）
 *
 * 遮罩点击不关闭（防误触，同 SymbolFormDialog）——遮罩无 onClick，仅顶部关闭按钮控制。
 * 字段来源均为 TradeDetail jsonb（open_ts/close_ts 为 Unix 秒）。方向无独立字段，引擎为长仓，
 * 故方向按做多口径展示「买入」。
 */
export function TradeDetailModal({
  trade,
  code,
  period,
  api = defaultApi,
  onClose,
}: {
  trade: Trade;
  code: string;
  period: string;
  api?: ApiClient;
  onClose: () => void;
}) {
  // 周期：默认 = 该 run 回测周期（后端码 M1/M5/M15/D1 → 前端 Period）
  const [selPeriod, setSelPeriod] = useState<Period>(() => periodCodeToPeriod(period));
  const [indicators, setIndicators] = useState<Record<IndicatorName, boolean>>({
    ...DASHBOARD_DEFAULTS.indicators,
  });
  const [size, setSize] = useState(defaultSize);
  const dragRef = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null);

  // 区间作用域 feed：code + 当前周期的「开仓→平仓 + buffer」；随周期切换重建，禁实时
  const feed = useMemo(
    () =>
      new ScopedKlineFeed({
        api,
        code,
        period: selPeriod,
        fromTs: trade.open_ts,
        toTs: trade.close_ts,
        buffer: 10,
      }),
    [api, code, selPeriod, trade],
  );
  useEffect(() => () => feed.dispose(), [feed]);

  // 开/平仓价位线 + 开平仓区间高亮 overlay（price 锚定价位）
  const overlays: KlineOverlay[] = useMemo(
    () => [
      { type: 'price-line', price: trade.open_price, label: '开', color: '#38bdf8' },
      { type: 'price-line', price: trade.close_price, label: '平', color: '#f59e0b' },
      { type: 'range', fromTs: trade.open_ts * 1000, toTs: trade.close_ts * 1000, price: trade.open_price },
    ],
    [trade],
  );

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, sw: size.w, sh: size.h };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setSize({
        w: Math.max(480, d.sw + (ev.clientX - d.sx)),
        h: Math.max(400, d.sh + (ev.clientY - d.sy)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const pct = trade.pnl / (trade.gross_value - trade.pnl) || 0;
  const hasFee = trade.commission > 0 || trade.stamp_duty > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="trade-detail-modal">
      <div
        className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        style={{ width: size.w, height: size.h }}
        data-testid="trade-detail-dialog"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[15px]">交易明细</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭交易明细"
            data-testid="trade-detail-close"
            className="rounded-lg border border-line px-2 py-0.5 text-xs text-dim hover:text-txt"
          >
            ✕
          </button>
        </div>

        {/* 上方：紧凑交易字段行 + 周期/指标切换（内容区可滚动） */}
        <div className="shrink-0 overflow-y-auto border-b border-line px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
            <Field label="标的">
              <span className="num" data-testid="td-code">{code}</span>
            </Field>
            <Field label="方向">
              <span data-testid="td-direction">买入</span>
            </Field>
            <Field label="开仓时刻">
              <span className="num" data-testid="td-open-ts">{fmtTs(trade.open_ts)}</span>
            </Field>
            <Field label="平仓时刻">
              <span className="num" data-testid="td-close-ts">{fmtTs(trade.close_ts)}</span>
            </Field>
            <Field label="开仓价">
              <span className="num" data-testid="td-open-price">{trade.open_price.toFixed(3)}</span>
            </Field>
            <Field label="平仓价">
              <span className="num" data-testid="td-close-price">{trade.close_price.toFixed(3)}</span>
            </Field>
            <Field label="数量（股）">
              <span className="num" data-testid="td-shares">{trade.shares.toLocaleString('zh-CN')}</span>
            </Field>
            <Field label="盈亏">
              <span className={`num ${deltaClass(trade.pnl)}`} data-testid="td-pnl">
                {fmtPnl(trade.pnl)}
              </span>{' '}
              <span className={`num ${deltaClass(trade.pnl)}`} data-testid="td-pct">
                （{fmtPct(pct)}）
              </span>
            </Field>
            <Field label="持仓时长">
              <span className="num" data-testid="td-hold">{fmtHoldBars(trade.hold_bars)}</span>
            </Field>
            {hasFee && (
              <Field label="相关费用">
                <span data-testid="td-fee">
                  佣金 {trade.commission.toFixed(2)} · 印花税 {trade.stamp_duty.toFixed(2)}
                </span>
              </Field>
            )}
          </dl>

          {/* 周期切换 + 指标勾选（弹窗内，复用看板 Toolbar 交互语义） */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-y border-line py-2">
            {PERIOD_OPTS.map((p) => (
              <Button
                key={p.value}
                aria-pressed={selPeriod === p.value}
                variant={selPeriod === p.value ? 'primary' : 'ghost'}
                onClick={() => setSelPeriod(p.value)}
              >
                {p.label}
              </Button>
            ))}
            <span className="mx-1.5 h-4 w-px bg-line" />
            {INDICATOR_OPTS.map((i) => (
              <Button
                key={i.value}
                aria-pressed={indicators[i.value]}
                variant={indicators[i.value] ? 'primary' : 'ghost'}
                onClick={() => setIndicators((s) => ({ ...s, [i.value]: !s[i.value] }))}
              >
                {i.label}
              </Button>
            ))}
            <span className="ml-2 text-[11px] text-dim">K线区间：开仓→平仓 ±10 bar</span>
          </div>
        </div>

        {/* 主体：复用看板 KlineChart 交互式 K 线（占弹窗主体） */}
        <div className="min-h-0 flex-1 p-2">
          <KlineChart
            feed={feed}
            code={code}
            period={selPeriod}
            followLatest={false}
            indicators={indicators}
            onManualZoom={() => {}}
            overlays={overlays}
          />
        </div>

        {/* resize 手柄：右下角拖拽改宽高 */}
        <div
          className="h-3 shrink-0 cursor-nwse-resize border-t border-line"
          data-testid="trade-detail-resize"
          onPointerDown={onResizeStart}
        />
      </div>
    </div>
  );
}
