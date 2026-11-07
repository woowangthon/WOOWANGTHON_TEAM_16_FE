import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, api } from "../api/client";
import type {
  BuildingDetail,
  BuildingSummary,
  Health,
  IncidentState,
  ModelMode,
  ReplayStatus,
} from "../api/types";
import {
  appendPrediction,
  currentTruth,
  firstMatchAt,
  shareBetween,
  type PredHistory,
  type TruthEvent,
} from "../lib/history";
import { nodeStatusLabel, predLabel, type Truth } from "../lib/labels";
import { mockState } from "../lib/mock";
import { applyRanges } from "../lib/ranges";
import { PROTOCOL_ID, SETTLE_S } from "../lib/protocol";
import { fetchRecording, recTimeToLocal, truthFromLabel, type RecState } from "../lib/recording";
import type { DataModeLabel, ExperimentRecord } from "../lib/records";
import { compare } from "../lib/scoring";
import { loadJson, saveJson } from "../lib/storage";
import { useSession } from "./session";

// live: 실제 센서 데이터로 감지 중, replay: 녹화 데이터 재생, mock: UI 예시(가상 데이터)
// idle: 서버는 연결됐지만 감지(상황)가 꺼져 있음, offline: 서버에 연결 안 됨
export type DataMode = "loading" | "live" | "replay" | "mock" | "idle" | "offline";

const POLL_MS = 2000;
const LIST_EVERY_MS = 10_000;

interface LiveValue {
  dataMode: DataMode;
  previewMock: boolean;
  setPreviewMock: (on: boolean) => void;
  health: Health | null;
  buildings: BuildingSummary[];
  buildingId: number | null;
  selectBuilding: (id: number | null) => void;
  building: BuildingDetail | null;
  state: IncidentState | null;
  modelMode: ModelMode | null;
  replay: ReplayStatus | null;
  error: string | null;
  now: number;
  lastUpdate: number | null;
  history: PredHistory;
  truthEvents: TruthEvent[];
  setTruth: (zoneId: number, truth: Truth) => void;
  autoSave: boolean;
  setAutoSave: (on: boolean) => void;
  delayLimit: number;
  setDelayLimit: (s: number) => void;
  records: ExperimentRecord[];
  saveRecord: (zoneId: number, note: string) => ExperimentRecord | null;
  saveOpenTrials: () => number;
  deleteRecord: (id: string) => void;
  clearRecords: () => void;
  tokens: Record<string, string>;
  setTokens: (buildingId: number, map: Record<string, string>) => void;
  busy: string | null;
  run: (label: string, fn: () => Promise<unknown>) => Promise<boolean>;
  refresh: () => void;
  rec: RecState | null; // 녹화 도우미가 알려 주는 지금 장면(없으면 null)
  recSync: boolean; // 녹화 장면으로 실제 상태를 자동 입력할지
  setRecSync: (on: boolean) => void;
}

