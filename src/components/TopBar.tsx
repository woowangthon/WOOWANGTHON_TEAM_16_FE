import type { ReactNode } from "react";
import { receiverCount, receiverRows } from "../lib/receivers";
import { useLive } from "../state/live";
import { Chip } from "./ui";

export function ModeBadges() {
  const { dataMode, modelMode, replay, state, building, now } = useLive();
  const rx = receiverCount(receiverRows(state, building, now));

  const mode =
    dataMode === "mock"
      ? { text: "UI 예시 · 가상 데이터", cls: "bg-blue-50 text-blue-700 ring-blue-300", dot: "bg-blue-500" }
      : dataMode === "live"
        ? { text: "실시간 · 센서 데이터", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" }
        : dataMode === "replay"
          ? {
              text: replay?.synthetic ? "기록 재생 · 합성 신호(개발용)" : "기록 재생 · 녹화 데이터",
              cls: "bg-violet-50 text-violet-700 ring-violet-200",
              dot: "bg-violet-500",
            }
          : dataMode === "offline"
            ? { text: "서버 연결 안 됨", cls: "bg-red-50 text-red-700 ring-red-200", dot: "bg-red-500" }
            : dataMode === "loading"
              ? { text: "서버 연결 중", cls: "bg-slate-50 text-slate-600 ring-slate-200", dot: "bg-slate-400" }
              : { text: "감지 꺼짐", cls: "bg-slate-50 text-slate-600 ring-slate-200", dot: "bg-slate-400" };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Chip className={`px-3 py-1 text-[13px] ${mode.cls}`}>
        <span className={`size-2 rounded-full ${mode.dot}`} />
        {mode.text}
      </Chip>
      {modelMode === "change" ? (
        <Chip className="px-3 py-1 text-[13px] bg-amber-50 text-amber-800 ring-amber-200">모델 없음 · 신호 변화 기준</Chip>
      ) : modelMode === "person" ? (
        <Chip className="px-3 py-1 text-[13px] bg-slate-50 text-slate-700 ring-slate-200">사람 판별 모델 사용</Chip>
      ) : null}
      {state?.summary.frozen ? (
        <Chip className="px-3 py-1 text-[13px] bg-slate-50 text-slate-600 ring-slate-200">재생 끝 · 수신 멈춤</Chip>
      ) : rx.total > 0 ? (
        <Chip
          className={`px-3 py-1 text-[13px] ${
            rx.ok === rx.total ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-800 ring-amber-200"
          }`}
        >
          <span className={`size-2 rounded-full ${rx.ok === rx.total ? "bg-emerald-500" : "bg-amber-500"}`} />
          수신기 {rx.ok}/{rx.total}대 수신 중
        </Chip>
      ) : null}
    </div>
  );
}

export default function TopBar({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-tight text-slate-900 sm:text-[32px]">{title}</h1>
        {sub ? <p className="mt-1 text-[15px] text-slate-500">{sub}</p> : null}
      </div>
      <div className="flex flex-col items-end gap-2">
        <ModeBadges />
        {children}
      </div>
    </header>
  );
}
