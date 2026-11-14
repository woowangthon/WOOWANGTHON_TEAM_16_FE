import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { IncidentState, ModelMode, ZoneStateCode } from "../api/types";
import { CORRIDORS, PLAN_ROOMS, SITE_FLOOR_LABEL, VIEW, VIEW_H, VIEW_W } from "../lib/layout";
import { PRED_COLOR, TRUTH_COLOR, TRUTH_LABEL, predLabel, type PredClass, type PredLabel, type Tone, type Truth } from "../lib/labels";

export interface PlanZone {
  id: number;
  name: string;
  polygon: number[][];
  state: ZoneStateCode | null;
}

export interface PlanNode {
  name: string;
  role: "tx" | "rx";
  x: number;
  y: number;
  tone: Tone;
}

type Background = { type: "site" } | { type: "image"; buildingId: number; width: number; height: number } | { type: "none" };

const TONE_FILL: Record<Tone, string> = { ok: "#10b981", warn: "#f59e0b", bad: "#ef4444", idle: "#94a3b8" };

export function planBackground(b: { id: number; floor_label: string; has_plan: boolean; plan_width: number | null; plan_height: number | null }): Background {
  if (b.floor_label === SITE_FLOOR_LABEL) return { type: "site" };
  if (b.has_plan && b.plan_width && b.plan_height) return { type: "image", buildingId: b.id, width: b.plan_width, height: b.plan_height };
  return { type: "none" };
}

export function planFromState(state: IncidentState): { zones: PlanZone[]; nodes: PlanNode[] } {
  return {
    zones: state.zones.map((z) => ({ id: z.id, name: z.name, polygon: z.polygon, state: z.state })),
    nodes: state.nodes.map((n) => ({
      name: n.name,
      role: n.role,
      x: n.x,
      y: n.y,
      tone: n.role === "tx" || state.summary.frozen ? "idle" : n.status === "ok" ? "ok" : n.status === "stale" ? "bad" : "warn",
    })),
  };
}

// 감지가 꺼져 있을 때: 구역 배치와 노드 신호 여부만 보여 준다
export function planFromBuilding(
  b: { zones: { id: number; name: string; polygon: number[][] }[]; nodes: { name: string; role: "tx" | "rx"; x: number; y: number; last_seen_at: string | null }[] },
  now: number,
): { zones: PlanZone[]; nodes: PlanNode[] } {
  return {
    zones: b.zones.map((z) => ({ id: z.id, name: z.name, polygon: z.polygon, state: null })),
    nodes: b.nodes.map((n) => {
      const seen = n.last_seen_at ? (now - Date.parse(n.last_seen_at)) / 1000 <= 6 : false;
      return { name: n.name, role: n.role, x: n.x, y: n.y, tone: n.role === "tx" ? "idle" : seen ? "ok" : "idle" };
    }),
  };
}

// ---- 글자·표시 배치 -------------------------------------------------------
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

// 글자 폭 어림값(한글 1em, 공백 0.3em, 나머지 0.6em)
function textW(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += HANGUL.test(ch) ? 1 : ch === " " ? 0.3 : 0.6;
  return w * size;
}

interface ZoneLayout {
  zone: PlanZone;
  pts: string;
  label: PredLabel | null;
  cls: PredClass;
  name: Box;
  pred: Box | null;
  truth: (Box & { truth: Truth; text: string }) | null;
  glyph: { x: number; y: number; s: number } | null;
}

interface Metrics {
  u: number;
  nameSize: number;
  tagSize: number;
  rowH: number;
  gap: number;
}

function nodeBox(x: number, y: number, n: PlanNode, m: Metrics): Box {
  const lw = Math.max(m.u * 0.8, textW(n.name, m.u * 0.5)) + m.u * 0.2;
  // 수신기는 점 아래, 송신기는 마름모 위에 이름을 쓴다
  return n.role === "tx" ? { x: x - lw / 2, y: y - m.u * 1.3, w: lw, h: m.u * 1.75 } : { x: x - lw / 2, y: y - m.u * 0.45, w: lw, h: m.u * 1.7 };
}

