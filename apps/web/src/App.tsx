import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { SetupPage } from "./pages/Setup";
import { DashboardPage } from "./pages/Dashboard";
import { RequestsPage } from "./pages/Requests";
import { RequestDetailPage } from "./pages/RequestDetail";
import { JobsPage } from "./pages/Jobs";
import { LogsPage } from "./pages/Logs";
import { DiskPage } from "./pages/Disk";
import { SettingsPage } from "./pages/Settings";

function Connecting() {
  return <div className="auth-card">Connecting to API…</div>;
}

function Guard({ children }: { children: ReactElement }) {
  const { user, ready, setup } = useAuth();
  if (!ready) return <Connecting />;
  if (setup && !setup.configured) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function SetupGate() {
  const { ready, setup, user } = useAuth();
  if (!ready) return <Connecting />;
  if (setup && !setup.configured) return <SetupPage />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to="/wizard" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupGate />} />
      <Route
        element={
          <Guard>
            <Layout />
          </Guard>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/requests/:id" element={<RequestDetailPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/disk" element={<DiskPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/wizard" element={<SetupPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
