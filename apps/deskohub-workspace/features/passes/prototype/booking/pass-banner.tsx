"use client";

// PROTOTYPE ONLY (#1392): the pass banner at the top of the cowork booking
// step. One component per banner state from the design doc §4.2.

import {
  AlertTriangle,
  CalendarCheck,
  Check,
  KeyRound,
  type LucideIcon,
  Ticket,
  X,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Locale } from "@/features/i18n";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils";
import { formatCzk, formatPrototypeDate, tierByKey } from "../mock-passes";
import {
  type EntryPack,
  type UnlimitedPass,
  unlimitedDay,
  weekdayDate,
} from "./booking-mock";

type Tone = "offer" | "applied" | "covered" | "warning" | "neutral";

const toneStyles: Record<Tone, { box: string; icon: string }> = {
  offer: {
    box: "border-2 border-burned-orange/55 bg-burned-orange/6",
    icon: "bg-burned-orange text-white",
  },
  applied: {
    box: "border-2 border-aquamarine-green/60 bg-aquamarine-green/10",
    icon: "bg-aquamarine-green text-white",
  },
  covered: {
    box: "border-2 border-aquamarine-green/60 bg-aquamarine-green/10",
    icon: "bg-aquamarine-green text-white",
  },
  warning: {
    box: "border border-sunset-yellow/60 bg-sunset-yellow/14",
    icon: "bg-sunset-yellow/40 text-chilean-fire",
  },
  neutral: {
    box: "border border-navy-blue/12 bg-[#fbfaf7]",
    icon: "bg-navy-blue/8 text-navy-blue/70",
  },
};

function BannerFrame({
  action,
  children,
  detail,
  icon: Icon,
  onDismiss,
  title,
  tone,
}: {
  readonly action?: ReactNode;
  readonly children?: ReactNode;
  readonly detail: ReactNode;
  readonly icon: LucideIcon;
  readonly onDismiss?: () => void;
  readonly title: ReactNode;
  readonly tone: Tone;
}) {
  const styles = toneStyles[tone];
  return (
    <section
      aria-live="polite"
      data-pass-banner={tone}
      className={cn("relative rounded-3xl p-5 sm:p-6", styles.box)}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <span
            aria-hidden="true"
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-full",
              styles.icon
            )}
          >
            <Icon className="size-5" />
          </span>
          <div className={cn("min-w-0 flex-1", onDismiss && "pr-8")}>
            <h2 className="text-xl leading-7 font-semibold text-balance text-navy-blue sm:text-2xl sm:leading-8">
              {title}
            </h2>
            <div className="mt-1 text-sm leading-6 text-navy-blue/70">
              {detail}
            </div>
          </div>
        </div>
        {action && (
          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            {action}
          </div>
        )}
      </div>
      {children}
      {onDismiss && (
        <button
          aria-label="Dismiss"
          className="absolute top-4 right-4 grid size-8 place-items-center rounded-full text-navy-blue/60 hover:bg-navy-blue/6 hover:text-navy-blue"
          onClick={onDismiss}
          type="button"
        >
          <X className="size-4" />
        </button>
      )}
    </section>
  );
}

const packFacts = (pack: EntryPack, leftAfterBooking = false) =>
  `${tierByKey(pack.tier).label} · ${
    leftAfterBooking
      ? `${pack.entriesLeft - 1} of ${pack.size} entries left after this`
      : `${pack.entriesLeft} of ${pack.size} entries left`
  } · valid until ${formatPrototypeDate(pack.validUntil)}`;

function FreeDayPrice() {
  return (
    <span className="whitespace-nowrap sm:text-right">
      <span className="block text-lg leading-6 font-semibold text-navy-blue">
        1 entry
      </span>
      <span className="block text-sm text-navy-blue/60">
        {formatCzk(0)} for the day
      </span>
    </span>
  );
}

export function PassOfferBanner({
  onUse,
  pack,
}: {
  readonly onUse: (pack: EntryPack) => void;
  readonly pack: EntryPack;
}) {
  return (
    <BannerFrame
      action={
        <div className="flex flex-col gap-3 sm:items-end sm:gap-2">
          <FreeDayPrice />
          <Button
            className="w-full sm:w-auto"
            onClick={() => onUse(pack)}
            size="lg"
            type="button"
          >
            <Ticket aria-hidden="true" />
            Use pass
          </Button>
        </div>
      }
      detail={packFacts(pack)}
      icon={Ticket}
      title="Use your Entry pack"
      tone="offer"
    />
  );
}

