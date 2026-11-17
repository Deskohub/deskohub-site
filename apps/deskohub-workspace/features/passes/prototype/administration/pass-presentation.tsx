"use client";

// PROTOTYPE ONLY: small presentational pieces shared by the pass admin screens.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import { cn } from "@/shared/utils";
import type { PrototypePass, UnlimitedPass } from "../mock-passes";
import {
  type EntryPackCounts,
  formatShortDate,
  isComplimentary,
  passStatusPresentation,
  type UnlimitedDayState,
  unlimitedDays,
} from "./admin-pass-data";

export function PassStatusBadge({ pass }: { readonly pass: PrototypePass }) {
  const { label, tone } = passStatusPresentation(pass);
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export function ComplimentaryBadge() {
  return <StatusBadge tone="neutral">Complimentary</StatusBadge>;
}

export function UnverifiedHolderBadge() {
  return <StatusBadge tone="progress">Not verified</StatusBadge>;
}

export function PassBadges({ pass }: { readonly pass: PrototypePass }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <PassStatusBadge pass={pass} />
      {isComplimentary(pass) && <ComplimentaryBadge />}
      {!pass.holderVerified && <UnverifiedHolderBadge />}
    </span>
  );
}

/** The `?action=` search param that opens one of the pass dialogs. */
export function useActionParam() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const action = searchParams.get("action");
  const setAction = (next: string | null, extra?: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("action", next);
    else {
      params.delete("action");
      params.delete("state");
      params.delete("days");
      params.delete("product");
    }
    for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return { action, searchParams, setAction };
}

const entrySegmentClassName = {
  used: "bg-navy-blue",
  booked: "bg-sunset-yellow",
  free: "bg-navy-blue/10",
} as const;

export function EntryPackMeter({
  counts,
  freeLabel = "Free",
}: {
  readonly counts: EntryPackCounts;
  readonly freeLabel?: string;
}) {
  const slots = [
    ...Array.from({ length: counts.used }, () => "used" as const),
    ...Array.from({ length: counts.booked }, () => "booked" as const),
    ...Array.from({ length: counts.free }, () => "free" as const),
  ];
  return (
    <div>
      <div aria-hidden className="flex gap-1">
        {slots.map((slot, index) => (
          <span
            className={cn("h-3 flex-1 rounded-full", entrySegmentClassName[slot])}
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
            key={index}
          />
        ))}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <MeterLegend className={entrySegmentClassName.used} label="Used" value={counts.used} />
        <MeterLegend className={entrySegmentClassName.booked} label="Booked ahead" value={counts.booked} />
        <MeterLegend className={entrySegmentClassName.free} label={freeLabel} value={counts.free} />
      </dl>
    </div>
  );
}

function MeterLegend({
  className,
  label,
  value,
}: {
  readonly className: string;
  readonly label: string;
  readonly value: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className={cn("size-2.5 rounded-full", className)} />
      <dt className="text-navy-blue/65">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

const dayStateClassName: Record<UnlimitedDayState, string> = {
  visited: "bg-navy-blue text-white",
  missed: "bg-navy-blue/25 text-navy-blue",
  today: "bg-burned-orange text-white ring-2 ring-burned-orange/30 ring-offset-1",
  upcoming: "border border-navy-blue/15 bg-white text-navy-blue/70",
  released: "border border-dashed border-navy-blue/20 bg-transparent text-navy-blue/40 line-through",
};

const dayStateLabel: Record<UnlimitedDayState, string> = {
  visited: "Visited (code opened)",
  missed: "Passed, not visited",
  today: "Today",
  upcoming: "Reserved",
  released: "Released",
};

/** The 30 daily reservations of one Unlimited purchase, as one strip. */
export function UnlimitedDayStrip({ pass }: { readonly pass: UnlimitedPass }) {
  const days = unlimitedDays(pass);
  const states = new Set(days.map((day) => day.state));
  return (
    <div>
      <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-10">
        {days.map((day) => (
          <li
            className={cn(
              "grid h-11 place-items-center rounded-lg text-center text-[0.7rem] font-semibold leading-tight",
              dayStateClassName[day.state]
            )}
            key={day.date}
            title={`${formatShortDate(day.date)} · ${dayStateLabel[day.state]}`}
          >
            <span>
              <span className="block text-[0.6rem] font-medium uppercase tracking-wide opacity-75">
                {new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(
                  new Date(`${day.date}T00:00:00Z`)
                )}
              </span>
              {Number(day.date.slice(8))}
            </span>
          </li>
        ))}
      </ol>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-navy-blue/70">
        {(Object.keys(dayStateLabel) as UnlimitedDayState[])
          .filter((state) => states.has(state))
          .map((state) => (
            <li className="flex items-center gap-2" key={state}>
              <span aria-hidden className={cn("size-3 rounded", dayStateClassName[state])} />
              {dayStateLabel[state]}
              <span className="font-semibold text-navy-blue">
                {days.filter((day) => day.state === state).length}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Label/value rows in a bordered card, like the customer detail's stats. */
export function FactRows({
  rows,
  className,
}: {
  readonly rows: readonly { label: string; value: ReactNode; hint?: ReactNode }[];
  readonly className?: string;
}) {
  return (
    <dl className={cn("overflow-hidden rounded-xl border border-navy-blue/10 bg-white", className)}>
      {rows.map((row) => (
        <div
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-4 border-b border-navy-blue/8 px-4 py-2.5 last:border-b-0 odd:bg-navy-blue/[0.025]"
          key={row.label}
        >
          <dt className="text-sm text-navy-blue/72">{row.label}</dt>
          <dd className="min-w-0 break-words text-right text-sm font-semibold">
            {row.value}
            {row.hint && (
              <span className="mt-0.5 block text-xs font-normal text-navy-blue/60">{row.hint}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
