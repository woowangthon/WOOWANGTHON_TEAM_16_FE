import type { BuildingDetail, IncidentState } from "../api/types";
import { secondsSince } from "./time";

export interface RxRow {
  id: number;
  name: string;
  zoneName: string | null;
  // frozen: 재생이 끝났거나 멈춘 상황의 마지막 값(지금 수신 중이라는 뜻이 아님)
  status: "ok" | "stale" | "warming" | "uncalibrated" | "seen" | "silent" | "frozen";
  reason?: string | null;
  lastSeenS: number | null;
  quality: number | null;
  calibrated: boolean | null;
}

const SEEN_WINDOW_S = 6;

// 감지 중이면 상황 상태(state)의 노드 정보를, 꺼져 있으면 건물 정보의 마지막 수신 시각을 쓴다.
export function receiverRows(state: IncidentState | null, building: BuildingDetail | null, now: number): RxRow[] {
  if (state) {
    const zoneName = (id: number | null) => state.zones.find((z) => z.id === id)?.name ?? null;
    return state.nodes
      .filter((n) => n.role === "rx")
      .map((n) => ({
        id: n.id,
        name: n.name,
        zoneName: zoneName(n.zone_id),
        status: state.summary.frozen ? "frozen" : n.status === "tx" ? "silent" : n.status,
        reason: n.reason ?? null,
        lastSeenS: n.last_seen_s ?? null,
        quality: n.quality ?? null,
        calibrated: n.status !== "uncalibrated",
      }));
  }
  if (!building) return [];
  const zoneName = (id: number | null) => building.zones.find((z) => z.id === id)?.name ?? null;
  return building.nodes
    .filter((n) => n.role === "rx")
    .map((n) => {
      const age = secondsSince(n.last_seen_at, now);
      return {
        id: n.id,
        name: n.name,
        zoneName: zoneName(n.zone_id),
        status: age !== null && age <= SEEN_WINDOW_S ? "seen" : "silent",
        reason: n.restarted_since_calibration ? "restarted" : null,
        lastSeenS: age,
        quality: null,
        calibrated: n.calibrated,
      };
    });
}

export function receiverCount(rows: RxRow[]): { ok: number; total: number } {
  return { ok: rows.filter((r) => r.status === "ok" || r.status === "seen").length, total: rows.length };
}
