import type { ModelMode, ZoneStateCode } from "../api/types";
import { predLabel, type PredClass, type Truth } from "./labels";
import { compare } from "./scoring";

// 화면이 받은 예측을 구역마다 구간으로 쌓는다. 백엔드는 지금 상태만 주므로 기록은 화면 쪽에 남긴다.
export interface Segment {
  state: ZoneStateCode;
  cls: PredClass;
  from: number;
  to: number;
}

export type PredHistory = Record<string, Segment[]>; // zoneId → 구간

export interface TruthEvent {
  zoneId: number;
  truth: Truth;
  at: number;
}

const GAP_MS = 10_000; // 이보다 오래 못 받았으면 끊긴 구간으로 둔다
const MAX_SEGMENTS = 600;

export function appendPrediction(
  hist: PredHistory,
  zones: { id: number; state: ZoneStateCode }[],
  mode: ModelMode,
  at: number,
): PredHistory {
  const next: PredHistory = { ...hist };
  for (const z of zones) {
    const key = String(z.id);
    const segs = next[key] ? [...next[key]] : [];
    const last = segs[segs.length - 1];
    const cls = predLabel(z.state, mode).cls;
    if (last && last.state === z.state && at - last.to <= GAP_MS) {
      segs[segs.length - 1] = { ...last, to: at };
    } else {
      segs.push({ state: z.state, cls, from: at, to: at });
    }
    next[key] = segs.length > MAX_SEGMENTS ? segs.slice(-MAX_SEGMENTS) : segs;
  }
  return next;
}

export function currentTruth(events: TruthEvent[], zoneId: number): TruthEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].zoneId === zoneId) return events[i];
  }
  return null;
}

const ONGOING_MS = 4_000; // 2초마다 받으므로, 마지막으로 받은 지 이 안이면 아직 이어지는 구간으로 본다

// 실제 상태를 바꾼 뒤 예측이 처음으로 맞은 시각. 아직 안 맞았으면 null.
// 바꾸는 순간 이미 맞는 예측이 이어지고 있었다면 바꾼 시각(반응 0초)을 돌려준다.
export function firstMatchAt(segs: Segment[] | undefined, truth: Truth, since: number): number | null {
  if (!segs) return null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const next = segs[i + 1];
    const ongoing = s.from <= since && (!next || next.from > since) && since - s.to <= ONGOING_MS;
    if (s.to < since && !ongoing) continue;
    if (compare(truth, s.cls) === "match") return Math.max(s.from, since);
  }
  return null;
}
