import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import DevicesPage from "./pages/DevicesPage";
import LoginPage from "./pages/LoginPage";
import RecordsPage from "./pages/RecordsPage";
import RunPage from "./pages/RunPage";
import { LiveProvider } from "./state/live";
import { SessionProvider, useSession } from "./state/session";

function Gate() {
  const { token, mockOnly } = useSession();
  if (!token && !mockOnly) return <LoginPage />;
  return (
    <LiveProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<RunPage />} />
          <Route path="records" element={<RecordsPage />} />
          <Route path="settings" element={<DevicesPage />} />
          <Route path="devices" element={<Navigate to="/settings" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </LiveProvider>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
