// 실험 타이밍. 백엔드(watchmate-be) 처리 방식에서 계산했다.
// - 2초 창마다 판정 하나를 내고, 판정마다 직전 16초를 함께 본다(context_seconds).
// - 화면 상태는 최근 판정을 지수 평균(α=0.5)으로 부드럽게 만든다. 판정 3개(6초)가 쌓여야 '감지 안 됨'을 낸다.
// 그래서 실제 상태가 바뀐 뒤 예측이 따라오는 데 길게는 16초 + 평균 2~3창(4~6초) ≈ 20초가 걸린다.
// 11/7 실측: 감지까지 0.3~13.8초, 사람이 나간 뒤 '변화 없음'으로 돌아오는 데 9.7초.

export const SETTLE_S = 20; // 상태를 바꾼 뒤 예측이 따라오는 시간
export const HOLD_S = 60; // 한 상태를 유지할 시간: 따라오는 20초 + 안정 구간 40초
export const WARMUP_S = 20; // 감지를 켠 뒤 첫 시도까지 기다릴 시간
// 기준선 보정: 빈 방 판정 점수의 상위 1%를 문턱으로 삼는다. 2분(창 60개)이면 상위 1%가 사실상 가장 큰 값 하나라
// 잠깐 지나간 사람 하나에도 문턱이 흔들린다. 3분(창 90개)을 권장하고, 2분보다 짧게는 하지 않는다.
export const CAL_RECOMMENDED_S = 180;

export interface TrialPhase {
  text: string;
  cls: string;
}

export function trialPhase(elapsedS: number): TrialPhase {
  if (elapsedS < SETTLE_S) {
    return { text: `예측이 따라오는 중 · ${Math.ceil(SETTLE_S - elapsedS)}초 남음`, cls: "bg-blue-50 text-blue-700 ring-blue-200" };
  }
  if (elapsedS < HOLD_S) {
    return { text: `안정 구간 · ${Math.ceil(HOLD_S - elapsedS)}초 더 유지`, cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  }
  return { text: "충분히 유지했어요 · 다음 상태로 바꿔도 돼요", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
}
