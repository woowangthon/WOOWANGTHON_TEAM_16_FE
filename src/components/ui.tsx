import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <section className={`rounded-2xl border border-slate-200 bg-white ${className}`}>{children}</section>;
}

export function CardHeader({ title, right, sub }: { title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-slate-100 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[17px] font-bold text-slate-900">{title}</h2>
        {sub ? <p className="mt-0.5 text-sm text-slate-500">{sub}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function Chip({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      {children}
    </span>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-blue-800 disabled:bg-blue-300",
  secondary: "bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-white text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-50 disabled:text-red-300",
  ghost: "text-slate-600 hover:bg-slate-100 disabled:text-slate-300",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
    />
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad"; children: ReactNode }) {
  const cls =
    tone === "bad"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-blue-200 bg-blue-50 text-blue-900";
  return <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}
