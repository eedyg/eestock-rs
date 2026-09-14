/**
 * P2-C 独立验收：**真实 klinecharts 10.0.3 产品级渲染** harness 入口（临时；**不进仓库**）。
 * 挂载真实 `MultiPeriodSatellite`（4 卫星）+ 真实 `KlineChart` 基准（阳性对照）。
 * 全程合成数据 ⇒ **0 网络写请求**（无后端调用；仅本地静态资源）。
 */
import { createRoot } from 'react-dom/client';
import { MultiPeriodSatellite } from '@/features/dashboard/MultiPeriodSatellite';
import { KlineChart } from '@/features/dashboard/KlineChart';
import { KlineDataFeed } from '@/features/dashboard/feed';
import { ensureDcapIndicatorRegistered, DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';

const W = window as any;

// ── 画布 draw 打点（按宿主归因：卫星 period / 基准 host）────────────────────────────
W.__texts = [];
(function patchFillText() {
  const proto: any = (window as any).CanvasRenderingContext2D && (window as any).CanvasRenderingContext2D.prototype;
  if (!proto || !proto.fillText) return;
  const orig = proto.fillText;
  proto.fillText = function (t: string, x: number, y: number) {
    try {
      const cv: any = this.canvas;
      const sat = cv?.closest?.('[data-mp-satellite]');
      const base = cv?.closest?.('[data-host]');
      const host = sat ? 'sat:' + sat.getAttribute('data-mp-satellite') : base ? 'base:' + base.getAttribute('data-host') : 'other';
      W.__texts.push({ host, text: String(t), x: +x, y: +y, baseline: this.textBaseline, font: this.font });
    } catch { /* ignore */ }
    return orig.apply(this, arguments as any);
  };
})();

// ── 假 api / 假 ws（合成数据；零网络）──────────────────────────────────────────────
const PERIOD_MIN: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 };
function bars(code: string, period: string, n: number) {
  const step = (PERIOD_MIN[period] ?? 15) * 60_000;
  const end = Date.UTC(2026, 8, 14, 2, 0, 0);
  const seed = code.charCodeAt(0) % 7;
  const out: any[] = [];
  let px = 8.9 + seed * 0.01;
  for (let i = n - 1; i >= 0; i--) {
    px += Math.sin((i + seed) / 13) * 0.002 + Math.cos((i + seed) / 29) * 0.001;
    const o = +px.toFixed(4);
    const c = +(px + Math.sin((i + seed) / 7) * 0.0012).toFixed(4);
    out.push({
      ts: new Date(end - i * step).toISOString(),
      open: o,
      high: +(Math.max(o, c) + 0.0009).toFixed(4),
      low: +(Math.min(o, c) - 0.0009).toFixed(4),
      close: c,
      volume: 100,
      amount: 100 * c,
    });
  }
  return out;
}
W.__queries = [];
const api: any = {
  getKline: async (q: any) => {
    W.__queries.push({ code: q.code, period: q.period, limit: q.limit, before: q.before ?? null });
    return bars(q.code, q.period, Math.min(q.limit ?? 120, 300));
  },
};
const ws: any = {
  connectionStatus: 'open',
  subscribe: () => () => {},
  onStatusChange: () => () => {},
};

const INDICATORS: any = { ma: true, macd: false, kdj: false, boll: false, dcap: true };
const CODE = '518880';
const VIEWPORT_BARS = 120;
const PERIODS: any[] = ['1m', '5m', '15m', '1h'];
const SAT_HEIGHT = 180;
const BASE_HEIGHT = 420;

function Baseline() {
  const feed = new KlineDataFeed({ api, ws, code: CODE, period: '15m', viewportBars: VIEWPORT_BARS, warmupBars: 0 });
  return (
    <div data-host="baseline" style={{ height: BASE_HEIGHT }}>
      <KlineChart
        feed={feed}
        code={CODE}
        period={'15m'}
        followLatest={true}
        indicators={INDICATORS}
        onManualZoom={() => {}}
        maWindows={[5, 10, 20]}
        dcapParams={DEFAULT_DCAP_PARAMS}
        warmupBars={0}
        heightPx={BASE_HEIGHT}
      />
    </div>
  );
}

/** 反向对照 1：**不隐藏 K 线**（T2 的反向：把隐藏改回不隐藏 ⇒ 必然出现蜡烛像素）。 */
function CandleVisibleControl() {
  const feed = new KlineDataFeed({ api, ws, code: CODE, period: '15m', viewportBars: VIEWPORT_BARS, warmupBars: 0 });
  return (
    <div data-host="candle-visible" style={{ height: 180 }}>
      <KlineChart feed={feed} code={CODE} period={'15m'} followLatest={true}
        indicators={{ ma: true, macd: false, kdj: false, boll: false, dcap: false }}
        onManualZoom={() => {}} maWindows={[5, 10, 20]} dcapParams={DEFAULT_DCAP_PARAMS} warmupBars={0} heightPx={180} />
    </div>
  );
}
/** 反向对照 2：隐藏 K 线 + **不显示 DCAP**（T5/G4 的反向：不要 DCAP ⇒ DCAP pane/像素应为 0）。 */
function DcapOffControl() {
  const feed = new KlineDataFeed({ api, ws, code: CODE, period: '15m', viewportBars: VIEWPORT_BARS, warmupBars: 0 });
  return (
    <div data-host="dcap-off" style={{ height: 180 }}>
      <KlineChart feed={feed} code={CODE} period={'15m'} followLatest={true}
        indicators={{ ma: true, macd: false, kdj: false, boll: false, dcap: false }}
        onManualZoom={() => {}} maWindows={[5, 10, 20]} dcapParams={DEFAULT_DCAP_PARAMS} warmupBars={0} hideCandles heightPx={180} />
    </div>
  );
}

function App() {
  ensureDcapIndicatorRegistered();
  return (
    <div id="main" data-region="main-chart" style={{ height: 600, overflow: 'hidden', display: 'block' }}>
      <Baseline />
      {PERIODS.map((p) => (
        <MultiPeriodSatellite
          key={p}
          api={api}
          ws={ws}
          code={CODE}
          period={p}
          height={SAT_HEIGHT}
          indicators={INDICATORS}
          maWindows={[5, 10, 20]}
          dcapParams={DEFAULT_DCAP_PARAMS}
          viewportBars={VIEWPORT_BARS}
          followLatest={true}
          basePeriod={'15m'}
          basePeriodSource={'config'}
        />
      ))}
      <CandleVisibleControl />
      <DcapOffControl />
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
