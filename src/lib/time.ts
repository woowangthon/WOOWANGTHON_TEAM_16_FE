export function clock(ms: number, withSeconds = true): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return withSeconds ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "기록 없음";
  if (seconds < 3) return "방금";
  if (seconds < 60) return `${Math.round(seconds)}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3600)}시간 전`;
}

export function secondsSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}초`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s / 60}분`;
  const m = Math.floor((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)}시간 ${m}분` : `${Math.floor(s / 3600)}시간`;
}
