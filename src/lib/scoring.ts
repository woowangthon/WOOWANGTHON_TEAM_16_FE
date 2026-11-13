import type { PredClass, Truth } from "./labels";

// 실제 상태(실험자 입력)와 모델 예측을 비교한다. 모델은 존재 여부만 내므로 자세는 비교하지 않는다.
export type Outcome = "match" | "false_alarm" | "miss" | "ambiguous" | "unscored";

export const OUTCOME_LABEL: Record<Outcome, string> = {
  match: "일치",
  false_alarm: "오탐",
  miss: "미탐",
  ambiguous: "애매(가능성 있음)",
  unscored: "채점 제외(판단 불가)",
};

export const OUTCOME_CHIP: Record<Outcome, string> = {
  match: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  false_alarm: "bg-red-50 text-red-700 ring-red-200",
  miss: "bg-red-50 text-red-700 ring-red-200",
  ambiguous: "bg-amber-50 text-amber-800 ring-amber-200",
  unscored: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function compare(truth: Truth, pred: PredClass): Outcome {
  if (pred === "unknown") return "unscored";
  if (pred === "maybe") return "ambiguous";
  const truthPresent = truth !== "empty";
  const predPresent = pred === "present";
  if (truthPresent === predPresent) return "match";
  return predPresent ? "false_alarm" : "miss";
}
