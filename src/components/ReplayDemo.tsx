import { RotateCcw, Square } from "lucide-react";
import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { IncidentState, ReplayStatus, ScenarioPublic } from "../api/types";
import { PRED_CHIP, predLabel, type PredClass } from "../lib/labels";
import { rangeText } from "../lib/ranges";
import { mmss } from "../lib/time";
import { useLive } from "../state/live";
import { PredLegend } from "./Legends";
import PlanView, { planBackground, planFromState } from "./PlanView";
import { FAST_SPEED, REPLAY_START_LABEL, StartingBar, useWaited } from "./QuickReplay";
import SpaceCard from "./SpaceCard";
import { Button, Chip } from "./ui";

interface ScreenEvent {
  at: number;
  zone: string;
  text: string;
  cls: PredClass;
}

const LOGGED: PredClass[] = ["present", "maybe", "absent"];

// 입체 도면은 three.js가 필요해서 이 화면을 열 때만 따로 받아 온다
const Plan3D = lazy(() => import("./Plan3D"));

// 입체 도면을 받아 오지 못하거나 그리다 실패하면 평면 도면으로 돌아간다
class Plan3DGuard extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const LEGEND_3D: [string, string][] = [
  ["#ff6b4a", "present"],
  ["#f5b83d", "maybe"],
  ["#2dd4a7", "absent"],
];

