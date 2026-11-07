import { useState } from "react";
import { useNavigate } from "react-router-dom";
import DetectionBar from "../components/DetectionBar";
import ExperimentPanel from "../components/ExperimentPanel";
import PlanView, { planBackground, planFromState } from "../components/PlanView";
import Timeline from "../components/Timeline";
import TopBar from "../components/TopBar";
import { Button, Card, CardHeader, Chip } from "../components/ui";
import { TRUTH_LABEL } from "../lib/labels";
import { OUTCOME_CHIP, OUTCOME_LABEL } from "../lib/scoring";
import { clock } from "../lib/time";
import { useLive } from "../state/live";
import { PredLegend, TruthLegend, useTruthMap } from "./LivePage";

const STEPS = [
  "모두 방 밖으로 나가 '비어 있음'을 누르고 30초 기다려요.",
  "한 명이 들어가 의자에 앉은 순간 '앉아 있음'을 눌러요. 움직이지 말고 숨만 쉬어요.",
  "예측이 '사람 있음'으로 바뀌는지, 앉아 있는 동안 유지되는지 봐요.",
  "일어나 나가는 순간 '비어 있음'을 눌러요. 다시 '감지 안 됨'으로 돌아오는지 봐요.",
  "같은 순서를 10번 반복해요. 자동 저장을 켜 두면 바꿀 때마다 한 줄씩 남아요.",
];

export default function ExperimentPage() {
  const { state, history, truthEvents, now, records } = useLive();
  const navigate = useNavigate();
  const [zoneId, setZoneId] = useState<number | null>(null);
  const truths = useTruthMap();
  const plan = state ? planFromState(state) : null;
  const recent = records.slice(0, 8);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <TopBar title="실험 검증" sub="실제 상태를 입력하고 모델 예측과 비교해요" />
      <DetectionBar />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="실제 상태 입력과 비교" />
            <ExperimentPanel zoneId={zoneId} onZoneChange={setZoneId} full />
          </Card>
          <Card>
            <CardHeader title="1순위 실험: 빈 방과 가만히 앉은 사람 구분" sub="움직일 때만 반응하는지, 앉은 뒤에도 사람이 있는 상태를 유지하는지 확인해요." />
            <ol className="list-decimal space-y-2 px-10 py-4 text-sm text-slate-700">
              {STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
              자세(서기·앉기·눕기) 구분은 3순위예요. 지금 모델은 사람이 있는지만 판단하므로 자세는 기록만 하고 채점하지 않아요.
            </p>
          </Card>
        </div>

        <div className="space-y-5">
          {state && plan ? (
            <Card>
              <CardHeader title="도면" right={<PredLegend />} />
              <div className="overflow-x-auto px-3 py-3">
                <div className="min-w-[480px]">
                  <PlanView background={planBackground(state.building)} zones={plan.zones} nodes={plan.nodes} mode={state.mode} truths={truths} />
                </div>
              </div>
            </Card>
          ) : null}
          {state ? (
            <Card>
              <CardHeader title="최근 5분 변화" right={<TruthLegend />} />
              <div className="px-5 py-4">
                <Timeline zones={state.zones.slice().sort((a, b) => a.id - b.id)} history={history} truthEvents={truthEvents} now={now} minutes={5} />
              </div>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="최근 기록" right={<Button variant="ghost" onClick={() => navigate("/records")}>기록 보기</Button>} />
            {recent.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">아직 저장한 기록이 없어요.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recent.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
                    <span className="w-16 text-slate-500 tabular">{clock(r.savedAt)}</span>
                    <span className="w-14 font-medium">{r.zone}</span>
                    <span className="text-slate-600">
                      실제 {TRUTH_LABEL[r.truth]} · 예측 {r.prediction}
                    </span>
                    <Chip className={`ml-auto ${OUTCOME_CHIP[r.outcome]}`}>{OUTCOME_LABEL[r.outcome]}</Chip>
                    {r.delayed ? <Chip className="bg-red-50 text-red-700 ring-red-200">반응 지연</Chip> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
