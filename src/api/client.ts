import type {
  BuildingDetail,
  BuildingSummary,
  Health,
  Incident,
  IncidentState,
  ModelCard,
  NodeOut,
  ReplayStatus,
  ScenarioPublic,
  ZoneOut,
} from "./types";

// 비워 두면 같은 주소의 /api(개발 서버 프록시)로 보낸다.
const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(/\/$/, "");

export const API_LABEL = BASE || "개발 서버 프록시 → 127.0.0.1:8000";

// 배포본(VITE_API_BASE가 있음): 무료 서버가 잠들었다 깨는 경우를 안내하고, 수집기 기본 주소로 쓴다
export const IS_DEPLOYED = BASE !== "";
export const API_BASE = BASE || "http://127.0.0.1:8000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setToken(value: string | null): void {
  token = value;
}

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

function detailMessage(data: unknown, status: number): string {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((d) => (d as { msg?: string }).msg ?? "").filter(Boolean).join(", ");
  }
  if (status === 0) return "서버에 연결할 수 없습니다. 백엔드가 켜져 있는지 확인하세요.";
  return `요청이 실패했습니다(${status}).`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, detailMessage(null, 0));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    // 개발 서버 프록시는 백엔드가 꺼져 있으면 500대 응답을 본문 없이 돌려준다
    if (res.status >= 500 && data === null) throw new ApiError(0, detailMessage(null, 0));
    throw new ApiError(res.status, detailMessage(data, res.status));
  }
  return data as T;
}

export const api = {
  health: () => request<Health>("GET", "/api/health"),
  login: (username: string, password: string) =>
    request<{ token: string; username: string; expires_at: string }>("POST", "/api/auth/login", {
      username,
      password,
    }),
  buildings: () => request<BuildingSummary[]>("GET", "/api/buildings"),
  building: (id: number) => request<BuildingDetail>("GET", `/api/buildings/${id}`),
  createBuilding: (body: { name: string; address: string; floor_label: string }) =>
    request<BuildingDetail>("POST", "/api/buildings", body),
  createZone: (buildingId: number, body: { name: string; polygon: number[][] }) =>
    request<ZoneOut>("POST", `/api/buildings/${buildingId}/zones`, body),
  createNode: (
    buildingId: number,
    body: { name: string; role: "tx" | "rx"; x: number; y: number; zone_id: number | null },
  ) => request<NodeOut>("POST", `/api/buildings/${buildingId}/nodes`, body),
  rotateNodeToken: (nodeId: number) => request<{ token: string }>("POST", `/api/nodes/${nodeId}/token`),
  startCalibration: (buildingId: number, seconds: number) =>
    request<BuildingDetail>("POST", `/api/buildings/${buildingId}/calibration/start`, {
      duration_seconds: seconds,
    }),
  stopCalibration: (buildingId: number) =>
    request<BuildingDetail>("POST", `/api/buildings/${buildingId}/calibration/stop`),
  openIncident: (buildingId: number, note: string) =>
    request<Incident & { created: boolean }>("POST", `/api/buildings/${buildingId}/incidents`, { note, measurement: true }),
  closeIncident: (incidentId: number) => request<Incident>("POST", `/api/incidents/${incidentId}/close`),
  incidentState: (incidentId: number) => request<IncidentState>("GET", `/api/incidents/${incidentId}/state`),
  planImage: async (buildingId: number): Promise<string> => {
    const res = await fetch(`${BASE}/api/buildings/${buildingId}/plan`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, "평면도를 불러오지 못했습니다.");
    return URL.createObjectURL(await res.blob());
  },
  modelCard: () => request<ModelCard>("GET", "/api/model/card"),
  scenarios: () => request<ScenarioPublic[]>("GET", "/api/demo/scenarios"),
  startScenario: (id: string, speed: number) =>
    request<ReplayStatus>("POST", `/api/demo/scenarios/${encodeURIComponent(id)}/start`, { speed }),
  stopReplay: () => request<ReplayStatus>("POST", "/api/demo/stop"),
  replayStatus: () => request<ReplayStatus>("GET", "/api/demo/status"),
};
