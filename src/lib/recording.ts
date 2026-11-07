import type { Truth } from "./labels";

// 녹화 도우미(scripts/record_live.py)가 알려 주는 지금 장면. 개발 서버가 /rec을 127.0.0.1:8765로 넘긴다.
// 도우미가 꺼져 있거나 배포 화면이면 응답이 없고, 그때는 실제 상태를 손으로 입력한다.
export type RecPhase = "countdown" | "recording" | "between" | "done" | "idle";

export interface RecState {
  running: boolean;
  day: string;
  index: number; // 장면 목록에서 몇 번째인지(0부터)
  total: number;
  scene: string | null;
  description: string;
  labels: Record<string, string>; // 수신기 이름 → 라벨(standing·sitting·lying·empty·neighbor)
  phase: RecPhase;
  phase_started: number; // 도우미 시계(초)
  phase_seconds: number;
  next: { scene: string; description: string } | null;
  now: number; // 도우미 시계(초). 화면 시계와 차이를 맞추는 데 쓴다
}

export async function fetchRecording(): Promise<RecState | null> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 900);
  try {
    const res = await fetch("/rec/scene", { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as RecState;
    return body && typeof body.phase === "string" ? body : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

// 녹화 라벨 → 화면의 실제 상태. 옆 구역에만 사람이 있으면 이 구역은 비어 있다.
export function truthFromLabel(label: string | undefined): Truth | null {
  if (label === "standing" || label === "sitting" || label === "lying") return label;
  if (label === "empty" || label === "neighbor") return "empty";
  return null;
}

// 도우미 시계의 시각(초)을 화면 시계(ms)로 바꾼다
export function recTimeToLocal(rec: RecState, t: number, fetchedAt: number): number {
  return fetchedAt - (rec.now - t) * 1000;
}
