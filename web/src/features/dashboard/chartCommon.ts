import type { Chart, KLineData, Period as KcPeriod } from 'klinecharts';
import type { Bar, Period } from '@/api/types';

/** Period（骨架契约）→ klinecharts Period */
export const PERIOD_MAP: Record<Period, KcPeriod> = {
  '1m': { type: 'minute', span: 1 },
  '5m': { type: 'minute', span: 5 },
  '15m': { type: 'minute', span: 15 },
  '1h': { type: 'hour', span: 1 },
  '1d': { type: 'day', span: 1 },
  '1w': { type: 'week', span: 1 },   // 周线（klinecharts week 周期）
  '1mo': { type: 'month', span: 1 }, // 月线（klinecharts month 周期）
};

export function toKcData(bar: Bar): KLineData {
  return {
    timestamp: Date.parse(bar.ts),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    turnover: bar.amount,
  };
}

/** 深色交易终端风（红涨绿跌，token 与 index.css 一致） */
export function applyDarkTerminalStyles(chart: Chart): void {
  chart.setStyles({
    candle: {
      bar: {
        upColor: '#ff5c6c',
        downColor: '#00e0a4',
        noChangeColor: '#8b93b0',
        upBorderColor: '#ff5c6c',
        downBorderColor: '#00e0a4',
        noChangeBorderColor: '#8b93b0',
        upWickColor: '#ff5c6c',
        downWickColor: '#00e0a4',
        noChangeWickColor: '#8b93b0',
      },
      tooltip: {
        title: { color: '#8b93b0' },
        legend: { color: '#8b93b0' },
      },
    },
    indicator: {
      ohlc: { upColor: '#ff5c6c', downColor: '#00e0a4', noChangeColor: '#8b93b0' },
      tooltip: { title: { color: '#8b93b0' }, legend: { color: '#8b93b0' } },
    },
    grid: {
      horizontal: { color: 'rgba(255,255,255,.07)' },
      vertical: { color: 'rgba(255,255,255,.07)' },
    },
    xAxis: { tickText: { color: '#8b93b0' }, axisLine: { color: 'rgba(255,255,255,.07)' } },
    yAxis: { tickText: { color: '#8b93b0' }, axisLine: { color: 'rgba(255,255,255,.07)' } },
    crosshair: {
      horizontal: { line: { color: '#38bdf8' }, text: { color: '#e5e9f2' } },
      vertical: { line: { color: '#38bdf8' }, text: { color: '#e5e9f2' } },
    },
  });
}
