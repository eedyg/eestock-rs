import type { Bar } from '@/api/types';

export interface TimesharePoint {
  ts: string;
  price: number; // 价格线：1m bar 收盘价
  avg: number; // 均价线：累计成交额 / 累计成交量
}

/** 分时数据（定稿 1b：当日价格线+均价线，1m bar 客户端计算，零额外接口） */
export function computeTimeshare(bars: Bar[]): TimesharePoint[] {
  let cumVol = 0;
  let cumAmt = 0;
  return bars.map((b) => {
    cumVol += b.volume;
    cumAmt += b.amount;
    return { ts: b.ts, price: b.close, avg: cumVol > 0 ? cumAmt / cumVol : b.close };
  });
}