// 녹화 재생을 보는 사람(보드가 없는 사람)을 위한 화면.
// 위에는 진행 상황, 가운데에는 도면과 '실제로 있었던 일 · 화면 판정' 대조, 아래에는 구역 카드를 둔다.
export default function ReplayDemo({
  state,
  replay,
  onEnd,
  onToolView,
}: {
  state: IncidentState;
  replay: ReplayStatus | null;
  onEnd: () => void;
  onToolView: () => void;
}) {
  const { busy, run } = useLive();
  // 서버가 다시 켜지면 재생 상태(제목·실제 상황 기록)를 잊는다. 그때는 시나리오 목록에서 채운다.
  const [fallback, setFallback] = useState<ScenarioPublic | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .scenarios()
      .then((list) => {
        if (alive) setFallback(list.find((s) => s.allowed && !s.synthetic) ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const running = !!replay?.running;
  const speed = replay?.speed && replay.speed > 0 ? replay.speed : 1;
  const total = replay?.duration ?? 0;
  const elapsed = Math.min(replay?.elapsed ?? 0, total || Infinity);
  const truthItems = replay?.timeline ?? fallback?.timeline ?? [];
  const title = replay?.title ?? fallback?.title ?? "녹화 데이터";
  const scenarioId = replay?.scenario_id ?? fallback?.id;

  // 서버 상태는 2초마다 받는다. 그 사이에는 진행 막대만 배속에 맞춰 부드럽게 움직인다(서버가 알려 준 시각을 앞지르지 않게 묶음).
  const anchor = useRef({ elapsed, at: performance.now() });
  const [, setTick] = useState(0);
  useEffect(() => {
    anchor.current = { elapsed, at: performance.now() };
  }, [elapsed]);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);
  const drift = running ? Math.min(((performance.now() - anchor.current.at) / 1000) * speed, 2.4 * speed) : 0;
  const shown = total ? Math.min(total, anchor.current.elapsed + drift) : anchor.current.elapsed + drift;
  const pct = total ? Math.min(100, (shown / total) * 100) : 0;

  // 화면 판정이 바뀐 순간을 적어 둔다(재생을 처음부터 지켜본 경우에만 정확하다)
  const [events, setEvents] = useState<ScreenEvent[]>([]);
  const last = useRef<Map<number, PredClass>>(new Map());
  const watching = useRef<number | undefined>(undefined);
  const fromStart = useRef(false);
  useEffect(() => {
    if (watching.current !== replay?.incident_id) {
      watching.current = replay?.incident_id;
      last.current = new Map();
      fromStart.current = running && elapsed < 15;
      setEvents([]);
    }
    // 새 재생을 막 시작했을 때는 화면에 아직 앞선 재생의 상태가 남아 있을 수 있다. 같은 상황의 상태만 적는다.
    if (!running || !fromStart.current || state.incident.id !== replay?.incident_id) return;
    const added: ScreenEvent[] = [];
    for (const z of state.zones) {
      const label = predLabel(z.state, state.mode);
      if (!LOGGED.includes(label.cls)) continue;
      const before = last.current.get(z.id);
      last.current.set(z.id, label.cls);
      if (before === label.cls) continue;
      // 처음 본 상태가 '뚜렷한 변화 없음'이면 적지 않는다
      if (before === undefined && label.cls === "absent") continue;
      added.push({ at: elapsed, zone: z.name, text: label.text, cls: label.cls });
    }
    if (added.length) setEvents((prev) => [...prev, ...added].slice(-12));
  }, [state, replay?.incident_id, running, elapsed]);

  const nowTruth = [...truthItems].reverse().find((t) => t.at <= shown);
  const rows = [
    ...truthItems.map((t) => ({ kind: "truth" as const, at: t.at, text: t.text })),
    ...events.map((e) => ({ kind: "screen" as const, at: e.at, text: `${e.zone} · ${e.text}`, cls: e.cls })),
  ].sort((a, b) => a.at - b.at || (a.kind === "truth" ? -1 : 1));

  const plan = planFromState(state);
  const plan2d = <PlanView background={planBackground(state.building)} zones={plan.zones} nodes={plan.nodes} mode={state.mode} fit />;
  // 도면 보기: 입체(시연 영상과 같은 모습)가 기본이고, 평면으로 바꿀 수 있다
  const [view3d, setView3d] = useState(true);
  const [fail3d, setFail3d] = useState(false);
  const show3d = view3d && !fail3d;
  const words3d: Record<string, string> = {
    present: predLabel("detected", state.mode).text,
    maybe: predLabel("possible", state.mode).text,
    absent: predLabel("not_detected", state.mode).text,
  };
  const zones = state.zones.slice().sort((a, b) => a.id - b.id);
  const rxByZone = (id: number) => state.nodes.filter((n) => n.role === "rx" && n.zone_id === id);
  const starting = busy === REPLAY_START_LABEL;
  const waited = useWaited(starting);
  const restart = (s: number) => {
    if (scenarioId) void run(REPLAY_START_LABEL, () => api.startScenario(scenarioId, s));
  };

  return (
    <div>
      <section className="mb-5 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4 text-violet-950">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-96">
            <p className="text-[19px] font-bold">{running ? "실제 측정 녹화를 서버가 다시 처리하고 있어요" : "녹화 재생이 끝났어요"}</p>
            <p className="mt-1 text-sm leading-relaxed">
              {title}
              {replay?.speed ? (
                <>
                  {" "}
                  · <b>{speed > 1 ? `${speed}배속` : "실제 속도"}</b>
                </>
              ) : null}{" "}
              · 결과를 미리 정해 두지 않았고, 서버가 2초 구간마다 새로 판정해요.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button disabled={!!busy} onClick={() => void run("재생 멈춤", () => api.stopReplay())}>
                <Square size={15} /> 멈추기
              </Button>
            ) : (
              <>
                <Button variant="primary" disabled={!!busy} onClick={() => restart(FAST_SPEED)}>
                  <RotateCcw size={15} /> 다시 재생 · {FAST_SPEED}배속
                </Button>
                <Button disabled={!!busy} onClick={() => restart(1)}>
                  실제 속도로 재생
                </Button>
              </>
            )}
            <Button variant="ghost" disabled={!!busy} onClick={onEnd}>
              닫기
            </Button>
          </div>
        </div>

        <div className={total ? "mt-4" : "hidden"}>
          <div className="relative h-2.5 rounded-full bg-violet-200">
            <div className="h-2.5 rounded-full bg-violet-600" style={{ width: `${pct}%` }} />
            {total
              ? truthItems
                  .filter((t) => t.at > 0 && t.at < total)
                  .map((t) => (
                    <span
                      key={t.at}
                      aria-hidden
                      className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 rounded bg-violet-900/50"
                      style={{ left: `${(t.at / total) * 100}%` }}
                    />
                  ))
              : null}
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[13px]">
            <span>
              녹화 시각 <b className="tabular-nums">{mmss(shown)}</b> / {mmss(total)}
            </span>
            {nowTruth ? (
              <span>
                이때 실제 상황: <b>{nowTruth.text}</b>
              </span>
            ) : null}
          </div>
        </div>
        {starting ? <StartingBar waited={waited} /> : null}
      </section>

      {/* 다시 시작해 기준을 계산하는 동안에는 앞선 재생의 결과를 흐리게 둔다 */}
      <div className={starting ? "pointer-events-none opacity-40" : ""}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <section className="rounded-2xl bg-white ring-1 ring-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <b className="text-[17px] text-slate-900">도면 · 지금 화면 판정</b>
            {fail3d ? null : (
              <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm" role="group" aria-label="도면 보기 방식">
                {(
                  [
                    [true, "입체"],
                    [false, "평면"],
                  ] as const
                ).map(([v, text]) => (
                  <button
                    key={text}
                    type="button"
                    aria-pressed={view3d === v}
                    onClick={() => setView3d(v)}
                    className={`rounded-md px-3 py-1 font-medium ${view3d === v ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </div>
          {show3d ? (
            <div className="p-3">
              <Plan3DGuard onFail={() => setFail3d(true)}>
                <Suspense fallback={<div className="mx-auto max-w-[560px]">{plan2d}</div>}>
                  <Plan3D state={state} mode={state.mode} onFail={() => setFail3d(true)} />
                </Suspense>
              </Plan3DGuard>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-slate-600">
                {LEGEND_3D.map(([color, cls]) => (
                  <span key={cls} className="inline-flex items-center gap-1.5">
                    <i className="size-3 rounded-sm" style={{ background: color }} />
                    {words3d[cls]}
                  </span>
                ))}
                {state.mode === "person" ? null : <span className="text-slate-400">({rangeText(state.thresholds)})</span>}
              </div>
            </div>
          ) : (
            <>
              <div className="px-5 pt-3">
                <PredLegend />
              </div>
              <div className="mx-auto max-w-[560px] p-3">{plan2d}</div>
            </>
          )}
          <p className="border-t border-slate-100 px-5 py-3 text-xs leading-relaxed text-slate-500">
            {show3d ? (
              <>
                파란 구슬은 송신 보드, 흰 구슬은 수신 보드예요. 솟아오른 빛기둥과 사람 모양은{" "}
                {state.mode === "person" ? "사람이 있다고 본 구역" : "빈 방일 때보다 신호가 크게 달라진 구역"}을 가리켜요. 구역 가운데에 그릴 뿐, 방 안
                어디인지나 인원수는 재지 않아요.
              </>
            ) : (
              <>
                {state.mode === "person" ? "사람 모양 = 사람 있음. " : `파형 동그라미 = 빈 방일 때와 신호가 달라짐 · ${rangeText(state.thresholds)}. `}
                둥근 점은 수신 보드, 빨간 마름모는 송신 보드예요. 구역 단위라 정확한 위치나 인원수는 알 수 없어요.
              </>
            )}
          </p>
        </section>

        <section className="rounded-2xl bg-white ring-1 ring-slate-200">
          <div className="border-b border-slate-100 px-5 py-3">
            <b className="text-[17px] text-slate-900">실제로 있었던 일과 화면 판정</b>
            <p className="mt-0.5 text-[13px] text-slate-500">녹화할 때 적어 둔 실제 상황 옆에, 화면 판정이 바뀐 순간을 함께 적어요.</p>
          </div>
          <ol className="space-y-1.5 px-5 py-4">
            {rows.map((r, i) => {
              const future = running && r.kind === "truth" && r.at > shown;
              const current = r.kind === "truth" && nowTruth?.at === r.at && running;
              return (
                <li
                  key={`${r.kind}-${r.at}-${i}`}
                  className={`flex items-start gap-3 rounded-xl px-3 py-2 ${current ? "bg-violet-50 ring-1 ring-violet-200" : ""} ${future ? "opacity-45" : ""}`}
                >
                  <span className="w-10 shrink-0 pt-0.5 text-right text-sm tabular-nums text-slate-500">{mmss(r.at)}</span>
                  {r.kind === "truth" ? (
                    <>
                      <Chip className="shrink-0 bg-slate-100 text-slate-600 ring-slate-200">실제</Chip>
                      <span className="text-[15px] text-slate-800">{r.text}</span>
                    </>
                  ) : (
                    <>
                      <Chip className={`shrink-0 ${PRED_CHIP[r.cls]}`}>화면</Chip>
                      <span className="text-[15px] font-medium text-slate-900">{r.text}</span>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="border-t border-slate-100 px-5 py-3 text-xs leading-relaxed text-slate-500">
            {events.length || running
              ? `화면 판정 시각은 화면이 서버 상태를 받아 온 때(2초마다, 녹화 시간으로는 ${2 * speed}초 간격)라서 몇 초 늦게 적힐 수 있어요.`
              : "화면 판정이 바뀌는 순간은 재생을 처음부터 지켜볼 때 여기에 적혀요. 위의 '다시 재생'을 눌러 보세요."}
          </p>
        </section>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {zones.map((z) => (
          <SpaceCard key={z.id} zone={z} mode={state.mode} rx={rxByZone(z.id)} truth={null} compact />
        ))}
      </div>
      </div>

      <section className="mt-5 rounded-2xl bg-white px-5 py-4 ring-1 ring-slate-200">
        <b className="text-slate-900">이 화면을 읽는 법</b>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-slate-700">
          <li>
            <b>신호 변화 큼</b>은 그 방의 와이파이 신호가 빈 방일 때와 크게 달라졌다는 뜻이에요. 기준은 같은 녹화의 빈 방 구간으로, 재생을 시작할
            때 서버가 계산해요.
          </li>
          <li>
            <b>뚜렷한 변화 없음</b>은 사람이 없다는 보장이 아니에요. 가만히 누워 있는 사람은 놓칠 수 있어서, 화면은 &lsquo;없음&rsquo;이라고 말하지
            않아요.
          </li>
          <li>사람이 한 방에 있어도 옆 구역이 잠깐 &lsquo;신호 변화 가능&rsquo;으로 뜰 수 있어요. 그런 순간도 지우지 않고 그대로 보여 줘요.</li>
        </ul>
        <button type="button" onClick={onToolView} className="mt-3 text-sm text-slate-500 underline hover:text-slate-800">
          실험할 때 쓰는 화면으로 보기
        </button>
      </section>
    </div>
  );
}
