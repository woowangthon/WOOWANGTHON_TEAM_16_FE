import { FileText, FlaskConical, House, LogOut, Settings, Wifi } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useLive } from "../state/live";
import { useSession } from "../state/session";

const NAV = [
  { to: "/", label: "실시간 현황", icon: House, end: true },
  { to: "/experiment", label: "실험 검증", icon: FlaskConical, end: false },
  { to: "/records", label: "기록 보기", icon: FileText, end: false },
  { to: "/devices", label: "장치 관리", icon: Settings, end: false },
];

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-brand text-white">
        <Wifi size={22} strokeWidth={2.4} />
      </span>
      <div className="leading-tight">
        <div className="text-lg font-bold text-slate-900">와치메이트</div>
        <div className="text-xs text-slate-500">Wi-Fi 기척 실험 화면</div>
      </div>
    </div>
  );
}

export default function Layout() {
  const { username, mockOnly, logout, exitMock } = useSession();
  const { building, state } = useLive();
  const where = state?.building.name ?? building?.name ?? null;

  return (
    <div className="min-h-screen bg-page lg:flex">
      <aside className="border-b border-slate-200 bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-4 lg:block lg:px-6 lg:py-7">
          <Brand />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:gap-1.5 lg:overflow-visible lg:px-4 lg:pb-0">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-3 rounded-xl px-4 py-2.5 text-[15px] font-medium transition-colors ${
                  isActive ? "bg-brand-soft text-brand" : "text-slate-600 hover:bg-slate-50"
                }`
              }
            >
              <Icon size={19} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-6 pb-6 text-sm lg:mt-auto lg:block">
          {where ? (
            <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2.5">
              <div className="text-xs text-slate-500">보고 있는 공간</div>
              <div className="font-medium text-slate-800">{where}</div>
            </div>
          ) : null}
          {mockOnly ? (
            <button type="button" onClick={exitMock} className="flex items-center gap-2 text-slate-500 hover:text-slate-800">
              <LogOut size={16} /> UI 예시 끝내기
            </button>
          ) : (
            <button type="button" onClick={logout} className="flex items-center gap-2 text-slate-500 hover:text-slate-800">
              <LogOut size={16} /> {username} 로그아웃
            </button>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
