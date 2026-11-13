import type { ReactNode } from "react";
import { receiverRows, type RxRow } from "../lib/receivers";
import { TONE_CHIP, TONE_DOT, nodeStatusLabel, type Tone } from "../lib/labels";
import { ago } from "../lib/time";
import { useLive } from "../state/live";
import { Chip } from "./ui";

function rowStatus(r: RxRow): { text: string; tone: Tone } {
  if (r.status === "seen") return { text: r.reason === "restarted" ? "신호 들어옴 · 재보정 필요" : "신호 들어옴", tone: r.reason ? "warn" : "ok" };
  if (r.status === "silent") return { text: "신호 없음", tone: "idle" };
  if (r.status === "frozen") return { text: "재생 끝 · 마지막 값", tone: "idle" };
  return nodeStatusLabel({ status: r.status, reason: (r.reason as "restarted" | "low_rate" | null) ?? null });
}

export default function DeviceStrip({ action }: { action?: ReactNode }) {
  const { state, building, now } = useLive();
  const rows = receiverRows(state, building, now);

  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-slate-200 bg-white px-5 py-4">
      <h2 className="text-[17px] font-bold text-slate-900">장치 수신 상태</h2>
      {rows.length === 0 ? <p className="text-sm text-slate-500">등록된 수신기가 없어요. 장치 관리에서 실험 공간을 만들어 주세요.</p> : null}
      {rows.map((r) => {
        const s = rowStatus(r);
        return (
          <div key={r.id} className="flex items-center gap-2.5 border-l border-slate-200 pl-5 first-of-type:border-l-0 first-of-type:pl-0">
            <span className="font-bold text-slate-800">{r.name}</span>
            <Chip className={TONE_CHIP[s.tone]}>
              <span className={`size-2 rounded-full ${TONE_DOT[s.tone]}`} />
              {s.text}
            </Chip>
            <span className="text-xs text-slate-500 tabular">
              {ago(r.lastSeenS)}
              {r.quality !== null ? ` · 프레임 ${Math.round(r.quality * 100)}%` : ""}
            </span>
          </div>
        );
      })}
      {action ? <div className="ml-auto">{action}</div> : null}
    </section>
  );
}
