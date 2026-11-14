import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ScenarioPublic } from "../api/types";
import { duration } from "../lib/time";
import { useLive } from "../state/live";
import { Button } from "./ui";

const LABEL = "녹화 재생 시작";

// 보드가 없는 사람도 첫 화면에서 실측 녹화를 바로 재생해 볼 수 있게 한다.
// 재생 자체는 '고급 설정 → 녹화 재생(시연)'과 같은 서버 기능이다.
export default function QuickReplay() {
  const { busy, run } = useLive();
  const [scenario, setScenario] = useState<ScenarioPublic | null>(null);

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
  const starting = busy === LABEL;

  return (
    <div className="mb-5 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4 text-violet-950">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <p className="text-[17px] font-bold">보드 없이 바로 보기</p>
          <p className="mt-1 text-sm leading-relaxed">
            실제 건물에서 녹화한 신호를 서버가 처음부터 다시 처리해 보여 줘요. 결과를 미리 정해 두지 않았고, 화면에는 &lsquo;기록 재생&rsquo;이라고
            표시돼요.
          </p>
          <p className="mt-1 text-xs text-violet-900/80">
            {scenario.title}
            {scenario.duration_seconds ? ` · ${duration(scenario.duration_seconds)}` : ""} · 구역 {scenario.zones.join(", ")}
          </p>
        </div>
        <Button variant="primary" size="lg" disabled={!!busy} onClick={() => void run(LABEL, () => api.startScenario(scenario.id, 1))}>
          <Play size={16} /> {LABEL}
        </Button>
      </div>
      {starting ? (
        <p className="mt-3 text-sm">빈 방 구간으로 기준을 계산하는 중이에요. 30초쯤 걸려요. 끝나면 화면이 저절로 바뀌어요.</p>
      ) : null}
    </div>
  );
}
