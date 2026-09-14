/**
 * P5-F-1 R1/R2 真渲染几何 harness：**真实产品组件** + **页面内父层桩**（0 网络写）。
 *
 * 本文件位置：`web/tester/p5-r1r2-harness/entry.tsx`
 * 构建/运行：`node tester/p5-r1r2-harness/run.mjs`（须在 `web/` 下）。
 *
 * 父层桩复刻 `DashboardPage.saveMultiPeriodHeights`（乐观写 → `PUT /api/config/multi_period` → 成功回显
 * 成为 props 权威），但 `PUT` 落在**页面内桩**上（只进内存数组）⇒ **0 真实写请求**；并以 **Promise**
 * 回执「父层已接管高度权威」（02-spec §6.3）。
 *
 * 暴露 `window.__r1r2`：真实 rect 读数 + 载荷序列 + 「仅改卫星高度」的父层变更入口（依赖完整性探针）。
 */
import '@/index.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MultiPeriodChartStack } from '@/features/dashboard/MultiPeriodChartStack';
import { KlineChart } from '@/features/dashboard/KlineChart';
import { KlineDataFeed } from '@/features/dashboard/feed';
import { ensureDcapIndicatorRegistered, DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';
import { HEIGHT_MAX, HEIGHT_MIN } from '@/features/dashboard/multiPeriodLayout';

const W = window as any;

// ── 参数（query）：`avail`（可用高度 px）、`server`（初始「服务端配置」heights JSON）──────────────
const params = new URLSearchParams(window.location.search);
const AVAILABLE = Number(params.get('avail') ?? 600);
const DEFAULT_HEIGHTS: Record<string, number> = { '15m': 420, '1h': 180, '5m': 180, '1d': 180 };
const SERVER0: Record<string, number> = params.get('server')
  ? (JSON.parse(params.get('server')!) as Record<string, number>)
  : { ...DEFAULT_HEIGHTS };

const PERIOD_MIN: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 };

/** 合成 bar（确定性；与 P5-A harness 同源口径 ⇒ 0 出网）。 */
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

// ── 页面内桩：api / ws / 「服务端配置」───────────────────────────────────────────────────────
W.__payloads = [] as any[]; // 每次 onHeightsChange 的载荷（含当时的 DOM 分配快照）
W.__writes = 0; // **真实**写请求数（恒 0：PUT 落在本页桩上）
W.__server = { ...SERVER0 }; // 桩「服务端配置」（唯一权威；成功回显后成为 props）
W.__setPayloadErrors = [] as string[];

const api: any = {
  getKline: async (q: any) => bars(q.code, q.period, Math.min(q.limit ?? 120, 300)),
  getMultiPeriodConfig: async () => ({
    enabled: true,
    periods: ['15m', '1h', '5m', '1d'],
    heights: { ...W.__server },
    indicators: ['dcap'],
  }),
  // 桩「PUT」：只进内存（0 网络）；域外值模拟配置面 400（`crates/web/src/dto.rs` 第 5 条）
  saveMultiPeriodConfig: async (cfg: any) => {
    const hs = (cfg?.heights ?? {}) as Record<string, number>;
    for (const [k, v] of Object.entries(hs)) {
      if (!Number.isInteger(v) || v < HEIGHT_MIN || v > HEIGHT_MAX) {
        W.__setPayloadErrors.push(`heights[${k}]=${v} ∉ [${HEIGHT_MIN},${HEIGHT_MAX}]`);
      }
    }
    W.__server = { ...W.__server, ...hs };
    return { ...cfg, heights: { ...W.__server } };
  },
  getKlineConfig: async () => ({ viewport_bars: 120 }),
  getDcapConfig: async () => DEFAULT_DCAP_PARAMS,
  saveDcapConfig: async (c: any) => c,
};
const ws: any = { connectionStatus: 'open', subscribe: () => () => {}, onStatusChange: () => () => {} };

const INDICATORS: any = { ma: true, macd: false, kdj: false, boll: false, dcap: true };
const CODE = '518880';
const BASE_PERIOD = '15m';
const VIEWPORT_BARS = 120;
const SATS = ['1h', '5m', '1d'] as const;

