/** P1-C 独立探针②：多周期开关的 UI 行为（乐观更新 / 失败回滚 / 零残留 / enabled=true 单图无错）。 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import fs from 'node:fs';

const chartCalls: string[] = [];
const chartStub: any = new Proxy({}, {
  get(_t, p: string) {
    if (p === 'then' || p === 'constructor') return undefined;
    return (...args: any[]) => {
      chartCalls.push(`${p}(${args.map((a) => JSON.stringify(a)).join(',')})`);
      if (p === 'getIndicators') return [{}];
      if (p === 'getVisibleRange') return { from: 0, to: 1, realFrom: 0, realTo: 1 };
      return undefined;
    };
  },
});
const initMock = vi.fn(() => chartStub);
vi.mock('klinecharts', () => ({ init: (...a: any[]) => initMock(...a), dispose: vi.fn() }));
import { DashboardPage } from './DashboardPage';

const SYMBOLS = [{ code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 }];
const MP_OFF = { enabled: false, periods: ['1m'], heights: { '1m': 420 }, indicators: ['dcap'] };
const apiLog: string[] = [];
const pending: Array<{ resolve: (v: any) => void; reject: (e: any) => void; body: any }> = [];

function makeApi() {
  const base: any = {
    getSymbols: async () => SYMBOLS,
    getKline: async () => [{ ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 1, amount: 1 }],
    getMultiPeriodConfig: async () => MP_OFF,
    getKlineConfig: async () => ({ viewport_bars: 120, default_period: '15m' }),
    getDcapConfig: async () => ({ short: 5, long: 20, signal: 9, top: 0.02, bottom: 0.02, bars: 60, enabled: true }),
    getMaConfig: async () => ({ windows: [5, 10, 20] }),
    saveMultiPeriodConfig: (body: any) => new Promise((resolve, reject) => pending.push({ resolve, reject, body })),
  };
  return new Proxy({}, {
    get(_t, p: string) {
      if (p === 'then') return undefined;
      const fn = base[p];
      if (typeof fn !== 'function') return undefined;
      return (...args: any[]) => {
        apiLog.push(`${p}(${args.map((a) => JSON.stringify(a)).join(',')})`);
        try { return Promise.resolve(fn.apply(base, args)); } catch (e) { return Promise.reject(e); }
      };
    },
  });
}
const wsTopics = new Map<string, number>();
const ws: any = {
  subscribe(topic: string) { wsTopics.set(topic, (wsTopics.get(topic) ?? 0) + 1); return () => {}; },
  connectionStatus: 'open', close() {}, send() {},
};

const out: any = { steps: [] };
const snap = (label: string, container: HTMLElement) => {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('多周期'));
  out.steps.push({
    label,
    pressed: btn?.getAttribute('aria-pressed') ?? null,
    initCalls: initMock.mock.calls.length,
    wsTopics: Object.fromEntries([...wsTopics.entries()].sort()),
    klineCalls: apiLog.filter((x) => x.startsWith('getKline(')).length,
    saveCalls: apiLog.filter((x) => x.startsWith('saveMultiPeriodConfig(')).length,
    satNodes: Array.from(container.querySelectorAll('*')).filter((el) =>
      Array.from(el.attributes).some((a) => /satellite/i.test(a.name) || /satellite/i.test(a.value))).length,
    chartCalls: [...chartCalls].sort(),
  });
};

describe('P1-C 开关行为探针', () => {
  it('乐观更新 / 失败回滚 / 零残留', async () => {
    const api = makeApi();
    const view = render(<MemoryRouter><DashboardPage api={api} ws={ws} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    const btn = () => Array.from(view.container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('多周期'))!;
    snap('t0 初始', view.container);

    // ① 乐观更新：点击后 setEnabled 同步生效（PUT 未决）
    fireEvent.click(btn());
    await waitFor(() => expect(pending.length).toBe(1));
    snap('t1 点击后(PUT 未决)', view.container);
    out.putBody = pending[0]!.body;

    // ② 失败回滚
    await act(async () => { pending[0]!.reject(new Error('boom')); await new Promise((r) => setTimeout(r, 50)); });
    snap('t2 PUT 失败后', view.container);

    // ③ 成功：服务端回显
    fireEvent.click(btn());
    await waitFor(() => expect(pending.length).toBe(2));
    await act(async () => { pending[1]!.resolve({ enabled: true, periods: ['1m'], heights: { '1m': 420 }, indicators: ['dcap'] }); await new Promise((r) => setTimeout(r, 50)); });
    snap('t3 PUT 成功后(enabled=true 单周期)', view.container);

    // ④ 关闭 ⇒ 零残留
    fireEvent.click(btn());
    await waitFor(() => expect(pending.length).toBe(3));
    await act(async () => { pending[2]!.resolve(MP_OFF); await new Promise((r) => setTimeout(r, 120)); });
    snap('t4 关闭后', view.container);

    fs.writeFileSync(process.env.P1C_OUT2!, JSON.stringify(out, null, 2));
    expect(out.steps.length).toBe(5);
  });
});
