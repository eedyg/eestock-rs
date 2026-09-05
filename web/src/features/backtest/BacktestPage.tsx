import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { BacktestGrid } from '@/layouts/BacktestGrid';
import { defaultApi } from '@/api';
import { defaultWs } from '@/ws';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { RegionPortal } from '@/components/RegionPortal';
import { BacktestStore } from './store';
import { StrategyForm } from './StrategyForm';
import { TaskList } from './TaskList';
import { ResultOverview } from './ResultOverview';
import { MetricCards } from './MetricCards';
import { TradeTable } from './TradeTable';
import { PeriodHeatmap } from './PeriodHeatmap';
import { CompareView } from './CompareView';
import { GridRank } from './GridRank';

/**
 * 页面⑤回测工作台：以 tangle 骨架 BacktestGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 * 数据流：strategies GET /api/backtest/strategies + runs GET /api/backtest/runs + WS backtest_progress；
 * 选中结果 GET /api/backtest/runs/{id}；对比 GET /api/backtest/compare?ids=；提交 POST /api/backtest/runs（网格展开）。
 */
export function BacktestPage({ api = defaultApi, ws = defaultWs }: { api?: ApiClient; ws?: WsClient }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const store = useMemo(() => new BacktestStore({ api, ws }), [api, ws]);
  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const selectedRun = state.runDetail.data;
  const loadSelected = () => {
    if (state.selectedRunId != null) void store.loadRunDetail(state.selectedRunId);
  };

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1">
      <BacktestGrid
        resultView={state.resultView}
        selectedRunId={state.selectedRunId != null ? String(state.selectedRunId) : null}
        compareIds={state.compareIds.map(String)}
        onSelectRun={(id) => void store.selectRun(Number(id))}
        onToggleCompare={(id) => store.toggleCompare(Number(id))}
        onSubmit={(p) => void store.submit(p)}
        onJumpToKline={(code, from, _to) =>
          navigate(`/?code=${encodeURIComponent(code)}&ts=${encodeURIComponent(from)}`)
        }
      />

      <RegionPortal root={rootRef} region="strategy-form">
        <StrategyForm
          strategies={state.strategies.data}
          loading={state.strategies.loading}
          error={state.strategies.error}
          onRetry={() => void store.loadStrategies()}
          submitting={state.submitting}
          submitError={state.submitError}
          onSubmit={(req) => void store.submit(req)}
        />
      </RegionPortal>

      <RegionPortal root={rootRef} region="task-list">
        <TaskList
          runs={state.runs.data}
          strategies={state.strategies.data}
          loading={state.runs.loading}
          error={state.runs.error}
          onRetry={() => void store.loadRuns()}
          selectedRunId={state.selectedRunId}
          compareIds={state.compareIds}
          progressMap={state.progressMap}
          onSelectRun={(id) => void store.selectRun(id)}
          onToggleCompare={(id) => store.toggleCompare(id)}
        />
      </RegionPortal>

      <RegionPortal root={rootRef} region="result-overview">
        <ResultOverview run={selectedRun} loading={state.runDetail.loading} error={state.runDetail.error} onRetry={loadSelected} />
      </RegionPortal>

      <RegionPortal root={rootRef} region="metric-cards">
        <MetricCards
          metrics={selectedRun?.metrics ?? null}
          loading={state.runDetail.loading}
          error={state.runDetail.error}
          onRetry={loadSelected}
        />
      </RegionPortal>

      <RegionPortal root={rootRef} region="trade-table">
        <TradeTable
          run={selectedRun}
          loading={state.runDetail.loading}
          error={state.runDetail.error}
          onRetry={loadSelected}
          onJumpToKline={(code, from, _to) =>
            navigate(`/?code=${encodeURIComponent(code)}&ts=${encodeURIComponent(from)}`)
          }
        />
      </RegionPortal>

      <RegionPortal root={rootRef} region="period-heatmap">
        <PeriodHeatmap run={selectedRun} loading={state.runDetail.loading} error={state.runDetail.error} onRetry={loadSelected} />
      </RegionPortal>

      <RegionPortal root={rootRef} region="compare-view">
        <CompareView
          runs={state.compare.data}
          loading={state.compare.loading}
          error={state.compare.error}
          onRetry={() => void store.refreshCompare()}
          onExit={() => store.setResultView('single')}
        />
      </RegionPortal>

      <RegionPortal root={rootRef} region="grid-rank">
        <GridRank
          runs={state.runs.data}
          loading={state.runs.loading}
          error={state.runs.error}
          onRetry={() => void store.loadRuns()}
          onSelectRun={(id) => void store.selectRun(id)}
        />
      </RegionPortal>
    </div>
  );
}