// ── 几何读数（真实 rect；与 P5-A harness 同口径）────────────────────────────────────────────
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

/** 各 pane 的**真实渲染高度**（rect，不是声明值）——R1/R2 判据用真实像素。 */
function domHeights(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of Array.from(document.querySelectorAll('[data-mp-pane]'))) {
    const period = el.getAttribute('data-mp-pane');
    if (!period) continue;
    out[period] = Math.round((rect(el)?.height ?? 0) * 100) / 100;
  }
  return out;
}

/** 各 pane 的**声明/分配**高度（inline px）——与真实 rect 互证。 */
function declaredHeights(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of Array.from(document.querySelectorAll('[data-mp-pane]'))) {
    const period = el.getAttribute('data-mp-pane');
    if (!period) continue;
    const attr = el.getAttribute('data-mp-pane-height');
    out[period] = attr !== null ? Number(attr) : Math.round(Number.parseFloat((el as HTMLElement).style.height));
  }
  return out;
}

// ── 父层 + 栈（真实产品组件）────────────────────────────────────────────────────────────────
function App() {
  ensureDcapIndicatorRegistered();
  const [heights, setHeights] = useState<Record<string, number>>({ ...W.__server });
  const feed = useMemo(
    () => new KlineDataFeed({ api, ws, code: CODE, period: BASE_PERIOD, viewportBars: VIEWPORT_BARS, warmupBars: 0 }),
    [],
  );

  // 「仅改卫星高度」的父层变更入口（R1 依赖完整性探针：不经过任何拖拽）
  useEffect(() => {
    W.__r1r2.setHeights = (h: Record<string, number>) => setHeights((prev) => ({ ...prev, ...h }));
    W.__r1r2.resetToServer = () => setHeights({ ...W.__server });
  }, []);

  const onHeightsChange = useCallback((h: Record<string, number>) => {
    const body = { ...h };
    W.__payloads.push({ ...body, __dom: domHeights(), __at: Date.now() });
    // 乐观写 + 桩「PUT」+ 成功回显（父层 props 成为权威）；返回 Promise ⇒ §6.3 父层接管
    setHeights((prev) => ({ ...prev, ...body }));
    return api.saveMultiPeriodConfig({
      enabled: true,
      periods: [BASE_PERIOD, ...SATS],
      heights: body,
      indicators: ['dcap'],
    });
  }, []);

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
        baseHeight={heights[BASE_PERIOD]}
        availableHeight={AVAILABLE}
        onHeightsChange={onHeightsChange}
        satellites={SATS.map((p) => ({ period: p as never, height: heights[p] ?? 180 }))}
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

W.__r1r2 = {
  version: 'p5-r1r2-harness/1',
  available: AVAILABLE,
  server0: { ...SERVER0 },
  /** 真实 rect 高度（判据口径）。 */
  domHeights,
  /** 分配/声明高度（与 rect 互证用）。 */
  declaredHeights,
  payloads: () => W.__payloads,
  payloadErrors: () => W.__setPayloadErrors,
  server: () => ({ ...W.__server }),
  /** 分隔条命中点（runner 用真鼠标事件拖拽）。 */
  sepPoint(key: string) {
    const el = document.querySelector(`[data-mp-separator="${key}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  },
  measure() {
    const main = document.querySelector('#main') as HTMLElement | null;
    const stack = document.querySelector('[data-mp-stack]') as HTMLElement | null;
    return {
      available: AVAILABLE,
      domHeights: domHeights(),
      declaredHeights: declaredHeights(),
      main: main ? { clientHeight: main.clientHeight, scrollHeight: main.scrollHeight } : null,
      stack: stack ? { clientHeight: stack.clientHeight, scrollHeight: stack.scrollHeight } : null,
      payloads: W.__payloads.length,
      writes: W.__writes,
    };
  },
  setHeights: (_h: Record<string, number>) => {
    throw new Error('setHeights 尚未就绪');
  },
  resetToServer: () => {},
};

createRoot(document.getElementById('app')!).render(<App />);