function layoutZones(
  zones: PlanZone[],
  nodeBoxes: Box[],
  obstacles: Box[],
  mode: ModelMode,
  truths: Record<number, Truth> | undefined,
  W: number,
  H: number,
  px: (n: number) => number,
  py: (n: number) => number,
  m: Metrics,
): ZoneLayout[] {
  const { u, nameSize, tagSize, rowH, gap } = m;
  const bboxes: Box[] = zones.map((z) => {
    const xs = z.polygon.map((p) => px(p[0]));
    const ys = z.polygon.map((p) => py(p[1]));
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
  });
  const outsideTaken: Box[] = [];

  return zones.map((z, i) => {
    const b = bboxes[i];
    const label = z.state ? predLabel(z.state, mode) : null;
    const cls: PredClass = label?.cls ?? "unknown";
    const needGlyph = cls === "present" || cls === "maybe";
    const pad = Math.min(u * 0.3, b.w * 0.06, b.h * 0.1);
    const right = b.x + b.w - pad;
    const bottom = b.y + b.h - pad;

    // 구역 왼쪽 위부터 글자를 한 줄로 흘려 놓고, 넘치면 다음 줄로
    let cx = b.x + pad;
    let ry = b.y + pad;
    const flow = (w: number): Box => {
      if (cx > b.x + pad + 1e-6 && cx + w > right) {
        cx = b.x + pad;
        ry += rowH + gap * 0.7;
      }
      const at = { x: cx, y: ry, w, h: rowH };
      cx += w + gap;
      return at;
    };

    const name = flow(textW(z.name, nameSize));
    const pred = label ? flow(textW(label.text, tagSize) + u * 0.7) : null;

    let truthBox: ZoneLayout["truth"] = null;
    const truth = truths?.[z.id];
    if (truth) {
      const text = `실제 ${TRUTH_LABEL[truth]}`;
      const w = textW(text, tagSize) + u * 0.7;
      const saved = { cx, ry };
      const inside = flow(w);
      const bodyLeft = bottom - (inside.y + rowH + gap);
      const fits =
        inside.x + w <= right + 1e-6 &&
        inside.y + rowH <= bottom &&
        (!needGlyph || bodyLeft >= u * 0.9) &&
        !nodeBoxes.some((n) => overlaps(n, inside));
      if (fits) {
        truthBox = { ...inside, truth, text };
      } else {
        // 구역 안에 자리가 없으면 바로 옆에 붙인다. 다른 방 위보다 복도·건물 바깥 같은 빈 곳을 먼저 고른다.
        cx = saved.cx;
        ry = saved.ry;
        const midY = b.y + b.h / 2 - rowH / 2;
        const options: Box[] = [
          { x: b.x - u * 0.3 - w, y: midY, w, h: rowH },
          { x: b.x + b.w + u * 0.3, y: midY, w, h: rowH },
          { x: b.x, y: b.y + b.h + u * 0.25, w, h: rowH },
          { x: b.x, y: b.y - u * 0.25 - rowH, w, h: rowH },
        ];
        // 맞닿은 벽(좌표 반올림 오차)은 겹침으로 보지 않는다
        const eps = u * 0.05;
        const solid = (bx: Box): Box => ({ x: bx.x + eps, y: bx.y + eps, w: bx.w - 2 * eps, h: bx.h - 2 * eps });
        const valid = options.filter(
          (o) =>
            o.x >= 0 &&
            o.y >= 0 &&
            o.x + o.w <= W &&
            o.y + o.h <= H &&
            !bboxes.some((bb, j) => j !== i && overlaps(solid(bb), o)) &&
            !nodeBoxes.some((n) => overlaps(n, o)) &&
            !outsideTaken.some((t) => overlaps(t, o)),
        );
        const free = valid.find((o) => !obstacles.some((ob) => overlaps(solid(ob), o))) ?? valid[0];
        if (free) outsideTaken.push(free);
        truthBox = { ...(free ?? inside), truth, text };
      }
    }

    let glyph: ZoneLayout["glyph"] = null;
    if (needGlyph) {
      const top = ry + rowH + gap;
      const bh = Math.max(0, bottom - top);
      const s = Math.min(u * 1.4, Math.max(u * 0.55, bh / 1.55));
      const gy = top + bh / 2 + s * 0.1;
      const extra = cls === "maybe" ? u * 0.7 : 0;
      const boxAt = (gx: number): Box => ({ x: gx - s * 0.5 - u * 0.1, y: gy - s * 0.85, w: s + extra + u * 0.2, h: s * 1.5 });
      let gx = b.x + b.w / 2;
      // 수신기 점·이름과 겹치지 않는 자리를 고른다
      for (const f of [0.5, 0.66, 0.34, 0.82, 0.18]) {
        const x = b.x + b.w * f;
        const box = boxAt(x);
        if (box.x < b.x || box.x + box.w > b.x + b.w) continue;
        if (nodeBoxes.some((n) => overlaps(n, box)) || (truthBox && overlaps(truthBox, box))) continue;
        gx = x;
        break;
      }
      glyph = { x: gx, y: gy, s };
    }

    return {
      zone: z,
      pts: z.polygon.map(([nx, ny]) => `${px(nx)},${py(ny)}`).join(" "),
      label,
      cls,
      name,
      pred,
      truth: truthBox,
      glyph,
    };
  });
}

