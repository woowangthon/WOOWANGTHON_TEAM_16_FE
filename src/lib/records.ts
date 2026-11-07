import type { Truth } from "./labels";
import { TRUTH_LABEL } from "./labels";
import type { Outcome } from "./scoring";
import { OUTCOME_LABEL } from "./scoring";
import { clock } from "./time";

export type DataModeLabel = "실시간" | "기록 재생" | "UI 예시";

// 실험 기록 한 줄. 기획서 6장 "실험 기록" 항목에 맞춘다.
export interface ExperimentRecord {
  id: string;
  savedAt: number;
  how: "수동" | "자동";
  incidentId: number | null;
  building: string;
  zone: string;
  receivers: string;
  truth: Truth;
  truthSince: number;
  prediction: string;
  predState: string;
  p: number | null;
  outcome: Outcome;
  reactionSec: number | null;
  delayed: boolean;
  dataMode: DataModeLabel;
  modelMode: string;
  reception: string;
  note: string;
  protocol?: string; // 실험 방식 이름(lib/protocol.ts PROTOCOL_ID). 11/7 첫 시험 기록에는 없다
}

const HEADERS = [
  "저장 시각", "저장 방식", "상황 번호", "건물", "공간", "수신기", "실제 상태", "실제 상태 시작",
  "모델 예측", "예측 코드", "모델 출력값", "비교 결과", "반응 시간(초)", "반응 지연", "데이터 모드", "모델", "수신 상태", "메모", "실험 방식",
];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function recordsToCsv(rows: ExperimentRecord[]): string {
  const lines = rows.map((r) =>
    [
      new Date(r.savedAt).toLocaleString("ko-KR"),
      r.how,
      r.incidentId ?? "",
      r.building,
      r.zone,
      r.receivers,
      TRUTH_LABEL[r.truth],
      clock(r.truthSince),
      r.prediction,
      r.predState,
      r.p ?? "",
      OUTCOME_LABEL[r.outcome],
      r.reactionSec === null ? "" : r.reactionSec.toFixed(1),
      r.delayed ? "예" : "",
      r.dataMode,
      r.modelMode,
      r.reception,
      r.note,
      r.protocol ?? "첫 시험(방식 정하기 전)",
    ].map(cell).join(","),
  );
  // 엑셀에서 한글이 깨지지 않게 BOM을 붙인다
  return "﻿" + [HEADERS.join(","), ...lines].join("\r\n");
}

export function recordsFileName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `watchmate_실험기록_${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}.csv`;
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
