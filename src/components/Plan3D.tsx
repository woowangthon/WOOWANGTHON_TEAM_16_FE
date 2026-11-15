import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { IncidentState, ModelMode, ZoneStateCode } from "../api/types";
import { CORRIDORS, PLAN_ROOMS, SITE_FLOOR_LABEL, SITE_ZONES, VIEW, VIEW_H, VIEW_W, toNorm } from "../lib/layout";
import { predLabel, type PredClass } from "../lib/labels";

// 시연 영상(demo_split/viewer.html)에 나온 입체 도면을 화면 안으로 옮긴 것.
// 구역은 반투명한 방 부피로, 송신 보드에서 퍼지는 전파와 수신 보드로 가는 점으로 신호 흐름을 보여 준다.

type Rect4 = [number, number, number, number]; // x0, x1, y0, y1 (미터, y가 북쪽)

const COL: Partial<Record<ZoneStateCode, number>> = { detected: 0xff6b4a, possible: 0xf5b83d, not_detected: 0x2dd4a7 };
const IDLE = 0x55607a;
const ACCENT = 0x4c9dff;
const BASE_W = 736;
const ASPECT = 736 / 537;

const CHIP: Record<PredClass, { background: string; color: string }> = {
  present: { background: "#ff6b4a", color: "#ffffff" },
  maybe: { background: "rgba(52,39,12,.9)", color: "#f5b83d" },
  absent: { background: "rgba(12,36,32,.9)", color: "#2dd4a7" },
  unknown: { background: "rgba(34,39,48,.9)", color: "#8b93a1" },
};

interface Geo {
  crop: { x0: number; x1: number; y0: number; y1: number };
  zones: { id: number; name: string; rect: Rect4 }[];
  nodes: { role: "tx" | "rx"; zoneId: number | null; x: number; y: number }[];
  rooms: { name: string; rect: Rect4; isZone: boolean }[];
  corridors: Rect4[];
}

// 녹화 재생용 건물은 층 이름이 달라도 구역 좌표가 실측 도면(lib/layout.ts)과 같다. 구역 이름과 자리가 맞으면 그 도면으로 본다.
function usesSiteLayout(state: IncidentState): boolean {
  if (state.building.floor_label === SITE_FLOOR_LABEL) return true;
  return SITE_ZONES.every((s) => {
    const z = state.zones.find((x) => x.name === s.name);
    if (!z || z.polygon.length < 3) return false;
    const [nx0, ny0] = toNorm(s.rect.x0, s.rect.y1);
    const [nx1, ny1] = toNorm(s.rect.x1, s.rect.y0);
    const xs = z.polygon.map((p) => p[0]);
    const ys = z.polygon.map((p) => p[1]);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
    return near(Math.min(...xs), nx0) && near(Math.max(...xs), nx1) && near(Math.min(...ys), ny0) && near(Math.max(...ys), ny1);
  });
}

function geometry(state: IncidentState): Geo {
  const b = state.building;
  const site = usesSiteLayout(state);
  // 구역 polygon과 노드 x·y는 0~1 비율 좌표다. 실측 도면이 있으면 그 미터로, 없으면 가로 24m로 어림한다.
  const wM = site ? VIEW_W : 24;
  const hM = site ? VIEW_H : b.plan_width && b.plan_height ? (24 * b.plan_height) / b.plan_width : 13.5;
  const ox = site ? VIEW.xmin : 0;
  const top = site ? VIEW.ymax : hM;
  const toM = (nx: number, ny: number): [number, number] => [ox + nx * wM, top - ny * hM];

  const zones = state.zones
    .filter((z) => z.polygon.length >= 3)
    .map((z) => {
      const pts = z.polygon.map(([nx, ny]) => toM(nx, ny));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { id: z.id, name: z.name, rect: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] as Rect4 };
    });
  const nodes = state.nodes.map((n) => {
    const [x, y] = toM(n.x, n.y);
    return { role: n.role, zoneId: n.zone_id, x, y };
  });

  const xs = [...zones.flatMap((z) => [z.rect[0], z.rect[1]]), ...nodes.map((n) => n.x)];
  const ys = [...zones.flatMap((z) => [z.rect[2], z.rect[3]]), ...nodes.map((n) => n.y)];
  const crop = xs.length
    ? { x0: Math.min(...xs) - 3, x1: Math.max(...xs) + 3, y0: Math.min(...ys) - 0.8, y1: Math.max(...ys) + 0.8 }
    : { x0: ox, x1: ox + wM, y0: top - hM, y1: top };

  // 주변 방은 보이는 범위보다 조금 넓게 깔아 안개 속으로 이어지게 한다
  const far = { x0: crop.x0 - 14, x1: crop.x1 + 14 };
  const clip = (r: { x0: number; x1: number; y0: number; y1: number }): Rect4 | null => {
    const x0 = Math.max(r.x0, far.x0);
    const x1 = Math.min(r.x1, far.x1);
    return x1 - x0 > 0.3 ? [x0, x1, r.y0, r.y1] : null;
  };
  const zoneNames = new Set(zones.map((z) => z.name.replace("호", "")));
  const rooms: Geo["rooms"] = [];
  const corridors: Rect4[] = [];
  if (site) {
    for (const r of PLAN_ROOMS) {
      const rect = clip(r);
      if (rect) rooms.push({ name: r.name, rect, isZone: zoneNames.has(r.name) });
    }
    for (const c of CORRIDORS) {
      const rect = clip(c);
      if (rect) corridors.push(rect);
    }
  }
  return { crop, zones, nodes, rooms, corridors };
}

