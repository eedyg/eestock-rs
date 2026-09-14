/**
 * P1-C 独立等价探针（Tester 自建，非实现方测试）。
 *
 * 该文件源码**逐字节相同**地放入两个隔离副本：
 *   A) /tmp/p1c/head  = `git archive HEAD`（d6462da 构建）
 *   B) /tmp/p1c/wt    = 工作树（P1 未提交改动）
 * 运行后各自把度量 dump 到 $P1C_OUT，再由 Tester 离线逐字段比对。
 *
 * 度量口径（不含断言，纯观测 ⇒ 不因实现方测试判据而偏向）：
 *  1. 图表实例数：klinecharts.init / dispose 调用次数；
 *  2. DOM：`[data-region=main-chart]` 与 `[data-region=sub-chart]` 子树 (a) 结构指纹
 *     (tag+深度+data-* + type + aria-pressed) (b) 原始 innerHTML；
 *  3. 请求/记账：ApiClient 逐方法调用计数 + 调用参数摘要（排序后集合）；
 *  4. WS 订阅：topic 列表与订阅函数数；
 *  5. 图表桩调用：逐方法计数 + 去重调用序列（指标注册/pane 结构经此暴露）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import fs from 'node:fs';

const chartCalls: string[] = [];
const chartStub: any = new Proxy(
  {},
  {
    get(_t, p: string) {
      if (p === 'then' || p === 'constructor') return undefined;
      return (...args: any[]) => {
        chartCalls.push(`${p}(${args.map((a) => JSON.stringify(a)).join(',')})`);
        if (p === 'getIndicators') return [{}];
        if (p === 'getVisibleRange') return { from: 0, to: 1, realFrom: 0, realTo: 1 };
        if (p === 'getDataList') return [];
        return undefined;
      };
    },
  },
);
const initMock = vi.fn(() => chartStub);
const disposeMock = vi.fn();
vi.mock('klinecharts', () => ({
  init: (...a: any[]) => initMock(...a),
  dispose: (...a: any[]) => disposeMock(...a),
}));

// eslint-disable-next-line import/first
import { DashboardPage } from './DashboardPage';

const SYMBOLS = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
];
const KLINES = [
  { ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
  { ts: '2026-09-04T02:01:00Z', open: 1.05, high: 1.2, low: 1.0, close: 1.1, volume: 120, amount: 126 },
];
const MP_OFF = { enabled: false, periods: ['1m'], heights: { '1m': 420 }, indicators: ['dcap'] };

const apiLog: string[] = [];
let api: any;
function makeApi(base: any) {
  base.getSymbols = async () => SYMBOLS;
  base.getKline = async (_q: any) => KLINES;
  base.getMultiPeriodConfig = async () => MP_OFF;
  base.getKlineConfig = async () => ({
    viewport_bars: 120,
    default_period: '15m',
    periods: ['1m', '5m', '15m', '1h', '1d', '1w'],
  });
  base.getDcapConfig = async () => ({ short: 5, long: 20, signal: 9, top: 0.02, bottom: 0.02, bars: 60, enabled: true });
  base.getMaConfig = async () => ({ windows: [5, 10, 20] });
  const summarize = (a: any) => JSON.stringify(a);
  return new Proxy(
    {},
    {
      get(_t, p: string) {
        if (p === 'then') return undefined;
        const fn = base[p];
        if (typeof fn !== 'function') return undefined;
        return (...args: any[]) => {
          apiLog.push(`${p}(${args.map(summarize).join(',')})`);
          try {
            return Promise.resolve(fn.apply(base, args));
          } catch (e) {
            return Promise.reject(e);
          }
        };
      },
    },
  );
}

const wsTopics = new Map<string, number>();
function makeWs() {
  return {
    subscribe(topic: string, _h: any) {
      wsTopics.set(topic, (wsTopics.get(topic) ?? 0) + 1);
      return () => {
        wsTopics.set(topic, (wsTopics.get(topic) ?? 0) - 1);
      };
    },
    onStatusChange: undefined,
    connectionStatus: 'open',
    close() {},
    send() {},
  } as any;
}

function fingerprint(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node, depth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(`${depth}:text:${t}`);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    const attrs = Array.from(e.attributes)
      .filter((a) => a.name.startsWith('data-') || a.name === 'type' || a.name === 'aria-pressed')
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join(' ');
    parts.push(`${depth}:${e.tagName.toLowerCase()}${attrs ? `[${attrs}]` : ''}`);
    Array.from(e.childNodes).forEach((c) => walk(c, depth + 1));
  };
  walk(el, 0);
  return parts.join('\n');
}

const count = (xs: string[]) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[x.split('(')[0]!] = (m[x.split('(')[0]!] ?? 0) + 1;
  return m;
};

describe('P1-C 等价探针', () => {
  it('dump 关闭态度量', async () => {
    api = makeApi(((await import('@/api/mock')) as any).createMockClient() as any);
    const ws = makeWs();
    const view = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    const q = (s: string) => view.container.querySelector(s);
    const main = q('[data-region="main-chart"]');
    const sub = q('[data-region="sub-chart"]');
    const dump = {
      label: process.env.P1C_LABEL ?? '?',
      mainFound: !!main,
      mainFP: main ? fingerprint(main) : null,
      mainHTML: main ? main.innerHTML : null,
      subHTML: sub ? sub.innerHTML : null,
      containerHTML: view.container.innerHTML,
      initCalls: initMock.mock.calls.length,
      disposeCalls: disposeMock.mock.calls.length,
      apiCounts: count(apiLog),
      apiCallsSorted: [...apiLog].sort(),
      wsTopics: Object.fromEntries([...wsTopics.entries()].sort()),
      chartCounts: count(chartCalls),
      chartCalls: chartCalls,
      chartCallsSorted: [...chartCalls].sort(),
      hasMultiPeriodToggle: Array.from(view.container.querySelectorAll('button')).some((b) =>
        (b.textContent ?? '').includes('多周期'),
      ),
    };
    fs.writeFileSync(process.env.P1C_OUT!, JSON.stringify(dump, null, 2));
    expect(dump.mainFound).toBe(true);
  });
});
