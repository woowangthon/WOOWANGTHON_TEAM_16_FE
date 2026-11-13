import type { Truth } from "./labels";

// 녹화 도우미(scripts/record_live.py)가 알려 주는 지금 장면. 개발 서버가 /rec을 127.0.0.1:8765로 넘긴다.
// 도우미가 꺼져 있거나 배포 화면이면 응답이 없고, 그때는 실제 상태를 손으로 입력한다.
export type RecPhase = "countdown" | "recording" | "between" | "done" | "idle" | "setup" | "preparing" | "calibrating" | "starting" | "waiting" | "armed" | "stopped";

export interface RecState {
  sync?: boolean;
  requested_nodes?: string[];
  run_id?: string;
  version?: number;
  building_id?: number;
  incident_id?: number;
  started_at?: number;
  finished_at?: number;
  message?: string;
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
  if (["still", "moving", "walking", "behind_wall", "two_people"].includes(label ?? "")) return "present";
  if (["empty", "neighbor", "fan", "door", "heat"].includes(label ?? "")) return "empty";
  return null;
}

// 도우미 시계의 시각(초)을 화면 시계(ms)로 바꾼다
export function recTimeToLocal(rec: RecState, t: number, fetchedAt: number): number {
  return fetchedAt - (rec.now - t) * 1000;
}

// 녹화 프로세스가 바뀌거나 다음 단계로 넘어간 뒤 도착한 응답은 도우미가 거절한다.
export async function acknowledgeRecording(rec: RecState) {
  try {
    await fetch("/rec/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: rec.run_id, version: rec.version }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // 다음 /rec/scene 폴링에서 같은 단계라면 다시 보낸다.
  }
}