const LiveContext = createContext<LiveValue | null>(null);

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "알 수 없는 오류가 났습니다.";
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { token, mockOnly } = useSession();
  const [previewMock, setPreviewMockState] = useState<boolean>(() => loadJson("wm.previewMock", false));
  const mock = mockOnly || previewMock;

  const [health, setHealth] = useState<Health | null>(null);
  const [buildings, setBuildings] = useState<BuildingSummary[]>([]);
  const [buildingId, setBuildingId] = useState<number | null>(() => loadJson<number | null>("wm.buildingId", null));
  const [building, setBuilding] = useState<BuildingDetail | null>(null);
  const [liveState, setLiveState] = useState<IncidentState | null>(null);
  const [replay, setReplay] = useState<ReplayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [pollNonce, setPollNonce] = useState(0);

  const [records, setRecords] = useState<ExperimentRecord[]>(() => loadJson("wm.records", []));
  const [autoSave, setAutoSaveState] = useState<boolean>(() => loadJson("wm.autoSave", true));
  const [delayLimit, setDelayLimitState] = useState<number>(() => loadJson("wm.delayLimit", 30));
  const [tokensAll, setTokensAll] = useState<Record<string, Record<string, string>>>(() => loadJson("wm.tokens", {}));
  const [rec, setRec] = useState<RecState | null>(null);
  const [recFetchedAt, setRecFetchedAt] = useState(0);
  const [recSync, setRecSyncState] = useState<boolean>(() => loadJson("wm.recSync", true));

  // 1초마다 시계를 움직여 "n초 전" 같은 표시를 갱신한다
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const setPreviewMock = useCallback((on: boolean) => {
    setPreviewMockState(on);
    saveJson("wm.previewMock", on);
  }, []);

  // 녹화 재생을 따라 시연 공간으로 자동 이동했는지(직접 고른 경우는 되돌리지 않는다). 새로 고쳐도 기억한다.
  const followedReplayRef = useRef<boolean>(loadJson("wm.followedReplay", false));
  const setFollowed = (on: boolean) => {
    followedReplayRef.current = on;
    saveJson("wm.followedReplay", on);
  };

  const selectBuilding = useCallback((id: number | null) => {
    setFollowed(false);
    setBuildingId(id);
    saveJson("wm.buildingId", id);
    setBuilding(null);
    setLiveState(null);
  }, []);

  // ---- 서버 폴링 -----------------------------------------------------------
  const buildingIdRef = useRef(buildingId);
  buildingIdRef.current = buildingId;
  const lastListAt = useRef(0);
  const replayRunningRef = useRef(false);

  useEffect(() => {
    if (mock || !token) return;
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const t = Date.now();
        if (t - lastListAt.current > LIST_EVERY_MS) {
          const [h, list, rp] = await Promise.all([api.health(), api.buildings(), api.replayStatus()]);
          if (!alive) return;
          lastListAt.current = t;
          setHealth(h);
          setBuildings(list);
          setReplay(rp);
          replayRunningRef.current = rp.running;
          // 녹화 재생이 돌고 있으면 그 시연 공간을 따라가고, 시연을 끝내면 원래 실험 공간으로 돌아온다
          let id = buildingIdRef.current;
          if (rp.running && rp.building_id && rp.building_id !== id) {
            id = rp.building_id;
            setFollowed(true);
          }
          const cur = list.find((b) => b.id === id);
          if (!rp.running && followedReplayRef.current && cur?.is_demo && !cur.active_incident_id) {
            id = list.find((b) => !b.is_demo)?.id ?? id;
            setFollowed(false);
          }
          if (id === null || !list.some((b) => b.id === id)) {
            id = list.find((b) => !b.is_demo)?.id ?? list[0]?.id ?? null;
          }
          if (id !== buildingIdRef.current) {
            buildingIdRef.current = id;
            setBuildingId(id);
            saveJson("wm.buildingId", id);
          }
        } else if (replayRunningRef.current) {
          // 재생 중에는 진행 시간을 매번 갱신한다
          const rp = await api.replayStatus();
          if (!alive) return;
          setReplay(rp);
          replayRunningRef.current = rp.running;
        }
        const id = buildingIdRef.current;
        if (id !== null) {
          const detail = await api.building(id);
          if (!alive) return;
          setBuilding(detail);
          if (detail.active_incident) {
            const st = await api.incidentState(detail.active_incident.id);
            if (!alive) return;
            setLiveState(applyRanges(st));
          } else {
            setLiveState(null);
          }
        } else {
          setBuilding(null);
          setLiveState(null);
        }
        setOffline(false);
        setError(null);
        setLastUpdate(Date.now());
      } catch (e) {
        if (!alive) return;
        setError(errorText(e));
        if (e instanceof ApiError && e.status === 0) setOffline(true);
      } finally {
        if (alive) {
          setLoaded(true);
          timer = window.setTimeout(tick, POLL_MS);
        }
      }
    };
    lastListAt.current = 0;
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mock, token, pollNonce]);

  // UI 예시: 가상 데이터를 2초마다 만든다
  const [mockSnap, setMockSnap] = useState<IncidentState | null>(null);
  useEffect(() => {
    if (!mock) {
      setMockSnap(null);
      return;
    }
    const make = () => {
      setMockSnap(applyRanges(mockState(Date.now())));
      setLastUpdate(Date.now());
    };
    make();
    const id = window.setInterval(make, POLL_MS);
    return () => window.clearInterval(id);
  }, [mock]);

  const state = mock ? mockSnap : liveState;

  const dataMode: DataMode = mock
    ? "mock"
    : offline
      ? "offline"
      : !loaded
        ? "loading"
        : state
          ? state.incident.source === "replay"
            ? "replay"
            : "live"
          : "idle";

  // ---- 예측 기록(구간)과 실제 상태 입력 -----------------------------------------
  const historyKey = mock ? "mock" : state ? `inc${state.incident.id}` : null;
  const [history, setHistory] = useState<PredHistory>({});
  const [truthEvents, setTruthEvents] = useState<TruthEvent[]>([]);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    if (historyKey === keyRef.current) return;
    keyRef.current = historyKey;
    setHistory(historyKey ? loadJson(`wm.hist.${historyKey}`, {}) : {});
    setTruthEvents(historyKey ? loadJson(`wm.truth.${historyKey}`, []) : []);
  }, [historyKey]);

  const lastAppended = useRef<string | null>(null);
  useEffect(() => {
    if (!state || !historyKey || keyRef.current !== historyKey) return;
    if (state.summary.frozen) return; // 끝난 상황·재생은 더 쌓지 않는다
    const stamp = `${historyKey}:${state.server_time}`;
    if (lastAppended.current === stamp) return;
    lastAppended.current = stamp;
    setHistory((h) => {
      const next = appendPrediction(h, state.zones, state.mode, Date.now());
      saveJson(`wm.hist.${historyKey}`, next);
      return next;
    });
  }, [state, historyKey]);

  const modelMode: ModelMode | null = state?.mode ?? health?.mode ?? null;

  const dataModeLabel = (): DataModeLabel => (dataMode === "mock" ? "UI 예시" : dataMode === "replay" ? "기록 재생" : "실시간");

  const buildRecord = useCallback(
    (zoneId: number, how: "수동" | "자동", note: string, truthEv: TruthEvent, at: number): ExperimentRecord | null => {
      if (!state) return null;
      const zone = state.zones.find((z) => z.id === zoneId);
      if (!zone) return null;
      const label = predLabel(zone.state, state.mode);
      const outcome = compare(truthEv.truth, label.cls);
      const matched = firstMatchAt(history[String(zoneId)], truthEv.truth, truthEv.at);
      const reactionSec = matched === null ? null : (matched - truthEv.at) / 1000;
      // 판단 불가(채점 제외)는 반응 시간을 따지지 않는다
      const delayed =
        outcome === "unscored" ? false : reactionSec === null ? (at - truthEv.at) / 1000 > delayLimit : reactionSec > delayLimit;
      const rx = state.nodes.filter((n) => n.role === "rx" && n.zone_id === zoneId);
      return {
        id: `${at}-${zoneId}-${Math.random().toString(36).slice(2, 7)}`,
        savedAt: at,
        how,
        incidentId: mock ? null : state.incident.id,
        building: state.building.name,
        zone: zone.name,
        receivers: rx.map((n) => n.name).join(", "),
        truth: truthEv.truth,
        truthSince: truthEv.at,
        prediction: label.text,
        predState: zone.state,
        p: zone.p,
        outcome,
        reactionSec,
        delayed,
        dataMode: dataModeLabel(),
        modelMode: state.mode === "person" ? `사람 판별 모델${state.model_version ? ` ${state.model_version}` : ""}` : "모델 미연결(1단계 신호 변화)",
        reception: rx
          .map((n) => {
            const s = nodeStatusLabel(n);
            const q = n.quality === null || n.quality === undefined ? "" : ` ${Math.round(n.quality * 100)}%`;
            return `${n.name} ${s.text}${q}`;
          })
          .join(" / "),
        note,
        protocol: PROTOCOL_ID,
      };
    },
    // dataModeLabel은 dataMode에 따라 바뀐다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, history, delayLimit, mock, dataMode],
  );

  const pushRecord = useCallback((r: ExperimentRecord) => {
    setRecords((rs) => {
      const next = [r, ...rs];
      saveJson("wm.records", next);
      return next;
    });
  }, []);

  // 한 번의 시도 = 한 구역에서 실제 상태 하나가 이어진 구간(상황 번호 + 구역 + 시작 시각)
  const savedTrial = useCallback(
    (zoneName: string, since: number) =>
      records.find((r) => r.incidentId === (mock ? null : state?.incident.id ?? null) && r.zone === zoneName && r.truthSince === since) ?? null,
    [records, mock, state],
  );
  const zoneNameOf = useCallback((zoneId: number) => state?.zones.find((z) => z.id === zoneId)?.name ?? "", [state]);

  const setTruth = useCallback(
    (zoneId: number, truth: Truth) => {
      if (!historyKey) return;
      const at = Date.now();
      const prev = currentTruth(truthEvents, zoneId);
      if (prev && prev.truth === truth) return;
      // 직접 저장한 시도는 다시 저장하지 않는다
      if (prev && autoSave && !savedTrial(zoneNameOf(zoneId), prev.at)) {
        const rec = buildRecord(zoneId, "자동", "실제 상태를 바꿀 때 자동 저장", prev, at);
        if (rec) pushRecord(rec);
      }
      const next = [...truthEvents, { zoneId, truth, at }];
      setTruthEvents(next);
      saveJson(`wm.truth.${historyKey}`, next);
    },
    [historyKey, truthEvents, autoSave, buildRecord, pushRecord, savedTrial, zoneNameOf],
  );

  const saveRecord = useCallback(
    (zoneId: number, note: string) => {
      const ev = currentTruth(truthEvents, zoneId);
      if (!ev) return null;
      // 저장 버튼을 연달아 눌렀을 때(3초 안) 같은 시도를 두 번 넣지 않는다
      const last = savedTrial(zoneNameOf(zoneId), ev.at);
      if (last && Date.now() - last.savedAt < 3000) return last;
      const rec = buildRecord(zoneId, "수동", note, ev, Date.now());
      if (rec) pushRecord(rec);
      return rec;
    },
    [truthEvents, buildRecord, pushRecord, savedTrial, zoneNameOf],
  );

  // 감지를 끄기 직전에, 아직 저장하지 않은 시도(구역마다 마지막 실제 상태)를 저장한다
  const saveOpenTrials = useCallback(() => {
    if (!state || !autoSave) return 0;
    const at = Date.now();
    let n = 0;
    for (const z of state.zones) {
      const ev = currentTruth(truthEvents, z.id);
      if (!ev || savedTrial(z.name, ev.at)) continue;
      const rec = buildRecord(z.id, "자동", "감지를 끌 때 자동 저장", ev, at);
      if (rec) {
        pushRecord(rec);
        n += 1;
      }
    }
    return n;
  }, [state, autoSave, truthEvents, savedTrial, buildRecord, pushRecord]);

  // ---- 녹화 장면 연동 ---------------------------------------------------------
  // 녹화 도우미(record_live.py)가 1초마다 지금 장면을 알려 준다. 장면 녹화가 시작되면 구역마다 실제 상태를
  // 그 장면의 라벨로 바꾸고, 장면이 끝나면 그 장면 동안의 판단 비율을 기록으로 저장한다.
  useEffect(() => {
    if (mock) {
      setRec(null);
      return;
    }
    let alive = true;
    let misses = 0;
    const tick = async () => {
      const r = await fetchRecording();
      if (!alive) return;
      // 한두 번 못 받은 건 넘기고, 3번 연속 응답이 없으면 녹화 도우미가 끝난 것으로 본다
      if (r) {
        misses = 0;
        setRec(r);
        setRecFetchedAt(Date.now());
      } else if (++misses >= 3) {
        setRec(null);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [mock]);

  const setRecSync = useCallback((on: boolean) => {
    setRecSyncState(on);
    saveJson("wm.recSync", on);
  }, []);

  // 장면이 바뀔 때마다 구역마다 새 시도를 시작한다(같은 실제 상태가 이어져도 장면별로 따로 채점)
  const applySceneTruth = useCallback(
    (changes: { zoneId: number; truth: Truth }[], at: number, scene: string) => {
      if (!historyKey || !changes.length) return;
      let next = truthEvents;
      for (const { zoneId, truth } of changes) {
        const prev = currentTruth(next, zoneId);
        if (prev && autoSave && !savedTrial(zoneNameOf(zoneId), prev.at)) {
          const r = buildRecord(zoneId, "자동", `녹화 장면 ${scene} 시작 전 자동 저장`, prev, at);
          if (r) pushRecord(r);
        }
        next = [...next, { zoneId, truth, at }];
      }
      setTruthEvents(next);
      saveJson(`wm.truth.${historyKey}`, next);
    },
    [historyKey, truthEvents, autoSave, savedTrial, zoneNameOf, buildRecord, pushRecord],
  );

  // 장면이 끝나면 구역마다 그 장면 동안(앞 20초는 따라오는 시간이라 뺌)의 판단 비율을 메모에 담아 저장한다
  const saveSceneRecords = useCallback(
    (scene: string, startedAt: number) => {
      if (!state) return;
      const at = Date.now();
      for (const z of state.zones) {
        const ev = currentTruth(truthEvents, z.id);
        if (!ev || ev.at !== startedAt || savedTrial(z.name, ev.at)) continue;
        const from = ev.at + Math.min(SETTLE_S * 1000, (at - ev.at) / 2);
        const sh = shareBetween(history[String(z.id)], from, at);
        const pct = (v: number) => `${Math.round(v * 100)}%`;
        const note = sh
          ? `녹화 장면 ${scene} · 측정됨 ${pct(sh.present)} · 애매함 ${pct(sh.maybe)} · 비어 있음 ${pct(sh.absent)} · 판단 불가 ${pct(sh.unknown)}`
          : `녹화 장면 ${scene} · 판단 기록 없음`;
        const r = buildRecord(z.id, "자동", note, ev, at);
        if (r) pushRecord(r);
      }
    },
    [state, truthEvents, savedTrial, history, buildRecord, pushRecord],
  );

  const appliedRef = useRef<{ key: string; scene: string; at: number } | null>(null);
  const savedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!recSync || mock || !state || state.summary.frozen || state.incident.status !== "active") return;
    const applied = appliedRef.current;
    if (!rec) {
      // 녹화 도우미가 끝났다. 마지막 장면을 저장한다
      if (applied && savedKeyRef.current !== applied.key) {
        saveSceneRecords(applied.scene, applied.at);
        savedKeyRef.current = applied.key;
      }
      return;
    }
    if (rec.phase === "recording" && rec.scene) {
      const key = `${state.incident.id}#${rec.day}#${rec.index}#${Math.round(rec.phase_started)}`;
      if (applied?.key === key) return;
      if (applied && savedKeyRef.current !== applied.key) {
        saveSceneRecords(applied.scene, applied.at);
        savedKeyRef.current = applied.key;
      }
      const at = Math.round(recTimeToLocal(rec, rec.phase_started, recFetchedAt));
      const changes: { zoneId: number; truth: Truth }[] = [];
      for (const z of state.zones) {
        const rx = state.nodes.filter((n) => n.role === "rx" && n.zone_id === z.id);
        const label = rx.map((n) => rec.labels[n.name]).find((l) => l !== undefined);
        const truth = truthFromLabel(label);
        if (truth) changes.push({ zoneId: z.id, truth });
      }
      applySceneTruth(changes, at, rec.scene);
      appliedRef.current = { key, scene: rec.scene, at };
    } else if (applied && savedKeyRef.current !== applied.key) {
      // 지금 장면 녹화가 끝났다(이동 중·다음 장면 대기·녹화 끝)
      saveSceneRecords(applied.scene, applied.at);
      savedKeyRef.current = applied.key;
    }
  }, [rec, recFetchedAt, recSync, mock, state, applySceneTruth, saveSceneRecords]);

  const deleteRecord = useCallback((id: string) => {
    setRecords((rs) => {
      const next = rs.filter((r) => r.id !== id);
      saveJson("wm.records", next);
      return next;
    });
  }, []);

  const clearRecords = useCallback(() => {
    setRecords([]);
    saveJson("wm.records", []);
  }, []);

  const setAutoSave = useCallback((on: boolean) => {
    setAutoSaveState(on);
    saveJson("wm.autoSave", on);
  }, []);

  const setDelayLimit = useCallback((s: number) => {
    const v = Math.max(5, Math.min(300, Math.round(s)));
    setDelayLimitState(v);
    saveJson("wm.delayLimit", v);
  }, []);

  const setTokens = useCallback((bid: number, map: Record<string, string>) => {
    setTokensAll((all) => {
      const next = { ...all, [String(bid)]: { ...(all[String(bid)] ?? {}), ...map } };
      saveJson("wm.tokens", next);
      return next;
    });
  }, []);

  const refresh = useCallback(() => setPollNonce((n) => n + 1), []);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      try {
        await fn();
        setError(null);
        refresh();
        return true;
      } catch (e) {
        setError(errorText(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const value = useMemo<LiveValue>(
    () => ({
      dataMode,
      previewMock,
      setPreviewMock,
      health,
      buildings,
      buildingId,
      selectBuilding,
      building: mock ? null : building,
      state,
      modelMode,
      replay,
      error: mock ? null : error,
      now,
      lastUpdate,
      history,
      truthEvents,
      setTruth,
      autoSave,
      setAutoSave,
      delayLimit,
      setDelayLimit,
      records,
      saveRecord,
      saveOpenTrials,
      deleteRecord,
      clearRecords,
      tokens: buildingId !== null ? tokensAll[String(buildingId)] ?? {} : {},
      setTokens,
      busy,
      run,
      refresh,
      rec,
      recSync,
      setRecSync,
    }),
    [
      dataMode, previewMock, setPreviewMock, health, buildings, buildingId, selectBuilding, building, mock, state,
      modelMode, replay, error, now, lastUpdate, history, truthEvents, setTruth, autoSave, setAutoSave, delayLimit,
      setDelayLimit, records, saveRecord, saveOpenTrials, deleteRecord, clearRecords, tokensAll, setTokens, busy, run, refresh,
      rec, recSync, setRecSync,
    ],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveValue {
  const v = useContext(LiveContext);
  if (!v) throw new Error("LiveProvider가 필요합니다.");
  return v;
}

// 구역마다 실험자가 마지막으로 입력한 실제 상태
export function useTruthMap(): Record<number, Truth> {
  const { state, truthEvents } = useLive();
  const map: Record<number, Truth> = {};
  for (const z of state?.zones ?? []) {
    const ev = currentTruth(truthEvents, z.id);
    if (ev) map[z.id] = ev.truth;
  }
  return map;
}
