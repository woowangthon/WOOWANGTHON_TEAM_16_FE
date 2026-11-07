import type { ModelMode, NodeInfo, ZoneStateCode } from "../api/types";

// 모델 예측은 존재 여부만 낸다(자세 예측 없음). 와치메이트 원칙: 감지 안 됨 ≠ 사람 없음.
export type PredClass = "present" | "maybe" | "absent" | "unknown";

export interface PredLabel {
  text: string;
  cls: PredClass;
}

export function predLabel(state: ZoneStateCode, mode: ModelMode): PredLabel {
  const person = mode === "person";
  switch (state) {
    case "detected":
      return { text: person ? "사람 있음" : "신호 변화 큼", cls: "present" };
    case "possible":
      return { text: person ? "가능성 있음" : "신호 변화 조금", cls: "maybe" };
    case "not_detected":
      return { text: person ? "감지 안 됨" : "변화 없음", cls: "absent" };
    case "warming":
      return { text: "판단 준비 중", cls: "unknown" };
    case "no_signal":
      return { text: "판단 불가 · 신호 없음", cls: "unknown" };
    case "uncalibrated":
      return { text: "판단 불가 · 보정 필요", cls: "unknown" };
    case "no_sensor":
      return { text: "판단 불가 · 수신기 없음", cls: "unknown" };
  }
}

// 화면 색. 지휘 화면 약속(빨강 감지, 노랑 확인 필요, 회색 미감지)을 따른다.
export const PRED_COLOR: Record<PredClass, string> = {
  present: "#dc2626",
  maybe: "#f59e0b",
  absent: "#cbd5e1",
  unknown: "#e2e8f0",
};

export const PRED_CHIP: Record<PredClass, string> = {
  present: "bg-red-50 text-red-700 ring-red-200",
  maybe: "bg-amber-50 text-amber-800 ring-amber-200",
  absent: "bg-slate-100 text-slate-600 ring-slate-200",
  unknown: "bg-slate-50 text-slate-500 ring-slate-200",
};

// 실험자가 입력하는 실제 상태. 채점에만 쓰고 예측 계산에는 쓰지 않는다.
export type Truth = "empty" | "standing" | "sitting" | "lying";

export const TRUTHS: Truth[] = ["empty", "standing", "sitting", "lying"];

export const TRUTH_LABEL: Record<Truth, string> = {
  empty: "비어 있음",
  standing: "서 있음",
  sitting: "앉아 있음",
  lying: "누워 있음",
};

export const TRUTH_COLOR: Record<Truth, string> = {
  empty: "#94a3b8",
  standing: "#16a34a",
  sitting: "#2563eb",
  lying: "#7c3aed",
};

export type Tone = "ok" | "warn" | "bad" | "idle";

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  idle: "bg-slate-400",
};

export const TONE_CHIP: Record<Tone, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  bad: "bg-red-50 text-red-700 ring-red-200",
  idle: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function nodeStatusLabel(n: Pick<NodeInfo, "status" | "reason">): { text: string; tone: Tone } {
  switch (n.status) {
    case "ok":
      return { text: "수신 중", tone: "ok" };
    case "warming":
      return { text: "준비 중", tone: "warn" };
    case "uncalibrated":
      return { text: "보정 전", tone: "warn" };
    case "stale":
      if (n.reason === "restarted") return { text: "다시 켜짐 · 재보정 필요", tone: "bad" };
      if (n.reason === "low_rate") return { text: "프레임 부족", tone: "warn" };
      return { text: "신호 끊김", tone: "bad" };
    default:
      return { text: "송신", tone: "idle" };
  }
}
