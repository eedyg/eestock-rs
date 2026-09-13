/**
 * 诊断 问题① 第二 harness（真实骨架 + 真实 KlineChart + 真实 klinecharts 10.0.3；/tmp 沙箱，不进仓库）。
 *
 * 与线上差异 = 0（除数据源为假 feed）：
 *  - 骨架：直接 import 仓库真实 tangle 生成物 `web/src/layouts/DashboardGrid.tsx`（未手改）；
 *  - 样式：注入**线上 8081 当前构建的 CSS**（/tmp/live.css，取自 https://localhost:8081/assets/index-*.css）；
 *  - 图表：import 仓库真实 `KlineChart.tsx`（真实 syncIndicators/INDICATOR_DEFS）；
 *  - klinecharts：真实 10.0.3（经 kc-spy 记录实例与调用序列）。
 *
 * 变体（最小差异，只有一行不同）：
 *  A 'dcap'   —— 调 ensureDcapIndicatorRegistered()（= 线上）
 *  B 'nodcap' —— **不调**（DCAP 未注册；createIndicator 失败 ⇒ 永不存在 DCAP pane）
 */
import { createElement, StrictMode, useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardGrid } from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/layouts/DashboardGrid';
import { KlineChart } from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/dashboard/KlineChart';
import { ensureDcapIndicatorRegistered } from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcapIndicator';

type IndicatorName = 'ma' | 'macd' | 'kdj' | 'boll' | 'dcap';
type Indicators = Record<IndicatorName, boolean>;

interface Bar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

interface AnyChart {
  id?: string;
  getPaneOptions(id?: string): any[];
  getIndicators(filter?: unknown): Array<{ name?: string; paneId?: string; id?: string }>;
  getDrawPanes(): Array<{ getId(): string }>;
  getSeparatorPanes(): Map<unknown, unknown>;
  setPaneOptions(options: unknown): void;
}

const w = window as unknown as {
  __CHARTS__?: AnyChart[];
  __CALLS__?: string[];
  __VARIANT__?: string;
  __STRICT__?: boolean;
  __READY__?: boolean;
  __ctl?: Record<string, unknown>;
};

