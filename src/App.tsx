import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import DevicesPage from "./pages/DevicesPage";
import ExperimentPage from "./pages/ExperimentPage";
import LivePage from "./pages/LivePage";
import LoginPage from "./pages/LoginPage";
import RecordsPage from "./pages/RecordsPage";
import { LiveProvider } from "./state/live";
import { SessionProvider, useSession } from "./state/session";

function Gate() {
  const { token, mockOnly } = useSession();
  if (!token && !mockOnly) return <LoginPage />;
  return (
    <LiveProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<LivePage />} />
          <Route path="experiment" element={<ExperimentPage />} />
          <Route path="records" element={<RecordsPage />} />
          <Route path="devices" element={<DevicesPage />} />
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
