import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WsConnectionStatus } from '@/ws/WsClient';
import { cn } from '@/lib/utils';

export interface TopBarProps {
  sessionLabel: string;
  sessionTime: string;
  collectorRunning: boolean | null; // null = 健康数据未加载
  healthy1m: number | null;
  total1m: number | null;
  wsStatus: WsConnectionStatus;
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'flex items-center gap-[7px] rounded-full border border-line bg-white/5 px-3 py-1 text-xs',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 顶部状态条 H=40（00-shell：交易时段 / 采集灯 / 1m 源健康数） */
export function TopBar({ sessionLabel, sessionTime, collectorRunning, healthy1m, total1m, wsStatus }: TopBarProps) {
  const healthText = healthy1m == null || total1m == null ? '--/--' : `${healthy1m}/${total1m}`;
  return (
    <header
      data-region="topbar"
      className="flex h-10 shrink-0 items-center gap-3.5 border-b border-line px-4"
    >
      <Pill>
        <span className={sessionLabel === '交易中' ? 'dot-live' : 'dot-idle'} />
        <span>
          {sessionLabel} <span className="num">{sessionTime}</span>
        </span>
      </Pill>
      <Pill>
        <span
          className={
            collectorRunning == null ? 'dot-idle' : collectorRunning ? 'dot-live' : 'dot-down'
          }
        />
        <span>
          {collectorRunning == null ? '采集状态未知' : collectorRunning ? '采集正常' : '采集停止'}
        </span>
      </Pill>
      <Link to="/sources" className="no-underline">
        <Pill className="hover:text-txt">
          <span>
            1m 源健康 <b className="num">{healthText}</b> →数据源诊断
          </span>
        </Pill>
      </Link>
      {wsStatus !== 'open' && (
        <Pill className="ml-auto text-dim">
          <span className="dot-warn" />
          <span>{wsStatus === 'connecting' ? 'WS 连接中…' : 'WS 断开，重连中…'}</span>
        </Pill>
      )}
    </header>
  );
}
