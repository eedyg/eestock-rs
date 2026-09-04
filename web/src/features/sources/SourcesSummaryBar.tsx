import type { SourcesHealth } from '@/api/types';
import { minuteSources, systemLight } from './sourceMeta';

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-[7px] rounded-full border border-line bg-white/5 px-3 py-1 text-xs">
      {children}
    </span>
  );
}

/**
 * 页面②汇总条 H=56（02-sources §2）：1m 可用/总数（降级计可用、熔断计不可用）、
 * 快照池健康/总数、系统状态灯（任一 1m 熔断🟡 / 全部🔴）。
 * 采集运行时长后端无数据源（07 §1.1），交易时段由 shell TopBar 承载——本处不重复。
 */
export function SourcesSummaryBar({ health }: { health: SourcesHealth | null }) {
  if (!health) {
    return (
      <div className="flex h-full items-center gap-3 px-4">
        <span className="h-6 w-24 animate-pulse rounded-full bg-white/5" />
        <span className="h-6 w-24 animate-pulse rounded-full bg-white/5" />
        <span className="h-6 w-28 animate-pulse rounded-full bg-white/5" />
      </div>
    );
  }
  const m1 = minuteSources(health.sources);
  const m1Avail = m1.filter((s) => s.status !== 'circuit_open').length;
  const snap = health.sources.filter((s) => !minuteSources([s]).length);
  const snapHealthy = snap.filter((s) => s.status === 'healthy').length;
  const light = systemLight(health.sources);
  const lightText =
    light === 'crit' ? '全部1m源熔断' : light === 'warn' ? '任一1m源熔断' : '系统正常';
  return (
    <div className="flex h-full items-center gap-3 px-4">
      <Pill>
        1m源{' '}
        <b className="num">
          {m1Avail}/{m1.length}
        </b>
      </Pill>
      <Pill>
        快照池{' '}
        <b className="num">
          {snapHealthy}/{snap.length}
        </b>
      </Pill>
      <Pill>
        <span className={light === 'ok' ? 'dot-live' : light === 'warn' ? 'dot-warn' : 'dot-down'} />
        <span>{lightText}</span>
      </Pill>
    </div>
  );
}
