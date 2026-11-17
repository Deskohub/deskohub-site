// PROTOTYPE ONLY (#1361): Unlimited holder's access page with today's door
// code. ?tier=open-space (default, Jana's complimentary pass) | reserved-desk.
import { ArrowLeft, CalendarClock, KeyRound } from "lucide-react";
import Link from "next/link";
import type { Locale } from "@/features/i18n";
import {
  passById,
  PROTOTYPE_TODAY,
  tierByKey,
  type UnlimitedPass,
  UNLIMITED_DAYS,
} from "@/features/passes/prototype/mock-passes";
import { CopyCodeButton } from "./copy-code-button";
import {
  formatPeriod,
  formatWeekdayDate,
  reservedDeskUnlimited,
  TODAY_DOOR_CODE,
  TOMORROW,
  unlimitedDayNumber,
  unlimitedDaysLeft,
} from "./holder-mock";

export const UNLIMITED_ACCESS_STATES = [
  { key: "open-space", label: "Open Space" },
  { key: "reserved-desk", label: "Reserved Desk" },
] as const;

export function UnlimitedAccessScreen({
  locale,
  tier,
}: {
  readonly locale: Locale;
  readonly tier: string;
}) {
  const isDesk = tier === "reserved-desk";
  const pass = isDesk
    ? reservedDeskUnlimited
    : (passById("pass_6RFA") as UnlimitedPass);
  const code = TODAY_DOOR_CODE[isDesk ? "reserved-desk" : "open-space"];
  const dayNumber = unlimitedDayNumber(pass);
  const daysLeft = unlimitedDaysLeft(pass);

  return (
    <main className="min-h-screen px-4 pb-28 pt-[calc(var(--site-header-height)+2rem)] [background:radial-gradient(circle_at_0%_0%,rgba(255,242,214,0.9),transparent_34%),radial-gradient(circle_at_100%_0%,rgba(218,244,235,0.82),transparent_38%),#f8f5ef] sm:px-6 sm:pt-[calc(var(--site-header-height)+3rem)]">
      <div className="mx-auto max-w-2xl">
        <Link
          className="inline-flex items-center gap-2 text-sm font-semibold text-navy-blue/70 hover:text-navy-blue"
          href={`/${locale}/prototype-passes/account`}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Passes
        </Link>

        <section className="mt-4 overflow-hidden rounded-[2.25rem] border border-white/55 bg-white/94 text-navy-blue shadow-[0_44px_140px_-54px_rgba(0,2,79,0.62)]">
          <div className="p-6 sm:p-10">
            <div className="flex items-center gap-4 sm:gap-6">
              <div className="flex h-13 w-13 shrink-0 items-center justify-center rounded-full bg-aquamarine-green/14 text-aquamarine-ink ring-8 ring-aquamarine-green/8 sm:h-16 sm:w-16">
                <KeyRound aria-hidden="true" className="h-8 w-8 sm:h-9 sm:w-9" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-aquamarine-ink">
                  Unlimited · {tierByKey(pass.tier).label}
                </p>
                <h1 className="mt-2 text-balance text-[1.75rem] leading-none sm:text-5xl">
                  Today’s door code
                </h1>
              </div>
            </div>

            <div className="mt-10 sm:mt-12">
              <output
                aria-label={Array.from(code).join(" ")}
                className="flex flex-wrap justify-center gap-[clamp(0.25rem,1.2vw,0.6rem)]"
              >
                {Array.from(code).map((character, index) => (
                  <span
                    aria-hidden="true"
                    className="grid h-[clamp(3.5rem,15vw,5.25rem)] w-[clamp(1.6rem,7.4vw,3.5rem)] place-items-center rounded-xl bg-navy-blue/5 font-mono text-[clamp(1.35rem,6vw,2.4rem)] font-medium tabular-nums text-navy-blue"
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional digits
                    key={`${index}-${character}`}
                  >
                    {character}
                  </span>
                ))}
              </output>

              <p className="mt-8 text-center text-lg font-semibold">
                Valid today, {formatWeekdayDate(PROTOTYPE_TODAY)}, until{" "}
                {isDesk ? "midnight" : "17:00"}
              </p>
              <p className="mt-1 text-center text-sm text-navy-blue/60">
                Type it on the keypad at the entrance.
              </p>

              <div className="mt-6 flex justify-center">
                <CopyCodeButton code={code} />
              </div>
            </div>
          </div>

          {isDesk && (
            <div className="border-t-4 border-aquamarine-green bg-[#e9fff6] px-6 py-5 text-center sm:px-10">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-aquamarine-ink">
                Your desk, all 30 days
              </p>
              <p className="mt-1 text-5xl font-bold leading-none">
                {pass.deskLabel?.replace("Desk ", "")}
              </p>
              <p className="mt-2 text-sm text-navy-blue/70">
                {pass.deskLabel} is held for you until midnight every day.
              </p>
            </div>
          )}

          <dl className="grid gap-5 border-t border-[#e6ebf1] bg-[#fbfaf7] px-6 py-6 sm:grid-cols-3 sm:px-10">
            <div className="min-w-0">
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b778c]">
                Period
              </dt>
              <dd className="mt-1 font-semibold">
                {formatPeriod(pass.startDate, pass.endDate)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b778c]">
                Today is
              </dt>
              <dd className="mt-1 font-semibold">
                Day {dayNumber} of {UNLIMITED_DAYS}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b778c]">
                Days left
              </dt>
              <dd className="mt-1 font-semibold">{daysLeft}, today included</dd>
            </div>
          </dl>
        </section>

        <p className="mt-6 flex items-start gap-3 rounded-2xl border border-[#dfe4ec] bg-white/70 px-5 py-4 text-sm leading-6 text-navy-blue/80">
          <CalendarClock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-navy-blue/60" />
          <span>
            Each day has its own code. Tomorrow’s code appears here tomorrow,{" "}
            {formatWeekdayDate(TOMORROW)}
            {isDesk ? ", from midnight." : "."}
          </span>
        </p>
      </div>
    </main>
  );
}
