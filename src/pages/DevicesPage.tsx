import { Check, Copy, Eye, EyeOff, Play, Square } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { API_BASE, API_LABEL, IS_DEPLOYED, api } from "../api/client";
import type { BuildingDetail, ModelCard, ScenarioPublic } from "../api/types";
import DeviceStrip from "../components/DeviceStrip";
import TopBar from "../components/TopBar";
import { Button, Card, CardHeader, Chip, Notice } from "../components/ui";
import { TONE_CHIP } from "../lib/labels";
import { SITE_FLOOR_LABEL, siteNodePayload, siteZonePayload } from "../lib/layout";
import { loadJson, saveJson } from "../lib/storage";
import { ago, clock, duration, secondsSince } from "../lib/time";
import { useLive } from "../state/live";
import { useSession } from "../state/session";

const SITE_NAME = "S4-1동 2층 실험";
const CAL_SECONDS = [60, 120, 180, 300];

// 이미 있는 구역·장치는 건너뛰고 빠진 것만 만든다. 수신기 토큰은 만들 때 한 번만 오므로 받는 즉시 넘긴다.
async function ensureSite(existingId: number | null, onToken: (buildingId: number, name: string, token: string) => void) {
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

function CopyButton({ text, label = "복사" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 2000);
          })
          .catch(() => setDone(false));
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />} {done ? "복사됨" : label}
    </Button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function MockCard() {
  const { previewMock, setPreviewMock } = useLive();
  const { mockOnly, exitMock } = useSession();
  return (
    <Card>
      <CardHeader title="UI 예시(가상 데이터)" sub="센서 없이 화면 구성을 보여 줄 때 써요. 실제 탐지 결과가 아니에요." />
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
        {mockOnly ? (
          <>
            <span className="text-slate-700">로그인 없이 UI 예시로 보는 중이에요.</span>
            <Button variant="primary" onClick={exitMock}>
              로그인 화면으로
            </Button>
          </>
        ) : (
          <>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-blue-700" checked={previewMock} onChange={(e) => setPreviewMock(e.target.checked)} />
              모든 화면을 가상 데이터로 보기
            </label>
            <span className="text-xs text-slate-500">켜 두면 위쪽에 'UI 예시 · 가상 데이터'가 붙고, 실험 기록에도 'UI 예시'로 남아요.</span>
          </>
        )}
      </div>
    </Card>
  );
}

function ServerCard() {
  const { dataMode, health, error } = useLive();
  const [card, setCard] = useState<ModelCard | null>(null);
  useEffect(() => {
    api
      .modelCard()
      .then(setCard)
      .catch(() => setCard(null));
  }, [dataMode === "offline"]);

  return (
    <Card>
      <CardHeader title="서버와 모델" sub={`주소: ${API_LABEL}`} />
      <div className="space-y-3 px-5 py-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {dataMode === "offline" ? (
            <Chip className={TONE_CHIP.bad}>서버 연결 안 됨</Chip>
          ) : health ? (
            <Chip className={TONE_CHIP.ok}>서버 연결됨 · v{health.version}</Chip>
          ) : (
            <Chip className={TONE_CHIP.idle}>연결 확인 중</Chip>
          )}
          {health ? (
            <Chip className={health.mode === "person" ? TONE_CHIP.ok : TONE_CHIP.warn}>
              {health.mode === "person" ? "사람 판별 모델 사용" : "모델 미연결 · 신호 변화만 표시"}
            </Chip>
          ) : null}
        </div>
        {dataMode === "offline" ? (
          IS_DEPLOYED ? (
            <p className="text-amber-800">
              서버를 깨우는 중일 수 있어요(무료 서버는 15분 동안 쓰지 않으면 잠들어요). 1분이 지나도 안 되면 Render에서 서비스 상태를 확인하세요.
            </p>
          ) : (
            <p className="text-red-700">
              {error ?? "서버에 연결할 수 없어요."} <code className="rounded bg-slate-100 px-1">C:\wm\watchmate-be</code>에서{" "}
              <code className="rounded bg-slate-100 px-1">.\.venv\Scripts\python -m uvicorn app.main:app --port 8000</code>을 실행하세요.
            </p>
          )
        ) : null}
        {card?.summary ? <p className="text-slate-700">{card.summary}</p> : null}
        {card?.limitations?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-slate-600">
            {card.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-slate-500">정확도 수치는 검증 기록이 쌓인 뒤에만 보여 줘요. 지금 화면에는 내지 않아요.</p>
      </div>
    </Card>
  );
}

