import { Play, Square } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { IS_DEPLOYED, api } from "../api/client";
import { clock, duration } from "../lib/time";
import { useLive } from "../state/live";
import { Button, Notice } from "./ui";

// 백엔드는 '상황(incident)'이 열려 있을 때만 분석한다. 실험 화면에서는 이것을 '감지 켜기/끄기'로 보여 준다.
export default function DetectionBar() {
  const { dataMode, building, state, replay, error, busy, run, now } = useLive();
  const navigate = useNavigate();

  if (dataMode === "mock") {
    return (
      <Notice>
        지금은 <b>UI 예시 · 가상 데이터</b>예요. 화면 구성을 보여 주려는 값이고 실제 탐지 결과가 아니에요. 장치 관리에서 끌 수 있어요.
      </Notice>
    );
  }
  if (dataMode === "offline") {
    if (IS_DEPLOYED) {
      return (
        <Notice tone="warn">
          서버를 깨우는 중일 수 있어요. 무료 서버는 15분 동안 쓰지 않으면 잠들고, 깨우는 데 1분쯤 걸려요. 화면이 알아서 다시 연결해요.
        </Notice>
      );
    }
    return (
      <Notice tone="bad">
        백엔드에 연결할 수 없어요. <code className="rounded bg-white/70 px-1">C:\wm\watchmate-be</code>에서 서버를 켰는지 확인하세요
        (<code className="rounded bg-white/70 px-1">python -m uvicorn app.main:app --port 8000</code>). {error ? `(${error})` : ""}
      </Notice>
    );
  }
  if (dataMode === "loading") return <Notice>서버에 연결하는 중이에요.</Notice>;
  if (!building) {
    return (
      <Notice tone="warn">
        아직 실험 공간이 없어요. <Link to="/devices" className="font-medium underline">장치 관리</Link>에서 S4-1동 2층 실험 공간을 만드세요.
      </Notice>
    );
  }

  const calibrating = building.calibration?.status === "running";
  const incident = state?.incident ?? building.active_incident;

  if (dataMode === "replay" && state) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-3 text-sm text-violet-900">
        <span>
          {state.summary.frozen ? "녹화 재생이 끝났어요" : "녹화 데이터를 서버에서 다시 처리하는 중이에요"}
          {replay?.title ? ` · ${replay.title}` : ""}
          {replay?.running && replay.duration ? ` · ${duration(replay.elapsed ?? 0)} / ${duration(replay.duration)}` : ""}
          {state.summary.frozen ? " · 마지막 결과를 보여 주고 있어요" : ""}
        </span>
        <div className="ml-auto flex gap-2">
          {replay?.running ? (
            <Button disabled={!!busy} onClick={() => void run("재생 멈춤", () => api.stopReplay())}>
              <Square size={15} /> 재생 멈추기
            </Button>
          ) : null}
          <Button variant="danger" disabled={!!busy} onClick={() => void run("감지 끄기", () => api.closeIncident(state.incident.id))}>
            시연 끝내기
          </Button>
        </div>
      </div>
    );
  }

  if (incident && incident.status === "active") {
    const started = Date.parse(incident.started_at);
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-3 text-sm text-emerald-900">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
        </span>
        <span>
          <b>감지 중</b> · {clock(started)} 시작 ({duration((now - started) / 1000)}) · {building.name}
        </span>
        <Button className="ml-auto" variant="danger" disabled={!!busy} onClick={() => void run("감지 끄기", () => api.closeIncident(incident.id))}>
          <Square size={15} /> 감지 끄기
        </Button>
      </div>
    );
  }

  const uncalibrated = building.nodes.filter((n) => n.role === "rx" && !n.calibrated);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm text-slate-700">
      <span>
        <b>감지 꺼짐</b> · {building.name}
        {calibrating ? " · 기준선 보정 중이라 끝나야 감지를 켤 수 있어요" : ""}
        {!calibrating && uncalibrated.length ? ` · 보정 안 된 수신기: ${uncalibrated.map((n) => n.name).join(", ")}` : ""}
      </span>
      <div className="ml-auto flex gap-2">
        <Button onClick={() => navigate("/devices")}>기준선 보정</Button>
        <Button
          variant="primary"
          disabled={!!busy || calibrating}
          onClick={() => void run("감지 켜기", () => api.openIncident(building.id, "실험"))}
        >
          <Play size={15} /> 감지 시작
        </Button>
      </div>
    </div>
  );
}
