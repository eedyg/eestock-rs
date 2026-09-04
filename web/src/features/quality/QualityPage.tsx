import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { QualityGrid } from '@/layouts/QualityGrid';
import { defaultApi } from '@/api';
import type { ApiClient } from '@/api/client';
import { RegionPortal } from '@/components/RegionPortal';
import { QualityStore } from './store';
import { QualityFilterBar } from './QualityFilterBar';
import { DivergenceTable } from './DivergenceTable';
import { OverlayChart } from './OverlayChart';
import { AccuracyCards } from './AccuracyCards';
import { SyncPanel } from './SyncPanel';
import { GapReportList } from './GapReportList';

/**
 * 页面④数据质量：以 tangle 骨架 QualityGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 * 数据流：四端点 REST 各载三态（store 承载）；过滤变更即重查；视图切换客户端完成。
 * 页面纪律（04-quality §6 / ADR-003）：纯只读 + 同步触发（本期触发按钮置灰，wave-2.md 边界）。
 */
export function QualityPage({ api = defaultApi }: { api?: ApiClient }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const store = useMemo(() => new QualityStore({ api }), [api]);
  useEffect(() => {
    void store.init();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { code, range, view } = state.filter;

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1">
      <QualityGrid
        code={code}
        range={range}
        view={view}
        onFilterChange={(c, r) => void store.setFilter({ code: c, range: r })}
        onViewChange={(v) => store.setView(v)}
        onJumpToKline={(c, ts) =>
          navigate(`/?code=${encodeURIComponent(c)}&ts=${encodeURIComponent(ts)}`)
        }
        // POST /api/tushare/sync 暂缓（wave-2.md 边界，父级裁决 2026-09-04）：按钮置灰，回调不接线
        onTriggerSync={() => {}}
        syncRunning={false}
      />
      <RegionPortal root={rootRef} region="filter-bar">
        <QualityFilterBar
          symbols={state.symbols}
          code={code}
          range={range}
          view={view}
          onFilterChange={(c, r) => void store.setFilter({ code: c, range: r })}
          onViewChange={(v) => store.setView(v)}
        />
      </RegionPortal>
      <RegionPortal root={rootRef} region="divergence-table">
        <DivergenceTable
          slice={state.divergence}
          onJump={(ts) => code && navigate(`/?code=${encodeURIComponent(code)}&ts=${encodeURIComponent(ts)}`)}
          onRetry={() => void store.retryDivergence()}
        />
      </RegionPortal>
      <RegionPortal root={rootRef} region="overlay-chart">
        <OverlayChart slice={state.divergence} onRetry={() => void store.retryDivergence()} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="accuracy-cards">
        <AccuracyCards slice={state.accuracy} onRetry={() => void store.retryAccuracy()} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="sync-panel">
        <SyncPanel slice={state.tushare} onRetry={() => void store.retryTushare()} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="gap-report">
        <GapReportList slice={state.gaps} onRetry={() => void store.retryGaps()} />
      </RegionPortal>
    </div>
  );
}