function PersonGlyph({ x, y, s, color, faded }: { x: number; y: number; s: number; color: string; faded?: boolean }) {
  return (
    <g opacity={faded ? 0.7 : 1}>
      <circle cx={x} cy={y - s * 0.55} r={s * 0.28} fill={color} />
      <path
        d={`M ${x - s * 0.42} ${y + s * 0.62} Q ${x - s * 0.42} ${y - s * 0.18} ${x} ${y - s * 0.18} Q ${x + s * 0.42} ${y - s * 0.18} ${x + s * 0.42} ${y + s * 0.62} Z`}
        fill={color}
      />
    </g>
  );
}

// 1단계(모델 없음)용: 빈 방 기준선과 신호가 달라졌다는 표시. 사람 모양을 쓰지 않는다.
function ChangeGlyph({ x, y, s, color, faded }: { x: number; y: number; s: number; color: string; faded?: boolean }) {
  const cy = y - s * 0.1;
  const pts = [
    [x - s * 0.42, cy],
    [x - s * 0.2, cy],
    [x - s * 0.08, cy - s * 0.32],
    [x + s * 0.08, cy + s * 0.32],
    [x + s * 0.2, cy],
    [x + s * 0.42, cy],
  ]
    .map((p) => p.join(","))
    .join(" ");
  return (
    <g opacity={faded ? 0.75 : 1}>
      <circle cx={x} cy={cy} r={s * 0.62} fill="#ffffff" stroke={color} strokeWidth={s * 0.08} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={s * 0.1} strokeLinejoin="round" strokeLinecap="round" />
    </g>
  );
}

