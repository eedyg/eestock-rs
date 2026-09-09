import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/shell/AppShell';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { SourcesPage } from '@/features/sources/SourcesPage';
import { SymbolsPage } from '@/features/symbols/SymbolsPage';
import { AlertsPage } from '@/features/alerts/AlertsPage';
import { QualityPage } from '@/features/quality/QualityPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { SimLivePage } from '@/features/simlive/SimLivePage';
import { StrategiesPage } from '@/features/strategies/StrategiesPage';
import { StrategyEditorPage } from '@/features/strategies/StrategyEditorPage';
import { WorkbenchPage } from '@/features/workbench/WorkbenchPage';

// 路由（00-shell §路由索引）：①...⑦ + ④（W2 Phase C）+ ⑤（W3 Phase 3c）+ ⑧（S1 设置页）已解锁，其余置灰项无路由，统一回落 /
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/symbols" element={<SymbolsPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/quality" element={<QualityPage />} />
          {/* P4b（D16 终章）：旧回测页已物理删除，/backtest 重定向至统一策略回测工作台 */}
          <Route path="/backtest" element={<Navigate to="/backtest-workbench" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/sim-live" element={<SimLivePage />} />
          {/* 页面⑩ 策略管理（12-strategy-system / P2b） */}
          <Route path="/strategies" element={<StrategiesPage />} />
          <Route path="/strategies/:id/edit" element={<StrategyEditorPage />} />
          {/* 页面⑪ 回测工作台（12-strategy-system / P3b；P4b 起为唯一回测入口） */}
          <Route path="/backtest-workbench" element={<WorkbenchPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