function SiteCard() {
  const { buildings, buildingId, selectBuilding, building, busy, run, setTokens } = useLive();
  const site = buildings.find((b) => b.floor_label === SITE_FLOOR_LABEL && !b.is_demo) ?? null;
  const missing = site ? (site.zone_count ?? 0) < siteZonePayload().length || (site.node_count ?? 0) < siteNodePayload().length : false;

  const build = () =>
    void run("실험 공간 만들기", async () => {
      const id = await ensureSite(site?.id ?? null, (bid, name, token) => setTokens(bid, { [name]: token }));
      selectBuilding(id);
    });

  return (
    <Card>
      <CardHeader
        title="실험 공간"
        sub="도면의 구역(223호·224호·복도)과 장치(TX-1, RX-301·302·COR)를 서버에 등록해요."
        right={
          buildings.length ? (
            <select
              id="building-select"
              aria-label="보고 있는 공간"
              value={buildingId ?? ""}
              onChange={(e) => selectBuilding(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            >
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.is_demo ? " (시연)" : ""}
                </option>
              ))}
            </select>
          ) : null
        }
      />
      <div className="space-y-3 px-5 py-4 text-sm">
        {!site ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-slate-700">아직 S4-1동 2층 실험 공간이 없어요.</span>
            <Button variant="primary" disabled={!!busy} onClick={build}>
              S4-1동 2층 실험 공간 만들기
            </Button>
          </div>
        ) : missing ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-amber-800">
              {site.name}에 빠진 구역이나 장치가 있어요(구역 {site.zone_count ?? 0}/3, 장치 {site.node_count ?? 0}/4).
            </span>
            <Button variant="primary" disabled={!!busy} onClick={build}>
              빠진 것 채우기
            </Button>
          </div>
        ) : (
          <p className="text-slate-700">
            <b>{site.name}</b> · 구역 {site.zone_count}개 · 장치 {site.node_count}개
            {site.id !== buildingId ? (
              <Button variant="ghost" className="ml-2" onClick={() => selectBuilding(site.id)}>
                이 공간 보기
              </Button>
            ) : null}
          </p>
        )}
        {building ? (
          <p className="text-xs text-slate-500">
            보고 있는 공간: {building.name} ({building.floor_label || "층 정보 없음"}) · 구역 {building.zones.map((z) => z.name).join(", ") || "없음"}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ReceiversCard({ building }: { building: BuildingDetail }) {
  const { tokens, setTokens, busy, run, now } = useLive();
  const [show, setShow] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [gateway, setGateway] = useState<string>(() => loadJson("wm.gatewayPort", "COM6"));
  // 배포본에서는 배포된 백엔드 주소, 이 PC에서는 로컬 백엔드 주소가 기본값
  const [apiUrl, setApiUrl] = useState<string>(() => loadJson("wm.collectorApi", API_BASE));

  const rx = building.nodes.filter((n) => n.role === "rx");
  const tx = building.nodes.filter((n) => n.role === "tx");
  const zoneName = (id: number | null) => building.zones.find((z) => z.id === id)?.name ?? "구역 없음";
  const mask = (t: string) => (show ? t : `••••••${t.slice(-4)}`);
  const missingTokens = rx.filter((n) => !tokens[n.name]);

  const command = (masked: boolean) =>
    [
      ".\\.venv\\Scripts\\python tools\\collector.py live",
      `--gateway ${gateway || "COM6"}`,
      `--api ${apiUrl || API_BASE}`,
      ...rx.map((n) => {
        const t = tokens[n.name];
        return `--port gw:${n.name} --token ${t ? (masked ? mask(t) : t) : `<${n.name} 토큰>`}`;
      }),
    ].join(" ");

  return (
    <Card>
      <CardHeader
        title="수신기와 수집기 명령"
        sub="게이트웨이 PC에서 아래 명령을 실행하면 수신기 데이터가 서버로 들어와요."
        right={
          <Button variant="ghost" onClick={() => setShow((v) => !v)}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />} {show ? "토큰 가리기" : "토큰 보기"}
          </Button>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              {["장치", "구역", "마지막 수신", "신호 세기", "기준선", "토큰(이 PC에 저장)"].map((h) => (
                <th key={h} className="px-3 py-2.5 font-medium first:pl-5">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rx.map((n) => {
              const age = secondsSince(n.last_seen_at, now);
              const live = age !== null && age <= 6;
              const t = tokens[n.name];
              return (
                <tr key={n.id}>
                  <td className="py-2.5 pl-5 pr-3 font-medium">
                    <span className={`mr-2 inline-block size-2 rounded-full ${live ? "bg-emerald-500" : "bg-slate-300"}`} />
                    {n.name}
                  </td>
                  <td className="px-3 py-2.5">{zoneName(n.zone_id)}</td>
                  <td className="px-3 py-2.5 tabular">{ago(age)}</td>
                  <td className="px-3 py-2.5 tabular">{n.last_rssi === null ? "—" : `${Math.round(n.last_rssi)} dBm`}</td>
                  <td className="px-3 py-2.5">
                    {n.restarted_since_calibration ? (
                      <Chip className={TONE_CHIP.bad}>다시 켜짐 · 재보정 필요</Chip>
                    ) : n.calibrated ? (
                      <Chip className={TONE_CHIP.ok}>보정됨</Chip>
                    ) : (
                      <Chip className={TONE_CHIP.warn}>보정 전</Chip>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {t ? <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{mask(t)}</code> : <span className="text-slate-500">없음</span>}
                      {confirmId === n.id ? (
                        <>
                          <span className="text-xs text-red-700">지금 쓰는 토큰은 바로 막혀요.</span>
                          <Button
                            variant="danger"
                            disabled={!!busy}
                            onClick={() =>
                              void run("토큰 발급", async () => {
                                const res = await api.rotateNodeToken(n.id);
                                setTokens(building.id, { [n.name]: res.token });
                                setConfirmId(null);
                              })
                            }
                          >
                            새로 발급
                          </Button>
                          <Button variant="ghost" onClick={() => setConfirmId(null)}>
                            취소
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" onClick={() => setConfirmId(n.id)}>
                          {t ? "다시 발급" : "새로 발급"}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 border-t border-slate-100 px-5 py-4 text-sm">
        {tx.length ? (
          <p className="text-slate-600">
            송신기: {tx.map((n) => n.name).join(", ")} · 송신기는 토큰이 없고 전원만 켜 두면 돼요.
          </p>
        ) : null}
        {missingTokens.length ? (
          <Notice tone="warn">
            토큰이 없는 수신기: {missingTokens.map((n) => n.name).join(", ")}. 토큰은 만들 때 한 번만 보여 줘서, 다른 PC에서 만들었다면 '새로 발급'을
            눌러야 해요.
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Field label="게이트웨이 USB 포트">
            <input
              id="gateway-port"
              value={gateway}
              onChange={(e) => {
                setGateway(e.target.value);
                saveJson("wm.gatewayPort", e.target.value);
              }}
              className="w-28 rounded-lg border border-slate-300 px-2 py-1.5"
            />
          </Field>
          <Field label="수집기가 보낼 서버 주소">
            <input
              id="collector-api"
              value={apiUrl}
              onChange={(e) => {
                setApiUrl(e.target.value);
                saveJson("wm.collectorApi", e.target.value);
              }}
              className="w-64 rounded-lg border border-slate-300 px-2 py-1.5"
            />
          </Field>
        </div>
        <div className="rounded-xl bg-slate-900 px-4 py-3 font-mono text-xs leading-relaxed text-slate-100">
          <div className="text-slate-400"># C:\wm\watchmate-be 폴더에서 실행 (PowerShell)</div>
          <div className="break-all">{command(true)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <CopyButton text={command(false)} label="명령 복사(토큰 포함)" />
          <span className="text-xs text-slate-500">gw:RX-301 같은 이름은 watchmate-be/nodes.csv의 MAC과 짝지어져 있어요.</span>
        </div>
      </div>
    </Card>
  );
}

function CalibrationCard({ building }: { building: BuildingDetail }) {
  const { busy, run, now } = useLive();
  const [seconds, setSeconds] = useState(120);
  const cal = building.calibration;
  const running = cal?.status === "running";
  const nodeName = (id: string) => building.nodes.find((n) => String(n.id) === id)?.name ?? `노드 ${id}`;
  const left = running && cal ? Math.max(0, (Date.parse(cal.ends_at) - now) / 1000) : 0;

  return (
    <Card>
      <CardHeader title="기준선 보정" sub="빈 방의 신호를 기준으로 저장해요. 보정이 있어야 감지를 시작할 수 있어요." />
      <div className="space-y-3 px-5 py-4 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-slate-600">
          <li>수집기 명령이 돌고 있고 수신기가 '방금' 수신 중인지 확인해요.</li>
          <li>모두 223호·224호·복도에서 나가요. 문과 의자는 실험 때와 같은 자리에 둬요.</li>
          <li>보정이 끝날 때까지 아무도 들어가지 않아요.</li>
        </ol>
        {building.active_incident ? <Notice tone="warn">감지가 켜져 있으면 보정할 수 없어요. 감지를 먼저 꺼 주세요.</Notice> : null}

        {running && cal ? (
          <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-blue-900">
            <div className="flex flex-wrap items-center gap-3">
              <b>보정 중</b>
              <span className="tabular">남은 시간 {duration(left)}</span>
              <Button className="ml-auto" disabled={!!busy} onClick={() => void run("보정 끝내기", () => api.stopCalibration(building.id))}>
                <Square size={15} /> 지금 끝내기
              </Button>
            </div>
            <ul className="space-y-0.5 tabular">
              {Object.entries(cal.progress ?? {}).map(([id, p]) => (
                <li key={id}>
                  {nodeName(id)}: 프레임 {p.frames}개 · {p.seconds}초 분량 {p.frames === 0 ? "· 아직 안 들어옴" : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="보정 시간">
              <select id="cal-seconds" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="rounded-lg border border-slate-300 px-2 py-1.5">
                {CAL_SECONDS.map((s) => (
                  <option key={s} value={s}>
                    {duration(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              variant="primary"
              disabled={!!busy || !!building.active_incident}
              onClick={() => void run("보정 시작", () => api.startCalibration(building.id, seconds))}
            >
              <Play size={15} /> 보정 시작
            </Button>
          </div>
        )}

        {cal && !running ? (
          <div className="rounded-xl border border-slate-200 px-4 py-3">
            <div className="mb-1 font-medium">
              마지막 보정: {cal.status === "done" ? "완료" : "실패"}
              {cal.finished_at ? ` · ${clock(Date.parse(cal.finished_at))}` : ""}
            </div>
            <ul className="space-y-0.5 text-slate-600">
              {Object.entries(cal.result ?? {}).map(([id, r]) => (
                <li key={id} className={r.ok ? "" : "text-red-700"}>
                  {r.node}: {r.ok ? `기준선 저장 · 프레임 ${r.frames}개 · 초당 ${r.fps ?? "—"}개` : r.error ?? "실패"}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ReplayCard() {
  const { replay, busy, run, dataMode } = useLive();
  const [list, setList] = useState<ScenarioPublic[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    if (dataMode === "offline") return;
    api
      .scenarios()
      .then((s) => {
        setList(s);
        setFailed(null);
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : "목록을 불러오지 못했어요."));
  }, [dataMode === "offline"]);

  return (
    <Card>
      <CardHeader
        title="녹화 재생(시연)"
        sub="녹화해 둔 데이터를 서버가 처음부터 다시 처리해요. 시연용 공간이 따로 생기고 화면에 '기록 재생'이 표시돼요."
        right={
          <select id="replay-speed" aria-label="재생 속도" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
            {[1, 2, 4].map((s) => (
              <option key={s} value={s}>
                {s}배속
              </option>
            ))}
          </select>
        }
      />
      <div className="space-y-3 px-5 py-4 text-sm">
        {replay?.running ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-violet-900">
            <span>
              재생 중: {replay.title} · {duration(replay.elapsed ?? 0)} / {duration(replay.duration ?? 0)}
            </span>
            <Button className="ml-auto" disabled={!!busy} onClick={() => void run("재생 멈춤", () => api.stopReplay())}>
              <Square size={15} /> 멈추기
            </Button>
          </div>
        ) : null}
        {failed ? <p className="text-red-700">{failed}</p> : null}
        {list && list.length === 0 ? (
          <p className="text-slate-500">
            재생할 녹화가 없어요. 백엔드 <code className="rounded bg-slate-100 px-1">sample_data</code> 폴더(SAMPLE_DATA_DIR)에 녹화 폴더를 넣으면 여기 나와요.
          </p>
        ) : null}
        <ul className="divide-y divide-slate-100">
          {(list ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {s.title}
                  {s.synthetic ? <Chip className={TONE_CHIP.warn}>합성 신호(개발용) · 실측 아님</Chip> : <Chip className={TONE_CHIP.ok}>실측 녹화</Chip>}
                </div>
                <p className="mt-0.5 text-slate-600">{s.description}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {s.duration_seconds ? `${duration(s.duration_seconds)} · ` : ""}구역 {s.zones.join(", ")} · 수신기 {s.rx_nodes}대
                </p>
                {!s.allowed ? <p className="mt-0.5 text-xs text-amber-800">합성 신호는 서버를 ALLOW_SYNTHETIC_DEMO=1로 켰을 때만 재생돼요.</p> : null}
              </div>
              <Button disabled={!!busy || !s.allowed || !!replay?.running} onClick={() => void run("재생 시작", () => api.startScenario(s.id, speed))}>
                <Play size={15} /> 재생
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default function DevicesPage() {
  const { dataMode, building, error, busy } = useLive();

  if (dataMode === "mock") {
    return (
      <div className="mx-auto max-w-[1400px] space-y-5">
        <TopBar title="장치 관리" sub="서버·실험 공간·수신기·기준선 보정" />
        <Notice>가상 데이터로 보는 중이라 실제 장치는 관리할 수 없어요. 아래에서 끄면 서버 정보가 보여요.</Notice>
        <MockCard />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <TopBar title="장치 관리" sub="서버·실험 공간·수신기·기준선 보정" />
      {busy ? <Notice>{busy} 중이에요…</Notice> : error && dataMode !== "offline" ? <Notice tone="bad">{error}</Notice> : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <ServerCard />
        {dataMode !== "offline" ? <SiteCard /> : null}
      </div>
      {building ? (
        <>
          <DeviceStrip />
          <ReceiversCard building={building} />
          <CalibrationCard building={building} />
        </>
      ) : null}
      {dataMode !== "offline" ? <ReplayCard /> : null}
      <MockCard />
    </div>
  );
}