export default function PlanView({
  background,
  zones,
  nodes,
  mode,
  truths,
  fit = false,
}: {
  background: Background;
  zones: PlanZone[];
  nodes: PlanNode[];
  mode: ModelMode;
  truths?: Record<number, Truth>;
  // 구역과 장치가 있는 부분만 크게 보여 준다(도면 전체에서 구역이 작게 보일 때)
  fit?: boolean;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const imageBuilding = background.type === "image" ? background.buildingId : null;

  useEffect(() => {
    if (imageBuilding === null) return;
    let url: string | null = null;
    let alive = true;
    api
      .planImage(imageBuilding)
      .then((u) => {
        url = u;
        if (alive) setImageUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => setImageUrl(null));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
      setImageUrl(null);
    };
  }, [imageBuilding]);

  const W = background.type === "site" ? VIEW_W : background.type === "image" ? background.width : 100;
  const H = background.type === "site" ? VIEW_H : background.type === "image" ? background.height : 56;
  const u = W / 36; // 대략 1m에 해당하는 그림 단위
  const px = (nx: number) => nx * W;
  const py = (ny: number) => ny * H;
  const m: Metrics = { u, nameSize: u * 0.68, tagSize: u * 0.48, rowH: u * 0.82, gap: u * 0.22 };

  const nodePts = nodes.map((n) => ({ n, x: px(n.x), y: py(n.y) }));
  const nodeBoxes = nodePts.map(({ n, x, y }) => nodeBox(x, y, n, m));
  const obstacles: Box[] =
    background.type === "site" ? PLAN_ROOMS.map((r) => ({ x: r.x0 - VIEW.xmin, y: VIEW.ymax - r.y1, w: r.x1 - r.x0, h: r.y1 - r.y0 })) : [];
  const layouts = layoutZones(zones, nodeBoxes, obstacles, mode, truths, W, H, px, py, m);
  const zoneNames = zones.map((z) => z.name);

  // 보여 줄 범위. fit이면 구역·장치를 둘러싼 상자에 여백을 두고, 너무 길쭉하지 않게 가로를 넓힌다.
  let view = { x: 0, y: 0, w: W, h: H };
  if (fit && zones.length) {
    const xs = [...zones.flatMap((z) => z.polygon.map((p) => px(p[0]))), ...nodePts.map((n) => n.x)];
    const ys = [...zones.flatMap((z) => z.polygon.map((p) => py(p[1]))), ...nodePts.map((n) => n.y)];
    const pad = u * 1.6;
    let x0 = Math.min(...xs) - pad;
    let x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad;
    const y1 = Math.max(...ys) + pad;
    const minW = (y1 - y0) / 0.9;
    if (x1 - x0 < minW) {
      const c = (x0 + x1) / 2;
      x0 = c - minW / 2;
      x1 = c + minW / 2;
    }
    view = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  return (
    <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} className="block h-auto w-full" role="img" aria-label="평면도 위 구역별 상태">
      <defs>
        <pattern id="plan-hatch" width={u * 0.5} height={u * 0.5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={u * 0.5} stroke="#94a3b8" strokeWidth={u * 0.08} />
        </pattern>
      </defs>
      <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="#ffffff" />

      {background.type === "site" ? (
        <g>
          {CORRIDORS.map((c, i) => (
            <rect key={i} x={c.x0 - VIEW.xmin} y={VIEW.ymax - c.y1} width={c.x1 - c.x0} height={c.y1 - c.y0} fill="#f8fafc" />
          ))}
          {PLAN_ROOMS.map((r) => {
            const x0 = Math.max(r.x0, VIEW.xmin);
            const x1 = Math.min(r.x1, VIEW.xmax);
            // 실험 구역과 겹치는 방 번호는 구역 이름으로 대신한다
            const showName = x1 - x0 > 0.6 && !zoneNames.some((n) => n.startsWith(r.name));
            return (
              <g key={`${r.name}-${r.x0}`}>
                <rect
                  x={r.x0 - VIEW.xmin}
                  y={VIEW.ymax - r.y1}
                  width={r.x1 - r.x0}
                  height={r.y1 - r.y0}
                  fill={r.kind === "stairs" ? "#e3efe7" : "#eef1f4"}
                  stroke="#475569"
                  strokeWidth={0.07}
                />
                {showName ? (
                  <text
                    x={(x0 + x1) / 2 - VIEW.xmin}
                    y={VIEW.ymax - (r.y0 + r.y1) / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={r.name.length > 3 ? 0.62 : 0.8}
                    fill="#64748b"
                  >
                    {r.name}
                  </text>
                ) : null}
              </g>
            );
          })}
          <text x={0.6} y={VIEW.ymax - 5.97} dominantBaseline="central" fontSize={0.7} fill="#94a3b8">
            복도
          </text>
        </g>
      ) : background.type === "image" && imageUrl ? (
        <image href={imageUrl} x="0" y="0" width={W} height={H} preserveAspectRatio="none" />
      ) : null}

      {/* 구역 바탕 */}
      {layouts.map(({ zone, pts, cls }) => {
        const color = PRED_COLOR[cls];
        const strong = cls === "present" || cls === "maybe";
        return (
          <polygon
            key={zone.id}
            points={pts}
            fill={cls === "unknown" ? "url(#plan-hatch)" : color}
            fillOpacity={cls === "unknown" ? 0.6 : strong ? 0.28 : 0.12}
            stroke={strong ? color : "#64748b"}
            strokeWidth={strong ? u * 0.14 : u * 0.07}
            strokeDasharray={cls === "unknown" ? `${u * 0.3} ${u * 0.2}` : undefined}
          />
        );
      })}

      {/* 구역 이름·예측·실제 상태·사람 표시 */}
      {layouts.map(({ zone, label, cls, name, pred, truth, glyph }) => {
        const color = PRED_COLOR[cls];
        return (
          <g key={zone.id}>
            <text x={name.x} y={name.y + m.rowH / 2} dominantBaseline="central" fontSize={m.nameSize} fontWeight={700} fill="#0f172a">
              {zone.name}
            </text>
            {label && pred ? (
              <g>
                <rect
                  x={pred.x}
                  y={pred.y}
                  width={pred.w}
                  height={m.rowH}
                  rx={m.rowH / 2}
                  fill="#ffffff"
                  stroke={cls === "absent" || cls === "unknown" ? "#cbd5e1" : color}
                  strokeWidth={u * 0.06}
                />
                <text
                  x={pred.x + pred.w / 2}
                  y={pred.y + m.rowH / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={m.tagSize}
                  fontWeight={500}
                  fill={cls === "present" ? "#b91c1c" : cls === "maybe" ? "#92400e" : "#475569"}
                >
                  {label.text}
                </text>
              </g>
            ) : null}
            {glyph && mode === "change" ? <ChangeGlyph x={glyph.x} y={glyph.y} s={glyph.s} color={color} faded={cls === "maybe"} /> : null}
            {glyph && mode === "person" && cls === "present" ? <PersonGlyph x={glyph.x} y={glyph.y} s={glyph.s} color={color} /> : null}
            {glyph && mode === "person" && cls === "maybe" ? (
              <g>
                <PersonGlyph x={glyph.x} y={glyph.y} s={glyph.s} color={color} faded />
                <text x={glyph.x + glyph.s * 0.5} y={glyph.y - glyph.s * 0.45} fontSize={u * 0.8} fontWeight={700} fill="#92400e">
                  ?
                </text>
              </g>
            ) : null}
            {truth ? (
              <g>
                <rect
                  x={truth.x}
                  y={truth.y}
                  width={truth.w}
                  height={m.rowH}
                  rx={m.rowH / 2}
                  fill="#ffffff"
                  stroke={TRUTH_COLOR[truth.truth]}
                  strokeWidth={u * 0.07}
                  strokeDasharray={`${u * 0.18} ${u * 0.12}`}
                />
                <text
                  x={truth.x + truth.w / 2}
                  y={truth.y + m.rowH / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={m.tagSize}
                  fill={TRUTH_COLOR[truth.truth]}
                  fontWeight={500}
                >
                  {truth.text}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      {/* 장치 */}
      {nodePts.map(({ n, x, y }) => (
        <g key={n.name}>
          {n.role === "tx" ? (
            <rect
              x={x - u * 0.32}
              y={y - u * 0.32}
              width={u * 0.64}
              height={u * 0.64}
              transform={`rotate(45 ${x} ${y})`}
              fill="#c8281c"
              stroke="#ffffff"
              strokeWidth={u * 0.08}
            />
          ) : (
            <circle cx={x} cy={y} r={u * 0.34} fill={TONE_FILL[n.tone]} stroke="#ffffff" strokeWidth={u * 0.1} />
          )}
          <text
            x={x}
            y={n.role === "tx" ? y - u * 0.85 : y + u * 0.95}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={u * 0.5}
            fontWeight={700}
            fill={n.role === "tx" ? "#c8281c" : "#1e293b"}
            stroke="#ffffff"
            strokeWidth={u * 0.14}
            paintOrder="stroke"
          >
            {n.name}
          </text>
        </g>
      ))}
    </svg>
  );
}
