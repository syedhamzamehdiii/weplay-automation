import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { getToken } from "./api";
import { Layout } from "./components/Layout";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { AccountsPage } from "./pages/AccountsPage";
import { CreateWePlayAccountPage } from "./pages/CreateWePlayAccountPage";
import { ImportAccountsPage } from "./pages/ImportAccountsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspaceUsersPage } from "./pages/WorkspaceUsersPage";

function RequireAuth({ children }: { children: ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="workspace" element={<WorkspaceUsersPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="accounts/create" element={<CreateWePlayAccountPage />} />
        <Route path="accounts/import" element={<ImportAccountsPage />} />
        <Route path="accounts/:id" element={<AccountDetailPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="workers" element={<Navigate to="/" replace />} />
        <Route path="logs" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