function makeBars(n: number): Bar[] {
  const t0 = Date.UTC(2026, 0, 5, 1, 30, 0);
  const bars: Bar[] = [];
  let close = 12.5;
  for (let i = 0; i < n; i++) {
    close = close * (1 + 0.004 * Math.sin(i / 7) + 0.001 * Math.cos(i / 3));
    const open = close * (1 - 0.0015 * Math.cos(i / 5));
    bars.push({
      ts: new Date(t0 + i * 15 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1000 + Math.round(100 * Math.abs(Math.sin(i / 4))),
      amount: 0,
    });
  }
  return bars;
}

const BARS = makeBars(260);
const makeFeed = () => ({
  bars: BARS,
  hasMore: false,
  viewportBars: 120,
  loadInitial: async () => {},
  loadBefore: async () => 0,
  onRealtime: () => () => {},
});

const live = () => (w.__CHARTS__ ?? []).slice(-1)[0] ?? null;

function ChartMount() {
  const [indicators, setIndicators] = useState<Indicators>({
    ma: true,
    macd: false,
    kdj: false,
    boll: false,
    dcap: false,
  });
  const feed = useMemo(makeFeed, []);
  const setIndicator = useCallback((n: IndicatorName, on: boolean) => {
    setIndicators((p) => ({ ...p, [n]: on }));
  }, []);

  w.__ctl = {
    setIndicator,
    /** 与 live-probe.mjs 完全相同的探针（保证线上/沙箱结果可直接对比） */
    snap: (label: string) => {
      const main = document.querySelector('[data-region="main-chart"]') as HTMLElement | null;
      const sub = document.querySelector('[data-region="sub-chart"]') as HTMLElement | null;
      const host = document.querySelector('[k-line-chart-id]') as HTMLElement | null;
      const kc = (host?.firstElementChild as HTMLElement) ?? null;
      const c = live();
      if (!main || !kc) return { label, error: 'no main/kc' };
      const mrect = main.getBoundingClientRect();
      const rel = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { topInMain: +(r.top - mrect.top).toFixed(2), h: +r.height.toFixed(2), w: +r.width.toFixed(2) };
      };
      const cs = sub ? getComputedStyle(sub) : null;
      const seps: Array<Record<string, unknown>> = [];
      for (const el of Array.from(kc.children)) {
        const widget = el.firstElementChild as HTMLElement | null;
        if (widget && widget.style.cursor === 'ns-resize') {
          seps.push({ ...rel(el), bg: getComputedStyle(el).backgroundColor });
        }
      }
      const lines: Array<Record<string, unknown>> = [];
      for (const el of Array.from(main.querySelectorAll('*'))) {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const bw = parseFloat(s.borderTopWidth || '0');
        const isSep = !!el.firstElementChild && (el.firstElementChild as HTMLElement).style.cursor === 'ns-resize';
        const thinBg = r.height <= 3 && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
        if (isSep || (bw > 0 && s.borderTopStyle !== 'none' && r.width > 100) || thinBg) {
          lines.push({
            tag: el.tagName + (el.dataset?.region ? `[data-region=${el.dataset.region}]` : '') + (isSep ? '[klinecharts-separator]' : ''),
            kind: isSep ? 'klinecharts-separator' : bw > 0 ? `border-top ${s.borderTopWidth} ${s.borderTopColor}` : `bg ${s.backgroundColor}`,
            ...rel(el),
          });
        }
      }
      const paneGeomDom: Array<Record<string, unknown>> = [];
      for (const el of Array.from(kc.children)) {
        const widget = el.firstElementChild as HTMLElement | null;
        if (widget && widget.style.cursor === 'ns-resize') continue;
        paneGeomDom.push(rel(el));
      }
      const paneOptions = c ? c.getPaneOptions().map((p) => ({ id: p.id, height: p.height, minHeight: p.minHeight, state: p.state })) : [];
      const indicatorsList = c ? c.getIndicators().map((i) => ({ name: i.name, paneId: i.paneId })) : [];
      const used = new Set(indicatorsList.map((i) => i.paneId));
      return {
        label,
        variant: w.__VARIANT__,
        mainChart: { h: +mrect.height.toFixed(2), w: +mrect.width.toFixed(2) },
        subChartAnchor: sub
          ? { ...rel(sub), borderTopWidth: cs!.borderTopWidth, borderTopColor: cs!.borderTopColor, borderTopStyle: cs!.borderTopStyle }
          : null,
        paneGeomDom,
        paneOptions,
        emptyPanes: paneOptions.filter((p) => p.id !== 'candle_pane' && p.id !== 'x_axis_pane' && !used.has(p.id)).map((p) => p.id),
        indicators: indicatorsList,
        separatorCount: seps.length,
        separatorCountApi: c ? c.getSeparatorPanes().size : null,
        expectedSeparatorsByPaneCount: Math.max(paneOptions.filter((p) => p.id !== 'x_axis_pane').length - 1, 0),
        horizontalLineCandidates: lines,
      };
    },
    /** 用公开 API 设 VOL pane 高度（等价用户拖高 VOL） */
    setVolHeight: (h: number) => {
      const c = live();
      if (!c) return 'no chart';
      const volPanes = c.getIndicators().filter((i) => i.name === 'VOL').map((i) => i.paneId);
      const p = c.getPaneOptions().find((x) => volPanes.includes(x.id));
      if (!p) return 'no VOL pane';
      c.setPaneOptions({ id: p.id, height: h });
      return p.id;
    },
  };

  return createElement(KlineChart, {
    feed: feed as never,
    code: 'TEST.SS',
    period: '15m',
    followLatest: true,
    indicators,
    onManualZoom: () => {},
    maWindows: [5, 10, 20],
  });
}

async function boot() {
  const variant = w.__VARIANT__ ?? 'dcap';
  // ★ 变体差异：唯一一行（'dcap'=线上；其余变体不预注册）
  if (variant === 'dcap') ensureDcapIndicatorRegistered();

  const host = document.createElement('div');
  host.style.cssText = 'display:flex;width:1440px;height:900px;';
  document.body.appendChild(host);

  createRoot(host).render(
    createElement(DashboardGrid as never, {
      symbols: [{ code: 'TEST.SS', name: 'TEST', enabled: true, last: 12.5, changePct: 0.5 }],
      selected: 'TEST.SS',
      onSelectSymbol: () => {},
      period: '15m',
      onPeriodChange: () => {},
      gridMode: 'single',
      onGridModeChange: () => {},
      followLatest: true,
      onBackToLatest: () => {},
      onLoadBefore: () => {},
    }),
  );
  await new Promise((r) => setTimeout(r, 200));

  const anchor = document.querySelector('[data-region="main-chart"]') as HTMLElement;
  const chartHost = document.createElement('div');
  chartHost.style.cssText = 'position:relative;height:100%;width:100%;';
  anchor.appendChild(chartHost);
  const el = createElement(ChartMount);
  createRoot(chartHost).render(w.__STRICT__ ? createElement(StrictMode, null, el) : el);
  await new Promise((r) => setTimeout(r, 500));
  w.__READY__ = true;
}

void boot();
