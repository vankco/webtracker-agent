import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { MonitorPage } from './pages/MonitorPage.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { ProvidersPage } from './pages/ProvidersPage.js';
import { DebugLogPage } from './pages/DebugLogPage.js';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<MonitorPage />} />
        <Route path="config" element={<ConfigPage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="debug" element={<DebugLogPage />} />
        {/* Catch-all → monitor */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
