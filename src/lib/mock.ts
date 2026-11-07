import type { IncidentState, NodeInfo, ZoneState, ZoneStateCode } from "../api/types";
import { SITE_FLOOR_LABEL, SITE_NODES, siteNodePayload, siteZonePayload } from "./layout";

// UI 예시용 가상 데이터. 화면에는 항상 'UI 예시 · 가상 데이터'로 표시한다. 실제 탐지 결과가 아니다.
const CYCLE_S = 90;

function zoneStateAt(name: string, t: number): ZoneStateCode {
  const s = t % CYCLE_S;
  if (name === "224호") {
    if (s < 15) return "not_detected";
    if (s < 22) return "possible";
    if (s < 70) return "detected";
    return "not_detected";
  }
  if (name === "복도") {
    if (s >= 12 && s < 18) return "detected";
    if (s >= 66 && s < 72) return "possible";
    return "not_detected";
  }
  return "not_detected";
}

const P: Record<ZoneStateCode, number | null> = {
  detected: 0.86,
  possible: 0.48,
  not_detected: 0.08,
  warming: null,
  no_signal: null,
  uncalibrated: null,
  no_sensor: null,
};

export function mockState(now: number): IncidentState {
  const t = now / 1000;
  const zonesIn = siteZonePayload();
  const zones: ZoneState[] = zonesIn.map((z, i) => {
    const state = zoneStateAt(z.name, t);
    return {
      id: i + 1,
      name: z.name,
      polygon: z.polygon,
      state,
      p: P[state],
      evidence: state === "detected" ? ["빈 방 기준선보다 신호 흔들림이 큼(예시 문구)"] : [],
      partial_signal: false,
      node_ids: [i + 2],
      detected_since: null,
      priority: i + 1,
    };
  });
  const nodesIn = siteNodePayload();
  const nodes: NodeInfo[] = nodesIn.map((n, i) => ({
    id: i + 1,
    name: n.name,
    role: n.role,
    zone_id: n.zone ? zones.find((z) => z.name === n.zone)?.id ?? null : null,
    x: n.x,
    y: n.y,
    status: n.role === "tx" ? "tx" : "ok",
    reason: null,
    p: null,
    windows: 12,
    last_seen_s: 0.4,
    quality: 0.97,
    evidence: [],
    source: "live",
  }));
  const started = new Date(now - 10 * 60_000).toISOString();
  return {
    incident: { id: 0, building_id: 0, source: "manual", status: "active", started_at: started, ended_at: null, note: "UI 예시" },
    building: {
      id: 0,
      name: `${SITE_FLOOR_LABEL} (UI 예시)`,
      floor_label: SITE_FLOOR_LABEL,
      has_plan: false,
      plan_width: null,
      plan_height: null,
      is_demo: true,
    },
    mode: "person",
    model_version: null,
    server_time: new Date(now).toISOString(),
    zones,
    nodes,
    timeline: [
      { t: started, kind: "incident_open", message: "UI 예시 — 가상 데이터로 화면 구성을 보여 줍니다." },
    ],
    summary: {
      states: { detected: 0, possible: 0, not_detected: 0, warming: 0, no_signal: 0, uncalibrated: 0, no_sensor: 0 },
      replay: false,
      replay_running: false,
      frozen: false,
    },
  };
}

export const MOCK_RX_COUNT = SITE_NODES.filter((n) => n.role === "rx").length;
