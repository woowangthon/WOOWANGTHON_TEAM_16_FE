import { Download, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE, IS_DEPLOYED, api } from "../api/client";
import RecordingBanner from "../components/RecordingBanner";
import ExperimentPanel from "../components/ExperimentPanel";
import GoalTracker from "../components/GoalTracker";
import { PredLegend, TruthLegend } from "../components/Legends";
import PlanView, { planBackground, planFromState } from "../components/PlanView";
import SpaceCard from "../components/SpaceCard";
import { StepCard, type StepStatus } from "../components/Step";
import Timeline from "../components/Timeline";
import TopBar from "../components/TopBar";
import { Button, CopyButton, Notice } from "../components/ui";
import { SERVER_COMMAND, helperCommand } from "../lib/collector";
import { CAL_RECOMMENDED_S, GOAL_REQUIRED, HOLD_S, SETTLE_S, WARMUP_S, calibrationIssue, calibrationNote, goalCounts, goalTotal } from "../lib/protocol";
import { receiverRows, type RxRow } from "../lib/receivers";
import { downloadText, recordsFileName, recordsToCsv } from "../lib/records";
import { ensureSite, findSite } from "../lib/site";
import { rangeText } from "../lib/ranges";
import { ago, clock, duration } from "../lib/time";
import { useLive, useTruthMap } from "../state/live";
import { useSession } from "../state/session";

const TITLES = ["서버 켜기", "실험 공간 등록 (처음 한 번)", "보드 켜고 수집기 실행", "기준선 보정 (빈 방 신호 저장)", "감지 시작", "실험하기", "마치기"];
const CAL_CHOICES = [120, CAL_RECOMMENDED_S, 300];

// 프레임이 들어오고 있는 수신기(재시작·프레임 부족이어도 보드는 보내는 중)
const RECEIVING = new Set<RxRow["status"]>(["seen", "ok", "warming", "uncalibrated"]);
const isReceiving = (r: RxRow) => RECEIVING.has(r.status) || (r.status === "stale" && (r.reason === "low_rate" || r.reason === "restarted"));

function Ok({ children }: { children: string }) {
  return <p className="rounded-lg bg-emerald-50 px-3 py-2.5 text-center text-[15px] font-bold text-emerald-700">{children}</p>;
}

function Wait({ children }: { children: string }) {
  return <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-center text-sm text-slate-500">{children}</p>;
}

