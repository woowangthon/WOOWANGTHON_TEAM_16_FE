import { Activity, CircleHelp, PersonStanding, Radar, WifiOff } from "lucide-react";
import type { ModelMode, NodeInfo, ZoneState } from "../api/types";
import { PRED_CHIP, TRUTH_LABEL, predLabel, type Truth } from "../lib/labels";
import { ago } from "../lib/time";
import { Chip } from "./ui";

const FRAME: Record<string, string> = {
  present: "border-red-300 bg-red-50/40",
  maybe: "border-amber-300 bg-amber-50/40",
  absent: "border-slate-200 bg-white",
  unknown: "border-dashed border-slate-300 bg-white",
};

export default function SpaceCard({
  zone,
  mode,
  rx,
  truth,
  compact = false,
}: {
  zone: ZoneState;
  mode: ModelMode;
  rx: NodeInfo[];
  truth: Truth | null;
  compact?: boolean;
}) {
  const label = predLabel(zone.state, mode);
  const seen = rx.map((n) => n.last_seen_s).filter((s): s is number => typeof s === "number");
  const freshest = seen.length ? Math.min(...seen) : null;
  // 모델이 없을 때(1단계)는 사람인지 판별하지 않으므로 사람 모양 대신 신호 변화 표시를 쓴다
  const person = mode === "person";
  const Icon =
    label.cls === "present"
      ? person
        ? PersonStanding
        : Activity
      : label.cls === "maybe"
        ? person
          ? CircleHelp
          : Activity
        : label.cls === "absent"
          ? Radar
          : WifiOff;
  const iconColor =
    label.cls === "present" ? "text-red-600" : label.cls === "maybe" ? "text-amber-600" : "text-slate-400";

  return (
    <article className={`flex flex-col rounded-2xl border-2 ${compact ? "gap-3 p-4" : "gap-4 p-5"} ${FRAME[label.cls]}`}>
      <div>
        <h3 className={`${compact ? "text-lg" : "text-2xl"} font-bold text-slate-900`}>{zone.name}</h3>
        <p className="mt-0.5 text-sm text-slate-500">수신기 {rx.map((n) => n.name).join(", ") || "없음"}</p>
      </div>
      <div className={`flex items-center ${compact ? "gap-3" : "gap-4"}`}>
        <Icon className={`${compact ? "size-10" : "size-14"} shrink-0 ${iconColor}`} strokeWidth={1.6} />
        <div className={`min-w-0 border-l border-slate-200 ${compact ? "pl-3" : "pl-4"}`}>
          <Chip className={`${compact ? "px-3 py-1 text-base" : "px-4 py-1.5 text-lg"} font-bold ${PRED_CHIP[label.cls]}`}>{label.text}</Chip>
          <p className="mt-1.5 text-sm text-slate-500">갱신 {ago(freshest)}</p>
        </div>
      </div>
      <div className="space-y-1.5 text-sm">
        <p className="text-slate-600">
          <span className="text-slate-400">근거 </span>
          {zone.evidence[0] ?? (label.cls === "absent" ? "빈 방 기준선과 비슷해요" : "—")}
        </p>
        {zone.partial_signal ? <p className="text-amber-700">이 구역 수신기 중 일부만 신호가 와요.</p> : null}
        {compact ? null : (
          <p className="text-slate-400">
            {person ? "자세 예측은 아직 없어요(존재 여부만 판단)." : "모델 연결 전이라 사람인지는 판단하지 않아요(신호 변화만)."}
          </p>
        )}
      </div>
      {truth ? (
        <div className="mt-auto rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600">
          실험자 입력: <b className="font-medium text-slate-800">{TRUTH_LABEL[truth]}</b>
          <span className="text-slate-400"> · 채점에만 씀</span>
        </div>
      ) : null}
    </article>
  );
}
