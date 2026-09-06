import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AlertsGrid } from '@/layouts/AlertsGrid';
import { defaultApi } from '@/api';
import { defaultWs } from '@/ws';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { RegionPortal } from '@/components/RegionPortal';
import { AlertsStore, rangeFromIso } from './store';
import { AlertFilterBar } from './AlertFilterBar';
import { AlertList } from './AlertList';
import { RulePanel } from './RulePanel';

/**
 * 页面⑦告警中心：以 tangle 骨架 AlertsGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 * 数据流：REST 过滤查询 + WS {type:"alert"} 实时并入（store 承载）；确认/规则调整即存热生效。
 */
export function AlertsPage({ api = defaultApi, ws = defaultWs }: { api?: ApiClient; ws?: WsClient }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const store = useMemo(() => new AlertsStore({ api, ws }), [api, ws]);
  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const sources = useMemo(
    () => [...new Set((state.list.data ?? []).map((a) => a.source))].sort(),
    [state.list.data],
  );

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1">
      <AlertsGrid
        filter={{
          level: state.filter.level,
          from: rangeFromIso(state.filter.range, new Date()) ?? '',
          to: '',
          source: state.filter.source,
        }}
        onFilterChange={(f) =>
          void store.setFilter({ level: f.level, source: f.source })
        }
        onAck={(id) => void store.ack(Number(id))}
        onUpdateRule={(id, p) =>
          void store.updateRule(id, {
            threshold: p.threshold,
            enabled: p.enabled,
            silence_minutes: p.silenceMinutes,
          })
        }
      />
      <RegionPortal root={rootRef} region="alert-filter">
        <AlertFilterBar
          filter={state.filter}
          sources={sources}
          onChange={(p) => void store.setFilter(p)}
        />
      </RegionPortal>
      <RegionPortal root={rootRef} region="alert-list">
        <AlertList
          list={state.list}
          acking={state.acking}
          ackError={state.ackError}
          onAck={(id) => void store.ack(id)}
          onRetry={() => void store.loadList()}
        />
      </RegionPortal>
      <RegionPortal root={rootRef} region="rule-panel">
        <RulePanel
          rules={state.rules}
          onUpdateRule={(id, p) => void store.updateRule(id, p)}
          onRetry={() => void store.loadRules()}
        />
      </RegionPortal>
    </div>
  );
}
