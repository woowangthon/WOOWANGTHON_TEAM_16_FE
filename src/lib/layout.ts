// S4-1동 2층 평면도. 저장소 watchmate-be/docs/site/make_plan.py의 벽 위치(픽셀)와 환산식을 그대로 옮겼다.
// 피난안내도 사진을 223호 실측(7.35 × 5.80m)으로 환산했고, 복도 폭은 실측 2.34m. 나머지는 ±5% 오차.
// 노드 자리는 11/3 실제 배치(docs/site/s4-1_2f_layout_1103.png)다.

const S = 7.35 / 171; // m/px
const X0 = 92;
const X = (px: number) => (px - X0) * S;

const BOT = 4.8; // 아래 줄 방 깊이
const COR = 2.34; // 복도 폭
const TOP = 5.8; // 위 줄 방 깊이
const YB0 = 0;
const YC0 = BOT;
const YT0 = BOT + COR;
const YT1 = YT0 + TOP;
const LOBBY_TOP = 3.12;
const LOBBY_BOT = -2.0;

export const SITE_FLOOR_LABEL = "S4-1동 2층";

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PlanRoom extends Rect {
  name: string;
  kind: "room" | "stairs" | "toilet";
}

const TOP_ROW: [number, number, string][] = [
  [158, 407, "201"], [407, 468, "202"], [468, 590, "203"], [590, 838, "204"], [838, 1009, "223"],
  [1009, 1255, "205"], [1255, 1503, "206"], [1503, 1635, "207"], [1635, 1704, "208"],
];
const BOTTOM_ROW: [number, number, string][] = [
  [116, 297, "222"], [297, 478, "221"], [478, 540, "220"], [540, 596, "219"], [596, 658, "218"],
  [658, 779, "217"], [779, 838, "남 화장실"],
  [1004, 1124, "224"], [1124, 1184, "216"], [1184, 1246, "215"], [1246, 1307, "214"], [1307, 1369, "213"],
  [1369, 1428, "212"], [1428, 1554, "211"], [1554, 1617, "210"], [1617, 1742, "209"],
];

export const PLAN_ROOMS: PlanRoom[] = [
  ...TOP_ROW.map(([a, b, name]) => ({ name, kind: "room" as const, x0: X(a), x1: X(b), y0: YT0, y1: YT1 })),
  ...BOTTOM_ROW.map(([a, b, name]) => ({
    name,
    kind: name.includes("화장실") ? ("toilet" as const) : ("room" as const),
    x0: X(a),
    x1: X(b),
    y0: YB0,
    y1: YC0,
  })),
  { name: "여 화장실", kind: "toilet", x0: X(838), x1: X(903), y0: LOBBY_BOT, y1: LOBBY_TOP },
  { name: "계단", kind: "stairs", x0: X(903), x1: X(1004), y0: LOBBY_BOT, y1: LOBBY_TOP },
];

export const CORRIDORS: Rect[] = [
  { x0: X(116), x1: X(1765), y0: YC0, y1: YT0 },
  { x0: X(838), x1: X(1004), y0: LOBBY_TOP, y1: YC0 },
];

// 화면에 보여 줄 범위(m). 실험 구역(223·224호·앞 복도)이 가운데 오도록 204~206호, 217~213호 사이만 자른다.
export const VIEW = { xmin: X(600), xmax: X(1440), ymin: LOBBY_BOT - 0.3, ymax: YT1 + 0.3 };
export const VIEW_W = VIEW.xmax - VIEW.xmin;
export const VIEW_H = VIEW.ymax - VIEW.ymin;

// 미터 좌표 ↔ 화면 비율 좌표(0~1, 위쪽이 0). 백엔드의 구역 polygon과 노드 x·y는 이 비율 좌표로 저장한다.
export function toNorm(x: number, y: number): [number, number] {
  const nx = (x - VIEW.xmin) / VIEW_W;
  const ny = (VIEW.ymax - y) / VIEW_H;
  return [Math.round(nx * 1e5) / 1e5, Math.round(ny * 1e5) / 1e5];
}

function rectToPolygon(r: Rect): number[][] {
  return [toNorm(r.x0, r.y1), toNorm(r.x1, r.y1), toNorm(r.x1, r.y0), toNorm(r.x0, r.y0)];
}

export interface SiteZone {
  name: string;
  receiver: string;
  rect: Rect;
}

export const SITE_ZONES: SiteZone[] = [
  { name: "223호", receiver: "RX-301", rect: { x0: X(838), x1: X(1009), y0: YT0, y1: YT1 } },
  { name: "224호", receiver: "RX-302", rect: { x0: X(1004), x1: X(1124), y0: YB0, y1: YC0 } },
  // 11/3 배치에서 정한 복도 구역: RX-COR부터 TX-1까지
  { name: "복도", receiver: "RX-COR", rect: { x0: X(838), x1: X(1009) + 0.3, y0: YC0, y1: YT0 } },
];

export interface SiteNode {
  name: string;
  role: "tx" | "rx";
  x: number;
  y: number;
  zone: string | null;
}

export const SITE_NODES: SiteNode[] = [
  { name: "TX-1", role: "tx", x: X(1006), y: YC0 + COR * 0.42, zone: null },
  { name: "RX-301", role: "rx", x: X(975), y: YT1 - 0.47 * TOP, zone: "223호" },
  { name: "RX-302", role: "rx", x: X(1052), y: 0.29 * BOT, zone: "224호" },
  { name: "RX-COR", role: "rx", x: X(901), y: YC0 + COR * 0.38, zone: "복도" },
];

// 백엔드에 실험 공간을 만들 때 보내는 값
export function siteZonePayload() {
  return SITE_ZONES.map((z) => ({ name: z.name, polygon: rectToPolygon(z.rect) }));
}

export function siteNodePayload() {
  return SITE_NODES.map((n) => {
    const [x, y] = toNorm(n.x, n.y);
    return { name: n.name, role: n.role, x, y, zone: n.zone };
  });
}
