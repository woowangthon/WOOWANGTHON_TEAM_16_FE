import { useEffect, useRef } from "react";
import { Clapperboard } from "lucide-react";
import { TRUTH_LABEL } from "../lib/labels";
import { acknowledgeRecording, truthFromLabel } from "../lib/recording";
import { ensureSite, findSite } from "../lib/site";
import { loadJson } from "../lib/storage";
import type { ExperimentRecord } from "../lib/records";
import { useLive } from "../state/live";

const PHASE_TEXT: Record<string, string> = {
  setup: "실험 공간 연결",
  preparing: "화면 연결 대기",
  calibrating: "빈 방 보정",
  starting: "감지 준비",
  waiting: "화면 준비 대기",
  armed: "녹화 시작 대기",
  countdown: "이동 중",
  recording: "녹화 중",
  between: "다음 장면 준비",
  done: "녹화 끝",
  idle: "대기",
};

// 녹화 도우미(record_live.py)와 연결되면 지금 장면과 남은 시간을 보여 주고, 실제 상태 자동 입력을 켜고 끈다
export default function RecordingBanner() {
  const { rec, recSync, setRecSync, state, building, dataMode, lastUpdate, error, truthEvents, records, buildings,
          selectBuilding, setTokens, run } = useLive();
  const settingUp = useRef(false);
  const site = findSite(buildings);
  const siteReady = !!site && building?.id === site.id && rec?.requested_nodes?.every((name) =>
    building.nodes.some((n) => n.name === name && n.role === "rx" && n.zone_id != null));

  useEffect(() => { settingUp.current = false; }, [rec?.run_id]);
  useEffect(() => {
    if (rec?.phase !== "setup" || !rec.sync || dataMode !== "idle" || !lastUpdate ||
        siteReady || settingUp.current || document.visibilityState !== "visible") return;
    settingUp.current = true;
    void run("실험 공간 자동 연결", async () => {
      const id = await ensureSite(site?.id ?? null, (bid, name, token) => setTokens(bid, { [name]: token }));
      selectBuilding(id);
    }).then((ok) => {
      if (!ok) settingUp.current = false;
    });
  }, [rec, site, siteReady, dataMode, lastUpdate, run, selectBuilding, setTokens]);


  useEffect(() => {
    if (!rec?.sync || !rec.running || (rec.phase === "setup" ? !siteReady : building?.id !== rec.building_id) ||
        error || !lastUpdate || Date.now() - lastUpdate > 5500 || !["live", "idle"].includes(dataMode)) return;
    if (rec.incident_id) {
      if (state?.incident.id !== rec.incident_id || state.summary.frozen || state.incident.status !== "active") return;
      const started = Math.round((rec.started_at ?? 0) * 1000);
      const durableRecords = rec.phase === "between" ? loadJson<ExperimentRecord[]>("wm.records", []) : [];
      for (const [name, label] of Object.entries(rec.labels)) {
        const node = state.nodes.find((n) => n.name === name && n.role === "rx");
        const zone = state.zones.find((z) => z.id === node?.zone_id);
        if (!node || !zone || !truthFromLabel(label)) return;
        if (rec.phase === "armed" && node.status !== "ok" && node.reason !== "low_rate") return;
        if (rec.phase === "recording" && !truthEvents.some((e) =>
            e.zoneId === zone.id && e.at === started && e.truth === truthFromLabel(label))) return;
        if (rec.phase === "between" && !durableRecords.some((r) =>
            r.incidentId === rec.incident_id && r.zone === zone.name && r.truthSince === started)) return;
      }
    }
    // 실제 실험 페이지가 보이고 React가 변경 내용을 그릴 기회를 얻은 뒤에만 확인을 보낸다.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (document.visibilityState === "visible") void acknowledgeRecording(rec);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [rec, state, building, dataMode, lastUpdate, error, truthEvents, records, siteReady]);
  if (!rec || !rec.running) return null;
  const elapsed = Math.max(0, rec.now - rec.phase_started); // 도우미 시계 기준. 1초마다 새로 받는다
  const left = rec.phase_seconds > 0 ? Math.max(0, Math.ceil(rec.phase_seconds - elapsed)) : null;
  const zones = state?.zones ?? [];
  const truths = zones
    .map((z) => {
      const rx = state?.nodes.filter((n) => n.role === "rx" && n.zone_id === z.id) ?? [];
      const t = truthFromLabel(rx.map((n) => rec.labels[n.name]).find((l) => l !== undefined));
      return t ? `${z.name} ${TRUTH_LABEL[t]}` : null;
    })
    .filter(Boolean);
  return (
    <div className="sticky top-0 z-20 mb-4 flex flex-col gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Clapperboard className="size-4 text-blue-700" />
        <b className="text-slate-900">
          녹화 연동 {rec.scene ? `· [${rec.index + 1}/${rec.total}] ${rec.scene}` : ""}
        </b>
        <span className="rounded-md bg-white px-2 py-0.5 text-blue-800 ring-1 ring-blue-200">
          {PHASE_TEXT[rec.phase] ?? rec.phase}
          {left !== null && (rec.phase === "countdown" || rec.phase === "recording") ? ` · ${left}초 남음` : ""}
        </span>
        {rec.next ? <span className="text-slate-500">다음: {rec.next.scene}</span> : null}
      </div>
      {rec.sync && rec.message ? <p>{rec.message}</p> : null}
      {rec.description ? <p className="text-slate-700">{rec.description}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-slate-600">{truths.length ? `이 장면의 실제 상태: ${truths.join(" · ")}` : ""}</span>
        <label className="inline-flex items-center gap-2 text-slate-700">
          <input id="rec-sync" type="checkbox" disabled={rec.sync} checked={rec.sync || recSync} onChange={(e) => setRecSync(e.target.checked)} />
          녹화 장면으로 실제 상태 자동 입력
        </label>
      </div>
    </div>
  );
}
