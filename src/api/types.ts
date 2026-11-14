// 백엔드(watchmate-be) 응답 모양. app/serializers.py, app/services/state.py와 맞춘다.

export type ZoneStateCode =
  | "detected"
  | "possible"
  | "not_detected"
  | "warming"
  | "no_signal"
  | "uncalibrated"
  | "no_sensor";

export type NodeStatus = "ok" | "stale" | "warming" | "uncalibrated" | "tx";
export type ModelMode = "person" | "change";

export interface Incident {
  id: number;
  building_id: number;
  source: "alarm" | "manual" | "measurement" | "replay";
  status: "active" | "closed";
  started_at: string;
  ended_at: string | null;
  note: string;
}

export interface ZoneState {
  id: number;
  name: string;
  polygon: number[][];
  state: ZoneStateCode;
  server_state?: ZoneStateCode; // 화면 판단 범위(lib/ranges.ts)로 다시 매기기 전 서버 상태
  p: number | null;
  evidence: string[];
  partial_signal: boolean;
  node_ids: number[];
  detected_since: string | null;
  priority: number;
}

export interface NodeInfo {
  id: number;
  name: string;
  role: "rx" | "tx";
  zone_id: number | null;
  x: number;
  y: number;
  status: NodeStatus;
  reason?: "restarted" | "low_rate" | null;
  p?: number | null;
  windows?: number;
  last_seen_s?: number | null;
  quality?: number | null;
  evidence?: string[];
  source?: string | null;
}

export interface TimelineItem {
  t: string | null;
  kind: string;
  message?: string;
  zone?: string | null;
}

export interface IncidentState {
  thresholds?: { detected: number; possible: number };
  incident: Incident;
  building: {
    id: number;
    name: string;
    floor_label: string;
    has_plan: boolean;
    plan_width: number | null;
    plan_height: number | null;
    is_demo: boolean;
  };
  mode: ModelMode;
  model_version: string | null;
  server_time: string;
  zones: ZoneState[];
  nodes: NodeInfo[];
  timeline: TimelineItem[];
  summary: {
    states: Record<ZoneStateCode, number>;
    replay: boolean;
    replay_running: boolean;
    frozen: boolean;
  };
}

export interface BuildingSummary {
  id: number;
  name: string;
  address: string;
  floor_label: string;
  has_plan: boolean;
  plan_width: number | null;
  plan_height: number | null;
  is_demo: boolean;
  zone_count: number | null;
  node_count: number | null;
  active_incident_id: number | null;
}

export interface ZoneOut {
  id: number;
  name: string;
  polygon: number[][];
}

export interface NodeOut {
  id: number;
  name: string;
  role: "rx" | "tx";
  x: number;
  y: number;
  zone_id: number | null;
  has_token: boolean;
  last_seen_at: string | null;
  last_rssi: number | null;
  calibrated: boolean | null;
  restarted_since_calibration: boolean;
  token?: string;
}

export interface CalibrationNodeResult {
  node: string;
  frames: number;
  ok?: boolean;
  error?: string;
  windows?: number;
  fps?: number;
  tau?: number; // 이 기준선의 감지 문턱(빈 방 점수 상위 1%, 최저 2.0)
}

// 보정 중인 보드의 지금 상태(2초 구간마다). 흔들림은 이번 보정의 중간값을 1로 본 배수다.
export interface CalibrationLive {
  windows: number;
  fps: number;
  rssi: number | null;
  rssi_start: number | null;
  rssi_min: number | null;
  rssi_max: number | null;
  wobble: number | null;
  loud: number;
  series: (number | null)[];
}

export interface Calibration {
  id: number;
  status: "running" | "done" | "failed";
  started_at: string;
  ends_at: string;
  finished_at: string | null;
  result: Record<string, CalibrationNodeResult> | null;
  progress: Record<string, { frames: number; seconds: number; live?: CalibrationLive | null }> | null;
}

export interface BuildingDetail extends BuildingSummary {
  zones: ZoneOut[];
  nodes: NodeOut[];
  calibration: Calibration | null;
  active_incident: Incident | null;
}

export interface Health {
  status: string;
  version: string;
  mode: ModelMode;
}

export interface ScenarioPublic {
  id: string;
  title: string;
  description: string;
  synthetic: boolean;
  allowed: boolean;
  recorded_at: string;
  duration_seconds: number | null;
  zones: string[];
  rx_nodes: number;
  timeline: { at: number; text: string }[];
}

export interface ReplayStatus {
  running: boolean;
  scenario_id?: string;
  title?: string;
  building_id?: number;
  incident_id?: number;
  elapsed?: number;
  duration?: number;
  synthetic?: boolean;
  speed?: number;
  // 녹화할 때 실제로 있었던 일(녹화 시작부터 몇 초째인지와 설명)
  timeline?: { at: number; text: string }[];
  finished_at?: string;
}

export interface ModelCard {
  status?: string;
  mode?: ModelMode;
  summary?: string;
  limitations?: string[];
  version?: string;
  [key: string]: unknown;
}
