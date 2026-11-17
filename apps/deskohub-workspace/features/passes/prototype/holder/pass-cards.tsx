// PROTOTYPE ONLY (#1361): the holder's pass cards in the account page.
import { CalendarPlus, Gift, KeyRound, Mail, Sparkles } from "lucide-react";
import Link from "next/link";
import type { Locale } from "@/features/i18n";
import {
  type EntryPackPass,
  formatPrototypeDate,
  type PrototypePass,
  tierByKey,
  type UnlimitedPass,
  UNLIMITED_DAYS,
} from "@/features/passes/prototype/mock-passes";
import { Button } from "@/shared/components/ui/button";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import { cn } from "@/shared/utils";
import {
  daysUntil,
  entriesLeft,
  formatPeriod,
  formatWeekdayDate,
  unlimitedDayNumber,
  unlimitedDaysLeft,
} from "./holder-mock";

const base = (locale: Locale) => `/${locale}/prototype-passes/account`;

function Eyebrow({ children }: { readonly children: string }) {
  return (
    <p className="text-xs font-bold uppercase tracking-[0.14em] text-aquamarine-ink">
      {children}
    </p>
  );
}

function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b778c]">
        {label}
      </dt>
      <dd className="mt-1 break-words text-[15px] font-semibold leading-snug text-navy-blue">
        {children}
      </dd>
    </div>
  );
}

