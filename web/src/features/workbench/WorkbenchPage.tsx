import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { defaultApi } from '@/api';
import { defaultWs } from '@/ws';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { WorkbenchStore } from './store';
import { ConfigPanel } from './ConfigPanel';
import { RunList } from './RunList';
import { ResultView } from './ResultView';
import { ComparePanel } from './ComparePanel';

/**
 * 页面⑪ 回测工作台（12-strategy-system / P3b；07-app-plane §1.8 + ADR §13.5 布局）。
 * 布局：左列（配置区 + 运行历史）/ 右列（结果视图 | compare 面板）。
 * 数据流：catalog GET /api/strategies + presets/runs REST + WS strategy_run_progress
 * （引擎 observer 事件驱动，无轮询）；结果 GET …/result；对比 POST …/compare。
 * 既有 /backtest 旧页不动，并存期 D16。
 */
export function WorkbenchPage({ api = defaultApi, ws = defaultWs }: { api?: ApiClient; ws?: WsClient }) {
  const store = useMemo(() => new WorkbenchStore({ api, ws }), [api, ws]);
  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const selectedRun = state.runs.data?.find((r) => r.id === state.selectedRunId) ?? null;

  return (
    <div className="flex min-w-0 flex-1" data-testid="workbench-page">
      {/* 左列：配置区 + 运行管理（min-h-0 约束列高；配置区内部滚动不被挤压，历史区 max-h 有界） */}
      <div className="flex min-h-0 w-[380px] shrink-0 flex-col border-r border-line" data-testid="wb-left-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConfigPanel
          catalog={state.catalog.data}
          catalogLoading={state.catalog.loading}
          catalogError={state.catalog.error}
          onRetryCatalog={() => void store.loadCatalog()}
          symbols={state.symbols.data}
          presets={state.presets.data}
          submitting={state.submitting}
          submitError={state.submitError}
          onSubmit={(req) => void store.submit(req)}
          onApplyPreset={(id) => store.applyPreset(id)}
          onCreatePreset={(name, config) => store.createPreset(name, config)}
          onUpdatePreset={(id, name, config) => store.updatePreset(id, name, config)}
          onRenamePreset={(id, name) => store.renamePreset(id, name)}
          onDeletePreset={(id) => store.deletePreset(id)}
        />
        </div>
        <div className="flex max-h-[45%] shrink-0 flex-col border-t border-line" data-testid="wb-run-history">
          <RunList
            runs={state.runs.data}
            loading={state.runs.loading}
            error={state.runs.error}
            onRetry={() => void store.loadRuns()}
            selectedRunId={state.selectedRunId}
            compareIds={state.compareIds}
            progressMap={state.progressMap}
            onSelectRun={(id) => void store.selectRun(id)}
            onToggleCompare={(id) => store.toggleCompare(id)}
            onCancelRun={(id) => store.cancelRun(id)}
            hasMore={state.hasMore}
            loadingMore={state.loadingMore}
            onLoadMore={() => void store.loadMoreRuns()}
          />
        </div>
      </div>
      {/* 右列：结果视图 / compare 面板（min-h-0 保证内部 overflow 生效，不反向挤压左列） */}
      <div className="min-h-0 min-w-0 flex-1 bg-panel">
        {state.view === 'compare' ? (
          <ComparePanel
            items={state.compare.data}
            loading={state.compare.loading}
            error={state.compare.error}
            onRetry={() => void store.refreshCompare()}
            onExit={() => store.setView('single')}
          />
        ) : (
          <ResultView
            key={selectedRun?.id ?? 'none'}
            run={selectedRun}
            result={state.result.data}
            loading={state.result.loading}
            error={state.result.error}
            onRetry={() => {
              if (state.selectedRunId) void store.loadResult(state.selectedRunId);
            }}
            api={api}
            catalog={state.catalog.data}
            progressMap={state.progressMap}
          />
        )}
      </div>
    </div>
  );
}
