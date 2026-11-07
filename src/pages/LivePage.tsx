import { useState } from "react";
import { useNavigate } from "react-router-dom";
import DetectionBar from "../components/DetectionBar";
import DeviceStrip from "../components/DeviceStrip";
import ExperimentPanel from "../components/ExperimentPanel";
import LogPanel from "../components/LogPanel";
import PlanView, { planBackground, planFromBuilding, planFromState } from "../components/PlanView";
import SpaceCard from "../components/SpaceCard";
import Timeline, { WINDOWS } from "../components/Timeline";
import TopBar from "../components/TopBar";
import { Button, Card, CardHeader } from "../components/ui";
import { currentTruth } from "../lib/history";
import { PRED_COLOR, TRUTHS, TRUTH_COLOR, TRUTH_LABEL, type Truth } from "../lib/labels";
import { useLive } from "../state/live";

export function PredLegend() {
  const { state, modelMode } = useLive();
  const person = (state?.mode ?? modelMode ?? "person") === "person";
  const items: [string, string][] = [
    [person ? "사람 있음" : "신호 변화 큼", PRED_COLOR.present],
    [person ? "가능성 있음" : "신호 변화 조금", PRED_COLOR.maybe],
    [person ? "감지 안 됨" : "변화 없음", PRED_COLOR.absent],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      <span className="font-medium text-slate-500">예측</span>
      {items.map(([t, c]) => (
        <span key={t} className="inline-flex items-center gap-1.5">
          <i className="size-3 rounded-sm" style={{ background: c }} />
          {t}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <i className="size-3 rounded-sm border border-slate-300 bg-[repeating-linear-gradient(45deg,#e2e8f0_0_2px,#fff_2px_5px)]" />
        판단 불가
      </span>
    </div>
  );
}

export function TruthLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      <span className="font-medium text-slate-500">실제</span>
      {TRUTHS.map((t) => (
        <span key={t} className="inline-flex items-center gap-1.5">
          <i className="size-3 rounded-sm" style={{ background: TRUTH_COLOR[t] }} />
          {TRUTH_LABEL[t]}
        </span>
      ))}
    </div>
  );
}

export function useTruthMap(): Record<number, Truth> {
  const { state, truthEvents } = useLive();
  const map: Record<number, Truth> = {};
  for (const z of state?.zones ?? []) {
    const ev = currentTruth(truthEvents, z.id);
    if (ev) map[z.id] = ev.truth;
  }
  return map;
}

export default function LivePage() {
  const { state, building, history, truthEvents, now } = useLive();
  const navigate = useNavigate();
  const [minutes, setMinutes] = useState<number>(5);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [showLog, setShowLog] = useState(false);
  const truths = useTruthMap();

  const rxByZone = (id: number) => (state?.nodes ?? []).filter((n) => n.role === "rx" && n.zone_id === id);
  const plan = state ? planFromState(state) : null;

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <TopBar title="실시간 공간 현황" sub="구역별 상태와 변화를 한눈에 봐요" />
      <DetectionBar />

      {state ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {state.zones
              .slice()
              .sort((a, b) => a.id - b.id)
              .map((z) => (
                <SpaceCard key={z.id} zone={z} mode={state.mode} rx={rxByZone(z.id)} truth={truths[z.id] ?? null} />
              ))}
          </div>

          {plan ? (
            <Card>
              <CardHeader
                title="도면"
                sub={
                  state.mode === "person"
                    ? "구역 단위 표시예요. 사람이 구역 안 정확히 어디에 있는지, 몇 명인지는 알 수 없어요."
                    : "구역 단위 표시예요. 사람 판별 모델을 연결하기 전이라 사람 모양 대신 신호 변화만 보여 줘요."
                }
                right={<PredLegend />}
              />
              <div className="overflow-x-auto px-3 py-3">
                <div className="min-w-[640px]">
                  <PlanView background={planBackground(state.building)} zones={plan.zones} nodes={plan.nodes} mode={state.mode} truths={truths} />
                </div>
              </div>
              <p className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-500">
                {state.mode === "person"
                  ? "사람 모양 = 사람 있음(흐리고 ? = 가능성 있음). "
                  : "파형 동그라미 = 빈 방 기준선과 신호가 달라짐(사람인지는 판단 안 함). "}
                빨간 마름모 = 송신(TX-1), 점 = 수신기(초록 수신 중, 노랑 준비·보정 전, 빨강 끊김). 점선 상자 = 실험자가 입력한 실제 상태.
              </p>
            </Card>
          ) : null}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader
                title="상태 변화 기록"
                sub="이 화면이 받은 예측과 실험자가 입력한 실제 상태"
                right={
                  <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
                    {WINDOWS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMinutes(m)}
                        className={`rounded-md px-2.5 py-1 ${minutes === m ? "bg-white font-medium shadow-sm" : "text-slate-500"}`}
                      >
                        {m}분
                      </button>
                    ))}
                  </div>
                }
              />
              <div className="space-y-2 px-5 pt-3">
                <PredLegend />
                <TruthLegend />
              </div>
              <div className="px-5 py-4">
                <Timeline
                  zones={state.zones.slice().sort((a, b) => a.id - b.id)}
                  history={history}
                  truthEvents={truthEvents}
                  now={now}
                  minutes={minutes}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="실험 검증" right={<Button variant="ghost" onClick={() => navigate("/experiment")}>크게 보기</Button>} />
              <ExperimentPanel zoneId={zoneId} onZoneChange={setZoneId} />
            </Card>
          </div>
        </>
      ) : null}

      {!state && building ? (
        <Card>
          <CardHeader title="도면" sub="감지가 꺼져 있어 구역 배치와 수신기 신호 여부만 보여요." />
          <div className="overflow-x-auto px-3 py-3">
            <div className="min-w-[640px]">
              {(() => {
                const p = planFromBuilding(building, now);
                return <PlanView background={planBackground(building)} zones={p.zones} nodes={p.nodes} mode="person" />;
              })()}
            </div>
          </div>
        </Card>
      ) : null}

      <DeviceStrip action={<Button onClick={() => setShowLog((v) => !v)}>{showLog ? "상세 로그 닫기" : "상세 로그 보기"}</Button>} />
      {showLog ? (
        <Card>
          <CardHeader title="상세 로그" sub="서버가 남긴 감지·보정·노드 기록" />
          <LogPanel />
        </Card>
      ) : null}
    </div>
  );
}
