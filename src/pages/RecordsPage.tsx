import { Download, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import LogPanel from "../components/LogPanel";
import TopBar from "../components/TopBar";
import { Button, Card, CardHeader, Chip } from "../components/ui";
import { TRUTHS, TRUTH_LABEL } from "../lib/labels";
import { downloadText, recordsFileName, recordsToCsv } from "../lib/records";
import { OUTCOME_CHIP, OUTCOME_LABEL, type Outcome } from "../lib/scoring";
import { useLive } from "../state/live";

const OUTCOMES: Outcome[] = ["match", "false_alarm", "miss", "ambiguous", "unscored"];

export default function RecordsPage() {
  const { records, deleteRecord, clearRecords } = useLive();
  const [zone, setZone] = useState("전체");
  const [mode, setMode] = useState("전체");
  const [confirmClear, setConfirmClear] = useState(false);

  const zones = useMemo(() => ["전체", ...Array.from(new Set(records.map((r) => r.zone)))], [records]);
  const modes = useMemo(() => ["전체", ...Array.from(new Set(records.map((r) => r.dataMode)))], [records]);
  const rows = records.filter((r) => (zone === "전체" || r.zone === zone) && (mode === "전체" || r.dataMode === mode));

  const table = TRUTHS.map((t) => {
    const of = rows.filter((r) => r.truth === t);
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, of.filter((r) => r.outcome === o).length])) as Record<Outcome, number>;
    return { truth: t, total: of.length, counts, delayed: of.filter((r) => r.delayed).length };
  });

  return (
    <div className="space-y-5">
      <TopBar title="기록 보기" sub="저장한 실험 기록과 오류 종류를 모아 봐요" />

      <Card>
        <CardHeader
          title="실제 상태별 결과"
          sub="센 건수만 보여 줘요. 기록이 충분히 쌓이기 전에는 정확도 %를 내지 않아요."
          right={
            <>
              <select id="filter-zone" value={zone} onChange={(e) => setZone(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                {zones.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
              <select id="filter-mode" value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                {modes.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="px-5 py-2.5 font-medium">실제 상태</th>
                <th className="px-3 py-2.5 font-medium">기록</th>
                {OUTCOMES.map((o) => (
                  <th key={o} className="px-3 py-2.5 font-medium">
                    {OUTCOME_LABEL[o]}
                  </th>
                ))}
                <th className="px-3 py-2.5 font-medium">반응 지연</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular">
              {table.map((r) => (
                <tr key={r.truth}>
                  <td className="px-5 py-2.5 font-medium text-slate-800">{TRUTH_LABEL[r.truth]}</td>
                  <td className="px-3 py-2.5">{r.total}건</td>
                  {OUTCOMES.map((o) => (
                    <td key={o} className={`px-3 py-2.5 ${r.counts[o] && (o === "false_alarm" || o === "miss") ? "font-medium text-red-700" : ""}`}>
                      {r.counts[o]}
                    </td>
                  ))}
                  <td className={`px-3 py-2.5 ${r.delayed ? "font-medium text-red-700" : ""}`}>{r.delayed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-500">
          오탐 = 사람이 없는데 있다고 함 · 미탐 = 사람이 있는데 감지 안 됨 · 애매 = 가능성 있음 · 채점 제외 = 판단 불가. 자세 오분류는 자세 예측이 생기면 셉니다.
        </p>
      </Card>

      <Card>
        <CardHeader
          title={`실험 기록 ${rows.length}건`}
          sub="이 PC 브라우저에 저장돼요. CSV로 내려받아 팀 드라이브에 올려 주세요."
          right={
            <>
              <Button
                disabled={rows.length === 0}
                onClick={() => downloadText(recordsFileName(), recordsToCsv(rows))}
              >
                <Download size={15} /> CSV 내보내기
              </Button>
              {confirmClear ? (
                <>
                  <span className="text-sm text-red-700">기록 {records.length}건을 모두 지울까요? 되돌릴 수 없어요.</span>
                  <Button
                    variant="danger"
                    onClick={() => {
                      clearRecords();
                      setConfirmClear(false);
                    }}
                  >
                    모두 지우기
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmClear(false)}>
                    취소
                  </Button>
                </>
              ) : (
                <Button variant="danger" disabled={records.length === 0} onClick={() => setConfirmClear(true)}>
                  <Trash2 size={15} /> 전체 삭제
                </Button>
              )}
            </>
          }
        />
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">저장한 기록이 없어요. 실험 진행 6단계에서 실제 상태 버튼을 누르면 쌓여요.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  {["저장 시각", "공간", "실제 상태", "모델 예측", "비교", "반응 시간", "데이터", "수신 상태", "메모", ""].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-medium first:pl-5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-2.5 pl-5 pr-3 tabular text-slate-600">
                      {new Date(r.savedAt).toLocaleTimeString("ko-KR")}
                      <div className="text-xs text-slate-400">{r.how}</div>
                    </td>
                    <td className="px-3 py-2.5 font-medium">{r.zone}</td>
                    <td className="px-3 py-2.5">{TRUTH_LABEL[r.truth]}</td>
                    <td className="px-3 py-2.5">{r.prediction}</td>
                    <td className="px-3 py-2.5">
                      <Chip className={OUTCOME_CHIP[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</Chip>
                    </td>
                    <td className={`px-3 py-2.5 tabular ${r.delayed ? "font-medium text-red-700" : ""}`}>
                      {r.reactionSec !== null ? `${r.reactionSec.toFixed(1)}초` : r.outcome === "unscored" ? "—" : "맞지 않음"}
                      {r.delayed ? " · 지연" : ""}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">
                      {r.dataMode}
                      <div className="text-xs text-slate-400">{r.modelMode}</div>
                    </td>
                    <td className="max-w-56 px-3 py-2.5 text-xs text-slate-600">{r.reception || "—"}</td>
                    <td className="max-w-48 px-3 py-2.5 text-slate-600">{r.note}</td>
                    <td className="px-3 py-2.5">
                      <button type="button" aria-label="이 기록 지우기" onClick={() => deleteRecord(r.id)} className="text-slate-400 hover:text-red-600">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="상세 로그" sub="지금 감지 중인 상황에서 서버가 남긴 기록" />
        <LogPanel />
      </Card>
    </div>
  );
}