export default function RunPage() {
  const {
    dataMode, building, state, buildings, setTokens, selectBuilding, busy, run, now, records,
    modelMode, replay, error, setPreviewMock, history, truthEvents, saveOpenTrials,
  } = useLive();
  const { mockOnly, exitMock } = useSession();
  const truths = useTruthMap();
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [calSeconds, setCalSeconds] = useState(CAL_RECOMMENDED_S);
  const [showTimeline, setShowTimeline] = useState(false);
  const [acceptedCalId, setAcceptedCalId] = useState<number | null>(null);

  const mock = dataMode === "mock";
  const replaying = dataMode === "replay";
  const online = dataMode === "live" || dataMode === "idle" || replaying;

  // ---- 지금 상태로 각 단계가 끝났는지 판단한다 ----------------------------------
  const site = findSite(buildings);
  const onDemo = !!building?.is_demo;
  const rxNodes = building?.nodes.filter((n) => n.role === "rx") ?? [];
  const rows = receiverRows(state, building, now);
  const receiving = rows.filter(isReceiving);
  const receivingNames = new Set(receiving.map((r) => r.name));
  const silent = rows.filter((r) => !isReceiving(r)).map((r) => r.name);
  const siteReady = !!building && !onDemo && building.zones.length > 0 && rxNodes.length > 0;

  const cal = building?.calibration ?? null;
  const calRunning = cal?.status === "running";
  const calibratedReceiving = rxNodes.filter((n) => n.calibrated && !n.restarted_since_calibration && receivingNames.has(n.name));
  const restarted = rxNodes.filter((n) => n.restarted_since_calibration && receivingNames.has(n.name));
  const notCalibrated = rxNodes.filter((n) => receivingNames.has(n.name) && !n.calibrated);
  const calTotal = cal ? Math.max(1, (Date.parse(cal.ends_at) - Date.parse(cal.started_at)) / 1000) : 1;
  const calLeft = calRunning && cal ? Math.max(0, (Date.parse(cal.ends_at) - now) / 1000) : 0;
  // 이 노트북 백엔드는 보정 마무리가 두 번 겹치면 결과 기록만 '실패 · 프레임 0'으로 덮어쓴다(기준선은 저장됨).
  // 결과가 모두 프레임 0인데 수신기가 보정됨이면 실패로 보지 않는다.
  const resultOverwritten =
    !!cal &&
    cal.status === "failed" &&
    !!cal.result &&
    Object.values(cal.result).every((r) => !r.ok && (r.frames ?? 0) === 0) &&
    rxNodes.some((n) => n.calibrated && !n.restarted_since_calibration);

  const incident = state?.incident.status === "active" ? state.incident : building?.active_incident ?? null;
  const detecting = !!incident && incident.status === "active";

  // 마지막 보정이 미덥지 않으면(문턱이 높거나 판정이 적음) 다시 보정하기 전까지 4단계에 머문다. '그대로 쓰기'를 누르면 넘어간다.
  const calIssues =
    cal && !calRunning && cal.result && cal.id !== acceptedCalId ? Object.values(cal.result).filter((r) => calibrationIssue(r)) : [];

  const done = [
    online,
    online && siteReady,
    online && siteReady && receiving.length > 0,
    online && siteReady && receiving.length > 0 && !calRunning && calibratedReceiving.length > 0 && restarted.length === 0 && calIssues.length === 0,
    online && detecting,
  ];
  const firstOpen = done.findIndex((d) => !d);
  const current = firstOpen === -1 ? 6 : firstOpen + 1;
  const doneCount = done.filter(Boolean).length;
  const warn4 =
    restarted.length > 0 || (cal?.status === "failed" && !resultOverwritten) || (detecting && !done[3]) || calIssues.length > 0;

  const statusOf = (n: number): StepStatus => {
    if (mock || replaying) return n <= 5 ? "skipped" : "open";
    if (n <= 5) {
      if (done[n - 1]) return "done";
      if (n === current) return n === 4 && warn4 ? "warn" : "current";
      return "todo";
    }
    if (n === 6) return detecting ? (current === 6 ? "current" : "open") : "todo";
    return detecting ? "open" : "todo";
  };

  // 단계가 끝나 다음 단계로 넘어가면 그 단계로 화면을 옮긴다(뒤로 갈 때는 옮기지 않는다)
  const lastCurrent = useRef<number | null>(null);
  useEffect(() => {
    if (mock || replaying || dataMode === "loading") return;
    const prev = lastCurrent.current;
    lastCurrent.current = current;
    if (prev !== null && current > prev) {
      document.getElementById(`step-${current}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [current, mock, replaying, dataMode]);

  // ---- 버튼 동작 ---------------------------------------------------------------
  const createSite = () =>
    void run("실험 공간 등록", async () => {
      const id = await ensureSite(site?.id ?? null, (bid, name, token) => setTokens(bid, { [name]: token }));
      selectBuilding(id);
    });
  const startCal = () => building && void run("보정 시작", () => api.startCalibration(building.id, calSeconds));
  const stopCal = () => building && void run("보정 끝내기", () => api.stopCalibration(building.id));
  const startDetection = () => building && void run("감지 시작", () => api.openIncident(building.id, "실험"));
  // 끄기 전에 아직 저장하지 않은 마지막 시도를 저장한다(감지를 끄면 그 시도는 더 이어지지 않으므로)
  const stopDetection = () =>
    incident &&
    void run("감지 끄기", async () => {
      saveOpenTrials();
      await api.closeIncident(incident.id);
    });
  const endReplay = () =>
    state &&
    void run("시연 끝내기", async () => {
      saveOpenTrials();
      await api.closeIncident(state.incident.id);
    });
  const endMock = () => (mockOnly ? exitMock() : setPreviewMock(false));
  const downloadCsv = () => downloadText(recordsFileName(), recordsToCsv(records));

  const plan = state ? planFromState(state) : null;
  const zones = state ? state.zones.slice().sort((a, b) => a.id - b.id) : [];
  const rxByZone = (id: number) => (state?.nodes ?? []).filter((n) => n.role === "rx" && n.zone_id === id);
  const skipped = mock ? "UI 예시라 건너뛰어요" : "녹화 재생 중이라 건너뛰어요";

  return (
    <div>
      <TopBar title="실험 진행" sub="위에서부터 차례대로 하면 돼요. 끝난 단계는 저절로 '완료'로 바뀌고 다음 단계가 열려요." />

      <RecordingBanner />

      {mock ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-3 text-sm text-blue-900">
          <span>
            지금은 <b>UI 예시 · 가상 데이터</b>예요. 실제 탐지 결과가 아니고, 1~5단계는 건너뛰고 6단계 화면만 보여 줘요.
          </span>
          <Button className="ml-auto" onClick={endMock}>
            UI 예시 끝내기
          </Button>
        </div>
      ) : null}

      {replaying && state ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-3 text-sm text-violet-900">
          <span>
            {state.summary.frozen ? "녹화 재생이 끝났어요" : "녹화 데이터를 다시 처리하는 중이에요"}
            {replay?.title ? ` · ${replay.title}` : ""}
            {replay?.running && replay.duration ? ` · ${duration(replay.elapsed ?? 0)} / ${duration(replay.duration)}` : ""}
          </span>
          <div className="ml-auto flex gap-2">
            {replay?.running ? (
              <Button disabled={!!busy} onClick={() => void run("재생 멈춤", () => api.stopReplay())}>
                <Square size={15} /> 재생 멈추기
              </Button>
            ) : null}
            <Button variant="danger" disabled={!!busy} onClick={endReplay}>
              시연 끝내기
            </Button>
          </div>
        </div>
      ) : null}

      {!mock && !replaying ? (
        <div className="mb-6 rounded-2xl bg-white px-5 py-4 ring-1 ring-slate-200">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm text-slate-500">지금 할 차례</span>
            <b className="text-[17px] text-slate-900">
              {current}. {TITLES[current - 1]}
            </b>
            <Button
              variant="ghost"
              onClick={() => document.getElementById(`step-${current}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              바로 가기
            </Button>
            <span className="ml-auto text-sm text-slate-500">준비 {doneCount}/5 단계 끝</span>
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1.5" aria-hidden>
            {done.map((d, i) => (
              <span key={i} className={`h-1.5 rounded-full ${d ? "bg-emerald-500" : i + 1 === current ? "bg-blue-500" : "bg-slate-200"}`} />
            ))}
          </div>
          {!detecting && records.length ? (
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
              <span>
                저장한 실험 기록 <b>{records.length}건</b>은 그대로 있어요. 감지를 꺼도 지워지지 않아요.
              </span>
              <Link to="/records" className="font-medium text-brand underline">
                기록 보기
              </Link>
              <button type="button" onClick={downloadCsv} className="font-medium text-brand underline">
                CSV 내려받기
              </button>
            </p>
          ) : null}
          {busy ? <p className="mt-3 text-sm text-blue-700">{busy} 중이에요…</p> : null}
          {error && online && !busy ? <p className="mt-3 text-sm text-red-700">방금 요청이 실패했어요: {error}</p> : null}
        </div>
      ) : null}

      <ol className="space-y-5">
        {/* 1. 서버 */}
        <StepCard
          n={1}
          title={TITLES[0]}
          status={statusOf(1)}
          summary={
            mock || replaying
              ? skipped
              : online
                ? `서버 연결됨 · ${modelMode === "person" ? "사람 판별 모델 사용" : "모델 없이 빈 방 대비 신호 변화(p)를 측정 기준으로 판단해요"}`
                : dataMode === "loading"
                  ? "서버에 연결하는 중이에요"
                  : "서버에 연결되지 않았어요"
          }
          before={
            IS_DEPLOYED
              ? "무료 서버라 15분 동안 아무도 쓰지 않으면 잠들어요."
              : "노트북에서 백엔드 서버가 켜져 있어야 해요. 서버용 PowerShell 창을 하나 열어 두세요."
          }
          action={
            online ? (
              <Ok>서버가 켜져 있어요</Ok>
            ) : IS_DEPLOYED ? (
              <Wait>서버를 깨우는 중… 1분쯤 기다려요</Wait>
            ) : (
              <CopyButton text={SERVER_COMMAND} label="서버 켜는 명령 복사" variant="primary" size="lg" />
            )
          }
          after={
            IS_DEPLOYED
              ? "깨어나면 이 단계가 저절로 '완료'로 바뀌어요."
              : "PowerShell에 붙여 넣고(Ctrl+V) Enter를 눌러요. 몇 초 뒤 이 단계가 저절로 '완료'로 바뀌어요. 그 창은 닫지 마세요."
          }
        />

        {/* 2. 실험 공간 */}
        <StepCard
          n={2}
          title={TITLES[1]}
          status={statusOf(2)}
          summary={
            mock || replaying
              ? skipped
              : onDemo
                ? "지금 시연 공간을 보고 있어요"
                : siteReady && building
                  ? `${building.name} · 구역 ${building.zones.length}개 · 보드 ${building.nodes.length}개`
                  : "아직 등록하지 않았어요"
          }
          before={<>처음 한 번만 해요. 223호·224호·복도와 보드 4개(TX-1, RX-301·302·COR)를 서버에 등록해요.</>}
          action={
            onDemo && site ? (
              <Button variant="primary" size="lg" onClick={() => selectBuilding(site.id)}>
                실험 공간으로 돌아가기
              </Button>
            ) : !siteReady ? (
              <Button variant="primary" size="lg" disabled={!online || !!busy} onClick={createSite}>
                실험 공간 등록하기
              </Button>
            ) : (
              <Ok>등록돼 있어요</Ok>
            )
          }
          after="다음 3단계로 넘어가요. 수신기 토큰(보드 비밀 열쇠)은 3단계 자동 실행이 서버에서 알아서 받아요."
        />

        {/* 3. 보드·수집기 */}
        <StepCard
          n={3}
          title={TITLES[2]}
          status={statusOf(3)}
          summary={
            mock || replaying
              ? skipped
              : receiving.length
                ? `${receiving.map((r) => r.name).join(", ")} 수신 중${silent.length ? ` · ${silent.join(", ")} 꺼짐` : ""}`
                : "아직 들어오는 수신기가 없어요"
          }
          before={
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>TX-1(1번)과 쓸 수신 보드(예: 2번 RX-301)의 전원을 손으로 켜요.</li>
              <li>게이트웨이(5번)를 노트북 USB에 꽂아요. 포트 번호는 몰라도 돼요.</li>
            </ol>
          }
          action={
            <>
              <CopyButton text={helperCommand(API_BASE, IS_DEPLOYED)} label="자동 실행 명령 복사" variant="primary" size="lg" disabled={!siteReady} />
              <p className="text-center text-xs leading-relaxed text-slate-500">
                탐색기에서 <code>start-collector.bat</code>을 두 번 눌러도 되고,
                <br />
                Claude에게 "게이트웨이 꽂았어"라고 해도 돼요
              </p>
            </>
          }
          after={
            <>
              PowerShell에 붙여 넣고 Enter. 새 창이 게이트웨이를 찾고 <b>TX-1·수신기 3개를 점검해 안 되는 보드와 고칠 점</b>을 알려 준 뒤, 토큰을
              알아서 받아 수집기를 켜요. 그 창은 켜 둔 채로 두세요. 아래 불이 초록으로 바뀌면 완료예요.
            </>
          }
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {rows.map((r) => {
              const on = isReceiving(r);
              return (
                <div key={r.id} className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${on ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200"}`}>
                  <span className={`size-3 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-slate-300"}`} />
                  <div className="min-w-0">
                    <div className="font-bold text-slate-900">
                      {r.name} <span className="font-normal text-slate-500">{r.zoneName ?? ""}</span>
                    </div>
                    <div className="text-sm text-slate-600">
                      {on
                        ? `수신 중 · ${ago(r.lastSeenS)}${r.quality !== null ? ` · 프레임 ${Math.round(r.quality * 100)}%` : ""}`
                        : `신호 없음${r.lastSeenS !== null ? ` · 마지막 ${ago(r.lastSeenS)}` : ""}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-sm text-slate-500">안 쓰는 수신기는 꺼져 있어도 괜찮아요. 초록 불이 하나라도 켜지면 다음 단계로 넘어가요.</p>
        </StepCard>

        {/* 4. 기준선 보정 */}
        <StepCard
          n={4}
          title={TITLES[3]}
          status={statusOf(4)}
          summary={
            mock || replaying
              ? skipped
              : calRunning
                ? `보정 중 · 남은 시간 ${duration(calLeft)}`
                : calIssues.length
                  ? `마지막 보정(${cal?.finished_at ? clock(Date.parse(cal.finished_at), false) : "?"})이 미덥지 않아요 · 모두 구역 밖에서 다시 보정하세요`
                  : done[3]
                  ? `기준선 저장됨: ${calibratedReceiving.map((n) => n.name).join(", ")}${cal?.finished_at ? ` · ${clock(Date.parse(cal.finished_at), false)}` : ""}${resultOverwritten ? " · 결과 기록은 확인 불가" : ""}`
                  : restarted.length
                    ? `${restarted.map((n) => n.name).join(", ")} 보드가 다시 켜져서 다시 보정해야 해요`
                    : cal?.status === "failed"
                      ? resultOverwritten
                        ? "기준선은 저장됨 · 결과 기록은 확인 불가"
                        : "지난 보정이 실패했어요. 다시 해요"
                      : cal?.status === "done"
                        ? `기준선이 있어요(${clock(Date.parse(cal.finished_at ?? cal.ends_at), false)} 보정) · 수신기가 다시 들어오면 그대로 써요`
                        : "아직 보정하지 않았어요"
          }
          before={
            detecting && (!done[3] || calIssues.length)
              ? "감지가 켜져 있으면 보정할 수 없어요."
              : "모두 223호·224호·복도에서 나와요. 실험자도 실험할 때 있을 자리(구역 밖, 예: 복도 끝)에 미리 가 있어요. 문과 의자는 실험할 때와 똑같이 두고, 끝날 때까지 아무도 들어가지 않아요."
          }
          action={
            detecting && (!done[3] || calIssues.length) ? (
              <Button variant="danger" size="lg" disabled={!!busy} onClick={stopDetection}>
                <Square size={16} /> 감지 끄기
              </Button>
            ) : calRunning ? (
              <>
                <div className="rounded-lg bg-blue-50 px-3 py-2.5 text-center">
                  <div className="text-sm text-blue-800">남은 시간</div>
                  <div className="text-2xl font-bold tabular text-blue-900">{duration(calLeft)}</div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
                    <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${Math.min(100, (1 - calLeft / calTotal) * 100)}%` }} />
                  </div>
                </div>
                <Button disabled={!!busy} onClick={stopCal}>
                  지금 끝내기
                </Button>
              </>
            ) : done[3] && !calIssues.length ? (
              <>
                <Ok>보정돼 있어요</Ok>
                {!detecting ? (
                  <button type="button" onClick={startCal} className="text-xs text-slate-500 underline hover:text-slate-800">
                    다시 보정하기
                  </button>
                ) : null}
              </>
            ) : (
              <div className="flex gap-2">
                <select
                  id="cal-seconds"
                  aria-label="보정 시간"
                  value={calSeconds}
                  onChange={(e) => setCalSeconds(Number(e.target.value))}
                  className="rounded-lg border border-slate-300 bg-white px-2 text-sm"
                >
                  {CAL_CHOICES.map((s) => (
                    <option key={s} value={s}>
                      {duration(s)}
                      {s === CAL_RECOMMENDED_S ? " (권장)" : ""}
                    </option>
                  ))}
                </select>
                <Button variant="primary" size="lg" className="flex-1" disabled={!done[2] || !!busy} onClick={startCal}>
                  보정 시작
                </Button>
              </div>
            )
          }
          extraAction={
            calIssues.length && cal && !calRunning && !detecting ? (
              <button type="button" onClick={() => setAcceptedCalId(cal.id)} className="text-xs text-slate-500 underline hover:text-slate-800">
                다시 보정하지 않고 이 보정 그대로 쓰기
              </button>
            ) : null
          }
          after={
            detecting && (!done[3] || calIssues.length)
              ? "감지를 끄면 '보정 시작' 버튼이 나와요."
              : calRunning
                ? "시간이 다 되면 저절로 끝나요. 그동안 방에 들어가지 마세요."
                : "끝나면 수신 중인 보드에 '기준선 저장'이 떠요. 꺼진 보드는 '프레임 없음'으로 나와도 괜찮아요."
          }
        >
          {calRunning && cal?.progress ? (
            <ul className="grid gap-2 text-sm sm:grid-cols-3">
              {Object.entries(cal.progress).map(([id, p]) => {
                const name = building?.nodes.find((n) => String(n.id) === id)?.name ?? `노드 ${id}`;
                return (
                  <li key={id} className="rounded-xl border border-slate-200 px-4 py-2.5 tabular">
                    <b>{name}</b> · 프레임 {p.frames.toLocaleString()}개{p.frames === 0 ? " · 아직 안 들어옴" : ` · ${p.seconds}초 분량`}
                  </li>
                );
              })}
            </ul>
          ) : cal && !calRunning && cal.result ? (
            <ul className="grid gap-2 text-sm sm:grid-cols-3">
              {Object.entries(cal.result).map(([id, r]) => {
                const issue = calibrationIssue(r);
                return (
                  <li
                    key={id}
                    className={`rounded-xl border px-4 py-2.5 ${issue ? "border-amber-300 bg-amber-50" : r.ok || resultOverwritten ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200"}`}
                  >
                    <b>{r.node}</b> ·{" "}
                    {r.ok
                      ? calibrationNote(r)
                      : resultOverwritten
                        ? "기준선은 저장됨 · 결과 기록은 확인 불가(이 서버 버전)"
                        : r.error ?? "실패"}
                    {issue ? (
                      <div className="mt-0.5 text-amber-800">
                        {issue} 모두 구역 밖에서 {duration(CAL_RECOMMENDED_S)} 다시 보정하세요.
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {notCalibrated.length && calibratedReceiving.length && !calRunning ? (
            <p className="mt-2 text-sm text-amber-800">
              {notCalibrated.map((n) => n.name).join(", ")}은(는) 아직 보정 전이에요.{" "}
              {detecting ? "이 보드도 쓰려면 감지를 끄고 다시 보정해요." : "이 보드도 쓰려면 '다시 보정하기'를 눌러요."}
            </p>
          ) : null}
        </StepCard>

        {/* 5. 감지 시작 */}
        <StepCard
          n={5}
          title={TITLES[4]}
          status={statusOf(5)}
          summary={
            mock || replaying
              ? skipped
              : detecting && incident
                ? `감지 중 · ${clock(Date.parse(incident.started_at), false)} 시작 · ${duration((now - Date.parse(incident.started_at)) / 1000)}째`
                : "감지 꺼짐"
          }
          before="보정이 끝났는지 확인해요. 사람은 아직 방 밖에 있어도 돼요."
          action={
            detecting ? (
              <Ok>감지 중이에요</Ok>
            ) : (
              <Button variant="primary" size="lg" disabled={!done[3] || !!busy} onClick={startDetection}>
                <Play size={17} /> 감지 시작
              </Button>
            )
          }
          after={`2초마다 구역 상태가 새로 나와요. 처음 ${WARMUP_S}초쯤은 '판단 준비 중'이니 기다렸다가 6단계를 시작해요.`}
        />

        {/* 6. 실험하기 */}
        <StepCard
          n={6}
          title={TITLES[5]}
          status={statusOf(6)}
          forceOpen={!!state && (detecting || mock || replaying)}
          summary={
            state && (detecting || mock || replaying)
              ? `필수 목표 ${goalTotal(goalCounts(records), GOAL_REQUIRED).done}/${goalTotal(goalCounts(records), GOAL_REQUIRED).total} · 저장된 기록 ${records.length}건`
              : "5단계에서 감지를 켜면 열려요"
          }
          before={
            <>
              실험할 방을 고르고, <b>사람이 문턱을 넘는 순간</b> 버튼을 눌러요. 들어갈 때 '앉아 있음'(앉을 거면), 나갈 때 '비어 있음'. 늦게 누르면
              직전 빈 방 시도가 오탐으로 기록돼요.
            </>
          }
          after={`각 상태를 ${HOLD_S}초 유지해요. 누르면 '예측이 따라오는 중(${SETTLE_S}초) → 안정 구간 → 다음 상태로 바꿔도 돼요'가 차례로 떠요. 바꿀 때와 감지를 끌 때 결과가 저절로 저장되니 저장 버튼은 안 눌러도 돼요.`}
        >
          {state && plan ? (
            <>
              <div className="mb-5">
                <GoalTracker />
              </div>
              <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                <div className="rounded-2xl border border-slate-200">
                  <ExperimentPanel zoneId={zoneId} onZoneChange={setZoneId} full />
                </div>
                <div className="rounded-2xl border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                    <b className="text-slate-900">도면</b>
                    <PredLegend />
                  </div>
                  <div className="overflow-x-auto p-3">
                    <div className="min-w-[480px]">
                      <PlanView background={planBackground(state.building)} zones={plan.zones} nodes={plan.nodes} mode={state.mode} truths={truths} />
                    </div>
                  </div>
                  <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
                    {state.mode === "person" ? "사람 모양 = 사람 있음(흐리고 ? = 가능성 있음). " : `파형 동그라미 = 빈 방과 신호가 달라짐 · ${rangeText(state.thresholds)}. `}
                    점선 상자 = 실험자가 누른 실제 상태. 구역 단위라 정확한 위치나 인원수는 알 수 없어요.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-3">
                {zones.map((z) => (
                  <SpaceCard key={z.id} zone={z} mode={state.mode} rx={rxByZone(z.id)} truth={truths[z.id] ?? null} compact />
                ))}
              </div>

              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 px-5 py-4">
                  <b className="text-slate-900">1순위 실험: 빈 방과 가만히 앉은 사람 구분</b>
                  <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[15px] text-slate-700">
                    <li>감지를 켜고 {WARMUP_S}초 기다린 뒤, 모두 방 밖인 걸 확인하고 '비어 있음'을 눌러요. {HOLD_S}초 기다려요.</li>
                    <li>한 명이 문턱을 넘는 순간 '앉아 있음'을 눌러요. 의자에 앉아 숨만 쉬고 {HOLD_S}초 가만히 있어요.</li>
                    <li>일어나 문을 나서는 순간 '비어 있음'을 눌러요. {HOLD_S}초 기다려요.</li>
                    <li>2~3을 10번 반복해요(한 번에 약 2분, 모두 약 20분).</li>
                    <li>실험자는 구역 밖에 있어요. 복도 구역 안에 서 있으면 RX-COR가 실험자를 잡아요.</li>
                  </ol>
                </div>
                <div className="rounded-2xl border border-slate-200 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <b className="text-slate-900">최근 5분 변화</b>
                    <Button variant="ghost" onClick={() => setShowTimeline((v) => !v)}>
                      {showTimeline ? "접기" : "펼치기"}
                    </Button>
                  </div>
                  {showTimeline ? (
                    <div className="mt-3 space-y-2">
                      <PredLegend />
                      <TruthLegend />
                      <Timeline zones={zones} history={history} truthEvents={truthEvents} now={now} minutes={5} />
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-slate-500">예측과 실제 상태가 시간에 따라 어떻게 바뀌었는지 막대로 봐요.</p>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </StepCard>

        {/* 7. 마치기 */}
        <StepCard
          n={7}
          title={TITLES[6]}
          status={statusOf(7)}
          last
          summary={`저장된 기록 ${records.length}건`}
          before="실험이 다 끝나면 눌러요."
          action={
            <>
              {mock ? (
                <Button variant="primary" size="lg" onClick={endMock}>
                  UI 예시 끝내기
                </Button>
              ) : replaying && state ? (
                <Button variant="danger" size="lg" disabled={!!busy} onClick={endReplay}>
                  시연 끝내기
                </Button>
              ) : detecting ? (
                <Button variant="danger" size="lg" disabled={!!busy} onClick={stopDetection}>
                  <Square size={16} /> 감지 끄기
                </Button>
              ) : null}
              <Button size="lg" disabled={!records.length} onClick={downloadCsv}>
                <Download size={17} /> 기록 CSV 내려받기
              </Button>
            </>
          }
          after={
            <>
              수집기 PowerShell 창에서 Ctrl+C를 눌러 멈추고, 보드 전원을 꺼요. CSV는 팀 드라이브에 올려요.{" "}
              <Link to="/records" className="font-medium text-brand underline">
                기록 자세히 보기
              </Link>
            </>
          }
        />
      </ol>

      {!online && !mock && dataMode !== "loading" && !IS_DEPLOYED ? (
        <div className="mt-6">
          <Notice tone="warn">서버가 꺼져 있으면 2~7단계를 할 수 없어요. 1단계부터 해 주세요.</Notice>
        </div>
      ) : null}
    </div>
  );
}