/** One segment per entry: used, booked, then free. */
function EntryMeter({ pass }: { readonly pass: EntryPackPass }) {
  return (
    <div aria-hidden="true" className="flex gap-1">
      {Array.from({ length: pass.size }, (_, index) => {
        const kind =
          index < pass.entriesUsed
            ? "used"
            : index < pass.entriesUsed + pass.entriesBooked
              ? "booked"
              : "free";
        return (
          <span
            className={cn(
              "h-2.5 flex-1 rounded-full",
              {
                used: "bg-navy-blue/18",
                booked: "bg-burned-orange",
                free: "bg-aquamarine-green",
              }[kind]
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: positional segments
            key={index}
          />
        );
      })}
    </div>
  );
}

/** One segment per day: elapsed, today, remaining. */
function DayMeter({ pass }: { readonly pass: UnlimitedPass }) {
  const today = unlimitedDayNumber(pass);
  return (
    <div aria-hidden="true" className="flex gap-[3px]">
      {Array.from({ length: UNLIMITED_DAYS }, (_, index) => {
        const day = index + 1;
        const kind =
          day < today ? "past" : day === today ? "today" : "future";
        return (
          <span
            className={cn(
              "h-2.5 flex-1 rounded-full",
              {
                past: "bg-navy-blue/18",
                today: "bg-burned-orange",
                future: "bg-aquamarine-green",
              }[kind]
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: positional segments
            key={index}
          />
        );
      })}
    </div>
  );
}

function Legend({
  items,
}: {
  readonly items: readonly { color: string; label: string }[];
}) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[#56627a]">
      {items.map((item) => (
        <li className="flex items-center gap-1.5" key={item.label}>
          <span className={cn("size-2.5 rounded-full", item.color)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function GiftNote({ pass }: { readonly pass: PrototypePass }) {
  if (pass.buyer === null) {
    return (
      <p className="flex items-center gap-2 text-sm font-semibold text-aquamarine-ink">
        <Sparkles aria-hidden="true" className="size-4 shrink-0" />
        Complimentary from Deskohub
      </p>
    );
  }
  if (pass.buyer.id === pass.holder.id) return null;
  return (
    <p className="flex items-center gap-2 text-sm font-semibold text-[#8a4a35]">
      <Gift aria-hidden="true" className="size-4 shrink-0" />
      Bought for you by {pass.buyer.name}
    </p>
  );
}

export function ActivePassCard({
  locale,
  pass,
}: {
  readonly locale: Locale;
  readonly pass: PrototypePass;
}) {
  const tier = tierByKey(pass.tier);

  if (pass.product === "entry-pack") {
    const left = entriesLeft(pass);
    const nextBooking = pass.usage.find((entry) => entry.kind === "entry-booked");
    return (
      <article className="min-w-0 overflow-hidden rounded-2xl border border-[#dfe4ec] bg-white">
        <div className="p-5 @xl:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <Eyebrow>{`Entry pack · ${pass.size} entries`}</Eyebrow>
              <h3 className="mt-1 text-2xl font-bold leading-tight text-navy-blue">
                {tier.label}
              </h3>
            </div>
            <StatusBadge tone="positive">Active</StatusBadge>
          </div>

          <p className="mt-4 flex flex-wrap items-baseline gap-x-2 text-navy-blue">
            <span className="text-5xl font-bold leading-none tabular-nums">
              {left}
            </span>
            <span className="text-lg font-semibold">
              of {pass.size} entries left
            </span>
          </p>
          <div className="mt-4">
            <EntryMeter pass={pass} />
            <Legend
              items={[
                { color: "bg-navy-blue/18", label: `${pass.entriesUsed} used` },
                ...(pass.entriesBooked > 0
                  ? [{ color: "bg-burned-orange", label: `${pass.entriesBooked} booked` }]
                  : []),
                { color: "bg-aquamarine-green", label: `${left} to book` },
              ]}
            />
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-[#e6ebf1] pt-4 @xl:grid-cols-3">
            <Fact label="Valid until">
              {formatPrototypeDate(pass.validUntil)}
              <span className="block text-sm font-normal text-[#6b778c]">
                in {daysUntil(pass.validUntil)} days
              </span>
            </Fact>
            <Fact label="Next booking">
              {nextBooking ? formatWeekdayDate(nextBooking.date) : "None yet"}
              <span className="block text-sm font-normal text-[#6b778c]">
                {nextBooking ? "Open Space, all day" : "Book any open day"}
              </span>
            </Fact>
            <Fact label="Pass">
              {pass.id.replace("pass_", "#")}
              <span className="block text-sm font-normal text-[#6b778c]">
                Bought {formatPrototypeDate(pass.validFrom)}
              </span>
            </Fact>
          </dl>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e6ebf1] bg-[#f8f5ef]/70 px-5 py-3 @xl:px-6">
          <GiftNote pass={pass} />
          <div className="ml-auto flex flex-wrap gap-2">
            <Button asChild size="sm" variant="ghost" tone="outline">
              <Link href={base(locale)}>Usage</Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`${base(locale)}/book?pass=${pass.id}`}>
                <CalendarPlus aria-hidden="true" />
                Book a date
              </Link>
            </Button>
          </div>
        </div>
      </article>
    );
  }

  const daysLeft = unlimitedDaysLeft(pass);
  const dayNumber = unlimitedDayNumber(pass);
  const until = pass.tier === "open-space" ? "17:00" : "midnight";
  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-[#dfe4ec] bg-white">
      <div className="p-5 @xl:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <Eyebrow>Unlimited · 30 days</Eyebrow>
            <h3 className="mt-1 text-2xl font-bold leading-tight text-navy-blue">
              {tier.label}
            </h3>
          </div>
          <StatusBadge tone="positive">
            Day {dayNumber} of {UNLIMITED_DAYS}
          </StatusBadge>
        </div>

        <p className="mt-4 flex flex-wrap items-baseline gap-x-2 text-navy-blue">
          <span className="text-5xl font-bold leading-none tabular-nums">
            {daysLeft}
          </span>
          <span className="text-lg font-semibold">days left, today included</span>
        </p>
        <div className="mt-4">
          <DayMeter pass={pass} />
          <Legend
            items={[
              { color: "bg-navy-blue/18", label: `${dayNumber - 1} days gone` },
              { color: "bg-burned-orange", label: "Today" },
              { color: "bg-aquamarine-green", label: `${daysLeft - 1} to come` },
            ]}
          />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-[#e6ebf1] pt-4 @xl:grid-cols-3">
          <Fact label="Period">
            {formatPeriod(pass.startDate, pass.endDate)}
            <span className="block text-sm font-normal text-[#6b778c]">
              ends in {daysUntil(pass.endDate)} days, no auto-renewal
            </span>
          </Fact>
          <Fact label="Today">
            Door code ready
            <span className="block text-sm font-normal text-[#6b778c]">
              valid until {until}
            </span>
          </Fact>
          <Fact label={pass.deskLabel ? "Your desk" : "Where"}>
            {pass.deskLabel ?? "Any free desk"}
            <span className="block text-sm font-normal text-[#6b778c]">
              {pass.deskLabel ? "Same desk all 30 days" : "Open space, no booking needed"}
            </span>
          </Fact>
        </dl>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e6ebf1] bg-[#f8f5ef]/70 px-5 py-3 @xl:px-6">
        <GiftNote pass={pass} />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link
              href={`${base(locale)}/unlimited-access?tier=${pass.tier === "open-space" ? "open-space" : "reserved-desk"}`}
            >
              <KeyRound aria-hidden="true" />
              Today&apos;s door code
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}

/** A pass the holder bought for someone else (buyer-side visibility is a guess). */
export function BoughtForOtherCard({
  pass,
}: {
  readonly pass: PrototypePass;
}) {
  const tier = tierByKey(pass.tier);
  return (
    <article className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl border border-dashed border-[#cbd7e5] bg-white px-5 py-4">
      <div className="min-w-0">
        <p className="font-bold text-navy-blue">
          {tier.label} ·{" "}
          {pass.product === "entry-pack"
            ? `Entry pack, ${pass.size} entries`
            : "Unlimited, 30 days"}
        </p>
        <p className="mt-1 break-words text-sm text-[#56627a]">
          For {pass.holder.name} · {pass.holder.email}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {pass.holderVerified ? (
          <StatusBadge tone="positive">In use</StatusBadge>
        ) : (
          <StatusBadge tone="attention">Not signed in yet</StatusBadge>
        )}
        {!pass.holderVerified && (
          <Button size="sm" tone="outline" variant="ghost">
            <Mail aria-hidden="true" />
            Resend invitation
          </Button>
        )}
      </div>
    </article>
  );
}

export function PastPassRow({ pass }: { readonly pass: PrototypePass }) {
  const tier = tierByKey(pass.tier);
  const detail =
    pass.product === "entry-pack"
      ? pass.status === "used-up"
        ? `All ${pass.size} entries used · ended ${formatPrototypeDate(pass.validUntil)}`
        : `Expired ${formatPrototypeDate(pass.validUntil)} · ${pass.size - pass.entriesUsed} of ${pass.size} entries unused`
      : `Ended ${formatPrototypeDate(pass.endDate)}`;
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-1 py-3 text-[#6b778c]">
      <div className="min-w-0">
        <p className="font-semibold text-navy-blue/70">
          {tier.label} ·{" "}
          {pass.product === "entry-pack"
            ? `Entry pack, ${pass.size} entries`
            : "Unlimited, 30 days"}
        </p>
        <p className="mt-0.5 text-sm">{detail}</p>
      </div>
      <StatusBadge tone="neutral">
        {pass.status === "used-up" ? "Used up" : "Expired"}
      </StatusBadge>
    </li>
  );
}

/** Compact tile for the "passes inside Reservations" variant. */
export function PassTile({
  locale,
  pass,
}: {
  readonly locale: Locale;
  readonly pass: PrototypePass;
}) {
  const tier = tierByKey(pass.tier);
  const isPack = pass.product === "entry-pack";
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-[#dfe4ec] bg-[#fbfaf7] p-4">
      <Eyebrow>{isPack ? `Entry pack · ${pass.size}` : "Unlimited · 30 days"}</Eyebrow>
      <h3 className="mt-1 text-lg font-bold leading-tight text-navy-blue">
        {tier.label}
      </h3>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 text-navy-blue">
        <span className="text-3xl font-bold leading-none tabular-nums">
          {isPack ? entriesLeft(pass) : unlimitedDaysLeft(pass)}
        </span>
        <span className="text-sm font-semibold">
          {isPack ? `of ${pass.size} entries left` : "days left"}
        </span>
      </p>
      <p className="mt-1 text-sm text-[#6b778c]">
        {isPack
          ? `Valid until ${formatPrototypeDate(pass.validUntil)}`
          : formatPeriod(pass.startDate, pass.endDate)}
      </p>
      <div className="mt-3 empty:hidden">
        <GiftNote pass={pass} />
      </div>
      <div className="mt-auto pt-4">
        <Button asChild className="w-full" size="sm" variant={isPack ? "secondary" : "primary"}>
          <Link
            href={
              isPack
                ? `${base(locale)}/book?pass=${pass.id}`
                : `${base(locale)}/unlimited-access?tier=open-space`
            }
          >
            {isPack ? "Book a date" : "Today's door code"}
          </Link>
        </Button>
      </div>
    </article>
  );
}
