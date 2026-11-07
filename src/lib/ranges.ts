import type { IncidentState, ZoneStateCode } from "../api/types";

// 이 노트북 백엔드(학습 모델 없이 1단계 '변화 감지')와 11/7 측정으로 정한 화면 판단 범위.
//
// 서버는 구역마다 p(0~1)를 준다. 224호 다시 찍기(2026-11-07b)와 2차(2026-11-07c) 비교표의 장면별 점수를
// 서버와 같은 식 p = 1 / (1 + e^-(점수 - 문턱) / max(0.5, 문턱/4))로 바꿔 보니:
//   - 사람이 자기 구역에 있음(서기·앉기·눕기) 12장면: 중앙값 0.73 ~ 1.00
//   - 빈 방(RX-301·RX-COR) 6장면: 0.04 ~ 0.14 / 빈 방(RX-302) 0.26 ~ 0.46
//   - 사람이 옆 구역에 있음 24장면: 대부분 0.03 ~ 0.15, 복도 앉기·눕기와 223호 앉기만 0.37 ~ 0.71
// 서버 기본 문턱(감지 0.70, 가능성 0.35)으로는 223호 눕기(중앙값 0.73)의 절반가량이 '감지'가 되지 않는다.
// 목표는 "사람이 방에 들어가면 확실히 잡는 것"이고 다른 곳 오탐은 받아들이므로, 감지 문턱을 0.50으로 낮춘다.
// 장면 중앙값으로 정한 값이라 3차 측정 뒤 2초 구간 단위로 다시 확인한다.
export const RANGE = {
  present: 0.5, // 이 값 이상: 사람 측정됨
  empty: 0.2, // 이 값 미만: 비어 있음. 그 사이는 있는지 애매함
} as const;

const JUDGED = new Set<ZoneStateCode>(["detected", "possible", "not_detected"]);

export function rangeState(serverState: ZoneStateCode, p: number | null | undefined): ZoneStateCode {
  // 준비 중·신호 없음·보정 필요·수신기 없음은 서버 판단을 그대로 둔다(판단 불가)
  if (!JUDGED.has(serverState) || p === null || p === undefined) return serverState;
  if (p >= RANGE.present) return "detected";
  if (p >= RANGE.empty) return "possible";
  return "not_detected";
}

// 서버 응답의 구역 상태를 위 범위로 다시 매긴다. 지도·카드·기록·CSV가 모두 이 값을 쓴다.
// 사람 판별 모델(person 모드)이 붙은 서버는 그 모델의 문턱을 그대로 따른다.
export function applyRanges(st: IncidentState): IncidentState {
  if (st.mode !== "change") return st;
  const zones = st.zones.map((z) => ({ ...z, server_state: z.state, state: rangeState(z.state, z.p) }));
  const states = Object.fromEntries(Object.keys(st.summary.states).map((k) => [k, 0])) as Record<ZoneStateCode, number>;
  for (const z of zones) states[z.state] = (states[z.state] ?? 0) + 1;
  return { ...st, zones, summary: { ...st.summary, states } };
}

export function rangeText(): string {
  return `측정됨 p ${RANGE.present.toFixed(2)} 이상 · 애매함 ${RANGE.empty.toFixed(2)}~${RANGE.present.toFixed(2)} · 비어 있음 ${RANGE.empty.toFixed(2)} 미만`;
}
