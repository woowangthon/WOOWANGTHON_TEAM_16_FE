import { api } from "../api/client";
import type { BuildingDetail } from "../api/types";
import { SITE_FLOOR_LABEL, siteNodePayload, siteZonePayload } from "./layout";

export const SITE_NAME = "S4-1동 2층 실험";

export function findSite<T extends { floor_label: string; is_demo: boolean }>(buildings: T[]): T | null {
  return buildings.find((b) => b.floor_label === SITE_FLOOR_LABEL && !b.is_demo) ?? null;
}

// S4-1동 2층 실험 공간을 만들거나, 이미 있으면 빠진 구역·보드만 채운다.
// 수신기 토큰은 만들 때 한 번만 오므로 받는 즉시 넘긴다.
export async function ensureSite(
  existingId: number | null,
  onToken: (buildingId: number, name: string, token: string) => void,
): Promise<number> {
  const b: BuildingDetail = existingId
    ? await api.building(existingId)
    : await api.createBuilding({ name: SITE_NAME, address: "", floor_label: SITE_FLOOR_LABEL });
  const zoneIds: Record<string, number> = Object.fromEntries(b.zones.map((z) => [z.name, z.id]));
  for (const z of siteZonePayload()) {
    if (zoneIds[z.name] === undefined) zoneIds[z.name] = (await api.createZone(b.id, z)).id;
  }
  const have = new Set(b.nodes.map((n) => n.name));
  for (const n of siteNodePayload()) {
    if (have.has(n.name)) continue;
    const created = await api.createNode(b.id, {
      name: n.name,
      role: n.role,
      x: n.x,
      y: n.y,
      zone_id: n.zone ? zoneIds[n.zone] ?? null : null,
    });
    if (created.token) onToken(b.id, n.name, created.token);
  }
  return b.id;
}
