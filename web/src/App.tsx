import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/shell/AppShell';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { SourcesPage } from '@/features/sources/SourcesPage';
import { SymbolsPage } from '@/features/symbols/SymbolsPage';

// 路由（00-shell §路由索引）：Phase C 解锁 ①②③，其余置灰项无路由，统一回落 /
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/symbols" element={<SymbolsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
