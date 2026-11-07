import { useEffect, useRef, useState } from "react";
import type { PredHistory, TruthEvent } from "../lib/history";
import { PRED_COLOR, TRUTH_COLOR, TRUTH_LABEL } from "../lib/labels";
import { clock } from "../lib/time";

// 실제 화면 폭에 맞춰 그려 글자 크기가 줄어들지 않게 한다(단위: CSS px)
const LEFT = 92;
const RIGHT = 10;
const LANE = 16;
const LANE_GAP = 5;
const ROW = LANE * 2 + LANE_GAP + 20;
const AXIS = 26;

export const WINDOWS = [5, 15, 60] as const;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function Timeline({
  zones,
  history,
  truthEvents,
  now,
  minutes,
}: {
  zones: { id: number; name: string }[];
  history: PredHistory;
  truthEvents: TruthEvent[];
  now: number;
  minutes: number;
}) {
  const [ref, measured] = useWidth();
  const width = Math.max(measured, 320);
  const span = minutes * 60_000;
  const t0 = now - span;
  const plotW = width - LEFT - RIGHT;
  const x = (t: number) => LEFT + ((Math.max(t, t0) - t0) / span) * plotW;
  const height = zones.length * ROW + AXIS;
  // 눈금 글자가 겹치지 않게 간격을 고른다
  const maxTicks = Math.max(2, Math.floor(plotW / 64));
  const stepMin = [1, 2, 3, 5, 10, 15, 30].find((s) => minutes / s <= maxTicks) ?? 30;
  const ticks: number[] = [];
  const first = Math.ceil(t0 / (stepMin * 60_000)) * stepMin * 60_000;
  for (let t = first; t <= now; t += stepMin * 60_000) ticks.push(t);

  return (
    <div ref={ref} className="w-full">
      {measured > 0 ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img" aria-label="구역별 예측과 실제 상태 변화">
          <defs>
            <pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#f1f5f9" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#cbd5e1" strokeWidth="2" />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} y1={4} x2={x(t)} y2={height - AXIS + 4} stroke="#e8edf3" />
              <text
                x={x(t)}
                y={height - 8}
                textAnchor={x(t) > width - RIGHT - 18 ? "end" : x(t) < LEFT + 18 ? "start" : "middle"}
                fontSize="12"
                fill="#64748b"
                className="tabular"
              >
                {clock(t, false)}
              </text>
            </g>
          ))}
          {zones.map((z, i) => {
            const top = 18 + i * ROW;
            const truthTop = top + LANE + LANE_GAP;
            const segs = (history[String(z.id)] ?? []).filter((s) => s.to + 2000 >= t0);
            const evs = truthEvents.filter((e) => e.zoneId === z.id);
            return (
              <g key={z.id}>
                <text x={0} y={top - 6} fontSize="13" fontWeight={700} fill="#0f172a">
                  {z.name}
                </text>
                <text x={LEFT - 8} y={top + LANE / 2} textAnchor="end" dominantBaseline="central" fontSize="12" fill="#64748b">
                  예측
                </text>
                <text x={LEFT - 8} y={truthTop + LANE / 2} textAnchor="end" dominantBaseline="central" fontSize="12" fill="#64748b">
                  실제
                </text>
                <rect x={LEFT} y={top} width={plotW} height={LANE} rx={3} fill="#f8fafc" />
                <rect x={LEFT} y={truthTop} width={plotW} height={LANE} rx={3} fill="#f8fafc" />
                {segs.map((s, k) => {
                  const a = x(s.from);
                  const b = x(Math.min(s.to + 2000, now));
                  return (
                    <rect
                      key={k}
                      x={a}
                      y={top}
                      width={Math.max(b - a, 1.5)}
                      height={LANE}
                      fill={s.cls === "unknown" ? "url(#tl-hatch)" : PRED_COLOR[s.cls]}
                    />
                  );
                })}
                {evs.map((e, k) => {
                  const end = k + 1 < evs.length ? evs[k + 1].at : now;
                  if (end < t0) return null;
                  const a = x(e.at);
                  const b = x(end);
                  return (
                    <g key={k}>
                      <rect x={a} y={truthTop} width={Math.max(b - a, 1.5)} height={LANE} fill={TRUTH_COLOR[e.truth]} opacity={0.85} />
                      {b - a > 64 ? (
                        <text x={a + 6} y={truthTop + LANE / 2} dominantBaseline="central" fontSize="11" fill="#ffffff" fontWeight={500}>
                          {TRUTH_LABEL[e.truth]}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}
