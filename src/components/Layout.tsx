import { FileText, LogOut, PlayCircle, Settings, Wifi } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useLive } from "../state/live";
import { useSession } from "../state/session";

const NAV = [
  { to: "/", label: "실험 진행", icon: PlayCircle, end: true },
  { to: "/records", label: "기록", icon: FileText, end: false },
  { to: "/settings", label: "고급 설정", icon: Settings, end: false },
];

export default function Layout() {
  const { username, mockOnly, logout, exitMock } = useSession();
  const { building, state } = useLive();
  const where = state?.building.name ?? building?.name ?? null;

  return (
    <div className="min-h-screen bg-page">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-brand text-white">
              <Wifi size={20} strokeWidth={2.4} />
            </span>
            <span className="text-lg font-bold text-slate-900">와치메이트</span>
          </div>
          <nav className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-[15px] font-medium transition-colors ${
                    isActive ? "bg-brand-soft text-brand" : "text-slate-600 hover:bg-slate-100"
                  }`
                }
              >
                <Icon size={18} />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm text-slate-500">
            {where ? <span className="hidden md:inline">{where}</span> : null}
            <button
              type="button"
              onClick={mockOnly ? exitMock : logout}
              className="flex items-center gap-1.5 hover:text-slate-800"
            >
              <LogOut size={16} /> {mockOnly ? "UI 예시 끝내기" : `${username ?? ""} 로그아웃`}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
