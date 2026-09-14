/**
 * P5-A 布局/溢出：**真实产品组件**渲染入口（Vite 构建；合成数据 ⇒ 0 网络写请求）。
 *
 * 本文件位置：`web/tester/p5-layout-harness/entry.tsx`
 * 挂载：真实 `MultiPeriodChartStack`（含基准 `KlineChart` + 3 个真实 `MultiPeriodSatellite`），
 * 外层复刻主图区容器（`data-region="main-chart"`，600px —— P2-C 实测口径）。
 *
 * 暴露 `window.__p5`：几何读数（不依赖 tailwind 类名，全部走 `getBoundingClientRect`/`clientHeight`）。
 */
import '@/index.css';
import { createRoot } from 'react-dom/client';
import { MultiPeriodChartStack } from '@/features/dashboard/MultiPeriodChartStack';
import { KlineChart } from '@/features/dashboard/KlineChart';
import { KlineDataFeed } from '@/features/dashboard/feed';
import { ensureDcapIndicatorRegistered, DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';

const W = window as any;

const PERIOD_MIN: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 };

/** 合成 bar（确定性；合成交易日密度 ⇒ 与生产同量级）。 */
function bars(code: string, period: string, n: number) {
  const step = (PERIOD_MIN[period] ?? 15) * 60_000;
  const end = Date.UTC(2026, 8, 15, 2, 0, 0);
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
  getMultiPeriodConfig: async () => ({
    enabled: true,
    periods: ['15m', '1h', '5m', '1d'],
    heights: { '15m': 420, '1h': 180, '5m': 180, '1d': 180 },
    indicators: ['dcap'],
  }),
  saveMultiPeriodConfig: async (cfg: any) => {
    W.__writes.push(cfg);
    return cfg;
  },
  getKlineConfig: async () => ({ viewport_bars: 120 }),
  getDcapConfig: async () => DEFAULT_DCAP_PARAMS,
  saveDcapConfig: async (c: any) => c,
};
W.__writes = [];
const ws: any = {
  connectionStatus: 'open',
  subscribe: () => () => {},
  onStatusChange: () => () => {},
};

const INDICATORS: any = { ma: true, macd: false, kdj: false, boll: false, dcap: true };
const CODE = '518880';
const VIEWPORT_BARS = 120;
const BASE_PERIOD = '15m';
const BASE_HEIGHT = 420;
const SAT_HEIGHT = 180;
const SATS: any[] = ['1h', '5m', '1d'];
/** 主图区可用高度（P2-C 实测口径：`#main` clientHeight = 600）。 */
const AVAILABLE = 600;

function App() {
  ensureDcapIndicatorRegistered();
  const feed = new KlineDataFeed({
    api,
    ws,
    code: CODE,
    period: BASE_PERIOD,
    viewportBars: VIEWPORT_BARS,
    warmupBars: 0,
  });
  return (
    <div
      id="main"
      data-region="main-chart"
      data-available={AVAILABLE}
      style={{ height: AVAILABLE, overflow: 'hidden', position: 'relative' }}
    >
      <MultiPeriodChartStack
        enabled
        code={CODE}
        api={api}
        ws={ws}
        indicators={INDICATORS}
        maWindows={[5, 10, 20]}
        dcapParams={DEFAULT_DCAP_PARAMS}
        viewportBars={VIEWPORT_BARS}
        followLatest
        basePeriod={BASE_PERIOD}
        basePeriodSource="config"
        {...({ baseHeight: BASE_HEIGHT } as any)}
        satellites={SATS.map((p) => ({ period: p, height: SAT_HEIGHT }))}
      >
        <KlineChart
          feed={feed}
          code={CODE}
          period={BASE_PERIOD}
          followLatest
          indicators={INDICATORS}
          onManualZoom={() => {}}
          maWindows={[5, 10, 20]}
          dcapParams={DEFAULT_DCAP_PARAMS}
          warmupBars={0}
        />
      </MultiPeriodChartStack>
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);

// ── 几何读数（供 run.mjs 调用；全部真实 rect）───────────────────────────────────
const rect = (el: Element | null) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: +r.top.toFixed(1),
    bottom: +r.bottom.toFixed(1),
    height: +r.height.toFixed(1),
    width: +r.width.toFixed(1),
  };
};

W.__p5 = {
  version: 'p5-layout-harness/1',
  measure() {
    const main = document.querySelector('#main') as HTMLElement | null;
    const stack = document.querySelector('[data-mp-stack]') as HTMLElement | null;
    const separators = Array.from(document.querySelectorAll('[data-mp-separator]')) as HTMLElement[];
    const base = document.querySelector('[data-testid="kline-chart"]') as HTMLElement | null;
    const sats = Array.from(document.querySelectorAll('[data-mp-satellite]')) as HTMLElement[];
    const panes = Array.from(document.querySelectorAll('[data-mp-pane]')) as HTMLElement[];

    // 现状实现（无栈/pane 契约）下的等价集合：基准图 + 各卫星（业务元素）
    const legacyItems = [base, ...sats].filter(Boolean) as HTMLElement[];
    const legacySum = legacyItems.reduce((a, el) => a + (rect(el)?.height ?? 0), 0);

    let layoutJson: any = null;
    if (stack) {
      const raw = stack.getAttribute('data-mp-stack-layout');
      try {
        layoutJson = raw ? JSON.parse(raw) : null;
      } catch {
        layoutJson = { parseError: raw };
      }
    }

    return {
      available: AVAILABLE,
      main: main
        ? {
            clientHeight: main.clientHeight,
            scrollHeight: main.scrollHeight,
            rect: rect(main),
          }
        : null,
      stack: stack
        ? {
            scrollHeight: stack.scrollHeight,
            clientHeight: stack.clientHeight,
            rect: rect(stack),
            scrollableAttr: stack.getAttribute('data-mp-stack-scrollable'),
            layout: layoutJson,
          }
        : null,
      paneCount: panes.length,
      panes: panes.map((el) => ({
        period: el.getAttribute('data-mp-pane'),
        role: el.getAttribute('data-mp-pane-role'),
        declared: el.getAttribute('data-mp-pane-height'),
        inlineHeight: el.style.height,
        rect: rect(el),
      })),
      separatorCount: separators.length,
      separators: separators.map((el) => ({
        key: el.getAttribute('data-mp-separator'),
        role: el.getAttribute('role'),
        rect: rect(el),
      })),
      base: rect(base),
      satellites: sats.map((el) => ({
        period: el.getAttribute('data-mp-satellite'),
        inlineHeight: el.style.height,
        rect: rect(el),
      })),
      /** 现状（无 P5 契约）下的「基准 + 卫星」高度和（红阶段取证用）。 */
      legacySum,
      bodyScrollHeight: document.body.scrollHeight,
      writes: W.__writes.length,
    };
  },
};