export function PassPickerBanner({
  onPick,
  onUse,
  packs,
  picked,
}: {
  readonly onPick: (pack: EntryPack) => void;
  readonly onUse: (pack: EntryPack) => void;
  readonly packs: readonly EntryPack[];
  readonly picked: EntryPack;
}) {
  return (
    <BannerFrame
      detail="You have two Entry packs that cover this date. Pick the one to use."
      icon={Ticket}
      title="Use one of your Entry packs"
      tone="offer"
    >
      <div
        aria-label="Entry pack"
        className="mt-4 grid gap-2.5 sm:grid-cols-2"
        role="radiogroup"
      >
        {packs.map((pack) => {
          const selected = pack.id === picked.id;
          return (
            <button
              aria-checked={selected}
              className={cn(
                "flex min-w-0 items-center gap-3 rounded-2xl border bg-white px-4 py-3 text-left transition-colors",
                selected
                  ? "border-burned-orange ring-1 ring-burned-orange"
                  : "border-navy-blue/12 hover:border-navy-blue/30"
              )}
              key={pack.id}
              onClick={() => onPick(pack)}
              role="radio"
              type="button"
            >
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border-2",
                  selected ? "border-burned-orange" : "border-navy-blue/30"
                )}
              >
                {selected && (
                  <span className="size-2.5 rounded-full bg-burned-orange" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-navy-blue">
                  {tierByKey(pack.tier).label}
                </span>
                <span className="block text-sm leading-5 text-navy-blue/65">
                  {pack.entriesLeft} of {pack.size} entries left · until{" "}
                  {formatPrototypeDate(pack.validUntil)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end sm:gap-4">
        <FreeDayPrice />
        <Button
          className="w-full sm:w-auto"
          onClick={() => onUse(picked)}
          size="lg"
          type="button"
        >
          <Ticket aria-hidden="true" />
          Use pass
        </Button>
      </div>
    </BannerFrame>
  );
}

export function PassAppliedBanner({
  onRemove,
  pack,
}: {
  readonly onRemove: () => void;
  readonly pack: EntryPack;
}) {
  return (
    <BannerFrame
      action={
        <Button onClick={onRemove} size="md" type="button" variant="secondary">
          Pay by card instead
        </Button>
      }
      detail={packFacts(pack, true)}
      icon={Check}
      title="Booking with your Entry pack"
      tone="applied"
    />
  );
}

export function PassCoveredBanner({
  date,
  locale,
  pass,
  quiet,
}: {
  readonly date: string;
  readonly locale: Locale;
  readonly pass: UnlimitedPass;
  readonly quiet: boolean;
}) {
  const tier = tierByKey(pass.tier).label;
  if (quiet) {
    return (
      <BannerFrame
        detail={`It covers ${tier} on ${weekdayDate(date)}. Any other space is a separate paid booking.`}
        icon={CalendarCheck}
        title="You have an Unlimited pass"
        tone="neutral"
      />
    );
  }
  return (
    <BannerFrame
      action={
        <Button asChild size="lg">
          <Link href={`/${locale}/prototype-passes/account`}>
            <KeyRound aria-hidden="true" />
            Today’s door code
          </Link>
        </Button>
      }
      detail={`${tier} · day ${unlimitedDay(pass, date)} of 30 · no booking needed. Walk in with today’s door code.`}
      icon={CalendarCheck}
      title="You’re covered today by your Unlimited pass"
      tone="covered"
    />
  );
}

export function PassExpiredBanner({
  date,
  onBookLastDay,
  pack,
}: {
  readonly date: string;
  readonly onBookLastDay: () => void;
  readonly pack: EntryPack;
}) {
  return (
    <BannerFrame
      action={
        <Button
          onClick={onBookLastDay}
          size="md"
          type="button"
          variant="secondary"
        >
          Use it on {weekdayDate(pack.validUntil)}
        </Button>
      }
      detail={`It’s valid until ${weekdayDate(pack.validUntil)}. ${weekdayDate(date)} is a normal paid day.`}
      icon={AlertTriangle}
      title={`Your Entry pack doesn’t cover ${weekdayDate(date)}`}
      tone="warning"
    />
  );
}

export function PassSpentBanner({
  date,
  pack,
}: {
  readonly date: string;
  readonly pack: EntryPack;
}) {
  return (
    <BannerFrame
      detail={`Its last entry was just used, maybe on another device. ${weekdayDate(
        date
      )} is now a normal paid day at ${formatCzk(
        tierByKey(pack.tier).singleDayPrice
      )}.`}
      icon={AlertTriangle}
      title="Your Entry pack has no entries left"
      tone="warning"
    />
  );
}

export function PassInvalidLinkNotice({
  onDismiss,
}: {
  readonly onDismiss: () => void;
}) {
  return (
    <BannerFrame
      detail="It may be used up, expired or held by someone else. You can still book this day and pay by card."
      icon={AlertTriangle}
      onDismiss={onDismiss}
      title="This pass can’t be used for booking"
      tone="neutral"
    />
  );
}
