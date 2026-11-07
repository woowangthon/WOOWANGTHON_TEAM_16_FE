import { CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { currentTruth, firstMatchAt } from "../lib/history";
import { PRED_CHIP, TRUTHS, TRUTH_LABEL, predLabel } from "../lib/labels";
import { trialPhase } from "../lib/protocol";
import { OUTCOME_CHIP, OUTCOME_LABEL, compare } from "../lib/scoring";
import { duration } from "../lib/time";
import { useLive } from "../state/live";
import { Button, Chip } from "./ui";

export default function ExperimentPanel({
  zoneId,
  onZoneChange,
  full = false,
}: {
  zoneId: number | null;
  onZoneChange: (id: number) => void;
  full?: boolean;
}) {
  const { state, truthEvents, setTruth, saveRecord, history, now, delayLimit, dataMode, autoSave, setAutoSave, setDelayLimit } = useLive();
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(null), 2500);
    return () => window.clearTimeout(id);
  }, [saved]);

  // 카드·시간 막대와 같은 순서(구역 번호 순)로 보여 준다
  const zones = (state?.zones ?? []).slice().sort((a, b) => a.id - b.id);
  const zone = zones.find((z) => z.id === zoneId) ?? zones[0] ?? null;
  const frozen = state?.summary.frozen ?? false;
  const usable = !!state && !!zone && !frozen;

  if (!usable || !zone || !state) {
    return (
      <div className="px-5 py-6 text-sm text-slate-500">
        {frozen
          ? "끝난 감지(또는 다 재생된 녹화)는 실험 기록을 더 받지 않아요."
          : "5단계에서 감지를 켜면 실제 상태를 입력하고 예측과 비교할 수 있어요."}
      </div>
    );
  }

  const label = predLabel(zone.state, state.mode);
  const truthEv = currentTruth(truthEvents, zone.id);
  const outcome = truthEv ? compare(truthEv.truth, label.cls) : null;
  const matched = truthEv ? firstMatchAt(history[String(zone.id)], truthEv.truth, truthEv.at) : null;
  const elapsed = truthEv ? (now - truthEv.at) / 1000 : 0;
  const reaction = truthEv && matched !== null ? (matched - truthEv.at) / 1000 : null;

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
        <span className="text-sm text-slate-500">대상 공간</span>
        {zones.map((z) => (
          <button
            key={z.id}
            type="button"
            onClick={() => onZoneChange(z.id)}
            className={`rounded-lg px-3 py-1 text-[15px] font-bold ${
              z.id === zone.id ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {z.name}
          </button>
        ))}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">실제 상태 입력</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TRUTHS.map((t) => {
            const on = truthEv?.truth === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTruth(zone.id, t)}
                className={`rounded-lg px-3 py-2.5 text-[15px] font-medium ring-1 ring-inset transition-colors ${
                  on ? "bg-brand text-white ring-brand" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
                }`}
              >
                {TRUTH_LABEL[t]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-slate-100 pt-4">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-[15px]">
          <dt className="text-slate-500">실제 상태</dt>
          <dd>
            {truthEv ? (
              <Chip className="bg-blue-50 px-3 py-1 text-[15px] text-blue-700 ring-blue-200">{TRUTH_LABEL[truthEv.truth]}</Chip>
            ) : (
              <span className="text-sm text-slate-400">아직 입력 안 함</span>
            )}
          </dd>
          <dt className="text-slate-500">모델 예측</dt>
          <dd>
            <Chip className={`px-3 py-1 text-[15px] ${PRED_CHIP[label.cls]}`}>{label.text}</Chip>
          </dd>
        </dl>
        <div className="flex min-w-28 flex-col items-center justify-center rounded-xl bg-slate-50 px-4 py-3 text-center">
          {outcome ? (
            <>
              {outcome === "match" ? <CircleCheck className="mb-1 size-6 text-emerald-600" /> : null}
              <Chip className={`px-3 py-1 text-[15px] font-bold ${OUTCOME_CHIP[outcome]}`}>{OUTCOME_LABEL[outcome]}</Chip>
            </>
          ) : (
            <span className="text-sm text-slate-400">비교 전</span>
          )}
        </div>
      </div>

      {truthEv ? (
        <div className="flex flex-wrap items-center gap-2">
          <Chip className={`px-3 py-1 text-sm ${trialPhase(elapsed).cls}`}>{trialPhase(elapsed).text}</Chip>
        </div>
      ) : null}

      {truthEv ? (
        <p className="text-sm text-slate-600 tabular">
          실제 상태를 바꾼 지 {duration(elapsed)} ·{" "}
          {reaction !== null ? (
            <>
              예측이 맞기까지 <b className={reaction > delayLimit ? "text-red-700" : "text-slate-900"}>{reaction.toFixed(1)}초</b>
            </>
          ) : outcome === "unscored" ? (
            <span className="text-slate-500">지금은 판단 불가라 반응 시간을 재지 않아요</span>
          ) : (
            <span className={elapsed > delayLimit ? "font-medium text-red-700" : ""}>예측이 아직 맞지 않음</span>
          )}
        </p>
      ) : null}

      {full ? (
        <div className="grid gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
          <label className="flex items-center gap-2 text-slate-700">
            <input
              id="auto-save"
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
              className="size-4 accent-blue-700"
            />
            실제 상태를 바꿀 때 이전 시험을 자동 저장
          </label>
          <label className="flex items-center gap-2 text-slate-700">
            반응 지연 기준
            <input
              id="delay-limit"
              type="number"
              min={5}
              max={300}
              value={delayLimit}
              onChange={(e) => setDelayLimit(Number(e.target.value))}
              className="w-16 rounded-md border border-slate-300 px-2 py-1 text-right tabular"
            />
            초
          </label>
          <input
            id="record-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="메모(예: 문 닫힘, 의자 위치 A)"
            className="rounded-lg border border-slate-300 px-3 py-2 sm:col-span-2"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-xs text-slate-500">
          실제 상태는 채점에만 써요. 예측 계산에는 들어가지 않아요.
          {dataMode === "mock" ? " 지금은 UI 예시(가상 데이터)라 기록에도 그렇게 남아요." : ""}
        </p>
        <Button
          variant="primary"
          disabled={!truthEv}
          onClick={() => {
            const rec = saveRecord(zone.id, note.trim());
            if (rec) {
              setSaved(`${rec.zone} · ${OUTCOME_LABEL[rec.outcome]} 기록을 저장했어요`);
              setNote("");
            }
          }}
        >
          실험 기록 저장
        </Button>
      </div>
      {saved ? <p className="-mt-2 text-right text-sm font-medium text-emerald-700">{saved}</p> : null}
    </div>
  );
}
