import React, { useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { KlineChart, type KlineChartFeedLike, type KlineOverlay } from '@/features/dashboard/KlineChart';
import type { Bar, Period } from '@/api/types';
import type { DcapParams } from '@/features/indicators/dcapIndicator';

type Ind = { ma: boolean; macd: boolean; kdj: boolean; boll: boolean; dcap: boolean };
interface Ctl {
  code: string;
  period: Period;
  bars: Bar[];
  overlays: KlineOverlay[];
  followLatest: boolean;
  indicators: Ind;
  maWindows: number[];
  dcapParams?: DcapParams;
  warmupBars?: number;
}

let state: Ctl = {
  code: 'AAA', period: '15m', bars: [], overlays: [], followLatest: true,
  indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: false },
  maWindows: [5, 10, 20],
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

const feedCalls: Array<{ code: string; period: string; init: number; before: number }> = [];
let currentRt: Set<(b: Bar) => void> = new Set();

function makeFeed(code: string, period: Period, bars: Bar[]): KlineChartFeedLike {
  const rec = { code, period: period as string, init: 0, before: 0 };
  feedCalls.push(rec);
  const rt = new Set<(b: Bar) => void>();
  currentRt = rt;
  return {
    bars,
    hasMore: false,
    loadInitial: async () => { rec.init++; },
    loadBefore: async () => { rec.before++; return 0; },
    onRealtime: (cb) => { rt.add(cb); return () => rt.delete(cb); },
    viewportBars: 120,
    setWarmupBars: async () => false,
  };
}

const w = window as unknown as Record<string, unknown>;
w.__H__ = {
  set: (patch: Partial<Ctl>) => { state = { ...state, ...patch }; emit(); },
  get: () => state,
  pushRealtime: (bar: Bar) => { currentRt.forEach((cb) => cb(bar)); },
  feedCalls: () => feedCalls.map((f) => ({ ...f })),
  resetCalls: () => { feedCalls.length = 0; },
};

function App() {
  const s = useSyncExternalStore(subscribe, () => state);
  const feed = useMemo(() => makeFeed(s.code, s.period, s.bars), [s.code, s.period, s.bars]);
  return (
    <KlineChart
      feed={feed}
      code={s.code}
      period={s.period}
      followLatest={s.followLatest}
      indicators={s.indicators}
      onManualZoom={() => {}}
      overlays={s.overlays}
      maWindows={s.maWindows}
      dcapParams={s.dcapParams}
      warmupBars={s.warmupBars}
    />
  );
}

createRoot(document.getElementById('host')!).render(<App />);
