import { Eye, EyeOff, Play, Square } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { API_LABEL, IS_DEPLOYED, api } from "../api/client";
import type { BuildingDetail, ModelCard, ScenarioPublic } from "../api/types";
import DeviceStrip from "../components/DeviceStrip";
import TopBar from "../components/TopBar";
import { Button, Card, CardHeader, Chip, CopyButton, Notice } from "../components/ui";
import { collectorCommand, maskToken, useCollectorSettings } from "../lib/collector";
import { TONE_CHIP } from "../lib/labels";
import { siteNodePayload, siteZonePayload } from "../lib/layout";
import { ensureSite, findSite } from "../lib/site";
import { ago, duration, secondsSince } from "../lib/time";
import { useLive } from "../state/live";
import { useSession } from "../state/session";

// 평소 실험은 '실험 진행' 한 페이지에서 한다. 여기는 가끔 쓰는 설정만 모았다.

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
  const offline = dataMode === "offline";
  useEffect(() => {
    api
      .modelCard()
      .then(setCard)
      .catch(() => setCard(null));
  }, [offline]);

  return (
    <Card>
      <CardHeader title="서버와 모델" sub={`주소: ${API_LABEL}`} />
      <div className="space-y-3 px-5 py-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {offline ? (
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
        {offline ? (
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
  const site = findSite(buildings);
  const missing = site ? (site.zone_count ?? 0) < siteZonePayload().length || (site.node_count ?? 0) < siteNodePayload().length : false;

  const build = () =>
    void run("실험 공간 만들기", async () => {
      const id = await ensureSite(site?.id ?? null, (bid, name, token) => setTokens(bid, { [name]: token }));
      selectBuilding(id);
    });

  return (
    <Card>
      <CardHeader
        title="보고 있는 공간"
        sub="평소에는 'S4-1동 2층 실험'이에요. 녹화 재생으로 생긴 시연 공간을 볼 때만 바꿔요."
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
          <p className="text-slate-700">아직 실험 공간이 없어요. 실험 진행 2단계에서 등록하세요.</p>
        ) : missing ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-amber-800">
              {site.name}에 빠진 구역이나 보드가 있어요(구역 {site.zone_count ?? 0}/3, 보드 {site.node_count ?? 0}/4).
            </span>
            <Button variant="primary" disabled={!!busy} onClick={build}>
              빠진 것 채우기
            </Button>
          </div>
        ) : (
          <p className="text-slate-700">
            <b>{site.name}</b> · 구역 {site.zone_count}개 · 보드 {site.node_count}개
            {site.id !== buildingId ? (
              <Button variant="ghost" className="ml-2" onClick={() => selectBuilding(site.id)}>
                이 공간 보기
              </Button>
            ) : null}
          </p>
        )}
        {building ? (
          <p className="text-xs text-slate-500">
            지금 보는 공간: {building.name} ({building.floor_label || "층 정보 없음"}) · 구역 {building.zones.map((z) => z.name).join(", ") || "없음"}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ReceiversCard({ building }: { building: BuildingDetail }) {
  const { tokens, setTokens, busy, run, now } = useLive();
  const { gateway, setGateway, apiUrl, setApiUrl } = useCollectorSettings();
  const [show, setShow] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const rx = building.nodes.filter((n) => n.role === "rx");
  const tx = building.nodes.filter((n) => n.role === "tx");
  const zoneName = (id: number | null) => building.zones.find((z) => z.id === id)?.name ?? "구역 없음";
  const missingTokens = rx.filter((n) => !tokens[n.name]);
  const command = (masked: boolean) =>
    collectorCommand({ gateway, api: apiUrl, receivers: rx.map((n) => n.name), tokens, masked });

  return (
    <Card>
      <CardHeader
        title="수신기 토큰과 수집기 명령"
        sub="토큰을 잃어버렸거나 다른 서버로 보낼 때 여기서 바꿔요."
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
              {["보드", "구역", "마지막 수신", "신호 세기", "기준선", "토큰(이 브라우저에 저장)"].map((h) => (
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
                      {t ? (
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{show ? t : maskToken(t)}</code>
                      ) : (
                        <span className="text-slate-500">없음</span>
                      )}
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
        {tx.length ? <p className="text-slate-600">송신기: {tx.map((n) => n.name).join(", ")} · 송신기는 토큰이 없고 전원만 켜 두면 돼요.</p> : null}
        {missingTokens.length ? (
          <Notice tone="warn">
            토큰이 없는 수신기: {missingTokens.map((n) => n.name).join(", ")}. 토큰은 만들 때 한 번만 보여 줘서, 다른 브라우저에서 만들었다면 '새로 발급'을
            눌러야 해요.
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Field label="게이트웨이 USB 포트">
            <input id="settings-gateway-port" value={gateway} onChange={(e) => setGateway(e.target.value)} className="w-28 rounded-lg border border-slate-300 px-2 py-1.5" />
          </Field>
          <Field label="수집기가 보낼 서버 주소">
            <input id="collector-api" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className="w-64 rounded-lg border border-slate-300 px-2 py-1.5" />
          </Field>
        </div>
        <div className="rounded-xl bg-slate-900 px-4 py-3 font-mono text-xs leading-relaxed text-slate-100">
          <div className="text-slate-400"># C:\wm\watchmate-be 폴더에서 실행 (PowerShell)</div>
          <div className="break-all">{command(!show)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <CopyButton text={command(false)} label="명령 복사(토큰 포함)" />
          <span className="text-xs text-slate-500">gw:RX-301 같은 이름은 watchmate-be/nodes.csv의 MAC과 짝지어져 있어요.</span>
        </div>
      </div>
    </Card>
  );
}

function ReplayCard() {
  const { replay, busy, run, dataMode } = useLive();
  const [list, setList] = useState<ScenarioPublic[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const offline = dataMode === "offline";

  useEffect(() => {
    if (offline) return;
    api
      .scenarios()
      .then((s) => {
        setList(s);
        setFailed(null);
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : "목록을 불러오지 못했어요."));
  }, [offline]);

  return (
    <Card>
      <CardHeader
        title="녹화 재생(시연)"
        sub="녹화해 둔 데이터를 서버가 처음부터 다시 처리해요. 시연용 공간이 따로 생기고, 실험 진행 화면 위에 '기록 재생'이 표시돼요."
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
  const sub = "평소에는 쓰지 않아요. 실험은 '실험 진행' 한 페이지에서 차례대로 하면 돼요.";

  if (dataMode === "mock") {
    return (
      <div className="space-y-5">
        <TopBar title="고급 설정" sub={sub} />
        <Notice>가상 데이터로 보는 중이라 실제 장치는 관리할 수 없어요. 아래에서 끄면 서버 정보가 보여요.</Notice>
        <MockCard />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <TopBar title="고급 설정" sub={sub} />
      {busy ? <Notice>{busy} 중이에요…</Notice> : error && dataMode !== "offline" ? <Notice tone="bad">{error}</Notice> : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <ServerCard />
        {dataMode !== "offline" ? <SiteCard /> : null}
      </div>
      {building ? (
        <>
          <DeviceStrip />
          <ReceiversCard building={building} />
        </>
      ) : null}
      {dataMode !== "offline" ? <ReplayCard /> : null}
      <MockCard />
    </div>
  );
}
