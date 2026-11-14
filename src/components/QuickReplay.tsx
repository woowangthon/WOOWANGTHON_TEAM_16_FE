import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ScenarioPublic } from "../api/types";
import { mmss } from "../lib/time";
import { useLive } from "../state/live";
import { Button } from "./ui";

export const REPLAY_START_LABEL = "녹화 재생 시작";
// 기본 배속. 무료 서버(CPU 0.1개)와 같은 조건에서 4배속까지 따라오는 것을 재 보고 정했다.
export const FAST_SPEED = 4;

// 기준을 계산하는 동안 몇 초째인지 센다
export function useWaited(active: boolean): number {
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!active) {
      setWaited(0);
      return;
    }
    const t0 = Date.now();
    const id = window.setInterval(() => setWaited(Math.round((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [active]);
  return waited;
}

export function StartingBar({ waited }: { waited: number }) {
  return (
    <div className="mt-4 rounded-xl bg-white/70 px-4 py-3 ring-1 ring-violet-200">
      <p className="text-[15px] font-medium">
        지금 서버가 빈 방 구간의 신호로 보드마다 기준을 계산하고 있어요 · <span className="tabular-nums">{waited}초째</span> (보통 30초쯤)
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-violet-200">
        <div className="h-2 rounded-full bg-violet-600 transition-[width] duration-500" style={{ width: `${Math.min(96, (waited / 30) * 100)}%` }} />
      </div>
      <p className="mt-2 text-[13px] text-violet-900/80">끝나면 화면이 저절로 바뀌어요.</p>
    </div>
  );
}

// 보드가 없는 사람도 첫 화면에서 실측 녹화를 바로 재생해 볼 수 있게 한다.
// 재생 자체는 '고급 설정 → 녹화 재생(시연)'과 같은 서버 기능이다.
export default function QuickReplay() {
  const { busy, run } = useLive();
  const [scenario, setScenario] = useState<ScenarioPublic | null>(null);
  const starting = busy === REPLAY_START_LABEL;
  const waited = useWaited(starting);

  useEffect(() => {
    let alive = true;
    api
      .scenarios()
      .then((list) => {
        if (alive) setScenario(list.find((s) => s.allowed && !s.synthetic) ?? null);
      })
      .catch(() => {
        if (alive) setScenario(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!scenario) return null;
  const start = (speed: number) => void run(REPLAY_START_LABEL, () => api.startScenario(scenario.id, speed));

  return (
    <div className="mb-5 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-5 text-violet-950">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
        <div className="min-w-0 flex-1 basis-96">
          <p className="text-[20px] font-bold">보드 없이 바로 보기</p>
          <p className="mt-1.5 text-[15px] leading-relaxed">
            실제 건물에서 녹화한 와이파이 신호를 서버가 처음부터 다시 처리해 보여 줘요. 결과를 미리 정해 두지 않았고, 화면에는 &lsquo;기록
            재생&rsquo;이라고 표시돼요.
          </p>
          <p className="mt-1.5 text-[13px] text-violet-900/80">
            {scenario.title} · 구역 {scenario.zones.join(", ")} · 수신 보드 {scenario.rx_nodes}대
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-2">
          <Button variant="primary" size="lg" disabled={!!busy} onClick={() => start(FAST_SPEED)}>
            <Play size={17} /> {REPLAY_START_LABEL} · {FAST_SPEED}배속
          </Button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => start(1)}
            className="text-center text-[13px] text-violet-900 underline hover:text-violet-950 disabled:opacity-50"
          >
            실제 속도로 보기{scenario.duration_seconds ? ` (${mmss(scenario.duration_seconds)})` : ""}
          </button>
        </div>
      </div>

      {starting ? <StartingBar waited={waited} /> : null}

      {scenario.timeline.length ? (
        <div className="mt-4">
          <p className="text-[13px] font-medium text-violet-900">이 녹화에서 실제로 있었던 일</p>
          <ol className="mt-1.5 grid gap-1.5 text-[14px] sm:grid-cols-2">
            {scenario.timeline.map((t) => (
              <li key={t.at} className="flex gap-2.5 rounded-lg bg-white/60 px-3 py-1.5">
                <span className="w-9 shrink-0 text-right tabular-nums text-violet-900/70">{mmss(t.at)}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
