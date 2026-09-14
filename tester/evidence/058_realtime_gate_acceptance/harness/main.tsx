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

const ws = new WsClient({ url: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` });
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
