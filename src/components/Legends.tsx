import { PRED_COLOR, TRUTHS, TRUTH_COLOR, TRUTH_LABEL } from "../lib/labels";
import { rangeText } from "../lib/ranges";
import { useLive } from "../state/live";

export function PredLegend() {
  const { state, modelMode } = useLive();
  const person = (state?.mode ?? modelMode ?? "person") === "person";
  const items: [string, string][] = [
    [person ? "사람 있음" : "사람 측정됨", PRED_COLOR.present],
    [person ? "가능성 있음" : "있는지 애매함", PRED_COLOR.maybe],
    [person ? "감지 안 됨" : "비어 있음", PRED_COLOR.absent],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      <span className="font-medium text-slate-500">예측</span>
      {items.map(([t, c]) => (
        <span key={t} className="inline-flex items-center gap-1.5">
          <i className="size-3 rounded-sm" style={{ background: c }} />
          {t}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <i className="size-3 rounded-sm border border-slate-300 bg-[repeating-linear-gradient(45deg,#e2e8f0_0_2px,#fff_2px_5px)]" />
        판단 불가
      </span>
      {person ? null : <span className="text-slate-400">({rangeText()})</span>}
    </div>
  );
}

export function TruthLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      <span className="font-medium text-slate-500">실제</span>
      {TRUTHS.map((t) => (
        <span key={t} className="inline-flex items-center gap-1.5">
          <i className="size-3 rounded-sm" style={{ background: TRUTH_COLOR[t] }} />
          {TRUTH_LABEL[t]}
        </span>
      ))}
    </div>
  );
}
