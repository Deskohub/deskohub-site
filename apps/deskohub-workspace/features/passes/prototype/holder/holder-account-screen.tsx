// PROTOTYPE ONLY (#1361): account page listing the holder's passes.
// Two variants via ?variant=: "section" (own Passes section, default) and
// "in-reservations" (passes as a strip above the reservations list).
import { KeyRound, Ticket } from "lucide-react";
import Link from "next/link";
import { AccountSectionPanel } from "@/features/account/components/shell/account-section-panel";
import type { Locale } from "@/features/i18n";
import { Button } from "@/shared/components/ui/button";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import { HolderAccountFrame } from "./holder-account-frame";
import { HOLDER_PASSES } from "./holder-mock";
import {
  ActivePassCard,
  BoughtForOtherCard,
  PassTile,
  PastPassRow,
} from "./pass-cards";

export const HOLDER_ACCOUNT_VARIANTS = [
  { key: "section", label: "A · Passes section" },
  { key: "in-reservations", label: "B · Inside Reservations" },
] as const;

function GroupHeading({
  children,
  hint,
}: {
  readonly children: string;
  readonly hint?: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="text-sm font-bold uppercase tracking-[0.12em] text-[#56627a]">
        {children}
      </h3>
      {hint && <p className="text-sm text-[#6b778c]">{hint}</p>}
    </div>
  );
}

function BuyPassButton({ locale }: { readonly locale: Locale }) {
  return (
    <Button asChild size="sm" variant="secondary">
      <Link href={`/${locale}/prototype-passes/entry-pack`}>
        <Ticket aria-hidden="true" />
        Buy a pass
      </Link>
    </Button>
  );
}

function PassesSection({ locale }: { readonly locale: Locale }) {
  return (
    <AccountSectionPanel actions={<BuyPassButton locale={locale} />} title="Passes">
      <div className="grid gap-9">
        <section data-group="active">
          <GroupHeading hint="Entry pack days are booked one date at a time.">
            Active
          </GroupHeading>
          <div className="grid gap-4">
            {HOLDER_PASSES.active.map((pass, index) => (
              <div data-pass-index={index} key={pass.id}>
                <ActivePassCard locale={locale} pass={pass} />
              </div>
            ))}
          </div>
        </section>

        <section data-group="others">
          <GroupHeading hint="The person you bought it for uses it.">
            Bought for others
          </GroupHeading>
          <div className="grid gap-3">
            {HOLDER_PASSES.boughtForOthers.map((pass) => (
              <BoughtForOtherCard key={pass.id} pass={pass} />
            ))}
          </div>
        </section>

        <section data-group="past">
          <GroupHeading>Past passes</GroupHeading>
          <ul className="divide-y divide-[#e6ebf1] border-y border-[#e6ebf1]">
            {HOLDER_PASSES.past.map((pass) => (
              <PastPassRow key={pass.id} pass={pass} />
            ))}
          </ul>
        </section>
      </div>
    </AccountSectionPanel>
  );
}

const UPCOMING = [
  {
    date: "Today",
    sub: "Tue 17 Nov",
    title: "Open Space",
    detail: "Unlimited · door code valid until 17:00",
    payment: "Unlimited",
    action: "code" as const,
  },
  {
    date: "Thu 19 Nov",
    sub: "in 2 days",
    title: "Open Space",
    detail: "All day · coffee not added",
    payment: "Entry pack",
    action: undefined,
  },
];

function ReservationsWithPasses({ locale }: { readonly locale: Locale }) {
  return (
    <AccountSectionPanel actions={<BuyPassButton locale={locale} />} title="Reservations">
      <div className="grid gap-9">
        <section>
          <GroupHeading hint={`${HOLDER_PASSES.past.length} past passes`}>
            Your passes
          </GroupHeading>
          <div className="grid gap-3 @2xl:grid-cols-3">
            {HOLDER_PASSES.active.map((pass) => (
              <PassTile key={pass.id} locale={locale} pass={pass} />
            ))}
          </div>
        </section>

        <section>
          <GroupHeading>Upcoming</GroupHeading>
          <ul className="grid gap-3">
            {UPCOMING.map((reservation) => (
              <li
                className="grid min-w-0 gap-x-5 gap-y-3 rounded-2xl border border-[#dfe4ec] bg-white p-4 @xl:grid-cols-[7rem_minmax(0,1fr)_auto] @xl:items-center"
                key={reservation.sub}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 @xl:block">
                  <p className="font-bold text-navy-blue">{reservation.date}</p>
                  <p className="text-sm text-[#6b778c]">{reservation.sub}</p>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-navy-blue">{reservation.title}</p>
                  <p className="mt-1 text-sm text-[#56627a]">
                    {reservation.detail}
                  </p>
                  <StatusBadge className="mt-2" tone="progress">
                    Paid with {reservation.payment}
                  </StatusBadge>
                </div>
                {reservation.action === "code" && (
                  <Button asChild className="@max-xl:w-full" size="sm">
                    <Link
                      href={`/${locale}/prototype-passes/account/unlimited-access?tier=open-space`}
                    >
                      <KeyRound aria-hidden="true" />
                      Door code
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-[#6b778c]">
            Days booked with an Entry pack can’t be cancelled.
          </p>
        </section>
      </div>
    </AccountSectionPanel>
  );
}

export function HolderAccountScreen({
  locale,
  variant,
}: {
  readonly locale: Locale;
  readonly variant: string;
}) {
  const inReservations = variant === "in-reservations";
  return (
    <HolderAccountFrame
      activeSection={inReservations ? "reservations" : "passes"}
      locale={locale}
      passCount={HOLDER_PASSES.active.length}
      showPassesSection={!inReservations}
    >
      {inReservations ? (
        <ReservationsWithPasses locale={locale} />
      ) : (
        <PassesSection locale={locale} />
      )}
    </HolderAccountFrame>
  );
}
