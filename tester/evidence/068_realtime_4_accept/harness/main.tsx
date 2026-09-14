import '@/index.css';
/**
 * 临时独立验收底座（tester 自建；跑完即删，不入库）：
 * 用**仓库真实模块**（WsClient / createHttpClient / KlineDataFeed / KlineChart）在真实浏览器里跑，
 * HTTP 与 WS 都打向真实临时后端（static_dir 与本底座同源）；对外暴露 window.__H__ 观测面。
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WsClient } from '@/ws/WsClient';
import { createHttpClient } from '@/api/client';
import { KlineDataFeed } from '@/features/dashboard/feed';
import { resetRealtimePollGateForTest } from '@/features/dashboard/realtimePoll';
import { KlineChart } from '@/features/dashboard/KlineChart';
import type { Period } from '@/api/types';

const q = new URLSearchParams(location.search);
const code = q.get('code') ?? '518880';
const period = (q.get('period') ?? '15m') as Period;
const viewportBars = Number(q.get('bars') ?? 120);

const _OW = window.WebSocket;
(window as unknown as { WebSocket: unknown }).WebSocket = class extends _OW {
  constructor(...a: ConstructorParameters<typeof WebSocket>) {
    super(...a);
    this.addEventListener('message', (e: MessageEvent) => {
      const H = (window as unknown as { __H__?: { frames: string[] } }).__H__;
      if (H && typeof e.data === 'string') H.frames.push(e.data);
    });
  }
} as never;
const ws = new WsClient({ url: () => 'ws://127.0.0.1:8081/ws' });
const api = createHttpClient('');
const feed = new KlineDataFeed({ api, ws, code, period, viewportBars });

let followNow = true;
let setFollowState: (v: boolean) => void = () => {};
let conns = 0;
const OriginalWS = window.WebSocket;
(window as unknown as { WebSocket: unknown }).WebSocket = class extends OriginalWS {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    conns += 1;
  }
};

// 观测面：WS 连接次数 / 连接状态时间线 / 数据面 / 可观测 stats / 制造断口 / 手动触发兜底
const timeline: Array<{ t: number; s: string }> = [];
let rtCount = 0;
feed.onRealtime(() => { rtCount += 1; });
ws.onStatusChange((s) => timeline.push({ t: Date.now(), s }));

function App() {
  const [follow, setFollow] = useState(true);
  followNow = follow;
  setFollowState = setFollow;
  useEffect(() => {
    ws.connect();
    void feed.loadInitial();
    return () => feed.dispose();
  }, []);
  return (
    <div style={{ width: 1200, height: 640 }}>
      <KlineChart
        feed={feed}
        code={code}
        period={period}
        followLatest={follow}
        indicators={{ ma: true, vol: true, dcap: false } as never}
        onManualZoom={() => setFollow(false)}
      />
    </div>
  );
}

(window as unknown as { __H__: unknown }).__H__ = {
  ws,
  feed,
  api,
  code,
  period,
  conns: () => conns,
  dataList: () => feed.bars.map((b) => b.ts),
  dataLen: () => feed.bars.length,
  bars: () => feed.bars,
  stats: () => feed.realtimeStats,
  status: () => ws.connectionStatus,
  timeline: () => timeline.slice(),
  follow: () => followNow,
  setFollow: (v: boolean) => setFollowState(v),
  truncateLast: (n: number) => {
    feed.bars = feed.bars.slice(0, Math.max(1, feed.bars.length - n));
  },
  pollNow: () => feed.pollIncrement('poll'),
  inject: (msg: unknown) => {
    const s = (ws as unknown as { socket: WebSocket | null }).socket;
    if (s && s.readyState === 1) {
      (s as unknown as { onmessage: (e: { data: string }) => void }).onmessage({ data: JSON.stringify(msg) });
      return true;
    }
    return false;
  },
  // 宫格合并/限流：同 (code,period) 3 图 + 3 个不同标的，同时发起兜底取数（计数由 Playwright 侧 request 事件）
  multiPollDistinct: async () => {
    resetRealtimePollGateForTest();
    const codes = ['161226', '513310', '159915', '510050', '512480', '513050'];
    const feeds = codes.map((c) => new KlineDataFeed({ api, ws, code: c, period, viewportBars }));
    const results = await Promise.all(feeds.map((f) => f.pollIncrement('poll')));
    feeds.forEach((f) => f.dispose());
    return results;
  },
  multiPoll: async () => {
    resetRealtimePollGateForTest();
    const feeds = [
      new KlineDataFeed({ api, ws, code, period, viewportBars }),
      new KlineDataFeed({ api, ws, code, period, viewportBars }),
      new KlineDataFeed({ api, ws, code, period, viewportBars }),
      new KlineDataFeed({ api, ws, code: '161226', period, viewportBars }),
      new KlineDataFeed({ api, ws, code: '513310', period, viewportBars }),
      new KlineDataFeed({ api, ws, code: '159915', period, viewportBars }),
    ];
    const results = await Promise.all(feeds.map((f) => f.pollIncrement('poll')));
    feeds.forEach((f) => f.dispose());
    return results;
  },
  rtCount: () => rtCount,
  lastBar: () => feed.bars.at(-1) ?? null,
  visible: null,
  mode: q.get('mode') ?? 'chart',
};

createRoot(document.getElementById('root')!).render(<App />);

// ── 068 追加：2×2 宫格（4 图同标同周期）限流/合并计数入口 ──
(window as unknown as { __H__: Record<string, unknown> }).__H__.grid2x2 = async () => {
  resetRealtimePollGateForTest();
  const fs = [0, 1, 2, 3].map(() => new KlineDataFeed({ api, ws, code, period, viewportBars }));
  const r = await Promise.all(fs.map((f) => f.pollIncrement('poll')));
  fs.forEach((f) => f.dispose());
  return r.map((x) => (Array.isArray(x) ? x.length : -1));
};
// 记录入站 WS 原始帧（供「重放真实帧」用；只读副本，不干预应用逻辑）
(window as unknown as { __H__: Record<string, unknown> }).__H__.frames = [] as string[];
