import { Clapperboard } from "lucide-react";
import { TRUTH_LABEL } from "../lib/labels";
import { truthFromLabel } from "../lib/recording";
import { useLive } from "../state/live";

const PHASE_TEXT: Record<string, string> = {
  countdown: "이동 중",
  recording: "녹화 중",
  between: "다음 장면 준비",
  done: "녹화 끝",
  idle: "대기",
};

// 녹화 도우미(record_live.py)와 연결되면 지금 장면과 남은 시간을 보여 주고, 실제 상태 자동 입력을 켜고 끈다
export default function RecordingBanner() {
  const { rec, recSync, setRecSync, state } = useLive();
  if (!rec || !rec.running) return null;
  const elapsed = Math.max(0, rec.now - rec.phase_started); // 도우미 시계 기준. 1초마다 새로 받는다
  const left = rec.phase_seconds > 0 ? Math.max(0, Math.ceil(rec.phase_seconds - elapsed)) : null;
  const zones = state?.zones ?? [];
  const truths = zones
    .map((z) => {
      const rx = state?.nodes.filter((n) => n.role === "rx" && n.zone_id === z.id) ?? [];
      const t = truthFromLabel(rx.map((n) => rec.labels[n.name]).find((l) => l !== undefined));
      return t ? `${z.name} ${TRUTH_LABEL[t]}` : null;
    })
    .filter(Boolean);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Clapperboard className="size-4 text-blue-700" />
        <b className="text-slate-900">
          녹화 연동 · [{rec.index + 1}/{rec.total}] {rec.scene ?? "—"}
        </b>
        <span className="rounded-md bg-white px-2 py-0.5 text-blue-800 ring-1 ring-blue-200">
          {PHASE_TEXT[rec.phase] ?? rec.phase}
          {left !== null && (rec.phase === "countdown" || rec.phase === "recording") ? ` · ${left}초 남음` : ""}
        </span>
        {rec.next ? <span className="text-slate-500">다음: {rec.next.scene}</span> : null}
      </div>
      {rec.description ? <p className="text-slate-700">{rec.description}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-slate-600">{truths.length ? `이 장면의 실제 상태: ${truths.join(" · ")}` : ""}</span>
        <label className="inline-flex items-center gap-2 text-slate-700">
          <input id="rec-sync" type="checkbox" checked={recSync} onChange={(e) => setRecSync(e.target.checked)} />
          녹화 장면으로 실제 상태 자동 입력
        </label>
      </div>
    </div>
  );
}
