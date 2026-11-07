import { useLive } from "../state/live";
import { clock } from "../lib/time";

const KIND_LABEL: Record<string, string> = {
  incident_open: "감지 시작",
  incident_close: "감지 끝",
  first_detection: "첫 감지",
  node_restart: "노드 재시작",
  frame_mismatch: "프레임 버림",
  calibration: "보정",
  replay_end: "재생 끝",
  replay_error: "재생 오류",
  decision: "기록",
};

export default function LogPanel() {
  const { state } = useLive();
  const items = state?.timeline ?? [];
  if (items.length === 0) return <p className="px-5 py-4 text-sm text-slate-500">감지 중일 때 서버가 남긴 기록이 여기에 나와요.</p>;
  return (
    <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
      {items.map((e, i) => (
        <li key={i} className="flex gap-4 px-5 py-2.5 text-sm">
          <span className="w-20 shrink-0 text-slate-500 tabular">{e.t ? clock(Date.parse(e.t)) : ""}</span>
          <span className="w-20 shrink-0 font-medium text-slate-700">{KIND_LABEL[e.kind] ?? e.kind}</span>
          <span className="min-w-0 text-slate-700">{e.message ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}
