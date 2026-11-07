import { Download, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IS_DEPLOYED, api } from "../api/client";
import ExperimentPanel from "../components/ExperimentPanel";
import { PredLegend, TruthLegend } from "../components/Legends";
import PlanView, { planBackground, planFromState } from "../components/PlanView";
import SpaceCard from "../components/SpaceCard";
import { StepCard, type StepStatus } from "../components/Step";
import Timeline from "../components/Timeline";
import TopBar from "../components/TopBar";
import { Button, CopyButton, Notice } from "../components/ui";
import { SERVER_COMMAND, collectorCommand, useCollectorSettings } from "../lib/collector";
import { receiverRows, type RxRow } from "../lib/receivers";
import { downloadText, recordsFileName, recordsToCsv } from "../lib/records";
import { ensureSite, findSite } from "../lib/site";
import { ago, clock, duration } from "../lib/time";
import { useLive, useTruthMap } from "../state/live";
import { useSession } from "../state/session";

const TITLES = ["서버 켜기", "실험 공간 등록 (처음 한 번)", "보드 켜고 수집기 실행", "기준선 보정 (빈 방 신호 저장)", "감지 시작", "실험하기", "마치기"];
const CAL_CHOICES = [60, 120, 180];

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
    dataMode, building, state, buildings, tokens, setTokens, selectBuilding, busy, run, now, records,
    modelMode, replay, error, setPreviewMock, history, truthEvents,
  } = useLive();
  const { mockOnly, exitMock } = useSession();
  const { gateway, setGateway, apiUrl } = useCollectorSettings();
  const truths = useTruthMap();
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [calSeconds, setCalSeconds] = useState(120);
  const [confirmTokens, setConfirmTokens] = useState(false);
  const [showCmd, setShowCmd] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  const mock = dataMode === "mock";
  const replaying = dataMode === "replay";
  const online = dataMode === "live" || dataMode === "idle" || replaying;

  // ---- 지금 상태로 각 단계가 끝났는지 판단한다 ----------------------------------
  const site = findSite(buildings);
  const onDemo = !!building?.is_demo;
  const rxNodes = building?.nodes.filter((n) => n.role === "rx") ?? [];
  const rxNames = rxNodes.map((n) => n.name);
  const rows = receiverRows(state, building, now);
  const receiving = rows.filter(isReceiving);
  const receivingNames = new Set(receiving.map((r) => r.name));
  const silent = rows.filter((r) => !isReceiving(r)).map((r) => r.name);
  const missingTokens = rxNames.filter((n) => !tokens[n]);
  const siteReady = !!building && !onDemo && building.zones.length > 0 && rxNodes.length > 0;

  const cal = building?.calibration ?? null;
  const calRunning = cal?.status === "running";
  const calibratedReceiving = rxNodes.filter((n) => n.calibrated && !n.restarted_since_calibration && receivingNames.has(n.name));
  const restarted = rxNodes.filter((n) => n.restarted_since_calibration && receivingNames.has(n.name));
  const notCalibrated = rxNodes.filter((n) => receivingNames.has(n.name) && !n.calibrated);
  const calTotal = cal ? Math.max(1, (Date.parse(cal.ends_at) - Date.parse(cal.started_at)) / 1000) : 1;
  const calLeft = calRunning && cal ? Math.max(0, (Date.parse(cal.ends_at) - now) / 1000) : 0;

  const incident = state?.incident.status === "active" ? state.incident : building?.active_incident ?? null;
  const detecting = !!incident && incident.status === "active";

  const done = [
    online,
    online && siteReady && (missingTokens.length === 0 || receiving.length > 0),
    online && siteReady && receiving.length > 0,
    online && siteReady && receiving.length > 0 && !calRunning && calibratedReceiving.length > 0 && restarted.length === 0,
    online && detecting,
  ];
  const firstOpen = done.findIndex((d) => !d);
  const current = firstOpen === -1 ? 6 : firstOpen + 1;
  const doneCount = done.filter(Boolean).length;
  const warn2 = siteReady && missingTokens.length > 0 && receiving.length === 0;
  const warn4 = restarted.length > 0 || cal?.status === "failed" || (detecting && !done[3]);

  const statusOf = (n: number): StepStatus => {
    if (mock || replaying) return n <= 5 ? "skipped" : "open";
    if (n <= 5) {
      if (done[n - 1]) return "done";
      if (n === current) return (n === 2 && warn2) || (n === 4 && warn4) ? "warn" : "current";
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
  const reissueTokens = () =>
    void run("토큰 새로 받기", async () => {
      if (!building) return;
      for (const n of rxNodes.filter((x) => !tokens[x.name])) {
        const res = await api.rotateNodeToken(n.id);
        setTokens(building.id, { [n.name]: res.token });
      }
      setConfirmTokens(false);
    });
  const startCal = () => building && void run("보정 시작", () => api.startCalibration(building.id, calSeconds));
  const stopCal = () => building && void run("보정 끝내기", () => api.stopCalibration(building.id));
  const startDetection = () => building && void run("감지 시작", () => api.openIncident(building.id, "실험"));
  const stopDetection = () => incident && void run("감지 끄기", () => api.closeIncident(incident.id));
  const endMock = () => (mockOnly ? exitMock() : setPreviewMock(false));
  const command = (masked: boolean) => collectorCommand({ gateway, api: apiUrl, receivers: rxNames, tokens, masked });
  const downloadCsv = () => downloadText(recordsFileName(), recordsToCsv(records));

  const plan = state ? planFromState(state) : null;
  const zones = state ? state.zones.slice().sort((a, b) => a.id - b.id) : [];
  const rxByZone = (id: number) => (state?.nodes ?? []).filter((n) => n.role === "rx" && n.zone_id === id);
  const skipped = mock ? "UI 예시라 건너뛰어요" : "녹화 재생 중이라 건너뛰어요";

  return (
    <div>
      <TopBar title="실험 진행" sub="위에서부터 차례대로 하면 돼요. 끝난 단계는 저절로 '완료'로 바뀌고 다음 단계가 열려요." />

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
            <Button variant="danger" disabled={!!busy} onClick={() => void run("시연 끝내기", () => api.closeIncident(state.incident.id))}>
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
                ? `서버 연결됨 · ${modelMode === "person" ? "사람 판별 모델 사용" : "모델 미연결이라 '신호 변화'만 판단해요"}`
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
                  ? `${building.name} · 구역 ${building.zones.length}개 · 보드 ${building.nodes.length}개${missingTokens.length ? " · 이 브라우저에 토큰 없음" : ""}`
                  : "아직 등록하지 않았어요"
          }
          before={
            warn2 ? (
              "이 브라우저에는 수신기 토큰(보드 비밀 열쇠)이 없어요. 다른 브라우저나 PC에서 등록했기 때문이에요."
            ) : (
              <>처음 한 번만 해요. 223호·224호·복도와 보드 4개(TX-1, RX-301·302·COR)를 서버에 등록해요.</>
            )
          }
          action={
            onDemo && site ? (
              <Button variant="primary" size="lg" onClick={() => selectBuilding(site.id)}>
                실험 공간으로 돌아가기
              </Button>
            ) : !siteReady ? (
              <Button variant="primary" size="lg" disabled={!online || !!busy} onClick={createSite}>
                실험 공간 등록하기
              </Button>
            ) : warn2 ? (
              confirmTokens ? (
                <>
                  <Button variant="danger" size="lg" disabled={!!busy} onClick={reissueTokens}>
                    네, 새로 받기
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmTokens(false)}>
                    취소
                  </Button>
                </>
              ) : (
                <Button variant="primary" size="lg" onClick={() => setConfirmTokens(true)}>
                  토큰 새로 받기
                </Button>
              )
            ) : (
              <Ok>등록돼 있어요</Ok>
            )
          }
          after={
            warn2
              ? confirmTokens
                ? "새로 받으면 예전 토큰으로 켜 둔 수집기는 멈춰요. 그 수집기는 3단계의 새 명령으로 다시 켜요."
                : "새 토큰이 이 브라우저에 저장되고, 3단계 수집기 명령에 자동으로 들어가요."
              : "보드 비밀 열쇠(토큰)가 이 브라우저에 저장되고, 3단계 수집기 명령에 자동으로 들어가요."
          }
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
              <li>TX-1(1번)과 쓸 수신 보드(예: 2번 RX-301)의 전원을 켜요.</li>
              <li>게이트웨이(5번)를 노트북 USB에 꽂아요.</li>
              <li>
                게이트웨이 포트{" "}
                <input
                  id="gateway-port"
                  aria-label="게이트웨이 포트"
                  value={gateway}
                  onChange={(e) => setGateway(e.target.value)}
                  className="mx-1 w-20 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-center font-mono text-sm"
                />
                를 확인해요. 장치 관리자 → 포트(COM과 LPT)에서 'CH343'이 붙은 번호예요.
              </li>
            </ol>
          }
          action={
            <>
              <CopyButton
                text={command(false)}
                label="수집기 명령 복사"
                variant="primary"
                size="lg"
                disabled={!siteReady || missingTokens.length === rxNames.length}
              />
              <button type="button" onClick={() => setShowCmd((v) => !v)} className="text-xs text-slate-500 underline hover:text-slate-800">
                {showCmd ? "명령 숨기기" : "명령 보기"}
              </button>
            </>
          }
          after={
            <>
              PowerShell을 하나 더 열고 <code className="rounded bg-white px-1">cd C:\wm\watchmate-be</code> → 붙여 넣기(Ctrl+V) → Enter.
              '실시간 전송 중입니다'가 뜨면 그 창은 켜 둔 채로 둬요. 아래 불이 초록으로 바뀌면 완료예요.
            </>
          }
        >
          {showCmd ? (
            <pre className="mb-4 whitespace-pre-wrap break-all rounded-xl bg-slate-900 px-4 py-3 font-mono text-xs leading-relaxed text-slate-100">
              {command(true)}
            </pre>
          ) : null}
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
                : done[3]
                  ? `기준선 저장됨: ${calibratedReceiving.map((n) => n.name).join(", ")}${cal?.finished_at ? ` · ${clock(Date.parse(cal.finished_at), false)}` : ""}`
                  : restarted.length
                    ? `${restarted.map((n) => n.name).join(", ")} 보드가 다시 켜져서 다시 보정해야 해요`
                    : cal?.status === "failed"
                      ? "지난 보정이 실패했어요. 다시 해요"
                      : "아직 보정하지 않았어요"
          }
          before={
            detecting && !done[3]
              ? "감지가 켜져 있으면 보정할 수 없어요."
              : "모두 223호·224호·복도에서 나와요. 문과 의자는 실험할 때와 똑같이 둬요. 끝날 때까지 아무도 들어가지 않아요."
          }
          action={
            detecting && !done[3] ? (
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
            ) : done[3] ? (
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
                    </option>
                  ))}
                </select>
                <Button variant="primary" size="lg" className="flex-1" disabled={!done[2] || !!busy} onClick={startCal}>
                  보정 시작
                </Button>
              </div>
            )
          }
          after={
            detecting && !done[3]
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
              {Object.entries(cal.result).map(([id, r]) => (
                <li key={id} className={`rounded-xl border px-4 py-2.5 ${r.ok ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200"}`}>
                  <b>{r.node}</b> · {r.ok ? `기준선 저장 (초당 ${r.fps ?? "—"}개)` : r.error ?? "실패"}
                </li>
              ))}
            </ul>
          ) : null}
          {notCalibrated.length && !calRunning ? (
            <p className="mt-2 text-sm text-amber-800">
              {notCalibrated.map((n) => n.name).join(", ")}은(는) 아직 보정 전이에요. 이 보드를 쓰려면 감지를 끄고 다시 보정해요.
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
          after="2초마다 구역 상태가 새로 나와요. 바로 아래 6단계에서 실험을 진행해요."
        />

        {/* 6. 실험하기 */}
        <StepCard
          n={6}
          title={TITLES[5]}
          status={statusOf(6)}
          forceOpen={!!state && (detecting || mock || replaying)}
          summary={state && (detecting || mock || replaying) ? `저장된 기록 ${records.length}건` : "5단계에서 감지를 켜면 열려요"}
          before={
            <>
              실험할 방을 고르고, <b>실제 상황이 바뀌는 그 순간</b> 해당 버튼을 눌러요. 예: 들어가 의자에 앉는 순간 '앉아 있음', 나가는 순간 '비어 있음'.
            </>
          }
          after="누를 때마다 직전 상태의 결과(일치·오탐·미탐)가 저절로 저장돼요. 모델은 이 버튼을 보지 않아요(채점에만 써요)."
        >
          {state && plan ? (
            <>
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
                    {state.mode === "person" ? "사람 모양 = 사람 있음(흐리고 ? = 가능성 있음). " : "파형 동그라미 = 빈 방과 신호가 달라짐(사람인지는 판단 안 함). "}
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
                    <li>모두 나간 상태에서 '비어 있음'을 누르고 30초 기다려요.</li>
                    <li>한 명이 들어가 앉는 순간 '앉아 있음'을 눌러요. 숨만 쉬고 가만히 있어요.</li>
                    <li>예측이 바뀌는지, 앉아 있는 동안 계속 유지되는지 봐요.</li>
                    <li>나가는 순간 '비어 있음'을 눌러요.</li>
                    <li>같은 순서를 10번 반복해요.</li>
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
                <Button variant="danger" size="lg" disabled={!!busy} onClick={() => void run("시연 끝내기", () => api.closeIncident(state.incident.id))}>
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

