import { TRUTH_LABEL, type Truth } from "../lib/labels";
import { GOAL_OPTIONAL, GOAL_REQUIRED, GOAL_ZONES, goalCounts, goalTotal } from "../lib/protocol";
import { useLive } from "../state/live";

function Bar({ done, total, tone }: { done: number; total: number; tone: "blue" | "slate" }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${tone === "blue" ? "bg-blue-600" : "bg-slate-400"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// 실험 목표 진행: 필수 80번(방마다 앉기 20·빈 방 20) → 선택 160번(앉기·빈 방 30, 서기 10, 눕기 10)
export default function GoalTracker() {
  const { records } = useLive();
  const counts = goalCounts(records);
  const req = goalTotal(counts, GOAL_REQUIRED);
  const opt = goalTotal(counts, GOAL_OPTIONAL);
  const requiredDone = req.done >= req.total;
  const truths = Object.keys(GOAL_OPTIONAL) as Truth[];

  return (
    <div className="rounded-2xl border border-slate-200 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <b className="text-slate-900">실험 목표</b>
        <span className="text-sm text-slate-600 tabular">
          필수 <b className="text-slate-900">{req.done}</b>/{req.total}
          {requiredDone ? ` · 선택까지 ${opt.done}/${opt.total}` : ""}
        </span>
      </div>
      <div className="mt-2">
        <Bar done={req.done} total={req.total} tone="blue" />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {GOAL_ZONES.map((z) => (
          <div key={z} className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
            <div className="mb-1 font-bold text-slate-800">{z}</div>
            <ul className="space-y-0.5 tabular">
              {truths.map((t) => {
                const n = counts[z]?.[t] ?? 0;
                const need = GOAL_REQUIRED[t];
                const final = GOAL_OPTIONAL[t] ?? 0;
                const target = need && n < need ? need : final;
                const optional = !need || n >= need;
                return (
                  <li key={t} className={`flex justify-between gap-2 ${optional && !requiredDone ? "text-slate-400" : "text-slate-700"}`}>
                    <span>
                      {TRUTH_LABEL[t]}
                      {optional ? " (선택)" : ""}
                    </span>
                    <span className={n >= target ? "font-medium text-emerald-700" : ""}>
                      {n}/{target}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        필수: 방마다 앉아 있음 20번 + 비어 있음 20번(합계 80번). 끝나면 선택으로 앉기·빈 방 30번까지, 서기·눕기 10번씩(합계 160번). 실시간 실측만 세고, 판단 불가와 11/7 첫 시험은 빼요.
      </p>
    </div>
  );
}