interface Zone3 {
  cur: THREE.Color;
  op: number;
  k: number;
  reach: number;
  glow: THREE.MeshBasicMaterial;
  fill: THREE.MeshBasicMaterial;
  edge: THREE.LineBasicMaterial;
  who: THREE.Group;
  beam: THREE.MeshBasicMaterial;
  rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[];
}

export default function Plan3D({ state, mode, onFail }: { state: IncidentState; mode: ModelMode; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  const states = useRef(new Map<number, ZoneStateCode>());
  const failed = useRef(onFail);
  failed.current = onFail;
  for (const z of state.zones) states.current.set(z.id, z.state);

  const geo = geometry(state);
  // 도면이 바뀔 때만 장면을 새로 짓는다(상태는 2초마다 바뀌지만 장면은 그대로 둔다)
  const geoKey = JSON.stringify([geo.crop, geo.zones, geo.nodes]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const g = geoRef.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      failed.current();
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.domElement.style.display = "block";
    el.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, ASPECT, 0.1, 400);
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x0b0d10, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(8, 18, 12);
    scene.add(sun);

    // 평면도 좌표(미터, y가 북쪽) → 3D(x 동쪽, y 높이, z 남쪽)
    const CX = (g.crop.x0 + g.crop.x1) / 2;
    const CY = (g.crop.y0 + g.crop.y1) / 2;
    const CAMK = Math.max((g.crop.x1 - g.crop.x0) / 18.48, (g.crop.y1 - g.crop.y0) / 13.44); // 도면이 넓으면 카메라를 그만큼 뒤로
    scene.fog = new THREE.Fog(0x0d1014, 30 * CAMK, 62 * CAMK);
    const V = (x: number, y: number, h = 0) => new THREE.Vector3(x - CX, h, CY - y);
    const root = new THREE.Group();
    scene.add(root);

    const floor = (r: Rect4, color: number, h = 0.05) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(r[1] - r[0], h, r[3] - r[2]), new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
      m.position.copy(V((r[0] + r[1]) / 2, (r[2] + r[3]) / 2, h / 2));
      root.add(m);
    };
    // 반투명한 방 부피와 밝은 모서리(홀로그램 느낌)
    const volume = (r: Rect4, h: number, color: number, fillOp: number, edgeOp: number) => {
      const geom = new THREE.BoxGeometry(r[1] - r[0] - 0.06, h, r[3] - r[2] - 0.06);
      const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOp, side: THREE.DoubleSide, depthWrite: false });
      const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: edgeOp });
      for (const o of [new THREE.Mesh(geom, fill), new THREE.LineSegments(new THREE.EdgesGeometry(geom), edge)]) {
        o.position.copy(V((r[0] + r[1]) / 2, (r[2] + r[3]) / 2, h / 2 + 0.05));
        root.add(o);
      }
      return { fill, edge };
    };
    const ring = (inner: number, outer: number, color: number, opacity: number) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(inner, outer, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      m.rotation.x = -Math.PI / 2;
      root.add(m);
      return m;
    };

    const base = new THREE.Mesh(new THREE.PlaneGeometry(140, 110), new THREE.MeshStandardMaterial({ color: 0x0e1115, roughness: 1 }));
    base.rotation.x = -Math.PI / 2;
    base.position.y = -0.02;
    root.add(base);
    const grid = new THREE.GridHelper(120, 120, 0x212a36, 0x171d26);
    grid.position.y = 0.001;
    root.add(grid);

    const labelPos = new Map<string, THREE.Vector3>();
    for (const c of g.corridors) floor(c, 0x141920, 0.04);
    for (const r of g.rooms) {
      floor(r.rect, 0x1a2029);
      if (r.isZone) continue;
      volume(r.rect, 0.8, 0x64748b, 0.04, 0.5);
      labelPos.set(`room:${r.name}`, V((r.rect[0] + r.rect[1]) / 2, (r.rect[2] + r.rect[3]) / 2, 1.0));
    }

    const waves: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
    const beams: { from: THREE.Vector3; to: THREE.Vector3; mat: THREE.LineBasicMaterial; dots: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[]; zoneId: number }[] = [];
    let tx3: THREE.Vector3 | null = null;
    const tx = g.nodes.find((n) => n.role === "tx");
    if (tx) {
      tx3 = V(tx.x, tx.y, 0.95);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: ACCENT, emissiveIntensity: 1.6 }));
      orb.position.copy(tx3);
      root.add(orb);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.95, 8), new THREE.MeshBasicMaterial({ color: 0x6f7b8f }));
      pole.position.copy(V(tx.x, tx.y, 0.475));
      root.add(pole);
      // 바닥으로 퍼지는 전파
      for (let i = 0; i < 5; i++) {
        const r = ring(0.985, 1.0, ACCENT, 0.5);
        r.position.copy(V(tx.x, tx.y, 0.1));
        waves.push(r);
      }
    }

    const zones3 = new Map<number, Zone3>();
    for (const z of g.zones) {
      const [x0, x1, y0, y1] = z.rect;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const glowMat = new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0.06, depthWrite: false });
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 0.1, y1 - y0 - 0.1), glowMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.copy(V(mx, my, 0.075));
      root.add(glow);
      const vol = volume(z.rect, 1.5, IDLE, 0.05, 0.9);
      // 사람 모양(위치는 구역 가운데로 표시한다. 구역 안 어디인지는 재지 않는다)
      const who = new THREE.Group();
      const skin = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: COL.detected, emissiveIntensity: 0.85, roughness: 0.4 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.72, 6, 14), skin);
      body.position.y = 0.66;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 14), skin);
      head.position.y = 1.42;
      const beamMat = new THREE.MeshBasicMaterial({ color: COL.detected, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 3.4, 28, 1, true), beamMat);
      beam.position.y = 1.7;
      who.add(body, head, beam);
      who.position.copy(V(mx, my, 0.06));
      who.scale.setScalar(0.001);
      root.add(who);
      const rings = [0, 1, 2].map(() => {
        const r = ring(0.93, 1.0, COL.detected as number, 0);
        r.position.copy(V(mx, my, 0.1));
        return r;
      });
      // 복도처럼 납작한 구역은 이름표를 서쪽 끝에 둬서 다른 이름표와 겹치지 않게 한다
      const flat = y1 - y0 < 3;
      labelPos.set(`zone:${z.id}`, V(flat ? x0 + 1.5 : mx, my, flat ? 1.7 : 2.0));
      zones3.set(z.id, { cur: new THREE.Color(IDLE), op: 0.06, k: 0, reach: Math.min(x1 - x0, y1 - y0) * 0.5, glow: glowMat, fill: vol.fill, edge: vol.edge, who, beam: beamMat, rings });

      const rx = g.nodes.find((n) => n.role === "rx" && n.zoneId === z.id);
      if (!rx) continue;
      const p = V(rx.x, rx.y, 0.95);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 }));
      orb.position.copy(p);
      root.add(orb);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 8), new THREE.MeshBasicMaterial({ color: 0x6f7b8f }));
      pole.position.copy(V(rx.x, rx.y, 0.475));
      root.add(pole);
      if (tx3) {
        const mat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.45 });
        root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([tx3, p]), mat));
        const dots = [0, 1, 2, 3].map(() => {
          const d = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), new THREE.MeshBasicMaterial({ color: ACCENT }));
          root.add(d);
          return d;
        });
        beams.push({ from: tx3, to: p, mat, dots, zoneId: z.id });
      }
    }

    let W = 0;
    let H = 0;
    const resize = () => {
      W = el.clientWidth;
      H = Math.round(W / ASPECT);
      if (!W) return;
      renderer.setSize(W, H);
      // 이름표 글자는 판 너비에 맞춰 줄인다
      el.style.fontSize = `${Math.max(10.5, (16 * W) / BASE_W).toFixed(1)}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const tmp = new THREE.Vector3();
    const tmpC = new THREE.Color();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!W) return;
      const t = now / 1000;
      const th = 0.38 + (still ? 0 : 0.2 * Math.sin(t * 0.21)); // 시점이 천천히 좌우로 돈다
      camera.position.set(17.5 * CAMK * Math.sin(th) + 0.4, 13.2 * CAMK, 17.5 * CAMK * Math.cos(th) + 0.6);
      camera.lookAt(0.4, 0.2, 0.2);
      waves.forEach((r, i) => {
        const ph = (t * 0.22 + i / waves.length) % 1;
        r.scale.setScalar(0.3 + ph * 13);
        r.material.opacity = 0.55 * (1 - ph) * (1 - ph);
      });
      zones3.forEach((z, id) => {
        const s = states.current.get(id);
        const on = s === "detected";
        z.cur.lerp(tmpC.setHex((s && COL[s]) ?? IDLE), 0.07);
        const target = on ? 0.5 + 0.12 * Math.sin(t * 3.2) : s === "possible" ? 0.32 : s === "not_detected" ? 0.17 : 0.06;
        z.op += (target - z.op) * 0.08;
        z.glow.color.copy(z.cur);
        z.glow.opacity = z.op;
        z.fill.color.copy(z.cur);
        z.fill.opacity = 0.04 + z.op * 0.18;
        z.edge.color.copy(z.cur);
        z.k += ((on ? 1 : 0) - z.k) * 0.09;
        z.who.scale.setScalar(Math.max(0.001, z.k * 1.1));
        z.beam.opacity = 0.1 + 0.05 * Math.sin(t * 2.4);
        z.rings.forEach((r, i) => {
          const ph = (t * 0.45 + i / 3) % 1;
          r.scale.setScalar(0.25 + ph * z.reach);
          r.material.opacity = z.k * 0.75 * (1 - ph);
        });
      });
      for (const b of beams) {
        const z = zones3.get(b.zoneId);
        if (!z) continue;
        b.mat.color.copy(z.cur);
        b.mat.opacity = states.current.get(b.zoneId) === "detected" ? 0.9 : 0.45;
        b.dots.forEach((d, i) => {
          d.position.lerpVectors(b.from, b.to, (t * 0.55 + i / b.dots.length) % 1);
          d.material.color.copy(z.cur);
        });
      }
      renderer.render(scene, camera);
      labelPos.forEach((pos, key) => {
        const node = labelEls.current.get(key);
        if (!node) return;
        tmp.copy(pos).project(camera);
        node.style.transform = `translate(${((tmp.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-tmp.y * 0.5 + 0.5) * H).toFixed(1)}px) translate(-50%, -100%)`;
        // 주변 방 이름은 판 가장자리에서 잘려 보이면 숨긴다
        const cut = key.startsWith("room:") && (Math.abs(tmp.x) > 0.8 || tmp.y < -0.86 || tmp.y > 0.8);
        node.style.visibility = cut ? "hidden" : "visible";
      });
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [geoKey]);

  const setLabel = (key: string) => (node: HTMLDivElement | null) => {
    if (node) labelEls.current.set(key, node);
    else labelEls.current.delete(key);
  };
  const labelBase = "pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-center will-change-transform";

  return (
    <div
      ref={host}
      role="img"
      aria-label={`${state.building.floor_label} 입체 도면과 구역별 상태`}
      className="relative w-full overflow-hidden rounded-xl text-[#eef0f2]"
      style={{ aspectRatio: `${BASE_W} / 537`, background: "radial-gradient(120% 90% at 50% 20%, #1a2029 0%, #0d1014 70%)" }}
    >
      {geo.rooms
        .filter((r) => !r.isZone && r.rect[1] - r.rect[0] > 2.4 && (r.rect[0] + r.rect[1]) / 2 > geo.crop.x0 - 2 && (r.rect[0] + r.rect[1]) / 2 < geo.crop.x1 + 2)
        .map((r) => (
          <div key={`room:${r.name}`} ref={setLabel(`room:${r.name}`)} className={labelBase}>
            <b className="block text-[0.75em] font-semibold text-[#9aa3b2]">{r.name}</b>
          </div>
        ))}
      {state.zones.map((z) => {
        const label = predLabel(z.state, mode);
        return (
          <div key={`zone:${z.id}`} ref={setLabel(`zone:${z.id}`)} className={labelBase}>
            <b className="block text-[1.3em] font-extrabold leading-tight" style={{ textShadow: "0 2px 10px rgba(0,0,0,.8)" }}>
              {z.name}
            </b>
            <span className="mt-[0.2em] inline-block rounded-full px-[0.85em] py-[0.12em] text-[0.82em] font-bold transition-colors duration-500" style={CHIP[label.cls]}>
              {label.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
