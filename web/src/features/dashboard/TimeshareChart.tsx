import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { KlineDataFeed } from './feed';
import { computeTimeshare, type TimesharePoint } from './timeshare';
import { shanghaiDayKey } from '@/shell/session';

const W = 1000;
const H = 300;
const PAD = 8;

function polyline(points: TimesharePoint[], min: number, max: number, pick: (p: TimesharePoint) => number): string {
  const span = max - min || 1;
  return points
    .map((p, i) => {
      const x = (i / Math.max(points.length - 1, 1)) * (W - PAD * 2) + PAD;
      const y = H - PAD - ((pick(p) - min) / span) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * 分时 Tab（定稿 1b）：当日价格线 + 均价线，由 1m bar 客户端计算（零额外接口）。
 * 轻量 SVG 实现（klinecharts 为 K线导向；分时仅当日单日线，SVG 足够）。
 * O1（定稿 1c 实时）：订阅 WS `bar:<code>:1m`（复用 feed.realtime 机制），
 * 当日线随新 1m bar append/update 实时前进，盘中不重挂载也刷新。
 */
export function TimeshareChart({ api, ws, code }: { api: ApiClient; ws: WsClient; code: string }) {
  const [points, setPoints] = useState<TimesharePoint[]>([]);
  const [failed, setFailed] = useState(false);
  // 复用 KlineDataFeed：1m 数据流 + WS 实时 append/update（零额外接口）
  const feed = useMemo(() => new KlineDataFeed({ api, ws, code, period: '1m' }), [api, ws, code]);

  // 重算：仅取当日 1m bar → 价格线+均价线（当日线收盘价 + 累计成交额/成交量）
  const update = useCallback(() => {
    if (feed.status === 'error') {
      setFailed(true);
      return;
    }
    if (feed.bars.length === 0) {
      setFailed(false);
      setPoints([]);
      return;
    }
    const today = shanghaiDayKey(new Date());
    const todayBars = feed.bars.filter((b) => shanghaiDayKey(new Date(Date.parse(b.ts))) === today);
    setFailed(false);
    setPoints(computeTimeshare(todayBars));
  }, [feed]);

  useEffect(() => {
    let alive = true;
    const guarded = () => {
      if (alive) update();
    };
    const offChange = feed.onChange(guarded);
    const offRt = feed.onRealtime(guarded); // append/update 实时触发
    void feed.loadInitial();
    return () => {
      alive = false;
      offChange();
      offRt();
      feed.dispose();
    };
  }, [feed, update]);

  if (failed) {
    return <div className="flex h-full items-center justify-center text-xs text-dim">分时数据加载失败</div>;
  }
  if (points.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-dim">该时段无数据</div>;
  }

  const values = points.flatMap((p) => [p.price, p.avg]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const last = points[points.length - 1]!;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
      <polyline points={polyline(points, min, max, (p) => p.avg)} fill="none" stroke="#a78bfa" strokeWidth="1.5" />
      <polyline points={polyline(points, min, max, (p) => p.price)} fill="none" stroke="#38bdf8" strokeWidth="2" />
      <text x={W - 120} y={24} fontSize={14} fill="#38bdf8" className="num">
        {last.price.toFixed(3)}
      </text>
      <text x={W - 120} y={44} fontSize={11} fill="#a78bfa" className="num">
        均价 {last.avg.toFixed(3)}
      </text>
    </svg>
  );
}
