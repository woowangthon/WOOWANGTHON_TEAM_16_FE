import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

// done: 끝남 · current: 지금 할 차례 · warn: 다시 확인해야 함 · todo: 아직 · skipped: 건너뜀 · open: 진행 중(실험하기·마치기)
export type StepStatus = "done" | "current" | "warn" | "todo" | "skipped" | "open";

const CHIP: Record<StepStatus, [string, string]> = {
  done: ["완료", "bg-emerald-50 text-emerald-700 ring-emerald-200"],
  current: ["지금 할 차례", "bg-blue-600 text-white ring-blue-600"],
  warn: ["확인 필요", "bg-amber-50 text-amber-800 ring-amber-300"],
  todo: ["대기", "bg-slate-100 text-slate-500 ring-slate-200"],
  skipped: ["건너뜀", "bg-slate-100 text-slate-500 ring-slate-200"],
  open: ["진행 중", "bg-blue-50 text-blue-700 ring-blue-200"],
};

const BUBBLE: Record<StepStatus, string> = {
  done: "bg-emerald-500 text-white",
  current: "bg-blue-600 text-white ring-4 ring-blue-100",
  warn: "bg-amber-500 text-white ring-4 ring-amber-100",
  todo: "bg-white text-slate-400 ring-1 ring-slate-300",
  skipped: "bg-white text-slate-400 ring-1 ring-slate-300",
  open: "bg-blue-600 text-white ring-4 ring-blue-100",
};

const FRAME: Record<StepStatus, string> = {
  done: "border-slate-200",
  current: "border-blue-300 shadow-[0_6px_24px_-12px_rgba(29,78,216,0.45)]",
  warn: "border-amber-300 shadow-[0_6px_24px_-12px_rgba(217,119,6,0.45)]",
  todo: "border-slate-200",
  skipped: "border-slate-200",
  open: "border-blue-200",
};

function Hint({ label, children }: { label: string; children?: ReactNode }) {
  if (!children) return <div className="hidden md:block" />;
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3 text-[15px] leading-relaxed text-slate-700">
      <div className="mb-1.5 text-xs font-bold text-slate-500">{label}</div>
      {children}
    </div>
  );
}

export function StepCard({
  n,
  title,
  status,
  summary,
  before,
  action,
  after,
  children,
  last = false,
  forceOpen = false,
}: {
  n: number;
  title: string;
  status: StepStatus;
  summary?: ReactNode;
  before?: ReactNode;
  action?: ReactNode;
  after?: ReactNode;
  children?: ReactNode;
  last?: boolean;
  forceOpen?: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const auto = forceOpen || status === "current" || status === "warn" || status === "open";
  const open = manual ?? auto;
  const muted = status === "todo" || status === "skipped";
  const [chipText, chipCls] = CHIP[status];

  return (
    <li id={`step-${n}`} className="relative scroll-mt-6 pl-14 sm:pl-16">
      {!last ? <span aria-hidden className="absolute bottom-[-20px] left-[19px] top-12 w-0.5 bg-slate-200 sm:left-[23px]" /> : null}
      <span
        aria-hidden
        className={`absolute left-0 top-1 grid size-10 place-items-center rounded-full text-base font-bold sm:size-12 sm:text-lg ${BUBBLE[status]}`}
      >
        {status === "done" ? <Check size={22} strokeWidth={3} /> : n}
      </span>
      <section className={`rounded-2xl border bg-white ${FRAME[status]}`}>
        <button
          type="button"
          onClick={() => setManual(!open)}
          aria-expanded={open}
          className="flex w-full items-start gap-3 px-5 py-4 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={`text-lg font-bold sm:text-xl ${muted ? "text-slate-500" : "text-slate-900"}`}>{title}</h2>
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ring-inset ${chipCls}`}>{chipText}</span>
            </div>
            {summary ? <div className="mt-1 text-sm text-slate-500">{summary}</div> : null}
          </div>
          <ChevronDown size={20} className={`mt-1 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open ? (
          <div className="border-t border-slate-100 px-5 pb-5 pt-4">
            {action ? (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-4">
                <Hint label="① 하기 전에">{before}</Hint>
                <div className="flex items-center justify-center gap-3">
                  <ArrowRight aria-hidden size={20} className="hidden shrink-0 text-slate-300 md:block" />
                  <div className="flex w-full flex-col items-stretch gap-2 md:w-60">{action}</div>
                  <ArrowRight aria-hidden size={20} className="hidden shrink-0 text-slate-300 md:block" />
                </div>
                <Hint label="② 누른 뒤에">{after}</Hint>
              </div>
            ) : before || after ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Hint label="① 하기 전에">{before}</Hint>
                <Hint label="② 누른 뒤에">{after}</Hint>
              </div>
            ) : null}
            {children ? <div className={before || action || after ? "mt-5" : ""}>{children}</div> : null}
          </div>
        ) : null}
      </section>
    </li>
  );
}
