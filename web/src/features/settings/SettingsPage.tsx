import { useMemo, useRef, useState } from 'react';
import { SettingsGrid, type SettingsSection } from '@/layouts/SettingsGrid';
import { defaultApi } from '@/api';
import type { ApiClient } from '@/api/client';
import { RegionPortal } from '@/components/RegionPortal';
import { SettingsNav } from './SettingsNav';
import { SystemInfoPanel } from './SystemInfoPanel';
import { SourceConfigPanel } from './SourceConfigPanel';
import { CollectorConfigPanel } from './CollectorConfigPanel';
import { McpConfigPanel } from './McpConfigPanel';
import { KlineConfigPanel } from './KlineConfigPanel';
import { LogViewer } from './LogViewer';
import { DangerZone } from './DangerZone';

/**
 * 页面⑧系统设置：以 tangle 骨架 SettingsGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 * S1 低风险切片：只读/运维区。配置持久化（PATCH /api/config/*）与日志采集/WS 属 S2，
 * 本页明确占位（保存按钮禁用 + LogViewer 占位），不实现持久化/PATCH。
 * 危险操作（purge-raw / reset-circuits）仅在前端 confirm 匹配后才发请求；服务端缺失 confirm 拒绝（400）。
 */
export function SettingsPage({ api = defaultApi }: { api?: ApiClient }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>('source-config');

  const gridProps = useMemo(
    () => ({
      activeSection,
      onNavigateSection: setActiveSection,
      // S1 边界：PATCH 持久化属 S2，回调不接线（只读区保存按钮禁用）
      onSaveSourceConfig: () => {},
      onSaveCollectorConfig: () => {},
      onSaveMcpConfig: () => {},
      onEnableMcpTradingTools: () => {},
      onSetLogLevel: () => {},
      onPurgeRaw: (confirm: string) => void api.purgeRaw(confirm),
      onResetCircuits: (confirm: string) => void api.resetCircuits(confirm),
    }),
    [activeSection, api],
  );

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1">
      <SettingsGrid {...gridProps} />
      <RegionPortal root={rootRef} region="settings-nav">
        <SettingsNav activeSection={activeSection} onNavigateSection={setActiveSection} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="source-config">
        <SourceConfigPanel api={api} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="collector-config">
        <CollectorConfigPanel api={api} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="mcp-config">
        <McpConfigPanel api={api} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="kline-config">
        <KlineConfigPanel api={api} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="system-info">
        <SystemInfoPanel api={api} />
      </RegionPortal>
      <RegionPortal root={rootRef} region="log-viewer">
        <LogViewer />
      </RegionPortal>
      <RegionPortal root={rootRef} region="danger-zone">
        <DangerZone api={api} />
      </RegionPortal>
    </div>
  );
}
