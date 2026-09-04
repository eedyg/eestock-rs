import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { SourcesGrid } from '@/layouts/SourcesGrid';
import { defaultApi } from '@/api';
import { defaultWs } from '@/ws';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { RegionPortal } from '@/components/RegionPortal';
import { SourcesStore } from './store';
import { SourcesSummaryBar } from './SourcesSummaryBar';
import { SourceCards } from './SourceCards';
import { SourceDetailPanel } from './SourceDetailPanel';
import { GapCards } from './GapCards';
import { AlertPreview } from './AlertPreview';

/**
 * 页面②数据源诊断：以 tangle 骨架 SourcesGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 * 健康数据 GET /api/sources/health + WS source_health 实时刷新（store 承载）。
 */
export function SourcesPage({ api = defaultApi, ws = defaultWs }: { api?: ApiClient; ws?: WsClient }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const store = useMemo(() => new SourcesStore({ api, ws }), [api, ws]);
  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1">
      <SourcesGrid
        selectedSource={state.selected}
        onSelectSource={(id) => store.selectSource(id)}
        detailRange={state.detailRange}
        onDetailRangeChange={(r) => store.setDetailRange(r)}
        onResetCircuit={(id) => void store.resetCircuit(id)}
      />
      <RegionPortal root={rootRef} region="summary-bar">
        <SourcesSummaryBar health={state.health.data} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="source-cards">
        {state.health.error && (
          <div className="flex w-full items-center gap-3 p-3 text-xs text-up">
            <span>健康数据加载失败:{state.health.error}</span>
            <button
              type="button"
              onClick={() => void store.refreshHealth()}
              className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt"
            >
              重试
            </button>
          </div>
        )}
        <SourceCards
          health={state.health.data}
          selected={state.selected}
          flashes={state.flashes}
          resetting={state.resetting}
          resetErrors={state.resetErrors}
          onSelect={(id) => store.selectSource(id)}
          onReset={(id) => void store.resetCircuit(id)}
        />
      </RegionPortal>
      {state.selected && state.detail && (
        <RegionPortal root={rootRef} region="detail-panel">
          <SourceDetailPanel
            detail={state.detail}
            range={state.detailRange}
            onRangeChange={(r) => store.setDetailRange(r)}
          />
        </RegionPortal>
      )}
      <RegionPortal root={rootRef} region="gap-cards">
        <GapCards
          symbols={state.symbols.data ?? []}
          selectedCode={state.selectedCode}
          slice={state.gaps}
          onSelectCode={(c) => store.selectCode(c)}
          onRetry={() => void store.retryGaps()}
        />
      </RegionPortal>
      <RegionPortal root={rootRef} region="alert-preview">
        <AlertPreview
          alerts={state.alerts.data}
          loading={state.alerts.loading}
          error={state.alerts.error}
        />
      </RegionPortal>
    </div>
  );
}
